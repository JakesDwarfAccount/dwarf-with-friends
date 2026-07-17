// tx1_barrel_peek_test.mjs -- TX1 acceptance: barrels/bins render their contents poking out
// of the container top (oracle TX1-1 native vs TX1-2 browser-empty).
//
// Native mechanism (verified against the raws + the oracle): DF composites a DEDICATED
// per-category overlay cell over the container sprite -- graphics_containers.txt's
// ITEM_BARREL_TOP_MEAT/_FISH/_PLANT[_SUBTERRANEAN]/... and the 21 ITEM_BIN_TOP_* rows
// (DF's own taxonomy: df::item_bin_graphics_contents_type). The wire's new CONTAINER_PEEK
// tail (0x0A) ships the representative FIRST contained item; both renderers classify it to
// a category token and resolve the cell through item_map.bytoken -- never a guessed cell.
//
// Asserts:
//   (1) wire: the regenerated golden fixture round-trips the CONTAINER_PEEK tail through the
//       REAL decoder (tiles 27/28/29: MEAT barrel, subterranean-PLANT barrel, coal-BAR bin),
//       and container tiles WITHOUT contents carry no peek tail (empty -> no peek).
//   (2) classifier (both renderers, REAL item_map.json/material_map.json): category ->
//       raws-parsed containers.png cell; unmapped content type -> null; non-container -> null.
//   (3) GL emits the peek composite (container cell THEN overlay cell) for a seeded
//       container; canvas2d blits the same two cells in the same order.
//   (4) seeded-bad: a container WITHOUT a peek descriptor must NOT emit the overlay (a peek
//       without contents is a FAILURE), and an unmapped peek emits exactly the plain container.
//
// Run: node tools/harness/tx1_barrel_peek_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const realItemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const realMaterialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));

// Fixture assumptions: the overlay tokens this feature composites must exist in the
// committed item_map (raws-parsed) -- if the generator ever drops them, fail loudly here.
for (const tok of ["ITEM_BARREL_TOP_MEAT", "ITEM_BARREL_TOP_FISH", "ITEM_BARREL_TOP_PLANT",
                   "ITEM_BARREL_TOP_PLANT_SUBTERRANEAN", "ITEM_BIN_TOP_COAL", "ITEM_BIN_TOP_BARS",
                   "ITEM_BIN_TOP_CHAINS", "ITEM_BIN_TOP_ROPES"]) {
  assert.ok(realItemMap.bytoken && realItemMap.bytoken[tok] && realItemMap.bytoken[tok].sheet,
    "fixture assumption broken: item_map.json bytoken no longer has " + tok);
}
const CELL = (tok) => realItemMap.bytoken[tok];
const BARREL_BASE = realItemMap.bytype.BARREL;   // ITEM_BARREL_WOOD_EMPTY
const BIN_BASE = realItemMap.bytype.BIN;
assert.ok(BARREL_BASE && BARREL_BASE.sheet && BIN_BASE && BIN_BASE.sheet,
  "fixture assumption broken: item_map.json bytype BARREL/BIN missing");

// A real METAL-family inorganic index (for the CHAIN metal->CHAINS / ARMOR metal split).
const metalIdx = realMaterialMap.inorganic.findIndex((e) => e && e.family === "METAL");
assert.ok(metalIdx >= 0, "fixture assumption broken: material_map.json has no METAL inorganic");

let failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok - " + name);
  else { failed++; console.log("  FAIL - " + name); }
}

