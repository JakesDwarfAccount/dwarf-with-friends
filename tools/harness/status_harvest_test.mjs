// status_harvest_test.mjs -- NATIVE-STATUS-BUBBLE §3.A screen-array harvest.
// Run: node tools/harness/status_harvest_test.mjs
//
// WHAT THIS PINS. The harvest route (src/status_harvest.cpp, GET /statusharvest) attributes each
// painted UNIT_STATUS cell in DF's screen arrays to the unit under it, per the spec's live-probe
// pinned addressing. I cannot run the plugin from this worktree (no build, live game off-limits),
// so this suite verifies the two things that are verifiable WITHOUT a running game:
//
//   1) THE ATTRIBUTION ALGORITHM, against the spec's real live-probe frame (2026-07-14). The probe
//      observed (spec §3.A): viewport 53x33, window (64,95,176); STRESSED painted at view (26,2)
//      with its unit at (26,3); SLEEPING at (32,22)/(33,22) with units at (32,23)/(33,23); GROUNDED
//      ON the unit's own tile (35,7). Those are ground truth. A reference scanner (identical math to
//      the C++) must reproduce that exact attribution: column-major idx = x*dim_y+y, texpos->row via
//      the live UNIT_STATUS page vector, unit found at offset (0,-1) then (0,0).
//   2) SOURCE LOCKSTEP. Because #1 tests a JS reference and the game is served by the C++, a set of
//      source guards assert the C++ encodes THAT SAME algorithm (same index formula, same offsets,
//      same token, texpos re-read per call not baked). Same discipline as status_truth_test.mjs /
//      ui_drift_guard_test.mjs: the harness is authoritative, the C++ is a checked transcription the
//      orchestrator still builds and runs against the live oracle.
//
// This is failing-first for the source half: with src/status_harvest.cpp absent, every guard fails.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

// ---- the 41 UNIT_STATUS rows in the game's own sheet order (spec §2.1) --------------------------
const ROW_NAMES = [
  "MIGRANT", "NO_JOB", "NO_DESTINATION", "HUNGRY", "THIRSTY", "DROWSY", "STRESSED", "DISTRACTED",
  "SLEEPING", "FEY_MOOD", "POSSESSED", "SECRETIVE_MOOD", "FELL_MOOD", "MACABRE_MOOD", "TANTRUM",
  "OBLIVIOUS", "DEPRESSION", "MADNESS", "MELANCHOLY", "BERSERK", "ENRAGED", "MARTIAL_TRANCE",
  "TERRIFIED", "WRESTLING", "MINOR_INJURY", "MAJOR_INJURY", "PARALYZED", "STUNNED", "NAUSEA",
  "WINDED", "UNCONSCIOUS", "FEVERED", "YIELDING", "PLAYING_MAKE_BELIEVE", "TELLING_A_STORY",
  "RECITING_POETRY", "PERFORMING", "PROJECTILE", "GROUNDED", "WEBBED", "CLIMBING",
];
const rowOf = (name) => ROW_NAMES.indexOf(name);

// ---- reference attribution algorithm (mirror of status_harvest.cpp) ------------------------------
// A "layer" is a flat column-major array of length dim_x*dim_y (idx = x*dim_y + y). `paint` places a
// texpos at a view cell. `harvest` scans, maps texpos->row via the live page vector, and attributes
// each hit to a unit at offset (0,-1) first (bubble above unit) then (0,0) (on-tile marker).
function makeLayer(dimX, dimY) { return new Int32Array(dimX * dimY); }
function paint(layer, dimY, vx, vy, texpos) { layer[vx * dimY + vy] = texpos; }

function harvest({ dimX, dimY, win, pageTexpos, layers, units }) {
  const texposRow = new Map();
  pageTexpos.forEach((tp, i) => { if (tp > 0) texposRow.set(tp, i); });
  const unitAt = new Map();
  for (const u of units) unitAt.set(`${u.x}|${u.y}|${u.z}`, u);
  const hits = [];
  for (const [name, arr] of Object.entries(layers)) {
    for (let x = 0; x < dimX; x++) {
      for (let y = 0; y < dimY; y++) {
        const v = arr[x * dimY + y];
        if (v <= 0 || !texposRow.has(v)) continue;
        const mx = win.x + x, my = win.y + y;
        let unit = unitAt.get(`${mx}|${my + 1}|${win.z}`), dyOff = 1;
        if (!unit) { unit = unitAt.get(`${mx}|${my}|${win.z}`); dyOff = unit ? 0 : null; }
        hits.push({ layer: name, vx: x, vy: y, texpos: v, row: texposRow.get(v),
          name: ROW_NAMES[texposRow.get(v)], unit: unit || null, offset: unit ? [0, dyOff === 0 ? 0 : -dyOff] : null });
      }
    }
  }
  return hits;
}

