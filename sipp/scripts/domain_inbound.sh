#!/bin/bash
# Per-domain inbound call boost for agent-sim (launched by agent-sim.js every
# 5 minutes for domains with callBoost.enabled; can also be run by hand).
#
# Usage:
#   domain_inbound.sh --server <id> --domain <domain> --csv <numbers.csv> --cps <peak>
#                     [--talk <min_s>,<max_s>] [--transport u1|t1|l1] [--tz-offset <hours>]
#
#   --csv        RANDOM-format CSV of the domain's queue DIDs (phonenumber;domain;desc).
#                agent-sim builds it from the API, repeating rows by queue weight.
#   --cps        Peak extra calls per second for this domain. Scaled by the
#                business-day curve (cps_multiplier in cps-utils.sh); unlike
#                inbound.sh it is NOT divided by 7, it is all for this domain.
#   --talk       Per-leg caller talk time range in seconds (default 5,80). Keep
#                the max under 90: the agent-side UAS transfers the call after 90s.
#   --tz-offset  Domain UTC offset in hours for the curve (default CPS_TZ_OFFSET or -7).
#
# Runs one ~275s SIPp batch with the same UAC scenario, port allocation, IPv4
# resolution and stats naming as inbound.sh, so metrics-server picks it up as
# <server>_domainboost_<transport>_<domain>_<pid>.csv.

BASE_DIR="/usr/local/NetSapiens/netsapiens-loadgenerator"
source $BASE_DIR/.env

SERVER_ID=""
DOMAIN=""
INPUTFILE=""
BOOST_CPS=""
TALK="5,80"
TRANSPORT="u1"
TZ_OFFSET="${CPS_TZ_OFFSET:--7}"

while [ $# -gt 0 ]; do
    case "$1" in
        --server)    SERVER_ID="$2"; shift ;;
        --domain)    DOMAIN="$2"; shift ;;
        --csv)       INPUTFILE="$2"; shift ;;
        --cps)       BOOST_CPS="$2"; shift ;;
        --talk)      TALK="$2"; shift ;;
        --transport) TRANSPORT="$2"; shift ;;
        --tz-offset) TZ_OFFSET="$2"; shift ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
    shift
done

if [ -z "$DOMAIN" ] || [ -z "$INPUTFILE" ] || [ -z "$BOOST_CPS" ]; then
    echo "Usage: domain_inbound.sh --server <id> --domain <domain> --csv <numbers.csv> --cps <peak> [--talk min,max] [--transport u1|t1|l1] [--tz-offset h]"
    exit 1
fi
if [ ! -f "$INPUTFILE" ]; then
    echo "Error: $INPUTFILE does not exist"
    exit 1
fi

TALK_MIN_MS=$(awk -F, '{printf "%d", $1*1000}' <<< "$TALK")
TALK_MAX_MS=$(awk -F, '{printf "%d", $2*1000}' <<< "$TALK")
if [ "$TALK_MAX_MS" -le "$TALK_MIN_MS" ] 2>/dev/null; then
    echo "Error: --talk max must be greater than min ($TALK)"
    exit 1
fi

# Random 0-15s stagger, like inbound.sh
RANDOM=$$
sleep $(( RANDOM % 16 ))

source "$BASE_DIR/sipp/scripts/port-allocator.sh"

# Destination: sasHostname, else hostname (legacy: SAS_SERVER, else TARGET_SERVER)
SIP_PORT_NUM=""
SIP_TLS_PORT_NUM=""
SEND_RTP_FINAL=${SEND_RTP:-1}
if [ -n "$SERVER_ID" ] && [ "$SERVER_ID" != "default" ] && [ -f "$BASE_DIR/servers.json" ]; then
    SUT=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sasHostname // .hostname // empty" "$BASE_DIR/servers.json")
    if [ -z "$SUT" ]; then
        echo "Error: Server '$SERVER_ID' not found in servers.json"
        exit 1
    fi
    SIP_PORT_NUM=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sipPort // empty" "$BASE_DIR/servers.json")
    SIP_TLS_PORT_NUM=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sipTlsPort // empty" "$BASE_DIR/servers.json")
    SERVER_SEND_RTP=$(jq -r ".servers[] | select(.id==\"$SERVER_ID\") | .sendRtp // empty" "$BASE_DIR/servers.json")
    [ -n "$SERVER_SEND_RTP" ] && SEND_RTP_FINAL=$SERVER_SEND_RTP
else
    SUT=${SAS_SERVER:-$TARGET_SERVER}
fi
SIP_PORT_NUM=${SIP_PORT_NUM:-${SIP_PORT:-5060}}
SIP_TLS_PORT_NUM=${SIP_TLS_PORT_NUM:-${SIP_TLS_PORT:-5061}}

source "$BASE_DIR/sipp/scripts/net-utils.sh"
SUT=$(resolve_ipv4 "$SUT")

# Business-day curve in the domain's local time
source "$BASE_DIR/sipp/scripts/cps-utils.sh"
CPS_TZ_OFFSET=$TZ_OFFSET
CPS_MULTIPLIER=$(cps_multiplier)
CALLRATE=$(awk -v cps="$BOOST_CPS" -v mult="$CPS_MULTIPLIER" -v seed="$RANDOM" \
    'BEGIN { srand(seed); v=cps*mult*(1+(rand()*0.04)-0.02); if (v<0.01) v=0.01; printf "%.2f", v }')
DURATION=275
NUMCALLS=$(awk -v r="$CALLRATE" -v d="$DURATION" 'BEGIN { printf "%.0f", r*d }')
if [ "$NUMCALLS" -lt 1 ]; then
    echo "Call rate $CALLRATE too low for a batch (multiplier $CPS_MULTIPLIER); nothing to do"
    exit 0
