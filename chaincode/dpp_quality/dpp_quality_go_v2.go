package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type TestStandard struct {
	Name          string  `json:"name"`
	IstNumerisch  bool    `json:"istNumerisch"`
	GrenzeNiedrig float64 `json:"grenzeNiedrig"` // omitempty entfernt
	GrenzeHoch    float64 `json:"grenzeHoch"`    // omitempty entfernt
	WertErwartet  string  `json:"wertErwartet"`  // omitempty entfernt
	Einheit       string  `json:"einheit"`       // omitempty entfernt
	Benoetigt     bool    `json:"benoetigt"`
}

type TestErgebnis struct {
	StandardName       string `json:"standardName"`
	Ergebnis           string `json:"ergebnis"`
	Einheit            string `json:"einheit"`
	SystemID           string `json:"systemId"`
	Zeit               string `json:"zeit"`
	Zustaendiger       string `json:"zustaendiger"`
	DurchfuehrendeOrg  string `json:"durchfuehrendeOrg"`
	OffChainProtokoll  string `json:"offChainProtokoll"`
	DateiHash          string `json:"dateiHash"`
	Bewertungsergebnis string `json:"bewertungsergebnis,omitempty"`
	KommentarBewertung string `json:"kommentarBewertung"`
}

type TransportLogDateiReferenz struct {
	DateiPfad              string `json:"dateiPfad"`
	DateiHash              string `json:"dateiHash"`
	AlarmZusammenfassung   string `json:"alarmZusammenfassung"`
	SystemID               string `json:"systemId,omitempty"`
	Zustaendiger           string `json:"zustaendiger,omitempty"`
	ZeitpunktVerankerung   string `json:"zeitpunktVerankerung,omitempty"`
	DurchfuehrendeOrgGLN   string `json:"durchfuehrendeOrgGLN,omitempty"`
	DurchfuehrendeOrgMSPID string `json:"durchfuehrendeOrgMSPID,omitempty"`
}

type EPCISEvent struct {
	EventID             string                 `json:"eventId"`
	EventType           string                 `json:"eventType"`
	EventTime           string                 `json:"eventTime"`
	EventTimeZoneOffset string                 `json:"eventTimeZoneOffset"`
	BizStep             string                 `json:"bizStep"`
	Action              string                 `json:"action,omitempty"`
	EPCList             []string               `json:"epcList,omitempty"` // Kann omitempty bleiben, wenn wirklich optional
	Disposition         string                 `json:"disposition,omitempty"`
	InputEPCList        []string               `json:"inputEPCList"`    // omitempty entfernt
	OutputEPCList       []string               `json:"outputEPCList"`   // omitempty entfernt
	ReadPoint           string                 `json:"readPoint,omitempty"`
	BizLocation         string                 `json:"bizLocation"`
	Extensions          map[string]interface{} `json:"extensions"`
}

type DPP struct {
	DppID                   string                      `json:"dppId"`
	GS1Key                  string                      `json:"gs1Key"`
	ProductTypeID           string                      `json:"productTypeId,omitempty"`
	ManufacturerGLN         string                      `json:"manufacturerGln"`
	Batch                   string                      `json:"batch"`
	ProductionDate          string                      `json:"productionDate"`
	OwnerOrg                string                      `json:"ownerOrg"`
	Status                  string                      `json:"status"`
	Specifications          []TestStandard              `json:"specifications"` // omitempty entfernt, falls das ganze Array nicht fehlen darf
	OffenePflichtpruefungen []string                    `json:"offenePflichtpruefungen"`
	Quality                 []TestErgebnis              `json:"quality"`
	VerankerteTransportLogs []TransportLogDateiReferenz `json:"verankerteTransportLogs"` // omitempty entfernt
	InputDPPIDs             []string                    `json:"inputDppIds"`             // omitempty entfernt
	EPCISEvents             []EPCISEvent                `json:"epcisEvents"`
}

type DPPQualityContract struct {
	contractapi.Contract
}

const dppPrefix = "DPP-"
const (
	StatusEntwurf                = "Entwurf"
	StatusFreigegeben            = "Freigegeben"
	StatusFreigegebenMitFehler   = "FreigegebenMitFehler"
	StatusGesperrt               = "Gesperrt"
	StatusTransportZuPrefix      = "TransportZu_"
	StatusAkzeptiertVonPrefix    = "AkzeptiertVon_"
	StatusGeloschtInTransfPrefix = "GeloschtInTransf_"
	StatusWartetAufPflichtpruefungen = "WartetAufPflichtpruefungen"
)

