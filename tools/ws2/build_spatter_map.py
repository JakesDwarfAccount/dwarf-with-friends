#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WS2 (WC-12): build the spatter/litter decal sprite map + growth-class table the
# browser tile renderer's decal layer needs (W-B W7 mechanism; this generator supplies
# the DATA half -- see docs/superpowers/specs/2026-07-07-WC-coverage-spec.md Chunk D).
#
# Gap this closes: `graphics_spatters.txt` binds EVERY family to the SAME token per
# page (e.g. every BLOOD_CYAN line is `TOKEN=SPATTER_BLOOD_CYAN`, only the trailing
# SHAPE param -- FULL_NSWE_A, PARTIAL_2C, etc. -- varies), so the runtime spriteMap's
# first-binding-wins parser (src/sprite_map.cpp) collapses all ~40 shape cells per
# family down to just the first one. This generator emits every (family, shape) cell
# as its own entry, keyed by shape, which the runtime parser cannot do without a grammar
# change (out of this generator's scope -- W-B/W-C boundary is the STATIC OFFLINE table,
# same convention as tiletype_token_map.json / tree_map.json / building_map.json).
#
# Verified this session (graphics_spatters.txt, tile_page_environment.txt):
#   16 family pages, each PAGE name == family name == the JSON key here:
#     BLOOD_CYAN, BLOOD_GOO, BLOOD_ICHOR, BLOOD_MAGENTA, BLOOD_RED, DUST, FRUIT,
#     FRUIT_SMALL, FRUIT_LARGE, LEAVES, MAGMA_SPATTER, MUD, SNOW, VOMIT, SLIME,
#     WATER_SPATTER.
#   Shape vocabulary (verified, all pages except the 4 litter families which are
#   PARTIAL-only): FULL_{ISOLATED,N,S,W,E,NW,NE,SW,SE,NS,WE,NSW,NSE,NWE,SWE,
#   NSWE_A..E} (20 cells) + PARTIAL_{1,2,3,4}{A,B,C,D} (16 cells) = 36 cells/family
#   for the 12 "wet/dry substance" families; FRUIT/FRUIT_SMALL/FRUIT_LARGE/LEAVES
#   are PARTIAL-only (16 cells/family, no FULL_* art -- litter never fully covers a
#   tile edge-to-edge the way liquid spatter does).
#
# What this generator does NOT do (WC-12 "Apply" -- client/GL, out of scope here,
# see the spec's own hedges):
#   - material (mat_type/mat_index) -> family classification for creature blood/
#     ichor/goo (spec: "family by the material's state-color hue... implementer
#     validates against 5+ creature mats and the parity gate arbitrates" -- a
#     runtime judgment call needing the material's resolved color, not static
#     generator data);
#   - the amount -> shape coverage thresholds ("implementer calibrates against the
#     oracle" -- also explicitly a runtime/apply decision). This generator ships
#     the spec's own suggested thresholds as documented DEFAULTS for the apply
#     implementer to start from and calibrate, not as calibrated truth.
#   - neighbor-mask FULL direction-variant selection (W-B W5 mechanism, apply-side).
#
# Run (uses the pre-installed venv, stdlib only):
#   python tools/ws2/build_spatter_map.py
#
# Reads (READ-ONLY, never writes to F:):
#   .../vanilla_environment/graphics/graphics_spatters.txt
#   .../vanilla_environment/graphics/tile_page_environment.txt
# Writes:
#   web/spatter_map.json

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
DF_ROOT = dfroot.df_root_for(__file__, sub="data/vanilla",
                          purpose="reads Dwarf Fortress's own raws as the ground truth")
ENV_GFX = os.path.join(DF_ROOT, "vanilla_environment", "graphics")
SPATTERS_FILE = "graphics_spatters.txt"
TILE_PAGE_FILE = "tile_page_environment.txt"
OUT_PATH = os.path.join(REPO, "web", "spatter_map.json")

