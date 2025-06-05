'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const fabricUtils = require('./fabricUtils.js');

const ccpPfadOrg3 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org3.example.com',
    'connection-org3.json'
);
const walletPfadOrgC = path.join(__dirname, 'walletC');
const MSP_ID_ORG3 = 'Org3MSP';
const CA_NAME_ORG3 = 'ca.org3.example.com';
const ADMIN_ID_ORG3 = 'adminOrg3';
const APP_USER_ID_ORG3 = 'appUserOrg3C';

const PRODUKT_TYP_ID_C = 'PP_GF_COMPOUND_30';
const GLN_ORG_C = '4077777000005';
const CHARGE_C_PREFIX = 'CHARGE_C_COMPOUND_';
const GS1_FIRMEN_PREFIX_C = '4077777';
const GS1_ARTIKEL_REF_C = '056789';

const COMPOUND_DICHTE_TEST_NAME = "Compound Dichte";
const COMPOUND_ZUGFESTIGKEIT_TEST_NAME = "Compound Zugfestigkeit";
const COMPOUND_FARBE_TEST_NAME = "Compound Farbe";

const SPEZIFIKATIONEN_C = [
    { name: COMPOUND_DICHTE_TEST_NAME, istNumerisch: true, grenzeNiedrig: 1.05, grenzeHoch: 1.15, einheit: "g/cm3", benoetigt: true },
    { name: COMPOUND_ZUGFESTIGKEIT_TEST_NAME, istNumerisch: true, grenzeNiedrig: 50, grenzeHoch: 65, einheit: "MPa", benoetigt: true },
    { name: COMPOUND_FARBE_TEST_NAME, istNumerisch: false, wertErwartet: "Grau-Schwarz", einheit: "", benoetigt: true }
];

