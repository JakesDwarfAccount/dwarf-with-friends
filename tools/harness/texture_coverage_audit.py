#!/usr/bin/env python
# B47 differential texture-coverage audit.
#
# WHY THIS EXISTS (the texsweep lesson): an audit that only asks "did the lookup return
# a cell?" structurally CANNOT catch mis-resolution -- willow logs rendering as seeds,
# fruit rendering as seeds, a skeleton rendering as a live animal, a constructed wall
# rendering as natural rock all PASS a missing-audit because something WAS resolved.
# This tool classifies every renderable it can enumerate into FOUR verdicts:
#
#   CORRECT      resolved to a cell whose SOURCE map + family matches the renderable's
#                identity class (judged against an independent oracle: DF's own raws +
#                the identity the wire tail carries), not merely "resolved to something".
#   WRONG-ART    resolved, but to a cell the oracle says belongs to a different
#                family/map (the texsweep blind spot -- every rule below encodes a class
#                B47 found live).
#   PLACEHOLDER  resolved to a placeholder (_missing / MISSING_* / defaults.png).
#   DEGRADED     resolved to a documented best-effort stand-in (e.g. _corpse_fallback
#                for a race with no raws corpse art) -- visible, not wrong, not final.
#
# RULES (each one is a live-found B47/B31 bug class, kept forever as a regression net):
#   R1  item-identity gating: a WOOD/DRINK/POWDER-class plant-material item must NOT
#       resolve into plant_map (B31: logs-as-seeds).
#   R2  plant part fidelity: a PLANT/PLANT_GROWTH item of a species must resolve to that
#       species' PICKED cell, which must EXIST and DIFFER from its SEED cell
#       (B47: 55 tree species rendered every fruit as seeds).
#   R3  corpse-class fidelity: a CORPSE/CORPSEPIECE/REMAINS item of a race whose RAWS
#       carry a [CORPSE:...] (or [SKELETON:...]) cell must resolve to that dead cell,
#       never the LIVING creature cell (B47: langur skeletons drawn as live langurs).
#   R4  corpse-class visibility: a corpse-class item must never resolve to _missing
#       (B47: dwarf corpses drew the placeholder box). item_map._corpse_fallback is
#       DEGRADED (acceptable), a per-race dead cell is CORRECT.
#   R5  building art geometry: multi-cell art smaller than its type's known footprint
#       must be drawn ONCE (centered), never edge-clamp repeated (B47: wagon's 1x3
#       strip stamped on all 3 columns). Audited as a map+rule contract: the client
#       centering rule is unit-tested in wb12_buildings_test.mjs; here we enumerate
#       every map entry whose art is smaller than the type's footprint so a NEW such
#       type cannot appear silently.
#   R6  construction tokens: Constructed* tiletypes must map to DF's construction
#       art families (FLOOR_STONE_BLOCK / ROCK_BLOCKS_WALL_*), never the natural
#       smoothed-stone tokens (B47: "constructions show as generic stone").
#   R7  tree resolution: every Tree* tiletype enum name must parse (ported parser,
#       kept in lockstep with dwf-tiles.js by wc14_tree_test.mjs's parity rows)
#       and resolve a real cell for every tree species in the map; live directional
#       trunk/branch cells must also resolve a TREE_OVERLEAVES overlay.
#   R8  raws-vs-map generation completeness: every raws race with corpse art has a
#       creatures_map corpse cell; every raws plant with a non-seed growth (or top-level
#       PICKED) has a plant_map PICKED cell. Catches GENERATION-time gaps no client
#       fix can patch.
#   R9  workshop/furnace raw-art REACHABILITY (B63): every WORKSHOP_*/FURNACE_* raw
#       entry with cells must be resolvable through a client candidate key
#       ("Workshop:<subtype>"/"Furnace:<subtype>" alias with the same art) -- art the
#       generator emits but the client can never look up is a blue-box-in-waiting
#       (B63: 5x5 WORKSHOP_SIEGE art sat unreachable; the siege workshop stamped the
#       placeholder). Animation-state variants (_TURNING) are DEGRADED. Also: custom
#       workshops (WORKSHOP_CUSTOM:*) are footprint-matched by the client (the def id
#       is not on the wire), so two custom defs sharing (w,h) is a finding.
#
# MODES
#   python tools/harness/texture_coverage_audit.py            # static: maps + raws oracle
#   python tools/harness/texture_coverage_audit.py --live     # + live-fort enumeration via dfhack-run
#   python tools/harness/texture_coverage_audit.py --selftest # seed deliberate wrong entries; the
#                                                             # audit MUST catch every one (test-the-test)
#
# Exit 0 = no WRONG-ART/PLACEHOLDER findings (DEGRADED allowed, listed).
# Exit 1 = findings. Exit 2 = cannot run. --selftest: exit 0 only if EVERY seeded bug is caught.
#
# Read-only against DF; pure reads in the lua enumeration (no widget access, sim-state only).

