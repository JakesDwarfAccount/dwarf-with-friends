#!/usr/bin/env python3
"""B232 -- generate the announcement taxonomy from DF's own raws.

SOURCE OF TRUTH: <DF>/data/init/announcements.txt.  That file lists every announcement token
DF knows plus its behaviour flags, and its token list is EXACTLY df::announcement_type minus the
4 UNUSED_* placeholders (verified: 352 tokens in the raws, 356 enum entries, the 4-way difference
is UNUSED_0001 / UNUSED_0002 / UNUSED_49 / UNUSED_50).  So a table keyed by the raws token name
maps 1:1 onto the `typeKey` we already put on the wire.

WHY BAKE INSTEAD OF READING THE FILE AT RUNTIME
  1. announcements.txt is the PLAYER'S file.  It exists so players can change BOX/PAUSE/ALERT
     behaviour.  It encodes BEHAVIOUR, not IDENTITY -- a player who deletes :BOX from MADE_ARTIFACT
     has not stopped artifacts being artifacts.  If we derived the SECTION live, one raws edit would
     silently move rows between sections.
  2. /reports runs its scan on the render thread under the core lock (B221: nothing slow under
     CoreSuspender).  A baked table is an O(1) array index per report, zero I/O, zero allocation.
  3. The generator ASSERTS the raws token set against df::announcement_type.h.  A DF update that
     adds a token fails HERE, loudly, instead of silently dumping new events into Misc.
  The cost is that the BOX/ALERT/... flags we report are DF's SHIPPED defaults, not this player's
  edited ones.  That is a documented limitation, not an accident.

Emits two files from ONE table so the server and the browser cannot drift:
  src/announce_taxonomy.gen.h          -- C++, flat array indexed by announcement_type value
  web/js/dwf-announce-taxonomy.js -- JS, same table; the client labels/chips read it

Usage:
  python tools/harness/gen_announce_taxonomy.py [--df-root <path>] [--check]

--check regenerates in memory and diffs against the checked-in files (exit 1 on drift).
"""

import argparse
import os
import re
import sys

# W1: the ONE DF-install resolver (--df-root / $DWF_DF_ROOT / autodetect).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "lib"))
import dfroot  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

DEFAULT_DF_ROOT = dfroot.df_root_for(__file__, purpose="reads Dwarf Fortress's own raws as the ground truth")
DEFAULT_ENUM_H = os.path.join(os.environ.get("DFHACK_SRC", ""), "library", "include", "df", "announcement_type.h")

# ---- flags, straight out of the legend at the top of announcements.txt ------------------------
FLAG_BITS = {
    "A_D": 1, "A_DISPLAY": 1,
    "D_D": 2, "D_DISPLAY": 2,
    "BOX": 4, "DO_MEGA": 4,
    "P": 8, "PAUSE": 8,
    "R": 16, "RECENTER": 16,
    "ALERT": 32,
    "UCR": 64, "UNIT_COMBAT_REPORT": 64,
    "UCR_A": 128, "UNIT_COMBAT_REPORT_ALL_ACTIVE": 128,
}
F_BOX, F_ALERT, F_UCR, F_UCR_A = 4, 32, 64, 128

# ---- sections ---------------------------------------------------------------------------------
# Order is the PRECEDENCE LADDER, first match wins, and the order is load-bearing:
#   deaths before combat  -- CITIZEN_DEATH carries UCR_A; a kill line is both, and a death belongs
#                            in Deaths (that is the row you go looking for).
#   sieges before combat  -- GHOST_ATTACK carries UCR_A but is an invasion, not a spar.
#   combat LAST but for misc -- DF's own UCR / UCR_A flag ("associated to the unit combat/hunting/
#                            sparring reports") IS the authoritative combat marker.  Everything the
#                            named sections did not claim, and that DF files into a unit's combat
#                            log, is combat.
SECTIONS = ["misc", "combat", "sieges", "artifacts", "trade", "nobles", "deaths"]
SECTION_LABELS = {
    "misc": "Misc",
    "combat": "Combat",
    "sieges": "Sieges & invasions",
    "artifacts": "Artifacts & masterworks",
    "trade": "Trade & diplomacy",
    "nobles": "Nobles & mandates",
    "deaths": "Deaths",
}

DEATHS = {
    "CITIZEN_DEATH", "PET_DEATH", "ADV_CREATURE_DEATH", "CITIZEN_MISSING", "PET_MISSING",
    "CITIZEN_LOST_TO_STRESS", "PET_LOSES_DEAD_OWNER",
}

