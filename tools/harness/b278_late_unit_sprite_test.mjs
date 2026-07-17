// b278_late_unit_sprite_test.mjs -- units arriving after v1 connect must enter the texture
// census and carry their late composite through the production GL interpolation path.
// Run: node tools/harness/b278_late_unit_sprite_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const stream = read("src", "world_stream.cpp");
const dump = read("src", "tile_map_dump.cpp");

function censusPrecedesSpriteSnapshot(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `found production scan marker: ${startMarker}`);
  const census = source.indexOf("unit_census_pass(world->units.active);", start);
  const snapshot = source.indexOf("unit_sprite_snapshot()", start);
  return census >= 0 && snapshot >= 0 && census < snapshot;
}

// The live v1 path is the important assertion. B278 existed because only the legacy serializer
// called the census; fixtures and refresh-time /mapdata requests therefore stayed green.
const v1Marker = "// (v) ONE units scan + ONE buildings scan into neutral vectors";
assert.ok(censusPrecedesSpriteSnapshot(stream, v1Marker),
  "v1 world scan discovers new units before snapshotting exported composite records");

// Preserve legacy behavior too: poll fallback and refresh-time /mapdata must still discover units.
assert.ok(censusPrecedesSpriteSnapshot(dump, "static int emit_units("),
  "legacy /mapdata scan discovers units before snapshotting composite records");

// Test the test: reconstruct the B278 v1 omission. This must make the production-path predicate
// false while leaving the legacy call present, exactly matching the refresh-heals symptom.
const reverted = stream.replace(
  /\n\s*unit_census_pass\(world->units\.active\);\n(?=\s*\/\/ WE-3: one snapshot)/,
  "\n",
);
assert.notEqual(reverted, stream, "revert transform removed the v1 census invocation");
assert.equal(censusPrecedesSpriteSnapshot(reverted, v1Marker), false,
  "test-the-test: removing only the v1 invocation is caught");
assert.ok(censusPrecedesSpriteSnapshot(dump, "static int emit_units("),
  "test-the-test control: legacy remains green, explaining why refresh masked the defect");

// Once the exporter produces ah/sw/sh/ax/ay, the unit record fold must change so auxd re-ships it.
assert.match(stream,
  /s4_fold_add\(h, u\.ah\);\s*s4_fold_add\(h, u\.sw\);\s*s4_fold_add\(h, u\.sh\);/,
  "appearance hash and span participate in the per-unit aux delta fold");
assert.match(stream,
  /if \(sit != sprite_snapshot\.end\(\) && !sit->second\.hash\.empty\(\)\) \{\s*r\.ah = sit->second\.hash;/,
  "the next v1 unit scan copies the newly exported composite into the wire record");

// Drive the real client handoff that production uses every rAF: update the same already-visible
// unit from generic (no ah) to a late composite, then ensure the interpolator returns the newest
// non-position fields and the tier resolver requests the content-addressed sprite.
const sandbox = { self: null, performance: { now: () => 0 } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("web", "js", "dwf-gl.js"), sandbox, { filename: "dwf-gl.js" });
const GL = sandbox.DwfGL;
const interp = GL.createUnitInterpolator({ lerpMs: 66 });
interp.ingest([{ id: 77, x: 10, y: 20, z: 4, rt: "DWARF", ct: "MALE" }], 0);
assert.equal(interp.tick(0)[0].ah, undefined, "new arrival starts on the generic fallback");
interp.ingest([{
  id: 77, x: 11, y: 20, z: 4, rt: "DWARF", ct: "MALE",
  ah: "0123456789abcdef", sw: 2, sh: 2, ax: 1, ay: 1,
}], 33);
const late = interp.tick(33)[0];
assert.deepEqual(
  { ah: late.ah, sw: late.sw, sh: late.sh, ax: late.ax, ay: late.ay },
  { ah: "0123456789abcdef", sw: 2, sh: 2, ax: 1, ay: 1 },
  "production interpolator patches the late composite fields without a page refresh",
);
const requests = [];
const atlas = {
  registerDynamicSheet(key, url) { requests.push({ key, url }); return true; },
};
assert.equal(GL.resolveUnitTierGL(late, {}, atlas).tier, 1,
  "late-updated unit selects its exact composite tier");
assert.deepEqual(requests, [{
  key: "0123456789abcdef", url: "/unit-sprite/0123456789abcdef.png",
}], "production resolver requests the newly arrived composite hash");

console.log("PASS B278: both live unit scans invoke census before sprite snapshot; deleting the v1 " +
  "call is caught while legacy stays green; late ah fields traverse interpolation into tier 1");
