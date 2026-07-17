#!/usr/bin/env python3
"""menu_oracle_stress.py -- transition-overlap stress acceptance for GET /menu-oracle.

WHY THIS EXISTS (2026-07-08, fix-batch item #0): the route's ORIGINAL acceptance ("200 rapid
reads during live navigation, zero failures") was proven insufficient -- it never overlapped
sheet teardown hard enough. The old render-thread snapshot then crashed DF twice (#4/#5) during
ordinary 2-3.5 Hz polling: 4 of 9 banked captures landed mid-transition and ~2 of ~15
transition-overlapping reads killed DF. This harness is the replacement acceptance: it hammers
the route at 20-50 Hz for minutes WHILE add-task sheets are rapidly opened/navigated/closed
(script cannot drive native DF -- a human, the owner, clicks at full speed during the run).

PASS requires ALL of:
  * the DF/plugin server stays alive for the whole run (sustained connection failure = the
    old crash signature = FAIL);
  * every 200 body parses as JSON, schema truemenu-oracle-v1, with the post-fix additive
    "in_transition" field PRESENT (the pre-fix code lacks it -- this check alone discriminates
    old from new, see --selftest-old);
  * ZERO untagged inconsistent states: view_sheets.active_id == -1 with button rows MUST carry
    in_transition:true (fix requirement #2);
  * zero HTTP 500 (500 = the SEH backstop caught a fault inside the quiesced window -- DF
    survived, but quiescence leaked: still a FAIL);
  * 503 rate (missed quiesce window, no snapshot attempted -- benign, caller retries) at or
    under --max-503-rate;
  * ENOUGH TRANSITION OVERLAP actually happened: at least --min-transitions distinct open-menu
    states AND at least --min-transitions open<->closed flips observed, else the run cannot
    claim transition coverage and exits CANNOT-RUN (2), never PASS.

TEST-THE-TEST (completeness protocol rule 3): `--selftest-old <session-dir>` runs the same
consistency checker over per-state JSONs banked from the PRE-FIX code (e.g.
tools/harness/results/menuwalk/live). The old code emitted active_id==-1-with-buttons states
with NO in_transition field; the checker MUST flag them (expected: 4 of the 9 banked states).
If it flags none, the checker itself is broken and this harness exits 1.

Usage:
    python tools/harness/menu_oracle_stress.py [--host 127.0.0.1:8765] [--hz 30] [--secs 300]
        [--workers 4] [--max-503-rate 0.10] [--min-transitions 5] [--call-text 1]
    python tools/harness/menu_oracle_stress.py --selftest-old tools/harness/results/menuwalk/live

Exit codes: 0 PASS, 1 FAIL, 2 CANNOT-RUN (server unreachable at start / insufficient overlap).
Evidence: tools/harness/results/menu_oracle_stress-<utc>.json
"""
import argparse
import glob
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


# ------------------------------------------------------------------------------------------
# Shared consistency checker (used by the live stress run AND --selftest-old).
# ------------------------------------------------------------------------------------------
def check_state(oracle, require_in_transition_field=True):
    """Return a list of consistency errors for one truemenu-oracle-v1 snapshot object."""
    errors = []
    if oracle.get("schema") != "truemenu-oracle-v1":
        errors.append("schema != truemenu-oracle-v1 (got %r)" % (oracle.get("schema"),))
        return errors
    if "error" in oracle:
        # error bodies (503/500) are judged by HTTP status, not by this checker
        return errors
    b = oracle.get("building") or {}
    vs = oracle.get("view_sheets")  # absent in the no-game closed snapshot -- skip vs checks
    buttons = b.get("button") or []
    if require_in_transition_field and "in_transition" not in oracle:
        errors.append("post-fix additive field 'in_transition' MISSING (pre-fix body?)")
    if isinstance(vs, dict) and vs.get("active_id") == -1 and buttons:
        if oracle.get("in_transition") is not True:
            errors.append(
                "UNTAGGED inconsistent state: active_id==-1 with %d button rows and "
                "in_transition!=true" % len(buttons))
    if oracle.get("open") and not buttons:
        errors.append("open:true with empty building.button")
    return errors


def buttons_hash(oracle):
    b = oracle.get("building") or {}
    rows = [(r.get("class", ""), r.get("filter_str", ""), r.get("text", ""))
            for r in (b.get("button") or [])]
    blob = json.dumps(rows, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:10]


