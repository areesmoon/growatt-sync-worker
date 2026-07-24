"use strict";

const wa = require('./whatsapp');
require('dotenv').config({ path: './.env.local' });

async function testSend() {
    const targetNumber = process.env.WA_TARGET_NUMBER;
    const testMessage = "🤖 Halo Aris, test notifikasi dari Growatt Sync Worker!";

    console.log(`Sedang mengirim pesan tes ke ${targetNumber}...`);

    try {
        const response = await wa.sendMessage(targetNumber, testMessage);
        
        console.log("\n✅ BERHASIL DIKIRIM!");
        console.log("📥 Respon dari Gateway:", JSON.stringify(response, null, 2));

    } catch (error) {
        console.log("\n❌ GAGAL MENGIRIM PESAN!");
        if (error.response) {
            // Error dari server API (misal 401 Unauthorized, 404, dll)
            console.log("status:", error.response.status);
            console.log("data:", error.response.data);
        } else {
            // Error koneksi / jaringan
            console.log("pesan error:", error.message);
        }
    }
}

testSend();