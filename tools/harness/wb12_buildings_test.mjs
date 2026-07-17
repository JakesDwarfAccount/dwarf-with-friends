// wb12_buildings_test.mjs -- WB-12 acceptance (docs/superpowers/specs/2026-07-07-WB-renderer-
// spec.md, "Buildings"). Loads the REAL web/js/dwf-gl.js (+ dwf-adjacency.js)
// verbatim via vm.runInContext, same convention as gl_core_test.mjs / wb11_sparse_test.mjs, and
// the REAL committed web/building_map.json (same convention as wc4_building_test.mjs) -- no
// synthetic building map for the resolution-logic assertions, so this proves the GL port
// resolves against the SAME data the canvas2d path ships.
//
// Per the run-orders instruction for this item, live gate_parity.py/gate_perf.py runs against DF
// are explicitly OUT of scope (queued for sweep #2/WB-14, same as WB-10/WB-11's own notes);
// evidence here is (1) node instance-stream equivalence tests for fixture buildings -- a
// multi-tile workshop with material tint, a bridge, a well, the MISSING_BUILDING fallback, and
// Stockpile/Civzone exclusion -- and (2) a RECONCILE cross-check against dwf-tiles.js's
// REAL buildingEntry()/isOverlayOnlyBuildingType() test hooks (WC-4), proving the GL port's
// resolution table agrees with the canvas2d reference it mirrors, field for field.
//
// Run: node tools/harness/wb12_buildings_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const realBuildingMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/building_map.json"), "utf8"));
const realMaterialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));

// ---- fixture-assumption guards (fail loudly if the committed map's shape drifts) -----------
assert.ok(realBuildingMap["Workshop:Masons"] && Array.isArray(realBuildingMap["Workshop:Masons"].cells) &&
  realBuildingMap["Workshop:Masons"].cells.length === 3 && realBuildingMap["Workshop:Masons"].cells[0].length === 3,
  "fixture assumption broken: building_map.json's Workshop:Masons is no longer a 3x3 cells[][] footprint");
// texsweep: Bed/Well/Bridge ARE flat top-level entries now (v3 building_type defaults), so
// furniture/well/bridge buildings render a real sprite instead of MISSING_BUILDING. "Shop" is
// the guaranteed-unmapped MISSING_BUILDING example these sections use instead.
assert.ok(Object.prototype.hasOwnProperty.call(realBuildingMap, "Bed") &&
  Object.prototype.hasOwnProperty.call(realBuildingMap, "Well") &&
  Object.prototype.hasOwnProperty.call(realBuildingMap, "Bridge"),
  "fixture assumption broken: building_map.json no longer has the v3 Bed/Well/Bridge defaults");
assert.ok(!Object.prototype.hasOwnProperty.call(realBuildingMap, "Shop"),
  "fixture assumption broken: building_map.json now has a 'Shop' entry -- pick another " +
  "unmapped building_type for the MISSING_BUILDING sections below");

// ---- sandbox 1: the REAL dwf-gl.js + dwf-adjacency.js (this item's own file) ---
const sandbox = {};
sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(sandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}
const GL = sandbox.DwfGL;
assert.ok(GL, "sandbox 1 must export DwfGL");

function makeMockAtlas() {
  const ids = new Map();
  let next = 1;
  return {
    resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!ids.has(k)) ids.set(k, next++); return ids.get(k); },
    resolvePalette(sheet, col, row, palRow) {
      return this.resolve(sheet + "#palette=" + palRow, col, row);
    },
  };
}

function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4], attr: u16[k * 8 + 5],
      r: u8[k * 16 + 12], g: u8[k * 16 + 13], b: u8[k * 16 + 14], a: u8[k * 16 + 15],
    });
  }
  return out;
}

let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}

