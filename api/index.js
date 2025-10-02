import express from "express"; 
import bodyParser from "body-parser";
import cors from "cors";
import sharp from "sharp";
import archiver from "archiver";
import { db } from "./firebase.js"; // Firestore instance
import admin from "firebase-admin";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import dotenv from "dotenv";
import { google } from "googleapis";
import fetch from "node-fetch";
import axios from "axios";

dotenv.config();

const app = express();

// 🔹 Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🔹 Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware
app.use(bodyParser.json());
app.use(cors());

// ----------------- Helper: Menghasilkan Transformasi Teks Cloudinary -----------------
/**
 * Membuat string transformasi l_text yang dirantai (chained) untuk teks multi-baris.
 * @param {string[]} lines - Array dari string teks, di mana setiap string adalah satu baris.
 * @returns {string} String transformasi Cloudinary yang dirantai (contoh: t_text/t_text)
 */
function createTextWatermarkTransformations(lines) {
  const baseFontSize = 28;
  const transforms = [];
  const lineHeight = 35; 
  const initialY = 20;  
  const initialX = 20; 

  lines.slice().reverse().forEach((text, index) => {
    // URL-encode teks, dan ganti tanda kutip tunggal ('') yang sering menyebabkan masalah encoding
    const encodedText = encodeURIComponent(text).replace(/'/g, '%27'); 
    
    const yPosition = initialY + (index * lineHeight); 

    // Output adalah STRING transformasi l_text
    const transformString = 
        `l_text:Arial_${baseFontSize}_bold:${encodedText},g_south_west,x_${initialX},y_${yPosition},co_rgb:FFFFFF,o_80`;
    
    transforms.push(transformString);
  });
  
  // Gabungkan semua string transformasi, dipisahkan oleh '/'
  return transforms.reverse().join('/');
}

// ----------------- Upload berkas -----------------
app.post("/upload-berkas", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send({ error: "Tidak ada berkas yang diunggah." });

    const streamUpload = (fileBuffer) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: "pelayanan_desa" }, (error, result) => {
          if (result) resolve(result);
          else reject(error);
        });
        stream.end(fileBuffer);
      });

    const result = await streamUpload(req.file.buffer);
    return res.status(200).send({ url: result.secure_url });
  } catch (error) {
    console.error("❌ Error unggah berkas:", error);
    return res.status(500).send({ error: "Gagal mengunggah berkas." });
  }
});

// ----------------- Google Auth untuk FCM -----------------
const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"];
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") : undefined,
  },
  scopes: SCOPES,
});

app.post("/send-notif", async (req, res) => {
  const { token, title, body } = req.body;
  if (!token || !title || !body) return res.status(400).send({ error: "token, title, and body are required." });

  try {
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const message = { message: { token, notification: { title, body } } };

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(message),
      }
    );

    const data = await response.json();
    if (response.ok) return res.status(200).send({ success: true, message: "Notification sent.", data });

    console.error("❌ Error FCM:", data);
    return res.status(500).send({ error: "Failed to send notification.", data });
  } catch (error) {
    console.error("❌ Gagal kirim notifikasi:", error);
    return res.status(500).send({ error: "Failed to send notification." });
  }
});

// ----------------- Hapus berkas -----------------
app.post("/delete-berkas", async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) return res.status(400).send({ error: "fileUrl diperlukan." });

    const parts = fileUrl.split("/");
    const fileName = parts.pop();
    const folderName = parts.pop();
    const publicId = `${folderName}/${fileName.split(".")[0]}`;

    const result = await cloudinary.uploader.destroy(publicId);
    if (result.result === "ok") return res.status(200).send({ success: true, message: "✅ File berhasil dihapus", publicId });

    return res.status(500).send({ success: false, message: "❌ Gagal hapus file", result });
  } catch (error) {
    console.error("❌ Error hapus berkas:", error);
    return res.status(500).send({ error: "Gagal menghapus berkas." });
  }
});

// ----------------- Helper: Extract Cloudinary public_id (FINAL FIX) -----------------
function extractCloudinaryPublicId(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const uploadIndex = parts.indexOf("upload");
    
    if (uploadIndex === -1) return null;

    // Ambil semua bagian path setelah 'upload'
    let publicParts = parts.slice(uploadIndex + 1);
    
    // Hapus versi (v1759376713)
    publicParts = publicParts.filter((p) => !/^v\d+/.test(p));
    
    if (publicParts.length === 0) return null;
    
    // Ambil elemen terakhir (yang berisi nama file + ekstensi), dan hapus ekstensi
    const lastPartIndex = publicParts.length - 1;
    const filenameWithExt = publicParts[lastPartIndex];
    
    // Hapus ekstensi (.jpg, .png, dll.)
    publicParts[lastPartIndex] = filenameWithExt.replace(/\.[^/.]+$/, "");
    
    // Gabungkan folder/subfolder/file tanpa ekstensi
    return publicParts.join("/");
  } catch (e) {
    console.error("Error extracting public ID:", e);
    return null;
  }
}

// Fungsi escapeXml tetap diperlukan untuk fallback
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

