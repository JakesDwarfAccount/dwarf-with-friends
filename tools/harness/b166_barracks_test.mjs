// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// b166_barracks_test.mjs -- offline route/UI fixtures for barracks squad assignment.
// No live DF and no world writes.
//   node tools/harness/b166_barracks_test.mjs

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const cpp = read("src/building_zone.cpp");
const header = read("src/building_zone.h");
// B212: the zone-squad + zone-rename routes live in register_building_zone_routes now.
const http = read("src/building_zone.cpp");
const clientPath = path.join(root, "web/js/dwf-building-zone-stockpile-panels.js");
const clientSource = fs.readFileSync(clientPath, "utf8");
const css = read("web/css/dwf.css");
// WAVE 5: the squad row renders through DWFUI (rowHtml + latchHtml). Mirror the browser load
// order -- ui-components loads first and publishes globalThis.DWFUI.
globalThis.escapeHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.DWFUI = require(path.join(root, "web/js/dwf-ui-components.js"));
const client = require(clientPath);

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}

console.log("# additive route shape and native data model");
check("header exposes read and one-bit write operations",
  /zone_squads_json_on_core_thread/.test(header) && /zone_squad_action_on_core_thread/.test(header));
check("GET /zone-squads serves the fixture payload", /server\.Get\("\/zone-squads"/.test(http));
check("POST /zone-squad-action is additive",
  /server\.Post\("\/zone-squad-action", zone_squad_action_handler\)/.test(http));
check("write route requires id, squad, mode, and enabled",
  /query_int\(req, "id"/.test(http) && /query_int\(req, "squad"/.test(http) &&
  /query_int\(req, "enabled"/.test(http) && /has_param\("mode"\)/.test(http));
check("only fortress-entity squads can be assigned",
  /std::find\(fort->squads\.begin\(\), fort->squads\.end\(\), squad_id\)/.test(cpp));
check("native updater maintains squad.rooms and zone.squad_room_info",
  /Military::updateRoomAssignments\(squad_id, zone_id, flags\)/.test(cpp) &&
  /squad->rooms/.test(cpp) && /zone->squad_room_info/.test(cpp));
check("bed, armor stand, and weapon rack selection resolve through their barracks relation",
  /building_type::Bed[\s\S]*?building_type::Armorstand[\s\S]*?building_type::Weaponrack[\s\S]*?b->relations/.test(cpp) &&
  /barracksZoneId/.test(clientSource) && /openZonePanel\(Number\(info\.barracksZoneId\)\)/.test(clientSource));
for (const [wire, bit] of [["sleep", "sleep"], ["train", "train"],
  ["individual-equipment", "indiv_eq"], ["squad-equipment", "squad_eq"]]) {
  check(`${wire} maps to squad_use_flags.${bit}`,
    new RegExp(`mode == "${wire}"[\\s\\S]*?flags\\.bits\\.${bit} = enabled`).test(cpp));
}
check("barracks repaint preserves the zone object so squad modes need no migration",
  /apply_zone_repaint_in_place_on_core_thread/.test(cpp) &&
  !/old_z->type == df::civzone_type::Barracks[\s\S]*?Military::updateRoomAssignments\(room->squad_id, new_z->id/.test(cpp));

console.log("\n# assignment-row fixture rendering");
check("pure row renderer and mode helper are exported",
  typeof client.zoneSquadRowsHtml === "function" && typeof client.zoneSquadModeState === "function");
const fixture = [
  { id: 90, name: "The Copper Helms", sleep: true, train: true,
    individualEquipment: true, squadEquipment: true,
    emblem: { fg: { r: 240, g: 220, b: 80 }, bg: { r: 40, g: 60, b: 100 } } },
  { id: 103, alias: "Gate Guard", sleep: false, train: false,
    individualEquipment: false, squadEquipment: false,
    emblem: { fg: { r: 255, g: 255, b: 255 }, bg: { r: 80, g: 20, b: 20 } } },
];
const html = client.zoneSquadRowsHtml(fixture, value => String(value));
// WAVE 5 RETARGET (same INTENT, STRICTER -- the b174/b55 pattern). The squad row is now built by
// the shared component layer: DWFUI.rowHtml for the chassis, DWFUI.latchHtml for the four mode
// tiles. Under the strangler contract a consumer class is ADDITIVE -- the builder always prepends
// its own (`dwfui-row`, `dwfui-latch`) and a consumer class can never replace it -- so these cells
// now pin the COMPOSED class string AND assert the bare hand-built form is IMPOSSIBLE. That is how
// the already-migrated surfaces in this repo assert themselves (see b174's tabs cell, which pins
// `class="dwfui-tabs ... workshop-tabs"` and then asserts `class="workshop-tabs"` cannot occur).
check("one native-shaped row renders per squad, through the shared row grammar",
  (html.match(/class="dwfui-row zone-squad-row/g) || []).length === 2 &&
  /The Copper Helms/.test(html) && /Gate Guard/.test(html) &&
  !/class="zone-squad-row/.test(html));                  // the hand-built row is now impossible
check("each row renders four independent mode toggles, as native two-state LATCHES",
  (html.match(/class="dwfui-latch zone-squad-mode/g) || []).length === 8 &&
  !/class="zone-squad-mode/.test(html));                 // the hand-built toggle is now impossible
check("assigned row reports its active uses",
  /Sleeping, Training, Individual equipment, Squad equipment/.test(html) &&
  /class="dwfui-row zone-squad-row assigned"/.test(html));
check("the squad emblem letter is FLAGGED as an identity blocker (no native emblem art is served)",
  (html.match(/class="zone-squad-emblem" data-df-identity-missing="letter"/g) || []).length === 2);
check("unassigned row remains explicit", /Not assigned/.test(html));
for (const token of ["SLEEP", "TRAIN", "INDIV_EQ", "SQUAD_EQ"])
  check(`${token} uses native active/inactive interface art`,
    html.includes(`ZONE_SQUAD_${token}_ACTIVE`) && html.includes(`ZONE_SQUAD_${token}_INACTIVE`));
check("pressed state and next enabled value agree",
  /data-zone-squad-mode="sleep" data-zone-squad-enabled="0" aria-pressed="true"/.test(html) &&
  /data-zone-squad="103" data-zone-squad-mode="train" data-zone-squad-enabled="1" aria-pressed="false"/.test(html));

console.log("\n# B194 hover titles replace the overlapping header row");
// Native DF shows each column name only on hover; every icon carries its own title tooltip.
const columnTitles = ["Sleep", "Train", "Individual equipment", "Squad equipment"];
check("each icon carries its native column title as a hover tooltip",
  columnTitles.every(t => new RegExp(`title="${t}: (?:on|off)"`).test(html)));
check("every mode button has a title attribute",
  (html.match(/class="dwfui-latch zone-squad-mode/g) || []).length ===
  (html.match(/<button[^>]*class="dwfui-latch zone-squad-mode[^>]*\stitle="/g) || []).length);
const iconTitles = (html.match(/title="([^:"]+): (?:on|off)"/g) || [])
  .map(m => m.replace(/title="([^:"]+):.*/, "$1"));
check("the four column titles are unique and non-overlapping",
  new Set(iconTitles).size === 4 && columnTitles.every(t => iconTitles.includes(t)));
// WAVE 5 RETARGET: the mode name reaches assistive tech through `aria-label` on the latch itself
// rather than a visually-hidden <span class="sr-only">. That is the SAME guarantee by a stronger,
// standard mechanism (latchHtml has no sr-only slot; it has aria-label). The COUNT is still pinned
// at 8, so a control that exposes no accessible mode name still fails this cell.
check("the accessible mode name is preserved on every one of the eight mode latches",
  (html.match(/class="dwfui-latch zone-squad-mode[^>]*aria-label="(?:Sleeping|Training|Individual equipment|Squad equipment)"/g) || []).length === 8);

console.log("\n# blue-flag affordance, wiring, and panel contract");
// B217 r2: the flag+ tile is a DWFUI artBtn in the panel's right rail now (the barracks zone
// oracle: [ZONE_SQUAD_LIST] above [shield+]); the wire is the same [data-zone-squads] dataset,
// emitted by datasetAttrs at render time rather than a literal attribute in source.
check("barracks detail exposes the native blue squad-list flag",
  /sprite: "ZONE_SQUAD_LIST"[\s\S]*?dataset: \{ zoneSquads: "" \}/.test(clientSource));
// B217 r2: rename is native's NAME ROW for every zone type (input + quill -- Z12-jt-1 and the
// barracks oracle both show it), not a barracks-only [data-zone-rename] button. Same route.
check("visible native quill renames the barracks through a semantic route",
  /server\.Post\("\/zone-rename", workshop_rename_handler\)/.test(http) &&
  /dataset: \{ zoneName: "" \}/.test(clientSource) &&
  /sprite: DWFUI\.TOKENS\.sprites\.zoneQuill/.test(clientSource) &&
  /\/zone-rename\?id=\$\{info\.id\}&name=\$\{encodeURIComponent\(name\)\}/.test(clientSource));
check("blue flag opens the squad assignment panel",
  /\[data-zone-squads\][\s\S]*?openZoneSquadsPanel\(info\.id\)/.test(clientSource));
check("toggle POST carries row squad, mode, and next enabled state",
  /\/zone-squad-action\?id=\$\{data\.id\}&squad=\$\{squad\}&mode=\$\{encodeURIComponent\(mode\)\}&enabled=\$\{enabled\}/.test(clientSource) &&
  /method: "POST"/.test(clientSource));
// Merge-proof extraction: slice from the function start to the NEXT top-level function,
// whatever whitespace a merge leaves between them (a whitespace-exact regex broke on 07-10).
const panelStart = clientSource.indexOf("async function openZoneSquadsPanel");
const panelRest = panelStart >= 0 ? clientSource.slice(panelStart + 30) : "";
const panelNextIdx = panelRest.search(/\n  (?:async )?function \w+/);
const panel = panelStart >= 0 ? panelRest.slice(0, panelNextIdx > 0 ? panelNextIdx : undefined) : "";
// B217 r2: the zone family is close-less (no native zone panel has an X; ESC/map click); the
// adoptable head is headerHtml's bld-head with native's gold back arrow (BUTTON_CLOSE_LEFT).
check("assignment panel supplies one adoptable close-less bld-head with the native back arrow",
  /cls: "bld-head zone-sub-head", close: false/.test(panel) &&
  /back: \{ dataset: \{ zoneBack: "" \}/.test(panel) &&
  !/<button class="bld-x"/.test(panel));
check("row CSS reserves portrait, name, and four native mode columns",
  /\.zone-squad-row\s*\{[\s\S]*?grid-template-columns: 32px minmax\(150px, 1fr\) repeat\(4, 36px\)/.test(css));
check("no always-on legend header row is rendered (B194: titles are hover tooltips)",
  !/zone-squad-legend/.test(panel));
check("dead legend CSS is removed",
  !/zone-squad-legend/.test(css));

console.log("\n# TEST-THE-TEST seeded bad");
const sleepButton = html.match(/<button[^>]*class="dwfui-latch zone-squad-mode on"[^>]*data-zone-squad="90"[^>]*data-zone-squad-mode="sleep"[\s\S]*?<\/button>/)?.[0] || "";
const seededBadSleepButton = sleepButton
  .replace('data-zone-squad-enabled="0"', 'data-zone-squad-enabled="1"')
  .replace("ZONE_SQUAD_SLEEP_ACTIVE", "ZONE_SQUAD_SLEEP_INACTIVE");
const validActiveSleep = button => /data-zone-squad-enabled="0"/.test(button) &&
  /ZONE_SQUAD_SLEEP_ACTIVE/.test(button);
check("active-sleep validator accepts the shipped row", validActiveSleep(sleepButton));
check("validator rejects seeded inverted next-state + inactive art", !validActiveSleep(seededBadSleepButton));

// B194: prove the tooltip/legend guards actually reject a regression.
const titledCount = h => (h.match(/<button[^>]*class="dwfui-latch zone-squad-mode[^>]*\stitle="/g) || []).length;
const modeCount = h => (h.match(/class="dwfui-latch zone-squad-mode/g) || []).length;
const seededNoTitle = html.replace(/(<button[^>]*class="dwfui-latch zone-squad-mode[^>]*)\stitle="[^"]*"/, "$1");
check("title guard accepts the shipped rows", titledCount(html) === modeCount(html));
check("title guard rejects a button with a stripped title",
  titledCount(seededNoTitle) !== modeCount(seededNoTitle));
const seededLegend = `<div class="zone-squad-legend"><span>Sleep</span></div>`;
check("legend guard rejects a reintroduced always-on header", /zone-squad-legend/.test(seededLegend));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