var gs1URNRegexp = regexp.MustCompile(`^urn:epc:id:([a-zA-Z0-9_]+):([a-zA-Z0-9\.\-]+)(\.[\w\.\-]+)*$`)

func validiereGS1Schluessel(gs1 string) error {
	if !gs1URNRegexp.MatchString(gs1) { return fmt.Errorf("GS1 Schlüssel ungültig: %s", gs1) }
	return nil
}
func (c *DPPQualityContract) dppExistiert(ctx contractapi.TransactionContextInterface, dppID string) (bool, error) {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil { return false, fmt.Errorf("Fehler beim Lesen des DPP %s: %w", dppID, err) }
	return dppDaten != nil, nil
}
func tzOffset() string { return time.Now().Format("-07:00") }
func sgln(gln string) string {
	if gln == "" { return "" }
	return "urn:epc:id:sgln:" + gln + ".0.0"
}

func (dpp *DPP) StatusEvaluierung() {
	if dpp.Status == StatusGesperrt || strings.HasPrefix(dpp.Status, StatusGeloschtInTransfPrefix) { return }
	if strings.HasPrefix(dpp.Status, StatusTransportZuPrefix) || strings.HasPrefix(dpp.Status, StatusAkzeptiertVonPrefix) { return }
	hatFehler := false
	hatProblemeOhneBlock := false
	for _, te := range dpp.Quality {
		if te.Bewertungsergebnis == "FEHLGESCHLAGEN" { hatFehler = true; break }
		if te.Bewertungsergebnis == "INFO_KEIN_STANDARD" { hatProblemeOhneBlock = true }
	}
	if hatFehler { dpp.Status = StatusGesperrt; return }
	for _, logRef := range dpp.VerankerteTransportLogs {
		if logRef.AlarmZusammenfassung == "JA" { hatProblemeOhneBlock = true }
	}
	allePflichtpruefungenErledigt := len(dpp.OffenePflichtpruefungen) == 0
	if allePflichtpruefungenErledigt {
		if hatProblemeOhneBlock { dpp.Status = StatusFreigegebenMitFehler
		} else { dpp.Status = StatusFreigegeben }
	} else {
		dpp.Status = fmt.Sprintf("%s (%d offen)", StatusWartetAufPflichtpruefungen, len(dpp.OffenePflichtpruefungen))
	}
}

func (c *DPPQualityContract) ErstellenDPP(ctx contractapi.TransactionContextInterface, dppID, gs1Key, productTypeID, manufacturerGLN, batch, productionDate string, specificationsJSON string) (*DPP, error) {
	existiert, err := c.dppExistiert(ctx, dppID)
	if err != nil { return nil, err }
	if existiert { return nil, fmt.Errorf("DPP mit ID %s existiert bereits", dppID) }
	if err := validiereGS1Schluessel(gs1Key); err != nil { return nil, err }
	var specs []TestStandard
	if specificationsJSON != "" {
		if err := json.Unmarshal([]byte(specificationsJSON), &specs); err != nil {
			return nil, fmt.Errorf("JSON der Spezifikationen ungültig: %w", err)
		}
	}
	var offenePflichtpruefungen []string
	for _, s := range specs {
		if s.Benoetigt { offenePflichtpruefungen = append(offenePflichtpruefungen, s.Name) }
	}
	clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil { return nil, fmt.Errorf("Fehler beim Abrufen der Client MSPID: %w", errClientMSPID) }
	now := time.Now()
	initialStatus := StatusEntwurf
	evt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-create-%d", now.UnixNano()), EventType: "ObjectEvent",
		EventTime:           now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:commissioning", Action: "ADD", EPCList: []string{gs1Key},
		Disposition:         "urn:epcglobal:cbv:disp:active", ReadPoint: sgln(manufacturerGLN), BizLocation: sgln(manufacturerGLN),
		Extensions:          make(map[string]interface{}),
		InputEPCList:        []string{}, // Explizit initialisieren
		OutputEPCList:       []string{}, // Explizit initialisieren
	}
	dpp := DPP{
		DppID:                   dppID, GS1Key: gs1Key, ProductTypeID: productTypeID, ManufacturerGLN: manufacturerGLN,
		Batch:                   batch, ProductionDate: productionDate, OwnerOrg: clientMSPID, Status: initialStatus,
		Specifications:          specs, OffenePflichtpruefungen: offenePflichtpruefungen, Quality: []TestErgebnis{},
		VerankerteTransportLogs: []TransportLogDateiReferenz{}, InputDPPIDs: []string{}, EPCISEvents: []EPCISEvent{evt},
	}
	dpp.StatusEvaluierung()
	dppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil { return nil, fmt.Errorf("Fehler beim Marshalling des DPP %s: %w", dppID, errMarshal) }
	errPut := ctx.GetStub().PutState(dppPrefix+dppID, dppDaten)
	if errPut != nil { return nil, fmt.Errorf("Fehler beim Speichern des DPP %s: %w", dppID, errPut) }
	return &dpp, nil
}

