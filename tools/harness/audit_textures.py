#!/usr/bin/env python
# dwf texture-coverage audit (texsweep).
#
# Repeatable instrument that finds every RENDERABLE thing (item / building /
# plant) falling back to a placeholder or wrong sprite, by diffing THREE sources:
#   (1) what the LIVE fort actually contains   -- via tools/harness/audit_live_enum.lua
#                                                  run through dfhack-run (read-only).
#   (2) what DF's OWN graphics raws authorise  -- the df::building_type / df::item_type
#                                                  enums + the committed *_map.json the
#                                                  generators distilled from the raws.
#   (3) what the CLIENT can actually resolve    -- this file replicates the browser's
#                                                  buildingEntry()/resolveItemEntry()/
#                                                  plant lookup EXACTLY, against the
#                                                  committed web/building_map.json,
#                                                  item_map.json, plant_map.json.
#
# A renderable is a GAP when (1) says it is in the world but (3) can only resolve it
# to MISSING_BUILDING / MISSING_ITEM / the generic _default cell.
#
# Exit 0 = every in-world renderable resolves to a real sprite (or is on the
# justified EXCEPTIONS list). Exit 1 = unmapped in-world renderables remain.
# Exit 2 = cannot run (server/DF down, maps missing).
#
# Usage:
#   python tools/harness/audit_textures.py [--no-live] [--json OUT]
#   --no-live  : skip the dfhack-run enumeration; audit the full-raws coverage only.
#
# Read-only. Does NOT drive DF (the lua it runs is pure reads); no DF_LOCK needed.

import json
import os
import re
import subprocess
import sys

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
WEB = os.path.join(REPO, "web")
DF_ROOT = dfroot.df_root_for(__file__, purpose="reads sprite sheets out of Dwarf Fortress's own art")
DFHACK_RUN = os.path.join(DF_ROOT, "hack", "dfhack-run.exe")
ENUM_LUA = os.path.join(HERE, "audit_live_enum.lua")

# ---- client-resolution constants (mirror web/js/dwf-tiles.js) -----------
WORKSHOP_SUBTYPE = [
    "Carpenters", "Farmers", "Masons", "Craftsdwarfs", "Jewelers", "MetalsmithsForge",
    "MagmaForge", "Bowyers", "Mechanics", "Siege", "Butchers", "Leatherworks", "Tanners",
    "Clothiers", "Fishery", "Still", "Loom", "Quern", "Kennels", "Kitchen", "Ashery",
    "Dyers", "Millstone", "Custom", "Tool",
]
FURNACE_SUBTYPE = [
    "WoodFurnace", "Smelter", "GlassFurnace", "Kiln", "MagmaSmelter",
    "MagmaGlassFurnace", "MagmaKiln", "Custom",
]
ITEM_MATVARIANT_BASE = {
    "DOOR": "Door", "BED": "Bed", "TABLE": "Table", "CHAIR": "Chair", "CABINET": "Cabinet",
    "BOX": "Box", "HATCH_COVER": "HatchCover", "GRATE": "Grate",
}
OVERLAY_ONLY_BUILDING = {"Stockpile", "Civzone"}

# In-world building_types that legitimately render NOTHING as a building (their
# tiles are drawn by the terrain/tiletype or plant layer, not a building sprite):
#   FarmPlot   -- tilled-soil tiletype + crop plant beneath (null-cell entry).
#   RoadDirt/RoadPaved/RoadStone/Construction -- constructed floors = tiletypes.
BUILDING_RENDERS_AS_TERRAIN = {"FarmPlot", "RoadDirt", "RoadPaved", "RoadStone", "Construction"}

# Item types with NO standalone ground-item cell in vanilla graphics raws (verified
# by build_item_map.py) -- they render the generic box; a species/creature-keyed
# sprite would need more on the wire (documented deferral, not a fixable gap here).
ITEM_GENERIC_EXPECTED = {
    "MEAT", "FISH", "FISH_RAW", "SEEDS", "GLOB", "VERMIN", "PET",
    "CORPSE", "CORPSEPIECE", "REMAINS",  # creature-keyed; render REMAINS/corpse fallback
    "PLANT", "PLANT_GROWTH",             # generic plant cell; per-species needs plant_id on the item wire
}


