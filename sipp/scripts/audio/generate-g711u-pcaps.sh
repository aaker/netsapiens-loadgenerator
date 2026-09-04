#!/usr/bin/env bash
#
# Generate G.711 mu-law (PCMU, PT 0) RTP pcaps for the SIPp scenarios that
# negotiate PCMU - currently sipp_uas_answer_then_callback.xml.
#
# Unlike generate-call-pcaps.sh this needs NO Deepgram key and no TTS: it
# re-encodes the reference WAVs committed in this directory (the exact audio
# the g711a-*.pcap files were built from), so the mu-law pcaps carry the same
# conversation, the same turn alignment and the same lengths as their A-law
# counterparts. Re-run it after regenerating the WAVs with
# generate-call-pcaps.sh.
#
#   g711u-orig.pcap   caller, segment 1 (90s)
#   g711u-orig2.pcap  caller, segment 2 (post-transfer, ~3.5 min)
#   g711u-term.pcap   agent 1, segment 1 (90s)
#   g711u-term2.pcap  agent 2, post-transfer (~3.5 min)
#   g711u-silence.pcap  90s of mu-law silence
#
# Requirements: bash, ffmpeg, python3.  Usage: ./generate-g711u-pcaps.sh
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
out_dir="$(cd "$script_dir/.." && pwd)"           # sipp/scripts/
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

SILENCE_SECONDS="${SILENCE_SECONDS:-90}"

# SSRCs are distinct from the A-law set (0A11CAxx) so a capture makes it
# obvious which codec family a stream came from.  A case statement rather than
# an associative array keeps this runnable under bash 3.2 (macOS).
ssrc_for() {
    case "$1" in
        orig)  echo 0B110011 ;;
        orig2) echo 0B110012 ;;
        term)  echo 0B110022 ;;
        term2) echo 0B110033 ;;
    esac
}

for leg in orig orig2 term term2; do
    wav="$script_dir/call-$leg.wav"
    [ -f "$wav" ] || { echo "missing $wav (run generate-call-pcaps.sh first)"; exit 1; }
    ffmpeg -nostdin -v error -y -i "$wav" -ac 1 -ar 8000 -f mulaw "$work/$leg.ulaw"
    python3 "$script_dir/wav2rtp-pcap.py" --codec ulaw \
        "$work/$leg.ulaw" "$out_dir/g711u-$leg.pcap" "$(ssrc_for "$leg")"
done

# mu-law encoded digital silence is 0xFF
python3 -c "open('$work/silence.ulaw','wb').write(bytes([0xFF])*8000*$SILENCE_SECONDS)"
python3 "$script_dir/wav2rtp-pcap.py" --codec ulaw \
    "$work/silence.ulaw" "$out_dir/g711u-silence.pcap" 0B110000

echo "Wrote g711u-*.pcap to $out_dir"