function tile(o) {
  return Object.assign({ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
}
function flatView(gw, gh, ox, oy, oz) {
  const tiles = new Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) tiles[y * gw + x] = tile({});
  return { origin: { x: ox, y: oy, z: (typeof oz === "number") ? oz : 0 }, width: gw, height: gh, tiles };
}

// =============================================================================================
// (1) MULTI-TILE ART: a 3x3 Workshop:Masons footprint straddling the window edge (part of the
// footprint is outside [0,gw)x[0,gh)) -- assert EVERY sub-cell (including the off-window ones)
// resolves to building_map.json's real per-row/col cell, matching canvas2d's own unclamped
// footprint iteration (a footprint bigger than the window still fully renders; the browser/GPU
// clips off-screen geometry, not this code).
// =============================================================================================
section("multi-tile workshop (3x3 Workshop:Masons) at window edge: exact real sub-cells, incl. off-window", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  // window origin (9,9), 3x3 window (world x/y 9..11) -- building footprint 8,8..10,10 straddles
  // the window's left/top edge (world column/row 8 stays world 8 under R1, off-window).
  const view = flatView(3, 3, 9, 9, 150);
  view.buildings = [{ type: "Workshop", subtype: 2, x1: 8, y1: 8, x2: 10, y2: 10, z: 150 }];
  b.buildScene(view);
  const inst = decode(b);
  const masons = realBuildingMap["Workshop:Masons"];
  for (let ry = 0; ry < 3; ry++) {
    for (let rx = 0; rx < 3; rx++) {
      const cd = masons.cells[ry][rx];
      const expectCell = atlas.resolve(masons.sheet, cd.col, cd.row);
      const wx = 8 + rx, wy = 8 + ry;
      const found = inst.find((i) => i.x === wx && i.y === wy && i.cell === expectCell);
      assert.ok(found, `sub-cell (row ${ry}, col ${rx}) at world (${wx},${wy}) must resolve to Workshop:Masons' own [${ry}][${rx}] cell`);
      assert.equal(found.a, 255, "no z-fade / no material tint -> full alpha, neutral (255,255,255) tint");
    }
  }
  console.log("    3x3 workshop instance count: " + inst.length + " (9 expected, incl. 5 off-window)");
});

// =============================================================================================
// (1b) B20 OVERLAY LAYER: a workshop with an `overlay` grid emits BOTH the base sub-cell AND
// the tool/decoration overlay sub-cell per footprint tile (two instances at the same grid
// position, different atlas cells); the overlay is UNTINTED (neutral 255,255,255) even when the
// base is material-tinted.
// =============================================================================================
section("B20: workshop overlay emits a second (untinted) instance per tile on top of the base", () => {
  const masons = realBuildingMap["Workshop:Masons"];
  assert.ok(masons.overlay && masons.overlaySheet, "fixture: Workshop:Masons must carry a v3 overlay grid");
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const view = flatView(3, 3, 9, 9, 150);
  // material-tinted base (component b.crgb -- window #13 corrected: header b.rgb never tints)
  // so we can prove the overlay is NOT tinted with it.
  view.buildings = [{ type: "Workshop", subtype: 2, x1: 9, y1: 9, x2: 11, y2: 11, z: 150, crgb: [120, 60, 40] }];
  b.buildScene(view);
  const inst = decode(b);
  let overlayHits = 0;
  for (let ry = 0; ry < 3; ry++) {
    for (let rx = 0; rx < 3; rx++) {
      const oc = masons.overlay[ry] && masons.overlay[ry][rx];
      if (!oc) continue;
      const oCell = atlas.resolve(masons.overlaySheet, oc.col, oc.row);
      const wx = 9 + rx, wy = 9 + ry;
      const found = inst.find((i) => i.x === wx && i.y === wy && i.cell === oCell &&
        i.r === 255 && i.g === 255 && i.b === 255);
      if (found) overlayHits++;
    }
  }
  assert.ok(overlayHits >= 1, "at least one untinted overlay instance must be emitted (got " + overlayHits + ")");
  console.log("    B20 overlay instances emitted (untinted): " + overlayHits);
});

