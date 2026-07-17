// gl_core_test.mjs -- WB-9 acceptance (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md,
// "GL core: instanced pipeline + scene-build + dense terrain"). Loads the REAL web/js/
// dwf-gl.js + dwf-adjacency.js verbatim (vm.runInThisContext, same convention as
// gl_atlas_test.mjs / cache_test.mjs) and exercises the PURE scene-build core with an injected
// mock atlas -- no DOM/GL. Asserts the cache->instance conversion mirrors dwf-tiles.js's
// drawTileComposite (the pixel reference): painter order (base fill before sprite), the
// solid-cell base fill, terrain sprite resolution (ttname->token->cell), hidden-rock cells,
// liquids-over-bed, grass recolour as a stacked overlay, wall joins, and the SOLID_CELL/tint
// encoding the shader consumes.
//
// Run: node tools/harness/gl_core_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const realItemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const sandbox = {};
sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(sandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js", "web/js/dwf-gl-atlas.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}
const GL = sandbox.DwfGL;
const Adj = sandbox.DwfAdjacency;
const RealAtlas = sandbox.DwfGLAtlas;
assert.ok(GL, "DwfGL must export onto the sandbox global");
assert.ok(Adj, "DwfAdjacency must export onto the sandbox global");
assert.ok(RealAtlas, "DwfGLAtlas must export onto the sandbox global");
assert.equal(GL.SOLID_CELL, 0xFFFF);
assert.equal(GL.INSTANCE_BYTES, 16);
assert.ok(realItemMap.bytype && realItemMap.bytype.AMMO && realItemMap.bytype.AMMO.sheet,
  "fixture assumption broken: item_map.json no longer has a drawable AMMO bytype cell");

// ---- mock atlas: assign a stable positive cell id per (sheet,col,row) --------------------
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

// ---- fixtures ----------------------------------------------------------------------------
const spriteMap = {
  STONE_FLOOR_5: { sheet: "floors.png", col: 1, row: 4 },
  PEBBLES_FLOOR_2: { sheet: "floor_pebbles.png", col: 6, row: 0 },
  PEBBLES_FLOOR_5: { sheet: "floor_pebbles.png", col: 0, row: 0 },
  STONE_WALL_N_S_1: { sheet: "wall_stone.png", col: 0, row: 9 },
  HIDDEN_ROCK_1: { sheet: "hidden_rock.png", col: 0, row: 0 },
  HIDDEN_ROCK_2: { sheet: "hidden_rock.png", col: 1, row: 0 },
  HIDDEN_ROCK_3: { sheet: "hidden_rock.png", col: 2, row: 0 },
  HIDDEN_ROCK_4: { sheet: "hidden_rock.png", col: 3, row: 0 },
  HIDDEN_ROCK_5: { sheet: "hidden_rock.png", col: 4, row: 0 },
  WALL_SHADOW_N: { sheet: "shadows_wall.png", col: 0, row: 0 },
  // WC-18 engraving tokens (environment-dir, resolve through tokenCell/the atlas like any
  // other spriteMap token).
  ENGRAVED_STONE_WALL_N: { sheet: "wall_stone_engraved.png", col: 0, row: 3 },
  ENGRAVED_STONE_WALL_N_S: { sheet: "wall_stone_engraved.png", col: 0, row: 5 },
  FLOOR_STONE_ENGRAVED_NON_PALETTE: { sheet: "floor_stone_engraved.png", col: 0, row: 0 },
};
const tokenMap = {
  StoneFloor5: { token: "STONE_FLOOR_5", tint: null },
  GrassLightFloor1: { token: "GRASS_1", tint: "grassSummer" },
  StonePebbles2: { token: "PEBBLES_FLOOR_5", tint: null },
};
const shadowCellMap = { wallShadow: { "1": "WALL_SHADOW_N" }, visionShadow: {}, rampShadowOnRamp: {} };

function tile(o) {
  return Object.assign({ tt: 1, ttname: "", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
}

// decode a built buffer into instance records for assertions
function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      x: f32[k * 4], y: f32[k * 4 + 1],
      cell: u16[k * 8 + 4], attr: u16[k * 8 + 5],
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

section("floor: base solid fill THEN terrain sprite (painter order)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ ttname: "StoneFloor5" })] };
  b.buildScene(view);
  const inst = decode(b);
  assert.ok(inst.length >= 2, "at least base + sprite");
  assert.equal(inst[0].cell, GL.SOLID_CELL, "first instance is the base colour fill (solid cell)");
  assert.equal(inst[0].a, 255, "base fill is opaque");
  // STONE mat colour [130,122,110]
  assert.deepEqual([inst[0].r, inst[0].g, inst[0].b], [130, 122, 110], "base uses matRgb(STONE)");
  const spriteCell = atlas.resolve("floors.png", 1, 4);
  assert.equal(inst[1].cell, spriteCell, "second instance is the resolved STONE_FLOOR_5 cell");
  assert.deepEqual([inst[1].r, inst[1].g, inst[1].b, inst[1].a], [255, 255, 255, 255], "sprite tint = white");
});

section("grass: sprite THEN summer recolour overlay (source-over via premult alpha)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  // GRASS_1 override -> grass.png 0,0; tint "grassSummer"
  spriteMap.GRASS_1 = null; // ensure the TOKEN_CELL_OVERRIDE path is what resolves it
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ ttname: "GrassLightFloor1", mat: "GRASS_LIGHT" })] };
  b.buildScene(view);
  const inst = decode(b);
  // expect: base solid, grass sprite (grass.png via override), grass tint overlay
  const gCell = atlas.resolve("grass.png", 0, 0);
  const sprite = inst.find((i) => i.cell === gCell);
  assert.ok(sprite, "grass sprite instance present (grass.png override)");
  const tint = inst.find((i) => i.cell === GL.SOLID_CELL && i.r === 93 && i.g === 119 && i.b === 52);
  assert.ok(tint, "summer recolour overlay (93,119,52) present as a solid instance");
  assert.equal(tint.a, Math.round(0.25 * 255), "tint alpha = 0.25 (64)");
});

