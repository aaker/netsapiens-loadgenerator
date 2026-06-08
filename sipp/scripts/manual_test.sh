#!/bin/bash
# Manual targeted test harness for debugging.
#
# Registers the devices from a CSV you choose (same scenario + flags as the
# cron-driven register_all.sh -> register.sh path), then lets you trigger
# single inbound calls to a number on demand (same scenario + flags as the
# cron-driven inbound.sh path). Everything is scoped down so one call can be
# watched end to end.
#
# Usage:
#   ./manual_test.sh [options]
#
#   -f, --file <csv>      Device CSV to register (the generated format:
#                         SEQUENTIAL header, displayName;device;domain;[authentication ...])
#                         Default: sipp/csv/manual/devices.csv
#   -n, --number <num>    Inbound number (DID) to call
#                         Default: first number in sipp/csv/manual/phonenumbers.csv
#   -t, --transport <t>   u1 (UDP, default) | t1 (TCP) | l1 (TLS)
#   -s, --server <id>     Multi-server mode: resolve hostname from servers.json
#   -c, --count <n>       Calls per trigger (default 1)
#   -w, --wait <sec>      Auto-place the first call after N seconds (default:
#                         wait for registrations, then prompt)
#   -k, --keep            Leave the registration instance running on exit
#   --no-capture          Skip the per-packet tcpdump capture of the media port
#
# Manual mode always enables verbose SIPp tracing: -trace_logs (the __PCAP__
# log lines marking the start of each pcap, with a clock_tick ms timestamp),
# -trace_msg (full SIP messages) and -trace_err. Unless --no-capture, a
# tcpdump of the UAC media port is written per call to the work dir, and a
# per-packet timing summary (tcpdump -ttt) is printed after the call.
#
# Examples:
#   ./manual_test.sh                                   # committed manual CSVs
#   ./manual_test.sh -f sipp/csv/devices/acme_corp.csv -n 14805550100
#   ./manual_test.sh -t t1 -s prod1 -w 5
#
# After the call completes you are prompted again - press Enter to place
# another call (new sipp instance, same paths), or q to quit. On exit the
# registration instance is stopped (unless -k) and ports are released.

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source "$BASE_DIR/.env"
source "$BASE_DIR/sipp/scripts/opus-utils.sh"
source "$BASE_DIR/sipp/scripts/version-utils.sh"
source "$BASE_DIR/sipp/scripts/port-allocator.sh"

# ---------------------------------------------------------------- arguments
# Long-term manual test data lives in sipp/csv/manual/ (committed, unlike the
# generated devices/ and phonenumbers/ dirs which are gitignored).
DEVICE_CSV="$BASE_DIR/sipp/csv/manual/devices.csv"
NUMBER=""
TRANSPORT="u1"
SERVER_ID=""
CALL_COUNT=1
AUTO_WAIT=""
KEEP=0
CAPTURE=1

while [ $# -gt 0 ]; do
    case "$1" in
        -f|--file)      DEVICE_CSV="$2"; shift 2 ;;
        -n|--number)    NUMBER="$2"; shift 2 ;;
        -t|--transport) TRANSPORT="$2"; shift 2 ;;
        -s|--server)    SERVER_ID="$2"; shift 2 ;;
        -c|--count)     CALL_COUNT="$2"; shift 2 ;;
        -w|--wait)      AUTO_WAIT="$2"; shift 2 ;;
        -k|--keep)      KEEP=1; shift ;;
        --no-capture)   CAPTURE=0; shift ;;
        -h|--help)      grep '^#' "$0" | head -35; exit 0 ;;
        *) echo "Unknown option: $1 (try -h)"; exit 1 ;;
    esac
done

# Default number: first entry in the committed manual phonenumbers CSV
if [ -z "$NUMBER" ]; then
    MANUAL_NUMBERS="$BASE_DIR/sipp/csv/manual/phonenumbers.csv"
    if [ -f "$MANUAL_NUMBERS" ]; then
        NUMBER=$(grep -v -e '^SEQUENTIAL' -e '^RANDOM' -e '^[[:space:]]*$' "$MANUAL_NUMBERS" | head -1 | cut -d';' -f1 | tr -d '\r')
    fi
fi

if [ -z "$DEVICE_CSV" ] || [ -z "$NUMBER" ]; then
    echo "ERROR: need a device CSV (-f) and a number (-n, or an entry in sipp/csv/manual/phonenumbers.csv)"
    exit 1
fi
if [ ! -f "$DEVICE_CSV" ]; then
    echo "ERROR: device CSV not found: $DEVICE_CSV"
    exit 1
fi
if ! command -v sipp >/dev/null; then
    echo "ERROR: sipp not found in PATH"
    exit 1
fi

