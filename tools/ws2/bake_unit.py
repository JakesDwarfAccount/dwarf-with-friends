#!/usr/bin/env python
"""
bake_unit.py -- W-E feasibility pixel test.

Reproduces DF's own per-unit composited sprite offline, by evaluating DF's
*parsed* graphics-layer-set conditions (dumped to dwarf_layerset.json) against
a specific unit's *parsed* appearance read (scout_units.json), and blitting
the resulting layer stack from the pre-exported texture-slot atlas.

This generalizes bake_dwarf.py's palette-remap trick (LS_PALETTE / USE_PALETTE:
row0 of a *_palettes.png is the "key" row painted into the source art; a
USE_PALETTE:<TOKEN>:<row> remaps every pixel whose RGB equals key-row[c] to
target-row[c], alpha preserved) to the *full* condition-gated layer set
instead of a hand-picked handful of body-part cells.

INPUTS (read-only)
------------------
  dwarf_layerset.json   -- layer_sets[2] (role DEFAULT, prof NONE, 893 layers):
                           the adult DEFAULT composite spec, in file/paint order.
  scout_units.json      -- live-DF unit appearance reads ("dwarves" array).
  atlas/tex_<id>.rgba   -- every texture slot DF has ever allocated, RAW RGBA8888,
                           dims via atlas/index.json. Library sprite pieces
                           (shoulder, torso, hair styles, clothing cells, ...)
                           live in this SAME id-space as a unit's own composited
                           slot (the --target ids), just allocated earlier/lower.
  dwarf_body_palettes.png / dwarf_hair_palettes.png / dwarf_clothes_palettes.png
                        -- LS_PALETTE source images (row 0 = key row).

CONDITION MODEL (see the big docstring-comments inline for the reverse-engineered
semantics of req_caste / req_prof / req_item / forb_item / tl / rand_part /
use_palette / flags.item_pal -- discovered empirically from this exact JSON,
cross-checked against graphics_creatures_dwarf.txt).

OUTPUT
------
  sprites/unit_<id>_cell<i>.png   -- the baked composite (cell0 = anchor 32x32,
                                     cell1 = second cell for 2-wide weapons).
  If --target is given: prints %exact / %exact-nonzero-alpha / MAE, and (with
  --diffdir) writes side-by-side + diff PNGs there (NOT into the repo).

Standalone offline tool: stdlib + PIL only.
Run with: python bake_unit.py ...
"""
import argparse
import collections
import json
import os
import sys

from PIL import Image, ImageDraw

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

# ----------------------------------------------------------------------------
# Paths (all read-only except OUT_DIR / DIFF_DIR)
# ----------------------------------------------------------------------------
DF_GFX = dfroot.df_root_for(__file__, sub="data/vanilla/vanilla_creatures_graphics/graphics/images/dwarf",
                          purpose="reads sprite sheets out of Dwarf Fortress's own art")
# Session inputs — regenerate with tools/ws2/dump_layerset.lua + scout_units.lua (dfhack-run)
# and GET /tiledump?atlas=1 for the atlas; override via --layerset/--units/--atlas.
ATLAS_DIR = dfroot.df_root_for(__file__, sub="dwf_td/we_scout1/atlas",
                          purpose="reads an atlas the plugin dumped into the DF install")
LAYERSET_JSON = "dwarf_layerset.json"
SCOUT_UNITS_JSON = "scout_units.json"

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sprites")
DIFF_DIR = os.environ.get("BAKE_DIFF_DIR", "bake_diffs")  # keep diff PNGs OUT of the repo

BODY_PAL_PNG = os.path.join(DF_GFX, "dwarf_body_palettes.png")
HAIR_PAL_PNG = os.path.join(DF_GFX, "dwarf_hair_palettes.png")
CLOTHES_PAL_PNG = os.path.join(DF_GFX, "dwarf_clothes_palettes.png")

CELL = 32

