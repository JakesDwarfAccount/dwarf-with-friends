// window12_corpse_test.mjs -- corpse/skeleton client acceptance, BOTH renderers.
//
// SERVER half (wire_v1.cpp): (a) DLL window #12 (corpsefix) ships the creature ident for
// CORPSE/CORPSEPIECE/REMAINS via item_identity_race (the derived item_corpsest/piecest/remainsst
// all inherit int16 `race`); (b) CORPSETEX-B195 adds iflags bit6 = DF's OWN fresh->skeletal
// label (Items::getDescription contains "skele"), so the client draws BODY art for a fresh
// corpse and switches to SKELETAL art only when the game itself names it a skeleton. Both are
// C++, compile-verified against the DFHack headers, NOT exercisable here.
//
// This test locks the CLIENT contract those feed (the oracle-differential half that IS offline-
// testable): a corpse-class item carrying a creature ident resolves via the identity path to the
// per-species DEAD art, and WHICH dead cell it picks now depends on it.skeletal:
//   * skeletal=true  -> the .skeleton (bone) cell, else .corpse (best available).
//   * skeletal=false -> the .corpse body cell, else the flat living cell -- NEVER the skeleton.
//   * skeletal absent (OLD server that never sends the bit) -> behaves EXACTLY like fresh, i.e.
//     pre-B195 corpse-first behaviour for body-art races -> feature-detect degrade, no regression.
//
// Test-the-test (rule 3): a TOKENLESS corpse must STILL resolve the `_corpse_fallback` box
// (source "corpse") -- the pre-ident behaviour, proving the token is what lifts a corpse off the
// box. And a body-artless CIV race (DWARF: only bone_pile exists in the map) fresh-corpse must
// NOT resolve the skeleton via the identity path -- it falls through to the fallback box, the
// honest "no fresh-body sprite exists yet" outcome (spritepick queued).
//
// Both renderers -- canvas2d (dwf-tiles.js) + GL (dwf-gl.js).
//
// Run: node tools/harness/window12_corpse_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const itemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const creaturesMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/creatures_map.json"), "utf8"));

// Fixture guards: five race shapes span the corpse-art matrix, chosen from the shipping
// creatures_map so the test tracks the real data.
const R_BOTH  = "OGRE";                     // has BOTH a .corpse AND a .skeleton cell (the B195 split)
const R_CORPSE = "AARDVARK";                // .corpse only, no .skeleton (skeletal falls back to corpse)
const R_SKELFLAT = "CAMBRIAN_TRILOBITE_MAN"; // .skeleton + flat living cell, no .corpse (fresh -> flat)
const R_FLAT  = "CAMEL_1_HUMP";             // flat living cell only, no dead art
const R_CIV   = "DWARF";                    // body-artless civ: ONLY bone_pile exists (spritepick pending)
const races = creaturesMap.races || {};
const cellSheet = (c) => c && c.sheet;
assert.ok(races[R_BOTH] && cellSheet(races[R_BOTH].corpse) && cellSheet(races[R_BOTH].skeleton),
  `[fixture guard] ${R_BOTH} must have BOTH a .corpse and a .skeleton cell`);
assert.ok(races[R_CORPSE] && races[R_CORPSE].sheet && cellSheet(races[R_CORPSE].corpse) && !cellSheet(races[R_CORPSE].skeleton),
  `[fixture guard] ${R_CORPSE} must have a .corpse cell and NO .skeleton cell`);
assert.ok(races[R_SKELFLAT] && cellSheet(races[R_SKELFLAT].skeleton) && races[R_SKELFLAT].sheet && !cellSheet(races[R_SKELFLAT].corpse),
  `[fixture guard] ${R_SKELFLAT} must have a .skeleton cell + a flat sheet and NO .corpse cell`);
assert.ok(races[R_FLAT] && races[R_FLAT].sheet && !cellSheet(races[R_FLAT].corpse) && !cellSheet(races[R_FLAT].skeleton),
  `[fixture guard] ${R_FLAT} must be a flat race with no dead art`);
assert.ok(races[R_CIV] && cellSheet(races[R_CIV].skeleton) && !cellSheet(races[R_CIV].corpse) && !races[R_CIV].sheet,
  `[fixture guard] ${R_CIV} must be a body-artless civ race: .skeleton only, no .corpse, no flat sheet`);
assert.ok(itemMap._corpse_fallback, "[fixture guard] item_map.json must carry _corpse_fallback (the generic box)");

