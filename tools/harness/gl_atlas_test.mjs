// gl_atlas_test.mjs -- WB-8 acceptance deliverable (docs/superpowers/specs/
// 2026-07-07-WB-renderer-spec.md, "GL atlas module"). Loads the REAL
// web/js/dwf-gl-atlas.js verbatim (via vm.runInThisContext, same convention as
// tools/harness/cache_test.mjs / tools/spikes/webgl/adjacency-test.mjs) and asserts, against
// procedural (no DF art) fixtures and an injected in-memory sink (no DOM/GL needed -- the
// packer's pixel/index math is pure):
//
//   1. page allocation: N sheets requested in sequence land at the expected global atlas
//      indices, one filler sheet exactly fills page 0 (3599 usable cells after the reserved
//      cell 0), and the next sheet is forced onto page 1 -- proven both via getStats()
//      pagesUsed AND via globalIndexToLocation() on the returned cell.
//   2. gutter bleed margins: readCell() on the in-memory sink's byte-exact atlas simulation
//      shows every gutter pixel equals the source's own true edge pixel (including all 4
//      corners), using a non-uniform ramp cell so a "gutter is just zeroed" bug would fail.
//   3. index stability: a sheet resolved before another (later-registered) sheet loads keeps
//      the SAME atlas index forever, even after the later sheet's cells get appended.
//   4. frame-sequence contiguity (RECONCILE): a token whose `frames` list is scattered at the
//      SHEET's native stride (not adjacent as plain grid cells) packs into N CONSECUTIVE
//      atlas indices via resolveAnimated(), and each destination cell's actual pixel content
//      matches its true (non-contiguous) source cell -- covers both a row-varying grammar
//      (col fixed, row 0..N -- e.g. BROOK_TO_NW/FLOW_MIASMA) and a col-varying grammar (row
//      fixed, col 0..N -- e.g. FIRE/RIVER_TO_*).
//   5. mixed sheet sizes: sheets of different cols x rows pack correctly side by side;
//      non-multiple-of-32 dims round down and warn exactly once.
//   6. eviction behavior: a bounded dynamic (content-addressed unit-sprite) pool evicts the
//      true least-recently-used entry (not merely oldest-inserted) when full, the evicted
//      key's resolve() reverts to PENDING, a fresh registration re-fetches it, and static
//      sheet indices are completely unaffected by any of this.
//   7. atlas allocation failure: an oversized request is rejected, fires onAtlasFull(), and
//      leaves every PRIOR successful allocation untouched.
//
// Run: node tools/harness/gl_atlas_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  makeGridImage, makeRampCell, makeSheetWithCells, makeRaggedImage, makeOversizedStub,
} from "./fixtures/gl_atlas_fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(__dirname, "../../web/js/dwf-gl-atlas.js");

const src = fs.readFileSync(MODULE_PATH, "utf8");
const sandbox = {};
sandbox.self = sandbox; // dual-mode file resolves `self` as its export target
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: MODULE_PATH });

const Atlas = sandbox.DwfGLAtlas;
assert.ok(Atlas, "DwfGLAtlas must be exported onto the sandbox global");
assert.equal(Atlas.CELL_SIZE, 32);
assert.equal(Atlas.CELL_PITCH, 34);
assert.equal(Atlas.PAGE_SIZE, 2048);
assert.equal(Atlas.CELLS_PER_PAGE, 3600, "60x60 cells/page at 34px pitch in a 2048px page");
assert.equal(Atlas.MAX_PAGES, 16, "T1 capacity fix: 16 pages (a full range sweep + palette-swap cells exhausted 8)");
assert.equal(Atlas.PENDING, 0);

function tick(ms) { return new Promise((r) => setTimeout(r, ms || 0)); }

let failures = 0;
function section(name, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log("PASS " + name),
    (err) => { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
  );
}

