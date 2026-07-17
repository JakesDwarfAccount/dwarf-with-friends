// b253_statue_test.mjs -- B253 (2026-07-14): "looks like we are missing the top half and
// some decorative patterning on the built statues... there are different variations to statues
// so make sure you get them all".
//
// A BUILT STATUE IS THREE CELLS, NOT ONE, and one of them lands on the tile ABOVE the statue:
//
//     statue's own tile : pedestal[material class][quality]   (material-tinted)
//                       + the subject's BOTTOM cell over it
//     one tile ABOVE    : the subject's TOP cell
//
// DF's own model, cited (df-structures, <DFHACK_ROOT>\library\xml):
//   df.itemdef.xml:44-48   item_statue_graphics_infost { flags; texpos_top; texpos_bottom; }
//                          -- the ONLY *_graphics_infost in df-structures with a top/bottom
//                          texpos PAIR: a statue is DF's only 2-cell-tall built object.
//   df.itemdef.xml:24-42   item_statue_graphics_flag: overall subject type, material class,
//                          artifact_index, QUALITY(3b) -- the quality column IS the frieze.
//   df.item.xml:1532-1542  item_statuest.art_graphics_type / .art_graphics_id -- DF precomputes
//                          the subject identity ONTO THE ITEM. The BUILDING has only an unused
//                          `statue_flag` (df.building.xml:1520) -- same root cause as B246.
//   df.creature.xml:1328   creature_raw/caste_raw statue_texpos[2], comment "top,bottom".
// Raws: [TILE_PAGE:STATUES] images/statues.png 32x32, 8x8 (tile_page_items.txt:120-123);
//   graphics_statues.txt (the generic subject + pedestal table); 932 STATUE_CREATURE_GRAPHICS
//   blocks across 37 graphics_creatures_*statues*.txt files, every one 1 wide x 2 tall.
//
// WHAT WAS BROKEN: building_map.json's flat "Statue" key held ONE cell -- statues.png (0,0),
// the plainest quality-1 stone PEDESTAL. That flat grey block is pixel-for-pixel the browser
// capture (B253-2.png). Nothing above the plinth was ever drawn.
//
// FAILS ON PRE-FIX MAIN: cells 1-9 all fail (no `statues` section in building_map.json, no
// statueEntry() in dwf-tiles.js / dwf-gl.js).
//
// Run: node tools/harness/b253_statue_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_PATH = path.resolve(__dirname, "../../web/js/dwf-tiles.js");
const GL_PATH = path.resolve(__dirname, "../../web/js/dwf-gl.js");
const BUILDING_MAP_PATH = path.resolve(__dirname, "../../web/building_map.json");

const bmap = JSON.parse(fs.readFileSync(BUILDING_MAP_PATH, "utf8"));

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// ---------------------------------------------------------------------------
// (1) the DATA: building_map.json must carry the whole statue family.
// ---------------------------------------------------------------------------
console.log("B253 (1): building_map.json `statues` section -- the complete vanilla table");

check("building_map.json has a `statues` section", !!bmap.statues);
const S = bmap.statues || {};   // null-safe: every cell below FAILS loudly on pre-fix main

check("statue sheet is statues.png", S.sheet === "statues.png");

// Pedestals: 4 material classes x 7 quality slots (1..6 = ordinary..masterwork, 7 = artifact
// fallback col -- graphics_statues.txt:14 "if you don't use ITEM_STATUE_ARTIFACT").
const MATS = ["WOOD", "STONE", "METAL", "GLASS"];
check("pedestal table covers all 4 material classes with 7 quality cells each",
  !!S.pedestal && MATS.every((m) => Array.isArray(S.pedestal[m]) && S.pedestal[m].length === 7));
// THE DECORATIVE PATTERNING: quality must actually MOVE the cell. We shipped col 0 always.
check("quality changes the pedestal cell (STONE q0..q5 -> cols 0..5) -- the missing frieze",
  !!S.pedestal && !!S.pedestal.STONE && S.pedestal.STONE.map((c) => c.col).join(",") === "0,1,2,3,4,5,5");
