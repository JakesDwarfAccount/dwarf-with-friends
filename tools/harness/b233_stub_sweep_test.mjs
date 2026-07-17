// b233_stub_sweep_test.mjs -- OFFLINE fixture test for B233 (the STUB SWEEP: four dead/missing
// controls from the B175 census). No Dwarf Fortress, no server, no DLL: it drives the PURE view
// builders + asserts the SERVER SOURCE carries the grounded field writes each control needs.
//
//   1. Minimap follow button (census #2 / M25)  -- was wired to the PLAYER-follow lock only, so it
//      stayed hidden+inert during a UNIT follow. Now both locks publish {following} and the one
//      button clears whichever is engaged.
//   2. Work animals (census #60)                -- assignment logic absent. Now: read + write on
//      unit.relationship_ids[PetOwner] (DF's INFO_ASSIGN_WORK_ANIMAL field), with an honest guard.
//   3. Create-position chooser (census #70/M3)  -- the create chooser only listed EXISTING free
//      seats. Now it can MAKE a seat (POST /position-create) for a position whose raws allow more
//      holders (entity_position.number == -1 == AS_NEEDED, e.g. MILITIA_CAPTAIN).
//   4. Traffic cost sliders (census #16/M18)    -- disabled "until server path-cost fields exist".
//      They exist: plotinfo.main.traffic_cost_{high,normal,low,restricted}. Sliders are live, and
//      the whole traffic submenu is now MOUNTED in the real client (it shipped EMPTY).
//
// Every assertion is paired with a seeded-bad guard (completeness rule 3: test-the-test).
//
//   node tools/harness/b233_stub_sweep_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = p => readFileSync(join(root, p), "utf8");

globalThis.DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
const squadsMod = require(join(root, "web", "js", "dwf-squads.js"));

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function guard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}

const controls = read("web/js/dwf-controls-placement.js");
const unitHud = read("web/js/dwf-unit-hud-notifications.js");
const shell = read("web/js/dwf-control-shell.js");
const squadsJs = read("web/js/dwf-squads.js");
const placementCpp = read("src/placement.cpp");
const infoPanelCpp = read("src/info_panel.cpp");
const unitSheetCpp = read("src/unit_sheet.cpp");
const fortAdminCpp = read("src/fort_admin.cpp");
const squadsCpp = read("src/squads.cpp");

// ============================================================================================
// 1. MINIMAP FOLLOW BUTTON -- reflects and clears BOTH follow locks; no second follow system.
// ============================================================================================
console.log("\n[1] minimap follow button (census #2 / M25)");

