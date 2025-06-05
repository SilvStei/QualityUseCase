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
	DppID               string                       `json:"dppId"`
	GS1Key              string                       `json:"gs1Key"`
	ProductTypeID       string                       `json:"productTypeId,omitempty"     metadata:",optional"`
	ManufacturerGLN     string                       `json:"manufacturerGln"`
	Batch               string                       `json:"batch"`
	ProductionDate      string                       `json:"productionDate"`
	OwnerOrg            string                       `json:"ownerOrg"`
	Status              string                       `json:"status"`
	Specifications      []QualitySpecification       `json:"specifications,omitempty"    metadata:",optional"`
	OpenMandatoryChecks []string                     `json:"openMandatoryChecks,omitempty" metadata:",optional"`
	Quality             []QualityEntry               `json:"quality"`
	TransportLog        []TransportConditionLogEntry `json:"transportLog,omitempty"      metadata:",optional"`
	InputDPPIDs         []string                     `json:"inputDppIds,omitempty"       metadata:",optional"`
	EPCISEvents         []EPCISEvent                 `json:"epcisEvents"`
}

type DPPQualityContract struct {
	contractapi.Contract
}

const dppPrefix = "DPP-"

var gs1URNRegexp = regexp.MustCompile(`^urn:epc:id:([a-zA-Z0-9_]+):([a-zA-Z0-9\.\-]+)(\.[\w\.\-]+)*$`)

func validateGS1Key(gs1 string) error {
	if !gs1URNRegexp.MatchString(gs1) {
		return fmt.Errorf("GS1 ungültig %s", gs1)
	}
	return nil
}

func (c *DPPQualityContract) dppExists(ctx contractapi.TransactionContextInterface, dppID string) (bool, error) {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return false, err
	}
	return dppDaten != nil, nil
}

