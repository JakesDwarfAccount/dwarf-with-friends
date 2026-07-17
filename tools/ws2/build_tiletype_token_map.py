#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WS2: build the tiletype -> graphics-token map that the browser tile renderer
# needs to blit DF's premium terrain sprites.
#
# THE PROBLEM this solves: DF's mapping from a live tile's df::tiletype enum to
# its on-screen sprite is HARDCODED in the DF binary, not in the raws. So the
# wire's per-tile `ttname` (a df::tiletype enum key such as "GrassLightFloor1",
# "SoilFloor2", "StoneWall") does NOT match the graphics TOKEN keys used by the
# sprite atlas / map.json (which are tokens like "GRASS_1", "DIRT_FLOOR_2",
# "STONE_WALL_N_S_W_E_1", "BOULDER"). We reconstruct that mapping here by
# classifying every tiletype enum-item on its (shape, material, variant) and
# emitting the matching representative token family. The output is a static JSON
# the client fetches once at boot.
#
# Run (uses the pre-installed venv, stdlib only):
#   python tools/ws2/build_tiletype_token_map.py
#
# Reads (READ-ONLY) DF's own data files to verify tokens exist; never writes to F:.
#   - <DFHACK_ROOT>\library\xml\df.d_basics.xml               (the tiletype enum)
#   - <DF_ROOT>\data\vanilla\...\graphics_*.txt               (available TOKENs)
# Writes:
#   - web/tiletype_token_map.json
#
# PHASE 1: walls/ramps use a sensible DEFAULT full-adjacency token (no neighbor
# data on the wire yet). PHASE 2 (noted, not done here): compute an N/S/E/W
# neighbor mask client-side and pick the joined wall/ramp token.

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
XML_PATH = os.path.join(os.environ.get("DFHACK_SRC", ""), "library", "xml", "df.d_basics.xml")
DF_GFX = dfroot.df_root_for(__file__, sub="data/vanilla/vanilla_environment/graphics",
                            purpose="reads DF's own graphics raws for the TOKEN list")
GFX_FILES = ["graphics_tiles.txt", "graphics_fluids.txt"]
OUT_PATH = os.path.join(REPO, "web", "tiletype_token_map.json")

# ---- default full-adjacency wall token (PHASE 1; no neighbor data yet) ----------
WALL_STONE = "STONE_WALL_N_S_W_E_1"
WALL_SOIL = "SOIL_WALL_N_S_W_E_1"
WALL_ICE = "ICE_WALL_N_S_W_E"
WALL_MAGMA = "MAGMA_WALL_N_S_W_E"

# Materials that render on the "stone" sheets (floors/walls/ramps/stairs/boulders).
STONE_MATS = {"STONE", "MINERAL", "FEATURE", "LAVA_STONE", "CONSTRUCTION", "HFS"}
GRASS_MATS = {"GRASS_LIGHT", "GRASS_DARK", "GRASS_DRY", "GRASS_DEAD"}
# WB-4 (fog report §1/§4.5): GrassLight and GrassDark measured IDENTICAL (same texpos, same
# rendered color) -- the previous 4-way tint split was fog debt. One calibrated summer wash
# for all four grass mats now (client TINT_COLORS["grassSummer"], dwf-tiles.js); dry/
# dead keep their own ttnames (distinct sprites/tokens untouched) but share the same wash
# until a seasonal recolor pass (W-C) keys it on season.
GRASS_TINT = {
    "GRASS_LIGHT": "grassSummer",
    "GRASS_DARK": "grassSummer",
    "GRASS_DRY": "grassSummer",
    "GRASS_DEAD": "grassSummer",
}


