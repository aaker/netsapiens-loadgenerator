#!/bin/bash
# Shared helpers for Opus/G.711a codec percentage handling in SIPp scenarios.
# Source this file; do not execute it directly.
#
# Usage:
#   source "$BASE_DIR/sipp/scripts/opus-utils.sh"
#   _OPUS_REGEX=$(_opus_regex "${OPUS_PCT:-50}")
#   _UAS_SCENARIO=$(make_uas_scenario "$BASE_DIR/sipp/scripts/sipp_uas_pcap_opus_g711a_fallback.xml" "$_OPUS_REGEX" "${OPUS_PCT:-50}")

# Convert a percentage (0-100) to a POSIX ERE pattern matching the last digit
# of the Call-ID numeric prefix for that percentage of calls (10% granularity).
# Values are rounded down to the nearest 10%.
#
# Examples:
#   _opus_regex 90  →  [0-8]    (digits 0-8 → Opus, digit 9 → G.711a)
#   _opus_regex 50  →  [0-4]
#   _opus_regex 10  →  0        (only digit 0 → Opus)
#   _opus_regex 0   →  NOMATCH  (never matches → always G.711a)
#   _opus_regex 100 →  [0-9]    (always matches → always Opus)
_opus_regex() {
    local N=${1:-50}
    [ "$N" -lt 0   ] && N=0
    [ "$N" -gt 100 ] && N=100
    local thresh=$(( N / 10 ))   # rounds down to nearest 10%
    if   [ "$thresh" -le 0  ]; then echo "NOMATCH"
    elif [ "$thresh" -ge 10 ]; then echo "[0-9]"
    elif [ "$thresh" -eq 1  ]; then echo "0"
    else echo "[0-$(( thresh - 1 ))]"
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
    local pct="${3:-50}"
    local out="/tmp/sipp_uas_opus_${pct}.xml"
    sed "s#__OPUS_REGEX__#${regex}#g" "$template" > "$out"
    echo "$out"
}
