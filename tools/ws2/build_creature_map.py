#!/usr/bin/env python
"""
build_creature_map.py  --  WS2 premium-sprite renderer, creature->sprite map.

Emits sprites/creatures_map.json:  RACE token -> how to draw that unit.

Two tiers (see graphics_creatures_*.txt), NOT mutually exclusive (WE-6):
  FLAT   a usable single-cell (or LARGE_IMAGE multi-cell) sprite, sourced from
         whichever of [DEFAULT:...], [ANIMATED:...], [VERMIN:...] appears in the
         block (DF creature raws use exactly one of these three token names for
         the map/tile sprite depending on the creature's graphics class -- vermin
         insects/small critters use VERMIN, most civ-viewed wildlife uses DEFAULT,
         and -- importantly -- LAYER_SET races frequently carry an ADDITIONAL
         [ANIMATED:...] cell as their flat/pre-composite sprite, e.g. every
         animal-person block: `[ANIMATED:...] [CORPSE:...] [LAYER_SET:DEFAULT]
         [USE_LAYER_SET_TEMPLATE:ANIMAL_PEOPLE] ...`).
         -> {"sheet":"creatures_domestic.png","col":0,"row":6}
         LARGE_IMAGE multi-cell creatures store the top-left cell + cell span:
         -> {"sheet":"...","col":14,"row":25,"w":3,"h":1}   (w,h in 32px cells)
  LAYERED any race whose block genuinely contains [LAYER_SET:...] or
         USE_LAYER_SET_TEMPLATE (runtime layer+palette composite -- the DF-side
         per-unit texture the WE-2 exporter serves at `/unit-sprite/<hash>.png`,
         race-agnostic). -> adds "layered":true to the record ABOVE any flat
         data found (tier ordering, client side: per-unit composite (ah hash) >
         own flat cell (this record's sheet/col/row, if present) > generic baked
         PNG (civ humanoids: dwarf.png family; everything else with no flat cell
         of its own, e.g. donkey/horse/ogre/troll/elephant: also dwarf.png,
         per spec WE-6 "else generic") > yellow dot).
         civ humanoids (DWARF/ELF/GOBLIN/HUMAN/KOBOLD) also get an explicit
         "baked":"dwarf.png" (only DWARF has its own bake today; the other four
         point at dwarf.png as a phase-1 placeholder -- swap in per-race bakes
         later). Everything else layered omits "baked" and relies on the
         client's `rec.baked || "dwarf.png"` default.
  A race can be BOTH: e.g. AARDVARK_MAN is {"layered":true,"sheet":...} -- its
  own animal-person ANIMATED cell is a much better fallback than the generic
  dwarf silhouette while its composite hash is loading.

  Defensive fallback (spec WE-6 item 1, "else point at the closest generic ...
  species base-animal cell for animal-people"): a layered race whose OWN block
  has no flat cell at all, and whose name is a "<BASE> MAN"/"<BASE>_MAN" animal-
  person variant, borrows the base species' flat cell (if the base race has
  one) as its sheet/col/row. This still supplies spans for extinct animal-people
  that do not carry a top-level ANIMATED map cell before the compositor replaces
  that borrowed fallback with generated body-part art.

PAGE resolution: tile_page_creatures.txt maps [TILE_PAGE:NAME] -> [FILE:images/x.png];
we store the png BASENAME as "sheet". All creature pages live in that one file.

Per-caste: races whose art is defined only via [CREATURE_CASTE_GRAPHICS:RACE:CASTE]
(e.g. poultry) get their first caste's flat cell as the race-level sprite, and every
caste is also recorded under "castes":{CASTE:{...}} so the client may refine by caste.

Reads DF install READ-ONLY. Writes generated outputs under tools/ws2/sprites/
and mirrors the client-loaded artifacts to web/: creatures_map.json plus the
animal_people_flat.png composite atlas.
"""

import json
import os
import re
import glob
import shutil

from PIL import Image

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

VANILLA = dfroot.df_root_for(__file__, sub="data/vanilla",
                          purpose="reads Dwarf Fortress's own raws as the ground truth")
