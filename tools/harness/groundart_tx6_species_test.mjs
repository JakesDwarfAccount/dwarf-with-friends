// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { loadTiles, loadGL } from "./groundart_fixture_support.mjs";

const T = loadTiles(), G = loadGL();
const pomelo = process.env.TX6_SEED_BROKEN ? [98, 142, 73] : [173, 205, 48];
const olive = [98, 142, 73];
for (const api of [T._itemSpatterTintRgbForTest, G.itemSpatterTintRgb]) {
  assert.notDeepEqual(Array.from(api("FRUIT", pomelo)), Array.from(api("FRUIT", olive)),
    "pomelo and olive material colors must remain visually distinct");
  assert.deepEqual(Array.from(api("FRUIT")), [194, 120, 38],
    "old/unresolved tails retain the TX6 fruit-family fallback");
  assert.equal(api("OTHER", pomelo), null, "OTHER remains untinted even when RGB is present");
}

const box = { console }; box.self = box;
vm.createContext(box);
vm.runInContext(fs.readFileSync("web/js/dwf-wire-v1.js", "utf8"), box);
const W = box.DwfWireV1;
const oldTail = new Uint8Array([2, 56, 12]);
assert.deepEqual({ ...W.decodeTailData(W.C.TAIL_ITEM_SPATTER, new DataView(oldTail.buffer), 0, 3) },
  { growth_class: 2, item_type: 56, amount: 12 }, "3-byte legacy tail stays unchanged");
const rgbTail = new Uint8Array([2, 56, 12, 1, ...pomelo]);
const decoded = W.decodeTailData(W.C.TAIL_ITEM_SPATTER, new DataView(rgbTail.buffer), 0, 7);
assert.deepEqual(Array.from(decoded.rgb), pomelo, "7-byte tail decodes optional species material RGB");

