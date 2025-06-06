'use strict';

//notwendige Sachen festlegen
const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const fabricUtils = require('./fabricUtils.js');


//connection-Datei finden
const ccpPfadOrg3 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org3.example.com',
    'connection-org3.json'
);
const walletPfadOrgC = path.join(__dirname, 'walletC');
const mspIdOrg3 = 'Org3MSP';
const caName3 = 'ca.org3.example.com';
const adminIdOrg3 = 'adminOrg3';
const appBenutzerIdOrg3 = 'appUserOrg3C';

const produktTypIdC = 'Compound PP GF30';
const glnOrgC = '4077777000005';
const chargeCPrefix = 'CHARGE_C_COMPOUND_';
const gs1FirmenPrefixC = '4077777';
const gs1ArtikelRefC = '056789';

const compoundDichteTestName = "Compound Dichte";
const compoundZugTestName = "Compound Zugfestigkeit";
const compoundFarbeTestName = "Compound Farbe";

const spezifikationenC = [
    { name: compoundDichteTestName, istNumerisch: true, grenzeNiedrig: 1.05, grenzeHoch: 1.15, einheit: "g/cm3", benoetigt: true },
    { name: compoundZugTestName, istNumerisch: true, grenzeNiedrig: 50, grenzeHoch: 65, einheit: "MPa", benoetigt: true },
    { name: compoundFarbeTestName, istNumerisch: false, wertErwartet: "Grau-Schwarz", einheit: "", benoetigt: true }
];

