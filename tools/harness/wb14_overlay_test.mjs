// wb14_overlay_test.mjs -- WB-14 acceptance (docs/superpowers/specs/2026-07-07-WB-renderer-
// spec.md, "Overlays, final 2D split, and the default-flip decision"). Loads the REAL
// web/js/dwf-gl.js verbatim via vm.runInContext, same convention as gl_core_test.mjs/
// wb11_sparse_test.mjs/wb12_buildings_test.mjs/wb13_units_test.mjs, and exercises the two new
// non-text overlay pieces this item ports into the GL scene-build: designation glyphs/category
// washes/marker-mode alpha (the previously-unused ATTR_MARKER attr bit, defined since WB-9/
// §1.2 but never consumed until now), and presence drag-rects/tile-outlines. TEXT (name pills/
// HUD/F3/"connecting...") stays on dwf-tiles.js's permanent 2D overlay canvas -- out of
// scope here by design (report §B), not tested by this file.
//
// Run: node tools/harness/wb14_overlay_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const sandbox = {};
sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8"), sandbox, { filename: "web/js/dwf-gl.js" });
const GL = sandbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
assert.ok(typeof GL.resolveDesig === "function", "DwfGL must export resolveDesig");
assert.ok(typeof GL.playerColorRgb === "function", "DwfGL must export playerColorRgb");
assert.equal(GL.ATTR_MARKER, 1 << 8, "ATTR_MARKER stays bit 8 per the spec §1.2 attr layout");

// ---- mock atlas: assign a stable positive cell id per (sheet,col,row) --------------------
function makeMockAtlas() {
  const ids = new Map();
  let next = 1;
  return { resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!ids.has(k)) ids.set(k, next++); return ids.get(k); } };
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