# ------------------------------------------------- target server resolution
# Mirrors inbound.sh/register_all.sh: --server <id> -> servers.json via jq,
# otherwise legacy .env (SAS_SERVER falls back to TARGET_SERVER).
SIP_PORT_NUM=""
SIP_TLS_PORT_NUM=""
if [ -n "$SERVER_ID" ]; then
    if [ ! -f "$BASE_DIR/servers.json" ]; then
        echo "ERROR: --server given but servers.json not found"; exit 1
    fi
    if ! command -v jq >/dev/null; then
        echo "ERROR: jq is required for multi-server mode"; exit 1
    fi
    SUT=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .hostname" "$BASE_DIR/servers.json")
    if [ -z "$SUT" ] || [ "$SUT" == "null" ]; then
        echo "ERROR: server '$SERVER_ID' not found in servers.json"; exit 1
    fi
    SIP_PORT_NUM=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sipPort // empty" "$BASE_DIR/servers.json")
    SIP_TLS_PORT_NUM=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sipTlsPort // empty" "$BASE_DIR/servers.json")
else
    SUT=${SAS_SERVER:-$TARGET_SERVER}
fi
SIP_PORT_NUM=${SIP_PORT_NUM:-${SIP_PORT:-5060}}
SIP_TLS_PORT_NUM=${SIP_TLS_PORT_NUM:-${SIP_TLS_PORT:-5061}}

if [ "$TRANSPORT" == "l1" ]; then
    SIP_PORT_ADD_ON=":$SIP_TLS_PORT_NUM"
elif [ "$SIP_PORT_NUM" != "5060" ]; then
    SIP_PORT_ADD_ON=":$SIP_PORT_NUM"
else
    SIP_PORT_ADD_ON=""
fi

PRIVATEIP=$(ip a s | sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}' | head -1)
# Media IP selection mirrors inbound.sh (IP_USE_PUBLIC defaults to 1)
if [ "${IP_USE_PUBLIC:-1}" == "1" ]; then
    PUBLICIP=$(dig +short myip.opendns.com @resolver1.opendns.com -4 2>/dev/null)
    MEDIA_IP=${PUBLICIP:-$PRIVATEIP}
else
    MEDIA_IP=$PRIVATEIP
fi

# TLS options mirror register.sh
TLS_OPTIONS=""
if [ "$TRANSPORT" == "l1" ]; then
    TLS_CERT="$BASE_DIR/sipp/tls/sipp.crt"
    TLS_KEY="$BASE_DIR/sipp/tls/sipp.key"
    if [ ! -f "$TLS_CERT" ] || [ ! -f "$TLS_KEY" ]; then
        echo "ERROR: TLS transport requested but certs missing ($TLS_CERT)"
        echo "Run: $BASE_DIR/sipp/scripts/generate_tls_certs.sh"
        exit 1
    fi
    TLS_CA_PATH=""
    [ -f /etc/ssl/certs/ca-certificates.crt ] && TLS_CA_PATH="-tls_ca /etc/ssl/certs/ca-certificates.crt"
    [ -f /etc/pki/tls/certs/ca-bundle.crt ] && TLS_CA_PATH="-tls_ca /etc/pki/tls/certs/ca-bundle.crt"
    TLS_OPTIONS="-tls_cert $TLS_CERT -tls_key $TLS_KEY -tls_version 1.2 $TLS_CA_PATH"
fi

# ------------------------------------------------------------------- setup
TS=$(date +%Y%m%d_%H%M%S)
WORK_DIR="/tmp/manual_test_$TS"
mkdir -p "$WORK_DIR"
STATS_PATH="$BASE_DIR/sipp/stats"

# Work on a copy of the device CSV: never mutate the user's file (register.sh
# rewrites its input in place), and force SEQUENTIAL so every line registers
# deterministically (the cron path randomizes + applies REGISTRATION_PCT; for
# debugging we want exactly the devices you listed).
REG_CSV="$WORK_DIR/devices.csv"
sed 's/^RANDOM/SEQUENTIAL/' "$DEVICE_CSV" > "$REG_CSV"
NUM_DEVICES=$(grep -cv -e '^SEQUENTIAL' -e '^RANDOM' -e '^[[:space:]]*$' "$REG_CSV")

# Single-number CSV for the UAC, same shape as phonenumbers/<tz>.csv
NUM_CSV="$WORK_DIR/number.csv"
printf 'SEQUENTIAL\r\n%s;manual;manual-test\r\n' "$NUMBER" > "$NUM_CSV"

# Same UAS scenario preparation as register.sh (OPUS_PCT bucket regex)
_OPUS_REGEX=$(_opus_regex "${OPUS_PCT:-99}")
_UAS_SCENARIO=$(make_uas_scenario \
    "$BASE_DIR/sipp/scripts/sipp_uas_pcap_opus_g711a_fallback.xml" \
    "$_OPUS_REGEX" "${OPUS_PCT:-99}")

