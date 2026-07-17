// wc6_wc8_machine_test.mjs -- WC-6/WC-8 MACHINE-token acceptance (docs/superpowers/specs/
// 2026-07-07-WC-coverage-spec.md WC-6 server table + WC-8 client apply). Exercises the machine
// sprite resolver in BOTH renderers -- dwf-tiles.js (canvas2d) and dwf-gl.js (GL) --
// against the REAL committed web/building_map.json's `machines` section (WC-5), plus a GL
// end-to-end buildScene emit, plus TEST-THE-TEST seeded-bad cases (rule 3 of the completeness
// protocol: the assertions must FAIL on a deliberately-broken map / wrong-cell expectation).
//
// The machine MATRIX covered (direction x orientation x active-state x footprint):
//   ScrewPump      dir 0/1/2/3        -> SCREWPUMP_{N,E,S,W}   (1x2 / 2x1 linear-sub footprints)
//   WaterWheel     dir 0/1 (WE/NS)    -> WATER_WHEEL_{WE,NS}   (3x2 / 1x4 explicit-sub footprints)
//   Windmill       dir 0..7 (8-way)   -> WINDMILL_{N..NW}      (3x4)
//   AxleHorizontal dir 0/1 (WE/NS)    -> AXLE_HORIZONTAL_{WE,NS}
//   AxleVertical                       -> AXLE_VERTICAL          (1x1)
//   GearAssembly                       -> GEAR_ASSEMBLY          (1x1)
//   active (bst&1) x frameParity       -> frame 0 (rest/inactive) vs frame 1 (active,parity 1)
//
// Run: node tools/harness/wc6_wc8_machine_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const buildingMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/building_map.json"), "utf8"));

// ---- fixture-assumption guards (fail loudly if the committed map drifts) --------------------
assert.ok(buildingMap.machines && typeof buildingMap.machines === "object",
  "fixture assumption broken: building_map.json has no `machines` section (WC-5 generator half)");
for (const k of ["SCREWPUMP_N", "SCREWPUMP_E", "WATER_WHEEL_NS", "WATER_WHEEL_WE",
  "WINDMILL_N", "WINDMILL_NW", "AXLE_HORIZONTAL_NS", "AXLE_HORIZONTAL_WE", "AXLE_VERTICAL", "GEAR_ASSEMBLY"]) {
  const fam = buildingMap.machines[k];
  assert.ok(fam && Array.isArray(fam.frames) && fam.frames.length === 2 && fam.sheet,
    `fixture assumption broken: machines.${k} is not a 2-frame family with a sheet`);
}

// ---- independent expected-cells re-derivation (NOT calling the impl) ------------------------
// Re-implements the sub-cell placement rule from the spec so the test is a genuine oracle, not
// an echo of machineEntry(). A 2-element sub is [dx,dy]; a 1-element sub is a linear index laid
// out row-major within the building's footprint width; empty sub is (0,0).
function expectedCells(fam, frameIdx, fpw) {
  const frame = fam.frames[frameIdx];
  const placed = [];
  let gw = 1, gh = 1;
  for (const c of frame) {
    const s = c.sub || []; let dx, dy;
    if (s.length >= 2) { dx = s[0] | 0; dy = s[1] | 0; }
    else if (s.length === 1) { const idx = s[0] | 0; dx = idx % fpw; dy = Math.floor(idx / fpw); }
    else { dx = 0; dy = 0; }
    if (dx + 1 > gw) gw = dx + 1; if (dy + 1 > gh) gh = dy + 1;
    placed.push({ dx, dy, col: c.col, row: c.row });
  }
  const cells = [];
  for (let y = 0; y < gh; y++) { const row = []; for (let x = 0; x < gw; x++) row.push(null); cells.push(row); }
  for (const p of placed) cells[p.dy][p.dx] = { col: p.col, row: p.row };
  return { sheet: fam.sheet, w: gw, h: gh, cells };
}

function eqEntry(a, b) {
  if (!a || !b) return false;
  if (a.sheet !== b.sheet || a.w !== b.w || a.h !== b.h) return false;
  if (a.cells.length !== b.cells.length) return false;
  for (let y = 0; y < a.cells.length; y++) {
    if (a.cells[y].length !== b.cells[y].length) return false;
    for (let x = 0; x < a.cells[y].length; x++) {
      const ca = a.cells[y][x], cb = b.cells[y][x];
      if ((ca == null) !== (cb == null)) return false;
      if (ca && (ca.col !== cb.col || ca.row !== cb.row)) return false;
    }
  }
  return true;
}

let failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  - " + name);
  else { failed++; console.log("  FAIL- " + name); }
}

// =============================================================================================
// Load canvas2d (dwf-tiles.js) with DOM-less stubs -> _machineEntryForTest.
// =============================================================================================
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
globalThis.Image = class { set src(v) {} get src() { return ""; } };
globalThis.fetch = async (url) => (String(url).indexOf("building_map.json") !== -1)
  ? { ok: true, json: async () => buildingMap } : { ok: false, json: async () => null };

vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const DwfTiles = globalThis.DwfTiles;
assert.ok(DwfTiles, "dwf-tiles.js did not install window.DwfTiles");
const tilesApi = DwfTiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
assert.ok(tilesApi && typeof tilesApi._machineEntryForTest === "function", "canvas2d _machineEntryForTest hook missing");
assert.ok(typeof tilesApi._machineFrameParityForTest === "function", "canvas2d _machineFrameParityForTest hook missing");
assert.ok(typeof tilesApi._machineCadenceStepForTest === "function", "canvas2d _machineCadenceStepForTest hook missing");
assert.ok(typeof tilesApi._hasDrawableMachineForTest === "function", "canvas2d _hasDrawableMachineForTest hook missing");
const c2dMachine = tilesApi._machineEntryForTest;

function loadTilesApiInSandbox(search) {
  const ctx = { console, URLSearchParams, Date, Math, Number, Proxy };
  ctx.window = ctx;
  ctx.location = { search, protocol: "http:", host: "localhost:8765" };
  ctx.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
  ctx.addEventListener = () => {};
  ctx.sessionStorage = { getItem: () => null, setItem: () => {} };
  ctx.localStorage = { getItem: () => null, setItem: () => {} };
  ctx.Image = class { set src(v) {} get src() { return ""; } };
  ctx.fetch = async (url) => (String(url).indexOf("building_map.json") !== -1)
    ? { ok: true, json: async () => buildingMap } : { ok: false, json: async () => null };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), ctx, { filename: "dwf-tiles.js" });
  const api = ctx.DwfTiles && ctx.DwfTiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
  assert.ok(api, "sandboxed dwf-tiles.js did not initialize");
  return api;
}

