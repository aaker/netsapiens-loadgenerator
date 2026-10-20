#!/usr/bin/env bash
#
# Generate time-aligned G.711 A-law RTP pcaps (and reference WAVs) for the
# call park call, using Deepgram Aura TTS + ffmpeg + wav2rtp-pcap.py. Same
# pipeline as generate-attended-pcaps.sh.
#
# The call has two sections, each with its own pair of tracks:
#
#   1. caller + agent 1, padded to PARK_AT - agent 1 then parks the caller
#        g711a-park-orig.pcap    caller (UAC, from agent connect)
#        g711a-park-term.pcap    agent 1 (sipp_uas_park.xml, from answer)
#   2. caller + agent 2 after the pickup, padded to TALK2_LEN - the caller
#      hangs up at the end
#        g711a-park-orig2.pcap   caller (UAC, from the pickup re-INVITE)
#        g711a-park-term2.pcap   agent 2 (sipp_uac_agent_dial.xml, from
#                                the pickup 200)
#
# PARK_AT and TALK2_LEN are 45s / 60s, close to the attended call's 44s / 60s, so the
# park caller is the attended caller scenario with these pcaps swapped in
# (manual_test.sh --flow park). The conversation is documented in
# park-call-script.md; the turns array below is the authoritative copy.
#
# Requirements: bash, curl, ffmpeg, ffprobe, python3, and a Deepgram key -
# or TTS=say on macOS for placeholder audio with the built-in voices.
# Usage:
#   DEEPGRAM_API_KEY=xxxxxxxx ./generate-park-pcaps.sh
#   TTS=say ./generate-park-pcaps.sh
#
# Pcaps are written to sipp/scripts/pcaps/ (the scenarios play pcaps/<name>.pcap) plus reference
# park-*.wav copies in this directory.

set -euo pipefail

# Load a local .env (DEEPGRAM_API_KEY=...) if present.
env_file="$(cd "$(dirname "$0")" && pwd)/.env"
if [ -f "$env_file" ]; then
  set -a; . "$env_file"; set +a
fi

TTS="${TTS:-deepgram}"
if [ "$TTS" = "say" ]; then
  CALLER_VOICE="${CALLER_VOICE:-Eddy (English (US))}"
  AGENT1_VOICE="${AGENT1_VOICE:-Samantha}"
  AGENT2_VOICE="${AGENT2_VOICE:-Reed (English (US))}"
else
  : "${DEEPGRAM_API_KEY:?Set DEEPGRAM_API_KEY in the environment or in audio/.env (or use TTS=say)}"
  CALLER_VOICE="${CALLER_VOICE:-aura-orpheus-en}"       # Victor Chen, Chen Auto Body
  AGENT1_VOICE="${AGENT1_VOICE:-aura-asteria-en}"   # Priya, tier 1 support
  AGENT2_VOICE="${AGENT2_VOICE:-aura-arcas-en}"     # Marcus, billing
fi
SR=24000                                          # TTS render rate (Hz); final output is 8 kHz
GAP="${GAP:-0.45}"                                # silence between turns (both tracks), seconds
PARK_AT="${PARK_AT:-45}"                          # section 1 length (agent 1 parks the caller)
TALK2_LEN="${TALK2_LEN:-60}"                      # section 2 length (the caller hangs up)

