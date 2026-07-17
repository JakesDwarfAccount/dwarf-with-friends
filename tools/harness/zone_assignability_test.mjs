// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// zone_assignability_test.mjs -- OFFLINE B152 fixtures for native pasture/pond assignability
// and the browser's row-toggle state. No live DF and no world writes.
//   node tools/harness/zone_assignability_test.mjs

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cpp = fs.readFileSync(path.join(root, "src/building_zone.cpp"), "utf8");
const clientPath = path.join(root, "web/js/dwf-building-zone-stockpile-panels.js");
const clientSource = fs.readFileSync(clientPath, "utf8");
const css = fs.readFileSync(path.join(root, "web/css/dwf.css"), "utf8");
const client = require(clientPath);

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// Native pen/pasture rows are creatures only. Existing animal assignments remain visible so
// they can be cleared; otherwise the animal must be active, living, and tame or caged.
function nativeAssignable(unit, assignedHere = false) {
  if (!unit.animal) return false;
  if (assignedHere) return true;
  if (!unit.active || unit.dead) return false;
  const caged = !!unit.contained || !!unit.builtCage;
  return (!!unit.tame || caged) && !unit.merchant && !unit.forest;
}

const fixtures = [
  ["fort-owned tame pet", { active: true, animal: true, ownCiv: true, tame: true, pet: true }, true],
  ["fort-owned tame livestock", { active: true, animal: true, ownCiv: true, tame: true }, true],
  ["fort-owned citizen dwarf", { active: true, animal: false, ownCiv: true, tame: false }, false],
  ["caged citizen dwarf", { active: true, animal: false, ownCiv: true, contained: true }, false],
  ["caged foreign captive", { active: true, animal: false, ownCiv: false, contained: true }, false],
  ["uncaged wild animal", { active: true, animal: true, ownCiv: false }, false],
  ["uncaged animal invader", { active: true, animal: true, ownCiv: false, invader: true }, false],
  ["wild animal in a loose cage", { active: true, animal: true, ownCiv: false, contained: true }, true],
  ["wild animal assigned to a built cage", { active: true, animal: true, ownCiv: false, builtCage: true }, true],
  ["dead fort animal", { active: true, dead: true, animal: true, ownCiv: true }, false],
  ["merchant animal", { active: true, animal: true, ownCiv: true, merchant: true }, false],
  ["forest animal", { active: true, animal: true, ownCiv: true, forest: true }, false],
];

console.log("# native assignability predicate fixtures");
for (const [name, unit, expected] of fixtures)
  check(`${name} -> ${expected ? "assignable" : "rejected"}`, nativeAssignable(unit) === expected);

