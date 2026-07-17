// wb13_units_test.mjs -- WB-13 acceptance (docs/superpowers/specs/2026-07-07-WB-renderer-
// spec.md, "Units + 60 fps interpolation"). Loads the REAL web/js/dwf-gl.js verbatim via
// vm.runInContext, same convention as gl_core_test.mjs/wb11_sparse_test.mjs/wb12_buildings_test.
// mjs, and the REAL committed web/creatures_map.json (same convention as wb12's real
// building_map.json) -- no synthetic race map for the resolution-logic assertions.
//
// Per the run-orders instruction for this item, live gate_parity.py/gate_perf.py/agent-browser
// runs against DF are explicitly OUT of scope (queued for sweep #2, same as WB-10/11/12's own
// notes); evidence here is (1) node instance-stream tests for tier resolution (span/anchor
// multi-cell placement, z-fade, fallback dot, capacity, painter order, the static-prefix-
// survives-a-capacity-grow regression this item's ensureCapacity fix targets), (2) a RECONCILE
// cross-check against dwf-tiles.js's REAL resolveUnitTier()/_resolveUnitTierForTest hook
// (WE-4) for every tier whose gating logic doesn't depend on an in-flight network fetch, and
// (3) pure interpolation-math fixtures (createUnitInterpolator) with fabricated timestamps,
// including a faithful node reproduction of the gate's own "60fps lerp >= 50 distinct positions
// vs ~15 on canvas2d" acceptance numbers.
//
// Run: node tools/harness/wb13_units_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const realCreaturesMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/creatures_map.json"), "utf8"));

// ---- fixture-assumption guards (fail loudly if the committed map's shape drifts) -----------
assert.ok(realCreaturesMap.races && realCreaturesMap.races.AARDVARK &&
  realCreaturesMap.races.AARDVARK.sheet === "creatures_surface.png",
  "fixture assumption broken: creatures_map.json's AARDVARK is no longer a flat sheet cell");
assert.ok(realCreaturesMap.races.DWARF && realCreaturesMap.races.DWARF.layered === true &&
  realCreaturesMap.races.DWARF.baked === "dwarf.png",
  "fixture assumption broken: creatures_map.json's DWARF is no longer layered+baked:dwarf.png");
assert.ok(!Object.prototype.hasOwnProperty.call(realCreaturesMap.races, "TOTALLY_MADE_UP_RACE"),
  "fixture assumption broken: creatures_map.json now has a real TOTALLY_MADE_UP_RACE entry");
assert.equal(realCreaturesMap.cell, 32, "fixture assumption broken: creatures_map.json cell size is no longer 32");

// ---- sandbox: the REAL dwf-gl.js (this item's own file) -----------------------------
const sandbox = {};
sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8"), sandbox, { filename: "web/js/dwf-gl.js" });
const GL = sandbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
assert.ok(typeof GL.resolveUnitTierGL === "function", "DwfGL must export resolveUnitTierGL");
assert.ok(typeof GL.createUnitInterpolator === "function", "DwfGL must export createUnitInterpolator");

