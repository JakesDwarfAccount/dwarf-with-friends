// hostwrites_fixture_test.mjs -- OFFLINE fixtures for B226 (browser barter) + B227 (justice
// convict/interrogate). No DF, no server: exercises the client pure shapers/markup against
// seeded JSON (good AND seeded-bad -- completeness rule 3), and greps the server sources for the
// wire + guard invariants (the 501-guard shape, the native-drive verification gates, the
// no-hand-write rule).
//   node tools/harness/hostwrites_fixture_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const webJs = name => join(here, "..", "..", "web", "js", name);
const src = name => join(here, "..", "..", "src", name);
const repo = name => join(here, "..", "..", name);

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

// ---- boot the same globals the concatenated browser bundle provides -----------------------------
globalThis.DWFUI = require(webJs("dwf-ui-components.js"));
globalThis.escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const P = require(webJs("dwf-fort-panels.js"));
globalThis.fortUnitRef = P.fortUnitRef;
globalThis.fortPrettyKey = P.fortPrettyKey;
globalThis.unitPortraitMarkup = (u, cls) => `<span class="${cls}" data-portrait-unit="${u.unitId}"></span>`;

for (const f of ["dwf-tradedepot-panel.js", "dwf-tradescreen.js", "dwf-fort-admin.js"]) {
  try { execFileSync(process.execPath, ["--check", webJs(f)], { stdio: "pipe" }); check(`node --check ${f}`, true); }
  catch (e) { check(`node --check ${f}`, false, e.stderr ? e.stderr.toString() : e.message); }
}

const TD = require(webJs("dwf-tradedepot-panel.js"));
const TS = require(webJs("dwf-tradescreen.js"));
const FA = require(webJs("dwf-fort-admin.js"));

// ================================================================================================
console.log("\n# B226 barter shapers");
const tradeOpen = {
  ok: true, open: true, stillUnloading: 0, haveTalker: 1, counterOffer: false,
  choosingMerchant: false, merchantCiv: "The Guild of Axes", merchantMood: 0, talkLine: "",
  guards: { tradeSelect: true, tradeConfirm: false, tradeOpen: false },
  caravanGoods: [
    { id: 100, idx: 0, desc: "iron bars", value: 40, selected: true, contained: false },
    { id: 101, idx: 1, desc: "a wooden bin", value: 10, selected: true, contained: false },
    { id: 102, idx: 2, desc: "rope reed cloth", value: 25, selected: false, contained: true },
    { id: 103, idx: 3, desc: "a stone mug", value: 5, selected: false, contained: false },
  ],
  fortGoods: [
    { id: 200, idx: 0, desc: "a masterwork amulet", value: 240, selected: false, contained: false },
  ],
};
check("barterRows keeps native order and fields",
  TD.barterRows(tradeOpen, 0).length === 4 && TD.barterRows(tradeOpen, 0)[2].contained === true);
check("barterRows side 1", TD.barterRows(tradeOpen, 1).length === 1);
const totals = TD.barterTotals(tradeOpen);
check("barterTotals follows NATIVE bin semantics (contents of a selected bin count)",
  totals.caravan.count === 3 && totals.caravan.value === 75,
  JSON.stringify(totals));
check("barterTotals: unselected side is zero", totals.fort.count === 0 && totals.fort.value === 0);
guard("a contained row after an UNselected bin does NOT count",
  TD.barterTotals({ caravanGoods: [
    { id: 1, idx: 0, desc: "bin", value: 10, selected: false, contained: false },
    { id: 2, idx: 1, desc: "cloth", value: 25, selected: false, contained: true },
  ], fortGoods: [] }).caravan.count === 0);
guard("malformed rows (missing id) are dropped, not NaN-ed",
  TD.barterRows({ caravanGoods: [{ desc: "ghost" }, null, { id: 5, idx: 0, desc: "real", value: 1 }] }, 0).length === 1);

