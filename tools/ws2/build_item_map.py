#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WS2 v2 (WC-2): build the item sprite map the browser tile renderer needs.
# WS2 v3 (T1b, 2026-07-08-asset-material-parity-spec §4-T1b): ADDITIVE keys for
# material/value/shape parity -- every v2 key/behavior is preserved byte-for-byte;
# v3 only appends new top-level keys and bumps "_v" 2->3. The new keys parse
# vanilla's graphics raws (graphics_items.txt already read; NEW read set:
# vanilla_descriptors_graphics/graphics/{graphics_shapes.txt,tile_page_descriptors.txt})
# and are consumed by the tier-1 client material resolver:
#   - rough_gem_tiers:  sorted-ascending [{min_value,cell}] from the 10
#                       ITEM_ROUGH_GEM_VALUE_<N> rows (client picks the highest
#                       tier whose min_value <= material MATERIAL_VALUE).
#   - rough_gem_glass:  {GLASS_GREEN/GLASS_CLEAR/GLASS_CRYSTAL: cell} from the
#                       ROUGH_GEM_GRAPHICS:BOULDERS:0:8:GLASS_* rows.
#   - gem_default / smallgem_default: the shape==-1 (spawned) fallback cells
#                       ITEM_GEMS @ GEMS:0:0 and SMALLGEMS:0:0.
#   - gem_shapes:       {<CUT_TOKEN>:{small,large}} from graphics_shapes.txt's
#                       SHAPE_GRAPHICS_SMALL_GEM/_LARGE_GEM rows (22 vanilla cuts;
#                       consumed once gem shape rides the wire in tier 2).
#   - boulder_bymat:    {<INORGANIC_ID>:cell} from the ~35 BOULDER_GRAPHICS rows.
#   - bar_bymat:        {POTASH,PEARLASH,COAL:COKE,COAL:CHARCOAL,SOAP: cell} from
#                       the BARS_GRAPHICS variants + ITEM_BARS_SOAP.
#
# v1 (kept for history in git blame) mapped 9 of df::item_type's 94 values off a
# hand-picked TOKEN_FOR_ITEM_TYPE list. v2 extends this to:
#   - bytype:      item_type name -> {sheet,col,row}, covering as many of the 94
#                  df::item_type enum values (df.d_basics.xml `item_type`) as
#                  vanilla's graphics raws give a real standalone ground-item cell
#                  for. Some item_types genuinely have NO standalone cell in
#                  vanilla (weapon/armor need the specific raw token via subtype;
#                  a handful of "misc material" types -- SMALLGEM/GEM/FISH/FISH_RAW/
#                  SEEDS -- have only bin-lid/barrel-lid/bag overlay cells in the item
#                  graphics raws. TX13 maps MEAT/GLOB through the separate creature
#                  body-part art + material-category raws described below.
#   - bytoken:     RAW item-graphics token (e.g. "ITEM_WEAPON_PICK") -> cell, for
#                  every token the parser can bind a cell to: every plain
#                  `[X_GRAPHICS:PAGE:col:row:TOKEN...]` line (TILE_GRAPHICS plus
#                  the sibling per-slot grammars: TOOL_/ARMOR_/HELM_/GLOVES_/
#                  PANTS_/SHOES_/SHIELD_/TOY_/TRAPCOMP_/FOOD_GRAPHICS -- all
#                  verified to share the identical PAGE:col:row:TOKEN shape) PLUS
#                  the "header + indented sub-cells" block grammar used by
#                  WEAPON_GRAPHICS/AMMO_GRAPHICS/SIEGEAMMO_GRAPHICS
#                  (`[WEAPON_GRAPHICS:TOKEN]` then `[WEAPON_GRAPHICS_DEFAULT:PAGE:
#                  col:row]`), keyed by the block's TOKEN using its "_DEFAULT"
#                  sub-cell. This is the table WC-3 (client apply, sonnet) uses
#                  to resolve a specific weapon/tool/armor raw token exactly.
#   - matvariants: furniture-as-item bases (Door/Bed/Table/Chair/Cabinet/Box/
#                  HatchCover/Grate) that carry a uniform _WOOD/_STONE/_METAL/
#                  _GLASS token suffix -> {base: {WOOD:{...}, STONE:{...}, ...}}.
#                  Shared by WC-3 (ground item material tint/cell) and WC-5
#                  (building_map's furniture reuse of these same item sheets).
#   - web:         ITEM_WEB_HARMLESS:1..4 / ITEM_WEB_THICK:1..4 (8 cells).
#   - _corpse_fallback: CORPSE/CORPSEPIECE art is keyed on CREATURE graphics
#                  state, not item sheets -- real per-race art needs the item's
#                  race on the wire (item_body_component), NEEDS-SCOUT, deferred
#                  to W-E's creature read pass (per spec). Emit REMAINS' cell as
#                  the interim stand-in so a corpse tile still renders something.
#   - _missing:    MISSING_ITEM (defaults.png 1:0, vanilla_interface/graphics/
#                  graphics_defaults.txt) -- the fallback WC-4 (client, out of
#                  this generator's territory) wires the box-of-last-resort to.
#   - creature_food: authored BODYPART_FAT/MEAT/organ cells plus each vanilla
#                  creature's raw-derived mat_type -> MEAT_CATEGORY assignment. Creature
#                  materials ride the wire as 19+local material slot, so the client can
#                  select fat, muscle, intestine, liver, etc. without a subtype or DLL change.
#
# TOKEN FORMAT (verified against the raws this session):
#   [TILE_GRAPHICS:<PAGE>:<col>:<row>:<TOKEN>(:<extra...>)]   -- "plain" form,
#     shared verbatim by TOOL_/ARMOR_/HELM_/GLOVES_/PANTS_/SHOES_/SHIELD_/TOY_/
#     TRAPCOMP_/FOOD_GRAPHICS (only the tag name differs). First binding of a
#     given TOKEN wins (trailing `:N` extra fields are cosmetic style-variant
#     indices 1..7 within the SAME token, e.g. ITEM_CHAIR_WOOD:1..7 -- picking
#     the first is an arbitrary-but-valid variant, same convention as v1).
#   [WEAPON_GRAPHICS:<TOKEN>]            -- "block" form (WEAPON_GRAPHICS,
#       [WEAPON_GRAPHICS_DEFAULT:<PAGE>:<col>:<row>]   AMMO_GRAPHICS, SIEGEAMMO_
#       [WEAPON_GRAPHICS_WOOD:<PAGE>:<col>:<row>]      GRAPHICS): a header names
#       ...                                            the raw TOKEN, indented
#                                                       sub-lines give material/
#                                                       state variant cells; we
#                                                       take the "_DEFAULT" cell.
#
# Run (uses the pre-installed venv; Pillow is preinstalled and used only for the hatch + table composite sheets):
#   python tools/ws2/build_item_map.py
#
# Reads (READ-ONLY, never writes to F:):
#   .../vanilla_items_graphics/graphics/graphics_items.txt
#   .../vanilla_items_graphics/graphics/graphics_containers.txt
#   .../vanilla_items_graphics/graphics/tile_page_items.txt
#   .../vanilla_plants_graphics/graphics/graphics_plants.txt   (ITEM_PLANT*)
#   .../vanilla_plants_graphics/graphics/tile_page_plants.txt
#   .../vanilla_interface/graphics/graphics_defaults.txt        (MISSING_ITEM)
#   .../vanilla_interface/graphics/tile_page_interface.txt
#   .../vanilla_descriptors_graphics/graphics/graphics_shapes.txt          (v3: gem shapes/defaults)
#   .../vanilla_descriptors_graphics/graphics/tile_page_descriptors.txt    (v3: GEMS/SMALLGEMS pages)
#   .../vanilla_creatures_graphics/graphics/{graphics_bodyparts.txt,tile_page_creatures.txt}
#   .../vanilla_materials/objects/material_template_default.txt
#   .../vanilla_bodies/objects/*.txt and vanilla_creatures/objects/*.txt
# Writes:
#   web/item_map.json
#   web/item_hatch_composite.png
#   web/item_table_composite.png
#   web/item_chair_composite.png

import json
import os
import re
import sys

from PIL import Image

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DF_ROOT = dfroot.df_root_for(__file__, sub="data/vanilla",
                          purpose="reads Dwarf Fortress's own raws as the ground truth")
ITEMS_GFX = os.path.join(DF_ROOT, "vanilla_items_graphics", "graphics")
PLANTS_GFX = os.path.join(DF_ROOT, "vanilla_plants_graphics", "graphics")
INTERFACE_GFX = os.path.join(DF_ROOT, "vanilla_interface", "graphics")
DESCRIPTORS_GFX = os.path.join(DF_ROOT, "vanilla_descriptors_graphics", "graphics")  # v3: gem shapes/pages
CREATURES_GFX = os.path.join(DF_ROOT, "vanilla_creatures_graphics", "graphics")
CREATURES_OBJECTS = os.path.join(DF_ROOT, "vanilla_creatures", "objects")
BODIES_OBJECTS = os.path.join(DF_ROOT, "vanilla_bodies", "objects")
MATERIALS_OBJECTS = os.path.join(DF_ROOT, "vanilla_materials", "objects")