// =============================================================================================
// WC-17 GL grass, post-grass-escalation contract (2026-07-07, the "multicolor patchwork +
// phantom stone" escalation): the dgfix1-era amount->tier cell pick + per-species
// grass_colors.json tint were verified WRONG against DF's own render (tier order inverted vs
// the raws' graze-state order, thresholds assumed amount<=100 vs live 5..251, and DF premium
// graphics don't species-tint grass at all -- GRASS_COLORS is ASCII-mode data). The live
// contract is now: a grass-mat tile with coverage renders through the ordinary ttname->token
// path (GRASS_1..4 + the calibrated grassSummer wash), and ONLY the wire's amount<=0 "worn
// bare" signal changes rendering (flat floor colour). grassTierIndex/grassSpeciesTintRGBA
// remain exported as pure helpers (not applied to the live render until oracle-calibrated).
// =============================================================================================
const realGrassColorsPath = path.join(ROOT, "web/grass_colors.json");
const realGrassColors = JSON.parse(fs.readFileSync(realGrassColorsPath, "utf8"));
assert.ok(realGrassColors.plants && realGrassColors.plants["MEADOW-GRASS"],
  "fixture assumption broken: grass_colors.json no longer has MEADOW-GRASS");

section("WC-17 GL: amount -> tier index pure helper (exported, unused by the live render)", () => {
  assert.equal(GL.grassTierIndex(0), 0);
  assert.equal(GL.grassTierIndex(33), 0);
  assert.equal(GL.grassTierIndex(34), 1);
  assert.equal(GL.grassTierIndex(66), 1);
  assert.equal(GL.grassTierIndex(67), 2);
  assert.equal(GL.grassTierIndex(99), 2);
  assert.equal(GL.grassTierIndex(100), 3);
  assert.equal(GL.grassTierIndex(255), 3);
});

section("grass-escalation GL: t.grass with amount>0 renders the ttname path -- grass sprite + flat grassSummer wash, NO species tint", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, grassColors: realGrassColors });
  const view = {
    origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1,
    tiles: [tile({ ttname: "GrassLightFloor1", mat: "GRASS_LIGHT", grass: { id: "MEADOW-GRASS", amount: 100 } })],
  };
  b.buildScene(view);
  const inst = decode(b);
  // GrassLightFloor1 -> token GRASS_1 -> grass.png col 0 row 0, exactly as if no tail arrived.
  const gCell = atlas.resolve("grass.png", 0, 0);
  assert.ok(inst.some((i) => i.cell === gCell), "GRASS_1 grass.png cell emitted via the ttname path");
  const wash = inst.find((i) => i.cell === GL.SOLID_CELL && i.r === 93 && i.g === 119 && i.b === 52);
  assert.ok(wash, "the calibrated flat (93,119,52) grassSummer wash is applied");
  assert.equal(wash.a, Math.round(0.25 * 255), "wash alpha = 0.25");
  // The inverted-tier patchwork regression: the per-species graze-state colors must NOT appear.
  for (const tier of realGrassColors.plants["MEADOW-GRASS"].tiers) {
    const [r, g, bl] = tier.rgb;
    if (r === 93 && g === 119 && bl === 52) continue; // (none collide today, but be safe)
    assert.ok(!inst.some((i) => i.cell === GL.SOLID_CELL && i.r === r && i.g === g && i.b === bl),
      "no per-species graze-state tint (" + tier.rgb.join(",") + ") is emitted");
  }
});

section("grass-escalation GL: rendering is species-independent (SATINTAIL == MEADOW-GRASS == no tail)", () => {
  const atlas = makeMockAtlas();
  const build = (grass) => {
    const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, grassColors: realGrassColors });
    b.buildScene({
      origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1,
      tiles: [tile(Object.assign({ ttname: "GrassLightFloor1", mat: "GRASS_LIGHT" }, grass ? { grass } : {}))],
    });
    return JSON.stringify(decode(b));
  };
  const a = build({ id: "MEADOW-GRASS", amount: 100 });
  const c = build({ id: "SATINTAIL", amount: 45 });
  const d = build(null);
  assert.equal(a, c, "different species/amounts (>0) render identically");
  assert.equal(a, d, "a covered tile renders identically to a no-tail tile (pre-WC-17 look)");
});

section("grass-escalation GL stage 2: StonePebbles under grass -> grass base + wash + SPARSE pebble variant on top", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  b.buildScene({
    origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1,
    tiles: [tile({ ttname: "StonePebbles2", mat: "STONE", grass: { id: "SATINTAIL", amount: 100 } })],
  });
  const inst = decode(b);
  const gCell = atlas.resolve("grass.png", GL.hashXY(0, 0) % 4, 0);
  const sparse = atlas.resolve("floor_pebbles.png", 6, 0); // PEBBLES_FLOOR_2 (the ttname's own variant digit)
  const dense = atlas.resolve("floor_pebbles.png", 0, 0);  // PEBBLES_FLOOR_5 (the bare-stone token-map pick)
  const cells = inst.map((i) => i.cell);
  assert.ok(cells.includes(gCell), "grass.png base cell emitted");
  assert.ok(cells.includes(sparse), "sparse PEBBLES_FLOOR_2 overlay emitted on top");
  assert.ok(!cells.includes(dense), "the dense PEBBLES_FLOOR_5 full-gravel cell is NOT emitted");
  assert.ok(cells.indexOf(gCell) < cells.indexOf(sparse), "grass draws under, pebbles on top");
  const wash = inst.find((i) => i.cell === GL.SOLID_CELL && i.r === 93 && i.g === 119 && i.b === 52);
  assert.ok(wash, "grassSummer wash present between base and overlay");
  assert.ok(cells.indexOf(sparse) > inst.indexOf(wash), "pebble overlay draws AFTER the wash (not tinted green)");
});

section("grass-escalation GL stage 2: unknown ttname carrying a grass tail keeps its normal art (never blanked)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  b.buildScene({
    origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1,
    tiles: [tile({ ttname: "StoneFloor5", mat: "STONE", grass: { id: "SATINTAIL", amount: 100 } })],
  });
  const inst = decode(b);
  const stoneCell = atlas.resolve("floors.png", 1, 4);
  assert.ok(inst.some((i) => i.cell === stoneCell), "non-whitelisted floor renders its own STONE_FLOOR_5 art");
  assert.ok(!inst.some((i) => i.cell === atlas.resolve("grass.png", GL.hashXY(0, 0) % 4, 0)),
    "no grass base is drawn for a ttname the whitelist does not know");
});

