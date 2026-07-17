// dwf - multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// Offline staged contracts for S3/S4/S5. No subprocesses or live DF required.
// Run: node tools/harness/s3_s4_s5_staging_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stream = fs.readFileSync(path.join(root, "src/world_stream.cpp"), "utf8");
const ws = fs.readFileSync(path.join(root, "src/websocket.cpp"), "utf8");
const wsHeader = fs.readFileSync(path.join(root, "src/websocket.h"), "utf8");
const tiles = fs.readFileSync(path.join(root, "web/js/dwf-tiles.js"), "utf8");

// S3: a cheap fold preserves unchanged derivation and invalidates a same-id rename/state flip.
const cache = new Map();
function derive(id, fold, value) {
  const prior = cache.get(id);
  if (prior && prior.fold === fold) return { value: prior.value, reused: true };
  cache.set(id, { fold, value });
  return { value, reused: false };
}
assert.equal(derive(7, "name:a|bst:0", "A").reused, false);
assert.equal(derive(7, "name:a|bst:0", "ignored").reused, true);
assert.equal(derive(7, "name:b|bst:0", "B").value, "B", "rename must invalidate");
assert.equal(derive(7, "name:b|bst:1", "door-open").value, "door-open",
  "seeded-bad omitted bst fold must fail this contract");

// S4: byte reuse is legal only for exact canonical AUX equality.
let cached = null;
function reuse(canonical) {
  if (cached === canonical) return "reuse";
  cached = canonical;
  return "assemble";
}
assert.equal(reuse('{"units":[1]}'), "assemble");
assert.equal(reuse('{"units":[1]}'), "reuse");
assert.equal(reuse('{"units":[2]}'), "assemble", "seeded changed section must not reuse");

// S4 section caches invalidate independently, and a camera-window change invalidates every
// window-filtered section even when its source fold is unchanged.
const sectionCache = new Map();
function reuseSection(name, fold, windowKey, serialized) {
  const prior = sectionCache.get(name);
  if (prior && prior.fold === fold && prior.windowKey === windowKey) return prior.serialized;
  sectionCache.set(name, { fold, windowKey, serialized });
  return serialized;
}
assert.equal(reuseSection("units", 11, "0,0,1,80,50", "u1"), "u1");
assert.equal(reuseSection("buildings", 20, "0,0,1,80,50", "b1"), "b1");
assert.equal(reuseSection("units", 11, "0,0,1,80,50", "seeded-bad"), "u1",
  "unchanged units section must reuse its prior bytes");
assert.equal(reuseSection("buildings", 21, "0,0,1,80,50", "b2"), "b2",
  "one changed fold must rebuild only that section");
assert.equal(reuseSection("units", 11, "1,0,1,80,50", "u2"), "u2",
  "seeded camera move must invalidate a windowed section");

// S5: full establishes a sequence; an unchanged tick is a compact auxd; a bad base resyncs.
let seq = 1;
function accept(frame) {
  if (frame.type === "aux") { seq = frame.aseq; return "full"; }
  if (frame.base !== seq) return "auxr";
  seq = frame.aseq;
  return "delta";
}
assert.equal(accept({ type: "aux", aseq: 3 }), "full");
assert.equal(accept({ type: "auxd", base: 3, aseq: 4 }), "delta");
assert.equal(accept({ type: "auxd", base: 3, aseq: 5 }), "auxr",
  "seeded lost delta must request a full snapshot");

// S5 merge contract: full replaces/reseeds, up/rm merge by id, and any rm has identical
// semantics whether its cause was death or camera-window exit.
function makeAuxMerge(send) {
  let expectedBase = 0;
  const units = new Map(), buildings = new Map();
  let djobs = [], proj = [], env = null, players = [];
  return {
    apply(frame) {
      if (frame.type === "aux") {
        units.clear(); for (const r of frame.units || []) units.set(r.id, r);
        buildings.clear(); for (const r of frame.buildings || []) buildings.set(r.id, r);
        djobs = frame.djobs || []; proj = frame.proj || []; env = frame.env || null;
        players = frame.players || []; expectedBase = frame.aseq; return true;
      }
      if (frame.base !== expectedBase) { send({ type: "auxr" }); return false; }
      for (const r of frame.units?.up || []) units.set(r.id, r);
      for (const id of frame.units?.rm || []) units.delete(id);
      for (const r of frame.buildings?.up || []) buildings.set(r.id, r);
      for (const id of frame.buildings?.rm || []) buildings.delete(id);
      if ("djobs" in frame) djobs = frame.djobs;
      if ("proj" in frame) proj = frame.proj;
      if ("env" in frame) env = frame.env;
      if ("players" in frame) players = frame.players;
      expectedBase = frame.aseq; return true;
    },
    state() { return { units: [...units.values()], buildings: [...buildings.values()], djobs, proj, env, players }; },
  };
}
const controls = [];
const merge = makeAuxMerge((msg) => controls.push(msg));
assert.equal(merge.apply({ type: "aux", aseq: 10, units: [{ id: 1, name: "one" }, { id: 2 }],
  buildings: [{ id: 7, stage: 1 }], djobs: [], proj: [], env: { season: 0 }, players: [] }), true);
assert.equal(merge.apply({ type: "auxd", base: 10, aseq: 11,
  units: { up: [{ id: 1, name: "renamed" }, { id: 3 }], rm: [2] },
  buildings: { up: [{ id: 7, stage: 2 }], rm: [] }, proj: [{ x: 4 }] }), true);