# ----------------------------------------------------------------------------
# Item subtype token -> int index tables.
# Order = load order of [ITEM_<TYPE>:ITEM_<TYPE>_<NAME>] tokens in DF's raws
# (<DF_ROOT>\...\vanilla_items\objects\item_<type>.txt), confirmed by grep.
# ----------------------------------------------------------------------------
ITEM_SUBTYPES = {
    "ARMOR": [
        "ITEM_ARMOR_BREASTPLATE", "ITEM_ARMOR_MAIL_SHIRT", "ITEM_ARMOR_LEATHER",
        "ITEM_ARMOR_COAT", "ITEM_ARMOR_SHIRT", "ITEM_ARMOR_CLOAK", "ITEM_ARMOR_TUNIC",
        "ITEM_ARMOR_TOGA", "ITEM_ARMOR_CAPE", "ITEM_ARMOR_VEST", "ITEM_ARMOR_DRESS",
        "ITEM_ARMOR_ROBE",
    ],
    "PANTS": [
        "ITEM_PANTS_PANTS", "ITEM_PANTS_GREAVES", "ITEM_PANTS_LEGGINGS",
        "ITEM_PANTS_LOINCLOTH", "ITEM_PANTS_THONG", "ITEM_PANTS_SKIRT",
        "ITEM_PANTS_SKIRT_SHORT", "ITEM_PANTS_SKIRT_LONG", "ITEM_PANTS_BRAIES",
    ],
    "GLOVES": ["ITEM_GLOVES_GAUNTLETS", "ITEM_GLOVES_GLOVES", "ITEM_GLOVES_MITTENS"],
    "SHOES": [
        "ITEM_SHOES_SHOES", "ITEM_SHOES_BOOTS", "ITEM_SHOES_BOOTS_LOW",
        "ITEM_SHOES_SANDAL", "ITEM_SHOES_CHAUSSE", "ITEM_SHOES_SOCKS",
    ],
    "WEAPON": [
        "ITEM_WEAPON_WHIP", "ITEM_WEAPON_AXE_BATTLE", "ITEM_WEAPON_HAMMER_WAR",
        "ITEM_WEAPON_SWORD_SHORT", "ITEM_WEAPON_SPEAR", "ITEM_WEAPON_MACE",
        "ITEM_WEAPON_CROSSBOW", "ITEM_WEAPON_PICK", "ITEM_WEAPON_BOW",
        "ITEM_WEAPON_BLOWGUN", "ITEM_WEAPON_PIKE", "ITEM_WEAPON_HALBERD",
        "ITEM_WEAPON_SWORD_2H", "ITEM_WEAPON_SWORD_LONG", "ITEM_WEAPON_MAUL",
        "ITEM_WEAPON_AXE_GREAT", "ITEM_WEAPON_DAGGER_LARGE", "ITEM_WEAPON_SCOURGE",
        "ITEM_WEAPON_FLAIL", "ITEM_WEAPON_MORNINGSTAR", "ITEM_WEAPON_SCIMITAR",
        "ITEM_WEAPON_AXE_TRAINING", "ITEM_WEAPON_SWORD_SHORT_TRAINING",
        "ITEM_WEAPON_SPEAR_TRAINING", "ITEM_WEAPON_PICK_GREAT",
    ],
    "HELM": [
        "ITEM_HELM_HELM", "ITEM_HELM_HOOD", "ITEM_HELM_VEIL_HEAD", "ITEM_HELM_CAP",
        "ITEM_HELM_MASK", "ITEM_HELM_VEIL_FACE", "ITEM_HELM_TURBAN", "ITEM_HELM_SCARF_HEAD",
    ],  # order approximate/unused by our two units; not verified against raws.
}


def subtype_str_to_int(item_type, subtype_token):
    table = ITEM_SUBTYPES.get(item_type)
    if not table or subtype_token is None:
        return None
    try:
        return table.index(subtype_token)
    except ValueError:
        return None


# HEAD tissue-style-type ints (from caste_tissue_styles cross-ref given in task).
TISSUE_HAIR, TISSUE_BEARD, TISSUE_MOUSTACHE, TISSUE_SIDEBURNS = 36, 37, 38, 39

# Groups (layer_sets[2], role DEFAULT/prof NONE) that carry a 'tl' (tissue/skin)
# condition, classified by what unit-side data governs them (all derived
# empirically from the JSON -- see report).
SKIN_GROUPS = {3, 7, 11, 15, 19, 23, 31, 37, 41, 54}  # body-part skin tone + FACE
HAIR_GROUP = 42
BEARD_GROUP = 51
FACE_GROUP = 41

CASTE_INT = {"FEMALE": 0, "MALE": 1}


# ----------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------
def load_json_lenient(path):
    raw = open(path, "rb").read()
    try:
        return json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError:
        return json.loads(raw.decode("cp1252"))


