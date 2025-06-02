// -----------------------------------------------------------------------------
// unternehmenA_app_v2.js – Rohstofflieferant (Org1MSP = Unternehmen A)
// Erstellt einen DPP, integriert simulierte Inline-Sensordaten (MFI),
// fügt dann weitere Labordaten hinzu und transferiert den DPP.
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process'); // Für den Aufruf externer Skripte

// --- Pfade & Konstanten für Org1 (Unternehmen A) ---
const ccpPathOrg1 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org1.example.com',
    'connection-org1.json'
);
const walletPathOrgA = path.join(__dirname, 'walletA');
const MSP_ID_ORG1 = 'Org1MSP';
const CA_NAME_ORG1 = 'ca.org1.example.com';
const ADMIN_ID_ORG1 = 'adminOrg1';
const APP_USER_ID_ORG1 = 'appUserOrg1A';

// Produktspezifische Daten für Unternehmen A
const PRODUCT_TYPE_ID_A = 'RAW_POLYMER_GRADE_X1';
const GLN_ORG_A = '4012345000002';
const BATCH_A_PREFIX = 'BATCH_A_';
const GS1_COMPANY_PREFIX_A = '4012345';
const GS1_ITEM_REF_A = '076543';

// Testnamen Konstanten
const MFI_TEST_NAME_CONST = "Melt Flow Index (230 °C / 2,16 kg)";
const VISUAL_TEST_NAME_CONST = "Visuelle Prüfung – Granulatfarbe";
const DENSITY_TEST_NAME_CONST = "Dichte";

// Spezifikationen für Produkt A
const SPECIFICATIONS_A = [
    { testName: MFI_TEST_NAME_CONST, isNumeric: true, lowerLimit: 10.0, upperLimit: 15.0, unit: "g/10 min", isMandatory: true },
    { testName: VISUAL_TEST_NAME_CONST, isNumeric: false, expectedValue: "OK", unit: "", isMandatory: true },
    { testName: DENSITY_TEST_NAME_CONST, isNumeric: true, lowerLimit: 0.89, upperLimit: 0.92, unit: "g/cm3", isMandatory: false }
];
// MFI Spezifikationen für Sensor-Skript extrahieren
const MFI_SPECS_A = SPECIFICATIONS_A.find(s => s.testName === MFI_TEST_NAME_CONST);


// --- Hilfsfunktionen ---
async function checkWallet(wallet, identityLabel) {
    return await wallet.get(identityLabel);
}

async function enrollAdmin(wallet, caClient, mspId, adminUserId) {
    try {
        if (await checkWallet(wallet, adminUserId)) {
            console.log(`Admin-Benutzer "${adminUserId}" existiert bereits im Wallet A.`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminUserId, x509Identity);
        console.log(`Admin-Benutzer "${adminUserId}" erfolgreich für Wallet A registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Admin-Benutzers "${adminUserId}" für Wallet A: ${error.message}`);
        throw error;
    }
}

async function registerAndEnrollUser(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        if (await checkWallet(wallet, userId)) {
            console.log(`Benutzer "${userId}" existiert bereits im Wallet A.`);
            return;
        }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) {
            throw new Error(`Admin-Benutzer "${adminUserId}" nicht im Wallet A gefunden. Bitte zuerst Admin enrollen.`);
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
        console.log(`Benutzer "${userId}" erfolgreich für Wallet A registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Benutzers "${userId}" für Wallet A: ${error.message}`);
        throw error;
    }
}

async function disconnectGateway(gateway) {
    if (gateway) {
        await gateway.disconnect();
    }
}

async function queryAndLogDPP(contract, dppId, contextMessage) {
    console.log(`\n--- [INFO] ${contextMessage} - Aktueller Status von ${dppId} ---`);
    const dppBytes = await contract.evaluateTransaction('QueryDPP', dppId);
    const dpp = JSON.parse(dppBytes.toString());
    console.log(`Status: ${dpp.status}`);
    if (dpp.openMandatoryChecks && dpp.openMandatoryChecks.length > 0) {
        console.log(`Offene mandatorische Prüfungen: ${dpp.openMandatoryChecks.join(', ')}`);
    }
    if (dpp.status === "Blocked") {
        console.error(`ACHTUNG: DPP ${dppId} ist blockiert!`);
    }
    return dpp;
}


