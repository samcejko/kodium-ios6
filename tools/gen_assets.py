#!/usr/bin/env python3
"""Generates Kodium's app icons and launch images for iOS 6 (run in CI, needs Pillow and rsvg-convert).

Usage: python3 tools/gen_assets.py Resources
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "Resources"
APP_NAME = "Kodium"
ICON_SVG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.svg")
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]

_R = getattr(Image, "Resampling", Image)
LANCZOS, NEAREST = _R.LANCZOS, _R.NEAREST


def font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    sys.exit("gen_assets: no TrueType font found (install fonts-dejavu-core)")


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(size, top, bottom):
    w, h = size
    col = Image.new("RGB", (1, h))
    col.putdata([lerp(top, bottom, y / max(1, h - 1)) for y in range(h)])
    return col.resize((w, h), NEAREST)


_BASE_ICON = None


def base_icon():
    """The 1024 px master icon: tools/icon.svg rendered by rsvg-convert (librsvg2-bin), once."""
    global _BASE_ICON
    if _BASE_ICON is None:
        with tempfile.TemporaryDirectory() as tmp:
            png = os.path.join(tmp, "icon.png")
            try:
                subprocess.run(["rsvg-convert", "-w", "1024", "-h", "1024", "-o", png, ICON_SVG], check=True)
            except (OSError, subprocess.CalledProcessError) as e:
                sys.exit("gen_assets: cannot render %s (install librsvg2-bin): %s" % (ICON_SVG, e))
            img = Image.open(png).convert("RGBA")
        ground = Image.new("RGBA", img.size, (255, 255, 255, 255))
        _BASE_ICON = Image.alpha_composite(ground, img).convert("RGB")
    return _BASE_ICON


def make_icon(size):
    return base_icon().resize((size, size), LANCZOS)


def make_launch(w, h):
    """The editor's dark ground with the icon and the name pressed into it (what shows while the app starts)."""
    img = vertical_gradient((w, h), (40, 40, 40), (24, 24, 24))
    d = ImageDraw.Draw(img)
    s = int(min(w, h) * 0.18)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.18), fill=255)
    cx, cy = w // 2, int(h * 0.42)
    img.paste(make_icon(s), (cx - s // 2, cy - s // 2), mask)
    fnt = font(int(min(w, h) * 0.06))
    l, t, r, b = d.textbbox((0, 0), APP_NAME, font=fnt)
    x, y = cx - (r - l) // 2 - l, cy + s // 2 + int(s * 0.25) - t
    d.text((x, y - 2), APP_NAME, font=fnt, fill=(0, 0, 0))          # the dark edge above: text pressed in
    d.text((x, y), APP_NAME, font=fnt, fill=(215, 215, 215))
    return img


ICONS = {
    "Icon.png": 57, "Icon@2x.png": 114, "Icon-72.png": 72, "Icon-72@2x.png": 144,
    "Icon-Small.png": 29, "Icon-Small@2x.png": 58, "Icon-Small-50.png": 50, "Icon-Small-50@2x.png": 100,
}

LAUNCH = {
    "Default.png": (320, 480),
    "Default@2x.png": (640, 960),
    "Default-568h@2x.png": (640, 1136),
    "Default-Portrait~ipad.png": (768, 1004),
    "Default-Portrait@2x~ipad.png": (1536, 2008),
    "Default-Landscape~ipad.png": (1024, 748),
    "Default-Landscape@2x~ipad.png": (2048, 1496),
}

for name, size in ICONS.items():
    make_icon(size).save(os.path.join(OUT, name), "PNG")
    print("icon", name)

for name, (w, h) in LAUNCH.items():
    make_launch(w, h).save(os.path.join(OUT, name), "PNG")
    print("launch", name)
