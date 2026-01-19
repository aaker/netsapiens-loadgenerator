#!/bin/bash

# Multi-server support with backward compatibility
# Usage: inbound.sh <timezone> [<transport>] [--server <server-id>]
# Examples:
#   inbound.sh US_Eastern                    # Uses default UDP (u1)
#   inbound.sh US_Eastern t1                 # Uses TCP
#   inbound.sh US_Eastern --server prod1     # Uses default UDP with server prod1
#   inbound.sh US_Eastern u1 --server prod1  # Uses UDP with server prod1
# Transport options: u1 (UDP - default), t1 (TCP), l1 (TLS)

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source $BASE_DIR/.env

#random delay to stagger start times (0-15 seconds), seed with $$ pid
RANDOM=$$
sleep $(( RANDOM % 16 ))

# Source port allocator for dynamic port allocation
source "$BASE_DIR/sipp/scripts/port-allocator.sh"

# Parse arguments: timezone is first, transport is optional (defaults to u1), --server is optional
TIMEZONE="$1"
TRANSPORT=""
SERVER_ID=""

if [ -z "$TIMEZONE" ]; then
    echo "Error: Timezone argument required"
    echo "Usage: inbound.sh <timezone> [<transport>] [--server <server-id>]"
    echo "Example: inbound.sh US_Eastern u1 --server prod1"
    echo "Transport options: u1 (UDP - default), t1 (TCP), l1 (TLS)"
    exit 1
fi

# Check if second argument is --server (no transport provided)
if [ "$2" == "--server" ]; then
    TRANSPORT="u1"  # Default to UDP
    SERVER_ID="$3"
# Check if third argument is --server (transport was provided)
elif [ "$3" == "--server" ] && [ -n "$4" ]; then
    TRANSPORT="$2"
    SERVER_ID="$4"
# Second argument provided but not --server (must be transport)
elif [ -n "$2" ]; then
    TRANSPORT="$2"
# No second argument at all
else
    TRANSPORT="u1"  # Default to UDP
fi

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
        echo "Running inbound for ALL servers in servers.json"
        echo "Timezone: $TIMEZONE"
        echo "Transport: $TRANSPORT"
        echo "=========================================="

        # Loop through each server and call this script recursively
        for SID in $SERVER_IDS; do
            echo ""
            echo ">>> Starting inbound calls for server: $SID (timezone: $TIMEZONE, transport: $TRANSPORT)"
            echo "---"
            $0 "$TIMEZONE" "$TRANSPORT" --server "$SID" 
            
            RESULT=$?
            if [ $RESULT -ne 0 ]; then
                echo "Warning: Inbound calls for server '$SID' failed with exit code $RESULT"
            else
                echo ">>> Completed inbound calls for server: $SID"
            fi
            echo ""
        done

        echo "=========================================="
        echo "Finished running for all servers"
        echo "=========================================="
        exit 0

    echo "Multi-server mode: Using server '$SERVER_ID'"
fi

# Determine target server and CSV path
if [ -n "$SERVER_ID" ]; then
    # Multi-server mode: Load configuration from servers.json
    if [ -f "$BASE_DIR/servers.json" ]; then
        if command -v jq &> /dev/null; then
            SUT=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .hostname" "$BASE_DIR/servers.json")
            if [ -z "$SUT" ] || [ "$SUT" == "null" ]; then
                echo "Error: Server '$SERVER_ID' not found in servers.json"
                exit 1
            fi
        else
            echo "Error: jq is required for multi-server mode but not installed"
            exit 1
        fi
    else
        echo "Error: servers.json not found"
        exit 1
    fi

    INPUTFILE="$BASE_DIR/sipp/csv/servers/$SERVER_ID/phonenumbers/${TIMEZONE}.csv"
