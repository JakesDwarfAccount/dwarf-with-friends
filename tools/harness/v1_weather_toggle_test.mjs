// v1_weather_toggle_test.mjs -- WTHR-1: the "Weather particles (rain/snow overlay)" setting.
//
// The overlay under test (web/js/dwf-weather.js) is an INVENTED ambience layer: an animated
// screen-space rain/snow particle system the browser client paints ABOVE both renderers. Native
// DF has no such particle system, so the setting exists purely so players who dislike it can turn
// it off. This test pins:
//   A. the setting exists, defaults ON, and persists across reloads (dfplex.weatherParticles).
//   B. OFF suppresses the particle DRAW at multiple wall-clock samples (rain AND snow); ON
//      restores it live (no reload). Includes a test-the-test guard on the draw detector.
//   C. single-gate-covers-both-renderers: neither dwf-gl.js nor dwf-tiles.js draws precipitation
//      (the overlay is a separate DOM canvas above both), so one gate is behavioral parity.
//   D. registration: dwf-controls-placement.js exposes it as a DFClientPrefs row (the shared DWFUI
//      switch), delegating to DwfWeather -- no hand-built control, no duplicated state.
//   E. NEGATIVE (owner-required): with the toggle OFF, NATIVE ground snow / spatter tiles still
//      render. The gate must touch the invented particle overlay ONLY, never the streamed world
//      data (snow/mud/blood spatter is native DF world state -- dwf-tiles.js's spatterFamilyFor).
//
// Run: node tools/harness/v1_weather_toggle_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEATHER_PATH = path.resolve(__dirname, "../../web/js/dwf-weather.js");
const TILES_PATH = path.resolve(__dirname, "../../web/js/dwf-tiles.js");
const GL_PATH = path.resolve(__dirname, "../../web/js/dwf-gl.js");
const CP_PATH = path.resolve(__dirname, "../../web/js/dwf-controls-placement.js");
const SPATTER_MAP_PATH = path.resolve(__dirname, "../../web/spatter_map.json");
const INDEX_PATH = path.resolve(__dirname, "../../web/index.html");

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// ---- localStorage double (shared backing lets us reload the module and re-read persisted state) --
function makeStorage(backing) {
  return {
    backing,
    getItem: (k) => (k in backing ? backing[k] : null),
    setItem: (k, v) => { backing[k] = String(v); },
  };
}

// ---- a DOM sandbox whose canvas 2d context RECORDS draw ops -------------------------------------
// ops = fill/stroke/arc/moveTo/lineTo (any actual particle painting). clears = clearRect (the
// idle/suppressed path). requestAnimationFrame captures the loop callback so we can drive exact
// frames at chosen wall-clock timestamps.
function loadWeatherDom({ search = "", storage = null, weather = 2, outside = true } = {}) {
  const rec = { ops: 0, clears: 0 };
  const ctx = {
    setTransform() {}, clearRect() { rec.clears++; },
    beginPath() {}, moveTo() { rec.ops++; }, lineTo() { rec.ops++; },
    arc() { rec.ops++; }, fill() { rec.ops++; }, stroke() { rec.ops++; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
  };
  const canvasEl = { style: {}, width: 0, height: 0, getContext: () => ctx };
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.location = { search };
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.devicePixelRatio = 1;
  let rafCb = null;
  sandbox.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  sandbox.cancelAnimationFrame = () => { rafCb = null; };
  sandbox.addEventListener = () => {};
  sandbox.URLSearchParams = URLSearchParams;
  if (storage) sandbox.localStorage = storage;
  sandbox.document = {
    readyState: "complete",
    addEventListener() {},
    createElement() { return canvasEl; },
    body: { appendChild() {} },
  };
  // Weather DATA source (never gated): a live storm with sky visible on screen.
  sandbox.DwfTiles = { getLatest: () => ({ env: { weather }, tiles: outside ? [{ outside: true }] : [] }) };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(WEATHER_PATH, "utf8"), sandbox, { filename: WEATHER_PATH });
  const frame = (ts) => { const cb = rafCb; if (cb) { rafCb = null; cb(ts); } };
  return { api: sandbox.DwfWeather, rec, frame };
}

function drawOverSamples(inst, samples) {
  let ops = 0, clears = 0;
  for (const ts of samples) { inst.rec.ops = 0; inst.rec.clears = 0; inst.frame(ts); ops += inst.rec.ops; clears += inst.rec.clears; }
  return { ops, clears };
}

const SAMPLES = [16, 120, 480, 960, 2000, 5000];   // multiple wall-clock samples across a "storm"

