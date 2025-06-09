'use strict';

//Benötigt
const fs = require('fs');
const path = require('path');

//Grenzen festlegen
const mfiGrenzeNiedrig = 10.0;
const mfiGrenzeHoch = 15.0;
const anzahlMessungen = 10;


//Verzeichnis erstellen
const offChainLogVerzeichnis = path.join(__dirname, 'offchain_sensor_logs');
if (!fs.existsSync(offChainLogVerzeichnis)) {
    fs.mkdirSync(offChainLogVerzeichnis, { recursive: true });
}

//Sensorwerte simulieren
function generiereMfiWert(qualitaetsProfil, index) {
    let messwert;
    const guterWert = () => mfiGrenzeNiedrig + Math.random() * (mfiGrenzeHoch - mfiGrenzeNiedrig);

     // Profil Schlecht
    if (qualitaetsProfil === "SCHLECHT") {
        // Wert über Grenze
        messwert = (mfiGrenzeHoch+ 3.0 + Math.random());
    } else {
        messwert = guterWert();
    }

    return parseFloat(messwert.toFixed(2));
}

//Argument übergeben überprüfen
async function main() {
    if (process.argv.length <4) {
        console.error("DPP und Profil GUT oder SCHLECHT angeben");
        process.exit(1);
    }

    //ID aus Arg
    const dppId = process.argv[2];
    //Profil aus Arg
    const qualitaetsProfil = process.argv[3].toUpperCase();



    if (!["GUT", "SCHLECHT"].includes(qualitaetsProfil)) {
        console.error("Ungültig, bitte GUT oder SCHLECHT wählen");
        process.exit(1);
    }


    console.log(`DPP: ${dppId}, Profil: ${qualitaetsProfil}`);
    const rohMfiMesswerte = [];
    const zeitpunktListe = [];
    const startZeit = new Date();


    for (let i =0; i < anzahlMessungen; i++) {
        //Messung jede Sekunde
        const messZeit = new Date(startZeit.getTime() + i* 1000);
        zeitpunktListe.push(messZeit.toISOString());
        rohMfiMesswerte.push(generiereMfiWert(qualitaetsProfil, i));
    }

    let csvInhalt = "zeitstempel,mfi_wert\n";
    for (let i = 0; i < anzahlMessungen; i++) {
        csvInhalt += `${zeitpunktListe[i]},${rohMfiMesswerte[i]}\n`;
    }

    const zeitstempelDateiTeil = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const ausgabeDateiname = `${dppId}_MFI_ROH_${qualitaetsProfil}_${zeitstempelDateiTeil}.csv`;
    const ausgabePfad = path.join(offChainLogVerzeichnis, ausgabeDateiname);

    try {
        fs.writeFileSync(ausgabePfad, csvInhalt);
       console.log(`RAW_FILE_PATH=${ausgabePfad}`);
    } catch (err) {
        console.error(`Fehler beim Schreiben der Datei ${err}`);
        process.exit(1);
    }
}

main();