# ------------------------------------------------------------------------------------------
# --selftest-old: prove the checker catches the PRE-FIX code's banked states.
# ------------------------------------------------------------------------------------------
def selftest_old(session_dir):
    files = sorted(glob.glob(os.path.join(session_dir, "[0-9][0-9][0-9]-*.json")))
    if not files:
        print("CANNOT RUN: no per-state JSONs (NNN-*.json) in %s" % session_dir)
        return 2
    flagged, clean, unreadable = [], [], []
    for path in files:
        try:
            with open(path, "r", encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError) as e:
            unreadable.append((path, str(e)))
            continue
        oracle = rec.get("oracle") or rec
        errs = check_state(oracle, require_in_transition_field=True)
        name = os.path.basename(path)
        if errs:
            flagged.append(name)
            for e in errs:
                print("FLAGGED %-48s %s" % (name, e))
        else:
            clean.append(name)
    print("\nselftest-old: %d states, %d flagged, %d clean, %d unreadable"
          % (len(files), len(flagged), len(clean), len(unreadable)))
    # Pre-fix states MUST be flagged (they all lack in_transition; the mid-transition ones
    # additionally hit the untagged-inconsistent check). Zero flags = broken checker.
    if not flagged:
        print("SELFTEST FAIL: checker flagged NOTHING on pre-fix states -- it cannot "
              "discriminate old code from new; do not trust a PASS from this harness.")
        return 1
    print("SELFTEST PASS: checker discriminates pre-fix snapshots (would have failed the "
          "old code).")
    return 0


# ------------------------------------------------------------------------------------------
# Live stress run.
# ------------------------------------------------------------------------------------------
class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.results = []          # (t, status, latency_ms, errors_list, quiesce_dict, open, ttag)
        self.conn_fail_streak = 0
        self.server_died_at = None


def parse_quiesce(header_val):
    out = {}
    if not header_val:
        return out
    for part in header_val.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                out[k.strip()] = int(v)
            except ValueError:
                pass
    return out


def worker_loop(url, period, deadline, stats):
    while time.time() < deadline:
        t0 = time.time()
        status = None
        errors = []
        quiesce = {}
        is_open = None
        in_trans = None
        bhash = None
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=5) as r:
                status = r.status
                quiesce = parse_quiesce(r.headers.get("X-Menu-Oracle-Quiesce"))
                raw = r.read().decode("utf-8", "replace")
            with stats.lock:
                stats.conn_fail_streak = 0
        except urllib.error.HTTPError as e:
            status = e.code
            quiesce = parse_quiesce(e.headers.get("X-Menu-Oracle-Quiesce"))
            try:
                raw = e.read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                raw = ""
            with stats.lock:
                stats.conn_fail_streak = 0
        except Exception:  # noqa: BLE001 -- connection refused/reset/timeout
            latency = (time.time() - t0) * 1000.0
            with stats.lock:
                stats.conn_fail_streak += 1
                stats.results.append((t0, "CONN", latency, ["connection failure"], {}, None, None, None))
                if stats.conn_fail_streak >= 10 and stats.server_died_at is None:
                    stats.server_died_at = time.time()
            time.sleep(min(period, 0.5))
            continue

        latency = (time.time() - t0) * 1000.0
        if status == 200:
            try:
                oracle = json.loads(raw)
                errors = check_state(oracle)
                is_open = bool(oracle.get("open"))
                in_trans = oracle.get("in_transition")
                if is_open:
                    bhash = buttons_hash(oracle)
            except ValueError:
                errors = ["200 body is not valid JSON"]
        with stats.lock:
            stats.results.append((t0, status, latency, errors, quiesce, is_open, in_trans, bhash))
        elapsed = time.time() - t0
        if elapsed < period:
            time.sleep(period - elapsed)


def pct(sorted_vals, p):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, int(round(p / 100.0 * (len(sorted_vals) - 1))))
    return sorted_vals[i]


