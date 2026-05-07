const admin = require('firebase-admin');

try {
  // Check karein ki app pehle se initialize toh nahi hai
  if (!admin.apps.length) {
    // Environment variable se service account key lein
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    console.log('Firebase Admin Initialized Successfully.');
  }
} catch (error) {
  console.error('Firebase Admin Initialization Error:', error.message);
}

// Database instance ko export karein taaki dusri files use kar sakein
module.exports = { admin, db: admin.database() };
