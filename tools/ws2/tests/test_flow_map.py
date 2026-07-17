#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WC-16 acceptance check for tools/ws2/build_flow_map.py's output (web/flow_map.json).
# Plain asserts -- run either as `python -m pytest -q` or directly:
#   python tools/ws2/tests/test_flow_map.py

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
FLOW_MAP_PATH = os.path.join(REPO, "web", "flow_map.json")


def load():
    with open(FLOW_MAP_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def test_top_level_shape():
    d = load()
    for key in ("_v", "flow_type_token", "flow_type_name", "sheet", "frames_per_token"):
        assert key in d, "missing top-level key %r" % key
    assert d["sheet"] == "event_flows.png"
    assert d["frames_per_token"] == 4


def test_14_flow_types_present():
    d = load()
    tt = d["flow_type_token"]
    assert set(tt.keys()) == {str(i) for i in range(14)}, sorted(tt.keys())


def test_known_mappings():
    d = load()
    tt = d["flow_type_token"]
    assert tt["0"] == "FLOW_MIASMA"
    assert tt["2"] == "FLOW_WATER_MIST"       # Mist (waterfall) -- WC-15/16's SCN-G target
    assert tt["5"] == "FLOW_SMOKE"
    assert tt["6"] == "FLOW_DRAGONFIRE"
    assert tt["7"] == "FLOW_FIRE"
    assert tt["13"] == "FLOW_ITEM"


def test_steam_and_materialgas_share_boiling():
    d = load()
    tt = d["flow_type_token"]
    assert tt["1"] == "FLOW_BOILING" and tt["9"] == "FLOW_BOILING"


def test_web_oceanwave_seafoam_have_no_art():
    d = load()
    tt = d["flow_type_token"]
    assert tt["8"] is None, "Web should have no flow art (renders via item/thread path)"
    assert tt["11"] is None, "OceanWave verified absent from vanilla graphics raws"
    assert tt["12"] is None, "SeaFoam verified absent from vanilla graphics raws"


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
