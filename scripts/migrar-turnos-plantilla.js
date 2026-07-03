/**
 * Migración al catálogo de turnos estilo Excel (26 slots día × tipo).
 *
 * - Desactiva turnos legados (mixto_1, dom_*, etc.)
 * - Upsert de la plantilla nueva
 * - Limpia referencias obsoletas en rutas.turnos[] y rutas.unidad_por_turno{}
 *
 * Uso:
 *   node backend/scripts/migrar-turnos-plantilla.js
 *   node backend/scripts/migrar-turnos-plantilla.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { admin, db } = require('../src/lib/utils');
const { PLANTILLA_TURNOS, IDS_PLANTILLA } = require('../src/lib/turnosPlantilla');

const dryRun = process.argv.includes('--dry-run');
const IDS_PLANTILLA_SET = new Set([...IDS_PLANTILLA]);

async function desactivarTurnosLegados(batch, stats) {
  const snapshot = await db.collection('turnos').get();

  snapshot.docs.forEach((doc) => {
    if (IDS_PLANTILLA_SET.has(doc.id)) {
      return;
    }

    const data = doc.data() || {};
    if (data.activo === false) {
      return;
    }

    stats.turnos_desactivados += 1;
    if (!dryRun) {
      batch.update(doc.ref, {
        activo: false,
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });
}

async function upsertPlantilla(batch, stats) {
  PLANTILLA_TURNOS.forEach((turno) => {
    stats.turnos_plantilla += 1;
    if (!dryRun) {
      const ref = db.collection('turnos').doc(turno.id);
      batch.set(ref, {
        ...turno,
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });
}

async function limpiarReferenciasRutas(batch, stats) {
  const snapshot = await db.collection('rutas').get();

  snapshot.docs.forEach((doc) => {
    const data = doc.data() || {};
    const turnos = Array.isArray(data.turnos) ? data.turnos.map(String) : [];
    const unidadPorTurno = data.unidad_por_turno && typeof data.unidad_por_turno === 'object'
      ? { ...data.unidad_por_turno }
      : {};

    const turnosValidos = turnos.filter((id) => IDS_PLANTILLA_SET.has(id));
    const turnosRemovidos = turnos.length - turnosValidos.length;

    const clavesUnidad = Object.keys(unidadPorTurno);
    const unidadLimpia = {};
    clavesUnidad.forEach((turnoId) => {
      if (IDS_PLANTILLA_SET.has(turnoId)) {
        unidadLimpia[turnoId] = unidadPorTurno[turnoId];
      }
    });
    const unidadesRemovidas = clavesUnidad.length - Object.keys(unidadLimpia).length;

    if (turnosRemovidos === 0 && unidadesRemovidas === 0) {
      return;
    }

    stats.rutas_actualizadas += 1;
    stats.referencias_turno_removidas += turnosRemovidos;
    stats.referencias_unidad_removidas += unidadesRemovidas;

    if (!dryRun) {
      batch.update(doc.ref, {
        turnos: turnosValidos,
        unidad_por_turno: unidadLimpia,
        actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });
}

async function main() {
  const stats = {
    turnos_desactivados: 0,
    turnos_plantilla: 0,
    rutas_actualizadas: 0,
    referencias_turno_removidas: 0,
    referencias_unidad_removidas: 0,
  };

  console.log(dryRun ? '[DRY-RUN] Migración de turnos (sin escrituras)' : 'Migración de turnos estilo Excel...');

  const batch = db.batch();
  let operaciones = 0;

  await desactivarTurnosLegados(batch, stats);
  await upsertPlantilla(batch, stats);
  await limpiarReferenciasRutas(batch, stats);

  if (!dryRun) {
    operaciones = batch._ops?.length || 0;
    if (operaciones > 0) {
      await batch.commit();
    }
  }

  console.log('Resumen:');
  console.log(`  Turnos legados desactivados: ${stats.turnos_desactivados}`);
  console.log(`  Turnos plantilla upsert:     ${stats.turnos_plantilla}`);
  console.log(`  Rutas actualizadas:          ${stats.rutas_actualizadas}`);
  console.log(`  Referencias turno removidas: ${stats.referencias_turno_removidas}`);
  console.log(`  Referencias unidad remov.:   ${stats.referencias_unidad_removidas}`);

  if (dryRun) {
    console.log('\nEjecuta sin --dry-run para aplicar los cambios.');
  } else {
    console.log('\nMigración completada. Reasigna turnos/unidades en Gestión de rutas → Catálogo.');
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('Error en migración de turnos:', error.message);
  process.exit(1);
});
