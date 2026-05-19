#!/bin/bash
# Call generator - spawns random calls between extensions
# Usage: call_all.sh [--server <server-id>]
# Can be called via cron to generate random call traffic

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
        echo "Running calls for ALL servers in servers.json"
        echo "=========================================="

        # Loop through each server and call this script recursively
        for SID in $SERVER_IDS; do
            echo ""
            echo ">>> Starting calls for server: $SID"
            echo "---"
            $0 --server "$SID" & # Run in background for parallel execution

            echo ">>> Launched calls for server: $SID"
            sleep 2 # Slight delay between servers
            echo ""
        done

        echo "=========================================="
        echo "Finished launching calls for all servers"
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

echo "Target server: $SUT (SIP udp/tcp: $SIP_PORT_NUM, TLS: $SIP_TLS_PORT_NUM)"
echo "CSV path: $CSV_PATH"

FILES=$(ls $CSV_PATH/* 2>/dev/null | wc -l)
echo "Found $FILES device files"

if [ "$FILES" -eq 0 ]; then
    echo "Error: No device CSV files found in $CSV_PATH"
    exit 1
fi

# Source the port allocator
source "$BASE_DIR/sipp/scripts/port-allocator.sh"

# Initialize port allocation system
init_port_locks

echo "Port allocation ready. Lock directory: $PORT_LOCK_DIR"

# Get IP addresses
PUBLICIP=$(dig +short myip.opendns.com @resolver1.opendns.com -4)
PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

ulimit -n 65536

# Use server-specific log files if in multi-server mode
if [ -n "$SERVER_ID" ]; then
    ERROR_LOG="$BASE_DIR/sipp/scripts/error_call_${SERVER_ID}.log"
    CALL_LOG="$BASE_DIR/sipp/scripts/call_${SERVER_ID}.log"
else
    ERROR_LOG="$BASE_DIR/sipp/scripts/error_call.log"
    CALL_LOG="$BASE_DIR/sipp/scripts/call.log"
fi

echo "starting call run... " > "$ERROR_LOG"
echo "scheduling call batch" >> "$CALL_LOG"

# Create unique temp file for combined CSV data
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
TEMP_CSV="/tmp/call_combined_${SERVER_ID:-default}_${TIMESTAMP}.csv"

# Cleanup function for temp files
cleanup_temp_files() {
    echo "Cleaning up temp files..."
    # Uncomment to enable cleanup
    #[ -f "$TEMP_CSV" ] && rm -f "$TEMP_CSV" && echo "  Removed: $TEMP_CSV"
}

# Trap to ensure cleanup on exit
trap cleanup_temp_files EXIT

# Randomly select files to include (for variety each run)
# Use minute of hour to rotate through different file sets
MINOFHOUR=$(date +"%M")
COUNTER=0
FILE_COUNT=0
HEADER_WRITTEN=false

echo "Combining CSV files for call generation (modulo $MINOFHOUR)..."

for file in $CSV_PATH/*; do
    MODU=$((COUNTER % 60))
    if [ $MODU -eq $MINOFHOUR ]; then
        echo "Including file: $file"

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
    echo "No files matched modulo $MINOFHOUR, nothing to call."
    exit 0
fi

TOTAL_LINES=$(wc -l < "$TEMP_CSV")
echo "Total lines in combined CSV: $TOTAL_LINES"

# Allocate ports dynamically for this SIPp instance
echo "Allocating ports for call batch..."
if ! allocate_ports 1 1 1; then
    echo "ERROR: Failed to allocate ports for call batch, exiting..."
    exit 1
fi

SIPPORT=$ALLOCATED_SIP_PORT
MEDIAPORT=$ALLOCATED_MEDIA_PORT
CONTROLPORT=$ALLOCATED_CONTROL_PORT

echo "  Allocated - SIP: $SIPPORT, Media: $MEDIAPORT, Control: $CONTROLPORT"

# Use modulo of minute to determine transport type
TRANSPORT_TYPE=$((MINOFHOUR % 3))

if [ $TRANSPORT_TYPE -eq 2 ]; then
    echo "Using UDP transport (u1)"
    $BASE_DIR/sipp/scripts/call.sh "$SUT" "$TEMP_CSV" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID" "$SIP_PORT_NUM"
elif [ $TRANSPORT_TYPE -eq 1 ]; then
    echo "Using TCP transport (t1)"
    $BASE_DIR/sipp/scripts/call.sh "$SUT" "$TEMP_CSV" "t1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID" "$SIP_PORT_NUM"
else
    echo "Using TLS transport (l1)"
    $BASE_DIR/sipp/scripts/call.sh "$SUT" "$TEMP_CSV" "l1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP "$SERVER_ID" "$SIP_TLS_PORT_NUM"
fi

# Cleanup stale locks
cleanup_stale_locks

echo "Call batch complete."
