// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// B64/B04/B80/B205/B208 fixture coverage: cache ordering, authoritative tile-occupant refinement,
// real-id item routing, old-host fallback, single-click bypass, the retained chooser machinery,
// AND the B208 top-first behaviour -- a multi-occupant click opens the TOP-layer occupant's sheet
// immediately (no chooser LIST step) and exposes the other occupants as an occupant tab strip.
// No browser or Dwarf Fortress process is required.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const DWFUI = require(path.join(root, "web/js/dwf-ui-components.js"));
const cyclePath = path.join(root, "web/js/dwf-unitcycle.js");
const controlsPath = path.join(root, "web/js/dwf-controls-placement.js");
const componentsPath = path.join(root, "web/js/dwf-ui-components.js");
const source = fs.readFileSync(cyclePath, "utf8");
const controls = fs.readFileSync(controlsPath, "utf8");
const components = fs.readFileSync(componentsPath, "utf8");

// Descendant-class lookup for the fake DOM: mirrors querySelector('.cls') closely enough to prove
// the occupant strip is injected with the DWFUI markup we expect.
function findByClass(node, cls) {
  for (const c of node.children || []) {
    if (c && typeof c.className === "string" && c.className.split(/\s+/).includes(cls)) return c;
    const nested = findByClass(c, cls);
    if (nested) return nested;
  }
  return null;
}
function fakeElement(tag = "div") {
  const el = { tag, children: [], className: "", style: {}, listeners: {}, disabled: false,
    parentNode: null, _html: "" };
  let text = "";
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set: value => { text = String(value); if (text === "") el.children = []; },
  });
  Object.defineProperty(el, "innerHTML", { get: () => el._html, set: v => { el._html = String(v); } });
  Object.defineProperty(el, "firstChild", { get: () => el.children[0] || null });
  el.classList = {
    contains: name => el.className.split(/\s+/).includes(name),
    add: name => { if (!el.className.split(/\s+/).includes(name)) el.className = `${el.className} ${name}`.trim(); },
    remove: name => { el.className = el.className.split(/\s+/).filter(part => part && part !== name).join(" "); },
  };
  el.appendChild = child => { child.parentNode = el; el.children.push(child); return child; };
  el.insertBefore = (node, ref) => {
    node.parentNode = el;
    const i = ref ? el.children.indexOf(ref) : -1;
    if (i < 0) el.children.unshift(node); else el.children.splice(i, 0, node);
    return node;
  };
  el.removeChild = child => {
    const i = el.children.indexOf(child);
    if (i >= 0) el.children.splice(i, 1);
    child.parentNode = null; return child;
  };
  el.addEventListener = (name, fn) => { el.listeners[name] = fn; };
  el.getAttribute = () => null;
  el.querySelectorAll = () => [];
  el.querySelector = sel => findByClass(el, String(sel).replace(/^\./, ""));
  return el;
}
const selection = fakeElement("selection");
const documentStub = {
  readyState: "complete",
  head: { appendChild() {} },
  documentElement: { appendChild() {} },
  createElement(tag) { return fakeElement(tag); },
  getElementById(id) { return id === "selection" ? selection : null; },
  addEventListener() {},
};
const sandbox = { window: null, document: documentStub, location: { search: "" },
  DWFUI,
  localStorage: { getItem: () => "" }, URLSearchParams, Date, Number, String, Array, Object,
  isFinite, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
// Load the REAL DWFUI first so the occupant strip is built by the shared factory, exactly as in
// production (index.html loads dwf-ui-components.js before everything else).
vm.runInContext(components, sandbox, { filename: componentsPath });
assert.ok(sandbox.DWFUI && typeof sandbox.DWFUI.tabsHtml === "function", "real DWFUI must load");
vm.runInContext(source, sandbox, { filename: cyclePath });
const api = sandbox.DFTileList;
assert.ok(api, "tile-list API must be exposed by the already-loaded WT08 module");

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + "\n" + (err.stack || err)); }
}
async function flushRoute() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
function chooserRows() {
  return selection.children[0].children.filter(child => child.tag === "button");
}
// A fetch stub that answers the async /unit open with a harmless unit and lets a caller supply the
// /tile-occupants payload (or 404). Keeps the top-first open path from throwing while we assert.
function fetchStub(occupantsPayloadOrNull) {
  return async request => {
    if (/\/unit\?/.test(request)) {
      const id = Number((/id=(\d+)/.exec(request) || [])[1]);
      unitFetches.push(id);
      return { ok: true, json: async () => ({ unit: { id, name: "u" + id } }) };
    }
    tileOccupantsUrl = request;
    if (occupantsPayloadOrNull == null) return { ok: false, status: 404 };
    return { ok: true, json: async () => occupantsPayloadOrNull };
  };
}
let unitFetches = [];
let tileOccupantsUrl = "";

