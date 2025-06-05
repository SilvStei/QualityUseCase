'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

const ccpPathOrg2 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org2.example.com',
    'connection-org2.json'
);

const walletPfadB = path.join(__dirname, 'walletB');
const MSP_ID_ORG2 = 'Org2MSP';
const CA_NAME_ORG2 = 'ca.org2.example.com';
const ADMIN_ID_ORG2 = 'adminOrg2';
const APP_USER_ID_ORG2 = 'appUserOrg2B';

const GLN_ORG_B = '4098765000007';
const GS1_FIRMEN_PREFIX_B = '4098765';
const STANDARD_PRODUKT_TYP_B = 'GLASFASER_GF30';

const GLASFASER_TEST_NAME_KONST = "Glasfaser-Gewichtsanteil";
const MFI_TEST_NAME_KONST_B = "Melt Flow Index (230 GradC / 2,16 kg)"; // Eindeutiger für B falls nötig
const RESTFEUCHTE_TEST_NAME_KONST = "Restfeuchte";


function erstelleSgtin(prefix, artikelRef, seriennummer) {
    return `urn:epc:id:sgtin:${prefix}.${artikelRef}.${seriennummer}`;
}

async function pruefeWallet(wallet, identLabel) {
    return await wallet.get(identLabel);
}

