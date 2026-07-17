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
// SPDX-License-Identifier: AGPL-3.0-only

// wt11_world3d_dom_test.mjs -- WT11 REOPEN + B237. Drives the REAL dwf-world3d.js through a
// minimal DOM + a stub WebGL2 context: opens the viewer, CLICKS its buttons, DRAGS its canvas, and
// asserts on what the renderer would actually put on screen (the captured MVP matrices).
//
// This exists because the original WT11 tests asserted on the source as a STRING and were green
// while every control in the viewer was dead. The causes, all regression-guarded here:
//
//   RC-1  A `.world3d-fallback { display: grid }` author rule beat the UA `[hidden]{display:none}`,
//         leaving an invisible full-screen glass pane over the canvas + header that ate every
//         pointerdown and click. Guarded by a real CSS-cascade evaluation (not a grep).
//   RC-2  dwf-core.js's CAPTURE-phase window listeners swallowed wheel + WASD/E/C before the
//         viewer could see them. Guarded by asserting the yields exist, each with a test-the-test.
//   B237  Two control sets overlapped at the bottom of the screen. Guarded by a LAYOUT ORACLE that
//         computes real rectangles from the real stylesheets (see "# B237" below) -- a class-name
//         assertion would have passed against the shipped bug, because the shipped bug had all the
//         right class names and the wrong geometry.
//
//   node tools/harness/wt11_world3d_dom_test.mjs
// Exit: 0 PASS, 1 FAIL.

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const readJs = n => fs.readFileSync(path.join(ROOT, "web", "js", n), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "web", "css", "dwf.css"), "utf8");

let passed = 0, failed = 0;
function check(value, name) {
  if (value) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}
function rejects(value, name) {
  if (!value) { passed++; console.log("  ok - (test-the-test) " + name); }
  else { failed++; console.log("  FAIL - (test-the-test) seeded-bad world was ACCEPTED: " + name); }
}

// =================================================================================================
// RC-1: a real CSS cascade evaluation. Answers "what `display` does an element with these classes
// and (maybe) the `hidden` attribute actually compute to?" -- honouring the rule that an AUTHOR
// `display` declaration beats the user-agent stylesheet's `[hidden] { display: none }` regardless of
// specificity, because author origin outranks user-agent origin. That single fact is the whole bug.
// =================================================================================================
function parseRules(css) {
  const rules = [];
  css = css.replace(/\/\*[\s\S]*?\*\//g, ""); // comments first, or a `{` inside prose becomes a rule
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const decls = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    rules.push({ selectors: m[1].split(",").map(s => s.trim()), decls });
  }
  return rules;
}
// Matches a SINGLE compound selector (e.g. `.a`, `.a[hidden]`, `#id.b`) against our element. Rules
// with combinators are skipped -- we only model the standalone rules that decide this element.
function compoundMatches(sel, elem) {
  if (/[\s>+~]/.test(sel)) return false;
  const parts = sel.match(/(\.[\w-]+|#[\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*)/g);
  if (!parts) return false;
  return parts.every(p => {
    if (p.startsWith(".")) return elem.classes.includes(p.slice(1));
    if (p.startsWith("#")) return elem.id === p.slice(1);
    if (p.startsWith("[")) return !!elem.attrs[p.slice(1, -1)];
    return true; // bare tag: treat as matching (we only ever ask about our own divs)
  });
}
function computedDisplay(css, elem) {
  // user-agent origin first; any matching AUTHOR rule then overrides it.
  let display = elem.attrs.hidden ? "none" : "block";
  for (const rule of parseRules(css)) {
    if (!("display" in rule.decls)) continue;
    if (rule.selectors.some(s => compoundMatches(s, elem))) display = rule.decls.display;
  }
  return display;
}
// B237 needs one more thing from the cascade: DESCENDANT selectors (`body.world3d-mode #hud`) and
// the INLINE styles the 2D client writes (`#hoverInfo.style.display = "block"`), because the whole
// question is "while the viewer is open, is the map's chrome still in the layout?" and the honest
// answer depends on both. Origin/importance order, high to low:
//   author !important  >  inline  >  author  >  user-agent ([hidden])
function selectorMatches(sel, elem, ancestors) {
  const parts = sel.trim().split(/\s+/);           // descendant combinator only (all we use)
  if (parts.some(p => /[>+~]/.test(p))) return false;
  const target = parts[parts.length - 1];
  if (!compoundMatches(target, elem)) return false;
  let i = 0;
  for (const anc of ancestors) {                    // ancestors: outermost -> innermost
    if (i < parts.length - 1 && compoundMatches(parts[i], anc)) i++;
  }
  return i === parts.length - 1;
}
// elem: {id, classes, attrs, style:{display}}; ancestors: [{id,classes,attrs}, ...]
function computedDisplayIn(css, elem, ancestors = []) {
  let normal = elem.attrs && elem.attrs.hidden ? "none" : "block";
  let important = null;
  for (const rule of parseRules(css)) {
    const raw = rule.decls.display;
    if (raw == null) continue;
    if (!rule.selectors.some(s => selectorMatches(s, elem, ancestors))) continue;
    if (/!important/.test(raw)) important = raw.replace(/\s*!important\s*/, "").trim();
    else normal = raw;
  }
  if (important) return important;                          // author !important beats everything
  const inline = elem.style && elem.style.display;
  return inline || normal;                                  // then inline, then the author rule
}

console.log("# RC-1: the `hidden` fallback pane must not be a full-screen glass pane over the canvas");
{
  const shown = { id: "world3dFallback", classes: ["world3d-fallback"], attrs: {} };
  const hidden = { id: "world3dFallback", classes: ["world3d-fallback"], attrs: { hidden: true } };
  check(computedDisplay(CSS, hidden) === "none",
    "an element with [hidden] computes to display:none (it is really out of the layout)");
  check(computedDisplay(CSS, shown) !== "none",
    "without [hidden] the pane still displays (the WebGL-error message still works)");

  // The readouts sit over the canvas too -- they MUST NOT eat drags.
  const overlayHasNoPointer = cls => parseRules(CSS)
    .some(r => r.selectors.includes("." + cls) && r.decls["pointer-events"] === "none");
  check(overlayHasNoPointer("world3d-status"), ".world3d-status sets pointer-events:none");
  check(overlayHasNoPointer("world3d-hint"), ".world3d-hint sets pointer-events:none");

  // test-the-test: delete the guard and the ORIGINAL bug must come back.
  const broken = CSS.replace(/\.world3d-fallback\[hidden\]\s*\{[^}]*\}/, "");
  rejects(computedDisplay(broken, hidden) === "none",
    "without the [hidden] guard the pane stays displayed -- the shipped bug");
}

// =================================================================================================
console.log("\n# RC-2: dwf-core.js must YIELD its capture-phase input while the viewer is open");
// =================================================================================================
{
  const core = readJs("dwf-core.js");
  const controls = readJs("dwf-controls-placement.js");
  // The wheel handler is capture-phase on window and stopImmediatePropagation()s -- the 3D canvas
  // can NEVER see a wheel event unless this allowlist yields to it.
  const wheelYield = /closest\(\s*"[^"]*#world3dScreen[^"]*"\s*\)/.test(core);
  check(wheelYield, "core.js's wheel yield list includes #world3dScreen (so the canvas gets the wheel)");
  // Same for the camera keys (WASD/E/C), which have no useful event.target to test.
  const keyYield = /function\s+handleCameraKey[\s\S]{0,300}?world3DOwnsInput\(\)/.test(core);
  check(keyYield, "core.js's handleCameraKey bails out while the 3D viewer owns input");
  check(/DFWorld3D\s*&&\s*window\.DFWorld3D\.isOpen/.test(core),
    "the yield asks DFWorld3D.isOpen() rather than sniffing the DOM");
  check(/DFWorld3D[\s\S]{0,40}isOpen\(\)\s*\)\s*return/.test(controls),
    "controls-placement's fort-tool letter cascade yields too (E/Q/C/Z would fire designations)");

  rejects(/closest\(\s*"[^"]*#world3dScreen[^"]*"\s*\)/
    .test(core.replace("#world3dScreen, ", "")),
    "removing #world3dScreen from the yield list must fail the wheel assertion");
}