# Scan EVERY vanilla_creatures*_graphics package, not just the base one. Vanilla ships the
# base creatures art in `vanilla_creatures_graphics` AND the extinct/prehistoric roster
# (all the CRETACEOUS_*/JURASSIC_*/... dinosaurs + their animal-people) in the SEPARATE
# `vanilla_creatures_extinct_graphics` package. The base dinos are plain NON-layered
# graphics-set creatures (their art lives in images/creatures_cretaceous.png etc.), so
# without ingesting the extinct package they had no tier-3 flat cell -> yellow dot in both
# renderers (their _MAN variants render fine via the race-agnostic runtime LAYER_SET
# composite regardless of this map). The glob is deliberately generic so any FUTURE
# `vanilla_creatures_<x>_graphics` pack is picked up for free. Every such package has the
# identical layout: graphics/tile_page_creatures.txt + graphics/graphics_creatures_*.txt +
# graphics/images/. The sheet basenames stored here must be reachable through the client's
# /sprites/img/<name> route (server searches vanilla_creatures_graphics/graphics/images);
# the deploy step copies the extinct top-level PNGs into that served dir (they have unique
# basenames -- no collision) so no C++/route change is needed.
GDIRS = sorted(glob.glob(os.path.join(VANILLA, "vanilla_creatures*_graphics", "graphics")))
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SPRITES_DIR = os.path.join(HERE, "sprites")
OUT = os.path.join(SPRITES_DIR, "creatures_map.json")
WEB_OUT = os.path.join(REPO, "web", "creatures_map.json")
COMPOSITE_ATLAS = "animal_people_flat.png"
COMPOSITE_OUT = os.path.join(SPRITES_DIR, COMPOSITE_ATLAS)
WEB_COMPOSITE_OUT = os.path.join(REPO, "web", COMPOSITE_ATLAS)
CELL = 32
ATLAS_COLS = 16

# civ humanoids are layered composites AND get an explicit generic-fallback bake
# (none of them carry an in-block flat cell -- verified: DWARF/ELF/GOBLIN/HUMAN/
# KOBOLD are all in the "genuinely layered, no in-block flat" set).
CIV_BAKED = {
    "DWARF":  "dwarf.png",
    "ELF":    "dwarf.png",   # placeholder until elf.png is baked
    "GOBLIN": "dwarf.png",   # placeholder
    "HUMAN":  "dwarf.png",   # placeholder
    "KOBOLD": "dwarf.png",   # placeholder
}

# flat-cell token names, in the order tried per block (see docstring above).
FLAT_TAGS = ("DEFAULT", "ANIMATED", "VERMIN")

# Vanilla graphics_creatures_small.txt maps WORM_KNUCKLE to row 57, but that cell
# is visibly a purple non-worm critter. Native draws the live knuckle worm with
# the same small worm glyph family as WORM, and row 111 is the species-correct
# worm cell. Keep this scoped to live flat sprites; corpse/remains item art is a
# separate resolver path and intentionally follows the raw REMAINS binding.
LIVE_CELL_FIXUPS = {
    "WORM_KNUCKLE": {
        "from": {"sheet": "creatures_small.png", "col": 0, "row": 57},
        "to": {"sheet": "creatures_small.png", "col": 0, "row": 111},
    },
}

# only parse flat creature definition files; skip statues/portraits/corpses/templates.
SKIP = ("statues", "portrait", "corpse", "layer_set_template", "bodyparts", "interactions")

# animal-person name suffix, in the two spellings the raws actually use
# ("AARDVARK_MAN" underscore-joined; "PANDA MAN"/"RED PANDA MAN" space-joined).
_MAN_SUFFIX = re.compile(r"[ _]MAN$")