# The 16 verified family pages (== PAGE name == JSON key). Split out because the 4
# litter families use a different (PARTIAL-only) shape vocabulary -- used only for
# the test's "expected shape count" assertion, not to filter what's parsed (the
# parser is grammar-driven, not this-list-driven, so a raws update that adds/removes
# a family is caught by the test rather than silently ignored).
WET_FAMILIES = {
    "BLOOD_CYAN", "BLOOD_GOO", "BLOOD_ICHOR", "BLOOD_MAGENTA", "BLOOD_RED",
    "DUST", "MAGMA_SPATTER", "MUD", "SNOW", "VOMIT", "SLIME", "WATER_SPATTER",
}
LITTER_FAMILIES = {"FRUIT", "FRUIT_SMALL", "FRUIT_LARGE", "LEAVES"}

# WC-11's growth_class wire values (wire_v1.h kGrowth*) -> the litter family this
# generator just parsed. 1:1, mechanical (no judgment call -- growth_class IS the
# family selector for item-spatter).
GROWTH_CLASS_FAMILY = {
    "0": "OTHER",         # no dedicated sheet; the apply side's fallback (e.g. skip/generic)
    "1": "LEAVES",
    "2": "FRUIT",
    "3": "FRUIT_SMALL",
    "4": "FRUIT_LARGE",
}

# Builtin (non-creature) material spatter families the client can resolve WITHOUT
# any per-material color lookup -- these are DF's own hardcoded builtin materials/
# states (§WC-12 wire "builtin materials by token" rule), verified against the
# family pages that exist. Keyed by a short hint string the apply side matches
# against the resolved material (builtin token or MATERIAL_REACTION_PRODUCT id, per
# their own resolution path); NOT a wire field, just a documented starting table.
BUILTIN_MATERIAL_HINTS = {
    "MUD": "MUD",
    "VOMIT": "VOMIT",
    "SALIVA": "VOMIT",         # closest builtin-family match (no dedicated saliva sheet)
    "SNOW": "SNOW",
    # water: Powder state (fresh snow accumulation) -> SNOW; Liquid state -> WATER_SPATTER.
    "WATER_LIQUID": "WATER_SPATTER",
    "WATER_POWDER": "SNOW",
    "MAGMA": "MAGMA_SPATTER",
    "LAVA": "MAGMA_SPATTER",
    "ASH": "DUST",
    "DUST": "DUST",
    "SLIME": "SLIME",
    "GOO": "SLIME",
}

# Creature blood/ichor/goo hue-family fallback set (the 5 BLOOD_* sheets) -- the
# CLASSIFICATION (which creature material maps to which hue) is explicitly deferred
# (see module docstring); this is just the closed set of valid targets.
BLOOD_FAMILIES = ["BLOOD_RED", "BLOOD_CYAN", "BLOOD_MAGENTA", "BLOOD_ICHOR", "BLOOD_GOO"]

# amount->shape coverage thresholds for the ground material-spatter decal ladder.
# B200 RECALIBRATION (2026-07-10): the original table (24/49/74/99, FULL>=100) was
# WC-12's un-calibrated placeholder ("implementer calibrates against the oracle" -- never
# done). Two defects made everything render at the FULL edge-to-edge coating cell (the
# "huge amount of blood... defaulting to the highest blood texture"):
#   (1) the client's SPATTER_VISIBLE_AMOUNT=25 gate collided with the old PARTIAL_1 band
#       (max 24), so PARTIAL_1 -- the sparsest art -- was UNREACHABLE; the visible floor
#       was PARTIAL_2 and the ladder jumped to FULL by amount 100.
#   (2) FULL was triggered at amount>=100, but 100 on DF's ground amount[16][16] uint8
#       scale is only where the descriptor word turns "pool/pile" -- NOT the full "coating"
#       graphic. Native ground captures (src/interaction.cpp::material_spatter_sentence):
#       mud amount=25 (solid) reads "A dusting of" (LIGHTEST) and gray-langur blood
#       amount=98 (liquid) reads "A smear of" (LIGHT) -- amount 98 is emphatically not a
#       coating. So FULL is reserved for near-saturation and the 4 partials spread across
#       the light->pool range, with PARTIAL_1 now reachable at amount 25-49.
# NOT-VERIFIED: the exact numeric band edges below (49/109/159/209) are a principled,
# monotonic spread anchored to the two native hover captures, NOT a per-band render-buffer
# oracle diff (a live capture, out of scope for a fixture-only worktree). Final pinning of
# each edge wants a tools/spikes/render-buffer dump of the native `spatter` texpos layer.
AMOUNT_THRESHOLDS_DEFAULT = [
    {"max": 49, "shape": "PARTIAL_1"},    # 25-49  "a dusting" (native mud@25) -- sparsest, now reachable
    {"max": 109, "shape": "PARTIAL_2"},   # 50-109 "a smear"   (native blood@98) -- light, NOT full
    {"max": 159, "shape": "PARTIAL_3"},   # 110-159
    {"max": 209, "shape": "PARTIAL_4"},   # 160-209 "a pool"
    {"max": None, "shape": "FULL"},       # 210-255 "a coating" -- FULL_* neighbor-join, near-saturation only
]


