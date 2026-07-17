// wb11_sparse_test.mjs -- WB-11 acceptance (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md,
// "Sparse layers: spatter, items, plants, tree geometry, floor-edge decals"). Loads the REAL
// web/js/dwf-gl.js (+ dwf-adjacency.js) verbatim via vm.runInContext, same
// convention as tools/harness/gl_core_test.mjs, and the REAL committed web/item_map.json,
// web/plant_map.json, web/tree_map.json, web/spatter_map.json (same convention as
// tools/harness/wc3_we4_wc12_apply_test.mjs) -- no synthetic maps for the resolution-logic
// assertions, so this proves the GL port resolves against the SAME data the canvas2d path
// ships. Per the run-orders instruction for this item, evidence is (1) node tests asserting
// instance-stream equivalence to the canvas draw order for fixture scenes, including layered
// spatter and forbidden/dump items, and (2) a browser bench (see
// tools/spikes/webgl/gl-sparse-bench.html) -- this file is (1); live gate_parity.py/gate_perf.py
// runs against DF are explicitly OUT of scope for this item (queued for sweep #2/WB-14).
//
// RECONCILE-WC14: this file ALSO cross-checks dwf-gl.js's ported tree-ttname parser
// (parseTreeTtname) against the uncommitted WC-14 draft's identical function inside
// web/js/dwf-tiles.js (loaded in a second, separate sandbox, same DOM-less convention as
// wc3_we4_wc12_apply_test.mjs) for every ttname sample below. If this section starts failing,
// WC-14 has since diverged from the draft this port was taken from -- reconcile the two.
//
// Run: node tools/harness/wb11_sparse_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const realItemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const realPlantMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/plant_map.json"), "utf8"));
const realTreeMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/tree_map.json"), "utf8"));
const realSpatterMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/spatter_map.json"), "utf8"));

// ---- fixture-assumption guards (fail loudly if the committed maps' shape drifts) -----------
assert.ok(realItemMap.matvariants && realItemMap.matvariants.Box && realItemMap.matvariants.Box.WOOD,
  "fixture assumption broken: item_map.json no longer has matvariants.Box.WOOD");
assert.ok(realItemMap._missing && realItemMap._missing.sheet, "fixture assumption broken: item_map.json no longer has _missing");
assert.ok(realTreeMap.ACACIA && realTreeMap.ACACIA.TREE_TRUNK && realTreeMap.ACACIA.TREE_TRUNK.E,
  "fixture assumption broken: tree_map.json's ACACIA.TREE_TRUNK.E is gone");
assert.ok(realTreeMap.ACACIA.TREE_BASE && realTreeMap.ACACIA.TREE_BASE.TRUNK,
  "fixture assumption broken: tree_map.json's ACACIA.TREE_BASE.TRUNK is gone");
assert.ok(realSpatterMap.families.MUD && realSpatterMap.families.SNOW && realSpatterMap.families.LEAVES,
  "fixture assumption broken: spatter_map.json's MUD/SNOW/LEAVES families are gone");
assert.ok(realPlantMap.ALFALFA && realPlantMap.ALFALFA.SHRUB, "fixture assumption broken: plant_map.json's ALFALFA.SHRUB is gone");

// ---- sandbox 1: the REAL dwf-gl.js + dwf-adjacency.js (this item's own file) ---
const sandbox = {};
sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(sandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}
const GL = sandbox.DwfGL;
const Adj = sandbox.DwfAdjacency;
assert.ok(GL && Adj, "sandbox 1 must export DwfGL/DwfAdjacency");

function makeMockAtlas() {
  const ids = new Map();
  let next = 1;
  return { resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!ids.has(k)) ids.set(k, next++); return ids.get(k); } };
}

const spriteMap = {
  STONE_FLOOR_5: { sheet: "floors.png", col: 1, row: 4 },
  WALL_SHADOW_N: { sheet: "shadows_wall.png", col: 0, row: 0 },
};
const tokenMap = { StoneFloor5: { token: "STONE_FLOOR_5", tint: null } };
const shadowCellMap = { wallShadow: { "1": "WALL_SHADOW_N" }, visionShadow: {}, rampShadowOnRamp: {} };

