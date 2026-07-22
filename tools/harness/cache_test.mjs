// cache_test.mjs -- WA-6 acceptance deliverable (docs/superpowers/specs/
// 2026-07-07-WA-foundation-spec.md, "world cache module + worker ingest"). Replays a
// committed keyframe+deltas fixture through the REAL web/js/dwf-cache-worker.js +
// web/js/dwf-cache.js modules (loaded verbatim, unmodified, via vm.runInThisContext --
// same convention as tools/harness/dropstale_test.mjs) and asserts:
//   - final cache state === serial-apply reference (every raw SoA array byte-equal, verified
//     by independently re-deriving the expected packed bytes from the fixture's own JSON
//     fields and comparing against what ingest() actually wrote)
//   - chunk count / z-level count match the fixture's known chunk-coverage math
//   - memory estimate stays within the default budget
//   - eviction fires on a synthetic over-budget load (WA-6 item 4)
//
// Runs in FALLBACK (synchronous, no dedicated Worker) mode: `globalThis.window` is set before
// loading dwf-cache-worker.js, which is the exact condition that file's dual-mode banner
// documents as "not a dedicated worker" -- so it exposes DwfCacheWorkerCore directly
// instead of wiring self.onmessage, and dwf-cache.js's ensureBackend() picks it up as the
// synchronous core (no Worker global defined in this Node harness, so the real-Worker branch
// never triggers). This exercises the IDENTICAL ingest algorithm a browser's dedicated Worker
// would run -- only the on/off-main-thread hop differs, per dwf-cache.js's own banner.
//
// Run: node tools/harness/cache_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(__dirname, "../../web/js/dwf-cache-worker.js");
const CACHE_PATH = path.resolve(__dirname, "../../web/js/dwf-cache.js");
const WIRE_V1_PATH = path.resolve(__dirname, "../../web/js/dwf-wire-v1.js");
const FIXTURE_PATH = path.resolve(__dirname, "fixtures/cache_fixture.json");
const WIRE_FIX_BIN = path.resolve(__dirname, "fixtures/wire_fixture.bin");

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

// ---- minimal browser-shaped globals (fallback/sync mode -- no Worker global) ------------
globalThis.window = globalThis;
globalThis.document = { getElementsByTagName: () => [] };
// Intentionally NO globalThis.Worker -- forces dwf-cache.js's ensureBackend() to use
// the synchronous DwfCacheWorkerCore fallback, exactly like an old/blocked browser.

// WA-12: the fallback/sync core's ingestBlocks() expects DwfWireV1 as an ambient global
// (the dedicated-worker branch self-loads it via importScripts; this Node harness plays the
// same role wire_decode_test.mjs's own loader does) -- must load BEFORE the worker script.
vm.runInThisContext(fs.readFileSync(WIRE_V1_PATH, "utf8"), { filename: WIRE_V1_PATH });
assert.ok(globalThis.DwfWireV1, "dwf-wire-v1.js did not attach DwfWireV1");

vm.runInThisContext(fs.readFileSync(WORKER_PATH, "utf8"), { filename: WORKER_PATH });
assert.ok(globalThis.DwfCacheWorkerCore, "dwf-cache-worker.js did not expose the fallback core");

vm.runInThisContext(fs.readFileSync(CACHE_PATH, "utf8"), { filename: CACHE_PATH });
const DwfCache = globalThis.DwfCache;
assert.ok(DwfCache, "dwf-cache.js did not install window.DwfCache");
assert.equal(DwfCache._backend(), "sync", "expected the synchronous fallback backend in this harness");

let failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// ---- independent reference packing (mirrors dwf-cache-worker.js's own scheme, but
// reimplemented separately here so a bug in the module can't also hide in the test's oracle) --
const DIG_NAMES = ["No", "Default", "UpDownStair", "Channel", "Ramp", "DownStair", "UpStair"];
function packMat(mt, mi) { return ((mt | 0) << 16) | ((mi | 0) & 0xFFFF); }
function expectedRecord(t) {
  const tt = (typeof t.tt === "number") ? t.tt : -1;
  if (tt < 0) return { tt: 0xFFFF, mat: 0, bits: 0, desig: 0, spatterAmt: 0, flags2: 0, sparse: null };
  const bmt = (typeof t.base_mt === "number") ? t.base_mt : -1;
  const bmi = (typeof t.base_mi === "number") ? t.base_mi : -1;
  const liquidCode = t.liquid === "magma" ? 2 : (t.liquid === "water" ? 1 : 0);
  const flow = (typeof t.flow === "number") ? (t.flow & 7) : 0;
  const hidden = t.hidden ? 1 : 0;
  const outside = t.outside ? 1 : 0;
  const bits = (liquidCode & 3) | (flow << 2) | (hidden << 5) | (outside << 6);
  let desig1 = 0, desig2 = 0;
  if (t.desig) {
    const digVal = DIG_NAMES.indexOf(t.desig.dig); const dv = digVal < 0 ? 0 : digVal;
    desig1 = (dv & 0xF) | (((t.desig.smooth | 0) & 3) << 4) |
      (((t.desig.marker ? 1 : 0) & 1) << 6) | (((t.desig.automine ? 1 : 0) & 1) << 7);
    desig2 = ((t.desig.traffic | 0) & 3) | (((t.desig.track | 0) & 0xF) << 2);
  }
  let flags2 = 0, spatterAmt = 0;
  const sparse = {};
  if (t.item) { sparse.item = t.item; flags2 |= 1; }
  if (t.plant) { sparse.plant = t.plant; flags2 |= 2; }
  if (t.spatter) { sparse.spatterMat = t.spatter; flags2 |= 4; spatterAmt = Math.max(0, Math.min(255, t.spatter.amount | 0)); }
  return {
    tt, mat: packMat(bmt, bmi), bits,
    desig: (desig1 & 0xFF) | ((desig2 & 0xFF) << 8),
    spatterAmt, flags2,
    sparse: Object.keys(sparse).length ? sparse : null,
  };
}
function chunkKeyFor(x, y) { return (x >> 4) * 4096 + (y >> 4); }
function idxFor(x, y) { return (y & 15) * 16 + (x & 15); }

