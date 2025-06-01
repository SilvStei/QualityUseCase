/*
 * dpp_quality_go_v2.go – Erweiterter Chaincode für Digital Product Pässe (DPP)
 * NEUESTE TESTVERSION V99 - DIES MUSS IM PAKET SEIN
 * Version mit "metadata:\",optional\""‑Tags, damit das Fabric SDK optionale Felder
 * im generierten JSON‑Schema nicht mehr als „required“ markiert.
 * Stand: Mai 2025 – geeignet für Hyperledger Fabric 2.5
 * ------------------------------------------------------------
 * Hinzugefügt: Debug-Logs und verbesserte Fehlerbehandlung in CreateDPP und RecordTransformation.
 */

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

// --------------------------- Datenstrukturen (Erweitert) --------------------------- //

type QualitySpecification struct {
	TestName      string  `json:"testName"`                                         // Eindeutiger Name des Tests
	IsNumeric     bool    `json:"isNumeric"`                                        // True, wenn das Ergebnis eine Zahl ist
	LowerLimit    float64 `json:"lowerLimit,omitempty"    metadata:",optional"`     // Untere Toleranzgrenze
	UpperLimit    float64 `json:"upperLimit,omitempty"    metadata:",optional"`     // Obere Toleranzgrenze
	ExpectedValue string  `json:"expectedValue,omitempty" metadata:",optional"`     // Erwarteter String-Wert
	Unit          string  `json:"unit,omitempty"          metadata:",optional"`     // Erwartete Einheit
	IsMandatory   bool    `json:"isMandatory"`                                      // Zwingend für Freigabe?
}

type QualityEntry struct {
	TestName          string `json:"testName"`
	Result            string `json:"result"`
	Unit              string `json:"unit"`
	SystemID          string `json:"systemId"`                                          // Quelle: LIMS, Sensor …
	Timestamp         string `json:"timestamp"`
	Responsible       string `json:"responsible"`
	PerformingOrg     string `json:"performingOrg"`
	OffChainDataRef   string `json:"offChainDataRef,omitempty"   metadata:",optional"`
	EvaluationOutcome string `json:"evaluationOutcome,omitempty" metadata:",optional"`
	EvaluationComment string `json:"evaluationComment,omitempty" metadata:",optional"`
}

type EPCISEvent struct {
	EventID             string                 `json:"eventId"`
	EventType           string                 `json:"eventType"`
	EventTime           string                 `json:"eventTime"`
	EventTimeZoneOffset string                 `json:"eventTimeZoneOffset"`
	BizStep             string                 `json:"bizStep"`
	Action              string                 `json:"action,omitempty"            metadata:",optional"`
	EPCList             []string               `json:"epcList,omitempty"           metadata:",optional"`
	Disposition         string                 `json:"disposition,omitempty"       metadata:",optional"`
	InputEPCList        []string               `json:"inputEPCList,omitempty"      metadata:",optional"`
	OutputEPCList       []string               `json:"outputEPCList,omitempty"     metadata:",optional"`
	ReadPoint           string                 `json:"readPoint,omitempty"         metadata:",optional"`
	BizLocation         string                 `json:"bizLocation,omitempty"       metadata:",optional"`
	Extensions          map[string]interface{} `json:"extensions"` // immer vorhanden
}

type DPP struct {
	DppID               string                 `json:"dppId"`
	GS1Key              string                 `json:"gs1Key"`
	ProductTypeID       string                 `json:"productTypeId,omitempty"     metadata:",optional"`
	ManufacturerGLN     string                 `json:"manufacturerGln"`
	Batch               string                 `json:"batch"`
	ProductionDate      string                 `json:"productionDate"`
	OwnerOrg            string                 `json:"ownerOrg"`
	Status              string                 `json:"status"`
	Specifications      []QualitySpecification `json:"specifications,omitempty"      metadata:",optional"`
	OpenMandatoryChecks []string               `json:"openMandatoryChecks,omitempty" metadata:",optional"`
	Quality             []QualityEntry         `json:"quality"`
	InputDPPIDs         []string               `json:"inputDppIds,omitempty"         metadata:",optional"`
	EPCISEvents         []EPCISEvent           `json:"epcisEvents"`
}

// --------------------------- Contract --------------------------- //

type DPPQualityContract struct {
	contractapi.Contract
}

const dppPrefix = "DPP-"

// --------------------------- Utils --------------------------- //

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

func tzOffset() string { return time.Now().Format("-07:00") }

func sgln(gln string) string {
	if gln == "" {
		return ""
	}
	return "urn:epc:id:sgln:" + gln + ".0.0"
}

// --------------------------- recalculateOverallStatus --------------------------- //

func (dpp *DPP) recalculateOverallStatus() {
	if dpp.Status == "Blocked" ||
		strings.HasPrefix(dpp.Status, "ConsumedInTransformation") ||
		strings.HasPrefix(dpp.Status, "RejectedBy") ||
		strings.HasPrefix(dpp.Status, "InTransitTo") ||
		dpp.Status == "AcceptedAtRecipient" {
		return
	}

	hasCriticalFailures := false
	hasDeviations := false

	for _, qe := range dpp.Quality {
		if qe.EvaluationOutcome == "FAIL" || qe.EvaluationOutcome == "INVALID_FORMAT" {
			hasCriticalFailures = true
			break
		}
		if strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") {
			hasDeviations = true
		}
	}

	if hasCriticalFailures {
		dpp.Status = "Blocked"
		return
	}

	if len(dpp.OpenMandatoryChecks) == 0 {
		if hasDeviations {
			dpp.Status = "ReleasedWithDeviations"
		} else {
			dpp.Status = "Released"
		}
	} else {
		dpp.Status = fmt.Sprintf("AwaitingMandatoryChecks (%d open)", len(dpp.OpenMandatoryChecks))
	}
}

