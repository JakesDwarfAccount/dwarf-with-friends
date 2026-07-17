// wc17_wc18_test.mjs -- acceptance deliverable for docs/superpowers/specs/
// 2026-07-07-WC-coverage-spec.md Chunk G (WC-17 grass coverage) and Chunk H's WC-18
// (engravings). Loads the REAL web/js/dwf-tiles.js module (verbatim, via
// vm.runInThisContext) in a minimally-mocked DOM-less environment, same convention as
// wc4_building_test.mjs/wc14_tree_test.mjs, and exercises its debug-only test hooks:
//   - _grassTierIndexForTest(amount)                  -- amount -> tier 0..3
//   - _grassSpeciesTintForTest(id, amount)             -- (id,amount) -> real
//     grass_colors.json rgba() string, or null
//   - _engravingWallTokenForTest(mask)                 -- combined eflags mask ->
//     ENGRAVED_STONE_WALL_* token, or null
//   - _resolveSpriteForTest(t, gx, gy)                 -- amount<=0 "worn bare" gate
//
// Also independently re-derives the wire's GRASS/ENGRAVING tail byte layout from
// tools/harness/fixtures/wire_fixture.bin (the same golden fixture wire_decode_test.mjs
// already validates byte-for-byte) to prove the client decoder's shape end to end.
//
// Run: node tools/harness/wc17_wc18_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_PATH = path.resolve(__dirname, "../../web/js/dwf-tiles.js");
const DECODER_PATH = path.resolve(__dirname, "../../web/js/dwf-wire-v1.js");
const GRASS_COLORS_PATH = path.resolve(__dirname, "../../web/grass_colors.json");
const FIX_BIN = path.resolve(__dirname, "fixtures/wire_fixture.bin");

const realGrassColors = JSON.parse(fs.readFileSync(GRASS_COLORS_PATH, "utf8"));
assert.ok(realGrassColors.plants && realGrassColors.plants["MEADOW-GRASS"],
  "fixture assumption broken: grass_colors.json no longer has MEADOW-GRASS");

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// ---- Part 1: independent wire re-decode (proves GRASS/ENGRAVING byte layout) ---------
vm.runInThisContext(fs.readFileSync(DECODER_PATH, "utf8"), { filename: DECODER_PATH });
const W = globalThis.DwfWireV1;
assert.ok(W && typeof W.decodeBlockSet === "function", "wire decoder did not attach");
const bin = new Uint8Array(fs.readFileSync(FIX_BIN));
const hdr = W.decodeHeader(bin);
assert.ok(hdr, "fixture header decode failed");
const decoded = W.decodeBlockSet(bin.subarray(hdr.payloadOffset));
const A = decoded.blocks[0];

const grassAt12 = A.tails.find((t) => t.tile_idx === 12 && t.kind === W.C.TAIL_GRASS);
check("A[12] GRASS tail decodes id=MEADOW-GRASS", !!grassAt12 && grassAt12.data.id === "MEADOW-GRASS");
check("A[12] GRASS tail decodes amount=45", !!grassAt12 && grassAt12.data.amount === 45);

const engravingsAt13 = A.tails.filter((t) => t.tile_idx === 13 && t.kind === W.C.TAIL_ENGRAVING);
check("A[13] has 2 ENGRAVING tails", engravingsAt13.length === 2);
check("A[13][0] north (eflags=0x0008) quality=3",
  engravingsAt13[0] && engravingsAt13[0].data.eflags === 0x0008 && engravingsAt13[0].data.quality === 3);
check("A[13][1] south (eflags=0x0010) quality=5",
  engravingsAt13[1] && engravingsAt13[1].data.eflags === 0x0010 && engravingsAt13[1].data.quality === 5);

// ---- Part 2: client apply logic (dwf-tiles.js pure hooks) ----------------------
class FakeImage {
  constructor() { this.onload = null; this.onerror = null; this._src = ""; this.width = 32; this.height = 32; }
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
        return (..._args) => {};
      },
      set(t, prop, v) { t[prop] = v; return true; },
    });
  }
}
const storageBacking = {};
const fakeStorage = {
  getItem: (k) => (k in storageBacking ? storageBacking[k] : null),
  setItem: (k, v) => { storageBacking[k] = String(v); },
};

globalThis.window = globalThis;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = {
  hidden: false,
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return { style: {} }; },
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
globalThis.sessionStorage = fakeStorage;
globalThis.Image = FakeImage;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("grass_colors.json") !== -1) return { ok: true, json: async () => realGrassColors };
  return { ok: false, json: async () => null };
};

