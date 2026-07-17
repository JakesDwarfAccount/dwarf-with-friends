#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
#
# WS2 (WC-16): flow_type -> raw token table for the client's flow/cloud decal layer
# (W-B W11 animation clock; this generator supplies the DATA half -- see
# docs/superpowers/specs/2026-07-07-WC-coverage-spec.md Chunk F). WC-15 puts
# `flow_type`/`density` on the wire (FLOW tail, kTailFlow=0x04); the per-token art
# (`graphics_flows.txt`, EVENT_FLOWS page, already parsed by the runtime spriteMap
# with WC-10's frames[] extension -- 10 tokens x 4 row-frames) needs nothing new
# from THIS generator except the flow_type-ordinal -> token correspondence table,
# since the runtime spriteMap is keyed by TOKEN STRING, not by the wire's numeric
# df::flow_type ordinal.
#
# Verified this session (graphics_flows.txt, df.flow.xml flow_type enum order):
#   14 flow_type values (0..13); 10 of them have dedicated EVENT_FLOWS art (4
#   row-frames each, col=type row=frame -- exact match to graphics_flows.txt).
#   Steam(1)/MaterialGas(9) intentionally SHARE FLOW_BOILING (both are "material
#   boiling into gas" -- same visual in vanilla, verified: no separate token for
#   either). Web(8) has NO flow art (webs render via the ITEM/THREAD art path,
#   WC-1..3 -- verified absent from every environment-dir graphics file).
#   OceanWave(11)/SeaFoam(12) -- VERIFIED ABSENT from graphics_fluids.txt (grep
#   for "wave"/"foam", case-insensitive: zero matches) and from every other
#   environment-dir graphics_*.txt this session. No vanilla flow-cloud art exists
#   for these two; marked skip (the spec's own NEEDS-CHECK, resolved: skip).
#
# Run (stdlib only, no DF install read needed -- the table is fully verified
# static data; kept as a generator script for the same "regenerate from source"
# convention as every other tools/ws2/build_*.py, and to re-verify the OceanWave/
# SeaFoam absence against a live install path if one is available):
#   python tools/ws2/build_flow_map.py
#
# Reads (READ-ONLY, best-effort re-verification; falls back to the verified table
# above if the DF install path is unavailable):
#   .../vanilla_environment/graphics/graphics_flows.txt
#   .../vanilla_environment/graphics/graphics_fluids.txt
# Writes:
#   web/flow_map.json

import json
import os
import re
import sys

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DF_ROOT = dfroot.df_root_for(__file__, sub="data/vanilla",
                          purpose="reads Dwarf Fortress's own raws as the ground truth")
ENV_GFX = os.path.join(DF_ROOT, "vanilla_environment", "graphics")
OUT_PATH = os.path.join(REPO, "web", "flow_map.json")

# df::flow_type ordinal (df.flow.xml, verified 2026-07-07) -> raw EVENT_FLOWS token,
# or null when vanilla ships no flow-cloud art for that type (see module docstring).
FLOW_TYPE_TOKEN = {
    0:  "FLOW_MIASMA",
    1:  "FLOW_BOILING",       # Steam (MIST_WATER) -- shares with MaterialGas
    2:  "FLOW_WATER_MIST",    # Mist (MIST_WATERFALL) -- waterfall/brook mist
    3:  "FLOW_DUST",          # MaterialDust
    4:  "FLOW_LAVA_MIST",     # MagmaMist
    5:  "FLOW_SMOKE",
    6:  "FLOW_DRAGONFIRE",
    7:  "FLOW_FIRE",
    8:  None,                 # Web -- no flow art; renders via item/thread path (WC-1..3)
    9:  "FLOW_BOILING",       # MaterialGas -- shares with Steam
    10: "FLOW_VAPOR",         # MaterialVapor
    11: None,                 # OceanWave -- verified absent from vanilla graphics raws
    12: None,                 # SeaFoam -- verified absent from vanilla graphics raws
    13: "FLOW_ITEM",          # ItemCloud
}
FLOW_TYPE_NAME = {
    0: "Miasma", 1: "Steam", 2: "Mist", 3: "MaterialDust", 4: "MagmaMist",
    5: "Smoke", 6: "Dragonfire", 7: "Fire", 8: "Web", 9: "MaterialGas",
    10: "MaterialVapor", 11: "OceanWave", 12: "SeaFoam", 13: "ItemCloud",
}


