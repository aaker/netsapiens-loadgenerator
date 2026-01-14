#!/bin/bash
#https://github.com/dizzy/sipR/tree/master/sipRtest/register
#https://github.com/saghul/sipp-scenarios/blob/master/sipp_uas_pcap_g711a.xml
#https://github.com/SIPp/sipp/issues/412

# Multi-server compatible registration script
# Called by register_all.sh with appropriate parameters

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

# replace SEQUENTIAL with  RANDOM  in the input file to randomize user selection
TEMP_CSV="/tmp/register_$$.csv"
cat $INPUTFILE | sed 's/SEQUENTIAL/RANDOM/g' > $TEMP_CSV	
cat $TEMP_CSV > $INPUTFILE
rm -f $TEMP_CSV

head -n 2 $INPUTFILE 

MAX_USERS=`cat $INPUTFILE | grep -v SEQUENTIAL | grep -v RANDOM | wc -l`
PCT_USERS=$REGISTRATION_PCT # % of the users will be registered

MAX_USERS=`printf "%.0f\n" $(echo "scale=2;$PCT_USERS*$MAX_USERS" |bc)`

LOG_FILE=$(basename "$INPUTFILE")
CALLRATE=`printf "%.0f\n" $(echo "scale=2;$MAX_USERS/50" |bc)`


echo "Registering $INPUTFILE"
ulimit -n 65536

# Use BASE_DIR for log file path
LOG_PATH="$BASE_DIR/sipp/scripts"
STATS_PATH="$BASE_DIR/sipp/stats"

# Create stats filename with server ID and transport
if [ -n "$SERVER_ID" ]; then
    STATS_FILE="${STATS_PATH}/${SERVER_ID}_register_${TRANSPORT}_${LOG_FILE}_$$.csv"
else
    STATS_FILE="${STATS_PATH}/register_${TRANSPORT}_${LOG_FILE}_$$.csv"
fi

echo "`date` - [start] $INPUTFILE $PORT $MEDIA_PORT $CONTROL_PORT (max users $MAX_USERS, pct users is $PCT_USERS) stats: $STATS_FILE" >> "$LOG_PATH/error_$LOG_FILE.log"

MEDIAPORT_LOGIC=" -mp $MEDIA_PORT "

#$RANDOM_15 is a random number between 10000 and 600000 (10 seconds to 10 minutes)
RANDOM_15=$(( ( RANDOM % 590000 )  + 10000 ))


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

SIPP_CMD="sipp ${SUT}${SIP_PORT_ADD_ON} -key expires 60 -r $[CALLRATE] -m $MAX_USERS \
-t $TRANSPORT $TLS_OPTIONS -p $PORT -cp $CONTROL_PORT -rtp_echo \
-sf $BASE_DIR/sipp/scripts/register.and.subscribe.sipp.xml \
-key bye_timeout $RANDOM_15 \
-oocsf $BASE_DIR/sipp/scripts/sipp_uas_pcap_g711a.xml \
-inf $INPUTFILE \
-inf $BASE_DIR/sipp/csv/random_user_agents.csv \
-recv_timeout 60000 \
-watchdog_interval 0 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
-aa -default_behaviors -abortunexp \
$MEDIAPORT_LOGIC \
-i $PRIVATEIP -mi $PRIVATEIP \
-trace_stat -stf $STATS_FILE -fd 15 -bg "

echo "SIPP command: $SIPP_CMD"
# Log command to syslog
logger -t sipp-register -p user.info "Starting registration: server=$SERVER_ID scenario=register transport=$TRANSPORT file=$LOG_FILE users=$MAX_USERS sip_port=$PORT media_port=$MEDIA_PORT control_port=$CONTROL_PORT"



# Execute sipp command (runs in background with -bg flag)
# Capture output to extract the PID
SIPP_OUTPUT=$($SIPP_CMD 2>&1)
SIPP_EXIT=$?

# Log the output
# echo "$SIPP_OUTPUT" | logger -t sipp-register -p user.info

# Extract the actual sipp PID from the "Background mode - PID=[XXXXX]" message
SIPP_PID=$(echo "$SIPP_OUTPUT" | grep -oP 'Background mode - PID=\[\K[0-9]+(?=\])')

# Give it 2 seconds to start, then verify it's still running
sleep 2

# Check if sipp process is still running
if [ -n "$SIPP_PID" ] && ps -p $SIPP_PID > /dev/null 2>&1; then
	logger -t sipp-register -p user.info "Registration process started successfully: server=$SERVER_ID scenario=register transport=$TRANSPORT file=$LOG_FILE users=$MAX_USERS pid=$SIPP_PID"
elif [ $SIPP_EXIT -ne 0 ]; then
	logger -t sipp-register -p user.err "Registration process failed to start: server=$SERVER_ID scenario=register transport=$TRANSPORT file=$LOG_FILE exit_code=$SIPP_EXIT"
	# Log full sipp command
	logger -t sipp-register -p user.info "Command: $SIPP_CMD"
	exit 1
else
	logger -t sipp-register -p user.err "Registration process failed to start or crashed: server=$SERVER_ID scenario=register transport=$TRANSPORT file=$LOG_FILE"
	# Log full sipp command
	logger -t sipp-register -p user.info "Command: $SIPP_CMD"
	exit 1
fi 