fi

PUBLICIP=$(dig +short myip.opendns.com @resolver1.opendns.com -4)
PRIVATEIP=$(ip a s | sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')
if [ "$IP_USE_PUBLIC" == "1" ] && [ -n "$PUBLICIP" ]; then
    SDP_IP=$PUBLICIP
else
    SDP_IP=$PRIVATEIP
fi

if ! allocate_ports 1 1 1; then
    echo "ERROR: Failed to allocate ports"
    exit 1
fi
SIP_PORT=$ALLOCATED_SIP_PORT
MEDIA_PORT=$ALLOCATED_MEDIA_PORT
CONTROL_PORT=$ALLOCATED_CONTROL_PORT

# Templated copy of the UAC scenario next to the original (pcap paths are
# relative): talk-time pause from --talk, media IP and RTP on/off applied to
# the copy only.
DOMAIN_CLEAN=$(echo "$DOMAIN" | tr -cd '[:alnum:]_')
SCENARIO="$BASE_DIR/sipp/scripts/.agentsim_uac_${SERVER_ID}_${DOMAIN_CLEAN}_$$.xml"
sed -e "s#<pause distribution=\"uniform\" min=\"5000\" max=\"80000\"/>#<pause distribution=\"uniform\" min=\"$TALK_MIN_MS\" max=\"$TALK_MAX_MS\"/>#" \
    -e "s/\[media_ip\]/$SDP_IP/g" \
    "$BASE_DIR/sipp/scripts/sipp_uac_pcap_g711a.xml" > "$SCENARIO"
if ! grep -q "min=\"$TALK_MIN_MS\" max=\"$TALK_MAX_MS\"" "$SCENARIO"; then
    logger -t agent-sim-boost -p user.warning "Talk-time pause not found in sipp_uac_pcap_g711a.xml; using the scenario's own talk time"
fi
if [ "$SEND_RTP_FINAL" != "1" ]; then
    sed -i -e 's/^[[:space:]]*<exec play_pcap_audio="\(g711a-[a-z0-9]*\)\.pcap"\/>/      <!-- RTP_DISABLED: <exec play_pcap_audio="\1.pcap"\/> -->/g' "$SCENARIO"
fi
trap 'rm -f "$SCENARIO"' EXIT

if [ "$TRANSPORT" == "l1" ]; then
    SIP_PORT_ADD_ON=":$SIP_TLS_PORT_NUM"
    TLS_CERT="$BASE_DIR/sipp/tls/sipp.crt"
    TLS_KEY="$BASE_DIR/sipp/tls/sipp.key"
    if [ ! -f "$TLS_CERT" ] || [ ! -f "$TLS_KEY" ]; then
        logger -t agent-sim-boost -p user.err "TLS certificates missing: $TLS_CERT / $TLS_KEY"
        exit 1
    fi
    TLS_CA_PATH=""
    [ -f /etc/ssl/certs/ca-certificates.crt ] && TLS_CA_PATH="-tls_ca /etc/ssl/certs/ca-certificates.crt"
    TLS_OPTIONS="-tls_cert $TLS_CERT -tls_key $TLS_KEY -tls_version 1.2 $TLS_CA_PATH"
else
    SIP_PORT_ADD_ON=":$SIP_PORT_NUM"
    TLS_OPTIONS=""
fi

source "$BASE_DIR/sipp/scripts/version-utils.sh"
UA_VERSION=$(get_ua_version "$BASE_DIR")

STATS_FILE="$BASE_DIR/sipp/stats/${SERVER_ID:-default}_domainboost_${TRANSPORT}_${DOMAIN_CLEAN}_$$.csv"

SIPP_CMD="sipp ${SUT}${SIP_PORT_ADD_ON} -r $CALLRATE -m $NUMCALLS \
-sf $SCENARIO \
-inf $INPUTFILE \
-inf $BASE_DIR/sipp/csv/random_caller_ids.csv \
-watchdog_interval 900000 -watchdog_minor_threshold 920000 -watchdog_major_threshold 9200000 \
-t $TRANSPORT -i $PRIVATEIP -p $SIP_PORT -cp $CONTROL_PORT -mp $MEDIA_PORT \
$TLS_OPTIONS \
-recv_timeout 60000 \
-key media_ip $SDP_IP \
-key ua_version $UA_VERSION \
-trace_stat -stf $STATS_FILE -fd 15 -bg"

logger -t agent-sim-boost -p user.info "Starting domain boost: server=$SERVER_ID domain=$DOMAIN transport=$TRANSPORT call_rate=$CALLRATE num_calls=$NUMCALLS multiplier=$CPS_MULTIPLIER talk=${TALK}s sip_port=$SIP_PORT"

# Relative pcap names resolve against the working directory, as for the cron jobs
cd "$BASE_DIR/sipp/scripts" || exit 1
SIPP_OUTPUT=$($SIPP_CMD 2>&1)
SIPP_EXIT=$?
echo "$SIPP_OUTPUT" | logger -t agent-sim-boost -p user.info
SIPP_PID=$(echo "$SIPP_OUTPUT" | grep -oP 'Background mode - PID=\[\K[0-9]+(?=\])')

if [ -z "$SIPP_PID" ]; then
    logger -t agent-sim-boost -p user.err "Domain boost failed to start: server=$SERVER_ID domain=$DOMAIN exit=$SIPP_EXIT cmd=$SIPP_CMD"
    exit 1
fi

# Keep the templated scenario until SIPp exits (the trap removes it)
while ps -p "$SIPP_PID" >/dev/null 2>&1; do
    sleep 20
done
logger -t agent-sim-boost -p user.info "Domain boost completed: server=$SERVER_ID domain=$DOMAIN pid=$SIPP_PID calls=$NUMCALLS"
