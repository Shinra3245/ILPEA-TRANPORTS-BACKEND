// backend/src/lib/utils.js
const admin = require('firebase-admin');
const { Resend } = require('resend');
const path = require('path');
const crypto = require('crypto');
const { ROLES } = require('../config/roles');

function cargarCredencialesFirebase() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    }

    const keyPath = process.env.FIREBASE_KEY_PATH
        ? path.resolve(__dirname, process.env.FIREBASE_KEY_PATH)
        : path.resolve(__dirname, '../config/firebase-key.json');

    return require(keyPath);
}

const serviceAccount = cargarCredencialesFirebase();

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (e) {
    // Si ya fue inicializado en otro módulo, ignorar
}

const db = admin.firestore();

function esEmailValido(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function generarPasswordTemporal(longitud = 12) {
    const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    let resultado = '';

    for (let i = 0; i < longitud; i += 1) {
        resultado += caracteres[crypto.randomInt(0, caracteres.length)];
    }

    return resultado;
}

let resendClient = null;
let emailVerificado = false;
let emailFalloHasta = 0;
const EMAIL_BACKOFF_MS = Number(process.env.SMTP_BACKOFF_MS || 120_000);

function normalizarVariableEntorno(valor) {
    const texto = String(valor || '').trim();

    if (
        (texto.startsWith('"') && texto.endsWith('"'))
        || (texto.startsWith("'") && texto.endsWith("'"))
    ) {
        return texto.slice(1, -1).trim();
    }

    return texto;
}

function obtenerFrontendUrl() {
    const url = normalizarVariableEntorno(
        process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:5173',
    );
    return url.replace(/\/+$/, '');
}

function obtenerActionCodeSettingsAuth() {
    return {
        url: `${obtenerFrontendUrl()}/auth/action`,
        handleCodeInApp: false,
    };
}

function escapeHtml(valor) {
    return String(valor || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function obtenerClienteResend() {
    if (resendClient) return resendClient;
    const apiKey = normalizarVariableEntorno(process.env.RESEND_API_KEY);
    if (!apiKey) return null;
    resendClient = new Resend(apiKey);
    return resendClient;
}

async function verificarTransporterSMTP() {
    const client = obtenerClienteResend();
    if (!client) {
        return { ok: false, motivo: 'EMAIL_NO_CONFIGURADO' };
    }
    if (emailVerificado) {
        return { ok: true, motivo: null };
    }
    emailVerificado = true;
    return { ok: true, motivo: null };
}

function smtpEnBackoff() {
    return Date.now() < emailFalloHasta;
}

function filaCredencialCorreo(etiqueta, valor, { destacado = false, monospace = false } = {}) {
    const valorEstilo = [
        'padding: 14px 18px',
        'border-bottom: 1px solid #e5e7eb',
        'color: #000000',
        'font-size: 14px',
        `font-weight: ${destacado ? '700' : '600'}`,
        monospace ? "font-family: 'Courier New', Courier, monospace" : "font-family: Inter, Arial, sans-serif",
        destacado ? 'background: #f0fdf4' : 'background: #ffffff',
    ].join('; ');

    return `
      <tr>
        <td style="padding: 14px 18px; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; width: 38%; background: #f9fafb; font-family: Inter, Arial, sans-serif;">
          ${etiqueta}
        </td>
        <td style="${valorEstilo}">
          ${valor}
        </td>
      </tr>
    `;
}

function construirContenidoCorreoCredenciales({ nombre, email, password, rol, idEmpleado = null }) {
    const rolNormalizado = String(rol || 'EMPLEADO').toUpperCase();
    const esAdmin = rolNormalizado === 'ADMIN';
    const esJefe = rolNormalizado === 'JEFE';
    const perfil = esAdmin ? 'Administrador' : esJefe ? 'Jefe de turno' : 'Empleado';

    const nombreSeguro = escapeHtml(nombre);
    const emailSeguro = escapeHtml(email);
    const passwordSeguro = escapeHtml(password);
    const idSeguro = idEmpleado ? escapeHtml(idEmpleado) : null;

    const filasHtml = [
        filaCredencialCorreo('Perfil', escapeHtml(perfil)),
        ...(idSeguro ? [filaCredencialCorreo('ID empleado', idSeguro, { monospace: true })] : []),
        filaCredencialCorreo('Nombre', nombreSeguro),
        filaCredencialCorreo('Correo', emailSeguro),
        filaCredencialCorreo('Contraseña temporal', passwordSeguro, { destacado: true, monospace: true }),
    ];

    const lineasCredencialesTexto = [
        `Perfil: ${perfil}`,
        ...(idEmpleado ? [`ID empleado: ${idEmpleado}`] : []),
        `Nombre: ${nombre}`,
        `Correo: ${email}`,
        `Contraseña temporal: ${password}`,
    ];

    const asunto = esAdmin
        ? 'Acceso de administrador — ILPEA Transporte'
        : esJefe
            ? 'Acceso de jefe de turno — ILPEA Transporte'
            : 'Credenciales de acceso — ILPEA Transporte';

    const urlLogin = normalizarVariableEntorno(process.env.FRONTEND_URL || process.env.APP_URL || '');
    const botonLogin = urlLogin
        ? `
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px auto 8px;">
          <tr>
            <td style="border-radius: 8px; background: #000000;">
              <a href="${escapeHtml(urlLogin)}" target="_blank" rel="noopener noreferrer"
                style="display: inline-block; padding: 14px 28px; font-family: Inter, Arial, sans-serif; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; letter-spacing: 0.03em;">
                Ingresar al sistema
              </a>
            </td>
          </tr>
        </table>
        <p style="margin: 0; text-align: center; font-size: 12px; color: #6b7280; font-family: Inter, Arial, sans-serif;">
          ${escapeHtml(urlLogin)}
        </p>
      `
        : '';

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(asunto)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: Inter, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #f3f4f6; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb; box-shadow: 0 4px 24px rgba(0,0,0,0.06);">
          <tr>
            <td style="background: #000000; padding: 28px 32px 24px;">
              <p style="margin: 0 0 4px; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.02em;">ILPEA Transporte</p>
              <p style="margin: 0; font-size: 13px; color: #9ca3af; letter-spacing: 0.06em; text-transform: uppercase;">Gestión de flota</p>
            </td>
          </tr>
          <tr>
            <td style="height: 4px; background: #107c41; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 8px;">
              <p style="margin: 0 0 8px; font-size: 18px; font-weight: 700; color: #000000;">Bienvenido(a), ${nombreSeguro}</p>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #374151;">
                Se creó tu cuenta de <strong>${escapeHtml(perfil)}</strong> en ILPEA Transporte.
                Usa las credenciales siguientes para iniciar sesión.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 8px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">
                ${filasHtml.join('')}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 8px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 8px;">
                <tr>
                  <td style="padding: 14px 16px; font-size: 13px; line-height: 1.5; color: #92400e;">
                    Por seguridad, cambia tu contraseña después del primer acceso.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${botonLogin ? `<tr><td style="padding: 8px 32px 32px;">${botonLogin}</td></tr>` : '<tr><td style="padding-bottom: 32px;"></td></tr>'}
          <tr>
            <td style="padding: 20px 32px; background: #f9fafb; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #6b7280; text-align: center;">
                Mensaje automático de ILPEA Transporte. No respondas a este correo.<br />
                Si no solicitaste esta cuenta, contacta a tu administrador.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

    const text = [
        'ILPEA Transporte — Gestión de flota',
        '',
        `Hola ${nombre},`,
        `Se creó tu cuenta de ${perfil}.`,
        '',
        ...lineasCredencialesTexto,
        '',
        'Por seguridad, cambia tu contraseña después del primer acceso.',
        ...(urlLogin ? ['', `Ingresar: ${urlLogin}`] : []),
        '',
        'Mensaje automático. No respondas a este correo.',
    ].join('\n');

    return { asunto, html, text };
}

function construirContenidoCorreoRestablecimiento({ email, enlace }) {
    const emailSeguro = escapeHtml(email);
    const enlaceSeguro = escapeHtml(enlace);

    const asunto = 'Restablece tu contraseña — ILPEA Transporte';

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(asunto)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: Inter, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #f3f4f6; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb; box-shadow: 0 4px 24px rgba(0,0,0,0.06);">
          <!-- Encabezado -->
          <tr>
            <td style="background: #000000; padding: 28px 32px 24px;">
              <p style="margin: 0 0 4px; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.02em;">ILPEA Transporte</p>
              <p style="margin: 0; font-size: 13px; color: #9ca3af; letter-spacing: 0.06em; text-transform: uppercase;">Gestión de flota</p>
            </td>
          </tr>
          <tr>
            <td style="height: 4px; background: #107c41; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>
          <!-- Cuerpo -->
          <tr>
            <td style="padding: 32px 32px 8px;">
              <p style="margin: 0 0 8px; font-size: 18px; font-weight: 700; color: #000000;">Restablece tu contraseña</p>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #374151;">
                Recibimos una solicitud para restablecer la contraseña de la cuenta asociada a
                <strong style="color: #000000;">${emailSeguro}</strong>.
              </p>
            </td>
          </tr>
          <!-- Tabla de info -->
          <tr>
            <td style="padding: 20px 32px 8px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">
                <tr>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; width: 38%; background: #f9fafb; font-family: Inter, Arial, sans-serif;">
                    Correo
                  </td>
                  <td style="padding: 14px 18px; border-bottom: 1px solid #e5e7eb; color: #000000; font-size: 14px; font-weight: 600; background: #ffffff; font-family: Inter, Arial, sans-serif;">
                    ${emailSeguro}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 14px 18px; color: #6b7280; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; width: 38%; background: #f9fafb; font-family: Inter, Arial, sans-serif;">
                    Validez del enlace
                  </td>
                  <td style="padding: 14px 18px; color: #000000; font-size: 14px; font-weight: 600; background: #ffffff; font-family: Inter, Arial, sans-serif;">
                    1 hora
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Botón -->
          <tr>
            <td style="padding: 24px 32px 8px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="border-radius: 8px; background: #107c41;">
                    <a href="${enlaceSeguro}" target="_blank" rel="noopener noreferrer"
                      style="display: inline-block; padding: 14px 28px; font-family: Inter, Arial, sans-serif; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; letter-spacing: 0.03em;">
                      Restablecer contraseña
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Enlace alternativo -->
          <tr>
            <td style="padding: 8px 32px 16px;">
              <p style="margin: 0 0 4px; font-size: 12px; color: #6b7280;">Si el botón no funciona, copia este enlace en tu navegador:</p>
              <p style="margin: 0; font-size: 12px; color: #107c41; word-break: break-all;">${enlaceSeguro}</p>
            </td>
          </tr>
          <!-- Aviso de seguridad -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #fffbeb; border-left: 4px solid #f59e0b; border-radius: 8px;">
                <tr>
                  <td style="padding: 14px 16px; font-size: 13px; line-height: 1.5; color: #92400e;">
                    Si no solicitaste este cambio, ignora este correo. Tu contraseña no será modificada.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Pie -->
          <tr>
            <td style="padding: 20px 32px; background: #f9fafb; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #6b7280; text-align: center;">
                Mensaje automático de ILPEA Transporte. No respondas a este correo.<br />
                Si no solicitaste restablecer tu contraseña, contacta a tu administrador.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    const text = [
        'ILPEA Transporte — Gestión de flota',
        '',
        'Restablece tu contraseña',
        '',
        `Cuenta: ${email}`,
        `Validez del enlace: 1 hora`,
        '',
        `Enlace para restablecer: ${enlace}`,
        '',
        'Si no solicitaste este cambio, ignora este correo.',
        '',
        'Mensaje automático. No respondas a este correo.',
    ].join('\n');

    return { asunto, html, text };
}

function formatearSemanaLegible(semanaKey) {
    const texto = textoNormalizado(semanaKey).toUpperCase();
    const match = /^(\d{4})-W(\d{1,2})$/.exec(texto);
    if (!match) {
        return semanaKey;
    }
    return `Semana ${Number(match[2])} de ${match[1]}`;
}

function formatearFechaLegibleCorreo(fechaISO) {
    const texto = textoNormalizado(fechaISO);
    const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
    if (!partes) {
        return fechaISO;
    }
    const fecha = new Date(Date.UTC(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3])));
    return fecha.toLocaleDateString('es-MX', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

function construirContenidoCorreoAsignacionSemanal({
    nombre,
    email,
    idEmpleado = null,
    semana,
    turnoNombre,
    fechasOperacion = [],
    rutaNombre,
    rutaNumero = null,
    asiento = null,
    paradaNombre = null,
    unidadCodigo = null,
    unidadTipo = null,
    esActualizacion = false,
}) {
    const nombreSeguro = escapeHtml(nombre);
    const emailSeguro = escapeHtml(email);
    const semanaLegible = escapeHtml(formatearSemanaLegible(semana));
    const turnoSeguro = escapeHtml(turnoNombre);
    const rutaSegura = escapeHtml(rutaNombre || (rutaNumero ? `Ruta ${rutaNumero}` : 'Sin ruta'));
    const fechasLegibles = fechasOperacion.map((fecha) => formatearFechaLegibleCorreo(fecha));
    const fechasTexto = fechasLegibles.length
        ? fechasLegibles.map((fecha) => escapeHtml(fecha)).join('<br />')
        : 'Por confirmar';

    const filasHtml = [
        filaCredencialCorreo('Semana', semanaLegible),
        filaCredencialCorreo('Fecha de viaje', fechasTexto),
        filaCredencialCorreo('Turno', turnoSeguro),
        filaCredencialCorreo('Ruta', rutaSegura),
        ...(asiento ? [filaCredencialCorreo('Asiento', String(asiento), { destacado: true })] : []),
        ...(paradaNombre ? [filaCredencialCorreo('Parada', escapeHtml(paradaNombre))] : []),
        ...(unidadCodigo || unidadTipo
            ? [filaCredencialCorreo('Unidad', escapeHtml([unidadCodigo, unidadTipo].filter(Boolean).join(' · ')))]
            : []),
        ...(idEmpleado ? [filaCredencialCorreo('ID empleado', escapeHtml(idEmpleado), { monospace: true })] : []),
        filaCredencialCorreo('Correo', emailSeguro),
    ];

    const asunto = esActualizacion
        ? 'Actualización de tu asignación — ILPEA Transporte'
        : 'Nueva asignación de ruta — ILPEA Transporte';

    const titulo = esActualizacion ? 'Tu asignación fue actualizada' : 'Tienes una nueva asignación';
    const intro = esActualizacion
        ? 'Se actualizaron los datos de tu programación semanal. Revisa el detalle a continuación.'
        : 'Fuiste asignado a una ruta y turno para la semana indicada. Guarda esta información para tu viaje.';

    const urlBase = normalizarVariableEntorno(process.env.FRONTEND_URL || process.env.APP_URL || '');
    const urlPanel = urlBase ? `${urlBase.replace(/\/$/, '')}/empleado` : '';
    const botonPanel = urlPanel
        ? `
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px auto 8px;">
          <tr>
            <td style="border-radius: 8px; background: #107c41;">
              <a href="${escapeHtml(urlPanel)}" target="_blank" rel="noopener noreferrer"
                style="display: inline-block; padding: 14px 28px; font-family: Inter, Arial, sans-serif; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; letter-spacing: 0.03em;">
                Ver mi asignación
              </a>
            </td>
          </tr>
        </table>
        <p style="margin: 0; text-align: center; font-size: 12px; color: #6b7280; font-family: Inter, Arial, sans-serif;">
          ${escapeHtml(urlPanel)}
        </p>
      `
        : '';

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(asunto)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: Inter, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #f3f4f6; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb; box-shadow: 0 4px 24px rgba(0,0,0,0.06);">
          <tr>
            <td style="background: #000000; padding: 28px 32px 24px;">
              <p style="margin: 0 0 4px; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.02em;">ILPEA Transporte</p>
              <p style="margin: 0; font-size: 13px; color: #9ca3af; letter-spacing: 0.06em; text-transform: uppercase;">Gestión de flota</p>
            </td>
          </tr>
          <tr>
            <td style="height: 4px; background: #107c41; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 8px;">
              <p style="margin: 0 0 8px; font-size: 18px; font-weight: 700; color: #000000;">${escapeHtml(titulo)}</p>
              <p style="margin: 0 0 8px; font-size: 15px; line-height: 1.6; color: #374151;">
                Hola <strong style="color: #000000;">${nombreSeguro}</strong>,
              </p>
              <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #374151;">
                ${escapeHtml(intro)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px 8px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">
                ${filasHtml.join('')}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 8px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #ecfdf5; border-left: 4px solid #107c41; border-radius: 8px;">
                <tr>
                  <td style="padding: 14px 16px; font-size: 13px; line-height: 1.5; color: #065f46;">
                    Presenta tu código QR en el abordaje el día de tu viaje. Si tienes dudas, contacta a tu jefe de turno.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${botonPanel ? `<tr><td style="padding: 8px 32px 32px;">${botonPanel}</td></tr>` : '<tr><td style="padding-bottom: 32px;"></td></tr>'}
          <tr>
            <td style="padding: 20px 32px; background: #f9fafb; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #6b7280; text-align: center;">
                Mensaje automático de ILPEA Transporte. No respondas a este correo.<br />
                Si detectas un error en tu asignación, contacta a tu administrador o jefe de turno.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    const lineasTexto = [
        `Semana: ${formatearSemanaLegible(semana)}`,
        `Fecha de viaje: ${fechasLegibles.join(', ') || 'Por confirmar'}`,
        `Turno: ${turnoNombre}`,
        `Ruta: ${rutaNombre || (rutaNumero ? `Ruta ${rutaNumero}` : 'Sin ruta')}`,
        ...(asiento ? [`Asiento: ${asiento}`] : []),
        ...(paradaNombre ? [`Parada: ${paradaNombre}`] : []),
        ...(unidadCodigo || unidadTipo ? [`Unidad: ${[unidadCodigo, unidadTipo].filter(Boolean).join(' · ')}`] : []),
        ...(idEmpleado ? [`ID empleado: ${idEmpleado}`] : []),
        `Correo: ${email}`,
    ];

    const text = [
        'ILPEA Transporte — Gestión de flota',
        '',
        titulo,
        '',
        `Hola ${nombre},`,
        intro,
        '',
        ...lineasTexto,
        '',
        'Presenta tu código QR en el abordaje el día de tu viaje.',
        ...(urlPanel ? ['', `Ver asignación: ${urlPanel}`] : []),
        '',
        'Mensaje automático. No respondas a este correo.',
    ].join('\n');

    return { asunto, html, text };
}

async function enviarCorreoAsignacionSemanal(datos) {
    const destinatario = normalizarVariableEntorno(datos?.email);
    if (!destinatario) {
        return {
            enviado: false,
            motivo: 'DATOS_CORREO_INCOMPLETOS',
            detalle: 'El empleado no tiene correo registrado.',
        };
    }

    if (smtpEnBackoff()) {
        return {
            enviado: false,
            motivo: 'EMAIL_BACKOFF',
            detalle: 'Proveedor de correo en pausa tras un fallo reciente.',
        };
    }

    const client = obtenerClienteResend();
    if (!client) {
        return {
            enviado: false,
            motivo: 'EMAIL_NO_CONFIGURADO',
            detalle: 'Configura RESEND_API_KEY y MAIL_FROM_EMAIL en las variables de entorno.',
        };
    }

    const remitenteEmail = normalizarVariableEntorno(
        process.env.MAIL_FROM_EMAIL,
    );
    const remitenteNombre = normalizarVariableEntorno(
        process.env.MAIL_FROM_NAME || 'ILPEA TRANSPORTS',
    );
    const contenido = construirContenidoCorreoAsignacionSemanal({
        ...datos,
        email: destinatario,
    });

    try {
        await client.emails.send({
            from: `"${remitenteNombre}" <${remitenteEmail}>`,
            to: destinatario,
            subject: contenido.asunto,
            html: contenido.html,
            text: contenido.text,
        });

        emailFalloHasta = 0;
        emailVerificado = true;
        return {
            enviado: true,
            motivo: null,
            destinatario,
        };
    } catch (error) {
        emailFalloHasta = Date.now() + EMAIL_BACKOFF_MS;
        console.warn('No se pudo enviar correo de asignación semanal:', error.message);
        return {
            enviado: false,
            motivo: 'EMAIL_ENVIO_FALLIDO',
            detalle: error.message,
        };
    }
}

function programarEnvioCorreoAsignacionSemanal(datos) {
    setImmediate(() => {
        enviarCorreoAsignacionSemanal(datos)
            .then((resultado) => {
                if (resultado.enviado) {
                    console.log(`Correo de asignación enviado a ${resultado.destinatario}`);
                    return;
                }
                console.warn(`Correo de asignación no enviado (${resultado.motivo || 'desconocido'}): ${resultado.detalle || ''}`);
            })
            .catch((error) => {
                console.warn('Error inesperado enviando correo de asignación:', error.message);
            });
    });
}

async function enviarCorreoRestablecimiento({ email, enlace }) {
    const destinatario = normalizarVariableEntorno(email);

    if (!destinatario || !enlace) {
        return { enviado: false, motivo: 'DATOS_CORREO_INCOMPLETOS' };
    }

    if (smtpEnBackoff()) {
        return { enviado: false, motivo: 'EMAIL_BACKOFF', detalle: 'Proveedor de correo en pausa tras fallo reciente.' };
    }

    const client = obtenerClienteResend();
    if (!client) {
        return { enviado: false, motivo: 'EMAIL_NO_CONFIGURADO', detalle: 'Configura RESEND_API_KEY y MAIL_FROM_EMAIL en las variables de entorno.' };
    }

    const remitenteEmail = normalizarVariableEntorno(process.env.MAIL_FROM_EMAIL);
    const remitenteNombre = normalizarVariableEntorno(process.env.MAIL_FROM_NAME || 'ILPEA TRANSPORTS');
    const contenido = construirContenidoCorreoRestablecimiento({ email: destinatario, enlace });

    try {
        await client.emails.send({
            from: `"${remitenteNombre}" <${remitenteEmail}>`,
            to: destinatario,
            subject: contenido.asunto,
            html: contenido.html,
            text: contenido.text,
        });
        emailFalloHasta = 0;
        emailVerificado = true;
        return { enviado: true, motivo: null, destinatario };
    } catch (error) {
        emailFalloHasta = Date.now() + EMAIL_BACKOFF_MS;
        console.warn('No se pudo enviar correo de restablecimiento:', error.message);
        return { enviado: false, motivo: 'EMAIL_ENVIO_FALLIDO', detalle: error.message };
    }
}

async function enviarCorreoCredencialesAcceso({ nombre, email, password, rol, idEmpleado = null }) {
    const destinatario = normalizarVariableEntorno(email);
    const contrasena = normalizarVariableEntorno(password);

    if (!destinatario || !contrasena) {
        return {
            enviado: false,
            motivo: 'DATOS_CORREO_INCOMPLETOS',
            detalle: 'Faltan correo destino o contraseña temporal.'
        };
    }

    if (smtpEnBackoff()) {
        return {
            enviado: false,
            motivo: 'EMAIL_BACKOFF',
            detalle: 'Proveedor de correo en pausa tras un fallo reciente. Espera unos minutos.'
        };
    }

    const client = obtenerClienteResend();
    if (!client) {
        return {
            enviado: false,
            motivo: 'EMAIL_NO_CONFIGURADO',
            detalle: 'Configura RESEND_API_KEY y MAIL_FROM_EMAIL en las variables de entorno.'
        };
    }
    const remitenteEmail = normalizarVariableEntorno(process.env.MAIL_FROM_EMAIL);
    const remitenteNombre = normalizarVariableEntorno(
        process.env.MAIL_FROM_NAME || 'ILPEA TRANSPORTS'
    );
    const contenido = construirContenidoCorreoCredenciales({
        nombre,
        email: destinatario,
        password: contrasena,
        rol,
        idEmpleado
    });

    try {
        await client.emails.send({
            from: `"${remitenteNombre}" <${remitenteEmail}>`,
            to: destinatario,
            subject: contenido.asunto,
            html: contenido.html,
            text: contenido.text
        });

        emailFalloHasta = 0;
        emailVerificado = true;
        return {
            enviado: true,
            motivo: null,
            destinatario
        };
    } catch (error) {
        emailFalloHasta = Date.now() + EMAIL_BACKOFF_MS;
        console.warn(`No se pudo enviar correo de alta (${rol || 'usuario'}):`, error.message);
        return {
            enviado: false,
            motivo: 'EMAIL_ENVIO_FALLIDO',
            detalle: error.message
        };
    }
}

function programarEnvioCorreoCredencialesAcceso(datos) {
    setImmediate(() => {
        enviarCorreoCredencialesAcceso(datos)
            .then((resultado) => {
                if (resultado.enviado) {
                    console.log(`Correo de alta enviado a ${resultado.destinatario}`);
                    return;
                }

                console.warn(
                    `Correo de alta no enviado (${resultado.motivo || 'DESCONOCIDO'}):`,
                    resultado.detalle || 'Sin detalle'
                );
            })
            .catch((error) => {
                console.warn('Error inesperado enviando correo de alta:', error.message);
            });
    });
}

function programarEnvioCorreoAltaEmpleado(datos) {
    programarEnvioCorreoCredencialesAcceso({
        ...datos,
        rol: 'EMPLEADO'
    });
}

function programarEnvioCorreoAltaJefe(datos) {
    programarEnvioCorreoCredencialesAcceso({
        ...datos,
        rol: 'JEFE'
    });
}

function programarEnvioCorreoAltaAdmin(datos) {
    programarEnvioCorreoCredencialesAcceso({
        ...datos,
        rol: 'ADMIN'
    });
}

async function enviarCorreoAltaEmpleado({ nombre, email, idEmpleado, password }) {
    return enviarCorreoCredencialesAcceso({
        nombre,
        email,
        password,
        rol: 'EMPLEADO',
        idEmpleado
    });
}

async function enviarCorreoAltaJefe({ nombre, email, password }) {
    return enviarCorreoCredencialesAcceso({
        nombre,
        email,
        password,
        rol: 'JEFE'
    });
}

async function enviarCorreoAltaAdmin({ nombre, email, password }) {
    return enviarCorreoCredencialesAcceso({
        nombre,
        email,
        password,
        rol: 'ADMIN'
    });
}

function formatearValorPorcentaje(valor, decimales = 2) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) {
        return 'N/D';
    }

    return numero.toFixed(decimales);
}

function convertirAFecha(valor) {
    if (!valor) return null;

    if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
        return valor;
    }

    if (typeof valor === 'object' && typeof valor.toDate === 'function') {
        const fecha = valor.toDate();
        return fecha instanceof Date && !Number.isNaN(fecha.getTime()) ? fecha : null;
    }

    if (typeof valor === 'object' && Number.isFinite(valor.seconds)) {
        const fecha = new Date(Number(valor.seconds) * 1000);
        return Number.isNaN(fecha.getTime()) ? null : fecha;
    }

    const texto = String(valor).trim();
    if (!texto) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
        const [anio, mes, dia] = texto.split('-').map(Number);
        const fecha = new Date(anio, mes - 1, dia);
        return Number.isNaN(fecha.getTime()) ? null : fecha;
    }

    const fecha = new Date(texto);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function formatearFechaISO(fecha) {
    const anio = fecha.getFullYear();
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const dia = String(fecha.getDate()).padStart(2, '0');
    return `${anio}-${mes}-${dia}`;
}

function obtenerNumeroSemanaISO(fecha) {
    const fechaUTC = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
    const diaSemana = fechaUTC.getUTCDay() || 7;
    fechaUTC.setUTCDate(fechaUTC.getUTCDate() + 4 - diaSemana);
    const inicioAnio = new Date(Date.UTC(fechaUTC.getUTCFullYear(), 0, 1));
    return Math.ceil((((fechaUTC.getTime() - inicioAnio.getTime()) / 86400000) + 1) / 7);
}

function obtenerRangoSemanaISO(anio, semana) {
    const semanaNumero = Number(semana);
    const anioNumero = Number(anio) || new Date().getFullYear();

    if (!Number.isInteger(semanaNumero) || semanaNumero < 1 || semanaNumero > 53) {
        return null;
    }

    const inicioSemanaUno = new Date(Date.UTC(anioNumero, 0, 4));
    const diaSemana = inicioSemanaUno.getUTCDay() || 7;
    const desde = new Date(inicioSemanaUno);
    desde.setUTCDate(inicioSemanaUno.getUTCDate() - diaSemana + 1 + (semanaNumero - 1) * 7);

    const hasta = new Date(desde);
    hasta.setUTCDate(desde.getUTCDate() + 6);

    return {
        desde: formatearFechaISO(desde),
        hasta: formatearFechaISO(hasta),
        anio: anioNumero,
        semana: semanaNumero
    };
}

// Mapea un turno a los días ISO (1=Lunes ... 7=Domingo) en que opera.
const DIA_POR_PREFIJO_TURNO = {
    lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6, dom: 7,
};

const cacheDiasOperacionTurno = new Map();

function registrarDiasOperacionTurno(turnoId, diasOperacion) {
    const id = turnoNormalizado(turnoId);
    if (!id || !Array.isArray(diasOperacion) || !diasOperacion.length) {
        return;
    }
    cacheDiasOperacionTurno.set(id, [...new Set(diasOperacion.map(Number).filter((n) => n >= 1 && n <= 7))]);
}

function limpiarCacheDiasOperacionTurno() {
    cacheDiasOperacionTurno.clear();
}

async function precargarCacheDiasOperacionTurnos() {
    const snapshot = await db.collection('turnos').get();
    snapshot.docs.forEach((doc) => {
        const data = doc.data() || {};
        if (Array.isArray(data.dias_operacion) && data.dias_operacion.length) {
            registrarDiasOperacionTurno(doc.id, data.dias_operacion);
        }
    });
}

function diasOperacionPorTurno(turnoId) {
    const turno = turnoNormalizado(turnoId);
    if (!turno) {
        return [];
    }

    if (cacheDiasOperacionTurno.has(turno)) {
        return cacheDiasOperacionTurno.get(turno);
    }

    const prefijo = turno.split('_')[0];
    if (DIA_POR_PREFIJO_TURNO[prefijo]) {
        return [DIA_POR_PREFIJO_TURNO[prefijo]];
    }

    // Compatibilidad legado (turnos viejos aún en rutas)
    if (turno.startsWith('mixto')) {
        return [1, 2, 3, 4, 5];
    }
    if (turno.startsWith('sab')) {
        return [6];
    }
    if (turno.startsWith('dom')) {
        return [7];
    }

    return [1, 2, 3, 4, 5, 6, 7];
}

const NOMBRE_DIA_POR_NUMERO = {
    1: 'lunes',
    2: 'martes',
    3: 'miércoles',
    4: 'jueves',
    5: 'viernes',
    6: 'sábado',
    7: 'domingo',
};

/** Indica si dos turnos operan al menos un mismo día de la semana (1=lun … 7=dom). */
function turnosCompartenDia(turnoA, turnoB) {
    const diasB = new Set(diasOperacionPorTurno(turnoB));
    return diasOperacionPorTurno(turnoA).some((dia) => diasB.has(dia));
}

/** Días de la semana (1–7) en común entre dos turnos. */
function diasEnComunTurnos(turnoA, turnoB) {
    const diasB = new Set(diasOperacionPorTurno(turnoB));
    return diasOperacionPorTurno(turnoA).filter((dia) => diasB.has(dia));
}

function nombreDiaOperacion(diaNumero) {
    return NOMBRE_DIA_POR_NUMERO[Number(diaNumero)] || `día ${diaNumero}`;
}

// Devuelve las fechas ISO (YYYY-MM-DD) en que opera un turno dentro de una
// semana con formato "YYYY-Www". Usa el rango ISO (lunes-domingo).
function fechasOperacionSemana(semanaKey, turnoId) {
    const texto = textoNormalizado(semanaKey).toUpperCase();
    const match = /^(\d{4})-W(\d{1,2})$/.exec(texto);
    if (!match) {
        return [];
    }

    const rango = obtenerRangoSemanaISO(Number(match[1]), Number(match[2]));
    if (!rango) {
        return [];
    }

    const dias = new Set(diasOperacionPorTurno(turnoId));
    if (!dias.size) {
        return [];
    }

    // rango.desde es el lunes (ISO) de la semana.
    const [anio, mes, dia] = rango.desde.split('-').map(Number);
    const lunes = new Date(Date.UTC(anio, mes - 1, dia));
    const fechas = [];

    for (let offset = 0; offset < 7; offset += 1) {
        const actual = new Date(lunes);
        actual.setUTCDate(lunes.getUTCDate() + offset);
        const isoWeekday = actual.getUTCDay() === 0 ? 7 : actual.getUTCDay();
        if (dias.has(isoWeekday)) {
            const y = actual.getUTCFullYear();
            const m = String(actual.getUTCMonth() + 1).padStart(2, '0');
            const d = String(actual.getUTCDate()).padStart(2, '0');
            fechas.push(`${y}-${m}-${d}`);
        }
    }

    return fechas;
}

function evaluarAlertas({ tipoUnidad, capacidadReal, pasajeros }) {
    const maxPasajeros = Number(pasajeros) || 0;
    const capacidad = Number(capacidadReal) || 0;
    const porcentaje = capacidad > 0 ? (maxPasajeros / capacidad) * 100 : 0;
    const alerta = porcentaje < 40 ? 'CANCELAR RUTA - Menor al 40%' : 'OK';
    const tipo = String(tipoUnidad || '').toLowerCase();
    const sugerencia = tipo.includes('autobus') && maxPasajeros <= 12
        ? 'CAMBIAR A VAN'
        : 'MANTENER UNIDAD';

    return {
        ocupacion_pct: Number(porcentaje.toFixed(2)),
        porcentaje_ocupacion_max: Number(porcentaje.toFixed(2)),
        alerta_ocupacion: alerta,
        sugerencia_right_sizing: sugerencia
    };
}

function construirMetricasOperativas({ tipoUnidad, capacidadLimite, asientosOcupados, programada }) {
    if (!programada && asientosOcupados === 0) {
        return {
            ocupacion_pct: 0,
            porcentaje_ocupacion_max: 0,
            alerta_ocupacion: 'SIN PROGRAMACIÓN',
            sugerencia_right_sizing: 'SIN DATOS OPERATIVOS',
            max_pasajeros_dia: 0,
            fuente_datos: 'catalogo_sin_programacion'
        };
    }

    const metricas = evaluarAlertas({
        tipoUnidad,
        capacidadReal: capacidadLimite,
        pasajeros: asientosOcupados
    });

    return {
        ...metricas,
        max_pasajeros_dia: asientosOcupados,
        fuente_datos: programada ? 'programacion_diaria' : 'catalogo_sin_programacion'
    };
}

function normalizarPeriodoRuta(rutaData, fechaDefault = new Date()) {
    const fechaDetectada = convertirAFecha(
        rutaData?.fecha_operacion
        ?? rutaData?.fechaOperacion
        ?? rutaData?.fecha
        ?? rutaData?.dia
        ?? rutaData?.fecha_programada
    );

    const semanaDetectada = Number(
        rutaData?.semana_operacion
        ?? rutaData?.semanaOperacion
        ?? rutaData?.semana
        ?? rutaData?.week
        ?? rutaData?.iso_week
    );

    const fechaFinal = fechaDetectada || fechaDefault;
    const semanaFinal = Number.isInteger(semanaDetectada) && semanaDetectada > 0
        ? semanaDetectada
        : obtenerNumeroSemanaISO(fechaFinal);

    return {
        fecha_operacion: formatearFechaISO(fechaFinal),
        semana_operacion: semanaFinal
    };
}

async function generarIdEmpleadoUnico() {
    const maxIntentos = 20;

    for (let intento = 0; intento < maxIntentos; intento += 1) {
        const candidato = `EMP-${crypto.randomInt(100000, 999999)}`;
        const existe = await db
            .collection('usuarios')
            .where('id_empleado', '==', candidato)
            .limit(1)
            .get();

        if (existe.empty) {
            return candidato;
        }
    }

    throw new Error('No se pudo generar un ID de empleado único. Intenta nuevamente.');
}

function construirIdEmpleadoDesdeUid(uid) {
    const fragmento = String(uid || '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(-6)
        .toUpperCase();

    if (!fragmento) {
        return `EMP-${crypto.randomInt(100000, 999999)}`;
    }

    return `EMP-${fragmento}`;
}

async function generarIdEmpleadoDeterministicoUnico(uid, idsReservados = new Set()) {
    const base = construirIdEmpleadoDesdeUid(uid);
    let candidato = base;
    let intento = 1;

    while (idsReservados.has(candidato)) {
        intento += 1;
        candidato = `${base}${String(intento).padStart(2, '0')}`;
    }

    while (true) {
        const existe = await db
            .collection('usuarios')
            .where('id_empleado', '==', candidato)
            .limit(1)
            .get();

        if (existe.empty || existe.docs[0].id === uid) {
            idsReservados.add(candidato);
            return candidato;
        }

        intento += 1;
        candidato = `${base}${String(intento).padStart(2, '0')}`;
    }
}

async function asegurarIdEmpleadoPersistido(doc, idsReservados = new Set()) {
    const data = doc.data() || {};
    const idActual = String(data.id_empleado || '').trim();

    if (idActual) {
        idsReservados.add(idActual);
        return idActual;
    }

    const idGenerado = await generarIdEmpleadoDeterministicoUnico(doc.id, idsReservados);
    await doc.ref.set({
        id_empleado: idGenerado,
        actualizado_en: new Date(),
        actualizado_por: 'auto-backfill-id-empleado'
    }, { merge: true });

    return idGenerado;
}

function normalizarEmpleado(doc) {
    const data = doc.data();
    return {
        uid: doc.id,
        id_empleado: data.id_empleado,
        email: data.email,
        nombre: data.nombre,
        rol: data.rol,
        jefe_uid: data.jefe_uid || null,
        activo: data.activo,
        creado_en: data.creado_en,
        actualizado_en: data.actualizado_en,
        creado_por: data.creado_por,
        actualizado_por: data.actualizado_por
    };
}

function normalizarJefe(doc) {
    const data = doc.data();
    return {
        uid: doc.id,
        email: data.email,
        nombre: data.nombre,
        rol: data.rol,
        activo: data.activo,
        creado_en: data.creado_en,
        actualizado_en: data.actualizado_en,
        creado_por: data.creado_por,
        actualizado_por: data.actualizado_por
    };
}

function puedeGestionarEmpleado(usuario, empleadoData) {
    if (!usuario || !empleadoData) {
        return false;
    }

    if (usuario.rol === ROLES.ADMIN) {
        return true;
    }

    return usuario.rol === ROLES.JEFE && empleadoData.jefe_uid === usuario.uid;
}

function textoNormalizado(valor) {
    return String(valor || '').trim();
}

function turnoNormalizado(turno) {
    return textoNormalizado(turno).toLowerCase();
}

function construirIdsProgramacion(fecha, idRuta, turno) {
    const fechaTexto = textoNormalizado(fecha);
    const idRutaTexto = textoNormalizado(idRuta);
    const turnoTexto = turnoNormalizado(turno);
    const ids = [];

    if (turnoTexto) {
        ids.push(`${fechaTexto}_${turnoTexto}_${idRutaTexto}`);
    }

    ids.push(`${fechaTexto}_${idRutaTexto}`);
    return ids;
}

function normalizarAsientosReservados(asientos) {
    if (!Array.isArray(asientos)) {
        return [];
    }

    return [...new Set(asientos
        .map((valor) => Number(valor))
        .filter((valor) => Number.isInteger(valor) && valor > 0))]
        .sort((a, b) => a - b);
}

function normalizarAsientosPorEmpleado(mapa) {
    if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) {
        return {};
    }

    const resultado = {};

    Object.entries(mapa).forEach(([idEmpleado, asiento]) => {
        const id = textoNormalizado(idEmpleado);
        const asientoNumero = Number(asiento);

        if (id && Number.isInteger(asientoNumero) && asientoNumero > 0) {
            resultado[id] = asientoNumero;
        }
    });

    return resultado;
}

/**
 * Sanitiza el mapa nuevo `pasajeros` de programacion_diaria:
 * { [id_empleado]: { nombre, asiento, parada_id, parada_orden } }
 */
function normalizarPasajerosDetalle(mapa) {
    if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) {
        return {};
    }

    const resultado = {};

    Object.entries(mapa).forEach(([idEmpleado, detalle]) => {
        const id = textoNormalizado(idEmpleado);
        if (!id || !detalle || typeof detalle !== 'object') {
            return;
        }

        const asiento = Number(detalle.asiento);
        resultado[id] = {
            nombre: textoNormalizado(detalle.nombre) || id,
            asiento: Number.isInteger(asiento) && asiento > 0 ? asiento : null,
            parada_id: textoNormalizado(detalle.parada_id) || null,
            parada_orden: Number.isInteger(Number(detalle.parada_orden))
                ? Number(detalle.parada_orden)
                : null,
        };
    });

    return resultado;
}

