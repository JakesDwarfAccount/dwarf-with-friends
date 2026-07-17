#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WS2: build the building/workshop -> sprite map the browser tile renderer
# needs to draw premium building graphics instead of ASCII glyphs.
#
# THE PROBLEM this solves: the wire gives a building as
#   {type, subtype, stage, x1,y1,x2,y2}
# Many workshops/buildings are MULTI-TILE (e.g. a 3x3 carpenter's shop, a 5x5
# trade depot) with a different sprite cell per sub-tile of the footprint.
# DF's own vanilla building graphics raws key sprites off a raw building
# token (e.g. WORKSHOP_CARPENTER, TRADE_DEPOT), not off the wire's
# type/subtype strings directly, so this script also emits DFHack-style
# "Type:Subtype" aliases for the common cases.
#
# TOKEN FORMAT (read from
#   .../vanilla_buildings_graphics/graphics/graphics_workshops.txt
#   .../vanilla_buildings_graphics/graphics/graphics_buildings.txt ):
#   [TILE_GRAPHICS:<TILE_PAGE>:<page_col>:<page_row>:<TOKEN>:<params...>]
# TILE_PAGE resolves to a PNG sheet via tile_page_buildings.txt:
#   [TILE_PAGE:<name>] [FILE:images/<sheet>.png] [TILE_DIM:32:32] [PAGE_DIM...]
#
# For multi-tile buildings, <params...> is (variantN...,col,row) where col/row
# are the building's own local footprint coordinates and row==0 is a reserved
# "overhang" cell (something sticking up above the shop, per the raw file's
# own comment) -- NOT part of the footprint. So footprint rows are 1..max_row
# (mapped to grid row max_row-1..0) and footprint cols are 0..max_col. This
# was verified against known building sizes: WORKSHOP_CARPENTER's params span
# col 0-2, row 0-3 => width=3, height=3 (matches its real 3x3 footprint,
# dropping the row-0 overhang); TRADE_DEPOT spans col 0-4, row 0-5 => 5x5
# (matches its real 5x5 footprint). Multiple TOKEN blocks repeat with
# different leading "variant" digits (purely cosmetic random-looking
# variants DF itself picks per-building) -- we deterministically pick the
# all-zero variant if present, else the lexicographically smallest, since any
# valid variant is an equally correct depiction for our renderer.
#
# For 1-tile buildings (WORKSHOPS_1x1 sheet: millstone, quern, screw press)
# <params...> is (variant, stage) or (variant, col, stage); stage 0 is
# frequently "the zero stage is made in-game if not provided" per the raw's
# own comment (i.e. an unbuilt placeholder), so we prefer stage>=1 when
# present. Building tokens with NO params at all (single decorative items
# like BLD_CHAIN_METAL) just use their one sprite cell directly.
#
# Tokens ending in _OVERLAY are skipped (decorative overlays drawn on top of
# stored-material variants; not needed for a base sprite map).
#
# ---- v2 (WC-2026-07-07 WC-5) additions ----
# The v1 pass above only reads graphics_workshops.txt/graphics_buildings.txt's
# named workshop/furnace/depot tokens. v2 adds, all still READ-ONLY:
#   - graphics_tracks.txt + graphics_planned_constructions.txt added to the
#     SAME generic per-token pass above (verified: identical plain
#     [TILE_GRAPHICS:PAGE:col:row:TOKEN] grammar, no code changes needed) --
#     picks up TRACK_STOP_*/TRACK_CARVED_*/ROLLERS_*/PLANNED_CONSTRUCTION_*
#     for free.
#   - `furniture`: 28 furniture-building keys (Door, Bed, Table, Chair,
#     Cabinet, Box, Coffin, Statue, Slab, Hatch, GrateWall, GrateFloor,
#     BarsVertical, BarsFloor, Chain, Cage, AnimalTrap, WindowGlass,
#     WindowGem, TractionBench, Weaponrack, Armorstand, NestBox, Hive,
#     Bookcase, DisplayFurniture, OfferingPlace, Instrument) resolved from
#     the ITEM-graphics sheets (graphics_items.txt/_containers.txt, read via
#     build_item_map's parser -- same raws WC-2 reads, imported not
#     duplicated) plus graphics_statues.txt (ITEM_STATUE_{WOOD,STONE,METAL,
#     GLASS}, a dedicated per-material statue family not read by WC-2).
#     `matvariants` per key (>=1 material each -- some furniture, e.g.
#     Chain/WindowGlass/WindowGem, only has 1-2 real materials in vanilla;
#     that IS the correct/complete art, not a gap) + `states` where DF has
#     open/closed/empty/full/in-use cells.
#   - `wells`: BLD_WELL/_WITH_ROPE/_WITH_CHAIN + BUCKET EMPTY/FULL x ROPE/
#     CHAIN, restructured from the generic pass's flat BLD_WELL* entries
#     into one states family.
#   - `machines`: SCREWPUMP/WINDMILL/WATER_WHEEL/AXLE_*/GEAR_ASSEMBLY
#     (graphics_machines.txt -- frame number is baked into the token NAME,
#     `_1`/`_2` suffix, per spec's verified animation-frame convention (b);
#     footprint sub-cells carry a trailing subcol[:subrow] param). Emits
#     `{direction: {frames: [cellset1, cellset2]}}`.
#   - `bridges`: `{material: {orientation: {raise_state: partgrid}}}` from
#     graphics_buildings.txt's BLD_BRIDGE_{WOOD,STONE,METAL,GLASS}_* tokens
#     (308 lines, 4 materials verified), so WC-8 stops string-guessing.
# `web/overlay_map.json` (a NEW, separate output) is built by
# `build_overlay_map()` from graphics_stockpiles.txt (19 tokens: FLOOR + 7
# edge cells + 19 category glyphs incl. BLANK/CUSTOM) and
# graphics_interface.txt's ACTIVITY_ZONES block (16 ZONE_INACTIVE adjacency
# cells + 27 named ZONE_* type icons, L2529-2640).
#
# Reads the DF install READ-ONLY. Writes web/building_map.json + web/overlay_map.json.
#
# Run (uses the pre-installed venv, stdlib only):
#   python tools/ws2/build_building_map.py

import json
import os
import re
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from build_item_map import (  # noqa: E402 -- sibling generator, same territory
    ITEMS_GFX, ITEM_TILE_PAGE_FILE, load_item_tokens, load_tile_pages as load_item_tile_pages,
    LEG_COMPOSITE_FAMILIES, redirect_to_leg_composite,
)

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

GDIR = dfroot.df_root_for(__file__, sub="data/vanilla/vanilla_buildings_graphics/graphics",
                          purpose="reads Dwarf Fortress's own raws as the ground truth")
DF_ROOT = dfroot.df_root_for(__file__, sub="data/vanilla",
                          purpose="reads Dwarf Fortress's own raws as the ground truth")
INTERFACE_GFX = os.path.join(DF_ROOT, "vanilla_interface", "graphics")
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(_ROOT, "web", "building_map.json")
OVERLAY_OUT = os.path.join(_ROOT, "web", "overlay_map.json")

SRC_FILES = ["graphics_workshops.txt", "graphics_buildings.txt",
             "graphics_tracks.txt", "graphics_planned_constructions.txt"]

TOKEN_RE = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):([^\]]+)\]")

