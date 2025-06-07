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


        //Hier weitermachen
        let transportProblemeFestgestellt = false;
        if (dpp.verankerteTransportLogs && dpp.verankerteTransportLogs.length > 0) {
            console.log(`Transportdaten zu ${dppIdVonC} empfangen`);
            dpp.verankerteTransportLogs.forEach((logRef, index) => {
               console.log(`   ${index + 1}. Datei: ${logRef.dateiPfad}, Hash: ${logRef.dateiHash}, Alarm-Zusammenfassung: ${logRef.alarmZusammenfassung}, System: ${logRef.systemId || 'N/A'}`);
                if (logRef.alarmZusammenfassung === "JA") {
                console.warn(`       WARNUNG: Transport-Log-Datei ${index + 1} signalisiert einen Alarm! (${logRef.dateiPfad})`);
                transportProblemeFestgestellt = true; 
                }
            });
        } else {
            console.log(`\n---> D Keine expliziten Referenzen zu Transport-Log-Dateien im DPP ${dppIdVonC}`);
        }
        if (transportProblemeFestgestellt) {
            console.warn(`       WARNUNG: Mindestens eine Transport-Log-Datei für DPP ${dppIdVonC} signalisiert einen Alarm!`);
        }
		
		
		
        console.log(`\n---> D Pruefung Qualitaetshistorie DPP ${dppIdVonC}`);
        if (dpp.quality && dpp.quality.length > 0) {
            dpp.quality.forEach((te, index) => {
                console.log(`   ${index + 1}. Test ${te.standardName}, Ergebnis ${te.ergebnis} ${te.einheit || ''}, Bewertung ${te.bewertungsergebnis || 'N/A'}, Org ${te.durchfuehrendeOrg}`);
            });
        } else {
            console.log("   Keine expliziten Qualitaetseintraege im DPP");
        }

        let akzeptiereWare = true;
        let grundAblehnung = "";

        if (transportProblemeFestgestellt) {
            console.log(`   ENTSCHEIDUNG Ware ${dppIdVonC} wegen Transport-Problemen genauer pruefen.`);
        }
        const eingangspruefungErgebnisD = akzeptiereWare ? "OK" : "NICHT_OKAY";
        if (!akzeptiereWare) {
             console.log(`   Ware wird abgelehnt ${grundAblehnung}`);
        }

        console.log(`\n--> D empfangBestaetigen DPP ${dppIdVonC}`);
        await contract.submitTransaction(
            'empfangBestaetigen',
            dppIdVonC,
            glnOrgD,
            eingangspruefungErgebnisD 
        );
        console.log(`Empfang DPP ${dppIdVonC} durch D verarbeitet Ergebnis ${eingangspruefungErgebnisD}`);
        
        const finalerDppBeiD = await fabricUtils.abfrageUndLogDPP(contract, dppIdVonC, `Finaler Zustand DPP ${dppIdVonC} bei D`, true);
        console.log(`\nDPP-Inhalt D nach Annahme ${dppIdVonC}\n`, JSON.stringify(finalerDppBeiD, null, 2));

    } catch (error) {
        console.error(`D FEHLER ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await fabricUtils.trenneGateway(gateway);
            console.log('\nD Gateway getrennt – Unternehmen D Demo beendet');
        }
    }
}

if (require.main === module) {
    main();
}