/**
 * Extrae la vista unificada de pasajeros de un doc de programacion_diaria.
 * Prioriza el mapa nuevo `pasajeros` y reconstruye desde los campos legados
 * (pasajeros_ids / asientos_por_empleado / asientos_reservados) como fallback.
 * Devuelve siempre ambas representaciones para mantener compatibilidad.
 */
function extraerPasajerosProgramacion(data) {
    const dataSegura = data && typeof data === 'object' ? data : {};
    const detalleNuevo = normalizarPasajerosDetalle(dataSegura.pasajeros);
    const idsLegados = Array.isArray(dataSegura.pasajeros_ids)
        ? dataSegura.pasajeros_ids.map((id) => textoNormalizado(id)).filter(Boolean)
        : [];
    const asientosPorEmpleadoLegado = normalizarAsientosPorEmpleado(dataSegura.asientos_por_empleado);
    const asientosReservadosLegado = normalizarAsientosReservados(dataSegura.asientos_reservados);

    let detalle = detalleNuevo;

    if (!Object.keys(detalle).length && idsLegados.length) {
        detalle = {};
        idsLegados.forEach((id, indice) => {
            const asientoMapa = Number(asientosPorEmpleadoLegado[id]);
            const asientoIndice = Number(asientosReservadosLegado[indice]);
            detalle[id] = {
                nombre: id,
                asiento: Number.isInteger(asientoMapa) && asientoMapa > 0
                    ? asientoMapa
                    : (Number.isInteger(asientoIndice) && asientoIndice > 0 ? asientoIndice : null),
                parada_id: null,
                parada_orden: null,
            };
        });
    }

    const ids = Object.keys(detalle).length ? Object.keys(detalle) : idsLegados;
    const asientosPorEmpleado = Object.keys(detalle).length
        ? Object.fromEntries(
            Object.entries(detalle)
                .filter(([, item]) => Number.isInteger(item.asiento) && item.asiento > 0)
                .map(([id, item]) => [id, item.asiento])
        )
        : asientosPorEmpleadoLegado;
    const asientosReservados = Object.keys(detalle).length
        ? normalizarAsientosReservados(Object.values(asientosPorEmpleado))
        : asientosReservadosLegado;

    return {
        detalle,
        ids,
        asientosPorEmpleado,
        asientosReservados,
        total: ids.length,
    };
}

