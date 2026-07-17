#!/usr/bin/env python3
"""
build_plant_map.py

Read-only parser over the vanilla Dwarf Fortress v50 plant/shrub graphics
raws to build a plant-id -> sprite-sheet-coordinate lookup table for a
premium-sprite web renderer.

Inputs (read-only, never modified):
  <your DF install>\\data\\vanilla\\
      vanilla_plants_graphics\\graphics\\
        tile_page_plants.txt              (TILE_PAGE -> png file)
        graphics_plant_standard_shrubs.txt (PLANT_GRAPHICS blocks, wild shrubs)
        graphics_plant_garden.txt          (PLANT_GRAPHICS blocks, garden crops)
        graphics_plant_crops.txt           (PLANT_GRAPHICS blocks, farm crops)
        graphics_plants.txt                (generic TILE_GRAPHICS:PLANTS fallback
                                             tiles used when a plant has no raw
                                             graphics tag at all)

Output:
  <repo>\\web\\plant_map.json

Token format (confirmed by reading the raws directly):
  Species files use blocks of the form:
      [PLANT_GRAPHICS:<PLANT_ID>]
          [SHRUB:<TILE_PAGE>:<col>:<row>]
          [PICKED:<TILE_PAGE>:<col>:<row>]
          [SEED:<TILE_PAGE>:<col>:<row>]
          [SHRUB_DEAD:<TILE_PAGE>:<col>:<row>]
          [GROWTH:<NAME>]
              [GROWTH_PICKED:<TILE_PAGE>:<col>:<row>]   (nested, one extra tab)
          ...
  We only need the [SHRUB:...] tag per block (the live, standing-shrub tile,
  which is what the wire's `plant.part == SHRUB` case wants). None of the
  three species files contain a per-species [SAPLING:...] tag -- SAPLING is
  only tagged per-species in graphics_individual_trees.txt (real trees, out
  of scope per task instructions), so no shrub/crop plant has a species-
  specific sapling sprite in these raws.

  graphics_plants.txt instead defines the game's generic fallback tile pair
  used for any plant lacking specific graphics:
      [TILE_GRAPHICS:PLANTS:0:0:SHRUB]
      [TILE_GRAPHICS:PLANTS:0:1:SAPLING]
  These become _default_shrub / _default_sapling (sheet "plants.png").

TILE_PAGE -> png resolution comes from tile_page_plants.txt's
  [TILE_PAGE:<NAME>] / [FILE:images/<file>.png] pairs (basename only is kept
  in the output, e.g. "plant_standard.png", matching how the other sheets
  named in tile_page_plants.txt are referenced elsewhere in this project).
"""
import json
import re
from pathlib import Path

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

DF_GRAPHICS_DIR = Path(dfroot.df_root_for(
    __file__, sub="data/vanilla/vanilla_plants_graphics/graphics",
    purpose="reads DF's own plant graphics raws"))
OUT_PATH = Path(__file__).resolve().parents[2] / "web" / "plant_map.json"

SPECIES_FILES = [
    "graphics_plant_standard_shrubs.txt",
    "graphics_plant_garden.txt",
    "graphics_plant_crops.txt",
    # WIRE-TAILS B27 follow-up (counterexample: "finger lime seeds" placeholder): fruit
    # TREES carry per-species [SEED:TREE_GROWTHS:col:row] tags in their own PLANT_GRAPHICS
    # blocks here -- tree-derived seed items are a whole matrix region the 3 files above
    # miss. Tree blocks have no top-level SHRUB (their SAPLING tag is not in WANTED_TAGS and
    # the nested two-tab GROWTH_PICKED lines don't match TOP_TAG_RE), so tree species
    # contribute {SEED: ...} entries only -- additive, no shrub/crop entry changes.
    "graphics_individual_trees.txt",
]
TILE_PAGE_FILE = "tile_page_plants.txt"
GENERIC_PLANTS_FILE = "graphics_plants.txt"

