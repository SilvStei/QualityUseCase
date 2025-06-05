// -----------------------------------------------------------------------------
// generate_transport_log.js - Simuliert Transport-Rohdatenerzeugung
// Erzeugt Temperatur- und Erschütterungswerte und speichert sie in einer CSV-Datei.
// Gibt den Pfad zur erzeugten Datei auf STDOUT aus.
// -----------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');

const SIMULATION_DURATION_MINUTES = 1; // Kürzere Dauer für schnellere Tests
const READINGS_PER_MINUTE = 6;         // 1 Messung alle 10 Sekunden
const TOTAL_READINGS = SIMULATION_DURATION_MINUTES * READINGS_PER_MINUTE;

// Parameter für die Simulation "GUTER" Bedingungen
const NORMAL_TEMP_MIN = 2.0;  // °C
const NORMAL_TEMP_MAX = 8.0;  // °C
const NORMAL_SHOCK_MAX_G = 0.5; // g

// Grenzwerte, deren Überschreitung einen ALERT auslösen soll
// Diese Werte sollten mit denen in `submit_transport_update.js` übereinstimmen oder diese überschreiten.
const TEMP_TARGET_FOR_HIGH_ALERT = 35.0; // Wenn Profil "TEMP_EXCEEDED_HIGH", werden Werte *um diesen Wert herum* generiert
const TEMP_TARGET_FOR_LOW_ALERT = -5.0;  // Wenn Profil "TEMP_EXCEEDED_LOW"
const SHOCK_TARGET_FOR_ALERT = 2.0;   // Wenn Profil "SHOCKS_DETECTED"

// Verzeichnis für simulierte Off-Chain Logs
const offChainLogDir = path.join(__dirname, 'offchain_transport_logs');
if (!fs.existsSync(offChainLogDir)) {
    fs.mkdirSync(offChainLogDir, { recursive: true });
}

// Generiert einen einzelnen Messwert
function generateSingleValue(profileType, specificProfile, readingIndex, totalReadings) {
    let value;
    const midPointGoodTemp = NORMAL_TEMP_MIN + (NORMAL_TEMP_MAX - NORMAL_TEMP_MIN) / 2;
    const variationGoodTemp = (NORMAL_TEMP_MAX - NORMAL_TEMP_MIN) / 2;

    const midPointGoodShock = NORMAL_SHOCK_MAX_G / 2;
    const variationGoodShock = NORMAL_SHOCK_MAX_G / 3; // Kleinere Variation für normale Schocks

    if (profileType === "TEMP") {
        value = midPointGoodTemp + (Math.random() - 0.5) * variationGoodTemp * 2; // Basis: Guter Temperaturwert
        if (specificProfile === "TEMP_EXCEEDED_HIGH" && readingIndex >= Math.floor(totalReadings / 2)) { // In der zweiten Hälfte der Zeit zu warm
            value = TEMP_TARGET_FOR_HIGH_ALERT + (Math.random() - 0.5) * 4; // Werte um 35°C +/- 2°C
        } else if (specificProfile === "TEMP_EXCEEDED_LOW" && readingIndex >= Math.floor(totalReadings / 2)) { // In der zweiten Hälfte der Zeit zu kalt
            value = TEMP_TARGET_FOR_LOW_ALERT + (Math.random() - 0.5) * 4;  // Werte um -5°C +/- 2°C
        }
    } else if (profileType === "SHOCK") {
        value = midPointGoodShock + (Math.random() - 0.5) * variationGoodShock * 2; // Basis: Normaler, geringer Schock
        if (value < 0) value = Math.random() * 0.1; // Schock nicht negativ, kleiner positiver Wert
        
        // Simuliere 1-2 Schockereignisse bei "SHOCKS_DETECTED"
        const numberOfShocksToSimulate = 2;
        const shockOccurrenceInterval = Math.floor(totalReadings / (numberOfShocksToSimulate +1));
        if (specificProfile === "SHOCKS_DETECTED" && (readingIndex +1) % shockOccurrenceInterval === 0 && readingIndex > 0 ) {
             value = SHOCK_TARGET_FOR_ALERT + Math.random() * 0.5; // Werte um 2.0g +/- 0.25g
        }
    } else {
        value = 0; // Fallback
    }
    return parseFloat(value.toFixed(2));
}

async function main() {
    if (process.argv.length < 4) {
        console.error("FEHLER: Bitte DPP ID und Transportprofil angeben.");
        console.error("Aufruf: node generate_transport_log.js <DPP_ID> <NORMAL|TEMP_EXCEEDED_HIGH|TEMP_EXCEEDED_LOW|SHOCKS_DETECTED>");
        process.exit(1);
    }
    const dppId = process.argv[2];
    const transportProfile = process.argv[3].toUpperCase();

    const validProfiles = ["NORMAL", "TEMP_EXCEEDED_HIGH", "TEMP_EXCEEDED_LOW", "SHOCKS_DETECTED"];
    if (!validProfiles.includes(transportProfile)) {
        console.error(`FEHLER: Ungültiges Transportprofil. Wähle: ${validProfiles.join('|')}.`);
        process.exit(1);
    }

    console.log(`\n--- [TRANSPORT-SENSOR-SIM] Generiere Transport-Log für DPP: ${dppId}, Profil: ${transportProfile} ---`);
    const transportReadings = [];
    const startTime = new Date();

    for (let i = 0; i < TOTAL_READINGS; i++) {
        const readingTime = new Date(startTime.getTime() + (i * (60 / READINGS_PER_MINUTE)) * 1000); // Zeitstempel
        
        const currentTemp = generateSingleValue(
            "TEMP",
            transportProfile, // Das Gesamtprofil steuert hier die Temperatur
            i, TOTAL_READINGS
        );
        
        const currentShock = generateSingleValue(
            "SHOCK",
            transportProfile, // Das Gesamtprofil steuert hier die Erschütterungen
            i, TOTAL_READINGS
        );

        transportReadings.push({
            timestamp: readingTime.toISOString(),
            temperatur: currentTemp,
            erschuetterung_g: currentShock
        });
         console.log(`  Zeit: ${readingTime.toISOString()}, Temp: ${currentTemp}°C, Schock: ${currentShock}g`);
    }

    let csvContent = "timestamp,temperatur,erschuetterung_g\n";
    transportReadings.forEach(r => {
        csvContent += `${r.timestamp},${r.temperatur},${r.erschuetterung_g}\n`;
    });

    const timestampFilePart = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, ''); // Erzeugt einen sauberen Zeitstempel für den Dateinamen
    const outputFilename = `${dppId}_TRANSPORT_RAW_${transportProfile}_${timestampFilePart}.csv`;
    const outputPath = path.join(offChainLogDir, outputFilename);

    try {
        fs.writeFileSync(outputPath, csvContent);
        console.log(`\nSimulierte Transport-Rohdaten erfolgreich geschrieben nach:`);
        console.log(`RAW_FILE_PATH=${outputPath}`); // Wichtige Ausgabe für das nächste Skript
    } catch (err) {
        console.error(`Fehler beim Schreiben der Transport-Rohdaten-Datei: ${err}`);
        process.exit(1);
    }
}

main();