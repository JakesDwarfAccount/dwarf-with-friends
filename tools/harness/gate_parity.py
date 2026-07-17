"""PIXEL-DIFF PARITY GATE for dwf (adopts docs/superpowers/scout/ws2-tile-feasibility.md §5).

Compares the CLIENT's tile reconstruction against DF's OWN rendered frame for the
SAME camera/viewport and produces a numeric score + a per-tile heatmap PNG showing
exactly what's wrong.

  ORACLE: GET /frame.jpg?player=P  -- the internal capture_camera_frame path (JPEG
          mode is retired as a product view but KEPT as the parity oracle, per the
          2026-07-06 brief §7). Rendered by DF itself at player P's camera, map-only
          (no DF UI). Grid geometry comes from GET /zoom-probe (viewport screenX/Y
          offset, dimX/dimY tiles) plus an empirical per-run alignment search.
  CLIENT: headless Chrome via the `agent-browser` CLI opens /tiles.html?player=P
          (the real render client, WS push with HTTP-poll fallback), pins a
          1280x800 viewport, hides the HUD overlay, and screenshots the canvas.
          Client grid geometry is exact: DwfTiles.getRenderRect().
  ORACLE (--oracle window, 2026-07-07 M1 item): an OS-level PrintWindow capture of the
          REAL on-screen "Dwarf Fortress" window (win_capture.py) -- the only oracle
          downstream of DF's screen-space fog present pass, so it's the one mode where
          fog correctness actually shows up in the score (see fetch_window_oracle()'s
          docstring for the grid-alignment method + IMPORTANT: the native window's camera
          is DF's own df.global.window_x/y/z, an INDEPENDENT value from any virtual
          per-player camera incl. --player's own -- --camera for this mode moves the
          native camera itself, restored afterward).

Both grids are resampled to a canonical S px/tile over their overlapping W x H
tile window (same world origin -- both windows start at the player camera), then
diffed per tile (mean abs RGB). Oracle geometry (pixel origin/cell size/tile-grid dims) is
derived from the ACTUAL rendered content (measure_content_bbox()/derive_oracle_geometry())
plus the /tiledump meta.json sidecar's dim_x/dim_y, NOT from /zoom-probe's live viewport
state -- sweep #2 §2 found capture_shifted's per-player-zoom-guard can render into a
viewport smaller than, and geometrically unrelated to, whatever /zoom-probe reports live
(a zoom/dims reference frozen the first capture of the DF session, that does not track
later window resizes/zoom changes). Outputs:
  results/parity-<UTC>/oracle.png,client.png  -- the aligned, resampled inputs
  results/parity-<UTC>/heatmap.png            -- per-tile error, black->red->yellow->white
  results/parity-<UTC>/triptych.png           -- oracle | client | heatmap side by side
  results/parity-<UTC>/parity.json            -- {score, p95, badTilePct, geometry, ...}

Score semantics: per-tile mean-absolute-RGB-error, 0..255 (JPEG compression alone
contributes a small noise floor, ~2-5). "badTilePct" = % of tiles with error > 30
(visibly wrong). New coverage work must SHRINK the score, never grow it (§9).

Usage (MUST use the Pillow/numpy env -- do not pip install):
  python gate_parity.py
  ... [--camera X,Y,Z] [--player qa-parity] [--host 127.0.0.1:8765]
      [--max-score N]   # enforce: exit 1 if score > N (else report-only)
      [--no-pause]      # don't pause DF around the captures (moving creatures skew)
Exit: 0 ok (or report-only), 1 score exceeds --max-score, 2 could not run.

Requires: DF running w/ loaded fort + capture-stream-start; `agent-browser` on PATH.
"""
import argparse, json, os, shutil, subprocess, sys, time, datetime, io
import urllib.request

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

HERE = os.path.dirname(os.path.abspath(__file__))
DF_ROOT_DEFAULT = dfroot.df_root_for(__file__, purpose="scores the browser against the real DF window")
DFHACK_RUN = DF_ROOT_DEFAULT + r"\hack\dfhack-run.exe"
CANON = 24  # canonical px/tile for the diff

