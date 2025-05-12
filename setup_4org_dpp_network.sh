#!/bin/bash
#
# Skript zum automatisierten Aufsetzen eines Hyperledger Fabric Test-Netzwerks
# mit VIER Organisationen (Org1, Org2, Org3, Org4) und Deployment des DPP-Chaincodes.

# --- Konfiguration ---
FABRIC_SAMPLES_DIR="${HOME}/Masterthesis/fabric-samples"
PROJECT_DIR="${HOME}/Masterthesis/QualityUseCase" # Dein Projektverzeichnis
CHAINCODE_SRC_FOLDER_NAME="dpp_quality"         # Der Name des Ordners mit deinem Chaincode-Quellcode
CHAINCODE_NAME="dpptransfer"
CHANNEL_NAME="mychannel"
CHAINCODE_LABEL="${CHAINCODE_NAME}_1.0" # Label für das Chaincode-Paket
CHAINCODE_VERSION="1.0"                 # Version des Chaincodes
CHAINCODE_SEQUENCE=1                    # Erste Sequenz für das 4-Org-Setup

# Pfad zum Chaincode relativ zum fabric-samples/test-network Verzeichnis
CC_PATH_FOR_PACKAGE="${PROJECT_DIR}/chaincode/${CHAINCODE_SRC_FOLDER_NAME}" # Absoluter oder relativer Pfad zum CC Source

# Endorsement Policy für alle vier Organisationen
ENDORSEMENT_POLICY_ORG1_ORG2_ORG3_ORG4="OR('Org1MSP.peer','Org2MSP.peer','Org3MSP.peer','Org4MSP.peer')"

# Verzeichnisse für AddOrg Skripte
ADD_ORG3_DIR="${FABRIC_SAMPLES_DIR}/test-network/addOrg3"
ADD_ORG4_DIR="${FABRIC_SAMPLES_DIR}/test-network/addOrg4" # Pfad zu deinem addOrg4 Skript

# Funktion für farbige Ausgaben
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m' # Gelb für Warnungen
NC='\033[0m' # No Color

infoln() {
  echo -e "${GREEN}${1}${NC}"
}
errorln() {
  echo -e "${RED}${1}${NC}"
}
warnln() {
  echo -e "${YELLOW}${1}${NC}"
}

# Exit on first error
set -e

# --- Schritt 0: Alles Herunterfahren und Bereinigen ---
infoln "--- Schritt 0: Netzwerk herunterfahren und bereinigen ---"

# Zuerst Org4 herunterfahren
if [ -d "${ADD_ORG4_DIR}" ]; then
  cd "${ADD_ORG4_DIR}"
  if [ -f "./addOrg4.sh" ]; then
    ./addOrg4.sh down || warnln "Herunterfahren von Org4-Komponenten fehlgeschlagen oder nicht notwendig (ignoriert)."
  else
    warnln "addOrg4.sh nicht gefunden in $(pwd), wird übersprungen."
  fi
else
    warnln "Verzeichnis ${ADD_ORG4_DIR} nicht gefunden, Herunterfahren von Org4 übersprungen."
fi

# Dann Org3 herunterfahren
if [ -d "${ADD_ORG3_DIR}" ]; then
  cd "${ADD_ORG3_DIR}"
  if [ -f "./addOrg3.sh" ]; then
    ./addOrg3.sh down || warnln "Herunterfahren von Org3-Komponenten fehlgeschlagen oder nicht notwendig (ignoriert)."
  else
    warnln "addOrg3.sh nicht gefunden in $(pwd), wird übersprungen."
  fi
else
    warnln "Verzeichnis ${ADD_ORG3_DIR} nicht gefunden, Herunterfahren von Org3 übersprungen."
fi

# Dann das Basisnetzwerk herunterfahren
cd "${FABRIC_SAMPLES_DIR}/test-network"
./network.sh down

infoln "Volumes vor dem Löschen:"
docker volume ls # Zur Diagnose

