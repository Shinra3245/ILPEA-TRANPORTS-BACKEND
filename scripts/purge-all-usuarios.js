/**
 * Purga usuarios de Firestore y Firebase Auth.
 *
 * Uso:
 *   node backend/scripts/purge-all-usuarios.js --dry-run
 *   node backend/scripts/purge-all-usuarios.js --confirm
 *   node backend/scripts/purge-all-usuarios.js --confirm --keep-admin
 *   node backend/scripts/purge-all-usuarios.js --confirm --rol=EMPLEADO
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

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const confirm = args.includes('--confirm');
const keepAdmin = args.includes('--keep-admin');
const rolArg = args.find((arg) => arg.startsWith('--rol='));
const rolFiltro = rolArg ? rolArg.split('=')[1]?.toUpperCase() : null;

function esInactivo(data) {
  return data.activo === false || data.activo === 'false' || data.activo === 0;
}

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

async function purgarDocumento(doc) {
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
    inactivo: esInactivo(data),
    authResult,
  };
}

function debePurgar(data) {
  const rol = data.rol;

  if (keepAdmin && rol === ROLES.ADMIN) {
    return false;
  }

  if (rolFiltro && rol !== rolFiltro) {
    return false;
  }

  return true;
}

async function main() {
  if (!dryRun && !confirm) {
    console.error('Debes pasar --confirm para ejecutar la purga real.');
    console.error('Usa --dry-run para ver qué se eliminaría.');
    process.exit(1);
  }

  const snapshot = await db.collection('usuarios').get();

  if (snapshot.empty) {
    console.log('No hay usuarios en la colección usuarios.');
    return;
  }

  const candidatos = snapshot.docs.filter((doc) => debePurgar(doc.data() || {}));

  if (!candidatos.length) {
    console.log('No hay usuarios que coincidan con los filtros.');
    return;
  }

  const etiqueta = dryRun ? '[DRY RUN] ' : '';
  console.log(`${etiqueta}Se purgarán ${candidatos.length} de ${snapshot.size} usuario(s).`);
  if (keepAdmin) {
    console.log('Se conservarán usuarios con rol ADMIN.');
  }
  if (rolFiltro) {
    console.log(`Filtro de rol: ${rolFiltro}`);
  }

  const resultados = [];
  for (const doc of candidatos) {
    const data = doc.data() || {};
    try {
      const resultado = await purgarDocumento(doc);
      resultados.push({ ...resultado, ok: true });
      const estado = resultado.inactivo ? 'inactivo' : 'activo';
      console.log(`- ${resultado.email || resultado.uid} (${resultado.rol}, ${estado})`);
    } catch (error) {
      resultados.push({
        uid: doc.id,
        email: data.email || null,
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
    console.log('\nEjecuta con --confirm para aplicar los cambios.');
    console.log('Ejemplo: node backend/scripts/purge-all-usuarios.js --confirm --keep-admin');
  } else if (keepAdmin) {
    console.log('\nUsuarios ADMIN conservados. El resto fue eliminado.');
  } else {
    console.log('\nTodos los usuarios fueron eliminados. Recrea el admin con seed-usuarios.js si hace falta.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en purge:', error.message);
    process.exit(1);
  });
