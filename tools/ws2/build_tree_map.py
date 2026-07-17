#!/usr/bin/env python3
"""
build_tree_map.py -- WS2 v2 (WC-13)

Read-only parser over Dwarf Fortress v50's vanilla tree graphics raws. Emits
a JSON lookup: tree species -> family -> variant -> sprite sheet cell.

v1 (see git history) picked ONE representative cell per {TRUNK, BRANCH,
CANOPY, LEAVES} and skipped OVERLEAVES/LEAFLESS/CAP-RAMP/BASE entirely,
collapsing ~200 directional tiletypes down to 4 cells/species (audit gap
2.1 "tree-part geometry"). v2 keeps EVERY [TREE_TILE:TOKEN:PAGE:col:row]
binding, structured `species -> family -> variantKey -> cell`, so the
client (WC-14) can pick the exact directional/connectivity cell a tree's
~200-tiletype vocabulary calls for instead of one fallback per part.

Inputs (read-only, never modified):
  .../vanilla_plants_graphics/graphics/graphics_individual_trees.txt
  .../vanilla_plants_graphics/graphics/graphics_plants.txt   (generic TREES
      page fallback -- see GENERIC FALLBACK below)
  .../vanilla_plants_graphics/graphics/tile_page_plants.txt

Output:
  <REPO>\\web\\tree_map.json

Token grammar (verified this session)
--------------------------------------
graphics_individual_trees.txt:
    [PLANT_GRAPHICS:<SPECIES_ID>]
        [TREE_TILE:<TOKEN>:<TILE_PAGE>:<COL>:<ROW>]
        [SAPLING:<TILE_PAGE>:<COL>:<ROW>]
        [GROWTH:...] / [SEED:...] (ignored -- fruit/flower/seed graphics, not
            tree body; growths are a separate content class, tracked in the
            audit's "shrub per-species growth-stage cells" deferred row)
    Lines suffixed "=> uses empty tile" (the TREE_CAP_RAMP_* tokens) render
    NOTHING per the raw file's own comment -- skipped, never emitted as a cell
    (a "cell" here would be a lie: DF draws the true floor/ramp tile beneath).

    72 species have a [PLANT_GRAPHICS:...] block; only 20 of them carry their
    own [TREE_TILE:...] lines (individual per-species art). The other 52
    (verified: oak, mahogany, acacia, most fruit trees, ...) have ONLY
    [SAPLING:...]/[GROWTH:...] lines -- DF renders their full-grown form with
    the shared generic renderer (see GENERIC FALLBACK). All 72 species DO
    carry their own [SAPLING:...] line (verified, no species is missing one).

<TOKEN> encodes a structural part + a directional/connectivity suffix. Every
token in the file (4688 TREE_TILE bindings, zero left unclassified -- verified
by exhaustive prefix-matching this session) falls into one of the families
below (`FAMILY_PREFIXES`, checked longest-prefix-first so e.g. "TRUNK_THICK"
is not swallowed by the plain "TRUNK" bucket):
    TREE_TRUNK        : directional/adjacency variants (N/S/W/E/NW.../NSWE,
                         lowercase sub-adjacency e.g. S_nwe, SLOPE_* ramp
                         variants) -- 1134 bindings file-wide.
    TREE_TRUNK_THICK   : 3x3 thick-trunk NW..SE + INTERIOR -- 180 bindings.
    TREE_TRUNK_PILLAR  : single 1-tile trunk -- 20 bindings (no variant text).
    TREE_BRANCH        : light branch directional variants -- 256 bindings.
    TREE_HEAVY_BRANCH  : heavy branch directional variants -- 1074 bindings.
    TREE_TWIGS         : canopy twigs (FULL1..4, N/S/W/E/NSWE/...) -- 588.
    TREE_LEAFLESS_TWIGS: bare-twig (dead/winter) variants -- 384 bindings.
    TREE_OVERLEAVES    : decorative overleaf variants (incl. _AUTUMN) -- 600.
    TREE_CAP           : mushroom-tree "cap" body (PILLAR, WALL_*, WALL_THICK_*,
                         THICK_INTERIOR, FLOOR_1..4; RAMP_* skipped) -- 180
                         bindings, present only for mushroom species (goblin
                         cap, nether cap, tower cap, black cap, ...).
    TREE_BASE          : ground-contact shadow/trunk-base variants -- 272.
    SAPLING            : single cell, not a family table (from [SAPLING:...]).

GENERIC FALLBACK (the "52 species without unique sheets" -- audit's own "good
news"): graphics_plants.txt's TREES tile page carries the SAME family/variant
token vocabulary via plain [TILE_GRAPHICS:TREES:col:row:TOKEN] lines (291
bindings, verified: identical family distribution to an individual species'
own block) -- this IS the data-driven generic broadleaf tree DF's engine
falls back to; earlier tooling assumed no such data existed, that assumption
was wrong. Every species without its own [TREE_TILE:...] lines gets this
generic family/variant table (its own per-species [SAPLING:...] cell is kept,
since that IS always species-specific). `_default` = this same generic table.

Back-compat: TRUNK/BRANCH/CANOPY/LEAVES/SAPLING flat single-cell keys (v1's
shape) are kept on every species entry, picking the same representative
cells v1 picked, for clients mid-migration.
"""

