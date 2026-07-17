#!/usr/bin/env python
# dwf - SPDX-License-Identifier: AGPL-3.0-only
#
# Gate G1 for T1a (spec docs/superpowers/specs/2026-07-08-asset-material-parity
# -spec.md section 6, row G1): material_map.json correctness.
#   method:    >=20 pinned rows incl. template-inherited colors + 2 edge cells
#              (RAW_ADAMANTINE, a soil); threshold 20/20.
#   test-the-test (protocol rule 3): one SEEDED-WRONG pin must FAIL the check,
#              proving the check can fail; then the real suite passes.
#
# The pins' expected COLOR TOKENS were derived by reading the raws by hand
# (blocks cited inline); the test joins each token through the SHIPPED palette
# (material_map.palette.byname) to an expected row, so a mis-parse of
# STATE_COLOR, a wrong mat_index order, or a wrong family all fail the check --
# it is NOT tautological against the generator's own row integers.
#
# Run (pre-installed venv):
#   python \
#       tools/ws2/tests/material_map_test.py
# Exit 0 = pass; non-zero = failure.

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WS2 = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(WS2, "..", ".."))
sys.path.insert(0, WS2)

import build_material_map as gen  # noqa: E402

MAP_PATH = os.path.join(REPO, "web", "material_map.json")

# --- pinned inorganics: (id, expected STATE_COLOR:ALL_SOLID token, family) ----
# Every color token below was read directly from the raws (file:block). The two
# edge cells are RAW_ADAMANTINE (no USE_MATERIAL_TEMPLATE; own STATE_COLOR at the
# very end of its block) and the CLAY/SILTY_CLAY soils.
INORGANIC_PINS = [
    # inorganic_metal.txt
    ("IRON",             "GRAY",        "METAL"),   # own STATE_COLOR:GRAY
    ("GOLD",             "GOLD",        "METAL"),   # own STATE_COLOR:GOLD
    # inorganic_stone_gem.txt  (saturated gems, the palette-swap headline)
    ("GREEN TOURMALINE", "GREEN",       "GEM"),
    ("ALEXANDRITE",      "VIOLET",      "GEM"),
    ("FIRE OPAL",        "SCARLET",     "GEM"),
    ("RUBY",             "SCARLET",     "GEM"),
    ("SAPPHIRE",         "SAPPHIRE",    "GEM"),
    ("EMERALD",          "EMERALD",     "GEM"),
    ("AMETHYST",         "AMETHYST",    "GEM"),
    ("DEMANTOID",        "GREEN-YELLOW","GEM"),
    ("SPINEL_PURPLE",    "PURPLE",      "GEM"),
    ("TANZANITE",        "AZURE",       "GEM"),
    ("RHODOLITE",        "PUCE",        "GEM"),
    ("PINK TOURMALINE",  "PINK",        "GEM"),
    ("PRASE",            "SPRING_GREEN","GEM"),
    ("SUNSTONE",         "PUMPKIN",     "GEM"),
    ("LAPIS LAZULI",     "ULTRAMARINE", "GEM"),
    ("ONYX",             "BLACK",       "GEM"),
    ("BLUE JADE",        "BLUE",        "GEM"),
    # inorganic_stone_mineral.txt
    ("MICROCLINE",       "AQUA",        "STONE"),
    ("RAW_ADAMANTINE",   "AQUA",        "STONE"),   # EDGE: no template
    # inorganic_stone_soil.txt
    ("CLAY",             "BRASS",       "SOIL"),    # EDGE: soil
    ("SILTY_CLAY",       "DARK_TAN",    "SOIL"),
]

# --- template-inherited colors (creature_generic reads the material TEMPLATE's
# STATE_COLOR directly -> exercises the inheritance path required by G1) --------
CREATURE_GENERIC_PINS = [
    ("BONE",    "WHITE"),       # BONE_TEMPLATE   STATE_COLOR:ALL_SOLID:WHITE
    ("SHELL",   "DARK_GREEN"),  # SHELL_TEMPLATE  STATE_COLOR:ALL_SOLID:DARK_GREEN
    ("LEATHER", "BROWN"),       # LEATHER_TEMPLATE STATE_COLOR:ALL_SOLID:BROWN
]

# --- plant WOOD (own-override path) -------------------------------------------
# CARAMBOLA WOOD material carries its own STATE_COLOR:ALL_SOLID:FLAX (verified in
# plant_new_trees.txt), overriding WOOD_TEMPLATE's BROWN.
PLANT_PINS = [
    ("CARAMBOLA", "WOOD", "FLAX"),
]

# --- index-order pins (spec 3, VERIFIED vs live world memory) -----------------
INDEX_PINS = [(0, "IRON"), (1, "GOLD"), (97, "GREEN TOURMALINE"),
              (233, "MICROCLINE"), (242, "RAW_ADAMANTINE")]

