/**
 * Generación y limpieza de datos de prueba para el panel admin.
 * Todo lo creado lleva es_datos_prueba: true para poder eliminarse sin afectar datos reales.
 */

const crypto = require('crypto');
const { ROLES } = require('../config/roles');
const {
  admin,
  db,
  textoNormalizado,
  turnoNormalizado,
  eliminarUsuarioDefinitivo,
  asignarCamioneroUnidadTurno,
  limpiarAsignacionCamionero,
  resolverUnidadTurno,
  obtenerNumeroSemanaISO,
  precargarCacheDiasOperacionTurnos,
  crearErrorHttp,
  liberarAsignacionesPorIdEmpleado,
  esRutaActiva,
} = require('./utils');

const CONFIG_REF = db.collection('config').doc('datos_prueba');
const LOTE_MARCA = 'ilpea_datos_prueba';
const PASSWORD_PRUEBA = 'IlpeaPrueba123!';

function obtenerSemanaISOKey(fechaReferencia = new Date()) {
  const fecha = new Date(fechaReferencia);
  const semana = obtenerNumeroSemanaISO(fecha);
  const fechaUTC = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
  const diaSemana = fechaUTC.getUTCDay() || 7;
  fechaUTC.setUTCDate(fechaUTC.getUTCDate() + 4 - diaSemana);
  const anioISO = fechaUTC.getUTCFullYear();
  return `${anioISO}-W${semana}`;
}

function sufijoUnico() {
  return crypto.randomBytes(3).toString('hex');
}

async function leerEstadoDatosPrueba() {
  const doc = await CONFIG_REF.get();
  if (!doc.exists) {
    return { activo: false, lote: LOTE_MARCA };
  }

  const data = doc.data() || {};
  return {
    activo: data.activo === true,
    lote: textoNormalizado(data.lote) || LOTE_MARCA,
    semana: data.semana || null,
    creado_en: data.creado_en || null,
    resumen: data.resumen || null,
  };
}

async function crearUsuarioPrueba({ email, nombre, rol, extras = {}, creadoPor }) {
  const userRecord = await admin.auth().createUser({
    email: String(email).trim(),
    password: PASSWORD_PRUEBA,
    displayName: String(nombre).trim(),
  });

  await db.collection('usuarios').doc(userRecord.uid).set({
    email: String(email).trim(),
    nombre: String(nombre).trim(),
    rol,
    activo: true,
    es_datos_prueba: true,
    lote_prueba: LOTE_MARCA,
    creado_por: creadoPor,
    creado_en: new Date(),
    actualizado_en: null,
    ...extras,
  });

  return {
    uid: userRecord.uid,
    email: String(email).trim(),
    nombre: String(nombre).trim(),
    rol,
    ...extras,
  };
}

async function generarIdEmpleadoPrueba() {
  for (let intento = 0; intento < 20; intento += 1) {
    const candidato = `EMP-DEMO-${crypto.randomInt(1000, 9999)}`;
    const existe = await db.collection('usuarios')
      .where('id_empleado', '==', candidato)
      .limit(1)
      .get();
    if (existe.empty) {
      return candidato;
    }
  }
  throw new Error('No se pudo generar un id_empleado de prueba único.');
}

async function generarIdCamioneroPrueba() {
  for (let intento = 0; intento < 20; intento += 1) {
    const candidato = `CAM-DEMO-${crypto.randomInt(1000, 9999)}`;
    const existe = await db.collection('usuarios')
      .where('id_camionero', '==', candidato)
      .limit(1)
      .get();
    if (existe.empty) {
      return candidato;
    }
  }
  throw new Error('No se pudo generar un id_camionero de prueba único.');
}

async function obtenerRutasActivas(limite = 2) {
  const snapshot = await db.collection('rutas').get();
  const rutas = [];

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    if (!esRutaActiva(data) || data.eliminada === true) {
      return;
    }
    rutas.push({ id: doc.id, data });
  });

  rutas.sort((a, b) => Number(a.data.ruta) - Number(b.data.ruta));
  return rutas.slice(0, limite);
}

