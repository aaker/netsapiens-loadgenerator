#!/usr/bin/env python3
"""
Create an Opus RTP PCAP file for use with SIPp play_pcap_audio.

Encodes a WAV (or any audio ffmpeg can read) to Opus at 48kHz/20ms frames,
then wraps each frame in RTP/UDP/IP/Ethernet and writes a standard PCAP file.

Usage:
    python3 create_opus_pcap.py [input.wav] [output.pcap]

Defaults:
    input  = sipp/scripts/mr.telephone.man.wav
    output = sipp/scripts/opus.pcap

SIPp replaces the destination IP/port at playback time, so the dummy
addresses in the PCAP headers don't matter.
"""

import struct
import subprocess
import sys
import tempfile
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

DEFAULT_INPUT = os.path.join(REPO_ROOT, "sipp", "scripts", "mr.telephone.man.wav")
DEFAULT_OUTPUT = os.path.join(REPO_ROOT, "sipp", "scripts", "opus.pcap")

# RTP parameters for Opus
OPUS_PT = 121          # payload type as declared in our SDP
OPUS_CLOCK = 48000     # Hz
FRAME_MS = 20          # ms per frame
SAMPLES_PER_FRAME = OPUS_CLOCK * FRAME_MS // 1000  # 960

# Dummy L2/L3 addresses (SIPp overwrites dst IP/port at send time)
ETH_DST = bytes.fromhex("002500ac6aca")
ETH_SRC = bytes.fromhex("0024c4393100")
ETH_TYPE = b"\x08\x00"  # IPv4
SRC_IP = bytes([10, 0, 0, 1])
DST_IP = bytes([10, 0, 0, 2])
SRC_PORT = 20000
DST_PORT = 20000
TTL = 58
SSRC = 0x12345678


def encode_to_ogg_opus(input_path: str, tmp_ogg: str) -> None:
    """Use ffmpeg to encode input audio to OGG/Opus at 48kHz mono, 20ms frames."""
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-acodec", "libopus",
        "-ar", "48000",
        "-ac", "1",
        "-b:a", "64k",
        "-frame_duration", str(FRAME_MS),
        "-vbr", "on",
        "-application", "audio",
        tmp_ogg,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        print("ffmpeg error:", result.stderr.decode(), file=sys.stderr)
        sys.exit(1)


def parse_ogg_opus_frames(ogg_path: str) -> list[bytes]:
    """
    Parse an OGG/Opus file and return a list of raw Opus packet payloads.
    Skips the two mandatory header pages (OpusHead, OpusTags).
    """
    with open(ogg_path, "rb") as f:
        data = f.read()

    frames = []
    offset = 0
    page_num = 0

    while offset < len(data):
        if data[offset:offset+4] != b"OggS":
            break

        # OGG page header
        # 0: capture_pattern (4)
        # 4: version (1)
        # 5: header_type (1)  0x02=first, 0x04=last, 0x01=continued
        # 6: granule_position (8 LE)
        # 14: bitstream_serial (4 LE)
        # 18: page_sequence_no (4 LE)
        # 22: checksum (4 LE)
        # 26: page_segments (1)
        # 27: segment_table (page_segments bytes)

        if offset + 27 > len(data):
            break

        header_type = data[offset + 5]
        page_segments = data[offset + 26]
        seg_table_end = offset + 27 + page_segments

        if seg_table_end > len(data):
            break

        segment_table = data[offset + 27: seg_table_end]
        body_offset = seg_table_end

        # Collect packets from this page using the segment table
        # A lace of 255 means the packet continues; <255 ends the packet
        current_packet_parts = []
        for seg_size in segment_table:
            end = body_offset + seg_size
            current_packet_parts.append(data[body_offset:end])
            body_offset = end
            if seg_size < 255:
                # End of this Opus packet
                packet = b"".join(current_packet_parts)
                current_packet_parts = []
                # Pages 0 and 1 are Opus headers — skip them
                if page_num >= 2 and len(packet) > 0:
                    frames.append(packet)

        offset = body_offset
        page_num += 1

    return frames


