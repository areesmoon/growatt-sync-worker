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

        console.log(JSON.stringify(historyLast, 0, 2));

    } catch (error) {
        console.error("Gagal ambil data:", error.message);
    }
}

run();