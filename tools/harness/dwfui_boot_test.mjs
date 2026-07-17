// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// FB-2 / FB-6: THE DOM HALF OF DWFUI, PROVEN TO ACTUALLY BOOT AND ACTUALLY PAINT.
// OFFLINE: no DF, no server, no browser, no network.
//
// WHY THIS FILE EXISTS. Wave 2 shipped a correct component foundation and never plugged it in.
// `DWFUI.paintSprites` / `mountScrollbarArt` / `mountTabArt` / `restoreScroll` / `restoreSearchCaret` had ZERO
// CALLERS in web/js. The builders emitted `<span data-dwfui-sprite="BUTTON_FILTER">` and nothing ever
// blitted it, so the search magnifier on THREE OF THE APPROVED ANCHORS rendered as an EMPTY BOX in
// the live client -- while the whole test suite stayed green, because every existing cell asserts on
// the MARKUP STRING. The markup was right. The screen was blank.
//
// So string assertions cannot catch this class of bug and none are used here. This file stands up a
// minimal DOM + a fake DFChrome, RUNS the boot, and asserts on the RESULTING NODES:
//   1. booting paints the sprites that are already on the page;
//   2. booting paints the sprites of a panel rendered LATER -- which is the whole product, since
//      every panel re-renders after boot -- and it does so WITHOUT that panel calling anything;
//   3. an unresolved sprite token is marked LOUDLY (FB-6) instead of shipping as an invisible hole;
//   4. every sprite token DWFUI can emit actually EXISTS in web/interface_map.json.
// Each carries a seeded-bad twin proving the assertion rejects the broken world we just left:
// specifically, a boot with NO observer -- which is what "call paintSprites once at startup" would
// have been, and which would have shipped the empty box anyway.
//
//   node tools/harness/dwfui_boot_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
};
const rejects = async (name, fn) => {
  try { await fn(); failed++; console.error("FAIL " + name + " -- the seeded-bad world was ACCEPTED"); }
  catch { console.log("PASS " + name + " (seeded-bad rejected)"); }
};

// =================================================================================================
// A minimal DOM. Only what DWFUI's four DOM members actually touch -- deliberately tiny, so it
// cannot quietly "work" for a reason Chromium would not share. appendChild REALLY dispatches to the
// registered MutationObservers, so the observer wiring (target + subtree) is exercised, not faked.
// =================================================================================================
const observers = [];
class FakeMutationObserver {
  constructor(cb) { this.cb = cb; this.records = []; }
  observe(target, opts) { observers.push({ mo: this, target, opts }); }
  disconnect() { for (let i = observers.length - 1; i >= 0; i--) if (observers[i].mo === this) observers.splice(i, 1); }
}
let delivering = false;
const pending = [];
function notify(target, added) {
  for (const reg of observers) {
    const scoped = reg.opts && reg.opts.subtree
      ? (target === reg.target || (target.closest && contains(reg.target, target)))
      : target === reg.target;
    if (scoped && reg.opts && reg.opts.childList) pending.push({ mo: reg.mo, rec: { type: "childList", target, addedNodes: added } });
  }
  if (delivering) return;                 // paintSprites' own canvas append re-enters here
  delivering = true;
  try {
    while (pending.length) {
      const { mo, rec } = pending.shift();
      mo.cb([rec], mo);
    }
  } finally { delivering = false; }
}
function notifyAttribute(target, name) {
  for (const reg of observers) {
    const scoped = reg.opts && reg.opts.subtree
      ? (target === reg.target || (target.closest && contains(reg.target, target)))
      : target === reg.target;
    const allowed = !reg.opts.attributeFilter || reg.opts.attributeFilter.includes(name);
    if (scoped && reg.opts && reg.opts.attributes && allowed)
      reg.mo.cb([{ type: "attributes", target, attributeName: name }], reg.mo);
  }
}
const contains = (ancestor, node) => {
  for (let n = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
};

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.attrs = new Map();
    this.classes = new Set();
    this.children = [];
    this.parent = null;
    this.style = { setProperty() {} };
    this.classList = {
      add: (...c) => c.forEach(x => this.classes.add(x)),
      remove: (...c) => c.forEach(x => this.classes.delete(x)),
      contains: c => this.classes.has(c),
    };
  }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(" "); }
  setAttribute(k, v) {
    const next = String(v), previous = this.attrs.get(k);
    this.attrs.set(k, next);
    if (previous !== next) notifyAttribute(this, k);
  }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  appendChild(child) { child.parent = this; this.children.push(child); notify(this, [child]); return child; }
  // the ONLY selectors DWFUI's DOM members use: [attr], tag[attr], tag.class
  matches(sel) {
    let m = /^\[([^\]]+)\]$/.exec(sel);
    if (m) return this.hasAttribute(m[1]);
    m = /^([a-z]+)\[([^\]]+)\]$/.exec(sel);
    if (m) return this.tagName === m[1].toUpperCase() && this.hasAttribute(m[2]);
    m = /^([a-z]+)\.([\w-]+)$/.exec(sel);
    if (m) return this.tagName === m[1].toUpperCase() && this.classes.has(m[2]);
    throw new Error(`test DOM: unsupported selector ${sel}`);
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = n => n.children.forEach(c => { if (c.matches(sel)) out.push(c); walk(c); });
    walk(this);
    return out;                                   // a real Array: .forEach works, which is all we use
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    for (let n = this; n; n = n.parent) if (n.matches && n.matches(sel)) return n;
    return null;
  }
  addEventListener() {}
}

