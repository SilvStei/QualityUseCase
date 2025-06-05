// Oracle_Transport.js
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { ArgumentParser } = require('argparse');

function parseArgumente() {
    const parser = new ArgumentParser({
        description: 'Verarbeitet Transport-Log-Daten und sendet Updates an die Blockchain.'
    });
    parser.add_argument('--dpp', { help: 'DPP ID', required: true });
    parser.add_argument('--datei', { help: 'Pfad zur CSV Transport-Log-Datei', required: true });
    parser.add_argument('--org', { help: 'MSP ID der Organisation', required: true });
    parser.add_argument('--gln', { help: 'GLN der Site', required: true });
    parser.add_argument('--system', { help: 'ID des erfassenden Systems', required: true });
    parser.add_argument('--zustaendig', { help: 'Zustaendige Einheit', default: 'Logistik-System' });
    return parser.parse_args();
}

async function holeWalletPfad(orgMspId) {
    const orgKurz = orgMspId.replace('MSP', '');
    let walletVerzeichnisName = `wallet${orgKurz.charAt(0).toUpperCase() + orgKurz.slice(1)}`;
    if (orgKurz === "Org1") walletVerzeichnisName = `walletA`;
    else if (orgKurz === "Org2") walletVerzeichnisName = `walletB`;
    else if (orgKurz === "Org3") walletVerzeichnisName = `walletC`;
    else if (orgKurz === "Org4") walletVerzeichnisName = `walletD`;
    else { throw new Error(`Unbekannte Org MSP ID fuer Wallet ${orgMspId}`); }
    return path.join(__dirname, walletVerzeichnisName);
}

async function holeCcpPfad(orgMspId) {
    const orgNameKlein = orgMspId.toLowerCase().replace('msp', '');
    return path.resolve(
        __dirname, '..', '..', 'fabric-samples', 'test-network',
        'organizations', 'peerOrganizations', `${orgNameKlein}.example.com`,
        `connection-${orgNameKlein}.json`
    );
}

async function stelleAdminSicher(ccp, caInfo, wallet, mspId, adminUserId) {
    if (await wallet.get(adminUserId)) return;
    if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
        throw new Error(`CA Info unvollstaendig fuer ${caInfo ? caInfo.caName : 'CA'}`);
    }
    const caClient = new FabricCAServices(caInfo.url, { trustedRoots: caInfo.tlsCACerts.pem, verify: false }, caInfo.caName);
    const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
    const x509Ident = {
        credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
        mspId: mspId, type: 'X.509',
    };
    await wallet.put(adminUserId, x509Ident);
    console.log(`Admin "${adminUserId}" fuer ${mspId} erstellt.`);
}

async function stelleBenutzerSicher(ccp, caInfo, wallet, mspId, userId, adminUserId, affiliation) {
    if (await wallet.get(userId)) return;
    const adminIdent = await wallet.get(adminUserId);
    if (!adminIdent) throw new Error(`Admin "${adminUserId}" fuer ${mspId} nicht gefunden.`);
    if (!caInfo || !caInfo.tlsCACerts || !caInfo.tlsCACerts.pem) {
        throw new Error(`CA Info unvollstaendig fuer ${caInfo ? caInfo.caName : 'CA'}`);
    }
    const caClient = new FabricCAServices(caInfo.url, { trustedRoots: caInfo.tlsCACerts.pem, verify: false }, caInfo.caName);
    const provider = wallet.getProviderRegistry().getProvider(adminIdent.type);
    const adminUser = await provider.getUserContext(adminIdent, adminUserId);
    const secret = await caClient.register({ affiliation, enrollmentID: userId, role: 'client' }, adminUser);
    const enrollment = await caClient.enroll({ enrollmentID: userId, enrollmentSecret: secret });
    const x509Ident = {
        credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
        mspId: mspId, type: 'X.509',
    };
    await wallet.put(userId, x509Ident);
    console.log(`Benutzer "${userId}" fuer ${mspId} erstellt.`);
}

