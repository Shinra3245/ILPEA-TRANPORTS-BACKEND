/**
 * Middleware de Autenticación y Autorización (RBAC)
 */

const admin = require('firebase-admin');
const { ROLES, tienePermiso } = require('../config/roles');

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
    // Verificar el token con Firebase Admin SDK
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Obtener datos adicionales del usuario desde Firestore
    const userDoc = await admin.firestore().collection('usuarios').doc(decodedToken.uid).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado en la base de datos.'
      });
    }

    // Adjuntar información del usuario al request
    req.usuario = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      rol: userDoc.data().rol || ROLES.EMPLEADO,
      nombre: userDoc.data().nombre || 'Usuario',
      ...userDoc.data()
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
           'Empleado Simulado'
  };

  next();
}

/**
 * Middleware: Logging de acciones (auditoría)
 */
function registrarAccion(coleccion = 'acciones') {
  return async (req, res, next) => {
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
  registrarAccion
};
