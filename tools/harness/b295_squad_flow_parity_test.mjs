// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// B295: native squad flow is screen-to-screen. Offline screen truth only; no DF/server/browser.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
globalThis.DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
const squads = require(join(root, "web/js/dwf-squads.js"));
const js = readFileSync(join(root, "web/js/dwf-squads.js"), "utf8");
const guardJs = readFileSync(join(root, "web/js/dwf-write-guards.js"), "utf8");
const cpp = readFileSync(join(root, "src/squads.cpp"), "utf8");
const guardsCpp = readFileSync(join(root, "src/write_guards.cpp"), "utf8");

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}

const detail = {
  squad: {
    id: 9, name: "The Growls of Inking", alias: "", positionCount: 2,
    members: [
      { idx: 0, unitId: 10, name: "Urist Leader", positionName: "Leader", filled: true, topSkills: ["Axe 8"] },
      { idx: 1, unitId: -1, name: "", positionName: "Member", filled: false, topSkills: [] },
    ],
  },
  candidates: [
    { unitId: 20, name: "Domas Adequate", profession: "Miner", topSkills: ["Axe 5"] },
    { unitId: 21, name: "Atir Novice", profession: "Brewer", topSkills: ["Wrestling 1"] },
  ],
};
const squadsList = {
  hasFreePosition: true,
  freePositions: [
    { assignmentId: 41, title: "Captain of the guard's squad", holderName: "Logem", category: "existing", squadSize: 10 },
    { assignmentId: 42, title: "New militia captain's squad", appointLabel: "appointed by militia commander", category: "appoint", squadSize: 10 },
  ],
  creatablePositions: [
    { positionId: 12, title: "Militia captain's squad", category: "new", seats: 2, maxSeats: -1, squadSize: 10 },
  ],
  squads: [],
};
const base = { squadsList, squadDetail: detail, squadSelectedId: 9, squadCandidatePos: 0 };

console.log("# position roster and dedicated candidate transition");
const positions = squads.buildSquadPanel({ ...base, view: "positions" });
check("position roster stays in the narrow squad sidebar", positions.wide === false);
check("position roster has inline exact-position transitions", /data-squad-pick-pos="0"/.test(positions.html) && /data-squad-pick-pos="1"/.test(positions.html));
check("position roster does not stack candidate controls", !/sq-candidate-row|data-sq-cyc="addUnit"|id="squadAddPos"|id="squadAssignBtn"/.test(positions.html));
check("occupied position has no per-row Remove plaque", !/data-squad-remove=/.test(positions.html));

const candidate = squads.buildSquadPanel({ ...base, view: "candidate", squadCandidatePos: 0,
  isHost: false });
check("candidate selector is a distinct wide screen", candidate.wide === true && /sq-candidate-screen/.test(candidate.html));
check("candidate selector targets one exact slot", /data-squad-assign-pos="0"/.test(candidate.html));
check("candidate rows are the controls, without duplicate Assign plaques", /data-squad-assign-unit="20"/.test(candidate.html) && !/>Assign</.test(candidate.html));
check("Remove assignment is first-class inside the candidate screen", /data-squad-remove-assignment="10"/.test(candidate.html));
check("candidate screen has no cycler or manual slot stepper", !/data-sq-cyc="addUnit"|id="squadAddPos"/.test(candidate.html));
check("assignment and removal return to the position roster",
  /squadStatusMsg = "Member assigned\.";\s*squadView = "positions"/.test(js) &&
  /squadStatusMsg = "Member removed\.";\s*squadView = "positions"/.test(js));

console.log("\n# position-0 is assigned like any other slot (probe guard removed, verified live 2026-07-17)");
const pos0Host = squads.buildSquadPanel({ ...base, view: "candidate", squadCandidatePos: 0,
  isHost: true }).html;
const pos0Remote = squads.buildSquadPanel({ ...base, view: "candidate", squadCandidatePos: 0,
  isHost: false }).html;
check("pos-0 host sees the normal candidate screen -- no lock, no enable control",
  /sq-candidate-screen/.test(pos0Host) && /data-squad-assign-pos="0"/.test(pos0Host) &&
  !/data-squad-pos0-enable/.test(pos0Host) && !/sq-pos0-locked/.test(pos0Host));
check("pos-0 remote sees the same live candidate screen (no refusal)",
  /sq-candidate-screen/.test(pos0Remote) && /data-squad-assign-unit="20"/.test(pos0Remote) &&
  !/data-squad-pos0-enable/.test(pos0Remote));
check("client no longer posts a squad_pos0 write-guard-config toggle",
  !/write-guard-config/.test(js) && !/squad_pos0/.test(js));
check("server no longer enumerates a squad_pos0 enable route",
  !/write-guard-config/.test(guardsCpp) && !/kSquadPos0Flag/.test(guardsCpp));
check("the pos-0 seat runs unguarded -- no hostwrite gate before seat_leader_at_pos0",
  !/hostwrite_enabled/.test(cpp) && /squad_pos == 0[\s\S]{0,160}seat_leader_at_pos0/.test(cpp));
check("the guard removal is documented with the live-verification note",
  /VERIFIED LIVE 2026-07-17/.test(cpp));

console.log("\n# create categories then uniform step");
const create = squads.buildSquadPanel({ ...base, view: "create" }).html;
check("all three native create categories remain distinct in order",
  create.indexOf('data-create-category="existing"') < create.indexOf('data-create-category="appoint"') &&
  create.indexOf('data-create-category="appoint"') < create.indexOf('data-create-category="new"'));
check("the three native create vectors remain separate groups without invented headings",
  (create.match(/data-create-category-group=/g) || []).length === 3);
const uniforms = { uniforms: [{ id: 7, name: "Melee, metal armor" }, { id: 8, name: "Crossbows, leather armor" }] };
const createUniform = squads.buildSquadPanel({ ...base, view: "create-uniform", uniformCatalog: uniforms,
  createPending: { kind: "assignment", id: 41, title: "Captain of the guard's squad" } });
check("create uniform is the second small-dialog screen", createUniform.dialog === true && /Choose a uniform for/.test(createUniform.html));
check("uniform choices and terminal No uniform are row actions",
  /data-squad-create-uniform="7"/.test(createUniform.html) && /data-squad-create-uniform="-1"/.test(createUniform.html) && /No uniform/.test(createUniform.html));
check("choosing leader transitions to uniform state instead of posting create immediately",
  /querySelectorAll\("\[data-squad-create-position\]"\)[\s\S]{0,700}squadView\s*=\s*"create-uniform"/.test(js));
check("create route accepts and applies the selected template to all positions",
  /uniform_id/.test(cpp) && /apply_uniform_to_position_locked/.test(cpp));

console.log("\n# DF-sourced candidate order proxy");
check("candidate records retain strongest effective military skill for sorting", /best_skill_level/.test(cpp));
check("candidate list is sorted strongest-skill first with deterministic name tie-break", /state\.candidates[\s\S]{0,500}std::sort/.test(cpp));
check("UI never labels the proxy as native suitability", !/suitability score/i.test(candidate.html));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
