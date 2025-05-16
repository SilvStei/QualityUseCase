// -----------------------------------------------------------------------------
// unternehmenA_app_extended.js – Client-Demo für GS1-DPP (Org1MSP = Unternehmen A)
// Angepasst für erweiterten Chaincode mit Quality Specifications
// Stand: Mai 2025 – getestet mit Hyperledger Fabric 2.5, Node SDK 2.2
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

// -----------------------------------------------------------------------------
// 1. Pfade & Konstanten – bitte auf deine Ordnerstruktur anpassen
// -----------------------------------------------------------------------------
const ccpPathOrg1 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network', // Ggf. anpassen, falls Ihre test-network Ordnerstruktur anders ist
    'organizations', 'peerOrganizations', 'org1.example.com',
    'connection-org1.json'
);

const walletPath = path.join(__dirname, 'walletA'); // Separates Wallet für Unternehmen A
const MSP_ID_ORG1 = 'Org1MSP';
const CA_NAME_ORG1 = 'ca.org1.example.com'; // Stellen Sie sicher, dass dies der CA-Name in Ihrer connection-org1.json ist

// GS1-Basisdaten von Unternehmen A (Demo-Werte)
const GLN_ORG1 = '4012345000002'; // Global Location Number A
const GS1_COMP_PREFIX = '4012345'; // 7-stelliger Company Prefix
const DEFAULT_PRODUCT_TYPE_A = 'RAW_POLYMER_GRADE_X1'; // Beispiel ProduktTypID für A

// Hilfsfunktion für einfache SGTIN-Erzeugung (ohne Prüfziffer-Berechnung)
function makeSgtin(companyPrefix, itemRef, serial) {
    return `urn:epc:id:sgtin:${companyPrefix}.${itemRef}.${serial}`;
}

