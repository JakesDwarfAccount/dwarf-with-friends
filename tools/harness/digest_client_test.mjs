// digest_client_test.mjs -- offline tests for web/js/dwf-digest.js
//
//   node tools/harness/digest_client_test.mjs
// Exit: 0 PASS, 1 FAIL.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(here, "../../web/js/dwf-digest.js"), "utf8");
const require = createRequire(import.meta.url);
const DWFUI = require(path.resolve(here, "../../web/js/dwf-ui-components.js"));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function eq(actual, expected, name) {
  ok(Object.is(actual, expected), name, `expected=${expected} actual=${actual}`);
}
const tick = () => new Promise(r => setImmediate(r));

function makeEl(tag) {
  const el = {
    tag, id: "", className: "", type: "", textContent: "", style: {}, children: [], parentNode: null,
    attrs: {}, handlers: {}, _innerHTMLWrites: [],
    set innerHTML(v) { this._innerHTMLWrites.push(String(v)); },
    get innerHTML() { return this._innerHTMLWrites.join(""); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] || null; },
    querySelector() { return null; },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    dispatch(t, ev) { (this.handlers[t] || []).forEach(fn => fn(ev || { target: this })); },
  };
  return el;
}
function collectText(el, out = []) {
  if (!el) return out;
  if (el.textContent) out.push(el.textContent);
  if (el.attrs && el.attrs["aria-label"]) out.push(el.attrs["aria-label"]);
  (el.children || []).forEach(c => collectText(c, out));
  return out;
}
function collectInnerWrites(el, out = []) {
  if (!el) return out;
  if (el._innerHTMLWrites && el._innerHTMLWrites.length) out.push(...el._innerHTMLWrites);
  (el.children || []).forEach(c => collectInnerWrites(c, out));
  return out;
}
function makeDoc() {
  const byId = {};
  const docHandlers = {};
  const doc = {
    createElement(tag) { return makeEl(tag); },
    getElementById(id) {
      if (doc.head.id === id) return doc.head;
      if (doc.body.id === id) return doc.body;
      return byId[id] || findById(doc.body, id) || findById(doc.head, id);
    },
    addEventListener(t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (docHandlers[t]) docHandlers[t] = docHandlers[t].filter(f => f !== fn); },
    _fire(t, ev) { (docHandlers[t] || []).slice().forEach(fn => fn(ev || {})); },
  };
  doc.head = makeEl("head");
  doc.documentElement = makeEl("html");
  doc.body = makeEl("body");
  function findById(el, id) {
    if (!el) return null;
    if (el.id === id) return el;
    for (const c of el.children || []) {
      const found = findById(c, id);
      if (found) return found;
    }
    return null;
  }
  const origHeadAppend = doc.head.appendChild.bind(doc.head);
  doc.head.appendChild = (el) => { if (el.id) byId[el.id] = el; return origHeadAppend(el); };
  return doc;
}

function boot(opts = {}) {
  const store = Object.assign({}, opts.store || {});
  const fetchLog = [];
  const pages = (opts.pages || []).slice();
  const g = {
    window: null,
    DWFUI,
    document: opts.noDom ? null : makeDoc(),
    URLSearchParams,
    Date,
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
    },
    fetch(url) {
      fetchLog.push(String(url));
      const page = pages.length ? pages.shift() : { nextReportId: 1, reports: [] };
      return Promise.resolve({ ok: true, json: async () => page });
    },
    module: { exports: {} },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  vm.runInContext(SRC, ctx, { filename: "dwf-digest.js" });
  return { g, store, fetchLog, api: g.DwfDigest, pure: g.module.exports };
}

function cat(summary, id) {
  return summary.categories.find(c => c.id === id);
}