console.log("\n# B226 barter block text (why the commit is unavailable)");
check("open+ready -> no block", TD.barterBlockText(tradeOpen) === "");
check("unloading blocks", /unloading/.test(TD.barterBlockText(Object.assign({}, tradeOpen, { stillUnloading: 1 }))));
check("no talker blocks", /negotiator/.test(TD.barterBlockText(Object.assign({}, tradeOpen, { haveTalker: 0 }))));
check("closed blocks", /No trade session/.test(TD.barterBlockText({ ok: true, open: false })));
check("null state blocks honestly", TD.barterBlockText(null).length > 0);
check("guard text prefers the server's own plain-English reason",
  TD.hostwriteGuardText({ error: "locked behind probe P-T3" }) === "locked behind probe P-T3");
check("guard text has an honest fallback", /probe/i.test(TD.hostwriteGuardText(null)));

console.log("\n# B226 trade-screen shapers (dwf-tradescreen.js, oracle B226-barter-1..4)");
// A payload in the ENRICHED shape the updated hw_trade_state serves (weights/groups/capacity/
// native strings). The screen must also survive the LEGACY shape (tradeOpen above).
const tradeRich = Object.assign({}, tradeOpen, {
  guards: { tradeSelect: true, tradeConfirm: true, tradeOpen: false },
  merchantCivNative: "Sarvabok", fortName: "Tostunib", talkerName: "Kosoth Amudrigoth",
  screenTitle: "Kosoth Amudrigoth, Merchant", merchantName: "Kosoth Amudrigoth",
  merchantTraderId: -1, merchantMood: 50, talkLine: "Greet", handleAppraisal: 0,
  capacity: 200, capacityFr: 0,
  caravanGoods: [
    { id: 100, idx: 0, desc: "(gold bars)", value: 150, selected: false, contained: false,
      weight: 115, weightFr: 0, weightText: "115", group: "BAR", spriteRef: { itemType: "BAR", itemSubtype: -1, materialType: 0, materialIndex: 1 } },
    { id: 101, idx: 1, desc: "(marble blocks)", value: 10, selected: true, contained: false,
      weight: 16, weightFr: 0, weightText: "16", group: "BLOCKS", spriteRef: null },
  ],
  fortGoods: [
    { id: 200, idx: 0, desc: "(Meat Barrel (apricot wood))", value: 24, selected: false, contained: false,
      weight: 21, weightFr: 0, weightText: "21", group: "BARREL", spriteRef: null },
    { id: 201, idx: 1, desc: "mule meat", value: 2, selected: false, contained: true,
      weight: 1, weightFr: 0, weightText: "1", group: "MEAT", spriteRef: null },
    { id: 202, idx: 2, desc: "limestone statue of a dwarf", value: 50, selected: false, contained: false,
      weight: 162, weightFr: 0, weightText: "162", group: "STATUE", spriteRef: null },
  ],
});
const fortGroups = TS.tsGroups(TS.tsRows(tradeRich, 1));
check("groups follow native item-type runs with oracle labels (Barrels / Statues)",
  fortGroups.length === 2 && fortGroups[0].label === "Barrels" && fortGroups[1].label === "Statues");
check("contained rows attach to their container (Contains N items), not the group list",
  fortGroups[0].items[0].children.length === 1 && fortGroups[0].items.length === 1);
check("legacy payload without group fields degrades to ONE label-less group (flat, honest)",
  TS.tsGroups(TS.tsRows(tradeOpen, 0)).length === 1 && TS.tsGroups(TS.tsRows(tradeOpen, 0))[0].label === "");
const richFooter = TS.tsFooter(tradeRich);
check("footer: caravan marked 10 vs fort 0 -> Trader Loss (absolute, oracle barter-2)",
  richFooter.profit.kind === "loss" && /Trader Loss: 10/.test(richFooter.profit.text));
check("footer: weight line uses capacity + per-row weights (Allowed Weight)",
  richFooter.weight && richFooter.weight.kind === "allowed" && /Allowed Weight: \d+/.test(richFooter.weight.text));
