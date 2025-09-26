// /api/upload-berkas.js
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import { buffer } from "micro";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Gunakan memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

export const config = {
  api: {
    bodyParser: false, // Karena kita pakai multer
  },
};

const handler = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Ambil buffer
    const fileBuffer = await buffer(req);

    const streamUpload = (bufferFile) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "pelayanan_desa" },
          (error, result) => {
            if (result) resolve(result);
            else reject(error);
          }
        );
        stream.end(bufferFile);
      });

    const result = await streamUpload(fileBuffer);

    return res.status(200).json({ url: result.secure_url });
  } catch (error) {
    console.error("❌ Error unggah berkas:", error);
    return res.status(500).json({ error: "Gagal mengunggah berkas." });
  }
};

export default handler;
