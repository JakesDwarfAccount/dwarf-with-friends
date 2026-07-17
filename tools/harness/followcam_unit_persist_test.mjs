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
//
// B61 -- follow-unit silently stops. Two causes:
//   (1) At a map edge DF clamps the camera, so the achieved view centre != the unit's tile.
//       The old drift check compared the live view centre against the UNIT TILE, read the clamp
//       as a manual pan, and stopped follow. Native DF keeps following through the clamp.
//   (2) FOLLOW_MISS_LIMIT stopped follow after ~2 s whenever the unit was transiently absent from
//       the snapshot. A live unit is findable at any z/visibility (only a real despawn 404s), so
//       transient absence must persist + re-attach; disengage is reserved for user action or a
//       confirmed death/despawn.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FOLLOW_PAN_STOP_TILES = 4;

// Manual-pan drift check, measured against a supplied baseline centre (matches core logic).
function driftStops(viewCentre, baseline) {
  if (!baseline || !viewCentre) return false;
  const dz = Math.abs(viewCentre.z - baseline.z);
  const dxy = Math.max(Math.abs(viewCentre.x - baseline.x), Math.abs(viewCentre.y - baseline.y));
  return dz >= 1 || dxy > FOLLOW_PAN_STOP_TILES;
}

// --- (1) Map-edge clamp must NOT stop follow --------------------------------------------------
// Unit walks into the SW corner. The camera clamps: the achieved view centre pins at the clamp
// tile and holds steady while the unit keeps moving along the edge.
const unitTileAtEdge = { x: 3, y: 3, z: 5 };       // unit near the map corner
const achievedClamped = { x: 40, y: 40, z: 5 };    // camera clamped -> view centre pinned here
const viewNextTick = { x: 40, y: 40, z: 5 };       // camera stationary between recenters

// NEW behaviour: baseline is the achieved (clamped) centre -> no drift -> follow persists.
assert.equal(driftStops(viewNextTick, achievedClamped), false,
  "clamped follow persists: view centre matches the achieved baseline, no phantom pan");

// BORN-RED: the OLD baseline was the unit tile; at the clamp that reads as a huge pan and stops.
assert.equal(driftStops(achievedClamped, unitTileAtEdge), true,
  "BORN-RED: comparing the clamped view centre against the UNIT TILE wrongly triggers a stop");

// A real manual pan still stops follow (regression guard): the view centre moves off the baseline.
assert.equal(driftStops({ x: 46, y: 40, z: 5 }, achievedClamped), true,
  "a genuine manual pan (>4 tiles off the achieved centre) still stops follow");
assert.equal(driftStops({ x: 40, y: 40, z: 6 }, achievedClamped), true,
  "a genuine manual z-step still stops follow");
assert.equal(driftStops({ x: 43, y: 41, z: 5 }, achievedClamped), false,
  "sub-threshold chase jitter around the achieved centre does not stop follow");

// --- (2) Locate outcome: transient absence persists; only despawn/death disengages ------------
// Model of one tick's locate decision: live snapshot first, then a /unit fallback.
function classifyLocate({ live, fetchResult }) {
  // fetchResult: null (no fetch this tick / throttled), or { ok, status, body }
  if (live) return { pos: live, deadStop: false };
  if (!fetchResult) return { pos: null, deadStop: false }; // transient: no fallback landed
  const { ok, status, body } = fetchResult;
  if (ok) {
    const u = body && body.unit;
    const flags = (u && Array.isArray(u.flags)) ? u.flags.join(" ").toLowerCase() : "";
    if ((body && body.error) || (u && (u.dead || /dead|deceas|corpse/.test(flags))))
      return { pos: null, deadStop: true };
    const t = body && body.tile;
    if (t && Number.isFinite(Number(t.x))) return { pos: { x: t.x, y: t.y, z: t.z }, deadStop: false };
    return { pos: null, deadStop: false };
  }
  if (status === 404) {
    const emsg = body && body.error ? String(body.error).toLowerCase() : "";
    if (/not\s*found/.test(emsg)) return { pos: null, deadStop: true }; // permanent despawn
  }
  return { pos: null, deadStop: false }; // transient server error / timeout
}

