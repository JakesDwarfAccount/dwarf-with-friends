"""USER-PERF GATE for dwf -- measures what the owner actually feels, not the wire.

Root of the 2026-07-08 perf audit (docs/superpowers/specs/2026-07-08-perf-audit.md):
gate_perf.py times WS frame DELIVERY to a headless probe and gate_localnav times an
empty GL uniform-scroll -- both have huge headroom, NEITHER measures the browser main
thread that the owner lives on. On a busy fort at wide zoom the full client pipeline (cache
decode + occluded canvas2d full repaint + GL scene rebuild + GL draw) runs ~30x/s on ONE
thread and collapses to 18-20fps. This gate drives a REAL browser (Chrome via CDP) at
wide zoom over a busy area, optionally with extra wide clients, and records browser-side
render fps + p95 frame time + long tasks AND the host DF cost (suspender ms/s, sim fps).

It is DESIGNED TO BE BORN RED: wide x busy x GL must FAIL today (p95 ~50-100ms) and go
green only after the F1 paint-gate + F3 rebuild-key fixes land. A green wide x busy run
against the pre-F1 page means the harness is measuring the wrong thing (exactly
gate_perf's blind spot -- do NOT rubber-stamp; see the completeness protocol, rule 3).

Scenario matrix (perf audit §3): zoom{default 24px, wide 12px} x area{quiet corner,
busy fort center} x clients{solo, multi = page + 2 wide headless ws_probe clients} = 8 GL
cells, plus ONE canvas2d wide x busy x solo cell (RECORD-ONLY, tracks the fallback's
health, never gates).

Usage:
  python gate_userperf.py                       # full matrix (auto solo-only if humans online)
  python gate_userperf.py --solo-only           # skip the 2-extra-client "multi" cells
  python gate_userperf.py --strict              # refuse to run at all if any human is connected
  python gate_userperf.py --meas 20 --warm 5    # per-cell measure / cache-warm seconds
  python gate_userperf.py --busy X,Y,Z --quiet X,Y,Z   # override discovered camera coords
  python gate_userperf.py --port 9333 --page-player userperf-page

PRECONDITION: refuses the MULTI cells while foreign human players are connected (they add
real wide-client suspender load to a live game). Default when humans are present: run SOLO
cells only, mark MULTI cells NOT-RUN. --strict refuses everything; --solo-only forces it.

Exit code 0 = PASS (every gating GL cell green), 1 = FAIL (>=1 gating cell red -- the
born-red state IS this), 2 = could not run (server/DF/Chrome down, or --strict + humans).
Evidence: results/userperf-<UTC>.json (full matrix + raw eval payloads + host samples).

Requires: DF running + fort loaded + capture-stream-start done; bundled Chrome under
~/.agent-browser (cdp_probe.py launch); `pip install websocket-client`.
"""
import argparse, json, os, re, subprocess, sys, tempfile, time, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cdp_probe          # CDP driver + launch/pick/pages (same dir)
import gate_perf          # Panner, unpause_df, http_get/http_post, DFHACK_RUN, LOCAL

PROBE = os.path.join(HERE, "ws_probe.py")
LOCAL = gate_perf.LOCAL            # "127.0.0.1:8765"
DFHACK_RUN = gate_perf.DFHACK_RUN
BASE = f"http://{LOCAL}"

# PASS thresholds (perf audit §3, anchored to "wide x busy must feel like the game")
RAF_FPS_MIN = 50.0
P95_FRAME_MS_MAX = 22.0
LONGTASK_MS_GATE = 200.0          # zero long tasks longer than this
SUSPENDER_MAX = 350.0             # multi cells only
SIM_FPS_TOLERANCE = 0.85          # multi cells: >= 85% of the same cell's solo sim fps