func (c *DPPQualityContract) AufzeichnenTestergebnisse(ctx contractapi.TransactionContextInterface, dppID string, testErgebnisJSON string, recordingSiteGLN string) error {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil { return fmt.Errorf("Lesefehler DPP %s: %w", dppID, err) }
	if dppDaten == nil { return fmt.Errorf("DPP %s nicht gefunden", dppID) }
	var dpp DPP
	if err := json.Unmarshal(dppDaten, &dpp); err != nil { return fmt.Errorf("Unmarshal Fehler DPP %s: %w", dppID, err) }
	var te TestErgebnis
	if err := json.Unmarshal([]byte(testErgebnisJSON), &te); err != nil { return fmt.Errorf("JSON TestErgebnis ungültig: %w", err) }
	if te.Zeit == "" { te.Zeit = time.Now().UTC().Format(time.RFC3339) }
	if te.DurchfuehrendeOrg == "" {
		clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
		if errClientMSPID != nil { return fmt.Errorf("MSPID Fehler für TestErgebnis: %w", errClientMSPID) }
		te.DurchfuehrendeOrg = clientMSPID
	}
	var currentStandard *TestStandard
	for i := range dpp.Specifications {
		if dpp.Specifications[i].Name == te.StandardName { currentStandard = &dpp.Specifications[i]; break }
	}
	clientHatBewertet := (te.Bewertungsergebnis == "BESTANDEN" || te.Bewertungsergebnis == "FEHLGESCHLAGEN")
	if !clientHatBewertet {
		te.KommentarBewertung = ""
		if currentStandard == nil {
			te.Bewertungsergebnis = "INFO_KEIN_STANDARD"
			te.KommentarBewertung = fmt.Sprintf("Kein Standard für Test '%s' im DPP hinterlegt.", te.StandardName)
		} else {
			if currentStandard.IstNumerisch {
				ergebnisVal, convErr := strconv.ParseFloat(te.Ergebnis, 64)
				if convErr != nil {
					te.Bewertungsergebnis = "FEHLGESCHLAGEN"
					te.KommentarBewertung = fmt.Sprintf("Ergebnis '%s' für '%s' ist nicht numerisch.", te.Ergebnis, te.StandardName)
				} else {
					if ergebnisVal < currentStandard.GrenzeNiedrig || ergebnisVal > currentStandard.GrenzeHoch {
						te.Bewertungsergebnis = "FEHLGESCHLAGEN"
						te.KommentarBewertung = fmt.Sprintf("Wert %.4f außerhalb Toleranz [%.4f, %.4f] %s.", ergebnisVal, currentStandard.GrenzeNiedrig, currentStandard.GrenzeHoch, currentStandard.Einheit)
					} else { te.Bewertungsergebnis = "BESTANDEN" }
				}
			} else {
				if strings.EqualFold(te.Ergebnis, currentStandard.WertErwartet) { te.Bewertungsergebnis = "BESTANDEN"
				} else {
					te.Bewertungsergebnis = "FEHLGESCHLAGEN"
					te.KommentarBewertung = fmt.Sprintf("Erwartet '%s', Erhalten '%s'.", currentStandard.WertErwartet, te.Ergebnis)
				}
			}
			if currentStandard.Einheit != "" && te.Einheit != "" && !strings.EqualFold(currentStandard.Einheit, te.Einheit) && te.Bewertungsergebnis != "FEHLGESCHLAGEN" {
				if te.KommentarBewertung != "" { te.KommentarBewertung += " " }
				te.KommentarBewertung += fmt.Sprintf("Einheitenwarnung: Standard '%s', Ergebnis '%s'.", currentStandard.Einheit, te.Einheit)
			}
		}
	} else {
		if te.KommentarBewertung == "" && te.Bewertungsergebnis != "BESTANDEN" { te.KommentarBewertung = "Bewertung extern gesetzt." }
	}
	dpp.Quality = append(dpp.Quality, te)
	now := time.Now()
	epcisDisposition := "urn:epcglobal:cbv:disp:active"
	if te.Bewertungsergebnis == "BESTANDEN" { epcisDisposition = "urn:epcglobal:cbv:disp:conformant" }
	if te.Bewertungsergebnis == "FEHLGESCHLAGEN" || te.Bewertungsergebnis == "INFO_KEIN_STANDARD" { epcisDisposition = "urn:epcglobal:cbv:disp:non_conformant" }
	qcEvent := EPCISEvent{
		EventID:             fmt.Sprintf("evt-qc-%s-%d", strings.ReplaceAll(strings.ReplaceAll(te.StandardName, " ", "_"), "/", "_"), now.UnixNano()),
		EventType:           "ObjectEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:inspecting", Action: "OBSERVE", EPCList: []string{dpp.GS1Key},
		Disposition:         epcisDisposition, ReadPoint: sgln(recordingSiteGLN), BizLocation: sgln(recordingSiteGLN),
		Extensions:          map[string]interface{}{"aufgezeichneteTestdaten": te},
		InputEPCList:        []string{}, OutputEPCList: []string{},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, qcEvent)
	if currentStandard != nil && currentStandard.Benoetigt && te.Bewertungsergebnis == "BESTANDEN" {
		neueOffenePruefungen := make([]string, 0) // Oder []string{}
		for _, pruefungsName := range dpp.OffenePflichtpruefungen {
			if pruefungsName != te.StandardName { neueOffenePruefungen = append(neueOffenePruefungen, pruefungsName) }
		}
		dpp.OffenePflichtpruefungen = neueOffenePruefungen
	}
	dpp.StatusEvaluierung()
	if te.Bewertungsergebnis == "FEHLGESCHLAGEN" {
		alertPayload := map[string]interface{}{ "dppId": dppID, "gs1Key": dpp.GS1Key, "batch": dpp.Batch, "productTypeId": dpp.ProductTypeID, "standardName": te.StandardName,
			"ergebnis": te.Ergebnis, "bewertungsergebnis": te.Bewertungsergebnis, "kommentarBewertung": te.KommentarBewertung, "zeit": te.Zeit,
			"systemId": te.SystemID, "durchfuehrendeOrg": te.DurchfuehrendeOrg, "dateiHash": te.DateiHash, }
		alertDaten, _ := json.Marshal(alertPayload)
		ctx.GetStub().SetEvent("QualityAlert", alertDaten)
	}
	updatedDppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil { return fmt.Errorf("Marshal Fehler Update DPP %s: %w", dppID, errMarshal) }
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppDaten)
}

