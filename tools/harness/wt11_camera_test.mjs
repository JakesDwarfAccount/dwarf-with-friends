// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-only

// wt11_camera_test.mjs -- WT11 REOPEN. Executable fixtures for the PURE model stage
// (dwf-world3d-model.js): the orbit camera (orbit/pan/zoom/limits/smoothing) and the z-slab
// window (add/remove layers above+below, clamped at the world's z bounds).
//
// WHY THIS EXISTS: the original WT11 shipped a viewer whose every control was dead, and its tests
// were GREEN -- because they asserted on the source code as a STRING. Camera math that is never
// executed by a test is camera math nobody has checked. Each assertion below is paired with a
// test-the-test that proves it can actually fail.
//
//   node tools/harness/wt11_camera_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { cam, slab } = require(join(here, "..", "..", "web", "js", "dwf-world3d-model.js"));

let passed = 0, failed = 0;
function check(value, name) {
  if (value) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}
// test-the-test: the assertion must REJECT a deliberately broken world.
function rejects(value, name) {
  if (!value) { passed++; console.log("  ok - (test-the-test) " + name); }
  else { failed++; console.log("  FAIL - (test-the-test) seeded-bad world was ACCEPTED: " + name); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// =================================================================================================
console.log("# camera: eye position sits on the orbit sphere around the target");
// =================================================================================================
{
  const c = cam.create({ tx: 10, ty: 20, tz: 30, dist: 50, yaw: 0.3, pitch: 0.4 });
  const e = cam.eye(c);
  const r = Math.hypot(e[0] - 10, e[1] - 20, e[2] - 30);
  check(near(r, 50, 1e-9), "eye is exactly `dist` from the target (r=" + r.toFixed(6) + ")");
  // pitch>0 must put the eye ABOVE the target -- if this inverts, the fort renders upside down.
  check(e[2] > 30, "positive pitch puts the eye above the target");
  const flat = cam.create({ tx: 0, ty: 0, tz: 0, dist: 10, yaw: 0, pitch: 0 });
  const fe = cam.eye(flat);
  check(near(fe[0], 10) && near(fe[1], 0) && near(fe[2], 0), "yaw=0,pitch=0 looks down +X");
  rejects(near(cam.eye(c)[2], 30), "eye z should NOT equal target z at pitch=0.4");
}

// =================================================================================================
console.log("# camera: orbit rotates, and pitch CANNOT reach the pole (no gimbal flip)");
// =================================================================================================
{
  const c = cam.create({ yaw: 0, pitch: 0 });
  cam.orbit(c, 100, 0);
  check(c.yaw < 0, "dragging right decreases yaw (the model follows the cursor)");
  cam.orbit(c, 0, 50);
  check(c.pitch > 0, "dragging down raises the pitch (grab-the-model convention)");

  // Slam the pitch far past the pole from both ends; it must clamp INSIDE +/- PI/2.
  const up = cam.create({ pitch: 0 });
  for (let i = 0; i < 500; i++) cam.orbit(up, 0, 100);
  check(up.pitch <= cam.LIMITS.pitchMax, "pitch clamps at pitchMax");
  check(up.pitch < Math.PI / 2, "pitch stays strictly inside the +Z pole");
  const down = cam.create({ pitch: 0 });
  for (let i = 0; i < 500; i++) cam.orbit(down, 0, -100);
  check(down.pitch >= cam.LIMITS.pitchMin, "pitch clamps at pitchMin");
  check(down.pitch > -Math.PI / 2, "pitch stays strictly inside the -Z pole");

  // The real reason the clamp matters: at the pole, fwd is parallel to up=[0,0,1] and the lookAt
  // cross-product degenerates. Assert the basis stays well-conditioned AT the clamp.
  const b = cam.basis(up);
  const rlen = Math.hypot(b.right[0], b.right[1], b.right[2]);
  check(near(rlen, 1, 1e-6), "right vector is unit-length even at max pitch (basis not degenerate)");
  check(near(b.right[2], 0, 1e-9), "right vector stays horizontal (it is fwd x worldUp)");

  rejects(up.pitch >= Math.PI / 2, "a camera clamped to exactly PI/2 would be degenerate");
}

// =================================================================================================
console.log("# camera: zoom is exponential and clamped");
// =================================================================================================
{
  const c = cam.create({ dist: 100 });
  cam.zoom(c, 1);
  check(near(c.dist, 100 * cam.ZOOM_BASE, 1e-9), "one tick out multiplies dist by ZOOM_BASE");
  cam.zoom(c, -1);
  check(near(c.dist, 100, 1e-9), "a tick back in is the exact inverse (no drift)");

  const far = cam.create({ dist: 100 });
  for (let i = 0; i < 1000; i++) cam.zoom(far, 1);
  check(near(far.dist, cam.LIMITS.distMax), "zoom-out clamps at distMax");
  const close = cam.create({ dist: 100 });
  for (let i = 0; i < 1000; i++) cam.zoom(close, -1);
  check(near(close.dist, cam.LIMITS.distMin), "zoom-in clamps at distMin");
  check(close.dist > 0, "dist never reaches 0 (a 0 dist would put the eye inside the target)");

  // Drag-zoom is the same transform, driven by pixels: dragging DOWN must zoom OUT.
  const d = cam.create({ dist: 100 });
  cam.dragZoom(d, 60);
  check(d.dist > 100, "drag-zoom down zooms out");
  cam.dragZoom(d, -60);
  check(near(d.dist, 100, 1e-9), "drag-zoom up is its exact inverse");

  rejects(cam.zoom(cam.create({ dist: 100 }), 1).dist === 100, "a zoom that changes nothing is broken");
}

// =================================================================================================
console.log("# camera: pan moves the target in the SCREEN plane, scaled by distance");
// =================================================================================================
{
  // Looking down -X from directly east at pitch 0: screen-right is world -Y.
  const c = cam.create({ tx: 0, ty: 0, tz: 0, dist: 100, yaw: 0, pitch: 0 });
  const before = c.target.slice();
  cam.pan(c, 50, 0);
  check(c.target[2] === before[2], "a horizontal pan at pitch=0 does not change target z");
  check(Math.abs(c.target[1] - before[1]) > 0, "a horizontal pan moves the target along the screen-right axis");

  // Pan must scale with dist, or panning while zoomed out crawls and while zoomed in flies.
  const near1 = cam.create({ dist: 10, yaw: 0, pitch: 0 });
  const far1 = cam.create({ dist: 100, yaw: 0, pitch: 0 });
  cam.pan(near1, 50, 0); cam.pan(far1, 50, 0);
  const dn = Math.hypot(near1.target[0], near1.target[1], near1.target[2]);
  const df = Math.hypot(far1.target[0], far1.target[1], far1.target[2]);
  check(near(df / dn, 10, 1e-6), "pan distance scales linearly with camera dist (10x dist = 10x pan)");

  // Panning up-screen at a pitch must lift the target (the screen-up axis has a +z component).
  const tilted = cam.create({ dist: 100, yaw: 0, pitch: 0.6 });
  cam.pan(tilted, 0, 50);
  check(tilted.target[2] !== 0, "panning vertically at a pitch moves the target through z");

  rejects(near(dn, df), "pan that ignores dist would move the same at every zoom");
}

// =================================================================================================
console.log("# camera: framing a field centers it in WORLD space");
// =================================================================================================
{
  // The world-space target is the whole point of the refresh fix: the field origin can move without
  // the view moving. frame() must use ox/oy/oz, NOT the grid origin (0,0,0).
  const field = { ox: 100, oy: 200, oz: 40, dimX: 96, dimY: 96, dimZ: 20 };
  const c = cam.frame(cam.create(), field);
  check(near(c.target[0], 148) && near(c.target[1], 248) && near(c.target[2], 50),
    "target is the field's world-space center (" + c.target.join(",") + ")");
  check(c.dist > 96, "dist backs off far enough to see the whole footprint");
  check(c.dist <= cam.LIMITS.distMax, "framing respects distMax");
  rejects(near(c.target[0], 48), "framing must not center on the GRID origin (that was the old bug)");
}

// =================================================================================================
console.log("# camera: smoothing decays toward the goal, is frame-rate independent, never overshoots");
// =================================================================================================
{
  const goal = cam.create({ yaw: 1, pitch: 0.5, dist: 200, tx: 10, ty: 10, tz: 10 });
  const c = cam.create({ yaw: 0, pitch: 0, dist: 100, tx: 0, ty: 0, tz: 0 });
  let overshot = false;
  for (let i = 0; i < 400; i++) {
    cam.smooth(c, goal, 16);
    if (c.yaw > goal.yaw + 1e-9 || c.dist > goal.dist + 1e-9) overshot = true;
  }
  check(!overshot, "the camera NEVER overshoots its goal (pure decay, not a spring)");
  check(cam.settled(c, goal), "the camera settles exactly on the goal (it does not creep forever)");

  // Frame-rate independence: 2 steps of 16ms must land within a hair of 1 step of 32ms.
  const a = cam.create({ dist: 100 }), b = cam.create({ dist: 100 });
  const g = cam.create({ dist: 200 });
  cam.smooth(a, g, 16); cam.smooth(a, g, 16);
  cam.smooth(b, g, 32);
  check(near(a.dist, b.dist, 1e-9), "2x16ms == 1x32ms (alpha = 1 - exp(-rate*dt))");

  const slow = cam.create({ dist: 100 }), fast = cam.create({ dist: 100 });
  cam.smooth(slow, g, 100);
  cam.smooth(fast, g, 4);
  rejects(near(slow.dist, fast.dist, 1e-6), "a dt-blind lerp would move the same at any frame rate");
}

// =================================================================================================
console.log("# slab: layers ABOVE the camera (the #1 -- this could not be expressed before)");
// =================================================================================================
{
  const s0 = slab.create();
  check(s0.down === 20 && s0.up === 0, "default slab is the historical 20-down / 0-up box");

  const r0 = slab.range(s0, 100);
  check(r0.zBot === 81 && r0.zTop === 100 && r0.count === 20,
    "default range is z 81..100 with the camera plane on top");

  const up3 = slab.addAbove(s0, 100, 200);
  check(up3.up === 1, "addAbove adds ONE layer above");
  const r1 = slab.range(slab.addAbove(slab.addAbove(s0, 100, 200), 100, 200), 100);
  check(r1.zTop === 102 && r1.zBot === 81 && r1.count === 22,
    "two layers above extend the TOP without moving the bottom (z 81..102)");

  const down = slab.addBelow(s0, 100, 200);
  check(down.down === 21 && slab.range(down, 100).zBot === 80,
    "addBelow extends the BOTTOM without moving the top");

  check(slab.removeAbove(up3, 100, 200).up === 0, "removeAbove takes it back");
  check(slab.removeBelow(s0, 100, 200).down === 19, "removeBelow shrinks the descent");

  rejects(slab.range(slab.addAbove(s0, 100, 200), 100).zTop === r0.zTop,
    "adding a layer above must CHANGE zTop (the old voxelizer could not)");
}

// =================================================================================================
console.log("# slab: clamps at the REAL world bounds and at the layer cap");
// =================================================================================================
{
  // World of 50 z-levels (0..49), camera at z=48: only ONE layer above exists.
  let s = slab.create({ down: 5, up: 0 });
  for (let i = 0; i < 10; i++) s = slab.addAbove(s, 48, 50);
  check(s.up === 1, "cannot add layers above the world's ceiling (z=49 is the last)");
  check(slab.range(s, 48).zTop === 49, "zTop clamps exactly at worldZ-1");

  // Camera near the world floor: the descent cannot go below z=0.
  let f = slab.create({ down: 1, up: 0 });
  for (let i = 0; i < 30; i++) f = slab.addBelow(f, 3, 50);
  check(f.down === 4, "descent clamps so zBot >= 0 (camera z=3 -> 4 layers: 3,2,1,0)");
  check(slab.range(f, 3).zBot === 0, "zBot clamps exactly at 0");

  // The floor of the slab itself: there is ALWAYS at least the camera plane to look at.
  let m = slab.create({ down: 3, up: 0 });
  for (let i = 0; i < 10; i++) m = slab.removeBelow(m, 100, 200);
  check(m.down === 1, "down never drops below 1 (an empty slab is not a view)");
  let z = slab.create({ down: 20, up: 2 });
  for (let i = 0; i < 10; i++) z = slab.removeAbove(z, 100, 200);
  check(z.up === 0, "up never goes negative");

  // The total-layer cap protects the voxel budget.
  let big = slab.create({ down: 40, up: 0 });
  for (let i = 0; i < 40; i++) big = slab.addAbove(big, 100, 500);
  check(big.up + big.down <= slab.LIMITS.maxLayers, "total layers never exceed the cap");
  check(big.down === 40, "the cap sheds layers ABOVE first -- the fort below is the point of the view");

  // Unknown world height (pre-hello_ack): the ceiling is unknown, so only floor + cap apply.
  let u = slab.create({ down: 5, up: 0 });
  for (let i = 0; i < 5; i++) u = slab.addAbove(u, 100, 0);
  check(u.up === 5, "worldZ=0 means 'ceiling unknown' and does not block adding layers above");

  // A clamp must be idempotent, or the UI's disabled-state would flicker.
  const c1 = slab.clamp({ down: 99, up: 99 }, 10, 50);
  const c2 = slab.clamp(c1, 10, 50);
  check(slab.equals(c1, c2), "clamp is idempotent");

  rejects(slab.addAbove(slab.create({ down: 5 }), 48, 50).up === 2,
    "a clamp that let zTop past the world ceiling would read unloaded blocks forever");
}

// =================================================================================================
console.log("# slab: equals() -- the no-op guard that keeps a bounded button from rebuilding");
// =================================================================================================
{
  const s = slab.create({ down: 20, up: 0 });
  const atFloor = slab.removeAbove(s, 100, 200); // already 0 above: a no-op
  check(slab.equals(s, atFloor), "a bounded mutation returns an EQUAL slab (so the view skips the rebuild)");
  check(!slab.equals(s, slab.addBelow(s, 100, 200)), "a real mutation is not equal");
  rejects(slab.equals(s, slab.addAbove(s, 100, 200)), "adding a layer that IS possible must not compare equal");
}

console.log("\n" + (failed ? "FAIL" : "PASS") + " -- " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
