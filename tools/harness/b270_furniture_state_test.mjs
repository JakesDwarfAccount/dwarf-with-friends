// b270_furniture_state_test.mjs -- B270: placed furniture must consume
// building_map.json.furniture material/state cells instead of its flat Type default.
//
// Failing-first proof on pre-fix rework/main: Door bst=0 (open) and bst=1 (closed)
// both resolved to item_door.png 1:0 in both renderers.
// Run: node tools/harness/b270_furniture_state_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bmap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/building_map.json"), "utf8"));
const mmap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));

class FakeImage {
  constructor() { this.onload = null; this.onerror = null; this._src = ""; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
}
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {}
  removeEventListener() {}
  getContext() {
    return new Proxy({}, {
      get(t, prop) {
        if (prop in t) return t[prop];
        if (prop === "measureText") return () => ({ width: 8 });
        return () => {};
      },
      set(t, prop, v) { t[prop] = v; return true; },
    });
  }
}

function sandboxBase() {
  const s = {};
  s.window = s;
  s.self = s;
  s.location = { search: "", protocol: "http:", host: "localhost:8765" };
  s.document = { hidden: false, addEventListener() {}, getElementById() { return null; },
    createElement() { return { style: {} }; }, body: { appendChild() {} } };
  s.addEventListener = () => {};
  s.sessionStorage = { getItem: () => null, setItem() {} };
  s.URLSearchParams = URLSearchParams;
  s.requestAnimationFrame = () => 0;
  s.cancelAnimationFrame = () => {};
  s.setTimeout = setTimeout;
  s.clearTimeout = clearTimeout;
  s.console = console;
  s.Image = FakeImage;
  return s;
}

const ts = sandboxBase();
ts.fetch = async (url) => String(url).includes("building_map.json")
  ? { ok: true, json: async () => bmap }
  : String(url).includes("material_map.json") ? { ok: true, json: async () => mmap }
  : { ok: false, json: async () => null };
vm.createContext(ts);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), ts,
  { filename: "dwf-tiles.js" });
assert.ok(ts.DwfTiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false }));

const gs = { self: null, performance: { now: () => 0 }, console };
gs.self = gs;
vm.createContext(gs);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), gs, { filename: f });
const gl = gs.DwfGL.createSceneBuilder({
  atlas: { resolve() { return 1; } },
  buildingMap: bmap,
  materialMap: mmap,
});

const t0 = Date.now();
while (ts.DwfTiles._buildingEntryForTest({ type: "Workshop", subtype: 0 }).sheet === "defaults.png") {
  if (Date.now() - t0 > 2000) throw new Error("dwf-tiles.js building_map load timed out");
  await new Promise((resolve) => setTimeout(resolve, 1));
}

const renderers = [
  ["canvas2d", (b) => ts.DwfTiles._buildingEntryForTest(b)],
  ["webgl", (b) => gl._buildingEntryForTest(b)],
];
const cell = (e) => e && e.cells && e.cells[0] && e.cells[0][0];
const key = (e) => {
  const c = cell(e);
  return c ? `${e.sheet}|${c.col}|${c.row}` : "missing";
};
const expected = (type, state, material) => {
  const family = bmap.furniture[type];
  const value = state ? family.states[state] : family.matvariants;
  const c = value.sheet ? value : value[material];
  return `${c.sheet}|${c.col}|${c.row}`;
};

console.log("B270: failing-first door proof + furniture state/material lookup");
assert.equal(Object.keys(bmap.furniture).length, 29, "fixture must contain all 29 furniture keys");

for (const [name, resolve] of renderers) {
  const open = resolve({ type: "Door", bst: 0, mat_type: 419, mat_index: 0 });
  const closed = resolve({ type: "Door", bst: 1, mat_type: 419, mat_index: 0 });
  console.log(`  ${name}: open=${key(open)} closed=${key(closed)}`);
  assert.notEqual(key(open), key(closed), `${name}: an open and closed door must not resolve to the same cell`);
  assert.equal(key(open), expected("Door", "OPEN", "WOOD"));
  assert.equal(key(closed), expected("Door", "CLOSED", "WOOD"));

  const cases = [
    ["Floodgate", 0, "OPEN"], ["Floodgate", 1, "CLOSED"],
    ["Hatch", 0, "OPEN"], ["Hatch", 1, "CLOSED"],
    ["GrateWall", 0, "OPEN"], ["GrateWall", 1, null],
    ["GrateFloor", 0, "OPEN"], ["GrateFloor", 1, null],
    ["Cage", 0, null], ["Cage", 1, "OCCUPIED"],
    ["AnimalTrap", 0, null], ["AnimalTrap", 1, "OCCUPIED"],
    ["Weaponrack", 0, null], ["Weaponrack", 1, "FULL"],
    ["Armorstand", 0, null], ["Armorstand", 1, "FULL"],
  ];
  for (const [type, bst, state] of cases) {
    const material = type === "AnimalTrap" ? "WOOD" : "WOOD";
    assert.equal(key(resolve({ type, bst, mat_type: 419, mat_index: 0 })), expected(type, state, material),
      `${name}: ${type} bst=${bst} must resolve ${state || "base"}`);
  }

  for (const [bst, state] of [[0, "EMPTY"], [1, "IN_USE"], [2, "PRODUCTS"]])
    assert.equal(key(resolve({ type: "Hive", bst, mat_type: 419, mat_index: 0 })), expected("Hive", state, "WOOD"),
      `${name}: Hive bst=${bst} must resolve ${state}`);

  assert.equal(key(resolve({ type: "Door", bst: 1, mat_type: 3, mat_index: 0 })),
    expected("Door", "CLOSED", "GLASS"), `${name}: furniture material selects GLASS`);
  assert.equal(key(resolve({ type: "Chain", mat_type: 419, mat_index: 0 })),
    expected("Chain", null, "ROPE"), `${name}: plant-fiber chain selects ROPE`);

  const inorganic = (family) => mmap.inorganic.findIndex((m) => m && m.family === family);
  const wireMaterial = {
    WOOD: { mat_type: 419, mat_index: 0 },
    STONE: { mat_type: 0, mat_index: inorganic("STONE") },
    METAL: { mat_type: 0, mat_index: inorganic("METAL") },
    GLASS: { mat_type: 3, mat_index: 0 },
    GEM: { mat_type: 0, mat_index: inorganic("STONE") }, // sole GEM variant is an exact fallback
    ROPE: { mat_type: 419, mat_index: 0 },
  };
  for (const [type, family] of Object.entries(bmap.furniture)) {
    for (const material of Object.keys(family.matvariants)) {
      assert.equal(key(resolve({ type, ...wireMaterial[material] })), expected(type, null, material),
        `${name}: ${type} selects its ${material} material cell`);
    }
  }
}

console.log("PASS B270 furniture state/material lookup");
