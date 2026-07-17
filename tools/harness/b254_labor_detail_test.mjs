// b254_labor_detail_test.mjs -- Creatures -> Residents: the SPECIALIZED toggle and the
// WORK_DETAILS icon column. Offline. Exit 0 PASS / 1 FAIL.
//
//   oracle: tools/orchestrator/attachments/B254-2.png   (NATIVE -- declared in
//           tools/ui-lab/reference-provenance.json; B254-1.png is OURS, never an oracle)
//
// WHAT WAS ACTUALLY WRONG (this is the point of the file, so read it before editing an assertion):
//
// DF's residents list is `widgets::unit_list` and its columns are literally enumerated in
// df-structures -- `library/xml/df.widgets.unit_list.xml` `unit_list_options`:
//
//     PORTRAIT, NAME_PROF, RECENTER, SHEET, CUR_JOB, ACTIVITY_DETAILS, HAPPINESS,
//     SPECIALIZED, WORK_DETAILS, SKILLS, SELECTED, ...
//
// Our row rendered portrait / name / recenter / view / job / mood -- and then put TWO INVENTIONS in
// the exact screen slots of SPECIALIZED and WORK_DETAILS:
//
//   * `laborHammerHtml()` -- a Unicode "&#9874;" glyph labelled "Open Labor tab for this unit".
//     Its own comment asserted "native has no such control" and "interface_map.json has no tile".
//     BOTH CLAIMS WERE FALSE. Native's control is DF's SPECIALIZED toggle, and the tiles have been
//     sitting in our own interface_map.json the whole time (WORKER_DO_ANY_AVAILABLE_JOB /
//     WORKER_ONLY_DO_ASSIGNED_JOBS). DWFUI's own latchHtml comment even names "the residents-row
//     specialization hammer" as one of its five intended consumers -- it was specced and never built.
//
//   * `creatureHeldItemHtml()` -- an EMPTY tile for a "held item" column DF does not have. It is the
//     "missing item sprite" the owner reported. The column is WORK_DETAILS: the icon of each work detail
//     the dwarf is assigned to (pick = Miners, axe-in-stump = Woodcutters, bag-of-plants =
//     Plant Gatherers, fish-on-a-rod = Fishermen -- all four visible in the oracle).
//
// So every assertion below does one of two things and never a third:
//   (a) REJECTS the fabrication by name (the glyph, the phantom held-item tile on residents), or
//   (b) PINS a capability -- the real DF token, the real data-* hook that carries the write.
// It never asserts that a file "mentions" something.
//
//   node tools/harness/b254_labor_detail_test.mjs
//   node tools/harness/b254_labor_detail_test.mjs --selftest   # each rule catches a seeded-bad

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const bipPath = join(root, "web", "js", "dwf-build-info-panels.js");
const dwfuiPath = join(root, "web", "js", "dwf-ui-components.js");
const infoCppPath = join(root, "src", "info_panel.cpp");
const laborCppPath = join(root, "src", "labor.cpp");
const mapPath = join(root, "web", "interface_map.json");

const DWFUI = require(dwfuiPath);
globalThis.window = globalThis;
globalThis.DWFUI = DWFUI;
globalThis.escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
globalThis.dfTokenMatch = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());
// The row builder reaches for these module-external globals at CALL time (core.js / render.js in the
// browser). Same stubs the sibling fixtures use (w3_itemsheet_test.mjs:486-495).
globalThis.unitPortraitMarkup = (row, cls) => `<span class="${cls}" data-stub-portrait="${row.unitId}"></span>`;
globalThis.infoRowPos = row => (row && row.hasPos ? { x: row.x, y: row.y, z: row.z } : null);
globalThis.rowTone = () => "";
globalThis.creatureNameColor = () => "";
const infoPanel = require(bipPath);

const bipSrc = fs.readFileSync(bipPath, "utf8");
const dwfuiSrc = fs.readFileSync(dwfuiPath, "utf8");
const infoCpp = fs.readFileSync(infoCppPath, "utf8");
const laborCpp = fs.readFileSync(laborCppPath, "utf8");
const ifaceMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));

let failed = 0, passed = 0;
const check = (n, c, x) => {
  if (c) { passed++; console.log(`  ok - ${n}`); }
  else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); }
};
const t = (n, fn) => { try { fn(); check(n, true); } catch (e) { check(n, false, e.message); } };

