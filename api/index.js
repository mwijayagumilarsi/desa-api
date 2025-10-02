import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import sharp from "sharp";
import archiver from "archiver";
import { db } from "./firebase.js"; // Firestore instance
import admin from "firebase-admin";
const Timestamp = admin.firestore.Timestamp;
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import dotenv from "dotenv";
import { google } from "googleapis";
import fetch from "node-fetch";
import axios from "axios";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();

// Cloudinary config (pastikan env vars sudah ter-set)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware
app.use(bodyParser.json());
app.use(cors());

// --- Load Roboto (fallback) ---
const fontPath = path.resolve("./fonts/Roboto-Regular.ttf");
let robotoBase64 = "";
if (fs.existsSync(fontPath)) {
  try {
    robotoBase64 = fs.readFileSync(fontPath).toString("base64");
    console.log("📂 Font Roboto ditemukan & di-load (fallback).");
  } catch (e) {
    console.warn("⚠️ Gagal baca font Roboto:", e.message);
    robotoBase64 = "";
  }
} else {
  console.warn("⚠️ Font Roboto TIDAK ditemukan (fallback akan non-aktif). Path:", fontPath);
}

// ----------------- Endpoints tetap (upload, send-notif, delete) -----------------
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

// Google Auth FCM v1
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

// ----------------- HELPER: extract Cloudinary public_id -----------------
function extractCloudinaryPublicId(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean); // remove empty
    // find 'upload' index
    const idx = parts.findIndex((p) => p === "upload");
    if (idx === -1) return null;
    let publicParts = parts.slice(idx + 1); // e.g. ["v12345","pelayanan_desa","idpic.jpg"]
    // remove version token (v\d+)
    publicParts = publicParts.filter((p) => !/^v\d+/.test(p));
    if (publicParts.length === 0) return null;
    // remove extension from last part
    publicParts[publicParts.length - 1] = publicParts[publicParts.length - 1].replace(/\.[^/.]+$/, "");
    return publicParts.join("/");
  } catch (e) {
    return null;
  }
}

