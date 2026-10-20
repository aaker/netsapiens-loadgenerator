#!/usr/bin/env python3
#
# generate-flow-pcaps.py - render a scripted multi-party call into
# time-aligned G.711 A-law RTP pcaps (and reference WAVs) for the SIPp
# manual-test flows, from a JSON spec in audio/flows/.
#
# Same pipeline as generate-call-pcaps.sh: Deepgram Aura TTS (or the macOS
# `say` voices with --tts say) -> ffmpeg -> wav2rtp-pcap.py.
#
# A spec is a list of sections. Each section names its tracks (one per
# speaker in it) and is padded with silence to a fixed length, which the
# scenarios use as their timers. While one speaker talks, every other track in
# the section carries silence, so playing a section's tracks together
# reproduces the conversation with no talk-over. A track can start late
# ("offsets": a party that joins N seconds into the section): its first N
# seconds are cut, and the script must keep that party silent until then.
#
# Spec format (see audio/flows/*.json):
#   {
#     "name": "blind2",
#     "voices": {"CALLER": "aura-orion-en", ...},       # Deepgram models
#     "say_voices": {"CALLER": "Ralph", ...},           # macOS voices
#     "sections": [
#       {"length": 44, "tracks": {"CALLER": "g711a-b2-orig1", "AGENT1": "g711a-b2-term1"}},
#       {"length": 70, "tracks": {...}, "offsets": {"AGENT2": 5}}
#     ],
#     "turns": [["AGENT1", "text"], ["CALLER", "text"], ["PAUSE", 6], ["SECTION"], ...],
#     "agents": {...}                                   # see gen-agent-scenario.py
#   }
# "SECTION" ends the current section and starts the next. ["PAUSE", n] is n
# seconds of dead air on every track (an awkward silence, someone typing).
#
# Usage:
#   ./generate-flow-pcaps.py flows/blind2.json            # DEEPGRAM_API_KEY from env or audio/.env
#   ./generate-flow-pcaps.py --tts say flows/blind2.json  # placeholder audio, macOS only
#
# Pcaps are written to sipp/scripts/pcaps/<track>.pcap and reference WAVs to
# audio/<track>.wav (8 kHz s16, telephony bandpassed).

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zlib

SR = 24000        # TTS render rate (Hz); final output is 8 kHz
GAP = 0.45        # silence between turns (all tracks), seconds
TELEPHONY_AF = "highpass=f=300,lowpass=f=3400,loudnorm=I=-20:TP=-3:LRA=11"

AUDIO_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.dirname(AUDIO_DIR)


def run(*cmd):
    subprocess.run(cmd, check=True)


def ffmpeg(*args):
    run("ffmpeg", "-nostdin", "-v", "error", "-y", *args)


def duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True).stdout
    return float(out.strip())


def silence(seconds, path):
    ffmpeg("-f", "lavfi", "-i", f"anullsrc=channel_layout=mono:sample_rate={SR}",
           "-t", f"{max(seconds, 0):.6f}", "-c:a", "pcm_s16le", path)