section("WC-17 GL: amount<=0 is worn bare -- resolveSprite falls through to the flat floor colour", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, grassColors: realGrassColors });
  const view = {
    origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1,
    tiles: [tile({ ttname: "GrassLightFloor1", mat: "GRASS_LIGHT", grass: { id: "MEADOW-GRASS", amount: 0 } })],
  };
  b.buildScene(view);
  const inst = decode(b);
  assert.equal(inst.length, 1, "only the flat base-colour fill is emitted, no grass sprite/tint at all");
  assert.equal(inst[0].cell, GL.SOLID_CELL, "base fill is the plain material colour");
});

section("hidden tile: hidden-rock cell, no terrain sprite, HIDDEN_COLOR base", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ ttname: "StoneFloor5", hidden: true })] };
  b.buildScene(view);
  const inst = decode(b);
  assert.deepEqual([inst[0].r, inst[0].g, inst[0].b], [6, 6, 8], "hidden base = HIDDEN_COLOR");
  // one of the HIDDEN_ROCK_1..5 cells
  const hiddenCells = [1, 2, 3, 4, 5].map((i) => atlas.resolve("hidden_rock.png", i - 1, 0));
  assert.ok(inst.some((i) => hiddenCells.includes(i.cell)), "a hidden_rock cell was emitted");
  // no shadow/walljoin overlays on hidden tiles
});

section("wall tile: darkened base + adjacency-aware wall-join cell (B36 open-face semantics)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  // 3x3: a horizontal 1-thick wall RUN in the middle row. The centre wall is EXPOSED to open
  // floor on the N and S faces and BURIED against wall on the W and E -> DF cell suffix "N_S"
  // (rock top+bottom, dark centre). B36 keys the cell on the EXPOSED (open) faces; the pre-fix
  // code keyed on the wall NEIGHBOURS (W,E) and would have drawn "W_E" -- rock on the wrong
  // faces. resolveSprite now returns null for walls, so the only terrain layers are the
  // darkened base fill + this directional edge cell (no full-block base underneath).
  const wall = () => tile({ ttname: "", shape: "WALL", mat: "STONE" });
  const floor = () => tile({ ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE" });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 3, height: 3,
    tiles: [floor(), floor(), floor(), wall(), wall(), wall(), floor(), floor(), floor()] };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 1 && i.y === 1); // the centre wall
  // darkened STONE base: [130,122,110]*0.45 -> [59,55,50]
  assert.ok(inst.some((i) => i.r === 59 && i.g === 55 && i.b === 50), "wall base darkened by 0.45");
  const wjCell = atlas.resolve("wall_stone.png", 0, 9); // STONE_WALL_N_S_1
  assert.ok(inst.some((i) => i.cell === wjCell), "STONE_WALL_N_S_1 join cell emitted (open N/S faces)");
});

section("wall tile: fully-buried interior wall emits NO join cell (B36 dark interior)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  // 3x3 solid wall block: the centre wall has walls on all 8 sides -> zero exposed faces -> no
  // directional cell at all, just the darkened base fill (DF's dark wall interior).
  const wall = () => tile({ ttname: "", shape: "WALL", mat: "STONE" });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 3, height: 3,
    tiles: [wall(), wall(), wall(), wall(), wall(), wall(), wall(), wall(), wall()] };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 1 && i.y === 1);
  const wjCell = atlas.resolve("wall_stone.png", 0, 9);
  assert.ok(!inst.some((i) => i.cell === wjCell), "no join cell emitted over a fully-buried wall");
});

section("shadow decal: floor next to a wall gets the wallShadow cell", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  // 1x2: wall to the N (y=0), floor at y=1 -> wallMask bit N=1 -> WALL_SHADOW_N
  const view = {
    origin: { x: 0, y: 0, z: 0 }, width: 1, height: 2,
    tiles: [tile({ shape: "WALL", mat: "STONE" }), tile({ ttname: "StoneFloor5" })],
  };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.y === 1);
  const shadowCell = atlas.resolve("shadows_wall.png", 0, 0);
  assert.ok(inst.some((i) => i.cell === shadowCell), "WALL_SHADOW_N decal emitted on the floor");
});

section("liquid over bed: bed sprite then liquid depth cell, no fake wash", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const view = {
    origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1,
    tiles: [tile({ ttname: "StoneFloor5", flow: 4, liquid: "water" })],
  };
  b.buildScene(view);
  const inst = decode(b);
  const liquidCell = atlas.resolve("liquids.png", 0, 7 - 4); // water depth 4 -> row 3
  assert.ok(inst.some((i) => i.cell === liquidCell), "liquid depth cell emitted");
  const bed = atlas.resolve("floors.png", 1, 4);
  assert.ok(inst.some((i) => i.cell === bed), "bed sprite emitted under the liquid");
  // base fill uses the bed colour (skipLiquidColor), NOT waterRgb -- STONE [130,122,110]
  assert.deepEqual([inst[0].r, inst[0].g, inst[0].b], [130, 122, 110], "base is bed colour, not fake teal");
});

section("void tile (tt<0): nothing emitted", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ tt: -1, shape: "NONE", mat: "NONE" })] };
  b.buildScene(view);
  assert.equal(b.count, 0, "void tile emits zero instances (background shows)");
});

section("scene-build is deterministic + reports timing", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const tiles = [];
  for (let i = 0; i < 256; i++) tiles.push(tile({ ttname: "StoneFloor5" }));
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 16, height: 16, tiles };
  const r1 = b.buildScene(view);
  const c1 = b.count;
  const r2 = b.buildScene(view);
  assert.equal(b.count, c1, "same input -> same instance count");
  assert.ok(typeof r1.ms === "number" && r1.ms >= 0, "reports build ms");
  console.log("    16x16 all-floor scene-build: " + r2.count + " instances in " + r2.ms.toFixed(3) + " ms");
});

// =============================================================================================
// WB-10 -- multi-z see-down descent (docs/superpowers/specs/2026-07-07-WB-renderer-spec.md,
// "Multi-z see-down composite"). Fixture chunks with open shafts/ramps/liquid at KNOWN depths,
// exercising createSceneBuilder's descent purely off a mock cache reader (no DOM/GL, no real
// DwfCache) -- the same {getChunk,chunkKeyFor} shape dwf-cache.js's public API
// already exposes. Every section here must also pass with the SAME assertions when the item
// lands in transitional mode (WA-12 unlanded, every chunk baked=true): that is exactly what
// the "transitional mode: cacheReader present, nothing changes" section proves.
// =============================================================================================

