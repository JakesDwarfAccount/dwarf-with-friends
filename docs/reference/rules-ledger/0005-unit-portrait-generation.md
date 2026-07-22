# 0005 — How Steam DF creates a unit's 96×96 portrait (`unit->portrait_texpos`)

**Status:** binary-read (2026-07-20), live-confirm pending the portrait canary.

## Rule

1. `unit.portrait_texpos` uses **0 as its unset sentinel** (not −1). The unit constructor zeroes
   it, and every display site tests `== 0`.
2. Every native surface that shows a portrait (unit view sheet, announcement popups, etc.) first
   runs the lazy gate: *if `portrait_texpos == 0` or `flags4.PORTRAIT_MUST_BE_REFRESHED` is set,
   call the portrait generator for that unit, then draw whatever `portrait_texpos` now holds.*
3. The portrait generator is a **self-contained one-argument routine** (`unit*` in, nothing out).
   It selects the unit's race/caste creature-graphics entry whose portrait capability flag is set
   (the raws `PORTRAIT` graphics), derives profession/ghost/adventurer context from the unit
   itself, and hands off to the bust compositor.
4. The compositor composes the portrait into a **new 32-bit SDL surface registered with DF's
   global texture handler** (reusing a free slot or growing the raws vector; the returned index
   becomes `portrait_texpos`). It also refreshes the unit's map-sprite/sheet-icon textures when
   they are missing or refresh-flagged, and invalidates the renderer's cached tiles for replaced
   indices via the renderer's `clean_cached_tile` virtual.
5. The generator **never touches `view_sheets`, the interface grid (`gps`), any viewscreen, or
   any SDL render target.** It is pure texture-side work, executed on the render thread by DF's
   own drawing code.
6. If the creature has no portrait-capable graphics entry (or generated portraits are disabled in
   vanilla settings), the generator returns without setting `portrait_texpos`; it stays 0.
7. `flags4` bit 9 (0x200) is `ANY_TEXTURE_MUST_BE_REFRESHED` (sprite regeneration); bit 14
   (0x4000) is `PORTRAIT_MUST_BE_REFRESHED`.

## Binary evidence

- Binary: `Dwarf Fortress.exe`,
  sha256 `683c721d1261e77ff862a2e01dfe3ff93d107ab7b1c92b5a3b6f313ccc8fc284`, 26,457,088 bytes,
  DF 53.15 Steam build (DFHack 53.15-r1/r2 symbols match, vtable set 0x141625888 for
  `widgets::unit_portrait`).
- Portrait generator wrapper: EA `0x1401b9610` (RVA `0x1b9610`).
- Bust compositor: EA `0x14071c610` (RVA `0x71c610`); writes `unit+0x142C` (portrait_texpos,
  offset confirmed live via DFHack `_fields`).
- Display-site gates observed in six functions (e.g. EA `0x14026d310`, `0x1408712f0`,
  `0x1408d7ae0`): compare `unit+0x142C` to 0 / test `flags4 & 0x4000`, call the wrapper, then
  draw the field's value.
- `widgets::unit_portrait::render` (EA `0x1414196a0`) is the **unit-list row icon** widget: it
  draws the race/caste map sprite or an ASCII glyph and never generates or reads
  `portrait_texpos` — which is why the earlier widget-driven attempt could only ever recover
  32×32 sprites.

## Consumed by

`src/unit_portrait.cpp` (`PORTRAIT-NATIVE-DIRECT rva=1b9610`): exe-pinned direct call of the
wrapper on the render thread, gated by 32-byte prologue signatures at both RVAs, SEH-wrapped,
fault-latched. `src/portrait_sweep.cpp` paces it.
