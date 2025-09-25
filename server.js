// api/server.js
const express = require("express");
const { db } = require("./firebase");

const app = express();
app.use(express.json());

// ✅ Endpoint: GET semua user
app.get("/users", async (req, res) => {
  try {
    const snap = await db.collection("users").get();
    const data = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(data);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// ✅ Endpoint: POST tambah user
app.post("/users", async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: "name & email wajib diisi" });
    }
    const ref = await db.collection("users").add({ name, email });
    res.json({ success: true, id: ref.id });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// Jalankan server
const PORT = 3000;
app.listen(PORT, () => {
  console.log("API Desa running at http://localhost:${PORT}");
});
