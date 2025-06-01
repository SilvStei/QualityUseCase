// -----------------------------------------------------------------------------
// unternehmenD_app_extended.js – Tier-1/Spritzgießer (Org4MSP = Unternehmen D)
// Empfängt Compound-DPP von C, bestätigt und führt Eingangsprüfung durch.
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
const ccpPathOrg4 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network', // Ggf. anpassen
    'organizations', 'peerOrganizations', 'org4.example.com',
    'connection-org4.json'
);

const walletPath = path.join(__dirname, 'walletD'); // Separates Wallet für Unternehmen D
const MSP_ID_ORG4 = 'Org4MSP';
const CA_NAME_ORG4 = 'ca.org4.example.com'; // Sicherstellen, dass dies der CA-Name in Ihrer connection-org4.json ist

// GS1-Stammdaten für Unternehmen D
const GLN_ORG4 = '4011111000009'; // Beispiel GLN für Unternehmen D

// -----------------------------------------------------------------------------
// 2. DPP-ID, die von C übertragen wurde – BITTE DIESE ID AKTUALISIEREN
//    mit der echten ID, die von unternehmenC_app_extended.js ausgegeben wurde!
// -----------------------------------------------------------------------------
const dppIdFromC_actual = 'DPP_C_1748781538580'; // <== ECHTE ID VON C EINSETZEN

// -----------------------------------------------------------------------------
// 3. Hauptablauf
// -----------------------------------------------------------------------------
async function main() {
    if (dppIdFromC_actual === 'DPP_C_xxxxxxxxxxxxx') {
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("FEHLER: Bitte aktualisieren Sie dppIdFromC_actual im Skript");
        console.error("        mit der echten DPP ID von Unternehmen C!");
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        process.exit(1);
    }

    try {
        // -------------------------------------------------------------------------
        // 3.1 Wallet & CA
        // -------------------------------------------------------------------------
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg4, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG4];
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPath);
        console.log(`Wallet Pfad für Unternehmen D: ${walletPath}`);
        await enrollAdmin(wallet, ca, MSP_ID_ORG4, 'adminOrg4');
        await registerAndEnrollUser(wallet, ca, MSP_ID_ORG4,
            'appUserOrg4D', 'adminOrg4', 'org4.department1'); // Eindeutiger User für D

        // -------------------------------------------------------------------------
        // 3.2 Gateway & Contract
        // -------------------------------------------------------------------------
        const gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: 'appUserOrg4D', // Identität von Unternehmen D
            discovery: { enabled: true, asLocalhost: true }
        });

        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2'); // Name des erweiterten Chaincodes

        // -------------------------------------------------------------------------
        // 3.3 Compound-Pass von C empfangen und prüfen
        // -------------------------------------------------------------------------
        console.log(`\n--> [D] QueryDPP ${dppIdFromC_actual} (empfangen von C)`);
        let dppBytes = await contract.evaluateTransaction('QueryDPP', dppIdFromC_actual);
        let dpp = JSON.parse(dppBytes.toString());

        console.log(`Status von ${dppIdFromC_actual} (vor Empfang durch D): ${dpp.status}, Owner: ${dpp.ownerOrg}`);
        if (dpp.ownerOrg !== MSP_ID_ORG4 || dpp.status !== `InTransitTo_${MSP_ID_ORG4}`) {
            throw new Error(`DPP ${dppIdFromC_actual} ist nicht korrekt an ${MSP_ID_ORG4} transferiert worden oder hat falschen Status/Owner. Aktuell: Owner ${dpp.ownerOrg}, Status ${dpp.status}. Erwartet Owner ${MSP_ID_ORG4} und Status InTransitTo_${MSP_ID_ORG4}`);
        }
        console.log(`✓ DPP ${dppIdFromC_actual} ist korrekt an ${MSP_ID_ORG4} unterwegs.`);

        // Simulation: Unternehmen D prüft die Qualitätshistorie des empfangenen DPPs
        console.log(`\n---> [D] Prüfung der Qualitätshistorie von DPP ${dppIdFromC_actual}:`);
        if (dpp.quality && dpp.quality.length > 0) {
            console.log(`   Gefundene Qualitätseinträge (${dpp.quality.length}):`);
            dpp.quality.forEach((qe, index) => {
                console.log(`     ${index + 1}. Test: ${qe.testName}, Ergebnis: ${qe.result} ${qe.unit}, Bewertung: ${qe.evaluationOutcome || 'N/A'}, Org: ${qe.performingOrg}`);
            });
        } else {
            console.log("   Keine expliziten Qualitätseinträge im DPP gefunden (abgesehen von initialen Daten bei Transformation).");
        }
        // Hier könnte D entscheiden, ob die Ware basierend auf der Historie angenommen wird.
        // Für den Prototyp nehmen wir an, die Ware wird akzeptiert, wenn keine "Blocked" Status vorliegen.
        let acceptGoods = true;
        if (dpp.status.includes("Blocked")) { // Einfache Prüfung, könnte detaillierter sein
            console.log(`   WARNUNG: Der DPP ${dppIdFromC_actual} hat einen blockierenden Status (${dpp.status}) in seiner Historie oder aktuell.`);
            // acceptGoods = false; // Für den Prototyp akzeptieren wir trotzdem, um den Fluss zu zeigen
        }

        // -------------------------------------------------------------------------
        // 3.4 Empfang bestätigen und optionale Eingangsprüfung hinzufügen
        // -------------------------------------------------------------------------
        const incomingInspectionD = {
            testName: 'Eingangsprüfung Compound Granulatfeuchte',
            result: '0.03', // Beispielwert
            unit: '%',
            systemId: 'LAB-D-INCOMING_INSP',
            responsible: 'Qualitätsteam D',
            // timestamp & performingOrg werden vom CC gesetzt
        };
        const incomingInspectionD_JSON = JSON.stringify(incomingInspectionD);

        // Entscheidung über den Acknowledgement-Status (könnte auf 'acceptGoods' basieren)
        const acknowledgementStatus = acceptGoods ? "AcceptedAtRecipient" : "RejectedByRecipient_QualityIssues";

        console.log(`\n--> [D] AcknowledgeReceiptAndRecordInspection für DPP ${dppIdFromC_actual} mit Status: ${acknowledgementStatus}`);
        await contract.submitTransaction(
            'AcknowledgeReceiptAndRecordInspection',
            dppIdFromC_actual,
            GLN_ORG4, // recipientGLN (GLN von D)
            incomingInspectionD_JSON // Optionale Eingangsprüfung durch D
        );
        console.log(`✓ Empfang von DPP ${dppIdFromC_actual} durch D bestätigt. Eingangsprüfung hinzugefügt.`);

        // -------------------------------------------------------------------------
        // 3.5 Abschlusskontrolle des DPPs bei Unternehmen D
        // -------------------------------------------------------------------------
        const dppAfterReceiptD = JSON.parse(
            (await contract.evaluateTransaction('QueryDPP', dppIdFromC_actual)).toString()
        );
        console.log(`\n[DPP-Inhalt bei D nach Empfang und Eingangsprüfung - ${dppIdFromC_actual}]\n`,
            JSON.stringify(dppAfterReceiptD, null, 2));
        console.log(`Finaler Status DPP ${dppIdFromC_actual} bei D: ${dppAfterReceiptD.status}`);
        console.log(`Finaler Owner DPP ${dppIdFromC_actual} bei D: ${dppAfterReceiptD.ownerOrg}`);


        // Hier könnte Unternehmen D den DPP weiterverarbeiten, wenn es ein Endprodukt herstellt,
        // z.B. durch eine weitere Transformation oder durch Hinzufügen von Produktions-EPCIS-Events
        // zum bestehenden (jetzt eigenen) DPP. Für diesen Prototyp endet der Fluss hier.

        // -------------------------------------------------------------------------
        await gateway.disconnect();
        console.log('\n[D] Gateway getrennt – Unternehmen D Demo beendet');

    } catch (err) {
        console.error(`[D] FEHLER: ${err.stack ? err.stack : err}`);
        process.exit(1);
    }
}

