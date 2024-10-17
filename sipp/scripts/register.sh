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

LOG_FILE=$(basename "$INPUTFILE")
CALLRATE=8 #8 registrations per second roll out rate

echo "Registering $INPUTFILE"
ulimit -n 65536
echo "`date` - [start] $INPUTFILE $PORT $MEDIA_PORT $CONTROL_PORT (max users $MAX_USERS, pxt users is $PCT_USERS) " >> error_$LOG_FILE.log
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
	-bg -trace_err -error_file error_$LOG_FILE.log
	#-mp $MEDIA_PORT \