def load_tile_pages():
    """[TILE_PAGE:NAME] -> png basename (mirrors build_item_map.py::load_tile_pages)."""
    path = os.path.join(ENV_GFX, TILE_PAGE_FILE)
    pages = {}
    cur = None
    page_re = re.compile(r"\[TILE_PAGE:([A-Za-z0-9_]+)\]")
    file_re = re.compile(r"\[FILE:images[/\\]([^\]]+)\]")
    with open(path, "r", encoding="latin-1") as fh:
        for ln in fh:
            m = page_re.search(ln)
            if m:
                cur = m.group(1)
                continue
            m = file_re.search(ln)
            if m and cur is not None:
                pages[cur] = m.group(1)
                cur = None
    return pages


def load_spatter_cells():
    """Parse every [TILE_GRAPHICS:PAGE:col:row:TOKEN:SHAPE] line in
    graphics_spatters.txt -> {family: {shape: (col,row)}}. `family` is derived from
    PAGE (verified == the family name in every case); duplicate (family,shape)
    bindings keep the FIRST (none observed, but matches every other WS2 generator's
    convention)."""
    path = os.path.join(ENV_GFX, SPATTERS_FILE)
    tg = re.compile(
        r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):(SPATTER_[A-Za-z0-9_]+):"
        r"([A-Za-z0-9_]+)\]"
    )
    families = {}
    for ln in open(path, "r", encoding="latin-1"):
        m = tg.match(ln.strip())
        if not m:
            continue
        page, col, row, _token, shape = m.groups()
        fam = families.setdefault(page, {})
        if shape not in fam:
            fam[shape] = (int(col), int(row))
    return families


def main():
    pages = load_tile_pages()
    families = load_spatter_cells()

    out_families = {}
    for fam, shapes in sorted(families.items()):
        sheet = pages.get(fam)
        if not sheet:
            print("WARNING: family %s has no tile_page FILE binding" % fam, file=sys.stderr)
            continue
        out_families[fam] = {
            "sheet": sheet,
            "cells": {shape: {"col": c, "row": r} for shape, (c, r) in sorted(shapes.items())},
        }

    out = {
        "_v": 1,
        "families": out_families,
        "growth_class_family": GROWTH_CLASS_FAMILY,
        "builtin_material_hints": BUILTIN_MATERIAL_HINTS,
        "blood_families": BLOOD_FAMILIES,
        "amount_thresholds_default": AMOUNT_THRESHOLDS_DEFAULT,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)

    n_wet = sum(1 for f in out_families if f in WET_FAMILIES)
    n_litter = sum(1 for f in out_families if f in LITTER_FAMILIES)
    print("families                    : %d (%d wet + %d litter)" % (len(out_families), n_wet, n_litter))
    for fam in sorted(out_families):
        print("  %-16s %3d cells (sheet=%s)" % (fam, len(out_families[fam]["cells"]), out_families[fam]["sheet"]))
    print("wrote                       : %s" % OUT_PATH)


if __name__ == "__main__":
    main()