// -----------------------------------------------------------------------------
// 4. Hilfsfunktionen für Admin/User-Handling (analog zu A, B, C)
// -----------------------------------------------------------------------------
async function enrollAdmin(wallet, caClient, mspId, adminUserId) {
    try {
        const adminIdentity = await wallet.get(adminUserId);
        if (adminIdentity) {
            console.log(`Admin-Benutzer "${adminUserId}" existiert bereits im Wallet D.`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminUserId, x509Identity);
        console.log(`Admin-Benutzer "${adminUserId}" erfolgreich für Wallet D registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Admin-Benutzers "${adminUserId}" für Wallet D: ${error}`);
        throw error;
    }
}

async function registerAndEnrollUser(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        const userIdentity = await wallet.get(userId);
        if (userIdentity) {
            console.log(`Benutzer "${userId}" existiert bereits im Wallet D.`);
            return;
        }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) {
            console.log(`Admin-Benutzer "${adminUserId}" nicht im Wallet D gefunden.`);
            throw new Error(`Admin-Benutzer "${adminUserId}" nicht im Wallet D gefunden.`);
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
        console.log(`Benutzer "${userId}" erfolgreich für Wallet D registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Benutzers "${userId}" für Wallet D: ${error}`);
        throw error;
    }
}
// -----------------------------------------------------------------------------
main().catch(err => {
    console.error("Ein unerwarteter Fehler ist in main() aufgetreten (unternehmenD_app_extended.js):", err);
    process.exit(1);
});