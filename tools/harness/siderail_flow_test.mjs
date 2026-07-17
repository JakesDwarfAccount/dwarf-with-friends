// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// B224 SIDERAIL-UX fixture coverage. The owner: "the multi item/unit select side rail do not work, they
// are missing sprites, when you click on one it doesnt keep the same side rail flow (all the side
// rail should stay in place so you can swap between the tabs)". Two pinned root causes:
//
//   PERSISTENCE -- (a) activeHostEl() mapped place kinds to #clientPanel, but ALL occupant sheets
//   (unit/item AND the four place panels) render into #selection, so selecting a place from the
//   rail injected it into a hidden panel; (b) every sheet render wipes the host's className
//   (taking `has-occupant-rail` with it) while the rail wrap SURVIVES as a .pf-content sibling --
//   and the old injector early-returned on "wrap exists", so after the FIRST tab switch the rail
//   sat in the DOM, CSS-clipped invisible, with a stale active tab ("when you click on the second
//   or third item the whole rail disappears so you cant go back").
//
//   SPRITES -- /tile-occupants shipped no art fields; place kinds rendered the fail-loud empty
//   tile unconditionally; and nobody ran DWFUI.paintSprites over the injected rail, so even
//   resolvable item icons stayed inert placeholders.
//
// The fixture drives the REAL dwf-unitcycle.js + REAL DWFUI in a fake DOM, with sheet-render
// stubs that do exactly what the production renderers do to #selection (className write + observer
// tick). Set SIDERAIL_MODULE=<path> to point at another module build (used once, manually, to
// prove these cells FAIL on the pre-B224 module -- test-the-test).
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
const cyclePath = process.env.SIDERAIL_MODULE || path.join(root, "web/js/dwf-unitcycle.js");
const componentsPath = path.join(root, "web/js/dwf-ui-components.js");
const source = fs.readFileSync(cyclePath, "utf8");
const components = fs.readFileSync(componentsPath, "utf8");
const infoPanelsSrc = fs.readFileSync(path.join(root, "web/js/dwf-build-info-panels.js"), "utf8");

// ---- fake DOM ---------------------------------------------------------------------------------
function findByClass(node, cls) {
  for (const c of node.children || []) {
    if (c && typeof c.className === "string" && c.className.split(/\s+/).includes(cls)) return c;
    const nested = findByClass(c, cls);
    if (nested) return nested;
  }
  return null;
}
function fakeElement(tag = "div") {
  const el = { tag, children: [], className: "", style: {}, listeners: {}, dataset: {},
    parentNode: null, _html: "", _attrs: {} };
  let text = "";
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set: value => { text = String(value); if (text === "") el.children = []; },
  });
  Object.defineProperty(el, "innerHTML", { get: () => el._html, set: v => { el._html = String(v); } });
  el.classList = {
    contains: name => el.className.split(/\s+/).includes(name),
    add: name => { if (!el.className.split(/\s+/).includes(name)) el.className = `${el.className} ${name}`.trim(); },
    remove: name => { el.className = el.className.split(/\s+/).filter(p => p && p !== name).join(" "); },
  };
  el.appendChild = child => { child.parentNode = el; el.children.push(child); return child; };
  el.removeChild = child => {
    const i = el.children.indexOf(child);
    if (i >= 0) el.children.splice(i, 1);
    child.parentNode = null; return child;
  };
  el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
  el.getAttribute = k => (k in el._attrs ? el._attrs[k] : null);
  el.addEventListener = (name, fn) => { el.listeners[name] = fn; };
  el.querySelectorAll = () => [];
  el.querySelector = sel => findByClass(el, String(sel).replace(/^\./, ""));
  return el;
}
const selection = fakeElement("selection");
const clientPanel = fakeElement("clientPanel");
const observers = [];          // { cb, target, opts } -- captured MutationObserver registrations
const keyHandlers = [];        // captured document-level keydown handlers
const documentStub = {
  readyState: "complete",
  head: { appendChild() {} },
  documentElement: { appendChild() {} },
  createElement(tag) { return fakeElement(tag); },
  getElementById(id) { return id === "selection" ? selection : id === "clientPanel" ? clientPanel : null; },
  addEventListener(name, fn) { if (name === "keydown") keyHandlers.push(fn); },
};
class MutationObserverStub {
  constructor(cb) { this.cb = cb; }
  observe(target, opts) { observers.push({ cb: this.cb, target, opts }); }
}
// The production renderers mutate #selection; the real MutationObserver then runs the injector.
// tick() is that observer turn: childList callbacks first, then the class-attribute callbacks.
function tick() {
  for (const o of observers) if (o.opts && o.opts.childList) o.cb();
  for (const o of observers) if (o.opts && o.opts.attributes) o.cb();
}
function pressTab(shiftKey, targetTag) {
  let prevented = false;
  const e = { key: "Tab", shiftKey: !!shiftKey, target: targetTag ? { tagName: targetTag } : null,
    preventDefault() { prevented = true; }, stopPropagation() {} };
  for (const fn of keyHandlers) fn(e);
  return prevented;
}

