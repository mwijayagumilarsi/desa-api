// api/listener.js
const { admin, db } = require("./firebase");

// Pantau perubahan pada koleksi pelayanan_surat
db.collection("pelayanan_surat").onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === "modified") {
      const data = change.doc.data();
      const uid = data.uid;
      const jenis = data.jenisPelayanan; // <-- field jenisPelayanan
      const newStatus = data.status; // <-- field status

      console.log(`📌 Dokumen ${change.doc.id} diupdate, status: ${newStatus}`);

      if (!uid) {
        console.log("⚠️ UID kosong, notifikasi dilewati.");
        return;
      }

      try {
        // Cari token user berdasarkan UID
        const userDoc = await db.collection("users").doc(uid).get();
        if (!userDoc.exists) {
          console.log(`❌ User ${uid} tidak ditemukan di Firestore.`);
          return;
        }

        const userData = userDoc.data();
        const token = userData?.fcmToken;

        if (!token) {
          console.log(`⚠️ User ${uid} tidak punya fcmToken.`);
          return;
        }

        // Kirim notifikasi ke user
        const message = {
          notification: {
            title: "Status Pengajuan Surat",
            body: `Surat "${jenis}" Anda, Sekarang Berstatus ${newStatus}`, // ✅ sudah pakai field yang benar
          },
          token,
        };

        await admin.messaging().send(message);
        console.log(`✅ Notifikasi terkirim ke user ${uid}`);
      } catch (err) {
        console.error("❌ Gagal kirim notifikasi:", err.message);
      }
    }
  });
});

console.log("👂 Listener Firestore berjalan, menunggu perubahan...");
