"use strict";

const { exec } = require('child_process');
const path = require('path');
// Memuat konfigurasi environment dari file .env.local dengan absolute path
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
const wa = require('./whatsapp');
const axios = require('axios'); // Pastikan axios sudah terinstall (npm install axios)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// 1. Inisialisasi koneksi ke Firestore menggunakan file kredensial service account
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

// 2. Memuat konfigurasi environment dan konstanta
const PLANT_ID = process.env.GROWATT_PLANT_ID || "11002949";
const STORAGE_SN = process.env.GROWATT_STORAGE_SN || "KHMAG3M0VC";
const COOKIE_HEADER = process.env.GROWATT_COOKIE || "";

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
    // Validasi keberadaan Cookie
    if (!COOKIE_HEADER) {
      throw new Error("GROWATT_COOKIE belum diset di file .env.local!");
    }

    // Headers standar ala browser menggunakan session cookie aktif
    const headers = {
      'Cookie': COOKIE_HEADER,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://server.growatt.com/'
    };

    console.log("🔄 Mengambil data langsung dari endpoint internal Growatt...");

    // 3. Request paralel ke endpoint Total Data & Status (Keduanya pakai POST dengan form-url-encoded)
    const postData = `plantId=${PLANT_ID}&storageSn=${STORAGE_SN}`;
    const postHeaders = {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    const [totalRes, statusRes] = await Promise.all([
      axios.post(`https://server.growatt.com/panel/storage/getStorageTotalData`, postData, { headers: postHeaders }),
      axios.post(`https://server.growatt.com/panel/storage/getStorageStatusData`, postData, { headers: postHeaders })
    ]);

    const totalData = totalRes.data.obj || {};
    const statusData = statusRes.data.obj || {};

    if (!totalRes.data.result || !statusRes.data.result) {
      throw new Error("Gagal mengambil data dari endpoint internal (Kemungkinan Cookie expired / Sesi habis).");
    }

    // 4. Mapping data dari endpoint internal baru
    const gridPower = parseFloat(statusData.gridPower || 0);
    const currentInverterMode = gridPower > 0 ? "UTI" : "SBU";

    const gridVoltage = parseFloat(statusData.vAcInput || 0);

    const powerChargeTotal = parseFloat(totalData.chargeTotal || 0);
    const powerDischargeTotal = parseFloat(totalData.eDischargeTotal || 0);

    const rawTotalVoltage = parseFloat(statusData.vBat || 0);
    const batPower = parseFloat(statusData.batPower || 0);
    const totalPower = batPower; // Nilai daya baterai langsung

    let totalCurrent = 0;
    if (rawTotalVoltage > 0) {
      totalCurrent = parseFloat((totalPower / rawTotalVoltage).toFixed(2));
    } else {
      totalCurrent = 0;
    }

    const loadPower = parseFloat(statusData.loadPower || 0);
    const totalPpv = parseFloat(statusData.panelPower || 0);

    // 8. Mengambil data status baterai Master
    const masterSoc = parseFloat(parseFloat(statusData.capacity || 0).toFixed(2));
    const masterCurrent = parseFloat(statusData.iTotal || 0);

    const currentMasterAh = parseFloat(((masterSoc / 100) * MASTER_CAPACITY_AH).toFixed(2));

    // 9. Menarik log snapshot terakhir dari Firestore
    const currentTimestampStr = new Date().toISOString();

    const lastSnapshot = await db.collection(FIRESTORE_COLLECTION)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    let totalVoltage = rawTotalVoltage;
    let lastChargeTotal = powerChargeTotal;
    let lastDischargeTotal = powerDischargeTotal;
    const dischgCurr = 0; // Default jika tidak ada di endpoint status

    let lastMasterSoc = masterSoc;
    let lastInverterMode = currentInverterMode;
    let lastGridVoltage = gridVoltage;
    let lastTotalPpv = totalPpv;

    if (!lastSnapshot.empty) {
      const lastDoc = lastSnapshot.docs[0].data();

      if (lastDoc.system && lastDoc.system.inverterMode) {
        lastInverterMode = lastDoc.system.inverterMode;
      }

      if (lastDoc.system && lastDoc.system.gridVoltage !== undefined) {
        lastGridVoltage = parseFloat(lastDoc.system.gridVoltage) || 0;
      }

      if (lastDoc.system && lastDoc.system.totalPpv !== undefined) {
        lastTotalPpv = parseFloat(lastDoc.system.totalPpv) || 0;
      }

      const lastTotalVoltage = lastDoc.system ? (lastDoc.system.totalVoltage || rawTotalVoltage) : rawTotalVoltage;

      if (lastTotalVoltage > 0 && rawTotalVoltage > 0) {
        totalVoltage = parseFloat(((lastTotalVoltage + rawTotalVoltage) / 2).toFixed(2));
      }

      if (lastDoc.system) {
        lastChargeTotal = lastDoc.system.chargeTotal !== undefined ? lastDoc.system.chargeTotal : powerChargeTotal;
        lastDischargeTotal = lastDoc.system.dischargeTotal !== undefined ? lastDoc.system.dischargeTotal : powerDischargeTotal;
      }

      if (lastDoc.master && lastDoc.master.soc !== undefined) {
        lastMasterSoc = lastDoc.master.soc;
      }
    }

    const masterVoltage = rawTotalVoltage;
    const masterPower = masterVoltage * masterCurrent;

    let slaveCurrent = totalCurrent - masterCurrent;

    let slaveAh = (masterSoc / 100) * SLAVE_CAPACITY_AH;
    let slaveSoc = masterSoc;

    // 12. Logika Utama Kalkulasi Berbasis Ah Murni
    if (!lastSnapshot.empty) {
      const lastDoc = lastSnapshot.docs[0].data();

      SLAVE_CORRECTION_FACTOR = parseFloat(lastDoc.correctionFactor || SLAVE_CORRECTION_FACTOR);

      const lastMasterAh = lastDoc.master && lastDoc.master.ah !== undefined
        ? lastDoc.master.ah
        : currentMasterAh;

      const lastSlaveAh = lastDoc.slave && lastDoc.slave.ah !== undefined
        ? lastDoc.slave.ah
        : ((lastDoc.slave ? lastDoc.slave.soc : masterSoc) / 100) * SLAVE_CAPACITY_AH;

      if (masterSoc === 100) {
        slaveAh = SLAVE_CAPACITY_AH;
        slaveSoc = 100.0;
        console.log("[CALIBRATION] Master SOC 100%. Slave Ah & SOC di-reset otomatis penuh ke 100%.");
      } else {
        const deltaChargeKwh = powerChargeTotal - lastChargeTotal;
        const deltaDischargeKwh = powerDischargeTotal - lastDischargeTotal;
        const netEnergyKwh = deltaChargeKwh - deltaDischargeKwh;

        let calculatedSlaveAh = lastSlaveAh;

        if (totalVoltage > 0 && (deltaChargeKwh !== 0 || deltaDischargeKwh !== 0)) {
          const totalAhSystem = (netEnergyKwh * 1000) / totalVoltage;
          const masterAhDelta = currentMasterAh - lastMasterAh;
          const rawSlaveAhDelta = totalAhSystem - masterAhDelta;
          const slaveAhDelta = rawSlaveAhDelta * SLAVE_CORRECTION_FACTOR;

          calculatedSlaveAh = lastSlaveAh + slaveAhDelta;
          console.log(`[CORRECTED ENERGY-TO-AH] Net kWh: ${netEnergyKwh.toFixed(4)} | Raw Delta: ${rawSlaveAhDelta.toFixed(2)} | Corrected Delta: ${slaveAhDelta.toFixed(2)}`);
        } else {
          calculatedSlaveAh = lastSlaveAh;
          console.log(`[STATIC] kWh Kumulatif Mandek (Delta 0). Slave Ah dipertahankan statis di: ${lastSlaveAh}Ah`);
        }

        // Trigger auto-correct.js jika tembus kapasitas maksimal
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
        slaveSoc = parseFloat(((slaveAh / SLAVE_CAPACITY_AH) * 100).toFixed(2));
        console.log(`[RESULT] Slave Ah: ${slaveAh}Ah / ${SLAVE_CAPACITY_AH}Ah | Slave SOC: ${slaveSoc}%`);
      }
    } else {
      console.log("[BOOTSTRAP] Belum ada data historis di Firestore. Inisialisasi awal Ah berbasis Master.");
    }

    const slaveVoltage = totalVoltage;
    const slavePower = slaveVoltage * slaveCurrent;

    // 14. Menyusun struktur payload data matang
    const currentTimestamp = new Date(currentTimestampStr).toISOString();

    const firestorePayload = {
      timestamp: currentTimestamp,
      deviceSn: STORAGE_SN,
      plantName: "Rumah Kablukan",
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
        gridFreq: parseFloat(statusData.fAcInput || 0),
        inverterTemp: 0,
        gridPower: gridPower,
        inverterMode: currentInverterMode
      },
      master: {
        ah: currentMasterAh,
        soc: masterSoc,
        voltage: masterVoltage,
        current: masterCurrent,
        power: parseFloat(masterPower.toFixed(2)),
        soh: 100,
        cycleCount: 0,
        temperature: 0,
        statusBms: parseInt(statusData.status || 0)
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
    // 🚨 WHATSAPP ALERTS
    // -------------------------------------------------------------
    if (lastInverterMode !== currentInverterMode) {
      let modeMessage = currentInverterMode === "SBU"
        ? `🔋 *POWER ALERT*\n\nSuplai beban berpindah ke *PLTS*.\n🕒 Waktu: ${timeWib}`
        : `⚡ *POWER ALERT*\n\nSuplai beban berpindah ke *PLN*.\n🕒 Waktu: ${timeWib}`;
      try {
        await wa.sendMessage(process.env.WA_TARGET_NUMBER, modeMessage);
      } catch (waError) { console.error("Gagal kirim WA:", waError.message); }
    }

    const isPlnUpNow = gridVoltage > 150;
    const isPlnUpBefore = lastGridVoltage > 150;
    if (isPlnUpBefore !== isPlnUpNow) {
      let plnAlertMessage = !isPlnUpNow
        ? `🚨 *PLN BLACKOUT ALERT*\n\nJalur PLN padam! Sistem sepenuhnya mengandalkan backup baterai/solar.\n🕒 Waktu: ${timeWib}`
        : `⚡ *PLN NORMAL RESTORED*\n\nJalur PLN menyala kembali! Tegangan Grid pulih normal di *${gridVoltage}V*.\n🕒 Waktu: ${timeWib}`;
      try {
        await wa.sendMessage(process.env.WA_TARGET_NUMBER, plnAlertMessage);
      } catch (waError) { console.error("Gagal kirim WA:", waError.message); }
    }

    if (lastMasterSoc < 100 && masterSoc === 100) {
      let alertMessage = `🔋 *BMS MASTER FULL ALERT*\n\nBaterai Master baru saja mencapai 100% penuh!\n⚡ Plant: Rumah Kablukan\n🕒 Waktu: ${timeWib}`;
      try {
        await wa.sendMessage(process.env.WA_TARGET_NUMBER, alertMessage);
      } catch (waError) { console.error("Gagal kirim WA:", waError.message); }
    }

    const isSolarProducingNow = totalPpv > 0;
    const isSolarProducingBefore = lastTotalPpv > 0;
    if (isSolarProducingBefore !== isSolarProducingNow) {
      let solarAlertMessage = !isSolarProducingNow
        ? `🌙 *SOLAR PRODUCTION STOPPED*\n\nProduksi panel surya berhenti / habis.\n🕒 Waktu: ${timeWib}`
        : `☀️ *SOLAR PRODUCTION STARTED*\n\nPanel surya mulai berproduksi! Daya *${totalPpv}W*.\n🕒 Waktu: ${timeWib}`;
      try {
        await wa.sendMessage(process.env.WA_TARGET_NUMBER, solarAlertMessage);
      } catch (waError) { console.error("Gagal kirim WA:", waError.message); }
    }

    const batToGridThreshold = parseInt(process.env.BAT_TO_GRID_THRESHOLD || 35, 10);
    const batCriticalThreshold = parseInt(process.env.BAT_CRITICAL_THRESHOLD || 22, 10);
    const batCriticalAlert = parseInt(process.env.BAT_CRITICAL_ALERT || 20, 10);

    if (lastMasterSoc > batToGridThreshold && masterSoc <= batToGridThreshold) {
      let bat2GridMessage = `⚡ *SWITCH TO GRID ALERT*\n\nKapasitas baterai PLTS menyentuh *${masterSoc}%* 🔌 Inverter akan switch suplai beban ke jalur PLN.\n🕒 Waktu: ${timeWib}`;
      try {
        await wa.sendMessage(process.env.WA_TARGET_NUMBER, bat2GridMessage);
      } catch (waError) { console.error("Gagal kirim WA:", waError.message); }
    }

    if (lastMasterSoc > batCriticalThreshold && masterSoc <= batCriticalThreshold) {
      let earlyWarningMessage = `🚨 *CRITICAL BATTERY WARNING*\n\nKapasitas baterai PLTS turun ke angka *${masterSoc}%*! (Mendekati batas kritis di ${batCriticalAlert}%).\n⚠️ Inverter akan segera shutdown total jika tidak ada suplai lain.\n🕒 Waktu: ${timeWib}`;
      try {
        await wa.sendMessage(process.env.WA_TARGET_NUMBER, earlyWarningMessage);
      } catch (waError) { console.error("Gagal kirim WA:", waError.message); }
    }

    // 16. Menyimpan dokumen payload baru ke Firestore
    const customDocId = currentTimestamp
      .replace(/[:.]/g, '-')
      .replace('T', '_');

    await db.collection(FIRESTORE_COLLECTION).doc(customDocId).set(firestorePayload);
    console.log(`[SUCCESS] Data berhasil disimpan dengan Custom ID: ${customDocId}`);

  } catch (error) {
    console.error("Gagal ambil data:", error.message);
  }
}

run();