# THERE IS NO `SIEGE` TOKEN.  Checked: neither announcements.txt nor df::announcement_type has one,
# and df::announcement_alert_type has no SIEGE either.  DF's siege banner is hardcoded outside the
# raws.  So "Sieges & invasions" is COMPOSED from the hostile-arrival family that the raws DO name
# -- every AMBUSH_*, the night attacks, the beasts, the undead -- and is backstopped at runtime by
# an alert-type rescue (AMBUSH / MONSTER / UNDEAD_ATTACK) so a report DF files under one of those
# alert types lands here even if its token is one we never saw.  See ALERT_RESCUE below.
SIEGE_PREFIXES = ("AMBUSH_", "NIGHT_ATTACK_")
SIEGES = {
    "BEAST_AMBUSH", "MEGABEAST_ARRIVAL", "WEREBEAST_ARRIVAL", "UNDEAD_ATTACK", "GHOST_ATTACK",
    "CITIZEN_SNATCHED", "CREATURE_STEALS_OBJECT", "EMERGENCY_TACTICAL_CONTROL",
    "MISCHIEF_LEVER", "MISCHIEF_PLATE", "MISCHIEF_CAGE", "MISCHIEF_CHAIN",
}

# B160's intent ("sieges and artifact creation get their own sections").  The registry landed
# `typeKey === "ARTIFACT_CREATED"` -- a token that DOES NOT EXIST.  The real ones are these.
ARTIFACTS = {
    "MADE_ARTIFACT", "NAMED_ARTIFACT", "ARTIFACT_BEGUN", "STRANGE_MOOD", "MOOD_BUILDING_CLAIMED",
    "ITEM_ATTACHMENT", "POSSESSED_TANTRUM",
    "MASTERPIECE_CRAFTED", "MASTERPIECE_ENGRAVING", "MASTERPIECE_CONSTRUCTION",
    "MASTERFUL_IMPROVEMENT", "DYED_MASTERPIECE", "COOKED_MASTERPIECE",
    "ARTWORK_DEFACED", "MAGMA_DEFACES_ENGRAVING", "ENGRAVING_MELTS",
    "MASTER_ARCHITECTURE_LOST", "MASTER_CONSTRUCTION_LOST",
}

TRADE = {
    "CARAVAN_ARRIVAL", "FIRST_CARAVAN_ARRIVAL", "MERCHANTS_UNLOADING", "MERCHANTS_NEED_DEPOT",
    "MERCHANT_WAGONS_BYPASSED", "MERCHANTS_LEAVING_SOON", "MERCHANTS_EMBARKED",
    "DIPLOMAT_ARRIVAL", "LIAISON_ARRIVAL", "TRADE_DIPLOMAT_ARRIVAL", "DIPLOMAT_LEFT_UNHAPPY",
    "AGREEMENT_SATISFIED", "AGREEMENT_WARNING", "AGREEMENT_ABANDONED",
    "GUEST_ARRIVAL", "NEW_MARKET_LINK", "PETITION_IGNORED", "NEW_APPRENTICESHIP",
}

NOBLES = {
    "NOBLE_ARRIVAL", "MONARCH_ARRIVAL", "HASTY_MONARCH", "SATISFIED_MONARCH", "MOUNTAINHOME",
    "FORT_POSITION_SUCCESSION", "ELECTION_RESULTS",
    "NEW_MANDATE", "NEW_DEMAND", "DEMAND_FORGOTTEN", "MANDATE_ENDS", "NEW_WORK_MANDATE",
    "PRICES_ALTERED", "QUOTA_FILLED", "SLOWDOWN_ENDS",
    "LAND_GAINS_STATUS", "LAND_ELEVATED_STATUS", "NEW_HOLDING", "GAIN_SITE_CONTROL",
    "GUILD_REQUEST_TAKEN", "GUILD_WAGES_CHANGED", "NEW_GUILD",
}

