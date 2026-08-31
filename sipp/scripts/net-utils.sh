#!/bin/bash
# Shared helper: force SIPp's destination onto IPv4.
# Source this file; do not execute it directly.
#
# Usage in a launch script:
#   source "$BASE_DIR/sipp/scripts/net-utils.sh"
#   SUT=$(resolve_ipv4 "$SUT")
#
# SIPp binds its local socket to an IPv4 address (-i <private ip>) but resolves
# the destination hostname itself.  When that hostname has an AAAA record SIPp
# may pick the IPv6 answer and abort with:
#   Network family mismatch for local (a.b.c.d) and remote (<v6 addr>, 10) IP
# Resolving to an A record here keeps both ends IPv4.  Note the scenarios use
# [remote_ip], which SIPp already expands to the resolved address, so passing a
# literal changes nothing in the SIP messages.

# resolve_ipv4 <host>
# Echoes the first IPv4 address for <host>.  Passes IPv4 literals and
# bracket-less hostnames through unchanged when no A record can be found, so a
# resolver hiccup degrades to today's behaviour rather than killing the run.
resolve_ipv4() {
    local host="$1"
    local ip=""

    # Already an IPv4 literal - nothing to do.
    if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$host"
        return 0
    fi

    if command -v getent >/dev/null 2>&1; then
        ip=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NF>0 {print $1; exit}')
    fi
    if [ -z "$ip" ] && command -v dig >/dev/null 2>&1; then
        ip=$(dig +short A "$host" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
    fi
    if [ -z "$ip" ] && command -v host >/dev/null 2>&1; then
        ip=$(host -t A "$host" 2>/dev/null | awk '/has address/ {print $NF; exit}')
    fi

    if [ -n "$ip" ]; then
        echo "$ip"
    else
        echo "Warning: could not resolve an IPv4 address for '$host'; using it as-is" >&2
        echo "$host"
    fi
}
