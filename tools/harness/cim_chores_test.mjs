// cim_chores_test.mjs -- OFFLINE fixture for R8 (CIM-labor-standing-orders-chores.jpg):
// the children roster + 14 chore-type flags + global do/don't toggle (two-pane roster model).
//   node tools/harness/cim_chores_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-labor-work-orders.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);

// Native chore-type order + captions, transcribed top-to-bottom from the oracle right pane.
const ORACLE = [
  ["feed_patients_prisoners", "Feed Patients/Prisoners"],
  ["milking", "Milking"],
  ["stone_hauling", "Stone Hauling"],
  ["wood_hauling", "Wood Hauling"],
  ["item_hauling", "Item Hauling"],
  ["burial", "Burial"],
  ["food_hauling", "Food Hauling"],
  ["refuse_hauling", "Refuse Hauling"],
  ["furniture_hauling", "Furniture Hauling"],
  ["animal_hauling", "Animal Hauling"],
  ["trade_good_hauling", "Trade Good Hauling"],
  ["water_hauling", "Water Hauling"],
  ["cleaning", "Cleaning"],
  ["lever_operation", "Lever Operation"],
];

console.log("\n# CHORE_TYPE_ORDER matches the oracle right-pane order");
check("14 chore types", M.CHORE_TYPE_ORDER.length === 14);
check("order = oracle order", M.CHORE_TYPE_ORDER.join(",") === ORACLE.map(o => o[0]).join(","));

// A /chores payload as the server would emit it (types already in native order).
const serverTypes = ORACLE.map(([key, label], i) => ({ key, label, enabled: i % 2 === 0 }));
const payload = {
  ok: true,
  childrenDoChores: true,
  choreTypes: serverTypes,
  children: [
    { unitId: 101, name: "Adil Kadolathel", enabled: true },
    { unitId: 102, name: "Asmel Rashlibash", enabled: false },
    { unitId: 103, name: "Asob astid", enabled: true },
  ],
};

const m = M.choresModel(payload);

console.log("\n# two-pane model (global toggle + right chore list + left children roster)");
check("childrenDoChores carried", m.childrenDoChores === true);
check("14 chore types kept", m.choreTypes.length === 14);
check("chore types in native order", m.choreTypes.map(t => t.key).join(",") === ORACLE.map(o => o[0]).join(","));
check("Feed Patients/Prisoners first, enabled", m.choreTypes[0].key === "feed_patients_prisoners" && m.choreTypes[0].enabled === true);
check("Lever Operation last", m.choreTypes[13].key === "lever_operation");
check("captions verbatim (Trade Good Hauling)", m.choreTypes[10].label === "Trade Good Hauling");
check("Milking enabled flag preserved (false at idx1)", m.choreTypes[1].enabled === false);

console.log("\n# children roster (red 'Name, Dwarven Child' rows w/ per-child checkbox)");
check("3 children", m.children.length === 3);
check("child name normalized", m.children[0].name === "Adil Kadolathel" && m.children[0].unitId === 101);
check("per-child enabled preserved (exempt child off)", m.children[1].enabled === false);

console.log("\n# toggle values (checkbox flip POSTs the opposite state)");
check("enabled -> POST value 0 (turn off)", M.choreToggleValue(true) === 0);
check("disabled -> POST value 1 (turn on)", M.choreToggleValue(false) === 1);

console.log("\n# defensive normalization: a reordered payload still paints native order");
const shuffled = { ...payload, choreTypes: [...serverTypes].reverse() };
const ms = M.choresModel(shuffled);
check("reversed payload re-sorted to native order", ms.choreTypes.map(t => t.key).join(",") === ORACLE.map(o => o[0]).join(","));
check("reordered enabled flags follow their key (lever last still its own flag)",
  ms.choreTypes[13].key === "lever_operation" && ms.choreTypes[13].enabled === serverTypes[13].enabled);