// ---- replay the fixture -------------------------------------------------------------------
console.log("TEST 1: keyframe + 3 deltas ingest, byte-exact SoA verification");
DwfCache.ingest(fixture.keyframe);
for (const d of fixture.deltas) DwfCache.ingest(d);

// Build the "serial apply" reference: last-write-wins per (x,y,z) across keyframe+deltas, in
// arrival order -- exactly what a naive full replay would produce, and exactly what the
// chunked cache should also converge to (world-addressed, order-independent per tile).
const ref = new Map(); // "x,y,z" -> tile
function applyRef(msg) {
  const z = typeof msg.z === "number" ? msg.z : msg.origin.z;
  for (const t of msg.tiles) ref.set(`${t.x},${t.y},${z}`, t);
}
applyRef(fixture.keyframe);
for (const d of fixture.deltas) applyRef(d);

let allMatch = true;
for (const [k, t] of ref) {
  const [x, y, z] = k.split(",").map(Number);
  const chunk = DwfCache.getChunk(z, chunkKeyFor(x, y));
  if (!chunk) { allMatch = false; console.log(`  missing chunk for ${k}`); continue; }
  const idx = idxFor(x, y);
  const exp = expectedRecord(t);
  const gotSparse = chunk.sparse.get(idx) || null;
  const same =
    chunk.tt[idx] === exp.tt &&
    chunk.mat[idx] === exp.mat &&
    chunk.bits[idx] === exp.bits &&
    chunk.desig[idx] === exp.desig &&
    chunk.spatterAmt[idx] === exp.spatterAmt &&
    chunk.flags2[idx] === exp.flags2 &&
    JSON.stringify(gotSparse) === JSON.stringify(exp.sparse);
  if (!same) {
    allMatch = false;
    console.log(`  mismatch at ${k}:`, { got: { tt: chunk.tt[idx], mat: chunk.mat[idx], bits: chunk.bits[idx], desig: chunk.desig[idx], spatterAmt: chunk.spatterAmt[idx], flags2: chunk.flags2[idx], sparse: gotSparse }, exp });
  }
}
check("every ingested tile's SoA record byte-matches the serial-apply reference", allMatch);
check(`reference covers ${ref.size} distinct world tiles (sanity)`, ref.size === 13);

const s1 = DwfCache.stats();
console.log(`  stats: ${JSON.stringify(s1)}`);
check("exactly 2 chunks touched (keyframe's chunk + the delta's new x=50 chunk)", s1.chunks === 2);
check("exactly 1 z-level touched", s1.zLevels === 1);
check("memory estimate within the default 128MB budget", s1.bytes > 0 && s1.bytes < 128 * 1024 * 1024);
check("no evictions yet at default budget", s1.evictions === 0);

console.log("TEST 2: void tile (tt:-1) reads back as an all-zero record with no sparse, and a later overwrite clears it");
{
  // (43,60) is void in the keyframe, then overwritten to a real Floor tile by delta #2 -- both
  // states are exercised: ingest a fresh void tile at an unused coordinate to check the
  // all-zero shape, then confirm the fixture's own void->real transition landed correctly.
  DwfCache.ingest({
    origin: { x: 200, y: 200, z: 30 }, width: 1, height: 1, z: 30,
    tiles: [{ x: 200, y: 200, tt: -1 }],
  });
  const chunk = DwfCache.getChunk(30, chunkKeyFor(200, 200));
  const idx = idxFor(200, 200);
  check("void tile tt === 0xFFFF", chunk.tt[idx] === 0xFFFF);
  check("void tile mat/bits/desig/spatterAmt/flags2 all zero", chunk.mat[idx] === 0 && chunk.bits[idx] === 0 && chunk.desig[idx] === 0 && chunk.spatterAmt[idx] === 0 && chunk.flags2[idx] === 0);
  check("void tile has no sparse entry", !chunk.sparse.has(idx));
}
{
  const chunk = DwfCache.getChunk(10, chunkKeyFor(43, 60));
  const idx = idxFor(43, 60);
  check("(43,60) was overwritten by the later delta to a real Floor tile (tt=2, not void)", chunk.tt[idx] === 2);
}

console.log("TEST 3: onDirty fires with the correct z/keys on ingest");
{
  let fired = null;
  const unsub = DwfCache.onDirty((z, keys, stats) => { fired = { z, keys, stats }; });
  DwfCache.ingest({
    origin: { x: 100, y: 100, z: 20 }, width: 2, height: 2, z: 20,
    tiles: [{ x: 100, y: 100, tt: 2, base_mt: 1, base_mi: 1, flow: 0, liquid: "none", hidden: 0, outside: 0 }],
  });
  check("onDirty fired", !!fired);
  check("onDirty reported z=20", fired && fired.z === 20);
  check("onDirty reported the touched chunk key", fired && fired.keys.length === 1 && fired.keys[0] === chunkKeyFor(100, 100));
  unsub();
}