const sandbox = { window: null, document: documentStub, location: { search: "" },
  DWFUI, MutationObserver: MutationObserverStub,
  localStorage: { getItem: () => "" }, URLSearchParams, Date, Number, String, Array, Object,
  isFinite, JSON, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(components, sandbox, { filename: componentsPath });
assert.ok(sandbox.DWFUI && typeof sandbox.DWFUI.occupantRailHtml === "function", "real DWFUI must load");

// Wiring-shape stubs for the two build-info-panels PLAIN-SCRIPT GLOBALS the rail consumes for
// place art. Their real existence + shape is pinned statically below (the "plain-script globals"
// cell) so this stub cannot drift silently.
sandbox.infoPlaceIconMarkup = row => {
  if (row && row.iconSheet === "zone")
    return `<span class="info-place-icon zone-icon" style="background-position:-${row.iconX * 32}px -${row.iconY * 32}px"></span>`;
  if (row && row.iconKey)
    return `<span class="info-place-icon" data-icon-key="${row.iconKey}"></span>`;
  return "";
};
sandbox.itemIconName = item => (/mason/i.test(String(item && item.label || "")) ? "workshop_mason" : null);

vm.runInContext(source, sandbox, { filename: cyclePath });
const api = sandbox.DFTileList;
assert.ok(api, "DFTileList API must be exposed");

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + "\n" + (err.stack || err)); }
}
async function flushRoute() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

// ---- production-mimicking sheet renderers ------------------------------------------------------
// Each does to #selection exactly what its real counterpart does: className write (wiping
// has-occupant-rail), identity bookkeeping, then the observer turn.
let placeOpens = [];
let engravingOpens = [];
sandbox.showUnitSheet = d => {
  sandbox.selectedUnitData = d;
  selection.className = "visible unit-sheet-panel";
  tick();
};
sandbox.openItemPanel = (id) => {
  selection.className = "visible stock-item-panel";
  selection.dataset = { dfcItemId: String(id) };   // showStockItemSheet's B224 stamp
  tick();
};
sandbox.openInfoPlace = (kind, id) => {
  placeOpens.push([kind, id]);
  selection.className =
    kind === "stockpile" ? "visible stockpile-panel" :
    kind === "zone" ? "visible building-panel zone-panel" :
    kind === "workshop" ? "visible building-panel workshop-panel" : "visible building-panel";
  tick();
};
sandbox.openEngravingPanel = tile => {
  engravingOpens.push({ x: Number(tile.x), y: Number(tile.y), z: Number(tile.z) });
  selection.className = "visible";
  selection.children = [];
  const window = fakeElement("div");
  window.className = "engraving-window";
  selection.appendChild(window);
  tick();
};
function closeSelectionLikeProduction() {
  sandbox.selectedUnitData = null;
  selection.className = "";
  tick();
}