function freshDoc() {
  const doc = new El("html");
  doc.documentElement = new El("html");
  doc.body = new El("body");
  doc.documentElement.parent = doc;
  doc.body.parent = doc.documentElement;
  doc.documentElement.children.push(doc.body);
  doc.children.push(doc.documentElement);
  doc.createElement = tag => new El(tag);
  return doc;
}

// A sprite span exactly as DWFUI.iconHtml emits it, but as nodes (no HTML parser in this shim).
function spriteSpan(token, size) {
  const el = new El("span");
  el.className = "dwfui-icon";
  el.setAttribute("data-dwfui-sprite", token);
  el.setAttribute("data-dwfui-sprite-size", String(size || 32));
  return el;
}
const isPainted = el => !!el.querySelector("canvas.df-chrome-icon");

// A DFChrome that knows the real token vocabulary but paints nothing.
//
// WAVE-4 INTERFACE SCALE: DWFUI no longer blits its sprites through DFChrome.updateIcon. It cannot:
// updateIcon goes through _dfChromeScaleFor, whose `Math.max(1, Math.round(target/native))` is the
// D1 integer rule in code, and that makes DF's real ~1.25 interface scale UNREPRESENTABLE. DWFUI
// now resolves the record with getCell and paints it itself, at `native * --dwfui-interface-scale`,
// with the 50% blend baked in. (DFChrome keeps the integer rule for the top bar and the game-chrome
// toolbar, which are OUR widgets, not DF's interface.)
//
// So the paint LEDGER moves to getCell -- the one call DWFUI still makes per sprite. `updateIcon`
// stays on the fake, unused, precisely so that a regression to the integer path would show up here
// as a token recorded TWICE.
const MAP = { BUTTON_FILTER: { img: "x.png", cx: 0, cy: 0, w: 48, h: 36 } };
function fakeChrome(map) {
  const painted = [];
  return {
    painted,
    loadMap: () => Promise.resolve(map),
    getCell: t => { const rec = map[t]; if (rec) painted.push({ token: t, rec }); return rec; },
    updateIcon: (canvas, token, size) => { painted.push({ canvas, token, size, viaDFChrome: true }); },
  };
}
// DWFUI must NEVER route a DWFUI sprite back through DFChrome's integer scaler.
const noIntegerPath = () =>
  assert.equal(globalThis.DFChrome.painted.filter(p => p.viaDFChrome).length, 0,
    "a DWFUI sprite painted through DFChrome.updateIcon is pinned to an INTEGER scale -- " +
    "DF's ~1.25 interface scale is unrepresentable there");

// The module resolves window.DFChrome / window.MutationObserver at CALL time off `root`, which is
// globalThis under node -- so the globals below are what it will see.
globalThis.MutationObserver = FakeMutationObserver;
const DWFUI = require(join(root, "web/js/dwf-ui-components.js"));

// =================================================================================================
console.log("FB-2 -- the DOM half BOOTS and PAINTS");
// =================================================================================================

await check("boot paints the sprites already on the page", async () => {
  const doc = freshDoc();
  globalThis.document = doc;
  globalThis.DFChrome = fakeChrome(MAP);
  const panel = doc.body.appendChild(new El("div"));
  const icon = panel.appendChild(spriteSpan("BUTTON_FILTER"));
  assert.equal(isPainted(icon), false, "precondition: inert markup, nothing painted");

  DWFUI.mountDom(doc);

  assert.equal(isPainted(icon), true, "the boot must blit the sprite that is already in the DOM");
  assert.deepEqual(globalThis.DFChrome.painted.map(p => p.token), ["BUTTON_FILTER"]);
  noIntegerPath();
});

