'use strict';

const fs = require('fs');
const path = require('path');


// Hier werden die Anzahl der simulierten Sesnordaten und die Grenzwerte für Temperatur und Erschütterungen festgelegt

const ANZAHL_LOG_EINTRAGE = 5; 
const TEMP_NORMAL_MIN = 5.0;
const TEMP_NORMAL_MAX = 30.0;
const TEMP_ALARM_HOCH = 35.1;  
const TEMP_ALARM_NIEDRIG = -0.1; 
const ERSCHUETTERUNG_NORMAL_MAX_G = 0.8;
const ERSCHUETTERUNG_ALARM_G = 1.1; 


// Hier wird das Verzeichnis für die CSV Datei festgelegt. Falls dieses nicht existiert, wird es erstellt.

const offChainLogVerzeichnis = path.join(__dirname, 'offchain_transport_logs');
if (!fs.existsSync(offChainLogVerzeichnis)) {
    fs.mkdirSync(offChainLogVerzeichnis, { recursive: true });
}


// In dieser Funktion wird der Transportsensor simuliert. 

function generiereTransportLogs(dppId, transportProfil) {
    const logs = [];
    const startZeit = new Date();

    for (let i = 0; i < ANZAHL_LOG_EINTRAGE_PRO_TYP; i++) {
        const zeitpunkt = new Date(startZeit.getTime() + i * 2 * 3600000);

        let tempWert = TEMP_NORMAL_MIN + Math.random() * (TEMP_NORMAL_MAX - TEMP_NORMAL_MIN);
        let tempZustand = 'OK';

        logs.push({
            zeitstempel: new Date(zeitpunkt.getTime() + 300000).toISOString(), 
            parametertyp: 'FeuchtigkeitRelativ',
            wert: (40 + Math.random() * 15).toFixed(1),
            einheit: '%',
            zustand: 'OK',
        });

        let erschuetterungWert = (Math.random() * ERSCHUETTERUNG_NORMAL_MAX_G).toFixed(2);
        let erschuetterungZustand = 'OK';

        if (i > 0 && i === Math.floor(ANZAHL_LOG_EINTRAGE / 2) + 1) { 
            switch (transportProfil) {
                case 'TEMP_HOCH':
                    tempWert = TEMP_ALARM_HOCH + Math.random() * 2;
                    tempZustand = 'ALARM';
                    break;
                case 'TEMP_NIEDRIG':
                    tempWert = TEMP_ALARM_NIEDRIG - Math.random() * 2;
                    tempZustand = 'ALARM';
                    break;
                case 'ERSCHUETTERUNG':
                    erschuetterungWert = (ERSCHUETTERUNG_ALARM_G + Math.random() * 0.5).toFixed(2);
                    erschuetterungZustand = 'ALARM';
                    break;
            }
        }
        logs.push({
            zeitstempel: zeitpunkt.toISOString(),
            parametertyp: 'Temperatur',
            wert: tempWert.toFixed(1),
            einheit: 'GradC',
            zustand: tempZustand,
        });
        logs.push({
            zeitstempel: new Date(zeitpunkt.getTime() + 600000).toISOString(),
            parametertyp: 'Erschuetterung',
            wert: erschuetterungWert,
            einheit: 'g',
            zustand: erschuetterungZustand,
        });
    }
    logs.sort((a, b) => new Date(a.zeitstempel) - new Date(b.zeitstempel));
    return logs;
}

async function main() {
    if (process.argv.length < 4) {
        console.error("FEHLER DPP ID und Transportprofil angeben");
        process.exit(1);
    }
    const dppId = process.argv[2];
    const transportProfil = process.argv[3].toUpperCase();
    const valideProfile = ["NORMAL", "TEMP_HOCH", "TEMP_NIEDRIG", "ERSCHUETTERUNG"];

    if (!valideProfile.includes(transportProfil)) {
        console.error(`FEHLER Ungueltiges Profil '${transportProfil}'.`);
        process.exit(1);
    }

    console.log(`TRANSPORT-SIM Generiere Logs DPP ${dppId}, Profil ${transportProfil}`);
    const transportLogs = generiereTransportLogs(dppId, transportProfil);

    let csvInhalt = "zeitstempel,parametertyp,wert,einheit,zustand\n";
    transportLogs.forEach(log => {
        csvInhalt += `${log.zeitstempel},${log.parametertyp},${log.wert},${log.einheit},${log.zustand}\n`;
    });

    const zeitstempelDateiTeil = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const ausgabeDateiname = `${dppId}_TRANSPORT_${transportProfil}_${zeitstempelDateiTeil}.csv`;
    const ausgabePfad = path.join(offChainLogVerzeichnis, ausgabeDateiname);

    try {
        fs.writeFileSync(ausgabePfad, csvInhalt);
        console.log(`RAW_FILE_PATH=${ausgabePfad}`);
    } catch (err) {
        console.error(`Fehler Schreiben Transport-Log Datei ${err}`);
        process.exit(1);
    }
}

main();