// ----------------- Export laporan bulanan (stabil) -----------------
app.get("/export-laporan-bulanan", async (req, res) => {
  try {
    const { bulan, tahun } = req.query;
    if (!bulan || !tahun) return res.status(400).send("Parameter bulan & tahun wajib diisi");

    const bulanInt = parseInt(bulan) - 1;
    const startDate = new Date(tahun, bulanInt, 1);
    const endDate = new Date(tahun, bulanInt + 1, 1);

    const snapshot = await db
      .collection("laporan_driver")
      .where("tanggal_pengerjaan", ">=", admin.firestore.Timestamp.fromDate(startDate))
      .where("tanggal_pengerjaan", "<", admin.firestore.Timestamp.fromDate(endDate))
      .get();

    if (snapshot.empty) return res.status(404).send("Tidak ada laporan di bulan ini");

    // Setup zip
    res.setHeader("Content-Disposition", `attachment; filename="Laporan_${bulan}_${tahun}.zip"`);
    res.setHeader("Content-Type", "application/zip");
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);

    // Ambil logo desa sekali saja
    let logoBuffer = null;
    try {
      const logoUrl = "https://res.cloudinary.com/drogicsrd/image/upload/v1759381091/desa_zn8ls3.png";
      const logoResp = await axios.get(logoUrl, { responseType: "arraybuffer" });
      logoBuffer = Buffer.from(logoResp.data);
    } catch (e) {
      console.warn("⚠️ Gagal ambil logo desa:", e.message);
    }
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const namaFolder = (data.nama_pemohon || "Laporan").replace(/[^a-z0-9]/gi, "_").substring(0, 50);
      const fotoList = data.dokumentasi_foto || [];

      const tanggalStr = data.tanggal_pengerjaan ? data.tanggal_pengerjaan.toDate().toLocaleDateString("id-ID") : "-";
      
      // 🟢 Perbaikan Watermark: Buat Array Baris Teks
      const textLines = [
        `Pemohon: ${data.nama_pemohon || "-"}`,
        `Driver: ${data.nama_driver || "-"}`,
        `Instansi: ${data.instansi_rujukan || "-"}`,
        `Alamat: ${data.alamat_pemohon || "-"}`,
        `Tanggal: ${tanggalStr}`,
      ];

      for (const [i, fotoUrl] of fotoList.entries()) {
        try {
          const publicId = extractCloudinaryPublicId(fotoUrl);
          let finalBuf = null;

          if (publicId) {
            
            // 🟢 Langkah 1: Buat string transformasi Teks Multi-Baris
            const textTransformString = createTextWatermarkTransformations(textLines);
            
            // 💡 PERBAIKAN: Gunakan SDK Helper dengan raw_transformation
            const transformUrl = cloudinary.url(publicId, {
                // Transformasi dasar
                transformation: [
                    { width: 1280, crop: "scale", quality: 90, flags: 'force_strip' },
                ],
                // Raw transformation: Menyuntikkan string transformasi rantai teks eksplisit
                raw_transformation: textTransformString,
                format: 'jpg' // Pastikan formatnya selalu .jpg
            });

            // Ambil gambar yang sudah di-watermark
            const resp = await axios.get(transformUrl, { 
                responseType: "arraybuffer",
                timeout: 60000 
            });
            
            let finalBuf = Buffer.from(resp.data);
            
            // 🟢 Langkah 2: Gabungkan Logo (Jika ada) menggunakan Sharp
            if (logoBuffer) {
              finalBuf = await sharp(finalBuf)
                .composite([
                    // Logo di kanan bawah
                    { 
                        input: logoBuffer, 
                        gravity: "southeast", 
                        blend: "over", 
                        top: 20, 
                        left: 20 
                    }
                ])
                .jpeg({ quality: 90 })
                .toBuffer();
            }

          } else {
            // Fallback (Sharp + SVG, jika Cloudinary publicId tidak ditemukan)
             const response = await axios.get(fotoUrl, { responseType: "arraybuffer", timeout: 60000 });
             const imageBuffer = Buffer.from(response.data);

             const svgOverlay = `
               <svg width="1280" height="260" xmlns="http://www.w3.org/2000/svg">
                 <style>
                   .title { fill: white; font-size: 28px; font-family: sans-serif; font-weight: bold; }
                 </style>
                 <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.5)" />
                 <text x="20" y="40" class="title">${escapeXml(data.nama_pemohon || "-")}</text>
                 <text x="20" y="80" class="title">${escapeXml(data.nama_driver || "-")}</text>
                 <text x="20" y="120" class="title">${escapeXml(data.instansi_rujukan || "-")}</text>
                 <text x="20" y="160" class="title">${escapeXml(data.alamat_pemohon || "-")}</text>
                 <text x="20" y="200" class="title">${escapeXml(tanggalStr)}</text>
               </svg>
             `;

             const compositeArray = [{ input: Buffer.from(svgOverlay), gravity: "southwest" }];
             if (logoBuffer) compositeArray.push({ input: logoBuffer, gravity: "southeast", blend: "over", top: 20, left: 20 });

             finalBuf = await sharp(imageBuffer)
               .resize({ width: 1280 })
               .composite(compositeArray)
               .jpeg({ quality: 90 })
               .toBuffer();
          }

          archive.append(finalBuf, { name: `${namaFolder}/foto_${i + 1}.jpg` });
          console.log(`✅ Ditambahkan: ${namaFolder}/foto_${i + 1}.jpg`);

         } catch (err) {
          // Log pesan error secara detail
          const errorMessage = err.message || JSON.stringify(err);
          console.error(`❌ GAGAL PROSES FOTO (${fotoUrl}):`, errorMessage);
          
          // Isi file error dengan pesan yang didapat
          archive.append(
            Buffer.from(`Gagal memproses foto. Error: ${errorMessage}`), 
            { name: `${namaFolder}/foto_${i + 1}_error.txt` }
          );
        }
      }
    }

    await archive.finalize();
    console.log("📦 Zip finalize selesai");
  } catch (error) {
    console.error("Error ekspor laporan bulanan:", error);
    if (!res.headersSent) res.status(500).send("Terjadi kesalahan server");
  }
});

// ----------------- Vercel export -----------------
export default app;