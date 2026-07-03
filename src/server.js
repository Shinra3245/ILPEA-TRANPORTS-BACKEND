// backend/src/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const operacionRoutes = require('./routes/operacion');
const app = express();
// Importar configuración de RBAC y utilidades
const { ROLES } = require('./config/roles');
const { autenticar, autorizar, autenticarSimulado, registrarAccion, invalidarCacheUsuario } = require('./middleware/auth');
const utils = require('./lib/utils');
const {
  db,
  admin,
  crearClienteOpenAI,
  esTimeoutOpenAI,
  generarRespuestaFallback,
  convertirAFecha,
  obtenerNumeroSemanaISO,
  obtenerRangoSemanaISO,
  construirMetricasOperativas,
  esEmailValido,
  generarPasswordTemporal,
  programarEnvioCorreoAltaEmpleado,
  programarEnvioCorreoAltaJefe,
  programarEnvioCorreoAltaAdmin,
  verificarTransporterSMTP,
  existeIdEmpleado,
  eliminarUsuarioDefinitivo,
  asignarCamioneroUnidadTurno,
  normalizarAsignacionUnidadTurno,
  limpiarAsignacionCamionero,
  esRutaActiva,
  obtenerBloqueoEliminacionRuta,
  normalizarPasajerosDetalle,
  extraerPasajerosProgramacion,
  construirVehiculoSnapshot,
  registrarDiasOperacionTurno,
  limpiarCacheDiasOperacionTurno,
} = utils;
const {
  PLANTILLA_TURNOS,
  DIAS_SEMANA,
  TIPOS_VALIDOS,
  normalizarTipoTurno,
  slugTurnoId,
  esIdPlantilla,
} = require('./lib/turnosPlantilla');
const {
  PLANTILLA_UNIDADES,
  TIPOS_VALIDOS: TIPOS_UNIDAD_VALIDOS,
  normalizarTipoUnidad,
  idVehiculoPorCodigo,
  esIdPlantillaUnidad,
} = require('./lib/unidadesPlantilla');

const NOTIFICACION_CORREO_EN_PROCESO = {
  enviado: null,
  motivo: 'ENVIO_EN_PROCESO',
  detalle: 'El correo se envia en segundo plano.'
};
const QR_TOKEN_TTL_SECONDS = Number(process.env.QR_TOKEN_TTL_SECONDS || 300);

function resolverQrSecret() {
  const secreto = String(process.env.QR_SIGNING_SECRET || '').trim();
  if (secreto) {
    return secreto;
  }
  return String(process.env.FIREBASE_PROJECT_ID || process.env.NODE_ENV || 'ilpea-qr-secret');
}

function firmarPayloadQr(payloadPlano) {
  return crypto
    .createHmac('sha256', resolverQrSecret())
    .update(payloadPlano, 'utf8')
    .digest('hex');
}

function crearTokenQrAsistencia(payload) {
  const payloadPlano = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const firma = firmarPayloadQr(payloadPlano);
  return `${payloadPlano}.${firma}`;
}

function verificarTokenQrAsistencia(token) {
  const tokenTexto = String(token || '').trim();
  const [payloadPlano, firma] = tokenTexto.split('.');
  if (!payloadPlano || !firma) {
    throw new Error('QR_INVALIDO: El token QR no tiene formato válido.');
  }

  const firmaEsperada = firmarPayloadQr(payloadPlano);
  if (firma.length !== firmaEsperada.length) {
    throw new Error('QR_INVALIDO: La firma del QR no es válida.');
  }
  if (!crypto.timingSafeEqual(Buffer.from(firma, 'utf8'), Buffer.from(firmaEsperada, 'utf8'))) {
    throw new Error('QR_INVALIDO: La firma del QR no es válida.');
  }

  const payload = JSON.parse(Buffer.from(payloadPlano, 'base64url').toString('utf8'));
  if (!payload?.id_empleado || !payload?.fecha || !payload?.exp) {
    throw new Error('QR_INVALIDO: El contenido del QR está incompleto.');
  }

  if (Number(payload.exp) < Math.floor(Date.now() / 1000)) {
    throw new Error('QR_EXPIRADO: El QR expiró, solicita uno nuevo.');
  }

  return payload;
}

// Fase 6 (contract): con DUAL_WRITE_LEGADO=off se dejan de escribir los campos
// legados de programacion_diaria (pasajeros_ids, asientos_reservados,
// asientos_por_empleado). Activar solo después de correr el backfill (Fase 3)
// y validar las lecturas del formato nuevo (Fase 4).
const DUAL_WRITE_LEGADO = String(process.env.DUAL_WRITE_LEGADO || 'on').toLowerCase() !== 'off';

function limpiarCamposLegados(payload) {
  if (DUAL_WRITE_LEGADO) {
    return payload;
  }

  const { pasajeros_ids, asientos_reservados, asientos_por_empleado, ...resto } = payload;
  return resto;
}

function cargarCredencialesFirebase() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  const keyPath = process.env.FIREBASE_KEY_PATH
    ? path.resolve(__dirname, process.env.FIREBASE_KEY_PATH)
    : path.resolve(__dirname, '../config/firebase-key.json');

  return require(keyPath);
}

const openai = crearClienteOpenAI();

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

async function generarIdCamioneroUnico() {
  const maxIntentos = 20;

  for (let intento = 0; intento < maxIntentos; intento += 1) {
    const candidato = `CAM-${crypto.randomInt(100000, 999999)}`;
    const existe = await db
      .collection('usuarios')
      .where('id_camionero', '==', candidato)
      .limit(1)
      .get();

    if (existe.empty) {
      return candidato;
    }
  }

  throw new Error('No se pudo generar un ID de camionero único. Intenta nuevamente.');
}

function construirIdCamioneroDesdeUid(uid) {
  const fragmento = String(uid || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-6)
    .toUpperCase();

  if (!fragmento) {
    return `CAM-${crypto.randomInt(100000, 999999)}`;
  }

  return `CAM-${fragmento}`;
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
    activo: data.activo !== false,
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
    activo: data.activo !== false,
    creado_en: data.creado_en,
    actualizado_en: data.actualizado_en,
    creado_por: data.creado_por,
    actualizado_por: data.actualizado_por
  };
}

function normalizarAdmin(doc) {
  return normalizarJefe(doc);
}

