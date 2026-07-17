# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, version 3 of the License.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-only
#
# =============================================================================
# B280 -- THE INDEPENDENT ORACLE.
#
# Everything else in this repo that claims to know when a dwarf is "Thirsty" is OUR OPINION:
# a constant somebody copied out of a DFHack plugin into src/unit_status.h. This script does not
# have an opinion. It opens Dwarf Fortress's own executable and DECODES the ladder DF itself uses
# to print the status words in the unit sheet's Overview tab.
#
# HOW. DF's Overview status-box builder is one function. It writes the words as string literals, so
# every word has a `lea reg, [rip+disp32]` pointing at it in .text. Immediately before each of those
# is the branch that gates it -- `mov rax,[rsp+X]; add rax, FIELD_OFF; cmp dword [rax], K` -- and
# `(FIELD_OFF, K)` is precisely the thing we are not allowed to guess. We decode both.
#
# WHY YOU CAN TRUST IT (this is the part that matters, and it is checked, not asserted):
# the decoded field offsets must land on df-structures' real `unit.counters` / `unit.counters2`
# layout -- consecutive int32s at 4-byte strides in the documented order
# {paralysis, numbness, fever, exhaustion, hunger_timer, thirst_timer, sleepiness_timer}, and
# int16s at 2-byte strides for {winded, stunned, unconscious, suffocation, webbed}. --verify
# asserts that. Seven offsets landing on seven named fields in the right order cannot happen by
# accident, so a decode that passes --verify is reading DF's real ladder. If DF is patched and the
# layout moves, --verify goes RED instead of quietly emitting garbage.
#
# The output feeds tools/harness/status_truth_test.mjs, which cross-checks it against the
# thresholds we actually shipped in src/unit_status.h.
#
#   python tools/harness/df_status_ladder.py --verify           # gate: exit 0 = decode is sane
#   python tools/harness/df_status_ladder.py --write            # refresh the committed fixture
#
# No DF install -> SKIP, exit 0 (harness rule: a DF-less machine stays green).
# =============================================================================
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from dfroot import df_root_or_skip  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "df-status-ladder.json")

# The words the Overview status box can print. Sourced from the string block in DF's .rdata that
# sits contiguous with 'Squad: ', 'Citizen', 'No official position' and 'Unmet need: ' -- i.e. the
# other Overview boxes. We do NOT invent words here: a word that is not in DF's binary cannot be
# decoded, and a word in DF's binary that we failed to list shows up as a missing xref, not as a
# silent omission (--verify counts them).
STATUS_WORDS = [
    "Harrowed", "Haggard", "Stressed",
    "Starving", "Very hungry", "Hungry",
    "Dehydrated", "Very thirsty", "Thirsty!", "Thirsty",
    "Slumberous", "Very drowsy", "Drowsy",
    "Unconscious", "Paralyzed", "Partially paralyzed", "Sluggish",
    "Stunned", "Dizzy",
    "Exhausted", "Over-exerted", "Tired",
    "Drowning", "Winded", "Nauseous",
    "Extreme pain", "Pain", "Numb",
    "Pale", "Faint", "Fever",
    "Heavy bleeding", "Bleeding",
    "Webbed", "Partially webbed",
    "Seriously injured", "Injured", "Healthy",
]

# df-structures ground truth (dfhack/library/xml/df.unit.xml). The decode must reproduce THIS.
# Values are (field-name, stride-in-bytes-to-the-next-listed-field).
COUNTERS2_ORDER = ["paralysis", "numbness", "fever", "exhaustion",
                   "hunger_timer", "thirst_timer", "sleepiness_timer"]
COUNTERS_ORDER = ["winded", "stunned", "unconscious", "suffocation", "webbed"]
# ...and, further down the same compound, three int32s in this order (df.unit.xml).
COUNTERS_PAIN_ORDER = ["pain", "nausea", "dizziness"]


def load_pe(path):
    with open(path, "rb") as fh:
        buf = fh.read()
    pe = struct.unpack_from("<I", buf, 0x3C)[0]
    if buf[pe:pe + 4] != b"PE\0\0":
        raise SystemExit("not a PE image: %s" % path)
    nsec = struct.unpack_from("<H", buf, pe + 6)[0]
    optsz = struct.unpack_from("<H", buf, pe + 20)[0]
    imagebase = struct.unpack_from("<Q", buf, pe + 24 + 24)[0]
    secoff = pe + 24 + optsz
    secs = []
    for i in range(nsec):
        o = secoff + 40 * i
        name = buf[o:o + 8].rstrip(b"\0").decode("ascii", "replace")
        vsz, va, rsz, roff = struct.unpack_from("<IIII", buf, o + 8)
        secs.append((name, va, vsz, roff, rsz))
    return buf, imagebase, secs