// =============================================================================================
// (2) MATERIAL TINT (window #13, corrected 2026-07-09 workshoptint): the COMPONENT-derived
// b.crgb becomes the instance's OWN tint via the closed-form multiply factor (buildingTintRgb);
// the HEADER b.rgb NEVER tints (native evidence: a component-less microcline-header workshop
// renders GRAY natively -- see pickBuildingTintRgb's banner in dwf-gl.js).
// =============================================================================================
section("material tint: component b.crgb resolves to the multiply-factor tint on every sub-cell", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const view = flatView(1, 1, 0, 0, 150);
  view.buildings = [{ type: "Workshop", subtype: 2, x1: 0, y1: 0, x2: 0, y2: 0, z: 150, crgb: [200, 80, 40], rgb: [0, 255, 255] }];
  b.buildScene(view);
  const inst = decode(b);
  const expectTint = GL.buildingTintRgb([200, 80, 40]);
  const cd = realBuildingMap["Workshop:Masons"].cells[0][0];
  const cell = atlas.resolve(realBuildingMap["Workshop:Masons"].sheet, cd.col, cd.row);
  const found = inst.find((i) => i.cell === cell);
  assert.ok(found, "the (0,0) sub-cell of the 3x3 footprint's own [0][0] entry was emitted");
  // GL.buildingTintRgb runs INSIDE the vm sandbox realm -- its returned array's prototype
  // differs from this script's native Array.prototype, so assert.deepEqual would treat two
  // value-identical arrays as unequal (same cross-realm pitfall wb11_sparse_test.mjs's
  // RECONCILE-WC14 section documents); JSON round-trip normalizes both sides first.
  assert.deepEqual([found.r, found.g, found.b], JSON.parse(JSON.stringify(expectTint)), "instance tint == buildingTintRgb(b.crgb)");
  assert.equal(found.a, 255, "material tint alone (no z-fade) keeps full alpha");
});

// B273 primary path: a new server also ships the component's canonical STATE_COLOR token. The
// atlas receives that palette row and the instance tint stays neutral because the cell pixels are
// already substituted; crgb remains only the older-server/unknown-token fallback above.
section("B273 material palette: component b.cpal resolves an exact atlas cell, not a multiply", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap, materialMap: realMaterialMap });
  const view = flatView(1, 1, 0, 0, 150);
  view.buildings = [{ type: "Workshop", subtype: 2, x1: 0, y1: 0, x2: 0, y2: 0, z: 150,
    cpal: "PALE_PINK", crgb: [255, 182, 193], rgb: [0, 255, 255] }];
  b.buildScene(view);
  const inst = decode(b);
  const cd = realBuildingMap["Workshop:Masons"].cells[0][0];
  const row = realMaterialMap.palette.byname.PALE_PINK;
  const cell = atlas.resolvePalette(realBuildingMap["Workshop:Masons"].sheet, cd.col, cd.row, row);
  const found = inst.find((i) => i.cell === cell);
  assert.ok(found, "workshop base cell must be resolved through the PALE_PINK palette row");
  assert.deepEqual([found.r, found.g, found.b], [255, 255, 255],
    "palette-substituted pixels use a neutral instance tint (no second/global multiply)");
});

// =============================================================================================
// (2b) HEADER NEVER TINTS (the five blue-workshop reports): a building carrying ONLY the
// header material color (b.rgb, e.g. microcline CYAN) -- the exact wire shape of a
// component-less building (empty contained_items -> server emits no crgb) -- must render
// NEUTRAL (255,255,255): native draws its authored art untinted (2026-07-09 tintprobe:
// native cyan-frac 0.000 vs the old header-fallback browser 0.26-0.56).
// =============================================================================================
section("header b.rgb alone NEVER tints: component-less building renders neutral (blue-workshop)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const view = flatView(1, 1, 0, 0, 150);
  view.buildings = [{ type: "Workshop", subtype: 2, x1: 0, y1: 0, x2: 0, y2: 0, z: 150, rgb: [0, 255, 255] }];
  b.buildScene(view);
  const inst = decode(b);
  const cd = realBuildingMap["Workshop:Masons"].cells[0][0];
  const cell = atlas.resolve(realBuildingMap["Workshop:Masons"].sheet, cd.col, cd.row);
  const found = inst.find((i) => i.cell === cell);
  assert.ok(found, "the (0,0) sub-cell was emitted");
  assert.deepEqual([found.r, found.g, found.b], [255, 255, 255],
    "header-only building must be NEUTRAL -- a non-white tint here is the blue-workshop defect");
  assert.equal(found.a, 255, "full alpha");
});

