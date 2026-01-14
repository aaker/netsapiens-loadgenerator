#!/bin/bash
#https://github.com/dizzy/sipR/tree/master/sipRtest/register
#https://github.com/saghul/sipp-scenarios/blob/master/sipp_uas_pcap_g711a.xml
#https://github.com/SIPp/sipp/issues/412

# Multi-server support with backward compatibility
# Usage: register_all.sh [--server <server-id>]

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source $BASE_DIR/.env

# Parse command-line arguments for multi-server support
SERVER_ID=""
if [ "$1" == "--server" ] && [ -n "$2" ]; then
    SERVER_ID="$2"

    # Handle --server all: loop through all servers in servers.json
    if [ "$SERVER_ID" == "all" ]; then
        if [ ! -f "$BASE_DIR/servers.json" ]; then
            echo "Error: servers.json not found. Required for --server all"
            exit 1
        fi

        if ! command -v jq &> /dev/null; then
            echo "Error: jq is required for --server all but not installed"
            exit 1
        fi

        # Get all server IDs from servers.json
        SERVER_IDS=$(jq -r '.servers[].id' "$BASE_DIR/servers.json")

        if [ -z "$SERVER_IDS" ]; then
            echo "Error: No servers found in servers.json"
            exit 1
        fi

        echo "=========================================="
        echo "Running for ALL servers in servers.json"
        echo "=========================================="

        # Loop through each server and call this script recursively
        for SID in $SERVER_IDS; do
            echo ""
            echo ">>> Starting registration for server: $SID"
            echo "---"
            $0 --server "$SID" & # Run in background for parallel execution
            
            echo ">>> Completed registration for server: $SID"
            sleep 2 # Slight delay between servers
            echo ""
        done

        echo "=========================================="
        echo "Finished running for all servers"
        echo "=========================================="
        exit 0
    fi

    echo "Multi-server mode: Using server '$SERVER_ID'"
fi

# Determine CSV path and target server
if [ -n "$SERVER_ID" ]; then
    # Multi-server mode: Load configuration from servers.json
    if [ -f "$BASE_DIR/servers.json" ]; then
        # Extract server configuration from servers.json using jq
        if command -v jq &> /dev/null; then
            SUT=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .hostname" "$BASE_DIR/servers.json")
            if [ -z "$SUT" ] || [ "$SUT" == "null" ]; then
                echo "Error: Server '$SERVER_ID' not found in servers.json"
                exit 1
            fi
        else
            echo "Error: jq is required for multi-server mode but not installed"
            echo "Install with: sudo apt-get install jq (Ubuntu) or brew install jq (macOS)"
            exit 1
        fi
    else
        echo "Error: servers.json not found. Required for multi-server mode."
        exit 1
    fi

    CSV_PATH="$BASE_DIR/sipp/csv/servers/$SERVER_ID/devices"

    if [ ! -d "$CSV_PATH" ]; then
        echo "Error: Device CSV directory not found: $CSV_PATH"
        echo "Have you generated data for this server using: node server.js --server $SERVER_ID"
        exit 1
    fi
else
    # Legacy single-server mode: Use environment variable
    SUT=$TARGET_SERVER
    CSV_PATH="$BASE_DIR/sipp/csv/servers/default/devices"

    if [ ! -d "$CSV_PATH" ]; then
        echo "Error: Legacy device CSV directory not found: $CSV_PATH"
        echo "Have you generated data using: node server.js"
        exit 1
    fi
    echo "Legacy single-server mode: Using TARGET_SERVER from .env"
fi

echo "Target server: $SUT"
echo "CSV path: $CSV_PATH"

COUNTER=0;
if [ -z "$2" ]; then
	COUNTER=$2;
fi

FILES=`ls $CSV_PATH/* 2>/dev/null | wc -l`
echo "Found $FILES files"

if [ "$FILES" -eq 0 ]; then
    echo "Error: No device CSV files found in $CSV_PATH"
    exit 1
fi

COUNTER_LOCAL=0;
MINOFHOUR=`date +"%M"`

# Source the port allocator
source "$BASE_DIR/sipp/scripts/port-allocator.sh"

# Initialize port allocation system (fast - no cleanup)
init_port_locks



echo "Port allocation ready. Lock directory: $PORT_LOCK_DIR"

# get the public ip and push it into the sipp scripts for the media ip.
PUBLICIP=`dig +short myip.opendns.com @resolver1.opendns.com -4`
PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

UAS_SCRIPT="sipp_uas_pcap_g711a.xml"
if [ "$USE_OPUS" == "yes" ] || [ "$USE_OPUS" == "1" ]; then
	UAS_SCRIPT="sipp_uas_pcap_opus_g711a_fallback.xml"
fi

if [ "$IP_USE_PUBLIC" == "1" ]; then
	sed -i -e "s/\[media_ip\]/$PUBLICIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/$UAS_SCRIPT
else 
	sed -i -e "s/\[media_ip\]/$PRIVATEIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/$UAS_SCRIPT
fi

ulimit -n 65536

# Use server-specific log files if in multi-server mode
if [ -n "$SERVER_ID" ]; then
    ERROR_LOG="$BASE_DIR/sipp/scripts/error_register_${SERVER_ID}.log"
    REGISTER_LOG="$BASE_DIR/sipp/scripts/register_${SERVER_ID}.log"
else
    ERROR_LOG="$BASE_DIR/sipp/scripts/error_register.log"
    REGISTER_LOG="$BASE_DIR/sipp/scripts/register.log"
fi

echo "starting run... " > "$ERROR_LOG"
echo "scheduling batch" >> "$REGISTER_LOG"

for file in $CSV_PATH/*; do
	#modulo COUNTER AND MINOFHOUR
	MODU=$((COUNTER % 60));
	if [ $MODU -eq $MINOFHOUR ]; then
		echo "Registering $file"
	else
		COUNTER=$((COUNTER + 1)); ##incremenet here to keep looping.
		continue;
	fi

	COUNTER=$((COUNTER + 1)); #moved below to keep 0 based index.

	sleep 2; #disperse the load a bit.

	# Allocate ports dynamically for this SIPp instance
	echo "Allocating ports for $(basename $file)..."
	if ! allocate_ports 1 1 1; then
		echo "ERROR: Failed to allocate ports for $file, skipping..."
		continue
	fi

	SIPPORT=$ALLOCATED_SIP_PORT
	MEDIAPORT=$ALLOCATED_MEDIA_PORT
	CONTROLPORT=$ALLOCATED_CONTROL_PORT

	echo "  Allocated - SIP: $SIPPORT, Media: $MEDIAPORT, Control: $CONTROLPORT"

	TRANSPORT_TYPE=$((COUNTER % 3));
	if [ $TRANSPORT_TYPE -eq 2 ]; then
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID"
	elif [ $TRANSPORT_TYPE -eq 1 ]; then
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "t1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID"
	else
		# TLS support (l1 = TLS with one socket)
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "l1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID"
	fi

	# Note: Ports will be released when register.sh completes via trap

done

# Only cleanup stale locks once at the start (not per-file)
cleanup_stale_locks

# Final cleanup - show stats
echo "Registration batch complete."