console.log("TEST 4: eviction fires on a synthetic over-budget load (item 4)");
{
  const before = DwfCache.stats();
  check("more than one chunk present before the budget squeeze", before.chunks > 1);
  // Force a budget far below the current footprint -- every ingest touches maybeEvict(), so
  // the NEXT ingest call (a tiny no-op-ish touch) must trigger eviction down toward the cap.
  DwfCache._setBudgetForTest(1024); // 1 KB -- smaller than a single chunk (~4.7 KB)
  const after = DwfCache.stats();
  check("eviction counter advanced", after.evictions > before.evictions);
  check("chunk count dropped toward the tiny budget", after.chunks < before.chunks);
}

console.log("TEST 5 (WA-7): windowView() matches the legacy serial-applied buffer tile-for-tile, wallnbr included");
{
  DwfCache._resetForTest();
  DwfCache._setBudgetForTest(128 * 1024 * 1024); // TEST 4 squeezed this down to 1KB
  DwfCache.setTiletypeMeta(fixture.tiletypeMeta);
  DwfCache.ingest(fixture.keyframe);
  for (const d of fixture.deltas) DwfCache.ingest(d);

  const ox = fixture.keyframe.origin.x, oy = fixture.keyframe.origin.y, z = fixture.keyframe.origin.z;
  const w = fixture.keyframe.width, h = fixture.keyframe.height;

  // Build the "legacy serial-applied tileBuf" reference EXACTLY like dwf-tiles.js's
  // applyKeyframe+applyTilesInto: pre-fill every cell with a void placeholder (a real
  // keyframe always emits {x,y,tt:-1} for a null/off-map tile, ground truth §1.3 lines
  // 213-219 -- this fixture's keyframe is deliberately sparse for brevity, so the holes are
  // filled in here to match what a REAL keyframe would have sent), then overlay the
  // fixture's own tiles (keyframe first, then each delta in arrival order) by world coord.
  const refBuf = new Array(w * h);
  for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) refBuf[gy * w + gx] = { x: ox + gx, y: oy + gy, tt: -1 };
  function overlay(tiles) {
    for (const t of tiles) {
      const gx = t.x - ox, gy = t.y - oy;
      if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue; // outside this window (e.g. x=50)
      refBuf[gy * w + gx] = t;
    }
  }
  overlay(fixture.keyframe.tiles);
  for (const d of fixture.deltas) overlay(d.tiles);

  // Normalize a fixture-authored tile into the SAME shape windowView() produces: strings
  // resolved via tiletypeMeta (not the fixture's own embedded strings -- those are discarded
  // by ingest, exactly like the real cache discards them), and wallnbr synthesized fresh
  // against the reference buffer itself (the reference's own "cache", so to speak).
  const metaByTt = new Map(fixture.tiletypeMeta.map((r) => [r[0], { ttname: r[1], shape: r[2], mat: r[3], special: r[4] }]));
  function refShapeAt(x, y) {
    const gx = x - ox, gy = y - oy;
    if (gx < 0 || gy < 0 || gx >= w || gy >= h) return null; // unknown to the reference too
    const t = refBuf[gy * w + gx];
    if (!t || t.tt < 0) return null;
    const meta = metaByTt.get(t.tt);
    return meta ? meta.shape : null;
  }
  function computeExpectedWallNbr(x, y) {
    let m = 0;
    if (refShapeAt(x, y - 1) === "WALL") m |= 1; // N
    if (refShapeAt(x, y + 1) === "WALL") m |= 2; // S
    if (refShapeAt(x + 1, y) === "WALL") m |= 4; // E
    if (refShapeAt(x - 1, y) === "WALL") m |= 8; // W
    return m;
  }
  function normalizeExpected(t) {
    if (t.tt < 0) return { x: t.x, y: t.y, tt: -1 };
    const meta = metaByTt.get(t.tt) || {};
    const out = {
      x: t.x, y: t.y, tt: t.tt,
      ttname: meta.ttname || "", shape: meta.shape || "", mat: meta.mat || "", special: meta.special || "",
      flow: t.flow || 0, liquid: t.liquid || "none", hidden: t.hidden ? 1 : 0, outside: t.outside ? 1 : 0,
      base_mt: typeof t.base_mt === "number" ? t.base_mt : -1, base_mi: typeof t.base_mi === "number" ? t.base_mi : -1,
    };
    if (t.desig) {
      const active = t.desig.dig !== "No" || (t.desig.smooth | 0) > 0 || (t.desig.traffic | 0) !== 0 || (t.desig.track | 0) !== 0;
      if (active) out.desig = { dig: t.desig.dig, smooth: t.desig.smooth | 0, traffic: t.desig.traffic | 0, track: t.desig.track | 0, marker: t.desig.marker ? 1 : 0, automine: t.desig.automine ? 1 : 0 };
    }
    if (t.item) out.item = t.item;
    if (t.plant) out.plant = t.plant;
    // WC-12 (additive): dwf-cache.js's decodeTile() now ALSO normalizes the legacy
    // JSON's first-event-only `spatter` into a 1-element `spatters` array (the uniform
    // shape the WC-12 layered-decal client apply reads, regardless of ingest path) -- mirror
    // that here so this reference stays in lockstep with the real decoder.
    if (t.spatter) { out.spatter = t.spatter; out.spatters = [t.spatter]; }
    if (out.shape === "WALL") out.wallnbr = computeExpectedWallNbr(t.x, t.y);
    return out;
  }

  const got = DwfCache.windowView(ox, oy, z, w, h);
  check("windowView returns the right envelope shape",
    got.origin.x === ox && got.origin.y === oy && got.origin.z === z &&
    got.width === w && got.height === h && got.tiles.length === w * h);

  let mismatches = 0;
  for (let i = 0; i < w * h; i++) {
    const exp = normalizeExpected(refBuf[i]);
    const gotTile = got.tiles[i];
    try {
      assert.deepStrictEqual(gotTile, exp);
    } catch (e) {
      mismatches++;
      console.log(`  mismatch at index ${i} (${exp.x},${exp.y}):`, { got: gotTile, exp });
    }
  }
  check("windowView tile-for-tile deep-equal to the legacy serial-applied reference (wallnbr included)", mismatches === 0);
  // Sanity: this fixture's wall layout (a corner at 42,60/42,61/41,61) must actually produce
  // NON-zero wallnbr somewhere, or the deep-equal above would trivially pass with a broken
  // synthesizer that always returns 0.
  const gxW = 42 - ox, gyW = 61 - oy;
  const gotWallNbr = got.tiles[gyW * w + gxW].wallnbr;
  check("the (42,61) wall corner has a non-zero synthesized wallnbr (N+W)", gotWallNbr === (1 | 8));
}

