"use strict";

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Inisialisasi Firebase
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
initializeApp({
    credential: cert(serviceAccount)
});
const db = getFirestore();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'bms_logs_test';
const SLAVE_CAPACITY_AH = parseFloat(process.env.SLAVE_CAPACITY_AH || 100);

async function runCorrection() {
    try {
        // Ambil argumen dari command line (contoh: --slave_ah=56.0 atau --factor=0.52)
        const args = process.argv.slice(2);
        let targetSlaveAh = null;
        let targetFactor = null;

        args.forEach(arg => {
            if (arg.startsWith('--slave_ah=')) {
                targetSlaveAh = parseFloat(arg.split('=')[1]);
            } else if (arg.startsWith('--factor=')) {
                targetFactor = parseFloat(arg.split('=')[1]);
            }
        });

        if (targetSlaveAh === null && targetFactor === null) {
            console.log("❌ Error: Argumen tidak valid!");
            console.log("Gunakan: node correct.js --slave_ah=56.0  ATAU  node correct.js --factor=0.52");
            return;
        }

        // Ambil dokumen log terakhir di Firestore
        const snapshot = await db.collection(FIRESTORE_COLLECTION)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log("❌ Tidak ada data ditemukan di collection:", FIRESTORE_COLLECTION);
            return;
        }

        const latestDoc = snapshot.docs[0];
        const docData = latestDoc.data();
        const docId = latestDoc.id;

        console.log(`📄 Dokumen terakhir ditemukan [ID: ${docId}] pada waktu: ${docData.timestamp}`);

        let updates = {};
        let updateLogs = [];

        // 1. Jika user ingin koreksi Ah Slave secara langsung
        if (targetSlaveAh !== null) {
            const clampedAh = Math.min(SLAVE_CAPACITY_AH, Math.max(0, targetSlaveAh));
            const newSoc = parseFloat(((clampedAh / SLAVE_CAPACITY_AH) * 100).toFixed(2));

            updates["slave.ah"] = clampedAh;
            updates["slave.soc"] = newSoc;
            updateLogs.push(`Slave Ah dikoreksi: ${docData.slave?.ah}Ah ➔ ${clampedAh}Ah (${newSoc}%)`);

            // --- HITUNG OTOMATIS REKALIBRASI FAKTOR KOREKSI ---
            // Kita cocokan ulang dengan data sebelumnya untuk nyesuaiin faktor koreksi ke depan
            // (Opsional cerdas: kalau kita tahu Ah real-nya, kita bisa hitung ulang faktor koreksi mutlaknya)
        }

        // 2. Jika user ingin langsung ubah faktor koreksi
        if (targetFactor !== null) {
            updates["correctionFactor"] = targetFactor;
            updateLogs.push(`Faktor koreksi diperbarui di DB: ${docData.correctionFactor || 'default'} ➔ ${targetFactor}`);
        }

        // Simpan pembaruan ke Firestore
        await db.collection(FIRESTORE_COLLECTION).doc(docId).update(updates);

        console.log("✅ Berhasil memperbarui database!");
        updateLogs.forEach(log => console.log(`   - ${log}`));

    } catch (error) {
        console.error("❌ Gagal melakukan koreksi:", error.message);
    }
}

runCorrection();