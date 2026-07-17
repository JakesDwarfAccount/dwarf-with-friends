// b256_projectile_sprite_test.mjs -- B256: "archers fire white circles instead of the correct bolt
// sprite." Run: node tools/harness/b256_projectile_sprite_test.mjs
//
// WHAT B256 ACTUALLY IS. Unlike B248 (a real sprite losing a priority race), this one is a
// PLACEHOLDER that was never replaced. WC-22 landed the projectile wire + both renderers'
// projectile passes, and BOTH deliberately drew a solid-color marker:
//   dwf-tiles.js drawProjectiles(): ctx.arc(...) fillStyle "rgba(250,240,200,0.95)"  <- the white circle
//   dwf-gl.js    buildProjectiles(): atlas.resolveStamp("proj:bolt", paintProjStamp)  <- the same dot
// with the comment "Item-art resolution by item_type index needs a client itemdef/type dictionary
// this path doesn't yet carry". That dictionary DOES exist client-side (GET /item_type_meta.json,
// WA-5/WA-12, numeric df::item_type -> "AMMO"), it was just wired to the cache worker only.
//
// DF'S REAL MODEL (raws, verified in the live install):
//   * There is NO projectile sprite sheet. data/vanilla/vanilla_items_graphics/graphics/
//     graphics_items.txt:754 [AMMO_GRAPHICS:ITEM_AMMO_BOLTS] -> AMMO_GRAPHICS_STRAIGHT_DEFAULT:
//     ITEM_AMMO:0:1 (+ DIAGONAL and WOOD variants). Arrows = rows 2/3, blowdarts = rows 4/5.
//     DF draws the AMMO ITEM'S OWN sprite for the flying projectile.
//   * TILE_GRAPHICS:UNIT_STATUS:0:37 PROJECTILE (graphics_interface.txt:2476) is a different
//     thing entirely -- a UNIT being flung through the air (B248 wired that; not this).
//   * The art is already in our atlas: web/item_map.json bytoken has ITEM_AMMO_BOLTS /
//     ITEM_AMMO_ARROWS / ITEM_AMMO_BLOWDARTS -> item_ammo.png.
//
// The wire has shipped everything needed since WC-22 (world_stream.cpp:1967 emits item_type,
// subtype, mat_type, mat_index per projectile), so the fix is CLIENT-ONLY: run the projectile's
// (item_type, subtype, mat) through the SAME resolveItemVisual chain every ground item uses.
// That covers bolts, arrows, blowdarts, ballista bolts AND anything thrown (a hurled spear is
// just item_type WEAPON), not only the crossbow bolt the owner saw.
//
// This fixture fails against pre-fix main on every cell below.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const realItemMap = JSON.parse(fs.readFileSync(path.join(ROOT, "web/item_map.json"), "utf8"));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  - " + name); }
  catch (err) { failed++; console.error("  FAIL- " + name + ": " + (err && err.message || err)); }
}

// df::item_type ordinals (dfhack library/include/df/item_type.h) -- exactly the shape the
// server's /item_type_meta.json route ships ([[v,"KEY"],...], http_server.cpp:225).
const ITEM_TYPE_META = [[4, "BOULDER"], [24, "WEAPON"], [39, "AMMO"], [65, "SIEGEAMMO"], [86, "TOOL"]];
// The v1 ITEMDEF_DICT, as tiles.js keys it: "<TYPE>:<subtype>" -> raws token.
const ITEMDEF = new Map([
  ["AMMO:0", "ITEM_AMMO_BOLTS"], ["AMMO:1", "ITEM_AMMO_ARROWS"], ["AMMO:2", "ITEM_AMMO_BLOWDARTS"],
  ["WEAPON:7", "ITEM_WEAPON_SPEAR"], ["SIEGEAMMO:0", "ITEM_SIEGEAMMO_BALLISTA"],
  ["TOOL:3", "ITEM_TOOL_MINECART"],
]);

// ---- (0) the art exists (the standing rule: prove it, never assume it's missing) ----------
check("item_map carries native ammo art for all three ammo classes", () => {
  for (const tok of ["ITEM_AMMO_BOLTS", "ITEM_AMMO_ARROWS", "ITEM_AMMO_BLOWDARTS"]) {
    const e = realItemMap.bytoken[tok];
    assert.ok(e && e.sheet === "item_ammo.png", tok + " must map to item_ammo.png, got " + JSON.stringify(e));
  }
  assert.ok(realItemMap.bytype.AMMO && realItemMap.bytype.AMMO.sheet === "item_ammo.png",
    "bytype.AMMO is the no-dict fallback and must also be real ammo art");
});

