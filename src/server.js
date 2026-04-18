// backend/src/server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const adminRoutes = require('./routes/admin');
const app = express();


// Importar configuración de RBAC
const { ROLES, obtenerPermisosDelRol } = require('./config/roles');
const { autenticar, autorizar, autenticarSimulado, registrarAccion } = require('./middleware/auth');

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

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

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

let smtpTransporter = null;

function escapeHtml(valor) {
  return String(valor || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function obtenerTransporterSMTP() {
  if (smtpTransporter) {
    return smtpTransporter;
  }

  const host = String(process.env.MAIL_HOST || '').trim();
  const user = String(process.env.MAIL_USER || '').trim();
  const pass = String(process.env.MAIL_PASS || '').trim();
  const port = Number(process.env.MAIL_PORT || 465);
  const secure = String(process.env.MAIL_SECURE || 'true').trim().toLowerCase() !== 'false';

  if (!host || !user || !pass) {
    return null;
  }

  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass
    }
  });

  return smtpTransporter;
}

async function enviarCorreoAltaEmpleado({ nombre, email, idEmpleado, password }) {
  const transporter = obtenerTransporterSMTP();
  if (!transporter) {
    return {
      enviado: false,
      motivo: 'SMTP_NO_CONFIGURADO'
    };
  }

  const remitenteEmail = String(process.env.MAIL_FROM_EMAIL || process.env.MAIL_USER || '').trim();
  const remitenteNombre = String(process.env.MAIL_FROM_NAME || 'ILPEA TRANSPORTS').trim();

  const nombreSeguro = escapeHtml(nombre);
  const emailSeguro = escapeHtml(email);
  const idSeguro = escapeHtml(idEmpleado);
  const passwordSeguro = escapeHtml(password);

  const asunto = 'Credenciales de acceso - ILPEA TRANSPORTS';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #111827;">
      <h2 style="margin-bottom: 8px;">Bienvenido(a) a ILPEA TRANSPORTS</h2>
      <p>Se ha creado tu usuario con los siguientes datos:</p>
      <ul>
        <li><strong>ID de empleado:</strong> ${idSeguro}</li>
        <li><strong>Nombre:</strong> ${nombreSeguro}</li>
        <li><strong>Correo:</strong> ${emailSeguro}</li>
        <li><strong>Contraseña temporal:</strong> ${passwordSeguro}</li>
      </ul>
      <p>Por seguridad, cambia tu contraseña después de iniciar sesión.</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb;" />
      <p style="font-size: 12px; color: #6b7280;">Este es un mensaje automático, por favor no respondas este correo.</p>
    </div>
  `;

  const text = [
    'Bienvenido(a) a ILPEA TRANSPORTS.',
    'Se ha creado tu usuario con los siguientes datos:',
    `ID de empleado: ${idEmpleado}`,
    `Nombre: ${nombre}`,
    `Correo: ${email}`,
    `Contrasena temporal: ${password}`,
    'Por seguridad, cambia tu contrasena despues de iniciar sesion.'
  ].join('\n');

  try {
    await transporter.sendMail({
      from: remitenteEmail ? `"${remitenteNombre}" <${remitenteEmail}>` : undefined,
      to: email,
      subject: asunto,
      html,
      text
    });

    return {
      enviado: true,
      motivo: null
    };
  } catch (error) {
    console.warn('No se pudo enviar correo de alta de empleado:', error.message);
    return {
      enviado: false,
      motivo: 'SMTP_ENVIO_FALLIDO'
    };
  }
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

  // Si no se especifica turno, buscamos cualquier programación existente
  // para esa fecha y ruta sin depender del formato del docId.
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
  const capacidad = Number(rutaData.capacidad_real) || 12;

  return {
    fecha: textoNormalizado(fecha),
    turno: turnoNormalizado(turno) || null,
    id_ruta: textoNormalizado(idRuta),
    capacidad_limite: capacidad,
    asientos_ocupados: 0,
    asientos_reservados: [],
    pasajeros_ids: [],
    asientos_por_empleado: {},
    programada_auto: true,
    zona: rutaData.zona || rutaData.nombre || null,
    tipo_unidad: rutaData['tipo de unidad'] || null,
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
      timeout: 60000, // 👈 Aumentamos a 60 segundos para mayor estabilidad en OCI
      maxRetries: 2    // 👈 Permitimos un reintento automático si falla la conexión
    });
  } catch (error) {
    console.warn('OpenAI deshabilitado: error de carga.');
    return null;
  }
}

const openai = crearClienteOpenAI();

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

function formatearValorPorcentaje(valor, decimales = 2) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) {
    return 'N/D';
  }

  return numero.toFixed(decimales);
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
        .collection(COLECCION_PLANES_IA)
        .orderBy('creado_en', 'desc')
        .limit(limite)
        .get();
    } catch (errorOrden) {
      snapshot = await db.collection(COLECCION_PLANES_IA).limit(limite).get();
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
  const diaSemana = fecha.getUTCDay(); // 0 domingo, 1 lunes
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

// Middlewares Globales
app.use(cors());
app.use(express.json()); // Permite recibir datos en formato JSON
app.use('/api', adminRoutes);

app.get('/api/test-ilpea', (req, res) => {
  res.json({ message: "El prefijo /api funciona correctamente" });
});
// Middleware de autenticación (simulado para desarrollo - cambiar en producción)
// Por defecto usa Firebase Auth real. Para pruebas locales: AUTH_MODE=simulated
app.use((req, res, next) => {
  if (req.path === '/api/auth/login') return next();

  const modoAuth = (process.env.AUTH_MODE || 'firebase').toLowerCase();
  if (modoAuth === 'simulated') {
    return autenticarSimulado(req, res, next);
  }
  return autenticar(req, res, next);
});


app.use('/api', adminRoutes);


// Middleware de logging/auditoría
app.use(registrarAccion('acciones'));

// Evita caída completa del proceso por errores async no manejados.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// ==========================================
// ENDPOINT 1: Obtener todas las rutas
// (Consumido por el Dashboard del Administrador, Jefe y Empleado)
// ==========================================
app.get('/api/rutas', autorizar('rutas:ver'), async (req, res) => {
  try {
    const rutasSnapshot = await db.collection('rutas').get();
    const rutas = [];

    rutasSnapshot.forEach(doc => {
      const rutaData = doc.data() || {};
      rutas.push({
        id: doc.id,
        ...rutaData,
        ...normalizarPeriodoRuta(rutaData)
      });
    });

    res.status(200).json({
      success: true,
      cantidad: rutas.length,
      data: rutas
    });
  } catch (error) {
    console.error("Error obteniendo rutas:", error);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

app.get('/api/rutas/programadas', autorizar('rutas:ver'), async (req, res) => {
  const fecha = textoNormalizado(req.query.fecha);
  const turno = turnoNormalizado(req.query.turno);

  if (!fecha) {
    return res.status(400).json({
      success: false,
      message: 'Debes enviar la fecha en query param: ?fecha=YYYY-MM-DD'
    });
  }

  try {
    const rutasSnapshot = await db.collection('rutas').get();

    const rutas = await Promise.all(rutasSnapshot.docs.map(async (rutaDoc) => {
      const rutaData = rutaDoc.data() || {};
      const programacion = await resolverProgramacion(fecha, rutaDoc.id, turno);
      const dataProgramacion = programacion.data || {};

      const capacidadLimite = Number(dataProgramacion.capacidad_limite) || Number(rutaData.capacidad_real) || 12;
      const asientosReservados = normalizarAsientosReservados(dataProgramacion.asientos_reservados);
      const asientosPorEmpleado = normalizarAsientosPorEmpleado(dataProgramacion.asientos_por_empleado);
      const pasajerosIds = Array.isArray(dataProgramacion.pasajeros_ids) ? dataProgramacion.pasajeros_ids : [];
      const asientosOcupadosDato = Number(dataProgramacion.asientos_ocupados);
      const asientosOcupados = Number.isFinite(asientosOcupadosDato)
        ? asientosOcupadosDato
        : Math.max(asientosReservados.length, pasajerosIds.length);

      return {
        id: rutaDoc.id,
        ...rutaData,
        ...normalizarPeriodoRuta({ ...rutaData, fecha_programada: fecha }, convertirAFecha(fecha) || new Date()),
        programada: Boolean(programacion.data),
        programacion_id: programacion.docId,
        fecha_programada: fecha,
        turno_programado: dataProgramacion.turno || turno || null,
        capacidad_limite: capacidadLimite,
        asientos_ocupados: asientosOcupados,
        asientos_reservados: asientosReservados,
        asientos_por_empleado: asientosPorEmpleado,
        pasajeros_ids: pasajerosIds,
        asientos_disponibles: Math.max(capacidadLimite - asientosOcupados, 0)
      };
    }));

    rutas.sort((a, b) => Number(a.ruta || 0) - Number(b.ruta || 0));

    res.status(200).json({
      success: true,
      fecha,
      turno: turno || null,
      cantidad: rutas.length,
      cantidad_programadas: rutas.filter((ruta) => ruta.programada).length,
      data: rutas
    });
  } catch (error) {
    console.error('Error obteniendo rutas programadas:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo rutas programadas.'
    });
  }
});

// ==========================================
// ENDPOINT 1.1: Obtener ruta asignada del empleado autenticado
// ==========================================
app.get('/api/empleado/mi-ruta', autorizar('asignacion:ver'), async (req, res) => {
  const fechaConsulta = textoNormalizado(req.query.fecha) || new Date().toISOString().slice(0, 10);
  const turnoConsulta = turnoNormalizado(req.query.turno);

  if (req.usuario?.rol !== ROLES.EMPLEADO) {
    return res.status(403).json({
      success: false,
      message: 'Este endpoint solo está disponible para usuarios con rol EMPLEADO.'
    });
  }

  const idEmpleado = textoNormalizado(req.usuario?.id_empleado) || construirIdEmpleadoDesdeUid(req.usuario?.uid);

  try {
    let query = db.collection('programacion_diaria').where('fecha', '==', fechaConsulta);
    if (turnoConsulta) {
      query = query.where('turno', '==', turnoConsulta);
    }

    const programacionesSnapshot = await query.get();
    let programacionEncontrada = null;
    let asientoAsignado = null;

    for (const doc of programacionesSnapshot.docs) {
      const data = doc.data() || {};
      const pasajerosIds = Array.isArray(data.pasajeros_ids) ? data.pasajeros_ids : [];
      const asientosPorEmpleado = normalizarAsientosPorEmpleado(data.asientos_por_empleado);

      const estaAsignado = pasajerosIds.includes(idEmpleado)
        || Object.prototype.hasOwnProperty.call(asientosPorEmpleado, idEmpleado);

      if (!estaAsignado) {
        continue;
      }

      const asientoDirecto = Number(asientosPorEmpleado[idEmpleado]);
      if (Number.isInteger(asientoDirecto) && asientoDirecto > 0) {
        asientoAsignado = asientoDirecto;
      } else {
        const asientosReservados = normalizarAsientosReservados(data.asientos_reservados);
        const indicePasajero = pasajerosIds.findIndex((id) => id === idEmpleado);
        if (indicePasajero >= 0 && Number.isInteger(asientosReservados[indicePasajero])) {
          asientoAsignado = asientosReservados[indicePasajero];
        }
      }

      programacionEncontrada = {
        id: doc.id,
        data
      };
      break;
    }

    if (!programacionEncontrada) {
      return res.status(200).json({
        success: true,
        fecha: fechaConsulta,
        turno: turnoConsulta || null,
        data: null
      });
    }

    const idRuta = textoNormalizado(programacionEncontrada.data.id_ruta);
    if (!idRuta) {
      return res.status(404).json({
        success: false,
        message: 'La asignación encontrada no contiene una ruta válida.'
      });
    }

    const rutaDoc = await db.collection('rutas').doc(idRuta).get();
    if (!rutaDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'No se encontró la ruta asociada a la asignación.'
      });
    }

    const rutaData = rutaDoc.data() || {};
    const capacidadLimite = Number(programacionEncontrada.data.capacidad_limite) || Number(rutaData.capacidad_real) || 0;
    const asientosOcupadosDato = Number(programacionEncontrada.data.asientos_ocupados);
    const pasajerosIds = Array.isArray(programacionEncontrada.data.pasajeros_ids)
      ? programacionEncontrada.data.pasajeros_ids
      : [];
    const asientosReservados = normalizarAsientosReservados(programacionEncontrada.data.asientos_reservados);
    const asientosOcupados = Number.isFinite(asientosOcupadosDato)
      ? asientosOcupadosDato
      : Math.max(pasajerosIds.length, asientosReservados.length);

    return res.status(200).json({
      success: true,
      fecha: fechaConsulta,
      turno: turnoConsulta || textoNormalizado(programacionEncontrada.data.turno) || null,
      data: {
        id: rutaDoc.id,
        ruta: Number(rutaData.ruta) || 0,
        nombre: String(rutaData.nombre || ''),
        zona: String(rutaData.zona || ''),
        nombre_ruta: String(rutaData.zona || rutaData.nombre || `Ruta ${Number(rutaData.ruta) || 0}`),
        'tipo de unidad': String(rutaData['tipo de unidad'] || 'N/D'),
        capacidad_real: Number(rutaData.capacidad_real) || capacidadLimite,
        max_pasajeros_dia: Number(rutaData.max_pasajeros_dia) || 0,
        porcentaje_ocupacion_max: Number(rutaData.porcentaje_ocupacion_max) || 0,
        alerta_ocupacion: String(rutaData.alerta_ocupacion || 'N/D'),
        sugerencia_right_sizing: String(rutaData.sugerencia_right_sizing || 'Sin sugerencia'),
        asiento_asignado: asientoAsignado,
        id_ruta: idRuta,
        id_programacion: programacionEncontrada.id,
        asientos_ocupados: asientosOcupados,
        capacidad_limite: capacidadLimite,
        asientos_disponibles: Math.max(capacidadLimite - asientosOcupados, 0)
      }
    });
  } catch (error) {
    console.error('Error obteniendo la ruta asignada del empleado:', error.message);
    return res.status(500).json({
      success: false,
      message: 'No se pudo obtener la ruta asignada del empleado.'
    });
  }
});

// ==========================================
// ENDPOINT 2: El "Cap Check" (Asignación Atómica)
// Solo Admin y Jefe pueden asignar empleados a rutas
// ==========================================
app.post('/api/asignar', autorizar('asignacion:crear'), async (req, res) => {
  const { id_empleado, id_ruta, fecha, turno, asiento } = req.body;

  const idEmpleado = textoNormalizado(id_empleado);
  const idRutaSolicitada = textoNormalizado(id_ruta);
  const fechaAsignacion = textoNormalizado(fecha);
  const turnoAsignacion = turnoNormalizado(turno);
  const asientoAsignado = Number(asiento);

  if (!idEmpleado || !idRutaSolicitada || !fechaAsignacion) {
    return res.status(400).json({
      success: false,
      message: 'id_empleado, id_ruta y fecha son requeridos.'
    });
  }

  if (!Number.isInteger(asientoAsignado) || asientoAsignado <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Debes enviar un número de asiento válido.'
    });
  }

  try {
    const rutaEncontrada = await resolverRutaPorIdentificador(idRutaSolicitada);
    if (!rutaEncontrada) {
      return res.status(404).json({
        success: false,
        message: 'La ruta seleccionada no existe.'
      });
    }

    // Usamos una TRANSACCIÓN de Firestore para evitar condiciones de carrera (sobrecupo)
    await db.runTransaction(async (t) => {
      const empleadoQuery = db.collection('usuarios')
        .where('id_empleado', '==', idEmpleado)
        .where('rol', '==', ROLES.EMPLEADO)
        .limit(1);

      const empleadoSnapshot = await leerQuery(empleadoQuery, t);
      if (empleadoSnapshot.empty) {
        throw new Error('El empleado seleccionado no existe.');
      }

      const empleadoDoc = empleadoSnapshot.docs[0];
      const empleadoData = empleadoDoc.data() || {};

      if (empleadoData.activo === false) {
        throw new Error('El empleado seleccionado está inactivo.');
      }

      if (req.usuario.rol === ROLES.JEFE && empleadoData.jefe_uid !== req.usuario.uid) {
        throw new Error('FORBIDDEN_EMPLOYEE: No puedes asignar empleados que no están bajo tu responsabilidad.');
      }

      // NUEVA VALIDACIÓN: Evitar que sea asignado a otra ruta o turno el mismo día
      const asignacionesPreviasQuery = db.collection('programacion_diaria')
        .where('fecha', '==', fechaAsignacion)
        .where('pasajeros_ids', 'array-contains', idEmpleado)
        .limit(1);

      const asignacionesPrevias = await leerQuery(asignacionesPreviasQuery, t);
      if (!asignacionesPrevias.empty) {
        throw new Error('DUPLICATE_ASSIGNMENT: El empleado ya tiene una asignación activa en este día. Cancélala primero.');
      }

      const programacion = await resolverProgramacion(fechaAsignacion, rutaEncontrada.id, turnoAsignacion, t);
      let data = programacion.data;
      let programacionRef = programacion.docRef;

      if (!data) {
        data = construirProgramacionBase({
          fecha: fechaAsignacion,
          idRuta: rutaEncontrada.id,
          turno: turnoAsignacion,
          rutaData: rutaEncontrada.data,
          uidCreador: req.usuario.uid
        });
        t.set(programacionRef, data, { merge: true });
      }

      const pasajerosActuales = Array.isArray(data.pasajeros_ids) ? data.pasajeros_ids : [];
      const asientosReservados = normalizarAsientosReservados(data.asientos_reservados);
      const asientosPorEmpleado = normalizarAsientosPorEmpleado(data.asientos_por_empleado);

      const asientosOcupadosDato = Number(data.asientos_ocupados);
      const asientosOcupados = Number.isFinite(asientosOcupadosDato)
        ? asientosOcupadosDato
        : Math.max(pasajerosActuales.length, asientosReservados.length);
      const capacidadMaxima = Number(data.capacidad_limite) || Number(rutaEncontrada.data.capacidad_real) || 12;

      // Regla de Negocio: Bloqueo Dinámico
      if (asientosOcupados >= capacidadMaxima) {
        throw new Error("CAP_CHECK_FAILED: La unidad ya está a su máxima capacidad.");
      }

      if (asientoAsignado > capacidadMaxima) {
        throw new Error('SEAT_OUT_OF_RANGE: El asiento seleccionado excede la capacidad de la unidad.');
      }

      if (asientosReservados.includes(asientoAsignado)) {
        throw new Error('SEAT_OCCUPIED: El asiento seleccionado ya está ocupado.');
      }

      if (pasajerosActuales.includes(idEmpleado)) {
        throw new Error('DUPLICATE_ASSIGNMENT: El empleado ya está asignado a esta ruta.');
      }

      const nuevosPasajeros = [...pasajerosActuales, idEmpleado];
      const nuevosAsientosReservados = [...asientosReservados, asientoAsignado].sort((a, b) => a - b);

      t.set(programacionRef, {
        fecha: fechaAsignacion,
        turno: turnoAsignacion || data.turno || null,
        id_ruta: rutaEncontrada.id,
        asientos_ocupados: asientosOcupados + 1,
        pasajeros_ids: nuevosPasajeros,
        asientos_reservados: nuevosAsientosReservados,
        asientos_por_empleado: {
          ...asientosPorEmpleado,
          [idEmpleado]: asientoAsignado
        },
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }, { merge: true });
    });

    res.status(200).json({
      success: true,
      message: "Empleado asignado exitosamente.",
      data: {
        id_empleado: idEmpleado,
        id_ruta: rutaEncontrada.id,
        fecha: fechaAsignacion,
        turno: turnoAsignacion || null,
        asiento: asientoAsignado
      }
    });

  } catch (error) {
    const mensaje = String(error.message || 'Error en la asignación.');
    const status = mensaje.startsWith('CAP_CHECK_FAILED')
      || mensaje.startsWith('DUPLICATE_ASSIGNMENT')
      || mensaje.startsWith('SEAT_OCCUPIED')
      || mensaje.startsWith('SEAT_OUT_OF_RANGE')
      ? 409
      : mensaje.startsWith('FORBIDDEN_EMPLOYEE')
        ? 403
        : mensaje.includes('no existe')
          ? 404
          : 400;

    res.status(status).json({ success: false, message: mensaje });
  }
});

app.post('/api/asignar/cancelar', autorizar('asignacion:cancelar'), async (req, res) => {
  const { id_empleado, id_ruta, fecha, turno, asiento } = req.body;

  const idEmpleadoBody = textoNormalizado(id_empleado);
  const idEmpleadoPropio = textoNormalizado(req.usuario?.id_empleado) || construirIdEmpleadoDesdeUid(req.usuario?.uid);
  const idEmpleado = req.usuario?.rol === ROLES.EMPLEADO ? idEmpleadoPropio : idEmpleadoBody;
  const idRutaSolicitada = textoNormalizado(id_ruta);
  const fechaAsignacion = textoNormalizado(fecha);
  const turnoAsignacion = turnoNormalizado(turno);
  const asientoSolicitado = Number(asiento);

  if (!idEmpleado || !idRutaSolicitada || !fechaAsignacion) {
    return res.status(400).json({
      success: false,
      message: 'id_empleado, id_ruta y fecha son requeridos.'
    });
  }

  if (req.usuario?.rol === ROLES.EMPLEADO && idEmpleadoBody && idEmpleadoBody !== idEmpleadoPropio) {
    return res.status(403).json({
      success: false,
      message: 'FORBIDDEN_EMPLOYEE: Solo puedes cancelar tu propia asignación.'
    });
  }

  try {
    const rutaEncontrada = await resolverRutaPorIdentificador(idRutaSolicitada);
    if (!rutaEncontrada) {
      return res.status(404).json({
        success: false,
        message: 'La ruta seleccionada no existe.'
      });
    }

    let asientoEliminado = null;

    await db.runTransaction(async (t) => {
      const empleadoQuery = db.collection('usuarios')
        .where('id_empleado', '==', idEmpleado)
        .where('rol', '==', ROLES.EMPLEADO)
        .limit(1);

      const empleadoSnapshot = await leerQuery(empleadoQuery, t);
      if (empleadoSnapshot.empty) {
        throw new Error('El empleado seleccionado no existe.');
      }

      const empleadoDoc = empleadoSnapshot.docs[0];
      const empleadoData = empleadoDoc.data() || {};

      if (req.usuario.rol === ROLES.JEFE && empleadoData.jefe_uid !== req.usuario.uid) {
        throw new Error('FORBIDDEN_EMPLOYEE: No puedes desasignar empleados que no están bajo tu responsabilidad.');
      }

      const programacion = await resolverProgramacion(fechaAsignacion, rutaEncontrada.id, turnoAsignacion, t);
      if (!programacion.data) {
        throw new Error('ASSIGNMENT_NOT_FOUND: No hay programación registrada para esa ruta y fecha.');
      }

      const data = programacion.data;
      const pasajerosActuales = Array.isArray(data.pasajeros_ids) ? data.pasajeros_ids : [];
      const asientosReservados = normalizarAsientosReservados(data.asientos_reservados);
      const asientosPorEmpleado = normalizarAsientosPorEmpleado(data.asientos_por_empleado);

      if (!pasajerosActuales.includes(idEmpleado) && !asientosPorEmpleado[idEmpleado]) {
        throw new Error('ASSIGNMENT_NOT_FOUND: El empleado no tiene asignación activa en esta ruta.');
      }

      const asientoDesdeMapa = Number(asientosPorEmpleado[idEmpleado]);
      const asientoFinal = Number.isInteger(asientoDesdeMapa)
        ? asientoDesdeMapa
        : (Number.isInteger(asientoSolicitado) && asientoSolicitado > 0 ? asientoSolicitado : null);

      const nuevosPasajeros = pasajerosActuales.filter((idActual) => idActual !== idEmpleado);
      const nuevosAsientosReservados = asientoFinal
        ? asientosReservados.filter((asientoActual) => asientoActual !== asientoFinal)
        : asientosReservados;

      const nuevosAsientosPorEmpleado = { ...asientosPorEmpleado };
      delete nuevosAsientosPorEmpleado[idEmpleado];

      const nuevosAsientosOcupados = Math.max(nuevosPasajeros.length, nuevosAsientosReservados.length);

      t.set(programacion.docRef, {
        pasajeros_ids: nuevosPasajeros,
        asientos_reservados: nuevosAsientosReservados,
        asientos_por_empleado: nuevosAsientosPorEmpleado,
        asientos_ocupados: nuevosAsientosOcupados,
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }, { merge: true });

      asientoEliminado = asientoFinal;
    });

    res.status(200).json({
      success: true,
      message: 'Asignación eliminada correctamente.',
      data: {
        id_empleado: idEmpleado,
        id_ruta: rutaEncontrada.id,
        fecha: fechaAsignacion,
        turno: turnoAsignacion || null,
        asiento: asientoEliminado
      }
    });
  } catch (error) {
    const mensaje = String(error.message || 'Error al eliminar asignación.');
    const status = mensaje.startsWith('ASSIGNMENT_NOT_FOUND')
      ? 404
      : mensaje.startsWith('FORBIDDEN_EMPLOYEE')
        ? 403
        : mensaje.includes('no existe')
          ? 404
          : 400;

    res.status(status).json({ success: false, message: mensaje });
  }
});

// ==========================================
// ENDPOINT 3: Sincronizar datos desde Python
// Solo Admin puede sincronizar datos
// ==========================================
app.post('/api/rutas/sync', autorizar('rutas:sync'), async (req, res) => {
  const rutasData = req.body; // Esperamos recibir un arreglo de rutas desde Python

  if (!Array.isArray(rutasData)) {
    return res.status(400).json({
      success: false,
      message: 'El payload debe ser un arreglo de rutas.'
    });
  }

  try {
    const batch = db.batch(); // Usamos batch para escribir todo de una sola vez

    rutasData.forEach(ruta => {
      // Usamos el número de ruta para crear un ID único (ej. "Ruta_1")
      const docId = `Ruta_${ruta.ruta.toString().trim()}`;
      const docRef = db.collection('rutas').doc(docId);

      // .set() con { merge: true } actualiza si ya existe, o lo crea si es nuevo
      batch.set(docRef, ruta, { merge: true });
    });

    await batch.commit();
    console.log(`📥 Sincronización exitosa: ${rutasData.length} rutas actualizadas.`);
    res.status(200).json({ success: true, message: "Datos sincronizados con Firebase" });

  } catch (error) {
    console.error("Error sincronizando rutas:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// ENDPOINT 4: Chat Operativo (Copiloto)
// Solo Admin y Jefe pueden usar el copiloto
// ==========================================
app.get('/api/chat/status', autorizar('chat:enviar'), async (_req, res) => {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();

  return res.status(200).json({
    success: true,
    chat_openai_configurado: Boolean(apiKey),
    chat_openai_cliente_activo: Boolean(openai),
    chat_modo: openai ? 'openai' : 'fallback'
  });
});

app.post('/api/chat', autorizar('chat:enviar'), async (req, res) => {
  const { mensaje_usuario, fecha, turno } = req.body || {};
  let rutas = [];

  if (!mensaje_usuario || !String(mensaje_usuario).trim()) {
    return res.status(400).json({
      success: false,
      message: 'Debes enviar un mensaje en el campo mensaje_usuario.'
    });
  }

  try {
    const snapshot = await db.collection('rutas').get();
    snapshot.forEach((doc) => rutas.push({ id: doc.id, ...doc.data() }));

    const fechaContexto = textoNormalizado(fecha) || fechaISOHoy();
    const turnoContexto = turnoNormalizado(turno);

    const contextAI = await construirContextoIAConMemoria(rutas, SEMANAS_MEMORIA_DEFECTO);
    const resumenOperativo = construirResumenOperativoChat(rutas);
    const contextoEmpleados = await obtenerContextoEmpleadosChat(req.usuario, 25);
    const planesRecientes = await obtenerPlanesIARecientesChat(8);
    const resumenProgramacion = await obtenerResumenProgramacionChat({
      fecha: fechaContexto,
      turno: turnoContexto,
      limite: 12
    });

    const contextoChat = {
      usuario: {
        uid: req.usuario?.uid || null,
        rol: req.usuario?.rol || null,
        nombre: req.usuario?.nombre || null
      },
      consulta_usuario: textoNormalizado(mensaje_usuario),
      contexto_operativo: resumenOperativo,
      contexto_programacion: resumenProgramacion,
      contexto_empleados: contextoEmpleados,
      aprendizaje_previo: contextAI.aprendizaje_previo,
      planes_ia_recientes: planesRecientes
    };

    if (!openai) {
      return res.status(200).json({
        success: true,
        respuesta: generarRespuestaFallback(mensaje_usuario, rutas)
      });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Eres un copiloto logistico de ILPEA entrenado con datos operativos reales del sistema. Responde en espanol con recomendaciones breves, accionables y orientadas a operacion. Adapta el nivel de detalle segun el rol del usuario (ADMIN o JEFE). Si la pregunta requiere datos no disponibles, dilo explicitamente y propone como validarlo. Nunca inventes cifras; usa un rango o N/D cuando falten datos.'
        },
        {
          role: 'user',
          content: `Consulta: ${mensaje_usuario}\n\nContexto operativo entrenado: ${JSON.stringify(contextoChat)}`
        }
      ],
      temperature: 0.2,
      max_tokens: 500
    });

    const respuestaIA = completion.choices?.[0]?.message?.content?.trim();

    if (!respuestaIA) {
      return res.status(200).json({
        success: true,
        respuesta: generarRespuestaFallback(mensaje_usuario, rutas)
      });
    }

    res.status(200).json({ success: true, respuesta: respuestaIA });
  } catch (error) {
    console.error('Error en /api/chat:', error);

    if (esTimeoutOpenAI(error)) {
      return res.status(200).json({
        success: true,
        respuesta: generarRespuestaFallback(mensaje_usuario, rutas)
      });
    }

    res.status(500).json({
      success: false,
      message: 'No fue posible generar respuesta del copiloto.'
    });
  }
});

// ==========================================
// ENDPOINT 5: Insights Automáticos (Proactivo)
// Solo Admin y Jefe pueden ver insights
// ==========================================
app.get('/api/insights-automaticos', autorizar('insights:ver'), async (req, res) => {
  let rutas = [];

  try {
    // 1. Extraemos TODAS las rutas de Firebase
    const snapshot = await db.collection('rutas').get();
    snapshot.forEach((doc) => rutas.push({ id: doc.id, ...doc.data() }));

    // 🔥 OPTIMIZACIÓN CRÍTICA: Reducimos drásticamente el tamaño del JSON enviado a OpenAI.
    // Enviando solo lo esencial, evitamos saturar los tokens y provocamos que la IA responda en < 2s.
    const rutasOptimizadas = rutas.map(r => ({
      ruta_id: r.id,
      nombre: r.zona || r.nombre || `Ruta ${r.ruta}`,
      ocupacion_pct: r.porcentaje_ocupacion_max,
      pasajeros: r.max_pasajeros_dia,
      unidad: r['tipo de unidad'] || r.tipo_unidad
    }));

    const contextAI = await construirContextoIAConMemoria(rutasOptimizadas, SEMANAS_MEMORIA_DEFECTO);

    if (!openai) {
      return res.status(200).json({
        success: true,
        insights: sanitizarListaInsights(generarInsightsLocales(rutas)),
        contexto_memoria: contextAI.aprendizaje_previo,
        source: 'fallback'
      });
    }

    // 2. El Prompt Maestro
    const systemPrompt = `
      Actua como un Analista Senior de Logistica e IA para ILPEA. Genera "Insights de Accion" basados en metricas actuales y aprendizaje historico.
      
      REGLAS:
      1. Prioridad ALTA: Rutas con ocupación < 40%.
      2. Prioridad MEDIA: Autobuses con <= 12 pasajeros (Sugerir Van).
      3. Considera contexto de las ultimas 4 semanas y decisiones recientes del administrador.
      
      SALIDA ESTRICTA: Devuelve UNICAMENTE un objeto JSON con propiedad "insights".
      Cada insight debe incluir: "recomendacion_id", "titulo", "descripcion", "prioridad" (alta/media/baja), "ruta_id", "prob_cancelacion" (0 a 1 o null), "ruta_alternativa_sugerida" (string o null).
      No incluyas texto extra fuera del JSON.
    `;

    // 3. Consulta a OpenAI enviando el prompt y los datos de Firebase
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: 'user', content: `Analiza estos datos y genera el JSON: ${JSON.stringify(contextAI)}` }
      ],
      temperature: 0.2
    }, {
      timeout: 8500, // 👈 Timeout estricto de 8.5s para evitar que Vercel/Frontend lance Error 504
      maxRetries: 0  // 👈 Sin reintentos para no retrasar la respuesta al usuario
    });

    // 4. Se lo enviamos procesado al Frontend
    const rawContent = completion.choices?.[0]?.message?.content;
    let dataIA = null;

    try {
      dataIA = rawContent ? JSON.parse(rawContent) : null;
    } catch (error) {
      console.warn('La IA devolvio un JSON invalido en insights. Se usa fallback local.');
    }

    const insights = sanitizarListaInsights(Array.isArray(dataIA?.insights) ? dataIA.insights : []);

    if (!insights.length) {
      return res.status(200).json({
        success: true,
        insights: sanitizarListaInsights(generarInsightsLocales(rutas)),
        contexto_memoria: contextAI.aprendizaje_previo,
        source: 'fallback'
      });
    }

    res.json({
      success: true,
      insights,
      contexto_memoria: contextAI.aprendizaje_previo,
      source: 'openai'
    });

  } catch (error) {
    if (esTimeoutOpenAI(error)) {
      console.warn('OpenAI tardó demasiado; usando insights locales.');
      return res.status(200).json({
        success: true,
        insights: sanitizarListaInsights(generarInsightsLocales(rutas)),
        source: 'fallback'
      });
    }

    console.error("Error generando insights:", error);
    return res.status(200).json({
      success: true,
      insights: sanitizarListaInsights(generarInsightsLocales(rutas)),
      source: 'fallback'
    });
  }
});

// ==========================================
// ENDPOINT 5A: Feedback de recomendaciones IA
// Solo Admin registra decision final
// ==========================================
app.post('/api/ai/feedback', autorizar('insights:ver'), async (req, res) => {
  if (req.usuario.rol !== ROLES.ADMIN) {
    return res.status(403).json({
      success: false,
      message: 'Solo un ADMIN puede registrar feedback oficial de recomendaciones IA.'
    });
  }

  const {
    recomendacion_id,
    ruta_id,
    decision,
    razon,
    prob_cancelacion,
    ruta_alternativa_sugerida,
    metadata
  } = req.body || {};

  const rutaId = textoNormalizado(ruta_id);
  const decisionNormalizada = normalizarDecisionIA(decision);
  const probCancelacion = Number(prob_cancelacion);

  if (!rutaId) {
    return res.status(400).json({
      success: false,
      message: 'ruta_id es obligatorio para registrar feedback.'
    });
  }

  if (!decisionNormalizada || !DECISIONES_IA_VALIDAS.includes(decisionNormalizada)) {
    return res.status(400).json({
      success: false,
      message: `decision invalida. Valores permitidos: ${DECISIONES_IA_VALIDAS.join(', ')}`
    });
  }

  try {
    const creadoEn = new Date();
    const semanaKey = obtenerSemanaKey(creadoEn);
    const feedbackRef = db.collection(COLECCION_FEEDBACK_IA).doc();
    const tipoEjemplo = obtenerTipoEjemploPorDecision(decisionNormalizada);

    const entradaMemoria = {
      feedback_id: feedbackRef.id,
      recomendacion_id: textoNormalizado(recomendacion_id) || null,
      ruta_id: rutaId,
      decision: decisionNormalizada,
      tipo_ejemplo: tipoEjemplo,
      es_negative_example: tipoEjemplo === 'NEGATIVE',
      razon: textoNormalizado(razon) || null,
      prob_cancelacion: Number.isFinite(probCancelacion) ? Number(probCancelacion.toFixed(2)) : null,
      ruta_alternativa_sugerida: textoNormalizado(ruta_alternativa_sugerida) || null,
      creado_por: req.usuario.uid,
      creado_en: creadoEn
    };

    const feedback = {
      ...entradaMemoria,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      creado_por: req.usuario.uid,
      creado_por_rol: req.usuario.rol,
      creado_en: creadoEn,
      semana_key: semanaKey
    };

    await feedbackRef.set(feedback);

    await db.collection(COLECCION_HISTORICO_RECOMENDACIONES).doc(semanaKey).set({
      semana_key: semanaKey,
      semana_inicio: obtenerInicioSemana(creadoEn),
      ...construirIncrementosDecisionSemanal(decisionNormalizada),
      recomendaciones: admin.firestore.FieldValue.arrayUnion(entradaMemoria),
      feedback_admin: admin.firestore.FieldValue.arrayUnion(entradaMemoria),
      ...(tipoEjemplo === 'NEGATIVE'
        ? { ejemplos_negativos: admin.firestore.FieldValue.arrayUnion(entradaMemoria) }
        : {}),
      ...(tipoEjemplo === 'POSITIVE'
        ? { ejemplos_positivos: admin.firestore.FieldValue.arrayUnion(entradaMemoria) }
        : {}),
      actualizado_en: creadoEn,
      actualizado_por: req.usuario.uid
    }, { merge: true });

    res.status(201).json({
      success: true,
      message: 'Feedback IA registrado correctamente.',
      feedback: {
        id: feedbackRef.id,
        ...feedback
      }
    });
  } catch (error) {
    console.error('Error registrando feedback IA:', error.message);
    res.status(500).json({
      success: false,
      message: 'No fue posible registrar el feedback IA.'
    });
  }
});

// ==========================================
// ENDPOINT 5B: Ejecutar plan IA (transaccional)
// Solo Admin puede ejecutar el plan
// ==========================================
app.post('/api/ai/ejecutar-plan', autorizar('asignacion:crear'), async (req, res) => {
  if (req.usuario.rol !== ROLES.ADMIN) {
    return res.status(403).json({
      success: false,
      message: 'Solo un ADMIN puede ejecutar planes masivos de IA.'
    });
  }

  const {
    ruta_origen_id,
    ruta_destino_id,
    fecha,
    turno,
    empleados_ids,
    recomendacion_id,
    motivo
  } = req.body || {};

  const rutaOrigenSolicitada = textoNormalizado(ruta_origen_id);
  const rutaDestinoSolicitada = textoNormalizado(ruta_destino_id);
  const fechaPlan = textoNormalizado(fecha);
  const turnoPlan = turnoNormalizado(turno);

  if (!rutaOrigenSolicitada || !rutaDestinoSolicitada || !fechaPlan) {
    return res.status(400).json({
      success: false,
      message: 'ruta_origen_id, ruta_destino_id y fecha son requeridos.'
    });
  }

  if (rutaOrigenSolicitada === rutaDestinoSolicitada) {
    return res.status(400).json({
      success: false,
      message: 'La ruta de origen y destino deben ser diferentes.'
    });
  }

  const empleadosSolicitados = Array.isArray(empleados_ids)
    ? [...new Set(empleados_ids.map((id) => textoNormalizado(id)).filter(Boolean))]
    : null;

  let resultado = null;

  try {
    const rutaOrigen = await resolverRutaPorIdentificador(rutaOrigenSolicitada);
    if (!rutaOrigen) {
      return res.status(404).json({
        success: false,
        message: 'La ruta de origen no existe.'
      });
    }

    const rutaDestino = await resolverRutaPorIdentificador(rutaDestinoSolicitada);
    if (!rutaDestino) {
      return res.status(404).json({
        success: false,
        message: 'La ruta de destino no existe.'
      });
    }

    const planRef = db.collection(COLECCION_PLANES_IA).doc();
    const feedbackRef = db.collection(COLECCION_FEEDBACK_IA).doc();

    await db.runTransaction(async (t) => {
      const programacionOrigen = await resolverProgramacion(fechaPlan, rutaOrigen.id, turnoPlan, t);
      if (!programacionOrigen.data) {
        throw new Error('SOURCE_ASSIGNMENT_NOT_FOUND: No existe programacion para la ruta origen en esa fecha/turno.');
      }

      const dataOrigen = programacionOrigen.data || {};
      const pasajerosOrigen = [...new Set(
        (Array.isArray(dataOrigen.pasajeros_ids) ? dataOrigen.pasajeros_ids : [])
          .map((id) => textoNormalizado(id))
          .filter(Boolean)
      )];

      if (!pasajerosOrigen.length) {
        throw new Error('EMPTY_SOURCE_ROUTE: La ruta origen no tiene empleados asignados para mover.');
      }

      const asientosOrigen = normalizarAsientosReservados(dataOrigen.asientos_reservados);
      const asientosPorEmpleadoOrigen = normalizarAsientosPorEmpleado(dataOrigen.asientos_por_empleado);

      const empleadosMover = empleadosSolicitados && empleadosSolicitados.length
        ? empleadosSolicitados
        : [...pasajerosOrigen];

      if (!empleadosMover.length) {
        throw new Error('EMPTY_MOVE_SET: No se recibieron empleados para mover.');
      }

      const empleadosNoEncontrados = empleadosMover.filter((idEmpleado) => !pasajerosOrigen.includes(idEmpleado));
      if (empleadosNoEncontrados.length) {
        throw new Error(`EMPLOYEE_NOT_IN_SOURCE: No estan asignados en ruta origen: ${empleadosNoEncontrados.join(', ')}`);
      }

      const programacionDestino = await resolverProgramacion(fechaPlan, rutaDestino.id, turnoPlan, t);
      let dataDestino = programacionDestino.data;

      if (!dataDestino) {
        dataDestino = construirProgramacionBase({
          fecha: fechaPlan,
          idRuta: rutaDestino.id,
          turno: turnoPlan,
          rutaData: rutaDestino.data,
          uidCreador: req.usuario.uid
        });

        t.set(programacionDestino.docRef, dataDestino, { merge: true });
      }

      const pasajerosDestino = [...new Set(
        (Array.isArray(dataDestino.pasajeros_ids) ? dataDestino.pasajeros_ids : [])
          .map((id) => textoNormalizado(id))
          .filter(Boolean)
      )];
      const asientosDestino = normalizarAsientosReservados(dataDestino.asientos_reservados);
      const asientosPorEmpleadoDestino = normalizarAsientosPorEmpleado(dataDestino.asientos_por_empleado);

      const duplicadosDestino = empleadosMover.filter((idEmpleado) => pasajerosDestino.includes(idEmpleado));
      if (duplicadosDestino.length) {
        throw new Error(`DUPLICATE_TARGET_ASSIGNMENT: Ya asignados en destino: ${duplicadosDestino.join(', ')}`);
      }

      const capacidadDestino = Number(dataDestino.capacidad_limite) || Number(rutaDestino.data.capacidad_real) || 12;
      const ocupacionDestinoActual = Math.max(pasajerosDestino.length, asientosDestino.length);
      if (ocupacionDestinoActual + empleadosMover.length > capacidadDestino) {
        throw new Error('TARGET_CAPACITY_EXCEEDED: La ruta destino no tiene capacidad para el plan completo.');
      }

      const asientosDestinoSet = asientosOcupadosComoSet(asientosDestino, asientosPorEmpleadoDestino);

      const pasajerosOrigenFinal = pasajerosOrigen.filter((idEmpleado) => !empleadosMover.includes(idEmpleado));
      const mapaOrigenFinal = { ...asientosPorEmpleadoOrigen };
      const asientosRemoverOrigen = new Set();

      const pasajerosDestinoFinal = [...pasajerosDestino];
      const asientosDestinoFinal = [...asientosDestino];
      const mapaDestinoFinal = { ...asientosPorEmpleadoDestino };
      const detalleReasignacion = [];

      empleadosMover.forEach((idEmpleado) => {
        const asientoOrigen = Number(mapaOrigenFinal[idEmpleado]);
        if (Number.isInteger(asientoOrigen) && asientoOrigen > 0) {
          asientosRemoverOrigen.add(asientoOrigen);
        }
        delete mapaOrigenFinal[idEmpleado];

        let asientoDestinoAsignado = null;
        if (
          Number.isInteger(asientoOrigen)
          && asientoOrigen > 0
          && asientoOrigen <= capacidadDestino
          && !asientosDestinoSet.has(asientoOrigen)
        ) {
          asientoDestinoAsignado = asientoOrigen;
        } else {
          asientoDestinoAsignado = siguienteAsientoDisponible(asientosDestinoSet, capacidadDestino);
        }

        asientosDestinoSet.add(asientoDestinoAsignado);
        pasajerosDestinoFinal.push(idEmpleado);
        asientosDestinoFinal.push(asientoDestinoAsignado);
        mapaDestinoFinal[idEmpleado] = asientoDestinoAsignado;

        detalleReasignacion.push({
          id_empleado: idEmpleado,
          asiento_origen: Number.isInteger(asientoOrigen) ? asientoOrigen : null,
          asiento_destino: asientoDestinoAsignado
        });
      });

      const asientosOrigenFinal = asientosOrigen.filter((asiento) => !asientosRemoverOrigen.has(asiento));

      t.set(programacionOrigen.docRef, {
        pasajeros_ids: pasajerosOrigenFinal,
        asientos_reservados: asientosOrigenFinal,
        asientos_por_empleado: mapaOrigenFinal,
        asientos_ocupados: Math.max(pasajerosOrigenFinal.length, asientosOrigenFinal.length),
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }, { merge: true });

      t.set(programacionDestino.docRef, {
        fecha: fechaPlan,
        turno: turnoPlan || dataDestino.turno || null,
        id_ruta: rutaDestino.id,
        pasajeros_ids: pasajerosDestinoFinal,
        asientos_reservados: normalizarAsientosReservados(asientosDestinoFinal),
        asientos_por_empleado: mapaDestinoFinal,
        asientos_ocupados: Math.max(pasajerosDestinoFinal.length, asientosDestinoFinal.length),
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }, { merge: true });

      const creadoEn = new Date();
      const semanaKey = obtenerSemanaKey(creadoEn);
      const planPayload = {
        recomendacion_id: textoNormalizado(recomendacion_id) || null,
        fecha: fechaPlan,
        turno: turnoPlan || null,
        ruta_origen_id: rutaOrigen.id,
        ruta_destino_id: rutaDestino.id,
        empleados_movidos: empleadosMover,
        cantidad_empleados_movidos: empleadosMover.length,
        motivo: textoNormalizado(motivo) || 'Plan ejecutado por recomendacion IA.',
        detalle_reasignacion: detalleReasignacion,
        ejecutado_por: req.usuario.uid,
        ejecutado_por_rol: req.usuario.rol,
        ejecutado_en: creadoEn,
        semana_key: semanaKey
      };

      t.set(planRef, planPayload);

      const feedbackPayload = {
        recomendacion_id: textoNormalizado(recomendacion_id) || null,
        ruta_id: rutaOrigen.id,
        decision: 'ACEPTADA',
        tipo_ejemplo: 'POSITIVE',
        es_negative_example: false,
        razon: textoNormalizado(motivo) || 'Plan ejecutado por Admin.',
        ruta_alternativa_sugerida: rutaDestino.id,
        metadata: {
          origen: 'api/ai/ejecutar-plan',
          plan_id: planRef.id,
          empleados_movidos: empleadosMover.length,
          fecha: fechaPlan,
          turno: turnoPlan || null
        },
        creado_por: req.usuario.uid,
        creado_por_rol: req.usuario.rol,
        creado_en: creadoEn,
        semana_key: semanaKey
      };

      t.set(feedbackRef, feedbackPayload);

      const entradaMemoria = {
        feedback_id: feedbackRef.id,
        recomendacion_id: textoNormalizado(recomendacion_id) || null,
        ruta_id: rutaOrigen.id,
        decision: 'ACEPTADA',
        tipo_ejemplo: 'POSITIVE',
        es_negative_example: false,
        ruta_alternativa_sugerida: rutaDestino.id,
        razon: textoNormalizado(motivo) || 'Plan ejecutado por Admin.',
        creado_por: req.usuario.uid,
        creado_en: creadoEn
      };

      t.set(db.collection(COLECCION_HISTORICO_RECOMENDACIONES).doc(semanaKey), {
        semana_key: semanaKey,
        semana_inicio: obtenerInicioSemana(creadoEn),
        ...construirIncrementosDecisionSemanal('ACEPTADA'),
        recomendaciones: admin.firestore.FieldValue.arrayUnion(entradaMemoria),
        feedback_admin: admin.firestore.FieldValue.arrayUnion(entradaMemoria),
        ejemplos_positivos: admin.firestore.FieldValue.arrayUnion(entradaMemoria),
        actualizado_en: creadoEn,
        actualizado_por: req.usuario.uid
      }, { merge: true });

      resultado = {
        plan_id: planRef.id,
        feedback_id: feedbackRef.id,
        ruta_origen_id: rutaOrigen.id,
        ruta_destino_id: rutaDestino.id,
        fecha: fechaPlan,
        turno: turnoPlan || null,
        cantidad_empleados_movidos: empleadosMover.length,
        detalle_reasignacion: detalleReasignacion
      };
    });

    res.status(200).json({
      success: true,
      message: 'Plan IA ejecutado correctamente de forma atomica.',
      data: resultado
    });
  } catch (error) {
    const mensaje = String(error?.message || 'No fue posible ejecutar el plan IA.');
    const status = mensaje.startsWith('SOURCE_ASSIGNMENT_NOT_FOUND')
      || mensaje.startsWith('EMPLOYEE_NOT_IN_SOURCE')
      ? 404
      : mensaje.startsWith('TARGET_CAPACITY_EXCEEDED')
        || mensaje.startsWith('DUPLICATE_TARGET_ASSIGNMENT')
        || mensaje.startsWith('EMPTY_SOURCE_ROUTE')
        || mensaje.startsWith('EMPTY_MOVE_SET')
        ? 409
        : 400;

    console.error('Error ejecutando plan IA:', mensaje);
    res.status(status).json({
      success: false,
      message: mensaje
    });
  }
});

// ==========================================
// ENDPOINT 5C: Auditoria de planes IA ejecutados
// Admin y Jefe pueden consultar historico
// ==========================================
app.get('/api/ai/planes-ejecutados', autorizar('insights:ver'), async (req, res) => {
  const fechaDesde = textoNormalizado(req.query.fecha_desde);
  const fechaHasta = textoNormalizado(req.query.fecha_hasta);
  const estadoImpacto = textoNormalizado(req.query.estado_impacto).toLowerCase();
  const limiteSolicitado = Number(req.query.limit);
  const limit = Number.isInteger(limiteSolicitado)
    ? Math.min(Math.max(limiteSolicitado, 1), 200)
    : 50;

  if (fechaDesde && !/^\d{4}-\d{2}-\d{2}$/.test(fechaDesde)) {
    return res.status(400).json({
      success: false,
      message: 'fecha_desde debe tener formato YYYY-MM-DD.'
    });
  }

  if (fechaHasta && !/^\d{4}-\d{2}-\d{2}$/.test(fechaHasta)) {
    return res.status(400).json({
      success: false,
      message: 'fecha_hasta debe tener formato YYYY-MM-DD.'
    });
  }

  if (fechaDesde && fechaHasta && fechaDesde > fechaHasta) {
    return res.status(400).json({
      success: false,
      message: 'fecha_desde no puede ser mayor que fecha_hasta.'
    });
  }

  if (estadoImpacto && !['alto', 'medio', 'bajo'].includes(estadoImpacto)) {
    return res.status(400).json({
      success: false,
      message: 'estado_impacto invalido. Valores permitidos: alto, medio, bajo.'
    });
  }

  try {
    let query = db.collection(COLECCION_PLANES_IA);

    if (fechaDesde) {
      query = query.where('fecha', '>=', fechaDesde);
    }

    if (fechaHasta) {
      query = query.where('fecha', '<=', fechaHasta);
    }

    query = query.orderBy('fecha', 'desc').limit(limit);

    const snapshot = await query.get();

    const planes = snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      const cantidadEmpleadosMovidos = Number(data.cantidad_empleados_movidos)
        || (Array.isArray(data.empleados_movidos) ? data.empleados_movidos.length : 0);

      return {
        id: doc.id,
        recomendacion_id: textoNormalizado(data.recomendacion_id) || null,
        fecha: textoNormalizado(data.fecha) || null,
        turno: textoNormalizado(data.turno) || null,
        ruta_origen_id: textoNormalizado(data.ruta_origen_id) || null,
        ruta_destino_id: textoNormalizado(data.ruta_destino_id) || null,
        cantidad_empleados_movidos: cantidadEmpleadosMovidos,
        estado_impacto: calcularEstadoImpactoPlan(cantidadEmpleadosMovidos),
        motivo: textoNormalizado(data.motivo) || null,
        detalle_reasignacion: Array.isArray(data.detalle_reasignacion) ? data.detalle_reasignacion : [],
        ejecutado_por: textoNormalizado(data.ejecutado_por) || null,
        ejecutado_por_rol: textoNormalizado(data.ejecutado_por_rol) || null,
        ejecutado_en: serializarFechaFirestore(data.ejecutado_en),
        semana_key: textoNormalizado(data.semana_key) || null
      };
    });

    const planesFiltrados = estadoImpacto
      ? planes.filter((plan) => plan.estado_impacto === estadoImpacto)
      : planes;

    const resumen = {
      total_planes: planesFiltrados.length,
      total_empleados_movidos: planesFiltrados.reduce(
        (acumulado, plan) => acumulado + Number(plan.cantidad_empleados_movidos || 0),
        0
      ),
      impacto_alto: planesFiltrados.filter((plan) => plan.estado_impacto === 'alto').length,
      impacto_medio: planesFiltrados.filter((plan) => plan.estado_impacto === 'medio').length,
      impacto_bajo: planesFiltrados.filter((plan) => plan.estado_impacto === 'bajo').length
    };

    res.status(200).json({
      success: true,
      filtros_aplicados: {
        fecha_desde: fechaDesde || null,
        fecha_hasta: fechaHasta || null,
        estado_impacto: estadoImpacto || null,
        limit
      },
      resumen,
      data: planesFiltrados
    });
  } catch (error) {
    console.error('Error consultando planes IA ejecutados:', error.message);
    res.status(500).json({
      success: false,
      message: 'No fue posible consultar el historico de planes IA ejecutados.'
    });
  }
});

// ==========================================
// ENDPOINT 6: Obtener info del usuario autenticado
// ==========================================
app.get('/api/auth/me', (req, res) => {
  if (!req.usuario) {
    return res.status(401).json({
      success: false,
      message: 'No autenticado'
    });
  }

  res.json({
    success: true,
    usuario: {
      uid: req.usuario.uid,
      email: req.usuario.email,
      nombre: req.usuario.nombre,
      rol: req.usuario.rol,
      permisos: obtenerPermisosDelRol(req.usuario.rol)
    }
  });
});

// ==========================================
// ENDPOINT 7: Crear usuario (Solo Admin)
// ==========================================
app.post('/api/usuarios/crear', autorizar('usuarios:crear'), async (req, res) => {
  const { email, nombre, rol = ROLES.EMPLEADO, password } = req.body;

  if (!email || !nombre || !rol || !password) {
    return res.status(400).json({
      success: false,
      message: 'Email, nombre, rol y password son requeridos.'
    });
  }

  // Validar que el rol sea válido
  if (!Object.values(ROLES).includes(rol)) {
    return res.status(400).json({
      success: false,
      message: `Rol inválido. Roles permitidos: ${Object.values(ROLES).join(', ')}`
    });
  }

  try {
    // Crear usuario en Firebase Auth
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: nombre
    });

    // Guardar datos adicionales en Firestore
    await db.collection('usuarios').doc(userRecord.uid).set({
      email,
      nombre,
      rol,
      creado_por: req.usuario.uid,
      creado_en: new Date(),
      activo: true
    });

    res.status(201).json({
      success: true,
      message: 'Usuario creado exitosamente.',
      usuario: {
        uid: userRecord.uid,
        email,
        nombre,
        rol
      }
    });
  } catch (error) {
    console.error('Error creando usuario:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// ENDPOINT 8: Listar usuarios (Solo Admin)
// ==========================================
app.get('/api/usuarios', autorizar('usuarios:ver'), async (req, res) => {
  try {
    const usuariosSnapshot = await db.collection('usuarios').get();
    const usuarios = [];

    usuariosSnapshot.forEach(doc => {
      const data = doc.data();
      usuarios.push({
        uid: doc.id,
        email: data.email,
        nombre: data.nombre,
        rol: data.rol,
        activo: data.activo,
        creado_en: data.creado_en
      });
    });

    res.json({
      success: true,
      cantidad: usuarios.length,
      data: usuarios
    });
  } catch (error) {
    console.error('Error listando usuarios:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo usuarios'
    });
  }
});

// ==========================================
// ENDPOINT 8B: CRUD de empleados (Admin y Jefe)
// ==========================================
app.get('/api/empleados', autorizar('empleados:ver'), async (req, res) => {
  try {
    const empleadosSnapshot = req.usuario.rol === ROLES.JEFE
      ? await db.collection('usuarios').where('jefe_uid', '==', req.usuario.uid).get()
      : await db.collection('usuarios').where('rol', '==', ROLES.EMPLEADO).get();

    const empleados = [];
    const idsReservados = new Set();

    for (const doc of empleadosSnapshot.docs) {
      const empleado = normalizarEmpleado(doc);
      if (empleado.rol === ROLES.EMPLEADO) {
        if (!String(empleado.id_empleado || '').trim()) {
          try {
            empleado.id_empleado = await asegurarIdEmpleadoPersistido(doc, idsReservados);
          } catch (error) {
            console.warn('No se pudo persistir id_empleado faltante para', doc.id, error.message);
            empleado.id_empleado = construirIdEmpleadoDesdeUid(doc.id);
          }
        } else {
          idsReservados.add(String(empleado.id_empleado).trim());
        }

        empleados.push(empleado);
      }
    }

    res.json({
      success: true,
      cantidad: empleados.length,
      data: empleados
    });
  } catch (error) {
    console.error('Error listando empleados:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo empleados'
    });
  }
});

app.post('/api/empleados', autorizar('empleados:crear'), async (req, res) => {
  const { id_empleado, email, nombre, password, jefe_uid } = req.body;

  if (!email || !nombre) {
    return res.status(400).json({
      success: false,
      message: 'Email y nombre son requeridos.'
    });
  }

  if (!esEmailValido(email)) {
    return res.status(400).json({
      success: false,
      message: 'El email no tiene un formato válido.'
    });
  }

  let jefeResponsable = req.usuario.rol === ROLES.JEFE ? req.usuario.uid : jefe_uid;

  if (!jefeResponsable) {
    return res.status(400).json({
      success: false,
      message: 'Debes asignar un jefe responsable para este empleado.'
    });
  }

  let userRecord;
  try {
    const idEmpleadoManual = String(id_empleado || '').trim();
    const passwordManual = String(password || '').trim();
    const idEmpleadoFinal = idEmpleadoManual || await generarIdEmpleadoUnico();
    const passwordFinal = passwordManual || generarPasswordTemporal();

    const jefeDoc = await db.collection('usuarios').doc(jefeResponsable).get();
    if (!jefeDoc.exists || jefeDoc.data().rol !== ROLES.JEFE) {
      return res.status(400).json({
        success: false,
        message: 'El jefe asignado no existe o no tiene rol JEFE.'
      });
    }

    userRecord = await admin.auth().createUser({
      email: String(email).trim(),
      password: passwordFinal,
      displayName: String(nombre).trim()
    });

    await db.collection('usuarios').doc(userRecord.uid).set({
      id_empleado: idEmpleadoFinal,
      email: String(email).trim(),
      nombre: String(nombre).trim(),
      rol: ROLES.EMPLEADO,
      jefe_uid: jefeResponsable,
      creado_por: req.usuario.uid,
      creado_en: new Date(),
      actualizado_en: null,
      activo: true
    });

    const notificacionCorreo = await enviarCorreoAltaEmpleado({
      nombre: String(nombre).trim(),
      email: String(email).trim(),
      idEmpleado: idEmpleadoFinal,
      password: passwordFinal
    });

    res.status(201).json({
      success: true,
      message: notificacionCorreo.enviado
        ? 'Empleado creado exitosamente y correo enviado.'
        : 'Empleado creado exitosamente. No se pudo enviar el correo de credenciales.',
      credenciales_generadas: {
        id_empleado: idEmpleadoFinal,
        password_temporal: passwordManual ? null : passwordFinal
      },
      notificacion_email: notificacionCorreo,
      usuario: {
        uid: userRecord.uid,
        id_empleado: idEmpleadoFinal,
        email: String(email).trim(),
        nombre: String(nombre).trim(),
        rol: ROLES.EMPLEADO,
        jefe_uid: jefeResponsable
      }
    });
  } catch (error) {
    console.error('Error creando empleado:', error.message);

    // Rollback si se creó en Auth pero falló en Firestore
    if (userRecord && userRecord.uid) {
      await admin.auth().deleteUser(userRecord.uid).catch(err =>
        console.error('Error al hacer rollback de Auth:', err.message)
      );
    }

    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({
        success: false,
        message: 'Ya existe un usuario con ese email.'
      });
    }

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

app.put('/api/empleados/:uid', autorizar('empleados:actualizar'), async (req, res) => {
  const { uid } = req.params;
  const { id_empleado, email, nombre, password, activo, jefe_uid } = req.body;

  try {
    const ref = db.collection('usuarios').doc(uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'Empleado no encontrado.'
      });
    }

    const data = snapshot.data();
    if (data.rol !== ROLES.EMPLEADO) {
      return res.status(403).json({
        success: false,
        message: 'Solo se pueden editar usuarios con rol EMPLEADO.'
      });
    }

    if (!puedeGestionarEmpleado(req.usuario, data)) {
      return res.status(403).json({
        success: false,
        message: 'No puedes modificar empleados que no te pertenecen.'
      });
    }

    const updatesFirestore = {
      actualizado_por: req.usuario.uid,
      actualizado_en: new Date()
    };

    if (id_empleado) updatesFirestore.id_empleado = String(id_empleado).trim();

    const updatesAuth = {};

    if (email !== undefined) {
      if (!esEmailValido(email)) {
        return res.status(400).json({
          success: false,
          message: 'El email no tiene un formato válido.'
        });
      }

      updatesFirestore.email = String(email).trim();
      updatesAuth.email = String(email).trim();
    }

    if (nombre !== undefined) {
      updatesFirestore.nombre = String(nombre).trim();
      updatesAuth.displayName = String(nombre).trim();
    }

    if (activo !== undefined) {
      updatesFirestore.activo = Boolean(activo);
    }

    if (req.usuario.rol === ROLES.ADMIN && jefe_uid !== undefined) {
      const jefeDoc = await db.collection('usuarios').doc(jefe_uid).get();
      if (!jefeDoc.exists || jefeDoc.data().rol !== ROLES.JEFE) {
        return res.status(400).json({
          success: false,
          message: 'El jefe asignado no existe o no tiene rol JEFE.'
        });
      }

      updatesFirestore.jefe_uid = jefe_uid;
    }

    if (req.usuario.rol === ROLES.JEFE) {
      updatesFirestore.jefe_uid = req.usuario.uid;
    }

    if (password) {
      updatesAuth.password = password;
    }

    await ref.update(updatesFirestore);

    if (Object.keys(updatesAuth).length > 0) {
      await admin.auth().updateUser(uid, updatesAuth);
    }

    const updated = await ref.get();

    res.json({
      success: true,
      message: 'Empleado actualizado exitosamente.',
      usuario: normalizarEmpleado(updated)
    });
  } catch (error) {
    console.error('Error actualizando empleado:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.'
      });
    }

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

app.delete('/api/empleados/:uid', autorizar('empleados:eliminar'), async (req, res) => {
  const { uid } = req.params;

  try {
    const ref = db.collection('usuarios').doc(uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'Empleado no encontrado.'
      });
    }

    const data = snapshot.data();
    if (data.rol !== ROLES.EMPLEADO) {
      return res.status(403).json({
        success: false,
        message: 'Solo se pueden eliminar usuarios con rol EMPLEADO.'
      });
    }

    if (!puedeGestionarEmpleado(req.usuario, data)) {
      return res.status(403).json({
        success: false,
        message: 'No puedes eliminar empleados que no te pertenecen.'
      });
    }

    await ref.update({
      activo: false,
      eliminado_por: req.usuario.uid,
      eliminado_en: new Date()
    });

    await admin.auth().deleteUser(uid);

    res.json({
      success: true,
      message: 'Empleado eliminado exitosamente.'
    });
  } catch (error) {
    console.error('Error eliminando empleado:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.'
      });
    }

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// ENDPOINT 8C: CRUD de Jefes (Solo Admin)
// ==========================================
app.get('/api/jefes', autorizar('jefes:ver'), async (req, res) => {
  try {
    const jefesSnapshot = await db.collection('usuarios').where('rol', '==', ROLES.JEFE).get();
    const jefes = [];

    jefesSnapshot.forEach((doc) => {
      jefes.push(normalizarJefe(doc));
    });

    res.json({
      success: true,
      cantidad: jefes.length,
      data: jefes
    });
  } catch (error) {
    console.error('Error listando jefes:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo jefes'
    });
  }
});

app.post('/api/jefes', autorizar('jefes:crear'), async (req, res) => {
  const { email, nombre, password } = req.body;

  if (!email || !nombre || !password) {
    return res.status(400).json({
      success: false,
      message: 'Email, nombre y password son requeridos.'
    });
  }

  if (!esEmailValido(email)) {
    return res.status(400).json({
      success: false,
      message: 'El email no tiene un formato válido.'
    });
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: String(email).trim(),
      password,
      displayName: String(nombre).trim()
    });

    await db.collection('usuarios').doc(userRecord.uid).set({
      email: String(email).trim(),
      nombre: String(nombre).trim(),
      rol: ROLES.JEFE,
      creado_por: req.usuario.uid,
      creado_en: new Date(),
      actualizado_en: null,
      activo: true
    });

    res.status(201).json({
      success: true,
      message: 'Jefe creado exitosamente.',
      usuario: {
        uid: userRecord.uid,
        email: String(email).trim(),
        nombre: String(nombre).trim(),
        rol: ROLES.JEFE
      }
    });
  } catch (error) {
    console.error('Error creando jefe:', error.message);

    // Rollback si se creó en Auth pero falló en Firestore
    if (userRecord && userRecord.uid) {
      await admin.auth().deleteUser(userRecord.uid).catch(err =>
        console.error('Error al hacer rollback de Auth:', err.message)
      );
    }

    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({
        success: false,
        message: 'Ya existe un usuario con ese email.'
      });
    }

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

app.put('/api/jefes/:uid', autorizar('jefes:actualizar'), async (req, res) => {
  const { uid } = req.params;
  const { email, nombre, password, activo } = req.body;

  try {
    const ref = db.collection('usuarios').doc(uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'Jefe no encontrado.'
      });
    }

    const data = snapshot.data();
    if (data.rol !== ROLES.JEFE) {
      return res.status(403).json({
        success: false,
        message: 'Solo se pueden editar usuarios con rol JEFE.'
      });
    }

    const updatesFirestore = {
      actualizado_por: req.usuario.uid,
      actualizado_en: new Date()
    };

    const updatesAuth = {};

    if (email !== undefined) {
      if (!esEmailValido(email)) {
        return res.status(400).json({
          success: false,
          message: 'El email no tiene un formato válido.'
        });
      }

      updatesFirestore.email = String(email).trim();
      updatesAuth.email = String(email).trim();
    }

    if (nombre !== undefined) {
      updatesFirestore.nombre = String(nombre).trim();
      updatesAuth.displayName = String(nombre).trim();
    }

    if (activo !== undefined) {
      updatesFirestore.activo = Boolean(activo);
    }

    if (password) {
      updatesAuth.password = password;
    }

    await ref.update(updatesFirestore);

    if (Object.keys(updatesAuth).length > 0) {
      await admin.auth().updateUser(uid, updatesAuth);
    }

    const updated = await ref.get();

    res.json({
      success: true,
      message: 'Jefe actualizado exitosamente.',
      usuario: normalizarJefe(updated)
    });
  } catch (error) {
    console.error('Error actualizando jefe:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.'
      });
    }

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

app.delete('/api/jefes/:uid', autorizar('jefes:eliminar'), async (req, res) => {
  const { uid } = req.params;

  try {
    const ref = db.collection('usuarios').doc(uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'Jefe no encontrado.'
      });
    }

    const data = snapshot.data();
    if (data.rol !== ROLES.JEFE) {
      return res.status(403).json({
        success: false,
        message: 'Solo se pueden eliminar usuarios con rol JEFE.'
      });
    }

    // Soft delete
    await ref.update({
      activo: false,
      eliminado_por: req.usuario.uid,
      eliminado_en: new Date()
    });

    // Eliminar de Firebase Auth
    await admin.auth().deleteUser(uid);

    res.json({
      success: true,
      message: 'Jefe eliminado exitosamente.'
    });
  } catch (error) {
    console.error('Error eliminando jefe:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.'
      });
    }

    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// ENDPOINT 9: Actualizar rol de usuario (Solo Admin)
// ==========================================
app.put('/api/usuarios/:uid/rol', autorizar('usuarios:actualizar'), async (req, res) => {
  const { uid } = req.params;
  const { rol } = req.body;

  if (!rol || !Object.values(ROLES).includes(rol)) {
    return res.status(400).json({
      success: false,
      message: `Rol inválido. Roles permitidos: ${Object.values(ROLES).join(', ')}`
    });
  }

  try {
    await db.collection('usuarios').doc(uid).update({
      rol,
      actualizado_por: req.usuario.uid,
      actualizado_en: new Date()
    });

    res.json({
      success: true,
      message: 'Rol actualizado exitosamente.'
    });
  } catch (error) {
    console.error('Error actualizando rol:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// ENDPOINT 10: Eliminar usuario (Solo Admin)
// ==========================================
app.delete('/api/usuarios/:uid', autorizar('usuarios:eliminar'), async (req, res) => {
  const { uid } = req.params;

  try {
    // Marcar como inactivo en Firestore
    await db.collection('usuarios').doc(uid).update({
      activo: false,
      eliminado_por: req.usuario.uid,
      eliminado_en: new Date()
    });

    // Opcionalmente, también eliminarlo de Firebase Auth
    await admin.auth().deleteUser(uid);

    res.json({
      success: true,
      message: 'Usuario eliminado exitosamente.'
    });
  } catch (error) {
    console.error('Error eliminando usuario:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// ENDPOINT 11: Login simulado (Para desarrollo)
// ==========================================
app.post('/api/auth/login', (req, res) => {
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

  // En producción, usar Firebase Auth correctamente
  res.json({
    success: true,
    message: 'Login simulado exitoso',
    usuario: {
      email,
      rol,
      nombre: rol === ROLES.ADMIN ? 'Admin' :
        rol === ROLES.JEFE ? 'Jefe' :
          'Empleado'
    },
    // En desarrollo simulado, devolver token falso
    token: 'simulado-token-' + Date.now()
  });
});

// Inicializar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor ILPEA corriendo en http://localhost:${PORT}`);
  console.log(`Conectado a Firebase Project: ${serviceAccount.project_id}`);
});