func (c *DPPQualityContract) TransportLogDateiVerankern(ctx contractapi.TransactionContextInterface, dppID string, logDateiReferenzJSON string, siteGLN string) error {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil { return fmt.Errorf("Lesefehler DPP %s: %w", dppID, err) }
	if dppDaten == nil { return fmt.Errorf("DPP %s nicht gefunden", dppID) }
	var dpp DPP
	if err := json.Unmarshal(dppDaten, &dpp); err != nil { return fmt.Errorf("Unmarshal Fehler DPP %s: %w", dppID, err) }
	clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil { return fmt.Errorf("MSPID Fehler bei TransportLogVerankerung: %w", errClientMSPID) }
	var logRef TransportLogDateiReferenz
	if err := json.Unmarshal([]byte(logDateiReferenzJSON), &logRef); err != nil { return fmt.Errorf("JSON TransportLogDateiReferenz ungültig: %w", err) }
	logRef.ZeitpunktVerankerung = time.Now().UTC().Format(time.RFC3339)
	logRef.DurchfuehrendeOrgGLN = siteGLN
	logRef.DurchfuehrendeOrgMSPID = clientMSPID
	dpp.VerankerteTransportLogs = append(dpp.VerankerteTransportLogs, logRef)
	now := time.Now()
	epcisDispositionFuerTransportLog := "urn:epcglobal:cbv:disp:in_transit"
	if logRef.AlarmZusammenfassung == "JA" { epcisDispositionFuerTransportLog = "urn:epcglobal:cbv:disp:non_conformant_in_transit" }
	transportLogEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-transportfileanchor-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent", EventTime: logRef.ZeitpunktVerankerung, EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:storing", Action: "ADD", EPCList: []string{dpp.GS1Key},
		Disposition:         epcisDispositionFuerTransportLog, ReadPoint: sgln(siteGLN), BizLocation: sgln(siteGLN),
		Extensions:          map[string]interface{}{"verankerteTransportLogDatei": logRef},
		InputEPCList:        []string{}, OutputEPCList: []string{},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, transportLogEvt)
	dpp.StatusEvaluierung()
	updatedDppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil { return fmt.Errorf("Marshal Fehler Update DPP %s nach Transport-Log Verankerung: %w", dppID, errMarshal) }
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppDaten)
}

