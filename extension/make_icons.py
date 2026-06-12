#!/usr/bin/env python3
"""Generate solid-color square PNG icons for the extension (no dependencies)."""
import struct, zlib, os

def make_png(size, rgb):
    r, g, b = rgb
    raw = bytearray()
    for _y in range(size):
        raw.append(0)  # filter type 0 per scanline
        for _x in range(size):
            raw += bytes((r, g, b))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

os.makedirs("icons", exist_ok=True)
for s in (16, 48, 128):
    with open(f"icons/icon{s}.png", "wb") as f:
        f.write(make_png(s, (109, 94, 252)))  # #6d5efc
    print(f"wrote icons/icon{s}.png")