def load_atlas_index():
    return load_json_lenient(os.path.join(ATLAS_DIR, "index.json"))["tiles"]


_tile_cache = {}


def load_tile(tex_id, atlas_index):
    tex_id = str(tex_id)
    if tex_id in _tile_cache:
        return _tile_cache[tex_id]
    info = atlas_index.get(tex_id)
    if info is None:
        return None
    w, h = info["w"], info["h"]
    p = os.path.join(ATLAS_DIR, f"tex_{tex_id}.rgba")
    if not os.path.exists(p):
        return None
    data = open(p, "rb").read()
    img = Image.frombytes("RGBA", (w, h), data)
    _tile_cache[tex_id] = img
    return img


def load_palette_png(path):
    im = Image.open(path).convert("RGBA")
    rows = []
    for y in range(im.height):
        rows.append([im.getpixel((x, y))[:3] for x in range(im.width)])
    return rows


PALETTES = None  # {0: body_rows, 1: hair_rows, 2: clothes_rows} -- lazy


def get_palettes():
    global PALETTES
    if PALETTES is None:
        PALETTES = {
            0: load_palette_png(BODY_PAL_PNG),
            1: load_palette_png(HAIR_PAL_PNG),
            2: load_palette_png(CLOTHES_PAL_PNG),
        }
    return PALETTES


def remap_fixed(cellimg, pal_rows, dst_row):
    """USE_PALETTE remap: key-row(0)[c] RGB -> pal_rows[dst_row][c] RGB."""
    if dst_row == 0:
        return cellimg
    key_row = pal_rows[0]
    dst = pal_rows[dst_row]
    lut = {key_row[c]: dst[c] for c in range(len(key_row))}
    out = cellimg.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            nc = lut.get((r, g, b))
            if nc:
                px[x, y] = (nc[0], nc[1], nc[2], a)
    return out


