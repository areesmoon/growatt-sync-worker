"use strict";

const { exec } = require('child_process');
const path = require('path');
// Memuat konfigurasi environment dari file .env.local dengan absolute path
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
const wa = require('./whatsapp');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const api = require('growatt');

// 1. Inisialisasi koneksi ke Firestore menggunakan file kredensial service account
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore();

// 2. Memuat konfigurasi kredensial, kapasitas baterai (Ah), threshold, dan nama collection dari .env.local
const username = process.env.GROWATT_USERNAME;
const password = process.env.GROWATT_PASSWORD;
const MASTER_CAPACITY_AH = parseFloat(process.env.MASTER_CAPACITY_AH || 100);
const SLAVE_CAPACITY_AH = parseFloat(process.env.SLAVE_CAPACITY_AH || 100);
const INV_STANDBY_THRESHOLD = parseFloat(process.env.INV_STANDBY_THRESHOLD_AMP || 0.4);
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'bms_logs';
let SLAVE_CORRECTION_FACTOR = parseFloat(process.env.SLAVE_CORRECTION_FACTOR || 0.58);

// --- HELPER FORMAT WAKTU WIB ---
function formatWibTime(isoString) {
    const date = isoString ? new Date(isoString) : new Date();
    return date.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/\./g, ':');
}

