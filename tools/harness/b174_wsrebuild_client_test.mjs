// b174_wsrebuild_client_test.mjs -- B174 workshop-panel rebuild: pure-builder fixture suite.
//
// Oracles: tools/orchestrator/attachments/B174-1.png (native stoneworker Tasks tab -- 3 chevron
// tabs, Add-new-task plaque, CONTENTS rows at the bottom of the Tasks tab), B174-2.png (native
// task picker: search + Cancel + one flat alphabetical list + red "[Requires X]" annotations),
// B174-3.png (the pre-rebuild shame list this suite guards AGAINST: 5 tabs, "Queued tasks (0/10)"
// counter, raw enum debug text, mojibake), B171-1/2/3.png (links side window), and the B168
// carpenter set proving one panel logic generalizes across workshop types.
//
// OFFLINE: no DF, no server, no browser. Drives the exported pure builders exactly like
// b55_farmplot_client_test drives the farm pilot. Load-bearing pins:
//   1. WIRE: the '!' control's dataset action stays job.doNow ? "priority" : "now" (B121);
//      wsLinkWireMode maps workshop-side verbs onto the stockpile-first /stockpile-link route
//      (take->give, give->take) -- a drift here silently links piles BACKWARDS.
//   2. NATIVE PARITY: exactly 3 tabs; no counter; no enum/reaction debug text in picker rows;
//      requirement objection renders as the red sub-line only when avail === false.
//   3. TEST-THE-TEST: seeded-bad shapes (a 5-tab strip, an enum-leaking row) are rejected.
//
//   node tools/harness/b174_wsrebuild_client_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

// The panels module resolves these at call time (browser: earlier <script>s).
globalThis.escapeHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.dfTokenMatch = (name, q) => String(name || "").toLowerCase().includes(String(q || "").toLowerCase());
globalThis.DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
const M = require(join(root, "web/js/dwf-building-zone-stockpile-panels.js"));

// ==============================================================================================
console.log("[1] tabs: exactly the 3 native tabs (oracle B174-1):");
check("WS_TABS is Tasks / Workers / Work orders and nothing else",
  JSON.stringify(M.WS_TABS) === JSON.stringify([["tasks", "Tasks"], ["workers", "Workers"], ["orders", "Work orders"]]));
check("legacy tab values fold to tasks", M.wsNormalizeTab("contents") === "tasks" &&
  M.wsNormalizeTab("stockpiles") === "tasks" && M.wsNormalizeTab(undefined) === "tasks");