# raw TOKEN key -> DFHack-style "Type:Subtype" alias(es) a wire consumer is
# likely to look up by. Not exhaustive -- covers the buildings named in the
# task plus the rest of the vanilla workshop/furnace roster we found.
ALIASES = {
    "WORKSHOP_CARPENTER":  ["Workshop:Carpenters"],
    "WORKSHOP_MASON":      ["Workshop:Masons"],
    "WORKSHOP_CRAFTS":     ["Workshop:Craftsdwarfs"],
    "WORKSHOP_STILL":      ["Workshop:Still"],
    "WORKSHOP_KITCHEN":    ["Workshop:Kitchen"],
    "WORKSHOP_FARMER":     ["Workshop:Farmers"],
    "WORKSHOP_FISHERY":    ["Workshop:Fishery"],
    "WORKSHOP_LOOM":       ["Workshop:Loom"],
    "WORKSHOP_CLOTHES":    ["Workshop:Clothiers"],
    "WORKSHOP_METALSMITH": ["Workshop:MetalsmithsForge"],
    "WORKSHOP_MAGMAFORGE": ["Workshop:MagmaForge"],
    "WORKSHOP_BOWYER":     ["Workshop:Bowyers"],
    "WORKSHOP_BUTCHER":    ["Workshop:Butchers"],
    "WORKSHOP_ASHERY":     ["Workshop:Ashery"],
    "WORKSHOP_DYER":       ["Workshop:Dyers"],
    "WORKSHOP_JEWELER":    ["Workshop:Jewelers"],
    "WORKSHOP_LEATHER":    ["Workshop:Leatherworks"],
    "WORKSHOP_TANNER":     ["Workshop:Tanners"],
    "WORKSHOP_MECHANIC":   ["Workshop:Mechanics"],
    "WORKSHOP_KENNEL":     ["Workshop:Kennels"],
    "WORKSHOP_MILLSTONE":  ["Workshop:Millstone"],
    "WORKSHOP_QUERN":      ["Workshop:Quern"],
    # B63 ("siege workshop shows the blue-box fallback"): the raws carry the full 5x5
    # WORKSHOP_SIEGE art (graphics_buildings.txt L1175+) and this generator emitted it under
    # its raw key -- but the client's buildingEntry() only ever constructs "Workshop:<subtype>"
    # (df::workshop_type key, Siege = 9), so the entry was unreachable. Hand-list gap, same
    # class as the report's "the generator was correct for its original question".
    "WORKSHOP_SIEGE":      ["Workshop:Siege"],
    "FURNACE_WOOD":        ["Furnace:WoodFurnace"],
    "FURNACE_SMELTER":     ["Furnace:Smelter"],
    "FURNACE_SMELTER_LAVA": ["Furnace:MagmaSmelter"],
    "FURNACE_GLASS":       ["Furnace:GlassFurnace"],
    "FURNACE_GLASS_LAVA":  ["Furnace:MagmaGlassFurnace"],
    "FURNACE_KILN":        ["Furnace:Kiln"],
    "FURNACE_KILN_LAVA":   ["Furnace:MagmaKiln"],
    "TRADE_DEPOT":         ["TradeDepot"],
}


def load_pages():
    """[TILE_PAGE:NAME] -> png basename, from tile_page_buildings.txt."""
    pages = {}
    txt = open(os.path.join(GDIR, "tile_page_buildings.txt"), encoding="latin-1").read()
    name = None
    for m in re.finditer(r"\[(TILE_PAGE|FILE):([^\]]+)\]", txt):
        kind, val = m.group(1), m.group(2)
        if kind == "TILE_PAGE":
            name = val.strip()
        elif kind == "FILE" and name:
            pages[name] = os.path.basename(val.strip())
            name = None
    return pages


def parse_entries():
    """(entries, overlays): building-key -> list of (page,page_col,page_row,params).

    B20: `<TOKEN>_OVERLAY` lines (the tool/decoration DETAIL layer DF draws ON TOP
    of a workshop's base structure -- 1296 lines in graphics_workshops.txt alone)
    were previously dropped entirely, so workshops rendered base-only. They are now
    captured into a SEPARATE `overlays` dict keyed by the SAME base token
    (`WORKSHOP_CARPENTER_OVERLAY` -> `WORKSHOP_CARPENTER`), share the identical
    `stage:col:row` footprint grammar, and get their own parallel grid the client
    blits over the base cell (see build_grid + the `overlay` field attached in main).
    """
    entries = defaultdict(list)
    overlays = defaultdict(list)
    for fname in SRC_FILES:
        path = os.path.join(GDIR, fname)
        if not os.path.exists(path):
            continue
        for line in open(path, encoding="latin-1"):
            m = TOKEN_RE.match(line.strip())
            if not m:
                continue
            page, pcol, prow, rest = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
            fields = rest.split(":")
            token = fields[0]
            is_overlay = token.endswith("_OVERLAY")
            base_token = token[:-len("_OVERLAY")] if is_overlay else token
            rest_fields = fields[1:]
            key = base_token
            if base_token == "WORKSHOP_CUSTOM" and rest_fields and not _is_int(rest_fields[0]):
                key = f"WORKSHOP_CUSTOM:{rest_fields[0]}"
                rest_fields = rest_fields[1:]
            if not all(_is_int(x) for x in rest_fields):
                continue  # stray trailing raw-file comment text, skip
            params = tuple(int(x) for x in rest_fields)
            (overlays if is_overlay else entries)[key].append((page, pcol, prow, params))
    return entries, overlays


def _is_int(s):
    try:
        int(s)
        return True
    except ValueError:
        return False


def build_grid(rows):
    """rows: [(page,pcol,prow,params)] for one building key -> (sheet,w,h,cells) or None."""
    # A 2-param trailing form is AMBIGUOUS in the graphics grammar: it is either
    #   (col, row)      -- a multi-tile building's footprint, col axis 0-based, OR
    #   (variant, row)  -- a single-tile building's build stage (col implicit 0),
    #                      e.g. millstone/quern "the zero stage is made in-game".
    # The graphics file doesn't tag which. Disambiguate STRUCTURALLY: a real
    # footprint column axis is 0-based and contiguous, so 0 appears among the
    # first-param values (wagon {0,1,2}, ballista {0,1,2}); a build-stage axis
    # starts at 1 (stage 0 is auto-generated), so 0 never appears (millstone {1}).
    # The old code assumed 2-param ALWAYS meant (variant, row) and force-set col=0,
    # which collapsed the wagon's 3-wide art (subtile_x 0,1,2) to col 2 only,
    # leaving 2 of 3 footprint columns blank on screen (TX3 / B47 reopen). 3+ param
    # forms are unambiguous (last two are always col,row).
    two_param_cols = [p[-2] for _, _, _, p in rows if len(p) == 2]
    two_param_is_col = bool(two_param_cols) and (0 in two_param_cols)

    def split_params(params):
        """(variant_key, col, row) honoring the 2-param ambiguity above."""
        if len(params) >= 3:
            return params[:-2], params[-2], params[-1]
        if len(params) == 2:
            if two_param_is_col:
                return (), params[-2], params[-1]
            return (params[0],), 0, params[-1]   # (variant, row), col implicit 0
        if len(params) == 1:
            return (), 0, params[-1]
        return (), 0, 0

    variants = defaultdict(list)
    for page, pcol, prow, params in rows:
        vk, _, _ = split_params(params)
        variants[vk].append((page, pcol, prow, params))

    # The leading param is the build STAGE (0 = frame/placeholder that's "made in-game
    # if not provided", higher = more complete). A fully-built workshop reports its MAX
    # stage on the wire (e.g. carpenter = stage 3), so pick the HIGHEST stage here -- else
    # built workshops render as the stage-0 construction frame. For buildings whose leading
    # digit is a cosmetic variant rather than a stage, any is equally valid, so max is safe.
    chosen_vk = max(variants.keys(), key=lambda k: (k, len(k)))
    group = variants[chosen_vk]

    sheet = None
    cellmap = {}          # (row,col) -> {"col":pcol,"row":prow}
    zero_row_cells = {}    # col -> {"col":pcol,"row":prow}  (row==0 / stage==0 fallback)
    for page, pcol, prow, params in group:
        sheet = page
        _, col, row = split_params(params)
        cell = {"col": pcol, "row": prow}
        if row == 0:
            zero_row_cells[col] = cell
        else:
            cellmap[(row - 1, col)] = cell

    used_zero_as_content = False
    if not cellmap:
        # no footprint rows beyond the reserved row 0 -- it IS the content
        # (true 1-tile buildings, e.g. millstone/quern/screw press).
        used_zero_as_content = True
        for col, cell in zero_row_cells.items():
            cellmap[(0, col)] = cell

    if not cellmap:
        return None

    h = max(r for r, c in cellmap) + 1
    w = max(c for r, c in cellmap) + 1
    grid = [[None] * w for _ in range(h)]
    for (r, c), cell in cellmap.items():
        grid[r][c] = cell
    fallback = next((cell for rrow in grid for cell in rrow if cell), None)
    for r in range(h):
        for c in range(w):
            if grid[r][c] is None:
                grid[r][c] = fallback

    # B14: the reserved art-row-0 "overhang" cells ("something sticking up above the shop"
    # per the raw file's own comment -- e.g. a furnace chimney / kiln stack). These were
    # DROPPED before (captured into zero_row_cells then discarded unless the building had no
    # footprint rows), so the top of tall building art was clipped flush with the footprint --
    # exactly B14's "the furnace part that should be on top of grass to show height is cut off
    # entirely". Emit them as a w-wide row the client blits ONE tile ABOVE the building's top
    # footprint row (world y1 - 1). Only when row 0 is a genuine overhang, not the sole content
    # of a 1-tile building (already placed into the grid above). None per column with no cell.
    overhang = None
    if not used_zero_as_content and zero_row_cells:
        overhang = [zero_row_cells.get(c) for c in range(w)]
        if not any(overhang):
            overhang = None
    return sheet, w, h, grid, overhang


