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
#   --talk <min>,<max>    Caller talk time per leg in seconds (default 5,80,
#                         same as cron). The agent transfers a call it is
#                         still on 90s after answering, and the caller then
#                         waits 30s more for the transfer, so 70,80 makes
#                         every call reach the transfer. Keep max under ~82
#                         or the transfer lands mid-pause and SIPp BYEs it.
#   --full-call           Play the whole scripted call once: leg 1 to the
#                         90s transfer (--talk defaults to 70,80), then the
#                         transferred leg plays all of orig2/term2 (195s)
#                         and the caller hangs up, instead of the agent
#                         transferring again at 90s. ~5 min per call.
#   --flow <name>         Call flow: blind (default; the cron scenarios, a
#                         blind REFER to the next queue at 90s) or attended
#                         (supervised transfer: agent A holds the caller,
#                         calls agent B, talks, then REFERs with Replaces;
#                         ~2.5 min). attended registers each device in its
#                         own SIPp process and ignores --talk/--full-call.
#   --consult <ext>       attended: agent B's extension (default: the first
#                         device in the CSV, or the next one when agent A is
#                         that device)
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
#   ./manual_test.sh -s prod1 --talk 70,80             # always reach the transfer
#   ./manual_test.sh -s prod1 --full-call              # whole conversation, one transfer
#   ./manual_test.sh -s prod1 --flow attended          # supervised transfer
#
# After the call completes you are prompted again - press Enter to place
# another call (new sipp instance, same paths), or q to quit. On exit the
# registration instances are stopped (unless -k) and ports are released.
#
# REG_LOOPS=1 ./manual_test.sh makes every registered device exit its
# re-register loop after one iteration (~45s) instead of running the full hour.

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
TALK=""
FULL_CALL=0
FLOW="blind"
CONSULT=""

while [ $# -gt 0 ]; do
    case "$1" in
        -f|--file)      DEVICE_CSV="$2"; shift 2 ;;
        -n|--number)    NUMBER="$2"; shift 2 ;;
        -t|--transport) TRANSPORT="$2"; shift 2 ;;
        -s|--server)    SERVER_ID="$2"; shift 2 ;;
        -c|--count)     CALL_COUNT="$2"; shift 2 ;;
        -w|--wait)      AUTO_WAIT="$2"; shift 2 ;;
        --talk)         TALK="$2"; shift 2 ;;
        --full-call)    FULL_CALL=1; shift ;;
        --flow)         FLOW="$2"; shift 2 ;;
        --consult)      CONSULT="$2"; shift 2 ;;
        -k|--keep)      KEEP=1; shift ;;
        --no-capture)   CAPTURE=0; shift ;;
        -h|--help)      grep '^#' "$0" | head -58; exit 0 ;;
        *) echo "Unknown option: $1 (try -h)"; exit 1 ;;
    esac
done

case "$FLOW" in
    blind) ;;
    attended)
        if [ -n "$TALK" ] || [ "$FULL_CALL" == "1" ]; then
            echo "ERROR: --talk/--full-call apply to the blind flow only"; exit 1
        fi ;;
    *) echo "ERROR: --flow must be blind or attended (got '$FLOW')"; exit 1 ;;
esac

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
    # Per-server opusPct overrides OPUS_PCT from .env
    SERVER_OPUS_PCT=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .opusPct // empty" "$BASE_DIR/servers.json")
    if [ -n "$SERVER_OPUS_PCT" ]; then
        OPUS_PCT="$SERVER_OPUS_PCT"
    fi
else
    SUT=${SAS_SERVER:-$TARGET_SERVER}
fi
SIP_PORT_NUM=${SIP_PORT_NUM:-${SIP_PORT:-5060}}
SIP_TLS_PORT_NUM=${SIP_TLS_PORT_NUM:-${SIP_TLS_PORT:-5061}}

# Force the SIP destination onto IPv4 (SIPp binds an IPv4 local socket)
source "$BASE_DIR/sipp/scripts/net-utils.sh"
SUT=$(resolve_ipv4 "$SUT")

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
cp "$DEVICE_CSV" "$REG_CSV"
# Normalize to the 5-column layout, keeping SEQUENTIAL ordering.
source "$BASE_DIR/sipp/scripts/csv-utils.sh"
normalize_device_csv "$REG_CSV" SEQUENTIAL
NUM_DEVICES=$(grep -cv -e '^SEQUENTIAL' -e '^RANDOM' -e '^[[:space:]]*$' "$REG_CSV")

