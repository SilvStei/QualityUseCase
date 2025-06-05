// -----------------------------------------------------------------------------
// unternehmenC_app_v2.js – Compoundierer (Org3MSP = Unternehmen C)
// Empfängt DPPs von A & B, transformiert sie, fügt eigene Qualitätsdaten hinzu,
// simuliert Transportdatenaufzeichnung und transferiert den Compound-DPP an D.
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process'); // Für den Aufruf externer Skripte

// --- Pfade & Konstanten für Org3 (Unternehmen C) ---
const ccpPathOrg3 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org3.example.com',
    'connection-org3.json'
);
const walletPathOrgC = path.join(__dirname, 'walletC');
const MSP_ID_ORG3 = 'Org3MSP';
const CA_NAME_ORG3 = 'ca.org3.example.com';
const ADMIN_ID_ORG3 = 'adminOrg3';
const APP_USER_ID_ORG3 = 'appUserOrg3C';

// Produktspezifische Daten für Unternehmen C
const PRODUCT_TYPE_ID_C = 'PP_GF_COMPOUND_30'; // Polypropylen Glasfaser Compound 30%
const GLN_ORG_C = '4077777000005';             // Eindeutige GLN für Unternehmen C
const BATCH_C_PREFIX = 'BATCH_C_COMPOUND_';
const GS1_COMPANY_PREFIX_C = '4077777';
const GS1_ITEM_REF_C = '056789';

// Spezifikationen für Compound-Produkt C
const COMPOUND_DENSITY_TEST_NAME = "Compound Dichte";
const COMPOUND_TENSILE_TEST_NAME = "Compound Zugfestigkeit";
const COMPOUND_COLOR_TEST_NAME = "Compound Farbe";

const SPECIFICATIONS_C = [
    { testName: COMPOUND_DENSITY_TEST_NAME, isNumeric: true, lowerLimit: 1.05, upperLimit: 1.15, unit: "g/cm3", isMandatory: true },
    { testName: COMPOUND_TENSILE_TEST_NAME, isNumeric: true, lowerLimit: 50, upperLimit: 65, unit: "MPa", isMandatory: true },
    { testName: COMPOUND_COLOR_TEST_NAME, isNumeric: false, expectedValue: "Grau-Schwarz", unit: "", isMandatory: true }
];

// --- Hilfsfunktionen (aus unternehmenA_app_v2.js übernommen und angepasst) ---
async function checkWallet(wallet, identityLabel) {
    return await wallet.get(identityLabel);
}

async function enrollAdmin(wallet, caClient, mspId, adminUserId) {
    try {
        if (await checkWallet(wallet, adminUserId)) {
            console.log(`Admin-Benutzer "${adminUserId}" existiert bereits im Wallet C.`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminUserId, x509Identity);
        console.log(`Admin-Benutzer "${adminUserId}" erfolgreich für Wallet C registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Admin-Benutzers "${adminUserId}" für Wallet C: ${error.message}`);
        throw error;
    }
}

async function registerAndEnrollUser(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        if (await checkWallet(wallet, userId)) {
            console.log(`Benutzer "${userId}" existiert bereits im Wallet C.`);
            return;
        }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) {
            throw new Error(`Admin-Benutzer "${adminUserId}" nicht im Wallet C gefunden.`);
        }
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, adminUserId);
        const secret = await caClient.register({ affiliation, enrollmentID: userId, role: 'client' }, adminUser);
        const enrollment = await caClient.enroll({ enrollmentID: userId, enrollmentSecret: secret });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(userId, x509Identity);
        console.log(`Benutzer "${userId}" erfolgreich für Wallet C registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Benutzers "${userId}" für Wallet C: ${error.message}`);
        throw error;
    }
}

async function queryAndLogDPP(contract, dppId, contextMessage) {
    console.log(`\n--- [INFO] ${contextMessage} - Aktueller Status von ${dppId} ---`);
    const dppBytes = await contract.evaluateTransaction('QueryDPP', dppId);
    const dpp = JSON.parse(dppBytes.toString());
    console.log(`Status: ${dpp.status}, Owner: ${dpp.ownerOrg}`);
    if (dpp.openMandatoryChecks && dpp.openMandatoryChecks.length > 0) {
        console.log(`Offene mandatorische Prüfungen: ${dpp.openMandatoryChecks.join(', ')}`);
    }
    if (dpp.status === "Blocked") {
        console.error(`ACHTUNG: DPP ${dppId} ist blockiert!`);
    }
    return dpp;
}