def load_pages():
    """[TILE_PAGE:NAME] -> the path the /sprites/img route can serve, from tile_page_creatures.txt.

    The value is relative to images/: a top-level sheet stores its bare basename
    ("dwarf.png"); a sheet ONE subdirectory deep stores "<subdir>/<file>.png" (e.g.
    "ogres/ogres.png"). As of the srvroutes deploy the /sprites/img/<name> route serves ONE
    subdirectory level (path-traversal-safe), so a one-level-nested sheet is now fully servable
    and IS emitted as a flat cell. Also returns the set of page names still UNSERVABLE (>1 level
    deep) -- callers must not emit a flat cell for those (they'd 404 -> fallback dot).
    """
    pages = {}
    page_files = {}
    unservable = set()
    # merge the tile_page_creatures.txt from every scanned package. TILE_PAGE names are
    # namespaced per pack (e.g. CREATURES_CRETACEOUS only in the extinct pack), so there are
    # no cross-package name clashes -- a plain dict merge is correct.
    for gdir in GDIRS:
        tp = os.path.join(gdir, "tile_page_creatures.txt")
        if not os.path.isfile(tp):
            continue
        txt = open(tp, encoding="latin-1").read()
        name = None
        for m in re.finditer(r"\[(TILE_PAGE|FILE):([^\]]+)\]", txt):
            kind, val = m.group(1), m.group(2)
            if kind == "TILE_PAGE":
                name = val.strip()
            elif kind == "FILE" and name:
                rel = val.strip().replace("\\", "/")
                # rel is "images/<...>"; the tail past that prefix is what the route serves.
                body = rel[len("images/"):] if rel.startswith("images/") else rel
                image_path = os.path.join(os.path.dirname(tp), rel.replace("/", os.sep))
                depth = body.count("/")
                if depth <= 1:
                    pages[name] = body                 # "dwarf.png" or "ogres/ogres.png" (both servable)
                    page_files[name] = image_path
                else:
                    pages[name] = os.path.basename(rel)  # >1 level: unservable, keep only for reference
                    page_files[name] = image_path
                    unservable.add(name)
                name = None
    return pages, unservable, page_files


def parse_cell_tag(inner, pages, tag):
    """First usable cell for one specific tag name in a block body -> sprite dict or None."""
    m = re.search(r"\[" + tag + r":([^\]]+)\]", inner)
    if not m:
        return None
    parts = m.group(1).split(":")
    page = parts[0]
    sheet = pages.get(page)
    if not sheet:
        return None
    try:
        if len(parts) >= 6 and parts[1] == "LARGE_IMAGE":
            c1, r1, c2, r2 = int(parts[2]), int(parts[3]), int(parts[4]), int(parts[5])
            return {"sheet": sheet, "col": min(c1, c2), "row": min(r1, r2),
                    "w": abs(c2 - c1) + 1, "h": abs(r2 - r1) + 1}
        col, row = int(parts[1]), int(parts[2])
        return {"sheet": sheet, "col": col, "row": row}
    except (ValueError, IndexError):
        return None


def parse_flat(inner, pages):
    """First usable flat cell in a block body -> sprite dict or None.

    Tries DEFAULT, then ANIMATED, then VERMIN (see module docstring) -- the
    first tag name that both appears in the block AND resolves to a known
    TILE_PAGE wins.
    """
    for tag in FLAT_TAGS:
        cell = parse_cell_tag(inner, pages, tag)
        if cell:
            return cell
    return None


def apply_live_cell_fixup(race, sprite, fixups=None):
    fixups = LIVE_CELL_FIXUPS if fixups is None else fixups
    fixup = fixups.get(race)
    if not fixup or not sprite:
        return sprite
    expected = fixup["from"]
    for key, value in expected.items():
        if sprite.get(key) != value:
            return sprite
    fixed = dict(sprite)
    fixed.update(fixup["to"])
    return fixed


# B47: the raws carry EXPLICIT per-creature corpse art -- `[CORPSE:PAGE:col:row:AS_IS]`
# (651 bindings across the vanilla creature graphics files) plus a handful of
# `[SKELETON:...]` cells. The original generator only lifted the LIVE cell
# (DEFAULT/ANIMATED/VERMIN), so a corpse ITEM (CORPSE/CORPSEPIECE/REMAINS via the item
# identity wire tail) either rendered the LIVING creature sprite (wrong-art) or, for
# layered races with no flat cell (DWARF...), the _missing placeholder box (the
# "skeleton missing in a pile"). Lift both cells so the client can prefer real corpse
# art for corpse-class items.
def parse_corpse(inner, pages):
    return parse_cell_tag(inner, pages, "CORPSE")


def parse_skeleton(inner, pages):
    return parse_cell_tag(inner, pages, "SKELETON")


# Some creatures declare their dead-body art as [REMAINS:PAGE:col:row] instead of
# [CORPSE:...] -- REMAINS is the token vanilla uses for small/vermin-class creatures whose
# death drops a "remains" item rather than a full corpse (108 CREATURES_SMALL bindings:
# TERMITE/SLUG/SKINK/FISH_CLOWNFISH..., plus a handful of extinct small critters). The
# original generator only lifted [CORPSE:...], so a REMAINS-only creature's corpse/remains
# item had no real cell and rendered wrong-art / the missing box. Treat REMAINS as a corpse
# cell of last resort (a block never carries both a CORPSE and a REMAINS for the same body).
def parse_remains(inner, pages):
    return parse_cell_tag(inner, pages, "REMAINS")


