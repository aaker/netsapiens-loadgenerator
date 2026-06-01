#!/bin/bash
# Shared helper: resolve a version string to stamp into SIP User-Agent headers.
# Source this file; do not execute it directly.
#
# Usage in a launch script:
#   source "$BASE_DIR/sipp/scripts/version-utils.sh"
#   UA_VERSION=$(get_ua_version "$BASE_DIR")
#   ... sipp ... -key ua_version "$UA_VERSION" ...
# and reference [ua_version] in the scenario's User-Agent header, e.g.
#   User-Agent: netsapiens-loadgenerator ([ua_version])

# Resolve the running version dynamically, per run.  Order of preference:
#   1. git describe  (when deployed as a git checkout - the normal case)
#   2. a VERSION file in the repo root (write it at deploy time for tarball/
#      rsync deploys that have no .git directory)
#   3. "unknown"
# The result is sanitised to a SIP-token-safe string (letters, digits, '.',
# '-', '_') so it can never break the header or the -key argument.
get_ua_version() {
    local dir="${1:-.}"
    local v=""

    if command -v git >/dev/null 2>&1; then
        v=$(git -C "$dir" describe --tags --always 2>/dev/null)
        # When there are no tags, describe returns a bare commit hash (e.g.
        # cfe3b9e).  Prefix it with 'g' to match git's conventional gHASH form
        # (gcfe3b9e).  Tagged output (v1.2 / v1.2-3-gcfe3b9e) is left as-is.
        if [[ "$v" =~ ^[0-9a-f]{7,40}$ ]]; then
            v="g$v"
        fi
    fi

    if [ -z "$v" ] && [ -f "$dir/VERSION" ]; then
        v=$(head -n1 "$dir/VERSION")
    fi

    [ -z "$v" ] && v="unknown"

    printf '%s' "$v" | tr ' /' '__' | tr -cd 'A-Za-z0-9._-'
}