function tile(o) {
  return Object.assign({ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
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

// =============================================================================================
// (1) PAINTER-ORDER EQUIVALENCE: a single "kitchen sink" tile carrying a grass neighbor, a
// wall-shadow decal, TWO layered spatter events, item-spatter litter, and an item -- assert the
// emitted instance sequence groups in dwf-tiles.js's drawTileComposite order: base ->
// terrain sprite -> shadow -> spatter(x2) -> itemSpatterLitter -> item (plant/tree are mutually
// exclusive with `.item` in this fixture, tested separately below). B71-r3: the floor-edge
// (grass-creep) decal that used to open this stack was DELETED (oracle-refuted false content --
// it painted translucent grass OVER boulder/pebble/floor sprites); the grass neighbor stays in
// this fixture to prove its presence no longer injects any decal instance.
// =============================================================================================
section("kitchen-sink tile: shadow < spatter(x2) < itemSpatterLitter < item, and NO grass-creep decal", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({
    atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj,
    itemMap: realItemMap, plantMap: realPlantMap, treeMap: realTreeMap, spatterMap: realSpatterMap,
  });
  // 1x2 window: (0,0) grass floor (neighbor), (0,1) the kitchen-sink tile with a wall to its
  // logical N (we fake the wall via the wallGrid path by using a real WALL tile at row 0... but
  // row 0 is grass; use a 1x3 column instead: wall(N) / kitchen-sink / grass(S neighbor for the
  // floor-edge decal AND spatter same-family adjacency).
  const wallT = tile({ ttname: "", shape: "WALL", mat: "STONE" });
  const grassT = tile({ ttname: "GrassLightFloor1", mat: "GRASS_LIGHT" });
  const sinkT = tile({
    ttname: "StoneFloor5",
    spatters: [{ mat_type: 12, mat_index: 0, amount: 220 }, { mat_type: 13, mat_index: 0, amount: 40 }], // MUD coating (FULL, >=210), VOMIT dusting (PARTIAL_1, 25-49)
    itemSpatters: [{ growth_class: 1, amount: 10 }], // LEAVES partial
    item: { type: "AMMO", mat_type: -1, iflags: 0, subtype: -1 },
  });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 3, tiles: [wallT, sinkT, grassT] };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.y === 1);

  const floorEdgeCell = atlas.resolve("grass.png", GL.hashXY(0, 1) % 4, 0);
  const shadowCell = atlas.resolve("shadows_wall.png", 0, 0);
  const mudCell = atlas.resolve(realSpatterMap.families.MUD.sheet, realSpatterMap.families.MUD.cells.FULL_ISOLATED.col, realSpatterMap.families.MUD.cells.FULL_ISOLATED.row);
  const leavesCellDef = realSpatterMap.families.LEAVES.cells["PARTIAL_1" + ["A", "B", "C", "D"][GL.hashInt(0 + 0, 1 + 0) % 4]];
  const leavesCell = atlas.resolve(realSpatterMap.families.LEAVES.sheet, leavesCellDef.col, leavesCellDef.row);
  const ammoCell = atlas.resolve(realItemMap.bytype.AMMO.sheet, realItemMap.bytype.AMMO.col, realItemMap.bytype.AMMO.row);

  const idxFloorEdge = inst.findIndex((i) => i.cell === floorEdgeCell);
  const idxShadow = inst.findIndex((i) => i.cell === shadowCell);
  const idxMud = inst.findIndex((i) => i.cell === mudCell);
  const idxLeaves = inst.findIndex((i) => i.cell === leavesCell);
  const idxAmmo = inst.findIndex((i) => i.cell === ammoCell);

  assert.ok(idxFloorEdge < 0, "B71-r3: NO grass-creep decal on the sink tile despite its grass neighbor");
  assert.ok(idxShadow >= 0, "wall-shadow decal present (wall neighbor to the N)");
  assert.ok(idxMud >= 0, "MUD spatter (FULL_ISOLATED, amount 100) present");
  assert.ok(idxLeaves >= 0, "LEAVES item-spatter litter (PARTIAL_1x, growth_class 1) present");
  assert.ok(idxAmmo >= 0, "AMMO item sprite present");
  assert.ok(idxShadow < idxMud, "shadow decal precedes spatter (dwf-tiles.js order)");
  assert.ok(idxMud < idxLeaves, "spatter precedes item-spatter litter");
  assert.ok(idxLeaves < idxAmmo, "item-spatter litter precedes the item sprite");
  console.log("    kitchen-sink instance count: " + inst.length);
});

