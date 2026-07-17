#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# Regression test for tools/ws2/build_creature_map.py's animal-person/troll
# flat-fallback compositor. Run directly:
#   python tools/harness/creature_composite_map_test.py

import importlib.util
import os
import sys

sys.dont_write_bytecode = True

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GEN_PATH = os.path.join(ROOT, "tools", "ws2", "build_creature_map.py")

spec = importlib.util.spec_from_file_location("build_creature_map", GEN_PATH)
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)


def fail(msg):
    raise AssertionError(msg)


def rec_cell(rec):
    return {k: rec[k] for k in ("sheet", "col", "row", "w", "h") if k in rec}


def assert_cell(races, race, expect):
    rec = races.get(race)
    if not rec:
        fail("control %s missing" % race)
    for k, v in expect.items():
        if rec.get(k) != v:
            fail("control %s changed %s: got %r expected %r in %r" % (
                race, k, rec.get(k), v, rec_cell(rec)))


def paste_origin_for(layer, span):
    img = gen.load_source_image(layer["ref"])
    canvas_size = (span[0] * gen.CELL, span[1] * gen.CELL)
    if img.size == canvas_size:
        return 0, 0, img
    ax = (0 if span[0] == 1 else 1) * gen.CELL
    ay = (span[1] - 1) * gen.CELL
    dx, dy = layer["offset"]
    return ax + dx, ay + dy, img


def matching_body_pixels(rendered, layers, span):
    body = next((layer for layer in layers if layer["name"] == "BODY"), None)
    if body is None:
        fail("fixture has no BODY layer")
    x, y, body_img = paste_origin_for(body, span)
    n = 0
    for by in range(body_img.height):
        gy = y + by
        if gy < 0 or gy >= rendered.height:
            continue
        for bx in range(body_img.width):
            gx = x + bx
            if gx < 0 or gx >= rendered.width:
                continue
            bp = body_img.getpixel((bx, by))
            if bp[3] == 0:
                continue
            rp = rendered.getpixel((gx, gy))
            if rp == bp:
                n += 1
    return n


def main():
    result, entries, atlas = gen.build_map(write=False)
    races = result["races"]
    entries_by_race = {entry["race"]: entry for entry in entries}

    specimen = races.get("CHAMELEON_MAN")
    if not specimen:
        fail("CHAMELEON_MAN missing from generated races")
    if specimen.get("sheet") != gen.COMPOSITE_ATLAS:
        fail("CHAMELEON_MAN did not resolve to the generated composite atlas: %r" % rec_cell(specimen))
    if "CHAMELEON_MAN" not in entries_by_race:
        fail("CHAMELEON_MAN has no composite entry")

    troll = races.get("TROLL")
    if not troll or troll.get("sheet") != gen.COMPOSITE_ATLAS or troll.get("w") != 3 or troll.get("h") != 2:
        fail("TROLL did not resolve to a 3x2 generated composite cell: %r" % rec_cell(troll or {}))

    controls = {
        "CAMEL_1_HUMP": {"sheet": "creatures_surface.png", "col": 0, "row": 88},
        "ELEPHANT": {"sheet": "creatures_surface_large.png", "col": 0, "row": 2, "w": 3, "h": 2},
        "HORSE": {"sheet": "creatures_domestic.png", "col": 0, "row": 12},
        "AARDVARK": {"sheet": "creatures_surface.png", "col": 0, "row": 0},
        "DINGO": {"sheet": "creatures_surface.png", "col": 0, "row": 36},
        "ANT": {"sheet": "creatures_small.png", "col": 0, "row": 3},
        "HONEY_BEE": {"sheet": "creatures_small.png", "col": 0, "row": 55},
        "MUSSEL": {"sheet": "creatures_small.png", "col": 0, "row": 75},
        "OYSTER": {"sheet": "creatures_small.png", "col": 0, "row": 79},
        "SQUID": {"sheet": "creatures_small.png", "col": 0, "row": 102},
        "WORM": {"sheet": "creatures_small.png", "col": 0, "row": 111},
        "WORM_KNUCKLE": {"sheet": "creatures_small.png", "col": 0, "row": 111},
        "DWARF": {"baked": "dwarf.png"},
        "ELF": {"baked": "dwarf.png"},
        "GOBLIN": {"baked": "dwarf.png"},
        "HUMAN": {"baked": "dwarf.png"},
        "KOBOLD": {"baked": "dwarf.png"},
    }
    for race, expect in controls.items():
        rec = races.get(race)
        if rec and rec.get("sheet") == gen.COMPOSITE_ATLAS:
            fail("control %s was incorrectly repointed to composite atlas" % race)
        assert_cell(races, race, expect)

    bad_fixups = {
        "WORM_KNUCKLE": {
            "from": {"sheet": "creatures_small.png", "col": 0, "row": 57},
            "to": {"sheet": "creatures_small.png", "col": 0, "row": 57},
        },
    }
    bad_result, _bad_entries, _bad_atlas = gen.build_map(write=False, live_cell_fixups=bad_fixups)
    try:
        assert_cell(bad_result["races"], "WORM_KNUCKLE", controls["WORM_KNUCKLE"])
    except AssertionError:
        pass
    else:
        fail("test-the-test failed: seeded WORM_KNUCKLE row 57 was not detected")

    # Span lock: every atlas record must occupy exactly its declared slot size.
    for entry in entries:
        rec = races[entry["race"]]
        span = (rec.get("w", 1), rec.get("h", 1))
        if span != entry["span"]:
            fail("span mismatch for %s: rec=%r entry=%r" % (entry["race"], span, entry["span"]))
        x0 = rec["col"] * gen.CELL
        y0 = rec["row"] * gen.CELL
        crop = atlas.crop((x0, y0, x0 + span[0] * gen.CELL, y0 + span[1] * gen.CELL))
        if gen.opaque_pixels(crop) <= 0:
            fail("blank composite atlas slot for %s" % entry["race"])

    chameleon_entry = entries_by_race["CHAMELEON_MAN"]
    pages, _unservable, page_files = gen.load_pages()
    block = next(inner for _path, kind, _args, race, inner in gen.iter_graphics_blocks(gen.graphics_files())
                 if kind == "CREATURE_GRAPHICS" and race == "CHAMELEON_MAN")
    src = gen.composite_source_for_block(block, pages, page_files)
    good = gen.render_composite(src["layers"], chameleon_entry["span"])
    bad = gen.render_composite([layer for layer in src["layers"] if layer["name"] != "BODY"], chameleon_entry["span"])
    good_body = matching_body_pixels(good, src["layers"], chameleon_entry["span"])
    bad_body = matching_body_pixels(bad, src["layers"], chameleon_entry["span"])
    if good_body < 20:
        fail("good compositor did not preserve enough BODY pixels, got %d" % good_body)
    if bad_body >= 20:
        fail("test-the-test failed: skipping BODY was not detected, body pixels=%d" % bad_body)

    print("PASS creature_composite_map_test: composites=%d atlas=%s size=%dx%d" % (
        len(entries), gen.COMPOSITE_ATLAS, atlas.width, atlas.height))


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("FAIL creature_composite_map_test -", e)
        sys.exit(1)
