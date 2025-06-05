// -----------------------------------------------------------------------------
// submit_transport_update.js - Verarbeitet Transport-Rohdaten und sendet Update an Blockchain.
// Simuliert einen Integrationslayer/Oracle für Transportdaten.
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { ArgumentParser } = require('argparse');

// Konfigurierbare Grenzwerte
const TRANSPORT_TEMP_LIMIT_HIGH = 30.0;
const TRANSPORT_TEMP_LIMIT_LOW = 0.0;
const TRANSPORT_SHOCK_LIMIT_G = 1.0;

function parseArgs() {
    const parser = new ArgumentParser({
        description: 'Verarbeitet Transport-Rohdaten aus einer Datei und reicht ein Update bei der Blockchain ein.'
    });
    parser.add_argument('--dpp', { help: 'DPP ID, zu der die Transportdaten gehören', required: true });
    parser.add_argument('--file', { help: 'Pfad zur CSV-Datei mit den Transport-Rohdaten', required: true });
    parser.add_argument('--org', { help: 'MSP ID der ausführenden Organisation (z.B. Org3MSP)', required: true });
    parser.add_argument('--gln', { help: 'GLN der aufzeichnenden Site/des Transportdienstleisters', required: true });
    parser.add_argument('--system', { help: 'ID des erfassenden Systems (z.B. TRANSPORT_LOGGER_001)', required: true });
    parser.add_argument('--responsible', { help: 'Verantwortliche Einheit für den Transport', default: 'Logistikabteilung' });
    return parser.parse_args();
}

// ***** BEGINN HILFSFUNKTIONEN (hier eingefügt) *****
async function getWalletPath(orgMspId) { // Umbenannt zu getWalletPath für Klarheit
    const orgShortName = orgMspId.replace('MSP', '');
    let walletDirName = `wallet${orgShortName.charAt(0).toUpperCase() + orgShortName.slice(1)}`;
     // Spezifische Wallet-Namen für den Prototyp
    if (orgShortName === "Org1") walletDirName = `walletA`;
    else if (orgShortName === "Org2") walletDirName = `walletB`;
    else if (orgShortName === "Org3") walletDirName = `walletC`;
    else if (orgShortName === "Org4") walletDirName = `walletD`;
    else { throw new Error(`Unbekannte Org MSP ID für Wallet-Pfad: ${orgMspId}`); }
    return path.join(__dirname, walletDirName);
}

async function getCcpPath(orgMspId) {
    const orgNameLowercase = orgMspId.toLowerCase().replace('msp', '');
    return path.resolve(
        __dirname, '..', '..', 'fabric-samples', 'test-network',
        'organizations', 'peerOrganizations', `${orgNameLowercase}.example.com`,
        `connection-${orgNameLowercase}.json`
    );
}

async function enrollOrgAdmin(ccp, caInfo, wallet, mspId, adminUserId) {
    try {
        const adminIdentity = await wallet.get(adminUserId);
        if (adminIdentity) { return; }
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA Info unvollständig für ${caInfo ? caInfo.caName : 'unbekannte CA'}.`);
        }
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const caClient = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminUserId, x509Identity);
        console.log(`Admin-Benutzer "${adminUserId}" für ${mspId} erfolgreich registriert/gespeichert.`);
    } catch (error) { console.error(`Fehler Admin-Enrollment für ${mspId}: ${error}`); throw error; }
}

async function registerAndEnrollOrgUser(ccp, caInfo, wallet, mspId, userId, adminUserId, affiliation) {
     try {
        const userIdentity = await wallet.get(userId);
        if (userIdentity) { return; }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) { throw new Error(`Admin "${adminUserId}" für ${mspId} nicht im Wallet.`); }
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA Info unvollständig für ${caInfo ? caInfo.caName : 'unbekannte CA'}.`);
        }
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const caClient = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, adminUserId);
        const secret = await caClient.register({ affiliation, enrollmentID: userId, role: 'client' }, adminUser);
        const enrollment = await caClient.enroll({ enrollmentID: userId, enrollmentSecret: secret });
        const x509Identity = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(userId, x509Identity);
        console.log(`Benutzer "${userId}" für ${mspId} erfolgreich registriert/gespeichert.`);
    } catch (error) { console.error(`Fehler User-Registrierung für ${mspId}: ${error}`); throw error; }
}
// ***** ENDE HILFSFUNKTIONEN *****