console.log("TEST 6 (WA-7): client-side see-down composite + wallnbr-at-descended-z (baked===false path)");
{
  DwfCache._resetForTest();
  DwfCache._setBudgetForTest(128 * 1024 * 1024);
  DwfCache.setTiletypeMeta([
    [0, "OpenSpace", "EMPTY", "AIR", "NONE"],
    [2, "Floor", "FLOOR", "STONE", "NONE"],
    [1, "Wall", "WALL", "STONE", "NONE"],
  ]);
  // z=5: an open/AIR camera-plane tile at (0,0); (1,0) is a WALL directly at the camera plane
  // (no descent). z=4: directly below (0,0) is a solid WALL -- deliberately a WALL, not a
  // floor, so the descended substitute ALSO exercises wallnbr synthesis (item 2: "wallnbr is
  // computed at the DESCENDED tile's z"); (1,0) has nothing ingested at z=4 (off-map/unknown).
  DwfCache.ingest({
    origin: { x: 0, y: 0, z: 5 }, width: 2, height: 1, z: 5,
    tiles: [
      { x: 0, y: 0, tt: 0, flow: 0, liquid: "none", hidden: 0, outside: 0, base_mt: -1, base_mi: -1 },
      { x: 1, y: 0, tt: 1, flow: 0, liquid: "none", hidden: 0, outside: 0, base_mt: 3, base_mi: 3 },
    ],
  });
  DwfCache.ingest({
    origin: { x: 0, y: 0, z: 4 }, width: 2, height: 1, z: 4,
    tiles: [
      { x: 0, y: 0, tt: 1, flow: 0, liquid: "none", hidden: 0, outside: 0, base_mt: 9, base_mi: 9,
        item: { type: "ANVIL", mat_type: 34, mat_index: 5678, subtype: -1, iflags: 0 } },
    ],
  });
  // Mark the z=5 chunk raw (not legacy-baked) -- this is what WA-12's v1 ingest will set;
  // synthetically flipping it here is the only way to exercise this dormant branch before
  // that lands (legacy ingest always sets baked=true).
  const chunk5 = DwfCache.getChunk(5, chunkKeyFor(0, 0));
  chunk5.baked = false;

  const view = DwfCache.windowView(0, 0, 5, 2, 1);
  const camTile = view.tiles[0];
  check("open camera tile descended to the z=4 solid Wall (tt=1 substituted)", camTile.tt === 1);
  check("descended tile's base material came from z=4, not z=5", camTile.base_mt === 9 && camTile.base_mi === 9);
  check("descended tile's sparse item tail came from z=4, not the open camera tile",
    camTile.item && camTile.item.type === "ANVIL" && camTile.item.mat_index === 5678);
  check("descended WALL tile's wallnbr is computed AT THE DESCENDED z (z=4's (1,0) was never ingested -> unknown -> 0)", camTile.wallnbr === 0);
  // The (1,0) camera-plane tile is itself a WALL directly at z=5 (no descent -- not open/AIR),
  // so its wallnbr is synthesized using RAW z=5 neighbor lookups (matching the server's own
  // tile_is_wall(x,y,fpos.z), which never re-runs descent on a neighbor either): the W
  // neighbor (0,0) is checked as its RAW z=5 record (OpenSpace/EMPTY), not (0,0)'s own
  // independently-descended composite -- so bit W stays 0. This is the one place the client
  // cache's raw-per-z storage (post-WA-12) can be MORE server-faithful than the legacy baked
  // path, where only one composited record exists per (x,y,z) at all.
  const wallTile = view.tiles[1];
  check("the non-descended camera-plane WALL tile is untouched (tt=1, no descent)", wallTile.tt === 1 && wallTile.hidden === 0);
  check("its wallnbr uses the RAW z=5 neighbor record, not the neighbor's own descended composite", wallTile.wallnbr === 0);
}