UA_VERSION=$(get_ua_version "$BASE_DIR")

# Two port sets from the shared allocator (same as the cron scripts)
allocate_ports 1 1 1 || exit 1
REG_SIP_PORT=$ALLOCATED_SIP_PORT; REG_MEDIA_PORT=$ALLOCATED_MEDIA_PORT; REG_CONTROL_PORT=$ALLOCATED_CONTROL_PORT
allocate_ports 1 1 1 || exit 1
UAC_SIP_PORT=$ALLOCATED_SIP_PORT; UAC_MEDIA_PORT=$ALLOCATED_MEDIA_PORT; UAC_CONTROL_PORT=$ALLOCATED_CONTROL_PORT

REG_STATS="$STATS_PATH/manual_register_${TRANSPORT}_$$.csv"
REG_PID=""

cleanup() {
    trap - EXIT INT TERM
    echo ""
    if [ -n "$REG_PID" ] && [ "$KEEP" == "1" ]; then
        echo "Leaving registration instance running (PID $REG_PID). Stop it with: kill $REG_PID"
    elif [ -n "$REG_PID" ]; then
        echo "Stopping registration instance (PID $REG_PID)"
        kill "$REG_PID" 2>/dev/null
    fi
    for p in $REG_SIP_PORT $REG_MEDIA_PORT $REG_CONTROL_PORT $UAC_SIP_PORT $UAC_MEDIA_PORT $UAC_CONTROL_PORT; do
        unlock_port "$p" 2>/dev/null
    done
    echo "Logs/CSVs kept in $WORK_DIR (sipp error/message logs in $BASE_DIR/sipp/scripts)"
    exit 0
}
trap cleanup EXIT INT TERM

# Relative pcap names in the scenarios resolve against the CWD (cron cd's here too)
cd "$BASE_DIR/sipp/scripts" || exit 1
ulimit -n 65536 2>/dev/null

echo "========================================================"
echo " Manual targeted test"
echo "   Target:      $SUT$SIP_PORT_ADD_ON ($TRANSPORT)"
echo "   Devices:     $NUM_DEVICES from $DEVICE_CSV"
echo "   Number:      $NUMBER  (x$CALL_COUNT per trigger)"
echo "   Local IP:    $PRIVATEIP   Media IP: $MEDIA_IP"
echo "   Opus pct:    ${OPUS_PCT:-99}% (regex: $_OPUS_REGEX)"
echo "   Reg ports:   sip=$REG_SIP_PORT media=$REG_MEDIA_PORT ctrl=$REG_CONTROL_PORT"
echo "   Call ports:  sip=$UAC_SIP_PORT media=$UAC_MEDIA_PORT ctrl=$UAC_CONTROL_PORT"
echo "   Work dir:    $WORK_DIR"
if [ "$CAPTURE" == "1" ]; then
    echo "   Tracing:     -trace_logs -trace_msg + tcpdump media capture per call"
else
    echo "   Tracing:     -trace_logs -trace_msg (media capture disabled)"
fi
echo "========================================================"

# ------------------------------------------- 1) registration (cron path)
# Mirrors register.sh's sipp invocation: same scenarios, keys and behavior
# flags; only -r/-m are pinned to register every listed device promptly.
SIPP_REG_CMD="sipp ${SUT}${SIP_PORT_ADD_ON} -key expires 60 -key ua_version $UA_VERSION \
-r 5 -m $NUM_DEVICES -l $NUM_DEVICES \
-t $TRANSPORT $TLS_OPTIONS -p $REG_SIP_PORT -cp $REG_CONTROL_PORT \
-sf $BASE_DIR/sipp/scripts/register.and.subscribe.sipp.xml \
-oocsf $_UAS_SCENARIO \
-inf $REG_CSV \
-inf $BASE_DIR/sipp/csv/random_user_agents.csv \
-recv_timeout 60000 \
-watchdog_interval 0 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
-aa -default_behaviors -abortunexp \
-mp $REG_MEDIA_PORT -i $PRIVATEIP -mi $PRIVATEIP \
-trace_stat -stf $REG_STATS -fd 5 -trace_err -trace_logs -trace_msg -bg"

echo ""
echo "[register] $SIPP_REG_CMD"
REG_OUTPUT=$($SIPP_REG_CMD 2>&1)
REG_PID=$(echo "$REG_OUTPUT" | grep -o 'PID=\[[0-9]*\]' | grep -o '[0-9]*')
if [ -z "$REG_PID" ]; then
    echo "ERROR: failed to start registration instance:"
    echo "$REG_OUTPUT"
    exit 1
fi
echo "[register] started (PID $REG_PID), waiting for $NUM_DEVICES registrations..."