let unitFetches = [], occupantFetches = 0;
function fetchStub(occupantsPayloadOrNull) {
  return async request => {
    if (/\/unit\?/.test(request)) {
      const id = Number((/id=(\d+)/.exec(request) || [])[1]);
      unitFetches.push(id);
      return { ok: true, json: async () => ({ unit: { id, name: "u" + id }, tile: { x: 10, y: 20, z: 150 } }) };
    }
    occupantFetches++;
    if (occupantsPayloadOrNull == null) return { ok: false, status: 404 };
    return { ok: true, json: async () => occupantsPayloadOrNull };
  };
}

// The tile under test: a unit standing on furniture over an item in a stockpile -- one entry of
// every occupant family, in the server's native display order (units, buildings incl. the
// designation, then items). This is the "corpse pile / item on stockpile / unit on furniture"
// crowd from the brief collapsed into one worst-case tile.
const fourKindRows = [
  { kind: "unit", id: 4, name: "Urist" },
  { kind: "workshop", id: 41, name: "Mason workshop", icon: { sheet: "building", key: "workshop_mason" } },
  { kind: "stockpile", id: 50, name: "Bar stockpile", spriteToken: "STOCKPILE_ICON_BARS" },
  { kind: "item", id: 88, name: "copper bar",
    spriteRef: { itemType: "BAR", itemSubtype: -1, materialType: 27, materialIndex: 3 } },
];
const crowdedLatest = { origin: { x: 0, y: 0, z: 150 }, width: 40, height: 30,
  units: [{ id: 4, name: "Urist", x: 10, y: 20, z: 150 }],
  buildings: [
    { type: "Workshop", id: 41, x1: 10, y1: 20, x2: 10, y2: 20, z: 150 },
    { type: "Stockpile", id: 50, x1: 10, y1: 20, x2: 10, y2: 20, z: 150 },
  ],
  tiles: Array.from({ length: 1200 }, () => null) };
const unitHit = { kind: "unit", title: "Urist", buildingId: -1, itemId: -1,
  unit: { id: 4, name: "Urist" }, tile: { x: 10, y: 20, z: 150 }, unitCycle: [4] };

function railHtml() {
  const wrap = selection.querySelector(".occupant-tabs-wrap");
  return wrap ? wrap.innerHTML : null;
}
function assertRailComplete(activeKey, note) {
  const html = railHtml();
  assert.ok(html, `rail wrap present (${note})`);
  assert.ok(selection.classList.contains("has-occupant-rail"),
    `has-occupant-rail healed after the render's className wipe (${note})`);
  for (const key of ["unit:4", "workshop:41", "stockpile:50", "item:88"])
    assert.match(html, new RegExp(`data-occupant-tab="${key}"`), `tab ${key} present (${note})`);
  assert.match(html, new RegExp(`class="dwfui-occupant-tab active"[^>]*data-occupant-tab="${activeKey}"`),
    `active tab follows the SHOWN occupant (${note})`);
  assert.equal((html.match(/dwfui-occupant-tab active/g) || []).length, 1,
    `exactly one active tab (${note})`);
}
async function startFourKindSession() {
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  unitFetches = []; occupantFetches = 0; placeOpens = [];
  sandbox.fetch = fetchStub({ occupants: fourKindRows });
  api.clearOccupantSession();
  selection.className = ""; selection._html = ""; selection.children = []; selection.dataset = {};
  assert.equal(api.consumeInspect(unitHit, { x: 10, y: 20, w: 40, h: 30 }), true);
  await flushRoute();   // unit 4 opens; authoritative refine lands the four-kind list
  assert.equal(api.getOccupantSession().candidates.length, 4, "authoritative 4-kind session");
}

// ---- 1. THE DEFECT: rail persists across EVERY entry switch, indefinitely ----------------------