import json
import re
from pathlib import Path

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

DF_GFX_DIR = Path(dfroot.df_root_for(
    __file__, sub="data/vanilla/vanilla_plants_graphics/graphics",
    purpose="reads DF's own tree/plant graphics raws"))
TREES_FILE = DF_GFX_DIR / "graphics_individual_trees.txt"
PLANTS_FILE = DF_GFX_DIR / "graphics_plants.txt"
TILE_PAGE_FILE = DF_GFX_DIR / "tile_page_plants.txt"
OUT_FILE = Path(__file__).resolve().parents[2] / "web" / "tree_map.json"

GENERIC_PAGE = "TREES"  # the page holding the data-driven generic tree fallback

# (prefix within TOKEN after stripping "TREE_", family name). Order matters:
# checked top-to-bottom, first match wins, so more-specific prefixes that are
# also a substring of a shorter one (TRUNK_THICK vs TRUNK) must come first.
FAMILY_PREFIXES = [
    ("TRUNK_THICK", "TREE_TRUNK_THICK"),
    ("TRUNK_PILLAR", "TREE_TRUNK_PILLAR"),
    ("BASE", "TREE_BASE"),
    ("TRUNK", "TREE_TRUNK"),
    ("HEAVY_BRANCH", "TREE_HEAVY_BRANCH"),
    ("BRANCH", "TREE_BRANCH"),
    ("LEAFLESS_TWIGS", "TREE_LEAFLESS_TWIGS"),
    ("TWIGS", "TREE_TWIGS"),
    ("OVERLEAVES", "TREE_OVERLEAVES"),
    ("CAP", "TREE_CAP"),
]

# v1's representative-cell picks, kept verbatim for the back-compat flat keys.
TRUNK_PREF = ["TREE_TRUNK_PILLAR", "TREE_TRUNK_NSWE", "TREE_TRUNK_THICK_INTERIOR", "TREE_TRUNK_NS"]
BRANCH_PREF = ["TREE_BRANCH_NSWE", "TREE_BRANCH", "TREE_HEAVY_BRANCH_NSWE", "TREE_HEAVY_BRANCH"]
CANOPY_PREF = ["TREE_CAP_PILLAR", "TREE_CAP_THICK_INTERIOR"]
TWIGS_FULL_PREF = ["TREE_TWIGS_FULL1"]
LEAVES_CAP_PREF = ["TREE_CAP_WALL_N_S_W_E"]
LEAVES_TWIGS_PREF = ["TREE_TWIGS_NSWE", "TREE_TWIGS"]


def parse_tile_pages(path: Path) -> dict:
    pages = {}
    current = None
    page_re = re.compile(r"\[TILE_PAGE:(\w+)\]")
    file_re = re.compile(r"\[FILE:images/([\w.\-]+)\]")
    for raw_line in path.read_text(encoding="latin-1").splitlines():
        line = raw_line.strip()
        m = page_re.match(line)
        if m:
            current = m.group(1)
            continue
        m = file_re.match(line)
        if m and current:
            pages[current] = m.group(1)
    return pages


