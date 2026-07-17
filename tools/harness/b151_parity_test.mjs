// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// B151/B143 STOCKPILE EXACT-PARITY fixture coverage. OFFLINE: no DF, no server, no browser.
// Oracles: tools/orchestrator/attachments/B151-1.png (native 3-column settings closeup, r1),
// B151-3.png (native at the full 1999x1303 DF window -- THE r2 scale + tri-state reference;
// B151-4.png is our browser capture it corrects) and B143-1.png (native stockpile window +
// Storage and tools window). Mechanism assertions follow the b123 pattern (source regexes +
// exported pure builders), each risky cell with a test-the-test guard proving the assertion
// rejects a seeded-bad implementation.
//
//   B151.4 - THE STATE BUG: a flag-off category stores nothing, so it renders red/X even when
//            every item bit is still on (DF keeps bits and flags independent; "preset none"
//            clears only flags.whole).
//   B151.3 - state IS color, categories included: off = red row + X, on = green row + check,
//            partial = grey row + dash.
//   B151.7 - (r2) the DISPLAY tri-state derives from contents at every level: category from
//            its groups' bits, group from its items' bits (B151-3 shows Food dashed while its
//            flag is on; Wood flag-on + Trees none must show X). Write path keeps the flags.
//   B151.8 - (r2) no-flash: paint final or nothing-until-ready. The default row is stateless;
//            selection paints the remembered state synchronously from the caches.
//   B151.9 - (r2) window-scale parity: panel 0.8239 x 0.8749 of the window, row pitch 0.03914
//            of window height, columns 370/343 native px -- via --spe-zoom over SPE_BASE.
//   B151.5 - column 3 sorts alphabetically by DISPLAY label ("Prepared toad eye" clusters
//            under P); columns 1-2 keep native's fixed order (never alphabetized).
//   B151.6 - no "N/N enabled" counter line; native All/None plaques; hidden empty groups
//            (native's Food column shows 18 of our 20 groups); native column-2 labels.
//   B143   - native type grid (column-major order/labels, corrected icon rows) and the
//            Storage and tools window (value + # / + / - tiles, immediate apply, Done).
//
//   node tools/harness/b151_parity_test.mjs
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
const css = readFileSync(join(root, "web/css/dwf.css"), "utf8");

// the pure builders resolve escapeHtml/dfTokenMatch as globals at CALL time (core.js in the
// browser); the fixture provides minimal stand-ins before requiring the module.
globalThis.escapeHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.dfTokenMatch = (name, q) => String(name || "").toLowerCase().includes(String(q || "").toLowerCase());
const require = createRequire(import.meta.url);
// WAVE 5: the B151 row builders now render through the shared DWFUI component layer, so the
// fixture must mirror the BROWSER LOAD ORDER (ui-components loads first) exactly as the b55 and
// b174 fixtures already do. Requiring the module also publishes globalThis.DWFUI, which is how the
// panel resolves it at call time.
globalThis.DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
const panel = require(panelPath);

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

// ---- B151.4: the ammo-state-on-open regression (the exact reported bug) ----

check("B151.4 flag-off category renders Ammo red/X despite all-on bits (pile-122 truth, derived model)", () => {
  // live-verified server truth (pile 122): flags = food only, ammo item bits still 9/9 on.
  // r2: display DERIVES from contents, and a flag-off category stores nothing -> 'none'.
  const noneSetFlags = { food: true };            // ammo flag OFF
  assert.equal(panel.speCatFlag(noneSetFlags, "ammo"), false);
  const state = panel.speCatDerivedState(panel.speCatFlag(noneSetFlags, "ammo"), [{ on: 9, total: 9 }]);
  assert.equal(state, "none");
  const html = panel.speCatRowHtml("Ammo", "ammo", 0, state, false);
  assert.match(html, /spe-cat off/);
  assert.match(html, /spe-state x/);
  assert.doesNotMatch(html, /spe-cat on/);
  assert.doesNotMatch(html, /spe-state check/);
});

