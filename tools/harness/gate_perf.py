"""PERF GATE for dwf (stdlib-only; any python3).

WA-15: protocol v1 is the ONLY wire (the legacy per-player JSON push was removed), so
every phase below connects as a v1 client (`proto1` token to ws_probe.py -- sends `hello`,
ACKs every binary frame, decodes the 10-byte header). There is no more legacy-vs-v1 phase
split; "gate_perf becomes v1-only" per the WA-foundation-spec's removal item.

Wraps ws_probe.py into an objective PASS/FAIL gate per the §9 definition of done:
  >= 30fps constant (29.5 tolerance for measurement jitter), zero inter-frame
  gaps > 500ms, zero 2s stalls -- IDLE and WHILE PANNING, on localhost AND over
  the cloudflare tunnel.

Panning is exercised programmatically: the wire's only camera input is the HTTP
camera endpoint (POST /camera?player=P&dx=&dy= -- see src/http_server.cpp; the WS
inbound path only understands "cursor"/"reqkey", see src/websocket.cpp
handle_client_text), so a background thread POSTs small dx/dy moves every 250ms
against the same path under test (localhost or tunnel), which is exactly what the
browser client does when a user pans.

Usage:
  python gate_perf.py                     # all 4 phases, 20s each
  python gate_perf.py --secs 30           # longer phases
  python gate_perf.py --skip-tunnel       # localhost only
  python gate_perf.py --tunnel HOST       # explicit tunnel host (else auto-discover
                                          # from cloudflared metrics at 127.0.0.1:20241)
Exit code 0 = PASS, 1 = FAIL, 2 = could not run (DF/server down).
Evidence: prints per-phase results and writes JSON + raw probe logs to
tools/harness/results/perf-<UTC>.{json,log}.

Requires: DF running with a loaded fort and capture-stream-start done (use
auto_load.sh, or the headless/manual load per README), cloudflared for the
tunnel phases. Unpauses DF via dfhack-run (headless RPC; no mouse) because an
idle PAUSED game legitimately goes quiet -- the idle-fps criterion is defined
over a running sim.
"""
import argparse, json, os, re, subprocess, sys, threading, time, datetime
import urllib.request, ssl

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "ws_probe.py")
DFHACK_RUN = dfroot.dfhack_run(dfroot.df_root_for(__file__,
    purpose="measures a LIVE DF's frame rate through dfhack-run"))
LOCAL = "127.0.0.1:8765"
FPS_MIN = 29.5

def http_get(url, timeout=10):
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(url, timeout=timeout, context=ctx) as r:
        return r.read().decode("utf-8", "replace")

def http_post(url, timeout=10):
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, method="POST", data=b"")
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.read().decode("utf-8", "replace")

def discover_tunnel():
    """Quick-tunnel hostname from cloudflared's metrics endpoint (pinned to :20241
    by the harness convention -- see README). Returns None if unavailable/dead."""
    try:
        q = json.loads(http_get("http://127.0.0.1:20241/quicktunnel", 5))
        ready = json.loads(http_get("http://127.0.0.1:20241/ready", 5))
        if ready.get("readyConnections", 0) < 1:
            return None
        return q.get("hostname") or None
    except Exception:
        return None

def unpause_df():
    try:
        out = subprocess.run([DFHACK_RUN, "lua",
                              "df.global.pause_state=false; print(df.global.pause_state)"],
                             capture_output=True, text=True, timeout=20)
        return "false" in (out.stdout or "")
    except Exception:
        return False

class Panner(threading.Thread):
    """POST small camera moves every `interval` against `base` (http(s)://host).
    Pattern +2,+2,-2,-2 on x then y so the camera oscillates in place (never
    drifts off-map; the server clamps anyway)."""
    def __init__(self, base, player, interval=0.25):
        super().__init__(daemon=True)
        self.base, self.player, self.interval = base, player, interval
        self.stop_ev = threading.Event()
        self.moves = 0
        self.errors = 0
    def run(self):
        seq = [("dx", 2), ("dx", 2), ("dx", -2), ("dx", -2),
               ("dy", 2), ("dy", 2), ("dy", -2), ("dy", -2)]
        i = 0
        while not self.stop_ev.wait(self.interval):
            k, v = seq[i % len(seq)]; i += 1
            try:
                http_post(f"{self.base}/camera?player={self.player}&{k}={v}", 8)
                self.moves += 1
            except Exception:
                self.errors += 1
    def stop(self):
        self.stop_ev.set()

DONE_RE = re.compile(r"DONE\s+([\d.]+)s:\s+(\d+) frames total = ([\d.]+) fps")