async function main() {
    const args = parseArgs();

    console.log(`\n--> [TRANSPORT-INTEGRATION] Verarbeite Transport-Log: ${args.file}`);
    console.log(`    Für DPP: ${args.dpp}, verantwortlich: ${args.org} (GLN: ${args.gln})`);

    let gateway;
    try {
        if (!fs.existsSync(args.file)) throw new Error(`Rohdaten-Datei nicht gefunden: ${args.file}`);
        const fileContent = fs.readFileSync(args.file, 'utf8');
        const lines = fileContent.trim().split('\n');
        if (lines.length <= 1) throw new Error(`Keine Daten in Transport-Log-Datei: ${args.file}`);

        const header = lines.shift().toLowerCase().split(',');
        const tempIndex = header.indexOf('temperatur');
        const shockIndex = header.indexOf('erschuetterung_g');
        if (tempIndex === -1 || shockIndex === -1) {
            throw new Error("Spalten 'temperatur' oder 'erschuetterung_g' nicht im CSV-Header gefunden.");
        }

        let minTemp = Infinity, maxTemp = -Infinity, maxShock = 0, tempAlert = false, shockAlert = false;
        let tempSum = 0;
        const readings = lines.map(line => {
            const parts = line.split(',');
            return {
                temp: parseFloat(parts[tempIndex]),
                shock: parseFloat(parts[shockIndex])
            };
        }).filter(r => !isNaN(r.temp) && !isNaN(r.shock));

        if (readings.length === 0) throw new Error("Keine gültigen numerischen Werte in Transport-Log gefunden.");

        readings.forEach(r => {
            tempSum += r.temp;
            if (r.temp < minTemp) minTemp = r.temp;
            if (r.temp > maxTemp) maxTemp = r.temp;
            if (r.shock > maxShock) maxShock = r.shock;
            if (r.temp > TRANSPORT_TEMP_LIMIT_HIGH || r.temp < TRANSPORT_TEMP_LIMIT_LOW) tempAlert = true;
            if (r.shock > TRANSPORT_SHOCK_LIMIT_G) shockAlert = true;
        });
        const avgTemp = parseFloat((tempSum / readings.length).toFixed(1));


        let transportOutcome = "TRANSPORT_OK"; // Wird für den Chaincode-Status verwendet
        let summaryForEntry = `Transportbedingungen: Min.Temp ${minTemp}°C, Avg.Temp ${avgTemp}°C, Max.Temp ${maxTemp}°C, Max.Schock ${maxShock}g.`;

        if (tempAlert && shockAlert) {
            transportOutcome = "TRANSPORT_MULTI_ALERT";
            summaryForEntry += " KRITISCH: Temperatur UND Erschütterungsgrenzwert überschritten!";
        } else if (tempAlert) {
            transportOutcome = "TRANSPORT_TEMP_ALERT";
            summaryForEntry += " KRITISCH: Temperaturgrenzwert überschritten!";
        } else if (shockAlert) {
            transportOutcome = "TRANSPORT_SHOCK_ALERT";
            summaryForEntry += " KRITISCH: Erschütterungsgrenzwert überschritten!";
        }
        console.log(`--- [TRANSPORT-INTEGRATION] Analyse: ${summaryForEntry}, Outcome-Status: ${transportOutcome} ---`);

        const orgShortName = args.org.replace('MSP', '');
        const ccpPath = await getCcpPath(args.org); // Verwende Hilfsfunktion
        if (!fs.existsSync(ccpPath)) throw new Error(`CCP ${ccpPath} nicht gefunden für ${args.org}`);
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));
        
        const orgCcpName = orgShortName.charAt(0).toUpperCase() + orgShortName.slice(1);
        if (!ccp.organizations[orgCcpName] || !ccp.organizations[orgCcpName].certificateAuthorities || ccp.organizations[orgCcpName].certificateAuthorities.length === 0) {
            throw new Error (`Keine certificateAuthorities für ${orgCcpName} in ${ccpPath} gefunden.`);
        }
        const caNameFromCcp = ccp.organizations[orgCcpName].certificateAuthorities[0];
        const caInfo = ccp.certificateAuthorities[caNameFromCcp];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA Info/tlsCACerts.pem unvollständig für ${caNameFromCcp} in ${ccpPath}.`);
        }

        const walletStoragePath = await getWalletPath(args.org); // Verwende Hilfsfunktion
        const wallet = await Wallets.newFileSystemWallet(walletStoragePath);
        const adminUserId = `admin${orgShortName}`;
        const appUserId = `appUser${orgShortName}_TransportIntegration`; // Eindeutiger User

        await enrollOrgAdmin(ccp, caInfo, wallet, args.org, adminUserId);
        await registerAndEnrollOrgUser(ccp, caInfo, wallet, args.org, appUserId, adminUserId, `${orgShortName.toLowerCase()}.department1`);

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet, identity: appUserId, discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2');

        const transportUpdateEntry = {
            logType: "TransportLogSummary", // Eindeutiger Typ
            value: summaryForEntry,         // Der detaillierte Summary-String
            unit: "",                       // Keine Einheit für den Summary-String
            status: transportOutcome,       // TRANSPORT_OK, TRANSPORT_TEMP_ALERT etc.
            offChainLogRef: `sim_log_ref:${path.basename(args.file)}`,
            responsibleSystem: args.system,
            // timestamp wird im Chaincode gesetzt
        };
        const transportUpdateJSON = JSON.stringify(transportUpdateEntry);

        console.log(`\n--> [TRANSPORT-INTEGRATION] Sende AddTransportUpdate an Chaincode für DPP ${args.dpp}...`);
        console.log(`    Payload: ${transportUpdateJSON}`);
        await contract.submitTransaction('AddTransportUpdate', args.dpp, transportUpdateJSON, args.gln);
        console.log(`✓ Transport-Update für DPP ${args.dpp} gespeichert.`);

        const dppBytes = await contract.evaluateTransaction('QueryDPP', args.dpp);
        const updatedDpp = JSON.parse(dppBytes.toString());
        console.log(`\nNeuer Status DPP ${args.dpp} nach Transport-Update: ${updatedDpp.status}`);
        if (updatedDpp.transportLog && updatedDpp.transportLog.length > 0) {
            console.log("Letzter Transport-Log Eintrag:", updatedDpp.transportLog[updatedDpp.transportLog.length - 1]);
        }
        if (updatedDpp.status.includes("Alert")) {
            console.warn(`WARNUNG: DPP ${args.dpp} hat einen Transport-Alert!`);
        }

    } catch (error) {
        console.error(`[TRANSPORT-INTEGRATION] FEHLER: ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await gateway.disconnect();
            console.log('\n[TRANSPORT-INTEGRATION] Skript beendet.');
        }
    }
}

main();