const wire = fs.readFileSync("src/wire_v1.cpp", "utf8");
assert.match(wire, /resolve_material_rgb\(world, isp->mattype, isp->matindex/,
  "server must resolve the specific growth material, including mattype");
assert.match(wire, /make_item_spatter_tail[\s\S]*if \(has_rgb\)[\s\S]*push_back\(1\)/,
  "server must preserve the optional additive extension gate");

// ---- END-TO-END through the REAL cache-worker ingest (TX6 rework, window #23) -------------
// The four prior TX6 fixes each verified ONE layer (server emit, wire decode, tint pick) and
// all passed while the litter still rendered uniform brown: the layer that actually broke the
// chain was dwf-cache-worker.js's ingestBlocks(), which rebuilt each ITEM_SPATTER entry
// as {growth_class,item_type,amount} and DROPPED the decoded rgb -- proven on live wire bytes
// 2026-07-10 (server c5e677a54 emitted 12 distinct species rgb values; every ingested entry
// lost them). So this section asserts species distinctness ACROSS the seam: synthetic
// BLOCK_SET payload -> REAL DwfWireV1.decodeBlockSet -> REAL cache-worker ingestBlocks
// -> chunk sparse -> the tint both renderers apply.
//
// Test-the-test negative: TX6_E2E_UNIFORM=1 makes both species' tails carry the SAME rgb --
// the distinctness assertion below must then FAIL (exit nonzero). Verified in the win23 run.
const pomegranate = [227, 66, 52];                       // VERMILION, live descriptor idx 110
const oliveFruit = process.env.TX6_E2E_UNIFORM ? pomegranate : [79, 121, 66]; // FERN_GREEN, idx 43
function itemSpatterTail(tileIdx, gclass, amount, rgb) {
  const body = rgb ? [gclass, 56, amount, 1, ...rgb] : [gclass, 56, amount];
  return [tileIdx, 0x05, body.length, ...body];
}
const BX = 1, BY = 2, BZ = 100;
const tails = [
  ...itemSpatterTail(5, 2, 200, pomegranate),
  ...itemSpatterTail(6, 2, 200, oliveFruit),
  ...itemSpatterTail(7, 2, 200, null),                   // legacy 3-byte tail: family fallback
];
const payload = new Uint8Array(4 + 2 + 13 + 256 * 12 + tails.length);
const pdv = new DataView(payload.buffer);
pdv.setUint32(0, 42, true);                              // world_seq
pdv.setUint16(4, 1, true);                               // block_count
pdv.setUint16(6, BX, true); pdv.setUint16(8, BY, true); pdv.setUint16(10, BZ, true);
pdv.setUint32(12, 1, true);                              // ver
payload[16] = 0;                                         // bflags
pdv.setUint16(17, 3, true);                              // tail_count (u16 LE, cachefix layout)
payload.set(tails, 19 + 256 * 12);

const workerBox = { console }; workerBox.self = workerBox; workerBox.window = workerBox; // fallback/sync core mode
vm.createContext(workerBox);
vm.runInContext(fs.readFileSync("web/js/dwf-wire-v1.js", "utf8"), workerBox, { filename: "dwf-wire-v1.js" });
vm.runInContext(fs.readFileSync("web/js/dwf-cache-worker.js", "utf8"), workerBox, { filename: "dwf-cache-worker.js" });
const CORE = workerBox.DwfCacheWorkerCore;
assert.ok(CORE, "dwf-cache-worker.js did not expose the fallback core");
CORE.ingestBlocks(payload);
const chunk = CORE.getChunk(BZ, BX * 4096 + BY);
assert.ok(chunk && chunk.sparse, "ingest must produce a chunk with sparse tails");
const kept5 = chunk.sparse.get(5).itemSpatters[0];
const kept6 = chunk.sparse.get(6).itemSpatters[0];
const kept7 = chunk.sparse.get(7).itemSpatters[0];
assert.deepEqual(Array.from(kept5.rgb || []), pomegranate,
  "cache-worker ingest must keep the decoded species rgb (pomegranate)");
for (const api of [T._itemSpatterTintRgbForTest, G.itemSpatterTintRgb]) {
  const tint5 = api("FRUIT", kept5.rgb), tint6 = api("FRUIT", kept6.rgb), tint7 = api("FRUIT", kept7.rgb);
  assert.notDeepEqual(Array.from(tint5), Array.from(tint6),
    "END-TO-END: two species ingested through the real cache-worker must render DISTINCT tints");
  assert.deepEqual(Array.from(tint5), pomegranate, "END-TO-END: instance rgb must win over the family tint");
  assert.deepEqual(Array.from(tint7), [194, 120, 38], "END-TO-END: rgb-less legacy tail keeps the family fallback");
}
// ---- B138: overlapping litter records must yield ONE draw (native parity) -----------------
// Native DF shows a single spatter per tile; both renderers used to draw EVERY overlapping
// ITEM_SPATTER record, multiply-compounding the tints toward brown/black. Winner rule (both
// renderers, logic-identical copies): highest amount, ties -> lowest growth_class then
// item_type, undrawable (OTHER/unmapped) records never win regardless of amount.
//
// Test-the-test negative: TX6_OVERLAP_BROKEN=1 reproduces the pre-fix visual outcome (two
// litter instances in the counted scene, one per record) -- the ONE-draw assertion below must
// then FAIL (exit nonzero). Verified in the B138 run.
const spatterMapReal = JSON.parse(fs.readFileSync("web/spatter_map.json", "utf8"));
const fruitLow = { growth_class: 2, item_type: 56, amount: 90, rgb: pomegranate };        // FRUIT
const fruitHigh = { growth_class: 4, item_type: 56, amount: 200, rgb: [79, 121, 66] };    // FRUIT_LARGE, higher amount
for (const pick of [T._pickItemSpatterForTest, G.pickItemSpatterLitter]) {
  assert.equal(pick([fruitLow, fruitHigh], spatterMapReal).isp, fruitHigh, "highest amount wins");
  assert.equal(pick([fruitHigh, fruitLow], spatterMapReal).isp, fruitHigh, "winner is arrival-order independent");
  const tie = { growth_class: 4, item_type: 56, amount: 90, rgb: [1, 2, 3] };
  assert.equal(pick([tie, fruitLow], spatterMapReal).isp, fruitLow, "amount tie -> lower growth_class (stable)");
  const otherBig = { growth_class: 0, item_type: 53, amount: 255 };
  assert.equal(pick([otherBig, fruitLow], spatterMapReal).isp, fruitLow, "undrawable OTHER never wins, whatever its amount");
  assert.equal(pick([otherBig], spatterMapReal), null, "nothing drawable -> no draw at all");
}
// Draw-path proof (GL, real scene builder + real spatter_map.json): the overlap tile must emit
// exactly ONE litter instance, tinted with the winner's species rgb.
const glBox = { console }; glBox.self = glBox;
vm.createContext(glBox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(f, "utf8"), glBox, { filename: f });
}
const GLS = glBox.DwfGL;
const atlasIds = new Map(); let nextAtlasId = 1;
const atlas = { resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!atlasIds.has(k)) atlasIds.set(k, nextAtlasId++); return atlasIds.get(k); } };
const builder = GLS.createSceneBuilder({
  atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: { wallShadow: {}, visionShadow: {}, rampShadowOnRamp: {} },
  adjacency: glBox.DwfAdjacency, spatterMap: spatterMapReal,
});
const baseTile = { tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 };
const view = process.env.TX6_OVERLAP_BROKEN
  ? { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 2,
      tiles: [{ ...baseTile, itemSpatters: [fruitLow] }, { ...baseTile, itemSpatters: [fruitHigh] }] }
  : { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1,
      tiles: [{ ...baseTile, itemSpatters: [fruitLow, fruitHigh] }] };
builder.buildScene(view);
const u16 = new Uint16Array(builder.buffer), u8 = new Uint8Array(builder.buffer);
const litter = [];
for (let k = 0; k < builder.count; k++) {
  const rgb = [u8[k * 16 + 12], u8[k * 16 + 13], u8[k * 16 + 14]];
  const isSpecies = [fruitLow.rgb, fruitHigh.rgb].some((s) => s[0] === rgb[0] && s[1] === rgb[1] && s[2] === rgb[2]);
  if (isSpecies && u16[k * 8 + 4] > 0) litter.push(rgb);
}
assert.equal(litter.length, 1,
  "B138: two overlapping litter records must yield ONE draw (native picks a single spatter per tile)");
assert.deepEqual(litter[0], fruitHigh.rgb, "B138: the single draw carries the WINNER's species rgb");
console.log("PASS TX6-SPECIES-TINT distinct material RGB + legacy fallback + OTHER guard + e2e cache-worker ingest + B138 one-draw overlap");