ITEM_GFX_FILES = ["graphics_items.txt", "graphics_containers.txt"]
ITEM_TILE_PAGE_FILE = "tile_page_items.txt"
OUT_PATH = os.path.join(REPO, "web", "item_map.json")
HATCH_COMPOSITE_SHEET = "item_hatch_composite.png"
HATCH_COMPOSITE_OUT = os.path.join(REPO, "web", HATCH_COMPOSITE_SHEET)

# TX10 (spritepick export choices-20260710T201628Z, the owner pick "TABLE (missing legs)"):
# DF composes a table from a material tabletop cell PLUS a separate transparent
# leg overlay (ITEM_TABLE_LEG_VARIANT is an authored detail token, exactly like
# the ITEM_TABLE_SPIKES/RINGS/... details and the hatch-cover detail overlays).
# Our renderer drew only the bare tabletop cell, so tables rendered legless. TX10
# baked the adjudicated composite for STONE only -- base item_table.png(0,1) [the
# STONE/generic tabletop, shared by bytoken.ITEM_TABLE / ITEM_TABLE_STONE /
# matvariants.Table.STONE / bytype.TABLE] alpha-composited with legs
# item_table.png(7,0) -- leaving WOOD(0,0)/METAL(0,2)/GLASS(0,3) as bare (legless)
# bases for a follow-up.
#
# B183 (this wave): extend the SAME leg overlay to WOOD/METAL/GLASS. Their base
# tabletop cells are not new picks -- they are the cells already pinned/used
# elsewhere in this map (bytoken.ITEM_TABLE_WOOD/_METAL/_GLASS and
# matvariants.Table.WOOD/METAL/GLASS all already resolve to item_table.png
# (0,0)/(0,2)/(0,3) respectively, straight off graphics_items.txt). The leg
# overlay is material-agnostic (an authored detail token, not tinted per
# material) so compositing it onto each base is mechanical, not a new
# adjudication. STONE stays at composite cell (0,0) so existing pins
# (TX10, choices-20260710T201628Z) remain valid; WOOD/METAL/GLASS get new rows
# on the same generated sheet.
TABLE_COMPOSITE_SHEET = "item_table_composite.png"
TABLE_COMPOSITE_OUT = os.path.join(REPO, "web", TABLE_COMPOSITE_SHEET)
TABLE_COMPOSITE_LEGS = (7, 0)   # item_table.png (col,row): ITEM_TABLE_LEG_VARIANT overlay
# material -> bare tabletop base cell on item_table.png (col,row). Must match
# bytoken.ITEM_TABLE_<mat> / matvariants.Table.<mat> exactly -- guarded below.
TABLE_MATERIAL_BASES = {
    "STONE": (0, 1),
    "WOOD": (0, 0),
    "METAL": (0, 2),
    "GLASS": (0, 3),
}
# material -> row on the generated item_table_composite.png sheet (1 col wide).
# STONE MUST stay row 0 (existing pins point at composite cell (0,0)).
TABLE_COMPOSITE_ROW = {"STONE": 0, "WOOD": 1, "METAL": 2, "GLASS": 3}

# B183 (chairs): item_chair.png is byte-for-byte the same LAYOUT as item_table.png --
# generic ITEM_CHAIR @ (0,1), per-material bases WOOD(0,0)/STONE(0,1)/METAL(0,2)/
# GLASS(0,3), and an authored ITEM_CHAIR_LEG_VARIANT overlay at (7,0)..(7,3)
# (graphics_items.txt lines 281-313, verified this wave; (7,0) has 104 opaque px).
# The prior table fixes never baked a chair composite at all, so PLACED and loose
# chairs both rendered the legless base. Same mechanical leg-overlay bake as tables,
# onto the same pre-pinned base cells -- not a new adjudication.
CHAIR_COMPOSITE_SHEET = "item_chair_composite.png"
CHAIR_COMPOSITE_OUT = os.path.join(REPO, "web", CHAIR_COMPOSITE_SHEET)
CHAIR_COMPOSITE_LEGS = (7, 0)   # item_chair.png (col,row): ITEM_CHAIR_LEG_VARIANT:1 overlay
CHAIR_MATERIAL_BASES = {
    "STONE": (0, 1),
    "WOOD": (0, 0),
    "METAL": (0, 2),
    "GLASS": (0, 3),
}
CHAIR_COMPOSITE_ROW = {"STONE": 0, "WOOD": 1, "METAL": 2, "GLASS": 3}

# Shared registry so the leg-composite mapping lives in ONE place -- both this
# generator AND build_building_map.py import LEG_COMPOSITE_FAMILIES / the redirect
# helpers below, instead of each hard-coding the base/row constants. Adding a new
# legged furniture family = one entry here + wiring its map keys; the bake, the
# guard, and the cross-generator consistency all follow automatically.
LEG_COMPOSITE_FAMILIES = {
    "Table": {"src": "item_table.png", "sheet": TABLE_COMPOSITE_SHEET, "out": TABLE_COMPOSITE_OUT,
              "legs": TABLE_COMPOSITE_LEGS, "bases": TABLE_MATERIAL_BASES, "rows": TABLE_COMPOSITE_ROW},
    "Chair": {"src": "item_chair.png", "sheet": CHAIR_COMPOSITE_SHEET, "out": CHAIR_COMPOSITE_OUT,
              "legs": CHAIR_COMPOSITE_LEGS, "bases": CHAIR_MATERIAL_BASES, "rows": CHAIR_COMPOSITE_ROW},
}


def leg_composite_bare_base_cell(family, mat):
    """The BARE (legless) base cell a given family/material resolves to BEFORE the
    leg-overlay redirect -- used as the guard target so a raws-layout drift fails
    loudly in either generator instead of compositing the wrong art."""
    spec = LEG_COMPOSITE_FAMILIES[family]
    col, row = spec["bases"][mat]
    return {"sheet": spec["src"], "col": col, "row": row}


def leg_composite_cell(family, mat):
    """The baked base+legs composite cell (1-col sheet, one row per material)."""
    spec = LEG_COMPOSITE_FAMILIES[family]
    return {"sheet": spec["sheet"], "col": 0, "row": spec["rows"][mat]}


def redirect_to_leg_composite(container, key, family, mat):
    """Repoint container[key] from the bare base cell to the family's baked
    composite, asserting the pre-redirect bare cell first. Shared by both
    generators so the table/chair redirect logic is identical, not copy-pasted."""
    bare = leg_composite_bare_base_cell(family, mat)
    cur = container.get(key)
    if cur != bare:
        raise SystemExit("leg composite %s: expected %s to be the bare %s base %s, "
                         "got %r (raws changed?)" % (family, key, mat, bare, cur))
    container[key] = leg_composite_cell(family, mat)

# "Plain" [TAG:PAGE:col:row:TOKEN(:extra...)] tags -- all verified this session
# to share the exact grammar TILE_GRAPHICS uses (grep counts: TOOL_GRAPHICS 30,
# ARMOR_GRAPHICS 12, HELM_GRAPHICS 8, GLOVES_GRAPHICS 3, PANTS_GRAPHICS 9,
# SHOES_GRAPHICS 6, SHIELD_GRAPHICS 2, TOY_GRAPHICS 20, TRAPCOMP_GRAPHICS 5,
# FOOD_GRAPHICS 3 top-level lines in graphics_items.txt).
PLAIN_TOKEN_TAGS = {
    "TILE_GRAPHICS", "TOOL_GRAPHICS", "ARMOR_GRAPHICS", "HELM_GRAPHICS",
    "GLOVES_GRAPHICS", "PANTS_GRAPHICS", "SHOES_GRAPHICS", "SHIELD_GRAPHICS",
    "TOY_GRAPHICS", "TRAPCOMP_GRAPHICS", "FOOD_GRAPHICS",
}

# "Block" [TAG:TOKEN] header + indented [TAG_DEFAULT:PAGE:col:row] sub-cell
# tags -- verified: WEAPON_GRAPHICS (25 blocks), AMMO_GRAPHICS, SIEGEAMMO_GRAPHICS.
BLOCK_TAGS = {"WEAPON_GRAPHICS", "AMMO_GRAPHICS", "SIEGEAMMO_GRAPHICS"}

