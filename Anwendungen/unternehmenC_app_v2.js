// -----------------------------------------------------------------------------
// unternehmenC_app_extended.js – Compounder (Org3MSP) mischt Inputs von A & B
// Empfängt DPPs, erstellt neuen DPP via RecordTransformation, transferiert an D.
// Angepasst für erweiterten Chaincode.
// Stand: Mai 2025 – Hyperledger Fabric 2.5 / Node SDK 2.2
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

// -----------------------------------------------------------------------------
// 1. Pfade & Konstanten
// -----------------------------------------------------------------------------
const ccpPathOrg3 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network', // Ggf. anpassen
    'organizations', 'peerOrganizations', 'org3.example.com',
    'connection-org3.json'
);

const walletPath = path.join(__dirname, 'walletC'); // Separates Wallet für Unternehmen C
const MSP_ID_ORG3 = 'Org3MSP';
const CA_NAME_ORG3 = 'ca.org3.example.com';

// GS1-Stammdaten Compounder C
const GLN_ORG3 = '4077777000005';
const GS1_COMP_PREFIX_C = '4077777'; // Eigener Prefix für C
const DEFAULT_PRODUCT_TYPE_C = 'PP_GF_COMPOUND_30'; // Beispiel ProduktTypID für das Compound

// Hilfsfunktion SGTIN
function makeSgtin(prefix, itemRef, serial) {
    return `urn:epc:id:sgtin:${prefix}.${itemRef}.${serial}`;
}

// -----------------------------------------------------------------------------
// 2. IDs der eingehenden DPPs – BITTE DIESE IDs AKTUALISIEREN
//    mit den echten IDs, die von unternehmenA_app_extended.js
//    und unternehmenB_app_extended.js ausgegeben wurden!
// -----------------------------------------------------------------------------
const dppIdFromA_actual = 'DPP_A_1747407716970'; // <== ECHTE ID VON A EINSETZEN
const dppIdFromB_actual = 'DPP_B_1747407772376'; // <== ECHTE ID VON B EINSETZEN

