#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WS2 / WD-3: build the interface-chrome sprite map the browser client needs
# to draw DF's REAL toolbar/tab/border art instead of invented letters/emoji.
#
# THE PROBLEM this solves: DF's UI art ships as cells on `interface_bits*.png`
# + ~20 sibling sheets (buttons, borders, unit-status glyphs, calendar icons,
# zone icons, ...), bound by `graphics_interface.txt`'s
#   [TILE_GRAPHICS:PAGE:col:row:TOKEN(:extra...)]
# grammar (same grammar `src/sprite_map.cpp` already parses server-side for
# live tiles, but that pass only needs ONE cell per token and discards the
# rest; this generator needs each token's full on-screen pixel footprint so
# the client can blit it without also knowing every sheet's TILE_DIM).
#
# GRAMMAR IN graphics_interface.txt (verified this session; 5 shapes occur in
# this one file -- other graphics_*.txt siblings under vanilla_interface/
# graphics use extra shapes (animation frames, orientation tags) that are out
# of scope: the spec pins the source to graphics_interface.txt only):
#   (a) 0 extra fields  -- a plain single-cell icon (e.g. INTERFACE_BACKGROUND).
#   (b) extra fields all-integer, 1 or 2 of them -- a MULTI-CELL composite
#       icon: repeated TILE_GRAPHICS lines for the same TOKEN, each carrying
#       the icon's own LOCAL (subcol[,subrow]) offset as the trailing param
#       (e.g. BUTTON_DIG_DIG_INACTIVE:0:0 .. :3:2 is a 4-wide x 3-tall composite
#       glued from 12 sheet cells). anchor = the sheet cell of the token's
#       own (0,0) sub-position; verified: `sheet_col - subcol` /
#       `sheet_row - subrow` is constant across every line of the same token
#       for the overwhelming majority of tokens in this file (2036/2040 of
#       the 2-param lines, 105/111 of the 1-param lines) -- that constant IS
#       the anchor. The handful that do NOT hold this invariant (verified:
#       CALENDAR_MONTH -- its 2 trailing ints are a variant+month INDEX, not
#       spatial offsets; 3 COMBAT_ICON_WRESTLE_* tokens with a single 1-param
#       binding each) fall back to (c).
#   (c) extra fields where the first is NOT an integer (e.g.
#       `UNIT_STATUS:MIGRANT`, `UNIT_STATUS:NO_JOB`, ... 89 named states of
#       the one UNIT_STATUS page) -- these are genuinely separate icons that
#       happen to share a base token name; emit one flat key per variant:
#       "TOKEN:VARIANT".
#   (d) fallback for the rare int-extra token whose anchor is NOT constant
#       (the CALENDAR_MONTH-style outliers) or whose axis can't be inferred
#       (both col and row vary, or neither, across a 1-param group) -- emit
#       one flat key per binding: "TOKEN:extra0[_extra1]", same as (c). This
#       keeps the generator correct-by-construction against future raws
#       changes instead of hardcoding token names.
#   (e) [TILE_GRAPHICS_RECTANGLE:PAGE:col:row:w_cells:h_cells:TOKEN] -- a
#       SEPARATE, single-line grammar (742 lines, WD-4 finding: the original
#       (a)-(d) regex only matched `[TILE_GRAPHICS:`, silently dropping every
#       RECTANGLE line -- that's why BUTTON_INFO_CREATURES/_TASKS/_PLACES/
#       _LABOR/_WORK_ORDERS/_NOBLES/_OBJECTS/_JUSTICE (+ their _ACTIVE pairs),
#       BUTTON_SQUADS, BUTTON_WORLD and BUTTON_STOCKPILE_INACTIVE/_ACTIVE were
#       all missing from interface_map.json even though they're real DF
#       tokens). Verified this session: all 742 RECTANGLE lines have exactly
#       6 colon fields (page:col:row:w:h:TOKEN, no trailing variant), 0
#       duplicate tokens -- so each line maps 1:1 to one token's full pixel
#       rect, no multi-line aggregation needed (simpler than (b)).
#
# OUTPUT SHAPE (per the spec): web/interface_map.json maps
#   TOKEN -> {"img": <sheet basename>, "cx": <px>, "cy": <px>, "w": <px>, "h": <px>}
# cx/cy/w/h are baked to PIXELS (not sheet cell units) using that token's own
# page's [TILE_DIM:w:h] -- interface sheets span two very different tile
# sizes (8x12 "font cell" sheets like interface_bits.png, and 32x32 "icon"
# sheets like unit_status.png/activity_zones.png/calendar.png) so a single
# client-side cell-size constant can't work; baking pixels here means the
# client blit helper never needs to know which sheet uses which TILE_DIM.
#
# Reads the DF install READ-ONLY. Writes web/interface_map.json.
#
# Run (uses the pre-installed venv, stdlib only):
#   python tools/ws2/build_interface_map.py

