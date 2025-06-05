#!/usr/bin/env bash
# =================================================================================================
# Hyperledger Fabric Test‑Netzwerk (4 Organisationen) – **JavaScript‑Chaincode Edition**
# -------------------------------------------------------------------------------------------------
# Baut das komplette Test‑Netz auf und deployed den DPP‑Chaincode (Node.js). 05. 06. 2025
#  ⬇️  **Neu in dieser Version**
#      • entfernt *node_modules* vor dem Packaging → deutlich kleineres CC‑Archiv
#      • setzt längeren Install‑Timeout auf Peer‑Seite (optional)
#      • robusteres „Schritt 0 down & clean“  → ignoriert harmlose Fehler‑Exit‑Codes
#      • ❗ v0.6 (05.‑06.‑2025):  Exit‑Abbruch in Schritt 0 behoben  ↝  »set +e … set -e«‑Klammer  +  Wallet‑Cleanup fix
#      • ❗ v0.7 (05.‑06.‑2025):  Commit‑Step ergänzt fehlenden  --sequence  &  --signature‑policy  und adressiert jetzt alle Peers
# =================================================================================================
# 👉  WICHTIG: Script immer aus  ~/Masterthesis/QualityUseCase  aufrufen  (Pfad‑Konstanten unten)

# 1) Shell‑Einstellungen --------------------------------------------------------------------------
#    • ‘-e’  →  bei echtem Fehler abbrechen (außerhalb von Schritt 0)
#    • ‘-o pipefail’  →  liefert Fehlerstatus aus Pipes korrekt weiter
#    🔸  kein ‘-u’ mehr (sonst bricht leerer String ab)
set -eo pipefail

# ▸ Farben für Logs -------------------------------------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
err()  { echo -e "${RED}$1${NC}"; }

# 2) Konfiguration --------------------------------------------------------------------------------
FABRIC_SAMPLES_DIR="$HOME/Masterthesis/fabric-samples"
PROJECT_DIR="$HOME/Masterthesis/QualityUseCase"

CHAINCODE_SRC_FOLDER_NAME="dpp_quality"      # ./chaincode/dpp_quality
CHAINCODE_NAME="dpp_quality"
CHAINCODE_VERSION="1.0"
CHAINCODE_LABEL="${CHAINCODE_NAME}_${CHAINCODE_VERSION}"

CHANNEL_NAME="mychannel"
CHAINCODE_SEQUENCE=1
ENDORSEMENT_POLICY="OR('Org1MSP.peer','Org2MSP.peer','Org3MSP.peer','Org4MSP.peer')"

ADD_ORG3_DIR="${FABRIC_SAMPLES_DIR}/test-network/addOrg3"
ADD_ORG4_DIR="${FABRIC_SAMPLES_DIR}/test-network/addOrg4"

CC_PATH_FOR_PACKAGE="${PROJECT_DIR}/chaincode/${CHAINCODE_SRC_FOLDER_NAME}"

# (Optional) längeres Install‑Timeout – hilft bei großen Paketen
export CORE_PEER_CLIENTCONNTIMEOUT=600000

# 3) Docker‑Compose CLI ermitteln -----------------------------------------------------------------
COMPOSE_CMD=$(command -v docker-compose &>/dev/null && echo "docker-compose" || echo "docker compose")
log "Nutze '${COMPOSE_CMD}' für Compose‑Befehle."

# 4) Hilfsfunktionen ------------------------------------------------------------------------------
remove_volume_if_exists() {
  local VOL=$1
  docker volume inspect "$VOL" &>/dev/null && sudo docker volume rm "$VOL" --force &>/dev/null && \
    log "   • Volume $VOL entfernt" || true
}

