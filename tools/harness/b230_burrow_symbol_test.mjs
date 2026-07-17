// b230_burrow_symbol_test.mjs -- B230 acceptance (burrow depth: symbol/colour picker, the tile
// overlay, limit_workshops, and the create-defaults fix).
//
// WHAT THIS PINS, AND WHY EACH ONE IS A REAL BUG CLASS:
//
//  1. THE OVERLAY PLANNER (dwf-burrow-overlay.js). /burrows has shipped a per-burrow `rects`
//     array since WD-13 and NOTHING drew it -- burrow tiles were invisible. The planner is pure and
//     exported precisely so its geometry can be asserted with no DOM: world tiles -> screen px,
//     clipped to the rendered window. A burrow you cannot see is a burrow you cannot trust in an
//     emergency, which is the entire point of the feature.
//
//  2. THE 23 SYMBOL CROPS (DWFUI TOKENS.spriteCrops.burrowSymbol0..22). df::burrow.symbol_index
//     picks one of DF's CUSTOM_SYMBOLS cells, but interface_map.json collapses all 23 onto a single
//     CUSTOM_SYMBOL token (cx:0, cy:0) -- so the glyphs are only reachable through a crop, and the
//     crop offsets must match DF's OWN sheet geometry, read from the raws:
//        tile_page_interface.txt: [TILE_PAGE:CUSTOM_SYMBOLS][TILE_DIM:32:32][PAGE_DIM_PIXELS:384:64]
//        graphics_interface.txt:  exactly 23 [TILE_GRAPHICS:CUSTOM_SYMBOLS:col:row:CUSTOM_SYMBOL]
//     An off-by-one in that grid silently shows the player the WRONG symbol for the index that gets
//     written to the save -- wrong in a way no crash reveals. So the test reads the count and the
//     grid out of DF's raws when they are present, and pins them when they are not.
//
//  3. THE C++ WRITE SET (src/burrows_panel.cpp). The one unacceptable outcome for a write path is a
//     half-write that desyncs a save, so the fields we DO NOT write are as load-bearing as the ones
//     we do, and both are asserted textually:
//        WRITE:      symbol_index, fg_color, bg_color, texture_r/g/b, texture_br/bg/bb
//        DO NOT:     tile, solid_texpos, blended_texpos   (DF-owned render caches / no oracle)
//     This mirrors DFHack's own and only burrow writer, scripts/internal/quickfort/burrow.lua's
//     create_burrow(), which sets exactly the same six fields and none of the three.
//
//  4. THE CREATE FIX. /burrow-create used to set fg_color=7/bg_color=0 and leave texture_r/g/b at
//     ZERO -- black on black. Every burrow the route ever made was invisible in graphics mode.
//
// Run: node tools/harness/b230_burrow_symbol_test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolveDfRoot } from "../lib/dfroot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// ---------------------------------------------------------------------------------------------
// DF ground truth. Read from the installed raws when reachable; otherwise fall back to the values
// read from them on 2026-07-14 (recorded here so the test still runs on a machine without DF).
// ---------------------------------------------------------------------------------------------
// W1: resolved, never hardcoded. This suite does NOT skip without DF -- it keeps the values it
// read from the raws on 2026-07-14, so it still checks something on a DF-less machine.
const DF_RESOLVED = resolveDfRoot().root;
const DF_RAWS = DF_RESOLVED
  ? [path.join(DF_RESOLVED, "data/vanilla/vanilla_interface/graphics")].find(p => fs.existsSync(p))
  : undefined;

let SYMBOL_COUNT = 23, SYMBOL_COLS = 12, SYMBOL_CELL = 32;
if (DF_RAWS) {
  const gfx = fs.readFileSync(path.join(DF_RAWS, "graphics_interface.txt"), "utf8");
  const cells = [...gfx.matchAll(/\[TILE_GRAPHICS:CUSTOM_SYMBOLS:(\d+):(\d+):CUSTOM_SYMBOL\]/g)]
    .map(m => ({ col: Number(m[1]), row: Number(m[2]) }));
  const page = fs.readFileSync(path.join(DF_RAWS, "tile_page_interface.txt"), "utf8");
  const dim = /\[TILE_PAGE:CUSTOM_SYMBOLS\][\s\S]*?\[TILE_DIM:(\d+):(\d+)\][\s\S]*?\[PAGE_DIM_PIXELS:(\d+):(\d+)\]/.exec(page);
  assert.ok(cells.length > 0 && dim, "DF raws present but CUSTOM_SYMBOLS not parseable");
  SYMBOL_COUNT = cells.length;
  SYMBOL_CELL = Number(dim[1]);
  SYMBOL_COLS = Number(dim[3]) / SYMBOL_CELL;
  // The cells must be bound in plain reading order, or "index i -> (i%cols, i/cols)" is a lie.
  cells.forEach((c, i) => {
    assert.equal(c.col, i % SYMBOL_COLS, `CUSTOM_SYMBOL cell ${i}: unexpected column`);
    assert.equal(c.row, Math.floor(i / SYMBOL_COLS), `CUSTOM_SYMBOL cell ${i}: unexpected row`);
  });
  console.log(`  (DF raws found: ${SYMBOL_COUNT} symbols, ${SYMBOL_COLS} cols, ${SYMBOL_CELL}px)`);
} else {
  console.log("  (DF raws not found -- using values recorded from them on 2026-07-14)");
}