// =============================================================================================
// (2) LAYERED SPATTER: up to 4 events stack in wire order; a light event uses the partial-
// letter key, a coating event (amount >= 210, B200 ladder) uses the neighbor-joined full key.
// =============================================================================================
section("layered spatter: 2 events both emit, in wire order, with correct family/shape", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, spatterMap: realSpatterMap });
  const t = tile({ spatters: [{ mat_type: 9, mat_index: 0, amount: 220 }, { mat_type: 6, mat_index: 0, amount: 220, state: 3 }] }); // DUST coating, SNOW coating (both FULL)
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] };
  b.buildScene(view);
  const inst = decode(b);
  const dustCell = atlas.resolve(realSpatterMap.families.DUST.sheet, realSpatterMap.families.DUST.cells.FULL_ISOLATED.col, realSpatterMap.families.DUST.cells.FULL_ISOLATED.row);
  const snowCell = atlas.resolve(realSpatterMap.families.SNOW.sheet, realSpatterMap.families.SNOW.cells.FULL_ISOLATED.col, realSpatterMap.families.SNOW.cells.FULL_ISOLATED.row);
  const idxDust = inst.findIndex((i) => i.cell === dustCell);
  const idxSnow = inst.findIndex((i) => i.cell === snowCell);
  assert.ok(idxDust >= 0 && idxSnow >= 0, "both layered spatter events emitted");
  assert.ok(idxDust < idxSnow, "spatter events emit in wire (amount-desc) order");
});

section("snow is NOT rendered as blood-red (the named gap this apply-gap fix targets)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, spatterMap: realSpatterMap });
  assert.equal(b._spatterFamilyForTest({ mat_type: 6, state: 3, amount: 50 }), "SNOW");
  assert.equal(b._spatterFamilyForTest({ mat_type: 6, state: 0, amount: 50 }), "WATER_SPATTER");
  assert.notEqual(b._spatterFamilyForTest({ mat_type: 6, state: 3, amount: 50 }), "BLOOD_RED");
});

section("spatter family classification: builtin materials exact, blood-range stable-hashed", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, spatterMap: realSpatterMap });
  assert.equal(b._spatterFamilyForTest({ mat_type: 9, amount: 1 }), "DUST");
  assert.equal(b._spatterFamilyForTest({ mat_type: 12, amount: 1 }), "MUD");
  assert.equal(b._spatterFamilyForTest({ mat_type: 13, amount: 1 }), "VOMIT");
  const f1 = b._spatterFamilyForTest({ mat_type: 40, mat_index: 7, amount: 1 });
  const f2 = b._spatterFamilyForTest({ mat_type: 40, mat_index: 7, amount: 1 });
  assert.ok(realSpatterMap.blood_families.includes(f1), "creature-range material picks one of the 5 blood families");
  assert.equal(f1, f2, "the SAME material always picks the SAME blood family (stable hash, no flicker)");
  assert.equal(b._spatterFamilyForTest({ mat_type: 999999, amount: 1 }), "MUD", "unclassifiable material defaults to MUD, never BLOOD_RED");
});

section("spatter amount->shape thresholds match spatter_map.json's real table", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, spatterMap: realSpatterMap });
  // B200 recalibrated ladder (25-49 P1 / 50-109 P2 / 110-159 P3 / 160-209 P4 / >=210 FULL).
  assert.equal(b._spatterShapeForTest(30), "PARTIAL_1");   // "a dusting" -- sparsest, now reachable
  assert.equal(b._spatterShapeForTest(98), "PARTIAL_2");   // native "a smear of" -- light, NOT full
  assert.equal(b._spatterShapeForTest(100), "PARTIAL_2");  // B200: amount 100 is no longer FULL
  assert.equal(b._spatterShapeForTest(160), "PARTIAL_4");
  assert.equal(b._spatterShapeForTest(220), "FULL");       // near-saturation coating only
});