await check("B224: clicking through EVERY rail entry keeps the rail present, complete and re-highlighted (2 full laps)", async () => {
  await startFourKindSession();
  assertRailComplete("unit:4", "initial open");
  // Native display order, two full laps, then back to the first -- 9 switches. the repro was
  // "click on the second or third item and the whole rail disappears so you cant go back".
  const lap = ["workshop:41", "stockpile:50", "item:88", "unit:4"];
  const keys = [...lap, ...lap, "workshop:41"];
  for (const key of keys) {
    const cand = api.getOccupantSession().candidates.find(c => `${c.kind}:${c.id}` === key);
    assert.ok(cand, `candidate ${key} still in session`);
    api.switchToOccupant(cand);   // exactly what the tab button's click handler dispatches
    await flushRoute();           // unit flow fetches /unit; item/place render synchronously
    assertRailComplete(key, `after switch to ${key}`);
  }
  assert.ok(unitFetches.length >= 2, "unit entries re-opened through the live /unit flow");
});

await check("B224: place occupants open in #selection -- never the hidden #clientPanel (root cause a)", async () => {
  await startFourKindSession();
  const sp = api.getOccupantSession().candidates.find(c => c.kind === "stockpile");
  api.switchToOccupant(sp);
  await flushRoute();
  assert.deepEqual(placeOpens[placeOpens.length - 1], ["stockpile", 50], "place flow dispatched");
  assert.ok(selection.querySelector(".occupant-tabs-wrap"), "rail lives on #selection with the place sheet");
  assert.equal(findByClass(clientPanel, "occupant-tabs-wrap"), null,
    "nothing is ever injected into #clientPanel (it does not host occupant sheets)");
});

await check("B224 root cause b: a render's className wipe is HEALED, not treated as 'already injected'", async () => {
  await startFourKindSession();
  // A sheet re-render: the wrap survives (it is a .pf-content sibling) but the class is wiped.
  assert.ok(selection.querySelector(".occupant-tabs-wrap"), "wrap in place before the re-render");
  selection.className = "visible unit-sheet-panel";   // renderUnitSheet's exact write
  assert.equal(selection.classList.contains("has-occupant-rail"), false, "the wipe really removed it");
  tick();                                             // the observer turn after the render
  assert.ok(selection.classList.contains("has-occupant-rail"),
    "the injector re-adds the class on a matching render (the pre-B224 injector early-returned " +
    "on 'wrap exists' and left the rail clipped invisible)");
});

await check("B224: a foreign sheet never wears the rail; returning to a session sheet restores it", async () => {
  await startFourKindSession();
  // An unrelated item opened from Stocks: same panel class, different identity stamp.
  selection.className = "visible stock-item-panel";
  selection.dataset = { dfcItemId: "999" };
  tick();
  assert.equal(selection.classList.contains("has-occupant-rail"), false,
    "no heal for a sheet that is not the session's active occupant");
  assert.ok(api.getOccupantSession(), "the session itself survives the detour");
  // Back to the session's unit (e.g. via the unit flow re-rendering).
  sandbox.showUnitSheet({ unit: { id: 4, name: "Urist" }, tile: { x: 10, y: 20, z: 150 } });
  assert.ok(selection.classList.contains("has-occupant-rail"), "rail restored on the session sheet");
});

// ---- 2. cancel / close: no wedged state --------------------------------------------------------