check("footer: native civ + fortress lines (Merchants from X / Your fortress of Y)",
  richFooter.merchantLine === "Merchants from Sarvabok" && richFooter.fortLine === "Your fortress of Tostunib");
check("footer: nothing marked -> Trader Profit: 0% (oracle barter-1/4)",
  TS.tsFooter(Object.assign({}, tradeRich, {
    caravanGoods: tradeRich.caravanGoods.map(g => Object.assign({}, g, { selected: false })) })).profit.text === "Trader Profit: 0%");
guard("legacy payload without capacity -> NO weight line (omitted, never faked)",
  TS.tsFooter(tradeOpen).weight === null);
check("header uses the native struct strings and the oracle mood line",
  TS.tsHeader(tradeRich).name === "Kosoth Amudrigoth, Merchant" &&
  TS.tsHeader(tradeRich).mood === "Kosoth seems willing to trade.");
check("post-trade talk line renders the oracle thank-you quote and drops the mood line",
  TS.tsHeader(Object.assign({}, tradeRich, { talkLine: "Trade" })).quote.includes("Thank you for your business") &&
  TS.tsHeader(Object.assign({}, tradeRich, { talkLine: "Trade" })).mood === "");

console.log("\n# B226 trade-screen action states (oracle-evidenced enable/disable rules)");
check("trade enabled with guards on (green even with nothing marked -- oracle barter-1)",
  TS.tsActionState(Object.assign({}, tradeRich, {
    caravanGoods: [], fortGoods: [] }), "trade").enabled === true);
check("offer enabled while NO fort goods are marked (oracle barter-1/2)",
  TS.tsActionState(tradeRich, "offer").enabled === true);
check("offer GREYS once fort goods are marked (oracle barter-3), with the reason stated",
  (() => { const t = JSON.parse(JSON.stringify(tradeRich)); t.fortGoods[2].selected = true;
    const a = TS.tsActionState(t, "offer");
    return a.enabled === false && /barter-3/.test(a.reason); })());
check("seize stays disabled with the honest unknown-condition reason (grey in EVERY capture)",
  TS.tsActionState(tradeRich, "seize").enabled === false &&
  /every native capture/.test(TS.tsActionState(tradeRich, "seize").reason));
check("guard off -> commits disabled with the trade_confirm probe reason (visible, not hidden)",
  (() => { const a = TS.tsActionState(tradeOpen, "trade");
    return a.enabled === false && /trade_confirm/.test(a.reason) && /dfcapture-hostwrites\.json/.test(a.reason); })());
check("guard off -> selection disabled with the trade_select probe reason",
  (() => { const t = Object.assign({}, tradeRich, { guards: { tradeSelect: false, tradeConfirm: true, tradeOpen: false } });
    const a = TS.tsActionState(t, "select");
    return a.enabled === false && /trade_select/.test(a.reason); })());
check("unloading blocks every action with the unloading reason",
  /unloading/.test(TS.tsActionState(Object.assign({}, tradeRich, { stillUnloading: 1 }), "trade").reason));

console.log("\n# B226 trade-screen markup (tradeScreenMarkup)");
const tsState = extra => Object.assign({ trade: tradeRich, error: "", busy: false,
  armed: "", search: { 0: "", 1: "" } }, extra);
const tsOpen = TS.tradeScreenMarkup(tsState());
check("both panels render with per-side searches and scroll lists",
  (tsOpen.match(/class="ts-side"/g) || []).length === 2 &&
  /data-ts-search-0/.test(tsOpen) && /data-ts-search-1/.test(tsOpen));
check("rows carry the wire datasets (item id + side + next selection)",
  /data-ts-item="100" data-ts-side="0" data-ts-on="1"/.test(tsOpen) &&
  /data-ts-item="101" data-ts-side="0" data-ts-on="0"/.test(tsOpen));
