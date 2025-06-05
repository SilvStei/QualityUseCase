'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ccpPathOrg1 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org1.example.com',
    'connection-org1.json'
);
const walletPathOrgA = path.join(__dirname, 'walletA');
const MSP_ID_ORG1 = 'Org1MSP';
const CA_NAME_ORG1 = 'ca.org1.example.com';
const ADMIN_ID_ORG1 = 'adminOrg1';
const APP_USER_ID_ORG1 = 'appUserOrg1A';

const PRODUKT_TYP_ID_A = 'POLYPROPYLEN_X1';
const GLN_ORG_A = '4012345000002';
const CHARGE_A_PREFIX = 'CHARGE_A_';
const GS1_FIRMEN_PREFIX_A = '4012345';
const GS1_ARTIKEL_REF_A = '076543';

const MFI_TEST_NAME_KONST = "Melt Flow Index (230 GradC / 2,16 kg)";
const VISUELL_TEST_NAME_KONST = "Visuelle Prüfung der Granulatfarbe";
const DICHTE_TEST_NAME_KONST = "Dichte";

const SPEZIFIKATIONEN_A = [
    { name: MFI_TEST_NAME_KONST, istNumerisch: true, grenzeNiedrig: 10.0, grenzeHoch: 15.0, einheit: "g/10 min", benoetigt: true },
    { name: VISUELL_TEST_NAME_KONST, istNumerisch: false, wertErwartet: "OK", einheit: "", benoetigt: true },
    { name: DICHTE_TEST_NAME_KONST, istNumerisch: true, grenzeNiedrig: 0.89, grenzeHoch: 0.92, einheit: "g/cm3", benoetigt: false }
];
const MFI_SPEZIFIKATIONEN_A = SPEZIFIKATIONEN_A.find(s => s.name === MFI_TEST_NAME_KONST);

async function pruefeWallet(wallet, identLabel) {
    return await wallet.get(identLabel);
}

async function erstelleAdmin(wallet, caClient, mspId, adminUserId) {
    try {
        if (await pruefeWallet(wallet, adminUserId)) {
            console.log(`Admin "${adminUserId}" existiert in Wallet A`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Ident = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminUserId, x509Ident);
        console.log(`Admin "${adminUserId}" fuer Wallet A registriert`);
    } catch (error) {
        console.error(`Fehler Admin Erstellung: ${error.message}`);
        throw error;
    }
}

async function erstelleBenutzer(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        if (await pruefeWallet(wallet, userId)) {
            console.log(`Benutzer "${userId}" existiert in Wallet A`);
            return;
        }
        const adminIdent = await wallet.get(adminUserId);
        if (!adminIdent) {
            throw new Error(`Admin "${adminUserId}" nicht in Wallet A gefunden`);
        }
        const provider = wallet.getProviderRegistry().getProvider(adminIdent.type);
        const adminUser = await provider.getUserContext(adminIdent, adminUserId);

        const secret = await caClient.register({ affiliation, enrollmentID: userId, role: 'client' }, adminUser);
        const enrollment = await caClient.enroll({ enrollmentID: userId, enrollmentSecret: secret });
        const x509Ident = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(userId, x509Ident);
        console.log(`Benutzer "${userId}" fuer Wallet A registriert`);
    } catch (error) {
        console.error(`Fehler Benutzer Erstellung: ${error.message}`);
        throw error;
    }
}

async function trenneGateway(gateway) {
    if (gateway) {
        await gateway.disconnect();
    }
}

async function abfrageUndLogDPP(contract, dppId, kontextNachricht) {
    console.log(`\n--- INFO ${kontextNachricht} - Status ${dppId} ---`);
    const dppBytes = await contract.evaluateTransaction('DPPAbfragen', dppId);
    const dpp = JSON.parse(dppBytes.toString());
    console.log(`Status ${dpp.status}`);
    if (dpp.offenePflichtpruefungen && dpp.offenePflichtpruefungen.length > 0) {
        console.log(`Offene Pflichtpruefungen ${dpp.offenePflichtpruefungen.join(', ')}`);
    }
    if (dpp.status === "Gesperrt") {
        console.error(`ACHTUNG DPP ${dppId} ist gesperrt!`);
    }
    return dpp;
}