check("B151.4 one complete read-only snapshot precedes the first final category paint", () => {
  assert.match(panelSource, /await speFetchSnapshot\(seq\)[\s\S]{0,400}loadSpGroups\(speDefaultCat\(\)\)/);
  // B231: the editor became target-addressed (it drives a stockpile OR a hauling stop, whose
  // `settings` is the same df::stockpile_settings), so the snapshot URL is composed by speUrl()
  // and the literal `/stockpile-settings-snapshot?id=` no longer appears verbatim. The invariant
  // this cell guards -- ONE read-only snapshot fetch, before the first category paint -- is intact;
  // assert it against the builder, plus the prefix table that still yields the same pile URL.
  assert.match(panelSource, /speUrl\("settings-snapshot", `t=\$\{Date\.now\(\)\}`\)/);
  assert.match(panelSource, /const prefix = speIsStop\(\) \? "\/hauling-stop-" : "\/stockpile-";/);
});

check("B151.4 navigation selection is deterministic and independent of enabled settings", () => {
  assert.equal(panel.speDefaultCat({ food: true }), "ammo");
  assert.equal(panel.speDefaultCat({ ammo: false, food: true }), "ammo");
  assert.equal(panel.speDefaultCat({}), "ammo");
});

check("B151.4 test-the-test: a bits-only category row (flag ignored) is rejected", () => {
  // seeded-bad: derive from the bits alone -- pile-122's all-on ammo bits give 'all' -> green
  const bitsOnlyState = "all";
  const bad = panel.speCatRowHtml("Ammo", "ammo", 0, bitsOnlyState, false);
  assert.throws(() => assert.match(bad, /spe-cat off/));
  assert.throws(() => assert.doesNotMatch(bad, /spe-state check/));
});

// ---- B151.3: state IS color, everywhere ----

check("B151.3 flag map: sheets->sheet, bars->bars_blocks, finished->finished_goods resolve", () => {
  assert.equal(panel.speCatFlag({ sheet: true }, "sheets"), true);
  assert.equal(panel.speCatFlag({ bars_blocks: true }, "bars"), true);
  assert.equal(panel.speCatFlag({ finished_goods: true }, "finished"), true);
  assert.equal(panel.speCatFlag({ finished_goods: true }, "food"), false);
});

check("B151.3 sub-group aggregate maps to native art: all=green check, some=GREY dash, none=red X", () => {
  assert.equal(panel.speStateFor({ on: 5, total: 5 }), "all");
  assert.equal(panel.speStateFor({ on: 1, total: 5 }), "some");
  assert.equal(panel.speStateFor({ on: 0, total: 5 }), "none");
  assert.equal(panel.speStateFor(null), null);
  const full = panel.speGroupRowHtml("Meat", "meat", "all", false, false);
  assert.match(full, /spe-group on/); assert.match(full, /spe-state check/);
  // r2: partial rows are the GREY art (oracle B151-3's Food row), not green
  const part = panel.speGroupRowHtml("Meat", "meat", "some", false, false);
  assert.match(part, /spe-group some/); assert.match(part, /spe-state dash/);
  assert.doesNotMatch(part, /spe-group on/);
  const none = panel.speGroupRowHtml("Meat", "meat", "none", false, false);
  assert.match(none, /spe-group off/); assert.match(none, /spe-state x/);
});

check("B151.3 oracle special case: a single-entry group (Prepared meals) shows no check when on", () => {
  const html = panel.speGroupRowHtml("Prepared meals", "prepared", "all", false, true);
  assert.match(html, /spe-group on/);
  assert.doesNotMatch(html, /spe-state/);
});

check("B151.3 item rows carry on/off state classes (green/red rows, no icons in column 3)", () => {
  assert.match(panel.speItemRowHtml({ idx: 3, name: "toad meat", on: true }), /spe-item on/);
  assert.match(panel.speItemRowHtml({ idx: 3, name: "toad meat", on: false }), /spe-item off/);
  assert.doesNotMatch(panel.speItemRowHtml({ idx: 3, name: "toad meat", on: true }), /spe-state/);
});

check("B151.3 the native state sprites ship in the stylesheet (check / dash / x / row tiles / gold frame)", () => {
  for (const v of ["--spa-check", "--spa-dash", "--spa-x", "--spa-row-red", "--spa-row-green", "--spa-frame-gold", "--spa-iconboxes", "--spa-winframe"])
    assert.ok(css.includes(v + ":"), v);
  assert.match(css, /\.spe-row\.off \{ border-image-source: var\(--spa-row-red\); \}/);
});

// ---- B151.5: sorting ----

