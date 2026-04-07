#!/bin/bash
#https://github.com/dizzy/sipR/tree/master/sipRtest/register
#https://github.com/saghul/sipp-scenarios/blob/master/sipp_uas_pcap_g711a.xml
#https://github.com/SIPp/sipp/issues/412

# Multi-server compatible registration script
# Called by register_all.sh with appropriate parameters

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source $BASE_DIR/.env

# Debug mode: controls verbose logging (screen dumps, frequent status checks)
# Set DEBUG=1 in .env or export DEBUG=1 to enable
DEBUG=${DEBUG:-0}

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

FILE_LINE_COUNT=`cat $INPUTFILE | grep -v SEQUENTIAL | grep -v RANDOM | wc -l`

# Time-based registration variation using a cosine curve:
#   Peak:   +0.10 at local noon (most devices registered mid-day)
#   Trough: -0.10 at local midnight
# CPS_TZ_OFFSET controls local time reference (default -7 for PDT), shared with inbound.sh
CPS_TZ_OFFSET=${CPS_TZ_OFFSET:--7}
CURRENT_HOUR=$(date -u +%H)
CURRENT_MIN=$(date -u +%M)
TIME_ADJUSTMENT=$(awk -v hour="$CURRENT_HOUR" -v min="$CURRENT_MIN" -v offset="$CPS_TZ_OFFSET" \
    'BEGIN { pi=3.14159265358979; utc_frac=hour+min/60; local_frac=(utc_frac+offset+48)%24; printf "%.4f", 0.1*cos(2*pi*(local_frac-12)/24) }')
PCT_USERS=$(awk -v base="$REGISTRATION_PCT" -v adj="$TIME_ADJUSTMENT" -v seed="$RANDOM" \
    'BEGIN { srand(seed); noise=(rand()*0.04)-0.02; v=base+adj+noise; if(v<0) v=0; if(v>1) v=1; printf "%.4f", v; printf " %.4f", noise > "/dev/stderr" }' \
    2>/tmp/pct_noise_$$)
NOISE=$(cat /tmp/pct_noise_$$); rm -f /tmp/pct_noise_$$
LOCAL_HOUR=$(awk -v h="$CURRENT_HOUR" -v m="$CURRENT_MIN" -v o="$CPS_TZ_OFFSET" 'BEGIN{printf "%.2f", (h+m/60+o+48)%24}')
echo "PCT_USERS: $PCT_USERS (base: $REGISTRATION_PCT, time_adjustment: $TIME_ADJUSTMENT, noise: $NOISE, local_hour: $LOCAL_HOUR, UTC: $CURRENT_HOUR:$CURRENT_MIN, tz_offset: $CPS_TZ_OFFSET)"

MAX_USERS=`printf "%.0f\n" $(echo "scale=2;$PCT_USERS*$FILE_LINE_COUNT" |bc)`
LOG_FILE=$(basename "$INPUTFILE")
# Spread registrations over 9 minutes (540 seconds) to fit in 10-minute window
CALLRATE=`printf "%.0f\n" $(echo "scale=2;$MAX_USERS/540" |bc)`
# Ensure minimum rate of 1 call/sec for small device counts
if [ $CALLRATE -lt 1 ]; then
	CALLRATE=1
fi


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

# Duration limit: 80 minutes (4800 seconds) allows for:
# - 9 min ramp-up to register all users
# - 58.5 min main registration loop (78 iterations × 45s)
# - 12.5 min buffer for incoming calls via -oocsf
DURATION_SECONDS=4800


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

# Conditionally add debug flags
TRACE_SCREEN=""
if [ "$DEBUG" = "1" ]; then
	TRACE_SCREEN="-trace_screen"
fi

SIPP_CMD="sipp ${SUT}${SIP_PORT_ADD_ON} -key expires 60 -r $[CALLRATE] -m $MAX_USERS -l $MAX_USERS \
-t $TRANSPORT $TLS_OPTIONS -p $PORT -cp $CONTROL_PORT -rtp_echo \
-sf $BASE_DIR/sipp/scripts/register.and.subscribe.sipp.xml \
-oocsf $BASE_DIR/sipp/scripts/sipp_uas_pcap_g711a.xml \
-inf $INPUTFILE \
-inf $BASE_DIR/sipp/csv/random_user_agents.csv \
-recv_timeout 60000 \
-watchdog_interval 0 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
-aa -default_behaviors -abortunexp \
$MEDIAPORT_LOGIC \
-i $PRIVATEIP -mi $PRIVATEIP \
-trace_stat -stf $STATS_FILE -fd 15 $TRACE_SCREEN -bg "

