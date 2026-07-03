/**
 * Fase 3 — Backfill histórico de programacion_diaria al formato nuevo.
 *
 * Por cada documento:
 *   - Construye el mapa `pasajeros{}` desde los 3 campos paralelos legados
 *     (pasajeros_ids, asientos_por_empleado, asientos_reservados) con el
 *     nombre desnormalizado desde `usuarios` (leídos UNA sola vez).
 *   - Agrega `vehiculo{}` (snapshot desde tipo_unidad/codigo_unidad/capacidad_limite
 *     con fallback al catálogo de rutas), `turno_id`, `ruta_numero` y `total_abordados`.
 *
 * No borra ningún campo legado (eso es Fase 6 / contract).
 * Escribe en lotes de 500 operaciones y es idempotente.
 *
 * Uso:
 *   node backend/scripts/backfill-programacion.js
 *   node backend/scripts/backfill-programacion.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const {
  db,
  textoNormalizado,
  turnoNormalizado,
  normalizarAsientosReservados,
  normalizarAsientosPorEmpleado,
  normalizarPasajerosDetalle,
  construirVehiculoSnapshot,
} = require('../src/lib/utils');

const dryRun = process.argv.includes('--dry-run');
const BATCH_SIZE = 500;

async function cargarNombresEmpleados() {
  const snapshot = await db.collection('usuarios').get();
  const nombres = new Map();

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const idEmpleado = textoNormalizado(data.id_empleado);
    if (idEmpleado) {
      nombres.set(idEmpleado, textoNormalizado(data.nombre) || idEmpleado);
    }
  });

  return nombres;
}

async function cargarRutas() {
  const snapshot = await db.collection('rutas').get();
  const rutas = new Map();
  snapshot.forEach((doc) => rutas.set(doc.id, doc.data() || {}));
  return rutas;
}

function construirActualizacion(data, nombres, rutas) {
  const idRuta = textoNormalizado(data.id_ruta);
  const rutaData = rutas.get(idRuta) || {};

  const pasajerosIds = Array.isArray(data.pasajeros_ids)
    ? data.pasajeros_ids.map((id) => textoNormalizado(id)).filter(Boolean)
    : [];
  const asientosPorEmpleado = normalizarAsientosPorEmpleado(data.asientos_por_empleado);
  const asientosReservados = normalizarAsientosReservados(data.asientos_reservados);
  const detalleExistente = normalizarPasajerosDetalle(data.pasajeros);

  const pasajeros = {};
  pasajerosIds.forEach((idEmpleado, indice) => {
    const previo = detalleExistente[idEmpleado] || {};
    const asientoMapa = Number(asientosPorEmpleado[idEmpleado]);
    const asientoIndice = Number(asientosReservados[indice]);
    const asiento = Number.isInteger(asientoMapa) && asientoMapa > 0
      ? asientoMapa
      : (Number.isInteger(asientoIndice) && asientoIndice > 0 ? asientoIndice : previo.asiento ?? null);

    pasajeros[idEmpleado] = {
      nombre: previo.nombre && previo.nombre !== idEmpleado
        ? previo.nombre
        : (nombres.get(idEmpleado) || idEmpleado),
      asiento,
      parada_id: previo.parada_id ?? null,
      parada_orden: previo.parada_orden ?? null,
    };
  });

  const vehiculo = data.vehiculo && typeof data.vehiculo === 'object' && data.vehiculo.tipo
    ? data.vehiculo
    : construirVehiculoSnapshot(rutaData, {
      tipo: data.tipo_unidad,
      codigo: data.codigo_unidad,
      capacidad: Number(data.capacidad_limite),
    });

  return {
    pasajeros,
    vehiculo,
    turno_id: turnoNormalizado(data.turno_id || data.turno) || null,
    ruta_numero: Number(data.ruta_numero) || Number(rutaData.ruta) || Number(rutaData.numero) || null,
    total_abordados: Number(data.total_abordados) || 0,
    backfill_formato_nuevo_en: new Date(),
  };
}

async function main() {
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Backfill de programacion_diaria al formato nuevo`);

  const [nombres, rutas] = await Promise.all([cargarNombresEmpleados(), cargarRutas()]);
  console.log(`Empleados con nombre resuelto: ${nombres.size} | Rutas en catálogo: ${rutas.size}`);

  const snapshot = await db.collection('programacion_diaria').get();
  console.log(`Documentos de programacion_diaria: ${snapshot.size}`);

  let procesados = 0;
  let batch = db.batch();
  let operacionesEnBatch = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const actualizacion = construirActualizacion(data, nombres, rutas);

    if (dryRun) {
      const totalPasajeros = Object.keys(actualizacion.pasajeros).length;
      console.log(`  [dry] ${doc.id}: ${totalPasajeros} pasajero(s), vehiculo=${actualizacion.vehiculo?.tipo || 'N/D'}`);
      procesados += 1;
      continue;
    }

    batch.set(doc.ref, actualizacion, { merge: true });
    operacionesEnBatch += 1;
    procesados += 1;

    if (operacionesEnBatch >= BATCH_SIZE) {
      await batch.commit();
      console.log(`  Commit de ${operacionesEnBatch} documento(s) (${procesados}/${snapshot.size})`);
      batch = db.batch();
      operacionesEnBatch = 0;
    }
  }

  if (!dryRun && operacionesEnBatch > 0) {
    await batch.commit();
    console.log(`  Commit final de ${operacionesEnBatch} documento(s).`);
  }

  console.log(`Backfill completado: ${procesados} documento(s) procesados.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backfill:', error.message);
    process.exit(1);
  });