# ============================================================================
# v2 additions (WC-5)
# ============================================================================

# 28 furniture-building keys -> {material: ITEM_* token}. Resolved against
# graphics_items.txt/_containers.txt (via build_item_map's parser -- the
# SAME item sheets WC-2 reads) plus graphics_statues.txt for Statue (a
# dedicated per-material statue family WC-2 doesn't need). Every token below
# is verified present in the raws this session; main() fails loudly (same
# convention as build_item_map.py) if a raws update removes one.
FURNITURE_MATVARIANTS = {
    "Door":       {"WOOD": "ITEM_DOOR_WOOD", "STONE": "ITEM_DOOR_STONE",
                    "METAL": "ITEM_DOOR_METAL", "GLASS": "ITEM_DOOR_GLASS"},
    "Floodgate":  {"WOOD": "ITEM_FLOODGATE_WOOD", "STONE": "ITEM_FLOODGATE_STONE",
                    "METAL": "ITEM_FLOODGATE_METAL", "GLASS": "ITEM_FLOODGATE_GLASS"},
    "Bed":        {"WOOD": "ITEM_BED_WOOD", "STONE": "ITEM_BED_STONE",
                    "METAL": "ITEM_BED_METAL", "GLASS": "ITEM_BED_GLASS"},
    "Table":      {"WOOD": "ITEM_TABLE_WOOD", "STONE": "ITEM_TABLE_STONE",
                    "METAL": "ITEM_TABLE_METAL", "GLASS": "ITEM_TABLE_GLASS"},
    "Chair":      {"WOOD": "ITEM_CHAIR_WOOD", "STONE": "ITEM_CHAIR_STONE",
                    "METAL": "ITEM_CHAIR_METAL", "GLASS": "ITEM_CHAIR_GLASS"},
    "Cabinet":    {"WOOD": "ITEM_CABINET_WOOD", "STONE": "ITEM_CABINET_STONE",
                    "METAL": "ITEM_CABINET_METAL", "GLASS": "ITEM_CABINET_GLASS"},
    "Box":        {"WOOD": "ITEM_BOX_WOOD", "STONE": "ITEM_BOX_STONE",
                    "METAL": "ITEM_BOX_METAL", "GLASS": "ITEM_BOX_GLASS"},
    "Coffin":     {"WOOD": "ITEM_COFFIN_WOOD", "STONE": "ITEM_COFFIN_STONE",
                    "METAL": "ITEM_COFFIN_METAL", "GLASS": "ITEM_COFFIN_GLASS"},
    "Statue":     {"WOOD": "ITEM_STATUE_WOOD", "STONE": "ITEM_STATUE_STONE",
                    "METAL": "ITEM_STATUE_METAL", "GLASS": "ITEM_STATUE_GLASS"},
    "Slab":       {"STONE": "ITEM_SLAB_BLANK"},  # slabs are always stone in vanilla
    "Hatch":      {"WOOD": "ITEM_HATCH_COVER_WOOD", "STONE": "ITEM_HATCH_COVER_STONE",
                    "METAL": "ITEM_HATCH_COVER_METAL", "GLASS": "ITEM_HATCH_COVER_GLASS"},
    "GrateWall":  {"WOOD": "ITEM_GRATE_WOOD_WALL_CLOSED", "STONE": "ITEM_GRATE_STONE_WALL_CLOSED",
                    "METAL": "ITEM_GRATE_METAL_WALL_CLOSED", "GLASS": "ITEM_GRATE_GLASS_WALL_CLOSED"},
    "GrateFloor": {"WOOD": "ITEM_GRATE_WOOD_FLOOR_CLOSED", "STONE": "ITEM_GRATE_STONE_FLOOR_CLOSED",
                    "METAL": "ITEM_GRATE_METAL_FLOOR_CLOSED", "GLASS": "ITEM_GRATE_GLASS_FLOOR_CLOSED"},
    "Cage":       {"WOOD": "ITEM_CAGE_WOOD", "METAL": "ITEM_CAGE_METAL", "GLASS": "ITEM_CAGE_GLASS"},
    "AnimalTrap": {"WOOD": "ITEM_ANIMAL_TRAP_WOOD", "METAL": "ITEM_ANIMAL_TRAP_METAL"},
    "WindowGlass":{"GLASS": "ITEM_WINDOW_GLASS"},
    "WindowGem":  {"GEM": "ITEM_WINDOW_GEM"},
    "TractionBench": {"WOOD": "ITEM_TRACTION_BENCH_WOODEN_CHAIN", "STONE": "ITEM_TRACTION_BENCH_STONE_CHAIN",
                       "METAL": "ITEM_TRACTION_BENCH_METAL_CHAIN", "GLASS": "ITEM_TRACTION_BENCH_GLASS_CHAIN"},
    "Weaponrack": {"WOOD": "ITEM_WEAPON_RACK_WOOD_EMPTY", "STONE": "ITEM_WEAPON_RACK_STONE_EMPTY",
                    "METAL": "ITEM_WEAPON_RACK_METAL_EMPTY"},
    "Armorstand": {"WOOD": "ITEM_ARMOR_STAND_WOOD_EMPTY", "STONE": "ITEM_ARMOR_STAND_STONE_EMPTY",
                    "METAL": "ITEM_ARMOR_STAND_METAL_EMPTY"},
    "NestBox":    {"WOOD": "ITEM_TOOL_NEST_BOX"},
    "Hive":       {"WOOD": "ITEM_TOOL_HIVE"},
    "Bookcase":   {"WOOD": "ITEM_TOOL_BOOKCASE"},
    "DisplayFurniture": {"WOOD": "ITEM_TOOL_DISPLAY_CASE"},
    "OfferingPlace":    {"WOOD": "ITEM_TOOL_ALTAR"},
    "Instrument": {"WOOD": "ITEM_INSTRUMENT_STRINGED_BUILDING"},
}

# Chain/BarsVertical/BarsFloor are BUILDING tokens (graphics_buildings.txt),
# not item-sheet tokens -- resolved from the generic per-token pass's `out`
# dict instead of item_tokens (see build_furniture()).
FURNITURE_FROM_BUILDING_TOKENS = {
    "Chain":        {"METAL": "BLD_CHAIN_METAL", "ROPE": "BLD_CHAIN_ROPE"},
    "BarsVertical": {"METAL": "BLD_VERTICAL_BARS_W"},
    "BarsFloor":    {"METAL": "BLD_FLOOR_BARS"},
}