# Runtime rescue, applied ONLY to a token the ladder put in `misc`.  Keyed by
# df::announcement_alert_type.  This is what catches (a) DF's hardcoded siege banner if it carries
# an AMBUSH/MONSTER alert type, and (b) any token a future DF adds that we have never seen.  It is
# fail-open by construction: it can only move a row OUT of Misc, never between named sections.
ALERT_RESCUE = {
    4: "sieges",    # MONSTER
    5: "sieges",    # AMBUSH
    23: "sieges",   # UNDEAD_ATTACK
    21: "deaths",   # DEATH
    34: "combat",   # COMBAT
    35: "combat",   # SPARRING
    36: "combat",   # HUNTING
    6: "trade",     # TRADE
    31: "trade",    # AGREEMENT
    28: "trade",    # GUEST_ARRIVAL
    7: "nobles",    # NOBLE
    29: "nobles",   # HOLDINGS
    19: "artifacts",  # MASTERPIECE
    10: "artifacts",  # MOOD
    18: "artifacts",  # ART_DEFACEMENT
}


def section_for(token, flags):
    if token in DEATHS:
        return "deaths"
    if token in SIEGES or token.startswith(SIEGE_PREFIXES):
        return "sieges"
    if token in ARTIFACTS:
        return "artifacts"
    if token in NOBLES:
        return "nobles"
    if token in TRADE:
        return "trade"
    if (flags & (F_UCR | F_UCR_A)) or token.startswith("COMBAT_"):
        return "combat"
    return "misc"


def parse_raws(path):
    """-> [(token, flags)] in file order."""
    out = []
    seen = set()
    with open(path, "r", encoding="latin-1") as fh:
        for line in fh:
            m = re.match(r"^\[([A-Z0-9_]+)((?::[A-Z0-9_]+)*)\]", line.strip())
            if not m:
                continue
            token = m.group(1)
            if token in seen:
                raise SystemExit("duplicate token in announcements.txt: " + token)
            seen.add(token)
            flags = 0
            for part in filter(None, m.group(2).split(":")):
                if part not in FLAG_BITS:
                    raise SystemExit("unknown flag %r on %s -- the legend changed" % (part, token))
                flags |= FLAG_BITS[part]
            out.append((token, flags))
    if not out:
        raise SystemExit("no tokens parsed from " + path)
    return out


def parse_enum(path):
    """-> [name] indexed by announcement_type value (NONE=-1 excluded)."""
    names = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*([A-Z][A-Z0-9_]*),\s*//\s*(\d+),", line)
            if m:
                value = int(m.group(2))
                if value != len(names):
                    raise SystemExit("announcement_type is not densely ordered at %d" % value)
                names.append(m.group(1))
    if not names:
        raise SystemExit("no enum entries parsed from " + path)
    return names


def build(df_root, enum_h):
    raws = parse_raws(os.path.join(df_root, "data", "init", "announcements.txt"))
    enum_names = parse_enum(enum_h)
    raw_flags = dict(raws)

    # The assertion that makes this table trustworthy: every raws token is an enum member, and
    # every enum member that is not an UNUSED_* placeholder is in the raws.
    unknown = [t for t, _ in raws if t not in enum_names]
    if unknown:
        raise SystemExit("raws tokens absent from df::announcement_type: " + ", ".join(unknown))
    missing = [n for n in enum_names if n not in raw_flags and not n.startswith("UNUSED")]
    if missing:
        raise SystemExit("enum members absent from announcements.txt: " + ", ".join(missing))

    rows = []
    for value, name in enumerate(enum_names):
        flags = raw_flags.get(name, 0)
        sect = "misc" if name.startswith("UNUSED") else section_for(name, flags)
        rows.append((value, name, sect, flags))
    return rows, len(raws)


LICENSE = """// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only
"""

BANNER = """
// GENERATED BY tools/harness/gen_announce_taxonomy.py -- DO NOT EDIT.
// Source of truth: <DF>/data/init/announcements.txt (%d tokens) checked against
// df::announcement_type (%d entries incl. UNUSED_* placeholders).
// Regenerate:  python tools/harness/gen_announce_taxonomy.py
// Verify:      python tools/harness/gen_announce_taxonomy.py --check
"""


