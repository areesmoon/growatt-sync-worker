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
        let rawPbat = parseFloat(historyLast.pBat || 0);
        let rawDischgCurr = parseFloat(historyLast.dischgCurr || 0);
        let rawChgCurr = parseFloat(historyLast.chgCurr || 0);
        
        let totalCurrent = 0;
        
        // Deteksi akurat berdasarkan prioritas flag inverter
        if (rawDischgCurr > 0 || rawPbat > 0) {
            // Kondisi DISCHARGING (Arus keluar -> Negatif)
            const currVal = rawDischgCurr > 0 ? rawDischgCurr : (rawPbat / (totalVoltage || 1));
            totalCurrent = -Math.abs(currVal);
        } else if (rawChgCurr > 0 || rawPbat < 0) {
            // Kondisi CHARGING (Arus masuk -> Positif)
            const currVal = rawChgCurr > 0 ? rawChgCurr : (Math.abs(rawPbat) / (totalVoltage || 1));
            totalCurrent = Math.abs(currVal);
        } else {
            totalCurrent = 0;
        }
        
        const totalPower = parseFloat((totalVoltage * totalCurrent).toFixed(2));

        // --- DATA MASTER ---
        const masterSoc = parseFloat(parseFloat(historyLast.bmsSoc || 0).toFixed(2));
        const masterVoltage = parseFloat(historyLast.bmsBatteryVolt || totalVoltage);
        const masterCurrent = parseFloat(historyLast.bmsBatteryCurr || 0); // Di data lu bernilai 5.1 (positif/charging)
        const masterPower = parseFloat((masterVoltage * masterCurrent).toFixed(2));

        // --- DATA SLAVE ---
        // Jika total charging 6.8A dan master charging 5.1A, maka slave = 6.8 - 5.1 = 1.7A (Charging/Positif)
        let slaveCurrent = parseFloat((totalCurrent - masterCurrent).toFixed(2));

        const slaveVoltage = totalVoltage;
        const slavePower = parseFloat((slaveVoltage * slaveCurrent).toFixed(2));

        // --- 2. TARIK DATA TERAKHIR DARI FIRESTORE UNTUK KONTROL & AH COUNTING ---
        const currentTimestampStr = historyLast.calendar || new Date().toISOString();
        const currentTime = new Date(currentTimestampStr).getTime();

        const lastSnapshot = await db.collection('bms_logs')
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        let slaveSoc = masterSoc; // Default awal

        if (!lastSnapshot.empty) {
            const lastDoc = lastSnapshot.docs[0].data();
            const lastTime = new Date(lastDoc.timestamp).getTime();
            const lastSlaveSoc = lastDoc.slave ? lastDoc.slave.soc : masterSoc;
            const lastMasterSoc = lastDoc.master ? lastDoc.master.soc : masterSoc;

            const deltaSeconds = (currentTime - lastTime) / 1000;

            if (deltaSeconds > 0 && deltaSeconds < 3600) {
                if (masterSoc === 100) {
                    // Kalibrasi penuh otomatis
                    slaveSoc = 100.0;
                    console.log("[CALIBRATION] Master SOC 100%. Slave SOC di-reset otomatis ke 100%.");
                } else {
                    // 1. Hitung Ah Counting dasar
                    const deltaHours = deltaSeconds / 3600;
                    const deltaAh = slaveCurrent * deltaHours; 
                    const deltaSocAh = (deltaAh / SLAVE_CAPACITY_AH) * 100;
                    let calculatedSlaveSoc = lastSlaveSoc + deltaSocAh;

                    // 2. KONTROL KOREKSI BERDASARKAN PERUBAHAN SOC MASTER
                    // Berapa persen Master berubah dari iterasi sebelumnya?
                    const masterSocDelta = masterSoc - lastMasterSoc;

                    if (masterSocDelta !== 0) {
                        // Jika master berubah, kita berikan bobot koreksi agar pergerakan slave 
                        // terkunci secara proporsional dengan dinamika master (mengurangi akumulasi eror sensor)
                        // Misal: Slave digeser dikit mendekati arah persentase perubahan master
                        const correctionWeight = 0.2; // 20% bobot koreksi master, 80% murni Ah counting (bisa disesuaikan)
                        const masterGuidedSoc = lastSlaveSoc + masterSocDelta;
                        
                        calculatedSlaveSoc = (calculatedSlaveSoc * (1 - correctionWeight)) + (masterGuidedSoc * correctionWeight);
                        console.log(`[MASTER GUIDED CONTROL] Master Delta: ${masterSocDelta}% | Koreksi diterapkan.`);
                    }

                    // Batasi rentang SOC antara 0 sampai 100
                    slaveSoc = parseFloat(Math.min(100, Math.max(0, calculatedSlaveSoc)).toFixed(2));
                    
                    console.log(`[AH COUNTING + CONTROL] Delta T: ${deltaSeconds}s | Slave SOC Final: ${slaveSoc}%`);
                }
            } else {
                console.log("[WARNING] Delta waktu tidak valid, menggunakan SOC Master sementara.");
            }
        } else {
            console.log("[BOOTSTRAP] Belum ada data historis di Firestore. Gunakan nilai awal master.");
        }

        // --- 3. PAYLOAD FIRESTORE ---
        const currentTimestamp = new Date(currentTimestampStr).toISOString();

        const firestorePayload = {
            timestamp: currentTimestamp,
            deviceSn: deviceSn,
            plantName: plantData[plantId].plantName || "Rumah Kablukan",
            system: {
                totalVoltage,
                totalCurrent,
                totalPower,
                gridVoltage: parseFloat(historyLast.vGrid || 0),
                gridFreq: parseFloat(historyLast.freqGrid || 0),
                loadPower: parseFloat(historyLast.outPutPower || 0),
                inverterTemp: parseFloat(historyLast.InvTemperature || 0)
            },
            master: {
                soc: masterSoc,
                voltage: masterVoltage,
                current: masterCurrent,
                power: masterPower,
                soh: parseFloat(historyLast.soh || 0),
                cycleCount: parseInt(historyLast.cycleCount || 0),
                temperature: parseFloat(historyLast.bmsBatteryTemp || 0),
                statusBms: historyLast.bmsStatus || 0
            },
            slave: {
                soc: slaveSoc,
                voltage: slaveVoltage,
                current: slaveCurrent,
                power: slavePower
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