# item_type -> representative TOKEN, hand-picked by reading the raws (every
# entry verified to exist as a real [*_GRAPHICS:...:TOKEN] binding in main()).
# Types not listed here have no standalone ground-item cell in vanilla's
# graphics raws at all (see UNMAPPABLE_ITEM_TYPES below) and fall to `_default`.
#
#   item_type              : TOKEN                          # rationale
TOKEN_FOR_ITEM_TYPE = {
    "BAR":              "ITEM_BARS",
    "BLOCKS":           "ITEM_BLOCKS",
    "ROUGH":            "ITEM_ROUGH_GEM",
    "BOULDER":          "ITEM_BOULDER",
    "WOOD":             "ITEM_WOOD",
    "DOOR":             "ITEM_DOOR_WOOD",             # matvariants also covers this base
    "FLOODGATE":        "ITEM_FLOODGATE_WOOD",
    "BED":              "ITEM_BED",                   # generic cell (matvariants has materials)
    "CHAIR":            "ITEM_CHAIR",                 # generic cell
    "CHAIN":            "ITEM_CHAIN_ROPE",
    "FLASK":            "ITEM_FLASK_LEATHER",
    "GOBLET":           "ITEM_GOBLET_WOOD",
    "INSTRUMENT":       "ITEM_GENERATED_TOOL",        # raw comment: "usually instrument pieces for now"
    "TOY":              "ITEM_TOY",                   # raw comment: generic icon if raw object unknown
    "WINDOW":           "ITEM_WINDOW_GLASS",
    "CAGE":             "ITEM_CAGE_WOOD",
    "BARREL":           "ITEM_BARREL_WOOD_EMPTY",
    "BUCKET":           "ITEM_BUCKET",
    "ANIMALTRAP":       "ITEM_ANIMAL_TRAP_WOOD",
    "TABLE":            "ITEM_TABLE",                  # generic cell
    "COFFIN":           "ITEM_COFFIN",                 # generic cell
    "STATUE":           "ITEM_STATUE_ITEM",
    "SHOES":            "ITEM_SHOES_SHOES",
    "SHIELD":           "ITEM_SHIELD_SHIELD",
    "HELM":             "ITEM_HELM_HELM",
    "GLOVES":           "ITEM_GLOVES_GLOVES",
    "BOX":              "ITEM_BOX",
    "BAG":              "ITEM_BAG",
    "BIN":              "ITEM_BIN",
    "ARMORSTAND":       "ITEM_ARMOR_STAND_WOOD_EMPTY",
    "WEAPONRACK":       "ITEM_WEAPON_RACK_WOOD_EMPTY",
    "CABINET":          "ITEM_CABINET",                # generic cell
    "FIGURINE":         "ITEM_FIGURINE_METAL",
    "AMULET":           "ITEM_AMULET_METAL",
    "SCEPTER":          "ITEM_SCEPTER_METAL",
    "AMMO":             "ITEM_AMMO",                   # raw comment: generic icon if raw object unknown
    "CROWN":            "ITEM_CROWN_METAL",
    "RING":             "ITEM_RING_METAL",
    "EARRING":          "ITEM_EARRING_METAL",
    "BRACELET":         "ITEM_BRACELET_METAL",
    "SMALLGEM":         "ITEM_ROUGH_GEM",              # no dedicated cut-gem cell; closest available gem icon
    "GEM":              "ITEM_ROUGH_GEM",              # no dedicated large-gem cell; same proxy
    "ANVIL":            "ITEM_ANVIL",
    "CORPSEPIECE":      "ITEM_REMAINS",                # closest match -- see _corpse_fallback note
    "REMAINS":          "ITEM_REMAINS",
    "SKIN_TANNED":      "ITEM_TANNED_SKIN",
    "THREAD":           "ITEM_THREAD",
    "CLOTH":            "ITEM_CLOTH",
    "TOTEM":            "ITEM_TOTEM",
    "PANTS":            "ITEM_PANTS_PANTS",
    "BACKPACK":         "ITEM_BACKPACK",
    "QUIVER":           "ITEM_QUIVER",
    "CATAPULTPARTS":    "ITEM_CATAPULT_PARTS",
    "BALLISTAPARTS":    "ITEM_BALLISTA_PARTS",
    "SIEGEAMMO":        "ITEM_SIEGEAMMO_BALLISTA",     # block-form; resolved via bytoken's _DEFAULT cell
    "BALLISTAARROWHEAD":"ITEM_BALLISTA_ARROWHEAD",
    "TRAPPARTS":        "ITEM_MECHANISMS",             # item_type caption: "mechanism"
    "TRAPCOMP":         "ITEM_TRAPCOMP_GIANTAXEBLADE",
    "DRINK":            "ITEM_LIQUID",                 # closest match; DF has no standalone drink cell
    "LIQUID_MISC":      "ITEM_LIQUID",                 # same proxy (water/lye/extracts)
    "POWDER_MISC":      "ITEM_POWDER",
    "CHEESE":           "ITEM_CHEESE",
    "FOOD":             "ITEM_PREPARED_MEAL",          # raw comment: generic icon if raw object unknown
    "COIN":             "ITEM_COINS_SINGLE",
    "ROCK":             "ITEM_ROCK",
    "PIPE_SECTION":     "ITEM_PIPE_SECTION",
    "HATCH_COVER":      "ITEM_HATCH_COVER_WOOD",
    "GRATE":            "ITEM_GRATE_WOOD",
    "QUERN":            "ITEM_QUERN",
    "MILLSTONE":        "ITEM_MILLSTONE",
    "SPLINT":           "ITEM_SPLINT",
    "CRUTCH":           "ITEM_CRUTCH",
    "TRACTION_BENCH":   "ITEM_TRACTION_BENCH_WOODEN_CHAIN",
    "ORTHOPEDIC_CAST":  "ITEM_ORTHOPEDIC_CAST",
    "TOOL":             "ITEM_TOOL",                   # raw comment: generic icon, very broad category
    "SLAB":             "ITEM_SLAB_BLANK",
    "BOOK":             "ITEM_BOOK_WOOD",
    "SHEET":            "ITEM_SHEET",
    "BRANCH":           "ITEM_BRANCH",
    "BOLT_THROWER_PARTS": "ITEM_BOLT_THROWER_PARTS",
    # EGG: pick SIZE2 as the task directs ("pick SIZE2 default").
    "EGG":              "ITEM_EGG_SIZE2",
}

# item_types with NO standalone ground-item cell in the item graphics raws
# (verified by direct search of graphics_items.txt/_containers.txt this
# session -- only bin-lid/barrel-lid/bag-content OVERLAY cells exist for these,
# e.g. ITEM_BARREL_TOP_MEAT, ITEM_BARREL_TOP_FISH, ITEM_BIN_TOP_GEMS,
# SEEDS_FOR_BAG -- none of which are a ground-tile item sprite), plus the
# subtype-dependent equipment categories (WEAPON/ARMOR -- picking any single
# representative cell for these would misrepresent wildly different raw
# shapes; the correct resolution is via `bytoken` + the item's subtype, which
# is WC-3's job) and the creature/vermin/pet-keyed types (deferred, see notes).
# (PLANT/PLANT_GROWTH and TX13's MEAT are NOT in this list -- they are mapped from
# their respective plant/bodypart graphics raws and added to `bytype` below.)
UNMAPPABLE_ITEM_TYPES = [
    "NONE",       # sentinel, not a real item
    "WEAPON",     # subtype-specific; resolve via bytoken (needs raw token from subtype)
    "ARMOR",      # subtype-specific; resolve via bytoken
    "CORPSE",     # creature-keyed; see _corpse_fallback (NEEDS-SCOUT -> W-E)
    "FISH",       # no standalone cell (only ITEM_BARREL_TOP_FISH lid overlay)
    "FISH_RAW",   # no standalone cell
    "VERMIN",     # creature-keyed; full read+art deferred to WC-21
    "PET",        # creature-keyed; deferred to W-E
    "SEEDS",      # no standalone cell (only SEEDS_FOR_BAG bag-content overlay)
]

# Furniture-as-item bases with a uniform _WOOD/_STONE/_METAL/_GLASS TOKEN
# suffix (verified). Shared by ground-item draw (WC-3) and building furniture
# reuse (WC-5). ITEM_SLAB_BLANK/ITEM_STATUE_ITEM are deliberately excluded --
# they carry no material suffix (slab has ENGRAVED_* *state* variants instead,
# already reachable via `bytoken`; statue art is single-cell).
MATVARIANT_BASES = {
    "Door":        "ITEM_DOOR_{}",
    "Bed":         "ITEM_BED_{}",
    "Table":       "ITEM_TABLE_{}",
    "Chair":       "ITEM_CHAIR_{}",
    "Cabinet":     "ITEM_CABINET_{}",
    "Box":         "ITEM_BOX_{}",
    "HatchCover":  "ITEM_HATCH_COVER_{}",
    "Grate":       "ITEM_GRATE_{}",
}
MATERIALS = ["WOOD", "STONE", "METAL", "GLASS"]

# ITEM_WEB_HARMLESS:1..4 / ITEM_WEB_THICK:1..4 (graphics_items.txt L491-498).
WEB_TOKENS = {
    "harmless": ["ITEM_WEB_HARMLESS"] * 1,  # variant index carried via extra field 1..4
    "thick": ["ITEM_WEB_THICK"] * 1,
}

DEFAULT_TOKEN = "ITEM_BOX"  # last-resort default cell (kept from v1)

# v3: the 10 ITEM_ROUGH_GEM_VALUE_<N> tiers, ascending (graphics_items.txt:11-20).
# A material's rough-gem cell = the highest tier whose min_value <= MATERIAL_VALUE.
ROUGH_GEM_VALUE_TIERS = [2, 3, 5, 10, 15, 20, 25, 30, 40, 60]