const src = fs.readFileSync(TILES_PATH, "utf8");
vm.runInThisContext(src, { filename: TILES_PATH });
const DwfTiles = globalThis.DwfTiles;
assert.ok(DwfTiles, "dwf-tiles.js did not install window.DwfTiles");
for (const hook of ["_grassTierIndexForTest", "_grassSpeciesTintForTest",
                     "_engravingWallTokenForTest", "_resolveSpriteForTest"]) {
  assert.ok(typeof DwfTiles[hook] === "function", `missing ${hook} hook`);
}

const canvasEl = new FakeCanvasEl();
const initResult = DwfTiles.init({ canvas: canvasEl, managePoll: false, manageCamera: false });
assert.ok(initResult, "init() returned null (canvas/context stub rejected)");

async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > (maxMs || 1000)) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

(async function main() {
  console.log("WC-17: grass coverage tier + species tint");

  // grass_colors.json is fetched ASYNCHRONOUSLY by loadGrassColors() inside init() --
  // wait for it to actually land before asserting any tint value (a synchronous check
  // right after init() would race the fetch and false-fail).
  await waitUntil(() => DwfTiles._grassSpeciesTintForTest("MEADOW-GRASS", 10) !== null, 2000);

  // ---- amount -> tier index (0-based; 4 tiers) --------------------------------------
  check("amount=0 -> tier 0 (bare/thinnest bucket, caller gates on <=0 separately)",
    DwfTiles._grassTierIndexForTest(0) === 0);
  check("amount=1 -> tier 0", DwfTiles._grassTierIndexForTest(1) === 0);
  check("amount=33 -> tier 0", DwfTiles._grassTierIndexForTest(33) === 0);
  check("amount=34 -> tier 1", DwfTiles._grassTierIndexForTest(34) === 1);
  check("amount=66 -> tier 1", DwfTiles._grassTierIndexForTest(66) === 1);
  check("amount=67 -> tier 2", DwfTiles._grassTierIndexForTest(67) === 2);
  check("amount=99 -> tier 2", DwfTiles._grassTierIndexForTest(99) === 2);
  check("amount=100 -> tier 3", DwfTiles._grassTierIndexForTest(100) === 3);
  check("amount=255 -> tier 3", DwfTiles._grassTierIndexForTest(255) === 3);

  // ---- species tint against the REAL committed grass_colors.json --------------------
  const expectTier0 = realGrassColors.plants["MEADOW-GRASS"].tiers[0].rgb;
  const gotTint0 = DwfTiles._grassSpeciesTintForTest("MEADOW-GRASS", 10); // tier 0
  check(`MEADOW-GRASS amount=10 (tier0) resolves the REAL tier0 rgb ${JSON.stringify(expectTier0)}`,
    gotTint0 === `rgba(${expectTier0[0]},${expectTier0[1]},${expectTier0[2]},0.25)`);
  const expectTier3 = realGrassColors.plants["MEADOW-GRASS"].tiers[3].rgb;
  const gotTint3 = DwfTiles._grassSpeciesTintForTest("MEADOW-GRASS", 150); // tier 3
  check(`MEADOW-GRASS amount=150 (tier3) resolves the REAL tier3 rgb ${JSON.stringify(expectTier3)}`,
    gotTint3 === `rgba(${expectTier3[0]},${expectTier3[1]},${expectTier3[2]},0.25)`);
  check("an unmapped species id falls back to null (caller then uses the flat summer wash)",
    DwfTiles._grassSpeciesTintForTest("NOT_A_REAL_SPECIES_TOKEN", 50) === null);
  check("a missing/empty id falls back to null",
    DwfTiles._grassSpeciesTintForTest("", 50) === null);

  // ---- resolveSprite: amount<=0 is "worn bare" -> falls through to the flat floor color --
  check("t.grass.amount=0 -> resolveSprite returns null (bare floor, not a grass cell)",
    DwfTiles._resolveSpriteForTest({ ttname: "GrassLightFloor1", grass: { id: "MEADOW-GRASS", amount: 0 } }) === null);
  check("t.hidden tiles stay null regardless of grass data (undiscovered-tile guard unchanged)",
    DwfTiles._resolveSpriteForTest({ hidden: true, ttname: "GrassLightFloor1", grass: { id: "MEADOW-GRASS", amount: 80 } }) === null);

  // ---- grass-escalation contract (2026-07-07, the "multicolor patchwork"): a tile with
  // amount>0 coverage must render EXACTLY like the same tile with no tail at all (the
  // ttname->token GRASS_1..4 + calibrated grassSummer path) -- the per-species/per-tier
  // tint was verified inverted vs DF's graze-state raw order AND absent from DF premium
  // rendering entirely (native oracle evidence in the ledger entry); it must never leak
  // into the live resolveSprite result until oracle-calibrated.
  check("t.grass.amount>0 -> resolveSprite output identical to a no-tail tile (species/tier tint never applied)",
    JSON.stringify(DwfTiles._resolveSpriteForTest({ ttname: "GrassLightFloor1", grass: { id: "MEADOW-GRASS", amount: 100 } })) ===
    JSON.stringify(DwfTiles._resolveSpriteForTest({ ttname: "GrassLightFloor1" })));
  check("species identity does not change rendering (SATINTAIL == MEADOW-GRASS at any amount>0)",
    JSON.stringify(DwfTiles._resolveSpriteForTest({ ttname: "GrassLightFloor1", grass: { id: "SATINTAIL", amount: 45 } })) ===
    JSON.stringify(DwfTiles._resolveSpriteForTest({ ttname: "GrassLightFloor1", grass: { id: "MEADOW-GRASS", amount: 251 } })));

  // ---- grass-under compositing (grass-escalation stage 2, the "phantom stone"): a
  // whitelisted non-grass-material floor carrying a positive-amount tail renders the
  // grass base + grassSummer wash (pebble variants additionally overlay their SPARSE
  // cell -- overlay resolution needs map.json, absent in this stub env, so only the
  // base+tint contract is asserted here; the GL suite covers the overlay ordering).
  {
    // FakeImage never fires onload on its own -- mark grass.png loaded through the same
    // getSheet cache the render path uses (the retry-probe block below does the inverse).
    const gs = DwfTiles._getSheetForTest("grass.png");
    if (!gs.loaded) gs.img.onload();
    const peb = DwfTiles._resolveSpriteForTest(
      { ttname: "StonePebbles2", mat: "STONE", grass: { id: "SATINTAIL", amount: 100 } }, 0, 0);
    check("StonePebbles2 + grass tail -> grass base cell (not the dense gravel path)",
      !!peb && peb.row === 0 && peb.col >= 0 && peb.col <= 3);
    check("StonePebbles2 + grass tail -> calibrated grassSummer wash key", !!peb && peb.tint === "grassSummer");
    const soil = DwfTiles._resolveSpriteForTest(
      { ttname: "SoilFloor3", mat: "SOIL", grass: { id: "GRAMA", amount: 50 } }, 5, 7);
    check("SoilFloor3 + grass tail -> plain grass base (native shows full grass)",
      !!soil && soil.tint === "grassSummer" && !soil.overlay);
    check("non-whitelisted ttname + grass tail -> unchanged normal resolution (never grass-replaced)",
      JSON.stringify(DwfTiles._resolveSpriteForTest({ ttname: "StoneFloor5", mat: "STONE", grass: { id: "GRAMA", amount: 50 } }, 0, 0)) ===
      JSON.stringify(DwfTiles._resolveSpriteForTest({ ttname: "StoneFloor5", mat: "STONE" }, 0, 0)));
  }

  // ---- sheet-load retry (2026-07-07 fix, the "blocky flat-color grass"): a single
  // transient <img> load failure (e.g. one dropped request over a flaky tunnel) used to
  // stick getSheet()'s cache entry at failed:true FOREVER -- resolveSprite() then always
  // fell through to the flat material-colour fill (tileColor()'s plain GRASS_LIGHT/etc.
  // rgb, no texture, no wash) for the rest of the session, fixable only by a full page
  // reload. Drive a FRESH sheet name (not "grass.png", already loaded by the boot sequence
  // above) through one failure, confirm it stays failed within the backoff window, then
  // confirm it retries and recovers past it -- no reload needed.
  console.log("\nsheet-load transient-failure retry (no page reload needed)");
  {
    const before = DwfTiles._getSheetForTest("retry_probe.png");
    before.img.onerror();
    check("sheet marked failed right after the (simulated) load error",
      DwfTiles._getSheetForTest("retry_probe.png").failed === true);
    check("re-requesting immediately (well within the backoff window) returns the SAME failed entry",
      DwfTiles._getSheetForTest("retry_probe.png") === before);
    await new Promise((r) => setTimeout(r, 2100)); // > SHEET_RETRY_DELAY_MS (2000ms)
    const after = DwfTiles._getSheetForTest("retry_probe.png");
    check("past the backoff window, getSheet() issues a FRESH attempt (new entry, not stuck failed)",
      after !== before && after.failed === false && after.loaded === false);
  }

  console.log("\nWC-18: engraving combined-mask -> ENGRAVED_STONE_WALL_* token");
  const ENG_N = 0x0008, ENG_S = 0x0010, ENG_W = 0x0002, ENG_E = 0x0004;
  const ENG_NW = 0x0040, ENG_NE = 0x0080, ENG_SW = 0x0100, ENG_SE = 0x0200;
  check("north only -> ENGRAVED_STONE_WALL_N",
    DwfTiles._engravingWallTokenForTest(ENG_N) === "ENGRAVED_STONE_WALL_N");
  check("north|south (2 records OR-combined) -> ENGRAVED_STONE_WALL_N_S",
    DwfTiles._engravingWallTokenForTest(ENG_N | ENG_S) === "ENGRAVED_STONE_WALL_N_S");
  check("west|east -> ENGRAVED_STONE_WALL_W_E",
    DwfTiles._engravingWallTokenForTest(ENG_W | ENG_E) === "ENGRAVED_STONE_WALL_W_E");
  check("north|south|west|east (all 4) -> ENGRAVED_STONE_WALL_N_S_W_E",
    DwfTiles._engravingWallTokenForTest(ENG_N | ENG_S | ENG_W | ENG_E) === "ENGRAVED_STONE_WALL_N_S_W_E");
  check("north|west|east (triple) -> ENGRAVED_STONE_WALL_N_W_E",
    DwfTiles._engravingWallTokenForTest(ENG_N | ENG_W | ENG_E) === "ENGRAVED_STONE_WALL_N_W_E");
  check("lone diagonal NW -> ENGRAVED_STONE_WALL_NW (no underscore)",
    DwfTiles._engravingWallTokenForTest(ENG_NW) === "ENGRAVED_STONE_WALL_NW");
  check("lone diagonal SE -> ENGRAVED_STONE_WALL_SE",
    DwfTiles._engravingWallTokenForTest(ENG_SE) === "ENGRAVED_STONE_WALL_SE");
  check("mixed cardinal+diagonal (N + NW, two separate records) -> cardinal wins (documented residual)",
    DwfTiles._engravingWallTokenForTest(ENG_N | ENG_NW) === "ENGRAVED_STONE_WALL_N");
  check("floor-only bit (no wall bits set) -> null (no wall token; floor handled separately)",
    DwfTiles._engravingWallTokenForTest(0x0001) === null);
  check("zero mask -> null", DwfTiles._engravingWallTokenForTest(0) === null);
  void ENG_SW; // referenced for symmetry/documentation only

  console.log("\nWC-22 blood-family: resolved rgb -> nearest BLOOD_* family (canvas2d)");
  check("golden fixture blood-red [180,20,20] -> BLOOD_RED",
    DwfTiles._bloodFamilyFromRgbForTest([180, 20, 20]) === "BLOOD_RED");
  check("blue [20,40,200] -> BLOOD_CYAN", DwfTiles._bloodFamilyFromRgbForTest([20, 40, 200]) === "BLOOD_CYAN");
  check("purple [160,30,170] -> BLOOD_MAGENTA", DwfTiles._bloodFamilyFromRgbForTest([160, 30, 170]) === "BLOOD_MAGENTA");
  check("yellow [200,190,30] -> BLOOD_ICHOR", DwfTiles._bloodFamilyFromRgbForTest([200, 190, 30]) === "BLOOD_ICHOR");
  check("grey [120,120,120] -> BLOOD_GOO", DwfTiles._bloodFamilyFromRgbForTest([120, 120, 120]) === "BLOOD_GOO");
  check("missing rgb -> null (caller falls back to the stable hash pick)",
    DwfTiles._bloodFamilyFromRgbForTest(null) === null);

  console.log("\nWC-19: item-designation mark token from iflags (canvas2d, parity with GL)");
  check("forbid (0x02) -> DESIGNATION_ITEM_FORBIDDEN", DwfTiles._itemMarkTokenForTest(0x02) === "DESIGNATION_ITEM_FORBIDDEN");
  check("dump (0x04) -> DESIGNATION_ITEM_DUMP", DwfTiles._itemMarkTokenForTest(0x04) === "DESIGNATION_ITEM_DUMP");
  check("melt (0x08) -> DESIGNATION_ITEM_MELT", DwfTiles._itemMarkTokenForTest(0x08) === "DESIGNATION_ITEM_MELT");
  check("forbid|melt -> DESIGNATION_ITEM_FORBIDDEN_MELT", DwfTiles._itemMarkTokenForTest(0x02 | 0x08) === "DESIGNATION_ITEM_FORBIDDEN_MELT");
  check("forbid|dump -> DESIGNATION_ITEM_FORBIDDEN_DUMP", DwfTiles._itemMarkTokenForTest(0x02 | 0x04) === "DESIGNATION_ITEM_FORBIDDEN_DUMP");
  check("no flags -> null", DwfTiles._itemMarkTokenForTest(0) === null);
  check("web-only (0x01) -> null (not a designation mark)", DwfTiles._itemMarkTokenForTest(0x01) === null);

  console.log(failed === 0 ? "\nPASS (0 failures)" : `\nFAIL (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err && err.stack || err);
  process.exit(1);
});