def emit_cpp(rows, n_raws):
    L = []
    L.append(LICENSE)
    L.append(BANNER % (n_raws, len(rows)))
    L.append("""
#pragma once

#include <cstdint>

namespace dwf {
namespace taxonomy {

// Flag bits, from the legend at the top of announcements.txt.
enum AnnounceFlag : uint8_t {
    FLAG_A_DISPLAY = 1,    // shows in the adventure announcement log
    FLAG_D_DISPLAY = 2,    // shows in the dwarf announcement alerts
    FLAG_BOX       = 4,    // BOX / DO_MEGA -- box popup AND a hard pause
    FLAG_PAUSE     = 8,    // P / PAUSE
    FLAG_RECENTER  = 16,   // R / RECENTER
    FLAG_ALERT     = 32,   // lights the alert button
    FLAG_UCR       = 64,   // attaches to unit combat/hunting/sparring reports
    FLAG_UCR_ACTIVE = 128, // UCR_A -- attaches only to an ALREADY-ACTIVE unit report
};

// Section ids. `misc` is 0 so a zero-initialised / unknown row degrades to Misc, never to a
// section it does not belong in.
enum Section : uint8_t {
    SECTION_MISC = 0,
    SECTION_COMBAT = 1,
    SECTION_SIEGES = 2,
    SECTION_ARTIFACTS = 3,
    SECTION_TRADE = 4,
    SECTION_NOBLES = 5,
    SECTION_DEATHS = 6,
    SECTION_COUNT = 7,
};

struct SectionInfo { const char* key; const char* label; };
static constexpr SectionInfo SECTION_INFO[SECTION_COUNT] = {""")
    for key in SECTIONS:
        L.append('    { "%s", "%s" },' % (key, SECTION_LABELS[key]))
    L.append("};")
    L.append("""
struct AnnounceTaxon {
    const char* key;   // df::announcement_type enum key == the announcements.txt token
    uint8_t section;   // Section
    uint8_t flags;     // AnnounceFlag bitfield, as SHIPPED by DF (see the generator's header)
};

// Indexed DIRECTLY by df::announcement_type value (0 .. TAXONOMY_COUNT-1). O(1), no search --
// this is what lets the /reports scan classify every entry in the fort's report vector without
// costing anything measurable under the core lock.
static constexpr AnnounceTaxon TAXONOMY[] = {""")
    for value, name, sect, flags in rows:
        L.append('    { "%s", SECTION_%s, %d }, // %d' % (name, sect.upper(), flags, value))
    L.append("};")
    L.append("static constexpr int TAXONOMY_COUNT = %d;" % len(rows))
    L.append("""
// Rescue table: applied ONLY when TAXONOMY put a report in Misc. Keyed by
// df::announcement_alert_type. Fail-open by construction -- it can move a row OUT of Misc but can
// never move it between two named sections. This is the backstop for DF's HARDCODED siege banner
// (there is no SIEGE announcement token) and for any token a future DF version adds.
struct AlertRescue { int16_t alert_type; uint8_t section; };
static constexpr AlertRescue ALERT_RESCUE[] = {""")
    for alert, sect in sorted(ALERT_RESCUE.items()):
        L.append("    { %d, SECTION_%s }," % (alert, sect.upper()))
    L.append("};")
    L.append("static constexpr int ALERT_RESCUE_COUNT = %d;" % len(ALERT_RESCUE))
    L.append("""
// The two calls the server makes. Both are branch-light and allocation-free.
inline const AnnounceTaxon* taxon_for(int announcement_type) {
    if (announcement_type < 0 || announcement_type >= TAXONOMY_COUNT)
        return nullptr;
    return &TAXONOMY[announcement_type];
}

inline uint8_t section_for(int announcement_type, int alert_type) {
    const AnnounceTaxon* taxon = taxon_for(announcement_type);
    uint8_t section = taxon ? taxon->section : SECTION_MISC;
    if (section != SECTION_MISC)
        return section;
    for (int i = 0; i < ALERT_RESCUE_COUNT; ++i) {
        if (ALERT_RESCUE[i].alert_type == alert_type)
            return ALERT_RESCUE[i].section;
    }
    return SECTION_MISC;
}

inline uint8_t flags_for(int announcement_type) {
    const AnnounceTaxon* taxon = taxon_for(announcement_type);
    return taxon ? taxon->flags : 0;
}

// -1 when `key` is not a section key ("all", "", garbage) -- the route reads that as "no filter".
inline int section_from_key(const char* key, size_t len) {
    if (!key || len == 0)
        return -1;
    for (int i = 0; i < SECTION_COUNT; ++i) {
        const char* candidate = SECTION_INFO[i].key;
        size_t n = 0;
        while (candidate[n] && n < len && candidate[n] == key[n]) ++n;
        if (!candidate[n] && n == len)
            return i;
    }
    return -1;
}

} // namespace taxonomy
} // namespace dwf""")
    return "\n".join(L) + "\n"