// ---- load GL --------------------------------------------------------------------------------
const glbox = {}; glbox.self = glbox; glbox.performance = { now: () => 0 };
vm.createContext(glbox);
for (const f of ["web/js/dwf-adjacency.js", "web/js/dwf-gl.js"])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), glbox, { filename: f });
const GL = glbox.DwfGL;
assert.ok(GL, "dwf-gl.js must export DwfGL");

// ---- boot canvas2d in a DOM-less host (same shape as gem_water_parity_test) -------------------
class FakeCanvasEl {
  constructor() { this.width = 800; this.height = 600; this.style = {}; }
  addEventListener() {} removeEventListener() {}
  getContext() {
    return new Proxy({}, {
      get(t, p) { if (p in t) return t[p]; if (p === "measureText") return () => ({ width: 8 }); return () => {}; },
      set(t, p, v) { t[p] = v; return true; },
    });
  }
}
globalThis.window = globalThis;
globalThis.DwfAdjacency = glbox.DwfAdjacency;
globalThis.location = { search: "", protocol: "http:", host: "localhost:8765" };
globalThis.document = {
  hidden: false, addEventListener() {}, getElementById() { return null; },
  createElement() { return { width: 0, height: 0, style: {}, getContext() { return { imageSmoothingEnabled: true, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(32 * 32 * 4) }; }, putImageData() {} }; } }; },
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
globalThis.Image = class { constructor() { this.onload = null; this.onerror = null; } set src(_v) {} };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("item_map.json") !== -1) return { ok: true, json: async () => realItemMap };
  if (u.indexOf("item_type_meta.json") !== -1) return { ok: true, json: async () => ({ wire: 1, item_types: ITEM_TYPE_META }) };
  return { ok: false, json: async () => null };
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), { filename: "dwf-tiles.js" });
const T = globalThis.DwfTiles;
assert.ok(T, "canvas2d export must load");
T.init({ canvas: new FakeCanvasEl(), managePoll: false, manageCamera: false });

async function waitUntil(pred, maxMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > (maxMs || 2000)) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}
await waitUntil(() => !!T._resolveItemVisualForTest({ type: "AMMO", mat_type: -1 }), 2000);
// The renderer must keep its OWN numeric-item_type table now (not just hand it to the cache
// worker) -- this is the hop that was missing.
await waitUntil(() => !!(T.getItemTypeNames && T.getItemTypeNames()), 2000).catch(() => {});
assert.ok(T.getItemTypeNames && T.getItemTypeNames(), "tiles.js must expose the numeric item_type table (getItemTypeNames)");
T._setItemDefTokensForTest(ITEMDEF);

const glb = GL.createSceneBuilder({ itemMap: realItemMap, itemDefTokens: ITEMDEF, itemTypeNames: T.getItemTypeNames(), atlas: null });

// wire-shaped projectile records (world_stream.cpp:1967).
const proj = (item_type, subtype, extra) => Object.assign(
  { x: 12, y: 12, z: 150, fx: 128, fy: 128, item_type, subtype, mat_type: 0, mat_index: 12, vehicle: false }, extra || {});

const BOLT = proj(39, 0), ARROW = proj(39, 1), DART = proj(39, 2);
const SPEAR = proj(24, 7);                       // a THROWN weapon -- same wire shape
const BALLISTA = proj(65, 0);                    // siege ammo
const ROCK = proj(4, -1);                        // a thrown/catapulted boulder: no subtype

// ---- (1) canvas2d: the flying projectile resolves to the AMMO ITEM'S OWN sprite ------------
check("canvas2d resolves a crossbow bolt to ITEM_AMMO_BOLTS art (not the white dot)", () => {
  const v = T._projItemVisualForTest(BOLT);
  assert.ok(v && v.entry, "bolt must resolve to a sprite entry");
  assert.equal(v.entry.sheet, "item_ammo.png");
  assert.deepEqual({ col: v.entry.col, row: v.entry.row }, { col: 0, row: 1 }, "graphics_items.txt:755 STRAIGHT_DEFAULT");
  assert.equal(v.source, "itemdef");
});
check("canvas2d covers arrows + blowdarts (every ammo class, not just the bolt)", () => {
  const a = T._projItemVisualForTest(ARROW), d = T._projItemVisualForTest(DART);
  assert.deepEqual([a.entry.sheet, a.entry.col, a.entry.row], ["item_ammo.png", 0, 3], "graphics_items.txt:761 arrows");
  assert.deepEqual([d.entry.sheet, d.entry.col, d.entry.row], ["item_ammo.png", 0, 5], "graphics_items.txt:767 blowdarts");
});
check("canvas2d covers thrown/siege projectiles (spear, ballista bolt, boulder)", () => {
  const s = T._projItemVisualForTest(SPEAR);
  assert.equal(s.entry.sheet, "item_weapons.png", "a thrown spear draws the spear");
  const b = T._projItemVisualForTest(BALLISTA);
  assert.ok(b && b.entry && b.entry.sheet, "ballista ammo must resolve");
  const r = T._projItemVisualForTest(ROCK);
  assert.ok(r && r.entry && r.entry.sheet && r.source !== "missing", "a thrown boulder must draw real art");
});
check("canvas2d falls back to bytype AMMO art when the ITEMDEF_DICT has not arrived yet", () => {
  const saved = T.getItemDefTokens();
  T._setItemDefTokensForTest(null);
  const v = T._projItemVisualForTest(BOLT);
  T._setItemDefTokensForTest(saved);
  assert.equal(v.entry.sheet, "item_ammo.png", "no dict must still be ammo art, never the dot");
  assert.equal(v.source, "bytype");
});
check("an unknown/absent item_type still yields NO art -> the marker survives as the last resort", () => {
  assert.equal(T._projItemVisualForTest(proj(999, -1)), null, "unmapped item_type must not invent a sprite");
  assert.equal(T._projItemVisualForTest({ x: 1, y: 1, z: 1 }), null, "a record with no item_type must not invent a sprite");
});