# --- BEGINN EXPLIZITE LÖSCHUNG ---
# Passe die Namen ggf. an!
infoln "Entferne spezifische Volumes..."
infoln "Entferne spezifische Peer-Volumes (falls vorhanden)..."
docker volume rm $(docker volume ls -q | grep 'peer0.org3.example.com') || warnln "Volume für peer0.org3 nicht gefunden/entfernt."
docker volume rm $(docker volume ls -q | grep 'peer0.org4.example.com') || warnln "Volume für peer0.org4 nicht gefunden/entfernt."
# Und ggf. für die Basis-CAs, falls network.sh sie nicht immer entfernt:
docker volume rm $(docker volume ls -q | grep 'ca_org1') || warnln "Volume für ca_org1 nicht gefunden/entfernt."
docker volume rm $(docker volume ls -q | grep 'ca_org2') || warnln "Volume für ca_org2 nicht gefunden/entfernt."
docker volume rm $(docker volume ls -q | grep 'ca_orderer') || warnln "Volume für ca_orderer nicht gefunden/entfernt."

# Alternative mit grep (prüfe Pattern sorgfältig!)
# docker volume rm $(docker volume ls -q | grep 'peer0.org[34]\|ca_org[34]') || warnln "Einige AddOrg Volumes konnten nicht entfernt werden."
# --- ENDE EXPLIZITE LÖSCHUNG ---

infoln "Volumes nach dem Löschen:"
docker volume ls # Zur Diagnose

infoln "Entferne ungenutzte Docker-Volumes (kann einen Moment dauern)..."
docker volume prune -f

infoln "Leere Client-Wallet..."
rm -rf "${PROJECT_DIR}/Anwendungen/wallet/"*
mkdir -p "${PROJECT_DIR}/Anwendungen/wallet"

# --- Schritt 1: Basisnetzwerk (Org1 & Org2) starten ---
infoln "\n--- Schritt 1: Basisnetzwerk (Org1 & Org2) starten ---"
cd "${FABRIC_SAMPLES_DIR}/test-network"
infoln "Starte Basisnetzwerk mit Org1, Org2 und CAs und erstelle Channel..."
./network.sh up createChannel -ca

# --- Schritt 2: Org3 zum Netzwerk hinzufügen (MIT CA) ---
infoln "\n--- Schritt 2: Org3 zum Netzwerk hinzufügen (mit CA) ---"
if [ -d "${ADD_ORG3_DIR}" ]; then
  cd "${ADD_ORG3_DIR}"
  infoln "Führe addOrg3.sh aus, um Org3 hinzuzufügen und dessen CA und Peer zu starten..."
  ./addOrg3.sh up -ca

  infoln "Überprüfe Docker-Container nach Hinzufügen von Org3..."
  docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "peer0.org[1-3].example.com|ca_org[1-3]|orderer.example.com" || true

  if [ ! -f "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org3.example.com/connection-org3.json" ]; then
      errorln "Connection Profile für Org3 wurde nicht erstellt. Fehler beim Hinzufügen von Org3."
      exit 1
  fi
  infoln "Org3 wurde dem Channel hinzugefügt und Peer/CA sind gestartet."
else
    errorln "Verzeichnis ${ADD_ORG3_DIR} nicht gefunden. Kann Org3 nicht hinzufügen."
    exit 1
fi

# --- Schritt 2.5: Org4 zum Netzwerk hinzufügen (MIT CA) ---
infoln "\n--- Schritt 2.5: Org4 zum Netzwerk hinzufügen (mit CA) ---"
if [ -d "${ADD_ORG4_DIR}" ]; then
  cd "${ADD_ORG4_DIR}"
  infoln "Führe addOrg4.sh aus, um Org4 hinzuzufügen und dessen CA und Peer zu starten..."
  ./addOrg4.sh up -ca # Sicherstellen, dass dieses Skript existiert und funktioniert!

  infoln "Überprüfe Docker-Container nach Hinzufügen von Org4..."
  # Grep Pattern erweitert für Org1 bis Org4
  docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "peer0.org[1-4].example.com|ca_org[1-4]|orderer.example.com" || true

  if [ ! -f "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org4.example.com/connection-org4.json" ]; then
      errorln "Connection Profile für Org4 wurde nicht erstellt. Fehler beim Hinzufügen von Org4."
      exit 1
  fi
  infoln "Org4 wurde dem Channel hinzugefügt und Peer/CA sind gestartet."