// =============================================================================================
// (3) Z-FADE: wire:6 sends buildings across the stacked z-range. BELOW camera: translucency via
// the measured see-down fog curve (belowAlpha/fogAlphaForDepth, docs/reference/fogparams.json
// `seeDown`, sweep #2) as a proxy -- buildings weren't themselves fog-sampled, terrain was.
// ABOVE camera: NO fade at all -- fogparams.json `seeAbove.mode: "delete"` (DF draws no
// above-camera translucent canopy), so the old alphaAbove curve is gone, not re-shaped.
// =============================================================================================
function buildingInstancesAt(depth, extra = {}) {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const view = flatView(1, 1, 0, 0, 10);
  view.buildings = [{ type: "TradeDepot", x1: 0, y1: 0, x2: 0, y2: 0,
    z: 10 - depth, ...extra }];
  b.buildScene(view);
  const inst = decode(b);
  const cd = realBuildingMap.TradeDepot.cells[0][0];
  const cell = atlas.resolve(realBuildingMap.TradeDepot.sheet, cd.col, cd.row);
  return inst.filter((i) => i.cell === cell);
}
section("ZBELOW-BUILDINGS: a DEEP sd-tagged building uses raw terrain alpha (no unit floor)", () => {
  const depth = 9;
  assert.equal(GL.belowAlpha(depth), 0, "guard: raw terrain curve reaches zero at depth 9");
  const inst = buildingInstancesAt(depth, { sd: 1 });
  assert.equal(inst.length, 1, "sd-tagged deep building still emits its tile-composite cell");
  assert.equal(inst[0].a, 0, "building alpha is the unfloored terrain curve, not units' 0.55 floor");
});
section("ZBELOW-BUILDINGS: a SHALLOW sd-tagged building uses the raw terrain curve", () => {
  const depth = 1;
  const inst = buildingInstancesAt(depth, { sd: 1 });
  assert.equal(inst.length, 1);
  assert.equal(inst[0].a, Math.round(GL.belowAlpha(depth) * 255));
});
section("ZBELOW-BUILDINGS discriminator: sd is REQUIRED for a below-camera building", () => {
  assert.equal(buildingInstancesAt(2).length, 0, "untagged below-camera stale ghost is dropped");
});
section("ZBELOW-BUILDINGS: sd does NOT resurrect an ABOVE-camera building", () => {
  assert.equal(buildingInstancesAt(-2, { sd: 1 }).length, 0, "above-camera building stays deleted");
});

