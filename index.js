// index.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { db } from "./firebase.js";

import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import dotenv from "dotenv";
import { google } from "googleapis";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();

const app = express();

// Vercel otomatis handle port
const port = process.env.PORT || 3000;

// 🔹 Konfigurasi Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🔹 Konfigurasi Multer
const upload = multer({ dest: "uploads/" });

app.use(bodyParser.json());
app.use(cors());

// ✅ Upload file ke Cloudinary
app.post("/upload-berkas", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send({ error: "Tidak ada berkas yang diunggah." });
    }

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: "pelayanan_desa",
    });

    fs.unlinkSync(req.file.path);

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

// ✅ Endpoint kirim notifikasi
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

// ✅ Vercel: jangan pakai app.listen
export default app;
