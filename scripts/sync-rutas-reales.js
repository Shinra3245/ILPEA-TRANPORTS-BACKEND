/**
 * Purga rutas de prueba y sincroniza las rutas reales ILPEA
 * desde el reporte de aforos (Marzo 2026).
 *
 * Fuente: data-science/data/Reporte de usuarios Ilpea Periodo del 09 de Marzo al 15 de Marzo del 2026.xlsx
 * Hoja: Aforos Ilpea
 *
 * Uso: node scripts/sync-rutas-reales.js
 */

const path = require('path');
const ExcelJS = require('exceljs');
const { db, evaluarAlertas } = require('../src/lib/utils');

const EXCEL_DEFAULT = path.resolve(
  __dirname,
  '../../data-science/data/Reporte de usuarios Ilpea Periodo del 09 de Marzo al 15 de Marzo del 2026.xlsx'
);

const SAMSARA = {
  1: { codigo_unidad: 'E0234', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/lBalLAGH1nOFRMquWZtj' },
  2: { codigo_unidad: 'E0322', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/SOMheubsCHWA8dXcgb4e' },
  3: { codigo_unidad: 'C0008', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/lx8gXOozwGTPq0tZNOEA' },
  4: { codigo_unidad: 'C0068', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/VMGMOM6ukDVfR2QaWaoQ' },
  5: { codigo_unidad: null, link_samsara: null }, // Rancho Nuevo — completar cuando esté disponible
  6: { codigo_unidad: 'C0036', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/gjlNSxi5GEgDu7fKZYZn' },
  7: { codigo_unidad: 'C0056', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/TXuwHMotHrvxnBOc6BXb' },
  8: { codigo_unidad: 'E0334', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/9feSjFeZN7RqjxOergxl' },
  9: { codigo_unidad: 'E0372', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/1VUuTytBwuaO0UNjpaTY' },
  10: { codigo_unidad: 'C0126', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/route/32848/2MaAXc5bDi6iLOvUrewL' },
  14: { codigo_unidad: 'C0118', link_samsara: 'https://cloud.samsara.com/o/32848/fleet/viewer/Glz8p8yZR51uiVx6bvXQ' },
};

function cargarFirebase() {
  return db;
}

function valorCelda(valor) {
  if (valor && typeof valor === 'object' && Object.prototype.hasOwnProperty.call(valor, 'result')) {
    return valor.result;
  }
  return valor;
}

function numeroCelda(valor) {
  const n = Number(valorCelda(valor));
  return Number.isFinite(n) ? n : 0;
}

function textoCelda(valor) {
  return String(valorCelda(valor) ?? '').trim();
}

function capacidadOperativa(tipoUnidad, capacidadExcel) {
  const tipo = textoCelda(tipoUnidad).toLowerCase();
  if (tipo.includes('autobus') || tipo.includes('camion') || tipo.includes('camión')) {
    return 30;
  }
  if (tipo.includes('sprinter')) {
    return 19;
  }
  if (tipo.includes('van')) {
    return 12;
  }
  const cap = numeroCelda(capacidadExcel);
  return cap > 0 ? cap : 0;
}

async function leerRutasDesdeExcel(excelPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet('Aforos Ilpea');

  if (!sheet) {
    throw new Error('No se encontró la hoja "Aforos Ilpea" en el archivo Excel.');
  }

  const rutas = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 7) {
      return;
    }

    const ruta = numeroCelda(row.getCell(1).value);
    if (!ruta) {
      return;
    }

    const capacidadExcel = numeroCelda(row.getCell(2).value);
    const tipoUnidad = textoCelda(row.getCell(3).value);
    const zona = textoCelda(row.getCell(4).value);
    const referencia = textoCelda(row.getCell(5).value);

    const turnos = [];
    for (let col = 6; col <= 56; col += 2) {
      turnos.push(numeroCelda(row.getCell(col).value));
    }

    const maxPasajeros = turnos.length ? Math.max(...turnos) : 0;
    const capacidadReal = capacidadOperativa(tipoUnidad, capacidadExcel);
    const metricas = evaluarAlertas({ tipoUnidad, capacidadReal, pasajeros: maxPasajeros });
    const samsara = SAMSARA[ruta] || {};

    rutas.push({
      ruta,
      zona,
      referencia,
      'tipo de unidad': tipoUnidad,
      capacidad_asientos: capacidadExcel || null,
      capacidad_real: capacidadReal,
      max_pasajeros_dia: maxPasajeros,
      ...metricas,
      codigo_unidad: samsara.codigo_unidad || null,
      link_samsara: samsara.link_samsara || null,
      fuente_datos: 'Reporte ILPEA Marzo 2026 (Aforos Ilpea)',
      asientos_ocupados: [],
    });
  });

  rutas.sort((a, b) => a.ruta - b.ruta);

  if (!rutas.length) {
    throw new Error('No se encontraron rutas en el Excel.');
  }

  return rutas;
}

async function purgarEInsertarRutas(db, rutas) {
  const colRef = db.collection('rutas');
  const snapshot = await colRef.get();

  const batchDelete = db.batch();
  snapshot.docs.forEach((doc) => batchDelete.delete(doc.ref));
  await batchDelete.commit();
  console.log(`Eliminadas ${snapshot.size} rutas anteriores.`);

  const batchInsert = db.batch();
  rutas.forEach((ruta) => {
    const docId = `ruta_${ruta.ruta}`;
    const docRef = colRef.doc(docId);
    batchInsert.set(docRef, {
      id: docId,
      ...ruta,
      actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await batchInsert.commit();
}

async function main() {
  const excelPath = process.env.ILPEA_RUTAS_EXCEL || EXCEL_DEFAULT;
  console.log(`Leyendo rutas desde: ${excelPath}`);

  const rutas = await leerRutasDesdeExcel(excelPath);
  console.log(`Rutas reales detectadas (${rutas.length}): ${rutas.map((r) => r.ruta).join(', ')}`);

  const db = cargarFirebase();
  await purgarEInsertarRutas(db, rutas);

  console.log('Base de datos de rutas sincronizada con datos reales ILPEA.');
  rutas.forEach((ruta) => {
    console.log(
      `  Ruta ${String(ruta.ruta).padStart(2, '0')} | ${ruta.zona} | ${ruta['tipo de unidad']} | max ${ruta.max_pasajeros_dia} pax`
    );
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error sincronizando rutas:', error.message);
    process.exit(1);
  });