// =============================================================================================
// Load GL (dwf-gl.js) in a vm context -> builder._machineEntryForTest + end-to-end emit.
// =============================================================================================
let fakeNow = null;
class FakeDate extends Date { static now() { return fakeNow === null ? Date.now() : fakeNow; } }
const sandbox = {}; sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
sandbox.Date = FakeDate;
vm.createContext(sandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
const GL = sandbox.DwfGL;
assert.ok(GL, "dwf-gl.js did not export DwfGL");
function makeAtlas() { const ids = new Map(); let n = 1; return { resolve(s, c, r) { const k = s + "|" + c + "|" + r; if (!ids.has(k)) ids.set(k, n++); return ids.get(k); } }; }
function makeFakeGL() {
  const noop = () => {};
  return {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, UNIFORM_BUFFER: 6, DYNAMIC_DRAW: 7, FLOAT: 8, UNSIGNED_SHORT: 9,
    UNSIGNED_BYTE: 10, INVALID_INDEX: 0xFFFFFFFF, COLOR_BUFFER_BIT: 0x4000,
    TEXTURE0: 0, TEXTURE_2D_ARRAY: 11, BLEND: 12, ONE: 1, ONE_MINUS_SRC_ALPHA: 13,
    TRIANGLES: 14, drawingBufferWidth: 64, drawingBufferHeight: 64,
    createShader: () => ({}), shaderSource: noop, compileShader: noop, getShaderParameter: () => true,
    getShaderInfoLog: () => "", deleteShader: noop, createProgram: () => ({}), attachShader: noop,
    linkProgram: noop, getProgramParameter: () => true, getProgramInfoLog: () => "", deleteProgram: noop,
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: noop, bindBuffer: noop,
    enableVertexAttribArray: noop, vertexAttribPointer: noop, vertexAttribDivisor: noop,
    vertexAttribIPointer: noop, bufferData: noop, getUniformBlockIndex: () => 0xFFFFFFFF,
    uniformBlockBinding: noop, bindBufferBase: noop, getUniformLocation: () => ({}), bufferSubData: noop,
    viewport: noop, clearColor: noop, clear: noop, useProgram: noop, activeTexture: noop,
    bindTexture: noop, uniform1i: noop, uniform2f: noop, uniform3f: noop, uniform1f: noop,
    enable: noop, blendFunc: noop, drawArraysInstanced: noop, deleteBuffer: noop, deleteVertexArray: noop,
  };
}
const glBuilder = GL.createSceneBuilder({ atlas: makeAtlas(), buildingMap });
assert.ok(typeof glBuilder._machineEntryForTest === "function", "GL _machineEntryForTest hook missing");
const glMachine = glBuilder._machineEntryForTest;

// =============================================================================================
// (1) THE MATRIX: each machine cell, both renderers, inactive (frame 0) resolution vs the
// independently re-derived expected grid; canvas2d and GL agree byte-for-byte.
// =============================================================================================
const MATRIX = [
  // [type, dir, footprint w,h, expected family key]
  ["ScrewPump", 0, 1, 2, "SCREWPUMP_N"],
  ["ScrewPump", 1, 2, 1, "SCREWPUMP_E"],
  ["ScrewPump", 2, 1, 2, "SCREWPUMP_S"],
  ["ScrewPump", 3, 2, 1, "SCREWPUMP_W"],
  ["WaterWheel", 0, 3, 2, "WATER_WHEEL_WE"],
  ["WaterWheel", 1, 1, 4, "WATER_WHEEL_NS"],
  ["Windmill", 0, 3, 3, "WINDMILL_N"],
  ["Windmill", 1, 3, 3, "WINDMILL_NE"],
  ["Windmill", 2, 3, 3, "WINDMILL_E"],
  ["Windmill", 3, 3, 3, "WINDMILL_SE"],
  ["Windmill", 4, 3, 3, "WINDMILL_S"],
  ["Windmill", 5, 3, 3, "WINDMILL_SW"],
  ["Windmill", 6, 3, 3, "WINDMILL_W"],
  ["Windmill", 7, 3, 3, "WINDMILL_NW"],
  ["AxleHorizontal", 0, 3, 1, "AXLE_HORIZONTAL_WE"],
  ["AxleHorizontal", 1, 1, 3, "AXLE_HORIZONTAL_NS"],
  ["AxleVertical", 0, 1, 1, "AXLE_VERTICAL"],
  ["GearAssembly", 0, 1, 1, "GEAR_ASSEMBLY"],
];
console.log("MATRIX (inactive/frame-0, both renderers vs independent oracle):");
for (const [type, dir, w, h, key] of MATRIX) {
  const b = { type, dir, bst: 0, x1: 10, y1: 10, x2: 10 + w - 1, y2: 10 + h - 1, z: 150 };
  const exp = expectedCells(buildingMap.machines[key], 0, w);
  const c2d = c2dMachine(b, buildingMap, 0);
  const gl = glMachine(b, buildingMap, 0);
  check(`${type} dir=${dir} -> ${key}: canvas2d matches oracle`, eqEntry(c2d, exp));
  check(`${type} dir=${dir} -> ${key}: GL matches oracle`, eqEntry(gl, exp));
  check(`${type} dir=${dir} -> ${key}: canvas2d==GL`, eqEntry(c2d, gl));
}

// =============================================================================================
// (2) ACTIVE-STATE ANIMATION: active (bst&1) + parity=1 -> frame 1; active + parity=0 -> frame
// 0; INACTIVE always frame 0 regardless of parity (spec WC-8: "frozen frame when active=0").
// =============================================================================================
console.log("ANIMATION (frame selection by active + parity):");
{
  const w = 1, h = 4, key = "WATER_WHEEL_NS";
  const base = { type: "WaterWheel", dir: 1, x1: 5, y1: 5, x2: 5, y2: 8, z: 150 };
  const f0 = expectedCells(buildingMap.machines[key], 0, w);
  const f1 = expectedCells(buildingMap.machines[key], 1, w);
  check("frame 0 and frame 1 actually differ (animation is real)", !eqEntry(f0, f1));
  check("active + parity1 -> frame 1 (canvas2d)", eqEntry(c2dMachine(Object.assign({ bst: 1 }, base), buildingMap, 1), f1));
  check("active + parity1 -> frame 1 (GL)", eqEntry(glMachine(Object.assign({ bst: 1 }, base), buildingMap, 1), f1));
  check("active + parity0 -> frame 0 (canvas2d)", eqEntry(c2dMachine(Object.assign({ bst: 1 }, base), buildingMap, 0), f0));
  check("INACTIVE + parity1 -> frame 0 (canvas2d)", eqEntry(c2dMachine(Object.assign({ bst: 0 }, base), buildingMap, 1), f0));
  check("INACTIVE + parity1 -> frame 0 (GL)", eqEntry(glMachine(Object.assign({ bst: 0 }, base), buildingMap, 1), f0));
}


// =============================================================================================
// (2b) CADENCE DRIVER: frame parity flips on the shared 500 ms Date-clock beat, but repaint
// scheduling is gated to drawable-and-active machines only. This is the idle-perf guard: no
// active machine means no phase wakeups. The seeded-bad check proves an implementation that only
// checks machine type (ignoring bst&1) would be caught.
// =============================================================================================
console.log("CADENCE DRIVER (active-only machine repaint beat):");
{
  const activeMachine = [{ type: "GearAssembly", bst: 1, x1: 1, y1: 1, x2: 1, y2: 1, z: 1 }];
  const inactiveMachine = [{ type: "GearAssembly", bst: 0, x1: 1, y1: 1, x2: 1, y2: 1, z: 1 }];
  const noMachines = [{ type: "Workshop", bst: 1, x1: 1, y1: 1, x2: 1, y2: 1, z: 1 }];
  const c2dStep = tilesApi._machineCadenceStepForTest;
  const glStep = GL.machineCadenceStepGL;

  check("shared beat constant is 500 ms", GL.MACHINE_ANIM_MS === 500);
  check("canvas2d parity: 0ms/499ms frame 0, 500ms frame 1",
    tilesApi._machineFrameParityForTest(0) === 0 && tilesApi._machineFrameParityForTest(499) === 0 &&
    tilesApi._machineFrameParityForTest(500) === 1);
  check("GL parity matches canvas2d at the same fake-clock beats",
    GL.machineFrameParityGL(0, false) === tilesApi._machineFrameParityForTest(0) &&
    GL.machineFrameParityGL(499, false) === tilesApi._machineFrameParityForTest(499) &&
    GL.machineFrameParityGL(500, false) === tilesApi._machineFrameParityForTest(500));

  let c = c2dStep(activeMachine, 0, -1, false);
  let g = glStep(activeMachine, 0, -1, false);
  check("active machine schedules initial phase repaint (canvas2d)", c.dirty && c.phase === 0);
  check("active machine schedules initial phase repaint (GL)", g.dirty && g.phase === 0);
  check("same active-machine phase does not reschedule (canvas2d)", !c2dStep(activeMachine, 250, 0, false).dirty);
  check("same active-machine phase does not reschedule (GL)", !glStep(activeMachine, 250, 0, false).dirty);
  check("active machine schedules repaint on the 500ms beat (canvas2d)", c2dStep(activeMachine, 500, 0, false).dirty);
  check("active machine schedules repaint on the 500ms beat (GL)", glStep(activeMachine, 500, 0, false).dirty);

  check("inactive machine is not drawable for cadence (canvas2d)", !tilesApi._hasDrawableMachineForTest(inactiveMachine));
  check("inactive machine is not drawable for cadence (GL)", !glBuilder._hasDrawableMachineForTest(inactiveMachine));
  check("inactive machine never schedules repaint (canvas2d control)", !c2dStep(inactiveMachine, 500, 0, false).dirty && c2dStep(inactiveMachine, 500, 0, false).phase === -1);
  check("inactive machine never schedules repaint (GL control)", !glStep(inactiveMachine, 500, 0, false).dirty && glStep(inactiveMachine, 500, 0, false).phase === -1);
  check("no-machines scene schedules zero repaints (canvas2d idle-perf guard)", !c2dStep(noMachines, 500, 0, false).dirty && c2dStep(noMachines, 500, 0, false).phase === -1);
  check("no-machines scene schedules zero repaints (GL idle-perf guard)", !glStep(noMachines, 500, 0, false).dirty && glStep(noMachines, 500, 0, false).phase === -1);

  const seededBadIgnoresActive = (buildings, nowMs, lastPhase) => {
    const anyMachine = Array.isArray(buildings) && buildings.some((b) => b && b.type === "GearAssembly");
    const phase = Math.floor(nowMs / 500);
    return { phase: anyMachine ? phase : -1, dirty: anyMachine && phase !== lastPhase };
  };
  check("SEEDED BAD: driver ignoring bst&1 would wake an inactive machine", seededBadIgnoresActive(inactiveMachine, 500, 0).dirty);
  check("real drivers reject the seeded-bad inactive wake", !c2dStep(inactiveMachine, 500, 0, false).dirty && !glStep(inactiveMachine, 500, 0, false).dirty);

  const frozenTiles = loadTilesApiInSandbox("?freezeAnim=1");
  check("?freezeAnim=1 freezes canvas2d machine parity at frame 0", frozenTiles._machineFrameParityForTest(500) === 0 && frozenTiles._machineFrameParityForTest(1500) === 0);
  check("freeze gate suppresses canvas2d cadence repaint", !c2dStep(activeMachine, 500, 0, true).dirty);
  check("freeze gate suppresses GL cadence repaint + parity", !glStep(activeMachine, 500, 0, true).dirty && GL.machineFrameParityGL(500, true) === 0);

  const viewBase = { origin: { x: 0, y: 0, z: 1 }, width: 1, height: 1,
    tiles: [{ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false }] };
  fakeNow = 0;
  const renderer = GL.create(makeFakeGL(), { atlas: makeAtlas(), buildingMap });
  renderer.buildScene(Object.assign({}, viewBase, { buildings: activeMachine }));
  fakeNow = 250; renderer.render(250);
  const beforeBeat = renderer.getStats();
  fakeNow = 500; renderer.render(500);
  const afterBeat = renderer.getStats();
  check("GL renderer wrapper rebuilds ONLY the building segment on active-machine beat",
    beforeBeat.sceneBuildCount === 1 && afterBeat.sceneBuildCount === 1 &&
    beforeBeat.buildingBuildCount === 0 && afterBeat.buildingBuildCount === 1);

  fakeNow = 0;
  const idleRenderer = GL.create(makeFakeGL(), { atlas: makeAtlas(), buildingMap });
  idleRenderer.buildScene(Object.assign({}, viewBase, { buildings: noMachines }));
  fakeNow = 500; idleRenderer.render(500);
  check("GL renderer wrapper does not rebuild no-machine scene on beat", idleRenderer.getStats().sceneBuildCount === 1);

  fakeNow = 0;
  const frozenRenderer = GL.create(makeFakeGL(), { atlas: makeAtlas(), buildingMap, freezeAnim: true });
  frozenRenderer.buildScene(Object.assign({}, viewBase, { buildings: activeMachine }));
  fakeNow = 500; frozenRenderer.render(500);
  check("GL renderer wrapper does not rebuild while freezeAnim is set", frozenRenderer.getStats().sceneBuildCount === 1);
  fakeNow = null;
}

// =============================================================================================
// (3) GL END-TO-END: buildScene with a live ScrewPump_N emits the exact 2 stacked sub-cells at
// the right grid positions (proves the synthesized entry flows through emitBuilding untouched).
// =============================================================================================
console.log("GL END-TO-END (buildScene emit):");
{
  const atlas = makeAtlas();
  const b2 = GL.createSceneBuilder({ atlas, buildingMap });
  const gw = 4, gh = 6;
  const tiles = new Array(gw * gh).fill(0).map(() => ({ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false }));
  const view = { origin: { x: 10, y: 10, z: 150 }, width: gw, height: gh, tiles, freezeAnim: true,
    buildings: [{ type: "ScrewPump", dir: 0, bst: 1, x1: 11, y1: 11, x2: 11, y2: 12, z: 150 }] };
  b2.buildScene(view);
  const buf = b2.buffer, n = b2.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf);
  const inst = [];
  for (let k = 0; k < n; k++) inst.push({ x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4] });
  const fam = buildingMap.machines["SCREWPUMP_N"];
  // freezeAnim -> parity 0 -> frame 0; footprint 1x2 -> sub idx 0 at (dx0,dy0), idx1 at (dx0,dy1)
  const exp0 = expectedCells(fam, 0, 1);
  const top = exp0.cells[0][0], bot = exp0.cells[1][0];
  const cellTop = atlas.resolve(fam.sheet, top.col, top.row);
  const cellBot = atlas.resolve(fam.sheet, bot.col, bot.row);
  // R1 world coords: the scene origin no longer changes instance positions.
  check("GL emits screwpump top cell at world (11,11)", inst.some((i) => i.x === 11 && i.y === 11 && i.cell === cellTop));
  check("GL emits screwpump bottom cell at world (11,12)", inst.some((i) => i.x === 11 && i.y === 12 && i.cell === cellBot));
  check("GL screwpump top!=bottom cell (real vertical footprint, not one repeated cell)", cellTop !== cellBot);
}

