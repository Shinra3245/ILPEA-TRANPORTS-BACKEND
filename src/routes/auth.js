const express = require('express');
const { ROLES, obtenerPermisosDelRol } = require('../config/roles');
const { admin, esEmailValido, obtenerActionCodeSettingsAuth, enviarCorreoRestablecimiento } = require('../lib/utils');

const router = express.Router();

// Rate-limit simple en memoria: máximo 3 solicitudes por correo cada 10 min
const resetSolicitudes = new Map();
function verificarRateLimit(email) {
    const ahora = Date.now();
    const VENTANA_MS = 10 * 60 * 1000;
    const MAX_INTENTOS = 3;
    const entrada = resetSolicitudes.get(email) || { count: 0, desde: ahora };
    if (ahora - entrada.desde > VENTANA_MS) {
        resetSolicitudes.set(email, { count: 1, desde: ahora });
        return true;
    }
    if (entrada.count >= MAX_INTENTOS) return false;
    entrada.count += 1;
    resetSolicitudes.set(email, entrada);
    return true;
}

router.get('/auth/me', (req, res) => {
  if (!req.usuario) {
    return res.status(401).json({
      success: false,
      message: 'No autenticado'
    });
  }

  return res.json({
    success: true,
    usuario: {
      uid: req.usuario.uid,
      email: req.usuario.email,
      nombre: req.usuario.nombre,
      rol: req.usuario.rol,
      id_empleado: req.usuario.id_empleado || null,
      id_camionero: req.usuario.id_camionero || null,
      permisos: obtenerPermisosDelRol(req.usuario.rol)
    }
  });
});

router.post('/auth/enviar-reset', async (req, res) => {
    const email = String(req.body?.email || '').trim();

    process.stdout.write(`[reset] solicitud recibida para: ${email}\n`);

    if (!email || !esEmailValido(email)) {
        return res.status(400).json({ success: false, message: 'Correo no válido.' });
    }

    if (!verificarRateLimit(email)) {
        return res.status(429).json({ success: false, message: 'Demasiados intentos. Espera unos minutos antes de reintentar.' });
    }

    const frontendUrl = obtenerActionCodeSettingsAuth().url.replace(/\/auth\/action$/, '');
    process.stdout.write(`[reset] frontendUrl: "${frontendUrl}"\n`);

    try {
        await admin.auth().getUserByEmail(email);
        process.stdout.write(`[reset] usuario encontrado en Firebase\n`);
    } catch (err) {
        process.stdout.write(`[reset] usuario no encontrado: ${err.message}\n`);
        return res.json({ success: true, message: 'Si existe una cuenta con ese correo, recibirás el enlace en breve.' });
    }

    let enlace;
    try {
        process.stdout.write(`[reset] generando OOB link...\n`);
        enlace = await admin.auth().generatePasswordResetLink(email, obtenerActionCodeSettingsAuth());
        process.stdout.write(`[reset] OOB link generado OK\n`);
    } catch (err) {
        process.stdout.write(`[reset] ERROR generatePasswordResetLink: ${err.code} — ${err.message}\n`);
        return res.status(500).json({
            success: false,
            message: 'No se pudo generar el enlace. Verifica FRONTEND_URL en backend/.env y que el dominio esté autorizado en Firebase.',
        });
    }

    const resultado = await enviarCorreoRestablecimiento({ email, enlace });
    process.stdout.write(`[reset] correo enviado: ${resultado.enviado} (${resultado.motivo || 'OK'})\n`);

    if (!resultado.enviado) {
        process.stdout.write(`[reset] detalle SMTP: ${resultado.detalle}\n`);
    }

    return res.json({ success: true, message: 'Si existe una cuenta con ese correo, recibirás el enlace en breve.' });
});

router.post('/auth/login', (req, res) => {
  const modoAuth = (process.env.AUTH_MODE || 'firebase').toLowerCase();
  if (modoAuth !== 'simulated') {
    return res.status(403).json({
      success: false,
      message: 'Login simulado deshabilitado. Usa Firebase Auth en modo real.'
    });
  }

  const { email, rol = ROLES.EMPLEADO } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: 'Email requerido'
    });
  }

  return res.json({
    success: true,
    message: 'Login simulado exitoso',
    usuario: {
      email,
      rol,
      nombre: rol === ROLES.ADMIN ? 'Admin' :
        rol === ROLES.JEFE ? 'Jefe' :
          rol === ROLES.CAMIONERO ? 'Camionero' : 'Empleado'
    },
    token: 'simulado-token-' + Date.now()
  });
});

module.exports = router;