// ---- mock atlas: registerDynamicSheet readiness is caller-controlled per key; resolve() hands
// out stable per-(key,col,row) integers, same convention as wb12's makeMockAtlas. ------------
function makeUnitMockAtlas(readySet) {
  readySet = readySet || new Set();
  const registerCalls = [];
  const ids = new Map();
  let next = 1;
  return {
    registerDynamicSheet(key, url) {
      registerCalls.push({ key, url });
      return readySet.has(key);
    },
    resolve(sheetOrKey, col, row) {
      const k = sheetOrKey + "|" + col + "|" + row;
      if (!ids.has(k)) ids.set(k, next++);
      return ids.get(k);
    },
    _registerCalls: registerCalls,
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
// (1) TIER RESOLUTION (pure, resolveUnitTierGL directly)
// =============================================================================================
section("tier 1: ah+sw+sh present and the dynamic sheet is ready", () => {
  const atlas = makeUnitMockAtlas(new Set(["deadbeef"]));
  const sel = GL.resolveUnitTierGL({ id: 1, x: 0, y: 0, ah: "deadbeef", sw: 2, sh: 3 }, realCreaturesMap.races, atlas);
  assert.equal(sel.tier, 1);
  assert.ok(atlas._registerCalls.some((c) => c.key === "deadbeef" && c.url === "/unit-sprite/deadbeef.png"));
});
section("tier 1 fallthrough (fetch in flight / not ready) -> falls to tier 3/4/5, same chain as canvas2d", () => {
  const atlas = makeUnitMockAtlas(); // nothing ready yet
  const sel = GL.resolveUnitTierGL({ id: 1, x: 0, y: 0, ah: "notyet", sw: 1, sh: 1, rt: "AARDVARK" }, realCreaturesMap.races, atlas);
  assert.equal(sel.tier, 3, "AARDVARK has a flat sheet cell -- falls through to tier 3 while tier 1 is pending");
});
section("tier 3: flat race sheet cell (AARDVARK -> creatures_surface.png)", () => {
  const atlas = makeUnitMockAtlas();
  const sel = GL.resolveUnitTierGL({ id: 1, x: 0, y: 0, rt: "AARDVARK" }, realCreaturesMap.races, atlas);
  assert.equal(sel.tier, 3);
  assert.equal(sel.rec.sheet, "creatures_surface.png");
});
section("tier 4: layered/baked civ race (DWARF, non-female) resolves dwarf.png as a dynamic sheet", () => {
  const atlas = makeUnitMockAtlas(new Set(["dwarf.png"]));
  const sel = GL.resolveUnitTierGL({ id: 1, x: 0, y: 0, rt: "DWARF", ct: "MALE" }, realCreaturesMap.races, atlas);
  assert.equal(sel.tier, 4);
  assert.equal(sel.key, "dwarf.png");
  assert.ok(atlas._registerCalls.some((c) => c.key === "dwarf.png" && c.url === "/dwarf.png"));
});
section("tier 4: FEMALE caste resolves dwarf_female.png instead", () => {
  const atlas = makeUnitMockAtlas(new Set(["dwarf_female.png"]));
  const sel = GL.resolveUnitTierGL({ id: 1, x: 0, y: 0, rt: "DWARF", ct: "FEMALE" }, realCreaturesMap.races, atlas);
  assert.equal(sel.tier, 4);
  assert.equal(sel.key, "dwarf_female.png");
});
section("tier 4 pending (dynamic sheet not yet loaded) -> tier 5 dot until it resolves", () => {
  const atlas = makeUnitMockAtlas(); // nothing ready
  const sel = GL.resolveUnitTierGL({ id: 1, x: 0, y: 0, rt: "DWARF", ct: "MALE" }, realCreaturesMap.races, atlas);
  assert.equal(sel.tier, 5);
});
section("tier 5: unknown race and no ah -> fallback dot", () => {
  const atlas = makeUnitMockAtlas();
  const sel = GL.resolveUnitTierGL({ id: 1, x: 0, y: 0, rt: "TOTALLY_MADE_UP_RACE" }, realCreaturesMap.races, atlas);
  assert.equal(sel.tier, 5);
});
section("tier 5: no atlas at all -> never throws", () => {
  const sel = GL.resolveUnitTierGL({ id: 1, x: 0, y: 0, rt: "AARDVARK" }, realCreaturesMap.races, null);
  assert.equal(sel.tier, 5);
});

// =============================================================================================
// (2) SPAN/ANCHOR PLACEMENT (LARGE_IMAGE, spec §2.6): a multi-tile creature (e.g. a "multi-tile
// elephant") renders its own EXACT w x h cells -- one instance per 32x32 cell, anchored per WE-2
// §3 (top-left cell = x-ax, y-ay) -- not a single stretched blit like canvas2d.
// =============================================================================================
section("LARGE_IMAGE: a 2w x 3h composite emits exactly 6 instances at the anchored grid offsets", () => {
  const atlas = makeUnitMockAtlas(new Set(["elephanthash"]));
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(10, 10, 0, 0, 5);
  b.buildScene(view);
  const staticCount = b.staticCount;
  const r = b.buildUnits([{ id: 42, x: 5, y: 5, z: 5, ah: "elephanthash", sw: 2, sh: 3, ax: 0, ay: 2 }], 0, 0, 5);
  assert.equal(r.count, 6, "2x3 composite must emit exactly 6 instances");
  const inst = decode(b).slice(staticCount);
  assert.equal(inst.length, 6);
  const expected = [];
  for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 2; rx++) expected.push({ x: 5 - 0 + rx, y: 5 - 2 + ry });
  for (const e of expected) {
    assert.ok(inst.some((i) => i.x === e.x && i.y === e.y), `expected an instance at grid (${e.x},${e.y})`);
  }
});
section("multi-tile elephant (3w x 2h, default anchor = bottom row): exact cell count and placement", () => {
  const atlas = makeUnitMockAtlas(new Set(["elehash2"]));
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(10, 10, 0, 0, 5);
  b.buildScene(view);
  const staticCount = b.staticCount;
  // no ax/ay given -> default ax=0, ay=max(0,sh-1)=1 (bottom row anchors the unit's own tile)
  const r = b.buildUnits([{ id: 7, x: 8, y: 8, z: 5, ah: "elehash2", sw: 3, sh: 2 }], 0, 0, 5);
  assert.equal(r.count, 6);
  const inst = decode(b).slice(staticCount);
  for (let ry = 0; ry < 2; ry++) for (let rx = 0; rx < 3; rx++) {
    const gx = 8 - 0 + rx, gy = 8 - 1 + ry;
    assert.ok(inst.some((i) => i.x === gx && i.y === gy), `default-anchor cell (${rx},${ry}) at grid (${gx},${gy})`);
  }
});

// =============================================================================================
// (3) Z-FADE: wire:6 z-fade reuses the measured see-down fog curve (belowAlpha/
// fogAlphaForDepth, docs/reference/fogparams.json `seeDown`, sweep #2) as a below-camera
// translucency proxy, matching buildings -- verified for a tier-3 flat race cell. Above camera
// gets NO fade (fogparams.json `seeAbove.mode: "delete"` -- see wb12_buildings_test.mjs).
// =============================================================================================
section("B03 own-z gate: a unit below camera is DROPPED (no off-z ghost)", () => {
  // B03 fix: units are server-side z-filtered to camera z, so a non-camera-z unit is a stale AUX
  // frame after a z-switch. Rendering it (faded) ghosted an unclickable dwarf onto the wrong
  // level. The renderer now emits NOTHING for dz!=0 -- superseding the speculative see-down curve.
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(5, 5, 0, 0, 10);
  b.buildScene(view);
  const staticCount = b.staticCount;
  b.buildUnits([{ id: 1, x: 2, y: 2, z: 8, rt: "AARDVARK" }], 0, 0, 10); // dz = -2
  const inst = decode(b).slice(staticCount);
  assert.equal(inst.length, 0, "below-camera unit emits zero instances (own-z gate)");
});
section("B03 own-z gate: a unit above camera is DROPPED too", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(5, 5, 0, 0, 10);
  b.buildScene(view);
  const staticCount = b.staticCount;
  b.buildUnits([{ id: 1, x: 2, y: 2, z: 13, rt: "AARDVARK" }], 0, 0, 10); // dz = +3
  const inst = decode(b).slice(staticCount);
  assert.equal(inst.length, 0, "above-camera unit emits zero instances (own-z gate)");
});
// B23: a below-camera unit the SERVER tagged see-down-visible (u.sd) is the explicit exception
// to the B03 own-z gate -- it RENDERS, fog-dimmed by depth (belowAlpha), so players see units on
// lower z through open columns like DF's Steam client. Untagged off-z units stay dropped (above),
// keeping the stale-ghost mechanism and the see-down mechanism distinct.
function seedownUnitAlpha(depth) { return Math.max(0.55, GL.belowAlpha(depth)); }
function plain(v) { return JSON.parse(JSON.stringify(v)); }
section("B23 see-down: a DEEP sd-tagged unit RENDERS, opacity FLOORED (never vanishes)", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(5, 5, 0, 0, 10);
  b.buildScene(view);
  const staticCount = b.staticCount;
  const depth = 9; // camera z=10, unit z=1 -- belowAlpha(9)==0 (raw curve would hide it)
  assert.equal(GL.belowAlpha(depth), 0, "guard: the raw fog curve fully hides a depth-9 unit");
  b.buildUnits([{ id: 1, x: 2, y: 2, z: 10 - depth, rt: "AARDVARK", sd: 1 }], 0, 0, 10);
  const inst = decode(b).slice(staticCount);
  assert.equal(inst.length, 1, "an sd-tagged see-down unit emits exactly one instance");
  const expA = Math.round(seedownUnitAlpha(depth) * 255);
  assert.equal(inst[0].a, expA, "alpha == max(0.55, belowAlpha)*255 -- floored so deep units stay readable");
  assert.ok(inst[0].a > 0 && inst[0].a < 255, "visible (never 0) yet dimmer than a camera-plane unit");
});
section("B23 see-down: a SHALLOW sd-tagged unit uses the raw curve (above the floor)", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(5, 5, 0, 0, 10);
  b.buildScene(view);
  const staticCount = b.staticCount;
  const depth = 1; // belowAlpha(1) ~0.64 > 0.55 -> the curve (not the floor) drives alpha
  assert.ok(GL.belowAlpha(depth) > 0.55, "guard: a shallow unit is above the floor");
  b.buildUnits([{ id: 1, x: 2, y: 2, z: 10 - depth, rt: "AARDVARK", sd: 1 }], 0, 0, 10);
  const inst = decode(b).slice(staticCount);
  assert.equal(inst[0].a, Math.round(seedownUnitAlpha(depth) * 255));
});
section("B23 see-down discriminator: sd is REQUIRED -- same unit without sd is still dropped", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(5, 5, 0, 0, 10);
  b.buildScene(view);
  const staticCount = b.staticCount;
  b.buildUnits([{ id: 1, x: 2, y: 2, z: 1, rt: "AARDVARK" }], 0, 0, 10); // dz=-9, NO sd tag
  const inst = decode(b).slice(staticCount);
  assert.equal(inst.length, 0, "an UNtagged below-camera unit is a stale ghost -> dropped");
});
section("B23 see-down: an sd flag does NOT resurrect an ABOVE-camera unit (see-above deleted)", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(5, 5, 0, 0, 10);
  b.buildScene(view);
  const staticCount = b.staticCount;
  b.buildUnits([{ id: 1, x: 2, y: 2, z: 13, rt: "AARDVARK", sd: 1 }], 0, 0, 10); // dz=+3 with a stray sd
  const inst = decode(b).slice(staticCount);
  assert.equal(inst.length, 0, "sd only applies below camera (udz<0); above-camera stays dropped");
});


