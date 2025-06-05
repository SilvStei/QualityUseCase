

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



type QualitySpecification struct {
	TestName      string  `json:"testName"`
	IsNumeric     bool    `json:"isNumeric"`
	LowerLimit    float64 `json:"lowerLimit,omitempty"    metadata:",optional"`
	UpperLimit    float64 `json:"upperLimit,omitempty"    metadata:",optional"`
	ExpectedValue string  `json:"expectedValue,omitempty" metadata:",optional"`
	Unit          string  `json:"unit,omitempty"          metadata:",optional"`
	IsMandatory   bool    `json:"isMandatory"`
}

type QualityEntry struct {
	TestName          string `json:"testName"`
	Result            string `json:"result"`
	Unit              string `json:"unit"`
	SystemID          string `json:"systemId"`
	Timestamp         string `json:"timestamp"`
	Responsible       string `json:"responsible"`
	PerformingOrg     string `json:"performingOrg"`
	OffChainDataRef   string `json:"offChainDataRef,omitempty"   metadata:",optional"`
	EvaluationOutcome string `json:"evaluationOutcome,omitempty" metadata:",optional"`
	EvaluationComment string `json:"evaluationComment,omitempty" metadata:",optional"`
}

type TransportConditionLogEntry struct {
	LogType           string `json:"logType"` 
	Value             string `json:"value"`   
	Unit              string `json:"unit"`   
	Timestamp         string `json:"timestamp"`
	Status            string `json:"status"`           
	OffChainLogRef    string `json:"offChainLogRef,omitempty" metadata:",optional"`
	ResponsibleSystem string `json:"responsibleSystem,omitempty" metadata:",optional"`
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
	Extensions          map[string]interface{} `json:"extensions"`
}

type DPP struct {
	DppID                 string                      `json:"dppId"`
	GS1Key                string                      `json:"gs1Key"`
	ProductTypeID         string                      `json:"productTypeId,omitempty"     metadata:",optional"`
	ManufacturerGLN       string                      `json:"manufacturerGln"`
	Batch                 string                      `json:"batch"`
	ProductionDate        string                      `json:"productionDate"`
	OwnerOrg              string                      `json:"ownerOrg"`
	Status                string                      `json:"status"`
	Specifications        []QualitySpecification      `json:"specifications,omitempty"      metadata:",optional"`
	OpenMandatoryChecks   []string                    `json:"openMandatoryChecks,omitempty" metadata:",optional"`
	Quality               []QualityEntry              `json:"quality"`
	TransportLog          []TransportConditionLogEntry `json:"transportLog,omitempty"      metadata:",optional"` // NEU
	InputDPPIDs           []string                    `json:"inputDppIds,omitempty"         metadata:",optional"`
	EPCISEvents           []EPCISEvent                `json:"epcisEvents"`
}

type DPPQualityContract struct {
	contractapi.Contract
}

const dppPrefix = "DPP-"
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

func (dpp *DPP) recalculateOverallStatus() {
	if dpp.Status == "Blocked" {
		return
	}
	
	if strings.HasPrefix(dpp.Status, "ConsumedInTransformation") ||
		strings.HasPrefix(dpp.Status, "RejectedBy") {
		return
	}
	
	if strings.HasPrefix(dpp.Status, "InTransitTo_") || strings.HasPrefix(dpp.Status, "AcceptedAtRecipient_") {

		if len(dpp.OpenMandatoryChecks) == 0 {

			for _, qe := range dpp.Quality {
				if qe.EvaluationOutcome == "FAIL" || qe.EvaluationOutcome == "INVALID_FORMAT" {
					dpp.Status = "Blocked" 
					return
				}
			}

			return 
		}

	}


	hasCriticalFailures := false
	hasDeviations := false 

	for _, qe := range dpp.Quality {
		if qe.EvaluationOutcome == "FAIL" || qe.EvaluationOutcome == "INVALID_FORMAT" {
			hasCriticalFailures = true
			break
		}
		if strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") || strings.Contains(qe.EvaluationOutcome, "ALERT") { 
			hasDeviations = true
		}
	}

	for _, tl := range dpp.TransportLog {
		if strings.Contains(tl.Status, "ALERT") {
			hasDeviations = true 
			break 
		}
	}


	if hasCriticalFailures {
		dpp.Status = "Blocked"
		return
	}

	if len(dpp.OpenMandatoryChecks) == 0 {
		if hasDeviations {

			specificDeviationStatus := "ReleasedWithDeviations" 
			for _, qe := range dpp.Quality {
				if strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION_") {
					specificDeviationStatus = "ReleasedWithQualityDeviations"
					break
				}
			}
			for _, tl := range dpp.TransportLog {
				if strings.Contains(tl.Status, "ALERT") {
					if specificDeviationStatus == "ReleasedWithDeviations" { 
						specificDeviationStatus = "ReleasedWithTransportAlert"
					} else {
						specificDeviationStatus = "ReleasedWithMultipleIssues"
					}
					break
				}
			}
			dpp.Status = specificDeviationStatus
		} else {
			dpp.Status = "Released"
		}
	} else {
		dpp.Status = fmt.Sprintf("AwaitingMandatoryChecks (%d open)", len(dpp.OpenMandatoryChecks))
	}
}