const tiletypeMeta = new Map([
  [1, { ttname: "OpenSpace", shape: "EMPTY", mat: "AIR" }],           // open shaft air
  [2, { ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE" }],       // a normal floor (existing fixture sprite)
  [3, { ttname: "", shape: "RAMP", mat: "STONE" }],                   // NOT open (only RAMP_TOP is)
  [4, { ttname: "", shape: "RAMP_TOP", mat: "STONE" }],               // open (matches isOpenTile)
]);

// Build one 16x16 chunk's raw SoA arrays. `overrides`: {idx: {tt,mt,mi,liquid,flow,hidden,outside}}.
// Everything not listed is a void record (tt=0xFFFF), matching dwf-cache.js's own layout.
function makeChunk(overrides, baked, sparseEntries) {
  const tt = new Uint16Array(256).fill(0xFFFF);
  const mat = new Int32Array(256);
  const bits = new Uint8Array(256);
  for (const idxStr of Object.keys(overrides)) {
    const idx = Number(idxStr), o = overrides[idxStr];
    tt[idx] = o.tt;
    const mt = (o.mt !== undefined ? o.mt : -1) & 0xFFFF, mi = (o.mi !== undefined ? o.mi : -1) & 0xFFFF;
    mat[idx] = (mt << 16) | mi;
    let b = 0;
    if (o.liquid === "water") b |= 1; else if (o.liquid === "magma") b |= 2;
    b |= ((o.flow || 0) & 7) << 2;
    if (o.hidden) b |= 1 << 5;
    if (o.outside) b |= 1 << 6;
    bits[idx] = b;
  }
  return { tt, mat, bits, baked, sparse: new Map(sparseEntries || []) };
}

// A mock DwfCache-shaped reader: Map "z|key" -> chunk. Real API surface only
// (getChunk/chunkKeyFor) -- exactly what createSceneBuilder's ctx.cacheReader is allowed to
// touch per this item's territory note.
function makeCacheReader(chunkMap) {
  return {
    chunkKeyFor(x, y) { return (x >> 4) * 4096 + (y >> 4); },
    getChunk(z, key) { return chunkMap.get(z + "|" + key) || null; },
  };
}

// A single-column shaft helper: places one tt/flow/hidden record at world (5,5) for a range of
// z levels [zTop..zBottom] (inclusive, descending), all in the SAME 16x16 chunk (key 0, since
// 5>>4===0). `perZ(z)` returns the override for that z, or null to leave it void.
function shaftReader(zTop, zBottom, perZ, bakedAtCamera) {
  const chunkMap = new Map();
  const IDX = 5 * 16 + 5; // (y&15)*16+(x&15) for (5,5)
  for (let z = zBottom; z <= zTop; z++) {
    const o = perZ(z);
    const baked = (z === zTop) ? bakedAtCamera : false; // only the CAMERA level's baked flag gates descent
    chunkMap.set(z + "|0", o ? makeChunk({ [IDX]: o }, baked) : makeChunk({}, baked));
  }
  return makeCacheReader(chunkMap);
}

section("WB-10 cacheHasMultiZ(): false for baked/missing/absent-reader, true only for a real un-baked chunk", () => {
  const baked = makeCacheReader(new Map([["10|0", makeChunk({}, true)]]));
  const unbaked = makeCacheReader(new Map([["10|0", makeChunk({}, false)]]));
  assert.equal(GL.cacheHasMultiZ(baked, 10, 5, 5), false, "baked chunk -> false (transitional)");
  assert.equal(GL.cacheHasMultiZ(unbaked, 10, 5, 5), true, "un-baked chunk -> true");
  assert.equal(GL.cacheHasMultiZ(unbaked, 10, 999, 999), false, "no chunk at that column -> false");
  assert.equal(GL.cacheHasMultiZ(null, 10, 5, 5), false, "no cache reader at all -> false");
});

section("WB-10 transitional mode: cacheReader present but every chunk baked -- zero behaviour change", () => {
  const atlas = makeMockAtlas();
  // camera tile is OPEN (EMPTY) and a solid floor sits right below it -- if descent fired
  // wrongly in transitional mode, this would substitute the floor. It must NOT.
  const cacheReader = shaftReader(10, 8, (z) => {
    if (z === 10) return { tt: 1 };          // camera: open air, BAKED (server already resolved it)
    if (z === 9) return { tt: 1 };
    if (z === 8) return { tt: 2 };            // a floor two levels down
    return null;
  }, /* bakedAtCamera */ true);
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, cacheReader, tiletypeMeta });
  const view = { origin: { x: 0, y: 0, z: 10 }, width: 16, height: 16, tiles: new Array(256).fill(null) };
  view.tiles[5 * 16 + 5] = { x: 5, y: 5, tt: 1, ttname: "", shape: "EMPTY", mat: "AIR", hidden: false, flow: 0, liquid: "none", outside: 1 };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 5 && i.y === 5);
  assert.equal(inst.length, 0, "open camera tile over a baked cache renders nothing (as given), not the substituted floor");
});

section("WB-10 descent: open 2-level shaft over a floor substitutes the floor at depth 2", () => {
  const atlas = makeMockAtlas();
  const cacheReader = shaftReader(10, 8, (z) => {
    if (z === 10) return { tt: 1 };  // camera: open
    if (z === 9) return { tt: 1 };   // still open: keep descending
    if (z === 8) return { tt: 2 };   // StoneFloor5: stop here
    return null;
  }, /* bakedAtCamera */ false);
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, cacheReader, tiletypeMeta });
  const view = { origin: { x: 0, y: 0, z: 10 }, width: 16, height: 16, tiles: new Array(256).fill(null) };
  view.tiles[5 * 16 + 5] = { x: 5, y: 5, tt: 1, ttname: "", shape: "EMPTY", mat: "AIR", hidden: false, flow: 0, liquid: "none", outside: 1 };
  const r = b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 5 && i.y === 5);
  const bed = atlas.resolve("floors.png", 1, 4); // STONE_FLOOR_5
  const sprite = inst.find((i) => i.cell === bed);
  assert.ok(sprite, "the descended floor's sprite is emitted (STONE_FLOOR_5)");
  const depth = (sprite.attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK;
  assert.equal(depth, 2, "seeDownDepth attr bits encode the actual descent depth (2)");
  assert.ok(inst.every((i) => ((i.attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK) === 2),
    "the WHOLE substituted stack (base fill included) carries the same depth");
  console.log("    descent 2-level shaft: " + inst.length + " instances, ms=" + r.ms.toFixed(3));
});