// ----------------- EXPORT LAPORAN BULANAN (utama) -----------------
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

    res.setHeader("Content-Disposition", `attachment; filename="Laporan_${bulan}_${tahun}.zip"`);
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const namaFolder = (data.nama_pemohon || "Laporan").replace(/[^a-z0-9]/gi, "_").substring(0, 50);
      const fotoList = data.dokumentasi_foto || [];

      // build watermark lines once per report
      const tanggalStr = data.tanggal_pengerjaan ? data.tanggal_pengerjaan.toDate().toLocaleDateString("id-ID") : "-";
      const lines = [
        `Pemohon: ${data.nama_pemohon || "-"}`,
        `Driver: ${data.nama_driver || "-"}`,
        `Instansi: ${data.instansi_rujukan || "-"}`,
        `Alamat: ${data.alamat_pemohon || "-"}`,
        `Tanggal: ${tanggalStr}`,
      ];
      const combinedText = lines.join("\n");

      for (const [i, fotoUrl] of fotoList.entries()) {
        try {
          // 1) Jika foto di Cloudinary -> gunakan Cloudinary transformation text overlay (paling andal)
          const publicId = extractCloudinaryPublicId(fotoUrl);
          if (publicId) {
            // Cloudinary transformation string:
            // - scale to width 1280
            // - overlay text (Arial, 28) at south_west with small offset, white text
            const encodedText = encodeURIComponent(combinedText);
            // Build one transformation segment that includes resize + overlay + gravity/offset/color
            const transformationSegment = `w_1280,c_scale,l_text:Arial_28:${encodedText},g_south_west,x_20,y_20,co_rgb:FFFFFF`;
            const transformUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${transformationSegment}/${publicId}.jpg`;

            // Debug
            console.log("📷 Using Cloudinary transform URL for publicId:", publicId);

            // Fetch transformed (watermarked) image bytes
            const resp = await axios.get(transformUrl, { responseType: "arraybuffer" });
            const buf = Buffer.from(resp.data);

            // Optional: normalize/convert with sharp (ensure jpeg, quality)
            const finalBuf = await sharp(buf).jpeg({ quality: 90 }).toBuffer();

            archive.append(finalBuf, { name: `${namaFolder}/foto_${i + 1}.jpg` });
            console.log(`✅ Ditambahkan (Cloudinary transformed): ${namaFolder}/foto_${i + 1}.jpg`);
            continue; // next foto
          }

          // 2) Jika bukan Cloudinary atau transform gagal -> fallback:
          //    fetch original and try Sharp+embedded-font (sudah ada robotoBase64 if available)
          console.log("⬇️ Download foto asli (fallback):", fotoUrl);
          const response = await axios.get(fotoUrl, { responseType: "arraybuffer", timeout: 30000 });
          const imageBuffer = Buffer.from(response.data);

          // If robotoBase64 exists -> embed font in SVG; else use simple sans-serif SVG
          let svgOverlay;
          if (robotoBase64) {
            svgOverlay = `
              <svg width="1280" height="260" xmlns="http://www.w3.org/2000/svg">
                <style>
                  @font-face {
                    font-family: 'Roboto';
                    src: url(data:font/truetype;charset=utf-8;base64,${robotoBase64}) format('truetype');
                  }
                  .title { fill: white; font-size: 28px; font-family: 'Roboto', sans-serif; font-weight: bold; }
                </style>
                <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.5)" />
                <text x="20" y="40" class="title">Pemohon: ${escapeXml(data.nama_pemohon || "-")}</text>
                <text x="20" y="80" class="title">Driver: ${escapeXml(data.nama_driver || "-")}</text>
                <text x="20" y="120" class="title">Instansi: ${escapeXml(data.instansi_rujukan || "-")}</text>
                <text x="20" y="160" class="title">Alamat: ${escapeXml(data.alamat_pemohon || "-")}</text>
                <text x="20" y="200" class="title">Tanggal: ${escapeXml(tanggalStr)}</text>
              </svg>
            `;
          } else {
            // fallback sans-serif
            svgOverlay = `
              <svg width="1280" height="260" xmlns="http://www.w3.org/2000/svg">
                <style>
                  .title { fill: white; font-size: 28px; font-family: sans-serif; font-weight: bold; }
                </style>
                <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.5)" />
                <text x="20" y="40" class="title">Pemohon: ${escapeXml(data.nama_pemohon || "-")}</text>
                <text x="20" y="80" class="title">Driver: ${escapeXml(data.nama_driver || "-")}</text>
                <text x="20" y="120" class="title">Instansi: ${escapeXml(data.instansi_rujukan || "-")}</text>
                <text x="20" y="160" class="title">Alamat: ${escapeXml(data.alamat_pemohon || "-")}</text>
                <text x="20" y="200" class="title">Tanggal: ${escapeXml(tanggalStr)}</text>
              </svg>
            `;
          }

          const processedImage = await sharp(imageBuffer)
            .resize({ width: 1280 })
            .composite([{ input: Buffer.from(svgOverlay), gravity: "southwest" }])
            .jpeg({ quality: 90 })
            .toBuffer();

          archive.append(processedImage, { name: `${namaFolder}/foto_${i + 1}.jpg` });
          console.log(`✅ Ditambahkan (fallback Sharp): ${namaFolder}/foto_${i + 1}.jpg`);
        } catch (err) {
          console.error(`❌ Gagal proses foto: ${fotoUrl}`, err && err.message ? err.message : err);
        }
      } // end fotoList loop
    } // end docs loop

    await archive.finalize();
    // response ends when archive finishes streaming
  } catch (error) {
    console.error("Error ekspor laporan bulanan:", error);
    if (!res.headersSent) res.status(500).send("Terjadi kesalahan server");
  }
});

// small helper to escape XML special chars in SVG
function escapeXml(unsafe) {
  if (!unsafe) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Vercel: export default
export default app;