else
    # Legacy single-server mode
    SUT=${SAS_SERVER:-$TARGET_SERVER}
    INPUTFILE="$BASE_DIR/sipp/csv/servers/default/phonenumbers/${TIMEZONE}.csv"
    echo "Legacy single-server mode"
fi


echo "Target server: $SUT"
echo "Input file: $INPUTFILE"

LOG_FILE=$(basename "$INPUTFILE")
STATS_PATH="$BASE_DIR/sipp/stats"




if [ ! -f "$INPUTFILE" ]; then
	echo "Error: File $INPUTFILE does not exist"
	echo "Have you generated data for timezone $TIMEZONE?"
	exit 1
fi

# Load PEAK_CPS from server-specific config if available
if [ -n "$SERVER_ID" ] && [ -f "$BASE_DIR/servers.json" ]; then
    if command -v jq &> /dev/null; then
        SERVER_PEAK_CPS=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .peakCps" "$BASE_DIR/servers.json")
        if [ -n "$SERVER_PEAK_CPS" ] && [ "$SERVER_PEAK_CPS" != "null" ]; then
            PEAK_CPS=$SERVER_PEAK_CPS
            echo "Using server-specific PEAK_CPS: $PEAK_CPS"
        fi
    fi
fi

# Fallback to .env or default
if [ -z "$PEAK_CPS" ]; then
	echo "No PEAK_CPS specified, defaulting to 7 cps, 1 per script"
	PEAK_CPS=7
fi

# Determine if RTP should be sent (default: enabled)
SEND_RTP_FINAL=1  # Default to enabled
SERVER_SEND_RTP=""

# Check for server-specific setting first
if [ -n "$SERVER_ID" ] && [ -f "$BASE_DIR/servers.json" ]; then
    if command -v jq &> /dev/null; then
        SERVER_SEND_RTP=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sendRtp // empty" "$BASE_DIR/servers.json")
        if [ -n "$SERVER_SEND_RTP" ] && [ "$SERVER_SEND_RTP" != "null" ]; then
            SEND_RTP_FINAL=$SERVER_SEND_RTP
            echo "Using server-specific RTP setting: SEND_RTP=$SEND_RTP_FINAL"
        fi
    fi
fi

# Fall back to .env if no server-specific setting
if [ -z "$SERVER_SEND_RTP" ] || [ "$SERVER_SEND_RTP" == "null" ]; then
    if [ -n "$SEND_RTP" ]; then
        SEND_RTP_FINAL=$SEND_RTP
        echo "Using .env RTP setting: SEND_RTP=$SEND_RTP_FINAL"
    fi
fi

echo "RTP Playback: $([ "$SEND_RTP_FINAL" == "1" ] && echo "ENABLED" || echo "DISABLED (signaling only)")"

#add some randomness to the PEAK_CPS to avoid exact same call rate every run, make it + or - 10%
# Use bc for decimal arithmetic to support CPS < 1
TEN_PERCENT=$(echo "scale=4; $PEAK_CPS * 0.1" | bc)

# Generate random adjustment between 0 and 10% of PEAK_CPS
# RANDOM generates 0-32767, we'll scale it to 0-1 range then multiply by 10%
RANDOM_FACTOR=$(echo "scale=4; $RANDOM / 32767" | bc)
RANDOM_ADJUSTMENT=$(echo "scale=4; $TEN_PERCENT * $RANDOM_FACTOR" | bc)

# Randomly add or subtract the adjustment
if (( RANDOM % 2 )); then
	PEAK_CPS=$(echo "scale=4; $PEAK_CPS + $RANDOM_ADJUSTMENT" | bc)
else
	PEAK_CPS=$(echo "scale=4; $PEAK_CPS - $RANDOM_ADJUSTMENT" | bc)
fi

#round PEAK_CPS to 2 decimal places (to support CPS < 1)
PEAK_CPS=$(echo "scale=2; $PEAK_CPS / 1" | bc)


PUBLICIP=`dig +short myip.opendns.com @resolver1.opendns.com -4`
PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

