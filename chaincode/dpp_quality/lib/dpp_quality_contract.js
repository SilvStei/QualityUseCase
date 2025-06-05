'use strict';

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

//Zeitzone setzen, hier fest gesetzt
function zeitzone() {return '+02:00';}

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
class TestErgebnis {
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

  for (const te of dpp.quality) {
    if (te.bewertungsergebnis === 'FEHLGESCHLAGEN') { hatFehler = true; break; }
    if (te.bewertungsergebnis === 'INFO_KEIN_STANDARD') istNichtGeblockt = true;
  }
  for (const log of dpp.verankerteTransportLogs) {
    if (log.alarmZusammenfassung === 'JA') istNichtGeblockt = true;
  }

  if (hatFehler) {
    dpp.status = STATUS.gesperrt; return;
  }
  if (dpp.offenePflichtpruefungen.length === 0) {
    dpp.status = istNichtGeblockt ? STATUS.freigegebenMitFehler : STATUS.freigegeben;
  } else {
    dpp.status = `${STATUS.erwartetPruefung} (${dpp.offenePflichtpruefungen.length} offen)`;
  }
}

class DPPQualityContract extends Contract {
  constructor() {
    super('org.example.dppquality');
  }

  async _getMSPID(ctx) {
    const msp = ctx.clientIdentity.getMSPID();
    if (!msp) throw new Error('MSPID konnte nicht ermittelt werden');
    return msp;
  }

  async _exists(ctx, dppId) {
    const data = await ctx.stub.getState(DPP_PREFIX + dppId);
    return !!(data && data.length);
  }

  async _write(ctx, dpp) {
    await ctx.stub.putState(DPP_PREFIX + dpp.dppId, Buffer.from(JSON.stringify(dpp)));
  }

  async InitLedger() {
    return { success: 'Ledger initialisiert.' };
  }

  async ErstellenDPP(ctx, dppId, gs1Key, productTypeId, manufacturerGln, batch, productionDate, specsJSON) {
    if (await this._exists(ctx, dppId)) throw new Error(`DPP ${dppId} existiert bereits`);
    checkeGS1Standard(gs1Key);

    const specs = (umwandelnJSON(specsJSON, 'Spezifikationen fehlerhaft') || []).map((s) => new TestStandard(s));
    const offeneChecks = specs.filter((s) => s.benoetigt).map((s) => s.name);

    const owner = await this._getMSPID(ctx);
    const now = new Date();

    const commissioningEvt = new EPCISEvent({
      eventId: evtId('evt-create'),
      eventType: 'ObjectEvent',
      eventTime: now.toISOString(),
      eventTimeZoneOffset: zeitzone(),
      bizStep: CBV.bizstep.commissioning,
      action: 'ADD',
      epcList: [gs1Key],
      disposition: CBV.disp.active,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(manufacturerGln),
      bizLocation: sgln(manufacturerGln),
      extensions: {},
    });

    const dpp = new DPP({
      dppId,
      gs1Key,
      productTypeId,
      manufacturerGln,
      batch,
      productionDate,
      ownerOrg: owner,
      status: STATUS.entwurf,
      specifications: specs,
      offenePflichtpruefungen: offeneChecks,
      quality: [],
      verankerteTransportLogs: [],
      inputDppIds: [],
      epcisEvents: [commissioningEvt],
    });

    evalStatus(dpp);
    await this._write(ctx, dpp);
    return dpp;
  }