console.log("WTHR-1: weather-particles toggle");

// ---- A. exists + default ON + persistence -------------------------------------------------------
const storeA = makeStorage({});
const a1 = loadWeatherDom({ storage: storeA });
check("setting exposed: DwfWeather.setEnabled/isEnabled are functions",
  a1.api && typeof a1.api.setEnabled === "function" && typeof a1.api.isEnabled === "function");
check("default ON when nothing is stored", a1.api.isEnabled() === true);

a1.api.setEnabled(false);
check("setEnabled(false) persists dfplex.weatherParticles = \"0\"", storeA.backing["dfplex.weatherParticles"] === "0");
const a2 = loadWeatherDom({ storage: storeA });   // fresh module load, SAME storage
check("OFF persists across reload", a2.api.isEnabled() === false);
a2.api.setEnabled(true);
check("setEnabled(true) persists dfplex.weatherParticles = \"1\"", storeA.backing["dfplex.weatherParticles"] === "1");
const a3 = loadWeatherDom({ storage: storeA });
check("ON persists across reload", a3.api.isEnabled() === true);

// ---- B. OFF suppresses the draw at multiple samples; ON restores live ---------------------------
const snow = loadWeatherDom({ weather: 2 });   // snow, default ON
const onSnow = drawOverSamples(snow, SAMPLES);
check("ON (snow): particles draw at every wall-clock sample", onSnow.ops > 0);

snow.api.setEnabled(false);
const offSnow = drawOverSamples(snow, SAMPLES);
check("OFF (snow): ZERO particle draw ops across all wall-clock samples", offSnow.ops === 0);
check("OFF (snow): overlay is cleared, not left frozen mid-storm", offSnow.clears > 0);

snow.api.setEnabled(true);
const reSnow = drawOverSamples(snow, SAMPLES);
check("ON restores the draw live (no reload)", reSnow.ops > 0);

const rain = loadWeatherDom({ weather: 1 });   // the OTHER precipitation kind
const onRain = drawOverSamples(rain, SAMPLES);
check("ON (rain): particles draw at every wall-clock sample", onRain.ops > 0);
rain.api.setEnabled(false);
const offRain = drawOverSamples(rain, SAMPLES);
check("OFF (rain): ZERO particle draw ops across all wall-clock samples", offRain.ops === 0);

// TEST-THE-TEST: the recorder must actually register draws when the gate is open -- otherwise the
// OFF=0 assertions above would pass against a dead detector. A gate regression (dropping `enabled`)
// would make OFF look like ON, and these ON>0 samples are exactly what would then trip.
check("TEST-THE-TEST: draw detector registers ops when enabled (snow+rain), so OFF=0 is meaningful",
  onSnow.ops > 0 && reSnow.ops > 0 && onRain.ops > 0);
// And OFF must genuinely differ from ON (not both zero from a broken harness).
check("TEST-THE-TEST: ON and OFF are distinguishable (ON draws, OFF does not)",
  onSnow.ops > 0 && offSnow.ops === 0 && onRain.ops > 0 && offRain.ops === 0);

// data stream is never gated: even OFF, weather state keeps flowing so re-enable is instant.
const offInst = loadWeatherDom({ weather: 2 });
offInst.api.setEnabled(false);
// (no throw, state readable) -- drive frames while off, then flip on and confirm immediate draw.
drawOverSamples(offInst, SAMPLES);
offInst.api.setEnabled(true);
const resumed = drawOverSamples(offInst, [16, 32]);
check("re-enabling mid-storm resumes instantly (pool/state kept while off)", resumed.ops > 0);

// ---- C. one gate == both renderers (overlay is above both; neither renderer draws precip) --------
const glSrc = fs.readFileSync(GL_PATH, "utf8");
const tilesSrc = fs.readFileSync(TILES_PATH, "utf8");
check("dwf-gl.js does not draw the precipitation overlay (no DwfWeather dependency)", !/DwfWeather/.test(glSrc));
check("dwf-tiles.js does not draw the precipitation overlay (no DwfWeather dependency)", !/DwfWeather/.test(tilesSrc));

// ---- D. registration is a DWFUI switch row (no hand-built control, delegates to DwfWeather) ------
const cpSrc = fs.readFileSync(CP_PATH, "utf8");
check("DFClientPrefs registers a weatherParticles row with a plain label",
  /id:\s*"weatherParticles"/.test(cpSrc) && /Weather particles \(rain\/snow overlay\)/.test(cpSrc));
check("the pref delegates to DwfWeather (single source of truth, no duplicated state)",
  /DwfWeather\.isEnabled/.test(cpSrc) && /DwfWeather\.setEnabled/.test(cpSrc));
