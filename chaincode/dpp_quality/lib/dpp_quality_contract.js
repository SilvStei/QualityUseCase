'use strict';

//ctx.stub.putState(key, value)
//EPCIS events nochmal überprüfen und Quellen angeben
//Überprüfen Funktionen wie Dpp geholt wird

//Dieser Chaincode orientiert sich an der offiziellen Dokumentation (https://hyperledger-fabric.readthedocs.io/en/release-2.5/)
//und dem Github-Repo https://github.com/hyperledger/fabric-samples/tree/main

// benötigte Module importieren
const { Contract } = require('fabric-contract-api');
const { v4: uuidv4 } = require('uuid');


// zum Umwandeln von Json in JS-Objekt
function umwandelnJSON(str, errMsg) {
  if (str === undefined || str === null || str === '') return {};
  try {
    return JSON.parse(str);
  } catch (e) {
    throw new Error(`${errMsg}: ${e.message}`);
  }
}

//timezone setzen, hier fest gesetzt
function timezone() {return '+02:00';}

//Umwandeln einer Global Location Number in Serialized Global Location Number
const sgln = (gln) => (!gln ? '' : `urn:epc:id:sgln:${gln}.0.0`);

//Überprüfen ob GS1 Schlüssel den Standard erfüllt, vereinfachte Darstellung
function checkeGS1Standard(gs1) {
  if (typeof gs1 !== 'string' || gs1.trim() === '') {
    throw new Error(`Der GS1 Schlüssel ${gs1} ist leer`);
  }
  if (!gs1.startsWith('urn:epc:id:')) {
  }
}

//Auswahl der Core Business Vocabulary aus dem GS1 EPCIS (https://ref.gs1.org/standards/cbv/)
//Packen in Objekt zur späteren Nutzung
const CBV = {
  bizstep: {
    commissioning: 'urn:epcglobal:cbv:bizstep:commissioning',
    storing: 'urn:epcglobal:cbv:bizstep:storing',
    transforming: 'urn:epcglobal:cbv:bizstep:transforming',
    inspecting: 'urn:epcglobal:cbv:bizstep:inspecting',
    shipping: 'urn:epcglobal:cbv:bizstep:shipping',
    receiving: 'urn:epcglobal:cbv:bizstep:receiving',
  },
  disp: {
    active: 'urn:epcglobal:cbv:disp:active',
    inTransit: 'urn:epcglobal:cbv:disp:in_transit',
    nonConformant: 'urn:epcglobal:cbv:disp:non_conformant',
    nonConformantTransit: 'urn:epcglobal:cbv:disp:non_conformant_in_transit',
    conformant: 'urn:epcglobal:cbv:disp:conformant',
    conformantIssues: 'urn:epcglobal:cbv:disp:conformant_with_issues',
    inPossession: 'urn:epcglobal:cbv:disp:in_possession',
  },
};

//setzen von möglichen Status für DPP, unveränderbar damit nicht es nicht überschrieben wird
const STATUS = Object.freeze({
  entwurf: 'Entwurf',
  freigegeben: 'Freigegeben',
  freigegebenMitFehler: 'Freigegeben mit Fehler',
  gesperrt: 'Gesperrt',
  gesendetZu: 'Transport zu ',
  akzeptiertVon: 'Akzeptiert von ',
  deleted: 'Gelöscht bei der Transformation von ',
  erwartetPruefung: 'Wartet auf Prüfungen ',
});

const DPP_PREFIX = 'DPP-';

//Erstellen einer ID für die EPCIS Events
const evtId = (prefix) => `${prefix}-${Date.now()}-${uuidv4()}`;