def parse_species(path: Path) -> dict:
    """[PLANT_GRAPHICS:ID] blocks -> {"tiles": [(token,page,col,row)], "sapling": (page,col,row)|None}."""
    species = {}
    current = None
    species_re = re.compile(r"\[PLANT_GRAPHICS:([\w\-]+)\]")
    tile_re = re.compile(r"\[TREE_TILE:([A-Za-z0-9_]+):([A-Za-z0-9_]+):(\d+):(\d+)\]")
    sapling_re = re.compile(r"\[SAPLING:([A-Za-z0-9_]+):(\d+):(\d+)\]")

    for raw_line in path.read_text(encoding="latin-1").splitlines():
        line = raw_line.strip()

        m = species_re.match(line)
        if m:
            current = m.group(1)
            species[current] = {"tiles": [], "sapling": None}
            continue

        if current is None:
            continue

        if "uses empty tile" in line:
            continue  # TREE_CAP_RAMP_* tokens render nothing

        m = tile_re.match(line)
        if m:
            token, page, col, row = m.groups()
            species[current]["tiles"].append((token, page, int(col), int(row)))
            continue

        m = sapling_re.match(line)
        if m:
            page, col, row = m.groups()
            species[current]["sapling"] = (page, int(col), int(row))

    return species


def parse_generic_tree_tiles(path: Path) -> list:
    """graphics_plants.txt's TREES-page [TILE_GRAPHICS:TREES:col:row:TOKEN]
    lines -- the data-driven generic broadleaf tree fallback."""
    tg = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):([A-Za-z0-9_]+)\]")
    tiles = []
    for raw_line in path.read_text(encoding="latin-1").splitlines():
        line = raw_line.strip()
        if "uses empty tile" in line:
            continue
        m = tg.match(line)
        if m:
            page, col, row, token = m.groups()
            if page == GENERIC_PAGE and token.startswith("TREE_"):
                tiles.append((token, page, int(col), int(row)))
    return tiles


def family_of(token: str):
    """token (e.g. TREE_TRUNK_THICK_NW) -> (family, variant) e.g.
    ("TREE_TRUNK_THICK", "NW"). variant is "_" for a family with no
    directional suffix at all (e.g. bare TREE_TRUNK_PILLAR)."""
    assert token.startswith("TREE_"), token
    rest = token[len("TREE_"):]
    for prefix, family in FAMILY_PREFIXES:
        if rest.startswith(prefix):
            variant = rest[len(prefix):].lstrip("_")
            return family, (variant or "_")
    return None, None


def build_family_tables(tiles: list, tile_pages: dict) -> dict:
    """[(token,page,col,row)] -> {family: {variant: cell}}, first-binding-wins
    per (family, variant)."""
    tables = {}
    for token, page, col, row in tiles:
        family, variant = family_of(token)
        if family is None:
            continue  # unreachable given the exhaustive prefix list (verified)
        cell = {"sheet": sheet_for(page, tile_pages), "col": col, "row": row}
        tables.setdefault(family, {})
        tables[family].setdefault(variant, cell)
    return tables


def _pick(cands: list, preferred: list):
    if not cands:
        return None
    for pref in preferred:
        for c in cands:
            if c[0].upper() == pref:
                return c
    return cands[0]


def flat_parts(tiles: list, sapling, tile_pages: dict) -> dict:
    """v1 back-compat: one representative cell per {TRUNK,BRANCH,CANOPY,LEAVES,SAPLING}."""
    trunk, branch = [], []
    cap_body, cap_wall = [], []
    twigs_full, twigs_other = [], []

    for token, page, col, row in tiles:
        t = token.upper()
        if "CAP" in t:
            if "WALL" in t:
                cap_wall.append((token, page, col, row))
            elif "RAMP" in t or "FLOOR" in t:
                continue
            else:
                cap_body.append((token, page, col, row))
        elif "OVERLEAVES" in t:
            continue
        elif "TRUNK" in t and "BASE" not in t and "SLOPE" not in t:
            trunk.append((token, page, col, row))
        elif "HEAVY_BRANCH" in t or "BRANCH" in t:
            branch.append((token, page, col, row))
        elif "LEAFLESS_TWIGS" in t:
            continue
        elif "TWIGS" in t:
            (twigs_full if "FULL" in t else twigs_other).append((token, page, col, row))

    out = {}
    tr = _pick(trunk, TRUNK_PREF)
    if tr:
        out["TRUNK"] = {"sheet": sheet_for(tr[1], tile_pages), "col": tr[2], "row": tr[3]}
    br = _pick(branch, BRANCH_PREF)
    if br:
        out["BRANCH"] = {"sheet": sheet_for(br[1], tile_pages), "col": br[2], "row": br[3]}
    canopy = _pick(cap_body, CANOPY_PREF) or _pick(twigs_full, TWIGS_FULL_PREF)
    if canopy:
        out["CANOPY"] = {"sheet": sheet_for(canopy[1], tile_pages), "col": canopy[2], "row": canopy[3]}
    leaves = _pick(cap_wall, LEAVES_CAP_PREF) or _pick(twigs_other, LEAVES_TWIGS_PREF)
    if leaves:
        out["LEAVES"] = {"sheet": sheet_for(leaves[1], tile_pages), "col": leaves[2], "row": leaves[3]}
    if sapling:
        page, col, row = sapling
        out["SAPLING"] = {"sheet": sheet_for(page, tile_pages), "col": col, "row": row}
    return out


