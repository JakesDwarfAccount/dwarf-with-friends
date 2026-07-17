#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WC-9 acceptance check for tools/ws2/build_tiletype_token_map.py's output
# (web/tiletype_token_map.json) -- the brook/river/pool/ice/fire family additions on top
# of WB-3's variant-digit fix. Plain asserts -- run either as `python -m pytest -q` or
# directly:
#   python tools/ws2/tests/test_token_map.py

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TOKEN_MAP_PATH = os.path.join(REPO, "web", "tiletype_token_map.json")
# Snapshot of every ttname key present right after WB-3 landed (407 entries, the variant-
# digit fix but before WC-9's new families) -- committed alongside this test so "zero
# regressions on the existing keys" is checkable without needing git history at test time.
BASELINE_KEYS_PATH = os.path.join(HERE, "token_map_wb3_baseline_keys.json")


def load():
    with open(TOKEN_MAP_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_baseline_keys():
    with open(BASELINE_KEYS_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _resolves(entry):
    """An entry "resolves" if it (or its overlay, for the WB-3 base+overlay families) has
    a non-empty token string -- i.e. the client will draw something other than flat color."""
    return bool(entry) and bool(entry.get("token"))


def test_entry_count_at_least_490():
    d = load()
    assert len(d) >= 490, "expected >=490 mapped tiletypes, got %d" % len(d)


def test_brook_family_at_least_10():
    d = load()
    brook = [k for k in d if k.startswith("Brook")]
    assert len(brook) >= 10, "expected >=10 Brook* keys, got %d (%s)" % (len(brook), brook)
    assert all(_resolves(d[k]) for k in brook), "some Brook* keys don't resolve to a token"


def test_river_family_at_least_12():
    d = load()
    river = [k for k in d if k.startswith("River") or k == "Waterfall"]
    assert len(river) >= 12, "expected >=12 River*/Waterfall keys, got %d (%s)" % (
        len(river), river)
    assert all(_resolves(d[k]) for k in river), "some River*/Waterfall keys don't resolve"


def test_frozen_family_at_least_30():
    d = load()
    frozen = [k for k in d if k.startswith("Frozen")]
    assert len(frozen) >= 30, "expected >=30 Frozen* keys, got %d" % len(frozen)
    assert all(_resolves(d[k]) for k in frozen), "some Frozen* keys don't resolve"


def test_fire_family_at_least_6():
    d = load()
    fire_family = [k for k in d if k in ("Fire", "Campfire", "Driftwood", "MagmaFlow")
                   or k.startswith("Ashes") or k.startswith("BurningTree")]
    assert len(fire_family) >= 6, "expected >=6 fire-family keys, got %d (%s)" % (
        len(fire_family), fire_family)
    assert all(_resolves(d[k]) for k in fire_family), "some fire-family keys don't resolve"


def test_zero_regressions_on_wb3_baseline_keys():
    d = load()
    baseline_keys = load_baseline_keys()
    missing = [k for k in baseline_keys if k not in d]
    assert not missing, "keys present after WB-3 went missing after WC-9: %s" % missing
    broken = [k for k in baseline_keys if not _resolves(d[k])]
    assert not broken, "keys that resolved after WB-3 stopped resolving after WC-9: %s" % broken


def test_frozen_wall_upgraded_to_material_specific_fortification():
    # WC-9 also fixed an existing gap while it was in the neighborhood: FrozenFortification
    # previously fell through to the generic "FORTIFICATION" token (material-blind);
    # confirm it now gets the ice-specific cell.
    d = load()
    assert d["FrozenFortification"]["token"] == "FORTIFICATION_ICE"


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
