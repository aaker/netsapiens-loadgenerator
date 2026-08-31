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
SIP_PORT_NUM=""
SIP_TLS_PORT_NUM=""
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
            SIP_PORT_NUM=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sipPort // empty" "$BASE_DIR/servers.json")
            SIP_TLS_PORT_NUM=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sipTlsPort // empty" "$BASE_DIR/servers.json")
            # Per-server opusPct overrides OPUS_PCT from .env. Exported as a
            # separate variable because register.sh re-sources .env, which
            # would clobber a plain OPUS_PCT export.
            SERVER_OPUS_PCT=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .opusPct // empty" "$BASE_DIR/servers.json")
            if [ -n "$SERVER_OPUS_PCT" ]; then
                export OPUS_PCT_OVERRIDE="$SERVER_OPUS_PCT"
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

# Fall back to env-provided SIP ports if not set per-server, then to standard defaults
SIP_PORT_NUM=${SIP_PORT_NUM:-${SIP_PORT:-5060}}
SIP_TLS_PORT_NUM=${SIP_TLS_PORT_NUM:-${SIP_TLS_PORT:-5061}}

# Force the SIP destination onto IPv4 (SIPp binds an IPv4 local socket)
source "$BASE_DIR/sipp/scripts/net-utils.sh"
SUT=$(resolve_ipv4 "$SUT")

echo "Target server: $SUT (SIP udp/tcp: $SIP_PORT_NUM, TLS: $SIP_TLS_PORT_NUM)"
if [ -n "$OPUS_PCT_OVERRIDE" ]; then
    echo "Opus pct: $OPUS_PCT_OVERRIDE% (per-server opusPct from servers.json)"
fi
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

# Create unique temp file for combined CSV data
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
TEMP_CSV="/tmp/register_combined_${SERVER_ID:-default}_${TIMESTAMP}.csv"
TEMP_LOG="/tmp/register_combined_${SERVER_ID:-default}_${TIMESTAMP}.log"

# Cleanup function for temp files
cleanup_temp_files() {
	echo "Cleaning up temp files (temp disabled)..."
	#[ -f "$TEMP_CSV" ] && rm -f "$TEMP_CSV" && echo "  Removed: $TEMP_CSV"
	#[ -f "$TEMP_LOG" ] && rm -f "$TEMP_LOG" && echo "  Removed: $TEMP_LOG"
}

# Trap to ensure cleanup on exit
trap cleanup_temp_files EXIT

# Calculate 10-minute window range (0-9, 10-19, 20-29, 30-39, 40-49, 50-59)
WINDOW_START=$((MINOFHOUR / 10 * 10))
WINDOW_END=$((WINDOW_START + 9))

echo "Combining CSV files for 10-minute window: $WINDOW_START-$WINDOW_END (minute $MINOFHOUR)"
echo "This window gets 1/6th of total devices"
echo "Temp CSV file: $TEMP_CSV"
echo "Temp log file: $TEMP_LOG"
echo "---"

# Collect all files in this 10-minute window
FILE_COUNT=0
HEADER_WRITTEN=false

for file in $CSV_PATH/*; do
	# Calculate modulo for this file
	MODU=$((COUNTER % 60))

	# Check if this file falls in the current 10-minute window
	if [ $MODU -ge $WINDOW_START ] && [ $MODU -le $WINDOW_END ]; then
		echo "Including file: $file (modulo $MODU in window $WINDOW_START-$WINDOW_END)" | tee -a "$TEMP_LOG"

		# Handle CSV header - only write it once from the first file
		if [ "$HEADER_WRITTEN" = false ]; then
			cat "$file" >> "$TEMP_CSV"
			HEADER_WRITTEN=true
		else
			tail -n +2 "$file" >> "$TEMP_CSV"
		fi

		FILE_COUNT=$((FILE_COUNT + 1))
	fi
	COUNTER=$((COUNTER + 1))
done

echo "---"
echo "Combined $FILE_COUNT files into $TEMP_CSV"

# Check if we have any files to process
if [ $FILE_COUNT -eq 0 ]; then
	echo "No files matched window $WINDOW_START-$WINDOW_END, nothing to register."
	exit 0
fi

TOTAL_LINES=$(wc -l < "$TEMP_CSV")
echo "Total lines in combined CSV: $TOTAL_LINES"

# Allocate ports dynamically for this SIPp instance
echo "Allocating ports for combined batch..."
if ! allocate_ports 1 1 1; then
	echo "ERROR: Failed to allocate ports for combined batch, exiting..."
	exit 1
fi

SIPPORT=$ALLOCATED_SIP_PORT
MEDIAPORT=$ALLOCATED_MEDIA_PORT
CONTROLPORT=$ALLOCATED_CONTROL_PORT

echo "  Allocated - SIP: $SIPPORT, Media: $MEDIAPORT, Control: $CONTROLPORT"

# Determine transport based on 10-minute window (minute % 30)
TRANSPORT_CYCLE=$((MINOFHOUR % 30))

set -x
if [ $TRANSPORT_CYCLE -eq 0 ]; then
	echo "Using UDP transport (u1) - runs at :00, :30"
	/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$TEMP_CSV" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID" "$SIP_PORT_NUM"
elif [ $TRANSPORT_CYCLE -eq 10 ]; then
	echo "Using TCP transport (t1) - runs at :10, :40"
	/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$TEMP_CSV" "t1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID" "$SIP_PORT_NUM"
elif [ $TRANSPORT_CYCLE -eq 20 ]; then
	echo "Using TLS transport (l1) - runs at :20, :50"
	/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$TEMP_CSV" "l1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID" "$SIP_TLS_PORT_NUM"
else
	echo "Unexpected minute $MINOFHOUR (cycle $TRANSPORT_CYCLE) - should only run at :00, :10, :20, :30, :40, :50"
    /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$TEMP_CSV" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID" "$SIP_PORT_NUM"
	#exit 1
fi

# Temp files will be cleaned up by the trap on EXIT

# Only cleanup stale locks once at the start (not per-file)
cleanup_stale_locks

# Final cleanup - show stats
echo "Registration batch complete."
