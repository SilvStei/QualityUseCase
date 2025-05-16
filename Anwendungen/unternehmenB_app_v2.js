// -----------------------------------------------------------------------------
// unternehmenB_app.js – Client-Demo für GS1-DPP (Org2MSP = Unternehmen B)
// Erstellt ein Glasfaser-Masterbatch, fügt Qualitätsdaten an und transferiert
// den Pass an Org3MSP.  Stand: Mai 2025
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices    = require('fabric-ca-client');
const path = require('path');
const fs   = require('fs');

// -----------------------------------------------------------------------------
// 1. Pfade & Konstanten
// -----------------------------------------------------------------------------
const ccpPathOrg2 = path.resolve(
  __dirname, '..', '..', 'fabric-samples', 'test-network',
  'organizations', 'peerOrganizations', 'org2.example.com',
  'connection-org2.json'
);
const walletPath = path.join(__dirname, 'wallet');

const MSP_ID_ORG2 = 'Org2MSP';
const CA_NAME_ORG2 = 'ca.org2.example.com';

// GS1-Stammdaten für Unternehmen B
const GLN_ORG2        = '4098765000007';
const GS1_COMP_PREFIX = '4098765';

// Hilfsfunktion SGTIN
function makeSgtin(prefix, itemRef, serial) {
  return `urn:epc:id:sgtin:${prefix}.${itemRef}.${serial}`;
}

// -----------------------------------------------------------------------------
// 2. Hauptablauf
// -----------------------------------------------------------------------------
async function main() {
  try {
    // -- Wallet & CA ----------------------------------------------------------
    const ccp    = JSON.parse(fs.readFileSync(ccpPathOrg2, 'utf8'));
    const caInfo = ccp.certificateAuthorities[CA_NAME_ORG2];
    const ca     = new FabricCAServices(caInfo.url);

    const wallet = await Wallets.newFileSystemWallet(walletPath);
    await enrollAdmin(wallet, ca, MSP_ID_ORG2, 'adminOrg2');
    await registerAndEnrollUser(wallet, ca, MSP_ID_ORG2,
                                'appUserOrg2', 'adminOrg2', 'org2.department1');

    // -- Gateway --------------------------------------------------------------
    const gateway = new Gateway();
    await gateway.connect(ccp, {
      wallet,
      identity: 'appUserOrg2',
      discovery: { enabled: true, asLocalhost: true }
    });

    const network  = await gateway.getNetwork('mychannel');
    const contract = network.getContract('dpp_quality_go_v2');

    // -------------------------------------------------------------------------
    // 3. DPP für Glasfaser-Masterbatch anlegen
    // -------------------------------------------------------------------------
    const now      = new Date();
    const dppId    = `DPP_B_${now.getTime()}`;
    const gs1Key   = makeSgtin(GS1_COMP_PREFIX, '067890', now.getTime());
    const batch    = 'B-456';
    const prodDate = now.toISOString().slice(0, 10);

    console.log(`\n--> [B] CreateDPP ${dppId}`);
    await contract.submitTransaction(
      'CreateDPP',
      dppId,
      gs1Key,
      GLN_ORG2,
      batch,
      prodDate
    );
    console.log('✓ DPP angelegt');

    // 3.1 Laborprüfung Glasfasergehalt
    const qcGF = {
      testName:    'Glasfaser-Gewichtsanteil',
      result:      '30',
      unit:        'wt-%',
      systemId:    'LAB-B-QA',
      responsible: 'Dipl-Ing König',
      timestamp:   new Date().toISOString()
    };
    await contract.submitTransaction('AddQualityData',
                                     dppId, JSON.stringify(qcGF));
    console.log('✓ GF-Anteil gespeichert');

    // 3.2 MFI-Test
    const qcMfi = {
      testName: 'Melt Flow Index (230 °C / 2,16 kg)',
      result:   '9.8',
      unit:     'g/10 min',
      systemId: 'LAB-B-QA',
      responsible: 'Dipl-Ing König',
      timestamp: new Date().toISOString()
    };
    await contract.submitTransaction('AddQualityData',
                                     dppId, JSON.stringify(qcMfi));
    console.log('✓ MFI gespeichert');

    // 3.3 Kontrolle
    const dppBytes = await contract.evaluateTransaction('QueryDPP', dppId);
    console.log('\n[DPP-Inhalt B]\n',
      JSON.stringify(JSON.parse(dppBytes.toString()), null, 2));

    // -------------------------------------------------------------------------
    // 4. Transfer an Compounder (Org3MSP)
    // -------------------------------------------------------------------------
    console.log('\n--> [B] TransferDPP an Org3MSP');
    await contract.submitTransaction('TransferDPP', dppId, 'Org3MSP', GLN_ORG2);
    console.log('✓ Transfer abgeschlossen');

    // -------------------------------------------------------------------------
    await gateway.disconnect();
    console.log('\n[B] Gateway getrennt – Unternehmen B-Demo beendet');
  } catch (err) {
    console.error('[B] FEHLER:', err);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 5. Hilfsfunktionen
// -----------------------------------------------------------------------------
async function enrollAdmin(wallet, ca, mspId, label) {
  if (await wallet.get(label)) return;
  const enrollment = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
  await wallet.put(label, {
    credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
    mspId, type: 'X.509'
  });
}

async function registerAndEnrollUser(wallet, ca, mspId,
                                     userLabel, adminLabel, affiliation) {
  if (await wallet.get(userLabel)) return;
  const adminId = await wallet.get(adminLabel);
  const provider = wallet.getProviderRegistry().getProvider(adminId.type);
  const admin    = await provider.getUserContext(adminId, adminLabel);
  const secret   = await ca.register({
    affiliation, enrollmentID: userLabel, role: 'client'
  }, admin);
  const enrollment = await ca.enroll({ enrollmentID: userLabel, enrollmentSecret: secret });
  await wallet.put(userLabel, {
    credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
    mspId, type: 'X.509'
  });
}

// -----------------------------------------------------------------------------
main();