// B24 SEAM (report 07-09): the lower raw chunk already carries ITEM tails in chunk.sparse,
// and dwf-cache.js's cache-fed canvas2d path already copies them during decodeTile()
// descent. GL's private decodeRawAt() used to return terrain-only fields, so the descended tile
// reached emitItem() without t.item and the item layer vanished. These rows exercise the full
// raw-cache descent -> sparse copy -> item emit path, including test-the-test discrimination.
section("WB-10/WB-11 SEAM: descended raw-cache tile carries item sparse layer with see-down depth", () => {
  const atlas = makeMockAtlas();
  const IDX = 5 * 16 + 5;
  const itemTail = { type: "AMMO", mat_type: -1, mat_index: -1, subtype: -1, iflags: 0 };
  const chunkMap = new Map([
    ["10|0", makeChunk({ [IDX]: { tt: 1 } }, false)],
    ["9|0", makeChunk({ [IDX]: { tt: 1 } }, false)],
    ["8|0", makeChunk({ [IDX]: { tt: 2 } }, false, [[IDX, { item: itemTail }]])],
  ]);
  const cacheReader = makeCacheReader(chunkMap);
  const b = GL.createSceneBuilder({
    atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj,
    cacheReader, tiletypeMeta, itemMap: realItemMap,
  });
  const view = { origin: { x: 0, y: 0, z: 10 }, width: 16, height: 16, tiles: new Array(256).fill(null) };
  view.tiles[IDX] = { x: 5, y: 5, tt: 1, ttname: "", shape: "EMPTY", mat: "AIR", hidden: false, flow: 0, liquid: "none", outside: 1 };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 5 && i.y === 5);
  const ammoDef = realItemMap.bytype.AMMO;
  const ammoCell = atlas.resolve(ammoDef.sheet, ammoDef.col, ammoDef.row);
  const item = inst.find((i) => i.cell === ammoCell);
  assert.ok(item, "the descended lower tile's AMMO item sprite is emitted");
  assert.equal((item.attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK, 2,
    "the item layer carries the SAME depth attr as the descended terrain stack");
  const bed = atlas.resolve("floors.png", 1, 4);
  const floor = inst.find((i) => i.cell === bed);
  assert.ok(floor, "guard: the descended floor terrain also emitted");
  assert.equal((floor.attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK, 2,
    "guard: terrain depth is the expected 2-level descent");
});

section("WB-10/WB-11 SEAM control: camera-plane item rendering is byte-identical with cacheReader present", () => {
  const IDX = 5 * 16 + 5;
  const itemTail = { type: "AMMO", mat_type: -1, mat_index: -1, subtype: -1, iflags: 0 };
  const view = {
    origin: { x: 5, y: 5, z: 10 }, width: 1, height: 1,
    tiles: [tile({ x: 5, y: 5, item: itemTail })],
  };
  const build = (cacheReader) => {
    const atlas = makeMockAtlas();
    const b = GL.createSceneBuilder({
      atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj,
      cacheReader, tiletypeMeta, itemMap: realItemMap,
    });
    b.buildScene(view);
    const ammoDef = realItemMap.bytype.AMMO;
    return { inst: decode(b), ammoCell: atlas.resolve(ammoDef.sheet, ammoDef.col, ammoDef.row) };
  };
  const noCache = build(null);
  const cacheReader = makeCacheReader(new Map([["10|0", makeChunk({ [IDX]: { tt: 2 } }, false)]]));
  const withCache = build(cacheReader);
  assert.deepEqual(withCache.inst, noCache.inst,
    "camera-plane rendering must not change when the cache reader is present but no descent occurs");
  const item = withCache.inst.find((i) => i.cell === withCache.ammoCell);
  assert.ok(item, "guard: the camera-plane AMMO item still emits");
  assert.equal((item.attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK, 0,
    "camera-plane item is not fog-tagged");
});

section("WB-10/WB-11 SEAM seeded-bad: a descended tile without sparse item tail emits no item", () => {
  const atlas = makeMockAtlas();
  const IDX = 5 * 16 + 5;
  const chunkMap = new Map([
    ["10|0", makeChunk({ [IDX]: { tt: 1 } }, false)],
    ["9|0", makeChunk({ [IDX]: { tt: 1 } }, false)],
    ["8|0", makeChunk({ [IDX]: { tt: 2 } }, false)],
  ]);
  const b = GL.createSceneBuilder({
    atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj,
    cacheReader: makeCacheReader(chunkMap), tiletypeMeta, itemMap: realItemMap,
  });
  const view = { origin: { x: 0, y: 0, z: 10 }, width: 16, height: 16, tiles: new Array(256).fill(null) };
  view.tiles[IDX] = { x: 5, y: 5, tt: 1, ttname: "", shape: "EMPTY", mat: "AIR", hidden: false, flow: 0, liquid: "none", outside: 1 };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 5 && i.y === 5);
  const ammoDef = realItemMap.bytype.AMMO;
  const ammoCell = atlas.resolve(ammoDef.sheet, ammoDef.col, ammoDef.row);
  assert.ok(!inst.some((i) => i.cell === ammoCell),
    "test-the-test: the item assertion discriminates a lower tile whose sparse item was skipped");
  const bed = atlas.resolve("floors.png", 1, 4);
  assert.ok(inst.some((i) => i.cell === bed), "guard: this seeded-bad row still descended to terrain");
});

section("WB-10 descent: max depth is bounded at 10 -- a floor at depth 11 is never reached", () => {
  const atlas = makeMockAtlas();
  // camera z=15; dz 1..10 -> z=14..5 all open; the floor sits at z=4 (dz=11) -- out of range.
  const cacheReader = shaftReader(15, 4, (z) => {
    if (z === 15) return { tt: 1 };
    if (z === 4) return { tt: 2 };
    return { tt: 1 }; // every level 14..5 stays open air
  }, /* bakedAtCamera */ false);
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, cacheReader, tiletypeMeta });
  const view = { origin: { x: 0, y: 0, z: 15 }, width: 16, height: 16, tiles: new Array(256).fill(null) };
  view.tiles[5 * 16 + 5] = { x: 5, y: 5, tt: 1, ttname: "", shape: "EMPTY", mat: "AIR", hidden: false, flow: 0, liquid: "none", outside: 1 };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 5 && i.y === 5);
  assert.equal(inst.length, 0, "nothing found within MAX_SEEDOWN_DEPTH -> falls back to the (colourless, open) camera tile");
});