def is_layered(inner):
    """True if the block genuinely composites at runtime (LAYER_SET / template)."""
    return bool(re.search(r"\[LAYER_SET:", inner) or "USE_LAYER_SET_TEMPLATE" in inner)


def parse_layerset_body(inner, pages, unservable):
    """Flat fallback for a LAYER_SET race with NO top-level flat tag: the static
    BODY layer of its LAYER_SET:DEFAULT (or ANIMATED) block.

    Many large creatures (elephant, horse, donkey, mule, camels, muskox, water
    buffalo, yak, unicorn, ogre, ...) declare no [DEFAULT/ANIMATED/VERMIN:...]
    flat tag -- their map sprite lives inside [LAYER_SET:DEFAULT] as a single
    static [LAYER:BODY:PAGE:...] cell (often LARGE_IMAGE, e.g. the 3x2 elephant).
    parse_flat() only sees top-level tags, so these races were emitted as bare
    {"layered":true} with no flat cell and fell through the client's tier chain
    to the generic dwarf.png silhouette whenever no per-unit composite existed --
    exactly the "wild (never-drawn) elephant shows a dwarf" bug (B19). A tame /
    on-camera unit gets DF's runtime composite (tier 1); a wild unit DF has never
    drawn has no texpos composite, so it needs this species flat cell (tier 3).

    Palette-composited sets are SKIPPED (USE_PALETTE): the civ humanoids
    (DWARF/ELF/GOBLIN/HUMAN/KOBOLD) build their body from a key-palette that must
    be remapped to a skin tone at runtime, so the raw body cell is not a usable
    standalone sprite -- they correctly keep their baked-PNG fallback. The 12
    affected creatures here all use plain static art (no USE_PALETTE), and the
    extracted cell is the SAME image DF composites (minus optional hauled
    saddlebags), so the flat fallback matches the composite pixel-for-pixel.
    """
    for setname in ("DEFAULT", "ANIMATED"):
        m = re.search(r"\[LAYER_SET:" + setname + r"\](.*?)(?=\[LAYER_SET:|\Z)",
                      inner, re.S)
        if not m:
            continue
        seg = m.group(1)
        if "USE_PALETTE" in seg:
            continue  # palette remap needed -> raw body cell is not a valid flat sprite
        bm = re.search(r"\[LAYER:BODY:([^\]]+)\]", seg)
        if not bm:
            continue
        # bm.group(1) is everything AFTER "[LAYER:BODY:", i.e.
        #   PAGE:LARGE_IMAGE:c1:r1:c2:r2   or   PAGE:col:row
        parts = bm.group(1).split(":")
        pagename = parts[0] if parts else None
        if not pagename or pagename in unservable:
            continue  # sheet >1 subdir level deep -> not servable -> keep the baked fallback
        page = pages.get(pagename)
        if not page:
            continue
        try:
            if len(parts) >= 6 and parts[1] == "LARGE_IMAGE":
                c1, r1, c2, r2 = int(parts[2]), int(parts[3]), int(parts[4]), int(parts[5])
                return {"sheet": page, "col": min(c1, c2), "row": min(r1, r2),
                        "w": abs(c2 - c1) + 1, "h": abs(r2 - r1) + 1}
            col, row = int(parts[1]), int(parts[2])
            return {"sheet": page, "col": col, "row": row}
        except (ValueError, IndexError):
            continue
    return None



TEMPLATE_PATH = os.path.join(
    VANILLA, "vanilla_creatures_graphics", "graphics", "graphics_layer_set_template_animal_people.txt")
ANIMAL_BODY_PREFIX = "CREATURES_ANIMAL_PEOPLE"
ANIMAL_ALWAYS_ON = {
    "RIGHT_WING", "LEFT_WING", "TAIL", "BODY", "HEAD",
    "RIGHT_HAND", "LEFT_HAND", "RIGHT_HAND_TALL", "LEFT_HAND_TALL",
    "RIGHT_HAND_WIDE", "LEFT_HAND_WIDE", "RIGHT_FOOT", "LEFT_FOOT",
}
_IMAGE_CACHE = {}
_TEMPLATE_GROUPS = None


