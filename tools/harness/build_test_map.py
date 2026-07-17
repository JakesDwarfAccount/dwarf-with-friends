#!/usr/bin/env python3
"""Generate TEST-MAP.md: which harness tests cover which source files.

The harness tests load the modules they exercise by repo-relative path
(`read("web/js/dwf-kitchen.js")`, `src/wire_v1.cpp` string witnesses, ...).
That makes the file -> test mapping derivable instead of hand-maintained.

  python tools/harness/build_test_map.py            # write TEST-MAP.md
  python tools/harness/build_test_map.py --check    # non-zero exit if stale

The untested-file list is the point of the exercise: those are the places a
change can land with every gate still green.
"""

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
HARNESS = ROOT / "tools" / "harness"
OUT = HARNESS / "TEST-MAP.md"

# Tests reference a module three ways, and all three count as "this test knows
# about it": a full repo path ("web/js/dwf-core.js"), a path assembled from
# parts (read("web/js", "dwf-core.js") -- so the full path never appears as
# one string), or a bare filename in a string-literal witness. Matching the
# BASENAME catches all three; basenames here are unique across web/js and src.
# Tests that read nearly every module (adoption census, drift sweeps). They are
# real coverage, but listing them against all 112 files buries the specific tests.
BROAD_THRESHOLD = 25


def sources():
    js = sorted(p for p in (ROOT / "web" / "js").glob("dwf-*.js"))
    cpp = sorted(p for p in (ROOT / "src").glob("*.cpp"))
    return [f"web/js/{p.name}" for p in js] + [f"src/{p.name}" for p in cpp]


def scan(files):
    # Word-boundary on the basename so dwf-core.js does not also match
    # a hypothetical dwf-core-extra.js.
    pats = {f: re.compile(r"(?<![\w-])" + re.escape(f.split("/")[-1])) for f in files}
    covers, broad = {}, set()
    for test in sorted(HARNESS.glob("*.mjs")):
        text = test.read_text(encoding="utf-8", errors="replace")
        hits = {f for f, pat in pats.items() if pat.search(text)}
        if not hits:
            continue
        if len(hits) >= BROAD_THRESHOLD:
            broad.add(test.name)
            continue
        for h in hits:
            covers.setdefault(h, set()).add(test.name)
    return covers, broad


def render(covers, broad, files):
    tested = [f for f in files if covers.get(f)]
    untested = [f for f in files if not covers.get(f)]
    total_tests = len(sorted({t for ts in covers.values() for t in ts}))

    L = []
    L.append("# TEST-MAP — which tests cover which file")
    L.append("")
    L.append("**Generated. Do not hand-edit.** Regenerate with `python tools/harness/build_test_map.py`.")
    L.append("")
    L.append("You changed a file. Find it below. Run the tests listed next to it:")
    L.append("")
    L.append("```")
    L.append("node tools/harness/<test-name>.mjs")
    L.append("```")
    L.append("")
    L.append("No build step, no install. A test prints its own failures and exits non-zero.")
    L.append("")
    L.append(f"- **{len(tested)}** source files have at least one specific test")
    L.append(f"- **{len(untested)}** have none — see *Blind spots* below")
    L.append(f"- **{total_tests}** tests are mapped; **{len(broad)}** broad sweeps run against nearly everything")
    L.append("")
    L.append("## Blind spots — files with no test")
    L.append("")
    L.append("A change here can pass every gate and still be broken. Highest value place to add a test.")
    L.append("")
    if untested:
        for f in untested:
            L.append(f"- `{f}`")
    else:
        L.append("_None._")
    L.append("")
    L.append("## Always-run sweeps")
    L.append("")
    L.append("These read most of the codebase. Run them after any")
    L.append("change to shared code — DWFUI, core, the panel frame — regardless of what the map says.")
    L.append("")
    for t in sorted(broad):
        L.append(f"- `node tools/harness/{t}`")
    L.append("")
    L.append("## The map")
    L.append("")
    for group, label in (("web/js/", "Browser client — web/js/"), ("src/", "Plugin — src/")):
        L.append(f"### {label}")
        L.append("")
        L.append("| file | tests to run |")
        L.append("| --- | --- |")
        for f in files:
            if not f.startswith(group):
                continue
            ts = covers.get(f)
            cell = " ".join(f"`{t}`" for t in sorted(ts)) if ts else "_none_"
            L.append(f"| `{f.split('/')[-1]}` | {cell} |")
        L.append("")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="exit 1 if TEST-MAP.md is stale")
    args = ap.parse_args()

    files = sources()
    covers, broad = scan(files)
    text = render(covers, broad, files)

    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print("TEST-MAP.md is stale -- run: python tools/harness/build_test_map.py", file=sys.stderr)
            return 1
        print("TEST-MAP.md is current")
        return 0

    OUT.write_text(text, encoding="utf-8")
    untested = [f for f in files if not covers.get(f)]
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  {len(files) - len(untested)}/{len(files)} files covered, {len(untested)} blind spots")
    return 0


if __name__ == "__main__":
    sys.exit(main())