def sheet_for(page: str, tile_pages: dict) -> str:
    return tile_pages.get(page, page.lower() + ".png")


def build():
    tile_pages = parse_tile_pages(TILE_PAGE_FILE)
    species = parse_species(TREES_FILE)
    generic_tiles = parse_generic_tree_tiles(PLANTS_FILE)
    generic_families = build_family_tables(generic_tiles, tile_pages)
    generic_flat = flat_parts(generic_tiles, None, tile_pages)

    tree_map = {}
    n_individual = 0
    n_generic = 0

    for species_id, data in species.items():
        if data["tiles"]:
            entry = flat_parts(data["tiles"], data["sapling"], tile_pages)
            entry.update(build_family_tables(data["tiles"], tile_pages))
            n_individual += 1
        else:
            # 52-species case: reuse the generic family/variant tables and
            # generic flat parts, but keep this species' OWN sapling cell.
            entry = dict(generic_flat)
            entry.update({k: dict(v) for k, v in generic_families.items()})
            if data["sapling"]:
                page, col, row = data["sapling"]
                entry["SAPLING"] = {"sheet": sheet_for(page, tile_pages), "col": col, "row": row}
            n_generic += 1
        tree_map[species_id] = entry

    tree_map["_default"] = dict(generic_flat)
    tree_map["_default"].update({k: dict(v) for k, v in generic_families.items()})
    tree_map["_v"] = 2

    return tree_map, n_individual, n_generic


def main():
    tree_map, n_individual, n_generic = build()

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(tree_map, indent=1, sort_keys=True), encoding="utf-8")

    # validate round-trip
    reparsed = json.loads(OUT_FILE.read_text(encoding="utf-8"))
    assert reparsed == tree_map

    sheets = set()
    for species_id, entry in tree_map.items():
        if species_id == "_v":
            continue
        for key, val in entry.items():
            if isinstance(val, dict) and "sheet" in val:
                sheets.add(val["sheet"])
            elif isinstance(val, dict):
                for cell in val.values():
                    sheets.add(cell["sheet"])
    sheets = sorted(sheets)

    maple = tree_map.get("MAPLE", {})
    maple_families = [k for k in maple if k.startswith("TREE_")]
    maple_cells = sum(len(v) for k, v in maple.items() if k.startswith("TREE_") and isinstance(v, dict))

    print(f"species (individual art): {n_individual}")
    print(f"species (generic fallback): {n_generic}")
    print(f"total species mapped: {n_individual + n_generic} (+ _default)")
    print(f"MAPLE: {maple_cells} distinct cells across {len(maple_families)} families "
          f"({', '.join(sorted(maple_families))})")
    print(f"MAPLE has TREE_TRUNK_THICK.INTERIOR: {'INTERIOR' in maple.get('TREE_TRUNK_THICK', {})}")
    print(f"MAPLE has TREE_TRUNK.NSWE: {'NSWE' in maple.get('TREE_TRUNK', {})}")
    tower_cap = tree_map.get("TOWER_CAP", {})
    print(f"TOWER_CAP has TREE_CAP family: {'TREE_CAP' in tower_cap} "
          f"({len(tower_cap.get('TREE_CAP', {}))} cells)")
    print(f"sheets referenced: {len(sheets)} -> {sheets}")
    print(f"wrote {OUT_FILE}")


if __name__ == "__main__":
    main()