async function obtenerTurnoOperativo() {
  const snapshot = await db.collection('turnos').limit(20).get();
  if (snapshot.empty) {
    return null;
  }

  const turnos = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((turno) => turno.activo !== false);

  return turnos[0] || null;
}

async function obtenerAsientosOcupados(semanaKey, rutaId, turnoId, excluirDocId = null) {
  const snapshot = await db.collection('programacion_semanal')
    .where('semana', '==', semanaKey)
    .where('ruta_id', '==', rutaId)
    .get();

  const ocupados = new Set();
  snapshot.forEach((doc) => {
    if (doc.id === excluirDocId) {
      return;
    }
    const data = doc.data() || {};
    if (turnoNormalizado(data.turno_id) !== turnoNormalizado(turnoId)) {
      return;
    }
    const asiento = Number(data.asiento);
    if (Number.isInteger(asiento) && asiento > 0) {
      ocupados.add(asiento);
    }
  });

  return ocupados;
}

function resolverPrimerAsientoLibre(capacidad, ocupados) {
  const limite = Number(capacidad) || 0;
  if (limite <= 0) {
    return null;
  }

  for (let asiento = 1; asiento <= limite; asiento += 1) {
    if (!ocupados.has(asiento)) {
      return asiento;
    }
  }

  return null;
}

async function crearAsignacionSemanalPrueba({
  semanaKey,
  empleado,
  ruta,
  turnoId,
  turnoNombre,
  asiento,
  creadoPor,
}) {
  const docId = `${semanaKey}_${empleado.id_empleado}_${turnoId}`;
  const asignacionRef = db.collection('programacion_semanal').doc(docId);
  const resumenRef = db.collection('resumen_semanal').doc(semanaKey);
  const rutaData = ruta.data || {};
  const unidad = resolverUnidadTurno(rutaData, turnoId);
  const capacidad = Number(unidad.capacidad) || Number(rutaData.capacidad_real) || 0;
  const rutaNombre = textoNormalizado(rutaData.nombre)
    || (rutaData.zona ? `Ruta ${rutaData.ruta} - ${rutaData.zona}` : `Ruta ${rutaData.ruta}`);

  await db.runTransaction(async (t) => {
    const [asignacionPrevia, resumenPrevio] = await Promise.all([
      t.get(asignacionRef),
      t.get(resumenRef),
    ]);

    const payload = {
      semana: semanaKey,
      id_empleado: empleado.id_empleado,
      empleado_uid: empleado.uid,
      empleado_nombre: empleado.nombre,
      ruta_id: ruta.id,
      ruta_numero: Number(rutaData.ruta) || null,
      ruta_nombre: rutaNombre,
      turno_id: turnoId,
      turno_nombre: turnoNombre || turnoId,
      asiento: asiento || null,
      unidad: {
        vehiculo_id: unidad.id || null,
        tipo: unidad.tipo || null,
        codigo: unidad.codigo || null,
        capacidad: capacidad || null,
      },
      es_datos_prueba: true,
      lote_prueba: LOTE_MARCA,
      creado_por: creadoPor,
      creado_en: asignacionPrevia.exists ? (asignacionPrevia.data()?.creado_en || new Date()) : new Date(),
      actualizado_en: new Date(),
      actualizado_por: creadoPor,
    };

    t.set(asignacionRef, payload, { merge: true });

    t.set(db.collection('usuarios').doc(empleado.uid), {
      [`asignaciones_semana.${turnoId}`]: {
        semana: semanaKey,
        ruta_id: ruta.id,
        ruta_nombre: rutaNombre,
        turno_id: turnoId,
        turno_nombre: turnoNombre || turnoId,
        asiento: asiento || null,
      },
      asignacion_actual: {
        semana: semanaKey,
        ruta_id: ruta.id,
        ruta_nombre: rutaNombre,
        turno_id: turnoId,
        turno_nombre: turnoNombre || turnoId,
      },
      actualizado_en: new Date(),
    }, { merge: true });

    const resumenData = resumenPrevio.exists ? (resumenPrevio.data() || {}) : {};
    const porRuta = { ...(resumenData.por_ruta || {}) };
    const rutaPrevia = asignacionPrevia.exists
      ? textoNormalizado(asignacionPrevia.data()?.ruta_id)
      : null;

    if (rutaPrevia && rutaPrevia !== ruta.id) {
      porRuta[rutaPrevia] = Math.max((Number(porRuta[rutaPrevia]) || 0) - 1, 0);
    }
    if (!asignacionPrevia.exists || rutaPrevia !== ruta.id) {
      porRuta[ruta.id] = (Number(porRuta[ruta.id]) || 0) + 1;
    }

    t.set(resumenRef, {
      semana: semanaKey,
      empleados_asignados: admin.firestore.FieldValue.arrayUnion(empleado.id_empleado),
      total: asignacionPrevia.exists
        ? (Number(resumenData.total) || 0)
        : admin.firestore.FieldValue.increment(1),
      por_ruta: porRuta,
      actualizado_en: new Date(),
    }, { merge: true });
  });

  return docId;
}