import argparse
import copy
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
WEB = os.path.join(REPO, "web")
DF_ROOT = dfroot.df_root_for(__file__, purpose="reads sprite sheets out of Dwarf Fortress's own art")
DFHACK_RUN = os.path.join(DF_ROOT, "hack", "dfhack-run.exe")
RAWS = os.path.join(DF_ROOT, "data", "vanilla")

# known fixed footprints for building types whose art may be smaller (R5)
KNOWN_FOOTPRINTS = {"Wagon": (3, 3), "TradeDepot": (5, 5)}

# item types that consume plant identity (must match dwf-tiles.js ITEM_PLANT_PART)
ITEM_PLANT_PART = {"SEEDS": "SEED", "PLANT": "PICKED", "PLANT_GROWTH": "PICKED"}
ITEM_CREATURE_TYPES = {"CORPSE", "CORPSEPIECE", "REMAINS", "VERMIN", "PET", "EGG", "FISH", "FISH_RAW", "MEAT"}
CORPSE_CLASS = {"CORPSE", "CORPSEPIECE", "REMAINS"}


def load_maps(web=WEB):
    maps = {}
    for name in ("item_map", "plant_map", "creatures_map", "building_map", "tree_map", "tiletype_token_map"):
        with open(os.path.join(web, name + ".json"), encoding="utf-8") as fh:
            maps[name] = json.load(fh)
    return maps


# ---------------- client resolution chain, replicated (canvas2d reference) ----------------
def resolve_item(maps, it):
    """Port of dwf-tiles.js resolveItemEntry for the audit's purposes.
    it: {type, identKind, ident}. Returns (cell, source) where source names the map/family."""
    item_map = maps["item_map"]
    plant_map = maps["plant_map"]
    races = maps["creatures_map"].get("races", {})
    t = it.get("type")
    ik = it.get("identKind")
    ident = it.get("ident")
    if ik == 1 and ident:
        part = ITEM_PLANT_PART.get(t)
        if part:
            pm = plant_map.get(ident)
            if pm:
                for key in (part, "PICKED", "SHRUB", "SEED"):
                    if pm.get(key):
                        return pm[key], "plant_map." + ident + "." + key
    elif ik == 2 and ident and t in ITEM_CREATURE_TYPES:
        cm = races.get(ident)
        if cm:
            if t in CORPSE_CLASS:
                for key in ("corpse", "skeleton"):
                    c = cm.get(key)
                    if c and c.get("sheet"):
                        return c, "creatures_map." + ident + "." + key
            if cm.get("sheet"):
                return cm, "creatures_map." + ident + ".live"
    bt = item_map.get("bytype", {})
    if bt.get(t):
        return bt[t], "item_map.bytype." + t
    if t in CORPSE_CLASS and item_map.get("_corpse_fallback"):
        return item_map["_corpse_fallback"], "item_map._corpse_fallback"
    if item_map.get("_missing"):
        return item_map["_missing"], "item_map._missing"
    return None, "none"


# ---------------- tree ttname parser, ported (parity-tested vs JS in wc14_tree_test) ------
TREE_DIR_ORDER = "NSWE"


def canonical_dirs(letters):
    return "".join(d for d in TREE_DIR_ORDER if d in letters)