// -----------------------------------------------------------------------------
// 3. Hauptablauf
// -----------------------------------------------------------------------------
async function main() {
    if (dppIdFromA_actual === 'DPP_A_xxxxxxxxxxxxx' || dppIdFromB_actual === 'DPP_B_yyyyyyyyyyyyy') {
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("FEHLER: Bitte aktualisieren Sie dppIdFromA_actual und dppIdFromB_actual im Skript");
        console.error("        mit den echten DPP IDs von Unternehmen A und B!");
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }

    try {
        // -------------------------------------------------------------------------
        // 3.1 Wallet & CA
        // -------------------------------------------------------------------------
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg3, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG3];
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPath);
        console.log(`Wallet Pfad für Unternehmen C: ${walletPath}`);
        await enrollAdmin(wallet, ca, MSP_ID_ORG3, 'adminOrg3');
        await registerAndEnrollUser(wallet, ca, MSP_ID_ORG3,
            'appUserOrg3C', 'adminOrg3', 'org3.department1');

        // -------------------------------------------------------------------------
        // 3.2 Gateway & Contract
        // -------------------------------------------------------------------------
        const gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: 'appUserOrg3C', // Identität von Unternehmen C
            discovery: { enabled: true, asLocalhost: true }
        });

        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2'); // Name des erweiterten Chaincodes

        // -------------------------------------------------------------------------
        // 3.3 Eingehende DPPs von A und B empfangen und prüfen
        // -------------------------------------------------------------------------
        console.log('\n--> [C] Empfange und bestätige DPPs von A und B...');
        const inputDppIDsForTransformation = [dppIdFromA_actual, dppIdFromB_actual];
        const receivedInputGS1Keys = [];

        for (const inputDppId of inputDppIDsForTransformation) {
            console.log(`\n---> [C] Bearbeite eingehenden DPP: ${inputDppId}`);
            let dppBytes = await contract.evaluateTransaction('QueryDPP', inputDppId);
            let dpp = JSON.parse(dppBytes.toString());

            console.log(`Status von ${inputDppId} (vor Empfang durch C): ${dpp.status}, Owner: ${dpp.ownerOrg}`);
            if (dpp.ownerOrg !== MSP_ID_ORG3 || !dpp.status.startsWith('InTransitTo_')) {
                 // Im Prototyp gehen wir davon aus, dass A und B direkt an C (Org3MSP) transferiert haben
                if (dpp.ownerOrg === MSP_ID_ORG3 && dpp.status.startsWith('InTransitTo_' + MSP_ID_ORG3)) {
                     console.log(`DPP ${inputDppId} ist korrekt an ${MSP_ID_ORG3} unterwegs.`);
                } else {
                    throw new Error(`DPP ${inputDppId} ist nicht korrekt an ${MSP_ID_ORG3} transferiert worden oder hat falschen Status/Owner. Aktuell: Owner ${dpp.ownerOrg}, Status ${dpp.status}. Erwartet Owner ${MSP_ID_ORG3} und Status InTransitTo_${MSP_ID_ORG3}`);
                }
            }

            // Optionale Eingangsprüfung für das Material von A/B durch C
            const incomingInspectionForInput = {
                testName: `Eingangsprüfung Material von ${inputDppId.includes('_A_') ? 'A' : 'B'}`,
                result: 'Visuell OK, Spezifikation laut Begleit-DPP geprüft', // Beispiel
                unit: '',
                systemId: 'QMS-C-INCOMING',
                responsible: 'Wareneingang C',
            };

            console.log(`---> [C] AcknowledgeReceiptAndRecordInspection für ${inputDppId}`);
            await contract.submitTransaction(
                'AcknowledgeReceiptAndRecordInspection',
                inputDppId,
                GLN_ORG3, // recipientGLN (GLN von C)
                JSON.stringify(incomingInspectionForInput)
            );
            console.log(`✓ Empfang von DPP ${inputDppId} durch C bestätigt und Eingangsprüfung hinzugefügt.`);

            dppBytes = await contract.evaluateTransaction('QueryDPP', inputDppId);
            dpp = JSON.parse(dppBytes.toString());
            console.log(`Neuer Status von ${inputDppId} (nach Empfang durch C): ${dpp.status}`);
            receivedInputGS1Keys.push(dpp.gs1Key); // GS1 Key für TransformationEvent sammeln
        }

        // -------------------------------------------------------------------------
        // 3.4 Transformation (Compounding) anlegen: Erzeugt neuen DPP für Produkt C
        // -------------------------------------------------------------------------
        const now = new Date();
        const newCompoundDppId = `DPP_C_${now.getTime()}`;
        const newCompoundGs1Key = makeSgtin(GS1_COMP_PREFIX_C, '056789', now.getTime().toString().slice(-5));
        const batchC = `BATCH_C_COMPOUND_${now.toISOString().slice(5, 10).replace('-', '')}`;
        const prodDateC = now.toISOString().slice(0, 10);

        // Spezifikationen für das Compound-Produkt von C
        const specificationsC = [
            { testName: 'Compound Dichte', isNumeric: true, lowerLimit: 1.05, upperLimit: 1.15, unit: 'g/cm3', isMandatory: true },
            { testName: 'Compound Zugfestigkeit', isNumeric: true, lowerLimit: 50, upperLimit: 65, unit: 'MPa', isMandatory: true },
            { testName: 'Compound Farbe', isNumeric: false, expectedValue: 'Grau-Schwarz', unit: '', isMandatory: true }
        ];
        const specificationsC_JSON = JSON.stringify(specificationsC);

        // Optionale initiale Qualitätsprüfung des direkt hergestellten Compounds
        const initialCompoundQuality = {
            testName: 'Compound Dichte', // Muss mit TestName in specificationsC übereinstimmen
            result: '1.09', // Beispielwert, sollte innerhalb der Spec liegen
            unit: 'g/cm3',
            systemId: 'LAB-C-INITIAL_COMPOUND_QA',
            responsible: 'Ing. Neumann (C)',
        };
        const initialCompoundQuality_JSON = JSON.stringify(initialCompoundQuality);

        console.log(`\n--> [C] RecordTransformation: Erzeuge DPP ${newCompoundDppId} für Produkt C`);
        await contract.submitTransaction(
            'RecordTransformation',
            newCompoundDppId,
            newCompoundGs1Key,
            DEFAULT_PRODUCT_TYPE_C,     // NEU: outputProductTypeID
            GLN_ORG3,                   // currentGLN (Ort der Transformation = C)
            batchC,
            prodDateC,
            JSON.stringify(inputDppIDsForTransformation), // NEU: JSON Array der Ledger-IDs der Input DPPs
            specificationsC_JSON,       // NEU: specificationsJSON für Output
            initialCompoundQuality_JSON // NEU: Optionale initiale Qualitätsdaten
        );
        console.log(`✓ Compound-DPP ${newCompoundDppId} (GS1: ${newCompoundGs1Key}) erstellt.`);
        console.log(`   Verwendete Input DPP IDs: ${inputDppIDsForTransformation.join(', ')}`);

        let compoundDppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', newCompoundDppId)).toString());
        console.log(`Initialer Status Compound DPP ${newCompoundDppId}: ${compoundDppState.status}`);


        // 3.4b Weitere Qualitätsprüfungen für das Compound-Produkt von C hinzufügen
        const zugfestigkeitEntryC = {
            testName: 'Compound Zugfestigkeit',
            result: '58', // Innerhalb der Spezifikation
            unit: 'MPa',
            systemId: 'LAB-C-MECHANICS',
            responsible: 'Dr. Schulz (C)',
        };
        console.log(`\n--> [C] RecordQualityData (Zugfestigkeit) für Compound DPP ${newCompoundDppId}`);
        await contract.submitTransaction('RecordQualityData', newCompoundDppId, JSON.stringify(zugfestigkeitEntryC), GLN_ORG3);
        console.log('✓ Zugfestigkeits-Daten für Compound gespeichert.');
        compoundDppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', newCompoundDppId)).toString());
        console.log(`Status Compound DPP ${newCompoundDppId} nach Zugfestigkeit: ${compoundDppState.status}`);

        const farbEntryC = {
            testName: 'Compound Farbe',
            result: 'Grau-Schwarz', // Entspricht Spezifikation
            unit: '',
            systemId: 'QMS-C-VISUAL',
            responsible: 'Team Visual C',
        };
        console.log(`\n--> [C] RecordQualityData (Farbe) für Compound DPP ${newCompoundDppId}`);
        await contract.submitTransaction('RecordQualityData', newCompoundDppId, JSON.stringify(farbEntryC), GLN_ORG3);
        console.log('✓ Farb-Daten für Compound gespeichert.');

        compoundDppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', newCompoundDppId)).toString());
        console.log(`Status Compound DPP ${newCompoundDppId} nach Farbprüfung: ${compoundDppState.status}`);
        if(compoundDppState.status === "Released") {
            console.log("Alle mandatorischen Prüfungen für Compound bestanden. Compound DPP ist freigegeben!");
        }


        // -------------------------------------------------------------------------
        // 3.5 Neuen Compound-Pass anzeigen
        // -------------------------------------------------------------------------
        const newCompoundDppBytes = await contract.evaluateTransaction('QueryDPP', newCompoundDppId);
        console.log(`\n[Neuer Compound-DPP C - ${newCompoundDppId}]\n`,
            JSON.stringify(JSON.parse(newCompoundDppBytes.toString()), null, 2));

        // -------------------------------------------------------------------------
        // 3.6 Transfer des Compound-Passes an Unternehmen D (Org4MSP)
        // -------------------------------------------------------------------------
        const nextOwnerMSP_D = 'Org4MSP';
        console.log(`\n--> [C] TransferDPP ${newCompoundDppId} von ${MSP_ID_ORG3} (GLN: ${GLN_ORG3}) an ${nextOwnerMSP_D}`);
        await contract.submitTransaction(
            'TransferDPP',
            newCompoundDppId,
            nextOwnerMSP_D,
            GLN_ORG3 // GLN des Versenders (Unternehmen C)
        );
        console.log(`✓ Transfer von ${newCompoundDppId} an ${nextOwnerMSP_D} initiiert.`);

        const dppAfterTransferC = JSON.parse(
            (await contract.evaluateTransaction('QueryDPP', newCompoundDppId)).toString()
        );
        console.log(`DPP Status nach TransferInitiative durch C: ${dppAfterTransferC.status}`);
        console.log(`Neuer (temporärer) Eigentümer laut DPP: ${dppAfterTransferC.ownerOrg}`);


        // -------------------------------------------------------------------------
        await gateway.disconnect();
        console.log('\n[C] Gateway getrennt – Unternehmen C Demo beendet');
        console.log(`WICHTIG: Bitte die DPP ID ${newCompoundDppId} (GS1: ${newCompoundGs1Key}) für Unternehmen D notieren!`);

    } catch (err) {
        console.error(`[C] FEHLER: ${err.stack ? err.stack : err}`);
        process.exit(1);
    }
}

