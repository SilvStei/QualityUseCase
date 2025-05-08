// unternehmenA_app.js
// Dieses Skript kommt in: ~/Masterthesis/QualityUseCase/applications/unternehmenA_app.js
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

// --- Pfadkonfiguration ---
// Pfad zum Connection Profile von Org1
const ccpPathOrg1 = path.resolve(
    __dirname, // Aktuelles Verzeichnis (QualityUseCase/applications)
    '..',      // Ein Verzeichnis hoch (QualityUseCase)
    '..',      // Noch ein Verzeichnis hoch (Masterthesis)
    'fabric-samples',
    'test-network',
    'organizations',
    'peerOrganizations',
    'org1.example.com',
    'connection-org1.json'
);

// Pfad zum Wallet-Verzeichnis (innerhalb des applications-Ordners)
const walletPath = path.join(__dirname, 'wallet');

// --- Organisationsspezifische Konstanten für Org1 ---
const MSP_ID_ORG1 = 'Org1MSP';
// Der Name der CA für Org1, wie im Connection Profile definiert.
// Für das test-network ist dies typischerweise 'ca.org1.example.com'.
const CA_NAME_ORG1 = 'ca.org1.example.com'; // Überprüfe diesen Namen im ccpPathOrg1, falls Fehler auftreten

