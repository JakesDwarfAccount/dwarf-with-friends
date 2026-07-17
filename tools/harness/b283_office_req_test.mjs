// b283_office_req_test.mjs -- OFFLINE contract + regression witness for B283:
// "office/noble requirements ALWAYS show unsatisfied even when native DF shows them satisfied."
//
//   node tools/harness/b283_office_req_test.mjs   (exit 0 PASS / 1 FAIL)
//
// WHAT THE BUG WAS (server, src/fort_admin.cpp holder_owned_rooms):
//   In v50 a noble's assigned rooms are CIVZONES. df::unit::owned_buildings is a
//   vector<building_civzonest*>, and the ROOM KIND is each civzone's own `type`
//   (df::civzone_type::{Office,Bedroom,DiningHall,Tomb}) -- exactly how DFHack's own
//   plugins/preserve-rooms.cpp classifies the same list. The old code instead switched
//   `bld->getType()` -- which is building_type::Civzone for EVERY entry in that vector --
//   against Chair/Bed/Table/Coffin, so no case ever matched and roomsSatisfied was ALWAYS
//   false. Every required room rendered red ("not satisfied") no matter what the noble owned.
//
// This test cannot run the C++ (DLL-gated), so it (1) models both the legacy and fixed
// server classification against known-adequate / known-inadequate fixtures and asserts the
// legacy one reproduces the always-unsatisfied bug while the fixed one matches DF's own
// preserve-rooms rule, and (2) drives the REAL client renderer to prove that a satisfied
// server verdict shows the player "satisfied" and an unsatisfied one shows "not satisfied".

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const webJs = name => join(here, "..", "..", "web", "js", name);
const modPath = webJs("dwf-fort-admin.js");

// Boot the same globals the concatenated browser bundle provides (see cim_nobles_test.mjs).
globalThis.DWFUI = require(webJs("dwf-ui-components.js"));
globalThis.escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const P = require(webJs("dwf-fort-panels.js"));
globalThis.fortUnitRef = P.fortUnitRef;
globalThis.fortPrettyKey = P.fortPrettyKey;

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("node --check fort-admin.js", true); }
catch (e) { check("node --check fort-admin.js", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);

// ---- DF's real model, mirrored from df/civzone_type.h + preserve-rooms.cpp -------------------
// A noble's owned_buildings entry is a civzone: it carries a civzone `type`, and (because it is a
// building_civzonest) its building_type is always Civzone.
const CIV = { Office: 93, Bedroom: 92, DiningHall: 80, Tomb: 97, MeetingHall: 8 }; // df::civzone_type
const zone = civType => ({ civType, buildingType: "Civzone" });

// FIXED server (src/fort_admin.cpp holder_owned_rooms, post-B283): classify by the civzone's type.
function classifyFixed(ownedBuildings) {
  const owned = { office: false, bedroom: false, dining: false, tomb: false };
  for (const z of ownedBuildings) {
    if (z.civType === CIV.Office) owned.office = true;
    else if (z.civType === CIV.Bedroom) owned.bedroom = true;
    else if (z.civType === CIV.DiningHall) owned.dining = true;
    else if (z.civType === CIV.Tomb) owned.tomb = true;
  }
  return owned;
}

// LEGACY server (what main shipped): switch the entry's furniture building_type against
// Chair/Bed/Table/Coffin. Every entry is a Civzone, so nothing ever matches -> all false.
function classifyLegacy(ownedBuildings) {
  const owned = { office: false, bedroom: false, dining: false, tomb: false };
  for (const z of ownedBuildings) {
    switch (z.buildingType) {
      case "Chair":  owned.office = true;  break;
      case "Bed":    owned.bedroom = true; break;
      case "Table":  owned.dining = true;  break;
      case "Coffin": owned.tomb = true;    break;
      default: break;
    }
  }
  return owned;
}

// ---- Fixtures the player can see -------------------------------------------------------------
// Known-ADEQUATE: a noble who owns an office (+ bedroom/dining/tomb). Native DF shows all satisfied.
const adequateRooms = [zone(CIV.Office), zone(CIV.Bedroom), zone(CIV.DiningHall), zone(CIV.Tomb)];
// Known-INADEQUATE for OFFICE specifically: owns bedroom/dining/tomb but NO office zone.
const noOfficeRooms = [zone(CIV.Bedroom), zone(CIV.DiningHall), zone(CIV.Tomb)];

console.log("\n# FIXED server classification reflects DF's own room model (preserve-rooms rule)");
const fixAdequate = classifyFixed(adequateRooms);
check("known-adequate office -> office satisfied === true", fixAdequate.office === true);
check("known-adequate also satisfies bedroom/dining/tomb",
  fixAdequate.bedroom && fixAdequate.dining && fixAdequate.tomb);
const fixNoOffice = classifyFixed(noOfficeRooms);
check("known-inadequate (no office zone) -> office satisfied === false", fixNoOffice.office === false);
check("known-inadequate still satisfies the rooms it DOES own",
  fixNoOffice.bedroom === true && fixNoOffice.tomb === true);

console.log("\n# REGRESSION WITNESS: the legacy field-mapping reproduces the always-unsatisfied bug");
const legAdequate = classifyLegacy(adequateRooms);
check("legacy: a noble WITH an adequate office STILL reads office === false (the bug)",
  legAdequate.office === false);
check("legacy: every required room reads unsatisfied regardless of ownership",
  legAdequate.office === false && legAdequate.bedroom === false &&
  legAdequate.dining === false && legAdequate.tomb === false);
// The fix must actually change behaviour for the known-adequate case.
check("fix changes the visible verdict for a known-adequate office (false -> true)",
  legAdequate.office === false && fixAdequate.office === true);

console.log("\n# server verdict -> what the PLAYER sees (real client renderer)");
// The /nobles row the server emits for the known-adequate noble.
const rowSatisfied = {
  filled: true, unitId: 7,
  rooms: { office: 100, bedroom: 100, dining: 100, tomb: 100, box: 0 },
  roomsSatisfied: fixAdequate,
};
const stSat = M.nobleRoomIconStates(rowSatisfied);
check("adequate office icon state === GOOD", M.nobleRoomSpriteState(stSat[0]) === "GOOD");
check("adequate office reads the word 'satisfied' to the player",
  /satisfied/.test(M.nobleRoomIconHtml(stSat[0])) && !/not satisfied/.test(M.nobleRoomIconHtml(stSat[0])));

// The row the BUGGY server emitted for that same noble (all false) -> red "not satisfied".
const rowBug = {
  filled: true, unitId: 7,
  rooms: { office: 100, bedroom: 100, dining: 100, tomb: 100, box: 0 },
  roomsSatisfied: legAdequate,
};
const stBug = M.nobleRoomIconStates(rowBug);
check("buggy server verdict makes the office render MISSING / 'not satisfied'",
  M.nobleRoomSpriteState(stBug[0]) === "MISSING" && /not satisfied/.test(M.nobleRoomIconHtml(stBug[0])));

console.log(`\n${failed ? "FAIL" : "PASS"} - b283_office_req  (${passed} ok, ${failed} failed)`);
process.exit(failed ? 1 : 0);
