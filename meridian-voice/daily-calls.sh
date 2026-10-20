#!/bin/bash
# daily-calls.sh - place one Meridian Voice scripted call, then do the agents'
# wrap-up (dispositions and notes on the CDRs).
#
# Cron runs this at the top of every hour (cron/start_sipp). It reads the
# current hour in the lab's time zone (lab.json "timeZone", America/Phoenix)
# and runs the flow whose "hour" matches - 9am blind, 10am attended, ... 4pm
# upset - so it does not depend on the time zone the box's cron runs in. In
# other hours it exits quietly.
#
# Usage:
#   daily-calls.sh                       # cron: this hour's flow, if any
#   daily-calls.sh --flow hold           # run one flow now
#   daily-calls.sh --flow hold --server core2-phx.v46
#
# The server is --server, else MERIDIAN_VOICE_SERVER from .env. Each run
# logs to stdout (cron appends it to /var/log/meridian-voice.log) and syslog
# (tag meridian-voice).

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
LAB="$BASE_DIR/meridian-voice/lab.json"
source "$BASE_DIR/.env"

FLOW=""
SERVER="${MERIDIAN_VOICE_SERVER:-}"
while [ $# -gt 0 ]; do
    case "$1" in
        --flow)   FLOW="$2"; shift 2 ;;
        --server) SERVER="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 2 ;;
    esac
done

log() {
    echo "$(date '+%F %T') [meridian-voice] $*"
    logger -t meridian-voice -- "$*"
}

if ! command -v jq >/dev/null; then
    log "jq is required"; exit 1
fi
if [ -z "$FLOW" ]; then
    HOUR=$(TZ="$(jq -r '.timeZone' "$LAB")" date +%-H)
    FLOW=$(jq -r --argjson h "$HOUR" '.flows | to_entries[] | select(.value.hour == $h) | .key' "$LAB" | head -1)
    [ -n "$FLOW" ] || exit 0
fi
if [ "$(jq -r --arg f "$FLOW" '.flows[$f] // empty | length' "$LAB")" == "" ]; then
    log "unknown flow '$FLOW'"; exit 2
fi
if [ -z "$SERVER" ]; then
    log "no server: set MERIDIAN_VOICE_SERVER in .env or pass --server"; exit 2
fi

# One run at a time: the long call takes ~14 minutes, well inside the hour,
# but a manual run could overlap the cron one.
exec 9>/tmp/meridian-voice-daily.lock
if ! flock -n 9; then
    log "another run is in progress - skipping $FLOW"; exit 0
fi

TRANSPORT=$(jq -r '.transport // "t1"' "$LAB")
START=$(date +%s)
log "starting $FLOW on $SERVER ($TRANSPORT)"

cd "$BASE_DIR/sipp/scripts" || exit 1
./manual_test.sh --once --flow "$FLOW" -s "$SERVER" -t "$TRANSPORT" -w 5 --no-capture < /dev/null
RC=$?
log "$FLOW call finished (manual_test.sh exit $RC)"
if [ "$RC" -ne 0 ]; then
    # The call failed (SIPp status != 0, e.g. the DID returned an error): no
    # agent answered, so there is no CDR to disposition.
    log "$FLOW call failed - skipping the wrap-up (see the caller's errors/messages logs in sipp/scripts)"
    exit "$RC"
fi

cd "$BASE_DIR" || exit 1
node meridian-voice/disposition-calls.js --server "$SERVER" --flow "$FLOW" --since "$START"
log "$FLOW wrap-up finished (exit $?)"