console.log("TEST 7 (WA-12): ingestBlocks() decodes a real protocol-v1 BLOCK_SET frame (the WA-8 golden fixture) into the SoA cache, byte-exact, idempotent, with resolved item/plant sparse detail");
{
  DwfCache._resetForTest();
  DwfCache._setBudgetForTest(128 * 1024 * 1024);
  DwfCache.setItemTypeMeta([[12, "ANVIL"], [1, "BOULDER"]]); // 34/-1/2 deliberately left unmapped -> numeric-string fallback

  const wireBin = new Uint8Array(fs.readFileSync(WIRE_FIX_BIN));
  const W = globalThis.DwfWireV1;
  const hdr = W.decodeHeader(wireBin);
  assert.ok(hdr && !hdr.deflated, "golden wire fixture must decode uncompressed");
  const payload = wireBin.subarray(hdr.payloadOffset);

  const packBits = (liq, flow, hid, out) => (liq & 3) | ((flow & 7) << 2) | ((hid & 1) << 5) | ((out & 1) << 6);
  const packDesig = (dig, smooth, marker, traffic, track) =>
    ((dig & 0xF) | ((smooth & 3) << 4) | ((marker & 1) << 6)) | ((((traffic & 3) | ((track & 0xF) << 2)) & 0xFF) << 8);

  const blockAKey = 1 * 4096 + 2, blockBKey = 300 * 4096 + 50, blockCKey = 500 * 4096 + 60;
  const dirty1 = DwfCache.ingestBlocks(payload.slice());
  check("ingestBlocks() (first application) reports 3 dirty z-groups (bz=3, bz=7, bz=9)", dirty1 && dirty1.byZ.length === 3);

  const chunkA = DwfCache.getChunk(3, blockAKey);
  const chunkB = DwfCache.getChunk(7, blockBKey);
  check("block A landed at (bz=3, key=1*4096+2)", !!chunkA);
  check("block B landed at (bz=7, key=300*4096+50)", !!chunkB);
  // ITEM 1 (cachefix): Block C is the 260-tail grass-dense block; its 4 ITEM tails sit at
  // tile_idx 250-253 (tail positions 256-259, PAST the old u8 255 cap). With the u16 tail_count
  // they now ride the wire AND land in sparse -- the invisible items, cured end-to-end.
  const chunkC = DwfCache.getChunk(9, blockCKey);
  check("block C (260-tail grass-dense) landed at (bz=9, key=500*4096+60)", !!chunkC);
  let allCItems = !!chunkC;
  for (let k = 0; k < 4 && chunkC; k++) {
    const sp = chunkC.sparse.get(250 + k);
    if (!sp || !sp.item || sp.item.mat_index !== 700 + k) { allCItems = false; break; }
  }
  check("all 4 high-tile_idx ITEM tails (250-253) survive the u16 tail_count and reach sparse (invisible-item cluster CURED)", allCItems);
  check("block A chunk.ver === wire ver (100)", chunkA.ver === 100);
  check("block B chunk.ver === wire ver (200)", chunkB.ver === 200);
  check("v1 ingest marks chunks raw (baked=false) -- activates WA-7's client-side see-down", chunkA.baked === false && chunkB.baked === false);
  check("cache worldSeq tracks the frame's world_seq (42)", DwfCache.stats().worldSeq === 42);

  check("A[0] void tile", chunkA.tt[0] === 0xffff && chunkA.mat[0] === 0 && chunkA.bits[0] === 0 && chunkA.desig[0] === 0);
  check("A[1] water(7)/outside record", chunkA.tt[1] === 100 && chunkA.mat[1] === ((5 << 16) | (6 & 0xFFFF)) && chunkA.bits[1] === packBits(1, 7, 0, 1));
  check("A[2] magma(3) record", chunkA.tt[2] === 101 && chunkA.bits[2] === packBits(2, 3, 0, 0));
  check("A[3] hidden record", chunkA.tt[3] === 102 && chunkA.bits[3] === packBits(0, 0, 1, 0));
  check("A[4] desig bits (dig=6 stairs, smooth=2, marker=1, traffic=3, track=15)", chunkA.desig[4] === packDesig(6, 2, 1, 3, 15));
  check("A[8] spatter_amt clamped record field === 255 (tile record, independent of the tail's unclamped amount)", chunkA.spatterAmt[8] === 255);

  const a5 = chunkA.sparse.get(5), a6 = chunkA.sparse.get(6), a7 = chunkA.sparse.get(7), a8 = chunkA.sparse.get(8);
  check("A[5] item tail resolved via item_type_meta (12 -> ANVIL)", !!a5 && a5.item && a5.item.type === "ANVIL" && a5.item.mat_type === 34 && a5.item.mat_index === 5678);
  check("A[6] plant tail (part 0 -> TRUNK, id OAK)", !!a6 && a6.plant && a6.plant.part === "TRUNK" && a6.plant.id === "OAK");
  check("A[7] spatterMat tail (unclamped amount 5000, distinct from the record's clamped spatterAmt)", !!a7 && a7.spatterMat && a7.spatterMat.amount === 5000 && a7.spatterMat.mat_type === 9);
  check("A[8] merges THREE tails (item+plant+spatterMat) into one sparse entry", !!a8 && a8.item && a8.plant && a8.spatterMat);
  check("A[8] item tail with an UNMAPPED type (1 -> BOULDER, mapped) vs plant part 5 -> SHRUB with empty id", a8.item.type === "BOULDER" && a8.plant.part === "SHRUB" && a8.plant.id === "");

  // WC-3/WC-11/WC-15 (extending this fixture per the spec's own instruction: "the WA-12
  // cache_test must still pass after your ingest changes -- extend its fixtures for new
  // tails"): the golden wire fixture (WC-11/WC-15's own extension, commit 6ef602a) already
  // carries subtype/iflags/stack on A[5]'s ITEM tail, a layered 2-event SPATTER at A[11], two
  // ITEM_SPATTER (leaves/fruit litter) entries at A[9], and a FLOW (mist) entry at A[10] --
  // this only ADDS assertions for what ingestBlocks() now surfaces from them (no fixture
  // bytes changed).
  check("A[5] item tail also carries WC-1 subtype/iflags/stack", a5.item.subtype === 42 && a5.item.iflags === 0x15 && a5.item.stack === 5);
  check("A[8] item tail subtype sentinel (-1) + stack clamp (999 -> 255) survive ingest", a8.item.subtype === -1 && a8.item.stack === 255);
  const a9 = chunkA.sparse.get(9), a10 = chunkA.sparse.get(10), a11 = chunkA.sparse.get(11);
  check("A[9] TWO ITEM_SPATTER entries accumulate into an array (LEAVES then FRUIT_LARGE)",
    !!a9 && Array.isArray(a9.itemSpatters) && a9.itemSpatters.length === 2 &&
    a9.itemSpatters[0].growth_class === 1 && a9.itemSpatters[0].amount === 60 &&
    a9.itemSpatters[1].growth_class === 4 && a9.itemSpatters[1].amount === 12);
  check("A[10] FLOW tail (Mist, density 180) resolves via the single-valued tailToSparseField path",
    !!a10 && a10.flow && a10.flow.type === 2 && a10.flow.density === 180);
  check("A[11] TWO layered SPATTER_MAT tails accumulate into `spatters` (Solid then Paste), `spatterMat` = the first",
    !!a11 && Array.isArray(a11.spatters) && a11.spatters.length === 2 &&
    a11.spatters[0].mat_type === 30 && a11.spatters[0].state === 0 &&
    a11.spatters[1].mat_type === 40 && a11.spatters[1].state === 4 &&
    a11.spatterMat === a11.spatters[0]);
  check("A[7]/A[8] single-event spatters ALSO got a `spatters` array of length 1 (uniform shape for the client apply)",
    Array.isArray(a7.spatters) && a7.spatters.length === 1 && a7.spatters[0].state === 1 &&
    Array.isArray(a8.spatters) && a8.spatters.length === 1 && a8.spatters[0].state === -1);

  // WC-19/WC-21/blood-family (this session): assert ingestBlocks() now SURFACES the tails the
  // wire decoder already decoded (previously skipped as unknown/multi-valued). No fixture bytes
  // changed -- these ride the same golden wire_fixture.bin wire_decode_test already validates.
  check("A[11] SPATTER blood-family rgb extension: first (Solid) event has NO rgb, second (Paste) carries resolved [180,20,20]",
    a11.spatters[0].rgb === undefined && Array.isArray(a11.spatters[1].rgb) &&
    a11.spatters[1].rgb[0] === 180 && a11.spatters[1].rgb[1] === 20 && a11.spatters[1].rgb[2] === 20);
  const a14 = chunkA.sparse.get(14), a15 = chunkA.sparse.get(15);
  check("A[14] DESIG_PRIORITY tail ingested into sp.desigPriority (priority 5)",
    !!a14 && a14.desigPriority && a14.desigPriority.priority === 5);
  check("A[15] TWO VERMIN tails accumulate into sp.vermin (lone bug race 200, then colony race 210)",
    !!a15 && Array.isArray(a15.vermin) && a15.vermin.length === 2 &&
    a15.vermin[0].race === 200 && a15.vermin[0].vflags === 0 &&
    a15.vermin[1].race === 210 && (a15.vermin[1].vflags & 0x01) === 0x01);

  check("B[0]/B[255] void edge tiles", chunkB.tt[0] === 0xffff && chunkB.tt[255] === 0xffff);
  check("B[10] item tail with an item_type not in the meta table falls back to its numeric string", chunkB.sparse.get(10) && chunkB.sparse.get(10).item.type === "-1");
  check("B[128] magma/hidden/outside record", chunkB.tt[128] === 200 && chunkB.bits[128] === packBits(2, 7, 1, 1) && chunkB.mat[128] === ((100 << 16) | (200 & 0xFFFF)));

  console.log("TEST 7b: idempotent re-application (§0.6) -- a resend at the SAME ver is a silent no-op");
  const dirty2 = DwfCache.ingestBlocks(payload.slice());
  check("re-ingesting the identical frame reports ZERO dirty groups (ver not strictly newer)", dirty2 && dirty2.byZ.length === 0);
  check("chunk state unchanged after the idempotent resend", chunkA.ver === 100 && chunkB.ver === 200 && chunkA.tt[1] === 100);
}