/**
 * Construye el snapshot desnormalizado de vehículo para programacion_diaria.
 * Prioriza vehiculo_default del catálogo de rutas y cae a los campos legados.
 */
function construirVehiculoSnapshot(rutaData = {}, overrides = {}) {
    const base = rutaData?.vehiculo_default && typeof rutaData.vehiculo_default === 'object'
        ? rutaData.vehiculo_default
        : {};

    const tipo = textoNormalizado(overrides.tipo)
        || textoNormalizado(base.tipo)
        || textoNormalizado(rutaData?.tipo_unidad)
        || textoNormalizado(rutaData?.['tipo de unidad'])
        || null;

    const codigo = textoNormalizado(overrides.codigo)
        || textoNormalizado(base.codigo)
        || textoNormalizado(rutaData?.codigo_unidad)
        || null;

    const capacidadOverride = Number(overrides.capacidad);
    const capacidadBase = Number(base.capacidad);
    const capacidadRuta = Number(rutaData?.capacidad_real);
    const capacidad = Number.isInteger(capacidadOverride) && capacidadOverride > 0
        ? capacidadOverride
        : (Number.isInteger(capacidadBase) && capacidadBase > 0
            ? capacidadBase
            : (Number.isInteger(capacidadRuta) && capacidadRuta > 0 ? capacidadRuta : 12));

    return {
        id: textoNormalizado(overrides.id) || textoNormalizado(base.id) || null,
        codigo,
        tipo,
        capacidad,
    };
}

