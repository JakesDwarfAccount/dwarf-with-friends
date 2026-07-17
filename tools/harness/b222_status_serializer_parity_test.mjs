// b222_status_serializer_parity_test.mjs -- B222: the TWO unit serializers must stay in lockstep.
// Run: node tools/harness/b222_status_serializer_parity_test.mjs
//
// ROOT CAUSE PINNED HERE: the plugin has two unit serializers --
//   * world_stream.cpp  append_unit_json  (aux full frame + auxd delta)
//   * tile_map_dump.cpp emit_units        (GET /mapdata + the byte-identical WS mapdata push)
// -- and only the FIRST ever emitted the overhead-status "st" field. Every path that rebuilds
// units from the mapdata shape (fresh join, snapshot, window change) therefore dropped all status
// bubbles until an aux fold change re-shipped the record; for a dwarf asleep the whole time that
// change never came (the fold changes on wake). Live-verified on the host 2026-07-13:
// counters.unconscious=1200 seeded on unit 139 -> GET /mapdata unit record had NO "st" key.
//
// The fix factors ONE shared computation (src/unit_status.h unit_status_bits) consumed by both
// serializers, and adds the missing conditional st emit to emit_units. This fixture pins:
//   (1) both serializers call the ONE shared helper (no local predicate copies anywhere),
//   (2) both emit st under the identical only-when-non-zero contract (and gh under the same
//       ghost predicate),
//   (3) FIELD-SET PARITY: the JSON keys emitted by append_unit_json and emit_units are the SAME
//       SET -- any future field added to one serializer but not the other fails loudly (the
//       structural class of bug B222 belongs to, made unrepresentable-without-a-red-test),
//   (4) test-the-test: reverting the fix (deleting the st emit from emit_units) makes the parity
//       check fail -- i.e. this fixture would have caught B222.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const ustat = read("src", "unit_status.h");
const stream = read("src", "world_stream.cpp");
const dump = read("src", "tile_map_dump.cpp");

