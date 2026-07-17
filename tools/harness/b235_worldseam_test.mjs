// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// b235_worldseam_test.mjs -- B235 ("faint border around the edge of the unloaded chunk").
//
// WT25 made in-bounds undiscovered (tt<0) tiles paint DF's unmined-rock hatch instead of black
// void. That left a faint 1-tile border tracing the boundary between the region with real block
// data and the procedurally-hatched undiscovered area.
//
// ROOT CAUSE (measured from the screenshot, tools/orchestrator/attachments/B235-1.png): the two
// sides of the seam paint the SAME hatch over the SAME [6,6,8] backdrop -- sampled means (50.1,
// 45.1,52.9) vs (50.4,45.2,52.9), modal colour (49,44,52) on both sides. The border is not a
// colour mismatch and not a fractional-zoom rounding hairline: it is an extra DECAL drawn on one
// side. drawTileComposite's overlay-stack gate was `drew && !t.hidden`. WT25's tt<0 tiles are
// hatched but carry NO `hidden` flag (the server never shipped them), so they pass that gate --
// and pre-WT25 they were harmless only because they painted nothing at all (`drew` stayed false).
// Once WT25 made them paint, the whole overlay stack ran on undiscovered rock, and
// drawShadowDecals' `visionShadow` decal (keyed on the 8-neighbour mask of `hidden` tiles) fired
// on exactly the ring of tt<0 tiles bordering the last KNOWN block -- whose rock IS shipped-hidden.
// That ring is the seam.
//
// The fix is one predicate, `overlaysAllowed(t)` = tt>=0 && !hidden ("this tile has DISCOVERED
// content"), mirrored in both renderers. These checks pin it. Pure/seam-driven: no canvas, no GL
// context, no transport, no server.
// Run: node tools/harness/b235_worldseam_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const glSource = fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8");
const tilesSource = fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8");

// ---- boot both renderers (mirrors renderer_wave_test) ----------------------------------------
const glbox = { self: null, performance: { now: () => 0 } }; glbox.self = glbox;
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
const GL = glbox.DwfGL;
assert.ok(GL, "GL export loads");

class FakeCanvas {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.Image = class { constructor() { this.onload = null; this.onerror = null; } set src(_) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => null });
vm.runInThisContext(tilesSource, { filename: "web/js/dwf-tiles.js" });
const Tiles = globalThis.DwfTiles.init({ canvas: new FakeCanvas(), managePoll: false, manageCamera: false });

let failed = 0;
function check(name, fn) { try { fn(); console.log("PASS " + name); } catch (e) { failed++; console.error("FAIL " + name + ": " + (e.stack || e)); } }
function makeAtlas() {
  const ids = new Map(); let next = 1;
  return {
    resolve(sheet, col, row) { const key = sheet + "|" + col + "|" + row; if (!ids.has(key)) ids.set(key, next++); return ids.get(key); },
    resolvePalette(sheet, col, row) { return this.resolve(sheet, col, row); },
  };
}
function decode(b) {
  const u = new Uint16Array(b.buffer), out = [];
  for (let i = 0; i < b.count; i++) out.push({ cell: u[i * 8 + 4] });
  return out;
}

// ---- the two tile classes that MEET at the seam ----------------------------------------------
const DIMS = { w: 16, h: 16, z: 8 };
// INSIDE the loaded region: rock the server shipped, flagged hidden (undug -> hatch).
const shippedHidden = { x: 5, y: 5, tt: 2, ttname: "StoneWall", shape: "WALL", mat: "STONE", hidden: 1 };
// OUTSIDE it: a tile in a block the server never sent at all. In-bounds -> WT25 hatch. NOT hidden.
const undiscovered = { x: 5, y: 4, tt: -1 };
// Real discovered terrain -- the fort floor. MUST keep its overlays (incl. fog-of-war shadow).
const discovered = { x: 5, y: 6, tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: 0 };
// Genuinely off-map (outside the 16x16 footprint): black void, hatch-less, overlay-less.
const offMap = { x: 40, y: 5, tt: -1 };

