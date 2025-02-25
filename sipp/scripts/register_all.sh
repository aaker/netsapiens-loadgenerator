#!/bin/bash
#https://github.com/dizzy/sipR/tree/master/sipRtest/register
#https://github.com/saghul/sipp-scenarios/blob/master/sipp_uas_pcap_g711a.xml
#https://github.com/SIPp/sipp/issues/412

source /usr/local/NetSapiens/netsapiens-loadgenerator/.env

SUT=$TARGET_SERVER


log() {
    local level=$1
    shift
    local message=$@
    local timestamp=$(date +"%Y-%m-%d %H:%M:%S")
    echo "${timestamp} [${level}] ${message}" >> $LOG_FILE
}

COUNTER=0;
if [ -z "$2" ]; then
    COUNTER=$2;
fi

FILES=`ls /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/devices/* | wc -l`
log "INFO" "Found $FILES files"

COUNTER_LOCAL=0;
HOUROFDAY=$((10#$(date +"%H")))
MINOFHOUR=`date +"%M"`
ADJUSTPORT=$((HOUROFDAY % 2)) # 0 or 1, use to adjust port numbers every hour to avoid conflicts at the top of the hour during flip over.

if [ $ADJUSTPORT -eq 0 ]; then
    SIPPORT=6060;
    MEDIAPORT=20000;
    CONTROLPORT=10000;
else
    SIPPORT=8060;
    MEDIAPORT=30004;
    CONTROLPORT=12004;
fi

log "DEBUG" "Using SIPPORT=$SIPPORT, MEDIAPORT=$MEDIAPORT, CONTROLPORT=$CONTROLPORT"

# get the public ip and push it into the sipp scripts for the media ip.
PUBLICIP=$(curl -s https://api.ipify.org)
PRIVATEIP=$(hostname -I | awk '{print $1}')

log "DEBUG" "PUBLICIP=$PUBLICIP, PRIVATEIP=$PRIVATEIP"

if [ "$IP_USE_PUBLIC" == "1" ]; then
    sed -i -e "s/\[media_ip\]/$PUBLICIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uas_pcap_g711a.xml
    log "DEBUG" "Replaced [media_ip] with PUBLICIP in sipp_uas_pcap_g711a.xml"
else
    sed -i -e "s/\[media_ip\]/$PRIVATEIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uas_pcap_g711a.xml
    log "DEBUG" "Replaced [media_ip] with PRIVATEIP in sipp_uas_pcap_g711a.xml"
fi

ulimit -n 65536
log "INFO" "scheduling batch"

if [ ! -f /tmp/register_all ]; then
    REGISTER_ALL=1
    log "INFO" "Flag /tmp/register_all not found: registering ALL files immediately."
else
    REGISTER_ALL=0
    log "INFO" "Flag /tmp/register_all found: using normal registration logic."
fi

for file in /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/devices/*; do
    SIPPORT=$((SIPPORT + 1));
    CONTROLPORT=$((CONTROLPORT + 1));
    MEDIAPORT=$((MEDIAPORT + 4));

    log "DEBUG" "Processing file $file with SIPPORT=$SIPPORT, MEDIAPORT=$MEDIAPORT, CONTROLPORT=$CONTROLPORT"

    if [ "$REGISTER_ALL" -eq 1 ]; then
        log "INFO" "Registering $file (REGISTER_ALL active)"
    else
        MODU=$((COUNTER % 60))
        if [ $MODU -eq $MINOFHOUR ]; then
            log "INFO" "Registering $file"
        else
            COUNTER=$((COUNTER + 1))  # increment counter to continue looping
            log "DEBUG" "Skipping $file, COUNTER=$COUNTER"
            continue
        fi
    fi

    COUNTER=$((COUNTER + 1)); #moved below to keep 0 based index.

    sleep 2; #disperse the load a bit.

    TRANSPORT_TYPE=$((COUNTER % 3));
    if [ $TRANSPORT_TYPE -eq 2 ]; then
        log "DEBUG" "Using UDP transport with server $SUT for $file"
        /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP
    elif [ $TRANSPORT_TYPE -eq 1 ]; then
        log "DEBUG" "Using TCP transport with server $SUT for $file"
        /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "t1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP
    else
		TLS_SUT="$TARGET_SERVER:5061"
        log "DEBUG" "Using TLS transport with server $TLS_SUT for $file"
        /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$TLS_SUT" "$file" "ln" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP
    fi
done

if [ "$REGISTER_ALL" -eq 1 ]; then
    touch /tmp/register_all
    log "INFO" "Created /tmp/register_all; future runs will use normal registration logic."
fi