// --------------------------- Chaincode-APIs (Überarbeitet und Erweitert) --------------------------- //

// CreateDPP: Legt einen neuen DPP an, initialisiert mit Spezifikationen.
// ÄNDERUNG: Gibt jetzt (*DPP, error) zurück
func (c *DPPQualityContract) CreateDPP(ctx contractapi.TransactionContextInterface, dppID, gs1Key, productTypeID, manufacturerGLN, batch, productionDate string, specificationsJSON string) (*DPP, error) { // <-- Geänderter Rückgabetyp
    fmt.Printf("[CreateDPP-DEBUG] Entry: dppID=%s, gs1Key=%s, productTypeID=%s, manufacturerGLN=%s, batch=%s, productionDate=%s\n", dppID, gs1Key, productTypeID, manufacturerGLN, batch, productionDate)

    exists, err := c.dppExists(ctx, dppID)
    if err != nil {
        fmt.Printf("[CreateDPP-ERROR] Fehler bei dppExists für DPP %s: %v\n", dppID, err)
        return nil, err // <-- Geänderte Rückgabe
    }
    if exists {
        fmt.Printf("[CreateDPP-ERROR] DPP %s existiert bereits.\n", dppID)
        return nil, fmt.Errorf("DPP %s existiert bereits", dppID) // <-- Geänderte Rückgabe
    }
    if err := validateGS1Key(gs1Key); err != nil {
        fmt.Printf("[CreateDPP-ERROR] Ungültiger GS1 Key %s: %v\n", gs1Key, err)
        return nil, err // <-- Geänderte Rückgabe
    }

    var specs []QualitySpecification
    if specificationsJSON != "" {
        if err := json.Unmarshal([]byte(specificationsJSON), &specs); err != nil {
            fmt.Printf("[CreateDPP-ERROR] Spezifikationen JSON fehlerhaft für DPP %s: %v\n", dppID, err)
            return nil, fmt.Errorf("Spezifikationen JSON fehlerhaft: %v", err) // <-- Geänderte Rückgabe
        }
    }

    var openMandatory []string
    for _, s := range specs {
        if s.IsMandatory {
            openMandatory = append(openMandatory, s.TestName)
        }
    }

    clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
    if errClientMSPID != nil {
        fmt.Printf("[CreateDPP-ERROR] Fehler beim Ermitteln der Client MSPID: %v\n", errClientMSPID)
        return nil, fmt.Errorf("Fehler beim Ermitteln der Client MSPID: %v", errClientMSPID) // <-- Geänderte Rückgabe
    }
    now := time.Now()
    initialStatus := "Draft"

    evt := EPCISEvent{
        EventID:             fmt.Sprintf("evt-create-%d", now.UnixNano()),
        EventType:           "ObjectEvent",
        EventTime:           now.UTC().Format(time.RFC3339),
        EventTimeZoneOffset: tzOffset(),
        BizStep:             "urn:epcglobal:cbv:bizstep:commissioning",
        Action:              "ADD",
        EPCList:             []string{gs1Key},
        Disposition:         "urn:epcglobal:cbv:disp:active",
        ReadPoint:           sgln(manufacturerGLN),
        BizLocation:         sgln(manufacturerGLN),
        Extensions:          make(map[string]interface{}),
    }

    dpp := DPP{ // Erzeuge das DPP-Objekt
        DppID:               dppID,
        GS1Key:              gs1Key,
        ProductTypeID:       productTypeID,
        ManufacturerGLN:     manufacturerGLN, // Dies wird currentGLN aus RecordTransformation sein
        Batch:               batch,
        ProductionDate:      productionDate,
        OwnerOrg:            clientMSPID,    // Der Aufrufer von CreateDPP, also Unternehmen C
        Status:              initialStatus,
        Specifications:      specs,
        OpenMandatoryChecks: openMandatory,
        Quality:             []QualityEntry{},
        InputDPPIDs:         []string{},
        EPCISEvents:         []EPCISEvent{evt},
    }

    dpp.recalculateOverallStatus() // Status anpassen

    dppBytes, errMarshal := json.Marshal(dpp)
    if errMarshal != nil {
        fmt.Printf("[CreateDPP-ERROR] Fehler beim Marshalling von DPP %s: %v\n", dppID, errMarshal)
        return nil, fmt.Errorf("Fehler beim Marshalling von DPP %s: %v", dppID, errMarshal) // <-- Geänderte Rückgabe
    }
    logKey := dppPrefix + dppID

    logBytesSample := string(dppBytes)
    if len(logBytesSample) > 200 { logBytesSample = logBytesSample[:200] + "..." }
    fmt.Printf("[CreateDPP-DEBUG] Vor PutState für Key: %s, DPP JSON (Ausschnitt): %s\n", logKey, logBytesSample)

    errPut := ctx.GetStub().PutState(logKey, dppBytes)
    if errPut != nil {
        fmt.Printf("[CreateDPP-ERROR] PutState für Key %s fehlgeschlagen: %v\n", logKey, errPut)
        return nil, errPut // <-- Geänderte Rückgabe
    }
    fmt.Printf("[CreateDPP-DEBUG] PutState für Key %s anscheinend erfolgreich.\n", logKey)
    return &dpp, nil // <-- Geänderte Rückgabe: Gib das erstellte Objekt und nil Fehler zurück
}

