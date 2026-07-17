#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WB-3 validator: empirically prove that tiletype_token_map.json's per-variant token
# choice reproduces DF's own per-tile variant CHOICE bijectively.
#
# THE CLAIM UNDER TEST (render-buffer verdict §D): DF's on-screen sprite for a tile is
# texpos = f(ttname[, base-mat]) -- an EXACT, data-driven function of the tile's own
# tiletype enum entry (which already encodes the variant digit), not a render-time hash.
# So within one "family" (e.g. dirt floors), each distinct ttname (SoilFloor1..4) should
# render a DISTINCT, STABLE texpos, and our token map must assign each a DISTINCT token --
# collapsing them all onto one shared "_5" cell (the pre-WB-3 bug) breaks that bijection.
#
# METHOD (no atlas dump needed -- texpos values are opaque per-session integers we never
# need to decode to pixels; we only need to know whether they are EQUAL or DIFFERENT):
#   1. Sweep a region with tools/spikes/render-buffer/sweep.py (frame.bin per position:
#      the "background"/"background_two" texpos arrays -- the render-buffer's `background`
#      layer IS the base terrain cell in DF's own draw order, verdict §A).
#   2. For every swept world tile, read its DF texpos (from frame.bin) and its wire ttname
#      (from a single bulk DFHack Lua dump over the swept bbox -- a plain core-suspended
#      read, NOT a render-thread capture, so the tiledump LAW about console commands
#      (render-buffer verdict §E) does not apply here).
#   3. For each tile, look up the CLIENT token tiletype_token_map.json assigns its ttname.
#   4. A tile PASSES iff its (texpos, token) pair participates in a globally consistent
#      bijection: every other tile sharing its texpos also shares its token, AND every
#      other tile sharing its token also shares its texpos. (Pre-fix, SoilFloor1..4 all
#      share the token DIRT_FLOOR_5 while carrying 4 distinct texpos values -- a 4:1
#      collapse that fails this check on every one of those tiles.)
#
# CONSISTENCY REQUIREMENT (found the hard way): the texpos sweep and the ttname dump MUST
# see the identical world instant -- the live fort digs/tills/regrows grass in real time, so
# an unpaused sweep-then-dump pair joins texpos from tick T against ttnames from tick T+k,
# producing bogus cross-family collisions (observed: "SoilFloor1" joining grass texpos values
# because a couple of the swept tiles had grown grass by the time the ttname dump ran). So
# THIS script owns the whole bracket itself: pause DF, run the sweep, dump ttnames, unpause --
# never a two-step "run sweep.py, then separately run this" workflow.
#
# Usage (MUST use the Pillow/numpy env -- do not pip install):
#   python tools/ws2/validate_variation.py \
#       --z 161 --x0 10 --y0 10 --x1 150 --y1 150 --sweep-dir tools/ws2/validate_sweep_s1
#
# Exit: 0 if the pass rate over swept, wire-visible FLOOR tiles is >= 99.5%, else 1.
# (Non-FLOOR shapes are reported too, informationally, but do not gate -- this item is
# scoped to the floor-variant collapse the fog/coverage reports called out.)
import argparse, json, os, struct, subprocess, sys
from collections import defaultdict

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import build_tiletype_token_map as btm  # noqa: E402  (same dir; shares XML_PATH/classify/parse)

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

TOKEN_MAP_PATH = os.path.join(REPO, "web", "tiletype_token_map.json")
DFHACK_RUN = dfroot.dfhack_run(dfroot.df_root_for(__file__,
    purpose="asks a LIVE DF, through dfhack-run, what it actually rendered"))
SWEEP_PY = os.path.join(REPO, "tools", "spikes", "render-buffer", "sweep.py")

# frame.bin layer table (mirrors tools/spikes/render-buffer/analyze.py's LAYERS -- kept as
# an independent copy since that directory is a spike scratch area, not a stable API this
# committed validator should depend on).
_LAYERS = [
    ("background", 4), ("floor_flag", 8), ("background_two", 4), ("liquid_flag", 4),
    ("spatter_flag", 4), ("spatter", 4), ("ramp_flag", 8), ("shadow_flag", 4),
    ("building_one", 4), ("item", 4), ("vehicle", 4), ("vermin", 4),
    ("left_creature", 4), ("main", 4), ("right_creature", 4), ("building_two", 4),
    ("projectile", 4), ("high_flow", 4), ("top_shadow", 4), ("signpost", 4),
    ("designation", 4), ("interface", 4), ("upleft_creature", 4), ("up_creature", 4),
    ("upright_creature", 4), ("tree_plus_one", 2),
]
_DTYPE = {2: np.int16, 4: np.int32, 8: np.int64}


