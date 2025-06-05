// -----------------------------------------------------------------------------
// unternehmenD_app_v2.js – Tier-1/Spritzgießer (Org4MSP = Unternehmen D)
// Empfängt Compound-DPP von C, prüft Transport-Log, bestätigt und führt Eingangsprüfung durch.
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

// --- Pfade & Konstanten für Org4 (Unternehmen D) ---
const ccpPathOrg4 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org4.example.com',
    'connection-org4.json'
);
const walletPathOrgD = path.join(__dirname, 'walletD');
const MSP_ID_ORG4 = 'Org4MSP';
const CA_NAME_ORG4 = 'ca.org4.example.com';
const ADMIN_ID_ORG4 = 'adminOrg4';
const APP_USER_ID_ORG4 = 'appUserOrg4D';
const GLN_ORG_D = '4011111000009'; // GLN von Unternehmen D (Empfangsort)

// --- Hilfsfunktionen (aus unternehmenA_app_v2.js übernommen und angepasst) ---
async function checkWallet(wallet, identityLabel) {
    return await wallet.get(identityLabel);
}

async function enrollAdmin(wallet, caClient, mspId, adminUserId) {
    try {
        if (await checkWallet(wallet, adminUserId)) {
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
        console.error(`Fehler beim Registrieren des Admin-Benutzers "${adminUserId}" für Wallet D: ${error.message}`);
        throw error;
    }
}

async function registerAndEnrollUser(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        if (await checkWallet(wallet, userId)) {
            console.log(`Benutzer "${userId}" existiert bereits im Wallet D.`);
            return;
        }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) {
            throw new Error(`Admin-Benutzer "${adminUserId}" nicht im Wallet D gefunden.`);
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
        console.log(`Benutzer "${userId}" erfolgreich für Wallet D registriert und gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Registrieren des Benutzers "${userId}" für Wallet D: ${error.message}`);
        throw error;
    }
}

async function queryAndLogDPP(contract, dppId, contextMessage) {
    console.log(`\n--- [INFO] ${contextMessage} - Aktueller Status von ${dppId} ---`);
    const dppBytes = await contract.evaluateTransaction('QueryDPP', dppId);
    const dpp = JSON.parse(dppBytes.toString());
    console.log(`Status: ${dpp.status}, Owner: ${dpp.ownerOrg}`);
    if (dpp.status === "Blocked") {
        console.error(`ACHTUNG: DPP ${dppId} ist blockiert!`);
    }
    return dpp;
}


