// b38_desig_wall_lighten_test.mjs -- B38 acceptance (bug list B38: mining designation
// glyphs are MISSING on REVEALED wall faces adjacent to a corridor being mined; picks render
// only on the still-hidden dark rock behind).
//
// ROOT CAUSE: the designation glyph in designations.png is a ~35%-alpha mid-grey overlay
// (measured: cell(0,1) pick = avgRGB ~93,92,98, centerAlpha ~90/255). It only reads over a
// LIGHTENED backdrop. The WB-5 additive lighten (rgb 27,29,26, "lighter") that supplies that
// backdrop fired ONLY for t.hidden -- drawDesignation's own code even flagged visible-tile
// designation-lighten as an unhandled residual. B36 (e5294e7) then turned REVEALED wall
// interiors from a full bright block into a DARK fill (darkened base + exposed-edge cell only),
// so a revealed designated wall lost its bright backdrop and the pick vanished, while the
// still-hidden walls behind kept their lighten and stayed visible -- exactly the report.
//
// FIX: extend the additive lighten to REVEALED WALL designated tiles (the tiles B36 darkened),
// in BOTH renderers, byte-identically. This test drives the GL renderer's instance emission
// (the additive-lighten SOLID_CELL carries ATTR_ADDITIVE) so the fix is asserted deterministically
// without pixels. The canvas2d twin (drawDesignation) is covered by the same condition edit.
//
// Run: node tools/harness/b38_desig_wall_lighten_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const sandbox = {};
sandbox.self = sandbox;
sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8"), sandbox, { filename: "web/js/dwf-gl.js" });
const GL = sandbox.DwfGL;
assert.ok(GL, "sandbox must export DwfGL");
const ATTR_ADDITIVE = GL.ATTR_ADDITIVE;
const SOLID_CELL = GL.SOLID_CELL;
const DIG_CELL = [0, 1]; // designations.png pick cell (DESIG_CELL.dig)

function makeMockAtlas() {
  const ids = new Map();
  let next = 1;
  return { resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!ids.has(k)) ids.set(k, next++); return ids.get(k); } };
}
function decode(builder) {
  const buf = builder.buffer, n = builder.count;
  const f32 = new Float32Array(buf), u16 = new Uint16Array(buf), u8 = new Uint8Array(buf);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      x: f32[k * 4], y: f32[k * 4 + 1], cell: u16[k * 8 + 4], attr: u16[k * 8 + 5],
      r: u8[k * 16 + 12], g: u8[k * 16 + 13], b: u8[k * 16 + 14], a: u8[k * 16 + 15],
    });
  }
  return out;
}
function tile(o) {
  return Object.assign({ tt: 1, ttname: "", shape: "FLOOR", mat: "STONE", hidden: false, flow: 0, liquid: "none", outside: 1 }, o);
}
// The WB-5/B38 additive-lighten instance: SOLID_CELL, ATTR_ADDITIVE set, fully-transparent tint.
function additiveLightenAt(inst, gx, gy) {
  return inst.find((i) => i.cell === SOLID_CELL && (i.attr & ATTR_ADDITIVE) && i.a === 0 && i.x === gx && i.y === gy);
}
function digGlyphAt(inst, atlas, gx, gy) {
  const gc = atlas.resolve("designations.png", DIG_CELL[0], DIG_CELL[1]);
  return inst.find((i) => i.cell === gc && i.x === gx && i.y === gy);
}
function buildOne(t) {
  const atlas = makeMockAtlas();
  const b = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
  b.buildScene({ origin: { x: 0, y: 0, z: 0 }, width: 1, height: 1, tiles: [t] });
  return { inst: decode(b), atlas };
}

let failures = 0;
function section(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (err) { failures++; console.error("FAIL " + name + ": " + (err && err.stack || err)); }
}

const DIG = { dig: "Default" };

// -----------------------------------------------------------------------------------------
// The working baseline (never regressed): a HIDDEN designated wall gets the additive lighten.
// -----------------------------------------------------------------------------------------
section("HIDDEN designated wall: additive lighten + pick glyph both present (baseline)", () => {
  const { inst, atlas } = buildOne(tile({ shape: "WALL", hidden: true, desig: DIG }));
  assert.ok(additiveLightenAt(inst, 0, 0), "hidden designated wall must emit the additive lighten");
  assert.ok(digGlyphAt(inst, atlas, 0, 0), "hidden designated wall must emit the pick glyph");
});

// -----------------------------------------------------------------------------------------
// THE B38 FIX: a REVEALED designated wall (adjacent to a mined corridor) now ALSO gets the
// additive lighten, so its ~35%-alpha grey pick reads over B36's dark wall interior.
// This assertion FAILS against the pre-B38 code (lighten was gated on t.hidden only) -- it is
// the regression guard that reproduces the bug.
// -----------------------------------------------------------------------------------------
section("REVEALED designated wall: additive lighten now present (the B38 fix)", () => {
  const { inst, atlas } = buildOne(tile({ shape: "WALL", hidden: false, desig: DIG }));
  assert.ok(digGlyphAt(inst, atlas, 0, 0), "revealed designated wall emits the pick glyph (always did)");
  assert.ok(additiveLightenAt(inst, 0, 0),
    "revealed designated WALL must emit the additive lighten so the grey pick reads over B36's dark interior");
});

// -----------------------------------------------------------------------------------------
// Boundaries / test-the-test.
// -----------------------------------------------------------------------------------------
section("SEEDED-BAD: a revealed designated FLOOR gets NO additive lighten (bright already)", () => {
  // Non-wall revealed terrain is drawn at full brightness by both renderers; native does not
  // over-brighten it, and the fix must not either -- the lighten is for DARK backdrops only.
  const { inst, atlas } = buildOne(tile({ shape: "FLOOR", hidden: false, desig: { smooth: 1 } }));
  assert.ok(!additiveLightenAt(inst, 0, 0), "revealed floor must NOT get the wall/hidden dark-backdrop lighten");
});
section("ISOLATION: an UNdesignated revealed wall emits neither lighten nor glyph", () => {
  const { inst, atlas } = buildOne(tile({ shape: "WALL", hidden: false }));
  assert.ok(!additiveLightenAt(inst, 0, 0), "undesignated wall: no designation lighten");
  assert.ok(!digGlyphAt(inst, atlas, 0, 0), "undesignated wall: no pick glyph");
});
section("ISOLATION: an UNdesignated hidden wall emits no lighten (lighten is designation-scoped)", () => {
  const { inst } = buildOne(tile({ shape: "WALL", hidden: true }));
  assert.ok(!additiveLightenAt(inst, 0, 0), "hidden but undesignated wall: the lighten is designation-only");
});

if (failures) { console.error("\n" + failures + " FAILED"); process.exit(1); }
console.log("\nALL B38 DESIG-WALL-LIGHTEN CHECKS PASSED");