section("WB-10 descent: a RAMP (not RAMP_TOP) camera tile is NOT open -- never descends", () => {
  const atlas = makeMockAtlas();
  const cacheReader = shaftReader(10, 9, (z) => {
    if (z === 10) return { tt: 3 };  // RAMP: solid walkable surface, not open
    if (z === 9) return { tt: 2 };   // a floor right below -- must be ignored
    return null;
  }, /* bakedAtCamera */ false);
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, cacheReader, tiletypeMeta });
  const view = { origin: { x: 0, y: 0, z: 10 }, width: 16, height: 16, tiles: new Array(256).fill(null) };
  view.tiles[5 * 16 + 5] = { x: 5, y: 5, tt: 3, ttname: "", shape: "RAMP", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 5 && i.y === 5);
  assert.ok(inst.length >= 1, "the ramp itself still renders (its own darkened/base colour)");
  assert.ok(inst.every((i) => ((i.attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK) === 0),
    "no descent occurred -- depth attr is 0 on every instance");
  assert.deepEqual([inst[0].r, inst[0].g, inst[0].b], [130, 122, 110], "renders the ramp's OWN stone colour, not the floor below");
});

section("WB-10 descent: a HIDDEN (undiscovered) open camera tile never descends", () => {
  const atlas = makeMockAtlas();
  const cacheReader = shaftReader(10, 9, (z) => {
    if (z === 10) return { tt: 1, hidden: 1 }; // hidden open air
    if (z === 9) return { tt: 2 };             // floor right below
    return null;
  }, /* bakedAtCamera */ false);
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, cacheReader, tiletypeMeta });
  const view = { origin: { x: 0, y: 0, z: 10 }, width: 16, height: 16, tiles: new Array(256).fill(null) };
  view.tiles[5 * 16 + 5] = { x: 5, y: 5, tt: 1, ttname: "", shape: "EMPTY", mat: "AIR", hidden: true, flow: 0, liquid: "none", outside: 1 };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 5 && i.y === 5);
  assert.deepEqual([inst[0].r, inst[0].g, inst[0].b], [6, 6, 8], "renders the hidden tile's own HIDDEN_COLOR, not a substituted floor");
  assert.ok(inst.every((i) => ((i.attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK) === 0), "depth attr stays 0");
});

section("WB-10 descent: an open-shaped tile with active flow STOPS the descent (liquid, not air)", () => {
  const atlas = makeMockAtlas();
  const cacheReader = shaftReader(10, 9, (z) => {
    if (z === 10) return { tt: 1 };                          // camera: open air
    if (z === 9) return { tt: 1, liquid: "water", flow: 4 };  // EMPTY shape but flow>0 -> a stop
    return null;
  }, /* bakedAtCamera */ false);
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj, cacheReader, tiletypeMeta });
  const view = { origin: { x: 0, y: 0, z: 10 }, width: 16, height: 16, tiles: new Array(256).fill(null) };
  view.tiles[5 * 16 + 5] = { x: 5, y: 5, tt: 1, ttname: "", shape: "EMPTY", mat: "AIR", hidden: false, flow: 0, liquid: "none", outside: 1 };
  b.buildScene(view);
  const inst = decode(b).filter((i) => i.x === 5 && i.y === 5);
  const liquidCell = atlas.resolve("liquids.png", 0, 7 - 4); // water depth 4
  const liq = inst.find((i) => i.cell === liquidCell);
  assert.ok(liq, "the depth-4 water tile one level down is the descent stop (liquid cell emitted)");
  const depth = (liq.attr >> GL.ATTR_SEEDOWN_SHIFT) & GL.ATTR_SEEDOWN_MASK;
  assert.equal(depth, 1, "stopped at dz=1, not deeper");
});

section("WB-10 RenderParams: seeDownTint/seeDownCurve default to the MEASURED fog verdict (sweep #2)", () => {
  const rp = GL.defaultRenderParams();
  // Array.from(): rp.seeDownTint was constructed inside the sandbox realm (vm.createContext),
  // so a raw deepEqual against a main-realm array literal spuriously fails Node's
  // reference-equality check on cross-realm Array prototypes -- normalize first.
  const tint = Array.from(rp.seeDownTint);
  const curve = Array.from(rp.seeDownCurve);
  const fog = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/reference/fogparams.json"), "utf8")).seeDown;
  assert.equal(Math.round(tint[0] * 255), fog.fogColorRgb[0], "seeDownTint.rgb r matches fogparams.json fogColorRgb");
  assert.equal(Math.round(tint[1] * 255), fog.fogColorRgb[1], "seeDownTint.rgb g matches fogparams.json fogColorRgb");
  assert.equal(Math.round(tint[2] * 255), fog.fogColorRgb[2], "seeDownTint.rgb b matches fogparams.json fogColorRgb");
  assert.ok(tint[3] > 0, "seeDownTint.a (rate) is non-zero -- fog is ON by default now that the verdict landed");
  assert.ok(curve[0] > 0, "seeDownCurve.x (intercept) is non-zero -- the fit is NOT linear through the origin");

  // Re-derive the shader's own formula (amt = clamp(intercept + depth*rate, 0, 1)) here in
  // plain JS and check it against every measured, non-clipped point in fogparams.json
  // (depth 1..7 -- 8/9 are the curve's own clip-to-1.0 region, checked separately below).
  function amtFor(depth) { return Math.max(0, Math.min(1, curve[0] + depth * tint[3])); }
  const table = fog.alphaByDepth;
  let maxAbsResid = 0;
  for (const depthStr of Object.keys(table)) {
    const depth = Number(depthStr);
    if (depth < 1 || depth > 7) continue; // 0 is never fogged; 8/9 are clipped, not fit points
    const resid = Math.abs(amtFor(depth) - table[depthStr]);
    maxAbsResid = Math.max(maxAbsResid, resid);
  }
  assert.ok(maxAbsResid < 0.01, "shader's intercept+rate*depth re-expression tracks the measured " +
    "curve to within 0.01 alpha at every non-clipped depth (max resid " + maxAbsResid.toFixed(4) + ")");
  for (const depth of [8, 9, 10]) {
    assert.equal(amtFor(depth), 1, "depth " + depth + " clips to full fog (matches the measured curve's own clip)");
  }

  // Explicit spot-checks at the depths named in the task (1/3/5/10), against fogparams.json.
  assert.ok(Math.abs(amtFor(1) - table["1"]) < 0.01, "depth 1 fog alpha matches fogparams.json (" + table["1"] + ")");
  assert.ok(Math.abs(amtFor(3) - table["3"]) < 0.01, "depth 3 fog alpha matches fogparams.json (" + table["3"] + ")");
  assert.ok(Math.abs(amtFor(5) - table["5"]) < 0.01, "depth 5 fog alpha matches fogparams.json (" + table["5"] + ")");
  assert.equal(amtFor(10), 1, "depth 10 (beyond the measured table's max of 9) stays clipped to full fog");
});

