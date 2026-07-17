// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// STOCKPILE-FLOW wave fixture coverage (B137 / B141 / B143 / B149). OFFLINE: no DF, no server,
// no browser. Mechanism assertions follow the b123 pattern (source regexes + exported pure
// builders), each with a test-the-test guard proving the assertion rejects a seeded-bad
// implementation (completeness protocol rule 3).
//
//   B137 - stockpile placement must create the pile INERT (preset=none end to end:
//          client create URL, lua create_stockpile 'none' skip, repaint temp pile "none").
//   B141 - PlantGrowth item labels come from the plant's growth raws name (species-
//          qualified "apple leaf"), not the shared material class word ("leaf"); the
//          client capitalizes the first letter for display like native.
//   B143 - Storage and tools rows: per-field immediate-apply wire URL, steppers, clamps,
//          and no batched Save button.
//   B149 - Meat / Glob / Animal-liquid item labels are creature-qualified via the
//          material's creature prefix + meat_name slots ("aardvark meat", "prepared
//          koala brain"), not the shared template word ("muscle" x1127).
//
//   node tools/harness/stockpile_flow_wave_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const panelPath = join(root, "web/js/dwf-building-zone-stockpile-panels.js");
const panelSource = readFileSync(panelPath, "utf8");
const placementSource = readFileSync(join(root, "web/js/dwf-controls-placement.js"), "utf8");
const luaSource = readFileSync(join(root, "dwf.lua"), "utf8");
// B212: /stockpile-repaint lives in register_stockpile_routes (src/stockpile_panel.cpp) now.
const httpSource = readFileSync(join(root, "src/stockpile_panel.cpp"), "utf8");
const require = createRequire(import.meta.url);
// WAVE-5 HARNESS REPAIR (not a relaxation -- the opposite). `spStorageRowsHtml` is now a DWFUI call
// (the three storage tiles are DWFUI.artBtnHtml on DF's own WORK_ORDERS_* sprites), and this suite
// required the module WITHOUT putting the component layer on the global the way the page does. Both
// B143 checks below were therefore dying in `ReferenceError: DWFUI is not defined` BEFORE they could
// assert anything -- a suite that cannot execute its assertions proves nothing. Same bootstrap as
// b174_wsrebuild_client_test / stockpile_ui_wave_test. Every assertion below is unchanged.
globalThis.escapeHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.dfTokenMatch = (name, q) =>
  String(name || "").toLowerCase().includes(String(q || "").toLowerCase());
globalThis.DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
const panel = require(panelPath);

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

// ---- B137: new piles are created inert (accept nothing until configured) ----

const createUrlInert = source =>
  /`\/stockpile\?player=\$\{encodeURIComponent\(player\)\}[\s\S]{0,200}?preset=none`/.test(source);

