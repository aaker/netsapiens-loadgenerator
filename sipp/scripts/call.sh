#!/bin/bash
# Call execution script - runs sipp with call scenario
# Called by call_all.sh with appropriate parameters

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source $BASE_DIR/.env

# Source port allocator for port release on exit
source "$BASE_DIR/sipp/scripts/port-allocator.sh"

SUT=$1
INPUTFILE=$2
TRANSPORT=$3
PORT=$4
MEDIA_PORT=$5
CONTROL_PORT=$6
MEDIA_IP=$7
SERVER_ID=$8  # Optional: for multi-server stats tracking

PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

# Replace SEQUENTIAL with RANDOM in the input file to randomize user selection
TEMP_CSV="/tmp/call_$$.csv"
cat $INPUTFILE | sed 's/SEQUENTIAL/RANDOM/g' > $TEMP_CSV
cat $TEMP_CSV > $INPUTFILE
rm -f $TEMP_CSV

head -n 2 $INPUTFILE

FILE_LINE_COUNT=$(cat $INPUTFILE | grep -v SEQUENTIAL | grep -v RANDOM | wc -l)

# Percentage of users to make calls (use CALL_PCT from .env or default to 5%)
PCT_USERS=${CALL_PCT:-0.05}

MAX_USERS=$(printf "%.0f\n" $(echo "scale=2;$PCT_USERS*$FILE_LINE_COUNT" | bc))

# Ensure at least 1 call
if [ "$MAX_USERS" -lt 1 ]; then
    MAX_USERS=1
fi

LOG_FILE=$(basename "$INPUTFILE")

# Call rate - spread calls over time (default: 1 call per second, adjust as needed)
CALLRATE=${CALL_RATE:-1}

echo "Making calls from $INPUTFILE"
ulimit -n 65536

# Use BASE_DIR for log file path
LOG_PATH="$BASE_DIR/sipp/scripts"
STATS_PATH="$BASE_DIR/sipp/stats"

# Create stats filename with server ID and transport
if [ -n "$SERVER_ID" ]; then
    STATS_FILE="${STATS_PATH}/${SERVER_ID}_call_${TRANSPORT}_${LOG_FILE}_$$.csv"
else
    STATS_FILE="${STATS_PATH}/call_${TRANSPORT}_${LOG_FILE}_$$.csv"
fi

echo "$(date) - [start] $INPUTFILE $PORT $MEDIA_PORT $CONTROL_PORT (max users $MAX_USERS, pct users is $PCT_USERS) stats: $STATS_FILE" >> "$LOG_PATH/error_call_$LOG_FILE.log"

MEDIAPORT_LOGIC=" -mp $MEDIA_PORT "

# TLS certificate configuration (only used when TRANSPORT=l1)
TLS_CERT="$BASE_DIR/sipp/tls/sipp.crt"
TLS_KEY="$BASE_DIR/sipp/tls/sipp.key"
TLS_OPTIONS=""
SIP_PORT_ADD_ON=""

if [ "$TRANSPORT" == "l1" ]; then
    SIP_PORT_ADD_ON=":5061"
    if [ -f "$TLS_CERT" ] && [ -f "$TLS_KEY" ]; then
        TLS_CA_PATH=""
        if [ -f "/etc/ssl/certs/ca-certificates.crt" ]; then
            TLS_CA_PATH="-tls_ca /etc/ssl/certs/ca-certificates.crt"
        elif [ -f "/etc/pki/tls/certs/ca-bundle.crt" ]; then
            TLS_CA_PATH="-tls_ca /etc/pki/tls/certs/ca-bundle.crt"
        fi

        TLS_OPTIONS="-tls_cert $TLS_CERT -tls_key $TLS_KEY -tls_version 1.2 $TLS_CA_PATH"
    else
        echo "ERROR: TLS transport requested but certificates not found!"
        echo "Expected: $TLS_CERT and $TLS_KEY"
        echo "Please run: $BASE_DIR/sipp/scripts/generate_tls_certs.sh"
        exit 1
    fi
fi

# Generate random target extension between 1001 and 1100
TARGET_EXT=$((1001 + RANDOM % 100))

SIPP_CMD="sipp ${SUT}${SIP_PORT_ADD_ON} -r $CALLRATE -m $MAX_USERS \
-t $TRANSPORT $TLS_OPTIONS -p $PORT -cp $CONTROL_PORT -rtp_echo \
-sf $BASE_DIR/sipp/scripts/sipp_uac_onnect.xml \
-inf $INPUTFILE \
-key target_ext $TARGET_EXT \
-recv_timeout 30000 \
-watchdog_interval 0 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
-aa -default_behaviors -abortunexp \
$MEDIAPORT_LOGIC \
-i $PRIVATEIP -mi $PRIVATEIP \
-trace_stat -stf $STATS_FILE -fd 15 -bg "

echo "SIPP command: $SIPP_CMD"

# Log command to syslog
logger -t sipp-call -p user.info "Starting calls: server=$SERVER_ID scenario=call transport=$TRANSPORT file=$LOG_FILE users=$MAX_USERS sip_port=$PORT media_port=$MEDIA_PORT control_port=$CONTROL_PORT"

# Execute sipp command (runs in background with -bg flag)
SIPP_OUTPUT=$($SIPP_CMD 2>&1)
SIPP_EXIT=$?

# Extract the actual sipp PID from the "Background mode - PID=[XXXXX]" message
SIPP_PID=$(echo "$SIPP_OUTPUT" | grep -oP 'Background mode - PID=\[\K[0-9]+(?=\])')

# Give it 2 seconds to start, then verify it's still running
sleep 2

ADDITION_INFO="scenario=call server=$SERVER_ID transport=$TRANSPORT file=$LOG_FILE users=$MAX_USERS pid=$SIPP_PID call_rate=$CALLRATE sip_port=$PORT media_port=$MEDIA_PORT control_port=$CONTROL_PORT filelinecount=$FILE_LINE_COUNT pct_call=$PCT_USERS"

# Check if sipp process is still running
if [ -n "$SIPP_PID" ] && ps -p $SIPP_PID > /dev/null 2>&1; then
    logger -t sipp-call -p user.info "Call process started successfully: $ADDITION_INFO"
elif [ $SIPP_EXIT -ne 0 ]; then
    logger -t sipp-call -p user.err "Call process failed to start: $ADDITION_INFO exit_code=$SIPP_EXIT"
    logger -t sipp-call -p user.info "Command: $SIPP_CMD"
    exit 1
else
    logger -t sipp-call -p user.err "Call process failed to start or crashed: $ADDITION_INFO"
    logger -t sipp-call -p user.info "Command: $SIPP_CMD"
    exit 1
fi
