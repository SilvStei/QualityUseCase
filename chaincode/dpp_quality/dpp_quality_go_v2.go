/*
 * dpp_quality_gs1.go – Chaincode für Digital Product Pässe (DPP) mit GS1-ID
 * und EPCIS-Event-Modell. Stand: Mai 2025 – geeignet für Hyperledger Fabric 2.5
 *
 * Anpassungen für verbesserte EPCIS 2.0 Konformität (Mai 2025):
 * - EPCISEvent Struktur: Korrekte JSON-Tags (`epcList`, `inputEPCList`, `outputEPCList`).
 * - ObjectEvent: Verwendet `epcList` statt `outputEPCList`.
 * - TransformationEvent: Verwendet `inputEPCList` und `outputEPCList`.
 * - GS1-Schlüsselvalidierung: Etwas allgemeiner für EPC URNs.
 * - Konsistente Befüllung der EPCIS-Pflicht- und empfohlenen Felder (eventTimeZoneOffset, action, disposition, readPoint, bizLocation).
 * - EventID-Generierung verwendet UnixNano für höhere Eindeutigkeit.
 *
 * Struktur:
 * - DPP          : Basisdaten + Qualitätsblöcke + EPCIS-Events
 * - QualityEntry : Ein einzelnes Testergebnis (Labor, QMS, Inline-Sensor)
 * - EPCISEvent   : Abbild eines EPCIS 2.0 Object- oder TransformationEvents
 *
 * Kernfunktionen:
 * CreateDPP()          – Rohprodukt/Charge anlegen (A, B)
 * AddQualityData()     – Qualitätsinfo anhängen (beliebige Stufe)
 * RecordTransformation() – Misch-/Compounding-Step (C)
 * TransferDPP()        – Eigentümerwechsel entlang Supply-Chain
 * QueryDPP()           – Einzelabfrage
 *
 * Die GS1-Schlüssel werden vom Client erzeugt (empfohlen: SGTIN oder LGTIN als URN).
 * Die Chaincode-Funktionen prüfen lediglich formale Plausibilität. Komplexe
 * GS1-Prüfungen (z. B. Check-Digit) können via Client-SDK erfolgen.
 */

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// --------------------------- Datenstrukturen --------------------------- //

type QualityEntry struct {
	TestName      string `json:"testName"`
	Result        string `json:"result"`
	Unit          string `json:"unit"`
	SystemID      string `json:"systemId"`
	Timestamp     string `json:"timestamp"`
	Responsible   string `json:"responsible"`
	PerformingOrg string `json:"performingOrg"`
}

type EPCISEvent struct {
	EventID             string                 `json:"eventId"`
	EventType           string                 `json:"eventType"` // "ObjectEvent" | "TransformationEvent" etc.
	EventTime           string                 `json:"eventTime"`
	EventTimeZoneOffset string                 `json:"eventTimeZoneOffset"`
	BizStep             string                 `json:"bizStep"` // z.B. "urn:epcglobal:cbv:bizstep:commissioning"

	// Spezifisch für ObjectEvent (und andere, wo relevant)
	Action      string   `json:"action,omitempty"      metadata:",optional"`      // z.B. "ADD", "OBSERVE", "DELETE"
	EPCList     []string `json:"epcList,omitempty"     metadata:",optional"`     // Korrektes Feld für ObjectEvent EPCs
	Disposition string   `json:"disposition,omitempty" metadata:",optional"` // z.B. "urn:epcglobal:cbv:disp:in_progress"

	// Spezifisch für TransformationEvent (und andere, wo relevant)
	InputEPCList  []string `json:"inputEPCList,omitempty"  metadata:",optional"`  // Korrektes Feld für Transformation Input EPCs
	OutputEPCList []string `json:"outputEPCList,omitempty" metadata:",optional"` // Korrektes Feld für Transformation Output EPCs

	// Allgemeine, oft empfohlene Felder
	ReadPoint   string `json:"readPoint,omitempty"   metadata:",optional"`   // z.B. SGLN URN
	BizLocation string `json:"bizLocation,omitempty" metadata:",optional"` // z.B. SGLN URN

	// Benutzerdefinierte Erweiterungen
	Extensions map[string]interface{} `json:"extensions"` // Immer initialisiert
}

type DPP struct {
	DppID           string         `json:"dppId"`           // interne Ledger-ID (Key)
	GS1Key          string         `json:"gs1Key"`          // z. B. urn:epc:id:sgtin:4012345.012345.12345
	ManufacturerGLN string         `json:"manufacturerGln"`
	Batch           string         `json:"batch"`
	ProductionDate  string         `json:"productionDate"`  // ISO-Date
	OwnerOrg        string         `json:"ownerOrg"`
	Status          string         `json:"status"`          // Released / Blocked / Consumed / ...
	Quality         []QualityEntry `json:"quality"`
	InputLots       []string       `json:"inputLots"`       // immer initialisiert
	EPCISEvents     []EPCISEvent   `json:"epcisEvents"`
}