def load_deepgram_key():
    key = os.environ.get("DEEPGRAM_API_KEY")
    env_file = os.path.join(AUDIO_DIR, ".env")
    if not key and os.path.exists(env_file):
        for line in open(env_file):
            if line.strip().startswith("DEEPGRAM_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("Set DEEPGRAM_API_KEY in the environment or in audio/.env (or use --tts say)")
    return key


def render(tts, voice, text, raw, key):
    if tts == "say":
        run("say", "-v", voice, "-o", raw, text)
        return
    req = urllib.request.Request(
        f"https://api.deepgram.com/v1/speak?model={voice}&encoding=linear16&sample_rate={SR}&container=wav",
        data=json.dumps({"text": text}).encode(),
        headers={"Authorization": f"Token {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp, open(raw, "wb") as f:
        f.write(resp.read())


def main():
    ap = argparse.ArgumentParser(description="Render a scripted call spec into aligned RTP pcaps")
    ap.add_argument("spec")
    ap.add_argument("--tts", choices=["deepgram", "say"], default="deepgram")
    args = ap.parse_args()

    spec = json.load(open(args.spec))
    voices = spec["say_voices"] if args.tts == "say" else spec["voices"]
    key = load_deepgram_key() if args.tts == "deepgram" else None
    sections = spec["sections"]

    work = tempfile.mkdtemp()
    try:
        # Per section: track name -> list of clip paths, and the running length.
        lists = [{t: [] for t in s["tracks"].values()} for s in sections]
        spoke_at = [{} for _ in sections]   # first speech time per speaker per section
        sec, elapsed, i = 0, 0.0, 0

        def close_section():
            s = sections[sec]
            pad = s["length"] - elapsed
            name = f"section {sec + 1}"
            if pad < 0:
                print(f"WARNING: {name} runs {elapsed:.1f}s, past its {s['length']}s length - "
                      "trim the script or raise the length", file=sys.stderr)
            print(f"[--] {name}: spoke {elapsed:.1f}s, padding {max(pad, 0):.1f}s to {s['length']}s")
            path = os.path.join(work, f"pad_{sec}.wav")
            silence(pad, path)
            for t in lists[sec]:
                lists[sec][t].append(path)
            for who, off in s.get("offsets", {}).items():
                first = spoke_at[sec].get(who)
                if first is not None and first < off:
                    print(f"WARNING: {who} speaks at {first:.1f}s in {name}, before joining at {off}s",
                          file=sys.stderr)

        for turn in spec["turns"]:
            if turn[0] == "SECTION":
                close_section()
                sec, elapsed = sec + 1, 0.0
                continue
            if turn[0] == "PAUSE":
                # Dead air on every track of the section (nobody speaks).
                i += 1
                print(f"[{i:02d}] PAUSE {turn[1]}s")
                pause = os.path.join(work, f"pause_{i}.wav")
                silence(turn[1], pause)
                for t in lists[sec]:
                    lists[sec][t].append(pause)
                elapsed += turn[1]
                continue
            who, text = turn
            tracks = sections[sec]["tracks"]
            if who not in tracks:
                sys.exit(f"ERROR: {who} does not speak in section {sec + 1}")
            i += 1
            print(f"[{i:02d}] {who} ({voices[who]}): {text[:60]}...")
            raw = os.path.join(work, f"raw_{i}" + (".aiff" if args.tts == "say" else ".wav"))
            render(args.tts, voices[who], text, raw, key)
            clip = os.path.join(work, f"clip_{i}.wav")
            ffmpeg("-i", raw, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", clip)
            dur = duration(clip)
            sil = os.path.join(work, f"sil_{i}.wav")
            gap = os.path.join(work, f"gap_{i}.wav")
            silence(dur, sil)
            silence(GAP, gap)
            spoke_at[sec].setdefault(who, elapsed)
            for speaker, t in tracks.items():
                lists[sec][t] += [clip if speaker == who else sil, gap]
            elapsed += dur + GAP
        close_section()

        for s, tracks in zip(sections, lists):
            offsets = {s["tracks"][who]: off for who, off in s.get("offsets", {}).items()}
            for t, clips in tracks.items():
                listfile = os.path.join(work, f"{t}.txt")
                with open(listfile, "w") as f:
                    f.writelines(f"file '{c}'\n" for c in clips)
                full = os.path.join(work, f"{t}.wav")
                ffmpeg("-f", "concat", "-safe", "0", "-i", listfile, "-c:a", "pcm_s16le", full)
                wav = os.path.join(AUDIO_DIR, f"{t}.wav")
                ffmpeg("-ss", str(offsets.get(t, 0)), "-i", full, "-af", TELEPHONY_AF,
                       "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", wav)
                alaw = os.path.join(work, f"{t}.alaw")
                ffmpeg("-i", wav, "-f", "alaw", alaw)
                ssrc = f"0A{zlib.crc32(t.encode()) & 0xFFFFFF:06X}"
                run(sys.executable, os.path.join(AUDIO_DIR, "wav2rtp-pcap.py"), alaw,
                    os.path.join(SCRIPTS_DIR, "pcaps", f"{t}.pcap"), ssrc)
                print(f"{t}.wav / {t}.pcap: {duration(wav):.1f}s")
    finally:
        shutil.rmtree(work)
    print(f"Done - pcaps written to {os.path.join(SCRIPTS_DIR, 'pcaps')}.")


if __name__ == "__main__":
    main()