def http(url, timeout=15, method="GET"):
    req = urllib.request.Request(url, method=method, data=(b"" if method == "POST" else None))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def _find_ab():
    """Prefer the real .exe over the npm .cmd shim: .cmd runs through cmd.exe, which
    interprets '&' in URLs as a command separator even with an argv list (no shell)."""
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
    """Run the CLI with stdout/stderr redirected to FILES, never pipes: the agent-browser
    CLI spawns a detached daemon that INHERITS the parent's handles, so with pipes
    subprocess.run(capture_output=True) blocks forever on the read side even after the
    CLI exits (and even after a timeout-kill -- run() re-enters communicate()). Files
    don't have that failure mode; we read them back after the process exits."""
    import tempfile
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
    """Run one agent-browser command; returns stdout. Raises on nonzero exit.
    The agent-browser daemon can wedge (stale daemon after a CLI update: every call
    fails 'Invalid response: EOF...' / 'daemon started concurrently'). Recovery that
    works in practice: kill the daemon process and retry -- so do that once, automatically,
    whenever a call fails with a daemon-shaped error (the gate must run unattended)."""
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
                time.sleep(3)   # post-restart race: one more try
                p = _ab_once(session, args, timeout)
    if p.returncode != 0:
        raise RuntimeError(f"agent-browser {' '.join(args[:2])} failed: {p.stdout} {p.stderr}")
    return p.stdout.strip()

def dfhack_lua(code, dfhack_run=DFHACK_RUN):
    p = subprocess.run([dfhack_run, "lua", code], capture_output=True, text=True, timeout=20)
    return (p.stdout or "").strip()

def fetch_jpeg_oracle(base, player):
    """Today's oracle: DF's own capture_camera_frame path (composite_seedown_into runs --
    manufactures see-down fog DF doesn't have, per the fog report). Kept for surface scenes
    and as the --oracle both discrimination baseline."""
    oracle_bytes = http(f"{base}/frame.jpg?player={player}")
    return Image.open(io.BytesIO(oracle_bytes)).convert("RGB")

def fetch_tiledump_meta(out_dir):
    """Read the meta.json sidecar /tiledump ALWAYS writes next to ground_truth.png/frame.bin
    (unconditionally, regardless of gt=/atlas= params) --
    {"camera":..., "dim_x":, "dim_y":, "clip_x":, "clip_y":, "tick":, "frame_w":, "frame_h":}.
    dim_x/dim_y are `gps->main_viewport->dim_x/dim_y` AT CAPTURE TIME (src/sdl_capture.cpp
    fill_tile_layer_dump) -- the one authoritative source for the tile-grid DF's viewport
    actually rendered THIS capture into. frame_w/frame_h are the full capture-buffer pixel
    dims (always the current DF window size)."""
    with open(os.path.join(out_dir, "meta.json")) as f:
        return json.load(f)

def probe_tiledump_meta(base, df_root, cam, run_tag):
    """Cheap geometry-only /tiledump call (gt=0 skips the PNG encode+write; ~25ms either way)
    for callers scoring a DIFFERENT oracle image (--oracle jpeg scores /frame.jpg) that still
    need dim_x/dim_y -- valid because /frame.jpg and /tiledump render the SAME camera through
    the exact same capture_shifted path (same ViewportZoomGuard state), so they share identical
    viewport geometry; confirmed empirically 2026-07-07 (content bbox on /frame.jpg matched
    /tiledump's to within a few px at the same camera/session)."""
    dir_rel = f"dwf_paritygate/{run_tag}-meta"
    url = (f"{base}/tiledump?x={cam['x']}&y={cam['y']}&z={cam['z']}"
           f"&dir={dir_rel}&gt=0&atlas=0")
    body = json.loads(http(url, timeout=30))
    if not body.get("ok"):
        raise RuntimeError(f"/tiledump (meta-only) failed: {body.get('err', '(no err)')}")
    return fetch_tiledump_meta(os.path.join(df_root, dir_rel.replace("/", os.sep)))

