// THE INTERFACE-SCALE GATE for runtime bitmap text. Offline: no game/server/browser.
//
// WHAT THIS PINS, AND WHY IT EXISTS
// ---------------------------------
// The foundation's D1 font contract said DF "INTEGER SCALEs ONLY -- never sub-sample", so the label
// assembler drew every glyph at exactly 8x12 with imageSmoothingEnabled = false. Fitting DF's OWN
// source cells back onto the lossless oracle (Menu Oracle Screenshots/unit profiles/Steam
// relations.png) says otherwise -- see docs/superpowers/analysis/wave4/FONT-SCALE-CLOSEOUT.md:
//
//     tab labels "Military"/"Thoughts"/"Groups"  -> 1.245 / 1.245 / 1.240
//     SHORT_TAB tab art (40x24)                  -> 1.230
//     UNIT_SHEET_* toolbar icons (32x36->40x45)  -> 1.260 / 1.240 / 1.240
//
// DF draws its interface at a NON-INTEGER, FILTERED scale, and it draws its SPRITE ART and its TEXT
// at THE SAME scale (they fit the same factor to within 1%; DF's art is authored on the 8x12 text
// cell, so this is structural, not luck). Therefore the text scale is DERIVED from the scale the
// surrounding DF sprite art is actually drawn at -- never stated as a constant, because DF rescales
// its whole interface with the window and 1.245 belongs to the oracle's window and nothing else.
//
// THE DECISIONS, after reviewing rendered comparisons (this is the wave that ADOPTS the scale --
// the mechanism above shipped INERT at 1.0 because the sprite art had not moved yet):
//   * ADOPT DF's scale. The whole interface -- art and text -- moves onto DF's grid together.
//   * SOFTEN = 50%. Off a rendered 0/35/50/70/100 ladder: full bilinear reads too soft on straight
//     vertical/horizontal strokes; pure nearest is too hard. It is BAKED ONCE PER SCALE, so the draw
//     path stays at ONE drawImage per label with zero readbacks.
//   * The tab token is SHORT_TAB, not TAB (pinned in tab_grammar_test).
//
// EVERY RULE BELOW REJECTS THE OLD 1x-NEAREST PATH. Run with --selftest to watch it happen: the
// pre-fix renderer is re-implemented verbatim in `legacy` and fed to the same eight rules, and each
// one must fail on it. A rule that cannot fail is worse than no rule.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const SELFTEST = process.argv.includes("--selftest");

// The oracle's measured native geometry, for the one surface the owner reported (the unit-profile tab band).
const ORACLE = { scale: 1.245, advance: 10, inkHeight: 15, text: "Military" };