func (c *DPPQualityContract) CreateDPP(ctx contractapi.TransactionContextInterface, dppID, gs1Key, productTypeID, manufacturerGLN, batch, productionDate string, specificationsJSON string) (*DPP, error) {
	
	fmt.Printf("[CreateDPP-DEBUG] Entry: dppID=%s, gs1Key=%s, productTypeID=%s, manufacturerGLN=%s, batch=%s, productionDate=%s\n", dppID, gs1Key, productTypeID, manufacturerGLN, batch, productionDate)

	exists, err := c.dppExists(ctx, dppID)
	if err != nil {
		fmt.Printf("[CreateDPP-ERROR] Fehler bei dppExists für DPP %s: %v\n", dppID, err)
		return nil, err
	}
	if exists {
		fmt.Printf("[CreateDPP-ERROR] DPP %s existiert bereits.\n", dppID)
		return nil, fmt.Errorf("DPP %s existiert bereits", dppID)
	}
	if err := validateGS1Key(gs1Key); err != nil {
		fmt.Printf("[CreateDPP-ERROR] Ungültiger GS1 Key %s: %v\n", gs1Key, err)
		return nil, err
	}

	var specs []QualitySpecification
	if specificationsJSON != "" {
		if err := json.Unmarshal([]byte(specificationsJSON), &specs); err != nil {
			fmt.Printf("[CreateDPP-ERROR] Spezifikationen JSON fehlerhaft für DPP %s: %v\n", dppID, err)
			return nil, fmt.Errorf("Spezifikationen JSON fehlerhaft: %v", err)
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
		return nil, fmt.Errorf("Fehler beim Ermitteln der Client MSPID: %v", errClientMSPID)
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

	dpp := DPP{
		DppID:               dppID,
		GS1Key:              gs1Key,
		ProductTypeID:       productTypeID,
		ManufacturerGLN:     manufacturerGLN,
		Batch:               batch,
		ProductionDate:      productionDate,
		OwnerOrg:            clientMSPID,
		Status:              initialStatus,
		Specifications:      specs,
		OpenMandatoryChecks: openMandatory,
		Quality:             []QualityEntry{},
		TransportLog:        []TransportConditionLogEntry{}, 
		InputDPPIDs:         []string{},
		EPCISEvents:         []EPCISEvent{evt},
	}

	dpp.recalculateOverallStatus()

	dppBytes, errMarshal := json.Marshal(dpp)
	if errMarshal != nil {
		fmt.Printf("[CreateDPP-ERROR] Fehler beim Marshalling von DPP %s: %v\n", dppID, errMarshal)
		return nil, fmt.Errorf("Fehler beim Marshalling von DPP %s: %v", dppID, errMarshal)
	}
	logKey := dppPrefix + dppID
	logBytesSample := string(dppBytes)
	if len(logBytesSample) > 200 { logBytesSample = logBytesSample[:200] + "..." }
	fmt.Printf("[CreateDPP-DEBUG] Vor PutState für Key: %s, DPP JSON (Ausschnitt): %s\n", logKey, logBytesSample)

	errPut := ctx.GetStub().PutState(logKey, dppBytes)
	if errPut != nil {
		fmt.Printf("[CreateDPP-ERROR] PutState für Key %s fehlgeschlagen: %v\n", logKey, errPut)
		return nil, errPut
	}
	fmt.Printf("[CreateDPP-DEBUG] PutState für Key %s anscheinend erfolgreich.\n", logKey)
	return &dpp, nil
}

func (c *DPPQualityContract) RecordQualityData(ctx contractapi.TransactionContextInterface, dppID string, qualityEntryJSON string, recordingSiteGLN string) error {

	fmt.Printf("[RecordQualityData-DEBUG] Entry für DPP: %s, SiteGLN: %s, QualityEntryJSON: %s\n", dppID, recordingSiteGLN, qualityEntryJSON)
	dppBytes, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return fmt.Errorf("Fehler beim Lesen von DPP %s: %v", dppID, err)
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
		return fmt.Errorf("QualityEntry JSON fehlerhaft: %v. JSON war: %s", err, qualityEntryJSON)
	}

	if qe.Timestamp == "" { qe.Timestamp = time.Now().UTC().Format(time.RFC3339) }
	if qe.PerformingOrg == "" {
		clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
		if errClientMSPID != nil { return fmt.Errorf("Fehler beim Ermitteln der Client MSPID für QualityEntry: %v", errClientMSPID) }
		qe.PerformingOrg = clientMSPID
	}
	
	var currentSpec *QualitySpecification
	for i := range dpp.Specifications {
		if dpp.Specifications[i].TestName == qe.TestName {
			currentSpec = &dpp.Specifications[i]
			break
		}
	}

	clientProvidedOutcomeIsFinal := qe.EvaluationOutcome == "PASS" ||
								   strings.HasPrefix(qe.EvaluationOutcome, "FAIL") ||
								   strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") ||
								   qe.EvaluationOutcome == "INVALID_FORMAT" ||
								   qe.EvaluationOutcome == "INFO_SENSOR_DATA" ||
								   qe.EvaluationOutcome == "INFO_NO_SPEC"

	if !clientProvidedOutcomeIsFinal {
		fmt.Printf("[RecordQualityData-INFO] Kein finaler Outcome vom Client für Test '%s'. Führe Neubewertung durch.\n", qe.TestName)
		qe.EvaluationOutcome = "NO_SPEC" 
		qe.EvaluationComment = ""      
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
					} else { qe.EvaluationOutcome = "PASS" }
				}
			} else { 
				if strings.EqualFold(qe.Result, currentSpec.ExpectedValue) { qe.EvaluationOutcome = "PASS"
				} else {
					qe.EvaluationOutcome = "FAIL"
					qe.EvaluationComment = fmt.Sprintf("Erwartet: '%s', Erhalten: '%s'.", currentSpec.ExpectedValue, qe.Result)
				}
			}
			if currentSpec.Unit != "" && qe.Unit != "" && !strings.EqualFold(currentSpec.Unit, qe.Unit) && qe.EvaluationOutcome != "INVALID_FORMAT" {
				if qe.EvaluationComment != "" { qe.EvaluationComment += " " }
				qe.EvaluationComment += fmt.Sprintf("Einheit für '%s' passt nicht: Spezifikation '%s', Eintrag '%s'.", qe.TestName, currentSpec.Unit, qe.Unit)
			}
		} else if qe.TestName != "" {
			 qe.EvaluationOutcome = "INFO_NO_SPEC"
			 qe.EvaluationComment = fmt.Sprintf("Keine Spezifikation für Test '%s' im DPP hinterlegt. Daten als informativ gespeichert.", qe.TestName)
		}
	} else {
		fmt.Printf("[RecordQualityData-INFO] Behalte vom Client übergebenen finalen EvaluationOutcome: '%s' für Test '%s'\n", qe.EvaluationOutcome, qe.TestName)
		if qe.EvaluationComment == "" && qe.EvaluationOutcome != "PASS" && qe.EvaluationOutcome != "INFO_SENSOR_DATA" && qe.EvaluationOutcome != "INFO_NO_SPEC" {
			qe.EvaluationComment = "Outcome vom Integrationslayer/Oracle oder externen System gesetzt."
		}
	}
	dpp.Quality = append(dpp.Quality, qe)
	fmt.Printf("[RecordQualityData-DEBUG] Qualitätseintrag hinzugefügt: %+v\n", qe)

	now := time.Now()
	epcisDisposition := "urn:epcglobal:cbv:disp:active"
	if qe.EvaluationOutcome == "PASS" { epcisDisposition = "urn:epcglobal:cbv:disp:conformant"
	} else if qe.EvaluationOutcome == "FAIL" || qe.EvaluationOutcome == "INVALID_FORMAT" || strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") {
		epcisDisposition = "urn:epcglobal:cbv:disp:non_conformant"
	}
	qcEvent := EPCISEvent{
		EventID:             fmt.Sprintf("evt-qc-%s-%d", strings.ReplaceAll(strings.ReplaceAll(qe.TestName, " ", "_"), "/", "_"), now.UnixNano()),
		EventType:           "ObjectEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:inspecting", Action: "OBSERVE", EPCList: []string{dpp.GS1Key},
		Disposition:         epcisDisposition, ReadPoint: sgln(recordingSiteGLN), BizLocation: sgln(recordingSiteGLN),
		Extensions:          map[string]interface{}{"recordedQualityData": qe},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, qcEvent)
	if currentSpec != nil && currentSpec.IsMandatory && qe.EvaluationOutcome == "PASS" {
		var newOpenChecks []string; foundAndRemoved := false
		for _, checkName := range dpp.OpenMandatoryChecks {
			if checkName == qe.TestName { foundAndRemoved = true
			} else { newOpenChecks = append(newOpenChecks, checkName) }
		}
		if foundAndRemoved { dpp.OpenMandatoryChecks = newOpenChecks
			fmt.Printf("[RecordQualityData-DEBUG] Mandatorischer Check '%s' als PASS erfüllt und entfernt.\n", qe.TestName)
		}
	}
	dpp.recalculateOverallStatus()
	fmt.Printf("[RecordQualityData-INFO] Neuer Status für DPP %s nach recalculateOverallStatus: %s\n", dppID, dpp.Status)
	fmt.Printf("[RecordQualityData-DEBUG] Verbleibende offene mandatorische Checks: %v\n", dpp.OpenMandatoryChecks)

	if qe.EvaluationOutcome == "FAIL" || strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") || qe.EvaluationOutcome == "INVALID_FORMAT" {
		alertPayload := map[string]interface{}{
			"dppId": dppID, "gs1Key": dpp.GS1Key, "batch": dpp.Batch, "productTypeId": dpp.ProductTypeID,
			"testName": qe.TestName, "result": qe.Result, "evaluationOutcome": qe.EvaluationOutcome,
			"evaluationComment": qe.EvaluationComment, "timestamp": qe.Timestamp, "systemId": qe.SystemID,
			"performingOrg": qe.PerformingOrg,
		}
		alertBytes, _ := json.Marshal(alertPayload)
		ctx.GetStub().SetEvent("QualityAlert", alertBytes)
		fmt.Printf("[RecordQualityData-INFO] QualityAlert Event für DPP %s gesendet.\n", dppID)
	}
	updatedDppBytes, errMarshal := json.Marshal(dpp)
	if errMarshal != nil { return fmt.Errorf("Fehler beim Marshalling des aktualisierten DPP %s: %v", dppID, errMarshal) }
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppBytes)
}


