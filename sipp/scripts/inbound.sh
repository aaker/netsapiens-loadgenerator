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

        # Loop through each server and launch in parallel, with a short stagger
        # between launches so all servers' inbound batches run concurrently
        # within the same 5-minute window.
        SERVER_COUNT=$(echo "$SERVER_IDS" | wc -w)
        STAGGER_MAX=15
        STAGGER_DELAY=$STAGGER_MAX
        if [ "$SERVER_COUNT" -gt 1 ]; then
            # Spread launches across the first STAGGER_MAX seconds at most
            STAGGER_DELAY=$(( STAGGER_MAX / (SERVER_COUNT - 1) ))
            [ "$STAGGER_DELAY" -lt 1 ] && STAGGER_DELAY=1
            [ "$STAGGER_DELAY" -gt "$STAGGER_MAX" ] && STAGGER_DELAY=$STAGGER_MAX
        fi

        FIRST=1
        for SID in $SERVER_IDS; do
            if [ "$FIRST" -eq 0 ]; then
                sleep "$STAGGER_DELAY"
            fi
            FIRST=0
            echo ""
            echo ">>> Launching inbound calls for server: $SID (timezone: $TIMEZONE, transport: $TRANSPORT)"
            echo "---"
            $0 "$TIMEZONE" "$TRANSPORT" --server "$SID" &
        done

        echo ""
        echo "=========================================="
        echo "Launched $SERVER_COUNT servers in parallel (stagger=${STAGGER_DELAY}s)"
        echo "=========================================="
        exit 0

    echo "Multi-server mode: Using server '$SERVER_ID'"
fi

# Determine target server and CSV path
SIP_PORT_NUM=""
SIP_TLS_PORT_NUM=""
if [ -n "$SERVER_ID" ]; then
    # Multi-server mode: Load configuration from servers.json
    if [ -f "$BASE_DIR/servers.json" ]; then
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

# Fall back to env-provided SIP ports if not set per-server, then to standard defaults
SIP_PORT_NUM=${SIP_PORT_NUM:-${SIP_PORT:-5060}}
SIP_TLS_PORT_NUM=${SIP_TLS_PORT_NUM:-${SIP_TLS_PORT:-5061}}


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
# Day-of-week scaling: Mon-Fri=100%, Sat=40%, Sun=20%
#
# All markers are configurable via .env. Defaults match observed traffic shape:
#
# Local Time | Multiplier             | Variable
# -----------|------------------------|-----------------------------
# 6am        | 0.05 (overnight edge)  | CPS_RAMP_START_HOUR / CPS_OVERNIGHT
# 9am        | 1.00 (peak)            | CPS_PEAK_HOUR / CPS_PEAK
# 10am       | 0.97 (derived)         | -
# 11am       | 0.93 (plateau)         | CPS_LUNCH_START_HOUR / CPS_PLATEAU
# 12pm       | 0.78 (trough)          | CPS_LUNCH_TROUGH
# 1pm        | 0.93 (plateau)         | CPS_LUNCH_END_HOUR / CPS_PLATEAU
# 3pm        | 0.67 (derived)         | -
# 5pm        | 0.40 (cliff)           | CPS_CLIFF_START_HOUR / CPS_CLIFF_LEVEL
# 6pm        | 0.23 (derived)         | -
# 7pm        | 0.05 (overnight edge)  | CPS_CLIFF_END_HOUR / CPS_OVERNIGHT
# 12:30am    | 0.005 (overnight deep) | CPS_DEEP_OVERNIGHT
# 6am        | 0.05 (overnight edge)  | CPS_RAMP_START_HOUR / CPS_OVERNIGHT
#
# Overnight (cliff_end -> ramp_start) is a cosine dip:
#   starts at CPS_OVERNIGHT, reaches CPS_DEEP_OVERNIGHT at the midpoint,
#   returns to CPS_OVERNIGHT before the morning ramp begins.

