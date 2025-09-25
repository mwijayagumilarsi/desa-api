// desa-api/api/index.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { admin, db } = require("./firebase");

// 🔹 Tambahan untuk upload file
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const dotenv = require("dotenv");

dotenv.config(); // Memuat variabel dari file .env

const app = express();
const port = process.env.PORT || 3000;


// Konfigurasi Cloudinary dari variabel lingkungan (.env)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Konfigurasi Multer untuk menyimpan file sementara
const upload = multer({ dest: "uploads/" });

app.use(bodyParser.json());
app.use(cors());

// 🔹 Endpoint baru untuk mengunggah berkas ke Cloudinary
app.post("/upload-berkas", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send({ error: "Tidak ada berkas yang diunggah." });
    }

    // Unggah file ke Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: "pelayanan_desa", // Nama folder di Cloudinary
    });

    // Hapus file sementara dari folder lokal
    const fs = require("fs");
    fs.unlinkSync(req.file.path);

    // Kirim URL berkas yang sudah diunggah ke Flutter
    return res.status(200).send({ url: result.secure_url });
  } catch (error) {
    console.error("❌ Error unggah berkas:", error);
    return res.status(500).send({ error: "Gagal mengunggah berkas." });
  }
});

// 🔹 Endpoint lama untuk mengirim notifikasi (diperbaiki)
app.post("/send-notif", async (req, res) => {
  // Mengubah 'uid' menjadi 'token'
  const { token, title, body } = req.body;

  if (!token || !title || !body) {
    return res.status(400).send({ error: "token, title, and body are required." });
  }

  try {
    // Tidak perlu mencari token lagi, karena sudah dikirim dari klien
    const message = {
      notification: { title, body },
      token,
    };

    await admin.messaging().send(message);
    return res.status(200).send({ success: true, message: "Notification sent." });
  } catch (error) {
    console.error(`❌ Gagal kirim notifikasi ke token ${token}:`, error);
    return res.status(500).send({ error: "Failed to send notification." });
  }
});

app.listen(port, () => {
console.log(`🚀 API server berjalan di port ${port}`);
});