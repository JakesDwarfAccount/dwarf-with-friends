#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WC-5 acceptance check for tools/ws2/build_building_map.py's output
# (web/building_map.json + web/overlay_map.json). Plain asserts -- run
# either as `python -m pytest -q` or directly:
#   python tools/ws2/tests/test_building_map.py

import glob
import json
import os
import sys

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
BUILDING_MAP_PATH = os.path.join(REPO, "web", "building_map.json")
OVERLAY_MAP_PATH = os.path.join(REPO, "web", "overlay_map.json")
WEB_ROOT = os.path.join(REPO, "web")
# W1: resolved, never hardcoded. "" on a machine with no DF install; the sheet-existence
# checks below already tolerate that (they fall back to the repo's web root).
DF_ROOT = dfroot.df_root_default(sub="data/vanilla")

EXPECTED_FURNITURE_KEYS = {
    "Door", "Floodgate", "Bed", "Table", "Chair", "Cabinet", "Box", "Coffin", "Statue",
    "Slab", "Hatch", "GrateWall", "GrateFloor", "BarsVertical", "BarsFloor",
    "Chain", "Cage", "AnimalTrap", "WindowGlass", "WindowGem", "TractionBench",
    "Weaponrack", "Armorstand", "NestBox", "Hive", "Bookcase",
    "DisplayFurniture", "OfferingPlace", "Instrument",
}