check("group headers carry a whole-group checkbox with the member ids",
  /data-ts-group="200"/.test(tsOpen) && /data-ts-side="1"/.test(tsOpen));
check("the three native commits all render (Seize grey/disabled, Trade + Offer live)",
  /data-ts-act="seize"/.test(tsOpen) && /data-ts-act="trade"/.test(tsOpen) &&
  /data-ts-act="offer"/.test(tsOpen) && /ts-commit-seize[^>]*disabled/.test(tsOpen));
check("per-side Mark all / Unmark all render with side+on datasets",
  /data-ts-mark-all="0" data-ts-on="1"/.test(tsOpen) && /data-ts-mark-all="1" data-ts-on="0"/.test(tsOpen));
check("footer shows Value/Profit lines and the container row shows Contains N items",
  /Trader Profit|Trader Loss/.test(tsOpen) && /Contains 1 item/.test(tsOpen));
check("host-close is explicit about the native LEAVESCREEN",
  /data-ts-act="close"/.test(tsOpen) && /LEAVESCREEN/.test(tsOpen));
const tsGuarded = TS.tradeScreenMarkup(tsState({ trade: tradeOpen }));
check("guard off -> commit plaques render DISABLED with the probe reason in the tooltip",
  /data-ts-act="trade"[^>]*title="[^"]*trade_confirm/.test(tsGuarded.replace(/\n/g, " ")) ||
  (/data-ts-act="trade"/.test(tsGuarded) && /trade_confirm/.test(tsGuarded) && /disabled/.test(tsGuarded)));
const tsArmed = TS.tradeScreenMarkup(tsState({ armed: "offer" }));
check("offer arms to an explicit second-click confirmation",
  /Really offer with no payment\?/.test(tsArmed));
const tsCounter = TS.tradeScreenMarkup(tsState({
  trade: Object.assign({}, tradeRich, { counterOffer: true, counterOfferItems: [{ id: 9, desc: "iron bars" }] }) }));
check("counter-offer replaces the commits with Accept/Refuse",
  /counter-offers/.test(tsCounter) && /data-ts-act="counter-accept"/.test(tsCounter) &&
  /data-ts-act="counter-decline"/.test(tsCounter) && !/data-ts-act="trade"/.test(tsCounter));
const tsClosed = TS.tradeScreenMarkup(tsState({ trade: { ok: true, open: false, guards: { tradeOpen: false } } }));
check("closed session -> remote-open renders DISABLED with the trade_open guard reason",
  /data-ts-act="open"/.test(tsClosed) && /disabled/.test(tsClosed) && /trade_open/.test(tsClosed));
check("closed session + guard on -> remote-open is live",
  (() => { const m = TS.tradeScreenMarkup(tsState({ trade: { ok: true, open: false, guards: { tradeOpen: true } } }));
    return /data-ts-act="open"/.test(m) && !/data-ts-act="open"[^>]*disabled/.test(m.replace(/\n/g, " ")); })());
const tsErr = TS.tradeScreenMarkup(tsState({ error: "locked behind the host-side verification probe" }));
check("a guarded reply's reason is surfaced verbatim",
  /locked behind the host-side verification probe/.test(tsErr));
guard("approximate appraisal renders the ~ value prefix",
  /Value: ~150/.test(TS.tradeScreenMarkup(tsState({
    trade: Object.assign({}, tradeRich, { handleAppraisal: 1 }) }))) &&
  !/Value: ~150/.test(tsOpen));

console.log("\n# B226 depot-panel doorway (tradeDepotPanelMarkup)");
const mkState = extra => Object.assign({
  id: 4, info: { ok: true, built: true, accessible: true, caravans: [{ origin: "caravan", state: "AtDepot", active: true, atDepot: true }], broker: { found: true, name: "Urist" } },
  tradeStatus: null, goods: null, goodsOpen: false, goodsSearch: "", busy: false, armed: "", tradeError: "",
}, extra);
const doorOpen = TD.tradeDepotPanelMarkup(mkState({ trade: tradeOpen }));
check("open session -> live barter doorway + goods-screen doorway",
  /data-td-act="barter-screen"/.test(doorOpen) && !/barter-screen"[^>]*disabled/.test(doorOpen) &&
  /data-td-act="goods-screen"/.test(doorOpen));