console.log("\n# TEST-THE-TEST (seeded-bad must be discriminated)");
// 1) Empty roster (fort with no children) => empty left pane, not an error / not the full citizen list.
const noKids = M.choresModel({ ok: true, childrenDoChores: false, choreTypes: serverTypes, children: [] });
guard("0 children -> empty roster (not a full citizen dump)", noKids.children.length === 0);
// 2) A malformed payload (missing arrays) must degrade to empty, not throw.
let threw = false;
try { M.choresModel({}); M.choresModel(null); } catch (_) { threw = true; }
guard("malformed/absent payload does not throw", threw === false);
guard("absent payload -> empty panes", M.choresModel(null).choreTypes.length === 0 && M.choresModel(null).children.length === 0);
// 3) A bad toggle table (both -> 1) would fail the enabled->0 assertion.
guard("enabled toggles to 0 not 1 (toggle-table guard)", M.choreToggleValue(true) === 0 && M.choreToggleValue(true) !== 1);

// ---- W5 RENDER PROOF: chores' controls are DWFUI ----------------------------------------------
// `.chore-check` had NO CSS AT ALL -- it was a bare browser button rendering a `&#10003;` entity,
// and an UNCHECKED one rendered NOTHING. Native's check is a COMPLETE 2-state sprite tile: it draws
// a real tile in BOTH states. The do/don't pair is the native segmented control, not two buttons.
const DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));
function laborRenderContext() {
  const ctx = vm.createContext({
    DWFUI, module: { exports: {} }, console, clientPanel: null, player: "p1",
    escapeHtml: s => String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    infoTabRowHtml: () => `<div class="info-tabs"></div>`,
    infoSearchBoxHtml: () => "",
    unitPortraitMarkup: (u, c) => `<span class="${c}"></span>`,
    attribRowHtml: () => "", bldIconStyle: () => "", dfTokenMatch: () => true,
  });
  vm.runInContext(readFileSync(modPath, "utf8"), ctx);
  return ctx.module.exports;
}
const R = laborRenderContext();
const choresData = {
  childrenDoChores: true,
  choreTypes: [{ key: "milking", label: "Milking", enabled: true }, { key: "burial", label: "Burial", enabled: false }],
  children: [{ unitId: 7, name: "Kubuk", enabled: false }, { unitId: 8, name: "Sigun", enabled: true }],
};
const chHtml = R.standingOrdersMarkup(
  { groups: [{ id: "refuse", items: [{ key: "dump_bones", label: "x", value: false }] }] },
  "chores", { choresData });

console.log("\n# W5 -- chores' controls reach the DWFUI layer");
check("the global do/don't pair is DWFUI.segmentedHtml (a radiogroup), not two buttons",
  /class="dwfui-segmented chores-head" role="radiogroup"/.test(chHtml) &&
  /data-chore-global="1"[^>]*>/.test(chHtml) && /data-chore-global="0"/.test(chHtml) &&
  !/<button class="chore-global/.test(chHtml));
check("the active segment is the served state (childrenDoChores:true -> segment '1' is checked)",
  /aria-checked="true" data-chore-global="1"/.test(chHtml));
check("every chore check is DWFUI.checkHtml, keeping its `.chore-check` hook",
  (chHtml.match(/class="dwfui-check chore-check/g) || []).length === 4 &&
  !/<button class="chore-check/.test(chHtml));
check("an UNCHECKED check renders a REAL TILE (LABOR_WORKER_UNASSIGNED), not nothing",
  /data-dwfui-sprite="LABOR_WORKER_UNASSIGNED"/.test(chHtml) && !/&#10003;/.test(chHtml));
check("a CHECKED check renders the assigned tile", /data-dwfui-sprite="LABOR_WORKER_ASSIGNED"/.test(chHtml));
check("the POST wire is unchanged: data-chore-child / data-chore-type + the FLIPPED data-chore-on",
  /data-chore-child="7" data-chore-on="1"/.test(chHtml) &&   // disabled child -> POST 1 (turn on)
  /data-chore-child="8" data-chore-on="0"/.test(chHtml) &&   // enabled child  -> POST 0 (turn off)
  /data-chore-type="milking" data-chore-on="0"/.test(chHtml) &&
  /data-chore-type="burial" data-chore-on="1"/.test(chHtml));
guard("a bare `<button class=\"chore-check\">` look-alike would NOT satisfy the dwfui-check signature",
  !/class="dwfui-check/.test(`<button class="chore-check on">&#10003;</button>`));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