check("B137 client: the new-pile create URL uses preset=none (never preset=all)", () => {
  assert.equal(createUrlInert(placementSource), true);
  // backtick-terminated = the URL literal itself (prose comments may mention the old value)
  assert.doesNotMatch(placementSource, /preset=all`/);
});

check("B137 lua: create_stockpile skips the preset import for 'none'", () => {
  assert.match(luaSource, /local want = tostring\(preset or 'all'\):lower\(\)\s*\n\s*if want ~= 'none' then/);
  // the old unconditional fallback ("STOCKPILE_PRESETS[...] or 'all'" directly on the raw
  // preset argument, outside the none-guard) must be gone from create_stockpile
  assert.doesNotMatch(luaSource,
    /local libname = STOCKPILE_PRESETS\[tostring\(preset or 'all'\):lower\(\)\] or 'all'/);
});

check("B137 server: the repaint replacement pile is created \"none\" (settings copied after)", () => {
  assert.match(httpSource, /create_stockpile_via_lua\(camera, px, py, px2, py2, frame_w, frame_h,\s*\n\s*"none", new_id, &err\)/);
  assert.doesNotMatch(httpSource, /"all", new_id, &err\)/);
});

check("B137 test-the-test: a preset=all create URL is rejected", () => {
  const bad = placementSource.replace("preset=none`", "preset=all`");
  assert.equal(createUrlInert(bad), false);
});

// ---- B141: PlantGrowth labels are species-qualified growth names ----

const growthBranch = source =>
  /if cat == df\.organic_mat_category\.PlantGrowth then\s*\n\s*local growth = sp_plant_growth_name\(mat_type, mat_index\)/.test(source);

check("B141 lua: PlantGrowth entries resolve the matching growth's raws name", () => {
  assert.equal(growthBranch(luaSource), true);
  // the growth is matched by its material identity, scanned 0-based (df vectors)
  assert.match(luaSource, /for i = 0, #plant\.growths - 1 do/);
  assert.match(luaSource, /gr\.mat_type == mat_type and gr\.mat_index == mat_index/);
  // no unconditional growths[0] pick (the coincidental-pass failure class from B123)
  assert.doesNotMatch(luaSource, /plant\.growths\[0\]/);
});

check("B141 lua: Seed/Plants sibling cells label from the plant raws (seed_singular / name)", () => {
  assert.match(luaSource, /if cat == df\.organic_mat_category\.Seed or cat == df\.organic_mat_category\.Plants then/);
  assert.match(luaSource, /local s = plant\.seed_singular/);
  // creature-material rows in these tables must keep their fallback (info.plant nil-check)
  assert.match(luaSource, /local plant = info and info\.plant\s*\n\s*if not plant then return nil end/);
});

check("B141 client: item rows display with native first-letter capitalization", () => {
  assert.equal(panel.spDisplayName("apple leaf"), "Apple leaf");
  assert.equal(panel.spDisplayName("alder pollen catkin"), "Alder pollen catkin");
  assert.equal(panel.spDisplayName(""), "");
  assert.equal(panel.spDisplayName(null), "");
  // WAVE-5: this used to pin `escapeHtml(spDisplayName(it.name))` as SOURCE TEXT. The item row now
  // goes through rowHtml({ label: spDisplayName(it.name) }) -- the builder owns the escaping, so the
  // old byte sequence cannot exist and the assertion was forbidding the migration while proving
  // nothing extra. (Seventh instance of this trap in Wave 5.) Assert the GUARANTEE against the
  // EMITTED MARKUP instead: the row shows the capitalized name, and it is escaped.
  const row = panel.speItemRowHtml
    ? panel.speItemRowHtml({ name: "apple leaf", id: 7, on: true }, "food", "fruit")
    : null;
  if (row) {
    assert.match(row, /Apple leaf/, "the rendered row shows the natively-capitalized name");
    assert.doesNotMatch(row, /apple leaf/, "...and not the raw lowercase wire string");
    const nasty = panel.speItemRowHtml({ name: '<img src=x onerror=1>', id: 8, on: false }, "food", "fruit");
    assert.doesNotMatch(nasty, /<img src=x/, "the row escapes the item name");
  } else {
    assert.match(panelSource, /spDisplayName\(it\.name\)/,
      "the item row still routes its name through spDisplayName");
  }
});

check("B141 test-the-test: removing the PlantGrowth branch is rejected", () => {
  const bad = luaSource.replace("df.organic_mat_category.PlantGrowth then", "df.organic_mat_category.NEVER then");
  assert.equal(growthBranch(bad), false);
});

// ---- B149: Meat / Glob / Animal-liquid labels are creature-qualified ----

// Extract the category condition of the creature-formula branch (the `if ... then`
// that feeds sp_creature_material_name). B150 widened it, so assertions are made
// per-category against the extracted condition text rather than one frozen regex.
const creatureBranchCond = source => {
  const m = source.match(
    /if (cat == df\.organic_mat_category\.\w+(?:\s+or\s+cat == df\.organic_mat_category\.\w+)*)\s+then\s*\n\s*local cn = sp_creature_material_name\(mat_type, mat_index\)/);
  return m ? m[1] : "";
};
const creatureBranch = source => {
  const cond = creatureBranchCond(source);
  // B153 moved CreatureLiquid (milk) OUT of the prefix formula into the liquid
  // branch (it is a liquid, labelled by state_name.Liquid, not the frozen Solid
  // base the meat formula uses). Meat/Glob remain creature-prefixed here.
  return ["Meat", "Glob"]
    .every(cat => cond.includes(`organic_mat_category.${cat}`));
};
// the formula must consume the live-probed meat_name slots: [0]=singular (with
// state-name fallback when empty) and [2]=the "prepared"-style name prefix
const meatNameSlots = source =>
  /local base = m\.meat_name\[0\]\s*\n\s*if not base or #base == 0 then base = m\.state_name\.Solid end/.test(source)
  && /local pre = m\.meat_name\[2\]/.test(source);

check("B149 lua: meat/glob/liquid_animal entries resolve creature-qualified names", () => {
  assert.equal(creatureBranch(luaSource), true);
  assert.equal(meatNameSlots(luaSource), true);
  // creature qualifier is the material's creature prefix ("aardvark man"), guarded
  assert.match(luaSource, /local creature = m\.prefix\s*\n\s*if not creature or #creature == 0 then return nil end/);
  // non-creature rows in these tables keep their fallback label
  assert.match(luaSource, /if not \(info and info\.creature\) then return nil end/);
});

check("B149 client: the five owner-verified native labels reproduce from lowercase emissions", () => {
  assert.equal(panel.spDisplayName("aardvark fat"), "Aardvark fat");
  assert.equal(panel.spDisplayName("aardvark meat"), "Aardvark meat");
  assert.equal(panel.spDisplayName("aardvark man tallow"), "Aardvark man tallow");
  assert.equal(panel.spDisplayName("prepared koala brain"), "Prepared koala brain");
  assert.equal(panel.spDisplayName("alligator snapping turtle tallow"),
    "Alligator snapping turtle tallow");
});

check("B149 test-the-test: an implementation that ignores meat_name is rejected", () => {
  // seeded-bad: label from state_name only ("aardvark muscle", "prepared" prefix lost)
  const bad = luaSource
    .replace(/local base = m\.meat_name\[0\]\s*\n\s*if not base or #base == 0 then base = m\.state_name\.Solid end/,
      "local base = m.state_name.Solid")
    .replace(/local pre = m\.meat_name\[2\]/, "local pre = ''");
  assert.equal(meatNameSlots(bad), false);
});

// ---- B150: Leather / Silk / Yarn / Parchment labels are creature-qualified ----
// Live-probed 2026-07-10 (win24 world): Leather 812/812 rows creature-covered,
// Silk 31/41 (10 divine "flowing fabric" rows keep fallback), Yarn 8/8,
// Parchment 811/812 (one PREFIX:NONE "vellum" row keeps fallback).

const B150_WIRED = ["Leather", "Silk", "Yarn", "Parchment"];
// Audited and deliberately left OUT of the creature branch: empty-prefix rows,
// already species-qualified state names, and a prefixed drink would compose
// wrongly (prefix + "frozen mead").
const B150_UNWIRED = ["CreatureDrink", "CreatureCheese", "Pressed", "CreaturePowder", "Paste"];

for (const cat of B150_WIRED) {
  check(`B150 lua: ${cat} entries route through sp_creature_material_name`, () => {
    assert.ok(creatureBranchCond(luaSource).includes(`organic_mat_category.${cat}`),
      `${cat} missing from the creature-formula branch condition`);
  });
}

check("B150 lua: audited-but-unwired tables stay out of the creature branch", () => {
  const cond = creatureBranchCond(luaSource);
  for (const cat of B150_UNWIRED) {
    assert.ok(!cond.includes(`organic_mat_category.${cat}`),
      `${cat} must keep its fallback label (empty-prefix rows; formula composes wrongly)`);
  }
});

check("B150 client: live-probed labels reproduce from lowercase emissions", () => {
  assert.equal(panel.spDisplayName("toad leather"), "Toad leather");
  assert.equal(panel.spDisplayName("brown recluse spider silk"), "Brown recluse spider silk");
  assert.equal(panel.spDisplayName("sheep wool"), "Sheep wool");
  assert.equal(panel.spDisplayName("troll fur"), "Troll fur");
  assert.equal(panel.spDisplayName("woolly mammoth man wool"), "Woolly mammoth man wool");
  assert.equal(panel.spDisplayName("toad parchment"), "Toad parchment");
});

check("B150 test-the-test: dropping Leather from the branch fails its per-table cell", () => {
  const bad = luaSource.replace(
    /cat == df\.organic_mat_category\.Leather or /, "");
  assert.ok(creatureBranchCond(bad).includes("organic_mat_category.Silk"),
    "seeded-bad must still extract the branch (only Leather removed)");
  assert.equal(creatureBranchCond(bad).includes("organic_mat_category.Leather"), false);
});

// ---- B153: drink / liquid labels come from the LIQUID state name, not SOLID ----
// A material's state_name.Solid is its FROZEN form ("frozen bumblebee mead",
// "frozen milk"); DF's native stockpile labels a stored drink/liquid by
// state_name.Liquid ("bumblebee mead", "milk"). The generic fallback read .Solid.

// the shared helper reads .Liquid first, degrading to .Solid then nil
const liquidHelperReadsLiquid = source =>
  /local base = m\.state_name\.Liquid\s*\n\s*if not base or #base == 0 then base = m\.state_name\.Solid end/.test(source);
// drinks + plant/misc liquid -> bare liquid name (qualify=false)
const liquidBranch = source =>
  /if cat == df\.organic_mat_category\.PlantDrink or\s*\n\s*cat == df\.organic_mat_category\.CreatureDrink or\s*\n\s*cat == df\.organic_mat_category\.PlantLiquid or\s*\n\s*cat == df\.organic_mat_category\.MiscLiquid then\s*\n\s*local ln = sp_liquid_material_name\(mat_type, mat_index, false\)/.test(source);

check("B153 lua: sp_liquid_material_name reads state_name.Liquid (frozen Solid is the bug)", () => {
  assert.equal(liquidHelperReadsLiquid(luaSource), true);
  // creature liquids keep the B149 prefix qualifier, but only on the liquid base
  assert.match(luaSource, /if qualify and info\.creature then\s*\n\s*local pre = m\.prefix/);
});

check("B153 lua: PlantDrink/CreatureDrink/PlantLiquid/MiscLiquid route to the liquid name", () => {
  assert.equal(liquidBranch(luaSource), true);
  // CreatureLiquid (milk) is creature-qualified (qualify=true) via the liquid base
  assert.match(luaSource,
    /if cat == df\.organic_mat_category\.CreatureLiquid then\s*\n\s*local ln = sp_liquid_material_name\(mat_type, mat_index, true\)/);
  // and it is no longer in the creature-prefix (frozen-Solid-base) formula
  assert.equal(creatureBranchCond(luaSource).includes("organic_mat_category.CreatureLiquid"), false);
});

check("B153 client: liquid labels reproduce native forms via first-letter capitalization", () => {
  assert.equal(panel.spDisplayName("bumblebee mead"), "Bumblebee mead");
  assert.equal(panel.spDisplayName("dwarven wine"), "Dwarven wine");
  assert.equal(panel.spDisplayName("milk"), "Milk");
  assert.equal(panel.spDisplayName("aardvark milk"), "Aardvark milk");
  assert.equal(panel.spDisplayName("lye"), "Lye");
});

check("B153 test-the-test: a helper that reads state_name.Solid is rejected", () => {
  // seeded-bad: the frozen name ("frozen bumblebee mead") the bug reported
  const bad = luaSource.replace(
    /local base = m\.state_name\.Liquid\s*\n\s*if not base or #base == 0 then base = m\.state_name\.Solid end/,
    "local base = m.state_name.Solid");
  assert.equal(liquidHelperReadsLiquid(bad), false);
});

check("B153 test-the-test: dropping CreatureDrink from the liquid branch is rejected", () => {
  const bad = luaSource.replace(
    /cat == df\.organic_mat_category\.CreatureDrink or\s*\n\s*/, "");
  assert.equal(liquidBranch(bad), false);
});

// ---- B143: Storage and tools (max barrels / bins / wheelbarrows) ----

check("B143: all three max-container fields render with input + both steppers", () => {
  const html = panel.spStorageRowsHtml({ barrels: 36, bins: 0, wheelbarrows: 5 });
  for (const [key, label] of panel.SP_STORAGE_FIELDS) {
    assert.match(html, new RegExp(`data-sp-storage="${key}"[^>]*value="`));
    assert.match(html, new RegExp(`data-sp-step="${key}" data-delta="1"`));
    assert.match(html, new RegExp(`data-sp-step="${key}" data-delta="-1"`));
    assert.ok(html.includes(label), `label ${label}`);
  }
  assert.match(html, /value="36"/);
  assert.deepEqual(panel.SP_STORAGE_FIELDS.map(([k]) => k), ["barrels", "bins", "wheelbarrows"]);
});

