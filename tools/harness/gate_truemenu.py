#!/usr/bin/env python3
"""gate_truemenu.py -- TRUEMENU deliverable 3: acceptance checks for the generated menu model.

Three modes, all completeness-protocol conformant:

1. MODEL CHECKS (default): run tools/harness/menu_model.lua against the LIVE game (read-only
   lua, no DF_LOCK) -- or load --model <json> -- and assert the screenshot-derived structural
   expectations in fixtures/truemenu_expected.json (the Menu Oracle Screenshots 2026-07-08).
   These are STRUCTURE assertions (category rows, per-category leaf lists, metal-list filters,
   ordering semantics), never pixel diffs and never world-generated names.

2. ORACLE DIFF (--oracle <snapshot.json>): differential-compare a menu_oracle.lua snapshot
   (DF's OWN filtered_button rows, taken while a native workshop sheet is open) against the
   generated model subtree for the same context. This is the oracle-differential gate the opus
   rollout must pass per category x metal (protocol rule 2: DF's native output is the oracle).

3. SELF-TEST (--self-test): test-the-test (protocol rule 3). Seeds three known-bad mutations
   into a fresh model (dropped leaf / illegal armor metal / broken leaf ordering) and requires
   that the model checks FAIL on every seed. A gate that has never failed is unvalidated.

Exit codes: 0 PASS, 1 FAIL, 2 CANNOT-RUN.
DF strings are CP437 -- model/oracle JSON is decoded accordingly.
"""

import argparse
import copy
import json
import os
import subprocess
import sys
import tempfile

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DF_ROOT = dfroot.df_root_for(__file__, purpose="compares our menus against DF's own")
FIXTURE = os.path.join(HERE, "fixtures", "truemenu_expected.json")
GEN_LUA = os.path.join(HERE, "menu_model.lua")


def load_cp437_json(path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("cp437"))


def load_served_json(path):
    # dwf.lua's json_string converts DF's CP437 strings to UTF-8 for the browser (the served
    # /workshop-info body is UTF-8), unlike menu_model.lua / menu_oracle.lua which emit raw CP437.
    # Decode accordingly so accented world-generated names (instrument reactions) compare equal.
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def run_generator(df_root):
    dfhack_run = os.path.join(df_root, "hack", "dfhack-run.exe")
    if not os.path.exists(dfhack_run):
        print(f"CANNOT RUN: {dfhack_run} not found")
        sys.exit(2)
    out = os.path.join(tempfile.gettempdir(), "truemenu_model.json")
    # NB: getJobs prints debug spew for smelters on stdout; the model goes to a file on purpose.
    proc = subprocess.run([dfhack_run, "lua", "-f", GEN_LUA.replace("\\", "/"), out.replace("\\", "/")],
                          capture_output=True, text=True, timeout=120)
    if not os.path.exists(out) or "menu_model: wrote" not in (proc.stdout or ""):
        print("CANNOT RUN: generator did not produce a model")
        print((proc.stdout or "")[-500:])
        print((proc.stderr or "")[-500:])
        sys.exit(2)
    return load_cp437_json(out)


# --------------------------------------------------------------------------------------------
class Checker:
    def __init__(self):
        self.results = []

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail))
        print(("PASS  " if ok else "FAIL  ") + name + (f"  -- {detail}" if detail and not ok else ""))
        return ok

    @property
    def failed(self):
        return [r for r in self.results if not r[1]]


def forge_of(model):
    for s in model.get("shops", []):
        if s.get("key") == "Workshop/MetalsmithsForge":
            return s
    return None


def cat_map(forge):
    return {c.get("label"): c for c in forge.get("root", [])}


def metal_labels(cat):
    return [m.get("label") for m in cat.get("metals", [])]


def leaves_of(cat, metal_label):
    for m in cat.get("metals", []):
        if m.get("label") == metal_label:
            return [l.get("label") for l in m.get("leaves", [])]
    return None


def is_prefix(prefix, seq):
    return seq[: len(prefix)] == prefix