async function main() {
    const args = parseArgumente();
    console.log(`\n--> ORACLE-TRANSPORT Verarbeite Log ${args.datei}`);
    console.log(`    DPP ${args.dpp}, Org ${args.org}`);

    let gateway;
    try {
        if (!fs.existsSync(args.datei)) throw new Error(`Transport-Log-Datei nicht gefunden ${args.datei}`);
        const dateiInhalt = fs.readFileSync(args.datei, 'utf8');
        const zeilen = dateiInhalt.trim().split('\n');
        if (zeilen.length <= 1) {
            console.warn(`Keine Daten in Transport-Log ${args.datei}`);
            return;
        }

        const kopfzeile = zeilen.shift().toLowerCase().split(',');
        const zeitstempelIdx = kopfzeile.indexOf('zeitstempel');
        const parametertypIdx = kopfzeile.indexOf('parametertyp');
        const wertIdx = kopfzeile.indexOf('wert');
        const einheitIdx = kopfzeile.indexOf('einheit');
        const zustandIdx = kopfzeile.indexOf('zustand');

        if ([zeitstempelIdx, parametertypIdx, wertIdx, einheitIdx, zustandIdx].includes(-1)) {
            throw new Error("CSV-Kopfzeile unvollstaendig (erwartet: zeitstempel,parametertyp,wert,einheit,zustand)");
        }

        const orgKurzName = args.org.replace('MSP', '');
        const ccpPfad = await holeCcpPfad(args.org);
        if (!fs.existsSync(ccpPfad)) throw new Error(`CCP ${ccpPfad} nicht gefunden`);
        const ccp = JSON.parse(fs.readFileSync(ccpPfad, 'utf8'));

        const orgCcpName = orgKurzName.charAt(0).toUpperCase() + orgKurzName.slice(1);
        if (!ccp.organizations[orgCcpName] || !ccp.organizations[orgCcpName].certificateAuthorities || ccp.organizations[orgCcpName].certificateAuthorities.length === 0) {
            throw new Error(`Keine CAs fuer ${orgCcpName} in ${ccpPfad}`);
        }
        const caNameAusCcp = ccp.organizations[orgCcpName].certificateAuthorities[0];
        const caInfo = ccp.certificateAuthorities[caNameAusCcp];
        if (!caInfo) throw new Error(`CA ${caNameAusCcp} nicht in ${ccpPfad}`);

        const walletPfad = await holeWalletPfad(args.org);
        const wallet = await Wallets.newFileSystemWallet(walletPfad);
        const adminUserId = `admin${orgKurzName}`;
        const appUserId = `appUser${orgKurzName}_TransportOracle`;

        await stelleAdminSicher(ccp, caInfo, wallet, args.org, adminUserId);
        await stelleBenutzerSicher(ccp, caInfo, wallet, args.org, appUserId, adminUserId, `${orgKurzName.toLowerCase()}.department1`);

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet, identity: appUserId, discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality_go_v2'); 

        for (const zeile of zeilen) {
            const werte = zeile.split(',');
            if (werte.length < 5) continue;

            const transitProtokollEintrag = {
                parametertyp: werte[parametertypIdx],
                wert: werte[wertIdx],
                einheit: werte[einheitIdx],
                zeit: werte[zeitstempelIdx],  
                zustand: werte[zustandIdx],  
                offChainProtokoll: `ref_log:${path.basename(args.datei)}#${werte[zeitstempelIdx]}`, 
                systemId: args.system, 
            };
            const transportUpdateJSON = JSON.stringify(transitProtokollEintrag);

            console.log(`\n--> ORACLE-TRANSPORT Sende TransportAktualisierung an Chaincode DPP ${args.dpp}`);
            console.log(`    Payload ${transportUpdateJSON}`);
            await contract.submitTransaction('TransportAktualisierungHinzufuegen', args.dpp, transportUpdateJSON, args.gln);
            console.log(`TransportAktualisierung fuer DPP ${args.dpp} (${transitProtokollEintrag.parametertyp}) gespeichert`);
        }

        const dppBytes = await contract.evaluateTransaction('DPPAbfragen', args.dpp);
        const aktualisierterDpp = JSON.parse(dppBytes.toString());
        console.log(`\nStatus DPP ${args.dpp} nach Transport-Updates ${aktualisierterDpp.status}`);
        if (aktualisierterDpp.transportLog && aktualisierterDpp.transportLog.length > 0) {
            console.log("Letzter Transport-Log Eintrag:", aktualisierterDpp.transportLog[aktualisierterDpp.transportLog.length - 1]);
        }
        if (aktualisierterDpp.status.includes("Fehler") || aktualisierterDpp.status === "Gesperrt") { 
            console.warn(`WARNUNG DPP ${args.dpp} Status ${aktualisierterDpp.status}`);
        }

    } catch (error) {
        console.error(`ORACLE-TRANSPORT FEHLER ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await gateway.disconnect();
            console.log('\nORACLE-TRANSPORT Skript beendet.');
        }
    }
}

main();