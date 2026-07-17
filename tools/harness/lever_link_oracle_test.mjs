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

// lever_link_oracle_test.mjs -- DEPLOY-GATED, LIVE / DF-INTERRUPTING acceptance oracle for
// POST /lever-link. Run only by explicit name after deployment, with DF_LOCK held and the chat
// warning sent. It queues one native LinkBuildingToTrigger job, reads its actual job/ref/item
// state through dfhack-run Lua, then cancels it through /task-cancel and proves both mechanism
// reservations were released. No temporary Lua files are created.
//
//   node tools/harness/lever_link_oracle_test.mjs --i-understand-live-mutation
//       [--host http://localhost:8765]
//       [--dfhack-run <path to dfhack-run.exe>]
//
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN. The explicit acknowledgement is mandatory because this
// creates and immediately cancels a real job in the loaded fortress.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { requireLiveOptIn } from "./live_guard.mjs";

import { defaultDfhackRun } from "../lib/dfroot.mjs";   // W1: resolved, never hardcoded
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg("--host", "http://localhost:8765").replace(/\/+$/, "");

// B242: a live oracle must be asked for on purpose -- port 8765 may be a fort someone is playing.
requireLiveOptIn("lever_link_oracle_test.mjs", BASE);
const DFHACK_RUN = arg("--dfhack-run", defaultDfhackRun());
const HEADERS = { Cookie: "dfcap_auth=123" };
const TARGET_TYPES = new Set([
  "Floodgate", "Bridge", "Door", "Hatch", "Floor Grate", "Wall Grate",
  "Floor Bars", "Vertical Bars", "Cage", "Chain", "Gear Assembly", "Spike",
  "Track Stop", "Roller",
]);

