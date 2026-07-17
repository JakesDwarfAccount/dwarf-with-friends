#!/usr/bin/env python
# dwf WS2 map-data pivot -- offline renderer.
#
# Reads dwf_mapdump/map.json (written by the crash-safe `capture-mapdump`
# DFHack command) and renders a simple Level-1.5 "Armok-Vision-style" tile image
# to mapdump_render.png. This proves the STABLE map-data reads reconstruct into a
# legible map -- no render-buffer scraping anywhere in the pipeline.
#
# Coloring rule (per ws2-mapdata-alternative.md sec.2, Level 1):
#   walls dark, floors by material, water blue-by-depth, magma orange/red,
#   units as dots, buildings outlined. Shape distinguishes wall/floor/ramp/stair.
#
# Run with the pre-installed Pillow env:
#   python tools/ws2/render_mapdump.py
#
# SPDX-License-Identifier: AGPL-3.0-only

import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

CELL = 12  # pixels per tile

# Material category -> base RGB (used for floors and as a fallback tint).
MAT_COLOR = {
    "STONE": (128, 128, 128),
    "SOIL": (120, 82, 48),
    "MINERAL": (150, 130, 90),
    "LAVA_STONE": (70, 60, 60),
    "FROZEN_LIQUID": (170, 200, 230),
    "CONSTRUCTION": (110, 110, 120),
    "GRASS_LIGHT": (86, 140, 62),
    "GRASS_DARK": (58, 104, 48),
    "GRASS_DRY": (150, 150, 70),
    "GRASS_DEAD": (110, 100, 70),
    "PLANT": (70, 130, 70),
    "TREE": (86, 66, 40),
    "ROOT": (96, 74, 48),
    "MUSHROOM": (150, 120, 130),
    "DRIFTWOOD": (120, 100, 70),
    "POOL": (60, 90, 150),
    "BROOK": (70, 110, 170),
    "RIVER": (55, 95, 165),
    "ASHES": (90, 90, 90),
    "MAGMA": (200, 70, 20),
    "AIR": (24, 24, 28),
    "NONE": (18, 18, 20),
}

BG = (14, 14, 16)
WALL_DARKEN = 0.45   # walls = material color darkened
UNIT_COLOR = (240, 220, 60)
BLD_OUTLINE = (230, 150, 40)


def mat_rgb(mat):
    return MAT_COLOR.get(mat, (100, 100, 100))


def darken(rgb, f):
    return tuple(int(c * f) for c in rgb)


def water_rgb(depth):
    # depth 1..7 -> lighter shallow to deep blue.
    d = max(1, min(7, depth))
    b = 90 + d * 18
    return (30, 60 + d * 6, min(255, b + 60))


def magma_rgb(depth):
    d = max(1, min(7, depth))
    return (min(255, 150 + d * 14), max(30, 90 - d * 8), 10)


def tile_color(t):
    """Resolve a tile record to a fill color."""
    tt = t.get("tt", -1)
    if tt < 0:
        return None  # null / edge -> leave background
    flow = t.get("flow", 0)
    liquid = t.get("liquid", "none")
    if flow > 0 and liquid == "magma":
        return magma_rgb(flow)
    if flow > 0 and liquid == "water":
        return water_rgb(flow)
    shape = t.get("shape", "NONE")
    mat = t.get("mat", "NONE")
    base = mat_rgb(mat)
    if shape in ("WALL", "FORTIFICATION"):
        return darken(base, WALL_DARKEN)
    if shape in ("EMPTY", "NONE"):
        return None
    # floors, ramps, stairs, boulders, pebbles, etc -> material color
    return base


def is_stair_or_ramp(shape):
    return shape in ("STAIR_UP", "STAIR_DOWN", "STAIR_UPDOWN", "RAMP", "RAMP_TOP")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="dwf_mapdump/map.json")
    ap.add_argument("--out", dest="out", default="mapdump_render.png")
    args = ap.parse_args()

    if not os.path.exists(args.inp):
        print("ERROR: %s not found (run capture-mapdump in DF first)" % args.inp)
        return 2

    with open(args.inp, "r", encoding="utf-8") as f:
        data = json.load(f)

    w = int(data["width"])
    h = int(data["height"])
    ox = int(data["origin"]["x"])
    oy = int(data["origin"]["y"])
    tiles = data.get("tiles", [])
    if len(tiles) != w * h:
        print("WARN: tile count %d != width*height %d; rendering what we have"
              % (len(tiles), w * h))

    img = Image.new("RGB", (w * CELL, h * CELL), BG)
    draw = ImageDraw.Draw(img)

    # ---- tiles (row-major, y outer / x inner -- matches the C++ writer).
    for i, t in enumerate(tiles):
        if i >= w * h:
            break
        cx = (i % w) * CELL
        cy = (i // w) * CELL
        col = tile_color(t)
        if col is None:
            continue
        draw.rectangle([cx, cy, cx + CELL - 1, cy + CELL - 1], fill=col)
        # mark stairs/ramps with an accent so vertical connectors read clearly.
        if is_stair_or_ramp(t.get("shape", "")):
            draw.line([cx, cy, cx + CELL - 1, cy + CELL - 1], fill=(220, 220, 220))
            draw.line([cx + CELL - 1, cy, cx, cy + CELL - 1], fill=(220, 220, 220))

    # ---- buildings: outline their extent (clipped to the window).
    for b in data.get("buildings", []):
        bx1 = (int(b["x1"]) - ox) * CELL
        by1 = (int(b["y1"]) - oy) * CELL
        bx2 = (int(b["x2"]) - ox + 1) * CELL - 1
        by2 = (int(b["y2"]) - oy + 1) * CELL - 1
        draw.rectangle([bx1, by1, bx2, by2], outline=BLD_OUTLINE)

    # ---- units: dots at their tile.
    r = max(2, CELL // 3)
    for u in data.get("units", []):
        ux = (int(u["x"]) - ox) * CELL + CELL // 2
        uy = (int(u["y"]) - oy) * CELL + CELL // 2
        draw.ellipse([ux - r, uy - r, ux + r, uy + r], fill=UNIT_COLOR,
                     outline=(20, 20, 20))

    img.save(args.out)
    print("wrote %s  (%dx%d tiles, %d px, %d units, %d buildings)"
          % (args.out, w, h, img.width,
             len(data.get("units", [])), len(data.get("buildings", []))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
