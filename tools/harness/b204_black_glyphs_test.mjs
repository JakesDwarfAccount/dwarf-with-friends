// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// BLACK-GLYPHS / B204 -- the RENDER half of B133.
//
// B133 fixed the INPUT half: a mining designation dropped into unexplored ("black") rock is
// accepted by the server and written to the map. But the owner could not SEE the resulting glyph. Root
// cause (server): world_stream's block_discovered() gate drops any FULLY-hidden block from BOTH
// the per-tick stream AND the REQ_BLOCKS refill -- so a fully-unexplored block carrying a fresh
// designation never reaches the client at all (no tiletype, no designation) and renders as pure
// black. Native DF (local) draws the pick glyph over that black; we shipped no data to draw from.
//
// Fix (additive, fog-safe):
//   - server (rides the next DLL window): a fully-hidden block that carries an active designation
//     is now SHIPPABLE (block_shippable = block_discovered || block_has_active_designation), and
//     encode_block emits such a block with VOID tiletypes -- only the designation bytes cross the
//     wire, so no real terrain/material leaks past fog-of-war.
//   - client (live now): the cache preserves a void tile's designation and windowView surfaces a
//     {tt:-1, hidden:1, desig} tile; both renderers already draw the glyph over black with NO
//     terrain invented under it.
//
// The C++ half cannot run in this JS harness (it rides the DLL rebuild); it is covered by
// STRING-LITERAL witnesses + test-the-test negations, exactly like the b52/b53 and b133 cells.
// The client half is exercised end-to-end (real wire frame -> real cache -> real renderers).
//
// Run: node tools/harness/b204_black_glyphs_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok - " + name); }
  catch (err) { failed++; console.log("  FAIL - " + name + ": " + (err && err.message || err)); }
}
function section(s) { console.log("\n# " + s); }

// ---------------------------------------------------------------------------------------------
// Shared wire-frame builder (mirrors tools/harness/gen_wire_fixture.mjs / src/wire_v1.cpp layout).
// ---------------------------------------------------------------------------------------------
class Buf {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 0xff); return this; }
  u16(v) { this.a.push(v & 0xff, (v >> 8) & 0xff); return this; }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) { this.a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  bytes(arr) { for (const b of arr) this.a.push(b & 0xff); return this; }
  out() { return new Uint8Array(this.a); }
}
const packDesig1 = (dig, smooth, marker) => ((dig & 15) | ((smooth & 3) << 4) | ((marker & 1) << 6)) & 0xff;
const packDesig2 = (traffic, track) => ((traffic & 3) | ((track & 15) << 2)) & 0xff;
function voidRec(over) {
  return Object.assign({ tt: 0xffff, base_mt: 0, base_mi: 0, bits: 0, desig1: 0, desig2: 0, spatter_amt: 0, flags2: 0 }, over || {});
}
// One BLOCK_SET PAYLOAD (the wire frame header is stripped by the WS handler before ingestBlocks;
// DwfWireV1.decodeBlockSet reads from world_seq). records is a 256-array of rec objects.
function frameFor(block) {
  const payload = new Buf();
  payload.u32(1);         // world_seq
  payload.u16(1);         // block count
  payload.u16(block.bx); payload.u16(block.by); payload.u16(block.bz); payload.u32(block.ver || 1);
  payload.u8(0); payload.u16(0);   // bflags, tail_count
  for (const r of block.records) {
    payload.u16(r.tt); payload.i16(r.base_mt); payload.i16(r.base_mi);
    payload.u8(r.bits); payload.u8(r.desig1); payload.u8(r.desig2); payload.u8(r.spatter_amt); payload.u16(r.flags2);
  }
  return payload.out().buffer;
}

// =============================================================================================
section("client cache: a fully-hidden block's designation survives as a glyph-over-black tile");
// =============================================================================================
// Load the real cache stack in sync mode (mirrors cache_test.mjs' scaffolding).
globalThis.window = globalThis;
globalThis.document = { getElementsByTagName: () => [], hidden: false, addEventListener() {},
  getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.addEventListener = () => {};
const _store = {};
globalThis.sessionStorage = { getItem: k => _store[k] ?? null, setItem: (k, v) => { _store[k] = String(v); } };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });

