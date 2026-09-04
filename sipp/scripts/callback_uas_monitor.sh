#!/bin/bash
# Keep-alive for the answer-then-callback UAS (callback_uas.sh).
#
# Run every minute from cron:
#   * * * * * root /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/callback_uas_monitor.sh --server prod1
#
# Each run it checks the instance recorded in
#   /tmp/sipp-callback-uas/callback_uas_<port>.state
# and starts (or restarts) it when any of these is true:
#   - no state file / recorded PID is gone   -> the 6h -timeout expired, or it crashed
#   - runtime >= max_runtime + 300s grace    -> SIPp ignored its own global timeout
#   - the stats file has not been written for STALE_AFTER seconds -> wedged
#   - the SIP port is not bound (checked only when `ss` is available)
#
# Restarts are graceful first: 'q' on the control port, then SIGTERM, then
# SIGKILL. Every action is logged to syslog under the sipp-callback tag.
#
# Usage: callback_uas_monitor.sh [same options as callback_uas.sh]
#   All options are forwarded verbatim to callback_uas.sh, so the monitor and
#   the launcher must be given the SAME --port (default 5050) to agree on the
#   state file.

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
LAUNCHER="$BASE_DIR/sipp/scripts/callback_uas.sh"

# Restart if the SIPp stats file has gone quiet for this long (it is rewritten
# every 15s by -fd 15, so 3 minutes of silence means the process is wedged).
STALE_AFTER=${CALLBACK_STALE_AFTER:-180}
# Extra time allowed past max_runtime before we force the restart ourselves.
RUNTIME_GRACE=${CALLBACK_RUNTIME_GRACE:-300}

# Parse only what the monitor itself needs; everything is forwarded as-is.
ARGS=("$@")
PORT=5050
CONTROL_PORT=5051
TRANSPORT="u1"
i=0
while [ $i -lt ${#ARGS[@]} ]; do
    case "${ARGS[$i]}" in
        --port)         PORT="${ARGS[$((i+1))]}" ;;
        --control-port) CONTROL_PORT="${ARGS[$((i+1))]}" ;;
        --transport|-t) TRANSPORT="${ARGS[$((i+1))]}" ;;
    esac
    i=$((i+1))
done

STATE_DIR="/tmp/sipp-callback-uas"
STATE_FILE="$STATE_DIR/callback_uas_${PORT}.state"
LOCK_FILE="$STATE_DIR/callback_uas_${PORT}.lock"
mkdir -p "$STATE_DIR"

# Serialise concurrent cron runs (a restart takes several seconds).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "Another monitor run is in progress for port $PORT; skipping"
    exit 0
fi

state_get() { awk -F= -v k="$1" '$1==k{print $2}' "$STATE_FILE" 2>/dev/null; }

start_instance() {
    local why="$1"
    logger -t sipp-callback -p user.warning "Restarting callback UAS on port $PORT: $why"
    echo "$(date) - starting callback UAS on port $PORT: $why"
    "$LAUNCHER" "${ARGS[@]}" --force
}

stop_instance() {
    local pid="$1"
    [ -z "$pid" ] && return 0
    ps -p "$pid" >/dev/null 2>&1 || return 0
    echo "q" | nc -w 1 localhost "$CONTROL_PORT" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5; do
        ps -p "$pid" >/dev/null 2>&1 || return 0
        sleep 1
    done
    kill -TERM "$pid" 2>/dev/null
    for _ in 1 2 3; do
        ps -p "$pid" >/dev/null 2>&1 || return 0
        sleep 1
    done
    kill -9 "$pid" 2>/dev/null
}

# ------------------------------------------------------------------ checks
if [ ! -f "$STATE_FILE" ]; then
    start_instance "no state file (never started, or state was cleared)"
    exit $?
fi

PID=$(state_get pid)
START=$(state_get start)
MAX_RUNTIME=$(state_get max_runtime)
STATS_FILE=$(state_get stats)
NOW=$(date +%s)

if [ -z "$PID" ] || ! ps -p "$PID" >/dev/null 2>&1; then
    start_instance "pid=${PID:-none} not running (6h timeout reached, or it crashed)"
    exit $?
fi

# Hard runtime cap, in case SIPp's own global -timeout did not fire.
if [ -n "$START" ] && [ -n "$MAX_RUNTIME" ]; then
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge $((MAX_RUNTIME + RUNTIME_GRACE)) ]; then
        logger -t sipp-callback -p user.warning "Callback UAS pid=$PID exceeded max runtime (${ELAPSED}s >= ${MAX_RUNTIME}s + ${RUNTIME_GRACE}s grace); forcing restart"
        stop_instance "$PID"
        start_instance "runtime ${ELAPSED}s past the ${MAX_RUNTIME}s cap"
        exit $?
    fi
fi

# Wedged-process check: the stats file must keep being rewritten.
if [ -n "$STATS_FILE" ] && [ -f "$STATS_FILE" ]; then
    STATS_AGE=$((NOW - $(stat -c %Y "$STATS_FILE" 2>/dev/null || echo "$NOW")))
    if [ "$STATS_AGE" -ge "$STALE_AFTER" ]; then
        logger -t sipp-callback -p user.warning "Callback UAS pid=$PID stats file stale (${STATS_AGE}s); forcing restart"
        stop_instance "$PID"
        start_instance "stats file stale for ${STATS_AGE}s"
        exit $?
    fi
fi

# Port-binding check (best effort - only when iproute2's ss is present).
if command -v ss >/dev/null 2>&1; then
    case "$TRANSPORT" in
        u1|un) BOUND=$(ss -lunH "sport = :$PORT" 2>/dev/null | wc -l) ;;
        *)     BOUND=$(ss -ltnH "sport = :$PORT" 2>/dev/null | wc -l) ;;
    esac
    if [ "${BOUND:-0}" -eq 0 ]; then
        logger -t sipp-callback -p user.warning "Callback UAS pid=$PID is running but port $PORT is not bound; forcing restart"
        stop_instance "$PID"
        start_instance "SIP port $PORT not bound"
        exit $?
    fi
fi

ELAPSED_MIN=$(( (NOW - ${START:-$NOW}) / 60 ))
echo "Callback UAS healthy: pid=$PID port=$PORT elapsed=${ELAPSED_MIN}min"
exit 0
