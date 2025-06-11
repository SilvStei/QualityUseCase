#!/bin/bash
#
# Skript zum automatisierten Aufsetzen eines Hyperledger Fabric Test-Netzwerks
# mit drei Organisationen (Org1, Org2, Org3) und Deployment des DPP-Chaincodes.

# --- Konfiguration ---
FABRIC_SAMPLES_DIR="${HOME}/Masterthesis/fabric-samples"
PROJECT_DIR="${HOME}/Masterthesis/QualityUseCase" # Dein Projektverzeichnis
CHAINCODE_SRC_FOLDER_NAME="dpp_quality"          # Der Name des Ordners mit deinem Chaincode-Quellcode
CHAINCODE_NAME="dpptransfer"
CHANNEL_NAME="mychannel"
CHAINCODE_LABEL="${CHAINCODE_NAME}_1.0" # Label für das Chaincode-Paket
CHAINCODE_VERSION="1.0"                 # Version des Chaincodes
CHAINCODE_SEQUENCE=1                    # Erste Sequenz für das 3-Org-Setup

# Pfad zum Chaincode relativ zum fabric-samples/test-network Verzeichnis
CC_PATH_FOR_PACKAGE="${PROJECT_DIR}/chaincode/${CHAINCODE_SRC_FOLDER_NAME}" # Absoluter oder relativer Pfad zum CC Source

# Endorsement Policy für alle drei Organisationen
ENDORSEMENT_POLICY_ORG1_ORG2_ORG3="OR('Org1MSP.peer','Org2MSP.peer','Org3MSP.peer')"

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
cd "${FABRIC_SAMPLES_DIR}/test-network/addOrg3"
if [ -f "./addOrg3.sh" ]; then
  ./addOrg3.sh down || warnln "Herunterfahren von Org3-Komponenten fehlgeschlagen oder nicht notwendig (ignoriert)."
else
  warnln "addOrg3.sh nicht gefunden in $(pwd), wird übersprungen."
fi

cd "${FABRIC_SAMPLES_DIR}/test-network"
./network.sh down

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
cd "${FABRIC_SAMPLES_DIR}/test-network/addOrg3"
infoln "Führe addOrg3.sh aus, um Org3 hinzuzufügen und dessen CA und Peer zu starten..."
./addOrg3.sh up -ca

infoln "Überprüfe Docker-Container nach Hinzufügen von Org3..."
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "peer0.org1.example.com|peer0.org2.example.com|peer0.org3.example.com|ca_org1|ca_org2|ca_org3|orderer.example.com" || true

if [ ! -f "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org3.example.com/connection-org3.json" ]; then
    errorln "Connection Profile für Org3 wurde nicht erstellt. Fehler beim Hinzufügen von Org3."
    exit 1
fi
infoln "Org3 wurde dem Channel hinzugefügt und Peer/CA sind gestartet."

# --- Schritt 3: Chaincode für ALLE drei Organisationen deployen (explizite Lifecycle-Schritte) ---
infoln "\n--- Schritt 3: Chaincode für alle drei Organisationen deployen ---"
cd "${FABRIC_SAMPLES_DIR}/test-network"

# Umgebungsvariablen für Peer-Befehle
export PATH=${FABRIC_SAMPLES_DIR}/bin:$PATH
export FABRIC_CFG_PATH=${FABRIC_SAMPLES_DIR}/config/

infoln "Erstelle Chaincode-Paket '${CHAINCODE_LABEL}.tar.gz'..."
peer lifecycle chaincode package ${CHAINCODE_NAME}.tar.gz --path "${CC_PATH_FOR_PACKAGE}" --lang golang --label "${CHAINCODE_LABEL}"

# Installiere Chaincode auf allen Peers
ORG_NUMS=(1 2 3)
PEER_PORTS=(7051 9051 11051) # Ports für peer0.org1, peer0.org2, peer0.org3

PACKAGE_ID="" # Wird nach der ersten Installation gesetzt

for i in ${!ORG_NUMS[@]}; do
  ORG=${ORG_NUMS[$i]}
  PEER_PORT=${PEER_PORTS[$i]}
  infoln "Installiere Chaincode auf peer0.org${ORG}.example.com..."
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp
  export CORE_PEER_ADDRESS=localhost:${PEER_PORT}
  
  peer lifecycle chaincode install ${CHAINCODE_NAME}.tar.gz
  if [ -z "$PACKAGE_ID" ]; then # Hole Package ID nach der ersten erfolgreichen Installation
    PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json | jq -r --arg PNAME "${CHAINCODE_LABEL}" '.installed_chaincodes[] | select(.label==$PNAME) | .package_id')
    if [ -z "$PACKAGE_ID" ]; then
      errorln "Konnte Package ID nach Installation auf Org${ORG} nicht ermitteln."
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
    --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3}"
done

infoln "Überprüfe Commit-Bereitschaft des Chaincodes auf dem Channel..."
# Umgebung für Org1 setzen, um checkcommitreadiness auszuführen
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051

peer lifecycle chaincode checkcommitreadiness --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" \
  --version "${CHAINCODE_VERSION}" --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3}" --output json | jq

infoln "Committe Chaincode-Definition auf dem Channel..."
peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "${FABRIC_SAMPLES_DIR}/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
  --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --version "${CHAINCODE_VERSION}" --sequence "${CHAINCODE_SEQUENCE}" \
  --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3}" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org2.example.com/tlsca/tlsca.org2.example.com-cert.pem" \
  --peerAddresses localhost:11051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org3.example.com/tlsca/tlsca.org3.example.com-cert.pem"

infoln "Überprüfe den committeten Chaincode auf dem Channel..."
peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --output json | jq

infoln "\n--- Netzwerk-Setup für 3 Organisationen abgeschlossen! ---"
infoln "Der Chaincode sollte jetzt auf allen Peers (Org1, Org2, Org3) laufen und von allen genehmigt sein."
infoln "Du kannst jetzt die Client-Anwendungen ausführen:"
infoln "1. cd ${PROJECT_DIR}/Anwendungen"
infoln "2. node unternehmenA_app.js (DPP ID notieren)"
infoln "3. unternehmenB_app.js anpassen (DPP ID eintragen, Transferziel Org3MSP) und ausführen: node unternehmenB_app.js"
infoln "4. unternehmenC_app.js anpassen (DPP ID eintragen) und ausführen: node unternehmenC_app.js"
