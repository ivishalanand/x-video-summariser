"""Run once to create extension icons: python3 generate_icons.py
Requires rsvg-convert (brew install librsvg) — falls back to solid-orange PNG."""
import os, subprocess, struct, zlib, tempfile, shutil

# ── SVG source ───────────────────────────────────────────────────────────────
# Full-detail version used for 48 and 128px renders.
SVG_MAIN = """\
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <rect width="128" height="128" rx="26" fill="#0f0f0f"/>
  <rect width="128" height="128" rx="26" fill="none" stroke="#2a2a2a" stroke-width="1.5"/>
  <path d="M 72 12 L 32 70 L 58 70 L 42 118 L 100 58 L 72 58 Z" fill="#f5a623"/>
  <path d="M 72 12 L 58 40 L 72 40 Z" fill="#ffc84a" opacity="0.45"/>
</svg>"""

# Simplified version for 16px — bolder bolt, no fine details.
SVG_SMALL = """\
<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <rect width="16" height="16" rx="3" fill="#0f0f0f"/>
  <path d="M 9 1 L 4 9 L 7 9 L 5 15 L 13 7 L 9 7 Z" fill="#f5a623"/>
</svg>"""


def _rsvg(svg_text, out_path, size):
    with tempfile.NamedTemporaryFile(suffix='.svg', mode='w', delete=False) as f:
        f.write(svg_text)
        tmp = f.name
    try:
        subprocess.run(
            ['rsvg-convert', '--width', str(size), '--height', str(size), tmp, '-o', out_path],
            check=True, capture_output=True,
        )
    finally:
        os.unlink(tmp)


def _fallback_png(path, size, rgb=(245, 166, 35)):
    r, g, b = rgb
    raw = b''.join(bytes([0]) + bytes([r, g, b] * size) for _ in range(size))
    compressed = zlib.compress(raw, 9)

    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)))
        f.write(chunk(b'IDAT', compressed))
        f.write(chunk(b'IEND', b''))


os.makedirs('icons', exist_ok=True)

rsvg = shutil.which('rsvg-convert')

for size in [16, 48, 128]:
    path = f'icons/icon{size}.png'
    if rsvg:
        svg = SVG_SMALL if size == 16 else SVG_MAIN
        _rsvg(svg, path, size)
        print(f'  {path}  (rsvg-convert)')
    else:
        _fallback_png(path, size)
        print(f'  {path}  (fallback — install librsvg for the real design)')

print('done')