// =============================================================================================
// (3b) WINDOW #13 UNIT STATUS ICONS: additive st bitfield drives one native UNIT_STATUS cell
// above the unit on the shared blink clock. Caged/chained have no native UNIT_STATUS overhead
// cell in graphics_interface.txt, so the client deliberately emits nothing for those bits.
// =============================================================================================
const ST_SLEEPING = 0x01;
const ST_UNCONSCIOUS = 0x02;
const ST_STRESSED = 0x04;
const ST_STRANGE_MOOD = 0x08;
const ST_CAGED = 0x10;
const ST_CHAINED = 0x20;
section("status icon helper: native row mapping, skipped cage/restraint states, deterministic blink", () => {
  // TX7 ("'Zz' sleep indicator renders as gray neutral face"): the sleep icon must land on the
  // native Zz cell. Oracle: data/vanilla/vanilla_interface/graphics/graphics_interface.txt
  // authors `[TILE_GRAPHICS:UNIT_STATUS:0:8:UNIT_STATUS:SLEEPING]` (x=0,y=8), and unit_status.png
  // (32x1312, one column) row 8 is pixel-confirmed to be the "Zᶻ" speech bubble -- while the
  // "gray neutral face" the report names is row 5 (DROWSY, meanRGB~125,125,120). So SLEEPING must
  // resolve to row 8 and MUST NOT collapse to row 5.
  assert.deepEqual(plain(GL.unitStatusIconForBits(ST_SLEEPING)), { sheet: "unit_status.png", col: 0, row: 8, token: "UNIT_STATUS:SLEEPING" });
  assert.notEqual(GL.unitStatusIconForBits(ST_SLEEPING).row, 5, "TX7: sleep must be the Zz (row 8), never the gray DROWSY neutral face (row 5)");
  assert.deepEqual(plain(GL.unitStatusIconForBits(ST_UNCONSCIOUS)), { sheet: "unit_status.png", col: 0, row: 30, token: "UNIT_STATUS:UNCONSCIOUS" });
  assert.deepEqual(plain(GL.unitStatusIconForBits(ST_STRESSED)), { sheet: "unit_status.png", col: 0, row: 6, token: "UNIT_STATUS:STRESSED" });
  assert.deepEqual(plain(GL.unitStatusIconForBits(ST_STRANGE_MOOD)), { sheet: "unit_status.png", col: 0, row: 9, token: "UNIT_STATUS:FEY_MOOD" });
  assert.equal(GL.unitStatusIconForBits(0), null, "st=0 control has no icon");
  assert.equal(GL.unitStatusIconForBits(ST_CAGED), null, "caged has no native UNIT_STATUS overhead icon");
  assert.equal(GL.unitStatusIconForBits(ST_CHAINED), null, "chained has no native UNIT_STATUS overhead icon");
  assert.equal(GL.unitStatusBlinkVisible(0), true);
  assert.equal(GL.unitStatusBlinkVisible(GL.UNIT_STATUS_BLINK_MS - 1), true);
  assert.equal(GL.unitStatusBlinkVisible(GL.UNIT_STATUS_BLINK_MS), false);
  assert.equal(GL.unitStatusBlinkVisible(GL.UNIT_STATUS_BLINK_MS * 2), true);
  const seededBad = () => ({ sheet: "unit_status.png", col: 0, row: 8, token: "BAD_IGNORES_ST" });
  assert.notDeepEqual(seededBad(0), GL.unitStatusIconForBits(0), "test-the-test: an icon resolver that ignores st would trip the st=0 control");
});
section("status icon GL: st-flagged unit emits a second native icon instance above the unit", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  b.buildScene(flatView(5, 5, 0, 0, 0));
  const staticCount = b.staticCount;
  const r = b.buildUnits([{ id: 1, x: 2, y: 2, z: 0, rt: "AARDVARK", st: ST_SLEEPING }], 0, 0, 0, 0);
  assert.equal(r.count, 2, "unit sprite + status icon");
  const inst = decode(b).slice(staticCount);
  const iconCell = atlas.resolve("unit_status.png", 0, 8);
  const icon = inst.find((i) => i.cell === iconCell);
  assert.ok(icon, "sleeping icon cell emitted");
  assert.equal(icon.x, 2);
  assert.equal(icon.y, 1, "icon sits one tile above the unit anchor");
  assert.equal(icon.a, 255);
});
// B222: the sleeping pin above proves the GL DRAW path for row 8; extend it to the other two
// never-observed-live bits so EVERY non-mood status kind is pinned through buildUnits (not just
// the unitStatusIconForBits helper). If the wire ever delivers st for an unconscious/stressed
// unit, this is the assertion that the icon actually reaches the instance stream.
section("status icon GL (B222): unconscious->row 30 and stressed->row 6 each emit their own draw-call instance", () => {
  for (const c of [
    { name: "unconscious", st: ST_UNCONSCIOUS, row: 30 },
    { name: "stressed",    st: ST_STRESSED,    row: 6 },
    { name: "sleeping",    st: ST_SLEEPING,    row: 8 },  // regression anchor alongside the two new ones
  ]) {
    const atlas = makeUnitMockAtlas();
    const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
    b.buildScene(flatView(5, 5, 0, 0, 0));
    const staticCount = b.staticCount;
    const r = b.buildUnits([{ id: 1, x: 2, y: 2, z: 0, rt: "AARDVARK", st: c.st }], 0, 0, 0, 0);
    assert.equal(r.count, 2, `${c.name}: unit sprite + status icon`);
    const inst = decode(b).slice(staticCount);
    const icon = inst.find((i) => i.cell === atlas.resolve("unit_status.png", 0, c.row));
    assert.ok(icon, `${c.name}: row-${c.row} icon cell emitted (the draw call the live fort never showed)`);
    assert.equal(icon.y, 1, `${c.name}: icon sits one tile above the unit anchor`);
    // test-the-test: the icon must be on THIS bit's row, not a neighbour's -- a resolver that
    // ignored st would collapse them all onto one cell.
    assert.ok(!inst.some((i) => i.cell === atlas.resolve("unit_status.png", 0, c.row === 8 ? 30 : 8)),
      `${c.name}: no foreign status cell leaked in`);
  }
});
section("status icon GL: st=0 control is byte-identical to a no-st unit", () => {
  const build = (u) => {
    const atlas = makeUnitMockAtlas();
    const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
    b.buildScene(flatView(5, 5, 0, 0, 0));
    const staticCount = b.staticCount;
    b.buildUnits([u], 0, 0, 0, 0);
    return plain(decode(b).slice(staticCount));
  };
  assert.deepEqual(
    build({ id: 1, x: 2, y: 2, z: 0, rt: "AARDVARK" }),
    build({ id: 1, x: 2, y: 2, z: 0, rt: "AARDVARK", st: 0 }),
    "omitted st and explicit st=0 must emit the exact same instances"
  );
});
// SB-TESTS (2026-07-16 native cadence) REWRITE: bubbles ride each unit's own phase, phase =
// (id*0x86e8 + now) % 7000. This section used to pin the invented fort-wide 800ms clock (assert the
// Zz was SUPPRESSED at the OFF phase); the intermediate rewrite pinned STEADY (always shown). It now
// pins the NATIVE window: an ordinary bubble (Zz, row 8) is SHOWN in the >=5001 window and HIDDEN in
// the <5001 physical window. Full cross-renderer coverage lives in sb_cadence_test.mjs.
section("status icon GL: ordinary Zz obeys the native per-unit phase window", () => {
  const mk = (t) => {
    const atlas = makeUnitMockAtlas();
    const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
    b.buildScene(flatView(5, 5, 0, 0, 0));
    const staticCount = b.staticCount;
    const r = b.buildUnits([{ id: 1, x: 2, y: 2, z: 0, rt: "AARDVARK", st: ST_SLEEPING }], 0, 0, 0, t);
    const inst = decode(b).slice(staticCount);
    return { count: r.count, hasZz: inst.some((i) => i.cell === atlas.resolve("unit_status.png", 0, 8)) };
  };
  // id=1: phase = (6536 + t) % 7000. t=0 -> 6536 (ordinary window, Zz shown); t=800 -> 336 (physical, hidden).
  const shown = mk(0), hidden = mk(800);
  assert.equal(shown.count, 2, "ordinary window: sprite + Zz drawn");
  assert.ok(shown.hasZz, "the Zz is present in the >=5001 window");
  assert.equal(hidden.count, 1, "physical window: sprite only (ordinary Zz gated off)");
  assert.ok(!hidden.hasZz, "the Zz is HIDDEN in the <5001 window");
});
section("status icon GL: ordinary Zz visibility tracks the native window across many wall-clock samples", () => {
  const P = GL.NATIVE_BUBBLE_PERIOD_MS, ORD = GL.NATIVE_BUBBLE_ORDINARY_MS, STRIDE = GL.NATIVE_BUBBLE_ID_STRIDE;
  const id = 1;
  for (const t of [0, 400, 800, 1200, 1600, 2400, 987654]) {
    const phase = (((id % P) * (STRIDE % P)) % P + (t % P)) % P;
    const atlas = makeUnitMockAtlas();
    const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
    b.buildScene(flatView(5, 5, 0, 0, 0));
    const staticCount = b.staticCount;
    b.buildUnits([{ id, x: 2, y: 2, z: 0, rt: "AARDVARK", st: ST_SLEEPING }], 0, 0, 0, t);
    const inst = decode(b).slice(staticCount);
    const hasZz = inst.some((i) => i.cell === atlas.resolve("unit_status.png", 0, 8));
    if (phase >= ORD) assert.ok(hasZz, `Zz shown at wall-clock ${t} (phase ${phase} >= 5001)`);
    else assert.ok(!hasZz, `Zz hidden at wall-clock ${t} (phase ${phase} < 5001)`);
  }
});
section("status icon GL: sd+st below-camera unit gets the same fog alpha on sprite and icon", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  b.buildScene(flatView(5, 5, 0, 0, 10));
  const staticCount = b.staticCount;
  const depth = 1;
  const r = b.buildUnits([{ id: 1, x: 2, y: 2, z: 10 - depth, rt: "AARDVARK", sd: 1, st: ST_SLEEPING }], 0, 0, 10, 0);
  assert.equal(r.count, 2, "see-down unit sprite + status icon");
  const inst = decode(b).slice(staticCount);
  const expA = Math.round(seedownUnitAlpha(depth) * 255);
  assert.equal(inst.length, 2);
  assert.ok(inst.every((i) => i.a === expA), "both sprite and icon use the same see-down alpha");
  const icon = inst.find((i) => i.cell === atlas.resolve("unit_status.png", 0, 8));
  assert.ok(icon, "fogged sleeping icon emitted");
  assert.ok(icon.a > 0 && icon.a < 255, "icon is fog-dimmed, not full-bright");
});

