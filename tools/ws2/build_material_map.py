#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# T1a (spec docs/superpowers/specs/2026-07-08-asset-material-parity-spec.md
# section 4-T1a, mechanism 1.2, enabler 3, gate 6-G1, 8.5): build the
# OFFLINE material -> palette-row map the browser resolver needs so that
# mat_type==0 items (inorganics: metal/stone/gem/soil) render in their real
# material color via the native palette swap, plus best-effort plant-wood and
# creature-generic (bone/shell/leather...) colors.
#
# THE MECHANISM (spec 1.2): native v50 draws each sprite in the 18-color
# "default palette" (palettes.png row 0) and, at draw time, remaps every pixel
# whose RGB exactly equals default-palette entry k to palettes.png[row][k],
# where `row` is the PALETTE_COLOR row whose NAME matches the material's
# STATE_COLOR:ALL_SOLID token. This generator emits that palette table + the
# per-material row index; the client does the pixel remap (T1c). We emit ONLY
# palette-row indices here -- sprite cells ({sheet,col,row}) live in
# item_map.json and are joined by the client via the inorganic `id`.
#
# THE INDEX RULE (spec 3, VERIFIED 265/265 vs live world memory): the
# df mat_index for mat_type==0 == position of [INORGANIC:<TOKEN>] in the
# concatenation of the six vanilla inorganic_*.txt files in ALPHABETICAL
# FILENAME order. We hard-fail (SystemExit) if the parsed count != 265 or if
# any of five verified index pins move.
#
# TEMPLATE INHERITANCE (spec 8.5, REQUIRED): a material without its own
# STATE_COLOR inherits its [USE_MATERIAL_TEMPLATE:<TPL>] template's STATE_COLOR.
# An own STATE_COLOR overrides the template's. NOTE (this session, VERIFIED):
# 0 of 265 vanilla inorganics actually rely on inheritance -- every one carries
# its own STATE_COLOR -- but the mechanism is implemented and IS exercised by
# plant materials and creature_generic templates, and is required so modded /
# future raws that omit STATE_COLOR resolve correctly.
#
# Run (pre-installed venv, PIL + stdlib):
#   python tools/ws2/build_material_map.py
#
# Reads (READ-ONLY, never writes to F:):
#   vanilla_materials/objects/inorganic_metal.txt, inorganic_other.txt,
#     inorganic_stone_gem.txt, inorganic_stone_layer.txt,
#     inorganic_stone_mineral.txt, inorganic_stone_soil.txt
#   vanilla_materials/objects/material_template_default.txt
#   vanilla_descriptors_graphics/graphics/palette_default.txt
#   vanilla_descriptors_graphics/graphics/images/palettes.png
#   vanilla_plants/objects/plant_*.txt
# Writes:
#   web/material_map.json

import json
import os
import re
import sys

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

try:
    from PIL import Image
except Exception as e:  # pragma: no cover
    sys.exit("PIL required (install Pillow): %s" % e)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DF_ROOT = dfroot.df_root_for(__file__, sub="data/vanilla",
                          purpose="reads Dwarf Fortress's own raws as the ground truth")
MAT_DIR = os.path.join(DF_ROOT, "vanilla_materials", "objects")
DESC_GFX = os.path.join(DF_ROOT, "vanilla_descriptors_graphics", "graphics")
PLANT_DIR = os.path.join(DF_ROOT, "vanilla_plants", "objects")
OUT_PATH = os.path.join(REPO, "web", "material_map.json")

# Alphabetical filename order -- THIS ORDER IS THE mat_index CONTRACT (spec 3).
INORGANIC_FILES = [
    "inorganic_metal.txt",         # 26
    "inorganic_other.txt",         # 8
    "inorganic_stone_gem.txt",     # 127
    "inorganic_stone_layer.txt",   # 25
    "inorganic_stone_mineral.txt", # 58
    "inorganic_stone_soil.txt",    # 21
]
EXPECT_COUNT = 265
# (index, token) pins VERIFIED against live world memory (spec 3 / 8.5).
INDEX_PINS = [(0, "IRON"), (1, "GOLD"), (97, "GREEN TOURMALINE"),
              (233, "MICROCLINE"), (242, "RAW_ADAMANTINE")]

