# WS2 T0 gate — how to run the dump + offline reconstruct (in a controlled window)

This is the empirical feasibility GATE for tile/sprite streaming. It is **not** to be run against
a live-played fort casually — schedule a controlled window. The dump is read-only (it copies memory
and writes files under the DF install CWD); it does not modify the save.

## 0. Prereqs
- The plugin must be built (`dwf.plug.dll`) and deployed to the live install. Building only
  writes to the build tree; deploying is a separate, deliberate step (stop DF first).
- A running DF + fort with the dwf stream server started (so the render thread + camera helpers
  are live).
- Load a save whose current view contains, in one screen: standing water, flowing water or magma,
  a blood/contaminant spatter, a ramp, a designated dig tile, a creature, an indoor dark tile, an
  outdoor sunlit tile, and a stairwell / open shaft down at least one z-level. This maximises the
  flag-array coverage the gate can measure.

## 1. Dump one live frame (host machine, DF running)
```
cd "<your DF install>\hack"        # W1: every tool below resolves this itself (--df-root / $DWF_DF_ROOT / autodetect)
./dfhack-run.exe capture-tiledump
```
This writes `dwf_tiledump/` under the DF install root:
- `frame.bin`      — 26 tile-layer arrays + header (magic `DFTD`, WIRE_VERSION 1, dims, origin)
- `atlas/tex_<i>.rgba` + `atlas/index.json` — every non-null texpos surface, RGBA8888 (byte order R,G,B,A)
- `ground_truth.png` — the JPEG-path render of the same tick, as PNG

## 2. Copy the dump out to the repo (never edit the live install)
Copy the whole `dwf_tiledump/` folder to:
```
<REPO>\tools\ws2\sample\
```
so `tools\ws2\sample\frame.bin`, `tools\ws2\sample\atlas\...`, `tools\ws2\sample\ground_truth.png` exist.

## 3. Reconstruct offline + diff
```
python tools/ws2/reconstruct.py tools/ws2/sample
```
Outputs into the sample dir:
- `recon_texpos.png` — texpos-only reconstruction (flags ignored)
- `recon_flags.png`  — texpos + flags (identical to texpos-only until `apply_flags` is filled in)
- `diff_texpos.png` / `diff_flags.png` — heatmaps vs `ground_truth.png` (red = mismatch, blue = match)
- stdout: per-flag `nonzero tiles` + `OR-of-bits`, and the detected tile size + grid.

## 4. Read the gate (per the plan, Task 0 Steps 8-9)
- Open `recon_texpos.png` beside `ground_truth.png`; inspect `diff_texpos.png`.
- **Mismatch confined to liquid/magma/ramp/shadow/spatter tiles** → expected, bounded. For each of
  the 5 flag arrays, correlate the printed `OR-of-bits` + tile positions against the JPEG (e.g. a
  known-magma tile's `liquid_flag` vs a known-water tile's), fill `apply_flags` incrementally,
  re-run, confirm `diff_flags.png` closes the gap. Record per flag: **cosmetic** vs **load-bearing**
  + the bit->effect map you proved.
- **Mismatch on plain floor/wall/building tiles too** → layer order or draw order is WRONG. **STOP.**
  Do not proceed to T1.
- Also check: the stairwell see-down region — does it reconstruct from texpos alone, or need the
  synthetic falloff (the plugin's own heuristic, `sdl_capture.cpp:1632-1678`)?
- Also check: max texpos in the dump vs `atlas/index.json` — confirm viewport texpos values stay
  inside DF's static atlas range (no collision with DFHack's reserved 10k dynamic range).

## 5. Deliverable
Record: texpos-only PASS/FAIL, a per-flag table (cosmetic | load-bearing + bits), the see-down
finding, the texpos-range finding, and a GO/STOP recommendation for T1-T6.

## Notes / deviations recorded during Task 0 implementation
- **Crash fix (post first live run):** the first version read the 26 `screentexpos_*` layer
  arrays cold, before DF had rendered the current window, so the pointers were null/stale ->
  SIGSEGV in the render-thread callback (crash_2026-07-04-15-31-19). The dump now runs through
  the live stream's own guarded capture path (`capture_frame_with_tile_layers` ->
  `capture_shifted`: live-fort gate + window setup + ViewportZoomGuard +
  `render_map_for_current_window`) and copies the arrays only AFTER the map is rendered. Every
  layer pointer is null-checked and every copy is SEH-guarded; a null/faulting layer is written
  as zeros (never faults). The atlas dump now runs as its own unconditional render-thread hop so
  a frame issue can't suppress it (that was why run 1's `atlas/` was empty).
- The atlas dump normalises surfaces via DFHack's `DFSDL` wrapper module
  (`DFSDL_AllocFormat`/`DFSDL_ConvertSurface`/`DFSDL_FreeSurface`), not direct SDL calls, because
  the plugin does not link SDL at build time. Output format/byte order is unchanged (RGBA8888,
  bytes R,G,B,A on little-endian), so `reconstruct.py` reads it as PIL "RGBA" verbatim.
- `frame.bin` header origin_z is a placeholder `0`; the reconstructor only uses dim_x/dim_y.