# Single-number CSV for the UAC, same shape as phonenumbers/<tz>.csv
NUM_CSV="$WORK_DIR/number.csv"
printf 'SEQUENTIAL\r\n%s;manual;manual-test\r\n' "$NUMBER" > "$NUM_CSV"

# Same UAS scenario preparation as register.sh (OPUS_PCT bucket regex)
_OPUS_REGEX=$(_opus_regex "${OPUS_PCT:-50}")
_UAS_SCENARIO=$(make_uas_scenario \
    "$BASE_DIR/sipp/scripts/sipp_uas_pcap_opus_g711a_fallback.xml" \
    "$_OPUS_REGEX" "${OPUS_PCT:-50}")

UA_VERSION=$(get_ua_version "$BASE_DIR")

# UAC scenario: the original, or a copy with the talk-time pause from --talk
# (same substitution as domain_inbound.sh). The copy sits next to the
# original because the pcap paths in it are relative.
UAC_SCENARIO="$BASE_DIR/sipp/scripts/sipp_uac_pcap_g711a.xml"
[ "$FULL_CALL" == "1" ] && TALK=${TALK:-70,80}
if [ -n "$TALK" ]; then
    TALK_MIN_MS=$(awk -F, '{printf "%d", $1*1000}' <<< "$TALK")
    TALK_MAX_MS=$(awk -F, '{printf "%d", $2*1000}' <<< "$TALK")
    if ! [ "$TALK_MAX_MS" -gt "$TALK_MIN_MS" ] 2>/dev/null; then
        echo "ERROR: --talk needs <min>,<max> seconds with max > min (got '$TALK')"
        exit 1
    fi
    UAC_SCENARIO="$BASE_DIR/sipp/scripts/.manual_uac_$$.xml"
    sed -e "s#<pause distribution=\"uniform\" min=\"5000\" max=\"80000\"/>#<pause distribution=\"uniform\" min=\"$TALK_MIN_MS\" max=\"$TALK_MAX_MS\"/>#" \
        "$BASE_DIR/sipp/scripts/sipp_uac_pcap_g711a.xml" > "$UAC_SCENARIO"
    if ! grep -q "min=\"$TALK_MIN_MS\" max=\"$TALK_MAX_MS\"" "$UAC_SCENARIO"; then
        echo "ERROR: talk-time pause not found in sipp_uac_pcap_g711a.xml"
        rm -f "$UAC_SCENARIO"
        exit 1
    fi
fi

# --full-call: the caller's post-transfer leg talks 188s (+8s settle = the
# 195s orig2), and a copy of the UAS sends a transferred leg to wait_bye_full
# instead of transferring again. The copy is ours alone - make_uas_scenario's
# /tmp file is shared with the cron registrations on this host.
if [ "$FULL_CALL" == "1" ]; then
    sed -i -e 's#<pause [^>]*/> <!-- leg2_talk -->#<pause milliseconds="188000"/> <!-- leg2_talk -->#' "$UAC_SCENARIO"
    sed -e 's#<nop next="wait_bye_90"/>#<nop test="is_transfer" next="wait_bye_full"/>#' \
        "$_UAS_SCENARIO" > "$WORK_DIR/uas_full_call.xml"
    if ! grep -q 'milliseconds="188000"/> <!-- leg2_talk -->' "$UAC_SCENARIO" \
        || ! grep -q 'next="wait_bye_full"/>' "$WORK_DIR/uas_full_call.xml"; then
        echo "ERROR: --full-call hooks not found in the UAC/UAS scenarios"
        rm -f "$UAC_SCENARIO"
        exit 1
    fi
    _UAS_SCENARIO="$WORK_DIR/uas_full_call.xml"
fi

# --flow attended: dedicated caller/agent scenarios. Each device registers in
# its own SIPp process with its own copy of the agent scenario, filled in with
# that device's name, extension, domain and credentials (an -oocsf scenario
# cannot read SIPp input files). Separate processes also mean a consult leg
# the platform delivers to agent B can never be matched to agent A's call.
if [ "$FLOW" == "attended" ]; then
    UAC_SCENARIO="$BASE_DIR/sipp/scripts/sipp_uac_attended.xml"
    DEV_EXTS=($(awk -F';' 'NR > 1 && NF >= 4 { print $2 }' "$REG_CSV"))
    if [ "${#DEV_EXTS[@]}" -lt 2 ]; then
        echo "ERROR: --flow attended needs at least 2 devices (agent A and agent B)"; exit 1
    fi
    CONSULT=${CONSULT:-${DEV_EXTS[0]}}
    CONSULT_ALT=""
    for ext in "${DEV_EXTS[@]}"; do
        [ "$ext" != "$CONSULT" ] && { CONSULT_ALT="$ext"; break; }
    done
    REG_KEYS="-key consult_target $CONSULT -key consult_target_alt $CONSULT_ALT"