// ---- deterministic canvas fakes. They RECORD what the renderer asked the GPU to do. --------------
class FakeContext {
  constructor(canvas) {
    this.canvas = canvas; this.imageSmoothingEnabled = true;
    this.draws = []; this.readbacks = 0;
    this.globalCompositeOperation = "source-over"; this.globalAlpha = 1;
  }
  // Every draw records the smoothing flag, the alpha AND the composite op AS THEY WERE AT DRAW TIME.
  // The whole point of the blend rule is *how* the two layers were combined, and a flag read after
  // the fact would prove nothing.
  drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    const state = { smoothing: this.imageSmoothingEnabled, alpha: this.globalAlpha,
      op: this.globalCompositeOperation };
    this.draws.push(arguments.length >= 9
      ? { src, sx, sy, sw, sh, dx, dy, dw, dh, ...state }
      : { src, dx: sx, dy: sy, ...state });
  }
  clearRect() {}
  fillRect() {}
  putImageData() {}
  getImageData() {
    this.readbacks++;
    const data = new Uint8ClampedArray(Math.max(1, this.canvas.width * this.canvas.height) * 4);
    for (let p = 0; p < data.length; p += 4) data[p] = data[p + 1] = data[p + 2] = data[p + 3] = 255;
    return { data, width: this.canvas.width, height: this.canvas.height };
  }
}
class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this.className = ""; this.attrs = {}; this.style = {}; this.ctx = new FakeContext(this); }
  getContext() { return this.ctx; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
}
class FakeImage {
  constructor() { this.naturalWidth = 128; this.naturalHeight = 192; this.listeners = {}; }
  addEventListener(type, cb) { this.listeners[type] = cb; }
  set src(value) { this._src = value; queueMicrotask(() => this.listeners.load()); }
}
class FakeClassList {
  constructor() { this.values = new Set(); }
  add(v) { this.values.add(v); } remove(v) { this.values.delete(v); } contains(v) { return this.values.has(v); }
}
class FakeLabel {
  constructor(doc, text, color = "rgb(255, 255, 255)") {
    this.ownerDocument = doc; this.attrs = { "data-dwfui-bitmap-text": text }; this.color = color;
    this.classList = new FakeClassList(); this.canvas = null;
  }
  matches(sel) { return sel === "[data-dwfui-bitmap-text]"; }
  querySelector(sel) { return sel === "canvas.dwfui-bitmap-canvas" ? this.canvas : null; }
  querySelectorAll() { return []; }
  getAttribute(n) { return this.attrs[n] ?? null; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  appendChild(node) { this.canvas = node; node.parentNode = this; }
  removeChild(node) { if (this.canvas === node) this.canvas = null; node.parentNode = null; }
}
class FakeContainer {
  constructor(doc, nodes, attrs = {}) { this.ownerDocument = doc; this.nodes = nodes; this.attrs = attrs; }
  matches() { return false; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  querySelectorAll(sel) { return sel === "[data-dwfui-bitmap-text]" ? this.nodes : []; }
}

// A DF sprite the way DFChrome actually leaves it in the DOM: a <canvas class="df-chrome-icon"> whose
// BACKING SIZE is the interface_map record times the scale DFChrome chose. drawn/native IS the scale.
// This is the ONLY place the renderer is allowed to learn how big DF is drawing right now.
const SPRITE_REC = { img: "interface_bits_shared.png", cx: 0, cy: 252, w: 32, h: 36 }; // UNIT_SHEET_CUSTOMIZE
function fakeDocument(spriteScale, opts) {
  const o = opts || {};
  const attrs = {};
  if (o.declaredScale != null) attrs["data-dwfui-interface-scale"] = String(o.declaredScale);
  const icons = [];
  if (spriteScale != null) {
    const canvas = new FakeCanvas();
    canvas.className = "df-chrome-icon";
    canvas.width = Math.round(SPRITE_REC.w * spriteScale);
    canvas.height = Math.round(SPRITE_REC.h * spriteScale);
    canvas.parentNode = { getAttribute: n => (n === "data-dwfui-sprite" ? "UNIT_SHEET_CUSTOMIZE" : null) };
    icons.push(canvas);
  }
  const documentElement = {
    attrs,
    setAttribute(n, v) { attrs[n] = String(v); },
    getAttribute(n) { return attrs[n] ?? null; },
  };
  // The in-client UI-scale slider lives on :root as --ui-scale and is applied as CSS `zoom`.
  const defaultView = o.uiScale == null ? undefined : {
    getComputedStyle: el => ({
      getPropertyValue: prop => (prop === "--ui-scale" && el === documentElement ? String(o.uiScale) : ""),
      color: "rgb(255, 255, 255)",
    }),
  };
  return {
    nodeType: 9,
    documentElement,
    defaultView,
    querySelectorAll: sel => (sel === "canvas.df-chrome-icon" ? icons : []),
    createElement: tag => { assert.equal(tag, "canvas"); return new FakeCanvas(); },
  };
}
globalThis.Image = FakeImage;
globalThis.getComputedStyle = node => ({ color: node.color });
globalThis.DFChrome = { getCell: token => (token === "UNIT_SHEET_CUSTOMIZE" ? SPRITE_REC : null) };

const Bitmap = require(join(root, "web/js/dwf-bitmap-text.js"));

// ---- THE OLD PATH, seeded verbatim, so the rules have something real to reject --------------------
// This is dwf-bitmap-text.js's render()/paint() AS THEY WERE before this fix: a fixed 8x12 cell,
// imageSmoothingEnabled = false unconditionally, the tight (unpadded) 8x12 atlas grid, and no notion
// of an interface scale at all. It shares the real module's atlas and cellsFor().
const legacy = {
  name: "the pre-fix 1x-nearest renderer",
  interfaceScale: () => 1,
  configure: (doc, opts) => Bitmap.configure(doc, opts),
  async render(doc, text, color, mul) {
    await Bitmap.load(doc);
    const cells = Bitmap.cellsFor(text);
    if (!cells) return null;
    const s = Math.max(1, Math.min(4, Math.round(Number(mul) || 1)));
    const canvas = doc.createElement("canvas");
    canvas.width = Math.max(1, cells.length * 8 * s);
    canvas.height = 12 * s;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    cells.forEach((cell, i) => ctx.drawImage({ legacyAtlas: true },
      (cell % 16) * 8, Math.floor(cell / 16) * 12, 8, 12,
      i * 8 * s, 0, 8 * s, 12 * s));
    ctx.globalCompositeOperation = "source-in";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
    return canvas;
  },
  async paint(node) {
    const doc = node.ownerDocument || node;
    const nodes = node.nodes || [node];
    let painted = 0;
    for (const label of nodes) {
      const text = label.getAttribute("data-dwfui-bitmap-text") || "";
      if (!Bitmap.cellsFor(text)) continue;
      const source = await legacy.render(doc, text, label.color, label.getAttribute("data-dwfui-bitmap-scale") || "1");
      if (!source) continue;
      let target = label.querySelector("canvas.dwfui-bitmap-canvas");
      if (!target) { target = doc.createElement("canvas"); target.className = "dwfui-bitmap-canvas"; label.appendChild(target); }
      target.width = source.width; target.height = source.height;
      const ctx = target.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(source, 0, 0);
      label.classList.add("dwfui-bitmap-text--ready");
      painted++;
    }
    return painted;
  },
};
const real = {
  name: "the shipped renderer",
  interfaceScale: doc => Bitmap.interfaceScale(doc),
  configure: (doc, opts) => Bitmap.configure(doc, opts),
  render: (doc, text, color, mul, iface) => Bitmap.render(doc, text, color, mul, iface),
  paint: node => Bitmap.paint(node),
  bakeAtlas: (doc, s) => Bitmap.bakeAtlas(doc, s),   // legacy has NO bake at all -- that IS the point
};

// A label's rendered geometry, whichever renderer produced it.
async function labelCanvas(impl, doc, text) {
  const node = new FakeLabel(doc, text);
  await impl.paint(node);
  return node.canvas;
}
// The glyph blits (9-arg draws) that produced a label -- their smoothing flag and source rects.
async function glyphDraws(impl, doc, text, iface) {
  const source = await impl.render(doc, text, "rgb(255, 255, 255)", 1, iface);
  return source.ctx.draws.filter(d => d.sw != null);
}
// The blits that built the PRE-SCALED, PRE-BLENDED atlas for a scale (the once-per-scale bake).
// The legacy renderer has no such thing at all, which is itself the point.
async function bakeDraws(impl, doc, s) {
  assert.ok(impl.bakeAtlas,
    "there must BE a once-per-scale atlas bake: it is where the filtering and the 50% blend live, " +
    "and it is what keeps the DRAW path at one nearest blit per glyph");
  await Bitmap.load(doc);
  Bitmap.clearCache();
  const baked = impl.bakeAtlas(doc, s);
  return { baked, draws: baked.canvas.ctx.draws.filter(d => d.sw != null) };
}

// ---- THE RULES. Each one must PASS on the shipped renderer and FAIL on the old path. --------------
const RULES = [
  ["R1 the text scale is DERIVED from the sprite art, and tracks it -- it is never a constant",
    async impl => {
      // Three different DF window scales, three different answers, from the SAME code. A renderer
      // with 1.25 (or 1) baked in cannot satisfy all three.
      // A sprite canvas has an INTEGER backing store, so the scale recoverable from it is quantised
      // (32px of art x 1.245 lands on 40px, which reads back as 1.25). That is not slop, it is the
      // real resolution of the only honest signal available -- and it is well inside the tolerance
      // that matters, because it still lands on the oracle's exact 10x15 cell.
      const QUANTISATION = 1 / SPRITE_REC.w;   // 0.031 for a 32px-wide record
      for (const [spriteScale, w, h] of [[1, 64, 12], [ORACLE.scale, 80, 15], [2, 128, 24]]) {
        const doc = fakeDocument(spriteScale);
        Bitmap.clearCache();
        const derived = impl.interfaceScale(doc);
        assert.ok(Math.abs(derived - spriteScale) <= QUANTISATION,
          `interface scale should follow the sprite art at ${spriteScale}, got ${derived}`);
        assert.equal(Math.round(SPRITE_REC.w * derived), Math.round(SPRITE_REC.w * spriteScale),
          "the derived scale must reproduce the art's own drawn size exactly");
        const canvas = await labelCanvas(impl, doc, ORACLE.text);
        assert.deepEqual([canvas.width, canvas.height], [w, h],
          `"${ORACLE.text}" at DF scale ${spriteScale} must be ${w}x${h}, got ${canvas.width}x${canvas.height}`);
      }
      // ...and at the oracle's own scale it lands exactly on the oracle's measured geometry.
      const doc = fakeDocument(ORACLE.scale);
      Bitmap.clearCache();
      const canvas = await labelCanvas(impl, doc, ORACLE.text);
      assert.equal(Math.round(canvas.width / ORACLE.text.length), ORACLE.advance, "glyph advance must be the oracle's 10px");
      assert.equal(canvas.height, ORACLE.inkHeight, "cell height must be the oracle's 15px");
    }],

  ["R2 at a NON-INTEGER scale the glyph is the 50% BLEND of nearest and bilinear, baked ONCE",
    async impl => {
      // The owner reviewed a rendered 0/35/50/70/100 ladder and chose 50%: full bilinear was TOO SOFT
      // "especially on straight vertical/horizontal strokes"; pure nearest was too hard. So each cell
      // is (1-SOFTEN)*nearest + SOFTEN*bilinear -- and the ONLY way to get that from canvas is an
      // ADDITIVE composite of the two layers at complementary alphas. Plain source-over CANNOT
      // interpolate (it only ever ADDS coverage), so it would ship a haloed nearest glyph instead.
      const bake = await bakeDraws(impl, fakeDocument(ORACLE.scale), ORACLE.scale);
      assert.ok(bake, "there must BE a pre-scaled atlas bake -- that is where the blend lives");
      assert.equal(bake.draws.length, 512, "256 cells x TWO layers: one hard pass, one soft pass");
      assert.ok(bake.draws.every(d => d.op === "lighter"),
        "the two layers must be composited ADDITIVELY on premultiplied pixels -- source-over is not a blend");
      const hard = bake.draws.filter(d => d.smoothing === false);
      const soft = bake.draws.filter(d => d.smoothing === true);
      assert.equal(hard.length, 256, "every cell gets exactly one NEAREST layer");
      assert.equal(soft.length, 256, "...and exactly one BILINEAR layer");
      assert.ok(hard.every(d => Math.abs(d.alpha - (1 - Bitmap.SOFTEN)) < 1e-9),
        `the nearest layer must carry alpha 1-SOFTEN (${1 - Bitmap.SOFTEN})`);
      assert.ok(soft.every(d => Math.abs(d.alpha - Bitmap.SOFTEN) < 1e-9),
        `the bilinear layer must carry alpha SOFTEN (${Bitmap.SOFTEN})`);
      assert.equal(Bitmap.SOFTEN, 0.5, "the owner chose 50% off the ladder");
      // ...AND AT AN INTEGER SCALE THERE IS NO BLEND AT ALL. Nearest and bilinear are the same image
      // there, so a soft pass would be softness we INVENTED. This is what keeps the approved 1x
      // Foundation FONT card byte-exact.
      for (const integer of [1, 2]) {
        const plain = await bakeDraws(impl, fakeDocument(integer), integer);
        assert.equal(plain.draws.length, 256, `at the integer scale ${integer} a cell is ONE blit`);
        assert.ok(plain.draws.every(d => d.smoothing === false && Math.abs(d.alpha - 1) < 1e-9),
          `at the integer scale ${integer} the blit is a plain nearest copy -- we never invent softness`);
      }
    }],

  ["R3 the BAKE reads the gutter-padded atlas; the LABEL reads the baked atlas 1:1 and never resamples",
    async impl => {
      // The filtering happens ONCE, in the bake, and it must read the PADDED atlas: a filtered read
      // of a tight 8x12 sub-rect bleeds the NEIGHBOURING glyph's ink in along the shared edge.
      const bake = await bakeDraws(impl, fakeDocument(ORACLE.scale), ORACLE.scale);
      for (const d of bake.draws) {
        assert.deepEqual([d.sw, d.sh], [8, 12], "the bake's source rect is one 8x12 cell");
        assert.equal((d.sx - Bitmap.PAD) % Bitmap.PITCH_W, 0,
          `cell x ${d.sx} must sit on the padded 10px pitch (a tight 8px grid bleeds the next glyph in)`);
        assert.equal((d.sy - Bitmap.PAD) % Bitmap.PITCH_H, 0,
          `cell y ${d.sy} must sit on the padded 14px pitch`);
      }
      // ...and the label path then does a 1:1 NEAREST copy of a finished cell. No filtering, no
      // blending, no fractional advance: DF's cell IS the advance, so glyphs stay on whole pixels.
      const draws = await glyphDraws(impl, fakeDocument(ORACLE.scale), "MW", ORACLE.scale);
      assert.equal(draws.length, 2, "one blit per glyph");
      const cw = Math.round(Bitmap.CELL_W * ORACLE.scale), ch = Math.round(Bitmap.CELL_H * ORACLE.scale);
      assert.deepEqual([cw, ch], [ORACLE.advance, ORACLE.inkHeight], "the baked cell IS the oracle's 10x15");
      for (const [i, d] of draws.entries()) {
        assert.equal(d.smoothing, false, "the label path must never resample -- the bake already ran");
        assert.deepEqual([d.sw, d.sh, d.dw, d.dh], [cw, ch, cw, ch], "a 1:1 copy of a baked cell");
        assert.equal(d.dx, i * cw, "the advance is DF's cell, on a whole pixel");
      }
    }],

  ["R4 the fix costs ONE drawImage per label and ZERO readbacks on the draw path",
    async impl => {
      const doc = fakeDocument(ORACLE.scale);
      Bitmap.clearCache();
      const node = new FakeLabel(doc, ORACLE.text);
      await impl.paint(node);
      // The budget: the label's own canvas takes exactly one blit of the cached, pre-tinted source.
      assert.equal(node.canvas.ctx.draws.length, 1, "a label must cost exactly ONE drawImage");
      assert.equal(node.canvas.ctx.readbacks, 0, "getImageData must never touch the draw path");
      // ...and that one blit must have carried the DERIVED geometry, not the old 64x12.
      assert.deepEqual([node.canvas.width, node.canvas.height], [80, 15]);
      // A second paint of an unchanged label is free.
      const before = node.canvas.ctx.draws.length;
      await impl.paint(node);
      assert.equal(node.canvas.ctx.draws.length, before, "an unchanged label must not redraw");
    }],

  ["R5 the dirty key tracks the EFFECTIVE scale: a DF window resize repaints every label",
    async impl => {
      const doc = fakeDocument(1);
      Bitmap.clearCache();
      const node = new FakeLabel(doc, ORACLE.text);
      assert.equal(await impl.paint(node), 1);
      assert.deepEqual([node.canvas.width, node.canvas.height], [64, 12]);
      // DF's window grows; DFChrome repaints its art bigger. The label MUST follow, or it is stale.
      impl.configure(doc, { interfaceScale: ORACLE.scale });
      assert.equal(await impl.paint(node), 1, "a changed interface scale must repaint the label");
      assert.deepEqual([node.canvas.width, node.canvas.height], [80, 15],
        "the label must be re-rendered at the new DF scale, not left stale at 64x12");
    }],

  ["R6 the canvas and frame budgets still hold at DF's native scale, where canvases are 56% bigger",
    async impl => {
      const doc = fakeDocument(ORACLE.scale);
      Bitmap.clearCache();
      const nodes = Array.from({ length: 120 }, (_, i) => new FakeLabel(doc, ORACLE.text));
      const host = new FakeContainer(doc, nodes);
      impl.configure(doc, { maxLiveCanvases: 500 });
      assert.equal(await impl.paint(host), 50, "the 50-live-canvas ceiling is unchanged by the scale");
      const live = nodes.filter(n => n.canvas);
      assert.equal(live.length, 50);
      assert.ok(live.every(n => n.canvas.width === 80 && n.canvas.height === 15),
        "every live canvas must carry the DERIVED native geometry");
      assert.equal(nodes.filter(n => n.attrs["data-dwfui-bitmap-fallback"] === "canvas-budget-deferred").length, 70);
    }],

  ["R7 the INTERFACE OWNER's declared scale wins over the measurement -- art and text cannot diverge",
    async impl => {
      // DWFUI paints DF's art at --dwfui-interface-scale and STAMPS it on <html> as
      // data-dwfui-interface-scale. That stamp is the contract this module documented, and it must
      // BEAT the DOM measurement -- otherwise a sprite canvas whose backing store carries the
      // UI-scale zoom (a HiDPI-style dense raster) would be read back as a bigger interface scale and
      // the text would outgrow the very art it is supposed to track.
      const doc = fakeDocument(1, { declaredScale: ORACLE.scale });   // art measures 1x, owner says 1.245
      Bitmap.clearCache();
      assert.ok(Math.abs(impl.interfaceScale(doc) - ORACLE.scale) < 1e-6,
        "the owner's declared scale must win over the measured sprite");
      const canvas = await labelCanvas(impl, doc, ORACLE.text);
      assert.deepEqual([canvas.width, canvas.height], [80, 15],
        "...and the label must land on the DECLARED grid, not the measured one");
    }],

  ["R8 the UI-scale slider MULTIPLIES on the base scale and makes the text CRISPER, not blurrier",
    async impl => {
      // dwf.css applies `zoom: var(--ui-scale)` to #hud/#clientPanel/..., so whatever we hand
      // the browser is RESAMPLED by the slider. Rasterising at 1x and then zooming is the worst case
      // for sharpness. So the BACKING STORE carries interfaceScale x zoom, and the CSS box is pinned
      // to the unzoomed size: the zoom then scales a bitmap already drawn at its target density.
      const doc = fakeDocument(ORACLE.scale, { uiScale: 2 });
      Bitmap.clearCache();
      const canvas = await labelCanvas(impl, doc, ORACLE.text);
      assert.deepEqual([canvas.width, canvas.height], [160, 30],
        "the backing store must be rasterised at interfaceScale x zoom (1.245 x 2 -> a 20x30 cell)");
      assert.deepEqual([canvas.style.width, canvas.style.height], ["80px", "15px"],
        "...while the CSS box stays the UNZOOMED size, so `zoom` lands it back on 160x30 device px");
      // and with the slider at rest, nothing changes at all: no style, no extra pixels.
      const rest = fakeDocument(ORACLE.scale, { uiScale: 1 });
      Bitmap.clearCache();
      const plain = await labelCanvas(impl, rest, ORACLE.text);
      assert.deepEqual([plain.width, plain.height], [80, 15]);
      assert.deepEqual([plain.style.width, plain.style.height], ["", ""], "no CSS box is pinned at zoom 1");
    }],
];

let failed = 0;
if (!SELFTEST) {
  for (const [name, run] of RULES) {
    try { await run(real); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + "\n  " + (error.message || error)); }
  }
  // Not a rule (the old path satisfied it too): the atlas is still loaded and padded exactly once.
  const stats = Bitmap.stats(fakeDocument(1));
  console.log(`INFO atlas loaded=${stats.loaded} in ${Number(stats.loadMilliseconds).toFixed(2)}ms; ` +
    `cache ${stats.cacheSize}/${stats.cacheLimit}; interfaceScale=${stats.interfaceScale}`);
} else {
  // THE RULES MUST BE ABLE TO FAIL. Feed each one the renderer as it was before the fix; every single
  // rule must reject it. A rule that passes here is a rule that pins nothing.
  console.log(`SELFTEST: every rule must REJECT ${legacy.name}\n`);
  for (const [name, run] of RULES) {
    let rejected = false, why = "";
    try { await run(legacy); }
    catch (error) { rejected = true; why = (error.message || String(error)).split("\n")[0]; }
    if (rejected) console.log(`PASS rejected: ${name}\n       -> ${why}`);
    else { failed++; console.error(`FAIL a rule that CANNOT FAIL: ${name} accepted the old path`); }
  }
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