func (c *DPPQualityContract) AddTransportUpdate(ctx contractapi.TransactionContextInterface, dppID string, transportUpdateEntryJSON string, siteGLN string) error {
	fmt.Printf("[AddTransportUpdate-DEBUG] Entry für DPP: %s, SiteGLN: %s, transportUpdateEntryJSON: %s\n", dppID, siteGLN, transportUpdateEntryJSON)

	dppBytes, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return fmt.Errorf("Fehler beim Lesen von DPP %s: %v", dppID, err)
	}
	if dppBytes == nil {
		return fmt.Errorf("DPP %s nicht gefunden", dppID)
	}

	var dpp DPP
	if err := json.Unmarshal(dppBytes, &dpp); err != nil {
		return fmt.Errorf("Fehler beim Unmarshalling von DPP %s: %v", dppID, err)
	}

	var transportEntry TransportConditionLogEntry
	if err := json.Unmarshal([]byte(transportUpdateEntryJSON), &transportEntry); err != nil {
		return fmt.Errorf("TransportUpdateEntry JSON fehlerhaft: %v. JSON war: %s", err, transportUpdateEntryJSON)
	}

	if transportEntry.Timestamp == "" {
		transportEntry.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	dpp.TransportLog = append(dpp.TransportLog, transportEntry)
	fmt.Printf("[AddTransportUpdate-DEBUG] TransportLog Eintrag hinzugefügt: %+v\n", transportEntry)


	now := time.Now()
	epcisDispositionForTransport := "urn:epcglobal:cbv:disp:in_transit" 
	if strings.Contains(transportEntry.Status, "ALERT") {
		epcisDispositionForTransport = "urn:epcglobal:cbv:disp:non_conformant_in_transit"
	}

	transportEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-transportlog-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent",
		EventTime:           transportEntry.Timestamp, 
		EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:transporting", 
		Action:              "OBSERVE",
		EPCList:             []string{dpp.GS1Key},
		Disposition:         epcisDispositionForTransport,
		ReadPoint:           sgln(siteGLN), 
		BizLocation:         sgln(siteGLN), 
		Extensions:          map[string]interface{}{"transportConditionUpdate": transportEntry},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, transportEvt)


	if strings.Contains(transportEntry.Status, "ALERT") {
		if dpp.Status == "InTransitTo_Org4MSP" { 
			dpp.Status = "InTransitTo_Org4MSP_TransportAlert"
		} else if strings.HasPrefix(dpp.Status, "InTransitTo_") && !strings.HasSuffix(dpp.Status, "_TransportAlert") {

			dpp.Status = dpp.Status + "_TransportAlert"
		}
		fmt.Printf("[AddTransportUpdate-INFO] Transport-Alert für DPP %s gesetzt. Neuer Status: %s\n", dppID, dpp.Status)
	}


	updatedDppBytes, errMarshal := json.Marshal(dpp)
	if errMarshal != nil {
		return fmt.Errorf("Fehler beim Marshalling des aktualisierten DPP %s nach Transport-Update: %v", dppID, errMarshal)
	}
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppBytes)
}