check("material class changes the pedestal ROW (WOOD/STONE row 0, METAL/GLASS row 1)",
  !!S.pedestal && !!S.pedestal.WOOD && S.pedestal.WOOD[0].row === 0 && S.pedestal.STONE[0].row === 0
  && S.pedestal.METAL[0].row === 1 && S.pedestal.GLASS[0].row === 1);
check("artifact pedestals (ITEM_STATUE_ARTIFACT, statues.png row 2) are present -- 6 variants",
  Array.isArray(S.artifact) && S.artifact.length === 6 && S.artifact.every((c) => c.row === 2));

// Subjects: every one is a TOP/BOTTOM pair, and BOTTOM is always TOP's row + 1.
const subjTokens = Object.keys(S.subjects || {});
check("all 13 generic subject TOP/BOTTOM pairs are present (graphics_statues.txt)",
  subjTokens.length === 13);
check("every generic subject is 1 wide x 2 tall (bottom = top's row + 1, same col)",
  subjTokens.length > 0 && subjTokens.every((t) => {
    const p = S.subjects[t];
    return p.top && p.bottom && p.top.col === p.bottom.col && p.bottom.row === p.top.row + 1;
  }));
// The default subject IS the cube-on-plinth in the native capture: ITEM_DEFAULT_STATUE =
// statues.png (1,3) top / (1,4) bottom (graphics_statues.txt:6-7).
check("default subject = ITEM_DEFAULT_STATUE, statues.png top (1,3) / bottom (1,4)",
  !!S.default && S.default.top.col === 1 && S.default.top.row === 3
  && S.default.bottom.col === 1 && S.default.bottom.row === 4);

// The GENERIC_EVENT roster -- statue_generic_event_type (df.itemdef.xml:11-22), all 9.
check("all 9 statue_generic_event_type subjects mapped (BASE..SITE)",
  !!S.event && Object.keys(S.event).length === 9
  && S.event["0"] === "ITEM_STATUE_GENERIC_EVENT"
  && S.event["4"] === "ITEM_STATUE_GENERIC_STRIKE_DOWN"
  && S.event["8"] === "ITEM_STATUE_GENERIC_SITE");
// item_statue_graphics_type_overall (df.itemdef.xml:2-9): SHAPE=0 TREE=3 PLANT=4 have art;
// CREATURE=2 resolves per race; ITEM=1 has no vanilla per-item statue art.
check("overall-type subjects mapped: SHAPE(0), TREE(3), PLANT(4)->SHRUB",
  !!S.overall && S.overall["0"] === "ITEM_STATUE_GENERIC_SHAPE"
  && S.overall["3"] === "ITEM_STATUE_GENERIC_TREE"
  && S.overall["4"] === "ITEM_STATUE_GENERIC_SHRUB");

// "there are different variations to statues so make sure you get them all" -- 932 of them.
const creatures = S.creature || {};
check("all 932 creature statue variants are mapped (37 graphics_creatures_*statues*.txt files)",
  Object.keys(creatures).length === 932);
check("every creature statue is 1 wide x 2 tall on its own sheet",
  Object.values(creatures).every((c) => c.sheet && c.top && c.bottom
    && c.top.col === c.bottom.col && c.bottom.row === c.top.row + 1));
check("DWARF statue -> creatures_layered_statues.png (0,0)/(0,1)",
  !!creatures.DWARF && creatures.DWARF.sheet === "creatures_layered_statues.png"
  && creatures.DWARF.top.row === 0 && creatures.DWARF.bottom.row === 1);