# Hour markers (local time)
CPS_TZ_OFFSET=${CPS_TZ_OFFSET:--7}
CPS_RAMP_START_HOUR=${CPS_RAMP_START_HOUR:-6}    # overnight ends, ramp begins
CPS_PEAK_HOUR=${CPS_PEAK_HOUR:-9}                # morning peak
CPS_LUNCH_START_HOUR=${CPS_LUNCH_START_HOUR:-11} # plateau ends, lunch dip begins
CPS_LUNCH_END_HOUR=${CPS_LUNCH_END_HOUR:-13}     # lunch dip ends, afternoon decline begins
CPS_CLIFF_START_HOUR=${CPS_CLIFF_START_HOUR:-17} # afternoon ends, evening cliff begins
CPS_CLIFF_END_HOUR=${CPS_CLIFF_END_HOUR:-19}     # cliff ends, overnight resumes

# Level markers (multiplier 0.0-1.0)
CPS_OVERNIGHT=${CPS_OVERNIGHT:-0.05}             # overnight edge (at 7pm and 6am)
CPS_DEEP_OVERNIGHT=${CPS_DEEP_OVERNIGHT:-0.005}  # overnight deep floor (midpoint of overnight)
CPS_PEAK=${CPS_PEAK:-1.00}                       # morning peak level
CPS_PLATEAU=${CPS_PLATEAU:-0.93}                 # level at 11am and 1pm (lunch dip endpoints)
CPS_LUNCH_TROUGH=${CPS_LUNCH_TROUGH:-0.78}       # lunch trough at noon
CPS_CLIFF_LEVEL=${CPS_CLIFF_LEVEL:-0.40}         # level at start of evening cliff

