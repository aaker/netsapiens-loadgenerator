#!/bin/bash
#https://github.com/dizzy/sipR/tree/master/sipRtest/register
#https://github.com/saghul/sipp-scenarios/blob/master/sipp_uas_pcap_g711a.xml
#https://github.com/SIPp/sipp/issues/412

source /usr/local/NetSapiens/netsapiens-loadgenerator/.env

SUT=$1

INPUTFILE=$2
TRANSPORT=$3
PORT=$4
MEDIA_PORT=$5
CONTROL_PORT=$6
MEDIA_IP=$7

MAX_USERS=`cat $INPUTFILE | grep -v SEQUENTIAL | wc -l`
PCT_USERS=$REGISTRATION_PCT # 50% of the users will be registered

MAX_USERS=`printf "%.0f\n" $(echo "scale=2;$PCT_USERS*$MAX_USERS" |bc)`

CALLRATE=8 #8 registrations per second roll out rate
SIPP_ERROR_FILE="${LOG_DIR}/sipp_log_${TIMESTAMP}_$$.log"

log() {
        local level=$1
        shift
        local message=$@
        local timestamp=$(date +"%Y-%m-%d %H:%M:%S")
        echo "${timestamp} [${level}] ${message}" >> $LOG_FILE
}

log "INFO" "Registering $INPUTFILE"
ulimit -n 65536
log "INFO" "[start] $INPUTFILE $PORT $MEDIA_PORT $CONTROL_PORT (max users $MAX_USERS, pct users is $PCT_USERS)"
set -x
sipp \
        ${SUT} \
    -key expires 60 \
        -r $[CALLRATE] \
        -m $MAX_USERS \
        -t $TRANSPORT \
        -p $PORT \
        -cp $CONTROL_PORT \
        -rtp_echo \
        -sf /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.and.subscribe.sipp.xml \
        -oocsf /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uas_pcap_g711a.xml \
        -inf $INPUTFILE \
        -inf /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/random_user_agents.csv \
        -recv_timeout 60000 \
        -watchdog_interval 0 \
        -watchdog_minor_threshold 920000 \
        -watchdog_major_threshold 9200000 \
        -aa -default_behaviors -abortunexp \
		-tls_cert /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/certs/cacert.pem \
		-tls_key /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/certs/cakey.pem \
        -bg -trace_err -error_file $SIPP_ERROR_FILE
        #-mp $MEDIA_PORT \