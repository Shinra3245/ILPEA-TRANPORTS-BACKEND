/**
 * Inserta ruta_5 (Rancho Nuevo) en Firestore.
 *
 * La ruta existe operativamente (aparece en el Excel de fines de semana)
 * pero nunca tuvo datos de aforo en el reporte base, por lo que no fue
 * incluida en la sincronización inicial.
 *
 * Una vez que se tengan datos reales (capacidad, tipo de unidad, pasajeros),
 * agregar la fila al Excel "Aforos Ilpea" y re-ejecutar sync-rutas-reales.js.
 *
 * Uso: node scripts/add-ruta5.js
 */

const admin = require('firebase-admin');
const { db } = require('../src/lib/utils');

async function main() {
  const docId = 'ruta_5';
  const docRef = db.collection('rutas').doc(docId);

  const existing = await docRef.get();
  if (existing.exists) {
    console.log('ruta_5 ya existe en Firestore. No se realizaron cambios.');
    console.log('Datos actuales:', existing.data());
    return;
  }

  const ruta5 = {
    id: docId,
    ruta: 5,
    zona: 'Rancho Nuevo',
    referencia: null,
    'tipo de unidad': null,
    capacidad_asientos: null,
    capacidad_real: 0,
    max_pasajeros_dia: 0,
    porcentaje_ocupacion_max: null,
    alerta_ocupacion: 'SIN DATOS',
    sugerencia_right_sizing: 'SIN DATOS',
    codigo_unidad: null,
    link_samsara: null,
    fuente_datos: 'Registro manual - datos de aforo pendientes',
    asientos_ocupados: [],
    actualizado_en: admin.firestore.FieldValue.serverTimestamp(),
  };

  await docRef.set(ruta5);
  console.log('✓ ruta_5 (Rancho Nuevo) insertada correctamente en Firestore.');
  console.log('  Recuerda actualizar los datos de aforo cuando estén disponibles.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
