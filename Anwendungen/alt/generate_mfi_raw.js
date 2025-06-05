'use strict';

const fs = require('fs');
const path = require('path');

const MFI_LOWER_LIMIT = 10.0;
const MFI_UPPER_LIMIT = 15.0;
const NUM_MFI_READINGS = 10;


const offChainLogDir = path.join(__dirname, 'offchain_sensor_logs');
if (!fs.existsSync(offChainLogDir)) {
    fs.mkdirSync(offChainLogDir, { recursive: true });
}

function generateMfiValue(qualityProfile, index) {
    let reading;
    const goodValue = () => MFI_LOWER_LIMIT + Math.random() * (MFI_UPPER_LIMIT - MFI_LOWER_LIMIT);

    switch (qualityProfile) {
        case "BAD":
            reading = (index % 2 === 0) ? (MFI_LOWER_LIMIT - 1.0 - Math.random()) : (MFI_UPPER_LIMIT + 1.0 + Math.random());
            break;
        case "GOOD":
        default:
            reading = goodValue();
            break;
    }
    return parseFloat(reading.toFixed(2));
}

async function main() {
    if (process.argv.length < 4) {
        console.error("FEHLER: Bitte DPP ID und Qualitätsprofil angeben.");
        console.error("Aufruf: node generate_mfi_raw.js <DPP_ID> <GOOD|BAD>");
        process.exit(1);
    }
    const dppId = process.argv[2];
    const qualityProfile = process.argv[3].toUpperCase();

    if (!["GOOD", "BAD"].includes(qualityProfile)) {
        console.error("FEHLER: Ungültiges Qualitätsprofil. Wähle GOOD oder BAD.");
        process.exit(1);
    }

    console.log(`[SENSOR-SIM] Generiere MFI Rohdaten für DPP: ${dppId}, Profil: ${qualityProfile}`);
    const rawMfiReadings = [];
    const timestamps = [];
    const startTime = new Date();

    for (let i = 0; i < NUM_MFI_READINGS; i++) {
        const readingTime = new Date(startTime.getTime() + i * 1000);
        timestamps.push(readingTime.toISOString());
        rawMfiReadings.push(generateMfiValue(qualityProfile, i));
    }

    let csvContent = "timestamp,mfi_value\n";
    for (let i = 0; i < NUM_MFI_READINGS; i++) {
        csvContent += `${timestamps[i]},${rawMfiReadings[i]}\n`;
    }

    const timestampFilePart = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const outputFilename = `${dppId}_MFI_RAW_${qualityProfile}_${timestampFilePart}.csv`;
    const outputPath = path.join(offChainLogDir, outputFilename);

    try {
        fs.writeFileSync(outputPath, csvContent);
        console.log(`RAW_FILE_PATH=${outputPath}`);
    } catch (err) {
        console.error(`Fehler beim Schreiben der Rohdaten-Datei: ${err}`);
        process.exit(1);
    }
}

main();