vm.runInThisContext(read("web", "js", "dwf-wire-v1.js"), { filename: "dwf-wire-v1.js" });
vm.runInThisContext(read("web", "js", "dwf-cache-worker.js"), { filename: "dwf-cache-worker.js" });
vm.runInThisContext(read("web", "js", "dwf-cache.js"), { filename: "dwf-cache.js" });
const Cache = globalThis.DwfCache;
assert.ok(Cache, "DwfCache must install");
assert.equal(Cache._backend(), "sync", "sync fallback backend expected");

// Block at world origin (176, 160, 20) -> bx=11, by=10, bz=20. Every tile hidden (fully-hidden
// block); tile idx 5 (local 5,0 -> world 181,160) carries a Default (mining) designation, tile
// idx 6 stays a pure void record. This is EXACTLY what the patched encode_block emits for a
// fully-hidden shippable block.
const OX = 176, OY = 160, Z = 20;
const records = [];
for (let i = 0; i < 256; i++) records[i] = voidRec({});
records[5] = voidRec({ desig1: packDesig1(1, 0, 0), desig2: 0 });   // dig=Default over black
Cache._resetForTest();
Cache._setBudgetForTest(128 * 1024 * 1024);
Cache.setTiletypeMeta([[2, "StoneWall", "WALL", "STONE", "NORMAL"]]);
Cache.ingestBlocks(frameFor({ bx: 11, by: 10, bz: Z, ver: 1, records }));

const view = Cache.windowView(OX, OY, Z, 16, 1);   // one row, world x=176..191 at y=160
const desigTile = view.tiles.find(t => t.x === 181 && t.y === 160);
const plainTile = view.tiles.find(t => t.x === 182 && t.y === 160);

check("designated fully-hidden tile surfaces with tt=-1 (no terrain), hidden, and the designation", () => {
  assert.ok(desigTile, "the designated tile must be present in the view");
  assert.equal(desigTile.tt, -1, "no real tiletype crosses the wire for an undiscovered tile");
  assert.equal(desigTile.hidden, 1, "the tile reports hidden so the glyph reads over black");
  assert.ok(desigTile.desig, "the designation must survive ingest of a void tiletype");
  assert.equal(desigTile.desig.dig, "Default", "a Default mining designation round-trips");
});
check("an undesignated tile in the SAME fully-hidden block stays pure black (bare void, no desig)", () => {
  assert.ok(plainTile, "the plain tile is still enumerated in the view");
  assert.equal(plainTile.tt, -1);
  assert.equal(plainTile.desig, undefined, "no designation, no hidden fill -- renders pure black");
  assert.notEqual(plainTile.hidden, 1);
});
check("(test-the-test) the old ingest that zeroed a void tile's designation would drop the glyph", () => {
  // Seeded-bad: if writeBlockTile still did `chunk.desig[idx] = 0` on tt===0xffff, decodeDesigObj
  // would see 0 and windowView would return a bare void tile -- exactly the pre-fix symptom.
  const worker = read("web", "js", "dwf-cache-worker.js");
  const voidBranch = worker.slice(worker.indexOf("function writeBlockTile"), worker.indexOf("function writeBlockTile") + 700);
  assert.doesNotMatch(voidBranch, /rec\.tt === 0xffff\)\s*\{[\s\S]*?chunk\.desig\[idx\] = 0;/,
    "writeBlockTile must NOT hard-zero desig on a void tile any more");
});

// =============================================================================================
section("GL renderer: dig glyph over black, no terrain invented");
// =============================================================================================
const glbox = { self: null, performance: { now: () => 0 } }; glbox.self = glbox;
vm.createContext(glbox);
vm.runInContext(read("web", "js", "dwf-gl.js"), glbox, { filename: "dwf-gl.js" });
const GL = glbox.DwfGL;
const sheetOf = new Map();     // cell id -> sheet name
let nextId = 1;
const atlas = { resolve(sheet, col, row) {
  const key = sheet + "|" + col + "|" + row;
  if (!atlas._m) atlas._m = new Map();
  if (!atlas._m.has(key)) { const id = nextId++; atlas._m.set(key, id); sheetOf.set(id, sheet); }
  return atlas._m.get(key);
} };
const DIG_GLYPH = atlas.resolve("designations.png", 0, 1);