PLANT_GRAPHICS_RE = re.compile(r"^\[PLANT_GRAPHICS:([A-Za-z0-9_\-]+)\]")
# top-level tag lines: exactly one leading tab, e.g. "\t[SHRUB:PLANT_STANDARD:0:0]"
TOP_TAG_RE = re.compile(r"^\t\[([A-Z_]+):([A-Za-z0-9_]+):(\d+):(\d+)\]")
# WIRE-TAILS B27 follow-up: some trees have NO top-level [SEED:...] tag -- their seed item
# art lives as a named growth, e.g. WILLOW's `[GROWTH:SEED_CATKINS]` with a nested (two-tab)
# `[GROWTH_PICKED:PAGE:col:row]` cell. Track the current [GROWTH:<NAME>] and lift a
# SEED-named growth's GROWTH_PICKED cell as the species' SEED fallback (only when no
# top-level SEED tag exists -- first binding wins as everywhere else).
GROWTH_HDR_RE = re.compile(r"^\t\[GROWTH:([A-Za-z0-9_\-]+)\]")
GROWTH_PICKED_RE = re.compile(r"^\t\t\[GROWTH_PICKED:([A-Za-z0-9_]+):(\d+):(\d+)\]")
TILE_PAGE_HDR_RE = re.compile(r"^\[TILE_PAGE:([A-Za-z0-9_]+)\]")
TILE_PAGE_FILE_RE = re.compile(r"^\t\[FILE:images/([A-Za-z0-9_\-]+)\.png\]")
GENERIC_TILE_RE = re.compile(
    r"^\[TILE_GRAPHICS:([A-Za-z0-9_]+):(\d+):(\d+):(SHRUB|SAPLING)\]"
)


def read_lines(name: str):
    path = DF_GRAPHICS_DIR / name
    # DF raws are CP437/latin-1-ish; vanilla plant graphics files are ASCII,
    # but be defensive.
    with open(path, "r", encoding="cp437", newline="") as f:
        return [ln.rstrip("\r\n") for ln in f]


def parse_tile_pages():
    """Return dict TILE_PAGE name -> 'file.png' (basename only)."""
    pages = {}
    current = None
    for line in read_lines(TILE_PAGE_FILE):
        m = TILE_PAGE_HDR_RE.match(line)
        if m:
            current = m.group(1)
            continue
        m = TILE_PAGE_FILE_RE.match(line)
        if m and current:
            pages[current] = f"{m.group(1)}.png"
            current = None
    return pages


# Per-species top-level tags we lift into the map. SHRUB is the standing plant (map draw);
# SEED / PICKED are the HARVESTED-ITEM sprites the item identity wire tail (WIRE-TAILS) needs
# to resolve a per-species seed / picked-plant item to real art instead of a placeholder box
# (closes B27's seed-placeholder half). SHRUB_DEAD is the withered/winter state.
# TX4: farm-plot contained seed items need the authored planted states too. CROP is the
# isolated/ripe cell, CROP_SPROUT the growing cell, and CROP_L/M/R the optional joined-row
# cells. Keeping them in the same species map lets both renderers share one resolver without
# inventing sheet coordinates.
WANTED_TAGS = (
    "SHRUB", "SEED", "PICKED", "SHRUB_DEAD",
    "CROP", "CROP_SPROUT", "CROP_L", "CROP_M", "CROP_R",
)


def parse_species_file(name: str):
    """Return dict PLANT_ID -> {TAG: (tile_page, col, row)} for one file, for each of the
    WANTED_TAGS present in the species' [PLANT_GRAPHICS:...] block (first binding wins).

    B47 (fruit-as-seed wrong-art class): trees have NO top-level [PICKED:...] tag, so a
    harvested PLANT / PLANT_GROWTH item of a tree species (e.g. the "custard-apples" fruit
    item) used to fall through the client's `pm[part] || pm.PICKED || pm.SHRUB || pm.SEED`
    ladder to the SEED cell -- 55 tree species rendered every fruit/leaf item as scattered
    seeds. The tree blocks DO carry the right art as named growths
    (`[GROWTH:FRUIT] ... [GROWTH_PICKED:PAGE:c:r]`); lift the best non-seed growth's
    GROWTH_PICKED cell as the species' PICKED entry (preference: a FRUIT-named growth,
    else the first non-SEED growth), so the ladder lands on real fruit art instead."""
    result = {}
    current_id = None
    current = {}
    current_growth = None
    growth_cells = []  # [(growth_name, page, col, row)] in raw order, non-SEED growths

    def flush():
        # B47: flush on growth_cells too -- 8 tree species (MAHOGANY/HIGHWOOD/MANGROVE/
        # KAPOK/PALM/RUBBER/FEATHER/SAGUARO) carry ONLY growth art (no top-level SEED/
        # PICKED/SHRUB tag at all) and were silently dropped from the map entirely
        # (found by texture_coverage_audit R8).
        if not current_id or not (current or growth_cells):
            return
        if "PICKED" not in current and growth_cells:
            fruit = next((g for g in growth_cells if "FRUIT" in g[0]), None)
            pick = fruit or growth_cells[0]
            current["PICKED"] = (pick[1], pick[2], pick[3])
        result[current_id] = dict(current)

    for line in read_lines(name):
        m = PLANT_GRAPHICS_RE.match(line)
        if m:
            flush()
            current_id = m.group(1)
            current = {}
            current_growth = None
            growth_cells = []
            continue
        m = TOP_TAG_RE.match(line)
        if m and current_id:
            tag, page, col, row = m.groups()
            current_growth = None
            if tag in WANTED_TAGS and tag not in current:
                current[tag] = (page, int(col), int(row))
            continue
        m = GROWTH_HDR_RE.match(line)
        if m and current_id:
            current_growth = m.group(1)
            continue
        m = GROWTH_PICKED_RE.match(line)
        if m and current_id and current_growth:
            if current_growth.startswith("SEED"):
                # SEED-named growth's picked cell = the species' seed-item art (WILLOW-class
                # trees with no top-level SEED tag). Top-level SEED (if it ever appears later
                # in the block) would not overwrite -- but in practice top-level tags precede
                # growths in every raw block, and first-binding-wins keeps this deterministic.
                if "SEED" not in current:
                    current["SEED"] = (m.group(1), int(m.group(2)), int(m.group(3)))
            else:
                growth_cells.append((current_growth, m.group(1), int(m.group(2)), int(m.group(3))))
    flush()
    return result