def remap_empirical(cellimg, target_crop):
    """
    DISCOVER an item_pal (USE_STANDARD_PALETTE_FROM_ITEM) remap directly from
    ground truth: for every opaque source pixel, look at DF's own composited
    pixel at the same local (x,y) and record src-RGB -> target-RGB. Majority
    vote per source color (robust to any incidental overlap from
    later-drawn layers). Returns (remapped_image, lut_dict, coverage_frac).
    """
    votes = collections.defaultdict(collections.Counter)
    px = cellimg.load()
    tpx = target_crop.load()
    n_opaque = 0
    n_voted = 0
    for y in range(cellimg.height):
        for x in range(cellimg.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            n_opaque += 1
            tr, tg, tb, ta = tpx[x, y]
            if ta == 0:
                continue
            n_voted += 1
            votes[(r, g, b)][(tr, tg, tb)] += 1
    lut = {src: cnt.most_common(1)[0][0] for src, cnt in votes.items()}
    out = cellimg.copy()
    opx = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = opx[x, y]
            if a == 0:
                continue
            nc = lut.get((r, g, b))
            if nc:
                opx[x, y] = (nc[0], nc[1], nc[2], a)
    coverage = (n_voted / n_opaque) if n_opaque else 0.0
    return out, lut, coverage


def find_matching_palette_row(lut, pal_rows):
    """Given a discovered src->dst RGB LUT, find which CLOTHES palette row is
    the best match (for reporting the human-readable color name/row)."""
    key_row = pal_rows[0]
    key_to_col = {rgb: i for i, rgb in enumerate(key_row)}
    best_row, best_score = None, -1
    for ridx, row in enumerate(pal_rows):
        score = 0
        total = 0
        for src, dst in lut.items():
            col = key_to_col.get(src)
            if col is None:
                continue
            total += 1
            if row[col] == dst:
                score += 1
        if total and score == total and total > best_score:
            best_score = total
            best_row = ridx
    return best_row


# ----------------------------------------------------------------------------
# Unit profile
# ----------------------------------------------------------------------------
class UnitProfile:
    def __init__(self, rec):
        self.raw = rec
        self.id = rec["id"]
        self.name = rec["name"]
        self.caste = CASTE_INT[rec["caste_id"]]
        self.profession = rec["profession"]
        self.syndromes = rec.get("syndromes", [])

        self.hair_color = None
        self.skin_color = None
        for c in rec.get("colors", []):
            if c["part"] == "hair" and c["index"] == 0:
                self.hair_color = c["pattern_token"]
            if c["part"] == "skin":
                self.skin_color = c["pattern_token"]

        # tissue_by_type: style_type int -> {"length":int, "style":str}
        self.tissue_by_type = {}
        for t in rec.get("tissue", []):
            st = t["style_type"]
            if st < 0:
                continue
            # keep first non-trivial entry per category; fall back to any.
            if st not in self.tissue_by_type or (
                self.tissue_by_type[st]["length"] < 0 and t["length"] >= 0
            ):
                self.tissue_by_type[st] = {"length": t["length"], "style": t["style"]}

        # items: list of dicts with resolved subtype_int
        self.items = []
        for it in rec.get("inventory", []):
            subtype_int = subtype_str_to_int(it["item_type"], it.get("subtype_token"))
            self.items.append({
                "item_type": it["item_type"],
                "subtype_int": subtype_int,
                "subtype_token": it.get("subtype_token"),
                "body_part_id": it["body_part_id"],
                "mat": it.get("mat"),
                "mat_color_token": it.get("mat_color_token"),
                "mode": it.get("mode"),
            })

    def tissue(self, style_type):
        return self.tissue_by_type.get(style_type, {"length": -30000, "style": "NONE"})


# ----------------------------------------------------------------------------
# Condition evaluation
# ----------------------------------------------------------------------------
def item_matches(entry, item):
    if entry.get("item_type") != item["item_type"]:
        return False
    bp = entry.get("bp")
    if bp:
        lo, hi = bp[0], bp[-1]
        if lo > hi:
            lo, hi = hi, lo
        if not (lo <= item["body_part_id"] <= hi):
            return False
    subtypes = entry.get("subtype") or []
    if subtypes and item["subtype_int"] not in subtypes:
        return False
    return True


def req_item_ok(layer, items):
    reqs = layer.get("req_item")
    if not reqs:
        return True
    # OR across entries (e.g. WAIST_SKIRT: dress OR thong); OR across items.
    return any(any(item_matches(e, it) for it in items) for e in reqs)


def forb_item_ok(layer, items):
    forbs = layer.get("forb_item")
    if not forbs:
        return True
    return not any(any(item_matches(e, it) for it in items) for e in forbs)


def req_caste_ok(layer, caste_int):
    rc = layer.get("req_caste")
    if rc is None:
        return True
    return caste_int in rc


def req_prof_ok(layer, profession):
    rp = layer.get("req_prof")
    if rp is None:
        return True
    return profession in rp


def req_syn_ok(layer, syndromes):
    rs = layer.get("req_syn")
    if rs is None:
        return True
    return any(s in rs for s in syndromes)


def tl_cond_matches(cond, color_token, length=None, style=None, try_curly=False, caste=None):
    # Per-condition caste gate: 'caste' is a parallel array to 'bp'/'tl'
    # (one entry per body-part/tissue-layer instance this condition covers).
    # Membership test is correct either way: BEARD conditions only ever list
    # caste=[1] (MALE-only growth), while skin-tone conditions list a mix of
    # both 0 and 1 (caste-agnostic) -- so "unit.caste in cond['caste']" vetoes
    # the former for FEMALE units without over-constraining the latter.
    cl = cond.get("caste")
    if cl and caste is not None and caste not in cl:
        return False
    colors = cond.get("colors") or []
    if colors and color_token not in colors:
        return False
    lo, hi = cond.get("len", [-1, -1])
    if lo != -1 or hi != -1:
        if length is None:
            return False
        # DF appears to use a large-negative sentinel (-30000) for "grown out
        # fully / never trimmed" rather than "no tissue" -- treat it as
        # unbounded-large so it satisfies open-ended (hi=-1) LONG_* bands.
        # (Discovered empirically: a "style NONE, length -30000" unit renders
        # with long unkempt hair, not bald.)
        eff_length = 10 ** 9 if length <= -30000 else length
        if lo != -1 and eff_length < lo:
            return False
        if hi != -1 and eff_length > hi:
            return False
    shape_list = cond.get("shape") or []
    not_shaped = cond.get("not_shaped", False)
    if shape_list:
        if style not in shape_list:
            return False
    elif not_shaped:
        if style != "NONE":
            return False
    return True


def tl_ok(layer, unit, group):
    tls = layer.get("tl")
    if not tls:
        return True
    if group == HAIR_GROUP:
        t = unit.tissue(TISSUE_HAIR)
        return any(tl_cond_matches(c, unit.hair_color, t["length"], t["style"], caste=unit.caste)
                   for c in tls)
    if group == BEARD_GROUP:
        t = unit.tissue(TISSUE_BEARD)
        return any(tl_cond_matches(c, unit.hair_color, t["length"], t["style"], caste=unit.caste)
                   for c in tls)
    # skin / face groups: color-only match (len is always [-1,-1] here).
    return any(tl_cond_matches(c, unit.skin_color, caste=unit.caste) for c in tls)


def flags_ok(layer, unit):
    """flags.ghost gates the 'ghost tint' variant (G_* tokens) -- these carry
    no req_syn (ghost-ness isn't a CE_ syndrome) but must still be vetoed for
    any non-ghost unit, or the ghost recolor wins by default (it has no other
    disqualifying condition). flags.child/not_child/suppressed handled the
    same way; our two units are neither ghosts nor children."""
    fl = layer.get("flags")
    if not fl:
        return True
    if fl.get("ghost"):
        return False
    if fl.get("child"):
        return False
    if fl.get("suppressed"):
        return False
    return True


def layer_passes(layer, unit, group):
    if not flags_ok(layer, unit):
        return False
    if not req_caste_ok(layer, unit.caste):
        return False
    if not req_prof_ok(layer, unit.profession):
        return False
    if not req_syn_ok(layer, unit.syndromes):
        return False
    if not req_item_ok(layer, unit.items):
        return False
    if not forb_item_ok(layer, unit.items):
        return False
    if not tl_ok(layer, unit, group):
        return False
    return True


# ----------------------------------------------------------------------------
# Layer-set evaluation -> ordered list of chosen layers (one per group, if any)
# ----------------------------------------------------------------------------
def group_layers_in_order(layers):
    """Return groups in first-appearance order, each with its layer list."""
    order = []
    seen = {}
    for l in layers:
        g = l["group"]
        if g not in seen:
            seen[g] = []
            order.append(g)
        seen[g].append(l)
    return order, seen


def evaluate(layers, unit, group_match="first", face_idx_override=None):
    """
    Returns list of (group, chosen_layer) for every group that has a winner.
    FACE_GROUP is special-cased: within the matching (caste+skin) candidates,
    there are 4 rand_part idx variants (1..4) that are otherwise identical
    conditions; face_idx_override picks which one (None = idx 1 default).
    """
    order, groups = group_layers_in_order(layers)
    chosen = []
    for g in order:
        candidates = [l for l in groups[g] if layer_passes(l, unit, g)]
        if not candidates:
            continue
        if g == FACE_GROUP:
            want_idx = face_idx_override if face_idx_override is not None else 1
            filtered = [l for l in candidates if l.get("rand_part", {}).get("idx", [None])[0] == want_idx]
            if not filtered:
                filtered = candidates
            chosen.append((g, filtered[0]))
            continue
        winner = candidates[0] if group_match == "first" else candidates[-1]
        chosen.append((g, winner))
    return chosen


# ----------------------------------------------------------------------------
# Compositing
# ----------------------------------------------------------------------------
def render(unit, layers, atlas_index, target_imgs=None, group_match="first", face_idx=None,
           verbose=True):
    """
    target_imgs: optional dict {cell_index: PIL.Image} of DF's own ground-truth
    composite, used ONLY to empirically discover item_pal remaps (see
    remap_empirical). Returns (canvases dict cell->Image, chosen list, discovery log).
    """
    pal = get_palettes()
    chosen = evaluate(layers, unit, group_match=group_match, face_idx_override=face_idx)

    canvases = {0: Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))}
    discovery_log = []

    # NOTE (empirically discovered, contradicts the a-priori "tex[1] draws to
    # a second/side tile" model): for the one 2-cell layer in our two units
    # (CLOTHING_LH_PICK), tex[1]'s source crop composites onto the SAME
    # 32x32 output slot as tex[0] -- not a neighboring map-tile texture slot.
    # tex[0] there is simply empty (0 opaque px) and DF's actual second
    # allocated atlas id (166831 for unit 5505) is *also* fully blank, which
    # is only consistent with "both tex[] entries target canvas 0". We found
    # no case where a second on-canvas slot was actually used, so we always
    # composite every tex[] entry onto canvas 0. See report for the residual
    # uncertainty (a longer weapon that truly overhangs into a neighboring
    # map tile might use tex[1] differently -- unverified, no such unit here).
    for group, layer in chosen:
        tex = layer.get("tex", [])
        for cell_idx, pair in enumerate(tex[:2]):
            tex_id = pair[0]
            if not tex_id:
                continue
            src = load_tile(tex_id, atlas_index)
            if src is None:
                if verbose:
                    print(f"  ! missing atlas tile {tex_id} for {layer.get('token')}")
                continue
            src = src.copy()

            up = layer.get("use_palette")
            item_pal = bool(layer.get("flags", {}).get("item_pal"))
            target0 = target_imgs.get(0) if target_imgs else None
            if up:
                idx = up["idx"][0]
                row = up["row"][0]
                src = remap_fixed(src, pal[idx], row)
            elif item_pal:
                if target0 is not None:
                    src, lut, coverage = remap_empirical(src, target0)
                    row_guess = find_matching_palette_row(lut, pal[2])
                    discovery_log.append({
                        "token": layer["token"], "cell": cell_idx, "tex_id": tex_id,
                        "coverage": round(coverage, 3), "clothes_row_guess": row_guess,
                        "lut_size": len(lut),
                    })
                else:
                    discovery_log.append({
                        "token": layer["token"], "cell": cell_idx, "tex_id": tex_id,
                        "coverage": None, "clothes_row_guess": None,
                        "note": "no target provided; left unremapped",
                    })

            canvases[0] = Image.alpha_composite(canvases[0], src)

    return canvases, chosen, discovery_log


