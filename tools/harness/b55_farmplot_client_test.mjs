// b55_farmplot_client_test.mjs -- offline contract test for the B55 farm-plot panel.
// No DF/server required. It checks the four-season shape, old-DLL dormancy, Steam-style zero-seed
// rows, sprite-token resolution, and source-level route/predicate wiring. Run by explicit name only:
//   node tools/harness/b55_farmplot_client_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
// B169: the farm builders render through the DWFUI component layer and resolve escapeHtml as a
// global at call time -- mirror the browser load order (ui-components loads first).
globalThis.escapeHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.DWFUI = require(path.join(root, "web/js/dwf-ui-components.js"));
const panelPath = path.join(root, "web/js/dwf-building-zone-stockpile-panels.js");
const panel = require(panelPath);
const panelSource = fs.readFileSync(panelPath, "utf8");
const panelCss = fs.readFileSync(path.join(root, "web/css/dwf.css"), "utf8");
const committedPlantMap = JSON.parse(fs.readFileSync(path.join(root, "web/plant_map.json"), "utf8"));
// B212: the farm-plot routes live in register_building_zone_routes now.
const server = fs.readFileSync(path.join(root, "src/building_zone.cpp"), "utf8");
const farm = fs.readFileSync(path.join(root, "src/building_zone.cpp"), "utf8");

