// -----------------------------------------------------------------------------
// submit_quality_from_file.js - Verarbeitet Rohdaten aus Datei und sendet sie an die Blockchain.
// Simuliert einen Integrationslayer/Oracle.
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { ArgumentParser } = require('argparse'); // Benötigt: npm install argparse

function parseArgs() {
    const parser = new ArgumentParser({
        description: 'Verarbeitet Sensor-Rohdaten aus einer Datei und reicht sie bei der Blockchain ein.'
    });
    parser.add_argument('--dpp', { help: 'DPP ID, zu der die Qualitätsdaten gehören', required: true });
    parser.add_argument('--file', { help: 'Pfad zur CSV-Datei mit den Rohdaten', required: true });
    parser.add_argument('--test', { help: 'Name des Tests im DPP (z.B. "Melt Flow Index (230 °C / 2,16 kg)")', required: true });
    parser.add_argument('--org', { help: 'MSP ID der ausführenden Organisation (z.B. Org1MSP)', required: true });
    parser.add_argument('--gln', { help: 'GLN der aufzeichnenden Site (recordingSiteGLN)', required: true });
    parser.add_argument('--system', { help: 'ID des erfassenden Systems (z.B. SENSOR_MFI_INLINE_A001)', required: true });
    parser.add_argument('--responsible', { help: 'Verantwortliche Person/Abteilung', default: 'Autom. Prozessüberwachung' });
    parser.add_argument('--lower_limit', { help: 'Untere Spezifikationsgrenze (optional, für numerische Tests)', type: 'float', required: false });
    parser.add_argument('--upper_limit', { help: 'Obere Spezifikationsgrenze (optional, für numerische Tests)', type: 'float', required: false });
    parser.add_argument('--expected_value', { help: 'Erwarteter String-Wert (optional, für nicht-numerische Tests)', type: 'str', required: false });
    parser.add_argument('--unit', { help: 'Einheit des Testergebnisses (z.B. "g/10 min")', required: false, default: "" }); // NEU

    return parser.parse_args();
}

async function getWallet(orgMspId) {
    const orgShortName = orgMspId.replace('MSP', ''); // z.B. Org1
    const walletDir = `wallet${orgShortName.charAt(0).toUpperCase() + orgShortName.slice(1)}`; // z.B. walletOrg1 -> walletA (Annahme)
    if (orgShortName === "Org1") return path.join(__dirname, `walletA`);
    if (orgShortName === "Org2") return path.join(__dirname, `walletB`);
    if (orgShortName === "Org3") return path.join(__dirname, `walletC`);
    if (orgShortName === "Org4") return path.join(__dirname, `walletD`);
    throw new Error(`Unbekannte Org MSP ID für Wallet-Pfad: ${orgMspId}`);
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
        if (adminIdentity) {
            // console.log(`Admin-Benutzer "${adminUserId}" für ${mspId} existiert bereits.`);
            return;
        }
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA Info unvollständig oder tlsCACerts.pem fehlt für ${caInfo ? caInfo.caName : 'unbekannte CA'}.`);
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
    } catch (error) {
        console.error(`Fehler beim Registrieren des Admin-Benutzers "${adminUserId}" für ${mspId}: ${error}`);
        throw error;
    }
}

async function registerAndEnrollOrgUser(ccp, caInfo, wallet, mspId, userId, adminUserId, affiliation) {
     try {
        const userIdentity = await wallet.get(userId);
        if (userIdentity) {
            // console.log(`Benutzer "${userId}" für ${mspId} existiert bereits.`);
            return;
        }
        const adminIdentity = await wallet.get(adminUserId);
        if (!adminIdentity) {
            throw new Error(`Admin-Benutzer "${adminUserId}" für ${mspId} nicht im Wallet gefunden.`);
        }
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA Info unvollständig oder tlsCACerts.pem fehlt für ${caInfo ? caInfo.caName : 'unbekannte CA'}.`);
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
    } catch (error) {
        console.error(`Fehler beim Registrieren des Benutzers "${userId}" für ${mspId}: ${error}`);
        throw error;
    }
}