import json
import os
import re
import sys
from collections import defaultdict

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(_ROOT, "web", "interface_map.json")

DF_ROOT = dfroot.df_root_for(__file__, sub="data/vanilla",
                          purpose="reads Dwarf Fortress's own raws as the ground truth")
INTERFACE_GFX = os.path.join(DF_ROOT, "vanilla_interface", "graphics")
SRC_FILE = os.path.join(INTERFACE_GFX, "graphics_interface.txt")
TILE_PAGE_FILE = os.path.join(INTERFACE_GFX, "tile_page_interface.txt")

TOKEN_RE = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):([^\]]+)\]")
RECT_RE = re.compile(
    r"\[TILE_GRAPHICS_RECTANGLE:([A-Za-z0-9_]+):(-?\d+):(-?\d+):(\d+):(\d+):([A-Za-z0-9_]+)\]")


def _is_int(s):
    try:
        int(s)
        return True
    except ValueError:
        return False


def load_pages(path):
    """[TILE_PAGE:NAME] -> {"sheet": png basename, "tw": tile_w, "th": tile_h}."""
    pages = {}
    name = None
    tw = th = None
    sheet = None
    text = open(path, encoding="latin-1").read()
    for m in re.finditer(r"\[(TILE_PAGE|FILE|TILE_DIM):([^\]]+)\]", text):
        kind, val = m.group(1), m.group(2)
        if kind == "TILE_PAGE":
            if name and sheet and tw and th:
                pages[name] = {"sheet": sheet, "tw": tw, "th": th}
            name, sheet, tw, th = val.strip(), None, None, None
        elif kind == "FILE" and name:
            sheet = os.path.basename(val.strip())
        elif kind == "TILE_DIM" and name:
            parts = val.split(":")
            tw, th = int(parts[0]), int(parts[1])
    if name and sheet and tw and th:
        pages[name] = {"sheet": sheet, "tw": tw, "th": th}
    return pages


def parse_entries(path):
    """base TOKEN -> [(page, col, row, [extra fields as strings]), ...]."""
    entries = defaultdict(list)
    for ln in open(path, encoding="latin-1"):
        m = TOKEN_RE.match(ln.strip())
        if not m:
            continue
        page, col, row, rest = m.groups()
        fields = rest.split(":")
        token = fields[0]
        if not token:
            continue
        entries[token].append((page, int(col), int(row), fields[1:]))
    return entries


def parse_rect_entries(path):
    """[TILE_GRAPHICS_RECTANGLE:PAGE:col:row:w_cells:h_cells:TOKEN] -> {TOKEN: (page, col, row, w_cells, h_cells)}.

    Separate one-line-per-token grammar (shape (e) above) -- no multi-line
    aggregation, no non-integer variant suffixes observed (742/742 lines is a
    clean 6-field match). First binding wins if a raws update ever adds a dup,
    matching the TILE_GRAPHICS convention elsewhere in this file.
    """
    out = {}
    for ln in open(path, encoding="latin-1"):
        m = RECT_RE.match(ln.strip())
        if not m:
            continue
        page, col, row, w_cells, h_cells, token = m.groups()
        if token in out:
            continue
        out[token] = (page, int(col), int(row), int(w_cells), int(h_cells))
    return out