// ---- helper: slice one function body out of a TU (from its signature to the closing brace at
// column 0 -- both files use K&R-at-col-0 for statics, so this is stable and comment-proof).
function fnBody(src, sigRe, label) {
  const m = src.match(sigRe);
  assert.ok(m, `${label}: signature found`);
  const start = m.index;
  const end = src.indexOf("\n}", start);
  assert.ok(end > start, `${label}: closing brace found`);
  return src.slice(start, end + 2);
}
const appendUnit = fnBody(stream, /static void append_unit_json\(/, "append_unit_json");
const emitUnits = fnBody(dump, /static int emit_units\(/, "emit_units");

// ---- (1) ONE shared computation: both serializer TUs consume unit_status.h ----------------------
assert.match(ustat, /inline int unit_status_bits\(df::unit\* u\)/, "shared helper exists in unit_status.h");
assert.match(stream, /#include "unit_status\.h"/, "world_stream includes the shared header");
assert.match(dump, /#include "unit_status\.h"/, "tile_map_dump includes the shared header");
assert.match(stream, /r\.st = unit_status_bits\(u\);/, "world_stream's units scan uses the shared helper");
assert.match(emitUnits, /unit_status_bits\(u\)/, "emit_units uses the shared helper");
// no local predicate copies may survive outside the header (a re-fork would resurrect B222's
// divergence risk): the raw predicate atoms appear ONLY in unit_status.h.
for (const [tu, name] of [[stream, "world_stream.cpp"], [dump, "tile_map_dump.cpp"]]) {
  assert.ok(!/job_type::Sleep/.test(tu), `${name}: no local Sleep predicate (lives in unit_status.h only)`);
  assert.ok(!/counters\.unconscious/.test(tu), `${name}: no local unconscious predicate`);
  assert.ok(!/personality\.stress/.test(tu), `${name}: no local stress predicate`);
  assert.ok(!/kUStatSleeping\s*=/.test(tu), `${name}: no local kUStat constant definitions`);
}
// B280 -- THESE PINS MUST READ CODE, NOT PROSE.
//
// The stress pin used to be `assert.match(ustat, /getStressCategory\(u\) <= 1/)`. When B280 replaced
// that predicate with DF's own threshold, the pin KEPT PASSING -- because the sentence explaining
// why the old predicate was wrong contains the string `getStressCategory(u) <= 1`. A source-text
// assertion that a COMMENT can satisfy is not an assertion. Every pin below therefore strips the
// comments first and matches only against code.
const ustatCode = ustat
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
  .replace(/\/\/.*$/gm, "");
assert.match(ustatCode, /job_type::Sleep/, "the Sleep predicate lives in the header");
assert.match(ustatCode, /counters\.unconscious > 0/, "the unconscious predicate lives in the header");
// SB-SERVER (table row 6, sel:184): the overhead STRESSED *bubble* predicate reads the RAW
// personality.stress accumulator >= 10000 (the graphics selector's field), not the unit-SHEET's
// longterm_stress. longterm_stress/kUStatStressLevel remains the sheet threshold elsewhere.
assert.match(ustatCode, /personality\.stress >= kUStatBubbleStress/,
  "the stress BUBBLE predicate lives in the header and reads DF's overhead-selector field (sel:184)");
assert.ok(!/getStressCategory/.test(ustatCode),
  "unit_status.h still calls DFHack's getStressCategory. That is DFHack's happiness bucketing " +
  "(stress >= 25000), not DF's status threshold (stress >= 20000) -- see B280.");

// ---- (2) identical emit contracts --------------------------------------------------------------
// st: only-when-non-zero, same key, same value source (UnitRec.st is set from unit_status_bits;
// emit_units computes it inline from the same helper).
assert.match(appendUnit, /if \(u\.st\) a << ",\\"st\\":" << u\.st/, "append_unit_json: st only when non-zero");
assert.match(emitUnits, /const int st = unit_status_bits\(u\);\s*\n\s*if \(st\) js << ",\\"st\\":" << st;/,
  "emit_units: st from the SHARED helper, only when non-zero");
// WT31: the SECOND status word rides the SAME contract in BOTH serializers, or B222 simply repeats
// one word over (every snapshot / fresh-join path silently dropping the new bubbles).
assert.match(appendUnit, /if \(u\.st2\) a << ",\\"st2\\":" << u\.st2/, "append_unit_json: st2 only when non-zero");
assert.match(emitUnits, /const int st2 = unit_status_bits2\(u\);\s*\n\s*if \(st2\) js << ",\\"st2\\":" << st2;/,
  "emit_units: st2 from the SHARED helper, only when non-zero");
assert.match(stream, /r\.st2 = unit_status_bits2\(u\);/, "world_stream's st2 comes from the same shared helper");
// ...and it MUST be folded, or an st2-only change never re-ships on the aux delta (B222's mechanism).
assert.match(stream, /s4_fold_add\(h, u\.st2\)/, "st2 is folded into s4_unit_fold (aux delta re-ships on an st2-only change)");
// gh: both gate on the ghost predicate with the same key/value. (world_stream stores
// Units::isGhost into UnitRec.ghostly during its scan; emit_units tests it directly.)
assert.match(appendUnit, /if \(u\.ghostly\) a << ",\\"gh\\":1"/, "append_unit_json: gh:1 for ghosts");
assert.match(emitUnits, /if \(Units::isGhost\(u\)\) js << ",\\"gh\\":1"/, "emit_units: gh:1 for ghosts");
assert.match(stream, /r\.ghostly = Units::isGhost\(u\);/, "world_stream's ghostly comes from the same predicate");

// ---- (3) FIELD-SET PARITY: both serializers emit the same JSON key set --------------------------
// Extract every emitted JSON key (the \"key\": tokens inside the emit bodies). This is the
// structural guard: B222 was exactly a key present in one set and missing from the other.
function emittedKeys(body, label) {
  const keys = new Set();
  const re = /\\"(\w+)\\":/g;
  let m;
  while ((m = re.exec(body))) keys.add(m[1]);
  assert.ok(keys.size > 0, `${label}: extracted at least one emitted key`);
  return keys;
}
const aKeys = emittedKeys(appendUnit, "append_unit_json");
const eKeys = emittedKeys(emitUnits, "emit_units");
const EXPECTED = ["x", "y", "z", "id", "race", "caste", "rt", "ct", "name",
                  "sd", "gh", "st", "st2", "ah", "sw", "sh", "ax", "ay"].sort();
assert.deepEqual([...aKeys].sort(), EXPECTED, "append_unit_json emits exactly the contract fields");
assert.deepEqual([...eKeys].sort(), EXPECTED, "emit_units emits exactly the contract fields");
assert.deepEqual([...aKeys].sort(), [...eKeys].sort(),
  "PARITY: both unit serializers emit the same field set (B222's bug class)");

// ---- (4) test-the-test: reverting the fix must turn (3) red -------------------------------------
// (a) Reconstruct pre-fix emit_units by deleting the added st emit -- the parity check must fail.
const reverted = emitUnits.replace(/\n[^\n]*const int st = unit_status_bits\(u\);\s*\n\s*if \(st\) js << ",\\"st\\":" << st;/, "");
assert.notEqual(reverted, emitUnits, "revert transform actually removed the st emit");
const rKeys = emittedKeys(reverted, "reverted emit_units");
assert.ok(!rKeys.has("st"), "reverted body no longer emits st (faithful pre-fix reconstruction)");
assert.notDeepEqual([...rKeys].sort(), [...aKeys].sort(),
  "test-the-test: the pre-fix serializer FAILS field-set parity -- this fixture catches B222");
// (b) A key extractor that returned nothing would vacuously 'pass' notDeepEqual -- guard it.
assert.ok(rKeys.has("gh") && rKeys.has("id"), "extractor sanity: reverted body still yields other keys");

console.log("PASS b222 parity: one shared unit_status_bits (no local predicate copies); st + gh emit " +
  "contracts identical; append_unit_json and emit_units emit the SAME field set " +
  `(${EXPECTED.length} keys); reverting the emit_units st fix turns the parity check red`);
