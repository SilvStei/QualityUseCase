// dpp.go
// Dieser Code kommt in die Datei: ~/Masterthesis/QualityUseCase/chaincode/dpp_transfer_go/dpp.go
package main

import (
	"encoding/json" // Wird benötigt, um Daten in das JSON-Format umzuwandeln und umgekehrt
	"fmt"           // Für formatierte Ausgaben, z.B. Fehlermeldungen
	"github.com/hyperledger/fabric-contract-api-go/contractapi" // Das Kernpaket für Fabric Smart Contracts in Go
)

// SmartContract implementiert die Chaincode-Logik.
// Wir betten contractapi.Contract ein, um Standardfunktionalitäten zu erhalten.
type SmartContract struct {
	contractapi.Contract
}

// NEU: Struktur für einen einzelnen Testeintrag
type TestEntry struct {
	TestName          string `json:"testName"`          // Name des Tests
	Ergebnis          string `json:"ergebnis"`          // Das Ergebnis des Tests
	Einheit           string `json:"einheit"`           // Einheit des Ergebnisses, falls numerisch
	SystemID          string `json:"systemID"`          // Kennung des Systems, das die Daten liefert (z.B. "LIMS-01")
	Timestamp         string `json:"timestamp"`         // Zeitstempel der Testerfassung
	Verantwortlich    string `json:"verantwortlich"`    // Person/Abteilung innerhalb der Organisation
	DurchfuehrendeOrg string `json:"durchfuehrendeOrg"` // NEU: MSPID der Organisation, die den Test hinzugefügt hat
}

// DPP definiert die Struktur unseres Digitalen Produktpasses.
// Die `json:"..."`-Tags sind wichtig für die (De-)Serialisierung nach/von JSON,
// wenn Daten im Ledger gespeichert oder von dort gelesen werden.
type DPP struct {
	ID             string      `json:"ID"`
	Beschreibung   string      `json:"beschreibung"`
	EigentuemerOrg string      `json:"eigentuemerOrg"`
	Status         string      `json:"status"`
	Testergebnisse []TestEntry `json:"testergebnisse,omitempty"` // NEUES FELD: Slice (Liste) von TestEntry-Objekten
// ,omitempty sorgt dafür, dass das Feld im JSON fehlt, wenn es leer ist
}


// InitLedger ist eine optionale Funktion, um den Ledger mit Beispieldaten zu initialisieren.
func (s *SmartContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	// Beispieldaten können hier nach Bedarf angepasst oder entfernt werden.
	// Für die aktuelle Entwicklung sind dynamisch erstellte DPPs wichtiger.
	dpps := []DPP{
		{
			ID: "DPP_INIT_001", Beschreibung: "Initiales Testprodukt von Org1", EigentuemerOrg: "Org1MSP", Status: "InitialBeiOrg1",
			Testergebnisse: []TestEntry{
				{TestName: "InitTestOrg1", Ergebnis: "OK", Einheit: "-", SystemID: "InitSystem", Timestamp: "2025-01-01T10:00:00Z", Verantwortlich: "SystemAdmin", DurchfuehrendeOrg: "Org1MSP"},
			},
		},
	}

	for _, dpp := range dpps {
		dppJSON, err := json.Marshal(dpp)
		if err != nil {
			return fmt.Errorf("Fehler beim Marshalling von DPP %s: %v", dpp.ID, err)
		}
		err = ctx.GetStub().PutState(dpp.ID, dppJSON)
		if err != nil {
			return fmt.Errorf("Fehler beim Speichern von DPP %s im Ledger: %v", dpp.ID, err)
		}
		fmt.Printf("DPP %s initialisiert\n", dpp.ID)
	}
	return nil
}

