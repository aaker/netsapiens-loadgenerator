#!/usr/bin/env python3
#
# opus2rtp-pcap.py - packetize an Ogg Opus file into a SIPp-compatible RTP
# pcap (classic libpcap format, Ethernet/IPv4/UDP/RTP, PT 121, 48 kHz clock).
#
# The output matches the framing of the original opus.pcap / sip-rtp-opus-121
# files (PT 121, ts += 960 per 20ms frame, single SSRC). Each Ogg packet
# (one 20ms opus frame when encoded with -frame_duration 20) becomes one RTP
# packet. SIPp rewrites the destination IP/port at play time.
#
# Usage:
#   ffmpeg -i in.wav -ac 1 -ar 48000 -c:a libopus -b:a 32k \
#          -application voip -frame_duration 20 out.ogg
#   python3 opus2rtp-pcap.py out.ogg out.pcap [ssrc-hex]
#
import struct
import sys

SAMPLES_PER_PKT = 960        # 20 ms @ 48 kHz RTP clock
PTIME_US = 20000
PAYLOAD_TYPE = 121
BASE_TS_SEC = 1715000000     # fixed epoch base -> deterministic output


def ogg_packets(data):
    """Yield logical packets from an Ogg stream (reassembling across pages)."""
    pos = 0
    pending = b''
    while pos < len(data):
        if data[pos:pos + 4] != b'OggS':
            sys.exit(f'error: bad Ogg page marker at offset {pos}')
        nsegs = data[pos + 26]
        lacing = data[pos + 27:pos + 27 + nsegs]
        body = pos + 27 + nsegs
        for lace in lacing:
            pending += data[body:body + lace]
            body += lace
            if lace < 255:
                yield pending
                pending = b''
        pos = body
    if pending:
        yield pending


def build_packet(seq, rtp_ts, ssrc, marker, payload):
    rtp = struct.pack('>BBHII',
                      0x80,                                     # V=2, no P/X/CC
                      (0x80 if marker else 0) | PAYLOAD_TYPE,   # M + PT
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
        sys.exit('usage: opus2rtp-pcap.py <in.ogg> <out.pcap> [ssrc-hex]')
    in_path, out_path = sys.argv[1], sys.argv[2]
    ssrc = int(sys.argv[3], 16) if len(sys.argv) > 3 else 0x0E330AF4

    packets = list(ogg_packets(open(in_path, 'rb').read()))
    # First two Ogg packets are the OpusHead and OpusTags headers, not audio.
    if len(packets) < 3 or not packets[0].startswith(b'OpusHead'):
        sys.exit(f'error: {in_path} does not look like an Ogg Opus file')
    frames = packets[2:]

    with open(out_path, 'wb') as out:
        # classic pcap global header: magic, v2.4, tz 0, sigfigs 0, snaplen, linktype 1
        out.write(struct.pack('<IHHiII I', 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        for i, frame in enumerate(frames):
            pkt = build_packet(seq=1000 + i,
                               rtp_ts=960 + i * SAMPLES_PER_PKT,
                               ssrc=ssrc,
                               marker=(i == 0),
                               payload=frame)
            ts_us = i * PTIME_US
            out.write(struct.pack('<IIII',
                                  BASE_TS_SEC + ts_us // 1000000,
                                  ts_us % 1000000,
                                  len(pkt), len(pkt)))
            out.write(pkt)

    sizes = [len(f) for f in frames]
    print(f'{out_path}: {len(frames)} packets, {len(frames) * 0.02:.1f}s, '
          f'payload min/avg/max={min(sizes)}/{sum(sizes) // len(sizes)}/{max(sizes)}, '
          f'ssrc=0x{ssrc:08X}')


if __name__ == '__main__':
    main()