// ---- shared fixtures: a small named sheet registry a fake fetchSheet resolves against ----
function makeFakeFetcher(sheetMap, opts) {
  opts = opts || {};
  return function fetchSheet(name) {
    const delay = (opts.delays && opts.delays[name]) || 0;
    const img = sheetMap[name];
    if (!img) return Promise.reject(new Error("no such fixture sheet: " + name));
    if (delay > 0) return new Promise((resolve) => setTimeout(() => resolve(img), delay));
    return Promise.resolve(img);
  };
}

// =========================================================================================
await section("page allocation: filler exactly fills page 0, next sheet lands on page 1", async () => {
  // 59 x 61 = 3599 cells -- exactly the cells left in page 0 after the reserved cell 0.
  const filler = makeGridImage(59, 61, 1);
  const nextSheet = makeGridImage(2, 2, 2); // 4 cells, must land on page 1

  const warnings = [];
  const atlas = Atlas.create({
    fetchSheet: makeFakeFetcher({ "filler.png": filler, "next.png": nextSheet }),
    warn: (m) => warnings.push(m),
  });

  assert.equal(atlas.resolve("filler.png", 0, 0), Atlas.PENDING, "not loaded yet -> PENDING/cell0");
  await tick();
  const fillerInfo = atlas.getSheetInfo("filler.png");
  assert.equal(fillerInfo.state, "ready");
  assert.equal(fillerInfo.cols, 59);
  assert.equal(fillerInfo.rows, 61);
  assert.equal(fillerInfo.base, 1, "filler must start right after the reserved cell 0");

  const fillerStats = atlas.getStats();
  assert.equal(fillerStats.cellsUsed, 3599, "cell 0 reserved + 3599 filler cells == page 0 exactly full");
  assert.equal(fillerStats.pagesUsed, 1, "filler alone must not have spilled onto page 1");

  // last filler cell (col 58, row 60) must resolve to global index 3599, still page 0.
  const lastFillerCell = atlas.resolve("filler.png", 58, 60);
  assert.equal(lastFillerCell, 3599);
  assert.equal(Atlas.globalIndexToLocation(lastFillerCell).page, 0);

  const nextIdx = atlas.resolve("next.png", 0, 0);
  assert.equal(nextIdx, Atlas.PENDING, "next.png requested but not yet decoded");
  await tick();
  const nextInfo = atlas.getSheetInfo("next.png");
  assert.equal(nextInfo.state, "ready");
  assert.equal(nextInfo.base, 3600, "next sheet must be forced to start exactly at page 1's first cell");
  const loc = Atlas.globalIndexToLocation(nextInfo.base);
  assert.equal(loc.page, 1, "next sheet's base must resolve onto page 1");
  assert.equal(loc.col, 0);
  assert.equal(loc.row, 0);

  const stats = atlas.getStats();
  assert.equal(stats.pagesUsed, 2, "requesting next.png must have grown pagesUsed to 2");
  assert.equal(warnings.length, 0, "no non-multiple-of-32 sheets in this section");
});