(async function run() {
  console.log("# digest pure aggregation");
  {
    const e = boot({ noDom: true });
    const summary = e.pure.aggregateReports([
      { id: 1, typeKey: "BIRTH_CITIZEN", alertType: 9, text: "Atir has been born." },
      { id: 2, typeKey: "MIGRANT_ARRIVAL", alertType: 3, text: "Some migrants arrived." },
      { id: 3, typeKey: "UNIT_DEATH", alertType: 21, text: "Urist has died." },
      { id: 4, typeKey: "BUILDING_COMPLETED", alertType: 0, text: "A new carpenter's workshop was completed." },
      { id: 5, typeKey: "MEGABEAST_ARRIVAL", alertType: 4, text: "A forgotten beast has arrived!" },
      { id: 6, typeKey: "MEGABEAST_ARRIVAL", alertType: 4, text: "continuation text", continuation: true },
    ]);
    eq(summary.total, 5, "continuations skipped and categorized total counted");
    eq(cat(summary, "citizens").count, 2, "citizens count includes births and migrants");
    eq(cat(summary, "deaths").count, 1, "deaths count");
    eq(cat(summary, "builds").count, 1, "completed build count");
    eq(cat(summary, "events").count, 1, "event count from stinger typeKey vocabulary");
    ok(cat(summary, "events").headlines[0].includes("forgotten beast"), "headline line retained");
  }

  console.log("# first join seeds only");
  {
    const e = boot({ pages: [{ nextReportId: 44, reports: [{ id: 43, typeKey: "MEGABEAST_ARRIVAL", text: "Backlog" }] }] });
    const result = await e.api.onJoinComplete({ player: "host" });
    await tick();
    eq(result, null, "first join returns no digest panel");
    eq(e.store[e.pure.storageKey("host")], "44", "first join advances watermark to host cursor");
    ok(e.fetchLog[0].includes("since=-1") && e.fetchLog[0].includes("max=1"), "first join uses seed-sized report request");
    eq(e.g.document.getElementById("dfDigestHost"), null, "first join does not render panel");
  }

  console.log("# returning instant delta is silent");
  {
    const seeded = {};
    const tmp = boot({ noDom: true });
    seeded[tmp.pure.storageKey("host")] = "44";
    const e = boot({ store: seeded, pages: [{ nextReportId: 44, reports: [] }] });
    const result = await e.api.onJoinComplete({ player: "host" });
    eq(result, null, "empty returning delta returns null");
    eq(e.store[e.pure.storageKey("host")], "44", "empty delta keeps watermark current");
    eq(e.g.document.getElementById("dfDigestHost"), null, "empty delta renders no panel");
  }

  console.log("# returning digest renders and advances");
  {
    const seeded = {};
    const tmp = boot({ noDom: true });
    seeded[tmp.pure.storageKey("host")] = "44";
    const e = boot({ store: seeded, pages: [{ nextReportId: 51, reports: [
      { id: 45, typeKey: "BIRTH_CITIZEN", alertType: 9, text: "Rigoth has been born." },
      { id: 46, typeKey: "UNIT_DEATH", alertType: 21, text: "Domas has died." },
      { id: 47, typeKey: "BUILDING_COMPLETED", text: "A mason's workshop was completed." },
      { id: 48, typeKey: "AMBUSH_AMBUSHER", alertType: 5, text: "An ambush! Drive them out!" },
    ] }] });
    const result = await e.api.onJoinComplete({ playerName: "host" });
    eq(result.total, 4, "returning digest summary returned");
    eq(e.store[e.pure.storageKey("host")], "51", "returning digest advances watermark");
    const host = e.g.document.getElementById("dfDigestHost");
    ok(!!host, "digest panel rendered");
    const text = collectText(host).concat(collectInnerWrites(host)).join(" | ");
    ok(text.includes("Since you left") && text.includes("New citizens (1)") && text.includes("Sieges &amp; events (1)"), "panel shows category counts");
    e.g.document._fire("pointerdown", { target: e.g.document.body });
    eq(e.g.document.getElementById("dfDigestHost"), null, "any click dismisses panel without a backdrop");
  }

  console.log("# XSS safety: report text is escaped by the shared DWFUI builder");
  {
    const seeded = {};
    const tmp = boot({ noDom: true });
    seeded[tmp.pure.storageKey("host")] = "1";
    const payload = "<img src=x onerror=alert(1)>";
    const e = boot({ store: seeded, pages: [{ nextReportId: 3, reports: [
      { id: 2, typeKey: "UNIT_DEATH", alertType: 21, text: payload },
    ] }] });
    await e.api.onJoinComplete({ player: "host" });
    const host = e.g.document.getElementById("dfDigestHost");
    const markup = collectInnerWrites(host).join("");
    ok(markup.includes("&lt;img src=x onerror=alert(1)&gt;"), "payload is preserved as escaped text");
    ok(!markup.includes(payload), "payload is never assigned as executable markup");
  }

  // ---- WAVE-5 / R1: the digest's PRIVATE 8-HEX PALETTE is gone ---------------------------------
  // The injected style block hard-coded its own colour table, and every colour in it was a
  // SUPERSEDED one -- the LEGACY gold #d89b27 (the MEASURED native frame gold is #ffbf01) and
  // "parchment" #f2e6cf, a tone that appears in ZERO DF menus. This is a SOURCE assertion on
  // purpose: the rule it enforces (drift-guard R1) is a source rule, and a hex literal cannot hide.
  {
    const digestSrc = SRC;
    const style = digestSrc.slice(digestSrc.indexOf("st.textContent = ["),
      digestSrc.indexOf("(doc.head || doc.documentElement).appendChild(st)"));
    const hex = style.match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?/g) || [];
    ok(hex.length === 0, "the injected style block declares NO colour hex literals", `found ${hex.join(", ")}`);
    // Named explicitly: the three tones the matrix called SUPERSEDED must not come back. Scoped to
    // the EMITTED style, not the whole file -- the comment above the block names them on purpose, so
    // a future reader knows exactly which values were retired and what replaced them.
    ok(!/#d89b27|#f2e6cf|#ffd45c/.test(style),
      "the superseded legacy gold / parchment tones are gone from the emitted style");
    for (const token of ["--dwfui-surface", "--dwfui-gold", "--dwfui-text-body", "--dwfui-text-title",
      "--dwfui-text-secondary", "--dwfui-gold-bevel-dark", "--dwfui-font-face"])
      ok(style.includes(`var(${token})`), `the digest consumes the shared token ${token}`);
    // The block is NOT deleted: it still carries the overlay's own geometry, which no --dwfui-* rule
    // provides and which this lane may not move into CSS. Deleting it would unposition the panel.
    ok(style.includes("position:fixed"), "the overlay's layout rules survive the palette removal");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