async function erstelleAdminOrg(wallet, caClient, mspId, adminUserId) {
    try {
        if (await pruefeWallet(wallet, adminUserId)) {
            console.log(`Admin "${adminUserId}" existiert in Wallet B`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Ident = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminUserId, x509Ident);
        console.log(`Admin "${adminUserId}" fuer Wallet B registriert`);
    } catch (error) {
        console.error(`Fehler Admin Erstellung B: ${error.message}`);
        throw error;
    }
}

async function erstelleBenutzerOrg(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        if (await pruefeWallet(wallet, userId)) {
            console.log(`Benutzer "${userId}" existiert in Wallet B`);
            return;
        }
        const adminIdent = await wallet.get(adminUserId);
        if (!adminIdent) {
            throw new Error(`Admin "${adminUserId}" nicht in Wallet B gefunden`);
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
        console.log(`Benutzer "${userId}" fuer Wallet B registriert`);
    } catch (error) {
        console.error(`Fehler Benutzer Erstellung B: ${error.message}`);
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
        const ccp = JSON.parse(fs.readFileSync(ccpPathOrg2, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG2];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA ${CA_NAME_ORG2} oder Zertifikate nicht in Verbindungsprofil gefunden`);
        }
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPfadB);
        console.log(`Wallet Pfad B ${walletPfadB}`);

        await erstelleAdminOrg(wallet, ca, MSP_ID_ORG2, ADMIN_ID_ORG2);
        await erstelleBenutzerOrg(wallet, ca, MSP_ID_ORG2, APP_USER_ID_ORG2, ADMIN_ID_ORG2, 'org2.department1');

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: APP_USER_ID_ORG2,
            discovery: { enabled: true, asLocalhost: true }
        });

        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2');

        const jetzt = new Date();
        const dppIdB = `DPP_B_${jetzt.getTime()}`;
        const gs1KeyB = erstelleSgtin(GS1_FIRMEN_PREFIX_B, '033445', jetzt.getTime().toString().slice(-5));
        const chargeB = `CHARGE_B_GF30_${jetzt.toISOString().slice(5, 10).replace('-', '')}`;
        const produktionsDatumB = jetzt.toISOString().slice(0, 10);

        const spezifikationenB = [
            { name: GLASFASER_TEST_NAME_KONST, istNumerisch: true, grenzeNiedrig: 29.5, grenzeHoch: 30.5, einheit: 'wt-%', benoetigt: true },
            { name: MFI_TEST_NAME_KONST_B, istNumerisch: true, grenzeNiedrig: 8.0, grenzeHoch: 12.0, einheit: 'g/10 min', benoetigt: true },
            { name: RESTFEUCHTE_TEST_NAME_KONST, istNumerisch: true, grenzeNiedrig: 0.0, grenzeHoch: 0.05, einheit: '%', benoetigt: false }
        ];
        const spezifikationenB_JSON = JSON.stringify(spezifikationenB);

        console.log(`\n--> B ErstelleDPP ${dppIdB} Produkt ${STANDARD_PRODUKT_TYP_B}`);
        await contract.submitTransaction(
            'ErstellenDPP',
            dppIdB,
            gs1KeyB,
            STANDARD_PRODUKT_TYP_B,
            GLN_ORG_B,
            chargeB,
            produktionsDatumB,
            spezifikationenB_JSON
        );
        console.log(`DPP ${dppIdB} angelegt (GS1 ${gs1KeyB})`);
        let dppStatus = await abfrageUndLogDPP(contract, dppIdB, "Initial nach ErstellenDPP");

        const testDatenGF = {
            standardName: GLASFASER_TEST_NAME_KONST,
            ergebnis: '30.1',
            einheit: 'wt-%',
            systemId: 'B-FIBERTEST',
            zustaendiger: 'PrüferB',
        };
        console.log(`\n--> B AufzeichnenTestergebnisse (Glasfaser) DPP ${dppIdB}`);
        await contract.submitTransaction('AufzeichnenTestergebnisse',
            dppIdB,
            JSON.stringify(testDatenGF),
            GLN_ORG_B
        );
        console.log('GF-Anteil gespeichert');
        dppStatus = await abfrageUndLogDPP(contract, dppIdB, "Nach GF-Test");

        const testDatenMfi = {
            standardName: MFI_TEST_NAME_KONST_B,
            ergebnis: '9.8',
            einheit: 'g/10 min',
            systemId: 'B-MFI',
            zustaendiger: 'PrüferB',
        };
        console.log(`\n--> B AufzeichnenTestergebnisse (MFI) DPP ${dppIdB}`);
        await contract.submitTransaction('AufzeichnenTestergebnisse',
            dppIdB,
            JSON.stringify(testDatenMfi),
            GLN_ORG_B
        );
        console.log('MFI gespeichert');
        dppStatus = await abfrageUndLogDPP(contract, dppIdB, "Nach MFI-Test");

        if(dppStatus.status === "Freigegeben") {
            console.log("Alle Pflichtpruefungen bestanden DPP freigegeben");
        }

        const dppFinal = JSON.parse((await contract.evaluateTransaction('DPPAbfragen', dppIdB)).toString());
        console.log(`\nDPP-Inhalt B ${dppIdB} vor Transfer\n`, JSON.stringify(dppFinal, null, 2));

        if (dppFinal.status === "Freigegeben" || dppFinal.status === "FreigegebenMitFehler") {
            const zielOrgC_MSP = 'Org3MSP';
            console.log(`\n--> B DPPUebertragen ${dppIdB} von ${MSP_ID_ORG2} (GLN ${GLN_ORG_B}) an ${zielOrgC_MSP}`);
            await contract.submitTransaction(
                'DPPUebertragen',
                dppIdB,
                zielOrgC_MSP,
                GLN_ORG_B
            );
            console.log(`Transfer ${dppIdB} an ${zielOrgC_MSP} initiiert`);
            await abfrageUndLogDPP(contract, dppIdB, "Nach TransferInitiative an C durch B");
        } else {
            console.error(`ACHTUNG DPP ${dppIdB} Status ${dppFinal.status} und kann NICHT transferiert werden`);
        }

        console.log(`WICHTIG DPP ID ${dppIdB} (GS1 ${gs1KeyB}) für Unternehmen C notieren`);

    } catch (err) {
        console.error(`B FEHLER ${err.stack ? err.stack : err}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await trenneGateway(gateway);
            console.log('\nB Gateway getrennt – Unternehmen B Demo beendet');
        }
    }
}

main().catch(err => {
    console.error("Unerwarteter Fehler in main() (unternehmenB_app.js)", err);
    process.exit(1);
});