# STATE_COLOR state-key preference for the solid-item palette swap.
SOLID_STATE_PREF = ["ALL_SOLID", "ALL", "SOLID"]

# creature-generic material templates we surface a row for (spec 4-T1a).
CREATURE_GENERIC_TEMPLATES = {
    "BONE": "BONE_TEMPLATE",
    "SHELL": "SHELL_TEMPLATE",
    "LEATHER": "LEATHER_TEMPLATE",
    "HORN": "HORN_TEMPLATE",
    "HOOF": "HOOF_TEMPLATE",
    "CHITIN": "CHITIN_TEMPLATE",
    "PEARL": "PEARL_TEMPLATE",
    "TOOTH": "TOOTH_TEMPLATE",
    "SILK": "SILK_TEMPLATE",
    "WAX": "WAX_TEMPLATE",
    "SCALE": "SCALE_TEMPLATE",
    "FEATHER": "FEATHER_TEMPLATE",
    "HAIR": "HAIR_TEMPLATE",
    "NAIL": "NAIL_TEMPLATE",
    "SKIN": "SKIN_TEMPLATE",
    "SOAP": "SOAP_TEMPLATE",
    "TALLOW": "TALLOW_TEMPLATE",
}

# df builtin material ids (mat_type) for the three vanilla glasses. Builtin
# materials are hardcoded in the DF binary (NOT in raws), so these STATE_COLORs
# are best-effort by name; see VERIFIED/NOT-VERIFIED split in the closeout.
BUILTIN_GLASS = {
    "3": ("GLASS_GREEN", "GREEN"),
    "4": ("GLASS_CLEAR", "CLEAR"),
    "5": ("GLASS_CRYSTAL", "CLEAR"),
}


def read(path):
    with open(path, encoding="latin-1") as fh:
        return fh.read()


# --- palette -----------------------------------------------------------------
def load_palette():
    txt = read(os.path.join(DESC_GFX, "palette_default.txt"))
    byname = {}
    for m in re.finditer(r"\[PALETTE_COLOR:([^:]+):(\d+)\]", txt):
        byname[m.group(1)] = int(m.group(2))
    img = Image.open(os.path.join(DESC_GFX, "images", "palettes.png")).convert("RGB")
    w, h = img.size
    if w != 18 or h != 137:
        sys.exit("palettes.png expected 18x137, got %dx%d" % (w, h))
    rows = [[list(img.getpixel((k, y))) for k in range(18)] for y in range(137)]
    return byname, rows


# --- material templates ------------------------------------------------------
def parse_templates():
    """{TEMPLATE_TOKEN: {STATE_KEY: COLOR_TOKEN}} for STATE_COLOR only."""
    txt = read(os.path.join(MAT_DIR, "material_template_default.txt"))
    tpl = {}
    cur = None
    for line in txt.splitlines():
        m = re.search(r"\[MATERIAL_TEMPLATE:([^\]]+)\]", line)
        if m:
            cur = m.group(1)
            tpl[cur] = {}
            continue
        m = re.search(r"\[STATE_COLOR:([^:]+):([^\]]+)\]", line)
        if m and cur is not None:
            tpl[cur][m.group(1)] = m.group(2)
    return tpl


def pick_solid_color(state_colors):
    """state_colors: {STATE_KEY: COLOR_TOKEN} -> preferred solid color or None."""
    for key in SOLID_STATE_PREF:
        if key in state_colors:
            return state_colors[key]
    return None


def resolve_color(own_states, template, templates):
    """Own STATE_COLOR overrides template's. Returns COLOR_TOKEN or None."""
    c = pick_solid_color(own_states)
    if c is not None:
        return c
    if template and template in templates:
        return pick_solid_color(templates[template])
    return None


def color_to_row(color_token, byname):
    if color_token is None:
        return None
    return byname.get(color_token)  # None if the token has no palette row