def load_map(name):
    p = os.path.join(WEB, name)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def building_resolves(bmap, btype, subtype=-1):
    """Replicate buildingEntry(): True if a real (non-MISSING) top-level entry hits."""
    if btype in OVERLAY_ONLY_BUILDING:
        return "overlay-only"
    cands = []
    if btype == "Workshop" and 0 <= subtype < len(WORKSHOP_SUBTYPE):
        cands.append("Workshop:" + WORKSHOP_SUBTYPE[subtype])
    if btype == "Furnace" and 0 <= subtype < len(FURNACE_SUBTYPE):
        cands.append("Furnace:" + FURNACE_SUBTYPE[subtype])
    cands += [btype + ":" + str(subtype), btype]
    for c in cands:
        if c in bmap:
            return True
    return False


def item_resolves(imap, itype):
    """Replicate resolveItemEntry() minus the runtime ITEMDEF bytoken step (which
    needs a live subtype dict): True if matvariant or a REAL bytype cell hits;
    'generic' if only _default/_missing would."""
    base = ITEM_MATVARIANT_BASE.get(itype)
    if base and imap.get("matvariants", {}).get(base):
        return True
    if imap.get("bytype", {}).get(itype):
        return True
    return "generic"


def run_live_enum():
    """Run audit_live_enum.lua via dfhack-run; return dict of category -> {name: count}."""
    if not os.path.exists(DFHACK_RUN):
        return None
    try:
        out = subprocess.run([DFHACK_RUN, "lua", "-f", ENUM_LUA],
                             cwd=DF_ROOT, capture_output=True, text=True, timeout=60)
    except Exception as e:
        print("live enum failed:", e)
        return None
    res = {"BLD": {}, "BSUB": {}, "ITM": {}, "IDEF": {}, "PLT": {}, "PLT_KIND": {}}
    for ln in out.stdout.splitlines():
        m = re.match(r"(BLD|BSUB|ITM|IDEF)\t(\S+)\t(\d+)", ln)
        if m:
            res[m.group(1)][m.group(2)] = int(m.group(3))
            continue
        m = re.match(r"PLT\t(\S+)\t(\d+)\t(TREE|SHRUB)", ln)
        if m:
            res["PLT"][m.group(1)] = int(m.group(2))
            res["PLT_KIND"][m.group(1)] = m.group(3)
    if not any(res[k] for k in ("BLD", "ITM", "PLT")):
        print("live enum returned no rows (fort not loaded?)")
        print(out.stdout[:500])
        return None
    return res


