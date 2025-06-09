'use strict';

//notwendige Sachen festlegen
const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const fabricUtils = require('./fabricUtils.js');


//connection-Datei finden
const ccpPathOrg2 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org2.example.com',
    'connection-org2.json'
);

const walletPfadB = path.join(__dirname, 'walletB');
const mspIdOrg2 = 'Org2MSP';
const caName2 = 'ca.org2.example.com';
const adminIdOrg2 = 'adminOrg2';
const appBenutzerIdOrg2 = 'appUserOrg2B';

////Berechnet mit https://www.gs1-germany.de/produkte-services/pruefziffernrechner/
const glnOrgB = '0000000000024';
const gs1FirmenPrefixB = '9999992';
const stdProduktTypB = 'Polypropylen mit Glasfaser 60%';

const glasfaserTestNameKosnt = "Glasfaser-Gewichtsanteil";
const mfiTestNameKonst_B = "Schmelzflussindex ";
const feuchteTestNameKonst = "Restfeuchte";


async function main() {
    let gateway;
    try {

        //Lesen Connection Profil und umwandeln
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg2, 'utf8'));
        const caInfo = ccp.certificateAuthorities[caName2];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA ${caName2} oder Zertifikate nicht in Verbindungsprofil gefunden`);
        }


        const caTLSCACerts = caInfo.tlsCACerts.pem;

        //Aufruf um CA zu erstellen
        const ca = new FabricCAServices(caInfo.url, {trustedRoots: caTLSCACerts, verify: false}, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPfadB);
        
        //Auch wieder Admin und Benutzer auf netzwerk anlegen
        await fabricUtils.erstelleAdmin(wallet, ca, mspIdOrg2, adminIdOrg2, 'B');
        await fabricUtils.erstelleBenutzer(wallet, ca, mspIdOrg2, appBenutzerIdOrg2, adminIdOrg2, 'org2.department1', 'B');

        //Verbindung zum eigentlichen Netzwerk herstellen
        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: appBenutzerIdOrg2,
            discovery: { enabled: true, asLocalhost: true }
        });


        //Kanal und Chaincode zugreifen
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality');

        //eindeutige Kennzeichnugen festlegen
        const dppIdB = `DPP_B_001`;
        const gs1IdB = `urn:epc:id:sgtin:0000002.000002.000002`;
        const chargeB = `Charge_B_001`

        const spezifikationenB = [
            { name: glasfaserTestNameKosnt, istNumerisch: true, grenzeNiedrig: 59.5, grenzeHoch: 60.5, einheit: 'Gew.-%', benoetigt: true },
            { name: mfiTestNameKonst_B, istNumerisch: true, grenzeNiedrig: 2.0, grenzeHoch: 5.0, einheit: 'g/10 min', benoetigt: true },
            { name: feuchteTestNameKonst, istNumerisch: true, grenzeNiedrig: 0.0, grenzeHoch: 0.05, einheit: '%', benoetigt: false }
        ];
        const spezifikationenB_JSON = JSON.stringify(spezifikationenB);

        console.log(`Dpp ${dppIdB} für Produkt ${stdProduktTypB}`);

                //Dpp auf der Blockchain erstellen
        await contract.submitTransaction(
            'ErstellenDPP',
            dppIdB,
            gs1IdB,
            stdProduktTypB,
            glnOrgB,
            chargeB,
            new Date().toISOString().split('T')[0],
            JSON.stringify(spezifikationenB)
        );
        console.log(`DPP ${dppIdB} angelegt mit GS1 ${gs1IdB})`);


        let dppStatus = await fabricUtils.abfrageUndLogDPP(contract, dppIdB, "Nach dem Erstellen");

        const testDatenGF = {
            standardName: glasfaserTestNameKosnt,
            ergebnis: '60.1',
            einheit: 'Gew.-%',
            systemId: 'Testsystem GF B1',
            zustaendiger: 'PrüferB',
			offChainProtokoll: "",
			dateiHash: "",         
        };


        console.log(`Testergebnisse aufzeichnen für DPP ${dppIdB}`);

        await contract.submitTransaction('AufzeichnenTestergebnisse',
            dppIdB,
            JSON.stringify(testDatenGF),
            glnOrgB
        );


        dppStatus = await fabricUtils.abfrageUndLogDPP(contract, dppIdB, "Nach Glasfaser-Test");

        const testDatenMfi = {
            standardName: mfiTestNameKonst_B,
            ergebnis: '3.8',
            einheit: 'g/10 min',
            systemId: 'B-MFI',
            zustaendiger: 'PrüferB',
			offChainProtokoll: "", 
			dateiHash: "",      
        };
        console.log(`Aufzeichnen der Testergebnisse für DPP ${dppIdB}`);
        await contract.submitTransaction('AufzeichnenTestergebnisse',
            dppIdB,
            JSON.stringify(testDatenMfi),
            glnOrgB
        );

        //Dpp Status festlegen
        dppStatus = await fabricUtils.abfrageUndLogDPP(contract, dppIdB, "Nach MFI-Test:");

        if(dppStatus.status === "Freigegeben") {
            console.log("Produkt hat alle Pflichtprüfungen bestanden und DPP ist freigegeben");
        }

        const dppFinal = JSON.parse((await contract.evaluateTransaction('DPPAbfragen', dppIdB)).toString());


                //Ausgabe aller Ergebnisse, mit 2 sonst nicht gut lesbar
        console.log(`${dppIdB} vor Transfer`, JSON.stringify(dppFinal, null, 2));

        if (dppFinal.status === "Freigegeben" || dppFinal.status === "FreigegebenMitFehler") {
            const zielOrgC_MSP = 'Org3MSP';
            console.log(`Senden des ${dppIdB} von ${mspIdOrg2} an ${zielOrgC_MSP}`);
            await contract.submitTransaction('DPPUebertragen', dppIdB, zielOrgC_MSP, glnOrgB);
            await fabricUtils.abfrageUndLogDPP(contract, dppIdB, "Nach Transfer an C");
        } else {
            console.error(`DPP ${dppIdB} hat Status ${dppFinal.status} und kann nicht transferiert werden`);
        }

        console.log(`DPP-ID für B: ${dppIdB}`);

    } catch (err) {
        console.error(`Fehler in unternehmenA_app_v2.js: ${error.message || error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await fabricUtils.trenneGateway(gateway);
        }
    }
}

main().catch(err => {
    console.error("Fehler in main()", err);
    process.exit(1);
});