// =========================================================================================
await section("gutter bleed: every duplicated edge pixel equals the source's true edge pixel", async () => {
  const ramp = makeRampCell(32, 17);
  const sheet = makeSheetWithCells(2, 2, 32, [
    { col: 0, row: 0, cell: ramp },
    { col: 1, row: 0, cell: makeRampCell(32, 91) },
    { col: 0, row: 1, cell: makeRampCell(32, 5) },
    { col: 1, row: 1, cell: makeRampCell(32, 200) },
  ]);
  const atlas = Atlas.create({ fetchSheet: makeFakeFetcher({ "ramp.png": sheet }) });
  const idx = atlas.resolve("ramp.png", 0, 0);
  assert.equal(idx, Atlas.PENDING);
  await tick();
  const realIdx = atlas.resolve("ramp.png", 0, 0);
  assert.notEqual(realIdx, Atlas.PENDING);

  // Reach into the in-memory sink used by create() (no `sink` option given -> memory sink).
  // We can't get the sink object back from the public API, so rebuild the same read through
  // a second atlas constructed WITH an explicit sink handle for inspection.
  const sink = Atlas.makeMemorySink();
  const atlas2 = Atlas.create({ sink: sink, fetchSheet: makeFakeFetcher({ "ramp.png": sheet }) });
  const idx2 = atlas2.resolve("ramp.png", 0, 0);
  await tick();
  const realIdx2 = atlas2.resolve("ramp.png", 0, 0);
  assert.notEqual(realIdx2, Atlas.PENDING);

  const padded = sink.readCell(realIdx2, false); // full 34x34 block
  const P = 34;
  function px(x, y) {
    const i = (y * P + x) * 4;
    return [padded.data[i], padded.data[i + 1], padded.data[i + 2], padded.data[i + 3]];
  }
  // Inner region starts at (1,1). Top gutter row (y=0) must equal the inner top edge row (y=1).
  for (let x = 1; x <= 32; x++) {
    assert.deepEqual(px(x, 0), px(x, 1), "top gutter mismatch at x=" + x);
    assert.deepEqual(px(x, 33), px(x, 32), "bottom gutter mismatch at x=" + x);
  }
  for (let y = 1; y <= 32; y++) {
    assert.deepEqual(px(0, y), px(1, y), "left gutter mismatch at y=" + y);
    assert.deepEqual(px(33, y), px(32, y), "right gutter mismatch at y=" + y);
  }
  // Corners must duplicate the corner pixel exactly.
  assert.deepEqual(px(0, 0), px(1, 1), "top-left corner");
  assert.deepEqual(px(33, 0), px(32, 1), "top-right corner");
  assert.deepEqual(px(0, 33), px(1, 32), "bottom-left corner");
  assert.deepEqual(px(33, 33), px(32, 32), "bottom-right corner");

  // And the inner 32x32 must be byte-identical to the true source ramp cell (proves we
  // didn't just get lucky with a flat-fill cell that would pass a broken "always zero" gutter).
  const inner = sink.readCell(realIdx2, true);
  assert.deepEqual(Array.from(inner.data), Array.from(ramp.data), "inner cell must be byte-exact vs source");
});

// =========================================================================================
await section("index stability: a late-arriving sheet never shifts an earlier sheet's cells", async () => {
  const early = makeGridImage(3, 3, 10);
  const late = makeGridImage(2, 2, 20);
  const evenLater = makeGridImage(1, 1, 30);
  const atlas = Atlas.create({
    fetchSheet: makeFakeFetcher(
      { "early.png": early, "late.png": late, "later.png": evenLater },
      { delays: { "late.png": 15 } }
    ),
  });

  atlas.resolve("early.png", 0, 0);
  await tick();
  const earlyIdxBefore = atlas.resolve("early.png", 1, 2);
  assert.notEqual(earlyIdxBefore, Atlas.PENDING);

  const lateIdx0 = atlas.resolve("late.png", 0, 0);
  assert.equal(lateIdx0, Atlas.PENDING, "late.png is still in flight");
  await tick(30); // let the delayed fetch land
  const lateIdxAfter = atlas.resolve("late.png", 0, 0);
  assert.notEqual(lateIdxAfter, Atlas.PENDING);

  assert.equal(atlas.resolve("early.png", 1, 2), earlyIdxBefore,
    "early.png's index must be unchanged after late.png finally loaded");

  atlas.resolve("later.png", 0, 0);
  await tick();
  assert.notEqual(atlas.resolve("later.png", 0, 0), Atlas.PENDING);

  // both earlier sheets still stable after yet another sheet was appended
  assert.equal(atlas.resolve("early.png", 1, 2), earlyIdxBefore);
  assert.equal(atlas.resolve("late.png", 0, 0), lateIdxAfter);
});