// CreateDPP erstellt einen neuen Digitalen Produktpass im Ledger.
// ctx: Der Transaktionskontext, liefert APIs für Ledger-Zugriff und Client-Identität.
// id: Die eindeutige ID für den neuen DPP.
// beschreibung: Beschreibung des Produkts.
// status: Initialer Status des DPPs.
func (s *SmartContract) CreateDPP(ctx contractapi.TransactionContextInterface, id string, beschreibung string, status string) error {
	exists, err := s.DPPExists(ctx, id)
	if err != nil {
		return fmt.Errorf("Fehler bei der Prüfung der Existenz von DPP %s: %v", id, err)
	}
	if exists {
		return fmt.Errorf("der DPP %s existiert bereits", id)
	}

	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("fehler beim Abrufen der MSPID des Clients: %v", err)
	}

	dpp := DPP{
		ID:             id,
		Beschreibung:   beschreibung,
		EigentuemerOrg: clientMSPID,
		Status:         status,
		Testergebnisse: []TestEntry{}, // Initialisiere als leeres Slice, um 'null' im JSON zu vermeiden, wenn keine Tests da sind
	}
	dppJSON, err := json.Marshal(dpp)
	if err != nil {
		return fmt.Errorf("fehler beim Marshalling des DPP %s: %v", id, err)
	}
	err = ctx.GetStub().PutState(id, dppJSON)
	if err != nil {
		return fmt.Errorf("fehler beim Speichern des DPP %s im Ledger: %v", id, err)
	}
	fmt.Printf("DPP %s erfolgreich erstellt und an %s zugewiesen.\n", id, clientMSPID)
	return nil
}

// QueryDPP liest einen DPP anhand seiner ID aus dem Ledger.
// ctx: Der Transaktionskontext.
// id: Die ID des abzufragenden DPPs.
// Gibt einen Pointer auf das DPP-Objekt oder einen Fehler zurück.
func (s *SmartContract) QueryDPP(ctx contractapi.TransactionContextInterface, id string) (*DPP, error) {
	// GetState ist die Funktion, um Daten anhand eines Schlüssels (hier die ID) aus dem Ledger zu lesen.
	dppJSON, err := ctx.GetStub().GetState(id)
	if err != nil {
		return nil, fmt.Errorf("fehler beim Lesen des DPPs %s vom World State: %v", id, err)
	}
	// Wenn GetState nil zurückgibt (und keinen Fehler), existiert der Schlüssel nicht.
	if dppJSON == nil {
		return nil, fmt.Errorf("der DPP %s existiert nicht", id)
	}

	// Die gelesenen JSON-Daten zurück in ein DPP-Objekt umwandeln (Unmarshal).
	var dpp DPP
	err = json.Unmarshal(dppJSON, &dpp)
	if err != nil {
		return nil, fmt.Errorf("fehler beim Unmarshalling des DPP %s: %v", id, err)
	}

	return &dpp, nil
}

// AddTestData fügt einen neuen Testeintrag zu einem bestehenden DPP hinzu.
// Die durchführende Organisation wird automatisch aus der Client-Identität ermittelt.
func (s *SmartContract) AddTestData(ctx contractapi.TransactionContextInterface, dppID string, testName string, ergebnis string, einheit string, systemID string, timestamp string, verantwortlich string) error {
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("fehler beim Abrufen der MSPID des Clients für AddTestData: %v", err)
	}

	dpp, err := s.QueryDPP(ctx, dppID)
	if err != nil {
		return fmt.Errorf("fehler beim Abrufen des DPP %s für AddTestData: %v", dppID, err)
	}
	if dpp == nil {
		return fmt.Errorf("kann keine Testdaten zu DPP %s hinzufügen, da er nicht existiert", dppID)
	}

	if dpp.EigentuemerOrg != clientMSPID {
		// In manchen Szenarien könnte man auch erlauben, dass andere berechtigte Parteien (z.B. ein zertifiziertes Labor)
		// Testdaten hinzufügen, auch wenn sie nicht der Eigentümer sind. Das würde eine komplexere Berechtigungslogik erfordern.
		// Fürs Erste bleibt die Regel: Nur der Eigentümer fügt Daten zu "seinem" Produkt hinzu.
		return fmt.Errorf("transaktion abgelehnt: Nur der aktuelle Eigentuemer (%s) darf Testdaten zu DPP %s hinzufügen. Aufrufer ist %s", dpp.EigentuemerOrg, dppID, clientMSPID)
	}

	neuerTest := TestEntry{
		TestName:          testName,
		Ergebnis:          ergebnis,
		Einheit:           einheit,
		SystemID:          systemID,
		Timestamp:         timestamp,
		Verantwortlich:    verantwortlich,    // Die spezifische Person/Abteilung
		DurchfuehrendeOrg: clientMSPID,       // Die MSPID der Organisation des Aufrufers
	}

	dpp.Testergebnisse = append(dpp.Testergebnisse, neuerTest)
	dpp.Status = fmt.Sprintf("AktualisiertMitTest_%s_Durch_%s", testName, clientMSPID) // Status angepasst

	dppJSON, err := json.Marshal(dpp)
	if err != nil {
		return fmt.Errorf("fehler beim Marshalling des aktualisierten DPP %s nach AddTestData: %v", dppID, err)
	}
	err = ctx.GetStub().PutState(dppID, dppJSON)
	if err != nil {
		return fmt.Errorf("fehler beim Speichern des DPP %s im Ledger nach AddTestData: %v", dppID, err)
	}
	fmt.Printf("Testdaten '%s' (durchgeführt von %s) erfolgreich zu DPP %s hinzugefügt.\n", testName, clientMSPID, dppID)
	return nil
}