// RecordQualityData: Erfasst Qualitätsdaten, bewertet sie gegen Spezifikationen und aktualisiert den DPP-Status.
// Erzeugt ein EPCIS Event für die Qualitätsprüfung.
func (c *DPPQualityContract) RecordQualityData(ctx contractapi.TransactionContextInterface, dppID string, qualityEntryJSON string, recordingSiteGLN string) error {
	dppBytes, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return err
	}
	if dppBytes == nil {
		return fmt.Errorf("DPP %s nicht gefunden", dppID)
	}

	var dpp DPP
	if err := json.Unmarshal(dppBytes, &dpp); err != nil {
		return fmt.Errorf("Fehler beim Unmarshalling von DPP %s: %v", dppID, err)
	}

	var qe QualityEntry
	if err := json.Unmarshal([]byte(qualityEntryJSON), &qe); err != nil {
		return fmt.Errorf("QualityEntry JSON fehlerhaft: %v", err)
	}

	if qe.Timestamp == "" {
		qe.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	if qe.PerformingOrg == "" {
		clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
		if errClientMSPID != nil {
			return fmt.Errorf("Fehler beim Ermitteln der Client MSPID für QualityEntry: %v", errClientMSPID)
		}
		qe.PerformingOrg = clientMSPID
	}

	qe.EvaluationOutcome = "NO_SPEC"
	qe.EvaluationComment = ""
	var currentSpec *QualitySpecification
	for i := range dpp.Specifications {
		if dpp.Specifications[i].TestName == qe.TestName {
			currentSpec = &dpp.Specifications[i]
			break
		}
	}

	if currentSpec != nil {
		if currentSpec.IsNumeric {
			resultVal, convErr := strconv.ParseFloat(qe.Result, 64)
			if convErr != nil {
				qe.EvaluationOutcome = "INVALID_FORMAT"
				qe.EvaluationComment = fmt.Sprintf("Ergebnis '%s' für Test '%s' ist nicht numerisch.", qe.Result, qe.TestName)
			} else {
				if resultVal < currentSpec.LowerLimit {
					qe.EvaluationOutcome = "DEVIATION_LOW"
					qe.EvaluationComment = fmt.Sprintf("Wert %.4f unter Grenzwert %.4f %s.", resultVal, currentSpec.LowerLimit, currentSpec.Unit)
				} else if resultVal > currentSpec.UpperLimit {
					qe.EvaluationOutcome = "DEVIATION_HIGH"
					qe.EvaluationComment = fmt.Sprintf("Wert %.4f über Grenzwert %.4f %s.", resultVal, currentSpec.UpperLimit, currentSpec.Unit)
				} else {
					qe.EvaluationOutcome = "PASS"
				}
			}
		} else { // String-basierter Test
			if strings.EqualFold(qe.Result, currentSpec.ExpectedValue) {
				qe.EvaluationOutcome = "PASS"
			} else {
				qe.EvaluationOutcome = "FAIL"
				qe.EvaluationComment = fmt.Sprintf("Erwartet: '%s', Erhalten: '%s'.", currentSpec.ExpectedValue, qe.Result)
			}
		}
		if currentSpec.Unit != "" && qe.Unit != "" && !strings.EqualFold(currentSpec.Unit, qe.Unit) {
			qe.EvaluationComment += fmt.Sprintf(" Einheit für '%s' passt nicht: Spezifikation '%s', Eintrag '%s'.", qe.TestName, currentSpec.Unit, qe.Unit)
		}
	} else if qe.TestName != "" {
		qe.EvaluationComment = fmt.Sprintf("Keine Spezifikation für Test '%s' im DPP hinterlegt. Daten werden als informativ gespeichert.", qe.TestName)
	}

	dpp.Quality = append(dpp.Quality, qe)

	now := time.Now()
	epcisDisposition := "urn:epcglobal:cbv:disp:active"
	if qe.EvaluationOutcome == "PASS" {
		epcisDisposition = "urn:epcglobal:cbv:disp:conformant"
	} else if strings.HasPrefix(qe.EvaluationOutcome, "FAIL") || strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") || qe.EvaluationOutcome == "INVALID_FORMAT" {
		epcisDisposition = "urn:epcglobal:cbv:disp:non_conformant"
	}

	qcEvent := EPCISEvent{
		EventID:             fmt.Sprintf("evt-qc-%s-%d", strings.ReplaceAll(strings.ReplaceAll(qe.TestName, " ", "_"), "/", "_"), now.UnixNano()),
		EventType:           "ObjectEvent",
		EventTime:           now.UTC().Format(time.RFC3339),
		EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:inspecting",
		Action:              "OBSERVE",
		EPCList:             []string{dpp.GS1Key},
		Disposition:         epcisDisposition,
		ReadPoint:           sgln(recordingSiteGLN),
		BizLocation:         sgln(recordingSiteGLN),
		Extensions:          map[string]interface{}{"recordedQualityData": qe},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, qcEvent)

	if currentSpec != nil && currentSpec.IsMandatory && qe.EvaluationOutcome == "PASS" {
		var newOpenChecks []string
		for _, checkName := range dpp.OpenMandatoryChecks {
			if checkName != qe.TestName {
				newOpenChecks = append(newOpenChecks, checkName)
			}
		}
		dpp.OpenMandatoryChecks = newOpenChecks
	}
	dpp.recalculateOverallStatus()

	if qe.EvaluationOutcome == "FAIL" || strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") || qe.EvaluationOutcome == "INVALID_FORMAT" {
		alertPayload := map[string]interface{}{
			"dppId":             dppID,
			"gs1Key":            dpp.GS1Key,
			"batch":             dpp.Batch,
			"productTypeId":     dpp.ProductTypeID,
			"testName":          qe.TestName,
			"result":            qe.Result,
			"evaluationOutcome": qe.EvaluationOutcome,
			"evaluationComment": qe.EvaluationComment,
			"timestamp":         qe.Timestamp,
			"systemId":          qe.SystemID,
			"performingOrg":     qe.PerformingOrg,
		}
		alertBytes, _ := json.Marshal(alertPayload)
		ctx.GetStub().SetEvent("QualityAlert", alertBytes)
	}

	updatedDppBytes, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppBytes)
}