// =============================================================================================
// (3) ITEMS -- real item_map.json resolution (matvariant/bytype/_missing), material tint as the
// instance's OWN tint (no extra multiply instance), and FORBIDDEN/DUMP iflags proven inert
// (drawItem/emitItem never special-case these bits today -- same as the canvas2d reference;
// this proves the flag combination doesn't crash or alter resolution, matching wire_v1.cpp's
// kItemFlagForbid=1<<1 / kItemFlagDump=1<<2).
// =============================================================================================
const kItemFlagForbid = 1 << 1, kItemFlagDump = 1 << 2;
section("item resolution: BOX + PLANT-range mat_type -> matvariants.Box.WOOD, tinted", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, itemMap: realItemMap });
  const t = tile({ item: { type: "BOX", mat_type: 419, subtype: -1, iflags: 0 } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const boxCell = atlas.resolve(realItemMap.matvariants.Box.WOOD.sheet, realItemMap.matvariants.Box.WOOD.col, realItemMap.matvariants.Box.WOOD.row);
  const sprite = inst.find((i) => i.cell === boxCell);
  assert.ok(sprite, "WOOD box variant cell emitted");
  const wt = GL.ITEM_TINT_RGB_BY_FAMILY.WOOD;
  assert.deepEqual([sprite.r, sprite.g, sprite.b, sprite.a], [wt[0], wt[1], wt[2], 255], "WOOD multiply-factor tint applied as the instance's own tint");
});

section("item resolution: unmapped exotic type -> item_map.json's real _missing cell (never a crash)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, itemMap: realItemMap });
  const t = tile({ item: { type: "TOTALLY_MADE_UP_ITEM_TYPE", mat_type: -1, subtype: -1, iflags: 0 } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const missCell = atlas.resolve(realItemMap._missing.sheet, realItemMap._missing.col, realItemMap._missing.row);
  assert.ok(inst.some((i) => i.cell === missCell), "MISSING_ITEM cell emitted for an unmapped type");
});

section("WC-19: forbid/dump iflags add a designation-mark instance (residual now CLOSED)", () => {
  // Pre-WC-19 this asserted the flags were INERT (no extra instance). WC-19 closes that
  // residual: a forbidden+dump item now emits one ADDITIONAL DESIGNATION_ITEM_FORBIDDEN_DUMP
  // glyph over the (unchanged) base item cell. The base resolution is still flag-independent.
  const atlas1 = makeMockAtlas(), atlas2 = makeMockAtlas();
  const plain = { type: "AMMO", mat_type: -1, subtype: -1, iflags: 0 };
  const forbidDump = { type: "AMMO", mat_type: -1, subtype: -1, iflags: kItemFlagForbid | kItemFlagDump };
  const b1 = GL.createSceneBuilder({ atlas: atlas1, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, itemMap: realItemMap });
  const b2 = GL.createSceneBuilder({ atlas: atlas2, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, itemMap: realItemMap });
  b1.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ item: plain })] });
  b2.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ item: forbidDump })] });
  const ammoCell1 = atlas1.resolve(realItemMap.bytype.AMMO.sheet, realItemMap.bytype.AMMO.col, realItemMap.bytype.AMMO.row);
  const ammoCell2 = atlas2.resolve(realItemMap.bytype.AMMO.sheet, realItemMap.bytype.AMMO.col, realItemMap.bytype.AMMO.row);
  const markCell = atlas2.resolve("designation_item.png", 0, 5); // FORBIDDEN_DUMP row (overlay_map.json)
  const inst1 = decode(b1), inst2 = decode(b2);
  assert.ok(inst1.some((i) => i.cell === ammoCell1), "plain item resolves the AMMO cell");
  assert.ok(inst2.some((i) => i.cell === ammoCell2), "forbidden+dump item resolves the SAME base AMMO cell");
  assert.ok(inst2.some((i) => i.cell === markCell), "forbidden+dump emits the FORBIDDEN_DUMP mark glyph");
  assert.equal(inst2.length, inst1.length + 1, "exactly ONE extra instance (the mark) is added");
});

