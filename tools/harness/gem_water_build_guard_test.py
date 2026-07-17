#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
"""Seeded-bad guard for item-map sheet geometry.

Run: python -B tools/harness/gem_water_build_guard_test.py
"""

import importlib.util
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MOD = os.path.join(ROOT, "tools", "ws2", "build_item_map.py")

spec = importlib.util.spec_from_file_location("build_item_map_guarded", MOD)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

try:
    mod.validate_raw_cell(
        ("SMALLGEMS", 0, 0),
        {"SMALLGEMS": {"cell_w": 16, "cell_h": 16, "page_w": 352, "page_h": 0}},
        "seeded-bad",
    )
except SystemExit:
    print("PASS seeded-bad rows=0 rejected")
    sys.exit(0)

print("FAIL seeded-bad rows=0 was accepted")
sys.exit(1)
