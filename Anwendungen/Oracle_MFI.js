// Oracle_MFI.js
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
        description: 'Verarbeitet Sensor-Rohdaten und reicht sie bei der Blockchain ein.'
    });
    parser.add_argument('--dpp', { help: 'DPP ID', required: true });
    parser.add_argument('--datei', { help: 'Pfad zur CSV Rohdaten-Datei', required: true });
    parser.add_argument('--test', { help: 'Name des Tests (StandardName im Chaincode)', required: true });
    parser.add_argument('--org', { help: 'MSP ID der Organisation', required: true });
    parser.add_argument('--gln', { help: 'GLN der aufzeichnenden Site', required: true });
    parser.add_argument('--system', { help: 'ID des erfassenden Systems', required: true });
    parser.add_argument('--zustaendig', { help: 'Zustaendige Person/Abteilung', default: 'Autom. Prozessueberwachung' });
    parser.add_argument('--grenze_niedrig', { help: 'Untere Grenze (optional)', type: 'float', required: false });
    parser.add_argument('--grenze_hoch', { help: 'Obere Grenze (optional)', type: 'float', required: false });
    parser.add_argument('--wert_erwartet', { help: 'Erwarteter String-Wert (optional)', type: 'str', required: false });
    parser.add_argument('--einheit', { help: 'Einheit des Ergebnisses', required: false, default: "" });
    return parser.parse_args();
}

async function main() {
    const args = parseArgumente();
    console.log(`\n--> INTEGRATION Verarbeite Daten aus ${args.datei}`);
    console.log(`    DPP ${args.dpp}, Test "${args.test}", Org ${args.org}`);

    let gateway;
    try {
        if (!fs.existsSync(args.datei)) {
            throw new Error(`Rohdaten-Datei nicht gefunden ${args.datei}`);
        }
        const dateiInhalt = fs.readFileSync(args.datei, 'utf8');
		const dateiHash = crypto.createHash('sha256').update(dateiInhalt).digest('hex');
        console.log(`Datei-Hash (SHA256) ist ${dateiHash}`);
        const zeilen = dateiInhalt.trim().split('\n');
        if (zeilen.length <= 1) {
            throw new Error(`Keine Daten in Datei ${args.datei}`);
        }

        const kopfzeile = zeilen.shift().toLowerCase().split(',');
        const wertIndex = kopfzeile.indexOf('mfi_wert');
        if (wertIndex === -1) {
            throw new Error("Spalte 'mfi_wert' nicht in CSV gefunden");
        }

        const messwerte = zeilen.map(zeile => parseFloat(zeile.split(',')[wertIndex])).filter(val => !isNaN(val));
        if (messwerte.length === 0) {
            throw new Error("Keine gueltigen numerischen Werte gefunden");
        }

        const summe = messwerte.reduce((acc, val) => acc + val, 0);
        const durchschnitt = parseFloat((summe / messwerte.length).toFixed(2));
        let bewertungsergebnisClient = "";
        let kommentarClient = `Durchschnitt von ${messwerte.length} Messungen: ${durchschnitt}`;
        const ergebnisFuerChaincode = String(durchschnitt);
        const einheitFuerChaincode = args.einheit || "";

        if (typeof args.grenze_niedrig === 'number' && typeof args.grenze_hoch === 'number') {
            if (durchschnitt < args.grenze_niedrig || durchschnitt > args.grenze_hoch) {
                console.log(`    CLIENT-INFO Durchschnitt ${durchschnitt} ausserhalb Spez (${args.grenze_niedrig}-${args.grenze_hoch})`);
            } else {
                console.log(`    CLIENT-INFO Durchschnitt ${durchschnitt} innerhalb Spez (${args.grenze_niedrig}-${args.grenze_hoch})`);
            }
        } else if (args.wert_erwartet) {
            const einzelwert = String(messwerte[0]);
            if (einzelwert.toLowerCase() === args.wert_erwartet.toLowerCase()) {
                console.log(`    CLIENT-INFO Wert "${einzelwert}" entspricht Erwartung.`);
            } else {
                console.log(`    CLIENT-INFO Wert "${einzelwert}" entspricht NICHT Erwartung "${args.wert_erwartet}".`);
            }
        }
        console.log(`--- INTEGRATION Aggregiertes Ergebnis ${durchschnitt}, Kommentar ${kommentarClient} ---`);

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
        const appUserId = `appUser${orgKurzName}_Integration`;

        await fabricUtils.erstelleAdmin(wallet, caClient, args.org, adminUserId, orgKurzName);
        await fabricUtils.erstelleBenutzer(wallet, caClient, args.org, appUserId, adminUserId, `${orgKurzName.toLowerCase()}.department1`, orgKurzName);

        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet,
            identity: appUserId,
            discovery: { enabled: true, asLocalhost: true }
        });
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality');

        const qualitaetsDatenEintrag = {
            standardName: args.test,
            ergebnis: ergebnisFuerChaincode,
            einheit: einheitFuerChaincode,
            systemId: args.system,
            zustaendiger: args.zustaendig,
            offChainProtokoll: args.datei, 
            dateiHash: dateiHash, 
            bewertungsergebnis: bewertungsergebnisClient,
            kommentarBewertung: kommentarClient,
        };
        const qualitaetsDatenJSON = JSON.stringify(qualitaetsDatenEintrag);

        console.log(`\n--> INTEGRATION Sende Qualitaetsdaten an Chaincode DPP ${args.dpp}`);
        console.log(`    Payload ${qualitaetsDatenJSON}`);
        await contract.submitTransaction('AufzeichnenTestergebnisse', args.dpp, qualitaetsDatenJSON, args.gln);
        console.log(`Qualitaetsdaten fuer DPP ${args.dpp} gespeichert`);

        const dppBytes = await contract.evaluateTransaction('DPPAbfragen', args.dpp);
        const aktualisierterDpp = JSON.parse(dppBytes.toString());
        console.log(`\nNeuer Status DPP ${args.dpp} ${aktualisierterDpp.status}`);
        if (aktualisierterDpp.status === "Gesperrt") {
            console.error("ACHTUNG DPP wurde blockiert!");
        } else if (aktualisierterDpp.status === "FreigegebenMitFehler") {
            console.warn(`INFO DPP hat Probleme ${aktualisierterDpp.status}`);
        }

    } catch (error) {
        console.error(`INTEGRATION FEHLER ${error.stack ? error.stack : error}`);
        process.exit(1);
    } finally {
        if (gateway) {
            await gateway.disconnect();
            console.log('\nINTEGRATION Skript beendet.');
        }
    }
}

main();