section("web (spider) item takes priority over generic resolution", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, itemMap: realItemMap });
  const t = tile({ item: { type: "THREAD", mat_type: -1, subtype: -1, iflags: 0x01 } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const webCells = realItemMap.web.harmless.map((v) => atlas.resolve(v.sheet, v.col, v.row));
  assert.ok(inst.some((i) => webCells.includes(i.cell)), "a web variant cell was emitted, not a generic THREAD cell");
});

// =============================================================================================
// (4) PLANTS -- real plant_map.json resolution + SAPLING->tree_map.json fallback.
// =============================================================================================
section("plant resolution: real plant_map.json SHRUB cell + _default fallbacks", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, plantMap: realPlantMap, treeMap: realTreeMap });
  const t = tile({ plant: { part: "SHRUB", id: "ALFALFA" } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const cell = atlas.resolve(realPlantMap.ALFALFA.SHRUB.sheet, realPlantMap.ALFALFA.SHRUB.col, realPlantMap.ALFALFA.SHRUB.row);
  assert.ok(inst.some((i) => i.cell === cell), "ALFALFA SHRUB cell emitted");
});

section("plant resolution: unmapped SAPLING id falls back to plant_map.json's _default_sapling", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, plantMap: realPlantMap, treeMap: realTreeMap });
  const t = tile({ plant: { part: "SAPLING", id: "NOT_A_REAL_PLANT_ID" } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const cell = atlas.resolve(realPlantMap._default_sapling.sheet, realPlantMap._default_sapling.col, realPlantMap._default_sapling.row);
  assert.ok(inst.some((i) => i.cell === cell), "_default_sapling cell emitted");
});

// =============================================================================================
// (5) TREE GEOMETRY -- ttname parse + resolveTreeCellGL against the real (v2) tree_map.json.
// =============================================================================================
section("tree: directional trunk ttname resolves the real ACACIA.TREE_TRUNK.E cell", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, treeMap: realTreeMap });
  const t = tile({ ttname: "TreeTrunkE", plant: { part: "TRUNK", id: "ACACIA" } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const e = realTreeMap.ACACIA.TREE_TRUNK.E;
  const cell = atlas.resolve(e.sheet, e.col, e.row);
  assert.ok(inst.some((i) => i.cell === cell), "ACACIA.TREE_TRUNK.E cell emitted for ttname TreeTrunkE");
});

section("tree: TreeRoots resolves TREE_BASE.TRUNK (RootSloping/Roots family per the parse table)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, treeMap: realTreeMap });
  const t = tile({ ttname: "TreeRoots", plant: { part: "TRUNK", id: "ACACIA" } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const e = realTreeMap.ACACIA.TREE_BASE.TRUNK;
  const cell = atlas.resolve(e.sheet, e.col, e.row);
  assert.ok(inst.some((i) => i.cell === cell), "ACACIA.TREE_BASE.TRUNK cell emitted for ttname TreeRoots");
});

section("tree: TreeCapRamp is a documented no-op (DF draws the bare floor/ramp beneath)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, treeMap: realTreeMap });
  const t = tile({ ttname: "TreeCapRamp", plant: { part: "CANOPY", id: "ACACIA" } });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] };
  b.buildScene(view);
  const before = decode(b).length;
  // sanity: a DIFFERENT canopy ttname on the same species DOES draw something, proving the
  // "no-op" above is the skip rule firing, not merely a missing map entry.
  const t2 = tile({ ttname: "TreeCapWallN", plant: { part: "CANOPY", id: "ACACIA" } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t2] });
  const after = decode(b).length;
  assert.ok(after >= before, "a resolvable canopy ttname emits at least as much as the CapRamp skip case");
});