  async AufzeichnenTestergebnisse(ctx, dppId, testErgebnisJSON, recordingSiteGln) {
    const dppBuf = await ctx.stub.getState(DPP_PREFIX + dppId);
    if (!dppBuf.length) throw new Error(`DPP ${dppId} nicht gefunden`);
    const dpp = JSON.parse(dppBuf.toString());

    const te = new TestErgebnis(umwandelnJSON(testErgebnisJSON, 'TestErgebnis JSON ungültig'));
    te.zeit = te.zeit || new Date().toISOString();
    te.durchfuehrendeOrg = te.durchfuehrendeOrg || await this._getMSPID(ctx);

    const std = dpp.specifications.find((s) => s.name === te.standardName);
    const clientSetBewertung = ['BESTANDEN', 'FEHLGESCHLAGEN'].includes(te.bewertungsergebnis);

    if (!clientSetBewertung) {
      te.kommentarBewertung = '';
      if (!std) {
        te.bewertungsergebnis = 'INFO_KEIN_STANDARD';
        te.kommentarBewertung = `Kein Standard für Test '${te.standardName}' hinterlegt.`;
      } else if (std.istNumerisch) {
        const val = parseFloat(te.ergebnis);
        if (Number.isNaN(val)) {
          te.bewertungsergebnis = 'FEHLGESCHLAGEN';
          te.kommentarBewertung = `Ergebnis '${te.ergebnis}' nicht numerisch.`;
        } else if (val < std.grenzeNiedrig || val > std.grenzeHoch) {
          te.bewertungsergebnis = 'FEHLGESCHLAGEN';
          te.kommentarBewertung = `Wert ${val.toFixed(4)} außerhalb Toleranz [${std.grenzeNiedrig}, ${std.grenzeHoch}] ${std.einheit}.`;
        } else {
          te.bewertungsergebnis = 'BESTANDEN';
        }
      } else {
        if ((te.ergebnis || '').toLowerCase() === (std.wertErwartet || '').toLowerCase()) {
          te.bewertungsergebnis = 'BESTANDEN';
        } else {
          te.bewertungsergebnis = 'FEHLGESCHLAGEN';
          te.kommentarBewertung = `Erwartet '${std.wertErwartet}', erhalten '${te.ergebnis}'.`;
        }
      }
    }

    dpp.quality.push(te);

    const qcEvt = new EPCISEvent({
      eventId: evtId(`evt-qc-${(te.standardName || 'unknown').replace(/\s|\//g, '_')}`),
      eventType: 'ObjectEvent',
      eventTime: te.zeit,
      eventTimeZoneOffset: zeitzone(),
      bizStep: CBV.bizstep.inspecting,
      action: 'OBSERVE',
      epcList: [dpp.gs1Key],
      disposition: te.bewertungsergebnis === 'BESTANDEN'
        ? CBV.disp.conformant
        : ['FEHLGESCHLAGEN', 'INFO_KEIN_STANDARD'].includes(te.bewertungsergebnis)
          ? CBV.disp.nonConformant
          : CBV.disp.active,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(recordingSiteGln),
      bizLocation: sgln(recordingSiteGln),
      extensions: { aufgezeichneteTestdaten: te },
    });
    dpp.epcisEvents.push(qcEvt);

    if (std && std.benoetigt && te.bewertungsergebnis === 'BESTANDEN') {
      dpp.offenePflichtpruefungen = dpp.offenePflichtpruefungen.filter((n) => n !== te.standardName);
    }

    evalStatus(dpp);

    if (te.bewertungsergebnis === 'FEHLGESCHLAGEN') {
      ctx.stub.setEvent('QualityAlert', Buffer.from(JSON.stringify({
        dppId,
        gs1Key: dpp.gs1Key,
        standardName: te.standardName,
        ergebnis: te.ergebnis,
        bewertungsergebnis: te.bewertungsergebnis,
        kommentarBewertung: te.kommentarBewertung,
        zeit: te.zeit,
      })));
    }

    await this._write(ctx, dpp);
    return { success: `Testergebnisse für ${dppId} gespeichert.` };
  }

  async TransportLogDateiVerankern(ctx, dppId, logJSON, siteGln) {
    const dppBuf = await ctx.stub.getState(DPP_PREFIX + dppId);
    if (!dppBuf.length) throw new Error(`DPP ${dppId} nicht gefunden`);
    const dpp = JSON.parse(dppBuf.toString());

    const logRef = new TransportLog(umwandelnJSON(logJSON, 'TransportLog JSON ungültig'));
    logRef.zeitpunktVerankerung = new Date().toISOString();
    logRef.durchfuehrendeOrgGLN = siteGln;
    logRef.durchfuehrendeOrgMSPID = await this._getMSPID(ctx);
    dpp.verankerteTransportLogs.push(logRef);

    const logEvt = new EPCISEvent({
      eventId: evtId(`evt-log-${dpp.gs1Key.replace(/:/g, '_')}`),
      eventType: 'ObjectEvent',
      eventTime: logRef.zeitpunktVerankerung,
      eventTimeZoneOffset: zeitzone(),
      bizStep: CBV.bizstep.storing,
      action: 'ADD',
      epcList: [dpp.gs1Key],
      disposition: logRef.alarmZusammenfassung === 'JA' ? CBV.disp.nonConformantTransit : CBV.disp.inTransit,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(siteGln),
      bizLocation: sgln(siteGln),
      extensions: { verankerteTransportLogDatei: logRef },
    });
    dpp.epcisEvents.push(logEvt);

    evalStatus(dpp);
    await this._write(ctx, dpp);
    return { success: `Transport‑Log verankert für ${dppId}.` };
  }

