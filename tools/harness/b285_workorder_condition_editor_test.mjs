// b285_workorder_condition_editor_test.mjs -- B285 wave-2: the work-order condition EDITOR
// (native parity per evidence/oracles/workorders/WO-CONDITIONS-native.png).
//
// the decisions pinned here:
//   * NO permission gates (friends-trust model) -- and no hostwrite flags appear anywhere.
//   * Strict DATA validation stays: every write validates item_type/material/comparison/adjective
//     against DF's real enums before touching DF memory; malformed input is refused with a clear
//     error (a bad index in a condition is read by DF's DAILY check and can crash far from the write).
//   * Suggestions: no lossy offscreen generator. The current server fails closed; future exact
//     rows must carry opaque add tokens bound to DF's live native filter, never reduced prose.
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
const cppRoutes = readFileSync(join(root, "src", "work_orders.cpp"), "utf8");
const cppBridge = readFileSync(join(root, "src", "lua_bridge.cpp"), "utf8");
const hBridge = readFileSync(join(root, "src", "lua_bridge.h"), "utf8");
const laborPath = join(root, "web", "js", "dwf-labor-work-orders.js");
const laborSrc = readFileSync(laborPath, "utf8");
const require = createRequire(import.meta.url);
const DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) { console.log(`ok ${++passed} - ${name}`); return; }
  console.error(`not ok ${++failed} - ${name}`);
}

// Slice one top-level lua function body out of the file (crude but stable: header to the next
// column-0 `function ` or `local function `).
function luaFn(name) {
  const m = lua.match(new RegExp(`\\nfunction ${name}\\(([\\s\\S]*?)\\n(?=function |local function )`));
  return m ? m[0] : "";
}

console.log("# Lua write path: one strict validator, add + edit + refusal wording");
const addBody = luaFn("add_item_condition");
const editBody = luaFn("edit_item_condition");
check("edit_item_condition exists (edit-in-place is a real function, not remove+add)",
  editBody.length > 0);