def graphics_files():
    raw_files = []
    for gdir in GDIRS:
        raw_files += glob.glob(os.path.join(gdir, "graphics_creatures_*.txt"))
        raw_files += glob.glob(os.path.join(gdir, "graphics_beasts*.txt"))
        raw_files += glob.glob(os.path.join(gdir, "graphics_werebeasts.txt"))
    return [f for f in raw_files
            if not any(s in os.path.basename(f).lower() for s in SKIP)]


def iter_graphics_blocks(files):
    hdr = re.compile(r"\[(CREATURE_GRAPHICS|CREATURE_CASTE_GRAPHICS):([^\]]+)\]")
    for path in files:
        txt = open(path, encoding="latin-1").read()
        marks = list(hdr.finditer(txt))
        for i, m in enumerate(marks):
            kind = m.group(1)
            args = m.group(2).split(":")
            race = args[0]
            end = marks[i + 1].start() if i + 1 < len(marks) else len(txt)
            yield path, kind, args, race, txt[m.end():end]


def tag_parts(inner, tag):
    m = re.search(r"\[" + re.escape(tag) + r":([^\]]+)\]", inner)
    return m.group(1).split(":") if m else None


def parse_cell_ref_parts(parts, pages, page_files):
    if not parts:
        return None
    page = parts[0]
    sheet = pages.get(page)
    image_path = page_files.get(page)
    if not sheet or not image_path:
        return None
    try:
        if len(parts) >= 6 and parts[1] == "LARGE_IMAGE":
            c1, r1, c2, r2 = int(parts[2]), int(parts[3]), int(parts[4]), int(parts[5])
            return {"page": page, "sheet": sheet, "image_path": image_path,
                    "col": min(c1, c2), "row": min(r1, r2),
                    "w": abs(c2 - c1) + 1, "h": abs(r2 - r1) + 1}
        return {"page": page, "sheet": sheet, "image_path": image_path,
                "col": int(parts[1]), "row": int(parts[2]), "w": 1, "h": 1}
    except (ValueError, IndexError):
        return None


def parse_top_flat_ref(inner, pages, page_files):
    for tag in FLAT_TAGS:
        ref = parse_cell_ref_parts(tag_parts(inner, tag), pages, page_files)
        if ref:
            ref["tag"] = tag
            return ref
    return None


def arg_map(inner):
    out = {}
    for m in re.finditer(r"\[(ARG_[A-Z0-9_]+):([^\]]+)\]", inner):
        out[m.group(1)] = m.group(2).split(":")
    return out


def arg_is_yes(args, name):
    val = args.get(name)
    return bool(val and val[0] == "YES")


def arg_offset(args, name):
    val = args.get(name)
    if not val or len(val) < 2:
        return 0, 0
    try:
        return int(val[0]), int(val[1])
    except ValueError:
        return 0, 0


def split_layer_groups(seg):
    marks = list(re.finditer(r"\[LAYER_GROUP\]", seg))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(seg)
        yield seg[m.end():end]


def layer_tags(group):
    tags = list(re.finditer(r"\[LAYER:([^\]]+)\]", group))
    for i, m in enumerate(tags):
        tail_end = tags[i + 1].start() if i + 1 < len(tags) else len(group)
        yield m.group(1).split(":"), group[m.end():tail_end]


def body_page_for_template(args):
    parts = args.get("ARG_BODY_TEXTURE")
    return parts[0] if parts else None


def is_animal_body_page(page):
    return bool(page and (page.startswith(ANIMAL_BODY_PREFIX) or page.endswith("_BODY")))


def template_groups():
    global _TEMPLATE_GROUPS
    if _TEMPLATE_GROUPS is not None:
        return _TEMPLATE_GROUPS
    txt = open(TEMPLATE_PATH, encoding="latin-1").read()
    groups = []
    for group in split_layer_groups(txt):
        pm = re.search(r"\[LG_PERMITTED:([^\]]+)\]", group)
        om = re.search(r"\[LG_OFFSET:([^\]]+)\]", group)
        permitted = pm.group(1) if pm else None
        offset_arg = om.group(1) if om else None
        layers = []
        for parts, tail in layer_tags(group):
            if "CONDITION_" in tail or len(parts) < 2:
                continue
            name, spec = parts[0], parts[1:]
            if name not in ANIMAL_ALWAYS_ON:
                continue
            if not spec or not spec[0].startswith("ARG_") or not spec[0].endswith("_TEXTURE"):
                continue
            layers.append((name, spec[0]))
        if layers:
            groups.append({"permitted": permitted, "offset_arg": offset_arg, "layers": layers})
    _TEMPLATE_GROUPS = groups
    return groups