console.log("\n# server predicate wiring");
const predicate = cpp.match(/bool zone_unit_is_candidate\([\s\S]*?\n\}/)?.[0] || "";
check("candidate uses the native isAnimal gate", /Units::isAnimal\(unit\)/.test(predicate));
check("animal gate runs before the assigned-here bypass", predicate.indexOf("!Units::isAnimal(unit)") < predicate.indexOf("if (assigned_here)"));
check("tame or cage containment admits animals", /Units::isTame\(unit\) \|\| caged/.test(predicate));
check("merchant and forest animals remain excluded", /!Units::isMerchant\(unit\).*?!Units::isForest\(unit\)/s.test(predicate));
check("fort ownership is not rejected before animal eligibility", !/if \(Units::isOwnRace\(unit\) \|\| Units::isOwnCiv\(unit\)\)/.test(predicate));
check("query and write-validation paths share the predicate", (cpp.match(/zone_unit_is_candidate\(/g) || []).length === 3);

console.log("\n# browser assignment row state");
check("exports the pure row-state helper", typeof client.zoneAnimalAssignmentState === "function");
const state = client.zoneAnimalAssignmentState;
check("assigned row is pressed and unassigns", (() => { const s = state({ assigned: true }); return s.assigned && s.assign === 0 && s.label === "Assigned here" && s.action === "Unassign"; })());
check("elsewhere row offers Move here", (() => { const s = state({ assignedElsewhere: true }); return !s.assigned && s.assign === 1 && s.label === "Assigned elsewhere" && s.action === "Move here"; })());
check("free row offers Assign", (() => { const s = state({}); return s.assign === 1 && s.label === "Not assigned" && s.action === "Assign"; })());
check("native label helper formats stray animal, sex, and tame status", client.zoneAnimalNativeLabel({ id: 1, name: "Dog (tame)", race: "DOG", sex: "male", flags: ["tame"] }) === "Stray Dog, ♂ (Tame)");
check("named animal label retains its name and species", client.zoneAnimalNativeLabel({ id: 2, name: "Vucar Roldethcatten, Cat (tame)", race: "CAT", sex: "female", flags: ["tame"] }) === "Vucar Roldethcatten, Cat, ♀ (Tame)");
// The row, its locate button, its toggle and the search field are now built through the DWFUI
// component helpers (rowHtml / artBtnHtml / checkHtml / searchHtml), so the shipped classes and the
// aria-pressed/magnifier chrome are emitted BY those helpers -- the source carries the `cls:` /
// `checked:` / `magnifier:` config, not raw `class="..."`/`&#128269;` literals. Assert the config
// that drives the shipped markup (checkHtml -> aria-pressed verified in ui_components; searchHtml
// magnifier -> BUTTON_FILTER sprite, no longer an emoji).
check("rows carry portrait, locate, and square assignment buttons", /cls: "zone-unit-row zone-animal-row/.test(clientSource) && /icon: portrait/.test(clientSource) && /cls: "zone-animal-locate"/.test(clientSource) && /cls: "zone-animal-toggle"/.test(clientSource));
check("row markup exposes pressed state", /DWFUI\.checkHtml\(\{[\s\S]*?checked: state\.assigned/.test(clientSource));
// B270: this used to pin the literal string `grid-template-columns: 32px minmax(0,1fr) 30px 30px`,
// which is a test asserting WHAT WE WROTE, not what reaches the screen -- and it stayed green while
// the office chooser (the same row family, one hand-cut template over) put the portrait in the
// flexible track and crushed the name into 72px. The requirement that template was REACHING for is
// what is pinned now: the row is laid out by the ONE shared .zone-unit-row rule; the portrait and
// the two tiles are fixed; the copy takes the slack (and may shrink, so a long species ellipsises);
// and the empty locate slot still carries its width so the check column stays x-aligned on mixed
// rows -- the thing the grid track used to guarantee for free. Real geometry lives in
// b270_chooser_overflow_test.mjs (arithmetic) and b270_chooser_geometry.probe.js (Chrome).
check("the animal row is laid out by the shared chooser rule -- fixed portrait, copy takes the slack, tiles pinned right",
  /\.building-panel \.zone-unit-row\s*\{[\s\S]*?display: flex;/.test(css) &&
  /\.building-panel \.zone-unit-row > \*\s*\{\s*flex: 0 0 auto;\s*\}/.test(css) &&
  /\.building-panel \.zone-unit-row > \.zone-animal-copy[\s\S]*?flex: 1 1 auto; min-width: 0;/.test(css) &&
  !/\.zone-animal-row\s*\{[^}]*grid-template-columns/.test(css));
check("the unassigned rows' empty locate slot keeps the check column x-aligned (no grid track does it now)",
  /\.building-panel \.zone-animal-locate-slot\s*\{[\s\S]*?width: 24px;/.test(css));
check("Name/Cat/Prof sort headers expose arrow buttons", /\[\["name", "Name"\], \["category", "Cat"\], \["profession", "Prof"\]\]/.test(clientSource) && /data-zone-animal-sort/.test(clientSource));
check("bottom search field includes the native magnifier", /cls: "zone-animal-search"/.test(clientSource) && /dataAttr: "zone-animal-search"/.test(clientSource) && /magnifier: true/.test(clientSource));

console.log("\n# resize and mutation continuity");
check("animal list consumes the framework panel's available height", /\.building-panel\.zone-animal-panel \.zone-animal-list\s*\{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;[\s\S]*?max-height: none;/.test(css));
check("mutation captures and restores the inner list scroll", /const scrollTop = animalList\?\.scrollTop \|\| 0;[\s\S]*?await openZoneUnitsPanel\(data\.id, \{ scrollTop, keepUnit: unit \}\)/.test(clientSource));
check("restored mutation keeps the clicked row visible", /restore\.keepUnit[\s\S]*?kept\.offsetTop[\s\S]*?animalList\.scrollTop/.test(clientSource));

console.log("\n# TEST-THE-TEST seeded-bad predicates");
const oldBroken = u => {
  if (!u.active || u.dead) return false;
  if (u.ownRace || u.ownCiv) return false;
  return !!u.tame || !!u.contained || !!u.builtCage;
};
const tamePet = fixtures[0][1];
check("old own-civ rejection fails the fort-owned tame-pet cell", oldBroken(tamePet) !== nativeAssignable(tamePet));
const mutantAllowsWild = u => !!u.active && !u.dead && !!u.animal;
const wild = fixtures.find(([name]) => name === "uncaged wild animal")[1];
check("mutant that admits uncaged wild animals fails the wild cell", mutantAllowsWild(wild) !== nativeAssignable(wild));
const cagedDwarf = fixtures.find(([name]) => name === "caged citizen dwarf")[1];
check("mutant that admits every caged captive fails the caged-dwarf cell", (!!cagedDwarf.contained) !== nativeAssignable(cagedDwarf));
check("mutant assigned-here bypass fails an assigned dwarf", true !== nativeAssignable(fixtures[2][1], true));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
