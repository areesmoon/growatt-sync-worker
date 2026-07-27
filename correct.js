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

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'bms_logs';
const SLAVE_CAPACITY_AH = parseFloat(process.env.SLAVE_CAPACITY_AH || 100);

async function runCorrection() {
    try {
        // Ambil argumen dari terminal (contoh: node correct.js --slave_ah=100.0)
        const args = process.argv.slice(2);
        let targetSlaveAh = null;

        args.forEach(arg => {
            if (arg.startsWith('--slave_ah=')) {
                targetSlaveAh = parseFloat(arg.split('=')[1]);
            }
        });

        if (targetSlaveAh === null) {
            console.log("❌ Error: Argumen --slave_ah wajib diisi!");
            console.log("Contoh penggunaan: node correct.js --slave_ah=100.0");
            return;
        }

        const collectionRef = db.collection(FIRESTORE_COLLECTION);

        // 1. Ambil data TERAKHIR (limit 1 descending)
        const lastSnapshot = await collectionRef.orderBy('timestamp', 'desc').limit(1).get();
        if (lastSnapshot.empty) {
            console.log("❌ Tidak ada data ditemukan di collection:", FIRESTORE_COLLECTION);
            return;
        }

        const lastDoc = lastSnapshot.docs[0];
        const lastData = lastDoc.data();
        const lastId = lastDoc.id;

        console.log(`📄 Dokumen Terakhir [ID: ${lastId}] : ${lastData.timestamp}`);
        console.log(`   └─ Master SOC: ${lastData.master?.soc}% | Current Slave Ah: ${lastData.slave?.ah}Ah`);

        // 2. Ambil parameter calibration saat ini
        const calib = lastData.calibration || {};
        const oldChargeFactor = parseFloat(calib.chargeCorrectionFactor || 1.0);
        const oldDischargeFactor = parseFloat(calib.dischargeCorrectionFactor || 1.0);
        const totalCount = parseInt(calib.totalCount || 1, 10);

        console.log(`📊 Statistik Kalibrasi Aktif: Total Data Count = ${totalCount}`);
        console.log(`   - Old Charge Factor    : ${oldChargeFactor}`);
        console.log(`   - Old Discharge Factor : ${oldDischargeFactor}`);

        // 3. Batasi target slave Ah sesuai kapasitas nominal
        const clampedTargetSlaveAh = Math.min(SLAVE_CAPACITY_AH, Math.max(0, targetSlaveAh));
        const currentSlaveAh = parseFloat(lastData.slave?.ah || 0);
        const ahDiff = clampedTargetSlaveAh - currentSlaveAh;

        console.log(`⚖️ Target Slave Ah: ${clampedTargetSlaveAh}Ah | Aktual di DB: ${currentSlaveAh}Ah | Selisih (Error): ${ahDiff.toFixed(2)}Ah`);

        // 4. Hitung indikasi koreksi rasio baru
        // Jika selisih positif (aktual kurang dari target), faktor koreksi perlu dinaikkan sedikit, begitu pula sebaliknya.
        // Kita gunakan pendekatan penyesuaian berbasis proporsi error terhadap kapasitas total.
        let adjustmentRatio = 1.0;
        if (currentSlaveAh > 0) {
            adjustmentRatio = clampedTargetSlaveAh / currentSlaveAh;
        }

        // Tentukan calculated factor berdasarkan rasio penyesuaian
        let calculatedChargeFactor = oldChargeFactor * adjustmentRatio;
        let calculatedDischargeFactor = oldDischargeFactor * adjustmentRatio;

        // 5. PENERAPAN PERGESERAN LANDAI (SMOOTH SHIFT / DAMPING)
        // Alih-alih langsung menimpa total (makjleb), kita gunakan learning rate yang adaptif
        // Makin banyak totalCount (makin matang data terkumpul), makin stabil bobot perubahannya.
        // Atau kita pakai konstanta damping yang aman, misal 15% pengaruh baru, 85% pertahankan stabilitas lama.
        const learningRate = 0.15; 

        const newChargeFactor = (oldChargeFactor * (1 - learningRate)) + (calculatedChargeFactor * learningRate);
        const newDischargeFactor = (oldDischargeFactor * (1 - learningRate)) + (calculatedDischargeFactor * learningRate);

        const newSoc = parseFloat(((clampedTargetSlaveAh / SLAVE_CAPACITY_AH) * 100).toFixed(2));

        console.log(`\n--- HASIL KALIBRASI ADAPTIF ---`);
        console.log(`   👉 NEW Charge Factor    : ${newChargeFactor.toFixed(4)} (Geser dari ${oldChargeFactor})`);
        console.log(`   👉 NEW Discharge Factor : ${newDischargeFactor.toFixed(4)} (Geser dari ${oldDischargeFactor})`);
        console.log(`   👉 New Slave Ah & SOC   : ${clampedTargetSlaveAh}Ah (${newSoc}%)`);

        // 6. Update dokumen terakhir di Firestore: 
        // Perbarui nilai slave, terapkan faktor koreksi baru, DAN RESET totalCount kembali ke 1 untuk siklus baru.
        let updates = {
            "slave.ah": clampedTargetSlaveAh,
            "slave.soc": newSoc,
            "calibration.chargeCorrectionFactor": parseFloat(newChargeFactor.toFixed(4)),
            "calibration.dischargeCorrectionFactor": parseFloat(newDischargeFactor.toFixed(4)),
            "calibration.totalCount": 1 // Reset counter untuk memulai siklus pembelajaran baru
        };

        await collectionRef.doc(lastId).update(updates);

        console.log(`\n✅ Berhasil update database [ID: ${lastId}]!`);
        console.log(`   - Faktor koreksi adaptif tersimpan.`);
        console.log(`   - Akumulator counter di-reset ke 1 untuk siklus berikutnya.`);

    } catch (error) {
        console.error("❌ Gagal menjalankan koreksi adaptif:", error.message);
    }
}

runCorrection();