func (c *DPPQualityContract) RecordTransformation(ctx contractapi.TransactionContextInterface,
	outputDppID, outputGS1Key, outputProductTypeID string,
	currentGLN string, batch, productionDate string,
	inputDPPIDsJSON string, outputSpecificationsJSON string,
	initialQualityEntryJSON string) error {

	fmt.Printf("[RecordTransformation-DEBUG] Entry: outputDppID=%s, outputGS1Key=%s, outputProductTypeID=%s, currentGLN=%s, batch=%s, productionDate=%s\n", outputDppID, outputGS1Key, outputProductTypeID, currentGLN, batch, productionDate)
	
	fmt.Printf("[RecordTransformation-DEBUG] inputDPPIDsJSON: %s\n", inputDPPIDsJSON)
	fmt.Printf("[RecordTransformation-DEBUG] outputSpecificationsJSON: %s\n", outputSpecificationsJSON)
	fmt.Printf("[RecordTransformation-DEBUG] initialQualityEntryJSON: %s\n", initialQualityEntryJSON)

	exists, err := c.dppExists(ctx, outputDppID)
	if err != nil {
		fmt.Printf("[RecordTransformation-ERROR] Fehler bei dppExists für OutputDPP %s: %v\n", outputDppID, err)
		return fmt.Errorf("Fehler bei dppExists für OutputDPP %s: %v", outputDppID, err)
	}
	if exists {
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
	outputDPPObj, errCreate := c.CreateDPP(ctx, outputDppID, outputGS1Key, outputProductTypeID, currentGLN, batch, productionDate, outputSpecificationsJSON)
	if errCreate != nil {
		fmt.Printf("[RecordTransformation-ERROR] CreateDPP für outputDppID %s ist fehlgeschlagen: %v\n", outputDppID, errCreate)
		return fmt.Errorf("Fehler beim Erstellen des Output-DPP %s via CreateDPP: %v", outputDppID, errCreate)
	}
	if outputDPPObj == nil {
		 fmt.Printf("[RecordTransformation-ERROR] CreateDPP lieferte nil für outputDPP %s zurück, obwohl kein Fehler gemeldet wurde.\n", outputDppID)
		 return fmt.Errorf("CreateDPP lieferte unerwartet nil für DPP %s", outputDppID)
	}
	fmt.Printf("[RecordTransformation-DEBUG] CreateDPP für outputDppID %s erfolgreich. outputDPP Objekt im Speicher vorhanden. OwnerOrg: %s\n", outputDppID, outputDPPObj.OwnerOrg)

	outputDPPObj.InputDPPIDs = inputDPPIDs

	now := time.Now()
	tfEvent := EPCISEvent{
		EventID:             fmt.Sprintf("evt-tf-%s-%d", strings.ReplaceAll(outputGS1Key, ":", "_"), now.UnixNano()),
		EventType:           "TransformationEvent", EventTime: now.UTC().Format(time.RFC3339),	EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:transforming",
		InputEPCList:        inputGS1KeysForEvent, OutputEPCList:       []string{outputGS1Key},
		ReadPoint:           sgln(currentGLN), BizLocation:         sgln(currentGLN), Extensions:          make(map[string]interface{}),
	}

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
            
            initialQEClientProvidedOutcomeIsFinal := initialQE.EvaluationOutcome == "PASS" ||
                                                strings.HasPrefix(initialQE.EvaluationOutcome, "FAIL") ||
                                                strings.HasPrefix(initialQE.EvaluationOutcome, "DEVIATION") ||
                                                initialQE.EvaluationOutcome == "INVALID_FORMAT" ||
                                                initialQE.EvaluationOutcome == "INFO_SENSOR_DATA" ||
                                                initialQE.EvaluationOutcome == "INFO_NO_SPEC"

            if !initialQEClientProvidedOutcomeIsFinal {
                 fmt.Printf("[RecordTransformation-INFO] Neubewertung für initialQE Test '%s'.\n", initialQE.TestName)
                 initialQE.EvaluationOutcome = "NO_SPEC"
                 initialQE.EvaluationComment = ""
                 var currentSpecForInitialQE *QualitySpecification
                 for i := range outputDPPObj.Specifications {
                     if outputDPPObj.Specifications[i].TestName == initialQE.TestName {
                         currentSpecForInitialQE = &outputDPPObj.Specifications[i]
                         break
                     }
                 }
                 if currentSpecForInitialQE != nil {
                     if currentSpecForInitialQE.IsNumeric {
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
                             } else { initialQE.EvaluationOutcome = "PASS" }
                         }
                     } else {
                         if strings.EqualFold(initialQE.Result, currentSpecForInitialQE.ExpectedValue) { initialQE.EvaluationOutcome = "PASS" 
                         } else {
                             initialQE.EvaluationOutcome = "FAIL_INITIAL"
                             initialQE.EvaluationComment = fmt.Sprintf("Initial erwartet: '%s', Erhalten: '%s'.", currentSpecForInitialQE.ExpectedValue, initialQE.Result)
                         }
                     }
                      if currentSpecForInitialQE.Unit != "" && initialQE.Unit != "" && !strings.EqualFold(currentSpecForInitialQE.Unit, initialQE.Unit) && initialQE.EvaluationOutcome != "INVALID_FORMAT" {
                         if initialQE.EvaluationComment != "" { initialQE.EvaluationComment += " " }
                         initialQE.EvaluationComment += fmt.Sprintf(" Einheit für initialen Test '%s' passt nicht: Spezifikation '%s', Eintrag '%s'.", initialQE.TestName, currentSpecForInitialQE.Unit, initialQE.Unit)
                      }
                 } else if initialQE.TestName != "" {
                      initialQE.EvaluationOutcome = "INFO_NO_SPEC"
                      initialQE.EvaluationComment = fmt.Sprintf("Keine Spezifikation für initialen Test '%s' im Compound-DPP.", initialQE.TestName)
                 }
            } else {
                 fmt.Printf("[RecordTransformation-INFO] Behalte vom Client übergebenen finalen EvaluationOutcome für initialQE: '%s'\n", initialQE.EvaluationOutcome)
                  if initialQE.EvaluationComment == "" && initialQE.EvaluationOutcome != "PASS" && initialQE.EvaluationOutcome != "INFO_SENSOR_DATA" && initialQE.EvaluationOutcome != "INFO_NO_SPEC" {
                      initialQE.EvaluationComment = "Outcome für initialQE vom Integrationslayer/Oracle oder externen System gesetzt."
                  }
            }

			outputDPPObj.Quality = append(outputDPPObj.Quality, initialQE)
			fmt.Printf("[RecordTransformation-DEBUG] InitialQE zu outputDPPObj.Quality hinzugefügt: %+v\n", initialQE)

			var currentSpecForInitialQE *QualitySpecification 
			for i := range outputDPPObj.Specifications {
				 if outputDPPObj.Specifications[i].TestName == initialQE.TestName {
					  currentSpecForInitialQE = &outputDPPObj.Specifications[i]
					  break
				 }
			}
			if currentSpecForInitialQE != nil && currentSpecForInitialQE.IsMandatory && initialQE.EvaluationOutcome == "PASS" {
				var newOpenChecks []string
				for _, checkName := range outputDPPObj.OpenMandatoryChecks {
					if checkName != initialQE.TestName { newOpenChecks = append(newOpenChecks, checkName) }
				}
				outputDPPObj.OpenMandatoryChecks = newOpenChecks
				fmt.Printf("[RecordTransformation-DEBUG] OpenMandatoryChecks nach initialQE aktualisiert: %v\n", newOpenChecks)
			}
		} else {
			fmt.Printf("[RecordTransformation-WARN] initialQualityEntryJSON ('%s') fehlerhaft und wird ignoriert: %v\n", initialQualityEntryJSON, errQE)
		}
	} else {
		if outputDPPObj.Quality == nil { outputDPPObj.Quality = []QualityEntry{} }
		fmt.Printf("[RecordTransformation-DEBUG] Keine initialQualityEntryJSON vorhanden oder leer.\n")
	}

	outputDPPObj.EPCISEvents = append(outputDPPObj.EPCISEvents, tfEvent)
	outputDPPObj.recalculateOverallStatus()
	fmt.Printf("[RecordTransformation-DEBUG] Status des Output-DPP %s nach recalculateOverallStatus: %s\n", outputDppID, outputDPPObj.Status)

	finalOutputDppBytes, errMarshalFinal := json.Marshal(outputDPPObj)
	if errMarshalFinal != nil {
		fmt.Printf("[RecordTransformation-ERROR] Fehler beim finalen Marshalling von OutputDPP %s: %v\n", outputDppID, errMarshalFinal)
		return fmt.Errorf("Fehler beim finalen Marshalling von OutputDPP %s: %v", outputDppID, errMarshalFinal)
	}
	targetKey := dppPrefix + outputDppID
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

