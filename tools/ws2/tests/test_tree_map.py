#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WC-13 acceptance check for tools/ws2/build_tree_map.py's output
# (web/tree_map.json). Plain asserts -- run either as `python -m pytest -q`
# or directly:
#   python tools/ws2/tests/test_tree_map.py

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
TREE_MAP_PATH = os.path.join(REPO, "web", "tree_map.json")
# W1: resolved, never hardcoded. "" on a machine with no DF install; the sheet-existence
# checks below already tolerate that (they fall back to the repo's web root).
DF_ROOT = dfroot.df_root_default(sub="data/vanilla")

# The 72 species with a [PLANT_GRAPHICS:...] block in
# graphics_individual_trees.txt (verified this session).
EXPECTED_SPECIES = {
    "ABACA", "ACACIA", "ALDER", "ALMOND", "APPLE", "APRICOT", "ASH", "AVOCADO",
    "BANANA", "BAYBERRY", "BIRCH", "BITTER_ORANGE", "BLACK_CAP", "BLOOD_THORN",
    "CACAO", "CANDLENUT", "CARAMBOLA", "CASHEW", "CEDAR", "CHERRY", "CHESTNUT",
    "CITRON", "COFFEE", "CUSTARD-APPLE", "DATE_PALM", "DESERT_LIME", "DURIAN",
    "FEATHER", "FINGER_LIME", "FUNGIWOOD", "GINKGO", "GLUMPRONG", "GOBLIN_CAP",
    "GUAVA", "HAZEL", "HIGHWOOD", "KAPOK", "KUMQUAT", "LARCH", "LIME", "LYCHEE",
    "MACADAMIA", "MAHOGANY", "MANGO", "MANGROVE", "MAPLE", "NETHER_CAP", "OAK",
    "OLIVE", "ORANGE", "PALM", "PAPAYA", "PARADISE_NUT", "PEACH", "PEAR",
    "PECAN", "PERSIMMON", "PINE", "PLUM", "POMEGRANATE", "POMELO", "RAMBUTAN",
    "ROUND_LIME", "RUBBER", "SAGUARO", "SAND_PEAR", "SPORE_TREE", "TEA",
    "TOWER_CAP", "TUNNEL_TUBE", "WALNUT", "WILLOW",
}


def load():
    with open(TREE_MAP_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def test_v2_and_all_72_species_plus_default():
    d = load()
    assert d.get("_v") == 2, "expected _v:2"
    species_keys = {k for k in d if k not in ("_v", "_default")}
    assert species_keys == EXPECTED_SPECIES, (
        "species key mismatch: missing=%s extra=%s"
        % (EXPECTED_SPECIES - species_keys, species_keys - EXPECTED_SPECIES))
    assert "_default" in d


def test_maple_at_least_40_cells_6_families():
    d = load()
    maple = d["MAPLE"]
    families = [k for k in maple if k.startswith("TREE_")]
    total_cells = sum(len(v) for k, v in maple.items()
                       if k.startswith("TREE_") and isinstance(v, dict))
    assert len(families) >= 6, "expected >=6 families for MAPLE, got %d (%s)" % (
        len(families), sorted(families))
    assert total_cells >= 40, "expected >=40 distinct cells for MAPLE, got %d" % total_cells
    assert "INTERIOR" in maple.get("TREE_TRUNK_THICK", {}), "MAPLE missing TREE_TRUNK_THICK.INTERIOR"
    assert "NSWE" in maple.get("TREE_TRUNK", {}), "MAPLE missing TREE_TRUNK.NSWE"


def test_tower_cap_has_cap_family():
    d = load()
    tower_cap = d["TOWER_CAP"]
    assert "TREE_CAP" in tower_cap and len(tower_cap["TREE_CAP"]) > 0, (
        "TOWER_CAP missing TREE_CAP family")


def test_backcompat_flat_keys_present_where_expected():
    d = load()
    maple = d["MAPLE"]
    for key in ("TRUNK", "BRANCH", "CANOPY", "LEAVES", "SAPLING"):
        assert key in maple, "MAPLE missing back-compat flat key %r" % key


def test_every_referenced_sheet_exists_under_df_install():
    if not DF_ROOT:
        print("SKIP test_every_referenced_sheet_exists_under_df_install: needs DF graphics sheets")
        return
    d = load()
    sheets = set()
    for species_id, entry in d.items():
        if species_id == "_v":
            continue
        for key, val in entry.items():
            if isinstance(val, dict) and "sheet" in val:
                sheets.add(val["sheet"])
            elif isinstance(val, dict):
                for cell in val.values():
                    sheets.add(cell["sheet"])
    assert sheets, "no sheets found in tree_map.json"
    missing = []
    for sheet in sheets:
        matches = glob.glob(os.path.join(DF_ROOT, "**", sheet), recursive=True)
        if not matches:
            missing.append(sheet)
    assert not missing, "sheet file(s) not found under DF install: %s" % missing


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