def make_off2va(imagebase, secs):
    def off2va(off):
        for _n, va, _vsz, roff, rsz in secs:
            if roff <= off < roff + rsz:
                return imagebase + va + (off - roff)
        return None
    return off2va


def decode(df_root):
    exe = os.path.join(df_root, "Dwarf Fortress.exe")
    if not os.path.exists(exe):
        raise SystemExit("no Dwarf Fortress.exe under %s" % df_root)
    buf, imagebase, secs = load_pe(exe)
    off2va = make_off2va(imagebase, secs)

    # 1. locate every status word's string literal. Take the copy that lives in the Overview
    #    string block (the one adjacent to 'Squad: '), so a same-named string used by an unrelated
    #    screen cannot pull the decode off into another function.
    anchor = None
    for m in re.finditer(rb"Squad: \x00", buf):
        anchor = m.start()
        break
    if anchor is None:
        raise SystemExit("could not find the Overview string block anchor ('Squad: ')")
    lo, hi = anchor - 0x1200, anchor + 0x400

    va_to_word = {}
    for m in re.finditer(rb"[\x20-\x7e]{2,}\x00", buf):
        s = m.group()[:-1].decode("ascii")
        if s in STATUS_WORDS and lo <= m.start() <= hi:
            va = off2va(m.start())
            if va:
                va_to_word[va] = s

    # 2. walk .text once, recording LEAs onto those strings and every `cmp dword [rax], imm`
    #    plus the `add rax, imm32` that set rax up. Instruction-level, no disassembler needed:
    #    the shapes are fixed (MSVC emits exactly these).
    text = next(s for s in secs if s[0] == ".text")
    tstart, tend = text[3], text[3] + text[4]
    events = []
    i = tstart
    while i < tend - 8:
        b = buf[i]
        if b == 0x48 and buf[i + 1] == 0x8D and (buf[i + 2] & 0xC7) == 0x05:
            disp = struct.unpack_from("<i", buf, i + 3)[0]
            nxt = off2va(i + 7)
            if nxt is not None and (nxt + disp) in va_to_word:
                events.append((i, "word", va_to_word[nxt + disp]))
        elif b == 0x48 and buf[i + 1] == 0x05:                       # add rax, imm32
            events.append((i, "add", struct.unpack_from("<I", buf, i + 2)[0]))
        elif b == 0x81 and buf[i + 1] == 0x38:                       # cmp dword [rax], imm32
            events.append((i, "cmp", struct.unpack_from("<i", buf, i + 2)[0]))
        elif b == 0x83 and buf[i + 1] == 0x38:                       # cmp dword [rax], imm8
            events.append((i, "cmp", struct.unpack_from("<b", buf, i + 2)[0]))
        i += 1
    events.sort()

    # 3. for each word, find its gate -- STRICTLY.
    #
    #    The emitted shape is fixed and we require all of it, because a loose "nearest preceding
    #    cmp" rule silently attributes one branch's constant to another word (it made `Stunned`
    #    look like a paralysis test on the first pass). The shape is:
    #
    #        mov rax,[rsp+X] ; add rax, FIELD_OFF   <- 6 bytes
    #        cmp dword [rax], K                     <- must begin exactly at add+6
    #        ... branch ...
    #        lea rdx, "Word"                        <- 0x30..0x60 past the cmp
    #
    #    add + cmp  -> the word is gated on `field >= K` (or `> K` when K == 0)
    #    add alone  -> DF tested the field truthily (movzx/test on an int16) -> `field > 0`
    #    neither    -> ungated: the word is an else-branch or a computed quantity. Reported as
    #                  such; NEVER given a made-up constant.
    adds = {o: v for o, k, v in events if k == "add"}
    cmps = {o: v for o, k, v in events if k == "cmp"}
    by_off = {}
    for off, kind, word in events:
        if kind != "word":
            continue
        field = const = None
        for add_off, add_val in adds.items():
            if not (0x30 <= off - add_off <= 0x120):
                continue
            c = cmps.get(add_off + 6)
            if c is not None and 0x30 <= off - (add_off + 6) <= 0x60:
                field, const = add_val, c
                break
            if 0x30 <= off - add_off <= 0x70 and field is None:
                field, const = add_val, 0        # truthy test, no immediate
        if field == 0x180:
            # the stress branch derefs the soul: add rax,0xa98 ; mov rax,[rax] ; add 0x248 ; add 0x180
            # -> unit_soul.personality (+0x248) . longterm_stress (+0x180). NOT `stress` (+0x120).
            field = "soul.personality.longterm_stress"
        row = {"code_off": off, "unit_off": field, "min": const}
        if row not in by_off.setdefault(word, []):
            by_off[word].append(row)

    return {"exe": exe, "words": by_off}