const workshopHit = { kind: "workshop", title: "Mason workshop", buildingId: 41,
  itemId: -1, tile: { x: 10, y: 20, z: 150 } };
const crowdedLatest = { origin: { x: 0, y: 0, z: 150 }, width: 40, height: 30,
  units: [
    { id: 9, name: "Zuglar", x: 10, y: 20, z: 150 },
    { id: 4, name: "Urist", x: 10, y: 20, z: 150 },
    { id: 99, name: "Elsewhere", x: 11, y: 20, z: 150 },
  ],
  buildings: [{ type: "Workshop", x1: 10, y1: 20, x2: 10, y2: 20, z: 150 }],
  tiles: Array.from({ length: 1200 }, () => null),
};
crowdedLatest.tiles[810] = { item: { type: "BAR" } };

// ---- buildCandidates: ordering + B205 no-placeholder (unchanged by B208) ---------------------

await check("multi-occupant cache list orders units then building; the id-less item tail is invisible", () => {
  const rows = api.buildCandidates(workshopHit, crowdedLatest);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r => [r.kind, r.id ?? null]))), [
    ["unit", 4], ["unit", 9], ["workshop", 41],
  ]);
  assert.equal(rows[0].label, "Urist");
  assert.ok(rows.every(r => !r.disabled), "no disabled placeholder row is ever produced");
});

// ---- B208: top-first open + occupant tab strip ------------------------------------------------

await check("B208: multi-occupant click opens the top-layer occupant's sheet directly (no chooser list)", async () => {
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  sandbox.showUnitSheet = () => {};
  unitFetches = []; tileOccupantsUrl = "";
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  selection.className = "";
  assert.equal(api.consumeInspect(workshopHit, { x: 10, y: 20, w: 40, h: 30 }), true);
  // No chooser LIST is rendered; #selection is NOT put into the tile-list-panel state.
  assert.notEqual(selection.className, "visible tile-list-panel");
  await flushRoute();
  // The cache TOP layer opened immediately: unit outranks the workshop, and unit 4 (Urist) is the
  // lowest-id unit -> ordering rule unit > building/workshop/stockpile/zone > item, then id.
  assert.equal(unitFetches[0], 4, "the top-layer occupant (unit 4) opened first");
  const sess = api.getOccupantSession();
  assert.ok(sess, "an occupant session is established");
  assert.equal(sess.activeKey, "unit:4");
  assert.deepEqual(JSON.parse(JSON.stringify(sess.candidates.map(c => c.kind + ":" + c.id))), ["unit:4", "unit:9", "workshop:41"]);
});

await check("B208: occupant tab strip config lists occupants in priority order, active = shown", () => {
  const session = { candidates: [
    { kind: "unit", id: 4, label: "Urist", icon: "@" },
    { kind: "unit", id: 9, label: "Zuglar", icon: "@" },
    { kind: "workshop", id: 41, label: "Mason workshop", icon: "#" },
  ], activeKey: "unit:4" };
  const cfg = api.occupantTabsCfg(session);
  assert.equal(cfg.dataAttr, "occupant-tab");
  assert.equal(cfg.active, "unit:4");
  assert.deepEqual(cfg.tabs.map(t => t.key), ["unit:4", "unit:9", "workshop:41"]);
  assert.deepEqual(cfg.tabs.map(t => t.title), ["Urist", "Zuglar", "Mason workshop"]);
  assert.ok(cfg.tabs.every(t => !Object.hasOwn(t, "label")), "native rail is icon-only");
});