def fetch_window_oracle(base, df_root, cam, run_tag):
    """WINDOW oracle (M1 fog-blind-oracle fix, 2026-07-07): an OS-level PrintWindow capture of
    the ACTUAL on-screen DF window (win_capture.py) -- the only capture path downstream of DF's
    screen-space fog *present* pass (both /frame.jpg and /tiledump read a pre-present buffer;
    see docs/superpowers/specs/2026-07-06-fog-lighting-report.md §7 and docs/reference/fogparams.json
    fogparams.json's `seeDown` entry). Passive/read-only: no input injection, no focus steal.
    CONSTRAINT: DF's window must be visible on screen and NOT minimized (win_capture.py's
    DFWindowNotFound/DFWindowMinimized map to CANNOT RUN here, never a score of 0).

    GRID ALIGNMENT (the interesting part): geometry is NOT measured off the window image
    itself -- DF draws its UI chrome (topbar/sidebars/minimap/toolbar) as a full-bleed OVERLAY
    on the SAME screen-space the map plane occupies, rather than reserving a separate region,
    so generic content-bbox detection (measure_content_bbox) would find chrome pixels almost
    everywhere and return a useless/oversized bbox. Calibration instead reuses a same-instant
    RAW /tiledump capture (fetch_raw_oracle) purely for its geometry: confirmed empirically
    2026-07-07 (region1, camera 58,72,161) that a live tiledump's measured content bbox spans
    its ENTIRE frame_w x frame_h capture buffer end to end (bbox (1,2,2078,1444) against a
    2078x1444 buffer), and that frame_w/frame_h is IDENTICAL, pixel for pixel, to the real
    window's client-area size (win_capture.py's client_size) for the same window -- i.e. DF's
    offscreen tiledump buffer and the real window's client area are the SAME coordinate space,
    the map plane fills both edge-to-edge, and only the real window additionally has UI drawn
    on top. That means the raw oracle's derive_oracle_geometry() output (pixel origin/cell
    size/tile-grid dims) transfers UNCHANGED onto the window screenshot: no separate bbox
    search needed for the window image, just the same small alignment refinement gate_parity
    already runs for every oracle (the existing dx/dy scan in main() -- this IS the residual-
    error correction: it soaks up any sub-pixel rounding between the two captures, typically
    0-3px in practice).

    RESIDUAL / KNOWN LIMITATION: DF's own UI chrome is real content in the window oracle that
    the client obviously never renders (no client HUD sits at those screen coordinates) --
    tiles under the persistent topbar/left icon ribbon/right minimap/bottom toolbar will show
    elevated per-tile error in the heatmap REGARDLESS of fog correctness, inflating the
    aggregate score_mae for any camera framing that includes window edges. This is symmetric
    across an A/B (same chrome pixels present whether the CLIENT is drawn with or without fog),
    so relative comparisons (fog on vs off, this item's whole point) are unaffected; absolute
    scores are only really comparable to another --oracle window run at the same window size/
    camera, not to --oracle raw/jpeg numbers. No chrome-masking is implemented (out of this
    item's scope) -- point the camera so the region of interest sits away from the window's own
    edges to minimize it, or accept the inflation as a known constant offset.

    Returns (window_img, meta, geom_img): window_img is the image actually SCORED against the
    client; geom_img is the same-instant raw tiledump image handed to derive_oracle_geometry()
    (never scored itself); meta is geom_img's sidecar (dim_x/dim_y/frame_w/frame_h etc.)."""
    from win_capture import capture_df_client_area, DFWindowNotFound, DFWindowMinimized
    try:
        win_img, win_meta = capture_df_client_area()
    except DFWindowNotFound as e:
        print(f"CANNOT RUN: {e}"); sys.exit(2)
    except DFWindowMinimized as e:
        print(f"CANNOT RUN: {e} -- DF must be visible (not minimized) for --oracle window")
        sys.exit(2)
    geom_img, meta = fetch_raw_oracle(base, df_root, cam, run_tag)
    win_size = tuple(win_meta["client_size"])
    meta_size = (meta.get("frame_w"), meta.get("frame_h"))
    if win_size != meta_size:
        print(f"WARN: window client_size {win_size} != tiledump frame_w/h {meta_size} -- the "
              f"window and DF's internal capture buffer disagree on the current window pixel "
              f"size (resized/DPI-changed between captures?); the geometry-transfer assumption "
              f"above is violated -- treat this run's --oracle window score as unreliable")
    return win_img, meta, geom_img


def fetch_raw_oracle(base, df_root, cam, run_tag):
    """WB-2 raw oracle: GET /tiledump (src/http_server.cpp ~782-808) renders the SAME camera
    through capture_frame_with_tile_layers -- the live-stream capture_shifted path WITHOUT
    composite_seedown_into -- and writes a lossless ground_truth.png server-side under the DF
    root. ~25ms, safe under DF lock, runs on an httplib worker thread (NEVER via a
    dfhack-run console command -- that deadlocks DF, render-buffer verdict §E). `dir` is
    scoped to this run (unique per call) so concurrent gate runs never collide on disk.
    Returns (image, meta) -- see fetch_tiledump_meta for meta's fields."""
    dir_rel = f"dwf_paritygate/{run_tag}"
    url = (f"{base}/tiledump?x={cam['x']}&y={cam['y']}&z={cam['z']}"
           f"&dir={dir_rel}&gt=1&atlas=0")
    body = json.loads(http(url, timeout=30))
    if not body.get("ok"):
        raise RuntimeError(f"/tiledump failed: {body.get('err', '(no err)')}")
    out_dir = os.path.join(df_root, dir_rel.replace("/", os.sep))
    png_path = os.path.join(out_dir, "ground_truth.png")
    if not os.path.isfile(png_path):
        raise RuntimeError(f"/tiledump reported ok but {png_path} is missing "
                           f"(wrong --df-root? default is {DF_ROOT_DEFAULT!r})")
    return Image.open(png_path).convert("RGB"), fetch_tiledump_meta(out_dir)