# state-variant sub-tables, keyed the same as FURNITURE_MATVARIANTS (material
# -> token), only where DF's raws actually carry a distinct state cell.
FURNITURE_STATES = {
    "Door": {
        "OPEN": {"WOOD": "ITEM_DOOR_WOOD_OPEN", "STONE": "ITEM_DOOR_STONE_OPEN",
                  "METAL": "ITEM_DOOR_METAL_OPEN", "GLASS": "ITEM_DOOR_GLASS_OPEN"},
        "CLOSED": {"WOOD": "ITEM_DOOR_WOOD_CLOSED", "STONE": "ITEM_DOOR_STONE_CLOSED",
                    "METAL": "ITEM_DOOR_METAL_CLOSED", "GLASS": "ITEM_DOOR_GLASS_CLOSED"},
    },
    "Floodgate": {
        "OPEN": {"WOOD": "ITEM_FLOODGATE_WOOD_OPEN", "STONE": "ITEM_FLOODGATE_STONE_OPEN",
                  "METAL": "ITEM_FLOODGATE_METAL_OPEN", "GLASS": "ITEM_FLOODGATE_GLASS_OPEN"},
        "CLOSED": {"WOOD": "ITEM_FLOODGATE_WOOD_CLOSED", "STONE": "ITEM_FLOODGATE_STONE_CLOSED",
                    "METAL": "ITEM_FLOODGATE_METAL_CLOSED", "GLASS": "ITEM_FLOODGATE_GLASS_CLOSED"},
    },
    "Hatch": {
        "OPEN": {"WOOD": "ITEM_HATCH_COVER_WOOD_OPEN", "STONE": "ITEM_HATCH_COVER_STONE_OPEN",
                  "METAL": "ITEM_HATCH_COVER_METAL_OPEN", "GLASS": "ITEM_HATCH_COVER_GLASS_OPEN"},
        "CLOSED": {"WOOD": "ITEM_HATCH_COVER_WOOD_CLOSED", "STONE": "ITEM_HATCH_COVER_STONE_CLOSED",
                    "METAL": "ITEM_HATCH_COVER_METAL_CLOSED", "GLASS": "ITEM_HATCH_COVER_GLASS_CLOSED"},
    },
    "GrateWall": {"OPEN": {"WOOD": "ITEM_GRATE_WOOD_WALL_OPEN", "STONE": "ITEM_GRATE_STONE_WALL_OPEN",
                            "METAL": "ITEM_GRATE_METAL_WALL_OPEN", "GLASS": "ITEM_GRATE_GLASS_WALL_OPEN"}},
    "GrateFloor": {"OPEN": {"WOOD": "ITEM_GRATE_WOOD_FLOOR_OPEN", "STONE": "ITEM_GRATE_STONE_FLOOR_OPEN",
                              "METAL": "ITEM_GRATE_METAL_FLOOR_OPEN", "GLASS": "ITEM_GRATE_GLASS_FLOOR_OPEN"}},
    "Cage": {"OCCUPIED": {"WOOD": "ITEM_CAGE_WOOD_OCCUPIED", "METAL": "ITEM_CAGE_METAL_OCCUPIED",
                           "GLASS": "ITEM_CAGE_GLASS_OCCUPIED"}},
    "AnimalTrap": {"OCCUPIED": {"WOOD": "ITEM_ANIMAL_TRAP_WOOD_OCCUPIED",
                                 "METAL": "ITEM_ANIMAL_TRAP_METAL_OCCUPIED"}},
    "TractionBench": {"ROPE": {"WOOD": "ITEM_TRACTION_BENCH_WOODEN_ROPE", "STONE": "ITEM_TRACTION_BENCH_STONE_ROPE",
                                 "METAL": "ITEM_TRACTION_BENCH_METAL_ROPE", "GLASS": "ITEM_TRACTION_BENCH_GLASS_ROPE"}},
    "Weaponrack": {"FULL": {"WOOD": "ITEM_WEAPON_RACK_WOOD_FULL", "STONE": "ITEM_WEAPON_RACK_STONE_FULL",
                             "METAL": "ITEM_WEAPON_RACK_METAL_FULL"}},
    "Armorstand": {"FULL": {"WOOD": "ITEM_ARMOR_STAND_WOOD_FULL", "STONE": "ITEM_ARMOR_STAND_STONE_FULL",
                             "METAL": "ITEM_ARMOR_STAND_METAL_FULL"}},
}


def load_statue_tokens():
    """ITEM_STATUE_{WOOD,STONE,METAL,GLASS}[:variant] from graphics_statues.txt
    (a dedicated per-material statue family; not read by build_item_map.py,
    which uses the single generic ITEM_STATUE_ITEM cell instead)."""
    path = os.path.join(ITEMS_GFX, "graphics_statues.txt")
    tg = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):(ITEM_STATUE_[A-Z]+)(?::\d+)?\]")
    tokens = {}
    for ln in open(path, "r", encoding="latin-1"):
        m = tg.match(ln.strip())
        if not m:
            continue
        page, col, row, token = m.groups()
        if token not in tokens:
            tokens[token] = (page, int(col), int(row))
    return tokens


# ---------------------------------------------------------------------------
# B253 (07-14): "missing the top half and some decorative patterning on the
# built statues". A BUILT STATUE IS THREE CELLS, NOT ONE -- and one of them
# lands on the tile ABOVE the statue. DF's own model, cited:
#
#   df.itemdef.xml:44-48   struct item_statue_graphics_infost {
#                              item_statue_graphics_flag flags;
#                              int32 texpos_top; int32 texpos_bottom; }
#     ^ the ONLY *_graphics_infost in df-structures carrying a top/bottom texpos
#       PAIR (every other furniture info struct has a single texpos) -- a statue
#       is DF's only 2-cell-tall built object.
#   df.itemdef.xml:24-42   item_statue_graphics_flag: overall (SHAPE|ITEM|
#       CREATURE|TREE|PLANT|GENERIC_EVENT), index_1, index_2, material
#       (WOOD|STONE|METAL|GLASS), material_color_index, planned, is_item,
#       artifact_index, QUALITY(3b).  <- material class + quality are part of
#       the sprite key: that is the "decorative patterning" the owner is missing.
#   df.item.xml:1532-1542  item_statuest carries art_graphics_type +
#       art_graphics_id -- DF's own already-resolved subject identity, ON THE
#       ITEM (the BUILDING has only an unused `statue_flag`, df.building.xml:1520;
#       same B246 finding).
#   df.creature.xml:1328   creature_raw/caste_raw statue_texpos[2] "top,bottom".
#
# So the composite DF draws is:
#     statue's own tile : pedestal[material class][quality]  (material-tinted)
#                       + subject BOTTOM cell over it
#     one tile ABOVE    : subject TOP cell
# Reconstructing that reproduces the native capture (B253-1.png) exactly, cube
# and dentil frieze included.
#
# We shipped ONE cell: statues.png (0,0) -- the plainest quality-1 stone
# pedestal. That is pixel-for-pixel the browser capture (B253-2.png).
#
# Raws: [TILE_PAGE:STATUES] images/statues.png TILE_DIM 32x32 PAGE_DIM 8x8
# (tile_page_items.txt:120), table in graphics_statues.txt; 932
# STATUE_CREATURE_GRAPHICS / STATUE_CREATURE_CASTE_GRAPHICS blocks across 37
# graphics_creatures_*statues*.txt files -- every one of their 976
# [DEFAULT:PAGE:x1:y1:x2:y2] lines satisfies x1==x2 and y2==y1+1 (1 wide, 2
# tall, top then bottom). Zero exceptions; asserted by build_statues().

# item_statue_graphics_type_overall (df.itemdef.xml:2-9) -> the raws token whose
# TOP/BOTTOM pair depicts that subject. CREATURE (2) is NOT here: it resolves per
# race/caste through the creature statue graphics below.
STATUE_OVERALL_TOKEN = {
    0: "ITEM_STATUE_GENERIC_SHAPE",   # SHAPE -- same cells as ITEM_DEFAULT_STATUE
    1: None,                          # ITEM  -- vanilla ships no per-item statue art -> default
    3: "ITEM_STATUE_GENERIC_TREE",    # TREE
    4: "ITEM_STATUE_GENERIC_SHRUB",   # PLANT
}
# statue_generic_event_type (df.itemdef.xml:11-22) -> raws token, for overall=GENERIC_EVENT(5).
STATUE_EVENT_TOKEN = {
    0: "ITEM_STATUE_GENERIC_EVENT",           # BASE
    1: "ITEM_STATUE_GENERIC_DUEL",
    2: "ITEM_STATUE_GENERIC_TRIUMPH",
    3: "ITEM_STATUE_GENERIC_CIVILIZED",
    4: "ITEM_STATUE_GENERIC_STRIKE_DOWN",
    5: "ITEM_STATUE_GENERIC_SHOT",
    6: "ITEM_STATUE_GENERIC_ITEM_CREATION",
    7: "ITEM_STATUE_GENERIC_BATTLE",
    8: "ITEM_STATUE_GENERIC_SITE",
}
# item_statue_graphics_flag_material (df.itemdef.xml:37-42), in enum order.
STATUE_MATERIAL_CLASS = ["WOOD", "STONE", "METAL", "GLASS"]
STATUE_QUALITY_MAX = 7   # 1..6 = ordinary..masterwork; 7 = artifact (graphics_statues.txt:14,21)

CREATURES_GFX_DIRS = ["vanilla_creatures_graphics", "vanilla_creatures_extinct_graphics"]