// RecordTransformation: Erstellt neuen DPP für Compound (C), verknüpft Inputs (A,B)
func (c *DPPQualityContract) RecordTransformation(ctx contractapi.TransactionContextInterface,
    outputDppID, outputGS1Key, outputProductTypeID string, // Für neuen DPP von C
    currentGLN string, // GLN von Unternehmen C (Ort der Transformation)
    batch, productionDate string, // Für neuen DPP von C
    inputDPPIDsJSON string, // JSON Array der Ledger-IDs der Input-DPPs (von A, B)
    outputSpecificationsJSON string, // Spezifikationen für das Compound-Produkt
    initialQualityEntryJSON string) error { // Optionale initiale Q-Prüfung des Compounds

    fmt.Printf("[RecordTransformation-DEBUG] Entry: outputDppID=%s, outputGS1Key=%s, outputProductTypeID=%s, currentGLN=%s, batch=%s, productionDate=%s\n", outputDppID, outputGS1Key, outputProductTypeID, currentGLN, batch, productionDate)

    // MINITEST kann jetzt entfernt oder auskommentiert werden, da das Problem identifiziert ist.
    // Ich lasse ihn hier auskommentiert, falls du ihn später nochmal brauchst.
    /*
    testKey := "TEST_KEY_123"
    testValue := []byte("test value for RecordTransformation") 
    fmt.Printf("[RecordTransformation-MINITEST] Versuche PutState für Key: '%s', Wert: '%s'\n", testKey, string(testValue))
    errTestPut := ctx.GetStub().PutState(testKey, testValue)
    if errTestPut != nil {
        fmt.Printf("[RecordTransformation-MINITEST-ERROR] PutState für Key '%s' ist FEHLGESCHLAGEN: %v\n", testKey, errTestPut)
        return fmt.Errorf("Minitest PutState für Key '%s' ist FEHLGESCHLAGEN: %v", testKey, errTestPut)
    }
    fmt.Printf("[RecordTransformation-MINITEST] PutState für Key '%s' war erfolgreich (errTestPut war nil).\n", testKey)
    retrievedValue, errTestGet := ctx.GetStub().GetState(testKey)
    if errTestGet != nil {
        fmt.Printf("[RecordTransformation-MINITEST-ERROR] GetState für Key '%s' gab einen FEHLER zurück: %v\n", testKey, errTestGet)
        return fmt.Errorf("Minitest GetState für Key '%s' gab einen FEHLER zurück: %v", testKey, errTestGet)
    }
    if retrievedValue == nil {
        fmt.Printf("[RecordTransformation-MINITEST-ERROR] GetState für Key '%s' lieferte nil!\n", testKey)
        return fmt.Errorf("Minitest GetState für Key '%s' lieferte nil", testKey)
    }
    fmt.Printf("[RecordTransformation-MINITEST] GetState für Key '%s' erfolgreich. Wert als String: '%s'\n", testKey, string(retrievedValue))
    if string(retrievedValue) != string(testValue) {
        fmt.Printf("[RecordTransformation-MINITEST-ERROR] GetState Wert '%s' stimmt NICHT mit PutState Wert '%s' überein!\n", string(retrievedValue), string(testValue))
        return fmt.Errorf("Minitest GetState Wert ('%s') stimmt nicht mit PutState Wert ('%s') überein", string(retrievedValue), string(testValue))
    }
    fmt.Printf("[RecordTransformation-MINITEST] GetState Wert für Key '%s' stimmt mit PutState Wert überein. MINITEST ERFOLGREICH.\n", testKey)
    */

    fmt.Printf("[RecordTransformation-DEBUG] inputDPPIDsJSON: %s\n", inputDPPIDsJSON)
    // ... (Validierungen für outputDppID, outputGS1Key etc. bleiben gleich) ...
    exists, err := c.dppExists(ctx, outputDppID) // dppExists prüft ja den World State, das ist OK.
    if err != nil {
        fmt.Printf("[RecordTransformation-ERROR] Fehler bei dppExists für OutputDPP %s: %v\n", outputDppID, err)
        return fmt.Errorf("Fehler bei dppExists für OutputDPP %s: %v", outputDppID, err)
    }
    if exists { // Sollte nicht passieren, wenn CreateDPP intern auch prüft, aber sicher ist sicher.
        fmt.Printf("[RecordTransformation-ERROR] Output DPP %s existiert bereits (geprüft vor CreateDPP).\n", outputDppID)
        return fmt.Errorf("Output DPP %s existiert bereits (geprüft vor CreateDPP)", outputDppID)
    }
    if err := validateGS1Key(outputGS1Key); err != nil {
        fmt.Printf("[RecordTransformation-ERROR] Ungültiger GS1 Key %s für OutputDPP: %v\n", outputGS1Key, err)
        return fmt.Errorf("Ungültiger GS1 Key '%s' für OutputDPP: %v", outputGS1Key, err)
    }


    var inputDPPIDs []string
    if err := json.Unmarshal([]byte(inputDPPIDsJSON), &inputDPPIDs); err != nil {
        fmt.Printf("[RecordTransformation-ERROR] inputDPPIDsJSON (Array von DPP IDs) ungültig: %v. JSON war: %s\n", err, inputDPPIDsJSON)
        return fmt.Errorf("inputDPPIDsJSON (Array von DPP IDs) ungültig: %v", err)
    }
    fmt.Printf("[RecordTransformation-DEBUG] Parsed inputDPPIDs: %v\n", inputDPPIDs)

    var inputGS1KeysForEvent []string
    for _, inputID := range inputDPPIDs {
        // ... (Logik zum Verarbeiten und Aktualisieren der Input-DPPs bleibt gleich) ...
         fmt.Printf("[RecordTransformation-DEBUG] Verarbeite InputDPP ID: %s\n", inputID)
	    inputDppBytes, errGet := ctx.GetStub().GetState(dppPrefix + inputID)
	    if errGet != nil {
	        fmt.Printf("[RecordTransformation-ERROR] Fehler beim Lesen von Input-DPP %s: %v\n", inputID, errGet)
	        return fmt.Errorf("Fehler beim Lesen von Input-DPP %s: %v", inputID, errGet)
	    }
	    if inputDppBytes == nil {
	        fmt.Printf("[RecordTransformation-ERROR] Input-DPP %s nicht gefunden.\n", inputID)
	        return fmt.Errorf("Input-DPP %s nicht gefunden", inputID)
	    }
	    var inputDPP DPP
	    if errUnmarshalInput := json.Unmarshal(inputDppBytes, &inputDPP); errUnmarshalInput != nil {
	        fmt.Printf("[RecordTransformation-ERROR] Fehler beim Unmarshalling von Input-DPP %s: %v\n", inputID, errUnmarshalInput)
	        return fmt.Errorf("Fehler beim Unmarshalling von Input-DPP %s: %v", inputID, errUnmarshalInput)
	    }

	    if inputDPP.Status != "Released" && inputDPP.Status != "ReleasedWithDeviations" && inputDPP.Status != "AcceptedAtRecipient" {
	        msg := fmt.Sprintf("Input DPP %s (GS1 %s) hat ungültigen Status '%s' für Transformation. Erlaubt sind 'Released', 'ReleasedWithDeviations', 'AcceptedAtRecipient'.", inputID, inputDPP.GS1Key, inputDPP.Status)
	        fmt.Printf("[RecordTransformation-ERROR] %s\n", msg)
	        fmt.Printf("[RecordTransformation-WARN] Transformation wird trotz Status '%s' durchgeführt (ursprüngliche Logik beibehalten).\n", inputDPP.Status)
	    }
	    inputGS1KeysForEvent = append(inputGS1KeysForEvent, inputDPP.GS1Key)

	    inputDPP.Status = fmt.Sprintf("ConsumedInTransformation_%s", outputDppID)
	    updatedInputBytes, errMarshalInput := json.Marshal(inputDPP)
	    if errMarshalInput != nil {
	        fmt.Printf("[RecordTransformation-ERROR] Fehler beim Marshalling des aktualisierten Input-DPP %s: %v\n", inputID, errMarshalInput)
	        return fmt.Errorf("Fehler beim Marshalling des aktualisierten Input-DPP %s: %v", inputID, errMarshalInput)
	    }
	    if errPutInput := ctx.GetStub().PutState(dppPrefix+inputID, updatedInputBytes); errPutInput != nil {
	        fmt.Printf("[RecordTransformation-ERROR] Fehler beim Aktualisieren des Input-DPP %s: %v\n", inputID, errPutInput)
	        return fmt.Errorf("Fehler beim Aktualisieren des Input-DPP %s: %v", inputID, errPutInput)
	    }
	    fmt.Printf("[RecordTransformation-DEBUG] InputDPP ID %s als 'ConsumedInTransformation_%s' markiert und gespeichert.\n", inputID, outputDppID)
    }

    fmt.Printf("[RecordTransformation-DEBUG] Rufe modifiziertes CreateDPP auf für outputDppID: %s\n", outputDppID)
    // HIER DIE ÄNDERUNG: outputDPP ist jetzt das direkt zurückgegebene Objekt
    outputDPP, errCreate := c.CreateDPP(ctx, outputDppID, outputGS1Key, outputProductTypeID, currentGLN, batch, productionDate, outputSpecificationsJSON)
    if errCreate != nil {
        fmt.Printf("[RecordTransformation-ERROR] CreateDPP für outputDppID %s ist fehlgeschlagen: %v\n", outputDppID, errCreate)
        // Wichtig: Da CreateDPP bei Fehlern nil zurückgibt, müssen wir hier abbrechen.
        return fmt.Errorf("Fehler beim Erstellen des Output-DPP %s via CreateDPP: %v", outputDppID, errCreate)
    }
    if outputDPP == nil { // Zusätzliche Sicherheitsprüfung
         fmt.Printf("[RecordTransformation-ERROR] CreateDPP lieferte nil für outputDPP %s zurück, obwohl kein Fehler gemeldet wurde. Das sollte nicht passieren.\n", outputDppID)
         return fmt.Errorf("CreateDPP lieferte unerwartet nil für DPP %s", outputDppID)
    }
    fmt.Printf("[RecordTransformation-DEBUG] CreateDPP für outputDppID %s erfolgreich. outputDPP Objekt im Speicher vorhanden. OwnerOrg: %s\n", outputDppID, outputDPP.OwnerOrg)

    // Jetzt outputDPP direkt modifizieren (das Objekt, das von CreateDPP zurückgegeben wurde)
    outputDPP.InputDPPIDs = inputDPPIDs

    now := time.Now() // 'now' neu definieren oder die von CreateDPP verwenden, je nach Bedarf
    tfEvent := EPCISEvent{
        EventID:             fmt.Sprintf("evt-tf-%s-%d", strings.ReplaceAll(outputGS1Key, ":", "_"), now.UnixNano()),
        EventType:           "TransformationEvent",
        EventTime:           now.UTC().Format(time.RFC3339),
        EventTimeZoneOffset: tzOffset(),
        BizStep:             "urn:epcglobal:cbv:bizstep:transforming",
        InputEPCList:        inputGS1KeysForEvent,
        OutputEPCList:       []string{outputGS1Key},
        ReadPoint:           sgln(currentGLN),
        BizLocation:         sgln(currentGLN),
        Extensions:          make(map[string]interface{}),
    }

    // InitialQualityEntry verarbeiten (Logik bleibt im Wesentlichen gleich, arbeitet jetzt auf outputDPP)
    if initialQualityEntryJSON != "" && initialQualityEntryJSON != "{}" {
         var initialQE QualityEntry
	    if errQE := json.Unmarshal([]byte(initialQualityEntryJSON), &initialQE); errQE == nil {
	        if initialQE.Timestamp == "" { initialQE.Timestamp = now.UTC().Format(time.RFC3339) }
	        if initialQE.PerformingOrg == "" {
	            clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	            if errClientMSPID != nil {
	                fmt.Printf("[RecordTransformation-ERROR] Fehler beim Ermitteln der Client MSPID für initialQE: %v\n", errClientMSPID)
	                return fmt.Errorf("Fehler beim Ermitteln der Client MSPID für initialQE: %v", errClientMSPID)
	            }
	            initialQE.PerformingOrg = clientMSPID
	        }
	        tfEvent.Extensions["initialCompoundQuality"] = initialQE
	        fmt.Printf("[RecordTransformation-DEBUG] InitialQE für Extension vorbereitet: %+v\n", initialQE)

	        initialQE.EvaluationOutcome = "NO_SPEC"
	        initialQE.EvaluationComment = ""
	        var currentSpecForInitialQE *QualitySpecification
	        for i := range outputDPP.Specifications {
	            if outputDPP.Specifications[i].TestName == initialQE.TestName {
	                currentSpecForInitialQE = &outputDPP.Specifications[i]
	                break
	            }
	        }
	        if currentSpecForInitialQE != nil {
	            if currentSpecForInitialQE.IsNumeric {
	                // ... (Rest der numerischen Bewertung)
                    resVal, convErr := strconv.ParseFloat(initialQE.Result, 64)
                    if convErr != nil {
                        initialQE.EvaluationOutcome = "INVALID_FORMAT"
                        initialQE.EvaluationComment = fmt.Sprintf("Initiales Ergebnis '%s' für Test '%s' ist nicht numerisch.", initialQE.Result, initialQE.TestName)
                    } else {
                        if resVal < currentSpecForInitialQE.LowerLimit {
                            initialQE.EvaluationOutcome = "DEVIATION_LOW_INITIAL"
                            initialQE.EvaluationComment = fmt.Sprintf("Initialer Wert %.4f unter Grenzwert %.4f %s.", resVal, currentSpecForInitialQE.LowerLimit, currentSpecForInitialQE.Unit)
                        } else if resVal > currentSpecForInitialQE.UpperLimit {
                            initialQE.EvaluationOutcome = "DEVIATION_HIGH_INITIAL"
                            initialQE.EvaluationComment = fmt.Sprintf("Initialer Wert %.4f über Grenzwert %.4f %s.", resVal, currentSpecForInitialQE.UpperLimit, currentSpecForInitialQE.Unit)
                        } else {
                            initialQE.EvaluationOutcome = "PASS"
                        }
                    }
	            } else {
	                // ... (Rest der String-Bewertung)
                    if strings.EqualFold(initialQE.Result, currentSpecForInitialQE.ExpectedValue) {
                        initialQE.EvaluationOutcome = "PASS"
                    } else {
                        initialQE.EvaluationOutcome = "FAIL_INITIAL"
                        initialQE.EvaluationComment = fmt.Sprintf("Initial erwartet: '%s', Erhalten: '%s'.", currentSpecForInitialQE.ExpectedValue, initialQE.Result)
                    }
	            }
                 if currentSpecForInitialQE.Unit != "" && initialQE.Unit != "" && !strings.EqualFold(currentSpecForInitialQE.Unit, initialQE.Unit) {
	                initialQE.EvaluationComment += fmt.Sprintf(" Einheit für initialen Test '%s' passt nicht: Spezifikation '%s', Eintrag '%s'.", initialQE.TestName, currentSpecForInitialQE.Unit, initialQE.Unit)
	            }
	        } else if initialQE.TestName != "" {
	             initialQE.EvaluationComment = fmt.Sprintf("Keine Spezifikation für initialen Test '%s' im Compound-DPP hinterlegt. Daten als informativ gespeichert.", initialQE.TestName)
	        }
	        outputDPP.Quality = append(outputDPP.Quality, initialQE)
	        fmt.Printf("[RecordTransformation-DEBUG] InitialQE zu outputDPP.Quality hinzugefügt: %+v\n", initialQE)

	        if currentSpecForInitialQE != nil && currentSpecForInitialQE.IsMandatory && initialQE.EvaluationOutcome == "PASS" {
	            var newOpenChecks []string
	            for _, checkName := range outputDPP.OpenMandatoryChecks {
	                if checkName != initialQE.TestName {
	                    newOpenChecks = append(newOpenChecks, checkName)
	                }
	            }
	            outputDPP.OpenMandatoryChecks = newOpenChecks
	            fmt.Printf("[RecordTransformation-DEBUG] OpenMandatoryChecks nach initialQE aktualisiert: %v\n", newOpenChecks)
	        }
	    } else {
	        fmt.Printf("[RecordTransformation-WARN] initialQualityEntryJSON ('%s') fehlerhaft und wird ignoriert: %v\n", initialQualityEntryJSON, errQE)
	    }
    } else {
        if outputDPP.Quality == nil { outputDPP.Quality = []QualityEntry{} }
         fmt.Printf("[RecordTransformation-DEBUG] Keine initialQualityEntryJSON vorhanden oder leer.\n")
    }

    outputDPP.EPCISEvents = append(outputDPP.EPCISEvents, tfEvent)
    outputDPP.recalculateOverallStatus() // Status basierend auf initialen Checks und Qualität
    fmt.Printf("[RecordTransformation-DEBUG] Status des Output-DPP %s nach recalculateOverallStatus: %s\n", outputDppID, outputDPP.Status)

    // Finalen Output-DPP speichern (dies ist jetzt der einzige PutState für den outputDPP in dieser Funktion)
    finalOutputDppBytes, errMarshalFinal := json.Marshal(outputDPP)
    if errMarshalFinal != nil {
        fmt.Printf("[RecordTransformation-ERROR] Fehler beim finalen Marshalling von OutputDPP %s: %v\n", outputDppID, errMarshalFinal)
        return fmt.Errorf("Fehler beim finalen Marshalling von OutputDPP %s: %v", outputDppID, errMarshalFinal)
    }

    targetKey := dppPrefix + outputDppID // targetKey hier definieren für den Log
    logFinalBytesSample := string(finalOutputDppBytes)
    if len(logFinalBytesSample) > 300 { logFinalBytesSample = logFinalBytesSample[:300] + "..." }
    fmt.Printf("[RecordTransformation-DEBUG] Vor finalem PutState für Key: %s, OutputDPP JSON (Ausschnitt): %s\n", targetKey, logFinalBytesSample)

    errPutFinal := ctx.GetStub().PutState(targetKey, finalOutputDppBytes)
    if errPutFinal != nil {
        fmt.Printf("[RecordTransformation-ERROR] Finales PutState für Output-DPP %s (Key: %s) fehlgeschlagen: %v\n", outputDppID, targetKey, errPutFinal)
        return fmt.Errorf("Finales PutState für Output-DPP %s fehlgeschlagen: %v", outputDppID, errPutFinal)
    }

    fmt.Printf("[RecordTransformation-INFO] RecordTransformation für OutputDPP %s erfolgreich abgeschlossen.\n", outputDppID)
    return nil
}