/**
 * Resuelve la unidad (vehículo) asignada a una ruta para un turno específico.
 * Prioriza `rutas.unidad_por_turno[turno]` y cae a `vehiculo_default`.
 */
function resolverUnidadTurno(rutaData = {}, turnoId = null) {
    const turno = turnoNormalizado(turnoId);
    const porTurno = rutaData && typeof rutaData.unidad_por_turno === 'object' && rutaData.unidad_por_turno
        ? rutaData.unidad_por_turno
        : {};

    const asignada = turno && porTurno[turno] && typeof porTurno[turno] === 'object'
        ? porTurno[turno]
        : null;

    const overrides = asignada
        ? {
            id: asignada.vehiculo_id || asignada.id,
            codigo: asignada.codigo,
            tipo: asignada.tipo,
            capacidad: asignada.capacidad,
        }
        : {};

    return construirVehiculoSnapshot(rutaData, overrides);
}

async function leerDoc(ref, transaction = null) {
    if (transaction) {
        return transaction.get(ref);
    }

    return ref.get();
}

async function leerQuery(query, transaction = null) {
    if (transaction) {
        return transaction.get(query);
    }

    return query.get();
}

async function resolverRutaPorIdentificador(idRuta, transaction = null) {
    const idRutaTexto = textoNormalizado(idRuta);
    if (!idRutaTexto) {
        return null;
    }

    const rutasRef = db.collection('rutas');
    const rutaDirectaRef = rutasRef.doc(idRutaTexto);
    const rutaDirecta = await leerDoc(rutaDirectaRef, transaction);
    if (rutaDirecta.exists) {
        return {
            id: rutaDirecta.id,
            ref: rutaDirectaRef,
            data: rutaDirecta.data() || {}
        };
    }

    const numeroRuta = Number(idRutaTexto);
    if (!Number.isNaN(numeroRuta)) {
        const consultaNumero = rutasRef.where('ruta', '==', numeroRuta).limit(1);
        const rutaPorNumero = await leerQuery(consultaNumero, transaction);

        if (!rutaPorNumero.empty) {
            const doc = rutaPorNumero.docs[0];
            return {
                id: doc.id,
                ref: doc.ref,
                data: doc.data() || {}
            };
        }
    }

    return null;
}

async function resolverProgramacion(fecha, idRuta, turno, transaction = null) {
    const fechaTexto = textoNormalizado(fecha);
    const idRutaTexto = textoNormalizado(idRuta);
    const turnoTexto = turnoNormalizado(turno);
    const idsProgramacion = construirIdsProgramacion(fechaTexto, idRutaTexto, turnoTexto);

    for (const programacionId of idsProgramacion) {
        const ref = db.collection('programacion_diaria').doc(programacionId);
        const doc = await leerDoc(ref, transaction);
        if (doc.exists) {
            return {
                docId: programacionId,
                docRef: ref,
                data: doc.data() || {}
            };
        }
    }

    if (!turnoTexto && fechaTexto && idRutaTexto) {
        const query = db.collection('programacion_diaria')
            .where('fecha', '==', fechaTexto)
            .where('id_ruta', '==', idRutaTexto)
            .limit(1);

        const snapshot = await leerQuery(query, transaction);
        if (!snapshot.empty) {
            const doc = snapshot.docs[0];
            return {
                docId: doc.id,
                docRef: doc.ref,
                data: doc.data() || {}
            };
        }
    }

    const docIdPrincipal = idsProgramacion[0];
    return {
        docId: docIdPrincipal,
        docRef: db.collection('programacion_diaria').doc(docIdPrincipal),
        data: null
    };
}

