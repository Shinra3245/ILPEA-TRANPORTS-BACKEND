/**
 * Middleware de Autenticación y Autorización (RBAC)
 */

const admin = require('firebase-admin');
const { ROLES, tienePermiso } = require('../config/roles');

const TOKEN_CACHE_TTL_MS = Number(process.env.AUTH_TOKEN_CACHE_TTL_MS || 30_000);
const USER_CACHE_TTL_MS = Number(process.env.AUTH_USER_CACHE_TTL_MS || 60_000);
const tokenCache = new Map();
const userCache = new Map();

function cacheValido(entry) {
  return entry && Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now();
}

function obtenerTokenCache(token) {
  const entry = tokenCache.get(token);
  if (!cacheValido(entry)) {
    tokenCache.delete(token);
    return null;
  }
  return entry.value;
}

function guardarTokenCache(token, decodedToken) {
  tokenCache.set(token, {
    value: decodedToken,
    expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
  });
}

function obtenerUsuarioCache(uid) {
  const entry = userCache.get(uid);
  if (!cacheValido(entry)) {
    userCache.delete(uid);
    return null;
  }
  return entry.value;
}

function guardarUsuarioCache(uid, userData) {
  userCache.set(uid, {
    value: userData,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
}

function invalidarCacheUsuario(uid) {
  if (uid) {
    userCache.delete(uid);
  }
}

/**
 * Middleware: Verificar token de Firebase y extraer datos del usuario
 * Busca el token en el header Authorization: Bearer <token>
 */
async function autenticar(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Token no proporcionado o inválido. Use: Authorization: Bearer <token>'
    });
  }

  const token = authHeader.substring(7); // Elimina "Bearer "

  try {
    const decodedToken = obtenerTokenCache(token) || await admin.auth().verifyIdToken(token);
    if (!obtenerTokenCache(token)) {
      guardarTokenCache(token, decodedToken);
    }

    let userData = obtenerUsuarioCache(decodedToken.uid);
    if (!userData) {
      const userDoc = await admin.firestore().collection('usuarios').doc(decodedToken.uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({
          success: false,
          message: 'Usuario no encontrado en la base de datos.'
        });
      }

      userData = userDoc.data() || {};
      guardarUsuarioCache(decodedToken.uid, userData);
    }

    if (!userData) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en la base de datos.'
      });
    }

    // Adjuntar información del usuario al request
    req.usuario = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      rol: userData.rol || ROLES.EMPLEADO,
      nombre: userData.nombre || 'Usuario',
      ...userData
    };

    next();
  } catch (error) {
    console.error('Error autenticando:', error.message);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({
        success: false,
        message: 'Token expirado. Por favor, inicia sesión nuevamente.'
      });
    }

    res.status(401).json({
      success: false,
      message: 'No autorizado. Token inválido.'
    });
  }
}

/**
 * Middleware: Verificar que el usuario tiene permiso para una acción
 * @param {string|string[]} accionesRequeridas - Acción o array de acciones
 * @returns {Function} Middleware express
 */
function autorizar(accionesRequeridas) {
  // Normalizar a array
  const acciones = Array.isArray(accionesRequeridas) 
    ? accionesRequeridas 
    : [accionesRequeridas];

  return (req, res, next) => {
    // Si no hay usuario autenticado (debería haber pasado por autenticar primero)
    if (!req.usuario) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // Verificar si el usuario tiene alguno de los permisos requeridos
    const tieneAlgunPermiso = acciones.some(accion => 
      tienePermiso(req.usuario.rol, accion)
    );

    if (!tieneAlgunPermiso) {
      return res.status(403).json({
        success: false,
        message: `Permiso denegado. Tu rol (${req.usuario.rol}) no tiene acceso a esta acción.`,
        accionesRequeridas: acciones,
        rolDelUsuario: req.usuario.rol
      });
    }

    next();
  };
}

/**
 * Middleware alternativo: Sin autenticación Firebase (para desarrollo/testing)
 * Simula un usuario basado en header X-User-Role
 */
function autenticarSimulado(req, res, next) {
  const rolHeader = String(req.headers['x-user-role'] || ROLES.EMPLEADO).toUpperCase();
  const rol = Object.values(ROLES).includes(rolHeader) ? rolHeader : ROLES.EMPLEADO;
  const userId = req.headers['x-user-id'] || 'usuario-simulado-' + Date.now();

  req.usuario = {
    uid: userId,
    email: 'simulado@ilpea.test',
    rol: rol,
    nombre: rol === ROLES.ADMIN ? 'Admin Simulado' : 
           rol === ROLES.JEFE ? 'Jefe Simulado' : 
           rol === ROLES.CAMIONERO ? 'Camionero Simulado' :
             'Empleado Simulado'
  };

  next();
}

/**
 * Middleware: Logging de acciones (auditoría)
 */
function registrarAccion(coleccion = 'acciones', opciones = {}) {
  const rutasExcluidas = new Set(Array.isArray(opciones.rutasExcluidas) ? opciones.rutasExcluidas : []);
  const metodosExcluidos = new Set(Array.isArray(opciones.metodosExcluidos)
    ? opciones.metodosExcluidos.map((metodo) => String(metodo).toUpperCase())
    : []);

  return async (req, res, next) => {
    const metodoActual = String(req.method || '').toUpperCase();
    if (rutasExcluidas.has(req.path) || metodosExcluidos.has(metodoActual)) {
      return next();
    }

    // Capturar la respuesta original
    const originalJson = res.json.bind(res);

    res.json = function(data) {
      const CLAVES_SENSIBLES = ['password', 'token', 'authorization', 'auth'];

      const normalizarObjeto = (valor) => {
        if (!valor || typeof valor !== 'object') return {};
        return Object.fromEntries(
          Object.entries(valor).map(([k, v]) => {
            if (CLAVES_SENSIBLES.includes(String(k).toLowerCase())) {
              return [k, '[REDACTED]'];
            }
            return [k, v === undefined ? null : v];
          })
        );
      };

      // Registrar en Firestore
      if (req.usuario) {
        admin.firestore().collection(coleccion).add({
          timestamp: new Date(),
          usuario_id: req.usuario.uid,
          usuario_rol: req.usuario.rol,
          usuario_email: req.usuario.email,
          metodo: req.method,
          ruta: req.path,
          status: res.statusCode,
          exitoso: res.statusCode >= 200 && res.statusCode < 300,
          datos: {
            body: normalizarObjeto(req.body),
            params: normalizarObjeto(req.params),
            query: normalizarObjeto(req.query)
          }
        }).catch(err => console.error('Error registrando acción:', err));
      }

      return originalJson(data);
    };

    next();
  };
}

module.exports = {
  autenticar,
  autorizar,
  autenticarSimulado,
  registrarAccion,
  invalidarCacheUsuario,
};
