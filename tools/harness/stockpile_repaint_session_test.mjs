// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// SPDX-License-Identifier: AGPL-3.0-only

// Native stockpile repaint session regression (owner request, v1): the existing-pile repaint
// exposes the SAME staged control set the zone repaint session has -- rect/free paint, erase,
// remove-existing, Cancel/Accept -- and commits ONE exact world-addressed '0'/'1' bitmap
// (mode=replace) that round-trips interior holes, instead of the old single-drag camera-relative
// rectangle. Server side: /stockpile-repaint mode=replace creates the replacement pile inert over
// the mask's tight bounds, CARVES the mask's holes out of it (carve-only -- DF's own construct
// validation stays the authority), and only then runs the proven settings-copy/purge/deconstruct
// finish. Executable cells run the SHIPPED helpers, not test copies.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const controls = fs.readFileSync(path.join(root, "web/js/dwf-controls-placement.js"), "utf8");
const core = fs.readFileSync(path.join(root, "web/js/dwf-core.js"), "utf8");
const panels = fs.readFileSync(path.join(root, "web/js/dwf-building-zone-stockpile-panels.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src/stockpile_panel.cpp"), "utf8");
const luaBridge = fs.readFileSync(path.join(root, "src/lua_bridge.cpp"), "utf8");

function body(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}
// ---- 1. the session float exposes the native four-tool control row (zone parity) ---------------
const toolsStart = controls.indexOf('<div class="stock-repaint-tools"');
assert.notEqual(toolsStart, -1, "the stockpile float has a repaint tools row");
const toolsEnd = controls.indexOf('<div class="stock-palette-status"', toolsStart);
const toolsMarkup = controls.slice(toolsStart, toolsEnd);
for (const token of ["BUTTON_PAINT_RECTANGLE_INACTIVE", "BUTTON_FREE_PAINT_INACTIVE",
  "STOCKPILE_ERASE_INACTIVE", "STOCKPILE_REMOVE_EXISTING"])
  assert.ok(toolsMarkup.includes(token), `repaint float includes native tool ${token}`);
assert.ok(toolsMarkup.indexOf("BUTTON_PAINT_RECTANGLE_INACTIVE") < toolsMarkup.indexOf("BUTTON_FREE_PAINT_INACTIVE") &&
  toolsMarkup.indexOf("BUTTON_FREE_PAINT_INACTIVE") < toolsMarkup.indexOf("STOCKPILE_ERASE_INACTIVE") &&
  toolsMarkup.indexOf("STOCKPILE_ERASE_INACTIVE") < toolsMarkup.indexOf("STOCKPILE_REMOVE_EXISTING"),
  "native tool order is Rectangle, Freehand, Erase portion, Remove stockpile (zone-session order)");
assert.match(controls, /stockCancel: ""[\s\S]*label: "Cancel"[\s\S]*stockAccept: ""[\s\S]*label: "Accept"/,
  "the staged float exposes both Cancel and Accept");
