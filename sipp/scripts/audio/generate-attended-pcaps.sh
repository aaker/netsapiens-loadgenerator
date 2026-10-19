#!/usr/bin/env bash
#
# Generate time-aligned G.711 A-law RTP pcaps (and reference WAVs) for the
# attended (supervised) transfer call, using Deepgram Aura TTS + ffmpeg +
# wav2rtp-pcap.py. Same pipeline as generate-call-pcaps.sh.
#
# The call has three sections, each with its own pair of tracks:
#
#   1. caller + agent 1, padded to HOLD_AT - agent 1 then holds the caller
#        g711a-att-orig.pcap        caller (UAC, from agent connect)
#        g711a-att-term.pcap        agent 1 (UAS role A, from answer)
#   2. consult: agent 1 + agent 2 while the caller is on hold, padded to
#      CONSULT_LEN - agent 1 then sends the REFER with Replaces
#        g711a-att-consult-a.pcap   agent 1 (UAS role A, from consult answer)
#        g711a-att-consult-b.pcap   agent 2 (UAS role B, from consult answer)
#   3. caller + agent 2 after the merge, padded to TALK2_LEN - the caller
#      hangs up at the end
#        g711a-att-orig2.pcap       caller (UAC, from the merge)
#        g711a-att-term2.pcap       agent 2 (UAS role B, from the merge)
#
# The section lengths are timers in sipp_uac_attended.xml and
# sipp_uas_attended.xml - change them together. The conversation is
# documented in attended-call-script.md; the turns array below is the
# authoritative copy.
#
# Requirements: bash, curl, ffmpeg, ffprobe, python3, and a Deepgram key -
# or TTS=say on macOS, which renders placeholder audio with the built-in
# voices (no key; re-run with Deepgram later for the real voices).
# Usage:
#   DEEPGRAM_API_KEY=xxxxxxxx ./generate-attended-pcaps.sh
#   TTS=say ./generate-attended-pcaps.sh
#
# Pcaps are written to sipp/scripts/ (next to the scenarios) plus reference
# att-*.wav copies in this directory.

set -euo pipefail

# Load a local .env (DEEPGRAM_API_KEY=...) if present.
env_file="$(cd "$(dirname "$0")" && pwd)/.env"
if [ -f "$env_file" ]; then
  set -a; . "$env_file"; set +a
fi
TTS="${TTS:-deepgram}"
if [ "$TTS" = "say" ]; then
  CALLER_VOICE="${CALLER_VOICE:-Ralph}"
  AGENT1_VOICE="${AGENT1_VOICE:-Samantha}"
  AGENT2_VOICE="${AGENT2_VOICE:-Reed (English (US))}"
else
  : "${DEEPGRAM_API_KEY:?Set DEEPGRAM_API_KEY in the environment or in audio/.env (or use TTS=say)}"
  CALLER_VOICE="${CALLER_VOICE:-aura-orion-en}"     # Tom, the office manager
  AGENT1_VOICE="${AGENT1_VOICE:-aura-asteria-en}"   # Priya, tier 1 support
  AGENT2_VOICE="${AGENT2_VOICE:-aura-arcas-en}"     # Marcus, provisioning
fi
SR=24000                                          # TTS render rate (Hz); final output is 8 kHz
GAP="${GAP:-0.45}"                                # silence between turns (both tracks), seconds
HOLD_AT="${HOLD_AT:-44}"                          # section 1 length (agent 1 holds the caller)
CONSULT_LEN="${CONSULT_LEN:-24}"                  # section 2 length (agent 1 sends the REFER)
TALK2_LEN="${TALK2_LEN:-60}"                      # section 3 length (the caller hangs up)

