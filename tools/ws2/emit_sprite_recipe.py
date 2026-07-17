#!/usr/bin/env python
"""
emit_sprite_recipe.py -- W11 (sprite provenance): emit host/sprite_recipe.json.

WHY THIS EXISTS
---------------
The eight PNGs the web client uses (dwarf.png, dwarf_dark.png, dwarf_female.png,
animal_people_flat.png, item_chair_composite.png, item_hatch_composite.png,
item_table_composite.png, favicon.png) are composited from the paid Dwarf
Fortress graphics, so they may not be redistributed in this repository. Instead
of shipping the PIXELS, we ship the RECIPE: a JSON file of crop/blit/palette-
remap coordinates into the HOST'S OWN DF install. host/bake_sprites.mjs (plain
Node, zero deps) replays the recipe at install time and writes the PNGs into
the deployed web root. The recipe contains coordinates and palette ROW INDICES
only -- not one pixel of Bay 12 / Kitfox artwork.

This emitter reuses the exact tables/logic of the original bakers so the
replayed output is pixel-identical to what those bakers produced:
  - bake_dwarf.py            (BODY_PARTS / HAIR_CELL / BEARD_CELL / VARIANTS)
  - build_item_map.py        (HATCH_* constants, LEG_COMPOSITE_FAMILIES)
  - build_creature_map.py    (build_map(write=False) -> composite entries+layers)

Run (dev machine only; hosts never run Python):
  python tools/ws2/emit_sprite_recipe.py

Reads the DF install READ-ONLY. Writes only host/sprite_recipe.json.
"""

import hashlib
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)

import bake_dwarf
import build_creature_map
import build_item_map

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
sys.path.insert(0, os.path.join(REPO, "tools", "lib"))
import dfroot  # noqa: E402

DF_ROOT = dfroot.df_root_for(
    __file__, purpose="reads the DF art layout to emit the sprite bake recipe")
OUT_PATH = os.path.join(REPO, "host", "sprite_recipe.json")
CELL = 32

# favicon design (ours): dark rounded-rect background + the baked dwarf at 2x
# nearest-neighbor. Corner mask = per-row transparent run widths from each edge
# (extracted from the original web/favicon.png; the SHAPE is our design, the
# dwarf pixels come from the host's install at replay time).
FAVICON_SIZE = 64
FAVICON_BG = (26, 22, 19, 255)
FAVICON_CORNER_RUNS = [7, 5, 4, 3, 2, 1, 1]


def df_rel(abspath):
    """Path relative to the DF root, forward slashes (what the replay resolves)."""
    rel = os.path.relpath(os.path.abspath(abspath), DF_ROOT)
    if rel.startswith(".."):
        raise SystemExit(f"source escapes DF root: {abspath}")
    return rel.replace(os.sep, "/")


class Tables:
    """Interned sources + remaps so ops stay compact arrays."""

    def __init__(self):
        self.sources = []
        self._src_idx = {}
        self.remaps = []
        self._remap_idx = {}

    def src(self, abspath):
        rel = df_rel(abspath)
        if rel not in self._src_idx:
            self._src_idx[rel] = len(self.sources)
            self.sources.append(rel)
        return self._src_idx[rel]

    def remap(self, palette_abspath, src_row, dst_row):
        key = (df_rel(palette_abspath), src_row, dst_row)
        if key not in self._remap_idx:
            self._remap_idx[key] = len(self.remaps)
            self.remaps.append({"palette": key[0], "from": src_row, "to": dst_row})
        return self._remap_idx[key]


def blit(t, src_abspath, sx, sy, w, h, dx, dy, remap_idx=-1):
    return ["b", t.src(src_abspath), sx, sy, w, h, dx, dy, remap_idx]


def emit_dwarf_variants(t, outputs):
    dfdir = os.path.join(
        DF_ROOT, "data", "vanilla", "vanilla_creatures_graphics",
        "graphics", "images", "dwarf")
    body_png = os.path.join(dfdir, "dwarf_body.png")
    body_pal = os.path.join(dfdir, "dwarf_body_palettes.png")
    hair_png = os.path.join(dfdir, "dwarf_hair.png")
    hair_pal = os.path.join(dfdir, "dwarf_hair_palettes.png")
    hpal_rows = Image.open(hair_pal).height  # beard row clamp, as in bake_dwarf

    for fname, kw in bake_dwarf.VARIANTS.items():
        row = 1 if kw["caste"] == "MALE" else 2
        ops = []
        for _name, c, r, remapped in bake_dwarf.BODY_PARTS:
            rr = row if r == "sex" else r
            ridx = t.remap(body_pal, 0, kw["body_pal"]) if remapped else -1
            ops.append(blit(t, body_png, c * CELL, rr * CELL, CELL, CELL, 0, 0, ridx))
        hc, hr = bake_dwarf.HAIR_CELL
        ops.append(blit(t, hair_png, hc * CELL, hr * CELL, CELL, CELL, 0, 0,
                        t.remap(hair_pal, 0, kw["hair_pal"])))
        if kw["beard"]:
            bc, br = bake_dwarf.BEARD_CELL
            beard_row = min(kw["hair_pal"] + 1, hpal_rows - 1)
            ops.append(blit(t, hair_png, bc * CELL, br * CELL, CELL, CELL, 0, 0,
                            t.remap(hair_pal, 0, beard_row)))
        outputs[fname] = {"w": CELL, "h": CELL, "ops": ops}


