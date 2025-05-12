#!/usr/bin/env bash
#
# Copyright IBM Corp. All Rights Reserved.
#
# SPDX-License-Identifier: Apache-2.0
#

echo "DEBUG (updateChannelConfig.sh): Bin gestartet."
echo "DEBUG (updateChannelConfig.sh): TEST_NETWORK_HOME ist [${TEST_NETWORK_HOME}]"
echo "DEBUG (updateChannelConfig.sh): PWD ist [${PWD}]"
echo "DEBUG (updateChannelConfig.sh): \$0 (Name des ausführenden Skripts) ist [$(basename "$0")]"

# This script is designed to be run by addOrg4.sh as part of
# adding Org4 to the channel. It creates and submits a
# configuration transaction to add Org4.

# --- Parameter übernehmen ---
CHANNEL_NAME="$1"
DELAY="$2"
TIMEOUT="$3"
VERBOSE="$4"
: ${CHANNEL_NAME:="mychannel"}
: ${DELAY:="3"}
: ${TIMEOUT:="10"}
: ${VERBOSE:="false"}
# COUNTER=1 # Diese Variablen werden im Skript nicht verwendet
# MAX_RETRY=5 # Diese Variablen werden im Skript nicht verwendet

# --- Wichtige Pfad- und Hilfsvariablen ---
# TEST_NETWORK_HOME wird von der aufrufenden Shell (addOrg4.sh) per 'export' erwartet.
# utils.sh (für infoln, errorln, fatalln etc.) wird bereits von addOrg4.sh gesourct und
# sollte im aktuellen Shell-Kontext verfügbar sein.

# Prüfen, ob TEST_NETWORK_HOME gesetzt ist, da es für die folgenden Pfade benötigt wird.
if [ -z "${TEST_NETWORK_HOME}" ]; then
    echo "FEHLER (updateChannelConfig.sh): Die Umgebungsvariable TEST_NETWORK_HOME ist nicht gesetzt! Dieses Skript erwartet, dass sie von der aufrufenden Shell exportiert wird."
    exit 1
fi

# --- Hilfsskripte sourcen ---
# Diese Skripte enthalten die notwendigen Funktionen (fetchChannelConfig, createConfigUpdate, setGlobals, etc.)

ENV_VAR_SCRIPT_PATH="${TEST_NETWORK_HOME}/scripts/envVar.sh"
infoln "(updateChannelConfig.sh) Versuche, envVar.sh zu sourcen von: ${ENV_VAR_SCRIPT_PATH}"
if [ -f "${ENV_VAR_SCRIPT_PATH}" ]; then
    set +e; . "${ENV_VAR_SCRIPT_PATH}"; SOURCING_RES=$?; set -e
    if [ $SOURCING_RES -ne 0 ]; then errorln "(updateChannelConfig.sh): Sourcing von ${ENV_VAR_SCRIPT_PATH} fehlgeschlagen! Code: $SOURCING_RES"; exit 1; fi
    infoln "(updateChannelConfig.sh): envVar.sh erfolgreich gesourct."
else
    errorln "(updateChannelConfig.sh): ${ENV_VAR_SCRIPT_PATH} NICHT gefunden!"; exit 1
fi


CONFIG_UPDATE_SCRIPT_PATH="${TEST_NETWORK_HOME}/scripts/configUpdate.sh"
infoln "(updateChannelConfig.sh) Versuche, configUpdate.sh zu sourcen von: ${CONFIG_UPDATE_SCRIPT_PATH}"
if [ -f "${CONFIG_UPDATE_SCRIPT_PATH}" ]; then
    set +e; . "${CONFIG_UPDATE_SCRIPT_PATH}"; SOURCING_RES=$?; set -e
    if [ $SOURCING_RES -ne 0 ]; then errorln "(updateChannelConfig.sh): Sourcing von ${CONFIG_UPDATE_SCRIPT_PATH} fehlgeschlagen! Code: $SOURCING_RES"; exit 1; fi
    infoln "(updateChannelConfig.sh): configUpdate.sh erfolgreich gesourct."
