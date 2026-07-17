// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// B224 REOPEN (round 2). The owner, live on win38/39 WITH round 1's fix deployed byte-identical:
// "clicking on the trader unit at the depot still doesnt give me a side rail multidropdown for
// all the units on that tile." Tile: horse + marksdwarf + trade depot. Oracle
// B224-oracle-native.png: vertical sprite-tab strip flush against the sheet's right edge, horse
// (selected) on top, marksdwarf, then the depot.
//
// ROOT CAUSE (round 2): the rail was IN the DOM, healed and wired -- round 1's fixtures prove
// that half and they were green -- but it PAINTED ZERO PIXELS. The wrap hangs OUTSIDE the host's
// padding box (right:-32px*scale, native's outside-the-frame strip), so it is visible only while
// #selection's effective overflow is `visible`. Round 1's un-clip was
//   #selection.has-occupant-rail { overflow:visible }            -- specificity (1,1,0)
// but in PRODUCTION the panel framework's fill contract puts `pf-fill-host` on #selection for
// every occupant sheet (unit sheet included: fillSel ".unit-grid,..." matches the Overview grid),
// and
//   #selection.visible.pf-fill-host { overflow:hidden }          -- specificity (1,2,0)
// beats the un-clip BY SPECIFICITY, source order irrelevant. Same ambush from
//   #selection.building-panel.td-depot-panel { overflow-y:auto } -- (1,2,0), the depot tab
// Round 1's harness never ran the panel framework, so its #selection never wore pf-fill-host and
// every DOM-level assertion passed while every LIVE sheet clipped the rail into invisibility.
//
// THIS TEST would have caught it: it computes the CASCADE WINNER for the overflow longhands over
// the REAL stylesheet, for the exact class sets production produces (pinned below, not invented),
// and asserts the rail-bearing host resolves to overflow visible. It FAILS against the round-1
// stylesheet (proof run recorded in the closeout) and passes once the un-clip outranks every
// single-id competitor.
//
// It also drives the exact repro through the REAL module (unit-first click, unit+unit+building,
// authoritative /tile-occupants order) and asserts the rail lists all three occupants in native
// display order with the clicked unit active -- the mandate's fixture. That half alone was green
// on round 1's module, which is precisely the round-1 lesson: DOM presence is not paint.
//
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
const cssPath = process.env.SIDERAIL_CSS || path.join(root, "web/css/dwf.css");
const componentsPath = path.join(root, "web/js/dwf-ui-components.js");
const source = fs.readFileSync(cyclePath, "utf8");
const components = fs.readFileSync(componentsPath, "utf8");
const cssText = fs.readFileSync(cssPath, "utf8");
const coreSrc = fs.readFileSync(path.join(root, "web/js/dwf-core.js"), "utf8");
const hudSrc = fs.readFileSync(path.join(root, "web/js/dwf-unit-hud-notifications.js"), "utf8");
const pfSrc = fs.readFileSync(path.join(root, "web/js/dwf-panelframe.js"), "utf8");

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + "\n" + (err.stack || err)); }
}

// ================================================================================================
// PART 1 -- THE PAINT ORACLE: cascade-resolved overflow for the LIVE class sets.
// A minimal, spec-shaped cascade for the subset this stylesheet uses on the host element:
// compound selectors of #id/.class (a selector with combinators or pseudos cannot match the host
// element itself here and is skipped), specificity (ids, classes), then source order. @media
// blocks are evaluated for a 1920x1080 desktop viewport. `overflow` shorthand expands to both
// longhands at the rule's specificity, exactly as the browser cascades it.
// ================================================================================================

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, " "); }

function mediaMatches(condition, viewportW) {
  // Only width conditions appear in this sheet. Unknown conditions -> treat as non-matching so a
  // future feature query cannot silently inject rules into the desktop evaluation.
  let match = true, understood = true;
  const feats = condition.match(/\((?:min|max)-width:\s*[\d.]+px\)/g) || [];
  const other = condition.replace(/\((?:min|max)-width:\s*[\d.]+px\)/g, "").replace(/\b(?:and|screen|all|only)\b/g, "").trim();
  if (other && other !== "," && !/^[\s,()]*$/.test(other)) understood = false;
  for (const f of feats) {
    const m = /\((min|max)-width:\s*([\d.]+)px\)/.exec(f);
    if (m[1] === "max" && viewportW > Number(m[2])) match = false;
    if (m[1] === "min" && viewportW < Number(m[2])) match = false;
  }
  return understood && match;
}