check("B151.5 column 3 sorts by display label: Prepared* clusters under P", () => {
  const items = [
    { idx: 0, name: "toad meat", on: true },
    { idx: 1, name: "prepared toad eye", on: true },
    { idx: 2, name: "aardvark meat", on: true },
    { idx: 3, name: "prepared aardvark brain", on: true },
    { idx: 4, name: "Worm tripe", on: true },
  ];
  const sorted = panel.spSortItems(items).map(it => it.name);
  assert.deepEqual(sorted, [
    "aardvark meat", "prepared aardvark brain", "prepared toad eye", "toad meat", "Worm tripe",
  ]);
});

check("B151.5 columns 1-2 keep native fixed order (never alphabetized)", () => {
  // native order from B151-1.png: ...Leather, Corpses, Refuse... (not alphabetical)
  const keys = panel.SP_EDIT_CATS.map(([, k]) => k);
  assert.deepEqual(keys, ["ammo", "animals", "armor", "bars", "cloth", "coins", "finished",
    "food", "furniture", "gems", "leather", "corpses", "refuse", "sheets", "stone", "weapons", "wood"]);
  // and the render path must not sort the group cache
  assert.doesNotMatch(panelSource, /spGroupsCache\s*\.\s*sort/);
});

check("B151.5 test-the-test: raw-name ordering would misplace capitalized Prepared items", () => {
  // seeded-bad: sorting by raw byte order puts "Worm tripe" before "aardvark meat"
  const raw = ["Worm tripe", "aardvark meat"].sort();
  assert.equal(raw[0], "Worm tripe");
  const good = panel.spSortItems([{ idx: 0, name: "Worm tripe" }, { idx: 1, name: "aardvark meat" }]);
  assert.equal(good[0].name, "aardvark meat");
});

// ---- B151.6: native layout details ----

check("B151.6 the N/N enabled counter line is gone", () => {
  assert.doesNotMatch(panelSource, /spe-count/);
  assert.doesNotMatch(panelSource, /\/\$\{[^}]*length\} enabled/);
  const html = panel.speItemsHtml([{ idx: 0, name: "toad meat", on: true }], "");
  assert.doesNotMatch(html, /enabled/);
});

check("B151.6 empty groups are hidden like native (Food shows 18 of 20 in the live world)", () => {
  const groups = [{ key: "meat" }, { key: "cheese_plant" }, { key: "glob" }];
  const agg = { meat: { on: 3, total: 3 }, cheese_plant: { on: 0, total: 0 }, glob: null };
  const vis = panel.speVisibleGroups(groups, agg).map(g => g.key);
  assert.deepEqual(vis, ["meat", "glob"]);   // unknown stays visible until counted
});

check("B151.6 native column-2 labels map over the server vocabulary (Fish/Egg/Fat/Bone meal...)", () => {
  assert.equal(panel.spGroupLabel("food", "fish", "Prepared fish"), "Fish");
  assert.equal(panel.spGroupLabel("food", "egg", "Eggs"), "Egg");
  assert.equal(panel.spGroupLabel("food", "glob", "Glob"), "Fat");
  assert.equal(panel.spGroupLabel("food", "leaves", "Leaves / growths"), "Fruit/leaves");
  assert.equal(panel.spGroupLabel("food", "liquid_misc", "Misc liquid"), "Misc. liquid");
  // unmapped categories keep the server label
  assert.equal(panel.spGroupLabel("ammo", "mats", "Metal"), "Metal");
});

check("B151.6 category column labels/icons match the oracle (Sheet singular; corpses=skull row 7)", () => {
  const byKey = Object.fromEntries(panel.SP_EDIT_CATS.map(([label, key, row]) => [key, { label, row }]));
  assert.equal(byKey.sheets.label, "Sheet");
  assert.equal(byKey.corpses.row, 7);
  assert.equal(byKey.finished.row, 8);
  assert.equal(byKey.food.row, 9);
  assert.equal(byKey.furniture.row, 10);
  assert.equal(byKey.gems.row, 11);
  assert.equal(byKey.leather.row, 12);
});

check("B151.6 items scroll only inside column 3; columns 1-2 never scroll", () => {
  assert.match(css, /\.spe-list \{ min-height: 0; overflow: hidden; \}/);
  assert.match(css, /\.spe-items \{ overflow-y: auto; \}/);
});