// --- Hauptablauf ---
async function main() {
    let gateway;
    try {
        // Wallet und CA-Client initialisieren
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg1, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG1];
        if (!caInfo) throw new Error(`CA ${CA_NAME_ORG1} nicht in ${ccpPathOrg1} gefunden.`);
        if (!caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) throw new Error(`tlsCACerts.pem nicht für CA ${CA_NAME_ORG1} in ${ccpPathOrg1} gefunden.`);
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPathOrgA);
        console.log(`Wallet Pfad für Unternehmen A: ${walletPathOrgA}`);
        await enrollAdmin(wallet, ca, MSP_ID_ORG1, ADMIN_ID_ORG1);
        await registerAndEnrollUser(wallet, ca, MSP_ID_ORG1, APP_USER_ID_ORG1, ADMIN_ID_ORG1, 'org1.department1');

        // Gateway verbinden
        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: APP_USER_ID_ORG1,
            discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2');

        // Eindeutige IDs generieren
        const uniqueIdPartA = Date.now();
        const dppIdA = `DPP_A_${uniqueIdPartA}`;
        const batchA = `${BATCH_A_PREFIX}${new Date().toISOString().slice(5, 10).replace('-', '')}`;
        const gs1KeyA = `urn:epc:id:sgtin:${GS1_COMPANY_PREFIX_A}.${GS1_ITEM_REF_A}.${uniqueIdPartA % 100000}`;

        // 1. DPP ERSTELLEN
        console.log(`\n--> [A] CreateDPP ${dppIdA} für Produkttyp ${PRODUCT_TYPE_ID_A}`);
        await contract.submitTransaction(
            'CreateDPP',
            dppIdA,
            gs1KeyA,
            PRODUCT_TYPE_ID_A,
            GLN_ORG_A,
            batchA,
            new Date().toISOString().split('T')[0],
            JSON.stringify(SPECIFICATIONS_A)
        );
        console.log(`✓ DPP ${dppIdA} angelegt (GS1 ${gs1KeyA})`);
        await queryAndLogDPP(contract, dppIdA, "Nach CreateDPP");

        // 2. SIMULIERTE INLINE-MFI-SENSORDATEN ERFASSEN UND INTEGRIEREN
        const sensorQualityProfile = "GOOD"; // Für "schlechte" Daten hier "BAD" einsetzen
        console.log(`\n--> [A] Starte Simulation für Inline-MFI-Sensor (Profil: ${sensorQualityProfile}) für DPP ${dppIdA}`);

        // 2.a Sensor-Rohdaten generieren
        console.log(`    1. Rufe generate_mfi_raw.js auf...`);
        let rawFilePath;
        try {
            const generateCmd = `node generate_mfi_raw.js ${dppIdA} ${sensorQualityProfile}`;
            console.log(`       Befehl: ${generateCmd}`);
            const generateOutput = execSync(generateCmd, { encoding: 'utf8', stdio: 'pipe' });
            console.log("       Ausgabe von generate_mfi_raw.js:");
            console.log(generateOutput);
            const match = generateOutput.match(/RAW_FILE_PATH=(.*)/);
            if (match && match[1]) {
                rawFilePath = match[1].trim();
                console.log(`    Rohdaten-Datei erstellt: ${rawFilePath}`);
            } else {
                throw new Error("Konnte RAW_FILE_PATH aus der Ausgabe von generate_mfi_raw.js nicht extrahieren.");
            }
        } catch (e) {
            console.error("Fehler bei der Ausführung von generate_mfi_raw.js:", e.message);
            if(e.stdout) console.error("STDOUT:", e.stdout.toString());
            if(e.stderr) console.error("STDERR:", e.stderr.toString());
            throw e;
        }

        // 2.b Aggregierte Sensordaten an Chaincode senden
        console.log(`    2. Rufe submit_quality_from_file.js auf für Datei: ${rawFilePath}`);
        try {
            if (!MFI_SPECS_A) { // MFI_SPECS_A ist oben im Skript definiert
                throw new Error(`MFI Spezifikationen für Test '${MFI_TEST_NAME_CONST}' nicht gefunden.`);
            }
            const submitCmd = `node submit_quality_from_file.js \
                --dpp ${dppIdA} \
                --file "${rawFilePath}" \
                --test "${MFI_TEST_NAME_CONST}" \
                --org ${MSP_ID_ORG1} \
                --gln ${GLN_ORG_A} \
                --system "SENSOR_MFI_INLINE_A001" \
                --responsible "Autom. Prozessüberwachung A" \
                --lower_limit ${MFI_SPECS_A.lowerLimit} \
                --upper_limit ${MFI_SPECS_A.upperLimit} \
                --unit "${MFI_SPECS_A.unit}"`; // UNIT PARAMETER HINZUGEFÜGT
            
            console.log("       Befehl:", submitCmd.replace(/\s+/g,' '));
            const submitOutput = execSync(submitCmd, { encoding: 'utf8', stdio: 'pipe' });
            console.log("       Ausgabe von submit_quality_from_file.js:");
            console.log(submitOutput);
        } catch (e) {
            console.error("Fehler bei der Ausführung von submit_quality_from_file.js:", e.message);
            if(e.stdout) console.error("STDOUT:", e.stdout.toString());
            if(e.stderr) console.error("STDERR:", e.stderr.toString());
            throw e;
        }
        await queryAndLogDPP(contract, dppIdA, "Nach Inline-MFI-Sensor Integration");


        // 3. WEITERE QUALITÄTSDATEN (QMS - Visuelle Prüfung)
        console.log(`\n--> [A] RecordQualityData (QMS - ${VISUAL_TEST_NAME_CONST}) für DPP ${dppIdA}`);
        const visualTestDataA = {
            testName: VISUAL_TEST_NAME_CONST,
            result: "OK", unit: "", systemId: "QMS-A-VISUAL01", responsible: "Hr. Schmidt",
            offChainDataRef: "ipfs://QmSimulatedVisualInspectionRecord123",
        };
        await contract.submitTransaction('RecordQualityData', dppIdA, JSON.stringify(visualTestDataA), GLN_ORG_A);
        console.log(`✓ QMS-Datensatz (Visuelle Prüfung) gespeichert`);
        await queryAndLogDPP(contract, dppIdA, `Nach QMS (${VISUAL_TEST_NAME_CONST})`);


        // (Optional) Nicht-mandatorischer Dichte-Test
        console.log(`\n--> [A] RecordQualityData (${DENSITY_TEST_NAME_CONST}) für DPP ${dppIdA}`);
        const densityTestDataA = {
            testName: DENSITY_TEST_NAME_CONST,
            result: "0.91", unit: "g/cm3", systemId: "SENSOR-A-DENS01", responsible: "Anlage 1",
        };
        await contract.submitTransaction('RecordQualityData', dppIdA, JSON.stringify(densityTestDataA), GLN_ORG_A);
        console.log(`✓ Dichte-Sensor-Datensatz gespeichert`);
        const finalDpp = await queryAndLogDPP(contract, dppIdA, `Nach ${DENSITY_TEST_NAME_CONST}`);

        // Finalen DPP anzeigen
        console.log(`\n[DPP-Inhalt A - ${dppIdA} vor Transfer]\n`, JSON.stringify(finalDpp, null, 2));

        // 4. TRANSFER AN UNTERNEHMEN C (Org3MSP)
        if (finalDpp.status === "Released" || finalDpp.status === "ReleasedWithDeviations" || finalDpp.status.includes("SensorAlert")) { // Auch mit SensorAlert transferieren
            const targetOrgC_MSP = 'Org3MSP';
            console.log(`\n--> [A] TransferDPP ${dppIdA} von ${MSP_ID_ORG1} (GLN: ${GLN_ORG_A}) an ${targetOrgC_MSP}`);
            await contract.submitTransaction('TransferDPP', dppIdA, targetOrgC_MSP, GLN_ORG_A);
            console.log(`✓ Transfer von ${dppIdA} an ${targetOrgC_MSP} initiiert.`);
            await queryAndLogDPP(contract, dppIdA, "Nach TransferInitiative an C");
        } else {
            console.error(`ACHTUNG: DPP ${dppIdA} hat Status ${finalDpp.status} und kann NICHT transferiert werden! Demo für diesen Pfad hier beendet.`);
        }

        console.log(`\nWICHTIG: Bitte die DPP ID ${dppIdA} (GS1: ${gs1KeyA}) für nachfolgende Schritte notieren!`);

    } catch (error) {
        console.error(`[A] FEHLER im Hauptablauf von unternehmenA_app_v2.js: ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await gateway.disconnect();
            console.log('\n[A] Gateway getrennt – Unternehmen A Demo beendet');
        }
    }
}

main();