// -----------------------------------------------------------------------------
// unternehmenB_app_extended.js – Client-Demo für GS1-DPP (Org2MSP = Unternehmen B)
// Erstellt ein Glasfaser-Masterbatch, fügt Qualitätsdaten an und transferiert
// den Pass an Org3MSP. Angepasst für erweiterten Chaincode.
// Stand: Mai 2025 – getestet mit Hyperledger Fabric 2.5, Node SDK 2.2
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

// -----------------------------------------------------------------------------
// 1. Pfade & Konstanten
// -----------------------------------------------------------------------------
const ccpPathOrg2 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network', // Ggf. anpassen
    'organizations', 'peerOrganizations', 'org2.example.com',
    'connection-org2.json'
);

const walletPath = path.join(__dirname, 'walletB'); // Separates Wallet für Unternehmen B
const MSP_ID_ORG2 = 'Org2MSP';
const CA_NAME_ORG2 = 'ca.org2.example.com'; // Sicherstellen, dass dies der CA-Name in Ihrer connection-org2.json ist

// GS1-Stammdaten für Unternehmen B
const GLN_ORG2 = '4098765000007';
const GS1_COMP_PREFIX_B = '4098765'; // Eigener Prefix für B
const DEFAULT_PRODUCT_TYPE_B = 'GLASFASER_MASTERBATCH_30GF'; // Beispiel ProduktTypID für B

// Hilfsfunktion SGTIN
function makeSgtin(prefix, itemRef, serial) {
    return `urn:epc:id:sgtin:${prefix}.${itemRef}.${serial}`;
}