await check("B208: occupant strip renders through DWFUI.occupantRailHtml outside the open sheet content", () => {
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  sandbox.showUnitSheet = () => {};
  unitFetches = [];
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  api.consumeInspect(workshopHit, { x: 10, y: 20, w: 40, h: 30 });   // session set synchronously
  // Mount a visible unit sheet for the active occupant (unit 4) and inject the strip.
  sandbox.selectedUnitData = { unit: { id: 4, name: "Urist" }, tile: { x: 10, y: 20, z: 150 } };
  selection.textContent = "";
  selection.className = "visible unit-sheet-panel";
  selection._html = "";
  api.injectOccupantTabs();
  const wrap = selection.querySelector(".occupant-tabs-wrap");
  assert.ok(wrap, "a strip wrap is injected into the open sheet");
  assert.ok(selection.classList.contains("has-occupant-rail"),
    "the host reserves the outside rail width so the viewport cannot clip it");
  const html = wrap.innerHTML;
  assert.match(html, /role="tablist"/, "built by the shared DWFUI factory, not hand-rolled");
  assert.match(html, /data-occupant-tab="unit:4"/);
  assert.match(html, /data-occupant-tab="unit:9"/);
  assert.match(html, /data-occupant-tab="workshop:41"/);
  assert.ok(html.indexOf("unit:4") < html.indexOf("unit:9") &&
    html.indexOf("unit:9") < html.indexOf("workshop:41"), "priority order preserved in markup");
  assert.match(html, /class="dwfui-occupant-tab active"[^>]*data-occupant-tab="unit:4"/,
    "the shown occupant's tab is the active one");
  sandbox.selectedUnitData = undefined;
});

await check("B208: switching to an occupant tab opens that occupant and updates the active tab", async () => {
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  sandbox.showUnitSheet = () => {};
  let placeOpen = null;
  sandbox.openInfoPlace = (kind, id) => { placeOpen = [kind, id]; };
  unitFetches = [];
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  api.consumeInspect(workshopHit, { x: 10, y: 20, w: 40, h: 30 });   // opens unit 4, session set
  await flushRoute();
  const wsCand = api.getOccupantSession().candidates.find(c => c.kind === "workshop");
  api.switchToOccupant(wsCand);
  assert.deepEqual(placeOpen, ["workshop", 41], "the tab click opened the workshop occupant");
  assert.equal(api.getOccupantSession().activeKey, "workshop:41", "active tab follows the switch");
  sandbox.openInfoPlace = undefined;
});

await check("B208: authoritative /tile-occupants refines the occupant strip to native display order", async () => {
  const routeRows = [
    { kind: "unit", id: 9, name: "Zuglar" },
    { kind: "unit", id: 4, name: "Urist" },
    { kind: "workshop", id: 41, name: "Mason workshop" },
    { kind: "item", id: 73, name: "copper battle axe" },
    { kind: "item", id: 72, name: "dwarf corpse" },
  ];
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  sandbox.showUnitSheet = () => {};
  unitFetches = []; tileOccupantsUrl = "";
  sandbox.fetch = fetchStub({ occupants: routeRows });
  api.clearOccupantSession();
  assert.equal(api.consumeInspect(workshopHit, { x: 10, y: 20, w: 40, h: 30 }), true);
  await flushRoute();
  assert.match(tileOccupantsUrl, /^\/tile-occupants\?player=&px=10&py=20&w=40&h=30&/);
  const sess = api.getOccupantSession();
  assert.deepEqual(JSON.parse(JSON.stringify(sess.candidates.map(c => [c.kind, c.id]))), [
    ["unit", 9], ["unit", 4], ["workshop", 41], ["item", 73], ["item", 72],
  ]);
  // The already-open occupant (cache top, unit 4) survives the refine -> no jarring re-open.
  assert.equal(sess.activeKey, "unit:4");
  assert.deepEqual(unitFetches, [4], "only the initial cache-top open fetched a unit; no re-open");
});

await check("B208: old-host 404 (no /tile-occupants) leaves the cache-derived occupant session intact", async () => {
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  sandbox.showUnitSheet = () => {};
  unitFetches = [];
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  assert.equal(api.consumeInspect(workshopHit, { x: 10, y: 20, w: 40, h: 30 }), true);
  await flushRoute();
  const sess = api.getOccupantSession();
  assert.deepEqual(JSON.parse(JSON.stringify(sess.candidates.map(c => c.kind + ":" + c.id))), ["unit:4", "unit:9", "workshop:41"]);
  assert.equal(sess.activeKey, "unit:4");
  assert.ok(sess.candidates.every(c => !c.disabled && !/host update needed/.test(String(c.label || ""))),
    "no dead placeholder survives the old-host fallback");
});

