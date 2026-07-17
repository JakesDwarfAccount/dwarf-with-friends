// b55_farmplot_oracle_test.mjs -- DEPLOY-GATED B55 farm-plot round-trip oracle.
// LIVE / DF-INTERRUPTING: run by this explicit name only, inside an agreed deploy/test window
// while holding DF_LOCK. It does not launch, kill, click, pause, or reload DF. It changes one
// season to fallow then to a currently listed crop, reads df::building_farmplotst::plant_id[4]
// through dfhack-run after each write, and restores the original selection before exit.
//
//   node tools/harness/b55_farmplot_oracle_test.mjs [--host http://localhost:8765]
//                                                  [--dfhack-run <path>]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { requireLiveOptIn } from "./live_guard.mjs";

import { defaultDfhackRun } from "../lib/dfroot.mjs";   // W1: resolved, never hardcoded
const hostIndex = process.argv.indexOf("--host");
const BASE = (hostIndex >= 0 && process.argv[hostIndex + 1] ? process.argv[hostIndex + 1] : "http://localhost:8765").replace(/\/+$/, "");

// B242: a live oracle must be asked for on purpose -- port 8765 may be a fort someone is playing.
requireLiveOptIn("b55_farmplot_oracle_test.mjs", BASE);
const runIndex = process.argv.indexOf("--dfhack-run");
const DFHACK_RUN = runIndex >= 0 && process.argv[runIndex + 1]
  ? process.argv[runIndex + 1] : defaultDfhackRun();
const HEADERS = { Cookie: "dfcap_auth=123" };
let passed = 0, failed = 0;
function check(name, condition, extra = "") { if (condition) { passed++; console.log(`  ok - ${name}`); } else { failed++; console.log(`  FAIL - ${name}${extra ? `  ${extra}` : ""}`); } }
function seededBad(name, condition) { check(`(test-the-test) ${name}`, !condition); }
function cannotRun(message) { console.log(`CANNOT RUN - ${message}`); process.exit(2); }
function lua(code) { return execFileSync(DFHACK_RUN, ["lua", code], { encoding: "utf8" }).trim(); }
async function json(path, init = {}) { const r = await fetch(`${BASE}${path}`, { headers: HEADERS, ...init }); let data = null; let text = ""; try { text = await r.text(); data = text ? JSON.parse(text) : null; } catch (_) {} return { status: r.status, data, text }; }
function plantId(id, season) { const out = lua(`local b=df.building.find(${id}) if not b or not df.building_farmplotst:is_instance(b) then print('none') else print(b.plant_id[${season}]) end`); return out === "none" ? null : Number(out); }
function firstBuiltFarm() { const out = lua("for _,b in ipairs(df.global.world.buildings.other.FARM_PLOT) do if b and b:getBuildStage()==b:getMaxBuildStage() then print(b.id) return end end print('none')"); return out === "none" ? null : Number(out); }

(async () => {
  try { const h = await fetch(`${BASE}/health`, { headers: HEADERS }); if (!h.ok) throw new Error(`/health ${h.status}`); }
  catch (error) { cannotRun(`server unreachable at ${BASE} (${error.message}). Deploy + load a fort first.`); }
  try { if (lua("print(df.global.world ~= nil)") !== "true") throw new Error("world nil"); }
  catch (error) { cannotRun(`dfhack-run unavailable at ${DFHACK_RUN} (${error.message}).`); }

  const id = firstBuiltFarm();
  if (!Number.isInteger(id) || id < 0) cannotRun("no built farm plot exists in this fort.");
  const state = await json(`/farm-plot?id=${id}&t=${Date.now()}`);
  if (state.status === 404) cannotRun("deployed DLL has no /farm-plot route yet.");
  if (!state.data || !state.data.isFarmPlot || !Array.isArray(state.data.seasons)) cannotRun(`/farm-plot did not return B55 state (HTTP ${state.status}).`);
  // Only mutate a season we can restore through the same validated route: its existing crop
  // must be fallow or still present in the currently usable crop list.
  const subject = state.data.seasons.find(row => Array.isArray(row.crops) && row.crops.length > 0 &&
    (Number(row.plantId) < 0 || row.crops.some(crop => Number(crop.id) === Number(row.plantId))));
  if (!subject) cannotRun("farm plot has no plantable season whose current selection can be safely restored.");
  const season = Number(subject.season), crop = subject.crops[0];
  const original = plantId(id, season);
  if (!Number.isInteger(season) || !Number.isInteger(Number(crop.id)) || !Number.isInteger(original)) cannotRun("could not establish farm/season oracle baseline.");
  console.log(`SUBJECT: farm ${id}, ${subject.name}, crop ${crop.id}`);

  check("GET /farm-plot returns HTTP 200", state.status === 200, `status=${state.status}`);
  check("state has four seasons", state.data.seasons.length === 4);
  check("listed crop carries a positive seed count", Number(crop.seedCount) > 0);

  let restoreNeeded = false;
  try {
    const fallow = await json(`/farm-plot-action?id=${id}&season=${season}&plant=-1`, { method: "POST" });
    restoreNeeded = true;
    check("set fallow HTTP 200", fallow.status === 200, `status=${fallow.status} ${fallow.text}`);
    check("fallow oracle writes plant_id = -1", plantId(id, season) === -1);
    seededBad("fallow oracle does not accept the old crop id", plantId(id, season) === original);

    const set = await json(`/farm-plot-action?id=${id}&season=${season}&plant=${Number(crop.id)}`, { method: "POST" });
    check("set listed crop HTTP 200", set.status === 200, `status=${set.status} ${set.text}`);
    check("listed crop oracle round-trips to plant_id", plantId(id, season) === Number(crop.id));

    const winter = state.data.seasons.find(row => Number(row.season) === 3);
    const nonWinter = state.data.seasons.find(row => Number(row.season) !== 3 && Array.isArray(row.crops) && row.crops.some(candidate => !winter?.crops?.some(w => Number(w.id) === Number(candidate.id))));
    if (winter && nonWinter) {
      const invalid = nonWinter.crops.find(candidate => !winter.crops.some(w => Number(w.id) === Number(candidate.id)));
      const reject = await json(`/farm-plot-action?id=${id}&season=3&plant=${Number(invalid.id)}`, { method: "POST" });
      check("winter-invalid crop is rejected", reject.status === 400, `status=${reject.status} ${reject.text}`);
    } else console.log("  SKIP - winter-invalid crop (world has no season-specific listed crop pair)");
  } finally {
    if (restoreNeeded) {
      const restore = await json(`/farm-plot-action?id=${id}&season=${season}&plant=${original}`, { method: "POST" });
      check("restore HTTP 200", restore.status === 200, `status=${restore.status} ${restore.text}`);
      check("restore oracle returns original plant_id", plantId(id, season) === original);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error("HARNESS ERROR:", error); process.exit(1); });