def detect_bg_color(arr):
    """Sample all four corners of an HxWx3 int array and return their median -- robust to one
    corner accidentally landing on real content. The oracle's offscreen capture buffer is
    blank outside whatever DF's render actually touched (confirmed pure black in every scene
    sampled 2026-07-07), and content anchors at the top-left, so a far corner is reliably
    background."""
    h, w, _ = arr.shape
    corners = [arr[0, 0], arr[0, w - 1], arr[h - 1, 0], arr[h - 1, w - 1]]
    return np.median(np.stack(corners), axis=0)

def measure_content_bbox(img, thresh=10, min_hits=2):
    """Find the pixel bounding box of DF's ACTUALLY-rendered content in an oracle image, by
    diffing every pixel against detect_bg_color() and looking for rows/cols with at least
    `min_hits` pixels differing by more than `thresh` (summed abs RGB, ~3.3/channel -- JPEG
    ringing near content edges is local and does not spread deep into background). Returns
    (x0, y0, x1, y1) (x1/y1 exclusive) or None if no content is distinguishable from
    background (e.g. a fully blank capture).

    Why this exists (sweep #2 §2): capture_shifted's per-player-zoom-guard can render into a
    viewport SMALLER than (and geometrically unrelated to) whatever /zoom-probe reports live
    -- a zoom/dims reference frozen the first time any capture ran this DF session, that does
    NOT track later window resizes or live zoom changes. The capture BUFFER (frame_w/h)
    always matches the current window; the POPULATED region does not. Measuring content
    extent directly off pixels sidesteps needing to know why/by how much the shrink
    happened, and self-corrects if the live/frozen relationship ever changes.
    """
    arr = np.asarray(img, dtype=np.int16)
    bg = detect_bg_color(arr)
    diff = np.abs(arr - bg).sum(axis=2)
    colact = (diff > thresh).sum(axis=0)
    rowact = (diff > thresh).sum(axis=1)
    xs = np.where(colact > min_hits)[0]
    ys = np.where(rowact > min_hits)[0]
    if xs.size == 0 or ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1

def derive_oracle_geometry(oracle_img, meta, fallback_probe=None):
    """Authoritative oracle grid geometry for the parity crop: (offx, offy, cw, ch, dim_x,
    dim_y, source). dim_x/dim_y come straight from the /tiledump meta.json sidecar (see
    fetch_tiledump_meta) -- the exact tile-grid DF's viewport rendered THIS capture at.
    offx/offy/cw/ch (pixel origin + per-tile pixel size) are measured directly off the oracle
    image's own content bounding box (measure_content_bbox) divided by dim_x/dim_y -- NOT
    re-derived from /zoom-probe's LIVE viewport state, which the sweep #2 §2 finding showed
    is frequently a DIFFERENT geometry than what actually got rendered into the oracle buffer.

    Falls back to the old /zoom-probe zoom/4.0-heuristic + screenX/Y ONLY if no content is
    distinguishable from background (measure_content_bbox returns None) -- e.g. a genuinely
    blank capture -- so a real oracle failure still produces some geometry rather than a
    crash; this path is expected to be wrong per the same sweep #2 finding and is flagged
    loudly when taken.
    """
    dim_x, dim_y = meta.get("dim_x", 0), meta.get("dim_y", 0)
    if dim_x > 0 and dim_y > 0:
        bbox = measure_content_bbox(oracle_img)
        if bbox is not None:
            x0, y0, x1, y1 = bbox
            return x0, y0, (x1 - x0) / dim_x, (y1 - y0) / dim_y, dim_x, dim_y, "measured"
    if fallback_probe is not None:
        vp0 = fallback_probe["viewport"]
        cell0 = fallback_probe["gps"]["viewportZoomFactor"] / 4.0
        print("WARN: could not measure oracle content bbox (or bad meta dim_x/dim_y); "
              "falling back to the /zoom-probe zoom/4.0 heuristic -- KNOWN WRONG under the "
              "sweep #2 §2 viewport-shrink bug; treat this run's geometry as unverified")
        dx = dim_x if dim_x > 0 else vp0["dimX"]
        dy = dim_y if dim_y > 0 else vp0["dimY"]
        return vp0["screenX"], vp0["screenY"], cell0, cell0, dx, dy, "probe-fallback"
    raise RuntimeError("could not derive oracle geometry: no content bbox and no fallback probe")

