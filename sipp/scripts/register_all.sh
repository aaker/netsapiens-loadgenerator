#!/bin/bash
#https://github.com/dizzy/sipR/tree/master/sipRtest/register
#https://github.com/saghul/sipp-scenarios/blob/master/sipp_uas_pcap_g711a.xml
#https://github.com/SIPp/sipp/issues/412

source /usr/local/NetSapiens/netsapiens-loadgenerator/.env

SUT=$TARGET_SERVER

COUNTER=0;
if [ -z "$2" ]; then
	COUNTER=$2;
fi

FILES=`ls /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/devices/* | wc -l`
echo "Found $FILES files"

COUNTER_LOCAL=0;
HOUROFDAY=`date +"%H"`
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

# get the public ip and push it into the sipp scripts for the media ip.
PUBLICIP=`dig +short myip.opendns.com @resolver1.opendns.com -4`
PRIVATEIP=$(ip a s|sed -ne '/127.0.0.1/!{s/^[ \t]*inet[ \t]*\([0-9.]\+\)\/.*$/\1/p}')

if [ "$IP_USE_PUBLIC" == "1" ]; then
	sed -i -e "s/\[media_ip\]/$PUBLICIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uas_pcap_g711a.xml
else 
	sed -i -e "s/\[media_ip\]/$PRIVATEIP/g" /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/sipp_uas_pcap_g711a.xml
fi

ulimit -n 65536
echo "starting run... " > /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/error_register.log
echo "scheduling batch" >> /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.log
for file in /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/csv/devices/*; do	
	SIPPORT=$((SIPPORT + 1));
	CONTROLPORT=$((CONTROLPORT + 1));
	MEDIAPORT=$((MEDIAPORT + 4));

	#modulo COUNTER AND MINOFHOUR
	MODU=$((COUNTER % 60));
	if [ $MODU -eq $MINOFHOUR ]; then
		echo "Registering $file"
	else
		COUNTER=$((COUNTER + 1)); ##incremenet here to keep looping. 
		continue;		
	fi

	COUNTER=$((COUNTER + 1)); #moved below to keep 0 based index.

	sleep 2; #disperse the load a bit.

	TRANSPORT_TYPE=$((COUNTER % 3));
	if [ $TRANSPORT_TYPE -eq 2 ]; then
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP
	elif [ $TRANSPORT_TYPE -eq 1 ]; then
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "t1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP
	else
		#TODO: add tls support here.
		/usr/local/NetSapiens/netsapiens-loadgenerator/sipp/scripts/register.sh "$SUT" "$file" "u1" $SIPPORT $MEDIAPORT $CONTROLPORT $PUBLICIP 
	fi
    
done
