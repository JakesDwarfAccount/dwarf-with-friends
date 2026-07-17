// sb_transport_test.mjs -- work-order criterion 8: full snapshots, updates, and 60fps interpolation
// keep BOTH status words st + st2 intact. No protocol redesign; the two words are load-bearing (a
// dropped st2 killed every second-word bubble in B277). Run: node tools/harness/sb_transport_test.mjs
//
// STANDALONE-PASSING: transport is intact on the base and is NOT changed by the v1 bubble work, so
// this suite is green pre- AND post-merge. It (1) drives the REAL GL interpolator across ingest ->
// tick to prove st/st2 survive a snapshot, an update (position change), an st2-only change, and
// both lerp modes; (2) re-verifies the server serializer + fold + interpolation source pins from the
// verified table §TRANSPORT so a silent drop turns red here too.

import assert from "node:assert/strict";
import { GL, read } from "./sb_renderers.mjs";

let n = 0;
const findById = (arr, id) => arr.find((u) => u.id === id);

// ============================================================================================
// (1) BEHAVIORAL: the real GL 60fps interpolator forwards st + st2 verbatim through every path.
// ============================================================================================
for (const nolerp of [false, true]) {
  const interp = GL.createUnitInterpolator({ nolerp });
  const mode = nolerp ? "nolerp" : "lerp";

  // -- fresh join / full snapshot: a brand-new unit's words appear on the first tick --------------
  interp.ingest([{ id: 1, x: 0, y: 0, z: 0, rt: "DWARF", st: 0x08000000, st2: 0x00000008 }], 0);
  let out = interp.tick(0);
  let u = findById(out, 1);
  assert.ok(u, `${mode}: unit present after first snapshot`);
  assert.equal(u.st >>> 0, 0x08000000, `${mode}: st (THIRSTY bit) survives the full snapshot`);
  assert.equal(u.st2 >>> 0, 0x00000008, `${mode}: st2 (DISTRACTED bit) survives the full snapshot`);
  n++;

  // -- update: unit moves; its status words must ride the update, mid-lerp and at completion -------
  interp.ingest([{ id: 1, x: 4, y: 0, z: 0, rt: "DWARF", st: 0x08000000, st2: 0x00000008 }], 100);
  for (const t of [100, 116, 150, 999]) {
    u = findById(interp.tick(t), 1);
    assert.equal(u.st >>> 0, 0x08000000, `${mode}: st preserved during an update at t=${t}`);
    assert.equal(u.st2 >>> 0, 0x00000008, `${mode}: st2 preserved during an update at t=${t}`);
  }
  n++;

  // -- st2-only change: st unchanged, st2 flips (the exact class B277 dropped). Must re-ship --------
  interp.ingest([{ id: 1, x: 4, y: 0, z: 0, rt: "DWARF", st: 0x08000000, st2: 0x00000200 }], 1000);
  u = findById(interp.tick(1000), 1);
  assert.equal(u.st2 >>> 0, 0x00000200, `${mode}: an st2-only change (TELLING_A_STORY) is forwarded`);
  assert.equal(u.st >>> 0, 0x08000000, `${mode}: st unchanged alongside the st2-only change`);
  n++;

  // -- a pre-WT31 record (no st2 field) survives as undefined, never corrupting st -----------------
  interp.ingest([{ id: 2, x: 1, y: 1, z: 0, rt: "DWARF", st: 0x00000001 }], 1000);
  u = findById(interp.tick(1000), 2);
  assert.equal(u.st >>> 0, 0x00000001, `${mode}: an old-DLL record keeps st (SLEEPING) with no st2`);
  assert.ok(u.st2 === undefined || (u.st2 | 0) === 0, `${mode}: absent st2 stays absent/0`);
  n++;
}

// ============================================================================================
// (2) SOURCE PINS (table §TRANSPORT, verified intact) -- a silent drop anywhere turns this red.
// ============================================================================================
const ws = read("src", "world_stream.cpp");
const dump = read("src", "tile_map_dump.cpp");
const gl = read("web", "js", "dwf-gl.js");
assert.match(ws, /r\.st = unit_status_bits\(u\);/, "world_stream computes st via the shared helper");
assert.match(ws, /r\.st2 = unit_status_bits2\(u\);/, "world_stream computes st2 via the shared helper");
assert.match(ws, /if \(u\.st2\) a << ",\\"st2\\":" << u\.st2;/, "world_stream emits st2 (only when non-zero)");
assert.match(ws, /s4_fold_add\(h, u\.st2\)/, "st2 is folded into s4_unit_fold (else an st2-only delta never re-ships)");
assert.match(dump, /unit_status_bits2\(u\)/, "tile_map_dump computes st2 via the shared helper");
assert.match(dump, /if \(st2\) js << ",\\"st2\\":" << st2;/, "tile_map_dump emits st2 (only when non-zero)");
// interpolation forwards BOTH words (the B277 line): the rebuild wrapper must carry st AND st2.
assert.match(gl, /sd: u\.sd, st: u\.st, st2: u\.st2,/, "GL interpolation rebuild forwards st AND st2");

// test-the-test: prove the behavioral checks are not vacuous -- a wrong expected word is rejected.
assert.throws(() => {
  const ii = GL.createUnitInterpolator({});
  ii.ingest([{ id: 9, x: 0, y: 0, z: 0, rt: "DWARF", st: 0x1, st2: 0x2 }], 0);
  assert.equal(findById(ii.tick(0), 9).st2 >>> 0, 0x999);
}, "harness would catch a corrupted st2");

console.log(`sb_transport_test: PASS (${n} interpolator round-trips preserve st+st2 in lerp & nolerp; ` +
  "server emit/fold + interpolation forwarding source-pinned)");