# Allocate ports for this inbound call session (runs ~5 minutes)
echo "Allocating ports for inbound calls..."
if ! allocate_ports 1 1 1; then
	echo "ERROR: Failed to allocate ports for inbound calls"
	exit 1
fi

SIP_PORT=$ALLOCATED_SIP_PORT
MEDIA_PORT=$ALLOCATED_MEDIA_PORT
CONTROL_PORT=$ALLOCATED_CONTROL_PORT

echo "Allocated ports - SIP: $SIP_PORT, Media: $MEDIA_PORT, Control: $CONTROL_PORT"

if [ "$IP_USE_PUBLIC" == "1" ]; then
	sed -i -e "s/\[media_ip\]/$PUBLICIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
else
	sed -i -e "s/\[media_ip\]/$PRIVATEIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
fi

# Conditionally enable/disable RTP playback by commenting/uncommenting play_pcap_audio
if [ "$SEND_RTP_FINAL" != "1" ]; then
    echo "Disabling RTP playback in XML scenario (commenting out play_pcap_audio)"
    # Comment out play_pcap_audio lines
    sed -i -e 's/<exec play_pcap_audio=/<!-- RTP_DISABLED: <exec play_pcap_audio=/g' \
           -e 's/play_pcap_audio="g711a\.pcap"\/>/play_pcap_audio="g711a.pcap"\/> -->/g' \
           /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
else
    echo "Enabling RTP playback in XML scenario (uncommenting play_pcap_audio if needed)"
    # Restore any previously commented RTP lines
    sed -i -e 's/<!-- RTP_DISABLED: <exec play_pcap_audio=/<exec play_pcap_audio=/g' \
           -e 's/play_pcap_audio="g711a\.pcap"\/> -->/play_pcap_audio="g711a.pcap"\/>/g' \
           /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
fi


CALLRATE=`printf "%.2f\n" $(echo "scale=2;$PEAK_CPS/7" |bc)` # 7 scripts running at once assuming all TZ's in play.
DURATION=275 # 5 minutes minus some time for calls to complete
NUMCALLS=`printf "%.0f\n" $(echo "scale=2;$CALLRATE*$DURATION" |bc)`
echo "Submitting $NUMCALLS calls to $SUT for $DURATION seconds at $CALLRATE cps using $INPUTFILE"

# Use server-specific log file if in multi-server mode
if [ -n "$SERVER_ID" ]; then
    LOG_FILE="$BASE_DIR/sipp/scripts/inbound_${SERVER_ID}_${TIMEZONE}.log"
else
    LOG_FILE="$BASE_DIR/sipp/scripts/inbound_${TIMEZONE}.log"
fi

TZ_CLEAN=$(echo "$TIMEZONE" | tr ' /' '__' | tr -cd '[:alnum:]')

# Create stats filename with server ID and transport
if [ -n "$SERVER_ID" ]; then
    STATS_FILE="${STATS_PATH}/${SERVER_ID}_inbound_${TRANSPORT}_${TZ_CLEAN}_$$.csv"
else
    STATS_FILE="${STATS_PATH}/inbound_${TRANSPORT}_${TZ_CLEAN}_$$.csv"
fi