def parse_generic_defaults():
    """Return dict part -> (tile_page, col, row) from graphics_plants.txt."""
    defaults = {}
    for line in read_lines(GENERIC_PLANTS_FILE):
        m = GENERIC_TILE_RE.match(line)
        if m:
            page, col, row, part = m.groups()
            if part not in defaults:  # keep first occurrence
                defaults[part] = (page, int(col), int(row))
    return defaults


def to_entry(tile_pages, page, col, row):
    sheet = tile_pages.get(page)
    if sheet is None:
        raise KeyError(f"TILE_PAGE {page!r} not found in {TILE_PAGE_FILE}")
    return {"sheet": sheet, "col": col, "row": row}


def main():
    tile_pages = parse_tile_pages()

    plant_map = {}
    per_file_counts = {}
    unmapped_pages = set()

    for fname in SPECIES_FILES:
        parsed = parse_species_file(fname)
        per_file_counts[fname] = len(parsed)
        for plant_id, parts in parsed.items():
            entry = plant_map.setdefault(plant_id, {})
            for part_name, (page, col, row) in parts.items():
                if page not in tile_pages:
                    unmapped_pages.add(page)
                    continue
                entry[part_name] = to_entry(tile_pages, page, col, row)

    # drop any plant entries that ended up empty (shouldn't happen, but be safe)
    plant_map = {k: v for k, v in plant_map.items() if v}

    generic = parse_generic_defaults()
    if "SHRUB" not in generic or "SAPLING" not in generic:
        raise RuntimeError(
            "Expected generic SHRUB and SAPLING fallback tiles in "
            f"{GENERIC_PLANTS_FILE}, found: {generic}"
        )
    default_shrub = to_entry(tile_pages, *generic["SHRUB"])
    default_sapling = to_entry(tile_pages, *generic["SAPLING"])

    plant_map["_default_shrub"] = default_shrub
    plant_map["_default_sapling"] = default_sapling

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(plant_map, f, indent=2, sort_keys=True)
        f.write("\n")

    total_species = len(plant_map) - 2  # minus the two _default_* keys
    species_with_shrub = sum(
        1
        for k, v in plant_map.items()
        if not k.startswith("_") and "SHRUB" in v
    )
    species_with_sapling = sum(
        1
        for k, v in plant_map.items()
        if not k.startswith("_") and "SAPLING" in v
    )
    species_with_seed = sum(
        1 for k, v in plant_map.items() if not k.startswith("_") and "SEED" in v
    )
    species_with_picked = sum(
        1 for k, v in plant_map.items() if not k.startswith("_") and "PICKED" in v
    )
    sheets_used = set()
    for k, v in plant_map.items():
        if k.startswith("_"):
            sheets_used.add(v["sheet"])
        else:
            for part_entry in v.values():
                sheets_used.add(part_entry["sheet"])

    print(f"Parsed species files: {per_file_counts}")
    print(f"Total distinct plant ids mapped: {total_species}")
    print(f"  with SHRUB tile: {species_with_shrub}")
    print(f"  with SEED tile: {species_with_seed} (harvested-seed item art -- WIRE-TAILS item identity)")
    print(f"  with PICKED tile: {species_with_picked} (picked-plant item art)")
    print(f"  with SAPLING tile: {species_with_sapling} (none expected; species files carry no per-species SAPLING tag)")
    print(f"Sheets referenced: {sorted(sheets_used)}")
    print(f"Default shrub: {default_shrub}")
    print(f"Default sapling: {default_sapling}")
    if unmapped_pages:
        print(f"WARNING: TILE_PAGE names referenced but not found in {TILE_PAGE_FILE}: {sorted(unmapped_pages)}")
    print(f"Wrote: {OUT_PATH}")


if __name__ == "__main__":
    main()