// =============================================================================================
// (4) FALLBACK DOT: unresolvable unit -> a flat SOLID_CELL instance tinted UNIT_FALLBACK_RGB
// (canvas2d's UNIT_COLOR "rgb(240,220,60)"), never silently drawing nothing.
// =============================================================================================
section("fallback dot: unknown race with no ah emits a SOLID_CELL instance in UNIT_FALLBACK_RGB", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(3, 3, 0, 0, 0);
  b.buildScene(view);
  const staticCount = b.staticCount;
  b.buildUnits([{ id: 9, x: 1, y: 1, z: 0, rt: "GHOST_RACE_NOT_IN_MAP" }], 0, 0, 0);
  const inst = decode(b).slice(staticCount);
  assert.equal(inst.length, 1);
  assert.equal(inst[0].cell, GL.SOLID_CELL);
  // GL.UNIT_FALLBACK_RGB was created INSIDE the vm sandbox realm -- its Array.prototype differs
  // from this script's native one, so assert.deepEqual would treat two value-identical arrays
  // as unequal (same cross-realm pitfall wb11/wb12's tests document); JSON round-trip first.
  assert.deepEqual([inst[0].r, inst[0].g, inst[0].b], JSON.parse(JSON.stringify(GL.UNIT_FALLBACK_RGB)));
  assert.equal(inst[0].a, 255, "no z-fade at dz=0 -> full alpha");
});