def reverify_against_raws():
    """Best-effort: if the DF install is reachable, re-parse graphics_flows.txt and
    confirm every non-null token above actually exists with 4 row-frames, and
    re-confirm OceanWave/SeaFoam ("wave"/"foam", case-insensitive) are absent from
    graphics_fluids.txt. Returns a small report dict; never raises (a missing/moved
    DF install must not break the build -- the table above is the verified source
    of truth either way)."""
    report = {"checked": False}
    flows_path = os.path.join(ENV_GFX, "graphics_flows.txt")
    fluids_path = os.path.join(ENV_GFX, "graphics_fluids.txt")
    if not (os.path.isfile(flows_path) and os.path.isfile(fluids_path)):
        return report
    try:
        tg = re.compile(r"\[TILE_GRAPHICS:EVENT_FLOWS:(-?\d+):(-?\d+):(FLOW_[A-Za-z0-9_]+):\d+\]")
        frame_counts = {}
        for ln in open(flows_path, "r", encoding="latin-1"):
            m = tg.match(ln.strip())
            if not m:
                continue
            _col, _row, token = m.groups()
            frame_counts[token] = frame_counts.get(token, 0) + 1
        missing = []
        for ft, tok in FLOW_TYPE_TOKEN.items():
            if tok is not None and frame_counts.get(tok, 0) < 4:
                missing.append((ft, tok, frame_counts.get(tok, 0)))
        fluids_text = open(fluids_path, "r", encoding="latin-1").read().lower()
        wave_or_foam_found = ("wave" in fluids_text) or ("foam" in fluids_text)
        report = {
            "checked": True,
            "tokens_with_lt_4_frames": missing,
            "oceanwave_seafoam_art_found_in_fluids_file": wave_or_foam_found,
        }
    except OSError:
        pass
    return report


def main():
    report = reverify_against_raws()
    out = {
        "_v": 1,
        "flow_type_token": {str(k): v for k, v in sorted(FLOW_TYPE_TOKEN.items())},
        "flow_type_name": {str(k): v for k, v in sorted(FLOW_TYPE_NAME.items())},
        "sheet": "event_flows.png",
        "frames_per_token": 4,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)

    n_art = sum(1 for v in FLOW_TYPE_TOKEN.values() if v is not None)
    print("flow_type entries           : %d (%d with art, %d skip)" %
          (len(FLOW_TYPE_TOKEN), n_art, len(FLOW_TYPE_TOKEN) - n_art))
    if report.get("checked"):
        if report["tokens_with_lt_4_frames"]:
            print("WARNING: raws re-verify found tokens with <4 frames: %s" %
                  report["tokens_with_lt_4_frames"], file=sys.stderr)
        else:
            print("raws re-verify OK: every mapped token has 4 EVENT_FLOWS row-frames")
        if report["oceanwave_seafoam_art_found_in_fluids_file"]:
            print("WARNING: 'wave'/'foam' text now found in graphics_fluids.txt -- "
                  "re-check OceanWave/SeaFoam art (table says skip)", file=sys.stderr)
        else:
            print("raws re-verify OK: no 'wave'/'foam' art in graphics_fluids.txt (OceanWave/SeaFoam skip confirmed)")
    else:
        print("(DF install not found at %s -- skipped live re-verify, using the verified static table)" % ENV_GFX)
    print("wrote                       : %s" % OUT_PATH)


if __name__ == "__main__":
    main()