# TX13: df::material.meat_organ selects these vanilla-authored cells. The aliases are
# semantic token joins, not hand-picked coordinates: STOMACH is named TRIPE in the art raw,
# and PANCREAS is named SWEETBREAD (matching their MATERIAL_TEMPLATE MEAT_NAME values).
FOOD_KIND_TO_BODYPART_TOKEN = {
    "GLOB:FAT": "BODYPART_FAT",
    "MEAT:STANDARD": "BODYPART_MEAT",
    "MEAT:EYE": "BODYPART_EYE",
    "MEAT:LUNG": "BODYPART_LUNG",
    "MEAT:HEART": "BODYPART_HEART",
    "MEAT:INTESTINES": "BODYPART_INTESTINES",
    "MEAT:LIVER": "BODYPART_LIVER",
    "MEAT:STOMACH": "BODYPART_TRIPE",
    "MEAT:PANCREAS": "BODYPART_SWEETBREAD",
    "MEAT:SPLEEN": "BODYPART_SPLEEN",
    "MEAT:KIDNEY": "BODYPART_KIDNEY",
    "MEAT:BRAIN": "BODYPART_BRAIN",
    "MEAT:GIZZARD": "BODYPART_GIZZARD",
}


# Native item|HATCH_COVER evidence (range-native-20260709T160835Z) shows the browser's
# old family cell collapse: it drew only ITEM_HATCH_COVER_{WOOD,STONE,METAL,GLASS}, while
# native composes that material base with one of the transparent ITEM_HATCH_COVER_VARIANT
# detail cells. Keep the fix scoped to the owner-adjudicated hatch materials; IRON is deliberately
# omitted as the weak-fine control from the same deck, so it still resolves through the old
# matvariants.HatchCover.METAL path.
HATCH_FAMILY_ROW = {"WOOD": 0, "STONE": 1, "METAL": 2, "GLASS": 3}
HATCH_VARIANT_ROW = {"FOUR": 0, "TWO": 1, "WIDE": 2, "OFFSET": 3}
HATCH_COVER_FIXUPS = {
    # Vanilla/common metals and alloys.
    "ELECTRUM": ("METAL", "FOUR"),
    "TIN": ("METAL", "FOUR"),
    "PEWTER_FINE": ("METAL", "FOUR"),
    "PEWTER_TRIFLE": ("METAL", "TWO"),
    "PEWTER_LAY": ("METAL", "WIDE"),
    "LEAD": ("METAL", "TWO"),
    "ALUMINUM": ("METAL", "TWO"),
    "NICKEL_SILVER": ("METAL", "FOUR"),
    "BILLON": ("METAL", "FOUR"),
    "STERLING_SILVER": ("METAL", "FOUR"),
    "BLACK_BRONZE": ("METAL", "TWO"),
    "ROSE_GOLD": ("METAL", "TWO"),
    "BISMUTH": ("METAL", "FOUR"),
    "BISMUTH_BRONZE": ("METAL", "FOUR"),
    "ADAMANTINE": ("METAL", "TWO"),
    "COPPER": ("METAL", "TWO"),
    "SILVER": ("METAL", "FOUR"),
    "GOLD": ("METAL", "FOUR"),
    "NICKEL": ("METAL", "FOUR"),
    "ZINC": ("METAL", "FOUR"),
    "BRONZE": ("METAL", "FOUR"),
    "BRASS": ("METAL", "TWO"),
    "STEEL": ("METAL", "FOUR"),
    "PIG_IRON": ("METAL", "FOUR"),
    # Stones from the deck use the stone family base plus the same native detail overlay.
    "MICROCLINE": ("STONE", "FOUR"),
    "ORTHOCLASE": ("STONE", "FOUR"),
    "MARBLE": ("STONE", "FOUR"),
    # Generated/material-token-only inorganics are absent from material_map.json but present on
    # the wire as identKind=3, so the JS resolver can still select their native model cell.
    "DIVINE_1": ("METAL", "TWO"),
    "DIVINE_3": ("METAL", "FOUR"),
    "DIVINE_5": ("METAL", "TWO"),
    "DIVINE_7": ("METAL", "FOUR"),
    "DIVINE_9": ("METAL", "FOUR"),
    "DIVINE_11": ("METAL", "TWO"),
    "DIVINE_13": ("METAL", "WIDE"),
    "DIVINE_15": ("METAL", "TWO"),
    "DIVINE_17": ("METAL", "FOUR"),
    "DIVINE_19": ("METAL", "TWO"),
    "MYTHICAL_REMNANT_1": ("METAL", "WIDE"),
    # Plant material keys match the review ident suffix and the resolver's plant identity key.
    "PLANT_MAT:OAK:WOOD": ("WOOD", "FOUR"),
    "PLANT_MAT:WILLOW:WOOD": ("WOOD", "FOUR"),
    "PLANT_MAT:MANGROVE:WOOD": ("WOOD", "TWO"),
    "PLANT_MAT:FEATHER:WOOD": ("WOOD", "FOUR"),
}


def _is_int(s):
    try:
        int(s)
        return True
    except ValueError:
        return False


def load_tile_page_records(gfx_dir, fname):
    """Parse TILE_PAGE records, including native cell/page geometry when present."""
    path = os.path.join(gfx_dir, fname)
    records = {}
    cur = None
    page_re = re.compile(r"\[TILE_PAGE:([A-Za-z0-9_]+)\]")
    file_re = re.compile(r"\[FILE:images[/\\]([^\]]+)\]")
    tile_dim_re = re.compile(r"\[TILE_DIM:(\d+):(\d+)\]")
    page_dim_re = re.compile(r"\[PAGE_DIM_PIXELS:(\d+):(\d+)\]")
    with open(path, "r", encoding="latin-1") as fh:
        for ln in fh:
            m = page_re.search(ln)
            if m:
                cur = {"page": m.group(1), "sheet": None, "cell_w": 32, "cell_h": 32,
                       "page_w": None, "page_h": None}
                records[cur["page"]] = cur
                continue
            if cur is None:
                continue
            m = file_re.search(ln)
            if m:
                cur["sheet"] = m.group(1)
                continue
            m = tile_dim_re.search(ln)
            if m:
                cur["cell_w"] = int(m.group(1)); cur["cell_h"] = int(m.group(2))
                continue
            m = page_dim_re.search(ln)
            if m:
                cur["page_w"] = int(m.group(1)); cur["page_h"] = int(m.group(2))
                continue
    return records


def load_tile_pages(gfx_dir, fname):
    """[TILE_PAGE:NAME] -> png basename, generic across all *_tile_page*.txt files."""
    return {k: v["sheet"] for k, v in load_tile_page_records(gfx_dir, fname).items() if v.get("sheet")}


def sheet_geometry_from_records(records):
    """Return sheet geometry keyed by image basename for non-default tile pages."""
    out = {}
    for rec in records.values():
        sheet = rec.get("sheet")
        if not sheet:
            continue
        cell_w = int(rec.get("cell_w") or 32)
        cell_h = int(rec.get("cell_h") or 32)
        page_w = rec.get("page_w")
        page_h = rec.get("page_h")
        if cell_w != 32 or cell_h != 32 or page_w or page_h:
            ent = {"cell_w": cell_w, "cell_h": cell_h}
            if page_w: ent["page_w"] = int(page_w)
            if page_h: ent["page_h"] = int(page_h)
            out[sheet] = ent
    return out


def validate_raw_cell(raw, records, source_desc):
    if raw is None:
        return
    page, col, row = raw
    rec = records.get(page)
    if not rec:
        return
    cell_w = int(rec.get("cell_w") or 32)
    cell_h = int(rec.get("cell_h") or 32)
    page_w = rec.get("page_w")
    page_h = rec.get("page_h")
    if page_w is None or page_h is None:
        return
    cols = int(page_w) // cell_w if cell_w > 0 else 0
    rows = int(page_h) // cell_h if cell_h > 0 else 0
    if cols <= 0 or rows <= 0 or col < 0 or row < 0 or col >= cols or row >= rows:
        raise SystemExit("%s references %s:%d:%d outside declared page geometry %dx%d cells "
                         "(%dx%d px / %dx%d cell)"
                         % (source_desc, page, col, row, cols, rows,
                            int(page_w), int(page_h), cell_w, cell_h))


