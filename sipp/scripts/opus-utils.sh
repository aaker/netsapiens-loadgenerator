#!/bin/bash
# Shared helpers for Opus/G.711a codec percentage handling in SIPp scenarios.
# Source this file; do not execute it directly.
#
# Usage:
#   source "$BASE_DIR/sipp/scripts/opus-utils.sh"
#   _OPUS_REGEX=$(_opus_regex "${OPUS_PCT:-99}")
#   _UAS_SCENARIO=$(make_uas_scenario "$BASE_DIR/sipp/scripts/sipp_uas_pcap_opus_g711a_fallback.xml" "$_OPUS_REGEX" "${OPUS_PCT:-99}")

# Convert an integer percentage (0-100) to a POSIX ERE pattern that matches
# the last-2-digit bucket of the Call-ID numeric prefix for that percentage of
# calls.  The pattern is injected into UAS scenario templates (replacing
# __OPUS_REGEX__) via make_uas_scenario().
#
# Examples:
#   _opus_regex 99  →  [0-8][0-9]|9[0-8]   (matches 00-98, i.e. 99/100 buckets)
#   _opus_regex 50  →  [0-4][0-9]           (matches 00-49, i.e. 50/100 buckets)
#   _opus_regex 0   →  NOMATCH              (matches nothing)
#   _opus_regex 100 →  [0-9][0-9]           (matches everything)
_opus_regex() {
    local N=${1:-99}
    [ "$N" -gt 100 ] && N=100
    [ "$N" -lt 0   ] && N=0
    local tens=$(( N / 10 ))
    local units=$(( N % 10 ))
    if   [ "$N" -le 0   ]; then echo "NOMATCH"
    elif [ "$N" -ge 100 ]; then echo "[0-9][0-9]"
    elif [ "$units" -eq 0 ]; then echo "[0-$(( tens - 1 ))][0-9]"
    elif [ "$tens"  -eq 0 ]; then echo "0[0-$(( units - 1 ))]"
    else echo "[0-$(( tens - 1 ))][0-9]|${tens}[0-$(( units - 1 ))]"
    fi
}

# Generate a temp UAS scenario file with __OPUS_REGEX__ replaced.
# Prints the path to the generated file.
#   $1 = template path (contains __OPUS_REGEX__ placeholder)
#   $2 = regex string from _opus_regex()
#   $3 = opus_pct integer (used only to name the output file)
make_uas_scenario() {
    local template="$1"
    local regex="$2"
    local pct="${3:-99}"
    local out="/tmp/sipp_uas_opus_${pct}.xml"
    sed "s#__OPUS_REGEX__#${regex}#g" "$template" > "$out"
    echo "$out"
}