await check("B208 test-the-test: malformed route rows never replace the cache-derived occupant session", async () => {
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  sandbox.showUnitSheet = () => {};
  unitFetches = [];
  sandbox.fetch = fetchStub({ occupants: [
    { kind: "item", id: -1, name: "bad" }, { kind: "unknown", id: 7, name: "bad" },
  ] });
  api.clearOccupantSession();
  assert.equal(api.consumeInspect(workshopHit, { x: 10, y: 20, w: 40, h: 30 }), true);
  await flushRoute();
  const sess = api.getOccupantSession();
  assert.deepEqual(JSON.parse(JSON.stringify(sess.candidates.map(c => c.kind + ":" + c.id))), ["unit:4", "unit:9", "workshop:41"],
    "a sub-2 authoritative list (all malformed) never overwrites the cache session");
});

// ---- B208 REOPEN: item-on-stockpile click-precedence ------------------------------------------
// The round-1 top-first fix opened candidates[0], and BOTH ordering sources (buildCandidates' rank
// and the server /tile-occupants construction order) list a stockpile BEFORE the item resting on
// it. So an item click opened the STOCKPILE screen. Native DF opens the ITEM sheet (it carries its
// own "view stockpile" section); the floor DESIGNATION (stockpile/zone) is beneath the item and
// must never steal the click. Precedence for which occupant OPENS is distinct from the strip's
// native DISPLAY order (which stays units>buildings>stockpiles>items, pinned above and by B80).

// A stockpile floor (id 50) covering the tile, plus a loose item the click resolved (kind=item).
const stockpileItemLatest = { origin: { x: 0, y: 0, z: 150 }, width: 40, height: 30,
  units: [],
  buildings: [{ type: "Stockpile", id: 50, x1: 10, y1: 20, x2: 10, y2: 20, z: 150 }],
  tiles: Array.from({ length: 1200 }, () => null),
};
const itemOnStockpileHit = { kind: "item", title: "copper bar", itemId: 88, buildingId: -1,
  tile: { x: 10, y: 20, z: 150 } };

await check("B208-REOPEN: cache list of an item on a stockpile is [stockpile, item] (native display order)", () => {
  const rows = api.buildCandidates(itemOnStockpileHit, stockpileItemLatest);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r => [r.kind, r.id]))), [
    ["stockpile", 50], ["item", 88],
  ], "strip DISPLAY order stays native: the floor designation is listed before the item");
});

await check("B208-REOPEN: clicking an item on a stockpile opens the ITEM sheet, not the stockpile screen", async () => {
  sandbox.DwfTiles = { getLatest: () => stockpileItemLatest };
  sandbox.showUnitSheet = () => {};
  let placeOpen = null, itemOpen = null;
  sandbox.openInfoPlace = (kind, id) => { placeOpen = [kind, id]; };
  sandbox.openItemPanel = (id) => { itemOpen = id; };
  sandbox.closeClientPanel = () => {};
  sandbox.closeSelection = () => {};
  unitFetches = []; tileOccupantsUrl = "";
  sandbox.fetch = fetchStub(null);   // no /tile-occupants refine: prove the CACHE top-open is correct
  api.clearOccupantSession();
  assert.equal(api.consumeInspect(itemOnStockpileHit, { x: 10, y: 20, w: 40, h: 30 }), true,
    "two occupants -> the multi-occupant top-first path runs");
  await flushRoute();
  assert.equal(itemOpen, 88, "the ITEM sheet opened (item outranks the stockpile floor beneath it)");
  assert.equal(placeOpen, null, "the stockpile place-panel must NOT open -- it may not steal item clicks");
  const sess = api.getOccupantSession();
  assert.ok(sess, "an occupant session is established");
  assert.equal(sess.activeKey, "item:88", "the item is the active (shown) occupant");
  // The strip still lists occupants in native display order; the active one is keyed, not first.
  assert.deepEqual(JSON.parse(JSON.stringify(sess.candidates.map(c => c.kind + ":" + c.id))),
    ["stockpile:50", "item:88"], "strip DISPLAY order preserved (stockpile listed first, item active)");
  sandbox.openInfoPlace = undefined; sandbox.openItemPanel = undefined;
  sandbox.closeClientPanel = undefined; sandbox.closeSelection = undefined;
});

