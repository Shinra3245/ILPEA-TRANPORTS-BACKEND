/**
 * Migra asignaciones camionero→ruta al modelo camionero→(unidad + turno).
 *
 * - Lee camioneros con ruta_asignada_id
 * - Toma el primer turno con unidad en rutas.unidad_por_turno
 * - Crea asignacion_unidad_turno y camionero_por_turno en vehiculos
 * - Limpia ruta_asignada_* y rutas.camionero
 *
 * Uso:
 *   node backend/scripts/migrar-camioneros-unidad-turno.js
 *   node backend/scripts/migrar-camioneros-unidad-turno.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const {
  admin,
  db,
  textoNormalizado,
  turnoNormalizado,
  asignarCamioneroUnidadTurno,
} = require('../src/lib/utils');

const dryRun = process.argv.includes('--dry-run');

function resolverPrimeraUnidadTurno(rutaData = {}) {
  const mapa = rutaData.unidad_por_turno && typeof rutaData.unidad_por_turno === 'object'
    ? rutaData.unidad_por_turno
    : {};

  const turnos = Object.keys(mapa).sort();
  for (const turnoId of turnos) {
    const unidad = mapa[turnoId];
    const vehiculoId = textoNormalizado(unidad?.vehiculo_id || unidad?.id);
    if (vehiculoId) {
      return {
        turno_id: turnoNormalizado(turnoId),
        vehiculo_id: vehiculoId,
      };
    }
  }

  return null;
}

async function limpiarRutaCamionero(rutaId, camioneroUid) {
  if (!rutaId) {
    return;
  }

  const rutaRef = db.collection('rutas').doc(rutaId);
  const rutaSnap = await rutaRef.get();
  if (!rutaSnap.exists) {
    return;
  }

  const camioneroRuta = rutaSnap.data()?.camionero;
  if (!camioneroRuta || camioneroRuta.uid !== camioneroUid) {
    return;
  }

  if (!dryRun) {
    await rutaRef.set({
      camionero: null,
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
      actualizado_por: 'migrar-camioneros-unidad-turno',
    }, { merge: true });
  }
}

async function migrar() {
  const snapshot = await db.collection('usuarios').where('rol', '==', 'CAMIONERO').get();
  const stats = {
    total: snapshot.size,
    migrados: 0,
    sin_unidad: [],
    sin_ruta: 0,
    ya_migrados: 0,
    limpiados: 0,
  };

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const uid = doc.id;

    if (data.asignacion_unidad_turno?.vehiculo_id && data.asignacion_unidad_turno?.turno_id) {
      stats.ya_migrados += 1;
      continue;
    }

    const rutaAsignadaId = textoNormalizado(data.ruta_asignada_id);
    if (!rutaAsignadaId) {
      stats.sin_ruta += 1;
      continue;
    }

    const rutaSnap = await db.collection('rutas').doc(rutaAsignadaId).get();
    if (!rutaSnap.exists) {
      stats.sin_unidad.push({
        uid,
        id_camionero: data.id_camionero || uid,
        motivo: `Ruta ${rutaAsignadaId} no encontrada`,
      });
      continue;
    }

    const unidadTurno = resolverPrimeraUnidadTurno(rutaSnap.data() || {});
    if (!unidadTurno) {
      stats.sin_unidad.push({
        uid,
        id_camionero: data.id_camionero || uid,
        motivo: `Ruta ${rutaAsignadaId} sin unidad_por_turno`,
      });
      continue;
    }

    if (!dryRun) {
      await asignarCamioneroUnidadTurno({
        camioneroUid: uid,
        vehiculoId: unidadTurno.vehiculo_id,
        turnoId: unidadTurno.turno_id,
        solicitanteUid: 'migrar-camioneros-unidad-turno',
      });

      await doc.ref.set({
        ruta_asignada_id: admin.firestore.FieldValue.delete(),
        ruta_asignada_numero: admin.firestore.FieldValue.delete(),
        ruta_asignada_nombre: admin.firestore.FieldValue.delete(),
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
        actualizado_por: 'migrar-camioneros-unidad-turno',
      }, { merge: true });

      await limpiarRutaCamionero(rutaAsignadaId, uid);
    }

    stats.migrados += 1;
  }

  const rutasSnapshot = await db.collection('rutas').get();
  for (const rutaDoc of rutasSnapshot.docs) {
    if (!rutaDoc.data()?.camionero) {
      continue;
    }

    if (!dryRun) {
      await rutaDoc.ref.set({
        camionero: null,
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
        actualizado_por: 'migrar-camioneros-unidad-turno',
      }, { merge: true });
    }
    stats.limpiados += 1;
  }

  console.log(`Modo: ${dryRun ? 'dry-run' : 'aplicado'}`);
  console.log(`Camioneros totales: ${stats.total}`);
  console.log(`Migrados a unidad+turno: ${stats.migrados}`);
  console.log(`Ya migrados previamente: ${stats.ya_migrados}`);
  console.log(`Sin ruta asignada: ${stats.sin_ruta}`);
  console.log(`Rutas con camionero limpiado: ${stats.limpiados}`);

  if (stats.sin_unidad.length) {
    console.log('Camioneros sin unidad derivable (requieren asignación manual):');
    stats.sin_unidad.forEach((item) => {
      console.log(`  - ${item.id_camionero} (${item.uid}): ${item.motivo}`);
    });
  }
}

migrar()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en migración:', error.message);
    process.exit(1);
  });
