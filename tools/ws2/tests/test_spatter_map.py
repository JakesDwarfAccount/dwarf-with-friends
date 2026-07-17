#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WC-12 acceptance check for tools/ws2/build_spatter_map.py's output
# (web/spatter_map.json). Plain asserts -- run either as `python -m pytest -q` or
# directly:
#   python tools/ws2/tests/test_spatter_map.py

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
SPATTER_MAP_PATH = os.path.join(REPO, "web", "spatter_map.json")
# W1: resolved, never hardcoded. "" on a machine with no DF install; the sheet-existence
# checks below already tolerate that (they fall back to the repo's web root).
DF_ROOT = dfroot.df_root_default(sub="data/vanilla")

WET_FAMILIES = {
    "BLOOD_CYAN", "BLOOD_GOO", "BLOOD_ICHOR", "BLOOD_MAGENTA", "BLOOD_RED",
    "DUST", "MAGMA_SPATTER", "MUD", "SNOW", "VOMIT", "SLIME", "WATER_SPATTER",
}
LITTER_FAMILIES = {"FRUIT", "FRUIT_SMALL", "FRUIT_LARGE", "LEAVES"}


def load():
    with open(SPATTER_MAP_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def test_top_level_shape():
    d = load()
    for key in ("_v", "families", "growth_class_family", "builtin_material_hints",
                "blood_families", "amount_thresholds_default"):
        assert key in d, "missing top-level key %r" % key


def test_16_families_present():
    d = load()
    fams = d["families"]
    assert len(fams) == 16, "expected 16 families, got %d (%s)" % (len(fams), sorted(fams))
    assert WET_FAMILIES <= set(fams), "missing wet families: %s" % (WET_FAMILIES - set(fams))
    assert LITTER_FAMILIES <= set(fams), "missing litter families: %s" % (LITTER_FAMILIES - set(fams))


def test_wet_families_have_36_cells_litter_have_16():
    d = load()
    fams = d["families"]
    for fam in WET_FAMILIES:
        n = len(fams[fam]["cells"])
        assert n == 36, "%s: expected 36 cells (20 FULL + 16 PARTIAL), got %d" % (fam, n)
        assert "FULL_ISOLATED" in fams[fam]["cells"]
        assert "PARTIAL_1A" in fams[fam]["cells"]
    for fam in LITTER_FAMILIES:
        n = len(fams[fam]["cells"])
        assert n == 16, "%s: expected 16 PARTIAL-only cells, got %d" % (fam, n)
        assert all(shape.startswith("PARTIAL_") for shape in fams[fam]["cells"]), (
            "%s has a non-PARTIAL cell (litter families are PARTIAL-only): %s" %
            (fam, [s for s in fams[fam]["cells"] if not s.startswith("PARTIAL_")]))


def test_growth_class_family_covers_all_5_wire_values():
    d = load()
    gcf = d["growth_class_family"]
    assert set(gcf.keys()) == {"0", "1", "2", "3", "4"}, gcf
    assert gcf["1"] == "LEAVES" and gcf["2"] == "FRUIT"
    assert gcf["3"] == "FRUIT_SMALL" and gcf["4"] == "FRUIT_LARGE"


def test_blood_families_are_5_and_all_present_in_families():
    d = load()
    assert len(d["blood_families"]) == 5
    for fam in d["blood_families"]:
        assert fam in d["families"], "blood family %r not in families table" % fam


def test_every_referenced_sheet_exists_under_df_install():
    if not DF_ROOT:
        print("SKIP test_every_referenced_sheet_exists_under_df_install: needs DF graphics sheets")
        return
    d = load()
    sheets = {fam["sheet"] for fam in d["families"].values()}
    assert sheets, "no sheets found in spatter_map.json"
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
