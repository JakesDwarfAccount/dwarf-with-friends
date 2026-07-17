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

// B267/B268: native slope tooltip direction and remove-stairs/ramps designation.
// Offline only: source contracts plus both real renderer designation resolvers.
// Run: node tools/harness/b267_b268_slopes_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const interaction = read("src/interaction.cpp");
const placement = read("src/placement.cpp");
const controls = read("web/js/dwf-controls-placement.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failed++; console.error("FAIL " + name + ": " + err.message); }
}

const hoverShape = interaction.match(/const char\* hover_shape_suffix\([^]*?\n\}/)?.[0] || "";
check("B267 upward slope wording", () => assert.match(hoverShape,
  /case tiletype_shape::RAMP:\s+return " Upward Slope";/,
  "a RAMP must use native's exact 'Upward Slope' form"));
check("B267 downward slope counter-direction", () => assert.match(interaction,
  /shape == tiletype_shape::RAMP_TOP\)\s+return "Downward Slope";/,
  "RAMP_TOP remains native's 'Downward Slope'"));

const toolMap = controls.match(/function backendToolFor\([^]*?\n  \}/)?.[0] || "";
check("B268 client sends the LEGACY spelling, which EVERY server accepts (see the regression note in dwf-controls-placement.js: the client deploys independently of the DLL, and an unknown action does not fail loudly -- it silently does nothing)", () => assert.match(toolMap, /remove:\s*"remove-construction"/,
  "the client must name DF's DIG_REMOVE_STAIRS_RAMPS action, not the construction job"));
check("B268 server action route", () => assert.match(placement,
  /tool == "remove-stairs-ramps"[^]*?DesignationKind::RemoveStairsRamps/,
  "the server must recognize the canonical native action"));

const guard = placement.match(/bool can_remove_stairs_ramps\([^]*?\n\}/)?.[0] || "";
check("B268 natural ramp acceptance", () => assert.match(guard, /tiletype_shape::RAMP/,
  "visible natural RAMP tiles must be accepted"));
check("B268 ramp-top proxy", () => assert.match(guard, /tiletype_shape::RAMP_TOP[^]*?pos\.z - 1[^]*?tiletype_shape::RAMP/,
  "the visible RAMP_TOP proxy must resolve to the upward ramp below"));
check("B268 construction superset", () => assert.match(guard, /tiletype_material::CONSTRUCTION|Constructions::findAtTile/,
  "the combined native action must retain construction removal"));
check("B268 Default designation write", () => assert.match(placement,
  /DesignationKind::RemoveStairsRamps[^]*?des\.bits\.dig = df::tile_dig_designation::Default;/,
  "removal must write DF's REGULAR/Default dig designation"));

const glbox = { self: null };
glbox.self = glbox;
vm.createContext(glbox);
vm.runInContext(read("web/js/dwf-gl.js"), glbox, { filename: "dwf-gl.js" });
const gl = glbox.DwfGL.resolveDesig({ dig: "Default" }, { shape: "RAMP", mat: "SOIL" });
check("B268 GL standard mining glyph", () => {
  assert.deepEqual(Array.from(gl.cell), [0, 1]);
  assert.equal(gl.cat, "dig", "a natural slope uses the standard mining glyph");
});

class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    if (key === "measureText") return () => ({ width: 8 });
    return () => {};
  }, set(target, key, value) { target[key] = value; return true; } }); }
}
const store = {};
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: key => store[key] ?? null,
  setItem: (key, value) => { store[key] = String(value); } };
globalThis.Image = class { set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(read("web/js/dwf-tiles.js"), { filename: "dwf-tiles.js" });
const tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });
const canvas = tiles._resolveDesigForTest({ dig: "Default" }, { shape: "RAMP", mat: "SOIL" });
check("B268 canvas standard mining glyph", () => {
  assert.deepEqual(Array.from(canvas.cell), [0, 1]);
  assert.equal(canvas.cat, "dig", "a natural slope uses the standard mining glyph");
});

// Test-the-test: the prior construction-only predicate cannot satisfy the native slope contract.
const oldGuard = placement.match(/bool can_remove_construction\([^]*?\n\}/)?.[0] || "";
check("B268 old conflated guard retired", () =>
  assert.equal(oldGuard, "", "the misleading construction-only guard must be retired"));

if (failed) {
  console.error(`FAIL ${failed} B267/B268 slope cell(s)`);
  process.exit(1);
}
console.log("PASS B267 directional slope tooltip + B268 native remove-stairs/ramps designation");