func tzOffset() string {
	return time.Now().Format("-07:00")
}

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
			hasQualityDev := false
			hasTransportAlert := false
			for _, qe := range dpp.Quality {
				if strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") {
					hasQualityDev = true
					break
				}
			}
			for _, tl := range dpp.TransportLog {
				if strings.Contains(tl.Status, "ALERT") {
					hasTransportAlert = true
					break
				}
			}

			if hasQualityDev && hasTransportAlert {
				specificDeviationStatus = "ReleasedWithMultipleIssues"
			} else if hasQualityDev {
				specificDeviationStatus = "ReleasedWithQualityDeviations"
			} else if hasTransportAlert {
				specificDeviationStatus = "ReleasedWithTransportAlert"
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
	exists, err := c.dppExists(ctx, dppID)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, fmt.Errorf("DPP existiert %s", dppID)
	}
	if err := validateGS1Key(gs1Key); err != nil {
		return nil, err
	}

	var specs []QualitySpecification
	if specificationsJSON != "" {
		if err := json.Unmarshal([]byte(specificationsJSON), &specs); err != nil {
			return nil, fmt.Errorf("JSON Specs ungültig %w", err)
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
		return nil, fmt.Errorf("MSPID Fehler %w", errClientMSPID)
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

	dppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil {
		return nil, fmt.Errorf("Marshal Fehler DPP %s %w", dppID, errMarshal)
	}

	errPut := ctx.GetStub().PutState(dppPrefix+dppID, dppDaten)
	if errPut != nil {
		return nil, errPut
	}
	return &dpp, nil
}

func (c *DPPQualityContract) RecordQualityData(ctx contractapi.TransactionContextInterface, dppID string, qualityEntryJSON string, recordingSiteGLN string) error {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return fmt.Errorf("Lesefehler DPP %s %w", dppID, err)
	}
	if dppDaten == nil {
		return fmt.Errorf("DPP nicht gefunden %s", dppID)
	}

	var dpp DPP
	if err := json.Unmarshal(dppDaten, &dpp); err != nil {
		return fmt.Errorf("Unmarshal Fehler DPP %s %w", dppID, err)
	}

	var qe QualityEntry
	if err := json.Unmarshal([]byte(qualityEntryJSON), &qe); err != nil {
		return fmt.Errorf("JSON QualityEntry ungültig %w", err)
	}

	if qe.Timestamp == "" {
		qe.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	if qe.PerformingOrg == "" {
		clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
		if errClientMSPID != nil {
			return fmt.Errorf("MSPID Fehler QE %w", errClientMSPID)
		}
		qe.PerformingOrg = clientMSPID
	}

	var currentSpec *QualitySpecification
	for i := range dpp.Specifications {
		if dpp.Specifications[i].TestName == qe.TestName {
			currentSpec = &dpp.Specifications[i]
			break
		}
	}

	clientFinal := qe.EvaluationOutcome == "PASS" ||
		strings.HasPrefix(qe.EvaluationOutcome, "FAIL") ||
		strings.HasPrefix(qe.EvaluationOutcome, "DEVIATION") ||
		qe.EvaluationOutcome == "INVALID_FORMAT" ||
		qe.EvaluationOutcome == "INFO_SENSOR_DATA" ||
		qe.EvaluationOutcome == "INFO_NO_SPEC"

	if !clientFinal {
		qe.EvaluationOutcome = "NO_SPEC"
		qe.EvaluationComment = ""
		if currentSpec != nil {
			if currentSpec.IsNumeric {
				ErgebnisVal, KonvError := strconv.ParseFloat(qe.Result, 64)
				if KonvError != nil {
					qe.EvaluationOutcome = "INVALID_FORMAT"
					qe.EvaluationComment = fmt.Sprintf("Ergebnis '%s' für Test '%s' ist nicht numerisch.", qe.Result, qe.TestName)
				} else {
					if ErgebnisVal < currentSpec.LowerLimit {
						qe.EvaluationOutcome = "DEVIATION_LOW"
						qe.EvaluationComment = fmt.Sprintf("Wert %.4f unter Grenzwert %.4f %s.", ErgebnisVal, currentSpec.LowerLimit, currentSpec.Unit)
					} else if ErgebnisVal > currentSpec.UpperLimit {
						qe.EvaluationOutcome = "DEVIATION_HIGH"
						qe.EvaluationComment = fmt.Sprintf("Wert %.4f über Grenzwert %.4f %s.", ErgebnisVal, currentSpec.UpperLimit, currentSpec.Unit)
					} else {
						qe.EvaluationOutcome = "PASS"
					}
				}
			} else {
				if strings.EqualFold(qe.Result, currentSpec.ExpectedValue) {
					qe.EvaluationOutcome = "PASS"
				} else {
					qe.EvaluationOutcome = "FAIL"
					qe.EvaluationComment = fmt.Sprintf("Erwartet '%s', Erhalten '%s'.", currentSpec.ExpectedValue, qe.Result)
				}
			}
			if currentSpec.Unit != "" && qe.Unit != "" && !strings.EqualFold(currentSpec.Unit, qe.Unit) && qe.EvaluationOutcome != "INVALID_FORMAT" {
				if qe.EvaluationComment != "" {
					qe.EvaluationComment += " "
				}
				qe.EvaluationComment += fmt.Sprintf("Einheit für '%s' passt nicht Spezifikation '%s', Eintrag '%s'.", qe.TestName, currentSpec.Unit, qe.Unit)
			}
		} else if qe.TestName != "" {
			qe.EvaluationOutcome = "INFO_NO_SPEC"
			qe.EvaluationComment = fmt.Sprintf("Keine Spezifikation für Test '%s' im DPP hinterlegt.", qe.TestName)
		}
	} else {
		if qe.EvaluationComment == "" && qe.EvaluationOutcome != "PASS" && qe.EvaluationOutcome != "INFO_SENSOR_DATA" && qe.EvaluationOutcome != "INFO_NO_SPEC" {
			qe.EvaluationComment = "Outcome extern gesetzt"
		}
	}
	dpp.Quality = append(dpp.Quality, qe)

	now := time.Now()
	epcisDisposition := "urn:epcglobal:cbv:disp:active"
	if qe.EvaluationOutcome == "PASS" {
		epcisDisposition = "urn:epcglobal:cbv:disp:conformant"
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
			"dppId": dppID, "gs1Key": dpp.GS1Key, "batch": dpp.Batch, "productTypeId": dpp.ProductTypeID,
			"testName": qe.TestName, "result": qe.Result, "evaluationOutcome": qe.EvaluationOutcome,
			"evaluationComment": qe.EvaluationComment, "timestamp": qe.Timestamp, "systemId": qe.SystemID,
			"performingOrg": qe.PerformingOrg,
		}
		alertDaten, _ := json.Marshal(alertPayload)
		ctx.GetStub().SetEvent("QualityAlert", alertDaten)
	}
	updatedDppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil {
		return fmt.Errorf("Marshal Fehler Update DPP %s %w", dppID, errMarshal)
	}
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppDaten)
}

