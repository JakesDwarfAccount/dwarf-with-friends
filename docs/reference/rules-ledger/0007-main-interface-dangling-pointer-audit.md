# 0007 - `main_interface` dangling building-pointer audit

**Status:** `binary-read` for the renderer call and selected consumers; structural pointer audit
complete; the historical July 16 dump-to-field attribution is unverified because that dump is no
longer available.
**Date read:** 2026-07-21

## Rule

DFHack's immediate `Buildings::deconstruct` deletes a building after clearing the pre-v50
`world.selected_building` and `ui_look_list` references. It does not clear raw building pointers
owned by `game.main_interface`. Any plugin path that can immediately free a building must clear
or close matching native-interface state before the delete.

Closing an open dependent view is required when that view assumes another cache remains non-null;
merely nulling the cache can replace a use-after-free with a null dereference.

## Binary evidence and limitation

- Binary: `Dwarf Fortress.exe`, DF 53.15 Steam
  - SHA-256 `683C721D1261E77FF862A2E01DFE3FF93D107AB7B1C92B5A3B6F313CCC8FC284`
  - PE timestamp `0x6A268FCD`
  - size 26,457,088 bytes; image base `0x140000000`
- At `0x1403e4bb2`, the interface renderer selects virtual slot offset `0x188`, calls it on a
  building object, then draws the returned name. The matching generated `building.h` identifies
  slot 49 (`0x188 / 8`) as `building::getName(std::string*)`.
- In the location-selector renderer `0x1403b7cf0`, address `0x1403b9bc1` reads the selected zone's
  field at `+0x118` without first checking the selected-zone pointer. This confirms that closing
  the dependent location selector is necessary when `civzone.cur_bld` is cleared.
- `interface_button_buildingst` press handlers `0x1408c0d20`, `0x1408c0c40`, and `0x1408c2200`
  load the button's `building*` and invoke a building virtual method. The large building-interface
  renderer `0x1408d7ae0` was also read; no equivalent render-frame dereference of the button's
  building field was identified. The residual is therefore user-input-gated, not proven to be
  the historical render crash.

Only the three July 19 stockpile-vector dumps remain in the private crash-dump archive; no July 16
Class A dump is available. The old claim that the freed pointer was found specifically in
`custom_stockpile.sp` cannot be reproduced. In addition, the private Ghidra project currently has
zero imported `/df` data types, so the old typed-global field mapping cannot be relied on. The
renderer method identity is confirmed; the historical crash object's exact source cache is not.

## Complete `main_interface` candidate inventory

This inventory was re-derived from the matching `df.d_interface.xml`, including nested vectors
and the `interface_button_buildingst` subclass reachable through `building_interfacest`. A row
marked `PURGED` is cleared by identity in `src/ui_cache_purge.cpp` today even when its individual
native consumer has not been fully mapped.

| Field/reachable field | Pointer type | Native dereference result | Current treatment | Verdict |
|---|---|---|---|---|
| `civzone.cur_bld` | `building_civzonest*` | confirmed unguarded dependent-view read | null; close matching location selector | PURGED |
| `civzone.list[]` | `building_civzonest*` | persistent UI list; individual render site not remapped | erase identity | PURGED |
| `civzone.zone_just_created[]` | `building_civzonest*` | persistent UI list; individual consumer not remapped | erase identity | PURGED |
| `stockpile.cur_bld` | `building_stockpilest*` | paint/repaint subject; individual consumer not remapped | null | PURGED |
| `custom_stockpile.abd` | `building_stockpilest*` | open custom-stockpile subject; historical dump mapping unavailable | close and null | PURGED |
| `custom_stockpile.sp` | `stockpile_settings*` | points inside the stockpile allocation and dangles with it; historical crash-field attribution unavailable | close and null when equal to `&bld->settings` | PURGED |
| `info.buildings.list[mode][]` | `building*` | persistent Buildings-tab name list; exact `getName` source mapping not independently recovered | erase identity from every mode | PURGED |
| `job_details.bld` | `building*` | open panel subject; individual consumer not remapped | close and null | PURGED |
| `buildjob.display_furniture_bld` | `building_display_furniturest*` | build-job subject; individual consumer not remapped | null | PURGED |
| `assign_display_item.display_bld` | `building_display_furniturest*` | open assignment subject; individual consumer not remapped | close and null | PURGED |
| `trade.bld` | `building_tradedepotst*` | open trade subject; individual consumer not remapped | close and null | PURGED |
| `assign_trade.trade_depot_bld` | `building_tradedepotst*` | open assignment subject; individual consumer not remapped | close and null | PURGED |
| `building.button[]`, `press_button[]`, `filtered_button[]` -> `interface_button_buildingst.bd` | `building*` | confirmed dereference in click handlers; no render-frame dereference identified | none | **GAP: reset build interface** |
| `location_list.valid_ab[]` | `abstract_building*` | location UI | not cleared | SAFE-never-plugin-reachable |
| `location_selector.valid_ab[]` | `abstract_building*` | location UI | not cleared | SAFE-never-plugin-reachable |
| `location_details.selected_ab` | `abstract_building*` | location UI | not cleared | SAFE-never-plugin-reachable |
| `create_work_order.building[]` | `cwo_buildingst*` | work-order template, not a world building | not cleared | SAFE-ID/type |

The abstract-building rows are safe for current building-deconstruct routes because
`abstract_building` location objects are distinct allocations not freed by
`Buildings::deconstruct(df::building*)`. A future location-deletion feature would require its own
audit and purge.

The adventure-mode barter zone and `viewscreen_assign_display_itemst.building` are declared in the
same XML file but are not fields of `main_interface`; they are outside this table and outside the
fortress-mode helper's current scope.

## Deconstruct-path coverage

The C++ paths that immediately deconstruct buildings all call `purge_ui_caches_for_building`
before `Buildings::deconstruct`:

- generic `/building-action` remove in `src/building_zone.cpp`;
- zone removal in `src/building_zone.cpp`;
- stockpile removal in `src/stockpile_panel.cpp`;
- stockpile repaint replacement in `src/stockpile_panel.cpp`.

Squad disbanding does not deconstruct a `df::building` and does not arm these fields.

One Lua cleanup path remains outside the helper: `dwf.lua:create_stockpile` calls
`dfhack.buildings.deconstruct` if importing settings into a newly constructed pile fails. The pile
is created and destroyed in one operation, so native UI reachability is unlikely, but it was not
proved from the binary or a live trace. It should not be silently treated as covered.

## Implementation gap list

- **`src/ui_cache_purge.cpp`:** the reachable `interface_button_buildingst.bd` cache remains live
  after a remote building delete. Do not merely null the field: its confirmed click handlers
  dereference it, and button objects are shared among multiple interface vectors. Reset/cancel the
  native build interface using the same lifecycle DF uses, or otherwise rebuild all three vectors
  atomically when any button targets the dying building.
- **`dwf.lua:create_stockpile`:** route import-failure cleanup through a deletion path that performs
  the same cache purge, or prove and document that the new pile cannot enter any native cache
  before cleanup.
- **No additional raw `main_interface` building/settings field is missing from the current C++
  purge inventory.** The remaining direct fields and nested vectors are either purged, refer to
  separate abstract-building allocations, or are ID/template data.
- **Needs more analysis:** recover a retained Class A full-memory dump before asserting that the
  historical freed pointer was specifically `custom_stockpile.sp`, `custom_stockpile.abd`, or an
  `info.buildings.list` entry. The current evidence proves the `getName` crash operation, not the
  source field.