// --- Hauptablauf ---
async function main() {
    let gateway;
    try {
        // DPP ID von Unternehmen C als Kommandozeilenargument
        const dppIdFromC_actual = process.argv[2]; 
        if (!dppIdFromC_actual || dppIdFromC_actual === 'DPP_C_xxxxxxxxxxxxx' || !dppIdFromC_actual.startsWith('DPP_C_')) {
            console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
            console.error("FEHLER: Bitte eine gültige DPP ID von Unternehmen C als Kommandozeilenargument angeben!");
            console.error("Aufruf z.B.: node unternehmenD_app_v2.js DPP_C_1234567890123");
            console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
            process.exit(1);
        }
        console.log(`Unternehmen D verarbeitet DPP: ${dppIdFromC_actual}`);


        // Wallet und CA-Client initialisieren
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg4, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG4];
        if (!caInfo) throw new Error(`CA ${CA_NAME_ORG4} nicht in ${ccpPathOrg4} gefunden.`);
        if (!caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) throw new Error(`tlsCACerts.pem nicht für CA ${CA_NAME_ORG4} in ${ccpPathOrg4} gefunden.`);
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPathOrgD);
        console.log(`Wallet Pfad für Unternehmen D: ${walletPathOrgD}`);
        await enrollAdmin(wallet, ca, MSP_ID_ORG4, ADMIN_ID_ORG4);
        await registerAndEnrollUser(wallet, ca, MSP_ID_ORG4, APP_USER_ID_ORG4, ADMIN_ID_ORG4, 'org4.department1');

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet, identity: APP_USER_ID_ORG4, discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2');

        console.log(`\n--> [D] QueryDPP ${dppIdFromC_actual} (empfangen von C)`);
        let dpp = await queryAndLogDPP(contract, dppIdFromC_actual, `Status von ${dppIdFromC_actual} bei Ankunft bei D`);

        const expectedStatusPrefix = `InTransitTo_${MSP_ID_ORG4}`;
        if (dpp.ownerOrg !== MSP_ID_ORG4 || !dpp.status.startsWith(expectedStatusPrefix)) {
            throw new Error(`DPP ${dppIdFromC_actual} ist nicht korrekt an ${MSP_ID_ORG4} transferiert. Aktuell: Owner ${dpp.ownerOrg}, Status ${dpp.status}.`);
        }
        console.log(`✓ DPP ${dppIdFromC_actual} ist korrekt an ${MSP_ID_ORG4} unterwegs.`);

        // Transport-Log und Qualitäts-Historie anzeigen
        if (dpp.transportLog && dpp.transportLog.length > 0) {
            console.log(`\n---> [D] Empfangener Transport-Log für DPP ${dppIdFromC_actual}:`);
            dpp.transportLog.forEach((logEntry, index) => {
                console.log(`    ${index + 1}. Typ: ${logEntry.logType}, Wert/Info: ${logEntry.value}, Status: ${logEntry.status}, System: ${logEntry.responsibleSystem || 'N/A'}, Ref: ${logEntry.offChainLogRef || 'N/A'}`);
                if (logEntry.status && logEntry.status.includes("ALERT")) {
                    console.warn(`       WARNUNG: Transport-Alert im Logeintrag ${index + 1} gefunden! (${logEntry.status})`);
                }
            });
        } else {
            console.log(`\n---> [D] Kein expliziter Transport-Log im DPP ${dppIdFromC_actual} gefunden.`);
        }
        if (dpp.status.includes("TransportAlert")) { // Prüft, ob der DPP-Status selbst den Alert enthält
             console.warn(`       WARNUNG: DPP-Status ${dpp.status} zeigt einen Transport-Alert!`);
        }

        console.log(`\n---> [D] Prüfung der inhärenten Qualitätshistorie von DPP ${dppIdFromC_actual}:`);
        if (dpp.quality && dpp.quality.length > 0) {
            dpp.quality.forEach((qe, index) => {
                console.log(`    ${index + 1}. Test: ${qe.testName}, Ergebnis: ${qe.result} ${qe.unit || ''}, Bewertung: ${qe.evaluationOutcome || 'N/A'}, Org: ${qe.performingOrg}`);
            });
        } else {
            console.log("    Keine expliziten Qualitätseinträge im DPP gefunden.");
        }

        let acceptGoods = true;
        let reasonForRejection = "";
        if (dpp.status.includes("TransportAlert") || (dpp.transportLog && dpp.transportLog.some(tl => tl.status.includes("ALERT")))) {
            console.log(`    ENTSCHEIDUNG: Ware ${dppIdFromC_actual} wird aufgrund von Transport-Alerts genauer geprüft. Für Prototyp: Annahme unter Vorbehalt / oder Ablehnung simulieren.`);
            // Hier könnte eine Logik stehen, die acceptGoods auf false setzt.
            // Für den Prototyp belassen wir acceptGoods = true, um den Fluss bis zum Ende zu sehen,
            // aber der Status des DPPs wird den Alert widerspiegeln.
            // acceptGoods = false; 
            // reasonForRejection = "Transportbedingungen nicht eingehalten.";
        }
        
        const incomingInspectionD = {
            testName: 'Eingangsprüfung Compound Sichtprüfung (D)',
            result: acceptGoods ? 'OK, trotz Transport-Alerts angenommen' : `Abgelehnt: ${reasonForRejection}`,
            unit: "", systemId: 'ERP-D-WARENEINGANG', responsible: 'Qualitätsteam D',
            evaluationOutcome: acceptGoods ? "PASS" : "FAIL", // Einfache Bewertung der Eingangsprüfung
        };

        console.log(`\n--> [D] AcknowledgeReceiptAndRecordInspection für DPP ${dppIdFromC_actual}`);
        await contract.submitTransaction(
            'AcknowledgeReceiptAndRecordInspection',
            dppIdFromC_actual,
            GLN_ORG_D,
            JSON.stringify(incomingInspectionD)
        );
        console.log(`✓ Empfang von DPP ${dppIdFromC_actual} durch D verarbeitet.`);
        
        const finalDppAtD = await queryAndLogDPP(contract, dppIdFromC_actual, `Finaler Zustand von DPP ${dppIdFromC_actual} bei D`);
        console.log(`\n[DPP-Inhalt bei D nach Annahme - ${dppIdFromC_actual}]\n`, JSON.stringify(finalDppAtD, null, 2));


    } catch (error) {
        console.error(`[D] FEHLER: ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await gateway.disconnect();
            console.log('\n[D] Gateway getrennt – Unternehmen D Demo beendet');
        }
    }
}

// Hilfsfunktion zum parsen der Kommandozeilenargumente für DPP IDs
if (require.main === module) {
    main();
}
