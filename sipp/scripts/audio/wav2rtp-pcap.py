#!/usr/bin/env python3
#
# wav2rtp-pcap.py - packetize raw G.711 A-law audio into a SIPp-compatible
# RTP pcap (classic libpcap format, Ethernet/IPv4/UDP/RTP, PT 8, 20ms ptime).
#
# The output matches the framing of the original g711a.pcap byte-for-byte in
# structure (214-byte frames: 14 eth + 20 ip + 8 udp + 12 rtp + 160 payload),
# so SIPp's play_pcap_audio replays it identically. SIPp rewrites the
# destination IP/port at play time, so the addresses below are cosmetic.
#
# Usage:
#   ffmpeg -i in.wav -ac 1 -ar 8000 -f alaw out.alaw
#   python3 wav2rtp-pcap.py out.alaw out.pcap [ssrc-hex]
#
import struct
import sys

ALAW_SILENCE = 0xD5          # A-law encoded 0
SAMPLES_PER_PKT = 160        # 20 ms @ 8 kHz
PTIME_US = 20000
BASE_TS_SEC = 1715000000     # fixed epoch base -> deterministic output


def build_packet(seq, rtp_ts, ssrc, marker, payload):
    rtp = struct.pack('>BBHII',
                      0x80,                          # V=2, no P/X/CC
                      (0x80 if marker else 0) | 8,   # M + PT 8 (PCMA)
                      seq & 0xFFFF,
                      rtp_ts & 0xFFFFFFFF,
                      ssrc) + payload

    udp = struct.pack('>HHHH', 6000, 6001, 8 + len(rtp), 0) + rtp

    ip_len = 20 + len(udp)
    ip = struct.pack('>BBHHHBBH4s4s',
                     0x45, 0, ip_len, seq & 0xFFFF, 0, 64, 17, 0,
                     bytes([192, 168, 8, 28]), bytes([192, 168, 8, 65]))
    # IP header checksum
    csum = 0
    for i in range(0, 20, 2):
        csum += (ip[i] << 8) | ip[i + 1]
    csum = (csum & 0xFFFF) + (csum >> 16)
    csum = (csum & 0xFFFF) + (csum >> 16)
    ip = ip[:10] + struct.pack('>H', ~csum & 0xFFFF) + ip[12:]

    eth = bytes([0x00, 0x0c, 0x29, 0xaa, 0xbb, 0x01,
                 0x00, 0x0c, 0x29, 0xaa, 0xbb, 0x02,
                 0x08, 0x00])
    return eth + ip + udp


def main():
    if len(sys.argv) < 3:
        sys.exit('usage: wav2rtp-pcap.py <in.alaw> <out.pcap> [ssrc-hex]')
    in_path, out_path = sys.argv[1], sys.argv[2]
    ssrc = int(sys.argv[3], 16) if len(sys.argv) > 3 else 0x0E330AF3

    audio = open(in_path, 'rb').read()
    if not audio:
        sys.exit(f'error: {in_path} is empty')
    # Pad final partial frame with A-law silence
    rem = len(audio) % SAMPLES_PER_PKT
    if rem:
        audio += bytes([ALAW_SILENCE]) * (SAMPLES_PER_PKT - rem)

    npkts = len(audio) // SAMPLES_PER_PKT
    with open(out_path, 'wb') as out:
        # classic pcap global header: magic, v2.4, tz 0, sigfigs 0, snaplen, linktype 1
        out.write(struct.pack('<IHHiII I', 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        for i in range(npkts):
            payload = audio[i * SAMPLES_PER_PKT:(i + 1) * SAMPLES_PER_PKT]
            pkt = build_packet(seq=1000 + i,
                               rtp_ts=160 + i * SAMPLES_PER_PKT,
                               ssrc=ssrc,
                               marker=(i == 0),
                               payload=payload)
            ts_us = i * PTIME_US
            out.write(struct.pack('<IIII',
                                  BASE_TS_SEC + ts_us // 1000000,
                                  ts_us % 1000000,
                                  len(pkt), len(pkt)))
            out.write(pkt)

    print(f'{out_path}: {npkts} packets, {npkts * 0.02:.1f}s, ssrc=0x{ssrc:08X}')


if __name__ == '__main__':
    main()