await check("B208-REOPEN: authoritative refine keeps the item shown when a stockpile precedes it", async () => {
  // Server /tile-occupants returns native construction order: designation (stockpile) BEFORE item.
  const routeRows = [
    { kind: "stockpile", id: 50, name: "Bar stockpile" },
    { kind: "item", id: 88, name: "copper bar" },
    { kind: "item", id: 89, name: "iron bar" },
  ];
  sandbox.DwfTiles = { getLatest: () => stockpileItemLatest };
  sandbox.showUnitSheet = () => {};
  let placeOpen = null, itemOpen = null;
  sandbox.openInfoPlace = (kind, id) => { placeOpen = [kind, id]; };
  sandbox.openItemPanel = (id) => { itemOpen = id; };
  sandbox.closeClientPanel = () => {};
  sandbox.closeSelection = () => {};
  unitFetches = []; tileOccupantsUrl = "";
  sandbox.fetch = fetchStub({ occupants: routeRows });
  api.clearOccupantSession();
  assert.equal(api.consumeInspect(itemOnStockpileHit, { x: 10, y: 20, w: 40, h: 30 }), true);
  await flushRoute();
  const sess = api.getOccupantSession();
  // Refined to authoritative native display order (stockpile first), but the ITEM stays active.
  assert.deepEqual(JSON.parse(JSON.stringify(sess.candidates.map(c => [c.kind, c.id]))), [
    ["stockpile", 50], ["item", 88], ["item", 89],
  ], "authoritative native display order adopted for the strip");
  assert.equal(sess.activeKey, "item:88", "the item stays shown through the refine; stockpile never steals it");
  assert.equal(placeOpen, null, "no stockpile place-panel opened at any point");
  sandbox.openInfoPlace = undefined; sandbox.openItemPanel = undefined;
  sandbox.closeClientPanel = undefined; sandbox.closeSelection = undefined;
});

// ---- B219: the multi-occupant selector RAIL must appear for item-top sessions too -------------
// Round 1 gave only the UNIT sheet the overflow:visible escape hatch, so the rail (a child placed
// just outside the panel's right edge) was clipped invisible on the item sheet (overflow:hidden)
// and place panels (overflow:auto). With B208 now opening the ITEM as the top occupant, the item
// host is the common path -- and without a visible rail there is no way to reach the other
// occupants. The strip is still built by the shared DWFUI.occupantRailHtml factory (DWFUI mandate).

await check("B219: a multi-occupant click with an ITEM on top injects the rail on the item sheet host", async () => {
  sandbox.DwfTiles = { getLatest: () => stockpileItemLatest };
  sandbox.showUnitSheet = () => {};
  sandbox.openItemPanel = () => {};          // openRoute -> item flow; DOM mounted manually below
  sandbox.openInfoPlace = () => {};
  sandbox.closeClientPanel = () => {};
  sandbox.closeSelection = () => {};
  unitFetches = [];
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  api.consumeInspect(itemOnStockpileHit, { x: 10, y: 20, w: 40, h: 30 });   // active = item:88
  assert.equal(api.getOccupantSession().activeKey, "item:88");
  // Mount the item sheet on #selection exactly as showStockItemSheet does (visible stock-item-panel
  // + the B224 identity stamp the shown-content guard reads).
  selection.textContent = "";
  selection.className = "visible stock-item-panel";
  selection.dataset = { dfcItemId: "88" };
  selection._html = "";
  api.injectOccupantTabs();
  const wrap = selection.querySelector(".occupant-tabs-wrap");
  assert.ok(wrap, "the occupant rail is injected onto the ITEM sheet host, not only the unit sheet");
  assert.ok(selection.classList.contains("has-occupant-rail"),
    "the item host reserves the outside rail gutter so the rail is not clipped");
  const html = wrap.innerHTML;
  assert.match(html, /role="tablist"/, "built by the shared DWFUI factory, not hand-rolled");
  assert.match(html, /data-occupant-tab="item:88"/, "the top (item) occupant has a rail tab");
  assert.match(html, /data-occupant-tab="stockpile:50"/,
    "the NON-top occupant (the stockpile) is reachable from the rail -- the B219 defect");
  assert.match(html, /class="dwfui-occupant-tab active"[^>]*data-occupant-tab="item:88"/,
    "the shown (item) occupant's tab is the active one");
  sandbox.openItemPanel = undefined; sandbox.openInfoPlace = undefined;
  sandbox.closeClientPanel = undefined; sandbox.closeSelection = undefined;
});