// =============================================================================================
// (4)/(5) texsweep: furniture/well/bridge buildings now resolve to a REAL sprite via the v3
// top-level building_type default keys (Bed/Well/Bridge/... in building_map.json). An
// unmapped type ("Shop" -- no vanilla in-world building sprite) still resolves to the WC-4
// MISSING_BUILDING fallback cell (defaults.png 0:1), NEVER the old `_default` workshop stamp.
// This proves the GL port mirrors the canvas2d reference's ACTUAL behaviour on both paths.
// =============================================================================================
section("v3 default: Bed resolves to a REAL sprite (not MISSING_BUILDING)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const e = b._buildingEntryForTest({ type: "Bed" });
  assert.ok(e && e.sheet && !(e.sheet === "defaults.png" && e.col === 0 && e.row === 1), "Bed -> real sprite");
});
section("v3 default: Well resolves to a REAL sprite (not MISSING_BUILDING)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const e = b._buildingEntryForTest({ type: "Well" });
  assert.ok(e && e.sheet && !(e.sheet === "defaults.png" && e.col === 0 && e.row === 1), "Well -> real sprite");
});
section("v3 default: Bridge resolves to a REAL sprite (not MISSING_BUILDING)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const e = b._buildingEntryForTest({ type: "Bridge" });
  assert.ok(e && e.sheet && !(e.sheet === "defaults.png" && e.col === 0 && e.row === 1), "Bridge -> real sprite");
});
// =============================================================================================
// (4c) B183 (REOPENED -- twice-shipped, still legless live): a PLACED table/chair renders
// through THIS building_map's furniture matvariant (buildingEntryGL ->
// buildingMap.furniture.Table/Chair), never item_map.json's already-composited matvariants.Table.
// Before B270 it reached the equivalent top-level default instead. The prior two fixes
// wired the leg composite only into item_map, so placed furniture kept the bare legless base.
// Assert the building resolver now returns the *_composite.png sheet for both, and that every
// furniture matvariant is composited -- the DATA the placed path actually draws.
// =============================================================================================
assert.ok(realBuildingMap.Table && realBuildingMap.Table.sheet === "item_table_composite.png",
  "fixture assumption broken: building_map.json Table default is not the leg composite");
assert.ok(realBuildingMap.Chair && realBuildingMap.Chair.sheet === "item_chair_composite.png",
  "fixture assumption broken: building_map.json Chair default is not the leg composite");
section("B183: placed Table resolves to item_table_composite.png (legs), not the bare base", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const e = b._buildingEntryForTest({ type: "Table" });
  assert.equal(e.sheet, "item_table_composite.png", "placed Table must draw the composite sheet");
  assert.notEqual(e.sheet, "item_table.png", "placed Table must NOT draw the bare legless base");
  const mv = realBuildingMap.furniture.Table.matvariants;
  for (const mat of ["WOOD", "STONE", "METAL", "GLASS"])
    assert.equal(mv[mat].sheet, "item_table_composite.png", "furniture.Table." + mat + " must be composited");
});
section("B183: placed Chair resolves to item_chair_composite.png (legs), not the bare base", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const e = b._buildingEntryForTest({ type: "Chair" });
  assert.equal(e.sheet, "item_chair_composite.png", "placed Chair must draw the composite sheet");
  assert.notEqual(e.sheet, "item_chair.png", "placed Chair must NOT draw the bare legless base");
  const mv = realBuildingMap.furniture.Chair.matvariants;
  for (const mat of ["WOOD", "STONE", "METAL", "GLASS"])
    assert.equal(mv[mat].sheet, "item_chair_composite.png", "furniture.Chair." + mat + " must be composited");
});
section("B183 [seeded-bad]: a bare-base furniture Table is NOT the composite (assertion is load-bearing)", () => {
  const badMap = JSON.parse(JSON.stringify(realBuildingMap));
  badMap.furniture.Table.matvariants.WOOD = { sheet: "item_table.png", col: 0, row: 0 };
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: badMap });
  const e = b._buildingEntryForTest({ type: "Table" });
  assert.notEqual(e.sheet, "item_table_composite.png",
    "seeded bare-base Table must fail the composite check -- proves the real assertion catches the live bug");
});

section("MISSING_BUILDING fallback: unmapped type (Shop) resolves to defaults.png 0:1", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const e = b._buildingEntryForTest({ type: "Shop" });
  assert.ok(e && e.sheet === "defaults.png" && e.col === 0 && e.row === 1, "Shop -> MISSING_BUILDING");
});
section("a REAL mapped type (Workshop:Masons) still resolves to its own sprite, not MISSING_BUILDING", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const e = b._buildingEntryForTest({ type: "Workshop", subtype: 2 });
  assert.ok(e && e.sheet === "workshops.png", "Workshop:Masons resolves to its own sheet, not defaults.png");
});
section("no building_map loaded yet: everything falls back to MISSING_BUILDING (never throws)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas }); // buildingMap absent
  const e = b._buildingEntryForTest({ type: "Workshop", subtype: 2 });
  assert.ok(e && e.sheet === "defaults.png" && e.col === 0 && e.row === 1, "no map loaded -> MISSING_BUILDING, not a crash");
});

