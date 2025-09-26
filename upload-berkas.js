import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import dotenv from "dotenv";

dotenv.config();

// Konfigurasi Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

export const config = {
  api: {
    bodyParser: false, // karena multer handle parsing
  },
};

// Helper untuk upload buffer ke Cloudinary
const streamUpload = (fileBuffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "pelayanan_desa" },
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      }
    );
    stream.end(fileBuffer);
  });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Multer upload
  upload.single("file")(req, {}, async (err) => {
    if (err) return res.status(500).json({ error: err.message });

    if (!req.file) {
      return res.status(400).json({ error: "Tidak ada berkas yang diunggah." });
    }

    try {
      const result = await streamUpload(req.file.buffer);
      return res.status(200).json({ url: result.secure_url });
    } catch (error) {
      console.error("❌ Error unggah berkas:", error);
      return res.status(500).json({ error: "Gagal mengunggah berkas." });
    }
  });
}