// -----------------------------------------------------------------------------
// 2. Hauptablauf
// -----------------------------------------------------------------------------
async function main() {
    try {
        // -- Wallet & CA ----------------------------------------------------------
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg2, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG2];
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPath);
        console.log(`Wallet Pfad für Unternehmen B: ${walletPath}`);

        await enrollAdmin(wallet, ca, MSP_ID_ORG2, 'adminOrg2');
        await registerAndEnrollUser(wallet, ca, MSP_ID_ORG2,
            'appUserOrg2B', 'adminOrg2', 'org2.department1'); // Eindeutiger User für B

        // -- Gateway --------------------------------------------------------------
        const gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: 'appUserOrg2B', // Identität von Unternehmen B
            discovery: { enabled: true, asLocalhost: true }
        });

        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2'); // Name des erweiterten Chaincodes

        // -------------------------------------------------------------------------
        // 3. DPP für Glasfaser-Masterbatch anlegen
        // -------------------------------------------------------------------------
        const now = new Date();
        const dppId = `DPP_B_${now.getTime()}`;
        const gs1Key = makeSgtin(GS1_COMP_PREFIX_B, '033445', now.getTime().toString().slice(-5));
        const batch = `BATCH_B_GF30_${now.toISOString().slice(5, 10).replace('-', '')}`;
        const prodDate = now.toISOString().slice(0, 10);

        // Beispiel Spezifikationen für ProduktTyp B (Glasfaser-Masterbatch)
        const specificationsB = [
            { testName: 'Glasfaser-Gewichtsanteil', isNumeric: true, lowerLimit: 29.5, upperLimit: 30.5, unit: 'wt-%', isMandatory: true },
            { testName: 'Melt Flow Index (230 °C / 2,16 kg)', isNumeric: true, lowerLimit: 8.0, upperLimit: 12.0, unit: 'g/10 min', isMandatory: true },
            { testName: 'Restfeuchte', isNumeric: true, lowerLimit: 0.0, upperLimit: 0.05, unit: '%', isMandatory: false }
        ];
        const specificationsB_JSON = JSON.stringify(specificationsB);

        console.log(`\n--> [B] CreateDPP ${dppId} für Produkttyp ${DEFAULT_PRODUCT_TYPE_B}`);
        await contract.submitTransaction(
            'CreateDPP',
            dppId,
            gs1Key,
            DEFAULT_PRODUCT_TYPE_B, // NEU
            GLN_ORG2,
            batch,
            prodDate,
            specificationsB_JSON    // NEU
        );
        console.log(`✓ DPP ${dppId} angelegt (GS1 ${gs1Key})`);

        let dppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', dppId)).toString());
        console.log(`Initialer Status DPP ${dppId}: ${dppState.status}`);
        console.log(`Offene mandatorische Prüfungen: ${dppState.openMandatoryChecks ? dppState.openMandatoryChecks.join(', ') : 'Keine'}`);


        // 3.1 Laborprüfung Glasfasergehalt
        const qcGF = {
            testName: 'Glasfaser-Gewichtsanteil', // Muss mit Spec übereinstimmen
            result: '30.1', // Innerhalb der Spezifikation
            unit: 'wt-%',
            systemId: 'LAB-B-FIBERTEST',
            responsible: 'Dr. Meier',
            // timestamp: new Date().toISOString() // Wird vom CC gesetzt
        };
        console.log(`\n--> [B] RecordQualityData (Glasfasergehalt) für DPP ${dppId}`);
        await contract.submitTransaction('RecordQualityData',
            dppId,
            JSON.stringify(qcGF),
            GLN_ORG2 // recordingSiteGLN
        );
        console.log('✓ GF-Anteil gespeichert');
        dppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', dppId)).toString());
        console.log(`Status DPP ${dppId} nach GF-Test: ${dppState.status}`);
        console.log(`Offene mandatorische Prüfungen: ${dppState.openMandatoryChecks ? dppState.openMandatoryChecks.join(', ') : 'Keine'}`);

        // 3.2 MFI-Test
        const qcMfi = {
            testName: 'Melt Flow Index (230 °C / 2,16 kg)', // Muss mit Spec übereinstimmen
            result: '9.8', // Innerhalb der Spezifikation
            unit: 'g/10 min',
            systemId: 'LAB-B-MFI',
            responsible: 'Dr. Meier',
        };
        console.log(`\n--> [B] RecordQualityData (MFI) für DPP ${dppId}`);
        await contract.submitTransaction('RecordQualityData',
            dppId,
            JSON.stringify(qcMfi),
            GLN_ORG2 // recordingSiteGLN
        );
        console.log('✓ MFI gespeichert');
        dppState = JSON.parse((await contract.evaluateTransaction('QueryDPP', dppId)).toString());
        console.log(`Status DPP ${dppId} nach MFI-Test: ${dppState.status}`);
        if(dppState.status === "Released") {
            console.log("Alle mandatorischen Prüfungen bestanden. DPP ist freigegeben!");
        } else {
            console.log(`Offene mandatorische Prüfungen: ${dppState.openMandatoryChecks ? dppState.openMandatoryChecks.join(', ') : 'Status nicht "Released"'}`);
        }

        // 3.3 Kontrolle des fertigen DPPs von Unternehmen B
        const dppBytes = await contract.evaluateTransaction('QueryDPP', dppId);
        console.log(`\n[DPP-Inhalt B - ${dppId}]\n`,
            JSON.stringify(JSON.parse(dppBytes.toString()), null, 2));

        // -------------------------------------------------------------------------
        // 4. Transfer an Compounder (Org3MSP = Unternehmen C)
        // -------------------------------------------------------------------------
        const nextOwnerMSP_C = 'Org3MSP';
        console.log(`\n--> [B] TransferDPP ${dppId} von ${MSP_ID_ORG2} (GLN: ${GLN_ORG2}) an ${nextOwnerMSP_C}`);
        await contract.submitTransaction(
            'TransferDPP',
            dppId,
            nextOwnerMSP_C,
            GLN_ORG2 // GLN des Versenders (Unternehmen B)
        );
        console.log(`✓ Transfer von ${dppId} an ${nextOwnerMSP_C} initiiert.`);

        // Kontrolle Status nach TransferInitiative
        const dppAfterTransferB = JSON.parse(
            (await contract.evaluateTransaction('QueryDPP', dppId)).toString()
        );
        console.log(`DPP Status nach TransferInitiative durch B: ${dppAfterTransferB.status}`);
        console.log(`Neuer (temporärer) Eigentümer laut DPP: ${dppAfterTransferB.ownerOrg}`);


        // -------------------------------------------------------------------------
        await gateway.disconnect();
        console.log('\n[B] Gateway getrennt – Unternehmen B Demo beendet');
        console.log(`WICHTIG: Bitte die DPP ID ${dppId} (GS1: ${gs1Key}) für Unternehmen C notieren!`);

    } catch (err) {
        console.error(`[B] FEHLER: ${err.stack ? err.stack : err}`);
        process.exit(1);
    }
}

// -----------------------------------------------------------------------------
// 5. Hilfsfunktionen für Admin/User-Handling (weitgehend wie bei A, nur Labels angepasst)
// -----------------------------------------------------------------------------
async function enrollAdmin(wallet, caClient, mspId, adminUserId) {
    try {
        const adminIdentity = await wallet.get(adminUserId);
        if (adminIdentity) {
            console.log(`Admin-Benutzer "${adminUserId}" existiert bereits im Wallet B.`);
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
        console.log(`Admin-Benutzer "${adminUserId}" erfolgreich für Wallet B registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Admin-Benutzers "${adminUserId}" für Wallet B: ${error}`);
        throw error;
    }
}

async function registerAndEnrollUser(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        const userIdentity = await wallet.get(userId);
        if (userIdentity) {
            console.log(`Benutzer "${userId}" existiert bereits im Wallet B.`);
            return;
        }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) {
            console.log(`Admin-Benutzer "${adminUserId}" nicht im Wallet B gefunden.`);
            throw new Error(`Admin-Benutzer "${adminUserId}" nicht im Wallet B gefunden.`);
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
        console.log(`Benutzer "${userId}" erfolgreich für Wallet B registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Benutzers "${userId}" für Wallet B: ${error}`);
        throw error;
    }
}
// -----------------------------------------------------------------------------
main().catch(err => {
    console.error("Ein unerwarteter Fehler ist in main() aufgetreten (unternehmenB_app_extended.js):", err);
    process.exit(1);
});