function glCellsFor(tile) {
  const builder = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  builder.buildScene({ origin: { x: 10, y: 20, z: 30 }, width: 1, height: 1, tiles: [tile], djobs: [], designationNowMs: 0 });
  const u16 = new Uint16Array(builder.buffer);
  return Array.from({ length: builder.count }, (_, i) => u16[i * 8 + 4]);
}
const glVoidDesig = { x: 10, y: 20, tt: -1, hidden: 1, desig: { dig: "Default", smooth: 0, traffic: 0, track: 0, marker: false } };
const glVoidPlain = { x: 10, y: 20, tt: -1 };
const glExplored  = { tt: 2, ttname: "StoneWall", shape: "WALL", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 0,
                      desig: { dig: "Default", smooth: 0, traffic: 0, track: 0, marker: false } };

check("designated + fully-hidden void tile emits the dig glyph in GL", () => {
  assert.ok(glCellsFor(glVoidDesig).includes(DIG_GLYPH), "the mining glyph must be emitted over the black tile");
});
check("GL invents no terrain under the glyph (only SOLID fills + the designation glyph)", () => {
  const cells = glCellsFor(glVoidDesig);
  for (const c of cells) {
    if (c === GL.SOLID_CELL) continue;             // flat colour fill / additive lighten -- not terrain
    const sheet = sheetOf.get(c);
    assert.ok(sheet === "designations.png", "unexpected non-designation sprite cell (sheet=" + sheet + ")");
  }
});
check("undesignated fully-hidden void tile emits NO glyph (stays black)", () => {
  assert.ok(!glCellsFor(glVoidPlain).includes(DIG_GLYPH), "a plain void tile must not draw a designation");
});
check("explored designated tile still emits the dig glyph (regression)", () => {
  assert.ok(glCellsFor(glExplored).includes(DIG_GLYPH), "a normal visible designated tile is unchanged");
});