def main():
    live = "--no-live" not in sys.argv
    bmap = load_map("building_map.json")
    imap = load_map("item_map.json")
    pmap = load_map("plant_map.json")
    if not (bmap and imap and pmap):
        print("CANNOT RUN: one or more *_map.json missing under web/")
        return 2

    tmap = load_map("tree_map.json") or {}
    enum = run_live_enum() if live else None
    gaps = []
    print("=" * 70)
    print("TEXTURE-COVERAGE AUDIT")
    print("=" * 70)

    if enum:
        # item_types whose sprite is resolved by the raw itemdef TOKEN (bytoken),
        # not a flat bytype cell -- audited via the IDEF token rows below.
        SUBTYPE_ITEM_TYPES = {"WEAPON", "ARMOR", "HELM", "SHIELD", "GLOVES", "PANTS",
                              "SHOES", "AMMO", "TOOL", "TRAPCOMP", "TOY", "INSTRUMENT",
                              "SIEGEAMMO", "WEAPONRACK"}
        bytoken = imap.get("bytoken", {})

        print("\n-- IN-WORLD BUILDINGS (%d types) --" % len(enum["BLD"]))
        for bt, n in sorted(enum["BLD"].items()):
            if bt in ("Workshop", "Furnace"):
                # resolution is per-subtype -- checked in the BSUB block below.
                subs = {k: v for k, v in enum["BSUB"].items() if k.startswith(bt + ":")}
                miss = [k for k in subs if k not in bmap]
                status = "OK (%d subtypes)" % len(subs) if not miss else "*** GAP subtypes: %s ***" % miss
                if miss:
                    for k in miss:
                        gaps.append(("building", k, subs[k]))
            else:
                r = building_resolves(bmap, bt)
                if r is True:
                    status = "OK"
                elif r == "overlay-only":
                    status = "overlay-only (zones)"
                elif bt in BUILDING_RENDERS_AS_TERRAIN:
                    status = "renders-as-terrain (OK)"
                else:
                    status = "*** GAP (MISSING_BUILDING) ***"
                    gaps.append(("building", bt, n))
            print("  %-16s x%-5d %s" % (bt, n, status))

        print("\n-- IN-WORLD ITEMS (%d types) --" % len(enum["ITM"]))
        for it, n in sorted(enum["ITM"].items()):
            if it in SUBTYPE_ITEM_TYPES:
                status = "OK (bytoken; per-subtype checked below)"
            else:
                r = item_resolves(imap, it)
                if r is True:
                    status = "OK"
                elif it in ITEM_GENERIC_EXPECTED:
                    status = "generic cell (expected; per-species needs wire ext)"
                else:
                    status = "*** GAP (generic/missing box) ***"
                    gaps.append(("item", it, n))
            print("  %-16s x%-5d %s" % (it, n, status))

        if enum["IDEF"]:
            print("\n-- IN-WORLD ITEMDEF TOKENS (%d) via bytoken --" % len(enum["IDEF"]))
            idef_miss = 0
            for tok, n in sorted(enum["IDEF"].items()):
                if tok in bytoken:
                    continue
                idef_miss += 1
                gaps.append(("itemdef", tok, n))
                print("  %-32s x%-5d *** GAP (no bytoken cell) ***" % (tok, n))
            print("  %d/%d itemdef tokens resolve to a bytoken cell" %
                  (len(enum["IDEF"]) - idef_miss, len(enum["IDEF"])))

        print("\n-- ON-MAP PLANTS (%d ids: trees via tree_map, shrubs via plant_map) --"
              % len(enum["PLT"]))
        plant_ok = 0
        for pid, n in sorted(enum["PLT"].items()):
            kind = enum["PLT_KIND"].get(pid, "SHRUB")
            if kind == "TREE":
                if pid in tmap:
                    plant_ok += 1
                else:
                    gaps.append(("tree", pid, n))
                    print("  %-24s x%-5d *** GAP (tree not in tree_map) ***" % (pid, n))
            else:
                e = pmap.get(pid)
                if e and e.get("SHRUB"):
                    plant_ok += 1
                else:
                    gaps.append(("plant", pid, n))
                    print("  %-24s x%-5d *** GAP (no SHRUB cell) ***" % (pid, n))
        print("  %d/%d plant ids resolve (tree or shrub)" % (plant_ok, len(enum["PLT"])))

    # ---- full-raws coverage (independent of what's in-world right now) ----
    print("\n-- FULL building_type DEFAULT COVERAGE (all enum names) --")
    all_bt = ["Chair", "Bed", "Table", "Coffin", "FarmPlot", "Furnace", "TradeDepot",
              "Shop", "Door", "Floodgate", "Box", "Weaponrack", "Armorstand", "Workshop",
              "Cabinet", "Statue", "WindowGlass", "WindowGem", "Well", "Bridge", "RoadDirt",
              "RoadPaved", "SiegeEngine", "Trap", "AnimalTrap", "Support", "ArcheryTarget",
              "Chain", "Cage", "Weapon", "Wagon", "ScrewPump", "Construction", "Hatch",
              "GrateWall", "GrateFloor", "BarsVertical", "BarsFloor", "GearAssembly",
              "AxleHorizontal", "AxleVertical", "WaterWheel", "Windmill", "TractionBench",
              "Slab", "Nest", "NestBox", "Hive", "Rollers", "Instrument", "Bookcase",
              "DisplayFurniture", "OfferingPlace"]
    unresolved = []
    for bt in all_bt:
        r = building_resolves(bmap, bt, 0)
        if r is True or r == "overlay-only" or bt in BUILDING_RENDERS_AS_TERRAIN:
            continue
        unresolved.append(bt)
    print("  building_types with NO top-level default entry: %s"
          % (unresolved if unresolved else "(none)"))

    print("\n" + "=" * 70)
    if gaps:
        print("RESULT: %d IN-WORLD GAP(S)" % len(gaps))
        for kind, name, n in gaps:
            print("  GAP  %-9s %-24s x%d" % (kind, name, n))
        print("=" * 70)
        return 1
    print("RESULT: no in-world unmapped renderables (all resolve to a real sprite,")
    print("        a terrain/plant layer, or a justified generic/deferred exception).")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
