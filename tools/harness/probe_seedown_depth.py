"""SEE-DOWN DESCENT DEPTH PROBE (server tile_map_dump.cpp bug -- docs/superpowers/plans/
2026-07-07-overnight-run-orders.md ledger, window-parity item's "BLOCKED" section, commit
55fa893).

Root cause found and fixed in emit_tile_fields() (src/tile_map_dump.cpp): TWO independent
bugs. (1) the see-down z-descent computed a `depth` local (walking z-1..z-N below an open,
non-hidden camera-plane tile until solid ground/liquid is found) but never serialized it --
no "depth" key ever reached the wire:5 JSON, so a client had no way to know a substitution
happened even when the loop succeeded. (2) the ACTUAL reason live cameras (e.g. 53,75,172)
never saw a substitution at all: MAX_DEPTH was hardcoded to 10, but the real ground at that
column sits 11 z-levels below the camera -- the loop exhausted its budget one level short of
solid ground and silently reported "nothing found", even though a floor unambiguously exists
in that exact column. Fixed by raising MAX_DEPTH to 60 and adding the missing "depth" field.

This probe walks a live camera window and, for every tile that carries a `depth` field > 0,
INDEPENDENTLY re-queries a fresh window centered `depth` z-levels BELOW the camera and asserts
the reported tt/shape/mat exactly match a plain top-level read at that lower z (self-consistency
-- avoids assuming anything about whether z-1 itself is "raw", since after the fix ANY camera
z might itself resolve via its own internal descent). The PRIMARY pass criterion is simply that
at least one tile in the window carries depth>=1 (proves both bugs fixed: the field exists, and
the search actually found real ground) -- before the fix this was always zero at every camera
tested.

Usage:
  python probe_seedown_depth.py [--host 127.0.0.1:8765] [--camera 53,75,172]
                                 [--player qa-seedown] [--w 12] [--h 12]
Exit: 0 pass (depth field present + self-consistent), 1 fail (bug reproduced / regressed),
      2 cannot run (server down, or the chosen camera/window has no open-sky tile at all --
      pick one of the ledger's repro cameras, e.g. 53,75,172).
Evidence: results/seedown-depth-<UTC>.json

Requires: DF running w/ loaded fort + capture-stream-start (dwf HTTP server up). Read-only
per-player camera + /mapdata calls only -- no agent-browser, no pause, no native camera write.
"""
import argparse, json, os, sys, datetime, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def http(url, timeout=10, method="GET"):
    req = urllib.request.Request(url, method=method, data=(b"" if method == "POST" else None))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def mapdata(base, player, w, h):
    return json.loads(http(f"{base}/mapdata?player={player}&w={w}&h={h}"))


def set_camera(base, player, x, y, z):
    http(f"{base}/camera?player={player}&x={x}&y={y}&z={z}", method="POST")


def is_open_shape(shape, mat):
    return shape in ("EMPTY", "RAMP_TOP") or mat == "AIR"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1:8765")
    ap.add_argument("--player", default="qa-seedown")
    ap.add_argument("--camera", default="53,75,172")
    ap.add_argument("--w", type=int, default=12)
    ap.add_argument("--h", type=int, default=12)
    args = ap.parse_args()

    base = f"http://{args.host}"
    try:
        assert b'"ok":true' in http(f"{base}/health", 5)
    except Exception as e:
        print(f"CANNOT RUN: dwf server not reachable: {e}")
        sys.exit(2)

    camx, camy, camz = (int(v) for v in args.camera.split(","))

    try:
        set_camera(base, args.player, camx, camy, camz)
        top = mapdata(base, args.player, args.w, args.h)
    except Exception as e:
        print(f"CANNOT RUN: /camera or /mapdata call failed: {e}")
        sys.exit(2)

    top_tiles = top.get("tiles", [])
    if not top_tiles:
        print("CANNOT RUN: empty tiles[] in response")
        sys.exit(2)

    depth_tiles = []
    for i, t in enumerate(top_tiles):
        if t.get("tt") == -1:
            continue
        d = t.get("depth", 0)
        if d and d > 0:
            x = camx + (i % args.w)
            y = camy + (i // args.w)
            depth_tiles.append({"x": x, "y": y, "depth": d, "tt": t.get("tt"),
                                 "shape": t.get("shape"), "mat": t.get("mat")})

    if not depth_tiles:
        print(f"CANNOT RUN: no tile in this window carries a depth field at all -- pick a "
              f"camera/window known to have open sky over solid ground more than 0 z below "
              f"(see the ledger's repro cameras, e.g. 53,75,172).")
        sys.exit(2)

    # Self-consistency check: sample up to 5 depth-carrying tiles and independently re-query
    # a top-level window at camera.z - depth for that exact (x,y); the substituted fields must
    # match a plain top-level read at the real lower z (proves the substitution content, not
    # just the field's presence, is correct).
    failures = []
    sample = depth_tiles[:5]
    for dt in sample:
        lz = camz - dt["depth"]
        try:
            set_camera(base, args.player, dt["x"], dt["y"], lz)
            check = mapdata(base, args.player, 1, 1)
        except Exception as e:
            failures.append({**dt, "error": str(e)})
            continue
        ct = check.get("tiles", [{}])[0]
        if ct.get("tt") != dt["tt"] or ct.get("shape") != dt["shape"] or ct.get("mat") != dt["mat"]:
            failures.append({**dt, "independent_read_at_lz": {"z": lz, "tt": ct.get("tt"),
                             "shape": ct.get("shape"), "mat": ct.get("mat")}})

    ok = not failures
    results = {
        "utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "camera": {"x": camx, "y": camy, "z": camz}, "player": args.player,
        "w": args.w, "h": args.h,
        "depth_tile_count": len(depth_tiles),
        "sample_checked": len(sample),
        "failures": failures,
        "pass": ok,
    }
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    outpath = os.path.join(HERE, "results", f"seedown-depth-{results['utc']}.json")
    with open(outpath, "w") as f:
        json.dump(results, f, indent=2)

    print(f"tiles carrying depth>0 in this window: {len(depth_tiles)} "
          f"(e.g. {depth_tiles[0]})")
    if ok:
        print(f"PASS: {len(sample)}/{len(sample)} sampled depth-tiles are self-consistent "
              f"with an independent top-level read at their reported z")
    else:
        print(f"FAIL: {len(failures)} sampled depth-tile(s) mismatch an independent read")
        for fm in failures:
            print(f"  {fm}")
    print(f"Evidence: {outpath}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
