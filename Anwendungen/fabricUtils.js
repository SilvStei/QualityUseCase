'use strict';

const { Wallets } = require('fabric-network');
const FabricCAServices = require('fabric-ca-client');
const path = require('path'); 

async function pruefeWallet(wallet, identLabel) {
    return await wallet.get(identLabel);
}

async function erstelleAdmin(wallet, caClient, mspId, adminUserId, orgNameForLog = '') {
    try {
        if (await pruefeWallet(wallet, adminUserId)) {
            console.log(`Admin "${adminUserId}" existiert${orgNameForLog ? ' in Wallet ' + orgNameForLog : ''}`);
            return;
        }
        const enrollment = await caClient.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
        const x509Ident = {
            credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
            mspId: mspId, type: 'X.509',
        };
        await wallet.put(adminUserId, x509Ident);
        console.log(`Admin "${adminUserId}" registriert${orgNameForLog ? ' fuer Wallet ' + orgNameForLog : ''}`);
    } catch (error) {
        console.error(`Fehler Admin Erstellung${orgNameForLog ? ' ' + orgNameForLog : ''}: ${error.message}`);
        throw error;
    }
}

async function erstelleBenutzer(wallet, caClient, mspId, userId, adminUserId, affiliation, orgNameForLog = '') {
    try {
        if (await pruefeWallet(wallet, userId)) {
            console.log(`Benutzer "${userId}" existiert${orgNameForLog ? ' in Wallet ' + orgNameForLog : ''}`);
            return;
        }
        const adminIdent = await wallet.get(adminUserId);
        if (!adminIdent) {
            throw new Error(`Admin "${adminUserId}" nicht gefunden${orgNameForLog ? ' in Wallet ' + orgNameForLog : ''}`);
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
        console.log(`Benutzer "${userId}" registriert${orgNameForLog ? ' fuer Wallet ' + orgNameForLog : ''}`);
    } catch (error) {
        console.error(`Fehler Benutzer Erstellung${orgNameForLog ? ' ' + orgNameForLog : ''}: ${error.message}`);
        throw error;
    }
}

async function trenneGateway(gateway) {
    if (gateway) {
        await gateway.disconnect();
    }
}

async function abfrageUndLogDPP(contract, dppId, kontextNachricht, includeOwner = false) {
    console.log(`Info: ${kontextNachricht} Status: ${dppId}`);
    const dppBytes = await contract.evaluateTransaction('DPPAbfragen', dppId);
    const dpp = JSON.parse(dppBytes.toString());
    let logMessage = `Status des DPP: ${dpp.status}`;
    if (includeOwner) {
        logMessage += `, Besitzer: ${dpp.ownerOrg}`;
    }
    console.log(logMessage);
    if (dpp.offenePflichtpruefungen && dpp.offenePflichtpruefungen.length > 0) {
        console.log(`Noch offene Pflichtprüfungen ${dpp.offenePflichtpruefungen.join(', ')}`);
    }
    if (dpp.status === "Gesperrt") {
        console.error(`DPP ${dppId} ist gesperrt!`);
    }
    return dpp;
}

function getWalletPath(orgMspId, basePath) {
    const orgKurz = orgMspId.replace('MSP', '');
    let walletDirName;
    if (orgKurz === "Org1") walletDirName = 'walletA';
    else if (orgKurz === "Org2") walletDirName = 'walletB';
    else if (orgKurz === "Org3") walletDirName = 'walletC';
    else if (orgKurz === "Org4") walletDirName = 'walletD';
    else {
        throw new Error(`Kein definierter Wallet-Verzeichnisname für ${orgMspId}`);
    }
    return path.join(basePath, walletDirName);
}

function getCcpPath(orgMspId, basePath) {
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

module.exports = {
    pruefeWallet,
    erstelleAdmin,
    erstelleBenutzer,
    trenneGateway,
    abfrageUndLogDPP,
    getWalletPath,   
    getCcpPath      
};