def run_model_checks(model, exp, ck):
    forge = forge_of(model)
    if not ck.check("forge-shop-present", forge is not None):
        return
    cats = cat_map(forge)

    # 1. category rows: exact labels, exact order (oracle capture 16 = 8 rows for this fort civ;
    #    the empty INSTRUMENT / "Make instrument" category is HIDDEN -- B40).
    got = [c.get("label") for c in forge.get("root", [])]
    ck.check("forge-categories-exact-order", got == exp["forge_categories_in_order"],
             f"got {got}")
    ck.check("forge-root-row-count", len(got) == exp["forge_root_row_count"], f"got {len(got)}")
    for hidden in exp.get("instrument_categories_hidden_when_empty", []):
        ck.check(f"custom-category-hidden-when-empty[{hidden}]", hidden not in cats,
                 f"{hidden} present but should be hidden (empty civ-filtered leaf set)")

    # 2/3. metal lists per category (flag mapping differentially verified vs screenshots)
    wm = metal_labels(cats.get("Weapons and ammunition", {}))
    ck.check("weapons-metals-vanilla-prefix", is_prefix(exp["weapons_metals_vanilla_prefix"], wm),
             f"got {wm[:8]}")
    om = metal_labels(cats.get("Other objects", {}))
    ck.check("other-metals-vanilla-prefix", is_prefix(exp["other_metals_vanilla_prefix"], om),
             f"got {om[:26]}")
    am = metal_labels(cats.get("Armor", {}))
    bad = [m for m in exp["armor_metals_must_not_contain"] if m in am]
    ck.check("armor-metals-excludes-nonarmor", not bad, f"illegal metals present: {bad}")
    missing = [m for m in exp["armor_metals_must_contain"] if m not in am]
    ck.check("armor-metals-includes-armor-grade", not missing, f"missing: {missing}")

    # 4. metal ordering = inorganic raws index order (native order, screenshot-verified)
    for label in ("Weapons and ammunition", "Other objects"):
        idxs = [m.get("mat_index") for m in cats.get(label, {}).get("metals", [])]
        ck.check(f"metals-raws-index-order[{label}]",
                 all(a < b for a, b in zip(idxs, idxs[1:])), f"indices {idxs[:10]}")

    # 5. per-category leaf lists (NATIVE SOURCE ORDER -- B45; DF never alpha-sorts, alpha_order=0
    #    on every captured row). EXACT (ordered) where a leaf capture pins the order; SET (sorted)
    #    where no leaf capture exists (trap) or the captured metal differs (armor iron).
    for name, key in (("weapons", "Weapons and ammunition"), ("furniture", "Furniture"),
                      ("siege", "Siege equipment"), ("other", "Other objects")):
        want = exp[f"{name}_iron_leaves_exact"]
        got_l = leaves_of(cats.get(key, {}), "iron")
        ck.check(f"{name}-x-iron-leaves-exact-order", got_l == want, f"got {got_l}")
    # armor: iron order NOT captured -> SET equality; glowing-metal ORDER pinned by capture 07
    got_ai = leaves_of(cats.get("Armor", {}), "iron")
    ck.check("armor-x-iron-leaves-set", sorted(got_ai or []) == sorted(exp["armor_iron_leaves_set"]),
             f"got {got_ai}")
    got_ag = leaves_of(cats.get("Armor", {}), "glowing metal")
    ck.check("armor-x-glowing-metal-leaves-exact-order", got_ag == exp["armor_glowing_metal_leaves_exact"],
             f"got {got_ag}")
    # trap: leaf order NOT-VERIFIED (no trap leaf capture) -> SET equality only
    got_ti = leaves_of(cats.get("Trap components", {}), "iron")
    ck.check("trap-x-iron-leaves-set", sorted(got_ti or []) == sorted(exp["trap_iron_leaves_set"]),
             f"got {got_ti}")
    # B52: trap metal LIST == weapons metal LIST (native capture 20 = ITEMS_WEAPON only, 17 rows);
    # the ITEMS_HARD-only metals (gold/tin/lead/...) must NOT appear in the trap category.
    tm = metal_labels(cats.get("Trap components", {}))
    ck.check("trap-metals-equals-weapons", tm == wm, f"trap {tm[:6]} vs weapons {wm[:6]}")
    bad = [m for m in exp["trap_metals_must_not_contain"] if m in tm]
    ck.check("trap-metals-excludes-hard-only", not bad, f"HARD-only metals leaked into trap: {bad}")
    # OTHER over-emission guard (B44): slab / per-itemdef toys / puzzlebox / mini-forge must be gone
    got_oi = leaves_of(cats.get("Other objects", {}), "iron") or []
    bad = [l for l in exp["other_must_not_contain"] if l in got_oi]
    ck.check("other-x-iron-no-over-emission", not bad, f"over-emitted: {bad}")

    # 6. silver counterexample: no ranged weapons without ITEMS_WEAPON_RANGED
    sl = leaves_of(cats.get("Weapons and ammunition", {}), "silver") or []
    bad = [l for l in exp["weapons_silver_must_not_contain"] if l in sl]
    ck.check("weapons-x-silver-no-crossbow", not bad, f"illegal leaves: {bad}")

    # 7. metal clothing: SOFT metals only; stable leaf subset; no METAL-flag items
    mc = cats.get("Metal clothing", {})
    mcm = metal_labels(mc)
    ck.check("clothing-metals-contains-adamantine", "adamantine" in mcm, f"got {mcm}")
    ck.check("clothing-metals-no-hard-only-metal",
             not any(m in ("iron", "gold", "steel", "copper") for m in mcm), f"got {mcm}")
    cl = leaves_of(mc, "adamantine") or []
    # clothing adamantine: EXACT native order (capture 27 -- family blocks in entity-vector order)
    ck.check("clothing-x-adamantine-leaves-exact-order", cl == exp["clothing_adamantine_leaves_exact"],
             f"got {cl}")
    bad = [l for l in exp["clothing_must_not_contain"] if l in cl]
    ck.check("clothing-x-adamantine-no-armor-leak", not bad, f"leaked: {bad}")

    # 8. instrument custom category: LEAF-ONLY shape (B41 -- NO metal layer, leaves on the node
    #    directly), civ-filtered count (B40/B42 -- capture 28 = 9 fort-civ reactions). Only
    #    INSTRUMENT_PIECE survives for this fort (INSTRUMENT is hidden, checked in #1).
    c = cats.get("Make instrument piece", {})
    ck.check("custom-category[Make instrument piece]",
             c.get("kind") == "custom_category" and c.get("token") == "INSTRUMENT_PIECE",
             f"kind={c.get('kind')} token={c.get('token')}")
    cat_leaves = c.get("leaves")
    ck.check("instrument-piece-leaf-only-no-metal-layer",
             isinstance(cat_leaves, list) and len(cat_leaves) > 0 and not c.get("metals"),
             f"leaves={type(cat_leaves).__name__} metals={len(c.get('metals') or [])} (B41: must be leaf-only)")
    ck.check("instrument-piece-all-reactions",
             bool(cat_leaves) and all(l.get("kind") == "reaction" for l in cat_leaves),
             "not every instrument-piece leaf is a reaction")
    lbls = [l.get("label") for l in (cat_leaves or [])]
    ck.check("instrument-piece-leaf-count",
             len(lbls) == exp["instrument_piece_leaf_count_civ305"],
             f"got {len(lbls)} vs expected {exp['instrument_piece_leaf_count_civ305']}")
    miss = [l for l in exp["instrument_piece_leaves_ascii_civ305"] if l not in lbls]
    ck.check("instrument-piece-ascii-names-present", not miss, f"missing: {miss}")

    # 9. (removed) the v1 "leaves-alpha-sorted" self-consistency check was the B45 misreading --
    #    native never alpha-sorts; ordering is now asserted per-category against the captures above.

    # 10. whole-matrix coverage: all 33 shop types modeled; magma forge mirrors forge
    keys = {s.get("key") for s in model.get("shops", [])}
    ck.check("all-33-shop-types-present", len(keys) == 33, f"got {len(keys)}")
    magma = next((s for s in model["shops"] if s.get("key") == "Workshop/MagmaForge"), None)
    if ck.check("magma-forge-present", magma is not None):
        ck.check("magma-forge-mirrors-forge",
                 forge_signature(forge.get("root")) == forge_signature(magma.get("root")),
                 "magma forge tree diverges: " +
                 first_forge_diff(forge_signature(magma.get("root")), forge_signature(forge.get("root"))))
    empties = [s["key"] for s in model["shops"]
               if not s.get("root") and not s.get("known_gap") and not s.get("error")]
    ck.check("flat-shops-nonempty-or-flagged-gap", not empties, f"silent empties: {empties}")