func (c *DPPQualityContract) AddTransportUpdate(ctx contractapi.TransactionContextInterface, dppID string, transportUpdateEntryJSON string, siteGLN string) error {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return fmt.Errorf("Lesefehler DPP %s %w", dppID, err)
	}
	if dppDaten == nil {
		return fmt.Errorf("DPP nicht gefunden %s", dppID)
	}

	var dpp DPP
	if err := json.Unmarshal(dppDaten, &dpp); err != nil {
		return fmt.Errorf("Unmarshal Fehler DPP %s %w", dppID, err)
	}

	var transportEntry TransportConditionLogEntry
	if err := json.Unmarshal([]byte(transportUpdateEntryJSON), &transportEntry); err != nil {
		return fmt.Errorf("JSON TransportEntry ungültig %w", err)
	}

	if transportEntry.Timestamp == "" {
		transportEntry.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	dpp.TransportLog = append(dpp.TransportLog, transportEntry)

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
		if strings.HasPrefix(dpp.Status, "InTransitTo_") && !strings.HasSuffix(dpp.Status, "_TransportAlert") {
			dpp.Status = dpp.Status + "_TransportAlert"
		}
	}

	updatedDppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil {
		return fmt.Errorf("Marshal Fehler Update DPP %s %w", dppID, errMarshal)
	}
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppDaten)
}