function construirProgramacionBase({ fecha, idRuta, turno, rutaData, uidCreador }) {
    const vehiculo = construirVehiculoSnapshot(rutaData);
    const capacidad = Number(rutaData.capacidad_real) || vehiculo.capacidad || 12;
    const turnoTexto = turnoNormalizado(turno) || null;

    return {
        fecha: textoNormalizado(fecha),
        turno: turnoTexto,
        turno_id: turnoTexto,
        id_ruta: textoNormalizado(idRuta),
        ruta_numero: Number(rutaData.ruta) || Number(rutaData.numero) || null,
        capacidad_limite: capacidad,
        asientos_ocupados: 0,
        asientos_reservados: [],
        pasajeros_ids: [],
        asientos_por_empleado: {},
        pasajeros: {},
        total_abordados: 0,
        vehiculo,
        programada_auto: true,
        zona: rutaData.zona || rutaData.nombre || null,
        tipo_unidad: rutaData['tipo de unidad'] || rutaData.tipo_unidad || null,
        creado_en: new Date(),
        creado_por: uidCreador,
        actualizado_en: new Date(),
        actualizado_por: uidCreador
    };
}

function crearClienteOpenAI() {
    if (!process.env.OPENAI_API_KEY) return null;

    try {
        const OpenAI = require('openai');
        return new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            timeout: 60000,
            maxRetries: 2
        });
    } catch (error) {
        console.warn('OpenAI deshabilitado: error de carga.');
        return null;
    }
}

function esTimeoutOpenAI(error) {
    const texto = String(error?.message || '').toLowerCase();
    const nombre = String(error?.name || '').toLowerCase();
    const codigo = String(error?.code || '').toLowerCase();

    return (
        texto.includes('request timed out')
        || texto.includes('timeout')
        || nombre.includes('timeout')
        || codigo.includes('etimedout')
        || codigo.includes('timeout')
    );
}

function generarRespuestaFallback(mensajeUsuario, rutas) {
    const totalRutas = rutas.length;
    const rutasCriticas = rutas.filter((r) => Number(r.porcentaje_ocupacion_max) < 40);
    const rutasRightSizing = rutas.filter(
        (r) =>
            String(r['tipo de unidad'] || '').toLowerCase().includes('autobus') &&
            Number(r.max_pasajeros_dia) <= 12
    );

    const consulta = String(mensajeUsuario || '').toLowerCase();

    if (consulta.includes('critica') || consulta.includes('cancel') || consulta.includes('40')) {
        if (!rutasCriticas.length) return 'No hay rutas en condición crítica (< 40%) con la data actual.';
        const listado = rutasCriticas
            .map((r) => `Ruta ${r.ruta} (${formatearValorPorcentaje(r.porcentaje_ocupacion_max)}%)`)
            .join(', ');
        return `Rutas críticas detectadas: ${listado}. Recomiendo revisión operativa inmediata.`;
    }

    if (consulta.includes('van') || consulta.includes('right') || consulta.includes('unidad')) {
        if (!rutasRightSizing.length) return 'No hay rutas candidatas claras para cambio de unidad en este momento.';
        const listado = rutasRightSizing.map((r) => `Ruta ${r.ruta}`).join(', ');
        return `Rutas candidatas a right-sizing (Autobús -> Van): ${listado}.`;
    }

    return `Resumen rápido: ${totalRutas} rutas analizadas, ${rutasCriticas.length} con ocupación menor a 40% y ${rutasRightSizing.length} candidatas a right-sizing.`;
}

function fechaISOHoy() {
    return new Date().toISOString().slice(0, 10);
}

function construirResumenOperativoChat(rutas, limite = 8) {
    const listado = Array.isArray(rutas) ? rutas : [];
    const totalRutas = listado.length;

    if (!totalRutas) {
        return {
            total_rutas: 0,
            ocupacion_promedio: 'N/D',
            rutas_criticas: [],
            rutas_right_sizing: []
        };
    }

    const rutasConOcupacion = listado
        .map((ruta) => {
            const ocupacion = Number(ruta.porcentaje_ocupacion_max);
            return {
                id: ruta.id || null,
                ruta: ruta.ruta ?? ruta.id ?? 'N/D',
                zona: ruta['ruta nombre'] || ruta.nombre_ruta || ruta.nombre || null,
                ocupacion: Number.isFinite(ocupacion) ? ocupacion : null,
                pasajeros: Number(ruta.max_pasajeros_dia),
                tipo_unidad: textoNormalizado(ruta['tipo de unidad'] || ruta.tipo_unidad)
            };
        })
        .filter((ruta) => Number.isFinite(ruta.ocupacion));

    const sumaOcupacion = rutasConOcupacion.reduce((acum, ruta) => acum + Number(ruta.ocupacion), 0);
    const promedio = rutasConOcupacion.length
        ? formatearValorPorcentaje(sumaOcupacion / rutasConOcupacion.length)
        : 'N/D';

    const rutasCriticas = rutasConOcupacion
        .filter((ruta) => Number(ruta.ocupacion) < 40)
        .sort((a, b) => Number(a.ocupacion) - Number(b.ocupacion))
        .slice(0, limite)
        .map((ruta) => ({
            ruta: ruta.ruta,
            zona: ruta.zona,
            ocupacion: `${formatearValorPorcentaje(ruta.ocupacion)}%`
        }));

    const rutasRightSizing = rutasConOcupacion
        .filter(
            (ruta) =>
                String(ruta.tipo_unidad || '').toLowerCase().includes('autobus')
                && Number.isFinite(ruta.pasajeros)
                && Number(ruta.pasajeros) <= 12
        )
        .sort((a, b) => Number(a.pasajeros) - Number(b.pasajeros))
        .slice(0, limite)
        .map((ruta) => ({
            ruta: ruta.ruta,
            zona: ruta.zona,
            pasajeros: Number(ruta.pasajeros)
        }));

    return {
        total_rutas: totalRutas,
        ocupacion_promedio: `${promedio}%`,
        rutas_criticas: rutasCriticas,
        rutas_right_sizing: rutasRightSizing
    };
}

async function obtenerContextoEmpleadosChat(usuario, limite = 20) {
    if (!usuario || !usuario.rol) {
        return {
            total: 0,
            activos: 0,
            muestra: []
        };
    }

    try {
        let consulta;

        if (usuario.rol === ROLES.JEFE) {
            consulta = db.collection('usuarios')
                .where('rol', '==', ROLES.EMPLEADO)
                .where('jefe_uid', '==', usuario.uid)
                .limit(limite);
        } else {
            consulta = db.collection('usuarios')
                .where('rol', '==', ROLES.EMPLEADO)
                .limit(limite);
        }

        const snapshot = await consulta.get();
        const muestra = [];
        let activos = 0;

        snapshot.forEach((doc) => {
            const data = doc.data() || {};
            const activo = data.activo !== false;
            if (activo) {
                activos += 1;
            }

            muestra.push({
                id_empleado: textoNormalizado(data.id_empleado) || construirIdEmpleadoDesdeUid(doc.id),
                nombre: textoNormalizado(data.nombre) || null,
                activo,
                turno: textoNormalizado(data.turno) || null,
                jefe_uid: textoNormalizado(data.jefe_uid) || null
            });
        });

        return {
            total: snapshot.size,
            activos,
            muestra
        };
    } catch (error) {
        console.warn('No se pudo construir contexto de empleados para chat:', error.message);
        return {
            total: 0,
            activos: 0,
            muestra: []
        };
    }
}

async function obtenerPlanesIARecientesChat(limite = 8) {
    try {
        let snapshot;

        try {
            snapshot = await db
                .collection(exports.COLECCION_PLANES_IA)
                .orderBy('creado_en', 'desc')
                .limit(limite)
                .get();
        } catch (errorOrden) {
            snapshot = await db.collection(exports.COLECCION_PLANES_IA).limit(limite).get();
        }

        const planes = [];
        snapshot.forEach((doc) => {
            const data = doc.data() || {};
            planes.push({
                id: doc.id,
                fecha: textoNormalizado(data.fecha) || null,
                turno: textoNormalizado(data.turno) || null,
                ruta_origen_id: textoNormalizado(data.ruta_origen_id) || null,
                ruta_destino_id: textoNormalizado(data.ruta_destino_id) || null,
                cantidad_empleados_movidos: Number(data.cantidad_empleados_movidos) || 0,
                estado_impacto: textoNormalizado(data.estado_impacto) || null,
                motivo: textoNormalizado(data.motivo) || null
            });
        });

        return planes;
    } catch (error) {
        console.warn('No se pudo obtener planes IA para chat:', error.message);
        return [];
    }
}

async function obtenerResumenProgramacionChat({ fecha, turno, limite = 10 } = {}) {
    const fechaTexto = textoNormalizado(fecha);
    const turnoTexto = turnoNormalizado(turno);

    if (!fechaTexto) {
        return {
            fecha: null,
            turno: turnoTexto || null,
            total_programadas: 0,
            muestra: []
        };
    }

    try {
        let query = db.collection('programacion_diaria').where('fecha', '==', fechaTexto);
        if (turnoTexto) {
            query = query.where('turno', '==', turnoTexto);
        }

        const snapshot = await query.limit(limite).get();
        const muestra = [];

        snapshot.forEach((doc) => {
            const data = doc.data() || {};
            muestra.push({
                id_ruta: textoNormalizado(data.id_ruta) || null,
                turno: textoNormalizado(data.turno) || null,
                asientos_ocupados: Number(data.asientos_ocupados) || 0,
                capacidad_limite: Number(data.capacidad_limite) || 0
            });
        });

        return {
            fecha: fechaTexto,
            turno: turnoTexto || null,
            total_programadas: snapshot.size,
            muestra
        };
    } catch (error) {
        console.warn('No se pudo construir resumen de programacion para chat:', error.message);
        return {
            fecha: fechaTexto,
            turno: turnoTexto || null,
            total_programadas: 0,
            muestra: []
        };
    }
}

function generarInsightsLocales(rutas) {
    const insights = [];

    rutas.forEach((ruta) => {
        const rutaId = ruta.ruta ?? ruta.id ?? null;
        const nombreRuta = ruta['ruta nombre'] || ruta.nombre_ruta || ruta.nombre || `Ruta ${rutaId ?? 'sin id'}`;
        const ocupacion = Number(ruta.porcentaje_ocupacion_max);
        const pasajeros = Number(ruta.max_pasajeros_dia);
        const tipoUnidad = String(ruta['tipo de unidad'] || '').toLowerCase();

        if (!Number.isNaN(ocupacion) && ocupacion < 40) {
            const probabilidadCancelacion = calcularProbabilidadCancelacionDesdeOcupacion(ocupacion);
            insights.push({
                recomendacion_id: crearIdRecomendacion(rutaId, insights.length),
                titulo: `Cancelar Ruta - ${nombreRuta}`,
                descripcion: `La ruta ${nombreRuta} tiene una ocupación del ${formatearValorPorcentaje(ocupacion)}%, menor al 40%.`,
                prioridad: 'alta',
                ruta_id: rutaId,
                prob_cancelacion: probabilidadCancelacion,
                ruta_alternativa_sugerida: null
            });
        }

        if (tipoUnidad.includes('autobus') && !Number.isNaN(pasajeros) && pasajeros <= 12) {
            insights.push({
                recomendacion_id: crearIdRecomendacion(rutaId, insights.length),
                titulo: `Sugerir Van - ${nombreRuta}`,
                descripcion: `La ruta ${nombreRuta} tiene ${pasajeros} pasajeros, se sugiere cambiar a una Van.`,
                prioridad: 'media',
                ruta_id: rutaId,
                prob_cancelacion: null,
                ruta_alternativa_sugerida: null
            });
        }
    });

    return insights;
}

const COLECCION_HISTORICO_RECOMENDACIONES = 'historico_recomendaciones';
const COLECCION_FEEDBACK_IA = 'ai_feedback_recomendaciones';
const COLECCION_PLANES_IA = 'ai_planes_ejecutados';
const SEMANAS_MEMORIA_DEFECTO = 4;
const DECISIONES_IA_VALIDAS = ['ACEPTADA', 'RECHAZADA', 'PENDIENTE'];

function obtenerTipoEjemploPorDecision(decision) {
    if (decision === 'ACEPTADA') {
        return 'POSITIVE';
    }

    if (decision === 'RECHAZADA') {
        return 'NEGATIVE';
    }

    return 'PENDING';
}

