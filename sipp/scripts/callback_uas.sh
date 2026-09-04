#!/bin/bash
# Launch the answer-then-callback UAS listener (sipp_uas_answer_then_callback.xml).
#
# One long-lived SIPp instance bound to a FIXED SIP port (default 5050) that
# answers inbound calls, plays audio, follows re-INVITEs, waits for the BYE,
# then 65 seconds later calls the originating number back.
#
# The instance is capped at MAX_RUNTIME seconds (default 6 hours) with SIPp's
# global -timeout, so it exits on its own and is restarted by
# callback_uas_monitor.sh (cron, every minute).
#
# Usage:
#   ./callback_uas.sh [--server <id>] [--port N] [--media-port N]
#                     [--control-port N] [--transport u1|t1|l1]
#                     [--runtime SECONDS] [--force]
#
#   --server <id>     Stats-file label only. The callback destination is taken
#                     from the inbound INVITE, so a single instance serves all
#                     servers; use this only if you run one listener per server
#                     (on different --port values) and want the stats split.
#   --port            Local SIP listen port (default 5050)
#   --media-port      RTP base port (default 60002 - deliberately above the
#                     24001-60000 range managed by port-allocator.sh so this
#                     fixed-port instance can never collide with the pooled
#                     register/inbound instances)
#   --control-port    SIPp control port for the graceful 'q' (default 5051)
#   --transport       u1 (UDP, default) | t1 (TCP) | l1 (TLS)
#   --runtime         Max runtime in seconds (default 21600 = 6h)
#   --force           Kill an instance already recorded in the state file
#                     instead of refusing to start a second one
#
# State (PID + start epoch, read by the monitor) is written to
#   /tmp/sipp-callback-uas/callback_uas_<port>.state

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source "$BASE_DIR/.env"

SERVER_ID=""
PORT=5050
MEDIA_PORT=60002
CONTROL_PORT=5051
TRANSPORT="u1"
MAX_RUNTIME=21600
FORCE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --server)       SERVER_ID="$2"; shift 2 ;;
        --port)         PORT="$2"; shift 2 ;;
        --media-port)   MEDIA_PORT="$2"; shift 2 ;;
        --control-port) CONTROL_PORT="$2"; shift 2 ;;
        --transport|-t) TRANSPORT="$2"; shift 2 ;;
        --runtime)      MAX_RUNTIME="$2"; shift 2 ;;
        --force)        FORCE=1; shift ;;
        -h|--help)      grep '^#' "$0" | head -30; exit 0 ;;
        *) echo "Unknown option: $1 (try -h)"; exit 1 ;;
    esac
done

STATE_DIR="/tmp/sipp-callback-uas"
STATE_FILE="$STATE_DIR/callback_uas_${PORT}.state"
mkdir -p "$STATE_DIR"

if ! command -v sipp >/dev/null 2>&1; then
    echo "ERROR: sipp not found in PATH"
    logger -t sipp-callback -p user.err "sipp not found in PATH; cannot start callback UAS on port $PORT"
    exit 1
fi

# Refuse to start a second instance on the same port (the monitor relies on
# this being idempotent).  --force stops the recorded one first.
if [ -f "$STATE_FILE" ]; then
    OLD_PID=$(awk -F= '/^pid=/{print $2}' "$STATE_FILE")
    if [ -n "$OLD_PID" ] && ps -p "$OLD_PID" >/dev/null 2>&1; then
        if [ "$FORCE" -eq 0 ]; then
            echo "Already running: pid=$OLD_PID port=$PORT (use --force to replace)"
            exit 0
        fi
        echo "--force: stopping existing instance pid=$OLD_PID"
        echo "q" | nc -w 1 localhost "$CONTROL_PORT" >/dev/null 2>&1 || true
        sleep 3
        ps -p "$OLD_PID" >/dev/null 2>&1 && kill -TERM "$OLD_PID" 2>/dev/null
        sleep 2
        ps -p "$OLD_PID" >/dev/null 2>&1 && kill -9 "$OLD_PID" 2>/dev/null
    fi
    rm -f "$STATE_FILE"
fi