// ---- (2) GL parity: same records, same cells -------------------------------------------------
check("GL resolves the same sprite cells as canvas2d for every projectile class", () => {
  for (const [name, p] of [["bolt", BOLT], ["arrow", ARROW], ["dart", DART], ["spear", SPEAR], ["boulder", ROCK]]) {
    const c = T._projItemVisualForTest(p), g = glb._projItemVisualForTest(p);
    assert.ok(g && g.entry, "GL must resolve " + name);
    assert.deepEqual([g.entry.sheet, g.entry.col, g.entry.row], [c.entry.sheet, c.entry.col, c.entry.row],
      "renderer parity for " + name);
  }
});

// ---- (3) GL end-to-end: buildProjectiles emits the ITEM sprite, not the proj:bolt stamp ------
function makeRecordingAtlas() {
  const ids = new Map(); let n = 1; const resolved = []; const stamps = [];
  return {
    resolved, stamps,
    resolve(s, c, r) { resolved.push(s + "|" + c + "|" + r); const k = s + "|" + c + "|" + r; if (!ids.has(k)) ids.set(k, n++); return ids.get(k); },
    resolvePalette(s, c, r) { return this.resolve(s, c, r); },
    resolveStamp(key) { stamps.push(key); const k = "stamp:" + key; if (!ids.has(k)) ids.set(k, n++); return ids.get(k); },
  };
}
check("GL buildProjectiles emits the real ammo cell (item_ammo.png|0|1), never the proj:bolt stamp", () => {
  const atlas = makeRecordingAtlas();
  const b = GL.createSceneBuilder({ itemMap: realItemMap, materialMap: null, itemDefTokens: ITEMDEF, itemTypeNames: T.getItemTypeNames(), atlas });
  b.buildScene({ origin: { x: 10, y: 10, z: 150 }, width: 8, height: 8, tiles: new Array(64).fill({ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE" }) });
  const r = b.buildProjectiles([BOLT], 10, 10, 150);
  assert.ok(r.count > 0, "one projectile instance must be emitted");
  assert.ok(atlas.resolved.includes("item_ammo.png|0|1"), "GL must resolve the bolt's atlas cell; resolved=" + JSON.stringify(atlas.resolved.slice(-4)));
  assert.ok(!atlas.stamps.includes("proj:bolt"), "the white-dot stamp must NOT be used for a resolvable projectile");
});
check("GL keeps the cart marker for vehicles and the dot for unresolvable projectiles (no regression)", () => {
  const atlas = makeRecordingAtlas();
  const b = GL.createSceneBuilder({ itemMap: realItemMap, itemDefTokens: ITEMDEF, itemTypeNames: T.getItemTypeNames(), atlas });
  b.buildScene({ origin: { x: 10, y: 10, z: 150 }, width: 8, height: 8, tiles: new Array(64).fill({ tt: 1, ttname: "StoneFloor5", shape: "FLOOR", mat: "STONE" }) });
  b.buildProjectiles([proj(86, 3, { vehicle: true }), proj(999, -1)], 10, 10, 150);
  assert.ok(atlas.stamps.includes("proj:vehicle"), "vehicles keep their cart marker");
  assert.ok(atlas.stamps.includes("proj:bolt"), "an unresolvable projectile must still show SOMETHING");
});

console.log(failed ? "\nFAIL " + failed + " cell(s)" : "\nPASS b256_projectile_sprite_test");
process.exit(failed ? 1 : 0);
