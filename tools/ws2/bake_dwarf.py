#!/usr/bin/env python
"""
bake_dwarf.py  --  WS2 premium-sprite renderer, dwarf-baking prototype.

WHAT THIS SOLVES
----------------
A dwarf in premium DF is NOT a single sprite cell. It is composited at runtime
from ~10 stacked 32x32 body-part cells (each cell holds one limb drawn in its
correct position within the 32x32 frame) plus hair + beard, and every layer is
recolored through a palette-remap (LS_PALETTE / USE_PALETTE). See
graphics_creatures_dwarf.txt  [CREATURE_GRAPHICS:DWARF][LAYER_SET:DEFAULT].

This script reproduces the *DEFAULT adult* composite offline and flattens it to a
single 32x32 RGBA PNG we can blit at a unit's tile, replacing the yellow dot.

WHAT WE COMPOSITE (the "clean default" dwarf -- no syndrome, no worn items)
--------------------------------------------------------------------------
From dwarf_body.png (TILE_PAGE DWARF_BODY, 288x224 = 9 cols x 7 rows):
  row 0 = faces/heads (cols 0-7),  col 8 row 0 = SHADOW
  row 1 = MALE   body-part cells   (row 2 = FEMALE equivalents)
Body-part cells used (col,row), MALE, in DF file/paint order (bottom->top):
  SHADOW (8,0), right shoulder (3,1), right hand (2,1), right leg (1,1),
  right foot (0,1), left leg (7,1), left foot (8,1), torso/BODY (4,1),
  left shoulder (5,1), FACE_M1 head (4,0), left hand (6,1).
Hair + beard from dwarf_hair.png (DWARF_HAIR, 192x608 = 6 cols x 19 rows):
  hair  "short combed"  = (2,4)
  beard "mid combed"    = (4,5)

PALETTE MODEL (verified against the PNGs)
-----------------------------------------
Each *_palettes.png is (Ncolorslots wide) x (Npaletterows tall). Row 0 is the
"key" palette -- the exact colors the source art (_body.png / _hair.png) is
painted in. USE_PALETTE:GROUP:N remaps every pixel whose RGB equals key-row[c]
to targetrow-N[c] (alpha preserved). For BODY, row 2 (LMID, the standard mid
skin tone) is byte-identical to row 0, so the base art already IS a valid dwarf
skin -- the default composite needs no body remap. Skin variants (dark/light)
are a pure row swap. Hair/beard are remapped to a brown (HAIR palette row 4/5),
since the key hair row is a stylized reddish that reads oddly for a "generic".

WHAT WE APPROXIMATE / OMIT (documented, not hidden)
---------------------------------------------------
* CLOTHING is skipped. Every clothing layer is gated on [CONDITION_ITEM_WORN]
  (what the unit actually wears) and colored via [USE_STANDARD_PALETTE_FROM_ITEM]
  (the item's material color) -- neither is knowable offline. Result is an
  unclothed-but-bearded dwarf, which still reads unmistakably as "a dwarf".
  (A profession tunic could be faked by tinting, but that is per-unit and belongs
  in a live compositor, not a static bake.)
* One caste (MALE), one skin tone (LMID/default), one hair+beard style/color.
  Real DF varies these per unit. We bake a small fixed set of variants instead.
* SYNDROME variants (zombie/ghost/vampire/...) omitted -- gated on CONDITION_SYN_CLASS.
* Shadow layer IS included (grounds the sprite; authentic to DF).

OUTPUT
------
  sprites/dwarf.png         MALE, default skin, brown hair+beard   (the generic)
  sprites/dwarf_female.png  FEMALE, default skin, hair, no beard
  sprites/dwarf_dark.png    MALE, dark skin (BODY palette 4), dark beard
Run:  <venv>/python.exe bake_dwarf.py
Reads DF install READ-ONLY. Writes only under tools/ws2/sprites/.
"""

import os
from PIL import Image

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

DF = dfroot.df_root_for(__file__, sub="data/vanilla/vanilla_creatures_graphics/graphics/images/dwarf",
                          purpose="reads sprite sheets out of Dwarf Fortress's own art")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sprites")
CELL = 32

BODY_PNG      = os.path.join(DF, "dwarf_body.png")
BODY_PAL_PNG  = os.path.join(DF, "dwarf_body_palettes.png")
HAIR_PNG      = os.path.join(DF, "dwarf_hair.png")
HAIR_PAL_PNG  = os.path.join(DF, "dwarf_hair_palettes.png")