// --- Hauptfunktion ---
async function main() {
    try {
        // 1. Lade das Connection Profile für Org1
        const ccpOrg1FileContent = fs.readFileSync(ccpPathOrg1, 'utf8');
        const ccpOrg1 = JSON.parse(ccpOrg1FileContent);

        // 2. Richte den CA-Client für Org1 ein
        // Die URL der CA wird aus dem Connection Profile gelesen.
        const caInfoOrg1 = ccpOrg1.certificateAuthorities[CA_NAME_ORG1];
        if (!caInfoOrg1) {
            throw new Error(`Certificate Authority ${CA_NAME_ORG1} nicht im Connection Profile gefunden.`);
        }
        const caClientOrg1 = new FabricCAServices(caInfoOrg1.url);

        // 3. Richte das Wallet ein (verwendet das Dateisystem)
        const wallet = await Wallets.newFileSystemWallet(walletPath);

        // 4. Registriere und enrolle den Admin-Benutzer für Org1 (falls noch nicht im Wallet)
        // Der Admin wird benötigt, um andere Anwendungsbenutzer zu registrieren.
        // Das 'test-network' Skript erstellt einen Admin mit Benutzername 'admin' und Passwort 'adminpw'.
        await enrollAdmin(wallet, caClientOrg1, MSP_ID_ORG1, 'adminOrg1'); // Eindeutiger Wallet-Name für Admin von Org1

        // 5. Registriere und enrolle einen Anwendungsbenutzer für Org1 (falls noch nicht im Wallet)
        const appUserOrg1IdentityLabel = 'appUserOrg1'; // Eindeutiger Wallet-Name für den App-User von Org1
        await registerAndEnrollUser(wallet, caClientOrg1, MSP_ID_ORG1, appUserOrg1IdentityLabel, 'adminOrg1', 'org1.department1');

        // 6. Erstelle eine Gateway-Verbindung zum Netzwerk für Org1
        const gatewayOrg1 = new Gateway();
        await gatewayOrg1.connect(ccpOrg1, {
            wallet,
            identity: appUserOrg1IdentityLabel, // Die Identität, die für Transaktionen verwendet wird
            discovery: { enabled: true, asLocalhost: true } // Service Discovery verwenden
        });

        // 7. Hole den Netzwerk-Channel (z.B. 'mychannel')
        const network = await gatewayOrg1.getNetwork('mychannel'); // 'mychannel' ist der Standardkanal im test-network

        // 8. Hole den Smart Contract (Chaincode) vom Channel
        // 'dpptransfer' ist der Name, den wir beim Deployment mit '-ccn dpptransfer' vergeben haben.
        const contract = network.getContract('dpptransfer');

        // --- Szenario für Unternehmen A ---
        const dppId = `DPP_NODE_${Date.now()}`; // Erzeugt eine halbwegs eindeutige ID für Tests

        console.log(`\n--> Unternehmen A (Org1): Erstelle DPP "${dppId}"...`);
        // Die Funktion 'CreateDPP' im Chaincode erwartet: id, beschreibung, status
        await contract.submitTransaction('CreateDPP', dppId, 'Hochwertiges Kunststoffgranulat Typ A', 'ErstelltBeiOrg1');
        console.log(`Unternehmen A: DPP "${dppId}" erfolgreich erstellt.`);

        console.log(`\n--> Unternehmen A (Org1): Lese DPP "${dppId}"...`);
        let dppResultBytes = await contract.evaluateTransaction('QueryDPP', dppId);
        console.log(`Unternehmen A: DPP "${dppId}" Daten: ${dppResultBytes.toString()}`);

        console.log(`\n--> Unternehmen A (Org1): Transferiere DPP "${dppId}" an Unternehmen B (Org2MSP)...`);
        // Die Funktion 'TransferDPP' im Chaincode erwartet: id, neueEigentuemerOrgMSP
        await contract.submitTransaction('TransferDPP', dppId, 'Org2MSP');
        console.log(`Unternehmen A: DPP "${dppId}" erfolgreich an Org2MSP transferiert.`);

        console.log(`\n--> Unternehmen A (Org1): Lese DPP "${dppId}" nach Transfer (Eigentümer sollte Org2MSP sein)...`);
        dppResultBytes = await contract.evaluateTransaction('QueryDPP', dppId);
        const dppNachTransfer = JSON.parse(dppResultBytes.toString());
        console.log(`Unternehmen A: DPP "${dppId}" Daten nach Transfer: ${JSON.stringify(dppNachTransfer, null, 2)}`);
        if (dppNachTransfer.eigentuemerOrg !== 'Org2MSP') {
            console.error("FEHLER: Eigentümer wurde nicht korrekt auf Org2MSP gesetzt!");
        }

        // 9. Trenne die Gateway-Verbindung
        await gatewayOrg1.disconnect();
        console.log('\nUnternehmen A: Aktionen abgeschlossen und Verbindung getrennt.');

    } catch (error) {
        console.error(`Fehler in der Unternehmen A Anwendung: ${error}`);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// --- Hilfsfunktionen für Benutzerregistrierung und -enrollment ---

/**
 * Registriert und enrollt einen Admin-Benutzer, falls er noch nicht im Wallet existiert.
 * @param {Wallet} wallet Das Wallet-Objekt.
 * @param {FabricCAServices} caClient Der CA-Client für die Organisation.
 * @param {string} mspId Die MSP ID der Organisation.
 * @param {string} adminIdLabel Das Label, unter dem die Admin-Identität im Wallet gespeichert wird.
 */
async function enrollAdmin(wallet, caClient, mspId, adminIdLabel) {
    try {
        const adminIdentity = await wallet.get(adminIdLabel);
        if (adminIdentity) {
            console.log(`Eine Identität für den Admin-Benutzer "${adminIdLabel}" (${mspId}) existiert bereits im Wallet.`);
            return;
        }

        // Enrolle den Admin-Benutzer. Das 'test-network' Skript registriert 'admin' mit Passwort 'adminpw'.
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
        throw error; // Fehler weiterwerfen, damit main() ihn fangen kann
    }
}

/**
 * Registriert und enrollt einen neuen Anwendungsbenutzer, falls er noch nicht im Wallet existiert.
 * Benötigt eine Admin-Identität im Wallet.
 * @param {Wallet} wallet Das Wallet-Objekt.
 * @param {FabricCAServices} caClient Der CA-Client für die Organisation.
 * @param {string} mspId Die MSP ID der Organisation.
 * @param {string} userIdLabel Das Label für den neuen Benutzer im Wallet.
 * @param {string} adminIdLabel Das Label der Admin-Identität im Wallet.
 * @param {string} affiliation Die Zugehörigkeit des Benutzers (z.B. 'org1.department1').
 */
async function registerAndEnrollUser(wallet, caClient, mspId, userIdLabel, adminIdLabel, affiliation) {
    try {
        const userIdentity = await wallet.get(userIdLabel);
        if (userIdentity) {
            console.log(`Eine Identität für den Benutzer "${userIdLabel}" (${mspId}) existiert bereits im Wallet.`);
            return;
        }

        // Die Admin-Identität wird benötigt, um neue Benutzer zu registrieren.
        const adminIdentity = await wallet.get(adminIdLabel);
        if (!adminIdentity) {
            throw new Error(`Admin-Benutzer "${adminIdLabel}" (${mspId}) nicht im Wallet gefunden. Bitte zuerst Admin enrollen.`);
        }

        // Erstelle einen Benutzerkontext für den Admin.
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, adminIdLabel); // Name des Admins im Kontext

        // Registriere den neuen Benutzer bei der CA.
        // Das affiliation-Feld ist optional, aber oft verwendet (z.B. 'org1.department1').
        const secret = await caClient.register({
            affiliation: affiliation,
            enrollmentID: userIdLabel, // Benutzername für die Registrierung
            role: 'client' // Typische Rolle für Anwendungsbenutzer
        }, adminUser); // Admin-Kontext für die Autorisierung der Registrierung

        // Enrolle den neuen Benutzer, um Zertifikate zu erhalten.
        const enrollment = await caClient.enroll({
            enrollmentID: userIdLabel,
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
        await wallet.put(userIdLabel, x509Identity);
        console.log(`Benutzer "${userIdLabel}" (${mspId}) erfolgreich registriert, enrollt und im Wallet gespeichert.`);

    } catch (error) {
        console.error(`Fehler beim Registrieren/Enrollen des Benutzers "${userIdLabel}" (${mspId}): ${error}`);
        throw error; // Fehler weiterwerfen
    }
}

// Starte die Hauptfunktion
main();