// -----------------------------------------------------------------------------
// 2. Hauptlogik
// -----------------------------------------------------------------------------
async function main() {
    try {
        // -- CA-Client & Wallet vorbereiten ---------------------------------------
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg1, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG1];
        const caTLSCACerts = caInfo.tlsCACerts.pem; // Pfad oder PEM-String direkt verwenden
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);


        const wallet = await Wallets.newFileSystemWallet(walletPath);
        console.log(`Wallet Pfad für Unternehmen A: ${walletPath}`);

        await enrollAdmin(wallet, ca, MSP_ID_ORG1, 'adminOrg1');
        await registerAndEnrollUser(wallet, ca, MSP_ID_ORG1,
            'appUserOrg1A', 'adminOrg1', 'org1.department1'); // Eindeutiger User pro Unternehmen

        // -- Gateway öffnen -------------------------------------------------------
        const gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: 'appUserOrg1A', // Identität von Unternehmen A verwenden
            discovery: { enabled: true, asLocalhost: true }
        });

        const network = await gateway.getNetwork('mychannel');
        // Stellen Sie sicher, dass der Chaincode-Name hier mit dem Namen übereinstimmt,
        // mit dem der ERWEITERTE Chaincode bereitgestellt wurde.
        const contract = network.getContract('dpp_quality_go_v2');

        // -------------------------------------------------------------------------
        // 3. Demo-Ablauf: DPP anlegen, Qualitätsdaten hinzufügen, weitergeben
        // -------------------------------------------------------------------------
        // 3.1 Neue IDs und Spezifikationen generieren
        const nowDate = new Date();
        const dppId = `DPP_A_${nowDate.getTime()}`; // Ledger-Key
        const gs1Key = makeSgtin(GS1_COMP_PREFIX, '076543', nowDate.getTime().toString().slice(-5)); // Eindeutigere Seriennummer
        const batch = `BATCH_A_${nowDate.toISOString().slice(5, 10).replace('-', '')}`;
        const prodISO = nowDate.toISOString().slice(0, 10); // JJJJ-MM-TT

        // Beispiel Spezifikationen für ProduktTyp A
        const specificationsA = [
            { testName: 'Melt Flow Index (230 °C / 2,16 kg)', isNumeric: true, lowerLimit: 10.0, upperLimit: 15.0, unit: 'g/10 min', isMandatory: true },
            { testName: 'Visuelle Prüfung – Granulatfarbe', isNumeric: false, expectedValue: 'OK', unit: '', isMandatory: true },
            { testName: 'Dichte', isNumeric: true, lowerLimit: 0.89, upperLimit: 0.92, unit: 'g/cm3', isMandatory: false } // Beispiel für nicht-mandatorischen Test
        ];
        const specificationsA_JSON = JSON.stringify(specificationsA);

        console.log(`\n--> [A] CreateDPP ${dppId} für Produkttyp ${DEFAULT_PRODUCT_TYPE_A}`);
        await contract.submitTransaction(
            'CreateDPP',
            dppId,
            gs1Key,
            DEFAULT_PRODUCT_TYPE_A, // NEU: productTypeID
            GLN_ORG1,
            batch,
            prodISO,
            specificationsA_JSON    // NEU: specificationsJSON
        );
        console.log(`✓ DPP ${dppId} angelegt (GS1 ${gs1Key})`);

        let dppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', dppId)).toString());
        console.log(`Initialer Status DPP ${dppId}: ${dppState.status}`);
        console.log(`Offene mandatorische Prüfungen: ${dppState.openMandatoryChecks ? dppState.openMandatoryChecks.join(', ') : 'Keine'}`);


        // 3.2 LIMS-Prüfergebnis anhängen (Melt Flow Index)
        const limsEntry = {
            testName: 'Melt Flow Index (230 °C / 2,16 kg)', // Muss mit TestName in Specifications übereinstimmen
            result: '12.3', // Innerhalb der Spezifikation
            unit: 'g/10 min',
            systemId: 'LIMS-A-LAB01',
            responsible: 'Dr. Weber',
            // timestamp: new Date().toISOString() // Wird jetzt vom Chaincode gesetzt, wenn leer
            // performingOrg: MSP_ID_ORG1 // Wird jetzt vom Chaincode gesetzt, wenn leer
        };
        console.log(`\n--> [A] RecordQualityData (LIMS) für DPP ${dppId}`);
        await contract.submitTransaction('RecordQualityData',
            dppId,
            JSON.stringify(limsEntry),
            GLN_ORG1 // NEU: recordingSiteGLN
        );
        console.log('✓ LIMS-Datensatz gespeichert');

        dppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', dppId)).toString());
        console.log(`Status DPP ${dppId} nach LIMS: ${dppState.status}`);
        console.log(`Offene mandatorische Prüfungen: ${dppState.openMandatoryChecks ? dppState.openMandatoryChecks.join(', ') : 'Keine'}`);

        // 3.3 QMS-Prüfergebnis anhängen (Visuelle Prüfung)
        const qmsEntry = {
            testName: 'Visuelle Prüfung – Granulatfarbe', // Muss mit TestName in Specifications übereinstimmen
            result: 'OK', // Entspricht expectedValue
            unit: '',
            systemId: 'QMS-A-VISUAL01',
            responsible: 'Hr. Schmidt',
            offChainDataRef: 'ipfs://QmSimulatedVisualInspectionRecord123' // Beispiel für Off-Chain Referenz
        };
        console.log(`\n--> [A] RecordQualityData (QMS) für DPP ${dppId}`);
        await contract.submitTransaction('RecordQualityData',
            dppId,
            JSON.stringify(qmsEntry),
            GLN_ORG1 // NEU: recordingSiteGLN
        );
        console.log('✓ QMS-Datensatz gespeichert');

        dppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', dppId)).toString());
        console.log(`Status DPP ${dppId} nach QMS: ${dppState.status}`);
        if(dppState.status === "Released") {
            console.log("Alle mandatorischen Prüfungen bestanden. DPP ist freigegeben!");
        } else {
            console.log(`Offene mandatorische Prüfungen: ${dppState.openMandatoryChecks ? dppState.openMandatoryChecks.join(', ') : 'Status nicht "Released"'}`);
        }

        // 3.3b Optionale, nicht-mandatorische Prüfung hinzufügen (Dichte)
        const densityEntry = {
            testName: 'Dichte',
            result: '0.91', // Innerhalb der Spezifikation
            unit: 'g/cm3',
            systemId: 'SENSOR-A-DENS01',
            responsible: 'Anlage 1',
        };
        console.log(`\n--> [A] RecordQualityData (Sensor Dichte) für DPP ${dppId}`);
        await contract.submitTransaction('RecordQualityData',
            dppId,
            JSON.stringify(densityEntry),
            GLN_ORG1
        );
        console.log('✓ Dichte-Sensor-Datensatz gespeichert');
        dppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', dppId)).toString());
        console.log(`Status DPP ${dppId} nach Dichte-Sensor: ${dppState.status}`);


        // 3.4 DPP lesen und anzeigen
        const dppBytes = await contract.evaluateTransaction('QueryDPP', dppId);
        console.log(`\n[DPP-Inhalt A - ${dppId}]\n`,
            JSON.stringify(JSON.parse(dppBytes.toString()), null, 2));

        // 3.5 Eigentümerwechsel an Unternehmen C (Org3MSP) simulieren
        // Annahme: Unternehmen B ist übersprungen oder nicht Teil dieses direkten Transfers von A zu C
        // Im komplexeren Szenario würde A an B, und B dann an C transferieren.
        // Für den Prototyp hier direkt A -> C.
        const nextOwnerMSP = 'Org3MSP'; // Unternehmen C
        console.log(`\n--> [A] TransferDPP ${dppId} von ${MSP_ID_ORG1} (GLN: ${GLN_ORG1}) an ${nextOwnerMSP}`);
        await contract.submitTransaction(
            'TransferDPP',
            dppId,
            nextOwnerMSP,
            GLN_ORG1 // GLN des Versenders (Unternehmen A)
        );
        console.log(`✓ Transfer von ${dppId} an ${nextOwnerMSP} initiiert.`);

        // 3.6 Kontrolle Status nach TransferInitiative
        const dppAfterTransferAttempt = JSON.parse(
            (await contract.evaluateTransaction('QueryDPP', dppId)).toString()
        );
        console.log(`DPP Status nach TransferInitiative: ${dppAfterTransferAttempt.status}`);
        console.log(`Neuer (temporärer) Eigentümer laut DPP: ${dppAfterTransferAttempt.ownerOrg}`);


        // -------------------------------------------------------------------------
        await gateway.disconnect();
        console.log('\n[A] Gateway getrennt – Unternehmen A Demo beendet');
        console.log(`WICHTIG: Bitte die DPP ID ${dppId} (GS1: ${gs1Key}) für Unternehmen C notieren!`);

    } catch (err) {
        console.error(`[A] FEHLER: ${err.stack ? err.stack : err}`);
        process.exit(1);
    }
}

