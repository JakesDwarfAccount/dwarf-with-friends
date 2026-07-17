#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WC-17 acceptance check for tools/ws2/build_grass_colors.py's output
# (web/grass_colors.json). Plain asserts -- run either as `python -m pytest -q` or
# directly: python tools/ws2/tests/test_grass_colors.py

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GRASS_COLORS_PATH = os.path.join(REPO, "web", "grass_colors.json")


def load():
    with open(GRASS_COLORS_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def test_top_level_shape():
    d = load()
    for key in ("_v", "palette_source", "palette", "plants"):
        assert key in d, "missing top-level key %r" % key
    assert isinstance(d["palette"], list) and len(d["palette"]) == 16, \
        "palette must have exactly 16 entries (DFHack color_value 0..15)"
    for entry in d["palette"]:
        assert isinstance(entry, list) and len(entry) == 3, "each palette entry is [r,g,b]"
        for c in entry:
            assert 0 <= c <= 255


def test_at_least_35_species():
    d = load()
    assert len(d["plants"]) >= 35, "expected >=35 grass species entries, got %d" % len(d["plants"])


def test_known_species_present_with_4_tiers():
    d = load()
    plants = d["plants"]
    assert "MEADOW-GRASS" in plants, "MEADOW-GRASS should be a real vanilla grass species"
    for pid in ("MEADOW-GRASS", "HAIR GRASS", "BENTGRASS"):
        assert pid in plants, "%r missing from grass_colors.json" % pid
        tiers = plants[pid]["tiers"]
        assert len(tiers) == 4, "%r must have exactly 4 coverage tiers" % pid
        for tier in tiers:
            for key in ("fg", "bg", "bright", "rgb"):
                assert key in tier, "%r tier missing %r" % (pid, key)
            assert isinstance(tier["rgb"], list) and len(tier["rgb"]) == 3
            for c in tier["rgb"]:
                assert 0 <= c <= 255, "rgb channel out of range: %r" % (tier["rgb"],)


def test_every_species_has_exactly_4_tiers():
    d = load()
    for pid, entry in d["plants"].items():
        assert len(entry["tiers"]) == 4, "%r does not have exactly 4 tiers" % pid


def test_meadow_grass_matches_known_raw_pattern():
    # plant_grasses.txt: [GRASS_COLORS:2:0:1:2:0:0:6:0:1:6:0:0] for MEADOW-GRASS (verified
    # this session) -- tier0 fg=2/bright=1 (bright green), tier1 fg=2/bright=0 (green),
    # tier2 fg=6/bright=1 (yellow), tier3 fg=6/bright=0 (brown).
    d = load()
    tiers = d["plants"]["MEADOW-GRASS"]["tiers"]
    expect = [(2, 0, True), (2, 0, False), (6, 0, True), (6, 0, False)]
    for i, (fg, bg, br) in enumerate(expect):
        assert tiers[i]["fg"] == fg and tiers[i]["bg"] == bg and tiers[i]["bright"] == br, \
            "tier %d mismatch: got %r want fg=%d bg=%d bright=%s" % (i, tiers[i], fg, bg, br)


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
