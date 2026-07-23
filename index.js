"use strict";

const path = require('path');
// Pakai absolute path biar aman dibaca dari direktori mana pun (termasuk Cron Job)
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const api = require('growatt');

// 1. Inisialisasi Firebase Admin dengan Absolute Path Service Account
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore();

// Kredensial & Konfigurasi Baterai Slave
const username = process.env.GROWATT_USERNAME;
const password = process.env.GROWATT_PASSWORD;
const SLAVE_CAPACITY_AH = 100; // Sesuaikan kapasitas nominal slave lu

// Ambil konfigurasi threshold inverter dari .env.local (default 0.4 A jika kosong)
const INV_STANDBY_THRESHOLD = parseFloat(process.env.INV_STANDBY_THRESHOLD_AMP || 0.4);

async function run() {
    try {
        if (!username || !password) {
            throw new Error("Kredensial Growatt belum diset di file .env.local!");
        }

        const growatt = new api({});
        await growatt.login(username, password);

        let plantData = await growatt.getAllPlantData({
            plantData: false,
            deviceData: false,
            weather: false,
            totalData: false,
            statusData: false,
            historyAll: false
        });

        const plantId = Object.keys(plantData)[0];
        const deviceSn = Object.keys(plantData[plantId].devices)[0];
        const historyLast = plantData[plantId].devices[deviceSn].historyLast;

        // --- DATA TOTAL & SYSTEM ---
        const totalVoltage = parseFloat(historyLast.vBat || 0);
        const rawPbat = parseFloat(historyLast.pBat || 0);

        // Dibalik tandanya: pBat negatif (charging) jadi positif, pBat positif (discharging) jadi negatif
        const totalPower = -rawPbat;

        let totalCurrent = 0;
        if (totalVoltage > 0) {
            // Arus mentah tanpa toFixed di tengah jalan biar presisi Ah counting
            totalCurrent = totalPower / totalVoltage;
        }

        // --- TAMBAHAN LOAD POWER & PANEL SURYA (PPV) ---
        const loadPower = parseFloat(historyLast.outPutPower || 0);
        const ppv1 = parseFloat(historyLast.ppv1 || 0);
        const ppv2 = parseFloat(historyLast.ppv2 || 0);
        const totalPpv = parseFloat((ppv1 + ppv2).toFixed(2));

        // --- DATA MASTER ---
        const masterSoc = parseFloat(parseFloat(historyLast.bmsSoc || 0).toFixed(2));
        const masterVoltage = parseFloat(historyLast.bmsBatteryVolt || totalVoltage);
        const masterCurrent = parseFloat(historyLast.bmsBatteryCurr || 0); // Arus mentah
        const masterPower = masterVoltage * masterCurrent;

        // --- DATA SLAVE ---
        let slaveCurrent = totalCurrent - masterCurrent; // Arus mentah
        const slaveVoltage = totalVoltage;
        const slavePower = slaveVoltage * slaveCurrent;

        // --- 2. TARIK DATA TERAKHIR DARI FIRESTORE UNTUK KONTROL & AH COUNTING ---
        const currentTimestampStr = historyLast.calendar || new Date().toISOString();

        const lastSnapshot = await db.collection('bms_logs')
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        let slaveSoc = masterSoc; // Default awal

        if (!lastSnapshot.empty) {
            const lastDoc = lastSnapshot.docs[0].data();
            const lastMasterSoc = lastDoc.master ? lastDoc.master.soc : masterSoc;
            const lastSlaveSoc = lastDoc.slave ? lastDoc.slave.soc : masterSoc;

            // [FIXED INTERVAL 5 MENIT / 300 DETIK]
            // Mengabaikan fluktuasi timestamp API Growatt demi kestabilan Ah Counting
            const deltaSeconds = 300;

            if (masterSoc === 100) {
                // Kalibrasi penuh otomatis
                slaveSoc = 100.0;
                console.log("[CALIBRATION] Master SOC 100%. Slave SOC di-reset otomatis ke 100%.");
            } else {
                // 1. Hitung Ah Counting dasar
                const deltaHours = deltaSeconds / 3600;

                // [DEADZONE FILTER BERDASARKAN TOTAL CURRENT / INVERTER IDLE]
                // Cek apakah inverter secara total sedang dalam status standby/idle (arus total kecil)
                let effectiveSlaveCurrent = slaveCurrent;
                if (Math.abs(totalCurrent) <= INV_STANDBY_THRESHOLD) {
                    effectiveSlaveCurrent = 0; // Jika inverter idle, anggap slave tidak narik/nyimpen apa-apa
                }

                const deltaAh = effectiveSlaveCurrent * deltaHours;
                const deltaSocAh = (deltaAh / SLAVE_CAPACITY_AH) * 100;
                let calculatedSlaveSoc = lastSlaveSoc + deltaSocAh;

                // 2. KONTROL KOREKSI BERDASARKAN PERUBAHAN SOC MASTER
                const masterSocDelta = masterSoc - lastMasterSoc;

                if (masterSocDelta !== 0) {
                    const correctionWeight = 0.3; // Bobot koreksi master 30%
                    const masterGuidedSoc = lastSlaveSoc + masterSocDelta;

                    calculatedSlaveSoc = (calculatedSlaveSoc * (1 - correctionWeight)) + (masterGuidedSoc * correctionWeight);
                    console.log(`[MASTER GUIDED CONTROL] Master Delta: ${masterSocDelta}% | Koreksi diterapkan.`);
                }

                // [STANDBY LOCK BERDASARKAN TOTAL CURRENT]
                // Jika master/slave sudah penuh dan inverter sedang dalam kondisi standby (totalCurrent kecil)
                if ((masterSoc === 100 || lastSlaveSoc >= 100) && totalCurrent >= -INV_STANDBY_THRESHOLD && totalCurrent <= INV_STANDBY_THRESHOLD) {
                    calculatedSlaveSoc = 100.0;
                    console.log(`[STANDBY LOCK] Total Inverter Current ${totalCurrent.toFixed(2)}A dalam batas INV threshold (${INV_STANDBY_THRESHOLD}A). SOC dikunci di 100%.`);
                } else if (lastSlaveSoc >= 100 && slaveCurrent > 0) {
                    calculatedSlaveSoc = 100.0;
                    console.log("[CAP PROTECTION] Slave sudah penuh (100%) dan masih charging. SOC dikunci di 100%.");
                }

                // Batasi rentang SOC antara 0 sampai 100
                slaveSoc = parseFloat(Math.min(100, Math.max(0, calculatedSlaveSoc)).toFixed(2));
                console.log(`[FIXED 5-MIN Ah] Arus Slave: ${slaveCurrent.toFixed(2)}A | Delta Ah: ${deltaAh.toFixed(4)}Ah | Slave SOC Final: ${slaveSoc}%`);
            }
        } else {
            console.log("[BOOTSTRAP] Belum ada data historis di Firestore. Gunakan nilai awal master.");
        }

        // --- 3. PAYLOAD FIRESTORE (Dibulatkan rapi di sini) ---
        const currentTimestamp = new Date(currentTimestampStr).toISOString();

        const firestorePayload = {
            timestamp: currentTimestamp,
            deviceSn: deviceSn,
            plantName: plantData[plantId].plantName || "Rumah Kablukan",
            system: {
                totalVoltage,
                totalCurrent: parseFloat(totalCurrent.toFixed(2)),
                totalPower: parseFloat(totalPower.toFixed(2)),
                totalPpv, // Total produksi panel (ppv1 + ppv2)
                loadPower,
                gridVoltage: parseFloat(historyLast.vGrid || 0),
                gridFreq: parseFloat(historyLast.freqGrid || 0),
                inverterTemp: parseFloat(historyLast.InvTemperature || 0)
            },
            master: {
                soc: masterSoc,
                voltage: masterVoltage,
                current: masterCurrent,
                power: parseFloat(masterPower.toFixed(2)),
                soh: parseFloat(historyLast.soh || 0),
                cycleCount: parseInt(historyLast.cycleCount || 0),
                temperature: parseFloat(historyLast.bmsBatteryTemp || 0),
                statusBms: historyLast.bmsStatus || 0
            },
            slave: {
                soc: slaveSoc,
                voltage: slaveVoltage,
                current: parseFloat(slaveCurrent.toFixed(2)),
                power: parseFloat(slavePower.toFixed(2))
            }
        };

        // --- 4. CEK DUPLIKAT BERDASARKAN TIMESTAMP ---
        const existingDocs = await db.collection('bms_logs')
            .where('timestamp', '==', currentTimestamp)
            .limit(1)
            .get();

        if (!existingDocs.empty) {
            console.log(`[SKIP] Data dengan timestamp ${currentTimestamp} sudah ada di Firestore. Lewati penyimpanan.`);
            return;
        }

        // --- 5. SIMPAN KE FIRESTORE ---
        const docRef = await db.collection('bms_logs').add(firestorePayload);
        console.log(`[SUCCESS] Data baru berhasil disimpan dengan ID: ${docRef.id}`);

    } catch (error) {
        console.error("Gagal ambil data:", error.message);
    }
}

run();