await check("B219: the non-top occupant is selectable from the rail (item-top session -> open the stockpile)", async () => {
  sandbox.DwfTiles = { getLatest: () => stockpileItemLatest };
  sandbox.showUnitSheet = () => {};
  let placeOpen = null;
  sandbox.openItemPanel = () => {};
  sandbox.openInfoPlace = (kind, id) => { placeOpen = [kind, id]; };
  sandbox.closeClientPanel = () => {};
  sandbox.closeSelection = () => {};
  unitFetches = [];
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  api.consumeInspect(itemOnStockpileHit, { x: 10, y: 20, w: 40, h: 30 });
  const spCand = api.getOccupantSession().candidates.find(c => c.kind === "stockpile");
  assert.ok(spCand, "the stockpile is present in the occupant session as a selectable candidate");
  api.switchToOccupant(spCand);
  assert.deepEqual(placeOpen, ["stockpile", 50], "selecting the rail's stockpile tab opens the stockpile screen");
  assert.equal(api.getOccupantSession().activeKey, "stockpile:50", "the active tab follows the selection");
  sandbox.openItemPanel = undefined; sandbox.openInfoPlace = undefined;
  sandbox.closeClientPanel = undefined; sandbox.closeSelection = undefined;
});

await check("B219/B224: ONE clip-escape hatch rides has-occupant-rail on #selection; the dead #clientPanel half is gone", () => {
  const css = fs.readFileSync(path.join(root, "web/css/dwf.css"), "utf8");
  // B224 generalized B219's per-variant grants: every occupant sheet (unit/item/place) renders into
  // #selection, so the un-clip + the narrow-viewport width cap ride the marker class itself.
  // B224 REOPEN r2: the selector is DOUBLED (#selection#selection, specificity (2,1,0)) so it
  // outranks `#selection.visible.pf-fill-host { overflow:hidden }` and every other single-id
  // variant rule; the single-id form silently lost that cascade and painted no rail at all.
  // siderail_paint_clip_test computes the actual cascade winner; this pin records the shape.
  assert.match(css, /#selection#selection\.has-occupant-rail \{\s*overflow:visible;\s*max-width:calc\(100vw - 24px - 34px \* var\(--dwfui-interface-scale\)\);\s*\}/,
    "the occupant-rail host must un-clip (and keep the outside gutter on-screen) for EVERY sheet variant, outranking the pf-fill-host clip");
  // The right-docked unit sheet still reserves the rail gutter at the screen edge.
  assert.match(css, /#selection\.unit-sheet-panel\.has-occupant-rail \{\s*right:calc\(12px \+ 32px \* var\(--dwfui-interface-scale\)\);/,
    "the unit sheet must shift left to reserve the outside rail gutter");
  // B219's #clientPanel escape hatch targeted a host that place panels never render into
  // (openBuildingPanel/openWorkshopPanel/openZonePanel/openStockpilePanel all write #selection);
  // pin its REMOVAL so the dead geometry cannot resurface and mislead the next reader.
  assert.equal(/#clientPanel\.has-occupant-rail/.test(css), false,
    "#clientPanel is not an occupant host; its rail rules must stay deleted");
});

await check("B208-REOPEN / B164 guard: a LONE stockpile is one candidate -> one-click place-panel, no session", () => {
  const loneStockpileHit = { kind: "stockpile", title: "Bar stockpile", itemId: -1, buildingId: 50,
    tile: { x: 10, y: 20, z: 150 } };
  const loneStockpileLatest = { origin: { x: 0, y: 0, z: 150 }, width: 40, height: 30, units: [],
    buildings: [{ type: "Stockpile", id: 50, x1: 10, y1: 20, x2: 10, y2: 20, z: 150 }],
    tiles: Array.from({ length: 1200 }, () => null) };
  const rows = api.buildCandidates(loneStockpileHit, loneStockpileLatest);
  assert.equal(rows.length, 1, "the cache stockpile and the /inspect buildingId dedupe to ONE candidate");
  assert.equal(rows[0].kind, "stockpile");
  sandbox.DwfTiles = { getLatest: () => loneStockpileLatest };
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  assert.equal(api.consumeInspect(loneStockpileHit, { x: 10, y: 20, w: 40, h: 30 }), false,
    "single occupant bypasses the top-first path -> the caller's normal one-click selection opens it (B164)");
  assert.equal(api.getOccupantSession(), null, "no occupant session for a lone stockpile");
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
});