def parse_tiletype_enum(path):
    """Line-scan the df::tiletype enum block. The file is DFHack's pseudo-XML
    (bare `--` comments, trailing text after `>`), so a real XML parser chokes;
    a scoped line scanner is robust here."""
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.readlines()

    start = None
    for i, ln in enumerate(lines):
        if "enum-type type-name='tiletype'" in ln:
            start = i
            break
    if start is None:
        raise SystemExit("could not find the tiletype enum-type in " + path)

    items = []
    cur = None
    item_re = re.compile(r"<enum-item\s+name='([^']+)'")
    attr_re = re.compile(r"<item-attr\s+name='([^']+)'\s+value='([^']*)'")
    for ln in lines[start + 1:]:
        if "</enum-type>" in ln:
            break
        m = item_re.search(ln)
        if m:
            if cur is not None:
                items.append(cur)
            cur = {"name": m.group(1), "shape": "NONE", "material": "NONE",
                   "variant": "NONE", "special": "NONE"}
            # an <enum-item ...> line can also carry inline attrs on later lines
            continue
        if cur is None:
            continue
        a = attr_re.search(ln)
        if a and a.group(1) in cur:
            cur[a.group(1)] = a.group(2)
    if cur is not None:
        items.append(cur)
    return items


def load_available_tokens():
    """Read DF's graphics_*.txt to collect the TOKENs that actually exist, so we
    never point the client at a token with no sprite cell."""
    toks = set()
    tg = re.compile(r"TILE_GRAPHICS:[^:\]]+:\d+:\d+:([A-Z0-9_]+)")
    for name in GFX_FILES:
        p = os.path.join(DF_GFX, name)
        if not os.path.exists(p):
            continue
        with open(p, "r", encoding="utf-8", errors="replace") as fh:
            for ln in fh:
                for m in tg.finditer(ln):
                    toks.add(m.group(1))
    return toks


_COMPASS = ("N", "S", "E", "W", "NE", "NW", "SE", "SW")


def direction_suffix(name, prefix):
    """Strip `prefix` off `name` and return the trailing compass-direction token (one of
    _COMPASS), or None if what remains isn't a plain direction (e.g. "RiverSource" after
    stripping "River" leaves "Source", not a direction -- callers handle those specials
    separately). Used by the WC-9 brook/river families, which name their 8-way ttnames
    directly after the compass point (BrookNW, RiverRampSE, ...) rather than via a bitmask."""
    if not name.startswith(prefix):
        return None
    rest = name[len(prefix):]
    return rest if rest in _COMPASS else None


def variant_num(item):
    """VAR_1..VAR_4 -> 1..4; fall back to a trailing digit in the enum key; else 1."""
    v = item.get("variant", "NONE")
    m = re.match(r"VAR_(\d+)", v or "")
    if m:
        return int(m.group(1))
    m = re.search(r"(\d)$", item["name"])
    if m:
        n = int(m.group(1))
        if 1 <= n <= 4:
            return n
    return 1


