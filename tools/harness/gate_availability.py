#!/usr/bin/env python3
"""gate_availability.py -- TRUEMENU WP-2 acceptance: per-leaf availability + "[Requires X]" objection.

Oracle-differential (protocol rule 2): DF's OWN objection strings (a menu_oracle / paused native
capture -- e.g. tools/harness/results/truemenu-native/30-Furnace-Smelter-root.json) are the ground
truth. This diffs the SERVED /workshop-info taskTree (dwf.lua WP-2 avail/objection fields)
against a native capture, matched by leaf label.

Because availability is fort-STATE dependent (a row objections only while its material is absent),
the diff is state-tolerant: a native row that carries an objection is CHECKED only when the served
row is ALSO unavailable (avail=false); if the served row is now available (material appeared) the row
is SKIPPED and reported. Any row checked in BOTH must match BYTE-EXACT. PASS requires zero mismatches
AND at least one checked row (a vacuous all-skipped diff is CANNOT-CONCLUDE, exit 2).

--self-test (protocol rule 3): mutates a served dump two ways -- (a) strip all avail/objection fields
(the pre-WP-2 baseline) and (b) flip one objection string -- and requires the diff to FAIL on both.

Exit codes: 0 PASS, 1 FAIL, 2 CANNOT-CONCLUDE. Native capture is CP437; served body is UTF-8.
"""

import argparse
import copy
import json
import sys
import urllib.request


def load_cp437(path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("cp437"))


def load_served(src):
    # src is a file path or an http URL to /workshop-info; returns the body dict.
    if src.startswith("http://") or src.startswith("https://"):
        with urllib.request.urlopen(src, timeout=8) as r:
            return json.loads(r.read().decode("utf-8"))
    with open(src, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def norm(s):
    return " ".join(str(s or "").strip().split()).lower()


def native_rows(cap):
    """[(label, objection)] for every non-navigation native button row."""
    b = cap.get("building", {})
    rows = b.get("button") or b.get("filtered_button") or []
    out = []
    for r in rows:
        if r.get("leave_button"):
            continue
        cls = str(r.get("class") or "")
        if "new_job" not in cls and "material_selector" in cls:
            continue  # a drill row, not a queueable leaf
        label = r.get("text") or r.get("filter_str") or ""
        out.append((label, r.get("objection") or ""))
    return out


def served_leaves(body):
    """flat map norm(label) -> {'label','avail','objection'} over a taskTree (flat native shop)."""
    tree = body.get("taskTree") if isinstance(body, dict) else body
    out = {}
    if not isinstance(tree, list):
        return out

    def add(node):
        if not isinstance(node, dict):
            return
        if isinstance(node.get("leaves"), list):
            for l in node["leaves"]:
                add(l)
            return
        out[norm(node.get("label"))] = {
            "label": node.get("label"),
            "avail": node.get("avail"),          # None if not annotated (pre-WP-2 / craftsdwarf)
            "objection": node.get("objection"),  # None if not annotated
        }
    for n in tree:
        add(n)
    return out


def run_diff(cap, body, verbose=True):
    """Returns (checked, matched, mismatches[list], skipped, missing[list])."""
    served = served_leaves(body)
    checked = matched = skipped = 0
    mismatches, missing = [], []
    for label, n_obj in native_rows(cap):
        if not n_obj:
            continue  # native row available -> no objection to verify
        s = served.get(norm(label))
        if s is None:
            missing.append(label)
            continue
        if s.get("avail") is None:
            # served row carries NO availability info -> WP-2 not applied to it (baseline / gap)
            mismatches.append((label, n_obj, "<no avail field>"))
            continue
        if s.get("avail") is True:
            skipped += 1  # material appeared since the capture -> state drift, cannot compare
            continue
        checked += 1
        s_obj = s.get("objection") or ""
        if s_obj == n_obj:
            matched += 1
        else:
            mismatches.append((label, n_obj, s_obj))
    if verbose:
        print(f"checked={checked} matched={matched} mismatches={len(mismatches)} "
              f"state-skipped={skipped} missing-served-row={len(missing)}")
        for label, n_obj, s_obj in mismatches[:20]:
            print(f"  MISMATCH  {label!r}  native={n_obj!r}  served={s_obj!r}")
        for label in missing[:10]:
            print(f"  MISSING   served row for native leaf {label!r}")
    return checked, matched, mismatches, skipped, missing


def verdict(cap, body):
    checked, matched, mismatches, skipped, missing = run_diff(cap, body)
    if mismatches or missing:
        return 1
    if checked == 0:
        print("CANNOT CONCLUDE: every objection row was state-skipped (fort no longer matches the "
              "capture's material state). Re-capture or re-run when the fort is comparably barren.")
        return 2
    print(f"PASS: {matched}/{checked} served objections byte-match the native capture "
          f"({skipped} rows state-skipped).")
    return 0


def run_self_test(cap, body):
    ok = True
    # (a) strip all avail/objection -> the pre-WP-2 baseline; the diff MUST fail.
    baseline = copy.deepcopy(body)
    tree = baseline.get("taskTree") if isinstance(baseline, dict) else baseline
    for n in (tree or []):
        for l in ([n] if not isinstance(n.get("leaves"), list) else n["leaves"]):
            l.pop("avail", None)
            l.pop("objection", None)
    print("== self-test (a) pre-WP-2 baseline (no avail fields) ==")
    _, _, mm_a, _, miss_a = run_diff(cap, baseline)
    caught_a = bool(mm_a or miss_a)
    print(("SELF-TEST PASS" if caught_a else "SELF-TEST FAIL -- baseline was accepted"))
    ok = ok and caught_a

    # (b) flip one served objection string -> the diff MUST fail.
    flipped = copy.deepcopy(body)
    tree = flipped.get("taskTree") if isinstance(flipped, dict) else flipped
    did = False
    for n in (tree or []):
        for l in ([n] if not isinstance(n.get("leaves"), list) else n["leaves"]):
            if l.get("avail") is False and l.get("objection"):
                l["objection"] = "[Requires WRONG]"
                did = True
                break
        if did:
            break
    print("== self-test (b) one flipped objection string ==")
    if not did:
        print("SELF-TEST SKIP -- no unavailable served row to flip (fort not barren enough)")
    else:
        _, _, mm_b, _, miss_b = run_diff(cap, flipped)
        caught_b = bool(mm_b or miss_b)
        print(("SELF-TEST PASS" if caught_b else "SELF-TEST FAIL -- flipped string was accepted"))
        ok = ok and caught_b
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--oracle", required=True, help="native capture json (CP437), e.g. capture 30")
    ap.add_argument("--served", required=True, help="served /workshop-info dump file OR http URL")
    ap.add_argument("--self-test", action="store_true", help="run the seeded-bad test-the-test pass")
    args = ap.parse_args()

    cap = load_cp437(args.oracle)
    body = load_served(args.served)
    if args.self_test:
        sys.exit(0 if run_self_test(cap, body) else 1)
    sys.exit(verdict(cap, body))


if __name__ == "__main__":
    main()