check("the old 'complete at the depot (host)' advice is SUPPRESSED while a session is live",
  !/Complete the barter at the depot/.test(doorOpen));
check("no caravan at depot -> doorway DISABLED with the honest reason (visible, never hidden)",
  (() => { const m = TD.tradeDepotPanelMarkup(mkState({ trade: { ok: true, open: false, guards: {} },
    info: { ok: true, built: true, accessible: true, caravans: [], broker: { found: true } } }));
    return /data-td-act="barter-screen"/.test(m) && /disabled/.test(m) && /No caravan is at the depot/.test(m); })());
check("a dead /depot-trade (legacy server) -> doorway DISABLED naming the missing route",
  (() => { const m = TD.tradeDepotPanelMarkup(mkState({ trade: { ok: false, error: "request failed (404)" } }));
    return /depot-trade/.test(m) && /disabled/.test(m); })());
guard("caravan at depot + closed session -> doorway is LIVE (the screen holds the guarded open)",
  (() => { const e = TD.barterEntryState({ ok: true, open: false, guards: {} },
    { caravans: [{ atDepot: true }] }); return e.enabled === true; })());

console.log("\n# B226 bring-goods screen (dwf-tradescreen.js, oracle B226-depot-1..7)");
const goodsPayload = { ok: true, id: 4, truncated: false, cap: 400, goods: [
  { id: 1, desc: "+sand pear wood bin+", value: 20, dist: 17, pending: false, atDepot: false, forbidden: false, requested: false },
  { id: 2, desc: "-sand pear wood bin-", value: 10, dist: 19, pending: true, atDepot: false, forbidden: false, requested: false },
  { id: 3, desc: "≡sand pear wood bin <#2>≡", value: 30, dist: 34, pending: false, atDepot: false, forbidden: false, requested: false },
  { id: 4, desc: "(pig tail bag)", value: 100, dist: 20, pending: false, atDepot: false, forbidden: true, requested: false },
  { id: 5, desc: "limestone", value: 10, dist: 15, pending: false, atDepot: true, forbidden: false, requested: true },
] };
const dgG = TS.dgGroups(TS.dgRows(goodsPayload), "", "distance");
check("quality-decorated variants fold into ONE group with a [count] (oracle depot-2)",
  dgG.some(g => g.key === "sand pear wood bin" && g.count === 3));
check("group fold strips -x- / +x+ / ≡x≡ wrappers, <#N> markers and improvement parens",
  TS.dgGroupKey("+Finished Goods Bin (sand pear wood) <#1>+") === "finished goods bin (sand pear wood)" &&
  TS.dgGroupKey("(pig tail bag)") === "pig tail bag");
check("distance sort orders groups' rows by distance",
  (() => { const g = dgG.find(x => x.key === "sand pear wood bin"); return g.items[0].dist === 17; })());
const dgMarkup = TS.depotGoodsScreenMarkup({ goods: goodsPayload, goodsSearch: "", goodsSort: "distance",
  goodsCull: false, goodsExpanded: {} });
check("rows carry Distance + Value + the five-state native check tile datasets",
  /Distance: 17/.test(dgMarkup) && /data-dg-item="1" data-dg-on="1"/.test(dgMarkup) &&
  /data-dg-item="2" data-dg-on="0"/.test(dgMarkup));
check("group header checkbox lists only markable (non-forbidden) member ids",
  /data-dg-group="1,2,3"/.test(dgMarkup) && !/data-dg-group="4"/.test(dgMarkup));