check("B143: wire URL carries exactly one field, clamped to [0,3000]", () => {
  assert.equal(panel.spStorageUrl(23, "bins", 7), "/stockpile-storage?id=23&bins=7");
  assert.equal(panel.spStorageUrl(23, "barrels", 99999), "/stockpile-storage?id=23&barrels=3000");
  assert.equal(panel.spStorageUrl(23, "wheelbarrows", -4), "/stockpile-storage?id=23&wheelbarrows=0");
  assert.equal(panel.spStorageUrl(23, "barrels", "junk"), "/stockpile-storage?id=23&barrels=0");
  assert.doesNotMatch(panel.spStorageUrl(23, "bins", 7), /barrels=|wheelbarrows=/);
});

check("B143: values render clamped and non-numeric storage degrades to 0", () => {
  const html = panel.spStorageRowsHtml({ barrels: 99999, bins: -3, wheelbarrows: "x" });
  assert.match(html, /data-sp-storage="barrels"[^>]*value="3000"/);
  assert.match(html, /data-sp-storage="bins"[^>]*value="0"/);
  assert.match(html, /data-sp-storage="wheelbarrows"[^>]*value="0"/);
  assert.match(panel.spStorageRowsHtml(null), /data-sp-storage="barrels"[^>]*value="0"/);
});

