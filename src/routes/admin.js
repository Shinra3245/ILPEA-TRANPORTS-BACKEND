const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
// Importamos ambos middlewares
const { autenticar, autorizar } = require('../middleware/auth'); 

// ✅ SOLUCIÓN: Agregamos 'autenticar' antes de 'autorizar'
router.get('/usuarios-asignados', autenticar, autorizar('usuarios:ver'), async (req, res) => {
  try {
    const db = admin.firestore();
    const snapshot = await db.collection('usuarios')
      .where('rol', '==', 'EMPLEADO')
      .get();
    
    const data = snapshot.docs.map(doc => {
      const u = doc.data();
      return {
        num_control: u.id_empleado || doc.id,
        nombre: u.nombre || 'N/D',
        puesto: u.puesto || 'Operario',
        dpto: u.dpto || 'Producción',
        turno: u.turno || '1ero',
        empresa: 'ILPEA',
        horario_entrada: u.horario_entrada || '06:00',
        horario_salida: u.horario_salida || '14:00',
        dias_trabajo: u.dias_trabajo || 'L-S',
        domicilio: u.domicilio || 'S/D',
        colonia: u.colonia || 'S/C',
        referencia: u.referencia || '',
        ruta_asignada: u.ruta_id || 'SIN RUTA', 
        parada_asignada: u.parada_nombre || 'S/P',
        estatus: u.activo ? 'ACTIVO' : 'INACTIVO'
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en OCI-Backend:', error);
    res.status(500).json({ success: false, message: 'Error interno' });
  }
});

module.exports = router;