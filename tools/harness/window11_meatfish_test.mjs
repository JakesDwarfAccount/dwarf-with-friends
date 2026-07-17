// window11_meatfish_test.mjs -- DLL WINDOW #11 (meatfix) client-side acceptance, BOTH renderers.
//
// Locks the two client-consumable halves of window #11 against regression:
//   (1) MEAT -> TX13's raws-derived BODYPART_MEAT cell via the creature-local material slot,
//       not the living creature or missing box. (This supersedes the synthetic window-11 slab.)
//   (2) FISH (prepared) resolves the SAME per-species creature cell as FISH_RAW of that species.
//       The SERVER half (wire_v1.cpp window #11: item_fishst.race cast) now ships prepared FISH a
//       creature ident; the CLIENT half is that FISH stays in ITEM_CREATURE_TYPES so it consumes
//       that token exactly like FISH_RAW already does. This test locks the client contract offline
//       (the server cast itself is C++, compile-verified, not exercisable here).
//
// Both renderers -- canvas2d (dwf-tiles.js) + GL (dwf-gl.js) -- plus test-the-test
// (rule 3): the assertions FAIL if MEAT is treated as a creature/box, or if FISH stops resolving.
//
// Run: node tools/harness/window11_meatfish_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const itemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));
const creaturesMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/creatures_map.json"), "utf8"));

// Fixture guard: a flat (non-layered) race with a real sheet, used as the "species" for the
// FISH/FISH_RAW parity check (the resolver mechanism is species-agnostic -- it looks up
// races[ident] -- so a guaranteed-flat race is the robust fixture, same convention as the
// existing WC-3/WC-6 item tests).
const SPECIES = "AARDVARK";
const flat = creaturesMap.races && creaturesMap.races[SPECIES];
assert.ok(flat && flat.sheet, `[fixture guard] creatures_map.json ${SPECIES} is no longer a flat race with a sheet`);

let failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  - " + name);
  else { failed++; console.log("  FAIL- " + name); }
}
function sameCell(a, b) {
  return !!a && !!b && a.sheet === b.sheet && a.col === b.col && a.row === b.row;
}

// ---- load canvas2d (dwf-tiles.js) with DOM-less stubs --------------------------------
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
const meatIt = { type: "MEAT", mat_type: 21, subtype: -1, identKind: 2, ident: SPECIES };
const catTallowIt = { type: "GLOB", mat_type: 25, subtype: -1, identKind: 2, ident: "CAT" };
const fishIt = { type: "FISH", mat_type: -1, subtype: -1, identKind: 2, ident: SPECIES };
const fishRawIt = { type: "FISH_RAW", mat_type: -1, subtype: -1, identKind: 2, ident: SPECIES };
const fishNoIdent = { type: "FISH", mat_type: -1, subtype: -1 };   // no creature token -> no creature cell

// canvas2d loads item_map.json via the mocked async fetch; wait until it lands (the resolver
// returns null while itemMap is still null). GL's map was injected synchronously via createSceneBuilder.
await (async function waitForC2dMaps() {
  const t0 = Date.now();
  while (c2dVisual(meatIt) === null) {
    if (Date.now() - t0 > 2000) throw new Error("canvas2d item_map.json never loaded in the harness");
    await new Promise((r) => setTimeout(r, 2));
  }
})();

for (const [label, visual] of [["canvas2d", c2dVisual], ["GL", glVisual]]) {
  console.log("window#11/TX13 (" + label + "): MEAT -> bodypart; FISH(prepared) -> per-species cell == FISH_RAW:");
  const meat = visual(meatIt);
  const fish = visual(fishIt);
  const fishRaw = visual(fishRawIt);
  const fishNil = visual(fishNoIdent);
  const catTallow = visual(catTallowIt);

  // (1) MEAT -> raw bodypart cell
  const meatCell = itemMap.creature_food.cells["MEAT:STANDARD"];
  check(label + " [meat] MEAT resolves to the raws-derived BODYPART_MEAT cell",
    !!meat && meat.source === "creaturefood" && sameCell(meat.entry, meatCell));
  check(label + " [test-the-test][meat] MEAT does NOT resolve to the creature cell (regresses if MEAT re-added to ITEM_CREATURE_TYPES)",
    !!meat && !!meat.entry && !sameCell(meat.entry, flat));
  check(label + " [test-the-test][meat] MEAT does NOT fall to the _missing box",
    !!meat && meat.source !== "missing");

  check(label + " TX5 CAT TALLOW blue-box regression: GLOB reaches item_map.bytype.GLOB end-to-end",
    !!catTallow && catTallow.source === "bytype" && sameCell(catTallow.entry, itemMap.bytype.GLOB));

  // (2) FISH(prepared) == FISH_RAW per-species cell (client consumes item_fishst.race token)
  check(label + " [fish] prepared FISH resolves via the creature-identity path (source ident)",
    !!fish && fish.source === "ident" && !!fish.entry && sameCell(fish.entry, flat));
  check(label + " [fish] prepared FISH and FISH_RAW resolve the SAME per-species cell",
    !!fish && !!fishRaw && sameCell(fish.entry, fishRaw.entry));
  check(label + " [test-the-test][fish] MEAT and FISH resolve DIFFERENTLY (bodypart vs creature)",
    !!meat && !!fish && meat.source !== fish.source && !sameCell(meat.entry, fish.entry));
  check(label + " [test-the-test][fish] a tokenless FISH does NOT resolve the creature cell (proves the token, not the type, drives it)",
    !fishNil || !sameCell(fishNil.entry, flat));
}

const badItemMap = JSON.parse(JSON.stringify(itemMap));
delete badItemMap.bytype.GLOB;
const badTallow = GL.createSceneBuilder({ atlas: makeAtlas(), itemMap: badItemMap, creaturesMap })
  ._resolveItemVisualForTest(catTallowIt);
check("[test-the-test] without bytype.GLOB, CAT TALLOW no longer resolves the real cell",
  !(badTallow && badTallow.source === "bytype" && sameCell(badTallow.entry, itemMap.bytype.GLOB)));

if (failed) { console.error("\n" + failed + " check(s) FAILED"); process.exit(1); }
console.log("\nAll window#11 meat/fish checks passed.");