// ---- 1. the invariant the owner actually cares about: the seam is invisible --------------------------
// The boundary is invisible iff the tile just inside it and the tile just outside it run the SAME
// draw program. Both are hatched; neither may take an overlay. If either half of that pair breaks,
// a border appears.
check("B235 canvas2d: the two tiles that meet at the seam paint identically (hatch, no overlay)", () => {
  for (const [name, t] of [["shipped-hidden (inside)", shippedHidden], ["undiscovered tt<0 (outside)", undiscovered]]) {
    assert.equal(Tiles._wantsHiddenHatchForTest(t, DIMS), true, name + " -> hatch");
    assert.equal(Tiles._overlaysAllowedForTest(t), false, name + " -> NO overlay stack");
  }
});

check("B235 canvas2d: discovered terrain still gets its overlay stack (fort fog-of-war shadow kept)", () => {
  assert.equal(Tiles._overlaysAllowedForTest(discovered), true);
  assert.equal(Tiles._wantsHiddenHatchForTest(discovered, DIMS), false);
});

check("B235 canvas2d: an off-map tt<0 tile takes no overlays either (it paints nothing at all)", () => {
  assert.equal(Tiles._overlaysAllowedForTest(offMap), false);
});

// ---- 2. test-the-test: the OLD gate would have failed check 1 ---------------------------------
// If this fixture cannot distinguish the fixed gate from the buggy one, it pins nothing. The bug
// was a bare `!t.hidden`. Show that predicate DISAGREES with overlaysAllowed on exactly the seam
// tile -- i.e. the old gate would have let the undiscovered ring draw the visionShadow decal.
check("B235 test-the-test: the pre-fix gate (!t.hidden) WOULD have allowed overlays on the seam tile", () => {
  const oldGate = (t) => !t.hidden;
  assert.equal(oldGate(undiscovered), true, "pre-fix gate lets the tt<0 seam tile through (the bug)");
  assert.equal(Tiles._overlaysAllowedForTest(undiscovered), false, "fixed gate stops it");
  // ...and the two gates must still AGREE everywhere else, or the fix over-reached.
  for (const t of [shippedHidden, discovered]) {
    assert.equal(oldGate(t), Tiles._overlaysAllowedForTest(t),
      "fix must only change the undiscovered-hatch case, not (" + t.x + "," + t.y + ")");
  }
});

// ---- 3. renderer parity: GL must agree tile-for-tile ------------------------------------------
check("B235 parity: GL overlaysAllowed agrees with canvas2d on every seam-relevant tile class", () => {
  const glb = GL.createSceneBuilder({ atlas: makeAtlas(), spriteMap: {}, tokenMap: {}, shadowCellMap: {},
    adjacency: glbox.DwfAdjacency, mapDims: DIMS });
  for (const t of [shippedHidden, undiscovered, discovered, offMap, { x: 0, y: 0, tt: -1 }, { x: 15, y: 15, tt: -1 }]) {
    assert.equal(glb._overlaysAllowedForTest(t), Tiles._overlaysAllowedForTest(t),
      `overlay-gate parity at (${t.x},${t.y}) tt=${t.tt}`);
    assert.equal(glb._wantsHiddenHatchForTest(t, DIMS), Tiles._wantsHiddenHatchForTest(t, DIMS),
      `hatch parity at (${t.x},${t.y}) tt=${t.tt}`);
  }
});