assert.deepEqual(merge.state().units, [{ id: 1, name: "renamed" }, { id: 3 }]);
assert.deepEqual(merge.state().buildings, [{ id: 7, stage: 2 }]);
assert.deepEqual(merge.state().proj, [{ x: 4 }]);
assert.equal(merge.apply({ type: "auxd", base: 10, aseq: 12, units: { up: [{ id: 9 }], rm: [] } }), false);
assert.deepEqual(controls, [{ type: "auxr" }]);
assert.deepEqual(merge.state().units, [{ id: 1, name: "renamed" }, { id: 3 }],
  "base mismatch must ignore the entire delta");
merge.apply({ type: "aux", aseq: 20, units: [{ id: 9 }], buildings: [{ id: 8 }], djobs: [], proj: [], env: null, players: [] });
assert.deepEqual(merge.state().units, [{ id: 9 }], "full resync must clear and repopulate sent state");
merge.apply({ type: "auxd", base: 20, aseq: 21, units: { up: [], rm: [9] } });
assert.deepEqual(merge.state().units, [], "death and window-exit share the same rm path");

// Seeded-bad T2: suppressing one changed record must be observable as inequality.
const badMerge = makeAuxMerge(() => {});
badMerge.apply({ type: "aux", aseq: 1, units: [{ id: 1, st: 0 }], buildings: [] });
badMerge.apply({ type: "auxd", base: 1, aseq: 2, units: { up: [], rm: [] } });
assert.notDeepEqual(badMerge.state().units, [{ id: 1, st: 1 }],
  "seeded suppressed unit delta must diverge from full-state truth");

// Seeded-bad T3: latest-wins replacement must force the next full only when the missed
// pending state was a delta; a newly-enqueued full snapshot heals an overwritten delta itself.
function replacementRecovery(queuedKinds) {
  let pending = null, needsFull = false;
  for (const kind of queuedKinds) {
    const replaced = pending !== null;
    const replacedDelta = pending === "delta";
    if (replaced && replacedDelta && kind !== "full") needsFull = true;
    if (kind === "full") needsFull = false;
    pending = kind;
  }
  return needsFull;
}
assert.equal(replacementRecovery(["delta", "delta"]), true,
  "seeded stalled writer must force recovery after dropping a delta");
assert.equal(replacementRecovery(["delta", "full"]), false,
  "a full snapshot that replaces a delta is already self-healing");
assert.equal(replacementRecovery(["full", "delta"]), false,
  "the replacement trigger keys on the dropped frame kind, not only the new frame kind");

assert.match(stream, /g_unit_derived/, "S3 unit cache must be wired");
assert.match(stream, /g_bld_derived/, "S3 building cache must be wired");
assert.match(stream, /g_mat_rgb_derived\.find\(key\)/, "S3 material RGB memo must be read");
assert.match(stream, /g_mat_rgb_derived\.emplace\(key, rgb\)/, "S3 material RGB memo must store misses");
assert.match(stream, /aux_cache_valid/, "S4 cache must be wired");
assert.match(stream, /aux_units_json/, "S4 units fragment cache must be wired");
assert.match(stream, /aux_bldgs_json/, "S4 buildings fragment cache must be wired");
assert.match(stream, /aux_djobs_json/, "S4 djobs fragment cache must be wired");
assert.match(stream, /aux_proj_json/, "S4 projectile fragment cache must be wired");
assert.match(stream, /aux_env_json/, "S4 env fragment cache must be wired");
assert.match(stream, /same_window[\s\S]*aux_units_fold != g_last_read\.units_fold/,
  "S4 reuse must depend on both source fold and interest window");
assert.match(stream, /auxd/, "S5 must emit a negotiated delta frame");
assert.match(stream, /sent_units/, "S5 per-connection unit fold map must be wired");
assert.match(stream, /sent_bldgs/, "S5 per-connection building fold map must be wired");
assert.ok(stream.includes('d << ",\\\"units\\\":{\\\"up\\\":["'),
  "S5 units delta must carry an up array");
assert.ok(stream.includes('d << "],\\\"rm\\\":["'), "S5 record deltas must carry rm arrays");
assert.match(stream, /for \(const auto& old : cs\.sent_units\) if \(!current\.count\(old\.first\)\)/,
  "S5 rm must be derived from absence in the post-filter visible set");
assert.match(stream, /cs\.sent_units\.clear\(\)[\s\S]*visible_units[\s\S]*cs\.sent_bldgs\.clear\(\)/,
  "S5 every full snapshot must repopulate both sent maps");
assert.match(ws, /set_wants_auxd/, "S5 HELLO capability must be parsed");
assert.match(wsHeader, /bool enqueue_v1_aux\(/, "S5 AUX enqueue must report latest-wins replacement");
assert.match(ws, /const bool replaced_unsent = v1_aux_has_;/,
  "S5 replacement signal must sample the unsent slot before overwrite");
assert.match(ws, /return replaced_unsent;/, "S5 replacement signal must reach the push caller");
assert.match(stream, /replaced_unsent && cs\.aux_pending_delta[\s\S]*cs\.aux_needs_full = true/,
  "S5 dropping a pending delta must force the next full snapshot");
assert.match(stream, /take_aux_full_request\(\)[\s\S]*cs\.aux_needs_full = true/,
  "S5 client auxr must compose with the same full-snapshot recovery path");
assert.match(tiles, /type === "auxd"/, "S5 client must consume delta heartbeat");
assert.match(tiles, /auxUnitsById\.set\(rec\.id, rec\)/, "S5 client must merge unit up records by id");
assert.match(tiles, /auxUnitsById\.delete\(id\)/, "S5 client must merge unit removals by id");
assert.match(tiles, /DwfWS\.send\(\{ type: "auxr" \}\)/,
  "S5 client must request resync on a base mismatch");
console.log("s3_s4_s5_staging_test: PASS");