// ---- B151.9 (r2): window-scale parity, measured from oracle B151-3.png ----
// Native at its full 1999x1303 window: panel 1647x1140 (0.8239 x 0.8749 of the window),
// row pitch 51px (0.03914 of window height), columns 370/343px, 32px gaps. The stylesheet
// keeps the 39px-pitch metrics; --spe-zoom = panel size / SPE_BASE (native px x 39/51)
// rescales the whole editor so those fractions hold at any viewport.

check("B151.9 base metrics: 39px rows, 283/262px columns, 24px gaps (= B151-3 px x 39/51)", () => {
  assert.match(css, /grid-template-columns: 283px 262px minmax\(\d+px, 1fr\)/);
  assert.match(css, /grid-template-rows: 46px minmax\(0, 1fr\)/);
  assert.match(css, /\.spe-row \{[^}]*height: 39px/);
  assert.match(css, /column-gap: 24px/);
  assert.deepEqual(panel.SPE_BASE, { rowH: 39, w: 1260, h: 872, col1: 283, col2: 262 });
  assert.deepEqual(panel.SPE_NATIVE, { winW: 1999, winH: 1303, panelW: 1647, panelH: 1140, pitch: 51, col1: 370, col2: 343 });
});

check("B151.9 default panel size = native window fractions (0.8239 x 0.8749)", () => {
  const fit = panel.speDefaultPanelSize(1999, 1303);
  assert.deepEqual(fit, { w: 1647, h: 1140 });   // exact at the oracle's own window
  const hd = panel.speDefaultPanelSize(1920, 1080);
  assert.equal(hd.w, Math.round(1920 * 0.82391));
  assert.equal(hd.h, Math.round(1080 * 0.87490));
  // tiny viewports keep the framework panel's floor
  assert.deepEqual(panel.speDefaultPanelSize(640, 400), { w: 760, h: 420 });
});

check("B151.9 zoom reproduces the oracle's row pitch and column widths at the oracle window", () => {
  const z = panel.speZoomFor(1647, 1140);
  assert.ok(Math.abs(z - 1.3071) < 0.002, `zoom ${z}`);
  const pitch = 39 * z;
  assert.ok(Math.abs(pitch - 51) < 0.15, `pitch ${pitch}`);                  // native 51px
  assert.ok(Math.abs(pitch / 1303 - 0.03914) < 0.0002);                      // fraction of window height
  assert.ok(Math.abs(283 * z - 370) < 1, `col1 ${283 * z}`);                 // native 370px
  assert.ok(Math.abs(262 * z - 343) < 1.5, `col2 ${262 * z}`);               // native 343px
});

check("B151.9 the pitch fraction holds at 16:9 (typical viewport), height-driven", () => {
  const { w, h } = panel.speDefaultPanelSize(1920, 1080);
  const z = panel.speZoomFor(w, h);
  assert.ok(Math.abs(39 * z / 1080 - 51 / 1303) < 0.0002, `fraction ${39 * z / 1080}`);
});

