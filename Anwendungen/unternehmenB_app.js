// unternehmenB_app.js
// Dieses Skript kommt in: ~/Masterthesis/QualityUseCase/applications/unternehmenB_app.js
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

// --- Pfadkonfiguration ---
const ccpPathOrg2 = path.resolve(
    __dirname, '../', '../', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org2.example.com', 'connection-org2.json'
);
const walletPath = path.join(__dirname, 'wallet');

// --- Organisationsspezifische Konstanten für Org2 ---
const MSP_ID_ORG2 = 'Org2MSP';
const CA_NAME_ORG2 = 'ca.org2.example.com';

// --- Hauptfunktion ---
async function main() {
    try {
        const ccpOrg2FileContent = fs.readFileSync(ccpPathOrg2, 'utf8');
        const ccpOrg2 = JSON.parse(ccpOrg2FileContent);

        const caInfoOrg2 = ccpOrg2.certificateAuthorities[CA_NAME_ORG2];
        if (!caInfoOrg2) {
            throw new Error(`Certificate Authority ${CA_NAME_ORG2} nicht im Connection Profile gefunden.`);
        }
        const caClientOrg2 = new FabricCAServices(caInfoOrg2.url);

        const wallet = await Wallets.newFileSystemWallet(walletPath);

        await enrollAdmin(wallet, caClientOrg2, MSP_ID_ORG2, 'adminOrg2');

        const appUserOrg2IdentityLabel = 'appUserOrg2';
        await registerAndEnrollUser(wallet, caClientOrg2, MSP_ID_ORG2, appUserOrg2IdentityLabel, 'adminOrg2', 'org2.department1');

        const gatewayOrg2 = new Gateway();
        await gatewayOrg2.connect(ccpOrg2, {
            wallet,
            identity: appUserOrg2IdentityLabel,
            discovery: { enabled: true, asLocalhost: true }
        });

        const network = await gatewayOrg2.getNetwork('mychannel');
        const contract = network.getContract('dpptransfer'); //Name des Chaincodes

        // Szenario 1: Abfrage eines DPPs, der durch InitLedger erstellt wurde
        const dppInitIdOrg2 = "DPP_INIT_002";
        console.log(`\n--> Unternehmen B (Org2): Versuche, initialen DPP "${dppInitIdOrg2}" zu lesen...`);
        try {
            let dppInitResultBytes = await contract.evaluateTransaction('QueryDPP', dppInitIdOrg2);
            const dppInitOrg2 = JSON.parse(dppInitResultBytes.toString());
            console.log(`Unternehmen B: Initialer DPP "${dppInitIdOrg2}" Daten: ${JSON.stringify(dppInitOrg2, null, 2)}`);
            if (dppInitOrg2.eigentuemerOrg !== MSP_ID_ORG2) {
                 console.warn(`WARNUNG: Der initiale DPP "${dppInitIdOrg2}" gehört nicht Org2MSP, sondern ${dppInitOrg2.eigentuemerOrg}.`);
            }
        } catch (initQueryError) {
            console.warn(`Unternehmen B: Konnte initialen DPP "${dppInitIdOrg2}" nicht abfragen. Fehlermeldung: ${initQueryError.message}`);
            console.warn(`   Mögliche Ursachen: InitLedger wurde nicht korrekt beim Chaincode-Deployment ausgeführt oder erstellt diesen DPP nicht für Org2MSP.`);
        }

        // Szenario 2: Abfrage des DPPs, der von Unternehmen A transferiert wurde.
        // WICHTIG: Diese ID muss mit der ID übereinstimmen, die vom letzten erfolgreichen Lauf von unternehmenA_app.js ausgegeben wurde!
        const dppIdTransferred = "DPP_NODE_1746794661038"; // <<----- BITTE DIESE ID PRÜFEN UND MIT DER AKTUELLEN ID VOM LAUF VON UNTERNEHMEN A ERSETZEN
                                                       
        if (dppIdTransferred && dppIdTransferred.startsWith("DPP_NODE_")) {
            console.log(`\n--> Unternehmen B (Org2): Lese den von Unternehmen A transferierten DPP "${dppIdTransferred}"...`);
            try {
                let dppResultBytes = await contract.evaluateTransaction('QueryDPP', dppIdTransferred);
                let dppAktuell = JSON.parse(dppResultBytes.toString());
                console.log(`Unternehmen B: DPP "${dppIdTransferred}" empfangene Daten: ${JSON.stringify(dppAktuell, null, 2)}`);

                if (dppAktuell.eigentuemerOrg === MSP_ID_ORG2) {
                    console.log(`Unternehmen B: Bestätigt - Wir (${MSP_ID_ORG2}) sind der Eigentümer von DPP "${dppIdTransferred}".`);
                    
                    // NEUER TEIL: Unternehmen B fügt eigene Testdaten hinzu
                    console.log(`\n--> Unternehmen B (Org2): Füge eigene Testdaten (z.B. Eingangsprüfung) zu DPP "${dppIdTransferred}" hinzu...`);
                    const testNameB = "Eingangsprüfung Materialreinheit";
                    const ergebnisB = "99.8%";
                    const einheitB = "Reinheit";
                    const systemIDB = "LAB-B-Eingang";
                    const timestampB = new Date().toISOString();
                    const verantwortlichB = "Hr. Schmidt (Org2)";

                    await contract.submitTransaction('AddTestData', dppIdTransferred, testNameB, ergebnisB, einheitB, systemIDB, timestampB, verantwortlichB);
                    console.log(`Unternehmen B: Eigene Testdaten "${testNameB}" erfolgreich zu DPP "${dppIdTransferred}" hinzugefügt.`);

                    // Optional: Weiteres Testergebnis von Unternehmen B (z.B. nach Verarbeitung)
                    console.log(`\n--> Unternehmen B (Org2): Füge Testdaten nach Verarbeitung (z.B. Spritzguss) zu DPP "${dppIdTransferred}" hinzu...`);
                    await contract.submitTransaction('AddTestData', dppIdTransferred, "Prüfung Formteil XYZ", "Maßhaltig", "-", "Produktion-B-Linie5", new Date().toISOString(), "Team Spritzguss B");
                    console.log(`Unternehmen B: Testdaten "Prüfung Formteil XYZ" erfolgreich zu DPP "${dppIdTransferred}" hinzugefügt.`);


                    // --- GEÄNDERTER TEIL: Transfer an Unternehmen C (Org3MSP) ---
                    const dppWeiterTransferZiel = "Org3MSP"; // Ziel ist jetzt Unternehmen C
                    console.log(`\n--> Unternehmen B (Org2): Versuche, DPP "${dppIdTransferred}" (jetzt mit Daten von A und B) an ${dppWeiterTransferZiel} (Unternehmen C) zu transferieren...`);
                    await contract.submitTransaction('TransferDPP', dppIdTransferred, dppWeiterTransferZiel);
                    console.log(`Unternehmen B: DPP "${dppIdTransferred}" erfolgreich an ${dppWeiterTransferZiel} transferiert.`);

                    // Optional: DPP nach dem Transfer an OrgC erneut lesen (aus Sicht von OrgB)
                    console.log(`\n--> Unternehmen B (Org2): Lese DPP "${dppIdTransferred}" nach Transfer an ${dppWeiterTransferZiel}...`);
                    dppResultBytes = await contract.evaluateTransaction('QueryDPP', dppIdTransferred);
                    const dppNachTransferAnC = JSON.parse(dppResultBytes.toString());
                    console.log(`Unternehmen B: DPP "${dppIdTransferred}" Daten nach Transfer an ${dppWeiterTransferZiel}: ${JSON.stringify(dppNachTransferAnC, null, 2)}`);
                    if (dppNachTransferAnC.eigentuemerOrg !== 'Org3MSP') {
                        console.error(`FEHLER: Eigentümer wurde nicht korrekt auf ${dppWeiterTransferZiel} gesetzt! Aktuell: ${dppNachTransferAnC.eigentuemerOrg}`);
                    }

                } else {
                    console.error(`FEHLER: Unternehmen B (${MSP_ID_ORG2}) ist nicht der Eigentümer von DPP "${dppIdTransferred}". Aktueller Eigentümer: ${dppAktuell.eigentuemerOrg}`);
                }
            } catch (queryError) {
                 console.error(`FEHLER beim Verarbeiten des DPPs "${dppIdTransferred}" durch Unternehmen B: ${queryError.message}`);
                 if(queryError.stack) {console.error(queryError.stack);}
                 console.error(`   Stelle sicher, dass die ID "${dppIdTransferred}" korrekt ist und der DPP tatsächlich existiert und an ${MSP_ID_ORG2} transferiert wurde.`);
            }
        } else {
            console.warn(`\nWARNUNG: Die Variable 'dppIdTransferred' im Skript ('${dppIdTransferred}') scheint nicht mit einer gültigen, von Unternehmen A erstellten ID ersetzt worden zu sein. Bitte anpassen.`);
        }

        await gatewayOrg2.disconnect();
        console.log('\nUnternehmen B: Aktionen abgeschlossen und Verbindung getrennt.');

    } catch (error) {
        console.error(`Fehler in der Unternehmen B Anwendung: ${error}`);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

async function enrollAdmin(wallet, caClient, mspId, adminIdLabel) {
    try {
        const adminIdentity = await wallet.get(adminIdLabel);
        if (adminIdentity) {
            console.log(`Eine Identität für den Admin-Benutzer "${adminIdLabel}" (${mspId}) existiert bereits im Wallet.`);
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
        await wallet.put(adminIdLabel, x509Identity);
        console.log(`Admin-Benutzer "${adminIdLabel}" (${mspId}) erfolgreich enrollt und im Wallet gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Enrollment des Admin-Benutzers "${adminIdLabel}" (${mspId}): ${error}`);
        throw error;
    }
}

// ANGEPASSTE FUNKTION:
async function registerAndEnrollUser(wallet, caClient, mspId, userIdLabel, adminIdLabel, affiliation) {
    try {
        const userIdentity = await wallet.get(userIdLabel);
        if (userIdentity) {
            console.log(`Eine Identität für den Benutzer "${userIdLabel}" (${mspId}) existiert bereits im Wallet.`);
            return;
        }

        const adminIdentity = await wallet.get(adminIdLabel);
        if (!adminIdentity) {
            throw new Error(`Admin-Benutzer "${adminIdLabel}" (${mspId}) nicht im Wallet gefunden. Bitte zuerst Admin enrollen.`);
        }
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, adminIdLabel);

        let enrollmentSecret;
        try {
            console.log(`Versuche, Benutzer "${userIdLabel}" (${mspId}) bei der CA zu registrieren...`);
            enrollmentSecret = await caClient.register({
                affiliation: affiliation,
                enrollmentID: userIdLabel,
                role: 'client'
            }, adminUser);
            console.log(`Benutzer "${userIdLabel}" (${mspId}) erfolgreich bei der CA registriert.`);
        } catch (registerError) {
            // Fehlercode 74 bedeutet typischerweise "Identity ... is already registered" bei Fabric CA
            const isAlreadyRegisteredError = (registerError.details && registerError.details.some(detail => detail.code === 74)) ||
                                           (registerError.message && registerError.message.includes('is already registered'));

            if (isAlreadyRegisteredError) {
                console.warn(`Benutzer "${userIdLabel}" (${mspId}) ist bereits bei der CA registriert. Versuche Enrollment...`);
                // Wenn der Benutzer bereits registriert ist, haben wir hier nicht das ursprüngliche Secret.
                // Für Testumgebungen versuchen wir oft, mit dem Benutzernamen als Secret zu enrollen,
                // oder die CA ist so konfiguriert, dass ein Admin einen Benutzer neu enrollen kann.
                // Dies ist eine Vereinfachung. In Produktion würde man einen neuen Einmal-Enrollment-Secret generieren.
                enrollmentSecret = userIdLabel; // Fallback-Strategie für das Secret
            } else {
                console.error(`Fehler bei der Registrierung von Benutzer "${userIdLabel}" (${mspId}):`, registerError);
                throw registerError; // Anderen Registrierungsfehler weiterwerfen
            }
        }
        
        console.log(`Versuche, Benutzer "${userIdLabel}" (${mspId}) mit Secret "${enrollmentSecret}" zu enrollen...`);
        const enrollment = await caClient.enroll({
            enrollmentID: userIdLabel,
            enrollmentSecret: enrollmentSecret // Verwendet das Secret von der Registrierung oder den Fallback
        });

        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: mspId,
            type: 'X.509',
        };
        await wallet.put(userIdLabel, x509Identity);
        console.log(`Benutzer "${userIdLabel}" (${mspId}) erfolgreich enrollt und im Wallet gespeichert.`);

    } catch (error) {
        console.error(`Gesamtfehler im registerAndEnrollUser für "${userIdLabel}" (${mspId}): ${error.message}`);
        if (error.stack && !error.message.includes(error.stack.split('\n')[0])) { // Stack nur loggen, wenn er mehr Info gibt
            console.error(error.stack);
        }
        throw error;
    }
}

main();