const bothCorpse = races[R_BOTH].corpse;
const bothSkel   = races[R_BOTH].skeleton;
const corpseCell = races[R_CORPSE].corpse;
const skelfCell  = races[R_SKELFLAT].skeleton;
const skelfFlat  = { sheet: races[R_SKELFLAT].sheet, col: races[R_SKELFLAT].col, row: races[R_SKELFLAT].row };
const flatCell   = { sheet: races[R_FLAT].sheet, col: races[R_FLAT].col, row: races[R_FLAT].row };
const civSkel    = races[R_CIV].skeleton;

let failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  - " + name);
  else { failed++; console.log("  FAIL- " + name); }
}
function sameCell(a, b) {
  return !!a && !!b && a.sheet === b.sheet && a.col === b.col && a.row === b.row;
}

// ---- load canvas2d (dwf-tiles.js) with DOM-less stubs -----
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() { return new Proxy({}, { get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
}
globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; }, body: { appendChild() {} } };
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
globalThis.Image = class { set src(v) {} get src() { return ""; } };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("item_map.json") !== -1) return { ok: true, json: async () => itemMap };
  if (u.indexOf("creatures_map.json") !== -1) return { ok: true, json: async () => creaturesMap };
  return { ok: false, json: async () => null };
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const DwfTiles = globalThis.DwfTiles;
assert.ok(DwfTiles, "dwf-tiles.js did not install window.DwfTiles");
DwfTiles.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });
const c2dVisual = DwfTiles._resolveItemVisualForTest;
assert.ok(typeof c2dVisual === "function", "canvas2d _resolveItemVisualForTest hook missing");