check("B143: native 'Storage and tools' window with immediate apply (no Save button)", () => {
  // B143 exact-parity fold-in (oracle B143-1.png): the storage rows moved from an inline
  // panel section into native's separate "Storage and tools" window, opened by the barrel
  // tool tile and closed by its Done plaque (see b151_parity_test.mjs for the window cells).
  // The immediate-apply single-field wire is unchanged.
  assert.match(panelSource, /spn-storagetitle">Storage and tools</);
  assert.match(panelSource, /data-spn-storage-open/);
  assert.match(panelSource, /data-spn-storage-done/);
  assert.match(panelSource, /spStorageRowsHtml\(storage\)/);
  assert.doesNotMatch(panelSource, /data-sp-storage-save/);
  // steppers and input changes both route through the single-field wire helper
  assert.match(panelSource, /await postStockpile\(spStorageUrl\(id, key, el && el\.value\)\)/);
  assert.match(panelSource, /\[data-sp-step\]"\)\.forEach\(btn => btn\.addEventListener\("click"/);
  assert.match(panelSource, /\[data-sp-storage\]"\)\.forEach\(inp => inp\.addEventListener\("change"/);
});

check("B143 test-the-test: a batched three-field URL is rejected by the single-field assertion", () => {
  const badUrl = "/stockpile-storage?id=23&barrels=1&bins=2&wheelbarrows=3";
  assert.throws(() => assert.doesNotMatch(badUrl, /barrels=|wheelbarrows=/));
});

if (failed) process.exit(1);
console.log("stockpile_flow_wave_test: PASS");
