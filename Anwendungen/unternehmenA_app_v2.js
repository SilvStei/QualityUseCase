'use strict';

//notwendige Sachen festlegen
const {Gateway, Wallets} = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const {execSync} = require('child_process');
const fabricUtils = require('./fabricUtils.js');


//connection-org1 Datei finden
const ccpPathOrg1 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org1.example.com',
    'connection-org1.json'
);


const walletPathOrgA = path.join(__dirname, 'walletA');
const mspIdOrg1 = 'Org1MSP';
const caName1 = 'ca.org1.example.com';
const adminIdOrg1 = 'adminOrg1';
const appBenutzerIdOrg1 = 'appUserOrg1A';

const produktTypIdA = 'Polypropylen_A1';
//Berechnet mit https://www.gs1-germany.de/produkte-services/pruefziffernrechner/
const glnOrgA = '0000000000017';
const chargeAPrefix = 'CHARGE_A_';
const gs1FirmenPrefixA = '9999991';
//const gs1ArtikelRefA = '000001';

const mfiTestNameKonst = "Schmelzflussindex";
const visTestNameKonst = "Visuelle Prüfung der Granulatfarbe";
const dichteTestNameKonst = "Dichtetest A1";


//Array um Qualitätsgrenzen festzulegen
const spezifikationenA = [
    { name: mfiTestNameKonst, istNumerisch: true, grenzeNiedrig: 10.0, grenzeHoch: 15.0, einheit: "g/10 min", benoetigt: true },
    { name: visTestNameKonst, istNumerisch: false, wertErwartet: "OK", einheit: "", benoetigt: true },
    { name: dichteTestNameKonst, istNumerisch: true, grenzeNiedrig: 0.89, grenzeHoch: 0.92, einheit: "g/cm3", benoetigt: false }
];

//Mfi Test aus Array suchen
const mfiSpezifikationenA = spezifikationenA.find(s => s.name === mfiTestNameKonst);

