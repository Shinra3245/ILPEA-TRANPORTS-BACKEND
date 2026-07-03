/**
 * Seed de unidades ILPEA (14 vehículos de la plantilla operativa).
 *
 * Uso:
 *   node backend/scripts/seed-unidades.js
 *   node backend/scripts/seed-unidades.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { admin, db } = require('../src/lib/utils');
const {
  PLANTILLA_UNIDADES,
  etiquetaTipoImagen,
} = require('../src/lib/unidadesPlantilla');

const dryRun = process.argv.includes('--dry-run');

async function alinearRutas(batch, stats) {
  const snapshot = await db.collection('rutas').get();

  snapshot.docs.forEach((doc) => {
    const data = doc.data() || {};
    const rutaNumero = Number(data.ruta);
    const unidad = PLANTILLA_UNIDADES.find((item) => item.ruta_numero === rutaNumero);

    if (!unidad) {
      return;
    }

    stats.rutas_actualizadas += 1;

    if (!dryRun) {
      batch.update(doc.ref, {
        codigo_unidad: unidad.codigo,
        tipo_unidad: unidad.tipo,
        'tipo de unidad': etiquetaTipoImagen(unidad.tipo),
        capacidad_real: unidad.capacidad,
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });
}

async function main() {
  const stats = {
    unidades_upsert: PLANTILLA_UNIDADES.length,
    rutas_actualizadas: 0,
  };

  console.log(dryRun ? '[DRY-RUN] Seed de unidades ILPEA' : 'Seed de unidades ILPEA...');

  if (dryRun) {
    PLANTILLA_UNIDADES.forEach((unidad) => {
      console.log(`  [veh] ${unidad.id} | Ruta ${unidad.ruta_numero} | ${unidad.codigo} | ${unidad.tipo} | ${unidad.capacidad} asientos`);
    });
  }

  const batch = db.batch();

  if (!dryRun) {
    PLANTILLA_UNIDADES.forEach((unidad) => {
      const ref = db.collection('vehiculos').doc(unidad.id);
      batch.set(ref, {
        ...unidad,
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }

  await alinearRutas(batch, stats);

  if (!dryRun) {
    await batch.commit();
  }

  console.log('Resumen:');
  console.log(`  Unidades upsert:     ${stats.unidades_upsert}`);
  console.log(`  Rutas actualizadas:  ${stats.rutas_actualizadas}`);

  if (dryRun) {
    console.log('\nEjecuta sin --dry-run para aplicar los cambios.');
  } else {
    console.log('\nSeed completado. Revisa asignaciones por turno en Gestión de rutas.');
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('Error en seed de unidades:', error.message);
  process.exit(1);
});