let passed = 0, failed = 0;
function check(name, condition, extra = "") {
  if (condition) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? `  ${extra}` : ""}`); }
}
function guard(name, condition) { check(`(test-the-test) ${name}`, condition); }

check("exports farmPlotPanelState", typeof panel.farmPlotPanelState === "function");
const stateOf = panel.farmPlotPanelState;

const fixture = {
  id: 71, isFarmPlot: true, currentSeason: 0, underground: true, biome: "SUBTERRANEAN_WATER",
  fertilize: { seasonal: true, current: 0, max: 4 },
  seedStocks: [
    { id: 501, token: "MUSHROOM_HELMET_PLUMP", name: "plump helmet spawn", count: 4, forbidden: false, dump: false, hidden: false },
    { id: 502, token: "GRASS_WHEAT_CAVE", name: "cave wheat seed", count: 2, forbidden: true, dump: false, hidden: false },
  ],
  seasons: [
    { season: 0, name: "Spring", plantId: 10, plantName: "Plump helmet", plantToken: "MUSHROOM_HELMET_PLUMP", crops: [{ id: 10, token: "MUSHROOM_HELMET_PLUMP", name: "Plump helmet", seedCount: 4 }] },
    { season: 1, name: "Summer", plantId: -1, plantName: "Fallow", crops: [{ id: 11, token: "GRASS_WHEAT_CAVE", name: "Cave wheat", seedCount: 2 }] },
    { season: 2, name: "Autumn", plantId: -1, plantName: "Fallow", crops: [{ id: 12, token: "POD_SWEET", name: "Sweet pod", seedCount: 7 }] },
    // The server's per-season list deliberately contains no autumn-only crop here: this is the
    // client-side counterpart of the winter-invalid server predicate below.
    { season: 3, name: "Winter", plantId: -1, plantName: "Fallow", crops: [{ id: 10, token: "MUSHROOM_HELMET_PLUMP", name: "Plump helmet", seedCount: 4 }, { id: 99, token: "MUSHROOM_CUP_DIMPLE", name: "Dimple cup", seedCount: 0 }] },
  ],
};

console.log("\n# panel state");
check("old DLL/no farm signal is dormant", stateOf({ id: 71 }) === null);
const state = stateOf(fixture, 3);
check("returns exactly four named seasonal tabs", state && state.seasons.length === 4 && state.seasons.map(s => s.name).join(",") === "Spring,Summer,Autumn,Winter");
check("selected tab remains Winter", state && state.activeSeason === 3);
check("season assignments preserve fallow as -1", state && state.seasons[1].plantId === -1 && state.seasons[3].plantId === -1);
check("winter list remains season-specific (autumn crop not copied in)", state && !state.seasons[3].crops.some(c => c.id === 12));
check("zero-seed crop remains visible like Steam's No seeds rows", state && state.seasons[3].crops.some(c => c.id === 99 && c.seedCount === 0));
check("positive seed count is retained for picker copy", state && state.seasons[3].crops.find(c => c.id === 10)?.seedCount === 4);
check("plant raw token survives normalization", state && state.seasons[0].crops[0].token === "MUSHROOM_HELMET_PLUMP" && state.seasons[0].plantToken === "MUSHROOM_HELMET_PLUMP");
check("current season/fertilize state survives normalization", state && state.currentSeason === 0 && state.fertilize.seasonal && state.fertilize.max === 4);
check("owned seed stack flags survive normalization", state && state.seedStocks.some(seed => seed.id === 501 && seed.token === "MUSHROOM_HELMET_PLUMP" && !seed.hidden));
check("seed inventory filters to the active crop token", panel.farmSeedStocksForCrop(state.seedStocks, state.seasons[0].plantToken).length === 1 && panel.farmSeedStocksForCrop(state.seedStocks, "").length === 0);
const stale = stateOf({ ...fixture, seasons: fixture.seasons.map((s, i) => i === 0 ? { ...s, plantId: 99, plantName: "No seeds", crops: [] } : s) });
check("already-scheduled unavailable crop is still represented as state", stale && stale.seasons[0].plantId === 99 && stale.seasons[0].plantName === "No seeds");

console.log("\n# sprite cells");
const spriteMaps = {
  plantMap: committedPlantMap,
  spriteMap: { FURROWED_SOIL_1: { sheet: "soil.png", col: 1, row: 2 } },
};
check("crop row resolves committed picked plant cell", panel.farmSpriteCell("MUSHROOM_HELMET_PLUMP", "crop", spriteMaps)?.sheet === committedPlantMap.MUSHROOM_HELMET_PLUMP.PICKED.sheet);
check("seed row resolves committed seed cell", panel.farmSpriteCell("MUSHROOM_HELMET_PLUMP", "seed", spriteMaps)?.sheet === committedPlantMap.MUSHROOM_HELMET_PLUMP.SEED.sheet);
check("fallow row reuses furrowed-soil cell", panel.farmSpriteCell("", "fallow", spriteMaps)?.sheet === "soil.png");
check("unknown sprite token falls back cleanly", panel.farmSpriteCell("MISSING", "crop", spriteMaps) === null);

console.log("\n# Steam-shaped surface");
check("crop picker is a row list rather than the old select", /class="farm-crop-list"/.test(panelSource) && !/<select class="livestock-trainer" data-farm-crop/.test(panelSource));
check("crop row list has its own vertical scrollbar", /\.farm-crop-list\s*\{[\s\S]*?overflow-y:\s*auto;/.test(panelCss));
// B169 migration note: tab markup now renders through DWFUI.tabsHtml (the shared chevron
// component), so the class assertion moved from source-regex to the RENDERED contract -- same
// contract, stronger check. The "(now)" marker stays a source literal in farmSeasonTabsHtml.
// WAVE 4: the season row is the native `TAB` grammar (matrix §3 F3: "Farm plot | row 1 = TAB").
// It used to pass NO level, so it rendered a CSS trapezoid in browser font. Every tab now carries the
// shared base class AND the level AND a DF bitmap label -- the old `class="farm-season-tab active"`
// (base class stripped, browser text) must be impossible.
check("season tabs mark the current season, in the native TAB grammar", (() => {
  const tabs = panel.farmSeasonTabsHtml(stateOf(fixture, 3));
  return /class="dwfui-tab dwfui-tab--primary farm-season-tab active"[^>]*data-farm-season="3"/.test(tabs) &&
    /^<div class="dwfui-tabs dwfui-tabs--primary farm-season-tabs dwfui-tabs--fill"/.test(tabs) &&
    /data-farm-season="0"[^>]*>.*data-dwfui-bitmap-text="Spring".*<span>\(now\)<\/span>/.test(tabs) &&
    !/class="farm-season-tab active"/.test(tabs) &&      // seeded-bad: the old base-class-less markup
    /\? "<span>\(now\)<\/span>"/.test(panelSource);
})());
check("leave-fallow row requests a furrowed-soil sprite", /farmCellMarkup\("", "fallow"\)/.test(panelSource) && /FURROWED_SOIL_1/.test(panelSource));
check("farm plot art survives a late or unavailable runtime sprite map", /floor_furrowed_soil\.png/.test(panelSource));

console.log("\n# route and native-predicate shape");
check("GET farm state route is registered", /server\.Get\("\/farm-plot",/.test(server));
check("POST set-season-crop route is registered", /server\.Post\("\/farm-plot-action",/.test(server));
check("action requires id, season, and plant", /query_int\(req, "id", id\).*query_int\(req, "season", season\).*query_int\(req, "plant", plant\)/s.test(server));
check("fallow is the sole negative action value", /if \(plant_id == -1\) \{\s*farm->plant_id\[season\] = -1;/s.test(farm));
check("winter-invalid crop is rejected by the season-flag predicate", /plant->flags\.is_set\(kFarmSeasonFlags\[season\]\)/.test(farm));
check("biome/underground predicate is applied", /farm_crop_matches_plot\(plant, subterranean, biome\)/.test(farm));
check("zero-seed crop can still be scheduled like native", !/crop has no available seeds/.test(farm));
check("response adds crop tokens, fertilize state, and seed stacks", /\\"token\\":/.test(farm) && /\\"fertilize\\":/.test(farm) && /\\"seedStocks\\":/.test(farm));
check("seasonal fertilize action route is registered", /server\.Post\("\/farm-plot-fertilize-action",/.test(server));
check("seed-stack controls reuse the stock item action route", /\/stock-item-action\?/.test(panelSource) && /postFarmSeedAction\(itemId, action\)/.test(panelSource));
check("view seed-stack action opens the existing item sheet", /action === "view"[\s\S]*showStockItemSheet\(result\)/.test(panelSource));
check("removed seed-gating helper has no orphaned definition", !/bool farm_crop_is_plantable\(/.test(farm));

console.log("\n# B55-r2 parity (oracle B55-2.png ours vs B55-3.png native) + B169 component pilot");
check("r2: crop display names are sentence-cased like native ('Strawberry plants')",
  panel.farmCropDisplayName("strawberry plants") === "Strawberry plants" &&
  panel.farmCropDisplayName("bitter melon vine") === "Bitter melon vine" &&
  panel.farmCropDisplayName("Alfalfa") === "Alfalfa");
const r2State = stateOf({ ...fixture, seasons: fixture.seasons.map((s, i) => i === 0
  ? { ...s, crops: [{ id: 10, token: "MUSHROOM_HELMET_PLUMP", name: "plump helmet", seedCount: 4 }] } : s) }, 0);
const r2Active = r2State.seasons[0];
const r2CropRow = panel.farmCropRowHtml(r2Active.crops[0], r2Active);
check("r2: crop row renders the sentence-cased name (wire name stays raw)",
  /class="farm-crop-name">[\s\S]*data-dwfui-bitmap-text="Plump helmet"/.test(r2CropRow) &&
  r2Active.crops[0].name === "plump helmet");
check("r2: seed stack names stay lowercase like native ('strawberry seeds')",
  /class="farm-seed-name"/.test(panel.farmSeedRowHtml(fixture.seedStocks[0])) &&
  panel.farmSeedRowHtml(fixture.seedStocks[0]).includes("plump helmet spawn"));
const seedRow = panel.farmSeedRowHtml({ id: 502, token: "GRASS_WHEAT_CAVE", name: "cave wheat seed", count: 2, forbidden: true, dump: false, hidden: false });
// WAVE 5 RETARGET (same INTENT, stricter). This cell used to pin the EMOJI code points themselves
// (&#128269; magnifier, &#128274; padlock, &#128465; bin, &#128065; eye) -- i.e. it pinned the
// defect. TOKENS.glyphs declares itself DEPRECATED ("EVERY entry below now HAS a real DF sprite in
// TOKENS.sprites"), and the spec forbids an emoji where a sprite exists. The row now renders DF's
// own STOCKS_* tiles, so the assertion is re-aimed at the SPRITE TOKENS and given a NEGATIVE GUARD
// that makes the emoji form impossible. Same four actions, same /stock-item-action route.
check("r2: seed rows use the stock item sheet's action vocabulary, as NATIVE SPRITES (same route)",
  /data-farm-seed-action="view"/.test(seedRow) && /data-dwfui-sprite="STOCKS_VIEW_ITEM"/.test(seedRow) &&
  /data-dwfui-sprite="STOCKS_FORBID_ACTIVE"/.test(seedRow) &&   // this fixture's stack IS forbidden
  /data-dwfui-sprite="STOCKS_DUMP"/.test(seedRow) && /data-dwfui-sprite="STOCKS_HIDE"/.test(seedRow) &&
  /data-dwfui-sprite="STOCKS_RECENTER"/.test(seedRow) &&        // the `follow` superset, dressed native
  !/&#128269;|&#128274;|&#128465;|&#128065;/.test(seedRow) &&  // the emoji are GONE and cannot return
  !/[⌂⌕▣♜◉]/.test(seedRow));
check("r2: forbidden seed stack renders the active state; eye is gap-separated like native",
  /class="active"[^>]*data-farm-seed-action="forbid"/.test(seedRow) &&
  /class="dwfui-gap"[^>]*data-farm-seed-action="hide"/.test(seedRow));
check("r2: seed action buttons carry the native gold-border cluster styling",
  /\.dwfui-actions button[^}]*border: 2px solid #d89b27/s.test(panelCss) &&
  /farm-seed-actions dwfui-actions/.test(panelSource));
// RETARGETED AGAIN (Wave 4 interface-scale close-out; the binding decision #3). The INTENT of this
// cell is unchanged and is the whole reason it exists: **the tab scale comes from DF's own cell, not
// from a hand-tuned CSS number.** What changed is which cell, and what "scale" means:
//
//   * THE TOKEN WAS WRONG. `primary` painted the TALL `TAB` (40x36) at 1:1 -- 36px. MEASURED on the
//     lossless oracle, native's tab band is `SHORT_TAB` (40x24). See INTERFACE-SCALE-CLOSEOUT.md.
//   * THE SCALE WAS WRONG. DF draws its interface -- art AND text, one grid -- at a NON-INTEGER,
//     window-dependent scale (~1.245 on the oracle). We drew at 1.0.
//
// So the height is now the NATIVE 24px cell TIMES the ONE interface-scale token: 30px at 1.25, which
// is the oracle's measured tab height. 36px was the wrong token's height, and a hardcoded 30px would
// merely re-hardcode the oracle's window. Both are rejected below.
check("r2: tab scale comes from DF's own SHORT_TAB cell (24px x the interface scale), not a CSS number",
  /\.dwfui-tab--primary \{[^}]*height:calc\(24px \* var\(--dwfui-interface-scale\)\)/s.test(panelCss) &&
  !/\.dwfui-tab--primary \{[^}]*height:36px/s.test(panelCss) &&
  !/\.dwfui-tab--primary \{[^}]*height:30px/s.test(panelCss) &&
  /\.farm-season-tab:not\(\.dwfui-tab\) \{/.test(panelCss) &&
  !/^\.farm-season-tab \{/m.test(panelCss));
check("r2: native row scale (50px rows, 16px type)",
  /\.farm-crop-row \{[^}]*min-height: 50px;[^}]*font: 400 16px/s.test(panelCss));
check("r2: No-seeds styling matches native weight/size",
  /\.farm-no-seeds \{ color: #ff8a00; font-size: 13px; font-weight: 700; \}/.test(panelCss));
check("B169: farm header renders through the shared component with the one-close contract",
  (() => { const head = panel.farmHeaderHtml();
    return /^<div class="farm-native-head">/.test(head) &&
      /<div class="farm-head-title"><span class="dwfui-bitmap-text[^>]*data-dwfui-bitmap-text="Farm Plot"/.test(head) &&
      /class="dwfui-art-btn bld-x"[^>]*data-dwfui-native-art="true"[^>]*data-bld-close/.test(head) &&
      /data-dwfui-sprite="BUILDING_JOBS_REMOVE"/.test(head); })());
check("B169: crop list keeps the fallow row's furrowed-soil cell and radiogroup wrapper",
  (() => { const list = panel.farmCropListHtml(r2State);
    return /class="farm-crop-list" role="radiogroup"/.test(list) &&
      /data-farm-crop="-1"/.test(list) && /Leave fallow/.test(list); })());

console.log("\n# TEST-THE-TEST");
const mutantLowercaseName = name => name;   // a display path that skips sentence-casing
guard("r2: a non-capitalizing display name is distinguishable",
  mutantLowercaseName("plump helmet") !== panel.farmCropDisplayName("plump helmet"));
const mutantOldGlyphRow = `<button data-farm-seed-action="view" title="View seed stack">⌕</button>`;
guard("r2: the old monochrome glyph cluster is rejected by the vocabulary cell", /[⌕]/.test(mutantOldGlyphRow) && !/[⌕]/.test(seedRow));
const mutantDropsNoSeeds = data => data.seasons[3].crops.filter(crop => crop.seedCount > 0);
guard("a picker that drops the zero-seed row differs from the panel state", mutantDropsNoSeeds(fixture).length !== state.seasons[3].crops.length);
const mutantWinterAcceptsAutumn = season => season === 3 || season === 2;
guard("a mutant predicate that permits autumn crop in winter is distinguishable", mutantWinterAcceptsAutumn(3) !== (state.seasons[3].crops.some(c => c.id === 12)));
const mutantCropUsesSeed = maps => maps.plantMap.MUSHROOM_HELMET_PLUMP.SEED;
guard("a crop-row resolver that uses the seed cell is distinguishable", mutantCropUsesSeed(spriteMaps).col !== panel.farmSpriteCell("MUSHROOM_HELMET_PLUMP", "crop", spriteMaps).col);
const mutantKeepsEverySeedStack = rows => rows;
guard("an unfiltered seed inventory differs from the selected crop inventory", mutantKeepsEverySeedStack(state.seedStocks).length !== panel.farmSeedStocksForCrop(state.seedStocks, state.seasons[0].plantToken).length);

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