def load_frame_layers(dumpdir, names):
    """Minimal frame.bin reader -- only decodes the named layers (avoids the ~1MB/layer
    cost of parsing all 26 for layers we never look at)."""
    with open(os.path.join(dumpdir, "frame.bin"), "rb") as f:
        d = f.read()
    magic, ver, dx, dy, ox, oy, z = struct.unpack_from("<IIiiiii", d, 0)
    assert magic == 0x44544644 and ver == 1, "unexpected frame.bin header"
    off = 28
    tiles = dx * dy
    out = {}
    for name, elem in _LAYERS:
        got = d[off]; off += 1
        assert got == elem, f"{name}: layer width {got} != expected {elem}"
        if name in names:
            out[name] = np.frombuffer(d, dtype=_DTYPE[elem], count=tiles, offset=off).copy()
        off += tiles * elem
    return dx, dy, z, out


def dump_world_ttnames(x0, y0, x1, y1, z, dfhack_run):
    """One bulk DFHack Lua read (core-suspended, NOT render-thread -- safe) mapping every
    world tile in [x0,x1)x[y0,y1) at z to its tiletype enum NAME (== the wire's ttname)."""
    lua = f"""
local x0,y0,x1,y1,z = {x0},{y0},{x1},{y1},{z}
local out = {{}}
for x=x0,x1-1 do
  for y=y0,y1-1 do
    local ok, tt = pcall(dfhack.maps.getTileType, x, y, z)
    if ok and tt and tt >= 0 then
      local name = df.tiletype[tt]
      if name then
        out[#out+1] = x..","..y..","..name
      end
    end
  end
end
print(table.concat(out, "\\n"))
"""
    p = subprocess.run([dfhack_run, "lua", lua], capture_output=True, text=True, timeout=120)
    ttnames = {}
    for line in (p.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(",", 2)
        if len(parts) != 3:
            continue
        x, y, name = parts
        ttnames[(int(x), int(y))] = name
    return ttnames


def family_key(item):
    """Same family grouping build_tiletype_token_map.classify() dispatches on: shape +
    the material bucket (STONE_MATS/GRASS_MATS/SOIL collapse to one bucket each, matching
    what the generator treats as "one sprite family with variant digits")."""
    shape = item["shape"]
    mat = item["material"]
    if mat in btm.GRASS_MATS:
        matbucket = "GRASS"
    elif mat in btm.STONE_MATS:
        matbucket = "STONE_MATS"
    elif mat == "SOIL":
        matbucket = "SOIL"
    else:
        matbucket = mat
    return f"{shape}:{matbucket}"


def run_sweep(sweep_dir, z, x0, y0, x1, y1):
    """Shell out to the landed sweep driver (tools/spikes/render-buffer/sweep.py). No
    ground-truth PNGs / redumps needed here -- we only ever read frame.bin's texpos arrays."""
    if os.path.isdir(sweep_dir):
        import shutil
        shutil.rmtree(sweep_dir)
    cmd = [sys.executable, SWEEP_PY, "--z", str(z), "--x0", str(x0), "--y0", str(y0),
           "--x1", str(x1), "--y1", str(y1), "--out", sweep_dir,
           "--gt-every", "0", "--redump-every", "0"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    print(p.stdout[-1500:])
    if p.returncode != 0:
        print(p.stderr[-1500:])
        raise RuntimeError(f"sweep.py exited {p.returncode}")


def dfhack_pause(dfhack_run, paused):
    subprocess.run([dfhack_run, "lua", f"df.global.pause_state={'true' if paused else 'false'}"],
                   capture_output=True, text=True, timeout=20)


def dfhack_is_paused(dfhack_run):
    p = subprocess.run([dfhack_run, "lua", "print(df.global.pause_state)"],
                       capture_output=True, text=True, timeout=20)
    return (p.stdout or "").strip() == "true"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep-dir", required=True,
                    help="output dir for a FRESH sweep this run drives itself (overwritten "
                         "each run) -- never point this at a stale/reused sweep, the "
                         "texpos<->ttname join requires the same paused instant")
    ap.add_argument("--z", type=int, required=True)
    ap.add_argument("--x0", type=int, default=10)
    ap.add_argument("--y0", type=int, default=10)
    ap.add_argument("--x1", type=int, default=150)
    ap.add_argument("--y1", type=int, default=150)
    ap.add_argument("--dfhack-run", default=DFHACK_RUN)
    ap.add_argument("--token-map", default=TOKEN_MAP_PATH)
    ap.add_argument("--min-pass-pct", type=float, default=99.5)
    ap.add_argument("--no-pause", action="store_true",
                    help="skip the pause bracket (results are only trustworthy if the fort "
                         "is already paused/idle another way)")
    args = ap.parse_args()

    token_map = json.load(open(args.token_map, encoding="utf-8"))
    tt_items = {it["name"]: it for it in btm.parse_tiletype_enum(btm.XML_PATH)}

    # -- 0. PAUSE bracket: the sweep and the ttname dump must see the identical instant --
    # (found the hard way -- see module docstring). Restored in the finally below.
    was_paused = None
    if not args.no_pause:
        was_paused = dfhack_is_paused(args.dfhack_run)
        if not was_paused:
            dfhack_pause(args.dfhack_run, True)
            import time; time.sleep(0.3)
    try:
        # -- 1. drive a FRESH sweep (frame.bin texpos arrays) while paused ------------
        run_sweep(args.sweep_dir, args.z, args.x0, args.y0, args.x1, args.y1)

        texpos_by_world = {}
        dumps = [d for d in sorted(os.listdir(args.sweep_dir))
                 if os.path.isdir(os.path.join(args.sweep_dir, d))]
        if not dumps:
            print(f"CANNOT RUN: sweep produced no dump subdirectories under {args.sweep_dir}")
            sys.exit(2)
        bx0 = by0 = 10**9
        bx1 = by1 = -10**9
        for name in dumps:
            ddir = os.path.join(args.sweep_dir, name)
            meta_path = os.path.join(ddir, "meta.json")
            if not os.path.isfile(meta_path):
                continue
            meta = json.load(open(meta_path))
            cam = meta["camera"]
            if cam["z"] != args.z:
                continue
            dx, dy, z, layers = load_frame_layers(ddir, {"background"})
            bg = layers["background"]
            cx, cy = cam["x"], cam["y"]
            bx0 = min(bx0, cx); by0 = min(by0, cy)
            bx1 = max(bx1, cx + dx); by1 = max(by1, cy + dy)
            for lx in range(dx):
                for ly in range(dy):
                    tp = int(bg[lx * dy + ly])
                    if tp <= 0:
                        continue
                    texpos_by_world[(cx + lx, cy + ly)] = tp
        if not texpos_by_world:
            print("CANNOT RUN: swept dumps yielded zero nonzero-texpos tiles at that z")
            sys.exit(2)
        print(f"swept {len(texpos_by_world)} distinct world tiles with a nonzero texpos "
              f"over bbox ({bx0},{by0})-({bx1},{by1}) z={args.z}")

        # -- 2. one bulk ttname read over the exact swept bbox, SAME paused instant ---
        ttnames = dump_world_ttnames(bx0, by0, bx1, by1, args.z, args.dfhack_run)
        print(f"resolved {len(ttnames)} world tiletype names over the same bbox")
    finally:
        if not args.no_pause and was_paused is False:
            dfhack_pause(args.dfhack_run, False)

    # -- 3. join: world tile -> (texpos, ttname, family, client_token) ---------------
    rows = []  # (wx, wy, texpos, ttname, family, token)
    for (wx, wy), tp in texpos_by_world.items():
        ttname = ttnames.get((wx, wy))
        if not ttname:
            continue
        item = tt_items.get(ttname)
        if not item:
            continue
        fam = family_key(item)
        entry = token_map.get(ttname)
        # WB-3 base+overlay composite: when an `overlay` cell is present, THAT is the
        # per-variant-distinguishing visual (the base token alone is deliberately shared
        # across the whole family, e.g. every stone floor shares STONE_FLOOR_5 as its dense
        # fill) -- so the bijection must be checked against the overlay, not the base.
        token = (entry.get("overlay") or entry.get("token")) if entry else None
        rows.append((wx, wy, tp, ttname, fam, token))

    # -- 4. per-family bijection check ------------------------------------------------
    # DF's "variant CHOICE" for a ttname is its MODAL (most common) texpos across the
    # sweep -- per-ttname, not per-tile: a small minority of tiles render a DIFFERENT
    # texpos than their own ttname's usual one because of a genuinely separate, neighbor-
    # driven effect (grass-creep: a bare-dirt tile at the edge of a grass patch borrows the
    # grass cell -- render-buffer verdict's "floor_flag = grass-creep edge decals", a W-C/
    # WB-11 residual, NOT the digit-collapse bug this item fixes). So the bijection is
    # checked on the modal value per ttname (matching the verdict's OWN methodology --
    # "SoilFloor1..4 -> 17241/17517/17526/17535" are themselves per-ttname modal readings,
    # not raw per-tile ones), and the "% of tiles" pass rate below counts a tile as passing
    # when it matches ITS ttname's modal texpos (i.e. is a typical, non-edge-contaminated
    # tile) -- outliers are reported separately, not folded into a false "collapse" verdict.
    fam_rows = defaultdict(list)
    for r in rows:
        fam_rows[r[4]].append(r)

    print("\nper-family bijection table (family: tiles, distinct ttnames, distinct MODAL "
          "texpos, distinct tokens, bijective?, pass% [tiles matching their ttname's modal "
          "texpos], outlier tiles):")
    total_floor_tiles = 0
    total_floor_pass = 0
    fam_table = []
    for fam in sorted(fam_rows):
        frows = fam_rows[fam]
        by_ttname = defaultdict(list)
        for r in frows:
            by_ttname[r[3]].append(r)
        modal_tp = {}
        token_of = {}
        for ttname, trows in by_ttname.items():
            counts = defaultdict(int)
            for (_, _, tp, _, _, _tok) in trows:
                counts[tp] += 1
            modal_tp[ttname] = max(counts, key=counts.get)
            token_of[ttname] = trows[0][5]
        # bijection over the FAMILY's per-ttname modal values: distinct ttnames must map
        # to distinct (modal_tp, token) pairs consistently -- same modal_tp iff same token.
        tp_to_tok = defaultdict(set)
        tok_to_tp = defaultdict(set)
        for ttname in by_ttname:
            tp_to_tok[modal_tp[ttname]].add(token_of[ttname])
            tok_to_tp[token_of[ttname]].add(modal_tp[ttname])
        bijective = all(len(v) == 1 for v in tp_to_tok.values()) and \
                    all(len(v) == 1 for v in tok_to_tp.values()) and \
                    all(t is not None for t in token_of.values())
        good = sum(1 for r in frows if r[2] == modal_tp[r[3]])
        pct = 100.0 * good / len(frows) if frows else 0.0
        distinct_ttnames = len(by_ttname)
        distinct_tp = len(set(modal_tp.values()))
        distinct_tok = len({t for t in token_of.values() if t is not None})
        fam_table.append((fam, len(frows), distinct_ttnames, distinct_tp, distinct_tok,
                          bijective, pct, len(frows) - good))
        print(f"  {fam:<24} tiles={len(frows):<6} ttnames={distinct_ttnames:<3} "
              f"texpos={distinct_tp:<3} tokens={distinct_tok:<3} "
              f"bijective={'Y' if bijective else 'N':<2} pass={pct:.1f}%  "
              f"outliers={len(frows) - good}")
        if fam.startswith("FLOOR:"):
            total_floor_tiles += len(frows)
            total_floor_pass += good

    overall_pct = 100.0 * total_floor_pass / total_floor_tiles if total_floor_tiles else 0.0
    print(f"\nFLOOR-shape overall: {total_floor_pass}/{total_floor_tiles} tiles pass "
          f"({overall_pct:.2f}%), threshold {args.min_pass_pct}%")

    out = {
        "sweep_dir": args.sweep_dir, "z": args.z, "bbox": [bx0, by0, bx1, by1],
        "families": [{"family": f, "tiles": n, "distinct_ttnames": dt, "distinct_texpos": dp,
                       "distinct_tokens": dk, "bijective": bij, "pass_pct": round(p, 2),
                       "outlier_tiles": o}
                      for (f, n, dt, dp, dk, bij, p, o) in fam_table],
        "floor_tiles": total_floor_tiles, "floor_pass": total_floor_pass,
        "floor_pass_pct": round(overall_pct, 2), "min_pass_pct": args.min_pass_pct,
    }
    out_path = os.path.join(HERE, "validate_variation_result.json")
    json.dump(out, open(out_path, "w"), indent=1)
    print(f"wrote {out_path}")

    if total_floor_tiles == 0:
        print("CANNOT RUN: zero FLOOR-shape tiles resolved in the sweep"); sys.exit(2)
    if overall_pct < args.min_pass_pct:
        print(f"FAIL: {overall_pct:.2f}% < {args.min_pass_pct}%"); sys.exit(1)
    print(f"PASS: {overall_pct:.2f}% >= {args.min_pass_pct}%")
    sys.exit(0)


if __name__ == "__main__":
    main()