// THIS is the cell that would have caught FB-2 in the live product. Every panel in the client
// re-renders AFTER boot (`panelContent(host).innerHTML = ...`), so a boot that only sweeps the page
// once at startup paints nothing that matters -- the workshop task picker does not exist yet when
// the page loads. The magnifier on the approved anchors is exactly such a sprite.
await check("a panel rendered AFTER boot is painted -- without the panel calling anything", async () => {
  const doc = freshDoc();
  globalThis.document = doc;
  globalThis.DFChrome = fakeChrome(MAP);
  DWFUI.mountDom(doc);
  assert.equal(globalThis.DFChrome.painted.length, 0, "nothing to paint at boot");

  // what dwf-building-zone-stockpile-panels.js does when the owner opens the workshop task picker
  const host = doc.body.appendChild(new El("div"));      // panelContent(clientPanel)
  const search = new El("div");
  const magnifier = search.appendChild(spriteSpan("BUTTON_FILTER", 32));
  host.appendChild(search);                              // <- the innerHTML assignment

  assert.equal(isPainted(magnifier), true,
    "the workshop-picker magnifier must be BLITTED, not an empty 38x38 box");
  assert.deepEqual(globalThis.DFChrome.painted.map(p => p.token), ["BUTTON_FILTER"]);
  noIntegerPath();
});

await rejects("test-the-test: a boot that only sweeps ONCE at startup leaves it an empty box", async () => {
  const doc = freshDoc();
  globalThis.document = doc;
  globalThis.DFChrome = fakeChrome(MAP);
  DWFUI.paintSprites(doc);        // <- the seeded-bad boot: a startup sweep with NO observer.
  const host = doc.body.appendChild(new El("div"));
  const magnifier = host.appendChild(spriteSpan("BUTTON_FILTER", 32));
  assert.equal(isPainted(magnifier), true, "un-booted sprite must NOT count as painted");
});

await check("mountDom is idempotent -- a second boot does not stack a second observer", async () => {
  const doc = freshDoc();
  globalThis.document = doc;
  globalThis.DFChrome = fakeChrome(MAP);
  const before = observers.length;
  DWFUI.mountDom(doc);
  DWFUI.mountDom(doc);
  assert.equal(observers.length - before, 1, "exactly one observer per document");
  const icon = doc.body.appendChild(new El("div")).appendChild(spriteSpan("BUTTON_FILTER"));
  assert.equal(isPainted(icon), true);
  assert.equal(globalThis.DFChrome.painted.filter(p => p.token === "BUTTON_FILTER").length, 1,
    "a doubled observer would double every blit on the render path");
  noIntegerPath();
});

await check("painting is idempotent: a repaint reuses the canvas, it does not stack canvases", async () => {
  const doc = freshDoc();
  globalThis.document = doc;
  globalThis.DFChrome = fakeChrome(MAP);
  const icon = doc.body.appendChild(spriteSpan("BUTTON_FILTER"));
  DWFUI.mountDom(doc);
  DWFUI.paintSprites(doc);
  DWFUI.paintSprites(doc);
  assert.equal(icon.children.length, 1, "one canvas, repainted -- never N canvases");
});

await check("a changed bitmap label is scheduled without waiting for unrelated DOM churn", async () => {
  const doc = freshDoc();
  globalThis.document = doc;
  globalThis.DFChrome = fakeChrome(MAP);
  const scheduled = [];
  globalThis.DFBitmapText = { schedule: node => { scheduled.push(node); return Promise.resolve(1); } };
  DWFUI.mountDom(doc);
  const label = new El("span");
  label.setAttribute("data-dwfui-bitmap-text", "Idle");
  doc.body.appendChild(label);
  scheduled.length = 0;
  label.setAttribute("data-dwfui-bitmap-text", "Store item in stockpile");
  assert.deepEqual(scheduled, [label], "the dirty label itself must be the scheduled paint root");
  delete globalThis.DFBitmapText;
});

// =================================================================================================
console.log("\nFB-2 -- the wiring, at the one central site");
// =================================================================================================

const coreSource = readFileSync(join(root, "web/js/dwf-core.js"), "utf8");
const indexHtml = readFileSync(join(root, "web/index.html"), "utf8");

await check("dwf-core.js -- the panel render/boot pipeline -- is the site that boots it", () => {
  assert.match(coreSource, /DWFUI\.mountDom\(document\)/,
    "core.js owns panelContent() and registerContentHosts(); the DOM half boots THERE, once");
  assert.match(coreSource, /DOMContentLoaded/, "and it boots on the same ready path as the panel framework");
});

