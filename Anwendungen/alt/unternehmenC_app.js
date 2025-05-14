// unternehmenC_app.js
// Dieses Skript kommt in: ~/Masterthesis/QualityUseCase/applications/unternehmenC_app.js
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

// --- Pfadkonfiguration ---
// WICHTIG: Dieser Pfad setzt voraus, dass eine Konfigurationsdatei connection-org3.json
// für Org3 existiert, nachdem Org3 zum Netzwerk hinzugefügt wurde.
const ccpPathOrg3 = path.resolve(
    __dirname, '../', '../', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org3.example.com', 'connection-org3.json'
);
const walletPath = path.join(__dirname, 'wallet'); // Das gleiche Wallet-Verzeichnis

// --- Organisationsspezifische Konstanten für Org3 ---
const MSP_ID_ORG3 = 'Org3MSP';
// Der Name der CA für Org3, wie im (noch zu erstellenden) Connection Profile definiert.
const CA_NAME_ORG3 = 'ca.org3.example.com'; // Annahme für den CA-Namen

// --- Hauptfunktion ---
async function main() {
    console.log(`INFO: Versuche, Aktionen für Unternehmen C (${MSP_ID_ORG3}) auszuführen.`);
    console.log(`INFO: Stelle sicher, dass Org3MSP korrekt zum Fabric-Netzwerk hinzugefügt wurde und das Connection Profile unter ${ccpPathOrg3} existiert.`);

    try {
        // Überprüfe, ob das Connection Profile für Org3 existiert
        if (!fs.existsSync(ccpPathOrg3)) {
            console.error(`FEHLER: Connection Profile für Org3 nicht gefunden unter: ${ccpPathOrg3}`);
            console.error(`Bitte stelle sicher, dass Org3 zum Netzwerk hinzugefügt und das Profil generiert wurde.`);
            process.exit(1);
        }

        const ccpOrg3FileContent = fs.readFileSync(ccpPathOrg3, 'utf8');
        const ccpOrg3 = JSON.parse(ccpOrg3FileContent);

        const caInfoOrg3 = ccpOrg3.certificateAuthorities[CA_NAME_ORG3];
        if (!caInfoOrg3) {
            throw new Error(`Certificate Authority ${CA_NAME_ORG3} nicht im Connection Profile für Org3 gefunden.`);
        }
        const caClientOrg3 = new FabricCAServices(caInfoOrg3.url);

        const wallet = await Wallets.newFileSystemWallet(walletPath);

        // Admin für Org3 registrieren und enrollen
        // Annahme: Die CA für Org3 ist aktiv und hat einen 'admin'/'adminpw' Benutzer
        await enrollAdmin(wallet, caClientOrg3, MSP_ID_ORG3, 'adminOrg3');

        // Anwendungsbenutzer für Org3 registrieren und enrollen
        const appUserOrg3IdentityLabel = 'appUserOrg3';
        await registerAndEnrollUser(wallet, caClientOrg3, MSP_ID_ORG3, appUserOrg3IdentityLabel, 'adminOrg3', 'org3.department1'); // Annahme für Affiliation

        const gatewayOrg3 = new Gateway();
        await gatewayOrg3.connect(ccpOrg3, {
            wallet,
            identity: appUserOrg3IdentityLabel,
            discovery: { enabled: true, asLocalhost: true }
        });

        const network = await gatewayOrg3.getNetwork('mychannel'); // Annahme: Org3 ist Mitglied im 'mychannel'
        const contract = network.getContract('dpptransfer'); // Name deines Chaincodes

        // --- Szenario für Unternehmen C ---
        // Unternehmen C muss die ID des DPPs kennen, der ihm von Unternehmen B transferiert wurde.
        // Diese ID muss mit der ID übereinstimmen, die von unternehmenA_app.js erstellt und von unternehmenB_app.js weitergeleitet wurde.
        const dppIdFromOrgB = "DPP_NODE_1747226258045"; // <<----- BITTE DIESE ID MIT DER AKTUELLEN ID VOM LETZTEN LAUF VON UNTERNEHMEN A/B ERSETZEN
                                                       
        if (dppIdFromOrgB && dppIdFromOrgB.startsWith("DPP_NODE_")) {
            console.log(`\n--> Unternehmen C (${MSP_ID_ORG3}): Lese den von Unternehmen B transferierten DPP "${dppIdFromOrgB}"...`);
            try {
                let dppResultBytes = await contract.evaluateTransaction('QueryDPP', dppIdFromOrgB);
                let dppEmpfangenVonB = JSON.parse(dppResultBytes.toString());
                console.log(`Unternehmen C: DPP "${dppIdFromOrgB}" empfangene Daten: ${JSON.stringify(dppEmpfangenVonB, null, 2)}`);

                if (dppEmpfangenVonB.eigentuemerOrg === MSP_ID_ORG3) {
                    console.log(`Unternehmen C: Bestätigt - Wir (${MSP_ID_ORG3}) sind der Eigentümer von DPP "${dppIdFromOrgB}".`);
                    console.log("   Der DPP enthält folgende Testergebnisse:");
                    if (dppEmpfangenVonB.testergebnisse && dppEmpfangenVonB.testergebnisse.length > 0) {
                        dppEmpfangenVonB.testergebnisse.forEach((test, index) => {
                            console.log(`     Test ${index + 1}: ${test.testName} (durchgeführt von ${test.durchfuehrendeOrg}) - Ergebnis: ${test.ergebnis}`);
                        });
                    } else {
                        console.log("     Keine Testergebnisse im DPP gefunden.");
                    }

                    // Unternehmen C könnte nun eigene Aktionen durchführen:
                    // 1. Eigene Tests hinzufügen (mit AddTestData)
                    // 2. Den Empfang explizit bestätigen (neue Chaincode-Funktion, z.B. ConfirmReception)
                    // 3. Den DPP an einen Endkunden oder eine weitere Verarbeitungsstufe transferieren

                    console.log(`\n--> Unternehmen C (${MSP_ID_ORG3}): Simuliert eine Bestätigung des DPP-Empfangs.`);
                    // Hier könnte z.B. eine Statusänderung oder ein neuer Eintrag im DPP erfolgen.
                    // Fürs Erste reicht die Bestätigung auf der Konsole.
                    // Beispiel für eine zukünftige Erweiterung:
                    // await contract.submitTransaction('AddTestData', dppIdFromOrgB, "Empfangsbestätigung OrgC", "Ware OK", "-", "ERP-C", new Date().toISOString(), "Logistik C");
                    // console.log("Unternehmen C: Empfangsbestätigung zum DPP hinzugefügt.");

                } else {
                    console.error(`FEHLER: Unternehmen C (${MSP_ID_ORG3}) ist nicht der Eigentümer von DPP "${dppIdFromOrgB}". Aktueller Eigentümer: ${dppEmpfangenVonB.eigentuemerOrg}`);
                }
            } catch (queryError) {
                 console.error(`FEHLER beim Abfragen des DPPs "${dppIdFromOrgB}" durch Unternehmen C: ${queryError.message}`);
                 if(queryError.stack) {console.error(queryError.stack);}
                 console.error(`   Stelle sicher, dass die ID "${dppIdFromOrgB}" korrekt ist, der DPP existiert, an ${MSP_ID_ORG3} transferiert wurde und Org3 Zugriff auf den Channel hat.`);
            }
        } else {
            console.warn(`\nWARNUNG: Die Variable 'dppIdFromOrgB' im Skript ('${dppIdFromOrgB}') scheint nicht mit einer gültigen DPP-ID ersetzt worden zu sein. Bitte anpassen.`);
        }

        await gatewayOrg3.disconnect();
        console.log(`\nUnternehmen C (${MSP_ID_ORG3}): Aktionen abgeschlossen und Verbindung getrennt.`);

    } catch (error) {
        console.error(`Fehler in der Unternehmen C Anwendung: ${error}`);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// --- Hilfsfunktionen (identisch zu den anderen Skripten) ---
async function enrollAdmin(wallet, caClient, mspId, adminIdLabel) {
    try {
        const adminIdentity = await wallet.get(adminIdLabel);
        if (adminIdentity) {
            // console.log(`Eine Identität für den Admin-Benutzer "${adminIdLabel}" (${mspId}) existiert bereits im Wallet.`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' }); // Annahme: admin/adminpw für die neue CA
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminIdLabel, x509Identity);
        console.log(`Admin-Benutzer "${adminIdLabel}" (${mspId}) erfolgreich enrollt und im Wallet gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim Enrollment des Admin-Benutzers "${adminIdLabel}" (${mspId}): ${error}`);
        throw error;
    }
}

async function registerAndEnrollUser(wallet, caClient, mspId, userIdLabel, adminIdLabel, affiliation) {
    try {
        const userIdentity = await wallet.get(userIdLabel);
        if (userIdentity) {
            // console.log(`Eine Identität für den Benutzer "${userIdLabel}" (${mspId}) existiert bereits im Wallet.`);
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
            enrollmentSecret = await caClient.register({
                affiliation: affiliation, enrollmentID: userIdLabel, role: 'client'
            }, adminUser);
        } catch (registerError) {
            const isAlreadyRegisteredError = (registerError.details && registerError.details.some(detail => detail.code === 74)) ||
                                           (registerError.message && registerError.message.includes('is already registered'));
            if (isAlreadyRegisteredError) {
                enrollmentSecret = userIdLabel; 
            } else {
                throw registerError; 
            }
        }
        const enrollment = await caClient.enroll({
            enrollmentID: userIdLabel, enrollmentSecret: enrollmentSecret
        });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(userIdLabel, x509Identity);
        console.log(`Benutzer "${userIdLabel}" (${mspId}) erfolgreich registriert, enrollt und im Wallet gespeichert.`);
    } catch (error) {
        console.error(`Gesamtfehler im registerAndEnrollUser für "${userIdLabel}" (${mspId}): ${error.message}`);
        throw error;
    }
}

// Starte die Hauptfunktion
main();
