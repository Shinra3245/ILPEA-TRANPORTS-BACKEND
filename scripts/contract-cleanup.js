/**
 * Fase 6 (Contract) — Limpieza de campos legados.
 *
 * PRERREQUISITOS (no correr antes):
 *   1. Backfill histórico completado (backend/scripts/backfill-programacion.js).
 *   2. Lecturas validadas con el formato nuevo (dashboard, panel jefe, exportaciones).
 *   3. Backend deployado con DUAL_WRITE_LEGADO=off (deja de escribir el formato viejo).
 *
 * Elimina:
 *   - rutas: campo "tipo de unidad" (solo si ya existe tipo_unidad normalizado)
 *   - programacion_diaria: pasajeros_ids, asientos_reservados, asientos_por_empleado
 *     (solo si el doc ya tiene el mapa nuevo `pasajeros`)
 *
 * Uso:
 *   node backend/scripts/contract-cleanup.js            (dry-run, solo reporta)
 *   node backend/scripts/contract-cleanup.js --confirm  (ejecuta la limpieza)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { admin, db } = require('../src/lib/utils');

const confirmado = process.argv.includes('--confirm');
const BATCH_SIZE = 400;

async function limpiarRutas() {
  const snapshot = await db.collection('rutas').get();
  let pendientes = 0;
  let batch = db.batch();
  let enBatch = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const tieneCampoLegado = Object.prototype.hasOwnProperty.call(data, 'tipo de unidad');

    if (!tieneCampoLegado) {
      continue;
    }

    if (!data.tipo_unidad) {
      console.warn(`  [skip] rutas/${doc.id}: no tiene tipo_unidad normalizado; corre el seed (Fase 1) primero.`);
      continue;
    }

    pendientes += 1;
    if (!confirmado) {
      continue;
    }

    batch.update(
      doc.ref,
      new admin.firestore.FieldPath('tipo de unidad'),
      admin.firestore.FieldValue.delete()
    );
    enBatch += 1;

    if (enBatch >= BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      enBatch = 0;
    }
  }

  if (confirmado && enBatch > 0) {
    await batch.commit();
  }

  console.log(`rutas: ${pendientes} documento(s) con "tipo de unidad" ${confirmado ? 'limpiados' : 'por limpiar'}.`);
}

async function limpiarProgramacionDiaria() {
  const snapshot = await db.collection('programacion_diaria').get();
  const CAMPOS_LEGADOS = ['pasajeros_ids', 'asientos_reservados', 'asientos_por_empleado'];

  let pendientes = 0;
  let omitidos = 0;
  let batch = db.batch();
  let enBatch = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const tieneLegados = CAMPOS_LEGADOS.some((campo) => Object.prototype.hasOwnProperty.call(data, campo));

    if (!tieneLegados) {
      continue;
    }

    const tieneMapaNuevo = data.pasajeros && typeof data.pasajeros === 'object' && !Array.isArray(data.pasajeros);
    const legadosVacios = (!Array.isArray(data.pasajeros_ids) || !data.pasajeros_ids.length);

    // Solo se limpia si el doc ya fue migrado (mapa nuevo) o no tenía pasajeros.
    if (!tieneMapaNuevo && !legadosVacios) {
      omitidos += 1;
      continue;
    }

    pendientes += 1;
    if (!confirmado) {
      continue;
    }

    const actualizacion = {};
    CAMPOS_LEGADOS.forEach((campo) => {
      actualizacion[campo] = admin.firestore.FieldValue.delete();
    });
    actualizacion.contract_limpiado_en = new Date();

    batch.update(doc.ref, actualizacion);
    enBatch += 1;

    if (enBatch >= BATCH_SIZE) {
      await batch.commit();
      console.log(`  Commit de ${BATCH_SIZE} documento(s)...`);
      batch = db.batch();
      enBatch = 0;
    }
  }

  if (confirmado && enBatch > 0) {
    await batch.commit();
  }

  console.log(`programacion_diaria: ${pendientes} documento(s) ${confirmado ? 'limpiados' : 'por limpiar'}, ${omitidos} omitido(s) sin migrar.`);

  if (omitidos > 0) {
    console.warn('ATENCION: hay documentos sin el mapa `pasajeros`. Corre backfill-programacion.js antes de limpiar.');
  }
}

async function main() {
  console.log(`${confirmado ? '' : '[DRY RUN] '}Contract cleanup — eliminación de campos legados`);

  if (!confirmado) {
    console.log('Modo reporte. Agrega --confirm para ejecutar la limpieza.\n');
  }

  await limpiarRutas();
  await limpiarProgramacionDiaria();

  console.log('Listo.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en contract cleanup:', error.message);
    process.exit(1);
  });