// =============================================================================================
// (1) WIRE: real decoder over the regenerated golden fixture
// =============================================================================================
console.log("TX1 wire: CONTAINER_PEEK (0x0A) round-trip through the real decoder");
{
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-wire-v1.js"), "utf8"),
    sandbox, { filename: "dwf-wire-v1.js" });
  const W = sandbox.DwfWireV1;
  assert.ok(W && W.C.TAIL_CONTAINER_PEEK === 0x0A && W.C.F2_CONTAINER_PEEK === 0x0200,
    "decoder must register TAIL_CONTAINER_PEEK 0x0A / F2 0x0200");

  const bin = fs.readFileSync(path.join(ROOT, "tools/harness/fixtures/wire_fixture.bin"));
  const bytes = new Uint8Array(bin.buffer, bin.byteOffset, bin.length);
  const hdr = W.decodeHeader(bytes);
  const dec = W.decodeBlockSet(bytes.subarray(hdr.payloadOffset));
  const A = dec.blocks[0];

  const peeksAt = (idx) => A.tails.filter((t) => t.tile_idx === idx && t.kind === 0x0A);
  const p27 = peeksAt(27), p28 = peeksAt(28), p29 = peeksAt(29);
  check("tile 27 carries exactly one CONTAINER_PEEK tail", p27.length === 1);
  check("tile 27 peek = MEAT (48), creature mat 19:5, subtype -1, cflags 0",
    p27.length === 1 && p27[0].data.item_type === 48 && p27[0].data.mat_type === 19 &&
    p27[0].data.mat_index === 5 && p27[0].data.subtype === -1 && p27[0].data.cflags === 0);
  check("tile 28 peek = PLANT (54) with cflags bit0 (subterranean)",
    p28.length === 1 && p28[0].data.item_type === 54 && (p28[0].data.cflags & 0x01) === 1);
  check("tile 29 peek = BAR (0) with builtin-COAL mat_type 7",
    p29.length === 1 && p29[0].data.item_type === 0 && p29[0].data.mat_type === 7);
  check("container-peek tiles set flags2 bit 0x0200 (and keep the ITEM bit)",
    (A.records[27].flags2 & 0x0201) === 0x0201 && (A.records[28].flags2 & 0x0201) === 0x0201 &&
    (A.records[29].flags2 & 0x0201) === 0x0201);
  // Empty container -> no peek: the wire only carries the tail when contents exist. Every
  // OTHER item tile in the fixture (5, 8, 16-26, block B/C items) is peek-less.
  const strayPeeks = A.tails.filter((t) => t.kind === 0x0A && ![27, 28, 29].includes(t.tile_idx));
  check("no CONTAINER_PEEK tail on any contents-less tile (empty -> no peek)", strayPeeks.length === 0);
  check("pre-peek item tile 5 keeps flags2 free of 0x0200", (A.records[5].flags2 & 0x0200) === 0);
}