let passed = 0;
let failed = 0;
function check(name, condition, extra = "") {
  if (condition) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${extra ? `  ${extra}` : ""}`);
  }
}
function seededBad(name, condition) {
  check(`(test-the-test) ${name}`, !condition, condition ? "oracle did not discriminate" : "");
}
function cannotRun(message) {
  console.log(`CANNOT RUN - ${message}`);
  process.exit(2);
}

async function request(path, method = "GET") {
  const response = await fetch(`${BASE}${path}`, { method, headers: HEADERS, cache: "no-store" });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data };
}
function lua(code) {
  return execFileSync(DFHACK_RUN, ["lua", code], { encoding: "utf8" }).trim();
}
function builtLeverId() {
  return Number(lua("local id=-1 for _,b in ipairs(df.global.world.buildings.other.TRAP) do if b.trap_type==df.trap_type.Lever and b:getBuildStage()>=b:getMaxBuildStage() then id=b.id break end end print(id)"));
}
function jobShape(jobId, leverId, targetId, triggerId, targetMechanismId) {
  return lua(`local utils=require('utils') local j=nil for _,x in utils.listpairs(df.global.world.jobs.list) do if x.id==${jobId} then j=x break end end if not j then print('missing') else local h=false local t=false local a=false local b=false for _,r in ipairs(j.general_refs) do if r._type==df.general_ref_building_holderst and r.building_id==${leverId} then h=true end if r._type==df.general_ref_building_triggertargetst and r.building_id==${targetId} then t=true end end for _,r in ipairs(j.items) do if r.item and r.item.id==${triggerId} and r.role==df.job_role_type.LinkToTrigger then a=true end if r.item and r.item.id==${targetMechanismId} and r.role==df.job_role_type.LinkToTarget then b=true end end print(tostring(j.job_type==df.job_type.LinkBuildingToTrigger)..'|'..tostring(h)..'|'..tostring(t)..'|'..tostring(a)..'|'..tostring(b)) end`);
}
function jobExists(jobId) {
  return lua(`local utils=require('utils') local found=false for _,x in utils.listpairs(df.global.world.jobs.list) do if x.id==${jobId} then found=true break end end print(found)`) === "true";
}
function reservationFlags(firstId, secondId) {
  return lua(`local a=df.item.find(${firstId}) local b=df.item.find(${secondId}) print((a and tostring(a.flags.in_job) or 'gone')..'|'..(b and tostring(b.flags.in_job) or 'gone'))`);
}
function mechanismIds(data) {
  return Array.isArray(data && data.mechanisms) ? data.mechanisms.map(m => Number(m && m.id)).filter(Number.isInteger) : [];
}
function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

if (!process.argv.includes("--i-understand-live-mutation")) {
  cannotRun("live mutation acknowledgement missing. Re-run with --i-understand-live-mutation after deployment, DF_LOCK, and chat warning.");
}

let created = null;
let cleanupDone = false;
async function cleanupCreatedJob() {
  if (!created || cleanupDone) return;
  const cancelled = await request(`/task-cancel?job=${created.jobId}`, "POST");
  const gone = !jobExists(created.jobId);
  const flags = reservationFlags(created.mechanisms[0], created.mechanisms[1]);
  check("cleanup: /task-cancel accepted queued link job", cancelled.status === 200, `status=${cancelled.status}`);
  check("cleanup: queued link job is gone", gone);
  check("cleanup: both mechanism reservations released", flags === "false|false", `flags=${flags}`);
  cleanupDone = cancelled.status === 200 && gone && flags === "false|false";
}

(async () => {
  try {
    try {
      const health = await request("/health");
      if (health.status !== 200) throw new Error(`/health ${health.status}`);
    } catch (error) {
      cannotRun(`server unreachable at ${BASE} (${error.message}). Deploy the DLL and load a fortress first.`);
    }
    try {
      if (lua("print(df.global.world ~= nil)") !== "true") throw new Error("world nil");
    } catch (error) {
      cannotRun(`dfhack-run Lua unavailable at ${DFHACK_RUN} (${error.message}).`);
    }

    const leverId = builtLeverId();
    if (!Number.isInteger(leverId) || leverId < 0) cannotRun("no built lever found. Build a lever, then re-run.");
    const before = await request(`/lever-link?id=${leverId}`);
    if (before.status === 404 || !before.data || before.data.isLever !== true) {
      cannotRun("deployed DLL does not expose /lever-link for a built lever (old DLL or route unavailable).");
    }
    const available = mechanismIds(before.data);
    if (available.length < 2 || Number(before.data.mechanismCount) < 2 || before.data.needsMechanisms) {
      cannotRun("fewer than two available mechanisms. Provide two loose, unrestricted mechanisms and re-run.");
    }
    const targets = Array.isArray(before.data.targets) ? before.data.targets : [];
    if (!targets.length) cannotRun("no linkable target found. Build one supported target and re-run.");

    console.log(`SUBJECTS: lever ${leverId}, ${available.length} available mechanisms, ${targets.length} targets.`);
    check("GET: mechanismCount matches enumerated available mechanisms", Number(before.data.mechanismCount) === available.length);
    check("GET: every target has a supported concrete type", targets.every(t => t && TARGET_TYPES.has(t.type)),
      `types=${targets.map(t => t && t.type).join(",")}`);
    check("GET: every target carries non-negative distance", targets.every(t => t && Number.isInteger(Number(t.distance)) && Number(t.distance) >= 0));

    console.log("MATRIX: invalid target counterexample does not reserve mechanisms");
    const invalid = await request(`/lever-link?id=${leverId}&target=999999999`, "POST");
    const afterInvalid = await request(`/lever-link?id=${leverId}`);
    check("invalid target: HTTP 400", invalid.status === 400, `status=${invalid.status}`);
    check("invalid target: available mechanism ids unchanged", sameIds(available, mechanismIds(afterInvalid.data)),
      `before=${available.join(",")} after=${mechanismIds(afterInvalid.data).join(",")}`);
    check("invalid target: sampled mechanism reservations remain clear",
      reservationFlags(available[0], available[1]) === "false|false",
      `flags=${reservationFlags(available[0], available[1])}`);

    const target = targets[0];
    console.log(`MATRIX: queue LinkBuildingToTrigger for ${target.type} target ${target.id}`);
    const queued = await request(`/lever-link?id=${leverId}&target=${target.id}`, "POST");
    check("queue: HTTP 200", queued.status === 200, `status=${queued.status}`);
    check("queue: JSON has jobId plus exactly two mechanism ids",
      queued.data && Number.isInteger(Number(queued.data.jobId)) && Array.isArray(queued.data.mechanisms) && queued.data.mechanisms.length === 2,
      JSON.stringify(queued.data));
    if (!queued.data || !Number.isInteger(Number(queued.data.jobId)) || !Array.isArray(queued.data.mechanisms) || queued.data.mechanisms.length !== 2) {
      throw new Error("queue response cannot be cleaned up safely");
    }

    created = { jobId: Number(queued.data.jobId), mechanisms: queued.data.mechanisms.map(Number) };
    const shape = jobShape(created.jobId, leverId, Number(target.id), created.mechanisms[0], created.mechanisms[1]);
    check("queue: live job/ref/item-role shape is exact", shape === "true|true|true|true|true", `shape=${shape}`);
    const reserved = reservationFlags(created.mechanisms[0], created.mechanisms[1]);
    check("queue: both mechanism items are reserved", reserved === "true|true", `flags=${reserved}`);
    seededBad("queue: both mechanism items are already clear before cancellation", reserved === "false|false");

    console.log("MATRIX: cancel queued job and release both mechanisms");
    await cleanupCreatedJob();
    if (cleanupDone) created = null;
  } catch (error) {
    console.error("HARNESS ERROR:", error.message);
    failed++;
  } finally {
    if (created && !cleanupDone) {
      try {
        console.error(`EMERGENCY CLEANUP: cancelling queued link job ${created.jobId}.`);
        await cleanupCreatedJob();
      } catch (error) {
        console.error(`EMERGENCY CLEANUP FAILED for job ${created.jobId}: ${error.message}`);
      }
    }
    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exitCode = failed ? 1 : 0;
  }
})().catch(error => { console.error("HARNESS FATAL:", error); process.exit(1); });