func (c *DPPQualityContract) RecordTransformation(ctx contractapi.TransactionContextInterface,
	outputDppID, outputGS1Key, outputProductTypeID string,
	currentGLN string, batch, productionDate string,
	inputDPPIDsJSON string, outputSpecificationsJSON string,
	initialQualityEntryJSON string) error {

	exists, err := c.dppExists(ctx, outputDppID)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("Output DPP existiert %s", outputDppID)
	}
	if err := validateGS1Key(outputGS1Key); err != nil {
		return err
	}

	var inputDPPIDs []string
	if err := json.Unmarshal([]byte(inputDPPIDsJSON), &inputDPPIDs); err != nil {
		return fmt.Errorf("JSON InputDPPIDs ungültig %w", err)
	}

	var inputGS1KeysForEvent []string
	for _, inputID := range inputDPPIDs {
		inputDppDaten, errGet := ctx.GetStub().GetState(dppPrefix + inputID)
		if errGet != nil {
			return fmt.Errorf("Lesefehler InputDPP %s %w", inputID, errGet)
		}
		if inputDppDaten == nil {
			return fmt.Errorf("InputDPP nicht gefunden %s", inputID)
		}
		var inputDPP DPP
		if errUnmarshalInput := json.Unmarshal(inputDppDaten, &inputDPP); errUnmarshalInput != nil {
			return fmt.Errorf("Unmarshal Fehler InputDPP %s %w", inputID, errUnmarshalInput)
		}

		inputGS1KeysForEvent = append(inputGS1KeysForEvent, inputDPP.GS1Key)

		inputDPP.Status = fmt.Sprintf("ConsumedInTransformation_%s", outputDppID)
		updatedInputDaten, errMarshalInput := json.Marshal(inputDPP)
		if errMarshalInput != nil {
			return fmt.Errorf("Marshal Fehler Update InputDPP %s %w", inputID, errMarshalInput)
		}
		if errPutInput := ctx.GetStub().PutState(dppPrefix+inputID, updatedInputDaten); errPutInput != nil {
			return errPutInput
		}
	}

	outputDPPObj, errCreate := c.CreateDPP(ctx, outputDppID, outputGS1Key, outputProductTypeID, currentGLN, batch, productionDate, outputSpecificationsJSON)
	if errCreate != nil {
		return fmt.Errorf("Create OutputDPP Fehler %w", errCreate)
	}
	if outputDPPObj == nil {
		return fmt.Errorf("OutputDPP nil nach Create")
	}

	outputDPPObj.InputDPPIDs = inputDPPIDs
	now := time.Now()
	tfEvent := EPCISEvent{
		EventID:             fmt.Sprintf("evt-tf-%s-%d", strings.ReplaceAll(outputGS1Key, ":", "_"), now.UnixNano()),
		EventType:           "TransformationEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:transforming",
		InputEPCList:        inputGS1KeysForEvent, OutputEPCList: []string{outputGS1Key},
		ReadPoint:           sgln(currentGLN), BizLocation: sgln(currentGLN), Extensions: make(map[string]interface{}),
	}

	if initialQualityEntryJSON != "" && initialQualityEntryJSON != "{}" {
		var initialQE QualityEntry
		if errQE := json.Unmarshal([]byte(initialQualityEntryJSON), &initialQE); errQE == nil {
			if initialQE.Timestamp == "" {
				initialQE.Timestamp = now.UTC().Format(time.RFC3339)
			}
			if initialQE.PerformingOrg == "" {
				clientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
				if errClientMSPID != nil {
					return fmt.Errorf("MSPID Fehler initialQE %w", errClientMSPID)
				}
				initialQE.PerformingOrg = clientMSPID
			}
			tfEvent.Extensions["initialCompoundQuality"] = initialQE

			clientFinal := initialQE.EvaluationOutcome == "PASS" ||
				strings.HasPrefix(initialQE.EvaluationOutcome, "FAIL") ||
				strings.HasPrefix(initialQE.EvaluationOutcome, "DEVIATION") ||
				initialQE.EvaluationOutcome == "INVALID_FORMAT" ||
				initialQE.EvaluationOutcome == "INFO_SENSOR_DATA" ||
				initialQE.EvaluationOutcome == "INFO_NO_SPEC"

			if !clientFinal {
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
						ErgebnisVal, KonvError := strconv.ParseFloat(initialQE.Result, 64)
						if KonvError != nil {
							initialQE.EvaluationOutcome = "INVALID_FORMAT"
							initialQE.EvaluationComment = fmt.Sprintf("Initiales Ergebnis '%s' für Test '%s' nicht numerisch.", initialQE.Result, initialQE.TestName)
						} else {
							if ErgebnisVal < currentSpecForInitialQE.LowerLimit {
								initialQE.EvaluationOutcome = "DEVIATION_LOW_INITIAL"
								initialQE.EvaluationComment = fmt.Sprintf("Initialer Wert %.4f unter Grenzwert %.4f %s.", ErgebnisVal, currentSpecForInitialQE.LowerLimit, currentSpecForInitialQE.Unit)
							} else if ErgebnisVal > currentSpecForInitialQE.UpperLimit {
								initialQE.EvaluationOutcome = "DEVIATION_HIGH_INITIAL"
								initialQE.EvaluationComment = fmt.Sprintf("Initialer Wert %.4f über Grenzwert %.4f %s.", ErgebnisVal, currentSpecForInitialQE.UpperLimit, currentSpecForInitialQE.Unit)
							} else {
								initialQE.EvaluationOutcome = "PASS"
							}
						}
					} else {
						if strings.EqualFold(initialQE.Result, currentSpecForInitialQE.ExpectedValue) {
							initialQE.EvaluationOutcome = "PASS"
						} else {
							initialQE.EvaluationOutcome = "FAIL_INITIAL"
							initialQE.EvaluationComment = fmt.Sprintf("Initial erwartet '%s', Erhalten '%s'.", currentSpecForInitialQE.ExpectedValue, initialQE.Result)
						}
					}
					if currentSpecForInitialQE.Unit != "" && initialQE.Unit != "" && !strings.EqualFold(currentSpecForInitialQE.Unit, initialQE.Unit) && initialQE.EvaluationOutcome != "INVALID_FORMAT" {
						if initialQE.EvaluationComment != "" { initialQE.EvaluationComment += " " }
						initialQE.EvaluationComment += fmt.Sprintf(" Einheit initialer Test '%s' passt nicht Spezifikation '%s', Eintrag '%s'.", initialQE.TestName, currentSpecForInitialQE.Unit, initialQE.Unit)
					}
				} else if initialQE.TestName != "" {
					initialQE.EvaluationOutcome = "INFO_NO_SPEC"
					initialQE.EvaluationComment = fmt.Sprintf("Keine Spezifikation für initialen Test '%s' im Compound-DPP.", initialQE.TestName)
				}
			} else {
				if initialQE.EvaluationComment == "" && initialQE.EvaluationOutcome != "PASS" && initialQE.EvaluationOutcome != "INFO_SENSOR_DATA" && initialQE.EvaluationOutcome != "INFO_NO_SPEC" {
					initialQE.EvaluationComment = "Outcome initialQE extern gesetzt."
				}
			}
			outputDPPObj.Quality = append(outputDPPObj.Quality, initialQE)

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
					if checkName != initialQE.TestName {
						newOpenChecks = append(newOpenChecks, checkName)
					}
				}
				outputDPPObj.OpenMandatoryChecks = newOpenChecks
			}
		}
	} else {
		if outputDPPObj.Quality == nil {
			outputDPPObj.Quality = []QualityEntry{}
		}
	}

	outputDPPObj.EPCISEvents = append(outputDPPObj.EPCISEvents, tfEvent)
	outputDPPObj.recalculateOverallStatus()

	finalOutputDppDaten, errMarshalFinal := json.Marshal(outputDPPObj)
	if errMarshalFinal != nil {
		return fmt.Errorf("Marshal Fehler OutputDPP %s %w", outputDppID, errMarshalFinal)
	}

	errPutFinal := ctx.GetStub().PutState(dppPrefix+outputDppID, finalOutputDppDaten)
	if errPutFinal != nil {
		return errPutFinal
	}
	return nil
}