// TransferDPP: Unternehmen C übergibt den Compound-DPP an D
func (c *DPPQualityContract) TransferDPP(ctx contractapi.TransactionContextInterface, dppID, newOwnerMSP, shipperGLN string) error {
	dppBytes, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return err
	}
	if dppBytes == nil {
		return fmt.Errorf("DPP %s nicht gefunden", dppID)
	}
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppBytes, &dpp); errUnmarshal != nil {
		return fmt.Errorf("Fehler beim Unmarshalling von DPP %s für Transfer: %v", dppID, errUnmarshal)
	}

	currentOwnerMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil {
		return fmt.Errorf("Fehler beim Ermitteln der Client MSPID für Transfer: %v", errClientMSPID)
	}
	if dpp.OwnerOrg != currentOwnerMSPID {
		return fmt.Errorf("Nur der aktuelle Eigentümer (%s) darf DPP %s transferieren. Aufrufer ist %s.", dpp.OwnerOrg, dppID, currentOwnerMSPID)
	}
	if dpp.OwnerOrg == newOwnerMSP {
		return errors.New("neuer Eigentümer ist identisch mit aktuellem Eigentümer")
	}

	if dpp.Status != "Released" && dpp.Status != "ReleasedWithDeviations" {
		return fmt.Errorf("DPP %s (Status: %s) ist nicht für den Transfer freigegeben.", dppID, dpp.Status)
	}

	now := time.Now()
	shipEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-ship-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent",
		EventTime:           now.UTC().Format(time.RFC3339),
		EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:shipping",
		Action:              "OBSERVE",
		EPCList:             []string{dpp.GS1Key},
		Disposition:         "urn:epcglobal:cbv:disp:in_transit",
		ReadPoint:           sgln(shipperGLN),
		BizLocation:         "", // Leer, da unterwegs
		Extensions:          map[string]interface{}{"intendedRecipientMSP": newOwnerMSP},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, shipEvt)
	dpp.OwnerOrg = newOwnerMSP
	dpp.Status = fmt.Sprintf("InTransitTo_%s", newOwnerMSP)

	updatedDppBytes, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppBytes)
}

