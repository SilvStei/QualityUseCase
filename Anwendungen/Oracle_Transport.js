// Oracle_Transport.js
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { ArgumentParser } = require('argparse');
const fabricUtils = require('./fabricUtils.js');
const crypto = require('crypto');

function parseArgumente() {
    const parser = new ArgumentParser({
        description: 'Verarbeitet eine Transport-Log-Datei, berechnet deren Hash und verankert eine Referenz dazu in der Blockchain.'
    });
    parser.add_argument('--dpp', { help: 'DPP ID', required: true });
    parser.add_argument('--datei', { help: 'Pfad zur CSV Transport-Log-Datei', required: true });
    parser.add_argument('--org', { help: 'MSP ID der Organisation', required: true });
    parser.add_argument('--gln', { help: 'GLN der Site', required: true });
    parser.add_argument('--system', { help: 'ID des erfassenden Systems', required: true });
    parser.add_argument('--zustaendig', { help: 'Zustaendige Einheit', default: 'Logistik-System' });
    return parser.parse_args();
}

async function main() {
    const args = parseArgumente();
    console.log(`\n--> ORACLE-TRANSPORT Verarbeite Log-Datei ${args.datei} zur Verankerung`);
    console.log(`    DPP ${args.dpp}, Org ${args.org}`);

    let gateway;
    try {
        if (!fs.existsSync(args.datei)) throw new Error(`Transport-Log-Datei nicht gefunden ${args.datei}`);
        const dateiInhalt = fs.readFileSync(args.datei, 'utf8');
        const dateiHash = crypto.createHash('sha256').update(dateiInhalt).digest('hex');
        console.log(`    Datei-Hash (SHA256) ist ${dateiHash}`);

        const zeilen = dateiInhalt.trim().split('\n');
        let alarmFestgestellt = "NEIN"; 

        if (zeilen.length > 1) { 
            const kopfzeile = zeilen[0].toLowerCase().split(','); 
            const zustandIdx = kopfzeile.indexOf('zustand');

            if (zustandIdx !== -1) {
                for (let i = 1; i < zeilen.length; i++) {
                    const werte = zeilen[i].split(',');
                    if (werte.length > zustandIdx && werte[zustandIdx] && werte[zustandIdx].toUpperCase() === 'ALARM') {
                        alarmFestgestellt = "JA";
                        console.log(`    ALARM im Transport-Log festgestellt.`);
                        break; 
                    }
                }
            } else {
                console.warn("    Spalte 'zustand' nicht in Transport-Log CSV gefunden, Alarm-Prüfung übersprungen. AlarmZusammenfassung bleibt 'NEIN'.");
            }
        } else if (zeilen.length === 0 || (zeilen.length === 1 && zeilen[0].trim() === '')) {
             console.warn(`Keine Daten in Transport-Log ${args.datei}, nur Hash wird verankert. AlarmZusammenfassung bleibt 'NEIN'.`);
        } else { 
            console.warn(`Transport-Log ${args.datei} enthält nur eine Kopfzeile. AlarmZusammenfassung bleibt 'NEIN'.`);
        }


        const orgKurzName = args.org.replace('MSP', '');
        const ccpPfad = fabricUtils.getCcpPath(args.org, __dirname);
        if (!fs.existsSync(ccpPfad)) throw new Error(`CCP ${ccpPfad} nicht gefunden`);
        const ccp = JSON.parse(fs.readFileSync(ccpPfad, 'utf8'));

        const orgCcpName = orgKurzName.charAt(0).toUpperCase() + orgKurzName.slice(1);
        if (!ccp.organizations[orgCcpName] || !ccp.organizations[orgCcpName].certificateAuthorities || ccp.organizations[orgCcpName].certificateAuthorities.length === 0) {
            throw new Error(`Keine CAs fuer ${orgCcpName} in ${ccpPfad}`);
        }
        const caNameAusCcp = ccp.organizations[orgCcpName].certificateAuthorities[0];
        const caInfo = ccp.certificateAuthorities[caNameAusCcp];
        if (!caInfo) throw new Error(`CA ${caNameAusCcp} nicht in ${ccpPfad}`);

        const caClient = new FabricCAServices(caInfo.url, { trustedRoots: caInfo.tlsCACerts.pem, verify: false }, caInfo.caName);

        const walletPfad = fabricUtils.getWalletPath(args.org, __dirname);
        const wallet = await Wallets.newFileSystemWallet(walletPfad);
        const adminUserId = `admin${orgKurzName}`;
        const appUserId = `appUser${orgKurzName}_TransportOracle`;

        await fabricUtils.erstelleAdmin(wallet, caClient, args.org, adminUserId, orgKurzName);
        await fabricUtils.erstelleBenutzer(wallet, caClient, args.org, appUserId, adminUserId, `${orgKurzName.toLowerCase()}.department1`, orgKurzName);

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet, identity: appUserId, discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality');

        const transportLogReferenz = {
            dateiPfad: args.datei, 
            dateiHash: dateiHash,
            alarmZusammenfassung: alarmFestgestellt,
            systemId: args.system,
            zustaendiger: args.zustaendig,
        };
        const transportLogReferenzJSON = JSON.stringify(transportLogReferenz);

        console.log(`\n--> ORACLE-TRANSPORT Verankere Transport-Log-Datei Referenz im DPP ${args.dpp}`);
        console.log(`    Payload ${transportLogReferenzJSON}`);
        await contract.submitTransaction('TransportLogDateiVerankern', args.dpp, transportLogReferenzJSON, args.gln);
        console.log(`Referenz zur Transport-Log-Datei für DPP ${args.dpp} erfolgreich im Ledger verankert.`);

        const dppBytes = await contract.evaluateTransaction('DPPAbfragen', args.dpp);
        const aktualisierterDpp = JSON.parse(dppBytes.toString());
        console.log(`\nStatus DPP ${args.dpp} nach Transport-Log Verankerung: ${aktualisierterDpp.status}`);

        if (aktualisierterDpp.verankerteTransportLogs && aktualisierterDpp.verankerteTransportLogs.length > 0) {
            console.log("Zuletzt verankerte Transport-Log Referenz:", aktualisierterDpp.verankerteTransportLogs[aktualisierterDpp.verankerteTransportLogs.length - 1]);
        } else if (aktualisierterDpp.transportLogReferenz) { 
             console.log("Verankerte Transport-Log Referenz:", aktualisierterDpp.transportLogReferenz);
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