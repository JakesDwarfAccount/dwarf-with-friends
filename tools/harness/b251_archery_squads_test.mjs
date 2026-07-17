// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// b251_archery_squads_test.mjs -- OFFLINE. B251: the blue-flag "assign squad" control is missing
// from the ARCHERY RANGE zone panel. No live DF, no world writes, no browser.
//   node tools/harness/b251_archery_squads_test.mjs
//
// DF'S ACTUAL RULE (cited, not guessed):
//
//   df::squad_selector_context_type  --  library/xml/df.d_interface.xml:1421
//     (bay12 original name: SquadSelectorContextType)
//        NONE = -1
//        ZONE_BARRACKS_ASSIGNMENT       = 0
//        ZONE_ARCHERY_RANGE_ASSIGNMENT  = 1
//
//   That enum IS the answer to "which zone types can open DF's squad selector". It has exactly two
//   members. `df::squad_selector_interfacest` (df.d_interface.xml:1427, reached from
//   game.main_interface.squad_selector) carries {open, context, squad_id[], bld_id, scroll} -- one
//   selector, one building, one of TWO contexts. So there is no third squad-assignable zone type
//   hiding anywhere: barracks and archery range are the complete set, and we shipped only barracks.
//
//   Storage is IDENTICAL for both: building_civzonest.squad_room_info (vector<building_squad_infost>,
//   df.building.xml:1083) forward-linked by squad.rooms (vector<squad_barracks_infost>,
//   df.squad.xml:323), each carrying one `squad_use_flags mode` bitfield
//   {sleep, train, indiv_eq, squad_eq} (df.squad.xml:243). DFHack's Military::updateRoomAssignments
//   (library/modules/Military.cpp:238) -- which is what our /zone-squad-action already calls -- takes
//   a plain building_civzonest and NEVER checks civzone_type. The only thing standing between an
//   archery range and squad assignment was OUR OWN `zone->type != Barracks` early-return.
//
//   DF's tooltip enum agrees: main_hover_instruction has ONE ZONE_ASSIGN_SQUAD (142) shared by both
//   zone panels, and ONE set of per-squad mode tooltips (BARRACKS_SQUAD_SLEEP/TRAIN/INDIV_EQ/SQUAD_EQ,
//   349-352) with no archery-specific counterparts -- i.e. DF reuses the same selector UI verbatim.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cpp = fs.readFileSync(path.join(root, "src/building_zone.cpp"), "utf8");
const clientPath = path.join(root, "web/js/dwf-building-zone-stockpile-panels.js");
const clientSource = fs.readFileSync(clientPath, "utf8");
const client = require(clientPath);

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// The complete squad-selector context set, transcribed from df::squad_selector_context_type.
const DF_SQUAD_ZONE_TYPES = ["Barracks", "ArcheryRange"];

console.log("# server: the squad routes accept every zone DF's squad selector accepts");

// One shared predicate, not two copy-pasted type checks -- the B152 lesson (zone_unit_is_candidate).
const predicate = cpp.match(/bool zone_accepts_squad_assignments\([\s\S]*?\n\}/)?.[0] || "";
check("a named zone_accepts_squad_assignments predicate exists", predicate.length > 0);
for (const t of DF_SQUAD_ZONE_TYPES)
  check(`predicate admits civzone_type::${t}`, new RegExp(`civzone_type::${t}\\b`).test(predicate));
check("predicate admits EXACTLY the two DF contexts (no third type invented)",
  (predicate.match(/civzone_type::\w+/g) || []).length === DF_SQUAD_ZONE_TYPES.length);

// Both the read route and the write route must go through it -- a read-only fix would render the
// button and 400 on click, which is the stranding class B227 exists to prevent.
check("zone_squads_json (read) uses the predicate",
  /zone_squads_json_on_core_thread[\s\S]{0,900}?zone_accepts_squad_assignments\(/.test(cpp));
check("zone_squad_action (write) uses the predicate",
  /zone_squad_action_on_core_thread[\s\S]{0,900}?zone_accepts_squad_assignments\(/.test(cpp));
check("no route still hard-codes `type != Barracks`",
  !/type\s*!=\s*df::civzone_type::Barracks/.test(cpp));
check("the barracks-only error string is gone",
  !/"zone is not a barracks"/.test(cpp));

console.log("\n# server: the panel payload tells the client which zones take squads");
check("ZonePanelInfo carries can_squads", /bool can_squads = false;/.test(
  fs.readFileSync(path.join(root, "src/building_zone.h"), "utf8")));
check("zone_info_json emits canSquads", /zone_info_json[\s\S]*?\\"canSquads\\":/.test(cpp));
check("assignedSquads is counted for every squad-assignable zone, not only barracks",
  /if \(out\.can_squads\) \{[\s\S]{0,220}?\+\+out\.assigned_squads;/.test(cpp));
check("/zone-squads reports the zone's real type (not a hard-coded \"Barracks\")",
  !/"type\\":\\"Barracks\\""/.test(cpp) && !/\\"type\\":\\"Barracks\\"/.test(cpp));

console.log("\n# browser: the blue-flag control renders on both zone types");
check("exports the pure zoneAcceptsSquads predicate", typeof client.zoneAcceptsSquads === "function");
const accepts = client.zoneAcceptsSquads || (() => false);
check("archery range accepts squads", accepts({ type: "ArcheryRange", isArchery: true, canSquads: true }) === true);
check("barracks accepts squads", accepts({ type: "Barracks", isBarracks: true, canSquads: true }) === true);
check("a pen does not", accepts({ type: "Pen", isPen: true }) === false);
check("a tomb does not", accepts({ type: "Tomb", isTomb: true }) === false);
// Old-DLL tolerance: a build that predates canSquads still serves isBarracks, and the flag must
// still show there (fail-open on the READ side is safe: the write route is the one that validates).
check("falls back to isBarracks when an older DLL serves no canSquads",
  accepts({ type: "Barracks", isBarracks: true }) === true);
check("does NOT invent archery support on an old DLL that cannot serve it",
  accepts({ type: "ArcheryRange", isArchery: true }) === false);

check("the rail gates the ZONE_SQUAD_LIST tile on the predicate, not on isBarracks",
  /zoneAcceptsSquads\(info\)/.test(clientSource) &&
  !/if \(info\.isBarracks\) \{\s*\n\s*const squadCount/.test(clientSource));
check("the squad panel is reachable from an archery range (tooltip names the zone)",
  /Assign squads to this (?:\$\{|archery|barracks)/i.test(clientSource) || /zoneSquadAssignVerb/.test(clientSource));

console.log("\n# TEST-THE-TEST: seeded-bad predicates");
const barracksOnly = info => !!info.isBarracks;
check("the shipped barracks-only predicate fails the archery cell",
  barracksOnly({ type: "ArcheryRange", isArchery: true, canSquads: true }) !== accepts({ type: "ArcheryRange", isArchery: true, canSquads: true }));
const everyZone = () => true;
check("a predicate that admits every zone fails the pen cell",
  everyZone({ type: "Pen" }) !== accepts({ type: "Pen", isPen: true }));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
