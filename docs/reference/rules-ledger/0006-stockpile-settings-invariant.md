# 0006 - Stockpile settings vector invariants

**Status:** `binary-read` + `dump-confirmed` for the eligibility-path safety rule;
`binary-read` for native category-enable and All/None behavior.
**Date read:** 2026-07-21

## Rule

`stockpile_settings` has two different notions of completeness that must not be conflated:

1. **Crash safety:** when its category flag is enabled, each fixed material-class vector that
   the native item predicate indexes without checking its length must contain at least the full
   fixed enum domain. There are seven such vectors:

   | Category | Vector | Minimum length |
   |---|---|---:|
   | furniture | `other_mats` | 15 |
   | ammo | `other_mats` | 2 |
   | bars/blocks | `bars_other_mats` | 5 |
   | bars/blocks | `blocks_other_mats` | 4 |
   | finished goods | `other_mats` | 16 |
   | weapons | `other_mats` | 10 |
   | armor | `other_mats` | 10 |

   A shorter vector is corrupt for the native eligibility path. Missing entries should be
   appended as `false`, preserving all existing choices.

2. **Semantic completeness:** the remaining vectors normally correspond to a current raws,
   item-definition, descriptor-color, or enum domain. The native eligibility predicate checks
   their length before every indexed read. A short or empty vector therefore rejects the missing
   choices instead of reading out of bounds. Growing these vectors to their current domain with
   `false` entries is a reasonable semantic normalization, but it is broader than the proven
   crash-safety predicate.

An empty raw-domain vector is legitimate for crash safety, including when its world domain is
empty. It is a crash defect only when it is one of the seven fixed vectors above and its category
is enabled.

## Fresh-construction state

The `building_stockpilest` constructor at `0x14030db80` initializes the embedded settings through
`0x14030c240`:

- all category flags are clear;
- every vector is empty;
- scalar booleans and the fixed quality arrays are false;
- `misc.allow_organic` and `misc.allow_inorganic` are true.

Thus an empty vector is valid in a fresh settings object while its category is disabled.

## Native category enable and All/None behavior

Native DF does not leave a newly enabled category's vectors empty, and it does not initially
select everything.

The stockpile interface transition helper at `0x14035e7f0` receives a `stockpile_list` mode and
the corresponding `stockpile_group_set` bit. When that category bit is currently clear, it:

1. calls `0x14030cb20`, which resizes every vector owned by the selected category to its current
   fixed or world-data domain, fills the vectors/scalars `true`, and sets the category flag;
2. immediately calls the matching category clear helper, which writes `false` across all those
   now-sized vectors and scalar choices.

The resulting native state for a category enabled through this path is therefore: **flag on,
vectors correctly sized, selections all false**. This applies to all 17 ordinary category bits
(animals through sheets). `AdditionalOptions` is not a category bit; its two booleans are toggled
individually.

The same UI input function, `0x1403106c0`, contains two category-wide buttons dispatched by
`cur_main_mode` (`stockpile_list`). The first calls the category helper that writes `true` to all
existing entries (the native **All** action); the second calls its `false` counterpart (the native
**None** action). The switch cases exactly match the category enum values: 0, 1, 21, 28, 29, 39,
44, 50, 51, 57, 63, 72, 75, 85, 86, 94, and 106, plus 109 for Additional Options.

This distinction matters for repair logic: growing missing entries as `false` agrees with native
new-category initialization. Filling repaired entries `true` would imitate an explicit All click,
not category enable.

## Vector-domain and eligibility audit

The domains below come from the matching DFHack 53.15-r2 generated layouts/XML. The access result
comes from the native eligibility dispatcher and its category helpers in the pinned executable.

| Category | Sub-vectors and domain | Eligibility access |
|---|---|---|
| animals | `enabled`: creature raws | bounds-checked |
| food | `meat`, `fish`, `unprepared_fish`, `egg`, `plants`, `drink_plant`, `drink_animal`, `cheese_plant`, `cheese_animal`, `seeds`, `leaves`, `powder_plant`, `powder_creature`, `glob`, `glob_paste`, `glob_pressed`, `liquid_plant`, `liquid_animal`, `liquid_misc`: their corresponding organic-material categories | bounds-checked |
| furniture | `type`: `furniture_type`; `other_mats`: 15-value `stockpile_furniture_mat`; `mats`: inorganic raws | `type` and `mats` checked; `other_mats` direct/unbounded |
| corpses | `corpses`: creature raws | bounds-checked |
| refuse | `type`: `item_type`; `corpses`, `body_parts`, `skulls`, `bones`, `hair`, `shells`, `teeth`, `horns`: creature raws | bounds-checked |
| stone | `mats`: inorganic raws | bounds-checked |
| ore | `mats`: no active domain; layout marks it unused | not referenced by this eligibility path |
| ammo | `type`: ammo item definitions; `other_mats`: 2-value `stockpile_ammo_mat`; `mats`: inorganic raws | `type` and `mats` checked; `other_mats` direct/unbounded |
| coins | `mats`: inorganic raws | bounds-checked |
| bars/blocks | `bars_other_mats`: 5-value bar enum; `blocks_other_mats`: 4-value block enum; `bars_mats`, `blocks_mats`: inorganic raws | raw vectors checked; both fixed material vectors direct/unbounded |
| gems | `rough_other_mats`, `cut_other_mats`: builtin material table; `rough_mats`, `cut_mats`: inorganic raws | bounds-checked |
| finished goods | `type`: `item_type`; `other_mats`: 16-value finished-material enum; `mats`: inorganic raws; `color`: descriptor colors | all checked except `other_mats`, which is direct/unbounded |
| leather | `mats`: leather organic-material category; `color`: descriptor colors | bounds-checked |
| cloth | eight thread/cloth organic-material vectors plus descriptor `color` | bounds-checked |
| wood | `mats`: plant raws | bounds-checked |
| weapons | `weapon_type`, `trapcomp_type`: item definitions; `other_mats`: 10-value weapon-material enum; `mats`: inorganic raws | item definitions and raws checked; `other_mats` direct/unbounded |
| armor | `body`, `head`, `feet`, `hands`, `legs`, `shield`: their item-definition tables; `other_mats`: 10-value armor-material enum; `mats`: inorganic raws; `color`: descriptor colors | item definitions/raws/colors checked; `other_mats` direct/unbounded |
| sheets | `paper`, `parchment`: corresponding organic-material categories | bounds-checked |