else
    errorln "(updateChannelConfig.sh): ${CONFIG_UPDATE_SCRIPT_PATH} NICHT gefunden!"; exit 1
fi

infoln "Prüfe Verfügbarkeit der Funktionen nach dem Sourcing:"
if command -v fetchChannelConfig > /dev/null 2>&1; then
    infoln "  Funktion 'fetchChannelConfig' ist VERFÜGBAR."
    infoln "  Typ von fetchChannelConfig:"
    type fetchChannelConfig
else
    errorln "  FEHLER: Funktion 'fetchChannelConfig' ist NICHT VERFÜGBAR."
    # exit 1 # Vorübergehend auskommentieren, um weitere Prüfungen zu sehen
fi

if command -v createConfigUpdate > /dev/null 2>&1; then
    infoln "  Funktion 'createConfigUpdate' ist VERFÜGBAR."
    infoln "  Typ von createConfigUpdate:"
    type createConfigUpdate
else
    errorln "  FEHLER: Funktion 'createConfigUpdate' ist NICHT VERFÜGBAR."
    # exit 1
fi

if command -v signConfigtxAsPeerOrg > /dev/null 2>&1; then
    infoln "  Funktion 'signConfigtxAsPeerOrg' ist VERFÜGBAR."
    infoln "  Typ von signConfigtxAsPeerOrg:"
    type signConfigtxAsPeerOrg
else
    errorln "  FEHLER: Funktion 'signConfigtxAsPeerOrg' ist NICHT VERFÜGBAR."
    # exit 1
fi

if ! command -v setGlobals > /dev/null 2>&1; then
    errorln "  FEHLER: Funktion 'setGlobals' ist NICHT VERFÜGBAR (wichtig für andere Funktionen)!"
    # exit 1
fi
# --- Ende Hilfsskripte sourcen ---


# Verwende infoln (aus utils.sh), da es jetzt verfügbar sein sollte
infoln "Creating config transaction to add Org4 to network for channel '${CHANNEL_NAME}'"

# Pfade zu den Artefakten, basierend auf TEST_NETWORK_HOME
CONFIG_JSON_PATH="${TEST_NETWORK_HOME}/channel-artifacts/config.json"
MODIFIED_CONFIG_JSON_PATH="${TEST_NETWORK_HOME}/channel-artifacts/modified_config.json"
ORG4_JSON_PATH="${TEST_NETWORK_HOME}/organizations/peerOrganizations/org4.example.com/org4.json" # org4.json wird von configtxgen in addOrg4.sh erstellt
ORG4_UPDATE_ENVELOPE_PATH="${TEST_NETWORK_HOME}/channel-artifacts/org4_update_in_envelope.pb"

# Schritt 1: Aktuelle Channel-Konfiguration abrufen
# Org1 (peer0.org1) wird verwendet, um die Konfiguration abzurufen.
# setGlobals 1 wird innerhalb von fetchChannelConfig (aus utils.sh) aufgerufen.
infoln "Fetching current channel config using Org1..."
fetchChannelConfig 1 "${CHANNEL_NAME}" "${CONFIG_JSON_PATH}"
if [ $? -ne 0 ]; then
    errorln "Failed to fetch channel config"
    exit 1
fi

# Schritt 2: Konfiguration modifizieren, um Org4 hinzuzufügen
infoln "Modifying channel config to include Org4MSP..."
if [ ! -f "${ORG4_JSON_PATH}" ]; then
    errorln "Org4 definition file (${ORG4_JSON_PATH}) not found. Please ensure it's generated by addOrg4.sh first."
    exit 1