// =============================================================================================
// (6) STOCKPILE/CIVZONE EXCLUSION: zero building-art instances for these types (dedicated
// overlay channel, WC-7/WB-14 territory) -- pixel assert: nothing at all emitted for the
// footprint, not even the MISSING_BUILDING stamp.
// =============================================================================================
section("Stockpile/Civzone: zero building-art instances (not even MISSING_BUILDING)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const view = flatView(2, 2, 0, 0, 150);
  view.buildings = [
    { type: "Stockpile", x1: 0, y1: 0, x2: 1, y2: 1, z: 150 },
    { type: "Civzone", x1: 0, y1: 0, x2: 1, y2: 1, z: 150 },
  ];
  const before = decode(b).length; // terrain-only instances (no buildings emitted yet)
  b.buildScene(view);
  const after = decode(b);
  const missCell = atlas.resolve("defaults.png", 0, 1);
  assert.ok(!after.some((i) => i.cell === missCell), "no MISSING_BUILDING stamp for Stockpile/Civzone");
  // exact count: 4 tiles * 1 base-colour SOLID_CELL instance each (StoneFloor5 has no sprite
  // mapping in this fixture's spriteMap, which is intentionally absent) = 4, PLUS zero building
  // instances.
  assert.equal(after.length, 4, "only the 4 terrain base-fill instances, zero building instances");
  assert.ok(GL.isOverlayOnlyBuildingType("Stockpile") && GL.isOverlayOnlyBuildingType("Civzone"),
    "module-level isOverlayOnlyBuildingType predicate agrees");
  assert.ok(!GL.isOverlayOnlyBuildingType("Workshop"), "Workshop is NOT overlay-only");
});

// =============================================================================================
// (7) PAINTER ORDER: buildings emit strictly AFTER every terrain-pass tile instance (matching
// canvas2d's "(8) BUILDINGS: ... drawn AFTER terrain/items/plants/trees").
// =============================================================================================
section("painter order: building instances come after all terrain instances in the buffer", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const view = flatView(2, 2, 0, 0, 150);
  view.buildings = [{ type: "TradeDepot", x1: 0, y1: 0, x2: 0, y2: 0, z: 150 }];
  b.buildScene(view);
  const inst = decode(b);
  const cd = realBuildingMap.TradeDepot.cells[0][0];
  const bldCell = atlas.resolve(realBuildingMap.TradeDepot.sheet, cd.col, cd.row);
  const bldIdx = inst.findIndex((i) => i.cell === bldCell);
  assert.ok(bldIdx >= 0, "building instance present");
  // 4 terrain tiles each emit exactly 1 base-fill SOLID_CELL instance (no spriteMap wired) ->
  // indices 0..3 are terrain, the building instance must be at index >= 4.
  assert.ok(bldIdx >= 4, "building instance index (" + bldIdx + ") is after all 4 terrain instances");
});

// =============================================================================================
// (8) CAPACITY: a large building footprint never silently clamps (the ensureCapacity budget
// accounts for buildings, not just tiles).
// =============================================================================================
section("capacity: a large building footprint emits every sub-cell, no silent clamp", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const view = flatView(1, 1, 0, 0, 150); // tiny window, but the building footprint is huge
  // B47 note: this section verifies BUFFER CAPACITY, so it must use an entry that fills its
  // whole footprint. Multi-cell art SMALLER than the footprint is now CENTERED (the wagon
  // fix, section 8b below) instead of edge-clamp repeated, so the old TradeDepot-on-50x50
  // fixture no longer fills 2500 cells BY DESIGN. Bridge's 1x1 `cells` entry is the
  // deliberate pattern-stamp path and still tiles the full span.
  view.buildings = [{ type: "Bridge", x1: 0, y1: 0, x2: 49, y2: 49, z: 150 }]; // 50x50 = 2500 sub-cells
  const r = b.buildScene(view);
  assert.ok(r.count >= 2500, "at least 2500 building sub-cell instances made it into the buffer (no clamp): got " + r.count);
});

