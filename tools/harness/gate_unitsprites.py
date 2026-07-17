"""UNIT-SPRITE PARITY GATE for dwf (WE-8).

Formalizes the WE-2 manual oracle-comparison method (byte-identical RGBA vs an independent
/tiledump?atlas=1 reconstruction -- tools/ws2/evidence/we2_export_parity.json, 17/17 match)
into a repeatable, unattended instrument. Run after every W-E item lands and after any DF
update (spec: docs/superpowers/specs/2026-07-07-WE-dwarf-compositing-spec.md#we-8).

TWO INDEPENDENT SOURCES, cross-checked against the SHIPPING PATH (never each other):
  1. ORACLE PIXELS -- a CACHED /tiledump?atlas=1 dump of DF's entire persistent texture atlas
     (enabler->textures.raws -- see src/tile_dump.cpp dump_atlas_impl) as raw RGBA .rgba files
     + index.json under the DF root. This is DF's OWN texture memory, read completely
     independently of the WE-2 exporter's render-thread copy path. SAFETY RULE (added
     2026-07-07 after a live incident: a fresh dump saturates the render thread for 60-100+
     seconds and froze the live game): this gate NEVER dumps a fresh atlas on its own. It
     reuses the cached copy at <df-root>/dwf_unitsprites_gate/atlas_cache/atlas/ (atlas
     content only changes on a world/save reload, cached+keyed by save_dir) and warns (not
     fails) if the cache looks stale for the current save. A fresh dump only happens via the
     explicit --refresh-atlas --confirmed-with-owner combination, under tools/harness/DF_LOCK.
  2. ORACLE GEOMETRY -- `dfhack-run lua -f tools/ws2/scout_units.lua` reads each active unit's
     RAW df.unit.texpos[3][2] / texpos_currently_in_use[3][2] fields directly -- the same
     fields WE-1's tracker consumes, read by an entirely separate code path (a lua script,
     not the plugin's C++).
  3. SHIPPING PATH UNDER TEST -- GET /unit-sprite (unit_id -> {ah,sw,sh,ax,ay} + stats) and
     GET /unit-sprite/<hash>.png, i.e. exactly what a real client fetches.

For every unit the shipping path currently reports a composite for, this script:
  a. Re-implements src/unit_sprites.cpp's assemble_sprite() bbox/anchor rule in Python,
     directly from oracle source (2), to get an INDEPENDENTLY computed expected sw/sh/ax/ay.
  b. Assembles the INDEPENDENTLY expected pixel canvas by cropping oracle source (1)'s raw
     cells at the oracle texpos ids and placing them per that same rule -- never touching the
     exporter's code or its cached PNG.
  c. Decodes the served /unit-sprite/<hash>.png and byte-compares it against (b).
  d. Asserts the shipping listing's sw/sh/ax/ay match the independently computed (a).

PASS = 100% pixel-identical + geometry-identical for every checked unit, with at least
--min-units units checked (spec floor: 5). A wire cross-check (ws_probe.py auxdump) confirms
the AUX "ah" the WS wire actually carries matches the HTTP listing for the same units (WE-3).

SECONDARY, NON-GATING instrument (spec item 2): tools/ws2/bake_unit.py re-run (--group-match
last) against up to 2 live dwarf fixtures using the SAME atlas/census dump, to track DF-update
drift against the baseline (97.16% peasant #3658-class / 95.96% miner #5505-class). A drop
here is a signal, not a shipping-gate failure -- recorded in the evidence JSON, never affects
the exit code.

Usage (needs the Pillow/numpy env -- do not pip install):
  python tools/harness/gate_unitsprites.py
    [--host 127.0.0.1:8765] [--min-units 5] [--max-units 200]
    [--no-wire-check] [--no-bake-check] [--no-pause] [--label tag]
    [--refresh-atlas --confirmed-with-owner]   # DANGEROUS, see the safety rule above

Exit: 0 PASS, 1 FAIL (a pixel/geometry/wire mismatch among checked units),
      2 CANNOT RUN (server down, no cached atlas yet, or fewer than --min-units live
      composited units to check).
Evidence: results/unitsprites-<UTC>[-label].json (+ .../triptych.png for one multi-cell
sample). The cached atlas lives outside the repo (DF root) and is NOT re-dumped or deleted
by a normal run.

Toggles capture-unit-census / capture-unit-sprites ON for the run (harmless if already on)
and turns BOTH OFF again when done, per the overnight run orders ("flags restore to default
OFF after"). Pauses DF around the measurement window (restores prior pause state) so units
don't move/recomposite mid-comparison -- same convention as gate_parity.py / gate_we5_visibility.py.
This gate takes tools/harness/DF_LOCK ONLY for the --refresh-atlas path; the normal
(cache-reuse) path needs DF up but not exclusive control, per the overnight run orders.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import time
import datetime
import urllib.request
from pathlib import Path

from unitsprites_refresh_lock import acquire_refresh_lock

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

try:
    from PIL import Image
    import numpy as np
except ImportError:
    print("CANNOT RUN: needs Pillow+numpy -- run with "
          r"python")
    sys.exit(2)

HERE = Path(__file__).resolve().parent
WS2 = HERE.parent / "ws2"
DF_ROOT_DEFAULT = dfroot.df_root_for(__file__, purpose="reads sprite sheets out of Dwarf Fortress's own art")
HEX16_RE = re.compile(r"^[0-9a-f]{16}$")
BAKE_BASELINE = {
    "peasant_3658_class": 97.16,
    "miner_5505_class": 95.96,
    "metric": "pct_exact_nonzero_alpha, --group-match last, face_idx=1 (default)",
    "source": "tools/ws2/evidence/bake_unit_report.md",
}


def http(url, timeout=20, method="GET"):
    req = urllib.request.Request(url, method=method, data=(b"" if method == "POST" else None))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def http_json(url, timeout=20):
    return json.loads(http(url, timeout))


def dfhack_cmd(dfhack_run, *args, timeout=30):
    p = subprocess.run([dfhack_run] + list(args), capture_output=True, text=True, timeout=timeout)
    return (p.stdout or "") + (p.stderr or "")


def dfhack_lua_stmt(dfhack_run, stmt, timeout=30):
    return dfhack_cmd(dfhack_run, "lua", stmt, timeout=timeout)


def dfhack_lua_file(dfhack_run, script_path, *args, timeout=90):
    return dfhack_cmd(dfhack_run, "lua", "-f", str(script_path), *[str(a) for a in args], timeout=timeout)


def flag_is_on(status_text):
    return "is ON" in status_text


def set_flag(dfhack_run, cmd_name, on):
    return dfhack_cmd(dfhack_run, cmd_name, "on" if on else "off")


def get_flag(dfhack_run, cmd_name):
    return flag_is_on(dfhack_cmd(dfhack_run, cmd_name))


# ---------------------------------------------------------------------------------------
# Independent re-implementation of src/unit_sprites.cpp's assemble_sprite() -- see that
# file's comment block for the authoritative rule this mirrors. i = col (0..2, up to 3
# wide), j = row-from-top (0..1, up to 2 tall); anchor col = 0 if sw==1 else 1; anchor row
# = sh-1 (bottom row -- the unit's own tile is always the LAST row in the span).
# ---------------------------------------------------------------------------------------
def bbox_from_in_use(in_use):
    min_i, max_i, min_j, max_j = 3, -1, 2, -1
    for i in range(3):
        for j in range(2):
            if in_use[i][j]:
                min_i = min(min_i, i); max_i = max(max_i, i)
                min_j = min(min_j, j); max_j = max(max_j, j)
    if max_i < 0:
        return None
    return min_i, max_i, min_j, max_j


def assemble_expected(texpos, in_use, load_cell):
    """Returns {sw,sh,ax,ay,canvas(np.uint8 HxWx4)} or None (no live composite)."""
    bbox = bbox_from_in_use(in_use)
    if bbox is None:
        return None
    min_i, max_i, min_j, max_j = bbox
    sw = max(1, min(3, max_i - min_i + 1))
    sh = max(1, min(2, max_j - min_j + 1))
    ax = 0 if sw == 1 else 1
    ay = sh - 1

    cells = []
    for i in range(3):
        for j in range(2):
            if not in_use[i][j]:
                continue
            tp = texpos[i][j]
            if tp is None or tp <= 0:
                continue
            arr = load_cell(tp)
            if arr is None:
                continue
            cells.append((i, j, arr))
    if not cells:
        return None
    ch0, cw0 = cells[0][2].shape[0], cells[0][2].shape[1]
    for _, _, arr in cells:
        if arr.shape[0] != ch0 or arr.shape[1] != cw0:
            return None  # non-uniform cell size -- bail, same as the C++ does

    canvas = np.zeros((sh * ch0, sw * cw0, 4), dtype=np.uint8)
    for i, j, arr in cells:
        ci, cj = i - min_i, j - min_j
        canvas[cj * ch0:(cj + 1) * ch0, ci * cw0:(ci + 1) * cw0, :] = arr
    return {"sw": sw, "sh": sh, "ax": ax, "ay": ay, "canvas": canvas}


def save_triptych(expected_canvas, served_canvas, out_path, scale=6):
    h, w = expected_canvas.shape[:2]
    exp = Image.fromarray(expected_canvas, "RGBA").convert("RGB")
    srv = Image.fromarray(served_canvas, "RGBA").convert("RGB")
    diff = np.where((expected_canvas == served_canvas).all(axis=2, keepdims=True),
                     np.array([0, 40, 0], dtype=np.uint8),
                     np.array([200, 0, 0], dtype=np.uint8))
    dif = Image.fromarray(diff, "RGB")
    side = Image.new("RGB", (w * 3 + 20, h), (30, 30, 34))
    side.paste(exp, (0, 0)); side.paste(srv, (w + 10, 0)); side.paste(dif, (2 * w + 20, 0))
    side.resize((side.width * scale, side.height * scale), Image.NEAREST).save(out_path)


def run_bake_check(dfhack_run, scratch_dir, all_units, exported_units, dwarves, timeout=120):
    """Secondary understanding-instrument cross-check (spec WE-8 item 2). NOT a shipping gate --
    never affects the overall exit code; a match% drop is DF-update drift signal only."""
    eligible = []
    for d in dwarves:
        rec = exported_units.get(str(d["id"]))
        if not rec or not HEX16_RE.match(rec.get("ah") or ""):
            continue
        cu = all_units.get(d["id"])
        if not cu:
            continue
        bbox = bbox_from_in_use(cu["in_use"])
        if bbox is None:
            continue
        eligible.append((d, rec, cu, bbox))
    if not eligible:
        return {"skipped": True,
                "reason": "no dwarves at the host camera z-level currently have an exported "
                          "composite (scout_units.lua only dumps full appearance for <=6 "
                          "dwarves at window_z)"}

    # Prefer one sw==1 fixture and one sw>=2 fixture, mirroring the original peasant/miner pair.
    fixtures = []
    for want_min in (1, 2):
        for e in eligible:
            if e in fixtures:
                continue
            sw = e[1].get("sw")
            if (want_min == 1 and sw == 1) or (want_min == 2 and sw and sw >= 2):
                fixtures.append(e); break
    for e in eligible:
        if len(fixtures) >= 2:
            break
        if e not in fixtures:
            fixtures.append(e)
    fixtures = fixtures[:2]

    layerset_path = scratch_dir / "dwarf_layerset.json"
    out = dfhack_lua_file(dfhack_run, WS2 / "dump_layerset.lua", layerset_path, timeout=timeout)
    if not layerset_path.exists():
        return {"skipped": True, "reason": f"dump_layerset.lua produced no output: {out.strip()[-500:]}"}

    units_path = scratch_dir / "scout_units.json"
    atlas_dir = scratch_dir / "atlas"

    runs = []
    stat_re = re.compile(r"cell0: exact=([\d.]+)% exact_nz=([\d.]+)% MAE=([\d.]+) opaque_px=(\d+)")
    for d, rec, cu, bbox in fixtures:
        min_i, max_i, min_j, max_j = bbox
        ax, ay = rec.get("ax", 0), rec.get("ay", 0)
        try:
            anchor_tex = d["tex"][min_i + ax][min_j + ay]
        except Exception:
            anchor_tex = None
        entry = {"unit": d["id"], "name": d.get("name"), "profession": d.get("profession"),
                  "exported_sw_sh": [rec.get("sw"), rec.get("sh")], "target_tex": anchor_tex}
        if not anchor_tex or anchor_tex <= 0:
            entry["error"] = "could not resolve an anchor texpos id"
            runs.append(entry); continue
        cmd = [sys.executable, str(WS2 / "bake_unit.py"), "--unit", str(d["id"]),
               "--target", str(anchor_tex), "--group-match", "last",
               "--layerset", str(layerset_path), "--units", str(units_path),
               "--atlas", str(atlas_dir)]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            raw = (p.stdout or "") + (p.stderr or "")
            m = stat_re.search(raw)
            entry["returncode"] = p.returncode
            if m:
                entry.update({"pct_exact": float(m.group(1)),
                              "pct_exact_nonzero_alpha": float(m.group(2)),
                              "mae_over_opaque": float(m.group(3)),
                              "opaque_px": int(m.group(4))})
            else:
                entry["parse_error"] = True
                entry["raw_tail"] = raw[-600:]
        except Exception as e:
            entry["error"] = str(e)
        runs.append(entry)

    return {"skipped": False, "baseline": BAKE_BASELINE, "runs": runs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1:8765")
    ap.add_argument("--player", default="qa-unitsprites")
    ap.add_argument("--df-root", default=DF_ROOT_DEFAULT)
    ap.add_argument("--min-units", type=int, default=5, help="WE-8 acceptance floor")
    ap.add_argument("--max-units", type=int, default=200, help="safety cap on units checked")
    ap.add_argument("--no-wire-check", action="store_true",
                     help="skip the ws_probe.py AUX-wire 'ah' cross-check (WE-3)")
    ap.add_argument("--no-bake-check", action="store_true",
                     help="skip the bake_unit.py understanding-instrument cross-check")
    ap.add_argument("--no-pause", action="store_true")
    ap.add_argument("--label", default=None, help="suffix for the results dir/files")
    ap.add_argument("--refresh-atlas", action="store_true",
                     help="DANGEROUS: dump a fresh full atlas (saturates the render thread for "
                          "60-100+s, freezes the live game). Requires --confirmed-with-owner and "
                          "tools/harness/DF_LOCK. Default: reuse the cached atlas on disk.")
    ap.add_argument("--confirmed-with-owner", action="store_true",
                     help="required alongside --refresh-atlas -- asserts the machine's owner "
                          "explicitly agreed to the render-thread freeze")
    args = ap.parse_args()

    base = f"http://{args.host}"
    dfhack_run = os.path.join(args.df_root, "hack", "dfhack-run.exe")

    try:
        assert b'"ok":true' in http(f"{base}/health", 5)
    except Exception as e:
        print(f"CANNOT RUN: dwf server not reachable: {e}")
        sys.exit(2)

    stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    tag = stamp + (f"-{args.label}" if args.label else "")
    outdir = HERE / "results" / f"unitsprites-{tag}"
    outdir.mkdir(parents=True, exist_ok=True)
    scratch_rel = f"dwf_unitsprites_gate/{tag}"
    scratch_dir = Path(args.df_root) / scratch_rel
    scratch_dir.mkdir(parents=True, exist_ok=True)

    result = {"gate": "unitsprites", "utc": stamp, "label": args.label,
              "host": args.host, "checks": [], "pass": False}

    def check(name, ok, detail=""):
        result["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS  " if ok else "FAIL  ") + name + (f"  -- {detail}" if detail else ""), flush=True)
        return ok

    prior_pause = None
    exit_code = 2
    try:
        # -- pause DF (stable snapshot for the whole measurement window) --------------------
        if not args.no_pause:
            prior_pause = dfhack_lua_stmt(dfhack_run, "print(df.global.pause_state)").strip().splitlines()[-1].strip()
            dfhack_lua_stmt(dfhack_run, "df.global.pause_state=true")
            time.sleep(0.3)

        # -- feature flags on (idempotent -- always issued; harmless if already on) ----------
        # NOTE: dfhack-run's text relay for plugin commands (not `lua`) prints a literal
        # "%s" placeholder instead of the real status line in this environment, so a
        # stdout readback of the PRIOR state is not reliable here. The toggle itself works
        # (verified live via GET /unit-sprite's "exportEnabled" flipping true/false); this
        # gate always restores both flags to OFF when done regardless (see the finally
        # block), so not knowing the prior state has no correctness consequence.
        set_flag(dfhack_run, "capture-unit-census", True)
        set_flag(dfhack_run, "capture-unit-sprites", True)
        time.sleep(3.0)  # let the ~30Hz export worker drain the dirty backlog

        # -- shipping-path snapshot: the listing under test ----------------------------------
        # unit_census_pass() (the WE-1 tracker) only runs inside emit_units(), which is only
        # invoked by a /mapdata request or an active WS stream -- with zero connections the
        # flags alone do nothing. Drive /mapdata each iteration (a single call census-passes
        # the WHOLE active-unit list, not just its own viewport window -- WE-1 by design) so
        # this gate works with no browser/player attached, matching the browser-hygiene rule
        # (0 foreign players) rather than requiring one.
        listing = None
        for _ in range(10):
            try:
                http(f"{base}/mapdata?player={args.player}&w=50&h=28", 15)
            except Exception:
                pass
            try:
                listing = http_json(f"{base}/unit-sprite")
            except Exception:
                listing = None
            if listing and listing.get("ok") and len(listing.get("units", {})) >= args.min_units:
                break
            time.sleep(1.0)
        if listing is None or not listing.get("ok"):
            result["cannot_run_reason"] = "GET /unit-sprite failed"
            print(f"CANNOT RUN: {result['cannot_run_reason']}")
            sys.exit(2)
        exported_units = listing.get("units", {})
        result["export_enabled"] = listing.get("exportEnabled")
        result["exporter_stats"] = listing.get("stats")

        # -- oracle geometry: independent lua read of raw texpos/in_use ---------------------
        scout_path = scratch_dir / "scout_units.json"
        lua_out = dfhack_lua_file(dfhack_run, WS2 / "scout_units.lua", scout_path)
        if not scout_path.exists():
            result["cannot_run_reason"] = f"scout_units.lua produced no output: {lua_out.strip()[-500:]}"
            print(f"CANNOT RUN: {result['cannot_run_reason']}")
            sys.exit(2)
        census = json.loads(scout_path.read_text(encoding="utf-8", errors="replace"))
        all_units = {u["id"]: u for u in census.get("all_units", [])}
        result["census_window"] = census.get("window")

        candidates = []
        for sid, rec in exported_units.items():
            uid = int(sid)
            cu = all_units.get(uid)
            if cu is None:
                continue
            candidates.append((uid, cu, rec))
        candidates.sort(key=lambda t: t[0])
        result["exported_not_in_independent_census"] = len(exported_units) - len(candidates)

        # -- wire cross-check (WE-3): AUX 'ah' must match the HTTP listing -------------------
        # The AUX wire only ever carries "ah" for units within THAT connection's own camera
        # viewport (emit_units' ox/oy/oz/width/height filter); the /unit-sprite listing above
        # is the exporter's global census, fort-wide. So the fair comparison is scoped to
        # whatever falls inside the probe player's own interest window (ws_probe.py's
        # hardcoded w=50,h=28, same as the /mapdata calls above) -- not every exported unit.
        if not args.no_wire_check:
            try:
                cam = http_json(f"{base}/camera?player={args.player}")
                cw, ch = 50, 28
                in_window = [(uid, cu, rec) for uid, cu, rec in candidates
                             if cu.get("z") == cam.get("z")
                             and cam.get("x") <= cu.get("x") < cam.get("x") + cw
                             and cam.get("y") <= cu.get("y") < cam.get("y") + ch]
                if not in_window:
                    result["wire_check"] = {"skipped": True,
                        "reason": f"no exported unit falls inside player {args.player!r}'s "
                                  f"current interest window (cam={cam}, w={cw}, h={ch}) -- "
                                  "not a failure, just nothing in view to cross-check"}
                else:
                    probe_secs = 6
                    subprocess.run([sys.executable, str(HERE / "ws_probe.py"), args.player,
                                    str(probe_secs), "proto1", "auxdump"],
                                   capture_output=True, text=True, timeout=probe_secs + 30)
                    auxfile = HERE / "results" / f"auxdump_{args.player}.json"
                    if auxfile.exists():
                        auxdata = json.loads(auxfile.read_text())
                        detail = auxdata.get("detail", {})
                        mismatches, checked_wire = [], 0
                        for uid, cu, rec in in_window:
                            wrec = detail.get(str(uid))
                            if not wrec or not wrec.get("last_ah"):
                                continue
                            checked_wire += 1
                            if wrec["last_ah"] != rec.get("ah"):
                                mismatches.append({"unit": uid, "wire_ah": wrec["last_ah"],
                                                    "http_ah": rec.get("ah")})
                        wire_detail = {"in_window": len(in_window), "checked": checked_wire,
                                        "mismatches": mismatches,
                                        "bad_hash_count": len(auxdata.get("bad_hash", []))}
                        check("wire AUX 'ah' matches HTTP /unit-sprite listing (WE-3)",
                              len(mismatches) == 0 and checked_wire > 0, json.dumps(wire_detail))
                        result["wire_check"] = wire_detail
                    else:
                        check("wire AUX cross-check produced auxdump json", False,
                              "auxdump json not written (ws_probe.py failed?)")
                        result["wire_check"] = {"error": "auxdump json not written"}
            except Exception as e:
                check("wire AUX cross-check ran", False, str(e))
                result["wire_check"] = {"error": str(e)}
        else:
            result["wire_check"] = {"skipped": True, "reason": "--no-wire-check"}

        # -- lightweight per-run liveness ping (lock-free, ~26ms) ----------------------------
        # Replaces a per-run full atlas dump. A plain frame-only /tiledump renders through the
        # SAME capture_shifted path but skips the atlas hop entirely -- confirms the
        # render-thread capture path is alive without touching enabler->textures.raws.
        try:
            t0 = time.time()
            ping_dir = (scratch_rel + "/ping").replace("\\", "/")
            ping_body = json.loads(http(f"{base}/tiledump?dir={ping_dir}&atlas=0&gt=0", timeout=15))
            result["frame_ping_ms"] = round((time.time() - t0) * 1000, 1)
            result["frame_ping_ok"] = bool(ping_body.get("ok"))
        except Exception as e:
            result["frame_ping_ok"] = False
            result["frame_ping_error"] = str(e)

        # -- oracle pixels: CACHED atlas only, never dumped unattended --------------------
        # SAFETY RULE (2026-07-07, added after a live incident): a full /tiledump?atlas=1
        # dumps DF's entire persistent texture atlas (enabler->textures.raws) and saturates
        # the render thread for 60-100+ SECONDS -- this froze the live game once already.
        # Atlas CONTENT only changes on a world/save reload, so it is cached at a stable
        # location (ATLAS_CACHE_DIR, keyed by save_dir below) and reused across every run
        # by default. A fresh dump only ever happens via --refresh-atlas, which itself
        # requires --confirmed-with-owner (the machine owner's explicit OK --
        # never a tool's own judgment call) AND tools/harness/DF_LOCK (exclusive; this is
        # the one operation in this whole gate that actually needs it).
        atlas_cache_dir = Path(args.df_root) / "dwf_unitsprites_gate" / "atlas_cache"
        atlas_dir = atlas_cache_dir / "atlas"
        cache_meta_path = atlas_cache_dir / "cache_meta.json"
        lock_path = HERE / "DF_LOCK"

        save_id = None
        try:
            out = dfhack_lua_stmt(dfhack_run, "print(df.global.world.cur_savegame.save_dir)")
            save_id = out.strip().splitlines()[-1].strip() if out.strip() else None
        except Exception:
            pass

        if args.refresh_atlas:
            if not args.confirmed_with_owner:
                result["cannot_run_reason"] = (
                    "--refresh-atlas requires --confirmed-with-owner -- a full atlas dump "
                    "saturates DF's render thread for 60-100+ seconds (verified: froze the "
                    "live game on 2026-07-07). This needs the machine owner's explicit OK, "
                    "never a tool's own judgment call.")
                print(f"CANNOT RUN: {result['cannot_run_reason']}")
                sys.exit(2)
            acquired, lock_detail = acquire_refresh_lock(lock_path, "gate_unitsprites")
            if not acquired:
                result["cannot_run_reason"] = (
                    f"{lock_detail} -- refusing to dump the atlas while another agent may "
                    "be driving DF.")
                print(f"CANNOT RUN: {result['cannot_run_reason']}")
                sys.exit(2)
            try:
                print("WARNING: dumping the FULL DF texture atlas now -- the live game/render "
                      "thread will visibly freeze for approximately 60-100+ SECONDS. Proceeding "
                      "only because --refresh-atlas --confirmed-with-owner was explicitly passed.",
                      flush=True)
                atlas_cache_dir.mkdir(parents=True, exist_ok=True)
                dir_rel = "dwf_unitsprites_gate/atlas_cache"
                t0 = time.time()
                body = json.loads(http(f"{base}/tiledump?dir={dir_rel}&atlas=1&gt=0", timeout=200))
                dump_s = round(time.time() - t0, 1)
                if not body.get("ok"):
                    result["cannot_run_reason"] = f"/tiledump?atlas=1 failed: {body.get('err')}"
                    print(f"CANNOT RUN: {result['cannot_run_reason']}")
                    sys.exit(2)
                cache_meta_path.write_text(json.dumps(
                    {"captured_utc": stamp, "save_dir": save_id, "dump_seconds": dump_s}, indent=2))
                result["atlas_refreshed_this_run"] = True
                result["atlas_dump_seconds"] = dump_s
            finally:
                lock_path.unlink(missing_ok=True)
        else:
            result["atlas_refreshed_this_run"] = False

        index_path = atlas_dir / "index.json"
        if not index_path.exists():
            result["cannot_run_reason"] = (
                f"no cached atlas at {atlas_dir} and --refresh-atlas not given. A fresh dump "
                "needs DF_LOCK + --refresh-atlas --confirmed-with-owner (see the safety-rule "
                "comment above this block) -- not something this gate does on its own "
                "initiative.")
            print(f"CANNOT RUN: {result['cannot_run_reason']}")
            sys.exit(2)
        atlas_index = json.loads(index_path.read_text())["tiles"]
        cache_meta = json.loads(cache_meta_path.read_text()) if cache_meta_path.exists() else {}
        result["atlas_cache_meta"] = cache_meta
        if cache_meta.get("save_dir") and save_id and cache_meta["save_dir"] != save_id:
            print(f"WARNING: cached atlas was captured under save_dir={cache_meta['save_dir']!r} "
                  f"but the CURRENT save is {save_id!r} -- a world/save reload happened since. "
                  "Texture ids get reassigned on load, so this comparison may be against a "
                  "stale atlas. A refresh needs DF_LOCK + --refresh-atlas --confirmed-with-owner.",
                  flush=True)
            result["atlas_cache_stale_warning"] = {"cached_save_dir": cache_meta["save_dir"],
                                                    "current_save_dir": save_id}

        atlas_cell_cache = {}

        def load_cell(tp):
            if tp in atlas_cell_cache:
                return atlas_cell_cache[tp]
            info = atlas_index.get(str(tp))
            arr = None
            if info is not None:
                p = atlas_dir / f"tex_{tp}.rgba"
                if p.exists():
                    w, h = info["w"], info["h"]
                    data = p.read_bytes()
                    if len(data) == w * h * 4:
                        arr = np.frombuffer(data, dtype=np.uint8).reshape((h, w, 4)).copy()
            atlas_cell_cache[tp] = arr
            return arr

        # -- per-unit compare: independent geometry+pixels vs the shipping listing+PNG -------
        n_checked = n_geom = n_pixel = 0
        details = []
        triptych_saved = False
        for uid, cu, rec in candidates[:args.max_units]:
            expected = assemble_expected(cu["tex"], cu["in_use"], load_cell)
            if expected is None:
                details.append({"unit": uid, "skip": "no live in-use texpos slots in independent census"})
                continue
            n_checked += 1
            geom_ok = (expected["sw"] == rec.get("sw") and expected["sh"] == rec.get("sh")
                       and expected["ax"] == rec.get("ax") and expected["ay"] == rec.get("ay"))
            if geom_ok:
                n_geom += 1

            ah = rec.get("ah", "")
            pixel_ok = False
            err = None
            served = None
            if HEX16_RE.match(ah or ""):
                try:
                    png_bytes = http(f"{base}/unit-sprite/{ah}.png", 20)
                    served = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGBA"), dtype=np.uint8)
                    if served.shape == expected["canvas"].shape:
                        pixel_ok = bool(np.array_equal(served, expected["canvas"]))
                    else:
                        err = f"shape mismatch served={served.shape} expected={expected['canvas'].shape}"
                except Exception as e:
                    err = str(e)
            else:
                err = f"bad/missing ah {ah!r}"
            if pixel_ok:
                n_pixel += 1

            if (not triptych_saved) and served is not None and (expected["sw"] > 1 or expected["sh"] > 1):
                try:
                    save_triptych(expected["canvas"], served, outdir / "triptych.png")
                    triptych_saved = True
                except Exception:
                    pass

            details.append({
                "unit": uid, "race": cu.get("race"), "ah": ah,
                "exported": {"sw": rec.get("sw"), "sh": rec.get("sh"),
                              "ax": rec.get("ax"), "ay": rec.get("ay")},
                "expected": {"sw": expected["sw"], "sh": expected["sh"],
                              "ax": expected["ax"], "ay": expected["ay"]},
                "geometry_match": geom_ok, "pixel_match": pixel_ok, "error": err,
            })
        result["units_checked"] = n_checked
        result["units_geometry_matched"] = n_geom
        result["units_pixel_matched"] = n_pixel
        result["match_pct"] = round(100.0 * n_pixel / n_checked, 2) if n_checked else 0.0
        result["results"] = details

        insufficient = n_checked < args.min_units
        if insufficient:
            check(f">= {args.min_units} live composited units available to check", False,
                  f"only {n_checked} checkable (exported listing had {len(exported_units)})")
            result["cannot_run_reason"] = (
                f"only {n_checked} live composited units checkable (< --min-units {args.min_units})")
        else:
            check(f">= {args.min_units} live composited units checked", True, f"checked={n_checked}")
        check("100% geometry match (sw/sh/ax/ay, independent texpos read vs shipping listing)",
              n_checked > 0 and n_geom == n_checked, f"{n_geom}/{n_checked}")
        check("100% pixel match (RGBA byte-identical, independent atlas crop vs served PNG)",
              n_checked > 0 and n_pixel == n_checked, f"{n_pixel}/{n_checked}")

        # -- secondary, non-gating: bake_unit.py cross-check ---------------------------------
        if not args.no_bake_check:
            bake_result = run_bake_check(dfhack_run, scratch_dir, all_units, exported_units,
                                          census.get("dwarves", []))
            result["bake_check"] = bake_result
            if bake_result.get("skipped"):
                print(f"INFO  bake_unit.py cross-check skipped -- {bake_result.get('reason')}", flush=True)
            else:
                for r in bake_result["runs"]:
                    if "pct_exact_nonzero_alpha" in r:
                        print(f"INFO  bake_unit.py unit={r['unit']} ({r.get('name')}): "
                              f"exact_nz={r['pct_exact_nonzero_alpha']:.2f}% "
                              f"MAE={r['mae_over_opaque']:.3f}  (baseline ~95-97%)", flush=True)
                        if r["pct_exact_nonzero_alpha"] < 90.0:
                            print(f"WARN  bake_unit.py unit={r['unit']} dropped below the "
                                  f"90% sanity floor -- possible DF compositor semantics drift",
                                  flush=True)
                    else:
                        print(f"WARN  bake_unit.py unit={r['unit']}: {r.get('error') or r.get('parse_error')}",
                              flush=True)
        else:
            result["bake_check"] = {"skipped": True, "reason": "--no-bake-check"}

        result["pass"] = all(c["ok"] for c in result["checks"])
        exit_code = 2 if insufficient else (0 if result["pass"] else 1)

    finally:
        # -- restore: flags OFF (default), pause restored to prior state ---------------------
        # Run-orders convention: these two experimental flags restore to their default OFF
        # regardless of the prior state this gate happened to find them in (order matters:
        # capture-unit-sprites depends on capture-unit-census, so disable it first).
        try:
            set_flag(dfhack_run, "capture-unit-sprites", False)
            set_flag(dfhack_run, "capture-unit-census", False)
        except Exception as e:
            print("WARN: flag restore failed:", e, flush=True)
        try:
            if prior_pause == "false":
                dfhack_lua_stmt(dfhack_run, "df.global.pause_state=false")
        except Exception as e:
            print("WARN: pause restore failed:", e, flush=True)
        # NOTE: no atlas cleanup here -- the atlas lives in the STABLE cache dir (reused
        # across runs, not per-run scratch), and is never deleted by a normal run.

        out_path = outdir / "unitsprites.json"
        out_path.write_text(json.dumps(result, indent=2))
        # Also drop a flat copy at the conventional results/<name>-<utc>.json path.
        flat_path = HERE / "results" / f"unitsprites-{tag}.json"
        flat_path.write_text(json.dumps(result, indent=2))
        if result.get("cannot_run_reason"):
            label = "GATE CANNOT-RUN"
        elif result.get("pass"):
            label = "GATE PASS"
        else:
            label = "GATE FAIL"
        print(f"{label}  evidence: {flat_path}  (+ {outdir})", flush=True)

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