def _statue_pairs_from_items_gfx():
    """TOP/BOTTOM cell pairs + per-quality pedestal cells from graphics_statues.txt.

    Grammar is the plain [TILE_GRAPHICS:PAGE:col:row:TOKEN[:quality]] one. Returns
    (pairs, pedestals): pairs[TOKEN] = {"top": (col,row), "bottom": (col,row)};
    pedestals[MATCLASS][quality 1..7] = (col,row), plus pedestals["ARTIFACT"] = [cells].
    """
    path = os.path.join(ITEMS_GFX, "graphics_statues.txt")
    tg = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):([A-Z0-9_]+)(?::(\d+))?\]")
    tops, bottoms = {}, {}
    pedestals = {m: {} for m in STATUE_MATERIAL_CLASS}
    artifact = []
    page_name = None
    for ln in open(path, "r", encoding="latin-1"):
        m = tg.match(ln.strip())
        if not m:
            continue
        page, col, row, token, qual = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4), m.group(5)
        page_name = page_name or page
        if token.endswith("_TOP"):
            tops[token[:-4]] = (col, row)
        elif token.endswith("_BOTTOM"):
            bottoms[token[:-7]] = (col, row)
        elif token == "ITEM_STATUE_ARTIFACT":
            artifact.append((col, row))
        else:
            for mc in STATUE_MATERIAL_CLASS:
                if token == "ITEM_STATUE_" + mc and qual:
                    pedestals[mc][int(qual)] = (col, row)
    pairs = {}
    for tok, top in tops.items():
        if tok in bottoms:
            pairs[tok] = {"top": top, "bottom": bottoms[tok]}
    return page_name, pairs, pedestals, artifact


def _statue_creature_graphics(pages_by_name):
    """Every STATUE_CREATURE_GRAPHICS / STATUE_CREATURE_CASTE_GRAPHICS block in the
    creature graphics raws -> {"RACE": {...}, "RACE:CASTE": {...}}.

    Each block's [DEFAULT:PAGE:x1:y1:x2:y2] is ALWAYS 1 wide and 2 tall (top at
    (x1,y1), bottom at (x1,y1+1)) -- asserted, not assumed. 932 blocks in vanilla.
    """
    blk = re.compile(r"\[STATUE_CREATURE_(CASTE_)?GRAPHICS:([A-Z0-9_]+)(?::([A-Z_]+))?\]")
    dfl = re.compile(r"\[DEFAULT:([A-Za-z0-9_]+):(\d+):(\d+):(\d+):(\d+)\]")
    out, missing_pages = {}, set()
    for sub in CREATURES_GFX_DIRS:
        d = os.path.join(DF_ROOT, sub, "graphics")
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if "statue" not in fn or not fn.endswith(".txt"):
                continue
            key = None
            for ln in open(os.path.join(d, fn), "r", encoding="latin-1"):
                s = ln.strip()
                m = blk.match(s)
                if m:
                    key = m.group(2) + (":" + m.group(3) if m.group(3) else "")
                    continue
                g = dfl.match(s)
                if not g or not key:
                    continue
                page, x1, y1, x2, y2 = g.group(1), *map(int, g.groups()[1:])
                if x1 != x2 or y2 != y1 + 1:
                    raise SystemExit(
                        "statue creature art %r is not 1x2 (%s %d:%d:%d:%d) -- raws changed, "
                        "the top/bottom model in this file is wrong" % (key, page, x1, y1, x2, y2))
                sheet = pages_by_name.get(page)
                if not sheet:
                    missing_pages.add(page)
                    continue
                out[key] = {"sheet": sheet,
                            "top": {"col": x1, "row": y1},
                            "bottom": {"col": x1, "row": y1 + 1}}
    if missing_pages:
        raise SystemExit("statue creature tile pages unresolved: %s" % sorted(missing_pages))
    return out


def _load_creature_tile_pages():
    """[TILE_PAGE:NAME] -> sheet basename, from the creature graphics tile-page files."""
    tp = re.compile(r"\[TILE_PAGE:([A-Za-z0-9_]+)\]")
    fl = re.compile(r"\[FILE:(?:.*/)?([A-Za-z0-9_.\-]+)\]")
    pages, cur = {}, None
    for sub in CREATURES_GFX_DIRS:
        d = os.path.join(DF_ROOT, sub, "graphics")
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.startswith("tile_page") or not fn.endswith(".txt"):
                continue
            for ln in open(os.path.join(d, fn), "r", encoding="latin-1"):
                s = ln.strip()
                m = tp.match(s)
                if m:
                    cur = m.group(1)
                    continue
                f = fl.match(s)
                if f and cur:
                    pages[cur] = f.group(1)
                    cur = None
    return pages


def build_statues():
    """The `statues` section: everything a client needs to draw ANY vanilla statue.

    {sheet, pedestal:{MATCLASS:[7 cells, quality 1..7]}, artifact:[cells],
     subjects:{TOKEN:{top,bottom}}, overall:{"<n>":TOKEN}, event:{"<n>":TOKEN},
     default:{top,bottom}, creature:{"RACE"|"RACE:CASTE":{sheet,top,bottom}}}
    """
    page_name, pairs, pedestals, artifact = _statue_pairs_from_items_gfx()
    item_pages = load_item_tile_pages(ITEMS_GFX, ITEM_TILE_PAGE_FILE)
    sheet = item_pages.get(page_name)
    if not sheet:
        raise SystemExit("statue tile page %r unresolved in item tile pages" % page_name)
    for tok in list(STATUE_OVERALL_TOKEN.values()) + list(STATUE_EVENT_TOKEN.values()):
        if tok and tok not in pairs:
            raise SystemExit("statue subject token %r absent from graphics_statues.txt "
                             "(raws changed?)" % tok)
    if "ITEM_DEFAULT_STATUE" not in pairs:
        raise SystemExit("ITEM_DEFAULT_STATUE absent from graphics_statues.txt")

    def cell(t):
        return {"col": t[0], "row": t[1]}

    ped = {}
    for mc in STATUE_MATERIAL_CLASS:
        q = pedestals[mc]
        if sorted(q) != list(range(1, STATUE_QUALITY_MAX + 1)):
            raise SystemExit("ITEM_STATUE_%s quality cells are %s, expected 1..%d"
                             % (mc, sorted(q), STATUE_QUALITY_MAX))
        ped[mc] = [cell(q[i]) for i in range(1, STATUE_QUALITY_MAX + 1)]

    return {
        "sheet": sheet,
        "pedestal": ped,
        "artifact": [cell(c) for c in artifact],
        "subjects": {tok: {"top": cell(p["top"]), "bottom": cell(p["bottom"])}
                      for tok, p in sorted(pairs.items())},
        "overall": {str(k): v for k, v in STATUE_OVERALL_TOKEN.items() if v},
        "event": {str(k): v for k, v in STATUE_EVENT_TOKEN.items()},
        "materials": list(STATUE_MATERIAL_CLASS),
        "default": {"top": cell(pairs["ITEM_DEFAULT_STATUE"]["top"]),
                     "bottom": cell(pairs["ITEM_DEFAULT_STATUE"]["bottom"])},
        "creature": _statue_creature_graphics(_load_creature_tile_pages()),
    }


def parse_hive_states():
    """TOOL_GRAPHICS_HIVE_BLD[_IN_USE|_PRODUCTS]:PAGE:col:row -- a one-off
    state-tag grammar (state name baked into the TAG, not a trailing param)
    used only by the beekeeping hive building; not part of build_item_map's
    PLAIN_TOKEN_TAGS grammar so parsed separately here."""
    path = os.path.join(ITEMS_GFX, "graphics_items.txt")
    tg = re.compile(r"\[TOOL_GRAPHICS_HIVE_BLD(_IN_USE|_PRODUCTS)?:([A-Za-z0-9_]+):(-?\d+):(-?\d+)\]")
    states = {}
    for ln in open(path, "r", encoding="latin-1"):
        m = tg.match(ln.strip())
        if not m:
            continue
        suffix, page, col, row = m.groups()
        name = {None: "EMPTY", "_IN_USE": "IN_USE", "_PRODUCTS": "PRODUCTS"}[suffix]
        states[name] = (page, int(col), int(row))
    return states