// Parse top-level rules; recurse into matching @media. Returns [{selectors, declarations, order}].
function parseRules(css, viewportW) {
  const rules = [];
  let i = 0, order = 0;
  function block(from) {  // index of '{' -> index just past its matching '}'
    let depth = 0, j = from;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") { depth--; if (depth === 0) return j + 1; }
    }
    return css.length;
  }
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    const prelude = css.slice(i, brace).trim();
    const end = block(brace);
    const body = css.slice(brace + 1, end - 1);
    if (prelude.startsWith("@media")) {
      const inner = prelude.slice(6).trim();
      if (mediaMatches(inner, viewportW))
        for (const r of parseRules(body, viewportW)) rules.push({ ...r, order: order++ });
    } else if (!prelude.startsWith("@")) {
      const declarations = {};
      for (const decl of body.split(";")) {
        const colon = decl.indexOf(":");
        if (colon < 0) continue;
        const prop = decl.slice(0, colon).trim().toLowerCase();
        const value = decl.slice(colon + 1).trim();
        if (prop) declarations[prop] = value;
      }
      rules.push({ selectors: prelude.split(","), declarations, order: order++ });
    }
    i = end;
  }
  return rules;
}

// Does a single compound selector match an element {id, classes}? Returns null when the selector
// cannot target the host element itself (combinators / pseudos / attributes / type selectors).
function compoundMatch(selector, el) {
  const s = selector.trim();
  if (!s || /[\s>+~:\[\]()]/.test(s)) return null;
  const parts = s.match(/[#.][^#.]+/g);
  if (!parts || parts.join("") !== s) return null;
  let ids = 0, classes = 0;
  for (const part of parts) {
    if (part[0] === "#") { if (part.slice(1) !== el.id) return null; ids++; }
    else { if (!el.classes.has(part.slice(1))) return null; classes++; }
  }
  return { ids, classes };
}

// Cascade winner for one longhand. `overflow: x` / `overflow: x y` expand per spec.
function cascadedOverflow(rules, el) {
  const axes = { "overflow-x": null, "overflow-y": null };
  const beats = (a, b) => !b || a.ids > b.ids || (a.ids === b.ids && (a.classes > b.classes ||
    (a.classes === b.classes && a.order >= b.order)));
  for (const rule of rules) {
    let best = null;
    for (const sel of rule.selectors) {
      const m = compoundMatch(sel, el);
      if (m && (!best || m.ids > best.ids || (m.ids === best.ids && m.classes > best.classes))) best = m;
    }
    if (!best) continue;
    const decls = { ...rule.declarations };
    if (decls.overflow != null) {
      const parts = decls.overflow.split(/\s+/);
      decls["overflow-x"] = decls["overflow-x"] != null ? decls["overflow-x"] : parts[0];
      decls["overflow-y"] = decls["overflow-y"] != null ? decls["overflow-y"] : (parts[1] || parts[0]);
    }
    for (const axis of ["overflow-x", "overflow-y"]) {
      if (decls[axis] == null) continue;
      const cand = { ids: best.ids, classes: best.classes, order: rule.order, value: decls[axis].toLowerCase() };
      if (beats(cand, axes[axis])) axes[axis] = cand;
    }
  }
  // Per CSS Overflow 3: if one axis computes to visible and the other is not visible, the visible
  // one computes to auto. The wrap needs BOTH visible, so model the coercion faithfully.
  let x = axes["overflow-x"] ? axes["overflow-x"].value : "visible";
  let y = axes["overflow-y"] ? axes["overflow-y"].value : "visible";
  if (x === "visible" && y !== "visible") x = "auto";
  if (y === "visible" && x !== "visible") y = "auto";
  return { x, y };
}

const rules = parseRules(stripComments(cssText), 1920);

// The class sets below are what PRODUCTION puts on #selection while an occupant sheet is up with
// a live rail session. Not invented -- each ingredient is pinned in Part 3: the renderer writes
// "visible <variant>", the panel framework re-adds pf-resizable and (because every occupant-sheet
// variant declares fill targets that its markup really renders) pf-fill-host, and the injector
// heals has-occupant-rail. pf-fill-host is the one round 1's harness never produced.
const LIVE_CLASS_SETS = {
  "unit sheet (the horse)": "visible unit-sheet-panel pf-resizable pf-fill-host has-occupant-rail",
  "stockpile sheet": "visible stockpile-panel pf-resizable pf-fill-host has-occupant-rail",
  "trade-depot sheet (the depot tab)": "visible building-panel td-depot-panel pf-resizable pf-fill-host has-occupant-rail",
  "hospital sheet": "visible building-panel hosp-panel pf-resizable pf-fill-host has-occupant-rail",
  "workshop sheet": "visible building-panel workshop-panel pf-resizable pf-fill-host has-occupant-rail",
  "farm sheet": "visible building-panel farm-panel pf-resizable pf-fill-host has-occupant-rail",
  "plain building sheet": "visible building-panel pf-resizable pf-fill-host has-occupant-rail",
  "item sheet": "visible stock-item-panel pf-resizable pf-fill-host has-occupant-rail",
  "zone sheet": "visible building-panel zone-panel pf-resizable pf-fill-host has-occupant-rail",
};

// Matrix: every occupant-sheet variant x desktop AND narrow viewport (the @media block reflows
// the unit sheet under ~720px; the un-clip must win there too).
const narrowRules = parseRules(stripComments(cssText), 700);
for (const [label, classNames] of Object.entries(LIVE_CLASS_SETS)) {
  for (const [vpLabel, ruleSet] of [["1920px", rules], ["700px", narrowRules]]) {
    await check(`B224r2 paint: ${label} @${vpLabel} -- cascade-winning overflow is visible on BOTH axes (the rail hangs outside the box)`, () => {
      const el = { id: "selection", classes: new Set(classNames.split(/\s+/)) };
      const got = cascadedOverflow(ruleSet, el);
      assert.deepEqual(got, { x: "visible", y: "visible" },
        `#selection{${classNames}} must not clip the outside-right rail; cascade resolved ${JSON.stringify(got)}. ` +
        "The un-clip must OUTRANK every single-id variant/fill rule (e.g. #selection.visible.pf-fill-host " +
        "{overflow:hidden} at (1,2,0)), not tie with or lose to it.");
    });
  }
}

await check("B224r2 paint: without a rail session the fill contract's clip still stands (no blanket un-clip)", () => {
  const el = { id: "selection", classes: new Set(["visible", "unit-sheet-panel", "pf-resizable", "pf-fill-host"]) };
  const got = cascadedOverflow(rules, el);
  assert.deepEqual(got, { x: "hidden", y: "hidden" },
    "pf-fill-host's overflow:hidden is intentional outside rail sessions; the fix must be scoped to has-occupant-rail");
});

await check("B224r2 geometry: the wrap is the native outside-right strip (oracle B224-oracle-native.png)", () => {
  const wrapRule = rules.find(r => r.selectors.some(s => s.trim() === ".occupant-tabs-wrap"));
  assert.ok(wrapRule, ".occupant-tabs-wrap rule present");
  assert.equal(wrapRule.declarations.position, "absolute", "wrap is positioned against the sheet host");
  assert.match(wrapRule.declarations.top || "", /^8px$/, "strip starts at the sheet's top edge band");
  assert.match(wrapRule.declarations.right || "", /^calc\(-32px \* var\(--dwfui-interface-scale\)\)$/,
    "strip hangs flush OUTSIDE the right edge, one native tab wide");
  const railRule = rules.find(r => r.selectors.some(s => s.trim() === ".dwfui-occupant-rail"));
  assert.ok(railRule && /column/.test(railRule.declarations["flex-direction"] || ""), "tabs stack vertically");
});

// ================================================================================================
// PART 2 -- THE EXACT REPRO through the REAL module: a unit-first click on a tile holding
// [unit(horse), unit(marksdwarf), building(trade depot)]. The AUX cache is given NO buildings
// (worst case: the depot is reachable only through authoritative /tile-occupants), and /inspect
// resolves the horse. The rail must list all three in native display order, horse active.
// ================================================================================================

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
const observers = [];
const documentStub = {
  readyState: "complete",
  head: { appendChild() {} },
  documentElement: { appendChild() {} },
  createElement(tag) { return fakeElement(tag); },
  getElementById(id) { return id === "selection" ? selection : null; },
  addEventListener() {},
};
class MutationObserverStub {
  constructor(cb) { this.cb = cb; }
  observe(target, opts) { observers.push({ cb: this.cb, target, opts }); }
}
function tick() {
  for (const o of observers) if (o.opts && o.opts.childList) o.cb();
  for (const o of observers) if (o.opts && o.opts.attributes) o.cb();
}
const sandbox = { window: null, document: documentStub, location: { search: "" },
  DWFUI, MutationObserver: MutationObserverStub,
  localStorage: { getItem: () => "" }, URLSearchParams, Date, Number, String, Array, Object,
  isFinite, JSON, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(components, sandbox, { filename: componentsPath });
sandbox.infoPlaceIconMarkup = row => (row && row.iconKey
  ? `<span class="info-place-icon" data-icon-key="${row.iconKey}"></span>` : "");
sandbox.itemIconName = () => null;
vm.runInContext(source, sandbox, { filename: cyclePath });
const api = sandbox.DFTileList;
assert.ok(api, "DFTileList API must be exposed");

const HORSE = 301, MARKS = 305, DEPOT = 88;
const depotTile = { x: 61, y: 47, z: 142 };
let unitFetches = [];
sandbox.showUnitSheet = d => {
  sandbox.selectedUnitData = d;
  selection.className = "visible unit-sheet-panel pf-resizable pf-fill-host"; // production set incl. framework classes
  tick();
};
sandbox.openItemPanel = () => {};
sandbox.openInfoPlace = (kind, id) => {
  // The depot occupant opens through openBuildingPanel's delegation to the trade-depot panel.
  selection.className = kind === "building"
    ? "visible building-panel td-depot-panel pf-resizable pf-fill-host"
    : "visible building-panel pf-resizable pf-fill-host";
  selection._lastPlace = [kind, id];
  tick();
};
const occupantRows = [
  { kind: "unit", id: HORSE, name: "Horse (Tame)" },
  { kind: "unit", id: MARKS, name: "Kadol Rithlutar, Marksdwarf" },
  { kind: "building", id: DEPOT, name: "Trade Depot", icon: { sheet: "building", key: "trade_depot" } },
];
sandbox.fetch = async request => {
  if (/\/unit\?/.test(request)) {
    const id = Number((/id=(\d+)/.exec(request) || [])[1]);
    unitFetches.push(id);
    return { ok: true, json: async () => ({ kind: "unit", unit: { id, name: "u" + id }, tile: depotTile }) };
  }
  return { ok: true, json: async () => ({ occupants: occupantRows }) };
};
async function flushRoute() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

const inspectHit = {
  kind: "unit", title: "Horse (Tame)", buildingId: -1, itemId: -1,
  unit: { id: HORSE, name: "Horse (Tame)" }, tile: depotTile,
  unitCycle: [HORSE, MARKS],   // find_units_for_tile_click: both units exact-tile, id order
};
const auxLatest = { origin: { x: 40, y: 30, z: 142 }, width: 40, height: 30,
  units: [
    { id: HORSE, name: "Horse (Tame)", x: 61, y: 47, z: 142 },
    { id: MARKS, name: "Kadol", x: 61, y: 47, z: 142 },
  ],
  buildings: [],   // worst case: the depot is invisible to the AUX cache
  tiles: [] };

function railHtml() {
  const wrap = selection.querySelector(".occupant-tabs-wrap");
  return wrap ? wrap.innerHTML : null;
}

await check("B224r2 flow: the unit-first click grows a 3-entry rail in native order, horse active", async () => {
  sandbox.DwfTiles = { getLatest: () => auxLatest };
  unitFetches = [];
  api.clearOccupantSession();
  selection.className = ""; selection._html = ""; selection.children = []; selection.dataset = {};
  assert.equal(api.consumeInspect(inspectHit, { x: 21, y: 17, w: 40, h: 30 }), true,
    "two exact-tile units make this a session click even with the depot invisible to the cache");
  await flushRoute();   // horse opens through /unit; authoritative /tile-occupants refine lands
  const sess = api.getOccupantSession();
  assert.ok(sess, "session established");
  // JSON round-trip: session arrays are vm-realm values; deepStrictEqual rejects foreign prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(sess.candidates.map(c => `${c.kind}:${c.id}`))),
    [`unit:${HORSE}`, `unit:${MARKS}`, `building:${DEPOT}`],
    "authoritative /tile-occupants order (native display order) owns the rail");
  assert.equal(sess.activeKey, `unit:${HORSE}`, "the clicked/resolved unit stays the shown occupant");
  tick();
  const html = railHtml();
  assert.ok(html, "rail wrap present on the unit sheet");
  assert.ok(selection.classList.contains("has-occupant-rail"), "has-occupant-rail healed");
  const order = [...html.matchAll(/data-occupant-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, [`unit:${HORSE}`, `unit:${MARKS}`, `building:${DEPOT}`],
    "tabs render in native display order");
  assert.match(html, new RegExp(`class="dwfui-occupant-tab active"[^>]*data-occupant-tab="unit:${HORSE}"`),
    "horse tab highlighted (oracle: selected occupant carries the highlight border)");
  assert.match(html, new RegExp(`data-occupant-tab="unit:${MARKS}"[^>]*>\\s*<img class="occupant-unit-icon" src="/unit-portrait\\?id=${MARKS}&mode=icon"`),
    "unit tabs paint the portrait pipeline");
  assert.match(html, /data-icon-key="trade_depot"/, "depot tab routes its wire icon key through the Places art channel");
});

await check("B224r2 flow: switching to the depot tab keeps the rail through the td-depot delegation; back to the horse", async () => {
  const sess = api.getOccupantSession();
  const depot = sess.candidates.find(c => c.kind === "building");
  api.switchToOccupant(depot);
  await flushRoute();
  assert.deepEqual(selection._lastPlace, ["building", DEPOT], "depot opened through the place flow");
  assert.ok(selection.classList.contains("has-occupant-rail"), "rail survives on the delegated td-depot sheet");
  assert.ok(railHtml(), "rail wrap still present");
  assert.match(railHtml(), new RegExp(`class="dwfui-occupant-tab active"[^>]*data-occupant-tab="building:${DEPOT}"`),
    "active highlight follows the depot");
  const horse = api.getOccupantSession().candidates.find(c => c.id === HORSE);
  api.switchToOccupant(horse);
  await flushRoute();
  assert.equal(api.getOccupantSession().activeKey, `unit:${HORSE}`, "no dead end: back on the horse");
  assert.ok(railHtml(), "rail persists for the return trip");
});

// ================================================================================================
// PART 3 -- pins for the causal chain Part 1's class sets rest on. If any of these change shape,
// the paint oracle's premises must be re-derived rather than silently going stale.
// ================================================================================================

await check("B224r2 pins: production really puts pf-fill-host on occupant sheets (the class round 1's harness never produced)", () => {
  assert.match(coreSrc, /if \(variant === "unit-sheet-panel"\) return "\.unit-grid,/,
    "core.js declares fill targets for the unit sheet variant");
  assert.match(hudSrc, /cls: "unit-grid"/, "the unit sheet Overview really renders .unit-grid, so fill targets match");
  assert.match(pfSrc, /el\.classList\.add\("pf-fill-host"\)/,
    "the framework adds pf-fill-host to the HOST when fill targets match");
  assert.match(cssText, /#selection\.visible\.pf-fill-host \{[^}]*overflow: hidden;/,
    "the fill contract clips the host at (1,2,0) -- the specificity the un-clip must outrank");
  assert.match(cssText, /#clientPanel\.visible\.pf-fill-host,\s*#selection\.visible\.pf-fill-host/,
    "clip rule shape (grouped selector) as audited");
});

await check("B224r2 pins: the renderers' wholesale className writes carry no un-clip of their own (heal + cascade are the whole story)", () => {
  assert.match(hudSrc, /selection\.className = "visible unit-sheet-panel";/,
    "renderUnitSheet writes the variant classes wholesale (pf-* re-added by the framework observers)");
});

if (failed) process.exit(1);
console.log("siderail_paint_clip_test: PASS");
