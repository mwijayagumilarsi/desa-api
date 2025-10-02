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

// 🟢 ENDPOINT EKSPOR LAPORAN BULANAN (REVISI PENANGANAN ERROR SHARP)
app.post("/export-laporan-bulanan", async (req, res) => {
    const { bulan, tahun } = req.body;

    if (!bulan || !tahun) {
        return res.status(400).send({ error: "Bulan dan tahun diperlukan." });
    }

    // 1. Hitung Rentang Tanggal (TETAP)
    const startOfMonth = new Date(tahun, bulan - 1, 1);
    const endOfMonth = new Date(tahun, bulan, 0, 23, 59, 59, 999);

    const startTimestamp = Timestamp.fromDate(startOfMonth);
    const endTimestamp = Timestamp.fromDate(endOfMonth);

    const monthName = startOfMonth.toLocaleString('id-ID', { month: 'long' });
    const zipFileName = `Dokumentasi_Laporan_${monthName}_${tahun}.zip`;

    // 2. Query Firestore (TETAP)
    try {
        const snapshot = await db.collection('laporan_driver')
            .where('tanggal_pengerjaan', '>=', startTimestamp)
            .where('tanggal_pengerjaan', '<=', endTimestamp)
            .orderBy('tanggal_pengerjaan', 'asc')
            .get();

        if (snapshot.empty) {
            return res.status(404).send({ error: `Tidak ada laporan pada ${monthName} ${tahun}.` });
        }

        // 3. Persiapan Archiver dan Headers (TETAP)
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);

        const archive = archiver('zip', {
            zlib: { level: 9 } 
        });

        archive.pipe(res);

        // 4. Proses Setiap Laporan (TETAP)
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const docId = doc.id;
            
            const safePemohonName = (data.nama_pemohon || 'Laporan').replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const folderName = `${docId}_${safePemohonName}`;
            const fotoList = data.dokumentasi_foto || [];

            const tanggalFormatted = data.tanggal_pengerjaan ? data.tanggal_pengerjaan.toDate().toLocaleString('id-ID', {
                day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
            }) : 'N/A';
            
            const reportMetadata = 
                `ID Laporan: ${docId}` +
                `\nTanggal: ${tanggalFormatted}` +
                `\nPemohon: ${data.nama_pemohon || 'N/A'}` +
                `\nDriver: ${data.nama_driver || 'N/A'}` +
                `\nInstansi: ${data.instansi_rujukan || 'N/A'}` +
                `\nAlamat: ${data.alamat_pemohon || 'N/A'}`;

            // 5. Unduh dan Tambahkan Foto DENGAN KETERANGAN TERTANAM
            for (let i = 0; i < fotoList.length; i++) {
                const fotoUrl = fotoList[i];
                
                try {
                    const fotoResponse = await fetch(fotoUrl);
                    if (!fotoResponse.ok) {
                        console.warn(`Gagal unduh foto: ${fotoUrl} (Status: ${fotoResponse.status})`);
                        continue; // Lanjut ke foto berikutnya jika gagal unduh
                    }

                    let fotoBuffer = await fotoResponse.buffer(); 
                    let bufferFinal = fotoBuffer; // 🔑 Default: Gunakan buffer asli

                    const extension = path.extname(new URL(fotoUrl).pathname) || '.jpg';
                    const fileIndex = i + 1;
                    const fileName = `foto_${fileIndex}${extension}`;
                    
                    try {
                        // Proses Sharp: Ini adalah blok yang rentan error
                        const image = sharp(fotoBuffer);
                        const metadata = await image.metadata();
                        const { width, height } = metadata;

                        if (width && height) {
                            const svgOverlayBuffer = createSvgOverlay(
                                reportMetadata, 
                                width, 
                                height, 
                                fileIndex, 
                                fotoList.length
                            );

                            bufferFinal = await image
                                .composite([{
                                    input: svgOverlayBuffer,
                                    left: 0,
                                    top: 0
                                }])
                                .jpeg({ quality: 90 }) 
                                .toBuffer();
                                
                            console.log(`✅ Foto ${fileName} berhasil dianotasi.`);
                        } else {
                            console.warn(`⚠️ Gagal mendapatkan dimensi untuk ${fileName}. Menyertakan foto asli.`);
                        }
                    } catch (sharpError) {
                        // 🔑 KUNCI PERBAIKAN: Jika Sharp gagal (misal: Memory Limit, format tidak didukung)
                        console.error(`❌ Error pemrosesan Sharp pada ${fileName}. Menyertakan foto asli.`, sharpError.message);
                        bufferFinal = fotoBuffer; // Gunakan buffer asli yang belum diubah
                    }

                    // Tambahkan foto (yang sudah dianotasi ATAU yang asli) ke dalam ZIP
                    archive.append(bufferFinal, { name: path.join(folderName, fileName) });
                    
                } catch (e) {
                    console.error(`❌ Error fatal saat memproses ${fotoUrl}:`, e);
                    // Jika ini gagal, loop akan berlanjut, tetapi Anda harus memeriksa log server Anda
                    // untuk melihat mengapa unduhan (fetch) atau append ke zip gagal.
                }
            }
        }

        // 6. Finalisasi ZIP (TETAP)
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