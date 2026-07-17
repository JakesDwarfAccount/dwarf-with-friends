# bake_unit.py feasibility report (W-E scout, 2026-07-07)

Offline compositor (`tools/ws2/bake_unit.py`) evaluating DF's PARSED graphics-layer
conditions (`dump_layerset.lua` output, adult DEFAULT set, 893 layers) against live-read
unit appearance (`scout_units.lua` output), blitting from the session atlas, palette-
remapping — compared pixel-for-pixel against DF's OWN per-unit runtime composites
(`unit.texpos` → atlas). Two real units from the fort.

## Pixel match (final: `--group-match last`, face_idx 2)

| Unit | Cell | %exact RGBA | %exact (non-transparent) | MAE (opaque) |
|---|---|---|---|---|
| 3658 "Thob" (FEMALE Peasant) | 166733 | 98.44% | **97.16%** | 0.438 |
| 5505 "Sarvesh" (MALE Miner, iron pick) | 166830 | 97.95% | **95.96%** | 1.908 |
| 5505 overhang cell | 166831 | 100% | 100% | 0.0 (blank, correctly) |

Residuals = 16–21 pixels each of ±1-unit alpha-blend rounding — **zero layer-selection
errors**; renders visually indistinguishable from DF's composite. Verdict: **the read
appearance fully determines the sprite** (with the one caveat in finding 7).

## Findings (feed the W-E spec)

1. **LAYER_GROUP resolution is LAST-match-wins** (profession-colored vs item-colored
   clothing candidates): first-match scored 57.9%/63.0%; last-match 97.2%/96.0%.
2. `flags.ghost`/`flags.child` are explicit vetoes for living adults (ghost variants carry
   no other disqualifier).
3. `tl_condition` entries carry their OWN caste gates (separate from layer `req_caste`) —
   required to keep MALE-only beards off FEMALE units.
4. Tissue length **-30000 = "grown out fully / never styled"**, not bald — satisfies
   open-ended `[200,-1]` LONG bands (Thob renders long unkempt hair).
5. 2-cell weapon layers can draw entirely within the main cell (iron pick: second
   allocated unit slot stayed blank). True cross-tile overhang unverified — pin with a
   pike/halberd fixture in WE-8.
6. Face variant (`CONDITION_RANDOM_PART_INDEX HEAD n:4`): idx 2 matched BOTH units;
   `genes.appearance[i] % 4 == 2` holds for i ∈ {2,15,21} for both — plausible gene source,
   **unresolved with 2 data points** (irrelevant to the shipping export path).
7. **`USE_STANDARD_PALETTE_FROM_ITEM` is NOT a lookup into the 117-row CLOTHES table** for
   multi-tone art: no single row reproduces the empirically-derived per-color LUT — DF
   appears to apply a continuous transform from the item material/dye color. Reproducible
   empirically per unit, **not yet predictable a priori** — the one genuine gap in the
   offline predictor. (Does NOT affect the shipping path, which exports DF's own pixels.)
8. MOUSTACHE/SIDEBURNS tissue categories have **no layers at all** in the dwarf DEFAULT
   set — moustache appearance data is unused by map sprites (DF engine limitation).

Outputs: `tools/ws2/sprites/unit_{3658,5505}_cell*.png`. Diff images were reviewed but not committed. Re-run after any DF update:
`bake_unit.py --unit 5505 --target 166830 --group-match last` (see file header).