echo "SIPP command: $SIPP_CMD"
# Log command to syslog
logger -t sipp-register -p user.info "Starting registration: server=$SERVER_ID scenario=register transport=$TRANSPORT file=$LOG_FILE users=$MAX_USERS duration=${DURATION_SECONDS}s sip_port=$PORT media_port=$MEDIA_PORT control_port=$CONTROL_PORT"



# Execute sipp command (runs in background with -bg flag)
# Capture output to extract the PID
SIPP_OUTPUT=$($SIPP_CMD 2>&1)
SIPP_EXIT=$?

# Log the output
# echo "$SIPP_OUTPUT" | logger -t sipp-register -p user.info

# Extract the actual sipp PID from the "Background mode - PID=[XXXXX]" message
SIPP_PID=$(echo "$SIPP_OUTPUT" | grep -oP 'Background mode - PID=\[\K[0-9]+(?=\])')

# Record start time for runtime calculation
START_TIME=$(date +%s)

# Give it 2 seconds to start, then verify it's still running
sleep 2

ADDITION_INFO="scenario=register server=$SERVER_ID transport=$TRANSPORT file=$LOG_FILE users=$MAX_USERS duration=${DURATION_SECONDS}s pid=$SIPP_PID call_rate=$CALLRATE sip_port=$PORT media_port=$MEDIA_PORT control_port=$CONTROL_PORT filelinecount=$FILE_LINE_COUNT pct_reg=$PCT_USERS"
# Check if sipp process is still running
if [ -n "$SIPP_PID" ] && ps -p $SIPP_PID > /dev/null 2>&1; then
	logger -t sipp-register -p user.info "Registration process started successfully:  $ADDITION_INFO"

	# Monitor the process until completion
	echo "Monitoring SIPp process (PID: $SIPP_PID) - checking every 20 seconds..."

	# Calculate expected milestones
	RAMPUP_SECONDS=$((MAX_USERS / CALLRATE))
	RAMPUP_MINUTES=$(echo "scale=1; $RAMPUP_SECONDS / 60" | bc)
	LOOP_DURATION_SECONDS=$((78 * 45))  # 78 loops × 45s = 3510s = 58.5 min
	EXPECTED_END_SECONDS=$((RAMPUP_SECONDS + LOOP_DURATION_SECONDS))
	EXPECTED_END_MINUTES=$(echo "scale=1; $EXPECTED_END_SECONDS / 60" | bc)

	echo "Expected milestones:"
	echo "  - Ramp-up complete: ${RAMPUP_MINUTES} min (registering $MAX_USERS users at $CALLRATE users/sec)"
	echo "  - Scenario end: ${EXPECTED_END_MINUTES} min (ramp-up + 78 loops of 45s re-registers)"
	if [ "$DEBUG" = "1" ]; then
		echo "  - Debug mode enabled: screen dumps to register_${SIPP_PID}_screens.log (every minute via USR2)"
	fi
	logger -t sipp-register -p user.info "Expected timeline: rampup=${RAMPUP_MINUTES}min total=${EXPECTED_END_MINUTES}min $ADDITION_INFO debug=$DEBUG"

	SOFT_KILL_SENT=false
	TERM_KILL_SENT=false
	HARD_KILL_SENT=false
	RAMPUP_LOGGED=false
	EXPECTED_END_LOGGED=false
	LAST_STATUS_LOG=0
	LAST_SCREEN_DUMP=0

	while true; do
		sleep 20

		# Calculate elapsed time
		CURRENT_TIME=$(date +%s)
		ELAPSED_SECONDS=$((CURRENT_TIME - START_TIME))
		ELAPSED_MINUTES=$(echo "scale=1; $ELAPSED_SECONDS / 60" | bc)

		# Trigger screen dump every minute via USR2 signal (only in debug mode)
		if [ "$DEBUG" = "1" ] && [ $((ELAPSED_SECONDS - LAST_SCREEN_DUMP)) -ge 60 ]; then
			if ps -p $SIPP_PID > /dev/null 2>&1; then
				kill -USR2 $SIPP_PID 2>/dev/null || true
				LAST_SCREEN_DUMP=$ELAPSED_SECONDS
			fi
		fi

		# Check if process is still running
		if ! ps -p $SIPP_PID > /dev/null 2>&1; then
			# Process has ended - calculate runtime
			END_TIME=$(date +%s)
			RUNTIME_SECONDS=$((END_TIME - START_TIME))
			RUNTIME_MINUTES=$(echo "scale=1; $RUNTIME_SECONDS / 60" | bc)

			# Log completion with runtime
			logger -t sipp-register -p user.info "Registration process completed: $ADDITION_INFO runtime=${RUNTIME_MINUTES}min"
			echo "SIPp process completed after ${RUNTIME_MINUTES} minutes"
			break
		fi

		# Log when ramp-up should be complete
		if [ $ELAPSED_SECONDS -ge $RAMPUP_SECONDS ] && [ "$RAMPUP_LOGGED" = false ]; then
			echo "Ramp-up phase should be complete (elapsed: ${ELAPSED_MINUTES}min, expected: ${RAMPUP_MINUTES}min)"
			logger -t sipp-register -p user.info "Ramp-up complete: $ADDITION_INFO elapsed=${ELAPSED_MINUTES}min"
			RAMPUP_LOGGED=true
		fi

		# Log when scenario should end (but it's still running)
		if [ $ELAPSED_SECONDS -ge $EXPECTED_END_SECONDS ] && [ "$EXPECTED_END_LOGGED" = false ]; then
			echo "WARNING: Process still running past expected end time (elapsed: ${ELAPSED_MINUTES}min, expected: ${EXPECTED_END_MINUTES}min)"
			logger -t sipp-register -p user.warning "Running past expected end: $ADDITION_INFO elapsed=${ELAPSED_MINUTES}min expected=${EXPECTED_END_MINUTES}min"
			EXPECTED_END_LOGGED=true
		fi

		# Periodic status logging (5 min in debug mode, 15 min otherwise)
		STATUS_INTERVAL=$( [ "$DEBUG" = "1" ] && echo 300 || echo 900 )
		if [ $((ELAPSED_SECONDS - LAST_STATUS_LOG)) -ge $STATUS_INTERVAL ]; then
			# Determine current phase
			if [ $ELAPSED_SECONDS -lt $RAMPUP_SECONDS ]; then
				PHASE="rampup"
				PROGRESS_PCT=$(echo "scale=1; ($ELAPSED_SECONDS * 100) / $RAMPUP_SECONDS" | bc)
				STATUS_MSG="Phase: $PHASE (${PROGRESS_PCT}% complete)"
			elif [ $ELAPSED_SECONDS -lt $EXPECTED_END_SECONDS ]; then
				PHASE="reregister_loop"
				LOOP_ELAPSED=$((ELAPSED_SECONDS - RAMPUP_SECONDS))
				CURRENT_LOOP=$((LOOP_ELAPSED / 45))
				STATUS_MSG="Phase: $PHASE (loop $CURRENT_LOOP/78)"
			else
				PHASE="overtime"
				OVERTIME_SECONDS=$((ELAPSED_SECONDS - EXPECTED_END_SECONDS))
				OVERTIME_MINUTES=$(echo "scale=1; $OVERTIME_SECONDS / 60" | bc)
				STATUS_MSG="Phase: $PHASE (+${OVERTIME_MINUTES}min past expected end)"
			fi

			# Read actual statistics from SIPp stats file if available
			STATS_MSG=""
			if [ -f "$STATS_FILE" ]; then
				# Get the last line of stats (most recent snapshot)
				LAST_STATS=$(tail -n 1 "$STATS_FILE" 2>/dev/null)

				if [ -n "$LAST_STATS" ]; then
					# Parse CSV fields (semicolon-delimited by default)
					# Field order: StartTime;LastResetTime;CurrentTime;ElapsedTime;CallRate;IncomingCall;OutgoingCall;TotalCallCreated;CurrentCall;SuccessfulCall;FailedCall;...
					IFS=';' read -ra STATS_ARRAY <<< "$LAST_STATS"

					# Extract key metrics (0-indexed)
					SIPP_ELAPSED="${STATS_ARRAY[3]}"          # ElapsedTime (msec)
					SIPP_CALL_RATE="${STATS_ARRAY[4]}"        # CallRate
					SIPP_TOTAL_CREATED="${STATS_ARRAY[7]}"    # TotalCallCreated
					SIPP_CURRENT_CALLS="${STATS_ARRAY[8]}"    # CurrentCall
					SIPP_SUCCESS="${STATS_ARRAY[9]}"          # SuccessfulCall
					SIPP_FAILED="${STATS_ARRAY[10]}"          # FailedCall

					# Convert elapsed time to minutes
					if [ -n "$SIPP_ELAPSED" ] && [ "$SIPP_ELAPSED" != "ElapsedTime" ]; then
						SIPP_ELAPSED_MIN=$(echo "scale=1; $SIPP_ELAPSED / 60000" | bc 2>/dev/null || echo "?")
						STATS_MSG="sipp_stats: elapsed=${SIPP_ELAPSED_MIN}min created=$SIPP_TOTAL_CREATED active=$SIPP_CURRENT_CALLS success=$SIPP_SUCCESS failed=$SIPP_FAILED rate=$SIPP_CALL_RATE"
					fi
				fi
			fi

			echo "Status check: ${ELAPSED_MINUTES}min elapsed - $STATUS_MSG"
			if [ -n "$STATS_MSG" ]; then
				echo "  SIPp stats: $STATS_MSG"
				logger -t sipp-register -p user.info "Status: $STATUS_MSG $STATS_MSG $ADDITION_INFO elapsed=${ELAPSED_MINUTES}min"
			else
				logger -t sipp-register -p user.info "Status: $STATUS_MSG $ADDITION_INFO elapsed=${ELAPSED_MINUTES}min"
			fi
			LAST_STATUS_LOG=$ELAPSED_SECONDS
		fi

		# Soft kill at 75 minutes (4500 seconds) - send quit command via control port
		if [ $ELAPSED_SECONDS -ge 4500 ] && [ "$SOFT_KILL_SENT" = false ]; then
			echo "Runtime ${ELAPSED_MINUTES}min exceeded 75 min threshold - sending soft shutdown via control port $CONTROL_PORT"
			logger -t sipp-register -p user.warning "Soft shutdown triggered: $ADDITION_INFO elapsed=${ELAPSED_MINUTES}min"
			# Send 'q' command to SIPp control port to trigger graceful shutdown
			echo "q" | nc -w 1 localhost $CONTROL_PORT 2>/dev/null || true
			SOFT_KILL_SENT=true
		fi

		# SIGTERM at 85 minutes (5100 seconds) if still running
		if [ $ELAPSED_SECONDS -ge 5100 ] && [ "$TERM_KILL_SENT" = false ]; then
			echo "Runtime ${ELAPSED_MINUTES}min exceeded 85 min threshold - sending SIGTERM to PID $SIPP_PID"
			logger -t sipp-register -p user.warning "SIGTERM sent: $ADDITION_INFO elapsed=${ELAPSED_MINUTES}min"
			kill -TERM $SIPP_PID 2>/dev/null || true
			TERM_KILL_SENT=true
		fi

		# Hard kill (SIGKILL) at 90 minutes (5400 seconds) if still running
		if [ $ELAPSED_SECONDS -ge 5400 ] && [ "$HARD_KILL_SENT" = false ]; then
			echo "Runtime ${ELAPSED_MINUTES}min exceeded 90 min threshold - sending SIGKILL to PID $SIPP_PID"
			logger -t sipp-register -p user.error "SIGKILL sent (force kill): $ADDITION_INFO elapsed=${ELAPSED_MINUTES}min"
			kill -9 $SIPP_PID 2>/dev/null || true
			HARD_KILL_SENT=true
		fi
	done
elif [ $SIPP_EXIT -ne 0 ]; then
	logger -t sipp-register -p user.err "Registration process failed to start: $ADDITION_INFO exit_code=$SIPP_EXIT"
	# Log full sipp command
	logger -t sipp-register -p user.info "Command: $SIPP_CMD"
	exit 1
else
	logger -t sipp-register -p user.err "Registration process failed to start or crashed: $ADDITION_INFO"
	# Log full sipp command
	logger -t sipp-register -p user.info "Command: $SIPP_CMD"
	exit 1
fi 