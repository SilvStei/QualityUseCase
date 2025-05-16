// -----------------------------------------------------------------------------
// unternehmenC_app.js – Compounder (Org3MSP) mischt PP + GF-Masterbatch
// Erstellt neuen DPP via RecordTransformation, behält Verweise auf Inputs.
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
const ccpPathOrg3 = path.resolve(
  __dirname, '..', '..', 'fabric-samples', 'test-network',
  'organizations', 'peerOrganizations', 'org3.example.com',
  'connection-org3.json'
);
const walletPath  = path.join(__dirname, 'wallet');

const MSP_ID_ORG3 = 'Org3MSP';
const CA_NAME_ORG3 = 'ca.org3.example.com';

// GS1-Stammdaten Compounder C
const GLN_ORG3        = '4077777000005';
const GS1_COMP_PREFIX = '4077777';

// Hilfsfunktion SGTIN
function makeSgtin(prefix, itemRef, serial) {
  return `urn:epc:id:sgtin:${prefix}.${itemRef}.${serial}`;
}

// -----------------------------------------------------------------------------
// 2. IDs der eingehenden DPPs – hier als Platzhalter anpassen!
// -----------------------------------------------------------------------------
const dppIdFromA = 'DPP_A_1747343624592';   // <== hier die echte ID einsetzen (von A → B → C)
const dppIdFromB = 'DPP_B_1747343658272';   // <== hier die echte ID einsetzen (von B → C)

// -----------------------------------------------------------------------------
// 3. Hauptablauf
// -----------------------------------------------------------------------------
async function main() {
  try {
    // -------------------------------------------------------------------------
    // 3.1 Wallet & CA
    // -------------------------------------------------------------------------
    const ccp    = JSON.parse(fs.readFileSync(ccpPathOrg3, 'utf8'));
    const caInfo = ccp.certificateAuthorities[CA_NAME_ORG3];
    const ca     = new FabricCAServices(caInfo.url);

    const wallet = await Wallets.newFileSystemWallet(walletPath);
    await enrollAdmin(wallet, ca, MSP_ID_ORG3, 'adminOrg3');
    await registerAndEnrollUser(wallet, ca, MSP_ID_ORG3,
                                'appUserOrg3', 'adminOrg3', 'org3.department1');

    // -------------------------------------------------------------------------
    // 3.2 Gateway & Contract
    // -------------------------------------------------------------------------
    const gateway = new Gateway();
    await gateway.connect(ccp, {
      wallet,
      identity: 'appUserOrg3',
      discovery: { enabled: true, asLocalhost: true }
    });

    const network  = await gateway.getNetwork('mychannel');
    const contract = network.getContract('dpp_quality_go_v2');

    // -------------------------------------------------------------------------
    // 3.3 Eingehende DPPs prüfen
    // -------------------------------------------------------------------------
    console.log('\n--> [C] Prüfe Besitz der eingehenden DPPs ...');
    const inputIds = [dppIdFromA, dppIdFromB];
    const inputGs1 = [];

    for (const id of inputIds) {
      const bytes = await contract.evaluateTransaction('QueryDPP', id);
      const dpp   = JSON.parse(bytes.toString());

      if (dpp.ownerOrg !== MSP_ID_ORG3) {
        throw new Error(`DPP ${id} gehört nicht Org3MSP (aktuell: ${dpp.ownerOrg})`);
      }
      console.log(`✓ DPP ${id} vorhanden – GS1: ${dpp.gs1Key}`);
      inputGs1.push(dpp.gs1Key);
    }

    // -------------------------------------------------------------------------
    // 3.4 Transformation (Compounding) anlegen
    // -------------------------------------------------------------------------
    const now       = new Date();
    const newDppId  = `DPP_C_${now.getTime()}`;
    const newGs1Key = makeSgtin(GS1_COMP_PREFIX, '055555', now.getTime());
    const batchC    = 'C-001';
    const prodDate  = now.toISOString().slice(0, 10);

    const qcCompound = {
      testName: 'Dichte',
      result:   '0.97',
      unit:     'g/cm3',
      systemId: 'LAB-C-QA',
      responsible: 'Ing. Weber',
      timestamp: now.toISOString()
    };

    console.log(`\n--> [C] RecordTransformation → ${newDppId}`);
    await contract.submitTransaction(
      'RecordTransformation',
      newDppId,
      newGs1Key,
      GLN_ORG3,
      batchC,
      prodDate,
      JSON.stringify(inputGs1),       // Inputs = GS1-Keys von A & B
      JSON.stringify(qcCompound)      // Qualitätsblock
    );
    console.log('✓ Compound-DPP erstellt');

    // -------------------------------------------------------------------------
    // 3.5 neuen Pass anzeigen
    // -------------------------------------------------------------------------
    const newBytes = await contract.evaluateTransaction('QueryDPP', newDppId);
    console.log('\n[Neuer Compound-DPP]\n',
      JSON.stringify(JSON.parse(newBytes.toString()), null, 2));

    // -------------------------------------------------------------------------
	// 3.6 Transfer des aggregierten Passes an Tier-1 (Org4MSP = Unternehmen D)
	// -------------------------------------------------------------------------
	console.log('\n--> [C] TransferDPP an Org4MSP');
	await contract.submitTransaction('TransferDPP', newDppId, 'Org4MSP', GLN_ORG3);
	console.log('✓ Transfer an D abgeschlossen');

	
    await gateway.disconnect();
    console.log('\n[C] Gateway getrennt – Unternehmen C abgeschlossen');
  } catch (err) {
    console.error('[C] FEHLER:', err);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 4. Hilfsfunktionen
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
  const adminId  = await wallet.get(adminLabel);
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
