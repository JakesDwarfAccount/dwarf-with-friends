#!/usr/bin/env python
# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
# SPDX-License-Identifier: AGPL-3.0-only
"""Build web/portraits_map.json from DF's shipped 96x96 portrait graphics raws.

Only portrait sets with one MAIN layer are emitted. Layered humanoid portraits remain on the
runtime /unit-portrait path; this map is the exact, license-safe crop metadata for flat animals.
The referenced PNGs stay in the user's DF install and are served by /sprites/img/.
"""

import argparse
import glob
import json
import os
import re
from pathlib import Path

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OUT = REPO / "web" / "portraits_map.json"


BLOCK_RE = re.compile(
    r"\[(CREATURE_GRAPHICS|CREATURE_CASTE_GRAPHICS):([^\]]+)\](.*?)"
    r"(?=\[(?:CREATURE_GRAPHICS|CREATURE_CASTE_GRAPHICS):|\Z)", re.S)
SET_RE = re.compile(r"\[LAYER_SET:(?:(CHILD):)?PORTRAIT\](.*?)(?=\[LAYER_SET:|\Z)", re.S)
LAYER_RE = re.compile(r"\[LAYER:([^:\]]+):([^:\]]+):(-?\d+):(-?\d+)(?::[^\]]*)?\]")


def discover_vanilla(explicit=None):
    """W1: one resolver. --vanilla still wins (it names data/vanilla directly, not the DF
    root); otherwise --df-root / $DWF_DF_ROOT / autodetect, and $DF_VANILLA_ROOT is still
    honoured because this tool has always accepted it."""
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    if os.environ.get("DF_VANILLA_ROOT"):
        base = Path(os.environ["DF_VANILLA_ROOT"])
        candidates.extend((base, base / "data" / "vanilla"))
    root = dfroot.df_root_default()
    if root:
        candidates.append(Path(root) / "data" / "vanilla")
    for candidate in candidates:
        gfx = candidate / "vanilla_creatures_graphics" / "graphics"
        if (gfx / "tile_page_portraits.txt").is_file():
            return candidate
    raise SystemExit(
        "Dwarf Fortress portrait raws not found.\n\n"
        + dfroot.missing_df_message(dfroot.resolve_df_root()[3], False,
                                    "reads DF's own portrait raws"))


def load_pages(path):
    pages = {}
    current = None
    for line in path.read_text(encoding="latin-1").splitlines():
        match = re.search(r"\[(TILE_PAGE|FILE|TILE_DIM|PAGE_DIM_PIXELS):([^\]]+)\]", line)
        if not match:
            continue
        kind, value = match.groups()
        if kind == "TILE_PAGE":
            current = value.strip()
            pages[current] = {}
        elif current:
            if kind == "FILE":
                rel = value.strip().replace("\\", "/")
                pages[current]["img"] = rel[len("images/"):] if rel.startswith("images/") else rel
            elif kind == "TILE_DIM":
                pages[current]["w"], pages[current]["h"] = map(int, value.split(":")[:2])
            elif kind == "PAGE_DIM_PIXELS":
                pages[current]["iw"], pages[current]["ih"] = map(int, value.split(":")[:2])
    return pages


def crop_for(layer, pages):
    name, page_name, col, row = layer
    page = pages.get(page_name)
    if name != "MAIN" or not page or not all(k in page for k in ("img", "w", "h")):
        return None
    w, h = page["w"], page["h"]
    crop = {"img": page["img"], "cx": int(col) * w, "cy": int(row) * h, "w": w, "h": h}
    if "iw" in page and "ih" in page:
        crop.update(iw=page["iw"], ih=page["ih"])
    return crop


def parse_portrait_file(path, pages, races):
    text = path.read_text(encoding="latin-1")
    for kind, key, body in BLOCK_RE.findall(text):
        parts = key.split(":")
        race, caste = parts[0], parts[1] if kind == "CREATURE_CASTE_GRAPHICS" and len(parts) > 1 else None
        record = races.setdefault(race, {})
        if caste:
            record = record.setdefault("castes", {}).setdefault(caste, {})
        for child, set_body in SET_RE.findall(body):
            layers = LAYER_RE.findall(set_body)
            if len(layers) != 1:
                continue
            crop = crop_for(layers[0], pages)
            if crop:
                record["child" if child else "adult"] = crop


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vanilla", help="Dwarf Fortress data/vanilla directory")
    args = parser.parse_args()
    vanilla = discover_vanilla(args.vanilla)
    gfx = vanilla / "vanilla_creatures_graphics" / "graphics"
    pages = load_pages(gfx / "tile_page_portraits.txt")
    races = {}
    for raw in sorted(glob.glob(str(gfx / "graphics_creatures_portraits_*.txt"))):
        parse_portrait_file(Path(raw), pages, races)
    races = {key: value for key, value in races.items() if value}
    output = {"_v": 1, "races": races}
    OUT.write_text(json.dumps(output, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    crops = sum("adult" in rec or "child" in rec for rec in races.values())
    print(f"wrote {OUT}")
    print(f"flat portrait races = {crops}; race/caste roots = {len(races)}")
    for token in ("CAT", "DOG"):
        print(f"{token} = {races.get(token)}")


if __name__ == "__main__":
    main()
