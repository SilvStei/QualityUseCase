'use strict';

const fs = require('fs');
const path = require('path');

const MFI_GRENZE_NIEDRIG = 10.0;
const MFI_GRENZE_HOCH = 15.0;
const ANZAHL_MESSUNGEN = 10;

const offChainLogVerzeichnis = path.join(__dirname, 'offchain_sensor_logs');
if (!fs.existsSync(offChainLogVerzeichnis)) {
    fs.mkdirSync(offChainLogVerzeichnis, { recursive: true });
}

function generiereMfiWert(qualitaetsProfil, index) {
    let messwert;
    const guterWert = () => MFI_GRENZE_NIEDRIG + Math.random() * (MFI_GRENZE_HOCH - MFI_GRENZE_NIEDRIG);

    switch (qualitaetsProfil) {
        case "SCHLECHT":
            messwert = (index % 2 === 0) ?
                (MFI_GRENZE_NIEDRIG - 1.0 - Math.random()) :
                (MFI_GRENZE_HOCH + 1.0 + Math.random());   
            break;
        case "GUT":
        default:
            messwert = guterWert();
            break;
    }
    return parseFloat(messwert.toFixed(2)); 
}

async function main() {
    if (process.argv.length < 4) {
        console.error("FEHLER DPP ID und Profil (GUT|SCHLECHT) angeben");
        process.exit(1);
    }
    const dppId = process.argv[2];
    const qualitaetsProfil = process.argv[3].toUpperCase();

    if (!["GUT", "SCHLECHT"].includes(qualitaetsProfil)) {
        console.error("FEHLER Ungueltiges Profil. GUT oder SCHLECHT waehlen");
        process.exit(1);
    }

    console.log(`SENSOR-SIM MFI Rohdaten DPP ${dppId}, Profil ${qualitaetsProfil}`);
    const rohMfiMesswerte = [];
    const zeitstempelListe = [];
    const startZeit = new Date();

    for (let i = 0; i < ANZAHL_MESSUNGEN; i++) {
        const messZeit = new Date(startZeit.getTime() + i * 1000);
        zeitstempelListe.push(messZeit.toISOString());
        rohMfiMesswerte.push(generiereMfiWert(qualitaetsProfil, i));
    }

    let csvInhalt = "zeitstempel,mfi_wert\n";
    for (let i = 0; i < ANZAHL_MESSUNGEN; i++) {
        csvInhalt += `${zeitstempelListe[i]},${rohMfiMesswerte[i]}\n`;
    }

    const zeitstempelDateiTeil = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const ausgabeDateiname = `${dppId}_MFI_ROH_${qualitaetsProfil}_${zeitstempelDateiTeil}.csv`;
    const ausgabePfad = path.join(offChainLogVerzeichnis, ausgabeDateiname);

    try {
        fs.writeFileSync(ausgabePfad, csvInhalt);
        console.log(`RAW_FILE_PATH=${ausgabePfad}`);
    } catch (err) {
        console.error(`Fehler beim Schreiben der Rohdaten Datei ${err}`);
        process.exit(1);
    }
}

main();