// ---- load GL (dwf-gl.js) in a vm context ---------------------------------------------
const sandbox = {}; sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
sandbox.Date = Date;
vm.createContext(sandbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
const GL = sandbox.DwfGL;
assert.ok(GL, "dwf-gl.js did not export DwfGL");
function makeAtlas() { const ids = new Map(); let n = 1; return { resolve(s, c, r) { const k = s + "|" + c + "|" + r; if (!ids.has(k)) ids.set(k, n++); return ids.get(k); } }; }
const glb = GL.createSceneBuilder({ atlas: makeAtlas(), itemMap, creaturesMap });
const glVisual = glb._resolveItemVisualForTest;
assert.ok(typeof glVisual === "function", "GL _resolveItemVisualForTest hook missing");

// item tails as the client sees them post-decode. identKind 2 = creature. `skeletal` is the
// B195 wire bit (iflags bit6): true = DF labels it a skeleton, false = fresh corpse, UNDEFINED
// = old server that never sends the bit.
const mk = (type, ident, skeletal) => ({ type, mat_type: -1, subtype: -1, identKind: 2, ident, skeletal });

// canvas2d loads item_map.json via mocked async fetch; wait until it lands.
await (async function waitForC2dMaps() {
  const t0 = Date.now();
  while (c2dVisual(mk("CORPSE", R_CORPSE, false)) === null) {
    if (Date.now() - t0 > 2000) throw new Error("canvas2d item_map.json never loaded in the harness");
    await new Promise((r) => setTimeout(r, 2));
  }
})();

for (const [label, visual] of [["canvas2d", c2dVisual], ["GL", glVisual]]) {
  console.log("window#12 + CORPSETEX-B195 (" + label + "): corpse fresh->body, skeletal->bone:");

  // (1) B195 core split -- a race with BOTH cells picks by DF's label
  check(label + " [both/fresh] OGRE fresh CORPSE resolves the .corpse BODY cell (source ident)",
    (() => { const v = visual(mk("CORPSE", R_BOTH, false)); return v && v.source === "ident" && sameCell(v.entry, bothCorpse) && !sameCell(v.entry, bothSkel); })());
  check(label + " [both/skeletal] OGRE skeletal CORPSE resolves the .skeleton BONE cell (source ident)",
    (() => { const v = visual(mk("CORPSE", R_BOTH, true)); return v && v.source === "ident" && sameCell(v.entry, bothSkel) && !sameCell(v.entry, bothCorpse); })());

  // (2) corpse-only race: skeletal falls back to the corpse cell (no bone art exists)
  check(label + " [corpse/fresh] AARDVARK fresh -> .corpse cell",
    (() => { const v = visual(mk("CORPSE", R_CORPSE, false)); return v && v.source === "ident" && sameCell(v.entry, corpseCell); })());
  check(label + " [corpse/skeletal] AARDVARK skeletal -> .corpse cell (best available, no .skeleton art)",
    (() => { const v = visual(mk("CORPSE", R_CORPSE, true)); return v && v.source === "ident" && sameCell(v.entry, corpseCell); })());

  // (3) skeleton+flat race: FRESH must be the flat living BODY, NOT the bone pile (the B195 bug)
  check(label + " [skelflat/fresh] TRILOBITE_MAN fresh -> flat living BODY cell, NOT the skeleton",
    (() => { const v = visual(mk("CORPSE", R_SKELFLAT, false)); return v && v.source === "ident" && sameCell(v.entry, skelfFlat) && !sameCell(v.entry, skelfCell); })());
  check(label + " [skelflat/skeletal] TRILOBITE_MAN skeletal -> the .skeleton cell",
    (() => { const v = visual(mk("CORPSE", R_SKELFLAT, true)); return v && v.source === "ident" && sameCell(v.entry, skelfCell); })());

  // (4) flat race: no dead art either way -> the flat living cell
  check(label + " [flat] CAMEL fresh & skeletal both resolve the flat living cell",
    (() => { const f = visual(mk("CORPSE", R_FLAT, false)); const s = visual(mk("CORPSE", R_FLAT, true)); return f && s && sameCell(f.entry, flatCell) && sameCell(s.entry, flatCell); })());

  // (5) body-artless CIV race (the reported dwarf): skeletal -> the .skeleton cell via identity;
  //     FRESH must NOT take the identity skeleton path -- it falls to _corpse_fallback instead.
  //     HONEST GAP: _corpse_fallback is itself bone_pile today, so a fresh dwarf still LOOKS like
  //     a bone pile (there is no fresh-body sprite for civ races in the map -- spritepick queued).
  //     What this locks is the RESOLUTION PATH: the moment a fresh-body cell exists (a spritepick
  //     civ .corpse cell, or a non-bone _corpse_fallback), fresh civ corpses light up with no
  //     further logic change -- and it can never silently regress to the per-species skeleton.
  check(label + " [civ/skeletal] DWARF skeletal -> the .skeleton (bone_pile) cell via identity",
    (() => { const v = visual(mk("CORPSE", R_CIV, true)); return v && v.source === "ident" && sameCell(v.entry, civSkel); })());
  check(label + " [civ/fresh] DWARF fresh falls to _corpse_fallback (NOT the identity skeleton path)",
    (() => { const v = visual(mk("CORPSE", R_CIV, false)); return v && v.source === "corpse" && sameCell(v.entry, itemMap._corpse_fallback); })());

  // (6) OLD-SERVER DEGRADE (feature-detect): skeletal===undefined behaves EXACTLY like fresh, so
  //     a body-art race resolves its corpse cell as pre-B195 (no regression on an old server).
  check(label + " [degrade] OGRE corpse with NO skeletal field -> .corpse cell (pre-B195 behaviour)",
    (() => { const v = visual({ type: "CORPSE", mat_type: -1, subtype: -1, identKind: 2, ident: R_BOTH }); return v && v.source === "ident" && sameCell(v.entry, bothCorpse); })());

  // (7) CORPSEPIECE and REMAINS follow the same fresh/skeletal split as CORPSE
  check(label + " [corpsepiece] OGRE fresh CORPSEPIECE -> .corpse cell; skeletal -> .skeleton cell",
    (() => { const f = visual(mk("CORPSEPIECE", R_BOTH, false)); const s = visual(mk("CORPSEPIECE", R_BOTH, true)); return f && s && sameCell(f.entry, bothCorpse) && sameCell(s.entry, bothSkel); })());
  check(label + " [remains] OGRE fresh REMAINS -> .corpse cell; skeletal -> .skeleton cell",
    (() => { const f = visual(mk("REMAINS", R_BOTH, false)); const s = visual(mk("REMAINS", R_BOTH, true)); return f && s && sameCell(f.entry, bothCorpse) && sameCell(s.entry, bothSkel); })());

  // (8) test-the-test: a TOKENLESS corpse STILL falls to the generic fallback box (pre-ident
  //     behaviour). Proves the token is what lifts a corpse off the box.
  const box = visual({ type: "CORPSE", mat_type: -1, subtype: -1 });
  check(label + " [test-the-test] a TOKENLESS CORPSE falls to the _corpse_fallback box (source corpse)",
    !!box && box.source === "corpse" && sameCell(box.entry, itemMap._corpse_fallback));
  check(label + " [test-the-test] corpse-with-ident and tokenless-corpse resolve DIFFERENTLY",
    (() => { const c = visual(mk("CORPSE", R_CORPSE, false)); return c && box && c.source !== box.source && !sameCell(c.entry, box.entry); })());
}

if (failed) { console.error("\n" + failed + " check(s) FAILED"); process.exit(1); }
console.log("\nAll window#12 + CORPSETEX-B195 corpse checks passed.");
