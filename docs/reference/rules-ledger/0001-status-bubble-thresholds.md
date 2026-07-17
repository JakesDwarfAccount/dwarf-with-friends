# 0001 — Status bubble thresholds and mode-specific selection

**Status:** graphics thresholds/priority `binary-read`; text-mode cadence `binary-read`
**Date read:** 2026-07-15

## Rule

DF has two different render routes for these status indicators. They must not be combined into one
visibility rule.

The normal Steam **graphics route** calls the graphics renderer at `0x140e94ac0`. For each unit, it
calls the selector at `0x1402685d0` and writes the selected `UNIT_STATUS` row through
`0x140ad93a0`. After higher-priority status groups, the need checks are:

| priority | bubble  | condition (unit field)               | threshold |
|----------|---------|--------------------------------------|-----------|
| 1        | Thirsty | `counters2.thirst_timer` > 24999     | ≥ 25000   |
| 2        | Hungry  | `counters2.hunger_timer` > 49999     | ≥ 50000   |
| 3        | Drowsy  | `counters2.sleepiness_timer` > 57599 | ≥ 57600   |

These graphics-mode need checks have **no clock window**. The selector does call
`GetTickCount()`, but that clock controls a separate seven-second group for projectile, grounded,
webbed, and climbing indicators. It does not gate Hungry, Thirsty, or Drowsy.

The **non-graphics/text route** calls the older chooser at `0x140e89460`. That function tests the
same three thresholds and adds separate 200-millisecond windows of a shared 1000-millisecond clock:

| bubble  | threshold | text chooser branch (`GetTickCount() % 1000`) |
|---------|-----------|------------------------------------------------|
| Hungry  | ≥ 50000   | [0, 200)                       |
| Drowsy  | ≥ 57600   | [300, 500)                     |
| Thirsty | ≥ 25000   | [500, 700)                     |

The wrapper at `0x140e949e0` makes the route split explicit: its graphics branch calls
`0x140e94ac0`; only its text branch calls `0x140e89460`. Therefore, the text windows must never be
used to suppress bubbles reconstructed from the normal graphics viewport. The thresholds
independently re-derive the values already used by `src/unit_status.h` (B280):
50000 / 25000 / 57600.

The graphics renderer also arbitrates multiple per-cell competitors. An eligible unit can therefore
be absent because another unit or effect won the cell. Corpus absence is accepted as threshold
evidence only when the recorder explicitly says the unit passed visibility, no higher-priority
indicator was selected, **and** that unit was admitted by the cell competitor arbitration. The
current control field is the binary `cell_competitor_admitted`; a missing value is unknown, not
false. A rendered hit remains positive evidence without needing absence controls.

Related observations from the text-mode chooser, **not yet promoted to rules** (field
identities not yet verified against df-structures offsets):

- A stress-type bubble is keyed on a unit-soul field at soul-offset `0x368` exceeding
  **9999** (not 20000), on a 600-tick cycle with a [0, 200) window.
- A distraction-type indicator is keyed on a focus computation over `soul + 0x248`
  compared against **80** (0x50), on a 1200-tick cycle with a [0, 500) window.
- Several other indicators in the ladder blink on a 500-tick cycle with [0, 100) windows.

## Binary evidence

- Exe: `Dwarf Fortress.exe`, DF **v0.53.15 win64 STEAM**
  - SHA-256 `683C721D1261E77FF862A2E01DFE3FF93D107AB7B1C92B5A3B6F313CCC8FC284`
  - PE COFF timestamp `0x6A268FCD` (== DFHack symbols `binary-timestamp`; symbols provably
    match this build)
- Text-mode chooser: **`0x140e89460`** (contains all four scanned threshold constants;
  the per-bubble compares read the unit fields at `+0x988` hunger / `+0x98c` thirst /
  `+0x990` sleepiness — three consecutive int32s in exactly the order `counters2`
  declares them, corroborating the field attribution).
- Route wrapper: **`0x140e949e0`**. It branches to graphics renderer **`0x140e94ac0`** or,
  only in non-graphics mode, to the chooser above.
- Graphics need selector: **`0x1402685d0`**; graphics row writer: **`0x140ad93a0`**.
- How found: label-string xref came up empty (labels are reached indirectly), so the
  fallback scan from `notes/spike-target.md` was used — an instruction-scalar sweep for
  the known constants. The apparent second all-constant match at `0x14113db20` was a false
  positive: the values occur as stack displacements, not status comparisons. It is not evidence
  of a second monolithic status renderer.
- Reproduce: in the private decompilation workspace, `scripts/run_ghidra_query.ps1 OracleHunt.java
  0x1416ca62c` (see that repo's README; decompiled output stays there, never here).

## Corpus evidence

Recorder session SHA-256
`689D6357C7C6480168F9FCB4DD470658FF082D40707CF8DCFD5591FB6458B7DA`
contains 78 pinned rich records from a native tavern view. The reducer conservatively associated
25 Hungry cells with one unit at `hunger_timer=65031` and 20 Thirsty cells with one unit at
`thirst_timer=25200`; both demonstrate graphics-mode visibility above the binary-read thresholds.

Those cells appeared at many phases outside the **text-mode** windows—for example Hungry at 343,
546, and 843, and Thirsty at 46, 234, 343, 734, and 843. That is expected in the graphics route and
is not evidence of viewport retention or a cadence contradiction.

Recorder-v2 session SHA-256
`68624D7C7A6AF780402F646180A95629D02E8F9B02A03403A1115C99A7AB34AC`
independently reproduces the same result with the complete v2 plane contract and deployed DLL
`A1FBFF1121FEB1CC4388034A080B73E8A9709ED832A47848D620F0AA4E24E3B8`. Across 89 records, the reducer
conservatively associated 23 Hungry cells with the above-threshold unit; 18 were outside the
text-mode chooser window. This independently supports the graphics/text route correction. Neither
live corpus brackets the exact timer cutoffs; exact thresholds remain pinned by the binary read.

## Predicate

`predicates/0001-status-thresholds.mjs` keeps three operations separate:

- `thresholdEligible(...)` tests the three timer cutoffs without choosing a renderer.
- `graphicsNeedSelection(...)` applies the graphics need priority, with no clock window.
- `textModeChooserSelection(...)` models only the non-graphics chooser windows.

The older `eligible` and `chooserSelection` export names remain compatibility aliases for the first
and third operations respectively; the alias does not make the text chooser a graphics predicate.