// -----------------------------------------------------------------------------
// 4. Hilfsfunktionen für Admin/User-Handling (unverändert)
// -----------------------------------------------------------------------------
async function enrollAdmin(wallet, caClient, mspId, adminUserId) {
    try {
        const adminIdentity = await wallet.get(adminUserId);
        if (adminIdentity) {
            console.log(`Admin-Benutzer "${adminUserId}" existiert bereits im Wallet A.`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: mspId,
            type: 'X.509',
        };
        await wallet.put(adminUserId, x509Identity);
        console.log(`Admin-Benutzer "${adminUserId}" erfolgreich für Wallet A registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Admin-Benutzers "${adminUserId}" für Wallet A: ${error}`);
        throw error; // Fehler weiterwerfen, um Hauptfunktion zu stoppen
    }
}

async function registerAndEnrollUser(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        const userIdentity = await wallet.get(userId);
        if (userIdentity) {
            console.log(`Benutzer "${userId}" existiert bereits im Wallet A.`);
            return;
        }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) {
            console.log(`Admin-Benutzer "${adminUserId}" nicht im Wallet A gefunden. Bitte zuerst Admin registrieren.`);
            throw new Error(`Admin-Benutzer "${adminUserId}" nicht im Wallet A gefunden.`);
        }
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, adminUserId);
        const secret = await caClient.register({
            affiliation: affiliation,
            enrollmentID: userId,
            role: 'client'
        }, adminUser);
        const enrollment = await caClient.enroll({
            enrollmentID: userId,
            enrollmentSecret: secret
        });
        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: mspId,
            type: 'X.509',
        };
        await wallet.put(userId, x509Identity);
        console.log(`Benutzer "${userId}" erfolgreich für Wallet A registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Benutzers "${userId}" für Wallet A: ${error}`);
        throw error; // Fehler weiterwerfen
    }
}
// -----------------------------------------------------------------------------
main().catch(err => {
    console.error("Ein unerwarteter Fehler ist in main() aufgetreten (unternehmenA_app_extended.js):", err);
    process.exit(1);
});