// ---------------------------------------------------------------------------------------------
// 0. Syntax + the enum, mirrored from df-structures.
// ---------------------------------------------------------------------------------------------
console.log("\n[0] baseline");
for (const p of [bipPath, dwfuiPath]) {
  try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); check(`node --check ${p.split(/[\\/]/).pop()}`, true); }
  catch (e) { check(`node --check ${p.split(/[\\/]/).pop()}`, false, String(e)); }
}

// EVERY value of df::work_detail_icon_type, transcribed from
// <DFHACK_ROOT>\library\xml\df.plotinfo.xml:573-594 (`work_detail_icon_type`, bay12
// WorkDetailIconType). NONE is -1 and renders nothing. The other 19 each have a real tile in
// DF's own interface_bits_labor.png (graphics_interface.txt:2912-2930). If DF ever adds an icon,
// THIS LIST is what fails first -- which is the intent.
const WORK_DETAIL_ICONS = [
  "MINERS", "WOODCUTTERS", "HUNTERS", "PLANTERS", "FISHERMEN", "STONECUTTERS", "ENGRAVERS",
  "PLANT_GATHERERS", "HAULERS", "ORDERLIES",
  "CUSTOM_1", "CUSTOM_2", "CUSTOM_3", "CUSTOM_4", "CUSTOM_5", "CUSTOM_6", "CUSTOM_7", "CUSTOM_8",
  "SIEGE_OPERATORS",
];
check("df::work_detail_icon_type has 19 drawable values (+NONE)", WORK_DETAIL_ICONS.length === 19);

// ---------------------------------------------------------------------------------------------
// 1. THE ART IS REAL. Every tile this feature needs already ships in DF and in our own map.
//    (the standing rule: never claim a sprite is missing without the search that proves it.)
// ---------------------------------------------------------------------------------------------
console.log("\n[1] the sprites exist in web/interface_map.json");
for (const icon of WORK_DETAIL_ICONS) {
  const token = `WORK_DETAIL_${icon}`;
  const rec = ifaceMap[token];
  check(`${token} present in interface_map.json`,
    !!rec && rec.img === "interface_bits_labor.png" && rec.w === 32 && rec.h === 36,
    rec ? JSON.stringify(rec) : "absent");
}
for (const token of ["WORKER_DO_ANY_AVAILABLE_JOB", "WORKER_ONLY_DO_ASSIGNED_JOBS"]) {
  const rec = ifaceMap[token];
  check(`${token} present in interface_map.json`, !!rec && rec.img === "interface_bits_labor.png",
    rec ? JSON.stringify(rec) : "absent");
}

// ---------------------------------------------------------------------------------------------
// 2. DWFUI carries the vocabulary + the resolver (EXTEND the layer; do not hand-roll a cell table).
// ---------------------------------------------------------------------------------------------
console.log("\n[2] DWFUI vocabulary + workDetailSprite()");
t("DWFUI.TOKENS.sprites.workerAny / workerOnly are the two padlock states", () => {
  assert.equal(DWFUI.TOKENS.sprites.workerAny, "WORKER_DO_ANY_AVAILABLE_JOB");
  assert.equal(DWFUI.TOKENS.sprites.workerOnly, "WORKER_ONLY_DO_ASSIGNED_JOBS");
});
t("DWFUI exports workDetailSprite()", () => {
  assert.equal(typeof DWFUI.workDetailSprite, "function");
});
for (const icon of WORK_DETAIL_ICONS) {
  t(`workDetailSprite("${icon}") -> WORK_DETAIL_${icon} (a token that exists)`, () => {
    const token = DWFUI.workDetailSprite(icon);
    assert.equal(token, `WORK_DETAIL_${icon}`);
    assert.ok(ifaceMap[token], `${token} must be in interface_map.json`);
  });
}
t("workDetailSprite() fails CLOSED on NONE / empty / junk -- never invents a tile", () => {
  assert.equal(DWFUI.workDetailSprite("NONE"), null);
  assert.equal(DWFUI.workDetailSprite(""), null);
  assert.equal(DWFUI.workDetailSprite(null), null);
  assert.equal(DWFUI.workDetailSprite(undefined), null);
  assert.equal(DWFUI.workDetailSprite("MADE_UP_DETAIL"), null);
});
t("workDetailSprite() accepts the already-prefixed token too (server may send either)", () => {
  assert.equal(DWFUI.workDetailSprite("WORK_DETAIL_MINERS"), "WORK_DETAIL_MINERS");
});
t("every token workDetailSprite can return is in DWFUI.TOKENS.sprites (dwfui_boot_test gates it)", () => {
  const vals = new Set(Object.values(DWFUI.TOKENS.sprites));
  for (const icon of WORK_DETAIL_ICONS)
    assert.ok(vals.has(`WORK_DETAIL_${icon}`), `TOKENS.sprites is missing WORK_DETAIL_${icon}`);
});