func (c *DPPQualityContract) TransferDPP(ctx contractapi.TransactionContextInterface, dppID, newOwnerMSP, shipperGLN string) error {
	fmt.Printf("[TransferDPP-DEBUG] Entry für DPP: %s, an: %s, von GLN: %s\n", dppID, newOwnerMSP, shipperGLN)
	dppBytes, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {	return fmt.Errorf("Fehler beim Lesen von DPP %s: %v", dppID, err) }
	if dppBytes == nil { return fmt.Errorf("DPP %s nicht gefunden", dppID) }
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppBytes, &dpp); errUnmarshal != nil {
		return fmt.Errorf("Fehler beim Unmarshalling von DPP %s für Transfer: %v", dppID, errUnmarshal)
	}

	currentOwnerMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil { return fmt.Errorf("Fehler beim Ermitteln der Client MSPID für Transfer: %v", errClientMSPID) }
	if dpp.OwnerOrg != currentOwnerMSPID {
		return fmt.Errorf("Nur der aktuelle Eigentümer (%s) darf DPP %s transferieren. Aufrufer ist %s.", dpp.OwnerOrg, dppID, currentOwnerMSPID)
	}
	if dpp.OwnerOrg == newOwnerMSP { return errors.New("neuer Eigentümer ist identisch mit aktuellem Eigentümer")	}


	isTransferable := dpp.Status == "Released" || dpp.Status == "ReleasedWithDeviations" || strings.Contains(dpp.Status, "TransportAlert")
	if !isTransferable || dpp.Status == "Blocked" {
		return fmt.Errorf("DPP %s (Status: %s) ist nicht für den Transfer freigegeben oder ist blockiert.", dppID, dpp.Status)
	}

	originalStatusBeforeTransportAlert := dpp.Status 
	
	now := time.Now()
	shipEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-ship-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:shipping", Action: "OBSERVE", EPCList: []string{dpp.GS1Key},
		Disposition:         "urn:epcglobal:cbv:disp:in_transit", ReadPoint: sgln(shipperGLN), BizLocation: "", 
		Extensions:          map[string]interface{}{"intendedRecipientMSP": newOwnerMSP, "originalStatus": originalStatusBeforeTransportAlert},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, shipEvt)
	dpp.OwnerOrg = newOwnerMSP

	if strings.Contains(originalStatusBeforeTransportAlert, "_TransportAlert") {
		dpp.Status = fmt.Sprintf("InTransitTo_%s_TransportAlert", newOwnerMSP)
	} else {
		dpp.Status = fmt.Sprintf("InTransitTo_%s", newOwnerMSP)
	}
	fmt.Printf("[TransferDPP-INFO] DPP %s an %s transferiert. Neuer Status: %s\n", dppID, newOwnerMSP, dpp.Status)

	updatedDppBytes, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppBytes)
}