def parse_tree_ttname(ttname):
    if not ttname or not ttname.startswith("Tree"):
        return None
    dead = "Dead" in ttname
    rest = ttname[4:]
    if dead:
        rest = rest.replace("Dead", "", 1)
    if rest == "TrunkInterior":
        return {"family": "TREE_TRUNK_THICK", "variant": "INTERIOR", "dead": dead}
    if rest == "CapInterior":
        return {"family": "TREE_CAP", "variant": "THICK_INTERIOR", "dead": dead}
    if rest == "TrunkPillar":
        return {"family": "TREE_TRUNK_PILLAR", "variant": "_", "dead": dead}
    if rest == "TrunkSloping":
        return {"family": "TREE_TRUNK", "variant": "SLOPE_TOP", "dead": dead}
    if rest in ("RootSloping", "Roots"):
        return {"family": "TREE_BASE", "variant": "TRUNK", "dead": dead}
    if rest == "CapRamp":
        return {"skip": True}
    if rest == "Twigs":
        return {"family": ("TREE_LEAFLESS_TWIGS" if dead else "TREE_TWIGS"), "variant": None,
                "dead": dead, "adjacency": True}
    if rest in ("Branches", "BranchesSmooth"):
        return {"family": "TREE_BRANCH", "altFamily": "TREE_HEAVY_BRANCH", "variant": "NSWE", "dead": dead}
    if rest == "Branch":
        return {"family": "TREE_BRANCH", "altFamily": "TREE_HEAVY_BRANCH", "variant": "_", "dead": dead}
    if rest == "CapPillar" or re.match(r"^CapPillar[NSEW]{1,4}$", rest):
        return {"family": "TREE_CAP", "variant": "PILLAR", "dead": dead}
    m = re.match(r"^TrunkBranch([NSEW])$", rest)
    if m:
        return {"family": "TREE_BASE", "variant": "TRUNK_" + m.group(1), "dead": dead}
    m = re.match(r"^TrunkThick([NSEW]{1,2})$", rest)
    if m:
        return {"family": "TREE_TRUNK_THICK", "variant": canonical_dirs(m.group(1)), "dead": dead}
    m = re.match(r"^CapWallThick([NSEW]{1,2})$", rest)
    if m:
        return {"family": "TREE_CAP", "variant": "WALL_THICK_" + canonical_dirs(m.group(1)), "dead": dead}
    m = re.match(r"^CapWall([NSEW]{1,4})$", rest)
    if m:
        return {"family": "TREE_CAP", "variant": "WALL_" + "_".join(canonical_dirs(m.group(1))), "dead": dead}
    m = re.match(r"^CapFloor([1-4])$", rest)
    if m:
        return {"family": "TREE_CAP", "variant": "FLOOR_" + m.group(1), "dead": dead}
    m = re.match(r"^Trunk([NSEW]{1,4})$", rest)
    if m:
        return {"family": "TREE_TRUNK", "variant": canonical_dirs(m.group(1)), "dead": dead}
    m = re.match(r"^Branch([NSEW]{1,4})$", rest)
    if m:
        return {"family": "TREE_BRANCH", "altFamily": "TREE_HEAVY_BRANCH", "variant": canonical_dirs(m.group(1)), "dead": dead}
    return None


TREE_FLAT_FALLBACK = {
    "TREE_TRUNK": "TRUNK", "TREE_TRUNK_THICK": "TRUNK", "TREE_TRUNK_PILLAR": "TRUNK", "TREE_BASE": "TRUNK",
    "TREE_BRANCH": "BRANCH", "TREE_HEAVY_BRANCH": "BRANCH",
    "TREE_CAP": "CANOPY",
    "TREE_TWIGS": "LEAVES", "TREE_LEAFLESS_TWIGS": "LEAVES",
}


def resolve_tree_cell(tree_map, sel, species_id):
    if not sel or sel.get("skip"):
        return None
    species = tree_map.get(species_id) or tree_map.get("_default")
    if not species:
        return None
    variant = sel.get("variant")
    if variant is None and sel.get("adjacency"):
        variant = "_"

    def lookup(fam, var):
        if not fam:
            return None
        t1 = species.get(fam)
        if isinstance(t1, dict) and t1.get(var):
            return t1[var]
        t2 = (tree_map.get("_default") or {}).get(fam)
        if isinstance(t2, dict) and t2.get(var):
            return t2[var]
        return None

    cell = lookup(sel.get("family"), variant) or lookup(sel.get("altFamily"), variant)
    if not cell and variant != "_":
        cell = lookup(sel.get("family"), "_") or lookup(sel.get("altFamily"), "_")
    if not cell:
        flat = TREE_FLAT_FALLBACK.get(sel.get("family"))
        if flat:
            cell = species.get(flat) or (tree_map.get("_default") or {}).get(flat)
    return cell


OVERLEAVES_PREFIX = {"TREE_TRUNK": "TRUNK_", "TREE_BRANCH": "HEAVY_BRANCH_", "TREE_HEAVY_BRANCH": "HEAVY_BRANCH_"}


def resolve_overleaves(tree_map, sel, species_id):
    if not sel or sel.get("dead"):
        return None
    prefix = OVERLEAVES_PREFIX.get(sel.get("family"))
    v = sel.get("variant")
    if not prefix or not v or v == "_" or not re.match(r"^[NSWE]+$", v):
        return None
    key = prefix + v
    sp = tree_map.get(species_id) or {}
    own = (sp.get("TREE_OVERLEAVES") or {}).get(key)
    if own:
        return own
    return ((tree_map.get("_default") or {}).get("TREE_OVERLEAVES") or {}).get(key)


# ---------------- raws oracles (independent of the maps) ----------------------------------
def raws_corpse_races():
    """Races whose RAWS carry an explicit [CORPSE:...] or [SKELETON:...] cell."""
    out = set()
    gdir = os.path.join(RAWS, "vanilla_creatures_graphics", "graphics")
    hdr = re.compile(r"\[CREATURE_(?:CASTE_)?GRAPHICS:([^\]:]+)")
    for path in glob.glob(os.path.join(gdir, "graphics_creatures_*.txt")):
        base = os.path.basename(path).lower()
        if any(s in base for s in ("statues", "portrait", "layer_set_template")):
            continue
        try:
            txt = open(path, encoding="latin-1").read()
        except OSError:
            continue
        marks = list(hdr.finditer(txt))
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(txt)
            inner = txt[m.end():end]
            if re.search(r"\[(CORPSE|SKELETON):[A-Z0-9_]+:\d+:\d+", inner):
                out.add(m.group(1))
    return out


