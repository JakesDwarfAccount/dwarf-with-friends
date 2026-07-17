"""WE-5 acceptance gate: ambusher + unrevealed-tile units must not leak onto the wire.

Scripted before/after fixture per the WE-5 spec item
(docs/superpowers/specs/2026-07-07-WE-dwarf-compositing-spec.md):

  1. Pick a live, currently-visible unit from /mapdata (or --unit <id>).
  2. Set flags1.hidden_in_ambush on it via dfhack lua  -> assert it VANISHES from
     /mapdata. Clear the flag -> assert it REAPPEARS.  (Flag restored regardless.)
  3. Set designation.hidden on the unit's tile via dfhack lua -> assert it vanishes.
     Clear -> reappears.  (Bit restored regardless.)
  4. Regression: the visible-unit count with no flags toggled is identical before
     and after the runs (same camera, DF paused for the whole gate).

Exit 0 = PASS (all assertions). Evidence JSON: results/we5-<utc>.json.

Run from anywhere:  python tools/harness/gate_we5_visibility.py [--unit ID]
Requires DF loaded in fortress mode with the dwf plugin serving :8765.
"""
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = Path(__file__).resolve().parent
DFHACK_RUN = dfroot.dfhack_run(dfroot.df_root_for(__file__,
    purpose="queries a LIVE DF through dfhack-run"))
BASE = "http://127.0.0.1:8765"
PLAYER = "we5gate"
W, H = 50, 28

def lua(*args):
    """dfhack-run lua -f <script> <args...> -> stdout text."""
    cmd = [DFHACK_RUN, "lua", "-f"] + list(args)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return (p.stdout or "") + (p.stderr or "")

def lua_stmt(stmt):
    p = subprocess.run([DFHACK_RUN, "lua", stmt], capture_output=True, text=True, timeout=30)
    return (p.stdout or "") + (p.stderr or "")

def http_json(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))

def mapdata():
    return http_json(f"/mapdata?player={PLAYER}&w={W}&h={H}")

def units_by_id(md):
    return {u["id"]: u for u in md.get("units", [])}

def wait_state(unit_id, present, tries=10, delay=0.4):
    """Poll /mapdata until unit_id presence matches `present` (bool). Returns (ok, md)."""
    md = None
    for _ in range(tries):
        md = mapdata()
        if (unit_id in units_by_id(md)) == present:
            return True, md
        time.sleep(delay)
    return False, md

def main():
    unit_arg = None
    if "--unit" in sys.argv:
        unit_arg = int(sys.argv[sys.argv.index("--unit") + 1])

    results = {"gate": "we5-visibility", "utc": datetime.now(timezone.utc).isoformat(),
               "checks": [], "pass": False}
    def check(name, ok, detail=""):
        results["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS  " if ok else "FAIL  ") + name + ("  -- " + detail if detail else ""), flush=True)
        return ok

    # Pause DF so units don't walk out of the window mid-gate.
    prior_pause = lua_stmt("print(df.global.pause_state)").strip().splitlines()[-1].strip()
    lua_stmt("df.global.pause_state=true")

    ambush_set = False
    tile_set = False
    fixture = None
    try:
        base_md = mapdata()
        base_units = units_by_id(base_md)
        if not check("baseline: >=1 visible unit in window", len(base_units) >= 1,
                     f"count={len(base_units)} camera_origin={base_md.get('origin')} z={base_md.get('z')}"):
            return results
        baseline_count = len(base_units)

        if unit_arg is not None and unit_arg in base_units:
            fixture = base_units[unit_arg]
        else:
            fixture = sorted(base_units.values(), key=lambda u: u["id"])[0]
        uid = fixture["id"]
        ux, uy, uz = fixture["x"], fixture["y"], fixture["z"]
        print(f"fixture unit: id={uid} {fixture.get('rt')} '{fixture.get('name')}' at {ux},{uy},{uz}", flush=True)
        results["fixture_unit"] = fixture

        # --- Fixture A: hidden_in_ambush ---
        out = lua(str(HERE / "we5_toggle_ambush.lua"), str(uid), "1")
        ambush_set = "-> true" in out
        if not check("A1 set hidden_in_ambush via lua", ambush_set, out.strip()):
            return results
        ok, md = wait_state(uid, present=False)
        check("A2 ambusher ABSENT from /mapdata while flagged", ok,
              f"units_now={sorted(units_by_id(md))}" if md else "")
        out = lua(str(HERE / "we5_toggle_ambush.lua"), str(uid), "0")
        ambush_set = not ("-> false" in out)
        check("A3 clear hidden_in_ambush via lua", "-> false" in out, out.strip())
        ok, md = wait_state(uid, present=True)
        check("A4 unit PRESENT again after clearing", ok,
              f"units_now={sorted(units_by_id(md))}" if md else "")

        # --- Fixture B: unrevealed tile (designation.hidden) ---
        out = lua(str(HERE / "we5_toggle_tile_hidden.lua"), str(ux), str(uy), str(uz), "1")
        tile_set = "-> true" in out
        if check("B1 set tile designation.hidden via lua", tile_set, out.strip()):
            ok, md = wait_state(uid, present=False)
            check("B2 unit on unrevealed tile ABSENT from /mapdata", ok,
                  f"units_now={sorted(units_by_id(md))}" if md else "")
        out = lua(str(HERE / "we5_toggle_tile_hidden.lua"), str(ux), str(uy), str(uz), "0")
        tile_set = not ("-> false" in out)
        check("B3 clear tile designation.hidden via lua", "-> false" in out, out.strip())
        ok, md = wait_state(uid, present=True)
        check("B4 unit PRESENT again after re-reveal", ok,
              f"units_now={sorted(units_by_id(md))}" if md else "")

        # --- Regression: visible count unchanged with everything restored ---
        final_md = mapdata()
        final_count = len(units_by_id(final_md))
        check("R1 visible-unit count unchanged (flags restored, DF paused)",
              final_count == baseline_count, f"before={baseline_count} after={final_count}")

        results["pass"] = all(c["ok"] for c in results["checks"])
        return results
    finally:
        # Restore anything left toggled, then DF pause state.
        try:
            if fixture is not None:
                if ambush_set:
                    lua(str(HERE / "we5_toggle_ambush.lua"), str(fixture["id"]), "0")
                if tile_set:
                    lua(str(HERE / "we5_toggle_tile_hidden.lua"),
                        str(fixture["x"]), str(fixture["y"]), str(fixture["z"]), "0")
        except Exception as e:
            print("WARN: restore failed:", e, flush=True)
        if prior_pause == "false":
            lua_stmt("df.global.pause_state=false")
        out_path = HERE / "results" / f"we5-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        out_path.parent.mkdir(exist_ok=True)
        out_path.write_text(json.dumps(results, indent=2))
        print(("GATE PASS" if results["pass"] else "GATE FAIL") + f"  evidence: {out_path}", flush=True)

if __name__ == "__main__":
    r = main()
    sys.exit(0 if r and r.get("pass") else 1)