func (c *DPPQualityContract) AcknowledgeReceiptAndRecordInspection(ctx contractapi.TransactionContextInterface, dppID, recipientGLN string, incomingInspectionJSON string) error {
	fmt.Printf("[AcknowledgeReceipt-DEBUG] Entry für DPP: %s, EmpfängerGLN: %s\n", dppID, recipientGLN)
	dppBytes, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil { return fmt.Errorf("Fehler beim Lesen von DPP %s: %v", dppID, err) }
	if dppBytes == nil { return fmt.Errorf("DPP %s nicht gefunden", dppID) }
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppBytes, &dpp); errUnmarshal != nil {
		return fmt.Errorf("Fehler beim Unmarshalling von DPP %s für Acknowledge: %v", dppID, errUnmarshal)
	}

	recipientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil { return fmt.Errorf("Fehler beim Ermitteln der Client MSPID für Acknowledge: %v", errClientMSPID) }


	expectedStatusPrefix := "InTransitTo_" + recipientMSPID
	if dpp.OwnerOrg != recipientMSPID || !strings.HasPrefix(dpp.Status, expectedStatusPrefix) {
		return fmt.Errorf("DPP %s ist nicht korrekt für Empfang durch %s vorgesehen. Aktuell: Owner %s, Status %s. Erwartet Owner %s und Status-Präfix %s",
			dppID, recipientMSPID, dpp.OwnerOrg, dpp.Status, recipientMSPID, expectedStatusPrefix)
	}


	statusSuffix := strings.TrimPrefix(dpp.Status, expectedStatusPrefix) 
	dpp.Status = "AcceptedAtRecipient" + statusSuffix
	
	ackDisposition := "urn:epcglobal:cbv:disp:in_possession"
	if strings.Contains(dpp.Status, "Alert") { 
		ackDisposition = "urn:epcglobal:cbv:disp:in_possession_non_conformant" 
	}


	now := time.Now()
	ackEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-recv-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:receiving", Action: "ADD", EPCList: []string{dpp.GS1Key},
		Disposition:         ackDisposition, ReadPoint: sgln(recipientGLN), BizLocation: sgln(recipientGLN),
		Extensions:          make(map[string]interface{}),
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, ackEvt)

	if incomingInspectionJSON != "" && incomingInspectionJSON != "{}" {
		var inspQE QualityEntry
		if errQE := json.Unmarshal([]byte(incomingInspectionJSON), &inspQE); errQE != nil {
			fmt.Printf("[Acknowledge-WARN] incomingInspectionJSON für DPP %s fehlerhaft, wird ignoriert: %v\n", dppID, errQE)
		} else {
			if inspQE.Timestamp == "" { inspQE.Timestamp = time.Now().UTC().Format(time.RFC3339) }
			if inspQE.PerformingOrg == "" { inspQE.PerformingOrg = recipientMSPID }
            if inspQE.EvaluationOutcome == "" { inspQE.EvaluationOutcome = "INCOMING_INSPECTION_DATA" }
			

			dpp.Quality = append(dpp.Quality, inspQE)
			fmt.Printf("[Acknowledge-DEBUG] Eingangsprüfungs-Qualitätseintrag hinzugefügt: %+v\n", inspQE)

			inspTime := time.Now()
			inspEventDisposition := "urn:epcglobal:cbv:disp:active" // Default
			if inspQE.EvaluationOutcome == "PASS" { inspEventDisposition = "urn:epcglobal:cbv:disp:conformant"
			} else if inspQE.EvaluationOutcome == "FAIL" || strings.HasPrefix(inspQE.EvaluationOutcome, "DEVIATION") || inspQE.EvaluationOutcome == "INVALID_FORMAT" {
				inspEventDisposition = "urn:epcglobal:cbv:disp:non_conformant"
			}

			inspEvent := EPCISEvent{
				EventID:             fmt.Sprintf("evt-insp-%s-%s-%d", recipientMSPID, strings.ReplaceAll(dpp.GS1Key, ":", "_"), inspTime.UnixNano()),
				EventType:           "ObjectEvent", EventTime: inspTime.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
				BizStep:             "urn:epcglobal:cbv:bizstep:inspecting", Action: "OBSERVE", EPCList: []string{dpp.GS1Key},
				Disposition:         inspEventDisposition, ReadPoint: sgln(recipientGLN), BizLocation: sgln(recipientGLN),
				Extensions:          map[string]interface{}{"inspectionDataByRecipient": inspQE},
			}
			dpp.EPCISEvents = append(dpp.EPCISEvents, inspEvent)

		}
	}
	fmt.Printf("[Acknowledge-INFO] DPP %s Empfang bestätigt. Neuer Status: %s\n", dppID, dpp.Status)
	updatedDppBytes, _ := json.Marshal(dpp)
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppBytes)
}

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

func (c *DPPQualityContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	fmt.Println("[InitLedger] Aufgerufen, keine Aktion implementiert.")
	return nil
}