def raws_picked_plants():
    """Plant ids whose RAWS carry picked/growth art that genuinely DIFFERS from their seed
    art. Cell-aware on purpose: e.g. ASH's FRUIT growth (ash keys/samaras) points at the
    SAME cell as its SEED tag in the raws -- a fruit item rendering that cell is NATIVE-
    correct, not the fruit-as-seed bug. Preference order mirrors build_plant_map.py
    (FRUIT-named growth, else first non-SEED growth) so the audit judges the same pick
    the generator makes, but reads the raws independently."""
    out = set()
    gdir = os.path.join(RAWS, "vanilla_plants_graphics", "graphics")
    for path in glob.glob(os.path.join(gdir, "graphics_plant*.txt")) + \
            glob.glob(os.path.join(gdir, "graphics_individual_trees.txt")):
        try:
            lines = open(path, encoding="cp437").read().splitlines()
        except OSError:
            continue
        cur, growth = None, None
        picked, seed, growths = None, None, []

        def flush():
            if cur is None:
                return
            pick = picked
            if pick is None and growths:
                fruit = next((g for g in growths if "FRUIT" in g[0]), None)
                pick = (fruit or growths[0])[1]
            if pick is not None and pick != seed:
                out.add(cur)

        for ln in lines:
            m = re.match(r"^\[PLANT_GRAPHICS:([A-Za-z0-9_\-]+)\]", ln)
            if m:
                flush()
                cur, growth = m.group(1), None
                picked, seed, growths = None, None, []
                continue
            if cur is None:
                continue
            m = re.match(r"^\t\[PICKED:([A-Za-z0-9_]+):(\d+):(\d+)\]", ln)
            if m:
                picked = (m.group(1), int(m.group(2)), int(m.group(3)))
                growth = None
                continue
            m = re.match(r"^\t\[SEED:([A-Za-z0-9_]+):(\d+):(\d+)\]", ln)
            if m:
                seed = (m.group(1), int(m.group(2)), int(m.group(3)))
                growth = None
                continue
            m = re.match(r"^\t\[GROWTH:([A-Za-z0-9_\-]+)\]", ln)
            if m:
                growth = m.group(1)
                continue
            m = re.match(r"^\t\t\[GROWTH_PICKED:([A-Za-z0-9_]+):(\d+):(\d+)\]", ln)
            if m and growth:
                cell = (m.group(1), int(m.group(2)), int(m.group(3)))
                if growth.startswith("SEED"):
                    if seed is None:
                        seed = cell
                else:
                    growths.append((growth, cell))
        flush()
    return out


def all_tree_ttnames():
    """Every Tree* name in the df tiletype enum (from DFHack's df.d_basics.xml)."""
    xml = os.path.join(os.environ.get("DFHACK_SRC", ""), "library", "xml", "df.d_basics.xml")
    names = []
    try:
        in_tt = False
        for ln in open(xml, encoding="utf-8"):
            if "enum-type type-name='tiletype'" in ln:
                in_tt = True
            elif in_tt and "</enum-type>" in ln:
                break
            elif in_tt:
                m = re.search(r"<enum-item\s+name='(Tree[^']*)'", ln)
                if m:
                    names.append(m.group(1))
    except OSError:
        pass
    return names