CURRENT_HOUR_UTC=$(date -u +%H)
CURRENT_MIN_UTC=$(date -u +%M)
CURRENT_DOW_UTC=$(date -u +%u)  # 1=Monday ... 6=Saturday, 7=Sunday (UTC)
CPS_MULTIPLIER=$(awk \
    -v hour="$CURRENT_HOUR_UTC" -v min="$CURRENT_MIN_UTC" \
    -v offset="$CPS_TZ_OFFSET" -v dow_utc="$CURRENT_DOW_UTC" \
    -v ramp_start="$CPS_RAMP_START_HOUR" -v peak_hour="$CPS_PEAK_HOUR" \
    -v lunch_start="$CPS_LUNCH_START_HOUR" -v lunch_end="$CPS_LUNCH_END_HOUR" \
    -v cliff_start="$CPS_CLIFF_START_HOUR" -v cliff_end="$CPS_CLIFF_END_HOUR" \
    -v overnight="$CPS_OVERNIGHT" -v deep_overnight="$CPS_DEEP_OVERNIGHT" \
    -v peak="$CPS_PEAK" \
    -v plateau="$CPS_PLATEAU" -v trough="$CPS_LUNCH_TROUGH" \
    -v cliff_level="$CPS_CLIFF_LEVEL" \
    'BEGIN {
    pi = 3.14159265358979
    utc_frac = hour + min/60
    # Convert to local fractional hour, wrap to [0,24)
    local_sum = utc_frac + offset
    local_frac = (local_sum + 48) % 24
    # Derive local day-of-week from the same offset (avoids Sunday-night
    # spikes when UTC has already rolled into Monday but local is still Sun).
    day_shift = 0
    if (local_sum < 0) day_shift = -1
    else if (local_sum >= 24) day_shift = 1
    dow = dow_utc + day_shift
    if (dow < 1) dow += 7apt 
    if (dow > 7) dow -= 7
    # Overnight cosine dip spans cliff_end -> ramp_start (wrapping midnight)
    overnight_duration = (24 - cliff_end) + ramp_start
    overnight_A = (overnight + deep_overnight) / 2
    overnight_B = (overnight - deep_overnight) / 2
    if (local_frac < ramp_start) {
        # Early-morning overnight (post-midnight side of the dip)
        t = (24 - cliff_end) + local_frac
        mult = overnight_A + overnight_B * cos(2 * pi * t / overnight_duration)
    } else if (local_frac < peak_hour) {
        # Steep morning ramp
        mult = overnight + (peak - overnight) * (local_frac - ramp_start) / (peak_hour - ramp_start)
    } else if (local_frac < lunch_start) {
        # Morning plateau taper: peak -> plateau
        mult = peak - (peak - plateau) * (local_frac - peak_hour) / (lunch_start - peak_hour)
    } else if (local_frac < lunch_end) {
        # Lunch dip: cosine from plateau at lunch_start, trough at midpoint, plateau at lunch_end
        A = (plateau + trough) / 2
        B = (plateau - trough) / 2
        mult = A + B * cos(2 * pi * (local_frac - lunch_start) / (lunch_end - lunch_start))
    } else if (local_frac < cliff_start) {
        # Gradual afternoon decline: plateau -> cliff_level
        mult = plateau - (plateau - cliff_level) * (local_frac - lunch_end) / (cliff_start - lunch_end)
    } else if (local_frac < cliff_end) {
        # Steep evening cliff: cliff_level -> overnight
        mult = cliff_level - (cliff_level - overnight) * (local_frac - cliff_start) / (cliff_end - cliff_start)
    } else {
        # Late-evening overnight (pre-midnight side of the dip)
        t = local_frac - cliff_end
        mult = overnight_A + overnight_B * cos(2 * pi * t / overnight_duration)
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
LOCAL_DOW=$(awk -v h="$CURRENT_HOUR_UTC" -v m="$CURRENT_MIN_UTC" -v o="$CPS_TZ_OFFSET" -v d="$CURRENT_DOW_UTC" \
    'BEGIN{s=h+m/60+o; shift=0; if(s<0)shift=-1; else if(s>=24)shift=1; ld=d+shift; if(ld<1)ld+=7; if(ld>7)ld-=7; print ld}')
DOW_NAME=$(awk -v d="$LOCAL_DOW" 'BEGIN{split("Mon,Tue,Wed,Thu,Fri,Sat,Sun",a,","); print a[d]}')
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
    sed -i -e 's/^[[:space:]]*<exec play_pcap_audio="\(g711a-[a-z0-9]*\)\.pcap"\/>/      <!-- RTP_DISABLED: <exec play_pcap_audio="\1.pcap"\/> -->/g' \
           /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
else
    echo "Enabling RTP playback in XML scenario (uncommenting play_pcap_audio if needed)"
    # Restore any previously commented RTP lines - only if currently commented
    sed -i -e 's/^[[:space:]]*<!-- RTP_DISABLED: <exec play_pcap_audio="\(g711a-[a-z0-9]*\)\.pcap"\/> -->/<exec play_pcap_audio="\1.pcap"\/>/g' \
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
if [ "$TRANSPORT" == "l1" ]; then
    SIP_PORT_ADD_ON=":$SIP_TLS_PORT_NUM"
else
    SIP_PORT_ADD_ON=":$SIP_PORT_NUM"
fi
if [ "$TRANSPORT" == "l1" ]; then
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

# Resolve the running version to stamp into the SIP User-Agent ([ua_version]).
source "$BASE_DIR/sipp/scripts/version-utils.sh"
UA_VERSION=$(get_ua_version "$BASE_DIR")

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
-key ua_version $UA_VERSION \
-trace_stat -stf $STATS_FILE -fd 15 -bg "

# Log command to syslog
logger -t sipp-inbound -p user.info "Starting inbound calls: server=$SERVER_ID scenario=inbound transport=$TRANSPORT timezone=$TIMEZONE send_rtp=$SEND_RTP_FINAL sip_port=$SIP_PORT media_port=$MEDIA_PORT control_port=$CONTROL_PORT call_rate=$CALLRATE num_calls=$NUMCALLS"

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