// ---------------------------------------------------------------------------------------------
// 1. Overlay planner. Loaded for real (the module is a guarded IIFE that exports its pure planner
//    before touching the DOM, so a bare globalThis is enough to get at it).
// ---------------------------------------------------------------------------------------------
const overlayGlobal = {};
new Function("window", "globalThis", read("web/js/dwf-burrow-overlay.js"))(undefined, overlayGlobal);
const plan = overlayGlobal.DwfBurrowOverlay.plan;

// A 20x10 tile window whose camera sits at world (100,200), drawn at 16px/tile from screen (5,7).
const RR = { ox: 100, oy: 200, oz: 3, gw: 20, gh: 10, cell: 16, left: 5, top: 7 };

check("overlay: a burrow rect maps world tiles -> screen px", () => {
  const out = plan(RR, [{ id: 1, rgb: [10, 20, 30], rects: [{ x: 102, y: 203, w: 4, h: 1 }] }]);
  assert.equal(out.length, 1);
  // world 102 - cam 100 = tile 2 -> 5 + 2*16 = 37 ; world 203 - cam 200 = tile 3 -> 7 + 3*16 = 55
  assert.deepEqual(
    { x: out[0].x, y: out[0].y, width: out[0].width, height: out[0].height },
    { x: 37, y: 55, width: 64, height: 16 });
  assert.equal(out[0].burrow.id, 1, "the plan must carry its burrow (the tint comes from it)");
});

check("overlay: a rect fully outside the window is culled", () => {
  assert.equal(plan(RR, [{ id: 1, rects: [{ x: 500, y: 500, w: 2, h: 2 }] }]).length, 0);
  assert.equal(plan(RR, [{ id: 1, rects: [{ x: 90, y: 203, w: 4, h: 1 }] }]).length, 0, "left of window");
});