  async TransformationAufzeichnen(ctx, outputId, outputGs1, outputTypeId, currentGln, batch, prodDate, inputIdsJSON, outSpecsJSON, initialTestJSON) {
    if (await this._exists(ctx, outputId)) throw new Error(`Output DPP ${outputId} existiert bereits`);
    checkeGS1Standard(outputGs1);
    const msp = await this._getMSPID(ctx);

    const inputIds = umwandelnJSON(inputIdsJSON, 'InputDPPIDs JSON ungültig');
    const inputGs1Keys = [];

    for (const id of inputIds) {
      const buf = await ctx.stub.getState(DPP_PREFIX + id);
      if (!buf.length) throw new Error(`InputDPP ${id} nicht gefunden`);
      const inp = JSON.parse(buf.toString());

      const accepted = inp.status === `${STATUS.akzeptiertVon}${msp}`;
      if (![STATUS.freigegeben, STATUS.freigegebenMitFehler].includes(inp.status) && !accepted) {
        throw new Error(`Input DPP ${id} ist nicht freigegeben / akzeptiert (Status ${inp.status})`);
      }
      inputGs1Keys.push(inp.gs1Key);
      inp.status = `${STATUS.deleted}${outputId}`;
      await this._write(ctx, inp);
    }

    const outSpecs = umwandelnJSON(outSpecsJSON, 'Output‑Spezifikationen ungültig');
    const outDpp = await this.ErstellenDPP(ctx, outputId, outputGs1, outputTypeId, currentGln, batch, prodDate, JSON.stringify(outSpecs));

    outDpp.inputDppIds = inputIds;

    const tfEvt = new EPCISEvent({
      eventId: evtId('evt-tf'),
      eventType: 'TransformationEvent',
      eventTime: new Date().toISOString(),
      eventTimeZoneOffset: zeitzone(),
      bizStep: CBV.bizstep.transforming,
      action: 'OBSERVE',
      epcList: [],
      disposition: '',
      inputEPCList: inputGs1Keys,
      outputEPCList: [outputGs1],
      readPoint: sgln(currentGln),
      bizLocation: sgln(currentGln),
      extensions: {},
    });

    if (initialTestJSON && initialTestJSON !== '{}') {
      const initTE = new TestErgebnis(umwandelnJSON(initialTestJSON, 'InitialTest JSON ungültig'));
      initTE.zeit = initTE.zeit || new Date().toISOString();
      initTE.durchfuehrendeOrg = initTE.durchfuehrendeOrg || msp;
      tfEvt.extensions.initialesKombinationsTestergebnis = initTE;
      outDpp.quality.push(initTE);
    }

    outDpp.epcisEvents.push(tfEvt);
    evalStatus(outDpp);
    await this._write(ctx, outDpp);
    return { success: `Transformation zu ${outputId} aufgezeichnet.` };
  }

  async DPPUebertragen(ctx, dppId, newOwnerMsp, shipperGln) {
    const buf = await ctx.stub.getState(DPP_PREFIX + dppId);
    if (!buf.length) throw new Error(`DPP ${dppId} nicht gefunden`);
    const dpp = JSON.parse(buf.toString());
    const caller = await this._getMSPID(ctx);

    if (dpp.ownerOrg !== caller) throw new Error(`Caller ist nicht Eigentümer (Owner ${dpp.ownerOrg})`);
    if (caller === newOwnerMsp) throw new Error('Neuer Eigentümer identisch mit aktuellem');
    if ([STATUS.gesperrt].includes(dpp.status) || ![STATUS.freigegeben, STATUS.freigegebenMitFehler].includes(dpp.status)) {
      throw new Error(`DPP ${dppId} (Status ${dpp.status}) ist nicht transferierbar`);
    }

    const shipEvt = new EPCISEvent({
      eventId: evtId('evt-ship'),
      eventType: 'ObjectEvent',
      eventTime: new Date().toISOString(),
      eventTimeZoneOffset: zeitzone(),
      bizStep: CBV.bizstep.shipping,
      action: 'OBSERVE',
      epcList: [dpp.gs1Key],
      disposition: CBV.disp.inTransit,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(shipperGln),
      bizLocation: sgln(shipperGln),
      extensions: { intendedRecipientMSP: newOwnerMsp, originalStatus: dpp.status },
    });
    dpp.epcisEvents.push(shipEvt);

    dpp.ownerOrg = newOwnerMsp;
    dpp.status = `${STATUS.gesendetZu}${newOwnerMsp}`;
    await this._write(ctx, dpp);
    return { success: `DPP ${dppId} an ${newOwnerMsp} übertragen.` };
  }