fi

# Port sets from the shared allocator (same as the cron scripts): one per
# registration process (one in total, or one per device for attended), plus
# one for the UAC. REG_SETS entries are "csv:sip:media:ctrl:stats:uas".
REG_SETS=()
ALL_PORTS=""
if [ "$FLOW" == "attended" ]; then
    for ext in "${DEV_EXTS[@]}"; do
        dev_csv="$WORK_DIR/device_$ext.csv"
        { printf 'SEQUENTIAL\r\n'; awk -F';' -v e="$ext" 'NR > 1 && $2 == e' "$REG_CSV"; } > "$dev_csv"
        # Literal (not regex) substitution via ENVIRON, so any character in a
        # display name or password is copied as-is.
        dev_uas="$WORK_DIR/uas_attended_$ext.xml"
        IFS=';' read -r AGENT_NAME AGENT_EXT AGENT_DOMAIN AGENT_AUTH _ua < <(sed -n '2p' "$dev_csv" | tr -d '\r')
        AGENT_NAME="$AGENT_NAME" AGENT_EXT="$AGENT_EXT" AGENT_DOMAIN="$AGENT_DOMAIN" AGENT_AUTH="$AGENT_AUTH" awk '
            function rep(s, from, to,    i, out) {
                out = ""
                while ((i = index(s, from)) > 0) { out = out substr(s, 1, i - 1) to; s = substr(s, i + length(from)) }
                return out s
            }
            {
                $0 = rep($0, "__AGENT_NAME__", ENVIRON["AGENT_NAME"])
                $0 = rep($0, "__AGENT_EXT__", ENVIRON["AGENT_EXT"])
                $0 = rep($0, "__AGENT_DOMAIN__", ENVIRON["AGENT_DOMAIN"])
                $0 = rep($0, "__AGENT_AUTH__", ENVIRON["AGENT_AUTH"])
                print
            }' "$BASE_DIR/sipp/scripts/sipp_uas_attended.xml" > "$dev_uas"
        allocate_ports 1 1 1 || exit 1
        REG_SETS+=("$dev_csv:$ALLOCATED_SIP_PORT:$ALLOCATED_MEDIA_PORT:$ALLOCATED_CONTROL_PORT:$STATS_PATH/manual_register_${TRANSPORT}_$$_$ext.csv:$dev_uas")
        ALL_PORTS="$ALL_PORTS $ALLOCATED_SIP_PORT $ALLOCATED_MEDIA_PORT $ALLOCATED_CONTROL_PORT"
    done
else
    allocate_ports 1 1 1 || exit 1
    REG_SETS+=("$REG_CSV:$ALLOCATED_SIP_PORT:$ALLOCATED_MEDIA_PORT:$ALLOCATED_CONTROL_PORT:$STATS_PATH/manual_register_${TRANSPORT}_$$.csv:$_UAS_SCENARIO")
    ALL_PORTS="$ALLOCATED_SIP_PORT $ALLOCATED_MEDIA_PORT $ALLOCATED_CONTROL_PORT"
fi
allocate_ports 1 1 1 || exit 1
UAC_SIP_PORT=$ALLOCATED_SIP_PORT; UAC_MEDIA_PORT=$ALLOCATED_MEDIA_PORT; UAC_CONTROL_PORT=$ALLOCATED_CONTROL_PORT
ALL_PORTS="$ALL_PORTS $UAC_SIP_PORT $UAC_MEDIA_PORT $UAC_CONTROL_PORT"

REG_PIDS=()

