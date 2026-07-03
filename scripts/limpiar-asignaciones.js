/**
 * Limpia todas las asignaciones y programaciones para un inicio limpio.
 *
 * Acciones:
 *   1. Elimina todos los documentos de `programacion_semanal`
 *   2. Elimina todos los documentos de `programacion_diaria`
 *   3. Elimina todos los documentos de `metricas_diarias` (agregados pre-calculados)
 *   4. Elimina todos los documentos de `resumen_semanal`
 *   5. Limpia los campos `turnos` y `unidad_por_turno` de cada ruta en `rutas`
 *
 * Uso:
 *   node backend/scripts/limpiar-asignaciones.js
 *   node backend/scripts/limpiar-asignaciones.js --sin-rutas   (omite paso 5)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const admin = require('firebase-admin');
const { db } = require('../src/lib/utils');
const FieldValue = admin.firestore.FieldValue;

const sinRutas = process.argv.includes('--sin-rutas');
const soloRutas = process.argv.includes('--solo-rutas');
const BATCH_SIZE = 400;

async function eliminarColeccion(nombre) {
  let total = 0;
  let snap;

  do {
    snap = await db.collection(nombre).limit(BATCH_SIZE).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    total += snap.docs.length;
    console.log(`  [${nombre}] eliminados: ${total}`);
  } while (!snap.empty);

  console.log(`  [${nombre}] total eliminado: ${total} documentos`);
  return total;
}

async function limpiarCamposRutas() {
  const snap = await db.collection('rutas').get();
  if (snap.empty) {
    console.log('  [rutas] sin documentos.');
    return 0;
  }

  let procesados = 0;
  const lotes = [];
  let batch = db.batch();
  let enLote = 0;

  snap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      // Asignaciones por turno (sistema nuevo)
      turnos: [],
      unidad_por_turno: {},
      // Campos de unidad directos (sistema legado)
      tipo_unidad: FieldValue.delete(),
      'tipo de unidad': FieldValue.delete(),
      codigo_unidad: FieldValue.delete(),
      capacidad_real: FieldValue.delete(),
    });
    enLote++;
    procesados++;

    if (enLote >= BATCH_SIZE) {
      lotes.push(batch.commit());
      batch = db.batch();
      enLote = 0;
    }
  });

  if (enLote > 0) lotes.push(batch.commit());
  await Promise.all(lotes);

  console.log(`  [rutas] campos de unidad limpiados en ${procesados} documentos`);
  return procesados;
}

async function main() {
  const modo = soloRutas ? 'solo campos de rutas (--solo-rutas)'
    : sinRutas ? 'solo programaciones (--sin-rutas)'
    : 'programaciones + campos de rutas';
  console.log('=== Limpieza de asignaciones ===');
  console.log(`Modo: ${modo}\n`);

  if (!soloRutas) {
    console.log('1. Eliminando programacion_semanal...');
    await eliminarColeccion('programacion_semanal');

    console.log('\n2. Eliminando programacion_diaria...');
    await eliminarColeccion('programacion_diaria');

    console.log('\n3. Eliminando metricas_diarias (agregados pre-calculados)...');
    await eliminarColeccion('metricas_diarias');

    console.log('\n4. Eliminando resumen_semanal...');
    await eliminarColeccion('resumen_semanal');
  }

  if (!sinRutas) {
    console.log('\n5. Limpiando campos de unidad en rutas...');
    await limpiarCamposRutas();
  }

  console.log('\n=== Limpieza completada ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
