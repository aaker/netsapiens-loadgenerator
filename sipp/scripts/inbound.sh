#!/bin/bash

source /usr/local/NetSapiens/netsapiens-loadgenerator/.env

SUT=${SAS_SERVER:-$TARGET_SERVER}



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

#add some randomness to the PEAK_CPS to avoid exact same call rate every run, make it + or 0 10%
RANDOM_ADJUSTMENT=$(( ( RANDOM % (PEAK_CPS / 10) ) + 1 ))
if (( RANDOM % 2 )); then
	PEAK_CPS=$((PEAK_CPS + RANDOM_ADJUSTMENT))
else
	PEAK_CPS=$((PEAK_CPS - RANDOM_ADJUSTMENT))
fi

#round PEAK_CPS to 1 decimal place
PEAK_CPS=`printf "%.0f\n" "$(echo "scale=2;$PEAK_CPS" |bc)"`


PUBLICIP=`dig +short myip.opendns.com @resolver1.opendns.com -4`
PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

if [ "$IP_USE_PUBLIC" == "1" ]; then
	sed -i -e "s/\[media_ip\]/$PUBLICIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
else 
	sed -i -e "s/\[media_ip\]/$PRIVATEIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uac_pcap_g711a.xml
fi


CALLRATE=`printf "%.2f\n" $(echo "scale=2;$PEAK_CPS/7" |bc)` # 7 scripts running at once assuming all TZ's in play. 
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
	-recv_timeout 60000 \
	-key media_ip $PUBLICIP \
	-bg \
    -trace_err