script_dir="$(cd "$(dirname "$0")" && pwd)"
out_dir="$(cd "$script_dir/../pcaps" && pwd)"     # sipp/scripts/pcaps/
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Ordered conversation. Format: "SPEAKER|text" (SPEAKER = CALLER, AGENT1,
# AGENT2). "PARK" ends section 1.
turns=(
"AGENT1|Thank you for calling Meridian Voice Support, this is Priya. How can I help you today?"
"CALLER|Hi Priya, it's Victor Chen at Chen Auto Body. Our invoice this month is about two hundred dollars higher than usual, and I can't tell why."
"AGENT1|I can help with that. Can you confirm the main number on the account?"
"CALLER|Sure, it's six one nine, five five five, zero one four four."
"AGENT1|Let me take a look. I see the account, and there is a new charge for additional phone numbers. Billing questions go to our billing team, and Marcus can walk you through the details."
"CALLER|Okay. Do I need to call a different number?"
"AGENT1|No, I'll park your call, and Marcus will pick it up in just a moment. You'll hear music while you wait."
"CALLER|Sounds good, thanks."
"PARK"
"AGENT2|Hi Victor, this is Marcus in billing. I just picked up your call from park. You have a question about this month's invoice?"
"CALLER|Yes. It's about two hundred dollars higher than usual."
"AGENT2|I see it. Ten new phone numbers were added on the third, and each one has a monthly charge plus a one-time setup fee."
"CALLER|Ten numbers? We only asked for two, for our new front desk staff."
"AGENT2|You're right, the order says two. It looks like the quantity was entered incorrectly. I'm removing the eight extra numbers now, and I'll credit the charges for them."
"CALLER|Great, thank you. Will the credit show up on next month's invoice?"
"AGENT2|Yes, it will appear as a separate line item. You'll also get an email confirmation in a few minutes."
"CALLER|One more thing. Can you make sure the two numbers we did order ring the front desk?"
"AGENT2|They do. Both are routed to your reception queue, the same as your main number."
"CALLER|Perfect. Thanks for sorting that out, Marcus."
"AGENT2|Happy to help, Victor. Have a great day."
"CALLER|You too. Bye."
)

json_payload() { python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$1"; }

# Canonical mono PCM silence of N seconds.
silence() { ffmpeg -nostdin -v error -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=$SR" -t "$1" -c:a pcm_s16le "$2"; }

fadd() { python3 -c "print($1 + $2)"; }

legs=(orig term orig2 term2)
for leg in "${legs[@]}"; do : > "$work/$leg.txt"; done

# Pad both tracks of the current section with silence up to $1 seconds.
pad_section() {
  local target="$1" name="$2" pad first second
  pad="$(python3 -c "print(max(0, $target - $elapsed))")"
  if python3 -c "exit(0 if $elapsed > $target else 1)"; then
    echo "WARNING: $name runs ${elapsed}s, past its ${target}s length - trim the script or raise the length" >&2
  fi
  echo "[--] $name: spoke ${elapsed}s, padding ${pad}s to ${target}s"
  silence "$pad" "$work/pad_$section.wav"
  if [ "$section" = 1 ]; then first=orig; second=term; else first=orig2; second=term2; fi
  printf "file '%s'\n" "$work/pad_$section.wav" >> "$work/$first.txt"
  printf "file '%s'\n" "$work/pad_$section.wav" >> "$work/$second.txt"
}

elapsed=0          # running duration of the current section, seconds
section=1
i=0
for turn in "${turns[@]}"; do
  if [ "$turn" = "PARK" ]; then
    pad_section "$PARK_AT" "section 1 (to the park)"
    section=2; elapsed=0
    continue
  fi

  i=$((i + 1))
  speaker="${turn%%|*}"
  text="${turn#*|}"
  case "$speaker" in
    CALLER) voice="$CALLER_VOICE" ;;
    AGENT1) voice="$AGENT1_VOICE" ;;
    AGENT2) voice="$AGENT2_VOICE" ;;
    *) echo "ERROR: unknown speaker '$speaker'" >&2; exit 1 ;;
  esac
  case "$section$speaker" in
    1CALLER) mine=orig;  other=term ;;
    1AGENT1) mine=term;  other=orig ;;
    2CALLER) mine=orig2; other=term2 ;;
    2AGENT2) mine=term2; other=orig2 ;;
    *) echo "ERROR: $speaker does not speak in section $section" >&2; exit 1 ;;
  esac

  idx="$(printf '%02d' "$i")"
  echo "[$idx] $speaker ($voice): ${text:0:60}..."

  if [ "$TTS" = "say" ]; then
    say -v "$voice" -o "$work/raw_$idx.aiff" "$text"
    raw="$work/raw_$idx.aiff"
  else
    curl -fsS -X POST \
      "https://api.deepgram.com/v1/speak?model=$voice&encoding=linear16&sample_rate=$SR&container=wav" \
      -H "Authorization: Token $DEEPGRAM_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$(json_payload "$text")" \
      -o "$work/raw_$idx.wav"
    raw="$work/raw_$idx.wav"
  fi
  ffmpeg -nostdin -v error -y -i "$raw" -ac 1 -ar "$SR" -c:a pcm_s16le "$work/clip_$idx.wav"

  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/clip_$idx.wav")"
  silence "$dur" "$work/sil_$idx.wav"
  silence "$GAP" "$work/gap_$idx.wav"

  printf "file '%s'\n" "$work/clip_$idx.wav" >> "$work/$mine.txt"
  printf "file '%s'\n" "$work/sil_$idx.wav"  >> "$work/$other.txt"
  printf "file '%s'\n" "$work/gap_$idx.wav"  >> "$work/$mine.txt"
  printf "file '%s'\n" "$work/gap_$idx.wav"  >> "$work/$other.txt"

  elapsed="$(fadd "$elapsed" "$(fadd "$dur" "$GAP")")"
done
pad_section "$TALK2_LEN" "section 2 (after the pickup)"

# Concatenate each track, then condition for telephony: PSTN bandpass
# (300-3400 Hz), loudness normalization, downsample to 8 kHz.
TELEPHONY_AF="highpass=f=300,lowpass=f=3400,loudnorm=I=-20:TP=-3:LRA=11"
ssrc=0
for leg in "${legs[@]}"; do
  ssrc=$((ssrc + 1))
  ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$work/$leg.txt" -c:a pcm_s16le "$work/$leg.wav"
  ffmpeg -nostdin -v error -y -i "$work/$leg.wav" -af "$TELEPHONY_AF" -ac 1 -ar 8000 -c:a pcm_s16le "$script_dir/park-$leg.wav"
  ffmpeg -nostdin -v error -y -i "$script_dir/park-$leg.wav" -f alaw "$work/$leg.alaw"
  python3 "$script_dir/wav2rtp-pcap.py" "$work/$leg.alaw" "$out_dir/g711a-park-$leg.pcap" "0A88CA0$ssrc"
  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$script_dir/park-$leg.wav")"
  echo "park-$leg.wav / g711a-park-$leg.pcap: ${dur}s"
done
echo "Done - pcaps written to $out_dir."