// ---- retained chooser machinery (still reachable directly) ------------------------------------

await check("chooser machinery is retained: renderChooser + real item id routing still work", () => {
  let opened = -1;
  sandbox.openItemPanel = id => { opened = id; };
  selection.textContent = "";
  api.renderChooser(api.routeCandidates({ occupants: [{ kind: "item", id: 731, name: "dwarf corpse" }] }));
  const row = chooserRows()[0];
  row.listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(opened, 731);
});

// ---- single-occupant bypass + session clear ---------------------------------------------------

await check("single occupant bypasses the top-first path and clears any prior occupant session", () => {
  // A lingering session from a previous multi-click must be cleared by a single-occupant click.
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  sandbox.showUnitSheet = () => {};
  unitFetches = [];
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  api.consumeInspect(workshopHit, { x: 10, y: 20, w: 40, h: 30 });   // establishes a session
  assert.ok(api.getOccupantSession(), "a session exists after a multi-occupant click");

  const data = { kind: "unit", title: "Domas", itemId: -1, buildingId: -1,
    unit: { id: 12, name: "Domas" }, tile: { x: 3, y: 4, z: 150 }, unitCycle: [12] };
  const rows = api.buildCandidates(data, { units: [{ id: 12, name: "Domas", x: 3, y: 4, z: 150 }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "unit");
  sandbox.DwfTiles = { getLatest: () => ({ units: [{ id: 12, name: "Domas", x: 3, y: 4, z: 150 }],
    buildings: [], tiles: Array.from({ length: 1200 }, () => null) }) };
  assert.equal(api.consumeInspect(data, { x: 3, y: 4, w: 40, h: 30 }), false);
  assert.equal(api.getOccupantSession(), null, "single-occupant click clears the prior session");
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
});

// ---- B205: corpse/coffin duplicate-selector regression (buildCandidates; unchanged by B208) ---
function loneItemLatest(tail) {
  const l = { origin: { x: 0, y: 0, z: 150 }, width: 40, height: 30, units: [], buildings: [],
    tiles: Array.from({ length: 1200 }, () => null) };
  l.tiles[810] = { item: tail };   // x10 y20 -> 20*40+10
  return l;
}
const corpseHit = { kind: "item", title: "dwarf corpse", itemId: 72, buildingId: -1,
  tile: { x: 10, y: 20, z: 150 } };

await check("B205: lone corpse (skeletal bit ABSENT) is one entry -> top-first path is bypassed, no dead row", () => {
  const rows = api.buildCandidates(corpseHit, loneItemLatest({ type: "CORPSE" }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "item");
  assert.equal(rows[0].id, 72);
  assert.ok(!rows[0].disabled);
  sandbox.DwfTiles = { getLatest: () => loneItemLatest({ type: "CORPSE" }) };
  assert.equal(api.consumeInspect(corpseHit, { x: 10, y: 20, w: 40, h: 30 }), false);
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
});

await check("B205: lone corpse (skeletal bit PRESENT) is STILL one entry -> no second selector row", () => {
  const rows = api.buildCandidates(corpseHit, loneItemLatest({ type: "CORPSE", skeletal: true }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 72);
  assert.ok(!rows[0].disabled);
});

await check("B205 sweep: NO tail type ever yields a disabled '(host update needed)' selector row", () => {
  const tails = [
    { type: "CORPSE" }, { type: "CORPSE", skeletal: true }, { type: "COFFIN" }, { type: "BOX" },
    { type: "BAR" }, { type: "REMAINS" }, { type: "CORPSEPIECE" }, {},
  ];
  for (const tail of tails) {
    const latest = JSON.parse(JSON.stringify(crowdedLatest));
    latest.tiles = Array.from({ length: 1200 }, () => null);
    latest.tiles[810] = { item: tail };
    const rows = api.buildCandidates(workshopHit, latest);
    assert.ok(rows.every(r => !r.disabled),
      "tail " + JSON.stringify(tail) + " must not produce a disabled row");
    assert.ok(rows.every(r => !/host update needed/.test(String(r.label || ""))),
      "tail " + JSON.stringify(tail) + " must not produce host-update text");
  }
});

await check("B205: the '(host update needed)' placeholder string is absent from the selector module", () => {
  assert.ok(!/host update needed/.test(source),
    "the dead-placeholder label must not exist anywhere in dwf-unitcycle.js");
});

// ---- route helpers / delegation / docking (unchanged) -----------------------------------------

await check("row routes preserve existing unit/building/item selection flows", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(api.routeForCandidate({ kind: "unit", id: 7 }))), { flow: "unit", id: 7 });
  assert.deepEqual(JSON.parse(JSON.stringify(api.routeForCandidate({ kind: "workshop", id: 41 }))), { flow: "place", kind: "workshop", id: 41 });
  assert.deepEqual(JSON.parse(JSON.stringify(api.routeForCandidate({ kind: "item", id: 88 }))), { flow: "item", id: 88 });
  assert.equal(api.routeForCandidate({ kind: "item", id: -1 }), null);
});

await check("Tab and Shift+Tab wraparound index helper is retained", () => {
  assert.equal(api.nextChooserIndex(0, 4, 1), 1);
  assert.equal(api.nextChooserIndex(3, 4, 1), 0);
  assert.equal(api.nextChooserIndex(0, 4, -1), 3);
  assert.equal(api.nextChooserIndex(0, 0, 1), -1);
});

await check("inspect delegates only when the tile-list module consumes; single path remains", () => {
  assert.match(controls, /DFTileList[.]consumeInspect[(]data, pixel[)][)] return;[\s\S]*?showSelection[(]data[)];/);
});