else
    errorln "Verzeichnis ${ADD_ORG4_DIR} nicht gefunden. Kann Org4 nicht hinzufügen."
    exit 1
fi


# --- Schritt 3: Chaincode für ALLE VIER Organisationen deployen (explizite Lifecycle-Schritte) ---
infoln "\n--- Schritt 3: Chaincode für alle vier Organisationen deployen ---"
cd "${FABRIC_SAMPLES_DIR}/test-network"

# Umgebungsvariablen für Peer-Befehle
export PATH=${FABRIC_SAMPLES_DIR}/bin:$PATH
export FABRIC_CFG_PATH=${FABRIC_SAMPLES_DIR}/config/

infoln "Erstelle Chaincode-Paket '${CHAINCODE_LABEL}.tar.gz'..."
peer lifecycle chaincode package ${CHAINCODE_NAME}.tar.gz --path "${CC_PATH_FOR_PACKAGE}" --lang golang --label "${CHAINCODE_LABEL}"

# Installiere Chaincode auf allen Peers
ORG_NUMS=(1 2 3 4) # Org4 hinzugefügt
PEER_PORTS=(7051 9051 11051 13051) # Ports für peer0.org1, peer0.org2, peer0.org3, peer0.org4 (Port 13051 für Org4)

PACKAGE_ID="" # Wird nach der ersten Installation gesetzt

for i in ${!ORG_NUMS[@]}; do
  ORG=${ORG_NUMS[$i]}
  PEER_PORT=${PEER_PORTS[$i]}
  infoln "Installiere Chaincode auf peer0.org${ORG}.example.com..."
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp
  export CORE_PEER_ADDRESS=localhost:${PEER_PORT}
  export CORE_PEER_TLS_ENABLED=true
  infoln "sleep 1"
  sleep 1


infoln "Prüfe Existenz von core.yaml:"
ls -l "${FABRIC_CFG_PATH}/core.yaml" || errorln "core.yaml NICHT GEFUNDEN unter ${FABRIC_CFG_PATH}"

infoln "Prüfe Existenz des Admin-Signaturzertifikats:"
ls -l "${CORE_PEER_MSPCONFIGPATH}/signcerts/"* || errorln "Admin signcerts NICHT GEFUNDEN unter ${CORE_PEER_MSPCONFIGPATH}"

infoln "Prüfe Existenz des Chaincode-Pakets:"
ls -l "${CHAINCODE_NAME}.tar.gz" || errorln "Chaincode-Paket ${CHAINCODE_NAME}.tar.gz NICHT GEFUNDEN in $(pwd)"
infoln "--- DEBUG INFO ENDE ---"
  peer lifecycle chaincode install ${CHAINCODE_NAME}.tar.gz
  if [ -z "$PACKAGE_ID" ]; then # Hole Package ID nach der ersten erfolgreichen Installation
    # Prüfe installierte Chaincodes und extrahiere die ID für unser Label
    PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json | jq -r --arg PNAME "${CHAINCODE_LABEL}" '.installed_chaincodes[] | select(.label==$PNAME) | .package_id')
    # Überprüfe, ob die PACKAGE_ID gefunden wurde
    if [ -z "$PACKAGE_ID" ] || [ "$PACKAGE_ID" == "null" ]; then
      errorln "Konnte Package ID nach Installation auf Org${ORG} nicht ermitteln. Ausgabe von queryinstalled:"
      peer lifecycle chaincode queryinstalled --output json | jq
      # Versuche es mit einer älteren jq-Syntax, falls die obige fehlschlägt
      PACKAGE_ID_ALT=$(peer lifecycle chaincode queryinstalled | grep "Package ID: ${CHAINCODE_LABEL}:" | sed -n 's/Package ID: //; s/, Label:.*$//p')
       if [ -n "$PACKAGE_ID_ALT" ]; then
          warnln "Alternative Methode zur Extraktion der Package ID verwendet."
          PACKAGE_ID=$PACKAGE_ID_ALT
       else
          errorln "Konnte Package ID auch mit alternativer Methode nicht finden."
          exit 1
       fi
    fi
    # Stelle sicher, dass keine Leerzeichen am Anfang/Ende sind
    PACKAGE_ID=$(echo $PACKAGE_ID | xargs)
    if [ -z "$PACKAGE_ID" ]; then
        errorln "Package ID ist leer nach Bereinigung."
        exit 1
    fi
    infoln "Chaincode Package ID: ${PACKAGE_ID}"
  fi
