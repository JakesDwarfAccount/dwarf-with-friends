// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// TX13: creature-material MEAT/GLOB items resolve through the vanilla body-part art selected
// by df::material.meat_organ. Oracle cells come from vanilla_creatures_graphics/graphics/
// graphics_bodyparts.txt; WILD_BOAR mat_type values are pinned by the read-only live oracle.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const itemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const materialMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/material_map.json"), "utf8"));
const creaturesMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/creatures_map.json"), "utf8"));

const CASES = [
  ["fat", "GLOB", 20, 0],
  ["meat", "MEAT", 21, 16],
  ["eye", "MEAT", 26, 1],
  ["brain", "MEAT", 28, 13],
  ["lung", "MEAT", 29, 3],
  ["heart", "MEAT", 30, 4],
  ["liver", "MEAT", 31, 6],
  ["intestines", "MEAT", 32, 5],
  ["stomach/tripe", "MEAT", 33, 7],
  ["gizzard", "MEAT", 34, 28],
  ["pancreas/sweetbread", "MEAT", 35, 8],
  ["spleen", "MEAT", 36, 9],
  ["kidney", "MEAT", 37, 10],
];
const expectedCell = (row) => ({ sheet: "bodyparts.png", col: 0, row });
const sameCell = (a, b) => !!a && !!b && a.sheet === b.sheet && a.col === b.col && a.row === b.row;
const item = (type, mat_type) => ({
  type, mat_type, mat_index: 638, subtype: -1, identKind: 2, ident: "WILD_BOAR",
});

assert.equal(itemMap.creature_food.queued_for_pick.length, 0,
  "all 13 vanilla creature-food categories have authored cells; none should be queued");
assert.equal(Object.keys(itemMap.creature_food.cells).length, 13,
  "fixture guard: expected all 13 authored FAT/MEAT-category cells");
const boarProfile = itemMap.creature_food.by_creature.WILD_BOAR;
assert.ok(boarProfile && itemMap.creature_food.profiles[boarProfile],
  "WILD_BOAR must select a generated creature-food profile");
assert.deepEqual(itemMap.creature_food.profiles[boarProfile], {
  20: "GLOB:FAT", 21: "MEAT:STANDARD", 26: "MEAT:EYE", 28: "MEAT:BRAIN",
  29: "MEAT:LUNG", 30: "MEAT:HEART", 31: "MEAT:LIVER", 32: "MEAT:INTESTINES",
  33: "MEAT:STOMACH", 34: "MEAT:GIZZARD", 35: "MEAT:PANCREAS",
  36: "MEAT:SPLEEN", 37: "MEAT:KIDNEY",
}, "raw-derived WILD_BOAR local-material layout");

function loadGL(map) {
  const sandbox = { self: null, performance: { now: () => 0 } };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, { filename: file });
  const atlas = { resolve: () => 1 };
  return sandbox.DwfGL.createSceneBuilder({
    atlas, itemMap: map, materialMap, creaturesMap,
  })._resolveItemVisualForTest;
}

class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {}
  removeEventListener() {}
  getContext() {
    return new Proxy({}, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === "measureText") return () => ({ width: 8 });
        return () => {};
      },
      set(target, prop, value) { target[prop] = value; return true; },
    });
  }
}

async function loadCanvas(map) {
  const sandbox = {
    console, setTimeout, clearTimeout, Uint8ClampedArray, URLSearchParams,
    location: { search: "", protocol: "http:", host: "localhost:8765" },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    Image: class { set src(_value) {} },
    fetch: async (url) => {
      const value = String(url);
      if (value.includes("item_map.json")) return { ok: true, json: async () => map };
      if (value.includes("material_map.json")) return { ok: true, json: async () => materialMap };
      if (value.includes("creatures_map.json")) return { ok: true, json: async () => creaturesMap };
      return { ok: false, json: async () => null };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.document = {
    hidden: false, addEventListener() {}, getElementById() { return null; },
    createElement() { return new FakeCanvas(); }, body: { appendChild() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"),
    sandbox, { filename: "dwf-tiles.js" });
  const tiles = sandbox.DwfTiles;
  tiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });
  const resolve = tiles._resolveItemVisualForTest;
  const started = Date.now();
  while (!resolve(item("MEAT", 21))) {
    if (Date.now() - started > 2000) throw new Error("canvas2d maps did not load");
    await new Promise((done) => setTimeout(done, 2));
  }
  return resolve;
}

const glResolve = loadGL(itemMap);
const canvasResolve = await loadCanvas(itemMap);
for (const [name, type, matType, row] of CASES) {
  const expected = expectedCell(row);
  for (const [renderer, resolve] of [["GL", glResolve], ["canvas2d", canvasResolve]]) {
    const visual = resolve(item(type, matType));
    assert.equal(visual && visual.source, "creaturefood", `${renderer} ${name} uses creature-food classifier`);
    assert.ok(sameCell(visual && visual.entry, expected),
      `${renderer} ${name} must resolve bodyparts.png:0,${row}, got ${JSON.stringify(visual)}`);
  }
}

// Genuine unmapped layouts keep the current raws-authored generic fallback and never invent a cell.
for (const resolve of [glResolve, canvasResolve]) {
  const unknown = resolve({ type: "MEAT", mat_type: 218, mat_index: -1, subtype: -1,
    identKind: 2, ident: "GENERATED_UNKNOWN_TX13" });
  assert.equal(unknown && unknown.source, "bytype");
  assert.ok(sameCell(unknown && unknown.entry, itemMap.bytype.MEAT));
}

// Seed the reported regression explicitly: every food category resolves to ITEM_TOOL_JUG.
// The same oracle above must reject every seeded result in both renderers.
const jug = itemMap.bytoken.ITEM_TOOL_JUG;
assert.ok(jug && jug.sheet === "containers.png", "fixture guard: ITEM_TOOL_JUG is the jug-family cell");
const badMap = structuredClone(itemMap);
for (const key of Object.keys(badMap.creature_food.cells)) badMap.creature_food.cells[key] = jug;
for (const [renderer, resolve] of [["GL", loadGL(badMap)], ["canvas2d", await loadCanvas(badMap)]]) {
  let rejected = 0;
  for (const [, type, matType, row] of CASES) {
    const visual = resolve(item(type, matType));
    if (!sameCell(visual && visual.entry, expectedCell(row))) rejected++;
  }
  assert.equal(rejected, CASES.length,
    `${renderer} seeded jug-family map must fail all ${CASES.length} raw-cell assertions`);
}

console.log(`PASS TX13: ${CASES.length} raw-derived food cells x 2 renderers; seeded jug family rejected`);