async function main() {

    let gateway;
    let istDppGesperrt = false;
    try {

        //Lesen Connection Profil und umwandeln
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg1, 'utf8'));
        //CA auslesen
        const caInfo = ccp.certificateAuthorities[caName1];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA ${caName1} oder TLS Zertifikate nicht im Verbindungsprofil gefunden`);
        }

        const caTLSCACerts = caInfo.tlsCACerts.pem;

        //Aufruf um CA zu erstellen 
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        //Wallet erzeugen
        const wallet = await Wallets.newFileSystemWallet(walletPathOrgA);
        // Admin anlegen
        await fabricUtils.erstelleAdmin(wallet, ca, mspIdOrg1, adminIdOrg1, 'A');
        //Benutzer anlegen
        await fabricUtils.erstelleBenutzer(wallet, ca, mspIdOrg1, appBenutzerIdOrg1, adminIdOrg1, 'org1.department1', 'A');
        
        //Verbindung zum eigentlichen Netzwerk herstellen
        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: appBenutzerIdOrg1,
            discovery: { enabled: true, asLocalhost: true }
        });

        //auf Kanel im Netzwerk zugreifen
        const network = await gateway.getNetwork('mychannel');
        //auf chaincode im Kanal zugreifen
        const contract = network.getContract('dpp_quality');







        //eindeutige Kennzeichnugen festlegen
        const dppIdA = `DPP_A_005`;
        const chargeA = `Charge_A_005`;
        const gs1IdA = `urn:epc:id:sgtin:0000001.000001.000001`;

        console.log(`DPP ${dppIdA} erstellen für Produkt ${produktTypIdA}`);

        //Dpp auf der Blockchain erstellen
        await contract.submitTransaction(
            'ErstellenDPP',
            dppIdA,
            gs1IdA,
            produktTypIdA,
            glnOrgA,
            chargeA,
            new Date().toISOString().split('T')[0],
            JSON.stringify(spezifikationenA)
        );


        console.log(`DPP ${dppIdA} ist angelegt mit GS1 ${gs1IdA}`);

        //Informationen zu DPP anzeigen
        await fabricUtils.abfrageUndLogDPP(contract, dppIdA,``);

        //Sensordaten simulieren
        const sensorQualitaetProfil = "GUT";
        console.log(`Starten des simulierten Inline-MFI-Sensors mit Profil ${sensorQualitaetProfil} für DPP ${dppIdA}`);

        let pfadRohdaten;
        try {
            const generateCmd = `node MFI_Generierung.js ${dppIdA} ${sensorQualitaetProfil}`;

            //Skript aufrufen und in Var umleiten
            const generateOutput = execSync(generateCmd, { encoding: 'utf8', stdio: 'pipe' });
            console.log(generateOutput);

            //Suchen nach dem Pfad der Sensordatei in Var
            const ergebnisSuche = generateOutput.match(/RAW_FILE_PATH=(.*)/);
            if (ergebnisSuche && ergebnisSuche[1]) {
                //Leerzeichen entfernen sonst gabs warum auch immer Fehler
                pfadRohdaten = ergebnisSuche[1].trim();
            } else {
                throw new Error("Konnte Sensordatei nicht finden");
            }
        } catch (e) {
            console.error("Fehler bei MFI_Generierung.js", e.message);
            throw e;
        }

        try {
            if (!mfiSpezifikationenA) {
                throw new Error(`MFI Spezifikationen für Test '${mfiTestNameKonst}' nicht gefunden.`);
            }

            //Oracle aufrufen und Informationen übergeben
            const aufrufOracleSkript = `node Oracle_MFI.js \
                --dpp ${dppIdA} \
                --datei "${pfadRohdaten}" \
                --test "${mfiTestNameKonst}" \
                --org ${mspIdOrg1} \
                --gln ${glnOrgA} \
                --system "Sensor MFI A1" \
                --zustaendig "Prozessüberwachung A1" \
                --grenze_niedrig ${mfiSpezifikationenA.grenzeNiedrig} \
                --grenze_hoch ${mfiSpezifikationenA.grenzeHoch} \
                --einheit "${mfiSpezifikationenA.einheit}"`;

            const outputAusgeben = execSync(aufrufOracleSkript, { encoding: 'utf8', stdio: 'pipe' });
            console.log("Ausgabe des Oracles");
            console.log(outputAusgeben);


        } catch (e) {
            console.error("Fehler beim Oracle", e.message);
            throw e;
        }
// Status nach Test prüfen
        const dppNachMfiBytes = await contract.evaluateTransaction('DPPAbfragen', dppIdA);
        const dppNachMfi = JSON.parse(dppNachMfiBytes.toString());

        if (dppNachMfi.status === 'Gesperrt') {
            console.error(`\nDPP ${dppIdA} gesperrt - Weitere Tests übersprungen`);
            istDppGesperrt = true;
        }


        //Nochmal Aufrufen
        await fabricUtils.abfrageUndLogDPP(contract, dppIdA, "");
if (!istDppGesperrt) {
        //Konstante für vis Test anlegen
        console.log(`\nAufzeichnen der Prüfung: ${visTestNameKonst}`);
        const visuellTestDatenA = {
        standardName: visTestNameKonst,
		ergebnis: "OK",
		einheit: "",
		systemId: "QMS-A",
		zustaendiger: "PrüferA",
		offChainProtokoll: "ipfs://QmSimuliert1",
		dateiHash: "", 
		};

        //Daten auf Blockchain schreiben
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdA, JSON.stringify(visuellTestDatenA), glnOrgA);
        console.log(`Daten aus QMS erfolgreich übermittelt`);
        await fabricUtils.abfrageUndLogDPP(contract, dppIdA, ``);
    }

    if (!istDppGesperrt) {

        console.log(`\nAufzeichnen Laborergebnis: ${dichteTestNameKonst}`);

        //Konstante für Dichteergebnisse
        const dichteTestDatenA = {
		standardName: dichteTestNameKonst,
		ergebnis: "0.91",
		einheit: "g/cm3",
		systemId: "LIMS Gerät 1",
		zustaendiger: "Anlage 1",
		offChainProtokoll: "", 
		dateiHash: "",       
		};

        //Testergebnisse schreiben
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdA, JSON.stringify(dichteTestDatenA), glnOrgA);
        console.log(`Daten aus LIMS erfolgreich übermittelt`);

    }

        const dppFinal = await fabricUtils.abfrageUndLogDPP(contract, dppIdA, ``);


        //Ausgabe aller Ergebnisse, mit 2 sonst nicht gut lesbar
        console.log(`Inhalt von ${dppIdA} vor Transfer`, JSON.stringify(dppFinal, null, 2));

        if (dppFinal.status === "Freigegeben" || dppFinal.status === "FreigegebenMitFehler") {
            const zielOrgC_MSP = 'Org3MSP';
            console.log(`Senden des DPP ${dppIdA} von ${mspIdOrg1} an ${zielOrgC_MSP}`);
            await contract.submitTransaction('DPPUebertragen', dppIdA, zielOrgC_MSP, glnOrgA);
            await fabricUtils.abfrageUndLogDPP(contract, dppIdA, "Finaler Status");
        } else {
            console.error(`DPP ${dppIdA} hat Status ${dppFinal.status} und kann nicht transferiert werden`);
        }

        console.log(`DPP-ID für A: ${dppIdA}`);

    } catch (error) {
        console.error(`Fehler in Skript: ${error.message || error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await fabricUtils.trenneGateway(gateway);
        }
    }
}

main();