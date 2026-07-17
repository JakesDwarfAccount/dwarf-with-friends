// b198_zone_border_test.mjs -- B198 acceptance (live win30: zone overlay drew a "tic-tac-toe"
// grid -- every interior cell stroked its own border instead of the native look = uniform fill + one
// thick border on the zone's OUTER perimeter only).
//
// ROOT CAUSE: renderZoneOverlay() autotiles each zone tile by picking a row of DF's native
// activity_zones.png from a 4-neighbour mask (zoneShapeRow in web/js/dwf-core.js). That
// mask->row table was scrambled: mask 15 (all neighbours present = fully interior) selected row 0,
// but sheet row 0 is the ISOLATED full-box sprite. So interior tiles drew a full border == grid.
//
// ORACLE: the ground-truth per-row edge set below (DF_ROW_EDGES) was read straight off
//   data/vanilla/vanilla_interface/graphics/images/activity_zones.png -- alpha-255 pixels = the
//   opaque border line, alpha-96 = the translucent fill. Detection produced a clean 16-way
//   bijection (each of the 16 neighbour masks appears exactly once), which is why it is trusted.
//   If that PNG ever changes, re-run the detection (tools/harness scratch script in the B198 notes).
//
// This test does NOT assert "row == some magic number". It asserts the END-TO-END invariant: the
// sprite the REAL client code selects for a tile strokes borders on EXACTLY the perimeter edges
// (a side is stroked iff that side's neighbour is not in the same zone). It re-reads the two real
// functions out of dwf-core.js by source slice (the file is a DOM-coupled IIFE with no
// exports, so it cannot be vm-loaded whole), so a future edit to the table is caught here.
//
// Run: node tools/harness/b198_zone_border_test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const SRC = fs.readFileSync(path.join(ROOT, "web/js/dwf-core.js"), "utf8");

// ---- extract the two real, pure functions from the client source -----------------------------
function sliceFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `could not find function ${name} in dwf-core.js`);
  // brace-match from the first '{' after the signature
  let i = SRC.indexOf("{", start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(start, i);
}
// eslint-disable-next-line no-new-func
const make = new Function(`${sliceFn("zoneExtentAt")}\n${sliceFn("zoneShapeRow")}\nreturn { zoneExtentAt, zoneShapeRow };`);
const { zoneShapeRow } = make();

// ---- ORACLE: activity_zones.png per-row border edges (edge => neighbour ABSENT on that side) ---
// Detected from the PNG; a side letter present == that row's sprite strokes a border on that side.
const DF_ROW_EDGES = {
  0: "NSWE", 1: "NW", 2: "NE", 3: "SE", 4: "SW", 5: "N", 6: "E", 7: "W",
  8: "S", 9: "NS", 10: "WE", 11: "NWE", 12: "SWE", 13: "NSW", 14: "NSE", 15: "",
};

// ---- helpers ---------------------------------------------------------------------------------
// Build a zone {w,h,extents} from an ASCII map (rows of '#' in-zone / '.' out). Rectangular grid.
function zoneFromMap(rows) {
  const h = rows.length, w = rows[0].length;
  let extents = "";
  for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) extents += rows[ly][lx] === "#" ? "1" : "0";
  return { w, h, extents };
}
function inZone(zone, lx, ly) {
  if (lx < 0 || ly < 0 || lx >= zone.w || ly >= zone.h) return false;
  return zone.extents.charAt(lx + ly * zone.w) === "1";
}
// The CORRECT perimeter for a tile: a side is a border iff that side's neighbour is NOT in the zone.
function expectedBorders(zone, lx, ly) {
  let b = "";
  if (!inZone(zone, lx, ly - 1)) b += "N";
  if (!inZone(zone, lx, ly + 1)) b += "S";
  if (!inZone(zone, lx - 1, ly)) b += "W";
  if (!inZone(zone, lx + 1, ly)) b += "E";
  return b;
}
const norm = s => s.split("").sort().join("");
// What the REAL client will actually paint on this tile: the sprite row it picks -> that row's edges.
function actualBorders(zone, lx, ly) {
  return DF_ROW_EDGES[zoneShapeRow(zone, lx, ly)];
}

let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}
// Assert every in-zone tile's painted borders == its true perimeter.
function assertZoneCorrect(zone, label) {
  for (let ly = 0; ly < zone.h; ly++) for (let lx = 0; lx < zone.w; lx++) {
    if (!inZone(zone, lx, ly)) continue;
    const exp = norm(expectedBorders(zone, lx, ly));
    const act = norm(actualBorders(zone, lx, ly));
    assert.equal(act, exp, `${label} tile (${lx},${ly}): painted borders [${act}] != perimeter [${exp}]`);
  }
}

// =============================================================================================
// The reported regression: a solid 3x3 zone. The CENTRE tile must have ZERO borders (the whole
// bug was that it drew a full box -> tic-tac-toe). Guarded explicitly, not just via the sweep.
// =============================================================================================
section("solid 3x3: centre tile draws NO border (the tic-tac-toe regression)", () => {
  const z = zoneFromMap(["###", "###", "###"]);
  assert.equal(actualBorders(z, 1, 1), "", "interior tile (mask 15) must select the borderless sheet row");
});
section("solid 3x3: interior edges never stroked, perimeter fully stroked", () => {
  assertZoneCorrect(zoneFromMap(["###", "###", "###"]), "3x3");
});

