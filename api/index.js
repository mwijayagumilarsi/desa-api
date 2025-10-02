import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import sharp from "sharp"; 
import archiver from "archiver"; 
import { db } from "./firebase.js"; // Firestore instance
import admin from 'firebase-admin'; 
const Timestamp = admin.firestore.Timestamp; 
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import dotenv from "dotenv";
import { google } from "googleapis";
import fetch from "node-fetch";
import axios from "axios";

dotenv.config();

const app = express();

// 🔹 Konfigurasi Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🔹 Konfigurasi Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware
app.use(bodyParser.json());
app.use(cors());

// ✅ Upload berkas ke Cloudinary
app.post("/upload-berkas", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send({ error: "Tidak ada berkas yang diunggah." });
    }

    const streamUpload = (fileBuffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "pelayanan_desa" },
          (error, result) => {
            if (result) resolve(result);
            else reject(error);
          }
        );
        stream.end(fileBuffer);
      });
    };

    const result = await streamUpload(req.file.buffer);

    return res.status(200).send({ url: result.secure_url });
  } catch (error) {
    console.error("❌ Error unggah berkas:", error);
    return res.status(500).send({ error: "Gagal mengunggah berkas." });
  }
});

// ✅ Google Auth untuk FCM v1
const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"];
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), 
  },
  scopes: SCOPES,
});

// ✅ Kirim notifikasi
app.post("/send-notif", async (req, res) => {
  const { token, title, body } = req.body;

  if (!token || !title || !body) {
    return res.status(400).send({ error: "token, title, and body are required." });
  }

  try {
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const message = {
      message: {
        token,
        notification: { title, body },
      },
    };

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      }
    );

    const data = await response.json();

    if (response.ok) {
      return res.status(200).send({ success: true, message: "Notification sent.", data });
    } else {
      console.error("❌ Error FCM:", data);
      return res.status(500).send({ error: "Failed to send notification.", data });
    }
  } catch (error) {
    console.error("❌ Gagal kirim notifikasi:", error);
    return res.status(500).send({ error: "Failed to send notification." });
  }
});

// ✅ Hapus berkas di Cloudinary
app.post("/delete-berkas", async (req, res) => {
  try {
    const { fileUrl } = req.body;

    if (!fileUrl) {
      return res.status(400).send({ error: "fileUrl diperlukan." });
    }

    const parts = fileUrl.split("/");
    const fileName = parts.pop(); 
    const folderName = parts.pop(); 
    const publicId = `${folderName}/${fileName.split(".")[0]}`; 

    const result = await cloudinary.uploader.destroy(publicId);

    if (result.result === "ok") {
      return res.status(200).send({ success: true, message: "✅ File berhasil dihapus", publicId });
    } else {
      return res.status(500).send({ success: false, message: "❌ Gagal hapus file", result });
    }
  } catch (error) {
    console.error("❌ Error hapus berkas:", error);
    return res.status(500).send({ error: "Gagal menghapus berkas." });
  }
});

// ==================== EXPORT LAPORAN BULANAN ====================
app.get('/export-laporan-bulanan', async (req, res) => {
  try {
    const { bulan, tahun } = req.query;
    if (!bulan || !tahun) {
      return res.status(400).send('Parameter bulan & tahun wajib diisi');
    }

    const bulanInt = parseInt(bulan) - 1; 
    const startDate = new Date(tahun, bulanInt, 1);
    const endDate = new Date(tahun, bulanInt + 1, 1);

    // Ambil laporan dari Firestore
    const snapshot = await db.collection('laporan_driver')
      .where('tanggal_pengerjaan', '>=', admin.firestore.Timestamp.fromDate(startDate))
      .where('tanggal_pengerjaan', '<', admin.firestore.Timestamp.fromDate(endDate))
      .get();

    if (snapshot.empty) {
      return res.status(404).send('Tidak ada laporan di bulan ini');
    }

    // Streaming ZIP
    res.setHeader('Content-Disposition', `attachment; filename="Laporan_${bulan}_${tahun}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const namaFolder = (data.nama_pemohon || 'Laporan').replace(/[^a-z0-9]/gi, '_').substring(0, 50);

      const fotoList = data.dokumentasi_foto || [];

      for (const [i, fotoUrl] of fotoList.entries()) {
        try {
          const response = await axios.get(fotoUrl, { responseType: 'arraybuffer' });
          const imageBuffer = Buffer.from(response.data);

          // Overlay teks dari field Firestore (HILANGKAN font-family)
          const svgOverlay = `
            <svg width="1280" height="220" xmlns="http://www.w3.org/2000/svg">
              <style>
                .title { fill: white; font-size: 28px; font-weight: bold; }
              </style>
              <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.5)" />
              <text x="20" y="40" class="title">Pemohon: ${data.nama_pemohon || '-'}</text>
              <text x="20" y="80" class="title">Driver: ${data.nama_driver || '-'}</text>
              <text x="20" y="120" class="title">Instansi: ${data.instansi_rujukan || '-'}</text>
              <text x="20" y="160" class="title">Alamat: ${data.alamat_pemohon || '-'}</text>
              <text x="20" y="200" class="title">Tanggal: ${data.tanggal_pengerjaan ? data.tanggal_pengerjaan.toDate().toLocaleDateString() : '-'}</text>
            </svg>
          `;

          const processedImage = await sharp(imageBuffer)
            .resize({ width: 1280 })
            .composite([{ input: Buffer.from(svgOverlay), gravity: 'southwest' }])
            .jpeg({ quality: 90 })
            .toBuffer();

          archive.append(processedImage, { name: `${namaFolder}/foto_${i + 1}.jpg` });
        } catch (err) {
          console.error(`Gagal proses foto: ${fotoUrl}`, err);
        }
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error('Error ekspor laporan bulanan:', error);
    res.status(500).send('Terjadi kesalahan server');
  }
});

// ✅ Vercel: jangan pakai app.listen
export default app;
