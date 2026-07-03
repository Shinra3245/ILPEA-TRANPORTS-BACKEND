/**
 * Fase 5 — Módulos nuevos del esquema Firestore:
 *   - programacion_semanal/{semana}_{id_empleado}_{turno_id}  (asignación semanal desnormalizada)
 *   - programacion_diaria/{id}/abordajes/{id_empleado}  (pase de lista con contador transaccional)
 *   - metricas_diarias/{fecha} + resumen_semanal/{semana}  (agregados para reportes)
 */

const express = require('express');
const router = express.Router();
const { autorizar } = require('../middleware/auth');
const { ROLES } = require('../config/roles');
const {
  admin,
  db,
  textoNormalizado,
  turnoNormalizado,
  fechaISOHoy,
  crearErrorHttp,
  resolverRutaPorIdentificador,
  resolverProgramacion,
  extraerPasajerosProgramacion,
  obtenerNumeroSemanaISO,
  resolverUnidadTurno,
  fechasOperacionSemana,
  normalizarPasajerosDetalle,
  precargarCacheDiasOperacionTurnos,
  turnosCompartenDia,
  diasEnComunTurnos,
  nombreDiaOperacion,
  normalizarAsignacionUnidadTurno,
  resolverRutaEmpleadoPorUnidadTurno,
  validarVehiculoProgramacionCoincide,
  programarEnvioCorreoAsignacionSemanal,
} = require('../lib/utils');

// ==========================================
// Helpers
// ==========================================

/** Devuelve la clave ISO de semana en formato "2026-W27" para una fecha dada. */
function obtenerSemanaISOKey(fechaReferencia = new Date()) {
  const fecha = new Date(fechaReferencia);
  const semana = obtenerNumeroSemanaISO(fecha);

  // El año ISO puede diferir del año calendario en los bordes (ej. 29-dic puede ser W1).
  const fechaUTC = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
  const diaSemana = fechaUTC.getUTCDay() || 7;
  fechaUTC.setUTCDate(fechaUTC.getUTCDate() + 4 - diaSemana);
  const anioISO = fechaUTC.getUTCFullYear();

  return `${anioISO}-W${semana}`;
}

/** Normaliza y valida una clave de semana "YYYY-Www"; si no hay valor usa la semana actual. */
function normalizarSemanaKey(valor) {
  const texto = textoNormalizado(valor).toUpperCase();
  if (!texto) {
    return obtenerSemanaISOKey();
  }

  if (!/^\d{4}-W\d{1,2}$/.test(texto)) {
    throw crearErrorHttp(400, 'La semana debe tener formato YYYY-Www (ej. 2026-W27).');
  }

  return texto;
}

function esProgramacionCancelada(data) {
  return textoNormalizado(data?.estado).toLowerCase() === 'cancelada';
}

/** IDs de empleados bajo la responsabilidad de un jefe (para filtrar consultas). */
async function obtenerEmpleadosDeJefe(jefeUid) {
  const snapshot = await db.collection('usuarios')
    .where('jefe_uid', '==', jefeUid)
    .get();

  const idsEmpleado = new Set();
  const uidsEmpleado = new Set();

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    if (data.rol !== ROLES.EMPLEADO) {
      return;
    }

    uidsEmpleado.add(doc.id);
    const idEmpleado = textoNormalizado(data.id_empleado);
    if (idEmpleado) {
      idsEmpleado.add(idEmpleado);
    }
  });

  return { idsEmpleado, uidsEmpleado };
}

function asignacionPerteneceAJefe(asignacion, idsEmpleado, uidsEmpleado) {
  const idEmpleado = textoNormalizado(asignacion.id_empleado);
  const empleadoUid = textoNormalizado(asignacion.empleado_uid);
  return (idEmpleado && idsEmpleado.has(idEmpleado))
    || (empleadoUid && uidsEmpleado.has(empleadoUid));
}

async function resolverEmpleadoPorId(idEmpleado, transaction = null) {
  const idNormalizado = textoNormalizado(idEmpleado);
  if (!idNormalizado) {
    throw crearErrorHttp(400, 'id_empleado es requerido.');
  }

  const query = db.collection('usuarios')
    .where('id_empleado', '==', idNormalizado)
    .where('rol', '==', ROLES.EMPLEADO)
    .limit(1);

  const snapshot = transaction ? await transaction.get(query) : await query.get();
  if (snapshot.empty) {
    throw crearErrorHttp(404, `El empleado "${idNormalizado}" no existe o no tiene rol EMPLEADO.`);
  }

  const doc = snapshot.docs[0];
  return { uid: doc.id, ref: doc.ref, data: doc.data() || {} };
}