function tile(o) {
  return Object.assign({ tt: 1, ttname: "", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
}

let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}

// =============================================================================================
// resolveDesig: pure category/cell resolution, mirrors dwf-tiles.js's resolveDesig 1:1.
// =============================================================================================
// NOTE: array/object literals built INSIDE the vm sandbox belong to a different realm than
// this test file's own Array/Object, so assert.deepEqual/deepStrictEqual's reference-equality
// prototype check fails even on identical structure -- compare fields individually instead
// (same cross-realm gotcha, same workaround convention as this repo's other vm-sandbox tests).
function assertDesig(actual, cell, cat) {
  assert.ok(actual, "resolveDesig returned null unexpectedly");
  assert.equal(actual.cat, cat);
  assert.equal(actual.cell[0], cell[0]); assert.equal(actual.cell[1], cell[1]);
}

section("resolveDesig: dig/channel/stair/ramp map to their designations.png cells", () => {
  assertDesig(GL.resolveDesig({ dig: "Default" }, { mat: "STONE", shape: "FLOOR" }), [0, 1], "dig");
  assertDesig(GL.resolveDesig({ dig: "Channel" }, {}), [0, 2], "channel");
  assertDesig(GL.resolveDesig({ dig: "UpStair" }, {}), [0, 3], "stair");
  assertDesig(GL.resolveDesig({ dig: "DownStair" }, {}), [0, 4], "stair");
  assertDesig(GL.resolveDesig({ dig: "UpDownStair" }, {}), [0, 5], "stair");
  assertDesig(GL.resolveDesig({ dig: "Ramp" }, {}), [0, 6], "ramp");
});
section("resolveDesig: dig=='Default' disambiguates chop/gather/dig from the tile's own mat/shape", () => {
  assert.equal(GL.resolveDesig({ dig: "Default" }, { mat: "TREE", shape: "TRUNK_N" }).cat, "chop");
  assert.equal(GL.resolveDesig({ dig: "Default" }, { mat: "STONE", shape: "SAPLING" }).cat, "chop");
  assert.equal(GL.resolveDesig({ dig: "Default" }, { mat: "PLANT", shape: "FLOOR" }).cat, "gather");
  assert.equal(GL.resolveDesig({ dig: "Default" }, { mat: "STONE", shape: "SHRUB" }).cat, "gather");
  assert.equal(GL.resolveDesig({ dig: "Default" }, { mat: "STONE", shape: "FLOOR", plant: { part: "SHRUB" } }).cat, "gather");
  assert.equal(GL.resolveDesig({ dig: "Default" }, { mat: "STONE", shape: "FLOOR", plant: { part: "FRUIT" } }).cat, "dig");
  assert.equal(GL.resolveDesig({ dig: "Default" }, { mat: "STONE", shape: "WALL" }).cat, "dig");
});
section("resolveDesig: smooth/engrave/track/traffic (non-dig designations)", () => {
  assert.equal(GL.resolveDesig({ smooth: 1 }, {}).cat, "smooth");
  assert.equal(GL.resolveDesig({ smooth: 2 }, {}).cat, "engrave");
  assertDesig(GL.resolveDesig({ track: 1 }, {}), [1, 0], "track");
  assert.equal(GL.resolveDesig({ traffic: 1 }, {}).cat, "traffic");
  assert.equal(GL.resolveDesig({ traffic: 2 }, {}).cat, "traffic");
  assert.equal(GL.resolveDesig({ traffic: 3 }, {}).cat, "traffic");
  assert.equal(GL.resolveDesig({ dig: "No" }, {}), null, "dig:'No' with nothing else active resolves to nothing");
  assert.equal(GL.resolveDesig(null, {}), null);
  assert.equal(GL.resolveDesig({}, {}), null, "an empty desig object resolves to nothing");
});

// =============================================================================================
// buildScene: designation wash + glyph instances, painter order, marker-mode.
// =============================================================================================
section("buildScene: an active dig designation emits a category wash THEN the DF glyph", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ desig: { dig: "Default" } })] });
  const inst = decode(b);
  const glyphCell = atlas.resolve("designations.png", 0, 1); // DESIG_CELL.dig
  const washIdx = inst.findIndex((i) => i.cell === GL.SOLID_CELL && i.r === 240 && i.g === 150 && i.b === 40);
  const glyphIdx = inst.findIndex((i) => i.cell === glyphCell);
  assert.ok(washIdx >= 0, "dig category wash instance present");
  assert.ok(glyphIdx >= 0, "dig glyph instance present");
  assert.ok(washIdx < glyphIdx, "wash is emitted BEFORE the glyph (painter order)");
  assert.equal(inst[washIdx].a, Math.round(GL.DESIG_WASH_ALPHA * 255), "active (non-marker) wash alpha");
  assert.equal(inst[glyphIdx].a, 255, "active (non-marker) glyph is fully opaque");
  assert.equal(inst[glyphIdx].attr & GL.ATTR_MARKER, 0, "MARKER attr bit is NOT set for an active designation");
});
section("buildScene: marker(blueprint) mode recolours the cell blue -- fixed marker-wash + glyph tint (MARKER-COLOR)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ desig: { dig: "Default", marker: true } })] });
  const inst = decode(b);
  const glyphCell = atlas.resolve("designations.png", 0, 1);
  // Wash swaps the category orange for native's measured marker-blue (NOT a fainter orange).
  const wash = inst.find((i) => i.cell === GL.SOLID_CELL && i.r === GL.MARKER_WASH_RGB[0] && i.g === GL.MARKER_WASH_RGB[1] && i.b === GL.MARKER_WASH_RGB[2]);
  const glyph = inst.find((i) => i.cell === glyphCell);
  assert.ok(wash, "marker wash uses the fixed native marker-blue colour, not the category orange");
  assert.equal(wash.a, Math.round(GL.DESIG_WASH_ALPHA_MARKER * 255), "marker wash alpha is the marker constant");
  assert.ok(!inst.some((i) => i.cell === GL.SOLID_CELL && i.r === 240 && i.g === 150 && i.b === 40), "no orange category wash in marker mode");
  // Glyph recolour rides its own rgb tint (texel*tint), NOT the retired ATTR_MARKER shader dim.
  assert.equal(glyph.r, GL.MARKER_GLYPH_TINT[0], "marker glyph carries the fitted recolour tint (R)");
  assert.equal(glyph.g, GL.MARKER_GLYPH_TINT[1], "marker glyph carries the fitted recolour tint (G)");
  assert.equal(glyph.b, GL.MARKER_GLYPH_TINT[2], "marker glyph carries the fitted recolour tint (B)");
  assert.equal(glyph.a, 255, "marker glyph stays fully opaque (recolour is per-channel, not a dim)");
  assert.equal(glyph.attr & GL.ATTR_MARKER, 0, "ATTR_MARKER is no longer emitted (recolour via instance tint)");
});
section("buildScene: designations fire on HIDDEN tiles too (WB-5 parity) and coexist with the WB-10 additive lighten", () => {
  const atlas = makeMockAtlas();
  const spriteMap = {
    HIDDEN_ROCK_1: { sheet: "hidden_rock.png", col: 0, row: 0 }, HIDDEN_ROCK_2: { sheet: "hidden_rock.png", col: 1, row: 0 },
    HIDDEN_ROCK_3: { sheet: "hidden_rock.png", col: 2, row: 0 }, HIDDEN_ROCK_4: { sheet: "hidden_rock.png", col: 3, row: 0 },
    HIDDEN_ROCK_5: { sheet: "hidden_rock.png", col: 4, row: 0 },
  };
  const b = GL.createSceneBuilder({ atlas, spriteMap, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({ hidden: true, desig: { dig: "Default" } })] });
  const inst = decode(b);
  assert.ok(inst.some((i) => (i.attr & GL.ATTR_ADDITIVE) === GL.ATTR_ADDITIVE), "additive lighten present (WB-10, unchanged)");
  const glyphCell = atlas.resolve("designations.png", 0, 1);
  assert.ok(inst.some((i) => i.cell === glyphCell), "designation glyph ALSO present over the hidden-rock tile");
});
section("buildScene: no designation instances when a tile has no active desig", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({})] });
  const inst = decode(b);
  assert.ok(!inst.some((i) => i.cell === atlas.resolve("designations.png", 0, 1)), "no glyph instance without a desig");
});