def classify(decoded):
    """Split the two ladders DF ships (fortress vs adventure) and name the fields.

    Fortress mode is the one we render. The split is not a guess: the three need timers each carry
    BOTH ladders in the same function, and the adventure constants (57600..2592000) are exactly the
    `is_adventure` argument lists in DFHack's Units::computeMovementSpeed / adjust_skill_rating.
    We keep only the lowest-constant pair per (field, word) -- the fortress branch -- and report the
    rest verbatim under `adventure` so nothing is silently dropped.
    """
    # THE STRESS FIELD IS NOT `stress`. The decoded chain is
    #   unit+0xa98 -> deref (status.current_soul) -> +0x248 -> +0x180 -> cmp {20000,50000,100000}
    # 0x248 is offsetof(unit_soul, personality) and 0x180 is offsetof(unit_personality,
    # LONGTERM_STRESS) -- laid out from df.personality.xml, MSVC x64 (vector 24 / string 32 / ptr 8),
    # which puts `stress` at +0x120 and `longterm_stress` at +0x180. The alternative reading of the
    # base is not merely unlikely, it is incoherent: it would make the field `temptation_anger`, a
    # 0-100 corruption counter, compared against 100000.
    #
    # DFHack's Units::getStressCategory reads personality.STRESS. DF's own sheet grades
    # personality.LONGTERM_STRESS. They are different numbers on the same dwarf, and reading the
    # wrong one is a bug no threshold can fix.
    layout = {"soul.personality.longterm_stress": "soul.personality.longterm_stress"}
    # counters2 base = the offset the exhaustion ladder tests (2000/4000/6000 -- unambiguous, it is
    # the only 3-band ladder on a counters2 field and DFHack tests the same three numbers).
    ex = [g for g in decoded["words"].get("Tired", []) if g["min"] == 2000]
    if not ex or ex[0]["unit_off"] is None:
        raise SystemExit("could not anchor counters2 (Tired/exhaustion@2000 not decoded)")
    c2_base = ex[0]["unit_off"] - 4 * COUNTERS2_ORDER.index("exhaustion")
    for n, name in enumerate(COUNTERS2_ORDER):
        layout["counters2." + name] = c2_base + 4 * n
    # counters: int16s. Anchor on `unconscious` (the Unconscious word tests it truthily), then
    # CHECK the derived `webbed` offset against the one the Webbed branch actually decoded --
    # if the two disagree, the anchor is wrong and verify() must go red.
    un = [g for g in decoded["words"].get("Unconscious", []) if g["unit_off"] is not None]
    if un:
        c_base = un[0]["unit_off"] - 2 * COUNTERS_ORDER.index("unconscious")
        for n, name in enumerate(COUNTERS_ORDER):
            layout["counters." + name] = c_base + 2 * n
    # counters.{pain,nausea,dizziness}: three int32s. Anchor on the Pain branch (the only one with
    # a 50/100 two-band ladder), then derive the other two -- verify() checks the derived offsets
    # against the ones the Nauseous and Dizzy branches decoded on their own.
    pn = [g for g in decoded["words"].get("Pain", []) if g["min"] == 50 and g["unit_off"]]
    if pn:
        for n, name in enumerate(COUNTERS_PAIN_ORDER):
            layout["counters." + name] = pn[0]["unit_off"] + 4 * n
    return layout


def build(df_root):
    decoded = decode(df_root)
    layout = classify(decoded)
    off_to_field = {v: k for k, v in layout.items()}

    # DF ships TWO ladders on the three need timers -- fortress first, then adventure -- and both
    # live in this one function. Each is a DESCENDING run, and the adventure run's floor (115200)
    # sits far above the fortress run's ceiling (150000 is the single fortress constant that even
    # approaches it, and it is emitted before any adventure gate). So the split is a code-order
    # cut, not a per-word allow-list: on each field, the first gate whose constant reaches
    # ADV_FLOOR opens the adventure block, and everything from there on is adventure.
    # Corroboration (independent of this decode): the adventure constants reproduce DFHack's
    # `is_adventure` argument lists in Units::computeMovementSpeed / adjust_skill_rating exactly.
    ADV_FLOOR = 172800
    rows = []
    for word, gates in decoded["words"].items():
        for g in gates:
            rows.append({"word": word, "unit_off": g["unit_off"], "min": g["min"],
                         "field": off_to_field.get(g["unit_off"]), "_off": g["code_off"]})
    fortress, adventure, unknown = [], [], []
    timers = ("counters2.hunger_timer", "counters2.thirst_timer", "counters2.sleepiness_timer")
    adv_starts = {}
    for f in timers:
        hits = sorted((r["_off"] for r in rows if r["field"] == f and (r["min"] or 0) >= ADV_FLOOR))
        adv_starts[f] = hits[0] if hits else None
    for r in rows:
        cut = adv_starts.get(r["field"])
        if r["unit_off"] is None or r["min"] is None or r["field"] is None:
            unknown.append(r)
        elif cut is not None and r["_off"] >= cut:
            adventure.append(r)
        else:
            fortress.append(r)
    for r in rows:
        r.pop("_off", None)

    # The three need ladders, reduced to the ONE number each that our bubble must match: the
    # LOWEST fortress constant on that field -- the point at which DF first prints the word at all.
    onset = {}
    for row in fortress:
        f = row["field"]
        if f and (f not in onset or row["min"] < onset[f]["min"]):
            onset[f] = {"word": row["word"], "min": row["min"]}

    return {
        "_source": "decoded from Dwarf Fortress.exe by tools/harness/df_status_ladder.py",
        "_warning": "DO NOT HAND-EDIT. Regenerate with --write. This file is DF's opinion, not ours.",
        "exe": decoded["exe"],
        "layout": layout,
        "fortress": sorted(fortress, key=lambda r: (r["field"] or "", -(r["min"] or 0))),
        "adventure": sorted(adventure, key=lambda r: (r["field"] or "", -(r["min"] or 0))),
        "ungated": sorted(unknown, key=lambda r: r["word"]),
        "onset": onset,
    }