def classify(item):
    """Return (token, tint) or (None, None) to leave the client on its color
    fallback. Covers the common in-play families: grass light/dark/dry/dead
    floors, soil floors, stone floors, walls (default adjacency), ramps, stairs,
    boulders, pebbles, fortifications."""
    shape = item["shape"]
    mat = item["material"]
    spec = item["special"]
    v = variant_num(item)

    # WC-9: fire is material-only, spanning shapes FLOOR/WALL/RAMP/BRANCH/TWIG (the
    # tiletype enum's Fire + all 6 BurningTree* items). Only one real fire cell exists in
    # the raws (FIRE; no distinct burning-tree-wall/branch/twig art) -- so every fire-
    # material tiletype, of any shape, gets that same real cell rather than being left
    # uncovered. Checked before the shape dispatch so it applies uniformly.
    if mat == "FIRE":
        return "FIRE", None

    # WC-9: brook/river/pool BEDS -- the terrain under the water. The water's own depth
    # look (liquids.png cols 0-1, row=7-depth) is the client's existing, unrelated overlay
    # (resolveLiquidSprite); this map only supplies the dry-look bed sprite underneath.
    if shape == "BROOK_BED":
        d = direction_suffix(item["name"], "Brook")
        return ("BROOK_BED_%s" % d if d else "BROOK_BED"), None
    if shape == "BROOK_TOP":
        # No dedicated BROOK_TOP_n cell exists in the raws (verified: only BROOK_BED*/
        # BROOK_TO_* tokens are bound on the BROOK* pages) -- BrookTop1..4 are still/
        # shallow brook tiles, so the generic bed cell is the closest REAL sprite, not a
        # fabrication.
        return "BROOK_BED", None

    if shape == "ENDLESS_PIT":
        if mat == "HFS":
            return "EERIE_PIT", None
        return None, None  # Chasm (material AIR): no terrain sprite in the raws -- DF's
                            # own void look already matches the client's flat AIR fallback

    # B47 ("constructions show as generic stone"): CONSTRUCTION used to be lumped into
    # STONE_MATS, so a built wall/floor rendered the NATURAL smoothed-stone art. DF ships
    # dedicated construction art (graphics_tiles.txt: FLOOR_STONE_BLOCK, the 19-cell
    # ROCK_BLOCKS_WALL_* adjacency family) -- the dressed-block look DF itself draws for
    # constructions. Checked BEFORE the shape dispatch's STONE_MATS membership so floors
    # and walls both route to the block family; ramps/stairs keep the stone family (no
    # dedicated block ramp/stair art exists in the raws -- verified, not a fabrication).
    # The material-specific half (a WOOD construction should use WALL_WOODEN/FLOOR_WOOD +
    # material tint) needs the construction's material on the wire, which baseMaterialAt
    # does NOT provide (base_mt=-1 on constructed tiles) -- that is the staged wire_v1.cpp
    # fix; this token-map half alone already replaces "natural rock" with "built blocks".
    if mat == "CONSTRUCTION":
        if shape == "FLOOR":
            return "FLOOR_STONE_BLOCK", None
        if shape == "WALL":
            return "ROCK_BLOCKS_WALL_N_S_W_E", None

    if shape == "FLOOR":
        # WB-3 (2026-07-07): the previous comment here said "cells _1..4 are sparse/near-
        # transparent detail overlays" and collapsed every stone/soil floor variant onto
        # the dense _5 cell, discarding the wire's own variant digit. render-buffer verdict
        # §D found DF's render IS a per-variant-distinct, per-tile-stable function of the
        # ttname (SoilFloor1..4 -> four distinct, stable texpos) -- but a direct pixel check
        # this session (floors.png DIRT_FLOOR_1..4 / STONE_FLOOR_1..4: mean alpha 5-21/255,
        # i.e. genuinely near-transparent; _5: fully opaque) proved the ORIGINAL transparency
        # claim correct too: these are OVERLAY detail cells, not standalone replacements.
        # Fix = spec's option 1 (preferred): keep the dense, opaque _5 as the BASE token
        # (so a floor never regresses to near-blank), and add a same-tiletype `overlay` cell
        # = the variant-specific detail (_<v>) the client blits ON TOP of the base -- this
        # reproduces DF's per-tile variant CHOICE (validated bijectively by
        # tools/ws2/validate_variation.py, keyed on the overlay field) without ever losing
        # the dense fill a straight swap to _1..4 alone would (that regressed U2 parity
        # 32->37 MAE in this session's own gate run -- direct-swap was tried and reverted).
        if mat in GRASS_MATS:
            # Grass is drawn via the client's grass.png override (GRASS_1..4 = dense
            # cells), so keep the variant for per-tile texture variety.
            return "GRASS_%d" % min(v, 4), GRASS_TINT[mat]
        if mat == "SOIL":
            return {"token": "DIRT_FLOOR_5", "overlay": "DIRT_FLOOR_%d" % v}, None
        if mat in STONE_MATS:
            # B74 ("no textures for smoothed floors"): a player-smoothed natural stone floor
            # (df::tiletype special=SMOOTH -- StoneFloorSmooth/MineralFloorSmooth/
            # FeatureFloorSmooth/LavaFloorSmooth) is a DISTINCT tiletype from the rough
            # StoneFloor1..4, and DF draws it with its own dedicated SMOOTH_FLOOR cell
            # (graphics_tiles.txt), NOT the rough STONE_FLOOR_5 + sparse-detail overlay. The
            # classifier previously ignored `special`, collapsing smoothed floors onto the rough
            # cell -- so they rendered identically to unsmoothed stone. (Smoothed ICE already
            # routes to SMOOTH_ICE_FLOOR via the FROZEN_LIQUID branch below; this is the stone-
            # family parallel.) Engraved floors carry their decal via the engraving overlay pass.
            if spec == "SMOOTH":
                return "SMOOTH_FLOOR", None
            return {"token": "STONE_FLOOR_5", "overlay": "STONE_FLOOR_%d" % v}, None
        # WC-9: river/pool beds, frozen-liquid floors, campfire/ashes/driftwood/magma-flow --
        # the coverage audit's "sparse layer" gap rows (§2.1 #10-13).
        if mat == "RIVER":
            if spec == "RIVER_SOURCE":
                return "RIVER_BED_SOURCE", None
            if spec == "WATERFALL":
                return "RIVER_BED", None  # mist/foam is WC-15's animation concern
            d = direction_suffix(item["name"], "River")
            return ("RIVER_BED_%s" % d if d else "RIVER_BED"), None
        if mat == "POOL":
            # MurkyPool: no dedicated pool-bed cell in the raws -- the river bed is the
            # closest real "standing water over a bed" sprite DF ships.
            return "RIVER_BED", None
        if mat == "FROZEN_LIQUID":
            return ("SMOOTH_ICE_FLOOR" if spec in ("SMOOTH", "SMOOTH_DEAD")
                    else "ROUGH_ICE_FLOOR"), None
        if mat == "CAMPFIRE":
            return "CAMPFIRE", None
        if mat == "ASHES":
            return "FLOOR_ASHES", None  # one token, 3 variant ttnames (Ashes1..3) --
                                          # frame/variant animation is WC-10's concern
        if mat == "DRIFTWOOD":
            return "DRIFTWOOD", None
        if mat == "MAGMA":
            return "MAGMA_1", None  # MagmaFlow: single ttname, no variant digit
        return None, None

    if shape in ("WALL", "FORTIFICATION"):
        if shape == "FORTIFICATION":
            if mat == "FROZEN_LIQUID":
                return "FORTIFICATION_ICE", None
            return "FORTIFICATION", None
        if mat == "SOIL":
            return WALL_SOIL, None
        if mat == "FROZEN_LIQUID":
            return WALL_ICE, None
        if mat == "MAGMA":
            return WALL_MAGMA, None
        if mat in STONE_MATS:
            return WALL_STONE, None
        return None, None

    if shape in ("RAMP", "RAMP_TOP"):
        if mat in GRASS_MATS:
            return "GRASS_RAMP_OTHER", GRASS_TINT[mat]
        if mat == "SOIL":
            return "SOIL_RAMP_OTHER", None
        if mat in STONE_MATS:
            return "STONE_RAMP_OTHER", None
        if mat == "RIVER":
            d = direction_suffix(item["name"], "RiverRamp")
            return ("RIVER_BED_%s" % d if d else "RIVER_BED"), None
        if mat == "POOL":
            return "RIVER_BED", None
        if mat == "FROZEN_LIQUID":
            # No dedicated ice-ramp art in the raws -- the flat ice floor cell is a real,
            # non-fabricated stand-in (same "OTHER" fallback pattern as the stone/soil/
            # grass ramp families above).
            return "ROUGH_ICE_FLOOR", None
        return None, None

    if shape in ("STAIR_UP", "STAIR_DOWN", "STAIR_UPDOWN"):
        suffix = {"STAIR_UP": "UP", "STAIR_DOWN": "DOWN",
                  "STAIR_UPDOWN": "UPDOWN"}[shape]
        if mat in GRASS_MATS:
            return "GRASS_STAIR_%s" % suffix, None
        if mat == "SOIL":
            return "DIRT_STAIR_%s" % suffix, None
        if mat in STONE_MATS:
            return "STONE_STAIR_%s" % suffix, None
        if mat == "FROZEN_LIQUID":
            return "ROUGH_ICE_FLOOR", None  # no ice-stair art; see RAMP note above
        # UnderworldGateStair{U,D,UD}: no dedicated token in the raws -- left uncovered
        # (flat color fallback); rare enough to be a documented best-effort gap.
        return None, None

    if shape == "BOULDER":
        return "BOULDER", None

    if shape == "PEBBLES":
        # B241 ("limestone pebbles don't render at all"): DF ships FOUR dense pebble-floor
        # cells -- FLOOR_PEBBLES cols 0-3 = PEBBLES_FLOOR_5 / 5B / 5C / 5D
        # (graphics_tiles.txt L118-121) -- and the pebble tiletypes carry VAR_1..VAR_4,
        # exactly one variant digit per dense cell. Key the cell off the tiletype's own
        # variant (the same per-tile-stable signal DF itself stores) instead of collapsing
        # all four onto _5. The 1..4 digit separately keys the SPARSE grass-composite
        # overlay (PEBBLES_FLOOR_1..4) in the renderers' grass-under path -- that path
        # bypasses this map entirely, so no conflict.
        dense = ["PEBBLES_FLOOR_5", "PEBBLES_FLOOR_5B",
                 "PEBBLES_FLOOR_5C", "PEBBLES_FLOOR_5D"]
        return dense[min(v, 4) - 1], None

    return None, None