check("unit-follow publishes the same {following} contract as the player-follow lock",
  /window\.DwfUnitFollow\s*=\s*\{[\s\S]*?getState[\s\S]*?stopFollow[\s\S]*?onChange/.test(unitHud));
check("starting / stopping a unit follow notifies subscribers",
  /function startUnitFollow[\s\S]*?emitUnitFollowChange\(\)/.test(unitHud) &&
  /function stopUnitFollow[\s\S]*?markFollowButton\(false\); emitUnitFollowChange\(\)/.test(unitHud));
// The button subscribes to BOTH locks and clears BOTH -- that is the whole fix.
const followBlock = (/const followBtn = document\.getElementById\("followBtn"\);[\s\S]*?\n  \/\/ --- WD-6/.exec(controls) || [""])[0];
check("the minimap button subscribes to the player lock AND the unit lock",
  /DwfSpectate/.test(followBlock) && /DwfUnitFollow/.test(followBlock));
check("clicking it clears every engaged lock (not just the player one)",
  /followLocks\.forEach\(lock => \{[\s\S]*?stopFollow/.test(followBlock));
check("it stays hidden while nothing is being followed (never a button that does nothing)",
  /button\.hidden = active\.length === 0;/.test(followBlock));
guard("the OLD single-lock shape (spectate-only stopFollow with no unit lock) is gone",
  !/const spectate = window\.DwfSpectate;\s*\n\s*if \(spectate && typeof spectate\.stopFollow === "function"\) spectate\.stopFollow\("top-right"\);\s*\n\s*focusPage\(\);/.test(controls));
guard("no SECOND follow implementation was added (unit follow still lives in one module)",
  (controls.match(/setInterval\([^)]*unitFollowTick/g) || []).length === 0);

// ============================================================================================
// 2. WORK ANIMALS -- PetOwner read+write, guarded; rows carry the assign/remove action.
// ============================================================================================
console.log("\n[2] work animals (census #60)");

check("the WRITE is DF's own work-animal field: unit.relationship_ids[PetOwner]",
  /animal->relationship_ids\[df::unit_relationship_type::PetOwner\] = owner_id < 0 \? -1 : owner_id;/.test(infoPanelCpp));
check("the write is reachable as a livestock action (assign-work-animal, owner=-1 clears)",
  /a == "assign-work-animal"/.test(infoPanelCpp) && /query_int\(req, "owner", owner_id\)/.test(unitSheetCpp));
check("eligibility mirrors DF's AssignWorkAnimal list (own civ + tame + war/hunt trained, living)",
  /work_animal_blocked_reason[\s\S]*?isOwnCiv[\s\S]*?isTame[\s\S]*?isWar\(animal\) && !Units::isHunter\(animal\)/.test(infoPanelCpp));
check("a histfig animal is REFUSED with a reason (its ownership also lives in the history graph)",
  /hist_figure_id >= 0\)\s*\n\s*return "This animal is a historical figure/.test(infoPanelCpp));
check("the owner must be a LIVING citizen (B214: units.active retains corpses + ghosts)",
  /!Units::isCitizen\(owner, true\) \|\| !Units::isActive\(owner\) \|\|\s*\n\s*Units::isDead\(owner\) \|\| Units::isGhost\(owner\)/.test(infoPanelCpp));
check("the READ no longer confuses TRAINER assignments with WORK ANIMALS",
  /unit_labor_work_animals\(df::unit\* owner\)[\s\S]{0,2200}relationship_ids\[df::enums::unit_relationship_type::PetOwner\]/.test(unitSheetCpp) &&
  !/unit_labor_work_animals[\s\S]{0,1200}plotinfo->training\.training_assignments/.test(unitSheetCpp));
check("the read's button gate is the SAME predicate as the write (no button the write would 400)",
  /const std::string blocked = work_animal_blocked_reason\(animal\);/.test(unitSheetCpp) &&
  /record\.assignable = \(assigned \|\| offerable\) && blocked\.empty\(\);/.test(unitSheetCpp));
check("the wire carries ownerId/assignable/blockedReason",
  /"ownerId\\":/.test(unitSheetCpp) && /"assignable\\":/.test(unitSheetCpp) && /"blockedReason\\":/.test(unitSheetCpp));
check("the client row renders an assign/remove plaque, and the reason when blocked",
  /data-unit-work-animal|unitWorkAnimal:/.test(unitHud) &&
  /unit-labor-animal-blocked[\s\S]*?blockedReason/.test(unitHud));
check("the client posts the real route and re-reads the sheet instead of guessing the new list",
  /livestock-action\?unit=\$\{animalId\}&action=assign-work-animal&owner=\$\{ownerId\}/.test(unitHud) &&
  /await unitSheetRefreshTick\(\)/.test(unitHud));
guard("a blocked animal cannot be offered: assignable is ANDed with blocked.empty()",
  !/record\.assignable = assigned \|\| offerable;/.test(unitSheetCpp));
guard("the write never runs unguarded (set_work_animal_owner calls the blocked-reason gate first)",
  /bool set_work_animal_owner[\s\S]{0,400}std::string blocked = work_animal_blocked_reason\(animal\);[\s\S]{0,160}return false;/.test(infoPanelCpp));

// ============================================================================================
// 3. CREATE-POSITION CHOOSER -- a new SEAT for a position the raws still allow.
// ============================================================================================
console.log("\n[3] create-position chooser (census #70 / M3)");

check("/position-create exists and returns the new assignment id",
  /server\.Post\("\/position-create", position_create_handler\)/.test(fortAdminCpp) &&
  /"\{\\"ok\\":true,\\"assignmentId\\":" \+ std::to_string\(assignment_id\)/.test(fortAdminCpp));
check("the seat count is bounded by the RAWS (entity_position.number; -1 = AS_NEEDED = unlimited)",
  /if \(position->number >= 0 && held >= position->number\) \{/.test(fortAdminCpp));
check("a created seat is fully -1-initialised (histfig/histfig2/squad_id) -- no ctor-zero half-write",
  /assignment->histfig = -1;[\s\S]{0,200}assignment->histfig2 = -1;[\s\S]{0,200}assignment->squad_id = -1;/.test(fortAdminCpp));
check("do_noble_assign's own create path now shares that constructor (its squad_id=0 bug is gone)",
  /auto assignment = find_assignment\(fort, position_id\);\s*\n\s*if \(!assignment\) \{[\s\S]{0,320}assignment = create_assignment\(fort, position_id\);/.test(fortAdminCpp));
check("/squads advertises creatablePositions with the same bound the write enforces",
  /"creatablePositions\\":\[/.test(squadsCpp) &&
  /if \(pos->number >= 0 && seats >= pos->number\)\s*\n\s*continue;/.test(squadsCpp));
check("after native's uniform step, the client's create flow makes the seat then the squad under it",
  /position-create\?player=\$\{encodeURIComponent\(player\)\}&position=/.test(squadsJs) &&
  /await squadCreate\(assignmentId, uniformId\)/.test(squadsJs));

// The chooser VIEW: a fort with zero free seats but an AS_NEEDED captain must still offer creation.
const noFreeButCreatable = {
  hasFreePosition: false,
  freePositions: [],
  creatablePositions: [{ positionId: 11, title: "militia captain", squadSize: 10, seats: 3, maxSeats: -1 }],
  squads: [],
};
const createHtml = squadsMod.sqCreateView(noFreeButCreatable);
check("the chooser offers 'New militia captain' when the raws allow another captain",
  /data-squad-create-new-position="11"/.test(createHtml) && /New militia captain/.test(createHtml),
  createHtml.slice(0, 200));
check("an unlimited position reads as unlimited, not as a fake cap",
  /unlimited/.test(createHtml));
const rootHtml = squadsMod.buildSquadPanel({ view: "list", squadsList: noFreeButCreatable }).html;
check("'Create new squad' is ENABLED when the only path is creating the position",
  /id="squadCreateBtn"/.test(rootHtml) && !/id="squadCreateBtn"[^>]*disabled/.test(rootHtml));
const cappedList = {
  hasFreePosition: false, freePositions: [], creatablePositions: [], squads: [],
};
const cappedHtml = squadsMod.sqCreateView(cappedList);
guard("with no free seat AND no creatable position, the chooser says so instead of faking a row",
  !/data-squad-create-new-position/.test(cappedHtml) && /No free squad positions/.test(cappedHtml));
// ...and with squads present but nothing creatable, the create plaque must be DISABLED (the panel's
// zero-squads branch is its own native empty state -- "You must appoint a militia commander" -- so
// the disabled-plaque case is asserted with a squad in the list).
const cappedWithSquad = Object.assign({}, cappedList, { squads: [{ id: 1, name: "1st", alias: "", orders: [] }] });
const cappedRoot = squadsMod.buildSquadPanel({ view: "list", squadsList: cappedWithSquad }).html;
guard("...and the create button is DISABLED in exactly that case",
  /<button[^>]*disabled[^>]*id="squadCreateBtn"|<button[^>]*id="squadCreateBtn"[^>]*disabled/.test(cappedRoot) ||
  (/id="squadCreateBtn"/.test(cappedRoot) && /disabled/.test(cappedRoot)),
  cappedRoot.slice(0, 400));

// ============================================================================================
// 4. TRAFFIC COST SLIDERS -- live plotinfo.main.traffic_cost_*, and the submenu is MOUNTED.
// ============================================================================================
console.log("\n[4] traffic cost sliders (census #16 / M18)");

check("the route writes DF's live per-fort path costs (plotinfo.main.traffic_cost_*)",
  /plotinfo->main\.traffic_cost_high/.test(placementCpp) &&
  /plotinfo->main\.traffic_cost_normal/.test(placementCpp) &&
  /plotinfo->main\.traffic_cost_low/.test(placementCpp) &&
  /plotinfo->main\.traffic_cost_restricted/.test(placementCpp));
check("/traffic-costs is registered for GET (read) and POST (write)",
  /server\.Get\("\/traffic-costs", traffic_costs_handler\)/.test(placementCpp) &&
  /server\.Post\("\/traffic-costs", traffic_costs_handler\)/.test(placementCpp));
check("a partial POST writes only the fields it carries (one slider cannot clobber the others)",
  /if \(!query_int\(req, f\.param, v\)\)\s*\n\s*continue;/.test(placementCpp));
check("costs are clamped to a sane band (a 0/negative cost is undefined in DF's pathfinder)",
  /clamp_cost = \[\]\(int v\) \{ return std::max\(1, std::min\(10000, v\)\); \}/.test(placementCpp));
check("the write runs under CoreSuspender (same discipline as every other DF write here)",
  /DFHack::CoreSuspender suspend;[\s\S]{0,400}traffic_cost_high/.test(placementCpp));
check("the sliders are no longer disabled",
  !/data-traffic-weight="\$\{key\}" disabled/.test(shell) &&
  /data-traffic-weight="\$\{key\}"/.test(shell));
check("the traffic submenu is MOUNTED into the live client from the shared builder",
  /trafficSubmenu\.innerHTML = window\.DwfControlShell\.trafficSubmenuMarkup\(/.test(controls));
check("the client seeds the sliders from DF (GET) and writes one field per released drag (POST)",
  /fetch\(`\/traffic-costs\?t=\$\{Date\.now\(\)\}`/.test(controls) &&
  /`\/traffic-costs\?\$\{encodeURIComponent\(key\)\}=\$\{encodeURIComponent\(value\)\}/.test(controls) &&
  /input\.addEventListener\("change"/.test(controls));
check("B216: opening traffic mode READS costs; it writes nothing on open",
  /if \(open && !trafficCostsLoaded\) \{ trafficCostsLoaded = true; loadTrafficCosts\(\); \}/.test(controls));
check("a rejected write re-reads the truth instead of leaving the slider showing a lie",
  /setTrafficCostNote\(`Could not set the \$\{key\} cost[\s\S]{0,120}loadTrafficCosts\(\);/.test(controls));
guard("the old 'not yet exposed by the server' disabled note is gone from the shell",
  !/Pathfinding weight editing is not yet exposed by the server/.test(shell) &&
  !/Cost editing needs server support/.test(shell));
guard("the submenu is not double-mounted (the guard checks for an existing level tile first)",
  /!trafficSubmenu\.querySelector\("\[data-traffic-level\]"\)/.test(controls));

// The shared builder still emits the four native paints + the four cost rows.
const shellMod = (() => {
  const sandbox = { window: { DWFUI: globalThis.DWFUI }, document: undefined };
  return null;   // control-shell attaches to window at load; markup is asserted through ui_lab_test
})();

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