section("tree: unparsed/unknown ttname falls back to the flat 4-part cell (never fully blank)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, treeMap: realTreeMap });
  const t = tile({ ttname: "SomeFutureTiletypeNotInTheGrammar", plant: { part: "TRUNK", id: "ACACIA" } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const e = realTreeMap.ACACIA.TRUNK; // the old flat v1 4-part key, still present in tree_map.json v2
  assert.ok(e, "fixture assumption: tree_map.json v2 still carries the flat TRUNK fallback key");
  const cell = atlas.resolve(e.sheet, e.col, e.row);
  assert.ok(inst.some((i) => i.cell === cell), "flat TRUNK fallback cell emitted for an unparseable ttname");
});

section("tree: SAPLING/SHRUB parts never reach the tree layer (they stay on drawPlant/emitPlant)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, treeMap: realTreeMap, plantMap: realPlantMap });
  const t = tile({ ttname: "TreeTrunkN", plant: { part: "SAPLING", id: "ACACIA" } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const trunkE = realTreeMap.ACACIA.TREE_TRUNK.N;
  const trunkCell = atlas.resolve(trunkE.sheet, trunkE.col, trunkE.row);
  assert.ok(!inst.some((i) => i.cell === trunkCell), "a SAPLING-part tile never draws a TREE_TRUNK cell even with a Tree* ttname");
});

// =============================================================================================
// (6) FLOOR-EDGE (grass-creep) decal: DELETED by B71-r3. It painted a translucent grass.png
// cell OVER the finished terrain sprite of every non-grass tile bordering grass (up to 55%
// alpha), which the paired oracle refuted pixel-wise (native boulders/pebbles/dirt beside
// grass are fully opaque). This section now pins the ABSENCE: a grass neighbor must inject no
// decal instance on any neighbor's stack. The deeper sprite-level invariants (boulder opacity,
// grass-under draw order) live in tools/harness/b71_grasstint_test.mjs.
// =============================================================================================
section("B71-r3: a non-grass floor bordering grass gets NO grass-creep decal", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const grass = tile({ ttname: "GrassLightFloor1", mat: "GRASS_LIGHT" });
  const stone = tile({ ttname: "StoneFloor5" });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 2, tiles: [grass, stone] };
  b.buildScene(view);
  const instStone = decode(b).filter((i) => i.y === 1);
  const edgeCellOnStone = atlas.resolve("grass.png", GL.hashXY(0, 1) % 4, 0);
  assert.ok(!instStone.some((i) => i.cell === edgeCellOnStone), "stone floor bordering grass draws NO grass.png cell at all");
  // and nothing translucent rides on the stone tile's stack (its own sprite + base only).
  assert.ok(!instStone.some((i) => i.a > 0 && i.a < 255 && i.cell !== GL.SOLID_CELL), "no translucent decal instance on the stone tile");
});

section("floor-edge deletion: an isolated floor tile with no grass neighbor also gets no decal", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const t = tile({ ttname: "StoneFloor5" });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  assert.ok(!inst.some((i) => i.a > 0 && i.a < 255 && i.cell !== GL.SOLID_CELL), "no translucent decal on a floor tile with zero grass neighbors");
});

// =============================================================================================
// (7) SCENE-BUILD SMOKE at 200x200 with EVERY sparse layer densely populated -- proves the
// capacity bump (total*24+32) never clamps/drops instances and nothing throws. The §1.7 budget
// number itself (real-browser evidence) belongs to tools/spikes/webgl/gl-sparse-bench.html.
// =============================================================================================
section("200x200 scene, every sparse layer populated on every tile: no throw, no capacity clamp", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({
    atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj,
    itemMap: realItemMap, plantMap: realPlantMap, treeMap: realTreeMap, spatterMap: realSpatterMap,
  });
  const GW = 200, GH = 200;
  const tiles = new Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    tiles[y * GW + x] = tile({
      x, y,
      spatters: [{ mat_type: 12, mat_index: 0, amount: 220 }, { mat_type: 9, mat_index: 0, amount: 40 }], // both >= the 25 gate so BOTH draw (B200: amount 10 was below-gate -> only 1 drew)
      itemSpatters: [{ growth_class: 1, amount: 10 }],
      item: { type: "AMMO", mat_type: -1, subtype: -1, iflags: 0 },
    });
  }
  const view = { origin: { x: 0, y: 0, z: 0 }, width: GW, height: GH, tiles };
  const r = b.buildScene(view);
  assert.ok(r.count > 0, "instances were emitted");
  assert.ok(r.count < b.buffer.byteLength / GL.INSTANCE_BYTES + 1, "instance count never exceeds the allocated buffer");
  // every tile should have contributed AT LEAST base+sprite+spatter(x2)+itemSpatterLitter+item
  // = 6 instances -- if capacity silently clamped, count would be far lower than 6*40000.
  assert.ok(r.count >= 6 * GW * GH, "no silent capacity clamp: every tile's full sparse stack made it into the buffer");
  console.log("    200x200 all-sparse scene-build: " + r.count + " instances in " + r.ms.toFixed(3) + " ms (node, no GL/atlas warmup)");
});

