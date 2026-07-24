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
        // Ambil argumen dari terminal (contoh: node correct.js --slave_ah=56.0)
        const args = process.argv.slice(2);
        let targetSlaveAh = null;

        args.forEach(arg => {
            if (arg.startsWith('--slave_ah=')) {
                targetSlaveAh = parseFloat(arg.split('=')[1]);
            }
        });

        if (targetSlaveAh === null) {
            console.log("❌ Error: Argumen --slave_ah wajib diisi!");
            console.log("Contoh penggunaan: node correct.js --slave_ah=56.0");
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

        // 2. Ambil data PALING AWAL (limit 1 ascending) untuk acuan kumulatif
        const firstSnapshot = await collectionRef.orderBy('timestamp', 'asc').limit(1).get();
        const firstData = firstSnapshot.docs[0].data();

        console.log(`📄 Titik Awal Ref  : ${firstData.timestamp} | Charge: ${firstData.system?.chargeTotal} kWh | Master Ah: ${firstData.master?.ah}Ah | Slave Ah: ${firstData.slave?.ah}Ah`);
        console.log(`📄 Titik Akhir     : ${lastData.timestamp} | Charge: ${lastData.system?.chargeTotal} kWh | Master Ah: ${lastData.master?.ah}Ah`);

        // 3. Hitung Delta Energi Kumulatif dari Awal ke Akhir
        const chargeStart = parseFloat(firstData.system?.chargeTotal || 0);
        const dischargeStart = parseFloat(firstData.system?.dischargeTotal || 0);
        
        const chargeEnd = parseFloat(lastData.system?.chargeTotal || 0);
        const dischargeEnd = parseFloat(lastData.system?.dischargeTotal || 0);

        const deltaChargeKwh = chargeEnd - chargeStart;
        const deltaDischargeKwh = dischargeEnd - dischargeStart;
        const netEnergyKwh = deltaChargeKwh - deltaDischargeKwh;

        // 4. Ambil tegangan rata-rata sistem (atau pakai vBat terakhir)
        const totalVoltage = parseFloat(lastData.system?.totalVoltage || 53.0);

        // 5. Hitung Total Ah System murni secara fisika
        const totalAhSystem = totalVoltage > 0 ? (netEnergyKwh * 1000) / totalVoltage : 0;

        // 6. Hitung Delta Ah Master dari Awal ke Akhir
        const masterAhStart = parseFloat(firstData.master?.ah || 0);
        const masterAhEnd = parseFloat(lastData.master?.ah || 0);
        const masterAhDelta = masterAhEnd - masterAhStart;

        // 7. Hitung Target Delta Ah Slave berdasarkan input user (--slave_ah) dikurangi Slave Ah awal
        const slaveAhStart = parseFloat(firstData.slave?.ah || 0);
        const clampedTargetSlaveAh = Math.min(SLAVE_CAPACITY_AH, Math.max(0, targetSlaveAh));
        const targetSlaveAhDelta = clampedTargetSlaveAh - slaveAhStart;

        // 8. Hitung Raw Delta Slave (teoretis murni tanpa koreksi)
        const rawSlaveAhDelta = totalAhSystem - masterAhDelta;

        // 9. Kalkulasi Faktor Koreksi Baru Otomatis!
        let newCorrectionFactor = lastData.correctionFactor || 0.58;
        if (rawSlaveAhDelta !== 0) {
            newCorrectionFactor = parseFloat((targetSlaveAhDelta / rawSlaveAhDelta).toFixed(4));
        }

        const newSoc = parseFloat(((clampedTargetSlaveAh / SLAVE_CAPACITY_AH) * 100).toFixed(2));

        console.log(`\n--- HASIL KALKULASI OTOMATIS ---`);
        console.log(`   Net Energy (kWh)   : ${netEnergyKwh.toFixed(4)} kWh`);
        console.log(`   Total Ah System    : ${totalAhSystem.toFixed(2)} Ah`);
        console.log(`   Master Ah Delta    : ${masterAhDelta.toFixed(2)} Ah`);
        console.log(`   Raw Slave Ah Delta : ${rawSlaveAhDelta.toFixed(2)} Ah`);
        console.log(`   Target Slave Delta : ${targetSlaveAhDelta.toFixed(2)} Ah`);
        console.log(`   👉 NEW FACTOR      : ${newCorrectionFactor}`);

        // 10. Update dokumen terakhir di Firestore dengan nilai slave baru & faktor koreksi baru
        let updates = {
            "slave.ah": clampedTargetSlaveAh,
            "slave.soc": newSoc,
            "correctionFactor": newCorrectionFactor
        };

        await collectionRef.doc(lastId).update(updates);

        console.log(`\n✅ Berhasil update database [ID: ${lastId}]!`);
        console.log(`   - Slave Ah dikoreksi menjadi: ${clampedTargetSlaveAh}Ah (${newSoc}%)`);
        console.log(`   - Faktor koreksi baru tersimpan: ${newCorrectionFactor}`);

    } catch (error) {
        console.error("❌ Gagal menjalankan koreksi otomatis:", error.message);
    }
}

runCorrection();