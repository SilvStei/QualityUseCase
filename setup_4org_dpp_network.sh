#!/bin/bash
#
# Skript zum automatisierten Aufsetzen eines Hyperledger Fabric Test-Netzwerks
# mit VIER Organisationen (Org1, Org2, Org3, Org4) und Deployment des DPP-Chaincodes.

# --- Konfiguration ---
FABRIC_SAMPLES_DIR="${HOME}/Masterthesis/fabric-samples"
PROJECT_DIR="${HOME}/Masterthesis/QualityUseCase" # Dein Projektverzeichnis
CHAINCODE_SRC_FOLDER_NAME="dpp_quality"          # Der Name des Ordners mit deinem Chaincode-Quellcode
CHAINCODE_NAME="dpp_quality_go_v2"
CHANNEL_NAME="mychannel"
CHAINCODE_LABEL="${CHAINCODE_NAME}_1.0" # Label für das Chaincode-Paket
CHAINCODE_VERSION="1.0"                 # Version des Chaincodes
CHAINCODE_SEQUENCE=1                    # Erste Sequenz für das 4-Org-Setup

CC_PATH_FOR_PACKAGE="${PROJECT_DIR}/chaincode/${CHAINCODE_SRC_FOLDER_NAME}"
ENDORSEMENT_POLICY_ORG1_ORG2_ORG3_ORG4="OR('Org1MSP.peer','Org2MSP.peer','Org3MSP.peer','Org4MSP.peer')"
ADD_ORG3_DIR="${FABRIC_SAMPLES_DIR}/test-network/addOrg3"
ADD_ORG4_DIR="${FABRIC_SAMPLES_DIR}/test-network/addOrg4"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

infoln() { echo -e "${GREEN}${1}${NC}"; }
errorln() { echo -e "${RED}${1}${NC}"; }
warnln() { echo -e "${YELLOW}${1}${NC}"; }

# Sicherstellen, dass Docker Compose Befehle korrekt sind (docker compose vs docker-compose)
CONTAINER_CLI="docker"
if command -v ${CONTAINER_CLI}-compose > /dev/null 2>&1; then
    CONTAINER_CLI_COMPOSE="${CONTAINER_CLI}-compose"
else
    CONTAINER_CLI_COMPOSE="${CONTAINER_CLI} compose"
fi
infoln "Verwende ${CONTAINER_CLI} und ${CONTAINER_CLI_COMPOSE} für Docker Compose Befehle."

set -e

# --- Schritt 0: Alles Herunterfahren und Bereinigen ---
infoln "--- Schritt 0: Netzwerk herunterfahren und bereinigen ---"

# Hilfsfunktion zum robusten Entfernen von Docker Volumes
remove_volume_if_exists() {
  local VOL_NAME=$1
  if docker volume inspect "$VOL_NAME" >/dev/null 2>&1; then
    infoln "Entferne Volume ${VOL_NAME}..."
    docker volume rm "$VOL_NAME" --force || warnln "Konnte Volume ${VOL_NAME} nicht entfernen."
  else
    warnln "Volume ${VOL_NAME} nicht gefunden."
  fi
}

# 1. AddOrg Komponenten herunterfahren
if [ -d "${ADD_ORG4_DIR}" ]; then
  infoln "Fahre Org4-Komponenten herunter..."
  (cd "${ADD_ORG4_DIR}" && ./addOrg4.sh down) || warnln "Herunterfahren von Org4 fehlgeschlagen/übersprungen."
else
  warnln "Verzeichnis ${ADD_ORG4_DIR} nicht gefunden."
fi

if [ -d "${ADD_ORG3_DIR}" ]; then
  infoln "Fahre Org3-Komponenten herunter..."
  (cd "${ADD_ORG3_DIR}" && ./addOrg3.sh down) || warnln "Herunterfahren von Org3 fehlgeschlagen/übersprungen."
else
  warnln "Verzeichnis ${ADD_ORG3_DIR} nicht gefunden."
fi

# 2. Basisnetzwerk herunterfahren
infoln "Fahre Basisnetzwerk herunter..."
(cd "${FABRIC_SAMPLES_DIR}/test-network" && ./network.sh down) || warnln "Herunterfahren des Basisnetzwerks fehlgeschlagen/übersprungen."