async function leerTurnoCatalogo(turnoId, transaction = null) {
  if (!turnoId) {
    return null;
  }

  const ref = db.collection('turnos').doc(turnoId);
  const doc = transaction ? await transaction.get(ref) : await ref.get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

function resolverParadaDeRuta(rutaData, paradaId) {
  const paradas = Array.isArray(rutaData?.paradas) ? rutaData.paradas : [];
  if (paradaId) {
    return paradas.find((parada) => parada?.id === paradaId) || null;
  }
  return paradas.length ? paradas[0] : null;
}

// ==========================================
// PROGRAMACIÓN SEMANAL
// ==========================================

// Crear/actualizar asignación semanal (docId determinista = idempotente)
router.post('/programacion-semanal', autorizar('programacion_semanal:crear'), async (req, res) => {
  try {
    const { semana, fecha, id_empleado, ruta_id, turno_id, parada_id, asiento } = req.body || {};

    const semanaKey = fecha
      ? obtenerSemanaISOKey(new Date(`${textoNormalizado(fecha)}T12:00:00Z`))
      : normalizarSemanaKey(semana);
    const idEmpleado = textoNormalizado(id_empleado);
    const idRuta = textoNormalizado(ruta_id);
    const turnoId = turnoNormalizado(turno_id);
    const asientoNumero = Number(asiento);
    const tieneAsiento = Number.isInteger(asientoNumero) && asientoNumero > 0;

    if (!idEmpleado || !idRuta || !turnoId) {
      return res.status(400).json({
        success: false,
        message: 'id_empleado, ruta_id y turno_id son requeridos.'
      });
    }

    const rutaEncontrada = await resolverRutaPorIdentificador(idRuta);
    if (!rutaEncontrada) {
      return res.status(404).json({ success: false, message: 'La ruta seleccionada no existe.' });
    }

    await precargarCacheDiasOperacionTurnos();

    const docId = `${semanaKey}_${idEmpleado}_${turnoId}`;
    const asignacionRef = db.collection('programacion_semanal').doc(docId);
    const resumenRef = db.collection('resumen_semanal').doc(semanaKey);

    // Ocupación previa de asientos para (semana, ruta): se filtra por turno en memoria.
    const ocupacionQuery = db.collection('programacion_semanal')
      .where('semana', '==', semanaKey)
      .where('ruta_id', '==', rutaEncontrada.id);

    const empleadoAsignacionesQuery = db.collection('programacion_semanal')
      .where('semana', '==', semanaKey)
      .where('id_empleado', '==', idEmpleado);

    let resultado = null;
    let datosCorreoAsignacion = null;

    await db.runTransaction(async (t) => {
      const empleado = await resolverEmpleadoPorId(idEmpleado, t);

      if (empleado.data.activo === false) {
        throw crearErrorHttp(409, 'El empleado seleccionado está inactivo.');
      }

      if (req.usuario.rol === ROLES.JEFE && empleado.data.jefe_uid !== req.usuario.uid) {
        throw crearErrorHttp(403, 'No puedes programar empleados que no están bajo tu responsabilidad.');
      }

      const [turnoCatalogo, asignacionPrevia, resumenPrevio, ocupacionSnap, empleadoAsignacionesSnap] = await Promise.all([
        leerTurnoCatalogo(turnoId, t),
        t.get(asignacionRef),
        t.get(resumenRef),
        t.get(ocupacionQuery),
        t.get(empleadoAsignacionesQuery),
      ]);

      const rutaData = rutaEncontrada.data || {};

      // Máximo un turno por día de la semana para el mismo empleado.
      const conflictoDia = empleadoAsignacionesSnap.docs.find((doc) => {
        if (doc.id === docId) {
          return false;
        }
        const existenteTurno = turnoNormalizado(doc.data()?.turno_id);
        if (!existenteTurno) {
          return false;
        }
        return turnosCompartenDia(existenteTurno, turnoId);
      });

      if (conflictoDia) {
        const dataConflicto = conflictoDia.data() || {};
        const diasComun = diasEnComunTurnos(dataConflicto.turno_id, turnoId);
        const diaNombre = nombreDiaOperacion(diasComun[0]);
        const turnoConflicto = dataConflicto.turno_nombre || dataConflicto.turno_id;
        throw crearErrorHttp(
          409,
          `El empleado ya tiene turno el ${diaNombre} de esta semana (${turnoConflicto}).`,
        );
      }

      // Unidad asignada a la ruta para este turno (define capacidad y asientos).
      const unidad = resolverUnidadTurno(rutaData, turnoId);
      const capacidad = Number(unidad.capacidad) || Number(rutaData.capacidad_real) || 0;

      if (tieneAsiento) {
        if (capacidad <= 0) {
          throw crearErrorHttp(409, 'La ruta no tiene una unidad asignada para este turno. Asigna una unidad antes de reservar asientos.');
        }

        if (asientoNumero > capacidad) {
          throw crearErrorHttp(409, `El asiento ${asientoNumero} excede la capacidad de la unidad (${capacidad}).`);
        }

        // Unicidad de asiento dentro de la misma semana+ruta+turno (excluye al propio empleado).
        const asientoOcupado = ocupacionSnap.docs.some((doc) => {
          if (doc.id === docId) {
            return false;
          }
          const data = doc.data() || {};
          const mismoTurno = turnoNormalizado(data.turno_id) === turnoId;
          return mismoTurno && Number(data.asiento) === asientoNumero;
        });

        if (asientoOcupado) {
          throw crearErrorHttp(409, `El asiento ${asientoNumero} ya está ocupado en esta ruta y turno.`);
        }
      }

      const parada = resolverParadaDeRuta(rutaData, textoNormalizado(parada_id))
        || (empleado.data.parada_default && typeof empleado.data.parada_default === 'object'
          ? { ...empleado.data.parada_default, orden: null }
          : null);

      const nombreEmpleado = textoNormalizado(empleado.data.nombre) || idEmpleado;
      const rutaNombre = textoNormalizado(rutaData.nombre)
        || (rutaData.zona ? `Ruta ${rutaData.ruta} - ${rutaData.zona}` : `Ruta ${rutaData.ruta}`);

      // Desnormalización: nombres de empleado/ruta/turno para pintar la tabla con 1 query.
      const payload = {
        semana: semanaKey,
        id_empleado: idEmpleado,
        empleado_uid: empleado.uid,
        empleado_nombre: nombreEmpleado,
        ruta_id: rutaEncontrada.id,
        ruta_numero: Number(rutaData.ruta) || Number(rutaData.numero) || null,
        ruta_nombre: rutaNombre,
        turno_id: turnoId || null,
        turno_nombre: turnoCatalogo?.nombre || turnoId || null,
        asiento: tieneAsiento ? asientoNumero : null,
        unidad: {
          vehiculo_id: unidad.id || null,
          tipo: unidad.tipo || null,
          codigo: unidad.codigo || null,
          capacidad: capacidad || null,
        },
        parada: parada
          ? { id: parada.id || null, nombre: parada.nombre || null, orden: parada.orden ?? null }
          : null,
        creado_por: req.usuario.uid,
        creado_en: asignacionPrevia.exists ? (asignacionPrevia.data()?.creado_en || new Date()) : new Date(),
        actualizado_en: new Date(),
        actualizado_por: req.usuario.uid
      };

      t.set(asignacionRef, payload, { merge: true });

      // Desnormalización: mapa de turnos de la semana actual en el doc del usuario.
      t.set(empleado.ref, {
        [`asignaciones_semana.${turnoId}`]: {
          semana: semanaKey,
          ruta_id: rutaEncontrada.id,
          ruta_nombre: rutaNombre,
          turno_id: turnoId,
          turno_nombre: turnoCatalogo?.nombre || turnoId,
          asiento: tieneAsiento ? asientoNumero : null,
        },
        asignacion_actual: {
          semana: semanaKey,
          ruta_id: rutaEncontrada.id,
          ruta_nombre: rutaNombre,
          turno_id: turnoId,
          turno_nombre: turnoCatalogo?.nombre || turnoId,
        },
        actualizado_en: new Date(),
      }, { merge: true });

      // Agregado resumen_semanal: lista de asignados + contadores por ruta.
      const resumenData = resumenPrevio.exists ? (resumenPrevio.data() || {}) : {};
      const rutaPrevia = asignacionPrevia.exists
        ? textoNormalizado(asignacionPrevia.data()?.ruta_id)
        : null;
      const porRuta = { ...(resumenData.por_ruta || {}) };

      if (rutaPrevia && rutaPrevia !== rutaEncontrada.id) {
        porRuta[rutaPrevia] = Math.max((Number(porRuta[rutaPrevia]) || 0) - 1, 0);
      }
      if (!asignacionPrevia.exists || rutaPrevia !== rutaEncontrada.id) {
        porRuta[rutaEncontrada.id] = (Number(porRuta[rutaEncontrada.id]) || 0) + 1;
      }

      t.set(resumenRef, {
        semana: semanaKey,
        empleados_asignados: admin.firestore.FieldValue.arrayUnion(idEmpleado),
        total: asignacionPrevia.exists
          ? (Number(resumenData.total) || 0)
          : admin.firestore.FieldValue.increment(1),
        por_ruta: porRuta,
        actualizado_en: new Date()
      }, { merge: true });

      resultado = { id: docId, ...payload };

      const emailEmpleado = textoNormalizado(empleado.data.email);
      if (emailEmpleado) {
        datosCorreoAsignacion = {
          nombre: nombreEmpleado,
          email: emailEmpleado,
          idEmpleado,
          semana: semanaKey,
          turnoNombre: turnoCatalogo?.nombre || turnoId,
          fechasOperacion: fechasOperacionSemana(semanaKey, turnoId),
          rutaNombre,
          rutaNumero: Number(rutaData.ruta) || Number(rutaData.numero) || null,
          asiento: tieneAsiento ? asientoNumero : null,
          paradaNombre: parada?.nombre || null,
          unidadCodigo: unidad.codigo || null,
          unidadTipo: unidad.tipo || null,
          esActualizacion: asignacionPrevia.exists,
        };
      }
    });

    if (datosCorreoAsignacion) {
      programarEnvioCorreoAsignacionSemanal(datosCorreoAsignacion);
    }

    res.status(200).json({
      success: true,
      message: 'Programación semanal registrada correctamente.',
      data: resultado
    });
  } catch (error) {
    const status = Number(error.status) || 400;
    res.status(status).json({ success: false, message: error.message || 'No fue posible registrar la programación semanal.' });
  }
});

// Listar programación de una semana — 1 sola query gracias a la desnormalización
router.get('/programacion-semanal', autorizar('programacion_semanal:ver'), async (req, res) => {
  try {
    const semanaKey = normalizarSemanaKey(req.query.semana);
    const rutaId = textoNormalizado(req.query.ruta_id);

    let query = db.collection('programacion_semanal').where('semana', '==', semanaKey);
    if (rutaId) {
      query = query.where('ruta_id', '==', rutaId);
    }

    const snapshot = await query.get();
    let data = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(a.empleado_nombre || '').localeCompare(String(b.empleado_nombre || ''), 'es'));

    if (req.usuario.rol === ROLES.JEFE) {
      const { idsEmpleado, uidsEmpleado } = await obtenerEmpleadosDeJefe(req.usuario.uid);
      data = data.filter((item) => asignacionPerteneceAJefe(item, idsEmpleado, uidsEmpleado));
    }

    res.status(200).json({
      success: true,
      semana: semanaKey,
      cantidad: data.length,
      data
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    res.status(status).json({ success: false, message: error.message || 'No fue posible consultar la programación semanal.' });
  }
});

// Empleados SIN asignación en la semana — usa el agregado resumen_semanal
// (diferencia en memoria; evita descargar la programación completa)
router.get('/programacion-semanal/sin-asignar', autorizar('programacion_semanal:ver'), async (req, res) => {
  try {
    const semanaKey = normalizarSemanaKey(req.query.semana);

    const [resumenDoc, empleadosSnapshot] = await Promise.all([
      db.collection('resumen_semanal').doc(semanaKey).get(),
      req.usuario.rol === ROLES.JEFE
        ? db.collection('usuarios').where('jefe_uid', '==', req.usuario.uid).get()
        : db.collection('usuarios')
          .where('rol', '==', ROLES.EMPLEADO)
          .where('activo', '==', true)
          .get(),
    ]);

    const asignados = new Set(
      Array.isArray(resumenDoc.data()?.empleados_asignados)
        ? resumenDoc.data().empleados_asignados
        : []
    );

    const data = empleadosSnapshot.docs
      .map((doc) => {
        const u = doc.data() || {};
        return {
          uid: doc.id,
          id_empleado: textoNormalizado(u.id_empleado),
          nombre: u.nombre || null,
          jefe_uid: u.jefe_uid || null,
          activo: u.activo !== false,
          rol: u.rol || null,
        };
      })
      .filter((empleado) => empleado.rol === ROLES.EMPLEADO
        && empleado.activo
        && empleado.id_empleado
        && !asignados.has(empleado.id_empleado))
      .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));

    res.status(200).json({
      success: true,
      semana: semanaKey,
      total_asignados: asignados.size,
      cantidad: data.length,
      data
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    res.status(status).json({ success: false, message: error.message || 'No fue posible consultar los empleados sin asignar.' });
  }
});

// Eliminar asignación semanal (mantiene consistentes usuario + resumen)
router.delete('/programacion-semanal/:id', autorizar('programacion_semanal:eliminar'), async (req, res) => {
  try {
    const docId = textoNormalizado(req.params.id);
    if (!docId) {
      return res.status(400).json({ success: false, message: 'El id de la asignación es requerido.' });
    }

    const asignacionRef = db.collection('programacion_semanal').doc(docId);

    await db.runTransaction(async (t) => {
      const asignacionDoc = await t.get(asignacionRef);
      if (!asignacionDoc.exists) {
        throw crearErrorHttp(404, 'La asignación semanal no existe.');
      }

      const data = asignacionDoc.data() || {};
      const semanaKey = textoNormalizado(data.semana);
      const idEmpleado = textoNormalizado(data.id_empleado);
      const rutaId = textoNormalizado(data.ruta_id);
      const resumenRef = db.collection('resumen_semanal').doc(semanaKey);
      const otrasAsignacionesQuery = db.collection('programacion_semanal')
        .where('semana', '==', semanaKey)
        .where('id_empleado', '==', idEmpleado);

      let empleadoRef = null;
      let empleadoData = null;
      let empleadoDocPromise = null;
      if (data.empleado_uid) {
        empleadoRef = db.collection('usuarios').doc(data.empleado_uid);
        empleadoDocPromise = t.get(empleadoRef);
      }

      const [resumenDoc, otrasAsignacionesSnap, empleadoDoc] = await Promise.all([
        t.get(resumenRef),
        t.get(otrasAsignacionesQuery),
        empleadoDocPromise,
      ]);

      if (empleadoDoc) {
        empleadoData = empleadoDoc.exists ? (empleadoDoc.data() || {}) : null;
      } else if (idEmpleado) {
        const empleadoResuelto = await resolverEmpleadoPorId(idEmpleado, t);
        empleadoRef = empleadoResuelto.ref;
        empleadoData = empleadoResuelto.data;
      }

      if (req.usuario.rol === ROLES.JEFE) {
        if (!empleadoData || empleadoData.jefe_uid !== req.usuario.uid) {
          throw crearErrorHttp(403, 'No puedes eliminar asignaciones de empleados que no están bajo tu responsabilidad.');
        }
      }

      const quedanOtrasAsignaciones = otrasAsignacionesSnap.docs.some((doc) => doc.id !== docId);
      const turnoIdEliminado = turnoNormalizado(data.turno_id);

      t.delete(asignacionRef);

      if (empleadoRef) {
        const actualizacionEmpleado = { actualizado_en: new Date() };
        if (turnoIdEliminado) {
          actualizacionEmpleado[`asignaciones_semana.${turnoIdEliminado}`] = admin.firestore.FieldValue.delete();
        }
        if (!quedanOtrasAsignaciones) {
          actualizacionEmpleado.asignacion_actual = {
            semana: '',
            ruta_id: null,
            ruta_nombre: null,
            turno_id: null,
            turno_nombre: null,
          };
          actualizacionEmpleado.asignaciones_semana = admin.firestore.FieldValue.delete();
        }
        t.set(empleadoRef, actualizacionEmpleado, { merge: true });
      }

      if (resumenDoc.exists) {
        const resumenData = resumenDoc.data() || {};
        const porRuta = { ...(resumenData.por_ruta || {}) };
        if (rutaId) {
          porRuta[rutaId] = Math.max((Number(porRuta[rutaId]) || 0) - 1, 0);
        }

        const actualizacionResumen = {
          total: Math.max((Number(resumenData.total) || 0) - 1, 0),
          por_ruta: porRuta,
          actualizado_en: new Date(),
        };
        if (!quedanOtrasAsignaciones) {
          actualizacionResumen.empleados_asignados = admin.firestore.FieldValue.arrayRemove(idEmpleado);
        }
        t.set(resumenRef, actualizacionResumen, { merge: true });
      }
    });

    res.status(200).json({ success: true, message: 'Asignación semanal eliminada correctamente.' });
  } catch (error) {
    const status = Number(error.status) || 400;
    res.status(status).json({ success: false, message: error.message || 'No fue posible eliminar la asignación semanal.' });
  }
});

// Materializa la plantilla semanal en programacion_diaria para cada día operativo.
// Es el puente hacia abordajes y métricas (que leen programacion_diaria).
// Idempotente: preserva total_abordados y creado_en de documentos existentes.
router.post('/programacion-semanal/materializar', autorizar('programacion_semanal:crear'), async (req, res) => {
  try {
    const semanaKey = normalizarSemanaKey(req.body?.semana);

    const asignacionesSnap = await db.collection('programacion_semanal')
      .where('semana', '==', semanaKey)
      .get();

    if (asignacionesSnap.empty) {
      return res.status(200).json({
        success: true,
        semana: semanaKey,
        message: 'No hay asignaciones semanales para materializar.',
        dias_generados: 0,
        documentos: 0,
      });
    }

    await precargarCacheDiasOperacionTurnos();

    // Agrupar asignaciones por ruta + turno.
    const grupos = new Map();
    asignacionesSnap.forEach((doc) => {
      const data = doc.data() || {};
      const rutaId = textoNormalizado(data.ruta_id);
      const turnoId = turnoNormalizado(data.turno_id);
      if (!rutaId) {
        return;
      }
      const clave = `${rutaId}__${turnoId}`;
      if (!grupos.has(clave)) {
        grupos.set(clave, { rutaId, turnoId, items: [] });
      }
      grupos.get(clave).items.push(data);
    });

    const rutasCache = new Map();
    const objetivos = [];

    for (const grupo of grupos.values()) {
      if (!rutasCache.has(grupo.rutaId)) {
        rutasCache.set(grupo.rutaId, await resolverRutaPorIdentificador(grupo.rutaId));
      }
      const rutaEnc = rutasCache.get(grupo.rutaId);
      if (!rutaEnc) {
        continue;
      }

      const rutaData = rutaEnc.data || {};
      const unidad = resolverUnidadTurno(rutaData, grupo.turnoId);
      const capacidad = Number(unidad.capacidad) || Number(rutaData.capacidad_real) || 0;

      // Mapa `pasajeros` desnormalizado del grupo.
      const pasajerosCrudo = {};
      grupo.items.forEach((item) => {
        const idEmp = textoNormalizado(item.id_empleado);
        if (!idEmp) {
          return;
        }
        const asientoItem = Number(item.asiento);
        pasajerosCrudo[idEmp] = {
          nombre: textoNormalizado(item.empleado_nombre) || idEmp,
          asiento: Number.isInteger(asientoItem) && asientoItem > 0 ? asientoItem : null,
          parada_id: item.parada?.id || null,
          parada_orden: Number.isInteger(Number(item.parada?.orden)) ? Number(item.parada.orden) : null,
        };
      });

      const detalle = normalizarPasajerosDetalle(pasajerosCrudo);
      const idsEmpleados = Object.keys(detalle);
      const asientosPorEmpleado = {};
      const asientosReservados = [];
      idsEmpleados.forEach((id) => {
        const asientoDetalle = detalle[id].asiento;
        if (Number.isInteger(asientoDetalle) && asientoDetalle > 0) {
          asientosPorEmpleado[id] = asientoDetalle;
          asientosReservados.push(asientoDetalle);
        }
      });
      asientosReservados.sort((a, b) => a - b);

      const vehiculoSnapshot = {
        id: unidad.id || null,
        codigo: unidad.codigo || null,
        tipo: unidad.tipo || null,
        capacidad: capacidad || null,
      };

      fechasOperacionSemana(semanaKey, grupo.turnoId).forEach((fecha) => {
        const docId = `${fecha}_${grupo.turnoId}_${rutaEnc.id}`;
        objetivos.push({
          ref: db.collection('programacion_diaria').doc(docId),
          roster: {
            fecha,
            turno: grupo.turnoId || null,
            turno_id: grupo.turnoId || null,
            id_ruta: rutaEnc.id,
            ruta_numero: Number(rutaData.ruta) || Number(rutaData.numero) || null,
            capacidad_limite: capacidad || null,
            vehiculo: vehiculoSnapshot,
            zona: rutaData.zona || rutaData.nombre || null,
            tipo_unidad: unidad.tipo || rutaData.tipo_unidad || rutaData['tipo de unidad'] || null,
            estado: 'activa',
            pasajeros: detalle,
            pasajeros_ids: idsEmpleados,
            asientos_por_empleado: asientosPorEmpleado,
            asientos_reservados: asientosReservados,
            asientos_ocupados: idsEmpleados.length,
            origen: 'materializacion_semanal',
            semana_origen: semanaKey,
          },
        });
      });
    }

    if (!objetivos.length) {
      return res.status(200).json({
        success: true,
        semana: semanaKey,
        message: 'No se generaron documentos. Verifica que las rutas tengan turnos operativos.',
        dias_generados: 0,
        documentos: 0,
      });
    }

    // Lee los docs existentes para preservar contadores de abordaje (idempotencia).
    const existentes = await Promise.all(objetivos.map((obj) => obj.ref.get()));

    const BATCH_SIZE = 400;
    for (let inicio = 0; inicio < objetivos.length; inicio += BATCH_SIZE) {
      const lote = objetivos.slice(inicio, inicio + BATCH_SIZE);
      const batch = db.batch();
      lote.forEach((obj, indiceLocal) => {
        const docPrevio = existentes[inicio + indiceLocal];
        const dataPrevia = docPrevio.exists ? (docPrevio.data() || {}) : {};
        batch.set(obj.ref, {
          ...obj.roster,
          total_abordados: Number(dataPrevia.total_abordados) || 0,
          creado_en: dataPrevia.creado_en || new Date(),
          creado_por: dataPrevia.creado_por || req.usuario.uid,
          actualizado_en: new Date(),
          actualizado_por: req.usuario.uid,
        });
      });
      await batch.commit();
    }

    const diasUnicos = new Set(objetivos.map((obj) => obj.roster.fecha));

    res.status(200).json({
      success: true,
      semana: semanaKey,
      message: `Operación materializada: ${objetivos.length} programación(es) diaria(s) en ${diasUnicos.size} día(s).`,
      dias_generados: diasUnicos.size,
      documentos: objetivos.length,
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    res.status(status).json({ success: false, message: error.message || 'No fue posible materializar la operación semanal.' });
  }
});

// ==========================================
// ABORDAJES (pase de lista con contador transaccional)
// ==========================================

// Registrar abordaje: escribe el doc de la subcolección Y actualiza el
// contador total_abordados del padre en la MISMA transacción (patrón increment).
router.post('/abordajes', autorizar('abordajes:registrar'), async (req, res) => {
  try {
    const { fecha, id_ruta, ruta_id, turno, id_empleado, abordo } = req.body || {};

    const fechaOperacion = textoNormalizado(fecha) || fechaISOHoy();
    let idRuta = textoNormalizado(id_ruta || ruta_id);
    let turnoOperacion = turnoNormalizado(turno);
    const idEmpleado = textoNormalizado(id_empleado);
    const abordoFinal = abordo !== false;

    if (!idEmpleado) {
      return res.status(400).json({
        success: false,
        message: 'id_empleado es requerido.'
      });
    }

    if (req.usuario?.rol === ROLES.CAMIONERO) {
      const asignacion = normalizarAsignacionUnidadTurno(req.usuario?.asignacion_unidad_turno);
      if (!asignacion) {
        return res.status(403).json({
          success: false,
          message: 'No tienes una unidad y turno asignados. Contacta al administrador.',
        });
      }

      if (!turnoOperacion) {
        turnoOperacion = asignacion.turno_id;
      } else if (turnoOperacion !== asignacion.turno_id) {
        return res.status(403).json({
          success: false,
          message: 'El turno indicado no coincide con tu asignación operativa.',
        });
      }

      if (!idRuta) {
        const resolucion = await resolverRutaEmpleadoPorUnidadTurno(
          fechaOperacion,
          turnoOperacion,
          asignacion.vehiculo_id,
          idEmpleado
        );
        idRuta = resolucion.id_ruta;
      }
    }

    if (!idRuta) {
      return res.status(400).json({
        success: false,
        message: 'id_ruta es requerido.'
      });
    }

    const rutaEncontrada = await resolverRutaPorIdentificador(idRuta);
    if (!rutaEncontrada) {
      return res.status(404).json({ success: false, message: 'La ruta seleccionada no existe.' });
    }

    let resultado = null;

    await db.runTransaction(async (t) => {
      const programacion = await resolverProgramacion(fechaOperacion, rutaEncontrada.id, turnoOperacion, t);
      if (!programacion.data) {
        throw crearErrorHttp(404, 'No hay programación registrada para esa ruta, fecha y turno.');
      }

      if (esProgramacionCancelada(programacion.data)) {
        throw crearErrorHttp(409, 'La programación está cancelada; no se pueden registrar abordajes.');
      }

      if (req.usuario?.rol === ROLES.CAMIONERO) {
        const asignacion = normalizarAsignacionUnidadTurno(req.usuario?.asignacion_unidad_turno);
        if (!asignacion || !validarVehiculoProgramacionCoincide(asignacion.vehiculo_id, programacion.data)) {
          throw crearErrorHttp(403, 'No puedes registrar abordajes para empleados de otra unidad.');
        }
      }

      const pasajeros = extraerPasajerosProgramacion(programacion.data);
      const detalle = pasajeros.detalle[idEmpleado];
      if (!detalle) {
        throw crearErrorHttp(409, 'El empleado no está asignado a esta ruta en la fecha indicada.');
      }

      const abordajeRef = programacion.docRef.collection('abordajes').doc(idEmpleado);
      const abordajePrevio = await t.get(abordajeRef);
      const abordoPrevio = abordajePrevio.exists && abordajePrevio.data()?.abordo === true;

      // Delta del contador: solo cambia si el estado abordo cambió.
      let delta = 0;
      if (abordoFinal && !abordoPrevio) {
        delta = 1;
      } else if (!abordoFinal && abordoPrevio) {
        delta = -1;
      }

      // Desnormalización: nombre y parada duplicados en el abordaje para que
      // los reportes históricos no toquen `usuarios`.
      t.set(abordajeRef, {
        id_empleado: idEmpleado,
        nombre: detalle.nombre || idEmpleado,
        parada: detalle.parada_id ? { id: detalle.parada_id, orden: detalle.parada_orden ?? null } : null,
        asiento: detalle.asiento ?? null,
        abordo: abordoFinal,
        hora_abordaje: abordoFinal ? new Date() : null,
        registrado_por: req.usuario.uid,
        actualizado_en: new Date()
      }, { merge: true });

      if (delta !== 0) {
        t.set(programacion.docRef, {
          total_abordados: admin.firestore.FieldValue.increment(delta),
          actualizado_en: new Date(),
          actualizado_por: req.usuario.uid
        }, { merge: true });
      }

      const capacidad = Number(programacion.data.capacidad_limite)
        || Number(programacion.data.vehiculo?.capacidad)
        || 0;

      resultado = {
        programacion_id: programacion.docId,
        id_empleado: idEmpleado,
        abordo: abordoFinal,
        total_abordados: Math.max((Number(programacion.data.total_abordados) || 0) + delta, 0),
        capacidad,
        fecha: fechaOperacion,
        turno: turnoOperacion || null
      };
    });

    res.status(200).json({
      success: true,
      message: 'Abordaje registrado correctamente.',
      data: resultado
    });
  } catch (error) {
    const status = Number(error.status) || 400;
    res.status(status).json({ success: false, message: error.message || 'No fue posible registrar el abordaje.' });
  }
});

// Manifiesto del chofer + estado de abordajes — lecturas mínimas
// (GET directo por docId determinista + subcolección; sin resolver usuarios)
router.get('/abordajes', autorizar('abordajes:ver'), async (req, res) => {
  try {
    const fechaOperacion = textoNormalizado(req.query.fecha) || fechaISOHoy();
    const idRuta = textoNormalizado(req.query.id_ruta || req.query.ruta_id);
    const turnoOperacion = turnoNormalizado(req.query.turno);

    if (!idRuta) {
      return res.status(400).json({ success: false, message: 'id_ruta es requerido.' });
    }

    const rutaEncontrada = await resolverRutaPorIdentificador(idRuta);
    if (!rutaEncontrada) {
      return res.status(404).json({ success: false, message: 'La ruta seleccionada no existe.' });
    }

    const programacion = await resolverProgramacion(fechaOperacion, rutaEncontrada.id, turnoOperacion);
    if (!programacion.data) {
      return res.status(200).json({
        success: true,
        fecha: fechaOperacion,
        turno: turnoOperacion || null,
        data: null
      });
    }

    const abordajesSnapshot = await programacion.docRef.collection('abordajes').get();
    const abordajesPorEmpleado = new Map();
    abordajesSnapshot.forEach((doc) => abordajesPorEmpleado.set(doc.id, doc.data() || {}));

    const pasajeros = extraerPasajerosProgramacion(programacion.data);
    const paradasRuta = Array.isArray(rutaEncontrada.data.paradas)
      ? [...rutaEncontrada.data.paradas].sort((a, b) => (a?.orden ?? 0) - (b?.orden ?? 0))
      : [];

    // Manifiesto agrupado por parada: todo estaba embebido, cero lecturas extra.
    const manifiesto = pasajeros.ids.map((idEmpleado) => {
      const detalle = pasajeros.detalle[idEmpleado] || {};
      const abordaje = abordajesPorEmpleado.get(idEmpleado) || null;
      return {
        id_empleado: idEmpleado,
        nombre: detalle.nombre || idEmpleado,
        asiento: detalle.asiento ?? null,
        parada_id: detalle.parada_id || null,
        abordo: abordaje?.abordo === true,
        hora_abordaje: abordaje?.hora_abordaje || null
      };
    });

    res.status(200).json({
      success: true,
      fecha: fechaOperacion,
      turno: turnoOperacion || null,
      data: {
        programacion_id: programacion.docId,
        ruta_id: rutaEncontrada.id,
        estado: programacion.data.estado || 'activa',
        capacidad_limite: Number(programacion.data.capacidad_limite)
          || Number(programacion.data.vehiculo?.capacidad)
          || null,
        vehiculo: programacion.data.vehiculo || null,
        total_asignados: pasajeros.total,
        total_abordados: Number(programacion.data.total_abordados) || 0,
        paradas: paradasRuta,
        manifiesto
      }
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    res.status(status).json({ success: false, message: error.message || 'No fue posible consultar los abordajes.' });
  }
});

// ==========================================
// MÉTRICAS DIARIAS (rollup + lectura)
// ==========================================

/**
 * Construye y materializa metricas_diarias/{fecha} con UNA sola query
 * de programacion_diaria (sin N+1). Reutilizable por el endpoint y por cron.
 */
async function ejecutarRollupMetricasDiarias(fecha, uidEjecutor = 'rollup-job') {
  const fechaOperacion = textoNormalizado(fecha) || fechaISOHoy();

  const snapshot = await db.collection('programacion_diaria')
    .where('fecha', '==', fechaOperacion)
    .get();

  const rutas = {};
  const totales = {
    rutas_programadas: 0,
    rutas_activas: 0,
    rutas_canceladas: 0,
    asignados: 0,
    abordados: 0
  };

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const idRuta = textoNormalizado(data.id_ruta);
    if (!idRuta) {
      return;
    }

    const pasajeros = extraerPasajerosProgramacion(data);
    const capacidad = Number(data.capacidad_limite) || Number(data.vehiculo?.capacidad) || 0;
    const asignados = Number.isFinite(Number(data.asientos_ocupados))
      ? Number(data.asientos_ocupados)
      : pasajeros.total;
    const abordados = Number(data.total_abordados) || 0;
    const cancelada = esProgramacionCancelada(data);

    rutas[idRuta] = {
      numero: Number(data.ruta_numero) || null,
      turno_id: turnoNormalizado(data.turno_id || data.turno) || null,
      capacidad,
      asignados,
      abordados,
      ocupacion_pct: capacidad > 0 ? Math.round((asignados / capacidad) * 1000) / 10 : 0,
      estado: cancelada ? 'cancelada' : 'activa'
    };

    totales.rutas_programadas += 1;
    if (cancelada) {
      totales.rutas_canceladas += 1;
    } else {
      totales.rutas_activas += 1;
      totales.asignados += asignados;
      totales.abordados += abordados;
    }
  });

  const payload = {
    fecha: fechaOperacion,
    rutas,
    totales,
    generado_en: new Date(),
    generado_por: uidEjecutor
  };

  await db.collection('metricas_diarias').doc(fechaOperacion).set(payload);
  return payload;
}

// Rollup manual/cron: materializa el agregado del día (idempotente)
router.post('/metricas/rollup', autorizar('metricas:rollup'), async (req, res) => {
  try {
    const fecha = textoNormalizado(req.body?.fecha) || fechaISOHoy();
    const payload = await ejecutarRollupMetricasDiarias(fecha, req.usuario.uid);

    res.status(200).json({
      success: true,
      message: `Métricas de ${payload.fecha} materializadas correctamente.`,
      data: payload
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    res.status(status).json({ success: false, message: error.message || 'No fue posible generar las métricas.' });
  }
});

// Lectura del agregado: el dashboard pasa de leer cientos de docs a 1 lectura
router.get('/metricas/diarias', autorizar('metricas:ver'), async (req, res) => {
  try {
    const fecha = textoNormalizado(req.query.fecha) || fechaISOHoy();
    const doc = await db.collection('metricas_diarias').doc(fecha).get();

    res.status(200).json({
      success: true,
      fecha,
      data: doc.exists ? doc.data() : null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'No fue posible consultar las métricas diarias.' });
  }
});

// Rango histórico: N días = N lecturas (no N x rutas x pasajeros)
router.get('/metricas/diarias/rango', autorizar('metricas:ver'), async (req, res) => {
  try {
    const desde = textoNormalizado(req.query.desde);
    const hasta = textoNormalizado(req.query.hasta);

    if (!desde || !hasta) {
      return res.status(400).json({ success: false, message: 'desde y hasta (YYYY-MM-DD) son requeridos.' });
    }

    const snapshot = await db.collection('metricas_diarias')
      .where('fecha', '>=', desde)
      .where('fecha', '<=', hasta)
      .get();

    const data = snapshot.docs
      .map((doc) => doc.data())
      .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

    res.status(200).json({
      success: true,
      desde,
      hasta,
      cantidad: data.length,
      data
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'No fue posible consultar el rango de métricas.' });
  }
});

module.exports = router;
module.exports.ejecutarRollupMetricasDiarias = ejecutarRollupMetricasDiarias;