def emit_item_composites(t, outputs):
    images = os.path.join(build_item_map.ITEMS_GFX, "images")

    # hatch: 4 material families x 4 detail variants (build_hatch_composite_sheet)
    src = os.path.join(images, "item_hatch.png")
    ops = []
    fam = build_item_map.HATCH_FAMILY_ROW
    var = build_item_map.HATCH_VARIANT_ROW
    for family, row in fam.items():
        for variant, vrow in var.items():
            dx, dy = var[variant] * CELL, row * CELL
            ops.append(blit(t, src, 1 * CELL, row * CELL, CELL, CELL, dx, dy))    # base
            ops.append(blit(t, src, 8 * CELL, vrow * CELL, CELL, CELL, dx, dy))   # overlay
    outputs[build_item_map.HATCH_COMPOSITE_SHEET] = {
        "w": len(var) * CELL, "h": len(fam) * CELL, "ops": ops}

    # tables + chairs: material base cell under the leg-variant overlay
    for family, spec in build_item_map.LEG_COMPOSITE_FAMILIES.items():
        src = os.path.join(images, spec["src"])
        lc, lr = spec["legs"]
        ops = []
        for mat, row in spec["rows"].items():
            bc, br = spec["bases"][mat]
            ops.append(blit(t, src, bc * CELL, br * CELL, CELL, CELL, 0, row * CELL))
            ops.append(blit(t, src, lc * CELL, lr * CELL, CELL, CELL, 0, row * CELL))
        outputs[spec["sheet"]] = {"w": CELL, "h": len(spec["rows"]) * CELL, "ops": ops}


def emit_atlas(t, outputs):
    """Replicate render_composite + pack_composites as concrete pre-clipped blits."""
    _result, entries, atlas = build_creature_map.build_map(write=False)
    ops = []
    for entry in entries:
        sw, sh = entry["span"]
        cw, ch = sw * CELL, sh * CELL
        anchor_x = (0 if sw == 1 else 1) * CELL
        anchor_y = (sh - 1) * CELL
        base_x, base_y = entry["col"] * CELL, entry["row"] * CELL
        for layer in entry["layers"]:
            ref = layer["ref"]
            iw, ih = ref["w"] * CELL, ref["h"] * CELL
            if (iw, ih) == (cw, ch):
                x, y = 0, 0
            else:
                dx, dy = layer["offset"]
                x, y = anchor_x + dx, anchor_y + dy
            # paste_clipped: clip [x, x+iw) x [y, y+ih) to the span canvas
            left, top = max(0, x), max(0, y)
            right, bottom = min(cw, x + iw), min(ch, y + ih)
            if right <= left or bottom <= top:
                continue
            ops.append(blit(
                t, ref["image_path"],
                ref["col"] * CELL + (left - x), ref["row"] * CELL + (top - y),
                right - left, bottom - top,
                base_x + left, base_y + top))
    outputs[build_creature_map.COMPOSITE_ATLAS] = {
        "w": atlas.width, "h": atlas.height, "ops": ops}


def emit_favicon(outputs):
    n = FAVICON_SIZE
    clear = []
    for y, run in enumerate(FAVICON_CORNER_RUNS):
        for x in range(run):
            clear += [[x, y], [n - 1 - x, y], [x, n - 1 - y], [n - 1 - x, n - 1 - y]]
    outputs["favicon.png"] = {"w": n, "h": n, "ops": [
        ["fill"] + list(FAVICON_BG),
        ["o", "dwarf.png", 2, 0, 0],   # baked dwarf, 2x nearest-neighbor
        ["clear", sorted(clear)],
    ]}


def main():
    if not os.path.isdir(DF_ROOT):
        raise SystemExit(f"DF root not found: {DF_ROOT} (set DWF_DF_ROOT)")
    t = Tables()
    outputs = {}
    emit_dwarf_variants(t, outputs)
    emit_item_composites(t, outputs)
    emit_atlas(t, outputs)
    emit_favicon(outputs)

    recipe = {
        "_note": ("Sprite bake recipe (W11). Coordinates + palette-row indices ONLY -- "
                  "contains no Dwarf Fortress artwork. host/bake_sprites.mjs replays these "
                  "ops against the HOST'S OWN DF install to produce the web client's "
                  "composite sprites. op forms: ['b', srcIdx, sx, sy, w, h, dx, dy, remapIdx] "
                  "alpha-composites a crop of sources[srcIdx] (remapIdx>=0: recolor pixels "
                  "matching remaps[i].palette row 'from' to row 'to' first); "
                  "['fill', r, g, b, a]; ['o', outputName, scale, dx, dy] composites an "
                  "already-baked output at integer scale; ['clear', [[x,y],...]] makes "
                  "pixels transparent. Generated by tools/ws2/emit_sprite_recipe.py."),
        "version": 1,
        "generatedFrom": "tools/ws2/emit_sprite_recipe.py",
        "sources": t.sources,
        "remaps": t.remaps,
        "outputs": outputs,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(recipe, fh, indent=1)
        fh.write("\n")
    n_ops = sum(len(o["ops"]) for o in outputs.values())
    print(f"wrote {OUT_PATH}")
    print(f"outputs={len(outputs)}  sources={len(t.sources)}  remaps={len(t.remaps)}  ops={n_ops}")
    sha = hashlib.sha256(open(OUT_PATH, "rb").read()).hexdigest()[:16]
    print(f"recipe sha256[:16]={sha}")


if __name__ == "__main__":
    main()
