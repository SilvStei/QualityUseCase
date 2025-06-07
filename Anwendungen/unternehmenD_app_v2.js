'use strict';


//notwendige Sachen festlegen
const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const fabricUtils = require('./fabricUtils.js');

//connection-Datei finden
const ccpPfadOrg4 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org4.example.com',
    'connection-org4.json'
);



const walletPfadOrgD = path.join(__dirname, 'walletD');
const mspIdOrg4 = 'Org4MSP';
const caName4 = 'ca.org4.example.com';
const adminIdOrg4 = 'adminOrg4';
const appBenutzerIdOrg4 = 'appUserOrg4D';
const glnOrgD = '4011111000009';

async function main() {
    let gateway;
    try {

        //Dpp aus Command
        const dppIdVonC = process.argv[2];
        if (!dppIdVonC || !dppIdVonC.startsWith('DPP_C_')) {
            console.error("DPP ID von C als Argument angeben");
            process.exit(1);
        }


        console.log(`Verarbeiten von ${dppIdVonC}`);


         //Lesen Connection Profil und umwandeln
        const ccp = JSON.parse(fs.readFileSync(ccpPfadOrg4, 'utf8'));
        const caInfo = ccp.certificateAuthorities[caName4];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA ${caName4} oder Zertifikate nicht in Verbindungsprofil gefunden`);
        }
        const caTLSCACerts = caInfo.tlsCACerts.pem;

        //Aufruf um CA zu erstellen
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);


        //Wallet anlegen
        const wallet = await Wallets.newFileSystemWallet(walletPfadOrgD);
        console.log(`Wallet Pfad D ${walletPfadOrgD}`);

        //Admin und Benutzer erstellen
        await fabricUtils.erstelleAdmin(wallet, ca, mspIdOrg4, adminIdOrg4, 'D');
        await fabricUtils.erstelleBenutzer(wallet, ca, mspIdOrg4, appBenutzerIdOrg4, adminIdOrg4, 'org4.department1', 'D');


        //Verbindung zum eigentlichen Netzwerk herstellen
        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet, identity: appBenutzerIdOrg4, discovery: { enabled: true, asLocalhost: true }
        });

        //Channel und Contract abrufen
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality');


        //Empfang bestätigen
        console.log(`${dppIdVonC} empfangen`);
        let dpp = await fabricUtils.abfrageUndLogDPP(contract, dppIdVonC, `Status ${dppIdVonC} bei Ankunft`, true);


        
        const erwarteterStatusPrefix = `TransportZu_${mspIdOrg4}`;
        if (dpp.ownerOrg !== mspIdOrg4 || !dpp.status.startsWith(erwarteterStatusPrefix)) {
            throw new Error(`${dppIdVonC} nicht korrekt an ${mspIdOrg4} transferiert; Besitzer ist ${dpp.ownerOrg} mit Status ${dpp.status}`);
        }


        console.log(`${dppIdVonC} an ${mspIdOrg4} unterwegs`);


        //Transportdaten überprüfen
        let transportProblemeFestgestellt = false;

        //Schauen ob Transportdaten vorliegen
        if (dpp.verankerteTransportLogs && dpp.verankerteTransportLogs.length > 0) {
            console.log(`Transportdaten zu ${dppIdVonC} empfangen`);

            //Log Einträge durchgehen
            for (let i = 0; i < dpp.verankerteTransportLogs.length; i++) {
            const logRef = dpp.verankerteTransportLogs[i]; 
            const eintragNummer = i + 1; 
            const logStatus = logRef.alarmZusammenfassung === "JA" ? "FEHLER" : "OK";

            //Einträge ausgeben
            console.log(`${eintragNummer}. Log von "${logRef.dateiPfad}": Status ist ${logStatus}`);
            

            if (logRef.alarmZusammenfassung === "JA") {
            console.warn(`Transportdatei ${eintragNummer + 1} stellt Alarm fest: (${logRef.dateiPfad})`);
            transportProblemeFestgestellt = true; 
                }
            }
        } else {
            console.log(`Keine Informationen in den Transportdaten von ${dppIdVonC}`);
        }


        if (transportProblemeFestgestellt) {
            console.warn(`Ein oder mehrere Alarme in ${dppIdVonC} festgestellt`);
        }
		
		
		//Qualitätshistorie prüfen
        console.log(`Prüfen der Qualitätshistorie von ${dppIdVonC}`);

        if (dpp.quality && dpp.quality.length > 0) {
        for (let i = 0; i < dpp.quality.length; i++) {
        const testEintrag = dpp.quality[i];
        const testNummer = i + 1;

        console.log(`${testNummer}. Qualitätstest:`);
        console.log(`   Name: ${testEintrag.standardName}`);
        console.log(`   Ergebnis: ${testEintrag.ergebnis} ${testEintrag.einheit || ''}`); 
        console.log(`   Bewertung: ${testEintrag.bewertungsergebnis || 'N/A'}`); 
        console.log(`   Durchgeführt von Organisation: ${testEintrag.durchfuehrendeOrg}`);
        console.log('\n');
         } 
        }
        else {
            console.log("Keine Qualitätseinträge im DPP");
        }

        let akzeptiereWare = true;
        let grundAblehnung = "";

        if (transportProblemeFestgestellt) {
            console.log(`Produkt ${dppIdVonC} wegen Problemen bei Transport genauer prüfen`);
        }
        const eingangspruefungErgebnisD = akzeptiereWare ? "OK" : "NICHT_OKAY";
        if (!akzeptiereWare) {
             console.log(`   Produkt wird abgelehnt, weil ${grundAblehnung}`);
        }

        console.log(`Bestätige Empfang von ${dppIdVonC}`);
        await contract.submitTransaction(
            'empfangBestaetigen',
            dppIdVonC,
            glnOrgD,
            eingangspruefungErgebnisD 
        );
        console.log(`Empfang des DPP ${dppIdVonC} durch D verarbeitet mit dem Ergebnis ${eingangspruefungErgebnisD}`);
        
        //Nochmal den finalen Status abfragen
        const finalerDppBeiD = await fabricUtils.abfrageUndLogDPP(contract, dppIdVonC, `Finaler Zustand des DPP ${dppIdVonC} bei D`, true);
        console.log(`Inhalt nach Annahme ${dppIdVonC}`, JSON.stringify(finalerDppBeiD, null, 2));

    } catch (error) {
        console.error(`Fehler in Skript: ${error.message || error}`);
        process.exit(1);


    } finally {
        if (gateway) {
            await fabricUtils.trenneGateway(gateway);
        }
    }
}

if (require.main === module) {
    main();
}