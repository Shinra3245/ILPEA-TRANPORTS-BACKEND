/**
 * Backfill de rutas para el módulo unificado de asignaciones.
 *
 * Dota a las rutas existentes de:
 *   - turnos[]           (derivados de programacion_diaria; fallback a Mixto 1 y 2)
 *   - unidad_por_turno{} (derivada de vehiculo_default / tipo_unidad / capacidad_real)
 *   - origen             ('sync' si no existía)
 *
 * Es idempotente: solo completa rutas que aún no tienen turnos o unidad_por_turno.
 *
 * Uso:
 *   node backend/scripts/backfill-rutas-turnos.js --dry-run
 *   node backend/scripts/backfill-rutas-turnos.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { admin, db, textoNormalizado, turnoNormalizado } = require('../src/lib/utils');

const dryRun = process.argv.includes('--dry-run');
const TURNOS_DEFECTO = ['mixto_1', 'mixto_2'];

async function derivarTurnosDeProgramacion(rutaId) {
  const snapshot = await db.collection('programacion_diaria').where('id_ruta', '==', rutaId).get();
  const turnos = new Set();
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const turno = turnoNormalizado(data.turno_id || data.turno);
    if (turno) {
      turnos.add(turno);
    }
  });
  return Array.from(turnos);
}

function construirUnidadPorTurno(turnos, rutaData) {
  const base = rutaData.vehiculo_default && typeof rutaData.vehiculo_default === 'object'
    ? rutaData.vehiculo_default
    : null;

  const tipo = textoNormalizado(base?.tipo)
    || textoNormalizado(rutaData.tipo_unidad)
    || textoNormalizado(rutaData['tipo de unidad'])
    || null;
  const capacidad = Number(base?.capacidad) || Number(rutaData.capacidad_real) || 0;
  const vehiculoId = textoNormalizado(base?.id) || null;
  const codigo = textoNormalizado(base?.codigo) || textoNormalizado(rutaData.codigo_unidad) || null;

  const unidad = {};
  turnos.forEach((turno) => {
    unidad[turno] = {
      vehiculo_id: vehiculoId,
      tipo,
      codigo,
      capacidad: capacidad || null,
    };
  });
  return unidad;
}

async function main() {
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Backfill de rutas (turnos + unidad_por_turno)`);

  const rutasSnapshot = await db.collection('rutas').get();
  console.log(`Rutas en catálogo: ${rutasSnapshot.size}`);

  let actualizadas = 0;

  for (const doc of rutasSnapshot.docs) {
    const data = doc.data() || {};
    const tieneTurnos = Array.isArray(data.turnos) && data.turnos.length > 0;
    const tieneUnidad = data.unidad_por_turno
      && typeof data.unidad_por_turno === 'object'
      && Object.keys(data.unidad_por_turno).length > 0;

    if (tieneTurnos && tieneUnidad) {
      continue;
    }

    let turnos = tieneTurnos
      ? data.turnos.map(turnoNormalizado).filter(Boolean)
      : await derivarTurnosDeProgramacion(doc.id);

    if (!turnos.length) {
      turnos = [...TURNOS_DEFECTO];
    }

    const unidadPorTurno = tieneUnidad
      ? data.unidad_por_turno
      : construirUnidadPorTurno(turnos, data);

    const cambios = {
      turnos,
      unidad_por_turno: unidadPorTurno,
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!data.origen) {
      cambios.origen = 'sync';
    }

    if (dryRun) {
      console.log(`  [DRY] ${doc.id} (Ruta ${data.ruta ?? '?'}) turnos=[${turnos.join(', ')}] unidades=${Object.keys(unidadPorTurno).length}`);
    } else {
      await doc.ref.set(cambios, { merge: true });
    }

    actualizadas += 1;
  }

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Rutas completadas: ${actualizadas}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backfill de rutas:', error.message);
    process.exit(1);
  });
