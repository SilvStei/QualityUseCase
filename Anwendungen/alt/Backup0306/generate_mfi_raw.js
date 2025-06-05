// -----------------------------------------------------------------------------
// generate_mfi_raw.js - Simuliert MFI-Sensor-Rohdatenerzeugung
// Erzeugt MFI-Messwerte und speichert sie in einer CSV-Datei.
// Gibt den Pfad zur erzeugten Datei auf STDOUT aus.
// -----------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');

const MFI_LOWER_LIMIT = 10.0; // Spezifikationsgrenzen für RAW_POLYMER_GRADE_X1
const MFI_UPPER_LIMIT = 15.0;
const NUM_MFI_READINGS = 10; // Anzahl simulierter Messwerte (reduziert für schnellere Tests)

// Verzeichnis für simulierte Off-Chain Logs
const offChainLogDir = path.join(__dirname, 'offchain_sensor_logs');
if (!fs.existsSync(offChainLogDir)) {
    fs.mkdirSync(offChainLogDir, { recursive: true });
}

function generateMfiValue(qualityProfile, index) {
    let reading;
    const goodValue = () => MFI_LOWER_LIMIT + Math.random() * (MFI_UPPER_LIMIT - MFI_LOWER_LIMIT);

    switch (qualityProfile) {
        case "BAD": // Erzeugt Werte, die sicher außerhalb der Toleranz liegen
            // Erzeugt abwechselnd Werte unter und über dem Limit
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

    console.log(`\n--- [SENSOR-SIM] Generiere MFI Rohdaten für DPP: ${dppId}, Profil: ${qualityProfile} ---`);
    const rawMfiReadings = [];
    const timestamps = [];
    const startTime = new Date();

    for (let i = 0; i < NUM_MFI_READINGS; i++) {
        const readingTime = new Date(startTime.getTime() + i * 1000); // Schnellere Zeitintervalle für Test
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
        console.log(`Simulierte MFI-Rohdaten erfolgreich geschrieben nach:`);
        console.log(`RAW_FILE_PATH=${outputPath}`); // Ausgabe für das nächste Skript
    } catch (err) {
        console.error(`Fehler beim Schreiben der Rohdaten-Datei: ${err}`);
        process.exit(1);
    }
}

main();