def animal_template_layers(inner, pages, page_files):
    if "USE_LAYER_SET_TEMPLATE:ANIMAL_PEOPLE" not in inner:
        return None
    args = arg_map(inner)
    body_page = body_page_for_template(args)
    if not is_animal_body_page(body_page):
        return None
    layers = []
    for group in template_groups():
        permitted = group["permitted"]
        if permitted and not arg_is_yes(args, permitted):
            continue
        dx, dy = arg_offset(args, group["offset_arg"] or "")
        for name, texture_arg in group["layers"]:
            ref = parse_cell_ref_parts(args.get(texture_arg), pages, page_files)
            if not ref or not is_animal_body_page(ref["page"]):
                continue
            layers.append({"name": name, "ref": ref, "offset": (dx, dy)})
    if not any(layer["name"] == "BODY" for layer in layers):
        return None
    return {"mechanism": "animal_people_template", "body_page": body_page, "layers": layers}


def own_body_layers(inner, pages, page_files):
    m = re.search(r"\[LAYER_SET:DEFAULT\](.*?)(?=\[LAYER_SET:|\Z)", inner, re.S)
    if not m:
        return None
    layers = []
    for group in split_layer_groups(m.group(1)):
        for parts, tail in layer_tags(group):
            if "CONDITION_" in tail or len(parts) < 4:
                continue
            name, spec = parts[0], parts[1:]
            ref = parse_cell_ref_parts(spec, pages, page_files)
            if not ref or not ref["page"].endswith("_BODY"):
                continue
            layers.append({"name": name, "ref": ref, "offset": (0, 0)})
    if not any(layer["name"] in ("BODY", "TORSO") for layer in layers):
        return None
    return {"mechanism": "own_body_layerset", "body_page": layers[0]["ref"]["page"], "layers": layers}


def composite_source_for_block(inner, pages, page_files):
    src = animal_template_layers(inner, pages, page_files)
    if src:
        return src
    return own_body_layers(inner, pages, page_files)


def load_source_image(ref):
    path = ref["image_path"]
    img = _IMAGE_CACHE.get(path)
    if img is None:
        img = Image.open(path).convert("RGBA")
        _IMAGE_CACHE[path] = img
    x0 = ref["col"] * CELL
    y0 = ref["row"] * CELL
    return img.crop((x0, y0, x0 + ref["w"] * CELL, y0 + ref["h"] * CELL))


def paste_clipped(dst, src, x, y):
    left = max(0, x)
    top = max(0, y)
    right = min(dst.width, x + src.width)
    bottom = min(dst.height, y + src.height)
    if right <= left or bottom <= top:
        return
    crop = src.crop((left - x, top - y, right - x, bottom - y))
    dst.alpha_composite(crop, (left, top))


def render_composite(layers, span, skip_body=False):
    sw, sh = span
    canvas = Image.new("RGBA", (sw * CELL, sh * CELL), (0, 0, 0, 0))
    anchor_x = (0 if sw == 1 else 1) * CELL
    anchor_y = (sh - 1) * CELL
    for layer in layers:
        if skip_body and layer["name"] == "BODY":
            continue
        img = load_source_image(layer["ref"])
        if img.size == canvas.size:
            x, y = 0, 0
        else:
            dx, dy = layer["offset"]
            x, y = anchor_x + dx, anchor_y + dy
        paste_clipped(canvas, img, x, y)
    return canvas


def opaque_pixels(img):
    return sum(1 for px in img.getdata() if px[3] > 0)


def pack_composites(entries):
    x = y = row_h = 0
    for entry in entries:
        sw, sh = entry["span"]
        if sw > ATLAS_COLS:
            raise ValueError("composite wider than atlas row: %s" % entry["race"])
        if x and x + sw > ATLAS_COLS:
            x = 0
            y += row_h
            row_h = 0
        entry["col"] = x
        entry["row"] = y
        x += sw
        row_h = max(row_h, sh)
    height_cells = y + row_h
    atlas = Image.new("RGBA", (ATLAS_COLS * CELL, max(1, height_cells) * CELL), (0, 0, 0, 0))
    for entry in entries:
        atlas.alpha_composite(entry["image"], (entry["col"] * CELL, entry["row"] * CELL))
    return atlas