// =============================================================================================
section("canvas2d renderer: dig glyph over black, no terrain invented");
// =============================================================================================
const drawCalls = [];
class RecCtx {
  constructor() { this.canvas = { width: 800, height: 600 }; }
  save() {} restore() {} beginPath() {} moveTo() {} lineTo() {} arc() {} stroke() {} fill() {}
  setLineDash() {} strokeRect() {} translate() {} scale() {} clip() {} rect() {} closePath() {}
  measureText() { return { width: 8 }; }
  createLinearGradient() { return { addColorStop() {} }; }
  fillRect(x, y, w, h) { drawCalls.push({ op: "fillRect", x, y, w, h }); }
  drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { drawCalls.push({ op: "drawImage", sx, sy, sw, sh, dw, dh }); }
}
class RecCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; this._ctx = new RecCtx(); }
  addEventListener() {} removeEventListener() {} getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  getContext() { return this._ctx; }
}
vm.runInThisContext(read("web", "js", "dwf-tiles.js"), { filename: "dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new RecCanvas(), managePoll: false, manageCamera: false });
assert.equal(typeof Tiles._drawDesignationForTest, "function", "canvas designation draw hook must export");
// Inject a "loaded" designation sheet so the real glyph BLIT path (not the synthetic fallback) runs.
Tiles._setSheetForTest("designations.png", { loaded: true, failed: false, img: {} });

const c2dVoidDesig = { x: 181, y: 160, tt: -1, hidden: 1, desig: { dig: "Default", smooth: 0, traffic: 0, track: 0, marker: false } };
const c2dVoidPlain = { x: 182, y: 160, tt: -1 };

check("designated + fully-hidden void tile blits the dig glyph (col0,row1 -> sx0,sy32) in canvas2d", () => {
  drawCalls.length = 0;
  Tiles._drawDesignationForTest(c2dVoidDesig, 0, 0, 16, 0, 0, false, false);
  const blits = drawCalls.filter(c => c.op === "drawImage");
  assert.ok(blits.some(b => b.sx === 0 && b.sy === 32 && b.sw === 32 && b.sh === 32),
    "the mining glyph cell must blit from designations.png at (0,32)");
});
check("canvas2d designation overlay invents no terrain (its only blit is the designation glyph)", () => {
  // drawDesignation draws ONLY the wash (fillRect) + the glyph blit + outline; it never blits a
  // terrain sprite. Assert every drawImage in the pass is the 32x32 designation cell.
  const blits = drawCalls.filter(c => c.op === "drawImage");
  for (const b of blits) assert.ok(b.sw === 32 && b.sh === 32, "only 32x32 designation-sheet cells may blit here");
});
check("undesignated void tile resolves to no designation (canvas2d draws nothing)", () => {
  drawCalls.length = 0;
  assert.equal(Tiles._resolveTileDesignationForTest(c2dVoidPlain, 0), null, "no desig -> resolver returns null");
  Tiles._drawDesignationForTest(c2dVoidPlain, 0, 0, 16, 0, 0, false, false);
  assert.equal(drawCalls.filter(c => c.op === "drawImage").length, 0, "a plain void tile blits nothing");
});

// =============================================================================================
section("server half (rides the DLL): STRING-LITERAL witnesses + test-the-test");
// =============================================================================================
const worldStream = read("src", "world_stream.cpp");
const wire = read("src", "wire_v1.cpp");

check("world_stream defines block_has_active_designation over dig/smooth/traffic + carve-track/marker", () => {
  const fn = worldStream.slice(worldStream.indexOf("bool block_has_active_designation"),
                              worldStream.indexOf("bool block_has_active_designation") + 900);
  assert.match(fn, /d\.bits\.dig != df::tile_dig_designation::No/);
  assert.match(fn, /d\.bits\.smooth != 0/);
  assert.match(fn, /d\.bits\.traffic != df::tile_traffic::Normal/);
  assert.match(fn, /o\.bits\.dig_marked/);
  assert.match(fn, /carve_track_north|carve_track_south|carve_track_east|carve_track_west/);
});
check("block_shippable = discovered OR carries a designation", () => {
  assert.match(worldStream, /bool block_shippable\(df::map_block\* b\)\s*\{\s*return block_discovered\(b\) \|\| block_has_active_designation\(b\);/);
});
check("all four block-selection gates now use block_shippable (per-tick, in-view, REQ_BLOCKS, trickle)", () => {
  const shippable = (worldStream.match(/block_shippable\(/g) || []).length;
  // 1 definition body + 4 call sites = 5 textual occurrences of block_shippable(.
  assert.ok(shippable >= 5, "expected >=5 block_shippable( occurrences, saw " + shippable);
});
check("(test-the-test) no block-selection gate still rejects a fully-hidden designated block via block_discovered", () => {
  // The bug was these 4 sites calling block_discovered directly. They must now all be block_shippable;
  // block_discovered survives only as a helper + inside block_shippable.
  assert.doesNotMatch(worldStream, /if \(!block_discovered\(b\)\) continue;/);
  assert.doesNotMatch(worldStream, /if \(!block_discovered\(b\)\) return true;/);
  assert.doesNotMatch(worldStream, /if \(!block_discovered\(b\)\) \{ cs\.pending\.erase/);
});
check("encode_block ships a fully-hidden block with VOID tiletypes but keeps the designation bytes", () => {
  assert.match(wire, /bool block_fully_hidden = true;/);
  const branch = wire.slice(wire.indexOf("if (block_fully_hidden) {"), wire.indexOf("if (block_fully_hidden) {") + 260);
  assert.match(branch, /r\.tt = 0xFFFF;/, "tiletype voided (no terrain leak)");
  assert.match(branch, /r\.base_mt = -1; r\.base_mi = -1;/, "base material voided (no ore/gem leak)");
  assert.match(branch, /continue;/, "sparse tails skipped for an undiscovered tile");
  // desig1/desig2 are set ABOVE this branch and deliberately NOT cleared -> they survive.
  assert.doesNotMatch(branch, /r\.desig1 = 0/, "the designation bytes must NOT be cleared");
});

// =============================================================================================
section("B209 UN-SHIP: erasing the LAST designation in a fully-hidden block clears the client glyph");
// =============================================================================================
// The B204 fix above lets a fully-hidden block ship WHILE it carries a designation -- but the very
// block_shippable gate that let it through is what hid its ERASURE: once the last designation is
// cleared the block is no longer shippable, so the per-tick sig-scan skipped it forever and the
// client kept drawing the erased pick over the black ("the eraser tool cant remove the
// designations" in the unrendered area). B209 keeps a block we ALREADY tracked in the sig-scan
// after it goes dark -- so the cleared designation registers as a signature change, dirties the
// block, and re-encodes it as a pure-void (desig==0) frame -- and OFFERS that void frame to any
// conn that still HOLDS the block (never to a conn that lacks it -- fog preserved). The client half
// needs no change: writeBlockTile overwrites the tile's desig on every frame, so a desig==0 void
// tile clears the cached glyph, and the renderers (proven above) draw nothing for it. Server half
// rides the next DLL window (string-literal witnesses); client overwrite is a live source witness.
check("(server) sig-scan keeps a previously-tracked block after it goes dark (detects the erase)", () => {
  // A block with a sig entry (already shipped, e.g. the B204 designation-over-black) is NOT skipped
  // when it stops being shippable, so block_signature re-runs and the cleared designation dirties it.
  assert.match(worldStream,
    /if \(!block_shippable\(b\) && g_gms\.sig\.find\(key\) == g_gms\.sig\.end\(\)\) continue;/,
    "the sig-scan must exempt an already-tracked (sig-mapped) block from the shippable skip");
});
check("(server) in-view + REQ selection offer the void frame to a conn that still holds the block", () => {
  const unship = (worldStream.match(/!block_shippable\(b\) && cs\.sent_ver\.find\(key\) == cs\.sent_ver\.end\(\)/g) || []).length;
  assert.ok(unship >= 2, "expected the sent_ver-held un-ship escape at BOTH the in-view and REQ gates, saw " + unship);
});
check("(server, test-the-test) no block-selection gate bare-skips a tracked block that just went dark", () => {
  // The bug shape is the UNCONDITIONAL skip. After B209 every !block_shippable skip in a SELECTION/
  // scan context must carry an escape (sig-mapped, or the conn already holds it) -- never bare.
  assert.doesNotMatch(worldStream, /if \(!block_shippable\(b\)\) continue;\n\s*uint64_t sig/,
    "the sig-scan must not bare-skip -- that is exactly what stranded the erased glyph");
  assert.doesNotMatch(worldStream, /if \(!block_shippable\(b\)\) \{ cs\.pending\.erase\(key\); continue; \}/,
    "the REQ gate must not bare-skip a block the conn still holds");
});
check("(client) writeBlockTile OVERWRITES a void tile's designation each frame (desig==0 clears it)", () => {
  const worker = read("web", "js", "dwf-cache-worker.js");
  const branch = worker.slice(worker.indexOf("if (rec.tt === 0xffff) {"),
                              worker.indexOf("if (rec.tt === 0xffff) {") + 900);
  // The void branch unconditionally assigns chunk.desig[idx] from the record -- it never MERGES with
  // the prior value -- so a re-shipped void tile with rec.dig==0 (etc.) writes 0 and the glyph clears.
  assert.match(branch, /chunk\.desig\[idx\] = \(vd1 & 0xFF\) \| \(\(vd2 & 0xFF\) << 8\);/,
    "the void branch must write desig from the record (overwrite), not preserve the prior glyph");
  assert.match(branch, /var vd1 = \(rec\.dig & 0xF\)/, "desig is rebuilt from the wire record's dig/smooth/marker");
});

if (failed) { console.error("\nFAIL " + failed + " B204/B209 cell(s)"); process.exit(1); }
console.log("\nPASS B204 black-glyphs + B209 un-ship: fully-hidden designated blocks ship, render, AND clear on erase");