check("overlay: a rect straddling the window edge is CLIPPED, not dropped", () => {
  // x 98..103 -> tiles -2..3; only tiles 0..3 are on-window, so 4 tiles wide starting at left+0.
  const out = plan(RR, [{ id: 1, rects: [{ x: 98, y: 203, w: 6, h: 1 }] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].x, 5, "clipped rect must start at the window's left edge");
  assert.equal(out[0].width, 4 * 16, "only the on-window part is drawn");
});

check("overlay: junk input is a no-op, never a throw", () => {
  assert.deepEqual(plan(null, [{ id: 1, rects: [{ x: 1, y: 1, w: 1, h: 1 }] }]), []);
  assert.deepEqual(plan(RR, null), []);
  assert.deepEqual(plan(RR, [null, { id: 2 }, { id: 3, rects: "nope" }]), []);
  assert.deepEqual(plan({ ...RR, cell: 0 }, [{ id: 1, rects: [{ x: 100, y: 200, w: 1, h: 1 }] }]), [],
    "a zero cell size means geometry is not ready -- draw nothing");
  assert.deepEqual(plan(RR, [{ id: 1, rects: [{ x: 100, y: 200, w: 0, h: 5 }] }]), [],
    "a zero-width rect is not a rect");
});

// TEST-THE-TEST: the planner must actually be able to FAIL. Feed it a rect it should place, but
// assert a deliberately wrong screen position -- if this passes, the assertions above are vacuous.
check("overlay: TEST-THE-TEST -- a wrong expectation really does fail", () => {
  const out = plan(RR, [{ id: 1, rects: [{ x: 102, y: 203, w: 4, h: 1 }] }]);
  assert.throws(() => assert.equal(out[0].x, 999), "the planner's x is asserted, not assumed");
});

// ---------------------------------------------------------------------------------------------
// 2. The 23 symbol crops in DWFUI.
// ---------------------------------------------------------------------------------------------
const UIC = read("web/js/dwf-ui-components.js");

check(`DWFUI: ${SYMBOL_COUNT} burrowSymbol crops are generated from the CUSTOM_SYMBOL token`, () => {
  const count = /const BURROW_SYMBOL_COUNT = (\d+);/.exec(UIC);
  const cols = /const BURROW_SYMBOL_COLS = (\d+);/.exec(UIC);
  const cell = /const BURROW_SYMBOL_CELL = (\d+);/.exec(UIC);
  assert.ok(count && cols && cell, "the generated-crop constants must exist");
  assert.equal(Number(count[1]), SYMBOL_COUNT, "crop count must match DF's CUSTOM_SYMBOL cell count");
  assert.equal(Number(cols[1]), SYMBOL_COLS, "crop grid width must match DF's sheet");
  assert.equal(Number(cell[1]), SYMBOL_CELL, "crop cell size must match DF's TILE_DIM");
  assert.match(UIC, /TOKENS\.spriteCrops\[`burrowSymbol\$\{i\}`\][\s\S]{0,200}sprite:\s*"CUSTOM_SYMBOL"/,
    "the crops must hang off the real CUSTOM_SYMBOL token");
});

check("DWFUI: artBtnHtml forwards spriteCrop (or the glyphs never render)", () => {
  assert.match(UIC, /const inner = c\.spriteCrop[\s\S]{0,240}iconHtml\(\{\s*spriteCrop: c\.spriteCrop/,
    "artBtnHtml must pass spriteCrop through to iconHtml -- it only handled `sprite` before B230");
});

// The crop math itself, evaluated exactly as the source computes it.
check("DWFUI: crop offsets tile the sheet in reading order with no overlap", () => {
  const seen = new Set();
  for (let i = 0; i < SYMBOL_COUNT; i++) {
    const x = (i % SYMBOL_COLS) * SYMBOL_CELL;
    const y = Math.floor(i / SYMBOL_COLS) * SYMBOL_CELL;
    const key = `${x},${y}`;
    assert.ok(!seen.has(key), `symbol ${i} would reuse sheet cell ${key}`);
    seen.add(key);
    assert.ok(x >= 0 && x < SYMBOL_COLS * SYMBOL_CELL, `symbol ${i} x off-sheet`);
  }
  assert.equal(seen.size, SYMBOL_COUNT);
});

// ---------------------------------------------------------------------------------------------
// 3 + 4. The C++ write set.
// ---------------------------------------------------------------------------------------------
const CPP = read("src/burrows_panel.cpp");
// The curses palette read was factored out of burrows_panel.cpp into the shared helper
// (src/curses_palette.cpp) so the SAME gps->uccolor bytes ship on the /version text-color handshake
// (text-color spec §3.2). The RGB-source assertion below now checks that helper; the write-set
// assertions stay on burrows_panel.cpp, which still owns apply_burrow_symbol.
const PALETTE_CPP = read("src/curses_palette.cpp");

check("C++: apply_burrow_symbol writes exactly the six graphics-mode fields", () => {
  const body = /void apply_burrow_symbol\([\s\S]*?\n\}/.exec(CPP);
  assert.ok(body, "apply_burrow_symbol must exist");
  for (const field of ["symbol_index", "fg_color", "bg_color",
                       "texture_r", "texture_g", "texture_b",
                       "texture_br", "texture_bg", "texture_bb"]) {
    assert.match(body[0], new RegExp(`burrow->${field}\\s*=`), `must write ${field}`);
  }
});

check("C++: the DF-owned render caches are NOT written (a guessed texpos is the desync risk)", () => {
  // Assignments only -- reads/comments are fine. `tile` has no oracle (no index->CP437 map);
  // solid_texpos/blended_texpos are DF's own caches, which quickfort also never touches.
  for (const field of ["tile", "solid_texpos", "blended_texpos"]) {
    assert.doesNotMatch(CPP, new RegExp(`burrow->${field}\\s*=[^=]`),
      `burrows_panel.cpp must NOT assign burrow->${field} -- see the apply_burrow_symbol banner`);
  }
});

check("C++: colour RGB comes from DF's live palette, not a hardcoded table", () => {
  assert.match(PALETTE_CPP, /gps->uccolor\[index\]\[0\]/, "fg/bg RGB must be read from df::global::gps->uccolor");
  assert.match(PALETTE_CPP, /if \(!gps \|\| index < 0 \|\| index >= kColors\)\s*\n\s*return false;/,
    "a missing gps must mean 'leave the texture bytes alone', not 'substitute a made-up colour'");
  // burrows_panel still routes through the shared reader rather than re-reading gps itself.
  assert.match(CPP, /dwf::curses::rgb/, "burrows_panel must use the shared curses palette helper");
});

check("C++: create no longer leaves a burrow black-on-black", () => {
  const body = /int32_t do_burrow_create\([\s\S]*?\n\}/.exec(CPP);
  assert.ok(body, "do_burrow_create must exist");
  assert.doesNotMatch(body[0], /burrow->fg_color\s*=\s*7\s*;/,
    "the old fg=7/bg=0 write left texture_r/g/b at 0 -- an invisible burrow");
  assert.match(body[0], /apply_burrow_symbol\(burrow,[^)]*\)/,
    "create must route its defaults through the same helper, so the texture RGB is populated");
});

check("C++: /burrow-symbol accepts a partial update (colour without restating the symbol)", () => {
  assert.match(CPP, /server\.Post\("\/burrow-symbol"/, "the route must be registered");
  const body = /bool do_burrow_symbol\([\s\S]*?\n\}/.exec(CPP);
  assert.ok(body, "do_burrow_symbol must exist");
  assert.match(CPP, /if \(symbol >= 0\)/, "a negative symbol must mean 'leave it alone'");
  assert.match(CPP, /if \(fg >= 0\)/, "a negative fg must mean 'leave it alone'");
  assert.match(CPP, /if \(bg >= 0\)/, "a negative bg must mean 'leave it alone'");
});

check("C++: limit_workshops -- the other half of df::burrow_flag -- is drivable", () => {
  assert.match(CPP, /action == "workshops-limit"[\s\S]{0,80}limit_workshops = 1/);
  assert.match(CPP, /action == "workshops-all"[\s\S]{0,80}limit_workshops = 0/);
  assert.match(CPP, /"limitWorkshops\\":/, "/burrows must report the flag, or the button cannot latch");
});

check("C++: /burrows ships the picker's inputs (symbol, colours, palette)", () => {
  for (const key of ["symbolIndex", "fgColor", "bgColor", "rgb", "bgRgb", "palette"]) {
    assert.match(CPP, new RegExp(`\\\\"${key}\\\\":`), `/burrows must emit ${key}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 5. The client no longer lies about the server.
// ---------------------------------------------------------------------------------------------
const PLACEMENT = read("web/js/dwf-controls-placement.js");

check("client: the false 'tile rects endpoint pending' warn is gone, and rects are consumed", () => {
  assert.doesNotMatch(PLACEMENT, /burrow tile overlay unavailable/,
    "the rects had shipped since WD-13 -- the warn was telling players a live feature was missing");
  // B238 widened the call to setBurrows(burrowsCache, burrowsZ) -- the rects are built for ONE z,
  // so the overlay has to know which. Still the same property: the list must reach the overlay.
  assert.match(PLACEMENT, /DwfBurrowOverlay\.setBurrows\(burrowsCache\b/,
    "the burrow list (with its rects) must be published to the overlay");
  assert.match(PLACEMENT, /DwfBurrowOverlay\.setBurrows\(\[\]\)/,
    "closing burrow mode must clear the overlay -- DF shows burrow tiles inside the mode only");
});

check("client: a paint stroke refreshes the rects (coalesced, not per-cell)", () => {
  assert.match(PLACEMENT, /function scheduleBurrowRefresh\(\)/,
    "free paint fires one call per cell; refetching per call would be a fetch storm");
  assert.match(PLACEMENT, /setBurrowStatus\(mode === "erase"[\s\S]{0,120}scheduleBurrowRefresh\(\)/,
    "a successful paint must schedule the refresh, or the overlay shows stale tiles");
});

check("client: the picker is registered and reachable", () => {
  assert.match(read("web/index.html"), /dwf-burrow-overlay\.js/, "the overlay must be loaded");
  assert.match(read("web/js/dwf-control-shell.js"), /function burrowSymbolMarkup\(/);
  assert.match(PLACEMENT, /function renderBurrowSymbol\(\)/);
  assert.match(PLACEMENT, /\/burrow-symbol\?player=/, "the picker must POST the new route");
});

console.log(`\nb230_burrow_symbol_test: ${passed} checks passed`);