# 3. Explizit Docker-Netzwerk entfernen
infoln "Entferne Docker-Netzwerk 'fabric_test' explizit..."
if ! docker network rm fabric_test >/dev/null 2>&1; then
    warnln "Netzwerk 'fabric_test' nicht gefunden oder konnte nicht entfernt werden (dies ist oft OK)."
fi

# 4. Host-Pfade für CAs bereinigen (wichtig für frische CA-Initialisierung)
ORG3_CA_HOST_DIR="${ADD_ORG3_DIR}/fabric-ca/org3"
ORG4_CA_HOST_DIR="${ADD_ORG4_DIR}/fabric-ca/org4"
BASE_ORG1_CA_HOST_DIR="${FABRIC_SAMPLES_DIR}/test-network/organizations/fabric-ca/org1"
BASE_ORG2_CA_HOST_DIR="${FABRIC_SAMPLES_DIR}/test-network/organizations/fabric-ca/org2"
BASE_ORDERER_CA_HOST_DIR="${FABRIC_SAMPLES_DIR}/test-network/organizations/fabric-ca/ordererOrg"

cleanup_ca_host_dir() {
  local CA_DIR_PATH=$1
  local ORG_NAME_FOR_LOG=$(basename "$CA_DIR_PATH")
  local CONFIG_FILE="fabric-ca-server-config.yaml"

  if [ -d "$CA_DIR_PATH" ]; then
    infoln "Bereinige CA-Host-Verzeichnis für ${ORG_NAME_FOR_LOG}: ${CA_DIR_PATH} (behalte ${CONFIG_FILE})"
    # Iteriere über alle Elemente (Dateien und Verzeichnisse) direkt in CA_DIR_PATH
    # Diese Schleife behandelt auch versteckte Dateien/Verzeichnisse im obersten Level des CA_DIR_PATH
    for item in "$CA_DIR_PATH"/* "$CA_DIR_PATH"/.*; do
      if [ -e "$item" ]; then # Überprüfe, ob das Element existiert (wichtig für Glob-Muster)
        local item_basename=$(basename "$item")
        # Überspringe die Konfigurationsdatei, sowie "." und ".."
        if [ "$item_basename" != "$CONFIG_FILE" ] && [ "$item_basename" != "." ] && [ "$item_basename" != ".." ]; then
          infoln "  Entferne: $item"
          sudo rm -rf "$item"
        fi
      fi
    done
    # Stelle sicher, dass das Verzeichnis selbst noch existiert und die korrekten Berechtigungen hat
    sudo mkdir -p "$CA_DIR_PATH" # Erstellt das Verzeichnis, falls es durch rm -rf eines Unterordners gelöscht wurde (unwahrscheinlich bei dieser Logik)
    sudo chmod -R 777 "$CA_DIR_PATH" # Setzt Berechtigungen
  else
    warnln "CA-Host-Verzeichnis ${CA_DIR_PATH} für ${ORG_NAME_FOR_LOG} nicht gefunden."
  fi
}

# CA-Daten für Org4 bereinigen
cleanup_ca_host_dir "$ORG4_CA_HOST_DIR"

# CA-Daten für Org3 bereinigen
cleanup_ca_host_dir "$ORG3_CA_HOST_DIR"

# CA-Daten für Basis-Organisationen bereinigen (optional, network.sh down sollte dies tun)
# cleanup_ca_host_dir "$BASE_ORG1_CA_HOST_DIR"
# cleanup_ca_host_dir "$BASE_ORG2_CA_HOST_DIR"
# cleanup_ca_host_dir "$BASE_ORDERER_CA_HOST_DIR"

# 5. Ungenutzte Docker Volumes entfernen
infoln "Entferne ungenutzte Docker-Volumes..."
docker volume prune -f
infoln "Zweiter Durchlauf für Docker Volume Prune zur Sicherheit..."
docker volume prune -f

# 6. Client Wallet leeren
infoln "Leere Client-Wallet..."
rm -rf "${PROJECT_DIR}/Anwendungen/wallet/"*
mkdir -p "${PROJECT_DIR}/Anwendungen/wallet"

# --- Ledger-Bereinigung (Peer0) für Org3 & Org4 ---
infoln "Bereinige Ledger-Daten von Peer0.org3 und Peer0.org4, falls vorhanden..."
LEDGER_BASE_ORG3="${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org3.example.com/peers/peer0.org3.example.com"
LEDGER_BASE_ORG4="${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org4.example.com/peers/peer0.org4.example.com"

LEDGER_PATH_SUFFIX_1="production"
LEDGER_PATH_SUFFIX_2="ledgersData"

cleanup_ledger_data() {
    local PEER_BASE_DIR=$1
    local ORG_NAME_FOR_LOG=$(basename "$(dirname "$(dirname "$PEER_BASE_DIR")")")

    if [ -d "${PEER_BASE_DIR}/${LEDGER_PATH_SUFFIX_1}" ]; then
      infoln "  Entferne Ledger-Daten (${LEDGER_PATH_SUFFIX_1}) für ${ORG_NAME_FOR_LOG}..."
      sudo rm -rf "${PEER_BASE_DIR}/${LEDGER_PATH_SUFFIX_1}"
    elif [ -d "${PEER_BASE_DIR}/${LEDGER_PATH_SUFFIX_2}" ]; then
      infoln "  Entferne Ledger-Daten (${LEDGER_PATH_SUFFIX_2}) für ${ORG_NAME_FOR_LOG}..."
      sudo rm -rf "${PEER_BASE_DIR}/${LEDGER_PATH_SUFFIX_2}"
    else
      warnln "  Keine bekannten Ledger-Daten-Verzeichnisse für ${ORG_NAME_FOR_LOG} unter ${PEER_BASE_DIR} gefunden."
    fi
}

if [ -d "$LEDGER_BASE_ORG3" ]; then
  cleanup_ledger_data "$LEDGER_BASE_ORG3"
fi

if [ -d "$LEDGER_BASE_ORG4" ]; then
  cleanup_ledger_data "$LEDGER_BASE_ORG4"
fi


# --- Schritt 1: Basisnetzwerk (Org1 & Org2) starten ---
# ... (Rest deines Skripts bleibt unverändert) ...
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

infoln "Warte 5 Sekunden zur Stabilisierung..."
sleep 5

# --- Schritt 2.5: Org4 zum Netzwerk hinzufügen (MIT CA) ---
infoln "\n--- Schritt 2.5: Org4 zum Netzwerk hinzufügen (mit CA) ---"
if [ -d "${ADD_ORG4_DIR}" ]; then
  cd "${ADD_ORG4_DIR}"
  infoln "Führe addOrg4.sh aus, um Org4 hinzuzufügen und dessen CA und Peer zu starten..."
  ./addOrg4.sh up -ca 

  infoln "Überprüfe Docker-Container nach Hinzufügen von Org4..."
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

infoln "Warte 5 Sekunden zur Stabilisierung..."
sleep 5

# --- Schritt 3: Chaincode für ALLE VIER Organisationen deployen (explizite Lifecycle-Schritte) ---
infoln "\n--- Schritt 3: Chaincode für alle vier Organisationen deployen ---"
cd "${FABRIC_SAMPLES_DIR}/test-network"

export PATH=${FABRIC_SAMPLES_DIR}/bin:$PATH
export FABRIC_CFG_PATH=${FABRIC_SAMPLES_DIR}/config/

infoln "Erstelle Chaincode-Paket '${CHAINCODE_LABEL}.tar.gz'..."
peer lifecycle chaincode package ${CHAINCODE_NAME}.tar.gz --path "${CC_PATH_FOR_PACKAGE}" --lang golang --label "${CHAINCODE_LABEL}"

ORG_NUMS=(1 2 3 4) 
PEER_PORTS=(7051 9051 11051 13051) 
PACKAGE_ID="" 

for i in ${!ORG_NUMS[@]}; do
  ORG=${ORG_NUMS[$i]}
  PEER_PORT=${PEER_PORTS[$i]}
  infoln "Installiere Chaincode auf peer0.org${ORG}.example.com..."
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp
  export CORE_PEER_ADDRESS=localhost:${PEER_PORT}
  export CORE_PEER_TLS_ENABLED=true
  
  infoln "Warte 2 Sekunden vor Installation auf Org${ORG}..."
  sleep 2

  peer lifecycle chaincode install ${CHAINCODE_NAME}.tar.gz
  
  if [ -z "$PACKAGE_ID" ]; then 
    PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json | jq -r --arg PNAME "${CHAINCODE_LABEL}" '.installed_chaincodes[] | select(.label==$PNAME) | .package_id')
    if [ -z "$PACKAGE_ID" ] || [ "$PACKAGE_ID" == "null" ]; then
      errorln "Konnte Package ID nach Installation auf Org${ORG} nicht ermitteln. Ausgabe von queryinstalled:"
      peer lifecycle chaincode queryinstalled --output json | jq
      PACKAGE_ID_ALT=$(peer lifecycle chaincode queryinstalled | grep "Package ID: ${CHAINCODE_LABEL}:" | sed -n 's/Package ID: //; s/, Label:.*$//p')
        if [ -n "$PACKAGE_ID_ALT" ]; then
          warnln "Alternative Methode zur Extraktion der Package ID verwendet."
          PACKAGE_ID=$PACKAGE_ID_ALT
        else
          errorln "Konnte Package ID auch mit alternativer Methode nicht finden."
          exit 1
        fi
    fi
    PACKAGE_ID=$(echo "$PACKAGE_ID" | xargs) 
    if [ -z "$PACKAGE_ID" ]; then
        errorln "Package ID ist leer nach Bereinigung."
        exit 1
    fi
    infoln "Chaincode Package ID: ${PACKAGE_ID}"
  fi
done

for i in ${!ORG_NUMS[@]}; do
  ORG=${ORG_NUMS[$i]}
  PEER_PORT=${PEER_PORTS[$i]}
  infoln "Genehmige Chaincode-Definition für Org${ORG}MSP..."
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt
  export CORE_PEER_MSPCONFIGPATH=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp
  export CORE_PEER_ADDRESS=localhost:${PEER_PORT}
  export CORE_PEER_TLS_ENABLED=true

  peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "${FABRIC_SAMPLES_DIR}/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
    --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --version "${CHAINCODE_VERSION}" --package-id "${PACKAGE_ID}" \
    --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3_ORG4}"
done

infoln "Überprüfe Commit-Bereitschaft des Chaincodes auf dem Channel..."
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051 
export CORE_PEER_TLS_ENABLED=true

peer lifecycle chaincode checkcommitreadiness --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" \
  --version "${CHAINCODE_VERSION}" --sequence "${CHAINCODE_SEQUENCE}" --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3_ORG4}" --output json | jq 

infoln "Committe Chaincode-Definition auf dem Channel..."
peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "${FABRIC_SAMPLES_DIR}/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
  --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --version "${CHAINCODE_VERSION}" --sequence "${CHAINCODE_SEQUENCE}" \
  --signature-policy "${ENDORSEMENT_POLICY_ORG1_ORG2_ORG3_ORG4}" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org2.example.com/tlsca/tlsca.org2.example.com-cert.pem" \
  --peerAddresses localhost:11051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org3.example.com/tlsca/tlsca.org3.example.com-cert.pem" \
  --peerAddresses localhost:13051 --tlsRootCertFiles "${FABRIC_SAMPLES_DIR}/test-network/organizations/peerOrganizations/org4.example.com/tlsca/tlsca.org4.example.com-cert.pem"

infoln "Überprüfe den committeten Chaincode auf dem Channel (für 4 Orgs)..."
peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --output json | jq

infoln "\n--- Netzwerk-Setup für 4 Organisationen abgeschlossen! ---"
infoln "Der Chaincode sollte jetzt auf allen Peers (Org1, Org2, Org3, Org4) laufen und von allen genehmigt sein."
infoln "Du kannst jetzt die Client-Anwendungen ausführen (Beispielhafte Reihenfolge):"
infoln "1. cd ${PROJECT_DIR}/Anwendungen"
infoln "2. node unternehmenA_app.js (DPP ID notieren, repräsentiert Org1)"
infoln "3. unternehmenB_app.js anpassen (DPP ID eintragen, Transferziel z.B. Org3MSP) und ausführen: node unternehmenB_app.js (repräsentiert Org2)"
infoln "4. unternehmenC_app.js anpassen (DPP ID eintragen) und ausführen: node unternehmenC_app.js (repräsentiert Org3)"
infoln "5. unternehmenD_app_v2.js anpassen (DPP ID eintragen) und ausführen: node unternehmenD_app_v2.js (repräsentiert Org4)"