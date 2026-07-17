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
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// PORTRAITS-ROOT (B128): fixture for the paced native-portrait generation sweep.
// DF 53.x fills unit->portrait_texpos only when a unit view sheet is rendered for that
// unit, so before the sweep, portraits existed only for units the HOST had opened in the
// Steam UI (verified live 2026-07-11: 377 active units, exactly 1 with portrait_texpos>0).
// The sweep triggers DF's own generator for every streamed unit; this mirror pins its
// scheduling semantics, and the implementation-contract section pins the real sources.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// --- JS mirror of the portrait_sweep scheduler ---------------------------------------
const MAX_ATTEMPTS = 3;
function makeSweep() {
  return { fort: [], rest: [], seen: new Set(), attempts: new Map(),
           generated: 0, failed: 0, busySkips: 0, backoff: false, world: 0 };
}
function noteUnit(s, id, fortPriority) {
  if (id < 0 || s.seen.has(id)) return;
  s.seen.add(id);
  (fortPriority ? s.fort : s.rest).push(id);
}
function observeWorld(s, identity) {
  if (!identity || identity === s.world) return;
  s.world = identity;
  s.fort = []; s.rest = []; s.seen = new Set(); s.attempts = new Map();
  s.generated = 0; s.failed = 0; s.busySkips = 0; s.backoff = false;
}
// generate(id) -> "ok" | "busy" | "fail"; bakeActive defers without consuming anything.
function tick(s, generate, { paced = true, bakeActive = false } = {}) {
  if (!s.fort.length && !s.rest.length) return null;
  if (!paced || s.backoff) return null;
  const fromFort = s.fort.length > 0;
  const q = fromFort ? s.fort : s.rest;
  const id = q.shift();
  if (bakeActive) { q.unshift(id); return null; }
  const r = generate(id);
  if (r === "ok") { s.generated++; return id; }
  if (r === "busy") { s.busySkips++; q.push(id); s.backoff = true; return null; }
  const attempts = (s.attempts.get(id) || 0) + 1;
  s.attempts.set(id, attempts);
  if (attempts < MAX_ATTEMPTS) q.push(id);
  else s.failed++;
  return null;
}

console.log("# fort units generate before everyone else");
{
  const s = makeSweep();
  observeWorld(s, 1);
  noteUnit(s, 8002, false);      // cat
  noteUnit(s, 1142, true);       // citizen dwarf
  noteUnit(s, 3107, true);       // citizen dwarf
  const order = [];
  while (tick(s, id => { order.push(id); return "ok"; }) !== null) {}
  assert.deepEqual(order, [1142, 3107, 8002], "fort queue drains first");
  assert.equal(s.generated, 3, "every offered unit is generated");
}

console.log("# dedup + new arrivals");
{
  const s = makeSweep();
  observeWorld(s, 1);
  noteUnit(s, 7, true);
  noteUnit(s, 7, true);
  assert.equal(s.fort.length, 1, "a re-scanned unit enqueues once");
  tick(s, () => "ok");
  noteUnit(s, 7, true);
  assert.equal(s.fort.length, 0, "a generated unit is not re-offered (seen)");
  noteUnit(s, 9, false);
  assert.equal(s.rest.length, 1, "a migrant seen on a later scan joins the queue");
}

console.log("# busy contention re-queues WITHOUT burning an attempt");
{
  const s = makeSweep();
  observeWorld(s, 1);
  noteUnit(s, 7, true);
  for (let i = 0; i < 10; i++) {
    tick(s, () => "busy");
    s.backoff = false; // model the 3s backoff expiring
  }
  assert.equal(s.attempts.get(7) || 0, 0, "busy never increments attempts");
  assert.equal(s.failed, 0, "busy never drops the unit");
  assert.equal(s.fort.length, 1, "unit stays queued through arbitrary contention");
  assert.equal(s.busySkips, 10, "contention is counted for /status");
  tick(s, () => "ok");
  assert.equal(s.generated, 1, "unit generates as soon as the sheet closes");
}

console.log("# real failures retry then drop at the attempt cap");
{
  const s = makeSweep();
  observeWorld(s, 1);
  noteUnit(s, 7, false);
  tick(s, () => "fail");
  tick(s, () => "fail");
  assert.equal(s.rest.length, 1, "below the cap the unit is retried");
  tick(s, () => "fail");
  assert.equal(s.rest.length, 0, "at the cap the unit is dropped");
  assert.equal(s.failed, 1, "drop is counted once");
}