# --------------------------------------------------------------------------------------------
# FLAT-SHOP checks (flatshop-executor): the non-forge native trees -- Smelter melt-first/raws-order,
# Craftsdwarf mixed root + rock submenu, Kennels (v50 Vermin Catcher). Derived from native captures
# 30/31/32/33 (fixtures flatshop_*). Exact-order assertions (DF never alpha-sorts these either).
def shop_by_key(model, key):
    for s in model.get("shops", []):
        if s.get("key") == key:
            return s
    return None


def first_pair_diff(got, want):
    for i in range(max(len(got), len(want))):
        a = got[i] if i < len(got) else "<<none>>"
        b = want[i] if i < len(want) else "<<none>>"
        if a != b:
            return f"row[{i}] got={a} want={b} (lens {len(got)}/{len(want)})"
    return ""


def run_flatshop_checks(model, exp, ck):
    # 1. Smelter: melt row FIRST, ores in inorganic raws-index order, reactions in raws order.
    sm = shop_by_key(model, "Furnace/Smelter")
    if ck.check("smelter-present", sm is not None):
        got = [n.get("label") for n in sm.get("root", [])]
        ck.check("smelter-root-exact-order", got == exp["flatshop_smelter_root_labels"],
                 first_pair_diff(got, exp["flatshop_smelter_root_labels"]))
        ck.check("smelter-melt-first", bool(got) and got[0] == "Melt a metal object", f"got {got[:1]}")
        idxs = [n.get("mat_index") for n in sm.get("root", []) if n.get("job_type") == "SmeltOre"]
        ck.check("smelter-ores-raws-index-order",
                 len(idxs) > 0 and all(a < b for a, b in zip(idxs, idxs[1:])), f"idxs {idxs}")
        # magma smelter mirrors the smelter shape (same reactions attach to its own building subtype)
        ms = shop_by_key(model, "Furnace/MagmaSmelter")
        ck.check("magma-smelter-present-and-shaped",
                 ms is not None and bool(ms.get("root")) and ms["root"][0].get("label") == "Melt a metal object")

    # 2. Kennels == v50 Vermin Catcher's Shop (2 rows).
    kn = shop_by_key(model, "Workshop/Kennels")
    if ck.check("kennels-vermin-catcher-present", kn is not None):
        got = [n.get("label") for n in kn.get("root", [])]
        ck.check("kennels-root-exact", got == exp["flatshop_kennels_root_labels"], f"got {got}")

    # 3. Craftsdwarf: MIXED root (material selectors + direct leaves + instrument categories), exact.
    cd = shop_by_key(model, "Workshop/Craftsdwarfs")
    if ck.check("craftsdwarf-present", cd is not None):
        pairs = [[n.get("kind"), n.get("label")] for n in cd.get("root", [])]
        want = [list(p) for p in exp["flatshop_craftsdwarf_root_pairs"]]
        ck.check("craftsdwarf-root-mixed-exact", pairs == want, first_pair_diff(pairs, want))
        sels = [n for n in cd.get("root", []) if n.get("kind") == "material_selector"]
        ck.check("craftsdwarf-4-material-selectors",
                 len(sels) == 4 and all(isinstance(s.get("leaves"), list) and s["leaves"] for s in sels),
                 f"got {len(sels)}")
        rock = next((s for s in sels if s.get("label") == "rock"), None)
        rl = [l.get("label") for l in rock.get("leaves", [])] if rock else None
        ck.check("craftsdwarf-rock-submenu-exact", rl == exp["flatshop_craftsdwarf_rock_leaves"],
                 first_pair_diff(rl or [], exp["flatshop_craftsdwarf_rock_leaves"]))
        # rock leaves carry the material pin the queue path needs (mat 0:-1 = any rock)
        if rock:
            ck.check("craftsdwarf-rock-leaves-material-pinned",
                     all(l.get("mat_type") == 0 and l.get("mat_index") == -1 for l in rock.get("leaves", [])),
                     "a rock leaf lost its material pin")
        cats = [n for n in cd.get("root", []) if n.get("kind") == "custom_category"]
        ck.check("craftsdwarf-instrument-categories-leaf-only",
                 len(cats) == 2 and all(c.get("leaves") and not c.get("metals") for c in cats),
                 f"got {len(cats)} custom categories")
        ck.check("craftsdwarf-instrument-leaves-are-reactions",
                 all(all(l.get("kind") == "reaction" for l in c.get("leaves", [])) for c in cats))