def load_item_tokens():
    """Parse every plain-form + block-form *_GRAPHICS line in graphics_items.txt
    and graphics_containers.txt -> {TOKEN: (page, col, row)}, first-binding-wins.
    Also returns the count of block headers seen (for the report)."""
    tokens = {}
    n_blocks = 0
    for fname in ITEM_GFX_FILES:
        path = os.path.join(ITEMS_GFX, fname)
        lines = open(path, "r", encoding="latin-1").read().splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            i += 1
            if not (line.startswith("[") and "]" in line):
                continue
            inner = line[1:line.index("]")]
            parts = inner.split(":")
            tag = parts[0]
            fields = parts[1:]

            if tag in BLOCK_TAGS and len(fields) == 1:
                # [TAG:TOKEN] header -- scan following indented lines for the
                # sibling TAG_DEFAULT sub-cell (or, failing that, the first
                # sub-cell of any kind) until the next non-indented line.
                token = fields[0]
                n_blocks += 1
                default_cell = None
                first_cell = None
                j = i
                while j < len(lines) and lines[j].startswith(("\t", " ")):
                    sub = lines[j].strip()
                    j += 1
                    if not (sub.startswith("[") and "]" in sub):
                        continue
                    sub_inner = sub[1:sub.index("]")]
                    sub_parts = sub_inner.split(":")
                    sub_tag = sub_parts[0]
                    sub_fields = sub_parts[1:]
                    if len(sub_fields) < 3:
                        continue
                    page, col, row = sub_fields[0], sub_fields[1], sub_fields[2]
                    if not (_is_int(col) and _is_int(row)):
                        continue
                    cell = (page, int(col), int(row))
                    if first_cell is None:
                        first_cell = cell
                    if sub_tag == tag + "_DEFAULT":
                        default_cell = cell
                if token not in tokens:
                    tokens[token] = default_cell or first_cell
                continue

            if tag in PLAIN_TOKEN_TAGS and len(fields) >= 4:
                page, col, row, token = fields[0], fields[1], fields[2], fields[3]
                if not (_is_int(col) and _is_int(row)):
                    continue
                if token not in tokens:
                    tokens[token] = (page, int(col), int(row))
    return tokens, n_blocks


def load_plant_item_tokens():
    """ITEM_PLANT / ITEM_PLANT_GROWTH / ITEM_ROTTEN_PLANT from
    graphics_plants.txt (PLANTS page) -- these already ship in the runtime
    spriteMap (src/sprite_map.cpp parses vanilla_plants_graphics/graphics
    directly); mirrored here so item_map has a single uniform lookup surface."""
    path = os.path.join(PLANTS_GFX, "graphics_plants.txt")
    tokens = {}
    tg = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):(ITEM_[A-Za-z0-9_]+)\]")
    for ln in open(path, "r", encoding="latin-1"):
        m = tg.match(ln.strip())
        if not m:
            continue
        page, col, row, token = m.groups()
        if token not in tokens:
            tokens[token] = (page, int(col), int(row))
    return tokens


# ---------------------------------------------------------------------------
# v3 (T1b) parsers -- all return raw (page, col, row) tuples (same shape the v2
# token dicts use); main() resolves page->sheet via the shared cell builder so
# sheets_used and the {sheet,col,row} JSON shape stay identical to v2's cells.
# ---------------------------------------------------------------------------

def load_gem_shapes():
    """Parse vanilla_descriptors_graphics/graphics/graphics_shapes.txt.

    Returns (gem_shapes_raw, gem_default_raw, smallgem_default_raw):
      gem_shapes_raw:      {CUT_TOKEN: {"small": (page,col,row), "large": (page,col,row)}}
      gem_default_raw:     (page,col,row) for ITEM_GEMS   (cut-large fallback, GEMS:0:0)
      smallgem_default_raw:(page,col,row) SMALLGEMS:0:0   (no dedicated token in raws;
                           spec §1.1/§2.2 pins the SMALLGEMS sheet's 0:0 cell as the
                           shape==-1 small-gem fallback -- constructed from the SMALLGEMS
                           TILE_PAGE the small-cut rows reference).
    """
    path = os.path.join(DESCRIPTORS_GFX, "graphics_shapes.txt")
    shapes = {}
    gem_default = None
    smallgem_page = None
    large_re = re.compile(r"\[SHAPE_GRAPHICS_LARGE_GEM:([A-Za-z0-9_]+):([A-Za-z0-9_]+):(\d+):(\d+)\]")
    small_re = re.compile(r"\[SHAPE_GRAPHICS_SMALL_GEM:([A-Za-z0-9_]+):([A-Za-z0-9_]+):(\d+):(\d+)\]")
    def_re = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(\d+):(\d+):(ITEM_GEMS|ITEM_LARGE_GEM)\]")
    for ln in open(path, "r", encoding="latin-1"):
        s = ln.strip()
        m = large_re.match(s)
        if m:
            cut, page, col, row = m.groups()
            shapes.setdefault(cut, {})["large"] = (page, int(col), int(row))
            continue
        m = small_re.match(s)
        if m:
            cut, page, col, row = m.groups()
            shapes.setdefault(cut, {})["small"] = (page, int(col), int(row))
            smallgem_page = page
            continue
        m = def_re.match(s)
        if m:
            page, col, row, token = m.groups()
            if token == "ITEM_GEMS" and gem_default is None:
                gem_default = (page, int(col), int(row))
    smallgem_default = (smallgem_page, 0, 0) if smallgem_page else None
    return shapes, gem_default, smallgem_default



def build_hatch_composite_sheet():
    """Generate 4 material-family rows x 4 native detail variants for hatch-cover items.

    The source cells are all vanilla-authored on item_hatch.png: base material cells at col 1,
    rows 0..3, plus transparent detail overlays at col 8, rows 0..3. The generated sheet is
    served by /sprites/img from the web root, same as animal_people_flat.png.
    """
    src = os.path.join(ITEMS_GFX, "images", "item_hatch.png")
    im = Image.open(src).convert("RGBA")
    out = Image.new("RGBA", (len(HATCH_VARIANT_ROW) * 32, len(HATCH_FAMILY_ROW) * 32), (0, 0, 0, 0))
    for family, row in HATCH_FAMILY_ROW.items():
        base = im.crop((1 * 32, row * 32, 2 * 32, (row + 1) * 32))
        for variant, vrow in HATCH_VARIANT_ROW.items():
            cell = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
            cell.alpha_composite(base)
            overlay = im.crop((8 * 32, vrow * 32, 9 * 32, (vrow + 1) * 32))
            cell.alpha_composite(overlay)
            out.alpha_composite(cell, (HATCH_VARIANT_ROW[variant] * 32, row * 32))
    os.makedirs(os.path.dirname(HATCH_COMPOSITE_OUT), exist_ok=True)
    out.save(HATCH_COMPOSITE_OUT)


def bake_leg_composite_sheet(family):
    """Bake ONE furniture family's leg composite: for every material with a known
    bare base cell, alpha-composite that base under the single material-agnostic
    leg-variant overlay, and stack the results as rows on a 1-col sheet (STONE
    pinned at row 0 so existing pins stay valid). Generic over Table/Chair (and any
    future legged family in LEG_COMPOSITE_FAMILIES) -- the per-family src png, legs
    cell, bases, and rows all come from the registry, so the bake is defined once.
    The generated sheet is served from the web root, same as item_hatch_composite.png."""
    spec = LEG_COMPOSITE_FAMILIES[family]
    src = os.path.join(ITEMS_GFX, "images", spec["src"])
    im = Image.open(src).convert("RGBA")
    lc, lr = spec["legs"]
    legs = im.crop((lc * 32, lr * 32, (lc + 1) * 32, (lr + 1) * 32))
    rows = spec["rows"]
    bases = spec["bases"]
    out = Image.new("RGBA", (32, len(rows) * 32), (0, 0, 0, 0))
    for mat, row in rows.items():
        bc, br = bases[mat]
        base = im.crop((bc * 32, br * 32, (bc + 1) * 32, (br + 1) * 32))
        cell = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        cell.alpha_composite(base)
        cell.alpha_composite(legs)
        out.alpha_composite(cell, (0, row * 32))
    os.makedirs(os.path.dirname(spec["out"]), exist_ok=True)
    out.save(spec["out"])


def load_special_item_graphics():
    """Parse graphics_items.txt for the v3 value-tier / glass / boulder / bar rows.

    Returns (rough_gem_tiers_raw, rough_gem_glass_raw, boulder_bymat_raw, bar_bymat_raw):
      rough_gem_tiers_raw: {min_value:int -> (page,col,row)} for ITEM_ROUGH_GEM_VALUE_<N>
      rough_gem_glass_raw: {"GLASS_GREEN"/"GLASS_CLEAR"/"GLASS_CRYSTAL" -> (page,col,row)}
      boulder_bymat_raw:   {INORGANIC_ID -> (page,col,row)} (first binding wins)
      bar_bymat_raw:       {"POTASH"/"PEARLASH"/"COAL:COKE"/"COAL:CHARCOAL"/"SOAP" -> (page,col,row)}
    """
    path = os.path.join(ITEMS_GFX, "graphics_items.txt")
    tiers = {}
    glass = {}
    boulder = {}
    bar = {}
    # value tiers use the plain TILE_GRAPHICS tag in vanilla (graphics_items.txt:11-20);
    # match on the ITEM_ROUGH_GEM_VALUE_<N> token regardless of the leading tag.
    tier_re = re.compile(r"\[[A-Z_]+:([A-Za-z0-9_]+):(\d+):(\d+):ITEM_ROUGH_GEM_VALUE_(\d+)\]")
    glass_re = re.compile(r"\[ROUGH_GEM_GRAPHICS:([A-Za-z0-9_]+):(\d+):(\d+):(GLASS_[A-Z]+)\]")
    boulder_re = re.compile(r"\[BOULDER_GRAPHICS:([A-Za-z0-9_]+):(\d+):(\d+):INORGANIC:([A-Za-z0-9_]+)\]")
    bars_re = re.compile(r"\[BARS_GRAPHICS:([A-Za-z0-9_]+):(\d+):(\d+):(.+)\]")
    soap_re = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(\d+):(\d+):ITEM_BARS_SOAP\]")
    for ln in open(path, "r", encoding="latin-1"):
        s = ln.strip()
        m = tier_re.match(s)
        if m:
            page, col, row, n = m.groups()
            tiers[int(n)] = (page, int(col), int(row))
            continue
        m = glass_re.match(s)
        if m:
            page, col, row, tok = m.groups()
            glass[tok] = (page, int(col), int(row))
            continue
        m = boulder_re.match(s)
        if m:
            page, col, row, iid = m.groups()
            if iid not in boulder:
                boulder[iid] = (page, int(col), int(row))
            continue
        m = bars_re.match(s)
        if m:
            page, col, row, key = m.groups()
            if key not in bar:
                bar[key] = (page, int(col), int(row))
            continue
        m = soap_re.match(s)
        if m:
            page, col, row = m.groups()
            bar.setdefault("SOAP", (page, int(col), int(row)))
    return tiers, glass, boulder, bar


