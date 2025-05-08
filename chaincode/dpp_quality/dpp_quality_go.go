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

// DPP definiert die Struktur unseres Digitalen Produktpasses.
// Die `json:"..."`-Tags sind wichtig für die (De-)Serialisierung nach/von JSON,
// wenn Daten im Ledger gespeichert oder von dort gelesen werden.
type DPP struct {
	ID             string `json:"ID"`             // Eindeutige Identifikationsnummer des DPPs
	Beschreibung   string `json:"beschreibung"`   // Eine kurze Beschreibung des Produkts
	EigentuemerOrg string `json:"eigentuemerOrg"` // Die MSPID der Organisation, der das Produkt aktuell gehört
	Status         string `json:"status"`         // Ein Statusfeld, z.B. "Erstellt", "Transferiert", "Geprüft"
	// Hier könnten später viele weitere Felder hinzukommen:
	// Produktionsdatum, Materialzusammensetzung, Qualitätsprüfungs-IDs, Sensorwerte-Hashes etc.
}

// InitLedger ist eine optionale Funktion, um den Ledger mit Beispieldaten zu initialisieren.
// Sie wird typischerweise einmalig beim Instanziieren des Chaincodes aufgerufen.
// Für unseren direkten Test ist sie nicht zwingend, aber nützlich für Demonstrationen.
func (s *SmartContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	dpps := []DPP{
		{ID: "DPP_INIT_001", Beschreibung: "Testprodukt1 von Org1", EigentuemerOrg: "Org1MSP", Status: "InitialBeiOrg1"},
		{ID: "DPP_INIT_002", Beschreibung: "Testprodukt2 von Org2", EigentuemerOrg: "Org2MSP", Status: "InitialBeiOrg2"},
	}

	for _, dpp := range dpps {
		dppJSON, err := json.Marshal(dpp) // DPP-Objekt in JSON umwandeln
		if err != nil {
			return fmt.Errorf("Fehler beim Marshalling von DPP %s: %v", dpp.ID, err)
		}

		err = ctx.GetStub().PutState(dpp.ID, dppJSON) // JSON-Daten unter der DPP-ID im Ledger speichern
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
	// 1. Prüfen, ob ein DPP mit dieser ID bereits existiert.
	exists, err := s.DPPExists(ctx, id)
	if err != nil {
		return fmt.Errorf("Fehler bei der Prüfung der Existenz von DPP %s: %v", id, err)
	}
	if exists {
		return fmt.Errorf("der DPP %s existiert bereits", id)
	}

	// 2. Die Identität (MSPID) der aufrufenden Organisation ermitteln.
	// Diese Organisation wird der erste Eigentümer des DPPs.
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("fehler beim Abrufen der MSPID des Clients: %v", err)
	}

	// 3. Das DPP-Objekt erstellen.
	dpp := DPP{
		ID:             id,
		Beschreibung:   beschreibung,
		EigentuemerOrg: clientMSPID, // Der Aufrufer ist der erste Eigentümer
		Status:         status,
	}

	// 4. Das DPP-Objekt in JSON umwandeln.
	dppJSON, err := json.Marshal(dpp)
	if err != nil {
		return fmt.Errorf("fehler beim Marshalling des DPP %s: %v", id, err)
	}

	// 5. Das JSON-Objekt im Ledger unter der DPP-ID speichern.
	// PutState ist die Funktion, um Daten ins Ledger zu schreiben.
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