# ---------------- live enumeration (optional) ----------------------------------------------
LIVE_LUA = r"""
-- texture_coverage_audit live enumeration: PURE READS (items/plants/buildings/constructions).
local out = {items={}, corpse_races={}, plant_species={}, tree_species={}, buildings={}, constructions={}}
local seen = {}
local items = df.global.world.items.all
for i = 0, #items - 1 do
  local it = items[i]
  local tn = df.item_type[it:getType()]
  local mi = dfhack.matinfo.decode(it)
  local tok = mi and mi:getToken() or ""
  local ident_kind, ident = 0, ""
  local race = -1
  if df.item_body_component:is_instance(it) then race = it.race
  elseif df.item_critter:is_instance(it) then race = it.race
  elseif df.item_remainsst:is_instance(it) then race = it.race
  elseif df.item_eggst:is_instance(it) then race = it.race
  elseif df.item_fish_rawst:is_instance(it) then race = it.race end
  if race >= 0 then
    local cr = df.global.world.raws.creatures.all[race]
    if cr then ident_kind, ident = 2, cr.creature_id end
  elseif mi then
    if mi.plant then ident_kind, ident = 1, mi.plant.id
    elseif mi.creature then ident_kind, ident = 2, mi.creature.creature_id end
  end
  local key = tn .. "|" .. tostring(ident_kind) .. "|" .. ident
  if not seen[key] then
    seen[key] = true
    table.insert(out.items, {type=tn, identKind=ident_kind, ident=ident, mat=tok})
  end
end
local pseen = {}
for i = 0, #df.global.world.plants.all - 1 do
  local pl = df.global.world.plants.all[i]
  local pr = df.plant_raw.find(pl.material)
  if pr and not pseen[pr.id] then
    pseen[pr.id] = true
    if pl.tree_info ~= nil then table.insert(out.tree_species, pr.id)
    else table.insert(out.plant_species, pr.id) end
  end
end
local bseen = {}
for _, b in ipairs(df.global.world.buildings.all) do
  local t = df.building_type[b:getType()] or "?"
  local key = t .. "|" .. tostring(b:getSubtype())
  if not bseen[key] then
    bseen[key] = true
    table.insert(out.buildings, {type=t, subtype=b:getSubtype(), w=b.x2-b.x1+1, h=b.y2-b.y1+1})
  end
end
local cseen = {}
for i = 0, #df.global.world.event.constructions - 1 do
  local c = df.global.world.event.constructions[i]
  local tt = dfhack.maps.getTileType(c.pos.x, c.pos.y, c.pos.z)
  local ttn = tt and df.tiletype[tt] or "?"
  local mi = dfhack.matinfo.decode(c.mat_type, c.mat_index)
  local key = ttn .. "|" .. (mi and mi:getToken() or "?")
  if not cseen[key] then
    cseen[key] = true
    table.insert(out.constructions, {ttname=ttn, mat=(mi and mi:getToken() or "?")})
  end
end
print(require("json").encode(out))
"""


def live_enumerate():
    if not os.path.exists(DFHACK_RUN):
        return None
    with tempfile.NamedTemporaryFile("w", suffix=".lua", delete=False, dir=tempfile.gettempdir()) as fh:
        fh.write(LIVE_LUA)
        lua_path = fh.name
    try:
        r = subprocess.run([DFHACK_RUN, "lua", "-f", lua_path], capture_output=True, text=True, timeout=180)
        if r.returncode != 0 or not r.stdout.strip():
            return None
        # dfhack's json.encode pretty-prints across many lines -- parse from the first brace.
        text = r.stdout
        return json.loads(text[text.index("{"):])
    except Exception:
        return None
    finally:
        try:
            os.unlink(lua_path)
        except OSError:
            pass


# ---------------- the audit -----------------------------------------------------------------
def cell_eq(a, b):
    return bool(a) and bool(b) and a.get("sheet") == b.get("sheet") and \
        a.get("col") == b.get("col") and a.get("row") == b.get("row")


