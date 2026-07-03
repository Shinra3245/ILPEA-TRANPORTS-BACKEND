/**
 * Fase 1 (Expand) — Seed de catálogos nuevos y backfill de rutas.
 *
 * Crea/actualiza:
 *   - turnos/{turnoId}      (catálogo de turnos, antes hardcodeado en el frontend)
 *   - vehiculos/{vehiculoId} (derivados de codigo_unidad + tipo de unidad de rutas)
 *   - paradas/{paradaId}     (derivadas de zona/referencia de rutas)
 *   - rutas/{rutaId}         (agrega numero, nombre, tipo_unidad, vehiculo_default,
 *                             paradas[] SIN borrar campos legados)
 *
 * Es idempotente: puede correrse varias veces sin duplicar datos.
 *
 * Uso:
 *   node backend/scripts/seed-catalogos.js
 *   node backend/scripts/seed-catalogos.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { admin, db, textoNormalizado } = require('../src/lib/utils');

const { PLANTILLA_TURNOS } = require('../src/lib/turnosPlantilla');

const dryRun = process.argv.includes('--dry-run');

const TURNOS_SEED = PLANTILLA_TURNOS;

function normalizarTipoVehiculo(tipoTexto) {
  const tipo = textoNormalizado(tipoTexto).toLowerCase();
  if (tipo.includes('autobus') || tipo.includes('autobús') || tipo.includes('camion') || tipo.includes('camión')) {
    return 'AUTOBUS';
  }
  if (tipo.includes('sprinter')) {
    return 'SPRINTER';
  }
  if (tipo.includes('van')) {
    return 'VAN';
  }
  return tipo ? tipo.toUpperCase() : 'DESCONOCIDO';
}

function capacidadPorTipo(tipo, capacidadRuta) {
  const capacidad = Number(capacidadRuta);
  if (Number.isInteger(capacidad) && capacidad > 0) {
    return capacidad;
  }
  if (tipo === 'AUTOBUS') return 30;
  if (tipo === 'SPRINTER') return 19;
  if (tipo === 'VAN') return 12;
  return 12;
}

function slug(texto) {
  return textoNormalizado(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

async function seedTurnos(batch) {
  let cantidad = 0;
  TURNOS_SEED.forEach((turno) => {
    const ref = db.collection('turnos').doc(turno.id);
    batch.set(ref, {
      nombre: turno.nombre,
      dia_semana: turno.dia_semana,
      dia_nombre: turno.dia_nombre,
      tipo: turno.tipo,
      orden: turno.orden,
      dias_operacion: turno.dias_operacion,
      hora_inicio: turno.hora_inicio,
      hora_fin: turno.hora_fin,
      activo: true,
      es_plantilla: turno.es_plantilla === true,
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    cantidad += 1;
  });
  return cantidad;
}

function construirVehiculosDesdeRutas(rutasDocs) {
  const vehiculos = new Map();

  rutasDocs.forEach((doc) => {
    const data = doc.data() || {};
    const codigo = textoNormalizado(data.codigo_unidad);
    const tipo = normalizarTipoVehiculo(data['tipo de unidad'] || data.tipo_unidad);
    const capacidad = capacidadPorTipo(tipo, data.capacidad_real);

    const vehiculoId = codigo ? `veh_${slug(codigo)}` : `veh_ruta_${data.ruta ?? doc.id}`;
    if (!vehiculos.has(vehiculoId)) {
      vehiculos.set(vehiculoId, {
        id: vehiculoId,
        codigo: codigo || null,
        tipo,
        placas: null,
        capacidad,
        estado: 'activo',
        rutas_asociadas: [],
      });
    }

    vehiculos.get(vehiculoId).rutas_asociadas.push(doc.id);
  });

  return vehiculos;
}

function construirParadasDesdeRutas(rutasDocs) {
  const paradas = new Map();

  rutasDocs.forEach((doc) => {
    const data = doc.data() || {};
    const zona = textoNormalizado(data.zona) || 'SIN ZONA';
    const referencia = textoNormalizado(data.referencia);
    const nombre = referencia || zona;
    const paradaId = `par_${slug(nombre) || slug(zona) || doc.id}`;

    if (!paradas.has(paradaId)) {
      paradas.set(paradaId, {
        id: paradaId,
        nombre,
        zona,
        geo: null,
        activa: true,
      });
    }
  });

  return paradas;
}

async function main() {
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Seed de catálogos Firestore`);

  const rutasSnapshot = await db.collection('rutas').get();
  console.log(`Rutas en catálogo: ${rutasSnapshot.size}`);

  const vehiculos = construirVehiculosDesdeRutas(rutasSnapshot.docs);
  const paradas = construirParadasDesdeRutas(rutasSnapshot.docs);

  console.log(`Turnos a sembrar: ${TURNOS_SEED.length}`);
  console.log(`Vehículos detectados: ${vehiculos.size}`);
  console.log(`Paradas detectadas: ${paradas.size}`);

  if (dryRun) {
    vehiculos.forEach((veh) => console.log(`  [veh] ${veh.id} | ${veh.tipo} | cap ${veh.capacidad} | rutas: ${veh.rutas_asociadas.join(', ')}`));
    paradas.forEach((par) => console.log(`  [par] ${par.id} | ${par.nombre} (${par.zona})`));
    console.log('[DRY RUN] No se escribió nada.');
    return;
  }

  const batchCatalogos = db.batch();

  await seedTurnos(batchCatalogos);

  vehiculos.forEach((veh) => {
    const { rutas_asociadas: _omit, ...datos } = veh;
    batchCatalogos.set(db.collection('vehiculos').doc(veh.id), {
      ...datos,
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  paradas.forEach((par) => {
    batchCatalogos.set(db.collection('paradas').doc(par.id), {
      ...par,
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  await batchCatalogos.commit();
  console.log('Catálogos turnos/vehiculos/paradas sembrados.');

  // Backfill de rutas: agrega campos nuevos sin borrar los legados.
  const vehiculoPorRuta = new Map();
  vehiculos.forEach((veh) => {
    veh.rutas_asociadas.forEach((rutaId) => vehiculoPorRuta.set(rutaId, veh));
  });

  const batchRutas = db.batch();
  let rutasActualizadas = 0;

  rutasSnapshot.docs.forEach((doc) => {
    const data = doc.data() || {};
    const veh = vehiculoPorRuta.get(doc.id) || null;
    const zona = textoNormalizado(data.zona) || null;
    const referencia = textoNormalizado(data.referencia);
    const nombreParada = referencia || zona || 'SIN ZONA';
    const paradaId = `par_${slug(nombreParada) || slug(zona || '') || doc.id}`;

    batchRutas.set(doc.ref, {
      numero: Number(data.ruta) || null,
      nombre: zona ? `Ruta ${data.ruta} - ${zona}` : `Ruta ${data.ruta}`,
      tipo_unidad: normalizarTipoVehiculo(data['tipo de unidad'] || data.tipo_unidad),
      vehiculo_default: veh
        ? { id: veh.id, codigo: veh.codigo, tipo: veh.tipo, capacidad: veh.capacidad }
        : null,
      paradas: Array.isArray(data.paradas) && data.paradas.length
        ? data.paradas
        : [{ id: paradaId, nombre: nombreParada, zona: zona || 'SIN ZONA', orden: 1 }],
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    rutasActualizadas += 1;
  });

  await batchRutas.commit();
  console.log(`Backfill de rutas completado: ${rutasActualizadas} documento(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en seed de catálogos:', error.message);
    process.exit(1);
  });