# --- inorganics --------------------------------------------------------------
def split_blocks(txt):
    """Yield (token, block_text) for each [INORGANIC:TOKEN] block, in order."""
    parts = re.split(r"(?=^\[INORGANIC:)", txt, flags=re.M)
    for p in parts:
        m = re.match(r"\[INORGANIC:([^\]]+)\]", p)
        if m:
            yield m.group(1), p


def parse_inorganics(templates, byname):
    entries = []
    for fn in INORGANIC_FILES:
        txt = read(os.path.join(MAT_DIR, fn))
        for token, block in split_blocks(txt):
            own = {}
            for m in re.finditer(r"\[STATE_COLOR:([^:]+):([^\]]+)\]", block):
                own[m.group(1)] = m.group(2)
            tpl_m = re.search(r"\[USE_MATERIAL_TEMPLATE:([^\]]+)\]", block)
            template = tpl_m.group(1) if tpl_m else None
            color = resolve_color(own, template, templates)
            row = color_to_row(color, byname)

            is_metal = ("[IS_METAL]" in block) or (fn == "inorganic_metal.txt")
            is_gem = ("[IS_GEM:" in block or "[IS_GEM]" in block
                      or fn == "inorganic_stone_gem.txt")
            is_soil = ("[SOIL]" in block) or (fn == "inorganic_stone_soil.txt")
            if is_metal:
                family = "METAL"
            elif is_gem:
                family = "GEM"
            elif is_soil:
                family = "SOIL"
            else:
                family = "STONE"

            val_m = re.search(r"\[MATERIAL_VALUE:(\d+)\]", block)
            value = int(val_m.group(1)) if val_m else 1

            entries.append({
                "id": token,
                "row": row,
                "family": family,
                "value": value,
                "gem": is_gem,
            })
    return entries


# --- plants (best-effort) ----------------------------------------------------
def parse_plants(templates, byname):
    """Return ({PLANT_TOKEN: {LOCAL_MAT_NAME: row}}, [PLANT_TOKEN in raw order])."""
    out = {}
    plant_ids = []
    for fn in sorted(os.listdir(PLANT_DIR)):
        if not fn.startswith("plant_") or not fn.endswith(".txt"):
            continue
        txt = read(os.path.join(PLANT_DIR, fn))
        # split by plant
        for pm in re.finditer(
                r"^\[PLANT:([^\]]+)\](.*?)(?=^\[PLANT:|\Z)", txt, re.M | re.S):
            ptok = pm.group(1)
            plant_ids.append(ptok)
            body = pm.group(2)
            mats = {}
            # a material block starts at [USE_MATERIAL_TEMPLATE:LOCAL:TPL] and
            # runs until the next USE_MATERIAL_TEMPLATE / non-indented tag / EOF.
            um = list(re.finditer(
                r"\[USE_MATERIAL_TEMPLATE:([^:\]]+):([^\]]+)\]", body))
            for i, m in enumerate(um):
                local, tpl = m.group(1), m.group(2)
                start = m.end()
                end = um[i + 1].start() if i + 1 < len(um) else len(body)
                seg = body[start:end]
                own = {}
                for sc in re.finditer(r"\[STATE_COLOR:([^:]+):([^\]]+)\]", seg):
                    own[sc.group(1)] = sc.group(2)
                color = resolve_color(own, tpl, templates)
                row = color_to_row(color, byname)
                if row is not None:
                    mats[local] = row
            if mats:
                out[ptok] = mats
    return out, plant_ids


# --- creature generic --------------------------------------------------------
def parse_creature_generic(templates, byname):
    out = {}
    for key, tpl in CREATURE_GENERIC_TEMPLATES.items():
        color = pick_solid_color(templates.get(tpl, {}))
        row = color_to_row(color, byname)
        if row is not None:
            out[key] = row
    return out