// The row renders through dwf-settings.js's existing DFClientPrefs -> DWFUI.switchHtml path; assert
// there is no bespoke <input>/<button> added for weather in either module.
check("no hand-built weather control smuggled into controls-placement",
  !/weather[\s\S]{0,80}<(?:input|button|select)\b/i.test(cpSrc));

// ---- F. REGRESSION (live-fix WTHR-2): the settings-panel wiring path, end-to-end -----------------
// The live failure the direct-call cells above could not see. The Settings > Interface toggle is a
// DWFUI switch -- a <label> wrapping <input type=checkbox>. A single user click on the LABEL fires
// the label's click handler TWICE (the real click PLUS the click the label re-dispatches through its
// associated checkbox, which bubbles back up). The original wiring was
// `row.addEventListener("click", () => set(id, !get(id)))`, so the two fires flipped the state twice
// and cancelled out: the persisted setting (and DwfWeather's draw gate) never changed -> rain kept
// falling, and reopening the panel re-read get()===true so the switch showed back ON -- while the
// native checkbox had toggled exactly ONCE, so it *looked* OFF. Direct setEnabled()/set() calls
// (cells A/B) bypass the label entirely, which is why the offline suite was green while the deployed
// build was broken. This cell runs the REAL wiring block extracted verbatim from dwf-settings.js
// against a DOM double that reproduces that exact label double-dispatch, driving the REAL DwfWeather
// draw gate -- so a regression back to the click pattern fails right here.
const SETTINGS_PATH = path.resolve(__dirname, "../../web/js/dwf-settings.js");
const settingsSrc = fs.readFileSync(SETTINGS_PATH, "utf8");

// Generic balanced-slice: from `marker`, take through the balanced (open..close) group, optionally
// including a trailing ';'. Lets us lift a whole wiring block verbatim out of dwf-settings.js.
function sliceBalanced(src, marker, open, close, wantSemicolon) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  // Search for the opening delimiter from the END of the marker, so parens/braces INSIDE the marker
  // text (e.g. the `querySelectorAll("[data-pref]")` call) don't get mistaken for the group we want.
  let i = src.indexOf(open, start + marker.length - 1);
  if (i < 0) return null;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) { i++; break; } }
  }
  if (wantSemicolon) { while (i < src.length && src[i] !== ";") i++; if (src[i] === ";") i++; }
  return src.slice(start, i);
}

// -- minimal DOM double that reproduces the browser's <label>-wraps-<checkbox> double-dispatch ------
function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
    toggle: (c, on) => { const has = on === undefined ? !set.has(c) : !!on; if (has) set.add(c); else set.delete(c); return has; },
  };
}
function makeNode(tag) {
  const listeners = {};
  const node = {
    tagName: tag.toUpperCase(), parentNode: null, children: [], dataset: {}, type: "", checked: false,
    classList: makeClassList(),
    addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
    _fire(t, ev) { (listeners[t] || []).slice().forEach((fn) => fn(ev)); if (node.parentNode) node.parentNode._fire(t, ev); },
    querySelector(sel) {
      if (sel === 'input[type="checkbox"]') return node.children.find((c) => c.tagName === "INPUT" && c.type === "checkbox") || null;
      return null;
    },
  };
  return node;
}
function buildSwitchRow(dataset, checked) {
  const label = makeNode("label");
  Object.assign(label.dataset, dataset);
  label.classList.toggle("on", checked);
  const input = makeNode("input");
  input.type = "checkbox"; input.checked = checked;
  input.parentNode = label; label.children.push(input);
  const counts = { click: 0, change: 0 };
  label.addEventListener("click", () => { counts.click++; });     // instrumentation only
  input.addEventListener("change", () => { counts.change++; });   // instrumentation only
  // A real user clicking the LABEL area (not the input): native toggles the checkbox once and fires
  // `change` once; the label then receives TWO `click` events (its own + the re-dispatched one).
  label._userClick = function () {
    input.checked = !input.checked;
    input._fire("change", { type: "change", target: input });
    label._fire("click", { type: "click", target: label });
    input._fire("click", { type: "click", target: input });
  };
  return { label, input, counts };
}

