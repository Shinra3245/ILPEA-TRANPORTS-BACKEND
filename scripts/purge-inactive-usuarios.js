/**
 * Elimina usuarios marcados como activo:false (soft deletes legacy).
 * Uso: node backend/scripts/purge-inactive-usuarios.js
 *      node backend/scripts/purge-inactive-usuarios.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const {
  admin,
  db,
  liberarAsignacionesPorIdEmpleado,
  construirIdEmpleadoDesdeUid,
  textoNormalizado,
} = require('../src/lib/utils');
const { ROLES } = require('../src/config/roles');

const dryRun = process.argv.includes('--dry-run');

async function eliminarAuthSiExiste(uid) {
  try {
    await admin.auth().deleteUser(uid);
    return 'auth_deleted';
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return 'auth_missing';
    }
    throw error;
  }
}

async function purgarUsuarioInactivo(doc) {
  const data = doc.data() || {};
  const uid = doc.id;
  const rol = data.rol;

  if (rol === ROLES.EMPLEADO) {
    const idEmpleado = textoNormalizado(data.id_empleado) || construirIdEmpleadoDesdeUid(uid);
    if (!dryRun) {
      await liberarAsignacionesPorIdEmpleado(idEmpleado);
    }
  }

  let authResult = 'skipped';
  if (!dryRun) {
    authResult = await eliminarAuthSiExiste(uid);
    await doc.ref.delete();
  }

  return {
    uid,
    email: data.email || null,
    rol,
    authResult,
  };
}

async function main() {
  const snapshot = await db.collection('usuarios').where('activo', '==', false).get();

  if (snapshot.empty) {
    console.log('No hay usuarios inactivos para purgar.');
    return;
  }

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Encontrados ${snapshot.size} usuario(s) inactivo(s).`);

  const resultados = [];
  for (const doc of snapshot.docs) {
    try {
      const resultado = await purgarUsuarioInactivo(doc);
      resultados.push({ ...resultado, ok: true });
      console.log(`- ${resultado.email || resultado.uid} (${resultado.rol})`);
    } catch (error) {
      resultados.push({
        uid: doc.id,
        email: doc.data()?.email || null,
        ok: false,
        error: error.message,
      });
      console.error(`x ${doc.id}: ${error.message}`);
    }
  }

  const ok = resultados.filter((item) => item.ok).length;
  const fallidos = resultados.length - ok;
  console.log(`\nResumen: ${ok} procesados, ${fallidos} con error.`);

  if (dryRun) {
    console.log('Ejecuta sin --dry-run para aplicar los cambios.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en purge:', error.message);
    process.exit(1);
  });