cleanup_ca_host_dir() {
  local D=$1 CFG="fabric-ca-server-config.yaml"
  [[ -d "$D" ]] || return 0
  log "   • Bereinige CA‑Daten in $D (Konfig bleibt)"
  shopt -s dotglob nullglob
  for f in "$D"/*; do
    [[ $(basename "$f") == "$CFG" ]] && continue
    sudo rm -rf "$f" 2>/dev/null || true
  done
  shopt -u dotglob nullglob
  sudo chmod -R 777 "$D" 2>/dev/null || true
}

cleanup_ledger_data() {
  local P=$1
  [[ -d "$P/production"    ]] && { sudo rm -rf "$P/production"    2>/dev/null || true; log "   • Ledger‑Daten (production) entfernt"; }
  [[ -d "$P/ledgersData"   ]] && { sudo rm -rf "$P/ledgersData"   2>/dev/null || true; log "   • Ledger‑Daten (ledgersData) entfernt"; }
}

# =================================================================================================
# Schritt 0 – Netzwerk herunterfahren & Umgebung reinigen
# =================================================================================================
log "\n────────────────────────────────────────────────────────────────────────────"
log "Schritt 0 : Netzwerk herunterfahren & Umgebung reinigen"
log "────────────────────────────────────────────────────────────────────────────"

# ▸ 0.1  ▼  shell auf *tolerant* schalten – damit harmlose Docker‑Fehler nicht abbrechen
set +e

# down‑Skripte (ignorieren Fehl‑Exit)
[[ -d "$ADD_ORG4_DIR" ]] && (cd "$ADD_ORG4_DIR" && ./addOrg4.sh down &>/dev/null) || warn "Org4 down übersprungen"
[[ -d "$ADD_ORG3_DIR" ]] && (cd "$ADD_ORG3_DIR" && ./addOrg3.sh down &>/dev/null) || warn "Org3 down übersprungen"
(cd "$FABRIC_SAMPLES_DIR/test-network" && ./network.sh down &>/dev/null) || true

# Volumes & Netzwerke
for vol in compose_peer0.org{1..4}.example.com compose_orderer.example.com \
           docker_orderer.example.com docker_peer0.org{1..4}.example.com; do
  remove_volume_if_exists "$vol"
done
sudo docker network rm fabric_test &>/dev/null || true
sudo docker volume prune -f &>/dev/null || true

# CA‑Daten bereinigen
cleanup_ca_host_dir "$ADD_ORG3_DIR/fabric-ca/org3"
cleanup_ca_host_dir "$ADD_ORG4_DIR/fabric-ca/org4"

# Wallets (Ordner erst anlegen, *dann* Inhalt killen → kein Glob‑Fehler mehr)
for w in wallet walletA walletB walletC walletD; do
  mkdir -p "$PROJECT_DIR/Anwendungen/$w"
  rm -rf "$PROJECT_DIR/Anwendungen/$w"/* 2>/dev/null || true
done

# alte Ledger‑Artefakte
cleanup_ledger_data "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org3.example.com/peers/peer0.org3.example.com"
cleanup_ledger_data "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org4.example.com/peers/peer0.org4.example.com"

# ▸ 0.2  ▲  Fehler wieder fatal   --------------------------------------------
set -e

# =================================================================================================
# Schritt 1 – Basis­netz (Org1 + Org2) hochfahren
# =================================================================================================
log "\n────────────────────────────────────────────────────────────────────────────"
log "Schritt 1 : Starte Basis‑Netzwerk (Org1 + Org2) inkl. CAs & Channel"
log "────────────────────────────────────────────────────────────────────────────"
(cd "$FABRIC_SAMPLES_DIR/test-network" && ./network.sh up createChannel -ca)

# Schritt 2 – Org3 & Org4 hinzufügen --------------------------------------------------------------
log "\nSchritt 2 : Füge Org3 hinzu";   (cd "$ADD_ORG3_DIR" && ./addOrg3.sh up -ca)
log "\nSchritt 2.5 : Füge Org4 hinzu"; (cd "$ADD_ORG4_DIR" && ./addOrg4.sh up -ca)

sleep 5

# =================================================================================================
# Schritt 3 – Chaincode packen & deployen
# =================================================================================================
log "\n────────────────────────────────────────────────────────────────────────────"
log "Schritt 3 : JavaScript‑Chaincode installieren, approven, committen"
log "────────────────────────────────────────────────────────────────────────────"

export PATH="$FABRIC_SAMPLES_DIR/bin:$PATH"
export FABRIC_CFG_PATH="$FABRIC_SAMPLES_DIR/config/"
cd "$FABRIC_SAMPLES_DIR/test-network"

# ► PRE‑PACKAGING CLEAN: node_modules raus, damit das Archiv klein bleibt!
find "$CC_PATH_FOR_PACKAGE" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true

log "• Packe Chaincode (label=${CHAINCODE_LABEL}) …"
peer lifecycle chaincode package "${CHAINCODE_NAME}.tar.gz" \
  --path "$CC_PATH_FOR_PACKAGE" \
  --lang node \
  --label "$CHAINCODE_LABEL"

ORG_IDS=(1 2 3 4); PEER_PORTS=(7051 9051 11051 13051); PACKAGE_ID=""

for idx in ${!ORG_IDS[@]}; do
  ORG=${ORG_IDS[$idx]}; PORT=${PEER_PORTS[$idx]}
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt"
  export CORE_PEER_MSPCONFIGPATH="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp"
  export CORE_PEER_ADDRESS="localhost:${PORT}"
  export CORE_PEER_TLS_ENABLED=true

  log "   • Installiere auf Org${ORG} (Port ${PORT})"
  peer lifecycle chaincode install "${CHAINCODE_NAME}.tar.gz" || { err "✗ Install auf Org${ORG} fehlgeschlagen"; exit 1; }

  if [[ -z "$PACKAGE_ID" ]]; then
    PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json | jq -r --arg L "$CHAINCODE_LABEL" '.installed_chaincodes[] | select(.label==$L) | .package_id')
    log "     ↳ Package ID = $PACKAGE_ID"
  fi

done

for idx in ${!ORG_IDS[@]}; do
  ORG=${ORG_IDS[$idx]}; PORT=${PEER_PORTS[$idx]}
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt"
  export CORE_PEER_MSPCONFIGPATH="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp"
  export CORE_PEER_ADDRESS="localhost:${PORT}"

  peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$FABRIC_SAMPLES_DIR/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
    --channelID "$CHANNEL_NAME" --name "$CHAINCODE_NAME" --version "$CHAINCODE_VERSION" \
    --package-id "$PACKAGE_ID" --sequence "$CHAINCODE_SEQUENCE" --signature-policy "$ENDORSEMENT_POLICY" || {
      err "✗ Approve Org${ORG} fehlgeschlagen"; exit 1; }

done

# ► Commit‑Readiness prüft nur Org1
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"
peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL_NAME" --name "$CHAINCODE_NAME" \
  --version "$CHAINCODE_VERSION" --sequence "$CHAINCODE_SEQUENCE" --signature-policy "$ENDORSEMENT_POLICY" --output json | jq

# ► Commit – jetzt inklusive  --sequence  &  --signature-policy  +  alle Peers --------------------
peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$FABRIC_SAMPLES_DIR/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
  --channelID "$CHANNEL_NAME" --name "$CHAINCODE_NAME" --version "$CHAINCODE_VERSION" \
  --sequence "$CHAINCODE_SEQUENCE" --signature-policy "$ENDORSEMENT_POLICY" \
  --peerAddresses localhost:7051  --tlsRootCertFiles "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt" \
  --peerAddresses localhost:9051  --tlsRootCertFiles "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
  --peerAddresses localhost:11051 --tlsRootCertFiles "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org3.example.com/peers/peer0.org3.example.com/tls/ca.crt" \
  --peerAddresses localhost:13051 --tlsRootCertFiles "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org4.example.com/peers/peer0.org4.example.com/tls/ca.crt"

log "\n✅ Netzwerk & Chaincode erfolgreich deployed – Viel Spaß beim Testen!"