check("caste-split creature statues survive (BIRD_PEAFOWL_BLUE MALE vs FEMALE differ)",
  creatures["BIRD_PEAFOWL_BLUE:MALE"] && creatures["BIRD_PEAFOWL_BLUE:FEMALE"]
  && creatures["BIRD_PEAFOWL_BLUE:MALE"].top.col !== creatures["BIRD_PEAFOWL_BLUE:FEMALE"].top.col);

// ---------------------------------------------------------------------------
// (2) the RENDERER: statueEntry() must produce the 3-cell composite.
// ---------------------------------------------------------------------------
console.log("\nB253 (2): dwf-tiles.js statueEntry() -- pedestal + subject bottom + subject top");

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
const storageBacking = {};
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
globalThis.sessionStorage = {
  getItem: (k) => (k in storageBacking ? storageBacking[k] : null),
  setItem: (k, v) => { storageBacking[k] = String(v); },
};
globalThis.Image = FakeImage;
globalThis.fetch = async (url) => {
  if (String(url).indexOf("building_map.json") !== -1) return { ok: true, json: async () => bmap };
  return { ok: false, json: async () => null };
};

const src = fs.readFileSync(TILES_PATH, "utf8");
vm.runInThisContext(src, { filename: TILES_PATH });
const T = globalThis.DwfTiles;
assert.ok(T, "dwf-tiles.js did not install window.DwfTiles");
assert.ok(T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false }),
  "init() returned null");

async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > (maxMs || 2000)) throw new Error("waitUntil timed out (building_map)");
    await new Promise((r) => setTimeout(r, 1));
  }
}

