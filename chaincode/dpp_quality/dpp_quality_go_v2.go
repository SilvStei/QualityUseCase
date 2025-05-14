/*
 * dpp_quality_gs1.go – Chaincode für Digital Product Pässe (DPP) mit GS1-ID
 * und EPCIS-Event-Modell. Stand: Mai 2025 – geeignet für Hyperledger Fabric 2.5
 *
 * Struktur:
 *   - DPP          : Basisdaten + Qualitätsblöcke + EPCIS-Events
 *   - QualityEntry : Ein einzelnes Testergebnis (Labor, QMS, Inline-Sensor)
 *   - EPCISEvent   : Abbild eines EPCIS 2.0 Object- oder TransformationEvents
 *
 * Kernfunktionen:
 *   CreateDPP()           – Rohprodukt/Charge anlegen (A, B)
 *   AddQualityData()      – Qualitätsinfo anhängen (beliebige Stufe)
 *   RecordTransformation() – Misch-/Compounding-Step (C)
 *   TransferDPP()         – Eigentümerwechsel entlang Supply-Chain
 *   QueryDPP()            – Einzelabfrage
 *
 * Die GS1-Schlüssel werden vom Client erzeugt (empfohlen: SGTIN oder LGTIN).
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
    EventID    string                 `json:"eventId"`
    EventType  string                 `json:"eventType"`  // ObjectEvent | TransformationEvent
    BizStep    string                 `json:"bizStep"`    // commissioning, compounding, shipping, etc.
    Timestamp  string                 `json:"timestamp"`
    Inputs     []string               `json:"inputs"`     // immer initialisiert
    Outputs    []string               `json:"outputs"`
    Extensions map[string]interface{} `json:"extensions"` // immer initialisiert
}

type DPP struct {
    DppID           string         `json:"dppId"`            // interne Ledger-ID (Key)
    GS1Key          string         `json:"gs1Key"`           // z. B. urn:epc:id:sgtin:4012345.012345.12345
    ManufacturerGLN string         `json:"manufacturerGln"`
    Batch           string         `json:"batch"`
    ProductionDate  string         `json:"productionDate"`   // ISO-Date
    OwnerOrg        string         `json:"ownerOrg"`
    Status          string         `json:"status"`           // Released / Blocked / Consumed / ...
    Quality         []QualityEntry `json:"quality"`
    InputLots       []string       `json:"inputLots"`        // immer initialisiert
    EPCISEvents     []EPCISEvent   `json:"epcisEvents"`
}

// --------------------------- Contract --------------------------- //

type DPPQualityContract struct {
    contractapi.Contract
}

const dppPrefix = "DPP-" // ledger-key = DPP-<dppId>

// --------------------------- Utils --------------------------- //

var gs1URNRegexp = regexp.MustCompile(`^urn:epc:id:sgtin:[0-9]+\.[0-9]+\.[0-9]+$`)

func validateGS1Key(gs1 string) error {
    if !gs1URNRegexp.MatchString(gs1) {
        return fmt.Errorf("ungültiger GS1-Schlüssel: %s", gs1)
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
        EPCISEvents: []EPCISEvent{{
            EventID:    fmt.Sprintf("evt-%s", time.Now().UTC().Format("20060102150405")),
            EventType:  "ObjectEvent",
            BizStep:    "commissioning",
            Timestamp:  time.Now().UTC().Format(time.RFC3339),
            Inputs:     []string{},
            Outputs:    []string{gs1Key},
            Extensions: map[string]interface{}{},
        }},
    }

    bytes, _ := json.Marshal(dpp)
    return ctx.GetStub().PutState(dppPrefix+dppID, bytes)
}

// AddQualityData fügt dem Pass ein neues Testergebnis hinzu.
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
func (c *DPPQualityContract) RecordTransformation(ctx contractapi.TransactionContextInterface, outputDppID, outputGS1Key, manufacturerGLN, batch, productionDate, inputJSON, qcJSON string) error {
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

    var inputs []string
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
    evt := EPCISEvent{
        EventID:    fmt.Sprintf("evt-%s", time.Now().UTC().Format("20060102150405")),
        EventType:  "TransformationEvent",
        BizStep:    "compounding",
        Timestamp:  time.Now().UTC().Format(time.RFC3339),
        Inputs:     inputs,
        Outputs:    []string{outputGS1Key},
        Extensions: map[string]interface{}{},
    }
    if qcJSON != "" {
        evt.Extensions["quality"] = qc
    }

    dpp := DPP{
        DppID:           outputDppID,
        GS1Key:          outputGS1Key,
        ManufacturerGLN: manufacturerGLN,
        Batch:           batch,
        ProductionDate:  productionDate,
        OwnerOrg:        msp,
        Status:          "Released",
        Quality:         []QualityEntry{},
        InputLots:       inputs,
        EPCISEvents:     []EPCISEvent{evt},
    }
    if qcJSON != "" {
        dpp.Quality = append(dpp.Quality, qc)
    }

    result, _ := json.Marshal(dpp)
    return ctx.GetStub().PutState(dppPrefix+outputDppID, result)
}

// TransferDPP ändert den Eigentümer und erzeugt EPCIS ObjectEvent shipping/receiving.
func (c *DPPQualityContract) TransferDPP(ctx contractapi.TransactionContextInterface, dppID, newOwner string) error {
    data, err := ctx.GetStub().GetState(dppPrefix + dppID)
    if err != nil {
        return err
    }
    if data == nil {
        return fmt.Errorf("DPP %s nicht gefunden", dppID)
    }
    var dpp DPP
    _ = json.Unmarshal(data, &dpp)

    if dpp.OwnerOrg == newOwner {
        return errors.New("neuer Eigentümer entspricht aktuellem Eigentümer")
    }

    shipEvt := EPCISEvent{
        EventID:    fmt.Sprintf("evt-%s", time.Now().UTC().Format("20060102150405")),
        EventType:  "ObjectEvent",
        BizStep:    "shipping",
        Timestamp:  time.Now().UTC().Format(time.RFC3339),
        Inputs:     []string{},
        Outputs:    []string{dpp.GS1Key},
        Extensions: map[string]interface{}{},
    }
    recvEvt := shipEvt
    recvEvt.EventID = shipEvt.EventID + "-recv"
    recvEvt.BizStep = "receiving"

    dpp.OwnerOrg = newOwner
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