def ip_checksum(header: bytes) -> int:
    if len(header) % 2:
        header += b"\x00"
    s = 0
    for i in range(0, len(header), 2):
        s += (header[i] << 8) + header[i + 1]
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return ~s & 0xFFFF


def build_packet(seq: int, ts: int, opus_frame: bytes) -> bytes:
    """Build an Ethernet/IPv4/UDP/RTP packet containing an Opus frame."""
    payload_len = len(opus_frame)
    udp_len = 8 + 12 + payload_len
    ip_total = 20 + udp_len

    # RTP header: V=2 P=0 X=0 CC=0 M=0 PT=121
    rtp = struct.pack(">BBHII",
        0x80,           # V=2, P=0, X=0, CC=0
        OPUS_PT,        # M=0, PT=121
        seq & 0xFFFF,
        ts & 0xFFFFFFFF,
        SSRC,
    ) + opus_frame

    # UDP
    udp = struct.pack(">HHHH", SRC_PORT, DST_PORT, udp_len, 0) + rtp

    # IPv4 (checksum computed with zeros first)
    ip_hdr_no_cs = struct.pack(">BBHHHBBH4s4s",
        0x45, 0,        # version+IHL, DSCP+ECN
        ip_total,
        0,              # id
        0,              # flags+frag offset
        TTL, 17,        # TTL, proto=UDP
        0,              # checksum placeholder
        SRC_IP, DST_IP,
    )
    cs = ip_checksum(ip_hdr_no_cs)
    ip_hdr = ip_hdr_no_cs[:10] + struct.pack(">H", cs) + ip_hdr_no_cs[12:]

    # Ethernet
    eth = ETH_DST + ETH_SRC + ETH_TYPE

    return eth + ip_hdr + udp


def write_pcap(frames: list[bytes], output_path: str) -> None:
    """Write a PCAP file from a list of Opus frames."""
    # PCAP global header
    global_hdr = struct.pack("<IHHiIII",
        0xa1b2c3d4,  # magic
        2, 4,        # version
        0,           # thiszone
        0,           # sigfigs
        65535,       # snaplen
        1,           # network: Ethernet
    )

    ts_usec_per_frame = FRAME_MS * 1000  # 20ms = 20000 µs
    ts_sec = 0
    ts_usec = 0

    with open(output_path, "wb") as f:
        f.write(global_hdr)

        seq = 1
        rtp_ts = 0

        for frame in frames:
            pkt = build_packet(seq, rtp_ts, frame)
            pkt_hdr = struct.pack("<IIII", ts_sec, ts_usec, len(pkt), len(pkt))
            f.write(pkt_hdr + pkt)

            seq += 1
            rtp_ts += SAMPLES_PER_FRAME

            ts_usec += ts_usec_per_frame
            if ts_usec >= 1_000_000:
                ts_sec += ts_usec // 1_000_000
                ts_usec %= 1_000_000


def main():
    input_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INPUT
    output_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTPUT

    if not os.path.exists(input_path):
        print(f"Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Input:  {input_path}")
    print(f"Output: {output_path}")
    print(f"Encoding to OGG/Opus ({OPUS_CLOCK}Hz, {FRAME_MS}ms frames, VBR 64kbps)...")

    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
        tmp_ogg = tmp.name

    try:
        encode_to_ogg_opus(input_path, tmp_ogg)
        print("Parsing OGG container for raw Opus frames...")
        frames = parse_ogg_opus_frames(tmp_ogg)
        print(f"Extracted {len(frames)} Opus frames ({len(frames) * FRAME_MS / 1000:.1f}s)")
        print("Building RTP/PCAP...")
        write_pcap(frames, output_path)
        print(f"Done: {output_path} ({os.path.getsize(output_path):,} bytes)")
    finally:
        os.unlink(tmp_ogg)


if __name__ == "__main__":
    main()
