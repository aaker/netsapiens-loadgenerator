#!/usr/bin/env bash
#
# Generate time-aligned G.711 A-law RTP pcaps (and reference WAVs) with real
# speech for the SIPp load scenarios, using Deepgram Aura TTS + ffmpeg +
# wav2rtp-pcap.py.
#
# The conversation models a support call with a transfer at TRANSFER_AT (90s).
# Each leg of the call gets its own file, all starting at their own t=0:
#
#   g711a-orig.pcap   -> caller, segment 1 (talking to agent 1), exactly
#                        TRANSFER_AT long - played by the UAC on the first leg
#   g711a-orig2.pcap  -> caller, segment 2 (talking to agent 2, ~3.5 min) -
#                        played by the UAC on post-transfer legs
#   g711a-term.pcap   -> agent 1 (tier 1), exactly TRANSFER_AT long - the leg
#                        that answers the initial call (the UAS REFERs at 90s)
#   g711a-term2.pcap  -> agent 2 (specialist), ~3.5 min - the leg that
#                        answers the transferred call
#
# The term legs are also rendered as OPUS pcaps (PT 121, 20ms @ 48kHz) for the
# UAS scenarios that negotiate OPUS:
#
#   opus-term.pcap / opus-term2.pcap - same audio as the g711a term legs
#
# Tracks are aligned turn-by-turn: while one speaker talks, the other track
# carries silence, so the legs of a call reproduce the conversation with no
# talk-over. Segment 1 (caller + agent 1) is padded with silence on both the
# orig and term tracks to exactly TRANSFER_AT, so orig/term and orig2/term2
# are equal-length aligned pairs. The conversation script is documented in
# call-script.md - edit the turns array below (the authoritative copy) and
# keep the doc in sync.
#
# Requirements: bash, curl, ffmpeg, ffprobe, python3, and a Deepgram key.
# Usage:
#   DEEPGRAM_API_KEY=xxxxxxxx ./generate-call-pcaps.sh
#
# Pcaps are written to sipp/scripts/ (next to the scenarios) plus reference
# call-{orig,orig2,term,term2}.wav copies in this directory.
set -euo pipefail

# Load a local .env (DEEPGRAM_API_KEY=...) if present.
env_file="$(cd "$(dirname "$0")" && pwd)/.env"
if [ -f "$env_file" ]; then
  set -a; . "$env_file"; set +a
fi

: "${DEEPGRAM_API_KEY:?Set DEEPGRAM_API_KEY in the environment or in audio/.env}"

CALLER_VOICE="${CALLER_VOICE:-aura-orion-en}"     # Tom, the office manager
AGENT1_VOICE="${AGENT1_VOICE:-aura-asteria-en}"   # Priya, tier 1 support
AGENT2_VOICE="${AGENT2_VOICE:-aura-arcas-en}"     # Marcus, provisioning
SR=24000                                          # TTS render rate (Hz); final output is 8 kHz
GAP="${GAP:-0.45}"                                # silence between turns (both tracks), seconds
TRANSFER_AT="${TRANSFER_AT:-90}"                  # transfer point on the orig timeline, seconds