// --- Hauptablauf ---
// ... (Anfang von unternehmenC_app_v2.js: Konstanten, Hilfsfunktionen, ...)

async function main() {
    let gateway;
    try {
        const dppIdFromA_actual = process.argv[2] || 'DPP_A_1748878242388'; // Hole ID von A
        const dppIdFromB_actual = process.argv[3] || 'DPP_B_1748878351405'; // Hole ID von B
        
        // NEU: Transportprofil für den Transport C -> D als Argument oder Default
        const transportProfileArg = process.argv[4] ? process.argv[4].toUpperCase() : "NORMAL";
        const validTransportProfiles = ["NORMAL", "TEMP_EXCEEDED_HIGH", "TEMP_EXCEEDED_LOW", "SHOCKS_DETECTED"];
        if (!validTransportProfiles.includes(transportProfileArg)) {
            console.error(`FEHLER: Ungültiges Transportprofil '${transportProfileArg}'. Wähle: ${validTransportProfiles.join('|')}.`);
            process.exit(1);
        }
        console.log(`Verwende Transportprofil C -> D: ${transportProfileArg}`);


        if (dppIdFromA_actual.includes("DEFAULT") || dppIdFromB_actual.includes("DEFAULT")) {
             console.error("FEHLER: Bitte DPP IDs von A und B als Kommandozeilenargumente angeben!");
             console.error("Aufruf z.B.: node unternehmenC_app_v2.js <DPP_ID_A> <DPP_ID_B> [TRANSPORT_PROFIL_C_NACH_D]");
             process.exit(1);
        }
        console.log(`Verwende Input DPP von A: ${dppIdFromA_actual}`);
        console.log(`Verwende Input DPP von B: ${dppIdFromB_actual}`);

        // ... (Wallet, CA, Gateway Setup für OrgC - bleibt gleich)
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg3, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG3];
        if (!caInfo) throw new Error(`CA ${CA_NAME_ORG3} nicht in ${ccpPathOrg3} gefunden.`);
        if (!caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) throw new Error(`tlsCACerts.pem nicht für CA ${CA_NAME_ORG3} in ${ccpPathOrg3} gefunden.`);
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPathOrgC);
        console.log(`Wallet Pfad für Unternehmen C: ${walletPathOrgC}`);
        await enrollAdmin(wallet, ca, MSP_ID_ORG3, ADMIN_ID_ORG3);
        await registerAndEnrollUser(wallet, ca, MSP_ID_ORG3, APP_USER_ID_ORG3, ADMIN_ID_ORG3, 'org3.department1');

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: APP_USER_ID_ORG3,
            discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2');


        // 1. EMPFANG DER INPUT-DPPS BESTÄTIGEN (bleibt gleich)
        console.log(`\n--> [C] Empfange und bestätige DPPs von A und B...`);
        const inputDPPIDs = [dppIdFromA_actual, dppIdFromB_actual];
        for (const inputDppId of inputDPPIDs) {
            console.log(`\n---> [C] Bearbeite eingehenden DPP: ${inputDppId}`);
            await queryAndLogDPP(contract, inputDppId, `Status von ${inputDppId} (vor Empfang durch C)`);
            const incomingInspectionC = {
                testName: `Wareneingangsprüfung C für ${inputDppId}`, result: "Optisch i.O., Lieferschein geprüft",
                unit: "", systemId: "ERP-C-WARENEINGANG", responsible: "Logistik C", evaluationOutcome: "INFO_INCOMING_INSPECTION"
            };
            console.log(`---> [C] AcknowledgeReceiptAndRecordInspection für ${inputDppId}`);
            await contract.submitTransaction('AcknowledgeReceiptAndRecordInspection', inputDppId, GLN_ORG_C, JSON.stringify(incomingInspectionC));
            console.log(`✓ Empfang von DPP ${inputDppId} durch C bestätigt.`);
            await queryAndLogDPP(contract, inputDppId, `Status von ${inputDppId} (nach Empfang durch C)`);
        }

        // 2. TRANSFORMATION: COMPOUND-DPP ERSTELLEN (bleibt gleich)
        const uniqueIdPartC = Date.now();
        const dppIdC = `DPP_C_${uniqueIdPartC}`;
        const batchC = `${BATCH_C_PREFIX}${new Date().toISOString().slice(5, 10).replace('-', '')}`;
        const gs1KeyC = `urn:epc:id:sgtin:${GS1_COMPANY_PREFIX_C}.${GS1_ITEM_REF_C}.${uniqueIdPartC % 100000}`;
        const initialCompoundQuality = {
            testName: COMPOUND_DENSITY_TEST_NAME, result: "1.09", unit: "g/cm3",
            systemId: "LAB-C-INITIAL_COMPOUND_QA", responsible: "Ing. Neumann (C)",
        };
        console.log(`\n--> [C] RecordTransformation: Erzeuge DPP ${dppIdC} für Produkt C`);
        await contract.submitTransaction(
            'RecordTransformation', dppIdC, gs1KeyC, PRODUCT_TYPE_ID_C, GLN_ORG_C, batchC, 
            new Date().toISOString().split('T')[0], JSON.stringify(inputDPPIDs),
            JSON.stringify(SPECIFICATIONS_C), JSON.stringify(initialCompoundQuality)
        );
        console.log(`✓ Compound-DPP ${dppIdC} (GS1: ${gs1KeyC}) erstellt.`);
        await queryAndLogDPP(contract, dppIdC, `Initialer Status Compound DPP ${dppIdC}`);

        // 3. WEITERE QUALITÄTSDATEN FÜR COMPOUND (bleibt gleich)
        console.log(`\n--> [C] RecordQualityData (${COMPOUND_TENSILE_TEST_NAME}) für Compound DPP ${dppIdC}`);
        const tensileTestDataC = { testName: COMPOUND_TENSILE_TEST_NAME, result: "58", unit: "MPa", systemId: "LAB-C-MECHANICS", responsible: "Dr. Schulz (C)"};
        await contract.submitTransaction('RecordQualityData', dppIdC, JSON.stringify(tensileTestDataC), GLN_ORG_C);
        console.log(`✓ Zugfestigkeits-Daten gespeichert.`);
        await queryAndLogDPP(contract, dppIdC, `Status Compound DPP ${dppIdC} nach Zugfestigkeit`);

        console.log(`\n--> [C] RecordQualityData (${COMPOUND_COLOR_TEST_NAME}) für Compound DPP ${dppIdC}`);
        const colorTestDataC = { testName: COMPOUND_COLOR_TEST_NAME, result: "Grau-Schwarz", unit: "", systemId: "QMS-C-VISUAL", responsible: "Team Visual C"};
        await contract.submitTransaction('RecordQualityData', dppIdC, JSON.stringify(colorTestDataC), GLN_ORG_C);
        console.log(`✓ Farb-Daten gespeichert.`);
        let dppCObj = await queryAndLogDPP(contract, dppIdC, `Status Compound DPP ${dppIdC} nach Farbprüfung`);
        console.log(`\n[Neuer Compound-DPP C - ${dppIdC} vor Transport-Log]\n`, JSON.stringify(dppCObj, null, 2));

        // 4. TRANSPORT AN UNTERNEHMEN D (Org4MSP) VORBEREITEN
        if (dppCObj.status === "Released" || dppCObj.status === "ReleasedWithDeviations") {
            const targetOrgD_MSP = 'Org4MSP';

            // 4.a Initialen Transfer durchführen (Status -> InTransitTo_Org4MSP)
            // Dieser Schritt ist wichtig, damit der DPP bereits den korrekten Owner und Transit-Status hat,
            // BEVOR die Transportdaten hinzugefügt werden.
            console.log(`\n--> [C] TransferDPP (Initial) ${dppIdC} von ${MSP_ID_ORG3} (GLN: ${GLN_ORG_C}) an ${targetOrgD_MSP}`);
            await contract.submitTransaction('TransferDPP', dppIdC, targetOrgD_MSP, GLN_ORG_C /* shipperGLN */);
            console.log(`✓ Initialer Transfer von ${dppIdC} an ${targetOrgD_MSP} initiiert.`);
            dppCObj = await queryAndLogDPP(contract, dppIdC, "Nach initialem TransferDPP an D");

            // 4.b Transport-Simulation und Log-Erstellung
            console.log(`\n--> [C-TRANSPORT] Starte Simulation für Transport von DPP ${dppIdC} (Profil: ${transportProfileArg})`);
            console.log(`    1. Rufe generate_transport_log.js auf...`);
            let transportRawFilePath;
            try {
                const generateCmd = `node generate_transport_log.js ${dppIdC} ${transportProfileArg}`;
                console.log(`       Befehl: ${generateCmd}`);
                const generateOutput = execSync(generateCmd, { encoding: 'utf8', stdio: 'pipe' });
                console.log("       Ausgabe von generate_transport_log.js:");
                console.log(generateOutput);
                const match = generateOutput.match(/RAW_FILE_PATH=(.*)/);
                if (match && match[1]) {
                    transportRawFilePath = match[1].trim();
                    console.log(`    Transport-Rohdaten-Datei erstellt: ${transportRawFilePath}`);
                } else {
                    throw new Error("Konnte RAW_FILE_PATH aus der Ausgabe von generate_transport_log.js nicht extrahieren.");
                }
            } catch (e) {
                console.error("Fehler bei der Ausführung von generate_transport_log.js:", e.message);
                if(e.stdout) console.error("STDOUT:", e.stdout.toString()); if(e.stderr) console.error("STDERR:", e.stderr.toString());
                throw e;
            }

            // 4.c Aggregierte Transportdaten an Chaincode senden (AddTransportUpdate)
            console.log(`    2. Rufe submit_transport_update.js auf für Datei: ${transportRawFilePath}`);
            try {
                const submitTransportCmd = `node submit_transport_update.js \
                    --dpp ${dppIdC} \
                    --file "${transportRawFilePath}" \
                    --org ${MSP_ID_ORG3} \
                    --gln ${GLN_ORG_C} \
                    --system "LOGISTIK_PARTNER_XYZ_SENSOR" \
                    --responsible "Logistik C-D"`;
                console.log("       Befehl:", submitTransportCmd.replace(/\s+/g,' '));
                const submitTransportOutput = execSync(submitTransportCmd, { encoding: 'utf8', stdio: 'pipe' });
                console.log("       Ausgabe von submit_transport_update.js:");
                console.log(submitTransportOutput);
            } catch (e) {
                console.error("Fehler bei der Ausführung von submit_transport_update.js:", e.message);
                if(e.stdout) console.error("STDOUT:", e.stdout.toString()); if(e.stderr) console.error("STDERR:", e.stderr.toString());
                // Hier nicht zwingend abbrechen, DPP ist bereits "InTransitTo", aber ohne Transport-Update.
                console.warn("WARNUNG: Transport-Update konnte nicht zum DPP hinzugefügt werden.");
            }
            
            dppCObj = await queryAndLogDPP(contract, dppIdC, "Nach Transport-Log Integration durch C");
            console.log(`    DPP ${dppIdC} ist jetzt endgültig auf dem Weg zu ${targetOrgD_MSP} mit Status: ${dppCObj.status}`);

        } else {
            console.error(`ACHTUNG: Compound DPP ${dppIdC} hat Status ${dppCObj.status} und kann NICHT transferiert werden!`);
        }

        console.log(`\nWICHTIG: Bitte die DPP ID ${dppIdC} (GS1: ${gs1KeyC}) für Unternehmen D notieren!`);

    } catch (error) {
        console.error(`[C] FEHLER im Hauptablauf: ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await gateway.disconnect();
            console.log('\n[C] Gateway getrennt – Unternehmen C Demo beendet');
        }
    }
}

// Hilfsfunktion zum parsen der Kommandozeilenargumente für DPP IDs
if (require.main === module) {
    // Wird direkt aufgerufen
    if (process.argv.length < 4) {
        console.error("FEHLER: Bitte DPP ID von Unternehmen A und B als Kommandozeilenargumente angeben!");
        console.error("Aufruf z.B.: node unternehmenC_app_v2.js <DPP_ID_A> <DPP_ID_B> [TRANSPORT_PROFIL_C_NACH_D]");
        console.error("Gültige Transportprofile: NORMAL, TEMP_EXCEEDED_HIGH, TEMP_EXCEEDED_LOW, SHOCKS_DETECTED");
        process.exit(1);
    }
    main();
}