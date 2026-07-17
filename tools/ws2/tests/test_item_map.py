#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WC-2 acceptance check for tools/ws2/build_item_map.py's output (web/item_map.json).
# Plain asserts -- run either as `python -m pytest -q` or directly:
#   python tools/ws2/tests/test_item_map.py

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
ITEM_MAP_PATH = os.path.join(REPO, "web", "item_map.json")
WEB_ROOT = os.path.join(REPO, "web")
# W1: resolved, never hardcoded. "" on a machine with no DF install; the sheet-existence
# checks below already tolerate that (they fall back to the repo's web root).
DF_ROOT = dfroot.df_root_default(sub="data/vanilla")


def load():
    with open(ITEM_MAP_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def collect_sheets(obj, out):
    if isinstance(obj, dict):
        if "sheet" in obj and "col" in obj and "row" in obj:
            out.add(obj["sheet"])
        else:
            for v in obj.values():
                collect_sheets(v, out)
    elif isinstance(obj, list):
        for v in obj:
            collect_sheets(v, out)


def test_v3_shape():
    d = load()
    assert d.get("_v") == 3, "expected _v:3"
    # v2 keys must all still be present (v3 is strictly additive).
    for key in ("bytype", "bytoken", "matvariants", "web", "_missing",
                "_corpse_fallback", "_default"):
        assert key in d, "missing v2 top-level key %r" % key
    # v3 (T1b) additive keys.
    for key in ("rough_gem_tiers", "rough_gem_glass", "gem_default",
                "smallgem_default", "gem_shapes", "boulder_bymat", "bar_bymat"):
        assert key in d, "missing v3 top-level key %r" % key


def _assert_cell(cell, sheet=None, col=None, row=None, where=""):
    assert {"sheet", "col", "row"} <= set(cell), "malformed cell %s: %r" % (where, cell)
    if sheet is not None:
        assert cell["sheet"] == sheet, "%s sheet %r != %r" % (where, cell["sheet"], sheet)
    if col is not None:
        assert cell["col"] == col, "%s col %r != %r" % (where, cell["col"], col)
    if row is not None:
        assert cell["row"] == row, "%s row %r != %r" % (where, cell["row"], row)


def test_rough_gem_tiers():
    d = load()
    tiers = d["rough_gem_tiers"]
    vals = [t["min_value"] for t in tiers]
    # all 10 spec-pinned value tiers, ascending.
    assert vals == [2, 3, 5, 10, 15, 20, 25, 30, 40, 60], "tiers not the 10 pinned values ascending: %s" % vals
    for t in tiers:
        _assert_cell(t["cell"], sheet="boulders.png", where="rough_gem_tier %d" % t["min_value"])
    # oracle cells (graphics_items.txt:11,20): VALUE_2 @ 0:9, VALUE_60 @ 1:11.
    _assert_cell(tiers[0]["cell"], sheet="boulders.png", col=0, row=9, where="tier2")
    _assert_cell(tiers[-1]["cell"], sheet="boulders.png", col=1, row=11, where="tier60")


def test_rough_gem_glass():
    d = load()
    glass = d["rough_gem_glass"]
    assert set(glass) == {"GLASS_GREEN", "GLASS_CLEAR", "GLASS_CRYSTAL"}, "glass keys: %s" % sorted(glass)
    # all three glass roughs sit at BOULDERS 0:8 (graphics_items.txt:8-10).
    for k, cell in glass.items():
        _assert_cell(cell, sheet="boulders.png", col=0, row=8, where="glass %s" % k)


def test_gem_defaults():
    d = load()
    _assert_cell(d["gem_default"], sheet="gems.png", col=0, row=0, where="gem_default")
    _assert_cell(d["smallgem_default"], sheet="smallgems.png", col=0, row=0, where="smallgem_default")


def test_gem_shapes():
    d = load()
    shapes = d["gem_shapes"]
    assert len(shapes) == 22, "expected 22 vanilla cut tokens, got %d" % len(shapes)
    for cut, sl in shapes.items():
        assert "small" in sl and "large" in sl, "cut %r missing small/large" % cut
        _assert_cell(sl["small"], sheet="smallgems.png", where="%s small" % cut)
        _assert_cell(sl["large"], sheet="gems.png", where="%s large" % cut)
    # oracle (graphics_shapes.txt:8-9,50-51): BAGUETTE small @ SMALLGEMS 0:0, large @ GEMS 1:0;
    # TRILLION large @ GEMS 22:0.
    _assert_cell(shapes["BAGUETTE_CUT_GEM"]["small"], col=0, row=0, where="baguette small")
    _assert_cell(shapes["BAGUETTE_CUT_GEM"]["large"], col=1, row=0, where="baguette large")
    _assert_cell(shapes["TRILLION_CUT_GEM"]["large"], col=22, row=0, where="trillion large")


def test_boulder_bymat():
    d = load()
    boulder = d["boulder_bymat"]
    assert len(boulder) >= 35, "expected >=35 boulder minerals, got %d" % len(boulder)
    # oracle cells (graphics_items.txt:22-56).
    _assert_cell(boulder["MARBLE"], sheet="boulders.png", col=0, row=4, where="MARBLE")
    _assert_cell(boulder["RAW_ADAMANTINE"], sheet="boulders.png", col=1, row=12, where="RAW_ADAMANTINE")
    _assert_cell(boulder["OBSIDIAN"], sheet="boulders.png", col=1, row=13, where="OBSIDIAN")
    _assert_cell(boulder["LIMONITE"], sheet="boulders.png", col=0, row=13, where="LIMONITE (ore)")
    _assert_cell(boulder["COAL_BITUMINOUS"], sheet="boulders.png", col=0, row=3, where="COAL_BITUMINOUS")


def test_bar_bymat():
    d = load()
    bar = d["bar_bymat"]
    assert set(bar) == {"POTASH", "PEARLASH", "COAL:COKE", "COAL:CHARCOAL", "SOAP"}, "bar keys: %s" % sorted(bar)
    # oracle cells (graphics_items.txt:59-63), all on item_construction.png.
    _assert_cell(bar["POTASH"], sheet="item_construction.png", col=0, row=3, where="POTASH")
    _assert_cell(bar["PEARLASH"], sheet="item_construction.png", col=1, row=3, where="PEARLASH")
    _assert_cell(bar["COAL:COKE"], sheet="item_construction.png", col=0, row=4, where="COKE")
    _assert_cell(bar["COAL:CHARCOAL"], sheet="item_construction.png", col=1, row=4, where="CHARCOAL")
    _assert_cell(bar["SOAP"], sheet="item_construction.png", col=1, row=1, where="SOAP")


def test_table_leg_composite_wiring():
    # TX10 shipped STONE only (baked cell (0,0)). B183 (registry: "the table leg texture
    # got fixed but it only applied to one type of table not all the different material
    # types") extends the SAME bake to WOOD/METAL/GLASS, using their pre-existing pinned
    # base cells -- one row per material on the generated sheet, STONE pinned at row 0.
    d = load()
    comp_row = {"STONE": 0, "WOOD": 1, "METAL": 2, "GLASS": 3}
    def comp(mat):
        return {"sheet": "item_table_composite.png", "col": 0, "row": comp_row[mat]}
    for kp, node in (("bytype.TABLE", d["bytype"].get("TABLE")),
                     ("bytoken.ITEM_TABLE", d["bytoken"].get("ITEM_TABLE")),
                     ("bytoken.ITEM_TABLE_STONE", d["bytoken"].get("ITEM_TABLE_STONE")),
                     ("matvariants.Table.STONE", d["matvariants"]["Table"].get("STONE"))):
        assert node == comp("STONE"), "%s must be the table composite %r, got %r" % (kp, comp("STONE"), node)
    # B183: WOOD/METAL/GLASS tabletops (bytoken + matvariants) must now ALSO point at
    # their own composite row -- no material renders the bare legless base anymore.
    tv = d["matvariants"]["Table"]
    for mat, bytoken_key in (("WOOD", "ITEM_TABLE_WOOD"), ("METAL", "ITEM_TABLE_METAL"),
                              ("GLASS", "ITEM_TABLE_GLASS")):
        assert tv[mat] == comp(mat), "matvariants.Table.%s must be %r, got %r" % (mat, comp(mat), tv[mat])
        assert d["bytoken"][bytoken_key] == comp(mat), (
            "bytoken.%s must be %r, got %r" % (bytoken_key, comp(mat), d["bytoken"][bytoken_key]))


def test_table_leg_composite_pixels_are_base_plus_legs():
    # Pixel-hash proof (parallel to candidate_pixel_key), for EVERY material row: each
    # generated cell equals its material's bare base (item_table.png) alpha-composited
    # with the single material-agnostic legs overlay item_table.png(7,0) -- no invented
    # art, every base cell is one already pinned/used elsewhere in the map. Skips if the
    # DF install (source PNG) is unreachable.
    from PIL import Image
    comp_path = os.path.join(WEB_ROOT, "item_table_composite.png")
    if not os.path.isfile(comp_path):
        return  # W11: composites are baked locally/at install time, never tracked --
                # nothing to pixel-check on a fresh clone (wiring test above still ran)
    comp = Image.open(comp_path).convert("RGBA")
    bases = {"STONE": (0, 1), "WOOD": (0, 0), "METAL": (0, 2), "GLASS": (0, 3)}
    comp_row = {"STONE": 0, "WOOD": 1, "METAL": 2, "GLASS": 3}
    assert comp.size == (32, 32 * len(comp_row)), (
        "composite sheet must be 32x%d (1 col, %d material rows), got %r"
        % (32 * len(comp_row), len(comp_row), comp.size))
    src_candidates = glob.glob(os.path.join(DF_ROOT, "**", "item_table.png"), recursive=True)
    if not src_candidates:
        return  # DF install not reachable in this environment -- wiring test above still ran
    src = Image.open(src_candidates[0]).convert("RGBA")
    legs = src.crop((7 * 32, 0 * 32, 8 * 32, 1 * 32))   # (7,0) ITEM_TABLE_LEG_VARIANT overlay
    for mat, (bc, br) in bases.items():
        base = src.crop((bc * 32, br * 32, (bc + 1) * 32, (br + 1) * 32))
        expect = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        expect.alpha_composite(base)
        expect.alpha_composite(legs)
        row = comp_row[mat]
        cell = comp.crop((0, row * 32, 32, (row + 1) * 32))
        assert cell.tobytes() == expect.tobytes(), (
            "%s baked composite cell != base(%d,%d)+legs(7,0)" % (mat, bc, br))
        # legs actually add pixels (guards against baking base-only): composite is
        # strictly more opaque than the bare top for every material, not just STONE.
        def opaque(im):
            return sum(1 for a in im.getchannel("A").tobytes() if a > 0)
        assert opaque(cell) > opaque(base), (
            "%s composite has no more opaque pixels than its bare top -- legs missing" % mat)


def test_chair_leg_composite_wiring():
    # B183 (reopened): chairs never got ANY composite in the prior two table fixes.
    # item_chair.png has the SAME layout as item_table.png -- generic ITEM_CHAIR @ (0,1),
    # per-material bases WOOD(0,0)/STONE(0,1)/METAL(0,2)/GLASS(0,3), and an authored
    # ITEM_CHAIR_LEG_VARIANT overlay at (7,0) -- so the same mechanical bake applies.
    # The loose-item render keys (matvariants.Chair.* + bytype.CHAIR) and each per-material
    # bytoken must now point at item_chair_composite.png.
    d = load()
    comp_row = {"STONE": 0, "WOOD": 1, "METAL": 2, "GLASS": 3}
    def comp(mat):
        return {"sheet": "item_chair_composite.png", "col": 0, "row": comp_row[mat]}
    # bytype.CHAIR is the generic/no-material cell (STONE row) -- NOT pinned, so composited.
    assert d["bytype"]["CHAIR"] == comp("STONE"), (
        "bytype.CHAIR must be the chair composite %r, got %r" % (comp("STONE"), d["bytype"]["CHAIR"]))
    cv = d["matvariants"]["Chair"]
    for mat, bytoken_key in (("STONE", "ITEM_CHAIR_STONE"), ("WOOD", "ITEM_CHAIR_WOOD"),
                              ("METAL", "ITEM_CHAIR_METAL"), ("GLASS", "ITEM_CHAIR_GLASS")):
        assert cv[mat] == comp(mat), "matvariants.Chair.%s must be %r, got %r" % (mat, comp(mat), cv[mat])
        assert d["bytoken"][bytoken_key] == comp(mat), (
            "bytoken.%s must be %r, got %r" % (bytoken_key, comp(mat), d["bytoken"][bytoken_key]))
    # DELIBERATE EXCEPTION: generic bytoken.ITEM_CHAIR carries the TX9 spritepick pin
    # (-> building_icons.png(1,5)); apply_choices --reapply re-asserts it OVER the
    # generator's composite. It is a non-render key (loose chairs draw via matvariant), so
    # the pin is preserved, not clobbered. This asserts the pin still holds after regen.
    assert d["bytoken"]["ITEM_CHAIR"] == {"sheet": "building_icons.png", "col": 1, "row": 5}, (
        "bytoken.ITEM_CHAIR should still carry the TX9 pin, got %r" % d["bytoken"]["ITEM_CHAIR"])


def test_chair_leg_composite_pixels_are_base_plus_legs():
    # Pixel-hash proof (parallel to the table proof): each generated chair cell equals its
    # material's bare base (item_chair.png) alpha-composited with the material-agnostic
    # ITEM_CHAIR_LEG_VARIANT overlay item_chair.png(7,0). No invented art -- every base cell
    # pre-exists in the raws. Skips only if the DF install (source PNG) is unreachable.
    from PIL import Image
    comp_path = os.path.join(WEB_ROOT, "item_chair_composite.png")
    if not os.path.isfile(comp_path):
        return  # W11: composites are baked locally/at install time, never tracked --
                # nothing to pixel-check on a fresh clone (wiring test above still ran)
    comp = Image.open(comp_path).convert("RGBA")
    bases = {"STONE": (0, 1), "WOOD": (0, 0), "METAL": (0, 2), "GLASS": (0, 3)}
    comp_row = {"STONE": 0, "WOOD": 1, "METAL": 2, "GLASS": 3}
    assert comp.size == (32, 32 * len(comp_row)), (
        "chair composite sheet must be 32x%d, got %r" % (32 * len(comp_row), comp.size))
    src_candidates = glob.glob(os.path.join(DF_ROOT, "**", "item_chair.png"), recursive=True)
    if not src_candidates:
        return  # DF install not reachable -- wiring test above still ran
    src = Image.open(src_candidates[0]).convert("RGBA")
    legs = src.crop((7 * 32, 0 * 32, 8 * 32, 1 * 32))   # (7,0) ITEM_CHAIR_LEG_VARIANT overlay
    for mat, (bc, br) in bases.items():
        base = src.crop((bc * 32, br * 32, (bc + 1) * 32, (br + 1) * 32))
        expect = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        expect.alpha_composite(base)
        expect.alpha_composite(legs)
        row = comp_row[mat]
        cell = comp.crop((0, row * 32, 32, (row + 1) * 32))
        assert cell.tobytes() == expect.tobytes(), (
            "%s baked chair cell != base(%d,%d)+legs(7,0)" % (mat, bc, br))
        def opaque(im):
            return sum(1 for a in im.getchannel("A").tobytes() if a > 0)
        assert opaque(cell) > opaque(base), (
            "%s chair composite has no more opaque pixels than its bare base -- legs missing" % mat)


def test_skin_tanned_and_cloth_are_distinct_authored_cells():
    # TX11: the leather (tanned-skin) key holds the authored ITEM_TANNED_SKIN cell and stays
    # DISTINCT from cloth -- the export's dangerous bytoken.ITEM_CLOTH reroute was rejected.
    d = load()
    _assert_cell(d["bytype"]["SKIN_TANNED"], sheet="item_cloth.png", col=0, row=1, where="SKIN_TANNED")
    _assert_cell(d["bytoken"]["ITEM_TANNED_SKIN"], sheet="item_cloth.png", col=0, row=1, where="ITEM_TANNED_SKIN")
    # cloth itself must be UNCHANGED (never repainted as leather)
    _assert_cell(d["bytype"]["CLOTH"], sheet="item_cloth.png", col=1, row=0, where="CLOTH")
    _assert_cell(d["bytoken"]["ITEM_CLOTH"], sheet="item_cloth.png", col=1, row=0, where="ITEM_CLOTH")
    assert d["bytype"]["SKIN_TANNED"] != d["bytoken"]["ITEM_CLOTH"], "leather must not equal cloth"


def test_generic_plant_unchanged_by_tx12():
    # TX12 was STOPPED (wire ident issue, no map change). The generic PLANT fallback must be
    # untouched -- a guard that nobody wrote the rat-weed pick into bytype.PLANT.
    d = load()
    _assert_cell(d["bytype"]["PLANT"], sheet="plants.png", col=1, row=0, where="PLANT")


def test_bytype_covers_at_least_80_of_94():
    d = load()
    bytype = d["bytype"]
    non_meta_keys = [k for k in bytype if not k.startswith("_")]
    default_cell = d["_default"]
    non_default = [k for k in non_meta_keys if bytype[k] != default_cell]
    assert len(non_default) >= 80, (
        "expected >=80 of the 94 item_type keys to resolve to non-default "
        "cells, got %d (%s)" % (len(non_default), sorted(non_default)))


def test_bytoken_has_at_least_100_incl_weapon_pick():
    d = load()
    bytoken = d["bytoken"]
    assert len(bytoken) >= 100, "expected >=100 bytoken entries, got %d" % len(bytoken)
    assert "ITEM_WEAPON_PICK" in bytoken, "ITEM_WEAPON_PICK missing from bytoken"
    cell = bytoken["ITEM_WEAPON_PICK"]
    assert {"sheet", "col", "row"} <= set(cell), "malformed cell for ITEM_WEAPON_PICK: %r" % cell


def test_web_has_8_cells():
    d = load()
    web = d["web"]
    assert "harmless" in web and "thick" in web
    assert len(web["harmless"]) == 4, "expected 4 harmless web cells, got %d" % len(web["harmless"])
    assert len(web["thick"]) == 4, "expected 4 thick web cells, got %d" % len(web["thick"])
    total = len(web["harmless"]) + len(web["thick"])
    assert total == 8, "expected 8 total web cells, got %d" % total


def test_matvariants_material_families():
    d = load()
    matvariants = d["matvariants"]
    assert len(matvariants) >= 1
    for base, variants in matvariants.items():
        for mat, cell in variants.items():
            assert mat in ("WOOD", "STONE", "METAL", "GLASS"), (
                "unexpected material key %r on base %r" % (mat, base))
            assert {"sheet", "col", "row"} <= set(cell)


def test_every_referenced_sheet_exists_under_df_install():
    if not DF_ROOT:
        print("SKIP test_every_referenced_sheet_exists_under_df_install: needs DF graphics sheets")
        return
    d = load()
    sheets = set()
    collect_sheets(d, sheets)
    assert sheets, "no sheets found in item_map.json"
    # W11: the generated composite sheets are never tracked (Kitfox-derived);
    # they are baked into the deployed web root at install time. A sheet listed
    # as an output of host/sprite_recipe.json is therefore accounted for.
    recipe = os.path.join(os.path.dirname(WEB_ROOT), "host", "sprite_recipe.json")
    baked = set()
    if os.path.isfile(recipe):
        with open(recipe, encoding="utf-8") as fh:
            baked = set(json.load(fh).get("outputs", {}))
    missing = []
    for sheet in sheets:
        if sheet in baked:
            continue
        matches = glob.glob(os.path.join(DF_ROOT, "**", sheet), recursive=True)
        if not matches and os.path.isfile(os.path.join(WEB_ROOT, sheet)):
            matches = [os.path.join(WEB_ROOT, sheet)]
        if not matches:
            missing.append(sheet)
    assert not missing, "sheet file(s) not found under DF install, web root, or bake recipe: %s" % missing


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