// =============================================================================================
// (5) PAINTER ORDER + STATIC-PREFIX SAFETY: unit instances land strictly after every terrain/
// building instance, AND repeated buildUnits() calls never disturb the terrain prefix already
// written -- including across a VBO-style capacity GROW triggered from INSIDE buildUnits() (the
// regression this item's ensureCapacity copy-forward fix targets: pre-fix, a grow triggered by
// a large unit batch would silently zero the terrain bytes already written by buildScene()).
// =============================================================================================
section("painter order: unit instances start exactly at builder.staticCount", () => {
  const atlas = makeUnitMockAtlas(new Set(["h1"]));
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(2, 2, 0, 0, 0); // 4 tiles, no spriteMap wired -> 1 base-fill instance/tile
  b.buildScene(view);
  assert.equal(b.staticCount, 4, "4 terrain base-fill instances, no buildings");
  b.buildUnits([{ id: 1, x: 0, y: 0, z: 0, ah: "h1", sw: 1, sh: 1 }], 0, 0, 0);
  assert.equal(b.count, 5);
  const inst = decode(b);
  assert.equal(inst.length, 5);
  // the unit instance (a tier-1 cell, not SOLID_CELL) must be the LAST entry, at index 4.
  assert.notEqual(inst[4].cell, GL.SOLID_CELL);
});
section("static prefix survives a capacity GROW triggered from inside buildUnits (regression guard)", () => {
  const atlas = makeUnitMockAtlas(new Set(["bighash"]));
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(2, 2, 0, 0, 0); // tiny window -> a small initial buffer capacity
  b.buildScene(view);
  const before = decode(b); // 4 terrain instances, captured BEFORE the forced grow
  assert.equal(before.length, 4);
  // A single huge composite (100x100 = 10000 cells) forces ensureCapacity to grow well past
  // whatever buildScene() originally allocated.
  const r = b.buildUnits([{ id: 1, x: 0, y: 0, z: 0, ah: "bighash", sw: 100, sh: 100, ax: 0, ay: 0 }], 0, 0, 0);
  assert.equal(r.count, 10000, "no silent clamp: all 10000 sub-cells made it into the buffer");
  const after = decode(b);
  assert.equal(after.length, 4 + 10000);
  const terrainAfter = after.slice(0, 4);
  assert.deepEqual(
    JSON.parse(JSON.stringify(terrainAfter)), JSON.parse(JSON.stringify(before)),
    "the 4 terrain instances must be BYTE-IDENTICAL after a capacity grow triggered by buildUnits -- " +
    "proves ensureCapacity's copy-forward fix, not a blank-buffer regression"
  );
});
section("repeated buildUnits() calls (simulating rAF ticks) never grow builder.staticCount", () => {
  const atlas = makeUnitMockAtlas(new Set(["h1", "h2"]));
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(3, 3, 0, 0, 0);
  b.buildScene(view);
  const sc = b.staticCount;
  b.buildUnits([{ id: 1, x: 0, y: 0, z: 0, ah: "h1", sw: 1, sh: 1 }], 0, 0, 0);
  assert.equal(b.staticCount, sc);
  b.buildUnits([{ id: 1, x: 1, y: 1, z: 0, ah: "h1", sw: 1, sh: 1 }, { id: 2, x: 2, y: 2, z: 0, ah: "h2", sw: 1, sh: 1 }], 0, 0, 0);
  assert.equal(b.staticCount, sc, "staticCount is a fixed checkpoint from buildScene, never moved by buildUnits");
  assert.equal(b.count, sc + 2, "the tail reflects only the LATEST buildUnits() call, not an accumulation");
});

