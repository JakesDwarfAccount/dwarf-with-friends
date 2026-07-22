import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = {
  hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return { style: {}, getContext() { return {}; } }; },
  body: { appendChild() {} }, scripts: [],
};
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });

vm.runInThisContext(read("web", "js", "dwf-wire-v1.js"), { filename: "dwf-wire-v1.js" });

const recordBytes = new Uint8Array(12);
recordBytes[7] = 0x81; // Default dig kind + automine high bit.
const decodedRecord = globalThis.DwfWireV1.decodeTileRecord(
  new DataView(recordBytes.buffer), 0,
);
assert.equal(decodedRecord.dig, 1);
assert.equal(decodedRecord.automine, 1, "wire decoder must expose designation bit 7");

vm.runInThisContext(read("web", "js", "dwf-cache-worker.js"), { filename: "dwf-cache-worker.js" });
vm.runInThisContext(read("web", "js", "dwf-cache.js"), { filename: "dwf-cache.js" });

// One complete BLOCK_SET payload. Tile zero is an automining wall; all remaining records are void.
const payload = [];
const u8 = v => payload.push(v & 0xff);
const u16 = v => { u8(v); u8(v >> 8); };
const u32 = v => { u16(v); u16(v >>> 16); };
u32(1); u16(1);             // world sequence, block count
u16(0); u16(0); u16(10);   // block x/y/z
u32(1); u8(0); u16(0);     // block version, flags, tail count
for (let i = 0; i < 256; i++) {
  u16(i === 0 ? 1 : 0xffff); // tiletype
  u16(0); u16(0);            // material
  u8(0);                     // terrain bits
  u8(i === 0 ? 0x81 : 0);    // desig1
  u8(0); u8(0); u16(0);      // desig2, spatter, flags2
}
globalThis.DwfCache._resetForTest();
globalThis.DwfCache.setTiletypeMeta([[1, "StoneWall", "WALL", "STONE", "NORMAL"]]);
globalThis.DwfCache.ingestBlocks(new Uint8Array(payload));
const cached = globalThis.DwfCache.windowView(0, 0, 10, 1, 1).tiles[0];
assert.equal(cached.desig.dig, "Default");
assert.equal(cached.desig.automine, 1, "cache must preserve automine from wire to renderer view");

const glbox = { self: null, performance: { now: () => 0 } };
glbox.self = glbox;
vm.createContext(glbox);
vm.runInContext(read("web", "js", "dwf-gl.js"), glbox, { filename: "dwf-gl.js" });
const GL = glbox.DwfGL;

class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() {
    return new Proxy({}, { get(t, p) {
      if (p in t) return t[p];
      if (p === "measureText") return () => ({ width: 8 });
      return () => {};
    }, set(t, p, v) { t[p] = v; return true; } });
  }
}
vm.runInThisContext(read("web", "js", "dwf-tiles.js"), { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });
const terrain = { mat: "STONE", shape: "WALL" };

assert.equal(GL.resolveDesig(cached.desig, terrain).cat, "automine");
assert.equal(Tiles._resolveDesigForTest(cached.desig, terrain).cat, "automine");
assert.equal(GL.resolveDesig({ ...cached.desig, automine: 0 }, terrain).cat, "dig");
assert.equal(Tiles._resolveDesigForTest({ ...cached.desig, automine: 0 }, terrain).cat, "dig");
assert.equal(GL.DESIG_TINT_RGB.automine, undefined, "automining must not add the generic wash");
assert.equal(Tiles._DESIG_TINT.automine, undefined, "canvas must not add the generic wash");
assert.deepEqual(Array.from(GL.AUTOMINE_SPRITE_TINT), [0, 255, 0]);
assert.deepEqual(Tiles._AUTOMINE_SPRITE_TINT, [0, 255, 0]);

// Drive the real WebGL scene builder. The designation-sheet instance must be pure-green and
// automining must not receive B38's additive wall-lighten instance.
const atlasIds = new Map();
const atlas = { resolve(sheet, col, row) {
  const key = `${sheet}|${col}|${row}`;
  if (!atlasIds.has(key)) atlasIds.set(key, atlasIds.size + 1);
  return atlasIds.get(key);
} };
const builder = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
builder.buildScene({ origin: { x: 0, y: 0, z: 10 }, width: 1, height: 1, tiles: [{
  tt: 1, ttname: "StoneWall", shape: "WALL", mat: "STONE", hidden: false,
  flow: 0, liquid: "none", outside: 0, desig: cached.desig,
}] });
const instanceU16 = new Uint16Array(builder.buffer), u8view = new Uint8Array(builder.buffer);
const instances = Array.from({ length: builder.count }, (_, i) => ({
  cell: instanceU16[i * 8 + 4], attr: instanceU16[i * 8 + 5],
  rgba: Array.from(u8view.slice(i * 16 + 12, i * 16 + 16)),
}));
const digCell = atlas.resolve("designations.png", 0, 1);
const glyph = instances.find(instance => instance.cell === digCell);
assert.ok(glyph, "WebGL scene must emit the native pick cell");
assert.deepEqual(glyph.rgba, [0, 255, 0, 255], "the complete pick cell must be pure-green multiplied");
assert.ok(!instances.some(instance => instance.cell === GL.SOLID_CELL && (instance.attr & GL.ATTR_ADDITIVE)),
  "automining must not receive the ordinary designation wall-lighten layer");

const oraclePath = path.join(root, "Menu Oracle Screenshots", "designations",
  "native automining designation green tint.png");
if (fs.existsSync(oraclePath)) {
  const oracleHash = crypto.createHash("sha256").update(fs.readFileSync(oraclePath)).digest("hex").toUpperCase();
  assert.equal(oracleHash, "30F42D6EAD2E67A9649C4F0BB14BDC93E95958606A037549DB46FAA767BFB000",
    "automining color contract must remain bound to Jake's exact native capture");
}

// Native compositing anchor from the saved PNG. The dominant untouched background is (49,44,52).
// The dominant designations.png pixel is (125,125,127,a=90). Multiplying the entire source by
// pure green before normal alpha compositing rounds to the capture's dominant (32,73,34).
const alpha = 90 / 255;
const nativeComposite = [
  Math.round(49 * (1 - alpha)),
  Math.round(125 * alpha + 44 * (1 - alpha)),
  Math.round(52 * (1 - alpha)),
];
assert.deepEqual(nativeComposite, [32, 73, 34]);

const glSource = read("web", "js", "dwf-gl.js");
const canvasSource = read("web", "js", "dwf-tiles.js");
assert.match(glSource, /if \(!automine\) \{[\s\S]*?emitSolid\(e\.gx, e\.gy, rgb, washA, 0\)/,
  "WebGL must skip the separate wash for automining");
assert.match(canvasSource, /if \(marker \|\| r\.cat !== "automine"\) \{[\s\S]*?ctx\.fillRect\(px, py, cell, cell\)/,
  "Canvas must skip the separate wash for automining");
assert.match(canvasSource, /r\.cat === "automine" \? AUTOMINE_SPRITE_TINT/,
  "Canvas must multiply-tint the actual designation sprite");

const nativeSource = read("src", "world_stream.cpp") + read("src", "wire_v1.cpp");
assert.match(nativeSource, /mask_dig_auto/,
  "automine-only occupancy changes must invalidate the streamed block");
assert.match(nativeSource, /occ\.bits\.dig_auto/,
  "native encoder must read DF's automining occupancy bit");

console.log("PASS automining reaches both renderers and uses the native whole-sprite green treatment");