# ----------------------------------------------------------------------------
# Comparison / diagnostics
# ----------------------------------------------------------------------------
def compare(canvas, target):
    w, h = canvas.size
    cpx, tpx = canvas.load(), target.load()
    total = w * h
    exact = 0
    exact_nonzero_alpha = 0
    nonzero_alpha_n = 0
    abs_err_sum = 0.0
    opaque_n = 0
    for y in range(h):
        for x in range(w):
            c = cpx[x, y]
            t = tpx[x, y]
            if c == t:
                exact += 1
            if t[3] > 0 or c[3] > 0:
                nonzero_alpha_n += 1
                if c == t:
                    exact_nonzero_alpha += 1
            if t[3] > 0:
                opaque_n += 1
                abs_err_sum += sum(abs(c[k] - t[k]) for k in range(3)) / 3.0
    pct_exact = 100.0 * exact / total
    pct_exact_nz = 100.0 * exact_nonzero_alpha / nonzero_alpha_n if nonzero_alpha_n else 100.0
    mae = abs_err_sum / opaque_n if opaque_n else 0.0
    return {
        "pct_exact": pct_exact,
        "pct_exact_nonzero_alpha": pct_exact_nz,
        "mae_over_opaque": mae,
        "opaque_px": opaque_n,
        "total_px": total,
    }