check("add and edit share the strict validator",
  /local function validate_item_condition_input\(/.test(lua) &&
  /validate_item_condition_input\(/.test(addBody) &&
  /validate_item_condition_input\(/.test(editBody));
check("edit mutates the existing entry: no allocation, no vector insert in its body",
  /o\.item_conditions\[idx\]/.test(editBody) &&
  !/:new\(/.test(editBody) && !/insert\(/.test(editBody));
check("comparison must be one of DF's 6 real enum values (NONE/-1 refused)",
  /bad comparison/.test(lua) && /ctype == nil or ctype < 0/.test(lua));
check("value must be numeric; refused otherwise (not defaulted to 0)",
  /bad value/.test(lua));
check("item type resolved against df.item_type or refused",
  /bad item type/.test(lua));
check("material pair must decode through DF's real material registry (matinfo) or be refused",
  /bad material/.test(lua) &&
  /validate_item_condition_input[\s\S]{0,900}matinfo\.decode/.test(lua));
check("unknown adjective keys are refused (not silently ignored)",
  /bad adjective/.test(lua));
check("the native `empty` bit is writable via the validated adjective path",
  /empty/.test(lua.slice(lua.indexOf("local function resolve_condition_adjectives"),
                         lua.indexOf("local function resolve_condition_adjectives") + 800)));
check("edit clears only the editor-owned adjective bits before applying the new ones",
  /pairs\(CONDITION_ADJECTIVES\)/.test(editBody) && /= false/.test(editBody));
check("add still initialises DF's no-init-value sentinels (metal_ore/has_tool_use/dye_color = -1)",
  /c\.metal_ore = -1/.test(addBody) && /c\.has_tool_use = -1/.test(addBody) &&
  /c\.dye_color = -1/.test(addBody));
check("bad condition index refused on edit and remove",
  /bad condition index/.test(editBody) && /bad condition index/.test(luaFn("remove_condition")));

console.log("\n# Lua suggestions: no barrel special case; lossless provider still deferred");
const sugBody = luaFn("suggested_conditions");
check("MakeBarrel is not a privileged guessed provider",
  !/df\.job_type\.MakeBarrel/.test(sugBody) && !/oracle-pinned/.test(sugBody));
check("all orders fail closed until a complete native filter is available",
  /deferred[^\n]+true[^\n]+suggestions[^\n]+\[\]/.test(sugBody) &&
  /"authoritative":false/.test(sugBody) && !sugBody.includes("amount_total") &&
  !lua.includes("reagent.item_type") && !/workflow\.listJobOutputs\s*\(/.test(sugBody));
check("native sentence casing: the item label is lowercased inside the sentence (empty barrels, not empty Barrels)",
  /function item_condition_description[\s\S]{0,800}:lower\(\)/.test(lua));

console.log("\n# C++ surface: edit route + bridge (no permission gates, full state required)");
check("/order-condition-item-edit route registered (GET+POST)",
  (cppRoutes.match(/\/order-condition-item-edit/g) || []).length >= 2);
check("edit route requires the full explicit state (no defaulted compare/value rewriting DF memory)",
  /missing id\/idx/.test(cppRoutes) && /missing compare\/value/.test(cppRoutes));
check("bridge edit_item_condition_via_lua exists, declared, and calls the lua fn",
  /edit_item_condition_via_lua/.test(hBridge) &&
  /call_lua\("edit_item_condition"/.test(cppBridge));
check("NO permission gates anywhere in the condition write path (decision: friends-trust)",
  !/hostwrite|host_only|is_host|requirePermission/i.test(cppRoutes));

console.log("\n# JS <-> Lua contract drift guards");
const adjBlockJs = laborSrc.match(/const WO_ADJECTIVES = \[([\s\S]*?)\];/)?.[1] || "";
const jsAdjKeys = [...adjBlockJs.matchAll(/\["(\w*)"/g)].map(m => m[1]).filter(Boolean);
const adjBlockLua = lua.match(/local CONDITION_ADJECTIVES = \{([\s\S]*?)\n\}/)?.[1] || "";
const luaAdjKeys = new Set([...adjBlockLua.matchAll(/\n\s*(\w+)\s*=\s*\{/g)].map(m => m[1]));
luaAdjKeys.add("empty"); // validated explicitly by resolve_condition_adjectives, not via the table
check("every JS adjective key is accepted by the lua validator (incl. empty)",
  jsAdjKeys.length >= 13 && jsAdjKeys.every(k => luaAdjKeys.has(k)) && jsAdjKeys.includes("empty"));
const cycle = laborSrc.match(/const WO_COMPARE_CYCLE = \[([^\]]+)\]/)?.[1] || "";
const cycleNames = [...cycle.matchAll(/"(\w+)"/g)].map(m => m[1]);
check("the comparison toggle cycles exactly DF's 6 enum values in enum order (df.workquota.xml:2)",
  cycleNames.join(",") === "AtLeast,AtMost,GreaterThan,LessThan,Exactly,Not");

console.log("\n# Rendered editor: native controls per WO-CONDITIONS-native.png");
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
const M = renderContext();

// This fixture is byte-shaped like the /orders serializer output AFTER an editor write: the
// round-trip contract is that the merged read view renders exactly what the editor wrote.
const barrelCond = {
  idx: 0, item: "BARREL", itemSubtype: -1, compare: "LessThan", value: 10,
  adjective: "empty", material: "", matType: -1, matIndex: -1,
  flags1: 1024, flags2: 0, flags3: 0, flags4: 0, flags5: 0,
  reactionClass: "", reactionProduct: "", metalOre: -1, minDimension: -1,
  contains: [], reactionId: -1, toolUse: "", dyeColor: -1,
  description: "Amount of empty barrels available is less than 10",
  satisfied: true, satisfactionSource: "df-ui",
};
const baseOrder = {
  id: 285, pos: 0, job: "Make wooden barrel", amountLeft: 10, amountTotal: 10,
  frequency: "Daily", validated: true, active: false, workshopId: -1,
  itemConditions: [barrelCond],
  orderConditions: [{ idx: 0, label: "after #12 is completed", other: 12, type: "Completed",
    satisfied: null, satisfactionSource: null }],
};
const html = M.workOrdersMarkup({ hasManager: true, orders: [baseOrder] },
  { mode: "conditions", selectedOrderId: 285 });

check("read half is unchanged: exact native sentence + DF-owned satisfied state still render",
  html.includes('data-dwfui-bitmap-text="Amount of empty barrels available is less than 10"') &&
  /class="dwfui-row wo-condition-row is-satisfied dwfui-row--table dwfui-row--on"/.test(html) &&
  html.includes('data-dwfui-bitmap-text="Satisfied for next check"'));
check("count value stepper on the row (native # / + / - cluster), showing the row's value",
  /data-wo-cond-val="0"/.test(html) && /data-wo-cond-val-inc="0"/.test(html) &&
  /data-wo-cond-val-dec="0"/.test(html) && /value="10"/.test(html));
check("comparison toggle tile uses the native <>=# glyph (WORK_ORDERS_CONDITIONS)",
  /data-wo-cond-cmp="0"/.test(html) &&
  /WORK_ORDERS_CONDITIONS[^>]*"[^>]*data-wo-cond-cmp="0"|data-wo-cond-cmp="0"[\s\S]{0,200}WORK_ORDERS_CONDITIONS/.test(html));
check("Type / Mat / Adj selector tabs use DF's own boxed-text tiles",
  html.includes("WORK_ORDERS_CHANGE_TYPE") && html.includes("WORK_ORDERS_CHANGE_MAT") &&
  html.includes("WORK_ORDERS_CHANGE_ADJ") && /data-wo-cond-tab="type"/.test(html) &&
  /data-wo-cond-tab="mat"/.test(html) && /data-wo-cond-tab="adj"/.test(html));
check("red X remove on item AND order condition rows (WORK_ORDERS_REMOVE, kind-addressed)",
  /data-wo-remove-cond="285" data-kind="item" data-idx="0"/.test(html) &&
  /data-wo-remove-cond="285" data-kind="order" data-idx="0"/.test(html));
check("header add tiles: new item condition + new order condition (native art)",
  /data-wo-add-item-cond/.test(html) && html.includes("WORK_ORDERS_ADD_ITEM_CONDITION") &&
  /data-wo-add-order-cond-open/.test(html) && html.includes("WORK_ORDERS_ADD_ORDER_CONDITION"));
check("no raw <select>/<input type=number>/hand-built <button> introduced by the editor row",
  typeof M.woConditionRowHtml === "function" &&
  (() => { const row = M.woConditionRowHtml(barrelCond, { orderId: 285, kind: "item" });
    return !/<select/.test(row) && /dwfui-stepper/.test(row); })());

console.log("\n# Suggestions: exact server rows only; native identity suppresses only the + tile");
check("woSuggestionRowsHtml is exported and pure", typeof M.woSuggestionRowsHtml === "function");
const suggestions = [
  { label: "Amount of empty barrels available is less than 10", item: "BARREL",
    itemSubtype: -1, compare: "LessThan", value: 10, adjective: "empty", material: "",
    matType: -1, matIndex: -1, flags1: 1024, flags2: 0, flags3: 0, flags4: 0, flags5: 0,
    reactionClass: "", reactionProduct: "", metalOre: -1, minDimension: -1,
    contains: [], reactionId: -1, toolUse: "", dyeColor: -1, token: "native-0" },
  { label: "Amount of barrels available is less than 10", item: "BARREL",
    itemSubtype: -1, compare: "LessThan", value: 10, adjective: "", material: "",
    matType: -1, matIndex: -1, flags1: 0, flags2: 0, flags3: 0, flags4: 0, flags5: 0,
    reactionClass: "", reactionProduct: "", metalOre: -1, minDimension: -1,
    contains: [], reactionId: -1, toolUse: "", dyeColor: -1, token: "native-1" },
  { label: "Amount of logs available is greater than 10", item: "WOOD",
    itemSubtype: -1, compare: "GreaterThan", value: 10, adjective: "", material: "",
    matType: -1, matIndex: -1, flags1: 0, flags2: 0, flags3: 0, flags4: 0, flags5: 0,
    reactionClass: "", reactionProduct: "", metalOre: -1, minDimension: -1,
    contains: [], reactionId: -1, toolUse: "", dyeColor: -1, token: "native-2" },
];
const sugHtml = M.woSuggestionRowsHtml(suggestions, [barrelCond]);
check("suggestion block renders the native header and all three sentences as bitmap text",
  sugHtml.includes('data-dwfui-bitmap-text="Suggested conditions"') &&
  suggestions.every(s => sugHtml.includes(`data-dwfui-bitmap-text="${s.label}"`)));
check("the already-added suggestion has NO + tile (absent cell, native-style); the other two do",
  !new RegExp(`data-wo-suggest="0"`).test(sugHtml) &&
  /data-wo-suggest="1"/.test(sugHtml) && /data-wo-suggest="2"/.test(sugHtml) &&
  (sugHtml.match(/WORK_ORDERS_ADD_SUGGESTED_CONDITION/g) || []).length === 2);
check("native duplicate identity ignores operator, threshold, and contains",
  M.woConditionDuplicate([barrelCond],
    { ...suggestions[0], compare: "Exactly", value: 999, contains: [7, 8] }, "item"));
check("a changed scalar filter field remains addable",
  !M.woConditionDuplicate([barrelCond], { ...suggestions[0], dyeColor: 4 }, "item"));
const displayOnly = M.woSuggestionRowsHtml([{ ...suggestions[2], token: "" }], []);
check("a suggestion without an opaque native token is display-only",
  /wo-suggest-row/.test(displayOnly) && !/data-wo-suggest=/.test(displayOnly));
check("no suggestions -> no invented block at all",
  M.woSuggestionRowsHtml([], []) === "" &&
  !/wo-suggest-row/.test(html)); // the base render got no suggestions option
const sugInMarkup = M.workOrdersMarkup({ hasManager: true, orders: [baseOrder] },
  { mode: "conditions", selectedOrderId: 285, suggestions });
check("conditions screen mounts the suggestion block only when the server sent rows",
  /wo-suggest-row/.test(sugInMarkup) &&
  sugInMarkup.includes('data-dwfui-bitmap-text="Suggested conditions"'));
check("suggestion writes return only an opaque token, never a browser-reconstructed filter",
  /order-condition-suggested-add/.test(laborSrc) && /token: s\.token/.test(laborSrc) &&
  !/order-condition-item-add"[^\n]+item: s\.item/.test(laborSrc));

console.log("\n# Pickers: Type / Mat / Adj chooser rows are DWFUI-built and value-addressed");
check("woCondPickerHtml is exported for fixture rendering", typeof M.woCondPickerHtml === "function");
if (typeof M.woCondPickerHtml === "function") {
  const typePicker = M.woCondPickerHtml("type", barrelCond,
    { targets: [{ item: "BARREL", label: "Barrels" }, { item: "WOOD", label: "Logs" }] });
  check("type picker lists condition targets and marks the current one",
    /data-wo-cond-pick="type"/.test(typePicker) && /data-value="WOOD"/.test(typePicker) &&
    /dwfui-row--on/.test(typePicker));
  const matPicker = M.woCondPickerHtml("mat", barrelCond,
    { materials: [{ matType: 420, matIndex: 12, name: "oak", count: 3 }] });
  check("mat picker offers Any material plus fort materials as matType:matIndex values",
    /data-value=""/.test(matPicker) && /data-value="420:12"/.test(matPicker));
  const adjPicker = M.woCondPickerHtml("adj", barrelCond, {});
  check("adj picker offers the validated adjective set incl. empty, current one marked",
    /data-value="empty"/.test(adjPicker) && /data-value="metal"/.test(adjPicker) &&
    /dwfui-row--on/.test(adjPicker));
} else { failed += 3; }

assert.equal(typeof M.workOrdersMarkup, "function");
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
