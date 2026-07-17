"""LOCAL-NAV GATE -- WB-16 (default mode, docs/superpowers/specs/2026-07-07-WB-renderer-spec.md)
plus the original WA-13 mode (--wa, docs/superpowers/specs/2026-07-07-WA-foundation-spec.md).

WB-16 (DEFAULT, no --wa): the 60fps local-nav gate for the GL renderer. Loads
GET /view?renderer=<gl|canvas2d>&benchpan=1, waits cache-warm, then drives a scripted
pan+zoom gesture (window.__wa_nav.pan() + window.dwfZoomView(), the SAME real input
pathways a human uses) for `--pan-secs` while the WB-9 `benchpan` hook
(dwf-render.js's GL controller) self-animates a uniform-only scroll wobble on its OWN
rAF loop, independent of scene rebuilds. PASS = p95 frame time <=17ms, read from:
  - `DwfRender.getStats().benchP95` when the GL renderer is active (the GL rAF loop's
    own per-frame timer -- the metric that matters, since the underlying canvas2d data layer
    keeps redrawing at its own ~30Hz AUX-driven cadence "underneath" regardless of which
    renderer is displayed, per dwf-render.js's file banner, and so cannot see faster
    than that floor);
  - `window.__wa_nav.stats().frameP95Ms` (the canvas2d full-redraw cadence, WA-13's original
    metric) when canvas2d is active -- there is no GL rAF loop to time in that case.
Discrimination proof (spec-required): `--renderer canvas2d --dims 200x200` forces the grid
window to the client's max 200x200-tile cap (report phase3-checkpoint.md: "Canvas 2D =
3.4fps at 200x200x8 layers (disqualified)") via `DwfTiles.zoomTo(TILE_PX_MIN)` + a
large browser viewport, and MUST fail the same <=17ms budget -- proving the gate can tell a
slow renderer from a fast one, not just rubber-stamp green.
`--require-wire-silence` additionally asserts zero BLOCK_SET bytes during the pan window
(WA-13's T2, already enforced by the CAM/wire-silent-nav wave) -- defaults OFF per the WB-16
spec text ("until W-A's world replication flips it on"); not part of WB-16's own pass
criteria, so it never gates the exit code unless explicitly requested.

WA-13 mode (--wa): unchanged from the original. Drives real zoom/pan/z-move gestures through
the REAL embedded client via window.__wa_nav (dwf-core.js, WA-13 item 4) and asserts
the wave's "wire-silent local nav" contract:
  T1  ZERO socket reconnects across 10 zoom steps (legacy wire reconnects on EVERY step --
      this is the headline win: CAM messages replace the resize-reconnect entirely, §0.4).
  T2  ZERO BLOCK_SET bytes during a steady-state pan window, after the first 500ms, while
      panning within an already-cached area (AUX/cursors are constant-rate and excluded --
      __wa_nav's blockSetBytesWindow counter only tracks BLOCK_SET bytes, see dwf-ws.js).
  T3  A single pan input causes a repaint within ~2 animation frames (sceneBuildCount
      advances), and the gesture's frame-to-frame p95 stays <=33ms (canvas2d floor; WB-16
      tightens this to 17ms for the GL renderer, see above).
  T4  ZERO socket reconnects across 5 z-move steps (same CAM-based windowing as zoom/pan).

Usage:
  python gate_localnav.py                                    # WB-16: gl, p95<=17ms
  python gate_localnav.py --renderer canvas2d --dims 200x200  # WB-16 discrimination (expect FAIL)
  python gate_localnav.py --wa                                # WA-13 mode (canvas2d, p95<=33ms)
  python gate_localnav.py --wa --camera 65,82,161 --host 127.0.0.1:8765
Exit: 0 pass, 1 fail, 2 could not run (server/agent-browser down).
Evidence: results/localnav-<UTC>.json

Requires: DF running w/ loaded fort + capture-stream-start; `agent-browser` on PATH.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, time, datetime

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DF_ROOT_DEFAULT = dfroot.df_root_for(__file__, purpose="drives a live DF host")
DFHACK_RUN = DF_ROOT_DEFAULT + r"\hack\dfhack-run.exe"


def http(url, timeout=15, method="GET"):
    import urllib.request
    req = urllib.request.Request(url, method=method, data=(b"" if method == "POST" else None))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def dfhack_lua(code, dfhack_run=DFHACK_RUN):
    p = subprocess.run([dfhack_run, "lua", code], capture_output=True, text=True, timeout=20)
    return (p.stdout or "").strip()


def _find_ab():
    """Prefer the real .exe over the npm .cmd shim (same rationale as gate_parity.py: the
    .cmd shim runs through cmd.exe, which mishandles '&' in URLs even with an argv list)."""
    shim = shutil.which("agent-browser")
    if shim:
        exe = os.path.join(os.path.dirname(shim), "node_modules", "agent-browser",
                           "bin", "agent-browser-win32-x64.exe")
        if os.path.isfile(exe):
            return exe
    return shim


AB_EXE = _find_ab()


class _AbResult:
    def __init__(self, returncode, stdout, stderr):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def _ab_once(session, args, timeout):
    """Redirect to FILES, never pipes (the agent-browser CLI's detached daemon inherits the
    parent's handles, so subprocess.run(capture_output=True) can block forever on the read
    side even after the CLI process itself exits -- see gate_parity.py's identical note)."""
    cmd = [AB_EXE, "--session", session] + list(args)
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as fo, \
         tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as fe:
        try:
            rc = subprocess.run(cmd, stdout=fo, stderr=fe, stdin=subprocess.DEVNULL,
                                timeout=timeout, shell=False).returncode
        except subprocess.TimeoutExpired:
            rc = -1
        fo.seek(0); fe.seek(0)
        return _AbResult(rc, fo.read(), fe.read())


def ab(session, *args, timeout=60):
    """Run one agent-browser command; returns stdout. Raises on nonzero exit. Auto-recovers
    from a wedged daemon (stale-CLI-version symptom) by killing + retrying once, same as
    gate_parity.py -- this gate must also run unattended overnight."""
    if not AB_EXE:
        print("CANNOT RUN: agent-browser CLI not on PATH"); sys.exit(2)
    p = _ab_once(session, args, timeout)
    if p.returncode != 0:
        blob = (p.stdout or "") + (p.stderr or "")
        if "daemon" in blob or "Invalid response" in blob:
            subprocess.run(["taskkill", "/IM", "agent-browser-win32-x64.exe", "/F"],
                           capture_output=True)
            time.sleep(2)
            p = _ab_once(session, args, timeout)
            if p.returncode != 0 and "concurrently" in ((p.stdout or "") + (p.stderr or "")):
                time.sleep(3)
                p = _ab_once(session, args, timeout)
    if p.returncode != 0:
        raise RuntimeError(f"agent-browser {' '.join(args[:2])} failed: {p.stdout} {p.stderr}")
    return p.stdout.strip()


def js_eval(session, expr):
    """Evaluate `expr` (must itself return a JSON-serializable value) and return it decoded.
    agent-browser's `eval` returns a JSON-encoded string of whatever the expression yields;
    that outer layer is itself JSON (a quoted string) when the expression's own result was
    already a JSON string (JSON.stringify(...)) -- unwrap defensively either way."""
    out = ab(session, "eval", expr)
    try:
        j = json.loads(out)
    except Exception:
        return None
    if isinstance(j, str):
        try:
            return json.loads(j)
        except Exception:
            return j
    return j


def ws_stats(session):
    return js_eval(session, "JSON.stringify(window.DwfWS && DwfWS.getStats())")


def cache_stats(session):
    return js_eval(session, "JSON.stringify(window.DwfCache && DwfCache.stats())")


def nav_stats(session):
    return js_eval(session, "JSON.stringify(window.__wa_nav && window.__wa_nav.stats())")


def tiles_stats(session):
    return js_eval(session, "JSON.stringify(window.DwfTiles && DwfTiles.getStats())")


def render_stats(session):
    """WB-1/WB-16: the renderer-seam stats (dwf-render.js's getStats()) -- carries
    `renderer` (which impl actually resolved: gl may auto-fallback to canvas2d) and, when GL
    is active with `benchpan=1` on the URL, `benchP95` -- the GL rAF loop's own per-frame p95,
    timed independently of the canvas2d data-layer's mapDirty-gated redraws."""
    return js_eval(session, "JSON.stringify(window.DwfRender && DwfRender.getStats())")


TILE_PX_MIN = 12  # dwf-tiles.js constant (mirrored here for the --dims discrimination forcer)


def force_grid_dims(session, dims):
    """WB-16 discrimination forcer: reproduce the phase3-checkpoint.md "200x200x8 layers"
    disqualifying case. The client caps its requested grid window at min(200, canvasPx /
    targetTilePx) tiles per side (dwf-tiles.js desiredWinDims()); at TILE_PX_MIN=12 that
    cap is reached once the canvas is >= 200*12=2400px per side. We size the browser viewport
    accordingly, then call DwfTiles.zoomTo(TILE_PX_MIN) directly (the same function
    `?[`/`?]` zoom keys eventually call) to jump straight to the max grid instead of stepping
    the 1.2x zoom ladder ~5 times. Returns the resulting getRenderRect() (gw/gh = actual grid
    tiles achieved) so the evidence JSON can show the forced dims were really reached."""
    w_tiles, h_tiles = (int(x) for x in dims.lower().split("x"))
    px = max(w_tiles, h_tiles, 200) * TILE_PX_MIN + 64
    ab(session, "set", "viewport", str(px), str(px))
    time.sleep(0.3)
    js_eval(session, "(function(){ if (window.DwfTiles && DwfTiles.zoomTo) "
                      f"DwfTiles.zoomTo({TILE_PX_MIN}); return true; }})()")
    time.sleep(0.6)  # let the resize/re-crop + a poll/CAM round-trip settle before measuring
    return js_eval(session, "JSON.stringify(window.DwfTiles && DwfTiles.getRenderRect "
                             "&& DwfTiles.getRenderRect())")


def nav_call(session, fn, *fnargs):
    args = ",".join(str(a) for a in fnargs)
    js_eval(session, f"(function(){{window.__wa_nav.{fn}({args}); return true;}})()")


def nav_pan_for(session, ms, interval_ms=100, amplitude=2):
    """Drive an oscillating +-`amplitude`-tile pan ENTIRELY in-page for `ms` milliseconds via
    one eval call (agent-browser awaits the returned Promise -- confirmed empirically: a
    setTimeout-resolved promise blocks the CLI call for its real duration). This is
    deliberately NOT a Python-side sleep loop of individual nav_call()s: each of those is a
    separate CLI/CDP round-trip (real subprocess spawn + protocol overhead), and that overhead
    was swamping the actual frame-time measurement (T3) with noise unrelated to the renderer's
    true redraw cadence -- an in-page loop measures what a human's continuous drag actually
    produces."""
    js_eval(session, f"""
      (function(){{
        return new Promise(function(resolve){{
          var toggle = 1, tEnd = performance.now() + {ms};
          function step(){{
            window.__wa_nav.pan({amplitude} * toggle, 0);
            toggle = -toggle;
            if (performance.now() < tEnd) setTimeout(step, {interval_ms});
            else resolve(true);
          }}
          step();
        }});
      }})()
    """)


def nav_gesture_for(session, ms, interval_ms=100, amplitude=2, zoom_every_ms=700):
    """WB-16: like nav_pan_for, but also throws in a real zoom in/out step every
    `zoom_every_ms` via window.dwfZoomView (the SAME function the [ / ] keys call) --
    matching the WB-9 acceptance text's "3s continuous wheel-zoom + drag-pan". Runs as ONE
    in-page loop for the same reason as nav_pan_for (CLI round-trip noise would otherwise
    swamp the frame-time measurement)."""
    js_eval(session, f"""
      (function(){{
        return new Promise(function(resolve){{
          var toggle = 1, zdir = 1, tEnd = performance.now() + {ms}, lastZoom = performance.now();
          function step(){{
            window.__wa_nav.pan({amplitude} * toggle, 0);
            toggle = -toggle;
            var now = performance.now();
            if (now - lastZoom >= {zoom_every_ms}) {{
              try {{ if (window.dwfZoomView) window.dwfZoomView(zdir > 0 ? 'in' : 'out'); }} catch (_) {{}}
              zdir = -zdir;
              lastZoom = now;
            }}
            if (now < tEnd) setTimeout(step, {interval_ms});
            else resolve(true);
          }}
          step();
        }});
      }})()
    """)


def write_results(results, ok):
    results["pass"] = ok
    stamp = results["utc"]
    outdir = os.path.join(HERE, "results")
    os.makedirs(outdir, exist_ok=True)
    outpath = os.path.join(outdir, f"localnav-{stamp}.json")
    with open(outpath, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n{'PASS' if ok else 'FAIL'}  (evidence: {os.path.relpath(outpath, HERE)})")
    sys.exit(0 if ok else 1)


def run_wb16(args):
    """WB-16: the GL 60fps local-nav gate (default mode, no --wa). See the file banner."""
    p95_budget = args.p95_budget_ms
    base = f"http://{args.host}"
    try:
        assert b'"ok":true' in http(f"{base}/health", 5)
    except Exception as e:
        print(f"CANNOT RUN: dwf server not reachable: {e}"); sys.exit(2)

    if args.camera:
        x, y, z = args.camera.split(",")
        http(f"{base}/camera?player={args.player}&x={x}&y={y}&z={z}", method="POST")

    session = "qa-wb16-" + datetime.datetime.utcnow().strftime("%H%M%S")
    results = {"utc": datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"),
               "gate": "WB-16", "camera": args.camera, "player": args.player,
               "renderer_requested": args.renderer, "dims": args.dims,
               "p95_budget_ms": p95_budget}
    ok = True
    warm_timeout = args.warm_timeout if not args.dims else max(args.warm_timeout, 40.0)
    try:
        ab(session, "open", f"{base}/view?player={args.player}&renderer={args.renderer}&benchpan=1")
        if args.dims:
            w_tiles, h_tiles = (int(x) for x in args.dims.lower().split("x"))
            px = max(w_tiles, h_tiles, 200) * TILE_PX_MIN + 64
            ab(session, "set", "viewport", str(px), str(px))
        else:
            ab(session, "set", "viewport", "1280", "800")

        # -- wait for the v1 session to come up + the cache to warm before driving gestures --
        # an ice-cold cache would make the pan phase legitimately fetch new territory, which
        # would pollute the frame-time measurement with genuine (unrelated) load cost.
        warmed = False
        t0 = time.time()
        last_cs, last_ws = None, None
        while time.time() - t0 < warm_timeout:
            last_ws = ws_stats(session)
            last_cs = cache_stats(session)
            if last_ws and last_ws.get("proto") == "v1" and last_cs and \
               last_cs.get("chunks", 0) >= 8 and last_cs.get("zLevels", 0) >= 3:
                warmed = True
                break
            time.sleep(0.5)
        results["warmup"] = {"warmed": warmed, "wait_s": round(time.time() - t0, 1),
                              "ws_stats": last_ws, "cache_stats": last_cs}
        if not last_ws or last_ws.get("proto") != "v1":
            print("CANNOT RUN: client never reported proto:v1 (DwfWS never connected, "
                  "or the bundle is stale -- old cache-buster?)")
            sys.exit(2)
        if not warmed:
            print(f"WARN: cache did not fully warm within {warm_timeout}s "
                  f"(cache_stats={last_cs}) -- proceeding anyway, p95 may be noisy")

        if args.dims:
            rr = force_grid_dims(session, args.dims)
            results["forced_dims"] = {"requested": args.dims, "getRenderRect": rr}
            print(f"forced grid dims: requested {args.dims} -> getRenderRect={rr}")

        rs0 = render_stats(session)
        if not rs0 or not rs0.get("renderer"):
            print("CANNOT RUN: window.DwfRender missing/empty -- stale bundle or seam "
                  "not booted"); sys.exit(2)
        results["renderer_active_at_load"] = rs0.get("renderer")

        # ---- pan+zoom gesture window (WB-9 acceptance: "3s continuous wheel-zoom + drag-pan")
        # Unmeasured settle pass first (lets the immediate vicinity finish arriving), then a
        # fresh __wa_nav baseline, matching the WA-13 gate's "after the first 500ms" convention
        # -- the GL benchpan wobble (bench.on) has been running on its own rAF loop since page
        # load regardless, so its ring buffer is measuring the WHOLE session's frame cadence by
        # design (spec: "3s continuous" -- a long-running ring is the more conservative read).
        nav_gesture_for(session, 500)
        nav_call(session, "stats")  # discard -> fresh __wa_nav baseline for canvas2d's own metric
        before_stats = tiles_stats(session)
        nav_gesture_for(session, int(args.pan_secs * 1000))
        wa_nav = nav_stats(session)
        after_stats = tiles_stats(session)
        rs = render_stats(session)

        active = rs.get("renderer") if rs else None
        results["renderer_active"] = active
        if active == "gl":
            p95 = rs.get("benchP95")
            metric = "DwfRender.getStats().benchP95 (GL rAF loop)"
        else:
            p95 = (wa_nav or {}).get("frameP95Ms")
            metric = "__wa_nav.stats().frameP95Ms (canvas2d data-layer draw loop)"
        p95_pass = isinstance(p95, (int, float)) and p95 <= p95_budget
        ok = ok and p95_pass
        results["metric"] = metric
        results["p95_ms"] = p95
        results["pass_p95"] = p95_pass
        results["render_stats"] = rs
        results["wa_nav_stats"] = wa_nav
        results["scene_build_count"] = {"before": (before_stats or {}).get("sceneBuildCount"),
                                         "after": (after_stats or {}).get("sceneBuildCount")}
        print(f"p95={p95}ms (budget {p95_budget}ms, metric={metric}, renderer_active={active})"
              + ("  PASS" if p95_pass else "  FAIL"))
        if args.renderer == "gl" and active != "gl":
            print("NOTE: requested gl but active renderer demoted to "
                  f"'{active}' (webgl2 unavailable / context-loss fallback?) -- investigate "
                  "before trusting this run as a GL measurement")

        if args.require_wire_silence:
            silent = bool(wa_nav) and wa_nav.get("blockSetBytesWindow", -1) == 0
            results["wire_silence_pass"] = silent
            results["require_wire_silence"] = True
            ok = ok and silent
            print(f"wire-silence blockSetBytesWindow={wa_nav and wa_nav.get('blockSetBytesWindow')}"
                  + ("  PASS" if silent else "  FAIL"))

        results["final_ws_stats"] = ws_stats(session)
        results["final_cache_stats"] = cache_stats(session)
    finally:
        try:
            ab(session, "close")
        except Exception:
            pass

    write_results(results, ok)


def run_wa(args):
    p95_budget = 33.0  # W-A canvas2d floor (--wa); WB-16 tightens this to 17ms for GL

    base = f"http://{args.host}"
    try:
        assert b'"ok":true' in http(f"{base}/health", 5)
    except Exception as e:
        print(f"CANNOT RUN: dwf server not reachable: {e}"); sys.exit(2)

    if args.camera:
        x, y, z = args.camera.split(",")
        http(f"{base}/camera?player={args.player}&x={x}&y={y}&z={z}", method="POST")

    session = "qa-nav-" + datetime.datetime.utcnow().strftime("%H%M%S")
    results = {"utc": datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"),
               "camera": args.camera, "player": args.player}
    ok = True
    try:
        ab(session, "open", f"{base}/view?player={args.player}&proto=1")
        ab(session, "set", "viewport", "1280", "800")

        # -- wait for the v1 session to come up + the cache to warm (interest window + a few
        # z-levels present) before driving gestures -- an ice-cold cache would make the pan
        # phase legitimately fetch BLOCK_SETs (new territory), which is not what T2 tests.
        warmed = False
        t0 = time.time()
        last_cs, last_ws = None, None
        while time.time() - t0 < args.warm_timeout:
            last_ws = ws_stats(session)
            last_cs = cache_stats(session)
            if last_ws and last_ws.get("proto") == "v1" and last_cs and \
               last_cs.get("chunks", 0) >= 8 and last_cs.get("zLevels", 0) >= 3:
                warmed = True
                break
            time.sleep(0.5)
        results["warmup"] = {"warmed": warmed, "wait_s": round(time.time() - t0, 1),
                              "ws_stats": last_ws, "cache_stats": last_cs}
        if not last_ws or last_ws.get("proto") != "v1":
            print("CANNOT RUN: client never reported proto:v1 (DwfWS never connected v1, "
                  "or window.__wa_nav/DwfWS missing -- old bundle cached?)")
            sys.exit(2)
        if not warmed:
            print(f"WARN: cache did not fully warm within {args.warm_timeout}s "
                  f"(cache_stats={last_cs}) -- proceeding anyway, T2 may be noisy")

        # ---- T1: 10 zoom steps -> zero reconnects -------------------------------------
        nav_call(session, "stats")  # discard-read: clears any stray baseline before T1 starts
        for _ in range(args.zoom_steps):
            nav_call(session, "zoom", 1)
            time.sleep(0.15)
        t1 = nav_stats(session)
        t1_pass = bool(t1) and t1.get("reconnects", -1) == 0
        results["T1_zoom_reconnects"] = {"stats": t1, "pass": t1_pass,
                                          "steps": args.zoom_steps}
        ok = ok and t1_pass
        print(f"T1 zoom x{args.zoom_steps}: reconnects={t1 and t1.get('reconnects')}"
              + ("  PASS" if t1_pass else "  FAIL"))

        # ---- T2/T3: steady-state pan within cached area -------------------------------
        # Pause DF for this measurement: an ACTIVE fort legitimately dirties off-screen blocks
        # every tick (§0.8 point 5 -- global broadcast to EVERY v1 client, correct behavior),
        # which is real BLOCK_SET traffic that has nothing to do with navigation. T2/T3 test
        # the NAV-silence contract specifically, so isolate it the same way gate_parity.py
        # isolates its pixel diff (dfhack_lua pause/restore, best-effort).
        was_paused = None
        if not args.no_pause:
            was_paused = dfhack_lua("print(df.global.pause_state)")
            dfhack_lua("df.global.pause_state=true")
            time.sleep(2.0)  # let any already-queued/in-flight dirty backlog fully drain
        # Un-measured settle pan first (lets any genuinely-new edge blocks for THIS immediate
        # vicinity arrive) -- oscillate a small +-2 tile range so we never leave cached
        # territory. Then discard-read stats() to clear the baseline before the MEASURED
        # window, matching "after the first 500ms" from the acceptance block. Both phases run
        # as a SINGLE in-page loop each (nav_pan_for) so the frame-time measurement reflects
        # real rAF cadence, not Python/CLI subprocess round-trip noise between individual calls.
        nav_pan_for(session, 500)
        nav_call(session, "stats")  # discard -> fresh baseline for the measured window

        before_stats = tiles_stats(session)
        nav_pan_for(session, int(args.pan_secs * 1000))
        t2 = nav_stats(session)
        after_stats = tiles_stats(session)
        if was_paused == "false":
            dfhack_lua("df.global.pause_state=false")
        t2_bytes_pass = bool(t2) and t2.get("blockSetBytesWindow", -1) == 0
        t2_p95_pass = bool(t2) and isinstance(t2.get("frameP95Ms"), (int, float)) and t2["frameP95Ms"] <= p95_budget
        results["T2_pan_blockset_silence"] = {"stats": t2, "pass": t2_bytes_pass,
                                               "pan_secs": args.pan_secs}
        results["T3_pan_frame_p95"] = {"stats": t2, "p95_budget_ms": p95_budget,
                                        "pass": t2_p95_pass}
        ok = ok and t2_bytes_pass and t2_p95_pass
        print(f"T2 pan blockSetBytesWindow={t2 and t2.get('blockSetBytesWindow')}"
              + ("  PASS" if t2_bytes_pass else "  FAIL"))
        print(f"T3 pan frameP95Ms={t2 and t2.get('frameP95Ms')} (budget {p95_budget})"
              + ("  PASS" if t2_p95_pass else "  FAIL"))

        # T3b: a SINGLE pan input causes a repaint within ~2 frames (sceneBuildCount advances
        # promptly -- direct evidence of "instant re-window from the cache", not just an
        # aggregate frame-rate stat).
        n0 = (before_stats or {}).get("sceneBuildCount", 0)
        nav_call(session, "stats")  # fresh baseline for the isolated single-input probe
        nav_call(session, "pan", 1, 0)
        time.sleep(0.05)  # ~3 frames @60Hz -- generous slack over the "<=2 rAF" claim
        n1 = (tiles_stats(session) or {}).get("sceneBuildCount", 0)
        t3b_pass = n1 > n0
        results["T3b_single_pan_repaint"] = {"sceneBuildCount_before": n0, "after": n1,
                                              "pass": t3b_pass}
        ok = ok and t3b_pass
        print(f"T3b single-pan repaint: sceneBuildCount {n0} -> {n1}"
              + ("  PASS" if t3b_pass else "  FAIL"))

        # ---- T4: 5 z-move steps -> zero reconnects ------------------------------------
        nav_call(session, "stats")  # discard -> fresh baseline
        for i in range(args.z_steps):
            nav_call(session, "zmove", 1 if i % 2 == 0 else -1)
            time.sleep(0.2)
        t4 = nav_stats(session)
        t4_pass = bool(t4) and t4.get("reconnects", -1) == 0
        results["T4_zmove_reconnects"] = {"stats": t4, "pass": t4_pass, "steps": args.z_steps}
        ok = ok and t4_pass
        print(f"T4 zmove x{args.z_steps}: reconnects={t4 and t4.get('reconnects')}"
              + ("  PASS" if t4_pass else "  FAIL"))

        results["final_ws_stats"] = ws_stats(session)
        results["final_cache_stats"] = cache_stats(session)
    finally:
        try:
            ab(session, "close")
        except Exception:
            pass

    write_results(results, ok)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wa", action="store_true",
                     help="run the original WA-13 gate (canvas2d floor: p95<=33ms; T1/T2/T3/T4 "
                          "reconnect + wire-silence contract). Default (no --wa) runs the WB-16 "
                          "GL 60fps gate instead (p95<=17ms).")
    ap.add_argument("--host", default="127.0.0.1:8765")
    ap.add_argument("--player", default="qa-localnav")
    ap.add_argument("--camera", default="65,82,161")
    ap.add_argument("--pan-secs", type=float, default=3.0)
    ap.add_argument("--warm-timeout", type=float, default=20.0)
    # --wa-only args
    ap.add_argument("--zoom-steps", type=int, default=10, help="[--wa only]")
    ap.add_argument("--z-steps", type=int, default=5, help="[--wa only]")
    ap.add_argument("--no-pause", action="store_true",
                     help="[--wa only] don't pause DF for the T2/T3 measurement window -- an "
                          "ACTIVE fort legitimately dirties off-screen blocks every tick (§0.8 "
                          "point 5: global broadcast to every v1 client), which is real wire "
                          "traffic unrelated to navigation and would make T2/T3 fail for reasons "
                          "that have nothing to do with WA-13's wire-silent-nav contract")
    # --wb16 (default mode) args
    ap.add_argument("--renderer", default="gl", choices=["gl", "canvas2d"],
                     help="[default WB-16 mode only] which renderer to select via ?renderer=")
    ap.add_argument("--dims", default=None,
                     help="[default WB-16 mode only] e.g. 200x200 -- force the grid window to "
                          "this many tiles/side (capped at the client's own 200x200 max) via "
                          "DwfTiles.zoomTo(TILE_PX_MIN) + a matching viewport. Used for "
                          "the spec-required discrimination proof: canvas2d @ 200x200 must FAIL.")
    ap.add_argument("--p95-budget-ms", type=float, default=17.0,
                     help="[default WB-16 mode only] the WB-16 pass threshold")
    ap.add_argument("--require-wire-silence", action="store_true",
                     help="[default WB-16 mode only] additionally assert zero BLOCK_SET bytes "
                          "during the pan window (WA-13's T2). Defaults OFF per the WB-16 spec "
                          "text (\"until W-A's world replication flips it on\") -- WA-13's CAM "
                          "wire-silent-nav wave is already landed, so this is available, just "
                          "not part of WB-16's own pass criteria unless explicitly requested.")
    args = ap.parse_args()

    if args.wa:
        run_wa(args)
    else:
        run_wb16(args)


if __name__ == "__main__":
    main()