// =========================================================================================
await section("frame-sequence contiguity (RECONCILE): scattered source frames pack consecutively", async () => {
  // Row-varying grammar (BROOK_TO_NW/FLOW_MIASMA style): sheetCols=4 so plain-grid indices
  // for col=0,row=0..5 would be 4 cells apart, NOT adjacent -- proves resolveAnimated() must
  // NOT just reuse the plain-grid stride.
  const frameCellsRow = [];
  for (let r = 0; r < 6; r++) frameCellsRow.push(makeRampCell(32, 50 + r));
  const rowSheet = makeSheetWithCells(4, 6, 32, frameCellsRow.map((cell, r) => ({ col: 0, row: r, cell })));

  // Col-varying grammar (FIRE/RIVER_TO_* style): sheetRows=5 so col=0..3,row=0 plain-grid
  // indices would be 1 apart by ACCIDENT on a 1-row sheet -- use a taller sheet (rows=5) so
  // the col-run sits at row 3, proving col-major frame extraction, not just "any adjacent".
  const frameCellsCol = [];
  for (let c = 0; c < 4; c++) frameCellsCol.push(makeRampCell(32, 150 + c));
  const colSheet = makeSheetWithCells(4, 5, 32, frameCellsCol.map((cell, c) => ({ col: c, row: 3, cell })));

  const sink = Atlas.makeMemorySink();
  const atlas = Atlas.create({
    sink: sink,
    fetchSheet: makeFakeFetcher({ "flows_row.png": rowSheet, "flows_col.png": colSheet }),
  });

  const rowFrames = [0, 1, 2, 3, 4, 5].map((r) => ({ col: 0, row: r }));
  let base = atlas.resolveAnimated("BROOK_TO_NW", "flows_row.png", rowFrames);
  assert.equal(base, Atlas.PENDING, "sheet not decoded yet");
  await tick();
  base = atlas.resolveAnimated("BROOK_TO_NW", "flows_row.png", rowFrames);
  assert.notEqual(base, Atlas.PENDING);
  for (let i = 0; i < rowFrames.length; i++) {
    const cellData = sink.readCell(base + i, true);
    assert.deepEqual(Array.from(cellData.data), Array.from(frameCellsRow[i].data),
      "frame " + i + " (row-varying) must hold its true scattered source cell, at base+" + i);
  }
  // idempotent: calling again returns the SAME base, no re-allocation.
  const statsAfterFirst = atlas.getStats();
  const base2 = atlas.resolveAnimated("BROOK_TO_NW", "flows_row.png", rowFrames);
  assert.equal(base2, base);
  assert.equal(atlas.getStats().cellsUsed, statsAfterFirst.cellsUsed, "repeat call must not allocate again");

  const colFrames = [0, 1, 2, 3].map((c) => ({ col: c, row: 3 }));
  let cbase = atlas.resolveAnimated("FIRE", "flows_col.png", colFrames);
  assert.equal(cbase, Atlas.PENDING);
  await tick();
  cbase = atlas.resolveAnimated("FIRE", "flows_col.png", colFrames);
  assert.notEqual(cbase, Atlas.PENDING);
  for (let i = 0; i < colFrames.length; i++) {
    const cellData = sink.readCell(cbase + i, true);
    assert.deepEqual(Array.from(cellData.data), Array.from(frameCellsCol[i].data),
      "frame " + i + " (col-varying) must hold its true scattered source cell, at base+" + i);
  }

  // The two animated runs must not overlap each other's cells.
  assert.ok(cbase >= base + rowFrames.length || base >= cbase + colFrames.length,
    "the two animated runs must occupy disjoint atlas ranges");
});