def build_token_records(entries, rect_entries, pages):
    out = {}
    dropped_unresolved_page = []
    ambiguous_axis = []

    def cell(sheet_info, col, row):
        tw, th = sheet_info["tw"], sheet_info["th"]
        return {"img": sheet_info["sheet"], "cx": col * tw, "cy": row * th, "w": tw, "h": th}

    # (e) TILE_GRAPHICS_RECTANGLE tokens first (first-binding-wins vs (a)-(d)
    # below is moot in practice -- no token name collides between the two
    # grammars in this file, verified this session).
    for token, (page, col, row, w_cells, h_cells) in rect_entries.items():
        sheet_info = pages.get(page)
        if not sheet_info:
            dropped_unresolved_page.append((token, page))
            continue
        if token in out:
            continue
        tw, th = sheet_info["tw"], sheet_info["th"]
        out[token] = {"img": sheet_info["sheet"], "cx": col * tw, "cy": row * th,
                      "w": w_cells * tw, "h": h_cells * th}

    for token, rows in entries.items():
        int_rows = [r for r in rows if all(_is_int(x) for x in r[3])]
        noint_rows = [r for r in rows if not all(_is_int(x) for x in r[3])]

        # (c) compound-key variants: first field is not an integer.
        for page, col, row, extra in noint_rows:
            sheet_info = pages.get(page)
            if not sheet_info:
                dropped_unresolved_page.append((token, page))
                continue
            key = token + ":" + "_".join(extra)
            if key in out:
                continue  # first binding wins (matches src/sprite_map.cpp convention)
            out[key] = cell(sheet_info, col, row)

        if not int_rows:
            continue

        sheet_info = pages.get(int_rows[0][0])
        if not sheet_info:
            dropped_unresolved_page.append((token, int_rows[0][0]))
            continue

        plen = len(int_rows[0][3])

        # (a) plain single-cell token, or a single binding regardless of arity
        # (nothing to aggregate against -- e.g. the 3 lone WRESTLE tokens).
        if plen == 0 or len(int_rows) == 1:
            page, col, row, extra = int_rows[0]
            if token not in out:
                out[token] = cell(sheet_info, col, row)
            continue

        if plen == 1:
            cols = {r[1] for r in int_rows}
            rws = {r[2] for r in int_rows}
            axis = "row" if (len(cols) == 1 and len(rws) > 1) else \
                   "col" if (len(rws) == 1 and len(cols) > 1) else None
            anchor_ok = False
            if axis:
                anchors = set()
                for page, col, row, extra in int_rows:
                    p = int(extra[0])
                    anchors.add((col, row - p) if axis == "row" else (col - p, row))
                if len(anchors) == 1:
                    anchor_ok = True
                    ac, ar = next(iter(anchors))
                    params = [int(r[3][0]) for r in int_rows]
                    span = max(params) - min(params) + 1
                    tw, th = sheet_info["tw"], sheet_info["th"]
                    w, h = (tw, th * span) if axis == "row" else (tw * span, th)
                    out[token] = {"img": sheet_info["sheet"], "cx": ac * sheet_info["tw"],
                                  "cy": ar * sheet_info["th"], "w": w, "h": h}
            if not anchor_ok:
                ambiguous_axis.append(token)
                for page, col, row, extra in int_rows:
                    key = f"{token}:{extra[0]}"
                    if key in out:
                        continue
                    out[key] = cell(sheet_info, col, row)
            continue

        if plen == 2:
            anchors = {(r[1] - int(r[3][0]), r[2] - int(r[3][1])) for r in int_rows}
            if len(anchors) == 1:
                ac, ar = next(iter(anchors))
                subcols = [int(r[3][0]) for r in int_rows]
                subrows = [int(r[3][1]) for r in int_rows]
                w_cells = max(subcols) - min(subcols) + 1
                h_cells = max(subrows) - min(subrows) + 1
                tw, th = sheet_info["tw"], sheet_info["th"]
                out[token] = {"img": sheet_info["sheet"], "cx": ac * tw, "cy": ar * th,
                              "w": w_cells * tw, "h": h_cells * th}
            else:
                ambiguous_axis.append(token)
                for page, col, row, extra in int_rows:
                    key = f"{token}:{extra[0]}_{extra[1]}"
                    if key in out:
                        continue
                    out[key] = cell(sheet_info, col, row)
            continue

        # plen >= 3 not observed in graphics_interface.txt this session; keep a
        # safe fallback so a raws update doesn't silently drop tokens.
        ambiguous_axis.append(token)
        for page, col, row, extra in int_rows:
            key = token + ":" + "_".join(extra)
            if key in out:
                continue
            out[key] = cell(sheet_info, col, row)

    return out, dropped_unresolved_page, ambiguous_axis


def main():
    pages = load_pages(TILE_PAGE_FILE)
    entries = parse_entries(SRC_FILE)
    rect_entries = parse_rect_entries(SRC_FILE)
    tokens, dropped, ambiguous = build_token_records(entries, rect_entries, pages)

    out = {"_v": 1}
    out.update(tokens)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)

    sheets = sorted({v["img"] for v in tokens.values()})
    print(f"wrote {OUT}")
    print(f"interface tokens = {len(tokens)} (base raw TOKEN names = {len(entries)}, "
          f"rectangle TOKEN names = {len(rect_entries)})")
    print(f"sheets referenced = {len(sheets)}: {sheets}")
    if dropped:
        print(f"dropped (unresolved TILE_PAGE) = {len(dropped)}: {dropped[:10]}")
    if ambiguous:
        print(f"non-spatial/ambiguous int-extra tokens (compound-keyed, not composited) = "
              f"{len(ambiguous)}: {ambiguous}")
    if "BUTTON_BUILDING_INACTIVE" in tokens:
        print("sample BUTTON_BUILDING_INACTIVE =", tokens["BUTTON_BUILDING_INACTIVE"])
    if "BUTTON_INFO_CREATURES" in tokens:
        print("sample BUTTON_INFO_CREATURES =", tokens["BUTTON_INFO_CREATURES"])


if __name__ == "__main__":
    main()