def _raw_tags(path):
    """Yield (tag, fields) for every bracketed raw token in a latin-1 file."""
    token_re = re.compile(r"\[([A-Z0-9_]+)(?::([^\]]*))?\]")
    for line in open(path, "r", encoding="latin-1"):
        for match in token_re.finditer(line):
            yield match.group(1), (match.group(2) or "").split(":")


def load_food_material_templates():
    """Return MATERIAL_TEMPLATE -> item/category key from the material raws.

    MEAT_CATEGORY is DF's own texture selector. FAT is the one butcher-produced GLOB
    template with authored body-part art. Other material templates are deliberately absent.
    """
    path = os.path.join(MATERIALS_OBJECTS, "material_template_default.txt")
    templates = {}
    cur = None
    butcher_type = None
    meat_category = None

    def finish():
        if not cur or not butcher_type:
            return
        if butcher_type == "MEAT" and meat_category:
            templates[cur] = "MEAT:" + meat_category
        elif butcher_type == "GLOB" and cur == "FAT_TEMPLATE":
            templates[cur] = "GLOB:FAT"

    for tag, fields in _raw_tags(path):
        if tag == "MATERIAL_TEMPLATE":
            finish()
            cur = fields[0] if fields else None
            butcher_type = None
            meat_category = None
        elif cur and tag == "BUTCHER_SPECIAL" and fields:
            butcher_type = fields[0]
        elif cur and tag == "MEAT_CATEGORY" and fields:
            meat_category = fields[0]
    finish()
    return templates


def load_bodypart_food_tokens():
    """Parse graphics_bodyparts.txt -> authored food-kind raw cells."""
    path = os.path.join(CREATURES_GFX, "graphics_bodyparts.txt")
    raw_tokens = {}
    token_re = re.compile(
        r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(-?\d+):(-?\d+):(BODYPART_[A-Za-z0-9_]+)\]")
    for line in open(path, "r", encoding="latin-1"):
        match = token_re.search(line)
        if match:
            page, col, row, token = match.groups()
            raw_tokens.setdefault(token, (page, int(col), int(row)))
    found = {}
    missing = []
    for food_kind, token in FOOD_KIND_TO_BODYPART_TOKEN.items():
        if token in raw_tokens:
            found[food_kind] = raw_tokens[token]
        else:
            missing.append(food_kind)
    return found, missing


def load_material_plans():
    """Parse BODY_DETAIL_PLAN ADD_MATERIAL expansions used by creature raws."""
    plans = {}
    for fname in sorted(os.listdir(BODIES_OBJECTS)):
        if not fname.endswith(".txt"):
            continue
        cur = None
        for tag, fields in _raw_tags(os.path.join(BODIES_OBJECTS, fname)):
            if tag == "BODY_DETAIL_PLAN":
                cur = fields[0] if fields else None
                if cur:
                    plans.setdefault(cur, [])
            elif cur and tag == "ADD_MATERIAL" and len(fields) >= 2:
                plans[cur].append((fields[0], fields[1]))
    return plans


def load_creature_food_materials(food_templates, plans):
    """Resolve vanilla creature local-material slots to authored food kinds.

    Creature materials ride the wire as mat_type=19+local_slot and mat_index=race. We
    reproduce the raw material-vector operations that affect those slots: plan expansion,
    USE_MATERIAL_TEMPLATE, REMOVE_MATERIAL, and COPY_TAGS_FROM inheritance. Unknown material
    sources still occupy a slot, preventing a later known food material from being shifted.
    """
    operations = {}
    cur = None
    for fname in sorted(os.listdir(CREATURES_OBJECTS)):
        if not fname.endswith(".txt"):
            continue
        for tag, fields in _raw_tags(os.path.join(CREATURES_OBJECTS, fname)):
            if tag == "CREATURE":
                cur = fields[0] if fields else None
                if cur:
                    operations.setdefault(cur, [])
                continue
            if not cur or not fields:
                continue
            if tag == "COPY_TAGS_FROM":
                operations[cur].append(("copy", fields[0]))
            elif tag == "BODY_DETAIL_PLAN" and fields[0] in plans:
                operations[cur].append(("plan", fields[0]))
            elif tag == "USE_MATERIAL_TEMPLATE" and len(fields) >= 2:
                operations[cur].append(("add", fields[0], fields[1]))
            elif tag in ("USE_MATERIAL", "MATERIAL"):
                # Preserve the local slot even when its source template cannot be inferred.
                operations[cur].append(("add", fields[0], None))
            elif tag == "REMOVE_MATERIAL":
                operations[cur].append(("remove", fields[0]))

    resolved = {}
    resolving = set()
    unresolved = set()

    def material_vector(creature):
        if creature in resolved:
            return list(resolved[creature])
        if creature in resolving:
            unresolved.add(creature)
            return []
        resolving.add(creature)
        mats = []
        for op in operations.get(creature, []):
            if op[0] == "copy":
                parent = op[1]
                if parent not in operations:
                    unresolved.add(creature)
                mats = material_vector(parent)
            elif op[0] == "plan":
                mats.extend(plans[op[1]])
            elif op[0] == "add":
                local_id, template = op[1], op[2]
                # USE_MATERIAL_TEMPLATE replaces a same-id definition in place in DF raws;
                # otherwise it appends a new local material slot.
                replaced = False
                for i, (old_id, _) in enumerate(mats):
                    if old_id == local_id:
                        mats[i] = (local_id, template)
                        replaced = True
                        break
                if not replaced:
                    mats.append((local_id, template))
            elif op[0] == "remove":
                mats = [entry for entry in mats if entry[0] != op[1]]
        resolving.remove(creature)
        resolved[creature] = list(mats)
        return mats

    by_creature = {}
    for creature in sorted(operations):
        slots = {}
        for local_slot, (_, template) in enumerate(material_vector(creature)):
            food_kind = food_templates.get(template)
            if food_kind:
                slots[str(19 + local_slot)] = food_kind
        if slots:
            by_creature[creature] = slots
    return by_creature, sorted(unresolved), len(operations)