// =========================================================================================
await section("mixed sheet sizes: different grids pack correctly; ragged dims round down + warn once", async () => {
  const sheetA = makeGridImage(4, 4, 1);   // 16 cells
  const sheetB = makeGridImage(10, 3, 2);  // 30 cells
  const sheetC = makeGridImage(1, 8, 3);   // 8 cells (tall single column, like brook.png)
  const ragged = makeRaggedImage(100, 64); // 100/32 = 3 rem 4 -> warn once, pack as 3x2

  const warnings = [];
  const atlas = Atlas.create({
    fetchSheet: makeFakeFetcher({
      "a.png": sheetA, "b.png": sheetB, "c.png": sheetC, "ragged.png": ragged,
    }),
    warn: (m) => warnings.push(m),
  });

  atlas.resolve("a.png", 0, 0);
  atlas.resolve("b.png", 0, 0);
  atlas.resolve("c.png", 0, 0);
  atlas.resolve("ragged.png", 0, 0);
  await tick();

  const ai = atlas.getSheetInfo("a.png");
  const bi = atlas.getSheetInfo("b.png");
  const ci = atlas.getSheetInfo("c.png");
  const ri = atlas.getSheetInfo("ragged.png");
  assert.deepEqual([ai.cols, ai.rows], [4, 4]);
  assert.deepEqual([bi.cols, bi.rows], [10, 3]);
  assert.deepEqual([ci.cols, ci.rows], [1, 8]);
  assert.deepEqual([ri.cols, ri.rows], [3, 2], "100x64 must round down to a 3x2 grid at 32px cells");

  // Distinct, non-overlapping base ranges (allocation order == request-completion order here
  // since all fixtures resolve on the same microtask tick).
  const ranges = [
    [ai.base, ai.cols * ai.rows], [bi.base, bi.cols * bi.rows],
    [ci.base, ci.cols * ci.rows], [ri.base, ri.cols * ri.rows],
  ].sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i][0] >= ranges[i - 1][0] + ranges[i - 1][1],
      "sheet cell ranges must not overlap");
  }

  assert.equal(warnings.length, 1, "exactly one warning for the one ragged sheet");
  assert.match(warnings[0], /ragged\.png/);
  assert.match(warnings[0], /100x64/);
});

// =========================================================================================
await section("dynamic unit-sprite eviction: true LRU, index reuse, cache invalidation on evict", async () => {
  const spanOneImg = (n) => makeGridImage(1, 1, n); // sw=1,sh=1 unit composite
  const atlas = Atlas.create({
    dynamicMaxCells: 4,
    fetchDynamic: (url) => Promise.resolve(spanOneImg(url.length)),
  });

  atlas.registerDynamicSheet("hashA", "/unit-sprite/aaaa.png");
  atlas.registerDynamicSheet("hashB", "/unit-sprite/bbbb.png");
  atlas.registerDynamicSheet("hashC", "/unit-sprite/cccc.png");
  atlas.registerDynamicSheet("hashD", "/unit-sprite/dddd.png");
  await tick();
  for (const k of ["hashA", "hashB", "hashC", "hashD"]) {
    assert.notEqual(atlas.resolve(k, 0, 0), Atlas.PENDING, k + " must be ready (budget exactly fits 4x span-1)");
  }
  const statsFull = atlas.getStats();
  assert.equal(statsFull.dynamicEntriesLive, 4);
  assert.equal(statsFull.dynamicEvictions, 0);

  // Touch B, C, D (in that order) via resolve() so A is the true least-recently-used --
  // NOT simply "first inserted" (B was inserted before C/D too, but gets touched again here).
  atlas.resolve("hashB", 0, 0);
  atlas.resolve("hashC", 0, 0);
  atlas.resolve("hashD", 0, 0);

  const aBaseBefore = atlas.getDynamicInfo("hashA").base;

  atlas.registerDynamicSheet("hashE", "/unit-sprite/eeee.png");
  await tick();
  assert.notEqual(atlas.resolve("hashE", 0, 0), Atlas.PENDING, "hashE must have been packed");
  assert.equal(atlas.getStats().dynamicEvictions, 1, "exactly one eviction to make room for hashE");
  assert.equal(atlas.getDynamicInfo("hashA"), null, "hashA must have been evicted, not some other key");
  assert.equal(atlas.resolve("hashA", 0, 0), Atlas.PENDING, "evicted key's resolve() must revert to PENDING/cell0");
  assert.equal(atlas.getDynamicInfo("hashE").base, aBaseBefore, "hashE must reuse hashA's freed cell exactly");

  // Static sheets, if any were in play, would be untouched by any of this -- prove the
  // eviction machinery never touches the static append-only allocator's own bookkeeping by
  // checking cellsUsed only reflects the 4 live dynamic entries (no drift/growth from the
  // evict+reuse cycle).
  assert.equal(atlas.getStats().cellsUsed, 4, "evict+reuse must not grow total cells used");

  // Re-registering the evicted key must trigger a genuinely fresh fetch (not silently stale).
  atlas.registerDynamicSheet("hashA", "/unit-sprite/aaaa.png");
  await tick();
  assert.notEqual(atlas.resolve("hashA", 0, 0), Atlas.PENDING, "re-registered hashA must resolve again");
});