section("WB-10: designated-hidden additive lighten emits an ATTR_ADDITIVE instance only when hidden+desig", () => {
  const atlas = makeMockAtlas();
  const b1 = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const withDesig = tile({ ttname: "StoneFloor5", hidden: true, desig: { dig: "Default" } });
  b1.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [withDesig] });
  const inst1 = decode(b1);
  const additive = inst1.find((i) => (i.attr & GL.ATTR_ADDITIVE) !== 0);
  assert.ok(additive, "an ADDITIVE instance is present for a hidden+designated tile");
  assert.deepEqual([additive.r, additive.g, additive.b, additive.a], [0, 0, 0, 0], "inert tint -- the shader supplies designationLighten.rgb");

  const b2 = GL.createSceneBuilder({ atlas: makeMockAtlas(), spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const noDesig = tile({ ttname: "StoneFloor5", hidden: true });
  b2.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [noDesig] });
  assert.ok(!decode(b2).some((i) => (i.attr & GL.ATTR_ADDITIVE) !== 0), "no ADDITIVE instance without an active designation");
});

// =============================================================================================
// Designation-glyph GL bug (2026-07-07 ledger, "DESIGNATION OVERLAY BUGS: DIAGNOSED" ->
// root-caused this session): a prior sweep proved the server wire and the CPU scene-build core
// were both innocent (a mock ALWAYS-READY atlas correctly emits wash+glyph across two sequential
// buildScene() calls, see the WB-10 additive-lighten section above), leaving the REAL atlas's
// async sheet-ready timing as the last unconfirmed candidate. This section uses the REAL
// dwf-gl-atlas.js (not the mock) with an injectable `fetchSheet` + `now()` clock (both
// DI hooks the atlas module exposes) to reproduce it precisely: `ensureSheet()` used to do
// `if (s) return s;` unconditionally, so a SINGLE transient sheet-fetch rejection (e.g. one
// dropped request over the flaky cloudflare tunnel) permanently stuck that sheet's `sheets`
// Map entry at state "error" for the rest of the browser session -- every sprite on that sheet
// (here: `designations.png`, i.e. every dig/channel/stair/track/traffic glyph) then resolved to
// PENDING forever, while unrelated overlay pieces drawn as SOLID_CELL (the wash) or from OTHER
// sheets (hidden-rock hatch) kept rendering fine -- exactly the reported split (wash+hatch+
// outline correct, glyph silently missing, fixed only by a full page reload that creates fresh
// `sheets`/`imageCache` Maps). Fixed by a bounded backoff retry (SHEET_RETRY_DELAY_MS) gated on
// `s.retryable` (only a FETCH failure is retried -- bad image dims / atlas-full are not, since
// re-fetching the same bytes can't change either outcome).
async function asyncSection(name, fn) {
  try { await fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}

await asyncSection("designation glyph survives a transient sheet-fetch failure (no reload needed)", async () => {
  let attempt = 0;
  // Only designations.png is flaky (one dropped request, like a tunnel hiccup); every OTHER
  // sheet this fixture's tile also touches (hidden_rock.png for the hidden-rock hatch) must
  // resolve normally immediately -- isolates the assertion to the ONE sheet under test, same
  // "other overlay pieces stay correct" split the live bug report described.
  const fetchSheetFlaky = (name) => {
    if (name !== "designations.png") {
      return Promise.resolve({ width: 5 * 32, height: 32, data: new Uint8Array(5 * 32 * 32 * 4) });
    }
    attempt++;
    // first attempt for designations.png simulates one dropped/failed request; every
    // subsequent attempt succeeds, mirroring a genuinely transient network hiccup.
    if (attempt === 1) return Promise.reject(new Error("simulated transient fetch failure"));
    return Promise.resolve({ width: 2 * 32, height: 16 * 32, data: new Uint8Array(2 * 32 * 16 * 32 * 4) });
  };
  let clock = 0;
  const atlas = RealAtlas.create({ fetchSheet: fetchSheetFlaky, now: () => clock });
  let lastKey = ""; // mirrors dwf-render.js's GL controller: onSheetReady() resets the
                     // maybeRebuild() change-key so the NEXT tick re-derives the scene.
  atlas.onSheetReady(() => { lastKey = ""; });

  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const withDesig = tile({ ttname: "StoneFloor5", hidden: true, desig: { dig: "Default" } });
  const view = { origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [withDesig] };
  const drain = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  // Track presence by the SPECIFIC glyph cell id (once the sheet is ready), not raw instance
  // counts -- the fixture's tile ALSO carries a hidden-rock hatch sprite (a completely
  // independent, always-succeeding sheet fetch) that legitimately appears on its own schedule
  // and must not be conflated with the designations.png glyph under test here.
  const glyphPresent = () => {
    // "designations.png" is DESIG_SHEET (not exported -- it's the same literal
    // dwf-gl.js's emitDesignationOverlay resolves against); resolve() is idempotent
    // for an already-resolved/pending/errored sheet, so calling it again here purely to
    // read back the id is side-effect-free w.r.t. the scene-build under test.
    const gc = atlas.resolve("designations.png", GL.DESIG_CELL.dig[0], GL.DESIG_CELL.dig[1]);
    return gc > 0 && decode(b).some((i) => i.cell === gc);
  };

  b.buildScene(view);
  await drain();
  assert.equal(glyphPresent(), false, "glyph missing right after the fetch rejects");
  assert.equal(atlas.getStats().sheetsError, 1, "the sheet is recorded as errored");

  // Re-rebuilding before the backoff window elapses must NOT spam a retry.
  clock += 500;
  b.buildScene(view);
  await drain();
  assert.equal(glyphPresent(), false, "still missing before SHEET_RETRY_DELAY_MS elapses");
  assert.equal(attempt, 1, "no retry attempted yet (within the backoff window)");

  // Past the backoff window, the next resolve() call retries and (this time) succeeds; the
  // real render.js contract is: onSheetReady() resets lastKey, and the NEXT rebuild picks up
  // the now-ready cell -- reproduced here as two buildScene() calls, mirroring two rAF ticks.
  clock += 2000;
  b.buildScene(view);
  await drain();
  b.buildScene(view);
  assert.equal(glyphPresent(), true, "glyph recovers automatically once the sheet's retry succeeds -- no page reload needed");
  assert.equal(attempt, 2, "exactly one retry attempt was made (not a hot retry loop)");
});

// =============================================================================================
// WC-18/WC-19/WC-22-blood (this session): GL parity for the held client-half tail consumers.
// =============================================================================================

section("WC-18 GL parity: engraving OR-combined mask -> ENGRAVED_STONE_WALL_* token (matches canvas2d)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const ENG_N = 0x0008, ENG_S = 0x0010, ENG_FLOOR = 0x0001, ENG_HIDDEN = 0x0020, ENG_NW = 0x0040;
  assert.equal(b._engravingWallTokenForTest(ENG_N), "ENGRAVED_STONE_WALL_N");
  assert.equal(b._engravingWallTokenForTest(ENG_N | ENG_S), "ENGRAVED_STONE_WALL_N_S");
  assert.equal(b._engravingWallTokenForTest(ENG_NW), "ENGRAVED_STONE_WALL_NW");
  assert.equal(b._engravingWallTokenForTest(ENG_N | ENG_NW), "ENGRAVED_STONE_WALL_N", "cardinal wins over lone diagonal (documented residual)");
  assert.equal(b._engravingWallTokenForTest(ENG_FLOOR), null, "floor-only bit -> no wall token");
  assert.equal(b._engravingWallTokenForTest(0), null, "zero mask -> null");
  void ENG_HIDDEN;
});