# Wait until all devices show as active calls in the stats (each registered
# device is one long-lived 'call' in the re-REGISTER loop), or 60s.
WAITED=0
while [ "$WAITED" -lt 60 ]; do
    if [ -f "$REG_STATS" ]; then
        CURRENT=$(awk -F';' 'NR==1{for(i=1;i<=NF;i++) if($i=="CurrentCall") c=i} END{if(c) print $c}' "$REG_STATS")
        echo "  registered/active: ${CURRENT:-0}/$NUM_DEVICES (${WAITED}s)"
        if [ -n "$CURRENT" ] && [ "$CURRENT" -ge "$NUM_DEVICES" ] 2>/dev/null; then
            break
        fi
    fi
    sleep 3; WAITED=$((WAITED + 3))
done
[ "$WAITED" -ge 60 ] && echo "  (timed out waiting - continuing anyway, check $REG_STATS)"

# --------------------------------------------- 2) inbound call (cron path)
# Mirrors inbound.sh's sipp invocation; -r/-m pinned for single targeted calls.
place_call() {
    local ts=$(date +%s)
    local stats="$STATS_PATH/manual_inbound_${TRANSPORT}_$$_${ts}.csv"
    local cap="$WORK_DIR/media_${ts}.pcap"
    local tcpdump_pid=""
    echo ""
    echo "[call] placing $CALL_COUNT call(s) to $NUMBER via $SUT ..."

    # Per-packet timing: capture the UAC media port (RTP) + its RTCP companion.
    if [ "$CAPTURE" == "1" ] && command -v tcpdump >/dev/null; then
        tcpdump -i any -n -s 0 -w "$cap" \
            "udp and (port $UAC_MEDIA_PORT or port $((UAC_MEDIA_PORT + 1)))" \
            >/dev/null 2>&1 &
        tcpdump_pid=$!
        # Give tcpdump a moment to bind before the first RTP packet.
        sleep 0.3
        echo "[call] media capture -> $cap (pid $tcpdump_pid)"
    elif [ "$CAPTURE" == "1" ]; then
        echo "[call] (tcpdump not found - skipping media capture)"
    fi

    # -trace_logs writes the __PCAP__ play markers; -trace_msg the full SIP
    # exchange.  Both land in $BASE_DIR/sipp/scripts as
    # sipp_uac_pcap_g711a_<pid>_{logs,messages,errors}.log
    sipp ${SUT}${SIP_PORT_ADD_ON} -r 1 -m "$CALL_COUNT" -l "$CALL_COUNT" \
        -sf "$BASE_DIR/sipp/scripts/sipp_uac_pcap_g711a.xml" \
        -inf "$NUM_CSV" \
        -inf "$BASE_DIR/sipp/csv/random_caller_ids.csv" \
        -watchdog_interval 900000 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
        -t "$TRANSPORT" $TLS_OPTIONS \
        -i "$PRIVATEIP" -p "$UAC_SIP_PORT" -cp "$UAC_CONTROL_PORT" -mp "$UAC_MEDIA_PORT" \
        -recv_timeout 60000 \
        -key media_ip "$MEDIA_IP" \
        -key ua_version "$UA_VERSION" \
        -trace_stat -stf "$stats" -fd 5 -trace_err -trace_logs -trace_msg
    local rc=$?
    echo "[call] sipp exited with status $rc (stats: $stats)"

    if [ -n "$tcpdump_pid" ]; then
        # Let trailing RTP flush, then stop the capture.
        sleep 0.5
        kill "$tcpdump_pid" 2>/dev/null; wait "$tcpdump_pid" 2>/dev/null
        local npkts=$(tcpdump -r "$cap" 2>/dev/null | wc -l | tr -d ' ')
        echo "[call] captured $npkts media packets. Per-packet inter-arrival timing:"
        echo "       (cols: delta-from-prev  src > dst  len)"
        # -ttt prints delta from the previous packet; head keeps it readable.
        tcpdump -ttt -n -r "$cap" 2>/dev/null | head -40
        echo "       ... full capture: tcpdump -ttt -n -r $cap | less"
    fi

    # Surface where the SIPp __PCAP__ play markers landed for this run.
    local logf=$(ls -t "$BASE_DIR/sipp/scripts/"sipp_uac_pcap_g711a_*_logs.log 2>/dev/null | head -1)
    if [ -n "$logf" ]; then
        echo "[call] pcap-play markers (clock_tick ms) from $logf:"
        grep -h '__PCAP__' "$logf" 2>/dev/null | tail -20 | sed 's/^/       /'
    fi
}

if [ -n "$AUTO_WAIT" ]; then
    echo "Waiting ${AUTO_WAIT}s before placing the first call..."
    sleep "$AUTO_WAIT"
    place_call
fi

while true; do
    echo ""
    read -r -p "Press Enter to place a call to $NUMBER (q to quit): " ANSWER
    [ "$ANSWER" == "q" ] && break
    place_call
done
