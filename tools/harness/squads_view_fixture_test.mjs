// squads_view_fixture_test.mjs -- OFFLINE fixture test for the B60 squad-UI parity restructure
// (docs/superpowers/specs/2026-07-09-squad-ui-parity-spec.md). No Dwarf Fortress, no server:
// it seeds ground-truth /squads + /squad + /uniforms payloads and asserts the PURE view
// builders exported by web/js/dwf-squads.js -- one screen per native screenshot. The
// central regression it guards is B60 itself: the narrow LIST screen must NOT contain any of
// the dense multi-column editor grids (those moved to their own WIDE screens). Seeded-bad
// cases (completeness rule 3) confirm each assertion discriminates.
//
//   node tools/harness/squads_view_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-squads.js");
const squadsCppPath = join(here, "..", "..", "src", "squads.cpp");
const cssPath = join(here, "..", "..", "web", "css", "dwf.css");
const sharedCss = readFileSync(cssPath, "utf8");
globalThis.DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function checkGuard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}

// node --check (the module must load as a script AND be require-able via its export guard).
try {
  execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-squads.js passes node --check");
} catch (e) {
  if (e && e.code === "EPERM") {
    console.log("  skip - nested node --check blocked by sandbox; run node --check explicitly");
  } else {
    failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
  }
}

const M = require(modPath);
const EXPORTS = ["buildSquadPanel", "sqListRows", "sqOrdersSummary", "sqOrderToolbar",
  "sqPositionsView", "sqCandidateRows", "sqCreateView", "sqEquipView", "sqUniformEditor", "sqAmmoSection", "sqScheduleView", "sqPatrolView"];
check("module exports the pure view builders", EXPORTS.every(k => typeof M[k] === "function"),
  EXPORTS.filter(k => typeof M[k] !== "function").join(","));

// ---------------- ground-truth payloads ----------------
const squadsList = {
  hasFreePosition: true,
  freePositions: [
    { assignmentId: 41, positionId: 10, title: "Captain of the guard's squad", holderName: "Logem Kalanakrul", appointLabel: "", squadSize: 10 },
    { assignmentId: 42, positionId: 11, title: "New militia captain's squad", holderName: "", appointLabel: "appointed by militia commander", squadSize: 10 },
  ],
  squads: [
    { id: 1, name: "1st Legion", alias: "The Lined Tours", routineName: "Staggered training",
      memberCount: 5, positionCount: 9, orders: [] },
    { id: 2, name: "2nd Legion", alias: "", routineName: "Off duty",
      memberCount: 0, positionCount: 10, orders: [{ index: 0, type: "kill", description: "Kill the goblin" }] },
  ],
};
const squadDetail = {
  squad: {
    id: 1, name: "1st Legion", alias: "The Lined Tours", routineIdx: 2, routineName: "Staggered training",
    memberCount: 1, positionCount: 2,
    orders: [{ index: 0, type: "move", description: "Move to 10,10,5" }],
    members: [
      { idx: 0, unitId: 100, name: "Urist McAxe", positionName: "Leader", filled: true, uniformItems: 5, topSkills: ["Axe"], uniformDetails: [
        { cat: 0, index: 0, itemType: 2, subtype: 0, itemName: "breastplate", materialClass: 16, materialClassName: "Armor", mattype: 0, matindex: 5, materialName: "iron", color: -1, colorName: "", choice: 0, assignedCount: 1 },
        { cat: 6, index: 0, itemType: 24, subtype: 3, itemName: "battle axe", materialClass: -1, materialClassName: "any", mattype: 0, matindex: 7, materialName: "copper", color: 2, colorName: "rust", choice: 2, assignedCount: 1 },
      ] },
      { idx: 1, unitId: -1, name: "", positionName: "Member", filled: false, uniformItems: 0, topSkills: [] },
    ],
  },
  candidates: [{ unitId: 200, name: "Cog Cavernshield", profession: "Stonecutter", topSkills: ["Sword"] }],
  uniforms: [{ id: 7, name: "Metal armor" }],
  routines: [{ idx: 0, name: "Off duty" }, { idx: 2, name: "Staggered training" }],
  schedule: Array.from({ length: 12 }, (_, m) => ({ month: m, name: "", sleep: "none", uniform: "none", orderCount: m === 0 ? 2 : 0 })),
  ammo: [{ index: 0, subtype: 0, ammoName: "Bolts", materialClass: 14, materialName: "metal", amount: 100, combat: true, training: false }],
  ammoDefs: [{ subtype: 0, name: "bolts", ammoClass: "bolt" }],
  // 5.4 supplies + 7.2/7.3 full per-routine schedule (additive detail fields).
  supplies: { food: 2, water: "drink" },
  routineSchedules: [
    { idx: 0, name: "Off duty", months: Array.from({ length: 12 }, (_, m) => ({ month: m, sleep: "anywhere", uniform: "civilian", orderCount: 0, orderLabel: "No orders", hasTrain: false, minCount: 0 })) },
    { idx: 2, name: "Staggered training", months: Array.from({ length: 12 }, (_, m) => ({ month: m, sleep: "anywhere", uniform: "regular", orderCount: (m % 2) ? 1 : 0, orderLabel: (m % 2) ? "Train" : "No orders", hasTrain: !!(m % 2), minCount: (m % 2) ? 8 : 0, assignedPositions: m === 1 ? [0] : [] })) },
  ],
};
const uniformCatalog = {
  uniforms: [{ id: 7, name: "Metal armor", replaceClothing: true, exactMatches: false,
    items: [{ cat: 0, subtype: -1, materialClass: 16, materialName: "metal", color: -1, choice: 0 }] }],
  subtypes: { 0: [{ subtype: 0, name: "breastplate" }], 6: [{ subtype: 3, name: "short sword" }] },
  materialClasses: [{ value: -1, name: "any" }, { value: 16, name: "Armor" }],
  materials: [{ mattype: 0, matindex: 5, name: "iron" }, { mattype: 0, matindex: 7, name: "copper" }],
  colors: [{ value: 2, name: "rust" }, { value: 3, name: "buff" }],
};
const model = (over) => Object.assign({ view: "list", squadsList, squadDetail, uniformCatalog,
  squadSelectedId: 1, uniformSelectedId: 7, equipTab: "uniform" }, over);