//Klassen um bestimmte Elemente direkt beim Aufruf mit Daten zu füllen
class TestStandard {
  constructor({ name, istNumerisch, grenzeNiedrig, grenzeHoch, wertErwartet, einheit, benoetigt }) {
    Object.assign(this, { name, istNumerisch, grenzeNiedrig, grenzeHoch, wertErwartet, einheit, benoetigt });
  }
}
class TestErgebnisse {
  constructor(init) { Object.assign(this, init); }
}
class TransportLog {
  constructor(init) { Object.assign(this, init); }
}
class EPCISEvent {
  constructor(init) { Object.assign(this, init); }
}
class DPP {
  constructor(init) { Object.assign(this, init); }
}


//Status des DPP festlegen wenn nicht durch andere Funktion gerade gesteuert
function evalStatus(dpp) {
  if (dpp.status === STATUS.gesperrt || dpp.status.startsWith(STATUS.deleted)) return;
  if (dpp.status.startsWith(STATUS.gesendetZu) || dpp.status.startsWith(STATUS.akzeptiertVon)) return;

  let hatFehler = false;
  let istNichtGeblockt = false;

  for (const te of dpp.qualitaet) {
    if (te.bewertung === 'FEHLGESCHLAGEN') { hatFehler = true; break; }
    if (te.bewertung === 'INFO_KEIN_STANDARD') istNichtGeblockt = true;
  }
  for (const log of dpp.verankerteTransportLogs) {
    if (log.alarmZusammenfassung === 'JA') istNichtGeblockt = true;
  }

//Dpp sperren wenn Fehler auftritt
  if (hatFehler) {
    dpp.status = STATUS.gesperrt; return;
  }
  if (dpp.offenePflichtpruefungen.length === 0) {
    dpp.status = istNichtGeblockt ? STATUS.freigegebenMitFehler : STATUS.freigegeben;
  } else {
    dpp.status = STATUS.erwartetPruefung + '(' + dpp.offenePflichtpruefungen.length + ' offen)';
  }
}

//Funktionen der Hyperledger Fabric Contract Klasse erben um Funktionalität mit Blockchain zu ermöglichen
//dieser spezifischer Vertrag soll übergeben werden