def score_at(oracle_img, offx, offy, cw, ch, W, H, client_canon):
    """Resample the oracle grid at the given geometry and return (mae, per-tile grid)."""
    crop = oracle_img.crop((int(round(offx)), int(round(offy)),
                            int(round(offx + W * cw)), int(round(offy + H * ch))))
    o = crop.resize((W * CANON, H * CANON), Image.LANCZOS)
    oa = np.asarray(o, dtype=np.int16)[..., :3]
    d = np.abs(oa - client_canon).mean(axis=2)              # HxW pixel error
    tiles = d.reshape(H, CANON, W, CANON).mean(axis=(1, 3)) # per-tile mean
    return float(tiles.mean()), tiles, o

def heatmap_rgb(tiles):
    """Per-tile error 0..255 -> black->red->yellow->white ramp."""
    t = np.clip(tiles / 96.0, 0, 1)  # 96+ MAE saturates the ramp
    r = np.clip(t * 3, 0, 1)
    g = np.clip(t * 3 - 1, 0, 1)
    b = np.clip(t * 3 - 2, 0, 1)
    return (np.stack([r, g, b], axis=2) * 255).astype(np.uint8)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1:8765")
    ap.add_argument("--player", default="qa-parity")
    ap.add_argument("--camera", default=None, help="X,Y,Z absolute (default: player's current)")
    ap.add_argument("--max-score", type=float, default=None)
    ap.add_argument("--no-pause", action="store_true")
    ap.add_argument("--label", default=None, help="suffix for the results dir")
    ap.add_argument("--renderer", default=None, choices=["canvas2d", "gl"],
                    help="append &renderer=<name> to the client URL (WB-1 seam selection)")
    ap.add_argument("--oracle", default="jpeg", choices=["jpeg", "raw", "both", "window"],
                    help="jpeg=today's /frame.jpg (manufactures see-down fog underground); "
                         "raw=WB-2 lossless /tiledump ground_truth.png (required for "
                         "underground/any-see-down scenes); both=score against raw AND "
                         "compute the jpeg-vs-raw discrimination assertion; window=OS-level "
                         "PrintWindow capture of the real on-screen DF window (win_capture.py) "
                         "-- the only oracle downstream of DF's screen-space fog present pass, "
                         "so it's the ONE mode where a client's fog-correctness (or lack of it) "
                         "actually shows up in the score; requires DF's window visible/not "
                         "minimized (see fetch_window_oracle's docstring for the grid-alignment "
                         "method + known chrome-contamination residual)")
    ap.add_argument("--df-root", default=DF_ROOT_DEFAULT,
                    help="DF install root /tiledump writes ground_truth.png under (raw oracle only)")
    ap.add_argument("--extra-params", default="",
                    help="raw extra query string (e.g. '&renderer=gl') appended verbatim to the "
                         "client URL -- lets an item's own A/B rollback flag be exercised for a "
                         "same-session before/after parity delta without redeploying different "
                         "code. (WA-7's ?cachedraw=0 was the original consumer; WA-15 removed "
                         "that flag along with the legacy wire it rolled back to, so this now "
                         "documents ?renderer= as the live example.) Empty by default: no "
                         "behavior change for any existing caller.")
    args = ap.parse_args()
    base = f"http://{args.host}"
    dfhack_run = os.path.join(args.df_root, "hack", "dfhack-run.exe")
    # Fresh session per run: a stale/killed session's metadata can point at a dead CDP
    # port (os error 10060 on every command). Timestamped names sidestep that entirely;
    # the session is closed in the finally below so chromes don't accumulate.
    session = "qa-" + datetime.datetime.utcnow().strftime("%H%M%S")

    # -- preflight ---------------------------------------------------------------
    try:
        assert b'"ok":true' in http(f"{base}/health", 5)
    except Exception as e:
        print(f"CANNOT RUN: dwf server not reachable: {e}"); sys.exit(2)

    # -- pin the camera ------------------------------------------------------------
    if args.camera:
        x, y, z = args.camera.split(",")
        http(f"{base}/camera?player={args.player}&x={x}&y={y}&z={z}", method="POST")
    cam = json.loads(http(f"{base}/camera?player={args.player}"))
    print(f"camera: {cam}")

    # --oracle window: the REAL on-screen DF window's camera is DF's own internal
    # df.global.window_x/y/z -- an INDEPENDENT value from any virtual per-player camera above.
    # Confirmed empirically 2026-07-07: /camera?player=host (39,82,160) and df.global.window_x/y/z
    # (66,83,161) disagreed by dozens of tiles at the same instant while the owner was actively playing
    # over the tunnel -- "host" is a remote virtual player rendered through the SAME capture_shifted
    # per-player hack every other player uses, NOT the physical host view. The native window
    # shows whatever df.global.window_x/y/z currently is, full stop. So for this oracle, --camera
    # (if given) is applied to the NATIVE camera (a direct game-state write -- the same category
    # of action as the pause_state toggle below, NOT input injection/focus-stealing -- and
    # therefore DOES need DF_LOCK, unlike the passive screenshot itself), restored in the
    # finally block; the virtual --player camera is then pinned to match so the CLIENT renders
    # the same view. Without --camera, the native camera is read (not written) and used as-is.
    native_cam_saved = None
    if args.oracle == "window":
        raw = dfhack_lua("print(df.global.window_x, df.global.window_y, df.global.window_z)",
                          dfhack_run)
        try:
            native_cam_saved = tuple(int(v) for v in raw.split())
        except ValueError:
            print(f"CANNOT RUN: could not read df.global.window_x/y/z ({raw!r})"); sys.exit(2)
        if args.camera:
            dfhack_lua(f"df.global.window_x={cam['x']};df.global.window_y={cam['y']};"
                       f"df.global.window_z={cam['z']}", dfhack_run)
            time.sleep(0.3)  # let at least one render frame pick up the new position
        else:
            wx, wy, wz = native_cam_saved
            cam = {"x": wx, "y": wy, "z": wz}
            http(f"{base}/camera?player={args.player}&x={wx}&y={wy}&z={wz}", method="POST")
        print(f"window-oracle camera (native df.global.window_x/y/z): {cam}  "
              f"(was {native_cam_saved}, restored after this run)")

    # -- pause DF so oracle and client see the same instant -----------------------
    was_paused = None
    if not args.no_pause:
        was_paused = dfhack_lua("print(df.global.pause_state)", dfhack_run)
        dfhack_lua("df.global.pause_state=true", dfhack_run)
        time.sleep(0.5)

    stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    outdir = os.path.join(HERE, "results", f"parity-{stamp}" + (f"-{args.label}" if args.label else ""))
    os.makedirs(outdir, exist_ok=True)
    jpeg_oracle = None  # only set in --oracle both (discrimination check)
    try:
        # -- client screenshot (real render client, headless) ----------------------
        # nolegend=1: suppress the canvas-drawn player/origin legend (it would otherwise
        # be diffed against DF's frame; the DOM #hud is also removed below).
        renderer_q = f"&renderer={args.renderer}" if args.renderer else ""
        ab(session, "open", f"{base}/tiles.html?player={args.player}&nolegend=1{renderer_q}{args.extra_params}")
        ab(session, "set", "viewport", "1280", "800")
        geom = None
        for _ in range(40):  # wait for first frame (WS or poll)
            out = ab(session, "eval",
                     "JSON.stringify(window.DwfTiles && DwfTiles.getRenderRect())")
            j = json.loads(json.loads(out)) if out.startswith('"') else json.loads(out)
            if j:
                geom = j; break
            time.sleep(0.5)
        if not geom:
            print("CANNOT RUN: client never rendered a frame"); sys.exit(2)
        time.sleep(4)  # let async sprite sheets finish loading (they redraw on load)
        # Remove (not just hide) the HUD overlay so it can't contaminate the top-left
        # tiles of the screenshot; verify it actually happened.
        gone = ab(session, "eval",
           "(function(){var h=document.getElementById('hud');if(h)h.remove();"
           "return document.getElementById('hud')===null?'GONE':'STILL';})()")
        if "GONE" not in gone:
            print(f"WARN: HUD overlay not removed ({gone!r}); top-left tiles may be noisy")
        ab(session, "eval",  # force a fresh draw after hiding hud + sheets loaded
           "window.DwfTiles && DwfTiles.draw()")
        shot = os.path.join(outdir, "client_raw.png")
        ab(session, "screenshot", shot)
        geom2 = json.loads(json.loads(ab(session, "eval",
                 "JSON.stringify(DwfTiles.getRenderRect())")))
        if (geom2["ox"], geom2["oy"], geom2["oz"]) != (cam["x"], cam["y"], cam["z"]):
            print(f"WARN: client origin {geom2['ox']},{geom2['oy']},{geom2['oz']} != camera "
                  f"{cam['x']},{cam['y']},{cam['z']} (server clamp?) -- diff uses client origin")
        geom = geom2

        # -- oracle frame + geometry ------------------------------------------------
        # NOTE (sweep #2 §2 fix): geometry is NO LONGER derived from /zoom-probe's LIVE
        # viewport state. capture_shifted's per-player-zoom-guard can render into a viewport
        # smaller than (and geometrically unrelated to) whatever /zoom-probe reports live --
        # a zoom/dims reference frozen the first time any capture ran this DF session, that
        # does not track later window resizes or live zoom changes (confirmed empirically:
        # a live window resize changed the capture BUFFER size but not the populated-content
        # boundary). /zoom-probe is still fetched (used only as a diagnostic print + the
        # derive_oracle_geometry() fallback), never as the primary geometry source; see
        # derive_oracle_geometry()/measure_content_bbox() for the actual method.
        probe = json.loads(http(f"{base}/zoom-probe"))
        oracle_discrimination = None
        meta = None
        geom_img = None  # set only by --oracle window (see fetch_window_oracle's docstring):
                          # the geometry SOURCE differs from the image actually SCORED there.
        if args.oracle == "jpeg":
            oracle = fetch_jpeg_oracle(base, args.player)
            meta = probe_tiledump_meta(base, args.df_root, cam, f"{session}-{stamp}")
        elif args.oracle == "raw":
            oracle, meta = fetch_raw_oracle(base, args.df_root, cam, f"{session}-{stamp}")
        elif args.oracle == "window":
            oracle, meta, geom_img = fetch_window_oracle(base, args.df_root, cam, f"{session}-{stamp}")
        else:  # both: raw is the SCORED oracle; jpeg is fetched too, same paused instant,
               # purely for the discrimination assertion (WB-2 acceptance).
            oracle, meta = fetch_raw_oracle(base, args.df_root, cam, f"{session}-{stamp}")
            jpeg_oracle = fetch_jpeg_oracle(base, args.player)
            # Crop both to the SAME derived geometry (measured off the raw oracle -- both
            # oracles share the identical capture_shifted render geometry for this camera,
            # confirmed empirically 2026-07-07: content bbox on /frame.jpg matched
            # /tiledump's to within a few px at the same camera/session) and diff --
            # oracle-vs-oracle, not oracle-vs-client, so no alignment search needed here.
            gx, gy, gcw, gch, gdx, gdy, _gsrc = derive_oracle_geometry(oracle, meta, probe)
            box_x1 = min(oracle.width, jpeg_oracle.width, gx + gdx * gcw)
            box_y1 = min(oracle.height, jpeg_oracle.height, gy + gdy * gch)
            box = (int(gx), int(gy), int(box_x1), int(box_y1))
            ra = np.asarray(oracle.crop(box), dtype=np.int16)
            rb = np.asarray(jpeg_oracle.crop(box), dtype=np.int16)
            oracle_discrimination = {
                "oracle_pixel_diff_mae": round(float(np.abs(ra - rb).mean()), 2),
                "region_px": list(box),
                "note": "raw vs jpeg oracle, SAME paused instant/camera AND geometry (sweep "
                        "#2 §2 fix) -- nonzero proves the jpeg oracle's "
                        "composite_seedown_into manufactures pixels the raw oracle does not "
                        "have (fog report §0/§2); near-zero on a surface/no-see-down scene is "
                        "the discrimination sanity check (WB-2's 2.98 baseline).",
            }
    finally:
        if native_cam_saved is not None:
            wx, wy, wz = native_cam_saved
            dfhack_lua(f"df.global.window_x={wx};df.global.window_y={wy};"
                       f"df.global.window_z={wz}", dfhack_run)
        if was_paused == "false":
            dfhack_lua("df.global.pause_state=false", dfhack_run)
        try:
            ab(session, "close")
        except Exception:
            pass

    # --oracle window: geometry comes from the same-instant raw tiledump (geom_img), NOT from
    # `oracle` (the window screenshot) -- see fetch_window_oracle()'s docstring for why
    # (DF's UI chrome defeats content-bbox detection on the window image itself).
    offx0, offy0, cell0, cell0y, dim_x, dim_y, geo_src = derive_oracle_geometry(
        geom_img if geom_img is not None else oracle, meta, probe)
    print(f"oracle geometry ({geo_src}): origin=({offx0},{offy0}) cell=({cell0:.2f},"
          f"{cell0y:.2f}) dim=({dim_x}x{dim_y})  [live /zoom-probe viewport dim="
          f"{probe['viewport']['dimX']}x{probe['viewport']['dimY']} zoom="
          f"{probe['gps']['viewportZoomFactor']} -- expected to differ, sweep #2 §2]")

    # -- overlap window (both grids start at the same world origin) ----------------
    gw, gh, cellc = geom["gw"], geom["gh"], geom["cell"]
    fullW = int((oracle.width - offx0) // cell0)
    fullH = int((oracle.height - offy0) // cell0y)
    W = min(gw, dim_x, fullW)
    H = min(gh, dim_y, fullH)
    if W < 8 or H < 8:
        print(f"CANNOT RUN: overlap too small ({W}x{H})"); sys.exit(2)

    # -- client canonical -----------------------------------------------------------
    client_img = Image.open(os.path.join(outdir, "client_raw.png")).convert("RGB")
    ccrop = client_img.crop((0, 0, int(round(W * cellc)), int(round(H * cellc))))
    client_canon_img = ccrop.resize((W * CANON, H * CANON), Image.LANCZOS)
    client_canon = np.asarray(client_canon_img, dtype=np.int16)[..., :3]

    # -- oracle alignment: measured geometry + small refinement search (sub-pixel/rounding) --
    best = (None, None, None)
    best_key = None
    for dx in (-6, -3, 0, 3, 6):
        for dy in (-6, -3, 0, 3, 6):
            mae, tiles, o = score_at(oracle, offx0 + dx, offy0 + dy, cell0, cell0y, W, H, client_canon)
            if best_key is None or mae < best_key:
                best_key, best = mae, (dx, dy, (mae, tiles, o))
    dx, dy, (mae, tiles, o_img) = best
    # fine step
    for fdx in (-1, 0, 1):
        for fdy in (-1, 0, 1):
            m2, t2, o2 = score_at(oracle, offx0 + dx + fdx, offy0 + dy + fdy, cell0, cell0y, W, H, client_canon)
            if m2 < mae:
                mae, tiles, o_img = m2, t2, o2
                dx, dy = dx + fdx, dy + fdy
    if (dx, dy) != (0, 0):
        print(f"NOTE: alignment search moved the oracle grid by ({dx},{dy})px off the measured values")

    # -- discrimination check (--oracle both): score the SAME client render against the jpeg
    # oracle too, at the alignment already resolved above -- a computed assertion (not an
    # eyeball) that the raw and jpeg oracles produce different scores/pixels for the SAME
    # paused instant (WB-2 acceptance).
    jpeg_mae = None
    if jpeg_oracle is not None:
        jpeg_mae, _, _ = score_at(jpeg_oracle, offx0 + dx, offy0 + dy, cell0, cell0y, W, H, client_canon)
        delta = mae - jpeg_mae
        print(f"DISCRIMINATION: score_mae(raw)={mae:.2f}  score_mae(jpeg)={jpeg_mae:.2f}  "
              f"delta={delta:+.2f}  oracle_pixel_diff_mae={oracle_discrimination['oracle_pixel_diff_mae']}")
        if oracle_discrimination["oracle_pixel_diff_mae"] <= 0.0:
            print("WARN: raw and jpeg oracle PNGs are pixel-IDENTICAL over the aligned window "
                  "-- discrimination assertion did not fire (no see-down fog visible at this "
                  "camera, or the raw fetch reused a stale image)")

    # -- outputs ---------------------------------------------------------------------
    p95 = float(np.percentile(tiles, 95))
    bad_pct = float((tiles > 30).mean() * 100)
    hm = Image.fromarray(heatmap_rgb(tiles)).resize((W * CANON, H * CANON), Image.NEAREST)
    o_img.save(os.path.join(outdir, "oracle.png"))
    client_canon_img.save(os.path.join(outdir, "client.png"))
    hm.save(os.path.join(outdir, "heatmap.png"))
    trip = Image.new("RGB", (W * CANON * 3 + 16, H * CANON), (20, 20, 24))
    trip.paste(o_img, (0, 0)); trip.paste(client_canon_img, (W * CANON + 8, 0))
    trip.paste(hm, (2 * (W * CANON + 8), 0))
    trip.save(os.path.join(outdir, "triptych.png"))

    result = {
        "utc": stamp, "renderer": args.renderer or "canvas2d", "oracle": args.oracle,
        "score_mae": round(mae, 2), "p95_tile_mae": round(p95, 2),
        "bad_tile_pct_gt30": round(bad_pct, 1),
        "tiles": f"{W}x{H}", "camera": cam,
        "oracle_grid": {"offx": offx0 + dx, "offy": offy0 + dy, "cell": [round(cell0, 2), round(cell0y, 2)],
                        "align_shift": [dx, dy], "geometry_source": geo_src, "dim": [dim_x, dim_y]},
        "client_grid": {"cell": cellc, "gw": gw, "gh": gh,
                        "origin": [geom["ox"], geom["oy"], geom["oz"]]},
        "outdir": outdir,
    }
    if jpeg_mae is not None:
        result["discrimination"] = {
            "jpeg_score_mae": round(jpeg_mae, 2),
            "raw_minus_jpeg_score_mae": round(mae - jpeg_mae, 2),
            **oracle_discrimination,
        }
    with open(os.path.join(outdir, "parity.json"), "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))

    if args.max_score is not None and mae > args.max_score:
        print(f"FAIL: score {mae:.2f} > max {args.max_score}")
        sys.exit(1)
    print(f"{'PASS' if args.max_score is not None else 'BASELINE'}: score {mae:.2f} "
          f"(p95 {p95:.1f}, {bad_pct:.1f}% tiles >30)  evidence: {outdir}")
    sys.exit(0)

if __name__ == "__main__":
    main()