// ---- 1) GOLDEN FIXTURE: the spec's real live-probe frame (2026-07-14) ----------------------------
// texpos values 135397..135437 = the 41 UNIT_STATUS ids observed loaded that session (spec §2.2,
// "contiguous this load"). Row r -> texpos 135397+r.
const BASE = 135397;
const pageTexpos = Array.from({ length: 41 }, (_, r) => BASE + r);
const dimX = 53, dimY = 33, win = { x: 64, y: 95, z: 176 };

const desig = makeLayer(dimX, dimY);
const creature = makeLayer(dimX, dimY);
// STRESSED (row 6) at view (26,2); its unit stands at (26,3) -> map (90,98).
paint(desig, dimY, 26, 2, BASE + rowOf("STRESSED"));
// SLEEPING (row 8) at (32,22) and (33,22); units at (32,23)/(33,23).
paint(desig, dimY, 32, 22, BASE + rowOf("SLEEPING"));
paint(desig, dimY, 33, 22, BASE + rowOf("SLEEPING"));
// GROUNDED (row 38) ON the unit's own tile (35,7) -- offset (0,0).
paint(desig, dimY, 35, 7, BASE + rowOf("GROUNDED"));
// a UNIT_STATUS cell with no unit beneath it -> must land in "unmatched", never mis-attributed.
paint(desig, dimY, 5, 5, BASE + rowOf("THIRSTY"));

const units = [
  { id: 101, x: 64 + 26, y: 95 + 3, z: 176 },   // under STRESSED bubble
  { id: 102, x: 64 + 32, y: 95 + 23, z: 176 },  // under first SLEEPING
  { id: 103, x: 64 + 33, y: 95 + 23, z: 176 },  // under second SLEEPING
  { id: 104, x: 64 + 35, y: 95 + 7, z: 176 },   // ON the GROUNDED tile
  { id: 105, x: 64 + 1, y: 95 + 1, z: 176 },    // decoy elsewhere -- must not be attributed
];

const hits = harvest({ dimX, dimY, win, pageTexpos, layers: { designation: desig, screentexpos: creature }, units });
const matched = hits.filter((h) => h.unit);
const unmatched = hits.filter((h) => !h.unit);

const byUnit = (id) => matched.find((h) => h.unit && h.unit.id === id);
assert.equal(byUnit(101).name, "STRESSED", "unit 101 gets STRESSED");
assert.deepEqual(byUnit(101).offset, [0, -1], "STRESSED is one tile ABOVE the unit");
assert.equal(byUnit(102).name, "SLEEPING", "unit 102 gets SLEEPING");
assert.equal(byUnit(103).name, "SLEEPING", "unit 103 gets SLEEPING");
assert.deepEqual(byUnit(102).offset, [0, -1], "SLEEPING is one tile ABOVE the unit");
assert.equal(byUnit(104).name, "GROUNDED", "unit 104 gets GROUNDED");
assert.deepEqual(byUnit(104).offset, [0, 0], "GROUNDED renders ON the unit's own tile");
assert.ok(!byUnit(105), "the decoy unit gets no bubble");
assert.equal(matched.length, 4, "exactly the four painted+occupied cells attribute to a unit");
assert.equal(unmatched.length, 1, "the empty-tile THIRSTY cell is reported unmatched, not mis-attributed");
assert.equal(unmatched[0].name, "THIRSTY", "the unmatched cell keeps its row name");
// row index == sheet row == raws name index, exactly (art parity by construction).
assert.equal(rowOf("SLEEPING"), 8, "SLEEPING is sheet row 8");
assert.equal(rowOf("GROUNDED"), 38, "GROUNDED is sheet row 38");
assert.equal(ROW_NAMES.length, 41, "the sheet has 41 rows");

// ---- 2) SOURCE LOCKSTEP: the C++ encodes this same algorithm -------------------------------------
const cpp = read("src", "status_harvest.cpp");
const guard = (re, why) => assert.ok(re.test(cpp), `status_harvest.cpp must ${why}`);
guard(/x\s*\*\s*dim_y\s*\+\s*y/, "index the screen arrays column-major (idx = x*dim_y + y)");
guard(/screentexpos_designation/, "scan the DESIGNATION layer the spec pinned");
guard(/pg->token\s*!=\s*"UNIT_STATUS"/, "select the UNIT_STATUS texture page by token");
guard(/pg->texpos\[i\]/, "re-read the page's texpos vector per call (never a baked constant)");
guard(/my\s*\+\s*1/, "look for the unit one tile BELOW the bubble (offset (0,-1))");
guard(/df::global::window_x/, "convert view->map via window_x/y/z");
// the C++ row-name table must match the raws order exactly (name-addressed art parity).
for (const n of ["STRESSED", "SLEEPING", "GROUNDED", "MIGRANT", "CLIMBING"])
  guard(new RegExp(`"${n}"`), `name UNIT_STATUS row ${rowOf(n)} (${n})`);
// it must NOT bake texpos numbers as constants (contiguity is an observation, not a contract).
assert.ok(!/135397|135437/.test(cpp), "status_harvest.cpp must not hard-code this session's texpos ids");

console.log("status_harvest_test: PASS");