check("real tabs survive normalization", M.wsNormalizeTab("workers") === "workers" && M.wsNormalizeTab("orders") === "orders");
const tabsHtml = M.wsTabsHtml("tasks");
// WAVE 4: the workshop row is the native `TAB` grammar (matrix §3 F3: "Workshop / Kitchen | row
// 1 = TAB"). It used to pass no level, so `cls:"workshop-tabs"` REPLACED the shared base class and it
// rendered as a CSS box in browser font. Base classes are additive now, and the old
// `class="workshop-tabs"` (no dwfui-tabs) must be impossible.
check("tab strip renders in the native TAB grammar (dfui base class, bitmap labels, single active)",
  /class="dwfui-tabs dwfui-tabs--primary workshop-tabs dwfui-tabs--hug" role="tablist"/.test(tabsHtml) &&
  !/class="workshop-tabs" role="tablist"/.test(tabsHtml) &&
  (tabsHtml.match(/class="dwfui-tab dwfui-tab--primary workshop-tab/g) || []).length === 3 &&
  (tabsHtml.match(/data-dwfui-bitmap-text=/g) || []).length === 3 &&
  (tabsHtml.match(/<button /g) || []).length === 3 &&
  (tabsHtml.match(/aria-selected="true"/g) || []).length === 1 &&
  /data-ws-tab="workers"/.test(tabsHtml));
// test-the-test: the pre-B174 5-tab shape must be impossible from WS_TABS
check("(test-the-test) no Contents / Linked stockpiles tab can render",
  !/Contents|Linked stockpiles/.test(tabsHtml) && M.WS_TABS.length === 3);

// ==============================================================================================
console.log("\n[2] task rows: native control cluster, B121 wire pin:");
const activeJob = { id: 7, name: "Make rock table", worker: "Urist", working: true, repeat: true, doNow: false, suspended: false };
const suspJob = { id: 9, name: "Make rock blocks", suspended: true, doNow: true, repeat: false };
const rowA = M.wsTaskRowHtml(activeJob);
const rowS = M.wsTaskRowHtml(suspJob);
check("active task name is cyan", /workshop-name cyan/.test(rowA));
check("suspended task name is NOT cyan and row is marked suspended",
  !/workshop-name cyan/.test(rowS) && /workshop-row suspended/.test(rowS));
check("all task controls share one trailing cell instead of becoming grid children",
  (rowA.match(/class="ws-task-controls"/g) || []).length === 1 &&
  rowA.indexOf('class="ws-task-controls"') < rowA.indexOf('BUILDING_JOBS_ACTIVE') &&
  rowA.lastIndexOf('</span>') > rowA.indexOf('data-ws-job-action="cancel"'));
// WAVE 5 RETARGET (same INTENT, stricter): these three cells used to pin the TOKENS.glyphs EMOJI
// spans (ws-glyph-check / ws-glyph-repeat / ws-glyph-pause). TOKENS.glyphs declares itself
// DEPRECATED -- "EVERY entry below now HAS a real DF sprite in TOKENS.sprites" -- and the spec
// forbids an emoji where a sprite exists. The controls now render DF's own BUILDING_JOBS_* tiles,
// so the assertions are re-aimed at the SPRITE TOKENS and each carries a NEGATIVE GUARD making the
// old emoji form impossible -- exactly as the tab cells above assert `dwfui-tabs` and then assert
// the bare hand-built class is impossible. Nothing is loosened: every cell still pins state->art.
check("status tile is DF's own BUILDING_JOBS_ACTIVE, dimmed via the native frame when suspended",
  /data-dwfui-sprite="BUILDING_JOBS_ACTIVE"/.test(rowA) && !/dwfui-btn--disabled/.test(rowA) &&
  /data-dwfui-sprite="BUILDING_JOBS_ACTIVE"/.test(rowS) && /dwfui-btn--disabled/.test(rowS) &&
  !/ws-glyph-check/.test(rowA) && !/&#10003;/.test(rowA));
check("repeat is a LATCH lit from job.repeat (two sprites, not one glyph)",
  /class="dwfui-latch ws-repeat-latch on"[^>]*data-ws-job="7"[^>]*data-ws-job-action="repeat"[^>]*aria-pressed="true"/.test(rowA) &&
  /data-dwfui-sprite="BUILDING_JOBS_REPEAT_ACTIVE"/.test(rowA) &&
  /data-dwfui-sprite="BUILDING_JOBS_REPEAT"/.test(rowS) &&
  !/class="dwfui-latch ws-repeat-latch on"/.test(rowS) && !/&#8635;/.test(rowA));
check("B121 wire pin: '!' sends now when doNow unset, priority when set",
  /data-ws-job="7" data-ws-job-action="now"/.test(rowA) &&
  /data-ws-job="9" data-ws-job-action="priority"/.test(rowS));
check("suspend is a LATCH: the wire still flips suspend<->resume, and the art flips with it",
  /data-ws-job-action="suspend"/.test(rowA) && /data-ws-job-action="resume"/.test(rowS) &&
  /data-dwfui-sprite="BUILDING_JOBS_SUSPENDED"/.test(rowA) &&
  /data-dwfui-sprite="BUILDING_JOBS_SUSPENDED_ACTIVE"/.test(rowS) &&
  /class="dwfui-latch ws-suspend-latch on"/.test(rowS) &&
  !/ws-glyph-pause/.test(rowA) && !/ws-glyph-play/.test(rowS));
check("remove control present", /data-ws-job-action="cancel"/.test(rowA));
check("status meta lives in the row title, not a rendered meta line",
  /title="Worker: Urist/.test(rowA) && !/workshop-meta/.test(rowA));
check("no queued-task counter anywhere in the row builders", !/Queued tasks \(/.test(rowA + rowS));

// ==============================================================================================
console.log("\n[3] contents rows (bottom of Tasks tab, oracle B174-1):");
const permItem = { id: 41, name: "siltstone", role: "PERM", forbidden: false, dump: false, hidden: false };
const prodItem = { id: 42, name: "siltstone table", role: "TEMP", forbidden: true, dump: true, hidden: true };
const rowP = M.wsContentRowHtml(permItem);
const rowT = M.wsContentRowHtml(prodItem);
check("building-material row carries the house status mark",
  /ws-item-status" title="Part of this building"/.test(rowP));
check("non-PERM row renders an EMPTY status cell (native alignment)",
  /ws-item-status" aria-hidden="true"><\/span>/.test(rowT));
check("actions: locate / forbid / dump / then separated hide",
  /data-ws-item-action="locate" data-ws-item="41"/.test(rowP) &&
  /data-ws-item-action="forbid"/.test(rowP) &&
  /data-ws-item-action="dump"/.test(rowP) &&
  /class="dwfui-gap"[^>]*data-ws-item-action="hide"/.test(rowP));
check("additive flags light the active states",
  !/class="active"/.test(rowP) && (rowT.match(/class="(?:active|active dwfui-gap|dwfui-gap active)"/g) || []).length >= 2);
check("contents section wraps rows; empty items render nothing",
  /^<div class="ws-contents"/.test(M.wsContentsSectionHtml([permItem])) &&
  M.wsContentsSectionHtml([]) === "");
check("item name is escaped", !/<img/.test(M.wsContentRowHtml({ id: 1, name: "<img src=x>" })));

// ==============================================================================================
console.log("\n[4] picker rows (oracle B174-2): no debug enums, red requirements:");
const okRow = M.wsPickerRowHtml({ label: "Make rock table",
  dataset: { wsAddTask: "ConstructTable", wsSearch: "make rock table" } });
const reqRow = M.wsPickerRowHtml({ label: "Make display case", avail: false,
  objection: "[Requires Window]", dataset: { wsAddTask: "k", wsSearch: "make display case" } });
check("available row: plain label, key only in data attr",
  /data-ws-add-task="ConstructTable"/.test(okRow) && />Make rock table</.test(okRow) &&
  !/>ConstructTable</.test(okRow));
check("unavailable row: ws-unavailable class + RED objection sub-line",
  /workshop-task-option ws-unavailable/.test(reqRow) &&
  /class="dwfui-sub ws-objection">[\s\S]*data-dwfui-bitmap-text="\[Requires Window\]"/.test(reqRow));
check("available row w/o objection renders NO requirement sub", !/ws-objection/.test(okRow));
check("avail undefined (older DLL) renders available (fail-open)",
  !/ws-unavailable/.test(M.wsPickerRowHtml({ label: "x", objection: "[Requires Y]" })));
// test-the-test: a seeded-bad row leaking the enum meta must be detectably different
const seededBad = `<button class="workshop-task-option"><span>make edol case</span><span class="workshop-meta">MAKE_ENT304 INK1_BODY</span></button>`;
check("(test-the-test) an enum-leaking row shape is rejected by the no-enum pin",
  />MAKE_ENT304 INK1_BODY</.test(seededBad) && !/MAKE_ENT304/.test(okRow + reqRow));
// WAVE 5 RETARGET: native's picker "Cancel" label is ORANGE (#FF7F13 = the measured
// --dwfui-text-warning), not neutral grey. The wire (data-ws-toggle-add) is unchanged.
check("Cancel plaque row renders the ORANGE-toned plaque wired to the picker toggle",
  /dwfui-plaque orange ws-cancel-plaque" data-ws-toggle-add=""/.test(M.wsCancelRowHtml()) &&
  /data-dwfui-bitmap-text="Cancel"/.test(M.wsCancelRowHtml()));
check("picker search filters case-insensitively and trims the query",
  M.wsPickerMatches("make wooden barrel", "  WOODEN  ") &&
  !M.wsPickerMatches("make rock table", "wooden"));
const seededBadSearch = (hay, term) => String(hay).startsWith(String(term));
check("(test-the-test) seeded prefix-only search would reject a valid middle-token match",
  !seededBadSearch("make wooden barrel", "wooden") &&
  M.wsPickerMatches("make wooden barrel", "wooden"));

// ==============================================================================================
console.log("\n[5] header tools (oracle B174-1 top-right):");
const tools = M.wsHeaderToolsHtml({ linksOpen: true, renaming: false });
check("three native art tiles: link opener, quill, remove",
  /var\(--spa-ws-linkopen\)/.test(tools) && /var\(--spa-tile-quill\)/.test(tools) &&
  /var\(--spa-ws-remove\)/.test(tools));
check("tools carry their data hooks",
  /data-ws-links-toggle/.test(tools) && /data-ws-rename/.test(tools) && /data-ws-remove/.test(tools));
check("links opener reflects the open state", /dwfui-art-btn ws-tool active" style="background-image:var\(--spa-ws-linkopen\)/.test(tools));

// ==============================================================================================
console.log("\n[6] links flow (B171-2/3): side window + the wire-mode mapping:");
check("WIRE pin: workshop takes-from == pile gives (and vice versa)",
  M.wsLinkWireMode("take") === "give" && M.wsLinkWireMode("give") === "take");
// test-the-test: an identity mapping (the plausible-wrong implementation) must fail the pin
check("(test-the-test) an identity mode mapping would be caught",
  !(M.wsLinkWireMode("take") === "take"));
check("map-click link add builds the stockpile-first on=1 payload",
  JSON.stringify(M.wsLinkPayload("13", 77, "take", true)) ===
  JSON.stringify({ id: 13, target: 77, mode: "give", on: 1 }));
check("X unlink builds the stockpile-first on=0 payload",
  JSON.stringify(M.wsLinkPayload("12", 77, "give", false)) ===
  JSON.stringify({ id: 12, target: 77, mode: "take", on: 0 }));
const seededBadLinkPayload = (id, target, mode, on) => ({ id: target, target: id, mode, on });
check("(test-the-test) reversed ids / untranslated mode / boolean on are rejected",
  JSON.stringify(seededBadLinkPayload(13, 77, "take", true)) !==
  JSON.stringify(M.wsLinkPayload(13, 77, "take", true)));
const takeRow = M.wsLinkRowHtml({ id: 13, name: "Food Stockpile #13", dir: "take", x: 1, y: 2, z: 3 });
const giveRow = M.wsLinkRowHtml({ id: 12, name: "Food Stockpile #12", dir: "give", x: 4, y: 5, z: 6 });
check("linked rows carry the native direction art per served dir",
  /var\(--spa-ws-dirtake\)/.test(takeRow) && /var\(--spa-ws-dirgive\)/.test(giveRow));
check("unlink X carries id + dir for the on=0 POST",
  /data-ws-link-remove="13" data-ws-link-dir="take"/.test(takeRow) &&
  /data-ws-link-remove="12" data-ws-link-dir="give"/.test(giveRow));
check("locate carries the pile position", /data-ws-link-locate="13" data-sp-x="1" data-sp-y="2" data-sp-z="3"/.test(takeRow));
const win = M.wsLinksWindowHtml({ linkedStockpiles: [{ id: 13, name: "Food Stockpile #13", dir: "take", x: 1, y: 2, z: 3 }] }, "take");
check("side window: give/take mode buttons + red Done plaque + linked rows",
  /dwfui-sidewin ws-links-win/.test(win) &&
  /data-ws-link-arm="give"/.test(win) && /data-ws-link-arm="take"/.test(win) &&
  /data-ws-links-done=""/.test(win) && /Food Stockpile #13/.test(win));
check("armed mode button is lit",
  /active" style="background-image:var\(--spa-ws-linktake\)/.test(win) &&
  !/active" style="background-image:var\(--spa-ws-linkgive\)/.test(win));
const emptyWin = M.wsLinksWindowHtml({ linkedStockpiles: [] }, null);
check("no links -> instructional note, nothing armed",
  /No linked stockpiles/.test(emptyWin) && !/dwfui-art-btn[^"]*active/.test(emptyWin));

// ==============================================================================================
console.log("\n[7] source-level pins (mojibake + retired shapes):");
const src = fs.readFileSync(join(root, "web/js/dwf-building-zone-stockpile-panels.js"), "utf8");
check("no mojibake in any placeholder/title/label string (the B174-3 encoding bug class)",
  !/placeholder="[^"]*â/.test(src) && !/Search tasksâ/.test(src));
check("the old 5-tab declaration is gone",
  !/\["contents", "Contents"\], \["stockpiles", "Linked stockpiles"\]/.test(src));
check("the queued-task counter is gone", !/Queued tasks \(\$\{jobs\.length\}\/10\)/.test(src));
check("the footer block is gone from the panel markup", !/<div class="workshop-footer">/.test(src));
check("the picker never renders t.reaction/t.job as visible meta",
  !/workshop-meta">\$\{escapeHtml\(meta\)\}/.test(src));

console.log(`\n${failed ? "FAIL" : "PASS"} b174_wsrebuild_client_test -- ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