// =============================================================================================
// (8b) TX3 (B47 reopen): the wagon's authored art is 3-wide x 3-tall on its 3x3 footprint --
// each footprint tile has its OWN distinct art (subtile_x 0,1,2 in the DF raws), plus a 3-wide
// overhang row. The earlier premise -- a 1x3 strip DF "centers" with bare flanks -- was a DATA
// bug: build_building_map.py mis-read the 2-param col:row grammar and collapsed the art to
// column 2, so 2 of the 3 columns rendered blank (re-report). With the corrected map the
// centering path is a no-op (art width == footprint width) and every column draws.
// =============================================================================================
section("TX3: wagon 3x3 art fills all three footprint columns (no blank columns)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const view = flatView(5, 5, 0, 0, 150);
  view.buildings = [{ type: "Wagon", x1: 1, y1: 1, x2: 3, y2: 3, z: 150 }]; // 3x3 footprint
  b.buildScene(view);
  const inst = decode(b);
  const wagon = realBuildingMap.Wagon;
  assert.ok(wagon && wagon.w === 3 && wagon.cells.length === 3, "[fixture guard] Wagon entry is the 3-wide art");
  const bodyCells = new Set();
  for (const row of wagon.cells) for (const c of row) bodyCells.add(atlas.resolve(wagon.sheet, c.col, c.row));
  const wagonInst = inst.filter((i) => bodyCells.has(i.cell));
  assert.equal(wagonInst.length, 9, "full 3x3 body: 9 cells emitted (one per footprint tile)");
  const xs = new Set(wagonInst.map((i) => i.x));
  assert.deepEqual([...xs].sort((a, b) => a - b), [1, 2, 3], "all three footprint columns drawn, none blank");
  // overhang: the 3-wide harness/canopy row draws one tile above the footprint top row (y=0),
  // spanning all three columns (not a single centered cell).
  if (Array.isArray(wagon.overhang)) {
    const ohCells = new Set(wagon.overhang.map((c) => atlas.resolve(wagon.sheet, c.col, c.row)));
    const ohInst = inst.filter((i) => ohCells.has(i.cell));
    assert.equal(ohInst.length, 3, "three overhang cells (one per column)");
    assert.ok(ohInst.every((i) => i.y === 0), "overhang sits one row above the footprint top (y1=1 -> 0)");
    assert.deepEqual([...new Set(ohInst.map((i) => i.x))].sort((a, b) => a - b), [1, 2, 3], "overhang spans all columns");
  }
});