script_dir="$(cd "$(dirname "$0")" && pwd)"
out_dir="$(cd "$script_dir/.." && pwd)"           # sipp/scripts/
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Ordered conversation. Format: "SPEAKER|text" (SPEAKER = CALLER, AGENT1,
# AGENT2). "HOLD" ends section 1 and "MERGE" ends section 2.
turns=(
"AGENT1|Thank you for calling Meridian Voice Support, this is Priya. How can I help you today?"
"CALLER|Hi Priya, it's Tom Becker at Lakeside Dental. Since this morning, every call to our main number goes straight to voicemail instead of ringing the front desk."
"AGENT1|I'm sorry about that, Tom. Let me pull up the account. I have the main number as six one nine, five five five, zero one four four. Is that right?"
"CALLER|That's the one. As far as I know, nobody here changed anything."
"AGENT1|I can see the answering rules were edited early this morning. Routing changes are handled by our provisioning team, so I'd like Marcus to look at this with you. Let me place you on a brief hold while I fill him in."
"CALLER|Sure, I'll hold."
"HOLD"
"AGENT2|Provisioning, this is Marcus."
"AGENT1|Hi Marcus, it's Priya. I have Tom Becker from Lakeside Dental on hold. Their main number started going straight to voicemail this morning, and the answering rules were edited at six a m."
"AGENT2|Okay, I see the edit on the account. I can take it from here."
"AGENT1|Great, I'll connect him now. Thanks, Marcus."
"MERGE"
"AGENT2|Hi Tom, this is Marcus in provisioning. Priya filled me in on the voicemail problem."
"CALLER|Thanks, Marcus. Our patients can't reach the front desk at all."
"AGENT2|I see what happened. Your after-hours schedule was set to stay active all day, so every call goes to voicemail. I'm switching it back to your normal business hours now."
"CALLER|Do you know who changed it?"
"AGENT2|It was edited from the admin portal at six this morning. It looks like someone was setting up a holiday schedule. I'd check with whoever manages your portal login."
"CALLER|That might have been our office administrator. I'll ask them."
"AGENT2|Okay, the schedule is fixed. Can you call your main number from a cell phone so we can test it?"
"CALLER|Calling now. And the front desk phones are ringing. That's working again."
"AGENT2|Perfect. I've added a note to your account, so if it happens again, anyone on our team can see the history."
"CALLER|Great. Thank you, Marcus, that was quick."
"AGENT2|Happy to help, Tom. Have a good rest of your day."
"CALLER|You too. Bye."
)

json_payload() { python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$1"; }

# Canonical mono PCM silence of N seconds.
silence() { ffmpeg -nostdin -v error -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=$SR" -t "$1" -c:a pcm_s16le "$2"; }

fadd() { python3 -c "print($1 + $2)"; }

legs=(orig term consult-a consult-b orig2 term2)
for leg in "${legs[@]}"; do : > "$work/$leg.txt"; done

# Section -> the two tracks it writes to, and the speaker on the first one.
section_tracks() {
  case "$1" in
    1) echo "orig term" ;;
    2) echo "consult-a consult-b" ;;
    3) echo "orig2 term2" ;;
  esac
}

# Pad both tracks of the current section with silence up to $1 seconds.
pad_section() {
  local target="$1" name="$2" pad
  pad="$(python3 -c "print(max(0, $target - $elapsed))")"
  if python3 -c "exit(0 if $elapsed > $target else 1)"; then
    echo "WARNING: $name runs ${elapsed}s, past its ${target}s length - trim the script or raise the length" >&2
  fi
  echo "[--] $name: spoke ${elapsed}s, padding ${pad}s to ${target}s"
  silence "$pad" "$work/pad_$section.wav"
  for t in $(section_tracks "$section"); do
    printf "file '%s'\n" "$work/pad_$section.wav" >> "$work/$t.txt"
  done
}

elapsed=0          # running duration of the current section, seconds
section=1
i=0
for turn in "${turns[@]}"; do
  if [ "$turn" = "HOLD" ]; then
    pad_section "$HOLD_AT" "section 1 (to the hold)"
    section=2; elapsed=0
    continue
  fi
  if [ "$turn" = "MERGE" ]; then
    pad_section "$CONSULT_LEN" "section 2 (consult)"
    section=3; elapsed=0
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

  # The speaker's track in this section; the other track gets silence.
  read -r first second <<< "$(section_tracks "$section")"
  case "$section$speaker" in
    1CALLER|2AGENT1|3CALLER) mine="$first";  other="$second" ;;
    1AGENT1|2AGENT2|3AGENT2) mine="$second"; other="$first" ;;
    *) echo "ERROR: $speaker does not speak in section $section" >&2; exit 1 ;;
  esac
  # Section 2 lists agent 1 first, so swap: consult-a is agent 1's track.
  if [ "$section" = 2 ]; then
    if [ "$speaker" = "AGENT1" ]; then mine=consult-a; other=consult-b; else mine=consult-b; other=consult-a; fi
  fi

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
pad_section "$TALK2_LEN" "section 3 (after the merge)"

# Concatenate each track, then condition for telephony: PSTN bandpass
# (300-3400 Hz), loudness normalization, downsample to 8 kHz.
TELEPHONY_AF="highpass=f=300,lowpass=f=3400,loudnorm=I=-20:TP=-3:LRA=11"
ssrc=0
for leg in "${legs[@]}"; do
  ssrc=$((ssrc + 1))
  ffmpeg -nostdin -v error -y -f concat -safe 0 -i "$work/$leg.txt" -c:a pcm_s16le "$work/$leg.wav"
  ffmpeg -nostdin -v error -y -i "$work/$leg.wav" -af "$TELEPHONY_AF" -ac 1 -ar 8000 -c:a pcm_s16le "$script_dir/att-$leg.wav"
  ffmpeg -nostdin -v error -y -i "$script_dir/att-$leg.wav" -f alaw "$work/$leg.alaw"
  python3 "$script_dir/wav2rtp-pcap.py" "$work/$leg.alaw" "$out_dir/g711a-att-$leg.pcap" "0A77CA0$ssrc"
  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$script_dir/att-$leg.wav")"
  echo "att-$leg.wav / g711a-att-$leg.pcap: ${dur}s"
done
echo "Done - pcaps written to $out_dir."