// --------------------------- Contract --------------------------- //

type DPPQualityContract struct {
	contractapi.Contract
}

const dppPrefix = "DPP-" // ledger-key = DPP-<dppId>

// --------------------------- Utils --------------------------- //

// Allgemeinere GS1 EPC URN-Prüfung. Akzeptiert verschiedene EPC-Schemata.
// Für eine vollständige Validierung (inkl. Check-Digits, korrekte Längen etc.)
// sollte eine dedizierte GS1-Bibliothek clientseitig verwendet werden.
var gs1URNRegexp = regexp.MustCompile(`^urn:epc:id:([a-zA-Z0-9_]+):([a-zA-Z0-9\.\-]+)(\.[\w\.\-]+)*$`)

func validateGS1Key(gs1 string) error {
	if !gs1URNRegexp.MatchString(gs1) {
		return fmt.Errorf("ungültiger GS1 EPC URN-Schlüssel: %s. Erwartet Format wie urn:epc:id:sgtin:...", gs1)
	}
	return nil
}

func (c *DPPQualityContract) dppExists(ctx contractapi.TransactionContextInterface, dppID string) (bool, error) {
	data, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return false, err
	}
	return data != nil, nil
}

// tzOffset gibt den aktuellen Timezone-Offset im Format ±HH:MM zurück.
func tzOffset() string {
	return time.Now().Format("-07:00") // Beibehaltung des ursprünglichen Formats, das ±HH:MM ergibt
}

// sgln erzeugt eine SGLN URN für einen gegebenen GLN (vereinfachte Annahme für Extension).
func sgln(gln string) string {
	if gln == "" {
		return "" // Leeren String zurückgeben, wenn GLN leer ist, um `omitempty` zu erlauben
	}
	return "urn:epc:id:sgln:" + gln + ".0.0" // Vereinfachte Extension, Standard GS1 hat oft .0 für keine Extension
}

// --------------------------- Chaincode-APIs --------------------------- //

// CreateDPP legt einen neuen Pass für eine Charge / Serienobjekt an.
func (c *DPPQualityContract) CreateDPP(ctx contractapi.TransactionContextInterface, dppID, gs1Key, manufacturerGLN, batch, productionDate string) error {
	exists, err := c.dppExists(ctx, dppID)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("DPP %s existiert bereits", dppID)
	}
	if err := validateGS1Key(gs1Key); err != nil {
		return err
	}

	clientMSPID, _ := ctx.GetClientIdentity().GetMSPID()
	now := time.Now()

	evt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-%d", now.UnixNano()),
		EventType:           "ObjectEvent",
		EventTime:           now.UTC().Format(time.RFC3339),
		EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:commissioning",
		Action:              "ADD",
		EPCList:             []string{gs1Key}, // Korrekt für ObjectEvent
		Disposition:         "urn:epcglobal:cbv:disp:in_progress",
		ReadPoint:           sgln(manufacturerGLN),
		BizLocation:         sgln(manufacturerGLN),
		Extensions:          map[string]interface{}{},
		// InputEPCList und OutputEPCList bleiben leer (omitempty)
	}

	dpp := DPP{
		DppID:           dppID,
		GS1Key:          gs1Key,
		ManufacturerGLN: manufacturerGLN,
		Batch:           batch,
		ProductionDate:  productionDate,
		OwnerOrg:        clientMSPID,
		Status:          "Released",
		Quality:         []QualityEntry{},
		InputLots:       []string{},
		EPCISEvents:     []EPCISEvent{evt},
	}

	bytes, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+dppID, bytes)
}

// AddQualityData fügt dem Pass ein neues Testergebnis hinzu.
// Diese Funktion erzeugt selbst kein EPCIS Event, da Qualitätsdaten oft Teil
// eines umfassenderen Business Steps sind (z.B. Inspektion, die als eigenes Event erfasst wird).
// Alternativ könnte hier ein ObservationEvent mit den Qualitätsdaten in Extensions erzeugt werden.
// Für diese Anpassung bleibt es bei der bisherigen Logik.
func (c *DPPQualityContract) AddQualityData(ctx contractapi.TransactionContextInterface, dppID string, qualityJSON string) error {
	exists, err := c.dppExists(ctx, dppID)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("DPP %s nicht gefunden", dppID)
	}
	data, _ := ctx.GetStub().GetState(dppPrefix + dppID)
	var dpp DPP
	_ = json.Unmarshal(data, &dpp)

	var q QualityEntry
	if err := json.Unmarshal([]byte(qualityJSON), &q); err != nil {
		return fmt.Errorf("Quality-JSON fehlerhaft: %v", err)
	}

	if strings.TrimSpace(q.PerformingOrg) == "" {
		q.PerformingOrg, _ = ctx.GetClientIdentity().GetMSPID()
	}
	if q.Timestamp == "" {
		q.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	dpp.Quality = append(dpp.Quality, q)
	if strings.Contains(strings.ToLower(q.Result), "fail") {
		dpp.Status = "Blocked"
	}

	updated, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+dppID, updated)
}

