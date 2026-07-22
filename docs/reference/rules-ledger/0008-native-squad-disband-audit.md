# 0008 - Native squad disband audit

**Status:** `binary-read` for the native delete path; `source-audited` against
`src/squads.cpp:do_squad_delete`.
**Date read:** 2026-07-21

## Rule

Deleting a `df::squad` is not only an ownership-tree deletion. Before the squad and its owned
objects are freed, native DF also removes equipment-assignment records, the squad's current
activity, historical-figure squad membership, entity-position links, and external squad IDs or
pointers held by several world/interface collections.

Calling C++ `delete` on the DFHack layout is not equivalent to the native squad destructor for
pointer-owned members. In particular, a `std::vector<squad_ammo_spec*>` destructor frees only the
vector storage; native DF explicitly destroys each pointed-to ammo spec and its `assigned` vector.

## Native path

The fortress squad input handler is `0x14043b190`. Its first branch handles
`squads_interfacest.disband_confirmation` at interface offset `+0x111`, using the selected squad-id
vector at `+0x118`. Confirming disband walks the selected IDs in reverse and, for each squad that
passes the native eligibility checks, performs the following cleanup before removing the UI-list
entry:

1. Removes the squad ID from its historical entity and clears the linked entity-position
   assignment.
2. For every squad position, unlinks assigned equipment items from native item-assignment indexes,
   then clears the occupant historical figure's squad/position state and entity link.
3. Removes the squad's current activity object and resets `squad.activity` to `-1`.
4. For every ammo spec, removes all IDs in `squad_ammo_spec.assigned` from the native assignment
   indexes.
5. Clears several additional world/interface records whose squad-id field equals the dying squad.
6. Runs the native squad destructor, which deep-destroys positions, live orders, schedule routines,
   barracks-info records, and ammo specs, and removes the pointer from `world.squads.all`.
7. Removes the matching ID/selection entry from the open squad interface.

Relevant native helpers:

| Address | Confirmed role |
|---|---|
| `0x14043b190` | squad UI input and confirmed-disband orchestration |
| `0x1410ea8a0` | unlink a position's `equipment.assigned_items` from native item-assignment indexes |
| `0x1413c2cd0` | clear a historical figure's squad/position membership and related entity link |
| `0x1400a1b10` | remove/destroy the squad's current activity object |
| `0x1410e5dd0` | deep-destroy `squad_equipmentst`, including every ammo spec |
| `0x1410e6820` | deep squad destructor and `world.squads.all` unlink |

The field identifications above agree with the matching DFHack 53.15-r2 layouts. In particular,
`squad.activity` is at squad `+0x13C`, `squad.ammo` starts at `+0x140`, positions are at `+0xA0`,
and `squad_position.equipment.assigned_items` is at position `+0x150`.

## Cross-check against `do_squad_delete`

| Native responsibility | Current plugin behavior | Verdict |
|---|---|---|
| release live unit membership and historical-figure/entity links | calls `Military::removeFromSquad` when the occupant resolves to a live unit | matches for live units only |
| clear historical-figure membership without a live unit | fallback only writes `position.occupant = -1` | **GAP** |
| unlink position-assigned equipment items | deletes uniform specs and the position, but does not process `equipment.assigned_items` | **GAP** |
| clear entity squad list and leader assignment | erases `fort->squads` and clears matching `assignment.squad_id` | matched |
| deep-delete live squad orders | explicitly deletes and clears them | matched |
| deep-delete all schedule routines/month orders/position markers | explicitly deletes the full tree | matched |
| remove current squad activity | no handling of `squad.activity` | **GAP** |
| unlink ammo-spec assigned item IDs | no handling of `ammo.ammunition[*].assigned` | **GAP** |
| deep-delete ammo specs | no handling of `ammo.ammunition`; ordinary C++ vector destruction does not delete pointed specs | **GAP** |
| release barracks-info records | deletes squad-side records and additionally removes matching zone-side records | matched; plugin is stronger on the building backref |
| remove from `world.squads.all` | explicitly erases the pointer | matched |
| clear raw-pointer UI caches | `purge_ui_caches_for_squad` clears the known pointer surfaces before free | matched in purpose; plugin also covers non-native entry points |

The schedule and room trees are not an identified omission. The current manual schedule deletion
matches the ownership performed by the native destructor. The plugin's explicit deletion of the
zone-side barracks record goes beyond the squad destructor and is conservative.

## Confirmed implementation gaps

All changes belong in `src/squads.cpp:do_squad_delete`, before owned positions/ammo specs and the
squad are freed:

1. **Position equipment assignments:** mirror native `0x1410ea8a0` for every
   `position.equipment.assigned_items` entry. Deleting the position without this step leaves native
   item-assignment indexes describing equipment for a position that no longer exists.
2. **Off-map/non-live occupants:** do not reduce the fallback to `position.occupant = -1`. When an
   occupant historical figure exists but has no findable live unit, clear its squad id/position and
   the matching entity link, as native `0x1413c2cd0` does.
3. **Current activity:** find and remove `squad.activity`, then set it to `-1`, before deleting the
   squad. Native DF destroys that activity explicitly rather than relying on member removal.
4. **Squad ammunition:** for each ammo spec, unlink every `assigned` item ID from the same native
   assignment indexes, then deep-delete the spec and clear `squad.ammo.ammunition`. The latter is
   also required to avoid leaking every spec allocation.

These are binary-evidenced differences, not inferred ownership preferences. `Military::removeFromSquad`
does not cover position `assigned_items`, squad ammo assignments, or `squad.activity`.

## Needs more analysis

The native tail also clears a squad-id field in five global pointer collections (four at object
offset `+0x14C`, one at `+0x148`) and removes matching heap records from another global collection.
The machine-code writes are confirmed, but this Ghidra project does not currently type those
globals well enough to name the owning structures without guesswork. They are therefore not
promoted to a named plugin gap here. Identify those collection types before adding any speculative
cleanup.

The native path has a pre-delete eligibility scan over occupied positions. Its exact policy is not
needed to establish the four cleanup omissions above, but it should be decoded before trying to
make the browser endpoint reproduce every native refusal condition.

## Binary identity

- Binary: `Dwarf Fortress.exe`, DF 53.15 Steam
- SHA-256 `683C721D1261E77FF862A2E01DFE3FF93D107AB7B1C92B5A3B6F313CCC8FC284`
- PE timestamp `0x6A268FCD`
- size 26,457,088 bytes; image base `0x140000000`

Raw decompilation and disassembly remain in the private `df-oracle` workspace.
