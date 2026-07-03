/**
 * Fase 0 — Backup de colecciones Firestore a JSON local.
 *
 * Exporta las colecciones base (rutas, usuarios, programacion_diaria) y,
 * si existen, las nuevas (vehiculos, turnos, paradas, programacion_semanal,
 * metricas_diarias, resumen_semanal) a backend/backups/<timestamp>/.
 *
 * Uso:
 *   node backend/scripts/backup-firestore.js
 *   node backend/scripts/backup-firestore.js --colecciones rutas,usuarios
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { db } = require('../src/lib/utils');

const COLECCIONES_DEFAULT = [
  'rutas',
  'usuarios',
  'programacion_diaria',
  'vehiculos',
  'turnos',
  'paradas',
  'programacion_semanal',
  'metricas_diarias',
  'resumen_semanal',
];

function leerColeccionesArg() {
  const indice = process.argv.indexOf('--colecciones');
  if (indice === -1 || !process.argv[indice + 1]) {
    return COLECCIONES_DEFAULT;
  }

  return process.argv[indice + 1]
    .split(',')
    .map((nombre) => nombre.trim())
    .filter(Boolean);
}

function serializarValor(valor) {
  if (valor && typeof valor.toDate === 'function') {
    return { __timestamp: valor.toDate().toISOString() };
  }

  if (Array.isArray(valor)) {
    return valor.map(serializarValor);
  }

  if (valor && typeof valor === 'object') {
    const resultado = {};
    Object.entries(valor).forEach(([clave, interno]) => {
      resultado[clave] = serializarValor(interno);
    });
    return resultado;
  }

  return valor;
}

async function exportarColeccion(nombre, carpetaDestino) {
  const snapshot = await db.collection(nombre).get();

  if (snapshot.empty) {
    console.log(`  ${nombre}: vacía u omitida (0 documentos).`);
    return 0;
  }

  const documentos = snapshot.docs.map((doc) => ({
    __id: doc.id,
    ...serializarValor(doc.data() || {}),
  }));

  const destino = path.join(carpetaDestino, `${nombre}.json`);
  fs.writeFileSync(destino, JSON.stringify(documentos, null, 2), 'utf8');
  console.log(`  ${nombre}: ${documentos.length} documento(s) -> ${destino}`);
  return documentos.length;
}

async function main() {
  const colecciones = leerColeccionesArg();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const carpetaDestino = path.resolve(__dirname, '../backups', timestamp);

  fs.mkdirSync(carpetaDestino, { recursive: true });
  console.log(`Backup Firestore -> ${carpetaDestino}`);

  let total = 0;
  for (const nombre of colecciones) {
    try {
      total += await exportarColeccion(nombre, carpetaDestino);
    } catch (error) {
      console.error(`  Error exportando ${nombre}: ${error.message}`);
    }
  }

  console.log(`Backup completado: ${total} documento(s) en total.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en backup:', error.message);
    process.exit(1);
  });