check("B151.9 the shell consumes the numbers: default size fn + ResizeObserver-driven --spe-zoom", () => {
  assert.match(panelSource, /speDefaultPanelSize\(vw, vh\)/);
  assert.doesNotMatch(panelSource, /Math\.min\(1270, vw/);   // r1's fixed default is gone
  assert.match(panelSource, /--spe-zoom/);
  assert.match(panelSource, /new ResizeObserver\(applyZoom\)\.observe\(el\)/);
  assert.match(css, /\.spe-head, \.spe-body \{ zoom: var\(--spe-zoom, 1\); \}/);
});

check("B151.9 test-the-test: r1's fixed 1270x792 default fails the native pitch fraction", () => {
  // seeded-bad: no zoom (z=1) at a 1999x1303 window -> pitch fraction 39/1303 = 0.0299
  assert.throws(() => assert.ok(Math.abs(39 * 1 / 1303 - 0.03914) < 0.0002));
});

check("B151.1 the editor is a framework panel (movable/resizable, one close button, Esc)", () => {
  assert.match(panelSource, /key: "spEditor"[\s\S]{0,400}headSel: "\.spe-head"[\s\S]{0,400}resizable: \{ minW: \d+, minH: \d+ \}/);
  assert.match(panelSource, /escClosable: true/);
  assert.match(panelSource, /data-pf-close/);   // the framework binds the skin's X (no second X)
  assert.doesNotMatch(panelSource, /spe-backdrop/);   // no modal backdrop any more
});

// ---- B151.7 (r2): the display tri-state DERIVES from contents at every level ----
// Oracle B151-3: Food shows a DASH while its flag is on; the raw flag never paints a
// category. check = everything beneath enabled, X = none, dash = partial.

check("B151.7 the live case verbatim: Wood flag ON, its only sub-group Trees none -> Wood is X/red", () => {
  const state = panel.speCatDerivedState(true, [{ on: 0, total: 34 }]);
  assert.equal(state, "none");
  const html = panel.speCatRowHtml("Wood", "wood", 17, state, false);
  assert.match(html, /spe-cat off/);
  assert.match(html, /spe-state x/);
  assert.doesNotMatch(html, /spe-cat on/);
  assert.doesNotMatch(html, /spe-state check/);
});

check("B151.7 category derives from its groups: partial -> dash (B151-3 Food), all -> check", () => {
  assert.equal(panel.speCatDerivedState(true, [{ on: 5, total: 5 }, { on: 0, total: 9 }]), "some");
  assert.equal(panel.speCatDerivedState(true, [{ on: 5, total: 5 }, { on: 9, total: 9 }]), "all");
  const dash = panel.speCatRowHtml("Food", "food", 9, "some", true);
  assert.match(dash, /spe-cat some/);        // grey partial row art, like the oracle's Food row
  assert.match(dash, /spe-state dash/);
  assert.match(dash, / sel/);
  const full = panel.speCatRowHtml("Food", "food", 9, "all", false);
  assert.match(full, /spe-cat on/); assert.match(full, /spe-state check/);
});

check("B151.7 empty groups don't poison the sum; an empty-world category falls back to its flag", () => {
  // cheese_plant/powder_creature are 0-total in the live world: they must not force 'some'
  assert.equal(panel.speCatDerivedState(true, [{ on: 3, total: 3 }, { on: 0, total: 0 }]), "all");
  assert.equal(panel.speCatDerivedState(true, [{ on: 0, total: 0 }]), "all");
  assert.equal(panel.speCatDerivedState(false, [{ on: 0, total: 0 }]), "none");
});

check("B151.7 unknown inputs derive to null and paint a STATELESS pending row (no color, no icon)", () => {
  assert.equal(panel.speCatDerivedState(null, null), null);                        // flags not fetched
  assert.equal(panel.speCatDerivedState(true, null), null);                        // groups unknown
  assert.equal(panel.speCatDerivedState(true, [{ on: 1, total: 2 }, undefined]), null); // a group's bits unknown
  const html = panel.speCatRowHtml("Wood", "wood", 17, null, false);
  assert.match(html, /spe-cat pending/);
  assert.doesNotMatch(html, /spe-cat on|spe-cat off|spe-cat some/);
  assert.doesNotMatch(html, /spe-state/);
  const grp = panel.speGroupRowHtml("Meat", "meat", null, false, false);
  assert.match(grp, /spe-group pending/);
  assert.doesNotMatch(grp, /spe-group on/);
  assert.doesNotMatch(grp, /spe-state/);
});

check("B151.7 grey partial row art ships and is wired (B151-3 Food row: 78,71,78 grey)", () => {
  assert.ok(css.includes("--spa-row-grey:"));
  assert.match(css, /\.spe-row\.some \{ border-image-source: var\(--spa-row-grey\); \}/);
});

check("B151.7 the category icon click follows the DISPLAYED state (X on flag-on Wood must Allow)", () => {
  assert.match(panelSource, /const state = speCatDerivedState\(speFlagsCache \? speCatFlag\(speFlagsCache, key\) : null, speCatAggs\(key\)\);\s*\n\s*const enable = state == null \? !speCatFlag\(speFlagsCache, key\) : state === "none";/);
  const html = panel.speCatRowHtml("Wood", "wood", 17, "none", false);
  assert.match(html, /title="Allow Wood"/);
});

check("B151.7 test-the-test: flag-driven display (r1's model) is rejected by the Wood/Trees case", () => {
  const flagOn = true;
  const seededBadState = flagOn ? "all" : "none";  // paint straight from the flag
  const bad = panel.speCatRowHtml("Wood", "wood", 17, seededBadState, false);
  assert.throws(() => assert.match(bad, /spe-cat off/));
  assert.throws(() => assert.doesNotMatch(bad, /spe-state check/));
});

// ---- B151.8 (r2): the no-flash contract -- paint final or nothing-until-ready ----
// the live report: clicking a category lit the whole detail column green, then rows that
// should be red slowly re-reddened. Root cause: the old speGroupRowHtml rendered a
// null-aggregate group as the default GREEN row art while serial requests filled bits one at
// a time. Now one snapshot supplies every aggregate before any final state is painted.

check("B151.8 selection paints final state synchronously from available data", () => {
  const groups = [{ key: "trees", label: "Trees" }];
  const html = panel.speGroupsListHtml("wood", groups, { trees: { on: 0, total: 34 } }, "trees");
  assert.match(html, /spe-group off/);
  assert.doesNotMatch(html, /pending/);
  assert.doesNotMatch(html, /spe-group on/);
  // and the synchronous snapshot-cache paint sits BEFORE the selected item-list await
  assert.match(panelSource, /applyCached\(\);\s*\n\s*renderSpeAll\(\);[\s\S]{0,180}if \(spEditGroup != null/);
  // group lists are world-static and cached across selections/opens
  assert.match(panelSource, /if \(spGroupsByCat\[cat\]\) return spGroupsByCat\[cat\];/);
});

check("B151.8 rows with unknown bits paint stateless, never the old default green", () => {
  const html = panel.speGroupsListHtml("food", [{ key: "meat", label: "Meat" }], {}, null);
  assert.match(html, /spe-group pending/);
  assert.doesNotMatch(html, /spe-group on/);
  assert.doesNotMatch(html, /spe-state/);
});

check("B151.8 stylesheet: the default row is stateless; green/grey/red are opt-in classes", () => {
  assert.match(css, /\.spe-row \{[^}]*border-image-source: none/);
  assert.match(css, /\.spe-row\.on \{ border-image-source: var\(--spa-row-green\); \}/);
  const rowRule = css.match(/\.spe-row \{[^}]*\}/)[0];
  assert.ok(!rowRule.includes("--spa-row-green"), "default row must not carry the green art");
});

check("B151.8 open paints NO state until the flags arrive (null flags, not all-off)", () => {
  assert.match(panelSource, /let speFlagsCache = null;/);
  assert.match(panelSource, /speFlagsCache = null; speAggCache = \{\}; speItemsByGroup = \{\};/);
  // the atomic snapshot load still precedes the category pick
  assert.match(panelSource, /await speFetchSnapshot\(seq\)[\s\S]{0,400}loadSpGroups\(speDefaultCat\(\)\)/);
});

check("B151.8 group click pulls the remembered items synchronously (r1 painted the previous group's items)", () => {
  assert.match(panelSource, /spItemsCache = speItemsByGroup\[speAggKey\(spEditCat, spEditGroup\)\] \|\| \[\];\s*\n\s*renderSpeGroups\(\); renderSpeItems\(\);/);
});

check("B151.8 no row-by-row request pump remains", () => {
  assert.doesNotMatch(panelSource, /function spePumpAll|progressive FINAL paints/);
  assert.match(panelSource, /Commit the complete snapshot atomically/);
});

check("B151.8 test-the-test: r1's null->green group row markup is rejected by the pending contract", () => {
  // seeded-bad: exactly what the old builder emitted for a loading group
  const oldR1 = `<button class="spe-row spe-group on" data-spe-group="meat"><span class="spe-lab">Meat</span></button>`;
  assert.throws(() => assert.doesNotMatch(oldR1, /spe-group on/));
  assert.throws(() => assert.match(oldR1, /spe-group pending/));
});

// ---- B143: native stockpile window + Storage and tools window ----

check("B143 type grid: native column-major order and labels (B143-1.png)", () => {
  assert.deepEqual(panel.SPN_TYPES.map(([l]) => l), [
    "All", "Ammo", "Animals", "Armor", "Bars and Blocks", "Cloth", "Coins", "Corpses",
    "Finished Goods", "Food", "Furniture", "Gem", "Leather", "Refuse", "Sheets", "Stone",
    "Weapons", "Wood", "None", "Custom"]);
  const html = panel.spnTypeGridHtml({ food: true });
  assert.match(html, /data-sp-cat="food"[^>]*>[\s\S]*?spn-ticon on/);
  assert.match(html, /data-sp-cat="custom"/);
});

// WAVE-5: these three pinned `class="spn-type active" data-sp-cat="custom"` -- the class attribute
// and the data attribute ADJACENT, with `active` LAST in the class list. That is a fact about
// hand-built markup, not about the product: rowHtml necessarily emits `class="dwfui-row spn-type
// active"`, so the assertion could never be satisfied by a migrated control and was silently
// forbidding the 20-tile type grid from EVER adopting the component layer. (Sixth instance of this
// trap in Wave 5.) Re-expressed as the guarantee: WHICH tile is active. Structure-agnostic, and the
// negative case still bites.
const tileFor = (html, cat) => {
  const m = new RegExp(`<[^>]*data-sp-cat="${cat}"[^>]*>`).exec(html)
    || new RegExp(`<[^>]*class="[^"]*"[^>]*data-sp-cat="${cat}"[^>]*>`).exec(html);
  return m ? m[0] : null;
};
check("B143 custom highlight: mixed flags light the Custom tile, single preset lights its icon", () => {
  const mixed = panel.spnTypeGridHtml({ food: true, refuse: true, corpses: true });
  const mixedCustom = tileFor(mixed, "custom");
  assert.ok(mixedCustom, "the grid renders a Custom tile");
  assert.match(mixedCustom, /\bactive\b/, "mixed flags must light the Custom tile");

  const single = panel.spnTypeGridHtml({ wood: true });
  const singleWood = tileFor(single, "wood");
  assert.ok(singleWood, "the grid renders a Wood tile");
  assert.match(singleWood, /\bactive\b/, "a single preset must light its own tile");
  const singleCustom = tileFor(single, "custom");
  assert.ok(singleCustom, "the grid still renders a Custom tile");
  assert.doesNotMatch(singleCustom, /\bactive\b/, "a single preset must NOT light Custom");
});

check("B143 storage rows: native value + # / + / - tiles, attributes preserved for the wire", () => {
  const html = panel.spStorageRowsHtml({ barrels: 36, bins: 0, wheelbarrows: 5 });
  for (const [key, label] of panel.SP_STORAGE_FIELDS) {
    assert.match(html, new RegExp(`data-sp-storage="${key}"[^>]*value="`));
    assert.match(html, new RegExp(`data-spn-hash="${key}"`));
    assert.match(html, new RegExp(`data-sp-step="${key}" data-delta="1"`));
    assert.match(html, new RegExp(`data-sp-step="${key}" data-delta="-1"`));
    assert.ok(html.includes(label), `label ${label}`);
  }
  assert.match(html, /spn-storval">36</);
});

check("B143 Storage and tools is its own window with a Done plaque, opened by the barrel tile", () => {
  assert.match(panelSource, /spn-storagetitle">Storage and tools</);
  assert.match(panelSource, /data-spn-storage-open/);
  assert.match(panelSource, /data-spn-storage-done/);
  assert.match(panelSource, /key: "spStorage"/);
  assert.doesNotMatch(panelSource, /data-sp-storage-save/);   // still no batched Save
});

check("B143 tool tiles: paint/remove/links/link-add/barrel all wired, art in stylesheet", () => {
  for (const cls of ["spn-tool-paint", "spn-tool-remove", "spn-tool-linkadd", "spn-tool-barrel"])
    assert.ok(panelSource.includes(cls), cls);
  assert.match(panelSource, /spn-tool-linksfree-(on|off)/);
  for (const v of ["--spa-tool-paint", "--spa-tool-remove", "--spa-tool-linksfree-on",
    "--spa-tool-linksfree-off", "--spa-tool-linkadd", "--spa-tool-barrel", "--spa-plaque-done",
    "--spa-tile-hash", "--spa-tile-plus", "--spa-tile-minus", "--spa-tile-quill", "--spa-sptype-icons"])
    assert.ok(css.includes(v + ":"), v);
});

check("B143 caption + quill rename render like native", () => {
  assert.match(panelSource, /Click an icon to set stockpile type\./);
  assert.match(panelSource, /spn-quill/);
  assert.match(panelSource, /spn-titlebar/);
});

if (failed) process.exit(1);
console.log("b151_parity_test: PASS");
