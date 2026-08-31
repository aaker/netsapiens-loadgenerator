#!/bin/bash
# Shared device-CSV helpers for SIPp launch scripts.
# Source this file; do not execute it directly.
#
#   source "$BASE_DIR/sipp/scripts/csv-utils.sh"
#   normalize_device_csv <csv-file> [header]
#
# Rewrites a generated device CSV in place so the register scenario can rely on
# a fixed 6-column layout:
#   field0 displayName ; field1 extension ; field2 domain ;
#   field3 [authentication ...] ; field4 userAgent ; field5 calleeExt
#
# - header (RANDOM by default, pass SEQUENTIAL to keep deterministic order)
# - pads old 4-column rows with the default userAgent from lib/utils.js
# - calleeExt = extension - 1, except the lowest extension in every domain
#   (1000, see USER_EXTENSION_START in server.js) wraps up to 1001 since 999
#   never exists. Used by the extension-to-extension call in
#   register.and.subscribe.sipp.xml.
# - strips and re-emits \r\n line endings (SIPp expects them; a stray mid-line
#   CR would otherwise leak into SIP headers via [field4]/[field5])
normalize_device_csv() {
    local csv="$1"
    local header="${2:-RANDOM}"
    local tmp="${csv}.norm.$$"

    awk -F';' -v header="$header" '
        { sub(/\r$/, "") }
        /^(SEQUENTIAL|RANDOM)/ { printf "%s\r\n", header; next }
        /^[[:space:]]*$/ { next }
        NF >= 4 {
            ua = (NF >= 5 && $5 != "") ? $5 : "netsapiens-loadgenerator"
            callee = ($2 == 1000) ? $2 + 1 : $2 - 1
            printf "%s;%s;%s;%s;%s;%s\r\n", $1, $2, $3, $4, ua, callee
        }' "$csv" > "$tmp" && cat "$tmp" > "$csv"
    local rc=$?
    rm -f "$tmp"
    return $rc
}