await check("B224: closing the sheet (Esc/X -> visible removed) ends the session and removes the rail DOM", async () => {
  await startFourKindSession();
  closeSelectionLikeProduction();
  assert.equal(api.getOccupantSession(), null, "session cleared when the host closes");
  assert.equal(selection.querySelector(".occupant-tabs-wrap"), null, "rail wrap removed, not orphaned");
  assert.equal(selection.classList.contains("has-occupant-rail"), false, "marker class gone");
  // No wedge: the next single-occupant click behaves as if the session never existed.
  sandbox.DwfTiles = { getLatest: () => ({ units: [{ id: 12, name: "Domas", x: 3, y: 4, z: 150 }],
    buildings: [], tiles: Array.from({ length: 1200 }, () => null) }) };
  const single = { kind: "unit", title: "Domas", itemId: -1, buildingId: -1,
    unit: { id: 12, name: "Domas" }, tile: { x: 3, y: 4, z: 150 }, unitCycle: [12] };
  assert.equal(api.consumeInspect(single, { x: 3, y: 4, w: 40, h: 30 }), false);
  assert.equal(api.getOccupantSession(), null);
  api.injectOccupantTabs();
  assert.equal(selection.querySelector(".occupant-tabs-wrap"), null, "no rail resurrects");
});

// ---- 3. keyboard: Tab / Shift+Tab walk the rail (all kinds, display order) ---------------------

await check("B224: Tab / Shift+Tab cycle the rail entries in display order; editable targets are never hijacked", async () => {
  await startFourKindSession();
  assert.equal(pressTab(false, "INPUT"), false, "Tab inside a search field is left alone");
  assert.equal(api.getOccupantSession().activeKey, "unit:4");
  assert.equal(pressTab(false, null), true, "Tab is consumed while the rail is live");
  await flushRoute();
  assert.equal(api.getOccupantSession().activeKey, "workshop:41", "Tab -> next entry in display order");
  assertRailComplete("workshop:41", "after Tab");
  assert.equal(pressTab(true, null), true);
  await flushRoute();
  assert.equal(api.getOccupantSession().activeKey, "unit:4", "Shift+Tab -> previous entry (wraps)");
  assert.equal(pressTab(true, null), true);
  await flushRoute();
  assert.equal(api.getOccupantSession().activeKey, "item:88", "Shift+Tab wraps from the first to the last");
});

// ---- 4. sprites: every occupant kind resolves through its sheet's own art channel --------------

await check("B224 sprites: unit portrait / item spriteRef / stockpile token / zone cell / building key all resolve in the rail markup", async () => {
  await startFourKindSession();
  const html = railHtml();
  assert.match(html, /<img class="occupant-unit-icon" src="\/unit-portrait\?id=4&mode=icon"/,
    "unit tab paints the same portrait pipeline as the unit sheet");
  assert.match(html, /data-dwfui-item="[^"]*BAR/, "item tab carries the wire spriteRef through DWFUI's item channel");
  assert.match(html, /data-dwfui-sprite="STOCKPILE_ICON_BARS"/, "stockpile tab paints its STOCKPILE_ICON_* interface token");
  assert.match(html, /data-icon-key="workshop_mason"/, "workshop tab routes its wire icon key through the Places art channel");
  assert.equal(/>[@#*]</.test(html), false, "no identity letter anywhere in the rail");
});

await check("B224 sprites: zone occupants route their activity_zones cell; missing art FAILS LOUD, never a letter", () => {
  const cfg = api.occupantTabsCfg({ activeKey: "zone:7", candidates: [
    { kind: "zone", id: 7, label: "Pen/Pasture", icon: { sheet: "zone", x: 5, y: 6 } },
    { kind: "item", id: 9, label: "mystery item" },   // NO spriteRef -> fail-loud
  ] });
  const html = sandbox.DWFUI.occupantRailHtml(cfg);
  assert.match(html, /zone-icon" style="background-position:-160px -192px"/,
    "zone tab passes the wire x/y through to the shared zone sheet (5,6 -> -160,-192)");
  assert.match(html, /data-df-identity-missing/, "an unresolvable item is MARKED, native empty tile");
  assert.equal(/dwfui-icon--letter/.test(html), false, "the letter path is never taken");
});

await check("B224 sprites: old host (no art fields) -- building falls back to a label-keyword cell, then fail-loud", () => {
  const cfg = api.occupantTabsCfg({ activeKey: "workshop:41", candidates: [
    { kind: "workshop", id: 41, label: "Mason workshop" },       // keyword hit
    { kind: "building", id: 60, label: "The Oiled Anvils" },     // custom name, no keyword -> loud
  ] });
  const html = sandbox.DWFUI.occupantRailHtml(cfg);
  assert.match(html, /data-icon-key="workshop_mason"/, "keyword fallback reuses the build-menu resolver");
  assert.match(html, /data-df-identity-missing/, "the unresolvable custom-named building is marked");
});

await check("B224 sprites: the injector runs DWFUI.paintSprites over the rail (item/token icons are inert strings otherwise)", async () => {
  let painted = 0;
  const realPaint = sandbox.DWFUI.paintSprites;
  sandbox.DWFUI.paintSprites = wrap => { painted++; return realPaint ? 0 : 0; };
  try {
    await startFourKindSession();
    assert.ok(painted >= 1, "paintSprites called on inject");
  } finally { sandbox.DWFUI.paintSprites = realPaint; }
});

await check("B224: routeCandidates passes the wire art fields through untouched", () => {
  const rows = api.routeCandidates({ occupants: fourKindRows });
  assert.equal(rows[3].spriteRef.itemType, "BAR");
  assert.equal(rows[2].spriteToken, "STOCKPILE_ICON_BARS");
  assert.deepEqual(JSON.parse(JSON.stringify(rows[1].icon)), { sheet: "building", key: "workshop_mason" });
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r => `${r.kind}:${r.id}`))),
    ["unit:4", "workshop:41", "stockpile:50", "item:88"],
    "B80 native display order untouched by the art fields");
});