function normalizarCamionero(doc) {
  const data = doc.data();
  return {
    uid: doc.id,
    id_camionero: data.id_camionero || construirIdCamioneroDesdeUid(doc.id),
    email: data.email,
    nombre: data.nombre,
    rol: data.rol,
    activo: data.activo !== false,
    asignacion_unidad_turno: normalizarAsignacionUnidadTurno(data.asignacion_unidad_turno),
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

function obtenerEstadoProgramacion(data) {
  const estado = textoNormalizado(data?.estado || data?.estado_programacion).toLowerCase();
  return estado === 'cancelada' ? 'cancelada' : 'activa';
}

function esProgramacionCancelada(data) {
  return obtenerEstadoProgramacion(data) === 'cancelada';
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
    estado: 'activa',
    programada_auto: true,
    zona: rutaData.zona || rutaData.nombre || null,
    tipo_unidad: rutaData['tipo de unidad'] || rutaData.tipo_unidad || null,
    creado_en: new Date(),
    creado_por: uidCreador,
    actualizado_en: new Date(),
    actualizado_por: uidCreador
  };
}

/**
 * Prepara el mapa `pasajeros` para un set con merge: conserva el detalle final
 * y marca con FieldValue.delete() las claves que existían antes y ya no están
 * (merge no elimina claves de mapas por sí solo).
 */
function construirMapaPasajerosMerge(detalleFinal, dataAnterior) {
  const resultado = { ...detalleFinal };
  const previos = normalizarPasajerosDetalle(dataAnterior?.pasajeros);

  Object.keys(previos).forEach((idEmpleado) => {
    if (!(idEmpleado in resultado)) {
      resultado[idEmpleado] = admin.firestore.FieldValue.delete();
    }
  });

  return resultado;
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
    const ocupacion = Number(ruta.porcentaje_ocupacion_max ?? ruta.ocupacion_pct);
    const pasajeros = Number(ruta.max_pasajeros_dia ?? ruta.asientos_ocupados);
    const tipoUnidad = String(ruta['tipo de unidad'] || ruta.tipo_unidad || '').toLowerCase();
    const estaRealmenteProgramada = ruta.programada === true
      && ruta.fuente_datos !== 'catalogo_sin_programacion';

    // cancelar_reasignar solo aplica si hay programacion_diaria activa con pasajeros reales
    if (estaRealmenteProgramada && pasajeros > 0 && !Number.isNaN(ocupacion) && ocupacion < 40) {
      const probabilidadCancelacion = calcularProbabilidadCancelacionDesdeOcupacion(ocupacion);
      insights.push({
        recomendacion_id: crearIdRecomendacion(rutaId, insights.length),
        titulo: `Cancelar Ruta - ${nombreRuta}`,
        descripcion: `La ruta ${nombreRuta} tiene una ocupación del ${formatearValorPorcentaje(ocupacion)}%, menor al 40%.`,
        prioridad: 'alta',
        ruta_id: rutaId,
        tipo_accion: 'cancelar_reasignar',
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
        tipo_accion: 'cambiar_unidad',
        prob_cancelacion: null,
        ruta_alternativa_sugerida: null,
        tipo_unidad_sugerida: 'VAN',
        capacidad_sugerida: Math.max(pasajeros, 12)
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
const TIPOS_ACCION_INSIGHT = ['cancelar_reasignar', 'cambiar_unidad'];

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

function formatearEtiquetaRuta(rutaData, rutaId) {
  const numeroRuta = rutaData?.ruta;
  const zona = textoNormalizado(
    rutaData?.zona
    || rutaData?.nombre
    || rutaData?.['ruta nombre']
    || rutaData?.nombre_ruta
  );
  const idTexto = textoNormalizado(rutaId);

  if (numeroRuta != null && zona) {
    return `Ruta ${numeroRuta} - ${zona}`;
  }

  if (numeroRuta != null) {
    return `Ruta ${numeroRuta}`;
  }

  if (zona) {
    return zona;
  }

  return idTexto || 'N/D';
}

async function obtenerEtiquetaRutaPorId(idRuta, cache = new Map()) {
  const idTexto = textoNormalizado(idRuta);
  if (!idTexto) {
    return 'N/D';
  }

  if (cache.has(idTexto)) {
    return cache.get(idTexto);
  }

  const ruta = await resolverRutaPorIdentificador(idTexto);
  const etiqueta = ruta ? formatearEtiquetaRuta(ruta.data, ruta.id) : idTexto;
  cache.set(idTexto, etiqueta);
  return etiqueta;
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

function inferirTipoAccionInsight(insight) {
  const accionExplicita = textoNormalizado(
    insight?.tipo_accion || insight?.accion || insight?.action_type || insight?.tipo_recomendacion
  ).toLowerCase();

  if (TIPOS_ACCION_INSIGHT.includes(accionExplicita)) {
    return accionExplicita;
  }

  const texto = `${textoNormalizado(insight?.titulo || insight?.title)} ${textoNormalizado(insight?.descripcion || insight?.description)}`.toLowerCase();
  if (texto.includes('van') || texto.includes('unidad') || texto.includes('vehiculo') || texto.includes('vehículo') || texto.includes('right')) {
    return 'cambiar_unidad';
  }

  return 'cancelar_reasignar';
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
  const capacidadSugerida = Number(insight.capacidad_sugerida ?? insight.capacidad_limite_sugerida);
  const tipoAccion = inferirTipoAccionInsight(insight);

  if (!rutaId || !titulo || !descripcion) {
    return null;
  }

  return {
    recomendacion_id: textoNormalizado(insight.recomendacion_id) || crearIdRecomendacion(rutaId, indice),
    titulo,
    descripcion,
    prioridad,
    ruta_id: rutaId,
    tipo_accion: tipoAccion,
    prob_cancelacion: Number.isFinite(probCancelacion) ? Number(probCancelacion.toFixed(2)) : null,
    ruta_alternativa_sugerida: textoNormalizado(
      insight.ruta_alternativa_sugerida || insight.ruta_destino_id || insight.ruta_destino || ''
    ) || null,
    tipo_unidad_sugerida: textoNormalizado(insight.tipo_unidad_sugerida || insight.unidad_sugerida || '') || null,
    capacidad_sugerida: Number.isInteger(capacidadSugerida) && capacidadSugerida > 0 ? capacidadSugerida : null,
    codigo_unidad_sugerido: textoNormalizado(insight.codigo_unidad_sugerido || insight.codigo_unidad || '') || null
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
const RUTAS_PUBLICAS = ['/api/auth/login', '/api/auth/enviar-reset', '/api/asistencia/escanear-qr-publico'];
app.use((req, res, next) => {
  if (RUTAS_PUBLICAS.includes(req.path)) return next();

  const modoAuth = (process.env.AUTH_MODE || 'firebase').toLowerCase();
  if (modoAuth === 'simulated') {
    return autenticarSimulado(req, res, next);
  }
  return autenticar(req, res, next);
});

app.use('/api', authRoutes);

// Middleware de logging/auditoría
app.use(registrarAccion('acciones', {
  rutasExcluidas: ['/api/auth/me', '/api/test-ilpea']
}));

// Módulos nuevos: programación semanal, abordajes y métricas agregadas (Fase 5)
app.use('/api', operacionRoutes);

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
      if (!esRutaActiva(rutaData)) {
        return;
      }

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

async function construirListaRutasOperativas(fecha, turno) {
  const fechaTexto = textoNormalizado(fecha);
  const turnoTexto = turnoNormalizado(turno);

  // Antes: 1 query de rutas + 1 query de programación POR CADA ruta (N+1).
  // Ahora: 2 queries totales y join en memoria por id_ruta.
  const [rutasSnapshot, programacionSnapshot] = await Promise.all([
    db.collection('rutas').get(),
    db.collection('programacion_diaria').where('fecha', '==', fechaTexto).get()
  ]);

  const programacionesPorRuta = new Map();
  programacionSnapshot.forEach((doc) => {
    const data = doc.data() || {};
    const idRuta = textoNormalizado(data.id_ruta);
    if (!idRuta) {
      return;
    }

    if (!programacionesPorRuta.has(idRuta)) {
      programacionesPorRuta.set(idRuta, []);
    }
    programacionesPorRuta.get(idRuta).push({ docId: doc.id, data });
  });

  // Replica la precedencia de resolverProgramacion: docId con turno explícito,
  // luego docId sin turno y, si no se pidió turno, cualquier doc de esa ruta.
  function elegirProgramacion(idRuta) {
    const candidatos = programacionesPorRuta.get(idRuta) || [];
    const [idConTurno, idSinTurno] = construirIdsProgramacion(fechaTexto, idRuta, turnoTexto);

    const porIdConTurno = turnoTexto
      ? candidatos.find((item) => item.docId === idConTurno)
      : null;
    if (porIdConTurno) {
      return porIdConTurno;
    }

    const porIdSinTurno = candidatos.find((item) => item.docId === (idSinTurno || idConTurno));
    if (porIdSinTurno) {
      return porIdSinTurno;
    }

    if (!turnoTexto && candidatos.length) {
      return candidatos[0];
    }

    return { docId: idConTurno, data: null };
  }

  const rutas = rutasSnapshot.docs.map((rutaDoc) => {
    const rutaData = rutaDoc.data() || {};
    if (!esRutaActiva(rutaData)) {
      return null;
    }

    const programacion = elegirProgramacion(rutaDoc.id);
    const dataProgramacion = programacion.data || {};

    // Lectura formato nuevo con fallback al legado (Fase 4).
    const pasajeros = extraerPasajerosProgramacion(dataProgramacion);
    const capacidadLimite = Number(dataProgramacion.capacidad_limite)
      || Number(dataProgramacion.vehiculo?.capacidad)
      || Number(rutaData.capacidad_real)
      || 12;
    const asientosOcupadosDato = Number(dataProgramacion.asientos_ocupados);
    const asientosOcupados = Number.isFinite(asientosOcupadosDato)
      ? asientosOcupadosDato
      : Math.max(pasajeros.asientosReservados.length, pasajeros.ids.length);
    const estadoProgramacion = obtenerEstadoProgramacion(dataProgramacion);
    const programada = Boolean(programacion.data);
    const tipoUnidad = dataProgramacion.vehiculo?.tipo
      || dataProgramacion.tipo_unidad
      || rutaData.tipo_unidad
      || rutaData['tipo de unidad']
      || null;
    const metricas = construirMetricasOperativas({
      tipoUnidad,
      capacidadLimite,
      asientosOcupados,
      programada
    });

    return {
      id: rutaDoc.id,
      ...rutaData,
      ...metricas,
      ...normalizarPeriodoRuta({ ...rutaData, fecha_programada: fecha }, convertirAFecha(fecha) || new Date()),
      programada,
      programacion_id: programacion.docId,
      fecha_programada: fecha,
      turno_programado: dataProgramacion.turno || turno || null,
      capacidad_limite: capacidadLimite,
      tipo_unidad: tipoUnidad,
      codigo_unidad: dataProgramacion.vehiculo?.codigo || dataProgramacion.codigo_unidad || rutaData.codigo_unidad || null,
      link_samsara: rutaData.link_samsara || null,
      estado: estadoProgramacion,
      estado_programacion: estadoProgramacion,
      cancelada: estadoProgramacion === 'cancelada',
      motivo_cancelacion: dataProgramacion.motivo_cancelacion || null,
      unidad_actualizada_en: dataProgramacion.unidad_actualizada_en || null,
      asientos_ocupados: asientosOcupados,
      asientos_reservados: pasajeros.asientosReservados,
      asientos_por_empleado: pasajeros.asientosPorEmpleado,
      pasajeros_ids: pasajeros.ids,
      pasajeros_detalle: pasajeros.detalle,
      total_abordados: Number(dataProgramacion.total_abordados) || 0,
      asientos_disponibles: Math.max(capacidadLimite - asientosOcupados, 0)
    };
  });

  return rutas
    .filter(Boolean)
    .sort((a, b) => Number(a.ruta || 0) - Number(b.ruta || 0));
}

app.get('/api/rutas/programadas/rango', autorizar('rutas:ver'), async (req, res) => {
  let desde = textoNormalizado(req.query.desde);
  let hasta = textoNormalizado(req.query.hasta);
  const semana = Number(req.query.semana);
  const anio = Number(req.query.anio) || new Date().getFullYear();
  const turno = turnoNormalizado(req.query.turno);

  if (!desde && !hasta && Number.isInteger(semana) && semana > 0) {
    const rango = obtenerRangoSemanaISO(anio, semana);
    if (!rango) {
      return res.status(400).json({
        success: false,
        message: 'La semana debe estar entre 1 y 53.'
      });
    }

    desde = rango.desde;
    hasta = rango.hasta;
  }

  if (!desde || !hasta) {
    return res.status(400).json({
      success: false,
      message: 'Debes enviar desde/hasta (YYYY-MM-DD) o el parametro semana.'
    });
  }

  try {
    const progSnap = await db.collection('programacion_diaria')
      .where('fecha', '>=', desde)
      .where('fecha', '<=', hasta)
      .get();

    const agregadosPorRuta = new Map();

    progSnap.forEach((doc) => {
      const data = doc.data() || {};
      if (turno && data.turno && turnoNormalizado(data.turno) !== turno) {
        return;
      }

      const idRuta = textoNormalizado(data.id_ruta);
      if (!idRuta) {
        return;
      }

      // Formato nuevo (mapa `pasajeros`) con fallback al legado.
      const pasajeros = extraerPasajerosProgramacion(data);
      const asientosOcupadosDato = Number(data.asientos_ocupados);
      const asientosOcupados = Number.isFinite(asientosOcupadosDato)
        ? asientosOcupadosDato
        : Math.max(pasajeros.asientosReservados.length, pasajeros.total);
      const capacidadLimite = Number(data.capacidad_limite) || Number(data.vehiculo?.capacidad) || 12;
      const ocupacionPct = capacidadLimite > 0 ? (asientosOcupados / capacidadLimite) * 100 : 0;

      const prev = agregadosPorRuta.get(idRuta) || {
        dias_programados: 0,
        pico_asientos: 0,
        suma_ocupacion: 0,
        pico_ocupacion_pct: 0
      };

      agregadosPorRuta.set(idRuta, {
        dias_programados: prev.dias_programados + 1,
        pico_asientos: Math.max(prev.pico_asientos, asientosOcupados),
        suma_ocupacion: prev.suma_ocupacion + ocupacionPct,
        pico_ocupacion_pct: Math.max(prev.pico_ocupacion_pct, ocupacionPct)
      });
    });

    const rutasSnapshot = await db.collection('rutas').get();
    const rutas = [];

    rutasSnapshot.forEach((rutaDoc) => {
      const rutaData = rutaDoc.data() || {};
      if (!esRutaActiva(rutaData)) {
        return;
      }

      const agg = agregadosPorRuta.get(rutaDoc.id);
      if (!agg) {
        return;
      }

      const capacidadLimite = Number(rutaData.capacidad_real) || 12;
      const asientosOcupados = agg.pico_asientos;
      const tipoUnidad = rutaData['tipo de unidad'] || null;
      const metricas = construirMetricasOperativas({
        tipoUnidad,
        capacidadLimite,
        asientosOcupados,
        programada: true
      });
      const ocupacionPromedio = agg.dias_programados > 0
        ? Number((agg.suma_ocupacion / agg.dias_programados).toFixed(2))
        : 0;

      rutas.push({
        id: rutaDoc.id,
        ...rutaData,
        ...metricas,
        porcentaje_ocupacion_max: agg.pico_ocupacion_pct,
        ocupacion_pct: agg.pico_ocupacion_pct,
        ocupacion_promedio_pct: ocupacionPromedio,
        dias_programados: agg.dias_programados,
        asientos_ocupados: asientosOcupados,
        capacidad_limite: capacidadLimite,
        programada: true,
        fuente_datos: 'programacion_diaria_rango',
        fecha_operacion: hasta,
        semana_operacion: obtenerNumeroSemanaISO(convertirAFecha(desde) || new Date())
      });
    });

    rutas.sort((a, b) => Number(a.ruta || 0) - Number(b.ruta || 0));

    res.status(200).json({
      success: true,
      desde,
      hasta,
      semana: Number.isInteger(semana) && semana > 0 ? semana : null,
      anio,
      turno: turno || null,
      cantidad: rutas.length,
      data: rutas
    });
  } catch (error) {
    console.error('Error obteniendo rutas programadas por rango:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo rutas programadas por rango.'
    });
  }
});

app.get('/api/rutas/calendario', autorizar('rutas:ver'), async (req, res) => {
  const desde = textoNormalizado(req.query.desde);
  const hasta = textoNormalizado(req.query.hasta);
  const isoFecha = /^\d{4}-\d{2}-\d{2}$/;

  if (!isoFecha.test(desde) || !isoFecha.test(hasta)) {
    return res.status(400).json({
      success: false,
      message: 'Debes enviar desde y hasta en formato YYYY-MM-DD.',
    });
  }

  if (desde > hasta) {
    return res.status(400).json({
      success: false,
      message: 'La fecha desde no puede ser posterior a hasta.',
    });
  }

  const fechaDesde = convertirAFecha(desde);
  const fechaHasta = convertirAFecha(hasta);
  if (!fechaDesde || !fechaHasta) {
    return res.status(400).json({
      success: false,
      message: 'Las fechas enviadas no son válidas.',
    });
  }

  const diffMs = fechaHasta.getTime() - fechaDesde.getTime();
  const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
  if (diffDias > 45) {
    return res.status(400).json({
      success: false,
      message: 'El rango máximo permitido es de 45 días.',
    });
  }

  try {
    const [progSnap, rutasSnap, turnosSnap] = await Promise.all([
      db.collection('programacion_diaria')
        .where('fecha', '>=', desde)
        .where('fecha', '<=', hasta)
        .get(),
      db.collection('rutas').get(),
      db.collection('turnos').get(),
    ]);

    // Lookup de turnos del catálogo: id → { nombre, dia_semana, activo }
    const turnoMap = new Map();
    turnosSnap.forEach((doc) => {
      const t = doc.data() || {};
      turnoMap.set(doc.id, {
        nombre: t.nombre || doc.id,
        dia_semana: t.dia_semana ?? null,
        activo: t.activo !== false,
      });
    });

    const numeroPorRutaId = new Map();
    const rutasActivas = new Set();
    const rutasDeshabilitadas = new Set();
    const turnosPorRuta = new Map(); // rutaId → [turnoId, ...]

    rutasSnap.forEach((doc) => {
      const data = doc.data() || {};
      const numero = Number(data.ruta);
      if (Number.isFinite(numero)) {
        numeroPorRutaId.set(doc.id, numero);
      }
      if (esRutaActiva(data)) {
        rutasActivas.add(doc.id);
        if (Array.isArray(data.turnos) && data.turnos.length) {
          turnosPorRuta.set(doc.id, data.turnos.map((t) => textoNormalizado(t)).filter(Boolean));
        }
      } else {
        rutasDeshabilitadas.add(doc.id);
      }
    });

    const dias = {};
    const registrosUnicos = new Set();

    progSnap.forEach((doc) => {
      const data = doc.data() || {};
      const fecha = textoNormalizado(data.fecha);
      if (!fecha) {
        return;
      }

      const idRuta = textoNormalizado(data.id_ruta);
      const esDeshabilitada = idRuta ? rutasDeshabilitadas.has(idRuta) : false;

      const turno = textoNormalizado(data.turno) || textoNormalizado(data.turno_id) || '—';
      const turno_id = textoNormalizado(data.turno_id) || null;

      // Evitar duplicados del mismo turno y ruta en el mismo día
      const uniqueKey = `${fecha}|${idRuta}|${turno_id || turno}`;
      if (registrosUnicos.has(uniqueKey)) {
        return;
      }
      registrosUnicos.add(uniqueKey);

      const pasajeros = extraerPasajerosProgramacion(data);
      const asientosOcupadosDato = Number(data.asientos_ocupados);
      const asientosOcupados = Number.isFinite(asientosOcupadosDato)
        ? asientosOcupadosDato
        : Math.max(pasajeros.asientosReservados.length, pasajeros.total);
      const capacidadLimite = Number(data.capacidad_limite)
        || Number(data.vehiculo?.capacidad)
        || 12;
      const estado = obtenerEstadoProgramacion(data);
      const rutaNumero = Number(data.ruta_numero)
        || numeroPorRutaId.get(idRuta)
        || 0;

      if (!dias[fecha]) {
        dias[fecha] = { total: 0, rutas: [] };
      }

      dias[fecha].rutas.push({
        ruta: rutaNumero,
        turno,
        turno_id,
        estado,
        asientos_ocupados: asientosOcupados,
        capacidad_limite: capacidadLimite,
        cancelada: !esDeshabilitada && estado === 'cancelada',
        deshabilitada: esDeshabilitada,
        planificada: false,
        id_ruta: idRuta || null,
        programacion_id: doc.id,
      });
    });

    // Generar entradas "planificadas" del catálogo para días sin programacion_diaria
    // Construir lista de fechas en el rango
    const fechasEnRango = [];
    {
      let cur = new Date(fechaDesde.getTime());
      while (cur <= fechaHasta) {
        fechasEnRango.push(cur.toISOString().slice(0, 10));
        cur = new Date(cur.getTime() + 86400000);
      }
    }

    turnosPorRuta.forEach((turnoIds, rutaId) => {
      const rutaNumero = numeroPorRutaId.get(rutaId) || 0;
      turnoIds.forEach((turnoId) => {
        const turnoInfo = turnoMap.get(turnoId);
        if (!turnoInfo || !turnoInfo.activo || turnoInfo.dia_semana == null) return;

        const diaSemanaEsperado = turnoInfo.dia_semana; // 1=Lun … 7=Dom

        fechasEnRango.forEach((fecha) => {
          const jsDow = new Date(fecha + 'T12:00:00Z').getUTCDay(); // 0=Dom, 1=Lun…
          const isoDow = jsDow === 0 ? 7 : jsDow; // 1=Lun … 7=Dom
          if (isoDow !== diaSemanaEsperado) return;

          const uniqueKey = `${fecha}|${rutaId}|${turnoId}`;
          if (registrosUnicos.has(uniqueKey)) return; // ya materializada

          if (!dias[fecha]) dias[fecha] = { total: 0, rutas: [] };
          dias[fecha].rutas.push({
            ruta: rutaNumero,
            turno: turnoInfo.nombre,
            turno_id: turnoId,
            estado: 'planificada',
            asientos_ocupados: 0,
            capacidad_limite: 0,
            cancelada: false,
            deshabilitada: false,
            planificada: true,
            id_ruta: rutaId,
            programacion_id: null,
          });
        });
      });
    });

    Object.values(dias).forEach((dia) => {
      dia.rutas.sort((a, b) => {
        const diffRuta = Number(a.ruta || 0) - Number(b.ruta || 0);
        if (diffRuta !== 0) {
          return diffRuta;
        }
        return String(a.turno || '').localeCompare(String(b.turno || ''), 'es');
      });
      dia.total = dia.rutas.length;
    });

    res.status(200).json({
      success: true,
      desde,
      hasta,
      dias,
    });
  } catch (error) {
    console.error('Error obteniendo calendario de rutas:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo calendario de rutas.',
    });
  }
});

app.get('/api/rutas/calendario/detalle', autorizar('rutas:ver'), async (req, res) => {
  const programacionId = textoNormalizado(req.query.programacion_id);

  if (!programacionId) {
    return res.status(400).json({
      success: false,
      message: 'Debes enviar programacion_id.',
    });
  }

  try {
    const progDoc = await db.collection('programacion_diaria').doc(programacionId).get();
    if (!progDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Programación no encontrada.',
      });
    }

    const data = progDoc.data() || {};
    const idRuta = textoNormalizado(data.id_ruta);
    let rutaInfo = null;

    if (idRuta) {
      const rutaDoc = await db.collection('rutas').doc(idRuta).get();
      if (rutaDoc.exists) {
        const rutaData = rutaDoc.data() || {};
        rutaInfo = {
          id: rutaDoc.id,
          numero: rutaData.ruta ?? null,
          zona: rutaData.zona || rutaData.nombre || null,
          tipo_unidad: rutaData['tipo de unidad'] || rutaData.tipo_unidad || null,
        };
      }
    }

    const pasajeros = extraerPasajerosProgramacion(data);
    const abordajesSnap = await progDoc.ref.collection('abordajes').get();
    const abordajesPorEmpleado = new Map();
    abordajesSnap.forEach((doc) => abordajesPorEmpleado.set(doc.id, doc.data() || {}));

    const listaPasajeros = pasajeros.ids.map((idEmpleado) => {
      const detalle = pasajeros.detalle[idEmpleado] || {};
      const abordaje = abordajesPorEmpleado.get(idEmpleado) || null;
      return {
        id_empleado: idEmpleado,
        nombre: detalle.nombre || idEmpleado,
        asiento: detalle.asiento ?? null,
        parada_id: detalle.parada_id || null,
        abordo: abordaje?.abordo === true,
        hora_abordaje: abordaje?.hora_abordaje || null,
      };
    });

    const asientosOcupadosDato = Number(data.asientos_ocupados);
    const asientosOcupados = Number.isFinite(asientosOcupadosDato)
      ? asientosOcupadosDato
      : Math.max(pasajeros.asientosReservados.length, pasajeros.total);
    const capacidadLimite = Number(data.capacidad_limite)
      || Number(data.vehiculo?.capacidad)
      || 12;
    const estado = obtenerEstadoProgramacion(data);
    const ocupacionPct = capacidadLimite > 0
      ? Number(((asientosOcupados / capacidadLimite) * 100).toFixed(1))
      : 0;

    res.status(200).json({
      success: true,
      data: {
        programacion_id: progDoc.id,
        fecha: textoNormalizado(data.fecha) || null,
        turno: textoNormalizado(data.turno) || textoNormalizado(data.turno_id) || null,
        turno_id: textoNormalizado(data.turno_id) || null,
        estado,
        cancelada: estado === 'cancelada',
        motivo_cancelacion: data.motivo_cancelacion || null,
        semana_origen: data.semana_origen || null,
        ruta: rutaInfo,
        vehiculo: data.vehiculo || null,
        codigo_unidad: data.vehiculo?.codigo || data.codigo_unidad || null,
        tipo_unidad: data.vehiculo?.tipo || data.tipo_unidad || rutaInfo?.tipo_unidad || null,
        asientos_ocupados: asientosOcupados,
        capacidad_limite: capacidadLimite,
        asientos_disponibles: Math.max(capacidadLimite - asientosOcupados, 0),
        ocupacion_pct: ocupacionPct,
        total_abordados: Number(data.total_abordados) || 0,
        pasajeros: listaPasajeros,
      },
    });
  } catch (error) {
    console.error('Error obteniendo detalle de programación:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo detalle de programación.',
    });
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
    const rutasActivas = await construirListaRutasOperativas(fecha, turno);

    res.status(200).json({
      success: true,
      fecha,
      turno: turno || null,
      cantidad: rutasActivas.length,
      cantidad_programadas: rutasActivas.filter((ruta) => ruta.programada).length,
      data: rutasActivas
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
// ENDPOINT 1.2: Gestión de baja lógica de rutas (soft delete)
// ==========================================
app.get('/api/rutas/eliminacion', autorizar('rutas:eliminar'), async (_req, res) => {
  try {
    const rutasSnapshot = await db.collection('rutas').get();
    const rutasOrdenadas = rutasSnapshot.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
      .sort((a, b) => Number(a.ruta || 0) - Number(b.ruta || 0));

    const data = await Promise.all(
      rutasOrdenadas.map(async (rutaData) => {
        const bloqueo = await obtenerBloqueoEliminacionRuta(rutaData.id);

        return {
          id: rutaData.id,
          ruta: rutaData.ruta ?? null,
          zona: rutaData.zona || rutaData.nombre || null,
          tipo_unidad: rutaData['tipo de unidad'] || rutaData.tipo_unidad || null,
          turnos: Array.isArray(rutaData.turnos) ? rutaData.turnos : [],
          unidad_por_turno: rutaData.unidad_por_turno && typeof rutaData.unidad_por_turno === 'object'
            ? rutaData.unidad_por_turno
            : {},
          activa: esRutaActiva(rutaData),
          eliminada_en: rutaData.eliminada_en || null,
          puede_deshabilitar: bloqueo.puede_eliminar && esRutaActiva(rutaData),
          puede_habilitar: !esRutaActiva(rutaData),
          total_pasajeros: bloqueo.total_pasajeros,
          empleados_a_reasignar: bloqueo.empleados_a_reasignar,
        };
      })
    );

    res.status(200).json({
      success: true,
      cantidad: data.length,
      cantidad_activas: data.filter((ruta) => ruta.activa).length,
      cantidad_deshabilitadas: data.filter((ruta) => !ruta.activa).length,
      data,
    });
  } catch (error) {
    console.error('Error listando rutas para eliminación:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo rutas para eliminación.',
    });
  }
});

// ==========================================
// ENDPOINT 1.3: Generación y edición de rutas (catálogo)
// ==========================================

function slugTexto(texto) {
  return textoNormalizado(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function normalizarTurnosRuta(turnos) {
  if (!Array.isArray(turnos)) {
    return [];
  }

  const vistos = new Set();
  const resultado = [];
  turnos.forEach((turno) => {
    const turnoTexto = turnoNormalizado(turno);
    if (turnoTexto && !vistos.has(turnoTexto)) {
      vistos.add(turnoTexto);
      resultado.push(turnoTexto);
    }
  });
  return resultado;
}

function normalizarParadasRuta(paradas, zonaRuta) {
  if (!Array.isArray(paradas) || !paradas.length) {
    const zona = textoNormalizado(zonaRuta) || 'SIN ZONA';
    return [{ id: `par_${slugTexto(zona) || 'principal'}`, nombre: zona, zona, orden: 1 }];
  }

  return paradas
    .map((parada, indice) => {
      const nombre = textoNormalizado(parada?.nombre) || textoNormalizado(zonaRuta) || `Parada ${indice + 1}`;
      const zona = textoNormalizado(parada?.zona) || textoNormalizado(zonaRuta) || 'SIN ZONA';
      const orden = Number.isInteger(Number(parada?.orden)) ? Number(parada.orden) : indice + 1;
      const id = textoNormalizado(parada?.id) || `par_${slugTexto(nombre) || slugTexto(zona) || `p${indice + 1}`}`;
      return { id, nombre, zona, orden };
    })
    .sort((a, b) => a.orden - b.orden);
}

/**
 * Resuelve la unidad por turno leyendo el catálogo `vehiculos`.
 * Lanza Error con `.status` si un vehículo no existe.
 */
async function resolverUnidadPorTurnoServer(turnos, unidadPorTurnoInput) {
  const resultado = {};
  const cacheVehiculos = new Map();
  const input = unidadPorTurnoInput && typeof unidadPorTurnoInput === 'object' ? unidadPorTurnoInput : {};

  for (const turno of turnos) {
    const entrada = input[turno] || input[turnoNormalizado(turno)] || null;
    const vehiculoId = entrada ? textoNormalizado(entrada.vehiculo_id || entrada.id) : '';
    if (!vehiculoId) {
      continue;
    }

    let vehiculoData = cacheVehiculos.get(vehiculoId);
    if (vehiculoData === undefined) {
      const doc = await db.collection('vehiculos').doc(vehiculoId).get();
      vehiculoData = doc.exists ? (doc.data() || {}) : null;
      cacheVehiculos.set(vehiculoId, vehiculoData);
    }

    if (!vehiculoData) {
      const error = new Error(`La unidad "${vehiculoId}" no existe en el catálogo de vehículos.`);
      error.status = 404;
      throw error;
    }

    resultado[turno] = {
      vehiculo_id: vehiculoId,
      codigo: textoNormalizado(vehiculoData.codigo) || null,
      tipo: textoNormalizado(vehiculoData.tipo) || null,
      capacidad: Number(vehiculoData.capacidad) || null,
    };
  }

  return resultado;
}

/**
 * Impide que la misma unidad quede asignada al mismo turno en otra ruta activa.
 */
async function validarConflictosUnidadPorTurno(excluirRutaId, turnos, unidadPorTurno) {
  const asignacionesNuevas = [];

  for (const turno of turnos) {
    const turnoTexto = turnoNormalizado(turno);
    const unidad = unidadPorTurno[turno] || unidadPorTurno[turnoTexto];
    const vehiculoId = unidad?.vehiculo_id ? textoNormalizado(unidad.vehiculo_id) : '';
    if (vehiculoId) {
      asignacionesNuevas.push({ turno: turnoTexto, vehiculoId, codigo: unidad.codigo || vehiculoId });
    }
  }

  if (!asignacionesNuevas.length) {
    return;
  }

  const rutasSnapshot = await db.collection('rutas').get();
  const conflictos = [];

  rutasSnapshot.forEach((doc) => {
    if (excluirRutaId && doc.id === excluirRutaId) {
      return;
    }

    const data = doc.data() || {};
    if (!esRutaActiva(data)) {
      return;
    }

    const numeroRuta = data.ruta ?? data.numero ?? doc.id;
    const mapa = data.unidad_por_turno && typeof data.unidad_por_turno === 'object'
      ? data.unidad_por_turno
      : {};

    asignacionesNuevas.forEach(({ turno, vehiculoId, codigo }) => {
      Object.entries(mapa).forEach(([turnoKey, existente]) => {
        if (turnoNormalizado(turnoKey) !== turno) {
          return;
        }

        const existenteId = existente?.vehiculo_id ? textoNormalizado(existente.vehiculo_id) : '';
        if (existenteId && existenteId === vehiculoId) {
          conflictos.push({
            vehiculoId,
            turno,
            codigo: existente.codigo || codigo || vehiculoId,
            rutaConflicto: numeroRuta,
          });
        }
      });
    });
  });

  if (conflictos.length) {
    const detalle = conflictos
      .map((c) => `"${c.codigo}" ya está asignada al turno ${c.turno} en la Ruta ${c.rutaConflicto}`)
      .join('; ');
    const error = new Error(`La unidad ya está en uso: ${detalle}`);
    error.status = 409;
    throw error;
  }
}

function derivarDefaultsUnidad(unidadPorTurno) {
  const unidades = Object.values(unidadPorTurno || {});
  if (!unidades.length) {
    return { vehiculo_default: null, capacidad_real: 0, tipo_unidad: null };
  }

  const primera = unidades[0];
  const capacidadMax = unidades.reduce((max, u) => Math.max(max, Number(u.capacidad) || 0), 0);

  return {
    vehiculo_default: {
      id: primera.vehiculo_id || null,
      codigo: primera.codigo || null,
      tipo: primera.tipo || null,
      capacidad: Number(primera.capacidad) || capacidadMax || 0,
    },
    capacidad_real: capacidadMax || Number(primera.capacidad) || 0,
    tipo_unidad: primera.tipo || null,
  };
}

app.post('/api/rutas', autorizar('rutas:crear'), async (req, res) => {
  try {
    const numero = Number(req.body?.ruta ?? req.body?.numero);
    const zona = textoNormalizado(req.body?.zona);
    const nombre = textoNormalizado(req.body?.nombre) || (zona ? `Ruta ${numero} - ${zona}` : `Ruta ${numero}`);
    const turnos = normalizarTurnosRuta(req.body?.turnos);

    if (!Number.isInteger(numero) || numero <= 0) {
      return res.status(400).json({ success: false, message: 'El número de ruta es requerido y debe ser un entero positivo.' });
    }

    if (!turnos.length) {
      return res.status(400).json({ success: false, message: 'Debes seleccionar al menos un turno para la ruta.' });
    }

    // Evita duplicar el número de ruta.
    const duplicada = await db.collection('rutas').where('ruta', '==', numero).limit(1).get();
    if (!duplicada.empty) {
      return res.status(409).json({ success: false, message: `Ya existe una ruta con el número ${numero}.` });
    }

    const unidadPorTurno = await resolverUnidadPorTurnoServer(turnos, req.body?.unidad_por_turno);
    await validarConflictosUnidadPorTurno(null, turnos, unidadPorTurno);
    const defaults = derivarDefaultsUnidad(unidadPorTurno);
    const paradas = normalizarParadasRuta(req.body?.paradas, zona);

    let docId = `ruta_${numero}`;
    if ((await db.collection('rutas').doc(docId).get()).exists) {
      docId = `ruta_${numero}_${Date.now()}`;
    }

    const nuevaRuta = {
      id: docId,
      ruta: numero,
      numero,
      nombre,
      zona: zona || null,
      referencia: textoNormalizado(req.body?.referencia) || null,
      tipo_unidad: defaults.tipo_unidad,
      'tipo de unidad': defaults.tipo_unidad,
      capacidad_real: defaults.capacidad_real,
      turnos,
      unidad_por_turno: unidadPorTurno,
      vehiculo_default: defaults.vehiculo_default,
      paradas,
      activa: true,
      origen: 'manual',
      creada_en: new Date(),
      creada_por: req.usuario?.uid || null,
      actualizado_en: new Date(),
      actualizado_por: req.usuario?.uid || null,
    };

    await db.collection('rutas').doc(docId).set(nuevaRuta);

    res.status(201).json({
      success: true,
      message: `Ruta ${numero} creada correctamente.`,
      data: nuevaRuta,
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error('Error creando ruta:', error.message);
    }
    res.status(status).json({
      success: false,
      message: status >= 500 ? 'Error interno creando la ruta.' : error.message,
    });
  }
});

app.put('/api/rutas/:id', autorizar('rutas:actualizar'), async (req, res) => {
  const idRuta = textoNormalizado(req.params.id);

  if (!idRuta) {
    return res.status(400).json({ success: false, message: 'Debes indicar el identificador de la ruta.' });
  }

  try {
    const rutaEncontrada = await resolverRutaPorIdentificador(idRuta);
    if (!rutaEncontrada) {
      return res.status(404).json({ success: false, message: 'La ruta no existe.' });
    }

    const rutaData = rutaEncontrada.data || {};
    const cambios = { actualizado_en: new Date(), actualizado_por: req.usuario?.uid || null };

    if (req.body?.nombre !== undefined) {
      cambios.nombre = textoNormalizado(req.body.nombre) || rutaData.nombre || null;
    }

    const zonaActualizada = req.body?.zona !== undefined ? textoNormalizado(req.body.zona) : textoNormalizado(rutaData.zona);
    if (req.body?.zona !== undefined) {
      cambios.zona = zonaActualizada || null;
    }

    if (req.body?.paradas !== undefined) {
      cambios.paradas = normalizarParadasRuta(req.body.paradas, zonaActualizada);
    }

    const turnosSolicitados = req.body?.turnos !== undefined
      ? normalizarTurnosRuta(req.body.turnos)
      : normalizarTurnosRuta(rutaData.turnos);

    if (req.body?.turnos !== undefined) {
      cambios.turnos = turnosSolicitados;
    }

    if (req.body?.unidad_por_turno !== undefined || req.body?.turnos !== undefined) {
      const unidadInput = req.body?.unidad_por_turno !== undefined
        ? req.body.unidad_por_turno
        : rutaData.unidad_por_turno;
      const unidadPorTurno = await resolverUnidadPorTurnoServer(turnosSolicitados, unidadInput);
      await validarConflictosUnidadPorTurno(rutaEncontrada.id, turnosSolicitados, unidadPorTurno);
      const defaults = derivarDefaultsUnidad(unidadPorTurno);
      // Reemplaza el mapa completo para no dejar turnos huérfanos al desmarcar uno.
      cambios.unidad_por_turno = unidadPorTurno;
      cambios.vehiculo_default = defaults.vehiculo_default;
      cambios.capacidad_real = defaults.capacidad_real;
      cambios.tipo_unidad = defaults.tipo_unidad;
      cambios['tipo de unidad'] = defaults.tipo_unidad;
    }

    await rutaEncontrada.ref.set(cambios, { merge: true });

    // Si cambiaron turnos/unidades, elimina claves de turnos que ya no aplican.
    if (req.body?.turnos !== undefined || req.body?.unidad_por_turno !== undefined) {
      const actualizadoSnap = await rutaEncontrada.ref.get();
      const actual = actualizadoSnap.data() || {};
      const mapaActual = actual.unidad_por_turno && typeof actual.unidad_por_turno === 'object'
        ? actual.unidad_por_turno
        : {};
      const turnosValidos = new Set(turnosSolicitados);
      const mapaLimpio = Object.fromEntries(
        Object.entries(mapaActual).filter(([turnoId]) => turnosValidos.has(turnoNormalizado(turnoId) || turnoId)),
      );
      if (Object.keys(mapaLimpio).length !== Object.keys(mapaActual).length) {
        await rutaEncontrada.ref.update({ unidad_por_turno: mapaLimpio });
      }
    }

    const actualizado = await rutaEncontrada.ref.get();

    res.status(200).json({
      success: true,
      message: 'Ruta actualizada correctamente.',
      data: { id: rutaEncontrada.id, ...(actualizado.data() || {}) },
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error('Error actualizando ruta:', error.message);
    }
    res.status(status).json({
      success: false,
      message: status >= 500 ? 'Error interno actualizando la ruta.' : error.message,
    });
  }
});

// ==========================================
// ENDPOINT 1.4: Catálogos (vehículos y turnos)
// ==========================================
app.get('/api/vehiculos', autorizar('unidades:ver'), async (_req, res) => {
  try {
    const snapshot = await db.collection('vehiculos').get();
    const data = snapshot.docs
      .map((doc) => {
        const raw = doc.data() || {};
        return {
          id: doc.id,
          codigo: raw.codigo || null,
          tipo: raw.tipo || null,
          capacidad: raw.capacidad ?? null,
          placas: raw.placas || null,
          ruta_numero: raw.ruta_numero ?? null,
          estado: raw.estado || 'activo',
          es_plantilla: raw.es_plantilla === true || esIdPlantillaUnidad(doc.id),
        };
      })
      .filter((veh) => veh.estado !== 'inactivo')
      .sort((a, b) => {
        const rutaA = Number(a.ruta_numero) || 999;
        const rutaB = Number(b.ruta_numero) || 999;
        if (rutaA !== rutaB) return rutaA - rutaB;
        return String(a.codigo || a.id).localeCompare(String(b.codigo || b.id), 'es');
      });

    res.status(200).json({ success: true, cantidad: data.length, data });
  } catch (error) {
    console.error('Error obteniendo vehículos:', error.message);
    res.status(500).json({ success: false, message: 'Error obteniendo el catálogo de vehículos.' });
  }
});

async function contarRutasActivasConVehiculo(vehiculoId) {
  const snapshot = await db.collection('rutas').where('activa', '==', true).get();
  let total = 0;

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const mapa = data.unidad_por_turno && typeof data.unidad_por_turno === 'object'
      ? data.unidad_por_turno
      : {};

    const enUso = Object.values(mapa).some((unidad) => {
      const id = textoNormalizado(unidad?.vehiculo_id || unidad?.id);
      return id === vehiculoId;
    });

    if (enUso) {
      total += 1;
    }
  });

  return total;
}

app.post('/api/vehiculos/generar-plantilla', autorizar('unidades:crear'), async (_req, res) => {
  try {
    const batch = db.batch();
    PLANTILLA_UNIDADES.forEach((unidad) => {
      const ref = db.collection('vehiculos').doc(unidad.id);
      batch.set(ref, {
        ...unidad,
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await batch.commit();

    res.status(200).json({
      success: true,
      message: `Plantilla ILPEA cargada (${PLANTILLA_UNIDADES.length} unidades).`,
      cantidad: PLANTILLA_UNIDADES.length,
    });
  } catch (error) {
    console.error('Error generando plantilla de unidades:', error.message);
    res.status(500).json({ success: false, message: 'No fue posible cargar la plantilla de unidades.' });
  }
});

app.post('/api/vehiculos', autorizar('unidades:crear'), async (req, res) => {
  try {
    const body = req.body || {};
    const codigo = textoNormalizado(body.codigo).toUpperCase();
    const tipo = normalizarTipoUnidad(body.tipo);
    const capacidad = Number(body.capacidad);
    const rutaNumero = body.ruta_numero != null && body.ruta_numero !== ''
      ? Number(body.ruta_numero)
      : null;

    if (!codigo) {
      return res.status(400).json({
        success: false,
        message: 'Debes indicar el código de la unidad.',
      });
    }

    if (!tipo || !TIPOS_UNIDAD_VALIDOS.has(tipo)) {
      return res.status(400).json({
        success: false,
        message: 'tipo debe ser AUTOBUS, VAN o SPRINTER.',
      });
    }

    if (!Number.isInteger(capacidad) || capacidad <= 0) {
      return res.status(400).json({
        success: false,
        message: 'capacidad debe ser un entero mayor a 0.',
      });
    }

    const vehiculoId = idVehiculoPorCodigo(codigo);
    if (!vehiculoId) {
      return res.status(400).json({
        success: false,
        message: 'No fue posible determinar el identificador de la unidad.',
      });
    }

    const existente = await db.collection('vehiculos').doc(vehiculoId).get();
    if (existente.exists && existente.data()?.estado !== 'inactivo') {
      return res.status(409).json({
        success: false,
        message: `Ya existe una unidad activa con id "${vehiculoId}".`,
      });
    }

    const payload = {
      codigo,
      tipo,
      capacidad,
      placas: textoNormalizado(body.placas) || null,
      ruta_numero: Number.isInteger(rutaNumero) && rutaNumero > 0 ? rutaNumero : null,
      estado: 'activo',
      es_plantilla: esIdPlantillaUnidad(vehiculoId),
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('vehiculos').doc(vehiculoId).set(payload, { merge: true });

    res.status(201).json({
      success: true,
      message: 'Unidad creada correctamente.',
      data: { id: vehiculoId, ...payload },
    });
  } catch (error) {
    console.error('Error creando unidad:', error.message);
    res.status(500).json({ success: false, message: 'No fue posible crear la unidad.' });
  }
});

app.put('/api/vehiculos/:id', autorizar('unidades:actualizar'), async (req, res) => {
  const vehiculoId = textoNormalizado(req.params.id).toLowerCase();

  if (!vehiculoId) {
    return res.status(400).json({
      success: false,
      message: 'Debes indicar el identificador de la unidad.',
    });
  }

  try {
    const ref = db.collection('vehiculos').doc(vehiculoId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Unidad no encontrada.',
      });
    }

    const body = req.body || {};
    const actualizacion = {
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (body.codigo != null) {
      const codigo = textoNormalizado(body.codigo).toUpperCase();
      if (!codigo) {
        return res.status(400).json({ success: false, message: 'El código no puede quedar vacío.' });
      }
      actualizacion.codigo = codigo;
    }

    if (body.tipo != null) {
      const tipo = normalizarTipoUnidad(body.tipo);
      if (!tipo || !TIPOS_UNIDAD_VALIDOS.has(tipo)) {
        return res.status(400).json({ success: false, message: 'tipo debe ser AUTOBUS, VAN o SPRINTER.' });
      }
      actualizacion.tipo = tipo;
    }

    if (body.capacidad != null) {
      const capacidad = Number(body.capacidad);
      if (!Number.isInteger(capacidad) || capacidad <= 0) {
        return res.status(400).json({ success: false, message: 'capacidad debe ser un entero mayor a 0.' });
      }
      actualizacion.capacidad = capacidad;
    }

    if (body.placas != null) {
      actualizacion.placas = textoNormalizado(body.placas) || null;
    }

    if (body.ruta_numero != null) {
      const rutaNumero = Number(body.ruta_numero);
      actualizacion.ruta_numero = Number.isInteger(rutaNumero) && rutaNumero > 0 ? rutaNumero : null;
    }

    if (body.estado != null) {
      const estado = textoNormalizado(body.estado).toLowerCase();
      actualizacion.estado = estado === 'inactivo' ? 'inactivo' : 'activo';
    }

    await ref.update(actualizacion);

    const actualizado = await ref.get();
    const data = actualizado.data() || {};

    res.status(200).json({
      success: true,
      message: 'Unidad actualizada correctamente.',
      data: { id: vehiculoId, ...data },
    });
  } catch (error) {
    console.error('Error actualizando unidad:', error.message);
    res.status(500).json({ success: false, message: 'No fue posible actualizar la unidad.' });
  }
});

app.delete('/api/vehiculos/:id', autorizar('unidades:eliminar'), async (req, res) => {
  const vehiculoId = textoNormalizado(req.params.id).toLowerCase();

  if (!vehiculoId) {
    return res.status(400).json({
      success: false,
      message: 'Debes indicar el identificador de la unidad.',
    });
  }

  try {
    const ref = db.collection('vehiculos').doc(vehiculoId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Unidad no encontrada.',
      });
    }

    const rutasActivas = await contarRutasActivasConVehiculo(vehiculoId);
    if (rutasActivas > 0) {
      return res.status(409).json({
        success: false,
        message: `No se puede deshabilitar: ${rutasActivas} ruta(s) activa(s) usan esta unidad.`,
      });
    }

    await ref.update({
      estado: 'inactivo',
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      success: true,
      message: 'Unidad deshabilitada correctamente.',
      data: { id: vehiculoId, estado: 'inactivo' },
    });
  } catch (error) {
    console.error('Error deshabilitando unidad:', error.message);
    res.status(500).json({ success: false, message: 'No fue posible deshabilitar la unidad.' });
  }
});

app.get('/api/turnos', autorizar('turnos:ver'), async (req, res) => {
  try {
    const incluirInactivos = ['1', 'true', 'si', 'sí'].includes(
      textoNormalizado(req.query.incluir_inactivos).toLowerCase(),
    );

    const snapshot = await db.collection('turnos').get();
    const data = snapshot.docs
      .map((doc) => {
        const raw = doc.data() || {};
        return {
          id: doc.id,
          nombre: raw.nombre || null,
          dia_semana: raw.dia_semana ?? null,
          dia_nombre: raw.dia_nombre || null,
          tipo: raw.tipo || null,
          orden: raw.orden ?? null,
          dias_operacion: Array.isArray(raw.dias_operacion) ? raw.dias_operacion : null,
          hora_inicio: raw.hora_inicio || null,
          hora_fin: raw.hora_fin || null,
          activo: raw.activo !== false,
          deshabilitado_en: raw.deshabilitado_en || null,
          es_plantilla: raw.es_plantilla === true || esIdPlantilla(doc.id),
        };
      })
      .filter((turno) => incluirInactivos || turno.activo !== false)
      .sort((a, b) => {
        if (a.activo !== b.activo) {
          return a.activo === false ? 1 : -1;
        }
        const diaA = Number(a.dia_semana) || 99;
        const diaB = Number(b.dia_semana) || 99;
        if (diaA !== diaB) return diaA - diaB;
        return (Number(a.orden) || 0) - (Number(b.orden) || 0);
      });

    limpiarCacheDiasOperacionTurno();
    data.forEach((turno) => {
      if (turno.activo !== false && Array.isArray(turno.dias_operacion) && turno.dias_operacion.length) {
        registrarDiasOperacionTurno(turno.id, turno.dias_operacion);
      }
    });

    res.status(200).json({ success: true, cantidad: data.length, data });
  } catch (error) {
    console.error('Error obteniendo turnos:', error.message);
    res.status(500).json({ success: false, message: 'Error obteniendo el catálogo de turnos.' });
  }
});

async function contarRutasActivasConTurno(turnoId) {
  const snapshot = await db.collection('rutas').where('activa', '==', true).get();
  let total = 0;
  snapshot.forEach((doc) => {
    const turnos = Array.isArray(doc.data()?.turnos) ? doc.data().turnos : [];
    if (turnos.includes(turnoId)) {
      total += 1;
    }
  });
  return total;
}

app.post('/api/turnos/generar-plantilla', autorizar('turnos:crear'), async (_req, res) => {
  try {
    const batch = db.batch();
    PLANTILLA_TURNOS.forEach((turno) => {
      const ref = db.collection('turnos').doc(turno.id);
      batch.set(ref, {
        ...turno,
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await batch.commit();

    limpiarCacheDiasOperacionTurno();
    PLANTILLA_TURNOS.forEach((turno) => {
      registrarDiasOperacionTurno(turno.id, turno.dias_operacion);
    });

    res.status(200).json({
      success: true,
      message: `Plantilla semanal generada (${PLANTILLA_TURNOS.length} turnos).`,
      cantidad: PLANTILLA_TURNOS.length,
    });
  } catch (error) {
    console.error('Error generando plantilla de turnos:', error.message);
    res.status(500).json({ success: false, message: 'No fue posible generar la plantilla de turnos.' });
  }
});

app.post('/api/turnos', autorizar('turnos:crear'), async (req, res) => {
  try {
    const body = req.body || {};
    const diaSemana = Number(body.dia_semana);
    const tipo = normalizarTipoTurno(body.tipo);
    const nombre = textoNormalizado(body.nombre);

    if (!Number.isInteger(diaSemana) || diaSemana < 1 || diaSemana > 7) {
      return res.status(400).json({
        success: false,
        message: 'dia_semana debe ser un entero entre 1 (Lunes) y 7 (Domingo).',
      });
    }

    if (!tipo || !TIPOS_VALIDOS.has(tipo)) {
      return res.status(400).json({
        success: false,
        message: 'tipo debe ser 1er, 2do, mixto o 3er.',
      });
    }

    if (diaSemana >= 6 && tipo === 'mixto') {
      return res.status(400).json({
        success: false,
        message: 'El turno Mixto solo aplica de Lunes a Viernes.',
      });
    }

    if (!nombre) {
      return res.status(400).json({
        success: false,
        message: 'Debes indicar el nombre del turno.',
      });
    }

    const diaInfo = DIAS_SEMANA.find((d) => d.dia_semana === diaSemana);
    let turnoId = null;
    if (diaInfo) {
      turnoId = `${diaInfo.prefijo}_${tipo}`;
    }

    if (!turnoId) {
      return res.status(400).json({
        success: false,
        message: 'No fue posible determinar el identificador del turno.',
      });
    }

    const existente = await db.collection('turnos').doc(turnoId).get();
    const existiaInactivo = existente.exists && existente.data()?.activo === false;

    if (existente.exists && existente.data()?.activo !== false) {
      return res.status(409).json({
        success: false,
        message: `Ya existe un turno activo con id "${turnoId}".`,
      });
    }

    const payload = {
      nombre,
      dia_semana: diaSemana,
      dia_nombre: diaInfo?.dia_nombre || null,
      tipo,
      orden: Number.isFinite(Number(body.orden)) ? Number(body.orden) : 99,
      dias_operacion: [diaSemana],
      hora_inicio: textoNormalizado(body.hora_inicio) || null,
      hora_fin: textoNormalizado(body.hora_fin) || null,
      activo: true,
      deshabilitado_en: admin.firestore.FieldValue.delete(),
      deshabilitado_por: admin.firestore.FieldValue.delete(),
      es_plantilla: esIdPlantilla(turnoId),
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('turnos').doc(turnoId).set(payload, { merge: true });
    registrarDiasOperacionTurno(turnoId, payload.dias_operacion);

    res.status(201).json({
      success: true,
      message: existiaInactivo
        ? 'Turno rehabilitado correctamente.'
        : 'Turno creado correctamente.',
      data: { id: turnoId, ...payload },
    });
  } catch (error) {
    console.error('Error creando turno:', error.message);
    res.status(500).json({ success: false, message: 'No fue posible crear el turno.' });
  }
});

app.put('/api/turnos/:id', autorizar('turnos:actualizar'), async (req, res) => {
  const turnoId = textoNormalizado(req.params.id).toLowerCase();

  if (!turnoId) {
    return res.status(400).json({
      success: false,
      message: 'Debes indicar el identificador del turno.',
    });
  }

  try {
    const ref = db.collection('turnos').doc(turnoId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Turno no encontrado.',
      });
    }

    const body = req.body || {};
    const actualizacion = {
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (body.nombre != null) {
      const nombre = textoNormalizado(body.nombre);
      if (!nombre) {
        return res.status(400).json({ success: false, message: 'El nombre no puede quedar vacío.' });
      }
      actualizacion.nombre = nombre;
    }

    if (body.hora_inicio != null) {
      actualizacion.hora_inicio = textoNormalizado(body.hora_inicio) || null;
    }

    if (body.hora_fin != null) {
      actualizacion.hora_fin = textoNormalizado(body.hora_fin) || null;
    }

    if (body.orden != null && Number.isFinite(Number(body.orden))) {
      actualizacion.orden = Number(body.orden);
    }

    if (body.activo != null) {
      const activo = body.activo !== false;
      actualizacion.activo = activo;
      if (activo) {
        actualizacion.deshabilitado_en = admin.firestore.FieldValue.delete();
        actualizacion.deshabilitado_por = admin.firestore.FieldValue.delete();
      } else {
        actualizacion.deshabilitado_en = admin.firestore.FieldValue.serverTimestamp();
        actualizacion.deshabilitado_por = req.usuario?.uid || null;
      }
    }

    await ref.update(actualizacion);

    const actualizado = await ref.get();
    const data = actualizado.data() || {};
    if (data.activo !== false && Array.isArray(data.dias_operacion) && data.dias_operacion.length) {
      registrarDiasOperacionTurno(turnoId, data.dias_operacion);
    } else if (data.activo === false) {
      limpiarCacheDiasOperacionTurno();
    }

    res.status(200).json({
      success: true,
      message: 'Turno actualizado correctamente.',
      data: { id: turnoId, ...data },
    });
  } catch (error) {
    console.error('Error actualizando turno:', error.message);
    res.status(500).json({ success: false, message: 'No fue posible actualizar el turno.' });
  }
});

app.delete('/api/turnos/:id', autorizar('turnos:eliminar'), async (req, res) => {
  const turnoId = textoNormalizado(req.params.id).toLowerCase();

  if (!turnoId) {
    return res.status(400).json({
      success: false,
      message: 'Debes indicar el identificador del turno.',
    });
  }

  try {
    const ref = db.collection('turnos').doc(turnoId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Turno no encontrado.',
      });
    }

    const turnoData = doc.data() || {};
    if (turnoData.activo === false) {
      return res.status(200).json({
        success: true,
        message: 'El turno ya estaba deshabilitado.',
        data: { id: turnoId, activo: false },
      });
    }

    const rutasActivas = await contarRutasActivasConTurno(turnoId);
    if (rutasActivas > 0) {
      return res.status(409).json({
        success: false,
        message: `No se puede deshabilitar: ${rutasActivas} ruta(s) activa(s) usan este turno.`,
      });
    }

    await ref.update({
      activo: false,
      deshabilitado_en: admin.firestore.FieldValue.serverTimestamp(),
      deshabilitado_por: req.usuario?.uid || null,
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    });

    limpiarCacheDiasOperacionTurno();

    res.status(200).json({
      success: true,
      message: 'Turno deshabilitado correctamente. Puedes volver a habilitarlo cuando lo necesites.',
      data: { id: turnoId, activo: false },
    });
  } catch (error) {
    console.error('Error deshabilitando turno:', error.message);
    res.status(500).json({ success: false, message: 'No fue posible deshabilitar el turno.' });
  }
});

app.delete('/api/rutas/:id', autorizar('rutas:eliminar'), async (req, res) => {
  const idRuta = textoNormalizado(req.params.id);

  if (!idRuta) {
    return res.status(400).json({
      success: false,
      message: 'Debes indicar el identificador de la ruta.',
    });
  }

  try {
    const bloqueo = await obtenerBloqueoEliminacionRuta(idRuta);

    if (!bloqueo.ruta.activa) {
      return res.status(409).json({
        success: false,
        message: 'La ruta ya está deshabilitada.',
      });
    }

    if (!bloqueo.puede_eliminar) {
      return res.status(409).json({
        success: false,
        message: `No se puede deshabilitar la ruta: tiene ${bloqueo.total_pasajeros} pasajero(s) asignados desde hoy en adelante. Reasígnalos antes de continuar.`,
        empleados_a_reasignar: bloqueo.empleados_a_reasignar,
      });
    }

    const rutaEncontrada = await resolverRutaPorIdentificador(idRuta);
    await rutaEncontrada.ref.update({
      activa: false,
      eliminada_en: new Date(),
      eliminada_por: req.usuario?.uid || null,
      actualizado_en: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Ruta deshabilitada correctamente. Puedes habilitarla nuevamente cuando la necesites.',
      data: {
        id: rutaEncontrada.id,
        activa: false,
      },
    });
  } catch (error) {
    const status = error.status || 500;
    const message = error.message || 'Error deshabilitando la ruta.';

    if (status >= 500) {
      console.error('Error deshabilitando ruta:', message);
    }

    res.status(status).json({
      success: false,
      message: status >= 500 ? 'Error interno deshabilitando la ruta.' : message,
    });
  }
});

app.post('/api/rutas/:id/restaurar', autorizar('rutas:eliminar'), async (req, res) => {
  const idRuta = textoNormalizado(req.params.id);

  if (!idRuta) {
    return res.status(400).json({
      success: false,
      message: 'Debes indicar el identificador de la ruta.',
    });
  }

  try {
    const rutaEncontrada = await resolverRutaPorIdentificador(idRuta);
    if (!rutaEncontrada) {
      return res.status(404).json({
        success: false,
        message: 'La ruta no existe.',
      });
    }

    if (esRutaActiva(rutaEncontrada.data)) {
      return res.status(409).json({
        success: false,
        message: 'La ruta ya está activa.',
      });
    }

    await rutaEncontrada.ref.update({
      activa: true,
      restaurada_en: new Date(),
      restaurada_por: req.usuario?.uid || null,
      actualizado_en: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Ruta habilitada correctamente.',
      data: {
        id: rutaEncontrada.id,
        activa: true,
      },
    });
  } catch (error) {
    console.error('Error restaurando ruta:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error habilitando la ruta.',
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
      // Formato nuevo (mapa `pasajeros`) con fallback al legado.
      const pasajeros = extraerPasajerosProgramacion(data);

      if (!pasajeros.ids.includes(idEmpleado)) {
        continue;
      }

      const asientoDetalle = Number(pasajeros.detalle[idEmpleado]?.asiento);
      if (Number.isInteger(asientoDetalle) && asientoDetalle > 0) {
        asientoAsignado = asientoDetalle;
      } else {
        const pasajerosIds = Array.isArray(data.pasajeros_ids) ? data.pasajeros_ids : [];
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
    const capacidadLimite = Number(programacionEncontrada.data.capacidad_limite)
      || Number(programacionEncontrada.data.vehiculo?.capacidad)
      || Number(rutaData.capacidad_real)
      || 0;
    const asientosOcupadosDato = Number(programacionEncontrada.data.asientos_ocupados);
    const pasajerosProgramacion = extraerPasajerosProgramacion(programacionEncontrada.data);
    const asientosOcupados = Number.isFinite(asientosOcupadosDato)
      ? asientosOcupadosDato
      : Math.max(pasajerosProgramacion.total, pasajerosProgramacion.asientosReservados.length);
    const abordajeSnapshot = await db
      .collection('programacion_diaria')
      .doc(programacionEncontrada.id)
      .collection('abordajes')
      .doc(idEmpleado)
      .get();
    const abordajeData = abordajeSnapshot.exists ? (abordajeSnapshot.data() || {}) : null;
    let camioneroAsignado = programacionEncontrada.data.camionero || rutaData.camionero || null;
    const turnoProg = turnoNormalizado(
      programacionEncontrada.data.turno_id || programacionEncontrada.data.turno
    );
    if (!camioneroAsignado) {
      const vehiculoId = textoNormalizado(programacionEncontrada.data.vehiculo?.id);
      if (vehiculoId && turnoProg) {
        const vehiculoDoc = await db.collection('vehiculos').doc(vehiculoId).get();
        if (vehiculoDoc.exists) {
          const mapaCamioneros = vehiculoDoc.data()?.camionero_por_turno || {};
          camioneroAsignado = mapaCamioneros[turnoProg] || null;
        }
      }
    }

    let horario_turno = null;
    if (turnoProg) {
      const turnosSnapshot = await db.collection('turnos').where('nombre', '==', turnoProg).limit(1).get();
      if (!turnosSnapshot.empty) {
        const tData = turnosSnapshot.docs[0].data();
        if (tData.hora_inicio && tData.hora_fin) {
          horario_turno = `${tData.hora_inicio} - ${tData.hora_fin}`;
        } else if (tData.hora_inicio) {
          horario_turno = tData.hora_inicio;
        }
      } else {
        const turnoPorId = await db.collection('turnos').doc(turnoProg).get();
        if (turnoPorId.exists) {
          const tData = turnoPorId.data();
          if (tData.hora_inicio && tData.hora_fin) {
            horario_turno = `${tData.hora_inicio} - ${tData.hora_fin}`;
          } else if (tData.hora_inicio) {
            horario_turno = tData.hora_inicio;
          }
        }
      }
    }

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
        horario: horario_turno,
        'tipo de unidad': String(rutaData['tipo de unidad'] || 'N/D'),
        capacidad_real: Number(rutaData.capacidad_real) || capacidadLimite,
        max_pasajeros_dia: Number(rutaData.max_pasajeros_dia) || 0,
        porcentaje_ocupacion_max: Number(rutaData.porcentaje_ocupacion_max) || 0,
        alerta_ocupacion: String(rutaData.alerta_ocupacion || 'N/D'),
        sugerencia_right_sizing: String(rutaData.sugerencia_right_sizing || 'Sin sugerencia'),
        id_empleado: idEmpleado,
        asiento_asignado: asientoAsignado,
        id_ruta: idRuta,
        id_programacion: programacionEncontrada.id,
        asientos_ocupados: asientosOcupados,
        capacidad_limite: capacidadLimite,
        asientos_disponibles: Math.max(capacidadLimite - asientosOcupados, 0),
        abordo: abordajeData?.abordo === true,
        hora_abordaje: abordajeData?.hora_abordaje || null,
        camionero_asignado: camioneroAsignado ? {
          uid: camioneroAsignado.uid || null,
          id_camionero: camioneroAsignado.id_camionero || null,
          nombre: camioneroAsignado.nombre || null,
        } : null,
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

app.get('/api/empleado/qr-asistencia', autorizar('asignacion:ver'), async (req, res) => {
  if (req.usuario?.rol !== ROLES.EMPLEADO) {
    return res.status(403).json({
      success: false,
      message: 'Este endpoint solo está disponible para usuarios con rol EMPLEADO.',
    });
  }

  try {
    const fecha = textoNormalizado(req.query.fecha) || new Date().toISOString().slice(0, 10);
    const turno = turnoNormalizado(req.query.turno) || null;
    const idEmpleado = textoNormalizado(req.usuario?.id_empleado) || construirIdEmpleadoDesdeUid(req.usuario?.uid);
    const exp = Math.floor(Date.now() / 1000) + Math.max(QR_TOKEN_TTL_SECONDS, 60);

    const payload = {
      v: 1,
      id_empleado: idEmpleado,
      uid: req.usuario.uid,
      fecha,
      turno,
      exp,
    };

    return res.json({
      success: true,
      data: {
        ...payload,
        token: crearTokenQrAsistencia(payload),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'No se pudo generar el QR de asistencia.',
    });
  }
});

// ENDPOINT PÚBLICO para registrar asistencia al escanear el QR
app.get('/api/asistencia/escanear-qr-publico', async (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).send(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif; text-align:center; padding: 2rem; background: #fef2f2; color: #991b1b;">
        <h1>Error</h1><p>Token no proporcionado.</p>
      </body></html>
    `);
  }

  try {
    const payload = verificarTokenQrAsistencia(token);
    
    let query = db.collection('programacion_diaria').where('fecha', '==', payload.fecha);
    if (payload.turno) {
      query = query.where('turno', '==', payload.turno);
    }

    const snapshot = await query.get();
    let programacionEncontrada = null;
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      const pasajeros = extraerPasajerosProgramacion(data);
      if (pasajeros.ids.includes(payload.id_empleado)) {
        programacionEncontrada = doc;
        break;
      }
    }

    if (!programacionEncontrada) {
      return res.status(404).send(`
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; text-align:center; padding: 2rem; background: #fffbeb; color: #92400e;">
          <h1>Viaje no encontrado</h1><p>No se encontró un viaje programado para ti en esta fecha/turno.</p>
        </body></html>
      `);
    }

    const abordajeRef = programacionEncontrada.ref.collection('abordajes').doc(payload.id_empleado);
    const abordajeSnap = await abordajeRef.get();
    
    if (abordajeSnap.exists && abordajeSnap.data().abordo) {
       return res.status(200).send(`
         <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
         <body style="font-family:sans-serif; text-align:center; padding: 2rem; background: #f0fdf4; color: #166534;">
           <h1>Ya estás a bordo</h1><p>Tu asistencia ya había sido registrada anteriormente.</p>
           <p style="font-size:3rem; margin:1rem 0;">✅</p>
         </body></html>
       `);
    }

    await abordajeRef.set({
      abordo: true,
      hora_abordaje: new Date().toISOString(),
      empleado_uid: payload.uid,
      metodo: 'qr_scanner_generico'
    }, { merge: true });

    return res.status(200).send(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif; text-align:center; padding: 2rem; background: #f0fdf4; color: #166534;">
        <h1>¡Asistencia Registrada!</h1><p>Has sido marcado a bordo exitosamente.</p>
        <p style="font-size:4rem; margin:1rem 0;">🚌</p>
      </body></html>
    `);

  } catch (error) {
    return res.status(400).send(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif; text-align:center; padding: 2rem; background: #fef2f2; color: #991b1b;">
        <h1>Error al registrar</h1><p>${error.message}</p>
      </body></html>
    `);
  }
});

app.get('/api/camionero/mi-asignacion', autorizar('abordajes:ver'), async (req, res) => {
  if (req.usuario?.rol !== ROLES.CAMIONERO) {
    return res.status(403).json({
      success: false,
      message: 'Este endpoint solo está disponible para usuarios con rol CAMIONERO.',
    });
  }

  try {
    const asignacion = normalizarAsignacionUnidadTurno(req.usuario?.asignacion_unidad_turno);
    if (!asignacion) {
      return res.json({
        success: true,
        data: null,
      });
    }

    return res.json({
      success: true,
      data: asignacion,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'No se pudo obtener la asignación del camionero.',
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

    if (!esRutaActiva(rutaEncontrada.data)) {
      return res.status(409).json({
        success: false,
        message: 'La ruta seleccionada está deshabilitada. Habilítala antes de asignar pasajeros.'
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

      // NUEVA VALIDACIÓN: Evitar que sea asignado a otra ruta o turno el mismo día.
      // Se consulta por fecha y se verifica membresía en memoria (compatible con
      // el formato nuevo `pasajeros{}` aun después de retirar pasajeros_ids).
      const asignacionesDelDiaQuery = db.collection('programacion_diaria')
        .where('fecha', '==', fechaAsignacion);

      const asignacionesDelDia = await leerQuery(asignacionesDelDiaQuery, t);
      const yaAsignadoHoy = asignacionesDelDia.docs.some((docDia) => {
        const pasajerosDia = extraerPasajerosProgramacion(docDia.data() || {});
        return pasajerosDia.ids.includes(idEmpleado);
      });

      if (yaAsignadoHoy) {
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
        t.set(programacionRef, limpiarCamposLegados(data), { merge: true });
      }

      if (esProgramacionCancelada(data)) {
        throw new Error('ROUTE_CANCELLED: La programación de esta ruta está cancelada para la fecha/turno seleccionado.');
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

      // Dual-write: mapa nuevo `pasajeros` con nombre desnormalizado + campos legados.
      const pasajerosDetalle = normalizarPasajerosDetalle(data.pasajeros);
      const paradaDefault = empleadoData.parada_default && typeof empleadoData.parada_default === 'object'
        ? empleadoData.parada_default
        : null;

      t.set(programacionRef, limpiarCamposLegados({
        fecha: fechaAsignacion,
        turno: turnoAsignacion || data.turno || null,
        turno_id: turnoAsignacion || data.turno_id || data.turno || null,
        id_ruta: rutaEncontrada.id,
        ruta_numero: Number(rutaEncontrada.data.ruta) || data.ruta_numero || null,
        estado: 'activa',
        asientos_ocupados: asientosOcupados + 1,
        pasajeros_ids: nuevosPasajeros,
        asientos_reservados: nuevosAsientosReservados,
        asientos_por_empleado: {
          ...asientosPorEmpleado,
          [idEmpleado]: asientoAsignado
        },
        pasajeros: {
          ...pasajerosDetalle,
          [idEmpleado]: {
            nombre: textoNormalizado(empleadoData.nombre) || idEmpleado,
            asiento: asientoAsignado,
            parada_id: paradaDefault?.id || null,
            parada_orden: null
          }
        },
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }), { merge: true });
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
      || mensaje.startsWith('ROUTE_CANCELLED')
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

      t.set(programacion.docRef, limpiarCamposLegados({
        pasajeros_ids: nuevosPasajeros,
        asientos_reservados: nuevosAsientosReservados,
        asientos_por_empleado: nuevosAsientosPorEmpleado,
        // Retirar también del mapa nuevo `pasajeros` (merge requiere marcador delete).
        pasajeros: {
          [idEmpleado]: admin.firestore.FieldValue.delete()
        },
        asientos_ocupados: nuevosAsientosOcupados,
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }), { merge: true });

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

app.post('/api/programacion/cancelar', autorizar('rutas:actualizar'), async (req, res) => {
  const {
    id_ruta,
    ruta_origen_id,
    ruta_destino_id,
    fecha,
    turno,
    motivo
  } = req.body || {};

  const idRutaOrigen = textoNormalizado(ruta_origen_id || id_ruta);
  const idRutaDestino = textoNormalizado(ruta_destino_id);
  const fechaOperacion = textoNormalizado(fecha);
  const turnoOperacion = turnoNormalizado(turno);
  const motivoCancelacion = textoNormalizado(motivo) || 'Cancelacion operativa por bajo aforo.';

  if (!idRutaOrigen || !fechaOperacion) {
    return res.status(400).json({
      success: false,
      message: 'id_ruta/ruta_origen_id y fecha son requeridos.'
    });
  }

  if (idRutaDestino && idRutaOrigen === idRutaDestino) {
    return res.status(400).json({
      success: false,
      message: 'La ruta origen y destino deben ser diferentes.'
    });
  }

  try {
    const rutaOrigen = await resolverRutaPorIdentificador(idRutaOrigen);
    if (!rutaOrigen) {
      return res.status(404).json({
        success: false,
        message: 'La ruta origen no existe.'
      });
    }

    const rutaDestino = idRutaDestino
      ? await resolverRutaPorIdentificador(idRutaDestino)
      : null;

    if (idRutaDestino && !rutaDestino) {
      return res.status(404).json({
        success: false,
        message: 'La ruta destino no existe.'
      });
    }

    let resultado = null;

    await db.runTransaction(async (t) => {
      const programacionOrigen = await resolverProgramacion(fechaOperacion, rutaOrigen.id, turnoOperacion, t);
      let dataOrigen = programacionOrigen.data;

      if (!dataOrigen) {
        dataOrigen = construirProgramacionBase({
          fecha: fechaOperacion,
          idRuta: rutaOrigen.id,
          turno: turnoOperacion,
          rutaData: rutaOrigen.data,
          uidCreador: req.usuario.uid
        });
      }

      const pasajerosOrigen = [...new Set(
        (Array.isArray(dataOrigen.pasajeros_ids) ? dataOrigen.pasajeros_ids : [])
          .map((id) => textoNormalizado(id))
          .filter(Boolean)
      )];
      const asientosOrigen = normalizarAsientosReservados(dataOrigen.asientos_reservados);
      const asientosPorEmpleadoOrigen = normalizarAsientosPorEmpleado(dataOrigen.asientos_por_empleado);
      const detalleOrigen = extraerPasajerosProgramacion(dataOrigen).detalle;
      const detalleReasignacion = [];

      if (pasajerosOrigen.length && !rutaDestino) {
        throw new Error('TARGET_ROUTE_REQUIRED: La ruta tiene pasajeros y requiere ruta destino para reasignacion.');
      }

      if (rutaDestino) {
        const programacionDestino = await resolverProgramacion(fechaOperacion, rutaDestino.id, turnoOperacion, t);
        let dataDestino = programacionDestino.data;

        if (!dataDestino) {
          dataDestino = construirProgramacionBase({
            fecha: fechaOperacion,
            idRuta: rutaDestino.id,
            turno: turnoOperacion,
            rutaData: rutaDestino.data,
            uidCreador: req.usuario.uid
          });
          t.set(programacionDestino.docRef, limpiarCamposLegados(dataDestino), { merge: true });
        }

        if (esProgramacionCancelada(dataDestino)) {
          throw new Error('TARGET_ROUTE_CANCELLED: La ruta destino esta cancelada para esa fecha/turno.');
        }

        const pasajerosDestino = [...new Set(
          (Array.isArray(dataDestino.pasajeros_ids) ? dataDestino.pasajeros_ids : [])
            .map((id) => textoNormalizado(id))
            .filter(Boolean)
        )];
        const asientosDestino = normalizarAsientosReservados(dataDestino.asientos_reservados);
        const asientosPorEmpleadoDestino = normalizarAsientosPorEmpleado(dataDestino.asientos_por_empleado);

        const duplicadosDestino = pasajerosOrigen.filter((idEmpleado) => pasajerosDestino.includes(idEmpleado));
        if (duplicadosDestino.length) {
          throw new Error(`DUPLICATE_TARGET_ASSIGNMENT: Ya asignados en destino: ${duplicadosDestino.join(', ')}`);
        }

        const capacidadDestino = Number(dataDestino.capacidad_limite) || Number(rutaDestino.data.capacidad_real) || 12;
        const ocupacionDestinoActual = Math.max(pasajerosDestino.length, asientosDestino.length);
        if (ocupacionDestinoActual + pasajerosOrigen.length > capacidadDestino) {
          throw new Error('TARGET_CAPACITY_EXCEEDED: La ruta destino no tiene capacidad para recibir a todos los pasajeros.');
        }

        const asientosDestinoSet = asientosOcupadosComoSet(asientosDestino, asientosPorEmpleadoDestino);
        const pasajerosDestinoFinal = [...pasajerosDestino];
        const asientosDestinoFinal = [...asientosDestino];
        const mapaDestinoFinal = { ...asientosPorEmpleadoDestino };
        const detalleDestinoFinal = extraerPasajerosProgramacion(dataDestino).detalle;

        pasajerosOrigen.forEach((idEmpleado) => {
          const asientoOrigen = Number(asientosPorEmpleadoOrigen[idEmpleado]);
          const asientoDestino = Number.isInteger(asientoOrigen)
            && asientoOrigen > 0
            && asientoOrigen <= capacidadDestino
            && !asientosDestinoSet.has(asientoOrigen)
            ? asientoOrigen
            : siguienteAsientoDisponible(asientosDestinoSet, capacidadDestino);

          asientosDestinoSet.add(asientoDestino);
          pasajerosDestinoFinal.push(idEmpleado);
          asientosDestinoFinal.push(asientoDestino);
          mapaDestinoFinal[idEmpleado] = asientoDestino;
          detalleDestinoFinal[idEmpleado] = {
            ...(detalleOrigen[idEmpleado] || { nombre: idEmpleado, parada_id: null, parada_orden: null }),
            asiento: asientoDestino
          };
          detalleReasignacion.push({
            id_empleado: idEmpleado,
            asiento_origen: Number.isInteger(asientoOrigen) ? asientoOrigen : null,
            asiento_destino: asientoDestino
          });
        });

        t.set(programacionDestino.docRef, limpiarCamposLegados({
          fecha: fechaOperacion,
          turno: turnoOperacion || dataDestino.turno || null,
          id_ruta: rutaDestino.id,
          estado: 'activa',
          pasajeros_ids: pasajerosDestinoFinal,
          asientos_reservados: normalizarAsientosReservados(asientosDestinoFinal),
          asientos_por_empleado: mapaDestinoFinal,
          pasajeros: detalleDestinoFinal,
          asientos_ocupados: Math.max(pasajerosDestinoFinal.length, asientosDestinoFinal.length),
          actualizado_en: new Date(),
          actualizado_por: req.usuario.uid
        }), { merge: true });
      }

      t.set(programacionOrigen.docRef, limpiarCamposLegados({
        fecha: fechaOperacion,
        turno: turnoOperacion || dataOrigen.turno || null,
        id_ruta: rutaOrigen.id,
        estado: 'cancelada',
        pasajeros_ids: [],
        asientos_reservados: [],
        asientos_por_empleado: {},
        pasajeros: construirMapaPasajerosMerge({}, dataOrigen),
        asientos_ocupados: 0,
        motivo_cancelacion: motivoCancelacion,
        cancelada_en: new Date(),
        cancelada_por: req.usuario.uid,
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }), { merge: true });

      resultado = {
        id_ruta: rutaOrigen.id,
        ruta_destino_id: rutaDestino?.id || null,
        fecha: fechaOperacion,
        turno: turnoOperacion || null,
        estado: 'cancelada',
        empleados_reasignados: detalleReasignacion.length,
        detalle_reasignacion: detalleReasignacion
      };
    });

    res.status(200).json({
      success: true,
      message: 'Programacion cancelada correctamente.',
      data: resultado
    });
  } catch (error) {
    const mensaje = String(error?.message || 'No fue posible cancelar la programacion.');
    const status = mensaje.startsWith('TARGET_ROUTE_REQUIRED')
      || mensaje.startsWith('TARGET_CAPACITY_EXCEEDED')
      || mensaje.startsWith('DUPLICATE_TARGET_ASSIGNMENT')
      || mensaje.startsWith('TARGET_ROUTE_CANCELLED')
      ? 409
      : 400;

    res.status(status).json({ success: false, message: mensaje });
  }
});

app.patch('/api/programacion/unidad', autorizar('rutas:actualizar'), async (req, res) => {
  const {
    id_ruta,
    ruta_id,
    fecha,
    turno,
    tipo_unidad,
    capacidad_limite,
    codigo_unidad,
    motivo
  } = req.body || {};

  const idRuta = textoNormalizado(id_ruta || ruta_id);
  const fechaOperacion = textoNormalizado(fecha);
  const turnoOperacion = turnoNormalizado(turno);
  const tipoUnidad = textoNormalizado(tipo_unidad);
  const codigoUnidad = textoNormalizado(codigo_unidad);
  const capacidadNueva = Number(capacidad_limite);

  if (!idRuta || !fechaOperacion || !tipoUnidad || !Number.isInteger(capacidadNueva) || capacidadNueva <= 0) {
    return res.status(400).json({
      success: false,
      message: 'id_ruta, fecha, tipo_unidad y capacidad_limite valida son requeridos.'
    });
  }

  try {
    const rutaEncontrada = await resolverRutaPorIdentificador(idRuta);
    if (!rutaEncontrada) {
      return res.status(404).json({
        success: false,
        message: 'La ruta seleccionada no existe.'
      });
    }

    let resultado = null;

    await db.runTransaction(async (t) => {
      const programacion = await resolverProgramacion(fechaOperacion, rutaEncontrada.id, turnoOperacion, t);
      let data = programacion.data;

      if (!data) {
        data = construirProgramacionBase({
          fecha: fechaOperacion,
          idRuta: rutaEncontrada.id,
          turno: turnoOperacion,
          rutaData: rutaEncontrada.data,
          uidCreador: req.usuario.uid
        });
        t.set(programacion.docRef, limpiarCamposLegados(data), { merge: true });
      }

      if (esProgramacionCancelada(data)) {
        throw new Error('ROUTE_CANCELLED: No se puede cambiar la unidad de una programacion cancelada.');
      }

      const pasajerosActuales = Array.isArray(data.pasajeros_ids) ? data.pasajeros_ids : [];
      const asientosReservados = normalizarAsientosReservados(data.asientos_reservados);
      const asientosOcupadosDato = Number(data.asientos_ocupados);
      const ocupacionActual = Number.isFinite(asientosOcupadosDato)
        ? asientosOcupadosDato
        : Math.max(pasajerosActuales.length, asientosReservados.length);

      if (capacidadNueva < ocupacionActual) {
        throw new Error('UNIT_CAPACITY_TOO_SMALL: La nueva unidad no tiene capacidad para los pasajeros actuales.');
      }

      const asientosFueraRango = asientosReservados.filter((asiento) => asiento > capacidadNueva);
      if (asientosFueraRango.length) {
        throw new Error(`SEAT_OUT_OF_RANGE: Hay asientos ocupados fuera de la nueva capacidad: ${asientosFueraRango.join(', ')}`);
      }

      // Dual-write: snapshot nuevo `vehiculo` + campos legados tipo_unidad/codigo_unidad.
      const vehiculoSnapshot = construirVehiculoSnapshot(rutaEncontrada.data, {
        tipo: tipoUnidad,
        codigo: codigoUnidad || data.codigo_unidad || rutaEncontrada.data.codigo_unidad || null,
        capacidad: capacidadNueva
      });

      t.set(programacion.docRef, {
        fecha: fechaOperacion,
        turno: turnoOperacion || data.turno || null,
        id_ruta: rutaEncontrada.id,
        estado: 'activa',
        tipo_unidad: tipoUnidad,
        capacidad_limite: capacidadNueva,
        codigo_unidad: codigoUnidad || data.codigo_unidad || rutaEncontrada.data.codigo_unidad || null,
        vehiculo: vehiculoSnapshot,
        motivo_cambio_unidad: textoNormalizado(motivo) || null,
        unidad_actualizada_en: new Date(),
        unidad_actualizada_por: req.usuario.uid,
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }, { merge: true });

      resultado = {
        id_ruta: rutaEncontrada.id,
        fecha: fechaOperacion,
        turno: turnoOperacion || null,
        estado: 'activa',
        tipo_unidad: tipoUnidad,
        capacidad_limite: capacidadNueva,
        codigo_unidad: codigoUnidad || null,
        asientos_ocupados: ocupacionActual,
        asientos_disponibles: Math.max(capacidadNueva - ocupacionActual, 0)
      };
    });

    res.status(200).json({
      success: true,
      message: 'Unidad actualizada correctamente.',
      data: resultado
    });
  } catch (error) {
    const mensaje = String(error?.message || 'No fue posible actualizar la unidad.');
    const status = mensaje.startsWith('UNIT_CAPACITY_TOO_SMALL')
      || mensaje.startsWith('SEAT_OUT_OF_RANGE')
      || mensaje.startsWith('ROUTE_CANCELLED')
      ? 409
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
    const fechaConsulta = textoNormalizado(req.query.fecha) || fechaISOHoy();
    const turnoConsulta = turnoNormalizado(req.query.turno);
    rutas = await construirListaRutasOperativas(fechaConsulta, turnoConsulta);

    const rutasOptimizadas = rutas.map((r) => ({
      ruta_id: r.id,
      nombre: r.zona || r.nombre || `Ruta ${r.ruta}`,
      ocupacion_pct: r.ocupacion_pct ?? r.porcentaje_ocupacion_max,
      pasajeros: r.asientos_ocupados ?? r.max_pasajeros_dia,
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
      1. Si la ruta no conviene operarla por ocupación < 40% Y tiene pasajeros reales asignados (pasajeros > 0) Y está realmente programada ese día (fuente_datos = "programacion_diaria"), usa tipo_accion "cancelar_reasignar". NUNCA sugiereas cancelar una ruta sin programación o sin pasajeros.
      2. Si la ruta si conviene operarla pero el vehículo está sobredimensionado, usa tipo_accion "cambiar_unidad".
      3. Prioridad ALTA: cancelar y reasignar por ocupación < 40% (solo con pasajeros reales).
      4. Prioridad MEDIA: autobuses con <= 12 pasajeros para cambiar a Van.
      5. Considera contexto de las ultimas 4 semanas y decisiones recientes del administrador.
      6. Si no hay rutas programadas con pasajeros reales, devuelve insights vacíos ([]).
      
      SALIDA ESTRICTA: Devuelve UNICAMENTE un objeto JSON con propiedad "insights".
      Cada insight debe incluir: "recomendacion_id", "titulo", "descripcion", "prioridad" (alta/media/baja), "ruta_id", "tipo_accion" ("cancelar_reasignar" o "cambiar_unidad"), "prob_cancelacion" (0 a 1 o null), "ruta_alternativa_sugerida" (string o null), "tipo_unidad_sugerida" (string o null), "capacidad_sugerida" (numero o null), "codigo_unidad_sugerido" (string o null).
      Para tipo_accion "cambiar_unidad", llena tipo_unidad_sugerida y capacidad_sugerida.
      Para tipo_accion "cancelar_reasignar", llena ruta_alternativa_sugerida si hay una ruta viable.
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
    motivo,
    cancelar_origen
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

        t.set(programacionDestino.docRef, limpiarCamposLegados(dataDestino), { merge: true });
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
      // Dual-write: mantener también los mapas nuevos `pasajeros` de origen/destino.
      const detalleOrigenFinal = extraerPasajerosProgramacion(dataOrigen).detalle;
      const detalleDestinoFinal = extraerPasajerosProgramacion(dataDestino).detalle;
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
        detalleDestinoFinal[idEmpleado] = {
          ...(detalleOrigenFinal[idEmpleado] || { nombre: idEmpleado, parada_id: null, parada_orden: null }),
          asiento: asientoDestinoAsignado
        };
        delete detalleOrigenFinal[idEmpleado];

        detalleReasignacion.push({
          id_empleado: idEmpleado,
          asiento_origen: Number.isInteger(asientoOrigen) ? asientoOrigen : null,
          asiento_destino: asientoDestinoAsignado
        });
      });

      const asientosOrigenFinal = asientosOrigen.filter((asiento) => !asientosRemoverOrigen.has(asiento));
      const debeCancelarOrigen = cancelar_origen === true;

      if (debeCancelarOrigen && pasajerosOrigenFinal.length) {
        throw new Error('CANNOT_CANCEL_NON_EMPTY_ROUTE: Para cancelar la ruta origen se deben mover todos los empleados asignados.');
      }

      t.set(programacionOrigen.docRef, limpiarCamposLegados({
        estado: debeCancelarOrigen ? 'cancelada' : obtenerEstadoProgramacion(dataOrigen),
        pasajeros_ids: pasajerosOrigenFinal,
        asientos_reservados: asientosOrigenFinal,
        asientos_por_empleado: mapaOrigenFinal,
        pasajeros: construirMapaPasajerosMerge(detalleOrigenFinal, dataOrigen),
        asientos_ocupados: Math.max(pasajerosOrigenFinal.length, asientosOrigenFinal.length),
        motivo_cancelacion: debeCancelarOrigen ? (textoNormalizado(motivo) || 'Cancelacion operativa por plan IA.') : dataOrigen.motivo_cancelacion || null,
        cancelada_en: debeCancelarOrigen ? new Date() : dataOrigen.cancelada_en || null,
        cancelada_por: debeCancelarOrigen ? req.usuario.uid : dataOrigen.cancelada_por || null,
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }), { merge: true });

      t.set(programacionDestino.docRef, limpiarCamposLegados({
        fecha: fechaPlan,
        turno: turnoPlan || dataDestino.turno || null,
        id_ruta: rutaDestino.id,
        pasajeros_ids: pasajerosDestinoFinal,
        asientos_reservados: normalizarAsientosReservados(asientosDestinoFinal),
        asientos_por_empleado: mapaDestinoFinal,
        pasajeros: detalleDestinoFinal,
        asientos_ocupados: Math.max(pasajerosDestinoFinal.length, asientosDestinoFinal.length),
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      }), { merge: true });

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
          turno: turnoPlan || null,
          cancelar_origen: debeCancelarOrigen
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
        estado_origen: debeCancelarOrigen ? 'cancelada' : 'activa',
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
      || mensaje.startsWith('CANNOT_CANCEL_NON_EMPTY_ROUTE')
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
    const tieneFiltroFecha = Boolean(fechaDesde || fechaHasta);
    let snapshot;

    if (!tieneFiltroFecha) {
      try {
        snapshot = await db
          .collection(COLECCION_PLANES_IA)
          .orderBy('ejecutado_en', 'desc')
          .limit(limit)
          .get();
      } catch (errorOrdenEjecutado) {
        try {
          snapshot = await db
            .collection(COLECCION_PLANES_IA)
            .orderBy('fecha', 'desc')
            .limit(limit)
            .get();
        } catch (errorOrdenFecha) {
          snapshot = await db.collection(COLECCION_PLANES_IA).limit(limit).get();
        }
      }
    } else {
      let query = db.collection(COLECCION_PLANES_IA);

      if (fechaDesde) {
        query = query.where('fecha', '>=', fechaDesde);
      }

      if (fechaHasta) {
        query = query.where('fecha', '<=', fechaHasta);
      }

      try {
        snapshot = await query.orderBy('fecha', 'desc').limit(limit).get();
      } catch (errorOrdenFechaFiltrada) {
        snapshot = await query.limit(Math.min(limit * 3, 200)).get();
      }
    }

    const etiquetasCache = new Map();
    const planesBase = snapshot.docs.map((doc) => {
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

    let planesOrdenados = [...planesBase];
    if (tieneFiltroFecha) {
      planesOrdenados.sort((planA, planB) => {
        const ejecutadoA = planA.ejecutado_en || `${planA.fecha || ''}T00:00:00.000Z`;
        const ejecutadoB = planB.ejecutado_en || `${planB.fecha || ''}T00:00:00.000Z`;
        return ejecutadoB.localeCompare(ejecutadoA);
      });
      planesOrdenados = planesOrdenados.slice(0, limit);
    }

    const planes = await Promise.all(planesOrdenados.map(async (plan) => ({
      ...plan,
      ruta_origen_label: await obtenerEtiquetaRutaPorId(plan.ruta_origen_id, etiquetasCache),
      ruta_destino_label: await obtenerEtiquetaRutaPorId(plan.ruta_destino_id, etiquetasCache)
    })));

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
    const idCamionero = rol === ROLES.CAMIONERO ? await generarIdCamioneroUnico() : null;
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
      id_camionero: idCamionero,
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
        rol,
        id_camionero: idCamionero
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
        activo: data.activo !== false,
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
    const passwordManual = String(password || '').trim();
    const idEmpleadoFinal = await generarIdEmpleadoUnico();
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

    programarEnvioCorreoAltaEmpleado({
      nombre: String(nombre).trim(),
      email: String(email).trim(),
      idEmpleado: idEmpleadoFinal,
      password: passwordFinal
    });

    res.status(201).json({
      success: true,
      message: 'Empleado creado exitosamente. Las credenciales se muestran abajo y el correo se envia en segundo plano.',
      credenciales_generadas: {
        email: String(email).trim(),
        id_empleado: idEmpleadoFinal,
        password_temporal: passwordManual ? null : passwordFinal,
        password_definida_manualmente: Boolean(passwordManual)
      },
      notificacion_email: NOTIFICACION_CORREO_EN_PROCESO,
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
    await eliminarUsuarioDefinitivo({
      uid,
      rolEsperado: ROLES.EMPLEADO,
      usuarioSolicitante: req.usuario,
      validarPermisoEmpleado: true,
      invalidarCacheUsuario,
    });

    res.json({
      success: true,
      message: 'Empleado eliminado definitivamente.'
    });
  } catch (error) {
    console.error('Error eliminando empleado:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.'
      });
    }

    res.status(error.status || 400).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// ENDPOINT 8C: CRUD de Camioneros (Solo Admin)
// ==========================================
app.get('/api/camioneros', autorizar('camioneros:ver'), async (_req, res) => {
  try {
    const snapshot = await db.collection('usuarios').where('rol', '==', ROLES.CAMIONERO).get();
    const camioneros = snapshot.docs.map((doc) => normalizarCamionero(doc));
    res.json({
      success: true,
      cantidad: camioneros.length,
      data: camioneros,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Error obteniendo camioneros.',
    });
  }
});

app.post('/api/camioneros', autorizar('camioneros:crear'), async (req, res) => {
  const { id_camionero, email, nombre, password } = req.body || {};

  if (!email || !nombre) {
    return res.status(400).json({
      success: false,
      message: 'Email y nombre son requeridos.',
    });
  }

  if (!esEmailValido(email)) {
    return res.status(400).json({
      success: false,
      message: 'El email no tiene un formato válido.',
    });
  }

  let userRecord = null;
  try {
    const passwordManual = String(password || '').trim();
    const idCamioneroFinal = await generarIdCamioneroUnico();
    const passwordFinal = passwordManual || generarPasswordTemporal();

    userRecord = await admin.auth().createUser({
      email: String(email).trim(),
      password: passwordFinal,
      displayName: String(nombre).trim(),
    });

    await db.collection('usuarios').doc(userRecord.uid).set({
      id_camionero: idCamioneroFinal,
      email: String(email).trim(),
      nombre: String(nombre).trim(),
      rol: ROLES.CAMIONERO,
      asignacion_unidad_turno: null,
      creado_por: req.usuario.uid,
      creado_en: new Date(),
      actualizado_en: null,
      activo: true,
    });

    res.status(201).json({
      success: true,
      message: 'Camionero creado exitosamente.',
      credenciales_generadas: {
        email: String(email).trim(),
        id_camionero: idCamioneroFinal,
        password_temporal: passwordManual ? null : passwordFinal,
        password_definida_manualmente: Boolean(passwordManual),
      },
      notificacion_email: NOTIFICACION_CORREO_EN_PROCESO,
      usuario: {
        uid: userRecord.uid,
        id_camionero: idCamioneroFinal,
        email: String(email).trim(),
        nombre: String(nombre).trim(),
        rol: ROLES.CAMIONERO,
      },
    });
  } catch (error) {
    if (userRecord?.uid) {
      await admin.auth().deleteUser(userRecord.uid).catch(() => {});
    }
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({
        success: false,
        message: 'Ya existe un usuario con ese email.',
      });
    }
    res.status(400).json({
      success: false,
      message: error.message || 'No se pudo crear el camionero.',
    });
  }
});

app.put('/api/camioneros/:uid', autorizar('camioneros:actualizar'), async (req, res) => {
  const { uid } = req.params;
  const { email, nombre, password, activo, vehiculo_id, turno_id } = req.body || {};

  try {
    const ref = db.collection('usuarios').doc(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return res.status(404).json({ success: false, message: 'Camionero no encontrado.' });
    }

    const data = snapshot.data() || {};
    if (data.rol !== ROLES.CAMIONERO) {
      return res.status(403).json({ success: false, message: 'Solo se pueden editar usuarios con rol CAMIONERO.' });
    }

    const updatesFirestore = {
      actualizado_por: req.usuario.uid,
      actualizado_en: new Date(),
    };
    const updatesAuth = {};

    if (email !== undefined) {
      if (!esEmailValido(email)) {
        return res.status(400).json({ success: false, message: 'El email no tiene un formato válido.' });
      }
      updatesFirestore.email = String(email).trim();
      updatesAuth.email = String(email).trim();
    }

    if (nombre !== undefined) {
      updatesFirestore.nombre = String(nombre).trim();
      updatesAuth.displayName = String(nombre).trim();
    }

    if (password) {
      updatesAuth.password = String(password);
    }

    if (activo !== undefined) {
      updatesFirestore.activo = Boolean(activo);
    }

    if (vehiculo_id !== undefined || turno_id !== undefined) {
      const vehiculoAsignado = vehiculo_id !== undefined ? String(vehiculo_id || '').trim() : null;
      const turnoAsignado = turno_id !== undefined ? String(turno_id || '').trim() : null;

      if (!vehiculoAsignado && !turnoAsignado) {
        await asignarCamioneroUnidadTurno({
          camioneroUid: uid,
          vehiculoId: null,
          turnoId: null,
          solicitanteUid: req.usuario.uid,
        });
      } else if (vehiculoAsignado && turnoAsignado) {
        await asignarCamioneroUnidadTurno({
          camioneroUid: uid,
          vehiculoId: vehiculoAsignado,
          turnoId: turnoAsignado,
          solicitanteUid: req.usuario.uid,
        });
      } else {
        return res.status(400).json({
          success: false,
          message: 'Debes enviar vehiculo_id y turno_id juntos, o ambos vacíos para desasignar.',
        });
      }
      invalidarCacheUsuario(uid);
    }

    await ref.update(updatesFirestore);
    if (Object.keys(updatesAuth).length) {
      await admin.auth().updateUser(uid, updatesAuth);
    }

    const actualizado = await ref.get();
    res.json({
      success: true,
      message: 'Camionero actualizado exitosamente.',
      usuario: normalizarCamionero(actualizado),
    });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado en Firebase Auth.' });
    }
    res.status(400).json({
      success: false,
      message: error.message || 'No se pudo actualizar el camionero.',
    });
  }
});

app.delete('/api/camioneros/:uid', autorizar('camioneros:eliminar'), async (req, res) => {
  const { uid } = req.params;

  try {
    await eliminarUsuarioDefinitivo({
      uid,
      rolEsperado: ROLES.CAMIONERO,
      invalidarCacheUsuario,
    });

    res.json({
      success: true,
      message: 'Camionero eliminado definitivamente.',
    });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.',
      });
    }
    res.status(error.status || 400).json({
      success: false,
      message: error.message || 'No se pudo eliminar el camionero.',
    });
  }
});

app.post('/api/camioneros/:uid/asignar-unidad-turno', autorizar('camioneros:asignar_unidad_turno'), async (req, res) => {
  const camioneroUid = textoNormalizado(req.params.uid);
  const vehiculoId = req.body?.vehiculo_id;
  const turnoId = req.body?.turno_id;

  try {
    const asignacion = await asignarCamioneroUnidadTurno({
      camioneroUid,
      vehiculoId: vehiculoId || null,
      turnoId: turnoId || null,
      solicitanteUid: req.usuario.uid,
    });
    invalidarCacheUsuario(camioneroUid);

    res.json({
      success: true,
      message: asignacion
        ? 'Camionero asignado a la unidad y turno correctamente.'
        : 'Camionero desasignado correctamente.',
      data: asignacion,
    });
  } catch (error) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message || 'No se pudo asignar el camionero a la unidad y turno.',
    });
  }
});

// ==========================================
// ENDPOINT 8C: CRUD de Admins (Solo Admin)
// ==========================================
app.get('/api/admins', autorizar('admins:ver'), async (req, res) => {
  try {
    const adminsSnapshot = await db.collection('usuarios').where('rol', '==', ROLES.ADMIN).get();
    const admins = [];

    adminsSnapshot.forEach((doc) => {
      admins.push(normalizarAdmin(doc));
    });

    res.json({
      success: true,
      cantidad: admins.length,
      data: admins
    });
  } catch (error) {
    console.error('Error listando admins:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo administradores'
    });
  }
});

app.post('/api/admins', autorizar('admins:crear'), async (req, res) => {
  const { email, nombre, password } = req.body;

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

  let userRecord;
  try {
    const passwordManual = String(password || '').trim();
    const passwordFinal = passwordManual || generarPasswordTemporal();

    userRecord = await admin.auth().createUser({
      email: String(email).trim(),
      password: passwordFinal,
      displayName: String(nombre).trim()
    });

    await db.collection('usuarios').doc(userRecord.uid).set({
      email: String(email).trim(),
      nombre: String(nombre).trim(),
      rol: ROLES.ADMIN,
      creado_por: req.usuario.uid,
      creado_en: new Date(),
      actualizado_en: null,
      activo: true
    });

    programarEnvioCorreoAltaAdmin({
      nombre: String(nombre).trim(),
      email: String(email).trim(),
      password: passwordFinal
    });

    res.status(201).json({
      success: true,
      message: 'Administrador creado exitosamente. Las credenciales se muestran abajo y el correo se envia en segundo plano.',
      credenciales_generadas: {
        email: String(email).trim(),
        password_temporal: passwordManual ? null : passwordFinal,
        password_definida_manualmente: Boolean(passwordManual)
      },
      notificacion_email: NOTIFICACION_CORREO_EN_PROCESO,
      usuario: {
        uid: userRecord.uid,
        email: String(email).trim(),
        nombre: String(nombre).trim(),
        rol: ROLES.ADMIN
      }
    });
  } catch (error) {
    console.error('Error creando admin:', error.message);

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

app.put('/api/admins/:uid', autorizar('admins:actualizar'), async (req, res) => {
  const { uid } = req.params;
  const { email, nombre, password, activo } = req.body;

  try {
    if (uid === req.usuario.uid && activo === false) {
      return res.status(403).json({
        success: false,
        message: 'No puedes desactivar tu propia cuenta de administrador.'
      });
    }

    const ref = db.collection('usuarios').doc(uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'Administrador no encontrado.'
      });
    }

    const data = snapshot.data();
    if (data.rol !== ROLES.ADMIN) {
      return res.status(403).json({
        success: false,
        message: 'Solo se pueden editar usuarios con rol ADMIN.'
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
      message: 'Administrador actualizado exitosamente.',
      usuario: normalizarAdmin(updated)
    });
  } catch (error) {
    console.error('Error actualizando admin:', error.message);

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

app.delete('/api/admins/:uid', autorizar('admins:eliminar'), async (req, res) => {
  const { uid } = req.params;

  if (uid === req.usuario.uid) {
    return res.status(403).json({
      success: false,
      message: 'No puedes eliminar tu propia cuenta de administrador.'
    });
  }

  try {
    await eliminarUsuarioDefinitivo({
      uid,
      rolEsperado: ROLES.ADMIN,
      invalidarCacheUsuario,
    });

    res.json({
      success: true,
      message: 'Administrador eliminado definitivamente.'
    });
  } catch (error) {
    console.error('Error eliminando admin:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.'
      });
    }

    res.status(error.status || 400).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// ENDPOINT 8D: CRUD de Jefes (Solo Admin)
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

  let userRecord;
  try {
    const passwordManual = String(password || '').trim();
    const passwordFinal = passwordManual || generarPasswordTemporal();

    userRecord = await admin.auth().createUser({
      email: String(email).trim(),
      password: passwordFinal,
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

    programarEnvioCorreoAltaJefe({
      nombre: String(nombre).trim(),
      email: String(email).trim(),
      password: passwordFinal
    });

    res.status(201).json({
      success: true,
      message: 'Jefe creado exitosamente. Las credenciales se muestran abajo y el correo se envia en segundo plano.',
      credenciales_generadas: {
        email: String(email).trim(),
        password_temporal: passwordManual ? null : passwordFinal,
        password_definida_manualmente: Boolean(passwordManual)
      },
      notificacion_email: NOTIFICACION_CORREO_EN_PROCESO,
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
    await eliminarUsuarioDefinitivo({
      uid,
      rolEsperado: ROLES.JEFE,
      invalidarCacheUsuario,
    });

    res.json({
      success: true,
      message: 'Jefe eliminado definitivamente.'
    });
  } catch (error) {
    console.error('Error eliminando jefe:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.'
      });
    }

    res.status(error.status || 400).json({
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
    const ref = db.collection('usuarios').doc(uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado.'
      });
    }

    const data = snapshot.data() || {};
    const opciones = {
      uid,
      invalidarCacheUsuario,
    };

    if (data.rol === ROLES.EMPLEADO) {
      opciones.rolEsperado = ROLES.EMPLEADO;
      opciones.validarPermisoEmpleado = true;
      opciones.usuarioSolicitante = req.usuario;
    } else if (data.rol === ROLES.JEFE) {
      opciones.rolEsperado = ROLES.JEFE;
    } else if (data.rol === ROLES.CAMIONERO) {
      opciones.rolEsperado = ROLES.CAMIONERO;
    }

    await eliminarUsuarioDefinitivo(opciones);

    res.json({
      success: true,
      message: 'Usuario eliminado definitivamente.'
    });
  } catch (error) {
    console.error('Error eliminando usuario:', error.message);

    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en Firebase Auth.'
      });
    }

    res.status(error.status || 400).json({
      success: false,
      message: error.message
    });
  }
});

// Inicializar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor ILPEA corriendo en http://localhost:${PORT}`);

  verificarTransporterSMTP()
    .then((smtp) => {
      if (smtp.ok) {
        console.log('📧 SMTP configurado correctamente para envio de credenciales.');
        return;
      }

      console.warn(`⚠️ SMTP no disponible (${smtp.motivo}). Los correos de alta pueden fallar hasta corregir backend/.env`);
      if (smtp.detalle) {
        console.warn(`   Detalle SMTP: ${smtp.detalle}`);
      }
    })
    .catch((error) => {
      console.warn('⚠️ No se pudo verificar SMTP al arrancar:', error.message);
    });
});