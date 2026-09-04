#!/usr/bin/env python3
#
# wav2rtp-pcap.py - packetize raw G.711 audio into a SIPp-compatible RTP pcap
# (classic libpcap format, Ethernet/IPv4/UDP/RTP, 20ms ptime).  A-law (PT 8)
# by default, mu-law (PT 0) with --codec ulaw.
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
#   ffmpeg -i in.wav -ac 1 -ar 8000 -f mulaw out.ulaw
#   python3 wav2rtp-pcap.py --codec ulaw out.ulaw out.pcap [ssrc-hex]
#
import struct
import sys

# codec -> (RTP payload type, encoded silence byte)
CODECS = {'alaw': (8, 0xD5), 'ulaw': (0, 0xFF)}
SAMPLES_PER_PKT = 160        # 20 ms @ 8 kHz
PTIME_US = 20000
BASE_TS_SEC = 1715000000     # fixed epoch base -> deterministic output


def build_packet(seq, rtp_ts, ssrc, marker, payload, pt):
    rtp = struct.pack('>BBHII',
                      0x80,                          # V=2, no P/X/CC
                      (0x80 if marker else 0) | pt,   # M + payload type
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
    argv = sys.argv[1:]
    codec = 'alaw'
    if argv and argv[0] == '--codec':
        if len(argv) < 2 or argv[1] not in CODECS:
            sys.exit('error: --codec takes one of: ' + ', '.join(CODECS))
        codec, argv = argv[1], argv[2:]
    if len(argv) < 2:
        sys.exit('usage: wav2rtp-pcap.py [--codec alaw|ulaw] <in.g711> <out.pcap> [ssrc-hex]')
    in_path, out_path = argv[0], argv[1]
    ssrc = int(argv[2], 16) if len(argv) > 2 else 0x0E330AF3
    pt, silence = CODECS[codec]

    audio = open(in_path, 'rb').read()
    if not audio:
        sys.exit(f'error: {in_path} is empty')
    # Pad final partial frame with encoded silence
    rem = len(audio) % SAMPLES_PER_PKT
    if rem:
        audio += bytes([silence]) * (SAMPLES_PER_PKT - rem)

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
                               payload=payload,
                               pt=pt)
            ts_us = i * PTIME_US
            out.write(struct.pack('<IIII',
                                  BASE_TS_SEC + ts_us // 1000000,
                                  ts_us % 1000000,
                                  len(pkt), len(pkt)))
            out.write(pkt)

    print(f'{out_path}: {npkts} packets, {npkts * 0.02:.1f}s, '
          f'{codec} pt={pt}, ssrc=0x{ssrc:08X}')


if __name__ == '__main__':
    main()