// ---------------- LIST screen (native 1 + 2) ----------------
console.log("\n# list screen");
{
  const { wide, html } = M.buildSquadPanel(model({ view: "list" }));
  check("list is NOT wide (stays in the 208px sidebar)", wide === false);
  check("list has the create-new-squad control", /id="squadCreateBtn"/.test(html) && /Create new squad/.test(html));
  check("row 1 shows emblem swatch", /class="sq-emblem"/.test(html));
  check("row 1 shows per-row Positions nav", /data-squad-positions="1"/.test(html));
  check("row 1 name rendered through the runtime bitmap system",
    /data-dwfui-bitmap-text="The Lined Tours"/.test(html));
  check("squad with no orders summarised 'No special orders'", /No special orders/.test(html));
  check("squad WITH an order shows its description (row 2)", /Kill the goblin/.test(html));
  check("routine surfaced in the row", /Staggered training/.test(html));
  // WAVE 4 S2 (S2-squads-evidence CORRECTION-2, R1/R2): the list row is the TABLE chassis --
  // flat, hatched, hairline-separated -- and selection REPAINTS NOTHING. The old assertion pinned
  // the hand-built path (a red/green slab + a gold bracket); it now REJECTS it.
  // WAVE 4 S2 / DEFECT S1: the row is ALSO `stacked` -- the two-band chassis modifier. The pin used
  // to end at `dwfui-row--table"`, i.e. it required the row to carry NO modifier, which is exactly the
  // 19px single-line row the owner filed against. It now requires the modifier and still rejects the slab.
  check("list rows use the native TABLE chassis + the STACKED two-band modifier, never the slab",
    /class="dwfui-row sq-item dwfui-row--table dwfui-row--stacked"/.test(html) &&
    !/dwfui-row--slab/.test(html) && !/dwfui-row--on/.test(html) && !/dwfui-row--off/.test(html));
  check("selection paints NO outline and NO bracket on a squad row (the green check IS the affordance)",
    !/dwfui-row--sel-outline/.test(html) && !/dwfui-row--sel-brackets/.test(html));
  check("row select box is the 2-state native check TILE, not the triState mark",
    /class="dwfui-check sq-item-check on"[^>]*data-squad-select="1"/.test(html) &&
    /data-dwfui-sprite="SQUADS_SELECTED"/.test(html) && /data-dwfui-sprite="SQUADS_NOT_SELECTED"/.test(html) &&
    !/class="dwfui-mark check"/.test(html) && !/class="dwfui-mark x"/.test(html) && !/sq-rowcheck/.test(html));
  check("row control tiles are real DF sprites, not the chess pawn / emoji",
    /data-dwfui-sprite="SQUADS_POSITIONS"/.test(html) && /data-dwfui-sprite="UNIT_SHEET_CUSTOMIZE"/.test(html) &&
    !/&#9823;/.test(html) && !/sq-rowicon/.test(html));
  // selected squad -> order toolbar + nav + rename + delete
  check("selected squad shows Station order button", /id="squadOrderMoveBtn"/.test(html));
  check("selected squad shows click-to-target Kill order button without a unit-id input",
    /id="squadOrderKillBtn"/.test(html) && !/id="squadKillTarget"/.test(html));
  check("selected squad shows Train button", /id="squadOrderTrainBtn"/.test(html));
  check("nav row links to positions/equip/schedule", /data-squad-nav="positions"/.test(html) && /data-squad-nav="equip"/.test(html) && /data-squad-nav="schedule"/.test(html));
  check("selected squad shows rename + delete", /id="squadRenameInput"/.test(html) && /id="squadDeleteBtn"/.test(html));
  check("selected squad w/ no list-row orders shows bitmap 'No current orders'",
    /data-dwfui-bitmap-text="No current orders\."/.test(html));
  check("all visible selected-list dynamic copy uses bitmap text, not inherited TTF",
    /data-dwfui-bitmap-text="No special orders"/.test(html) &&
    /data-dwfui-bitmap-text="Routine:Staggered training · 5\/9 members"/.test(html) &&
    /class="sq-sel-name"[^>]*>[\s\S]{0,180}?data-dwfui-bitmap-text="The Lined Tours"/.test(html));
}
// A selected squad whose /squads row carries an order shows it + a per-order Cancel.
{
  const { html } = M.buildSquadPanel(model({ view: "list", squadSelectedId: 2 }));
  check("current order listed with per-order cancel", /Kill the goblin/.test(html) && /data-squad-order-cancel="0"/.test(html));

  // *** B60 REGRESSION GUARD ***: none of the dense editor grids may appear on the narrow list.
  check("B60: list has NO positions grid", !/class="sq-pos-row"/.test(html));
  check("B60: list has NO ammunition grid", !/class="sq-ammo-row"/.test(html));
  check("B60: list has NO schedule grid", !/class="sq-schedule-row"/.test(html));
  check("B60: list has NO uniform-template editor", !/class="sq-ucat"/.test(html));
  check("B60: list has NO uniform-assign grid", !/class="sq-uassign-row"/.test(html));
  // TEST-THE-TEST: prove the guard would FIRE if an editor grid leaked in (i.e. the regex is real).
  checkGuard("B60 guard is a real detector", /class="sq-ammo-row"/.test('<div class="sq-ammo-row"></div>'));

  // Patrol and defend-burrow are served and open their native editor/picker screens.
  check("Patrol shown and enabled", /id="squadOrderPatrolBtn"(?![^>]*disabled)/.test(html));
  check("Defend burrow shown AND enabled (server now serves defend-burrow)", /id="squadOrderBurrowBtn"(?![^>]*disabled)/.test(html));
  checkGuard("would catch a re-disabled Patrol", !/id="squadOrderPatrolBtn"(?![^>]*disabled)/.test('<button id="squadOrderPatrolBtn" disabled>Patrol</button>'));
  // TEST-THE-TEST: a DISABLED Defend button (regression to the old GAP) must be detectable as wrong.
  checkGuard("would catch a re-disabled Defend", !/id="squadOrderBurrowBtn"(?![^>]*disabled)/.test('<button id="squadOrderBurrowBtn" disabled>Defend</button>'));
}

// ---------------- PATROL route editor (native 2.3) ----------------
console.log("\n# patrol route editor (native screen 2.3)");
{
  const empty = M.buildSquadPanel(model({ view: "patrol", squadPatrolDraft: { name: "Route 1", points: [] } }));
  check("patrol editor IS wide", empty.wide === true);
  check("patrol editor has route name + map-click instruction", /id="patrolRouteName"[^>]*value="Route 1"/.test(empty.html) && /Click the map to add points/.test(empty.html));
  check("empty patrol disables Confirm", /id="patrolConfirmBtn"[^>]*disabled/.test(empty.html));
  const one = M.buildSquadPanel(model({ view: "patrol", squadPatrolDraft: { name: "Gate loop", points: [{ x: 12, y: 20, z: 4 }] } }));
  // WAVE 4 S2 (R9): a native patrol row is `Point N` + a trash tile -- NO coordinates, no z. The
  // coordinate span was computed and read by nobody (S2-deletion-audit A14, the file's one true
  // deletion). The DRAFT still carries the points; only the display string is gone.
  check("one-point patrol lists the point and remains disabled",
    /Point 1</.test(one.html) && /data-patrol-remove="0"/.test(one.html) &&
    /id="patrolConfirmBtn"[^>]*disabled/.test(one.html));
  check("patrol rows no longer print raw world coordinates", !/x 12, y 20, z 4/.test(one.html));
  const two = M.buildSquadPanel(model({ view: "patrol", squadPatrolDraft: { name: "Gate loop", points: [{ x: 12, y: 20, z: 4 }, { x: 18, y: 20, z: 4 }] } }));
  check("two distinct points enable Confirm", /id="patrolConfirmBtn"(?![^>]*disabled)/.test(two.html));
  check("patrol points are individually removable", (two.html.match(/data-patrol-remove=/g) || []).length === 2);
  const duplicate = M.buildSquadPanel(model({ view: "patrol", squadPatrolDraft: { name: "Bad", points: [{ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }] } }));
  checkGuard("duplicate coordinates do not satisfy the route minimum", /id="patrolConfirmBtn"[^>]*disabled/.test(duplicate.html));
}
// empty state: no squads AND no free militia-captain position.
{
  const { html } = M.buildSquadPanel(model({ view: "list", squadsList: { hasFreePosition: false, squads: [] }, squadSelectedId: -1, squadDetail: null }));
  check("empty state prompts for a militia commander", /militia commander/.test(html) && /sq-empty-state/.test(html));
  checkGuard("empty state has no create button", !/id="squadCreateBtn"/.test(html));
}
// XSS: a malicious alias must be escaped in the list row.
{
  const evil = { hasFreePosition: true, squads: [{ id: 3, name: "x", alias: '<img src=x onerror=alert(1)>', routineName: "r", memberCount: 0, positionCount: 1, orders: [] }] };
  const { html } = M.buildSquadPanel(model({ view: "list", squadsList: evil, squadSelectedId: 3, squadDetail: null }));
  checkGuard("malicious alias HTML-escaped", !/<img/.test(html) && /&lt;img/.test(html));
}

// ---------------- CREATE screen (native 8) ----------------
console.log("\n# create squad screen");
{
  const { wide, html } = M.buildSquadPanel(model({ view: "create" }));
  check("create chooser IS wide", wide === true);
  check("create chooser asks native question", /Create which squad\?/.test(html));
  check("create chooser lists every served free position", (html.match(/data-squad-create-position=/g) || []).length === 2);
  check("create chooser shows existing-holder and appointed-by rows", /Captain of the guard's squad/.test(html) && /Logem Kalanakrul/.test(html) && /appointed by militia commander/.test(html));
  check("create chooser row posts the selected assignment id", /data-squad-create-position="41"/.test(html) && /data-squad-create-position="42"/.test(html));
  check("create chooser choices reuse the shared green slab component",
    (html.match(/class="dwfui-row sq-pos-row sq-create-row dwfui-row--slab dwfui-row--on"/g) || []).length === 2);
  const none = M.buildSquadPanel(model({ view: "create", squadsList: Object.assign({}, squadsList, { freePositions: [], hasFreePosition: false }) }));
  check("create chooser graceful when no free positions remain", /No free squad positions/.test(none.html) && !/data-squad-create-position/.test(none.html));
  checkGuard("would catch an occupied position leaking into the chooser", (('<button data-squad-create-position="99"></button>').match(/data-squad-create-position=/g) || []).length !== 2);
}

// ---------------- POSITIONS screen (native 4 / 4.1) ----------------
console.log("\n# positions screen");
{
  const { wide, html } = M.buildSquadPanel(model({ view: "positions" }));
  check("positions stays in native's narrow squad sidebar", wide === false);
  check("positions has back-to-squads header", /id="squadBackBtn"/.test(html) && /Back to squads/.test(html));
  check("positions lists the occupied leader and empty member slot", /Urist McAxe/.test(html) &&
    /data-squad-pick-pos="0"/.test(html) && /Assign position 1/.test(html));
  check("filled and empty positions both transition by exact position", /data-squad-pick-pos="0"/.test(html) &&
    /data-squad-pick-pos="1"/.test(html));
  check("roster does not stack candidates, cycler, Assign button, or manual slot stepper",
    !/sq-candidate-row|data-sq-cyc="addUnit"|id="squadAssignBtn"|id="squadAddPos"/.test(html));
  checkGuard("would catch a positions screen that lost its candidate transition",
    !/data-squad-pick-pos/.test('<div>no chooser</div>'));

  const candidate = M.buildSquadPanel(model({ view: "candidate", squadCandidatePos: 0,
    isHost: false }));
  check("candidate chooser is a separate wide screen", candidate.wide === true && /sq-candidate-screen/.test(candidate.html));
  check("native candidate roster shows profession and assigns the exact selected position",
    /Stonecutter/.test(candidate.html) && /data-squad-assign-unit="200"/.test(candidate.html) &&
    /data-squad-assign-pos="0"/.test(candidate.html));
  check("Remove assignment lives inside the candidate screen",
    /data-squad-remove-assignment="100"/.test(candidate.html));
  // B249 probe guard REMOVED (verified live 2026-07-17): pos 0 is now a plain candidate screen for
  // host AND remote -- no locked branch, no enable control, no commander-only copy.
  const pos0Host = M.buildSquadPanel(model({ view: "candidate", squadCandidatePos: 0,
    isHost: true })).html;
  check("pos-0 host gets the live candidate screen, not a lock",
    /sq-candidate-screen/.test(pos0Host) && /data-squad-assign-pos="0"/.test(pos0Host) &&
    !/data-squad-pos0-enable/.test(pos0Host) && !/sq-pos0-locked/.test(pos0Host));
  checkGuard("would catch a re-introduced pos-0 lock branch",
    !/sq-pos0-locked/.test('<div class="sq-candidate-screen"></div>'));
}

// ---------------- EQUIP screen (native 5 / 5.1 / 5.2 / 5.3) ----------------
console.log("\n# equip screen");
{
  const tabIds = M.EQUIP_TABS.map(t => t[0]);
  check("equip sub-tab order includes production Details last", JSON.stringify(tabIds) === JSON.stringify(["uniform", "add", "ammo", "supplies", "details"]));
  checkGuard("would catch a mis-ordered tab set", JSON.stringify(tabIds) !== JSON.stringify(["ammo", "add", "uniform", "supplies"]));

  const uni = M.buildSquadPanel(model({ view: "equip", equipTab: "uniform" }));
  check("equip IS wide", uni.wide === true);
  check("equipment screens retain the shared squad rail", /class="sq-equip-layout"/.test(uni.html) &&
    /class="sq-equip-context"/.test(uni.html) && /class="sq-list"/.test(uni.html) && /id="squadCreateBtn"/.test(uni.html));
  check("equip uses native equipment header, not the invented Back-to-squads header",
    !/id="squadBackBtn"/.test(uni.html) && /Update equipment/.test(uni.html));
  check("equip tabbar in order uniform->add->ammo->supplies", /data-equip-tab="uniform"[\s\S]*data-equip-tab="add"[\s\S]*data-equip-tab="ammo"[\s\S]*data-equip-tab="supplies"/.test(uni.html));
  check("Supplies and Details are both active production tabs", /data-equip-tab="supplies"/.test(uni.html) && /data-equip-tab="details"/.test(uni.html) && !/data-equip-tab="details"[^>]*disabled/.test(uni.html));
  check("Assign-uniform tab: template pane + dense per-position equipment matrix",
    /class="sq-uniform-template-pane"/.test(uni.html) && /data-uniform-template="7"/.test(uni.html) &&
    /class="sq-uassign-row sq-uassign-matrix-row"/.test(uni.html) && /data-uniform-apply="0"/.test(uni.html) &&
    /data-equipment-details="0"/.test(uni.html) && /data-dwfui-sprite="SQUADS_INSPECT"/.test(uni.html));

  const ammo = M.buildSquadPanel(model({ view: "equip", equipTab: "ammo" }));
  check("Ammo tab: existing spec row + add controls", /class="sq-ammo-row"/.test(ammo.html) && /Bolts/.test(ammo.html) && /id="squadAmmoAddBtn"/.test(ammo.html));
  checkGuard("Ammo tab does NOT render the uniform-assign grid", !/class="sq-uassign-row"/.test(ammo.html));

  const add = M.buildSquadPanel(model({ view: "equip", equipTab: "add" }));
  check("Add-uniform tab: template editor with all 7 categories", /Body armor/.test(add.html) && /Helm/.test(add.html) && /Legwear/.test(add.html) && /Gloves/.test(add.html) && /Footwear/.test(add.html) && /Shield/.test(add.html) && /Weapon/.test(add.html));
  check("Add-uniform tab: create/rename/delete + flags", /id="uniformCreateBtn"/.test(add.html) && /id="uniformRenameBtn"/.test(add.html) && /id="uniformDeleteBtn"/.test(add.html) && /id="uniformFlagsBtn"/.test(add.html));
  check("weapon category exposes individual-choice select", /sq-uitem-choice/.test(add.html));
  const addBlank = M.buildSquadPanel(model({ view: "equip", equipTab: "add", uniformSelectedId: -1 }));
  check("Add-uniform starts as native's blank composer, not an existing template editor",
    /class="sq-uniform-blank-head"/.test(addBlank.html) && /&lt;enter name here&gt;/.test(addBlank.html) &&
    /Confirm and save uniform/.test(addBlank.html) && !/id="uniformRenameInput"/.test(addBlank.html));

  const details = M.buildSquadPanel(model({ view: "equip", equipTab: "details", equipmentPosition: 0 }));
  check("Details renders the selected position's served equipment specs", /Position 1/.test(details.html) && /iron breastplate/.test(details.html) && /copper battle axe/.test(details.html));
  check("each equipment row exposes Mat, Color, and remove actions", /data-equipment-material="0:0"/.test(details.html) && /data-equipment-color="0:0"/.test(details.html) && /data-equipment-remove="0:0"/.test(details.html));
  check("Details exposes all seven native New equipment categories", (details.html.match(/data-equipment-add=/g) || []).length === 7);
  check("Details ends with the two native uniform-policy controls",
    /Uniform worn over clothing/.test(details.html) && /Exact matches only/.test(details.html));

  const material = M.buildSquadPanel(model({ view: "equip", equipTab: "details", equipmentPosition: 0, equipmentPicker: { kind: "material", cat: 0, index: 0 } }));
  check("material picker shows broad classes and concrete materials", /Select material\./.test(material.html) && /data-equipment-pick-material="class:16"/.test(material.html) && /data-equipment-pick-material="material:0:5"/.test(material.html));
  const color = M.buildSquadPanel(model({ view: "equip", equipTab: "details", equipmentPosition: 0, equipmentPicker: { kind: "color", cat: 0, index: 0 } }));
  check("color picker shows any color and served descriptor colors", /Select color\./.test(color.html) && /data-equipment-pick-color="-1"/.test(color.html) && /rust/.test(color.html));
  check("material/color selectors use the full-width native row + shared scrollbar grammar",
    /sq-picker-row/.test(material.html) && /data-dwfui-scroll-key="squads:picker:material"/.test(material.html) &&
    /data-dwfui-scroll-key="squads:picker:color"/.test(color.html));
}

// ---------------- B158 squads-UX: dropdowns beside titles + wider editor ----------------
// A playtester (registry B158): "The squads UI could scale better to be bigger and have the dropdown
// menus next to the 'helm' like titles". Two asks, pinned here:
//   (1) placement -- the add-item dropdowns share the SAME row as each category's "Helm"-like
//       title (a left label column), with the existing-items list rendering AFTER that row;
//   (2) sizing   -- the wide editor variant scales past the old 680px cap (CSS).
console.log("\n# B158 squads-UX (dropdowns beside category titles, wider editor)");
{
  const add = M.buildSquadPanel(model({ view: "equip", equipTab: "add" }));
  // (1a) head + add-controls are siblings inside one .sq-ucat-top row (adjacent markup).
  check("B158: category head + add-controls share the sq-ucat-top row",
    /<div class="sq-ucat-top">\s*<div class="sq-ucat-head">[^<]*<\/div>\s*<div class="sq-controls sq-uitem-add"/.test(add.html));
  // (1b) within ONE category block the dropdowns precede the existing-items list.
  const oneCat = add.html.slice(add.html.indexOf('class="sq-ucat"'));
  const topIdx = oneCat.indexOf("sq-ucat-top");
  const subIdx = oneCat.indexOf("sq-uitem-subtype");
  const listIdx = oneCat.indexOf("sq-uitem-list");
  check("B158: the add dropdowns sit inside the top row, before the items list",
    topIdx >= 0 && subIdx > topIdx && listIdx > subIdx);
  // TEST-THE-TEST: the OLD stacked layout (title, then items list, then dropdowns) must fail (1a).
  const stackedBad = '<div class="sq-ucat"><div class="sq-ucat-head">Helm</div>' +
    '<div class="sq-uitem-list"></div><div class="sq-controls sq-uitem-add"></div></div>';
  checkGuard("B158 placement guard rejects the old stacked (title / list / dropdown) layout",
    !/<div class="sq-ucat-top">\s*<div class="sq-ucat-head">[^<]*<\/div>\s*<div class="sq-controls sq-uitem-add"/.test(stackedBad));

  // (2) sizing: the wide squads panel scales above the retired 680px cap.
  const css = readFileSync(cssPath, "utf8");
  const wideRule = /\.squads-wide\s*\{\s*width:\s*min\((\d+)px/.exec(css);
  const wideWidth = wideRule ? Number(wideRule[1]) : 0;
  check("B158: wide squads panel width bumped above the old 680px cap", wideWidth > 680);
  // TEST-THE-TEST: a regression back to the old 680px value would fail the '> 680' assertion.
  checkGuard("B158 sizing guard: an extractor reads the old 680px as NOT bigger",
    !(Number((/min\((\d+)px/.exec("width: min(680px, 66vw)") || [])[1]) > 680));
}

// ---------------- SCHEDULE screen (native 7) ----------------
console.log("\n# schedule screen");
{
  const { wide, html } = M.buildSquadPanel(model({ view: "schedule" }));
  check("schedule IS wide", wide === true);
  // B252: the routine column is no longer an inert <section> -- it is a DWFUI selectCell (the whole
  // COLUMN is the click target, with radio semantics). The two-column count and the
  // no-12-month-editor guard are unchanged; only the element the count lands on moved.
  check("schedule uses native routine-column overview, not the wrong 12-month editor",
    /class="sq-schedule-overview"/.test(html) && (html.match(/class="dwfui-selectcell sq-schedule-routine\b/g) || []).length === 2 &&
    /Off duty/.test(html) && /Staggered training/.test(html) && !/class="sq-schedule-row"/.test(html) && !/data-month-sleep/.test(html));
  check("routine COLUMNS (not just their headers) carry the active-routine capability",
    /data-schedule-routine="0"/.test(html) && /data-schedule-routine="2"/.test(html) &&
    /role="radiogroup"/.test(html) && (html.match(/role="radio"/g) || []).length === 2);
  check("schedule retains the shared right squad rail", /class="sq-context-layout"/.test(html) && /class="sq-equip-context"/.test(html));
  check("routine columns include Edit-or-Clear plus Copy grammar", /sq-schedule-edit/.test(html) && /sq-schedule-copy/.test(html));
  check("Add/edit routines + View monthly schedule are active nav", /data-squad-nav="routines"/.test(html) && /data-squad-nav="monthly"/.test(html));
}

// ---------------- SCHEDULE empty state: a squad/fort with NO routines yet ----------------
// Slice-1 repair: the old empty branch returned a bare "Schedule unavailable." and DROPPED the
// Add/edit routines control, so a fresh squad could never author its first routine. The empty state
// must keep the routine-authoring path (routine-create is fort-global, independent of any routine
// already existing) and read as an empty state, not an error.
console.log("\n# schedule empty state (no routines)");
{
  const emptySched = Object.assign({}, squadDetail, { routines: [], routineSchedules: [] });
  const { html } = M.buildSquadPanel(model({ view: "schedule", squadDetail: emptySched }));
  check("empty schedule still offers 'Add/edit routines' authoring",
    /data-squad-nav="routines"/.test(html));
  check("empty schedule reads as an empty state, not 'Schedule unavailable'",
    /No military routines exist yet/.test(html) && !/Schedule unavailable/.test(html));
  check("empty schedule keeps the squad rail for switching", /class="sq-equip-context"/.test(html));
  // TEST-THE-TEST: a regression to the bare unavailable message would carry no routines nav.
  checkGuard("empty-schedule guard: a bare-message regression exposes no routine-authoring nav",
    !/data-squad-nav="routines"/.test(`<div class="info-message">Schedule unavailable.</div>`));
}

// ---------------- Rail order toolbar is LIVE in the deep-editor views ----------------
// Slice-1 repair: sqRootPane (the squad rail) renders the selected squad's order strip
// (Kill/Station/Patrol/Defend/Train/Cancel) in the equip AND schedule/routines/monthly views, but
// renderSquadsPanel used to wire it only for `squadView === "list"` -- so those rail tiles were dead.
// This is a DOM-wiring concern (no jsdom here), so it is guarded at the source level: the wiring call
// must be UNCONDITIONAL, and the equip/schedule rails must actually contain the toolbar it wires.
console.log("\n# rail order toolbar wiring (equip/schedule)");
{
  const src = readFileSync(modPath, "utf8");
  check("order-toolbar wiring is no longer gated to the list view",
    !/if\s*\(\s*squadView\s*===\s*"list"\s*\)\s*wireSquadOrderControls/.test(src));
  check("renderSquadsPanel wires the order toolbar unconditionally when a squad is selected",
    /\n\s*wireSquadOrderControls\(squad\);/.test(src));
  // The rail order strip that this wiring targets is present in the equip and schedule views.
  const equip = M.buildSquadPanel(model({ view: "equip", equipTab: "uniform" }));
  const sched = M.buildSquadPanel(model({ view: "schedule" }));
  check("equip rail carries the order toolbar the wiring targets",
    /id="squadOrderMoveBtn"/.test(equip.html) && /id="squadOrderKillBtn"/.test(equip.html));
  check("schedule rail carries the order toolbar the wiring targets",
    /id="squadOrderMoveBtn"/.test(sched.html) && /id="squadOrderKillBtn"/.test(sched.html));
}

// ---------------- SUPPLIES tab (native 5.4) ----------------
console.log("\n# supplies (native screen 5.4)");
{
  const { wide, html } = M.buildSquadPanel(model({ view: "equip", equipTab: "supplies" }));
  check("supplies IS wide (equip screen)", wide === true);
  check("supplies prompt matches native", /Supplies carried by each squad member/.test(html));
  check("food options 3/2/1/No food present", /data-supply-food="3"/.test(html) && /data-supply-food="2"/.test(html) && /data-supply-food="1"/.test(html) && /data-supply-food="0"/.test(html));
  check("water options drink/water/nowater present", /data-supply-water="drink"/.test(html) && /data-supply-water="water"/.test(html) && /data-supply-water="nowater"/.test(html));
  // The seven hand-rolled `.sq-supply-btn` are now ONE segmented control per row (native's
  // HORIZONTAL_OPTION_* radiogroup: the selected segment carries GOLD CORNER BRACKETS, never a fill).
  // The served value is the segment with aria-checked="true" -- and exactly ONE segment per row may
  // carry it, which the old `.on`-class assertion never checked.
  check("served food value is the ACTIVE segment (food=2), and only that one",
    /aria-checked="true" data-supply-food="2"/.test(html) &&
    (html.match(/aria-checked="true" data-supply-food/g) || []).length === 1);
  check("served water value is the ACTIVE segment (drink), and only that one",
    /aria-checked="true" data-supply-water="drink"/.test(html) &&
    (html.match(/aria-checked="true" data-supply-water/g) || []).length === 1);
  // graceful: a build that serves no supplies -> message, no buttons.
  const bare = M.buildSquadPanel(model({ view: "equip", equipTab: "supplies", squadDetail: Object.assign({}, squadDetail, { supplies: undefined }) }));
  check("supplies graceful when absent (old DLL)", /does not serve squad supplies/.test(bare.html) && !/data-supply-food/.test(bare.html));
  checkGuard("would catch a supplies tab missing its food buttons", !/data-supply-food/.test('<div>no buttons</div>'));
}

// ---------------- ROUTINES editor (native 7.1) ----------------
console.log("\n# routines (native screen 7.1)");
{
  const { wide, html } = M.buildSquadPanel(model({ view: "routines" }));
  check("routines IS wide", wide === true);
  check("routines back header present", /id="squadBackBtn"/.test(html));
  check("routines titled 'Military routines'", /Military routines/.test(html));
  check("each routine has a rename input carrying its idx", /data-routine-idx="0"/.test(html) && /data-routine-idx="2"/.test(html));
  check("routine names populated", /value="Off duty"/.test(html) && /value="Staggered training"/.test(html));
  check("routines have rename + delete controls", /sq-routine-rename/.test(html) && /sq-routine-delete/.test(html));
  check("routine rows use compact input + quill + delete grammar (no Rename plaque)",
    /data-dwfui-sprite="UNIT_SHEET_CUSTOMIZE"/.test(html) && /data-dwfui-sprite="STOCKS_DUMP"/.test(html) &&
    !/>Rename routine<\//.test(html));
  check("'Add new routine' control present", /id="routineAddBtn"/.test(html) && /id="routineNewName"/.test(html));
  checkGuard("would catch a routines view missing its rows", !/data-routine-idx/.test('<div>Military routines</div>'));
}

// ---------------- MONTHLY grid (native 7.2) ----------------
console.log("\n# monthly (native screen 7.2)");
{
  const { wide, html } = M.buildSquadPanel(model({ view: "monthly" }));
  check("monthly IS wide", wide === true);
  check("monthly has back header", /id="squadBackBtn"/.test(html));
  check("monthly header lists routine columns", /Off duty/.test(html) && /Staggered training/.test(html));
  check("monthly lists all 12 month rows + header", /Granite/.test(html) && /Obsidian/.test(html) && (html.match(/class="sq-month-row/g) || []).length === 13);
  check("monthly cells show order labels", /Train/.test(html) && /No orders/.test(html));
  check("monthly Edit buttons carry routine+month coords", /data-train-routine="2"[^>]*data-train-month="1"|data-train-month="1"[^>]*data-train-routine="2"/.test(html));
  check("every monthly cell places Copy beside Edit", (html.match(/sq-month-copy/g) || []).length === 24);
  // graceful: no routineSchedules served -> message, no grid.
  const bare = M.buildSquadPanel(model({ view: "monthly", squadDetail: Object.assign({}, squadDetail, { routineSchedules: [] }) }));
  check("monthly graceful when full schedule not served", /does not serve the full monthly schedule/.test(bare.html) && !/class="sq-month-cell"/.test(bare.html));
  checkGuard("would catch a monthly grid missing its month rows", (('<div></div>').match(/class="sq-month-row/g) || []).length !== 13);
}

// ---------------- TRAINING editor (native 7.3) ----------------
console.log("\n# training (native screen 7.3)");
{
  // month 1 of routine 2 (Staggered) is a TRAIN month (minCount 8) in the seed.
  const { wide, html } = M.buildSquadPanel(model({ view: "training", trainingSel: { routine: 2, month: 1 } }));
  check("training IS wide", wide === true);
  check("training back-to-schedule header", /Back to schedule/.test(html));
  check("training names the routine + month being edited", /Editing routine Staggered training/.test(html) && /Slate/.test(html));
  check("training has Equip (uniform) + Sleep choosers, as native segmented controls",
    /data-train-uniform="regular"/.test(html) && /data-train-sleep="anywhere"/.test(html) &&
    /aria-checked="true" data-train-sleep="anywhere"/.test(html) && !/<select/.test(html));
  // The Train checkbox is now the 2-state native check TILE: SQUADS_SELECTED when on. A tile is
  // rendered in BOTH states (native never renders nothing), so the ON state is aria-pressed + sprite.
  check("training Train toggle reflects the served order (the ON check tile)",
    /id="trainOrder"[^>]*class="dwfui-check on"/.test(html) &&
    /id="trainOrder"[^>]*aria-pressed="true"/.test(html) &&
    /data-dwfui-sprite="SQUADS_SELECTED"/.test(html));
  check("training min-soldiers input seeded from minCount (8)", /id="trainMin"[^>]*value="8"/.test(html));
  check("training has a Save button", /id="trainSaveBtn"/.test(html));
  check("training includes the native per-position assignment roster and checkbox column",
    (html.match(/class="sq-training-member"/g) || []).length === 2 &&
    (html.match(/data-training-position=/g) || []).length >= 2 && /class="dwfui-scroll sq-training-roster/.test(html));
  // a NON-train month -> toggle unchecked, min 0.
  const off = M.buildSquadPanel(model({ view: "training", trainingSel: { routine: 2, month: 0 } }));
  check("training non-train month -> the OFF check tile (a real tile, not nothing), min 0",
    /id="trainOrder"[^>]*aria-pressed="false"/.test(off.html) &&
    /data-dwfui-sprite="SQUADS_NOT_SELECTED"/.test(off.html) &&
    /id="trainMin"[^>]*value="0"/.test(off.html));
  // graceful: unknown routine/month -> message.
  const bad = M.buildSquadPanel(model({ view: "training", trainingSel: { routine: 99, month: 0 } }));
  check("training graceful for an unserved routine", /does not serve the editable schedule/.test(bad.html));
  checkGuard("would catch a training editor missing its Save", !/id="trainSaveBtn"/.test('<div>editing</div>'));
}

// ---------------- EMBLEM badge + edit screen (native 3, squads-client2) ----------------
console.log("\n# emblem (native screen 3)");
const emblem = { symbol: 6, fg: { r: 0, g: 0, b: 255 }, bg: { r: 255, g: 255, b: 255 } }; // ★ blue on white
{
  // Row badge: absent emblem -> read-only placeholder <span>, NO edit entry (graceful old DLL).
  const noEmblemSwatch = M.sqEmblemSwatch({ id: 9, name: "X" });
  check("absent emblem -> read-only placeholder swatch, no edit entry",
    /class="sq-emblem"/.test(noEmblemSwatch) && !/data-squad-emblem/.test(noEmblemSwatch) && !/<button/.test(noEmblemSwatch));
  // Served emblem -> faithful TWO-colour badge (bg + fg) that is a click target -> edit screen.
  const withEmblemSwatch = M.sqEmblemSwatch({ id: 9, name: "X", emblem });
  check("served emblem -> two-colour badge + edit entry",
    /data-squad-emblem="9"/.test(withEmblemSwatch) && /background:rgb\(255,255,255\)/.test(withEmblemSwatch) && /color:rgb\(0,0,255\)/.test(withEmblemSwatch));
  check("served emblem renders the symbol glyph (id 6 = star)", /★/.test(withEmblemSwatch));
  // TEST-THE-TEST: the seeded-bad case -- an emblem edit button on an emblem-LESS badge -- must be
  // caught by the absent-check above. Prove the detector actually fires on that bad string.
  checkGuard("would catch an edit-button leaking onto an emblem-less badge (seeded bad)",
    /data-squad-emblem/.test('<button class="sq-emblem" data-squad-emblem="9"></button>'));
  // Mixed list: squad 1 served an emblem, squad 2 not -> only squad 1 is clickable.
  const mixed = { hasFreePosition: true, squads: [
    Object.assign({}, squadsList.squads[0], { emblem }), squadsList.squads[1] ] };
  const { html } = M.buildSquadPanel(model({ view: "list", squadsList: mixed }));
  check("list: emblem-bearing squad gets an edit button", /data-squad-emblem="1"/.test(html));
  check("list: emblem-less squad stays a plain placeholder", !/data-squad-emblem="2"/.test(html));
}
{
  // Emblem edit screen (native 3): symbol grid + fg/bg pickers + preview + Done.
  const emblemDetail = { squad: Object.assign({}, squadDetail.squad, { emblem }) };
  const { wide, html } = M.buildSquadPanel(model({ view: "emblem", squadDetail: emblemDetail }));
  check("emblem screen IS wide", wide === true);
  check("emblem screen has back-to-squads header", /id="squadBackBtn"/.test(html));
  check("emblem screen prompts 'Choose a symbol for the squad.'", /Choose a symbol for the squad\./.test(html));
  check("emblem screen renders all 23 symbol buttons", (html.match(/data-emblem-symbol=/g) || []).length === 23);
  check("emblem screen highlights the current symbol (id 6)", /data-emblem-symbol="6"[^>]*border-color/.test(html));
  check("emblem screen has fg + bg colour inputs bound to served rgb",
    /id="emblemFg"[^>]*value="#0000ff"/.test(html) && /id="emblemBg"[^>]*value="#ffffff"/.test(html));
  check("emblem screen has a live preview badge", /id="emblemPreview"/.test(html) && /background:rgb\(255,255,255\)/.test(html));
  check("emblem screen has a Done (save) button", /id="emblemDoneBtn"/.test(html));
  // Draft override: an in-progress edit is reflected instead of the served emblem.
  const draft = { symbol: 0, fg: { r: 255, g: 0, b: 0 }, bg: { r: 0, g: 0, b: 0 } };
  const dr = M.buildSquadPanel(model({ view: "emblem", squadDetail: emblemDetail, emblemDraft: draft }));
  check("emblem screen honours an in-progress draft", /id="emblemFg"[^>]*value="#ff0000"/.test(dr.html) && /data-emblem-symbol="0"[^>]*border-color/.test(dr.html));
  // Graceful: a squad WITHOUT emblem data cannot be edited -> message, NO grid.
  const bare = M.buildSquadPanel(model({ view: "emblem", squadDetail }));
  check("emblem screen graceful when squad has no emblem data", /does not serve squad-emblem/.test(bare.html) && !/data-emblem-symbol/.test(bare.html));
  // TEST-THE-TEST: a 22-entry (short) glyph table would be caught by the 23-count assertion.
  checkGuard("symbol table is exactly 23 (indices 0..22)", M.SQUAD_SYMBOL_GLYPHS.length === 23);
  check("sqRgbToHex clamps + formats", M.sqRgbToHex({ r: 300, g: -5, b: 16 }) === "#ff0010");
}

// ---------------- DEFEND-BURROW picker (native 2.4, squads-client2) ----------------
console.log("\n# defend-burrow (native screen 2.4)");
{
  const burrows = [{ id: 3, name: "Burrow 1", memberCount: 2 }, { id: 4, name: "Barracks", memberCount: 0 }];
  const { wide, html } = M.buildSquadPanel(model({ view: "burrow", squadBurrows: burrows }));
  check("burrow picker IS wide", wide === true);
  check("burrow picker has back header + prompt", /id="squadBackBtn"/.test(html) && /Select which burrows to defend\./.test(html));
  check("burrow picker lists a native CHECK TILE per burrow",
    (html.match(/class="dwfui-check sq-burrow-check"/g) || []).length === 2 &&
    /Burrow 1/.test(html) && /Barracks/.test(html) && !/type="checkbox"/.test(html));
  check("burrow picker checkboxes carry burrow ids", /data-burrow-id="3"/.test(html) && /data-burrow-id="4"/.test(html));
  check("burrow picker has Confirm + Cancel", /id="burrowDefendConfirmBtn"/.test(html) && /id="burrowDefendCancelBtn"/.test(html));
  // null (fetch failed / route absent on old DLL) -> graceful message, NO confirm control.
  const un = M.buildSquadPanel(model({ view: "burrow", squadBurrows: null }));
  check("burrow picker null -> unavailable message, no confirm", /Burrows unavailable/.test(un.html) && !/id="burrowDefendConfirmBtn"/.test(un.html));
  // empty [] -> distinct "no burrows yet" message, NO confirm control.
  const empty = M.buildSquadPanel(model({ view: "burrow", squadBurrows: [] }));
  check("burrow picker empty -> create-a-burrow-first message, no confirm", /No burrows exist yet/.test(empty.html) && !/id="burrowDefendConfirmBtn"/.test(empty.html));
  // TEST-THE-TEST: a picker that showed Confirm with zero checkboxes (bad) is caught by the count.
  checkGuard("would catch a burrow picker missing its checkbox rows",
    (('<div></div>').match(/class="sq-burrow-check"/g) || []).length !== 2);
}

// ---------------- WAVE 5 / GATE C: the migration itself ----------------
// New assertions for the work Gate C landed. Each names the COMPONENT that must be present and the
// artefact that must be gone -- `assert.match(source, /DWFUI/)` is the failure mode this avoids.
console.log("\n# WAVE 5 / GATE C -- native control adoption");
{
  // ---- 1. THE 33 SQUADS_EQUIPMENT_* SPRITES REACH THE SCREEN (they had ZERO consumers). ----------
  // Native `Squad Menu UI/5. Equip Squad Menu.PNG` draws a slot tile per member row: GREEN when the
  // dwarf has the item, RED when the requirement is unfilled. We rendered "N items" as plain TEXT.
  // The state is SERVED, not invented: uniformDetails[].assignedCount is spec->assigned.size()
  // (src/squads.cpp) -- >=1 means DF matched a real item to the spec, 0 means it stands unfilled.
  const uni = M.buildSquadPanel(model({ view: "equip", equipTab: "uniform" }));
  check("equip member rows render the native equipment SLOT SPRITES, not '5 items' text",
    /data-dwfui-sprite="SQUADS_EQUIPMENT_ARMOR_GOOD"/.test(uni.html) &&
    /data-dwfui-sprite="SQUADS_EQUIPMENT_WEAPON_GOOD"/.test(uni.html) &&
    !/>5 items</.test(uni.html));
  // Both of the seed's uniform specs carry assignedCount 1 -> both GOOD. Flip ONE to 0 and the row
  // must paint MISSING for that slot only -- which proves the state is READ, not hardcoded.
  const missingDetail = JSON.parse(JSON.stringify(squadDetail));
  missingDetail.squad.members[0].uniformDetails[1].assignedCount = 0;   // the battle axe is unassigned
  const miss = M.buildSquadPanel(model({ view: "equip", equipTab: "uniform", squadDetail: missingDetail }));
  check("an UNFILLED requirement (assignedCount 0) paints the MISSING tile, not the GOOD one",
    /data-dwfui-sprite="SQUADS_EQUIPMENT_WEAPON_MISSING"/.test(miss.html) &&
    /data-dwfui-sprite="SQUADS_EQUIPMENT_ARMOR_GOOD"/.test(miss.html) &&
    !/data-dwfui-sprite="SQUADS_EQUIPMENT_WEAPON_GOOD"/.test(miss.html));
  checkGuard("the slot-state detector is real: GOOD and MISSING are two different tokens",
    /_GOOD$/.test("SQUADS_EQUIPMENT_ARMOR_GOOD") && !/_GOOD$/.test("SQUADS_EQUIPMENT_ARMOR_MISSING"));
  // The amber WARNING state has NO field behind it in anything the server sends. Painting it from a
  // guess is exactly the substitution the rules forbid, so it must NEVER be emitted.
  check("the amber _WARNING slot state is NEVER emitted (no served field derives it)",
    !/_WARNING"/.test(uni.html) && !/_WARNING"/.test(miss.html));

  // ---- 2. THE EQUIP NAV IS A GREEN PLAQUE ROW, NOT A TAB ROW (the file's own FOLLOW-UP). ---------
  // The oracle shows FOUR GREEN PLAQUES and no tab shape anywhere on the squad screens. The old
  // nonNativeTabsHtml opt-out was right about the evidence and wrong about the paint: a DECLARED
  // non-native tab row is still a tab row (a tablist role, trapezoid CSS, an aria-selected key).
  check("equip nav is a row of native GREEN PLAQUES (native 5), with no tab grammar at all",
    (uni.html.match(/class="dwfui-plaque green dwfui-plaque--art-neutral sq-tab/g) || []).length === 5 &&
    !/role="tablist"/.test(uni.html) && !/dwfui-nntab/.test(uni.html) && !/aria-selected/.test(uni.html));
  check("the active equip section carries native's FOCUS affordance (gold corner brackets, not a fill)",
    /dwfui-focus-brackets/.test(uni.html) &&
    (uni.html.match(/dwfui-plaque-focus-ornaments/g) || []).length === 1);
  checkGuard("would catch a regression back to the tab grammar",
    /role="tablist"/.test('<div role="tablist"></div>'));

  // ---- 3. THE SMALL LEFT-DOCKED DIALOG (PB-06 / F9-a). ------------------------------------------
  // Measured: create `8.` is 967x990 = a 565px dialog + a 3px gutter + the 391px sidebar; patrol
  // `2.3` (967x991) and defend-burrow `2.4` (968x988) are the SAME dialog. We shipped all three at
  // `.squads-wide` (880px) -- ~3x too wide. modalHtml IS that frame: no header, no close, a prompt.
  for (const [name, over] of [
    ["create", { view: "create" }],
    ["patrol", { view: "patrol", squadPatrolDraft: { name: "Route 1", points: [] } }],
    ["defend-burrow", { view: "burrow", squadBurrows: [{ id: 3, name: "Burrow 1", memberCount: 2 }] }],
  ]) {
    const { dialog, html } = M.buildSquadPanel(model(over));
    check(`${name} renders native's SMALL LEFT-DOCKED DIALOG (modalHtml), not a wide generic panel`,
      dialog === true && /class="dwfui-modal sq-modal/.test(html) &&
      /class="dwfui-modal-prompt"/.test(html) && !/bld-x/.test(html));
  }
  checkGuard("the dialog detector is real: a wide editor screen is NOT flagged as a dialog",
    M.buildSquadPanel(model({ view: "schedule" })).dialog !== true &&
    !/dwfui-modal/.test(M.buildSquadPanel(model({ view: "schedule" })).html));

  // ---- 4. THE LISTS SCROLL THROUGH THE ONE NATIVE SCROLL COMPONENT. -----------------------------
  // The owner, verbatim: "needs to be a proper parity scroll bar element built out in cui that is used for
  // every menu scroll bar. VERY IMPORTANT." Native `6.` and `4.1` both show a scrollbar; before Gate
  // C this file had NO scrollHtml call anywhere.
  const scrolled = [
    ["positions roster", { view: "positions" }, "squads:positions"],
    ["candidate roster", { view: "candidate", squadCandidatePos: 1,
      pos0Guard: { enabled: true, reason: "" } }, "squads:candidates:1"],
    ["uniform-assign list", { view: "equip", equipTab: "uniform" }, "squads:uassign"],
    ["ammo list", { view: "equip", equipTab: "ammo" }, "squads:ammo"],
    ["monthly grid", { view: "monthly" }, "squads:monthly"],
    ["routine list", { view: "routines" }, "squads:routines"],
    ["create chooser", { view: "create" }, "squads:create"],
  ];
  for (const [what, over, key] of scrolled) {
    const { html } = M.buildSquadPanel(model(over));
    check(`${what} scrolls through DWFUI.scrollHtml (preserveKey ${key})`,
      new RegExp(`class="dwfui-scroll [^"]*"[^>]*data-dwfui-scroll-key="${key}"`).test(html));
  }
  check("schedule uses the bounded native routine-column overview rather than a month scroller",
    /class="sq-schedule-overview"/.test(M.buildSquadPanel(model({ view: "schedule" })).html));
  checkGuard("the scroll detector can fail",
    !/data-dwfui-scroll-key="squads:nope"/.test(M.buildSquadPanel(model({ view: "schedule" })).html));

  // ---- 5. NO DROPDOWN SURVIVES ANYWHERE. Native has none in any of the 36 squad captures. -------
  const ALL_VIEWS = ["list", "create", "positions", "candidate", "equip", "schedule", "routines", "monthly",
    "training", "emblem", "burrow", "patrol"];
  const emblemDetail2 = { squad: Object.assign({}, squadDetail.squad,
    { emblem: { symbol: 6, fg: { r: 0, g: 0, b: 255 }, bg: { r: 255, g: 255, b: 255 } } }) };
  const everything = ALL_VIEWS.map(view => ["uniform", "add", "ammo", "supplies", "details"]
    .map(equipTab => M.buildSquadPanel(model({ view, equipTab,
      squadDetail: view === "emblem" ? emblemDetail2 : squadDetail,
      squadBurrows: [{ id: 3, name: "B", memberCount: 0 }],
      trainingSel: { routine: 2, month: 1 },
      squadPatrolDraft: { name: "R", points: [] } })).html).join("")).join("");
  check("NO view renders a dropdown, a raw checkbox, a radio or a raw numeric spinner",
    !/<select/.test(everything) && !/type="checkbox"/.test(everything) &&
    !/type="radio"/.test(everything) && !/<option/.test(everything));
  check("every choice is a plaque, a row, a cycler, a segment, a stepper or a check TILE",
    /dwfui-cycler/.test(everything) && /dwfui-segmented/.test(everything) &&
    /dwfui-check/.test(everything) && /dwfui-plaque/.test(everything) &&
    /dwfui-row/.test(everything) && /dwfui-stepper/.test(everything));
  checkGuard("the dropdown scanner is a real detector", /<select/.test('<select><option>x</option></select>'));
  // The two colour inputs are a KNOWN, REPORTED gap: DWFUI ships no colour component and the
  // Foundation is LOCKED this wave. They are WIRED (/squad-emblem fg+bg), so they STAY (superset rule).
  check("the emblem colour inputs are KEPT (a wired superset; no DWFUI colour component exists yet)",
    /id="emblemFg"/.test(everything) && /id="emblemBg"/.test(everything));
}

// ---------------- unit checks on small pure helpers ----------------
console.log("\n# helpers");
check("sqOrdersSummary empty -> 'No special orders'", M.sqOrdersSummary({ orders: [] }) === "No special orders");
check("sqOrdersSummary joins descriptions", /Kill the goblin/.test(M.sqOrdersSummary(squadsList.squads[1])));
// sqMaterialClassOptions is still the option-list source of truth; it now returns [value,label] PAIRS
// for the cyclers instead of <option> markup (there is no <select> left to render them into). Pinning
// the pairs is stronger than grepping for the word "selected": it asserts the exact wire VALUE.
{
  const opts = M.sqMaterialClassOptions(uniformCatalog, 16);
  check("sqMaterialClassOptions lists every class as a [value,label] pair",
    Array.isArray(opts) && opts.length === 2 &&
    opts.some(o => Number(o[0]) === 16 && /Armor/.test(o[1])) &&
    opts.some(o => Number(o[0]) === -1 && /any/.test(o[1])));
  check("sqMaterialClassOptions with no catalog -> the 'any' (-1) fallback pair",
    JSON.stringify(M.sqMaterialClassOptions(null, -1)) === JSON.stringify([[-1, "any"]]));
  checkGuard("would catch an option list that dropped the wire value",
    !M.sqMaterialClassOptions(uniformCatalog, 16).some(o => Number(o[0]) === 99));
}

// ---------------- non-author counterexample cells (completeness rule 5) ----------------
console.log("\n# non-author counterexamples");
{
  // (a) 0-member squad: supplies + monthly + training are squad-scoped (not member-scoped), so
  //     they must still render for a squad with no filled positions.
  const zeroMember = { squad: Object.assign({}, squadDetail.squad, { members: [], memberCount: 0 }),
    supplies: squadDetail.supplies, routineSchedules: squadDetail.routineSchedules };
  const sup0 = M.buildSquadPanel(model({ view: "equip", equipTab: "supplies", squadDetail: zeroMember }));
  check("supplies renders for a 0-member squad", /data-supply-food="2"/.test(sup0.html));
  const mon0 = M.buildSquadPanel(model({ view: "monthly", squadDetail: zeroMember }));
  check("monthly renders for a 0-member squad", (mon0.html.match(/class="sq-month-row/g) || []).length === 13);

  // (b) month boundary: the training editor must open month 0 (Granite) AND month 11 (Obsidian),
  //     not clamp/lose the first or last.
  const m0 = M.buildSquadPanel(model({ view: "training", trainingSel: { routine: 0, month: 0 } }));
  const m11 = M.buildSquadPanel(model({ view: "training", trainingSel: { routine: 0, month: 11 } }));
  check("training edits month 0 (Granite)", /Granite/.test(m0.html) && /id="trainSaveBtn"/.test(m0.html));
  check("training edits month 11 (Obsidian)", /Obsidian/.test(m11.html) && /id="trainSaveBtn"/.test(m11.html));
  checkGuard("month-boundary guard: a clamp to month 0 would be caught", !/Obsidian/.test(m0.html));

  // (c) empty routine (every month 'No orders'): monthly must show it, and its cells must NOT be
  //     flagged as train months (a builder that always painted train would fail here).
  const off = M.buildSquadPanel(model({ view: "monthly" }));
  check("empty (Off duty) routine cells show 'No orders', not Train", /No orders/.test(off.html));
  checkGuard("empty-routine guard: Off-duty months carry no train flag on every cell",
    (off.html.match(/sq-month-train/g) || []).length < 24); // 12 train cells max (Staggered only), never both columns

  // (d) Ineligible/duplicate cells: the client only renders the server-served eligible roster,
  //     and the squad route refuses a malicious duplicate unit assignment before addToSquad.
  const noDup = M.buildSquadPanel(model({ view: "candidate", squadCandidatePos: 1,
    pos0Guard: { enabled: true, reason: "" },
    squadDetail: Object.assign({}, squadDetail, { candidates: [{ unitId: 201, name: "Free Citizen", profession: "Miner", topSkills: [] }] }) }));
  check("ineligible already-squad-assigned unit is absent from the candidate roster", !/Already Assigned/.test(noDup.html) && /Free Citizen/.test(noDup.html));
  const squadsCpp = readFileSync(squadsCppPath, "utf8");
  check("server refuses duplicate squad assignment explicitly", /unit->military\.squad_id != -1/.test(squadsCpp) && /unit is already assigned to a squad/.test(squadsCpp));
}

// ---------------- B70 multi-target kill order (client view) ----------------
console.log("\n# B70 multi-target kill (native screen 2)");
{
  const killSquad = squadDetail.squad;
  // not armed -> plain Kill button, no confirm/cancel.
  const idle = M.sqOrderToolbar(killSquad, { killArmed: false, killTargets: [] });
  check("idle kill toolbar shows the Kill button only", /id="squadOrderKillBtn"/.test(idle) && !/id="squadOrderKillCancelBtn"/.test(idle));
  // armed, no targets -> prompt + disabled confirm + cancel.
  const armed0 = M.sqOrderToolbar(killSquad, { killArmed: true, killTargets: [] });
  check("armed w/ 0 targets prompts for selection + Cancel", /Select targets on the map/.test(armed0) && /id="squadOrderKillCancelBtn"/.test(armed0));
  check("armed w/ 0 targets disables Confirm", /id="squadOrderKillBtn"[^>]*disabled/.test(armed0));
  // armed, 2 targets -> Confirm (2), two removable chips carrying their unit ids + names.
  const armed2 = M.sqOrderToolbar(killSquad, { killArmed: true, killTargets: [{ id: 501, name: "Goblin Axeman" }, { id: 502, name: "Goblin Bowman" }] });
  // WAVE 4 S2: Confirm is now a native GREEN PLAQUE (bitmap-text label), not a bare .alerts-action.
  check("armed w/ 2 targets shows Confirm (2) on a native plaque",
    /id="squadOrderKillBtn"[^>]*class="dwfui-plaque green[^"]*"/.test(armed2) &&
    /data-dwfui-bitmap-text="Confirm \(2\)"/.test(armed2) && !/alerts-action[^>]*id="squadOrderKillBtn"/.test(armed2));
  check("armed w/ 2 targets marks both units as chips", (armed2.match(/class="sq-kill-mark"/g) || []).length === 2);
  check("chips carry unmark ids + names", /data-kill-unmark="501"/.test(armed2) && /data-kill-unmark="502"/.test(armed2) && /Goblin Axeman/.test(armed2) && /Goblin Bowman/.test(armed2));
  // single-target back-compat: Confirm (1), one chip.
  const armed1 = M.sqOrderToolbar(killSquad, { killArmed: true, killTargets: [{ id: 501, name: "Lone Goblin" }] });
  check("single-target back-compat: Confirm (1) + one chip", /Confirm \(1\)/.test(armed1) && (armed1.match(/class="sq-kill-mark"/g) || []).length === 1);
  // XSS: a malicious target name must be escaped in its chip.
  const evil = M.sqOrderToolbar(killSquad, { killArmed: true, killTargets: [{ id: 9, name: '<img src=x onerror=alert(1)>' }] });
  checkGuard("malicious target name HTML-escaped in chip", !/<img/.test(evil) && /&lt;img/.test(evil));
  // TEST-THE-TEST: the count assertion must fire if a chip leaked/duplicated.
  checkGuard("would catch a wrong chip count", (('<span class="sq-kill-mark"></span>').match(/class="sq-kill-mark"/g) || []).length !== 2);
}

// ---------------- B249 position-0 = APPOINTMENT (was: B94 false restriction) + B70 kill route ----
console.log("\n# B249 position-0 appoints the squad commander (server)");
{
  const cpp = readFileSync(squadsCppPath, "utf8");
  // Create seeds the commanding militia captain/commander at position 0 (native: they immediately lead).
  check("do_squad_create seeds the leader at position 0 after makeSquad",
    /makeSquad\(asn->id\)[\s\S]*?squad_leader_unit\(squad\)[\s\S]*?seat_leader_at_pos0\(squad, leader/.test(cpp));
  // /squad-assign?pos=0 no longer routes through addToSquad (which hard-refuses pos 0) -- it seats the leader.
  check("do_squad_assign handles pos 0 via seat_leader_at_pos0, NOT addToSquad",
    /squad_pos == 0[\s\S]*?seat_leader_at_pos0\(squad, unit/.test(cpp));
  check("the seat helper sets occupant + squad_position 0",
    /pos0->occupant = hf->id;/.test(cpp) && /unit->military\.squad_position = 0;/.test(cpp));
  // B249 CORE. DF's own remove_squad_info (mirrored by DFHack Military::removeFromSquad ->
  // remove_officer_entity_link, Military.cpp:528 + :345) VACATES the squad's noble seat
  // (assignment->histfig = -1) when the dwarf at squad position 0 leaves. So filling position 0
  // is what APPOINTS that dwarf as the squad's militia commander/captain -- it is not a
  // precondition. B94 read the coupling backwards and invented a restriction DF does not have.
  check("B249: NO militia-commander precondition on position 0 (the invented refusals are gone)",
    !/appoint a militia commander\//.test(cpp) && !/not an arbitrary citizen/.test(cpp));
  check("B249: seating position 0 APPOINTS the occupant to the squad's commanding assignment",
    /appoint_squad_leader_position\(/.test(cpp) && /asn->histfig = hf->id;/.test(cpp) &&
    /squad_leader_assignment\(/.test(cpp));
  check("B249: the leader carries the NOBLE (position) entity link, mirroring DF's officer link",
    /histfig_entity_link_positionst/.test(cpp) && /assignment_vector_idx/.test(cpp));
  check("B249: a displaced previous holder is unlinked + recorded as the last holder",
    /unlink_leader_position\(/.test(cpp) && /asn->histfig2 = /.test(cpp));
  // Regression guard: positions 1..9 still go through the (unchanged) addToSquad path.
  check("positions >= 1 still use Military::addToSquad",
    /DFHack::Military::addToSquad\(unit_id, squad_id, squad_pos\)/.test(cpp));
  // TEST-THE-TEST: prove the pos-0 detector is real (would fail if the branch were removed).
  checkGuard("pos-0 leader branch detector is real", /squad_pos == 0/.test(cpp));
  // TEST-THE-TEST: the "no precondition" cell must fire if the old refusal text came back.
  checkGuard("would catch a re-introduced commander precondition",
    /appoint a militia commander\//.test("position 0 is the squad leader -- appoint a militia commander/captain"));

  console.log("\n# B70 multi-target kill route (server)");
  check("do_squad_order_kill accepts a vector of target ids",
    /do_squad_order_kill\(int32_t squad_id, const std::vector<int32_t>& target_unit_ids/.test(cpp));
  check("single-target back-compat overload preserved",
    /do_squad_order_kill\(int32_t squad_id, int32_t target_unit_id, std::string\* err\) \{[\s\S]*?std::vector<int32_t>\{ target_unit_id \}/.test(cpp));
  check("kill route parses targets=<csv> and keeps single target= for back-compat",
    /req\.has_param\("targets"\)/.test(cpp) && /query_int\(req, "target", target\)/.test(cpp));
  check("multi-target kill builds ONE order with several units (title '+N more')",
    /order->units\.push_back\(valid\[i\]\)/.test(cpp) && /\+ " more"/.test(cpp));
  checkGuard("would catch a kill route that dropped targets-csv support", /targets/.test(cpp));

  console.log("\n# patrol persistent-route write (server)");
  check("patrol uses the canonical persistent waypoint route store",
    /plotinfo->waypoints\.points\.push_back/.test(cpp) && /plotinfo->waypoints\.routes\.push_back/.test(cpp));
  check("patrol queues an order that references the created route id",
    /allocate<df::squad_order_patrol_routest>/.test(cpp) && /order->route_id = route->id/.test(cpp));
  check("patrol route rejects fewer than two distinct points",
    /patrol route needs at least two distinct points/.test(cpp));
  check("patrol endpoint parses semicolon-separated x:y:z points",
    /std::getline\(point_stream, point_token, ';'\)/.test(cpp) && /std::getline\(coord_stream, coord_token, ':'\)/.test(cpp));

  console.log("\n# per-position equipment details (server)");
  check("detail payload serializes copied position uniform specs only on detail responses",
    /uniformDetails/.test(cpp) && /append_squad\(body, squad, true\)/.test(cpp));
  check("equipment mutation validates position/category and re-arms matching",
    /do_squad_equipment_change/.test(cpp) && /mark_squad_equipment_dirty/.test(cpp));
  check("equipment endpoint supports add, update, and remove",
    /\/squad-equipment/.test(cpp) && /action == "add"/.test(cpp) && /action == "update"/.test(cpp) && /action == "remove"/.test(cpp));
  check("uniform catalog serves specific materials and descriptor colors",
    /cat\.materials/.test(cpp) && /cat\.colors/.test(cpp) && /world->raws\.descriptors\.colors/.test(cpp));
}

// ---------------- HOST WIDTH-TIER FLAGS (window-frame geometry key contract) ----------------
// FIX-WIDTH root cause: #clientPanel is registered ONCE with the panel framework, and its
// per-variant geometry is remembered under primaryVariant(className, CLIENT_VARIANTS) -- which
// only sees "squads-sidebar". The narrow root list and the WIDE deep editors therefore share one
// geometry slot, so a saved/restored narrow rect freezes an inline width onto the wide editors
// and their multi-column grids collapse (the "Schedule/Equip opens narrow" report). The shell-host
// fix keys the geometry slot off the wide MODIFIER classes; that fix is inert unless the family
// keeps emitting them. These assertions pin that emission so a family-side regression can't quietly
// strip the flag the shell fix depends on. (The geometry conflation itself lives in dwf-core.js and
// is filed as a serialized shell-host handoff -- CSS/framework are integrator-owned.)
console.log("\n# host width-tier flags (geometry-key contract for the movable-window fix)");
{
  const list = M.buildSquadPanel(model({ view: "list" }));
  check("root LIST is the narrow tier (no wide/contextual/equipment host flag)",
    list.wide !== true && !list.contextual && !list.equipment);
  for (const view of ["schedule", "routines", "monthly"]) {
    const p = M.buildSquadPanel(model({ view }));
    check(`${view} requests the WIDE CONTEXTUAL host (side-by-side routine columns + squad rail)`,
      p.wide === true && p.contextual === true);
  }
  const cand = M.buildSquadPanel(model({ view: "candidate", squadCandidatePos: 0,
    squadDetail: Object.assign({}, squadDetail, { positions: (squadDetail.positions || []).slice() }) }));
  check("candidate chooser requests the WIDE CONTEXTUAL host", cand.wide === true && cand.contextual === true);
  const equip = M.buildSquadPanel(model({ view: "equip", equipTab: "uniform" }));
  check("equip requests the WIDE EQUIPMENT host (widest tier)", equip.wide === true && equip.equipment === true);
  // TEST-THE-TEST: a regression that dropped the contextual flag (leaving only `wide`) would map
  // schedule onto the plain 880px .squads-wide tier -- narrower than native's side-by-side columns
  // and, worse, indistinguishable from the dialog tier. This guard fails on that exact regression.
  checkGuard("width-tier guard: a schedule view emitting `wide` WITHOUT `contextual` is rejected",
    !((view => view.wide === true && view.contextual === true)({ wide: true })));
}

check("shared red slab renderer removes the keyed left-edge blip for every consumer",
  /\.dwfui-row--slab\.dwfui-row--off::before\s*\{[^}]*left:0;[^}]*width:1px;[^}]*background:var\(--dwfui-surface\)/s.test(sharedCss));
checkGuard("squad-specific row paint is gone",
  !/\.sq-item(?:\.selected|:hover)\s*\{[^}]*background/.test(sharedCss) && !/\.sq-rowcheck\s*\{/.test(sharedCss));

console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
