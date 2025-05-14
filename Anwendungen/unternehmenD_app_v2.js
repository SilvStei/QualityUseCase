// -----------------------------------------------------------------------------
// unternehmenD_app.js – Tier-1 / Spritzgießer (Org4MSP) empfängt Compound-DPP
// Stand: Mai 2025 – Hyperledger Fabric 2.5 / Node SDK 2.2
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets } = require('fabric-network');
const FabricCAServices    = require('fabric-ca-client');
const path = require('path');
const fs   = require('fs');

// -----------------------------------------------------------------------------
// 1. Pfade & Konstanten
// -----------------------------------------------------------------------------
const ccpPathOrg4 = path.resolve(
  __dirname, '..', '..', 'fabric-samples', 'test-network',
  'organizations', 'peerOrganizations', 'org4.example.com',
  'connection-org4.json'
);
const walletPath  = path.join(__dirname, 'wallet');

const MSP_ID_ORG4 = 'Org4MSP';
const CA_NAME_ORG4 = 'ca.org4.example.com';

// -----------------------------------------------------------------------------
// 2. DPP-ID, die von C übertragen wurde – hier anpassen!
// -----------------------------------------------------------------------------
const dppIdFromC = 'DPP_C_1747253988730';  // <== echte ID eintragen

// -----------------------------------------------------------------------------
// 3. Hauptablauf
// -----------------------------------------------------------------------------
async function main() {
  try {
    // 3.1 Wallet & CA ---------------------------------------------------------
    const ccp    = JSON.parse(fs.readFileSync(ccpPathOrg4, 'utf8'));
    const caInfo = ccp.certificateAuthorities[CA_NAME_ORG4];
    const ca     = new FabricCAServices(caInfo.url);

    const wallet = await Wallets.newFileSystemWallet(walletPath);
    await enrollAdmin(wallet, ca, MSP_ID_ORG4, 'adminOrg4');
    await registerAndEnrollUser(wallet, ca, MSP_ID_ORG4,
                                'appUserOrg4', 'adminOrg4', 'org4.department1');

    // 3.2 Gateway ------------------------------------------------------------
    const gateway = new Gateway();
    await gateway.connect(ccp, {
      wallet,
      identity: 'appUserOrg4',
      discovery: { enabled: true, asLocalhost: true }
    });

    const network  = await gateway.getNetwork('mychannel');
    const contract = network.getContract('dpp_quality_go_v2');

    // 3.3 Compound-Pass lesen -----------------------------------------------
    console.log(`\n--> [D] QueryDPP ${dppIdFromC}`);
    const bytes = await contract.evaluateTransaction('QueryDPP', dppIdFromC);
    const dpp   = JSON.parse(bytes.toString());

    if (dpp.ownerOrg !== MSP_ID_ORG4) {
      throw new Error(`DPP ${dppIdFromC} gehört nicht Org4MSP (aktuell: ${dpp.ownerOrg})`);
    }
    console.log('\n[Empfangener Compound-DPP]\n',
      JSON.stringify(dpp, null, 2));

    // 3.4 Eingangsprüfung anhängen (optional) --------------------------------
    const qcIncoming = {
      testName: 'Eingangsprüfung Granulatfeuchte',
      result:   '0.04',
      unit:     '%',
      systemId: 'LAB-D-IN',
      responsible: 'Qualitätsteam D',
      timestamp: new Date().toISOString()
    };

    console.log('\n--> [D] AddQualityData (Eingangsprüfung)');
    await contract.submitTransaction('AddQualityData',
                                     dppIdFromC, JSON.stringify(qcIncoming));
    console.log('✓ Eingangsprüfung gespeichert');

    // 3.5 Abschlusskontrolle --------------------------------------------------
    const after = JSON.parse(
      (await contract.evaluateTransaction('QueryDPP', dppIdFromC)).toString()
    );
    console.log('\n[DPP nach Eingangsprüfung]\n',
      JSON.stringify(after, null, 2));

    await gateway.disconnect();
    console.log('\n[D] Gateway getrennt – Unternehmen D abgeschlossen');
  } catch (err) {
    console.error('[D] FEHLER:', err);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 4. Hilfsfunktionen
// -----------------------------------------------------------------------------
async function enrollAdmin(wallet, ca, mspId, label) {
  if (await wallet.get(label)) return;
  const e = await ca.enroll({ enrollmentID: 'admin', enrollmentSecret: 'adminpw' });
  await wallet.put(label, {
    credentials: { certificate: e.certificate, privateKey: e.key.toBytes() },
    mspId, type: 'X.509'
  });
}

async function registerAndEnrollUser(wallet, ca, mspId,
                                     userLabel, adminLabel, affiliation) {
  if (await wallet.get(userLabel)) return;
  const adminId  = await wallet.get(adminLabel);
  const provider = wallet.getProviderRegistry().getProvider(adminId.type);
  const admin    = await provider.getUserContext(adminId, adminLabel);
  const secret   = await ca.register({
    affiliation, enrollmentID: userLabel, role: 'client'
  }, admin);
  const e = await ca.enroll({ enrollmentID: userLabel, enrollmentSecret: secret });
  await wallet.put(userLabel, {
    credentials: { certificate: e.certificate, privateKey: e.key.toBytes() },
    mspId, type: 'X.509'
  });
}

// -----------------------------------------------------------------------------
main();