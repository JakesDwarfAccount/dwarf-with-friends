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

// onboarding_wave_e_test.mjs -- WAVE E onboarding regressions (offline).
// Exercises the real core identity prefix, the real follow-button visibility helper, and the
// join-submit ordering without starting a browser or contacting a host.
// Run: node tools/harness/onboarding_wave_e_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.resolve(__dirname, "../../web/js/dwf-core.js");
const joinPath = path.resolve(__dirname, "../../web/js/dwf-join.js");
const controlsPath = path.resolve(__dirname, "../../web/js/dwf-controls-placement.js");
const core = fs.readFileSync(corePath, "utf8");
const join = fs.readFileSync(joinPath, "utf8");
const controls = fs.readFileSync(controlsPath, "utf8");

let passed = 0;
function ok(condition, message) { assert.ok(condition, message); passed++; }

function bootIdentity(storedName, query) {
  const writes = [];
  const storage = {
    getItem(key) { return key === "dwf.player" ? storedName : null; },
    setItem(key, value) { writes.push([key, value]); },
  };
  const window = {};
  const cutoff = core.indexOf("\n  const view");
  assert.ok(cutoff > 0, "could not isolate core identity block");
  vm.runInNewContext(core.slice(0, cutoff), {
    URLSearchParams, window, localStorage: storage, location: { search: query || "" },
    crypto: { randomUUID: () => "fresh-uuid" }, Date, Math,
  }, { filename: corePath });
  return { window, writes };
}

// Fresh profiles keep only an in-memory fallback until the join screen supplies a real name.
{
  const fresh = bootIdentity(null, "");
  ok(fresh.window.playerName === "fresh-uuid", "E1: fresh profile starts with in-memory fallback");
  ok(fresh.writes.length === 0, "E2: fresh fallback UUID is never written to localStorage");
  fresh.window.__dwfAdoptName("Ada");
  ok(fresh.window.playerName === "Ada", "E3: join adoption updates live player identity without reload");
}

// Existing names still win at core startup.
{
  const returning = bootIdentity("Urist", "?player=SomeoneElse");
  ok(returning.window.playerName === "Urist", "E4: returning stored name remains authoritative");
}

// The join submit must adopt before storing/resolving the gate.
const adoptAt = join.indexOf("window.__dwfAdoptName(name)");
const storeAt = join.indexOf("localStorage.setItem(NAME_KEY, name)");
ok(adoptAt >= 0 && storeAt > adoptAt, "E5: join submit adopts the selected name before persisting it");

// Follow marker is hidden until a real follow lock says otherwise.
//
// B242: this pinned setFollowButtonVisibility(button, state) and a spectate-only onChange line.
// The helper was since rebuilt around followLocks -- the ONE button now reflects and clears BOTH
// the player-spectate lock and the unit-follow camera latch, and takes its state from the locks
// rather than from a passed-in spectate state. The old signature is gone; the CONTRACT (hidden
// while nothing is followed, visible while something is, resubscribed to every lock) is not, so
// this exercises the real helper against both locks.
const labels = controls.match(/  function followingLabels\(\) \{[\s\S]*?\n  \}/);
const helper = controls.match(/  function setFollowButtonVisibility\(button\) \{[\s\S]*?\n  \}/);
assert.ok(labels && helper, "could not find follow-button visibility helper");
const followContext = { followLocks: [] };
vm.runInNewContext(`${labels[0]}\n${helper[0]}\nthis.setFollowButtonVisibility = setFollowButtonVisibility;`,
  followContext, { filename: controlsPath });
const button = { hidden: false, title: "" };
const lock = (label, following) => ({ label, api: { getState: () => ({ following }) } });

followContext.followLocks.push(lock("player", false), lock("unit", false));
followContext.setFollowButtonVisibility(button);
ok(button.hidden === true, "E6: follow stop button hides while nothing is followed");
ok(button.title === "", "E6b: the hidden button carries no stale tooltip");

followContext.followLocks[0] = lock("player", true);
followContext.setFollowButtonVisibility(button);
ok(button.hidden === false, "E7: follow stop button shows while a player is followed");
ok(/Stop following player/.test(button.title), "E7b: the tooltip names the engaged lock");

// The unit-camera latch is a follow too -- before the rebuild this button ignored it.
followContext.followLocks[0] = lock("player", false);
followContext.followLocks[1] = lock("unit", true);
followContext.setFollowButtonVisibility(button);
ok(button.hidden === false, "E7c: follow stop button shows while a UNIT is followed");
followContext.followLocks[0] = lock("player", true);
followContext.setFollowButtonVisibility(button);
ok(/Stop following player \+ unit/.test(button.title), "E7d: both engaged locks are named");

ok(/followLocks\.forEach\(lock => \{\s*if \(typeof lock\.api\.onChange === "function"\)\s*lock\.api\.onChange\(\(\) => setFollowButtonVisibility\(followBtn\)\);/.test(controls),
   "E8: follow stop button subscribes to onChange on EVERY follow lock, not just spectate");
ok(/followLocks\.forEach\(lock => \{[\s\S]*?stopFollow/.test(controls),
   "E8b: clicking the button clears every engaged lock");

console.log("onboarding_wave_e_test: OK (" + passed + " assertions)");