# --- SEEDED-WRONG pin (test-the-test): IRON is GRAY, NOT GOLD -----------------
SEEDED_WRONG_PIN = ("IRON", "GOLD", "METAL")


def load_map():
    with open(MAP_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def check_inorganic_pins(m, pins):
    """Return list of failure strings (empty == all pass)."""
    byname = m["palette"]["byname"]
    by_id = {e["id"]: e for e in m["inorganic"]}
    fails = []
    for mid, color_token, family in pins:
        if color_token not in byname:
            fails.append("%s: color token %r not in palette.byname"
                         % (mid, color_token))
            continue
        exp_row = byname[color_token]
        e = by_id.get(mid)
        if e is None:
            fails.append("%s: not present in inorganic[]" % mid)
            continue
        if e["row"] != exp_row:
            fails.append("%s: row %r != expected %r (%s)"
                         % (mid, e["row"], exp_row, color_token))
        if e["family"] != family:
            fails.append("%s: family %r != expected %r"
                         % (mid, e["family"], family))
    return fails


def main():
    m = load_map()

    # structural sanity
    assert m["_v"] == 1
    assert len(m["palette"]["rows"]) == 137, "palette must have 137 rows"
    assert all(len(r) == 18 for r in m["palette"]["rows"]), "18 cols/row"
    assert m["default_row"] == m["palette"]["rows"][0], "default_row == rows[0]"
    assert len(m["inorganic"]) == 265, "must be exactly 265 inorganics"

    # index-order (mat_index contract)
    for idx, tok in INDEX_PINS:
        got = m["inorganic"][idx]["id"]
        assert got == tok, "index %d expected %r got %r" % (idx, tok, got)

    # ---- STEP 1: test-the-test -- the SEEDED-WRONG pin MUST fail -------------
    wrong_fails = check_inorganic_pins(m, [SEEDED_WRONG_PIN])
    print("[test-the-test] seeded-wrong pin %s -> %d failure(s):"
          % (SEEDED_WRONG_PIN, len(wrong_fails)))
    for f in wrong_fails:
        print("    (expected) FAIL:", f)
    if not wrong_fails:
        print("FATAL: seeded-wrong pin did NOT fail -- the check is broken")
        return 2
    print("    OK: the check can fail as designed.\n")

    # ---- STEP 2: the real suite MUST pass -----------------------------------
    fails = check_inorganic_pins(m, INORGANIC_PINS)

    byname = m["palette"]["byname"]
    # creature_generic (template-inherited colors)
    for key, color_token in CREATURE_GENERIC_PINS:
        exp = byname.get(color_token)
        got = m["creature_generic"].get(key)
        if got != exp:
            fails.append("creature_generic[%s]: %r != expected %r (%s)"
                         % (key, got, exp, color_token))
    # plant WOOD
    for ptok, local, color_token in PLANT_PINS:
        exp = byname.get(color_token)
        got = m["plant"].get(ptok, {}).get(local)
        if got != exp:
            fails.append("plant[%s][%s]: %r != expected %r (%s)"
                         % (ptok, local, got, exp, color_token))

    npins = len(INORGANIC_PINS) + len(CREATURE_GENERIC_PINS) + len(PLANT_PINS)
    print("[real suite] %d pinned rows checked" % npins)
    if fails:
        print("FAILURES (%d):" % len(fails))
        for f in fails:
            print("    FAIL:", f)
        return 1

    # ---- STEP 3: template-inheritance mechanism unit test -------------------
    # A material with NO own STATE_COLOR must inherit its template's. Vanilla
    # inorganics never trigger this (all 265 carry their own), so prove the code
    # path directly with a synthetic material via the generator's own resolver.
    templates = gen.parse_templates()
    inherited = gen.resolve_color({}, "STONE_TEMPLATE", templates)
    assert inherited == "GRAY", "template inheritance broken: %r" % inherited
    overridden = gen.resolve_color({"ALL_SOLID": "SCARLET"},
                                   "STONE_TEMPLATE", templates)
    assert overridden == "SCARLET", "own STATE_COLOR must override template"
    print("[mechanism] template inheritance + override: OK")

    # print the resolved pins for the record
    by_id = {e["id"]: e for e in m["inorganic"]}
    print("\nResolved inorganic pins:")
    for mid, color_token, family in INORGANIC_PINS:
        e = by_id[mid]
        print("    %-18s idx=%3d row=%3d (%-13s) family=%s"
              % (mid, m["inorganic"].index(e), e["row"], color_token,
                 e["family"]))

    print("\nG1 PASS: %d/%d pinned rows correct, seeded-wrong pin failed as "
          "required." % (npins, npins))
    return 0


if __name__ == "__main__":
    sys.exit(main())