async function main() {
    let gateway;
    try {

        //Argumente des Aufrufs mitaufnehmen
        const dppIdVonA = process.argv[2];
        const dppIdVonB = process.argv[3];
        const transportProfilArg = process.argv[4] ? process.argv[4].toUpperCase() : "NORMAL";
        const valideTransportProfile = ["NORMAL", "TEMP_HOCH", "TEMP_NIEDRIG", "ERSCHUETTERUNG"];


        //Fehler falls falsch aufgerufen
        if (!dppIdVonA || !dppIdVonB || !valideTransportProfile.includes(transportProfilArg)) {
            console.error("Falscher Aufruf");
            console.error("node unternehmenC_app.js <DPP_ID_A> <DPP_ID_B> [TRANSPORT_PROFIL]");
            console.error(`Profile ${valideTransportProfile.join('|')}`);
            process.exit(1);
            }

         //Lesen Connection Profil und umwandeln
        const ccp = JSON.parse(fs.readFileSync(ccpPfadOrg3, 'utf8'));
        const caInfo = ccp.certificateAuthorities[caName3];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA ${caName3} oder Zertifikate nicht in Verbindungsprofil gefunden`);
        }


        const caTLSCACerts = caInfo.tlsCACerts.pem;

        //Aufruf um CA zu erstellen
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPfadOrgC);


        //Erstellen von Admin und Benutzer
        await fabricUtils.erstelleAdmin(wallet, ca, mspIdOrg3, adminIdOrg3, 'C');
        await fabricUtils.erstelleBenutzer(wallet, ca, mspIdOrg3, appBenutzerIdOrg3, adminIdOrg3, 'org3.department1', 'C');


        //Verbindung zum eigentlichen Netzwerk herstellen
        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: appBenutzerIdOrg3,
            discovery: { enabled: true, asLocalhost: true }
        });


        //Kanal und Chaincode zugreifen
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality');



        console.log(`Empfange DPPs von A und B`);
        const inputDPPIDs = [dppIdVonA, dppIdVonB];


        //Empfangene Dpp überprüfen
        for (const inputDppId of inputDPPIDs) {
            console.log(`Bearbeite eingehenden DPP ${inputDppId}`);

            await fabricUtils.abfrageUndLogDPP(contract, inputDppId, `Status ${inputDppId} vor Empfang C`, true);
            const eingangspruefungErgebnis = "OK"; 

            console.log(`${inputDppId} hat Ergebnis ${eingangspruefungErgebnis}`);
            await contract.submitTransaction('empfangBestaetigen', inputDppId, glnOrgC, eingangspruefungErgebnis);
            console.log(`Empfang des DPP ${inputDppId} durch C bestätigt`);
            await fabricUtils.abfrageUndLogDPP(contract, inputDppId, `Status ${inputDppId} nach Empfang C`, true);
        }

        const dppIdC = `DPP_C_001`;
        const chargeC = `Charge_C_001`;
        const gs1IdC = `urn:epc:id:sgtin:0000003.000003.000003`;
        
        const initialesCompoundTestergebnis = {
            standardName: compoundDichteTestName, 
            ergebnis: "1.09", 
            einheit: "g/cm3",
            systemId: "Compound Test C1", 
            zustaendiger: "PrüferC",
			offChainProtokoll: "", 
			dateiHash: "",      
        };


        console.log(`Erzeuge neuen DPP ${dppIdC} durch Transformation`);

        //Dpps Transformieren um neuen Dpp zu erschaffen
        await contract.submitTransaction(
            'dppTransformieren', 
            dppIdC, 
            gs1IdC, 
            produktTypIdC, 
            glnOrgC, 
            chargeC, 
            new Date().toISOString().split('T')[0], 
            JSON.stringify(inputDPPIDs),
            JSON.stringify(spezifikationenC), 
            JSON.stringify(initialesCompoundTestergebnis)
        );


        console.log(`Compound-DPP ${dppIdC} erstellt`);
        await fabricUtils.abfrageUndLogDPP(contract, dppIdC, `Status des Compound DPP ${dppIdC}`, true);



        console.log(`Test (${compoundZugTestName}) für DPP ${dppIdC}`);
        const zugfestigkeitTestDatenC = { 
            standardName: compoundZugTestName, 
            ergebnis: "58", 
            einheit: "MPa", 
            systemId: "Mechanik System C1",
            zustaendiger: "PrüferC",
			offChainProtokoll: "", 
			dateiHash: "",        
        };
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdC, JSON.stringify(zugfestigkeitTestDatenC), glnOrgC);
        await fabricUtils.abfrageUndLogDPP(contract, dppIdC, `Status des Compound DPP ${dppIdC} nach Zugfestigkeit`, true);

        console.log(`Test (${compoundFarbeTestName}) für DPP ${dppIdC}`);
        const farbTestDatenC = { 
            standardName: compoundFarbeTestName, 
            ergebnis: "Grau-Schwarz", 
            einheit: "", 
            systemId: "QMS C1",
            zustaendiger: "PrüferC",
			offChainProtokoll: "", 
			dateiHash: "",     
        };
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdC, JSON.stringify(farbTestDatenC), glnOrgC);
        await fabricUtils.abfrageUndLogDPP(contract, dppIdC, `Status des Compound DPP ${dppIdC} nach Farbtest`, true);


		console.log(`Test (${compoundDichteTestName}) für DPP ${dppIdC}`);
		const dichteTestDatenC = {
		standardName: compoundDichteTestName,
		ergebnis: "1.09",         
		einheit: "g/cm3",
		systemId: "Dichtessystem C1",
		zustaendiger: "PrüferC",
		offChainProtokoll: "",
		dateiHash: ""
		};
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdC, JSON.stringify(dichteTestDatenC), glnOrgC);
        let dppCObj = await fabricUtils.abfrageUndLogDPP(contract, dppIdC, `Status Compound DPP ${dppIdC} nach Dichteprüfung`, true);

        
        console.log(`\nCompound-DPP C ${dppIdC} vor Transport-Log\n`, JSON.stringify(dppCObj, null, 2));

        if (dppCObj.status === "Freigegeben" || dppCObj.status === "FreigegebenMitFehler") {
            const zielOrgD_MSP = 'Org4MSP';

            console.log(`\n--> C DPPUebertragen (Initial) ${dppIdC} an ${zielOrgD_MSP}`);
            await contract.submitTransaction('DPPUebertragen', dppIdC, zielOrgD_MSP, glnOrgC);
            console.log(`Initialer Transfer ${dppIdC} an ${zielOrgD_MSP} initiiert`);
            dppCObj = await fabricUtils.abfrageUndLogDPP(contract, dppIdC, "Nach initialem Transfer an D", true);

            console.log(`\n--> C-TRANSPORT Starte Simulation DPP ${dppIdC} (Profil ${transportProfilArg})`);
            console.log(`   1. Rufe Transport_Generierung.js auf`);
            let transportRohdatenPfad;
            try {
                const generateCmd = `node Transport_Generierung.js ${dppIdC} ${transportProfilArg}`;
                console.log(`       Befehl ${generateCmd}`);
                const generateOutput = execSync(generateCmd, { encoding: 'utf8', stdio: 'pipe' });
                console.log(generateOutput);
                const match = generateOutput.match(/RAW_FILE_PATH=(.*)/);
                if (match && match[1]) {
                    transportRohdatenPfad = match[1].trim();
                    console.log(`   Transport-Rohdaten ${transportRohdatenPfad}`);
                } else {
                    throw new Error("Konnte RAW_FILE_PATH aus Transport_Generierung.js nicht extrahieren");
                }
            } catch (e) {
                console.error("Fehler bei Transport_Generierung.js", e.message);
                throw e;
            }

            console.log(`   2. Rufe Oracle_Transport.js Datei ${transportRohdatenPfad}`);
            try {
                const submitTransportCmd = `node Oracle_Transport.js \
                    --dpp ${dppIdC} \
                    --datei "${transportRohdatenPfad}" \
                    --org ${mspIdOrg3} \
                    --gln ${glnOrgC} \
                    --system "LOGISTIK_C_TELEMATIK" \
                    --zustaendig "Logistik C-D"`;
                console.log("       Befehl", submitTransportCmd.replace(/\s+/g, ' '));
                const submitTransportOutput = execSync(submitTransportCmd, { encoding: 'utf8', stdio: 'pipe' });
                console.log(submitTransportOutput);
            } catch (e) {
                console.error("Fehler bei Oracle_Transport.js", e.message);
                console.warn("WARNUNG Transport-Update konnte nicht zum DPP hinzugefuegt werden");
            }
            
            dppCObj = await fabricUtils.abfrageUndLogDPP(contract, dppIdC, "Nach Transport-Log Integration C", true);
            console.log(`   DPP ${dppIdC} auf Weg zu ${zielOrgD_MSP} Status ${dppCObj.status}`);

        } else {
            console.error(`ACHTUNG Compound DPP ${dppIdC} Status ${dppCObj.status} NICHT transferierbar`);
        }

        console.log(`DPP-ID für A: ${dppIdC}`);

    } catch (error) {
        console.error(`C FEHLER Hauptablauf ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await fabricUtils.trenneGateway(gateway);
            console.log('\nC Gateway getrennt – Unternehmen C Demo beendet');
        }
    }
}

if (require.main === module) {
    if (process.argv.length < 4) { 
        console.error("FEHLER DPP ID von A und B als Argumente angeben!");
        console.error("Aufruf z.B. node unternehmenC_app.js <DPP_ID_A> <DPP_ID_B> [TRANSPORT_PROFIL]");
        console.error("Profile NORMAL, TEMP_HOCH, TEMP_NIEDRIG, ERSCHUETTERUNG");
        process.exit(1);
    }
    main();
}