// TransferDPP ändert den Eigentümer eines DPPs.
// ctx: Der Transaktionskontext.
// id: Die ID des zu transferierenden DPPs.
// neueEigentuemerOrgMSP: Die MSPID der Organisation, an die der DPP transferiert wird.
func (s *SmartContract) TransferDPP(ctx contractapi.TransactionContextInterface, id string, neueEigentuemerOrgMSP string) error {
	// 1. Den aktuellen DPP aus dem Ledger lesen.
	dpp, err := s.QueryDPP(ctx, id) // Wir verwenden unsere eigene QueryDPP-Funktion
	if err != nil {
		return fmt.Errorf("fehler beim Abrufen des DPP %s für den Transfer: %v", id, err)
	}
	if dpp == nil { // Sollte durch QueryDPP abgedeckt sein, aber sicher ist sicher
		return fmt.Errorf("kann DPP %s nicht transferieren, da er nicht existiert", id)
	}

	// 2. Die Identität (MSPID) der aufrufenden Organisation ermitteln.
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("fehler beim Abrufen der MSPID des Clients für den Transfer von DPP %s: %v", id, err)
	}

	// 3. Berechtigungsprüfung: Nur der aktuelle Eigentümer darf den DPP transferieren.
	if dpp.EigentuemerOrg != clientMSPID {
		return fmt.Errorf("transaktion abgelehnt: Nur der aktuelle Eigentuemer (%s) darf den DPP %s transferieren. Aufrufer ist %s", dpp.EigentuemerOrg, id, clientMSPID)
	}

	// 4. Den neuen Eigentümer und ggf. den Status aktualisieren.
	dpp.EigentuemerOrg = neueEigentuemerOrgMSP
	dpp.Status = fmt.Sprintf("TransferiertAn_%s", neueEigentuemerOrgMSP) // Beispielhafter Status

	// 5. Das aktualisierte DPP-Objekt in JSON umwandeln.
	dppJSON, err := json.Marshal(dpp)
	if err != nil {
		return fmt.Errorf("fehler beim Marshalling des aktualisierten DPP %s: %v", id, err)
	}

	// 6. Das aktualisierte JSON-Objekt im Ledger speichern (überschreibt den alten Eintrag).
	err = ctx.GetStub().PutState(id, dppJSON)
	if err != nil {
		return fmt.Errorf("fehler beim Speichern des transferierten DPP %s im Ledger: %v", id, err)
	}
	fmt.Printf("DPP %s erfolgreich an %s transferiert.\n", id, neueEigentuemerOrgMSP)
	return nil
}

// DPPExists prüft, ob ein DPP mit der gegebenen ID im World State existiert.
// Hilfsfunktion, die intern verwendet wird.
func (s *SmartContract) DPPExists(ctx contractapi.TransactionContextInterface, id string) (bool, error) {
	dppJSON, err := ctx.GetStub().GetState(id)
	if err != nil {
		return false, fmt.Errorf("fehler beim Lesen vom World State bei Existenzprüfung für DPP %s: %v", id, err)
	}
	return dppJSON != nil, nil // Gibt true zurück, wenn Daten gefunden wurden (nicht nil)
}




// main ist der Einstiegspunkt für den Chaincode-Prozess.
// Diese Funktion wird von Hyperledger Fabric aufgerufen, um den Chaincode zu starten.
func main() {
	// Erstellt eine neue Instanz unseres Smart Contracts.
	dppChaincode, err := contractapi.NewChaincode(&SmartContract{})
	if err != nil {
		fmt.Printf("Fehler beim Erstellen des dpp_transfer_chaincode: %s", err.Error())
		return
	}

	// Startet den Chaincode. Ab hier übernimmt die fabric-contract-api die Bearbeitung von Anfragen.
	if err := dppChaincode.Start(); err != nil {
		fmt.Printf("Fehler beim Starten des dpp_transfer_chaincode: %s", err.Error())
	}
}