def load_palette(path):
    """Return list-of-rows; each row is a list of (r,g,b) tuples (alpha dropped)."""
    im = Image.open(path).convert("RGBA")
    rows = []
    for y in range(im.height):
        rows.append([im.getpixel((x, y))[:3] for x in range(im.width)])
    return rows


def cell(img, col, row):
    return img.crop((col * CELL, row * CELL, col * CELL + CELL, row * CELL + CELL)).convert("RGBA")


def remap(cellimg, pal, src_row, dst_row):
    """Palette-remap a cell: key-row[c] RGB -> dst-row[c] RGB, alpha preserved."""
    if src_row == dst_row:
        return cellimg
    lut = {pal[src_row][c]: pal[dst_row][c] for c in range(len(pal[src_row]))}
    px = cellimg.load()
    for y in range(cellimg.height):
        for x in range(cellimg.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            nc = lut.get((r, g, b))
            if nc:
                px[x, y] = (nc[0], nc[1], nc[2], a)
    return cellimg


# (col,row) body-part cells in DF paint order (bottom -> top). Shadow first.
# Skin cells are remapped BODY key-row(0) -> body_pal. row 2 == row 0 (identity).
# row "sex" resolves to the caste row (1=MALE / 2=FEMALE). Module-level so
# tools/ws2/emit_sprite_recipe.py (W11 install-time bake) reuses the exact table.
BODY_PARTS = [
    ("shadow",         8, 0,     False),  # shadow: drawn as-is (no USE_PALETTE)
    ("right_shoulder", 3, "sex", True),
    ("right_hand",     2, "sex", True),
    ("right_leg",      1, "sex", True),
    ("right_foot",     0, "sex", True),
    ("left_leg",       7, "sex", True),
    ("left_foot",      8, "sex", True),
    ("torso",          4, "sex", True),
    ("left_shoulder",  5, "sex", True),
    ("face_M1",        4, 0,     True),   # head/face lives in row 0
    ("left_hand",      6, "sex", True),
]
HAIR_CELL = (2, 4)    # dwarf_hair.png "short combed"
BEARD_CELL = (4, 5)   # dwarf_hair.png "mid combed"

# output name -> composite parameters (shared with emit_sprite_recipe.py).
VARIANTS = {
    "dwarf.png":        dict(caste="MALE",   body_pal=2, hair_pal=4, beard=True),
    "dwarf_female.png": dict(caste="FEMALE", body_pal=2, hair_pal=6, beard=False),
    "dwarf_dark.png":   dict(caste="MALE",   body_pal=4, hair_pal=5, beard=True),
}


def composite(body, bpal, hair, hpal, *, caste="MALE", body_pal=2, hair_pal=4, beard=True):
    """Stack the body-part cells + hair + beard into one 32x32 RGBA image."""
    row = 1 if caste == "MALE" else 2   # dwarf_body.png row 1=MALE, row 2=FEMALE
    canvas = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))

    parts = [(name, c, row if r == "sex" else r, body_pal if remapped else None)
             for name, c, r, remapped in BODY_PARTS]
    for _name, c, r, pal in parts:
        cimg = cell(body, c, r)
        if pal is not None:
            cimg = remap(cimg, bpal, 0, pal)
        canvas = Image.alpha_composite(canvas, cimg)

    # hair (short combed 2:4) then beard (mid combed 4:5), remapped to brown.
    hairimg = remap(cell(hair, *HAIR_CELL), hpal, 0, hair_pal)
    canvas = Image.alpha_composite(canvas, hairimg)
    if beard:
        beardimg = remap(cell(hair, *BEARD_CELL), hpal, 0, min(hair_pal + 1, len(hpal) - 1))
        canvas = Image.alpha_composite(canvas, beardimg)
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)
    body = Image.open(BODY_PNG).convert("RGBA")
    hair = Image.open(HAIR_PNG).convert("RGBA")
    bpal = load_palette(BODY_PAL_PNG)   # 11 slots x 13 rows
    hpal = load_palette(HAIR_PAL_PNG)   # 8 slots x 13 rows

    for fname, kw in VARIANTS.items():
        img = composite(body, bpal, hair, hpal, **kw)
        p = os.path.join(OUT, fname)
        img.save(p)
        bbox = img.getbbox()
        opaque = sum(1 for px in img.getdata() if px[3] > 0)
        print(f"wrote {p}  bbox={bbox}  opaque_px={opaque}/{CELL*CELL}")


if __name__ == "__main__":
    main()