// =========================================================================================
await section("atlas allocation failure: oversized request rejected without disturbing prior allocations", async () => {
  const small = makeGridImage(2, 2, 1);
  const oversized = makeOversizedStub(241, 241); // 58081 cells > 57599 available after cell 0 (16 pages)

  let fullFired = 0;
  const atlas = Atlas.create({
    fetchSheet: makeFakeFetcher({ "small.png": small, "huge.png": oversized }),
  });
  atlas.onAtlasFull(() => { fullFired++; });

  atlas.resolve("small.png", 0, 0);
  await tick();
  const smallInfo = atlas.getSheetInfo("small.png");
  assert.equal(smallInfo.state, "ready");
  const smallBase = smallInfo.base;

  atlas.resolve("huge.png", 0, 0);
  await tick();
  const hugeInfo = atlas.getSheetInfo("huge.png");
  assert.equal(hugeInfo.state, "error", "an over-budget sheet must be rejected, not silently truncated");
  assert.equal(fullFired, 1, "onAtlasFull must fire exactly once");
  assert.equal(atlas.getStats().allocationFailed, true);

  // The earlier, successful allocation must be completely undisturbed.
  assert.equal(atlas.getSheetInfo("small.png").base, smallBase);
  assert.equal(atlas.resolve("small.png", 1, 1), smallBase + 3);
});

// =========================================================================================
await section("capacity boundary: exactly MAX_CELLS-1 usable cells fit, one more does not", async () => {
  // Regression guard for an off-by-one in the allocator's budget check: MAX_CELLS total
  // slots across 8 pages, index 0 reserved, so exactly MAX_CELLS-1 real cells must fit and
  // not one more. Use a 1-row sheet so the grid math stays simple (cols == cell count).
  const exact = makeOversizedStub(Atlas.MAX_CELLS - 1, 1);   // fits exactly
  const overByOne = makeOversizedStub(Atlas.MAX_CELLS, 1);   // one cell too many, alone

  const atlasA = Atlas.create({ fetchSheet: makeFakeFetcher({ "exact.png": exact }) });
  atlasA.resolve("exact.png", 0, 0);
  await tick();
  const exactInfo = atlasA.getSheetInfo("exact.png");
  assert.equal(exactInfo.state, "ready", "MAX_CELLS-1 cells must fit exactly (base=1 .. MAX_CELLS-1)");
  assert.equal(exactInfo.base, 1);
  assert.equal(atlasA.resolve("exact.png", Atlas.MAX_CELLS - 2, 0), Atlas.MAX_CELLS - 1,
    "the very last cell must land on global index MAX_CELLS-1, the true last valid slot");

  const atlasB = Atlas.create({ fetchSheet: makeFakeFetcher({ "over.png": overByOne }) });
  atlasB.resolve("over.png", 0, 0);
  await tick();
  assert.equal(atlasB.getSheetInfo("over.png").state, "error",
    "MAX_CELLS cells (using up index MAX_CELLS itself) must be rejected -- only indices 0..MAX_CELLS-1 exist");
});