// =============================================================================================
// (2)+(3 GL) GL renderer: classifier + emitted peek composite
// =============================================================================================
console.log("TX1 GL: classifier + scene-build emits container cell THEN overlay cell");
{
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
  vm.createContext(sandbox);
  for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
  }
  const GL = sandbox.DwfGL;
  const Adj = sandbox.DwfAdjacency;

  function makeMockAtlas() {
    const ids = new Map();
    let next = 1;
    return {
      resolve(sheet, col, row) {
        const k = sheet + "|" + col + "|" + row;
        if (!ids.has(k)) ids.set(k, next++);
        return ids.get(k);
      },
    };
  }
  const spriteMap = { STONE_FLOOR_5: { sheet: "floors.png", col: 1, row: 4 } };
  const tokenMap = { StoneFloor5: { token: "STONE_FLOOR_5", tint: null } };
  const shadowCellMap = { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} };
  const tile = (o) => Object.assign({ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE",
    hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
  const decode = (b) => {
    const f32 = new Float32Array(b.buffer), u16 = new Uint16Array(b.buffer);
    const out = [];
    for (let k = 0; k < b.count; k++) out.push({ x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4] });
    return out;
  };
  function buildCells(t, atlas) {
    const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj,
      itemMap: realItemMap, materialMap: realMaterialMap });
    b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
    return decode(b).map((i) => i.cell);
  }

  const atlas = makeMockAtlas();
  const barrelItem = { type: "BARREL", mat_type: 420, mat_index: 30, subtype: -1, iflags: 0, stack: 1 };
  const meatPeek = { type: "MEAT", mat_type: 19, mat_index: 5, subtype: -1, cflags: 0 };

  // classifier hook (same builder convention as _resolveItemEntryForTest)
  const hookB = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj,
    itemMap: realItemMap, materialMap: realMaterialMap });
  const pk = hookB._containerPeekEntryForTest;
  check("GL classifier: BARREL+MEAT -> ITEM_BARREL_TOP_MEAT cell",
    JSON.stringify(pk(barrelItem, meatPeek)) === JSON.stringify(CELL("ITEM_BARREL_TOP_MEAT")));
  check("GL classifier: BARREL+PLANT cflags1 -> _PLANT_SUBTERRANEAN; cflags0 -> _PLANT",
    JSON.stringify(pk(barrelItem, { type: "PLANT", mat_type: 419, mat_index: 12, cflags: 1 })) ===
      JSON.stringify(CELL("ITEM_BARREL_TOP_PLANT_SUBTERRANEAN")) &&
    JSON.stringify(pk(barrelItem, { type: "PLANT", mat_type: 419, mat_index: 12, cflags: 0 })) ===
      JSON.stringify(CELL("ITEM_BARREL_TOP_PLANT")));
  const binItem = { type: "BIN", mat_type: 420, mat_index: 30 };
  check("GL classifier: BIN+BAR coal-mat -> TOP_COAL; other BAR -> TOP_BARS",
    JSON.stringify(pk(binItem, { type: "BAR", mat_type: 7, mat_index: 0, cflags: 0 })) ===
      JSON.stringify(CELL("ITEM_BIN_TOP_COAL")) &&
    JSON.stringify(pk(binItem, { type: "BAR", mat_type: 0, mat_index: metalIdx, cflags: 0 })) ===
      JSON.stringify(CELL("ITEM_BIN_TOP_BARS")));
  check("GL classifier: BIN+CHAIN metal -> TOP_CHAINS; non-metal -> TOP_ROPES",
    JSON.stringify(pk(binItem, { type: "CHAIN", mat_type: 0, mat_index: metalIdx, cflags: 0 })) ===
      JSON.stringify(CELL("ITEM_BIN_TOP_CHAINS")) &&
    JSON.stringify(pk(binItem, { type: "CHAIN", mat_type: 420, mat_index: 0, cflags: 0 })) ===
      JSON.stringify(CELL("ITEM_BIN_TOP_ROPES")));
  check("GL classifier: unmapped content (ANVIL) -> null (no invented cell)",
    pk(barrelItem, { type: "ANVIL", mat_type: 0, mat_index: 0, cflags: 0 }) === null);
  check("GL classifier: non-container item (TABLE) with a peek -> null",
    pk({ type: "TABLE", mat_type: 420, mat_index: 30 }, meatPeek) === null);

  // scene emit: container base cell then overlay cell, in painter order
  const baseCell = atlas.resolve(BARREL_BASE.sheet, BARREL_BASE.col, BARREL_BASE.row);
  const meatTop = CELL("ITEM_BARREL_TOP_MEAT");
  const meatCell = atlas.resolve(meatTop.sheet, meatTop.col, meatTop.row);
  const withPeek = buildCells(tile({ item: barrelItem, peek: meatPeek }), atlas);
  check("GL emits the container sprite for the seeded barrel", withPeek.includes(baseCell));
  check("GL emits the MEAT peek overlay cell", withPeek.includes(meatCell));
  check("GL emits the overlay AFTER the container (painter order: contents over the rim)",
    withPeek.indexOf(meatCell) > withPeek.indexOf(baseCell));

  // seeded-bad: peek overlay WITHOUT contents must FAIL (must not appear)
  const noPeek = buildCells(tile({ item: barrelItem }), atlas);
  check("seeded-bad GL: barrel WITHOUT contents emits NO peek overlay", !noPeek.includes(meatCell));
  // unmapped peek == exactly the plain-container scene (no extra instance of any kind)
  const unmapped = buildCells(tile({ item: barrelItem, peek: { type: "ANVIL", mat_type: 0, mat_index: 0, cflags: 0 } }), atlas);
  check("GL: unmapped content renders byte-identical to a plain container",
    JSON.stringify(unmapped) === JSON.stringify(noPeek));
}

// =============================================================================================
// (2)+(3 canvas2d) tiles renderer: classifier + drawItem blits base THEN overlay
// =============================================================================================
console.log("TX1 canvas2d: classifier + drawItem composites base cell THEN overlay cell");

// DOM-less harness (wc4_building_test.mjs convention) with two additions: FakeImage fires
// onload synchronously (so getSheet()'s sheets read as loaded and blitCell actually draws),
// and the 2d context records drawImage source rects for assertions.
const drawImageCalls = [];
class FakeImage {
  constructor() { this.onload = null; this.onerror = null; this._src = ""; this.width = 256; this.height = 448; }
  set src(v) { this._src = v; if (this.onload) { try { this.onload(); } catch (_) { /* draw() noise */ } } }
  get src() { return this._src; }
}
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {}
  removeEventListener() {}
  getContext() {
    return new Proxy({}, {
      get(t, prop) {
        if (prop in t) return t[prop];
        if (prop === "measureText") return () => ({ width: 8 });
        if (prop === "drawImage") return (img, sx, sy, sw, sh) => { drawImageCalls.push({ src: img && img._src || "", sx, sy, sw, sh }); };
        return (..._args) => {};
      },
      set(t, prop, v) { t[prop] = v; return true; },
    });
  }
}
const storageBacking = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = {
  hidden: false,
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return { style: {}, getContext: () => new FakeCanvasEl().getContext() }; },
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
globalThis.sessionStorage = {
  getItem: (k) => (k in storageBacking ? storageBacking[k] : null),
  setItem: (k, v) => { storageBacking[k] = String(v); },
};
globalThis.Image = FakeImage;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("item_map.json") !== -1) return { ok: true, json: async () => realItemMap };
  if (u.indexOf("material_map.json") !== -1) return { ok: true, json: async () => realMaterialMap };
  return { ok: false, json: async () => null };
};

vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"),
  { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles;
assert.ok(Tiles, "dwf-tiles.js did not install window.DwfTiles");
assert.ok(Tiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false }),
  "init() returned null");

async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > (maxMs || 2000)) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

(async function main() {
  const barrelItem = { type: "BARREL", mat_type: 420, mat_index: 30, subtype: -1, iflags: 0, stack: 1 };
  const meatPeek = { type: "MEAT", mat_type: 19, mat_index: 5, subtype: -1, cflags: 0 };

  await waitUntil(() => Tiles._containerPeekEntryForTest(barrelItem, meatPeek) !== null, 2000);
  Tiles._setMaterialMapForTest(realMaterialMap);

  const pk = Tiles._containerPeekEntryForTest;
  check("c2d classifier: BARREL+MEAT -> ITEM_BARREL_TOP_MEAT cell",
    JSON.stringify(pk(barrelItem, meatPeek)) === JSON.stringify(CELL("ITEM_BARREL_TOP_MEAT")));
  check("c2d classifier: BARREL+FISH_RAW -> ITEM_BARREL_TOP_FISH cell",
    JSON.stringify(pk(barrelItem, { type: "FISH_RAW", mat_type: 19, mat_index: 2, cflags: 0 })) ===
      JSON.stringify(CELL("ITEM_BARREL_TOP_FISH")));
  check("c2d classifier: BIN+CHAIN metal -> TOP_CHAINS; plant-mat -> TOP_ROPES",
    JSON.stringify(pk({ type: "BIN" }, { type: "CHAIN", mat_type: 0, mat_index: metalIdx, cflags: 0 })) ===
      JSON.stringify(CELL("ITEM_BIN_TOP_CHAINS")) &&
    JSON.stringify(pk({ type: "BIN" }, { type: "CHAIN", mat_type: 420, mat_index: 0, cflags: 0 })) ===
      JSON.stringify(CELL("ITEM_BIN_TOP_ROPES")));
  check("c2d classifier: unmapped content (ANVIL) -> null; non-container -> null",
    pk(barrelItem, { type: "ANVIL", mat_type: 0, mat_index: 0, cflags: 0 }) === null &&
    pk({ type: "TABLE" }, meatPeek) === null);

  // drawItem composite: base cell then overlay cell (source-rect assertions on containers.png)
  const draws = () => drawImageCalls.filter((c) => c.src.indexOf(BARREL_BASE.sheet) !== -1);
  drawImageCalls.length = 0;
  Tiles._drawItemForTest({ item: barrelItem, peek: meatPeek }, 0, 0, 32);
  let d = draws();
  const meatTop = CELL("ITEM_BARREL_TOP_MEAT");
  check("c2d: seeded barrel blits exactly 2 container-sheet cells (base + peek overlay)", d.length === 2);
  check("c2d: first blit is the BARREL base cell",
    d.length === 2 && d[0].sx === BARREL_BASE.col * 32 && d[0].sy === BARREL_BASE.row * 32);
  check("c2d: second blit is the ITEM_BARREL_TOP_MEAT overlay cell (over the rim)",
    d.length === 2 && d[1].sx === meatTop.col * 32 && d[1].sy === meatTop.row * 32);

  // seeded-bad: peek without contents must FAIL (no overlay blit)
  drawImageCalls.length = 0;
  Tiles._drawItemForTest({ item: barrelItem }, 0, 0, 32);
  d = draws();
  check("seeded-bad c2d: barrel WITHOUT contents blits ONLY the base cell", d.length === 1 &&
    d[0].sx === BARREL_BASE.col * 32 && d[0].sy === BARREL_BASE.row * 32);

  // unmapped content -> plain container
  drawImageCalls.length = 0;
  Tiles._drawItemForTest({ item: barrelItem, peek: { type: "ANVIL", mat_type: 0, mat_index: 0, cflags: 0 } }, 0, 0, 32);
  d = draws();
  check("c2d: unmapped content blits ONLY the base cell (no invented overlay)", d.length === 1);

  console.log(failed === 0 ? "PASS (0 failures)" : `FAIL (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err && err.stack || err);
  process.exit(1);
});