await check("B288: engraved floor inside a zone appears in the rail and opens by tile", async () => {
  const tile = { x: 10, y: 20, z: 150 };
  const latest = { origin: { x: 0, y: 0, z: 150 }, width: 40, height: 30, units: [],
    buildings: [{ type: "Civzone", id: 77, name: "Dining Hall",
      x1: 10, y1: 20, x2: 10, y2: 20, z: 150 }],
    tiles: Array.from({ length: 1200 }, () => null) };
  const rows = [
    { kind: "zone", id: 77, name: "Dining Hall", icon: { sheet: "zone", x: 1, y: 2 } },
    { kind: "engraving", id: -1, name: 'Mukar Nashas, "The Sadness of Lilacs"',
      spriteToken: "DESIGNATION_ENGRAVE" },
  ];
  const routed = api.routeCandidates({ tile, occupants: rows });
  assert.equal(routed.length, 2, "id-less engraving row survives authoritative routing");
  assert.deepEqual(JSON.parse(JSON.stringify(api.routeForCandidate(routed[1]))),
    { flow: "engraving", tile }, "engraving dispatch is tile-addressed, not fake-id addressed");

  sandbox.DwfTiles = { getLatest: () => latest };
  sandbox.fetch = fetchStub({ tile, occupants: rows });
  engravingOpens = [];
  api.clearOccupantSession();
  selection.className = ""; selection.children = []; selection.dataset = {};
  const hit = { kind: "engraving", title: rows[1].name, itemId: -1, buildingId: -1, tile };
  assert.equal(api.consumeInspect(hit, { x: 10, y: 20, w: 40, h: 30 }), true,
    "engraving beats its passive zone and opens immediately");
  await flushRoute();
  assert.deepEqual(engravingOpens[0], tile, "the existing engraving panel receives the exact tile");
  assert.equal(api.getOccupantSession().activeKey, "engraving:-1");
  const html = railHtml();
  assert.match(html, /data-occupant-tab="zone:77"/);
  assert.match(html, /data-occupant-tab="engraving:-1"/);
  assert.match(html, /data-dwfui-sprite="DESIGNATION_ENGRAVE"/,
    "engraving row carries a real DF sprite through the generic icon channel");
});

