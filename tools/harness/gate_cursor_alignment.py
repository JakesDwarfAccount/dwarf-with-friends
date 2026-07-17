"""CURSOR/SELECTION ALIGNMENT GATE (HOTFIX, docs/superpowers/plans/2026-07-07-overnight-run-orders.md
ledger section for this item's dispatch).

Root cause (see interaction.cpp's pixel_to_tile_coord banner + http_server.cpp's
normalize_frame_to_viewport banner for the full writeup): every click-driven endpoint
(/inspect, /hover, /designate, /build-place, /stockpile[-repaint], /zone[-repaint],
/burrow-paint) is documented (http_server.cpp's /mapdata "FIX 1" comment) to resolve a client
grid index the same simple way the client itself renders it: `world = camera + grid_index`.
Before this fix, the server instead rescaled/clamped that grid index against
effective_capture_viewport_dims() -- DF's own native gps->main_viewport tile dimensions, a
small, zoom-driven quantity totally unrelated to the browser client's actual rendered window
size (data.width/height, sized to the canvas). Any grid index beyond that small native
viewport silently CLAMPED to its edge tile -- in practice, on any normally-sized/zoomed
browser window, clicks past roughly the top-left quarter of the screen resolved to the WRONG
tile. This is a pure HTTP-level regression check (no DF UI driving, no agent-browser): it
walks a WIDE window's full px/py range through /inspect and asserts the returned world tile
tracks `camera + grid_index` exactly, with no early clamp point.

Usage:
  python gate_cursor_alignment.py
  python gate_cursor_alignment.py --host 127.0.0.1:8765 --camera 70,76,161
Exit: 0 pass, 1 fail, 2 could not run (server down).
Evidence: results/cursor-alignment-<UTC>.json

Requires: DF running w/ loaded fort + capture-stream-start (dwf HTTP server up). Does
NOT require agent-browser or any live gameplay session -- read-only /inspect probes only.
"""
import argparse, json, os, sys, datetime, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))


def http(url, timeout=10, method="GET"):
    req = urllib.request.Request(url, method=method, data=(b"" if method == "POST" else None))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def inspect(base, player, px, py, w, h):
    url = f"{base}/inspect?player={player}&px={px}&py={py}&w={w}&h={h}"
    raw = http(url)
    return json.loads(raw)


def sample_axis(n):
    """A handful of indices spanning the full range, including both ends -- enough to catch
    a clamp point wherever it falls, without walking every single index."""
    pts = sorted(set([0, 1, n // 4, n // 2, (3 * n) // 4, n - 2, n - 1]))
    return [p for p in pts if 0 <= p < n]


def check_window(base, player, camx, camy, w, h, results, label):
    """Probe every sampled px (py fixed at 0) and every sampled py (px fixed at 0); assert the
    returned world tile is EXACTLY camera + grid_index for the full window width/height, i.e.
    no clamp point short of the window's own edge (w-1 / h-1)."""
    ok = True
    mismatches = []
    for px in sample_axis(w):
        d = inspect(base, player, px, 0, w, h)
        got = d.get("tile", {})
        want_x = camx + px
        if got.get("x") != want_x or got.get("y") != camy:
            ok = False
            mismatches.append({"axis": "x", "px": px, "py": 0, "w": w, "h": h,
                                "want": {"x": want_x, "y": camy}, "got": got})
    for py in sample_axis(h):
        d = inspect(base, player, 0, py, w, h)
        got = d.get("tile", {})
        want_y = camy + py
        if got.get("x") != camx or got.get("y") != want_y:
            ok = False
            mismatches.append({"axis": "y", "px": 0, "py": py, "w": w, "h": h,
                                "want": {"x": camx, "y": want_y}, "got": got})
    results[label] = {"w": w, "h": h, "pass": ok, "mismatches": mismatches}
    print(f"{label} (w={w},h={h}): " + ("PASS" if ok else f"FAIL ({len(mismatches)} mismatches)"))
    if mismatches:
        for m in mismatches[:5]:
            print(f"    axis={m['axis']} px={m['px']} py={m['py']} want={m['want']} got={m['got']}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1:8765")
    ap.add_argument("--player", default="qa-cursor-align")
    ap.add_argument("--camera", default="70,76,161")
    args = ap.parse_args()

    base = f"http://{args.host}"
    try:
        assert b'"ok":true' in http(f"{base}/health", 5)
    except Exception as e:
        print(f"CANNOT RUN: dwf server not reachable: {e}")
        sys.exit(2)

    camx, camy, camz = (int(v) for v in args.camera.split(","))
    try:
        http(f"{base}/camera?player={args.player}&x={camx}&y={camy}&z={camz}", method="POST")
    except urllib.error.HTTPError as e:
        # Some builds don't expose a direct /camera setter for arbitrary players; fall back to
        # whatever camera the player already has and read it back from the first /inspect call.
        print(f"WARN: could not set camera explicitly ({e}); using the player's current camera")

    d0 = inspect(base, args.player, 0, 0, 80, 50)
    cam0 = d0.get("camera", {})
    camx, camy = cam0.get("x", camx), cam0.get("y", camy)

    results = {"utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
               "camera": {"x": camx, "y": camy, "z": camz}, "player": args.player}
    ok = True
    # WIDE window (80x50): deliberately much larger than any plausible DF native viewport
    # (gps->main_viewport is typically well under that) -- this is the window shape that
    # triggered the clamp bug pre-fix; every sampled px/py must resolve to camera+index with
    # no early clamp.
    ok = check_window(base, args.player, camx, camy, 80, 50, results, "wide_window") and ok
    # Different aspect / smaller window: same contract must hold regardless of window shape.
    ok = check_window(base, args.player, camx, camy, 33, 19, results, "odd_aspect_window") and ok
    # A SMALL window (bug never manifested here pre-fix, since small px never exceeded the
    # native viewport's clamp bound) -- must still pass, i.e. the fix doesn't regress it.
    ok = check_window(base, args.player, camx, camy, 12, 9, results, "small_window") and ok

    results["pass"] = ok
    stamp = results["utc"]
    outdir = os.path.join(HERE, "results")
    os.makedirs(outdir, exist_ok=True)
    outpath = os.path.join(outdir, f"cursor-alignment-{stamp}.json")
    with open(outpath, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n{'PASS' if ok else 'FAIL'}  (evidence: {os.path.relpath(outpath, HERE)})")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
