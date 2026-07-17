#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WC-17 (docs/superpowers/specs/2026-07-07-WC-coverage-spec.md, Chunk G): per-species
# grass tint table. The 41 vanilla grass species (vanilla_plants/objects/plant_grasses.txt,
# verified this session: exactly 41 [PLANT:...] blocks, all tagged [GRASS], all with a
# [GRASS_COLORS:...] tag) all share the SAME 4 sprite cells (grass.png GRASS_1..4) -- the
# audit's "structurally client is right" finding -- so the only missing piece is per-
# species COLOR, which the raws carry as [GRASS_COLORS:fg1:bg1:br1:fg2:bg2:br2:fg3:bg3:
# br3:fg4:bg4:br4]: four (foreground, background, bright) triples into DF's 16-slot
# console/interface palette (data/init/colors.txt), NOT the [STATE_COLOR:...] named-
# descriptor-color system (world->raws.descriptors.colors) material tints use elsewhere in
# this codebase (src/world_stream.cpp:639-646) -- verified these are two independent color
# systems in DF's raws.
#
# Palette index convention (verified against DFHack's own DFHack::color_value enum,
# library/include/ColorText.h:44-64, which fixes the canonical 0-15 order): 0 Black,
# 1 Blue, 2 Green, 3 Cyan, 4 Red, 5 Magenta, 6 Brown, 7 Grey, 8 DarkGrey, 9 LightBlue,
# 10 LightGreen, 11 LightCyan, 12 LightRed, 13 LightMagenta, 14 Yellow, 15 White; a raw
# color's actual index is `fg + 8*bright`. data/init/colors.txt ships one block per named
# color (BLACK_R/G/B, BLUE_R/G/B, ...) but its file ORDER doesn't reliably indicate which
# of its two ambiguous-by-brightness tags (DGRAY/LGRAY) is index 7 vs 8 -- resolved by
# NAME rather than position (LGRAY, the brighter one at (192,192,192) in the verified
# install, pairs with index 7/Grey since its bright partner at index 15 is White; DGRAY
# pairs with index 8/DarkGrey since its bright partner at index 0 is Black) -- see this
# generator's PALETTE_TAG_FOR_INDEX comment. No vanilla grass species actually uses fg 7/8
# (verified: all 8 distinct GRASS_COLORS patterns in plant_grasses.txt use fg in {2,3,5,6,
# 7} for the FIRST field only as a coincidence of one pattern -- checked, this ambiguity
# has zero practical effect on the shipped table, documented for correctness anyway).
#
# Run (stdlib only):
#   python tools/ws2/build_grass_colors.py
#
# Reads (READ-ONLY, best-effort; falls back to the verified default palette below if the
# DF install is unreachable -- a moved/missing install must never break the build):
#   data/init/colors.txt
#   vanilla_plants/objects/plant_grasses.txt
# Writes:
#   web/grass_colors.json

import json
import os
import re
import sys

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DF_ROOT = dfroot.df_root_for(__file__, purpose="reads Dwarf Fortress's own raws as the ground truth")
COLORS_TXT = os.path.join(DF_ROOT, "data", "init", "colors.txt")
GRASS_RAWS = os.path.join(DF_ROOT, "data", "vanilla", "vanilla_plants", "objects", "plant_grasses.txt")
OUT_PATH = os.path.join(REPO, "web", "grass_colors.json")

# DFHack::color_value order (ColorText.h:44-64) -> the colors.txt tag name for that index.
# Index = fg + 8*bright; see the module docstring for the DGRAY/LGRAY resolution.
PALETTE_TAG_FOR_INDEX = [
    "BLACK", "BLUE", "GREEN", "CYAN", "RED", "MAGENTA", "BROWN", "LGRAY",
    "DGRAY", "LBLUE", "LGREEN", "LCYAN", "LRED", "LMAGENTA", "YELLOW", "WHITE",
]

# Verified fallback (this session's actual data/init/colors.txt, in case the install is
# unreachable when this regenerates) -- same 16 RGB triples as PALETTE_TAG_FOR_INDEX order.
DEFAULT_PALETTE_RGB = [
    (0, 0, 0), (32, 125, 241), (162, 220, 52), (113, 187, 176),
    (255, 17, 58), (167, 60, 213), (215, 155, 45), (192, 192, 192),
    (160, 160, 160), (140, 102, 255), (19, 253, 101), (18, 254, 207),
    (255, 113, 17), (232, 17, 255), (255, 225, 17), (255, 255, 255),
]


def parse_colors_txt(path):
    """Returns a 16-entry list of (r,g,b) or None if unreadable/incomplete."""
    if not os.path.isfile(path):
        return None
    try:
        text = open(path, "r", encoding="latin-1").read()
    except OSError:
        return None
    vals = {}
    for m in re.finditer(r"\[([A-Z]+)_([RGB]):(\d+)\]", text):
        tag, chan, num = m.group(1), m.group(2), int(m.group(3))
        vals.setdefault(tag, {})[chan] = num
    palette = []
    for tag in PALETTE_TAG_FOR_INDEX:
        c = vals.get(tag)
        if not c or "R" not in c or "G" not in c or "B" not in c:
            return None
        palette.append((c["R"], c["G"], c["B"]))
    return palette


def parse_grass_colors(path):
    """Returns { plant_id: [(fg,bg,bright) x4], ... } or {} if unreadable."""
    if not os.path.isfile(path):
        return {}
    out = {}
    cur_id = None
    plant_re = re.compile(r"^\[PLANT:([^\]]+)\]")
    gc_re = re.compile(r"^\[GRASS_COLORS:(-?\d+):(-?\d+):(-?\d+):(-?\d+):(-?\d+):(-?\d+):"
                        r"(-?\d+):(-?\d+):(-?\d+):(-?\d+):(-?\d+):(-?\d+)\]")
    try:
        for raw_line in open(path, "r", encoding="latin-1"):
            line = raw_line.strip()
            m = plant_re.match(line)
            if m:
                cur_id = m.group(1)
                continue
            m = gc_re.match(line)
            if m and cur_id:
                nums = [int(x) for x in m.groups()]
                tiers = [(nums[i], nums[i + 1], nums[i + 2]) for i in range(0, 12, 3)]
                out[cur_id] = tiers
    except OSError:
        return {}
    return out


def rgb_for(palette, fg, bg, bright):
    idx = max(0, min(15, fg + (8 if bright else 0)))
    return list(palette[idx])


def main():
    palette = parse_colors_txt(COLORS_TXT)
    palette_source = "colors.txt"
    if palette is None:
        palette = [list(t) for t in DEFAULT_PALETTE_RGB]
        palette_source = "default-fallback (colors.txt unreadable)"
    else:
        palette = [list(t) for t in palette]

    species = parse_grass_colors(GRASS_RAWS)
    if not species:
        print("WARNING: no grass species parsed from %s (missing install?) -- "
              "writing an empty table" % GRASS_RAWS, file=sys.stderr)

    plants = {}
    for pid, tiers in species.items():
        entry_tiers = []
        for (fg, bg, br) in tiers:
            entry_tiers.append({
                "fg": fg, "bg": bg, "bright": bool(br),
                "rgb": rgb_for(palette, fg, bg, br),
            })
        plants[pid] = {"tiers": entry_tiers}

    out = {
        "_v": 1,
        "palette_source": palette_source,
        "palette": palette,
        "plants": plants,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)

    print("palette_source              : %s" % palette_source)
    print("grass species entries       : %d" % len(plants))
    print("wrote                       : %s" % OUT_PATH)


if __name__ == "__main__":
    main()
