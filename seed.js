const admin = require('firebase-admin');
const serviceAccount = require('./config/firebase-key.json');

// Inicialización
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// Capacidades oficiales ILPEA
const CAP = { CAMION: 30, SPRINTER: 19, VAN: 12 };

const rutasOficiales = [
    { n: 1, z: "Apaseo el Grande", t: "Camión", c: CAP.CAMION, m: 24 },
    { n: 2, z: "Rancherías", t: "Camión", c: CAP.CAMION, m: 24 },
    { n: 3, z: "Qro Obrera", t: "Sprinter", c: CAP.SPRINTER, m: 5 },
    { n: 4, z: "Qro Carrillo", t: "Van", c: CAP.VAN, m: 8 },
    { n: 5, z: "Rancho Nuevo", t: "Van", c: CAP.VAN, m: 7 },
    { n: 6, z: "Fuentes de Balvanera", t: "Van", c: CAP.VAN, m: 3 },
    { n: 7, z: "Celaya I", t: "Van", c: CAP.VAN, m: 6 },
    { n: 8, z: "Santa Rita", t: "Sprinter", c: CAP.SPRINTER, m: 11 },
    { n: 9, z: "Apaseo el Alto", t: "Camión", c: CAP.CAMION, m: 25 },
    { n: 10, z: "Tierrablanca", t: "Van", c: CAP.VAN, m: 11 },
    { n: 11, z: "San Miguel Octopan", t: "Camión", c: CAP.CAMION, m: 28 },
    { n: 12, z: "San Juan de la Vega", t: "Sprinter", c: CAP.SPRINTER, m: 16 },
    { n: 14, z: "Picacho", t: "Van", c: CAP.VAN, m: 2 },
    { n: 15, z: "Villagrán", t: "Camión", c: CAP.CAMION, m: 10 },
    { n: 16, z: "Comonfort", t: "Camión", c: CAP.CAMION, m: 21 },
    { n: 17, z: "Empalme Escobedo", t: "Camión", c: CAP.CAMION, m: 26 },
    { n: 18, z: "Juventino Rosas", t: "Camión", c: CAP.CAMION, m: 24 },
    { n: 19, z: "Cortazar Centro", t: "Sprinter", c: CAP.SPRINTER, m: 6 },
    { n: 20, z: "Cortazar", t: "Van", c: CAP.VAN, m: 6 },
    { n: 21, z: "Jerecuaro", t: "Camión", c: CAP.CAMION, m: 22 },
    { n: 22, z: "Salvatierra", t: "Camión", c: CAP.CAMION, m: 25 },
    { n: 23, z: "Tarimoro", t: "Camión", c: CAP.CAMION, m: 18 },
    { n: 24, z: "Acambaro", t: "Camión", c: CAP.CAMION, m: 27 },
    { n: 25, z: "Yuriria", t: "Camión", c: CAP.CAMION, m: 20 },
    { n: 26, z: "Moroleon", t: "Camión", c: CAP.CAMION, m: 15 },
    { n: 27, z: "Uriangato", t: "Camión", c: CAP.CAMION, m: 19 },
    { n: 28, z: "Valle de Santiago", t: "Camión", c: CAP.CAMION, m: 23 },
    { n: 29, z: "Jaral del Progreso", t: "Camión", c: CAP.CAMION, m: 12 },
    { n: 30, z: "Salamanca", t: "Camión", c: CAP.CAMION, m: 26 },
    { n: 31, z: "Irapuato", t: "Camión", c: CAP.CAMION, m: 21 },
    { n: 32, z: "Leon", t: "Camión", c: CAP.CAMION, m: 18 },
    { n: 33, z: "Silao", t: "Camión", c: CAP.CAMION, m: 10 }
];

async function sync() {
    try {
        console.log("--- INICIANDO LIMPIEZA TOTAL ---");
        const colRef = db.collection('rutas');
        const snapshot = await colRef.get();
        
        // Borrar todo lo anterior para que no se encimen datos de 37 asientos
        const batchDelete = db.batch();
        snapshot.docs.forEach(doc => batchDelete.delete(doc.ref));
        await batchDelete.commit();
        console.log(`✅ ${snapshot.size} rutas antiguas borradas.`);

        console.log("--- INSERTANDO 33 RUTAS OFICIALES ---");
        const batchInsert = db.batch();

        rutasOficiales.forEach(r => {
            const porcentaje = (r.m / r.c) * 100;
            const docRef = colRef.doc(`ruta_${r.n}`);
            
            batchInsert.set(docRef, {
                id: docRef.id,
                ruta: r.n,
                zona: r.z,
                "tipo de unidad": r.t,
                capacidad_real: r.c,
                max_pasajeros_dia: r.m,
                porcentaje_ocupacion_max: porcentaje,
                alerta_ocupacion: porcentaje < 40 ? "BAJO AFORO" : "OK",
                sugerencia_right_sizing: porcentaje < 40 ? "CAMBIAR UNIDAD" : "MANTENER",
                asientos_ocupados: [] // Iniciamos limpio para el Jefe
            });
        });

        await batchInsert.commit();
        console.log("🏆 ÉXITO: Base de datos sincronizada con 33 rutas.");
    } catch (e) {
        console.error("❌ ERROR:", e);
    } finally {
        process.exit();
    }
}

sync();