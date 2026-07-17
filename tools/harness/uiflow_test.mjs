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
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// uiflow_test.mjs -- static client contracts for UIFLOW's browser-only behavior.
//
//   node tools/harness/uiflow_test.mjs
// Exit: 0 PASS, 1 FAIL. These validate request shapes and route wiring without a live DF.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.resolve(here, "../../web/js", name), "utf8");
const stockpiles = read("dwf-building-zone-stockpile-panels.js");
const controls = read("dwf-controls-placement.js");
const core = read("dwf-core.js");
const squads = read("dwf-squads.js");
const labor = read("dwf-labor-work-orders.js");
const hud = read("dwf-unit-hud-notifications.js");
const css = fs.readFileSync(path.resolve(here, "../../web/css/dwf.css"), "utf8");
let passed = 0, failed = 0;
function check(value, name) {
  if (value) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

console.log("# B57 stockpile per-column All/None");
// WAVE-5: this asserted `data-spe-column-all="categories"` as a SOURCE LITERAL. A DWFUI builder
// emits its datasets at runtime from a config object, so no migrated control can ever satisfy it --
// the assertion was silently forbidding the six B151 All/None plaques from adopting plaqueBtnHtml,
// even though the RENDERED markup would be identical. Accept either spelling: the literal attribute
// (hand-built) or the dataset key passed to a builder (migrated). What B57 actually guards -- that
// each of the three columns HAS an All/None control -- is unchanged.
for (const column of ["categories", "groups", "items"])
  check(new RegExp(`data-spe-column-all=\\\\?["']${column}["']|["']spe-column-all["']\\s*:\\s*["']${column}["']|speColumnAll\\s*:\\s*["']${column}["']`).test(stockpiles),
    `${column} column has All/None controls`);
// B231: same WAVE-5 lesson as the loop above, one line later. This pinned the literal
// `stockpile-toggle-all` INSIDE spToggleAllUrl. The settings editor is now target-addressed -- it
// drives a df::building_stockpilest OR a df::hauling_stop, whose `settings` is the same
// df::stockpile_settings struct (df.hauling.xml:42) -- so the endpoint prefix is chosen by
// speUrl() and the literal necessarily moved out of this function. The REQUEST SHAPE that B57
// actually guards (cat + group on the toggle-all call) is unchanged and still asserted; accept the
// builder spelling alongside the hand-built one.
check(/function spToggleAllUrl[\s\S]*?(stockpile-toggle-all|speUrl\("toggle-all")[\s\S]*?cat=\$\{encodeURIComponent\(cat\)\}[\s\S]*?group=\$\{encodeURIComponent\(group \|\| ""\)\}/.test(stockpiles),
  "column action keeps the existing cat+group toggle-all request shape");
// ...and the toggle-all endpoint still exists for BOTH subjects (the prefix is the only difference).
check(/const prefix = speIsStop\(\) \? "\/hauling-stop-" : "\/stockpile-";/.test(stockpiles),
  "the settings editor resolves its endpoint family from the target, not a hardcoded prefix");
check(/Promise\.all\(groups\.map\(group => postStockpile\(spToggleAllUrl/.test(stockpiles),
  "column action batches independent group requests rather than item requests");

console.log("# B62 squad kill click-to-target");
check(!/id="squadKillTarget"/.test(squads) && /Select targets on the map, then Confirm\./.test(squads),
  "unit-id input is removed and the select/confirm state is visible");
check(/window\.DFSquadKill\.arm\(squad\.id\)/.test(squads) && /action: "kill", targets:/.test(squads),
  "kill arms map selection then posts the kill route only on confirm");
check(/async function squadKillClick[\s\S]*?\/inspect\?[\s\S]*?data\.unit\.id/.test(controls),
  "map target plumbing resolves the clicked unit through the existing inspect route");

console.log("# B70 squad kill multi-target");
check(/squadKillArmedFor\s*=\s*\{\s*id:\s*-1,\s*targets:\s*\[\]\s*\}/.test(squads),
  "kill selection state holds a target SET, not a single id");
check(/targets\.join\(","\)/.test(squads) && /squadKillArmedFor\.targets\.map\(t => t\.id\)/.test(squads),
  "confirm sends every marked target as a CSV of unit ids");
check(/data-kill-unmark/.test(squads) && /squadKillArmedFor\.targets\.splice/.test(squads),
  "marked targets render as chips and a click unmarks a single target");
// squadKillClick must NOT disarm on a pick (multi-select stays armed until confirm/cancel).
check(/async function squadKillClick\(event\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*const pixel = imagePixelFromEvent/.test(controls),
  "map click stays armed after selecting a target (no immediate disarm)");
// TEST-THE-TEST: the old single-disarm shape would be caught by the assertion above.
check(!/async function squadKillClick\(event\)\s*\{\s*squadKillArmed = -1;/.test(controls),
  "(test-the-test) the pre-B70 immediate-disarm shape is gone");

console.log("# B63 unified settings entry points");
check(/if \(settingsMenu\) settingsMenu\.remove\(\)/.test(controls), "legacy cog popover is removed");
check(/settingsBtn\.addEventListener\("click"[\s\S]*?DFSettings\.open\(\)/.test(controls), "gear opens the full Settings panel");
check(/topbarHelpBtn\.addEventListener\("click"[\s\S]*?DFSettings\.open\("keybinds"\)/.test(controls),
  "help button opens the customizable keybinds section");

console.log("# B58 native stairs z-range");
check(/const digTools = new Set\(\["dig", "stairs"/.test(controls) && /function collapseStairTools\(\)/.test(controls),
  "three cached stair tools collapse to one stairs tool");
check(/designationTool === "stairs" \? "stairs" : backendToolFor/.test(controls) &&
  /async function submitDesignationRange[\s\S]*?tool=\$\{encodeURIComponent\(rangeTool\)\}[\s\S]*?zlevels=\$\{values\[4\] - values\[5\]\}/.test(controls),
  "shared range submitter resolves stairs and emits its signed zlevels payload");
check(/px=\$\{px1\}&py=\$\{py1\}[\s\S]*?px2=\$\{px2\}&py2=\$\{py2\}/.test(controls),
  "stair range preserves both corners of the selected area across all z levels");

console.log("# B193 two-click rectangle designations (supersedes B186 held-drag, 07-11)");
// Edited 2026-07-11 (B193): three cells here pinned the B186 held-drag contract (shifted-drag
// commit, first-release commit, stairs/erase-only two-release fallback). The owner verified native DF:
// designations are two-click, click-drag is not a native gesture -- so those cells now pin the
// two-click routing instead. The wheel delegation and stairs' same-z hold survive unchanged.
check(/DFDesignationRangeWheel/.test(core) && /window\.DFDesignationRangeWheel = designationRangeWheel/.test(controls),
  "core delegates Shift+wheel to the placement module's range hook");
check(/rangeDesignationTools\.has\(selectedDesignation\) && paintMode === "rect"\) \{\s*designateTwoClickRange\(downX, downY, event\.clientX, event\.clientY\);/.test(controls),
  "every rect-mode rectangle designation commits through the two-click handler");
check(!/completedRange/.test(controls) && !/beginDesignationDragRange/.test(controls),
  "the held-drag commit machinery is fully removed (click-drag is not a native gesture)");
check(/const isStairs = selectedDesignation === "stairs";\s*if \(start\.z === pointZ && isStairs\)/.test(controls),
  "same-z second click commits for every tool; only stairs holds (needs >=2 levels)");
check(/function twoClickEligible\(\)/.test(controls) &&
  /rangeDesignationTools\.has\(selectedDesignation\)/.test(controls.match(/  function twoClickEligible\(\) \{[\s\S]*?\n  \}/)?.[0] || ""),
  "two-click eligibility is tool-agnostic across the whole rectangle-designation matrix");
// TEST-THE-TEST: the removed numeric-z implementation must not return.
check(!/digZLevels|buildZLevelsControl|dwfGetZLevels|dig-zlevels/.test(controls),
  "(test-the-test) the numeric z-stepper state, builder, export, and markup are absent");
check(/"dig", "stairs", "ramp", "channel", "remove", "erase"[\s\S]*?"chop", "gather"[\s\S]*?"claim", "forbid"/.test(controls),
  "the audited range matrix includes mining, erase, smooth/carve, plant, and item rectangles");

console.log("# B66 custom-labor scroll preservation");
check(/const prevMainScroll = clientPanel\.querySelector\("\.info-main"\)\?\.scrollTop \|\| 0;/.test(labor),
  "labor panel captures .info-main scroll offset before the re-render");
check(/if \(prevMainScroll\)[\s\S]*?restoredMain\.scrollTop = prevMainScroll/.test(labor),
  "labor panel restores the captured scroll offset after the re-render");
// test-the-test: the capture must precede the restore in source order (the restore consumes the
// captured value); a swapped order would read the fresh (0) DOM and defeat the fix.
check(labor.indexOf("const prevMainScroll") < labor.indexOf("restoredMain.scrollTop = prevMainScroll"),
  "(test-the-test) scroll is captured before it is restored");

console.log("# B68->B151 stockpile All/None (native plaques; the glow shim is retired)");
// B151 exact-parity mandate (oracle B151-1.png): native's All/None are static green/red
// plaques with no aggregate glow; per-entry state moved onto the rows themselves
// (red+X / green+check / grey dash -- covered by tools/harness/b151_parity_test.mjs).
check(!/updateSpColumnGlow/.test(stockpiles),
  "the B68 glow shim is fully retired (superseded by B151 row-state art)");
check(/spe-plaque-all/.test(stockpiles) && /spe-plaque-none/.test(stockpiles),
  "every column renders the native All/None plaque buttons");
check(/--spa-plaque-all:/.test(css) && /--spa-plaque-none:/.test(css),
  "the native plaque art ships in the stylesheet");
check(/\.spe-plaque-all \{[^}]*var\(--spa-plaque-all\)/.test(css) && /\.spe-plaque-none \{[^}]*var\(--spa-plaque-none\)/.test(css),
  "plaque buttons draw the extracted native art");

console.log("# B152 pasture assignment panel continuity");
check(/const scrollTop = animalList\?\.scrollTop \|\| 0;[\s\S]*?await openZoneUnitsPanel\(data\.id, \{ scrollTop, keepUnit: unit \}\)/.test(stockpiles),
  "pasture mutation restores its inner scroll and anchors the clicked unit");
check(/requestAnimationFrame\([\s\S]*?restore\.keepUnit[\s\S]*?kept\.offsetTop[\s\S]*?animalList\.scrollTop/.test(stockpiles),
  "clicked pasture row is kept inside the restored viewport");
check(/#selection\.building-panel\.zone-animal-panel\s*\{[\s\S]*?display: flex[\s\S]*?overflow: hidden/.test(css) &&
      /\.building-panel\.zone-animal-panel \.zone-animal-list\s*\{[\s\S]*?flex: 1 1 auto[\s\S]*?min-height: 0[\s\S]*?max-height: none/.test(css),
  "pasture list grows with the resizable framework box instead of retaining a fixed cap");
check(/data-zone-animal-sort/.test(stockpiles) && /data-zone-animal-search/.test(stockpiles) && /data-zone-unit-locate/.test(stockpiles),
  "pasture panel wires native sort, magnified search, and per-row locate controls");

console.log("# B101 farm-plot panel sizing");
check(/"visible building-panel" \+ \(farmPlotInfo \? " farm-panel" : ""\)/.test(stockpiles),
  "a built farm plot adds the farm-panel modifier class");
// B131 replaced the B101-era .livestock-trainer <select> with the Steam-shaped .farm-crop-list
// row picker; the sizing contract is now panel rule + crop-list rule.
check(/#selection\.building-panel\.farm-panel\b/.test(css) && /\.farm-crop-list\s*\{/.test(css),
  "CSS scales up the farm-plot panel width and crop picker");

console.log("# B86 weather HUD indicator");
check(/weatherLabel = document\.createElement\("div"\)[\s\S]*?weatherLabel\.className = "weather-label"/.test(hud),
  "a weather label element is created next to the moon icon");
check(/weatherLabel\.textContent = weatherName/.test(hud) && /weatherName === "Rain" \|\| weatherName === "Snow"/.test(hud),
  "weather label reflects hud.weather and lights up for precipitation");
check(/\.weather-label\b/.test(css) && /\.weather-label\.weather-active\b/.test(css),
  "CSS styles the weather label (dimmed base + lit active state)");

console.log("# B148 one closest-material affordance (build menu)");
const buildInfo = read("dwf-build-info-panels.js");
check(!/<option value="closest"/.test(buildInfo),
  "the per-requirement select no longer offers a 'Closest to placement' option (it duplicated the WD-15 toggle)");
// WAVE-5: this used to pin `data-build-matmode="closest">Use closest material` -- the attribute and
// its label ADJACENT in the raw source. That is a fact about hand-built markup, and plaqueBtnHtml
// (which emits the label through the bitmap layer, inside a copy span) can never reproduce it. The
// assertion was therefore forbidding the toggle from adopting the component layer at all. The thing
// it actually guards is B148: that there is EXACTLY ONE closest-material affordance and it is the
// native placement toggle. Assert that, not the byte order.
const buildMatmodeClosest = /(?:data-build-matmode|["']build-matmode["'])\s*[:=]\s*["']closest["']/g;
check(buildMatmodeClosest.test(buildInfo),
  "the native-DF placement toggle remains the ONE closest-material affordance (hook present)");
check(/Use closest material/.test(buildInfo),
  "...and it still carries its label");
// Count the HOOK, not the label: the label also appears in four explanatory comments, and a
// source-text count would police prose rather than the product.
buildMatmodeClosest.lastIndex = 0;
check((buildInfo.match(buildMatmodeClosest) || []).length === 1,
  "...and there is EXACTLY ONE closest-material affordance -- a second one is the B148 defect");
check(/if \((?:buildMaterialMode|materialMode) === "closest"\) \{\s*\n\s*return `<div class="build-req-row">/.test(buildInfo),
  "while the bulk toggle is active the Needs rows render as resolved text, not dead live selects");
// B244 widened the pick grammar to itemType:matType:matIndex (the item CLASS -- rock/blocks/wood/
// bars -- is now part of the pick; the legacy 2-part matType:matIndex form still parses). The B148
// guarantee this check exists to defend is unchanged: in select mode ONLY concrete picks are sent,
// and a lingering "closest" value is dropped rather than forwarded.
check(/if \(MAT_PICK_RE\.test\(val\)\) params\.set/.test(buildInfo) &&
  /MAT_PICK_RE = \/\^-\?\\d\+:-\?\\d\+\(:-\?\\d\+\)\?\$\//.test(buildInfo) &&
  !/val === "closest" \|\|/.test(buildInfo),
  "appendBuildOptions accepts only concrete itemType:matType:matIndex picks in select mode");

// ---- wave BUILD-UX (B144 / B121 / B147) -----------------------------------------------------
const menuTree = read("dwf-menu-tree.js");

console.log("# B144 alphabetical make-X lists (wiring)");
check(/orderRowsAlpha, sortTasksAlpha/.test(menuTree),
  "menu-tree module exports the two pure sort helpers");
check(/MTF && MTF\.sortTasksAlpha\) list = MTF\.sortTasksAlpha\(list\)/.test(stockpiles),
  "flat task picker (tasks + shop work orders) renders through sortTasksAlpha");
// B174 (oracle B174-2): native shows ONE flat alphabetical list, no group headers -- the flat
// picker now re-sorts A->Z across groups after sortTasksAlpha.
// D3/D4 (2026-07-14 parity review): still ONE A->Z list -- but DF puts CONTAINER rows ("(opens menu)")
// above the leaves, so the comparator now sorts submenu-first, then alphabetically. Both halves are
// asserted: a plain A->Z sort would bury the carpenter's `Make instrument` row among the M's.
check(/\(a\.submenu \? 0 : 1\) - \(b\.submenu \? 0 : 1\)/.test(stockpiles),
  "flat picker puts container rows first (the universal ordering law from the 30 captures)");
check(/\|\| String\(a\.name \|\| a\.job \|\| ""\)\s*\n?\s*\.localeCompare\(String\(b\.name \|\| b\.job \|\| ""\)/.test(stockpiles),
  "flat picker flattens to one A->Z list across groups (B174-2 native shape)");
check(!/workshop-task-group/.test(stockpiles),
  "picker group headers are retired (native shows none)");
check(/const orderRows = rows => \(MT\.orderRowsAlpha \? MT\.orderRowsAlpha\(rows\)/.test(stockpiles),
  "tree picker renders through orderRowsAlpha (with a stale-module fallback)");
check(/orderRows\(nav\.rows\)\.map\(\(\{ node, idx \}\) =>/.test(stockpiles) &&
  /dataset: \{ wsTreeCat: idx, wsSearch: hay \}/.test(stockpiles),
  "root rows keep their ORIGINAL index on drill attributes after reordering");
check(/orderRows\(nav\.rows\)\.map\(\(\{ node: leaf \}\) =>/.test(stockpiles),
  "leaf level renders the alphabetized rows");
check(/Array\.isArray\(info\.orderTasks\)[\s\S]*?info\.orderTasks\.filter\(t => t\.orderKey\)[\s\S]*?: tasks\.filter\(t => t\.orderKey\)/.test(stockpiles),
  "shop work-order picker prefers fully-expanded server orderTasks with stale-DLL fallback");

const lua = fs.readFileSync(path.resolve(here, "../../dwf.lua"), "utf8");
const buildingZoneCpp = fs.readFileSync(path.resolve(here, "../../src/building_zone.cpp"), "utf8");

console.log("# B121 make-priority route shape");
check(/elseif action == 'priority' then[\s\S]*?job\.flags\.do_now = not job\.flags\.do_now/.test(lua),
  "lua workshop_job_action grows an additive 'priority' TOGGLE (legacy 'now' untouched)");
check(/elseif action == 'now' then\s*\n\s*job\.flags\.do_now = true/.test(lua),
  "(regression) legacy set-only 'now' action is still served for deployed clients");
// B174 rebuilt the task row through DWFUI.actionButtonsHtml; the B121 wire rule moved into the
// builder's dataset (same emitted attribute, pinned end-to-end by b174_wsrebuild_client_test).
check(/wsJobAction: job\.doNow \? "priority" : "now"/.test(stockpiles),
  "workshop '!' control toggles: sends priority when set (new DLL), now when unset (any DLL)");
check(/action == "priority"[\s\S]*?do_now = !current/.test(buildingZoneCpp),
  "building-action grows an additive 'priority' toggle for pending constructions");
check(/"doNow\\":" << \(b\.do_now \? "true" : "false"\)/.test(buildingZoneCpp),
  "building-info serves the additive doNow field the client gates on");
check(/underConstruction && info\.hasJobs && info\.doNow !== undefined/.test(stockpiles) &&
  /data-bld-act="priority"/.test(stockpiles),
  "construction panel renders Make priority only when the DLL serves doNow (graceful dormant)");

// B147's five-tab layout is RETIRED (B174 exact-parity mandate, oracle B174-1): native shows
// exactly 3 chevron tabs, contents rows live at the bottom of the Tasks tab, and linked
// stockpiles moved to the B171 side window. Same retirement convention as the B68 glow shim
// above; the rebuilt structure is pinned by tools/harness/b174_wsrebuild_client_test.mjs.
console.log("# B147 -> B174 three native workshop tabs (5-tab layout retired)");
check(/const WS_TABS = \[\["tasks", "Tasks"\], \["workers", "Workers"\], \["orders", "Work orders"\]\]/.test(stockpiles),
  "tab strip declares exactly the 3 native tabs (Tasks / Workers / Work orders)");
check(!/\["contents", "Contents"\]/.test(stockpiles) && !/\["stockpiles", "Linked stockpiles"\]/.test(stockpiles),
  "(test-the-test) the B147 Contents / Linked stockpiles tabs are fully retired");
check(/\$\{wsContentsSectionHtml\(items\)\}/.test(stockpiles),
  "contents rows render INSIDE the Tasks tab body (bottom section, oracle B174-1)");
check(/\.ws-contents \{[\s\S]*?margin-top: auto/.test(css),
  "CSS pins the contents section to the bottom of the tab (native placement)");
check(!/workshop-footer/.test(stockpiles),
  "the workshop footer is retired (Remove building moved into the header tool cluster)");
// WAVE 4: the workshop tabs are the native `TAB` grammar (matrix §3 F3: "Workshop / Kitchen |
// row 1 = TAB"), painted from DF's own sprite cells by DWFUI -- NOT the old CSS clip-path imitation
// in browser font. This cell now REJECTS the imitation: the legacy rule survives only behind
// `:not(.dwfui-tab)`, and wsTabsHtml must declare level:'primary'.
check(/level: "primary"/.test(stockpiles) && /cls: "workshop-tabs"/.test(stockpiles),
  "the 3 workshop tabs render through DWFUI.tabsHtml at the native TAB level");
check(!/^\.building-panel \.workshop-tab \{/m.test(css) &&
  /\.building-panel \.workshop-tab:not\(\.dwfui-tab\) \{/.test(css),
  "the legacy CSS chevron imitation can no longer override the native tab paint");

console.log("# B174 native picker + links flow wiring");
check(/wsPickerSearchHtml\(\)/.test(stockpiles) && /magnifier: true/.test(stockpiles),
  "picker search renders through DWFUI.searchHtml with the native magnifier");
check(!/Search tasksâ/.test(stockpiles) && !/placeholder="[^"]*â/.test(stockpiles),
  "the mojibake search placeholder is gone (fixed at the source with plain ASCII)");
check(/wsLinksWindowHtml/.test(stockpiles) && /data-ws-link-arm/.test(stockpiles) &&
  /wsLinkWireMode/.test(stockpiles),
  "links side window renders give/take arm buttons and maps verbs through wsLinkWireMode");
check(/workshopPost\("\/stockpile-link", wsLinkPayload\(spId, info\.id, workshopLinkArmMode, true\)\)/.test(stockpiles) &&
  /function wsLinkPayload\([\s\S]*mode: wsLinkWireMode\(panelMode\), on: on \? 1 : 0/.test(stockpiles),
  "an armed map pick POSTs /stockpile-link with the translated wire mode (on=1)");
check(/wsLinkPayload\(btn\.dataset\.wsLinkRemove, info\.id, btn\.dataset\.wsLinkDir, false\)/.test(stockpiles),
  "the linked-row X unlinks through the same route (on=0)");
check(/let wsLinkArmed = null;/.test(controls) && /async function wsLinkClick\(event\)/.test(controls) &&
  /window\.DFWsLink\.arm = function \(wsId, mode\)/.test(controls),
  "controls-placement arms the map-click stockpile pick (DFWsLink, squad-kill convention)");
check(/kind === "stockpile" && typeof selectionBuildingId === "function"/.test(controls),
  "map pick resolves the clicked stockpile through the existing /inspect pipeline");
check(/\} else if \(wsLinkArmed\) \{\s*\n\s*wsLinkClick\(event\);/.test(controls),
  "the pointer dispatch routes armed link clicks before falling through to inspect");

// B223 chat ping targeting -- the MAP half. (The chat half -- resolution, auto-send, cancel -- is
// driven end-to-end through the real module in chat_client_test.mjs PART G.) These pin the four
// mechanical properties that live in controls-placement and that a chat-side test cannot see: the
// armed flag, the /inspect pick, the crosshair, and -- the anti-wedge invariant -- that the pick
// DISARMS BEFORE IT AWAITS.
console.log("# B223 chat ping targeting (arm -> map click -> auto-send)");
const chat = read("dwf-chat.js");
check(/let chatPingArmed = false;/.test(controls) && /async function chatPingClick\(event\)/.test(controls) &&
  /window\.DFChatPing\.arm = function \(\)/.test(controls) && /window\.DFChatPing\.isArmed = function/.test(controls),
  "controls-placement arms the map-click ping pick (DFChatPing, the ws-link/squad-kill convention)");
check(/async function chatPingClick\(event\)[\s\S]*?\/inspect\?[\s\S]*?window\.DFChatPing\.onPick\(data, pos\)/.test(controls),
  "the ping pick resolves the clicked tile through the existing /inspect pipeline and hands it to chat");
// NO WEDGE: disarm must happen BEFORE the awaited fetch, so a slow/failing /inspect can never leave
// the map armed. Assert the ORDER, not merely the presence -- and do it on the function's OWN body
// (a whole-file regex would happily match the disarm() call in the Escape cascade further down and
// pass for the wrong reason).
const pingClickBody = (/async function chatPingClick\(event\) \{[\s\S]*?\n  \}\n/.exec(controls) || [""])[0];
const disarmAt = pingClickBody.indexOf("window.DFChatPing.disarm();");
const awaitAt = pingClickBody.indexOf("await fetch(url");
check(pingClickBody !== "" && disarmAt >= 0 && awaitAt >= 0 && disarmAt < awaitAt,
  "the pick disarms BEFORE it awaits /inspect (one-shot; a failed inspect cannot wedge the mode)");
check(pingClickBody !== "" && !/await fetch\(url[\s\S]*window\.DFChatPing\.disarm\(\);/.test(pingClickBody),
  "(test-the-test) within chatPingClick, the disarm-AFTER-await shape -- the wedge -- is absent");
check(/haulingStopArmedRoute >= 0 \|\| wsLinkArmed \|\| chatPingArmed\) \? "crosshair"/.test(controls),
  "an armed ping puts the map on the SAME crosshair every other armed tool uses");
check(/\} else if \(chatPingArmed\) \{\s*\n\s*(?:\/\/[^\n]*\n\s*)*chatPingClick\(event\);/.test(controls),
  "the pointer dispatch routes an armed ping click before falling through to inspect");
check(/if \(chatPingArmed\) \{\s*\n\s*window\.DFChatPing\.disarm\(\);\s*\n\s*handledEscape = true;/.test(controls),
  "Escape cancels an armed ping (checked first in the cascade -- always one key away from out)");
// The consumer half must ARM, never author. The camera-centre composer insert is the bug and is gone.
check(/dataset: \{ chatPingArm: "" \}/.test(chat) && !/insertLocationPing/.test(chat) &&
  !/function currentCameraLocation/.test(chat),
  "the chat ping button ARMS the map pick -- the camera-centre composer insert is removed entirely");
check(!/data-chat-ping-location/.test(chat),
  "(test-the-test) no path in chat still reads the old camera-ping hook");

// S7 shell: the Escape cascade ORDER is the "always one key away from out, back out one layer at a
// time" navigation contract. Each branch is a layer, and the ORDER in which they are checked is what
// makes Escape peel the topmost layer first: a transient one-shot pick before any panel, the unit
// SHEET before the generic info LIST, the outer screens (World / Esc menu) before anything they
// contain, and the "nothing else open -> open the Esc menu" fallback dead last. A silent reorder here
// (e.g. openEscMenu creeping above a panel branch) would make Escape pop the game menu while a panel
// is still up -- exactly the confusing/inconsistent-navigation class the sprint calls a blocker. Pin
// the order so it cannot regress unnoticed. The order is asserted on the cascade's OWN body only, so
// an identically-named guard elsewhere in the file cannot satisfy it by accident.
console.log("# S7 Esc cascade: back-out order (one layer at a time, menu is the last resort)");
const escCascade = (/let handledEscape = false;[\s\S]*?\n      if \(handledEscape\) \{/.exec(controls) || [""])[0];
check(escCascade !== "", "the Escape cascade block is present and isolatable");
const ord = s => escCascade.indexOf(s);
const G = {
  chatPing:   "if (chatPingArmed) {",
  world:      "worldScreenOpen()) {",
  escMenu:    "escMenuOpen()) {",
  selection:  'else if (selection.classList.contains("visible")) {',
  clientPanel:'else if (clientPanel.classList.contains("visible")) {',
  zonePaint:  'else if (zoneMode === "paint") {',
  zoneClose:  "else if (zoneMode || (typeof zonePalette",
  burrow:     "else if (burrowMode) {",
  hauling:    "else if (haulingMode) {",
  stock:      "else if (stockMode) {",
  twoClick:   "else if (twoClickArmed()) {",
  designation:"else if (digMenuOpen || plantMenuOpen || smoothMenuOpen",
  frameTop:   "escCloseTopmost()) {",
  openMenu:   'else if (typeof openEscMenu === "function") {',
};
// Every guard the order test names must actually exist in the cascade -- a renamed/removed branch
// fails HERE rather than silently making an ordering check vacuously true.
check(Object.values(G).every(g => escCascade.includes(g)),
  "every cascade branch the order test pins is present in the block");
check(ord(G.chatPing) >= 0 && ord(G.chatPing) < ord(G.world),
  "a transient armed chat-ping is peeled FIRST -- before any screen or panel (one Escape and it's gone)");
check(ord(G.world) < ord(G.selection) && ord(G.escMenu) < ord(G.selection),
  "the outer World screen and Esc menu are closed before any panel branch runs");
check(ord(G.selection) < ord(G.clientPanel),
  "the unit SHEET (#selection) backs out before the generic info LIST (#clientPanel) -- sheet before list");
check(ord(G.zonePaint) < ord(G.zoneClose),
  "zone back-out is two-stage: paint stage returns to the type grid before the whole mode closes");
check(ord(G.burrow) >= 0 && ord(G.hauling) >= 0 && ord(G.stock) >= 0,
  "every mode panel (burrow, hauling, stock) has an Escape branch -- none is the one panel Esc can't close");
check(ord(G.twoClick) < ord(G.designation),
  "a pending two-click box is dropped (tool stays armed) before the tool itself is dropped -- two-stage");
check(ord(G.frameTop) < ord(G.openMenu),
  "a framework panel (escCloseTopmost) is closed before the Esc menu opens");
check(ord(G.openMenu) === Math.max(...Object.values(G).map(ord)),
  "opening the Esc menu is the LAST branch -- the fallback when nothing else is open (never earlier)");
// test-the-test: a seeded inversion (menu-first) must move openEscMenu ahead of the panels, so the
// ordering assertions above would genuinely fail on it. Swap the first (chatPing) and last (openMenu)
// guards via placeholders so the two replacements can't clobber each other.
const seededInversion = escCascade
  .replace(G.chatPing, " A ").replace(G.openMenu, " B ")
  .replace(" A ", G.openMenu).replace(" B ", G.chatPing);
check(seededInversion.indexOf(G.openMenu) < seededInversion.indexOf(G.world),
  "(test-the-test) swapping the first and last branches really does move openEscMenu ahead of the screens");

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