# --------------------------------------------------------------------------------------------
# MONTAGE oracle (wp3-executor): a SECOND, independent oracle -- the 9 forge montage shots from a
# DIFFERENT world/civ. Only civ/world-INDEPENDENT cells are gated (root category order as an ordered
# subsequence; the weapons/armor/furniture/siege/trap iron leaf SETS). Leaf ORDER is NOT gated (the
# montages are alphabetized, the button[] captures are raws order) and montage METAL lists are NOT
# gated (reused weapons crop). See fixtures montage_iron.provenance.
def is_ordered_subsequence(sub, seq):
    it = iter(seq)
    return all(x in it for x in sub)


def run_montage_checks(model, exp, ck):
    m = exp.get("montage_iron")
    if not m:
        return
    forge = forge_of(model)
    if not ck.check("montage-forge-present", forge is not None):
        return
    cats = cat_map(forge)
    # root category ORDER: the model's forge categories are an ordered subsequence of the montage's
    # (ENT305 has 8 categories -- 'Make instrument' empty/hidden; the montage world has 9).
    model_cats = [c.get("label") for c in forge.get("root", [])]
    ck.check("montage-root-categories-subsequence",
             is_ordered_subsequence(model_cats, m["root_categories"]),
             f"model {model_cats} is not an ordered subsequence of montage {m['root_categories']}")
    # civ/world-independent iron leaf SETS (order NOT portable -> set equality only).
    for name, key, setkey in (("weapons", "Weapons and ammunition", "weapons_iron_set"),
                              ("armor", "Armor", "armor_iron_set"),
                              ("furniture", "Furniture", "furniture_iron_set"),
                              ("siege", "Siege equipment", "siege_iron_set"),
                              ("trap", "Trap components", "trap_iron_set")):
        got = leaves_of(cats.get(key, {}), "iron") or []
        want = m[setkey]
        ck.check(f"montage-{name}-x-iron-set", sorted(got) == sorted(want),
                 f"missing={sorted(set(want) - set(got))} extra={sorted(set(got) - set(want))}")