# Orphan cleanup: a previous instance whose state file was lost can still be
# holding the fixed SIP port, which would make every restart fail to bind.
# Only sipp processes running THIS scenario are eligible to be killed.
if command -v ss >/dev/null 2>&1; then
    ORPHANS=$( { ss -lunpH "sport = :$PORT"; ss -ltnpH "sport = :$PORT"; } 2>/dev/null \
        | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
    for OP in $ORPHANS; do
        if grep -qa 'sipp_uas_answer_then_callback.xml' "/proc/$OP/cmdline" 2>/dev/null; then
            echo "Killing orphaned callback UAS holding port $PORT: pid=$OP"
            logger -t sipp-callback -p user.warning "Killing orphaned callback UAS pid=$OP holding port $PORT"
            kill -TERM "$OP" 2>/dev/null; sleep 2
            ps -p "$OP" >/dev/null 2>&1 && kill -9 "$OP" 2>/dev/null
        fi
    done
fi

# No callback destination is configured here: the scenario addresses the
# callback to the host:port from the inbound INVITE's Contact, and SIPp sends it
# back on that call's peer association.  One instance therefore serves EVERY
# server that sends it a call - hence no remote host on the sipp command line
# and no servers.json lookup.  --server is only a stats-file label.
#
# UDP (u1) is the safe transport: the peer association survives the 65s gap
# between leg 1 and the callback.  On TCP/TLS the far end may close the
# connection after leg 1's BYE, leaving the callback INVITE with no socket.

PRIVATEIP=$(ip a s | sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}' | head -1)

# TLS certificates (only used when TRANSPORT=l1)
TLS_OPTIONS=""
if [ "$TRANSPORT" == "l1" ]; then
    TLS_CERT="$BASE_DIR/sipp/tls/sipp.crt"
    TLS_KEY="$BASE_DIR/sipp/tls/sipp.key"
    if [ ! -f "$TLS_CERT" ] || [ ! -f "$TLS_KEY" ]; then
        echo "ERROR: TLS transport requested but certificates not found ($TLS_CERT / $TLS_KEY)"
        echo "Run: $BASE_DIR/sipp/scripts/generate_tls_certs.sh"
        exit 1
    fi
    TLS_CA_PATH=""
    [ -f /etc/ssl/certs/ca-certificates.crt ] && TLS_CA_PATH="-tls_ca /etc/ssl/certs/ca-certificates.crt"
    [ -f /etc/pki/tls/certs/ca-bundle.crt ] && TLS_CA_PATH="-tls_ca /etc/pki/tls/certs/ca-bundle.crt"
    TLS_OPTIONS="-tls_cert $TLS_CERT -tls_key $TLS_KEY -tls_version 1.2 $TLS_CA_PATH"
fi

source "$BASE_DIR/sipp/scripts/version-utils.sh"
UA_VERSION=$(get_ua_version "$BASE_DIR")

STATS_PATH="$BASE_DIR/sipp/stats"
mkdir -p "$STATS_PATH"
if [ -n "$SERVER_ID" ]; then
    STATS_FILE="${STATS_PATH}/${SERVER_ID}_callback_${TRANSPORT}_${PORT}_$$.csv"
else
    STATS_FILE="${STATS_PATH}/callback_${TRANSPORT}_${PORT}_$$.csv"
fi

ulimit -n 65536

# -timeout <n> is SIPp's GLOBAL run limit (not a per-call timer): the process
# exits after MAX_RUNTIME seconds, which is the 6h cap.  The monitor restarts
# it on the next minute and independently enforces the same cap in case SIPp
# ever fails to honour it.
SIPP_CMD="sipp \
-sf $BASE_DIR/sipp/scripts/sipp_uas_answer_then_callback.xml \
-key ua_version $UA_VERSION \
-t $TRANSPORT $TLS_OPTIONS -p $PORT -cp $CONTROL_PORT -mp $MEDIA_PORT \
-i $PRIVATEIP -mi $PRIVATEIP \
-timeout ${MAX_RUNTIME}s \
-recv_timeout 60000 \
-watchdog_interval 0 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
-aa -default_behaviors -abortunexp \
-trace_stat -stf $STATS_FILE -fd 15 -bg"

echo "SIPP command: $SIPP_CMD"
SIPP_OUTPUT=$($SIPP_CMD 2>&1)
SIPP_EXIT=$?
SIPP_PID=$(echo "$SIPP_OUTPUT" | grep -oP 'Background mode - PID=\[\K[0-9]+(?=\])')

sleep 2
if [ -z "$SIPP_PID" ] || ! ps -p "$SIPP_PID" >/dev/null 2>&1; then
    echo "ERROR: callback UAS failed to start (exit=$SIPP_EXIT)"
    echo "$SIPP_OUTPUT"
    logger -t sipp-callback -p user.err "Callback UAS failed to start: port=$PORT transport=$TRANSPORT server=$SERVER_ID exit=$SIPP_EXIT"
    logger -t sipp-callback -p user.info "Command: $SIPP_CMD"
    exit 1
fi

{
    echo "pid=$SIPP_PID"
    echo "start=$(date +%s)"
    echo "max_runtime=$MAX_RUNTIME"
    echo "port=$PORT"
    echo "control_port=$CONTROL_PORT"
    echo "media_port=$MEDIA_PORT"
    echo "transport=$TRANSPORT"
    echo "server=$SERVER_ID"
    echo "stats=$STATS_FILE"
} > "$STATE_FILE"

echo "Callback UAS started: pid=$SIPP_PID port=$PORT transport=$TRANSPORT (callback target: source of each inbound call) max_runtime=${MAX_RUNTIME}s"
logger -t sipp-callback -p user.info "Callback UAS started: pid=$SIPP_PID port=$PORT media_port=$MEDIA_PORT control_port=$CONTROL_PORT transport=$TRANSPORT server=$SERVER_ID max_runtime=${MAX_RUNTIME}s stats=$STATS_FILE"
exit 0