await check("B224: noteOccupantArt backfills the item sheet's spriteRef + location stockpile token on pre-B224 hosts", async () => {
  // Old host: /tile-occupants 404s, session runs on the cache list (no art).
  sandbox.DwfTiles = { getLatest: () => crowdedLatest };
  unitFetches = [];
  sandbox.fetch = fetchStub(null);
  api.clearOccupantSession();
  selection.className = ""; selection._html = ""; selection.children = []; selection.dataset = {};
  api.consumeInspect(unitHit, { x: 10, y: 20, w: 40, h: 30 });
  await flushRoute();
  const item = api.getOccupantSession().candidates.find(c => c.kind === "stockpile");
  assert.ok(item && !item.spriteToken, "cache candidate starts art-less");
  api.noteOccupantArt("stockpile", 50, { spriteToken: "STOCKPILE_ICON_BARS" });
  assert.equal(api.getOccupantSession().candidates.find(c => c.kind === "stockpile").spriteToken,
    "STOCKPILE_ICON_BARS", "the open sheet's resolved art reaches the session");
});

// ---- 5. discovery: co-located items the cache cannot see (corpse pile on bare floor) -----------

await check("B224 discovery: a corpse pile on BARE floor (1 cache candidate) still grows the rail from /tile-occupants", async () => {
  // The AUX tail is id-less (B205), so the cache resolves ONE item; pre-B224 the other corpses
  // were unreachable -- no rail, no chooser. The authoritative route reports all three.
  const corpseRows = [
    { kind: "item", id: 72, name: "dwarf corpse", spriteRef: { itemType: "CORPSE", itemSubtype: -1, materialType: -1, materialIndex: -1 } },
    { kind: "item", id: 73, name: "cat corpse", spriteRef: { itemType: "CORPSE", itemSubtype: -1, materialType: -1, materialIndex: -1 } },
    { kind: "item", id: 74, name: "rat remains", spriteRef: { itemType: "REMAINS", itemSubtype: -1, materialType: -1, materialIndex: -1 } },
  ];
  const bareLatest = { origin: { x: 0, y: 0, z: 150 }, width: 40, height: 30, units: [], buildings: [],
    tiles: Array.from({ length: 1200 }, () => null) };
  bareLatest.tiles[810] = { item: { type: "CORPSE" } };
  const corpseHit = { kind: "item", title: "dwarf corpse", itemId: 72, buildingId: -1,
    tile: { x: 10, y: 20, z: 150 } };
  sandbox.DwfTiles = { getLatest: () => bareLatest };
  unitFetches = []; occupantFetches = 0; placeOpens = [];
  sandbox.fetch = fetchStub({ occupants: corpseRows });
  api.clearOccupantSession();
  selection.className = ""; selection._html = ""; selection.children = []; selection.dataset = {};
  // consumeInspect stands aside (single cache candidate) -- the CALLER opens the item normally.
  assert.equal(api.consumeInspect(corpseHit, { x: 10, y: 20, w: 40, h: 30 }), false,
    "single-candidate click keeps the normal one-click path (B205/B164 behaviour)");
  sandbox.openItemPanel(72);   // what showSelection does for the item click
  await flushRoute();
  const sess = api.getOccupantSession();
  assert.ok(sess, "the authoritative read grew a session around the already-open sheet");
  assert.equal(sess.activeKey, "item:72", "the occupant the caller opened stays the shown one");
  assert.equal(unitFetches.length, 0, "nothing was re-opened by discovery");
  tick();
  const html = railHtml();
  assert.ok(html, "rail appears on the corpse sheet");
  for (const key of ["item:72", "item:73", "item:74"])
    assert.match(html, new RegExp(`data-occupant-tab="${key}"`), `corpse-pile entry ${key} reachable`);
  // And B164 stands: a LONE occupant discovery (route returns 1) never creates a session.
  sandbox.fetch = fetchStub({ occupants: [{ kind: "stockpile", id: 50, name: "Bar stockpile" }] });
  api.clearOccupantSession();
  const loneHit = { kind: "stockpile", title: "Bar stockpile", itemId: -1, buildingId: 50, tile: { x: 10, y: 20, z: 150 } };
  assert.equal(api.consumeInspect(loneHit, { x: 10, y: 20, w: 40, h: 30 }), false);
  await flushRoute();
  assert.equal(api.getOccupantSession(), null, "a lone stockpile stays session-less (B164)");
});

