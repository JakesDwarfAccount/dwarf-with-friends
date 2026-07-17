// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-only

// WAVE 4 / S2 -- squads/squad-list NATIVE-PARITY GATE. Offline (node, no DF, no browser).
//
// The representative state is a PAIR, because PB-05 ("context actions appear ONLY when a squad is
// selected") is only provable as one: R1 `Menu Oracle Screenshots/Squad Menu UI/1. Squad Menu.PNG`
// (nothing selected -> hint line, no order strip) and R2
// `docs/superpowers/analysis/review-2026-07-11/attach-3-squads__squad-list.webp` (selected -> green
// check, order strip, Equip/Schedule/trash, no hint). Both halves are rendered here from the REAL
// production builder (`buildSquadPanel`), not from a copy.
//
// WHAT THIS GATE IS FOR, and what it deliberately is NOT:
//   * It REJECTS THE OLD HAND-BUILT PATH by NAME -- the chess pawn, the five order-button emoji, the
//     disband trash emoji, `.alerts-action` chrome borrowed from the alerts panel, the triState mark,
//     the slab chassis and the gold selection outline. `assert.match(source, /DWFUI/)` is the failure
//     mode this file exists to avoid (AGENTS.md: "a test can pass while asserting nothing"), so every
//     positive assertion names the SPRITE TOKEN or the COMPONENT CLASS that must be present, and
//     every negative one names the exact artefact that must be gone.
//   * It PROVES THE WIRED CAPABILITIES SURVIVED the restyle -- above all SQUAD RENAME, which is the
//     client's ONLY rename path and which the parity instinct would have deleted (DELETION-LEDGER;
//     the owner 2026-07-12: keep the free-text input, dress it native). The rename proof executes the real
//     `squadRename` source against a stub transport and asserts the exact route it POSTs.
//   * It is NOT visual proof. Pixels are the Parity Studio's job. This gate proves ADOPTION,
//     BEHAVIOUR and NON-REMOVAL; it cannot prove the paint.
//
//   node tools/harness/wave4_squads_parity_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const modPath = join(root, "web", "js", "dwf-squads.js");
const source = readFileSync(modPath, "utf8");
const squadsCpp = readFileSync(join(root, "src", "squads.cpp"), "utf8");
const interfaceMap = JSON.parse(readFileSync(join(root, "web", "interface_map.json"), "utf8"));

globalThis.DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
const M = require(modPath);

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function guard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}

// ---------------- the model behind BOTH halves of the pair ----------------
// Three squads with DELIBERATELY different name lengths (14 / 21 / 12 chars). S3 -- the select
// checkbox must land in the SAME column on every row -- is unprovable on rows whose labels are the
// same width: the old staggered path would pass such a fixture by accident.
const squadsList = {
  hasFreePosition: true,
  freePositions: [{ assignmentId: 41, positionId: 10, title: "Captain of the guard's squad", holderName: "Logem", appointLabel: "", squadSize: 10 }],
  squads: [
    { id: 1, name: "1st Legion", alias: "The Lined Tours", routineName: "Staggered training",
      memberCount: 5, positionCount: 10, orders: [],
      emblem: { symbol: 6, fg: { r: 245, g: 195, b: 65 }, bg: { r: 55, g: 30, b: 85 } } },
    { id: 2, name: "2nd Legion", alias: "The Rough Entanglement", routineName: "Off duty",
      memberCount: 3, positionCount: 10,
      orders: [{ index: 0, type: "kill", description: "Kill Fath Usirdumat" }],
      emblem: { symbol: 20, fg: { r: 230, g: 110, b: 45 }, bg: { r: 25, g: 30, b: 30 } } },
    { id: 3, name: "3rd Legion", alias: "Death Return", routineName: "Staggered training",
      memberCount: 7, positionCount: 10, orders: [],
      emblem: { symbol: 14, fg: { r: 235, g: 235, b: 235 }, bg: { r: 40, g: 40, b: 40 } } },
  ],
};
const squadDetail = { squad: Object.assign({}, squadsList.squads[0], { members: [], uniforms: [] }), routines: [], schedule: [] };
const model = over => Object.assign({ view: "list", squadsList, squadDetail, uniformCatalog: null,
  squadSelectedId: 1, uniformSelectedId: -1, equipTab: "uniform" }, over);