function construirIncrementosDecisionSemanal(decision) {
    return {
        total_feedback: admin.firestore.FieldValue.increment(1),
        total_aceptadas: admin.firestore.FieldValue.increment(decision === 'ACEPTADA' ? 1 : 0),
        total_rechazadas: admin.firestore.FieldValue.increment(decision === 'RECHAZADA' ? 1 : 0),
        total_pendientes: admin.firestore.FieldValue.increment(decision === 'PENDIENTE' ? 1 : 0),
        total_negative_examples: admin.firestore.FieldValue.increment(decision === 'RECHAZADA' ? 1 : 0),
        total_positive_examples: admin.firestore.FieldValue.increment(decision === 'ACEPTADA' ? 1 : 0)
    };
}

function serializarFechaFirestore(valor) {
    if (!valor) {
        return null;
    }

    if (valor instanceof Date) {
        return valor.toISOString();
    }

    if (typeof valor.toDate === 'function') {
        return valor.toDate().toISOString();
    }

    return null;
}

function calcularEstadoImpactoPlan(cantidadEmpleadosMovidos) {
    const cantidad = Number(cantidadEmpleadosMovidos);

    if (!Number.isFinite(cantidad) || cantidad <= 0) {
        return 'bajo';
    }

    if (cantidad >= 10) {
        return 'alto';
    }

    if (cantidad >= 4) {
        return 'medio';
    }

    return 'bajo';
}

function formatearFechaISO(fecha) {
    if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) {
        return null;
    }

    return fecha.toISOString().slice(0, 10);
}

function obtenerInicioSemana(fechaReferencia = new Date()) {
    const fecha = new Date(fechaReferencia);
    const diaSemana = fecha.getUTCDay();
    const ajuste = diaSemana === 0 ? -6 : 1 - diaSemana;

    fecha.setUTCDate(fecha.getUTCDate() + ajuste);
    fecha.setUTCHours(0, 0, 0, 0);
    return fecha;
}

function obtenerSemanaKey(fechaReferencia = new Date()) {
    return formatearFechaISO(obtenerInicioSemana(fechaReferencia));
}

function normalizarDecisionIA(decision) {
    const valor = textoNormalizado(decision).toLowerCase();

    if (!valor) {
        return null;
    }

    if (['aceptada', 'aceptado', 'aprobar', 'aprobada', 'approved', 'approve', 'si', 's'].includes(valor)) {
        return 'ACEPTADA';
    }

    if (['rechazada', 'rechazado', 'rechazar', 'denied', 'deny', 'no'].includes(valor)) {
        return 'RECHAZADA';
    }

    if (['pendiente', 'postergada', 'diferida', 'defer', 'deferred'].includes(valor)) {
        return 'PENDIENTE';
    }

    return valor.toUpperCase();
}

function normalizarBooleano(valor) {
    if (typeof valor === 'boolean') {
        return valor;
    }

    const texto = textoNormalizado(valor).toLowerCase();
    if (!texto) {
        return null;
    }

    if (['1', 'true', 'si', 's', 'yes', 'correcto', 'correcta'].includes(texto)) {
        return true;
    }

    if (['0', 'false', 'no', 'incorrecto', 'incorrecta'].includes(texto)) {
        return false;
    }

    return null;
}

function extraerRutaTexto(item) {
    if (!item || typeof item !== 'object') {
        const textoDirecto = textoNormalizado(item);
        return textoDirecto || null;
    }

    const posibles = [
        item.ruta_id,
        item.id_ruta,
        item.ruta,
        item.ruta_codigo,
        item.nombre_ruta,
        item.nombre,
        item.ruta_nombre
    ];

    for (const candidato of posibles) {
        const texto = textoNormalizado(candidato);
        if (texto) {
            return texto;
        }
    }

    return null;
}

function incrementarFrecuenciaRuta(mapa, rutaTexto) {
    const ruta = textoNormalizado(rutaTexto);
    if (!ruta) {
        return;
    }

    mapa.set(ruta, (mapa.get(ruta) || 0) + 1);
}

function calcularProbabilidadCancelacionDesdeOcupacion(ocupacion) {
    const ocupacionNumero = Number(ocupacion);
    if (Number.isNaN(ocupacionNumero)) {
        return null;
    }

    if (ocupacionNumero >= 40) {
        return 0;
    }

    const probabilidad = Math.min(0.95, Math.max(0.4, (40 - ocupacionNumero) / 40));
    return Number(probabilidad.toFixed(2));
}

function crearIdRecomendacion(rutaId, indice = 0) {
    const fragmentoRuta = textoNormalizado(rutaId) || 'sin-ruta';
    return `REC-${Date.now()}-${fragmentoRuta}-${indice + 1}`;
}

function sanitizarInsight(insight, indice = 0) {
    if (!insight || typeof insight !== 'object') {
        return null;
    }

    const rutaId = textoNormalizado(insight.ruta_id || insight.id_ruta || insight.ruta);
    const titulo = textoNormalizado(insight.titulo || insight.title);
    const descripcion = textoNormalizado(insight.descripcion || insight.description);
    const prioridadRaw = textoNormalizado(insight.prioridad || 'media').toLowerCase();
    const prioridad = ['alta', 'media', 'baja'].includes(prioridadRaw) ? prioridadRaw : 'media';
    const probCancelacion = Number(insight.prob_cancelacion ?? insight.probabilidad_cancelacion);

    if (!rutaId || !titulo || !descripcion) {
        return null;
    }

    return {
        recomendacion_id: textoNormalizado(insight.recomendacion_id) || crearIdRecomendacion(rutaId, indice),
        titulo,
        descripcion,
        prioridad,
        ruta_id: rutaId,
        prob_cancelacion: Number.isFinite(probCancelacion) ? Number(probCancelacion.toFixed(2)) : null,
        ruta_alternativa_sugerida: textoNormalizado(
            insight.ruta_alternativa_sugerida || insight.ruta_destino_id || insight.ruta_destino || ''
        ) || null
    };
}

function sanitizarListaInsights(insights) {
    if (!Array.isArray(insights)) {
        return [];
    }

    return insights
        .map((insight, indice) => sanitizarInsight(insight, indice))
        .filter(Boolean);
}

function formatearPorcentaje(fraccion) {
    if (!Number.isFinite(fraccion)) {
        return 'N/D';
    }

    return `${(fraccion * 100).toFixed(2)}%`;
}

function construirResumenDecisiones(decisiones, limite = 4) {
    if (!Array.isArray(decisiones) || !decisiones.length) {
        return 'Sin decisiones recientes registradas.';
    }

    return decisiones.slice(0, limite).join(' | ');
}

async function construirAprendizajePrevioIA({ semanas = SEMANAS_MEMORIA_DEFECTO } = {}) {
    const frecuenciaRutas = new Map();
    const decisiones = [];
    let totalDecisiones = 0;
    let totalAceptadas = 0;
    let totalEvaluadas = 0;
    let totalAcertadas = 0;
    let semanasLeidas = 0;

    let historicoSnapshot;
    try {
        historicoSnapshot = await db
            .collection(COLECCION_HISTORICO_RECOMENDACIONES)
            .orderBy('semana_inicio', 'desc')
            .limit(semanas)
            .get();
    } catch (error) {
        console.warn('No se pudo ordenar historico_recomendaciones por semana_inicio. Se usa fallback simple.');
        historicoSnapshot = await db.collection(COLECCION_HISTORICO_RECOMENDACIONES).limit(semanas).get();
    }

    semanasLeidas = historicoSnapshot.size;

    historicoSnapshot.forEach((doc) => {
        const data = doc.data() || {};

        if (Array.isArray(data.rutas_criticas_recurrentes)) {
            data.rutas_criticas_recurrentes.forEach((ruta) => incrementarFrecuenciaRuta(frecuenciaRutas, ruta));
        }

        const recomendaciones = Array.isArray(data.recomendaciones) ? data.recomendaciones : [];
        recomendaciones.forEach((recomendacion) => {
            incrementarFrecuenciaRuta(frecuenciaRutas, extraerRutaTexto(recomendacion));

            const decision = normalizarDecisionIA(
                recomendacion.decision_admin || recomendacion.decision || recomendacion.feedback_admin
            );

            if (decision) {
                totalDecisiones += 1;
                if (decision === 'ACEPTADA') {
                    totalAceptadas += 1;
                }

                const rutaTexto = extraerRutaTexto(recomendacion) || 'Ruta sin identificar';
                decisiones.push(`${rutaTexto}: ${decision}`);
            }

            const evaluacion = normalizarBooleano(
                recomendacion.evaluacion_correcta ?? recomendacion.feedback_correcto ?? recomendacion.resultado_correcto
            );

            if (evaluacion !== null) {
                totalEvaluadas += 1;
                if (evaluacion) {
                    totalAcertadas += 1;
                }
            }
        });

        if (Array.isArray(data.decisiones_admin_recientes)) {
            data.decisiones_admin_recientes.forEach((decision) => {
                const texto = textoNormalizado(decision);
                if (texto) {
                    decisiones.push(texto);
                }
            });
        } else {
            const decisionTexto = textoNormalizado(data.decisiones_admin_recientes);
            if (decisionTexto) {
                decisiones.push(decisionTexto);
            }
        }

        if (Array.isArray(data.feedback_admin)) {
            data.feedback_admin.forEach((feedback) => {
                incrementarFrecuenciaRuta(frecuenciaRutas, extraerRutaTexto(feedback));

                const decision = normalizarDecisionIA(feedback.decision);
                if (decision) {
                    totalDecisiones += 1;
                    if (decision === 'ACEPTADA') {
                        totalAceptadas += 1;
                    }

                    const rutaTexto = extraerRutaTexto(feedback) || 'Ruta sin identificar';
                    decisiones.push(`${rutaTexto}: ${decision}`);
                }
            });
        }
    });

    let feedbackSnapshot;
    try {
        feedbackSnapshot = await db
            .collection(COLECCION_FEEDBACK_IA)
            .orderBy('creado_en', 'desc')
            .limit(Math.max(10, semanas * 8))
            .get();
    } catch (error) {
        console.warn('No se pudo ordenar ai_feedback_recomendaciones por creado_en. Se usa fallback simple.');
        feedbackSnapshot = await db.collection(COLECCION_FEEDBACK_IA).limit(Math.max(10, semanas * 8)).get();
    }

    feedbackSnapshot.forEach((doc) => {
        const data = doc.data() || {};
        incrementarFrecuenciaRuta(frecuenciaRutas, extraerRutaTexto(data));

        const decision = normalizarDecisionIA(data.decision);
        if (!decision) {
            return;
        }

        totalDecisiones += 1;
        if (decision === 'ACEPTADA') {
            totalAceptadas += 1;
        }

        const rutaTexto = extraerRutaTexto(data) || 'Ruta sin identificar';
        const motivo = textoNormalizado(data.razon) || textoNormalizado(data.motivo) || '';
        decisiones.push(motivo ? `${rutaTexto}: ${decision} (${motivo})` : `${rutaTexto}: ${decision}`);

        const evaluacion = normalizarBooleano(data.evaluacion_correcta ?? data.feedback_correcto ?? data.resultado_correcto);
        if (evaluacion !== null) {
            totalEvaluadas += 1;
            if (evaluacion) {
                totalAcertadas += 1;
            }
        }
    });

    const rutasCriticas = [...frecuenciaRutas.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ruta]) => ruta);

    const efectividad = totalEvaluadas > 0
        ? formatearPorcentaje(totalAcertadas / totalEvaluadas)
        : totalDecisiones > 0
            ? formatearPorcentaje(totalAceptadas / totalDecisiones)
            : 'N/D';

    const tasaAceptacion = totalDecisiones > 0
        ? formatearPorcentaje(totalAceptadas / totalDecisiones)
        : 'N/D';

    return {
        semanas_consideradas: semanasLeidas || semanas,
        rutas_criticas_recurrentes: rutasCriticas,
        efectividad_sugerencias_pasadas: efectividad,
        tasa_aceptacion_admin: tasaAceptacion,
        decisiones_admin_recientes: construirResumenDecisiones(decisiones),
        observacion: rutasCriticas.length
            ? 'El contexto prioriza patrones repetidos y decisiones recientes del administrador.'
            : 'Sin historico suficiente. Prioriza la metrica actual con validacion humana.'
    };
}

