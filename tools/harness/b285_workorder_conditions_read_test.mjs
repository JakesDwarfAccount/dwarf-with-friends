// b285_workorder_conditions_read_test.mjs -- offline read/display contract for work-order conditions
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const lua = readFileSync(join(root, "dwf.lua"), "utf8");
const laborPath = join(root, "web", "js", "dwf-labor-work-orders.js");
const require = createRequire(import.meta.url);
const DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) { console.log(`ok ${++passed} - ${name}`); return; }
  console.error(`not ok ${++failed} - ${name}`);
}

function renderContext() {
  const ctx = vm.createContext({
    DWFUI,
    module: { exports: {} }, console, clientPanel: null, player: "p1",
    escapeHtml: s => String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    infoTabRowHtml: () => `<div class="info-tabs"></div>`,
    infoSearchBoxHtml: () => "",
    unitPortraitMarkup: () => "", attribRowHtml: () => "",
    bldIconStyle: () => "", dfTokenMatch: () => true,
  });
  vm.runInContext(readFileSync(laborPath, "utf8"), ctx);
  return ctx.module.exports;
}

console.log("# Lua /orders serializer: stored filter + DF-owned satisfaction result");
check("serializer owns the native condition sentence instead of asking the client to invent it",
  /function item_condition_description\(c\)/.test(lua) &&
  /Amount of .* available is /.test(lua) && /less than/.test(lua));
check("empty is read from DF's real job_item_flags1 condition bit",
  /c\.flags1\.empty/.test(lua));
check("authoritative satisfaction comes from DF's item_condition_satisfied vector",
  /item_condition_satisfied/.test(lua) && /conditions\.open/.test(lua));
check("serializer emits description, satisfied, and its provenance",
  /\"description\"/.test(lua) && /\"satisfied\"/.test(lua) && /\"satisfactionSource\"/.test(lua));
check("serializer preserves subtype, material, all five flag words, and extended DF filters",
  /\"itemSubtype\"/.test(lua) && /\"matType\"/.test(lua) && /\"matIndex\"/.test(lua) &&
  [1, 2, 3, 4, 5].every(n => lua.includes(`\"flags${n}\"`)) &&
  /\"reactionClass\"/.test(lua) && /\"contains\"/.test(lua));
check("suggestions fail closed until the DF-owned generator is implemented",
  /authoritative[^\n]+false[^\n]+deferred[^\n]+true[^\n]+suggestions[^\n]+\[\]/.test(lua) &&
  !lua.includes("reagent.item_type"));

const M = renderContext();
const baseOrder = {
  id: 285, pos: 0, job: "Make wooden barrel", amountLeft: 10, amountTotal: 10,
  frequency: "Daily", validated: true, active: false, workshopId: -1,
  itemConditions: [{
    idx: 0, item: "BARREL", itemSubtype: -1, compare: "LessThan", value: 10,
    adjective: "empty", description: "Amount of empty barrels available is less than 10",
    satisfied: true, satisfactionSource: "df-ui",
  }],
  orderConditions: [],
};

console.log("\n# real conditions panel builder consumes the /orders payload");
const html = M.workOrdersMarkup({ hasManager: true, orders: [baseOrder] },
  { mode: "conditions", selectedOrderId: 285 });
check("native repeating header reaches bitmap text",
  html.includes('data-dwfui-bitmap-text="Restarts if completed, conditions checked daily"'));
check("native condition wording reaches bitmap text exactly",
  html.includes('data-dwfui-bitmap-text="Amount of empty barrels available is less than 10"'));
check("DF-owned true result reaches the green row and native satisfied wording",
  /class="dwfui-row wo-condition-row is-satisfied dwfui-row--table dwfui-row--on"/.test(html) &&
  html.includes('data-dwfui-bitmap-text="Satisfied for next check"'));
check("condition row is built by DWFUI.rowHtml",
  /class="dwfui-row wo-condition-row/.test(html) && /dwfui-copy/.test(html));
// Wave 2 (b285_workorder_condition_editor_test.mjs pins the editor itself): write controls are
// now mounted, but the READ contract this suite owns is unchanged -- and suggestions still render
// ONLY when the server sent rows (none were passed here), never invented client-side.
check("Wave 2: no suggestion rows render unless the server sent them; no legacy id-addressed form controls",
  !/data-wo-suggest\b/.test(html) && !/wo-suggest-row/.test(html) &&
  !/id="woCond(?:Item|Value|Compare|Material|Adjective|Other|Type)"/.test(html));

const falseOrder = { ...baseOrder, itemConditions: [{ ...baseOrder.itemConditions[0], satisfied: false }] };
const falseHtml = M.workOrdersMarkup({ hasManager: true, orders: [falseOrder] },
  { mode: "conditions", selectedOrderId: 285 });
check("false is not painted green and does not fabricate unattested failure wording",
  !/is-satisfied|Satisfied for next check/.test(falseHtml));

const unknownOrder = { ...baseOrder, itemConditions: [{ ...baseOrder.itemConditions[0], satisfied: null, satisfactionSource: null }] };
const unknownHtml = M.workOrdersMarkup({ hasManager: true, orders: [unknownOrder] },
  { mode: "conditions", selectedOrderId: 285 });
check("unknown satisfaction fails closed instead of guessing from browser inventory",
  !/is-satisfied|Satisfied for next check/.test(unknownHtml));

assert.equal(typeof M.workOrdersMarkup, "function");
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