def live_stress(args):
    url = "http://%s/menu-oracle" % args.host
    if not args.call_text:
        url += "?call_text=0"
    # reachability preflight (single read is permitted: this harness only runs POST-deploy,
    # per the polling ban on the pre-fix DLL)
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            r.read()
    except Exception as e:  # noqa: BLE001
        print("CANNOT RUN: %s unreachable (%s) -- is DF + the fix DLL live?" % (url, e))
        return 2

    stats = Stats()
    n_workers = max(1, args.workers)
    period = n_workers / max(args.hz, 1.0)
    deadline = time.time() + args.secs
    print("[stress] %s @ %.1f Hz aggregate (%d workers), %ds -- NAVIGATE ADD-TASK SHEETS "
          "AT FULL SPEED NOW (open/click categories/leaves/close, many shops)"
          % (url, args.hz, n_workers, args.secs), flush=True)
    threads = [threading.Thread(target=worker_loop, args=(url, period, deadline, stats),
                                daemon=True) for _ in range(n_workers)]
    for t in threads:
        t.start()
    last_echo = 0
    while time.time() < deadline:
        time.sleep(1.0)
        with stats.lock:
            n = len(stats.results)
            died = stats.server_died_at
        if died:
            print("[stress] SERVER DIED (10+ consecutive connection failures) -- aborting wait",
                  flush=True)
            break
        if time.time() - last_echo >= 15:
            last_echo = time.time()
            print("[stress] %d reads so far..." % n, flush=True)
    for t in threads:
        t.join(timeout=10)

    # ---- analysis ----------------------------------------------------------------------
    res = stats.results
    total = len(res)
    by_status = {}
    consistency_errors = []
    latencies = sorted(r[2] for r in res)
    q_hold = sorted(r[4]["hold_ms"] for r in res if r[4].get("hold_ms", -1) >= 0)
    q_park = sorted(r[4]["park_ms"] for r in res if r[4].get("park_ms", -1) >= 0)
    q_susp = sorted(r[4]["suspend_ms"] for r in res if r[4].get("suspend_ms", -1) >= 0)
    open_flips = 0
    prev_open = None
    distinct_states = set()
    n_in_transition = 0
    for r in res:
        by_status[r[1]] = by_status.get(r[1], 0) + 1
        for e in r[3]:
            consistency_errors.append((r[0], r[1], e))
        if r[5] is not None:
            if prev_open is not None and r[5] != prev_open:
                open_flips += 1
            prev_open = r[5]
        if r[6] is True:
            n_in_transition += 1
        if r[7]:
            distinct_states.add(r[7])

    n503 = by_status.get(503, 0)
    n500 = by_status.get(500, 0)
    nconn = by_status.get("CONN", 0)
    rate503 = (n503 / total) if total else 1.0

    verdict_fail = []
    if stats.server_died_at:
        verdict_fail.append("SERVER DIED mid-run (the old code's crash signature)")
    if n500:
        verdict_fail.append("%d HTTP 500 (SEH fault inside quiesced window)" % n500)
    if consistency_errors:
        verdict_fail.append("%d consistency errors (untagged transition / bad schema / "
                            "bad JSON)" % len(consistency_errors))
    if rate503 > args.max_503_rate:
        verdict_fail.append("503 rate %.1f%% > %.1f%% budget"
                            % (rate503 * 100, args.max_503_rate * 100))
    cannot_run = None
    if len(distinct_states) < args.min_transitions or open_flips < args.min_transitions:
        cannot_run = ("insufficient transition overlap: %d distinct open states, %d "
                      "open<->closed flips (need >= %d each) -- navigate faster / longer"
                      % (len(distinct_states), open_flips, args.min_transitions))

    summary = {
        "url": url, "hz": args.hz, "secs": args.secs, "workers": n_workers,
        "total_reads": total, "by_status": {str(k): v for k, v in by_status.items()},
        "conn_failures": nconn, "server_died": bool(stats.server_died_at),
        "rate_503": rate503,
        "latency_ms": {"p50": pct(latencies, 50), "p95": pct(latencies, 95),
                       "p99": pct(latencies, 99), "max": latencies[-1] if latencies else None},
        "quiesce_hold_ms": {"p50": pct(q_hold, 50), "p95": pct(q_hold, 95),
                            "max": q_hold[-1] if q_hold else None},
        "quiesce_park_ms": {"p50": pct(q_park, 50), "p95": pct(q_park, 95),
                            "max": q_park[-1] if q_park else None},
        "quiesce_suspend_ms": {"p50": pct(q_susp, 50), "p95": pct(q_susp, 95),
                               "max": q_susp[-1] if q_susp else None},
        "distinct_open_states": len(distinct_states),
        "open_closed_flips": open_flips,
        "in_transition_tagged_reads": n_in_transition,
        "consistency_errors": [
            {"t": t, "status": s, "error": e} for (t, s, e) in consistency_errors[:200]],
        "fail_reasons": verdict_fail,
        "cannot_run": cannot_run,
    }
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
    os.makedirs(out_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = os.path.join(out_dir, "menu_oracle_stress-%s.json" % stamp)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)

    print(json.dumps(summary, indent=1))
    print("\nevidence: %s" % out_path)
    if verdict_fail:
        print("VERDICT: FAIL -- " + "; ".join(verdict_fail))
        return 1
    if cannot_run:
        print("VERDICT: CANNOT RUN (no PASS credit) -- " + cannot_run)
        return 2
    print("VERDICT: PASS -- %d reads, 0 consistency errors, 0 faults, server alive, "
          "%d distinct states / %d flips overlapped, sim-pause hold p95=%sms"
          % (total, len(distinct_states), open_flips, summary["quiesce_hold_ms"]["p95"]))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1:8765")
    ap.add_argument("--hz", type=float, default=30.0, help="aggregate poll rate (20-50)")
    ap.add_argument("--secs", type=int, default=300)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--max-503-rate", type=float, default=0.10)
    ap.add_argument("--min-transitions", type=int, default=5)
    ap.add_argument("--call-text", type=int, default=1)
    ap.add_argument("--selftest-old", metavar="SESSION_DIR",
                    help="run the checker over pre-fix banked states; MUST flag them")
    args = ap.parse_args()
    if args.selftest_old:
        sys.exit(selftest_old(args.selftest_old))
    sys.exit(live_stress(args))


if __name__ == "__main__":
    main()