def main():
    item_page_records = load_tile_page_records(ITEMS_GFX, ITEM_TILE_PAGE_FILE)
    plant_page_records = load_tile_page_records(PLANTS_GFX, "tile_page_plants.txt")
    defaults_page_records = load_tile_page_records(INTERFACE_GFX, "tile_page_interface.txt")
    descriptor_page_records = load_tile_page_records(DESCRIPTORS_GFX, "tile_page_descriptors.txt")  # v3
    creature_page_records = load_tile_page_records(CREATURES_GFX, "tile_page_creatures.txt")
    item_pages = {k: v["sheet"] for k, v in item_page_records.items() if v.get("sheet")}
    plant_pages = {k: v["sheet"] for k, v in plant_page_records.items() if v.get("sheet")}
    defaults_pages = {k: v["sheet"] for k, v in defaults_page_records.items() if v.get("sheet")}
    descriptor_pages = {k: v["sheet"] for k, v in descriptor_page_records.items() if v.get("sheet")}
    creature_pages = {k: v["sheet"] for k, v in creature_page_records.items() if v.get("sheet")}

    item_tokens, n_blocks = load_item_tokens()
    plant_tokens = load_plant_item_tokens()
    build_hatch_composite_sheet()
    bake_leg_composite_sheet("Table")
    bake_leg_composite_sheet("Chair")

    sheets_used = set()
    sheet_geometry = {}
    sheet_geometry.update(sheet_geometry_from_records(item_page_records))
    sheet_geometry.update(sheet_geometry_from_records(plant_page_records))
    sheet_geometry.update(sheet_geometry_from_records(defaults_page_records))
    sheet_geometry.update(sheet_geometry_from_records(descriptor_page_records))

    def cell_from(token, tokens, pages, source_desc):
        if token not in tokens or tokens[token] is None:
            raise SystemExit("token %r not found (or no cell resolved) in %s "
                              "(raws changed?)" % (token, source_desc))
        page, col, row = tokens[token]
        if page not in pages:
            raise SystemExit("TILE_PAGE %r (for token %r) not found (%s)"
                              % (page, token, source_desc))
        sheet = pages[page]
        sheets_used.add(sheet)
        return {"sheet": sheet, "col": col, "row": row}

    def raw_cell(raw, pages, source_desc):
        """v3: resolve a (page,col,row) tuple -> {sheet,col,row} (same shape/side
        effects as cell_from, but keyed by page tuple rather than a token dict)."""
        if raw is None:
            raise SystemExit("missing cell (%s) -- raws changed?" % source_desc)
        page, col, row = raw
        if pages is descriptor_pages:
            validate_raw_cell(raw, descriptor_page_records, source_desc)
        if page not in pages:
            raise SystemExit("TILE_PAGE %r not found (%s)" % (page, source_desc))
        sheet = pages[page]
        sheets_used.add(sheet)
        return {"sheet": sheet, "col": col, "row": row}

    def item_cell(token):
        return cell_from(token, item_tokens, item_pages, "graphics_items.txt/_containers.txt")

    def plant_cell(token):
        return cell_from(token, plant_tokens, plant_pages, "graphics_plants.txt")

    # ---- bytype ----
    bytype = {}
    for item_type, token in TOKEN_FOR_ITEM_TYPE.items():
        bytype[item_type] = item_cell(token)
    # PLANT / PLANT_GROWTH mirrored from graphics_plants.txt (item 5 of WC-2).
    bytype["PLANT"] = plant_cell("ITEM_PLANT")
    bytype["PLANT_GROWTH"] = plant_cell("ITEM_PLANT_GROWTH")
    bytype["_ROTTEN_PLANT"] = plant_cell("ITEM_ROTTEN_PLANT")  # not its own item_type; noted separately

    # TX13 creature-food cells come from graphics_bodyparts.txt, not graphics_items.txt.
    food_templates = load_food_material_templates()
    food_cells_raw, food_queue = load_bodypart_food_tokens()
    food_queue = sorted(set(food_queue) | (set(food_templates.values()) - set(food_cells_raw)))
    creature_food_cells = {
        kind: raw_cell(raw, creature_pages, "graphics_bodyparts.txt %s" % kind)
        for kind, raw in sorted(food_cells_raw.items())
    }
    # Generic, raws-authored fallbacks preserve a useful sprite for modded/generated creature
    # material layouts that the static vanilla creature map cannot identify.
    bytype["MEAT"] = creature_food_cells["MEAT:STANDARD"]
    bytype["GLOB"] = creature_food_cells["GLOB:FAT"]

    material_plans = load_material_plans()
    creature_food_layouts, unresolved_creatures, creature_count = load_creature_food_materials(
        food_templates, material_plans)
    profile_keys = sorted({tuple(sorted(layout.items())) for layout in creature_food_layouts.values()})
    profile_id = {key: "p%d" % i for i, key in enumerate(profile_keys)}
    creature_food_profiles = {profile_id[key]: dict(key) for key in profile_keys}
    creature_food_bycreature = {
        creature: profile_id[tuple(sorted(layout.items()))]
        for creature, layout in creature_food_layouts.items()
    }

    default_entry = item_cell(DEFAULT_TOKEN)
    bytype["_default"] = default_entry

    # ---- bytoken (every raw token the parser bound a cell to) ----
    bytoken = {}
    for token, (page, col, row) in item_tokens.items():
        if page not in item_pages:
            continue
        sheet = item_pages[page]
        sheets_used.add(sheet)
        bytoken[token] = {"sheet": sheet, "col": col, "row": row}

    # ---- matvariants ----
    matvariants = {}
    for base, pattern in MATVARIANT_BASES.items():
        variants = {}
        for mat in MATERIALS:
            token = pattern.format(mat)
            if token in item_tokens and item_tokens[token] is not None:
                variants[mat] = item_cell(token)
        if variants:
            matvariants[base] = variants

    # ---- TX10/B183: table+chair-with-legs composite, all materials ----
    # Point every map key currently resolving to a bare material base at that
    # material's baked base+legs composite row so tables AND chairs render WITH
    # legs, for every material. TX10 shipped tables/STONE only; B183 extended
    # tables to WOOD/METAL/GLASS, and this wave adds chairs (identical layout,
    # authored ITEM_CHAIR_LEG_VARIANT overlay). Each redirect is guarded against
    # the current bare base cell so a raws-layout change fails loudly here instead
    # of silently compositing the wrong art. Shared helper => the two furniture
    # families are wired identically, not copy-pasted. See bake_leg_composite_sheet().
    #
    # NOTE (chairs): bytoken.ITEM_CHAIR (generic) also carries the TX9 spritepick
    # pin ("CHAIR / THRONE (missing legs)" -> building_icons.png(1,5)); the
    # generator redirect below runs FIRST, then apply_choices.py --reapply re-asserts
    # that human pin over it (same order tables already rely on for bytoken.ITEM_TABLE,
    # whose pin AGREES with the composite). The live render keys -- matvariants.Chair
    # (loose items) and building_map's furniture.Chair (placed) -- are NOT pinned, so
    # they keep the legged composite. The TX9 pin sits on a non-render key; flagged
    # for an owner re-pick, not silently removed here.
    leg_redirects = [
        (bytype, "TABLE", "Table", "STONE"),
        (bytoken, "ITEM_TABLE", "Table", "STONE"),
        (bytoken, "ITEM_TABLE_STONE", "Table", "STONE"),
        (bytoken, "ITEM_TABLE_WOOD", "Table", "WOOD"),
        (bytoken, "ITEM_TABLE_METAL", "Table", "METAL"),
        (bytoken, "ITEM_TABLE_GLASS", "Table", "GLASS"),
        (matvariants.get("Table", {}), "STONE", "Table", "STONE"),
        (matvariants.get("Table", {}), "WOOD", "Table", "WOOD"),
        (matvariants.get("Table", {}), "METAL", "Table", "METAL"),
        (matvariants.get("Table", {}), "GLASS", "Table", "GLASS"),
        (bytype, "CHAIR", "Chair", "STONE"),
        (bytoken, "ITEM_CHAIR", "Chair", "STONE"),
        (bytoken, "ITEM_CHAIR_STONE", "Chair", "STONE"),
        (bytoken, "ITEM_CHAIR_WOOD", "Chair", "WOOD"),
        (bytoken, "ITEM_CHAIR_METAL", "Chair", "METAL"),
        (bytoken, "ITEM_CHAIR_GLASS", "Chair", "GLASS"),
        (matvariants.get("Chair", {}), "STONE", "Chair", "STONE"),
        (matvariants.get("Chair", {}), "WOOD", "Chair", "WOOD"),
        (matvariants.get("Chair", {}), "METAL", "Chair", "METAL"),
        (matvariants.get("Chair", {}), "GLASS", "Chair", "GLASS"),
    ]
    for container, key, family, mat in leg_redirects:
        redirect_to_leg_composite(container, key, family, mat)
    sheets_used.add(TABLE_COMPOSITE_SHEET)
    sheets_used.add(CHAIR_COMPOSITE_SHEET)

    # ---- hatch-cover material fixups (native base + transparent detail composite) ----
    hatch_cover_bymat = {}
    for mat_key, (family, variant) in sorted(HATCH_COVER_FIXUPS.items()):
        hatch_cover_bymat[mat_key] = {
            "sheet": HATCH_COMPOSITE_SHEET,
            "col": HATCH_VARIANT_ROW[variant],
            "row": HATCH_FAMILY_ROW[family],
        }
    sheets_used.add(HATCH_COMPOSITE_SHEET)

    # ---- web (8 cells: 4 harmless + 4 thick variants) ----
    # Each variant shares the same TOKEN name with a trailing `:N` extra field
    # (first-binding-wins in load_item_tokens() only kept variant 1's cell for
    # the plain bytoken dict); pull all 4 numbered cells directly here instead.
    web_re = re.compile(r"\[TILE_GRAPHICS:([A-Za-z0-9_]+):(\d+):(\d+):(ITEM_WEB_(?:HARMLESS|THICK)):(\d)\]")
    web_harmless = {}
    web_thick = {}
    for fname in ITEM_GFX_FILES:
        path = os.path.join(ITEMS_GFX, fname)
        for ln in open(path, "r", encoding="latin-1"):
            m = web_re.search(ln.strip())
            if not m:
                continue
            page, col, row, token, variant = m.groups()
            sheet = item_pages.get(page)
            if not sheet:
                continue
            sheets_used.add(sheet)
            cell = {"sheet": sheet, "col": int(col), "row": int(row)}
            (web_harmless if token.endswith("HARMLESS") else web_thick)[int(variant)] = cell
    web = {
        "harmless": [web_harmless[i] for i in sorted(web_harmless)],
        "thick": [web_thick[i] for i in sorted(web_thick)],
    }
    if len(web["harmless"]) != 4 or len(web["thick"]) != 4:
        raise SystemExit("expected 4+4 web variant cells, got %d+%d (raws changed?)"
                          % (len(web["harmless"]), len(web["thick"])))

    # ---- _missing (MISSING_ITEM, defaults.png 1:0) ----
    defaults_txt = open(os.path.join(INTERFACE_GFX, "graphics_defaults.txt"),
                         "r", encoding="latin-1").read()
    m = re.search(r"\[TILE_GRAPHICS:DEFAULTS:(\d+):(\d+):MISSING_ITEM\]", defaults_txt)
    if not m:
        raise SystemExit("MISSING_ITEM token not found in graphics_defaults.txt (raws changed?)")
    missing_sheet = defaults_pages.get("DEFAULTS")
    if not missing_sheet:
        raise SystemExit("DEFAULTS TILE_PAGE not found in tile_page_interface.txt")
    missing_entry = {"sheet": missing_sheet, "col": int(m.group(1)), "row": int(m.group(2))}
    sheets_used.add(missing_sheet)

    # ---- _corpse_fallback (CORPSE/CORPSEPIECE art is creature-keyed; see
    # module docstring -- real per-race art needs item_body_component's race,
    # NEEDS-SCOUT, deferred to W-E.) ----
    # dinofix/corpsefix: an art-less corpse (creature has no per-race CORPSE cell) renders
    # this generic fallback. Native DF draws a SKELETON (bone pile), not a red gore blob, for
    # such corpses -- so point the fallback at bone_pile.png[0,0] (the [SKELETON:BONE_PILE:0:0]
    # cell every creature's skeleton uses) instead of the old ITEM_REMAINS red-gore cell
    # (item_nature.png[2,0]). bone_pile.png is already served from the creatures image dir.
    corpse_fallback = {"sheet": "bone_pile.png", "col": 0, "row": 0}

    # ---- v3 (T1b): rough-gem value tiers / glass roughs / boulder+bar per-mat ----
    tiers_raw, glass_raw, boulder_raw, bar_raw = load_special_item_graphics()

    # rough_gem_tiers: sorted-ascending list, one entry per pinned value tier.
    if set(tiers_raw) != set(ROUGH_GEM_VALUE_TIERS):
        raise SystemExit("rough_gem_tiers: expected value tiers %s, got %s (raws changed?)"
                         % (ROUGH_GEM_VALUE_TIERS, sorted(tiers_raw)))
    rough_gem_tiers = [
        {"min_value": v, "cell": raw_cell(tiers_raw[v], item_pages, "ITEM_ROUGH_GEM_VALUE_%d" % v)}
        for v in sorted(tiers_raw)
    ]

    # rough_gem_glass: the 3 ROUGH_GEM_GRAPHICS glass rows (all at BOULDERS 0:8).
    rough_gem_glass = {k: raw_cell(glass_raw[k], item_pages, "rough_gem_glass %s" % k)
                       for k in glass_raw}
    for expect in ("GLASS_GREEN", "GLASS_CLEAR", "GLASS_CRYSTAL"):
        if expect not in rough_gem_glass:
            raise SystemExit("rough_gem_glass: missing %r (raws changed?)" % expect)

    # boulder_bymat: {INORGANIC_ID: cell} for the ~35 named minerals.
    boulder_bymat = {iid: raw_cell(boulder_raw[iid], item_pages, "boulder %s" % iid)
                     for iid in boulder_raw}
    if not boulder_bymat:
        raise SystemExit("boulder_bymat is empty (raws changed?)")
    for pinned in ("MARBLE", "RAW_ADAMANTINE", "OBSIDIAN"):
        if pinned not in boulder_bymat:
            raise SystemExit("boulder_bymat: missing spec-pinned mineral %r (raws changed?)" % pinned)

    # bar_bymat: non-generic bar variants (generic ITEM_BARS stays in bytype/bytoken).
    bar_bymat = {k: raw_cell(bar_raw[k], item_pages, "bar %s" % k) for k in bar_raw}
    for pinned in ("POTASH", "PEARLASH", "COAL:COKE", "COAL:CHARCOAL", "SOAP"):
        if pinned not in bar_bymat:
            raise SystemExit("bar_bymat: missing spec-pinned variant %r (raws changed?)" % pinned)

    # ---- v3 (T1b): cut-gem shapes + shape==-1 (spawned) default cells ----
    gem_shapes_raw, gem_default_raw, smallgem_default_raw = load_gem_shapes()
    gem_default = raw_cell(gem_default_raw, descriptor_pages, "gem_default (ITEM_GEMS)")
    smallgem_default = raw_cell(smallgem_default_raw, descriptor_pages, "smallgem_default (SMALLGEMS:0:0)")
    gem_shapes = {}
    for cut, sl in sorted(gem_shapes_raw.items()):
        entry = {}
        if "small" in sl:
            entry["small"] = raw_cell(sl["small"], descriptor_pages, "gem_shape %s small" % cut)
        if "large" in sl:
            entry["large"] = raw_cell(sl["large"], descriptor_pages, "gem_shape %s large" % cut)
        gem_shapes[cut] = entry

    out = {
        "_v": 3,
        "bytype": bytype,
        "bytoken": bytoken,
        "matvariants": matvariants,
        "web": web,
        "_missing": missing_entry,
        "_corpse_fallback": corpse_fallback,
        "_default": default_entry,
        # v3 (T1b) additive keys:
        "rough_gem_tiers": rough_gem_tiers,
        "rough_gem_glass": rough_gem_glass,
        "gem_default": gem_default,
        "smallgem_default": smallgem_default,
        "gem_shapes": gem_shapes,
        "boulder_bymat": boulder_bymat,
        "bar_bymat": bar_bymat,
        "hatch_cover_bymat": hatch_cover_bymat,
        "creature_food": {
            "cells": creature_food_cells,
            "profiles": creature_food_profiles,
            "by_creature": creature_food_bycreature,
            "queued_for_pick": food_queue,
            "unresolved_creatures": unresolved_creatures,
        },
        "sheet_geometry": sheet_geometry,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")

    non_default = sum(1 for k in bytype if not k.startswith("_"))
    print("df::item_type enum values  : 94 (incl. NONE; df.d_basics.xml `item_type`)")
    print("item_types mapped (bytype) : %d / 94" % non_default)
    print("item_types unmappable       : %d (%s)"
          % (len(UNMAPPABLE_ITEM_TYPES), ", ".join(sorted(UNMAPPABLE_ITEM_TYPES))))
    print("bytoken entries             : %d (block headers seen: %d)" % (len(bytoken), n_blocks))
    print("matvariants bases           : %d (%s)" % (len(matvariants), ", ".join(sorted(matvariants))))
    print("web cells                   : %d" % (len(web["harmless"]) + len(web["thick"])))
    print("_missing                    : %s" % missing_entry)
    print("_corpse_fallback            : %s" % corpse_fallback)
    print("rough_gem_tiers (v3)        : %d tiers (%s)"
          % (len(rough_gem_tiers), ", ".join(str(t["min_value"]) for t in rough_gem_tiers)))
    print("rough_gem_glass (v3)        : %d (%s)"
          % (len(rough_gem_glass), ", ".join(sorted(rough_gem_glass))))
    print("gem_shapes (v3)             : %d cuts" % len(gem_shapes))
    print("gem_default / smallgem (v3) : %s / %s" % (gem_default, smallgem_default))
    print("boulder_bymat (v3)          : %d minerals" % len(boulder_bymat))
    print("bar_bymat (v3)              : %d (%s)" % (len(bar_bymat), ", ".join(sorted(bar_bymat))))
    print("hatch_cover_bymat           : %d -> %s" % (len(hatch_cover_bymat), HATCH_COMPOSITE_SHEET))
    print("leg composites (B183)       : %d redirects -> %s + %s, %d materials each (%s)"
          % (len(leg_redirects), TABLE_COMPOSITE_SHEET, CHAIR_COMPOSITE_SHEET,
             len(TABLE_COMPOSITE_ROW), ", ".join(sorted(TABLE_COMPOSITE_ROW))))
    print("creature_food cells         : %d mapped, %d queued-for-pick"
          % (len(creature_food_cells), len(food_queue)))
    print("creature_food assignments   : %d across %d / %d vanilla creatures"
          % (sum(len(v) for v in creature_food_layouts.values()),
             len(creature_food_layouts), creature_count))
    print("creature_food profiles      : %d" % len(creature_food_profiles))
    print("creature_food unresolved    : %d" % len(unresolved_creatures))
    print("sheet_geometry              : %d (%s)" % (len(sheet_geometry), ", ".join(sorted(sheet_geometry))))
    print("sheets used                 : %d -> %s" % (len(sheets_used), ", ".join(sorted(sheets_used))))
    print("wrote                       : %s" % OUT_PATH)
    print("wrote                       : %s" % HATCH_COMPOSITE_OUT)
    print("wrote                       : %s" % TABLE_COMPOSITE_OUT)
    print("wrote                       : %s" % CHAIR_COMPOSITE_OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