await check("B142: chooser docks clear of the chat toggle and stacks above the bottom-left HUD", () => {
  const css = fs.readFileSync(path.join(root, "web/css/dwf.css"), "utf8");
  assert.match(css, /#selection\.tile-list-panel \{ bottom: 90px; z-index: 8990; \}/);
  const chat = fs.readFileSync(path.join(root, "web/js/dwf-chat.js"), "utf8");
  assert.match(chat, /#dfChatToggle\{position:fixed;left:8px;bottom:calc\(52px \+ var\(--dfvv-kb-inset, 0px\)\);z-index:8980/);
  assert.match(chat, /#dfChatPanel\{position:fixed;left:8px;bottom:calc\(52px \+ var\(--dfvv-kb-inset, 0px\)\);z-index:8981/);
});

// ---- WAVE-5 GATE C: the on-tile controls are DWFUI components -----------------------------------
// Asserted on EMITTED MARKUP. The occupant RAIL was already adopted (occupantRailHtml, pinned above);
// what this block pins is the two controls that were still hand-built beside it.

await check("the unit cycle bar is DWFUI's three-slice cycler, not a pair of glyph buttons", () => {
  const html = api.unitCycleMarkup(0, 3);
  // Native's prev/next is TYPE_FILTER_LEFT / _TEXT / _RIGHT -- all three verified in interface_map.json.
  assert.match(html, /class="dwfui-cycler/, "not built by DWFUI.cyclerHtml");
  assert.match(html, /data-dwfui-sprite="TYPE_FILTER_LEFT"/);
  assert.match(html, /data-dwfui-sprite="TYPE_FILTER_RIGHT"/);
  assert.match(html, /dwfui-bitmap-text/, "the n/N label must be bitmap text");
  // A glyph where a sprite exists is the defect this retires: the Unicode triangles must be gone.
  assert.equal(/◀|▶|&#9664;|&#9654;/.test(html), false, "a Unicode triangle survived");
  // THE WIRE IS THE CONTRACT: inject() and the Tab-key handler both look up [data-cyc] (-1 / +1).
  assert.match(html, /data-cyc="-1"/);
  assert.match(html, /data-cyc="1"/);
});

await check("the retained chooser resolves icons through iconHtml, never the identity-LETTER path", () => {
  // The chooser is a SUPERSET (off the live path since B208, still reachable via renderChooser) so it
  // is dressed, not deleted. Its icons used to be the literal letters '@' / '#' / '*'.
  const html = api.tileListMarkup([
    { kind: "unit", id: 4, label: "Urist", icon: "@" },
    { kind: "workshop", id: 41, label: "Mason workshop", icon: "#" },
  ]);
  assert.match(html, /class="dwfui-row[^"]*tile-list-row/, "rows must be DWFUI rows");
  assert.match(html, /data-tile-candidate="0"/, "the candidate wire must survive");
  const icons = html.slice(0, html.length);
  assert.equal(/>[@#*]</.test(icons), false, "an identity LETTER is still being rendered as the icon");
});

if (failed) process.exit(1);
console.log("tilelist_fixture_test: PASS");
