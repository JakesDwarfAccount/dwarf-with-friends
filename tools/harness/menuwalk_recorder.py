#!/usr/bin/env python3
"""menuwalk_recorder.py -- live auto-capture of native DF add-task menus via /menu-oracle.

Polls GET http://127.0.0.1:8765/menu-oracle at ~3.5 Hz. Every DISTINCT open menu state
(deduped by a content hash over building id + category + material context + the full button
list) is appended to a session JSONL and written as an individual per-state JSON file, tagged
with capture time and the resolved building type.

The /menu-oracle route (src/menu_oracle.cpp, schema truemenu-oracle-v1) snapshots on the render
thread and is SAFE under rapid polling while the owner navigates natively (acceptance: 200 rapid reads,
zero failures). This recorder NEVER touches RPC lua / widget state.

The oracle JSON identifies the open building only by view_sheets.active_id (a building id), not
its type. A sidecar map file (buildmap.json in the session dir, produced by a one-shot lua dump)
is re-read live each loop so shop-type labels appear as soon as it lands / refreshes.

Usage:
    python tools/harness/menuwalk_recorder.py [--host 127.0.0.1:8765] [--hz 3.5] [--session <dir>]

Runs until killed. Designed to run detached/in-background across agent turns.
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone


def http_get(url, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def state_signature(oracle):
    """Content hash + human context for one open menu state.

    Keyed on building id (active_id), the current category / custom-category token, the
    material/matgloss selection context, and the full ordered button list (class + label +
    filter_str + jobtype + material context per row). Any change in ANY of those -> new state.
    """
    b = oracle.get("building", {}) or {}
    vs = oracle.get("view_sheets", {}) or {}
    rows = b.get("button") or []
    row_sig = [
        [
            r.get("class", ""),
            r.get("text", ""),
            r.get("filter_str", ""),
            r.get("jobtype", ""),
            r.get("category", ""),
            r.get("custom_category_token", ""),
            r.get("material", ""),
            r.get("matgloss", ""),
            bool(r.get("leave_button")),
        ]
        for r in rows
    ]
    ctx = {
        "active_id": vs.get("active_id"),
        "category": b.get("category"),
        "token": b.get("current_custom_category_token", ""),
        "material": b.get("material"),
        "matgloss": b.get("matgloss"),
        "job": b.get("job"),
        "rows": row_sig,
    }
    blob = json.dumps(ctx, sort_keys=True, ensure_ascii=False)
    h = hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]
    return h, ctx


def derive_path(b):
    """A short human submenu-path descriptor from the building context."""
    cat = b.get("category") or "NONE"
    tok = b.get("current_custom_category_token") or ""
    mat = b.get("matgloss")
    rows = b.get("button") or []
    classes = {r.get("class", "") for r in rows}
    if any("category_selector" in c for c in classes):
        shape = "root/categories"
    elif any("material_selector" in c for c in classes):
        shape = "material-selector"
    elif any("new_job" in c for c in classes):
        shape = "leaf/jobs"
    else:
        shape = "?"
    seg = cat
    if tok:
        seg += f":{tok}"
    if mat is not None and mat >= 0:
        seg += f"/mat{mat}"
    return f"{seg} [{shape}]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1:8765")
    ap.add_argument("--hz", type=float, default=2.0)
    ap.add_argument("--session", default=None, help="explicit session dir (default: timestamped)")
    args = ap.parse_args()

    url = f"http://{args.host}/menu-oracle"
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "menuwalk")
    if args.session:
        session_dir = args.session
    else:
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        session_dir = os.path.join(base, ts)
    os.makedirs(session_dir, exist_ok=True)
    jsonl_path = os.path.join(session_dir, "session.jsonl")
    buildmap_path = os.path.join(session_dir, "buildmap.json")

    print(f"[menuwalk] recording to {session_dir}", flush=True)
    print(f"[menuwalk] polling {url} at {args.hz} Hz -- open a workshop add-task sheet in DF", flush=True)

    # resume-safe: preload dedupe hashes + next index from an existing session.jsonl so a
    # recorder restart in the same session dir never double-records or re-numbers states
    seen = set()
    index = 0
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                seen.add(rec.get("hash"))
                index = max(index, rec.get("index", -1) + 1)
        if seen:
            print(f"[menuwalk] resumed: {len(seen)} prior states, next index {index}", flush=True)
    except OSError:
        pass
    period = 1.0 / max(args.hz, 0.5)
    buildmap = {}
    buildmap_mtime = 0
    err_streak = 0

    while True:
        loop_start = time.time()
        # refresh buildmap if the sidecar changed
        try:
            m = os.path.getmtime(buildmap_path)
            if m != buildmap_mtime:
                with open(buildmap_path, "r", encoding="utf-8") as f:
                    buildmap = json.load(f)
                buildmap_mtime = m
                print(f"[menuwalk] buildmap loaded ({len(buildmap)} buildings)", flush=True)
        except (OSError, ValueError):
            pass

        try:
            raw = http_get(url)
            err_streak = 0
        except Exception as e:  # noqa: BLE001 -- server may be down / restarting
            err_streak += 1
            if err_streak in (1, 20, 100):
                print(f"[menuwalk] fetch error ({err_streak}): {e}", flush=True)
            time.sleep(period)
            continue

        try:
            oracle = json.loads(raw)
        except ValueError:
            time.sleep(period)
            continue

        if not oracle.get("open"):
            time.sleep(period)
            continue
        # post-fix oracle (047a96f) tags legitimate cross-frame states (sheet mid-open/close);
        # they are not menu content -- skip, never record
        if oracle.get("in_transition"):
            time.sleep(period)
            continue
        b = oracle.get("building", {}) or {}
        if not (b.get("button")):
            time.sleep(period)
            continue

        h, ctx = state_signature(oracle)
        if h in seen:
            time.sleep(max(0, period - (time.time() - loop_start)))
            continue
        seen.add(h)

        vs = oracle.get("view_sheets", {}) or {}
        active_id = vs.get("active_id")
        btype = buildmap.get(str(active_id)) or buildmap.get(active_id) or f"id{active_id}"
        pathdesc = derive_path(b)
        n_rows = len([r for r in (b.get("button") or []) if not r.get("leave_button")])

        record = {
            "index": index,
            "hash": h,
            "captured_at": now_iso(),
            "building_id": active_id,
            "building_type": btype,
            "path": pathdesc,
            "category": b.get("category"),
            "token": b.get("current_custom_category_token", ""),
            "matgloss": b.get("matgloss"),
            "n_rows": n_rows,
            "oracle": oracle,
        }
        # per-state file
        safe_type = str(btype).replace("/", "_").replace(" ", "")
        safe_cat = str(b.get("category") or "NONE").replace("/", "_")
        fname = f"{index:03d}-{safe_type}-{safe_cat}-{h}.json"
        with open(os.path.join(session_dir, fname), "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, indent=1)
        with open(jsonl_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

        print(
            f"[menuwalk] #{index:03d} {btype:<24} id={active_id} {pathdesc:<34} rows={n_rows} {h}",
            flush=True,
        )
        index += 1
        time.sleep(max(0, period - (time.time() - loop_start)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("[menuwalk] stopped", flush=True)
        sys.exit(0)