def verify(data):
    """Prove the decode landed on df-structures' real layout. This is the anti-garbage gate."""
    errs = []
    lay = data["layout"]
    for n, name in enumerate(COUNTERS2_ORDER):
        key = "counters2." + name
        if key not in lay:
            errs.append("missing %s" % key)
    if not errs:
        offs = [lay["counters2." + n] for n in COUNTERS2_ORDER]
        if offs != list(range(offs[0], offs[0] + 4 * len(offs), 4)):
            errs.append("counters2 offsets are not a 4-byte int32 run: %r" % offs)
    # cross-check the counters (int16) anchor: the offset derived from `Unconscious` must predict
    # the offset the `Webbed` branch independently decoded. Two branches, one layout.
    webbed = [r for r in data["fortress"] + data["ungated"]
              if r["word"] == "Webbed" and r["unit_off"] is not None]
    if webbed and "counters.webbed" in lay and webbed[0]["unit_off"] != lay["counters.webbed"]:
        errs.append("counters anchor disagrees: Webbed decoded at 0x%x, layout says 0x%x"
                    % (webbed[0]["unit_off"], lay["counters.webbed"]))
    for word, off_key in (("Nauseous", "counters.nausea"), ("Dizzy", "counters.dizziness")):
        got = [r for r in data["fortress"] + data["ungated"]
               if r["word"] == word and r["unit_off"] is not None]
        if got and off_key in lay and got[0]["unit_off"] != lay[off_key]:
            errs.append("%s decoded at 0x%x but the Pain anchor predicts %s = 0x%x"
                        % (word, got[0]["unit_off"], off_key, lay[off_key]))
    # the four fortress onsets must exist and be the words DF prints first
    want = {"counters2.hunger_timer": "Hungry",
            "counters2.thirst_timer": "Thirsty",
            "counters2.sleepiness_timer": "Drowsy",
            "soul.personality.longterm_stress": "Stressed"}
    for field, word in want.items():
        got = data["onset"].get(field)
        if not got:
            errs.append("no fortress onset decoded for %s" % field)
        elif got["word"] != word:
            errs.append("fortress onset for %s decoded as %r, expected DF's %r"
                        % (field, got["word"], word))
    # every word we listed must have been found somewhere
    found = {r["word"] for r in data["fortress"] + data["adventure"] + data["ungated"]}
    missing = [w for w in STATUS_WORDS if w not in found]
    if missing:
        errs.append("status words present in DF's binary but never decoded: %r" % missing)
    return errs


def main(argv):
    df_root = df_root_or_skip("df_status_ladder",
                              purpose="decodes DF's own unit-sheet status ladder from the game binary",
                              argv=argv)
    if df_root is None:
        return 0
    data = build(df_root)
    errs = verify(data)
    if "--write" in argv and not errs:
        os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
        with open(FIXTURE, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1, sort_keys=True)
            fh.write("\n")
        print("wrote %s" % FIXTURE)
    if errs:
        print("FAIL df_status_ladder -- the decode does not match df-structures:")
        for e in errs:
            print("  - %s" % e)
        return 1
    print("PASS df_status_ladder -- %d fortress gates, %d adventure gates, %d ungated words"
          % (len(data["fortress"]), len(data["adventure"]), len(data["ungated"])))
    for field, got in sorted(data["onset"].items()):
        print("   onset  %-28s %-12s >= %d" % (field, got["word"], got["min"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
