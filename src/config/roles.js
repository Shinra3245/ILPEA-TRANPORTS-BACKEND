/**
 * Configuración de Roles y Permisos (RBAC)
 * Define qué acciones puede realizar cada rol
 */

const ROLES = {
  ADMIN: 'ADMIN',
  JEFE: 'JEFE',
  EMPLEADO: 'EMPLEADO',
  CAMIONERO: 'CAMIONERO'
};

/**
 * Matriz de Permisos por Rol
 * Formato: { accion: [roles_permitidos] }
 */
const PERMISOS = {
  // Rutas
  'rutas:ver': [ROLES.ADMIN, ROLES.JEFE, ROLES.EMPLEADO, ROLES.CAMIONERO],
  'rutas:crear': [ROLES.ADMIN],
  'rutas:actualizar': [ROLES.ADMIN, ROLES.JEFE],
  'rutas:eliminar': [ROLES.ADMIN],
  'rutas:sync': [ROLES.ADMIN],

  // Asignaciones
  'asignacion:crear': [ROLES.ADMIN, ROLES.JEFE],
  'asignacion:ver': [ROLES.ADMIN, ROLES.JEFE, ROLES.EMPLEADO],
  'asignacion:cancelar': [ROLES.ADMIN, ROLES.JEFE],

  // Chat/IA
  'chat:enviar': [ROLES.ADMIN, ROLES.JEFE],
  'insights:ver': [ROLES.ADMIN, ROLES.JEFE],

  // Dashboard
  'dashboard:admin': [ROLES.ADMIN],
  'dashboard:jefe': [ROLES.ADMIN, ROLES.JEFE],
  'dashboard:empleado': [ROLES.ADMIN, ROLES.JEFE, ROLES.EMPLEADO],
  'dashboard:camionero': [ROLES.ADMIN, ROLES.CAMIONERO],

  // Usuarios
  'usuarios:ver': [ROLES.ADMIN],
  'usuarios:crear': [ROLES.ADMIN],
  'usuarios:actualizar': [ROLES.ADMIN],
  'usuarios:eliminar': [ROLES.ADMIN],

  // CRUD de empleados (ADMIN y JEFE)
  'empleados:ver': [ROLES.ADMIN, ROLES.JEFE],
  'empleados:crear': [ROLES.ADMIN, ROLES.JEFE],
  'empleados:actualizar': [ROLES.ADMIN, ROLES.JEFE],
  'empleados:eliminar': [ROLES.ADMIN, ROLES.JEFE],

  // CRUD de camioneros (ADMIN)
  'camioneros:ver': [ROLES.ADMIN],
  'camioneros:crear': [ROLES.ADMIN],
  'camioneros:actualizar': [ROLES.ADMIN],
  'camioneros:eliminar': [ROLES.ADMIN],
  'camioneros:asignar_unidad_turno': [ROLES.ADMIN],

  // CRUD de admins (Solo ADMIN)
  'admins:ver': [ROLES.ADMIN],
  'admins:crear': [ROLES.ADMIN],
  'admins:actualizar': [ROLES.ADMIN],
  'admins:eliminar': [ROLES.ADMIN],

  // CRUD de jefes (Solo ADMIN)
  'jefes:ver': [ROLES.ADMIN],
  'jefes:crear': [ROLES.ADMIN],
  'jefes:actualizar': [ROLES.ADMIN],
  'jefes:eliminar': [ROLES.ADMIN],

  // Programación semanal
  'programacion_semanal:ver': [ROLES.ADMIN, ROLES.JEFE, ROLES.EMPLEADO],
  'programacion_semanal:crear': [ROLES.ADMIN, ROLES.JEFE],
  'programacion_semanal:eliminar': [ROLES.ADMIN, ROLES.JEFE],

  // Abordajes (pase de lista)
  'abordajes:registrar': [ROLES.ADMIN, ROLES.JEFE, ROLES.CAMIONERO],
  'abordajes:ver': [ROLES.ADMIN, ROLES.JEFE, ROLES.CAMIONERO],

  // Métricas agregadas
  'metricas:ver': [ROLES.ADMIN, ROLES.JEFE],
  'metricas:rollup': [ROLES.ADMIN],

  // Catálogo de turnos
  'turnos:ver': [ROLES.ADMIN, ROLES.JEFE],
  'turnos:crear': [ROLES.ADMIN],
  'turnos:actualizar': [ROLES.ADMIN],
  'turnos:eliminar': [ROLES.ADMIN],

  // Catálogo de unidades (vehículos)
  'unidades:ver': [ROLES.ADMIN, ROLES.JEFE],
  'unidades:crear': [ROLES.ADMIN],
  'unidades:actualizar': [ROLES.ADMIN],
  'unidades:eliminar': [ROLES.ADMIN],
};

/**
 * Descripción de Roles
 */
const DESCRIPCION_ROLES = {
  [ROLES.ADMIN]: {
    nombre: 'Administrador',
    descripcion: 'Acceso total al sistema. Gestiona rutas, usuarios y configuración.',
    color: '#0f172a'
  },
  [ROLES.JEFE]: {
    nombre: 'Jefe de Turno',
    descripcion: 'Gestiona asignaciones, monitorea rutas y accede al copiloto IA.',
    color: '#2563eb'
  },
  [ROLES.EMPLEADO]: {
    nombre: 'Empleado',
    descripcion: 'Visualiza su ruta asignada y estado de viaje.',
    color: '#10b981'
  },
  [ROLES.CAMIONERO]: {
    nombre: 'Camionero',
    descripcion: 'Escanea QR y registra abordajes en ruta.',
    color: '#f59e0b'
  }
};

/**
 * Verifica si un rol tiene permiso para una acción
 * @param {string} rol - El rol del usuario
 * @param {string} accion - La acción a verificar (ej: 'rutas:ver')
 * @returns {boolean}
 */
function tienePermiso(rol, accion) {
  if (!PERMISOS[accion]) {
    console.warn(`Acción no registrada: ${accion}`);
    return false;
  }
  return PERMISOS[accion].includes(rol);
}

/**
 * Obtiene todos los permisos de un rol
 * @param {string} rol
 * @returns {string[]} Array de acciones permitidas
 */
function obtenerPermisosDelRol(rol) {
  return Object.keys(PERMISOS).filter(accion => PERMISOS[accion].includes(rol));
}

module.exports = {
  ROLES,
  PERMISOS,
  DESCRIPCION_ROLES,
  tienePermiso,
  obtenerPermisosDelRol
};