// AcknowledgeReceiptAndRecordInspection: Unternehmen D bestätigt Empfang und führt ggf. Eingangsprüfung durch.
func (c *DPPQualityContract) AcknowledgeReceiptAndRecordInspection(ctx contractapi.TransactionContextInterface, dppID, recipientGLN string, incomingInspectionJSON string) error {
	dppBytes, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return err
	}
	if dppBytes == nil {
		return fmt.Errorf("DPP %s nicht gefunden", dppID)
	}
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppBytes, &dpp); errUnmarshal != nil {
		return fmt.Errorf("Fehler beim Unmarshalling von DPP %s für Acknowledge: %v", dppID, errUnmarshal)
	}

	recipientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil {
		return fmt.Errorf("Fehler beim Ermitteln der Client MSPID für Acknowledge: %v", errClientMSPID)
	}

	expectedStatus := "InTransitTo_" + recipientMSPID
	if dpp.OwnerOrg != recipientMSPID || dpp.Status != expectedStatus {
		return fmt.Errorf("DPP %s ist nicht für Empfang durch %s vorgesehen oder hat falschen Status/Owner (Status: %s, Owner: %s, Erwartet Status: %s, Erwartet Owner: %s)", dppID, recipientMSPID, dpp.Status, dpp.OwnerOrg, expectedStatus, recipientMSPID)
	}

	dpp.Status = "AcceptedAtRecipient"
	ackDisposition := "urn:epcglobal:cbv:disp:in_possession"

	now := time.Now()
	ackEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-recv-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent",
		EventTime:           now.UTC().Format(time.RFC3339),
		EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:receiving",
		Action:              "ADD",
		EPCList:             []string{dpp.GS1Key},
		Disposition:         ackDisposition,
		ReadPoint:           sgln(recipientGLN),
		BizLocation:         sgln(recipientGLN),
		Extensions:          make(map[string]interface{}),
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, ackEvt)

	if incomingInspectionJSON != "" {
		var inspQE QualityEntry
		if errQE := json.Unmarshal([]byte(incomingInspectionJSON), &inspQE); errQE != nil {
			fmt.Printf("[Acknowledge-WARN] incomingInspectionJSON für DPP %s fehlerhaft, wird ignoriert: %v\n", dppID, errQE)
		} else {
			if inspQE.Timestamp == "" {
				inspQE.Timestamp = time.Now().UTC().Format(time.RFC3339)
			}
			if inspQE.PerformingOrg == "" {
				// Bereits durch recipientMSPID oben ermittelt
				inspQE.PerformingOrg = recipientMSPID
			}
			inspQE.EvaluationOutcome = "INCOMING_INSPECTION_DATA" // Beispiel, könnte auch bewertet werden
			dpp.Quality = append(dpp.Quality, inspQE)

			inspTime := time.Now()
			inspEvent := EPCISEvent{
				EventID:             fmt.Sprintf("evt-insp-%s-%s-%d", recipientMSPID, strings.ReplaceAll(dpp.GS1Key, ":", "_"), inspTime.UnixNano()),
				EventType:           "ObjectEvent",
				EventTime:           inspTime.UTC().Format(time.RFC3339),
				EventTimeZoneOffset: tzOffset(),
				BizStep:             "urn:epcglobal:cbv:bizstep:inspecting",
				Action:              "OBSERVE",
				EPCList:             []string{dpp.GS1Key},
				Disposition:         "urn:epcglobal:cbv:disp:active",
				ReadPoint:           sgln(recipientGLN),
				BizLocation:         sgln(recipientGLN),
				Extensions:          map[string]interface{}{"inspectionDataByRecipient": inspQE},
			}
			dpp.EPCISEvents = append(dpp.EPCISEvents, inspEvent)
			// Ggf. dpp.recalculateOverallStatus() wenn die Inspektion mandatorisch war oder Specs hatte
		}
	}

	updatedDppBytes, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppBytes)
}