func (c *DPPQualityContract) TransformationAufzeichnen(ctx contractapi.TransactionContextInterface,
	outputDppID, outputGS1Key, outputProductTypeID string, currentGLN string, batch, productionDate string,
	inputDPPIDsJSON string, outputSpecificationsJSON string, initialTestResultJSON string) error {
	existiert, err := c.dppExistiert(ctx, outputDppID)
	if err != nil { return err }
	if existiert { return fmt.Errorf("Output DPP %s existiert bereits", outputDppID) }
	if err := validiereGS1Schluessel(outputGS1Key); err != nil { return err }
	clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil { return fmt.Errorf("Fehler beim Abrufen der Client MSPID für Transformation: %w", errClientMSPID) }
	var inputDPPIDs []string
	if err := json.Unmarshal([]byte(inputDPPIDsJSON), &inputDPPIDs); err != nil { return fmt.Errorf("JSON InputDPPIDs ungültig: %w", err) }
	var inputGS1KeysForEvent []string
	for _, inputID := range inputDPPIDs {
		inputDppDaten, errGet := ctx.GetStub().GetState(dppPrefix + inputID)
		if errGet != nil { return fmt.Errorf("Lesefehler InputDPP %s: %w", inputID, errGet) }
		if inputDppDaten == nil { return fmt.Errorf("InputDPP %s nicht gefunden", inputID) }
		var inputDPP DPP
		if errUnmarshalInput := json.Unmarshal(inputDppDaten, &inputDPP); errUnmarshalInput != nil { return fmt.Errorf("Unmarshal Fehler InputDPP %s: %w", inputID, errUnmarshalInput) }
		isAcceptedByCurrentOrg := inputDPP.Status == fmt.Sprintf("%s%s", StatusAkzeptiertVonPrefix, clientMSPID)
		if inputDPP.Status != StatusFreigegeben && inputDPP.Status != StatusFreigegebenMitFehler && !isAcceptedByCurrentOrg {
			return fmt.Errorf("Input DPP %s (Status: %s) ist nicht freigegeben oder vom aktuellen Unternehmen (%s) akzeptiert und kann nicht transformiert werden", inputID, inputDPP.Status, clientMSPID)
		}
		inputGS1KeysForEvent = append(inputGS1KeysForEvent, inputDPP.GS1Key)
		inputDPP.Status = fmt.Sprintf("%s%s", StatusGeloschtInTransfPrefix, outputDppID)
		updatedInputDaten, errMarshalInput := json.Marshal(inputDPP)
		if errMarshalInput != nil { return fmt.Errorf("Marshal Fehler Update InputDPP %s: %w", inputID, errMarshalInput) }
		if errPutInput := ctx.GetStub().PutState(dppPrefix+inputID, updatedInputDaten); errPutInput != nil { return fmt.Errorf("Speicherfehler Update InputDPP %s: %w", inputID, errPutInput) }
	}
	outputDPPObj, errCreate := c.ErstellenDPP(ctx, outputDppID, outputGS1Key, outputProductTypeID, currentGLN, batch, productionDate, outputSpecificationsJSON)
	if errCreate != nil { return fmt.Errorf("ErstellenDPP Fehler für OutputDPP: %w", errCreate) }
	if outputDPPObj == nil { return fmt.Errorf("OutputDPP ist nil nach ErstellenDPP") }
	outputDPPObj.InputDPPIDs = inputDPPIDs
	now := time.Now()
	tfEvent := EPCISEvent{
		EventID:             fmt.Sprintf("evt-tf-%s-%d", strings.ReplaceAll(outputGS1Key, ":", "_"), now.UnixNano()),
		EventType:           "TransformationEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:transforming", InputEPCList: inputGS1KeysForEvent, OutputEPCList: []string{outputGS1Key},
		ReadPoint:           sgln(currentGLN), BizLocation: sgln(currentGLN), Extensions: make(map[string]interface{}),
	}
	if initialTestResultJSON != "" && initialTestResultJSON != "{}" {
		var initialTE TestErgebnis
		if errTE := json.Unmarshal([]byte(initialTestResultJSON), &initialTE); errTE == nil {
			if initialTE.Zeit == "" { initialTE.Zeit = now.UTC().Format(time.RFC3339) }
			if initialTE.DurchfuehrendeOrg == "" { initialTE.DurchfuehrendeOrg = clientMSPID }
			tfEvent.Extensions["initialesKombinationsTestergebnis"] = initialTE
			clientHatInitialBewertet := (initialTE.Bewertungsergebnis == "BESTANDEN" || initialTE.Bewertungsergebnis == "FEHLGESCHLAGEN")
			if !clientHatInitialBewertet {
				initialTE.KommentarBewertung = ""
				var standardFuerInitialTest *TestStandard
				for i := range outputDPPObj.Specifications {
					if outputDPPObj.Specifications[i].Name == initialTE.StandardName { standardFuerInitialTest = &outputDPPObj.Specifications[i]; break }
				}
				if standardFuerInitialTest != nil {
					if standardFuerInitialTest.IstNumerisch {
						val, convErr := strconv.ParseFloat(initialTE.Ergebnis, 64)
						if convErr != nil {
							initialTE.Bewertungsergebnis = "FEHLGESCHLAGEN"
							initialTE.KommentarBewertung = fmt.Sprintf("Initiales Ergebnis '%s' ('%s') nicht numerisch.", initialTE.Ergebnis, initialTE.StandardName)
						} else if val < standardFuerInitialTest.GrenzeNiedrig || val > standardFuerInitialTest.GrenzeHoch {
							initialTE.Bewertungsergebnis = "FEHLGESCHLAGEN"
							initialTE.KommentarBewertung = fmt.Sprintf("Initialer Wert %.4f ('%s') außer Toleranz.", val, initialTE.StandardName)
						} else { initialTE.Bewertungsergebnis = "BESTANDEN" }
					} else {
						if strings.EqualFold(initialTE.Ergebnis, standardFuerInitialTest.WertErwartet) { initialTE.Bewertungsergebnis = "BESTANDEN"
						} else {
							initialTE.Bewertungsergebnis = "FEHLGESCHLAGEN"
							initialTE.KommentarBewertung = fmt.Sprintf("Initial erwartet '%s' ('%s'), aber '%s'.", standardFuerInitialTest.WertErwartet, initialTE.StandardName, initialTE.Ergebnis)
						}
					}
				} else if initialTE.StandardName != "" {
					initialTE.Bewertungsergebnis = "INFO_KEIN_STANDARD"
					initialTE.KommentarBewertung = fmt.Sprintf("Kein Standard für initialen Test '%s' im Output-DPP.", initialTE.StandardName)
				}
			}
			outputDPPObj.Quality = append(outputDPPObj.Quality, initialTE)
			var standardFuerInitialTest *TestStandard
			for i := range outputDPPObj.Specifications {
				if outputDPPObj.Specifications[i].Name == initialTE.StandardName { standardFuerInitialTest = &outputDPPObj.Specifications[i]; break }
			}
			if standardFuerInitialTest != nil && standardFuerInitialTest.Benoetigt && initialTE.Bewertungsergebnis == "BESTANDEN" {
				neueOffene := make([]string, 0) // Oder []string{}
				for _, name := range outputDPPObj.OffenePflichtpruefungen { if name != initialTE.StandardName { neueOffene = append(neueOffene, name) } }
				outputDPPObj.OffenePflichtpruefungen = neueOffene
			}
		} else { return fmt.Errorf("Ungültiges JSON für initialTestResultJSON: %w", errTE) }
	}
	outputDPPObj.EPCISEvents = append(outputDPPObj.EPCISEvents, tfEvent)
	outputDPPObj.StatusEvaluierung()
	finalOutputDppDaten, errMarshalFinal := json.Marshal(outputDPPObj)
	if errMarshalFinal != nil { return fmt.Errorf("Marshal Fehler OutputDPP %s: %w", outputDppID, errMarshalFinal) }
	errPutFinal := ctx.GetStub().PutState(dppPrefix+outputDppID, finalOutputDppDaten)
	if errPutFinal != nil { return fmt.Errorf("Speicherfehler OutputDPP %s: %w", outputDppID, errPutFinal) }
	return nil
}