def cell_copy(rec):
    return {k: rec[k] for k in ("sheet", "col", "row", "w", "h") if k in rec}


def apply_composite_fallbacks(races, composite_sources, mutator=None):
    entries = []
    for race in sorted(composite_sources):
        rec = races.get(race)
        if not rec or not rec.get("sheet"):
            continue
        span = (int(rec.get("w", 1)), int(rec.get("h", 1)))
        if span[0] < 1 or span[1] < 1:
            continue
        src = composite_sources[race]
        layers = list(src["layers"])
        if mutator:
            layers = mutator(race, layers)
        img = render_composite(layers, span)
        if opaque_pixels(img) <= 0:
            continue
        entries.append({"race": race, "span": span, "image": img,
                        "old": cell_copy(rec), "mechanism": src["mechanism"],
                        "body_page": src["body_page"], "layer_count": len(layers),
                        # W11: the concrete (post-mutator) layer refs, so
                        # emit_sprite_recipe.py can record the exact blits.
                        "layers": layers})
    atlas = pack_composites(entries)
    for entry in entries:
        rec = races[entry["race"]]
        for k in ("sheet", "col", "row", "w", "h"):
            rec.pop(k, None)
        rec.update({"sheet": COMPOSITE_ATLAS, "col": entry["col"], "row": entry["row"]})
        sw, sh = entry["span"]
        if sw != 1:
            rec["w"] = sw
        if sh != 1:
            rec["h"] = sh
    return entries, atlas


def build_map(write=True, compositor_mutator=None, live_cell_fixups=None):
    pages, unservable, page_files = load_pages()
    races = {}
    composite_sources = {}

    # split each file into blocks keyed by CREATURE_GRAPHICS / CREATURE_CASTE_GRAPHICS.
    for path, kind, args, race, inner in iter_graphics_blocks(graphics_files()):
        layered_here = is_layered(inner)
        sprite = apply_live_cell_fixup(race, parse_flat(inner, pages), live_cell_fixups)
        # B47 + dinofix: per-creature dead-body art. Prefer an explicit [CORPSE:...] cell;
        # fall back to [REMAINS:...] (small/vermin-class creatures use REMAINS instead of
        # CORPSE -- TERMITE/SLUG/SKINK/FISH_CLOWNFISH and small extinct critters).
        corpse = parse_corpse(inner, pages) or parse_remains(inner, pages)
        skeleton = parse_skeleton(inner, pages)  # B47: rare explicit skeleton art
        # No top-level flat tag but the race IS layered: recover a species flat
        # fallback from the LAYER_SET body (B19 -- wild/never-drawn units otherwise
        # fall through to the generic dwarf.png). Civ humanoids (palette-composited)
        # are skipped inside parse_layerset_body and keep their baked fallback.
        if sprite is None and layered_here and race not in CIV_BAKED:
            sprite = parse_layerset_body(inner, pages, unservable)

        if kind == "CREATURE_GRAPHICS":
            src = composite_source_for_block(inner, pages, page_files)
            if src and race not in CIV_BAKED:
                composite_sources[race] = src
            # race-level block wins; keep any flat cell found AND/OR the layered
            # flag, merging castes already recorded from an earlier caste block.
            cur = races.get(race, {})
            castes = cur.get("castes", {})
            rec = dict(sprite) if sprite else {}
            # B47: corpse/skeleton cells ride the race record; merge with any found in
            # an earlier block for this race (e.g. the live cell and corpse cell can
            # come from different graphics files -- first binding wins, same as flat).
            if corpse or cur.get("corpse"):
                rec["corpse"] = corpse or cur.get("corpse")
            if skeleton or cur.get("skeleton"):
                rec["skeleton"] = skeleton or cur.get("skeleton")
            if layered_here or cur.get("layered"):
                rec["layered"] = True
            if race in CIV_BAKED:
                rec["layered"] = True
                rec["baked"] = CIV_BAKED[race]
            if castes:
                rec["castes"] = castes
            if not rec:
                # neither a flat cell nor LAYER_SET found (shouldn't happen in
                # practice -- every race in this DF version has one or the
                # other) -- record as layered/no-bake so the client still has
                # a defined fallback rather than a missing races[] key.
                rec = {"layered": True}
            races[race] = rec
        else:  # CREATURE_CASTE_GRAPHICS:RACE:CASTE
            caste = args[1] if len(args) > 1 else "DEFAULT"
            cur = races.setdefault(race, {})
            caste_rec = dict(sprite) if sprite else {}
            if layered_here:
                caste_rec["layered"] = True
            # B47: promote a caste block's corpse/skeleton cell to the race level when
            # the race has none yet (poultry-style per-caste-only species).
            if corpse and "corpse" not in cur:
                cur["corpse"] = corpse
            if skeleton and "skeleton" not in cur:
                cur["skeleton"] = skeleton
            cur.setdefault("castes", {})[caste] = caste_rec
            # if no race-level flat cell yet, promote first caste's data
            # (flat cell and/or layered flag) as the race-level default.
            if "sheet" not in cur and not cur.get("layered"):
                cur.update({k: v for k, v in caste_rec.items()})

    # Defensive fallback (spec WE-6 item 1): a layered "<BASE> MAN"/"<BASE>_MAN"
    # animal-person race with no in-block flat cell borrows the base species'
    # flat cell, if the base race has one. No-op for most current animal-people,
    # but extinct animal-people still rely on it for their declared span before
    # the compositor replaces the borrowed cell with species body art.
    for race, rec in races.items():
        if rec.get("layered") and "sheet" not in rec and _MAN_SUFFIX.search(race):
            base = _MAN_SUFFIX.sub("", race).strip()
            base_rec = races.get(base)
            if base_rec and base_rec.get("sheet"):
                for k in ("sheet", "col", "row", "w", "h"):
                    if k in base_rec:
                        rec[k] = base_rec[k]

    composite_entries, composite_atlas = apply_composite_fallbacks(
        races, composite_sources, mutator=compositor_mutator)

    result = {
        "_note": "WS2 creature->sprite map. Blit sheet cell (col*32,row*32,32,32) "
                 "for flat races; layered races additionally carry their own "
                 "flat cell when the raws define one (fallback while the W-E "
                 "per-unit composite hash is loading), else fall back to the "
                 "baked PNG (dwarf.png family) -- see build_creature_map.py "
                 "docstring. Sheets served from DF install; generated composite "
                 "fallbacks use animal_people_flat.png.",
        "cell": 32,
        "races": dict(sorted(races.items())),
    }

    if write:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=1)
        composite_atlas.save(COMPOSITE_OUT)
        os.makedirs(os.path.dirname(WEB_OUT), exist_ok=True)
        shutil.copyfile(OUT, WEB_OUT)
        shutil.copyfile(COMPOSITE_OUT, WEB_COMPOSITE_OUT)
    return result, composite_entries, composite_atlas