// The follow-persistence rule: stop ONLY on deadStop; a null pos with no deadStop keeps the lock.
function tickKeepsFollowing(outcome) { return !outcome.deadStop; }

// Unit temporarily off-snapshot AND the throttled fallback did not run this tick -> persist.
let out = classifyLocate({ live: null, fetchResult: null });
assert.deepEqual(out, { pos: null, deadStop: false }, "transient absence yields no pos and no stop");
assert.equal(tickKeepsFollowing(out), true, "follow PERSISTS through transient absence (no miss stop)");

// Even a long absence (many ticks) never accumulates into a stop.
for (let i = 0; i < 40; i++) {
  assert.equal(tickKeepsFollowing(classifyLocate({ live: null, fetchResult: null })), true,
    "follow never times out on sustained transient absence");
}

// Re-attach: the unit reappears in the live snapshot -> follow resumes centring on it.
out = classifyLocate({ live: { x: 120, y: 90, z: 7 }, fetchResult: null });
assert.deepEqual(out.pos, { x: 120, y: 90, z: 7 }, "follow re-attaches when the unit reappears live");
assert.equal(out.deadStop, false, "re-attach is not a stop");

// Off-viewport / other z-level: not in live snapshot, but /unit fallback still locates it (DF
// finds a live unit anywhere) -> follow tracks it across the excursion.
out = classifyLocate({ live: null, fetchResult: { ok: true, status: 200, body: { tile: { x: 200, y: 10, z: 12 } } } });
assert.deepEqual(out.pos, { x: 200, y: 10, z: 12 }, "fallback locates an off-snapshot unit and follow tracks it");
assert.equal(out.deadStop, false, "off-snapshot excursion is not a stop");

// Confirmed death (dead flag) -> disengage.
out = classifyLocate({ live: null, fetchResult: { ok: true, status: 200, body: { unit: { dead: true }, tile: { x: 1, y: 1, z: 1 } } } });
assert.equal(out.deadStop, true, "a dead unit stops follow");
assert.equal(tickKeepsFollowing(out), false, "follow disengages on confirmed death");

// Confirmed despawn (/unit 404 'unit not found') -> disengage.
out = classifyLocate({ live: null, fetchResult: { ok: false, status: 404, body: { ok: false, error: "unit not found" } } });
assert.equal(out.deadStop, true, "a despawned unit (404 not found) stops follow");

// Transient render-thread hiccup that also 404s with a DIFFERENT message -> persist (not despawn).
out = classifyLocate({ live: null, fetchResult: { ok: false, status: 404, body: { ok: false, error: "render thread busy" } } });
assert.equal(out.deadStop, false, "a non-'not found' 404 is treated as transient, not a despawn");
assert.equal(tickKeepsFollowing(out), true, "follow persists through a transient render-thread 404");

// A 5xx / network timeout (no body) -> persist.
out = classifyLocate({ live: null, fetchResult: { ok: false, status: 503, body: null } });
assert.equal(out.deadStop, false, "a 5xx/timeout is transient, not a despawn");

// --- The real core must adopt the new mechanism -----------------------------------------------
const core = readFileSync("web/js/dwf-unit-hud-notifications.js", "utf8");

// (1) Drift baseline is the achieved view centre, not the unit tile.
assert.match(core, /let unitFollowViewCenter = null;/, "core tracks the achieved-view-centre baseline");
assert.match(core, /cc\.x - unitFollowViewCenter\.x/, "drift check compares against the achieved view centre");
assert.doesNotMatch(core, /cc\.x - unitFollowCenter\.x/, "drift check no longer compares against the unit tile");

// (2) The miss-limit auto-stop is gone; transient absence persists.
assert.doesNotMatch(core, /FOLLOW_MISS_LIMIT/, "the ~2 s miss-limit auto-stop constant is removed");
assert.doesNotMatch(core, /unitFollowMiss/, "the miss counter is removed");

// (2) /unit 404 'not found' is the definitive despawn signal.
assert.match(core, /r\.status === 404/, "core treats a /unit 404 as a despawn candidate");
assert.ok(core.includes("/not\\s*found/.test(emsg)"),
  "core requires a not-found message before treating a 404 as a despawn");

console.log("followcam_unit_persist_test: PASS");