async function main() {
    let gateway;
    try {
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg1, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG1];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA ${CA_NAME_ORG1} oder Zertifikate nicht in Verbindungsprofil gefunden`);
        }
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPathOrgA);
        console.log(`Wallet Pfad A ${walletPathOrgA}`);
        await erstelleAdmin(wallet, ca, MSP_ID_ORG1, ADMIN_ID_ORG1);
        await erstelleBenutzer(wallet, ca, MSP_ID_ORG1, APP_USER_ID_ORG1, ADMIN_ID_ORG1, 'org1.department1');

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: APP_USER_ID_ORG1,
            discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2'); 

        const uniqueIdPartA = Date.now();
        const dppIdA = `DPP_A_${uniqueIdPartA}`;
        const chargeA = `${CHARGE_A_PREFIX}${new Date().toISOString().slice(5, 10).replace('-', '')}`;
        const gs1KeyA = `urn:epc:id:sgtin:${GS1_FIRMEN_PREFIX_A}.${GS1_ARTIKEL_REF_A}.${uniqueIdPartA % 100000}`;

        console.log(`\n--> A ErstelleDPP ${dppIdA} Produkt ${PRODUKT_TYP_ID_A}`);
        await contract.submitTransaction(
            'ErstellenDPP',
            dppIdA,
            gs1KeyA,
            PRODUKT_TYP_ID_A,
            GLN_ORG_A,
            chargeA,
            new Date().toISOString().split('T')[0],
            JSON.stringify(SPEZIFIKATIONEN_A)
        );
        console.log(`DPP ${dppIdA} angelegt (GS1 ${gs1KeyA})`);
        await abfrageUndLogDPP(contract, dppIdA, "Nach ErstellenDPP");

        const sensorQualitaetProfil = "GUT";
        console.log(`\n--> A Starte Simulation Inline-MFI-Sensor (Profil ${sensorQualitaetProfil}) DPP ${dppIdA}`);

        console.log(`    1. Rufe generate_mfi_raw.js auf`);
        let rawFilePath;
        try {
            const generateCmd = `node MFI_Generierung.js ${dppIdA} ${sensorQualitaetProfil}`;
            console.log(`       Befehl ${generateCmd}`);
            const generateOutput = execSync(generateCmd, { encoding: 'utf8', stdio: 'pipe' });
            console.log(generateOutput);
            const match = generateOutput.match(/RAW_FILE_PATH=(.*)/);
            if (match && match[1]) {
                rawFilePath = match[1].trim();
                console.log(`    Rohdaten-Datei ${rawFilePath}`);
            } else {
                throw new Error("Konnte RAW_FILE_PATH nicht extrahieren");
            }
        } catch (e) {
            console.error("Fehler generate_mfi_raw.js", e.message);
            throw e;
        }

        console.log(`${rawFilePath} aufrufen und bearbeiten`);
        try {
            if (!MFI_SPEZIFIKATIONEN_A) {
                throw new Error(`MFI Spezifikationen für Test '${MFI_TEST_NAME_KONST}' nicht gefunden.`);
            }
            const aufrufOracleSkript = `node Oracle_MFI.js \
                --dpp ${dppIdA} \
                --datei "${rawFilePath}" \
                --test "${MFI_TEST_NAME_KONST}" \
                --org ${MSP_ID_ORG1} \
                --gln ${GLN_ORG_A} \
                --system "SENSOR_MFI_INLINE_A001" \
                --zustaendig "Autom. Prozessueberwachung A" \
                --grenze_niedrig ${MFI_SPEZIFIKATIONEN_A.grenzeNiedrig} \
                --grenze_hoch ${MFI_SPEZIFIKATIONEN_A.grenzeHoch} \
                --einheit "${MFI_SPEZIFIKATIONEN_A.einheit}"`;

            console.log("        Befehl", aufrufOracleSkript.replace(/\s+/g, ' ')); // Variable hier auch anpassen
            const submitOutput = execSync(aufrufOracleSkript, { encoding: 'utf8', stdio: 'pipe' }); // aufrufOracleSkript verwenden
            console.log("        Ausgabe Oracle_MFI.js"); // Skriptname in der Log-Ausgabe anpassen
            console.log(submitOutput);
        } catch (e) {
            console.error("Fehler Oracle_MFI.js", e.message); // Skriptname in der Fehler-Log-Ausgabe anpassen
            throw e;
        }
        await abfrageUndLogDPP(contract, dppIdA, "Nach Inline-MFI Integration");

        console.log(`\n--> A AufzeichnenTestergebnisse (QMS ${VISUELL_TEST_NAME_KONST}) DPP ${dppIdA}`);
        const visuellTestDatenA = {
            standardName: VISUELL_TEST_NAME_KONST, 
            ergebnis: "OK", einheit: "", systemId: "QMS-A", zustaendiger: "PrüferA", 
            offChain: "ipfs://QmSimulatedVisualInspectionRecord123", 
        };
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdA, JSON.stringify(visuellTestDatenA), GLN_ORG_A); 
        console.log(`QMS-Datensatz (Visuell) gespeichert`);
        await abfrageUndLogDPP(contract, dppIdA, `Nach QMS (${VISUELL_TEST_NAME_KONST})`);

        console.log(`\n--> A AufzeichnenTestergebnisse (${DICHTE_TEST_NAME_KONST}) DPP ${dppIdA}`);
        const dichteTestDatenA = {
            standardName: DICHTE_TEST_NAME_KONST, 
            ergebnis: "0.91", einheit: "g/cm3", systemId: "SENSOR-A-DENS01", zustaendiger: "Anlage 1", 
        };
        await contract.submitTransaction('AufzeichnenTestergebnisse', dppIdA, JSON.stringify(dichteTestDatenA), GLN_ORG_A); 
        console.log(`Dichte-Sensor-Datensatz gespeichert`);
        const dppFinal = await abfrageUndLogDPP(contract, dppIdA, `Nach ${DICHTE_TEST_NAME_KONST}`);

        console.log(`\nDPP-Inhalt A ${dppIdA} vor Transfer\n`, JSON.stringify(dppFinal, null, 2));

        if (dppFinal.status === "Freigegeben" || dppFinal.status === "FreigegebenMitFehler") {
            const zielOrgC_MSP = 'Org3MSP';
            console.log(`\n--> A DPPUebertragen ${dppIdA} von ${MSP_ID_ORG1} (GLN ${GLN_ORG_A}) an ${zielOrgC_MSP}`);
            await contract.submitTransaction('DPPUebertragen', dppIdA, zielOrgC_MSP, GLN_ORG_A); 
            console.log(`Transfer ${dppIdA} an ${zielOrgC_MSP} initiiert`);
            await abfrageUndLogDPP(contract, dppIdA, "Nach TransferInitiative an C");
        } else {
            console.error(`ACHTUNG DPP ${dppIdA} Status ${dppFinal.status} und kann NICHT transferiert werden! Demo hier beendet`);
        }

        console.log(`\nWICHTIG DPP ID ${dppIdA} (GS1 ${gs1KeyA}) für nächste Schritte notieren!`);

    } catch (error) {
        console.error(`A FEHLER Hauptablauf unternehmenA_app_v2.js ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await trenneGateway(gateway);
            console.log('\nA Gateway getrennt – Unternehmen A Demo beendet');
        }
    }
}

main();