"use strict";

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const ExcelJS = require('exceljs');

// 1. Inisialisasi Firestore menggunakan Service Account
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

if (getApps().length === 0) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();
const FIRESTORE_COLLECTION = 'bms_logs';

async function exportCurrentLogs() {
    try {
        console.log("📥 Mengambil data telemetri arus dari Firestore...");
        
        // Tarik data bms_logs, urutkan dari yang terbaru
        const snapshot = await db.collection(FIRESTORE_COLLECTION)
            .orderBy('timestamp', 'desc')
            .limit(300) 
            .get();

        if (snapshot.empty) {
            console.log("⚠️ Tidak ada data ditemukan di koleksi bms_logs.");
            return;
        }

        // Inisialisasi Workbook Excel
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Aris - Rumah Kablukan';
        
        const sheet = workbook.addWorksheet('Current Trend Analysis', {
            views: [{ showGridLines: true }]
        });

        // Setup Kolom Sederhana (Fokus Arus Saja)
        sheet.columns = [
            { header: 'Timestamp', key: 'timestamp', width: 22 },
            { header: 'System Total Current (A)', key: 'sysTotalCurr', width: 25 },
            { header: 'Master Current (A)', key: 'masterCurr', width: 20 },
            { header: 'Slave Current (A)', key: 'slaveCurr', width: 20 }
        ];

        // Styling Header Row
        sheet.getRow(1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFF' } };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: '1F4E78' } // Biru profesional
        };
        sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };

        // Masukkan Data dari Firestore Payload
        snapshot.forEach(doc => {
            const data = doc.data();
            
            // Ambil timestamp dan format rapi
            let formattedTime = '-';
            if (data.timestamp) {
                const dt = data.timestamp.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
                formattedTime = dt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
            }

            sheet.addRow({
                timestamp: formattedTime,
                sysTotalCurr: data.system?.totalCurrent || 0,
                masterCurr: data.master?.current || 0,
                slaveCurr: data.slave?.current || 0
            });
        });

        // Styling Data Rows & Format Angka Desimal Dua Digit
        sheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) {
                row.alignment = { vertical: 'middle' };
                row.getCell(1).alignment = { horizontal: 'center' };
                row.getCell(2).alignment = { horizontal: 'right' };
                row.getCell(3).alignment = { horizontal: 'right' };
                row.getCell(4).alignment = { horizontal: 'right' };
                
                row.getCell(2).numFmt = '#,##0.00';
                row.getCell(3).numFmt = '#,##0.00';
                row.getCell(4).numFmt = '#,##0.00';
            }
        });

        // Simpan File Excel Murni (.xlsx)
        const fileName = `BMS_Current_Comparison_${Date.now()}.xlsx`;
        await workbook.xlsx.writeFile(fileName);
        
        console.log(`✅ Berhasil! File excel arus tersimpan sebagai: ${fileName}`);

    } catch (error) {
        console.error("❌ Gagal mengekspor data arus:", error);
    }
}

exportCurrentLogs();