// The generic contract EVERY label-wrapped switch wireInterface owns must satisfy: one user click on
// the label flips the setting exactly ONCE (never a self-cancelling double), the checkbox + row class
// track the state that actually applied (no desync), and a second click flips it back. The
// test-the-test proves the DOM double really reproduces the label double-dispatch (2 clicks / 1
// change) that caused the live bug -- otherwise these could pass against a footgun never modelled.
function assertSwitchTogglesOnce(tag, sw, readApplied) {
  const before = readApplied();
  sw.label._userClick();
  const firstCounts = { click: sw.counts.click, change: sw.counts.change };
  const off = readApplied();
  check(`${tag}: one label click flips the setting exactly ONCE (not a self-cancelling double)`, off === !before);
  check(`${tag}: checkbox AND row visual match the applied state (no desync)`,
    sw.input.checked === off && sw.label.classList.contains("on") === off);
  sw.label._userClick();
  const on = readApplied();
  check(`${tag}: a second click flips it back and stays in sync`,
    on === before && sw.input.checked === on && sw.label.classList.contains("on") === on);
  check(`${tag}: TEST-THE-TEST label double-fires \`click\` while \`change\` fires once (footgun modelled)`,
    firstCounts.click === 2 && firstCounts.change === 1);
}

// eslint-disable-next-line no-new-func -- run the REAL wiring source, not a re-implementation of it
const runBlock = (block, panel, root, panelFrameEnabled) =>
  new Function("panel", "root", "panelFrameEnabled", block)(panel, root, panelFrameEnabled);

