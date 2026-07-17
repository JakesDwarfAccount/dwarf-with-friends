# 0004 - Engraved-floor native wall wording

**Status:** `shipped` (`binary-read` + `corpus-confirmed`)
**Date read:** 2026-07-15

## Rule

For the ordinary engraving view sheet's simple sentence, native DF can describe an
engraved floor as being engraved "on the wall." The engraving's floor flag remains the
physical truth: routing, graphics, and structured output must still identify the surface
as `floor`. Only the native prose surface word is `wall`.

Named-rendition descriptions do not contain this surface phrase and are unchanged.

## Binary evidence

- Exe: `Dwarf Fortress.exe`, DF **v0.53.15 win64 STEAM**
  - SHA-256 `683C721D1261E77FF862A2E01DFE3FF93D107AB7B1C92B5A3B6F313CCC8FC284`
  - PE COFF timestamp `0x6A268FCD`
- Artwork formatter: **`0x141447f70`**. Its engraved-surface wording is selected from
  formatter context rather than by reading the engraving record's floor flag directly.
  The ordinary view-sheet context captured below selected the wall wording for a record
  whose floor flag was true.
- Reproduce in the private decompilation workspace: locate the `Engraved` fragment, follow its references, and
  inspect the formatter at `0x141447f70`. Decompiled output remains private there.

## Corpus evidence

- Rich recording `dwf-rec-20260715-121557-311-rich.jsonl`, records on JSONL lines
  197-430 (`t_ms` 1784132295322-1784132411822), focus
  `dwarfmode/ViewSheets/ENGRAVING`.
- The native screen for tile `(84,114,176)` visibly says "Engraved on the wall" while a
  direct read of that same engraving reports the floor flag set and every wall-direction
  flag clear.
- The user independently confirmed the same wording across many engraved floors.

## Predicate

`predicates/0004-engraved-floor-native-wall-wording.mjs` - given the physical floor flag,
predicts both the structured `surface` and the independent surface word used by the native
simple engraving sentence.