// TEST 8 (cachefix FIX, 2026-07-09): tail_count u8->u16 KILLS the invisible-item cluster.
// The owner reported dozens of items invisible in BOTH renderers in the sprite-range world. Root cause
// (proven by a live WS capture + replay): the wire ENCODER clamped `tail_count` to a u8, so a
// grass-dense block (up to 256 GRASS tails, one per grassed floor) plus its ITEM tails exceeded
// 255 and every tail past the 255th was truncated SERVER-SIDE -- high-tile_idx ITEM tails simply
// never left the server, so no client fix could recover them. The fix widened tail_count to u16
// in src/wire_v1.cpp::assemble_block_set + web/js/dwf-wire-v1.js (golden CRC re-goldened).
//
// This test builds a grass-dense block the way the live encoder now does -- 256 GRASS tails +
// ITEM tails at HIGH tile_idx (250-255), 262 tails total -- through the SAME decoder+ingest path
// the client uses, and asserts every high-idx item now lands in sparse. test-the-test: re-encode
// the SAME logical block with the OLD u8 clamp (only the first 255 tails) and show the high-idx
// items vanish -- proving the assertion depends on the widened count, not on ingest behaviour.
console.log("TEST 8 (cachefix FIX): u16 tail_count carries a 262-tail grass-dense block so every high-tile_idx ITEM tail reaches sparse; a u8-clamped re-encode drops them (invisible-item cluster cured)");
{
  DwfCache._resetForTest();
  DwfCache._setBudgetForTest(128 * 1024 * 1024);
  DwfCache.setItemTypeMeta([[5, "AMULET"]]);
  DwfCache.setTiletypeMeta([[43, "StoneFloorSmooth", "FLOOR", "STONE", "SMOOTH"]]);

  // Build a BLOCK_SET PAYLOAD (header already stripped). Byte layout mirrors
  // dwf-wire-v1.js's decodeBlockSet (§0.3): world_seq u32, block_count u16, then per block
  // bx u16 | by u16 | bz u16 | ver u32 | bflags u8 | tail_count u16 LE | 256x12B tile records |
  // tails (tile_idx u8 | kind u8 | len u8 | data[len]). GRASS data (0x06) = idlen u8 | id bytes |
  // amount u8; ITEM data (0x01) = item_type i16 | mat_type i16 | mat_index i32.
  // `tailClamp` lets the same builder emit either the widened count (all tails) or the OLD u8
  // clamp (min(n,255) tails) so the test-the-test can contrast them.
  const buildPayload = (ver, tailClamp) => {
    const buf = [];
    const u8 = (v) => buf.push(v & 0xFF);
    const u16 = (v) => { buf.push(v & 0xFF); buf.push((v >> 8) & 0xFF); };
    const u32 = (v) => { u16(v & 0xFFFF); u16((v >>> 16) & 0xFFFF); };
    // tail list: 256 GRASS (tile 0..255) then 6 ITEM tails at tile 250..255 = 262 tails.
    const tails = [];
    for (let i = 0; i < 256; i++) tails.push({ kind: 0x06, tile: i, grass: true });
    for (let k = 0; k < 6; k++) tails.push({ kind: 0x01, tile: 250 + k, mat: 700 + k });
    const emitted = tailClamp ? tails.slice(0, Math.min(tails.length, 255)) : tails;
    u32(7);           // world_seq
    u16(1);           // block_count
    u16(0); u16(0); u16(62);  // bx, by, bz
    u32(ver);         // ver
    u8(0);            // bflags
    u16(emitted.length);      // tail_count -- u16 LE (widened). Under the OLD u8 clamp `emitted`
                              //   is pre-truncated to 255 so the same u16 field carries 255.
    for (let i = 0; i < 256; i++) { u16(43); u16(0); u16(0); u8(0); u8(0); u8(0); u8(0); u16(0); }
    for (const t of emitted) {
      if (t.grass) { u8(t.tile); u8(0x06); u8(3); u8(1); u8(0x47 /*'G'*/); u8(50); }        // len=3
      else { u8(t.tile); u8(0x01); u8(8); u16(5); u16(0); u32(t.mat); }                     // len=8
    }
    return new Uint8Array(buf);
  };

  // (1) The FIX: widened u16 count carries all 262 tails.
  const res8 = DwfCache.ingestBlocks(buildPayload(1, false));
  check("262-tail grass-dense BLOCK_SET ingested (1 dirty z-group at bz=62)", res8 && res8.byZ.length === 1 && res8.byZ[0].z === 62);
  const chunk8 = DwfCache.getChunk(62, 0 * 4096 + 0);
  let allItems = !!chunk8, firstBad = -1;
  for (let k = 0; k < 6 && chunk8; k++) {
    const sp = chunk8.sparse.get(250 + k);
    if (!sp || !sp.item || sp.item.type !== "AMULET" || sp.item.mat_index !== 700 + k) { allItems = false; firstBad = 250 + k; break; }
  }
  check("all 6 high-tile_idx ITEM tails (250-255, positions 256-261) reach sparse under u16 tail_count" + (firstBad >= 0 ? ` [first miss tile ${firstBad}]` : ""), allItems);
  const vEnd = DwfCache.windowView(15, 15, 62, 1, 1).tiles[0];   // tile idx 255 = the worst case
  check("windowView (the exact read the renderers consume) surfaces the item at tile (15,15)=idx255", !!(vEnd && vEnd.item && vEnd.item.type === "AMULET"));

  // (2) TEST-THE-TEST: re-encode the SAME block with the OLD u8 clamp (only the first 255 tails,
  // i.e. the 256 grass minus one -- all 6 items truncated). Fresh cache so the result is purely
  // "what the clamped wire carries", independent of any replace/merge-on-newer-ver semantics.
  DwfCache._resetForTest();
  DwfCache._setBudgetForTest(128 * 1024 * 1024);
  DwfCache.setItemTypeMeta([[5, "AMULET"]]);
  DwfCache.setTiletypeMeta([[43, "StoneFloorSmooth", "FLOOR", "STONE", "SMOOTH"]]);
  DwfCache.ingestBlocks(buildPayload(1, true));
  const chunk8b = DwfCache.getChunk(62, 0 * 4096 + 0);
  let anyItemUnderClamp = false;
  for (let k = 0; k < 6 && chunk8b; k++) {
    const sp = chunk8b.sparse.get(250 + k);
    if (sp && sp.item) { anyItemUnderClamp = true; break; }
  }
  check("TEST-THE-TEST: under a u8 (255) clamp every high-tile_idx item is truncated off the wire -> NONE reach sparse (the exact invisible-item symptom the u16 widen fixes)", !anyItemUnderClamp);
}