// RecordTransformation bildet einen Misch-/Compounding-Schritt ab.
func (c *DPPQualityContract) RecordTransformation(ctx contractapi.TransactionContextInterface, outputDppID, outputGS1Key, currentGLN, batch, productionDate, inputJSON, qcJSON string) error {
	if err := validateGS1Key(outputGS1Key); err != nil {
		return err
	}
	exists, err := c.dppExists(ctx, outputDppID)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("DPP %s existiert bereits", outputDppID)
	}

	var inputs []string // Diese werden zu inputEPCList
	if err := json.Unmarshal([]byte(inputJSON), &inputs); err != nil {
		return fmt.Errorf("inputJSON ungültig: %v", err)
	}

	var qc QualityEntry
	if qcJSON != "" {
		if err := json.Unmarshal([]byte(qcJSON), &qc); err != nil {
			return fmt.Errorf("qcJSON fehlerhaft: %v", err)
		}
	}

	msp, _ := ctx.GetClientIdentity().GetMSPID()
	now := time.Now()

	evt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-%d", now.UnixNano()),
		EventType:           "TransformationEvent",
		EventTime:           now.UTC().Format(time.RFC3339),
		EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:commissioning", // Oder passenderer BizStep wie "urn:epcglobal:cbv:bizstep:transforming" oder "urn:epcglobal:cbv:bizstep:compounding"
		InputEPCList:        inputs,                 // Korrekt für TransformationEvent
		OutputEPCList:       []string{outputGS1Key}, // Korrekt für TransformationEvent
		ReadPoint:           sgln(currentGLN),       // Standort, an dem die Transformation stattfindet/erfasst wird
		BizLocation:         sgln(currentGLN),       // Geschäftsort der Transformation
		Extensions:          map[string]interface{}{},
		// Action und Disposition sind für TransformationEvent nicht typisch/standard
	}
	if qcJSON != "" {
		evt.Extensions["quality"] = qc
	}

	dpp := DPP{
		DppID:           outputDppID,
		GS1Key:          outputGS1Key,
		ManufacturerGLN: currentGLN, // Der GLN der transformierenden Einheit wird zum neuen "Hersteller" dieses DPPs
		Batch:           batch,
		ProductionDate:  productionDate,
		OwnerOrg:        msp,
		Status:          "Released",
		Quality:         []QualityEntry{},
		InputLots:       inputs, // Beibehaltung der Semantik von InputLots
		EPCISEvents:     []EPCISEvent{evt},
	}
	if qcJSON != "" {
		dpp.Quality = append(dpp.Quality, qc)
	}

	result, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+outputDppID, result)
}