def audit(maps, live=None, oracle_corpse=None, oracle_picked=None, tree_ttnames=None, tree_species=None):
    findings = []   # (severity, rule, message)
    degraded = []

    def bad(rule, msg):
        findings.append((rule, msg))

    races = maps["creatures_map"].get("races", {})
    plant_map = maps["plant_map"]
    item_map = maps["item_map"]
    tree_map = maps["tree_map"]
    token_map = maps["tiletype_token_map"]
    building_map = maps["building_map"]

    # ---- R1: WOOD + plant ident must resolve OUTSIDE plant_map -------------------------------
    probe_species = [k for k in plant_map if not k.startswith("_")]
    for sp in probe_species:
        cell, src = resolve_item(maps, {"type": "WOOD", "identKind": 1, "ident": sp})
        if src.startswith("plant_map"):
            bad("R1", f"WOOD item of species {sp} resolves INTO plant_map ({src}) -- B31 logs-as-seeds class")

    # ---- R2: PLANT_GROWTH per-species fruit fidelity ------------------------------------------
    # A fruit/growth item resolving to the species' SEED art is WRONG-ART whenever the raws
    # oracle says non-seed picked art exists for that species (a map whose PICKED merely
    # POINTS AT the seed cell is the same bug as a missing PICKED -- judged by the RESOLVED
    # pixel source, not by key presence, which is exactly the texsweep blind spot).
    for sp in probe_species:
        pm = plant_map[sp]
        if not isinstance(pm, dict) or "SEED" not in pm:
            continue
        cell, src = resolve_item(maps, {"type": "PLANT_GROWTH", "identKind": 1, "ident": sp})
        if cell and cell_eq(cell, pm.get("SEED")):
            if oracle_picked and sp in oracle_picked:
                bad("R2", f"PLANT_GROWTH of {sp} renders the SEED cell although the raws carry non-seed picked art ({src})")
            elif oracle_picked is not None and sp not in oracle_picked:
                degraded.append(("R2", f"PLANT_GROWTH of {sp} falls to SEED (raws carry no picked art)"))

    # ---- R3/R4: corpse-class fidelity ----------------------------------------------------------
    oracle_corpse = oracle_corpse or set()
    for race, rec in races.items():
        if not isinstance(rec, dict):
            continue
        cell, src = resolve_item(maps, {"type": "CORPSE", "identKind": 2, "ident": race})
        live_cell = {"sheet": rec.get("sheet"), "col": rec.get("col"), "row": rec.get("row")} if rec.get("sheet") else None
        has_dead = bool((rec.get("corpse") or {}).get("sheet") or (rec.get("skeleton") or {}).get("sheet"))
        if race in oracle_corpse and not has_dead:
            bad("R8", f"raws carry corpse art for {race} but creatures_map has no corpse/skeleton cell (generation gap)")
        if has_dead and live_cell and cell_eq(cell, live_cell):
            bad("R3", f"CORPSE of {race} resolves to the LIVING cell despite dead art existing ({src})")
        if cell is None or (item_map.get("_missing") and cell_eq(cell, item_map["_missing"])):
            bad("R4", f"CORPSE of {race} resolves to the _missing placeholder ({src})")
        elif src == "item_map._corpse_fallback":
            degraded.append(("R4", f"CORPSE of {race} uses the generic remains fallback (no per-race art)"))

    # ---- R5: building art geometry --------------------------------------------------------------
    for btype, (fw, fh) in KNOWN_FOOTPRINTS.items():
        e = building_map.get(btype)
        if not e or not isinstance(e.get("cells"), list):
            continue
        gh = len(e["cells"])
        gw = e.get("w") or (len(e["cells"][0]) if e["cells"] else 1)
        if (gw > 1 or gh > 1) and (gw < fw or gh < fh):
            # smaller-than-footprint multi-cell art: legal ONLY because the client centers it.
            degraded.append(("R5", f"{btype} art {gw}x{gh} < footprint {fw}x{fh}: relies on the "
                                   f"centered-once blit rule (unit-tested in wb12_buildings_test.mjs)"))
        if gw > fw or gh > fh:
            bad("R5", f"{btype} art {gw}x{gh} EXCEEDS its footprint {fw}x{fh} -- would be clamped/cropped")

    # ---- R9: workshop/furnace raw-art REACHABILITY (B63 class) ------------------------------------
    # The client's buildingEntry() constructs ONLY "Workshop:<subtype>"/"Furnace:<subtype>"
    # candidates (+ footprint-matched WORKSHOP_CUSTOM:* for subtype Custom). A raw-token entry
    # the generator emits is DEAD DATA unless an alias with the same art exists -- exactly how
    # the full 5x5 WORKSHOP_SIEGE art sat in the map while the client stamped the blue box.
    # Animation-state variants (base art carries the alias) are DEGRADED, not findings.
    R9_STATE_SUFFIXES = ("_TURNING",)

    def _art_sig(e):
        return (e.get("sheet"), e.get("w"), e.get("h"), json.dumps(e.get("cells"), sort_keys=True))
    alias_sigs = {_art_sig(v) for k, v in building_map.items()
                  if isinstance(v, dict) and "cells" in v
                  and (k.startswith("Workshop:") or k.startswith("Furnace:"))}
    for k, e in building_map.items():
        if not (k.startswith("WORKSHOP_") or k.startswith("FURNACE_")):
            continue
        if k == "WORKSHOP_CUSTOM" or k.startswith("WORKSHOP_CUSTOM:"):
            continue  # custom defs are footprint-matched by the client; ambiguity checked below
        if not isinstance(e, dict) or "cells" not in e:
            continue
        if _art_sig(e) in alias_sigs:
            continue
        if any(k.endswith(s) for s in R9_STATE_SUFFIXES):
            degraded.append(("R9", f"{k} is an animation-state variant with no alias (base art reachable)"))
        else:
            bad("R9", f"{k} art is UNREACHABLE: no Workshop:/Furnace: alias resolves it (B63 siege class)")
    # Custom workshops: the client's ONLY wire signal is the footprint (the def id is not on
    # the wire) -- two custom defs sharing (w,h) cannot be distinguished (needs the cdef field).
    seen_fp = {}
    for k, e in building_map.items():
        if not k.startswith("WORKSHOP_CUSTOM:") or not isinstance(e, dict):
            continue
        fp = (e.get("w"), e.get("h"))
        if fp in seen_fp:
            bad("R9", f"custom workshops {seen_fp[fp]} and {k} share footprint {fp} -- the client's "
                      f"footprint match cannot distinguish them (needs the wire cdef field)")
        else:
            seen_fp[fp] = k

    # ---- R6: construction tokens -----------------------------------------------------------------
    for ttname, entry in token_map.items():
        if not ttname.startswith("Constructed") or not isinstance(entry, dict):
            continue
        tok = entry.get("token") or ""
        if ttname in ("ConstructedFloor",) and tok != "FLOOR_STONE_BLOCK":
            bad("R6", f"{ttname} maps to {tok!r}, not FLOOR_STONE_BLOCK (natural-stone misread)")
        if "Wall" in ttname or "Pillar" in ttname:
            if not tok.startswith("ROCK_BLOCKS_WALL"):
                bad("R6", f"{ttname} maps to {tok!r}, not a ROCK_BLOCKS_WALL_* construction token")

    # ---- R7: tree resolution ----------------------------------------------------------------------
    ttnames = tree_ttnames or all_tree_ttnames()
    tree_species = tree_species or (live or {}).get("tree_species") or \
        [k for k in tree_map if not k.startswith("_")]
    for sp in tree_species:
        if sp not in tree_map:
            bad("R7", f"live tree species {sp} has NO tree_map entry (falls to _default for every tile)")
            continue
        for tt in ttnames:
            sel = parse_tree_ttname(tt)
            if sel is None:
                bad("R7", f"tree ttname {tt} does not parse (would fall to the coarse flat cell)")
                continue
            if sel.get("skip"):
                continue
            cell = resolve_tree_cell(tree_map, sel, sp)
            if not cell or not cell.get("sheet"):
                bad("R7", f"{sp} x {tt} resolves NO cell (family {sel.get('family')} variant {sel.get('variant')})")
            if not sel.get("dead") and OVERLEAVES_PREFIX.get(sel.get("family")) and \
                    sel.get("variant") and re.match(r"^[NSWE]+$", sel.get("variant") or ""):
                if not resolve_overleaves(tree_map, sel, sp):
                    bad("R7", f"{sp} x {tt}: live directional cell has NO TREE_OVERLEAVES overlay")

    # ---- R8 (plants half): generation completeness -------------------------------------------------
    for sp in (oracle_picked or set()):
        pm = plant_map.get(sp)
        if pm is None:
            bad("R8", f"raws define graphics for plant {sp} but plant_map has no entry")
        elif "PICKED" not in pm:
            bad("R8", f"raws carry non-seed growth/picked art for {sp} but plant_map has no PICKED (generation gap)")

    # ---- live items (when available): run the full item matrix through the resolver ---------------
    if live:
        for it in live.get("items", []):
            t = it.get("type")
            cell, src = resolve_item(maps, {"type": t, "identKind": it.get("identKind"), "ident": it.get("ident")})
            if t == "WOOD" and src.startswith("plant_map"):
                bad("R1", f"[live] WOOD {it.get('mat')} resolves into plant_map ({src})")
            if t in CORPSE_CLASS:
                if cell is None or (item_map.get("_missing") and cell_eq(cell, item_map["_missing"])):
                    bad("R4", f"[live] {t} of {it.get('ident')} resolves to _missing")
                elif src.endswith(".live"):
                    rec = races.get(it.get("ident")) or {}
                    if (rec.get("corpse") or {}).get("sheet") or (rec.get("skeleton") or {}).get("sheet"):
                        bad("R3", f"[live] {t} of {it.get('ident')} uses the LIVING cell despite dead art")
                    else:
                        degraded.append(("R3", f"[live] {t} of {it.get('ident')}: living cell stands in (no raws dead art)"))
        for c in live.get("constructions", []):
            tok = (token_map.get(c["ttname"]) or {}).get("token") or ""
            if c["ttname"].startswith("Constructed"):
                if ("Wall" in c["ttname"] or "Pillar" in c["ttname"]) and not tok.startswith("ROCK_BLOCKS_WALL"):
                    bad("R6", f"[live] construction {c['ttname']} ({c['mat']}) maps to {tok!r}")
    return findings, degraded


