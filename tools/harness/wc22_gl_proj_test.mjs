// wc22_gl_proj_test.mjs -- WC-22 GL projectile pass (wcclient handoff: "GL projectiles need a
// third GPU dynamic-instance region like updateUnits"). Loads the REAL dwf-gl.js builder
// and exercises builder.buildProjectiles() -- the third dynamic region that APPENDS after the
// units tail (no k reset) so units+proj upload as one contiguous [staticCount, k) segment.
//
// Asserts (decoding the raw instance buffer, same convention as wb12/wb13):
//   - projectiles append AFTER units in the dynamic tail (count = units + proj)
//   - sub-tile placement uses (fx-128)/255 signed offset (matches canvas2d projCenterPx)
//   - z-filter drops off-camera-plane projectiles
//   - vehicle vs projectile use distinct marker colors
//   - TEST-THE-TEST: an off-z projectile is genuinely dropped (count changes when we fix z)
//
// Run: node tools/harness/wc22_gl_proj_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const sandbox = {}; sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
sandbox.Date = Date;
vm.createContext(sandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
const GL = sandbox.DwfGL;
assert.ok(GL, "dwf-gl.js did not export DwfGL");

function makeAtlas() { const ids = new Map(); let n = 1; return { resolve(s, c, r) { const k = s + "|" + c + "|" + r; if (!ids.has(k)) ids.set(k, n++); return ids.get(k); } }; }
function tile() { return { tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: false }; }
function flatView(gw, gh, ox, oy, oz) {
  const tiles = new Array(gw * gh); for (let i = 0; i < gw * gh; i++) tiles[i] = tile();
  return { origin: { x: ox, y: oy, z: oz }, width: gw, height: gh, tiles };
}
function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) out.push({
    x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4],
    r: u8[k * 16 + 12], g: u8[k * 16 + 13], b: u8[k * 16 + 14], a: u8[k * 16 + 15],
  });
  return out;
}

let failed = 0;
function check(name, cond) { if (cond) console.log("  ok  - " + name); else { failed++; console.log("  FAIL- " + name); } }

const OX = 10, OY = 10, OZ = 150;
const b = GL.createSceneBuilder({ atlas: makeAtlas() });
const view = flatView(8, 8, OX, OY, OZ);
b.buildScene(view);
const staticCount = b.count;
check("static scene built (>0 terrain instances)", staticCount > 0);

// no units, two projectiles on-plane + one off-plane (should be dropped) + one vehicle on-plane.
b.buildUnits([], OX, OY, OZ);
const afterUnits = b.count;
check("buildUnits([]) leaves the dynamic tail empty (count == staticCount)", afterUnits === staticCount);

const projs = [
  { x: 12, y: 13, z: OZ, fx: 128, fy: 128, vehicle: false },       // centered
  { x: 14, y: 15, z: OZ, fx: 255, fy: 0, vehicle: false },          // +0.5,-0.5 tile offset
  { x: 16, y: 16, z: OZ + 3, fx: 128, fy: 128, vehicle: false },    // OFF-PLANE -> dropped
  { x: 11, y: 11, z: OZ, fx: 128, fy: 128, vehicle: true },         // vehicle (cart)
];
const rp = b.buildProjectiles(projs, OX, OY, OZ);
const inst = decode(b);
const projInst = inst.slice(staticCount); // dynamic tail (units=0, so all tail is proj)

check("buildProjectiles returns TOTAL dynamic count (units 0 + 3 on-plane proj = 3)", rp.count === 3);
check("3 projectile instances emitted (the off-plane one is z-filtered out)", projInst.length === 3);

// R1 world-anchored instances retain WORLD coordinates; the projection subtracts the
// origin later (same contract b35_djobs_test pins). Pre-R1 this test asserted grid-relative
// coords, which went stale at 2861db9.
// centered projectile: world (12,13), offset 0.
const p0 = projInst.find((i) => Math.abs(i.x - 12) < 1e-6 && Math.abs(i.y - 13) < 1e-6);
check("centered proj at grid (2,3) with fx/fy=128 -> zero sub-tile offset", !!p0);
check("centered proj uses the bright bolt color (250,240,200)", p0 && p0.r === 250 && p0.g === 240 && p0.b === 200);

// offset projectile: world (14,15) + (255-128)/255 = +0.498, (0-128)/255 = -0.502.
const expX = 14 + (255 - 128) / 255, expY = 15 + (0 - 128) / 255;
const p1 = projInst.find((i) => Math.abs(i.x - expX) < 1e-4 && Math.abs(i.y - expY) < 1e-4);
check("offset proj places at the exact signed sub-tile offset ((fx-128)/255)", !!p1);

// vehicle: cart color (180,150,90) at world (11,11).
const pv = projInst.find((i) => Math.abs(i.x - 11) < 1e-6 && Math.abs(i.y - 11) < 1e-6);
check("vehicle proj at grid (1,1) uses the cart color (180,150,90)", pv && pv.r === 180 && pv.g === 150 && pv.b === 90);

// projectiles do NOT clobber the static prefix (terrain still intact below staticCount).
check("static terrain prefix untouched by the projectile append", decode(b).length >= staticCount && b.count === staticCount + 3);

// TEST-THE-TEST: move the off-plane proj onto the camera plane -> count rises to 4 (proving the
// z-filter is real, not a coincidental drop).
b.buildUnits([], OX, OY, OZ);
const projs2 = projs.map((p) => Object.assign({}, p, { z: OZ }));
const rp2 = b.buildProjectiles(projs2, OX, OY, OZ);
check("[test-the-test] with all 4 on-plane, the count rises to 4 (the z-filter genuinely dropped one before)", rp2.count === 4);

// TEST-THE-TEST: a proj with non-numeric coords is skipped (never a NaN instance).
b.buildUnits([], OX, OY, OZ);
const rp3 = b.buildProjectiles([{ x: "nope", y: 5, z: OZ }, { x: 12, y: 12, z: OZ }], OX, OY, OZ);
check("[test-the-test] a proj with a bad x coord is skipped (1 valid of 2)", rp3.count === 1);

console.log(failed === 0 ? "\nALL WC-22 GL PROJECTILE TESTS PASS" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