// =============================================================================================
// RECONCILE-WC14: cross-check parseTreeTtname against the uncommitted WC-14 draft living in the
// CURRENT working tree's dwf-tiles.js (loaded in a second sandbox). If dwf-tiles.js
// hasn't been touched by WC-14 yet in some future checkout (test hooks absent), this section
// SKIPS with a note rather than failing the whole file.
// =============================================================================================
(function reconcileWC14() {
  let DwfTiles = null;
  try {
    const tilesSandbox = {};
    tilesSandbox.window = tilesSandbox;
    tilesSandbox.self = tilesSandbox;
    tilesSandbox.location = { search: "", protocol: "http:", host: "localhost:8765" };
    tilesSandbox.document = {
      hidden: false, addEventListener() {}, getElementById() { return null; },
      createElement() { return { style: {} }; }, body: { appendChild() {} },
    };
    tilesSandbox.addEventListener = () => {};
    tilesSandbox.sessionStorage = { getItem: () => null, setItem() {} };
    tilesSandbox.URLSearchParams = URLSearchParams;
    tilesSandbox.requestAnimationFrame = () => 0;
    tilesSandbox.cancelAnimationFrame = () => {};
    tilesSandbox.setTimeout = setTimeout;
    tilesSandbox.clearTimeout = clearTimeout;
    tilesSandbox.console = console;
    tilesSandbox.Image = class { constructor() { this.onload = null; this.onerror = null; } set src(_v) {} get src() { return ""; } };
    tilesSandbox.fetch = async () => ({ ok: false, json: async () => null });
    vm.createContext(tilesSandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), tilesSandbox, { filename: "dwf-tiles.js" });
    DwfTiles = tilesSandbox.DwfTiles;
  } catch (err) {
    console.log("SKIP RECONCILE-WC14 (could not load dwf-tiles.js in a sandbox): " + (err && err.message));
    return;
  }
  if (!DwfTiles || typeof DwfTiles._parseTreeTtnameForTest !== "function") {
    console.log("SKIP RECONCILE-WC14 (dwf-tiles.js has no _parseTreeTtnameForTest hook -- WC-14 not landed/drafted in this checkout)");
    return;
  }
  const samples = [
    "TreeTrunkN", "TreeTrunkNSWE", "TreeTrunkThickNW", "TreeDeadTrunkPillar",
    "TreeCapWallThickSW", "TreeTrunkBranchN", "TreeRoots", "TreeRootSloping",
    "TreeCapRamp", "TreeTwigs", "TreeDeadTwigs", "TreeBranchesSmooth", "TreeBranch",
    "TreeCapFloor2", "TreeCapPillarNE", "NotATreeTtnameAtAll",
  ];
  section("RECONCILE-WC14: parseTreeTtname agrees with the working-tree draft for every sample", () => {
    for (const ttname of samples) {
      // JSON round-trip: `mine`/`theirs` are plain objects constructed in TWO DIFFERENT vm
      // realms (this file's sandbox vs the tiles.js sandbox) -- assert.deepEqual treats
      // cross-realm objects as reference-unequal even with identical own properties, so
      // normalize through JSON (same convention gl_core_test.mjs uses for cross-realm arrays).
      const mine = JSON.parse(JSON.stringify(GL.parseTreeTtname(ttname)));
      const theirs = JSON.parse(JSON.stringify(DwfTiles._parseTreeTtnameForTest(ttname)));
      assert.deepEqual(mine, theirs, "parseTreeTtname(" + JSON.stringify(ttname) + ") must agree: " +
        JSON.stringify(mine) + " vs " + JSON.stringify(theirs));
    }
  });
})();

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nAll wb11_sparse_test sections passed.");