// =============================================================================================
// (4) TEST-THE-TEST (rule 3): the resolver returns null (-> caller falls back) for a broken map
// / non-machine type, and the oracle assertion FAILS on a deliberately-wrong expected cell.
// =============================================================================================
console.log("TEST-THE-TEST (seeded-bad cases must behave):");
{
  const b = { type: "ScrewPump", dir: 0, bst: 0, x1: 1, y1: 1, x2: 1, y2: 2, z: 1 };
  // (a) non-machine type -> null (fallback to buildingEntry).
  check("non-machine type 'Workshop' -> null (canvas2d)", c2dMachine({ type: "Workshop", x1: 1, y1: 1, x2: 1, y2: 1 }, buildingMap, 0) === null);
  check("non-machine type 'Workshop' -> null (GL)", glMachine({ type: "Workshop", x1: 1, y1: 1, x2: 1, y2: 1 }, buildingMap, 0) === null);
  // (b) machines section missing / family empty -> null.
  check("no machines section -> null (canvas2d)", c2dMachine(b, { machines: null }, 0) === null);
  const brokenMap = { machines: Object.assign({}, buildingMap.machines, { SCREWPUMP_N: { sheet: "x.png", frames: [] } }) };
  check("empty frames family -> null (canvas2d)", c2dMachine(b, brokenMap, 0) === null);
  check("empty frames family -> null (GL)", glMachine(b, brokenMap, 0) === null);
  // (c) the oracle itself has teeth: a WRONG expected cell must NOT eqEntry the real resolution.
  const good = c2dMachine(b, buildingMap, 0);
  const wrong = JSON.parse(JSON.stringify(good));
  wrong.cells[0][0] = { col: good.cells[0][0].col + 999, row: good.cells[0][0].row };
  check("SEEDED BAD: a mutated (+999 col) expected cell does NOT match (eqEntry has teeth)", !eqEntry(good, wrong));
}

