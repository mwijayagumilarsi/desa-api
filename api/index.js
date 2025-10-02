import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import sharp from "sharp"; 
import path from "path";
import archiver from "archiver"; 
import { db } from "./firebase.js"; // Firestore instance
import admin from 'firebase-admin'; 
const Timestamp = admin.firestore.Timestamp; 
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import dotenv from "dotenv";
import { google } from "googleapis";
import fetch from "node-fetch";

dotenv.config();

const app = express();

// 🔹 Konfigurasi Cloudinary (TETAP)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🔹 Konfigurasi Multer (TETAP)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware (TETAP)
app.use(bodyParser.json());
app.use(cors());

// ✅ Endpoint /upload-berkas (TETAP)
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

// ✅ Google Auth untuk FCM v1 (TETAP)
const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"];
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), 
  },
  scopes: SCOPES,
});

// ✅ Endpoint kirim notifikasi (TETAP)
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

// ✅ Hapus file di Cloudinary (TETAP)
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

// ----------------------------------------------------------------------
// 🛠️ FUNGSI BANTUAN SHARP: Memastikan kompatibilitas font
// ----------------------------------------------------------------------
const createSvgOverlay = (text, width, height, fileIndex, totalFiles) => {
    const lines = text.split('\n');
    
    const fontSize = Math.max(24, Math.floor(width / 45)); 
    const padding = Math.max(20, Math.floor(width / 60)); 
    const lineHeight = fontSize * 1.6; 
    
    const textHeight = (lines.length + 1) * lineHeight; 
    const backgroundHeight = textHeight + (2 * padding) + (textHeight * 0.5);
    const backgroundY = height - backgroundHeight;
    
    // 🔑 KUNCI: Font-family DIHILANGKAN
    let svgTextContent = '';
    
    const titleLine = `FOTO KE-${fileIndex}/${totalFiles}`;
    const titleYPos = backgroundY + padding + (fontSize * 1.0); 
    
    // Judul menggunakan warna kuning
    svgTextContent += `<text x="${padding}" y="${titleYPos}" fill="#FFEB3B" font-size="${fontSize + 4}px" font-weight="900" xml:space="preserve">${titleLine}</text>`; 
    
    lines.forEach((line, index) => {
        const yPos = titleYPos + (lineHeight * (index + 1)); 
        
        const escapedLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        svgTextContent += `<text x="${padding}" y="${yPos}" fill="white" font-size="${fontSize}px" font-weight="normal" xml:space="preserve">${escapedLine}</text>`;
    });

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="${backgroundY}" width="${width}" height="${backgroundHeight}" fill="rgba(0, 0, 0, 0.8)" />
            ${svgTextContent}
        </svg>
    `;

    return Buffer.from(svg, 'utf8');
};
// ==================== EXPORT LAPORAN BULANAN ====================
app.get('/export-laporan-bulanan', async (req, res) => {
  try {
    const { bulan, tahun } = req.query;
    if (!bulan || !tahun) {
      return res.status(400).send('Parameter bulan & tahun wajib diisi');
    }

    const bulanInt = parseInt(bulan) - 1; // bulan di JS dimulai dari 0
    const startDate = new Date(tahun, bulanInt, 1);
    const endDate = new Date(tahun, bulanInt + 1, 1);

    // Ambil data laporan dari Firestore
    const snapshot = await db.collection('laporan_driver')
      .where('tanggal', '>=', admin.firestore.Timestamp.fromDate(startDate))
      .where('tanggal', '<', admin.firestore.Timestamp.fromDate(endDate))
      .get();

    if (snapshot.empty) {
      return res.status(404).send('Tidak ada laporan di bulan ini');
    }

    // Siapkan streaming ZIP ke client
    res.setHeader('Content-Disposition', `attachment; filename="Laporan_${bulan}_${tahun}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const namaFolder = (data.nama_pemohon || 'Laporan').replace(/[^a-z0-9]/gi, '_').substring(0, 50);

      // Proses setiap foto laporan
      if (data.foto && Array.isArray(data.foto)) {
        for (const [i, fotoUrl] of data.foto.entries()) {
          try {
            // Download foto dari Cloudinary
            const response = await axios.get(fotoUrl, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data);

            // Buat overlay watermark dari Firestore data
            const svgOverlay = `
              <svg width="1280" height="220">
                <style>
                  .title { fill: white; font-size: 28px; font-weight: bold; font-family: Arial, sans-serif; }
                </style>
                <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.5)" />
                <text x="20" y="40" class="title">Pemohon: ${data.nama_pemohon || '-'}</text>
                <text x="20" y="80" class="title">Driver: ${data.nama_driver || '-'}</text>
                <text x="20" y="120" class="title">Instansi: ${data.instansi || '-'}</text>
                <text x="20" y="160" class="title">Alamat: ${data.alamat || '-'}</text>
                <text x="20" y="200" class="title">Tanggal: ${data.tanggal ? data.tanggal.toDate().toLocaleDateString() : '-'}</text>
              </svg>
            `;

            // Tambahkan watermark dengan Sharp
            const processedImage = await sharp(imageBuffer)
              .resize({ width: 1280 }) // supaya tidak berat
              .composite([
                {
                  input: Buffer.from(svgOverlay),
                  gravity: 'southwest'
                }
              ])
              .jpeg({ quality: 90 })
              .toBuffer();

            // Masukkan ke dalam zip
            archive.append(processedImage, { name: `${namaFolder}/foto_${i + 1}.jpg` });

          } catch (err) {
            console.error(`Gagal proses foto: ${fotoUrl}`, err);
            // fallback: masukkan gambar asli tanpa watermark
            archive.append(imageBuffer, { name: `${namaFolder}/foto_${i + 1}.jpg` });
          }
        }
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error('Error ekspor laporan bulanan:', error);
    res.status(500).send('Terjadi kesalahan server');
  }
});
// ✅ Vercel: jangan pakai app.listen (TETAP)
export default app;