// =============================================================================================
// buildScene: presence drag-rects + tile-outlines.
// =============================================================================================
section("buildScene: an in-progress drag rect fills every covered tile in the dragging player's colour", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {}, ownPlayerName: "me" });
  const view = {
    origin: { x: 10, y: 10, z: 0 }, width: 5, height: 5, tiles: Array.from({ length: 25 }, () => tile({})),
    players: [{ name: "bob", x: 12, y: 12, z: 0, drag: true, dx: 13, dy: 13 }],
  };
  b.buildScene(view);
  const inst = decode(b);
  const rgb = GL.playerColorRgb("bob");
  const fillA = Math.round(0.16 * 255);
  const fills = inst.filter((i) => i.cell === GL.SOLID_CELL && i.r === rgb[0] && i.g === rgb[1] && i.b === rgb[2] && i.a === fillA);
  assert.equal(fills.length, 4, "the 2x2 drag rect ((12,12)-(13,13) inclusive) fills exactly 4 tiles");
  const coords = fills.map((f) => f.x + "," + f.y).sort();
  assert.deepEqual(coords, ["12,12", "12,13", "13,12", "13,13"], "fills land at the world tiles the drag rect covers");
});
section("buildScene: presence emits a tile-outline marker at the OTHER player's own tile, same-z opacity", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {}, ownPlayerName: "me" });
  const view = {
    origin: { x: 0, y: 0, z: 5 }, width: 3, height: 3, tiles: Array.from({ length: 9 }, () => tile({})),
    players: [{ name: "carol", x: 1, y: 1, z: 5 }],
  };
  b.buildScene(view);
  const inst = decode(b);
  const rgb = GL.playerColorRgb("carol");
  const marker = inst.find((i) => i.cell === GL.SOLID_CELL && i.r === rgb[0] && i.g === rgb[1] && i.b === rgb[2] && i.a === Math.round(0.55 * 255));
  assert.ok(marker, "same-z tile-outline marker present");
  assert.equal(marker.x, 1); assert.equal(marker.y, 1);
});
section("buildScene: a different-z player's marker uses the faded (diff-z) alpha", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {}, ownPlayerName: "me" });
  const view = {
    origin: { x: 0, y: 0, z: 5 }, width: 3, height: 3, tiles: Array.from({ length: 9 }, () => tile({})),
    players: [{ name: "dave", x: 1, y: 1, z: 9 }],
  };
  b.buildScene(view);
  const inst = decode(b);
  const rgb = GL.playerColorRgb("dave");
  const marker = inst.find((i) => i.cell === GL.SOLID_CELL && i.r === rgb[0] && i.g === rgb[1] && i.b === rgb[2]);
  assert.ok(marker, "diff-z marker present");
  assert.equal(marker.a, Math.round(0.28 * 255), "diff-z marker uses the faded alpha, not the same-z one");
});
section("buildScene: presence never draws our own cursor (ownPlayerName injected via ctx)", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {}, ownPlayerName: "me" });
  const view = {
    origin: { x: 0, y: 0, z: 0 }, width: 3, height: 3, tiles: Array.from({ length: 9 }, () => tile({})),
    players: [{ name: "me", x: 1, y: 1, z: 0 }],
  };
  b.buildScene(view);
  const inst = decode(b);
  const rgb = GL.playerColorRgb("me");
  assert.ok(!inst.some((i) => i.cell === GL.SOLID_CELL && i.r === rgb[0] && i.g === rgb[1] && i.b === rgb[2]),
    "no presence instance emitted for a player whose name matches the injected ownPlayerName");
});
section("presenceBudget: caps a pathological drag rect at PRESENCE_DRAG_MAX_TILES", () => {
  const huge = [{ name: "x", x: 0, y: 0, drag: true, dx: 999, dy: 999 }];
  const budget = GL.presenceBudget(huge);
  assert.equal(budget, 1 + GL.PRESENCE_DRAG_MAX_TILES, "budget clamps the drag area, never scales with dx*dy unbounded");
});
section("emitPresence: a pathological drag rect never emits more than PRESENCE_DRAG_MAX_TILES fill instances", () => {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {}, ownPlayerName: "me" });
  const view = {
    origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [tile({})],
    players: [{ name: "eve", x: 0, y: 0, z: 0, drag: true, dx: 200, dy: 200 }],
  };
  const r = b.buildScene(view);
  assert.ok(r.count <= 1 /* base+sprite for the lone tile is near-zero here */ + GL.PRESENCE_DRAG_MAX_TILES + 8,
    "a 201x201 drag rect never balloons past the capped instance budget (count=" + r.count + ")");
});