async function eliminarAsignacionSemanalPrueba(docId) {
  const asignacionRef = db.collection('programacion_semanal').doc(docId);

  await db.runTransaction(async (t) => {
    const asignacionDoc = await t.get(asignacionRef);
    if (!asignacionDoc.exists) {
      return;
    }

    const data = asignacionDoc.data() || {};
    if (data.es_datos_prueba !== true) {
      throw crearErrorHttp(409, 'La asignación no pertenece al lote de datos de prueba.');
    }

    const semanaKey = textoNormalizado(data.semana);
    const idEmpleado = textoNormalizado(data.id_empleado);
    const rutaId = textoNormalizado(data.ruta_id);
    const turnoIdEliminado = turnoNormalizado(data.turno_id);
    const resumenRef = db.collection('resumen_semanal').doc(semanaKey);

    let empleadoRef = null;
    if (data.empleado_uid) {
      empleadoRef = db.collection('usuarios').doc(data.empleado_uid);
    }

    const [resumenDoc, otrasAsignacionesSnap, empleadoDoc] = await Promise.all([
      t.get(resumenRef),
      t.get(db.collection('programacion_semanal')
        .where('semana', '==', semanaKey)
        .where('id_empleado', '==', idEmpleado)),
      empleadoRef ? t.get(empleadoRef) : Promise.resolve(null),
    ]);

    const quedanOtrasAsignaciones = otrasAsignacionesSnap.docs.some((doc) => doc.id !== docId);
    t.delete(asignacionRef);

    if (empleadoRef && empleadoDoc?.exists) {
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
      if (!quedanOtrasAsignaciones && idEmpleado) {
        actualizacionResumen.empleados_asignados = admin.firestore.FieldValue.arrayRemove(idEmpleado);
      }
      t.set(resumenRef, actualizacionResumen, { merge: true });
    }
  });
}

async function vehiculoTurnoDisponible(vehiculoId, turnoId) {
  const vehiculoDoc = await db.collection('vehiculos').doc(vehiculoId).get();
  if (!vehiculoDoc.exists) {
    return false;
  }

  const data = vehiculoDoc.data() || {};
  const camioneroPorTurno = data.camionero_por_turno && typeof data.camionero_por_turno === 'object'
    ? data.camionero_por_turno
    : {};

  const asignado = camioneroPorTurno[turnoNormalizado(turnoId)];
  return !asignado?.uid;
}

async function rollbackGeneracion(manifest) {
  for (const docId of manifest.asignaciones_semanal || []) {
    try {
      await eliminarAsignacionSemanalPrueba(docId);
    } catch {
      // Ignorar errores parciales en rollback
    }
  }

  for (const item of manifest.camioneros_asignaciones || []) {
    try {
      const camioneroDoc = await db.collection('usuarios').doc(item.uid).get();
      if (camioneroDoc.exists) {
        await limpiarAsignacionCamionero(item.uid, camioneroDoc.data() || {}, manifest.creado_por);
      }
    } catch {
      // Continuar limpiando
    }
  }

  const usuarios = [...(manifest.usuarios || [])].reverse();
  for (const usuario of usuarios) {
    try {
      await eliminarUsuarioDefinitivo({
        uid: usuario.uid,
        rolEsperado: usuario.rol,
        usuarioSolicitante: { uid: manifest.creado_por, rol: ROLES.ADMIN },
        validarPermisoEmpleado: false,
      });
    } catch {
      // Continuar
    }
  }

  await CONFIG_REF.delete().catch(() => {});
}