// ---- 4. GL integration: the decal is not merely gated, it is never EMITTED --------------------
// Build a real 6x6 scene shaped like the seam: rows y=0..2 are the never-shipped undiscovered
// region, rows y=3..5 are the loaded region's shipped-hidden rock. The boundary runs between y=2
// and y=3, so every tt<0 tile on row 2 has hidden 8-neighbours -- the exact geometry that painted
// the border. Map every possible nonzero mask to one token so ANY visionShadow emission is caught
// regardless of the adjacency bit order.
const VISION_TOKEN = "VISION_SHADOW_ANY";
const shadowCellMap = { visionShadow: {}, wallShadow: {}, rampShadowOnRamp: {} };
for (let m = 1; m <= 255; m++) shadowCellMap.visionShadow[String(m)] = VISION_TOKEN;
const spriteMap = {
  VISION_SHADOW_ANY: { sheet: "shadows.png", col: 0, row: 0 },
  HIDDEN_ROCK_1: { sheet: "hidden_rock.png", col: 0, row: 0 }, HIDDEN_ROCK_2: { sheet: "hidden_rock.png", col: 1, row: 0 },
  HIDDEN_ROCK_3: { sheet: "hidden_rock.png", col: 2, row: 0 }, HIDDEN_ROCK_4: { sheet: "hidden_rock.png", col: 3, row: 0 },
  HIDDEN_ROCK_5: { sheet: "hidden_rock.png", col: 4, row: 0 },
};

function buildSeamScene(outerRowFactory) {
  const atlas = makeAtlas();
  const visionCell = atlas.resolve("shadows.png", 0, 0);
  const glb = GL.createSceneBuilder({ atlas, spriteMap, tokenMap: {}, shadowCellMap,
    adjacency: glbox.DwfAdjacency, mapDims: DIMS });
  const W = 6, H = 6, tiles = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      tiles.push(y < 3 ? outerRowFactory(x, y)
        : { x, y, tt: 2, ttname: "StoneWall", shape: "WALL", mat: "STONE", hidden: 1 });
    }
  }
  glb.buildScene({ origin: { x: 0, y: 0, z: 4 }, width: W, height: H, tiles });
  const emitted = decode(glb);
  return { visionCount: emitted.filter((i) => i.cell === visionCell).length, total: emitted.length };
}

check("B235 GL integration: NO visionShadow decal is emitted on the undiscovered side of the seam", () => {
  const r = buildSeamScene((x, y) => ({ x, y, tt: -1 }));   // never-shipped block -> WT25 hatch
  assert.ok(r.total > 0, "scene actually built instances (guard against a vacuous pass)");
  assert.equal(r.visionCount, 0, "the loaded/unloaded boundary must draw no fog-of-war decal");
});

// Vacuity guard -- WITHOUT this, the check above would pass even if the fixture were incapable of
// ever emitting a visionShadow cell (wrong token, wrong mask, shadowCellMap ignored...). Swap the
// outer rows for DISCOVERED floor: those tiles legitimately border hidden rock, so DF's fog-of-war
// decal MUST fire. This proves the wiring is live AND that the fix did not kill the real shadow.
check("B235 test-the-test: DISCOVERED tiles bordering hidden rock DO still emit visionShadow", () => {
  const r = buildSeamScene((x, y) => ({ x, y, tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE", hidden: 0 }));
  assert.ok(r.visionCount > 0,
    "fixture must be able to emit a visionShadow decal at all -- otherwise the check above is vacuous");
});

// ---- 5. source guard: neither renderer may regress to the bare `!t.hidden` overlay gate --------
check("B235 source guard: both overlay-stack gates go through overlaysAllowed, not `!t.hidden`", () => {
  assert.match(tilesSource, /if \(drew && overlaysAllowed\(t\)\) \{/,
    "canvas2d overlay stack must be gated on overlaysAllowed");
  assert.match(glSource, /if \(drew && overlaysAllowedGL\(t\)\) \{/,
    "GL overlay stack must be gated on overlaysAllowedGL");
  assert.doesNotMatch(tilesSource, /if \(drew && !t\.hidden\) \{/, "canvas2d must not use the pre-B235 gate");
  assert.doesNotMatch(glSource, /if \(drew && !t\.hidden\) \{/, "GL must not use the pre-B235 gate");
});

if (failed) { console.error("\n" + failed + " B235 check(s) FAILED"); process.exit(1); }
console.log("\nALL B235 world-seam checks PASSED");