// =============================================================================================
// FRAG_SRC: MARKER-COLOR retired the ATTR_MARKER shader dim. The marker glyph recolour now rides
// the ordinary per-instance `texel * v_tint.rgb` path (the fitted MARKER_GLYPH_TINT), so the
// shader must NO LONGER carry the invented `base *= 0.6` marker branch.
// =============================================================================================
section("FRAG_SRC: the retired ATTR_MARKER `base *= 0.6` dim is gone (recolour is via instance tint)", () => {
  assert.doesNotMatch(GL.FRAG_SRC, /base \*= 0\.6/, "the invented marker-dim shader branch is removed");
  assert.doesNotMatch(GL.FRAG_SRC, /v_attr >> 8u/, "the shader no longer reads attr bit 8 (MARKER)");
  assert.match(GL.FRAG_SRC, /s\.rgb \* v_tint\.rgb/, "glyph recolour rides the ordinary texel*tint path");
});

section("FRAG_SRC: premultiplied fade -- sprite rgb is scaled by tint alpha, not just alpha", () => {
  // Regression guard for the WB-14 premultiplied-fade fix (see FRAG_SRC's own banner): a
  // translucent sprite instance (tint alpha < 1 -- floor-edge decals, z-faded units/
  // buildings) must scale its PREMULTIPLIED rgb by tint.a too, or the ONE/
  // ONE_MINUS_SRC_ALPHA blend effectively ADDS full-strength rgb over the backdrop
  // (measured live at S1: the whole "green terrain" GL-vs-canvas2d parity gap).
  assert.match(GL.FRAG_SRC, /s\.rgb \* v_tint\.rgb \* v_tint\.a, s\.a \* v_tint\.a/,
    "sprite branch multiplies rgb by v_tint.a (premultiplied fade)");
  assert.doesNotMatch(GL.FRAG_SRC, /base = s \* v_tint;/,
    "the pre-fix `base = s * v_tint` form must not reappear");
});

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nALL WB-14 OVERLAY CHECKS PASSED");