// =================================================================================================
// A minimal DOM + a stub WebGL2 context, so the REAL module runs end to end. The GL stub records
// every uniformMatrix4fv, which lets us assert on what would actually be on screen.
// =================================================================================================
let nextId = 0;
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null;
    this.attrs = Object.create(null); this.style = {};
    this.listeners = Object.create(null);
    this._classes = new Set();
    this.textContent = ""; this.hidden = false; this.disabled = false;
    this._id = nextId++;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._classes.add(x)),
      remove: (...c) => c.forEach(x => self._classes.delete(x)),
      contains: c => self._classes.has(c),
    };
  }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = v; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "class") String(v).split(/\s+/).filter(Boolean).forEach(c => this._classes.add(c));
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); }
  removeEventListener() {}
  focus() {}
  setPointerCapture() {} releasePointerCapture() {}
  getContext() { return GL; }
  set innerHTML(html) { this.children = parseHTML(html).map(c => (c.parentNode = this, c)); this._html = html; }
  get innerHTML() { return this._html || ""; }
  get clientWidth() { return 1200; }
  get clientHeight() { return 800; }
  descendants() { const out = []; const walk = n => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return this.descendants().filter(n => matches(n, sel)); }
  // Dispatch to the listeners this node really registered. If nothing is listening, the control is
  // dead -- which is exactly the failure this suite exists to catch.
  fire(type, ev = {}) {
    const e = Object.assign({ preventDefault() {}, stopPropagation() {}, type }, ev);
    const ls = this.listeners[type] || [];
    ls.forEach(fn => fn(e));
    return ls.length;
  }
}
function matches(node, sel) {
  sel = sel.trim();
  let m;
  if ((m = /^\[([^\]=]+)\]$/.exec(sel))) return node.hasAttribute(m[1]);
  if ((m = /^#([\w-]+)$/.exec(sel))) return node.attrs.id === m[1];
  if ((m = /^\.([\w-]+)$/.exec(sel))) return node._classes.has(m[1]);
  return node.tagName === sel.toUpperCase();
}
const VOID = new Set(["INPUT", "IMG", "BR", "HR", "META", "LINK", "CANVAS"]);
function parseHTML(html) {
  const roots = []; const stack = [];
  const re = /<(\/?)([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, closing, tag, attrs, selfClose, text] = m;
    const parent = stack[stack.length - 1];
    if (text != null) { if (parent && text.trim()) parent.textContent += text; continue; }
    if (closing) { stack.pop(); continue; }
    const el = new El(tag);
    const ar = /([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
    let a;
    while ((a = ar.exec(attrs || ""))) el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? "");
    (parent ? parent.children : roots).push(el);
    if (parent) el.parentNode = parent;
    if (!selfClose && !VOID.has(el.tagName)) stack.push(el);
  }
  return roots;
}

// ---- stub WebGL2 -------------------------------------------------------------------------------
const gpu = { mvp: null, mv: null, draws: 0, verts: 0 };
const GL = new Proxy({
  VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
  ARRAY_BUFFER: 5, FLOAT: 6, UNSIGNED_BYTE: 7, STATIC_DRAW: 8, DEPTH_TEST: 9,
  CULL_FACE: 10, BACK: 11, CCW: 12, COLOR_BUFFER_BIT: 13, DEPTH_BUFFER_BIT: 14, TRIANGLES: 15,
  createShader: () => ({}), shaderSource() {}, compileShader() {},
  getShaderParameter: () => true, getShaderInfoLog: () => "", deleteShader() {},
  createProgram: () => ({}), attachShader() {}, linkProgram() {},
  getProgramParameter: () => true, getProgramInfoLog: () => "",
  getUniformLocation: (_p, name) => name,
  createVertexArray: () => ({}), createBuffer: () => ({}),
  bindVertexArray() {}, bindBuffer() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
  enable() {}, cullFace() {}, frontFace() {}, clearColor() {}, bufferData() {},
  viewport() {}, clear() {}, useProgram() {},
  uniformMatrix4fv: (loc, _t, v) => { gpu[loc === "u_mvp" ? "mvp" : "mv"] = Array.from(v); },
  uniform3fv() {}, uniform1f() {}, uniform2f() {},
  drawArrays: (_m, _f, count) => { gpu.draws++; gpu.verts = count; },
}, { get: (t, k) => (k in t ? t[k] : () => {}) });

// ---- the fake world --------------------------------------------------------------------------
// 60 z-levels. Solid rock everywhere at or BELOW the camera z, plus a tower rising 4 levels ABOVE
// it -- so "add a layer above" has something real to reveal. `fill` lets a test mutate the world and
// prove that Refresh re-reads CURRENT state rather than replaying a cached field.
const WORLD = { z: 60, camz: 40, fill: 1 };
const solidTile = () => ({ tt: 1, shape: "WALL", mat: "STONE" });
function tileAt(_x, _y, wz) {
  if (!WORLD.fill) return null;
  if (wz <= WORLD.camz) return solidTile();      // the fort and the rock under it
  if (wz <= WORLD.camz + 4) return solidTile();  // a tower, only visible if you add layers ABOVE
  return null;                                   // open sky
}

// ---- boot -------------------------------------------------------------------------------------
const body = new El("body");
const doc = {
  body, hidden: false, readyState: "complete",
  createElement: t => new El(t),
  getElementById: id => body.descendants().find(n => n.attrs.id === id) || null,
  querySelector: s => body.querySelector(s),
  listeners: Object.create(null),
  addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); },
  fire(t, ev) {
    const e = Object.assign({ preventDefault() {}, stopPropagation() {}, target: body, type: t }, ev);
    (this.listeners[t] || []).forEach(fn => fn(e));
  },
};
// A VIRTUAL clock. The module's smoothing and its auto-refresh debounce are both time-driven, so a
// test that pumps frames in a tight loop (real dt ~= 0) would let neither ever advance -- the camera
// would creep instead of settling and every "did the view change?" assertion would be noise. Each
// pumped frame advances the clock by one 60fps tick, so the viewer behaves exactly as it would live.
let fakeNow = 1000;
let rafQueue = [];
const win = {
  document: doc, devicePixelRatio: 1, console,
  requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame: () => {},
  addEventListener() {},
  performance: { now: () => fakeNow },
};
win.window = win;
const ctx = vm.createContext(win);
for (const f of ["dwf-ui-components.js", "dwf-world3d-model.js",
  "dwf-voxelizer.js", "dwf-voxel-mesh.js", "dwf-world3d.js"]) {
  vm.runInContext(readJs(f), ctx, { filename: f });
}
win.DwfTiles = {
  getLatest: () => ({ origin: { x: 460, y: 460, z: WORLD.camz }, width: 80, height: 80 }),
  tileColor: () => [120, 110, 100],
};
win.DwfCache = {
  mapDims: () => ({ w: 1000, h: 1000, z: WORLD.z }),
  windowView: (ox, oy, z, w, h) => {
    const tiles = new Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles[y * w + x] = tileAt(ox + x, oy + y, z);
    return { tiles, width: w, height: h };
  },
};
// Pump RAF frames on the virtual clock (bounded, so a hang fails instead of spinning). 120 frames =
// ~2s of virtual time: enough for a chunked build to drain AND for the camera to settle on its goal,
// so a captured MVP is stable rather than mid-decay.
function pump(frames = 120) {
  for (let i = 0; i < frames && rafQueue.length; i++) {
    fakeNow += 16;
    const q = rafQueue; rafQueue = [];
    q.forEach(fn => fn());
  }
}
const W3D = win.DFWorld3D;
const $ = sel => doc.getElementById("world3dScreen").querySelector(sel);
// B237: the readouts are DWFUI statuses now -- the component owns the box, the module writes the copy.
const copy = sel => $(sel).querySelector(".dwfui-status-copy");
const statusText = () => copy("[data-world3d-status]").textContent;

