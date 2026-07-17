// cim_kitchen_test.mjs -- OFFLINE fixture for R5 (CIM-labor-kitchen.jpg): category label mapping +
// node --check of the kitchen module (catches syntax regressions in the full-item-list wiring).
// The count>0 filter + exclusion addressing are SERVER-side (kitchen_panel.cpp) and are
// compile-verified / deploy-gated -- not offline-testable without the DLL (see notes closeout).
// B157: cook-toggle cell contract -- every plant/item row must EMIT a mode="cook" toggle AND the
// row/head cell counts must equal the CSS grid track counts (the R5 regression wrapped the actions
// cell into the 28px glyph column, clipping the cook button off-panel: "no Forbid/Allow cooking").
//   node tools/harness/cim_kitchen_test.mjs   (exit 0 PASS / 1 FAIL)

import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-kitchen.js");
globalThis.DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));

// The row renderers use the browser-global escapeHtml (defined in dwf-core.js when the
// scripts are concatenated); provide the same contract for the offline fixture.
globalThis.escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);

const body = M.kitchenBodyMarkup({ items: [], plants: [] }, "plump");
check("body uses the shared DWFUI fill-scroll anatomy", /class="dwfui-scroll kitchen-scroll"/.test(body));
// F7 (Wave 2): searchHtml's wrapper is now UNCONDITIONAL and the shared `.dwfui-search` class is
// emitted ALONGSIDE the consumer's pinned class rather than being REPLACED by it -- previously
// `cls` overwrote `dwfui-search` entirely, which is why the shared search styling reached no
// consumer at all. Kitchen's pinned hooks are unchanged; the assertion is EXTENDED to also prove
// the shared class is present (strangler contract: .dwfui-* styles, pinned classes stay as hooks).
check("body uses the shared DWFUI search anatomy without changing Kitchen's pinned classes",
  /class="dwfui-search kitchen-search-row dwfui-search--footer"/.test(body) &&
  /class="dwfui-search-input"[^>]*id="kitchenSearch"/.test(body) &&
  /class="dwfui-search-btn"[^>]*data-dwfui-native-art="true"/.test(body) &&
  /data-dwfui-sprite="BUTTON_FILTER"/.test(body) && !/info-search-(?:box|button)|128269|🔍/.test(body));

console.log("\n# category labels (served item_type enum key -> display)");
check("MEAT -> Meat", M.kitchenPrettyCategory("MEAT") === "Meat");
check("FISH_RAW -> Raw fish", M.kitchenPrettyCategory("FISH_RAW") === "Raw fish");
check("PLANT_GROWTH -> Plant growth", M.kitchenPrettyCategory("PLANT_GROWTH") === "Plant growth");
check("GLOB -> Fat", M.kitchenPrettyCategory("GLOB") === "Fat");
check("unknown enum key -> title-cased fallback (no crash, no blank)", M.kitchenPrettyCategory("SOME_NEW_TYPE") === "Some new type");
check("empty category -> empty string (no 'undefined')", M.kitchenPrettyCategory("") === "");

// ---- B157 -> WAVE 4: the cook/brew cells ------------------------------------------------------
// B157's original guard was "the row's cell count must equal the .kitchen-row CSS grid tracks",
// because the hand-built row was a 4-track CSS grid and a 5th cell wrapped the cook toggle
// off-panel. Wave 4 RETIRES that row: kitchen rows are now DWFUI `rowHtml({chassis:'table'})`, a
// flex row with explicit `.dwfui-cell` children, so there are no grid tracks to overflow and
// `.kitchen-row` / `.kitchen-head` no longer exist. The invariant B157 actually cared about --
// EVERY ROW STILL EMITS ITS COOK AND BREW CELLS -- is re-pinned below against the new anatomy.
console.log("\n# Wave 4: the row is a DWFUI table row, NOT the old hand-built grid");
const src = fs.readFileSync(modPath, "utf8");
check("the hand-built .kitchen-head block is GONE from the module source",
  !/class="kitchen-head"/.test(src));