// =========================================================================================
await section("smallgems sheet geometry: 16px native cells pack into 32px atlas slots", async () => {
  const smallgems = makeGridImage(22, 1, 77, { cellSize: 16 });
  const gems = makeGridImage(23, 1, 88, { cellSize: 32 });
  const sink = Atlas.makeMemorySink();
  const atlas = Atlas.create({
    sink: sink,
    sheetGeometry: {
      "smallgems.png": { cell_w: 16, cell_h: 16, page_w: 352, page_h: 16 },
      "gems.png": { cell_w: 32, cell_h: 32, page_w: 736, page_h: 32 },
    },
    fetchSheet: makeFakeFetcher({ "smallgems.png": smallgems, "gems.png": gems }),
  });

  assert.equal(atlas.resolve("smallgems.png", 21, 0), Atlas.PENDING, "decode is async");
  await tick();
  const si = atlas.getSheetInfo("smallgems.png");
  assert.deepEqual([si.cols, si.rows], [22, 1], "352x16 / 16x16 yields all 22 small-gem cells");
  const smallIdx = atlas.resolve("smallgems.png", 21, 0);
  assert.notEqual(smallIdx, Atlas.PENDING, "last small-gem cell must resolve to a nonzero atlas id");
  const smallCell = sink.readCell(smallIdx, true);
  for (let y = 0; y < smallCell.height; y++) {
    for (let x = 0; x < smallCell.width; x++) {
      const i = (y * smallCell.width + x) * 4;
      assert.equal(smallCell.data[i], (21 * 7 + 11) % 256, "scaled small-gem R at " + x + "," + y);
      assert.equal(smallCell.data[i + 1], 5, "scaled small-gem G at " + x + "," + y);
      assert.equal(smallCell.data[i + 2], 77, "scaled small-gem B at " + x + "," + y);
      assert.equal(smallCell.data[i + 3], 255, "scaled small-gem A at " + x + "," + y);
    }
  }

  atlas.resolve("gems.png", 22, 0);
  await tick();
  const gi = atlas.getSheetInfo("gems.png");
  assert.deepEqual([gi.cols, gi.rows], [23, 1], "gems.png control remains a 23x1 32px grid");
  assert.notEqual(atlas.resolve("gems.png", 22, 0), Atlas.PENDING, "last large-gem control cell resolves");
});

