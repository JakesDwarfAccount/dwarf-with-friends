# 0003 — Work-order condition status colors

**Status:** `binary-read` + false-state `corpus-captured`
**Date read:** 2026-07-15

## Rule

In a work order's condition editor, native DF renders the status of each item condition
from that condition's cached result for the next check:

- a true result is labeled **Satisfied for next check** in bright green on black;
- a false result is labeled **Not satisfied for next check** in bright red on black.

The native 8-color indexes are green `2`, red `4`, and black `0`; the brightness flag is
set in both branches. This is the status annotation at the right of an existing item
condition, not the separately colored operator, quantity, or item-description fragments.

## Binary evidence

- Exe: `Dwarf Fortress.exe`, DF **v0.53.15 win64 STEAM**
  - SHA-256 `683C721D1261E77FF862A2E01DFE3FF93D107AB7B1C92B5A3B6F313CCC8FC284`
  - PE COFF timestamp `0x6A268FCD` (matches the DFHack symbols for this build)
- Work-order condition renderer: **`0x14038c3c0`**. It tests the selected item condition's
  cached satisfaction bit, selects the matching label, and writes the corresponding
  foreground/background/brightness state immediately before drawing it.
- The satisfied branch is centered around **`0x140390a03`** and selects native foreground
  index `2`; the unsatisfied branch is centered around **`0x140390a57`** and selects native
  foreground index `4`. Both select background `0` and bright text.
- The color field interpretation was corroborated against the matching DFHack definitions
  for `graphic.screenf`, `graphic.screenb`, `graphic.screenbright`, and `curses_color`.
- Reproduce in the private decompilation workspace: locate the two exact status labels with `oq.py str`, inspect
  their references with `OracleRefs.java`, decompile `0x14038c3c0`, then inspect bounded
  windows at the two branch addresses with `OracleDisasm.java`. Decompiled and disassembled
  output remains private there.

## Corpus evidence

Recorder session SHA-256
`D5E7D59A6BD424294943E49EDF2BF5CDAC43283EF5396CBD38E1E0D50B53D387`
contains three pinned frames of the same false-state condition. The composed native planes show
the exact **Not satisfied for next check** text in bright foreground index `4` on background `0`,
matching the binary read.

Corpus confirmation is still incomplete because the same condition has not yet been captured
after its cached result changes to true. That paired frame must show the exact satisfied label and
bright foreground index `2` before the whole rule is promoted.

## Predicate

`predicates/0003-work-order-condition-status-colors.mjs` — given the cached satisfaction
boolean for an item condition, predicts the native status label and text attributes.