func (c *DPPQualityContract) DPPUebertragen(ctx contractapi.TransactionContextInterface, dppID, newOwnerMSP, shipperGLN string) error {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil { return fmt.Errorf("Lesefehler DPP %s: %w", dppID, err) }
	if dppDaten == nil { return fmt.Errorf("DPP %s nicht gefunden", dppID) }
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppDaten, &dpp); errUnmarshal != nil { return fmt.Errorf("Unmarshal Fehler DPP %s: %w", dppID, errUnmarshal) }
	currentOwnerMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil { return fmt.Errorf("MSPID Fehler bei Übertragung: %w", errClientMSPID) }
	if dpp.OwnerOrg != currentOwnerMSPID { return fmt.Errorf("Eigentümer Konflikt: DPP gehört %s, Aufrufer ist %s", dpp.OwnerOrg, currentOwnerMSPID) }
	if dpp.OwnerOrg == newOwnerMSP { return errors.New("Neuer Eigentümer ist identisch mit dem aktuellen Eigentümer") }
	isTransferable := dpp.Status == StatusFreigegeben || dpp.Status == StatusFreigegebenMitFehler
	if !isTransferable || dpp.Status == StatusGesperrt { return fmt.Errorf("DPP %s (Status %s) ist nicht transferierbar", dppID, dpp.Status) }
	originalStatusVorTransport := dpp.Status
	now := time.Now()
	shipEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-ship-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:shipping", Action: "OBSERVE", EPCList: []string{dpp.GS1Key},
		BizLocation:         sgln(shipperGLN),
		Disposition:         "urn:epcglobal:cbv:disp:in_transit", ReadPoint: sgln(shipperGLN),
		Extensions:          map[string]interface{}{"intendedRecipientMSP": newOwnerMSP, "originalStatus": originalStatusVorTransport},
		InputEPCList:        []string{}, OutputEPCList: []string{},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, shipEvt)
	dpp.OwnerOrg = newOwnerMSP
	dpp.Status = fmt.Sprintf("%s%s", StatusTransportZuPrefix, newOwnerMSP)
	updatedDppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil { return fmt.Errorf("Marshal Fehler DPP %s bei Übertragung: %w", dppID, errMarshal) }
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppDaten)
}

