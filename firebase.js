// api/firebase.js
const admin = require("firebase-admin");
const path = require("path");

const serviceAccount = require(path.join(__dirname, "serviceAccountKey.json"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://${serviceAccount.project_id}.firebaseio.com",
  });
}

const db = admin.firestore();

module.exports = { admin, db };