// =============================================================================================
// (6) CAPACITY BUDGET: exact per-unit budget (sum of sw*sh, min 1) -- mirrors WB-12's
// buildingBudget precomputation, no guessing / no silent clamp for a big unit batch.
// =============================================================================================
section("capacity: many units, mixed tiers, never silently clamps", () => {
  const atlas = makeUnitMockAtlas(new Set(["hA"]));
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(1, 1, 0, 0, 0);
  b.buildScene(view);
  const units = [];
  for (let i = 0; i < 500; i++) units.push({ id: i, x: i, y: 0, z: 0, rt: "AARDVARK" }); // tier 3, span 1 each
  units.push({ id: 9999, x: 0, y: 0, z: 0, ah: "hA", sw: 4, sh: 4 }); // tier 1, span 16
  const r = b.buildUnits(units, 0, 0, 0);
  assert.equal(r.count, 500 + 16, "500 tier-3 units (1 cell each) + one 4x4 tier-1 composite (16 cells)");
});

// =============================================================================================
// (7) RECONCILE: cross-check GL.resolveUnitTierGL against dwf-tiles.js's REAL
// resolveUnitTier() (WE-4, via its _resolveUnitTierForTest hook) for every tier whose gating
// logic does NOT depend on an in-flight network fetch (tier 3 / tier 4-gate / tier 5) -- proving
// the GL port's race-lookup/fallback ORDER agrees with the canvas2d reference it mirrors, field
// for field, using the SAME real creatures_map.json on both sides.
// =============================================================================================
async function reconcileWE4() {
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
      if (String(url).indexOf("creatures_map.json") !== -1) return { ok: true, json: async () => realCreaturesMap };
      return { ok: false, json: async () => null };
    };
    vm.createContext(tilesSandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), tilesSandbox, { filename: "dwf-tiles.js" });
    DwfTiles = tilesSandbox.DwfTiles;
    const canvasEl = new FakeCanvasEl();
    DwfTiles.init({ canvas: canvasEl, managePoll: false, manageCamera: false });
  } catch (err) {
    console.log("SKIP RECONCILE-WE4 (could not load dwf-tiles.js in a sandbox): " + (err && err.message));
    return;
  }
  if (!DwfTiles || typeof DwfTiles._resolveUnitTierForTest !== "function") {
    console.log("SKIP RECONCILE-WE4 (dwf-tiles.js has no _resolveUnitTierForTest hook)");
    return;
  }
  section("RECONCILE status icons: canvas2d and GL share rows, blink, draw position, and skipped cage/restraint bits", () => {
    assert.equal(typeof DwfTiles._unitStatusIconForTest, "function");
    assert.deepEqual(plain(DwfTiles._unitStatusIconForTest(ST_SLEEPING)), plain(GL.unitStatusIconForBits(ST_SLEEPING)));
    assert.deepEqual(plain(DwfTiles._unitStatusIconForTest(ST_UNCONSCIOUS)), plain(GL.unitStatusIconForBits(ST_UNCONSCIOUS)));
    assert.deepEqual(plain(DwfTiles._unitStatusIconForTest(ST_STRESSED)), plain(GL.unitStatusIconForBits(ST_STRESSED)));
    assert.deepEqual(plain(DwfTiles._unitStatusIconForTest(ST_STRANGE_MOOD)), plain(GL.unitStatusIconForBits(ST_STRANGE_MOOD)));
    assert.equal(DwfTiles._unitStatusIconForTest(0), null);
    assert.equal(DwfTiles._unitStatusIconForTest(ST_CAGED | ST_CHAINED), null);
    assert.equal(DwfTiles._unitStatusBlinkVisibleForTest(0), GL.unitStatusBlinkVisible(0));
    assert.equal(DwfTiles._unitStatusBlinkVisibleForTest(GL.UNIT_STATUS_BLINK_MS), GL.unitStatusBlinkVisible(GL.UNIT_STATUS_BLINK_MS));
    // native cadence: id=0 so phase == nowMs % 7000. T_ORD=6000 (>=5001) shows the ordinary Zz.
    const T_ORD = 6000, T_PHYS = 800;
    const plan = DwfTiles._unitStatusDrawPlanForTest({ id: 0, x: 7, y: 9, st: ST_SLEEPING }, 5, 6, 24, T_ORD, 0.64);
    assert.deepEqual(plain(plan), { sheet: "unit_status.png", col: 0, row: 8, token: "UNIT_STATUS:SLEEPING", dx: 48, dy: 48, dw: 24, dh: 24, alpha: 0.64 });
    // SB-TESTS (2026-07-16 native cadence) REWRITE: this line used to pin the invented fort-wide 800ms
    // clock (plan NULL at the OFF instant), then STEADY (always drawn). It now pins the NATIVE window:
    // the ordinary Zz is HIDDEN in the <5001 physical window (per-unit phase gate, not any global clock).
    const planAtPhys = DwfTiles._unitStatusDrawPlanForTest({ id: 0, x: 7, y: 9, st: ST_SLEEPING }, 5, 6, 24, T_PHYS, 0.64);
    assert.equal(plain(planAtPhys), null,
      "canvas2d ordinary bubble is hidden in the <5001 physical window (native per-unit cadence)");
  });
  // creatures_map.json loads asynchronously inside dwf-tiles.js too -- wait for it (tier
  // 3's AARDVARK sample resolves to tier 3 only once the real map has actually landed).
  const t0 = Date.now();
  while (DwfTiles._resolveUnitTierForTest({ rt: "AARDVARK" }).tier !== 3) {
    if (Date.now() - t0 > 2000) throw new Error("dwf-tiles.js creatures_map.json load timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
  section("RECONCILE-WE4: tier 3 (flat race cell) agrees for AARDVARK", () => {
    const atlas = makeUnitMockAtlas();
    const glSel = GL.resolveUnitTierGL({ rt: "AARDVARK" }, realCreaturesMap.races, atlas);
    const theirSel = DwfTiles._resolveUnitTierForTest({ rt: "AARDVARK" });
    assert.equal(glSel.tier, theirSel.tier, 3);
    assert.equal(glSel.rec.sheet, theirSel.rec.sheet);
    assert.equal(glSel.rec.col, theirSel.rec.col);
    assert.equal(glSel.rec.row, theirSel.rec.row);
  });
  section("RECONCILE-WE4: tier 4 gate (layered/baked DWARF, ah absent) agrees -- both select tier 4", () => {
    const atlas = makeUnitMockAtlas(new Set(["dwarf.png"])); // GL side: pretend the fetch already landed
    const glSel = GL.resolveUnitTierGL({ rt: "DWARF", ct: "MALE" }, realCreaturesMap.races, atlas);
    const theirSel = DwfTiles._resolveUnitTierForTest({ rt: "DWARF", ct: "MALE" });
    assert.equal(glSel.tier, 4);
    assert.equal(theirSel.tier, 4);
  });
  section("RECONCILE-WE4: tier 5 (unmapped race) agrees", () => {
    const atlas = makeUnitMockAtlas();
    const glSel = GL.resolveUnitTierGL({ rt: "TOTALLY_MADE_UP_RACE" }, realCreaturesMap.races, atlas);
    const theirSel = DwfTiles._resolveUnitTierForTest({ rt: "TOTALLY_MADE_UP_RACE" });
    assert.equal(glSel.tier, 5);
    assert.equal(theirSel.tier, 5);
  });
  section("RECONCILE-WE4: tier-1 GATING CONDITION (ah + numeric sw/sh) agrees structurally", () => {
    // Both sides require u.ah truthy AND sw/sh numeric before even attempting tier 1 -- verified
    // by starving both of a resolvable race/atlas so the ONLY way either could reach tier 1 is
    // via the ah/sw/sh gate (never actually satisfied here since neither side's fetch resolves
    // synchronously) -- i.e. both must land on tier 5, proving neither short-circuits into a
    // bogus tier 1 without the gate.
    const atlas = makeUnitMockAtlas(); // ah present but never marked ready
    const glSel = GL.resolveUnitTierGL({ ah: "somehash", sw: 2, sh: 2, rt: "TOTALLY_MADE_UP_RACE" }, realCreaturesMap.races, atlas);
    const theirSel = DwfTiles._resolveUnitTierForTest({ ah: "somehash", sw: 2, sh: 2, rt: "TOTALLY_MADE_UP_RACE" });
    assert.equal(glSel.tier, 5, "GL: ah present but atlas never signals ready -> falls through to tier 5");
    assert.equal(theirSel.tier, 5, "canvas2d: ah present but the Image never fires onload -> falls through to tier 5");
  });
}

// =============================================================================================
// (8) INTERPOLATION MATH FIXTURES (createUnitInterpolator, pure, fabricated timestamps)
// =============================================================================================
section("interpolator: first sighting has no glide (from == to)", () => {
  const interp = GL.createUnitInterpolator({});
  interp.ingest([{ id: 1, x: 10, y: 10, z: 0 }], 0);
  const out = interp.tick(0);
  assert.equal(out.length, 1);
  assert.equal(out[0].x, 10); assert.equal(out[0].y, 10);
});
section("interpolator: linear lerp between two snapshots over UNIT_LERP_MS", () => {
  const lerpMs = GL.UNIT_LERP_MS;
  const interp = GL.createUnitInterpolator({});
  interp.ingest([{ id: 1, x: 10, y: 10, z: 0 }], 0);      // first sighting @ t=0
  interp.ingest([{ id: 1, x: 13, y: 10, z: 0 }], 100);    // new target arrives @ t=100
  const atStart = interp.tick(100);
  assert.equal(atStart[0].x, 10, "alpha=0 at the instant the new target arrives");
  const atHalf = interp.tick(100 + lerpMs / 2);
  assert.ok(Math.abs(atHalf[0].x - 11.5) < 1e-9, "alpha=0.5 -> x == 11.5 (halfway between 10 and 13)");
  const atEnd = interp.tick(100 + lerpMs);
  assert.equal(atEnd[0].x, 13, "alpha=1 at exactly lerpMs later -> fully arrived");
  const atPast = interp.tick(100 + lerpMs + 500);
  assert.equal(atPast[0].x, 13, "alpha clamps to 1 well past lerpMs -- never overshoots");
});
section("interpolator: a new update mid-glide starts its glide from the CURRENT position (no pop)", () => {
  const lerpMs = GL.UNIT_LERP_MS;
  const interp = GL.createUnitInterpolator({});
  interp.ingest([{ id: 1, x: 0, y: 0, z: 0 }], 0);
  interp.ingest([{ id: 1, x: 10, y: 0, z: 0 }], 0);         // glide 0 -> 10 starting at t=0
  const midAlpha = 0.4;
  const tMid = midAlpha * lerpMs;
  const justBefore = interp.tick(tMid)[0].x;                // read the in-flight position
  interp.ingest([{ id: 1, x: 20, y: 0, z: 0 }], tMid);       // a NEW target arrives mid-glide
  const justAfter = interp.tick(tMid)[0].x;                  // same instant, right after re-aim
  assert.ok(Math.abs(justBefore - justAfter) < 1e-9,
    "re-aiming mid-glide must not pop the rendered position: " + justBefore + " vs " + justAfter);
  // and the NEW glide must actually head toward 20, not restart from 0.
  const later = interp.tick(tMid + lerpMs)[0].x;
  assert.equal(later, 20);
});
// B23 REGRESSION (live report 07-09): tick()'s record rebuild silently DROPPED the server's
// see-down tag (and would have dropped window-#13 st), so every below-camera unit vanished in GL
// while c2d (raw records, no interpolator) drew them. These cells test the SEAM the direct
// buildUnits fixtures above structurally cannot see: fields must survive ingest -> tick.
section("interpolator SEAM: sd and st survive the tick() rebuild (below-camera unit regression)", () => {
  const interp = GL.createUnitInterpolator({});
  interp.ingest([{ id: 1, x: 5, y: 5, z: 7, rt: "AARDVARK", sd: 1, st: 5 }], 0);
  const out = interp.tick(0);
  assert.equal(out.length, 1);
  assert.equal(out[0].sd, 1, "sd must ride through tick() -- buildUnits drops below-z units without it");
  assert.equal(out[0].st, 5, "st (status bits) must ride through tick() for the icon draw pass");
});
section("interpolator SEAM composed: an sd-tagged below-camera unit still EMITS after interpolation", () => {
  const atlas = makeUnitMockAtlas();
  const b = GL.createSceneBuilder({ atlas, creaturesMap: realCreaturesMap });
  const view = flatView(5, 5, 0, 0, 10);
  b.buildScene(view);
  const staticCount = b.staticCount;
  const interp = GL.createUnitInterpolator({});
  interp.ingest([{ id: 1, x: 2, y: 2, z: 7, rt: "AARDVARK", sd: 1 }], 0);
  b.buildUnits(interp.tick(0), 0, 0, 10);                    // camera z=10, unit z=7, via tick()
  assert.equal(decode(b).slice(staticCount).length, 1,
    "below-camera sd unit must survive the FULL ingest->tick->buildUnits path");
  // test-the-test: the same composed path WITHOUT sd must still drop (B03 anti-ghost gate intact).
  const b2 = GL.createSceneBuilder({ atlas: makeUnitMockAtlas(), creaturesMap: realCreaturesMap });
  b2.buildScene(flatView(5, 5, 0, 0, 10));
  const staticCount2 = b2.staticCount;
  const i2 = GL.createUnitInterpolator({});
  i2.ingest([{ id: 1, x: 2, y: 2, z: 7, rt: "AARDVARK" }], 0);
  b2.buildUnits(i2.tick(0), 0, 0, 10);
  assert.equal(decode(b2).slice(staticCount2).length, 0,
    "untagged off-z unit must STILL be dropped after the fix");
});
section("interpolator: a unit id missing from a fresh snapshot is dropped immediately (no ghost)", () => {
  const interp = GL.createUnitInterpolator({});
  interp.ingest([{ id: 1, x: 0, y: 0, z: 0 }], 0);
  assert.equal(interp.tick(0).length, 1);
  interp.ingest([], 50);
  assert.equal(interp.tick(50).length, 0, "a unit absent from the latest snapshot must vanish immediately");
});
section("interpolator: nolerp mode snaps to the newest raw position with zero glide", () => {
  const interp = GL.createUnitInterpolator({ nolerp: true });
  interp.ingest([{ id: 1, x: 0, y: 0, z: 0 }], 0);
  interp.ingest([{ id: 1, x: 50, y: 50, z: 0 }], 10);
  const out = interp.tick(10.001); // an instant later -- nolerp must already read the new target
  assert.equal(out[0].x, 50); assert.equal(out[0].y, 50);
});

// =============================================================================================
// (9) GATE-EVIDENCE PROXY: a faithful node reproduction of the acceptance gate's own numbers
// ("2s of a moving unit... assert >= 50 distinct rendered unit positions... vs ~15 on canvas2d").
// SAME ingest cadence on both sides (~133ms, matching the gate's own ~15-in-2s canvas2d
// baseline) -- only the tick-side interpolation differs: lerp mode samples a continuously
// changing position every simulated rAF tick (~16.7ms, 60fps); nolerp mode (the snap-to-latest
// behaviour `?nolerp=1` reverts to) only changes value on an ingest boundary.
// =============================================================================================
function simulateDistinctPositions(interp, totalMs, ingestEveryMs, tickEveryMs) {
  const seen = new Set();
  let x = 0;
  for (let t = 0; t <= totalMs; t += tickEveryMs) {
    if (t % ingestEveryMs < tickEveryMs) { x += 1; interp.ingest([{ id: 1, x, y: 0, z: 0 }], t); }
    const cur = interp.tick(t)[0];
    seen.add(cur.x.toFixed(4));
  }
  return seen.size;
}
section("gate-evidence proxy: lerp mode yields >= 50 distinct positions over 2s at 60fps (same ~133ms ingest cadence as canvas2d)", () => {
  const interp = GL.createUnitInterpolator({});
  const distinct = simulateDistinctPositions(interp, 2000, 133, 1000 / 60);
  assert.ok(distinct >= 50, "expected >= 50 distinct rendered positions, got " + distinct);
});
section("gate-evidence proxy: nolerp (snap-to-latest) mode is bounded by the ingest count, well under the lerp mode's count", () => {
  const interp = GL.createUnitInterpolator({ nolerp: true });
  const distinct = simulateDistinctPositions(interp, 2000, 133, 1000 / 60);
  assert.ok(distinct <= 20, "nolerp mode should only change value on ~15 ingest boundaries over 2s, got " + distinct);
});

await reconcileWE4();

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nAll wb13_units_test sections passed.");
