#!/usr/bin/env python3
"""Builds the cover image (SVG source and PNG) in this folder. Needs rsvg-convert.

    python3 assets/social/make.py

The image is the logo, the tagline and a real screenshot of the app that bleeds off
the bottom edge. screenshot.jpg is a frame of site/assets/demo.mp4 (1440 wide).
"""
import pathlib
import subprocess

HERE = pathlib.Path(__file__).parent

# name, width, height
SIZES = [
    # One image for everything: Open Graph / Twitter card, the dev.to cover_image
    # and the GitHub repository social preview.
    ("og", 1200, 630),
]

SHOT_W = 1072  # on-screen width of the screenshot
SHOT_SRC = (1440, 600)  # size of screenshot.jpg


def svg(w: int, h: int) -> str:
    shot_x = (w - SHOT_W) // 2
    shot_y = 288
    shot_h = round(SHOT_W * SHOT_SRC[1] / SHOT_SRC[0])
    return f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <defs>
    <clipPath id="shot"><rect x="{shot_x}" y="{shot_y}" width="{SHOT_W}" height="{shot_h + 40}" rx="12"/></clipPath>
  </defs>
  <rect width="{w}" height="{h}" fill="#0f172a"/>
  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
    <g transform="translate({shot_x} 38) scale(0.30) translate(-90 -93)">
      <path d="M122 330 V130 L232 246 L342 130 V392 M290 340 L342 392 L394 340" fill="none" stroke="#5fd0e6" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    <text x="{shot_x + 110}" y="118" font-size="92" font-weight="700" fill="#f8fafc" letter-spacing="-2.5">Marq</text>
    <text x="{shot_x}" y="190" font-size="38" font-weight="600" fill="#f8fafc">Run agents. Keep everything.</text>
    <text x="{shot_x}" y="234" font-size="22" fill="#94a3b8">A Markdown knowledge base and an IDE for coding agents, in one app.</text>
  </g>
  <rect x="{shot_x - 1}" y="{shot_y - 1}" width="{SHOT_W + 2}" height="{shot_h + 42}" rx="13" fill="none" stroke="#3d4a5c" stroke-width="2"/>
  <image href="screenshot.jpg" xlink:href="screenshot.jpg" x="{shot_x}" y="{shot_y}" width="{SHOT_W}" height="{shot_h}" clip-path="url(#shot)"/>
</svg>
'''


for name, w, h in SIZES:
    path = HERE / f"{name}.svg"
    path.write_text(svg(w, h))
    subprocess.run(["rsvg-convert", str(path), "-o", str(HERE / f"{name}.png")], check=True)
    print(name, w, h)