console.log("TEST 9 (P1 + WT25 Phase 2): REQ_BLOCKS fire ONLY for known-but-evicted holes (positive discovered-evidence), are suppressed for never-known base-hatch/off-map void, dedupe in flight, back off on silence, and stay idle when resident");
{
  const realNow = Date.now;
  let now = 10000;
  const sent = [];
  Date.now = () => now;
  globalThis.DwfWS = { send(msg) { sent.push(msg); return true; } };
  const residentTilesAt = (bx, by, z) => {
    // 4 real tiles inside block (bx,by,z) so one legacy ingest marks that block key KNOWN.
    const t = [];
    for (let i = 0; i < 4; i++) t.push({ x: bx * 16 + (i % 2), y: by * 16 + Math.floor(i / 2), z,
      tt: 2, base_mt: 1, base_mi: 1, flow: 0, liquid: "none", hidden: 0, outside: 0 });
    return { origin: { x: bx * 16, y: by * 16, z }, width: 2, height: 2, z, tiles: t };
  };
  try {
    // WT25 Phase 2 (the "power trap" fix): a never-received block is undiscovered rock the server
    // will never ship, so a void window over it must emit ZERO REQ_BLOCKS -- the renderers paint
    // it as the base-hatch. This is the load-bearing suppression, not polish.
    DwfCache._resetForTest();
    const baseHatch = DwfCache.windowView(0, 0, 20, 2, 2);
    check("WT25: a NEVER-KNOWN in-bounds void window (undiscovered rock) emits NO reqblocks (base-hatch, not a hole)",
      baseHatch.tiles.every((t) => t.tt === -1) && sent.length === 0);

    // ...but a block the client HELD then EVICTED (positive discovered-evidence: it stays in
    // knownKeysByZ) is a genuine cache hole -> B133/P1 gap-fill must still refill it. Make (0,0,20)
    // known by ingesting it, then squeeze the budget so it evicts (getChunk null, still known).
    DwfCache.ingest(residentTilesAt(0, 0, 20));
    DwfCache._setBudgetForTest(1024); // < one chunk (~4.7 KB) -> evicts the sole block
    // getChunk (never fires a request) proves eviction without polluting the in-flight state the
    // measured windowView() below depends on.
    check("setup: the ingested block is now KNOWN-BUT-EVICTED (chunk gone from the store)",
      !DwfCache.getChunk(20, 0));
    sent.length = 0;
    const hole = DwfCache.windowView(0, 0, 20, 2, 2);
    check("gap detected: a KNOWN-but-evicted void window emits one batched reqblocks message",
      hole.tiles.every((t) => t.tt === -1) && sent.length === 1 && sent[0].type === "reqblocks");
    check("gap request targets ONLY the known-but-evicted block/z (undiscovered lower z-levels are suppressed)",
      sent.length === 1 && sent[0].blocks.length === 1 && sent[0].blocks[0][0] === 0 && sent[0].blocks[0][1] === 0 && sent[0].blocks[0][2] === 20);
    DwfCache.windowView(0, 0, 20, 2, 2);
    check("in-flight dedupe: the same gap emits no second request", sent.length === 1);

    now += 1001;
    DwfCache.windowView(0, 0, 20, 2, 2);
    check("non-answer enters backoff instead of immediately retrying", sent.length === 1);
    now += 499;
    DwfCache.windowView(0, 0, 20, 2, 2);
    check("backoff holds until its deadline", sent.length === 1);
    now += 1;
    DwfCache.windowView(0, 0, 20, 2, 2);
    check("backoff expiry retries one batched request", sent.length === 2 && sent[1].blocks.length === 1);

    DwfCache._resetForTest();
    DwfCache._setBudgetForTest(128 * 1024 * 1024); // undo the 1KB squeeze above
    sent.length = 0;
    DwfCache.ingest(residentTilesAt(0, 0, 20));
    const resident = DwfCache.windowView(0, 0, 20, 2, 2);
    check("idle guard: a fully resident window emits zero reqblocks messages", resident.tiles.every((t) => t.tt === 2) && sent.length === 0);

    // B211 (2026-07-14): the R3 overview read seam (cachedBlocks/readTile/overviewVersion) is
    // DELETED along with the world-map zoom stage it existed to feed. windowView() is the only
    // read path again.
    check("the overview read seam is gone -- windowView is the cache's only read path",
      typeof DwfCache.cachedBlocks === "undefined" &&
      typeof DwfCache.readTile === "undefined" &&
      typeof DwfCache.overviewVersion === "undefined");

    // Born-red/test-the-test for G4's seeded-eviction case: with the P1 sender disabled, even a
    // KNOWN-but-evicted hole leaves no request -- proving the send path (not just the suppression)
    // is what emits it. Re-ingest+evict to recreate the known-but-evicted state after the reset.
    DwfCache._resetForTest();
    DwfCache.ingest(residentTilesAt(0, 0, 20));
    DwfCache._setBudgetForTest(1024);
    DwfCache._setReqBlocksEnabledForTest(false);
    sent.length = 0;
    const seededBad = DwfCache.windowView(0, 0, 20, 2, 2);
    check("TEST-THE-TEST (seeded-bad): disabled P1 sender leaves known-but-evicted void tiles and emits no request",
      seededBad.tiles.some((t) => t.tt === -1) && sent.length === 0);
  } finally {
    Date.now = realNow;
    delete globalThis.DwfWS;
    DwfCache._resetForTest();
  }
}

console.log(failed === 0 ? `PASS (0 failures)` : `FAIL (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
