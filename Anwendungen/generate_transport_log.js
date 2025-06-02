// -----------------------------------------------------------------------------
// generate_transport_log.js - Simuliert Transport-Rohdatenerzeugung
// Erzeugt Temperatur- und Erschütterungswerte und speichert sie in einer CSV-Datei.
// Gibt den Pfad zur erzeugten Datei auf STDOUT aus.
// -----------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');

const SIMULATION_DURATION_MINUTES = 5; // Wie lange soll der Transport simuliert werden (in Minuten)?
const READINGS_PER_MINUTE = 6;         // Wie viele Messungen pro Minute?
const TOTAL_READINGS = SIMULATION_DURATION_MINUTES * READINGS_PER_MINUTE;

// Normale Temperaturbereich (Beispiel für gekühlte Ware, anpassbar)
const NORMAL_TEMP_MIN = 2.0;
const NORMAL_TEMP_MAX = 8.0;
const TEMP_ALERT_THRESHOLD_HIGH = 10.0; // Grad Celsius
const TEMP_ALERT_THRESHOLD_LOW = 0.0;   // Grad Celsius

// Erschütterung
const NORMAL_SHOCK_MAX_G = 0.5; // Maximale normale Erschütterung in g
const SHOCK_ALERT_THRESHOLD_G = 1.5; // g-Wert, der einen Alarm auslöst

// Verzeichnis für simulierte Off-Chain Logs
const offChainLogDir = path.join(__dirname, 'offchain_transport_logs');
if (!fs.existsSync(offChainLogDir)) {
    fs.mkdirSync(offChainLogDir, { recursive: true });
}

function simulateReading(baseValue, variation, profile, alertThresholdHigh, alertThresholdLow, readingIndex, totalReadings) {
    let value = baseValue + (Math.random() - 0.5) * variation * 2; // Wert um Basiswert mit Variation

    if (profile === "TEMP_EXCEEDED_HIGH" && readingIndex > totalReadings / 2) { // Ab der Hälfte der Zeit zu warm
        value = alertThresholdHigh + Math.random() * 5; // Deutlich über dem Grenzwert
    } else if (profile === "TEMP_EXCEEDED_LOW" && readingIndex > totalReadings / 2) { // Ab der Hälfte der Zeit zu kalt
        value = alertThresholdLow - Math.random() * 5; // Deutlich unter dem Grenzwert
    } else if (profile === "SHOCKS_DETECTED" && readingIndex % Math.floor(totalReadings / 3) === 0 && readingIndex > 0) { // 2-3 Schockereignisse
        value = alertThresholdHigh + Math.random(); // Simuliert einen hohen g-Wert
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
        
        let tempProfile = "NORMAL";
        if (transportProfile === "TEMP_EXCEEDED_HIGH" || transportProfile === "TEMP_EXCEEDED_LOW") {
            tempProfile = transportProfile;
        }
        const currentTemp = simulateReading((NORMAL_TEMP_MAX + NORMAL_TEMP_MIN) / 2, (NORMAL_TEMP_MAX - NORMAL_TEMP_MIN) / 2, tempProfile, TEMP_ALERT_THRESHOLD_HIGH, TEMP_ALERT_THRESHOLD_LOW, i, TOTAL_READINGS);
        
        let shockProfile = "NORMAL";
        if (transportProfile === "SHOCKS_DETECTED") {
            shockProfile = transportProfile;
        }
        const currentShock = simulateReading(NORMAL_SHOCK_MAX_G / 2, NORMAL_SHOCK_MAX_G / 2, shockProfile, SHOCK_ALERT_THRESHOLD_G, 0, i, TOTAL_READINGS);

        transportReadings.push({
            timestamp: readingTime.toISOString(),
            temperatur: currentTemp,
            erschuetterung_g: currentShock
        });
    }

    // CSV-Format: timestamp,temperatur,erschuetterung_g
    let csvContent = "timestamp,temperatur,erschuetterung_g\n";
    transportReadings.forEach(r => {
        csvContent += `${r.timestamp},${r.temperatur},${r.erschuetterung_g}\n`;
    });

    const timestampFilePart = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const outputFilename = `${dppId}_TRANSPORT_RAW_${transportProfile}_${timestampFilePart}.csv`;
    const outputPath = path.join(offChainLogDir, outputFilename);

    try {
        fs.writeFileSync(outputPath, csvContent);
        console.log(`Simulierte Transport-Rohdaten erfolgreich geschrieben nach:`);
        console.log(`RAW_FILE_PATH=${outputPath}`); // Ausgabe für das nächste Skript
    } catch (err) {
        console.error(`Fehler beim Schreiben der Transport-Rohdaten-Datei: ${err}`);
        process.exit(1);
    }
}

main();