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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const FOLLOW_POST_MIN_MS = 250;
const FOLLOW_DEADBAND_TILES = 1;

function finiteRosterNumber(v) {
  return (typeof v === "number" && Number.isFinite(v)) ? v : null;
}

function cameraFromPresence(p) {
  if (!p) return null;
  const hasCamShape = p.camx !== undefined || p.camy !== undefined || p.camz !== undefined;
  let x = finiteRosterNumber(p.camx), y = finiteRosterNumber(p.camy), z = finiteRosterNumber(p.camz);
  if (hasCamShape) {
    if (x === null || y === null || z === null) return null;
  } else {
    x = finiteRosterNumber(p.x); y = finiteRosterNumber(p.y); z = finiteRosterNumber(p.z);
    if (x === null || y === null || z === null) return null;
  }
  return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
}

function shouldPost(lastSent, next, now, lastPostAt) {
  if (!next) return false;
  if (!lastSent) return true;
  if (now - (lastPostAt || 0) < FOLLOW_POST_MIN_MS) return false;
  if (next.z !== lastSent.z) return true;
  const dxy = Math.max(Math.abs(next.x - lastSent.x), Math.abs(next.y - lastSent.y));
  return dxy > FOLLOW_DEADBAND_TILES;
}

function reducer(state, event) {
  state = state || { following: false, name: "", lastSent: null, lastPostAt: 0 };
  if (event.type === "follow") return { following: true, name: event.name, lastSent: null, lastPostAt: 0 };
  if (event.type === "manualCameraInput") return { following: false, name: "", lastSent: null, lastPostAt: 0 };
  if (event.type !== "tick" || !state.following) return state;
  const cam = cameraFromPresence(event.player);
  if (!shouldPost(state.lastSent, cam, event.now, state.lastPostAt)) return { ...state, posted: false };
  return { ...state, lastSent: cam, lastPostAt: event.now, posted: true };
}

const good = { name: "guest", camx: 100, camy: 50, camz: 151, x: 3, y: 4, z: 160 };
assert.deepEqual(cameraFromPresence(good), { x: 100, y: 50, z: 151 }, "prefers camera window over cursor xyz");
assert.deepEqual(cameraFromPresence({ name: "old", x: 10, y: 11, z: 12 }), { x: 10, y: 11, z: 12 }, "legacy xyz fallback still works");
assert.equal(cameraFromPresence({ name: "idle" }), null, "missing x/y guard");
assert.equal(cameraFromPresence({ camx: 1, camy: 2 }), null, "partial cam shape is rejected");
assert.equal(cameraFromPresence({ camx: "1", camy: 2, camz: 3 }), null, "string camera coordinate is rejected");
assert.equal(cameraFromPresence({ camx: Number.NaN, camy: 2, camz: 3 }), null, "NaN camera coordinate is rejected");
assert.equal(cameraFromPresence({ camx: Infinity, camy: 2, camz: 3 }), null, "infinite camera coordinate is rejected");
assert.equal(cameraFromPresence({ camx: 1, camy: 2, camz: undefined, x: 90, y: 91, z: 92 }), null,
  "malformed modern cam row does not fall back to cursor xyz");

assert.equal(shouldPost(null, { x: 10, y: 10, z: 5 }, 0, 0), true, "first follow tick posts immediately");
assert.equal(shouldPost({ x: 10, y: 10, z: 5 }, { x: 11, y: 10, z: 5 }, 300, 0), false,
  "1-tile jitter stays inside deadband");
assert.equal(shouldPost({ x: 10, y: 10, z: 5 }, { x: 12, y: 10, z: 5 }, 300, 0), true,
  "2-tile movement crosses deadband");
assert.equal(shouldPost({ x: 10, y: 10, z: 5 }, { x: 10, y: 10, z: 6 }, 300, 0), true,
  "z movement always posts after debounce");
assert.equal(shouldPost({ x: 10, y: 10, z: 5 }, { x: 30, y: 10, z: 5 }, 200, 0), false,
  "debounce suppresses rapid repeat posts");

let s = reducer(null, { type: "follow", name: "guest" });
s = reducer(s, { type: "tick", player: good, now: 0 });
assert.equal(s.posted, true, "follow tick emits camera move for valid target");
s = reducer(s, { type: "tick", player: { ...good, camx: 101 }, now: 300 });
assert.equal(s.posted, false, "seeded 1-tile camera jitter does not spam a move");
s = reducer(s, { type: "tick", player: { ...good, camx: 103 }, now: 550 });
assert.equal(s.posted, true, "follow resumes after meaningful movement and debounce");
s = reducer(s, { type: "manualCameraInput" });
assert.equal(s.following, false, "manual camera input breaks follow mode");
s = reducer(s, { type: "tick", player: { ...good, camx: 120 }, now: 900 });
assert.equal(s.following, false, "stopped follow ignores later presence ticks");

const core = readFileSync("web/js/dwf-core.js", "utf8");
assert.match(core, /const PLAYER_FOLLOW_TICK_MS = 250;/, "core tick cadence matches test");
assert.match(core, /const PLAYER_FOLLOW_DEADBAND_TILES = 1;/, "core deadband matches test");
assert.match(core, /function queueMove\(dx, dy, dz, opts\)/, "queueMove carries follow-break option");
assert.match(core, /stopPlayerFollow\("manual"\)/, "manual camera paths stop player follow");
assert.match(core, /window\.DwfSpectate = \{/, "core exposes DwfSpectate API");

const lobby = readFileSync("web/js/dwf-lobby.js", "utf8");
assert.match(lobby, /data-lobby-follow/, "lobby renders follow controls");
assert.match(lobby, /jumpToPlayer/, "lobby row click calls jump-to-player API");

const Lobby = require("../../web/js/dwf-lobby.js");
assert.equal(Lobby.lobbyConnectionLabel({ rtt: 37 }).text, "37 ms", "measured app RTT remains visible");
assert.equal(Lobby.lobbyConnectionLabel({ lastInboundAgeMs: 250 }).text, "live", "fresh inbound age is honest liveness");
assert.equal(Lobby.lobbyConnectionLabel({ lastInboundAgeMs: 3400 }).text, "3s", "aged inbound data reports elapsed liveness");
assert.equal(Lobby.lobbyConnectionLabel({ rtt: -1 }).text, "live", "unsampled RTT no longer renders a dead dash");

console.log("spectate_client_test: PASS");