done

# Genehmige Chaincode-Definition für alle Organisationen
for i in ${!ORG_NUMS[@]}; do
  ORG=${ORG_NUMS[$i]}
  PEER_PORT=${PEER_PORTS[$i]}
  infoln "Genehmige Chaincode-Definition für Org${ORG}MSP..."
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp
  export CORE_PEER_ADDRESS=localhost:${PEER_PORT}

  peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "${FABRIC_SAMPLES_DIR}/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
    --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --version "${CHAINCODE_VERSION}" --package-id "${PACKAGE_ID}" \
    --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3_ORG4}" # Policy für 4 Orgs
done

infoln "Überprüfe Commit-Bereitschaft des Chaincodes auf dem Channel..."
# Umgebung für Org1 setzen, um checkcommitreadiness auszuführen
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051 # Peer von Org1

peer lifecycle chaincode checkcommitreadiness --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" \
  --version "${CHAINCODE_VERSION}" --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3_ORG4}" --output json | jq # Policy für 4 Orgs

infoln "Committe Chaincode-Definition auf dem Channel..."
# Verwende wieder den Peer von Org1 zum Senden des Commits
peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "${FABRIC_SAMPLES_DIR}/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
  --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --version "${CHAINCODE_VERSION}" --sequence "${CHAINCODE_SEQUENCE}" \
  --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3_ORG4}" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org2.example.com/tlsca/tlsca.org2.example.com-cert.pem" \
  --peerAddresses localhost:11051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org3.example.com/tlsca/tlsca.org3.example.com-cert.pem" \
  --peerAddresses localhost:13051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org4.example.com/tlsca/tlsca.org4.example.com-cert.pem" # Org4 Peer hinzugefügt

infoln "Überprüfe den committeten Chaincode auf dem Channel (für 4 Orgs)..."
peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --output json | jq

infoln "\n--- Netzwerk-Setup für 4 Organisationen abgeschlossen! ---"
infoln "Der Chaincode sollte jetzt auf allen Peers (Org1, Org2, Org3, Org4) laufen und von allen genehmigt sein."
# Passe ggf. die Anweisungen für die Client-Anwendungen an, falls Org4 eine eigene App benötigt
infoln "Du kannst jetzt die Client-Anwendungen ausführen (Beispielhafte Reihenfolge):"
infoln "1. cd ${PROJECT_DIR}/Anwendungen"
infoln "2. node unternehmenA_app.js (DPP ID notieren, repräsentiert Org1)"
infoln "3. unternehmenB_app.js anpassen (DPP ID eintragen, Transferziel z.B. Org3MSP) und ausführen: node unternehmenB_app.js (repräsentiert Org2)"
infoln "4. unternehmenC_app.js anpassen (DPP ID eintragen) und ausführen: node unternehmenC_app.js (repräsentiert Org3)"
# Füge hier ggf. Schritte für eine Org4-Anwendung hinzu
# infoln "5. unternehmenD_app.js anpassen (DPP ID eintragen) und ausführen: node unternehmenD_app.js (repräsentiert Org4)"