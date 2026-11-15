#!/usr/bin/env python3
"""Builds the cover images (SVG sources and PNGs) in this folder. Needs rsvg-convert.

    python3 assets/social/make.py
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

# The content is drawn in a 1200x520 box and scaled to fit the canvas.
BOX_W, BOX_H = 1200, 520

CARD = [
    ("## Todo", "h"),
    ("- [ ] T1 Show types on hover", ""),
    ("", ""),
    ("## Doing", "h"),
    ("- [ ] T2 Review the diff  @impl", ""),
    ("", ""),
    ("## Done", "h"),
    ("- [x] T3 Add the logo", "d"),
]


def svg(w: int, h: int) -> str:
    s = min(w / BOX_W, h / BOX_H) * 0.92
    tx, ty = (w - BOX_W * s) / 2, (h - BOX_H * s) / 2
    lines = []
    y = 74
    for text, kind in CARD:
        if text:
            fill = {"h": "#f2b92c", "d": "#7f93a8"}.get(kind, "#e2e8f0")
            text = text.replace("&", "&amp;").replace("@", "@")
            lines.append(f'<text x="44" y="{y}" fill="{fill}">{text}</text>')
        y += 38
    card = "\n      ".join(lines)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <rect width="{w}" height="{h}" fill="#0f172a"/>
  <g transform="translate({tx:.1f} {ty:.1f}) scale({s:.4f})" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
    <g transform="translate(20 70) scale(0.62) translate(-90 -93)">
      <path d="M122 330 V130 L232 246 L342 130 V392 M290 340 L342 392 L394 340" fill="none" stroke="#5fd0e6" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    <text x="250" y="190" font-size="132" font-weight="700" fill="#f8fafc" letter-spacing="-3">Marq</text>
    <text x="20" y="330" font-size="44" font-weight="600" fill="#f8fafc">Run agents. Keep everything.</text>
    <text x="20" y="392" font-size="27" fill="#94a3b8">A Markdown knowledge base and an IDE</text>
    <text x="20" y="428" font-size="27" fill="#94a3b8">for coding agents, in one app.</text>
    <g transform="translate(720 30)">
      <rect width="460" height="420" rx="20" fill="#0b1220" stroke="#334155" stroke-width="2"/>
      <circle cx="34" cy="30" r="7" fill="#475569"/><circle cx="58" cy="30" r="7" fill="#475569"/><circle cx="82" cy="30" r="7" fill="#475569"/>
      <g font-family="Menlo, Monaco, monospace" font-size="22" transform="translate(0 30)">
      {card}
      </g>
    </g>
  </g>
</svg>
'''


for name, w, h in SIZES:
    path = HERE / f"{name}.svg"
    path.write_text(svg(w, h))
    subprocess.run(["rsvg-convert", str(path), "-o", str(HERE / f"{name}.png")], check=True)
    print(name, w, h)