# --------------------------------------------------------------------------------------------
# SERVED-TREE equivalence (WP-1): the dwf.lua forge tree served over /workshop-info as
# `taskTree` is a PORT of menu_model.lua's forge_root, but serialized in camelCase for the browser
# client. This mode proves the served tree is equivalent to the generator's (screenshot-verified,
# gate-blessed) forge subtree, so it inherits the 27/27 guarantee, and re-runs the full model
# checks with the SERVED data substituted into the forge slots (so every forge check exercises
# server-produced rows, not the generator's).
_SNAKE = {
    "matIndex": "mat_index", "matType": "mat_type", "dfCategory": "df_category",
    "itemType": "item_type", "itemSubtype": "item_subtype", "subtypeToken": "subtype_token",
    "reactionCode": "reaction_code", "jobType": "job_type",
}


def snake(obj):
    """Recursively rename served camelCase keys to the generator's snake_case."""
    if isinstance(obj, list):
        return [snake(v) for v in obj]
    if isinstance(obj, dict):
        return {_SNAKE.get(k, k): snake(v) for k, v in obj.items()}
    return obj


def forge_signature(root):
    """The menu-relevant shape of a forge root: category labels/tokens x metal labels+index x
    leaf labels, in order. Two roots with equal signatures render identical native menus. Leaf-only
    categories (instruments, B41) carry their leaves directly (cat_leaves) instead of metals."""
    sig = []
    for c in root or []:
        metals = [(m.get("label"), m.get("mat_index"),
                   [l.get("label") for l in m.get("leaves", [])]) for m in c.get("metals", [])]
        cat_leaves = [l.get("label") for l in c["leaves"]] if isinstance(c.get("leaves"), list) else None
        sig.append((c.get("label"), c.get("df_category"), c.get("token"), c.get("kind"), metals, cat_leaves))
    return sig


def first_forge_diff(a, b):
    """Human-readable first point of divergence between two forge signatures (category ->
    metal -> leaf), so a seeded/real mismatch names the exact cell, not just the category label."""
    for ci in range(max(len(a), len(b))):
        if ci >= len(a) or ci >= len(b):
            return f"category count {len(a)} vs {len(b)}"
        (la, dca, ta, ka, ma, cla), (lb, dcb, tb, kb, mb, clb) = a[ci], b[ci]
        if (la, dca, ta, ka) != (lb, dcb, tb, kb):
            return f"cat[{ci}] header served={(la, dca, ta, ka)} gen={(lb, dcb, tb, kb)}"
        if cla != clb:  # leaf-only category (instruments): compare category-level leaves
            for li in range(max(len(cla or []), len(clb or []))):
                xa = (cla or [])[li] if li < len(cla or []) else "<<none>>"
                xb = (clb or [])[li] if li < len(clb or []) else "<<none>>"
                if xa != xb:
                    return f"cat[{ci}]({la}) leaf-only leaf[{li}] served={xa!r} gen={xb!r}"
        for mi in range(max(len(ma), len(mb))):
            if mi >= len(ma) or mi >= len(mb):
                return f"cat[{ci}]({la}) metal count {len(ma)} vs {len(mb)}"
            (mla, mia, lfa), (mlb, mib, lfb) = ma[mi], mb[mi]
            if (mla, mia) != (mlb, mib):
                return f"cat[{ci}]({la}) metal[{mi}] served=({mla},{mia}) gen=({mlb},{mib})"
            if lfa != lfb:
                for li in range(max(len(lfa), len(lfb))):
                    xa = lfa[li] if li < len(lfa) else "<<none>>"
                    xb = lfb[li] if li < len(lfb) else "<<none>>"
                    if xa != xb:
                        return f"cat[{ci}]({la})/metal({mla}) leaf[{li}] served={xa!r} gen={xb!r}"
    return "sigs differ (unlocated)"