// ---------------------------------------------------------------------------------------------
// 3. residentLaborState() -- the pure read model. FAIL CLOSED is the whole contract.
// ---------------------------------------------------------------------------------------------
console.log("\n[3] residentLaborState(): capability-gated, fails closed");
const { residentLaborState, creatureRowsMarkup } = infoPanel;
check("dwf-build-info-panels.js exports residentLaborState", typeof residentLaborState === "function");

// The new-DLL wire: the row carries its own truth.
t("new DLL: row.specialized + row.workDetails are used verbatim", () => {
  const st = residentLaborState({ unitId: 7, specialized: true,
    workDetails: [{ name: "Miners", icon: "MINERS" }, { name: "Haulers", icon: "HAULERS" }] }, null);
  assert.equal(st.specialized, true);
  assert.equal(st.known, true);
  assert.deepEqual(st.details.map(d => d.icon), ["MINERS", "HAULERS"]);
});
t("new DLL: specialized:false is FALSE, not unknown (presence, not truthiness)", () => {
  const st = residentLaborState({ unitId: 7, specialized: false, workDetails: [] }, null);
  assert.equal(st.specialized, false);
  assert.equal(st.known, true);
});

// The old-DLL fallback: derive from the /labor snapshot the Labor tab already serves.
const laborSnap = {
  details: [
    { index: 0, name: "Miners", iconKey: "MINERS" },
    { index: 1, name: "Woodworkers", iconKey: "WOODCUTTERS" },
    { index: 2, name: "Fish Cleaning", iconKey: "NONE" },
    { index: 3, name: "Haulers", iconKey: "HAULERS" },
  ],
  rows: [
    { id: 7, specialist: true, assignedTo: "Miners, Haulers" },
    { id: 8, specialist: false, assignedTo: "Fish Cleaning" },
    { id: 9, specialist: false, assignedTo: "" },
  ],
};
t("old DLL: state is derived from the /labor snapshot (specialist + assignedTo)", () => {
  const st = residentLaborState({ unitId: 7 }, laborSnap);
  assert.equal(st.known, true);
  assert.equal(st.specialized, true);
  assert.deepEqual(st.details.map(d => d.icon), ["MINERS", "HAULERS"]);
  assert.deepEqual(st.details.map(d => d.name), ["Miners", "Haulers"]);
});
t("old DLL: an icon-less work detail is still reported, with icon NONE (no invented tile)", () => {
  const st = residentLaborState({ unitId: 8 }, laborSnap);
  assert.equal(st.specialized, false);
  assert.deepEqual(st.details, [{ name: "Fish Cleaning", icon: "NONE" }]);
});
t("old DLL: a citizen on no work detail is KNOWN with zero details (not unknown)", () => {
  const st = residentLaborState({ unitId: 9 }, laborSnap);
  assert.equal(st.known, true);
  assert.deepEqual(st.details, []);
});
t("FAIL CLOSED: no row fields and no snapshot -> known:false, nothing rendered", () => {
  const st = residentLaborState({ unitId: 7 }, null);
  assert.equal(st.known, false);
  assert.deepEqual(st.details, []);
});
t("FAIL CLOSED: a unit the /labor snapshot does not list (a long-term resident, B215) is unknown", () => {
  const st = residentLaborState({ unitId: 404 }, laborSnap);
  assert.equal(st.known, false);
});
t("FAIL CLOSED: a garbage snapshot does not throw and does not claim knowledge", () => {
  assert.equal(residentLaborState({ unitId: 7 }, {}).known, false);
  assert.equal(residentLaborState({ unitId: 7 }, { rows: "nope" }).known, false);
  assert.equal(residentLaborState({}, laborSnap).known, false);
});

// ---------------------------------------------------------------------------------------------
// 4. The rendered row. Native oracle B254-2.png, top to bottom.
// ---------------------------------------------------------------------------------------------
console.log("\n[4] creatureRowsMarkup(): the two native columns");
const residents = { detail: "residents", labor: laborSnap };
const miner = { unitId: 7, name: "Dodok Cogiger", profession: "Miner", job: "Give water",
  specialized: false, workDetails: [{ name: "Miners", icon: "MINERS" }] };