// TransferDPP ändert den Eigentümer und erzeugt EPCIS ObjectEvent shipping/receiving.
// HINWEIS: Für eine präzisere Erfassung sollten ReadPoint/BizLocation des tatsächlichen Versenders
// und Empfängers als Parameter übergeben oder aus einem Organisationsregister bezogen werden.
// Hier wird vereinfacht der GLN des aktuellen (Noch-)Eigentümers für den Versand
// und für den Empfang keine spezifische Location gesetzt (wird durch Client-Anwendung des Empfängers erwartet).
func (c *DPPQualityContract) TransferDPP(ctx contractapi.TransactionContextInterface, dppID, newOwnerMSP, shipperGLN string) error {
	data, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return err
	}
	if data == nil {
		return fmt.Errorf("DPP %s nicht gefunden", dppID)
	}
	var dpp DPP
	_ = json.Unmarshal(data, &dpp)

	// Identität des aktuellen Aufrufers (des aktuellen Eigentümers, der transferiert)
	// currentOwnerMSPID, _ := ctx.GetClientIdentity().GetMSPID()
	// if dpp.OwnerOrg != currentOwnerMSPID {
	//  return fmt.Errorf("nur der aktuelle Eigentümer (%s) kann den DPP transferieren, nicht %s", dpp.OwnerOrg, currentOwnerMSPID)
	// }

	if dpp.OwnerOrg == newOwnerMSP {
		return errors.New("neuer Eigentümer entspricht aktuellem Eigentümer")
	}

	now := time.Now()
	eventTime := now.UTC().Format(time.RFC3339)
	timeZoneOffset := tzOffset()

	// Shipping Event (durch den aktuellen Eigentümer/Versender)
	shipEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-%d-ship", now.UnixNano()),
		EventType:           "ObjectEvent",
		EventTime:           eventTime,
		EventTimeZoneOffset: timeZoneOffset,
		BizStep:             "urn:epcglobal:cbv:bizstep:shipping",
		Action:              "OBSERVE", // "DELETE" würde bedeuten, es ist nicht mehr im Besitz des Versenders nachverfolgbar
		EPCList:             []string{dpp.GS1Key},
		Disposition:         "urn:epcglobal:cbv:disp:in_transit",
		ReadPoint:           sgln(shipperGLN), // Standort des Versenders
		BizLocation:         sgln(shipperGLN), // Geschäftsort des Versenders
		Extensions:          map[string]interface{}{},
	}

	// Receiving Event (theoretisch durch den neuen Eigentümer/Empfänger zu erfassen)
	// Da dies hier im Transfer-Aufruf des *Versenders* geschieht, ist es eine Antizipation
	// oder ein Platzhalter. Ein echtes Receiving-Event würde vom Empfänger-System ausgelöst.
	recvEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-%d-recv", now.UnixNano()+1), // leicht andere ID
		EventType:           "ObjectEvent",
		EventTime:           eventTime, // Kann leicht später sein, aber oft wird derselbe Zeitpunkt für Transfer verwendet
		EventTimeZoneOffset: timeZoneOffset,
		BizStep:             "urn:epcglobal:cbv:bizstep:receiving",
		Action:              "ADD",
		EPCList:             []string{dpp.GS1Key},
		Disposition:         "urn:epcglobal:cbv:disp:available", // Oder "urn:epcglobal:cbv:disp:in_progress" etc.
		// ReadPoint und BizLocation des Empfängers sind hier nicht bekannt,
		// sie sollten vom Empfangssystem gesetzt werden. Hier leer lassen (omitempty).
		ReadPoint:   "", // sgln(newOwnerGLN) - newOwnerGLN müsste übergeben werden
		BizLocation: "", // sgln(newOwnerGLN)
		Extensions:  map[string]interface{}{"receivingOrganization": newOwnerMSP},
	}

	dpp.OwnerOrg = newOwnerMSP // Eigentümerwechsel
	dpp.Status = fmt.Sprintf("TransferredTo_%s", newOwnerMSP)
	dpp.EPCISEvents = append(dpp.EPCISEvents, shipEvt, recvEvt)

	updated, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+dppID, updated)
}

// QueryDPP liefert den kompletten Pass zurück (inkl. Qualität & Events)
func (c *DPPQualityContract) QueryDPP(ctx contractapi.TransactionContextInterface, dppID string) (*DPP, error) {
	data, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, fmt.Errorf("DPP %s nicht gefunden", dppID)
	}
	var dpp DPP
	_ = json.Unmarshal(data, &dpp)
	return &dpp, nil
}

// InitLedger kann verwendet werden, um initiale Test-DPPs zu erstellen (optional)
func (c *DPPQualityContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	// Beispiel: Erstelle einen initialen DPP für Org1MSP
	// Parameter müssen hier fest codiert oder aus einer anderen Quelle bezogen werden.
	// Für ein echtes Deployment ist diese Funktion oft nicht notwendig oder wird anders gehandhabt.

	/* Beispielhafter Aufruf, der hier nicht direkt ausgeführt wird, sondern als Vorlage dient:
	dppID := "DPP_INIT_001"
	gs1Key := "urn:epc:id:sgtin:4000001.000123.98765" // Beispiel SGTIN
	manufacturerGLN := "4000001000000" // Beispiel GLN für Org1
	batch := "BATCH_INITIAL_A"
	productionDate := "2025-01-15"

	// Prüfen, ob DPP bereits existiert
	exists, err := c.dppExists(ctx, dppID)
	if err != nil {
	    return fmt.Errorf("Fehler bei Prüfung von DPP %s: %v", dppID, err)
	}
	if !exists {
	    err = c.CreateDPP(ctx, dppID, gs1Key, manufacturerGLN, batch, productionDate)
	    if err != nil {
	        return fmt.Errorf("Fehler beim Erstellen von DPP %s: %v", dppID, err)
	    }
	    fmt.Printf("DPP %s für %s initialisiert.\n", dppID, manufacturerGLN)
	}
	*/
	return nil
}

/* func main() {
 	chaincode, err := contractapi.NewChaincode(&DPPQualityContract{})
 	if err != nil {
		fmt.Printf("Error creating DPPQuality chaincode: %s", err.Error())
		return
	}

	if err := chaincode.Start(); err != nil {
		fmt.Printf("Error starting DPPQuality chaincode: %s", err.Error())
	}
}
*/