def main():
    items = parse_tiletype_enum(XML_PATH)
    available = load_available_tokens()
    have_tokens = bool(available)

    out = {}
    fam_counts = {}
    skipped_missing = []
    overlay_count = 0
    for it in items:
        token, tint = classify(it)
        if token is None:
            continue
        # WB-3 option 1 (base+overlay composite): classify() may return a dict
        # {"token": <dense base>, "overlay": <sparse per-variant detail>} instead of a
        # bare token string. Both cells must exist in DF's graphics files independently --
        # an overlay whose cell is missing degrades to the base alone (still correct,
        # just un-detailed), never to a skipped/uncovered tiletype.
        if isinstance(token, dict):
            base_tok = token["token"]
            overlay_tok = token.get("overlay")
        else:
            base_tok = token
            overlay_tok = None
        if have_tokens and base_tok not in available:
            # Chosen token is not present in DF's graphics files -> don't emit it;
            # the client falls back to flat color for this tiletype.
            skipped_missing.append((it["name"], base_tok))
            continue
        if overlay_tok and have_tokens and overlay_tok not in available:
            overlay_tok = None  # cell doesn't exist -> drop the overlay, keep the base
        entry = {"token": base_tok}
        entry["tint"] = tint  # explicit null when untinted, per the wire contract
        if overlay_tok:
            entry["overlay"] = overlay_tok
            overlay_count += 1
        out[it["name"]] = entry
        fam = re.sub(r"_\d.*$", "", base_tok)
        fam = re.sub(r"_(N|S|E|W)(_.*)?$", "", fam)
        fam_counts[fam] = fam_counts.get(fam, 0) + 1

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")

    print("tiletype enum-items scanned : %d" % len(items))
    print("available DF tokens loaded  : %d (%s)"
          % (len(available), "F: graphics files" if have_tokens
             else "NONE - F: unreadable, emitted without existence check"))
    print("tiletypes mapped            : %d" % len(out))
    print("wrote                       : %s" % OUT_PATH)
    print("by token family:")
    for fam in sorted(fam_counts, key=lambda k: (-fam_counts[k], k)):
        print("   %-22s %d" % (fam, fam_counts[fam]))
    tinted = sum(1 for e in out.values() if e["tint"])
    print("tinted (grass) entries      : %d" % tinted)
    print("base+overlay entries (WB-3) : %d" % overlay_count)
    if skipped_missing:
        print("skipped (token not in DF gfx): %d e.g. %s"
              % (len(skipped_missing), skipped_missing[:5]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
