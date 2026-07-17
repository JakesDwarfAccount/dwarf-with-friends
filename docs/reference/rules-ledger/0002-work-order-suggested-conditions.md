# 0002 — Work-order suggested item conditions

**Status:** `binary-read` + `corpus-confirmed` (native row and add-control behavior live-verified)
**Date read:** 2026-07-15

## Rule

When native DF opens a work order's condition editor, it derives suggested item conditions
from the order's generated products and required inputs. The threshold is fixed at **10**;
it does not come from the order quantity:

- every generated product filter yields **Amount available is less than 10**;
- every required-input filter yields **Amount available is greater than 10**.

Each suggestion copies the complete native item filter: item type/subtype, material,
`flags1`–`flags5`, reaction class and material-reaction-product class, ore, minimum
dimension, contained-reagent indexes and reaction id, tool use, and dye color.

For product filters that can be containers, DF inserts an additional **empty** product
suggestion before the ordinary product suggestion, unless the product filter already
requires `job_item_flags1.empty` (`0x400`). The fixed container-type set is:

`FLASK`, `GOBLET`, `CAGE`, `BARREL`, `BUCKET`, `ANIMALTRAP`, `COFFIN`, `BOX`, `BAG`,
`BIN`, `ARMORSTAND`, `WEAPONRACK`, `CABINET`, `BACKPACK`, and `QUIVER`.

`TOOL` products get the same extra empty suggestion only when that tool subtype's
`container_capacity` is greater than zero.

The suggestion list keeps every candidate's text row visible. When the order already has an item
condition whose scalar and string filter fields match, DF suppresses only that row's **add**
control. This equality check intentionally ignores
`compare_type`, `compare_val`, **and the `contains` vector**. The producer still copies
`contains` into each suggestion; it is only omitted from the renderer's already-present
test. Therefore an existing condition can remove the add control even when its operator,
threshold, or contained-reagent indexes differ, while the descriptive row remains on screen.

## Binary evidence

- Exe: `Dwarf Fortress.exe`, DF **v0.53.15 win64 STEAM**
  - SHA-256 `683C721D1261E77FF862A2E01DFE3FF93D107AB7B1C92B5A3B6F313CCC8FC284`
  - PE COFF timestamp `0x6A268FCD` (matches the DFHack symbols for this build)
- Suggestion producer: **`0x140a9d510`**. It is called when the work-order input handler
  opens the condition editor. It builds product suggestions with comparison type 3
  (`LessThan`) and input suggestions with comparison type 2 (`GreaterThan`), both with
  value 10, including the container/empty branch above.
- Work-order input handler: **`0x1403c2190`**. Its editor-opening path selects the order,
  refreshes condition satisfaction, then invokes the suggestion producer.
- Condition editor renderer: **`0x14038c3c0`** (found from the `Suggested conditions`
  string). It renders every candidate's two text lines before the equality check, then draws the
  4-by-3 `WORK_ORDERS_ADD_SUGGESTED_CONDITION` control only when no existing condition matches.
- Structure and enum names were corroborated against the matching DFHack definitions for
  `manager_order`, `manager_order_condition_item`, `logic_condition_type`, `item_type`,
  `job_item_flags1.empty`, and `itemdef_toolst.container_capacity`.
- Reproduce in the private decompilation workspace: locate `Suggested conditions` with `oq.py who`, decompile the
  renderer, follow its work-order state back through the dwarf-mode input dispatch, and
  decompile the three function addresses above. Decompiled output remains private there.

## Corpus evidence

Recorder session SHA-256
`D5E7D59A6BD424294943E49EDF2BF5CDAC43283EF5396CBD38E1E0D50B53D387`
contains three pinned native frames for order 9. All three show the predicted empty-barrel,
barrel, and log rows in the correct order. The empty-barrel suggestion matches an existing
condition and remains visible at rows 57–58, correcting the earlier interpretation that the
whole row was hidden.

Recorder-v2 session SHA-256
`ED2240F6B4D72E6F01F5BD7DECC17628FF77419D2D5FC2056132A5E7D1452923`
provides the self-contained cell-level proof that v1 could not. In the pinned native frame, the
matching empty-barrel suggestion remains visible but has no add control. The ordinary-barrel and
log suggestions each carry the same 4-by-3 control in `gps.texpos_lower`. The pinned reducer
reproduced all three suggestion identities and rows, then matched expected control availability
to the captured cells with eight passing observations, zero failures, and two unrelated Rule 0003
inconclusives. Remaining Rule 0002 coverage:

- a non-container tool and a positive-capacity tool;
- otherwise identical existing filters with different operators, values, and `contains` indexes;
- an otherwise identical existing filter with deliberately changed operator, value, and
  `contains` indexes in a live frame, paired with scalar/string-field mismatch counterexamples.

## Predicate

`predicates/0002-work-order-suggestions.mjs` — given normalized product filters, required
input filters, and existing item conditions, predicts the visible native suggestion list and
whether each row's add control is available.

## Implementation consequence

DFHack 53.15-r1 does not expose a lossless offscreen manager-order product-filter API.
`workflow.listJobOutputs()` drops native condition fields and differs from the manager-order
generator for several job families, so it must not supply addable suggestions. The product now
fails closed instead of special-casing an observed barrel order. An exact implementation requires
a same-order render-thread snapshot of DF's open native condition editor, an opaque server token,
and a server-side deep copy of the complete filter after revalidation. The browser must never
reconstruct that filter from the displayed sentence or a reduced field subset.
