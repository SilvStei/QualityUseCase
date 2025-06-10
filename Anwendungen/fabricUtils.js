'use strict';

//Import der benötigten Bibs
const { Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path'); 


//Schauen ob Identität bereits im Wallet ist
async function pruefeWallet(wallet, identLabel) {
    return await wallet.get(identLabel);
}


//Admin im Netzwerk erstellen
async function erstelleAdmin(wallet, caClient, mspId, adminBenutzerId, orgNameLog = '') {
    try {
        if (await pruefeWallet(wallet, adminBenutzerId)) {
            console.log(`Admin "${adminBenutzerId}" ist bereits im Wallet registriert.`);
            return;
        }

        //Admin registrieren
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        //Umwandeln in benötigtes Format
        const x509Ident = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
            mspId: mspId, type: 'X.509',
        };

        //Identität im Wallet ablegen
        await wallet.put(adminBenutzerId, x509Ident);
        console.log(`Admin "${adminBenutzerId}" im Wallet registriert'}`);

        //Fehler abfangen sonst absturz
    } catch (error) {
        console.error(`Fehler bei Adminerstellung${orgNameLog ? ' ' + orgNameLog : ''}: ${error.message}`);
        throw error;
    }
}


//Benutzer ertsellen und registrieren
async function erstelleBenutzer(wallet, caClient, mspId, userId, adminBenutzerId, affiliation, orgNameLog = '') {
    try {
        if (await pruefeWallet(wallet, userId)) {
            console.log(`Benutzer "${userId}" existiert bereits im Wallet`);
            return;
        }

        //Erstmal Admin holen, da für Benutzerregistrierung benötigt
        const adminIdent = await wallet.get(adminBenutzerId);
        if (!adminIdent) {
            throw new Error(`Admin "${adminBenutzerId}" nicht gefunden`);
        }

        //Provider für X.509
        const provider = wallet.getProviderRegistry().getProvider(adminIdent.type);

        //Nutzbare Variable für Admin erstellen
        const adminUser = await provider.getUserContext(adminIdent, adminBenutzerId);
        //Secret für den Benutzer erstellen
        const secret = await caClient.register({ affiliation, enrollmentID: userId, role: 'client' }, adminUser);
        //Benutzer im CA registrieren
        const enrollment = await caClient.enroll({ enrollmentID: userId, enrollmentSecret: secret });
        //Umwandeln in nutzbare Identität
        const x509Ident = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
            mspId: mspId, type: 'X.509',
        };

        //Benutzer ins Wallet
        await wallet.put(userId, x509Ident);
        console.log(`Benutzer "${userId}" registriert`);
    } catch (error) {
        console.error(`Fehler bei Benutzererstellung`);
        throw error;
    }
}

//Gateway trennen
async function trenneGateway(gateway) {
    if (gateway) {
        await gateway.disconnect();
    }
}


//Zustand des DPP abfragen
async function abfrageUndLogDPP(contract, dppId, kontextNachricht, includeOwner = false) {
    console.log(`Kommentar: ${kontextNachricht} für ${dppId}`);

    //Abfragen des Dpp im Ledger
    const dppBytes = await contract.evaluateTransaction('DPPAbfragen', dppId);
    //Dpp nutzbar machen
    const dpp = JSON.parse(dppBytes.toString());

    let logMessage = `Status des DPP: ${dpp.status}`;
    if (includeOwner) {
        logMessage += `, Besitzer: ${dpp.besitzerOrg}`;
    }
    console.log(logMessage);

    //Schauen ob noch Prüfungen offen sind
    if (dpp.offenePflichtpruefungen && dpp.offenePflichtpruefungen.length > 0) {
        //Ausgeben welche Prüfungen
        console.log(`Offene Pflichtprüfungen: ${dpp.offenePflichtpruefungen.join(', ')}\n`);
    }
    //Warunung wenn Gesperrt
    if (dpp.status === "Gesperrt") {
        console.error(`DPP ${dppId} ist gesperrt!`);
    }
    return dpp;
}

function holeWalletPfad(orgMspId, basePath) {

    //MSP aus Org entfernen
    const orgKurz = orgMspId.replace('MSP', '');
    let walletDirName;
    if (orgKurz === "Org1") walletDirName = 'walletA';
    else if (orgKurz === "Org2") walletDirName = 'walletB';
    else if (orgKurz === "Org3") walletDirName = 'walletC';
    else if (orgKurz === "Org4") walletDirName = 'walletD';
    else {
        throw new Error(`Kein Wallet-Name für ${orgMspId} definiert`);
    }
    return path.join(basePath, walletDirName);
}

function holeCcpPfad(orgMspId, basePath) {
    const orgNameKlein = orgMspId.toLowerCase().replace('msp', '');
    return path.resolve(
        basePath,
        '..',   
        '..',   
        'fabric-samples',
        'test-network',
        'organizations',
        'peerOrganizations',
        `${orgNameKlein}.example.com`,
        `connection-${orgNameKlein}.json`
    );
}

//Module exportieren zu Nutzung außerhalb
module.exports = {
    pruefeWallet,
    erstelleAdmin,
    erstelleBenutzer,
    trenneGateway,
    abfrageUndLogDPP,
    holeWalletPfad,   
    holeCcpPfad      
};