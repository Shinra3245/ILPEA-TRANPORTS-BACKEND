/**
 * Migra documentos de programacion_semanal del formato antiguo
 *   {semana}_{id_empleado}
 * al formato nuevo (múltiples turnos por semana):
 *   {semana}_{id_empleado}_{turno_id}
 *
 * Uso:
 *   node backend/scripts/migrar-programacion-semanal-multi-turno.js
 *   node backend/scripts/migrar-programacion-semanal-multi-turno.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { admin, db, textoNormalizado, turnoNormalizado } = require('../src/lib/utils');

const dryRun = process.argv.includes('--dry-run');
const BATCH_SIZE = 400;

function construirIdNuevo(data) {
  const semana = textoNormalizado(data.semana);
  const idEmpleado = textoNormalizado(data.id_empleado);
  const turnoId = turnoNormalizado(data.turno_id);
  if (!semana || !idEmpleado || !turnoId) {
    return null;
  }
  return `${semana}_${idEmpleado}_${turnoId}`;
}

async function main() {
  const snapshot = await db.collection('programacion_semanal').get();
  const stats = {
    total: snapshot.size,
    ya_migrados: 0,
    migrados: 0,
    omitidos_sin_turno: 0,
    conflictos: 0,
  };

  const operaciones = [];

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const idNuevo = construirIdNuevo(data);

    if (!idNuevo) {
      stats.omitidos_sin_turno += 1;
      console.warn(`[omitir] ${doc.id}: sin semana, id_empleado o turno_id`);
      continue;
    }

    if (doc.id === idNuevo) {
      stats.ya_migrados += 1;
      continue;
    }

    const destinoRef = db.collection('programacion_semanal').doc(idNuevo);
    const destinoDoc = await destinoRef.get();
    if (destinoDoc.exists) {
      stats.conflictos += 1;
      console.warn(`[conflicto] ${doc.id} → ${idNuevo}: el destino ya existe`);
      continue;
    }

    stats.migrados += 1;
    operaciones.push({ origen: doc.ref, destino: destinoRef, data });

    if (!dryRun) {
      console.log(`[migrar] ${doc.id} → ${idNuevo}`);
    } else {
      console.log(`[dry-run] ${doc.id} → ${idNuevo}`);
    }
  }

  if (!dryRun && operaciones.length) {
    for (let i = 0; i < operaciones.length; i += BATCH_SIZE) {
      const lote = operaciones.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      lote.forEach(({ origen, destino, data }) => {
        batch.set(destino, {
          ...data,
          actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
        });
        batch.delete(origen);
      });
      await batch.commit();
    }
  }

  console.log('\n--- Resumen ---');
  console.log(`Total documentos:     ${stats.total}`);
  console.log(`Ya en formato nuevo:  ${stats.ya_migrados}`);
  console.log(`Migrados:             ${stats.migrados}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`Omitidos sin turno:   ${stats.omitidos_sin_turno}`);
  console.log(`Conflictos:           ${stats.conflictos}`);
}

main().catch((error) => {
  console.error('Error en migración:', error);
  process.exit(1);
});