// ---- F1: the weatherParticles pref row (the reported bug) drives the REAL DwfWeather draw gate ----
const prefWiring = sliceBalanced(settingsSrc, 'panel.querySelectorAll("[data-pref]").forEach(', "(", ")", true);
check("regression: [data-pref] wiring block located in dwf-settings.js", !!prefWiring);
check("regression: [data-pref] wiring targets the inner checkbox + `change`, not a label `click`",
  /querySelector\(\s*['"]input\[type=/.test(prefWiring || "") &&
  /["']change["']/.test(prefWiring || "") &&
  !/row\.addEventListener\(\s*["']click["']/.test(prefWiring || ""));

const regStore = makeStorage({});
const wx = loadWeatherDom({ weather: 1, storage: regStore });   // rain, default ON
const regRoot = {
  localStorage: regStore,
  DwfWeather: wx.api,
  DFClientPrefs: {
    list() {
      return [{ id: "weatherParticles",
        get: () => (wx.api && wx.api.isEnabled ? wx.api.isEnabled() : true),
        set: (on) => { try { if (wx.api && wx.api.setEnabled) wx.api.setEnabled(!!on); } catch (_) {} } }];
    },
    get(id) { const p = this.list().find((x) => x.id === id); return p ? !!p.get() : undefined; },
    set(id, on) { const p = this.list().find((x) => x.id === id); if (p) p.set(!!on); },
  },
};
const wsw = buildSwitchRow({ pref: "weatherParticles" }, true);
runBlock(prefWiring, { querySelectorAll: (sel) => (sel === "[data-pref]" ? [wsw.label] : []), querySelector: () => null }, regRoot);

// The generic switch contract (flips once, no desync, double-fire modelled)...
assertSwitchTogglesOnce("weatherParticles", wsw, () => wx.api.isEnabled());
// ...plus the weather-specific evidence that flipping the switch actually gates the live rain draw.
check("regression: OFF persists to dfplex.weatherParticles = \"0\" through the wiring",
  (wsw.label._userClick(), regStore.backing["dfplex.weatherParticles"] === "0"));   // now OFF
check("regression: rain STOPS drawing immediately after the switch is clicked off",
  drawOverSamples(wx, SAMPLES).ops === 0);
wsw.label._userClick();                                                             // back ON
check("regression: rain RESUMES live after the switch is clicked back on (no reload)",
  wx.api.isEnabled() === true && drawOverSamples(wx, SAMPLES).ops > 0);

// ---- F2: the movable-panels (panelframe) toggle -- same DWFUI switch, same double-fire class ------
const pfWiring = sliceBalanced(settingsSrc,
  'var panelFrameToggle = panel.querySelector(\'[data-dfs-toggle="panelframe"]\');', "{", "}", false);
check("regression: panelframe wiring block located in dwf-settings.js", !!pfWiring);
check("regression: panelframe wiring targets the inner checkbox + `change`, not a label `click`",
  /querySelector\(\s*['"]input\[type=/.test(pfWiring || "") &&
  /["']change["']/.test(pfWiring || "") &&
  !/panelFrameToggle\.addEventListener\(\s*["']click["']/.test(pfWiring || ""));

const pfRoot = {
  localStorage: makeStorage({}),
  DFPanelFrame: { _on: true, setEnabled(v) { this._on = !!v; }, get enabled() { return this._on; } },
};
const panelFrameEnabled = () => {
  try { return pfRoot.DFPanelFrame ? pfRoot.DFPanelFrame.enabled : pfRoot.localStorage.getItem("dwf.panelFrame.enabled") !== "0"; }
  catch (_) { return true; }
};
const psw = buildSwitchRow({ dfsToggle: "panelframe" }, true);
runBlock(pfWiring,
  { querySelectorAll: () => [], querySelector: (sel) => (sel === '[data-dfs-toggle="panelframe"]' ? psw.label : null) },
  pfRoot, panelFrameEnabled);
assertSwitchTogglesOnce("panelframe", psw, () => panelFrameEnabled());

// ---- E. NEGATIVE: toggle OFF leaves native snow / spatter tiles rendering ------------------------
// Load the REAL dwf-tiles.js alongside dwf-weather.js in one global scope, flip the weather toggle
// OFF, and confirm the native world-data spatter path is completely unaffected (frozen-water spatter
// still classifies as SNOW and is still visible -> still drawn). This is the boundary the owner
// pinned: the gate must NOT touch streamed native snow/spatter.
const realSpatterMap = JSON.parse(fs.readFileSync(SPATTER_MAP_PATH, "utf8"));
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
const storeC = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.localStorage = { getItem: (k) => (k in storeC ? storeC[k] : null), setItem: (k, v) => { storeC[k] = String(v); } };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.URLSearchParams = URLSearchParams;
globalThis.Image = class { constructor() { this.onload = null; this.onerror = null; this._src = ""; this.width = 32; this.height = 32; } set src(v) { this._src = v; } get src() { return this._src; } };
globalThis.document = {
  hidden: false, readyState: "complete",
  addEventListener() {}, getElementById() { return null; },
  createElement() { return new FakeCanvasEl(); },
  body: { appendChild() {} },
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("spatter_map.json") !== -1) return { ok: true, json: async () => realSpatterMap };
  return { ok: false, json: async () => null };
};

async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > (maxMs || 1000)) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

(async function negative() {
  vm.runInThisContext(fs.readFileSync(TILES_PATH, "utf8"), { filename: TILES_PATH });
  const DwfTiles = globalThis.DwfTiles;
  DwfTiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
  vm.runInThisContext(fs.readFileSync(WEATHER_PATH, "utf8"), { filename: WEATHER_PATH });
  const DwfWeather = globalThis.DwfWeather;

  DwfWeather.setEnabled(false);   // <-- the weather-particle overlay is OFF for every assertion below
  await waitUntil(() => DwfTiles._spatterFamilyForTest({ mat_type: 6, state: 3 }) === "SNOW", 2000);

  check("negative precondition: weather particles are OFF during the spatter checks",
    DwfWeather.isEnabled() === false);
  check("OFF -> native frozen-water spatter STILL classifies as SNOW (ground snow renders)",
    DwfTiles._spatterFamilyForTest({ mat_type: 6, state: 3 }) === "SNOW");
  check("OFF -> a snow spatter above threshold is STILL visible (still drawn)",
    DwfTiles._spatterVisibleForTest(DwfTiles._spatterVisibleAmountForTest + 50) === true);
  check("OFF -> liquid-water spatter classification is untouched (WATER_SPATTER)",
    DwfTiles._spatterFamilyForTest({ mat_type: 6, state: 1 }) === "WATER_SPATTER");
  check("OFF -> mud/dust spatter families untouched",
    DwfTiles._spatterFamilyForTest({ mat_type: 12 }) === "MUD" && DwfTiles._spatterFamilyForTest({ mat_type: 9 }) === "DUST");
  // TEST-THE-TEST for the negative: the classifier is a live function, not a stubbed constant --
  // an unknown/undersized spatter is NOT force-classified as SNOW, so the SNOW result above is real.
  check("TEST-THE-TEST: spatter classifier is live (a sub-threshold amount is NOT visible)",
    DwfTiles._spatterVisibleForTest(1) === false);

  // ---- cache-bust presence: every asset we changed carries the -wthr1 suffix -------------------
  const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");
  check("index.html cache-busts dwf-weather.js with -wthr1", /dwf-weather\.js\?v=[^"']*-wthr1/.test(indexSrc));
  check("index.html cache-busts dwf-controls-placement.js with -wthr1", /dwf-controls-placement\.js\?v=[^"']*-wthr1/.test(indexSrc));
  check("index.html cache-busts dwf-settings.js with -wthr2 (the live-fix asset)", /dwf-settings\.js\?v=[^"']*-wthr2/.test(indexSrc));

  console.log(failed === 0 ? "\nPASS (0 failures)" : `\nFAIL (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
})();