section("WC-18 GL parity: engraving hits emit the ENGRAVED_STONE_WALL cell over a wall tile (was canvas2d-only)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  // two engraving records on one wall tile (north + south faces) -> OR-combined N_S cell.
  const t = tile({ tt: 1, ttname: "StoneWall", shape: "WALL", mat: "STONE",
                   engravings: [{ eflags: 0x0008, quality: 3 }, { eflags: 0x0010, quality: 5 }] });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const engCell = atlas.resolve("wall_stone_engraved.png", 0, 5); // ENGRAVED_STONE_WALL_N_S
  assert.ok(inst.some((i) => i.cell === engCell), "the OR-combined ENGRAVED_STONE_WALL_N_S cell is emitted");
});

section("WC-18 GL: a hidden-flag engraving draws nothing (DF hides the decoration)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const t = tile({ tt: 1, ttname: "StoneWall", shape: "WALL", mat: "STONE",
                   engravings: [{ eflags: 0x0008 | 0x0020, quality: 3 }] }); // N + hidden
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const engCell = atlas.resolve("wall_stone_engraved.png", 0, 3);
  assert.ok(!inst.some((i) => i.cell === engCell), "no engraving cell emitted when the hidden flag is set");
});

section("WC-19 GL: dig-priority numeral emitted over a designated tile from t.desigPriority", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const t = tile({ tt: 2, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE",
                   desig: { dig: "Default", smooth: 0, traffic: 0, track: 0, marker: 0 },
                   desigPriority: { priority: 5 } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  const prioCell = atlas.resolve("designation_priority.png", 0, 4); // level 5 -> row 4
  assert.ok(inst.some((i) => i.cell === prioCell), "priority-5 numeral cell emitted");
});

section("WC-19 GL: no priority numeral when the tile carries no desigPriority tail", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  const t = tile({ tt: 2, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE",
                   desig: { dig: "Default", smooth: 0, traffic: 0, track: 0, marker: 0 } });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  const inst = decode(b);
  // designation_priority.png must never be resolved for a tile with no priority tail.
  const anyPrio = inst.some((i) => {
    for (let lvl = 0; lvl < 7; lvl++) if (i.cell === atlas.resolve("designation_priority.png", 0, lvl)) return true;
    return false;
  });
  assert.ok(!anyPrio, "no priority glyph for a default-priority designation");
});

section("WC-19 GL: itemMarkToken maps iflags combos to DESIGNATION_ITEM_* tokens", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  assert.equal(b._itemMarkTokenForTest(0x02), "DESIGNATION_ITEM_FORBIDDEN");
  assert.equal(b._itemMarkTokenForTest(0x04), "DESIGNATION_ITEM_DUMP");
  assert.equal(b._itemMarkTokenForTest(0x08), "DESIGNATION_ITEM_MELT");
  assert.equal(b._itemMarkTokenForTest(0x02 | 0x08), "DESIGNATION_ITEM_FORBIDDEN_MELT");
  assert.equal(b._itemMarkTokenForTest(0x02 | 0x04), "DESIGNATION_ITEM_FORBIDDEN_DUMP");
  assert.equal(b._itemMarkTokenForTest(0), null);
  assert.equal(b._itemMarkTokenForTest(0x01), null, "web-only flag is not a designation mark");
});

section("WC-22 blood-family GL: rgb hue -> nearest BLOOD_* family (parity with canvas2d)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap, shadowCellMap, adjacency: Adj });
  assert.equal(b._bloodFamilyFromRgbForTest([180, 20, 20]), "BLOOD_RED", "golden fixture blood-red rgb");
  assert.equal(b._bloodFamilyFromRgbForTest([20, 40, 200]), "BLOOD_CYAN", "blue -> cyan");
  assert.equal(b._bloodFamilyFromRgbForTest([160, 30, 170]), "BLOOD_MAGENTA", "purple -> magenta");
  assert.equal(b._bloodFamilyFromRgbForTest([200, 190, 30]), "BLOOD_ICHOR", "yellow -> ichor");
  assert.equal(b._bloodFamilyFromRgbForTest([120, 120, 120]), "BLOOD_GOO", "grey -> goo");
  assert.equal(b._bloodFamilyFromRgbForTest(null), null, "missing rgb -> null (caller hash-picks)");
});

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nAll gl_core_test sections passed.");