const manager = { unitId: 11, name: "Cilob Eshtanbunem", profession: "manager",
  job: "Soldier (no activity)", specialized: true,
  workDetails: [{ name: "Fishing", icon: "FISHERMEN" }] };

t("SPECIALIZED off -> the GREEN open padlock (WORKER_DO_ANY_AVAILABLE_JOB), aria-pressed=false", () => {
  const html = creatureRowsMarkup([miner], residents);
  assert.match(html, /data-dwfui-sprite="WORKER_DO_ANY_AVAILABLE_JOB"/);
  assert.doesNotMatch(html, /data-dwfui-sprite="WORKER_ONLY_DO_ASSIGNED_JOBS"/);
  assert.match(html, /aria-pressed="false"/);
});
t("SPECIALIZED on -> the RED closed padlock (WORKER_ONLY_DO_ASSIGNED_JOBS), aria-pressed=true", () => {
  const html = creatureRowsMarkup([manager], residents);
  assert.match(html, /data-dwfui-sprite="WORKER_ONLY_DO_ASSIGNED_JOBS"/);
  assert.doesNotMatch(html, /data-dwfui-sprite="WORKER_DO_ANY_AVAILABLE_JOB"/);
  assert.match(html, /aria-pressed="true"/);
});
t("the toggle carries the WRITE hook: data-resident-spec=<unitId> + data-spec=<current>", () => {
  const html = creatureRowsMarkup([manager], residents);
  assert.match(html, /data-resident-spec="11"/, "unit id must reach the click handler");
  assert.match(html, /data-spec="1"/, "current state must reach the click handler");
  const off = creatureRowsMarkup([miner], residents);
  assert.match(off, /data-resident-spec="7"/);
  assert.match(off, /data-spec="0"/);
});
t("the toggle's title is DF's own copy (df.d_interface.xml:3777/3780), not invented", () => {
  const on = creatureRowsMarkup([manager], residents);
  assert.match(on, /only do tasks that match their workshop assignments, work details, and occupations/);
  const off = creatureRowsMarkup([miner], residents);
  assert.match(off, /will do any free tasks that become available/);
});
t("WORK_DETAILS column: the miner's pick renders (WORK_DETAIL_MINERS), titled with the detail name", () => {
  const html = creatureRowsMarkup([miner], residents);
  assert.match(html, /data-dwfui-sprite="WORK_DETAIL_MINERS"/);
  assert.match(html, /title="Miners"/);
});
t("WORK_DETAILS column: the fish-on-a-rod renders for a Fishermen-icon detail", () => {
  const html = creatureRowsMarkup([manager], residents);
  assert.match(html, /data-dwfui-sprite="WORK_DETAIL_FISHERMEN"/);
});
t("WORK_DETAILS column: several details -> several icons, in the server's order", () => {
  const multi = { unitId: 3, name: "Urist", specialized: false,
    workDetails: [{ name: "Plant Gathering", icon: "PLANT_GATHERERS" }, { name: "Haulers", icon: "HAULERS" }] };
  const html = creatureRowsMarkup([multi], residents);
  const order = [...html.matchAll(/data-dwfui-sprite="(WORK_DETAIL_[A-Z_0-9]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ["WORK_DETAIL_PLANT_GATHERERS", "WORK_DETAIL_HAULERS"]);
});
t("WORK_DETAILS column: an icon-less detail draws NO tile (DF draws none) but is still named", () => {
  const none = { unitId: 4, name: "Kadol", specialized: false,
    workDetails: [{ name: "Fish Cleaning", icon: "NONE" }] };
  const html = creatureRowsMarkup([none], residents);
  assert.doesNotMatch(html, /data-dwfui-sprite="WORK_DETAIL_/);
  assert.doesNotMatch(html, /data-df-identity-missing/, "must not ship an invisible hole either");
  assert.match(html, /Fish Cleaning/, "the name still reaches the player (tooltip)");
});
t("a dwarf on NO work detail renders no tiles at all (oracle: the mason rows are empty)", () => {
  const bare = { unitId: 9, name: "Domas", specialized: false, workDetails: [] };
  const html = creatureRowsMarkup([bare], residents);
  assert.doesNotMatch(html, /data-dwfui-sprite="WORK_DETAIL_/);
  assert.match(html, /data-resident-spec="9"/, "...but the padlock is still there (oracle: every row has one)");
});
t("OLD DLL, no row fields: the fallback lights the same two columns from /labor", () => {
  const html = creatureRowsMarkup([{ unitId: 7, name: "Dodok" }], residents);
  assert.match(html, /data-dwfui-sprite="WORKER_ONLY_DO_ASSIGNED_JOBS"/, "unit 7 is specialist in the snapshot");
  assert.match(html, /data-dwfui-sprite="WORK_DETAIL_MINERS"/);
  assert.match(html, /data-dwfui-sprite="WORK_DETAIL_HAULERS"/);
});
t("FAIL CLOSED in the DOM: unknown state renders NO toggle button (never a dead live-looking one)", () => {
  const html = creatureRowsMarkup([{ unitId: 404, name: "Ghost" }], { detail: "residents", labor: null });
  assert.doesNotMatch(html, /data-resident-spec=/, "no write control when we cannot know the state");
  assert.doesNotMatch(html, /data-dwfui-sprite="WORKER_/);
});

// ---------------------------------------------------------------------------------------------
// 5. The columns are DF's, and they are on DF's tab.
// ---------------------------------------------------------------------------------------------
console.log("\n[5] scope: SPECIALIZED/WORK_DETAILS are residents-only (unit_list_options are per-list)");
t("the Pets tab gets no padlock and no work-detail icons", () => {
  const html = creatureRowsMarkup([{ unitId: 7, name: "Cow", specialized: false,
    workDetails: [{ name: "Miners", icon: "MINERS" }] }], { detail: "pets", labor: laborSnap });
  assert.doesNotMatch(html, /data-resident-spec=/);
  assert.doesNotMatch(html, /data-dwfui-sprite="WORK_DETAIL_/);
});
t("the Dead/Missing tab gets no padlock", () => {
  const html = creatureRowsMarkup([{ unitId: 7, name: "Urist", specialized: true }],
    { detail: "dead", labor: laborSnap });
  assert.doesNotMatch(html, /data-resident-spec=/);
});

// ---------------------------------------------------------------------------------------------
// 6. THE FABRICATIONS ARE GONE. (a)-class assertions: reject the old markup by name.
// ---------------------------------------------------------------------------------------------
console.log("\n[6] the two inventions are deleted, not restyled");
t("the Unicode hammer-and-pick glyph (&#9874;) is gone from the module", () => {
  assert.ok(!bipSrc.includes("&#9874;"),
    "the residents row's SPECIALIZED slot is DF's padlock sprite, not a Unicode glyph");
});
t("data-labor-hammer (the invented 'jump to Labor tab' shortcut) is gone", () => {
  assert.ok(!/data-labor-hammer|laborHammer/.test(bipSrc));
});
t("the residents row no longer paints the phantom held-item tile", () => {
  const html = creatureRowsMarkup([{ unitId: 7, name: "Dodok", heldItem: "iron pick",
    specialized: false, workDetails: [] }], residents);
  assert.doesNotMatch(html, /info-held-item/,
    "DF's residents list has no held-item column -- unit_list_options has no such member");
});
t("REGRESSION GUARD: the other creature tabs keep their existing held-item cell (out of scope)", () => {
  const html = creatureRowsMarkup([{ unitId: 2, name: "Urist", heldItem: "iron dagger" }], {});
  assert.match(html, /info-held-item/);
});

// ---------------------------------------------------------------------------------------------
// 7. The server half + the write path. (The write ALREADY SHIPS: /labor-specialist.)
// ---------------------------------------------------------------------------------------------
console.log("\n[7] server: the wire, and the one true write");
t("info_panel.cpp emits `specialized` on unit rows", () => {
  assert.match(infoCpp, /"\\"specialized\\":"/);
});
t("info_panel.cpp emits `workDetails` on unit rows, as an array of {name, icon}", () => {
  assert.match(infoCpp, /\\"workDetails\\":\[/);
  assert.match(infoCpp, /\\"name\\":" << json_string\(row\.work_details\[wd\]\.first\)/);
  assert.match(infoCpp, /\\"icon\\":" << json_string\(row\.work_details\[wd\]\.second\)/);
});
t("info_panel.cpp reads DF's REAL flag: unit->flags4.bits.only_do_assigned_jobs", () => {
  assert.match(infoCpp, /flags4\.bits\.only_do_assigned_jobs/);
});
t("info_panel.cpp reads DF's REAL work details: plotinfo->labor_info.work_details", () => {
  assert.match(infoCpp, /labor_info\.work_details/);
  assert.match(infoCpp, /assigned_units/);
});
// The one that bites: a B215 long-term resident (bard/mercenary/monster hunter) IS on the Residents
// list but CANNOT hold a fortress labor -- info_panel.cpp says so itself, and /labor-specialist
// refuses them by the identical predicate. So the server must not claim to know their state.
t("the labor columns are gated on is_fort_citizen -- long-term residents get NO padlock", () => {
  assert.match(infoCpp, /void fill_labor_columns[\s\S]{0,400}?if \(!is_fort_citizen\(unit\)\) return;/);
});
t("...and a non-citizen's row OMITS the keys entirely (absent = unknown = no control)", () => {
  assert.match(infoCpp, /if \(row\.has_labor_columns\) \{[\s\S]{0,600}?\\"specialized\\":/,
    "specialized/workDetails must be emitted INSIDE the has_labor_columns guard: emitting " +
    "`specialized:false` for a long-term resident would read as a KNOWN state and draw a live " +
    "padlock over a dwarf the game will not let the player change");
});
t("the client treats an absent key as unknown, not as false", () => {
  // Exactly the shape a non-citizen row now has: every other field, neither labor key.
  const st = residentLaborState({ unitId: 55, name: "Bard", heldItem: "flute" }, null);
  assert.equal(st.known, false);
  const html = creatureRowsMarkup([{ unitId: 55, name: "Bard" }], { detail: "residents", labor: null });
  assert.doesNotMatch(html, /data-resident-spec=/);
});
t("labor.cpp still owns the ONE write (unit->flags4.bits.only_do_assigned_jobs = on)", () => {
  assert.match(laborCpp, /unit->flags4\.bits\.only_do_assigned_jobs = on;/);
  assert.match(laborCpp, /server\.Post\("\/labor-specialist"/);
});
t("the residents toggle POSTs the EXISTING endpoint -- this wave adds no new write surface", () => {
  assert.match(bipSrc, /\/labor-specialist\?unit=/);
  const writes = [...bipSrc.matchAll(/fetch\(`\/labor-[a-z-]+/g)].map(m => m[0]);
  assert.deepEqual([...new Set(writes)], ["fetch(`/labor-specialist"],
    "the Creatures panel may reach exactly one labor write endpoint, the one that already shipped");
});
t("no hand-rolled sprite-sheet cell table: the new columns emit DWFUI placeholders only", () => {
  // The labor PANEL hand-rolls LABOR_ICON_CELL + an inline background-position (grandfathered).
  // The residents columns must NOT copy that: they go through DWFUI.iconHtml, which is what
  // ui_drift_guard_test polices and what makes the tiles survive an interface-scale change.
  const html = creatureRowsMarkup([miner, manager], residents);
  const cells = html.slice(html.indexOf("creature-workdetails"));
  assert.doesNotMatch(cells, /background-position/,
    "work-detail tiles go through DWFUI.iconHtml, not an inline px table");
  assert.match(html, /data-dwfui-sprite="WORK_DETAIL_MINERS"/);
});

// ---------------------------------------------------------------------------------------------
// selftest: every rule above must actually catch a seeded-bad.
// ---------------------------------------------------------------------------------------------
if (process.argv.includes("--selftest")) {
  console.log("\n[selftest] seeded-bad inputs must FAIL");
  const bad = (n, fn) => {
    let threw = false;
    try { fn(); } catch (_) { threw = true; }
    check(`seeded-bad caught: ${n}`, threw);
  };
  bad("a specialized dwarf drawn with the GREEN sprite", () => {
    const html = creatureRowsMarkup([manager], residents);
    assert.match(html, /data-dwfui-sprite="WORKER_DO_ANY_AVAILABLE_JOB"/);
  });
  bad("workDetailSprite inventing a tile for NONE", () => {
    assert.equal(DWFUI.workDetailSprite("NONE"), "WORK_DETAIL_NONE");
  });
  bad("an unknown-state row still exposing a write hook", () => {
    const html = creatureRowsMarkup([{ unitId: 404, name: "Ghost" }], { detail: "residents", labor: null });
    assert.match(html, /data-resident-spec=/);
  });
  bad("a work-detail token that is not in interface_map.json", () => {
    assert.ok(ifaceMap["WORK_DETAIL_CHEESEMAKERS"]);
  });
  bad("the phantom held-item tile back on the residents row", () => {
    const html = creatureRowsMarkup([{ unitId: 7, name: "D", heldItem: "pick", specialized: false, workDetails: [] }], residents);
    assert.match(html, /info-held-item/);
  });
}

console.log(`\n${failed ? "FAIL" : "PASS"} - ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