# ---------------------------------------------------------------------------------------
# SAWTOOTH / TAIL thresholds (perfhitch, 2026-07-08 -- the gates-vs-reality reconciliation).
# The original gate above measured p95FrameMs and longtasks>200ms. BOTH are blind to the F1
# keep-warm sawtooth the owner reported (30-150fps oscillation): a full-viewport occluded canvas2d
# repaint fired ~2-3x/s, each ~50-140ms, BLOCKING the GL main thread. Measured live differential
# at a busy fort (results/sawtooth-ctl2/fix2-*.json), pre-fix vs the incremental-keepwarm fix:
#   metric              pre-fix (sawtooth)   post-fix       old gate verdict
#   p95FrameMs          6.5                  6.5            PASS both  <- BLIND: hitches are ~2% of
#                                                                         frames, above p95
#   longtasksOver200    0                    0              PASS both  <- BLIND: each hitch <200ms
#   p99FrameMs          56.2                 12.5           (new) catches it
#   hitchesPerSec(>33)  3.27                 0.07           (new) catches it
#   longtaskMsPerSec    115                  0              (new) catches it
# So p95 + longtasks>200 let a violent, visible sawtooth PASS. The three metrics below are the
# tail/periodicity signal the user actually feels; thresholds sit between the measured pre-fix
# (FAIL) and post-fix (PASS) values so the gate is a real differential (completeness rule 3).
P99_FRAME_MS_MAX = 28.0           # sawtooth p99=56 FAILs; clean tail p99=12.5 PASSes (>22 headroom
                                  # for the occasional lone buildScene frame, still << a hitch)
HITCHES_PER_SEC_MAX = 1.5         # frames>33ms per second: sawtooth 3.3/s FAILs, clean 0.07/s PASSes
LONGTASK_MS_PER_SEC_MAX = 40.0    # total longtask ms per second: sawtooth 115 FAILs, clean 0 PASSes
                                  # -- catches the sub-200ms hitches longtasksOver200 structurally misses
HITCH_MS = 33.0                   # a "hitch" = a frame worse than ~2x a 60fps budget (dropped frame)

WIDE_DIMS = (200, 114)            # ~2560x1400 @ 12px/tile, clamped to the client's 200 cap


# ---------------------------------------------------------------------------- host probes
def diag():
    try:
        return json.loads(gate_perf.http_get(f"{BASE}/diag", 6))
    except Exception:
        return None

def foreign_players(d, own):
    """Player names in /diag that are NOT one of ours (own={page, probe names}). Human
    players connect under their own names; our clients use the reserved userperf-* names."""
    if not d:
        return []
    return [p["player"] for p in d.get("players", []) if p["player"] not in own]