Fixed quality arrays and scalar choices such as dye, usability, prepared meals, hides, and empty
cages/traps are not vectors and are not part of this failure class.

## Dump evidence

All three retained July 19 full-memory dumps independently produce the same result:

- `Dwarf Fortress.exe.59052.dmp`
- `Dwarf Fortress.exe.64972.dmp`
- `Dwarf Fortress.exe.103416.dmp`

Each has a read access violation at normalized address `0x1405ae0c0`, reading address `0x3`.
The faulting operation is the native read of byte index 3 from a null vector begin pointer.
Registers identify material type `0x1A4` and material index `0xCC`.

For each dump, independently walking backward from the helper argument gives:

- helper argument = settings `+0x3E8` = `bars_blocks`;
- settings = `building_stockpilest +0x120`;
- the building begins with the correctly relocated `building_stockpilest` vtable whose static
  address is `0x141624268`;
- settings flags are `0x00001504`, including enabled `bars_blocks`;
- `bars_other_mats` length is 5;
- `blocks_other_mats` length is 0;
- `bars_mats` length is 319;
- `blocks_mats` length is 0.

The matching layout places `bars_other_mats`, `blocks_other_mats`, `bars_mats`, and `blocks_mats`
at `bars_blocks +0x00`, `+0x18`, `+0x30`, and `+0x48`. The helper's block-material branch reads
`blocks_other_mats[3]` before any length check. This confirms the crash field as
`bars_blocks.blocks_other_mats`; it refutes the earlier `ore.mats` hypothesis.

## Binary evidence

- Binary: `Dwarf Fortress.exe`, DF 53.15 Steam
  - SHA-256 `683C721D1261E77FF862A2E01DFE3FF93D107AB7B1C92B5A3B6F313CCC8FC284`
  - PE timestamp `0x6A268FCD`
  - size 26,457,088 bytes; image base `0x140000000`
- Stockpile constructor: `0x14030db80`
- `stockpile_settings` initializer: `0x14030c240`
- Stockpile UI input/update: `0x1403106c0`
- Category transition/enable helper: `0x14035e7f0`
- Category vector sizing/default population: `0x14030cb20`
- Item eligibility dispatcher: `0x14055cf70`
- Material lookup: `0x1414a41d0`
- Category helpers read during this audit:
  - animals `0x140544660`
  - food `0x1405ac640`
  - furniture `0x1405ad640`
  - refuse `0x1405447c0`
  - ammo `0x1405ade10`
  - bars/blocks `0x1405adfd0`
  - finished goods `0x1405ae260`
  - cloth `0x1405ae850`
  - weapons `0x140589290`
  - armor `0x140589730`

Raw decompilation and disassembly remain in the private `df-oracle` workspace.

## Other settings holders

The matching layouts contain three persistent owners of this exact struct:

1. `building_stockpilest.settings` - directly evaluated for stockpile hauling.
2. `hauling_stop.settings` - the same eligibility data and therefore the same invariant.
3. `plotinfo.stockpile.custom_settings` - the fortress-wide custom-stockpile settings buffer. It
   is not a farm plot and is not directly tied to one stockpile's hauling predicate, but it can
   carry and later propagate the same malformed shape.

`building_farmplotst` does not embed `stockpile_settings`; its crop/settings data is a different
shape and is outside this rule.

## Implementation gap list

- `dwf.lua:sp_normalize_enabled_categories` already grows all declared vectors for enabled
  categories with false entries, preserving existing choices. Its fixed material lists have the
  seven correct lengths above, so it covers the proven crash predicate for stockpiles and hauling
  stops.
- Treat growth of raw-domain vectors as semantic normalization, not as evidence that every short
  raw-domain vector would crash. If the healer is intended to be minimal, the exact crash rule is
  the seven-vector table above.
- The healer currently scans stockpile buildings and hauling stops but not
  `plotinfo.stockpile.custom_settings`. Add that owner if malformed custom settings must not be
  propagated into a later pile.
- Do not special-case or grow `ore.mats` for this crash; the matching layout marks it unused and
  the audited eligibility path never references it.
- Native behavior supports the healer's choice to append `false`: that is the default state after
  category enable. An explicit native All action is the operation that fills existing choices
  `true`.