fi
set -x
jq -s '.[0] * {"channel_group":{"groups":{"Application":{"groups": {"Org4MSP":.[1]}}}}}' "${CONFIG_JSON_PATH}" "${ORG4_JSON_PATH}" > "${MODIFIED_CONFIG_JSON_PATH}"
res=$?
{ set +x; } 2>/dev/null # set +x Fehler hier nicht unterdrücken, um jq Fehler zu sehen
if [ $res -ne 0 ]; then
    errorln "jq command failed to modify config. Exit code: $res"
    exit 1
fi
if [ ! -s "${MODIFIED_CONFIG_JSON_PATH}" ]; then # Prüfen, ob die Datei nicht leer ist
    errorln "${MODIFIED_CONFIG_JSON_PATH} ist leer oder wurde nicht erstellt!"
    exit 1
fi

# Schritt 3: Konfigurations-Update-Transaktion erstellen
infoln "Creating Org4 config update transaction..."
createConfigUpdate "${CHANNEL_NAME}" "${CONFIG_JSON_PATH}" "${MODIFIED_CONFIG_JSON_PATH}" "${ORG4_UPDATE_ENVELOPE_PATH}"
if [ $? -ne 0 ]; then
    errorln "Failed to create config update transaction"
    exit 1
fi

# Schritt 4: Konfigurations-Update-Transaktion als Org1 signieren
# setGlobals 1 wird innerhalb von signConfigtxAsPeerOrg (aus configUpdate.sh) aufgerufen.
infoln "Signing config transaction as Org1..."
signConfigtxAsPeerOrg 1 "${ORG4_UPDATE_ENVELOPE_PATH}"
if [ $? -ne 0 ]; then
    errorln "Failed to sign config transaction as Org1"
    exit 1
fi

# Schritt 5: Transaktion von einer anderen bereits existierenden Organisation (hier Org3) einreichen,
# die dann ebenfalls signiert (implizit durch den Peer, der den Update-Befehl ausführt).
# Die Standard-Endorsement-Policy für Channel-Updates erfordert typischerweise Signaturen von der Mehrheit der existierenden Admins.
# Wenn Sie nur Org1 und Org2 im Channel haben, und die Policy "MAJORITY Admins" ist, dann müssen beide signieren.
# Das Skript hier verwendet Org3 zum Einreichen, was impliziert, dass Org3 bereits Teil des Channels ist
# und seine Signatur entweder die Policy erfüllt oder dass die Policy anders ist.
# Im Kontext des Hinzufügens von Org4 zu einem Channel mit Org1, Org2, Org3 wäre es typischer,
# dass Org1 und Org2 (oder eine Mehrheit davon) die Transaktion signieren und dann eine davon einreicht.
# Das fabric-samples addOrg3.sh Skript reicht oft mit Org2 ein, nachdem Org1 signiert hat.
# Für Org4, wenn Org1, Org2, Org3 bereits im Channel sind, ist die Einreichung durch Org3 (oder Org1/Org2) plausibel.

infoln "Submitting transaction from peer0.org3.example.com (which will also sign it)..."
setGlobals 3 # Setzt Umgebungsvariablen für Org3 (CORE_PEER_LOCALMSPID, CORE_PEER_ADDRESS etc.)
if [ $? -ne 0 ]; then
    errorln "Failed to set globals for Org3"
    exit 1
fi

if [ -z "$ORDERER_CA" ] || [ ! -f "$ORDERER_CA" ]; then
    errorln "ORDERER_CA variable is not set or cafile not found: [$ORDERER_CA]"
    errorln "This variable should be set by envVar.sh. Check if envVar.sh was sourced correctly and defines ORDERER_CA."
    exit 1
fi

set -x
peer channel update -f "${ORG4_UPDATE_ENVELOPE_PATH}" -c "${CHANNEL_NAME}" -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA"
res=$?
{ set +x; }
if [ $res -ne 0 ]; then
    errorln "'peer channel update' command failed with res $res"
    exit 1
fi

successln "Config transaction to add org4 to network submitted successfully"