// QueryDPP: Liest den vollständigen DPP.
func (c *DPPQualityContract) QueryDPP(ctx contractapi.TransactionContextInterface, dppID string) (*DPP, error) {
	fmt.Printf("[QueryDPP-DEBUG] Query für dppID: %s\n", dppID)
	dppBytes, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		fmt.Printf("[QueryDPP-ERROR] GetState für dppID %s fehlgeschlagen: %v\n", dppID, err)
		return nil, err
	}
	if dppBytes == nil {
		fmt.Printf("[QueryDPP-ERROR] DPP %s nicht gefunden.\n", dppID)
		return nil, fmt.Errorf("DPP %s nicht gefunden", dppID)
	}
	fmt.Printf("[QueryDPP-DEBUG] DPP %s gefunden, Bytes Länge: %d\n", dppID, len(dppBytes))

	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppBytes, &dpp); errUnmarshal != nil {
		fmt.Printf("[QueryDPP-ERROR] Fehler beim Unmarshalling von DPP %s: %v\n", dppID, errUnmarshal)
		return nil, fmt.Errorf("Fehler beim Unmarshalling von DPP %s: %v", dppID, errUnmarshal)
	}
	fmt.Printf("[QueryDPP-DEBUG] DPP %s erfolgreich unmarshalled. OwnerOrg: %s, GS1Key: %s\n", dppID, dpp.OwnerOrg, dpp.GS1Key)
	return &dpp, nil
}

// InitLedger: Kann für Testaufbau verwendet werden (optional).
func (c *DPPQualityContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	fmt.Println("[InitLedger] Aufgerufen, keine Aktion implementiert.")
	return nil
}
