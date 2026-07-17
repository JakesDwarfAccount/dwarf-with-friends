// sb_renderers.mjs -- shared loader for the sb_*_test.mjs suites. NOT a *_test.mjs (never run as a
// suite by the CI runner). Loads the REAL web/js/dwf-gl.js + dwf-tiles.js verbatim (same vm harness
// as wt30/wb13) and exposes: the two resolvers, the canvas2d draw-plan, and the GL scene-builder
// draw harness (createSceneBuilder + a mock atlas + decode) used to observe GL bubble drawing at a
// given wall-clock nowMs. One place to change if the load convention drifts.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---- GL: isolated vm context (its own `self`) --------------------------------------------------
const glbox = { self: null, performance: { now: () => 0 } };
glbox.self = glbox;
vm.createContext(glbox);
vm.runInContext(read("web", "js", "dwf-gl.js"), glbox, { filename: "dwf-gl.js" });
export const GL = glbox.DwfGL;

// ---- Canvas2d: needs a DOM-ish global; same shims as b248/wt30 ---------------------------------
class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() {
    return new Proxy({}, {
      get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; },
      set(t, p, v) { t[p] = v; return true; },
    });
  }
}
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(read("web", "js", "dwf-tiles.js"), { filename: "dwf-tiles.js" });
export const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });

// ---- resolvers + canvas draw-plan --------------------------------------------------------------
export const glIcon = (st, st2) => GL.unitStatusIconForBits(st, st2);
export const tilesIcon = (st, st2) => Tiles._unitStatusIconForTest(st, st2);
export const plain = (o) => (o ? { sheet: o.sheet, col: o.col, row: o.row, token: o.token } : null);
// canvas2d real draw path: returns a plan object or null (null = no icon drawn this frame).
export const tilesDrawPlan = (u, nowMs, cell = 24) => Tiles._unitStatusDrawPlanForTest(u, 0, 0, cell, nowMs, 1);

// ---- GL scene-builder draw harness (mirror of wb13_units_test.mjs) -----------------------------
const realCreaturesMap = JSON.parse(read("web", "creatures_map.json"));
export function makeUnitMockAtlas() {
  const ids = new Map(); let next = 1;
  return {
    registerDynamicSheet() { return true; },
    resolve(sheetOrKey, col, row) {
      const k = sheetOrKey + "|" + col + "|" + row;
      if (!ids.has(k)) ids.set(k, next++);
      return ids.get(k);
    },
  };
}
function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4],
      r: u8[k * 16 + 12], g: u8[k * 16 + 13], b: u8[k * 16 + 14], a: u8[k * 16 + 15] });
  }
  return out;
}
function tile() { return { tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }; }
function flatView(gw, gh) {
  const tiles = new Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) tiles[i] = tile();
  return { origin: { x: 0, y: 0, z: 0 }, width: gw, height: gh, tiles };
}
// Build a GL scene of `units` at wall-clock `nowMs`, return the emitted unit-region instances plus a
// helper that reports, per unit, whether its status-bubble cell was emitted this frame.
export function glBuildUnits(units, nowMs) {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  b.buildScene(flatView(8, 8));
  const staticCount = b.staticCount;
  const r = b.buildUnits(units, 0, 0, 0, nowMs);
  const inst = decode(b).slice(staticCount);
  const bubbleCellFor = (row) => atlas.resolve("unit_status.png", 0, row);
  return {
    count: r.count,
    instances: inst,
    // did a bubble for `row` get emitted (unit at any position)?
    hasBubbleRow: (row) => inst.some((i) => i.cell === bubbleCellFor(row)),
  };
}