cleanup() {
    trap - EXIT INT TERM
    echo ""
    if [ "${#REG_PIDS[@]}" -gt 0 ] && [ "$KEEP" == "1" ]; then
        echo "Leaving registration instance(s) running (PID ${REG_PIDS[*]}). Stop with: kill ${REG_PIDS[*]}"
    elif [ "${#REG_PIDS[@]}" -gt 0 ]; then
        echo "Stopping registration instance(s) (PID ${REG_PIDS[*]})"
        kill "${REG_PIDS[@]}" 2>/dev/null
    fi
    [ -n "$TALK" ] && rm -f "$UAC_SCENARIO"
    for p in $ALL_PORTS; do
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
if [ "$FLOW" == "attended" ]; then
    echo "   Flow:        attended - agent B is $CONSULT (or $CONSULT_ALT when A is $CONSULT)"
elif [ "$FULL_CALL" == "1" ]; then
    echo "   Talk time:   full call - ${TALK}s to the 90s transfer, then 195s post-transfer"
else
    echo "   Talk time:   ${TALK:-5,80}s per leg (transfer at ~90s after answer)"
fi
echo "   Opus pct:    ${OPUS_PCT:-50}% (regex: $_OPUS_REGEX)"
for set in "${REG_SETS[@]}"; do
    IFS=: read -r _csv _sip _media _ctrl _stats _uas <<< "$set"
    echo "   Reg ports:   sip=$_sip media=$_media ctrl=$_ctrl ($(basename "$_csv"))"
done
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
# start_registration <csv> <sip-port> <media-port> <ctrl-port> <stats-file> <uas-scenario>
start_registration() {
    local csv="$1" sip="$2" media="$3" ctrl="$4" stats="$5" uas="$6"
    local n=$(grep -cv -e '^SEQUENTIAL' -e '^RANDOM' -e '^[[:space:]]*$' "$csv")
    local cmd="sipp ${SUT}${SIP_PORT_ADD_ON} -key expires 60 -key ua_version $UA_VERSION -key reg_loops ${REG_LOOPS:-78} $REG_KEYS \
-r 5 -m $n -l $n \
-t $TRANSPORT $TLS_OPTIONS -p $sip -cp $ctrl \
-sf $BASE_DIR/sipp/scripts/register.and.subscribe.sipp.xml \
-oocsf $uas \
-inf $csv \
-inf $BASE_DIR/sipp/csv/random_user_agents.csv \
-recv_timeout 60000 \
-watchdog_interval 0 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
-aa -default_behaviors -abortunexp \
-mp $media -i $PRIVATEIP -mi $PRIVATEIP \
-trace_stat -stf $stats -fd 5 -trace_err -trace_logs -trace_msg -bg"

    echo ""
    echo "[register] $cmd"
    local out=$($cmd 2>&1)
    local pid=$(echo "$out" | grep -o 'PID=\[[0-9]*\]' | grep -o '[0-9]*')
    if [ -z "$pid" ]; then
        echo "ERROR: failed to start registration instance:"
        echo "$out"
        exit 1
    fi
    REG_PIDS+=("$pid")
    echo "[register] started (PID $pid, $n device(s))"
}

for set in "${REG_SETS[@]}"; do
    IFS=: read -r _csv _sip _media _ctrl _stats _uas <<< "$set"
    start_registration "$_csv" "$_sip" "$_media" "$_ctrl" "$_stats" "$_uas"
done
echo "[register] waiting for $NUM_DEVICES registrations..."

# Wait until all devices show as active calls in the stats (each registered
# device is one long-lived 'call' in the re-REGISTER loop), or 60s.
WAITED=0
while [ "$WAITED" -lt 60 ]; do
    CURRENT=0
    for set in "${REG_SETS[@]}"; do
        IFS=: read -r _csv _sip _media _ctrl _stats _uas <<< "$set"
        [ -f "$_stats" ] || continue
        c=$(awk -F';' 'NR==1{for(i=1;i<=NF;i++) if($i=="CurrentCall") c=i} END{if(c) print $c}' "$_stats")
        CURRENT=$((CURRENT + ${c:-0}))
    done
    echo "  registered/active: $CURRENT/$NUM_DEVICES (${WAITED}s)"
    [ "$CURRENT" -ge "$NUM_DEVICES" ] && break
    sleep 3; WAITED=$((WAITED + 3))
done
[ "$WAITED" -ge 60 ] && echo "  (timed out waiting - continuing anyway, check $STATS_PATH/manual_register_${TRANSPORT}_$$*.csv)"

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
        -sf "$UAC_SCENARIO" \
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
    # SIPp names its logs after the scenario file, which is a templated
    # copy (.manual_uac_<pid>.xml) when --talk/--full-call is used.
    local logf=$(ls -t "$BASE_DIR/sipp/scripts/$(basename "$UAC_SCENARIO" .xml)"_*_logs.log 2>/dev/null | head -1)
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