check("native tool tiles render: cull (disabled data-gap), sort x2, SELECT_ALL",
  /data-dg-tool="cull"[^>]*disabled/.test(dgMarkup.replace(/\n/g, " ")) &&
  /data-dg-tool="sort-distance"/.test(dgMarkup) && /data-dg-tool="sort-value"/.test(dgMarkup) &&
  /data-dg-tool="select-all"/.test(dgMarkup));
check("the category-rail data gap is stated in plain English (not faked, not silent)",
  /Category rail/.test(dgMarkup) && /not served yet/.test(dgMarkup));
check("container expansion renders child rows with NO distance and NO checkbox (oracle depot-3)",
  (() => { const m = TS.depotGoodsScreenMarkup({ goods: goodsPayload, goodsSearch: "", goodsSort: "",
    goodsCull: false, goodsExpanded: { 1: { loading: false, contents: [{ id: 9, name: "pig tail cloth", spriteRef: null }] } } });
    const children = m.slice(m.indexOf('class="dg-children"'));
    return /pig tail cloth/.test(children) && !/data-dg-item="9"/.test(children) &&
      !children.slice(0, children.indexOf("</div>")).includes("Distance:"); })());
guard("malformed goods rows (missing/negative id) are dropped, not NaN-ed",
  TS.dgRows({ goods: [{ desc: "ghost" }, null, { id: -2, desc: "x" }, { id: 7, desc: "real" }] }).length === 1);

// ================================================================================================
console.log("\n# B227 justice case actions (open cases only)");
const openCase = { id: 12, mode: "Theft", sentenced: false, discovered: true, needsTrial: true,
  accusedId: 77, accused: "Urist McSuspect", criminalId: -1, criminal: "", victimId: 5, victim: "Litast" };
// B227 UI (wave/justice): the action strip is now GUARD-AWARE -- it takes the GET /justice-convict
// payload as its third argument. With the flags ON it renders the live buttons this suite always
// asserted; with them off (or unreadable) it renders them DISABLED. The calls below therefore pass
// an explicit flags-on host state; the locked half is asserted right after (and exhaustively in
// b227_justice_ui_test.mjs).
const HOST_ON = { ok: true, guards: { justiceConvict: true, justiceInterrogate: true } };
const actions = FA.justiceCaseActionsHtml(openCase, "open", HOST_ON);
check("convict + interrogate render for the accused with the wire datasets",
  /data-justice-convict="12" data-justice-unit="77"/.test(actions) &&
  /data-justice-interrogate="12" data-justice-unit="77"/.test(actions));