def run_served_diff(base_model, served, ck):
    served = snake(served)
    served_root = served.get("root")
    if not ck.check("served-has-forge-root", isinstance(served_root, list) and served_root,
                    f"served payload: {list(served.keys())}"):
        return base_model
    base_forge = forge_of(base_model)
    if not ck.check("base-generator-forge-present", base_forge is not None):
        return base_model
    # 1. signature equivalence: served == generator (the load-bearing equivalence assertion)
    sig_served, sig_gen = forge_signature(served_root), forge_signature(base_forge.get("root"))
    if sig_served != sig_gen:
        ck.check("served-tree-equals-generator", False,
                 "served forge tree diverges from generator: " + first_forge_diff(sig_served, sig_gen))
    else:
        ck.check("served-tree-equals-generator", True)
    # 2. substitute served root into BOTH forge slots and re-run the full model checks on it,
    #    so the 27 structural assertions run against server-produced rows.
    sub = copy.deepcopy(base_model)
    for s in sub.get("shops", []):
        if s.get("key") in ("Workshop/MetalsmithsForge", "Workshop/MagmaForge"):
            s["root"] = copy.deepcopy(served_root)
    return sub


# --------------------------------------------------------------------------------------------
def normalize_label(s):
    if s is None:
        return ""
    s = s.lower().strip()
    for suffix in (" (opens menu)",):
        if s.endswith(suffix):
            s = s[: -len(suffix)]
    return " ".join(s.split())


def run_oracle_diff(model, oracle, ck):
    """Compare a native menu_oracle snapshot against the model subtree for the same context."""
    if not oracle.get("open"):
        print("CANNOT RUN: oracle snapshot has no open menu (building.button empty). "
              "Open the workshop add-task menu in native DF and re-snapshot.")
        sys.exit(2)
    forge = forge_of(model)
    b = oracle["building"]
    # NATIVE DISPLAY ORDER is button[] (alpha_order=0 = alpha toggle OFF; B45). filtered_button is
    # the search/sorted view and must NOT be used for the ordering assertion. Drop the trailing
    # navigation row(s) (leave_button -- the "(opens menu)" back / material sub-selector).
    all_rows = b.get("button") or b.get("filtered_button") or []
    rows = [r for r in all_rows if not r.get("leave_button")]
    native = [normalize_label(r.get("text") or r.get("filter_str")) for r in rows]
    classes = {r.get("class") for r in rows}

    cat_name = b.get("category")
    token = b.get("current_custom_category_token") or ""
    # locate the model node for this context (df_category, or custom-category token)
    node = next((c for c in forge["root"]
                 if c.get("df_category") == cat_name or (token and c.get("token") == token)), None)
    if any("category_selector" in c for c in classes):
        want = [normalize_label(c["label"]) for c in forge["root"]]
        ck.check("oracle-root-categories-order", native == want, f"native {native} vs model {want}")
    elif any("material_selector" in c for c in classes):
        if ck.check("oracle-category-located", node is not None, f"category={cat_name} token={token}"):
            want = [normalize_label(m["label"]) for m in node.get("metals", [])]
            ck.check(f"oracle-metal-list[{node['label']}]", native == want,
                     f"native({len(native)}) vs model({len(want)}); "
                     f"missing={set(want)-set(native)} extra={set(native)-set(want)}")
    elif any("new_job" in c for c in classes):
        # leaf-only category (instruments, B41): leaves live on the node; else pick the metal branch
        want = None
        if node is not None and isinstance(node.get("leaves"), list) and not node.get("metals"):
            want = [normalize_label(l["label"]) for l in node["leaves"]]
            ck.check(f"oracle-leaves-leaf-only[{node['label']}]", native == want,
                     f"missing={set(want)-set(native)} extra={set(native)-set(want)}")
        else:
            mat = b.get("matgloss")
            branch = next((m for m in node.get("metals", []) if m.get("mat_index") == mat), None) if node else None
            if ck.check("oracle-leaf-context-located", branch is not None,
                        f"category={cat_name} matgloss={mat}"):
                want = [normalize_label(l["label"]) for l in branch.get("leaves", [])]
                ck.check(f"oracle-leaves[{node['label']}/{branch['label']}]", native == want,
                         f"order-or-set diff -- missing={set(want)-set(native)} extra={set(native)-set(want)}"
                         + ("" if sorted(want) != sorted(native) else " (SET equal, ORDER differs)"))
        # availability ground truth present on native rows (B43 fixture data)
        n_obj = sum(1 for r in rows if r.get("objection"))
        print(f"INFO  native rows with objection (unavailable/orange): {n_obj}/{len(rows)}")
    else:
        ck.check("oracle-known-button-classes", False, f"unrecognized classes: {classes}")


