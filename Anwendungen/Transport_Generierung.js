'use strict';

const fs = require('fs');
const path = require('path');


//Grenzwerte festlegen

const anzahlLogEintraege = 5; 
const tempNormalMin = 5.0;
const tempNormalMax= 30.0;
const tempAlarmHoch = 35.1;  
const tempAlarmNiedrig = -0.1; 
const erschuettNormalMax= 0.8;
const erschuettAlarm = 1.1; 


//Verzeichnis erstellen
const offChainLogVerzeichnis = path.join(__dirname, 'offchain_transport_logs');
if (!fs.existsSync(offChainLogVerzeichnis)) {
    fs.mkdirSync(offChainLogVerzeichnis, { recursive: true });
}


//Sensorwerte simulieren
function generiereTransportLogs(dppId, transportProfil) {
    const logs = [];
    const startZeit = new Date();


    for (let i = 0; i < anzahlLogEintraege; i++) {
        //Messdaten jede Sekunde
        const zeitpunkt = new Date(startZeit.getTime() + i * 1000);

        //Normale Temperatur festlegen
        let tempWert = tempNormalMin + Math.random() * (tempNormalMax - tempNormalMin);
        let tempZustand = 'OK';

        //Feuchtigkeitsmessung
        logs.push({
            zeitstempel: new Date(zeitpunkt.getTime()).toISOString(), 
            parametertyp: 'Relative Feuchtigkeit',
            wert: (40 + Math.random() * 15).toFixed(1),
            einheit: '%',
            zustand: 'OK',
        });

        //Erschütterungswert festlegen
        let erschuetterungWert = (Math.random() * erschuettNormalMax).toFixed(2);
        let erschuetterungZustand = 'OK';

        //Fehler nur bei zweitem und drittem Alarm
        if (i === 1 || i === 2) {
        if (transportProfil === 'TEMP_HOCH') {
        tempWert = tempAlarmHoch + Math.random() * 2;
        tempZustand = 'ALARM';
        } else if (transportProfil === 'TEMP_NIEDRIG') {
        tempWert = tempAlarmNiedrig - Math.random() * 2;
        tempZustand = 'ALARM';
        } else if (transportProfil === 'ERSCHUETTERUNG') {
        erschuetterungWert = (erschuettAlarm + Math.random() * 0.5).toFixed(2);
        erschuetterungZustand = 'ALARM';
        }
        }

        //Temperatur Logs erstellen
        logs.push({
            zeitstempel: zeitpunkt.toISOString(),
            parametertyp: 'Temperatur',
            wert: tempWert.toFixed(1),
            einheit: '°C',
            zustand: tempZustand,
        });

        //Erschütterung Logs erstellen
        logs.push({
            zeitstempel: new Date(zeitpunkt.getTime() + 600000).toISOString(),
            parametertyp: 'Erschütterung',
            wert: erschuetterungWert,
            einheit: 'g',
            zustand: erschuetterungZustand,
        });
    }

}



async function main() {
    //Argumente überprüfen
    if (process.argv.length < 4) {
        console.error("DPP ID und Transportprofil müssen angegeben werden");
        process.exit(1);
    }

    //Dpp Id holen
    const dppId = process.argv[2];
    //Transportprofil holen
    const transportProfil = process.argv[3].toUpperCase();

    const profilChecken = ["NORMAL", "TEMP_HOCH", "TEMP_NIEDRIG", "ERSCHUETTERUNG"];

    if (!profilChecken.includes(transportProfil)) {
        console.error(`Ungültiges Profil '${transportProfil}'`);
        process.exit(1);
    }

    //Eigentliche Logs generieren
    console.log(`Generiere Logs für DPP ${dppId}, Profil ${transportProfil}`);
    const transportLogs = generiereTransportLogs(dppId, transportProfil);

    //Struktur für CSV festlegen
    let csvInhalt = "zeitstempel,parametertyp,wert,einheit,zustand\n";
    transportLogs.forEach(log => {
        csvInhalt += `${log.zeitstempel},${log.parametertyp},${log.wert},${log.einheit},${log.zustand}\n`;
    });

    //Informationen für Datei erstellen
    const zeitstempelDateiTeil = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const ausgabeDateiname = `${dppId}_TRANSPORT_${transportProfil}_${zeitstempelDateiTeil}.csv`;
    const ausgabePfad = path.join(offChainLogVerzeichnis, ausgabeDateiname);

    //Datei schreiben
    try {
        fs.writeFileSync(ausgabePfad, csvInhalt);
        console.log(`RAW_FILE_PATH=${ausgabePfad}`);
    } catch (err) {
        console.error(`Fehler beim Schreiben der Datei ${err}`);
        process.exit(1);
    }
}

main();