// =============================================================================================
// Single-tile zone == full box (all four sides). (mask 0 -> row 0)
// =============================================================================================
section("single-tile zone is a full box (all 4 borders)", () => {
  const z = zoneFromMap(["#"]);
  assert.equal(norm(actualBorders(z, 0, 0)), "ENSW");
});

// =============================================================================================
// Rectangles of assorted sizes: corners = 2 sides, edges = 1 side, interior = none.
// =============================================================================================
section("rectangles 1x1..6x4: every tile's border set == its perimeter", () => {
  for (const [w, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 2], [5, 4], [6, 4]]) {
    const rows = Array.from({ length: h }, () => "#".repeat(w));
    assertZoneCorrect(zoneFromMap(rows), `${w}x${h}`);
  }
});

// =============================================================================================
// 1xN strips: end caps have 3 borders, middles have 2 (the two long sides).
// =============================================================================================
section("horizontal 1x4 strip: ends 3-sided, middles top+bottom only", () => {
  const z = zoneFromMap(["####"]);
  assert.equal(norm(actualBorders(z, 0, 0)), "NSW", "left cap");
  assert.equal(norm(actualBorders(z, 3, 0)), "ENS", "right cap");
  assert.equal(norm(actualBorders(z, 1, 0)), "NS", "middle");
  assertZoneCorrect(z, "1x4");
});
section("vertical 4x1 strip: ends 3-sided, middles left+right only", () => {
  const z = zoneFromMap(["#", "#", "#", "#"]);
  assert.equal(norm(actualBorders(z, 0, 0)), "ENW", "top cap");
  assert.equal(norm(actualBorders(z, 0, 3)), "ESW", "bottom cap");
  assert.equal(norm(actualBorders(z, 0, 1)), "EW", "middle");
  assertZoneCorrect(z, "4x1");
});

// =============================================================================================
// Concave / L-shaped / multi-rect zone: the concave (inner) corner must render correctly. This is
// the case a naive "bounding-box perimeter" would get wrong -- per-edge neighbour test handles it.
// =============================================================================================
section("L-shape: concave inner corner strokes exactly its two exposed sides", () => {
  // ##
  // ##
  // #.   -> the tile at (0,2) is the foot; (1,1) is the inner corner region
  const z = zoneFromMap(["##", "##", "#."]);
  assertZoneCorrect(z, "L-shape");
  // spot-check tiles the sweep already covers (foot of the L + the notch column):
  assert.equal(norm(actualBorders(z, 1, 1)), "ES", "(1,1): east (out of bounds) + south (notch) exposed");
  assert.equal(norm(actualBorders(z, 0, 2)), "ESW", "(0,2) foot: south, west (both edges) + east (notch) exposed");
});
section("plus/cross shape: every arm tip and the hub render their true perimeter", () => {
  const z = zoneFromMap([".#.", "###", ".#."]);
  assertZoneCorrect(z, "plus");
  assert.equal(actualBorders(z, 1, 1), "", "hub of the plus is fully interior -> no border");
});

// =============================================================================================
// Two adjacent-but-distinct zones keep a border between them. zoneShapeRow only sees ONE zone's
// extents, so a tile on the shared seam sees the OTHER zone as "not me" -> border. Model zone A as
// the left half; its right column tiles must stroke their east (seam) edge.
// =============================================================================================
section("two adjacent distinct zones keep a border on the shared seam", () => {
  const zoneA = zoneFromMap(["##", "##"]); // sits at x0..1; zone B (not in these extents) abuts at x2
  // right column (lx=1) is the seam-facing edge of A; east neighbour is outside A's extents -> border
  assert.ok(actualBorders(zoneA, 1, 0).includes("E"), "seam-facing tile strokes its east border");
  assert.ok(actualBorders(zoneA, 1, 1).includes("E"), "seam-facing tile strokes its east border");
  assertZoneCorrect(zoneA, "zoneA-half");
});

// =============================================================================================
// Exhaustive: for a padded canvas covering all 16 neighbour combinations, the client's chosen row
// always paints exactly the perimeter. This is the real "no scrambled table" guarantee.
// =============================================================================================
section("exhaustive: all 16 neighbour combinations map to the correct perimeter", () => {
  for (let m = 0; m < 16; m++) {
    // build a 3x3 with the centre in-zone and each neighbour present per bit n=1,s=2,w=4,e=8
    const grid = [[".", ".", "."], [".", "#", "."], [".", ".", "."]];
    if (m & 1) grid[0][1] = "#"; // N
    if (m & 2) grid[2][1] = "#"; // S
    if (m & 4) grid[1][0] = "#"; // W
    if (m & 8) grid[1][2] = "#"; // E
    const z = zoneFromMap(grid.map(r => r.join("")));
    const exp = norm(expectedBorders(z, 1, 1));
    const act = norm(actualBorders(z, 1, 1));
    assert.equal(act, exp, `mask ${m}: painted [${act}] != perimeter [${exp}]`);
  }
});

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nALL B198 ZONE-BORDER CHECKS PASSED");