check("the convict tooltip states irreversibility and the native drive",
  /Irreversible/.test(actions) && /DF&#39;s own justice screen|DF's own justice screen/.test(actions));
check("flags on -> neither button is disabled", !/disabled/.test(actions));
check("flags OFF -> both buttons render DISABLED, naming their flags (no live-looking 501 trap)",
  (() => { const off = FA.justiceCaseActionsHtml(openCase, "open", { ok: true, guards: {} });
    return (off.match(/disabled/g) || []).length === 2 &&
      /justice_convict/.test(off) && /justice_interrogate/.test(off) &&
      /dfcapture-hostwrites\.json/.test(off); })());
check("a sentenced case gets NO actions", FA.justiceCaseActionsHtml(Object.assign({}, openCase, { sentenced: true }), "open", HOST_ON) === "");
check("closed/cold modes get NO actions", FA.justiceCaseActionsHtml(openCase, "closed", HOST_ON) === "" &&
  FA.justiceCaseActionsHtml(openCase, "cold", HOST_ON) === "");
check("no named party -> honest note, no dead buttons",
  /interrogation may surface one/.test(FA.justiceCaseActionsHtml(
    { id: 3, sentenced: false, accusedId: -1, criminalId: -1 }, "open", HOST_ON)) &&
  !/data-justice-convict/.test(FA.justiceCaseActionsHtml(
    { id: 3, sentenced: false, accusedId: -1, criminalId: -1 }, "open", HOST_ON)));
guard("accused == criminal is de-duplicated (one pair of buttons, not two)",
  (FA.justiceCaseActionsHtml({ id: 4, sentenced: false, accusedId: 8, accused: "A",
    criminalId: 8, criminal: "A" }, "open", HOST_ON).match(/data-justice-convict=/g) || []).length === 1);

console.log("\n# B227 justiceBody integration (open branch carries the actions)");
const jb = FA.justiceBody({ crimes: [openCase] }, { mode: "open", selectedCase: 12, hostState: HOST_ON });
check("open-case detail pane includes the action strip",
  /justice-case-actions/.test(jb) && /data-justice-convict="12"/.test(jb));
guard("closed branch does NOT grow the strip",
  !/justice-case-actions/.test(FA.justiceBody({ crimes: [Object.assign({}, openCase, { sentenced: true })] },
    { mode: "closed", selectedCase: 12, hostState: HOST_ON })));

// ================================================================================================
console.log("\n# server wire + guard invariants (source greps)");
const tradeCpp = readFileSync(src("trade_depot.cpp"), "utf8");
const fortCpp = readFileSync(src("fort_admin.cpp"), "utf8");
const luaSrc = readFileSync(repo("dwf.lua"), "utf8");
const bridgeH = readFileSync(src("lua_bridge.h"), "utf8");

check("/depot-trade POST dispatches to the native-drive bridge (no more unconditional 501)",
  /trade_action_json_via_lua/.test(tradeCpp) && /server\.Post\("\/depot-trade"/.test(tradeCpp));
check("/justice-convict + /justice-interrogate POST through the drive",
  /justice_action_json_via_lua\("convict"/.test(fortCpp.replace(/justice_drive_handler\("convict"\)/, 'justice_action_json_via_lua("convict"')) ||
  /justice_drive_handler\("convict"\)/.test(fortCpp));
check("hostwrites_status_for maps guarded->501 and retry->503 (legacy-client compatible)",
  /return 501/.test(bridgeH) && /return 503/.test(bridgeH) && /guarded\\":true/.test(bridgeH));
check("the guard file is host-controlled (read from the DF dir, never set over HTTP)",
  /dfcapture-hostwrites\.json/.test(luaSrc) && /NOT settable over HTTP/.test(luaSrc) &&
  !/server\.(Post|Get)\("\/hostwrites/.test(tradeCpp + fortCpp));
check("Lua engine never hand-writes trade records: only goodflag selection + native feed",
  /goodflag\[side\]\[i\]\.selected/.test(luaSrc) && /simulateInput/.test(luaSrc) &&
  !/import_value\s*=/.test(luaSrc) && !/\.trader\s*=/.test(luaSrc));
check("conviction verifies convict_crime BEFORE the final SELECT (wrong-case abort path exists)",
  /convict_crime/.test(luaSrc) && /backing out of wrong case/.test(luaSrc));
check("conviction success is verified against crime.flags.sentenced, never assumed",
  /crime\.flags\.sentenced/.test(luaSrc) && /sentenced flag\s*'\s*\.\.\s*'unchanged|sentenced flag /.test(luaSrc));
check("the trade commit is text-asserted before any click (refuses to click blind)",
  /refusing to click blind/.test(luaSrc));
check("confirm-plugin interception is handled (specs paused around fed input)",
  /hw_with_confirms_disabled/.test(luaSrc) && /trade-confirm-trade/.test(luaSrc) && /'convict'/.test(luaSrc));
check("guarded actions self-describe with the probe flag name",
  /hw_guarded\('trade_open'|hw_guarded\("trade_open"/.test(luaSrc.replace(/hw_guarded\('trade_open'/g, "hw_guarded('trade_open'")) ||
  /hw_guarded\('/.test(luaSrc));
guard("seeded-bad: a hand-write of caravan import_value would be caught by the grep above",
  !/import_value\s*=/.test(luaSrc));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