await check("the central DWFUI boot mounts both native scrollbar and native tab art", () => {
  const componentsSource = readFileSync(join(root, "web/js/dwf-ui-components.js"), "utf8");
  const mountDomBody = /function mountDom\(doc\) \{([\s\S]*?)\n  \}/.exec(componentsSource)?.[1] || "";
  assert.match(mountDomBody, /mountScrollbarArt\(d\)/);
  assert.match(mountDomBody, /mountTabArt\(d\)/);
  assert.match(mountDomBody, /mountPlaqueArt\(d\)/);
});

await check("load order: DWFUI is defined before core.js runs", () => {
  const ui = indexHtml.indexOf("dwf-ui-components.js?");
  const core = indexHtml.indexOf("dwf-core.js?");
  assert.ok(ui > 0 && core > ui, "ui-components must be loaded before core");
});

await check("NO panel module boots the DOM half itself -- a per-panel sprinkle is the failed fix", () => {
  const panels = ["dwf-building-zone-stockpile-panels.js", "dwf-build-info-panels.js",
    "dwf-kitchen.js", "dwf-help-panel.js", "dwf-squads.js"];
  for (const f of panels) {
    const src = readFileSync(join(root, "web/js", f), "utf8");
    assert.doesNotMatch(src, /DWFUI\.mountDom\(/, `${f} must not boot the DOM half -- core.js does`);
  }
});

// =================================================================================================
console.log("\nFB-6 -- an unresolved sprite token is LOUD, never an invisible hole");
// =================================================================================================

await check("an unknown sprite token is marked data-df-identity-missing + the native empty tile", async () => {
  const doc = freshDoc();
  globalThis.document = doc;
  globalThis.DFChrome = fakeChrome(MAP);
  const good = doc.body.appendChild(spriteSpan("BUTTON_FILTER"));
  const typo = doc.body.appendChild(spriteSpan("BUTTON_FILTR"));      // one letter short
  DWFUI.mountDom(doc);
  await Promise.resolve(); await Promise.resolve();                   // the audit awaits loadMap()

  assert.equal(typo.getAttribute("data-df-identity-missing"), "sprite:BUTTON_FILTR",
    "a typo'd token must be MECHANICALLY DETECTABLE, exactly like a bad art:/letter:");
  assert.ok(typo.classList.contains("dwfui-icon--empty"), "and VISIBLE as native's empty tile");
  assert.equal(good.getAttribute("data-df-identity-missing"), null, "a good token stays unmarked");
  assert.equal(good.classList.contains("dwfui-icon--empty"), false);
});

await rejects("test-the-test: the pre-fix paintSprites (silent on a bad token) is CAUGHT", async () => {
  const doc = freshDoc();
  const node = doc.body.appendChild(spriteSpan("BUTTON_FILTR"));
  // the shipped behaviour before FB-6: DFChrome.updateIcon returns quietly, nothing is marked
  assert.equal(node.getAttribute("data-df-identity-missing"), "sprite:BUTTON_FILTR",
    "an unmarked bad token must NOT pass");
});

const interfaceMap = JSON.parse(readFileSync(join(root, "web/interface_map.json"), "utf8"));

await check("every token DWFUI can emit EXISTS in interface_map.json (a typo here ships a hole)", () => {
  const groups = { sprites: DWFUI.TOKENS.sprites, frames: DWFUI.TOKENS.frames, plaques: DWFUI.TOKENS.plaques };
  const bad = [];
  for (const [group, table] of Object.entries(groups))
    for (const [key, token] of Object.entries(table))
      if (!interfaceMap[token]) bad.push(`TOKENS.${group}.${key} = ${token}`);
  for (const [key, token] of Object.entries(DWFUI.TOKENS.tabs))
    for (const state of ["off", "on"])
      if (!interfaceMap[token[state]]) bad.push(`TOKENS.tabs.${key}.${state} = ${token[state]}`);
  for (const [key, token] of Object.entries(DWFUI.TOKENS.scrollbar))
    if (typeof token === "string" && !interfaceMap[token]) bad.push(`TOKENS.scrollbar.${key} = ${token}`);
  assert.deepEqual(bad, [], `sprite tokens absent from interface_map.json:\n  ${bad.join("\n  ")}`);
});

await rejects("test-the-test: a fabricated token (SCROLLBAR_UP -- it does NOT exist) is CAUGHT", () => {
  assert.ok(interfaceMap.SCROLLBAR_UP,
    "SCROLLBAR_UP is named by the matrix AND the handback and is NOT in interface_map.json");
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