# TLS certificate configuration (only used when TRANSPORT=l1)
TLS_CERT="$BASE_DIR/sipp/tls/sipp.crt"
TLS_KEY="$BASE_DIR/sipp/tls/sipp.key"
TLS_OPTIONS=""
SIP_PORT_ADD_ON=""
if [ "$TRANSPORT" == "l1" ]; then
    SIP_PORT_ADD_ON=":5061"
	if [ -f "$TLS_CERT" ] && [ -f "$TLS_KEY" ]; then
		# Add TLS version options - use TLS 1.2 for better compatibility
		# Include system CA bundle for verifying server certificates
		# Note: We do NOT include -tls_crl because it causes verification errors
		# when the CRL is for the client cert but SIPp tries to verify the server cert with it
		TLS_CA_PATH=""
		if [ -f "/etc/ssl/certs/ca-certificates.crt" ]; then
			TLS_CA_PATH="-tls_ca /etc/ssl/certs/ca-certificates.crt"
		elif [ -f "/etc/pki/tls/certs/ca-bundle.crt" ]; then
			TLS_CA_PATH="-tls_ca /etc/pki/tls/certs/ca-bundle.crt"
		fi

		# Use TLS 1.2 for compatibility with older servers
		TLS_OPTIONS="-tls_cert $TLS_CERT -tls_key $TLS_KEY -tls_version 1.2 $TLS_CA_PATH"
	else
		echo "ERROR: TLS transport requested but certificates not found!"
		echo "Expected: $TLS_CERT and $TLS_KEY"
		echo "Please run: $BASE_DIR/sipp/scripts/generate_tls_certs.sh"
		exit 1
	fi
fi

MEDIAPORT_LOGIC=" -mp $MEDIA_PORT "

SIPP_CMD="sipp ${SUT}${SIP_PORT_ADD_ON} -r $CALLRATE -m $NUMCALLS \
-sf $BASE_DIR/sipp/scripts/sipp_uac_pcap_g711a.xml \
-inf $INPUTFILE \
-watchdog_interval 900000 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
-t $TRANSPORT \
-i $PRIVATEIP \
-p $SIP_PORT \
-cp $CONTROL_PORT \
$MEDIAPORT_LOGIC \
$TLS_OPTIONS \
-inf $BASE_DIR/sipp/csv/random_caller_ids.csv \
-recv_timeout 60000 \
-key media_ip $PUBLICIP \
-trace_stat -stf $STATS_FILE -fd 15 -bg "

# Log command to syslog
logger -t sipp-inbound -p user.info "Starting inbound calls: server=$SERVER_ID scenario=inbound transport=$TRANSPORT timezone=$TIMEZONE send_rtp=$SEND_RTP_FINAL sip_port=$SIP_PORT media_port=$MEDIA_PORT control_port=$CONTROL_PORT"

# Execute sipp command (runs in background with -bg flag)
# Capture output to extract the PID
SIPP_OUTPUT=$($SIPP_CMD 2>&1)
SIPP_EXIT=$?

# Log the output
echo "$SIPP_OUTPUT" | logger -t sipp-inbound -p user.info

# Extract the actual sipp PID from the "Background mode - PID=[XXXXX]" message
SIPP_PID=$(echo "$SIPP_OUTPUT" | grep -oP 'Background mode - PID=\[\K[0-9]+(?=\])')

# Give it 2 seconds to start, then verify it's still running
sleep 2

# Check if sipp process is still running
if [ -n "$SIPP_PID" ] && ps -p $SIPP_PID > /dev/null 2>&1; then
	logger -t sipp-inbound -p user.info "Inbound process started successfully: server=$SERVER_ID scenario=inbound transport=$TRANSPORT timezone=$TIMEZONE send_rtp=$SEND_RTP_FINAL calls=$NUMCALLS pid=$SIPP_PID"
elif [ $SIPP_EXIT -ne 0 ]; then
	logger -t sipp-inbound -p user.err "Inbound process failed to start: server=$SERVER_ID scenario=inbound transport=$TRANSPORT timezone=$TIMEZONE exit_code=$SIPP_EXIT"
    # Log full sipp command
	logger -t sipp-inbound -p user.info "Command: $SIPP_CMD"
	exit 1
else


	logger -t sipp-inbound -p user.err "Inbound process failed to start or crashed: server=$SERVER_ID scenario=inbound transport=$TRANSPORT timezone=$TIMEZONE"
    # Log full sipp command
	logger -t sipp-inbound -p user.info "Command: $SIPP_CMD"
	exit 1
fi 