console.log("# bake sweep defers portrait steps without consuming them");
{
  const s = makeSweep();
  observeWorld(s, 1);
  noteUnit(s, 7, true);
  tick(s, () => { throw new Error("must not generate while bake sweep active"); },
       { bakeActive: true });
  assert.equal(s.fort.length, 1, "deferred unit keeps its place at the FRONT");
  assert.equal(s.attempts.get(7) || 0, 0, "deferral burns nothing");
}

console.log("# world change resets everything");
{
  const s = makeSweep();
  observeWorld(s, 1);
  noteUnit(s, 7, true);
  tick(s, () => "fail");
  observeWorld(s, 2);
  assert.equal(s.fort.length + s.rest.length, 0, "queues cleared");
  assert.equal(s.seen.size, 0, "seen cleared: new world re-offers all units");
  noteUnit(s, 7, true);
  assert.equal(s.fort.length, 1, "same id enqueues again after a world swap");
}

console.log("# test the test");
{
  const s = makeSweep();
  observeWorld(s, 1);
  noteUnit(s, 7, true);
  // Seeded broken scheduler: counts busy as a real attempt -> the busy-contention
  // invariant above MUST catch it.
  const brokenTick = (st) => {
    const id = st.fort.shift();
    st.attempts.set(id, (st.attempts.get(id) || 0) + 1);
    st.fort.push(id);
  };
  brokenTick(s);
  assert.throws(() => assert.equal(s.attempts.get(7) || 0, 0, "busy never increments attempts"),
                "seeded attempt-burning busy path is detected");
}

// --- implementation contract (string literals in the real sources) -------------------
console.log("# implementation contract");
const sweep = readFileSync(new URL("../../src/portrait_sweep.cpp", import.meta.url), "utf8");
const portrait = readFileSync(new URL("../../src/unit_portrait.cpp", import.meta.url), "utf8");
const stream = readFileSync(new URL("../../src/world_stream.cpp", import.meta.url), "utf8");
const plugin = readFileSync(new URL("../../src/dwf.cpp", import.meta.url), "utf8");
const cmake = readFileSync(new URL("../../CMakeLists.txt", import.meta.url), "utf8");
const core = readFileSync(new URL("../../web/js/dwf-core.js", import.meta.url), "utf8");

assert.match(sweep, /kMinStepInterval\(1000\)/, "sweep paces one generation per second");
assert.match(sweep, /kBusyBackoff\(3000\)/, "host-sheet contention backs off");
assert.match(sweep, /kMaxAttempts = 3/, "real failures are retried three times");
assert.match(sweep, /unit_portrait_on_render_thread\(/, "sweep delegates to the guarded generator");
assert.match(sweep, /bake_sweep_active\(\)/, "sweep serializes behind the map bake sweep");
assert.match(sweep, /"PORTRAIT-SWEEP drained: generated="/, "drain summary is logged");
assert.match(portrait, /"host view sheet is open; skipping native unit-sheet portrait generation"/,
             "busy literal exists for contention classification");
assert.match(portrait, /request->busy_skip = true/, "generator reports contention as a skip");
assert.match(stream, /portrait_sweep_note_unit\(u->id, Units::isFortControlled\(u\)\)/,
             "unit scan offers portrait-less units with fort priority");
assert.match(stream, /portrait_sweep_tick\(\);/, "push tick runs the paced sweep step");
assert.match(stream, /portrait_sweep_observe_world/, "world swaps reset the sweep");
assert.match(plugin, /"capture-portrait-sweep"/, "status/rearm command is registered");
assert.match(cmake, /src\/portrait_sweep\.cpp/, "sweep compiles into the plugin");
assert.match(core, /localStorage\.getItem\("dfplex\.unitImages"\) !== "0"/,
             "unit images default ON (explicit \"0\" opts out)");
assert.doesNotMatch(core, /getItem\("dfplex\.unitImages"\) === "1"/,
                    "the old default-off opt-in read is gone");

console.log("PASS portrait sweep scheduler fixture + implementation contract");