// -----------------------------------------------------------------------------
// 4. Hilfsfunktionen für Admin/User-Handling (analog zu A und B)
// -----------------------------------------------------------------------------
async function enrollAdmin(wallet, caClient, mspId, adminUserId) {
    try {
        const adminIdentity = await wallet.get(adminUserId);
        if (adminIdentity) {
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
        console.error(`Fehler beim Registrieren des Admin-Benutzers "${adminUserId}" für Wallet C: ${error}`);
        throw error;
    }
}

async function registerAndEnrollUser(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        const userIdentity = await wallet.get(userId);
        if (userIdentity) {
            console.log(`Benutzer "${userId}" existiert bereits im Wallet C.`);
            return;
        }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) {
            console.log(`Admin-Benutzer "${adminUserId}" nicht im Wallet C gefunden.`);
            throw new Error(`Admin-Benutzer "${adminUserId}" nicht im Wallet C gefunden.`);
        }
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, adminUserId);
        const secret = await caClient.register({
            affiliation: affiliation, enrollmentID: userId, role: 'client'
        }, adminUser);
        const enrollment = await caClient.enroll({ enrollmentID: userId, enrollmentSecret: secret });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(userId, x509Identity);
        console.log(`Benutzer "${userId}" erfolgreich für Wallet C registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Benutzers "${userId}" für Wallet C: ${error}`);
        throw error;
    }
}
// -----------------------------------------------------------------------------
main().catch(err => {
    console.error("Ein unerwarteter Fehler ist in main() aufgetreten (unternehmenC_app_extended.js):", err);
    process.exit(1);
});