def save_diff(canvas, target, out_path, scale=8):
    w, h = canvas.size
    side = Image.new("RGBA", (w * 3 + 20, h), (40, 40, 40, 255))
    side.paste(canvas, (0, 0))
    side.paste(target, (w + 10, 0))
    diff = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cpx, tpx, dpx = canvas.load(), target.load(), diff.load()
    for y in range(h):
        for x in range(w):
            c, t = cpx[x, y], tpx[x, y]
            if c == t:
                dpx[x, y] = (0, 0, 0, 0) if t[3] == 0 else (0, 255, 0, 255)
            else:
                dpx[x, y] = (255, 0, 0, 255)
    side.paste(diff, (2 * w + 20, 0))
    big = side.resize((side.width * scale, side.height * scale), Image.NEAREST)
    big.save(out_path)


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------
def find_unit(units_data, unit_id):
    for u in units_data["dwarves"]:
        if u["id"] == unit_id:
            return u
    for u in units_data.get("all_units", []):
        if u.get("id") == unit_id:
            return u
    raise KeyError(f"unit {unit_id} not found in scout_units.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--unit", type=int, required=True)
    ap.add_argument("--target", type=int, nargs="*", default=None,
                     help="ground-truth composite tex id(s), cell0 [cell1 ...]")
    ap.add_argument("--group-match", choices=["first", "last"], default="first")
    ap.add_argument("--face-idx", type=int, default=None, choices=[1, 2, 3, 4])
    ap.add_argument("--try-all-faces", action="store_true")
    ap.add_argument("--diff", action="store_true", help="write diff PNGs to DIFF_DIR (not the repo)")
    ap.add_argument("--layerset", default=None, help="dwarf_layerset.json path")
    ap.add_argument("--units", default=None, help="scout_units.json path")
    ap.add_argument("--atlas", default=None, help="atlas dir (tex_<id>.rgba + index.json)")
    args = ap.parse_args()
    global ATLAS_DIR, LAYERSET_JSON, SCOUT_UNITS_JSON
    if args.layerset: LAYERSET_JSON = args.layerset
    if args.units: SCOUT_UNITS_JSON = args.units
    if args.atlas: ATLAS_DIR = args.atlas

    os.makedirs(OUT_DIR, exist_ok=True)
    if args.diff:
        os.makedirs(DIFF_DIR, exist_ok=True)

    layerset = load_json_lenient(LAYERSET_JSON)
    layers = layerset["layer_sets"][2]["layers"]
    units_data = load_json_lenient(SCOUT_UNITS_JSON)
    rec = find_unit(units_data, args.unit)
    unit = UnitProfile(rec)
    atlas_index = load_atlas_index()

    print(f"=== unit {unit.id} {unit.name!r} caste={rec['caste_id']} prof={unit.profession} ===")
    print(f"    hair_color={unit.hair_color} skin_color={unit.skin_color}")
    for st, name in ((36, "HAIR"), (37, "BEARD"), (38, "MOUSTACHE"), (39, "SIDEBURNS")):
        t = unit.tissue(st)
        print(f"    tissue[{name}] len={t['length']} style={t['style']}")
    for it in unit.items:
        print(f"    item {it['item_type']}/{it['subtype_token']}(#{it['subtype_int']}) "
              f"bp={it['body_part_id']} color={it['mat_color_token']} mode={it['mode']}")

    target_imgs = {}
    if args.target:
        for i, tid in enumerate(args.target):
            img = load_tile(tid, atlas_index)
            if img is None:
                print(f"  ! target tex {tid} not found in atlas")
            else:
                target_imgs[i] = img.convert("RGBA")

    face_candidates = [args.face_idx] if args.face_idx else (
        [1, 2, 3, 4] if args.try_all_faces else [1]
    )

    best = None
    for fidx in face_candidates:
        canvases, chosen, disc = render(unit, layers, atlas_index, target_imgs,
                                         group_match=args.group_match, face_idx=fidx)
        print(f"\n--- face_idx={fidx}: {len(chosen)} groups drawn ---")
        for g, l in chosen:
            print(f"  group {g:>2} -> {l['token']}"
                  + (f"  use_palette={l['use_palette']}" if l.get("use_palette") else "")
                  + (f"  item_pal(discovered)" if l.get("flags", {}).get("item_pal") else ""))
        for d in disc:
            print(f"  [item_pal] {d}")

        stats_by_cell = {}
        if target_imgs:
            for cidx, timg in target_imgs.items():
                canvas = canvases.get(cidx, Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0)))
                stats = compare(canvas, timg)
                stats_by_cell[cidx] = stats
                print(f"  cell{cidx}: exact={stats['pct_exact']:.2f}% "
                      f"exact_nz={stats['pct_exact_nonzero_alpha']:.2f}% "
                      f"MAE={stats['mae_over_opaque']:.3f} opaque_px={stats['opaque_px']}")

        avg_exact_nz = (sum(s["pct_exact_nonzero_alpha"] for s in stats_by_cell.values()) / len(stats_by_cell)
                         if stats_by_cell else 0)
        if best is None or avg_exact_nz > best[0]:
            best = (avg_exact_nz, fidx, canvases, chosen, disc, stats_by_cell)

    _, best_fidx, canvases, chosen, disc, stats_by_cell = best
    if len(face_candidates) > 1:
        print(f"\n=== BEST face_idx = {best_fidx} (avg exact_nz {best[0]:.2f}%) ===")

    for cidx, canvas in canvases.items():
        out_p = os.path.join(OUT_DIR, f"unit_{unit.id}_cell{cidx}.png")
        canvas.save(out_p)
        print(f"wrote {out_p}")
        if args.diff and cidx in target_imgs:
            dp = os.path.join(DIFF_DIR, f"unit_{unit.id}_cell{cidx}_diff.png")
            save_diff(canvas, target_imgs[cidx], dp)
            print(f"wrote diff {dp}")


if __name__ == "__main__":
    main()