// =============================================================================================
// (5) B31 REGRESSION (GL half): "all wood textures replaced with seeds". A WOOD item carries a
// plant identity (wood is plant-material) but must resolve to the generic WOOD/log cell, NEVER
// the species' SEED cell. Asserts the GL resolveIdentityEntryGL fix (parity with canvas2d's
// wc3_we4_wc12_apply_test.mjs B31 section). OAK is the trigger: its plant_map entry has ONLY a
// SEED key, so the old fall-through landed on the seed cell.
// =============================================================================================
console.log("B31 (GL): wood-with-plant-ident must NOT resolve to a seed cell:");
{
  const plantMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/plant_map.json"), "utf8"));
  const itemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
  const oakSeed = plantMap.OAK && plantMap.OAK.SEED;
  const woodLog = itemMap.bytype && itemMap.bytype.WOOD;
  check("[fixture guard] OAK has a SEED cell + item_map.bytype.WOOD exists", !!oakSeed && !!woodLog);
  const b = GL.createSceneBuilder({ atlas: makeAtlas(), buildingMap, plantMap, itemMap });
  assert.ok(typeof b._resolveIdentityEntryForTest === "function", "GL _resolveIdentityEntryForTest hook missing");
  const glWood = b._resolveIdentityEntryForTest({ type: "WOOD", mat_type: 420, subtype: -1, identKind: 1, ident: "OAK" });
  check("GL: WOOD+OAK identity resolves to null (falls through to generic bytype.WOOD log art)", glWood === null);
  check("[test-the-test] GL: WOOD+OAK is NOT OAK's SEED cell (the regression would have returned it)",
    glWood === null || (glWood.sheet !== oakSeed.sheet || glWood.col !== oakSeed.col || glWood.row !== oakSeed.row));
  // and the per-species SEED path STILL works for a real SEEDS item (fix didn't over-reach).
  const glSeed = b._resolveIdentityEntryForTest({ type: "SEEDS", mat_type: -1, subtype: -1, identKind: 1, ident: "OAK" });
  check("GL: a real SEEDS+OAK item STILL resolves to OAK's SEED cell (fix scoped to non-plant-sprite types)",
    !!glSeed && !!oakSeed && glSeed.sheet === oakSeed.sheet && glSeed.col === oakSeed.col && glSeed.row === oakSeed.row);
}