async function construirContextoIAConMemoria(rutasActuales, semanas = SEMANAS_MEMORIA_DEFECTO) {
    const aprendizajePrevio = await construirAprendizajePrevioIA({ semanas });

    return {
        metricas_actuales: Array.isArray(rutasActuales) ? rutasActuales : [],
        aprendizaje_previo: aprendizajePrevio
    };
}

function asientosOcupadosComoSet(asientosReservados, asientosPorEmpleado) {
    const ocupados = new Set(normalizarAsientosReservados(asientosReservados));

    Object.values(normalizarAsientosPorEmpleado(asientosPorEmpleado)).forEach((asiento) => {
        const numero = Number(asiento);
        if (Number.isInteger(numero) && numero > 0) {
            ocupados.add(numero);
        }
    });

    return ocupados;
}

function siguienteAsientoDisponible(asientosOcupados, capacidadMaxima) {
    const capacidad = Number(capacidadMaxima);
    if (!Number.isInteger(capacidad) || capacidad <= 0) {
        throw new Error('TARGET_CAPACITY_INVALID: Capacidad de destino invalida.');
    }

    for (let asiento = 1; asiento <= capacidad; asiento += 1) {
        if (!asientosOcupados.has(asiento)) {
            return asiento;
        }
    }

    throw new Error('TARGET_CAPACITY_EXCEEDED: No hay asientos disponibles en la ruta destino.');
}

function crearErrorHttp(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

async function existeIdEmpleado(idEmpleado, excluirUid = null) {
    const id = textoNormalizado(idEmpleado);
    if (!id) {
        return false;
    }

    const snapshot = await db
        .collection('usuarios')
        .where('id_empleado', '==', id)
        .limit(1)
        .get();

    if (snapshot.empty) {
        return false;
    }

    if (excluirUid && snapshot.docs[0].id === excluirUid) {
        return false;
    }

    return true;
}

async function contarEmpleadosDeJefe(jefeUid) {
    const snapshot = await db
        .collection('usuarios')
        .where('rol', '==', ROLES.EMPLEADO)
        .where('jefe_uid', '==', jefeUid)
        .get();

    let total = 0;
    snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (data.activo !== false) {
            total += 1;
        }
    });

    return total;
}

function esRutaActiva(rutaData) {
    if (!rutaData || typeof rutaData !== 'object') {
        return true;
    }

    return rutaData.activa !== false;
}

async function resolverEmpleadoPorIdEmpleado(idEmpleado, cache = new Map()) {
    const id = textoNormalizado(idEmpleado);
    if (!id) {
        return null;
    }

    if (cache.has(id)) {
        return cache.get(id);
    }

    const snapshot = await db.collection('usuarios')
        .where('id_empleado', '==', id)
        .where('rol', '==', ROLES.EMPLEADO)
        .limit(1)
        .get();

    const empleado = !snapshot.empty
        ? {
            id_empleado: id,
            nombre: textoNormalizado(snapshot.docs[0].data()?.nombre) || id,
            email: textoNormalizado(snapshot.docs[0].data()?.email) || null,
        }
        : {
            id_empleado: id,
            nombre: id,
            email: null,
        };

    cache.set(id, empleado);
    return empleado;
}

async function obtenerBloqueoEliminacionRuta(idRuta) {
    const rutaEncontrada = await resolverRutaPorIdentificador(idRuta);
    if (!rutaEncontrada) {
        throw crearErrorHttp(404, 'La ruta no existe.');
    }

    const fechaMinima = fechaISOHoy();
    const snapshot = await db.collection('programacion_diaria')
        .where('id_ruta', '==', rutaEncontrada.id)
        .get();

    const empleadosMap = new Map();
    const cacheEmpleados = new Map();

    snapshot.forEach((doc) => {
        const data = doc.data() || {};
        const fecha = textoNormalizado(data.fecha);
        if (!fecha || fecha < fechaMinima) {
            return;
        }

        // Formato nuevo (mapa `pasajeros` con nombre desnormalizado) con fallback al legado.
        const pasajeros = extraerPasajerosProgramacion(data);
        if (!pasajeros.total) {
            return;
        }

        const turno = textoNormalizado(data.turno) || null;

        pasajeros.ids.forEach((idEmpleado) => {
            const detalle = pasajeros.detalle[idEmpleado] || {};
            const asiento = Number.isFinite(Number(detalle.asiento)) ? Number(detalle.asiento) : null;

            const clave = `${idEmpleado}|${fecha}|${turno || ''}`;
            if (!empleadosMap.has(clave)) {
                empleadosMap.set(clave, {
                    id_empleado: idEmpleado,
                    fecha,
                    turno,
                    asiento,
                    nombre_desnormalizado: detalle.nombre && detalle.nombre !== idEmpleado ? detalle.nombre : null,
                });
            }
        });
    });

    const empleadosPendientes = Array.from(empleadosMap.values());

    // Solo resuelve contra `usuarios` los empleados sin nombre desnormalizado (docs legados).
    await Promise.all(
        empleadosPendientes.map(async (item) => {
            if (item.nombre_desnormalizado) {
                item.nombre = item.nombre_desnormalizado;
                item.email = null;
            } else {
                const info = await resolverEmpleadoPorIdEmpleado(item.id_empleado, cacheEmpleados);
                item.nombre = info?.nombre || item.id_empleado;
                item.email = info?.email || null;
            }
            delete item.nombre_desnormalizado;
        })
    );

    empleadosPendientes.sort((a, b) => {
        const fechaCmp = String(a.fecha).localeCompare(String(b.fecha));
        if (fechaCmp !== 0) {
            return fechaCmp;
        }

        return String(a.nombre).localeCompare(String(b.nombre), 'es');
    });

    const rutaData = rutaEncontrada.data || {};

    return {
        ruta: {
            id: rutaEncontrada.id,
            ruta: rutaData.ruta ?? null,
            zona: rutaData.zona || rutaData.nombre || null,
            tipo_unidad: rutaData['tipo de unidad'] || null,
            activa: esRutaActiva(rutaData),
            eliminada_en: rutaData.eliminada_en || null,
        },
        puede_eliminar: empleadosPendientes.length === 0,
        total_pasajeros: empleadosPendientes.length,
        empleados_a_reasignar: empleadosPendientes,
    };
}

async function liberarAsignacionesPorIdEmpleado(idEmpleado) {
    const id = textoNormalizado(idEmpleado);
    if (!id) {
        return 0;
    }

    // Query por array legado (mientras exista) + query por fecha para docs ya
    // migrados al mapa `pasajeros{}`; se filtra membresía en memoria.
    const [snapshotLegado, snapshotFuturo] = await Promise.all([
        db.collection('programacion_diaria')
            .where('pasajeros_ids', 'array-contains', id)
            .get(),
        db.collection('programacion_diaria')
            .where('fecha', '>=', fechaISOHoy())
            .get(),
    ]);

    const docsPorId = new Map();
    snapshotLegado.forEach((doc) => docsPorId.set(doc.id, doc));
    snapshotFuturo.forEach((doc) => {
        if (docsPorId.has(doc.id)) {
            return;
        }
        const pasajeros = extraerPasajerosProgramacion(doc.data() || {});
        if (pasajeros.ids.includes(id)) {
            docsPorId.set(doc.id, doc);
        }
    });

    if (!docsPorId.size) {
        return 0;
    }

    const actualizaciones = [];

    docsPorId.forEach((doc) => {
        const data = doc.data() || {};
        const pasajerosActuales = Array.isArray(data.pasajeros_ids) ? data.pasajeros_ids : [];
        const pasajerosIds = pasajerosActuales.filter((pasajero) => textoNormalizado(pasajero) !== id);
        const asientosPorEmpleado = normalizarAsientosPorEmpleado(data.asientos_por_empleado);
        delete asientosPorEmpleado[id];

        actualizaciones.push({
            ref: doc.ref,
            pasajeros_ids: pasajerosIds,
            asientos_por_empleado: asientosPorEmpleado,
        });
    });

    const BATCH_SIZE = 400;
    for (let indice = 0; indice < actualizaciones.length; indice += BATCH_SIZE) {
        const lote = actualizaciones.slice(indice, indice + BATCH_SIZE);
        const batch = db.batch();

        lote.forEach((item) => {
            // Dual-write: actualiza campos legados y retira del mapa nuevo `pasajeros`.
            // FieldPath evita problemas con guiones en el id (ej. EMP-1042).
            batch.update(
                item.ref,
                'pasajeros_ids', item.pasajeros_ids,
                'asientos_por_empleado', item.asientos_por_empleado,
                new admin.firestore.FieldPath('pasajeros', id), admin.firestore.FieldValue.delete(),
                'actualizado_en', new Date()
            );
        });

        await batch.commit();
    }

    return actualizaciones.length;
}

function normalizarAsignacionUnidadTurno(data) {
    if (!data || typeof data !== 'object') {
        return null;
    }

    const vehiculoId = textoNormalizado(data.vehiculo_id);
    const turnoId = turnoNormalizado(data.turno_id);
    if (!vehiculoId || !turnoId) {
        return null;
    }

    return {
        vehiculo_id: vehiculoId,
        turno_id: turnoId,
        vehiculo_codigo: textoNormalizado(data.vehiculo_codigo) || null,
        turno_nombre: textoNormalizado(data.turno_nombre) || null,
    };
}

function extraerVehiculoIdProgramacion(data) {
    const programacion = data || {};
    return textoNormalizado(programacion.vehiculo?.id || programacion.vehiculo_id);
}

function esProgramacionCancelada(data) {
    const estado = textoNormalizado(data?.estado || data?.estado_programacion).toLowerCase();
    return estado === 'cancelada';
}

function validarVehiculoProgramacionCoincide(vehiculoId, programacionData) {
    const vehiculoEsperado = textoNormalizado(vehiculoId);
    const vehiculoProgramacion = extraerVehiculoIdProgramacion(programacionData);
    return Boolean(vehiculoEsperado && vehiculoProgramacion && vehiculoEsperado === vehiculoProgramacion);
}

async function limpiarCamioneroDeVehiculo(vehiculoId, turnoId, transaction = null) {
    const vehiculoIdTexto = textoNormalizado(vehiculoId);
    const turnoTexto = turnoNormalizado(turnoId);
    if (!vehiculoIdTexto || !turnoTexto) {
        return;
    }

    const vehiculoRef = db.collection('vehiculos').doc(vehiculoIdTexto);
    const vehiculoDoc = await leerDoc(vehiculoRef, transaction);
    if (!vehiculoDoc.exists) {
        return;
    }

    const data = vehiculoDoc.data() || {};
    const camioneroPorTurno = data.camionero_por_turno && typeof data.camionero_por_turno === 'object'
        ? { ...data.camionero_por_turno }
        : {};

    if (!camioneroPorTurno[turnoTexto]) {
        return;
    }

    delete camioneroPorTurno[turnoTexto];
    const updates = {
        camionero_por_turno: camioneroPorTurno,
        actualizado_en: new Date(),
    };

    if (transaction) {
        transaction.set(vehiculoRef, updates, { merge: true });
    } else {
        await vehiculoRef.set(updates, { merge: true });
    }
}

async function limpiarAsignacionCamionero(camioneroUid, camioneroData = {}, solicitanteUid = null, transaction = null) {
    const asignacion = normalizarAsignacionUnidadTurno(camioneroData.asignacion_unidad_turno);
    if (!asignacion) {
        return;
    }

    await limpiarCamioneroDeVehiculo(asignacion.vehiculo_id, asignacion.turno_id, transaction);

    const camioneroRef = db.collection('usuarios').doc(camioneroUid);
    const updates = {
        asignacion_unidad_turno: null,
        actualizado_en: new Date(),
        actualizado_por: solicitanteUid || camioneroUid,
    };

    if (transaction) {
        transaction.set(camioneroRef, updates, { merge: true });
    } else {
        await camioneroRef.set(updates, { merge: true });
    }
}