func (c *DPPQualityContract) EmpfangBestaetigenUndPruefungAufzeichnen(ctx contractapi.TransactionContextInterface, dppID, recipientGLN string, incomingInspectionResult string) error {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil { return fmt.Errorf("Lesefehler DPP %s: %w", dppID, err) }
	if dppDaten == nil { return fmt.Errorf("DPP %s nicht gefunden", dppID) }
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppDaten, &dpp); errUnmarshal != nil { return fmt.Errorf("Unmarshal Fehler DPP %s: %w", dppID, errUnmarshal) }
	recipientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil { return fmt.Errorf("MSPID Fehler bei Bestätigung: %w", errClientMSPID) }
	erwarteterStatusPrefix := StatusTransportZuPrefix + recipientMSPID
	if dpp.OwnerOrg != recipientMSPID || !strings.HasPrefix(dpp.Status, erwarteterStatusPrefix) {
		return fmt.Errorf("Empfang für DPP %s durch %s nicht erlaubt (Owner: %s, Status: %s)", dppID, recipientMSPID, dpp.OwnerOrg, dpp.Status)
	}
	dpp.Status = StatusAkzeptiertVonPrefix + recipientMSPID
	inspectionPerformed := false
	var inspTE TestErgebnis
	if incomingInspectionResult == "NICHT_OKAY" || incomingInspectionResult == "OK" {
		inspectionPerformed = true
		inspTE = TestErgebnis{
			StandardName:      "Eingangspruefung", Ergebnis: incomingInspectionResult, Zeit: time.Now().UTC().Format(time.RFC3339),
			DurchfuehrendeOrg: recipientMSPID, SystemID: "ManuellePruefungEmpfaenger",
		}
		if incomingInspectionResult == "OK" { inspTE.Bewertungsergebnis = "BESTANDEN"
		} else {
			inspTE.Bewertungsergebnis = "FEHLGESCHLAGEN"
			inspTE.KommentarBewertung = "DPP bei Eingangsprüfung als NICHT_OKAY bewertet durch Empfänger."
			dpp.Status = StatusGesperrt
		}
		dpp.Quality = append(dpp.Quality, inspTE)
	}
	ackDisposition := "urn:epcglobal:cbv:disp:in_possession"
	if dpp.Status == StatusGesperrt { ackDisposition = "urn:epcglobal:cbv:disp:non_conformant"
	} else if incomingInspectionResult == "OK" && dpp.Status != StatusGesperrt {
		if strings.Contains(dpp.Status, "Fehler") { ackDisposition = "urn:epcglobal:cbv:disp:conformant_with_issues"
		} else { ackDisposition = "urn:epcglobal:cbv:disp:conformant" }
	}
	now := time.Now()
	ackEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-recv-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:receiving", Action: "ADD", EPCList: []string{dpp.GS1Key},
		Disposition:         ackDisposition, ReadPoint: sgln(recipientGLN), BizLocation: sgln(recipientGLN),
		Extensions:          make(map[string]interface{}),
		InputEPCList:        []string{}, OutputEPCList: []string{},
	}
	if inspectionPerformed { ackEvt.Extensions["eingangspruefungErgebnis"] = incomingInspectionResult }
	dpp.EPCISEvents = append(dpp.EPCISEvents, ackEvt)
	if inspectionPerformed {
		inspTime := time.Now()
		inspEventDisposition := "urn:epcglobal:cbv:disp:active"
		if inspTE.Bewertungsergebnis == "BESTANDEN" { inspEventDisposition = "urn:epcglobal:cbv:disp:conformant"
		} else { inspEventDisposition = "urn:epcglobal:cbv:disp:non_conformant" }
		inspEvent := EPCISEvent{
			EventID:             fmt.Sprintf("evt-insp-%s-%s-%d", recipientMSPID, strings.ReplaceAll(dpp.GS1Key, ":", "_"), inspTime.UnixNano()),
			EventType:           "ObjectEvent", EventTime: inspTime.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
			BizStep:             "urn:epcglobal:cbv:bizstep:inspecting", Action: "OBSERVE", EPCList: []string{dpp.GS1Key},
			Disposition:         inspEventDisposition, ReadPoint: sgln(recipientGLN), BizLocation: sgln(recipientGLN),
			Extensions:          map[string]interface{}{"eingangspruefungsdatenDurchEmpfaenger": inspTE},
			InputEPCList:        []string{}, OutputEPCList: []string{},
		}
		dpp.EPCISEvents = append(dpp.EPCISEvents, inspEvent)
	}
	if dpp.Status != StatusGesperrt { dpp.StatusEvaluierung() }
	updatedDppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil { return fmt.Errorf("Marshal Fehler DPP %s bei Bestätigung: %w", dppID, errMarshal) }
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppDaten)
}

func (c *DPPQualityContract) DPPAbfragen(ctx contractapi.TransactionContextInterface, dppID string) (*DPP, error) {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil { return nil, fmt.Errorf("Lesefehler DPP %s: %w", dppID, err) }
	if dppDaten == nil { return nil, fmt.Errorf("DPP %s nicht gefunden", dppID) }
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppDaten, &dpp); errUnmarshal != nil { return nil, fmt.Errorf("Unmarshal Fehler DPP %s: %w", dppID, errUnmarshal) }
	return &dpp, nil
}

func (c *DPPQualityContract) LedgerInitialisieren(ctx contractapi.TransactionContextInterface) error {
	return nil
}