// =================================================================================================
console.log("\n# the viewer opens, builds, and DRAWS (the whole pipeline, not a string match)");
// =================================================================================================
W3D.open();
pump();
const screen = doc.getElementById("world3dScreen");
check(!!screen && screen.classList.contains("open"), "open() puts #world3dScreen.open in the document");
check(body.classList.contains("world3d-mode"), "open() puts <body> into world3d-mode (B237: it is a MODE)");
check($("#world3dFallback").hidden === true, "the WebGL fallback pane is hidden when GL initialises");
check(gpu.draws > 0 && gpu.verts > 0, `the mesh reached the GPU (${gpu.verts.toLocaleString()} verts drawn)`);
check(/voxels/.test(statusText()) && /faces/.test(statusText()), "the status readout reports the built field");
check(/z 21–40 \(20 at\/below · 0 above\)/.test(statusText()),
  "the default slab is z 21..40: 20 layers at/below the camera, 0 above -- " + statusText().split("·")[0].trim());

// =================================================================================================
console.log("\n# CAMERA: drag orbits, wheel zooms, right-drag pans -- through the REAL listeners");
// =================================================================================================
const canvas = $("#world3dCanvas");
function mvpNow() { pump(); return gpu.mvp.slice(); }
{
  const before = mvpNow();
  const n = canvas.fire("pointerdown", { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  check(n > 0, "the canvas HAS a pointerdown listener (the glass pane used to eat this)");
  canvas.fire("pointermove", { clientX: 220, clientY: 140, pointerId: 1 });
  canvas.fire("pointerup", { pointerId: 1 });
  const after = mvpNow();
  check(before.some((v, i) => Math.abs(v - after[i]) > 1e-6), "dragging the canvas ORBITS the camera (the MVP changed)");

  const preZoom = mvpNow();
  const wheeled = canvas.fire("wheel", { deltaY: -240 });
  check(wheeled > 0, "the canvas HAS a wheel listener");
  const postZoom = mvpNow();
  check(preZoom.some((v, i) => Math.abs(v - postZoom[i]) > 1e-6), "the wheel ZOOMS the camera (the MVP changed)");

  const prePan = mvpNow();
  canvas.fire("pointerdown", { button: 2, clientX: 400, clientY: 400, pointerId: 2 });
  canvas.fire("pointermove", { clientX: 460, clientY: 430, pointerId: 2 });
  canvas.fire("pointerup", { pointerId: 2 });
  check(prePan.some((v, i) => Math.abs(v - mvpNow()[i]) > 1e-6), "right-drag PANS the camera (the MVP changed)");

  const preDz = mvpNow();
  canvas.fire("pointerdown", { button: 1, clientX: 400, clientY: 400, pointerId: 3 });
  canvas.fire("pointermove", { clientX: 400, clientY: 500, pointerId: 3 });
  canvas.fire("pointerup", { pointerId: 3 });
  check(preDz.some((v, i) => Math.abs(v - mvpNow()[i]) > 1e-6), "middle-drag DRAG-ZOOMS the camera (the MVP changed)");

  // test-the-test: a pointermove with no button held must do nothing.
  const idle = mvpNow();
  canvas.fire("pointermove", { clientX: 900, clientY: 900 });
  rejects(idle.some((v, i) => Math.abs(v - mvpNow()[i]) > 1e-6), "a move with no drag in progress must not move the camera");
}

// =================================================================================================
console.log("\n# Z-SLAB: buttons add/remove layers ABOVE and BELOW (the #1)");
// =================================================================================================
{
  const upInc = $("[data-world3d-up-inc]"), upDec = $("[data-world3d-up-dec]");
  const dnInc = $("[data-world3d-down-inc]"), dnDec = $("[data-world3d-down-dec]");
  check(!!upInc && !!upDec && !!dnInc && !!dnDec, "all four slab buttons exist in the DWFUI header");
  check(upDec.disabled === true, "'remove layer above' starts DISABLED (there are none) -- the affordance tells the truth");

  const vox0 = Number(statusText().match(/([\d,]+) voxels/)[1].replace(/,/g, ""));
  check(upInc.fire("click") > 0, "the 'add layer above' button is wired");
  pump();
  check(/z 21–41 \(20 at\/below · 1 above\)/.test(statusText()),
    "one click adds a layer ABOVE: z 21..41 -- " + statusText().split("·").slice(0, 2).join("·").trim());
  const vox1 = Number(statusText().match(/([\d,]+) voxels/)[1].replace(/,/g, ""));
  check(vox1 > vox0, `the new layer really added voxels (${vox0.toLocaleString()} -> ${vox1.toLocaleString()}) -- the tower above the camera`);
  check($("[data-world3d-up-count]").textContent === "1", "the readout shows 1 layer above");
  check(upDec.disabled === false, "'remove layer above' is now enabled");

  upDec.fire("click"); pump();
  check(/0 above/.test(statusText()), "'remove layer above' takes it back");

  dnInc.fire("click"); pump();
  check(/z 20–40 \(21 at\/below/.test(statusText()), "'add layer below' extends the BOTTOM to z 20");
  dnDec.fire("click"); pump();
  check(/z 21–40 \(20 at\/below/.test(statusText()), "'remove layer below' takes it back");

  // Keyboard equivalents, through the real document keydown handler.
  doc.fire("keydown", { key: "e" }); pump();
  check(/1 above/.test(statusText()), "the E key adds a layer above");
  doc.fire("keydown", { key: "q" }); pump();
  check(/0 above/.test(statusText()), "the Q key removes it");
  doc.fire("keydown", { key: "c" }); pump();
  check(/21 at\/below/.test(statusText()), "the C key adds a layer below");
  doc.fire("keydown", { key: "z" }); pump();
  check(/20 at\/below/.test(statusText()), "the Z key removes it");

  // Clamping at the world ceiling, driven all the way through the UI.
  for (let i = 0; i < 25; i++) { $("[data-world3d-up-inc]").fire("click"); pump(); }
  const top = Number(statusText().match(/z \d+–(\d+)/)[1]);
  check(top === WORLD.z - 1, `the slab clamps at the world ceiling (zTop=${top}, world has ${WORLD.z} levels)`);
  check($("[data-world3d-up-inc]").disabled === true, "'add layer above' DISABLES itself at the world ceiling");
  for (let i = 0; i < 25; i++) { $("[data-world3d-up-dec]").fire("click"); pump(); }
  check(/0 above/.test(statusText()), "and it all winds back down to 0 above");
}

// =================================================================================================
console.log("\n# REFRESH: rebuilds from CURRENT world state, and does not yank the camera");
// =================================================================================================
{
  const before = Number(statusText().match(/([\d,]+) voxels/)[1].replace(/,/g, ""));
  check(before > 0, "the field has voxels before the world changes");

  // Mine out the world behind the viewer's back, then press Refresh. A refresh that replayed a
  // cached field (or that never fired at all -- the shipped bug) would report the OLD count.
  WORLD.fill = 0;
  check($("[data-world3d-refresh]").fire("click") > 0, "the Refresh button is wired");
  pump();
  const after = Number(statusText().match(/([\d,]+) voxels/)[1].replace(/,/g, ""));
  check(after === 0, `Refresh re-read the CURRENT world (${before.toLocaleString()} voxels -> ${after})`);

  WORLD.fill = 1;
  doc.fire("keydown", { key: "r" }); pump();
  const back = Number(statusText().match(/([\d,]+) voxels/)[1].replace(/,/g, ""));
  check(back === before, "the R key refreshes too, and the restored world rebuilds identically");

  // The camera must SURVIVE a refresh. Orbit somewhere distinctive, refresh, and assert the view
  // matrix is untouched -- this is what "Refresh should not feel like a jump cut" means.
  canvas.fire("pointerdown", { button: 0, clientX: 100, clientY: 100, pointerId: 9 });
  canvas.fire("pointermove", { clientX: 300, clientY: 260, pointerId: 9 });
  canvas.fire("pointerup", { pointerId: 9 });
  const posed = mvpNow();
  $("[data-world3d-refresh]").fire("click"); pump();
  const afterRefresh = mvpNow();
  check(posed.every((v, i) => Math.abs(v - afterRefresh[i]) < 1e-6),
    "Refresh PRESERVES the camera exactly (the old build re-framed it every time)");

  // ...but Fit re-frames on demand.
  $("[data-world3d-fit]").fire("click"); pump();
  check(posed.some((v, i) => Math.abs(v - mvpNow()[i]) > 1e-6), "the Fit button DOES re-frame the view");
}

// =================================================================================================
console.log("\n# WORLD-SPACE CAMERA: the live 2D camera moving must not drag the 3D view with it");
// =================================================================================================
{
  // This is the deep fix behind Refresh: the mesh is drawn through a MODEL matrix at the field
  // origin, so the camera target is a WORLD coordinate. When the field origin shifts under a
  // rebuild, a given WORLD point must still land on exactly the same pixel.
  const mul = (m, v) => [0, 1, 2, 3].map(r =>
    m[0 * 4 + r] * v[0] + m[1 * 4 + r] * v[1] + m[2 * 4 + r] * v[2] + m[3 * 4 + r] * v[3]);
  const P = [500, 500, 40]; // a fixed WORLD point

  const cam0 = { x: 460, y: 460 };
  const grid0 = [P[0] - (500 - 48), P[1] - (500 - 48), P[2] - 21]; // world - field origin (ox,oy,oz)
  const clipBefore = mul(mvpNow(), [grid0[0], grid0[1], grid0[2], 1]);

  // Walk the live 2D camera 10 tiles east and let the 400ms debounce elapse on the virtual clock.
  win.DwfTiles.getLatest = () => ({ origin: { x: cam0.x + 10, y: cam0.y, z: WORLD.camz }, width: 80, height: 80 });
  pump(60); // ~1s of virtual time: past the debounce, and the rebuild drains
  check(/voxels/.test(statusText()), "the viewer auto-refreshed after the live camera settled (no button press)");

  const grid1 = [P[0] - (510 - 48), P[1] - (500 - 48), P[2] - 21]; // same world point, new origin
  const clipAfter = mul(mvpNow(), [grid1[0], grid1[1], grid1[2], 1]);
  check(clipBefore.every((v, i) => Math.abs(v - clipAfter[i]) < 1e-3),
    "the same WORLD point projects to the same clip position after the origin moved (world-space camera)");

  // test-the-test: a DIFFERENT world point must project somewhere else, or the check above is vacuous.
  const other = mul(mvpNow(), [grid1[0] + 20, grid1[1], grid1[2], 1]);
  rejects(clipBefore.every((v, i) => Math.abs(v - other[i]) < 1e-3),
    "a different world point must project differently");
}

// =================================================================================================
// # B237 -- the LAYOUT ORACLE. The owner: "bottom of screen has two sets of controls overlapping".
//
// A class-name assertion cannot see this bug: the shipped viewer had all the right classes and two
// boxes on top of each other. So this section computes RECTANGLES -- in CSS pixels, at several
// viewport sizes -- from the REAL sources of truth:
//   * web/css/dwf.css          for the 3D chrome and the map's #hud / #bottomBar
//   * web/js/dwf-chat.js       for the chat dock, whose geometry lives in an injected <style>
// and asserts that nothing the viewer draws overlaps anything the client still draws, and that the
// map's bottom toolbar is not in the layout at all while the viewer is open.
//
// Text metrics are ESTIMATED (there is no layout engine here, and this test must run without a
// browser): a monospace advance of 0.6em and a line box of 1.2em. The estimate is deliberately on
// the generous side, and the test-the-test below proves the oracle actually detects the collision it
// is looking for -- it reports BOTH shipped overlaps when the shipped CSS is seeded back in.
// =================================================================================================
console.log("\n# B237: the 3D chrome and the client's chrome must not overlap (real rectangles)");
{
  const CHAT_JS = readJs("dwf-chat.js");
  const px = v => (v == null ? null : parseFloat(String(v)));
  // Merge every declaration block whose selector list contains this exact selector.
  const declsOf = (css, selector) => {
    const out = {};
    for (const rule of parseRules(css)) {
      if (rule.selectors.includes(selector)) Object.assign(out, rule.decls);
    }
    return out;
  };
  // The chat dock's rules live inside a JS string literal, so read them as text.
  const chatDecls = id => {
    const m = new RegExp("#" + id + "\\{([^}]*)").exec(CHAT_JS.replace(/"\s*\+\s*\n?\s*"/g, ""));
    const out = {};
    if (m) for (const d of m[1].split(";")) { const i = d.indexOf(":"); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
    return out;
  };
  const bottomOf = decl => px((decl.bottom || "").replace(/calc\(\s*([\d.]+px).*/, "$1")); // strip the --dfvv-kb-inset calc (0px off-mobile)

  // --- text metrics (documented estimates) ---
  const FONT = 12, CH = FONT * 0.6, LINE = FONT * 1.2;
  const box = (decl, text, availW) => {
    const pad = (decl.padding || "0 0").trim().split(/\s+/).map(px);
    const padY = pad[0] || 0, padX = pad[1] != null ? pad[1] : padY;
    const bw = px(decl.border) || 0;
    const inner = Math.max(40, availW - 2 * padX - 2 * bw);
    const lines = Math.max(1, Math.ceil((text.length * CH) / inner));
    return {
      w: Math.min(availW, text.length * CH + 2 * padX + 2 * bw),
      h: lines * LINE + 2 * padY + 2 * bw,
      lines,
    };
  };
  const rect = (x, y, w, h) => ({ x, y, w, h });
  const overlaps = (a, b) =>
    a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // The status line the viewer actually shows right now, and the hint it always shows.
  const STATUS_TEXT = statusText();
  const HINT_TEXT = copy("[data-world3d-hint]").textContent;
  check(HINT_TEXT.length > 100, `the hint legend is long (${HINT_TEXT.length} chars) -- it WILL wrap; that is the trap`);

  // Lay out the world (viewport W x H). `css` is a parameter so the test-the-test can re-run the
  // very same oracle against the SHIPPED stylesheet and watch it catch the bug.
  function layout(css, W, H, opts = {}) {
    const modeOn = opts.mode !== false;
    const ancestors = [{ id: "", classes: modeOn ? ["world3d-mode"] : [], attrs: {} }]; // <body>
    const inLayout = (id, classes = [], inline = {}) =>
      computedDisplayIn(css, { id, classes, attrs: {}, style: inline }, ancestors) !== "none";

    const out = { viewer: {}, client: {} };

    // ---- the 3D chrome: ONE top-anchored flex column (.world3d-chrome) ----
    const chrome = declsOf(css, ".world3d-chrome");
    const head = declsOf(css, "#world3dScreen .world3d-head");
    const st = declsOf(css, ".world3d-status,\n.world3d-hint").padding
      ? declsOf(css, ".world3d-status,\n.world3d-hint") : declsOf(css, ".world3d-status");
    const readouts = declsOf(css, ".world3d-readouts");
    const chromeTop = px(chrome.top) ?? 8, chromeLeft = px(chrome.left) ?? 8;
    const chromeW = W - chromeLeft - (px(chrome.right) ?? 8);
    const gap = px(chrome.gap) ?? 0, rgap = px(readouts.gap) ?? 0;

    // A viewer whose chrome is NOT one flow column is laid out from its own absolute offsets --
    // which is exactly the shipped bug, and exactly what this oracle has to be able to express.
    const flow = (chrome.display || "").includes("flex");
    const stDecl = Object.assign({}, st, declsOf(css, ".world3d-status"));
    const hintDecl = Object.assign({}, st, declsOf(css, ".world3d-hint"));
    const stBox = box(stDecl, STATUS_TEXT, Math.min(chromeW, 860));
    const hintBox = box(hintDecl, HINT_TEXT, Math.min(chromeW, 860));
    const headH = (px(head.padding) || 5) * 2 + (px(head.border) || 2) * 2 + 26; // 26px plaque row

    out.viewer.head = rect(chromeLeft, chromeTop, chromeW, headH);
    if (flow && !stDecl.bottom && !hintDecl.bottom) {
      let y = chromeTop + headH + gap;
      out.viewer.status = rect(chromeLeft, y, stBox.w, stBox.h);
      y += stBox.h + rgap;
      out.viewer.hint = rect(chromeLeft, y, hintBox.w, hintBox.h);
    } else { // absolutely docked to the BOTTOM, each with a hardcoded offset (the shipped layout)
      const sB = px(stDecl.bottom) || 0, hB = px(hintDecl.bottom) || 0;
      out.viewer.status = rect(px(stDecl.left) || 8, H - sB - stBox.h, stBox.w, stBox.h);
      out.viewer.hint = rect(px(hintDecl.left) || 8, H - hB - hintBox.h, hintBox.w, hintBox.h);
    }

    // ---- the client's chrome that is still on screen ----
    // The map toolbar: #bottomBar (absolute, full width, 44px) inside #hud (fixed, inset 0).
    if (inLayout("hud") && inLayout("bottomBar")) {
      const bb = declsOf(css, "#bottomBar");
      const h = px(bb.height) || 44;
      out.client.bottomBar = rect(0, H - h, W, h);
    }
    // The chat dock: z-index 8980/8981, ABOVE the 3D overlay's z122 by design, and never suppressed.
    const tg = chatDecls("dfChatToggle");
    const tgH = 13 * 1.35 + 6 * 2 + 2; // 13px label, 6px padding, 1px border
    out.client.chatToggle = rect(px(tg.left), H - bottomOf(tg) - tgH, 78, tgH);
    if (opts.chatOpen) {
      const cp = chatDecls("dfChatPanel");
      out.client.chatPanel = rect(px(cp.left), H - bottomOf(cp) - px(cp.height), px(cp.width), px(cp.height));
    }
    return out;
  }

  function collisions(L) {
    const hits = [];
    const V = Object.entries(L.viewer), C = Object.entries(L.client);
    for (const [vn, v] of V) for (const [cn, c] of C) if (overlaps(v, c)) hits.push(`${vn} x ${cn}`);
    for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) {
      if (overlaps(V[i][1], V[j][1])) hits.push(`${V[i][0]} x ${V[j][0]}`);
    }
    return hits;
  }

  // WT11_DUMP=1 prints the boxes. Worth keeping: an oracle whose rectangles you cannot LOOK at is
  // one bad parse away from passing vacuously (a NaN rect overlaps nothing).
  if (process.env.WT11_DUMP) {
    for (const [W, H] of [[1920, 1080], [480, 800]]) {
      const L = layout(CSS, W, H, { chatOpen: true });
      console.log(`  [dump ${W}x${H}]`);
      for (const side of ["viewer", "client"]) {
        for (const [n, r] of Object.entries(L[side])) {
          console.log(`    ${side}.${n}`.padEnd(24) +
            `x ${r.x.toFixed(0)}..${(r.x + r.w).toFixed(0)}   y ${r.y.toFixed(0)}..${(r.y + r.h).toFixed(0)}`);
        }
      }
    }
  }

  const VIEWPORTS = [[1920, 1080], [1600, 900], [1366, 768], [1280, 720], [1024, 640], [760, 900], [480, 800]];
  for (const [W, H] of VIEWPORTS) {
    for (const chatOpen of [false, true]) {
      const hits = collisions(layout(CSS, W, H, { chatOpen }));
      check(hits.length === 0,
        `${W}x${H}${chatOpen ? " (chat panel open)" : ""}: nothing overlaps` + (hits.length ? " -- " + hits.join(", ") : ""));
    }
  }

  // The mandate, stated as geometry rather than as a class: the map's bottom toolbar is NOT in the
  // layout while the viewer is open, and IS once it closes.
  const openL = layout(CSS, 1920, 1080, {});
  const closedL = layout(CSS, 1920, 1080, { mode: false });
  check(!openL.client.bottomBar, "while the 3D screen is open the map's bottom toolbar has NO box (display:none, out of the layout)");
  check(!!closedL.client.bottomBar && closedL.client.bottomBar.h === 44,
    "with the mode off the toolbar is back in the layout (44px band across the bottom)");
  check(declsOf(CSS, ".tool-group")["pointer-events"] === "auto",
    "...and its tool groups are hit-testable again (.tool-group keeps pointer-events:auto)");

  // The panels the 2D client shows with an INLINE style.display are suppressed too -- the case where
  // a rule without !important would have silently lost.
  const inlineShown = { id: "hoverInfo", classes: [], attrs: {}, style: { display: "block" } };
  check(computedDisplayIn(CSS, inlineShown, [{ id: "", classes: ["world3d-mode"], attrs: {} }]) === "none",
    "a panel the client had OPEN via inline style (#hoverInfo) is still suppressed in world3d-mode");
  check(computedDisplayIn(CSS, inlineShown, [{ id: "", classes: [], attrs: {} }]) === "block",
    "...and it is shown again the moment the mode class comes off");

  // ---- test-the-test: seed the SHIPPED geometry back in; the oracle must SEE both collisions -----
  const SHIPPED = CSS +
    "\n.world3d-status,\n.world3d-hint { position: absolute; left: 8px; }" +
    "\n.world3d-status { bottom: 34px; }\n.world3d-hint { bottom: 8px; }";
  const shippedHits = collisions(layout(SHIPPED, 1920, 1080, {}));
  rejects(shippedHits.length === 0,
    "the SHIPPED bottom-docked readouts collide -- oracle reports: " + (shippedHits.join(", ") || "NOTHING"));
  check(shippedHits.includes("status x hint"),
    "  ...it catches collision 1: the wrapped hint rides up into the status box");
  check(shippedHits.includes("status x chatToggle"),
    "  ...and collision 2: the chat toggle (z8980, bottom:52) sits on the status box");

  // ...and if the mode rule is deleted, the toolbar assertion must fail.
  const noMode = CSS.replace(/body\.world3d-mode #hud,/, "body.never-matches #hud,");
  rejects(!layout(noMode, 1920, 1080, {}).client.bottomBar,
    "without the `body.world3d-mode #hud` rule the toolbar is back in the layout -- the assertion is real");

  // ---- the CATEGORY, not the instance ----------------------------------------------------------
  // The overlay is z122. EVERY rule in the client that outranks it can paint on the viewer, so
  // enumerate them all -- from both stylesheets, the CSS file AND the ones JS injects -- and require
  // each to be either SUPPRESSED by the mode or on an explicit keep-list with a reason. A future
  // high-z element that is neither fails here, instead of landing on the screen.
  console.log("\n# B237: every layer above the overlay's z122 is classified (the ratchet)");
  const OVERLAY_Z = px(declsOf(CSS, "#world3dScreen")["z-index"]);
  check(OVERLAY_Z === 122, `#world3dScreen sits at z${OVERLAY_Z} -- everything above it is in scope`);

  const KEEP = {
    "#dfChatToggle": "multiplayer chat: floats above every screen by design; the viewer vacates its bottom-left lane",
    "#dfChatPanel": "ditto -- and the geometry checks above prove the viewer never reaches it",
    "#dfPauseToasts": "transient centered notice, pointer-events:none -- not a control",
    "#dfBusyBanner": "transient centered notice -- not a control",
    "#dfDigestHost": "pointer-events:none notice layer",
    "#dfPopupMirror": "full-screen native-popup takeover, not corner chrome",
    "#dfDiploMirror": "full-screen native-diplomacy takeover, not corner chrome",
    "#dfcapJoinOverlay": "the join screen precedes the game entirely",
    "#dfcapVerBanner": "version-mismatch banner: an error state that must outrank everything",
    "#helpPopup": "full-screen modal with its own backdrop; Esc-dismissed",
    "#escMenu": "full-screen modal; Esc is consumed by the viewer, so it cannot even open from here",
  };
  // Every z-index > 122 in the CSS file, plus the ones the JS modules inject as <style> text.
  const highZ = [];
  for (const rule of parseRules(CSS)) {
    const z = px(rule.decls["z-index"]);
    if (z > OVERLAY_Z) rule.selectors.forEach(s => highZ.push({ sel: s, z, src: "dwf.css" }));
  }
  for (const f of fs.readdirSync(path.join(ROOT, "web", "js")).filter(n => n.endsWith(".js"))) {
    const src = readJs(f);
    for (const m of src.matchAll(/(#[\w-]+)\s*\{[^}]*?z-index:\s*(\d+)/g)) {
      if (Number(m[2]) > OVERLAY_Z) highZ.push({ sel: m[1], z: Number(m[2]), src: f });
    }
  }
  check(highZ.length >= 15, `found ${highZ.length} layers above z122 across both stylesheets`);
  const modeBody = [{ id: "", classes: ["world3d-mode"], attrs: {} }];
  const unclassified = [];
  for (const { sel, z, src } of highZ) {
    if (KEEP[sel]) continue;
    const id = (/#([\w-]+)/.exec(sel) || [])[1] || "";
    const classes = [...sel.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    // The client shows these with an inline style; the mode must beat that too.
    const elem = { id, classes, attrs: {}, style: { display: "block" } };
    if (computedDisplayIn(CSS, elem, modeBody) !== "none") unclassified.push(`${sel} (z${z}, ${src})`);
  }
  check(unclassified.length === 0,
    "every layer above z122 is either suppressed by world3d-mode or keep-listed with a reason" +
    (unclassified.length ? " -- UNCLASSIFIED: " + unclassified.join(", ") : ""));
  // test-the-test: a brand-new high-z panel that nobody classified must FAIL this ratchet.
  const seeded = CSS + "\n.zz-new-panel { position: fixed; top: 60px; z-index: 5000; }";
  const seededHits = [];
  for (const rule of parseRules(seeded)) {
    const z = px(rule.decls["z-index"]);
    if (z > OVERLAY_Z) for (const s of rule.selectors) {
      if (KEEP[s]) continue;
      const id = (/#([\w-]+)/.exec(s) || [])[1] || "";
      const classes = [...s.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
      if (computedDisplayIn(seeded, { id, classes, attrs: {}, style: {} }, modeBody) !== "none") seededHits.push(s);
    }
  }
  rejects(seededHits.length === 0,
    "an unclassified new high-z panel is CAUGHT by the ratchet (" + seededHits.join(", ") + ")");
  for (const sel of Object.keys(KEEP)) {
    if (!highZ.some(h => h.sel === sel)) console.log(`  note - keep-list entry ${sel} no longer exists above z122 (prunable)`);
  }
}

// =================================================================================================
console.log("\n# housekeeping: close restores the client EXACTLY, and releases the RAF loop");
// =================================================================================================
{
  // No leaked hidden state: the viewer must not have touched a single node it does not own. (The
  // WT11 bug was an invisible pane left in the layout eating clicks; the B237 fix hides the client's
  // chrome, so this is now the load-bearing invariant.) Snapshot the HUD, cycle the viewer, compare.
  const hud = new El("div"); hud.setAttribute("id", "hud");
  const bar = new El("div"); bar.setAttribute("id", "bottomBar");
  const group = new El("div"); group.setAttribute("class", "tool-group");
  const btn = new El("button"); btn.setAttribute("data-df-btn", "");
  let clicks = 0; btn.addEventListener("click", () => clicks++);
  group.appendChild(btn); bar.appendChild(group); hud.appendChild(bar); body.appendChild(hud);
  const snap = () => JSON.stringify([hud, bar, group, btn].map(n =>
    [n.attrs, n.style, n.hidden, [...n._classes].sort()]));
  const before = snap();

  W3D.open(); pump();
  check(body.classList.contains("world3d-mode"), "reopening re-enters the mode");
  W3D.close();

  check(!doc.getElementById("world3dScreen").classList.contains("open"), "close() removes .open");
  check(!body.classList.contains("world3d-mode"), "close() leaves the mode -- the 2D chrome comes back");
  check(snap() === before,
    "close() left the HUD byte-for-byte as it found it (no style, class, or [hidden] written to it)");
  check(btn.fire("click") > 0 && clicks === 1, "a toolbar button is hit-testable again after close");
  check(W3D.isOpen() === false, "isOpen() reports closed -- this is what core.js's yields ask");
  const drawsBefore = gpu.draws;
  pump();
  check(gpu.draws === drawsBefore, "the RAF loop stops drawing once closed (no background GPU burn)");
}

console.log("\n" + (failed ? "FAIL" : "PASS") + " -- " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