// A FULLY-SERVED detail + catalog, so section 4e can render every non-list screen and assert each of
// the 35 wired controls by the identity hook its handler actually binds to.
const DETAIL = {
  squad: Object.assign({}, squadsList.squads[0], {
    routineIdx: 2, memberCount: 1, positionCount: 2,
    members: [
      { idx: 0, unitId: 100, name: "Urist McAxe", positionName: "Leader", filled: true, uniformItems: 2,
        topSkills: ["Axe"], uniformDetails: [
          { cat: 0, index: 0, itemName: "breastplate", subtype: 0, materialClass: 16, materialClassName: "Armor",
            mattype: 0, matindex: 5, materialName: "iron", color: -1, choice: 0, assignedCount: 1 },
          { cat: 6, index: 0, itemName: "battle axe", subtype: 3, materialClass: -1, materialClassName: "any",
            mattype: 0, matindex: 7, materialName: "copper", color: 2, choice: 2, assignedCount: 0 },
        ] },
      { idx: 1, unitId: -1, name: "", positionName: "Member", filled: false, uniformItems: 0, topSkills: [] },
    ],
  }),
  candidates: [{ unitId: 200, name: "Cog Cavernshield", profession: "Stonecutter", topSkills: ["Sword"] }],
  uniforms: [{ id: 7, name: "Metal armor" }],
  routines: [{ idx: 0, name: "Off duty" }, { idx: 2, name: "Staggered training" }],
  schedule: Array.from({ length: 12 }, (_, m) => ({ month: m, sleep: "anywhere", uniform: "civilian", orderCount: 0 })),
  ammo: [{ index: 0, subtype: 0, ammoName: "Bolts", materialClass: 14, materialName: "metal", amount: 100, combat: true, training: false }],
  ammoDefs: [{ subtype: 0, name: "bolts", ammoClass: "bolt" }],
  supplies: { food: 2, water: "drink" },
  routineSchedules: [
    { idx: 2, name: "Staggered training", months: Array.from({ length: 12 }, (_, m) => ({
      month: m, sleep: "anywhere", uniform: "regular", orderCount: 1, orderLabel: "Train",
      hasTrain: true, minCount: 8 })) },
  ],
};
const CATALOG = {
  uniforms: [{ id: 7, name: "Metal armor", replaceClothing: true, exactMatches: false,
    items: [{ cat: 0, subtype: -1, materialClass: 16, materialName: "metal", color: -1, choice: 0 }] }],
  subtypes: { 0: [{ subtype: 0, name: "breastplate" }], 6: [{ subtype: 3, name: "short sword" }] },
  materialClasses: [{ value: -1, name: "any" }, { value: 16, name: "Armor" }],
  materials: [{ mattype: 0, matindex: 5, name: "iron" }],
  colors: [{ value: 2, name: "rust" }],
};
const EMBLEM_DETAIL = { squad: Object.assign({}, DETAIL.squad,
  { emblem: { symbol: 6, fg: { r: 245, g: 195, b: 65 }, bg: { r: 55, g: 30, b: 85 } } }) };

const UNSELECTED = M.buildSquadPanel(model({ squadSelectedId: -1, squadDetail: null })).html;
const SELECTED = M.buildSquadPanel(model({ squadSelectedId: 1 })).html;

// The six order tiles + the row tiles + both check states. Every token must be a REAL record in
// interface_map.json -- a token that is not in the map ships as an INVISIBLE HOLE, not as an error.
const REQUIRED_SPRITES = [
  "SQUADS_POSITIONS", "UNIT_SHEET_CUSTOMIZE", "SQUADS_SELECTED", "SQUADS_NOT_SELECTED",
  "SQUADS_KILL_ORDER", "SQUADS_MOVE_ORDER", "SQUADS_PATROL_ORDER", "SQUADS_DEFEND_BURROW_ORDER",
  "SQUADS_TRAIN_ORDER", "SQUADS_CANCEL_ORDER", "SQUADS_DISBAND",
];

// ================= 1. PB-05 -- the pair =================
console.log("\n# PB-05: context actions appear ONLY when a squad is selected (R1 vs R2)");
{
  const ORDER_TILES = ["squadOrderKillBtn", "squadOrderMoveBtn", "squadOrderPatrolBtn",
    "squadOrderBurrowBtn", "squadOrderTrainBtn", "squadOrderCancelAllBtn"];
  check("UNSELECTED: no order strip at all",
    ORDER_TILES.every(id => !UNSELECTED.includes(`id="${id}"`)));
  check("UNSELECTED: no Equip / Schedule / disband cluster",
    !/data-squad-nav="equip"/.test(UNSELECTED) && !/data-squad-nav="schedule"/.test(UNSELECTED) &&
    !/id="squadDeleteBtn"/.test(UNSELECTED));
  check("UNSELECTED: the native hint line IS shown (R1, verbatim)",
    /Select a squad or squad member to give orders, change equipment, and assign schedules\./.test(UNSELECTED));
  check("UNSELECTED: every squad's check tile is the EMPTY box",
    (UNSELECTED.match(/data-dwfui-sprite="SQUADS_NOT_SELECTED"/g) || []).length === 3 &&
    !/SQUADS_SELECTED/.test(UNSELECTED));
  check("SELECTED: the full order strip appears",
    ORDER_TILES.every(id => SELECTED.includes(`id="${id}"`)));
  check("SELECTED: Equip / Schedule plaques + the disband tile appear",
    /data-squad-nav="equip"/.test(SELECTED) && /data-squad-nav="schedule"/.test(SELECTED) &&
    /id="squadDeleteBtn"/.test(SELECTED));
  check("SELECTED: the hint line DISAPPEARS (R2)", !/sq-footer-note/.test(SELECTED));
  check("SELECTED: exactly the selected squad carries the GREEN CHECK",
    (SELECTED.match(/data-dwfui-sprite="SQUADS_SELECTED"/g) || []).length === 1 &&
    (SELECTED.match(/data-dwfui-sprite="SQUADS_NOT_SELECTED"/g) || []).length === 2 &&
    /class="dwfui-check sq-item-check on"[^>]*data-squad-select="1"/.test(SELECTED));
  check("the check tile is a real 2-state control the player can toggle (data-squad-select)",
    /data-squad-select="1"/.test(SELECTED) && /data-squad-select="2"/.test(SELECTED) &&
    /\[data-squad-select\]/.test(source) && /squadSelectedId = -1;/.test(source));
  guard("the pair is not vacuous: the two halves really differ",
    UNSELECTED !== SELECTED && UNSELECTED.length > 200 && SELECTED.length > 200);
}