//Die Prorgrammierung der Klasse orientiert sich an https://hyperledger-fabric.readthedocs.io/en/release-2.2/developapps/smartcontract.html
class DPPqualitaetContract extends Contract {
  constructor() {
	//Elternklasse aufrufen und Vetragsnamen übergeben
    super('org.example.dppqualitaet');
  }


//Identität holen
  async mspidHolen(ctx) {
    const msp = ctx.clientIdentity.getMSPID();
    if (!msp) throw new Error('Ermitteln der MSPID nicht möglich');
    return msp;
  }

// überprüfen ob Daten im Dpp existieren
//Orientiert sich an https://github.com/hyperledger/fabric-samples/blob/main/asset-transfer-basic/chaincode-javascript/lib/assetTransfer.js
  async existenzPruefen(ctx, dppID) {
    const data = await ctx.stub.getState(DPP_PREFIX + dppID);
    if (data && data.length > 0) {
	return true;
	} else {
	return false;
	}
  }


//Daten des DPP auf den Ledger schreiben
//(https://github.com/hyperledger/fabric-samples/blob/main/asset-transfer-basic/chaincode-javascript/lib/assetTransfer.js)
  async datenSchreiben(ctx, dpp) {
    await ctx.stub.putState(DPP_PREFIX + dpp.dppID, Buffer.from(JSON.stringify(dpp)));
  }


//Ledger initialisieren
//https://github.com/hyperledger/fabric-samples/blob/main/asset-transfer-basic/chaincode-javascript/lib/assetTransfer.js
  async InitLedger() {
    return { success: 'Ledger ist initialisiert' };
  }


//Erstellen eines DPP, mit Daten füttern und schreiben auf der Blockchain
//Orientiert sich an https://github.com/hyperledger/fabric-samples/blob/main/asset-transfer-basic/chaincode-javascript/lib/assetTransfer.js
  async ErstellenDPP(ctx, dppID, gs1ID, produktTypID, herstellerGLN, charge, herstellDatum, specsJSON) {
    if (await this.existenzPruefen(ctx, dppID)) throw new Error(`Der DPP ${dppID} existiert bereits`);
    checkeGS1Standard(gs1ID);


//JSON nutzbar machen
    let spezifikationenArray = umwandelnJSON(specsJSON, 'Fehlerhafte Spezifikationen');
	if (!spezifikationenArray) {
	spezifikationenArray = [];
	}
	const specs = spezifikationenArray.map( (s) => {
	return new TestStandard(s);
	});
	
//Liste mit Namen der Pflichtprüfungen erstellen
    const nurBenoetigteTests = specs.filter( (s) => {
	return s.benoetigt === true;
	});
	const offeneChecks = nurBenoetigteTests.map( (s) => {
	return s.name;
	});

    const owner = await this.mspidHolen(ctx);
    const now = new Date();


//Commissioning Event basierend auf (https://www.gs1.org/docs/epc/EPCIS_Guideline.pdf)
    const commissioningEvt = new EPCISEvent({
      eventId: evtId('evt-create'),
      eventType: 'ObjectEvent',
      eventTime: now.toISOString(),
      eventTimeZoneOffset: timezone(),
      bizStep: CBV.bizstep.commissioning,
      action: 'ADD',
      epcList: [gs1ID],
      disposition: CBV.disp.active,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(herstellerGLN),
      bizLocation: sgln(herstellerGLN),
      extensions: {},
    });

    const dpp = new DPP({
      dppID,
      gs1ID,
      produktTypID,
      herstellerGLN,
      charge,
      herstellDatum,
      besitzerOrganisation: owner,
      status: STATUS.entwurf,
      spezifikationen: specs,
      offenePflichtpruefungen: offeneChecks,
      qualitaet: [],
      verankerteTransportLogs: [],
      vorproduktDppIDs: [],
      epcisEvents: [commissioningEvt],
    });

    evalStatus(dpp);
    await this.datenSchreiben(ctx, dpp);
    return dpp;
  }


//Qualitätstests durchführen, Ergebnisse zum Dpp hinzufügen
//Transaktionen orientieren sich an https://github.com/hyperledger/fabric-samples/tree/main/asset-transfer-basic/chaincode-java
  async AufzeichnenTestergebnisse(ctx, dppID, testErgebnisJSON, pruefungsortGln) {
    const dppRohdaten = await ctx.stub.getState(DPP_PREFIX + dppID);
	if (!dppRohdaten || dppRohdaten.length === 0) {
	throw new Error(`DPP ${dppID} nicht gefunden`);
	}
    const dpp = JSON.parse(dppRohdaten.toString());

    if (dpp.status === 'Gesperrt') {
        throw new Error(`${dppID} ist gesperrt - keine neuen Tests möglich`);
    }

    const TestErgebnisseDaten = umwandelnJSON(testErgebnisJSON, 'testErgebnisJSON ungültig');
    const te = new TestErgebnisse(TestErgebnisseDaten);
    te.zeitstempel = te.zeitstempel || new Date().toISOString();
    te.durchfuehrendeOrganisation = te.durchfuehrendeOrganisation || await this.mspidHolen(ctx);

// evt mit find schreiben?
//
    let gefundenerStandard = undefined;
	for (const s of dpp.spezifikationen) {
	if (s.name === te.pruefungsName) {
		gefundenerStandard = s;
		break;
		}
	}
	const std = gefundenerStandard;
	
//schauen ob Bewertung schon final ist
    const clientBewertung = ['BESTANDEN', 'FEHLGESCHLAGEN'].includes(te.bewertung);


//falls keine Bewertung soll diese durch Vergleich mit Vergleich gegen Grenzwerten im Dpp erstellt werden
    if (!clientBewertung) {
      te.kommentarBewertung = '';
	  
	  //schauen ob Grenzwerte vorliegen und bewerten
      if (!std) {
        te.bewertung = 'INFO_KEIN_STANDARD';
        te.kommentarBewertung = `Es gibt keinen Standard für den Test '${te.pruefungsName}'`;
		
		//numerische Tests
      } else if (std.istNumerisch) {
        const val = parseFloat(te.messwert);
        if (Number.isNaN(val)) {
          te.bewertung = 'FEHLGESCHLAGEN';
          te.kommentarBewertung = `Ergebnis '${te.messwert}' ist nicht numerisch.`;
		  
        } else if (val < std.grenzeNiedrig || val > std.grenzeHoch) {
          te.bewertung = 'FEHLGESCHLAGEN';
          te.kommentarBewertung = `Wert ${val.toFixed(4)} liegt außerhalb Toleranz [${std.grenzeNiedrig}, ${std.grenzeHoch}] ${std.einheit}`;
		  
        } else {
          te.bewertung = 'BESTANDEN';
        }
		
		//nichtnumerische Tests
      } else {
        if ((te.messwert || '').toLowerCase() === (std.wertErwartet || '').toLowerCase()) {
          te.bewertung = 'BESTANDEN';
        } else {
          te.bewertung = 'FEHLGESCHLAGEN';
          te.kommentarBewertung = `Erwartet wird '${std.wertErwartet}' aber '${te.messwert}' erhalten`;
        }
      }
    }
	
//testergebnis an Qualitätseinträge im Dpp anhängen
    dpp.qualitaet.push(te);


//EPCIS Event (basierend auf https://ref.gs1.org/docs/epcis/examples/)
    const qcEvent = new EPCISEvent({
      eventId: evtId(`evt-qc-${(te.pruefungsName || 'unknown').replace(/\s|\//g, '_')}`),
      eventType: 'ObjectEvent',
      eventTime: te.zeitstempel,
      eventTimeZoneOffset: timezone(),
      bizStep: CBV.bizstep.inspecting,
      action: 'OBSERVE',
      epcList: [dpp.gs1ID],
      disposition: te.bewertung === 'BESTANDEN'
        ? CBV.disp.conformant
        : ['FEHLGESCHLAGEN', 'INFO_KEIN_STANDARD'].includes(te.bewertung)
          ? CBV.disp.nonConformant
          : CBV.disp.active,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(pruefungsortGln),
      bizLocation: sgln(pruefungsortGln),
      extensions: { aufgezeichneteTestdaten: te },
    });
	
	//an EPCIS events des DPP anhängen
    dpp.epcisEvents.push(qcEvent);


	// Tests von Liste abhaken wenn bestanden
	if (std && std.benoetigt && te.bewertung === 'BESTANDEN') {
	  const erledigterTestName = te.pruefungsName;
	  const neueListeOffenerPruefungen = [];
	  for (const alterTestName of dpp.offenePflichtpruefungen) {
		if (alterTestName !== erledigterTestName) {
		  neueListeOffenerPruefungen.push(alterTestName);
		}
	  }
	  dpp.offenePflichtpruefungen = neueListeOffenerPruefungen;
	}


//Status des Dpp evaluieren um evt zu sperren und Status des Dpp anzupassen
    evalStatus(dpp);


	//Event setzen falls fehlgeschlagener Test, Informationen zum Test mitgeben
    if (te.bewertung === 'FEHLGESCHLAGEN') {
      ctx.stub.setEvent('qualityalarm', Buffer.from(JSON.stringify({
        dppID,
        gs1ID: dpp.gs1ID,
        pruefungsName: te.pruefungsName,
        messwert: te.messwert,
        bewertung: te.bewertung,
        kommentarBewertung: te.kommentarBewertung,
        zeitstempel: te.zeitstempel,
      })));
    }

//alle Infos des Dpp auf Blockchain schreiben
    await this.datenSchreiben(ctx, dpp);
    return { success: `Ergebnisse der Tests für ${dppID} gespeichert` };
  }


//Transport Sensordaten auf Blockchain schreiben
//Orientieren an https://github.com/hyperledger/fabric-samples/tree/main/asset-transfer-basic/chaincode-java
  async TransportLogDateiVerankern(ctx, dppID, logJSON, standortGLN) {
    const dppRohdaten = await ctx.stub.getState(DPP_PREFIX + dppID);
    if (!dppRohdaten.length) throw new Error(`DPP ${dppID} nicht gefunden`);
    const dpp = JSON.parse(dppRohdaten.toString());

	//Transportinformationen zum Dpp hinzufügen
    const logRef = new TransportLog(umwandelnJSON(logJSON, 'JSON des TransportLog ungültig'));
    logRef.zeitpunktVerankerung = new Date().toISOString();
    logRef.durchfuehrendeOrgGLN = standortGLN;
    logRef.durchfuehrendeOrgMSPID = await this.mspidHolen(ctx);
    dpp.verankerteTransportLogs.push(logRef);


	//EPCIS Event (https://www.gs1nz.org/assets/Resources/Case-Studies/Supply-chain-traceability-Halal-meat-products.pdf)
	//https://www.gs1.org/docs/epc/EPCIS_Guideline.pdf
    const logEvt = new EPCISEvent({
      eventId: evtId(`evt-log-${dpp.gs1ID.replace(/:/g, '_')}`),
      eventType: 'ObjectEvent',
      eventTime: logRef.zeitpunktVerankerung,
      eventTimeZoneOffset: timezone(),
      bizStep: CBV.bizstep.storing,
      action: 'ADD',
      epcList: [dpp.gs1ID],
      disposition: logRef.alarmZusammenfassung === 'JA' ? CBV.disp.nonConformantTransit : CBV.disp.inTransit,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(standortGLN),
      bizLocation: sgln(standortGLN),
      extensions: { verankerteTransportLogDatei: logRef },
    });
	
	//Event auch zum Dpp bzw. epcisEvents hinzufügen
    dpp.epcisEvents.push(logEvt);

	//Status evaluieren falls geändert werden soll, dann schreiben
    evalStatus(dpp);
    await this.datenSchreiben(ctx, dpp);
    return { success: ` Der Log des Transports für ${dppID} wurde verankert` };
  }


//transformieren der Dpp um Compundierer abzubilden
  async dppTransformieren(ctx, outputId, outputGs1, outputTypId, aktuelleGln, charge, herstellDatum, inputIdsJSON, outSpecsJSON, initialTestJSON) {
    if (await this.existenzPruefen(ctx, outputId)) throw new Error(`Output DPP ${outputId} existiert bereits`);
    checkeGS1Standard(outputGs1);
    const msp = await this.mspidHolen(ctx);

	//Json in Array umwandeln
  const inputIds = umwandelnJSON(inputIdsJSON, 'vorproduktDppIDs JSON ungültig');
  const inputgs1IDs = [];

  for (const id of inputIds) {
    const buf = await ctx.stub.getState(DPP_PREFIX + id);
    if (!buf.length) throw new Error(`InputDPP ${id} nicht gefunden`);
  //buf für weitere Verwendung nutzbar machen
  const inp = JSON.parse(buf.toString());


	 //nur inputDpps verwenden die für Transformation geeignet sind, also die von der aktuellen Org akzeptiert wurden
      const akzeptiert = inp.status === `${STATUS.akzeptiertVon}${msp}`;
		const istFreigegeben = (inp.status === STATUS.freigegeben) || (inp.status === STATUS.freigegebenMitFehler);
		if (istFreigegeben === false && akzeptiert === false) {
			throw new Error(`Input DPP ${id} ist nicht freigegeben oder ist nicht akzeptiert worden (Status ${inp.status})`);
		}
	  
	  //GS1-Id in liste packen
      inputgs1IDs.push(inp.gs1ID);
	  
	  //inputDpp löschen da transformiert
      inp.status = `${STATUS.deleted}${outputId}`;
      await this.datenSchreiben(ctx, inp);
    }

	//Umwandeln der outSpecs in nutzbare Form
    const outSpecs = umwandelnJSON(outSpecsJSON, 'Spezifikationen des Outputs ungültig');
	//neuen Dpp erstellen
    const outDpp = await this.ErstellenDPP(ctx, outputId, outputGs1, outputTypId, aktuelleGln, charge, herstellDatum, JSON.stringify(outSpecs));

	//outputDpp die inputDpps hinzufügen
    outDpp.vorproduktDppIDs = inputIds;


	//Tranformationsevent (basierend auf https://ref.gs1.org/docs/epcis/examples/transformation_event_all_possible_fields.jsonld)
	//bizStep commissioning?
  const tfEvt = new EPCISEvent({
    eventId: evtId('evt-tf'),
    eventType: 'TransformationEvent',
    eventTime: new Date().toISOString(),
    eventTimeZoneOffset: timezone(),
    bizStep: CBV.bizstep.transforming,
    action: 'OBSERVE',
    epcList: [],
    disposition: '',
    inputEPCList: inputgs1IDs,
    outputEPCList: [outputGs1],
    readPoint: sgln(aktuelleGln),
    bizLocation: sgln(aktuelleGln),
    extensions: {},
  });

//Initiales Testergbnis schreiben
    if (initialTestJSON && initialTestJSON !== '{}') {
	  //umwandeln in 
      const initTE = new TestErgebnisse(umwandelnJSON(initialTestJSON, 'InitialTest JSON ungültig'));
      initTE.zeitstempel = initTE.zeitstempel || new Date().toISOString();
      initTE.durchfuehrendeOrganisation = initTE.durchfuehrendeOrganisation || msp;
	  
	  //Testergbnis zu den Extensions hinzufügen
      tfEvt.extensions.transformationsTest = initTE;
	  //Testergbnis zu den Qualitätsdaten hinzufügen um schnellen Überblick über Historie zu bekommen
      outDpp.qualitaet.push(initTE);

//Regeln aus Spezifikationen holen um Tests bewerten zu können      
const std = outDpp.spezifikationen.find(s => s.name === initTE.pruefungsName);

        //schauen ob Testergebnis keine Bewertung hat
        if (!initTE.bewertung) {
          //gibt es Standard für Bewertung
            if (std && std.istNumerisch) {
              //zum Nutzen umwandeln in Zahl
                const val = parseFloat(initTE.messwert);
                if (!Number.isNaN(val) && val >= std.grenzeNiedrig && val <= std.grenzeHoch) {
                    initTE.bewertung = 'BESTANDEN';
                } else {
                    initTE.bewertung = 'FEHLGESCHLAGEN';
                    initTE.kommentarBewertung = `Wert ${val} außerhalb Toleranz [${std.grenzeNiedrig}, ${std.grenzeHoch}]`;
                }
            } else if (std) { 
                if ((initTE.messwert || '').toLowerCase() === (std.wertErwartet || '').toLowerCase()) {
                    initTE.bewertung = 'BESTANDEN';
                } else {
                    initTE.bewertung = 'FEHLGESCHLAGEN';
                }
            } else {
                initTE.bewertung = 'INFO_KEIN_STANDARD';
             }
        }
        
        //Falls Test bestanden aus offener Liste streichen
        if (std && std.benoetigt && initTE.bewertung === 'BESTANDEN') {
            const erledigterTestName = initTE.pruefungsName;
            //Bestandenen Test aus Liste mit offnen Prüfungen filtern
            outDpp.offenePflichtpruefungen = outDpp.offenePflichtpruefungen.filter(name => name !== erledigterTestName);
        }


    }
	
	//Transformation zur EPCIS Liste hinzufügen
    outDpp.epcisEvents.push(tfEvt);
	//überprüfen ob Status okay ist
    evalStatus(outDpp);
	//OutputDpp auf Blockchain speichern
    await this.datenSchreiben(ctx, outDpp);
    return { success: `Transformation zu ${outputId} abgeschlossen`};
  }



// senden eines Dpp an neues Unternehmen/Eigentümer
  async DPPUebertragen(ctx, dppID, neuerOwnerMsp, senderGln) {
	  
	  //Dpp holen und nutzbar machen
    const buf = await ctx.stub.getState(DPP_PREFIX + dppID);
    if (!buf.length) throw new Error(`DPP ${dppID} nicht gefunden`);
    const dpp = JSON.parse(buf.toString());
	
	//Id des Senders holen
    const absender = await this.mspidHolen(ctx);

    if (dpp.besitzerOrganisation !== absender) throw new Error(`Sender ist nicht Eigentümer des DPP (Owner ${dpp.besitzerOrganisation})`);
    if (absender === neuerOwnerMsp) throw new Error('Absender und Empfänger sind gleich');
	
	//Schauen ob Dpp überhaupt transferierbar ist
    const istGesperrt = (dpp.status === STATUS.gesperrt);
	const istFreigegeben = (dpp.status === STATUS.freigegeben) || (dpp.status === STATUS.freigegebenMitFehler);
	if (istGesperrt || !istFreigegeben) {
	  throw new Error(`DPP ${dppID} (Status ist ${dpp.status}); DPP ist nicht transferierbar`);
	}


	//EPCIS Shipping Event festlegen (basierend auf https://www.gs1.org/docs/epc/EPCIS_Guideline.pdf)
    const shipEvt = new EPCISEvent({
      eventId: evtId('evt-ship'),
      eventType: 'ObjectEvent',
      eventTime: new Date().toISOString(),
      eventTimeZoneOffset: timezone(),
      bizStep: CBV.bizstep.shipping,
      action: 'OBSERVE',
      epcList: [dpp.gs1ID],
      disposition: CBV.disp.inTransit,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(senderGln),
      bizLocation: sgln(senderGln),
      extensions: {intendedRecipientMSP: neuerOwnerMsp, originalStatus: dpp.status},
    });
	
	//Shipping Event an Dpp hängen
    dpp.epcisEvents.push(shipEvt);

	//Neuen Besitzer auf Dpp setzen
    dpp.besitzerOrganisation = neuerOwnerMsp;
    dpp.status = `${STATUS.gesendetZu}${neuerOwnerMsp}`;
    await this.datenSchreiben(ctx, dpp);
    return { success: `DPP ${dppID} an ${neuerOwnerMsp} übertragen` };
  }


//Empfangen und Fehler/Qualität überprüfen
  async empfangBestaetigen(ctx, dppID, empfaengerGln, prueferErgebnis) {
    const buf = await ctx.stub.getState(DPP_PREFIX + dppID);
    if (!buf.length) throw new Error(`DPP ${dppID} nicht gefunden`);
    const dpp = JSON.parse(buf.toString());


	//schauen ob Empfänger passt
    const empfaengerMsp = await this.mspidHolen(ctx);
    const erwarteterStatus = `${STATUS.gesendetZu}${empfaengerMsp}`;
    if (dpp.besitzerOrganisation !== empfaengerMsp || !dpp.status.startsWith(erwarteterStatus)) {
      throw new Error(`Empfang nicht erlaubt (Owner ${dpp.besitzerOrganisation} - Status ${dpp.status}) liegt vor`);
    }

    dpp.status = `${STATUS.akzeptiertVon}${empfaengerMsp}`;
	
	//Eingangsprüfung
    let inspektionErgebnis;

	//schauen ob Ergbnis vorliegt
    if (['NICHT_OKAY', 'OK'].includes(prueferErgebnis)) {
		
		//neues Objekt für Eingangsprüfung
      inspektionErgebnis = new TestErgebnisse({
        pruefungsName: 'Eingangspruefung',
        messwert: prueferErgebnis,
        zeitstempel: new Date().toISOString(),
        durchfuehrendeOrganisation: empfaengerMsp,
        systemId: 'ManuellePruefungEmpfaenger',
        bewertung: prueferErgebnis === 'OK' ? 'BESTANDEN' : 'FEHLGESCHLAGEN',
        kommentarBewertung: prueferErgebnis === 'OK' ? '' : 'NICHT_OKAY bei Eingangsprüfung.',
      });
	  
	  //Prüfung an Qualitätshistorie anhängen
      dpp.qualitaet.push(inspektionErgebnis);
      if (prueferErgebnis === 'NICHT_OKAY') dpp.status = STATUS.gesperrt;
    }

	let dispositionWert;
	
	//Dpp gesperrt
	if (dpp.status === STATUS.gesperrt) {
	  dispositionWert = CBV.disp.nonConformant;
	  
	  //Eingangsprüfung war okay
	} else if (prueferErgebnis === 'OK') {
	  const statusHatFehler = dpp.status.includes('Fehler');
	let hatNichtBestandenenTest = false; 
	for (const q of dpp.qualitaet) {
	  if (q.bewertung !== 'BESTANDEN') {
		hatNichtBestandenenTest = true;
		break; 
		}
	}
	
	//Beide Prüfungen
	const hatProbleme = statusHatFehler || hatNichtBestandenenTest;
		  if (hatProbleme) {
			dispositionWert = CBV.disp.conformantIssues; 
		  } else {
			dispositionWert = CBV.disp.conformant;
		  }
		  
	//andere Fälle
	} else {
	  dispositionWert = CBV.disp.inPossession;
	}
	
	
	let extensionsWert = {}; 
	if (prueferErgebnis) { 
	  extensionsWert = { eingangspruefungErgebnis: prueferErgebnis };
	}


//Event zum Empfang, (basierend auf https://www.gs1.org/docs/epc/EPCIS_Guideline.pdf) 
// https://ref.gs1.org/cbv/BizStep-receiving
    const now = new Date();
    const ackEvt = new EPCISEvent({
      eventId: evtId('evt-recv'),
      eventType: 'ObjectEvent',
      eventTime: now.toISOString(),
      eventTimeZoneOffset: timezone(),
      bizStep: CBV.bizstep.receiving,
      action: 'ADD',
      epcList: [dpp.gs1ID],
      disposition: dispositionWert,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(empfaengerGln),
      bizLocation: sgln(empfaengerGln),
      extensions: extensionsWert,
    });
	
	//Event zum Dpp adden
    dpp.epcisEvents.push(ackEvt);

    if (inspektionErgebnis) {
		
		//EPCIS Event basierend auf (https://ref.gs1.org/cbv/BizStep-inspecting)
		//(https://www.gs1.org/docs/epc/EPCIS_Guideline.pdf)
      const inspEvt = new EPCISEvent({
        eventId: evtId('evt-insp'),
        eventType: 'ObjectEvent',
        eventTime: inspektionErgebnis.zeitstempel,
        eventTimeZoneOffset: timezone(),
        bizStep: CBV.bizstep.inspecting,
        action: 'OBSERVE',
        epcList: [dpp.gs1ID],
        disposition: inspektionErgebnis.bewertung === 'BESTANDEN' ? CBV.disp.conformant : CBV.disp.nonConformant,
        inputEPCList: [],
        outputEPCList: [],
        readPoint: sgln(empfaengerGln),
        bizLocation: sgln(empfaengerGln),
        extensions: { eingangspruefungsdatenDurchEmpfaenger: inspektionErgebnis },
      });
	  
	  //Hinzufügen zu Dpp
      dpp.epcisEvents.push(inspEvt);
    }


	//Schreiben wenn nicht gesperrt
    if (dpp.status !== STATUS.gesperrt) evalStatus(dpp);
    await this.datenSchreiben(ctx, dpp);
    return { success: `Empfang für ${dppID} bestätigt` };
  }


	//Dpp abfragen und zurückgeben
  async DPPAbfragen(ctx, dppID) {
    const buf = await ctx.stub.getState(DPP_PREFIX + dppID);
    if (!buf.length) throw new Error(`DPP ${dppID} nicht gefunden`);
    return JSON.parse(buf.toString());
  }
}

module.exports = DPPqualitaetContract;
module.exports.contracts = [DPPqualitaetContract];