  async EmpfangBestaetigenUndPruefungAufzeichnen(ctx, dppId, recipientGln, inspectionResult) {
    const buf = await ctx.stub.getState(DPP_PREFIX + dppId);
    if (!buf.length) throw new Error(`DPP ${dppId} nicht gefunden`);
    const dpp = JSON.parse(buf.toString());

    const recipientMsp = await this._getMSPID(ctx);
    const expectedStatus = `${STATUS.gesendetZu}${recipientMsp}`;
    if (dpp.ownerOrg !== recipientMsp || !dpp.status.startsWith(expectedStatus)) {
      throw new Error(`Empfang nicht erlaubt (Owner ${dpp.ownerOrg}, Status ${dpp.status})`);
    }

    dpp.status = `${STATUS.akzeptiertVon}${recipientMsp}`;
    let inspTE;

    if (['NICHT_OKAY', 'OK'].includes(inspectionResult)) {
      inspTE = new TestErgebnis({
        standardName: 'Eingangspruefung',
        ergebnis: inspectionResult,
        zeit: new Date().toISOString(),
        durchfuehrendeOrg: recipientMsp,
        systemId: 'ManuellePruefungEmpfaenger',
        bewertungsergebnis: inspectionResult === 'OK' ? 'BESTANDEN' : 'FEHLGESCHLAGEN',
        kommentarBewertung: inspectionResult === 'OK' ? '' : 'NICHT_OKAY bei Eingangsprüfung.',
      });
      dpp.quality.push(inspTE);
      if (inspectionResult === 'NICHT_OKAY') dpp.status = STATUS.gesperrt;
    }

    const now = new Date();
    const ackEvt = new EPCISEvent({
      eventId: evtId('evt-recv'),
      eventType: 'ObjectEvent',
      eventTime: now.toISOString(),
      eventTimeZoneOffset: zeitzone(),
      bizStep: CBV.bizstep.receiving,
      action: 'ADD',
      epcList: [dpp.gs1Key],
      disposition: dpp.status === STATUS.gesperrt
        ? CBV.disp.nonConformant
        : inspectionResult === 'OK'
          ? (
            dpp.status.includes('Fehler') || dpp.quality.some((q) => q.bewertungsergebnis !== 'BESTANDEN')
              ? CBV.disp.conformantIssues
              : CBV.disp.conformant
          )
          : CBV.disp.inPossession,
      inputEPCList: [],
      outputEPCList: [],
      readPoint: sgln(recipientGln),
      bizLocation: sgln(recipientGln),
      extensions: inspectionResult ? { eingangspruefungErgebnis: inspectionResult } : {},
    });
    dpp.epcisEvents.push(ackEvt);

    if (inspTE) {
      const inspEvt = new EPCISEvent({
        eventId: evtId('evt-insp'),
        eventType: 'ObjectEvent',
        eventTime: inspTE.zeit,
        eventTimeZoneOffset: zeitzone(),
        bizStep: CBV.bizstep.inspecting,
        action: 'OBSERVE',
        epcList: [dpp.gs1Key],
        disposition: inspTE.bewertungsergebnis === 'BESTANDEN' ? CBV.disp.conformant : CBV.disp.nonConformant,
        inputEPCList: [],
        outputEPCList: [],
        readPoint: sgln(recipientGln),
        bizLocation: sgln(recipientGln),
        extensions: { eingangspruefungsdatenDurchEmpfaenger: inspTE },
      });
      dpp.epcisEvents.push(inspEvt);
    }

    if (dpp.status !== STATUS.gesperrt) evalStatus(dpp);
    await this._write(ctx, dpp);
    return { success: `Empfang für ${dppId} bestätigt.` };
  }

  async DPPAbfragen(ctx, dppId) {
    const buf = await ctx.stub.getState(DPP_PREFIX + dppId);
    if (!buf.length) throw new Error(`DPP ${dppId} nicht gefunden`);
    return JSON.parse(buf.toString());
  }
}

module.exports = DPPQualityContract;
module.exports.contracts = [DPPQualityContract];