// ================= 2. the old hand-built path is REJECTED =================
console.log("\n# the hand-built path is gone from the list view (not merely 'DWFUI appears somewhere')");
{
  const listSurface = UNSELECTED + SELECTED;
  const BANNED = [
    ["&#9823; chess pawn (positions)", "&#9823;"],
    ["&#9876; crossed swords (Kill AND Station shared it)", "&#9876;"],
    ["&#9874; hammer-and-pick (Train)", "&#9874;"],
    ["&#10227; circle arrow (Patrol)", "&#10227;"],
    ["&#128737; shield EMOJI (Defend)", "&#128737;"],
    ["&#128683; no-entry EMOJI (Cancel all)", "&#128683;"],
    ["&#128465; wastebasket EMOJI (Disband)", "&#128465;"],
    ["&#8592; back arrow", "&#8592;"],
    ["the alerts panel's button chrome", "alerts-action"],
    ["the hand-rolled .sq-rowicon tile", "sq-rowicon"],
    ["triState mark used as a control", "dwfui-mark"],
    ["the slab chassis on a list row", "dwfui-row--slab"],
    ["a gold selection outline on a squad row", "dwfui-row--sel-outline"],
    ["a gold selection bracket on a squad row", "dwfui-row--sel-brackets"],
  ];
  for (const [label, needle] of BANNED)
    check(`list view contains NO ${label}`, !listSurface.includes(needle));
  guard("the banned-list scanner is a real detector",
    `<button class="alerts-action">&#9823;</button>`.includes("alerts-action"));

  check("every list control is a DWFUI component (rows, tiles, plaques, checks)",
    /class="dwfui-row sq-item dwfui-row--table dwfui-row--stacked"/.test(SELECTED) &&
    /class="dwfui-art-btn/.test(SELECTED) && /class="dwfui-plaque/.test(SELECTED) &&
    /class="dwfui-check/.test(SELECTED));
  check("Create new squad keeps its id + its disabled semantics",
    /id="squadCreateBtn"/.test(SELECTED) &&
    /id="squadCreateBtn"[^>]*disabled/.test(M.buildSquadPanel(model({
      squadsList: { hasFreePosition: false, freePositions: [], squads: squadsList.squads } })).html));
  check("Back is a centred green plaque, NOT an arrow (R7)",
    /id="squadBackBtn"[^>]*class="dwfui-plaque green sq-back-plaque"/.test(M.sqBackHeader(squadsList.squads[0])));
}

// ================= 3. the sprites are real, and self-framed =================
console.log("\n# native art: every tile is a REAL interface_map token, drawn with no second border");
{
  const records = Array.isArray(interfaceMap) ? interfaceMap
    : (interfaceMap.records || interfaceMap.sprites || Object.keys(interfaceMap));
  const names = new Set(Array.isArray(records)
    ? records.map(r => (typeof r === "string" ? r : (r && (r.name || r.token || r.id))))
    : Object.keys(records));
  for (const token of REQUIRED_SPRITES)
    check(`${token} is a real record in web/interface_map.json`, names.has(token));
  guard("the interface_map lookup can FAIL", !names.has("SQUADS_NOT_A_REAL_TOKEN"));

  check("all 11 squad tiles are rendered in the pair",
    REQUIRED_SPRITES.every(t => (UNSELECTED + SELECTED).includes(`data-dwfui-sprite="${t}"`)));
  // A self-framed sprite carries its own dark fill + grey border. NOTHING may box it a second time:
  // the icon must be a native cell and its host button must be flagged self-framed. Asserted on the
  // RENDERED markup of each token (GAP-1 was exactly this, and a `true` fallback would hide it).
  const pair = UNSELECTED + SELECTED;
  const framed = t => new RegExp(
    `<span class="dwfui-icon dwfui-icon--native-cell" data-dwfui-sprite="${t}" data-dwfui-self-framed="true"`).test(pair);
  for (const token of REQUIRED_SPRITES)
    check(`${token} renders as a self-framed native cell (no second border)`, framed(token));
  check("every host button of a squad sprite is flagged self-framed",
    (SELECTED.match(/<button[^>]*data-dwfui-self-framed="true"/g) || []).length >= 8);
  guard("the self-framed detector can FAIL", !framed("SQUADS_NOT_A_REAL_TOKEN"));
  check("the Train tile ships as a PLACEHOLDER with a title naming the missing evidence (Q4)",
    /id="squadOrderTrainBtn"[^>]*dwfui-btn--placeholder/.test(SELECTED) &&
    /id="squadOrderTrainBtn"[^>]*title="[^"]*unverified[^"]*"/.test(SELECTED));
}

// ================= 4. WIRED CAPABILITIES SURVIVED (DELETION-LEDGER) =================
console.log("\n# no capability was amputated by the restyle");
{
  // --- 4a. SQUAD RENAME, end to end. The one the parity instinct would have deleted.
  // S5 deleted the redundant bottom `Rename` BUTTON. The INPUT and the ROUTE are untouched, and the
  // quill tile + Enter still reach them -- which is exactly what these four checks prove. ---
  check("the free-text rename input is STILL RENDERED on the selected squad (S5 kept it)",
    /id="squadRenameInput"[^>]*maxlength="64"/.test(SELECTED));
  check("the row's quill tile targets that input (it is THE rename affordance)",
    /data-squad-rename-focus="1"/.test(SELECTED) &&
    /\[data-squad-rename-focus\]/.test(source) && /querySelector\("#squadRenameInput"\)/.test(source));
  check("the input COMMITS ON ENTER -- squadRename() is still called from the list view",
    /querySelector\("#squadRenameInput"\)\?\.addEventListener\("keydown"[\s\S]{0,260}?squadRename\(squadSelectedId, event\.currentTarget\.value\);/.test(source));

  // Execute the REAL squadRename source against a stub transport: this proves the exact route, not
  // the mere presence of the letters "squad-rename" somewhere in the file.
  const fn = source.match(/async function squadRename\(id, name\) \{[\s\S]*?\n  \}/);
  check("squadRename() exists in the module source", !!fn);
  let renamedUrl = null, renamedOpts = null;
  if (fn) {
    const factory = new Function("squadFetchJson", "player", "squadSetStatus", "loadSquadDetail",
      "refreshSquads", `${fn[0]}\n return squadRename;`);
    const squadRename = factory(
      (url, opts) => { renamedUrl = url; renamedOpts = opts; return Promise.resolve({ ok: true }); },
      "host", () => {}, () => Promise.resolve(), () => Promise.resolve());
    await squadRename(7, "The Copper Picks");
  }
  check("squadRename POSTs /squad-rename with the player, the squad id and the FREE-TEXT name",
    !!renamedUrl && renamedUrl.startsWith("/squad-rename?") &&
    /[?&]id=7(&|$)/.test(renamedUrl) && /[?&]name=The%20Copper%20Picks/.test(renamedUrl) &&
    renamedOpts && renamedOpts.method === "POST",
    renamedUrl || "(never called)");
  check("the C++ route + writer are still there: /squad-rename -> do_squad_rename -> squad->alias",
    /"\/squad-rename"/.test(squadsCpp) && /do_squad_rename/.test(squadsCpp) &&
    /squad->alias\s*=\s*name/.test(squadsCpp));
  guard("the rename proof would notice a broken route",
    !"/squad-renam?player=host".startsWith("/squad-rename?"));

  // --- 4b. per-order Cancel BY INDEX (native has only cancel-ALL; ours is a superset) ---
  check("per-order Cancel survives, one per order, carrying its index",
    /data-squad-order-cancel="0"/.test(SELECTED.replace(/[\s\S]*sq-order-list/, "")) ||
    /data-squad-order-cancel/.test(M.sqOrderToolbar(squadsList.squads[1], {})));
  check("cancel-by-index and cancel-ALL are still TWO different calls",
    /action: "cancel", index: Number\(b\.dataset\.squadOrderCancel\)/.test(source) &&
    /action: "cancel", all: 1/.test(source) && /do_squad_order_cancel/.test(squadsCpp));

  // --- 4c. multi-target kill marking (the C++ takes a target LIST) ---
  const armed = M.sqOrderToolbar(squadsList.squads[0], { killArmed: true,
    killTargets: [{ id: 501, name: "Goblin Axeman" }, { id: 502, name: "Goblin Bowman" }] });
  check("multi-target kill: both chips still render, still unmarkable by unit id",
    /data-kill-unmark="501"/.test(armed) && /data-kill-unmark="502"/.test(armed) &&
    (armed.match(/class="sq-kill-mark"/g) || []).length === 2);
  check("multi-target kill: Confirm (2) + Cancel still present",
    /data-dwfui-bitmap-text="Confirm \(2\)"/.test(armed) && /id="squadOrderKillCancelBtn"/.test(armed));
  check("multi-target kill: the CSV target list still reaches the wire",
    /action: "kill", targets: targets\.join\(","\)/.test(source));
  check("the kill chip's glyph became a SPRITE, but the chip is still a control",
    /data-dwfui-sprite="SQUADS_KILL_ORDER"/.test(armed) && !armed.includes("&#9876;"));

  // --- 4d. the rest of the row's wiring ---
  check("the positions tile keeps data-squad-positions (the handler binds to it)",
    /data-squad-positions="1"/.test(SELECTED) && /\[data-squad-positions\]/.test(source));
  check("the emblem badge still opens the emblem editor",
    /data-squad-emblem="1"/.test(SELECTED) && /\[data-squad-emblem\]/.test(source));
  check("the row itself still selects the squad (data-squad-id)",
    /data-squad-id="1"/.test(SELECTED) && /\[data-squad-id\]/.test(source));
  check("the 23 emblem symbols were NOT deleted (they DRIVE the picker grid's length)",
    Array.isArray(M.SQUAD_SYMBOL_GLYPHS) && M.SQUAD_SYMBOL_GLYPHS.length === 23);
  check("disband keeps its id and its route (glyph replaced, control retained)",
    /id="squadDeleteBtn"[^>]*class="dwfui-art-btn sq-danger"/.test(SELECTED) &&
    /squadDelete\(squadSelectedId\)/.test(source) && /"\/squad-delete"/.test(squadsCpp));
  // ---- 4e. THE 35 WIRED CHOOSER/FIELD CONTROLS -- BY IDENTITY, NOT BY ANGLE-BRACKET COUNT. -------
  //
  // This gate used to read:
  //     const selects = (source.match(/<select\b/g) || []).length;   // require >= 14
  //     const inputs  = (source.match(/<input\b/g)  || []).length;   // require >= 21
  // i.e. it counted RAW HTML TAGS as a PROXY for "no capability was amputated". The proxy was always
  // the wrong instrument, and Wave-5 Gate C is exactly the case that exposes it: DWFUI's cycler,
  // segmented, check and stepper components are the NATIVE form of these 35 controls (native DF has
  // NO dropdown in any of the 36 squad captures), so MIGRATING them -- the entire point of the wave --
  // drives both counters to ~0 while every capability is intact. The old assertion would have failed a
  // correct migration and passed a bulk delete that left 14 dead `<select>` behind. It is REPLACED, not
  // relaxed, by the thing it was standing in for: a NAMED LEDGER of all 35, each asserted BY THE
  // IDENTITY HOOK ITS HANDLER BINDS TO, in the rendered markup of the screen it lives on, plus the
  // route it still reaches. That is strictly stronger: it can tell a migrated control from a deleted
  // one, which counting angle brackets cannot.
  const SQ = {
    positions: M.buildSquadPanel(model({ view: "positions", squadDetail: DETAIL })).html,
    candidate: M.buildSquadPanel(model({ view: "candidate", squadDetail: DETAIL,
      squadCandidatePos: 1, pos0Guard: { enabled: true, reason: "" } })).html,
    equipUniform: M.buildSquadPanel(model({ view: "equip", equipTab: "uniform", squadDetail: DETAIL, uniformCatalog: CATALOG })).html,
    equipAdd: M.buildSquadPanel(model({ view: "equip", equipTab: "add", squadDetail: DETAIL, uniformCatalog: CATALOG, uniformSelectedId: 7 })).html,
    equipAmmo: M.buildSquadPanel(model({ view: "equip", equipTab: "ammo", squadDetail: DETAIL, uniformCatalog: CATALOG })).html,
    equipDetails: M.buildSquadPanel(model({ view: "equip", equipTab: "details", squadDetail: DETAIL, uniformCatalog: CATALOG })).html,
    schedule: M.buildSquadPanel(model({ view: "schedule", squadDetail: DETAIL })).html,
    routines: M.buildSquadPanel(model({ view: "routines", squadDetail: DETAIL })).html,
    training: M.buildSquadPanel(model({ view: "training", squadDetail: DETAIL, trainingSel: { routine: 2, month: 1 } })).html,
    emblem: M.buildSquadPanel(model({ view: "emblem", squadDetail: EMBLEM_DETAIL })).html,
    burrow: M.buildSquadPanel(model({ view: "burrow", squadDetail: DETAIL, squadBurrows: [{ id: 3, name: "Burrow 1", memberCount: 2 }] })).html,
    patrol: M.buildSquadPanel(model({ view: "patrol", squadDetail: DETAIL, squadPatrolDraft: { name: "Route 1", points: [] } })).html,
  };
  // [what it is, which screen, the identity hook its handler binds to, the wire it reaches]
  const WIRED = [
    // --- the 14 choosers that WERE <select>: now native cyclers / segmented controls ---
    ["position row opens the dedicated candidate screen", "positions", /data-squad-pick-pos="1"/, /squadView = "candidate"/],
    ["per-position uniform chooser (was .sq-uniform-select)", "equipUniform", /data-sq-cyc="uniformPick"[\s\S]*?data-uniform-pos="0"/, /action: "apply", uniform/],
    ["uniform-template chooser (was #uniformSelect)", "equipAdd", /data-sq-cyc="uniformSelect"/, /uniformSelectedId = Number\(raw\)/],
    ["add-item subtype chooser (was .sq-uitem-subtype)", "equipAdd", /data-sq-cyc="uitemSubtype"/, /uniform-item-add/],
    ["add-item material chooser (was .sq-uitem-mat)", "equipAdd", /data-sq-cyc="uitemMat"/, /matclass/],
    ["weapon individual-choice (was .sq-uitem-choice)", "equipAdd", /data-uitem-choice="2"/, /choice = cat === 6/],
    ["ammo-type chooser (was #squadAmmoType)", "equipAmmo", /data-sq-cyc="ammoType"/, /action: "add", subtype/],
    ["ammo-material chooser (was #squadAmmoMat)", "equipAmmo", /data-sq-cyc="ammoMat"/, /matclass/],
    // B252: the capability survives, but the click target widened from the column's name plaque to
    // the whole COLUMN CELL (DWFUI.selectCellHtml), so the handler now reads the CELL's dataset.
    ["active-routine chooser (re-homed from #squadRoutineSelect to native routine columns)", "schedule", /data-schedule-routine="2"/, /action: "set-routine", routine: idx[\s\S]*?pickRoutine\(cell\.dataset\.scheduleRoutine\)/],
    ["per-month sleep chooser (re-homed from schedule row to native training editor)", "training", /data-train-sleep="anywhere"/, /action: "set-month", routine, month, sleep, uniform/],
    ["per-month uniform chooser (re-homed from schedule row to native training editor)", "training", /data-train-uniform="civilian"/, /action: "set-month", routine, month, sleep, uniform/],
    ["training Equip chooser (was #trainUniform)", "training", /data-train-uniform="regular"/, /uniform = d\.uniform \|\| "none"/],
    ["training Sleep chooser (was #trainSleep)", "training", /data-train-sleep="anywhere"/, /sleep = d\.sleep \|\| "none"/],
    ["equipment position chooser (was #equipmentPositionSelect)", "equipDetails", /data-sq-cyc="equipPos"/, /equipmentPosition = Number\(raw\)/],
    // --- the 8 checkboxes: now the 2-state native check TILE ---
    ["ammo row Combat check", "equipAmmo", /data-ammo-flag="combat"/, /action: "update", index, amount, combat, training/],
    ["ammo row Train check", "equipAmmo", /data-ammo-flag="training"/, /action: "update", index, amount, combat, training/],
    ["ammo add Combat check", "equipAmmo", /data-ammo-add-flag="combat"/, /action: "add", subtype, amount, matclass, combat, training/],
    ["ammo add Train check", "equipAmmo", /data-ammo-add-flag="training"/, /action: "add", subtype, amount, matclass, combat, training/],
    ["uniform replaceClothing flag", "equipAdd", /data-uniform-flag="replaceClothing"/, /uniform-flags/],
    ["uniform exactMatches flag", "equipAdd", /data-uniform-flag="exactMatches"/, /uniform-flags/],
    ["burrow checklist check", "burrow", /class="dwfui-check sq-burrow-check[^"]*"[^>]*data-burrow-id="3"/, /action: "defend-burrow", burrows/],
    ["training Train-order check", "training", /id="trainOrder"/, /order: train \? "train" : "none"/],
    // --- the 5 number fields: now the native stepper (value [#][+][-]) with its editable input ---
    ["candidate row carries its exact squad position", "candidate", /data-squad-assign-pos="1"/, /Number\(button\.dataset\.squadAssignPos\)/],
    ["ammo row amount stepper", "equipAmmo", /class="sq-input sq-ammo-amount-input"[^>]*type="number"/, /amount, combat, training/],
    ["ammo add amount stepper", "equipAmmo", /class="sq-input sq-ammo-add-amount-input"[^>]*type="number"/, /action: "add", subtype, amount/],
    ["dye-colour stepper (was .sq-uitem-color)", "equipAdd", /data-uitem-color="0"/, /uniform-item-add/],
    ["min-soldiers stepper (was #trainMin)", "training", /id="trainMin"[^>]*type="number"/, /set-month-order/],
    // --- the 2 colour fields: NO DWFUI colour component exists, so they STAY (superset kept) ---
    ["emblem foreground colour", "emblem", /id="emblemFg"[^>]*type="color"|type="color" id="emblemFg"/, /squadEmblemPost/],
    ["emblem background colour", "emblem", /id="emblemBg"[^>]*type="color"|type="color" id="emblemBg"/, /squadEmblemPost/],
    // --- the 6 free-text fields: the DELIBERATE editable exception, all kept verbatim ---
    ["squad rename free text (binding superset)", "selected", /id="squadRenameInput"/, /\/squad-rename\?player=/],
    ["uniform new-template name", "equipAdd", /id="uniformNewName"/, /uniform-create/],
    ["uniform rename field", "equipAdd", /id="uniformRenameInput"/, /uniform-rename/],
    ["routine rename field", "routines", /class="sq-input sq-routine-name"/, /routine-rename/],
    ["routine new-name field", "routines", /id="routineNewName"/, /routine-create/],
    ["patrol route name", "patrol", /id="patrolRouteName"/, /action: "patrol", name/],
  ];
  const surfaceOf = key => (key === "selected" ? SELECTED : SQ[key]);
  let wiredOk = 0;
  for (const [what, screen, markupRe, wireRe] of WIRED) {
    const html = surfaceOf(screen);
    const rendered = markupRe.test(html);
    const wired = wireRe.test(source);
    check(`WIRED: ${what} -- still rendered on ${screen} AND still reaches its handler/route`,
      rendered && wired,
      `${rendered ? "" : "markup missing "}${wired ? "" : "wire missing"}`);
    if (rendered && wired) wiredOk++;
  }
  check(`all 35 wired chooser/field capabilities survived the migration (${wiredOk}/35)`,
    wiredOk === WIRED.length && WIRED.length === 35);
  guard("the ledger is a real detector: a control deleted from its screen is caught",
    !/data-squad-assign-pos/.test(SQ.schedule));
  // And the migration is REAL, not a rename: native DF has no dropdown, so none may remain.
  check("no raw dropdown, checkbox, radio or numeric DOM control is hand-built any more",
    !/<select\b/.test(source) &&
    !/<input\b[^>]*type\s*=\s*"(?:checkbox|radio|number)"/.test(source),
    "native DF has NO <select> in any of the 36 squad captures");
}

// ================= 5. WAVE 4 S2 -- THE FIVE DEFECTS. THE RULES THAT REJECT THE OLD PATH ========
// Each rule is a NAMED PREDICATE over (UNSELECTED, SELECTED, source), so `--selftest` can re-run the
// SAME predicate against markup in which that exact defect has been seeded back in, and prove the
// rule goes red. A rule that cannot fail is worse than no rule (AGENTS.md), and every one of these
// would have PASSED on the shipped code the day the owner filed the bug -- which is why they exist.
const ROW_RE = /<div class="dwfui-row sq-item[^"]*"[^>]*data-squad-id="\d+"[\s\S]*?<\/button><\/div>/g;
const rows = html => html.match(ROW_RE) || [];

const RULES = [
  // ---- S1: THE ROWS ARE COLLAPSED. 19px measured; native pitch ~126px. --------------------------
  ["S1 every squad row adopts the two-band chassis (rowHtml stacked -> min-height:126px)",
    (U, S) => rows(U).length === 3 && rows(S).length === 3 &&
      [...rows(U), ...rows(S)].every(r => /class="dwfui-row sq-item dwfui-row--table dwfui-row--stacked"/.test(r))],
  ["S1 the copy cell keeps the CHASSIS class (.dwfui-copy) -- band 2 is CSS-reachable",
    (U, S) => [...rows(U), ...rows(S)].every(r => r.includes(`<span class="dwfui-copy">`)) &&
      !(U + S).includes("sq-item-main")],
  ["S1 band 2 is THREE lines: name / order / Routine (the label + exactly 2 sub lines)",
    (U, S) => rows(U).every(r =>
      /<span class="dwfui-copy"><span class="dwfui-label">[\s\S]*?data-dwfui-bitmap-text=/.test(r) &&
      (r.match(/class="dwfui-sub sq-item-(orders|sub)/g) || []).length === 2 &&
      /Routine:/.test(r))],
  ["S1 the order line is ORANGE via a TONE (--dwfui-text-warning), never a squads-local hex",
    (U, S) => /class="dwfui-sub sq-item-orders dwfui-sub--warning">[\s\S]*?data-dwfui-bitmap-text="Kill Fath Usirdumat/.test(S) &&
      /class="dwfui-sub sq-item-orders dwfui-sub--secondary">[\s\S]*?data-dwfui-bitmap-text="No special orders"/.test(S) &&
      (S.match(/dwfui-sub--warning/g) || []).length === 1 &&           // discriminates: 1 of 3 rows
      !/style="color:/.test(S)],
  // ---- S2: "3 horizontal lines across the bottom for no reason." --------------------------------
  // The collapsed rows' hairlines. With real row height they become native's BETWEEN-squad
  // separators. The second cause was structural: `.sq-list-pane`'s border-bottom stacked on
  // `.sq-selected`'s border-top -> a doubled rule. The wrapper (and its non-native "Squads" title
  // bar) is gone; the hairline that remains is the ONE the chassis draws between rows.
  ["S2 the doubled `.sq-list-pane` / `.sq-list-head` hairline wrapper is GONE",
    (U, S) => !(U + S).includes("sq-list-pane") && !(U + S).includes("sq-list-head")],
  ["S2 the ONLY hairline source on the list is the table chassis's own border-bottom",
    (U, S) => rows(U).every(r => r.includes("dwfui-row--table")) &&
      !/<hr\b/.test(U + S) && !/border-bottom/.test(U + S)],
  // ---- S3: the select checkbox must be RIGHT-JUSTIFIED (oracle x=312..355 on EVERY row). --------
  // BOTH halves of the pin are asserted, because either alone is a rule that cannot fail:
  //   (a) the check must be the row's LAST child   -- `> :last-child:not(.dwfui-copy)` selects it;
  //   (b) the copy cell must still BE `.dwfui-copy` -- that is the cell the chassis gives `flex:1`,
  //       and `copyCls` REPLACING it (the original DWFUI bug) is what let the slack land AFTER the
  //       check instead of before it. DOM order alone proves nothing: the old, staggered markup had
  //       the check last TOO.
  ["S3 the check is the LAST cell AND the copy still flexes (the chassis's right-pin, both halves)",
    (U, S) => [...rows(U), ...rows(S)].every(r =>
      /data-squad-select="\d+"[\s\S]*<\/button><\/div>$/.test(r) &&
      r.lastIndexOf("dwfui-check") > r.lastIndexOf("dwfui-copy") &&
      r.includes(`<span class="dwfui-copy">`))],
  ["S3 squads does NOT fight the chassis: no squads-local margin-left:auto / float / abs-position",
    (U, S, src) => !/margin-left\s*:\s*auto/.test(src) && !/float\s*:/.test(src) &&
      !/position\s*:\s*absolute/.test(src)],
  // ---- S4: Create new squad -- GREY SLAB #4e474e + GREEN #14ff6b, at the panel BOTTOM. ----------
  ["S4 Create new squad uses the native plaque art with GREEN bitmap text, never the flat slab",
    (U, S) => /id="squadCreateBtn"[^>]*class="dwfui-plaque green dwfui-plaque--art-neutral"/.test(U) &&
      !/id="squadCreateBtn"[^>]*dwfui-plaque--slab/.test(U)],
  ["S4 Create new squad sits at the panel BOTTOM: after the list, before the hint line",
    U => U.indexOf(`id="squadCreateBtn"`) > U.lastIndexOf(`data-squad-select=`) &&
      U.indexOf(`id="squadCreateBtn"`) < U.indexOf("sq-footer-note")],
  // ---- S5: the bottom rename BUTTON is deleted (the quill + the input remain). ------------------
  ["S5 the redundant bottom `Rename` button is GONE from the selected squad",
    (U, S) => !/id="squadRenameBtn"/.test(S) && !/squadRenameBtn/.test(source) &&
      !/label: "Rename"/.test(source)],
  ["S5 the rename CAPABILITY survives: quill tile -> #squadRenameInput -> squadRename -> POST",
    (U, S) => /data-squad-rename-focus="1"/.test(S) && /id="squadRenameInput"/.test(S) &&
      /addEventListener\("keydown"/.test(source) && /squadRename\(squadSelectedId/.test(source) &&
      /"\/squad-rename"/.test(squadsCpp)],
  ["S6 selected-squad navigation reuses the native GREY plaque art with GREEN bitmap labels",
    (U, S) => ["Positions", "Equip", "Schedule"].every(label =>
      new RegExp(`class="dwfui-plaque green dwfui-plaque--art-neutral"[^>]*[\\s\\S]*?${label}`).test(S)) &&
      (S.match(/class="dwfui-plaque green dwfui-plaque--art-neutral"/g) || []).length >= 4 &&
      !/class="dwfui-plaque dwfui-plaque--slab green"/.test(S)],
];

console.log("\n# WAVE 4 S2 -- the five squad-list defects");
for (const [name, rule] of RULES) check(name, rule(UNSELECTED, SELECTED, source));

// ================= 6. --selftest: seed each defect back in, prove each rule REJECTS it ==========
// The mutations reproduce the EXACT markup that shipped (and that the owner filed against), not a strawman.
if (process.argv.includes("--selftest")) {
  console.log("\n# --selftest: every rule must go RED when its defect is seeded back in");
  const strip = h => h.replace(/ dwfui-row--stacked/g, "")                       // the collapsed row
    .replace(/<span class="dwfui-copy">/g, `<span class="sq-item-main">`)
    .replace(/<span class="dwfui-label">/g, `<span class="sq-item-name">`);
  const OLD_ROWS_U = strip(UNSELECTED), OLD_ROWS_S = strip(SELECTED);
  const OLD_TONE_S = SELECTED
    .replace(/class="dwfui-sub sq-item-orders dwfui-sub--(warning|secondary)"/g,
      (_, t) => t === "warning" ? `class="sq-item-orders" style="color:var(--dwfui-text-warning)"` : `class="sq-item-orders"`);
  const OLD_PANE_U = UNSELECTED.replace(`<div class="sq-list">`,
    `<div class="sq-list-pane"><div class="sq-list-head"><span>Squads</span></div><div class="sq-list">`);
  const OLD_FILL_U = UNSELECTED.replace(`class="dwfui-plaque green dwfui-plaque--art-neutral"`, `class="dwfui-plaque green"`);
  // Top-right Create: hoist the button out of the footer and back into a list header.
  const createBtn = UNSELECTED.match(/<button type="button" class="dwfui-plaque[^>]*id="squadCreateBtn"[\s\S]*?<\/button>/) ||
    UNSELECTED.match(/<button id="squadCreateBtn"[\s\S]*?<\/button>/);
  const OLD_TOP_U = createBtn
    ? UNSELECTED.replace(createBtn[0], "").replace(`<div class="sq-list">`, `${createBtn[0]}<div class="sq-list">`)
    : UNSELECTED;
  const OLD_BTN_S = SELECTED.replace(`<div class="sq-controls sq-rename-row">`,
    `<div class="sq-controls sq-rename-row"><button id="squadRenameBtn" class="dwfui-plaque green">Rename</button>`);
  const OLD_SRC_MARGIN = source + `\n.sq-item-check { margin-left: auto; }\n`;
  const OLD_SRC_BTN = source.replace(/squadRenameInput"\)\?\.addEventListener\("keydown"/,
    `squadRenameBtn")?.addEventListener("click"`);
  const OLD_NAV_S = SELECTED.replace(
    /class="dwfui-plaque green dwfui-plaque--art-neutral"(?=[^>]*data-squad-nav)/g,
    `class="dwfui-plaque green"`);

  // rule index -> the mutated inputs that MUST make it fail.
  const SEEDS = [
    [0, OLD_ROWS_U, OLD_ROWS_S, source, "the 19px single-line row (no `stacked`)"],
    [1, OLD_ROWS_U, OLD_ROWS_S, source, "copyCls='sq-item-main' (the class that broke S3)"],
    [2, OLD_ROWS_U, OLD_ROWS_S, source, "the one-line copy cell"],
    [3, SELECTED, OLD_TONE_S, source, "the inline `style=color:var(--dwfui-text-warning)` hex path"],
    [4, OLD_PANE_U, SELECTED, source, "the `.sq-list-pane` + `.sq-list-head` doubled hairline"],
    [6, OLD_ROWS_U, OLD_ROWS_S, source, "a staggered check (copy no longer the flexing cell)"],
    [7, UNSELECTED, SELECTED, OLD_SRC_MARGIN, "a squads-local `margin-left:auto` fighting the chassis"],
    [8, OLD_FILL_U, SELECTED, source, "Create regressed to the flat CSS slab"],
    [9, OLD_TOP_U, SELECTED, source, "Create new squad back at the TOP of the panel"],
    [10, UNSELECTED, OLD_BTN_S, source, "the redundant bottom `Rename` button"],
    [11, UNSELECTED, SELECTED.replace(/data-squad-rename-focus="1"/, ""), OLD_SRC_BTN,
      "rename amputated (no quill, no Enter commit)"],
    [12, UNSELECTED, OLD_NAV_S, source, "selected navigation regressed to flat CSS slabs"],
  ];
  for (const [i, u, s, src, what] of SEEDS) {
    const [name, rule] = RULES[i];
    let red = false;
    try { red = !rule(u, s, src); } catch (_) { red = true; }
    guard(`rule REJECTS ${what}  ->  ${name.slice(0, 46)}`, red);
  }
  // And the mutations must be real: each seeded surface must actually differ from the shipped one.
  guard("the seeds are not no-ops (every mutated surface really changed)",
    OLD_ROWS_U !== UNSELECTED && OLD_TONE_S !== SELECTED && OLD_PANE_U !== UNSELECTED &&
    OLD_FILL_U !== UNSELECTED && OLD_TOP_U !== UNSELECTED && OLD_BTN_S !== SELECTED &&
    OLD_SRC_BTN !== source && OLD_NAV_S !== SELECTED);
}

console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
