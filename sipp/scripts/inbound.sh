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

# Time-based CPS multiplier
# Curve expressed in local time via CPS_TZ_OFFSET (default -7 for PDT)
# Shape: peaks at 11am and 1pm local, noon dip (90%), 10% overnight (6pm-6am)
# Day-of-week scaling: Mon-Fri=100%, Sat=40%, Sun=20%
CPS_TZ_OFFSET=${CPS_TZ_OFFSET:--7}
CURRENT_HOUR_UTC=$(date -u +%H)
CURRENT_MIN_UTC=$(date -u +%M)
CURRENT_DOW=$(date -u +%u)  # 1=Monday ... 6=Saturday, 7=Sunday
CPS_MULTIPLIER=$(awk -v hour="$CURRENT_HOUR_UTC" -v min="$CURRENT_MIN_UTC" -v offset="$CPS_TZ_OFFSET" -v dow="$CURRENT_DOW" 'BEGIN {
    pi = 3.14159265358979
    utc_frac = hour + min/60
    # Convert to local fractional hour, wrap to [0,24)
    local_frac = (utc_frac + offset + 48) % 24
    if (local_frac >= 6 && local_frac < 11) {
        # Ramp up: 0.1 at 6am -> 1.0 at 11am
        mult = 0.1 + 0.9 * (local_frac - 6) / 5
    } else if (local_frac >= 11 && local_frac < 13) {
        # Cosine dip: peaks at 11am and 1pm, trough at noon
        mult = 0.95 + 0.05 * cos(pi * (local_frac - 11))
    } else if (local_frac >= 13 && local_frac < 18) {
        # Ramp down: 1.0 at 1pm -> 0.1 at 6pm
        mult = 1.0 - 0.9 * (local_frac - 13) / 5
    } else {
        # Overnight low (6pm-6am)
        mult = 0.1
    }
    # Day-of-week scaling (dow: 1=Mon...6=Sat, 7=Sun)
    if (dow == 6) mult = mult * 0.4
    else if (dow == 7) mult = mult * 0.2
    printf "%.4f", mult
}')

# Apply multiplier and ±2% random noise to PEAK_CPS
PEAK_CPS=$(awk -v cps="$PEAK_CPS" -v mult="$CPS_MULTIPLIER" -v seed="$RANDOM" \
    'BEGIN { srand(seed); noise=(rand()*0.04)-0.02; v=cps*mult*(1+noise); if(v<0.01) v=0.01; printf "%.2f", v; printf " %.4f", noise > "/dev/stderr" }' \
    2>/tmp/inbound_noise_$$)
NOISE=$(cat /tmp/inbound_noise_$$); rm -f /tmp/inbound_noise_$$
LOCAL_HOUR=$(awk -v h="$CURRENT_HOUR_UTC" -v m="$CURRENT_MIN_UTC" -v o="$CPS_TZ_OFFSET" 'BEGIN{printf "%.2f", (h+m/60+o+48)%24}')
DOW_NAME=$(awk -v d="$CURRENT_DOW" 'BEGIN{split("Mon,Tue,Wed,Thu,Fri,Sat,Sun",a,","); print a[d]}')
echo "PEAK_CPS: $PEAK_CPS (multiplier: $CPS_MULTIPLIER, noise: $NOISE, local_hour: $LOCAL_HOUR, UTC: ${CURRENT_HOUR_UTC}:${CURRENT_MIN_UTC}, tz_offset: $CPS_TZ_OFFSET, day: $DOW_NAME)"


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
    # Comment out play_pcap_audio lines - only if not already commented
    sed -i -e 's/^[[:space:]]*<exec play_pcap_audio="g711a\.pcap"\/>/      <!-- RTP_DISABLED: <exec play_pcap_audio="g711a.pcap"\/> -->/g' \
           /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
else
    echo "Enabling RTP playback in XML scenario (uncommenting play_pcap_audio if needed)"
    # Restore any previously commented RTP lines - only if currently commented
    sed -i -e 's/^[[:space:]]*<!-- RTP_DISABLED: <exec play_pcap_audio="g711a\.pcap"\/> -->/<exec play_pcap_audio="g711a.pcap"\/>/g' \
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

# Record start time for runtime calculation
START_TIME=$(date +%s)

# Give it 2 seconds to start, then verify it's still running
sleep 2

# Check if sipp process is still running
if [ -n "$SIPP_PID" ] && ps -p $SIPP_PID > /dev/null 2>&1; then
	logger -t sipp-inbound -p user.info "Inbound process started successfully: server=$SERVER_ID scenario=inbound transport=$TRANSPORT timezone=$TIMEZONE send_rtp=$SEND_RTP_FINAL calls=$NUMCALLS pid=$SIPP_PID"

	# Monitor the process until completion
	echo "Monitoring SIPp process (PID: $SIPP_PID) - checking every 20 seconds..."
	while true; do
		sleep 20

		# Check if process is still running
		if ! ps -p $SIPP_PID > /dev/null 2>&1; then
			# Process has ended - calculate runtime
			END_TIME=$(date +%s)
			RUNTIME_SECONDS=$((END_TIME - START_TIME))
			RUNTIME_MINUTES=$(echo "scale=1; $RUNTIME_SECONDS / 60" | bc)

			# Log completion with runtime
			logger -t sipp-inbound -p user.info "Inbound process completed: server=$SERVER_ID scenario=inbound transport=$TRANSPORT timezone=$TIMEZONE send_rtp=$SEND_RTP_FINAL calls=$NUMCALLS pid=$SIPP_PID runtime=${RUNTIME_MINUTES}min"
			echo "SIPp process completed after ${RUNTIME_MINUTES} minutes"
			break
		fi
	done
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