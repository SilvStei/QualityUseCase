// -----------------------------------------------------------------------------
// unternehmenD_app_v2.js – Tier-1 / Spritzgießer (Org4MSP) empfängt Compound-DPP
// Stand: Mai 2025 – Hyperledger Fabric 2.5 / Node SDK 2.2
// -----------------------------------------------------------------------------
'use strict';

const { Gateway, Wallets }   = require('fabric-network');
const FabricCAServices       = require('fabric-ca-client');
const path                   = require('path');
const fs                     = require('fs');

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
const dppIdFromC = 'DPP_C_1747343695644';  // <== echte ID eintragen

// -----------------------------------------------------------------------------
// 3. Hauptablauf
// -----------------------------------------------------------------------------
async function main() {
  try {
    // 3.1 Wallet & CA ---------------------------------------------------------
    const ccp     = JSON.parse(fs.readFileSync(ccpPathOrg4, 'utf8'));
    const caInfo  = ccp.certificateAuthorities[CA_NAME_ORG4];
    const ca      = new FabricCAServices(caInfo.url);
    const wallet  = await Wallets.newFileSystemWallet(walletPath);

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
      testName:    'Eingangsprüfung Granulatfeuchte',
      result:      '0.04',
      unit:        '%',
      systemId:    'LAB-D-IN',
      responsible: 'Qualitätsteam D',
      timestamp:   new Date().toISOString()
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
    // Wenn die Identity tatsächlich beim CA-Server existiert, musst du sie
    // zuerst dort löschen (siehe unten) und dann das Skript erneut ausführen.
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 4. Hilfsfunktionen
// -----------------------------------------------------------------------------
async function enrollAdmin(wallet, caClient, mspId, adminLabel) {
  if (await wallet.get(adminLabel)) {
    console.log(`→ Admin-Identität '${adminLabel}' bereits im Wallet.`);
    return;
  }
  const enrollment = await caClient.enroll({
    enrollmentID: 'admin',
    enrollmentSecret: 'adminpw'
  });
  const x509Identity = {
    credentials: {
      certificate: enrollment.certificate,
      privateKey: enrollment.key.toBytes(),
    },
    mspId: mspId,
    type: 'X.509',
  };
  await wallet.put(adminLabel, x509Identity);
  console.log(`→ Admin '${adminLabel}' enrollt und im Wallet gespeichert.`);
}

async function registerAndEnrollUser(wallet, caClient, mspId,
                                     userLabel, adminLabel, affiliation) {
  // 1) Wenn schon im Wallet, dann alles überspringen
  if (await wallet.get(userLabel)) {
    console.log(`→ User '${userLabel}' bereits im Wallet – überspringe Registration/Enroll.`);
    return;
  }

  // 2) Admin-Context erzeugen
  const adminIdentity = await wallet.get(adminLabel);
  if (!adminIdentity) {
    throw new Error(`Admin-Identität '${adminLabel}' nicht im Wallet gefunden.`);
  }
  const provider  = wallet.getProviderRegistry().getProvider(adminIdentity.type);
  const adminUser = await provider.getUserContext(adminIdentity, adminLabel);

  let enrollmentSecret;
  // 3) Registrierung versuchen
  try {
    enrollmentSecret = await caClient.register({
      affiliation: affiliation,
      enrollmentID: userLabel,
      role: 'client'
    }, adminUser);
    console.log(`→ User '${userLabel}' erfolgreich registriert.`);
  } catch (registerError) {
    const alreadyRegistered = registerError.errors &&
      registerError.errors.some(e => e.code === 74);
    if (alreadyRegistered) {
      console.warn(`→ '${userLabel}' ist bereits registriert. Es wird ein neuer Secret benötigt.`);
      console.warn(`  Bitte entferne die Identität beim CA-Server mit:`);
      console.warn(`    fabric-ca-client identity remove ${userLabel} \\`);
      console.warn(`      -u https://adminOrg4:adminpw@localhost:9054 \\`);
      console.warn(`      --tls.certfiles <Pfad-zur-tlsca.pem> --force`);
      throw new Error('Bitte entferne die bereits registrierte Identity beim CA-Server und starte das Skript erneut.');
    }
    throw registerError;
  }

  // 4) Enroll mit dem erhaltenen Secret
  const enrollment = await caClient.enroll({
    enrollmentID: userLabel,
    enrollmentSecret: enrollmentSecret
  });
  const x509Identity = {
    credentials: {
      certificate: enrollment.certificate,
      privateKey: enrollment.key.toBytes(),
    },
    mspId: mspId,
    type: 'X.509',
  };
  await wallet.put(userLabel, x509Identity);
  console.log(`→ User '${userLabel}' erfolgreich enrollt und im Wallet gespeichert.`);
}

// -----------------------------------------------------------------------------
main();