def emit_js(rows, n_raws):
    L = []
    L.append(LICENSE)
    L.append(BANNER % (n_raws, len(rows)))
    L.append("""
(function (root) {
  "use strict";

  var FLAGS = Object.freeze({
    A_DISPLAY: 1, D_DISPLAY: 2, BOX: 4, PAUSE: 8, RECENTER: 16, ALERT: 32,
    UCR: 64, UCR_ACTIVE: 128
  });

  var SECTIONS = Object.freeze([""")
    for i, key in enumerate(SECTIONS):
        L.append('    { id: %d, key: "%s", label: "%s" },' % (i, key, SECTION_LABELS[key]))
    L.append("""  ]);

  // token -> [sectionId, flags]. Keyed by the announcements.txt token, which IS the `typeKey`
  // the server puts on every report.
  var BY_KEY = {""")
    for _value, name, sect, flags in rows:
        L.append('    %s: [%d, %d],' % (name, SECTIONS.index(sect), flags))
    L.append("""  };

  var ALERT_RESCUE = {""")
    for alert, sect in sorted(ALERT_RESCUE.items()):
        L.append("    %d: %d," % (alert, SECTIONS.index(sect)))
    L.append("""  };

  // Mirrors taxonomy::section_for() in src/announce_taxonomy.gen.h EXACTLY. The gate
  // (b232_announce_screen_test.mjs) diffs the two tables token-for-token so they cannot drift.
  function sectionId(typeKey, alertType) {
    var row = BY_KEY[String(typeKey == null ? "" : typeKey)];
    var id = row ? row[0] : 0;
    if (id !== 0) return id;
    var rescued = ALERT_RESCUE[Number(alertType)];
    return rescued == null ? 0 : rescued;
  }
  function sectionKey(typeKey, alertType) { return SECTIONS[sectionId(typeKey, alertType)].key; }
  function sectionLabel(key) {
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].key === key) return SECTIONS[i].label;
    return "Misc";
  }
  function flagsFor(typeKey) {
    var row = BY_KEY[String(typeKey == null ? "" : typeKey)];
    return row ? row[1] : 0;
  }
  function isBox(typeKey) { return (flagsFor(typeKey) & FLAGS.BOX) !== 0; }
  function isAlert(typeKey) { return (flagsFor(typeKey) & FLAGS.ALERT) !== 0; }

  var api = {
    FLAGS: FLAGS, SECTIONS: SECTIONS, BY_KEY: BY_KEY, ALERT_RESCUE: ALERT_RESCUE,
    sectionId: sectionId, sectionKey: sectionKey, sectionLabel: sectionLabel,
    flagsFor: flagsFor, isBox: isBox, isAlert: isAlert
  };
  root.DwfAnnounceTaxonomy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));""")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--df-root", default=os.environ.get("DF_ROOT", DEFAULT_DF_ROOT))
    ap.add_argument("--enum-h", default=os.environ.get("DF_ANNOUNCE_ENUM", DEFAULT_ENUM_H))
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    # This verification needs DF's announcement_type.h from a DFHack source tree. A bare clone of
    # the public repo won't have it, so skip cleanly (exit 0) with a clear message instead of a
    # traceback. Set DFHACK_SRC (or pass --enum-h) on a dev machine to actually run the sync check.
    if not os.path.exists(args.enum_h):
        print("SKIP: DFHack announcement_type.h not found (set DFHACK_SRC or pass --enum-h to "
              "verify the generated tables against the raws). Looked for: %s" % args.enum_h)
        return 0

    rows, n_raws = build(args.df_root, args.enum_h)
    targets = {
        os.path.join(ROOT, "src", "announce_taxonomy.gen.h"): emit_cpp(rows, n_raws),
        os.path.join(ROOT, "web", "js", "dwf-announce-taxonomy.js"): emit_js(rows, n_raws),
    }

    drift = False
    for path, want in targets.items():
        have = None
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8", newline="") as fh:
                have = fh.read()
        if args.check:
            if have != want:
                print("DRIFT: %s" % os.path.relpath(path, ROOT))
                drift = True
        elif have != want:
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(want)
            print("wrote %s" % os.path.relpath(path, ROOT))
        else:
            print("up to date %s" % os.path.relpath(path, ROOT))

    counts = {}
    for _v, _n, sect, _f in rows:
        counts[sect] = counts.get(sect, 0) + 1
    print("tokens=%d  " % len(rows) + "  ".join("%s=%d" % (k, counts.get(k, 0)) for k in SECTIONS))
    if args.check and drift:
        print("FAIL: generated files are stale -- run gen_announce_taxonomy.py")
        return 1
    if args.check:
        print("OK: generated files match the raws")
    return 0


if __name__ == "__main__":
    sys.exit(main())