def run_lua_file(lua_src):
    """dfhack-run lua -f <ABSOLUTE temp file> -- the ops-note pattern: inline multi-statement
    lua with `local`/loops fails ('unexpected symbol near local'); a file always works."""
    fd, path = tempfile.mkstemp(suffix=".lua", prefix="userperf-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(lua_src)
        out = subprocess.run([DFHACK_RUN, "lua", "-f", path],
                             capture_output=True, text=True, timeout=25)
        return (out.stdout or "") + (out.stderr or "")
    except Exception as e:
        return f"LUA-ERROR {e}"
    finally:
        try: os.remove(path)
        except OSError: pass

DISCOVER_LUA = r"""
local cx,cy,n = 0,0,0
local zc = {}
for _,u in ipairs(df.global.world.units.active) do
  local p = u.pos
  if p and p.x and p.x >= 0 then
    cx = cx + p.x; cy = cy + p.y; n = n + 1
    zc[p.z] = (zc[p.z] or 0) + 1
  end
end
local bz,bc = 0,-1
for z,c in pairs(zc) do if c > bc then bc = c; bz = z end end
local m = df.global.world.map
if n > 0 then
  print(('BUSY %d %d %d %d'):format(math.floor(cx/n), math.floor(cy/n), bz, n))
else
  print('BUSY none')
end
print(('MAP %d %d %d'):format(m.x_count, m.y_count, m.z_count))
"""

SAMPLE_LUA = r"""
print(('SAMPLE %d %d %d'):format(
  df.global.world.frame_counter,
  df.global.enabler.calculated_fps or 0,
  df.global.enabler.calculated_gfps or 0))
"""

def discover_cameras(args):
    """Busy = densest-units centroid + modal z (perf audit §3 'camera with most units');
    quiet = a map corner at the busy z. Both overridable via --busy/--quiet."""
    busy = quiet = None
    map_dims = None
    out = run_lua_file(DISCOVER_LUA)
    mb = re.search(r"BUSY\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)", out)
    mm = re.search(r"MAP\s+(\d+)\s+(\d+)\s+(\d+)", out)
    if mm:
        map_dims = tuple(int(x) for x in mm.groups())
    if mb:
        busy = (int(mb.group(1)), int(mb.group(2)), int(mb.group(3)))
    bz = busy[2] if busy else 100
    if map_dims:
        # a corner well away from the fort; 16,16 is on-map and almost always undiscovered rock
        quiet = (16, 16, bz)
    if args.busy:
        busy = tuple(int(x) for x in args.busy.split(","))
    if args.quiet:
        quiet = tuple(int(x) for x in args.quiet.split(","))
    if not busy:
        busy = (100, 100, 100)      # last-ditch fallback; real coords come from the lua scan
    if not quiet:
        quiet = (16, 16, busy[2])
    return busy, quiet, map_dims, out.strip()

def sample_host(player):
    """One host snapshot: suspender ms/s + this player's scan/dirty blocks + sim frame/fps."""
    d = diag()
    v1 = (d or {}).get("v1", {}) or {}
    row = next((r for r in v1.get("players", []) if r.get("player") == player), {})
    s = {"v1SuspenderMsPerSec": v1.get("v1SuspenderMsPerSec"),
         "worldSeq": v1.get("worldSeq"),
         "scanBlocks": row.get("scanBlocks"), "dirtyBlocks": row.get("dirtyBlocks")}
    out = run_lua_file(SAMPLE_LUA)
    ms = re.search(r"SAMPLE\s+(\d+)\s+(\d+)\s+(\d+)", out)
    if ms:
        s["frameCounter"] = int(ms.group(1))
        s["calculatedFps"] = int(ms.group(2))
        s["calculatedGfps"] = int(ms.group(3))
    s["wall"] = time.time()
    return s

def sim_fps(h0, h1):
    """Real sim advance rate = frame_counter delta / wallclock delta (DF caps at 100)."""
    try:
        dt = h1["wall"] - h0["wall"]
        if dt <= 0:
            return None
        return round((h1["frameCounter"] - h0["frameCounter"]) / dt, 1)
    except (KeyError, TypeError):
        return None


# --------------------------------------------------------------------------- browser drive
def cdp_eval(cdp, expr, await_promise=False):
    r = cdp.call("Runtime.evaluate", expression=expr, returnByValue=True,
                 awaitPromise=await_promise)
    if "exceptionDetails" in r:
        return {"__error__": str(r.get("exceptionDetails"))}
    return r.get("result", {}).get("value")

def move_camera(player, x, y, z):
    try:
        gate_perf.http_post(f"{BASE}/camera?player={player}&x={x}&y={y}&z={z}", 8)
        return True
    except Exception:
        return False

def wait_warm(cdp, warm_s):
    """Wait for the WS snapshot to complete (cache warm) then settle, per §3 step 3."""
    deadline = time.time() + max(warm_s, 8)
    while time.time() < deadline:
        st = cdp_eval(cdp, "(window.DwfWS&&DwfWS.getStats)?"
                           "!!DwfWS.getStats().snapshotDone:false")
        if st is True:
            break
        time.sleep(0.5)
    time.sleep(warm_s)

def measure_js(meas_ms):
    return r"""
new Promise(function(resolve){
  var T=window.DwfTiles, R=window.DwfRender, WS=window.DwfWS;
  var MEAS=%d, t0=performance.now(), frames=0, deltas=[], last=t0;
  var ltCount=0, ltTotal=0, ltMax=0, ltOver200=0;
  var obs=null;
  try {
    obs=new PerformanceObserver(function(list){
      list.getEntries().forEach(function(e){
        ltCount++; ltTotal+=e.duration; if(e.duration>ltMax) ltMax=e.duration;
        if(e.duration>200) ltOver200++;
      });
    });
    obs.observe({entryTypes:['longtask']});
  } catch(_){}
  function stats(){ try { return (R&&R.getStats)?R.getStats():((T&&T.getStats)?T.getStats():{}); } catch(_){ return {}; } }
  function wsStats(){ try { return (WS&&WS.getStats)?WS.getStats():{}; } catch(_){ return {}; } }
  var s0=stats(), done=false;
  function loop(ts){
    if(done) return;
    frames++; deltas.push(ts-last); last=ts;
    if(performance.now()-t0 < MEAS){ requestAnimationFrame(loop); return; }
    finish(false);
  }
  // Backstop: if the GL rAF loop truly freezes (or Chrome still throttles rAF to ~0), loop()
  // never fires again and the Promise would hang forever -> resolve anyway after MEAS+3s with
  // whatever frames we got. A frozen loop reads as rafFps~0, which correctly FAILS the cell
  // (that IS a stall) rather than timing out the whole gate.
  setTimeout(function(){ finish(true); }, MEAS+3000);
  function finish(viaBackstop){
    if(done) return; done=true;
    if(obs){ try{obs.disconnect();}catch(_){} }
    var elapsed=(performance.now()-t0)/1000;
    var s1=stats(), ws=wsStats();
    var d=deltas.slice(1).sort(function(a,b){return a-b;});   // drop first (warmup) delta
    function pct(q){ return d.length?+d[Math.min(d.length-1,Math.floor(d.length*q))].toFixed(2):0; }
    var mem=(performance.memory)?{usedJSHeapMB:+(performance.memory.usedJSHeapSize/1048576).toFixed(1)}:null;
    function pick(o,k){ return (o&&o[k]!=null)?o[k]:null; }
    // SAWTOOTH / TAIL metrics (perfhitch): p99 + hitch count catch the periodic keep-warm block
    // that lands ABOVE p95 and stays UNDER the 200ms longtask gate -- see gate_userperf's
    // threshold banner. Count hitches over the RAW delta series (not the warmup-trimmed sort).
    var HITCH=33.0, hitches=0; for(var hi=0;hi<deltas.length;hi++){ if(deltas[hi]>HITCH) hitches++; }
    var hitchesPerSec=+(hitches/Math.max(0.001,elapsed)).toFixed(3);
    var longtaskMsPerSec=+(ltTotal/Math.max(0.001,elapsed)).toFixed(1);
    resolve({
      elapsedS:+elapsed.toFixed(2), viaBackstop:!!viaBackstop,
      rafFps:+(frames/elapsed).toFixed(1),
      p50FrameMs:pct(0.50), p95FrameMs:pct(0.95), p99FrameMs:pct(0.99),
      maxFrameMs:d.length?+d[d.length-1].toFixed(2):0,
      hitches:hitches, hitchesPerSec:hitchesPerSec,
      longtasks:ltCount, longtaskMs:+ltTotal.toFixed(1), longtaskMsPerSec:longtaskMsPerSec,
      longtaskMaxMs:+ltMax.toFixed(1), longtasksOver200:ltOver200,
      renderer:pick(s1,'renderer'),
      drawsPerSec:pick(s1,'drawsPerSec'), lastDrawMs:pick(s1,'lastDrawMs'),
      sceneBuildDelta:(s1&&s0&&s1.sceneBuildCount!=null&&s0.sceneBuildCount!=null)?(s1.sceneBuildCount-s0.sceneBuildCount):null,
      lastBuildMs:pick(s1,'lastBuildMs'),
      blockSetBytesPerSec:pick(ws,'blockSetBytesPerSec'), auxBytesPerSec:pick(ws,'auxBytesPerSec'),
      estBehindMs:pick(ws,'estBehindMs'), worldSeq:pick(ws,'worldSeq'),
      mem:mem,
    });
  }
  requestAnimationFrame(loop);
});
""" % meas_ms


# ------------------------------------------------------------------------------- cell eval
def gate_cell(cell, m, host_start, host_end, solo_sim):
    """Return (passed|None, reasons[]). None = record-only (canvas2d)."""
    reasons = []
    if not m or "__error__" in (m or {}):
        return (False if cell["renderer"] == "gl" else None), ["measurement failed: %s" % (m or {}).get("__error__", "no data")]
    if cell["renderer"] != "gl":
        return None, []          # canvas2d: record-only, never gates
    if m.get("rafFps", 0) < RAF_FPS_MIN:
        reasons.append(f"rafFps {m.get('rafFps')} < {RAF_FPS_MIN}")
    if m.get("p95FrameMs", 1e9) > P95_FRAME_MS_MAX:
        reasons.append(f"p95FrameMs {m.get('p95FrameMs')} > {P95_FRAME_MS_MAX}")
    if m.get("longtasksOver200", 0) > 0:
        reasons.append(f"longtasks>200ms = {m.get('longtasksOver200')}")
    # SAWTOOTH / TAIL gating (perfhitch) -- the checks that actually catch the keep-warm hitch
    # (p95 + longtasks>200 above are both blind to it; see the threshold banner's differential).
    if m.get("p99FrameMs", 1e9) > P99_FRAME_MS_MAX:
        reasons.append(f"p99FrameMs {m.get('p99FrameMs')} > {P99_FRAME_MS_MAX} (tail hitch)")
    if m.get("hitchesPerSec", 1e9) > HITCHES_PER_SEC_MAX:
        reasons.append(f"hitchesPerSec {m.get('hitchesPerSec')} > {HITCHES_PER_SEC_MAX} (frames>{int(HITCH_MS)}ms)")
    if m.get("longtaskMsPerSec", 1e9) > LONGTASK_MS_PER_SEC_MAX:
        reasons.append(f"longtaskMsPerSec {m.get('longtaskMsPerSec')} > {LONGTASK_MS_PER_SEC_MAX} (sawtooth block time)")
    if cell["clients"] == "multi":
        susp = (host_end or {}).get("v1SuspenderMsPerSec")
        if susp is not None and susp > SUSPENDER_MAX:
            reasons.append(f"v1SuspenderMsPerSec {susp} > {SUSPENDER_MAX}")
        mine = sim_fps(host_start, host_end)
        base = solo_sim.get((cell["area"], cell["zoom"]))
        if base and mine is not None and mine < SIM_FPS_TOLERANCE * base:
            reasons.append(f"simFps {mine} < {int(SIM_FPS_TOLERANCE*100)}% of solo {base}")
    return (len(reasons) == 0), reasons


def run_cell(cdp, cell, args, coords, solo_sim):
    x, y, z = coords[cell["area"]]
    zoom_px = 12 if cell["zoom"] == "wide" else 24
    label = f'{cell["area"]}-{cell["zoom"]}-{cell["clients"]}-{cell["renderer"]}'

    # canvas2d record cell: re-navigate the page onto the fallback renderer for this one cell
    if cell["renderer"] == "canvas2d":
        cdp.call("Page.navigate",
                 url=f"{BASE}/?renderer=canvas2d&player={args.page_player}")
        time.sleep(3)
        cdp.call("Emulation.setDeviceMetricsOverride", width=2560, height=1400,
                 deviceScaleFactor=1, mobile=False)

    move_camera(args.page_player, x, y, z)
    cdp_eval(cdp, f"window.DwfTiles&&DwfTiles.zoomTo&&DwfTiles.zoomTo({zoom_px})")

    # multi: 2 extra WIDE headless clients pointed at the same area + panning (adds server load)
    probes, panners = [], []
    if cell["clients"] == "multi":
        secs = int(args.warm + args.meas + 12)
        for i in (1, 2):
            pl = f"userperf-{i}"
            move_camera(pl, x, y, z)
            p = subprocess.Popen(
                [sys.executable, PROBE, pl, str(secs), "proto1",
                 f"dims:{WIDE_DIMS[0]}x{WIDE_DIMS[1]}"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            probes.append(p)
            pan = gate_perf.Panner(BASE, pl); pan.start(); panners.append(pan)

    wait_warm(cdp, args.warm)
    h0 = sample_host(args.page_player)
    cdp.ws.settimeout(args.meas + 40)
    m = cdp_eval(cdp, measure_js(int(args.meas * 1000)), await_promise=True)
    cdp.ws.settimeout(30)
    h1 = sample_host(args.page_player)

    for pan in panners:
        pan.stop(); pan.join(2)
    for p in probes:
        try: p.terminate()
        except Exception: pass

    if cell["renderer"] == "gl" and cell["clients"] == "solo":
        s = sim_fps(h0, h1)
        if s is not None:
            solo_sim[(cell["area"], cell["zoom"])] = s

    passed, reasons = gate_cell(cell, m, h0, h1, solo_sim)
    rec = {"cell": label, **cell, "camera": [x, y, z], "zoomPx": zoom_px,
           "measure": m, "hostStart": h0, "hostEnd": h1,
           "simFps": sim_fps(h0, h1),
           "pass": passed, "reasons": reasons}
    verdict = "PASS" if passed is True else ("FAIL" if passed is False else "RECORD")
    rf = (m or {}).get("rafFps"); p95 = (m or {}).get("p95FrameMs"); p99 = (m or {}).get("p99FrameMs")
    hps = (m or {}).get("hitchesPerSec"); ltps = (m or {}).get("longtaskMsPerSec")
    print(f"  {label:34s} rafFps={rf} p95={p95} p99={p99} hitch/s={hps} lt-ms/s={ltps}  {verdict}"
          + (f"  [{'; '.join(reasons)}]" if reasons else ""))
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meas", type=float, default=20.0, help="measure seconds per cell")
    ap.add_argument("--warm", type=float, default=5.0, help="cache-warm seconds per cell")
    ap.add_argument("--solo-only", action="store_true", help="skip the 2-extra-client multi cells")
    ap.add_argument("--strict", action="store_true", help="refuse to run at all if a human is connected")
    ap.add_argument("--busy", default=None, help="X,Y,Z override for the busy area")
    ap.add_argument("--quiet", default=None, help="X,Y,Z override for the quiet area")
    ap.add_argument("--port", type=int, default=9333)
    ap.add_argument("--page-player", default="userperf-page")
    ap.add_argument("--keep-open", action="store_true", help="don't kill Chrome at the end")
    args = ap.parse_args()

    own = {args.page_player, "userperf-1", "userperf-2"}

    # ---- preflight -------------------------------------------------------------------
    try:
        assert '"ok":true' in gate_perf.http_get(f"{BASE}/health", 5)
    except Exception as e:
        print(f"CANNOT RUN: dwf server not reachable on {LOCAL}: {e}")
        sys.exit(2)
    if not gate_perf.unpause_df():
        print("WARN: could not unpause DF via dfhack-run (sim-fps cells need a running sim)")

    d0 = diag()
    humans = foreign_players(d0, own)
    solo_only = args.solo_only
    if humans:
        print(f"NOTE: foreign human player(s) connected: {humans}")
        if args.strict:
            print("--strict + humans online -> refusing to run (would add wide-client load).")
            sys.exit(2)
        print("      -> running SOLO cells only; MULTI cells marked NOT-RUN "
              "(they would add 2 wide clients of suspender load to a live game).")
        solo_only = True

    busy, quiet, map_dims, discover_raw = discover_cameras(args)
    coords = {"busy": busy, "quiet": quiet}
    print(f"cameras: busy={busy} quiet={quiet} map={map_dims}")

    # ---- matrix (solo cells first, so multi can compare sim fps to the solo baseline) ----
    cells = []
    for area in ("quiet", "busy"):
        for zoom in ("default", "wide"):
            cells.append({"area": area, "zoom": zoom, "clients": "solo", "renderer": "gl"})
    if not solo_only:
        for area in ("quiet", "busy"):
            for zoom in ("default", "wide"):
                cells.append({"area": area, "zoom": zoom, "clients": "multi", "renderer": "gl"})
    # the single canvas2d record-only cell (wide x busy x solo)
    canvas_cell = {"area": "busy", "zoom": "wide", "clients": "solo", "renderer": "canvas2d"}

    # ---- launch Chrome on the GL page ------------------------------------------------
    url = f"{BASE}/?renderer=gl&player={args.page_player}"
    print(f"launching Chrome: {url}")
    try:
        lp = subprocess.run([sys.executable, os.path.join(HERE, "cdp_probe.py"),
                             "launch", url, "--port", str(args.port)],
                            capture_output=True, text=True, timeout=60)
        port = json.loads(lp.stdout.strip().splitlines()[-1])["port"]
    except Exception as e:
        print(f"CANNOT RUN: chrome launch failed: {e} :: {getattr(lp,'stderr','')}")
        sys.exit(2)
    time.sleep(3)
    try:
        target = cdp_probe.pick(port, args.page_player) if False else cdp_probe.pages(port)[0]
        cdp = cdp_probe.CDP(target)
    except Exception as e:
        print(f"CANNOT RUN: no CDP page target on port {port}: {e}")
        sys.exit(2)
    cdp.call("Emulation.setDeviceMetricsOverride", width=2560, height=1400,
             deviceScaleFactor=1, mobile=False)
    # initial warm on the GL page before the first cell
    time.sleep(2)
    wait_warm(cdp, args.warm)

    solo_sim = {}
    records = []
    skipped = []
    print("running GL cells...")
    for cell in cells:
        try:
            records.append(run_cell(cdp, cell, args, coords, solo_sim))
        except Exception as e:
            print(f"  {cell} ERRORED: {e}")
            records.append({"cell": str(cell), **cell, "error": str(e), "pass": False})
    if solo_only:
        for area in ("quiet", "busy"):
            for zoom in ("default", "wide"):
                skipped.append({"cell": f"{area}-{zoom}-multi-gl", "area": area, "zoom": zoom,
                                "clients": "multi", "renderer": "gl", "pass": None,
                                "notRun": "foreign human online / --solo-only"})
    # canvas2d record cell last (it re-navigates the page)
    print("running canvas2d record-only cell...")
    try:
        records.append(run_cell(cdp, canvas_cell, args, coords, solo_sim))
    except Exception as e:
        print(f"  canvas2d cell ERRORED: {e}")

    if not args.keep_open:
        try: cdp.call("Browser.close")
        except Exception: pass

    # ---- verdict: every GATING (gl) cell must be green -------------------------------
    gating = [r for r in records if r.get("renderer") == "gl"]
    ok = all(r.get("pass") is True for r in gating) and len(gating) > 0

    stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    outdir = os.path.join(HERE, "results")
    os.makedirs(outdir, exist_ok=True)
    summary = {
        "utc": stamp, "meas_s": args.meas, "warm_s": args.warm,
        "thresholds": {"rafFpsMin": RAF_FPS_MIN, "p95FrameMsMax": P95_FRAME_MS_MAX,
                       "p99FrameMsMax": P99_FRAME_MS_MAX, "hitchesPerSecMax": HITCHES_PER_SEC_MAX,
                       "longtaskMsPerSecMax": LONGTASK_MS_PER_SEC_MAX, "hitchMs": HITCH_MS,
                       "longtaskMsGate": LONGTASK_MS_GATE, "suspenderMax": SUSPENDER_MAX,
                       "simFpsTolerance": SIM_FPS_TOLERANCE},
        "cameras": {"busy": busy, "quiet": quiet, "mapDims": map_dims},
        "discoverRaw": discover_raw,
        "foreignHumans": humans, "soloOnly": solo_only,
        "cells": records, "notRun": skipped, "pass": ok,
    }
    outpath = os.path.join(outdir, f"userperf-{stamp}.json")
    with open(outpath, "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"\n{'PASS' if ok else 'FAIL'}  (evidence: results/userperf-{stamp}.json)")
    if not ok:
        print("  (a FAIL on wide x busy pre-F1 is the EXPECTED born-red baseline -- that IS the point)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
