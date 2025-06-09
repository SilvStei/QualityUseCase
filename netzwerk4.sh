#!/bin/bash
set -eo pipefail

FABRIC_SAMPLES_DIR="$HOME/Masterthesis/fabric-samples"
PROJECT_DIR="$HOME/Masterthesis/QualityUseCase"

CHAINCODE_SRC_FOLDER_NAME="dpp_quality"
CHAINCODE_NAME="dpp_quality"
CHAINCODE_VERSION="1.0"
CHAINCODE_LABEL="${CHAINCODE_NAME}_${CHAINCODE_VERSION}"

CHANNEL_NAME="mychannel"
CHAINCODE_SEQUENCE=1
ENDORSEMENT_POLICY="OR('Org1MSP.peer','Org2MSP.peer','Org3MSP.peer','Org4MSP.peer')"

ADD_ORG3_DIR="${FABRIC_SAMPLES_DIR}/test-network/addOrg3"
ADD_ORG4_DIR="${FABRIC_SAMPLES_DIR}/test-network/addOrg4"

CC_PATH_FOR_PACKAGE="${PROJECT_DIR}/chaincode/${CHAINCODE_SRC_FOLDER_NAME}"

remove_volume_if_exists() {
  local VOL=$1
  docker volume inspect "$VOL" &>/dev/null && sudo docker volume rm "$VOL" --force &>/dev/null
}

cleanup_ca_host_dir() {
  local D=$1 CFG="fabric-ca-server-config.yaml"
  [[ -d "$D" ]] || return 0
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
  [[ -d "$P/production"   ]] && sudo rm -rf "$P/production"   2>/dev/null || true
  [[ -d "$P/ledgersData"  ]] && sudo rm -rf "$P/ledgersData"  2>/dev/null || true
}

set +e
[[ -d "$ADD_ORG4_DIR" ]] && (cd "$ADD_ORG4_DIR" && ./addOrg4.sh down &>/dev/null)
[[ -d "$ADD_ORG3_DIR" ]] && (cd "$ADD_ORG3_DIR" && ./addOrg3.sh down &>/dev/null)
(cd "$FABRIC_SAMPLES_DIR/test-network" && ./network.sh down &>/dev/null)

for vol in compose_peer0.org{1..4}.example.com compose_orderer.example.com \
           docker_orderer.example.com docker_peer0.org{1..4}.example.com; do
  remove_volume_if_exists "$vol"
done

sudo docker network rm fabric_test &>/dev/null || true
sudo docker volume prune -f &>/dev/null || true

cleanup_ca_host_dir "$ADD_ORG3_DIR/fabric-ca/org3"
cleanup_ca_host_dir "$ADD_ORG4_DIR/fabric-ca/org4"

for w in wallet walletA walletB walletC walletD; do
  mkdir -p "$PROJECT_DIR/Anwendungen/$w"
  rm -rf "$PROJECT_DIR/Anwendungen/$w"/* 2>/dev/null || true
done

cleanup_ledger_data "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org3.example.com/peers/peer0.org3.example.com"
cleanup_ledger_data "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org4.example.com/peers/peer0.org4.example.com"
set -e

(cd "$FABRIC_SAMPLES_DIR/test-network" && ./network.sh up createChannel -ca)

(cd "$ADD_ORG3_DIR" && ./addOrg3.sh up -ca)
(cd "$ADD_ORG4_DIR" && ./addOrg4.sh up -ca)

sleep 5

export PATH="$FABRIC_SAMPLES_DIR/bin:$PATH"
export FABRIC_CFG_PATH="$FABRIC_SAMPLES_DIR/config/"
cd "$FABRIC_SAMPLES_DIR/test-network"

find "$CC_PATH_FOR_PACKAGE" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true

peer lifecycle chaincode package "${CHAINCODE_NAME}.tar.gz" \
  --path "$CC_PATH_FOR_PACKAGE" \
  --lang node \
  --label "$CHAINCODE_LABEL"

ORG_IDS=(1 2 3 4)
PEER_PORTS=(7051 9051 11051 13051)
PACKAGE_ID=""

for idx in ${!ORG_IDS[@]}; do
  ORG=${ORG_IDS[$idx]}
  PORT=${PEER_PORTS[$idx]}
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt"
  export CORE_PEER_MSPCONFIGPATH="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp"
  export CORE_PEER_ADDRESS="localhost:${PORT}"
  export CORE_PEER_TLS_ENABLED=true

  peer lifecycle chaincode install "${CHAINCODE_NAME}.tar.gz"

  if [[ -z "$PACKAGE_ID" ]]; then
    PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json | jq -r --arg L "$CHAINCODE_LABEL" '.installed_chaincodes[] | select(.label==$L) | .package_id')
  fi
done

for idx in ${!ORG_IDS[@]}; do
  ORG=${ORG_IDS[$idx]}
  PORT=${PEER_PORTS[$idx]}
  export CORE_PEER_LOCALMSPID="Org${ORG}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org${ORG}.example.com/peers/peer0.org${ORG}.example.com/tls/ca.crt"
  export CORE_PEER_MSPCONFIGPATH="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org${ORG}.example.com/users/Admin@org${ORG}.example.com/msp"
  export CORE_PEER_ADDRESS="localhost:${PORT}"

  peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$FABRIC_SAMPLES_DIR/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
    --channelID "$CHANNEL_NAME" --name "$CHAINCODE_NAME" --version "$CHAINCODE_VERSION" \
    --package-id "$PACKAGE_ID" --sequence "$CHAINCODE_SEQUENCE" --signature-policy "$ENDORSEMENT_POLICY"
done

export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"

peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL_NAME" --name "$CHAINCODE_NAME" \
  --version "$CHAINCODE_VERSION" --sequence "$CHAINCODE_SEQUENCE" --signature-policy "$ENDORSEMENT_POLICY" --output json

peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$FABRIC_SAMPLES_DIR/test-network/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem" \
  --channelID "$CHANNEL_NAME" --name "$CHAINCODE_NAME" --version "$CHAINCODE_VERSION" \
  --sequence "$CHAINCODE_SEQUENCE" --signature-policy "$ENDORSEMENT_POLICY" \
  --peerAddresses localhost:7051  --tlsRootCertFiles "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt" \
  --peerAddresses localhost:9051  --tlsRootCertFiles "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
  --peerAddresses localhost:11051 --tlsRootCertFiles "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org3.example.com/peers/peer0.org3.example.com/tls/ca.crt" \
  --peerAddresses localhost:13051 --tlsRootCertFiles "$FABRIC_SAMPLES_DIR/test-network/organizations/peerOrganizations/org4.example.com/peers/peer0.org4.example.com/tls/ca.crt"