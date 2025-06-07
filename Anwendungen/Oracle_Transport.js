'use strict';


//Benötigt
const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path');
const fs = require('fs');
const { ArgumentParser } = require('argparse');
const fabricUtils = require('./fabricUtils.js');
const crypto = require('crypto');


//Konsolenargumente lesen und bearbeiten
function parseArgumente() {
    const parser = new ArgumentParser({
        beschreibung: 'Transportdaten verarbeiten und hashen'
    });
    parser.add_argument('--dpp', { required: true });
    parser.add_argument('--datei', { required: true });
    parser.add_argument('--org', { required: true });
    parser.add_argument('--gln', { required: true });
    parser.add_argument('--system', { required: true });
    parser.add_argument('--zustaendig', { default: 'Logistiksystem' });
    return parser.parse_args();
}

async function main() {
    const args = parseArgumente();
    console.log(`Transport-Oracle: Verarbeite Log ${args.datei} zur Verankerung im DPP`);
    console.log(`   DPP ${args.dpp}, Org ${args.org}`);

    let gateway;
    try {

        //Schauen ob Datei existiert
        if (!fs.existsSync(args.datei)) throw new Error(`Transportlog nicht gefunden ${args.datei}`);
        const dateiInhalt = fs.readFileSync(args.datei, 'utf8');
        //Hash erzeugen um Unveränderlichkeit bezeugen zu können
        const dateiHash = crypto.createHash('sha256').update(dateiInhalt).digest('hex');
        console.log(`  Hash ist ${dateiHash}`);

        //Leerzeichen entfernen und zeilenweise Strings
        const zeilen = dateiInhalt.trim().split('\n');
        let alarmFestgestellt = "NEIN"; 

        if (zeilen.length > 1) { 
            const kopfzeile = zeilen[0].toLowerCase().split(','); 
            //nach zustand suchen, weil der benötigt wird
            const zustandIdx = kopfzeile.indexOf('zustand');
            
            //nur wenn zustand gefunden wird
            if (zustandIdx !== -1) {
                for (let i = 1; i < zeilen.length; i++) {
                    //andere Zeilen auch in einzelne Strings umwandeln
                    const werte = zeilen[i].split(',');
                    //Schauen ob Alarm im Skript ist
                    if (werte.length > zustandIdx && werte[zustandIdx] && werte[zustandIdx].toUpperCase() === 'ALARM') {
                        alarmFestgestellt = "JA";
                        console.log(`  ALARM bei Transport festgestellt.`);
                        break; 
                    }
                }
            } else {
                console.warn("Zustand ist nicht in Transportdatei, Alarmprüfung nicht möglich");
            }

        } else if (zeilen.length === 0 || (zeilen.length === 1 && zeilen[0].trim() === '')) {
             console.warn(`Keine Daten in Transportdatei ${args.datei}, Hash trotzdem verankern`);
        } else { 
            console.warn(`Transportdatei ${args.datei} enthält Kopfzeile`);
        }


        const orgKurzName = args.org.replace('MSP', '');

        //Connection Profil holen
        const ccpPfad = fabricUtils.holeCcpPfad(args.org, __dirname);
        if (!fs.existsSync(ccpPfad)) throw new Error(`CCP ${ccpPfad} nicht gefunden`);
        //Nutzbar machen
        const ccp = JSON.parse(fs.readFileSync(ccpPfad, 'utf8'));

        //OrgX muss großgeschrieben sein, sonst Fehler - deshalb ersten Buchstaben groß
        const orgCcpName = orgKurzName.charAt(0).toUpperCase() + orgKurzName.slice(1);

        if (!ccp.organizations[orgCcpName] || !ccp.organizations[orgCcpName].certificateAuthorities || ccp.organizations[orgCcpName].certificateAuthorities.length === 0) {
            throw new Error(`Keine CAs für ${orgCcpName} in ${ccpPfad}`);
        }

        //Name der CA holen
        const caNameAusCcp = ccp.organizations[orgCcpName].certificateAuthorities[0];
        //Informationen spezifischer CA holen
        const caInfo = ccp.certificateAuthorities[caNameAusCcp];
        if (!caInfo) throw new Error(`CA ${caNameAusCcp} nicht in ${ccpPfad}`);

        //CA Client erstellen, verify: false da sonst Fehler
        const caClient = new FabricCAServices(caInfo.url, { trustedRoots: caInfo.tlsCACerts.pem, verify: false }, caInfo.caName);

        //Informationen holen
        const walletPfad = fabricUtils.holeWalletPfad(args.org, __dirname);
        const wallet = await Wallets.newFileSystemWallet(walletPfad);
        const adminUserId = `admin${orgKurzName}`;
        const appUserId = `appUser${orgKurzName}_TransportOracle`;

        //Admin und Benutzer erstellen
        await fabricUtils.erstelleAdmin(wallet, caClient, args.org, adminUserId, orgKurzName);
        await fabricUtils.erstelleBenutzer(wallet, caClient, args.org, appUserId, adminUserId, `${orgKurzName.toLowerCase()}.department1`, orgKurzName);

        //Verbindung mit Gateway herstellen
        gateway = new Gateway();
        await gateway.connect(ccp, {
            wallet, identity: appUserId, discovery: { enabled: true, asLocalhost: true }
        });

        //Channel und Contract
        const network = await gateway.getNetwork('mychannel');
        const contract = network.getContract('dpp_quality');

        //Infromationen zu Transport zusammenstellen
        const transportLogReferenz = {
            dateiPfad: args.datei, 
            dateiHash: dateiHash,
            alarmZusammenfassung: alarmFestgestellt,
            systemId: args.system,
            zustaendiger: args.zustaendig,
        };

        //Umwandeln in String
        const transportLogReferenzJSON = JSON.stringify(transportLogReferenz);

        //Ausgabe
        console.log(`Verankere Transportlog im DPP ${args.dpp}`);
        console.log(`    Inhalt: ${transportLogReferenzJSON}`);

        //Datein in Blockchain schreiben
        await contract.submitTransaction('TransportLogDateiVerankern', args.dpp, transportLogReferenzJSON, args.gln);

        //Dpp auslesen bzw. überprüfen
        const dppBytes = await contract.evaluateTransaction('DPPAbfragen', args.dpp);
        //Nutzbare Var erstellen
        const aktualisierterDpp = JSON.parse(dppBytes.toString());
        console.log(`Status des DPP ${args.dpp} nach Transport: ${aktualisierterDpp.status}`);

        //Ausgabe der Transportdaten
        if (aktualisierterDpp.verankerteTransportLogs && aktualisierterDpp.verankerteTransportLogs.length > 0) {
            console.log("Zuletzt verankerte Transport-Log Referenz:", aktualisierterDpp.verankerteTransportLogs[aktualisierterDpp.verankerteTransportLogs.length - 1]);
        } else if (aktualisierterDpp.transportLogReferenz) { 
             console.log("Verankerte Transport-Log Referenz:", aktualisierterDpp.transportLogReferenz);
        }


        if (aktualisierterDpp.status.includes("Fehler") || aktualisierterDpp.status === "Gesperrt") {
            console.warn(`Achtung! DPP ${args.dpp} hat Status ${aktualisierterDpp.status}`);
        }

    } catch (error) {
        console.error(`Fehler in Skript: ${error.message || error}`);
        process.exit(1);


    } finally {
        if (gateway) {
            await gateway.disconnect();
        }
    }
}

main();