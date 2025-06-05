'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');

const ccpPfadOrg4 = path.resolve(
    __dirname, '..', '..', 'fabric-samples', 'test-network',
    'organizations', 'peerOrganizations', 'org4.example.com',
    'connection-org4.json'
);
const walletPfadOrgD = path.join(__dirname, 'walletD');
const MSP_ID_ORG4 = 'Org4MSP';
const CA_NAME_ORG4 = 'ca.org4.example.com';
const ADMIN_ID_ORG4 = 'adminOrg4';
const APP_USER_ID_ORG4 = 'appUserOrg4D';
const GLN_ORG_D = '4011111000009';

async function pruefeWallet(wallet, identLabel) {
    return await wallet.get(identLabel);
}

async function erstelleAdminOrgD(wallet, caClient, mspId, adminUserId) {
    try {
        if (await pruefeWallet(wallet, adminUserId)) {
            console.log(`Admin "${adminUserId}" existiert in Wallet D`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Ident = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes(), },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminUserId, x509Ident);
        console.log(`Admin "${adminUserId}" fuer Wallet D registriert`);
    } catch (error) {
        console.error(`Fehler Admin Erstellung D ${error.message}`);
        throw error;
    }
}

async function erstelleBenutzerOrgD(wallet, caClient, mspId, userId, adminUserId, affiliation) {
    try {
        if (await pruefeWallet(wallet, userId)) {
            console.log(`Benutzer "${userId}" existiert in Wallet D`);
            return;
        }
        const adminIdent = await wallet.get(adminUserId);
        if (!adminIdent) {
            throw new Error(`Admin "${adminUserId}" nicht in Wallet D gefunden`);
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
        console.log(`Benutzer "${userId}" fuer Wallet D registriert`);
    } catch (error) {
        console.error(`Fehler Benutzer Erstellung D ${error.message}`);
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
    console.log(`Status ${dpp.status}, Owner ${dpp.ownerOrg}`);
    if (dpp.status === "Gesperrt") { 
        console.error(`ACHTUNG DPP ${dppId} gesperrt!`);
    }
    return dpp;
}

async function main() {
    let gateway;
    try {
        const dppIdVonC = process.argv[2];
        if (!dppIdVonC || !dppIdVonC.startsWith('DPP_C_')) {
            console.error("FEHLER Gueltige DPP ID von C als Argument angeben!");
            console.error("Aufruf z.B. node unternehmenD_app.js DPP_C_1234567890123");
            process.exit(1);
        }
        console.log(`Unternehmen D verarbeitet DPP ${dppIdVonC}`);

        const ccp = JSON.parse(fs.readFileSync(ccpPfadOrg4, 'utf8'));
        const caInfo = ccp.certificateAuthorities[CA_NAME_ORG4];
        if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
            throw new Error(`CA ${CA_NAME_ORG4} oder Zertifikate nicht in Verbindungsprofil gefunden`);
        }
        const caTLSCACerts = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName);

        const wallet = await Wallets.newFileSystemWallet(walletPfadOrgD);
        console.log(`Wallet Pfad D ${walletPfadOrgD}`);
        await erstelleAdminOrgD(wallet, ca, MSP_ID_ORG4, ADMIN_ID_ORG4);
        await erstelleBenutzerOrgD(wallet, ca, MSP_ID_ORG4, APP_USER_ID_ORG4, ADMIN_ID_ORG4, 'org4.department1');

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet, identity: APP_USER_ID_ORG4, discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2');

        console.log(`\n--> D DPPAbfragen ${dppIdVonC} (empfangen von C)`);
        let dpp = await abfrageUndLogDPP(contract, dppIdVonC, `Status ${dppIdVonC} bei Ankunft D`);

        const erwarteterStatusPrefix = `TransportZu_${MSP_ID_ORG4}`;
        if (dpp.ownerOrg !== MSP_ID_ORG4 || !dpp.status.startsWith(erwarteterStatusPrefix)) {
            throw new Error(`DPP ${dppIdVonC} nicht korrekt an ${MSP_ID_ORG4} transferiert. Aktuell Owner ${dpp.ownerOrg}, Status ${dpp.status}`);
        }
        console.log(`DPP ${dppIdVonC} korrekt an ${MSP_ID_ORG4} unterwegs`);

        if (dpp.transportLog && dpp.transportLog.length > 0) {
            console.log(`\n---> D Empfangener Transport-Log DPP ${dppIdVonC}`);
            dpp.transportLog.forEach((logEintrag, index) => {
                console.log(`    ${index + 1}. Typ ${logEintrag.parametertyp}, Wert ${logEintrag.wert}, Status ${logEintrag.zustand}, System ${logEintrag.systemId || 'N/A'}, Ref ${logEintrag.offChainProtokoll || 'N/A'}`);
                if (logEintrag.zustand && logEintrag.zustand.includes("ALARM")) {
                    console.warn(`        WARNUNG Transport-Alarm im Logeintrag ${index + 1} (${logEintrag.zustand})`);
                }
            });
        } else {
            console.log(`\n---> D Kein expliziter Transport-Log im DPP ${dppIdVonC}`);
        }
        let transportProblemeFestgestellt = false;
        if (dpp.transportLog && dpp.transportLog.some(tl => tl.zustand === "ALARM")) {
             console.warn(`        WARNUNG DPP ${dppIdVonC} hat Transport-Alarm im Log!`);
             transportProblemeFestgestellt = true;
        }
        console.log(`\n---> D Pruefung Qualitaetshistorie DPP ${dppIdVonC}`);
        if (dpp.quality && dpp.quality.length > 0) {
            dpp.quality.forEach((te, index) => {
                console.log(`    ${index + 1}. Test ${te.standardName}, Ergebnis ${te.ergebnis} ${te.einheit || ''}, Bewertung ${te.bewertungsergebnis || 'N/A'}, Org ${te.durchfuehrendeOrg}`);
            });
        } else {
            console.log("    Keine expliziten Qualitaetseintraege im DPP");
        }

        let akzeptiereWare = true;
        let grundAblehnung = "";

        if (transportProblemeFestgestellt) {
            console.log(`    ENTSCHEIDUNG Ware ${dppIdVonC} wegen Transport-Problemen genauer pruefen.`);
        }
        const eingangspruefungErgebnisD = akzeptiereWare ? "OK" : "NICHT_OKAY";
        if (!akzeptiereWare) {
             console.log(`    Ware wird abgelehnt ${grundAblehnung}`);
        }


        console.log(`\n--> D EmpfangBestaetigenUndPruefungAufzeichnen DPP ${dppIdVonC}`);
        await contract.submitTransaction(
            'EmpfangBestaetigenUndPruefungAufzeichnen',
            dppIdVonC,
            GLN_ORG_D,
            eingangspruefungErgebnisD 
        );
        console.log(`Empfang DPP ${dppIdVonC} durch D verarbeitet Ergebnis ${eingangspruefungErgebnisD}`);
        
        const finalerDppBeiD = await abfrageUndLogDPP(contract, dppIdVonC, `Finaler Zustand DPP ${dppIdVonC} bei D`);
        console.log(`\nDPP-Inhalt D nach Annahme ${dppIdVonC}\n`, JSON.stringify(finalerDppBeiD, null, 2));

    } catch (error) {
        console.error(`D FEHLER ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await trenneGateway(gateway);
            console.log('\nD Gateway getrennt – Unternehmen D Demo beendet');
        }
    }
}

if (require.main === module) {
    main();
}