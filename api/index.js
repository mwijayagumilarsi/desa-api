import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
// ❗️ PUSTAKA IMAGE PROCESSING BARU: Jimp
import Jimp from "jimp"; 
// PUSTAKA FILE DAN ZIP
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

// 🟢 ENDPOINT EKSPOR LAPORAN BULANAN (IMPLEMENTASI JIMP YANG STABIL)
app.post("/export-laporan-bulanan", async (req, res) => {
    const { bulan, tahun } = req.body;

    if (!bulan || !tahun) {
        return res.status(400).send({ error: "Bulan dan tahun diperlukan." });
    }

    // 1. Hitung Rentang Tanggal
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

        archive.pipe(res);
        
        // 🔑 JIMP: Muat font bawaan yang terjamin bekerja
        // FONT SANS_32_WHITE untuk metadata, FONT SANS_64_YELLOW untuk judul/ID
        const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
        const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_64_YELLOW);
        
        // Estimasi tinggi baris untuk padding
        const padding = 40;
        const lineHeight = Jimp.measureTextHeight(font, 'Test', 1000); 

        // 4. Proses Setiap Laporan
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const docId = doc.id;
            
            const safePemohonName = (data.nama_pemohon || 'Laporan').replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const folderName = `${docId}_${safePemohonName}`;
            const fotoList = data.dokumentasi_foto || [];

            // Buat string metadata utuh
            const tanggalFormatted = data.tanggal_pengerjaan ? data.tanggal_pengerjaan.toDate().toLocaleString('id-ID', {
                day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
            }) : 'N/A';
            
            const reportMetadata = 
                `Tanggal: ${tanggalFormatted}\n` +
                `Pemohon: ${data.nama_pemohon || 'N/A'}\n` +
                `Driver: ${data.nama_driver || 'N/A'}\n` +
                `Instansi: ${data.instansi_rujukan || 'N/A'}\n` +
                `Alamat: ${data.alamat_pemohon || 'N/A'}`;

            // 5. Unduh dan Tambahkan Foto DENGAN KETERANGAN TERTANAM
            for (let i = 0; i < fotoList.length; i++) {
                const fotoUrl = fotoList[i];
                let fotoBuffer;

                try {
                    const fotoResponse = await fetch(fotoUrl);
                    if (!fotoResponse.ok) {
                         console.warn(`Gagal unduh foto: ${fotoUrl} (Status: ${fotoResponse.status})`);
                         continue; // Lanjutkan ke foto berikutnya
                    }
                    
                    fotoBuffer = await fotoResponse.buffer(); 
                    const extension = path.extname(new URL(fotoUrl).pathname) || '.jpg';
                    const fileIndex = i + 1;
                    const fileName = `foto_${fileIndex}${extension}`;
                    
                    // 🔑 JIMP: Baca gambar dari buffer
                    const image = await Jimp.read(fotoBuffer);
                    const { width, height } = image.bitmap;
                    
                    const annotationText = reportMetadata.replace(/\n/g, ' | ');
                    const titleLine = `FOTO KE-${fileIndex}/${fotoList.length} | ID: ${docId}`;
                    
                    // --- Hitung Posisi Teks ---
                    const maxWidth = width - (2 * padding);
                    
                    // Kunci untuk Jimp: Gunakan Jimp.measureTextHeight untuk menghitung total tinggi teks dengan wrap
                    const titleHeight = Jimp.measureTextHeight(fontTitle, titleLine, maxWidth);
                    const metaHeight = Jimp.measureTextHeight(font, reportMetadata.replace(/\n/g, ' '), maxWidth); 

                    const totalTextHeight = titleHeight + metaHeight + 10; // Tambahkan spasi
                    const backgroundHeight = totalTextHeight + (2 * padding);
                    const backgroundY = height - backgroundHeight;
                    let textY = backgroundY + padding;

                    // 🔑 JIMP: Buat lapisan background hitam semi-transparan
                    // Gunakan Jimp.read untuk membuat background dari array RGB
                    const background = new Jimp(width, backgroundHeight, 0x000000B2); // Hitam 70% opacity
                    image.composite(background, 0, backgroundY);

                    // 🔑 JIMP: Tulis Teks (Judul)
                    Jimp.print(
                        image,
                        fontTitle, // Font Kuning/Besar
                        padding,
                        textY,
                        { text: titleLine, alignmentX: Jimp.HORIZ_ALIGN_LEFT },
                        maxWidth
                    );
                    textY += titleHeight; 
                    
                    // 🔑 JIMP: Tulis Teks (Metadata)
                    // Ganti '\n' menjadi ' ' agar Jimp bisa mengukur dan membungkus teks secara akurat di dalam Jimp.print
                    Jimp.print(
                        image,
                        font, 
                        padding,
                        textY,
                        { text: annotationText.replace(/ \| /g, '\n'), alignmentX: Jimp.HORIZ_ALIGN_LEFT },
                        maxWidth
                    );
                    
                    // Dapatkan buffer gambar hasil anotasi
                    fotoBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
                    
                    // Tambahkan foto (yang sudah dianotasi) ke dalam ZIP
                    archive.append(fotoBuffer, { name: path.join(folderName, fileName) });
                    
                } catch (e) {
                    console.error(`❌ Error saat memproses Jimp atau anotasi foto ${fotoUrl}:`, e);
                    // Fallback: Jika Jimp gagal, tambahkan foto asli ke ZIP (jika buffer masih ada)
                    if (fotoBuffer) {
                         archive.append(fotoBuffer, { name: path.join(folderName, `original_${fileIndex}${extension}`) });
                    }
                }
            }
        }

        // 6. Finalisasi ZIP
        await archive.finalize();

    } catch (error) {
        console.error("❌ Error ekspor laporan bulanan:", error);
        if (!res.headersSent) {
            return res.status(500).send({ error: "Gagal memproses ekspor ZIP di server." });
        }
    }
});


// ✅ Vercel: jangan pakai app.listen (TETAP)
export default app;