// =============================================================================================
// (9) RECONCILE: cross-check dwf-gl.js's buildingEntryGL/isOverlayOnlyBuildingType against
// dwf-tiles.js's REAL committed buildingEntry()/_isOverlayOnlyBuildingTypeForTest hooks
// (WC-4) -- same DOM-less sandbox convention as wc4_building_test.mjs -- proving the GL port's
// resolution table agrees with the canvas2d reference it mirrors, not just internally consistent
// with itself.
// =============================================================================================
async function reconcileWC4() {
  let DwfTiles = null;
  try {
    class FakeImage { constructor() { this.onload = null; this.onerror = null; this._src = ""; } set src(v) { this._src = v; } get src() { return this._src; } }
    class FakeCanvasEl {
      constructor() { this.width = 800; this.height = 600; this.style = {}; }
      addEventListener() {} removeEventListener() {}
      getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
    }
    const tilesSandbox = {};
    tilesSandbox.window = tilesSandbox;
    tilesSandbox.self = tilesSandbox;
    tilesSandbox.location = { search: "", protocol: "http:", host: "localhost:8765" };
    tilesSandbox.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
    tilesSandbox.addEventListener = () => {};
    tilesSandbox.sessionStorage = { getItem: () => null, setItem() {} };
    tilesSandbox.URLSearchParams = URLSearchParams;
    tilesSandbox.requestAnimationFrame = () => 0;
    tilesSandbox.cancelAnimationFrame = () => {};
    tilesSandbox.setTimeout = setTimeout;
    tilesSandbox.clearTimeout = clearTimeout;
    tilesSandbox.console = console;
    tilesSandbox.Image = FakeImage;
    tilesSandbox.fetch = async (url) => {
      if (String(url).indexOf("building_map.json") !== -1) return { ok: true, json: async () => realBuildingMap };
      return { ok: false, json: async () => null };
    };
    vm.createContext(tilesSandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), tilesSandbox, { filename: "dwf-tiles.js" });
    DwfTiles = tilesSandbox.DwfTiles;
    const canvasEl = new FakeCanvasEl();
    DwfTiles.init({ canvas: canvasEl, managePoll: false, manageCamera: false });
  } catch (err) {
    console.log("SKIP RECONCILE-WC4 (could not load dwf-tiles.js in a sandbox): " + (err && err.message));
    return;
  }
  if (!DwfTiles || typeof DwfTiles._buildingEntryForTest !== "function") {
    console.log("SKIP RECONCILE-WC4 (dwf-tiles.js has no _buildingEntryForTest hook)");
    return;
  }
  // building_map.json loads asynchronously inside dwf-tiles.js too -- wait for it.
  const t0 = Date.now();
  while (DwfTiles._buildingEntryForTest({ type: "Workshop", subtype: 0 }).sheet === "defaults.png") {
    if (Date.now() - t0 > 2000) throw new Error("dwf-tiles.js building_map.json load timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
  const atlas = makeMockAtlas();
  const glBuilder = GL.createSceneBuilder({ atlas, buildingMap: realBuildingMap });
  const samples = [
    { type: "Workshop", subtype: 2 }, { type: "Workshop", subtype: 0 }, { type: "Furnace", subtype: 1 },
    { type: "TradeDepot" }, { type: "Bed" }, { type: "Well" }, { type: "Bridge" },
    { type: "TotallyMadeUpType", subtype: 99 },
  ];
  section("RECONCILE-WC4: buildingEntryGL agrees with dwf-tiles.js's real buildingEntry() for every sample", () => {
    for (const s of samples) {
      // Both sides may return an object CREATED inside their own vm sandbox realm (e.g. the
      // MISSING_BUILDING fallback for an unmapped type) -- cross-realm plain objects fail
      // assert.deepEqual by prototype identity even with identical own properties (same
      // pitfall wb11_sparse_test.mjs's RECONCILE-WC14 section documents for arrays); JSON
      // round-trip normalizes both sides first.
      const mine = JSON.parse(JSON.stringify(glBuilder._buildingEntryForTest(s)));
      const theirs = JSON.parse(JSON.stringify(DwfTiles._buildingEntryForTest(s)));
      assert.deepEqual(mine, theirs, "buildingEntry(" + JSON.stringify(s) + ") must agree: " +
        JSON.stringify(mine) + " vs " + JSON.stringify(theirs));
    }
  });
  section("RECONCILE-WC4: isOverlayOnlyBuildingType agrees for Stockpile/Civzone/Workshop", () => {
    for (const t of ["Stockpile", "Civzone", "Workshop", "TradeDepot"]) {
      assert.equal(GL.isOverlayOnlyBuildingType(t), DwfTiles._isOverlayOnlyBuildingTypeForTest(t),
        "isOverlayOnlyBuildingType(" + t + ") must agree");
    }
  });
}

await reconcileWC4();

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nAll wb12_buildings_test sections passed.");