async function main() {
    const args = parseArgs();

    console.log(`\n--> [INTEGRATION] Verarbeite Daten aus Datei: ${args.file}`);
    console.log(`    Für DPP: ${args.dpp}, Test: "${args.test}", Org: ${args.org}`);

    let gateway;
    try {
        if (!fs.existsSync(args.file)) {
            throw new Error(`Rohdaten-Datei nicht gefunden: ${args.file}`);
        }
        const fileContent = fs.readFileSync(args.file, 'utf8');
        const lines = fileContent.trim().split('\n');
        if (lines.length <= 1) {
            throw new Error(`Keine Daten in Datei gefunden: ${args.file}`);
        }

        const header = lines.shift().toLowerCase().split(',');
        const valueIndex = header.indexOf('mfi_value');
        if (valueIndex === -1) {
            throw new Error("Spalte 'mfi_value' nicht in CSV-Header gefunden.");
        }

        const readings = lines.map(line => parseFloat(line.split(',')[valueIndex])).filter(val => !isNaN(val));
        if (readings.length === 0) {
            throw new Error("Keine gültigen numerischen Werte in der Datenspalte gefunden.");
        }

        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        let deviations = 0;
        const hasNumericSpec = typeof args.lower_limit === 'number' && typeof args.upper_limit === 'number';

        readings.forEach(r => {
            sum += r;
            if (r < min) min = r;
            if (r > max) max = r;
            if (hasNumericSpec && (r < args.lower_limit || r > args.upper_limit)) {
                deviations++;
            }
        });
        const average = parseFloat((sum / readings.length).toFixed(2));

        let resultSummary;
        let evaluationOutcome;
        let resultForChaincode;
        let unitForChaincode = "";

        if (args.expected_value) { // Nicht-numerischer Test
            const actualValue = String(readings[0]); // Annahme: erster Wert ist relevant
            if (actualValue.toLowerCase() === args.expected_value.toLowerCase()) {
                resultSummary = `Prüfung OK: '${actualValue}' entspricht Erwartung.`;
                evaluationOutcome = "PASS";
            } else {
                resultSummary = `Prüfung NICHT OK: Erhalten '${actualValue}', Erwartet '${args.expected_value}'`;
                evaluationOutcome = "FAIL";
            }
            resultForChaincode = actualValue;
            unitForChaincode = args.unit || "";
        } else if (hasNumericSpec) { // Numerischer Test
            if (deviations === 0) {
                resultSummary = `Alle ${readings.length} Messungen i.O. (Avg: ${average}, Min: ${min}, Max: ${max})`;
                evaluationOutcome = "PASS";
                resultForChaincode = String(average);
                unitForChaincode = args.unit;
            } else {
                resultSummary = `WARNUNG/FEHLER: ${deviations} von ${readings.length} Messungen außerh. Spez.! (Avg: ${average}, Min: ${min}, Max: ${max})`;
                // Einfache Regel: Wenn mehr als 20% abweichen oder ein einzelner Wert stark abweicht -> FAIL
                if (deviations > readings.length * 0.2 || max > args.upper_limit * 1.1 || min < args.lower_limit * 0.9) {
                    evaluationOutcome = "FAIL";
                } else {
                    evaluationOutcome = `DEVIATION_SENSOR_${args.org.replace('MSP', '')}`;
                }
                resultForChaincode = String(average); // Sende Durchschnitt auch bei Fehler/Deviation
                unitForChaincode = args.unit;
            }
        } else { // Keine Spezifikationsgrenzen für numerische oder erwarteten Wert für String Tests -> informativ
            resultSummary = `Messreihe erfasst: ${readings.length} Werte (Avg: ${average}, Min: ${min}, Max: ${max})`;
            evaluationOutcome = "INFO_SENSOR_DATA";
            resultForChaincode = resultSummary; // In diesem Fall ist der Summary das Ergebnis
            unitForChaincode = args.unit || "";
        }
        console.log(`--- [INTEGRATION] Aggregiertes Ergebnis: ${resultSummary}, Outcome: ${evaluationOutcome} ---`);

        const orgShortName = args.org.replace('MSP', '');
        const ccpPath = await getCcpPath(args.org);
        if (!fs.existsSync(ccpPath)) throw new Error(`CCP ${ccpPath} nicht gefunden für Org ${args.org}`);
        const ccp = JSON.parse(fs.readFileSync(ccpPath, 'utf8'));
        
        const orgCcpName = orgShortName.charAt(0).toUpperCase() + orgShortName.slice(1);
        if (!ccp.organizations[orgCcpName] || !ccp.organizations[orgCcpName].certificateAuthorities || ccp.organizations[orgCcpName].certificateAuthorities.length === 0) {
            throw new Error (`Keine certificateAuthorities für ${orgCcpName} in ${ccpPath} gefunden.`);
        }
        const caNameFromCcp = ccp.organizations[orgCcpName].certificateAuthorities[0];
        const caInfo = ccp.certificateAuthorities[caNameFromCcp];
        if (!caInfo) throw new Error(`CA ${caNameFromCcp} nicht im Abschnitt 'certificateAuthorities' von ${ccpPath} gefunden.`);
        if (!caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) throw new Error(`tlsCACerts.pem nicht für CA ${caNameFromCcp} in ${ccpPath} gefunden.`);

        const walletPath = await getWallet(args.org);
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        const adminUserId = `admin${orgShortName}`;
        const appUserId = `appUser${orgShortName}_Integration`;

        await enrollOrgAdmin(ccp, caInfo, wallet, args.org, adminUserId);
        await registerAndEnrollOrgUser(ccp, caInfo, wallet, args.org, appUserId, adminUserId, `${orgShortName.toLowerCase()}.department1`);

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: appUserId,
            discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2');

        const qualityEntryData = {
            testName: args.test,
            result: resultForChaincode,
            unit: unitForChaincode,
            systemId: args.system,
            responsible: args.responsible,
            offChainDataRef: `sim_log_ref:${path.basename(args.file)}`,
            evaluationOutcome: evaluationOutcome,
            evaluationComment: (evaluationOutcome === "PASS" || evaluationOutcome === "FAIL" || evaluationOutcome === "INFO_SENSOR_DATA") ? "" : resultSummary,
        };
        const qualityEntryJSON = JSON.stringify(qualityEntryData);

        console.log(`\n--> [INTEGRATION] Sende QualityData an Chaincode für DPP ${args.dpp}...`);
        console.log(`    Payload: ${qualityEntryJSON}`);
        await contract.submitTransaction('RecordQualityData', args.dpp, qualityEntryJSON, args.gln);
        console.log(`✓ Qualitätsdaten für DPP ${args.dpp} via Integrationsskript gespeichert.`);

        const dppBytes = await contract.evaluateTransaction('QueryDPP', args.dpp);
        const updatedDpp = JSON.parse(dppBytes.toString());
        console.log(`\nNeuer Status DPP ${args.dpp}: ${updatedDpp.status}`);
        if (updatedDpp.status === "Blocked") {
            console.error("ACHTUNG: DPP wurde aufgrund der verarbeiteten Daten blockiert!");
        } else if (updatedDpp.status.includes("Deviations") || updatedDpp.status.includes("Alert") || updatedDpp.status.includes("SENSOR")) {
            console.warn(`INFO: DPP hat Abweichungen/Warnungen: ${updatedDpp.status}`);
        }

    } catch (error) {
        console.error(`[INTEGRATION] FEHLER: ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await gateway.disconnect();
            console.log('\n[INTEGRATION] Skript beendet.');
        }
    }
}

main();