# --------------------------------------------------------------------------------------------
def run_self_test(model, exp):
    """Protocol rule 3: the checks must FAIL on seeded known-bad models."""
    seeds = []

    bad1 = copy.deepcopy(model)
    cats = cat_map(forge_of(bad1))
    for m in cats["Weapons and ammunition"]["metals"]:
        if m["label"] == "iron":
            m["leaves"] = [l for l in m["leaves"] if l["label"] != "Forge iron mace"]
    seeds.append(("seed-dropped-leaf (Forge iron mace removed)", bad1))

    bad2 = copy.deepcopy(model)
    cats = cat_map(forge_of(bad2))
    wm = cats["Weapons and ammunition"]["metals"]
    silver = next(m for m in wm if m["label"] == "silver")
    cats["Armor"]["metals"].insert(1, copy.deepcopy(silver))
    seeds.append(("seed-illegal-armor-metal (silver injected)", bad2))

    bad3 = copy.deepcopy(model)
    cats = cat_map(forge_of(bad3))
    for m in cats["Furniture"]["metals"]:
        if m["label"] == "iron":
            m["leaves"] = list(reversed(m["leaves"]))
    seeds.append(("seed-broken-order (furniture x iron reversed)", bad3))

    # seed 4: the silver-pick generator bug (digger_type not gated on ITEMS_DIGGER) -- inject the
    # exact leaf the pre-fix generator emitted; the silver must-not-contain check has to catch it.
    bad4 = copy.deepcopy(model)
    cats = cat_map(forge_of(bad4))
    for m in cats["Weapons and ammunition"]["metals"]:
        if m["label"] == "silver":
            m["leaves"] = m["leaves"] + [{"label": "Forge silver pick"}]
    seeds.append(("seed-illegal-digger (Forge silver pick injected)", bad4))

    # seed 5 (B41): the pre-fix instrument shape -- a metal layer wrapping the reactions instead of
    # leaf-only. The leaf-only check must catch it.
    bad5 = copy.deepcopy(model)
    cats = cat_map(forge_of(bad5))
    ip = cats.get("Make instrument piece")
    if ip is not None:
        ip["metals"] = [{"label": "iron", "mat_index": 0, "leaves": ip.get("leaves", [])}]
        ip.pop("leaves", None)
    seeds.append(("seed-instrument-metal-layer (B41: leaf-only violated)", bad5))

    # seed 6 (B40): the pre-fix 9-category root -- re-add the empty "Make instrument" category. The
    # root-count / hidden-when-empty checks must catch it.
    bad6 = copy.deepcopy(model)
    forge6 = forge_of(bad6)
    forge6["root"].append({"kind": "custom_category", "label": "Make instrument",
                           "token": "INSTRUMENT", "leaves": [{"kind": "reaction", "label": "x"}]})
    seeds.append(("seed-9th-category (B40: empty instrument category shown)", bad6))

    # seed 7 (B45): the pre-fix alpha_sort -- sort OTHER x iron leaves alphabetically. The
    # native-order check must catch it.
    bad7 = copy.deepcopy(model)
    cats = cat_map(forge_of(bad7))
    for m in cats["Other objects"]["metals"]:
        if m["label"] == "iron":
            m["leaves"] = sorted(m["leaves"], key=lambda l: l.get("label", ""))
    seeds.append(("seed-alpha-sorted (B45: OTHER x iron alphabetized)", bad7))

    # seed 8 (B44): the pre-fix OTHER over-emission -- inject a slab row. The over-emission guard
    # must catch it.
    bad8 = copy.deepcopy(model)
    cats = cat_map(forge_of(bad8))
    for m in cats["Other objects"]["metals"]:
        if m["label"] == "iron":
            m["leaves"] = m["leaves"] + [{"label": "Make iron slab"}]
    seeds.append(("seed-other-over-emission (B44: iron slab injected)", bad8))

    # seed 8b (B52): inject a HARD-only metal (gold) into the TRAP metal list -- the pre-fix
    # over-emission (ITEMS_WEAPON+ITEMS_HARD). trap-metals-equals-weapons / -excludes-hard-only must catch.
    bad8b = copy.deepcopy(model)
    cats = cat_map(forge_of(bad8b))
    wm_ = cats["Weapons and ammunition"]["metals"]
    gold = next((m for m in cat_map(forge_of(model))["Other objects"]["metals"] if m["label"] == "gold"), None)
    if gold is not None:
        cats["Trap components"]["metals"].insert(1, copy.deepcopy(gold))
        seeds.append(("seed-trap-hard-metal (B52: gold injected into trap list)", bad8b))

    # ---- flat-shop seeds (flatshop-executor): the flat-shop checks must fail on these ----------
    # seed 9: Smelter melt row NOT first (moved to the end) -- melt-first + exact-order must catch.
    bad9 = copy.deepcopy(model)
    sm = shop_by_key(bad9, "Furnace/Smelter")
    if sm and sm.get("root"):
        sm["root"].append(sm["root"].pop(0))
    seeds.append(("seed-smelter-melt-not-first (melt moved to end)", bad9))

    # seed 10: Smelter alpha-sorted (the pre-fix flat_root behaviour) -- exact-order must catch.
    bad10 = copy.deepcopy(model)
    sm = shop_by_key(bad10, "Furnace/Smelter")
    if sm and sm.get("root"):
        sm["root"] = sorted(sm["root"], key=lambda n: (n.get("label") or "").lower())
    seeds.append(("seed-smelter-alpha-sorted (B45 flat_root regression)", bad10))

    # seed 11: Craftsdwarf drops the rock material selector -- mixed-root + 4-selectors must catch.
    bad11 = copy.deepcopy(model)
    cd = shop_by_key(bad11, "Workshop/Craftsdwarfs")
    if cd and cd.get("root"):
        cd["root"] = [n for n in cd["root"] if not (n.get("kind") == "material_selector" and n.get("label") == "rock")]
    seeds.append(("seed-craftsdwarf-drop-rock-selector", bad11))

    # seed 12: Craftsdwarf rock submenu reversed -- rock-submenu-exact must catch.
    bad12 = copy.deepcopy(model)
    cd = shop_by_key(bad12, "Workshop/Craftsdwarfs")
    if cd:
        for n in cd.get("root", []):
            if n.get("kind") == "material_selector" and n.get("label") == "rock":
                n["leaves"] = list(reversed(n.get("leaves", [])))
    seeds.append(("seed-craftsdwarf-rock-reversed", bad12))

    # seed 13 (wp3-executor): montage oracle -- inject a leaf absent from the montage weapons iron
    # SET. The independent montage set-equality check (montage-weapons-x-iron-set) must catch it.
    bad13 = copy.deepcopy(model)
    cats = cat_map(forge_of(bad13))
    for mm in cats["Weapons and ammunition"]["metals"]:
        if mm["label"] == "iron":
            mm["leaves"] = mm["leaves"] + [{"label": "Forge iron flail"}]
    seeds.append(("seed-montage-weapons-extra-leaf (Forge iron flail not in montage set)", bad13))

    all_ok = True
    for name, bad in seeds:
        print(f"\n== self-test {name} ==")
        ck = Checker()
        run_model_checks(bad, exp, ck)
        run_flatshop_checks(bad, exp, ck)
        run_montage_checks(bad, exp, ck)
        caught = bool(ck.failed)
        print(("SELF-TEST PASS  " if caught else "SELF-TEST FAIL  ") + name +
              ("" if caught else "  -- gate did NOT fail on a known-bad model"))
        all_ok = all_ok and caught
    return all_ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--df-root", default=DEFAULT_DF_ROOT)
    ap.add_argument("--model", help="path to an existing menu_model.lua output (skips live generation)")
    ap.add_argument("--oracle", help="path to a menu_oracle.lua snapshot (raw CP437) to diff "
                    "against the model -- the LEGACY, crash-prone RPC-lua live-read path")
    ap.add_argument("--menu-oracle", help="path to a /menu-oracle C++ route snapshot (UTF-8) to "
                    "diff against the model -- B37 crash-safe render-thread replacement for --oracle; "
                    "identical schema, only the byte encoding differs (served body is UTF-8)")
    ap.add_argument("--served", help="path to a dwf.lua forge_task_tree_json dump "
                    "(the served /workshop-info taskTree); checks it equals the generator + runs "
                    "the full model checks against the SERVED rows (WP-1 acceptance)")
    ap.add_argument("--self-test", action="store_true", help="run the test-the-test seeded-bad pass")
    args = ap.parse_args()

    exp = json.load(open(FIXTURE, encoding="utf-8"))
    model = load_cp437_json(args.model) if args.model else run_generator(args.df_root)

    ck = Checker()
    if args.served:
        # substitute the served forge tree into the model, then check everything against it
        model = run_served_diff(model, load_served_json(args.served), ck)

    if args.self_test:
        ok = run_self_test(model, exp)
        sys.exit(0 if ok else 1)

    run_model_checks(model, exp, ck)
    run_flatshop_checks(model, exp, ck)
    run_montage_checks(model, exp, ck)
    if args.oracle:
        run_oracle_diff(model, load_cp437_json(args.oracle), ck)
    if args.menu_oracle:
        # B37: the /menu-oracle route snapshots on the render thread and its body is UTF-8
        # (dwf json_escape runs DF2UTF), so decode as UTF-8, not CP437. Same schema.
        run_oracle_diff(model, load_served_json(args.menu_oracle), ck)

    n_fail = len(ck.failed)
    print(f"\n{len(ck.results)} checks, {n_fail} failed")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