check("the inert .kitchen-paging unicode arrows are GONE", !/class="kitchen-paging"/.test(src));
check("the .kitchen-icon-btn hand button is GONE", !/class="kitchen-icon-btn/.test(src));
check("the bowl/tankard EMOJI are GONE (native sprites exist: LABOR_KITCHEN_*)",
  !/&#127858;|&#127868;|&#127860;|&#127793;/.test(src));
check("the inline count hex is GONE (R1 drift)", !/color:#d9b34a/i.test(src));

console.log("\n# Wave 4 plant row: the cook + brew TRI-STATE cells");
const plant = { id: 3, name: "plump helmet", seedCookAllowed: false, plantCookAllowed: true,
  brewCapable: true, brewAllowed: true };
const plantRow = M.kitchenPlantRowHtml(plant);
check("row is a DWFUI table row", /class="dwfui-row [^"]*dwfui-row--table"/.test(plantRow));
check("row emits a mode=\"cook\" control", /<button[^>]*data-kitchen-mode="cook"/.test(plantRow));
check("row emits a mode=\"brew\" control", /<button[^>]*data-kitchen-mode="brew"/.test(plantRow));
check("forbidden cook cell paints RESTRICTED and arms allow (data-kitchen-on=\"1\")",
  /data-kitchen-mode="cook" data-kitchen-on="1"[\s\S]*?LABOR_KITCHEN_COOK_RESTRICTED/.test(plantRow));
check("allowed brew cell paints ALLOWED and arms forbid (data-kitchen-on=\"0\")",
  /data-kitchen-mode="brew" data-kitchen-on="0"[\s\S]*?LABOR_KITCHEN_BREW_ALLOWED/.test(plantRow));
const plantAllowed = M.kitchenPlantRowHtml({ ...plant, seedCookAllowed: true });
check("allowed cook cell flips to LABOR_KITCHEN_COOK_ALLOWED / data-kitchen-on=\"0\"",
  /data-kitchen-mode="cook" data-kitchen-on="0"[\s\S]*?LABOR_KITCHEN_COOK_ALLOWED/.test(plantAllowed));

console.log("\n# Wave 4 item row: cook cell keyed by type+mat+matIndex");
const item = { type: 23, category: "EGG", mat: 43, matIndex: 155, name: "turkey egg", count: 12, cookAllowed: true };
const itemRow = M.kitchenItemRowHtml(item);
check("item row emits a mode=\"cook\" toggle addressed by type+mat+matIndex",
  /<button[^>]*data-kitchen-item-type="23"[^>]*data-kitchen-mat="43"[^>]*data-kitchen-matindex="155"[^>]*data-kitchen-mode="cook"/s.test(itemRow.replace(/\n\s*/g, " ")));
check("an un-brewable item row renders the native CANNOT tile, not an empty span and not a button",
  /LABOR_KITCHEN_BREW_CANNOT/.test(itemRow) && !/data-kitchen-mode="brew"/.test(itemRow));
check("the item icon uses the ITEM channel and fails loud without a spriteRef (never an emoji)",
  /data-df-identity-missing="item:none"/.test(itemRow));
const identifiedFishRow = M.kitchenItemRowHtml({ ...item, category: "FISH_RAW",
  spriteRef: { itemType: "FISH_RAW", itemSubtype: -1, materialType: 2, materialIndex: 0,
    identKind: 2, ident: "FISH_CAVE" } });
check("a species-specific Kitchen item carries its identity through the shared DWFUI item channel",
  /data-dwfui-item=/.test(identifiedFishRow) && /&quot;identKind&quot;:2/.test(identifiedFishRow) &&
  /&quot;ident&quot;:&quot;FISH_CAVE&quot;/.test(identifiedFishRow) &&
  !/data-df-identity-missing/.test(identifiedFishRow));

console.log("\n# seeded-bad: old-DLL / hostile field shapes never lose the cook cell");
const bareRow = M.kitchenPlantRowHtml({ id: 0, name: "pig tail" });   // pre-WD-18 DLL: no toggle fields
check("plant with NO toggle fields still renders a cook toggle (restricted, arms allow)",
  /data-kitchen-mode="cook" data-kitchen-on="1"/.test(bareRow));
check("plant with NO brew fields renders the CANNOT tile, not a live button",
  /LABOR_KITCHEN_BREW_CANNOT/.test(bareRow) && !/data-kitchen-mode="brew"/.test(bareRow));
check("no 'undefined'/'NaN' leaks into the bare row", !/undefined|NaN/.test(bareRow));
const badItem = M.kitchenItemRowHtml({ type: 47, category: "GLOB", mat: -1, matIndex: -1,
  name: "<b>fat</b> & tallow", count: "not-a-number" });
check("item with junk count renders NO count cell content, cook toggle intact",
  /class="dwfui-cell kitchen-count-cell"[^>]*><\/span>/.test(badItem) && /data-kitchen-mode="cook"/.test(badItem));
check("item name is HTML-escaped in the cell", /&lt;b&gt;fat&lt;\/b&gt; &amp; tallow/.test(badItem));
check("no 'undefined'/'NaN' leaks into the junk item row", !/undefined|NaN/.test(badItem));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