// ---- 6. occupants changing while the rail is open ----------------------------------------------

await check("B224: each rail switch re-reads /tile-occupants so a changed tile refreshes the rail", async () => {
  await startFourKindSession();
  const before = occupantFetches;
  const sp = api.getOccupantSession().candidates.find(c => c.kind === "stockpile");
  api.switchToOccupant(sp);
  await flushRoute();
  assert.ok(occupantFetches > before, "switching triggered a click-time occupant re-read");
});

// ---- 6. wiring + serializer parity pins --------------------------------------------------------

await check("B224 pins: build-info-panels really exposes the plain-script globals the rail consumes, and stamps/backfills", () => {
  assert.match(infoPanelsSrc, /function infoPlaceIconMarkup\(row\)/, "the shared Places art builder exists");
  assert.match(infoPanelsSrc, /function itemIconName\(item\)/, "the keyword resolver exists");
  assert.equal(/\(function\s*\(/.test(infoPanelsSrc.slice(0, 2000)), false,
    "build-info-panels is a plain script (its functions ARE globals the rail can reach)");
  assert.match(infoPanelsSrc, /selection\.dataset\.dfcItemId = String\(Number\(result\?\.id \?\? -1\)\)/,
    "showStockItemSheet stamps the identity the shown-content guard reads");
  assert.match(infoPanelsSrc, /DFTileList\.noteOccupantArt\("item", Number\(result\?\.id \?\? -1\), \{ spriteRef: result\?\.spriteRef \|\| null \}\)/,
    "showStockItemSheet backfills the item's art into the session");
  assert.match(infoPanelsSrc, /DFTileList\.noteOccupantArt\("stockpile", Number\(result\.locationId\), \{ spriteToken: result\.locationSpriteToken \}\)/,
    "showStockItemSheet backfills the location stockpile's token");
});

await check("B224 pins: the C++ /tile-occupants serializer ships the art fields this fixture consumes (DLL-gated half)", () => {
  const cpp = fs.readFileSync(path.join(root, "src/interaction.cpp"), "utf8");
  const handler = cpp.slice(cpp.indexOf("/tile-occupants\""));
  assert.ok(handler.length > 100, "handler found");
  // The C++ writes ESCAPED json fragments; match the source text as it appears in the .cpp.
  assert.match(handler, /\\"spriteRef\\":\{\\"itemType\\":/, "items ship the four-field spriteRef");
  assert.match(handler, /stockpile_icon_token\(virtual_cast<df::building_stockpilest>\(building\)\)/,
    "stockpiles ship their STOCKPILE_ICON_* token (same derivation as the item sheet's location row)");
  assert.match(handler, /\\"icon\\":\{\\"sheet\\":\\"zone\\",\\"x\\":/, "zones ship their activity_zones cell");
  assert.match(handler, /\\"icon\\":\{\\"sheet\\":\\"building\\",\\"key\\":/, "buildings/workshops ship their cell name");
  assert.match(fs.readFileSync(path.join(root, "src/info_panel.h"), "utf8"),
    /std::string building_icon_key\(df::building\* building\);/, "building_icon_key exported");
  assert.match(fs.readFileSync(path.join(root, "src/building_zone.h"), "utf8"),
    /bool zone_icon_cell\(df::building\* building, int& x, int& y\);/, "zone_icon_cell exported");
});

if (failed) process.exit(1);
console.log("siderail_flow_test: PASS");
