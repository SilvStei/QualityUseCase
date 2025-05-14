// -----------------------------------------------------------------------------
// unternehmenA_app.js  – Client-Demo für GS1-DPP (Org1MSP = Unternehmen A)
// Stand: Mai 2025 – getestet mit Hyperledger Fabric 2.5, Node SDK 2.2
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices    = require('fabric-ca-client');
const path = require('path');
const fs   = require('fs');

// -----------------------------------------------------------------------------
// 1. Pfade & Konstanten – bitte auf deine Ordnerstruktur anpassen
// -----------------------------------------------------------------------------
const ccpPathOrg1 = path.resolve(
  __dirname, '..', '..', 'fabric-samples', 'test-network',
  'organizations', 'peerOrganizations', 'org1.example.com',
  'connection-org1.json'
);

const walletPath = path.join(__dirname, 'wallet');           // ./Anwendungen/wallet
const MSP_ID_ORG1 = 'Org1MSP';
const CA_NAME_ORG1 = 'ca.org1.example.com';

// GS1-Basisdaten von Unternehmen A (Demo-Werte)
const GLN_ORG1        = '4012345000002';                      // Global Location Number A
const GS1_COMP_PREFIX = '4012345';                            // 7-stelliger Company Prefix

// Hilfsfunktion für einfache SGTIN-Erzeugung (ohne Prüfziffer-Berechnung)
function makeSgtin(companyPrefix, itemRef, serial) {
  return `urn:epc:id:sgtin:${companyPrefix}.${itemRef}.${serial}`;
}

// -----------------------------------------------------------------------------
// 2. Hauptlogik
// -----------------------------------------------------------------------------
async function main() {
  try {
    // -- CA-Client & Wallet vorbereiten ---------------------------------------
    const ccp    = JSON.parse(fs.readFileSync(ccpPathOrg1, 'utf8'));
    const caInfo = ccp.certificateAuthorities[CA_NAME_ORG1];
    const ca     = new FabricCAServices(caInfo.url);

    const wallet = await Wallets.newFileSystemWallet(walletPath);
    await enrollAdmin(wallet, ca, MSP_ID_ORG1, 'adminOrg1');
    await registerAndEnrollUser(wallet, ca, MSP_ID_ORG1,
                                'appUserOrg1', 'adminOrg1', 'org1.department1');

    // -- Gateway öffnen -------------------------------------------------------
    const gateway = new Gateway();
    await gateway.connect(ccp, {
      wallet,
      identity: 'appUserOrg1',
      discovery: { enabled: true, asLocalhost: true }
    });

    const network  = await gateway.getNetwork('mychannel');
    const contract = network.getContract('dpp_quality_go_v2');       // Name beim Commit!

    // -------------------------------------------------------------------------
    // 3. Demo-Ablauf: DPP anlegen, Qualitätsdaten hinzufügen, weitergeben
    // -------------------------------------------------------------------------
    // 3.1 Neue IDs generieren
    const nowDate = new Date();
    const dppId   = `DPP_A_${nowDate.getTime()}`;             // Ledger-Key
    const gs1Key  = makeSgtin(GS1_COMP_PREFIX, '012345', nowDate.getTime());
    const batch   = 'A-123';
    const prodISO = nowDate.toISOString().slice(0, 10);       // YYYY-MM-DD

    console.log(`\n--> [A] CreateDPP ${dppId}`);
    await contract.submitTransaction(
      'CreateDPP',
      dppId,          // Ledger-ID
      gs1Key,         // GS1-Schlüssel
      GLN_ORG1,       // Hersteller-GLN
      batch,          // Chargenname
      prodISO         // Produktionsdatum
    );
    console.log(`✓ DPP ${dppId} angelegt (GS1 ${gs1Key})`);

    // 3.2 LIMS-Prüfergebnis anhängen
    const limsEntry = {
      testName:    'Melt Flow Index (230 °C / 2,16 kg)',
      result:      '12.3',
      unit:        'g/10 min',
      systemId:    'LIMS-LAB01',
      responsible: 'Dr. Krause',
      timestamp:   new Date().toISOString()
    };
    console.log(`\n--> [A] AddQualityData (LIMS)`);
    await contract.submitTransaction('AddQualityData',
                                     dppId, JSON.stringify(limsEntry));
    console.log('✓ LIMS-Datensatz gespeichert');

    // 3.3 QMS-Eingangsprüfung anhängen
    const qmsEntry = {
      testName:    'Visuelle Prüfung – Granulatfarbe',
      result:      'OK',
      unit:        '',
      systemId:    'QMS-01',
      responsible: 'S. Müller',
      timestamp:   new Date().toISOString()
    };
    await contract.submitTransaction('AddQualityData',
                                     dppId, JSON.stringify(qmsEntry));
    console.log('✓ QMS-Datensatz gespeichert');

    // 3.4 DPP lesen
    const dppBytes = await contract.evaluateTransaction('QueryDPP', dppId);
    console.log('\n[DPP-Inhalt A]\n',
      JSON.stringify(JSON.parse(dppBytes.toString()), null, 2));

    // 3.5 Eigentümerwechsel an Unternehmen B (Org2MSP)
    console.log(`\n--> [A] TransferDPP → Org3MSP`);
    await contract.submitTransaction('TransferDPP', dppId, 'Org3MSP');
    console.log('✓ Transfer abgeschlossen');

    // 3.6 Kontrolle Eigentümer
    const dppAfter = JSON.parse(
      (await contract.evaluateTransaction('QueryDPP', dppId)).toString()
    );
    console.log(`Neuer Eigentümer: ${dppAfter.ownerOrg}`);

    // -------------------------------------------------------------------------
    await gateway.disconnect();
    console.log('\n[A] Gateway getrennt – Demo beendet');
  } catch (err) {
    console.error('[A] FEHLER:', err);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 4. Hilfsfunktionen für Admin/User-Handling
// -----------------------------------------------------------------------------
async function enrollAdmin(wallet, ca, mspId, label) {
  if (await wallet.get(label)) return;

  const enrollment = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
  const identity = {
    credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
    mspId, type: 'X.509'
  };
  await wallet.put(label, identity);
  console.log(`Admin ${label} enrollt`);
}

async function registerAndEnrollUser(wallet, ca, mspId,
                                     userLabel, adminLabel, affiliation) {
  if (await wallet.get(userLabel)) return;

  const admin   = await wallet.get(adminLabel);
  const provider = wallet.getProviderRegistry().getProvider(admin.type);
  const adminUser = await provider.getUserContext(admin, adminLabel);

  const secret = await ca.register({
    affiliation, enrollmentID: userLabel, role: 'client'
  }, adminUser);
  const enrollment = await ca.enroll({ enrollmentID: userLabel, enrollmentSecret: secret });

  await wallet.put(userLabel, {
    credentials: { certificate: enrollment.certificate, privateKey: enrollment.key.toBytes() },
    mspId, type: 'X.509'
  });
  console.log(`User ${userLabel} registriert & enrollt`);
}

// -----------------------------------------------------------------------------
main();