func (c *DPPQualityContract) TransferDPP(ctx contractapi.TransactionContextInterface, dppID, newOwnerMSP, shipperGLN string) error {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return fmt.Errorf("Lesefehler DPP %s %w", dppID, err)
	}
	if dppDaten == nil {
		return fmt.Errorf("DPP nicht gefunden %s", dppID)
	}
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppDaten, &dpp); errUnmarshal != nil {
		return fmt.Errorf("Unmarshal Fehler DPP %s %w", dppID, errUnmarshal)
	}

	currentOwnerMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil {
		return fmt.Errorf("MSPID Fehler Transfer %w", errClientMSPID)
	}
	if dpp.OwnerOrg != currentOwnerMSPID {
		return fmt.Errorf("Eigentümer Konflikt %s", dpp.OwnerOrg)
	}
	if dpp.OwnerOrg == newOwnerMSP {
		return errors.New("Identischer Eigentümer")
	}

	istTransfer := dpp.Status == "Released" || dpp.Status == "ReleasedWithDeviations" || strings.Contains(dpp.Status, "TransportAlert") || dpp.Status == "AcceptedAtRecipient" || strings.HasPrefix(dpp.Status, "AcceptedAtRecipient_")
	if !istTransfer || dpp.Status == "Blocked" {
		return fmt.Errorf("DPP %s (Status %s) nicht transferierbar", dppID, dpp.Status)
	}

	originalStatusVorTransportAlarm := dpp.Status
	now := time.Now()
	shipEvt := EPCISEvent{
		EventID:             fmt.Sprintf("evt-ship-%s-%d", strings.ReplaceAll(dpp.GS1Key, ":", "_"), now.UnixNano()),
		EventType:           "ObjectEvent", EventTime: now.UTC().Format(time.RFC3339), EventTimeZoneOffset: tzOffset(),
		BizStep:             "urn:epcglobal:cbv:bizstep:shipping", Action: "OBSERVE", EPCList: []string{dpp.GS1Key},
		Disposition:         "urn:epcglobal:cbv:disp:in_transit", ReadPoint: sgln(shipperGLN), BizLocation: "",
		Extensions:          map[string]interface{}{"intendedRecipientMSP": newOwnerMSP, "originalStatus": originalStatusVorTransportAlarm},
	}
	dpp.EPCISEvents = append(dpp.EPCISEvents, shipEvt)
	dpp.OwnerOrg = newOwnerMSP

	if strings.Contains(originalStatusVorTransportAlarm, "_TransportAlert") {
		dpp.Status = fmt.Sprintf("InTransitTo_%s_TransportAlert", newOwnerMSP)
	} else {
		dpp.Status = fmt.Sprintf("InTransitTo_%s", newOwnerMSP)
	}

	updatedDppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil {
		return fmt.Errorf("Marshal Fehler DPP %s Transfer %w", dppID, errMarshal)
	}
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppDaten)
}