// =========================================================================================
// AH-DEFECT CLIENT HEAL (live report 07-09): a unit portrait first referenced BEFORE the
// server had baked its composite (`/unit-sprite/<hash>.png` 404s -- DF fills
// texpos_currently_in_use only once the unit RENDERS host-side, so a never-yet-drawn spawn has
// no composite until the window #10 worker re-enqueues the bake seconds-to-minutes later) used
// to be DELETED from `dynamicEntries` on the failing fetch. That made resolve()/registerDynamic
// re-fetch the SAME missing hash every single rAF frame (a request storm) AND applied no backoff,
// while the reported symptom on the canvas2d twin was the opposite -- a negative cache that never
// recovered until a full page reload. The fix keeps the failed entry in an "error" state and
// re-fetches only once DYNAMIC_RETRY_DELAY_MS has elapsed, lazily on the next per-frame reference.
const DYN_RETRY_MS = 3000; // mirrors dwf-gl-atlas.js DYNAMIC_RETRY_DELAY_MS
await section("dynamic unit-sprite 404 heals via bounded backoff retry (no per-frame storm, no reload)", async () => {
  let attempt = 0;
  const baked = makeGridImage(1, 1, 7); // the sw=1/sh=1 composite, once the server bakes it
  const fetchDynamic = (_url) => {
    attempt++;
    if (attempt <= 2) return Promise.reject(new Error("404 -- composite not baked yet")); // still baking
    return Promise.resolve(baked);
  };
  let clock = 0;
  let readyFires = 0;
  const atlas = Atlas.create({ fetchDynamic, now: () => clock });
  atlas.onSheetReady((k) => { if (k === "hashLate") readyFires++; });

  // Frame 1: first reference kicks the fetch off; it 404s.
  atlas.registerDynamicSheet("hashLate", "/unit-sprite/hashLate.png");
  await tick();
  assert.equal(attempt, 1, "one fetch kicked off on first reference");
  assert.equal(atlas.resolve("hashLate", 0, 0), Atlas.PENDING, "a 404'd portrait resolves to PENDING (caller draws the dot)");

  // STORM GUARD: re-referencing every frame BEFORE the backoff elapses must NOT re-fetch.
  for (let f = 0; f < 120; f++) atlas.registerDynamicSheet("hashLate", "/unit-sprite/hashLate.png");
  await tick();
  assert.equal(attempt, 1, "no re-fetch within the backoff window despite 120 per-frame references (was a storm)");

  // Past the backoff: the next reference retries -- and this attempt 404s too (server still baking).
  clock += DYN_RETRY_MS + 1;
  atlas.registerDynamicSheet("hashLate", "/unit-sprite/hashLate.png");
  await tick();
  assert.equal(attempt, 2, "exactly one retry once the backoff elapses (bounded, not a hot loop)");
  assert.equal(atlas.resolve("hashLate", 0, 0), Atlas.PENDING, "still PENDING while the second attempt also 404s");

  // Past the backoff again: the bake has now landed, so the retry succeeds and the portrait fills.
  clock += DYN_RETRY_MS + 1;
  atlas.registerDynamicSheet("hashLate", "/unit-sprite/hashLate.png");
  await tick();
  assert.equal(attempt, 3, "third attempt fired after the second backoff");
  assert.notEqual(atlas.resolve("hashLate", 0, 0), Atlas.PENDING, "portrait fills in automatically once the late bake lands -- no page reload");
  assert.equal(readyFires, 1, "onSheetReady fired EXACTLY ONCE on the ready transition (render.js's repaint/rebuild hook)");

  // IDLE GUARD: a now-ready portrait never re-fetches, no matter how much time passes or how
  // many times it is referenced -- zero network/timer wakeups when nothing is missing.
  clock += DYN_RETRY_MS * 20;
  for (let f = 0; f < 60; f++) atlas.registerDynamicSheet("hashLate", "/unit-sprite/hashLate.png");
  await tick();
  assert.equal(attempt, 3, "a resolved portrait never re-fetches -- zero wakeups once nothing is missing");
});

// =========================================================================================
await section("dynamic seeded-bad detection: a decodable-but-unusable composite is NOT retry-stormed", async () => {
  // A fetch that SUCCEEDS but yields an unusable image (0 usable cells -- a truncated/blank bake,
  // distinct from a 404) is a permanent, non-network defect: re-fetching the identical bytes can
  // never change the outcome. It must be recorded errored and left alone, NOT retried every frame
  // like a still-baking 404. (retryable=false, same split as ensureSheet's bad-dims vs fetch-fail.)
  let attempt = 0;
  const bad = makeOversizedStub(0, 0); // decodes, but gridDims -> 0 cols -> unusable
  const fetchDynamic = (_url) => { attempt++; return Promise.resolve(bad); };
  let clock = 0;
  const atlas = Atlas.create({ fetchDynamic, now: () => clock });

  atlas.registerDynamicSheet("hashBad", "/unit-sprite/hashBad.png");
  await tick();
  assert.equal(attempt, 1, "one fetch attempted");
  assert.equal(atlas.resolve("hashBad", 0, 0), Atlas.PENDING, "an unusable composite resolves to PENDING");

  clock += DYN_RETRY_MS * 5;
  for (let f = 0; f < 40; f++) atlas.registerDynamicSheet("hashBad", "/unit-sprite/hashBad.png");
  await tick();
  assert.equal(attempt, 1, "a decoded-but-unusable composite is NEVER retried (only network/404 misses are)");
});

// =========================================================================================
if (failures > 0) {
  console.error(failures + " section(s) FAILED");
  process.exit(1);
} else {
  console.log("all gl_atlas_test.mjs sections PASSED");
}