(async function main() {
  check("dwf-tiles.js exposes _statueEntryForTest", typeof T._statueEntryForTest === "function");
  if (typeof T._statueEntryForTest !== "function") {
    console.log(`\n${failed} FAILED -- the renderer has no statue path at all.`);
    process.exit(1);
  }
  await waitUntil(() => {
    const e = T._buildingEntryForTest({ type: "Workshop", subtype: 0 });
    return e && e.sheet !== "defaults.png";
  }, 3000);

  // --- the reported bug, exactly: a plain stone statue, no wire fields (old DLL). ---
  // 3=INORGANIC-ish header material: mat_type 0 => STONE family.
  const plain = T._statueEntryForTest({ id: 1, type: "Statue", x1: 5, y1: 5, x2: 5, y2: 5, mat_type: 0, mat_index: 1 });
  check("a Statue resolves through statueEntry(), not the one-cell flat key", !!plain);
  check("THE MISSING TOP HALF: the entry carries an `overhang` (the tile-ABOVE cell)",
    !!plain && Array.isArray(plain.overhang) && plain.overhang.length === 1 && !!plain.overhang[0]);
  check("the subject's BOTTOM cell is composited over the plinth on the statue's own tile",
    !!plain && Array.isArray(plain.overlay) && !!plain.overlay[0] && !!plain.overlay[0][0]);
  check("the subject is material-tinted like the plinth (overlayTint) -- it is the same stone",
    !!plain && plain.overlayTint === true);
  check("top and bottom are the two halves of ONE sprite (same col, bottom = top row + 1)",
    !!plain && plain.overhang[0].col === plain.overlay[0][0].col
    && plain.overlay[0][0].row === plain.overhang[0].row + 1);
  // With no wire subject the default (cube) applies -- which IS what the native capture shows.
  check("no-wire fallback draws ITEM_DEFAULT_STATUE (the cube in the native capture)",
    !!plain && plain.overhang[0].col === 1 && plain.overhang[0].row === 3
    && plain.overlay[0][0].col === 1 && plain.overlay[0][0].row === 4);
  check("plinth defaults to the STONE row for a stone statue",
    !!plain && plain.cells[0][0].row === 0);

  // --- THE DECORATIVE PATTERNING: quality must move the plinth column. ---
  const q0 = T._statueEntryForTest({ id: 2, type: "Statue", mat_type: 0, mat_index: 1, smt: 0, smi: 1, sq: 0 });
  const q5 = T._statueEntryForTest({ id: 3, type: "Statue", mat_type: 0, mat_index: 1, smt: 0, smi: 1, sq: 5 });
  check("THE MISSING PATTERNING: a masterwork statue draws a DIFFERENT plinth than an ordinary one",
    !!q0 && !!q5 && q0.cells[0][0].col === 0 && q5.cells[0][0].col === 5);
  const art = T._statueEntryForTest({ id: 4, type: "Statue", mat_type: 0, mat_index: 1, smt: 0, smi: 1, sq: 6 });
  check("an ARTIFACT statue draws an ITEM_STATUE_ARTIFACT plinth (statues.png row 2)",
    !!art && art.cells[0][0].row === 2);

  // --- material class rows ---
  const glassy = T._statueEntryForTest({ id: 5, type: "Statue", smt: 3, smi: -1, sq: 0 });
  check("a GLASS statue draws the metal/glass plinth row (row 1)", !!glassy && glassy.cells[0][0].row === 1);

  // --- every subject variation resolves ---
  const duel = T._statueEntryForTest({ id: 6, type: "Statue", smt: 0, smi: 1, sq: 0, sgt: 5, sgi: 1 });
  check("GENERIC_EVENT/DUEL statue -> statues.png (2,3)/(2,4)",
    !!duel && duel.overhang[0].col === 2 && duel.overhang[0].row === 3);
  const site = T._statueEntryForTest({ id: 7, type: "Statue", smt: 0, smi: 1, sq: 0, sgt: 5, sgi: 8 });
  check("GENERIC_EVENT/SITE statue -> statues.png (7,5)/(7,6)",
    !!site && site.overhang[0].col === 7 && site.overhang[0].row === 5);
  const tree = T._statueEntryForTest({ id: 8, type: "Statue", smt: 0, smi: 1, sq: 0, sgt: 3 });
  check("TREE statue -> ITEM_STATUE_GENERIC_TREE (1,5)/(1,6)",
    !!tree && tree.overhang[0].col === 1 && tree.overhang[0].row === 5);
  const shrub = T._statueEntryForTest({ id: 9, type: "Statue", smt: 0, smi: 1, sq: 0, sgt: 4 });
  check("PLANT statue -> ITEM_STATUE_GENERIC_SHRUB (4,5)/(4,6)",
    !!shrub && shrub.overhang[0].col === 4 && shrub.overhang[0].row === 5);

  // --- creature statues: a DIFFERENT SHEET for the top/bottom cells ---
  const dragon = T._statueEntryForTest({ id: 10, type: "Statue", smt: 0, smi: 1, sq: 3, sgt: 2, srt: "DRAGON" });
  check("a statue OF A DRAGON draws the dragon statue art, off the creature statue sheet",
    !!dragon && dragon.overhangSheet === "creatures_megabeast_statues.png"
    && dragon.overlaySheet === "creatures_megabeast_statues.png"
    && dragon.sheet === "statues.png");   // the plinth still comes from statues.png
  const hen = T._statueEntryForTest({ id: 11, type: "Statue", smt: 0, smi: 1, sq: 0, sgt: 2, srt: "BIRD_CHICKEN:FEMALE" });
  const cock = T._statueEntryForTest({ id: 12, type: "Statue", smt: 0, smi: 1, sq: 0, sgt: 2, srt: "BIRD_CHICKEN:MALE" });
  check("caste-specific creature statues differ (hen vs rooster)",
    !!hen && !!cock && hen.overhang[0].col !== cock.overhang[0].col);
  const unknownCaste = T._statueEntryForTest({ id: 13, type: "Statue", smt: 0, smi: 1, sq: 0, sgt: 2, srt: "DWARF:MALE" });
  check("an unmapped caste falls back to the bare race (DWARF:MALE -> DWARF)",
    !!unknownCaste && unknownCaste.overhangSheet === "creatures_layered_statues.png");
  const unknownRace = T._statueEntryForTest({ id: 14, type: "Statue", smt: 0, smi: 1, sq: 0, sgt: 2, srt: "NOT_A_REAL_RACE" });
  check("an unmapped race falls back to the DEFAULT subject, never to nothing",
    !!unknownRace && unknownRace.overhang[0].col === 1 && unknownRace.overhang[0].row === 3);

  // --- non-statues are untouched ---
  check("statueEntry() returns null for a non-statue building (no regression on other art)",
    T._statueEntryForTest({ type: "Bed" }) === null
    && T._statueEntryForTest({ type: "Workshop", subtype: 0 }) === null);

  // ---------------------------------------------------------------------------
  // (3) GL parity: the WebGL renderer must know the same three layers.
  // ---------------------------------------------------------------------------
  console.log("\nB253 (3): dwf-gl.js parity -- same statue composite in the GL path");
  const glSrc = fs.readFileSync(GL_PATH, "utf8");
  check("gl.js has a statueEntry path", /function\s+statueEntryGL\s*\(/.test(glSrc)
    && /statueEntryGL\(b\)\s*\|\|\s*buildingEntryGL\(b\)/.test(glSrc));
  check("gl.js honours overlayTint (the subject is tinted with the plinth)",
    /overlayTint/.test(glSrc));
  check("gl.js honours overhangSheet (creature statue tops are on another sheet)",
    /overhangSheet/.test(glSrc));

  // ---------------------------------------------------------------------------
  // (4) SOURCE-TIE: the C++ wire. DLL-gated -- there is no live DF in the offline sweep, so
  // these cells assert the post-fix SERVER SOURCE (the same convention as b255_bolt_jobs_test).
  // They all fail against pre-fix main.
  // ---------------------------------------------------------------------------
  console.log("\nB253 (4): world_stream.cpp -- the statue sprite key is read off the ITEM");
  const cpp = fs.readFileSync(path.resolve(__dirname, "../../src/world_stream.cpp"), "utf8");
  check("a Statue building fills its sprite key from its contained item (fill_statue_art)",
    /case building_type::Statue:[\s\S]{0,240}?fill_statue_art\(b, r\);/.test(cpp));
  check("the key comes off df::item_statuest -- never off df::building_statuest (B246's lesson)",
    /virtual_cast<df::item_statuest>\(contained->item\)/.test(cpp));
  check("we forward DF's OWN resolved subject (art_graphics_type/art_graphics_id)",
    /st->art_graphics_type/.test(cpp) && /st->art_graphics_id/.test(cpp));
  check("quality rides the wire (the decorative frieze), artifact overriding it",
    /flags\.bits\.artifact \? 6 : \(int\)st->getQuality\(\)/.test(cpp));
  check("the ITEM's material rides the wire, not the building header's",
    /r\.s_mt = st->getMaterial\(\)/.test(cpp) && /r\.s_mi = st->getMaterialIndex\(\)/.test(cpp));
  check("creature statues ship a race token, caste-qualified from DF's own art_image element",
    /statue_creature_caste/.test(cpp) && /craws\[race\]->creature_id/.test(cpp)
    && /caste\[caste\]->caste_id/.test(cpp));
  check("the caste walk REUSES art_desc.cpp's find_art_image (no second art_image chunk walk)",
    /dwf::find_art_image\(st->image\.id, st->image\.subid\)/.test(cpp));
  check("the fields are emitted on the AUX building JSON (sq/smt/smi/sgt/sgi/srt)",
    /"sq\\":/.test(cpp) && /"sgt\\":/.test(cpp) && /"srt\\":/.test(cpp));
  check("the statue key is folded into s3_bld_fold, so a finished statue actually re-sends",
    /add\(ds\.s_valid\); add\(ds\.s_quality\)/.test(cpp));

  console.log("");
  if (failed) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("B253: all checks pass -- statues draw plinth + subject bottom + subject top.");
})();