func (c *DPPQualityContract) AcknowledgeReceiptAndRecordInspection(ctx contractapi.TransactionContextInterface, dppID, recipientGLN string, incomingInspectionJSON string) error {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil { return fmt.Errorf("Lesefehler DPP %s %w", dppID, err) }
	if dppDaten == nil { return fmt.Errorf("DPP nicht gefunden %s", dppID) }
	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppDaten, &dpp); errUnmarshal != nil {
		return fmt.Errorf("Unmarshal Fehler DPP %s %w", dppID, errUnmarshal)
	}

	recipientMSPID, errClientMSPID := ctx.GetClientIdentity().GetMSPID()
	if errClientMSPID != nil {
		return fmt.Errorf("MSPID Fehler Acknowledge %w", errClientMSPID)
	}

	expectedStatusPrefix := "InTransitTo_" + recipientMSPID
	if dpp.OwnerOrg != recipientMSPID || !strings.HasPrefix(dpp.Status, expectedStatusPrefix) {
		return fmt.Errorf("Empfang nicht erlaubt DPP %s für %s (Owner %s, Status %s)", dppID, recipientMSPID, dpp.OwnerOrg, dpp.Status)
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
		if errQE := json.Unmarshal([]byte(incomingInspectionJSON), &inspQE); errQE == nil {
			if inspQE.Timestamp == "" { inspQE.Timestamp = time.Now().UTC().Format(time.RFC3339) }
			if inspQE.PerformingOrg == "" { inspQE.PerformingOrg = recipientMSPID }
			if inspQE.EvaluationOutcome == "" { inspQE.EvaluationOutcome = "INCOMING_INSPECTION_DATA" }

			dpp.Quality = append(dpp.Quality, inspQE)

			inspTime := time.Now()
			inspEventDisposition := "urn:epcglobal:cbv:disp:active"
			if inspQE.EvaluationOutcome == "PASS" {
				inspEventDisposition = "urn:epcglobal:cbv:disp:conformant"
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
	updatedDppDaten, errMarshal := json.Marshal(dpp)
	if errMarshal != nil {
		return fmt.Errorf("Marshal Fehler DPP %s Acknowledge %w", dppID, errMarshal)
	}
	return ctx.GetStub().PutState(dppPrefix+dppID, updatedDppDaten)
}

func (c *DPPQualityContract) QueryDPP(ctx contractapi.TransactionContextInterface, dppID string) (*DPP, error) {
	dppDaten, err := ctx.GetStub().GetState(dppPrefix + dppID)
	if err != nil {
		return nil, err
	}
	if dppDaten == nil {
		return nil, fmt.Errorf("DPP nicht gefunden %s", dppID)
	}

	var dpp DPP
	if errUnmarshal := json.Unmarshal(dppDaten, &dpp); errUnmarshal != nil {
		return nil, fmt.Errorf("Unmarshal Fehler DPP %s %w", dppID, errUnmarshal)
	}
	return &dpp, nil
}

func (c *DPPQualityContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	return nil
}