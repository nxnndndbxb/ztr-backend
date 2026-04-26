const admin = require("firebase-admin");

const serviceAccount = require("../serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://fortune-2cb70-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();

module.exports = { admin, db };