async function asignarCamioneroUnidadTurno({
    camioneroUid,
    vehiculoId = null,
    turnoId = null,
    solicitanteUid,
}) {
    const camioneroRef = db.collection('usuarios').doc(camioneroUid);
    const camioneroSnap = await camioneroRef.get();

    if (!camioneroSnap.exists) {
        throw crearErrorHttp(404, 'Camionero no encontrado.');
    }

    const camioneroData = camioneroSnap.data() || {};
    if (camioneroData.rol !== ROLES.CAMIONERO) {
        throw crearErrorHttp(403, 'El usuario no tiene rol CAMIONERO.');
    }

    const vehiculoIdTexto = textoNormalizado(vehiculoId);
    const turnoTexto = turnoNormalizado(turnoId);

    if (!vehiculoIdTexto && !turnoTexto) {
        await limpiarAsignacionCamionero(camioneroUid, camioneroData, solicitanteUid);
        return null;
    }

    if (!vehiculoIdTexto || !turnoTexto) {
        throw crearErrorHttp(400, 'vehiculo_id y turno_id son requeridos para asignar.');
    }

    const vehiculoRef = db.collection('vehiculos').doc(vehiculoIdTexto);
    const turnoRef = db.collection('turnos').doc(turnoTexto);

    await db.runTransaction(async (t) => {
        const [vehiculoSnap, turnoSnap, camioneroActualSnap] = await Promise.all([
            t.get(vehiculoRef),
            t.get(turnoRef),
            t.get(camioneroRef),
        ]);

        if (!vehiculoSnap.exists) {
            throw crearErrorHttp(404, 'La unidad seleccionada no existe.');
        }
        if (!turnoSnap.exists) {
            throw crearErrorHttp(404, 'El turno seleccionado no existe.');
        }

        const camioneroActual = camioneroActualSnap.data() || {};
        const asignacionPrevia = normalizarAsignacionUnidadTurno(camioneroActual.asignacion_unidad_turno);

        const vehiculoData = vehiculoSnap.data() || {};
        const camioneroPorTurno = vehiculoData.camionero_por_turno && typeof vehiculoData.camionero_por_turno === 'object'
            ? { ...vehiculoData.camionero_por_turno }
            : {};

        const camioneroPrevioEnPar = camioneroPorTurno[turnoTexto];
        if (camioneroPrevioEnPar?.uid && camioneroPrevioEnPar.uid !== camioneroUid) {
            const prevRef = db.collection('usuarios').doc(camioneroPrevioEnPar.uid);
            t.set(prevRef, {
                asignacion_unidad_turno: null,
                actualizado_en: new Date(),
                actualizado_por: solicitanteUid,
            }, { merge: true });
        }

        if (asignacionPrevia
            && (asignacionPrevia.vehiculo_id !== vehiculoIdTexto || asignacionPrevia.turno_id !== turnoTexto)) {
            const vehiculoPrevRef = db.collection('vehiculos').doc(asignacionPrevia.vehiculo_id);
            const vehiculoPrevSnap = await t.get(vehiculoPrevRef);
            if (vehiculoPrevSnap.exists) {
                const prevData = vehiculoPrevSnap.data() || {};
                const prevMap = prevData.camionero_por_turno && typeof prevData.camionero_por_turno === 'object'
                    ? { ...prevData.camionero_por_turno }
                    : {};
                if (prevMap[asignacionPrevia.turno_id]?.uid === camioneroUid) {
                    delete prevMap[asignacionPrevia.turno_id];
                    t.set(vehiculoPrevRef, {
                        camionero_por_turno: prevMap,
                        actualizado_en: new Date(),
                    }, { merge: true });
                }
            }
        }

        const turnoData = turnoSnap.data() || {};
        const vehiculoCodigo = textoNormalizado(vehiculoData.codigo) || vehiculoIdTexto;
        const turnoNombre = textoNormalizado(turnoData.nombre) || turnoTexto;
        const idCamionero = textoNormalizado(camioneroActual.id_camionero)
            || `CAM-${camioneroUid.slice(-6).toUpperCase()}`;

        const asignacion = {
            vehiculo_id: vehiculoIdTexto,
            turno_id: turnoTexto,
            vehiculo_codigo: vehiculoCodigo,
            turno_nombre: turnoNombre,
        };

        camioneroPorTurno[turnoTexto] = {
            uid: camioneroUid,
            id_camionero: idCamionero,
            nombre: textoNormalizado(camioneroActual.nombre) || 'Camionero',
        };

        t.set(camioneroRef, {
            asignacion_unidad_turno: asignacion,
            actualizado_en: new Date(),
            actualizado_por: solicitanteUid,
        }, { merge: true });

        t.set(vehiculoRef, {
            camionero_por_turno: camioneroPorTurno,
            actualizado_en: new Date(),
            actualizado_por: solicitanteUid,
        }, { merge: true });
    });

    const actualizado = await camioneroRef.get();
    return normalizarAsignacionUnidadTurno(actualizado.data()?.asignacion_unidad_turno);
}

async function resolverRutaEmpleadoPorUnidadTurno(fecha, turnoId, vehiculoId, idEmpleado) {
    const fechaTexto = textoNormalizado(fecha);
    const turnoTexto = turnoNormalizado(turnoId);
    const vehiculoIdTexto = textoNormalizado(vehiculoId);
    const idEmpleadoTexto = textoNormalizado(idEmpleado);

    if (!fechaTexto || !turnoTexto || !vehiculoIdTexto || !idEmpleadoTexto) {
        throw crearErrorHttp(400, 'Fecha, turno, vehículo e id_empleado son requeridos.');
    }

    const snapshot = await db.collection('programacion_diaria')
        .where('fecha', '==', fechaTexto)
        .get();

    const candidatos = [];

    snapshot.forEach((doc) => {
        const data = doc.data() || {};
        const turnoProgramacion = turnoNormalizado(data.turno_id || data.turno);
        if (turnoProgramacion !== turnoTexto) {
            return;
        }
        if (!validarVehiculoProgramacionCoincide(vehiculoIdTexto, data)) {
            return;
        }
        if (esProgramacionCancelada(data)) {
            return;
        }

        const pasajeros = extraerPasajerosProgramacion(data);
        if (!pasajeros.detalle[idEmpleadoTexto]) {
            return;
        }

        candidatos.push({
            id_ruta: textoNormalizado(data.id_ruta),
            programacion: {
                docId: doc.id,
                docRef: doc.ref,
                data,
            },
        });
    });

    if (!candidatos.length) {
        throw crearErrorHttp(
            409,
            'El empleado no está programado en ninguna ruta de tu unidad para esa fecha y turno.'
        );
    }

    if (candidatos.length > 1) {
        throw crearErrorHttp(
            409,
            'El empleado aparece en más de una ruta con la misma unidad y turno.'
        );
    }

    return candidatos[0];
}

async function eliminarUsuarioDefinitivo({
    uid,
    rolEsperado = null,
    usuarioSolicitante = null,
    validarPermisoEmpleado = false,
    invalidarCacheUsuario = null,
}) {
    const ref = db.collection('usuarios').doc(uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
        throw crearErrorHttp(404, 'Usuario no encontrado.');
    }

    const data = snapshot.data() || {};

    if (rolEsperado && data.rol !== rolEsperado) {
        throw crearErrorHttp(
            403,
            `Solo se pueden eliminar usuarios con rol ${rolEsperado}.`
        );
    }

    if (validarPermisoEmpleado && !puedeGestionarEmpleado(usuarioSolicitante, data)) {
        throw crearErrorHttp(403, 'No puedes eliminar empleados que no te pertenecen.');
    }

    if (data.rol === ROLES.JEFE) {
        const empleadosAsignados = await contarEmpleadosDeJefe(uid);
        if (empleadosAsignados > 0) {
            throw crearErrorHttp(
                409,
                `No se puede eliminar: tiene ${empleadosAsignados} empleado(s) asignados. Reasígnalos o elimínalos primero.`
            );
        }
    }

    if (data.rol === ROLES.EMPLEADO) {
        const idEmpleado = textoNormalizado(data.id_empleado) || construirIdEmpleadoDesdeUid(uid);
        await liberarAsignacionesPorIdEmpleado(idEmpleado);
    }

    if (data.rol === ROLES.CAMIONERO) {
        await limpiarAsignacionCamionero(uid, data, usuarioSolicitante?.uid || uid);
    }

    try {
        await admin.auth().deleteUser(uid);
    } catch (error) {
        if (error.code !== 'auth/user-not-found') {
            throw error;
        }
    }

    await ref.delete();

    if (typeof invalidarCacheUsuario === 'function') {
        invalidarCacheUsuario(uid);
    }

    return {
        uid,
        rol: data.rol,
    };
}

module.exports = {
    admin,
    db,
    cargarCredencialesFirebase,
    esEmailValido,
    generarPasswordTemporal,
    escapeHtml,
    normalizarVariableEntorno,
    obtenerFrontendUrl,
    obtenerActionCodeSettingsAuth,
    obtenerClienteResend,
    verificarTransporterSMTP,
    enviarCorreoCredencialesAcceso,
    enviarCorreoRestablecimiento,
    programarEnvioCorreoCredencialesAcceso,
    programarEnvioCorreoAltaEmpleado,
    programarEnvioCorreoAltaJefe,
    programarEnvioCorreoAltaAdmin,
    enviarCorreoAltaEmpleado,
    enviarCorreoAltaJefe,
    enviarCorreoAltaAdmin,
    enviarCorreoAsignacionSemanal,
    programarEnvioCorreoAsignacionSemanal,
    formatearValorPorcentaje,
    convertirAFecha,
    formatearFechaISO,
    obtenerNumeroSemanaISO,
    obtenerRangoSemanaISO,
    diasOperacionPorTurno,
    turnosCompartenDia,
    diasEnComunTurnos,
    nombreDiaOperacion,
    registrarDiasOperacionTurno,
    limpiarCacheDiasOperacionTurno,
    precargarCacheDiasOperacionTurnos,
    fechasOperacionSemana,
    evaluarAlertas,
    construirMetricasOperativas,
    normalizarPeriodoRuta,
    generarIdEmpleadoUnico,
    construirIdEmpleadoDesdeUid,
    generarIdEmpleadoDeterministicoUnico,
    asegurarIdEmpleadoPersistido,
    normalizarEmpleado,
    normalizarJefe,
    puedeGestionarEmpleado,
    existeIdEmpleado,
    contarEmpleadosDeJefe,
    liberarAsignacionesPorIdEmpleado,
    esRutaActiva,
    resolverEmpleadoPorIdEmpleado,
    obtenerBloqueoEliminacionRuta,
    eliminarUsuarioDefinitivo,
    normalizarAsignacionUnidadTurno,
    extraerVehiculoIdProgramacion,
    esProgramacionCancelada,
    validarVehiculoProgramacionCoincide,
    limpiarAsignacionCamionero,
    asignarCamioneroUnidadTurno,
    resolverRutaEmpleadoPorUnidadTurno,
    crearErrorHttp,
    textoNormalizado,
    turnoNormalizado,
    construirIdsProgramacion,
    normalizarAsientosReservados,
    normalizarAsientosPorEmpleado,
    normalizarPasajerosDetalle,
    extraerPasajerosProgramacion,
    construirVehiculoSnapshot,
    resolverUnidadTurno,
    leerDoc,
    leerQuery,
    resolverRutaPorIdentificador,
    resolverProgramacion,
    construirProgramacionBase,
    crearClienteOpenAI,
    esTimeoutOpenAI,
    generarRespuestaFallback,
    fechaISOHoy,
    construirResumenOperativoChat,
    obtenerContextoEmpleadosChat,
    obtenerPlanesIARecientesChat,
    obtenerResumenProgramacionChat,
    generarInsightsLocales,
    COLECCION_HISTORICO_RECOMENDACIONES,
    COLECCION_FEEDBACK_IA,
    COLECCION_PLANES_IA,
    SEMANAS_MEMORIA_DEFECTO,
    DECISIONES_IA_VALIDAS,
    obtenerTipoEjemploPorDecision,
    construirIncrementosDecisionSemanal,
    serializarFechaFirestore,
    calcularEstadoImpactoPlan,
    formatearFechaISO: formatearFechaISO,
    obtenerInicioSemana,
    obtenerSemanaKey,
    normalizarDecisionIA,
    normalizarBooleano,
    extraerRutaTexto,
    incrementarFrecuenciaRuta,
    calcularProbabilidadCancelacionDesdeOcupacion,
    crearIdRecomendacion,
    sanitizarInsight,
    sanitizarListaInsights,
    formatearPorcentaje,
    construirResumenDecisiones,
    construirAprendizajePrevioIA,
    construirContextoIAConMemoria,
    asientosOcupadosComoSet,
    siguienteAsientoDisponible,
};