// TX13: MEAT resolves its creature-local material slot to graphics_bodyparts art, never the
// creature cell or missing box. GLOB identity gating is unchanged.
console.log("TX13 (GL): MEAT -> raws-derived bodypart (not creature, not box); GLOB gated:");
{
  const itemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
  const creaturesMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/creatures_map.json"), "utf8"));
  const aardvark = creaturesMap.races && creaturesMap.races.AARDVARK;
  assert.ok(aardvark && aardvark.sheet, "[fixture guard] creatures_map.json AARDVARK is a flat race");
  const b = GL.createSceneBuilder({ atlas: makeAtlas(), buildingMap, itemMap, creaturesMap });
  const glMeatId = b._resolveIdentityEntryForTest({ type: "MEAT", mat_type: 21, subtype: -1, identKind: 2, ident: "AARDVARK" });
  check("GL [TX13]: MEAT does not resolve via the creature-identity path", !glMeatId);
  const glMeatVis = b._resolveItemVisualForTest({ type: "MEAT", mat_type: 21, subtype: -1, identKind: 2, ident: "AARDVARK" });
  const meatCell = itemMap.creature_food.cells["MEAT:STANDARD"];
  check("GL [TX13]: MEAT resolves to the raws-derived standard-meat bodypart cell",
    !!glMeatVis && glMeatVis.source === "creaturefood" && !!glMeatVis.entry &&
    glMeatVis.entry.sheet === meatCell.sheet && glMeatVis.entry.col === meatCell.col && glMeatVis.entry.row === meatCell.row);
  check("GL [test-the-test][TX13]: MEAT does NOT resolve to AARDVARK's flat cell",
    !!glMeatVis && !!glMeatVis.entry && !(glMeatVis.entry.sheet === aardvark.sheet &&
      glMeatVis.entry.col === aardvark.col && glMeatVis.entry.row === aardvark.row));
  check("GL [test-the-test][TX13]: MEAT does NOT fall to the _missing box",
    !!glMeatVis && glMeatVis.source !== "missing");
  const glGlob = b._resolveIdentityEntryForTest({ type: "GLOB", mat_type: -1, subtype: -1, identKind: 2, ident: "AARDVARK" });
  check("GL [test-the-test][B30]: GLOB+creature token does NOT resolve to the creature cell (tallow gating preserved)",
    !glGlob || glGlob.sheet !== aardvark.sheet || glGlob.col !== aardvark.col || glGlob.row !== aardvark.row);
  // EGG (GL parity, Phase-3 sweep): an EGG item carrying the laying creature's race must NOT
  // resolve via the creature-identity path (pre-fix it drew the live creature / nothing). The GL
  // identity hook returns null for EGG post-fix, so the generic chain paints item_map.bytype.EGG.
  const glEgg = b._resolveIdentityEntryForTest({ type: "EGG", mat_type: -1, subtype: -1, identKind: 2, ident: "AARDVARK" });
  check("GL [EGG]: an EGG+creature token does NOT resolve via the identity path (falls through to the generic egg cell)",
    !glEgg);
  check("GL [test-the-test][EGG]: the EGG identity result is NOT the live AARDVARK cell (pre-fix creature wrong-art would have matched here)",
    !glEgg || glEgg.sheet !== aardvark.sheet || glEgg.col !== aardvark.col || glEgg.row !== aardvark.row);
}

console.log(failed === 0 ? "\nALL MACHINE + B31 TESTS PASS" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
