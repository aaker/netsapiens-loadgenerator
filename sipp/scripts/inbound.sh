#!/bin/bash

source /usr/local/NetSapiens/netsapiens-loadgenerator/.env

SUT=$TARGET_SERVER


INPUTFILE="/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/phonenumbers/${1}.csv" 

if [ ! -f $INPUTFILE ]; then
	echo "File $INPUTFILE does not exist"
	exit 1
fi

if [ ! -f $INPUTFILE ]; then
	echo "File $INPUTFILE does not exist"
	exit 1
fi

if [ -z "$PEAK_CPS" ]; then
	echo "No PEAK_CPS specified, defaulting to 7 cps, 1 per script"
	PEAK_CPS=7

fi

MAX_USERS=`cat $INPUTFILE | grep -v SEQUENTIAL | wc -l`

PUBLICIP=`dig +short myip.opendns.com @resolver1.opendns.com`

sed -i -e "s/\[media_ip\]/$PUBLICIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml

CALLRATE=`printf "%.1f\n" $(echo "scale=2;$PEAK_CPS/7" |bc)`
DURATION=275 # 5 minutes minus some time for calls to complete
NUMCALLS=`printf "%.0f\n" $(echo "scale=2;$CALLRATE*$DURATION" |bc)`
echo "Submitting $NUMCALLS calls to $SUT for $DURATION seconds at $CALLRATE cps using $INPUTFILE"
sipp \
	${SUT} \
    -r "$CALLRATE" \
	-m $NUMCALLS \
	-sf /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml \
	-inf $INPUTFILE \
	-watchdog_interval 900000 \
	-watchdog_minor_threshold 920000 \
	-watchdog_major_threshold 9200000 \
	-t u1 \
    -inf /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/random_caller_ids.csv \
	-inf /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/public_info.csv \
	-recv_timeout 60000 \
	-key media_ip $PUBLICIP \
	-bg \
    -trace_err