# ---------------- selftest: seed deliberate wrong entries; the audit MUST catch each ------------
def selftest():
    base = load_maps()
    oracle_corpse = {"GRAY_LANGUR"}
    seeds = []

    # S1 (R2): point CUSTARD-APPLE's PICKED at its SEED cell -- key EXISTS (a key-presence
    # audit passes) but the RESOLVED pixel is seed art while the raws carry fruit art.
    m = copy.deepcopy(base)
    m["plant_map"]["CUSTARD-APPLE"]["PICKED"] = dict(m["plant_map"]["CUSTARD-APPLE"]["SEED"])
    seeds.append(("R2 fruit-as-seed", m, None, "R2", {"oracle_picked": {"CUSTARD-APPLE"}}))

    # S2 (R3): strip GRAY_LANGUR's corpse cell -> corpse resolves to the LIVING cell, and the
    # raws oracle says corpse art exists -> R8 (generation gap) must fire.
    m = copy.deepcopy(base)
    m["creatures_map"]["races"]["GRAY_LANGUR"].pop("corpse", None)
    m["creatures_map"]["races"]["GRAY_LANGUR"].pop("skeleton", None)
    seeds.append(("R8 corpse generation gap", m, oracle_corpse, "R8", {}))

    # S3 (R6): point ConstructedFloor back at the natural smoothed-stone token.
    m = copy.deepcopy(base)
    m["tiletype_token_map"]["ConstructedFloor"] = {"token": "STONE_FLOOR_5", "tint": None}
    seeds.append(("R6 construction natural-stone", m, None, "R6", {}))

    # S4 (R7): delete WILLOW's TREE_OVERLEAVES (own + _default) -> live directional trunk
    # cells lose their overlay for the audited species.
    m = copy.deepcopy(base)
    m["tree_map"]["WILLOW"].pop("TREE_OVERLEAVES", None)
    m["tree_map"]["_default"].pop("TREE_OVERLEAVES", None)
    seeds.append(("R7 overleaves missing", m, None, "R7", {"tree_species": ["WILLOW"]}))

    # S5 (R4): drop the corpse fallback AND dwarf's skeleton -> dwarf corpse lands on _missing.
    m = copy.deepcopy(base)
    m["creatures_map"]["races"]["DWARF"].pop("skeleton", None)
    m["creatures_map"]["races"]["DWARF"].pop("corpse", None)
    m["item_map"].pop("_corpse_fallback", None)
    seeds.append(("R4 corpse placeholder", m, None, "R4", {}))

    # S6 (R9, B63): delete the Workshop:Siege alias -> the 5x5 WORKSHOP_SIEGE art becomes
    # client-unreachable again (the exact pre-B63 map state; the audit MUST catch it).
    m = copy.deepcopy(base)
    m["building_map"].pop("Workshop:Siege", None)
    seeds.append(("R9 siege art unreachable", m, None, "R9", {}))

    # S7 (R9, B63): seed a second 3x3 custom workshop -> footprint collision with SOAP_MAKER
    # (the client's only wire signal cannot distinguish them).
    m = copy.deepcopy(base)
    m["building_map"]["WORKSHOP_CUSTOM:SEEDED_CLONE"] = copy.deepcopy(
        m["building_map"]["WORKSHOP_CUSTOM:SOAP_MAKER"])
    seeds.append(("R9 custom footprint collision", m, None, "R9", {}))

    missed = 0
    for name, m, oc, want_rule, extra in seeds:
        f, _ = audit(m, live=None, oracle_corpse=(oc or set()),
                     oracle_picked=extra.get("oracle_picked", set()),
                     tree_ttnames=["TreeTrunkNS", "TreeTrunkPillar", "TreeBranchNS"],
                     tree_species=extra.get("tree_species", ["MAPLE"]))
        hit = any(rule == want_rule for rule, _msg in f)
        print(("CAUGHT " if hit else "MISSED ") + name + f" ({sum(1 for r, _ in f if r == want_rule)} {want_rule} findings)")
        if not hit:
            missed += 1
    # the UNSEEDED baseline must be clean for the same reduced scope
    f0, _ = audit(base, live=None, oracle_corpse=set(), oracle_picked=set(),
                  tree_ttnames=["TreeTrunkNS", "TreeTrunkPillar", "TreeBranchNS"],
                  tree_species=["MAPLE", "WILLOW"])
    clean = [x for x in f0]
    print(("PASS" if not clean else "FAIL") + f" baseline (unseeded) audit is clean for the selftest scope ({len(clean)} findings)")
    if clean:
        for r, msg in clean[:10]:
            print("   ", r, msg)
    return 0 if (missed == 0 and not clean) else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="also enumerate the live fort via dfhack-run")
    ap.add_argument("--selftest", action="store_true", help="seed deliberate wrong map entries; audit must catch each")
    ap.add_argument("--json", help="write findings to this path")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    try:
        maps = load_maps()
    except OSError as e:
        print("cannot run: " + str(e))
        sys.exit(2)

    oracle_corpse = raws_corpse_races()
    oracle_picked = raws_picked_plants()
    live = live_enumerate() if args.live else None
    if args.live and live is None:
        print("WARNING: live enumeration unavailable (DF down or dfhack-run failed) -- static audit only")

    findings, degraded = audit(maps, live=live, oracle_corpse=oracle_corpse, oracle_picked=oracle_picked)

    by_rule = {}
    for rule, msg in findings:
        by_rule.setdefault(rule, []).append(msg)
    print(f"texture_coverage_audit: {len(findings)} findings, {len(degraded)} degraded (accepted)")
    for rule in sorted(by_rule):
        msgs = by_rule[rule]
        print(f"  {rule}: {len(msgs)}")
        for msg in msgs[:8]:
            print("     - " + msg)
        if len(msgs) > 8:
            print(f"     ... and {len(msgs) - 8} more")
    if degraded:
        print("  degraded (documented, non-failing):")
        seen = set()
        for rule, msg in degraded:
            key = rule + msg
            if key in seen:
                continue
            seen.add(key)
        print(f"     {len(seen)} unique degradations (use --json for the full list)")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"findings": [{"rule": r, "msg": m} for r, m in findings],
                       "degraded": [{"rule": r, "msg": m} for r, m in degraded]}, fh, indent=1)
        print("wrote " + args.json)
    sys.exit(1 if findings else 0)


if __name__ == "__main__":
    main()