async function generarDatosPrueba(creadoPor) {
  const estadoActual = await leerEstadoDatosPrueba();
  if (estadoActual.activo) {
    throw crearErrorHttp(409, 'Ya hay datos de prueba activos. Presiona de nuevo para eliminarlos.');
  }

  const sufijo = sufijoUnico();
  const semanaKey = obtenerSemanaISOKey();
  const manifest = {
    activo: true,
    lote: LOTE_MARCA,
    semana: semanaKey,
    creado_por: creadoPor,
    creado_en: new Date(),
    usuarios: [],
    asignaciones_semanal: [],
    camioneros_asignaciones: [],
    resumen: {},
  };

  const rutas = await obtenerRutasActivas(2);
  const turno = await obtenerTurnoOperativo();

  if (!rutas.length) {
    throw crearErrorHttp(400, 'No hay rutas activas en el sistema. Crea al menos una ruta antes de generar datos de prueba.');
  }

  if (!turno?.id) {
    throw crearErrorHttp(400, 'No hay turnos configurados. Crea al menos un turno antes de generar datos de prueba.');
  }

  await precargarCacheDiasOperacionTurnos();

  const turnoId = turnoNormalizado(turno.id);
  const turnoNombre = textoNormalizado(turno.nombre) || turnoId;

  try {
    const jefe1 = await crearUsuarioPrueba({
      email: `demo.jefe.norte.${sufijo}@ilpea.demo`,
      nombre: 'Jefe Prueba Norte',
      rol: ROLES.JEFE,
      creadoPor,
    });
    manifest.usuarios.push(jefe1);

    const jefe2 = await crearUsuarioPrueba({
      email: `demo.jefe.sur.${sufijo}@ilpea.demo`,
      nombre: 'Jefe Prueba Sur',
      rol: ROLES.JEFE,
      creadoPor,
    });
    manifest.usuarios.push(jefe2);

    const empleadosDef = [
      { nombre: 'Empleado Prueba Ana', jefe: jefe1, ruta: rutas[0] },
      { nombre: 'Empleado Prueba Luis', jefe: jefe1, ruta: rutas[0] },
      { nombre: 'Empleado Prueba María', jefe: jefe2, ruta: rutas[1] || rutas[0] },
      { nombre: 'Empleado Prueba Carlos', jefe: jefe2, ruta: rutas[1] || rutas[0] },
    ];

    for (const def of empleadosDef) {
      const idEmpleado = await generarIdEmpleadoPrueba();
      const empleado = await crearUsuarioPrueba({
        email: `demo.empleado.${idEmpleado.toLowerCase()}.${sufijo}@ilpea.demo`,
        nombre: def.nombre,
        rol: ROLES.EMPLEADO,
        extras: {
          id_empleado: idEmpleado,
          jefe_uid: def.jefe.uid,
          puesto: 'Operador',
          dpto: 'Producción',
          empresa: 'ILPEA',
        },
        creadoPor,
      });
      manifest.usuarios.push(empleado);

      const unidad = resolverUnidadTurno(def.ruta.data, turnoId);
      const capacidad = Number(unidad.capacidad) || Number(def.ruta.data.capacidad_real) || 20;
      const ocupados = await obtenerAsientosOcupados(semanaKey, def.ruta.id, turnoId);
      const asiento = resolverPrimerAsientoLibre(capacidad, ocupados);
      if (asiento) {
        ocupados.add(asiento);
      }

      const docId = await crearAsignacionSemanalPrueba({
        semanaKey,
        empleado: { ...empleado, id_empleado: idEmpleado },
        ruta: def.ruta,
        turnoId,
        turnoNombre,
        asiento,
        creadoPor,
      });
      manifest.asignaciones_semanal.push(docId);
    }

    const camionerosDef = [
      { nombre: 'Camionero Prueba Uno', ruta: rutas[0] },
      { nombre: 'Camionero Prueba Dos', ruta: rutas[1] || rutas[0] },
    ];

    for (const def of camionerosDef) {
      const idCamionero = await generarIdCamioneroPrueba();
      const camionero = await crearUsuarioPrueba({
        email: `demo.camionero.${idCamionero.toLowerCase()}.${sufijo}@ilpea.demo`,
        nombre: def.nombre,
        rol: ROLES.CAMIONERO,
        extras: { id_camionero: idCamionero },
        creadoPor,
      });
      manifest.usuarios.push(camionero);

      const unidad = resolverUnidadTurno(def.ruta.data, turnoId);
      const vehiculoId = textoNormalizado(unidad.id);

      if (vehiculoId && await vehiculoTurnoDisponible(vehiculoId, turnoId)) {
        await asignarCamioneroUnidadTurno({
          camioneroUid: camionero.uid,
          vehiculoId,
          turnoId,
          solicitanteUid: creadoPor,
        });
        manifest.camioneros_asignaciones.push({
          uid: camionero.uid,
          vehiculo_id: vehiculoId,
          turno_id: turnoId,
        });
      }
    }

    manifest.resumen = {
      jefes: 2,
      empleados: empleadosDef.length,
      camioneros: camionerosDef.length,
      asignaciones_semanal: manifest.asignaciones_semanal.length,
      camioneros_asignados: manifest.camioneros_asignaciones.length,
      semana: semanaKey,
      password_demo: PASSWORD_PRUEBA,
    };

    await CONFIG_REF.set(manifest);

    return {
      accion: 'generado',
      activo: true,
      ...manifest.resumen,
    };
  } catch (error) {
    await rollbackGeneracion(manifest);
    throw error;
  }
}