script_dir="$(cd "$(dirname "$0")" && pwd)"
out_dir="$(cd "$script_dir/.." && pwd)"           # sipp/scripts/
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Ordered conversation. Format: "SPEAKER|text" (SPEAKER = CALLER, AGENT1,
# AGENT2). The literal "TRANSFER" line marks the handoff: segment 1 is padded
# to TRANSFER_AT, agent 1's track ends, and agent 2's track begins.
turns=(
"AGENT1|Thank you for calling Meridian Voice Support, this is Priya. How can I help you today?"
"CALLER|Hi Priya, this is Tom Becker, office manager at Lakeside Dental. We hired two new front desk coordinators this week, and I need to get them set up on our phone system."
"AGENT1|I can certainly get that started, Tom. Let me verify the account first. Can you give me the main number on the account?"
"CALLER|Sure, it's six one nine, five five five, zero one four four."
"AGENT1|Thank you. And just to confirm, I'm showing the account under Lakeside Dental Group on Harbor Boulevard, is that right?"
"CALLER|That's us. We'd also like to change how the front desk queue rings, if that's possible today."
"AGENT1|Absolutely. New user setup and queue changes are handled by our provisioning team, so I'll get you over to a specialist who can do both while you're on the line."
"CALLER|Great. Will I need to repeat all my information, or do you pass that along?"
"AGENT1|I'm attaching my notes to the ticket right now, so they'll see everything. Your account, the two new hires, and the queue request."
"CALLER|Perfect, thank you."
"AGENT1|You're welcome, Tom. Stay on the line for just a moment while I transfer you to Marcus in provisioning. He'll take great care of you."
"CALLER|Sounds good, thanks Priya."
"TRANSFER"
"AGENT2|Hi, this is Marcus with provisioning. Am I speaking with Tom from Lakeside Dental?"
"CALLER|That's me. Hopefully Priya sent over the details?"
"AGENT2|She did, I have the ticket right here. Two new front desk coordinators to set up, and some changes to your reception queue. Let's start with the new users. Can you give me their names?"
"CALLER|The first is Maria Delgado, that's D E L G A D O. The second is James Whitfield, W H I T F I E L D."
"AGENT2|Got it. I see extensions one oh six and one oh seven are free, so I'll put Maria on one oh six and James on one oh seven."
"CALLER|That works. They each have a desk phone already. We pulled two spares out of the storage closet, same model as everyone else's."
"AGENT2|Even easier. Once I finish, just plug each phone into the network and power it on. It will pull its configuration automatically, and the extension number will show on the screen when it's ready."
"CALLER|Okay, that's simpler than I expected. What do they do for voicemail?"
"AGENT2|I'm setting a temporary PIN for each of them now, and they'll be prompted to change it the first time they dial in. Do you want their voicemails delivered to email as well, like the rest of your staff?"
"CALLER|Yes please. Use m delgado at lakeside dental dot com, and j whitfield at the same domain."
"AGENT2|Both are in. Now, the queue. I'm opening your reception queue, and right now it rings extensions one oh one and one oh two together, then overflows to your line after twenty seconds."
"CALLER|Right, and that's the problem. We want all four front desk extensions in there, but when every phone rings at once it gets chaotic up front."
"AGENT2|Understood. I can switch the queue from ring-all to round robin. It rings whoever has been idle the longest first, then moves to the next agent if there's no answer after fifteen seconds."
"CALLER|Round robin sounds much better. Fifteen seconds per agent is fine."
"AGENT2|Done. All four front desk extensions are in the rotation, round robin, fifteen second timeout, and the overflow to your line stays as the final step."
"CALLER|Great. One more thing, while you're in there. Our after-hours greeting is out of date, it still has our old Saturday hours."
"AGENT2|I see it, that recording is from last year. I'll flag it for a re-recording on this same ticket so it doesn't get lost."
"CALLER|Appreciate it. Our Saturday hours changed back in March, so I'll record a new greeting this week."
"AGENT2|Sounds good. Alright, everything is provisioned. Can you plug in one of the new phones now so we can do a quick live test?"
"CALLER|Give me a second. Okay, Maria's phone is booting, it says updating configuration. There we go, extension one oh six is on the screen."
"AGENT2|I can see it registered on my end too. I'm sending a test call into the queue now. It should ring the longest idle phone first."
"CALLER|It's ringing on Maria's phone right now. I'll let it time out. And there it goes, it just rolled over to the next desk. That's exactly what we wanted."
"AGENT2|Perfect, round robin is doing its job. You'll get a summary email with the new extensions, the voicemail settings, and the greeting reminder."
"CALLER|One last thing. If James's phone gives us any trouble tomorrow, do I call this same number?"
"AGENT2|Yes, same number, and reference ticket four seven two one five. Anyone on my team can pick it right up from the notes."
"CALLER|Ticket four seven two one five, got it. You've both made this really painless today. Thanks, Marcus."
"AGENT2|My pleasure, Tom. Welcome aboard to Maria and James, and thanks for calling Meridian Voice. Have a great day."
)

json_payload() { python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$1"; }

# Canonical mono PCM silence of N seconds.
silence() { ffmpeg -nostdin -v error -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=$SR" -t "$1" -c:a pcm_s16le "$2"; }

fadd() { python3 -c "print($1 + $2)"; }

orig_list="$work/orig.txt";   : > "$orig_list"
orig2_list="$work/orig2.txt"; : > "$orig2_list"
term_list="$work/term.txt";   : > "$term_list"
term2_list="$work/term2.txt"; : > "$term2_list"

elapsed=0          # running duration of the orig track, seconds
segment=1          # 1 = before transfer (agent 1), 2 = after (agent 2)
i=0
for turn in "${turns[@]}"; do
  if [ "$turn" = "TRANSFER" ]; then
    # Pad segment 1 with silence so orig and term both run exactly
    # TRANSFER_AT - matching the 90s REFER cadence of the UAS scenario.
    pad="$(python3 -c "print(max(0, $TRANSFER_AT - $elapsed))")"
    if python3 -c "exit(0 if $elapsed > $TRANSFER_AT else 1)"; then
      echo "WARNING: segment 1 runs ${elapsed}s, past the ${TRANSFER_AT}s transfer point - trim the script or raise TRANSFER_AT" >&2
    fi
    echo "[--] TRANSFER at ${TRANSFER_AT}s (segment 1 spoke ${elapsed}s, padding ${pad}s of hold silence)"
    silence "$pad" "$work/pad_transfer.wav"
    printf "file '%s'\n" "$work/pad_transfer.wav" >> "$orig_list"
    printf "file '%s'\n" "$work/pad_transfer.wav" >> "$term_list"
    segment=2
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
  idx="$(printf '%02d' "$i")"

  echo "[$idx] $speaker ($voice): ${text:0:60}..."

  # Render the turn, then normalize to canonical mono s16le for clean concat.
  curl -fsS -X POST \
    "https://api.deepgram.com/v1/speak?model=$voice&encoding=linear16&sample_rate=$SR&container=wav" \
    -H "Authorization: Token $DEEPGRAM_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(json_payload "$text")" \
    -o "$work/raw_$idx.wav"
  ffmpeg -nostdin -v error -y -i "$work/raw_$idx.wav" -ac 1 -ar "$SR" -c:a pcm_s16le "$work/clip_$idx.wav"

  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/clip_$idx.wav")"
  silence "$dur" "$work/sil_$idx.wav"
  silence "$GAP" "$work/gap_$idx.wav"

  # Each segment writes to its own orig/agent track pair (the other pair
  # doesn't exist yet / anymore, so it gets nothing).
  if [ "$segment" = 1 ]; then
    caller_list="$orig_list";  agent_list="$term_list"
  else
    caller_list="$orig2_list"; agent_list="$term2_list"
  fi

  # The speaker's track gets the clip; the other track gets equal-length silence.
  if [ "$speaker" = "CALLER" ]; then
    printf "file '%s'\n" "$work/clip_$idx.wav" >> "$caller_list"
    printf "file '%s'\n" "$work/sil_$idx.wav"  >> "$agent_list"
  else
    printf "file '%s'\n" "$work/sil_$idx.wav"  >> "$caller_list"
    printf "file '%s'\n" "$work/clip_$idx.wav" >> "$agent_list"
  fi
  # Inter-turn gap on BOTH tracks keeps them the same length and adds breathing room.
  printf "file '%s'\n" "$work/gap_$idx.wav" >> "$caller_list"
  printf "file '%s'\n" "$work/gap_$idx.wav" >> "$agent_list"

  elapsed="$(fadd "$elapsed" "$(fadd "$dur" "$GAP")")"
done

# Concatenate each track, then condition for telephony: PSTN bandpass
# (300-3400 Hz), loudness normalization, downsample to 8 kHz.
TELEPHONY_AF="highpass=f=300,lowpass=f=3400,loudnorm=I=-20:TP=-3:LRA=11"
for leg in orig orig2 term term2; do
  list_var="${leg}_list"
  ffmpeg -nostdin -v error -y -f concat -safe 0 -i "${!list_var}" -c:a pcm_s16le "$work/$leg.wav"
  # Reference WAV (8 kHz s16) for auditioning / rtp_stream use.
  ffmpeg -nostdin -v error -y -i "$work/$leg.wav" -af "$TELEPHONY_AF" -ac 1 -ar 8000 -c:a pcm_s16le "$script_dir/call-$leg.wav"
  # Raw A-law for packetization.
  ffmpeg -nostdin -v error -y -i "$script_dir/call-$leg.wav" -f alaw "$work/$leg.alaw"
done

# OPUS variants for the term legs (the UAS scenarios offer/answer OPUS PT 121).
# Encoded from the full-band 24 kHz intermediate - same rendering, so they stay
# turn-aligned with the g711a orig legs - with loudnorm but no PSTN bandpass.
for leg in term term2; do
  ffmpeg -nostdin -v error -y -i "$work/$leg.wav" -af "loudnorm=I=-20:TP=-3:LRA=11" \
    -ac 1 -ar 48000 -c:a libopus -b:a 32k -application voip -frame_duration 20 "$work/$leg.ogg"
done

# Packetize into SIPp-compatible RTP pcaps (distinct SSRC per leg).
python3 "$script_dir/wav2rtp-pcap.py"  "$work/orig.alaw"  "$out_dir/g711a-orig.pcap"  0A11CA11
python3 "$script_dir/wav2rtp-pcap.py"  "$work/orig2.alaw" "$out_dir/g711a-orig2.pcap" 0A11CA12
python3 "$script_dir/wav2rtp-pcap.py"  "$work/term.alaw"  "$out_dir/g711a-term.pcap"  0A11CA22
python3 "$script_dir/wav2rtp-pcap.py"  "$work/term2.alaw" "$out_dir/g711a-term2.pcap" 0A11CA33
python3 "$script_dir/opus2rtp-pcap.py" "$work/term.ogg"   "$out_dir/opus-term.pcap"   0B11CA22
python3 "$script_dir/opus2rtp-pcap.py" "$work/term2.ogg"  "$out_dir/opus-term2.pcap"  0B11CA33

for leg in orig orig2 term term2; do
  dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$script_dir/call-$leg.wav")"
  echo "call-$leg.wav / g711a-$leg.pcap: ~${dur%.*}s"
done
echo "Done - pcaps written to $out_dir."