def build_furniture(out):
    """28 furniture-building keys -> {"matvariants": {...}, "states": {...}}."""
    item_tokens, _ = load_item_tokens()
    item_pages = load_item_tile_pages(ITEMS_GFX, ITEM_TILE_PAGE_FILE)
    item_tokens = dict(item_tokens)
    item_tokens.update(load_statue_tokens())

    def item_cell(token):
        if token not in item_tokens or item_tokens[token] is None:
            raise SystemExit("furniture token %r not found in item graphics (raws changed?)" % token)
        page, col, row = item_tokens[token]
        sheet = item_pages.get(page)
        if not sheet:
            raise SystemExit("TILE_PAGE %r (for token %r) not found" % (page, token))
        return {"sheet": sheet, "col": col, "row": row}

    def building_cell(key):
        entry = out.get(key)
        if not entry:
            raise SystemExit("furniture building-token %r not found in generic pass (raws changed?)" % key)
        c = entry["cells"][0][0]
        return {"sheet": entry["sheet"], "col": c["col"], "row": c["row"]}

    furniture = {}
    for key, mats in FURNITURE_MATVARIANTS.items():
        furniture[key] = {"matvariants": {mat: item_cell(tok) for mat, tok in mats.items()}}
    for key, mats in FURNITURE_FROM_BUILDING_TOKENS.items():
        furniture[key] = {"matvariants": {mat: building_cell(tok) for mat, tok in mats.items()}}

    # B183 (REOPENED): PLACED furniture renders through THIS map, not item_map.json.
    # The client resolves a built Table/Chair via buildingMap[<building_type>] (the
    # top-level default _emit_bytype_defaults() derives from furniture.<key>.matvariants),
    # never reaching item_map's already-composited matvariants.Table -- so the two prior
    # table fixes (which touched only item_map) left placed tables/chairs legless. Repoint
    # each legged family's furniture matvariants at the SAME baked base+legs composite
    # item_map uses, via the SHARED helper/registry (no duplicated base/row constants):
    # a raws-layout drift fails loudly here exactly as it does in build_item_map. The
    # top-level building_type default then inherits the legged cell automatically.
    for family in LEG_COMPOSITE_FAMILIES:
        variants = furniture.get(family, {}).get("matvariants", {})
        for mat in list(variants):
            redirect_to_leg_composite(variants, mat, family, mat)

    for key, state_table in FURNITURE_STATES.items():
        furniture[key]["states"] = {
            state: {mat: item_cell(tok) for mat, tok in mats.items()}
            for state, mats in state_table.items()
        }

    # Slab: engraved-state cells (not material-keyed -- vanilla slabs are
    # always stone; the variant axis is engraving content, not material).
    slab_re = re.compile(r"\[TILE_GRAPHICS:ITEM_SLAB:(-?\d+):(-?\d+):(ITEM_SLAB_ENGRAVED_[A-Z0-9_]+)\]")
    slab_states = {}
    for ln in open(os.path.join(ITEMS_GFX, "graphics_items.txt"), "r", encoding="latin-1"):
        m = slab_re.match(ln.strip())
        if m:
            col, row, token = m.groups()
            slab_states[token[len("ITEM_SLAB_ENGRAVED_"):]] = item_cell(token)
    furniture["Slab"]["states"] = slab_states

    # Hive: EMPTY/IN_USE/PRODUCTS building-state cells (one-off tag grammar).
    hive_states = parse_hive_states()
    furniture["Hive"]["states"] = {
        name: {"sheet": item_pages.get(page), "col": col, "row": row}
        for name, (page, col, row) in hive_states.items()
    }

    missing = [k for k in FURNITURE_MATVARIANTS if k not in furniture] + \
              [k for k in FURNITURE_FROM_BUILDING_TOKENS if k not in furniture]
    assert not missing, "furniture keys not built: %s" % missing
    return furniture


def build_wells(out):
    """BLD_WELL* flat entries from the generic pass, restructured into one
    states family (bucket empty/full x rope/chain)."""
    def c1(key):
        entry = out.get(key)
        if not entry:
            raise SystemExit("well token %r not found in generic pass (raws changed?)" % key)
        c = entry["cells"][0][0]
        return {"sheet": entry["sheet"], "col": c["col"], "row": c["row"]}

    return {
        "BASE": c1("BLD_WELL"),
        "WITH_ROPE": c1("BLD_WELL_WITH_ROPE"),
        "WITH_CHAIN": c1("BLD_WELL_WITH_CHAIN"),
        "ROPE_HANGING": c1("BLD_WELL_ROPE"),
        "CHAIN_HANGING": c1("BLD_WELL_CHAIN"),
        "bucket": {
            "EMPTY": {"CHAIN": c1("BLD_WELL_BUCKET_EMPTY_CHAIN"), "ROPE": c1("BLD_WELL_BUCKET_EMPTY_ROPE")},
            "FULL": {"CHAIN": c1("BLD_WELL_BUCKET_FULL_CHAIN"), "ROPE": c1("BLD_WELL_BUCKET_FULL_ROPE")},
        },
    }


def build_machines():
    """SCREWPUMP/WINDMILL/WATER_WHEEL/AXLE_*/GEAR_ASSEMBLY -- frame number is
    baked into the token NAME (`_1`/`_2` suffix, verified animation-frame
    convention (b)); footprint sub-cells carry a trailing subcol[:subrow]
    param. Emits {base: {sheet, frames: [cellset1, cellset2]}} -- exactly 2
    frames per family (verified: every base in graphics_machines.txt has a
    complete _1/_2 pair, no odd-ones-out)."""
    path = os.path.join(GDIR, "graphics_machines.txt")
    pages = load_pages()
    line_re = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):([A-Za-z0-9_]+)((?::-?\d+)*)\]")
    frame_re = re.compile(r"^(.*)_(1|2)$")

    groups = defaultdict(lambda: defaultdict(list))
    for ln in open(path, "r", encoding="latin-1"):
        m = line_re.match(ln.strip())
        if not m:
            continue
        page, col, row, token, extra = m.groups()
        fm = frame_re.match(token)
        if not fm:
            continue
        base, frame = fm.group(1), int(fm.group(2))
        sub = [int(x) for x in extra.split(":") if x]
        groups[base][frame].append((page, int(col), int(row), sub))

    machines = {}
    incomplete = []
    for base, frames in groups.items():
        if set(frames.keys()) != {1, 2}:
            incomplete.append(base)
            continue
        sheet = None
        frame_lists = []
        for fnum in (1, 2):
            cells = []
            for page, col, row, sub in frames[fnum]:
                sheet = pages.get(page)
                if not sheet:
                    raise SystemExit("TILE_PAGE %r not found (machine %r)" % (page, base))
                cells.append({"sub": sub, "col": col, "row": row})
            frame_lists.append(cells)
        machines[base] = {"sheet": sheet, "frames": frame_lists}

    assert not incomplete, "machine families with an incomplete frame pair: %s" % incomplete
    assert all(len(v["frames"]) == 2 for v in machines.values())
    return machines


def parse_bridges():
    """BLD_BRIDGE_{WOOD,STONE,METAL,GLASS}_<suffix> -> {material: {suffix:
    cell}}. <suffix> already encodes orientation+raise-state+part (e.g.
    "1x1_RAISE_E", "NS_CENTER", "RAISE_N_END_W", "RETRACT_NSWE",
    "CONSTRUCTION") so WC-8 indexes by material first instead of
    string-matching across the ~300-entry flat token list."""
    path = os.path.join(GDIR, "graphics_buildings.txt")
    pages = load_pages()
    tg = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):(BLD_BRIDGE_[A-Z0-9_]+)\]")
    materials = ["WOOD", "STONE", "METAL", "GLASS"]
    bridges = {mat: {} for mat in materials}
    for ln in open(path, "r", encoding="latin-1"):
        m = tg.match(ln.strip())
        if not m:
            continue
        page, col, row, token = m.groups()
        for mat in materials:
            prefix = "BLD_BRIDGE_%s_" % mat
            if token.startswith(prefix):
                sheet = pages.get(page)
                bridges[mat][token[len(prefix):]] = {"sheet": sheet, "col": int(col), "row": int(row)}
                break
    assert all(bridges[mat] for mat in materials), "a bridge material had zero cells (raws changed?)"
    return bridges