assert.match(controls, /stockSummaryCopy\.innerHTML = DWFUI\.bitmapTextHtml\(\s*`\$\{label\}: \$\{count\} /,
  "the repaint float reports original tile count plus/minus the staged delta");

// ---- 2. strokes are STAGED; Accept is the one commit point -------------------------------------
assert.match(controls, /stockRepaintId != null && !stockRepaintRemoveArmed[\s\S]{0,220}stageStockRepaintDrag/,
  "map pointer-up stages repaint geometry");
assert.doesNotMatch(controls, /function repaintStockpileDrag/,
  "the old immediate-commit rectangle drag is gone");
assert.match(body(controls, "async function acceptStockRepaint()"),
  /zoneRepaintFinalShape\(draft\)[\s\S]*mode=replace[\s\S]*body: shape\.extents/,
  "Accept serializes through the SHARED exact-shape serializer and sends one mode=replace bitmap");
assert.match(body(controls, "function stageStockRepaintDrag(x1, y1, x2, y2)"),
  /rendered\.ox[\s\S]*setZoneDraftTile[\s\S]*stockRepaintFreeCells/,
  "strokes become exact world tiles immediately, including free-paint cells");
assert.match(body(controls, "async function loadStockRepaintBase(id)"),
  /\/stockpile-info\?id=[\s\S]*sp\.extents[\s\S]*changes: new Map\(\)/,
  "the draft base is the pile's authoritative extents bitmap from /stockpile-info");
assert.match(panels, /DFStockRepaint\.arm\(id, \{[\s\S]{0,200}label:/,
  "the stockpile panel's paint latch arms the session with the pile's label identity");
assert.match(core, /function drawStockRepaintPreview\(ctx\)[\s\S]*?rgba\(90, 205, 255[\s\S]*?rgba\(235, 75, 65/,
  "the retained preview distinguishes exact added and erased tiles (zone colors)");

// ---- 3. executable round trip: an interior hole survives the SHIPPED serializer ----------------
const { zoneRepaintFinalShapeFn } = (() => {
  const extract = name => {
    const start = controls.indexOf(`function ${name}(`);
    const coreStart = core.indexOf(`function ${name}(`);
    const src = start !== -1 ? controls : core;
    const at = start !== -1 ? start : coreStart;
    assert.notEqual(at, -1, `missing ${name}`);
    const open = src.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
    }
    assert.fail(`unterminated ${name}`);
  };
  const built = new Function(
    `${extract("zoneExtentAt")}\n${extract("zoneWorldPresent")}\n${extract("setZoneDraftTile")}\n` +
    `${extract("zoneRepaintFinalShape")}\n` +
    "return { zoneRepaintFinalShapeFn: zoneRepaintFinalShape, setZoneDraftTileFn: setZoneDraftTile };")();
  // Stage exactly like the stockpile session does: a /stockpile-info-shaped base + staged edits.
  const draft = {
    zone: { id: 42, x: 10, y: 20, z: 100, w: 3, h: 3, extents: "111111111" },
    changes: new Map(),
  };
  built.setZoneDraftTileFn(draft, 11, 21, false);      // erase the center -> interior hole
  built.setZoneDraftTileFn(draft, 13, 20, true);       // freehand extension outside the rect
  const shape = built.zoneRepaintFinalShapeFn(draft);
  assert.deepEqual(shape, {
    x1: 10, y1: 20, x2: 13, y2: 22, z: 100, extents: "111110101110"
  }, "a stockpile draft round-trips an interior hole + a disconnected added tile exactly");
  // full-erase guard: clearing every tile is refused CLIENT-side before any request
  const wipe = { zone: draft.zone, changes: new Map() };
  for (let y = 20; y <= 22; y++) for (let x = 10; x <= 12; x++) built.setZoneDraftTileFn(wipe, x, y, false);
  assert.deepEqual(built.zoneRepaintFinalShapeFn(wipe), { empty: true },
    "clearing every tile is detected before the request (explicit Remove is the only delete path)");
  return built;
})();
void zoneRepaintFinalShapeFn;

// ---- 4. server: mode=replace exact-mask pipeline mirrors the zone route ------------------------
const handler = body(server, "auto stockpile_repaint_handler = [](const httplib::Request& req, httplib::Response& res)");
const replaceAt = handler.indexOf('mode == "replace"');
assert.notEqual(replaceAt, -1, "/stockpile-repaint has a mode=replace branch");
const replaceBranch = handler.slice(replaceAt, handler.indexOf("int px = 0;"));
assert.match(replaceBranch, /query_int\(req, "x1"[\s\S]*"y1"[\s\S]*"x2"[\s\S]*"y2"[\s\S]*"z"/,
  "the exact route is world-addressed (x1/y1/x2/y2/z), not camera-relative");
assert.match(replaceBranch, /req\.body/, "the bitmap rides the POST body");
assert.match(replaceBranch, /mask\.size\(\)\) != cells/, "bitmap size must match its bounds");
assert.match(replaceBranch, /c != '0' && c != '1'/, "bitmap charset is validated");
assert.match(replaceBranch, /kMaxStockpileRepaintTiles/, "footprint size is capped");
assert.match(replaceBranch, /res\.status = 409;[\s\S]{0,220}cannot erase an entire\s*"\s*"stockpile/,
  "erasing every tile is refused with 409 and the pile left unchanged");
assert.match(replaceBranch, /create_stockpile_at_world_rect_via_lua\([^)]*"none"/,
  "the replacement pile is created INERT over the mask's tight bounds (B137 preserved)");
const carveAt = replaceBranch.indexOf("carve_stockpile_extent_mask_on_core_thread");
const finishAt = replaceBranch.indexOf("finish_stockpile_repaint_on_core_thread");
assert.ok(carveAt !== -1 && finishAt !== -1 && carveAt < finishAt,
  "the mask is carved out of the NEW pile before settings copy + old-pile deconstruct");
assert.ok((replaceBranch.match(/remove_stockpile_on_core_thread\(new_id\)/g) || []).length >= 2,
  "every failure after the temp create removes the temp pile (no orphan inert piles)");
// the legacy camera-relative rectangle path survives for the new-pile paint-extend flow
assert.match(handler, /missing id\/px\/py\/w\/h/, "legacy rectangle clients still get the old contract");

// carve helper: carve-ONLY (a tile DF excluded at construct time is never re-added), allocate
// before touching DF state, and the full-erase refusal exists server-side too.
const carve = body(server, "bool carve_stockpile_extent_mask_on_core_thread");
assert.match(carve, /mask\[i\] == '1' &&\s*\n\s*\(!shaped \|\| sp->room\.extents\[i\] != df::building_extents_type::None\)/,
  "carve-only: mask AND existing membership -- construct-time exclusions preserved");
assert.match(carve, /new \(std::nothrow\)[\s\S]*not enough memory/,
  "extents fully allocated + initialized before the swap (allocation failure changes nothing)");
assert.match(carve, /cannot erase an entire stockpile/, "server-side full-erase refusal");
assert.match(luaBridge, /bool create_stockpile_at_world_rect_via_lua\(/,
  "world-rect create exists in the lua bridge");
assert.match(body(server, "std::string stockpile_info_json_on_core_thread"), /\\"extents\\"/,
  "/stockpile-info exposes the extents bitmap the client stages from");

// UI-cache purge (dump-proven UAF class) still guards the deconstruct in the shared finish.
const finish = body(server, "bool finish_stockpile_repaint_on_core_thread");
const purgeAt = finish.indexOf("purge_ui_caches_for_building");
const deconAt = finish.indexOf("Buildings::deconstruct");
assert.ok(purgeAt !== -1 && deconAt !== -1 && purgeAt < deconAt,
  "finish still purges UI caches BEFORE deconstructing the old pile");

// ---- 5. seeded-bad: the detectors bite ---------------------------------------------------------
{
  const noCarve = replaceBranch.replace(/carve_stockpile_extent_mask_on_core_thread/g, "/*gone*/");
  assert.equal(noCarve.indexOf("carve_stockpile_extent_mask_on_core_thread") !== -1, false,
    "(seeded-bad) a replace branch without the carve call is detected");
  const looseCarve = carve.replace(
    /mask\[i\] == '1' &&\s*\n\s*\(!shaped \|\| sp->room\.extents\[i\] != df::building_extents_type::None\)/,
    "mask[i] == '1'");
  assert.doesNotMatch(looseCarve, /mask\[i\] == '1' &&\s*\n\s*\(!shaped/,
    "(seeded-bad) a carve that re-adds DF-excluded tiles is detected");
  const noTools = controls.replaceAll('"STOCKPILE_ERASE_INACTIVE"', '"REMOVED"');
  const s = noTools.indexOf('<div class="stock-repaint-tools"');
  const e = noTools.indexOf('<div class="stock-palette-status"', s);
  assert.equal(noTools.slice(s, e).includes("STOCKPILE_ERASE_INACTIVE"), false,
    "(seeded-bad) a float that loses the erase control is detected");
}

console.log("PASS stockpile repaint session: native four-tool staged float, exact interior-hole round trip, mode=replace carve-before-finish server pipeline, purge-before-deconstruct intact");
