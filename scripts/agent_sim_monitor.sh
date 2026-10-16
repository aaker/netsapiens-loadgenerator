#!/bin/bash
# Keep-alive for the agent-sim daemon (node agent-sim.js run).
#
# Run every minute from cron (see cron/start_agentsim):
#   * * * * * root /usr/local/NetSapiens/netsapiens-loadgenerator/scripts/agent_sim_monitor.sh
#
# Starts the daemon when it is not running, and restarts it when its heartbeat
# file (state/agent-sim/heartbeat, rewritten every tick) is older than
# STALE_AFTER seconds. The daemon persists per-agent state, so a restart picks
# up mid-day without logging everyone out and back in. Output goes to syslog
# under the agent-sim tag.
#
# Usage: agent_sim_monitor.sh [start|stop|restart|status] [extra run args...]
#   Extra args are passed to `agent-sim.js run` (e.g. --server core2-phx).

BASE_DIR="${AGENT_SIM_BASE_DIR:-/usr/local/NetSapiens/netsapiens-loadgenerator}"
RUN_DIR="$BASE_DIR/state/agent-sim"
PID_FILE="$RUN_DIR/agent-sim.pid"
HEARTBEAT="$RUN_DIR/heartbeat"
LOCK_FILE="$RUN_DIR/monitor.lock"
STALE_AFTER=${AGENT_SIM_STALE_AFTER:-180}
NODE=${NODE:-$(command -v node || echo /usr/bin/node)}

ACTION="${1:-check}"
case "$ACTION" in
    start|stop|restart|status|check) shift ;;
    *) ACTION="check" ;;
esac
RUN_ARGS=("$@")

mkdir -p "$RUN_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "Another monitor run is in progress; skipping"
    exit 0
fi

running_pid() {
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$pid" ] && ps -p "$pid" -o args= 2>/dev/null | grep -q "agent-sim.js run"; then
        echo "$pid"
    fi
}

start_daemon() {
    local why="$1"
    logger -t agent-sim -p user.warning "Starting agent-sim: $why"
    echo "$(date) - starting agent-sim: $why"
    cd "$BASE_DIR" || exit 1
    # Daemon stdout/stderr -> syslog (agent-sim tag)
    nohup setsid bash -c "\"$NODE\" agent-sim.js run ${RUN_ARGS[*]} 2>&1 | logger -t agent-sim -p user.info" >/dev/null 2>&1 &
    sleep 3
    local pid
    pid=$(running_pid)
    if [ -n "$pid" ]; then
        echo "agent-sim started (pid $pid)"
    else
        logger -t agent-sim -p user.err "agent-sim failed to start; run 'node agent-sim.js run' in $BASE_DIR to see why"
        echo "agent-sim failed to start"
        return 1
    fi
}

stop_daemon() {
    local pid="$1"
    [ -z "$pid" ] && return 0
    kill -TERM "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        ps -p "$pid" >/dev/null 2>&1 || return 0
        sleep 1
    done
    kill -9 "$pid" 2>/dev/null
}

PID=$(running_pid)
case "$ACTION" in
    stop)
        stop_daemon "$PID"
        logger -t agent-sim -p user.info "agent-sim stopped (pid ${PID:-none})"
        echo "stopped"
        exit 0
        ;;
    restart)
        stop_daemon "$PID"
        start_daemon "manual restart"
        exit $?
        ;;
    status)
        if [ -n "$PID" ]; then
            AGE=$(( $(date +%s) - $(cat "$HEARTBEAT" 2>/dev/null || echo 0) ))
            echo "agent-sim running (pid $PID, heartbeat ${AGE}s ago)"
            exit 0
        fi
        echo "agent-sim not running"
        exit 1
        ;;
esac

# start / check
if [ -z "$PID" ]; then
    start_daemon "not running"
    exit $?
fi
AGE=$(( $(date +%s) - $(cat "$HEARTBEAT" 2>/dev/null || echo 0) ))
if [ "$AGE" -ge "$STALE_AFTER" ]; then
    logger -t agent-sim -p user.warning "agent-sim pid=$PID heartbeat stale (${AGE}s); restarting"
    stop_daemon "$PID"
    start_daemon "heartbeat stale for ${AGE}s"
    exit $?
fi
echo "agent-sim healthy (pid $PID, heartbeat ${AGE}s ago)"
