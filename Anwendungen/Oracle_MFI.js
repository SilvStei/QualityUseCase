'use strict';


//Benötigt
const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { ArgumentParser } = require('argparse');
const fabricUtils = require('./fabricUtils.js');
const crypto = require('crypto');


//Konsolenargumente lesen und bearbeiten
function parseArgumente() {
    const parser = new ArgumentParser({
        description: 'Sensordaten verarbeiten und hashen'
    });
    parser.add_argument('--dpp', { required: true });
    parser.add_argument('--datei', { required: true });
    parser.add_argument('--test', { required: true });
    parser.add_argument('--org', { required: true });
    parser.add_argument('--gln', { required: true });
    parser.add_argument('--system', { required: true });
    parser.add_argument('--zustaendig', { default: 'Autom Prozessüberwachung' });
    parser.add_argument('--grenze_niedrig', { type: 'float', required: false });
    parser.add_argument('--grenze_hoch', { type: 'float', required: false });
    parser.add_argument('--wert_erwartet', { type: 'str', required: false });
    parser.add_argument('--einheit', { required: false, default: "" });
    return parser.parse_args();
}



async function main() {


    const args = parseArgumente();
console.log(`Oracle verarbeitet Test '${args.test}' für DPP ${args.dpp}`);

    let gateway;


    try {

        //Schauen ob Datei existiert
        if (!fs.existsSync(args.datei)) {
            throw new Error(`Sensorlog nicht gefunden ${args.datei}`);
        }

        const dateiInhalt = fs.readFileSync(args.datei, 'utf8');

        //Hash erzeugen um Unveränderlichkeit bezeugen zu können
		const dateiHash = crypto.createHash('sha256').update(dateiInhalt).digest('hex');

        //Leerzeichen entfernen und zeilenweise Strings
        const zeilen = dateiInhalt.trim().split('\n');

        if (zeilen.length <= 1) {
            throw new Error(`Keine Daten in Datei ${args.datei}`);
        }

        //Leerzeichen entfernen und zeilenweise Strings
        const kopfzeile = zeilen.shift().toLowerCase().split(',');
        //nach mfi_wert schauen
        const wertIndex = kopfzeile.indexOf('mfi_wert');


        if (wertIndex === -1) {
            throw new Error("mfi_wert nicht in gefunden");
        }

        //Mfi Werte aus den einzelnen Zeilen holen
        const messwerte = [];
        for (const zeile of zeilen) {
            const spaltenInDieserZeile = zeile.split(',');
            const textWert = spaltenInDieserZeile[wertIndex];
            const numerischerWert = parseFloat(textWert);
            if (!isNaN(numerischerWert)) {
                messwerte.push(numerischerWert);
            }
        }
        if (messwerte.length === 0) {
            throw new Error("Keine numerischen Werte in Datei");
        }

        //Messwerte addieren
        let summe = 0;
        for (const zahl of messwerte) {
            summe += zahl;
        }

        //Zahlen runden und einheitlich auf zwei Nachkommastellen bringen
        let ungerundDurchschnitt = summe / messwerte.length;
        let gerundeterDurchschnitt = ungerundDurchschnitt.toFixed(2);
        const durchschnitt = parseFloat(gerundeterDurchschnitt);


        let bewertungsergebnisClient = "";
        let kommentarClient = `Durchschnitt der ${messwerte.length} Messungen ist ${durchschnitt}`;
        const ergebnisFuerChaincode = String(durchschnitt);
        const einheitFuerChaincode = args.einheit || "";

        //Schauen ob Grenzwerte zahlen sind
        let bewertungsText = `Ergebnis: ${durchschnitt} ${args.einheit}.`;
        if (typeof args.grenze_niedrig === 'number' && typeof args.grenze_hoch === 'number') {
            //Schauen ob außerhalb Grenzwerte
            if (durchschnitt < args.grenze_niedrig || durchschnitt > args.grenze_hoch) {
                console.log(`   Durchschnitt ${durchschnitt} ausserhalb Grenzen (${args.grenze_niedrig}-${args.grenze_hoch})`);
            } else {
                console.log(`   Durchschnitt ${durchschnitt} innerhalb Grenzen (${args.grenze_niedrig}-${args.grenze_hoch})`);
            }

        console.log(bewertungsText);

        //Schauen ob überhaupt Wert mitgeliefert
        } else if (args.wert_erwartet) {
            const einzelwert = String(messwerte[0]);
            if (einzelwert.toLowerCase() === args.wert_erwartet.toLowerCase()) {
                console.log(`   Wert "${einzelwert}" entspricht der Erwartung`);
            } else {
                console.log(`   Wert "${einzelwert}" entspricht nicht der Erwartung "${args.wert_erwartet}"`);
            }
        }

    

        const orgKurzName = args.org.replace('MSP', '');

        //Connection Profil holen
        const ccpPfad = fabricUtils.holeCcpPfad(args.org, __dirname);
        if (!fs.existsSync(ccpPfad)) throw new Error(`CCP ${ccpPfad} nicht gefunden`);
        //Nutzbar machen
        const ccp = JSON.parse(fs.readFileSync(ccpPfad, 'utf8'));

        //OrgX muss großgeschrieben sein, sonst Fehler - deshalb ersten Buchstaben groß
        const orgCcpName = orgKurzName.charAt(0).toUpperCase() + orgKurzName.slice(1);


        if (!ccp.organizations[orgCcpName] || !ccp.organizations[orgCcpName].certificateAuthorities || ccp.organizations[orgCcpName].certificateAuthorities.length === 0) {
            throw new Error(`Keine CAs für ${orgCcpName} in ${ccpPfad}`);
        }

        //Name der CA holen
        const caNameAusCcp = ccp.organizations[orgCcpName].certificateAuthorities[0];
        //Informationen spezifischer CA holen
        const caInfo = ccp.certificateAuthorities[caNameAusCcp];
        if (!caInfo) throw new Error(`CA ${caNameAusCcp} nicht in ${ccpPfad}`);

        //CA Client erstellen, verify: false da sonst Fehler
        const caClient = new FabricCAServices(caInfo.url, { trustedRoots: caInfo.tlsCACerts.pem, verify: false }, caInfo.caName);

        //Informationen holen
        const walletPfad = fabricUtils.holeWalletPfad(args.org, __dirname);
        const wallet = await Wallets.newFileSystemWallet(walletPfad);
        const adminUserId = `admin${orgKurzName}`;
        const appUserId = `appUser${orgKurzName}_Integration`;

        //Admin und Benutzer erstellen
        await fabricUtils.erstelleAdmin(wallet, caClient, args.org, adminUserId, orgKurzName);
        await fabricUtils.erstelleBenutzer(wallet, caClient, args.org, appUserId, adminUserId, `${orgKurzName.toLowerCase()}.department1`, orgKurzName);

        //Verbindung mit Gateway herstellen
        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: appUserId,
            discovery: { enabled: true, asLocalhost: true }
        });

        //Channel und Contract
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality');

        //Infromationen zu Qualität zusammenstellen
        const qualitaetsDatenEintrag = {
            standardName: args.test,
            ergebnis: ergebnisFuerChaincode,
            einheit: einheitFuerChaincode,
            systemId: args.system,
            zustaendiger: args.zustaendig,
            offChainProtokoll: args.datei, 
            dateiHash: dateiHash, 
            bewertungsergebnis: bewertungsergebnisClient,
            kommentarBewertung: kommentarClient,
        };

        //Umwandeln in String
        const qualitaetsDatenJSON = JSON.stringify(qualitaetsDatenEintrag);

        //Ausgabe
        console.log(`Übermittle Testergebnis an Blockchain`);

        //Datein in Blockchain schreiben
        await contract.submitTransaction('AufzeichnenTestergebnisse', args.dpp, qualitaetsDatenJSON, args.gln);

        //Dpp auslesen bzw. überprüfen
        const dppBytes = await contract.evaluateTransaction('DPPAbfragen', args.dpp);
        //Nutzbare Var erstellen
        const aktualisierterDpp = JSON.parse(dppBytes.toString());
        console.log(`Neuer Status des DPP: ${aktualisierterDpp.status}`);


        if (aktualisierterDpp.status === "Gesperrt") {
            console.error("DPP wurde blockiert!");
        } else if (aktualisierterDpp.status === "FreigegebenMitFehler") {
            console.warn(`DPP hat Fehler ${aktualisierterDpp.status}`);
        }

    } catch (error) {
        console.error(`Fehler in Skript: ${error.message || error}`);
        process.exit(1);

        
    } finally {
        if (gateway) {
            await gateway.disconnect();
        }
    }
}

main();