def parse_shape_tokens():
    """T2 client join: world.raws.descriptors.shapes order == [SHAPE:*] line order of
    vanilla_descriptors/objects/descriptor_shape_*.txt in alphabetical filename order
    (VERIFIED 2026-07-08 vs live memory: 43/43 ids at identical indices, exact list match --
    same reproducibility rule as inorganics). The wire's per-gem `shape` i16 indexes this
    list; the client joins shape_tokens[shape] -> item_map.gem_shapes[token]."""
    ddir = os.path.join(DF_ROOT, "vanilla_descriptors", "objects")
    toks = []
    for fname in sorted(os.listdir(ddir)):
        if not (fname.startswith("descriptor_shape") and fname.endswith(".txt")):
            continue
        for ln in open(os.path.join(ddir, fname), encoding="latin-1"):
            m = re.match(r"\[SHAPE:([A-Z0-9_]+)\]", ln.strip())
            if m:
                toks.append(m.group(1))
    return toks


SHAPE_PINS = [(0, "STAR"), (1, "CRESCENT"), (10, "CLOUD"),
              (13, "OVAL_CABOCHON"), (42, "LONG_DIE_8")]


def main():
    byname, rows = load_palette()
    templates = parse_templates()

    inorganic = parse_inorganics(templates, byname)

    # --- HARD ASSERTS (spec 3) -------------------------------------------
    if len(inorganic) != EXPECT_COUNT:
        sys.exit("FATAL: parsed %d inorganics, expected %d"
                 % (len(inorganic), EXPECT_COUNT))
    for idx, tok in INDEX_PINS:
        got = inorganic[idx]["id"]
        if got != tok:
            sys.exit("FATAL: index pin %d expected %r got %r" % (idx, tok, got))
    # template mechanism must resolve the 3 inorganic templates to a real row
    for tpl in ("STONE_TEMPLATE", "METAL_TEMPLATE", "SOIL_TEMPLATE"):
        c = pick_solid_color(templates.get(tpl, {}))
        if color_to_row(c, byname) is None:
            sys.exit("FATAL: template %s solid color %r has no palette row"
                     % (tpl, c))

    shape_tokens = parse_shape_tokens()
    if len(shape_tokens) != 43:
        sys.exit("FATAL: parsed %d shape tokens, expected 43 (vanilla)" % len(shape_tokens))
    for idx, tok in SHAPE_PINS:
        if shape_tokens[idx] != tok:
            sys.exit("FATAL: shape pin %d expected %r got %r" % (idx, tok, shape_tokens[idx]))

    plant, plant_ids = parse_plants(templates, byname)
    creature_generic = parse_creature_generic(templates, byname)

    builtin = {}
    for bid, (name, color) in BUILTIN_GLASS.items():
        builtin[bid] = {"row": color_to_row(color, byname),
                        "family": "GLASS", "material": name}

    out = {
        "_v": 1,
        "palette": {"rows": rows, "byname": byname},
        "default_row": rows[0],
        "inorganic": inorganic,
        "builtin": builtin,
        "plant": plant,
        "plant_ids": plant_ids,
        "creature_generic": creature_generic,
        # additive (T2 client join): wire gem `shape` i16 -> SHAPE token -> item_map.gem_shapes
        "shape_tokens": shape_tokens,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=True)
        fh.write("\n")

    # summary to stderr/stdout
    nrows = sum(1 for e in inorganic if e["row"] is not None)
    fams = {}
    for e in inorganic:
        fams[e["family"]] = fams.get(e["family"], 0) + 1
    print("OK wrote %s" % OUT_PATH)
    print("  inorganic: %d (rows resolved: %d)" % (len(inorganic), nrows))
    print("  families: %s" % fams)
    print("  plant tokens: %d (ids: %d), creature_generic: %d, builtin: %d"
          % (len(plant), len(plant_ids), len(creature_generic), len(builtin)))
    print("  index pins OK: %s"
          % ", ".join("%s@%d" % (t, i) for i, t in INDEX_PINS))
    print("  shape tokens: %d (pins OK: %s)"
          % (len(shape_tokens), ", ".join("%s@%d" % (t, i) for i, t in SHAPE_PINS)))


if __name__ == "__main__":
    main()
