const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let keyPath = path.resolve(__dirname, 'config/firebase-key.json');
if (!fs.existsSync(keyPath)) {
    console.error("No firebase key found");
    process.exit(1);
}

const serviceAccount = require(keyPath);

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch(e){}

const db = admin.firestore();

function generateCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const letter = letters[Math.floor(Math.random() * letters.length)];
  const nums = Math.floor(1000 + Math.random() * 9000);
  return `${letter}${nums}`;
}

async function run() {
  // Use collection 'vehiculos' based on backend source code
  const snapshot = await db.collection('vehiculos').get();
  const existingCodes = new Set();
  
  // Collect existing valid codes to avoid duplicates
  for (const doc of snapshot.docs) {
    const code = doc.data().codigo;
    if (code && /^[A-Z]\d{4}$/.test(code)) {
      existingCodes.add(code);
    }
  }
  
  let count = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    let codigo = data.codigo || '';
    
    // Update if it doesn't match [A-Z][0-9]{4}
    if (!/^[A-Z]\d{4}$/.test(codigo)) {
      let newCode = generateCode();
      while (existingCodes.has(newCode)) {
        newCode = generateCode();
      }
      existingCodes.add(newCode);
      
      await doc.ref.update({ codigo: newCode });
      console.log(`Updated unit ${doc.id}: '${codigo}' -> '${newCode}'`);
      count++;
    }
  }
  console.log(`Finished updating ${count} units in collection 'vehiculos'.`);
}

run().catch(console.error);