def parse_stockpile_glyphs():
    """STOCKPILE_FLOOR + 7 edge-adjacency cells + 19 category glyphs
    (graphics_stockpiles.txt, verified 27 tokens total)."""
    path = os.path.join(GDIR, "graphics_stockpiles.txt")
    pages = load_pages()
    sheet = pages.get("STOCKPILE")
    tg = re.compile(r"\[TILE_GRAPHICS:STOCKPILE:(-?\d+):(-?\d+):(STOCKPILE_[A-Z0-9_]+)\]")
    out = {}
    for ln in open(path, "r", encoding="latin-1"):
        m = tg.match(ln.strip())
        if m:
            col, row, token = m.groups()
            out[token] = {"sheet": sheet, "col": int(col), "row": int(row)}
    return out


def parse_zone_glyphs():
    """ZONE_INACTIVE* 16-way adjacency + ZONE_{ACTIVE,SELECTED,GENERAL}* +
    27 named zone-type icons (graphics_interface.txt ACTIVITY_ZONES block,
    verified L2529-2640)."""
    path = os.path.join(INTERFACE_GFX, "graphics_interface.txt")
    pages = load_item_tile_pages(INTERFACE_GFX, "tile_page_interface.txt")
    sheet = pages.get("ACTIVITY_ZONES")
    tg = re.compile(r"\[TILE_GRAPHICS:ACTIVITY_ZONES:(-?\d+):(-?\d+):(ZONE_[A-Z0-9_]+)\]")
    out = {}
    for ln in open(path, "r", encoding="latin-1"):
        m = tg.match(ln.strip())
        if m:
            col, row, token = m.groups()
            out[token] = {"sheet": sheet, "col": int(col), "row": int(row)}
    return out


def parse_designation_glyphs():
    """WC-19: designation-priority numerals (DESIGNATION_PRIORITY:1..7, graphics_interface.txt
    L3168-3174) and item-designation mark glyphs (DESIGNATION_ITEM_{MELT,DUMP,FORBIDDEN,
    HIDDEN,FORBIDDEN_MELT,FORBIDDEN_DUMP}, L3176-3181), both verified in the SAME
    graphics_interface.txt already parsed for zone glyphs above. Grammar differs slightly
    from parse_zone_glyphs: DESIGNATION_PRIORITY's token has a trailing numeric param
    (`:1`..`:7`) that is NOT an animation-frame series (§1.2's frame-series note is about
    a REPEATED token; here it's the SAME token seven DIFFERENT times, once per priority
    level) -- the numeral is the actual priority level, captured directly as the dict key
    (int 1..7) rather than treated as a frame index."""
    path = os.path.join(INTERFACE_GFX, "graphics_interface.txt")
    pages = load_item_tile_pages(INTERFACE_GFX, "tile_page_interface.txt")
    prio_sheet = pages.get("DESIGNATION_PRIORITY")
    item_sheet = pages.get("DESIGNATION_ITEM")
    prio_re = re.compile(r"\[TILE_GRAPHICS:DESIGNATION_PRIORITY:(-?\d+):(-?\d+):DESIGNATION_PRIORITY:(\d+)\]")
    item_re = re.compile(r"\[TILE_GRAPHICS:DESIGNATION_ITEM:(-?\d+):(-?\d+):(DESIGNATION_ITEM_[A-Z_]+)\]")
    priority = {}
    item = {}
    for ln in open(path, "r", encoding="latin-1"):
        s = ln.strip()
        m = prio_re.match(s)
        if m:
            col, row, level = m.groups()
            priority[level] = {"sheet": prio_sheet, "col": int(col), "row": int(row)}
            continue
        m = item_re.match(s)
        if m:
            col, row, token = m.groups()
            item[token] = {"sheet": item_sheet, "col": int(col), "row": int(row)}
    return priority, item


def build_overlay_map():
    stockpile = parse_stockpile_glyphs()
    zone = parse_zone_glyphs()
    desig_priority, desig_item = parse_designation_glyphs()
    return {"_v": 1, "stockpile": stockpile, "zone": zone,
            "designation_priority": desig_priority, "designation_item": desig_item}


# df::building_type enum name -> machine family base key (from build_machines()).
BUILDING_TYPE_TO_MACHINE = {
    "WaterWheel":     "WATER_WHEEL_NS",
    "Windmill":       "WINDMILL_N",
    "GearAssembly":   "GEAR_ASSEMBLY",
    "AxleHorizontal": "AXLE_HORIZONTAL_WE",
    "AxleVertical":   "AXLE_VERTICAL",
    "ScrewPump":      "SCREWPUMP_N",
}
# building_type name -> an existing top-level TOKEN entry (generic pass) to reuse.
BUILDING_TYPE_TO_TOKEN = {
    "Wagon":         "WAGON_BLD",
    "ArcheryTarget": "BLD_ARCHERY_TARGET_STONE",
    "Rollers":       "ROLLERS_STONE_E_1",
    "SiegeEngine":   "CATAPULT_CONST_3",  # subtype 0 catapult default; ballista via subtype = client upgrade
    "Support":       "BLD_SUPPORT_STONE",
    "Trap":          "TRAP_CAGE",          # subtype 0..5 (stonefall/weapon/lever/plate/cage/track) = client upgrade
}
_MAT_PREF = ["WOOD", "STONE", "METAL", "GLASS", "GEM", "ROPE"]


def _one_cell_entry(sheet, cell):
    """Wrap a {col,row} cell as a 1x1 building entry the draw loop understands."""
    return {"sheet": sheet, "w": 1, "h": 1, "cells": [[{"col": cell["col"], "row": cell["row"]}]]}


def _emit_bytype_defaults(out, furniture, wells, machines, bridges, pages):
    """Emit flat top-level df::building_type-keyed entries so the client's
    buildingEntry() (buildingMap[type]) resolves furniture/well/machine/bridge/
    wagon buildings instead of falling to MISSING_BUILDING. Never clobbers an
    existing key. Returns the count emitted."""
    n = 0

    def emit(bt_name, entry):
        nonlocal n
        if not entry or bt_name in out:
            return
        out[bt_name] = entry
        n += 1

    # Furniture: building_type enum name == furniture key for all 28 (verified
    # against df.building_type). Pick a default material variant (WOOD-first).
    for key, fdata in furniture.items():
        mats = (fdata or {}).get("matvariants") or {}
        if not mats:
            continue
        pick = next((m for m in _MAT_PREF if m in mats), None) or sorted(mats)[0]
        cell = mats[pick]
        emit(key, _one_cell_entry(cell["sheet"], cell))

    # Well: the base well cell (bucket/rope state is a client upgrade).
    if wells.get("BASE"):
        emit("Well", _one_cell_entry(wells["BASE"]["sheet"], wells["BASE"]))

    # Machines: default = frame 0, sub-cell 0 (a single representative cell;
    # direction/animation stays available in the nested `machines` family).
    for bt_name, base in BUILDING_TYPE_TO_MACHINE.items():
        md = machines.get(base)
        if md and md.get("frames") and md["frames"][0]:
            c0 = md["frames"][0][0]
            emit(bt_name, _one_cell_entry(md["sheet"], c0))

    # Bridge: a lowered/flat centre cell (raise-state/orientation = client upgrade).
    st = bridges.get("STONE") or {}
    bcell = st.get("NS_CENTER") or st.get("CONSTRUCTION") or (next(iter(st.values())) if st else None)
    if bcell:
        emit("Bridge", _one_cell_entry(bcell["sheet"], bcell))

    # Reuse existing top-level TOKEN entries (already multi-tile-shaped).
    for bt_name, tok in BUILDING_TYPE_TO_TOKEN.items():
        if tok in out:
            emit(bt_name, out[tok])

    # FarmPlot: no building sprite in vanilla -- render NOTHING over the crop
    # (a null cell -> the client's draw loop skips it; the tilled-soil tiletype
    # and the crop plant beneath render normally). Prevents the grid of "?" boxes
    # that hid growing plump helmets / other crops.
    fp_sheet = pages.get("WORKSHOPS_1x1", pages.get("WORKSHOPS"))
    if fp_sheet and "FarmPlot" not in out:
        out["FarmPlot"] = {"sheet": fp_sheet, "w": 1, "h": 1, "cells": [[None]]}
        n += 1

    # B93 ("missing textures for constructed roads"): roads are df::building_type RoadPaved/
    # RoadDirt (NOT tiletypes), so the client resolves them through buildingMap[type] like every
    # other building -- but no road key was ever emitted here, so both fell to MISSING_BUILDING
    # (the "?"/box the friend's screenshot shows). DF's own road art lives in the TERRAIN graphics
    # (data/vanilla/vanilla_environment/graphics/graphics_tiles.txt -- NOT this generator's building
    # SRC_FILES, which is why parse_entries() never saw it): BLD_PAVED_ROAD = PAVED_BLOCK_ROADS page
    # col 0,row 0 (paved_block_roads.png); BLD_DIRT_ROAD = FLOORS page col 6,row 1 (floors.png -- DF
    # itself points dirt road at that floor cell, verified in the raw's own trailing comment). Both
    # sheets are served by the plugin's /sprites/img handler (vanilla environment graphics dir). A
    # road is ONE building spanning an arbitrary rectangle; a 1x1 cell entry pattern-tiles across the
    # whole footprint (the client's documented 1x1 stamp path, identical to how bridges plank-tile),
    # which is exactly how DF draws a road field.
    ROAD_CELLS = {
        "RoadPaved": ("paved_block_roads.png", 0, 0),
        "RoadDirt": ("floors.png", 6, 1),
    }
    for bt_name, (sheet, col, row) in ROAD_CELLS.items():
        emit(bt_name, {"sheet": sheet, "w": 1, "h": 1, "cells": [[{"col": col, "row": row}]]})

    return n