async function main() {
    let gateway;
    try {
        const dppIdVonA = process.argv[2];
        const dppIdVonB = process.argv[3];
        const transportProfilArg = process.argv[4] ? process.argv[4].toUpperCase() : "NORMAL";
        const valideTransportProfile = ["NORMAL", "TEMP_HOCH", "TEMP_NIEDRIG", "ERSCHUETTERUNG"];

        if (!dppIdVonA || !dppIdVonB) {
            console.error("FEHLER DPP IDs von A und B als Argumente angeben!");
            console.error("Aufruf z.B. node unternehmenC_app.js <DPP_ID_A> <DPP_ID_B> [TRANSPORT_PROFIL]");
            process.exit(1);
        }
        if (!valideTransportProfile.includes(transportProfilArg)) {
            console.error(`FEHLER Ungueltiges Profil '${transportProfilArg}'. Waehle ${valideTransportProfile.join('|')}`);
            process.exit(1);
        }
        console.log(`Transportprofil C -> D ${transportProfilArg}`);
        console.log(`Input DPP von A ${dppIdVonA}`);
        console.log(`Input DPP von B ${dppIdVonB}`);

        const ccp = JSON.parse(fs.readFileSync(ccpPfadOrg3, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG3];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA ${CA_NAME_ORG3} oder Zertifikate nicht in Verbindungsprofil gefunden`);
        }
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPfadOrgC);
        console.log(`Wallet Pfad C ${walletPfadOrgC}`);
        await fabricUtils.erstelleAdmin(wallet, ca, MSP_ID_ORG3, ADMIN_ID_ORG3, 'C');
        await fabricUtils.erstelleBenutzer(wallet, ca, MSP_ID_ORG3, APP_USER_ID_ORG3, ADMIN_ID_ORG3, 'org3.department1', 'C');

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: APP_USER_ID_ORG3,
            discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality');

        console.log(`\n--> C Empfange DPPs von A und B`);
        const inputDPPIDs = [dppIdVonA, dppIdVonB];
        for (const inputDppId of inputDPPIDs) {
            console.log(`\n---> C Bearbeite eingehenden DPP ${inputDppId}`);
            await fabricUtils.abfrageUndLogDPP(contract, inputDppId, `Status ${inputDppId} (vor Empfang C)`, true);
            
            const eingangspruefungErgebnis = "OK"; 
            console.log(`---> C EmpfangBestaetigenUndPruefungAufzeichnen fuer ${inputDppId} Ergebnis ${eingangspruefungErgebnis}`);
            await contract.submitTransaction('EmpfangBestaetigenUndPruefungAufzeichnen', inputDppId, GLN_ORG_C, eingangspruefungErgebnis);
            console.log(`Empfang DPP ${inputDppId} durch C bestaetigt`);
            await fabricUtils.abfrageUndLogDPP(contract, inputDppId, `Status ${inputDppId} (nach Empfang C)`, true);
        }

        const uniqueIdPartC = Date.now();
        const dppIdC = `DPP_C_${uniqueIdPartC}`;
        const chargeC = `${CHARGE_C_PREFIX}${new Date().toISOString().slice(5, 10).replace('-', '')}`;
        const gs1KeyC = `urn:epc:id:sgtin:${GS1_FIRMEN_PREFIX_C}.${GS1_ARTIKEL_REF_C}.${uniqueIdPartC % 100000}`;
        
        const initialesCompoundTestergebnis = {
            standardName: COMPOUND_DICHTE_TEST_NAME, 
            ergebnis: "1.09", 
            einheit: "g/cm3",
            systemId: "INITIAL_COMPOUND_QA", 
            zustaendiger: "PrüferC",
			offChainProtokoll: "", 
			dateiHash: "",      
        };
        console.log(`\n--> C TransformationAufzeichnen Erzeuge DPP ${dppIdC}`);
        await contract.submitTransaction(
            'TransformationAufzeichnen', 
            dppIdC, 
            gs1KeyC, 
            PRODUKT_TYP_ID_C, 
            GLN_ORG_C, 
            chargeC, 
            new Date().toISOString().split('T')[0], 
            JSON.stringify(inputDPPIDs),
            JSON.stringify(SPEZIFIKATIONEN_C), 
            JSON.stringify(initialesCompoundTestergebnis)
        );
        console.log(`Compound-DPP ${dppIdC} (GS1 ${gs1KeyC}) erstellt`);
        await fabricUtils.abfrageUndLogDPP(contract, dppIdC, `Initial Status Compound DPP ${dppIdC}`, true);

        console.log(`\n--> C AufzeichnenTestergebnisse (${COMPOUND_ZUGFESTIGKEIT_TEST_NAME}) DPP ${dppIdC}`);
        const zugfestigkeitTestDatenC = { 
            standardName: COMPOUND_ZUGFESTIGKEIT_TEST_NAME, 
            ergebnis: "58", 
            einheit: "MPa", 
            systemId: "Mechanik-System",
            zustaendiger: "PrüferC",
			offChainProtokoll: "", 
			dateiHash: "",        
        };
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdC, JSON.stringify(zugfestigkeitTestDatenC), GLN_ORG_C);
        console.log(`Zugfestigkeits-Daten gespeichert`);
        await fabricUtils.abfrageUndLogDPP(contract, dppIdC, `Status Compound DPP ${dppIdC} nach Zugfestigkeit`, true);

        console.log(`\n--> C AufzeichnenTestergebnisse (${COMPOUND_FARBE_TEST_NAME}) DPP ${dppIdC}`);
        const farbTestDatenC = { 
            standardName: COMPOUND_FARBE_TEST_NAME, 
            ergebnis: "Grau-Schwarz", 
            einheit: "", 
            systemId: "QMS_Visuell",
            zustaendiger: "PrüferC",
			offChainProtokoll: "", 
			dateiHash: "",     
        };
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdC, JSON.stringify(farbTestDatenC), GLN_ORG_C);
        console.log(`Farb-Daten gespeichert`);
		console.log(`\n--> C AufzeichnenTestergebnisse (${COMPOUND_DICHTE_TEST_NAME}) DPP ${dppIdC}`);
		const dichteTestDatenC = {
		standardName: COMPOUND_DICHTE_TEST_NAME,
		ergebnis: "1.09",          // aktueller Messwert eintragen
		einheit: "g/cm3",
		systemId: "FINAL_COMPOUND_QA",
		zustaendiger: "PrüferC",
		offChainProtokoll: "",
		dateiHash: ""
		};
		await contract.submitTransaction(
		'AufzeichnenTestergebnisse',
		dppIdC,
		JSON.stringify(dichteTestDatenC),
		GLN_ORG_C
		);
		console.log("Dichte-Daten gespeichert");

		let dppCObj = await fabricUtils.abfrageUndLogDPP(
		contract,
		dppIdC,
		`Status Compound DPP ${dppIdC} nach Dichte-Prüfung`,
		true
		);
        let dppCObj = await fabricUtils.abfrageUndLogDPP(contract, dppIdC, `Status Compound DPP ${dppIdC} nach Farbpruefung`, true);
        console.log(`\nCompound-DPP C ${dppIdC} vor Transport-Log\n`, JSON.stringify(dppCObj, null, 2));

        if (dppCObj.status === "Freigegeben" || dppCObj.status === "FreigegebenMitFehler") {
            const zielOrgD_MSP = 'Org4MSP';

            console.log(`\n--> C DPPUebertragen (Initial) ${dppIdC} an ${zielOrgD_MSP}`);
            await contract.submitTransaction('DPPUebertragen', dppIdC, zielOrgD_MSP, GLN_ORG_C);
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
                    --org ${MSP_ID_ORG3} \
                    --gln ${GLN_ORG_C} \
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

        console.log(`\nWICHTIG DPP ID ${dppIdC} (GS1 ${gs1KeyC}) für Unternehmen D notieren`);

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