async function eliminarDatosPrueba() {
  const configDoc = await CONFIG_REF.get();
  if (!configDoc.exists || configDoc.data()?.activo !== true) {
    return {
      accion: 'eliminado',
      activo: false,
      eliminados: { usuarios: 0, asignaciones: 0 },
    };
  }

  const manifest = configDoc.data() || {};
  const creadoPor = manifest.creado_por || 'sistema';

  for (const docId of manifest.asignaciones_semanal || []) {
    await eliminarAsignacionSemanalPrueba(docId);
  }

  const empleados = (manifest.usuarios || []).filter((u) => u.rol === ROLES.EMPLEADO);
  for (const empleado of empleados) {
    const idEmpleado = textoNormalizado(empleado.id_empleado);
    if (idEmpleado) {
      await liberarAsignacionesPorIdEmpleado(idEmpleado);
    }
  }

  for (const item of manifest.camioneros_asignaciones || []) {
    const camioneroDoc = await db.collection('usuarios').doc(item.uid).get();
    if (camioneroDoc.exists) {
      await limpiarAsignacionCamionero(item.uid, camioneroDoc.data() || {}, creadoPor);
    }
  }

  const usuariosEliminados = [];
  const ordenRoles = [ROLES.EMPLEADO, ROLES.CAMIONERO, ROLES.JEFE];
  for (const rol of ordenRoles) {
    const grupo = (manifest.usuarios || []).filter((u) => u.rol === rol);
    for (const usuario of grupo) {
      try {
        await eliminarUsuarioDefinitivo({
          uid: usuario.uid,
          rolEsperado: rol,
          usuarioSolicitante: { uid: creadoPor, rol: ROLES.ADMIN },
          validarPermisoEmpleado: false,
        });
        usuariosEliminados.push(usuario.uid);
      } catch (error) {
        if (Number(error.status) !== 404) {
          throw error;
        }
      }
    }
  }

  await CONFIG_REF.delete();

  return {
    accion: 'eliminado',
    activo: false,
    eliminados: {
      usuarios: usuariosEliminados.length,
      asignaciones: (manifest.asignaciones_semanal || []).length,
    },
  };
}

async function alternarDatosPrueba(creadoPor) {
  const estado = await leerEstadoDatosPrueba();
  if (estado.activo) {
    return eliminarDatosPrueba();
  }
  return generarDatosPrueba(creadoPor);
}

module.exports = {
  leerEstadoDatosPrueba,
  alternarDatosPrueba,
  generarDatosPrueba,
  eliminarDatosPrueba,
  LOTE_MARCA,
  PASSWORD_PRUEBA,
};