def run_probe(player, secs, wss_host=None, extra_tokens=None):
    cmd = [sys.executable, PROBE, player, str(secs)]
    if wss_host:
        cmd.append("wss:" + wss_host)
    for tok in (extra_tokens or []):
        cmd.append(tok)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=secs + 60)
    out = (p.stdout or "") + (p.stderr or "")
    m = DONE_RE.search(out)
    fps = float(m.group(3)) if m else 0.0
    gaps = len(re.findall(r"\bGAP\b", out))
    stalls = len(re.findall(r"\bSTALL\b", out))
    return {"fps": fps, "gaps": gaps, "stalls": stalls,
            "handshake_ok": "101" in out.split("\n", 2)[0] if out else False,
            "raw": out}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=int, default=20)
    ap.add_argument("--tunnel", default=None, help="tunnel hostname (no scheme)")
    ap.add_argument("--skip-tunnel", action="store_true")
    ap.add_argument("--player", default="qa-perf")
    ap.add_argument("--no-unpause", action="store_true",
                    help="do NOT unpause DF. REQUIRED on pause-only worlds (the sprite "
                         "range: unpausing wakes 748 spawned creature AIs and crashes DF "
                         "in seconds -- 3x AVs at DF.exe+0x5659a4 on 2026-07-09 were this "
                         "gate's unpause_df, not the server). Expect lower idle fps while "
                         "paused; aux/blockset traffic still flows and pan still redraws.")
    args = ap.parse_args()

    # Preflight: server up?
    try:
        health = http_get(f"http://{LOCAL}/health", 5)
        assert '"ok":true' in health
    except Exception as e:
        print(f"CANNOT RUN: dwf server not reachable on {LOCAL}: {e}")
        sys.exit(2)

    if args.no_unpause:
        print("NOTE: --no-unpause (pause-only world); idle-fps floor not meaningful while paused")
    elif not unpause_df():
        print("WARN: could not unpause DF via dfhack-run (idle fps needs a running sim)")

    tunnel = None
    if not args.skip_tunnel:
        tunnel = args.tunnel or discover_tunnel()
        if not tunnel:
            print("WARN: no live tunnel found (cloudflared metrics :20241); tunnel phases SKIPPED")

    # WA-15: v1-only -- every phase is a proto1 probe (there is no other wire left). The
    # separate "-v1"-suffixed tunnel phases from the WA-14 dual-wire era are gone; the base
    # 4 phases (local/tunnel x idle/pan) now ARE the v1 phases.
    phases = [("local-idle", None, False, ["proto1"]), ("local-pan", None, True, ["proto1"])]
    if tunnel:
        phases += [("tunnel-idle", tunnel, False, ["proto1"]), ("tunnel-pan", tunnel, True, ["proto1"])]

    results = {}
    raw_log = []
    ok = True
    for name, wss, pan, extra_tokens in phases:
        base = f"https://{wss}" if wss else f"http://{LOCAL}"
        panner = None
        if pan:
            panner = Panner(base, args.player)
            panner.start()
        r = run_probe(args.player, args.secs, wss, extra_tokens)
        if panner:
            panner.stop(); panner.join(2)
            r["pan_moves"] = panner.moves
            r["pan_errors"] = panner.errors
        raw_log.append(f"===== {name} =====\n{r.pop('raw')}")
        passed = r["fps"] >= FPS_MIN and r["gaps"] == 0 and r["stalls"] == 0
        if pan and r.get("pan_moves", 0) == 0:
            passed = False  # the pan phase must actually have panned
        r["pass"] = passed
        ok = ok and passed
        results[name] = r
        print(f"{name:12s} fps={r['fps']:5.1f} gaps={r['gaps']} stalls={r['stalls']}"
              + (f" panMoves={r['pan_moves']}" if pan else "")
              + ("  PASS" if passed else "  FAIL"))

    if not tunnel and not args.skip_tunnel:
        ok = False
        results["tunnel"] = {"pass": False, "error": "no live tunnel"}

    stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    outdir = os.path.join(HERE, "results")
    os.makedirs(outdir, exist_ok=True)
    summary = {"utc": stamp, "fps_min": FPS_MIN, "secs": args.secs,
               "tunnel": tunnel, "phases": results, "pass": ok}
    with open(os.path.join(outdir, f"perf-{stamp}.json"), "w") as f:
        json.dump(summary, f, indent=2)
    with open(os.path.join(outdir, f"perf-{stamp}.log"), "w") as f:
        f.write("\n".join(raw_log))
    print(f"\n{'PASS' if ok else 'FAIL'}  (evidence: results/perf-{stamp}.json + .log)")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