async function run() {
    try {
        // Validasi awal keberadaan kredensial
        if (!username || !password) {
            throw new Error("Kredensial Growatt belum diset di file .env.local!");
        }

        // 3. Autentikasi dan login ke API inverter Growatt
        const growatt = new api({});
        await growatt.login(username, password);

        // 4. Menarik data plant dengan opsi totalData: true untuk statistik energi kumulatif (kWh)
        let plantData = await growatt.getAllPlantData({
            plantData: false,
            deviceData: false,
            weather: false,
            totalData: true,
            statusData: true,
            historyAll: false
        });

        // 5. Mengambil objek data spesifik milik device inverter yang terhubung
        const plantId = Object.keys(plantData)[0];
        const plantObj = plantData[plantId] || {};
        const deviceSn = Object.keys(plantObj.devices)[0];
        const deviceNode = plantObj.devices[deviceSn];
        const statusData = deviceNode.statusData || {};
        const historyLast = deviceNode.historyLast;
        const totalData = deviceNode.totalData || {};

        // 6.1. gridPower
        const gridPower = parseFloat(statusData.gridPower || 0);
        const currentInverterMode = gridPower > 0 ? "UTI" : "SBU";

        // 6.1. gridVoltage
        const gridVoltage = parseFloat(historyLast.vGrid || 0);

        // 6.3. Mengambil angka energi kumulatif mentah dari inverter (dalam satuan kWh)
        const powerChargeTotal = parseFloat(totalData.chargeTotal || 0);
        const powerDischargeTotal = parseFloat(totalData.eDischargeTotal || 0);

        // 7. Mengambil data mentah tegangan dan daya baterai dari API untuk presisi maksimal
        const rawTotalVoltage = parseFloat(historyLast.vBat || 0);
        const totalPower = parseFloat(historyLast.pBat || 0) * -1; // pBat dibalik polaritasnya agar sinkron

        // [PENYESUAIAN PRESISI]: Arus total dihitung langsung dari pBat / vBat
        let totalCurrent = 0;
        if (rawTotalVoltage > 0) {
            totalCurrent = parseFloat((totalPower / rawTotalVoltage).toFixed(2));
        } else {
            totalCurrent = 0;
        }

        // Membaca parameter pendukung lain (beban rumah & produksi panel surya/PPV)
        const loadPower = parseFloat(historyLast.outPutPower || 0);
        const ppv1 = parseFloat(historyLast.ppv1 || 0);
        const ppv2 = parseFloat(historyLast.ppv2 || 0);
        const totalPpv = parseFloat((ppv1 + ppv2).toFixed(2));

        // 8. Mengambil data status baterai Master langsung dari BMS inverter (SOC%)
        const masterSoc = parseFloat(parseFloat(historyLast.bmsSoc || 0).toFixed(2));
        const masterCurrent = parseFloat(historyLast.bmsBatteryCurr || 0);

        // Hitung Ah Master mutlak saat ini berdasarkan perkalian SOC% dengan kapasitas nominalnya
        const currentMasterAh = parseFloat(((masterSoc / 100) * MASTER_CAPACITY_AH).toFixed(2));

        // 9. Menarik log snapshot terakhir dari Firestore (untuk acuan Ah sebelumnya & vBat rata-rata)
        const currentTimestampStr = historyLast.calendar || new Date().toISOString();

        const lastSnapshot = await db.collection(FIRESTORE_COLLECTION)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

        // 10. Menghitung tegangan rata-rata (vBat) antara t-5 dan t-0, serta inisialisasi nilai energi kumulatif
        let totalVoltage = rawTotalVoltage;
        let lastChargeTotal = powerChargeTotal;
        let lastDischargeTotal = powerDischargeTotal;
        const dischgCurr = parseFloat(historyLast.dischgCurr || 0);

        // [TAMBAHAN]: Variabel buat nyimpen SOC Master sebelumnya
        let lastMasterSoc = masterSoc;

        // inverter mode
        let lastInverterMode = currentInverterMode;

        // siapkan gridVoltage
        let lastGridVoltage = gridVoltage;

        // ppv
        let lastTotalPpv = totalPpv

        if (!lastSnapshot.empty) {
            const lastDoc = lastSnapshot.docs[0].data();

            // Ambil mode dari data sistem sebelumnya (kalau udah pernah disimpan)
            if (lastDoc.system && lastDoc.system.inverterMode) {
                lastInverterMode = lastDoc.system.inverterMode;
            }

            //ambil last grid voltage
            if (lastDoc.system && lastDoc.system.gridVoltage) {
                lastGridVoltage = lastDoc.system.gridVoltage;
            }

            //ambil last total PPV
            if (lastDoc.system && lastDoc.system.totalPpv) {
                lastTotalPpv = lastDoc.system.totalPpv;
            }

            const lastTotalVoltage = lastDoc.system ? (lastDoc.system.totalVoltage || rawTotalVoltage) : rawTotalVoltage;

            if (lastTotalVoltage > 0 && rawTotalVoltage > 0) {
                totalVoltage = parseFloat(((lastTotalVoltage + rawTotalVoltage) / 2).toFixed(2));
            }

            if (lastDoc.system) {
                lastChargeTotal = lastDoc.system.chargeTotal !== undefined ? lastDoc.system.chargeTotal : powerChargeTotal;
                lastDischargeTotal = lastDoc.system.dischargeTotal !== undefined ? lastDoc.system.dischargeTotal : powerDischargeTotal;
            }

            // [TAMBAHAN]: Ambil SOC master dari dokumen sebelumnya
            if (lastDoc.master && lastDoc.master.soc !== undefined) {
                lastMasterSoc = lastDoc.master.soc;
            }
        }

        const masterVoltage = parseFloat(historyLast.bmsBatteryVolt || totalVoltage);
        const masterPower = masterVoltage * masterCurrent;

        // 11. Menghitung arus sementara untuk baterai Slave
        let slaveCurrent = totalCurrent - masterCurrent;
        if (masterSoc === 100 && dischgCurr === -INV_STANDBY_THRESHOLD) {
            slaveCurrent = 0;
        }

        // Inisialisasi nilai Ah awal slave
        let slaveAh = (masterSoc / 100) * SLAVE_CAPACITY_AH;
        let slaveSoc = masterSoc;

        // 12. Logika Utama Kalkulasi Berbasis Ah Murni (ENERGY-TO-AH INTEGRATION ONLY)
        if (!lastSnapshot.empty) {
            const lastDoc = lastSnapshot.docs[0].data();

            SLAVE_CORRECTION_FACTOR = parseFloat(lastDoc.correctionFactor || SLAVE_CORRECTION_FACTOR);

            // Ambil data Ah Master & Slave sebelumnya dari Firestore
            const lastMasterAh = lastDoc.master && lastDoc.master.ah !== undefined
                ? lastDoc.master.ah
                : currentMasterAh;

            const lastSlaveAh = lastDoc.slave && lastDoc.slave.ah !== undefined
                ? lastDoc.slave.ah
                : ((lastDoc.slave ? lastDoc.slave.soc : masterSoc) / 100) * SLAVE_CAPACITY_AH;

            if (masterSoc === 100) {
                // Kalibrasi otomatis penuh
                slaveAh = SLAVE_CAPACITY_AH;
                slaveSoc = 100.0;
                console.log("[CALIBRATION] Master SOC 100%. Slave Ah & SOC di-reset otomatis penuh ke 100%.");
            } else {
                // Hitung delta energi kumulatif (kWh) dari inverter
                const deltaChargeKwh = powerChargeTotal - lastChargeTotal;
                const deltaDischargeKwh = powerDischargeTotal - lastDischargeTotal;
                const netEnergyKwh = deltaChargeKwh - deltaDischargeKwh;

                let calculatedSlaveAh = lastSlaveAh;

                if (totalVoltage > 0 && (deltaChargeKwh !== 0 || deltaDischargeKwh !== 0)) {
                    // Konversi kWh netto ke Total Ah sistem secara mutlak
                    const totalAhSystem = (netEnergyKwh * 1000) / totalVoltage;

                    // Hitung delta Ah yang terpakai/masuk di Master
                    const masterAhDelta = currentMasterAh - lastMasterAh;

                    // Sisa delta Ah murni milik Slave setelah dikurangi master, lalu dikali faktor koreksi empiris lapangan
                    const rawSlaveAhDelta = totalAhSystem - masterAhDelta;
                    const slaveAhDelta = rawSlaveAhDelta * SLAVE_CORRECTION_FACTOR;

                    calculatedSlaveAh = lastSlaveAh + slaveAhDelta;

                    console.log(`[CORRECTED ENERGY-TO-AH] Net kWh: ${netEnergyKwh.toFixed(4)} | Raw Delta: ${rawSlaveAhDelta.toFixed(2)} | Corrected Delta: ${slaveAhDelta.toFixed(2)}`);
                } else {
                    // JIKA KWH KUMULATIF MANDEK (DELTA 0): Slave mutlak diam/statis ngikutin nilai terakhirnya!
                    calculatedSlaveAh = lastSlaveAh;
                    console.log(`[STATIC] kWh Kumulatif Mandek (Delta 0). Slave Ah dipertahankan statis di: ${lastSlaveAh}Ah`);
                }

                // 13. Aturan Pengaman (Standby Lock & Cap Protection) berbasis Ah
                // Ambil data chgCurr langsung dari historyLast (arus masuk/charging dari inverter)
                const inverterChgCurr = parseFloat(historyLast.chgCurr || 0);
                const slaveSocCheck = (lastSlaveAh / SLAVE_CAPACITY_AH) * 100;

                if ((masterSoc === 100 || lastSlaveAh >= SLAVE_CAPACITY_AH) && (Math.abs(totalCurrent) <= INV_STANDBY_THRESHOLD || dischgCurr === -INV_STANDBY_THRESHOLD)) {
                    calculatedSlaveAh = SLAVE_CAPACITY_AH;
                    console.log("[STANDBY LOCK] Inverter idle / Standby, Slave Ah dikunci penuh.");
                } else if (lastSlaveAh >= SLAVE_CAPACITY_AH && slaveCurrent > 0) {
                    calculatedSlaveAh = SLAVE_CAPACITY_AH;
                    console.log("[CAP PROTECTION] Slave penuh & masih charging, Ah dikunci.");
                } else if (inverterChgCurr === 0 && slaveSocCheck >= 90.0) {
                    // [AUTO-SYNC OVERRIDE]: Jika inverter sudah berhenti nge-charge (chgCurr == 0) 
                    // dan SOC Slave sudah tinggi (>= 90%), selaraskan nilai Ah slave dengan master.
                    calculatedSlaveAh = (masterSoc / 100) * SLAVE_CAPACITY_AH;
                    console.log(`[AUTO-SYNC FULL] Inverter berhenti nge-charge (chgCurr: ${inverterChgCurr}A) dengan SOC tinggi (${slaveSocCheck.toFixed(1)}%). Ah di-sync selaras dengan Master.`);
                }

                // [AUTO-TRIGGER CORRECT.JS]: Jika sebelumnya di bawah kapasitas, 
                // tapi hasil kalkulasi baru ini tembus kapasitas maksimal, panggil correct.js otomatis!
                if (lastSlaveAh < SLAVE_CAPACITY_AH && calculatedSlaveAh >= SLAVE_CAPACITY_AH) {
                    console.log(`\n🚨 [AUTO-CORRECT TRIGGER] Slave tembus batas penuh (${calculatedSlaveAh.toFixed(2)}Ah). Menjalankan correct.js otomatis...`);

                    const scriptPath = path.join(__dirname, 'correct.js');
                    const command = `node "${scriptPath}" --slave_ah=${SLAVE_CAPACITY_AH}`;

                    exec(command, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`❌ Gagal menjalankan correct.js otomatis: ${error.message}`);
                            return;
                        }
                        if (stderr) {
                            console.error(`⚠️ Warning dari correct.js: ${stderr}`);
                        }
                        console.log(`✅ Sukses Eksekusi Otomatis:\n${stdout}`);
                    });
                }

                slaveAh = parseFloat(Math.min(SLAVE_CAPACITY_AH, Math.max(0, calculatedSlaveAh)).toFixed(2));

                // Batasi nilai Ah slave di antara 0 sampai kapasitas maksimum nominalnya
                slaveAh = parseFloat(Math.min(SLAVE_CAPACITY_AH, Math.max(0, calculatedSlaveAh)).toFixed(2));

                // Turunkan persentase SOC untuk display dashboard
                slaveSoc = parseFloat(((slaveAh / SLAVE_CAPACITY_AH) * 100).toFixed(2));
                console.log(`[RESULT] Slave Ah: ${slaveAh}Ah / ${SLAVE_CAPACITY_AH}Ah | Slave SOC: ${slaveSoc}%`);
            }
        } else {
            console.log("[BOOTSTRAP] Belum ada data historis di Firestore. Inisialisasi awal Ah berbasis Master.");
        }

        const slaveVoltage = totalVoltage;
        const slavePower = slaveVoltage * slaveCurrent;

        // 14. Menyusun struktur payload data matang dengan menyertakan nilai Ah dan SOC% untuk display
        const currentTimestamp = new Date(currentTimestampStr).toISOString();

        const firestorePayload = {
            timestamp: currentTimestamp,
            deviceSn: deviceSn,
            plantName: plantObj.plantName || "Rumah Kablukan",
            correctionFactor: SLAVE_CORRECTION_FACTOR,
            system: {
                totalVoltage,
                totalCurrent: parseFloat(totalCurrent.toFixed(2)),
                totalPower: parseFloat(totalPower.toFixed(2)),
                totalPpv,
                loadPower,
                chargeTotal: powerChargeTotal,
                dischargeTotal: powerDischargeTotal,
                gridVoltage,
                gridFreq: parseFloat(historyLast.freqGrid || 0),
                inverterTemp: parseFloat(historyLast.InvTemperature || 0),
                gridPower: gridPower,
                inverterMode: currentInverterMode
            },
            master: {
                ah: currentMasterAh,
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
                ah: slaveAh,
                soc: slaveSoc,
                voltage: slaveVoltage,
                current: parseFloat(slaveCurrent.toFixed(2)),
                power: parseFloat(slavePower.toFixed(2))
            }
        };

        // 15. Pengecekan duplikat data berdasarkan timestamp
        const existingDocs = await db.collection(FIRESTORE_COLLECTION)
            .where('timestamp', '==', currentTimestamp)
            .limit(1)
            .get();

        if (!existingDocs.empty) {
            console.log(`[SKIP] Data dengan timestamp ${currentTimestamp} sudah ada di Firestore (${FIRESTORE_COLLECTION}).`);
            return;
        }

        const timeWib = formatWibTime(currentTimestamp);

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT: Deteksi Perubahan Suplai Beban (PLTS / PLN)
        // -------------------------------------------------------------
        if (lastInverterMode !== currentInverterMode) {
            let modeMessage = "";

            if (currentInverterMode === "SBU") {
                modeMessage = `🔋 *POWER ALERT*\n\nSuplai beban berpindah ke *PLTS*.\n🕒 Waktu: ${timeWib}`;
            } else {
                modeMessage = `⚡ *POWER ALERT*\n\nSuplai beban berpindah ke *PLN*.\n🕒 Waktu: ${timeWib}`;
            }

            try {
                await wa.sendMessage(process.env.WA_TARGET_NUMBER, modeMessage);
                console.log(`📨 Notifikasi WA Perubahan Suplai (${currentInverterMode}) berhasil dikirim!`);
            } catch (waError) {
                console.error("❌ Gagal kirim notifikasi WA Suplai:", waError.message);
            }
        }

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT: Deteksi Perubahan Status PLN (Mati / Nyala)
        // -------------------------------------------------------------
        const isPlnUpNow = gridVoltage > 150;
        const isPlnUpBefore = lastGridVoltage > 150;

        if (isPlnUpBefore !== isPlnUpNow) {
            let plnAlertMessage = "";

            if (!isPlnUpNow) {
                plnAlertMessage = `🚨 *PLN BLACKOUT ALERT*\n\nJalur PLN padam! Sistem sepenuhnya mengandalkan backup baterai/solar.\n🕒 Waktu: ${timeWib}`;
            } else {
                plnAlertMessage = `⚡ *PLN NORMAL RESTORED*\n\nJalur PLN menyala kembali! Tegangan Grid pulih normal di *${gridVoltage}V*.\n🕒 Waktu: ${timeWib}`;
            }

            try {
                await wa.sendMessage(process.env.WA_TARGET_NUMBER, plnAlertMessage);
                console.log(`📨 Notifikasi WA Status PLN (${isPlnUpNow ? 'Nyala Kembali' : 'Padam'}) berhasil dikirim!`);
            } catch (waError) {
                console.error("❌ Gagal kirim notifikasi WA Status PLN:", waError.message);
            }
        }

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT: Deteksi Master SOC 100% Penuh
        // -------------------------------------------------------------
        if (lastMasterSoc < 100 && masterSoc === 100) {
            const alertMessage = `🔋 *BMS MASTER FULL ALERT*\n\nBaterai Master baru saja mencapai 100% penuh!\n⚡ Plant: ${plantObj.plantName || "Rumah Kablukan"}\n🕒 Waktu: ${timeWib}`;

            try {
                await wa.sendMessage(process.env.WA_TARGET_NUMBER, alertMessage);
                console.log("📨 Notifikasi WhatsApp Master SOC 100% berhasil dikirim!");
            } catch (waError) {
                console.error("❌ Gagal kirim notifikasi WA Master 100%:", waError.message);
            }
        }

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT: Deteksi Status Produksi Panel Surya (PPV)
        // -------------------------------------------------------------
        const isSolarProducingNow = totalPpv > 0;
        const isSolarProducingBefore = lastTotalPpv > 0;

        if (isSolarProducingBefore !== isSolarProducingNow) {
            let solarAlertMessage = "";

            if (!isSolarProducingNow) {
                // Dari ada produksi (> 0) menjadi 0 (Habis/Malam)
                solarAlertMessage = `🌙 *SOLAR PRODUCTION STOPPED*\n\nProduksi panel surya berhenti / habis. Sistem beralih sepenuhnya ke Baterai/PLN.\n🕒 Waktu: ${timeWib}`;
            } else {
                // Dari 0 menjadi mulai berproduksi (> 0)
                solarAlertMessage = `☀️ *SOLAR PRODUCTION STARTED*\n\nPanel surya mulai berproduksi! Daya terdeteksi *${totalPpv}W*.\n🕒 Waktu: ${timeWib}`;
            }

            try {
                await wa.sendMessage(process.env.WA_TARGET_NUMBER, solarAlertMessage);
                console.log(`📨 Notifikasi WA Status Panel Surya (${isSolarProducingNow ? 'Mulai Produksi' : 'Habis'}) berhasil dikirim!`);
            } catch (waError) {
                console.error("❌ Gagal kirim notifikasi WA Panel Surya:", waError.message);
            }
        }

        // Ambil threshold dari .env, sediakan nilai default cadangan
        const batToGridThreshold = parseInt(process.env.BAT_TO_GRID_THRESHOLD || 35, 10);
        const batCriticalThreshold = parseInt(process.env.BAT_CRITICAL_THRESHOLD || 22, 10);
        const batCriticalAlert = parseInt(process.env.BAT_CRITICAL_ALERT || 20, 10);

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT 1: Batas Baterai Switch ke Grid/PLN (BAT2GRID)
        // -------------------------------------------------------------
        if (lastMasterSoc > batToGridThreshold && masterSoc <= batToGridThreshold) {
            let bat2GridMessage = `⚡ *SWITCH TO GRID ALERT*\n\nKapasitas baterai PLTS menyentuh *${masterSoc}%* 🔌 Inverter akan switch suplai beban ke jalur PLN.\n🕒 Waktu: ${timeWib}`;

            try {
                await wa.sendMessage(process.env.WA_TARGET_NUMBER, bat2GridMessage);
                console.log(`📨 Notifikasi WA BAT2GRID (${masterSoc}%) berhasil dikirim!`);
            } catch (waError) {
                console.error("❌ Gagal kirim notifikasi WA BAT2GRID:", waError.message);
            }
        }

        // -------------------------------------------------------------
        // 🚨 WHATSAPP ALERT 2: Early Warning Baterai Kritis (Mau Habis)
        // -------------------------------------------------------------
        if (lastMasterSoc > batCriticalThreshold && masterSoc <= batCriticalThreshold) {
            let earlyWarningMessage = `🚨 *CRITICAL BATTERY WARNING*\n\nKapasitas baterai PLTS turun ke angka *${masterSoc}%*! (Mendekati batas kritis di ${batCriticalAlert}%).\n⚠️ Inverter akan segera shutdown total jika tidak ada suplai lain. Segera ambil tindakan!\n🕒 Waktu: ${timeWib}`;

            try {
                await wa.sendMessage(process.env.WA_TARGET_NUMBER, earlyWarningMessage);
                console.log(`📨 Notifikasi WA Baterai Kritis (${masterSoc}%) berhasil dikirim!`);
            } catch (waError) {
                console.error("❌ Gagal kirim notifikasi WA Baterai Kritis:", waError.message);
            }
        }

        // 16. Menyimpan dokumen payload baru ke Firestore
        // Format timestamp jadi string aman untuk Firestore Document ID
        // Contoh: "2026-07-24T03:31:17.000Z" diubah jadi "2026-07-24_03-31-17"
        const customDocId = currentTimestamp
            .replace(/[:.]/g, '-')  // ganti titik dan titik dua jadi dash (-)
            .replace('T', '_');     // ganti T jadi underscore (_)

        // Menyimpan dokumen dengan Custom ID yang rapi
        await db.collection(FIRESTORE_COLLECTION).doc(customDocId).set(firestorePayload);
        console.log(`[SUCCESS] Data berhasil disimpan dengan Custom ID: ${customDocId}`);

    } catch (error) {
        console.error("Gagal ambil data:", error.message);
    }
}

run();