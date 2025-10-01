// index.js (Backend - Node.js/Express)
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
// ❗️ TAMBAHKAN fs dan path
import fs from "fs";
import path from "path";
// ❗️ TAMBAHKAN ARCHIVER
import archiver from "archiver";
// PENTING: Pastikan ini mengimpor instance Firestore dan admin yang benar
import { db } from "./firebase.js"; 
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

    // Ambil public_id dari URL Cloudinary
    const parts = fileUrl.split("/");
    const fileName = parts.pop(); 
    const folderName = parts.pop(); 
    const publicId = `${folderName}/${fileName.split(".")[0]}`; 

    // Hapus file dari Cloudinary
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


// 🟢 ENDPOINT BARU: EKSPOR LAPORAN BULANAN KE ZIP
app.post("/export-laporan-bulanan", async (req, res) => {
    const { bulan, tahun } = req.body;

    if (!bulan || !tahun) {
        return res.status(400).send({ error: "Bulan dan tahun diperlukan." });
    }

    // 1. Hitung Rentang Tanggal
    // Bulan di JS adalah 0-indexed (Januari=0), tapi dari Flutter kita kirim 1-indexed.
    const startOfMonth = new Date(tahun, bulan - 1, 1);
    const endOfMonth = new Date(tahun, bulan, 0, 23, 59, 59, 999);

    const startTimestamp = Timestamp.fromDate(startOfMonth);
    const endTimestamp = Timestamp.fromDate(endOfMonth);

    // Format nama file ZIP
    const monthName = startOfMonth.toLocaleString('id-ID', { month: 'long' });
    const zipFileName = `Dokumentasi_Laporan_${monthName}_${tahun}.zip`;

    // 2. Query Firestore
    try {
        const snapshot = await db.collection('laporan_driver')
            .where('tanggal_pengerjaan', '>=', startTimestamp)
            .where('tanggal_pengerjaan', '<=', endTimestamp)
            .orderBy('tanggal_pengerjaan', 'asc')
            .get();

        if (snapshot.empty) {
            return res.status(404).send({ error: `Tidak ada laporan pada ${monthName} ${tahun}.` });
        }

        // 3. Persiapan Archiver dan Headers
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);

        const archive = archiver('zip', {
            zlib: { level: 9 } 
        });

        // Pipe archiver output ke response HTTP
        archive.pipe(res);

        // 4. Proses Setiap Laporan
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const docId = doc.id;
            // Gunakan nama pemohon untuk folder
            const safePemohonName = (data.nama_pemohon || 'Laporan').replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const folderName = `${docId}_${safePemohonName}`;
            const fotoList = data.dokumentasi_foto || [];

            // a. Buat File Keterangan
            const tanggalFormatted = data.tanggal_pengerjaan ? data.tanggal_pengerjaan.toDate().toLocaleString('id-ID', {
                day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
            }) : 'N/A';
            
            let keterangan = `======================================\n`;
            keterangan += `LAPORAN PEKERJAAN - ID: ${docId}\n`;
            keterangan += `======================================\n`;
            keterangan += `Tanggal Pengerjaan: ${tanggalFormatted}\n`;
            keterangan += `Pemohon: ${data.nama_pemohon || 'N/A'}\n`;
            keterangan += `Driver: ${data.nama_driver || 'N/A'}\n`;
            keterangan += `Instansi Rujukan: ${data.instansi_rujukan || 'N/A'}\n`;
            keterangan += `Alamat: ${data.alamat_pemohon || 'N/A'}\n`;
            keterangan += `Jumlah Foto: ${fotoList.length}\n`;
            keterangan += `======================================`;

            // Tambahkan file keterangan ke dalam ZIP
            archive.append(keterangan, { name: path.join(folderName, 'keterangan_laporan.txt') });


            // b. Unduh dan Tambahkan Foto
            for (let i = 0; i < fotoList.length; i++) {
                const fotoUrl = fotoList[i];
                try {
                    const fotoResponse = await fetch(fotoUrl);
                    if (fotoResponse.ok) {
                        const fotoBuffer = await fotoResponse.buffer();
                        // Ambil ekstensi dari URL, default ke .jpg
                        const extension = path.extname(new URL(fotoUrl).pathname) || '.jpg';
                        
                        // Tambahkan foto ke dalam ZIP
                        archive.append(fotoBuffer, { name: path.join(folderName, `foto_${i + 1}${extension}`) });
                    } else {
                        console.warn(`Gagal unduh foto: ${fotoUrl}`);
                    }
                } catch (e) {
                    console.error(`Error saat fetching foto ${fotoUrl}:`, e);
                }
            }
        }

        // 5. Finalisasi ZIP
        await archive.finalize();

    } catch (error) {
        console.error("❌ Error ekspor laporan bulanan:", error);
        // Pastikan response header tidak dikirim jika terjadi error di tengah jalan
        if (!res.headersSent) {
            return res.status(500).send({ error: "Gagal memproses ekspor ZIP." });
        }
    }
});


// ✅ Vercel: jangan pakai app.listen (TETAP)
export default app;