def main():
    pages = load_pages()
    entries, overlays = parse_entries()

    out = {}
    n_overlay = 0
    unresolved_sheet = []
    for key, rows in sorted(entries.items()):
        built = build_grid(rows)
        if not built:
            continue
        page, w, h, grid, overhang = built
        sheet = pages.get(page)
        if not sheet:
            unresolved_sheet.append((key, page))
            continue
        entry = {"sheet": sheet, "w": w, "h": h, "cells": grid}
        if overhang:
            entry["overhang"] = overhang   # B14: art-row-0 cells drawn one tile above y1
        # B20: attach the tool/decoration overlay grid (same footprint, blit ON TOP
        # of the base cell by the client). Same sheet as the base in vanilla (the
        # OVERLAY page-cols sit further right on the SAME WORKSHOPS png), so a single
        # `overlaySheet` + `overlay` grid rides alongside `cells`; forward-compatible
        # (a client that doesn't know `overlay` just draws the base, unchanged).
        ov = overlays.get(key)
        if ov:
            ob = build_grid(ov)
            if ob:
                opage, _, _, ogrid, ooverhang = ob
                osheet = pages.get(opage)
                if osheet:
                    entry["overlaySheet"] = osheet
                    entry["overlay"] = ogrid
                    if ooverhang:
                        entry["overlayOverhang"] = ooverhang  # B14: overlay art above y1
                    n_overlay += 1
        out[key] = entry
        for alias in ALIASES.get(key, ()):
            out[alias] = entry

    # _default: a generic 1x1 workshop-ish fallback cell (first WORKSHOP_CUSTOM
    # cell, itself a stand-in DF uses for player-defined reaction workshops).
    default_sheet = pages.get("WORKSHOPS_1x1", pages.get("WORKSHOPS"))
    out["_default"] = {"sheet": default_sheet, "w": 1, "h": 1,
                        "cells": [[{"col": 0, "row": 0}]]}

    # ---- v2 additions ----
    furniture = build_furniture(out)
    wells = build_wells(out)
    machines = build_machines()
    bridges = parse_bridges()

    # ---- v3 (texsweep): top-level building_type-keyed DEFAULT entries -----------
    # THE COVERAGE GAP this closes: the client's buildingEntry() resolves a wire
    # building by looking up buildingMap[<building_type>] (+ a Type:Subtype alias);
    # it never reaches the nested `furniture`/`wells`/`machines`/`bridges` families
    # this generator emits. So every furniture/well/machine/bridge building fell to
    # MISSING_BUILDING (the "?" defaults box) -- doors, beds, tables, chairs,
    # coffins, statues, slabs, wells, water wheels, ... all showed a placeholder.
    # We now also emit a flat top-level key per df::building_type enum name so the
    # EXISTING resolver renders them. The cell is a DEFAULT material/state (the
    # per-material fidelity pick stays available in the nested `furniture` family
    # for the client's matFamily upgrade); the server-resolved b.rgb material tint
    # already recolours the sprite, so a stone door reads stone-grey, a metal bed
    # metallic, etc. FarmPlot has NO building sprite in vanilla (its tiles are
    # tilled-soil tiletypes + the crop renders via plant_map) -> a null-cell entry
    # so the client draws NOTHING over the crop instead of a grid of "?" boxes.
    n_bytype = _emit_bytype_defaults(out, furniture, wells, machines, bridges, pages)

    # B253: the statue family (pedestal x material class x quality, every subject
    # TOP/BOTTOM pair, all 932 creature statues). See build_statues()'s banner.
    statues = build_statues()

    out["_v"] = 3
    out["furniture"] = furniture
    out["wells"] = wells
    out["machines"] = machines
    out["bridges"] = bridges
    out["statues"] = statues

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)

    overlay = build_overlay_map()
    with open(OVERLAY_OUT, "w") as f:
        json.dump(overlay, f, indent=1, sort_keys=True)

    v1_keys = {k for k in out if k not in ("_v", "furniture", "wells", "machines", "bridges", "statues")}
    sheets = sorted({v["sheet"] for k, v in out.items() if k in v1_keys and v.get("sheet")})
    multi = sum(1 for k in v1_keys if k != "_default" and (out[k]["w"] > 1 or out[k]["h"] > 1))
    single = sum(1 for k in v1_keys if k != "_default" and out[k]["w"] == 1 and out[k]["h"] == 1)
    furniture_with_variant = sum(1 for v in furniture.values() if v.get("matvariants"))
    edge_floor_tokens = {"STOCKPILE_FLOOR", "STOCKPILE_N_UP", "STOCKPILE_N", "STOCKPILE_S",
                          "STOCKPILE_W_UP", "STOCKPILE_W", "STOCKPILE_E_UP", "STOCKPILE_E"}
    stockpile_glyphs = sum(1 for k in overlay["stockpile"] if k not in edge_floor_tokens)
    zone_inactive = sum(1 for k in overlay["zone"]
                         if k.startswith("ZONE_INACTIVE") and "SELECTED" not in k)

    bytype_keys = sorted(k for k in out if k and k[0].isupper() and k not in ("Workshop", "Furnace")
                         and not k.startswith(("BLD_", "WORKSHOP_", "FURNACE_", "WAGON_", "BALLISTA",
                                               "CATAPULT", "ROLLERS", "TRACK", "PLANNED", "SCREWPUMP",
                                               "GEAR", "AXLE", "WATER_WHEEL", "WINDMILL", "TRADE_DEPOT"))
                         and ":" not in k and "_" not in k)
    print(f"wrote {OUT}")
    print(f"v3 top-level building_type defaults emitted = {n_bytype}: {bytype_keys}")
    print(f"B20 overlay (tool/decor) layers attached      = {n_overlay}")
    print(f"buildings mapped (incl. aliases, v1 shape) = {len(v1_keys) - 1}  multi-tile={multi}  single-tile={single}")
    print(f"furniture keys = {len(furniture)} (with >=1 material variant: {furniture_with_variant})")
    print(f"wells states = {list(wells.keys())}")
    print(f"machine families (2 frames each) = {len(machines)}: {sorted(machines)}")
    print(f"bridge materials = {list(bridges.keys())} (cells/material: "
          f"{ {m: len(c) for m, c in bridges.items()} })")
    print("sheets:", sheets)
    if unresolved_sheet:
        print("unresolved sheet refs (skipped):", unresolved_sheet[:10])
    print(f"wrote {OVERLAY_OUT}")
    print(f"overlay stockpile glyph tokens = {len(overlay['stockpile'])} "
          f"(category glyphs incl. BLANK/CUSTOM: {stockpile_glyphs})")
    print(f"overlay zone tokens = {len(overlay['zone'])} (ZONE_INACTIVE adjacency: {zone_inactive})")
    print(f"overlay designation_priority levels = {len(overlay['designation_priority'])} "
          f"(expect 7: {sorted(overlay['designation_priority'])})")
    print(f"overlay designation_item marks = {len(overlay['designation_item'])} "
          f"(expect 6: {sorted(overlay['designation_item'])})")


if __name__ == "__main__":
    main()