def main():
    result, composite_entries, _atlas = build_map(write=True)
    races = result["races"]

    flat = sum(1 for v in races.values() if v.get("sheet"))
    corpse_n = sum(1 for v in races.values() if v.get("corpse"))
    skeleton_n = sum(1 for v in races.values() if v.get("skeleton"))
    layered = sum(1 for v in races.values() if v.get("layered"))
    layered_own_flat = sum(1 for v in races.values() if v.get("layered") and v.get("sheet"))
    layered_no_flat = layered - layered_own_flat
    mechanisms = {}
    spans = {}
    for entry in composite_entries:
        mechanisms[entry["mechanism"]] = mechanisms.get(entry["mechanism"], 0) + 1
        spans[entry["span"]] = spans.get(entry["span"], 0) + 1
    print(f"wrote {OUT}")
    print(f"wrote {WEB_OUT}")
    print(f"wrote {COMPOSITE_OUT}")
    print(f"wrote {WEB_COMPOSITE_OUT}")
    print(f"races total={len(races)}  flat-only={flat - layered_own_flat}  "
          f"layered={layered} (own-flat-fallback={layered_own_flat}, "
          f"generic-only={layered_no_flat})")
    print(f"corpse cells={corpse_n}  skeleton cells={skeleton_n}  (B47)")
    print(f"composited flat fallbacks={len(composite_entries)}  mechanisms={mechanisms}  spans={spans}")
    print("composited races:", [entry["race"] for entry in composite_entries])
    print("sample flat-only:", [r for r, v in races.items()
                                 if v.get("sheet") and not v.get("layered")][:8])
    print("sample layered+own-flat:", [r for r, v in races.items()
                                        if v.get("layered") and v.get("sheet")][:8])
    print("sample layered generic-only:", [r for r, v in races.items()
                                            if v.get("layered") and not v.get("sheet")][:8])


if __name__ == "__main__":
    main()