def load_building_map():
    with open(BUILDING_MAP_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_overlay_map():
    with open(OVERLAY_MAP_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def test_v2_shape():
    d = load_building_map()
    # v3 added the flat top-level building_type default keys (Bed/Well/Bridge/Table/...);
    # the generator writes _v:3. (Was stale at ==2 -- corrected 2026-07-10 B183 reopen.)
    assert d.get("_v") == 3
    for key in ("furniture", "wells", "machines", "bridges"):
        assert key in d, "missing top-level key %r" % key


def test_placed_furniture_table_chair_render_leg_composite():
    # B183 (REOPENED -- twice-shipped, still legless live): PLACED tables/chairs render
    # through building_map.json, NOT item_map.json. The client resolves a built Table/Chair
    # via the top-level building_type default key (buildingMap["Table"]/["Chair"]), which the
    # generator derives WOOD-first from furniture.<key>.matvariants. The prior two fixes wired
    # the leg composite ONLY into item_map (the loose-item path) -- so placed furniture kept
    # pointing at the bare legless base. Assert both the top-level default AND every furniture
    # matvariant now resolve to the *_composite.png sheet.
    d = load_building_map()
    families = {"Table": "item_table_composite.png", "Chair": "item_chair_composite.png"}
    comp_row = {"STONE": 0, "WOOD": 1, "METAL": 2, "GLASS": 3}
    for key, comp_sheet in families.items():
        top = d[key]
        cell0 = top["cells"][0][0]
        assert top["sheet"] == comp_sheet, (
            "placed %s default must render the leg composite %s, got bare %s"
            % (key, comp_sheet, top["sheet"]))
        # WOOD-first default (_MAT_PREF) -> composite row 1.
        assert cell0 == {"col": 0, "row": comp_row["WOOD"]}, (
            "placed %s default cell must be the WOOD composite row, got %r" % (key, cell0))
        mv = d["furniture"][key]["matvariants"]
        for mat, cell in mv.items():
            assert cell == {"sheet": comp_sheet, "col": 0, "row": comp_row[mat]}, (
                "furniture.%s.%s must be the %s composite row, got %r" % (key, mat, mat, cell))


def test_placed_furniture_seeded_bad_bare_base_is_detected():
    # test-the-test (protocol rule 3): a bare (legless) base cell must NOT be mistaken for the
    # composite. Proves the assertions above are load-bearing on the composite sheet, not a
    # coincidental pass -- the exact live defect (item_table.png / item_chair.png bare base).
    d = load_building_map()
    seeded_bad = {
        "Table": {"sheet": "item_table.png", "col": 0, "row": 0},   # bare WOOD tabletop
        "Chair": {"sheet": "item_chair.png", "col": 0, "row": 0},   # bare WOOD chair
    }
    for key, bad in seeded_bad.items():
        assert d["furniture"][key]["matvariants"]["WOOD"] != bad, (
            "furniture.%s.WOOD must not be the bare legless base %r (that is the live bug)" % (key, bad))
        assert d[key]["cells"][0][0] != {"col": bad["col"], "row": bad["row"]} or d[key]["sheet"] != bad["sheet"], (
            "placed %s default must not be the bare base" % key)


def test_all_28_furniture_keys_have_material_variant():
    d = load_building_map()
    furniture = d["furniture"]
    keys = set(furniture.keys())
    assert keys == EXPECTED_FURNITURE_KEYS, (
        "furniture key mismatch: missing=%s extra=%s"
        % (EXPECTED_FURNITURE_KEYS - keys, keys - EXPECTED_FURNITURE_KEYS))
    for key, entry in furniture.items():
        variants = entry.get("matvariants", {})
        assert len(variants) >= 1, "%r has no material variant" % key
        for mat, cell in variants.items():
            assert {"sheet", "col", "row"} <= set(cell), "malformed cell for %s.%s" % (key, mat)


def test_machine_families_have_exactly_2_frames():
    d = load_building_map()
    machines = d["machines"]
    assert len(machines) >= 20, "expected >=20 machine families, got %d" % len(machines)
    for base, entry in machines.items():
        frames = entry.get("frames")
        assert isinstance(frames, list) and len(frames) == 2, (
            "%r has %r frames, expected exactly 2" % (base, len(frames) if frames else frames))
        for frame in frames:
            assert len(frame) >= 1


def test_wells_and_bridges_present():
    d = load_building_map()
    wells = d["wells"]
    assert "BASE" in wells and "bucket" in wells
    assert "EMPTY" in wells["bucket"] and "FULL" in wells["bucket"]
    bridges = d["bridges"]
    for mat in ("WOOD", "STONE", "METAL", "GLASS"):
        assert mat in bridges and len(bridges[mat]) > 0


def test_overlay_map_stockpile_glyphs_and_zone_adjacency():
    o = load_overlay_map()
    assert "stockpile" in o and "zone" in o
    category_glyphs = {
        "STOCKPILE_BLANK", "STOCKPILE_AMMO", "STOCKPILE_ANIMALS", "STOCKPILE_ARMOR",
        "STOCKPILE_BARS", "STOCKPILE_CLOTH", "STOCKPILE_COINS", "STOCKPILE_CORPSES",
        "STOCKPILE_FINISHED_GOODS", "STOCKPILE_FOOD", "STOCKPILE_FURNITURE",
        "STOCKPILE_GEMS", "STOCKPILE_LEATHER", "STOCKPILE_REFUSE", "STOCKPILE_SHEETS",
        "STOCKPILE_STONE", "STOCKPILE_WEAPONS", "STOCKPILE_WOOD", "STOCKPILE_CUSTOM",
    }
    assert len(category_glyphs) == 19
    stockpile = set(o["stockpile"].keys())
    assert category_glyphs <= stockpile, "missing category glyphs: %s" % (category_glyphs - stockpile)

    zone_inactive = [k for k in o["zone"] if k.startswith("ZONE_INACTIVE") and "SELECTED" not in k]
    assert len(zone_inactive) >= 16, "expected >=16 ZONE_INACTIVE adjacency cells, got %d" % len(zone_inactive)


def test_overlay_map_designation_priority_and_item_marks():
    """WC-19: designation_priority.png rows 0-6 (levels 1-7) + designation_item.png rows
    0-5 (6 marks) -- both parsed from graphics_interface.txt, same source file the zone
    glyphs above already read."""
    o = load_overlay_map()
    assert "designation_priority" in o and "designation_item" in o
    priority = o["designation_priority"]
    assert set(priority.keys()) == {"1", "2", "3", "4", "5", "6", "7"}, priority.keys()
    for lvl in priority.values():
        assert lvl["sheet"] == "designation_priority.png"
    item_marks = {
        "DESIGNATION_ITEM_MELT", "DESIGNATION_ITEM_DUMP", "DESIGNATION_ITEM_FORBIDDEN",
        "DESIGNATION_ITEM_HIDDEN", "DESIGNATION_ITEM_FORBIDDEN_MELT",
        "DESIGNATION_ITEM_FORBIDDEN_DUMP",
    }
    assert set(o["designation_item"].keys()) == item_marks
    for mark in o["designation_item"].values():
        assert mark["sheet"] == "designation_item.png"


def test_every_referenced_sheet_exists_under_df_install():
    if not DF_ROOT:
        print("SKIP test_every_referenced_sheet_exists_under_df_install: needs DF graphics sheets")
        return
    def collect(obj, out):
        if isinstance(obj, dict):
            if "sheet" in obj and "col" in obj and "row" in obj:
                out.add(obj["sheet"])
            else:
                for v in obj.values():
                    collect(v, out)
        elif isinstance(obj, list):
            for v in obj:
                collect(v, out)

    sheets = set()
    collect(load_building_map(), sheets)
    collect(load_overlay_map(), sheets)
    sheets.discard(None)
    assert sheets, "no sheets found"
    # W11: the generated composite sheets are never tracked (Kitfox-derived);
    # they are baked into the deployed web root at install time. A sheet listed
    # as an output of host/sprite_recipe.json is therefore accounted for.
    recipe = os.path.join(REPO, "host", "sprite_recipe.json")
    baked = set()
    if os.path.isfile(recipe):
        with open(recipe, encoding="utf-8") as fh:
            baked = set(json.load(fh).get("outputs", {}))
    missing = []
    for sheet in sheets:
        if sheet in baked:
            continue
        matches = glob.glob(os.path.join(DF_ROOT, "**", sheet), recursive=True)
        # A locally regenerated composite in the web root also counts (dev flow).
        if not matches and os.path.isfile(os.path.join(WEB_ROOT, sheet)):
            matches = [os.path.join(WEB_ROOT, sheet)]
        if not matches:
            missing.append(sheet)
    assert not missing, "sheet file(s) not found under DF install, web root, or bake recipe: %s" % missing


def test_wagon_and_siege_art_is_multicolumn_not_collapsed():
    # TX3 (B47 reopen): the 2-param `col:row` graphics grammar (wagons, ballista, catapult)
    # must map to the FULL multi-column footprint art, not a single collapsed column. The old
    # generator mis-read col:row as (variant, row) and kept only the max column, blanking 2 of
    # the wagon's 3 columns on screen.
    d = load_building_map()
    for key in ("Wagon", "WAGON_BLD", "WAGON_N", "WAGON_S", "BALLISTA_N", "CATAPULT_N"):
        e = d[key]
        assert e["w"] == 3, "%s must be 3 columns wide, got w=%s" % (key, e["w"])
        for row in e["cells"]:
            assert len(row) == 3, "%s row not 3-wide: %r" % (key, row)
            assert len({c["col"] for c in row}) == 3, "%s columns not distinct (collapsed): %r" % (key, row)
    for key in ("WAGON_E", "WAGON_W"):
        assert d[key]["w"] == 4, "%s (E/W facing) art is 4 columns wide" % key
    # The disambiguation must NOT over-widen genuine single-tile buildings whose 2-param form is
    # (stage, row) -- millstone/quern use build stage 1 (col implicit 0), never a column axis.
    for key in ("WORKSHOP_MILLSTONE", "WORKSHOP_QUERN", "Workshop:Millstone", "Workshop:Quern"):
        assert d[key]["w"] == 1, "%s must stay 1-wide (stage:row, not col:row), got w=%s" % (key, d[key]["w"])


def test_build_grid_disambiguates_col_row_from_stage_row():
    # test-the-test for the generator heuristic: a col:row footprint (0-based column axis)
    # widens; a stage:row axis (col implicit 0, stage starts at 1) does NOT.
    sys.path.insert(0, os.path.join(REPO, "tools", "ws2"))
    from build_building_map import build_grid
    # col:row like a wagon -- columns 0,1,2 across rows 1,2,3 (row 0 = overhang).
    col_row = []
    for c in range(3):
        for r in range(4):
            col_row.append(("WAGONS", c, r, (c, r)))
    sheet, w, h, grid, overhang = build_grid(col_row)
    assert w == 3 and h == 3, "col:row footprint must widen to 3x3, got %sx%s" % (w, h)
    assert overhang and len(overhang) == 3, "row-0 overhang spans all 3 columns"
    # stage:row like a millstone -- stage 1 only, rows 0 (overhang) and 1 (footprint), col=0.
    stage_row = [("WORKSHOPS_1x1", 1, 0, (1, 0)), ("WORKSHOPS_1x1", 1, 1, (1, 1))]
    sheet2, w2, h2, grid2, overhang2 = build_grid(stage_row)
    assert w2 == 1, "stage:row single-tile must stay 1-wide, got w=%s (mis-read stage as column)" % w2


def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for t in tests:
        try:
            t()
            print("PASS", t.__name__)
        except AssertionError as e:
            failures += 1
            print("FAIL", t.__name__, "-", e)
    print("%d/%d tests passed" % (len(tests) - failures, len(tests)))
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)
