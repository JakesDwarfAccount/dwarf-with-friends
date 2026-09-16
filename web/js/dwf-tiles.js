// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// Standalone tile renderer: polls /mapdata and draws the DF map straight to a <canvas>.

(function () {
  "use strict";

  // ---- player identity (same convention as dwf-core.js) ------------------
  const params = new URLSearchParams(location.search);
  const stored = (function () {
    try { return localStorage.getItem("dwf.player"); } catch (_) { return null; }
  })();
  const fresh = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
    `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let player = params.get("player") || stored || fresh;
  // Never persist this player id: dwf-join.js's gate() reads localStorage["dwf.player"] first,
  // and a written fallback makes a first-time visitor silently auto-join under a generated name.

  // stable per-TAB client id: sessionStorage survives a refresh and differs per new tab
  const clientId = (function () {
    try {
      let id = sessionStorage.getItem("dwf.cid");
      if (!id) {
        id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
          `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
        sessionStorage.setItem("dwf.cid", id);
      }
      return id;
    } catch (_) {
      return `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    }
  })();

  // ---- protocol v1 is the only wire -----------------------------------------------
  function v1Active() { return true; }

  // ---- coloring ------------------------------------------------------------------
  const MAT_COLOR = {
    STONE: [128, 128, 128],
    SOIL: [120, 82, 48],
    MINERAL: [150, 130, 90],
    LAVA_STONE: [70, 60, 60],
    FROZEN_LIQUID: [170, 200, 230],
    CONSTRUCTION: [110, 110, 120],
    GRASS_LIGHT: [86, 140, 62],
    GRASS_DARK: [58, 104, 48],
    GRASS_DRY: [150, 150, 70],
    GRASS_DEAD: [110, 100, 70],
    PLANT: [70, 130, 70],
    TREE: [86, 66, 40],
    ROOT: [96, 74, 48],
    MUSHROOM: [150, 120, 130],
    DRIFTWOOD: [120, 100, 70],
    POOL: [60, 90, 150],
    BROOK: [70, 110, 170],
    RIVER: [55, 95, 165],
    ASHES: [90, 90, 90],
    MAGMA: [200, 70, 20],
    AIR: [24, 24, 28],
    NONE: [18, 18, 20],
  };
  const FALLBACK_MAT = [100, 100, 100];

  const BG = [14, 14, 16];
  const WALL_DARKEN = 0.45;
  const UNIT_COLOR = "rgb(240,220,60)";
  const UNIT_OUTLINE = "rgb(20,20,20)";
  // ghost tint: spectral-green multiply plus DF's own ghost translucency (its palette row is alpha 163)
  const GHOST_TINT_RGB = [120, 235, 150];
  const GHOST_ALPHA = 163 / 255;
  const GHOST_TINT_CSS = "rgb(" + GHOST_TINT_RGB[0] + "," + GHOST_TINT_RGB[1] + "," + GHOST_TINT_RGB[2] + ")";
  const UNIT_STATUS_BLINK_MS = 800;
  const USTAT_SLEEPING = 0x01;
  const USTAT_UNCONSCIOUS = 0x02;
  const USTAT_NAUSEA = 0x00000800;
  const USTAT_PARALYZED = 0x00002000;
  const BLD_OUTLINE = "rgb(230,150,40)";
  // native's measured undiscovered-field colour, equal to hidden_rock.png's own cell background
  const HIDDEN_COLOR = [49, 44, 52];

  function matRgb(mat) {
    return MAT_COLOR[mat] || FALLBACK_MAT;
  }

  function darken(rgb, f) {
    return [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)];
  }

  function waterRgb(depth) {
    const d = Math.max(1, Math.min(7, depth));
    const b = 90 + d * 18;
    return [30, 60 + d * 6, Math.min(255, b + 60)];
  }

  function magmaRgb(depth) {
    const d = Math.max(1, Math.min(7, depth));
    return [Math.min(255, 150 + d * 14), Math.max(30, 90 - d * 8), 10];
  }

  function rgbStr(rgb) {
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  // ---- real liquid sprites --------------------------------------------------------
  const WATER_CELL = { sheet: "liquids.png", col: 0 };
  const MAGMA_CELL = { sheet: "liquids.png", col: 1 };

  function liquidCellFor(liquid, flow) {
    if (liquid !== "water" && liquid !== "magma") return null;
    const d = Math.max(1, Math.min(7, flow || 0));
    const base = (liquid === "magma") ? MAGMA_CELL : WATER_CELL;
    return { sheet: base.sheet, col: base.col, row: 7 - d };
  }

  function liquidEdgeTokens(t, gx, gy, lookupTile, Adj) {
    if (!Adj || !lookupTile) return [];
    const flow = t && (t.flow || 0), liquid = t && (t.liquid || "none");
    if (flow <= 0 || (liquid !== "water" && liquid !== "magma")) return [];
    const mask8 = Adj.computeMask8(lookupTile, gx, gy, (nt) => {
      if (!nt) return true;
      const nFlow = nt.flow || 0, nLiquid = nt.liquid || "none";
      return !(nFlow > 0 && (nLiquid === "water" || nLiquid === "magma"));
    });
    if (!mask8) return [];
    const prefix = (liquid === "magma") ? "UNDERMAGMA_EDGE_" : "UNDERWATER_EDGE_";
    const out = [];
    for (let i = 0; i < Adj.DIR_NAMES.length && out.length < 4; i++) {
      const name = Adj.DIR_NAMES[i];
      if (mask8 & Adj.BIT[name]) out.push(prefix + name);
    }
    return out;
  }

  function resolveLiquidSprite(t) {
    if (t.hidden) return null;
    const flow = t.flow || 0;
    const liquid = t.liquid || "none";
    if (flow <= 0 || (liquid !== "water" && liquid !== "magma")) return null;
    const entry = liquidCellFor(liquid, flow);
    if (!entry) return null;
    const sheet = getSheet(entry.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    return { img: sheet.img, col: entry.col, row: entry.row };
  }

  function isTreeWallMat(mat) { return mat === "TREE" || mat === "MUSHROOM"; }

  function derivedTreePart(t) {
    const shape = t.shape || "", mat = t.mat || "";
    if (shape === "TWIG") return "LEAVES";
    if (shape === "BRANCH") return "BRANCH";
    if (shape === "TRUNK_BRANCH") return "TRUNK";
    if (mat === "TREE") return (shape === "WALL") ? "TRUNK" : "CANOPY";
    if (mat === "MUSHROOM") return "TRUNK";
    return null;
  }

  const GRASS_BACK_OFFSETS = (() => {
    const out = [];
    for (let r = 1; r <= 1; r++) {
      const ring = [];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
        }
      }
      ring.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])));
      out.push.apply(out, ring);
    }
    return out;
  })();
  function isGrassBackingSource(n) {
    if (!n || n.hidden) return false;
    return n.mat === "GRASS_LIGHT" || n.mat === "GRASS_DARK";
  }
  function grassBackingCell(t, gx, gy, lookup) {
    const mat = t.mat || "";
    if (mat !== "TREE" && mat !== "MUSHROOM") return null;
    const shape = t.shape || "";
    if (shape === "EMPTY" || shape === "NONE") return null;
    if (typeof gx !== "number" || typeof gy !== "number") return null;
    const at = lookup || tileAt;
    for (let i = 0; i < GRASS_BACK_OFFSETS.length; i++) {
      if (isGrassBackingSource(at(gx + GRASS_BACK_OFFSETS[i][0], gy + GRASS_BACK_OFFSETS[i][1]))) {
        return TOKEN_CELL_OVERRIDE["GRASS_" + ((hashXY(gx, gy) & 3) + 1)];
      }
    }
    return null;
  }

  function groundBackingCell(t, gx, gy, lookup) {
    if (t.plant && t.grass && t.grass.amount > 0) {
      const own = grassFallbackCell(gx, gy, t.grass.id, t.ttname, true);
      return own ? {
        sheet: own.sheet, col: own.col, row: own.row,
        wash: own.tint === "grassSummer",
      } : null;
    }
    const gb = grassBackingCell(t, gx, gy, lookup);
    if (gb) return { sheet: gb.sheet, col: gb.col, row: gb.row, wash: true };
    if ((t.shape || "") !== "BOULDER") return null;
    const grassBack = (id) => {
      const c = grassFallbackCell(gx, gy, id, t.ttname);
      return c ? {
        sheet: c.sheet, col: c.col, row: c.row,
        wash: c.tint === "grassSummer",
      } : null;
    };
    if (t.grass && t.grass.amount > 0) return grassBack(t.grass.id); // (1) true floor: grass
    if (!t.grass && typeof gx === "number" && typeof gy === "number") {
      const at = lookup || tileAt;                                   // (2) ring-1 borrow
      for (let i = 0; i < GRASS_BACK_OFFSETS.length; i++) {
        if (isGrassBackingSource(at(gx + GRASS_BACK_OFFSETS[i][0], gy + GRASS_BACK_OFFSETS[i][1]))) {
          return grassBack();
        }
      }
    }
    const entry = spriteMap && spriteMap.STONE_FLOOR_5;              // (3) rough stone floor
    if (!entry || !entry.sheet) return null;
    return { sheet: entry.sheet, col: entry.col, row: entry.row, wash: false };
  }

  function tileColor(t, skipLiquidColor) {
    const tt = (typeof t.tt === "number") ? t.tt : -1;
    if (tt < 0) return null;
    if (t.hidden) return HIDDEN_COLOR;
    if (!skipLiquidColor) {
      const flow = t.flow || 0;
      const liquid = t.liquid || "none";
      if (flow > 0 && liquid === "magma") return magmaRgb(flow);
      if (flow > 0 && liquid === "water") return waterRgb(flow);
    }
    const shape = t.shape || "NONE";
    const mat = t.mat || "NONE";
    const base = matRgb(mat);
    if (shape === "WALL" || shape === "FORTIFICATION") {
      if (isTreeWallMat(mat)) return base;
      if (shape === "WALL" && wallMaterial(t)) return HIDDEN_COLOR;
      const cr = wallMaterialRgb(t);
      if (cr) return darken(cr, WALL_DARKEN);
      return darken(base, WALL_DARKEN);
    }
    if (shape === "EMPTY" || shape === "NONE" || shape === "RAMP_TOP") return null;
    return base;
  }

  function isStairOrRamp(shape) {
    return shape === "STAIR_UP" || shape === "STAIR_DOWN" ||
      shape === "STAIR_UPDOWN" || shape === "RAMP" || shape === "RAMP_TOP";
  }

  // ---- premium terrain sprites ----------------------------------------------------
  // spriteMap keys are graphics TOKENS, not df::tiletype enum keys: translate ttname -> token first.
  let spriteMap = null;
  let tiletypeTokenMap = null; // { "<ttname>": {token, tint}, ... } from /tiletype_token_map.json
  const sheets = Object.create(null);

  const TINT_COLORS = {
    grassSummer: "rgba(93,119,52,0.25)",
  };

  // The /sprites/map.json parser mis-binds GRASS_n to floors.png (a token collision); the
  // REAL grass sprites are the 4 opaque textured cells of grass.png (graphics_grass.txt:
  // [GRASS_1:GRASS:0:0]..[GRASS_4:GRASS:3:0]). Override those tokens to the correct cells;
  // the 4 variants give DF's per-tile grass texture variation.
  const TOKEN_CELL_OVERRIDE = {
    GRASS_1: { sheet: "grass.png", col: 0, row: 0 },
    GRASS_2: { sheet: "grass.png", col: 1, row: 0 },
    GRASS_3: { sheet: "grass.png", col: 2, row: 0 },
    GRASS_4: { sheet: "grass.png", col: 3, row: 0 },
  };

  // GRASS CHECKERBOARD FIX: two independent gaps left some tiles with no
  // tiletype_token_map.json entry at all, so resolveSprite() gave up and
  // tileColor()'s flat color showed through as a hard-edged square amid the
  // textured grass.png field:
  //   1. df::tiletype's "Shrub"/"ShrubDead"/"Sapling"/"SaplingDead" entries are
  //      shape SHRUB/SAPLING with tiletype_material PLANT (confirmed against DF's
  //      own tiletype enum) -- build_tiletype_token_map.py's classify() only
  //      handles shape FLOOR/WALL/FORTIFICATION/RAMP/RAMP_TOP/STAIR_*/BOULDER/
  //      PEBBLES, so these four ttnames are never written to the JSON. A wild
  //      shrub/sapling standing on any biome's natural ground is overwhelmingly
  //      standing on grass, so tileColor() fell back to the flat PLANT-material
  //      color ([70,130,70]) under the small plant-tuft overlay drawPlant() draws
  //      -- a flat green square peeking out around every wild plant.
  //   2. Forward-compat: any future/modded grass FLOOR ttname not yet present in
  //      the generated token map should still get grass texture instead of flat
  //      color, per the same "GRASS_n" family.
  // Both fall back to one of the 4 real grass.png cells (same sheet/cells as the
  // TOKEN_CELL_OVERRIDE above), picked by a stable per-tile hash for variety
  // since these ttnames carry no DF variant digit to key off of.
  const GRASS_FLOOR_FALLBACK_TTNAMES = new Set(["Shrub", "ShrubDead", "Sapling", "SaplingDead"]);
  function looksLikeGrassFloor(ttname) {
    return GRASS_FLOOR_FALLBACK_TTNAMES.has(ttname) ||
      (ttname.indexOf("Grass") !== -1 && ttname.indexOf("Floor") !== -1);
  }

  // stable per-tile hash: the same (x,y) must pick the same variant every frame or the grass flickers
  function hashXY(x, y) {
    return ((x * 374761393 + y * 668265263) ^ (x >> 3)) >>> 0;
  }

  function boulderVariant(t, gx, gy) {
    const entry = spriteMap && spriteMap.BOULDER;
    if (!entry || entry.sheet !== "terrain_boulders.png" || entry.col !== 0 || entry.row !== 0) return null;
    const wx = (t && typeof t.x === "number") ? t.x : gx;
    const wy = (t && typeof t.y === "number") ? t.y : gy;
    const h = hashXY(wx, wy);
    return { col: h & 3, row: (h >> 2) & 1 };
  }

  // Undiscovered rock is black with confetti: at most 4 speckle cells per 16x16 block column per z.
  // The scatter is anchored per (block_x, block_y, z) -- keying it on the viewport slides it under pans.
  const HIDDEN_SLOTS = 4;
  const HIDDEN_SCATTER_MAX = 8192;   // live-key ceiling; a whole embark z-slice is ~256 keys
  const hiddenScatter = new Map();   // "bx,by,z" -> [{bx,by,variant} x4]
  function hiddenScatterSeed(bx, by, bz) {
    const s = (Math.imul(bx | 0, 0x27d4eb2d) ^ Math.imul(by | 0, 0x165667b1) ^
               Math.imul(bz | 0, 0x9e3779b1)) >>> 0;
    return s === 0 ? 0x6d2b79f5 : s;   // xorshift32 has no escape from state 0
  }
  function hiddenScatterFor(bx, by, bz) {
    const key = bx + "," + by + "," + bz;
    const hit = hiddenScatter.get(key);
    if (hit) return hit;
    let s = hiddenScatterSeed(bx, by, bz);
    const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
    next(); next();   // burn-in: neighbouring seeds are near-identical for one or two steps
    const slots = new Array(HIDDEN_SLOTS);
    for (let i = 0; i < HIDDEN_SLOTS; i++) {
      // Take the high bits: xorshift32's high bits are the well-mixed ones.
      const sx = next() >>> 28, sy = next() >>> 28;
      const v = Math.floor((next() / 4294967296) * 5);
      slots[i] = { bx: sx, by: sy, variant: v > 4 ? 4 : v };
    }
    if (hiddenScatter.size >= HIDDEN_SCATTER_MAX) hiddenScatter.clear();
    hiddenScatter.set(key, slots);
    return slots;
  }
  function resetHiddenScatter() { hiddenScatter.clear(); }
  // The first slot matching (x&15, y&15) wins; no match -> -1, "write nothing". A miss is not a
  // fallback: there is deliberately no default variant.
  function hiddenVariantAt(wx, wy, wz) {
    if (typeof wx !== "number" || typeof wy !== "number") return -1;
    const slots = hiddenScatterFor(wx >> 4, wy >> 4, (typeof wz === "number" ? wz : 0) | 0);
    const lx = wx & 15, ly = wy & 15;
    for (let i = 0; i < HIDDEN_SLOTS; i++) {
      if (slots[i].bx === lx && slots[i].by === ly) return slots[i].variant;
    }
    return -1;
  }
  function resolveHiddenSprite(t, wz) {
    const v = hiddenVariantAt(t && t.x, t && t.y, wz);
    if (v < 0) return null;
    const entry = spriteMap && spriteMap["HIDDEN_ROCK_" + (v + 1)];   // 0..4 -> _1.._5
    if (!entry || !entry.sheet) return null;
    const sheet = getSheet(entry.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    return { img: sheet.img, col: entry.col, row: entry.row };
  }

  function inMapBounds(t, dims) {
    if (!dims || !t) return false;
    const x = t.x, y = t.y;
    return typeof x === "number" && x >= 0 && x < dims.w &&
           typeof y === "number" && y >= 0 && y < dims.h;
  }

  function wantsHiddenHatch(t, dims) {
    if (!t) return false;
    const tt = (typeof t.tt === "number") ? t.tt : -1;
    if (t.hidden && tt >= 0) return true;
    return tt < 0 && inMapBounds(t, dims);
  }

  function overlaysAllowed(t) {
    if (!t) return false;
    const tt = (typeof t.tt === "number") ? t.tt : -1;
    return tt >= 0 && !t.hidden;
  }

  function grassSpriteSpec(colors, id) {
    const law = window.DwfGrassSelection;
    const spec = law && law.speciesSpec(colors, id);
    return spec ? { sheet: spec.sheet, row: spec.row, tint: spec.sheet === "grass.png" ? "grassSummer" : null } : null;
  }
  function grassVariantIndex(ttname, gx, gy, plantOccupied) {
    const law = window.DwfGrassSelection;
    return law ? law.variantIndex(ttname, plantOccupied) : 0;
  }
  function grassFallbackCell(gx, gy, id, ttname, plantOccupied, tile) {
    const law = window.DwfGrassSelection;
    const selection = law && law.select(grassColors,
      tile || { ttname, grass: { id } }, plantOccupied);
    if (!selection) return null;
    const sheet = getSheet(selection.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    if (!sheetCellHasVisiblePixel(selection.sheet, selection.col, selection.row)) return null;
    return { img: sheet.img, col: selection.col, row: selection.row,
      tint: selection.tint, sheet: selection.sheet };
  }

  function grassTierIndex(amount) {
    if (amount <= 33) return 0;
    if (amount <= 66) return 1;
    if (amount <= 99) return 2;
    return 3;
  }
  function grassSpeciesTint(id, amount) {
    if (!grassColors || !grassColors.plants || !id) return null;
    const p = grassColors.plants[id];
    if (!p || !p.tiers) return null;
    const tier = p.tiers[grassTierIndex(amount)];
    if (!tier || !tier.rgb) return null;
    // A low-alpha source-over wash, not a hard recolor, so the grass.png texture detail still shows.
    return "rgba(" + tier.rgb[0] + "," + tier.rgb[1] + "," + tier.rgb[2] + ",0.25)";
  }

  const SHEET_RETRY_DELAY_MS = 2000;
  const SHEET_RETRY_MAX_DELAY_MS = 60000;

  function sheetRetryDelay(failCount) {
    return Math.min(SHEET_RETRY_MAX_DELAY_MS, SHEET_RETRY_DELAY_MS * Math.pow(2, Math.max(0, failCount - 1)));
  }

  function getSheet(name) {
    let s = sheets[name];
    if (s && s.failed && (Date.now() - s.failedAt) >= sheetRetryDelay(s.failCount)) {
      return makeSheet(name, s.failCount);
    }
    return s || makeSheet(name, 0);
  }

  function makeSheet(name, failCount) {
    const s = sheets[name] = {
      img: new Image(), loaded: false, failed: false, failedAt: 0, failCount: failCount || 0,
      visibleCells: new Map(),
    };
    s.img.onload = () => {
      s.loaded = true;
      s.failCount = 0;
      draw();
    };
    s.img.onerror = () => {
      s.failed = true;
      s.failedAt = Date.now();
      s.failCount++;
    };
    // Never throw synchronously on a bad filename -- onerror handles load failure.
    s.img.src = "/sprites/img/" + name;
    return s;
  }

  function sheetCellHasVisiblePixel(sheetName, col, row) {
    const s = sheets[sheetName];
    if (!s || !s.loaded || s.failed || !s.img) return false;
    if (typeof col !== "number" || typeof row !== "number") return false;
    const geom = sheetCellGeometry(sheetName);
    const x0 = Math.floor(col * geom.cellW), y0 = Math.floor(row * geom.cellH);
    const iw = s.img.naturalWidth || s.img.width, ih = s.img.naturalHeight || s.img.height;
    if (x0 < 0 || y0 < 0 || x0 + geom.cellW > iw || y0 + geom.cellH > ih) return false;
    const key = col + "|" + row + "|" + geom.cellW + "|" + geom.cellH;
    if (s.visibleCells.has(key)) return s.visibleCells.get(key);
    try {
      const c = document.createElement("canvas");
      c.width = geom.cellW; c.height = geom.cellH;
      const cctx = c.getContext("2d", { willReadFrequently: true });
      cctx.drawImage(s.img, x0, y0, geom.cellW, geom.cellH, 0, 0, geom.cellW, geom.cellH);
      const id = cctx.getImageData(0, 0, geom.cellW, geom.cellH);
      let visible = false;
      for (let i = 3; id && id.data && i < id.data.length; i += 4) {
        if (id.data[i] !== 0) { visible = true; break; }
      }
      s.visibleCells.set(key, visible);
      return visible;
    } catch (_) {
      s.visibleCells.set(key, true);
      return true;
    }
  }

  async function loadSpriteMap() {
    const data = await fetchJsonOnce("/sprites/map.json");
    if (!data) { spriteMap = null; return; }
    spriteMap = data;
    const seen = new Set();
    for (const key in spriteMap) {
      const entry = spriteMap[key];
      if (entry && entry.sheet && !seen.has(entry.sheet)) {
        seen.add(entry.sheet);
        getSheet(entry.sheet);
      }
    }
  }

  async function loadTokenMap() {
    const data = await fetchJsonOnce("/tiletype_token_map.json");
    if (!data) { tiletypeTokenMap = null; return; }
    tiletypeTokenMap = data;
    draw();
  }

  let grassColors = null;
  async function loadGrassColors() {
    const data = await fetchJsonOnce("/grass_colors.json");
    grassColors = data || null;
    if (data) draw();
  }

  let shadowCellMap = null;
  async function loadShadowCellMap() {
    const data = await fetchJsonOnce("/shadow_cell_map.json");
    shadowCellMap = data || null;
    if (data) draw();
  }

  function resolveCell(token) {
    const entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
    if (!entry || !entry.sheet) return null;
    const sheet = getSheet(entry.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    if (!sheetCellHasVisiblePixel(entry.sheet, entry.col, entry.row)) return null;
    return { img: sheet.img, col: entry.col, row: entry.row, sheet: entry.sheet };
  }

  // ---- material-family construction FLOOR/TRACK art --------------------------------
  const CONS_GLASS_FLOOR_TOKEN = { 3: "GLASS_GREEN_FLOOR", 4: "GLASS_CLEAR_FLOOR", 5: "GLASS_CRYSTAL_FLOOR" };
  function constructionTrackMask(ttname) {
    const m = /Track([NSEW]+)$/.exec(ttname || "");
    if (!m) return 0;
    const s = m[1];
    return (s.indexOf("N") >= 0 ? 1 : 0) | (s.indexOf("S") >= 0 ? 2 : 0) |
           (s.indexOf("E") >= 0 ? 4 : 0) | (s.indexOf("W") >= 0 ? 8 : 0);
  }
  function paletteRowRgb(palRow) {
    if (typeof palRow !== "number" || !materialMap || !materialMap.palette) return null;
    const row = materialMap.palette.rows && materialMap.palette.rows[palRow];
    const c = row && row[7];
    return (c && c.length >= 3) ? [c[0], c[1], c[2]] : null;
  }
  function plantWoodRow(base_mi) {
    const ids = materialMap && materialMap.plant_ids;
    const id = ids && ids[base_mi];
    const p = id && materialMap.plant && materialMap.plant[id];
    return p && typeof p.WOOD === "number" ? p.WOOD : null;
  }
  function consMaterial(base_mt, base_mi) {
    if (typeof base_mt !== "number" || base_mt < 0) return null;
    if (CONS_GLASS_FLOOR_TOKEN[base_mt]) {
      const pr = matPalRowFor({ mat_type: base_mt });
      return { family: "GLASS", glassMt: base_mt, palRow: (typeof pr === "number") ? pr : null, tintRgb: paletteRowRgb(pr) };
    }
    if (base_mt >= 419) {
      const wr = plantWoodRow(base_mi);
      return { family: "WOOD", palRow: wr, woodRow: wr, tintRgb: paletteRowRgb(wr) || [150, 120, 84] };
    }
    if (base_mt === 0) {
      const ino = materialMap && materialMap.inorganic && materialMap.inorganic[base_mi];
      const fam = ino && ino.family;
      const pr = ino && typeof ino.row === "number" ? ino.row : null;
      const prOk = (typeof pr === "number") && materialMap && materialMap.palette
        && materialMap.palette.rows && materialMap.palette.rows[pr];
      const row = prOk ? pr : null;
      return { family: fam || "STONE", palRow: row, tintRgb: paletteRowRgb(row) };
    }
    return null;
  }
  function consMaterialRgb(base_mt, base_mi) {
    const m = consMaterial(base_mt, base_mi);
    return m && m.tintRgb ? m.tintRgb : null;
  }
  function wallMaterial(t) {
    if (!t) return null;
    const mat = t.mat || "";
    const m = consMaterial(t.base_mt, t.base_mi);
    if (!m) return null;
    if (mat === "CONSTRUCTION") return m;
    if (mat === "STONE" && (m.family === "STONE" || m.family === "GEM")) return m;
    if (mat === "SOIL" && m.family === "SOIL") return m;
    if (mat === "MINERAL" && (m.family === "STONE" || m.family === "GEM")) return m;
    return null;
  }
  function wallMaterialRgb(t) {
    const m = wallMaterial(t);
    return m && m.tintRgb ? m.tintRgb : null;
  }
  function wallBackingToken(t, gx, gy, openMask) {
    if (!t || (t.shape || "") !== "WALL") return null;
    if (!wallMaterial(t)) return null;
    if (!((openMask | 0) & 0xff)) return null;
    return "HIDDEN_ROCK_" + ((hashXY(gx, gy) % 5) + 1);
  }
  function fortificationOpenToken(prefix, openMask) {
    // Adjacency bit values (dwf-adjacency.js DIR order): N=1, S=2, W=4, E=8. The _OPEN_<letters>
    // suffix must equal the set bits -- an E/W-mirrored table renders corner fortifications flipped.
    const m = openMask & 15;
    const suffix = m === 15 ? "NSWE" : m === 11 ? "NSE" : m === 7 ? "NSW" :
      m === 13 ? "NWE" : m === 14 ? "SWE" : m === 3 ? "NS" : m === 12 ? "WE" :
      m === 9 ? "NE" : m === 5 ? "NW" : m === 10 ? "SE" : m === 6 ? "SW" : null;
    return suffix ? (prefix + "_OPEN_" + suffix) : prefix;
  }
  function constructionFloorPlan(ttname, base_mt, base_mi, openMask) {
    const nm = ttname || "";
    const isFloor = /^(?:Shoddy)?ConstructedFloor/.test(nm);
    const isRamp = /^(?:Shoddy)?ConstructedRamp/.test(nm);
    const stairM = /^ConstructedStair(UD|U|D)$/.exec(nm);
    const isFort = nm === "ConstructedFortification";
    if (!isFloor && !isRamp && !stairM && !isFort) return null;
    const m = consMaterial(base_mt, base_mi);
    if (!m) return null;
    const kind = isFloor ? "FLOOR" : isRamp ? "RAMP" : stairM ? stairM[1] : "FORT";
    return window.DwfTerrainVariant.constructedTerrainPlan(kind, nm, m, openMask);
  }
  function resolveConstructionFloor(t, gx, gy) {
    let openMask = 0;
    if ((t.ttname || "") === "ConstructedFortification") {
      const Adj = window.DwfAdjacency;
      if (Adj && typeof gx === "number" && typeof gy === "number") openMask = Adj.computeMask8(tileAt, gx, gy, Adj.isOpenNeighbor);
    }
    const plan = constructionFloorPlan(t.ttname || "", t.base_mt, t.base_mi, openMask);
    if (!plan) return null;
    const token = plan.token, palRow = plan.palRow;
    const entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
    if (!entry || !entry.sheet) return null;
    const sh = getSheet(entry.sheet);
    if (!sh || !sh.loaded || sh.failed) return null;
    if (!sheetCellHasVisiblePixel(entry.sheet, entry.col, entry.row)) return null;
    const base = { img: sh.img, col: entry.col, row: entry.row, tint: null, overlay: null, multiplyRgb: plan.multiplyRgb || null, multiplySheet: entry.sheet, sheet: entry.sheet };
    if (typeof palRow === "number") { base.palRow = palRow; base.paletteSheet = entry.sheet; }
    const mask = plan.mask;
    if (mask) {
      const rc = DESIG_TRACK_CELL[mask];
      const rs = rc && getSheet(DESIG_SHEET);
      if (rc && rs && rs.loaded && !rs.failed) base.overlay = { img: rs.img, col: rc[0], row: rc[1] };
    }
    return base;
  }

  function terrainSpritePalRow(t, token) {
    if (!t || (token !== "BOULDER" && token !== "FORTIFICATION" &&
      !/^PEBBLES_FLOOR_/.test(token || ""))) return null;
    const mat = t.mat || "";
    if (mat !== "STONE" && mat !== "MINERAL") return null;
    const m = consMaterial(t.base_mt, t.base_mi);
    return m && typeof m.palRow === "number" ? m.palRow : null;
  }

  function sandFloorPlan(t, ttname) {
    if (!t || t.base_mt !== 0 || !/^SoilFloor[1-4]$/.test(ttname || "")) return null;
    const ino = materialMap && materialMap.inorganic && materialMap.inorganic[t.base_mi];
    const m = ino && /^SAND_(TAN|YELLOW|WHITE|BLACK|RED)$/.exec(ino.id || "");
    if (!m) return null;
    const prefix = m[1] === "TAN" ? "SAND" : "SAND_" + m[1];
    const v = ((/([1-4])$/.exec(ttname) || [null, "1"])[1]);
    return { token: prefix + "_FLOOR_5", overlay: prefix + "_FLOOR_" + v };
  }

  function resolveSprite(t, gx, gy) {
    if (t.hidden) return null;
    const ttname = t.ttname;
    if (!ttname) return null;
    // A WALL's terrain art is the darkened base fill plus drawWallJoin's directional edge cell.
    // Never stamp a full-block wall token underneath: that is the evenly-tiled-solid-blocks defect.
    if ((t.shape || "") === "WALL") return null;
    const TV = window.DwfTerrainVariant;
    const sweepFloorToken = TV && typeof TV.smoothFloorToken === "function" ? TV.smoothFloorToken(t) : null;
    if (sweepFloorToken) {
      const sweepFloor = resolveCell(sweepFloorToken);
      if (sweepFloor) return sweepFloor;
    }
    const sandPlan = sandFloorPlan(t, ttname);
    if (sandPlan) {
      const base = resolveCell(sandPlan.token);
      if (base) { base.overlay = resolveCell(sandPlan.overlay); return base; }
    }
    const isGrassMat = !!(t.mat && t.mat.indexOf("GRASS_") === 0);
    // Grass amount is trample state, never an art selector: the tiletype picks the variant.
    if (t.grass && isGrassMat && (t.shape || "") === "FLOOR") {
      const speciesCell = grassFallbackCell(gx, gy, t.grass.id, ttname, false, t);
      // A present species id is authoritative: unresolvable -> no grass sprite, never the generic token.
      return speciesCell;
    }
    if (t.grass && !isGrassMat) {
      const under = /^(?:SoilFloor[1-4]|(?:Stone|Mineral|Lava|Feature)Pebbles([1-4]))$/.exec(ttname);
      if (under) {
        const cell = grassFallbackCell(gx, gy, t.grass.id, ttname, false, t);
        if (cell) {
          if (under[1]) {
            const pebbleToken = "PEBBLES_FLOOR_" + under[1];
            cell.overlay = resolveCell(pebbleToken);
            const pebbleRow = terrainSpritePalRow(t, pebbleToken);
            if (cell.overlay && typeof pebbleRow === "number") {
              cell.overlay.palRow = pebbleRow;
              const pe = TOKEN_CELL_OVERRIDE[pebbleToken] || (spriteMap && spriteMap[pebbleToken]);
              cell.overlay.paletteSheet = pe && pe.sheet;
            }
          }
          return cell;
        }
        // grass.png not loaded yet -- fall through to the normal ttname art for one frame.
      }
    }
    const consCell = resolveConstructionFloor(t, gx, gy);
    if (consCell) return consCell;
    const map = spriteMap && tiletypeTokenMap && tiletypeTokenMap[ttname];
    if (map && map.token) {
      const base = resolveCell(map.token);
      if (!base) return null;
      // BOULDER fans out to its 8 authored variant cells (see boulderVariant).
      if (map.token === "BOULDER") {
        const bv = boulderVariant(t, gx, gy);
        if (bv) { base.col = bv.col; base.row = bv.row; }
      }
      const terrainPalRow = terrainSpritePalRow(t, map.token);
      if (typeof terrainPalRow === "number") {
        base.palRow = terrainPalRow;
        const paletteEntry = TOKEN_CELL_OVERRIDE[map.token] || spriteMap[map.token];
        base.paletteSheet = paletteEntry && paletteEntry.sheet;
      }
      const overlay = map.overlay ? resolveCell(map.overlay) : null;
      base.tint = map.tint || null;
      base.overlay = overlay;   // null when absent/unloaded -- caller checks before blitting
      return base;
    }
    // Decide "legitimately uncovered" only once tiletypeTokenMap has loaded, or every tile flashes
    // the fallback during the window before the fetch resolves.
    if (tiletypeTokenMap && looksLikeGrassFloor(ttname)) {
      return grassFallbackCell(gx, gy, t.grass && t.grass.id, ttname, false, t);
    }
    return null;
  }

  function terrainSpriteRef(t, gx, gy) {
    if (!t) return null;
    let c = null;
    try { c = resolveSprite(t, gx, gy); } catch (_) { return null; }
    if (!c || !c.sheet || typeof c.col !== "number" || typeof c.row !== "number") return null;
    return { sheet: c.sheet, col: c.col, row: c.row };
  }

  // ---- renderer-neutral answers for dwf-world3d.js ----------------------------------------------

  function voxelColor(t) {
    if (!t) return null;
    const shape = t.shape || "NONE";
    const blocks = (shape === "WALL" || shape === "FORTIFICATION");
    if (!blocks) {
      const flow = t.flow || 0, liquid = t.liquid || "none";
      if (flow > 0 && (liquid === "water" || liquid === "magma")) return tileColor(t, false);
    } else if (!isTreeWallMat(t.mat || "") && !t.hidden) {
      const cr = wallMaterialRgb(t);
      if (cr) return darken(cr, WALL_DARKEN);
    }
    return tileColor(t, true);
  }

  // Wall side-face art for dwf-world3d.js: drawWallJoin's token and variant, minus its palette
  // swap and loaded-sheet requirement -- 3D owns a separate atlas.
  function wallSpriteRef(t, gx, gy, openMask, drawZ) {
    if (!t || (t.shape || "") !== "WALL") return null;
    const base = wallJoinBaseToken(t, openMask | 0);
    if (!base) return null;   // tree/mushroom trunk, fully buried, or unresolved
    const v = roughWallVariant(gx, gy, t, drawZ) + 1;
    const cands = [base + "_" + v, base + "_1", base];
    for (let i = 0; i < cands.length; i++) {
      const entry = TOKEN_CELL_OVERRIDE[cands[i]] || (spriteMap && spriteMap[cands[i]]);
      if (entry && entry.sheet && typeof entry.col === "number" && typeof entry.row === "number") {
        return { sheet: entry.sheet, col: entry.col, row: entry.row };
      }
    }
    return null;
  }

  function drawResolvedTerrainCell(resolved, px, py, cell) {
    if (!resolved) return false;
    if (typeof resolved.palRow === "number" && resolved.paletteSheet) {
      const swapped = paletteSwappedCell(resolved.paletteSheet, resolved.col, resolved.row, resolved.palRow);
      if (swapped) {
        const sm = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(swapped, 0, 0, 32, 32, px, py, cell, cell);
        ctx.imageSmoothingEnabled = sm;
        return true;
      }
    }
    ctx.drawImage(resolved.img, resolved.col * 32, resolved.row * 32, 32, 32, px, py, cell, cell);
    return true;
  }

  // ============================================================================ measured see-down fog ====
  const FOG_COLOR = [88, 138, 158];
  const FOG_ALPHA_INTERCEPT = 0.2464;
  const FOG_ALPHA_RATE = 0.1057;
  // QA-only kill switch: ?nofog=1 forces the see-down wash off for A/B parity scoring.
  const FOG_DISABLED = params.get("nofog") === "1";
  function buildingAlphaForZ(b, cameraZ) {
    const dz = (b && typeof b.z === "number" && typeof cameraZ === "number") ? b.z - cameraZ : 0;
    const seeDown = !!(b && b.sd) && dz < 0;
    if (dz !== 0 && !seeDown) return null;
    return seeDown ? Math.max(0, 1 - fogAlphaForDepth(-dz)) : 1;
  }

  function fogAlphaForDepth(depth) {
    if (FOG_DISABLED) return 0;
    const d = typeof depth === "number" ? depth : 0;
    if (d <= 0) return 0;
    return Math.max(0, Math.min(1, FOG_ALPHA_INTERCEPT + FOG_ALPHA_RATE * d));
  }

  function isOpenTile(t) {
    if (!t) return true;
    const s = t.shape || "", m = t.mat || "";
    return s === "EMPTY" || s === "NONE" || s === "RAMP_TOP" || m === "AIR";
  }

  // `camOz` is the frame's camera-origin z, so the tile's own world z is camOz - depth
  function drawTileComposite(t, px, py, cell, gx, gy, depth, alpha, camOz) {
    if (!t) return false;
    const a = (typeof alpha === "number") ? alpha : 1;
    const d = (typeof depth === "number") ? depth : 0;
    let saved = false;
    if (a < 1) { ctx.save(); ctx.globalAlpha = a; saved = true; }
    // DF composites a material-colour BASE first, then the sprite on top (sprites are transparent).
    const tt = (typeof t.tt === "number") ? t.tt : -1;
    const wantsHidden = wantsHiddenHatch(t, v1MapDims);
    const hiddenSprite = wantsHidden
      ? resolveHiddenSprite(t, (typeof camOz === "number") ? camOz - d : undefined) : null;
    const sprite = resolveSprite(t, gx, gy);
    const liquidSprite = resolveLiquidSprite(t);
    const Adj = window.DwfAdjacency;
    const wallOpenMask = (Adj && (t.shape || "") === "WALL" && typeof gx === "number" && typeof gy === "number")
      ? Adj.computeMask8(tileAt, gx, gy, Adj.isOpenNeighbor) : 0;
    const col = tileColor(t, !!liquidSprite);
    let drew = false;
    let grassBacked = false;
    if (col !== null && !t.hidden && !wantsHidden && !liquidSprite) {
      const wallBackToken = wallBackingToken(t, gx, gy, wallOpenMask);
      const wallBack = wallBackToken && spriteMap && spriteMap[wallBackToken];
      if (wallBack && wallBack.sheet && blitCell(wallBack.sheet, wallBack.col, wallBack.row, px, py, cell)) {
        grassBacked = true;
        drew = true;
      }
      const gb = !grassBacked && ((t.shape || "") !== "BOULDER" || sprite)
        ? groundBackingCell(t, gx, gy) : null;
      if (!grassBacked && gb && blitCell(gb.sheet, gb.col, gb.row, px, py, cell)) {
        if (gb.wash) {
          ctx.fillStyle = TINT_COLORS.grassSummer;
          ctx.fillRect(px, py, cell, cell);
        }
        grassBacked = true;
        drew = true;
      }
    }
    if (col !== null && !grassBacked) {
      ctx.fillStyle = rgbStr(col);
      ctx.fillRect(px, py, cell, cell);
      drew = true;
    } else if (wantsHidden && col === null && !grassBacked) {
      ctx.fillStyle = rgbStr(HIDDEN_COLOR);
      ctx.fillRect(px, py, cell, cell);
      drew = true;
    }
    // Native compositor order: background floor -> floor_flag fringe -> boulder/plant content.
    let edgeDrawn = false;
    if (drew && !liquidSprite && overlaysAllowed(t) && (t.shape || "") === "BOULDER") {
      drawEdgeOvergrowth(t, px, py, cell, gx, gy);
      edgeDrawn = true;
    }
    if (hiddenSprite) {
      ctx.drawImage(hiddenSprite.img, hiddenSprite.col * 32, hiddenSprite.row * 32, 32, 32, px, py, cell, cell);
      drew = true;
    } else if (liquidSprite) {
      if (sprite) {
        ctx.drawImage(sprite.img, sprite.col * 32, sprite.row * 32, 32, 32, px, py, cell, cell);
        const bedTint = sprite.tint && (TINT_COLORS[sprite.tint] || sprite.tint);
        if (bedTint) {
          ctx.fillStyle = bedTint;
          ctx.fillRect(px, py, cell, cell);
        }
        if (sprite.overlay) drawResolvedTerrainCell(sprite.overlay, px, py, cell);
      }
      // Native draws liquid over bed contaminants, so spatter belongs below the liquid depth cell.
      drawSpatter(t, px, py, cell, gx, gy);
      ctx.drawImage(liquidSprite.img, liquidSprite.col * 32, liquidSprite.row * 32, 32, 32, px, py, cell, cell);
      if (drawLiquidEdges(t, px, py, cell, gx, gy)) drew = true;
      drew = true;
    } else if (sprite) {
      let cdrew = false;
      if (typeof sprite.palRow === "number" && sprite.paletteSheet) {
        const sw = paletteSwappedCell(sprite.paletteSheet, sprite.col, sprite.row, sprite.palRow);
        if (sw) {
          const sm = ctx.imageSmoothingEnabled;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(sw, 0, 0, 32, 32, px, py, cell, cell);
          ctx.imageSmoothingEnabled = sm;
          cdrew = true;
        }
      }
      if (!cdrew && sprite.multiplyRgb && sprite.multiplySheet) {

        const mtc = multiplyTintedCell(sprite.multiplySheet, sprite.col, sprite.row, sprite.multiplyRgb);

        if (mtc) {

          const sm = ctx.imageSmoothingEnabled;

          ctx.imageSmoothingEnabled = false;

          ctx.drawImage(mtc, 0, 0, 32, 32, px, py, cell, cell);

          ctx.imageSmoothingEnabled = sm;

          cdrew = true;

        }

      }

      if (!cdrew) ctx.drawImage(sprite.img, sprite.col * 32, sprite.row * 32, 32, 32, px, py, cell, cell);
      const tintColor = sprite.tint && (TINT_COLORS[sprite.tint] || sprite.tint);
      if (tintColor) {
        ctx.fillStyle = tintColor;
        ctx.fillRect(px, py, cell, cell);
      }
      if (sprite.overlay) drawResolvedTerrainCell(sprite.overlay, px, py, cell);
      drew = true;
    } else if (col !== null) {
      const shape = t.shape || "";
      if (isStairOrRamp(shape) && cell >= 3) {
        ctx.strokeStyle = "rgb(220,220,220)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 0.5, py + 0.5);
        ctx.lineTo(px + cell - 0.5, py + cell - 0.5);
        ctx.moveTo(px + cell - 0.5, py + 0.5);
        ctx.lineTo(px + 0.5, py + cell - 0.5);
        ctx.stroke();
      }
    }
    if (!edgeDrawn && drew && !liquidSprite && overlaysAllowed(t))
      drawEdgeOvergrowth(t, px, py, cell, gx, gy);
    if (drew && overlaysAllowed(t)) {
      drawStockpileFloor(t, px, py, cell, gx, gy);
      drawShadowDecals(t, px, py, cell, gx, gy);
      if (!liquidSprite) drawSpatter(t, px, py, cell, gx, gy);
      drawItemSpatterLitter(t, px, py, cell, gx, gy);
      drawItem(t, px, py, cell, gx, gy);
      drawItemMark(t, px, py, cell);   // forbid/dump/melt glyph over a marked ground item
      drawVermin(t, px, py, cell, gx, gy);  // vermin/colony sprite (creatures_map race cell)
      drawPlant(t, px, py, cell);
      drawTree(t, px, py, cell, gx, gy);
      drawWallJoin(t, px, py, cell, gx, gy, wallOpenMask,
        (typeof camOz === "number") ? camOz - d : undefined);
      drawEngraving(t, px, py, cell, gx, gy);
      // The rope-and-post border is a BOUNDARY: drawn last so it stays above contents and engraving.
      drawStockpileRope(t, px, py, cell, gx, gy);
    }
    if (drew && d > 0) {
      const fa = fogAlphaForDepth(d);
      if (fa > 0) {
        ctx.fillStyle = `rgba(${FOG_COLOR[0]},${FOG_COLOR[1]},${FOG_COLOR[2]},${fa})`;
        ctx.fillRect(px, py, cell, cell);
      }
    }
    if (saved) ctx.restore();
    return drew;
  }

  function renderComposite(byDz, maxUp, maxDown, cam, gw, gh, cell, n, iStart, iEnd, camOz) {
    // The keep-warm band may bound the loop to a row range [iStart, iEnd); a full paint passes 0..n.
    const _s = (iStart | 0), _e = (iEnd == null ? n : (iEnd | 0));
    for (let i = _s; i < _e; i++) {
      const gx = i % gw, gy = (i - gx) / gw;
      const px = gx * cell, py = gy * cell;
      try {
        const ct = cam[i];
        // (1) see-below: descend to the first solid/liquid tile and fog it by depth. Drawn BEFORE the
        // camera plane so a solid camera tile correctly occludes it.
        if (ct && !ct.hidden && isOpenTile(ct)) {
          for (let d = 1; d <= maxDown; d++) {
            const arr = byDz[-d];
            if (!arr) continue;               // culled/empty layer: keep descending
            const bt = arr[i];
            if (!bt) continue;
            if (isOpenTile(bt) && !(bt.flow > 0)) continue;   // still open air: go deeper
            drawTileComposite(bt, px, py, cell, gx, gy, d, 1, camOz);
            break;                            // stop at the first solid/liquid we can see
          }
        }
        if (ct) drawTileComposite(ct, px, py, cell, gx, gy, 0, 1, camOz);
        // (3) see-above: nothing is drawn -- DF renders no above-camera translucent canopy.
      } catch (_) { /* per-cell guarded: one bad cell never blanks the map */ }
    }
  }

  // ---- wire:3 extra layer maps (items/plants/trees/buildings/creatures) ------------
  let itemMap = null;       // v2: { bytype:{TYPE:{sheet,col,row}}, bytoken:{TOKEN:{...}},
                            //       matvariants:{Base:{WOOD|STONE|METAL|GLASS:{...}}},
                            //       web:{harmless:[4 cells],thick:[4 cells]}, _missing, _v:2 }
  let plantMap = null;      // { id: {SHRUB|SAPLING:{...}}, _default_shrub, _default_sapling }
  let treeMap = null;       // { species: {PART:{...}}, _default:{PART:{...}} }
  let buildingMap = null;   // { "Type:Subtype"|TOKEN : {sheet,w,h,cells}|{sheet,col,row}, _default }
  let creaturesMap = null;  // { cell, races: { RACE: {sheet,col,row}|{layered,baked} } }
  let materialMap = null;
  let spatterMap = null;    // { families:{FAM:{sheet,cells:{SHAPE:{col,row}}}},
                            //          amount_thresholds_default:[{max,shape}], blood_families:[...],
                            //          growth_class_family:{"0".."4":FAM}, builtin_material_hints:{...} }
  let overlayMap = null;    // { designation_priority:{"1".."7":{sheet,col,row}},
                            //          designation_item:{DESIGNATION_ITEM_*:{sheet,col,row}}, ... }

  let itemDefTokens = null; // Map<"TYPE:subtype", token>
  let itemTypeNames = null; // Map<number, "TYPE">
  function applyItemTypeMeta(list) {
    try {
      const m = new Map();
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (Array.isArray(r) && r.length >= 2 && typeof r[0] === "number" && r[1]) m.set(r[0], r[1]);
        }
      }
      itemTypeNames = m;
      // The cache/worker ingest still needs the same table; one fetch, both consumers.
      if (window.DwfCache && typeof DwfCache.setItemTypeMeta === "function") {
        DwfCache.setItemTypeMeta(list);
      }
      draw();
    } catch (_) { /* table stays whatever it was -- projectiles just keep the marker */ }
  }
  // Index IS the wire's subcat code: this array's order must stay DFHack's ITEMDEF_VECTORS order,
  // or every itemdef subtype resolves to the wrong item type.
  const ITEMDEF_SUBCAT_TYPE = ["WEAPON", "TRAPCOMP", "TOY", "TOOL", "INSTRUMENT", "ARMOR", "AMMO",
    "SIEGEAMMO", "GLOVES", "SHOES", "SHIELD", "HELM", "PANTS", "FOOD"];
  const INSTRUMENT_ART_TOKEN = [
    "ITEM_INSTRUMENT_KEYBOARD_BUILDING", "ITEM_INSTRUMENT_KEYBOARD_HANDHELD",
    "ITEM_INSTRUMENT_STRINGED_BUILDING", "ITEM_INSTRUMENT_STRINGED_HANDHELD",
    "ITEM_INSTRUMENT_WIND_BUILDING", "ITEM_INSTRUMENT_WIND_HANDHELD",
    "ITEM_INSTRUMENT_PERCUSSION_BUILDING", "ITEM_INSTRUMENT_PERCUSSION_HANDHELD",
  ];
  function handleItemDefDictV1(subcats) {
    try {
      const m = new Map();
      if (Array.isArray(subcats)) {
        for (let i = 0; i < subcats.length; i++) {
          const sc = subcats[i];
          const typeName = ITEMDEF_SUBCAT_TYPE[sc.subcat];
          if (!typeName || !Array.isArray(sc.entries)) continue;
          for (let j = 0; j < sc.entries.length; j++) {
            const e = sc.entries[j];
            if (e && typeof e.id === "number" && e.token) m.set(typeName + ":" + e.id, e.token);
          }
        }
      }
      itemDefTokens = m;
      draw();
    } catch (_) { /* dict stays whatever it was -- resolution just skips the bytoken step */ }
  }

  // A 404 here is transient (the host bakes only once the unit renders): retry, never cache the miss.
  const UNIT_SPRITE_RETRY_MS = 3000;
  const unitSpriteImgs = Object.create(null); // hash -> {img, loaded, failed, failedAt}
  let unitSpriteRetryTimer = null;
  function scheduleUnitSpriteRetry() {
    if (unitSpriteRetryTimer !== null) return;
    unitSpriteRetryTimer = setTimeout(() => { unitSpriteRetryTimer = null; draw(); }, UNIT_SPRITE_RETRY_MS);
  }
  function getUnitSprite(hash) {
    let e = unitSpriteImgs[hash];
    if (e && e.failed && (Date.now() - e.failedAt) >= UNIT_SPRITE_RETRY_MS) {
      delete unitSpriteImgs[hash]; // drop the negatively-cached miss; the old Image is abandoned
      e = null;
    }
    if (!e) {
      e = unitSpriteImgs[hash] = { img: new Image(), loaded: false, failed: false, failedAt: 0 };
      e.img.onload = () => { e.loaded = true; draw(); };
      e.img.onerror = () => { e.failed = true; e.failedAt = Date.now(); scheduleUnitSpriteRetry(); };
      e.img.src = "/unit-sprite/" + hash + ".png";
    }
    return e;
  }
  function resolveUnitTier(u, races) {
    if (u.ah && typeof u.sw === "number" && typeof u.sh === "number") {
      const usp = getUnitSprite(u.ah);
      if (usp.loaded && !usp.failed) return { tier: 1, sprite: usp };
      // tier 2 (fetch in flight / 404): fall through, but the fetch was already kicked off.
    }
    const rec = races && u.rt && races[u.rt];
    if (rec && rec.sheet && typeof rec.col === "number") return { tier: 3, rec: rec };
    if (rec && (rec.layered || rec.baked)) return { tier: 4, rec: rec };
    return { tier: 5 };
  }

  function unitSpriteRefs(u) {
    if (!u) return [];
    const out = [];
    if (u.ah && typeof u.sw === "number" && typeof u.sh === "number")
      out.push({ dynamicKey: u.ah, url: "/unit-sprite/" + u.ah + ".png" });
    const rec = creaturesMap && creaturesMap.races && u.rt && creaturesMap.races[u.rt];
    if (rec && rec.sheet && typeof rec.col === "number" && typeof rec.row === "number")
      out.push({ sheet: rec.sheet, col: rec.col, row: rec.row });
    else if (rec && (rec.layered || rec.baked)) {
      const name = u.ct === "FEMALE" ? "dwarf_female.png" : (rec.baked || "dwarf.png");
      out.push({ dynamicKey: name, url: "/" + name });
    }
    return out;
  }

  const UnitStatusLaw = window.DwfUnitStatus;
  const unitStatusIconForBitsLaw = UnitStatusLaw && UnitStatusLaw.unitStatusIconForBits;
  const nativeBubblePhaseLaw = UnitStatusLaw && UnitStatusLaw.nativeBubblePhase;
  const physicalStatusIconForBitsLaw = UnitStatusLaw && UnitStatusLaw.physicalStatusIconForBits;
  const ordinaryStatusIconForBitsLaw = UnitStatusLaw && UnitStatusLaw.ordinaryStatusIconForBits;
  const unitStatusIconNowLaw = UnitStatusLaw && UnitStatusLaw.unitStatusIconNow;
  const NATIVE_BUBBLE_PERIOD_MS = UnitStatusLaw && UnitStatusLaw.NATIVE_BUBBLE_PERIOD_MS;
  const NATIVE_BUBBLE_ID_STRIDE = UnitStatusLaw && UnitStatusLaw.NATIVE_BUBBLE_ID_STRIDE;
  const NATIVE_BUBBLE_ORDINARY_MS = UnitStatusLaw && UnitStatusLaw.NATIVE_BUBBLE_ORDINARY_MS;
  function unitStatusIconForBitsTiles(st, st2) { return unitStatusIconForBitsLaw(st, st2); }
  function nativeBubblePhaseTiles(unitId, nowMs) { return nativeBubblePhaseLaw(unitId, nowMs); }
  function physicalStatusIconForBitsTiles(st) { return physicalStatusIconForBitsLaw(st); }
  function ordinaryStatusIconForBitsTiles(st, st2) { return ordinaryStatusIconForBitsLaw(st, st2); }
  function unitStatusIconNowTiles(st, st2, unitId, nowMs) {
    return unitStatusIconNowLaw(st, st2, unitId, nowMs);
  }
  const unitStatusIconForBits = unitStatusIconForBitsTiles;
  const nativeBubblePhase = nativeBubblePhaseTiles;
  const physicalStatusIconForBits = physicalStatusIconForBitsTiles;
  const ordinaryStatusIconForBits = ordinaryStatusIconForBitsTiles;
  const unitStatusIconNow = unitStatusIconNowTiles;

  // ---- the overhead map flash ----
  const FLASH_CYAN_RGB = [20, 255, 233];
  function unitMapFlash(st, nowMs) {
    st = st | 0;
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    let period = 0, onWindow = 0, rgb = null;
    if ((st & USTAT_SLEEPING) && (st & USTAT_UNCONSCIOUS)) { period = 1000; onWindow = 500; }
    else if (st & USTAT_UNCONSCIOUS) { period = 500; onWindow = 100; }
    else if (st & USTAT_PARALYZED) { period = 500; onWindow = 100; rgb = FLASH_CYAN_RGB; }
    else if (st & USTAT_NAUSEA) { period = 500; onWindow = 100; }
    else return null;
    let t = Math.floor(nowMs) % period;
    if (t < 0) t += period;
    return { on: t < onWindow, rgb };
  }
  function unitStatusVisibilitySignature(units, nowMs) {
    if (!Array.isArray(units)) return 0;
    let h = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u) continue;
      const icon = unitStatusIconNow(u.st, u.st2, u.id, nowMs);
      if (icon) h = (Math.imul(h, 33) + (((u.id | 0) * 41 + icon.row + 1) | 0)) | 0;
    }
    return h;
  }
  // The shared designation/flow 800ms beat. Despite the name it does NOT gate unit-status bubbles.
  function unitStatusBlinkVisible(nowMs) {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) nowMs = Date.now();
    return (Math.floor(nowMs / UNIT_STATUS_BLINK_MS) % 2) === 0;
  }
  const DESIG_ACTIVE_BLINK_MS = UNIT_STATUS_BLINK_MS / 2;
  function isBlinkingDesignationJob(djobKind) {
    return djobKind >= 1 && djobKind <= 13;
  }
  function activeBlinkVisible(nowMs) {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) nowMs = Date.now();
    return (Math.floor(nowMs / DESIG_ACTIVE_BLINK_MS) % 2) === 0;
  }
  function designationBlinkState(djobKind, hasWorker, unitOnTile) {
    if (!isBlinkingDesignationJob(djobKind) || !hasWorker) return 0;
    return unitOnTile ? 2 : 1;
  }
  function designationGlyphVisible(djobKind, nowMs, hasWorker, unitOnTile) {
    const s = designationBlinkState(djobKind, hasWorker, unitOnTile);
    if (s === 2) return activeBlinkVisible(nowMs);
    if (s === 1) return unitStatusBlinkVisible(nowMs);
    return true;
  }
  function workedTileUnitVisible(nowMs) {
    return !activeBlinkVisible(nowMs);
  }
  function hasBlinkingDesignationJob(djobs) {
    if (!Array.isArray(djobs)) return false;
    for (let i = 0; i < djobs.length; i++)
      if (djobs[i] && djobs[i].w && isBlinkingDesignationJob(djobs[i].k)) return true;
    return false;
  }
  function hasDrawableUnitStatus(units) {
    if (!Array.isArray(units)) return false;
    for (let i = 0; i < units.length; i++) if (units[i] && unitStatusIconForBits(units[i].st, units[i].st2)) return true;
    return false;
  }
  function unitStatusDrawPlan(u, ox, oy, cell, nowMs, alpha) {
    const icon = unitStatusIconNow(u && u.st, u && u.st2, u && u.id, nowMs);
    if (!icon) return null;
    return {
      sheet: icon.sheet, col: icon.col, row: icon.row, token: icon.token,
      dx: (u.x - ox) * cell, dy: (u.y - oy - 1) * cell, dw: cell, dh: cell,
      alpha: (typeof alpha === "number") ? alpha : 1,
    };
  }

  // Baked civ-race sprites are served at the web ROOT (/dwarf.png), not via /sprites/img.
  const bakedImgs = Object.create(null);
  function getBaked(name) {
    let b = bakedImgs[name];
    if (!b) {
      b = bakedImgs[name] = { img: new Image(), loaded: false, failed: false };
      b.img.onload = () => { b.loaded = true; draw(); };
      b.img.onerror = () => { b.failed = true; };
      b.img.src = "/" + name;
    }
    return b;
  }

  // ---- window.DwfJson: shared, memoised loader for the STATIC boot-time map JSON -----------
  const jsonMemo = new Map();
  function fetchJsonOnce(url) {
    let p = jsonMemo.get(url);
    if (p) return p;
    const forget = () => { if (jsonMemo.get(url) === p) jsonMemo.delete(url); };
    p = fetch(url, { cache: "no-cache" })
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((data) => {
        if (data && typeof data === "object") return data;
        forget();   // a miss/bad body is NOT memoised
        return null;
      })
      .catch(() => { forget(); return null; });
    jsonMemo.set(url, p);
    return p;
  }
  try { window.DwfJson = { get: fetchJsonOnce }; } catch (_) { /* non-browser context */ }

  async function loadJsonMap(url, assign) {
    const data = await fetchJsonOnce(url);
    if (data) { assign(data); draw(); }
  }

  // df::workshop_type / df::furnace_type enum order: the wire gives subtype as an int while
  // building_map.json is keyed by "Type:Subtype" aliases, so translate the int -> name.
  const WORKSHOP_SUBTYPE = [
    "Carpenters", "Farmers", "Masons", "Craftsdwarfs", "Jewelers", "MetalsmithsForge",
    "MagmaForge", "Bowyers", "Mechanics", "Siege", "Butchers", "Leatherworks", "Tanners",
    "Clothiers", "Fishery", "Still", "Loom", "Quern", "Kennels", "Kitchen", "Ashery",
    "Dyers", "Millstone", "Custom", "Tool",
  ];
  const FURNACE_SUBTYPE = [
    "WoodFurnace", "Smelter", "GlassFurnace", "Kiln", "MagmaSmelter",
    "MagmaGlassFurnace", "MagmaKiln", "Custom",
  ];


  // ---- palette swap -----------------------------------------------------------------------
  let paletteLookup = null;
  const paletteCellCache = new Map();
  const multiplyCellCache = new Map();
  function buildPaletteLookup() {
    paletteLookup = null;
    paletteCellCache.clear();
    gemVariantCache.clear();   // the gem composite bakes the palette in, so it follows the palette
    matInorganicById = null;  // id-join cache follows the materialMap instance
    const def = materialMap && (materialMap.default_row ||
      (materialMap.palette && materialMap.palette.rows && materialMap.palette.rows[0]));
    if (!def || !def.length) return;
    const m = new Map();
    for (let k = 0; k < def.length; k++) {
      const c = def[k];
      const key = c && c.length >= 3
        ? (((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255)) : null;
      if (key !== null && !m.has(key)) m.set(key, k);
    }
    paletteLookup = m;
    multiplyCellCache.clear();
  }
  function sheetCellGeometry(sheetName) {
    const g = itemMap && itemMap.sheet_geometry && itemMap.sheet_geometry[sheetName];
    return {
      cellW: Math.max(1, Math.floor((g && (g.cell_w || g.cellW)) || 32)),
      cellH: Math.max(1, Math.floor((g && (g.cell_h || g.cellH)) || 32)),
    };
  }
  function remapPaletteData(data, lookup, target) {
    const GV = window.DwfGemVariant;
    if (GV) return GV.remapPalette(data, lookup, target);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const k = lookup.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (k !== undefined) {
        const t = target[k];
        if (t) { data[i] = t[0]; data[i + 1] = t[1]; data[i + 2] = t[2]; }
      }
    }
    return data;
  }

  // A palette-swapped or gem-composited cell blits from an OFFSCREEN CANVAS, which has no `.src` and
  // a (0,0,32,32) source rect, so the cell identity must ride on the canvas for the sprite recorder.
  function stampCellProvenance(canvas, sheetName, col, row, colour) {
    if (!canvas) return canvas;
    canvas.__dfcName = sheetName;
    canvas.__dfcCol = col;
    canvas.__dfcRow = row;
    if (colour && typeof colour.paletteRow === "number") canvas.__dfcPaletteRow = colour.paletteRow;
    if (colour && Array.isArray(colour.tintRgb)) canvas.__dfcTintRgb = colour.tintRgb.slice(0, 3);
    return canvas;
  }

  function paletteSwappedCell(sheetName, col, row, palRow) {
    if (!paletteLookup || !materialMap || !materialMap.palette || !materialMap.palette.rows) return null;
    const target = materialMap.palette.rows[palRow];
    if (!target || !target.length) return null;
    const key = sheetName + ":" + col + ":" + row + ":" + palRow;
    if (paletteCellCache.has(key)) return paletteCellCache.get(key);
    const s = getSheet(sheetName);
    if (!s || !s.loaded || s.failed) return null; // not cached: retried next frame once loaded
    let out = null;
    try {
      const oc = document.createElement("canvas");
      oc.width = 32; oc.height = 32;
      const octx = oc.getContext("2d");
      octx.imageSmoothingEnabled = false;
      const geom = sheetCellGeometry(sheetName);
      octx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, 0, 0, 32, 32);
      const id = octx.getImageData(0, 0, 32, 32);
      const d = id.data;
      remapPaletteData(d, paletteLookup, target);
      octx.putImageData(id, 0, 0);
      out = stampCellProvenance(oc, sheetName, col, row, { paletteRow: palRow });
    } catch (_) { out = null; } // tainted canvas / decode race -> fall back to untinted blit
    paletteCellCache.set(key, out);
    return out;
  }

  // ---- cut-gem runtime composite ---------------------------------------------------
  const gemVariantCache = new Map();
  function gemVariantCell(sheetName, col, row, palRow, variant) {
    const GV = window.DwfGemVariant;
    if (!GV || typeof variant !== "number") return null;
    const key = sheetName + ":" + col + ":" + row + ":" + palRow + ":v" + variant;
    if (gemVariantCache.has(key)) return gemVariantCache.get(key);
    const s = getSheet(sheetName);
    if (!s || !s.loaded || s.failed) return null;  // not cached: retried next frame once loaded
    let out = null;
    try {
      const geom = sheetCellGeometry(sheetName);
      const dim = GV.destSize(geom.cellW, geom.cellH);
      const oc = document.createElement("canvas");
      oc.width = dim.w; oc.height = dim.h;
      const octx = oc.getContext("2d");
      octx.imageSmoothingEnabled = false;
      const rects = GV.stamps(variant, geom.cellW, geom.cellH);
      for (const r of rects)
        octx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH,
          r.x, r.y, r.w, r.h);
      if (typeof palRow === "number" && paletteLookup && materialMap
          && materialMap.palette && materialMap.palette.rows) {
        const target = materialMap.palette.rows[palRow];
        if (target && target.length) {
          const id = octx.getImageData(0, 0, dim.w, dim.h);
          GV.remapPalette(id.data, paletteLookup, target);
          octx.putImageData(id, 0, 0);
        }
      }
      out = stampCellProvenance(oc, sheetName, col, row,
        typeof palRow === "number" ? { paletteRow: palRow } : null);
    } catch (_) { out = null; }  // tainted canvas / decode race -> caller blits the plain cell
    gemVariantCache.set(key, out);
    return out;
  }

  function multiplyTintedCell(sheetName, col, row, rgb) {


    if (!Array.isArray(rgb) || rgb.length < 3) return null;


    const key = sheetName + ":" + col + ":" + row + ":" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0);


    if (multiplyCellCache.has(key)) return multiplyCellCache.get(key);


    const s = getSheet(sheetName);


    if (!s || !s.loaded || s.failed) return null;


    let out = null;


    try {


      const oc = document.createElement("canvas");


      oc.width = 32; oc.height = 32;


      const octx = oc.getContext("2d");


      octx.imageSmoothingEnabled = false;


      const geom = sheetCellGeometry(sheetName);


      octx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, 0, 0, 32, 32);


      octx.globalCompositeOperation = "multiply";


      octx.fillStyle = "rgb(" + (rgb[0] | 0) + "," + (rgb[1] | 0) + "," + (rgb[2] | 0) + ")";


      octx.fillRect(0, 0, 32, 32);


      octx.globalCompositeOperation = "destination-in";


      octx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, 0, 0, 32, 32);


      out = stampCellProvenance(oc, sheetName, col, row, { tintRgb: rgb });


    } catch (_) { out = null; }


    multiplyCellCache.set(key, out);


    return out;


  }

  function unitGhostPlan(u) {
    if (!u || u.gh !== 1) return null;
    return { rgb: GHOST_TINT_RGB, alpha: GHOST_ALPHA, css: GHOST_TINT_CSS };
  }

  let ghostBuf = null, ghostBufCtx = null;
  function blitGhostTinted(img, sx, sy, sSW, sSH, dx, dy, dw, dh) {
    const w = Math.max(1, Math.round(dw)), h = Math.max(1, Math.round(dh));
    try {
      if (!ghostBuf) { ghostBuf = document.createElement("canvas"); ghostBufCtx = ghostBuf.getContext("2d"); }
      if (ghostBuf.width !== w || ghostBuf.height !== h) { ghostBuf.width = w; ghostBuf.height = h; }
      const octx = ghostBufCtx;
      octx.imageSmoothingEnabled = false;
      octx.globalCompositeOperation = "source-over";
      octx.clearRect(0, 0, w, h);
      octx.drawImage(img, sx, sy, sSW, sSH, 0, 0, w, h);   // 1) unit sprite
      octx.globalCompositeOperation = "multiply";
      octx.fillStyle = GHOST_TINT_CSS;
      octx.fillRect(0, 0, w, h);                            // 2) green multiply (also paints transparent)
      octx.globalCompositeOperation = "destination-in";
      octx.drawImage(img, sx, sy, sSW, sSH, 0, 0, w, h);   // 3) re-clip to the sprite's alpha
      octx.globalCompositeOperation = "source-over";
      ctx.drawImage(ghostBuf, 0, 0, w, h, dx, dy, dw, dh); // 4) blit (honors ctx.globalAlpha)
    } catch (_) {
      ctx.drawImage(img, sx, sy, sSW, sSH, dx, dy, dw, dh);
    }
  }



  // `nearest` point-samples at the UNROUNDED destination so item sprites match GL's NEAREST draw.
  function blitCell(sheetName, col, row, px, py, cell, palRow, nearest, gemVariant) {
    if (!sheetName || typeof col !== "number" || typeof row !== "number") return false;
    if (typeof gemVariant === "number") {
      const gv = gemVariantCell(sheetName, col, row, palRow, gemVariant);
      if (gv) {
        const sm = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(gv, 0, 0, gv.width, gv.height, px, py, cell, cell);
        ctx.imageSmoothingEnabled = sm;
        return true;
      }
      // composite not ready -> fall through; a plain cell is wrong art but better than a hole.
    }
    if (typeof palRow === "number") {
      const swapped = paletteSwappedCell(sheetName, col, row, palRow);
      if (swapped) {
        const sm = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(swapped, 0, 0, 32, 32, px, py, cell, cell);
        ctx.imageSmoothingEnabled = sm;
        return true;
      }
      // swap not ready/available -> fall through to a plain blit (still NEAREST for items).
    }
    const s = getSheet(sheetName);
    if (!s || !s.loaded || s.failed) return false;
    if (!sheetCellHasVisiblePixel(sheetName, col, row)) return false;
    if (nearest || typeof palRow === "number") {
      const sm2 = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      const geom = sheetCellGeometry(sheetName);
      ctx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, px, py, cell, cell);
      ctx.imageSmoothingEnabled = sm2;
      return true;
    }
    const geom = sheetCellGeometry(sheetName);
    ctx.drawImage(s.img, col * geom.cellW, row * geom.cellH, geom.cellW, geom.cellH, px, py, cell, cell);
    return true;
  }

  // ---- small stable integer hash (position/material -> a repeatable 0..N-1 pick) ----------
  function hashInt(a, b) {
    let h = (a | 0) * 2654435761 ^ (b | 0) * 2246822519;
    h = (h ^ (h >>> 15)) >>> 0;
    return h;
  }

  // ---- item sprite resolution (token -> cell, matvariant, tint, fallback) ----------------
  const ITEM_MATVARIANT_BASE = {
    DOOR: "Door", BED: "Bed", TABLE: "Table", CHAIR: "Chair", CABINET: "Cabinet",
    BOX: "Box", HATCH_COVER: "HatchCover", GRATE: "Grate",
  };
  function matFamilyFor(mat_type) {
    if (mat_type === 3 || mat_type === 4 || mat_type === 5) return "GLASS";
    if (mat_type >= 419) return "WOOD";
    if (mat_type === 0) return "STONE";
    return null;
  }
  function itemSpatterPlan(arr, map) {
    return window.DwfTerrainVariant.itemSpatterLitter(arr, map);
  }
  const ITEM_TINT_BY_FAMILY = {
    WOOD: "rgba(140,100,60,0.28)",
    GLASS: "rgba(180,220,220,0.20)",
    // STONE: deliberately no tint -- a specific stone hue cannot be guessed without a raws table.
  };
  function lookupCurrentTile(gx, gy) {
    try {
      if (!latest || !latest.tiles || !latest.origin) return null;
      const x = gx - latest.origin.x, y = gy - latest.origin.y;
      if (x < 0 || y < 0 || x >= latest.width || y >= latest.height) return null;
      return latest.tiles[y * latest.width + x] || null;
    } catch (_) { return null; }
  }

  function drawLiquidEdges(t, px, py, cell, gx, gy) {
    try {
      const Adj = window.DwfAdjacency;
      const tokens = liquidEdgeTokens(t, gx, gy, lookupCurrentTile, Adj);
      let drew = false;
      for (let i = 0; i < tokens.length; i++) {
        const e = resolveCell(tokens[i]);
        if (e && e.sheet && blitCell(e.sheet, e.col, e.row, px, py, cell)) drew = true;
      }
      return drew;
    } catch (_) { return false; }
  }

  function drawItemTint(mat_type, px, py, cell) {
    const fam = matFamilyFor(mat_type);
    const tint = fam && ITEM_TINT_BY_FAMILY[fam];
    if (!tint) return;
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = tint;
    ctx.fillRect(px, py, cell, cell);
    ctx.restore();
  }
  // An unknown material token yields null, never a wrong-index guess; every helper is null-safe.
  let matInorganicById = null; // lazy {ID: entry} over materialMap.inorganic
  function matInorganic(it) {
    if (!materialMap || !materialMap.inorganic || !it || it.mat_type !== 0) return null;
    if (it.identKind === 3 && it.ident) {
      if (!matInorganicById) {
        matInorganicById = Object.create(null);
        for (let j = 0; j < materialMap.inorganic.length; j++) {
          const e2 = materialMap.inorganic[j];
          if (e2 && e2.id) matInorganicById[e2.id] = e2;
        }
      }
      return matInorganicById[it.ident] || null;
    }
    const i = it.mat_index;
    if (typeof i !== "number" || i < 0 || i >= materialMap.inorganic.length) return null;
    return materialMap.inorganic[i] || null;
  }
  // matvariants carries only WOOD/STONE/METAL/GLASS, so SOIL/GEM inorganics collapse to STONE.
  function matFamilyForItem(it) {
    const mt = it.mat_type;
    if (mt === 3 || mt === 4 || mt === 5) return "GLASS";
    if (mt === 0) {
      const e = matInorganic(it);
      if (e && e.family) return (e.family === "METAL") ? "METAL" : (e.family === "GLASS" ? "GLASS" : "STONE");
      return "STONE";
    }
    if (mt >= 419) return "WOOD";
    return null;
  }
  function matPalRowFor(it) {
    if (!materialMap) return null;
    const mt = it.mat_type;
    if (mt === 0) { const e = matInorganic(it); return e && typeof e.row === "number" ? e.row : null; }
    if (mt === 3 || mt === 4 || mt === 5) {
      const b = materialMap.builtin && materialMap.builtin[String(mt)];
      return b && typeof b.row === "number" ? b.row : null;
    }
    if (mt >= 419 && materialMap.plant) {
      const ids = materialMap.plant_ids;
      const id = (it.identKind === 1 && it.ident) ? it.ident
        : (ids && typeof it.mat_index === "number" ? ids[it.mat_index] : null);
      const p = id && materialMap.plant[id];
      if (p) {
        // DF encodes local plant material N as mat_type 419+N.
        // Logs deliberately use the WOOD colour; drinks, leaves, fruit and seeds use their local material.
        if (it.type === "WOOD" && typeof p.WOOD === "number") return p.WOOD;
        const local = Object.keys(p)[mt - 419];
        if (local && typeof p[local] === "number") return p[local];
      }
    }
    return null;
  }
  const GLASS_ROUGH_KEY = { 3: "GLASS_GREEN", 4: "GLASS_CLEAR", 5: "GLASS_CRYSTAL" };
  const CRAFT_ITEM_TOKEN_BASE = {
    FIGURINE: "ITEM_FIGURINE", AMULET: "ITEM_AMULET", SCEPTER: "ITEM_SCEPTER",
    CROWN: "ITEM_CROWN", RING: "ITEM_RING", EARRING: "ITEM_EARRING", BRACELET: "ITEM_BRACELET",
  };
  function pickRoughTier(value) {
    const tiers = itemMap && itemMap.rough_gem_tiers;
    if (!tiers || !tiers.length) return null;
    let chosen = tiers[0].cell;
    for (let i = 0; i < tiers.length; i++) if (value >= tiers[i].min_value) chosen = tiers[i].cell;
    return chosen || null;
  }
  function hatchCoverMaterialCell(it) {
    const map = itemMap && itemMap.hatch_cover_bymat;
    if (!map || !it) return null;
    if (it.mat_type === 0) {
      if (it.identKind === 3 && it.ident && map[it.ident]) return map[it.ident];
      const e = matInorganic(it);
      if (e && e.id && map[e.id]) return map[e.id];
    }
    if (it.mat_type >= 419 && it.identKind === 1 && it.ident) {
      return map["PLANT_MAT:" + it.ident + ":WOOD"] || null;
    }
    return null;
  }
  function materialItemCell(it, type) {
    if (!itemMap) return null;
    const craftBase = CRAFT_ITEM_TOKEN_BASE[type];
    if (craftBase && itemMap.bytoken) {
      const craftMaterial = matFamilyForItem(it) === "WOOD" ? "WOOD" : "METAL";
      const craftCell = itemMap.bytoken[craftBase + "_" + craftMaterial];
      if (craftCell) return craftCell;
    }
    if (itemMap.bytoken && (type === "BARREL" || type === "BUCKET" || type === "CAGE")) {
      const fam = matFamilyForItem(it);
      let token = null;
      if (type === "BARREL") token = fam === "METAL" ? "ITEM_BARREL_METAL_EMPTY" : "ITEM_BARREL_WOOD_EMPTY";
      else if (type === "BUCKET") token = fam === "METAL" ? "ITEM_BUCKET_METAL" : "ITEM_BUCKET_WOOD";
      else if (type === "CAGE")
        token = fam === "GLASS" ? "ITEM_CAGE_GLASS" : (fam === "METAL" ? "ITEM_CAGE_METAL" : "ITEM_CAGE_WOOD");
      if (token && itemMap.bytoken[token]) return itemMap.bytoken[token];
    }
    if (type === "BAR" && itemMap.bar_bymat) {
      let key = null;
      if (it.mat_type === 7) key = it.mat_index === 1 ? "COAL:CHARCOAL" : "COAL:COKE";
      else if (it.mat_type === 8) key = "POTASH";
      else if (it.mat_type === 10) key = "PEARLASH";
      if (key && itemMap.bar_bymat[key]) return itemMap.bar_bymat[key];
    }
    if (type === "HATCH_COVER") {
      const hc = hatchCoverMaterialCell(it);
      if (hc) return hc;
    }
    // Native keys cut-gem art on the CUT alone -- the material contributes only the palette row -- so this
    // branch must stay MATERIAL-BLIND, or stone/shell/glass cuts fall through to the generic bytype.GEM cell.
    if (type === "GEM" || type === "SMALLGEM") {
      // shape indexes material_map's shape_tokens -> item_map.gem_shapes per-cut cells.
      if (typeof it.shape === "number" && it.shape >= 0 &&
          materialMap && materialMap.shape_tokens && itemMap.gem_shapes) {
        const stok = materialMap.shape_tokens[it.shape];
        const gsh = stok && itemMap.gem_shapes[stok];
        const cut = gsh && ((type === "GEM") ? gsh.large : gsh.small);
        if (cut) return cut;
      }
      const gc = (type === "GEM") ? itemMap.gem_default : itemMap.smallgem_default;
      if (gc) return gc;
    }
    if (it.mat_type === 0) {
      const e = matInorganic(it);
      if (e) {
        if (type === "BOULDER" && itemMap.boulder_bymat && itemMap.boulder_bymat[e.id]) return itemMap.boulder_bymat[e.id];
        if (type === "ROUGH" && e.gem) { const c = pickRoughTier(e.value || 1); if (c) return c; }
      }
    }
    if (type === "ROUGH" && itemMap.rough_gem_glass) {
      const gk = GLASS_ROUGH_KEY[it.mat_type];
      if (gk && itemMap.rough_gem_glass[gk]) return itemMap.rough_gem_glass[gk];
    }
    return null;
  }
  function itemdefVariantCell(it, token) {
    const variants = itemMap && itemMap.itemdef_variants && itemMap.itemdef_variants[token];
    if (!variants) return null;
    if (it.artifact && variants.ARTIFACT) return variants.ARTIFACT;
    if (it.specialMaterial && variants.SPECIAL_MAT) return variants.SPECIAL_MAT;
    const fam = matFamilyForItem(it);
    if (it.type === "AMMO")
      return fam === "WOOD" ? (variants.STRAIGHT_WOOD || null) :
        (variants.STRAIGHT_DEFAULT || null);
    if (fam === "WOOD") {
      if (it.grown && variants.WOOD_GROWN) return variants.WOOD_GROWN;
      return variants.WOOD || variants.WOODEN || null;
    }
    return fam && variants[fam] ? variants[fam] : null;
  }
  const ITEM_PLANT_PART = { SEEDS: "SEED", PLANT: "PICKED", PLANT_GROWTH: "PICKED" };
  const ITEM_CREATURE_TYPES = new Set(["CORPSE", "CORPSEPIECE", "REMAINS", "VERMIN", "PET", "FISH", "FISH_RAW"]);
  function creatureFoodItemCell(it) {
    if (!it || (it.type !== "MEAT" && it.type !== "GLOB") || it.identKind !== 2 || !it.ident)
      return null;
    const food = itemMap && itemMap.creature_food;
    const profile = food && food.by_creature && food.by_creature[it.ident];
    const layout = profile && food.profiles && food.profiles[profile];
    const kind = layout && layout[String(it.mat_type)];
    const entry = kind && food.cells && food.cells[kind];
    return entry && entry.sheet ? entry : null;
  }
  function resolveIdentityEntry(it) {
    if (!it || typeof it.identKind !== "number" || !it.ident) return null;
    if (it.identKind === 1 /* plant */ && plantMap) {
      // Gate on ITEM TYPE, not ident presence: WOOD/DRINK/POWDER are plant-material items too. Only
      // SEEDS/PLANT/PLANT_GROWTH have per-species art; everything else must fall through to the type chain.
      const part = ITEM_PLANT_PART[it.type];
      if (!part) return null;
      const pm = plantMap[it.ident];
      if (pm) return pm[part] || pm.PICKED || pm.SHRUB || pm.SEED || null;
    } else if (it.identKind === 2 /* creature */ && creaturesMap && creaturesMap.races) {
      if (ITEM_CREATURE_TYPES.has(it.type)) {
        const cm = creaturesMap.races[it.ident];
        if (cm) {
          if (it.type === "CORPSE" || it.type === "CORPSEPIECE" || it.type === "REMAINS") {
            const corpseCell = (cm.corpse && cm.corpse.sheet) ? cm.corpse : null;
            const skelCell   = (cm.skeleton && cm.skeleton.sheet) ? cm.skeleton : null;
            if (it.skeletal) {
              const dead = skelCell || corpseCell;   // bone art first when DF says skeleton
              if (dead) return dead;
            } else {
              if (corpseCell) return corpseCell;      // fresh -> body art, never the skeleton
              // no .corpse cell: fall through to cm.sheet (flat living body) / fallback box.
            }
          }
          if (cm.sheet) return cm;   // real per-race flat cell (vs the generic REMAINS box)
        }
      }
    }
    return null;
  }
  function resolveItemVisual(it) {
    if (!itemMap) return null;
    const type = it.type;
    const food = creatureFoodItemCell(it);
    if (food) return { entry: food, source: "creaturefood" };
    const ident = resolveIdentityEntry(it);
    if (ident) return { entry: ident, source: "ident" };
    if (type === "TOOL" && it.generatedTool && itemMap.bytoken.ITEM_GENERATED_TOOL)
      return { entry: itemMap.bytoken.ITEM_GENERATED_TOOL, source: "itemdef" };
    if (type === "INSTRUMENT" && typeof it.instrumentClass === "number") {
      const instrumentToken = INSTRUMENT_ART_TOKEN[it.instrumentClass];
      const instrumentEntry = instrumentToken && itemMap.bytoken && itemMap.bytoken[instrumentToken];
      if (instrumentEntry) return { entry: instrumentEntry, source: "itemdef" };
    }
    if (itemDefTokens && typeof it.subtype === "number" && it.subtype >= 0) {
      const tok = itemDefTokens.get(type + ":" + it.subtype);
      const variant = tok && itemdefVariantCell(it, tok);
      if (variant) return { entry: variant, source: "itemdef" };
      if (tok && itemMap.bytoken && itemMap.bytoken[tok]) return { entry: itemMap.bytoken[tok], source: "itemdef" };
    }
    const matCell = materialItemCell(it, type);
    if (matCell) return { entry: matCell, source: "material" };
    const base = ITEM_MATVARIANT_BASE[type];
    if (base && itemMap.matvariants && itemMap.matvariants[base]) {
      const fam = matFamilyForItem(it);
      const variants = itemMap.matvariants[base];
      if (fam && variants[fam]) return { entry: variants[fam], source: "matvariant" };
    }
    if (itemMap.bytype && itemMap.bytype[type]) return { entry: itemMap.bytype[type], source: "bytype" };
    if ((type === "CORPSE" || type === "CORPSEPIECE" || type === "REMAINS") && itemMap._corpse_fallback) {
      return { entry: itemMap._corpse_fallback, source: "corpse" };
    }
    const miss = itemMap._missing || itemMap[type] || itemMap._default || null;
    return miss ? { entry: miss, source: "missing" } : null;
  }
  function resolveItemEntry(it) {
    const v = resolveItemVisual(it);
    return v ? v.entry : null;
  }
  function resolveItemSpriteRef(ref) {
    if (!ref || typeof ref.itemType !== "string") return null;
    if (typeof ref.itemToken === "string" && ref.itemToken && itemMap && itemMap.bytoken) {
      const tokenEntry = itemMap.bytoken[ref.itemToken];
      if (tokenEntry && tokenEntry.sheet) return tokenEntry;
    }
    const v = resolveItemVisual({
      type: ref.itemType,
      subtype: Number(ref.itemSubtype),
      mat_type: Number(ref.materialType),
      mat_index: Number(ref.materialIndex),
      identKind: Number(ref.identKind),
      ident: typeof ref.ident === "string" ? ref.ident : "",
    });
    if (!v || v.source === "missing") return null;
    const out = Object.assign({}, v.entry);
    if (v.source === "ident" && (ref.itemType === "PLANT_GROWTH" ||
        ref.itemType === "PLANT" || ref.itemType === "SEEDS")) {
      const palRow = matPalRowFor({
        type: ref.itemType,
        mat_type: Number(ref.materialType),
        mat_index: Number(ref.materialIndex),
        identKind: Number(ref.identKind),
        ident: typeof ref.ident === "string" ? ref.ident : "",
      });
      if (typeof palRow === "number") out.palRow = palRow;
    }
    return out;
  }
  const PALETTIZABLE_SOURCE = { itemdef: 1, material: 1, matvariant: 1, bytype: 1 };

  // ---- barrel/bin contents-peek overlay ---------------------------------------------------
  function containerPeekEntryCanvas(it, peek) {
    return window.DwfItemSelection.containerPeekEntry(it, peek, itemMap, materialMap);
  }

  function gemVariantForItem(it, v, gx, gy) {
    const GV = window.DwfGemVariant;
    if (!GV || !it || it.type !== "SMALLGEM") return undefined;
    if (!v || !v.entry || v.entry.sheet !== "smallgems.png") return undefined;
    return GV.variantIndex(GV.seedFromTile(gx, gy, 0));
  }

  function drawItem(t, px, py, cell, gx, gy) {
    try {
      if (!itemMap || !t.item) return;
      const it = t.item;
      if (it.type === "THREAD" && (it.iflags & 0x01) && itemMap.web) {
        const variants = (itemMap.web.harmless && itemMap.web.harmless.length) ? itemMap.web.harmless : itemMap.web.thick;
        if (variants && variants.length) {
          const v = variants[hashInt(px, py) % variants.length];
          if (v && v.sheet && blitCell(v.sheet, v.col, v.row, px, py, cell, undefined, true)) return;
        }
      }
      const v = resolveItemVisual(it);
      if (v && v.entry && v.entry.sheet) {
        let palRow;
        if (materialMap && (PALETTIZABLE_SOURCE[v.source] ||
            (v.source === "ident" && (it.type === "PLANT_GROWTH" ||
              it.type === "PLANT" || it.type === "SEEDS")))) {
          const pr = matPalRowFor(it);
          if (typeof pr === "number") palRow = pr;
        }
        const gemVar = gemVariantForItem(it, v, gx, gy);
        if (blitCell(v.entry.sheet, v.entry.col, v.entry.row, px, py, cell, palRow, true, gemVar)) {
          if (palRow === undefined) drawItemTint(it.mat_type, px, py, cell);
          if (t.peek) {
            const pk = containerPeekEntryCanvas(it, t.peek);
            if (pk) {
              const ppr = matPalRowFor(t.peek);
              blitCell(pk.sheet, pk.col, pk.row, px, py, cell,
                typeof ppr === "number" ? ppr : undefined, true);
            }
          }
        }
      }
    } catch (_) { /* layer guarded */ }
  }

  // ---- vermin / vermin-colony sprite --------------------------------------------------
  function resolveVerminEntry(t) {
    const v = t.vermin;
    if (!v || !v.length || !creaturesMap || !creaturesMap.races) return null;
    let lone = null;
    for (let i = 0; i < v.length; i++) {
      const e = v[i];
      if (!e || !e.token) continue;
      const c = creaturesMap.races[e.token];
      if (!c || !c.sheet) continue;
      if (e.vflags & 0x01) return c;   // colony takes precedence, regardless of list order
      if (!lone) lone = c;
    }
    return lone;
  }
  function drawVermin(t, px, py, cell) {
    try {
      const e = resolveVerminEntry(t);
      if (e && e.sheet) blitCell(e.sheet, e.col, e.row, px, py, cell);
    } catch (_) { /* layer guarded */ }
  }

  // ---- material-spatter decal + fallen-leaves/fruit litter ------------------------------
  const SPATTER_BUILTIN_FAMILY = { 9: "DUST", 12: "MUD", 13: "VOMIT" };
  // native enters the spatter draw path for every positive amount
  const SPATTER_VISIBLE_AMOUNT = 1;
  function spatterVisible(amount, threshold) {
    const min = threshold === undefined ? SPATTER_VISIBLE_AMOUNT : threshold;
    return Number.isFinite(amount) && amount >= min;
  }
  function firstVisibleSpatter(arr) {
    if (!arr) return null;
    for (let i = 0; i < arr.length && i < 4; i++) {
      if (arr[i] && spatterVisible(arr[i].amount)) return arr[i];
    }
    return null;
  }
  function bloodFamilyFromRgb(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return null;
    const r = rgb[0], g = rgb[1], b = rgb[2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 36) return "BLOOD_GOO";                    // desaturated grey -> goo
    if (r > g + 30 && b > g + 30) return "BLOOD_MAGENTA";    // red+blue both high -> purple/magenta
    if (b >= r && b >= g) return "BLOOD_CYAN";                // blue/cyan dominant
    if (r >= g && r >= b) {                                   // red dominant
      if (g >= r * 0.6 && b < g) return "BLOOD_ICHOR";        // yellow/orange (green high, blue low)
      return "BLOOD_RED";
    }
    return "BLOOD_ICHOR";                                     // green dominant -> yellow/green ichor
  }
  function spatterFamilyFor(sp) {
    const TV = window.DwfTerrainVariant;
    if (TV && typeof TV.spatterFamily === "function") return TV.spatterFamily(spatterMap, sp);
    if (!spatterMap || !sp) return null;
    const mt = sp.mat_type;
    if (mt === 6) return (sp.state === 3) ? "SNOW" : "WATER_SPATTER";
    const hint = SPATTER_BUILTIN_FAMILY[mt];
    if (hint) return hint;
    if (mt >= 19 && mt < 419) {
      const byRgb = bloodFamilyFromRgb(sp.rgb);
      if (byRgb) return byRgb;
      const blood = spatterMap.blood_families;
      if (Array.isArray(blood) && blood.length) return blood[hashInt(mt, sp.mat_index) % blood.length];
    }
    return "MUD";
  }
  // The 1..4 in PARTIAL_1A..PARTIAL_4D is a random visual variant WITHIN a band, not an amount
  // level: the amount only picks the A/B/C/D band, and the band table is server data.
  function spatterShapeFor(amount) {
    const TV = window.DwfTerrainVariant;
    if (TV && typeof TV.spatterShape === "function") return TV.spatterShape(spatterMap, amount);
    const thr = (spatterMap && spatterMap.amount_thresholds_default) || [];
    for (let i = 0; i < thr.length; i++) {
      const th = thr[i];
      if (th.max === null || amount <= th.max) return th.shape;
    }
    return "FULL";
  }
  // native's 36x16 region is shape x FAMILY, not shape x amount
  function spatterOracleCellFor(map, family, kind, familyLevel) {
    if (!map || !Array.isArray(map.oracle_kind_cells)) return null;
    if (!Number.isInteger(kind) || kind < 1 || kind > map.oracle_kind_cells.length) return null;
    const levels = map.oracle_family_levels;
    if (!Number.isInteger(familyLevel) || !Array.isArray(levels) ||
        familyLevel < 0 || familyLevel >= levels.length) return null;
    const famDef = map.families && map.families[levels[familyLevel] || family];
    const key = map.oracle_kind_cells[kind - 1];
    const c = famDef && famDef.cells && famDef.cells[key];
    return c ? { sheet: famDef.sheet, col: c.col, row: c.row, key } : null;
  }
  function spatterCellForKey(map, family, key) {
    const famDef = map && map.families && map.families[family];
    const c = famDef && famDef.cells && famDef.cells[key];
    return c ? { sheet: famDef.sheet, col: c.col, row: c.row, key } : null;
  }
  function partialVariantKey(band, gx, gy, gz, salt) {
    const TV = window.DwfTerrainVariant;
    if (TV && typeof TV.spatterPartialKey === "function")
      return TV.spatterPartialKey(band, gx, gy, gz || 0, salt || 0);
    const m = /^PARTIAL_([A-D])$/.exec(band || "");
    if (!m) return null;
    return "PARTIAL_" + (1 + hashInt(gx, gy) % 4) + m[1];
  }
  // FULL_* cell-key letters are concatenated in fixed N,S,W,E order (spatter_map.json's own key set).
  function resolveSpatterFullKey(fam, gx, gy, wx, wy, wz) {
    const Adj = window.DwfAdjacency;
    if (!Adj || typeof gx !== "number" || typeof gy !== "number") return "FULL_ISOLATED";
    let mask4 = 0;
    try {
      const mask8 = Adj.computeMask8(tileAt, gx, gy, (nt) => {
        const nsp = nt && ((nt.spatters && nt.spatters[0]) || nt.spatter);
        return !!nt && spatterVisible(nsp && nsp.amount) && spatterFamilyFor(nsp) === fam;
      });
      mask4 = mask8 & Adj.CARDINAL_BITS;
    } catch (_) { mask4 = 0; }
    let suf = "";
    if (mask4 & Adj.BIT.N) suf += "N";
    if (mask4 & Adj.BIT.S) suf += "S";
    if (mask4 & Adj.BIT.W) suf += "W";
    if (mask4 & Adj.BIT.E) suf += "E";
    if (!suf) return "FULL_ISOLATED";
    if (suf === "NSWE") {
      const letters = ["A", "B", "C", "D", "E"];
      const TV = window.DwfTerrainVariant;
      const pick = TV && typeof TV.stableIndex === "function"
        ? TV.stableIndex(wx, wy, wz || 0, letters.length, 0) : hashInt(gx, gy) % letters.length;
      return "FULL_NSWE_" + letters[pick];
    }
    return "FULL_" + suf;
  }
  function drawSpatterFallbackWash(sp, px, py, cell) {
    if (!spatterVisible(sp && sp.amount)) return;
    const a = Math.min(0.4, 0.08 + sp.amount / 400);
    ctx.fillStyle = "rgba(140,25,20," + a + ")";
    ctx.fillRect(px, py, cell, cell);
  }
  function drawSpatter(t, px, py, cell, gx, gy) {
    try {
      const arr = t.spatters;
      if (!arr || !arr.length) return;
      if (!spatterMap) { drawSpatterFallbackWash(firstVisibleSpatter(arr), px, py, cell); return; }
      let drewAny = false;
      for (let i = 0; i < arr.length && i < 4; i++) {
        const sp = arr[i];
        if (!sp || !spatterVisible(sp.amount)) continue;
        const fam = spatterFamilyFor(sp);
        const famDef = fam && spatterMap.families && spatterMap.families[fam];
        if (!famDef) continue;
        const wx = (typeof t.x === "number") ? t.x : gx;
        const wy = (typeof t.y === "number") ? t.y : gy;
        const wz = (typeof t.z === "number") ? t.z : ((typeof camOz === "number") ? camOz : 0);
        const shape = spatterShapeFor(sp.amount);
        const key = (shape === "FULL") ? resolveSpatterFullKey(fam, gx, gy, wx, wy, wz)
          : partialVariantKey(shape, wx, wy, wz, i);
        const TV = window.DwfTerrainVariant;
        const cellDef = TV && typeof TV.spatterCell === "function"
          ? TV.spatterCell(spatterMap, sp, wx, wy, wz, i, key)
          : (spatterCellForKey(spatterMap, fam, key)
            || spatterCellForKey(spatterMap, fam, "FULL_ISOLATED"));
        if (cellDef && blitCell(cellDef.sheet, cellDef.col, cellDef.row, px, py, cell)) drewAny = true;
      }
      if (!drewAny) drawSpatterFallbackWash(firstVisibleSpatter(arr), px, py, cell);
    } catch (_) { /* layer guarded */ }
  }

  // Litter is PARTIAL-only in spatter_map.json, so a FULL threshold hit downgrades to the densest PARTIAL.
  function drawItemSpatterLitter(t, px, py, cell, gx, gy) {
    try {
      const best = itemSpatterPlan(t.itemSpatters, spatterMap);
      if (!best) return;
      let shape = spatterShapeFor(best.isp.amount);
      if (shape === "FULL") shape = "PARTIAL_D";
      const wx = (typeof t.x === "number") ? t.x : gx;
      const wy = (typeof t.y === "number") ? t.y : gy;
      const wz = (typeof t.z === "number") ? t.z : ((typeof camOz === "number") ? camOz : 0);
      const key = partialVariantKey(shape, wx, wy, wz, 0);
      const cellDef = best.famDef.cells[key];
      if (!cellDef) return;
      const tint = window.DwfTerrainVariant.itemSpatterTintRgb(best.fam, best.isp.rgb);
      const tinted = tint && multiplyTintedCell(best.famDef.sheet, cellDef.col, cellDef.row, tint);
      if (tinted) ctx.drawImage(tinted, 0, 0, 32, 32, px, py, cell, cell);
      else blitCell(best.famDef.sheet, cellDef.col, cellDef.row, px, py, cell);
    } catch (_) { /* layer guarded */ }
  }

  function plantEntry(p) {
    if (!p || !plantMap || (p.part !== "SHRUB" && p.part !== "SAPLING")) return null;
    let e = p.id && plantMap[p.id] && plantMap[p.id][p.part];
    if (!e && p.part === "SAPLING" && treeMap && p.id && treeMap[p.id]) e = treeMap[p.id].SAPLING;
    if (!e) e = p.part === "SHRUB" ? plantMap._default_shrub : plantMap._default_sapling;
    return e && e.sheet ? e : null;
  }
  function drawPlant(t, px, py, cell) {
    try {
      const e = plantEntry(t && t.plant);
      if (e) blitCell(e.sheet, e.col, e.row, px, py, cell);
    } catch (_) { /* layer guarded */ }
  }
  function plantSpriteRef(t) {
    const e = plantEntry(t && t.plant);
    return e ? { sheet: e.sheet, col: e.col, row: e.row } : null;
  }

  const TREE_FLAT_FALLBACK = {
    TREE_TRUNK: "TRUNK", TREE_TRUNK_THICK: "TRUNK", TREE_TRUNK_PILLAR: "TRUNK", TREE_BASE: "TRUNK",
    TREE_BRANCH: "BRANCH", TREE_HEAVY_BRANCH: "BRANCH",
    TREE_CAP: "CANOPY",
    TREE_TWIGS: "LEAVES", TREE_LEAFLESS_TWIGS: "LEAVES",
  };

  // DF's canonical direction-letter order is N,S,W,E, but a tiletype enum name spells its runs in raws
  // order (TreeTrunkNEW), so a captured letter run must be re-sorted through this table before use.
  const TREE_DIR_ORDER = "NSWE";
  function canonicalDirs(letters) {
    let out = "";
    for (let i = 0; i < TREE_DIR_ORDER.length; i++) {
      if (letters.indexOf(TREE_DIR_ORDER[i]) !== -1) out += TREE_DIR_ORDER[i];
    }
    return out;
  }

  // {skip:true} draws nothing; null is unparsed and falls through to the flat back-compat key.
  function parseTreeTtname(ttname) {
    if (!ttname || ttname.indexOf("Tree") !== 0) return null;
    const dead = ttname.indexOf("Dead") !== -1;
    let rest = ttname.slice(4); // strip leading "Tree"
    if (dead) rest = rest.replace("Dead", "");
    let m;
    if (rest === "TrunkInterior") return { family: "TREE_TRUNK_THICK", variant: "INTERIOR", dead };
    if (rest === "CapInterior") return { family: "TREE_CAP", variant: "THICK_INTERIOR", dead };
    if (rest === "TrunkPillar") return { family: "TREE_TRUNK_PILLAR", variant: "_", dead };
    if (rest === "TrunkSloping") return { family: "TREE_TRUNK", variant: "SLOPE_TOP", dead };
    if (rest === "RootSloping" || rest === "Roots") return { family: "TREE_BASE", variant: "TRUNK", dead };
    if (rest === "CapRamp") return { skip: true };
    if (rest === "Twigs") {
      return { family: dead ? "TREE_LEAFLESS_TWIGS" : "TREE_TWIGS", variant: null, dead, adjacency: true };
    }
    if (rest === "Branches" || rest === "BranchesSmooth") {
      return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: "NSWE", dead };
    }
    if (rest === "Branch") return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: "_", dead };
    if (rest === "CapPillar") return { family: "TREE_CAP", variant: "PILLAR", dead };
    if ((m = /^CapPillar[NSEW]{1,4}$/.exec(rest))) return { family: "TREE_CAP", variant: "PILLAR", dead };
    if ((m = /^TrunkBranch([NSEW])$/.exec(rest))) return { family: "TREE_BASE", variant: "TRUNK_" + m[1], dead };
    if ((m = /^TrunkThick([NSEW]{1,2})$/.exec(rest))) return { family: "TREE_TRUNK_THICK", variant: canonicalDirs(m[1]), dead };
    if ((m = /^CapWallThick([NSEW]{1,2})$/.exec(rest))) return { family: "TREE_CAP", variant: "WALL_THICK_" + canonicalDirs(m[1]), dead };
    // The plain (non-THICK) CAP_WALL raw tokens join their direction letters with underscores
    // (TREE_CAP_WALL_N_S_W_E) and tree_map.json follows the raw token, so re-join with "_" here.
    if ((m = /^CapWall([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_CAP", variant: "WALL_" + canonicalDirs(m[1]).split("").join("_"), dead };
    if ((m = /^CapFloor([1-4])$/.exec(rest))) return { family: "TREE_CAP", variant: "FLOOR_" + m[1], dead };
    if ((m = /^Trunk([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_TRUNK", variant: canonicalDirs(m[1]), dead };
    if ((m = /^Branch([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: canonicalDirs(m[1]), dead };
    return null;
  }

  function isCanopyNeighbor(nt) {
    if (!nt || nt.hidden) return false;
    const shape = nt.shape || "";
    if (shape !== "TWIG" && shape !== "BRANCH") return false;
    const mat = nt.mat || "";
    return mat === "TREE" || mat === "MUSHROOM";
  }

  function treeFamilyTable(entry, family) {
    return entry && entry[family];
  }

  function resolveTreeCell(sel, id, gx, gy) {
    if (!treeMap || !sel || sel.skip) return null;
    const species = (id && treeMap[id]) || treeMap._default;
    if (!species) return null;
    let variant = sel.variant;
    if (variant === null && sel.adjacency) {
      variant = "_";
      const Adj = window.DwfAdjacency;
      if (Adj && typeof gx === "number" && typeof gy === "number") {
        const mask = Adj.computeMask8(tileAt, gx, gy, isCanopyNeighbor);
        const suffix = Adj.cardinalSuffix(mask).replace(/_/g, "");
        if (suffix) variant = suffix;
      }
    }
    function lookup(fam) {
      if (!fam) return null;
      const t1 = treeFamilyTable(species, fam);
      if (t1 && t1[variant]) return t1[variant];
      const t2 = treeFamilyTable(treeMap._default, fam);
      if (t2 && t2[variant]) return t2[variant];
      return null;
    }
    let cell = lookup(sel.family) || lookup(sel.altFamily);
    if (!cell && variant !== "_") {
      const savedVariant = variant;
      variant = "_";
      cell = lookup(sel.family) || lookup(sel.altFamily);
      variant = savedVariant;
    }
    if (!cell) {
      const flatKey = TREE_FLAT_FALLBACK[sel.family];
      if (flatKey) cell = species[flatKey] || (treeMap._default && treeMap._default[flatKey]);
    }
    return cell;
  }

  const OVERLEAVES_PREFIX = {
    TREE_TRUNK: "TRUNK_",
    TREE_BRANCH: "HEAVY_BRANCH_",
    TREE_HEAVY_BRANCH: "HEAVY_BRANCH_",
  };
  function resolveOverleaves(sel, id) {
    if (!sel || sel.dead || !treeMap) return null;
    const prefix = OVERLEAVES_PREFIX[sel.family];
    if (!prefix || !sel.variant || sel.variant === "_" || !/^[NSWE]+$/.test(sel.variant)) return null;
    const key = prefix + sel.variant;
    const sp = (id && treeMap[id]) || null;
    const own = sp && sp.TREE_OVERLEAVES && sp.TREE_OVERLEAVES[key];
    if (own) return own;
    const dflt = treeMap._default && treeMap._default.TREE_OVERLEAVES;
    return (dflt && dflt[key]) || null;
  }


  const TREE_GROWTH_NAMES = ["FRUIT_1", "FRUIT_2", "FRUIT_3", "FLOWER_2", "FLOWER_1"];
  function treeGraphicsCells(g) {
    const shared = treeMap && treeMap._shared;
    if (!g || !shared || !shared.wood || !shared.leaf) return null;
    const out = { wood: null, leaf: null, growth: null, colorIndex: 0 };
    if (g.woodPresent) {
      const wk = g.woodKey >>> 0, ws = (wk >>> 8) & 0xff;
      if (ws < shared.wood.length) out.wood = shared.wood[ws];
      out.colorIndex = wk & 0xff;
    }
    if (g.leafPresent) {
      const lk = g.leafKey >>> 0, ls = (lk >>> 8) & 0xff, autumn = (lk >>> 19) & 3;
      const baseRun = autumn ? shared.leaf.autumn && shared.leaf.autumn[String(autumn)] : shared.leaf.base;
      if (baseRun && ls < baseRun.length) out.leaf = baseRun[ls];
      out.colorIndex = lk & 0xff;
      if (g.growthPresent) {
        const name = TREE_GROWTH_NAMES[(lk >>> 16) & 7];
        const run = name && shared.leaf.growth && shared.leaf.growth[name];
        if (run && ls < run.length) out.growth = run[ls];
      }
    }
    return out;
  }

  function drawTree(t, px, py, cell, gx, gy) {
    try {
      if (!treeMap) return;
      const keyed = treeGraphicsCells(t.treeGraphics);
      if (keyed && (keyed.wood || keyed.leaf)) {
        for (const e of [keyed.wood, keyed.leaf, keyed.growth])
          if (e && e.sheet) blitCell(e.sheet, e.col, e.row, px, py, cell,
            keyed.colorIndex > 0 ? keyed.colorIndex - 1 : undefined, true);
        return;
      }
      const p = t.plant;
      const part = (p && p.part) || derivedTreePart(t);
      if (part !== "TRUNK" && part !== "BRANCH" && part !== "CANOPY" && part !== "LEAVES") return;
      const pid = (p && p.id) || null;
      const sel = parseTreeTtname(t.ttname || "");
      if (sel && sel.skip) return; // TreeCapRamp family: DF draws the bare floor/ramp beneath
      let e = sel && resolveTreeCell(sel, pid, gx, gy);
      if (!e) {
        e = pid && treeMap[pid] && treeMap[pid][part];
        if (!e) e = treeMap._default && treeMap._default[part];
      }
      if (e && e.sheet) {
        blitCell(e.sheet, e.col, e.row, px, py, cell);
        const over = resolveOverleaves(sel, pid);
        if (over && over.sheet) blitCell(over.sheet, over.col, over.row, px, py, cell);
      }
    } catch (_) { /* layer guarded */ }
  }
  function treeSpriteRef(t, gx, gy) {
    const p = t && t.plant;
    const part = (p && p.part) || derivedTreePart(t || {});
    if (part !== "TRUNK" && part !== "BRANCH" && part !== "CANOPY" && part !== "LEAVES") return null;
    const sel = parseTreeTtname((t && t.ttname) || "");
    if (sel && sel.skip) return null;
    let e = sel && resolveTreeCell(sel, (p && p.id) || null, gx, gy);
    if (!e) {
      e = p && p.id && treeMap && treeMap[p.id] && treeMap[p.id][part];
      if (!e) e = treeMap && treeMap._default && treeMap._default[part];
    }
    return e && e.sheet ? { sheet: e.sheet, col: e.col, row: e.row } : null;
  }

  function tileAt(gx, gy) {
    const src = latest;
    if (!src || !Array.isArray(src.tiles)) return null;
    const w = src.width | 0, h = src.height | 0;
    if (gx < 0 || gy < 0 || gx >= w || gy >= h) return null;
    return src.tiles[gy * w + gx] || null;
  }

  function edgeReceiver(t) {
    if (!t || t.hidden) return false;
    const s = t.shape || "";
    return s === "FLOOR" || s === "PEBBLES" || s === "BOULDER" ||
      s === "STAIR_UP" || s === "STAIR_DOWN" || s === "STAIR_UPDOWN" || s === "RAMP" ||
      !!t.plant;
  }

  function edgeOvergrowthPlan(gx, gy, lookup) {
    const Edge = window.DwfEdgeOvergrowth;
    if (!Edge || typeof gx !== "number" || typeof gy !== "number") return null;
    return Edge.plan(lookup || tileAt, gx, gy, materialMap);
  }

  function drawEdgeOvergrowth(t, px, py, cell, gx, gy, lookup) {
    if (!edgeReceiver(t)) return false;
    const Edge = window.DwfEdgeOvergrowth;
    const plan = edgeOvergrowthPlan(gx, gy, lookup || tileAt);
    if (!Edge || !plan) return false;
    let drew = false;
    for (let i = 0; i < plan.draws.length; i++) {
      const q = plan.draws[i], art = Edge.artFor(q.code, q.slot);
      // A resolved null art is a real gap, never an edge-clamped neighbouring cell.
      if (art && blitCell(art.sheet, art.col, art.row, px, py, cell)) drew = true;
    }
    return drew;
  }

  function resolveShadowToken(table, mask8) {
    if (!shadowCellMap || !spriteMap) return null;
    const tbl = shadowCellMap[table];
    const tok = tbl && tbl[String(mask8)];
    if (!tok) return null;
    return resolveCell(tok);
  }
  function drawShadowDecals(t, px, py, cell, gx, gy) {
    try {
      const Adj = window.DwfAdjacency;
      if (!Adj || !shadowCellMap || typeof gx !== "number" || typeof gy !== "number") return;
      const shape = t.shape || "";
      if (shape !== "WALL" && shape !== "FORTIFICATION" && shape !== "EMPTY" && shape !== "NONE") {
        const wallMask = Adj.computeMask8(tileAt, gx, gy);
        if (wallMask) {
          const table = (shape === "RAMP" || shape === "RAMP_TOP") ? "rampShadowOnRamp" : "wallShadow";
          const cell8 = resolveShadowToken(table, wallMask);
          if (cell8) ctx.drawImage(cell8.img, cell8.col * 32, cell8.row * 32, 32, 32, px, py, cell, cell);
        }
      }
      const hiddenMask = Adj.computeMask8(tileAt, gx, gy, Adj.isHiddenTile);
      if (hiddenMask) {
        const visCell = resolveShadowToken("visionShadow", hiddenMask);
        if (visCell) ctx.drawImage(visCell.img, visCell.col * 32, visCell.row * 32, 32, 32, px, py, cell, cell);
      }
    } catch (_) { /* layer guarded */ }
  }

  function wallPrefix(mat, base_mt) {
    if (mat === "SOIL") return "SOIL_WALL";
    if (mat === "FROZEN_LIQUID") return "ICE_WALL";
    if (mat === "LAVA_STONE" || mat === "MAGMA") return "MAGMA_WALL";
    // Never default an unresolved mineral wall to ORE_VEIN_WALL: its near-white glaze is the one
    // sheet the palette substitution cannot recolour, so every such wall would render near-white.
    if (mat === "CONSTRUCTION") return (typeof base_mt === "number" && base_mt >= 419) ? "WOODEN_WALL" : "ROCK_BLOCKS_WALL";
    return "STONE_WALL";
  }
  const WALL_ART_PARITY = Object.freeze({
    family: "exact", cellBase: "exact", variant: "approximate",
    variantReason: "native-global-rng-is-not-on-the-wire",
  });
  function roughInorganicWallPrefix(t) {
    if (!t || t.base_mt !== 0 || (t.mat !== "STONE" && t.mat !== "MINERAL")) return null;
    const ino = materialMap && materialMap.inorganic && materialMap.inorganic[t.base_mi];
    const family = ino && ino.wall_family;
    const base = ino && ino.wall_cell_base;
    if (family === 10) return "ORE_VEIN_WALL";           // ore-bearing: the vein glaze is native
    if (family === 7 && base === 0x4c6a) return "STONE_WALL";
    const gemBases = [0x4bbf, 0x4bd2, 0x4be5, 0x4bf8];
    if (family >= 11 && family <= 14 && base === gemBases[family - 11])
      return "GEM_" + "ABCD"[family - 11] + "_WALL";
    return null;
  }
  // Both the law and its fallback key on the tile's WORLD position; gx/gy are used only when the
  // caller has no tile to read one from, which no production caller does.
  function roughWallVariant(gx, gy, t, drawZ) {
    const wx = (t && typeof t.x === "number") ? t.x : gx;
    const wy = (t && typeof t.y === "number") ? t.y : gy;
    const TV = window.DwfTerrainVariant;
    if (TV && typeof drawZ === "number") {
      const v = TV.variant(wx, wy, drawZ);
      if (typeof v === "number") return v;
    }
    return hashXY(wx, wy) & 3;
  }
  function wallDetailPrefix(t) {
    const nm = (t && t.ttname) || "";
    const isIce = ((t && t.mat) || "") === "FROZEN_LIQUID";
    if (/WallSmooth/.test(nm)) return isIce ? "SMOOTHED_ICE_WALL" : "SMOOTHED_STONE_WALL";
    const worn = /WallWorn([123])$/.exec(nm);
    if (worn) return isIce ? "SMOOTHED_ICE_WALL" : ("WORN" + worn[1] + "_STONE_WALL");
    return null;
  }
  function wallJoinBaseToken(t, openMask) {
    if ((t.shape || "") !== "WALL") return null;
    if (isTreeWallMat(t.mat || "")) return null;
    const Adj = window.DwfAdjacency;
    const infix = Adj ? Adj.wallCellSuffix(openMask) : null;
    if (!infix) return null; // fully buried -> darkened base fill only
    const prefix = wallDetailPrefix(t) || roughInorganicWallPrefix(t)
      || wallPrefix(t.mat || "", t.base_mt);
    return prefix + "_" + infix;
  }
  function wallJoinPalRow(t) {
    const m = wallMaterial(t);
    if (!m || typeof m.palRow !== "number") return null;
    return m.palRow;
  }

  function drawWallJoin(t, px, py, cell, gx, gy, knownOpenMask, drawZ) {
    try {
      if (!spriteMap || (t.shape || "") !== "WALL") return;
      const Adj = window.DwfAdjacency;
      if (!Adj || typeof gx !== "number" || typeof gy !== "number") return;
      const openMask = (typeof knownOpenMask === "number") ? knownOpenMask
        : Adj.computeMask8(tileAt, gx, gy, Adj.isOpenNeighbor);
      const base = wallJoinBaseToken(t, openMask);
      if (!base) return; // not a stone wall (tree/mushroom trunk), fully buried, or unresolved
      const palRow = wallJoinPalRow(t); // per-material dressed-block colour (null => draw as-authored)
      const v = roughWallVariant(gx, gy, t, drawZ) + 1;
      const cands = [base + "_" + v, base + "_1", base];
      for (let i = 0; i < cands.length; i++) {
        const e = spriteMap[cands[i]];
        if (e && e.sheet && blitCell(e.sheet, e.col, e.row, px, py, cell, (typeof palRow === "number") ? palRow : undefined)) return;
      }
    } catch (_) { /* layer guarded */ }
  }

  // ============================================================================ engravings ====
  const ENG_FLOOR = 0x0001, ENG_HIDDEN = 0x0020;

  function engravingWallPlan(t, mask) {
    const token = window.DwfAdjacency.engravingWallToken(mask);
    return token ? { token, palRow: wallJoinPalRow(t) } : null;
  }

  function engravingFloorPlan(t) {
    const m = wallMaterial(t);
    if (m && typeof m.palRow === "number") {
      return { token: "FLOOR_STONE_ENGRAVED_PALETTE", palRow: m.palRow };
    }
    return { token: "FLOOR_STONE_ENGRAVED_NON_PALETTE", palRow: null };
  }
  function drawEngraving(t, px, py, cell, gx, gy) {
    const hits = t.engravings;
    if (!hits || !hits.length || !spriteMap) return;
    let mask = 0;
    for (let i = 0; i < hits.length; i++) mask |= (hits[i].eflags & 0x03ff);
    if (mask & ENG_HIDDEN) return; // DF hides the decoration -- draw nothing
    if (mask & ENG_FLOOR) {
      const floorPlan = engravingFloorPlan(t);
      const fe = spriteMap[floorPlan.token];
      if (fe && fe.sheet) blitCell(fe.sheet, fe.col, fe.row, px, py, cell,
        (typeof floorPlan.palRow === "number") ? floorPlan.palRow : undefined);
    }
    const plan = engravingWallPlan(t, mask);
    if (plan) {
      const we = spriteMap[plan.token];
      if (we && we.sheet) blitCell(we.sheet, we.col, we.row, px, py, cell,
        (typeof plan.palRow === "number") ? plan.palRow : undefined);
    }
  }

  const MISSING_BUILDING = { sheet: "defaults.png", col: 0, row: 1 };

  function isOverlayOnlyBuildingType(type) {
    return type === "Stockpile" || type === "Civzone";
  }

  // Building art is not commutative: the authored overhang row lands at y1-1, so paint back-to-front by
  // ASCENDING y1 (down-screen last). Stable source order breaks ties; never mutate the AUX vector.
  function buildingsInPaintOrder(list) {
    if (!Array.isArray(list) || list.length < 2) return Array.isArray(list) ? list.slice() : [];
    return list.map((building, index) => ({ building, index })).sort((a, b) => {
      const ay = a.building && Number.isFinite(a.building.y1) ? a.building.y1 : -2147483648;
      const by = b.building && Number.isFinite(b.building.y1) ? b.building.y1 : -2147483648;
      return (ay - by) || (a.index - b.index);
    }).map((entry) => entry.building);
  }

  function pickBuildingPalRow(b) {
    if (!b || typeof b.cpal !== "string" || !materialMap || !materialMap.palette) return null;
    const r = materialMap.palette.byname && materialMap.palette.byname[b.cpal];
    return typeof r === "number" && materialMap.palette.rows && materialMap.palette.rows[r] ? r : null;
  }

  function customWorkshopEntry(b) {
    if (!buildingMap) return null;
    const w = Math.max(1, ((b.x2 | 0) - (b.x1 | 0)) + 1);
    const h = Math.max(1, ((b.y2 | 0) - (b.y1 | 0)) + 1);
    const keys = Object.keys(buildingMap);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("WORKSHOP_CUSTOM:") !== 0) continue;
      const e = buildingMap[keys[i]];
      if (e && e.w === w && e.h === h) return e;
    }
    return null;
  }

  function plannedConstructionEntryTiles(b) {
    return window.DwfConstructionSelect.plannedConstructionEntry(b, buildingMap);
  }

  const STATUE_OVERALL_CREATURE = 2;      // item_statue_graphics_type_overall
  const STATUE_OVERALL_EVENT = 5;
  function statueSubject(S, b) {
    if (!S.subjects) return S.default || null;
    const gt = (typeof b.sgt === "number") ? b.sgt : -1;
    if (gt === STATUE_OVERALL_CREATURE && b.srt && S.creature) {
      // "RACE:CASTE" first (peafowl/chicken/duck statues are caste-split), then bare RACE.
      const race = String(b.srt);
      const hit = S.creature[race] || S.creature[race.split(":")[0]];
      if (hit) return hit;
    } else if (gt === STATUE_OVERALL_EVENT && S.event) {
      const tok = S.event[String(b.sgi)];
      if (tok && S.subjects[tok]) return S.subjects[tok];
    } else if (gt >= 0 && S.overall) {
      const tok = S.overall[String(gt)];
      if (tok && S.subjects[tok]) return S.subjects[tok];
    }
    return S.default || null;   // SHAPE/ITEM/unknown/no-wire -> ITEM_DEFAULT_STATUE
  }
  function statueEntry(b) {
    if (!buildingMap || !b || b.type !== "Statue") return null;
    // Keep this ahead of the composite so scaffolding never grows a statue subject.
    if (typeof b.stage === "number" && isFinite(b.stage)) {
      const stage = b.stage | 0;
      if (stage === 0) return null;
      if (stage !== 1) return { hidden: true };
    }
    const S = buildingMap.statues;
    if (!S || !S.sheet || !S.pedestal) return null;    // older map -> caller's flat-key path
    const mat = (typeof b.smt === "number") ? { mat_type: b.smt, mat_index: b.smi } : b;
    const mc = matFamilyForItem(mat) || "STONE";
    const q = (typeof b.sq === "number") ? b.sq : 0;
    const row = S.pedestal[mc] || S.pedestal.STONE;
    const ped = row && row.length ? row[Math.min(Math.max(q, 0), row.length - 1)] : null;
    if (!ped) return null;
    const e = { sheet: S.sheet, w: 1, h: 1, cells: [[ped]] };
    const subj = statueSubject(S, b);
    if (subj && subj.top && subj.bottom) {
      const ssheet = subj.sheet || S.sheet;            // creature statues live on their own sheets
      e.overlaySheet = ssheet;
      e.overlay = [[subj.bottom]];
      e.overlayTint = true;                            // subject is the SAME stone as the plinth
      e.overhangSheet = ssheet;
      e.overhang = [subj.top];                         // -> one tile ABOVE (the overhang row)
    }
    return e;
  }

  const FURNITURE_MAT_PREF = ["WOOD", "STONE", "METAL", "GLASS", "GEM", "ROPE"];
  function furnitureMaterialKey(variants, b) {
    const family = matFamilyForItem(b);
    if (family && variants[family]) return family;
    // Rope restraints use plant-fiber materials, which the item classifier calls WOOD; here it is ROPE.
    if (family === "WOOD" && variants.ROPE) return "ROPE";
    for (let i = 0; i < FURNITURE_MAT_PREF.length; i++) {
      if (variants[FURNITURE_MAT_PREF[i]]) return FURNITURE_MAT_PREF[i];
    }
    return Object.keys(variants)[0] || null;
  }
  function furnitureEntry(b) {
    if (!buildingMap || !buildingMap.furniture || !b) return null;
    const f = buildingMap.furniture[b.type];
    if (!f || !f.matvariants) return null;
    // Stage 0 uses the flat Type entry, stage 1 the contained item, every other stage draws nothing.
    if (typeof b.stage === "number" && isFinite(b.stage)) {
      const stage = b.stage | 0;
      if (stage === 0) return null;
      if (stage !== 1) return { hidden: true };
    }
    let variants = f.matvariants;
    const TV = window.DwfTerrainVariant;
    const state = TV && typeof TV.furnitureStateKey === "function" ? TV.furnitureStateKey(b) : null;
    if (state && f.states && f.states[state]) {
      const sv = f.states[state];
      if (sv.sheet) return { sheet: sv.sheet, w: 1, h: 1, cells: [[sv]] };
      variants = sv;
    }
    const material = furnitureMaterialKey(variants, b);
    let c = material && variants[material];
    if (!c) return null;
    let damage = null;
    if (TV && typeof TV.furnitureQualityArt === "function") {
      const art = TV.furnitureQualityArt(f, material, state, b.cq, b.cw, c);
      c = art.base;
      damage = art.damage;
    }
    const out = { sheet: c.sheet, w: 1, h: 1, cells: [[c]] };
    if (damage) {
      out.overlaySheet = damage.sheet;
      out.overlay = [[damage]];
    }
    if ((b.type === "Door" || b.type === "Hatch") && (b.bst & 2) && f.forbidden) {
      out.overlaySheet = f.forbidden.sheet;
      out.overlay = [[f.forbidden]];
    }
    return out;
  }

  // Track-stop mask bits match the wire's track convention: N=1, S=2, E=4, W=8.
  const TRACK_STOP_SHAPE = ["NSWE", "N", "S", "NS", "E", "NE", "SE", "NSE",
    "W", "NW", "SW", "NSW", "WE", "NWE", "SWE", "NSWE"];
  function trackStopEntry(b) {
    if (!buildingMap || !b || b.type !== "TrackStop") return null;
    const mask = (typeof b.track === "number") ? (b.track & 15) : 15;
    const material = matFamilyForItem(b) === "WOOD" ? "WOOD" : "STONE";
    return buildingMap["TRACK_STOP_" + material + "_" + TRACK_STOP_SHAPE[mask]] || null;
  }

  // Workshop/furnace/depot sheets carry four build-stage grids side by side; the flat entry is the
  // finished grid, so stage N shifts every base/overlay cell (3-N)*width columns.
  function shiftBuildingEntry(entry, dx) {
    const out = Object.assign({}, entry);
    const shiftCell = c => c ? Object.assign({}, c, { col: c.col + dx }) : c;
    const shiftGrid = grid => grid && grid.map(row => row.map(shiftCell));
    if (entry.cells) out.cells = shiftGrid(entry.cells);
    if (entry.overhang) out.overhang = entry.overhang.map(shiftCell);
    if (entry.overlay) out.overlay = shiftGrid(entry.overlay);
    if (entry.overlayOverhang) out.overlayOverhang = entry.overlayOverhang.map(shiftCell);
    return out;
  }
  function workshopStageEntry(b, entry) {
    if (!entry || !b || (b.type !== "Workshop" && b.type !== "Furnace" && b.type !== "TradeDepot")) return entry;
    if (typeof b.stage !== "number" || !isFinite(b.stage)) return entry;
    const stage = b.stage | 0;
    if (stage < 0 || stage > 3) return Object.assign({}, entry, { cells: entry.cells.map(row => row.map(() => null)), overhang: null, overlay: null, overlayOverhang: null });
    if (b.type === "Workshop" && (b.subtype === 17 || b.subtype === 22)) {
      if (stage > 1) return Object.assign({}, entry, { cells: entry.cells.map(row => row.map(() => null)), overhang: null, overlay: null, overlayOverhang: null });
      return stage === 0 ? shiftBuildingEntry(entry, -entry.cells[0][0].col) : entry;
    }
    return shiftBuildingEntry(entry, (3 - stage) * entry.w);
  }

  const BR_RETRACT = -1, BR_LEFT = 0, BR_RIGHT = 1, BR_UP = 2, BR_DOWN = 3;
  const BRIDGE_TI_HOLE = 0x3c;                       // produced by no branch
  const BRIDGE_TI_MAX = 0x4c;
  function bridgeTileIndexTiles(dir, raised, rx1, rx2, ry1, ry2, x, y) {
    return window.DwfConstructionSelect.bridgeTileIndex(dir, raised, rx1, rx2, ry1, ry2, x, y);
  }
  // The draw rectangle: [rx1, rx2, ry1, ry2] in FOOTPRINT-LOCAL coords.
  function bridgeDrawRect(dir, raised, w, h) {
    let rx1 = 0, rx2 = w - 1, ry1 = 0, ry2 = h - 1;
    if (raised) {
      if (dir === BR_LEFT) rx2 = rx1;
      else if (dir === BR_RIGHT) rx1 = rx2;
      else if (dir === BR_UP) ry2 = ry1;
      else if (dir === BR_DOWN) ry1 = ry2;
      // BR_RETRACT: no clamp -- the loop still visits the whole footprint and emits nothing.
    }
    return [rx1, rx2, ry1, ry2];
  }

  function bridgeEntryTiles(b) {
    if (!buildingMap || !buildingMap.bridges || !b || b.type !== "Bridge" ||
        typeof b.dir !== "number" || typeof b.bst !== "number") return null;
    const variants = buildingMap.bridges;
    const material = furnitureMaterialKey(variants, b);
    const map = material && variants[material];
    const w = b.x2 - b.x1 + 1, h = b.y2 - b.y1 + 1;
    if (!map || w < 1 || h < 1) return null;
    const dirCode = b.dir | 0;
    if (dirCode < BR_RETRACT || dirCode > BR_DOWN) return null;
    const raised = !!(b.bst & 1);
    if (dirCode === BR_RETRACT && raised) return { hidden: true };  // nothing, anywhere
    // The material's authored block fixes the sheet: one column per material, one row per tile_index.
    const anchor = map.NS_CENTER;
    if (!anchor || typeof anchor.col !== "number" || !anchor.sheet) return null;

    const rect = bridgeDrawRect(dirCode, raised, w, h);
    const rx1 = rect[0], rx2 = rect[1], ry1 = rect[2], ry2 = rect[3];
    const cells = [];
    let drew = false;
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        // Cells OUTSIDE the draw rectangle emit NOTHING.
        const inRect = x >= rx1 && x <= rx2 && y >= ry1 && y <= ry2;
        const ti = inRect ? bridgeTileIndexTiles(dirCode, raised, rx1, rx2, ry1, ry2, x, y) : null;
        if (ti === null) { row.push(null); continue; }
        if (ti === BRIDGE_TI_HOLE || ti < 0 || ti > BRIDGE_TI_MAX) return null;  // hole predicate
        row.push({
          col: anchor.col, row: window.DwfConstructionSelect.bridgeSheetRow(ti),
        });
        drew = true;
      }
      cells.push(row);
    }
    if (!drew) return { hidden: true };
    return { sheet: anchor.sheet, w, h, cells };
  }

  const CATAPULT_CONST_FRAMES = ["CATAPULT_CONST_0", "CATAPULT_CONST_1", "CATAPULT_CONST_2", "CATAPULT_CONST_3"];
  const SIEGE_DIR = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const SIEGE_KIND = ["CATAPULT", "BALLISTA", "BOLT_THROWER"];
  function siegeEngineToken(b) {
    if (!b || b.type !== "SiegeEngine" || typeof b.dir !== "number" || typeof b.bextra !== "number") return null;
    const kind = SIEGE_KIND[b.bextra & 0xff];
    const dir = SIEGE_DIR[b.dir & 7];
    if (!kind || !dir) return null;
    if (kind !== "BOLT_THROWER" && b.built === false) {
      const stage = (typeof b.stage === "number" && isFinite(b.stage)) ? (b.stage | 0) : 0;
      return kind + "_CONST_" + Math.max(0, Math.min(3, stage));
    }
    if (kind === "BOLT_THROWER") return "BOLT_THROWER_" + ((b.bst & 1) ? "FIRING_" : "READY_") + dir;
    return kind + "_" + dir + ((b.bst & 1) ? "_FIRING" : "");
  }
  function siegeEngineEntry(b) {
    const token = siegeEngineToken(b);
    const base = token && buildingMap && buildingMap[token];
    if (!base) return null;
    const ammoLevel = b && typeof b.bextra === "number" ? ((b.bextra >>> 8) & 7) : 0;
    if (!token.startsWith("BOLT_THROWER_") || ammoLevel < 1) return base;
    const ammo = buildingMap["BOLT_THROWER_AMMO_" + SIEGE_DIR[b.dir & 7]];
    if (!ammo) return base;
    const choices = [ammo.overhang && ammo.overhang[0]].concat((ammo.cells || []).map(row => row && row[0]));
    const cell = choices[Math.min(5, ammoLevel) - 1];
    return cell ? Object.assign({}, base, { overlaySheet: ammo.sheet, overlay: [[cell]] }) : base;
  }

  function trapEntry(b) {
    if (!b || b.type !== "Trap" || typeof b.dir !== "number") return null;
    const delayed = !!(b.bst & 1);
    if (b.built === false) return null;
    if (b.dir === 0) return buildingMap[delayed ? "LEVER_PULLED" : "LEVER_SET"] || null;
    if (b.dir === 1) {
      const flags = (typeof b.bextra === "number") ? b.bextra : 0;
      const suffix = (flags & 4) ? "_MAGMA" : (flags & 2) ? "_WATER" : (flags & 32) ? "_MINECART" : "";
      return buildingMap[(delayed ? "TRAP_PLATE_PRESSED" : "TRAP_PLATE_READY") + suffix] || null;
    }
    if (b.dir === 2 || b.dir === 3) {
      const family = b.dir === 2 ? "TRAP_CAGE" : "TRAP_STONE";
      const base = buildingMap[family + (delayed ? "_UNLOADED" : "")];
      const top = !delayed && buildingMap[family + "_TOP"];
      return base && top ? Object.assign({}, base, { overhang: [top.cells[0][0]], overhangSheet: top.sheet }) : base || null;
    }
    return null;
  }

  // Wagons key body and goods overlay on the wire's dir (BLD/N/S/W/E = 0..4) and bst (goods level 0..7).
  const WAGON_DIR = ["BLD", "N", "S", "W", "E"];
  function wagonEntry(b) {
    if (!b || b.type !== "Wagon" || !buildingMap || !buildingMap.wagons ||
        typeof b.dir !== "number" || typeof b.bst !== "number") return null;
    const direction = WAGON_DIR[b.dir | 0];
    const family = direction && buildingMap.wagons[direction];
    const body = family && buildingMap[family.body];
    if (!body) return null;
    const goods = Math.max(0, Math.min(7, b.bst | 0));
    const overlay = goods && family.goods && family.goods[goods];
    if (!overlay) return body;
    return Object.assign({}, body, {
      overlaySheet: overlay.sheet,
      overlay: overlay.overlay,
      overlayOverhang: overlay.overlayOverhang,
    });
  }

  function supportEntry(b) {
    if (!b || b.type !== "Support" || !buildingMap) return null;
    const family = matFamilyForItem(b);
    const token = family === "METAL" ? "BLD_SUPPORT_METAL" :
                  family === "WOOD" ? "BLD_SUPPORT_WOOD" : "BLD_SUPPORT_STONE";
    return buildingMap[token] || null;
  }

  function buildingEntry(b) {
    if (!buildingMap) return MISSING_BUILDING;
    const type = b.type || "";
    const st = (typeof b.subtype === "number") ? b.subtype : -1;
    // stage-correct siege art must be tried before the flat-key ladder can swallow it
    const siege = siegeEngineEntry(b);
    if (siege) return siege;
    const trackStop = trackStopEntry(b);
    if (trackStop) return trackStop;
    const bridge = bridgeEntryTiles(b);
    if (bridge) return bridge;
    const wagon = wagonEntry(b);
    if (wagon) return wagon;
    const support = supportEntry(b);
    if (support) return support;
    const trap = trapEntry(b);
    if (trap) return trap;
    const pc = plannedConstructionEntryTiles(b);
    if (pc) return pc;
    const furniture = furnitureEntry(b);
    if (furniture) return furniture;
    const cands = [];
    if (type === "Workshop" && st >= 0 && st < WORKSHOP_SUBTYPE.length) {
      const stName = WORKSHOP_SUBTYPE[st];
      if (stName === "Custom") {
        const ce = customWorkshopEntry(b);
        if (ce) return ce;
      }
      cands.push("Workshop:" + stName);
    }
    if (type === "Furnace" && st >= 0 && st < FURNACE_SUBTYPE.length) cands.push("Furnace:" + FURNACE_SUBTYPE[st]);
    if (type) { cands.push(type + ":" + st); cands.push(type); }
    for (let i = 0; i < cands.length; i++) {
      if (cands[i] && buildingMap[cands[i]]) return workshopStageEntry(b, buildingMap[cands[i]]);
    }
    return MISSING_BUILDING;
  }

  function buildingSpriteRef(b) {
    if (!b || !buildingMap) return null;
    const e = machineEntry(b, buildingMap, machineFrameParity(worldAnimMs(Date.now())), lookupCurrentTile) ||
      farmPlotEntry(b) || statueEntry(b) || buildingEntry(b);
    if (!e || e === MISSING_BUILDING || e.hidden || !e.sheet) return null;
    if (typeof e.col === "number" && typeof e.row === "number")
      return { sheet: e.sheet, col: e.col, row: e.row };
    if (!Array.isArray(e.cells) || !e.cells.length) return null;
    let ry = Math.floor(((b.y2 | 0) - (b.y1 | 0)) / 2);
    ry = Math.max(0, Math.min(e.cells.length - 1, ry));
    let row = e.cells[ry] || null;
    let rx = Math.floor(((b.x2 | 0) - (b.x1 | 0)) / 2);
    if (row) rx = Math.max(0, Math.min(row.length - 1, rx));
    let c = row && row[rx];
    if (!c) {
      for (let y = 0; y < e.cells.length && !c; y++)
        for (let x = 0; e.cells[y] && x < e.cells[y].length && !c; x++) c = e.cells[y][x];
    }
    return c && typeof c.col === "number" && typeof c.row === "number"
      ? { sheet: e.sheet, col: c.col, row: c.row } : null;
  }

  // The placement ghost: DF's baked 50%-opacity copy, expressed here as a draw-time globalAlpha.
  function drawBuildingGhost(ctx, b, opts) {
    if (!ctx || !b || !buildingMap) return 0;
    const o = opts || {};
    const cell = Number(o.cell) || 0;
    if (!(cell > 0)) return 0;
    const e = machineEntry(b, buildingMap, machineFrameParity(worldAnimMs(Date.now())), lookupCurrentTile) ||
      farmPlotEntry(b) || statueEntry(b) || buildingEntry(b);
    if (!e || e === MISSING_BUILDING || e.hidden || !e.sheet) return 0;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * (Number.isFinite(Number(o.alpha)) ? Number(o.alpha) : 128 / 255);
    let drawn = 0;
    try {
      if (typeof e.col === "number" && typeof e.row === "number") {
        if (blitCell(e.sheet, e.col, e.row, o.px, o.py, cell, e.palRow, true)) drawn++;
      } else if (Array.isArray(e.cells)) {
        for (let ry = 0; ry < e.cells.length; ry++) {
          const row = e.cells[ry];
          if (!Array.isArray(row)) continue;
          for (let rx = 0; rx < row.length; rx++) {
            const c = row[rx];
            if (!c || typeof c.col !== "number" || typeof c.row !== "number") continue;
            if (blitCell(e.sheet, c.col, c.row, o.px + rx * cell, o.py + ry * cell, cell,
              c.palRow != null ? c.palRow : e.palRow, true)) drawn++;
          }
        }
      }
    } finally {
      ctx.globalAlpha = prevAlpha;
    }
    return drawn;
  }
  // Footprint art can be TALLER than the footprint by one row, so a caller needs both numbers to anchor.
  function buildingGhostExtent(b) {
    if (!b || !buildingMap) return null;
    const e = machineEntry(b, buildingMap, machineFrameParity(worldAnimMs(Date.now())), lookupCurrentTile) ||
      farmPlotEntry(b) || statueEntry(b) || buildingEntry(b);
    if (!e || e === MISSING_BUILDING || e.hidden || !e.sheet) return null;
    if (typeof e.col === "number" && typeof e.row === "number") return { w: 1, h: 1 };
    if (!Array.isArray(e.cells) || !e.cells.length) return null;
    let w = 0;
    for (const row of e.cells) if (Array.isArray(row)) w = Math.max(w, row.length);
    return w > 0 ? { w, h: e.cells.length } : null;
  }

  const MACHINE_TYPES = { ScrewPump: 1, WaterWheel: 1, Windmill: 1, AxleHorizontal: 1, AxleVertical: 1, GearAssembly: 1, Rollers: 1 };
  const WINDMILL_DIR8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const SCREWPUMP_DIR4 = ["N", "E", "S", "W"];
  function machineFamilyKey(b) {
    const dir = (typeof b.dir === "number") ? b.dir : 0;
    switch (b.type) {
      case "ScrewPump": return "SCREWPUMP_" + SCREWPUMP_DIR4[dir & 3];
      case "WaterWheel": return dir ? "WATER_WHEEL_NS" : "WATER_WHEEL_WE";
      case "AxleHorizontal": return dir ? "AXLE_HORIZONTAL_NS" : "AXLE_HORIZONTAL_WE";
      case "AxleVertical": return "AXLE_VERTICAL";
      case "GearAssembly": return "GEAR_ASSEMBLY";
      case "Windmill": return "WINDMILL_" + WINDMILL_DIR8[dir & 7];
      default: return null;
    }
  }
  function hasDrawableMachine(buildings) {
    if (!Array.isArray(buildings)) return false;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (b && MACHINE_TYPES[b.type] && (typeof b.bst === "number") && (b.bst & 1)) return true;
    }
    return false;
  }

  function machineTrackSuffix(mask) {
    let s = "";
    if (mask & 1) s += "N"; if (mask & 2) s += "S";
    if (mask & 8) s += "W"; if (mask & 4) s += "E";
    return s || "NSWE";
  }
  function machineLayerGrid(w, h) {
    const grid = [];
    for (let y = 0; y < h; y++) { const row = []; for (let x = 0; x < w; x++) row.push(null); grid.push(row); }
    return grid;
  }
  function barsVerticalEntry(b, map) {
    const table = map && map.machine_variants && map.machine_variants.bars_vertical;
    if (!b || b.type !== "BarsVertical" || !table) return null;
    // `blayer` is the oracle/test seam; live AUX carries the gate state.
    const key = (typeof b.blayer === "string") ? b.blayer : ((b.bst & 1) ? "N_SIGNPOST" : "FLOOR");
    const src = table[key];
    if (!Array.isArray(src) || src.length === 0) return null;
    const e = { sheet: src[0].sheet, w: 1, h: 1, cells: [[{ col: src[0].col, row: src[0].row }]] };
    if (src.length > 1) e.layers = src.slice(1).map(c => ({ sheet: c.sheet, tint: true, cells: [[{ col: c.col, row: c.row }]] }));
    return e;
  }
  function rollerEntry(b, map, frameParity, tileLookup) {
    const table = map && map.machine_variants && map.machine_variants.rollers;
    if (!b || b.type !== "Rollers" || !table) return null;
    const material = (matFamilyForItem(b) === "WOOD") ? "WOOD" : "STONE";
    const fallbackMask = ((b.dir | 0) & 1) ? 12 : 3; // E/W drive -> WE rail; N/S -> NS.
    const tile = (typeof tileLookup === "function") ? tileLookup(b.x1, b.y1) : null;
    const liveMask = tile ? constructionTrackMask(tile.ttname) : 0;
    const mask = (typeof b.track === "number") ? b.track : (liveMask || fallbackMask);
    const shape = machineTrackSuffix(mask);
    const fam = table[material] && table[material][shape];
    if (!fam || !Array.isArray(fam.frames)) return null;
    const active = (typeof b.bst === "number") && (b.bst & 1);
    const fi = active ? ((((frameParity | 0) % fam.frames.length) + fam.frames.length) % fam.frames.length) : 0;
    const c = fam.frames[fi] || fam.frames[0];
    return c ? { sheet: fam.sheet, w: 1, h: 1, cells: [[{ col: c.col, row: c.row }]] } : null;
  }
  function machineEntry(b, map, frameParity, tileLookup) {
    if (!b || !map) return null;
    const bars = barsVerticalEntry(b, map); if (bars) return bars;
    const rollers = rollerEntry(b, map, frameParity, tileLookup); if (rollers) return rollers;
    if (!map.machines || !MACHINE_TYPES[b.type]) return null;
    const key = machineFamilyKey(b);
    const fam = key && map.machines[key];
    if (!fam || !Array.isArray(fam.frames) || fam.frames.length === 0) return null;
    const active = (typeof b.bst === "number") && (b.bst & 1);
    const fi = active ? (((frameParity | 0) % fam.frames.length + fam.frames.length) % fam.frames.length) : 0;
    const frame = fam.frames[fi] || fam.frames[0];
    if (!Array.isArray(frame) || frame.length === 0) return null;
    const fpw = Math.max(1, (b.x2 | 0) - (b.x1 | 0) + 1);
    const placed = [];
    let gw = 1, gh = 1;
    for (let i = 0; i < frame.length; i++) {
      const c = frame[i]; const s = c.sub || []; let dx, dy;
      if (s.length >= 2) { dx = (s[0] | 0); dy = (s[1] | 0); }
      else if (s.length === 1) { const idx = (s[0] | 0); dx = idx % fpw; dy = Math.floor(idx / fpw); }
      else { dx = 0; dy = 0; }
      if (dx + 1 > gw) gw = dx + 1; if (dy + 1 > gh) gh = dy + 1;
      placed.push({ dx: dx, dy: dy, col: c.col, row: c.row });
    }
    const cells = machineLayerGrid(gw, gh);
    for (let i = 0; i < placed.length; i++) { const p = placed[i]; cells[p.dy][p.dx] = { col: p.col, row: p.row }; }
    const e = { sheet: fam.sheet, w: gw, h: gh, cells: cells };
    const companions = map.machine_variants && map.machine_variants.companions;
    let layerKey = companions && companions[key];
    let layerAt = 0;
    if (b.type === "ScrewPump") {
      layerKey = companions && companions.SCREWPUMP;
      const hasAxle = (typeof b.maxle === "boolean") ? b.maxle : b.built !== false;
      const pumpDir = key.slice("SCREWPUMP_".length);
      if (!hasAxle || pumpDir === "S") layerKey = null; // S has no secondary-axle compositor arm.
      else layerAt = (pumpDir === "E") ? 0 : 1;         // E:first tile; N/W:second tile.
    }
    const layerFam = layerKey && map.machines[layerKey];
    const layerFrame = layerFam && layerFam.frames && (layerFam.frames[fi] || layerFam.frames[0]);
    if (Array.isArray(layerFrame) && layerFrame.length) {
      const grid = machineLayerGrid(gw, gh);
      const dx = layerAt % fpw, dy = Math.floor(layerAt / fpw);
      if (grid[dy] && dx < grid[dy].length) grid[dy][dx] = { col: layerFrame[0].col, row: layerFrame[0].row };
      e.layers = [{ sheet: layerFam.sheet, tint: false, cells: grid }];
    }
    return e;
  }
  // ~2 Hz machine animation; ?freezeAnim=1 pins it for deterministic parity captures.
  const MACHINE_ANIM_MS = 500;
  let _machineFreezeAnim = false;
  try { _machineFreezeAnim = /[?&]freezeAnim=1\b/.test(location.search || ""); } catch (_e) { }
  function machineAnimPhase(nowMs) {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) nowMs = Date.now();
    return Math.floor(nowMs / MACHINE_ANIM_MS);
  }
  function machineFrameParity(nowMs) {
    return _machineFreezeAnim ? 0 : (machineAnimPhase(nowMs) % 2);
  }
  function _animClockOffset(wallMs) {
    try {
      var c = (typeof window !== "undefined") && window.DFAnimClock;
      if (c && typeof c.offset === "function") return c.offset(wallMs) || 0;
    } catch (_e) { /* inert-graceful */ }
    return 0;
  }
  function worldAnimMs(wallMs) {
    // ?freezeAnim=1 pins the whole world clock, not only machines: two captures of one scene must be
    // pixel-identical. A fixed NON-ZERO instant is returned so cadence maths keeps a real phase.
    if (_machineFreezeAnim) return 1000;
    var b = (typeof wallMs === "number" && Number.isFinite(wallMs)) ? wallMs
      : ((window.performance && performance.now) ? performance.now() : Date.now());
    return b - _animClockOffset(b);
  }
  function uiAnimMs(wallMs) {
    if (_machineFreezeAnim) return 1000;
    return (typeof wallMs === "number" && Number.isFinite(wallMs)) ? wallMs
      : ((window.performance && performance.now) ? performance.now() : Date.now());
  }
  function machineCadenceStep(buildings, nowMs, lastPhase, freezeAnim) {
    if (freezeAnim || !hasDrawableMachine(buildings)) return { phase: -1, dirty: false };
    const phase = machineAnimPhase(nowMs);
    return { phase, dirty: phase !== lastPhase };
  }

  const FARM_EMPTY = 0xFFFF;
  function farmCellRef(token) {
    const s = spriteMap && spriteMap[token];
    return (s && s.sheet) ? s : null;
  }
  function farmPlotEntry(b) {
    if (!b || b.type !== "FarmPlot" || !spriteMap) return null;
    const hasExtra = typeof b.bextra === "number";
    const planted = hasExtra && b.bextra !== FARM_EMPTY;
    if (planted) {
      const p = farmCellRef("FARMPLOT_PLANTED") || farmCellRef("FARMPLOT") || farmCellRef("FURROWED_SOIL_1");
      if (!p) return null;
      return { sheet: p.sheet, w: 1, h: 1, cells: [[{ col: p.col, row: p.row }]] };
    }
    const fur = [];
    for (let i = 1; i <= 4; i++) { const c = farmCellRef("FURROWED_SOIL_" + i); if (c) fur.push(c); }
    if (!fur.length) {
      const f = farmCellRef("FARMPLOT");
      if (!f) return null;
      return { sheet: f.sheet, w: 1, h: 1, cells: [[{ col: f.col, row: f.row }]] };
    }
    const x1 = b.x1 | 0, y1 = b.y1 | 0;
    const w = Math.max(1, (b.x2 | 0) - x1 + 1), h = Math.max(1, (b.y2 | 0) - y1 + 1);
    const cells = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) { const c = fur[hashXY(x1 + x, y1 + y) % fur.length]; row.push({ col: c.col, row: c.row }); }
      cells.push(row);
    }
    return { sheet: fur[0].sheet, w: w, h: h, cells: cells };
  }

  function farmCropPlans(tiles, width, height, map) {
    const policy = window.DwfFarmCrops;
    return policy && typeof policy.collect === "function"
      ? policy.collect(tiles, width, height, map || plantMap)
      : [];
  }
  function drawFarmCrops(tiles, width, height, cell) {
    const plans = farmCropPlans(tiles, width, height, plantMap);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i], c = p.cell;
      blitCell(c.sheet, c.col, c.row, p.gx * cell, p.gy * cell, cell);
    }
  }
  function paintFarmLayers(paintBuildings, paintCrops) {
    const policy = window.DwfFarmCrops;
    if (policy && typeof policy.paintAboveBuildings === "function")
      policy.paintAboveBuildings(paintBuildings, paintCrops);
    else { paintBuildings(); paintCrops(); }
  }

  // ---- OVERLAY LAYER (wire:5): designations + presence, above terrain/objects/creatures ----

  // ---- (A) DESIGNATIONS ------------------------------------------------------------
  const DESIG_SHEET = "designations.png";
  const DESIG_CELL = {
    dig: [0, 1], channel: [0, 2], stairUp: [0, 3], stairDown: [0, 4],
    stairUpDown: [0, 5], ramp: [0, 6], removeConstruction: [0, 7], chop: [0, 8],
    gather: [0, 9], smooth: [0, 10], engrave: [0, 11], fortify: [0, 12],
    trafficLow: [0, 13], trafficHigh: [0, 14], trafficRes: [0, 15],
  };
  const MINING_SHEET = "mining_indicators.png";
  const MINING_CELL = { damp: [0, 0], warm: [1, 0] };

  // ---- tool-state overlay gate -----------------------------------------------------------
  const TOOL_STATE_OVERLAYS = { mining: false, traffic: false };
  function setToolStateOverlayTiles(kind, on) {
    return window.DwfDesignationJob.setToolStateOverlay(TOOL_STATE_OVERLAYS, kind, on);
  }
  function toolStateOverlayVisibleTiles(kind) {
    return window.DwfDesignationJob.toolStateOverlayVisible(TOOL_STATE_OVERLAYS, kind);
  }
  function setMineMode(on) { setToolStateOverlayTiles("mining", on); }
  function miningIndicatorCell(t, on) {
    if (!on || !t || t.hidden) return null;
    if ((t.shape || "") !== "WALL") return null;
    if (t.damp) return MINING_CELL.damp;
    if (t.warm) return MINING_CELL.warm;
    return null;
  }

  // carve-track adjacency mask (N=1 S=2 E=4 W=8) -> designations.png col-1 cell.
  const DESIG_TRACK_CELL = {
    1: [1, 0], 2: [1, 1], 8: [1, 2], 4: [1, 3], 3: [1, 4], 9: [1, 5], 5: [1, 6],
    10: [1, 7], 6: [1, 8], 12: [1, 9], 11: [1, 10], 7: [1, 11], 13: [1, 12],
    14: [1, 13], 15: [1, 14],
  };
  // Category colour prefix for the synthetic wash/outline (alpha appended per use); automining
  // uses a whole-sprite multiply instead and has no entry here.
  const DESIG_TINT = {
    dig: "rgba(240,150,40,",
    channel: "rgba(200,105,20,", ramp: "rgba(240,175,60,",
    stair: "rgba(240,195,75,", chop: "rgba(215,150,45,", gather: "rgba(120,200,90,",
    smooth: "rgba(90,150,235,", engrave: "rgba(80,215,225,", traffic: "rgba(225,205,80,",
    track: "rgba(185,140,90,", fortify: "rgba(90,150,235,",
    removeConstruction: "rgba(220,110,55,",
  };
  // Pure green multiplies the complete translucent designation cell -- not a wash under a normal pick.
  const AUTOMINE_SPRITE_TINT = [0, 255, 0];
  const CHOP_PLANT_PART = new Set(["TRUNK", "BRANCH", "CANOPY", "LEAVES", "SAPLING"]);
  const DESIG_WASH_ALPHA = 0.28, DESIG_WASH_ALPHA_MARKER = 0.5;
  const MARKER_RECOLOR = [0.43, 0.68, 1.0];   // fitted native per-channel multiply (blue exact)
  const MARKER_GLYPH_TINT = [110, 173, 255];  // round(255*MARKER_RECOLOR): glyph multiply tint
  const MARKER_WASH_RGB = [32, 50, 78];       // native measured marker-wash colour (flat cell)
  const MARKER_WASH_CSS = "rgba(" + MARKER_WASH_RGB[0] + "," + MARKER_WASH_RGB[1] + "," + MARKER_WASH_RGB[2] + ",";
  const MARKER_OUTLINE_CSS = "rgba(" + MARKER_GLYPH_TINT[0] + "," + MARKER_GLYPH_TINT[1] + "," + MARKER_GLYPH_TINT[2] + ",";

  function resolveDjobTiles(k, t) {
    return window.DwfDesignationJob.resolve(k, t, DESIG_CELL, DESIG_TRACK_CELL);
  }

  // dig=="Default" means "dig / fell tree / gather plant", disambiguated by the tile's material/shape.
  function resolveDesig(d, t) {
    if (!d) return null;
    const dig = d.dig;
    if (dig && dig !== "No") {
      switch (dig) {
        case "Channel": return { cell: DESIG_CELL.channel, cat: "channel" };
        case "Ramp": return { cell: DESIG_CELL.ramp, cat: "ramp" };
        case "UpStair": return { cell: DESIG_CELL.stairUp, cat: "stair" };
        case "DownStair": return { cell: DESIG_CELL.stairDown, cat: "stair" };
        case "UpDownStair": return { cell: DESIG_CELL.stairUpDown, cat: "stair" };
        default: {
          const mat = t.mat || "", shape = t.shape || "";
          const plantPart = (t.plant && t.plant.part) || "";
          if (mat === "CONSTRUCTION")
            return { cell: DESIG_CELL.removeConstruction, cat: "removeConstruction" };
          // Never treat an arbitrary plant tail as gather: tree roots are shape=WALL/mat=ROOT with a TRUNK tail.
          if (mat === "TREE" || mat === "ROOT" || CHOP_PLANT_PART.has(plantPart) ||
            shape.indexOf("TRUNK") !== -1 || shape === "BRANCH" || shape === "TWIG" || shape === "SAPLING")
            return { cell: DESIG_CELL.chop, cat: "chop" };
          if (shape === "SHRUB" || mat === "PLANT" || plantPart === "SHRUB")
            return { cell: DESIG_CELL.gather, cat: "gather" };
          return { cell: DESIG_CELL.dig, cat: d.automine ? "automine" : "dig" };
        }
      }
    }
    if (d.smooth === 2) return { cell: DESIG_CELL.engrave, cat: "engrave" };
    if (d.smooth === 1) return { cell: DESIG_CELL.smooth, cat: "smooth" };
    if (d.track) { const c = DESIG_TRACK_CELL[d.track & 15]; if (c) return { cell: c, cat: "track" }; }
    // Traffic is pure tool state: native paints its marks ONLY while a traffic mode is the active tool.
    // Traffic 0 (Normal) has no sprite at all -- Normal is the absence of a mark, so there is no case for it.
    if (toolStateOverlayVisibleTiles("traffic")) {
      if (d.traffic === 1) return { cell: DESIG_CELL.trafficLow, cat: "traffic" };
      if (d.traffic === 2) return { cell: DESIG_CELL.trafficHigh, cat: "traffic" };
      if (d.traffic === 3) return { cell: DESIG_CELL.trafficRes, cat: "traffic" };
    }
    return null;
  }

  function resolveTileDesignation(t, djobKind) {
    const d = t && t.desig;
    let glyph = d ? resolveDesig(d, t) : null;
    if (!glyph && djobKind) glyph = resolveDjobTiles(djobKind, t);
    return glyph ? { glyph, marker: d ? !!d.marker : false } : null;
  }

  function drawDesignation(t, px, py, cell, djobKind, nowMs, hasWorker, unitOnTile) {
    try {
      // map bits win; a claimed designation job is the authoritative fallback
      const resolved = resolveTileDesignation(t, djobKind);
      if (!resolved) return;
      const r = resolved.glyph, marker = resolved.marker;
      const glyphVisible = designationGlyphVisible(djobKind, nowMs, hasWorker, unitOnTile);
      if (r.cat !== "automine" && (t.hidden || (t.shape || "") === "WALL")) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = "rgb(27,29,26)";
        ctx.fillRect(px, py, cell, cell);
        ctx.restore();
      }
      const tint = DESIG_TINT[r.cat] || DESIG_TINT.dig;
      if (marker || r.cat !== "automine") {
        ctx.fillStyle = marker ? (MARKER_WASH_CSS + DESIG_WASH_ALPHA_MARKER + ")") : (tint + DESIG_WASH_ALPHA + ")");
        ctx.fillRect(px, py, cell, cell);
      }
      if (glyphVisible) {
        const s = getSheet(DESIG_SHEET);
        let blitted = false;
        if (s && s.loaded && !s.failed) {
          const spriteTint = marker ? MARKER_GLYPH_TINT : (r.cat === "automine" ? AUTOMINE_SPRITE_TINT : null);
          const tc = spriteTint ? multiplyTintedCell(DESIG_SHEET, r.cell[0], r.cell[1], spriteTint) : null;
          if (tc) {
            ctx.drawImage(tc, 0, 0, 32, 32, px, py, cell, cell);
          } else {
            ctx.drawImage(s.img, r.cell[0] * 32, r.cell[1] * 32, 32, 32, px, py, cell, cell);
          }
          blitted = true;
        }
        if (!blitted && cell >= 4) drawDesigSynthetic(r.cat, px, py, cell);
        drawDesigPriority(t, px, py, cell);
      }
      if (cell >= 4) {
        ctx.save();
        ctx.strokeStyle = marker ? (MARKER_OUTLINE_CSS + "0.9)") : (tint + "0.9)");
        ctx.lineWidth = marker ? 1 : 1.5;
        ctx.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);
        ctx.restore();
      }
    } catch (_) { /* overlay guarded */ }
  }

  function drawMiningIndicator(t, px, py, cell) {
    try {
      const mc = miningIndicatorCell(t, toolStateOverlayVisibleTiles("mining"));
      if (!mc) return;
      const s = getSheet(MINING_SHEET);
      if (!s || !s.loaded || s.failed) return;
      ctx.drawImage(s.img, mc[0] * 32, mc[1] * 32, 32, 32, px, py, cell, cell);
    } catch (_) { /* overlay guarded */ }
  }

  function drawDesigSynthetic(cat, px, py, cell) {
    const cx = px + cell / 2, cy = py + cell / 2, r = Math.max(2, cell * 0.28);
    ctx.save();
    ctx.strokeStyle = cat === "automine" ? "rgb(0,255,0)" : "rgba(18,14,8,0.92)";
    ctx.lineWidth = Math.max(1, cell / 12);
    ctx.beginPath();
    if (cat === "dig" || cat === "automine" || cat === "chop") {
      ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);            // pick shaft
      ctx.moveTo(cx + r * 0.35, cy - r); ctx.lineTo(cx + r, cy - r * 0.35); // pick head
    } else if (cat === "channel") {
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx, cy + r); ctx.lineTo(cx + r, cy - r);
    } else if (cat === "ramp" || cat === "stair") {
      ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    } else if (cat === "gather") {
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    } else if (cat === "smooth" || cat === "engrave") {
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      if (cat === "engrave") { ctx.moveTo(cx - r, cy + r * 0.5); ctx.lineTo(cx + r, cy + r * 0.5); }
    } else {                                                            // traffic / track
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawDesigPriority(t, px, py, cell) {
    try {
      const dp = t.desigPriority;
      if (!dp || !overlayMap || !overlayMap.designation_priority) return;
      const lvl = dp.priority | 0;
      if (lvl < 1 || lvl > 7) return;
      const e = overlayMap.designation_priority[String(lvl)];
      if (!e || !e.sheet) return;
      const s = getSheet(e.sheet);
      if (!s || !s.loaded || s.failed) return;
      const sz = Math.max(8, Math.round(cell * 0.55));
      ctx.drawImage(s.img, e.col * 32, e.row * 32, 32, 32, px + cell - sz, py + cell - sz, sz, sz);
    } catch (_) { /* overlay guarded */ }
  }

  function itemMarkToken(iflags) {
    if (!iflags) return null;
    const forbid = iflags & 0x02, dump = iflags & 0x04, melt = iflags & 0x08;
    if (forbid && melt) return "DESIGNATION_ITEM_FORBIDDEN_MELT";
    if (forbid && dump) return "DESIGNATION_ITEM_FORBIDDEN_DUMP";
    if (forbid) return "DESIGNATION_ITEM_FORBIDDEN";
    if (melt) return "DESIGNATION_ITEM_MELT";
    if (dump) return "DESIGNATION_ITEM_DUMP";
    return null;
  }
  let spIndex = null, spIndexSig = "";
  let spRefBuildings = null, spRefOz = null, spRefPaintRev = null;
  function paintSessionRevision() {
    try { return window.DwfPaintSession ? window.DwfPaintSession.revision() : -1; } catch (_) { return -1; }
  }
  function stockpileIndexFor(buildings, oz) {
    const B = (typeof window !== "undefined") && window.DwfOverlayBoxes;
    if (!B || typeof B.stockpileLayerIndex !== "function") return null;
    const paintRev = paintSessionRevision();
    if (buildings === spRefBuildings && oz === spRefOz && paintRev === spRefPaintRev) return spIndex;
    spRefBuildings = buildings; spRefOz = oz; spRefPaintRev = paintRev;
    let sig = String(oz) + "|" + (Array.isArray(buildings) ? buildings.length : -1);
    if (Array.isArray(buildings)) {
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i];
        if (!b || b.type !== "Stockpile") continue;
        sig += ";" + b.id + "," + b.x1 + "," + b.y1 + "," + b.x2 + "," + b.y2 + "," + b.z +
          "," + (typeof b.ext === "string" ? b.ext.length + ":" + b.ext : "-");
      }
    }
    sig += "|p" + paintRev;
    if (sig !== spIndexSig) { spIndexSig = sig; spIndex = B.stockpileLayerIndex(buildings, oz); }
    return spIndex;
  }
  // z is the plane the frame is drawing, never a building's own z -- the index already filtered on that.
  function stockpileTileAt(t, gx, gy) {
    const buildings = lastAux && lastAux.buildings;
    if (!buildings || !buildings.length || !geom) return null;
    const idx = stockpileIndexFor(buildings, geom.oz);
    if (!idx || !idx.size) return null;
    const wx = (t && typeof t.x === "number") ? t.x : (geom.ox + gx);
    const wy = (t && typeof t.y === "number") ? t.y : (geom.oy + gy);
    return idx.get(wx + "," + wy) || null;
  }
  // Colour is baked into the art: these blits never tint, fade or recolour.
  function drawStockpilePieces(tokens, px, py, cell) {
    const B = window.DwfOverlayBoxes;
    if (!tokens || !tokens.length || !B) return;
    for (let i = 0; i < tokens.length; i++) {
      const spec = B.stockpileCells[tokens[i]];
      if (spec) blitCell("stockpile.png", spec.col, spec.row, px, py, cell);
    }
  }
  function drawStockpileFloor(t, px, py, cell, gx, gy) {
    const e = stockpileTileAt(t, gx, gy);
    if (e) drawStockpilePieces(e.floor, px, py, cell);
  }
  function drawStockpileRope(t, px, py, cell, gx, gy) {
    const e = stockpileTileAt(t, gx, gy);
    if (e) drawStockpilePieces(e.rope, px, py, cell);
  }

  function drawItemMark(t, px, py, cell) {
    try {
      if (!t.item || !overlayMap || !overlayMap.designation_item) return;
      const token = itemMarkToken(t.item.iflags);
      if (!token) return;
      const e = overlayMap.designation_item[token];
      if (!e || !e.sheet) return;
      const s = getSheet(e.sheet);
      if (!s || !s.loaded || s.failed) return;
      const sz = Math.max(8, Math.round(cell * 0.55));
      ctx.drawImage(s.img, e.col * 32, e.row * 32, 32, 32, px, py, sz, sz);
    } catch (_) { /* overlay guarded */ }
  }

  function projCenterPx(worldCoord, originCoord, fraw, cell) {
    const off = ((typeof fraw === "number" ? fraw : 128) - 128) / 255; // -0.5..+0.5 tiles
    return (worldCoord - originCoord + 0.5 + off) * cell;
  }
  function projItemVisual(p) {
    if (!p || typeof p.item_type !== "number" || p.item_type < 0) return null;
    const type = itemTypeNames && itemTypeNames.get(p.item_type);
    if (!type) return null;
    const v = resolveItemVisual({
      type,
      subtype: typeof p.subtype === "number" ? p.subtype : -1,
      mat_type: typeof p.mat_type === "number" ? p.mat_type : -1,
      mat_index: typeof p.mat_index === "number" ? p.mat_index : -1,
      iflags: 0,
    });
    return (v && v.entry && v.entry.sheet && v.source !== "missing") ? v : null;
  }
  function drawProjectiles(data, ox, oy, oz, cell) {
    const projs = Array.isArray(data.proj) ? data.proj : [];
    if (!projs.length) return;
    for (let i = 0; i < projs.length; i++) {
      const p = projs[i];
      if (!p) continue;
      // A below-camera projectile renders when the SERVER proved an open column (p.sd), fog-dimmed by depth.
      // Untagged off-z projectiles are still dropped: those are stale cross-z AUX records.
      const pdz = (typeof p.z === "number" && typeof oz === "number") ? p.z - oz : 0;
      const seeDownP = !!p.sd && pdz < 0;
      if (pdz !== 0 && !seeDownP) continue;
      ctx.save();
      if (seeDownP) ctx.globalAlpha = ctx.globalAlpha * Math.max(0.55, 1 - fogAlphaForDepth(-pdz));
      try {
        const cx = projCenterPx(p.x, ox, p.fx, cell), cy = projCenterPx(p.y, oy, p.fy, cell);
        let drewArt = false;
        if (!p.vehicle) {
          const v = projItemVisual(p);
          if (v) {
            const it = { type: v.entry && itemTypeNames.get(p.item_type), mat_type: p.mat_type, mat_index: p.mat_index };
            let palRow;
            if (materialMap && PALETTIZABLE_SOURCE[v.source]) {
              const pr = matPalRowFor(it);
              if (typeof pr === "number") palRow = pr;
            }
            const px = cx - cell / 2, py = cy - cell / 2;
            if (blitCell(v.entry.sheet, v.entry.col, v.entry.row, px, py, cell, palRow, true)) {
              if (palRow === undefined) drawItemTint(p.mat_type, px, py, cell);
              drewArt = true;   // art drew -- no placeholder marker on top of it
            }
          }
        }
        if (drewArt) continue;
        ctx.save();
        if (p.vehicle) {
          // minecart/vehicle: a small filled square outline.
          const s = Math.max(3, cell * 0.5);
          ctx.fillStyle = "rgba(180,150,90,0.9)";
          ctx.strokeStyle = "rgba(40,30,10,0.9)";
          ctx.lineWidth = 1;
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
          ctx.strokeRect(cx - s / 2 + 0.5, cy - s / 2 + 0.5, s - 1, s - 1);
        } else {
          // projectile (bolt/stone/etc.): a bright dot with a dark outline.
          const rr = Math.max(1.5, cell * 0.16);
          ctx.beginPath();
          ctx.arc(cx, cy, rr, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(250,240,200,0.95)";
          ctx.fill();
          ctx.strokeStyle = "rgba(30,20,10,0.9)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.restore();
      } catch (_) { /* per-projectile guarded */
      } finally { ctx.restore(); }   // pairs the see-down alpha save; runs on the `continue` too
    }
  }

  // ---- flow clouds (miasma/smoke/mist/...) ----------------------------------------
  var FLOW_STYLES = {
    0: { token: "FLOW_MIASMA", rgb: [150, 64, 176] },   // Miasma: native EVENT_FLOWS art
  };
  function flowOverlayFor(cloud, nowMs) {
    if (!cloud || typeof cloud.type !== "number") return null;
    var style = FLOW_STYLES[cloud.type];
    var d = typeof cloud.density === "number" ? cloud.density : 0;
    if (!style || d <= 0) return null;
    var a = 0.2 + 0.55 * Math.min(1, d / 64);   // fallback-haze alpha
    var sa = 0.9;
    if (!unitStatusBlinkVisible(nowMs)) { a *= 0.78; sa *= 0.85; }
    return { token: style.token || null, rgb: style.rgb, alpha: a, spriteAlpha: sa };
  }
  function resolveFlowFrameCell(token, nowMs) {
    var entry = spriteMap && spriteMap[token];
    if (!entry || !entry.sheet) return null;
    var sheet = getSheet(entry.sheet);
    if (!sheet || !sheet.loaded || sheet.failed) return null;
    var frames = entry.frames;
    if (frames && frames.length > 1) {
      var fi = Math.floor((nowMs / 1000) * 4) % frames.length;
      var f = frames[fi] || frames[0];
      if (f && typeof f.col === "number") return { img: sheet.img, col: f.col, row: f.row };
    }
    return { img: sheet.img, col: entry.col, row: entry.row };
  }
  function drawFlows(tiles, n, gw, cell, nowMs) {
    for (var i = 0; i < n; i++) {
      var t = tiles[i];
      if (!t || !t.cloud || t.hidden) continue;
      var plan = flowOverlayFor(t.cloud, nowMs);
      if (!plan) continue;
      var a = plan.alpha, sa = plan.spriteAlpha;
      if (typeof t.depth === "number" && t.depth > 0) {
        var dim = Math.max(0.35, 1 - 0.12 * t.depth); a *= dim; sa *= dim;
      }
      var gx = i % gw, gy = (i - gx) / gw;
      var px = gx * cell, py = gy * cell;
      try {
        // DF's own authored miasma art (EVENT_FLOWS FLOW_MIASMA) when the sheet is loaded.
        var fs = plan.token ? resolveFlowFrameCell(plan.token, nowMs) : null;
        if (fs) {
          var prevA = ctx.globalAlpha;
          ctx.globalAlpha = Math.max(0, Math.min(1, sa));
          ctx.drawImage(fs.img, fs.col * 32, fs.row * 32, 32, 32, px, py, cell, cell);
          ctx.globalAlpha = prevA;
          continue;
        }
        // Fallback (sheet not loaded / headless): the procedural purple haze.
        var cx = px + cell * 0.5, cy = py + cell * 0.5;
        var rr = cell * 0.72;   // bleeds slightly past the cell so adjacent clouds merge
        var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        grad.addColorStop(0, "rgba(" + plan.rgb[0] + "," + plan.rgb[1] + "," + plan.rgb[2] + "," + a.toFixed(3) + ")");
        grad.addColorStop(0.62, "rgba(" + plan.rgb[0] + "," + plan.rgb[1] + "," + plan.rgb[2] + "," + (a * 0.6).toFixed(3) + ")");
        grad.addColorStop(1, "rgba(" + plan.rgb[0] + "," + plan.rgb[1] + "," + plan.rgb[2] + ",0)");
        ctx.fillStyle = grad;
        ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
      } catch (_) { /* per-cloud guarded */ }
    }
  }

  // ---- (B) MULTIPLAYER PRESENCE ----------------------------------------------------
  function playerColor(name) {
    let h = 2166136261 >>> 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    // Math.imul yields a SIGNED int32, so normalize the signed value the CSS way -- dwf-gl.js's
    // playerColorRgb normalizes the same value, and any other convention rotates half of all hues.
    const hue = ((h % 360) + 360) % 360;
    return { fill: `hsl(${hue},85%,58%)`, dark: `hsl(${hue},60%,24%)` };
  }

  // Route every raw session-key name through the one canonical DwfLobby.displayName anonymizer.
  function presenceLabel(name) {
    try {
      if (window.DwfLobby && typeof DwfLobby.displayName === "function")
        return DwfLobby.displayName(name).text;
    } catch (_) {}
    return String(name == null ? "" : name);
  }

  // Publishes the connected-player roster to non-GL UI via window.DwfPresence.onChange(cb).
  // Created EAGERLY at load: this file loads before its consumers, whose bindings must not miss it.
  (function ensurePresence() {
    try {
      if (window.DwfPresence) return;
      const subs = [];
      window.DwfPresence = {
        roster: [],
        onChange(cb) { if (typeof cb === "function") { subs.push(cb); try { cb(this.roster); } catch (_) {} } },
        _emit(next) {
          this.roster = Array.isArray(next) ? next : [];
          for (let i = 0; i < subs.length; i++) { try { subs[i](this.roster); } catch (_) {} }
        },
      };
    } catch (_) { /* non-browser context */ }
  })();
  function publishRoster(list) {
    try {
      const P = window.DwfPresence;
      if (P && typeof P._emit === "function") P._emit(Array.isArray(list) ? list : []);
    } catch (_) { /* presence surface is best-effort; never break the render path */ }
  }

  function drawPresence(data, ox, oy, oz, cell, gw, gh) {
    const players = Array.isArray(data.players) ? data.players : [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.name === player) continue;               // never draw our own cursor
      // A roster entry can be cursor-less: without numeric x/y the tile math yields NaN, which slips
      // through the window guard and paints at NaN.
      if (typeof p.x !== "number" || typeof p.y !== "number") continue;
      try {
        const col = playerColor(p.name);
        const sameZ = (typeof p.z !== "number") || p.z === oz;
        // (1) their drag rectangle (in-progress designation), in their color.
        if (p.drag && typeof p.dx === "number" && typeof p.dy === "number") {
          const gx0 = Math.min(p.x, p.dx) - ox, gy0 = Math.min(p.y, p.dy) - oy;
          const gx1 = Math.max(p.x, p.dx) - ox + 1, gy1 = Math.max(p.y, p.dy) - oy + 1;
          const rx = gx0 * cell, ry = gy0 * cell, rw = (gx1 - gx0) * cell, rh = (gy1 - gy0) * cell;
          ctx.save();
          ctx.fillStyle = col.fill; ctx.globalAlpha = sameZ ? 0.16 : 0.08;
          ctx.fillRect(rx, ry, rw, rh);
          ctx.globalAlpha = sameZ ? 0.9 : 0.4;
          ctx.strokeStyle = col.fill; ctx.lineWidth = 2;
          ctx.strokeRect(rx + 1, ry + 1, Math.max(1, rw - 2), Math.max(1, rh - 2));
          ctx.restore();
        }
        // (2) cursor marker + name label at their tile.
        const tx = p.x - ox, ty = p.y - oy;
        if (tx < -1 || ty < -1 || tx > gw || ty > gh) continue;   // outside our window
        const cxp = tx * cell, cyp = ty * cell;
        ctx.save();
        ctx.globalAlpha = sameZ ? 1 : 0.5;
        ctx.strokeStyle = col.fill; ctx.lineWidth = 2;
        ctx.strokeRect(cxp + 1, cyp + 1, Math.max(1, cell - 2), Math.max(1, cell - 2));
        // caret in the top-left corner so the exact tile is unambiguous
        ctx.fillStyle = col.fill;
        const cs = Math.min(12, cell * 0.6);
        ctx.beginPath();
        ctx.moveTo(cxp, cyp); ctx.lineTo(cxp + cs, cyp); ctx.lineTo(cxp, cyp + cs); ctx.closePath(); ctx.fill();
        // name (+ up/dn when on another z-level)
        let label = presenceLabel(p.name) || "?";
        if (label.length > 14) label = label.slice(0, 13) + "…";
        if (!sameZ) label += (p.z > oz ? " ↑" : " ↓");
        ctx.font = "11px monospace";
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        const tw = ctx.measureText(label).width;
        const lx = cxp, ly = cyp - 14;
        ctx.globalAlpha = sameZ ? 0.95 : 0.55;
        ctx.fillStyle = col.dark;
        ctx.fillRect(lx, ly, tw + 8, 13);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, lx + 4, ly + 1);
        ctx.restore();
      } catch (_) { /* per-player guarded */ }
    }
  }

  // ---- (C) SMOOTH SUB-TILE CURSORS (over the WebSocket) ----------------------------
  const CURSOR_SEND_MS = 40;    // ~25/s outbound throttle
  // This lerp stays UNCONDITIONAL even though creature motion snaps: the mouse pointer is the one
  // continuous-valued position native DF has, so snapping other players' cursors would move away from it.
  const CURSOR_LERP_MS = 70;    // interpolate over the gap between two received positions
  const CURSOR_TTL_MS = 1500;   // drop a cursor we stop hearing about (player left / idle)
  const CURSOR_ZFADE_N = 6;     // opacity = max(0, 1 - |dz|/N); invisible beyond N z-levels

  let lastCursorSend = 0;
  let lastCursorKey = "";
  const smoothCursors = new Map();   // name -> { rx,ry, fromX,fromY, toX,toY, tStart, z, drag, lastSeen }
  let cursorCanvas = null, cursorCtx = null, cursorRaf = null;

  // SEND: pointer -> world coords, throttled; WS only (HTTP presence remains the fallback).
  function sendSmoothCursor(clientX, clientY) {
    if (!window.DwfWS || typeof DwfWS.isConnected !== "function" ||
        !DwfWS.isConnected()) return;
    const rr = getRenderRect();
    if (!rr || rr.cell <= 0) return;
    const gxf = (clientX - rr.left) / rr.cell;
    const gyf = (clientY - rr.top) / rr.cell;
    if (gxf < 0 || gyf < 0 || gxf >= rr.gw || gyf >= rr.gh) return;   // off the drawn map
    const gx = Math.floor(gxf), gy = Math.floor(gyf);
    const fx = Math.round((gxf - gx) * 1000) / 1000;
    const fy = Math.round((gyf - gy) * 1000) / 1000;
    const x = rr.ox + gx, y = rr.oy + gy;
    const key = x + "," + y + "," + fx + "," + fy;
    if (key === lastCursorKey) return;                               // unchanged -> skip
    lastCursorKey = key;
    DwfWS.send({ type: "cursor", x: x, y: y, z: rr.oz, fx: fx, fy: fy });
  }

  function bindSmoothCursorSend() {
    if (!canvas) return;
    canvas.addEventListener("mousemove", (event) => {
      try {
        const now = Date.now();
        if (now - lastCursorSend < CURSOR_SEND_MS) return;
        lastCursorSend = now;
        sendSmoothCursor(event.clientX, event.clientY);
      } catch (_) { /* never throw out of an input handler */ }
    }, { passive: true });
  }

  function ingestSmoothCursors(players) {
    if (!Array.isArray(players)) return;
    const now = Date.now();
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
      if (p.name === player) continue;                               // never our own cursor
      const wx = p.x + (typeof p.fx === "number" ? p.fx : 0);
      const wy = p.y + (typeof p.fy === "number" ? p.fy : 0);
      let c = smoothCursors.get(p.name);
      if (!c) { c = { rx: wx, ry: wy }; smoothCursors.set(p.name, c); }
      c.fromX = (typeof c.rx === "number") ? c.rx : wx;
      c.fromY = (typeof c.ry === "number") ? c.ry : wy;
      c.toX = wx; c.toY = wy;
      c.tStart = now;
      c.z = (typeof p.z === "number") ? p.z : 0;
      c.drag = !!p.drag;
      c.lastSeen = now;
    }
  }

  function syncCursorCanvas() {
    if (!canvas) return false;
    if (!cursorCanvas) {
      try {
        cursorCanvas = document.createElement("canvas");
        cursorCanvas.className = "dwf-remote-cursor-canvas";
        document.body.appendChild(cursorCanvas);
        cursorCtx = cursorCanvas.getContext("2d");
      } catch (_) { cursorCanvas = null; cursorCtx = null; return false; }
    }
    if (!cursorCtx) return false;
    const rect = canvas.getBoundingClientRect();
    if (cursorCanvas.width !== canvas.width) cursorCanvas.width = canvas.width;
    if (cursorCanvas.height !== canvas.height) cursorCanvas.height = canvas.height;
    cursorCanvas.style.setProperty("--dwf-cursor-left", rect.left + "px");
    cursorCanvas.style.setProperty("--dwf-cursor-top", rect.top + "px");
    cursorCanvas.style.setProperty("--dwf-cursor-width", rect.width + "px");
    cursorCanvas.style.setProperty("--dwf-cursor-height", rect.height + "px");
    return true;
  }

  function drawRemoteDragRects(octx) {
    if (!geom || !glOccludesCanvas2d()) return;
    const players = (lastAux && Array.isArray(lastAux.players)) ? lastAux.players : [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.name === player) continue;              // never our own box
      if (!p.drag || typeof p.dx !== "number" || typeof p.dy !== "number" ||
          typeof p.x !== "number" || typeof p.y !== "number") continue;
      const sameZ = (typeof p.z !== "number") || p.z === geom.oz;
      const col = playerColor(p.name);
      const cell = geom.cell;
      const gx0 = Math.min(p.x, p.dx) - geom.ox, gy0 = Math.min(p.y, p.dy) - geom.oy;
      const gx1 = Math.max(p.x, p.dx) - geom.ox + 1, gy1 = Math.max(p.y, p.dy) - geom.oy + 1;
      const rx = gx0 * cell, ry = gy0 * cell, rw = (gx1 - gx0) * cell, rh = (gy1 - gy0) * cell;
      if (rx > cursorCanvas.width || ry > cursorCanvas.height || rx + rw < 0 || ry + rh < 0) continue;
      octx.save();
      octx.fillStyle = col.fill; octx.globalAlpha = sameZ ? 0.10 : 0.05;
      octx.fillRect(rx, ry, rw, rh);
      octx.globalAlpha = sameZ ? 0.9 : 0.4;
      octx.strokeStyle = col.fill; octx.lineWidth = 2;
      octx.strokeRect(rx + 1, ry + 1, Math.max(1, rw - 2), Math.max(1, rh - 2));
      octx.restore();
    }
  }

  function drawSmoothCursors() {
    if (!syncCursorCanvas()) return;
    const octx = cursorCtx;
    octx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    if (!geom) return;                                    // no map yet -> nothing to place against
    try { drawRemoteDragRects(octx); } catch (_) { /* overlay must never throw */ }
    const now = Date.now();
    const cell = geom.cell, ox = geom.ox, oy = geom.oy, oz = geom.oz;
    for (const [name, c] of smoothCursors) {
      if (now - c.lastSeen > CURSOR_TTL_MS) { smoothCursors.delete(name); continue; }
      const a = Math.min(1, (now - c.tStart) / CURSOR_LERP_MS);      // interpolation alpha
      c.rx = c.fromX + (c.toX - c.fromX) * a;
      c.ry = c.fromY + (c.toY - c.fromY) * a;
      const dz = Math.abs(oz - c.z);
      const alpha = Math.max(0, 1 - dz / CURSOR_ZFADE_N);            // z-fade
      if (alpha <= 0.02) continue;
      const px = (c.rx - ox) * cell;                                 // world -> our backing px
      const py = (c.ry - oy) * cell + (oz - c.z) * 3;                // small lift per z-level
      if (px < -40 || py < -40 || px > cursorCanvas.width + 40 || py > cursorCanvas.height + 40) continue;
      try { drawOneCursor(octx, name, px, py, alpha, c, oz); } catch (_) { /* per-cursor guarded */ }
    }
    try { drawPingSplashes(octx, now); } catch (_) { /* a splash must never break the overlay */ }
  }

  function drawOneCursor(octx, name, px, py, alpha, c, oz) {
    const col = playerColor(name);
    octx.save();
    octx.globalAlpha = alpha;
    octx.beginPath();
    octx.moveTo(px, py);
    octx.lineTo(px, py + 16);
    octx.lineTo(px + 4, py + 12);
    octx.lineTo(px + 9, py + 17);
    octx.lineTo(px + 12, py + 14);
    octx.lineTo(px + 7, py + 9);
    octx.lineTo(px + 12, py + 9);
    octx.closePath();
    octx.fillStyle = col.fill;
    octx.strokeStyle = "rgba(0,0,0,0.55)";
    octx.lineWidth = 1;
    octx.fill();
    octx.stroke();
    let label = presenceLabel(name) || "?";
    if (label.length > 14) label = label.slice(0, 13) + "…";
    if (c.z > oz) label += " ↑"; else if (c.z < oz) label += " ↓";
    octx.font = "11px monospace";
    octx.textAlign = "left"; octx.textBaseline = "top";
    const tw = octx.measureText(label).width;
    const lx = px + 13, ly = py + 15;
    octx.globalAlpha = alpha * 0.9;
    octx.fillStyle = col.dark;
    octx.fillRect(lx, ly, tw + 8, 14);
    octx.globalAlpha = alpha;
    octx.fillStyle = "#fff";
    octx.fillText(label, lx + 4, ly + 1);
    octx.restore();
  }

  function startCursorOverlay() {
    if (cursorRaf !== null) return;                       // already running
    const tick = () => {
      cursorRaf = requestAnimationFrame(tick);
      try { drawSmoothCursors(); } catch (_) { /* overlay must never throw */ }
    };
    cursorRaf = requestAnimationFrame(tick);
  }

  // ---- (D) PING SPLASH: expanding-ring location ping --------------------------------
  const PING_DURATION_MS = 950;      // total lifetime of one splash
  const PING_RINGS = 2;              // concentric rings
  const PING_RING_STAGGER = 0.18;    // each later ring starts this fraction of the lifetime later
  const PING_MAX_R_TILES = 3.2;      // peak ring radius, in world tiles (scales with zoom via cell)
  const PING_MAX_R_PX = 120;         // hard px ceiling so a far-zoom ping stays a tidy burst
  const PING_MAX_ACTIVE = 24;        // hard cap on simultaneous splashes (spam guard)
  const activePings = [];            // { wx, wy, z, col, tStart }

  function pingSplash(worldX, worldY, z, name) {
    const wx = Number(worldX), wy = Number(worldY);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return false;
    activePings.push({
      wx: wx, wy: wy,
      z: Number.isFinite(Number(z)) ? Number(z) : (geom ? geom.oz : 0),
      col: playerColor(name), tStart: Date.now(),
    });
    if (activePings.length > PING_MAX_ACTIVE) activePings.splice(0, activePings.length - PING_MAX_ACTIVE);
    startCursorOverlay();            // ensure the RAF runs even before any cursor has arrived
    return true;
  }

  // Ease-out cubic: fast expansion that settles -- the "pop" that makes a ping feel responsive.
  function pingEaseOut(t) { const u = 1 - Math.max(0, Math.min(1, t)); return 1 - u * u * u; }

  function drawPingSplashes(octx, now) {
    if (!octx || !geom || !activePings.length) return 0;
    const cell = geom.cell, ox = geom.ox, oy = geom.oy, oz = geom.oz;
    const cw = (cursorCanvas && cursorCanvas.width) || (canvas && canvas.width) || 4096;
    const ch = (cursorCanvas && cursorCanvas.height) || (canvas && canvas.height) || 4096;
    const maxR = Math.min(PING_MAX_R_PX, PING_MAX_R_TILES * cell + 12);
    const span = 1 - (PING_RINGS - 1) * PING_RING_STAGGER;
    let drawn = 0;
    for (let i = activePings.length - 1; i >= 0; i--) {
      const p = activePings[i];
      const life = (now - p.tStart) / PING_DURATION_MS;
      if (life >= 1 || life < 0) { activePings.splice(i, 1); continue; }   // reap expired
      const dz = Math.abs(oz - p.z);
      const zAlpha = Math.max(0, 1 - dz / CURSOR_ZFADE_N);                 // fade across z-levels
      if (zAlpha <= 0.02) continue;
      const px = (p.wx + 0.5 - ox) * cell;                                 // tile CENTER -> overlay px
      const py = (p.wy + 0.5 - oy) * cell;
      if (px < -maxR || py < -maxR || px > cw + maxR || py > ch + maxR) continue;  // off-screen
      octx.save();
      for (let r = 0; r < PING_RINGS; r++) {
        const rl = (life - r * PING_RING_STAGGER) / span;                 // this ring's own 0..1
        if (rl <= 0 || rl >= 1) continue;
        const radius = 4 + pingEaseOut(rl) * maxR;
        const alpha = zAlpha * (1 - rl) * (1 - rl);                       // quadratic fade-out
        octx.globalAlpha = alpha;
        octx.strokeStyle = p.col.fill;
        octx.lineWidth = Math.max(1.5, 3 * (1 - rl));
        octx.beginPath();
        octx.arc(px, py, radius, 0, Math.PI * 2);
        octx.stroke();
      }
      // center dot: marks the exact tile, fades fastest.
      const dotA = zAlpha * Math.max(0, 1 - life * 2.4);
      if (dotA > 0.02) {
        octx.globalAlpha = dotA;
        octx.fillStyle = p.col.fill;
        octx.beginPath();
        octx.arc(px, py, Math.max(2, cell * 0.2), 0, Math.PI * 2);
        octx.fill();
      }
      octx.restore();
      drawn++;
    }
    return drawn;
  }

  // ---- canvas / DOM setup ----------------------------------------------------------
  // Dual-mode: STANDALONE binds #tilemap and owns camera + poll; EMBEDDED is init()ed by dwf-core.js.
  let canvas = null;
  let ctx = null;
  let hud = null;
  let manageCamera = true;   // bind WASD/arrow camera keys (standalone only)
  let managePoll = true;     // run the /mapdata poll loop ourselves
  let onDrawCb = null;       // fired after every draw() -- embed hook to repaint overlays
  let listenersBound = false;

  let latest = null;      // last good mapdata payload
  let connected = false;  // whether the last poll succeeded with valid JSON
  let wsAlive = false;    // true while the WS push transport is feeding draw() (FIX 2)

  let mapDirty = false;
  let mapDrawRaf = null;
  let lastUnitStatusVisSig = 0;
  let lastUnitStatusHadBubble = false;
  let lastDesignationBlinkPhase = -1;
  let lastMachineAnimPhase = -1;
  function startMapDrawLoop() {
    if (mapDrawRaf !== null) return;
    const tick = () => {
      mapDrawRaf = requestAnimationFrame(tick);
      const wallNowMs = (window.performance && performance.now) ? performance.now() : Date.now();
      const nowMs = _machineFreezeAnim ? 1000 : wallNowMs;
      if (connected && latest && hasDrawableUnitStatus(latest.units)) {
        const sig = unitStatusVisibilitySignature(latest.units, nowMs);
        if (sig !== lastUnitStatusVisSig || !lastUnitStatusHadBubble) { lastUnitStatusVisSig = sig; mapDirty = true; }
        lastUnitStatusHadBubble = true;
      } else {
        lastUnitStatusVisSig = 0;
        lastUnitStatusHadBubble = false;
      }
      if (connected && latest && hasBlinkingDesignationJob(latest.djobs)) {
        const phase = Math.floor(nowMs / DESIG_ACTIVE_BLINK_MS);
        if (phase !== lastDesignationBlinkPhase) { lastDesignationBlinkPhase = phase; mapDirty = true; }
      } else {
        lastDesignationBlinkPhase = -1;
      }
      if (connected && latest) {
        const mstep = machineCadenceStep(latest.buildings, worldAnimMs(nowMs), lastMachineAnimPhase, _machineFreezeAnim);
        lastMachineAnimPhase = mstep.phase;
        if (mstep.dirty) mapDirty = true;
      } else {
        lastMachineAnimPhase = -1;
      }
      if (mapDirty) {
        mapDirty = false;
        try { draw(); } catch (_) { /* draw() already self-guards; belt & suspenders */ }
      }
    };
    mapDrawRaf = requestAnimationFrame(tick);
  }

  let sceneBuildCount = 0;
  let geom = null;        // {cell, gw, gh, ox, oy, oz}

  // PERSISTENT TILE BUFFER: draw() always renders from this row-major buffer, so a delta touches a
  // handful of cells. A keyframe rebuilds it; the HTTP poll fallback instead sets `latest` outright.
  let tileBuf = null;                       // row-major Array(bufW*bufH); === latest.tiles
  let bufOx = 0, bufOy = 0, bufOz = 0, bufW = 0, bufH = 0;

  // ---- v1 optimistic local windowing ------------------------------------------------------
  let desiredCam = null;          // {x,y,z} -- null until the first hello_ack/AUX seeds it
  let v1MapDims = null;           // {w,h,z} world extent from hello_ack.map, for clamping
  let v1WorldSeq = null;          // last hello_ack.world_seq -- a DECREASE means a different world
  let lastPanInputTime = 0;
  const CAM_DIVERGENCE_MS = 500;  // snap to AUX.cam if desiredCam has been stale this long
  function clampCam(c) {
    if (!v1MapDims) return c;
    return {
      x: Math.max(0, Math.min(v1MapDims.w - 1, c.x)),
      y: Math.max(0, Math.min(v1MapDims.h - 1, c.y)),
      z: Math.max(0, Math.min(v1MapDims.z - 1, c.z)),
    };
  }
  let _lastCamHintZSent = null;
  function pushDesiredCamToBuf() {
    bufOx = desiredCam.x; bufOy = desiredCam.y; bufOz = desiredCam.z;
    const d = desiredWinDims();
    bufW = d.w; bufH = d.h;
    mapDirty = true; // instant re-window from the cache on the next rAF -- no wire wait
    if (bufOz !== _lastCamHintZSent) {
      _lastCamHintZSent = bufOz;
      try { if (window.DwfCache && typeof DwfCache.setCamHintZ === "function") DwfCache.setCamHintZ(bufOz); } catch (_) {}
    }
  }
  function noteCamDelta(dx, dy, dz) {
    if (!v1Active()) return;
    lastPanInputTime = Date.now();
    if (!desiredCam) desiredCam = { x: bufOx, y: bufOy, z: bufOz };
    desiredCam = clampCam({ x: desiredCam.x + (dx | 0), y: desiredCam.y + (dy | 0), z: desiredCam.z + (dz | 0) });
    pushDesiredCamToBuf();
  }
  function setCamAbsolute(x, y, z) {
    if (!v1Active()) return;
    lastPanInputTime = Date.now();
    desiredCam = clampCam({ x: x | 0, y: y | 0, z: z | 0 });
    pushDesiredCamToBuf();
  }
  // While local input is recent (< CAM_DIVERGENCE_MS) the local window wins; then divergence snaps back.
  function reconcileAuxCam(cam) {
    if (!cam || typeof cam.x !== "number") { if (desiredCam) pushDesiredCamToBuf(); return; }
    if (!desiredCam) { desiredCam = { x: cam.x, y: cam.y, z: cam.z }; pushDesiredCamToBuf(); return; }
    const diverged = desiredCam.x !== cam.x || desiredCam.y !== cam.y || desiredCam.z !== cam.z;
    if (diverged && (Date.now() - lastPanInputTime) > CAM_DIVERGENCE_MS) {
      desiredCam = { x: cam.x, y: cam.y, z: cam.z };
    }
    pushDesiredCamToBuf();
  }

  // ---- cache-fed draw path ---------------------------------------------------------
  function shouldUseCacheDraw() {
    return !!(window.DwfCache && typeof DwfCache.windowView === "function");
  }
  let lastAux = { units: [], buildings: [], players: [], proj: [], djobs: [], env: null };
  const auxUnitsById = new Map();
  const auxBldgsById = new Map();
  const auxBldgsParked = new Map();
  const AUX_BLDGS_PARKED_MAX = 256;
  function bldOutsideWindow(b, cam) {
    if (!b || !cam || typeof cam.x !== "number" || typeof cam.y !== "number" ||
        !(cam.w > 0) || !(cam.h > 0)) return false;
    if (typeof cam.z === "number" && typeof b.z === "number" && b.z !== cam.z) return false;
    return b.x2 < cam.x || b.x1 >= cam.x + cam.w || b.y2 < cam.y || b.y1 >= cam.y + cam.h;
  }
  function bldInClientWindow(b) {
    if (!b || bufW <= 0 || bufH <= 0) return false;
    if (typeof b.z === "number" && b.z !== bufOz) return false;
    return !(b.x2 < bufOx || b.x1 >= bufOx + bufW || b.y2 < bufOy || b.y1 >= bufOy + bufH);
  }
  function reconcileParkedBldgs(cam) {
    if (!auxBldgsParked.size) return false;
    let changed = false;
    for (const [id, b] of auxBldgsParked) {
      if (auxBldgsById.has(id) || !bldOutsideWindow(b, cam) || !bldInClientWindow(b)) {
        auxBldgsParked.delete(id); changed = true;
      }
    }
    return changed;
  }
  function parkBld(b) {
    if (!b || typeof b.id !== "number") return false;
    if (auxBldgsParked.size >= AUX_BLDGS_PARKED_MAX) {
      const oldest = auxBldgsParked.keys().next().value;
      auxBldgsParked.delete(oldest);
    }
    auxBldgsParked.set(b.id, b);
    return true;
  }
  // The renderer-facing building list: live server truth plus the (usually empty) parked bridge.
  function composeAuxBldgs() {
    const live = Array.from(auxBldgsById.values());
    if (!auxBldgsParked.size) return live;
    return live.concat(Array.from(auxBldgsParked.values()));
  }

  function refreshFromCacheIfNeeded() {
    if (!wsAlive || !shouldUseCacheDraw() || bufW <= 0 || bufH <= 0) return;
    let view = null;
    try { view = DwfCache.windowView(bufOx, bufOy, bufOz, bufW, bufH); } catch (_) { view = null; }
    if (!view || !Array.isArray(view.tiles)) return;
    tileBuf = view.tiles;
    latest = {
      wire: 5, origin: { x: bufOx, y: bufOy, z: bufOz }, width: bufW, height: bufH, z: bufOz,
      tiles: tileBuf, units: lastAux.units, buildings: lastAux.buildings, players: lastAux.players,
      proj: lastAux.proj, env: lastAux.env,   // projectiles + weather/season
      djobs: lastAux.djobs,                   // designation jobs
      // GL keys its scene rebuild on this content version, not on `latest` object identity.
      contentVersion: (typeof view.version === "number") ? view.version : undefined,
      coverageVersion: (typeof view.coverageVersion === "number") ? view.coverageVersion : undefined,
    };
  }

  // ---- F3 perf overlay -------------------------------------------------------------
  let diagOn = false, diagEl = null, diagTimer = null;
  let lastDrawMs = 0, lastMapUpdateTime = 0;
  const drawRing = [];                        // timestamps of recent PAINTED draw() calls (fps)
  let glFpsSample = { t: 0, draw: 0 };

  // ---- occluded-canvas2d paint gate ----------------------------------------------------
  const KEEPWARM_TICK_MS = 120;               // min gap between incremental occluded band paints
  const KEEPWARM_BAND_TILES = 800;            // ~tiles per band => ~4-6ms, independent of zoom
  let lastPaintTime = 0;                       // performance.now() of the last occluded band paint
  let warmRow = 0;                             // grid-row cursor for the incremental keep-warm cycle
  function glOccludesCanvas2d() {
    try {
      if (!(window.DwfRender && window.DwfRender.active === "gl")) return false;
      return window.__dfcGLVisible === true;
    } catch (_) { return false; }
  }
  function markMapUpdate() { lastMapUpdateTime = Date.now(); }
  function recordDraw(ms) {
    lastDrawMs = ms;
    const now = Date.now();
    drawRing.push(now);
    while (drawRing.length > 240) drawRing.shift();
  }
  function ensureDiagEl() {
    if (diagEl) return diagEl;
    try {
      diagEl = document.createElement("div");
      diagEl.className = "df-tile-diag";
      document.body.appendChild(diagEl);
    } catch (_) { diagEl = null; }
    return diagEl;
  }
  function diagText() {
    const now = Date.now();
    let fps = 0;
    for (let i = drawRing.length - 1; i >= 0; i--) { if (now - drawRing[i] > 1000) break; fps++; }
    const ws = (window.DwfWS && typeof DwfWS.getStats === "function") ? DwfWS.getStats() : null;
    const sinceMap = lastMapUpdateTime ? (now - lastMapUpdateTime) : -1;
    const bufN = tileBuf ? tileBuf.length : 0;
    let renderLine = `render: ${fps} fps   ${lastDrawMs.toFixed(1)} ms/draw`;
    let keepWarmLine = null;
    let coldReconcileLine = null;
    const retainedDiagLines = [];
    try {
      const rs = (window.DwfRender && typeof DwfRender.getStats === "function")
        ? DwfRender.getStats() : null;
      if (rs && rs.renderer === "gl" && typeof rs.drawCount === "number") {
        let gfps = 0;
        if (glFpsSample.t && now > glFpsSample.t) {
          gfps = Math.max(0, Math.round(((rs.drawCount - glFpsSample.draw) * 1000) / (now - glFpsSample.t)));
        }
        glFpsSample = { t: now, draw: rs.drawCount };
        const bms = (typeof rs.lastBuildMs === "number") ? rs.lastBuildMs.toFixed(1) : "?";
        renderLine = `render: ${gfps} fps   ${bms} ms/build (gl)`;
        keepWarmLine = `underlay keep-warm: ${fps}/s`;
        if (typeof rs.coldReconcileStage === "number" &&
            typeof rs.coldReconcileStageCount === "number") {
          coldReconcileLine = `cold reconcile: ${rs.coldReconcileStage}/${rs.coldReconcileStageCount}` +
            `   builds: ${rs.coldReconcileBuildCount || 0}`;
        }
        retainedDiagLines.push(`scene: full ${rs.sceneBuildCount || 0}   patch ${rs.chunkPatchCount || 0}` +
          `   invalid: ${rs.sceneInvalidated ? "yes" : "no"}`);
        if (typeof rs.staleTerrainChunkCount === "number") {
          retainedDiagLines.push(`retained/cache: stale ${rs.staleTerrainChunkCount}/${rs.retainedTerrainChecked || 0}` +
            `   missing ${rs.missingTerrainSegmentCount || 0}`);
          retainedDiagLines.push(`hidden tiles kept/cache: ${rs.retainedHiddenTileCount || 0}/${rs.cacheHiddenTileCount || 0}`);
          const hc = Array.isArray(rs.hiddenTerrainChunks) ? rs.hiddenTerrainChunks : [];
          for (let i = 0; i < Math.min(hc.length, 8); i++) {
            const h = hc[i];
            retainedDiagLines.push(`  hidden ${h.bx},${h.by},${h.z}: ${h.retainedHidden}/${h.cacheHidden}`);
          }
          retainedDiagLines.push(`void tiles kept/cache: ${rs.retainedVoidTileCount || 0}/${rs.cacheVoidTileCount || 0}`);
          const vc = Array.isArray(rs.voidTerrainChunks) ? rs.voidTerrainChunks : [];
          for (let i = 0; i < Math.min(vc.length, 8); i++) {
            const v = vc[i];
            retainedDiagLines.push(`  void ${v.bx},${v.by},${v.z}: ${v.retainedVoid}/${v.cacheVoid}`);
          }
          const mm = Array.isArray(rs.staleTerrainChunks) ? rs.staleTerrainChunks : [];
          for (let i = 0; i < Math.min(mm.length, 4); i++) {
            const m = mm[i];
            retainedDiagLines.push(`  ${m.bx},${m.by},${m.z}: kept ${m.retained}/256 cache ${m.cache}/256` +
              ` hidden ${m.retainedHidden}/${m.cacheHidden} builds ${m.builds}`);
          }
        }
        if (typeof rs.gpuStaticMismatchBytes === "number") {
          retainedDiagLines.push(`cpu/gpu static: ${rs.cpuStaticInstances || 0}/${rs.gpuStaticInstances || 0}` +
            `   diff ${rs.gpuStaticMismatchBytes}` +
            (rs.gpuStaticAvailable ? `/${rs.gpuStaticComparedBytes || 0}B` : " (readback unavailable)"));
        }
        const fi = rs.firstSceneInput, ci = rs.currentSceneInput, br = rs.buildRect;
        if (fi) retainedDiagLines.push(`first: ${fi.x},${fi.y},${fi.z} ${fi.width}x${fi.height}`);
        if (ci) retainedDiagLines.push(`now:   ${ci.x},${ci.y},${ci.z} ${ci.width}x${ci.height}`);
        if (br) retainedDiagLines.push(`rect:  ${br.x0},${br.y0} .. ${br.x1},${br.y1}`);
      }
    } catch (_) { /* overlay must never throw */ }
    const lines = [
      "Dwf perf  [F3]",
      renderLine,
      `transport: ${wsAlive ? "WS delta" : "HTTP poll"}`,
    ];
    if (keepWarmLine) lines.push(keepWarmLine);
    if (coldReconcileLine) lines.push(coldReconcileLine);
    for (let i = 0; i < retainedDiagLines.length; i++) lines.push(retainedDiagLines[i]);
    try {
      if (window.DwfRender && typeof DwfRender.provenance === "function") {
        const p = DwfRender.provenance();
        const how = p.demoted ? ("demoted from " + p.requested)
          : (p.source === "url" ? "url" : p.source === "stored" ? "localStorage" : "default");
        lines.push(`renderer: ${p.active} (${how})`);
      }
    } catch (_) { /* overlay must never throw */ }
    if (ws) {
      lines.push(`proto: ${ws.proto}   rtt: ${ws.rttMs}ms   ack-lag: ${ws.inflightAcks}`);
      if (ws.proto === "v1") {
        lines.push(`  worldSeq: ${ws.worldSeq}   opens: ${ws.socketOpens}   snap: ${ws.snapshotDone ? "done" : "..."}`);
        lines.push(`  blockSet: ${ws.blockSetBytesPerSec} B/s   aux: ${ws.auxBytesPerSec} B/s` +
          `   behind ~${ws.estBehindMs}ms`);
      } else {
        lines.push(`ws: ${ws.msgsPerSec} msg/s   avg ${ws.avgBytes} B`);
        lines.push(`  key ${ws.keyMsgs}×${ws.keyAvgBytes}B  delta ${ws.deltaMsgs}×${ws.deltaAvgBytes}B`);
        lines.push(`  pending: ${ws.pendingMaps} map / ${ws.pendingInflates} inflate` +
          `   behind ~${ws.estBehindMs}ms`);
        lines.push(`  dropped: ${ws.droppedStale}   resyncs: ${ws.resyncs}   apply: ${ws.clientApplyMs}ms`);
      }
    }
    lines.push(`last map upd: ${sinceMap < 0 ? "-" : sinceMap + " ms"} ago`);
    lines.push(`buffer: ${bufN} tiles (${bufW}×${bufH})`);
    try {
      if (window.DwfCache && typeof DwfCache.stats === "function") {
        const cs = DwfCache.stats();
        const mb = (cs.bytes / (1024 * 1024)).toFixed(1);
        lines.push(`cache: ${cs.chunks} chunks / ${cs.zLevels} z / ${mb} MB / ${cs.evictions} evictions`);
      }
    } catch (_) { /* diag must never affect rendering */ }
    return lines.join("\n");
  }
  function toggleDiag() {
    diagOn = !diagOn;
    const el = ensureDiagEl();
    if (!el) return;
    el.classList.toggle("df-tile-diag-active", diagOn);
    if (diagOn && diagTimer === null) {
      diagTimer = setInterval(() => {
        try { if (diagOn && diagEl) diagEl.textContent = diagText(); } catch (_) { /* overlay must never throw */ }
      }, 250);
      try { diagEl.textContent = diagText(); } catch (_) {}
    } else if (!diagOn && diagTimer !== null) {
      clearInterval(diagTimer); diagTimer = null;
    }
  }

  const ZOOM_LADDER = [12, 16, 24, 32, 48, 64];   // CSS px/tile, ascending
  const TILE_PX_MIN = ZOOM_LADDER[0];     // zoom-out cap: smallest px/tile that still renders sprites
  const TILE_PX_MAX = ZOOM_LADDER[ZOOM_LADDER.length - 1];
  const TILE_PX_DEFAULT = 24;
  const SPRITE_SRC_PX = 32;               // source sprite size (== dwf-gl-atlas.js CELL_SIZE)
  let targetTilePx = TILE_PX_DEFAULT;
  try {
    const v = parseFloat(sessionStorage.getItem("dwf.tilePx"));
    if (Number.isFinite(v) && v >= TILE_PX_MIN && v <= TILE_PX_MAX) targetTilePx = clampTilePx(v);
  } catch (_) { /* no sessionStorage -> default zoom */ }

  // Ladder-snap is THE clamp: off-ladder zoom levels cannot exist, so a fractional cell cannot come back.
  function clampTilePx(px) {
    if (!Number.isFinite(px)) return targetTilePx;
    let best = ZOOM_LADDER[0];
    for (let i = 1; i < ZOOM_LADDER.length; i++) {
      if (Math.abs(ZOOM_LADDER[i] - px) < Math.abs(best - px)) best = ZOOM_LADDER[i];
    }
    return best;
  }
  // The canvas backing store is sized in PHYSICAL pixels: min(devicePixelRatio, 2) x the CSS box, with
  // localStorage['dwf.dpr']='0' as the kill switch. targetTilePx keeps its CSS-px-per-tile meaning.
  let backingDpr = 1;
  function hiDpiEnabled() {
    try { return localStorage.getItem("dwf.dpr") !== "0"; } catch (_) { return true; }
  }
  function backingScale() {
    try {
      if (!hiDpiEnabled()) return 1;
      return Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    } catch (_) { return 1; }
  }
  function setHiDpi(on) {
    try { localStorage.setItem("dwf.dpr", on ? "1" : "0"); } catch (_) { /* private mode */ }
    resizeCanvas();
  }
  // Physical (backing-store) pixels per tile at a CSS px/tile rung -- ALWAYS an integer.
  function renderCellPx(px) {
    return Math.max(1, Math.round((Number.isFinite(px) ? px : targetTilePx) * backingDpr));
  }
  // Requested /mapdata window: enough whole tiles to COVER the canvas at the integer cell. ceil, not
  // round -- a remainder strip would force a centering offset and move grid (0,0) off the canvas origin.
  function dimsAtTilePx(px) {
    const cell = renderCellPx(px);
    const cw = (canvas && canvas.width) ? canvas.width
      : Math.round((window.innerWidth || 0) * backingDpr);
    const ch = (canvas && canvas.height) ? canvas.height
      : Math.round((window.innerHeight || 0) * backingDpr);
    const w = Math.max(1, Math.min(200, Math.ceil(cw / cell)));
    const h = Math.max(1, Math.min(200, Math.ceil(ch / cell)));
    return { w, h };
  }
  // THE cell-size decision, shared by both renderers through DwfTiles.cellPxFor so they cannot disagree.
  // The ladder cell normally; a server-clamped smaller window falls back to the largest integer cell.
  function cellPxFor(w, h, gw, gh, idealPx) {
    const ideal = renderCellPx(idealPx);
    if (!(gw > 0) || !(gh > 0)) return ideal;
    if (gw * ideal >= w && gh * ideal >= h) return ideal;
    return Math.max(1, Math.floor(Math.min(w / gw, h / gh)));
  }
  function desiredWinDims() {
    return dimsAtTilePx(targetTilePx);
  }

  // Returns the change in requested window dims {dw,dh}; the embedder shifts the camera by -delta/2.
  function applyTilePx(px) {
    const before = desiredWinDims();
    const clamped = clampTilePx(px);
    if (clamped === targetTilePx) return { dw: 0, dh: 0 };
    targetTilePx = clamped;
    try { sessionStorage.setItem("dwf.tilePx", String(targetTilePx)); } catch (_) {}
    const after = desiredWinDims();
    if (v1Active() && desiredCam) { bufW = after.w; bufH = after.h; mapDirty = true; }
    if (after.w !== before.w || after.h !== before.h) {
      try {
        if (window.DwfWS && typeof DwfWS.updateDimsNow === "function")
          DwfWS.updateDimsNow(after.w, after.h, targetTilePx);
        else if (window.DwfWS && typeof DwfWS.updateDims === "function")
          DwfWS.updateDims(after.w, after.h, targetTilePx);
      } catch (_) { /* ignore */ }
      pollNow();
    }
    mapDirty = true;
    return { dw: after.w - before.w, dh: after.h - before.h };
  }
  function zoomStepPx(px, dir) {
    const i = ZOOM_LADDER.indexOf(clampTilePx(px));
    const j = Math.max(0, Math.min(ZOOM_LADDER.length - 1, i + (dir === "in" ? 1 : -1)));
    return ZOOM_LADDER[j];
  }
  function zoom(dir) {
    return applyTilePx(zoomStepPx(targetTilePx, dir));
  }
  function zoomTo(px) { return applyTilePx(px); }
  function getZoom() { return { px: targetTilePx, min: TILE_PX_MIN, max: TILE_PX_MAX,
    def: TILE_PX_DEFAULT }; }

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    backingDpr = backingScale();
    canvas.width = Math.max(1, Math.round(window.innerWidth * backingDpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * backingDpr));
    ctx.imageSmoothingEnabled = false;
    try {
      if (window.DwfWS && typeof DwfWS.updateDims === "function") {
        const d = desiredWinDims();
        DwfWS.updateDims(d.w, d.h);
      }
    } catch (_) { /* ignore */ }
    draw();
  }

  function setHud(text) {
    if (hud) hud.textContent = text;
  }

  function isValidMapData(d) {
    return !!d && d.wire >= 1 && d.origin &&
      typeof d.width === "number" && typeof d.height === "number" &&
      Array.isArray(d.tiles);
  }

  // ---- drawing --------------------------------------------------------------------
  function draw() {
    if (!canvas || !ctx) return;
    const _t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    let painted = false;
    try {
      painted = drawInner();       // false when the keep-warm gate skipped the (occluded) paint this frame
    } catch (_) {
      // Never let a draw error take down the poll loop.
    }
    if (painted) {
      try {
        const _t1 = (window.performance && performance.now) ? performance.now() : Date.now();
        recordDraw(_t1 - _t0);
      } catch (_) { /* diag must never affect rendering */ }
    }
    // This embed hook ALWAYS fires, so host overlays stay cursor-aligned even on a skipped paint.
    if (onDrawCb) { try { onDrawCb(); } catch (_) { /* overlay hook is non-fatal */ } }
  }

  // TRUE if it painted this frame, FALSE if the keep-warm gate skipped the occluded paint.
  function drawInner() {
    // ===== DATA HALF (always runs, even when the paint below is skipped) =====
    refreshFromCacheIfNeeded();

    const w = canvas.width, h = canvas.height;

    geom = null;
    const connectedValid = connected && latest && latest.width > 0 && latest.height > 0;
    let data = null, gw = 0, gh = 0, cell = 1, ox = 0, oy = 0, oz = 0;
    if (connectedValid) {
      data = latest;
      gw = data.width; gh = data.height;
      cell = cellPxFor(w, h, gw, gh);
      ox = data.origin.x; oy = data.origin.y; oz = data.origin.z;
      geom = { cell, gw, gh, ox, oy, oz };
    }
    ctx.imageSmoothingEnabled = false;

    // ===== PAINT GATE ===== While GL occludes this canvas, paint at most ONE small terrain band per
    // tick; a demote force-repaints one full frame, so a partially warm buffer is never actually shown.
    const nowMs = (window.performance && performance.now) ? performance.now() : Date.now();
    const worldMs = worldAnimMs(nowMs);
    const uiMs = uiAnimMs(nowMs);
    let bandMode = false, bandRowStart = 0, bandRowEnd = 0;
    if (glOccludesCanvas2d()) {
      if (!connectedValid) return false;                     // nothing to keep warm yet
      if ((nowMs - lastPaintTime) < KEEPWARM_TICK_MS) return false;  // too soon: skip this frame
      lastPaintTime = nowMs;
      bandMode = true;
    }

    // ===== PAINT HALF (skippable) =====
    if (bandMode) {
      const bandRows = Math.max(2, Math.min(gh, Math.ceil(KEEPWARM_BAND_TILES / Math.max(1, gw))));
      bandRowStart = (warmRow >= gh) ? 0 : warmRow;
      bandRowEnd = Math.min(gh, bandRowStart + bandRows);
      const by0 = bandRowStart * cell, bandH = (bandRowEnd - bandRowStart) * cell;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, by0, w, bandH); ctx.clip();
      ctx.fillStyle = rgbStr(BG);
      ctx.fillRect(0, by0, w, bandH);
    } else {
      ctx.fillStyle = rgbStr(BG);
      ctx.fillRect(0, 0, w, h);
    }
    if (!connectedValid) {
      drawConnectingOverlay();
      return true;
    }
    if (!bandMode) sceneBuildCount++;   // a band is a partial refresh, not a full scene build

    const tiles = Array.isArray(data.tiles) ? data.tiles : [];
    const n = Math.min(tiles.length || (gw * gh), gw * gh);
    const iStart = bandMode ? Math.min(n, bandRowStart * gw) : 0;
    const iEnd = bandMode ? Math.min(n, bandRowEnd * gw) : n;

    const layersArr = Array.isArray(data.layers) ? data.layers : null;
    if (layersArr) {
      const byDz = Object.create(null);
      let maxUp = 0, maxDown = 0;
      for (let li = 0; li < layersArr.length; li++) {
        const L = layersArr[li];
        if (!L || !Array.isArray(L.tiles) || typeof L.dz !== "number") continue;
        byDz[L.dz] = L.tiles;
        if (L.dz > maxUp) maxUp = L.dz;
        if (-L.dz > maxDown) maxDown = -L.dz;
      }
      // dz:0 layer is the camera plane; fall back to top-level tiles if it was omitted.
      const cam = byDz[0] || tiles;
      renderComposite(byDz, maxUp, maxDown, cam, gw, gh, cell, n, iStart, iEnd, oz);
    } else {
      for (let i = iStart; i < iEnd; i++) {
        const t = tiles[i];
        if (!t) continue;
        const gx = i % gw, gy = (i - gx) / gw;
        drawTileComposite(t, gx * cell, gy * cell, cell, gx, gy, t.depth || 0, 1, oz);
      }
    }

    if (bandMode) {
      ctx.restore();
      warmRow = (bandRowEnd >= gh) ? 0 : bandRowEnd;   // wrap the row cursor at the grid bottom
      return true;
    }

    // (8) BUILDINGS: after terrain/items/plants/trees and before creatures.
    paintFarmLayers(() => {
      const buildings = buildingsInPaintOrder(data.buildings);
      for (let bi = 0; bi < buildings.length; bi++) {
      const b = buildings[bi];
      if (!b) continue;
      if (isOverlayOnlyBuildingType(b.type)) continue;
      const bAlpha = buildingAlphaForZ(b, oz);
      if (bAlpha === null) continue;
      ctx.save();
      ctx.globalAlpha = bAlpha;
      try {
        const e = machineEntry(b, buildingMap, machineFrameParity(worldMs), lookupCurrentTile) || farmPlotEntry(b)
                || statueEntry(b) || buildingEntry(b);   // statues are a 3-cell composite
        let drewBld = !!(e && e.hidden);
        const bldPalRow = pickBuildingPalRow(b);
        const blitBldCell = (col, row, px, py, sheet) => {
          const sh = sheet || e.sheet;
          if (typeof bldPalRow === "number") {
            const swapped = paletteSwappedCell(sh, col, row, bldPalRow);
            if (swapped) {
              const sm = ctx.imageSmoothingEnabled;
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(swapped, 0, 0, 32, 32, px, py, cell, cell);
              ctx.imageSmoothingEnabled = sm;
              return true;
            }
          }
          return blitCell(sh, col, row, px, py, cell);
        };
        if (e && e.sheet && Array.isArray(e.cells)) {
          const gh2 = e.cells.length;
          const gw2 = e.w || (e.cells[0] ? e.cells[0].length : 1);
          const bfw = b.x2 - b.x1 + 1, bfh = b.y2 - b.y1 + 1;
          const multiCell = (gw2 > 1 || gh2 > 1);
          const offX = (multiCell && gw2 < bfw) ? ((bfw - gw2) >> 1) : 0;
          const offY = (multiCell && gh2 < bfh) ? ((bfh - gh2) >> 1) : 0;
          for (let by = b.y1; by <= b.y2; by++) {
            let ry = by - b.y1 - offY;
            if (multiCell && gh2 < bfh && (ry < 0 || ry >= gh2)) continue; // centered: flanks stay bare
            if (ry >= gh2) ry = gh2 - 1; if (ry < 0) ry = 0;
            const rowArr = e.cells[ry];
            if (!rowArr) continue;
            for (let bx = b.x1; bx <= b.x2; bx++) {
              let rx = bx - b.x1 - offX;
              if (multiCell && gw2 < bfw && (rx < 0 || rx >= gw2)) continue; // centered: flanks stay bare
              if (rx >= gw2) rx = gw2 - 1; if (rx < 0) rx = 0;
              // An EXPLICIT null cell means "this entry draws nothing here" and must NOT be edge-clamped -- that
              // clamp would smear a raised bridge's hinge face across its whole footprint. A MISSING index clamps.
              const cd = rowArr[rx] !== undefined ? rowArr[rx] : rowArr[rowArr.length - 1];
              if (!cd) continue;
              const px = (bx - ox) * cell, py = (by - oy) * cell;
              if (blitBldCell(cd.col, cd.row, px, py)) {
                drewBld = true;
                if (e.overlay && e.overlaySheet) {
                  const orow = e.overlay[ry];
                  const ocd = orow && (orow[rx] || orow[orow.length - 1]);
                  if (ocd) {
                    if (e.overlayTint) blitBldCell(ocd.col, ocd.row, px, py, e.overlaySheet);
                    else blitCell(e.overlaySheet, ocd.col, ocd.row, px, py, cell);
                  }
                }
                if (Array.isArray(e.layers)) {
                  for (let li = 0; li < e.layers.length; li++) {
                    const layer = e.layers[li];
                    const lrow = layer && layer.cells && layer.cells[ry];
                    const lcd = lrow && (lrow[rx] || lrow[lrow.length - 1]);
                    if (!lcd || !layer.sheet) continue;
                    if (layer.tint) blitBldCell(lcd.col, lcd.row, px, py, layer.sheet);
                    else blitCell(layer.sheet, lcd.col, lcd.row, px, py, cell);
                  }
                }
              }
            }
          }
          if (Array.isArray(e.overhang) && drewBld) {
            const opy = (b.y1 + offY - 1 - oy) * cell;
            const ow = e.overhang.length;
            for (let bx = b.x1; bx <= b.x2; bx++) {
              let rx = bx - b.x1 - offX;
              if (multiCell && ow < bfw && (rx < 0 || rx >= ow)) continue;
              if (rx >= ow) rx = ow - 1; if (rx < 0) rx = 0;
              const ocell = e.overhang[rx];
              if (!ocell) continue;
              const opx = (bx - ox) * cell;
              // `overhangSheet` is optional: a creature statue's TOP cell is on its own page, absent => base sheet.
              if (blitBldCell(ocell.col, ocell.row, opx, opy, e.overhangSheet)) {
                if (Array.isArray(e.overlayOverhang) && e.overlaySheet) {
                  const oov = e.overlayOverhang[rx];
                  if (oov) blitCell(e.overlaySheet, oov.col, oov.row, opx, opy, cell);
                }
              }
            }
          }
        } else if (e && e.sheet && typeof e.col === "number") {
          for (let by = b.y1; by <= b.y2; by++) {
            for (let bx = b.x1; bx <= b.x2; bx++) {
              const px = (bx - ox) * cell, py = (by - oy) * cell;
              if (blitBldCell(e.col, e.row, px, py)) { drewBld = true; }
            }
          }
        }
        if (!drewBld) {
          const bx1 = (b.x1 - ox) * cell, by1 = (b.y1 - oy) * cell;
          const bx2 = (b.x2 - ox + 1) * cell, by2 = (b.y2 - oy + 1) * cell;
          ctx.strokeStyle = BLD_OUTLINE;
          ctx.lineWidth = 1;
          ctx.strokeRect(bx1 + 0.5, by1 + 0.5, Math.max(1, bx2 - bx1 - 1), Math.max(1, by2 - by1 - 1));
        }
      } catch (_) { /* per-building guarded */ }
        ctx.restore();
      }
    }, () => {
      drawFarmCrops(tiles, gw, gh, cell);
    });

    let workedTiles = null;
    {
      const wdj = Array.isArray(data.djobs) ? data.djobs : null;
      if (wdj) {
        for (let di = 0; di < wdj.length; di++) {
          const dj = wdj[di];
          if (!dj || !dj.w || !isBlinkingDesignationJob(dj.k)) continue;
          if (!workedTiles) workedTiles = new Set();
          workedTiles.add(dj.x + "|" + dj.y + "|" + dj.z);
        }
      }
    }
    const units = Array.isArray(data.units) ? data.units : [];
    const races = creaturesMap && creaturesMap.races;
    const cpx = (creaturesMap && creaturesMap.cell) || 32;
    const r = Math.max(2, Math.floor(cell / 3));
    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui];
      if (!u) continue;
      const udz = (typeof u.z === "number") ? u.z - oz : 0;
      // A unit renders on its own z-plane, or below the camera only when the server tagged it see-down-visible
      // (u.sd). Untagged off-z units are dropped: those are stale cross-z AUX ghosts on the wrong level.
      const seeDownU = !!u.sd && udz < 0;
      if (udz !== 0 && !seeDownU) continue;
      if (udz === 0 && workedTiles && workedTiles.has(u.x + "|" + u.y + "|" + u.z) &&
          !workedTileUnitVisible(uiMs)) continue;
      // Floor a see-down unit's opacity: the raw fog curve reaches 0 by depth ~8 and would re-hide it.
      // The deepening blue comes from the fog-washed terrain behind it, showing through.
      const uAlpha = seeDownU ? Math.max(0.55, 1 - fogAlphaForDepth(-udz)) : 1;
      const ghost = unitGhostPlan(u);
      ctx.save();
      ctx.globalAlpha = ghost ? uAlpha * ghost.alpha : uAlpha;
      // Drawn AFTER the unit so the flash reads as emphasis on the dwarf rather than replacing it.
      const flash = unitMapFlash(u.st, uiMs);
      try {
        const px = (u.x - ox) * cell, py = (u.y - oy) * cell;
        let drewU = false;
        const sel = resolveUnitTier(u, races);
        if (sel.tier === 1) {
          // Anchored so the unit's OWN tile is the anchor's bottom cell: top-left = (x-ax, y-ay).
          const ax = (typeof u.ax === "number") ? u.ax : 0;
          const ay = (typeof u.ay === "number") ? u.ay : Math.max(0, u.sh - 1);
          const spx = (u.x - ax - ox) * cell, spy = (u.y - ay - oy) * cell;
          const usp = sel.sprite;
          if (ghost) blitGhostTinted(usp.img, 0, 0, usp.img.width, usp.img.height, spx, spy, u.sw * cell, u.sh * cell);
          else ctx.drawImage(usp.img, 0, 0, usp.img.width, usp.img.height, spx, spy, u.sw * cell, u.sh * cell);
          drewU = true;
        } else if (sel.tier === 3) {
          const s = getSheet(sel.rec.sheet);
          if (s && s.loaded && !s.failed) {
            // LARGE_IMAGE flat creatures carry w/h > 1 in creatures_map.json: span that many cells instead of
            // stretching the top-left one. Anchor is centre column, bottom row; w===h===1 is the single-cell draw.
            const rw = sel.rec.w || 1, rh = sel.rec.h || 1;
            const rax = (rw === 1) ? 0 : 1;
            const ray = rh - 1;
            const spx = (u.x - rax - ox) * cell, spy = (u.y - ray - oy) * cell;
            if (ghost) blitGhostTinted(s.img, sel.rec.col * cpx, sel.rec.row * cpx, rw * cpx, rh * cpx,
                          spx, spy, rw * cell, rh * cell);
            else ctx.drawImage(s.img, sel.rec.col * cpx, sel.rec.row * cpx, rw * cpx, rh * cpx,
                          spx, spy, rw * cell, rh * cell);
            drewU = true;
          }
        } else if (sel.tier === 4) {
          const bname = (u.ct === "FEMALE") ? "dwarf_female.png" : (sel.rec.baked || "dwarf.png");
          const bk = getBaked(bname);
          if (bk && bk.loaded && !bk.failed) {
            if (ghost) blitGhostTinted(bk.img, 0, 0, bk.img.width, bk.img.height, px, py, cell, cell);
            else ctx.drawImage(bk.img, 0, 0, bk.img.width, bk.img.height, px, py, cell, cell);
            drewU = true;
          }
        }
        if (!drewU) {
          const ux = px + cell / 2, uy = py + cell / 2;
          ctx.beginPath();
          ctx.arc(ux, uy, r, 0, Math.PI * 2);
          ctx.fillStyle = ghost ? GHOST_TINT_CSS : UNIT_COLOR;
          ctx.fill();
          ctx.strokeStyle = UNIT_OUTLINE;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        const plan = unitStatusDrawPlan(u, ox, oy, cell, uiMs, uAlpha);
        if (plan) {
          const stSheet = getSheet(plan.sheet);
          if (stSheet && stSheet.loaded && !stSheet.failed) {
            ctx.drawImage(stSheet.img, plan.col * 32, plan.row * 32, 32, 32,
                          plan.dx, plan.dy, plan.dw, plan.dh);
          }
        }
      } catch (_) { /* per-unit guarded */ }
      if (flash && flash.on) {
        try {
          const fx = (u.x - ox) * cell, fy = (u.y - oy) * cell;
          const rgb = flash.rgb || [255, 255, 255];
          ctx.globalAlpha = (ghost ? uAlpha * ghost.alpha : uAlpha) * 0.35;
          ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          ctx.fillRect(fx, fy, cell, cell);
        } catch (_f) { /* a flash never blanks a unit */ }
      }
      ctx.restore();
    }

    drawProjectiles(data, ox, oy, oz, cell);

    // ---- OVERLAY LAYER (wire:5): designations + presence, on top of everything ----
    let djobMap = null;
    const djobs = Array.isArray(data.djobs) ? data.djobs : null;
    if (djobs && djobs.length) {
      // camera-plane unit tiles ("x|y|z") decide state 2; `w` off the wire decides state 1 vs 0.
      let unitTiles = null;
      const dus = Array.isArray(data.units) ? data.units : null;
      if (dus && dus.length) {
        unitTiles = new Set();
        for (let ui = 0; ui < dus.length; ui++) {
          const u = dus[ui];
          if (u && typeof u.x === "number" && typeof u.y === "number") unitTiles.add(u.x + "|" + u.y + "|" + u.z);
        }
      }
      djobMap = new Map();
      for (let di = 0; di < djobs.length; di++) {
        const dj = djobs[di];
        if (!dj) continue;
        const gx = dj.x - ox, gy = dj.y - oy;
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
        djobMap.set(gy * gw + gx, { k: dj.k, w: !!dj.w,
          onTile: !!(dj.w && unitTiles && unitTiles.has(dj.x + "|" + dj.y + "|" + dj.z)) });
      }
    }
    const designationNowMs = uiMs;
    for (let i = 0; i < n; i++) {
      const t = tiles[i];
      if (!t) continue;
      const dje = djobMap ? djobMap.get(i) : null;
      const dk = dje ? dje.k : 0;
      if (!t.desig && !dk) continue;
      const gx = i % gw, gy = (i - gx) / gw;
      drawDesignation(t, gx * cell, gy * cell, cell, dk, designationNowMs,
        !!(dje && dje.w), !!(dje && dje.onTile));
    }
    if (toolStateOverlayVisibleTiles("mining")) {
      for (let i = 0; i < n; i++) {
        const t = tiles[i];
        if (!t) continue;
        const gx = i % gw, gy = (i - gx) / gw;
        drawMiningIndicator(t, gx * cell, gy * cell, cell);
      }
    }
    drawFlows(tiles, n, gw, cell, worldMs);   // miasma frame cycle freezes on game pause
    drawPresence(data, ox, oy, oz, cell, gw, gh);

    // ?nolegend=1 suppresses the legend so the parity gate never diffs legend pixels against DF's frame.
    if (manageCamera && !params.has("nolegend")) drawLegend(data);
    return true;   // painted this frame
  }

  function drawConnectingOverlay() {
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#eee";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("connecting...", w / 2, h / 2);
    ctx.restore();
  }

  function drawLegend(data) {
    const lines = [
      `player: ${player}`,
      `origin: ${data.origin.x}, ${data.origin.y}, ${data.origin.z}`,
    ];
    ctx.save();
    ctx.font = "12px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const pad = 6;
    const lineH = 14;
    const boxW = 220;
    const boxH = pad * 2 + lineH * lines.length;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(6, 6, boxW, boxH);
    ctx.fillStyle = "#ddd";
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 6 + pad, 6 + pad + i * lineH);
    }
    ctx.restore();
  }

  // ---- polling loop -----------------------------------------------------------
  const POLL_MS = 500; // ~2x/sec
  let pollTimer = null;

  function scheduleNext(delayMs) {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollLoop, Math.max(0, delayMs));
  }

  function pollNow() {
    scheduleNext(0);
  }

  async function pollLoop() {
    const start = Date.now();
    // If the WS push is live it already feeds draw(); the loop stays scheduled so it resumes on a drop.
    if (wsAlive) {
      scheduleNext(POLL_MS - (Date.now() - start));
      return;
    }
    try {
      const dims = desiredWinDims();
      const resp = await fetch(
        `/mapdata?player=${encodeURIComponent(player)}&w=${dims.w}&h=${dims.h}`, {
        cache: "no-store",
      });
      if (!resp.ok) {
        // Includes 503 (server not ready yet) -- just keep retrying on the normal cadence.
        connected = false;
        setHud("connecting...");
        draw();
      } else {
        let data = null;
        try {
          data = await resp.json();
        } catch (_) {
          data = null;
        }
        if (isValidMapData(data)) {
          latest = data;
          connected = true;
          markMapUpdate();
          // The GL renderer reads terrain from the cache, never from `latest`, so the HTTP poll fallback must
          // fill the cache too or a WS-less GL player sees a blank map with units and buildings floating on it.
          try {
            if (window.DwfCache && typeof DwfCache.ingest === "function") DwfCache.ingest(data);
          } catch (_) { /* shadow cache: never affect the poll's real job */ }
          publishRoster(data.players);   // the poll fallback also feeds the roster surface
          setHud(`player: ${player}  camera: ${data.origin.x}, ${data.origin.y}, ${data.origin.z}`);
          draw();
        } else {
          connected = false;
          setHud("connecting...");
          draw();
        }
      }
    } catch (_) {
      connected = false;
      setHud("connecting...");
      draw();
    } finally {
      const elapsed = Date.now() - start;
      scheduleNext(POLL_MS - elapsed);
    }
  }

  // ---- camera controls (mirrors dwf-core.js's WASD/arrow/PageUp-PageDown) ----
  const STEP = 10;         // native d_init scroll speed
  const STEP_FAST_MULT = 2;// native *_scroll_speed_fast (20) / normal (10)
  const ZSTEP = 1;         // CURSOR_UP_Z / CURSOR_DOWN_Z
  const ZSTEP_FAST = 10;   // CURSOR_UP_Z_FAST / CURSOR_DOWN_Z_FAST (hardcoded in DF)
  let moveBusy = false;

  function isTextEditingTarget(target) {
    const tag = target && target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!(target && target.isContentEditable);
  }

  function sendMove(dx, dy, dz) {
    if (moveBusy) return;
    moveBusy = true;
    noteCamDelta(dx, dy, dz);   // instant cache re-window for standalone tiles.html too
    const url = `/camera?player=${encodeURIComponent(player)}&dx=${dx}&dy=${dy}&dz=${dz}`;
    fetch(url, { method: "POST", cache: "no-store" })
      .catch(() => {})
      .finally(() => {
        moveBusy = false;
        pollNow();
      });
  }

  function handleCameraKey(event) {
    if (!event || isTextEditingTarget(event.target)) return false;
    if (event.altKey || event.metaKey || event.ctrlKey) return false;
    const pan = event.shiftKey ? STEP * STEP_FAST_MULT : STEP;
    switch (event.key) {
      case "ArrowLeft": case "a": case "A":
        sendMove(-pan, 0, 0); return true;
      case "ArrowRight": case "d": case "D":
        sendMove(pan, 0, 0); return true;
      case "ArrowUp": case "w": case "W":
        sendMove(0, -pan, 0); return true;
      case "ArrowDown": case "s": case "S":
        sendMove(0, pan, 0); return true;
      case "PageUp": case "e":
        sendMove(0, 0, ZSTEP); return true;
      case "PageDown": case "c":
        sendMove(0, 0, -ZSTEP); return true;
      case "E":
        sendMove(0, 0, ZSTEP_FAST); return true;
      case "C":
        sendMove(0, 0, -ZSTEP_FAST); return true;
      default:
        return false;
    }
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    addEventListener("keydown", (event) => {
      try {
        if (event && event.key === "F3" && !event.altKey && !event.metaKey && !event.ctrlKey) {
          if (document.getElementById("helpPopup")?.classList.contains("open")) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }
          toggleDiag();
          event.preventDefault();
        }
      } catch (_) { /* never throw out of an input handler */ }
    }, { capture: true });
    if (manageCamera) {
      addEventListener("keydown", (event) => {
        try {
          if (handleCameraKey(event)) {
            event.preventDefault();
          }
        } catch (_) {
          // never throw out of an input handler
        }
      }, { capture: true });
    }
    // Always keep the canvas sized to the window (both modes want this).
    addEventListener("resize", () => {
      try { resizeCanvas(); } catch (_) { /* ignore */ }
    });
    // Standalone only: the embedded client owns input and already sends /placement-cursor.
    if (manageCamera) bindPresenceBroadcast();
    bindSmoothCursorSend();
  }

  const PRESENCE_MS = 100;  // ~10/s
  let lastPresenceSend = 0;
  let lastPresenceKey = "";

  function sendPresenceCursor(hx, hy) {
    const q = `player=${encodeURIComponent(player)}&hx=${hx}&hy=${hy}` +
              `&w=${(geom && geom.gw) || 0}&h=${(geom && geom.gh) || 0}` +
              `&drag=0&dx=-1&dy=-1&bw=0&bh=0`;
    fetch(`/placement-cursor?${q}`, { method: "POST", cache: "no-store" }).catch(() => {});
  }

  function bindPresenceBroadcast() {
    if (!canvas) return;
    canvas.addEventListener("mousemove", (event) => {
      try {
        const now = Date.now();
        if (now - lastPresenceSend < PRESENCE_MS) return;
        const g = screenToGrid(event.clientX, event.clientY, false);
        if (!g) return;                       // off the drawn map -> don't move the cursor
        const key = g.gx + "," + g.gy;
        if (key === lastPresenceKey) return;  // same tile -> nothing changed
        lastPresenceSend = now;
        lastPresenceKey = key;
        sendPresenceCursor(g.gx, g.gy);
      } catch (_) { /* never throw out of an input handler */ }
    });
    // Clear our cursor when the pointer leaves so it doesn't linger for others.
    canvas.addEventListener("mouseleave", () => {
      try {
        lastPresenceKey = "";
        lastPresenceSend = Date.now();
        sendPresenceCursor(-1, -1);
      } catch (_) { /* ignore */ }
    });
  }

  // ---- screen<->tile hit-testing ---------------------------------------------------
  function screenToGrid(clientX, clientY, clamp) {
    if (!canvas || !geom) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width ? (rect.width / canvas.width) : 1;
    const cellS = geom.cell * (scale || 1);
    if (cellS <= 0) return null;
    let gx = Math.floor((clientX - rect.left) / cellS);
    let gy = Math.floor((clientY - rect.top) / cellS);
    if (clamp) {
      gx = Math.max(0, Math.min(geom.gw - 1, gx));
      gy = Math.max(0, Math.min(geom.gh - 1, gy));
    } else if (gx < 0 || gy < 0 || gx >= geom.gw || gy >= geom.gh) {
      return null;
    }
    return { gx, gy, gw: geom.gw, gh: geom.gh };
  }

  function getRenderRect() {
    if (!canvas || !geom) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width ? (rect.width / canvas.width) : 1;
    const cellS = geom.cell * (scale || 1);
    return {
      left: rect.left, top: rect.top,
      cell: cellS, gw: geom.gw, gh: geom.gh,
      width: cellS * geom.gw, height: cellS * geom.gh,
      ox: geom.ox, oy: geom.oy, oz: geom.oz,
    };
  }

  // ---- protocol v1 session callbacks -----------------------------------------------
  function handleHelloAckV1(ack) {
    try {
      if (ack && ack.map && typeof ack.map.w === "number") {
        // hello_ack carries no world id: a changed footprint, or a world_seq that went BACKWARDS, is the only
        // signal a different fort loaded -- and everything keyed to the old one must be dropped with it.
        const worldChanged = !!v1MapDims && (v1MapDims.w !== ack.map.w || v1MapDims.h !== ack.map.h ||
          v1MapDims.z !== ack.map.z ||
          (typeof ack.world_seq === "number" && typeof v1WorldSeq === "number" && ack.world_seq < v1WorldSeq));
        v1MapDims = { w: ack.map.w, h: ack.map.h, z: ack.map.z };
        if (typeof ack.world_seq === "number") v1WorldSeq = ack.world_seq;
        if (worldChanged) {
          try { if (window.DwfCache && typeof window.DwfCache.reset === "function") window.DwfCache.reset(); }
          catch (_) { /* cache optional */ }
          try { if (typeof window.dfcResetPortraitState === "function") window.dfcResetPortraitState(); }
          catch (_) { /* unit HUD optional on tiles.html */ }
          // The hidden-tile scatter is deliberately NOT reset on a world change: it is a pure function of
          // (block_x, block_y, z), so a leftover entry hands the new world exactly what regenerating would.
        }
        try {
          if (window.DwfCache && typeof window.DwfCache.setMapDims === "function") {
            window.DwfCache.setMapDims(ack.map.w, ack.map.h, ack.map.z);
          }
        } catch (_) { /* cache optional; canvas2d reads v1MapDims directly */ }
      }
      // Adopt the server's authoritative (possibly deduped) player name so every ?player= key matches it.
      if (ack && typeof ack.player === "string" && ack.player && ack.player !== player) {
        player = ack.player;
        if (typeof window.__dwfAdoptName === "function") window.__dwfAdoptName(ack.player);
      }
    } catch (_) { /* diagnostic-only field; a missing/malformed map just skips clamping */ }
  }
  // AUX (~30Hz): units/buildings/players plus the authoritative server camera. On a v1 session this is
  // the ONLY source of lastAux and window reconciliation -- block sets feed the world cache directly.
  let auxSeqV1 = 0;
  function handleAuxV1(aux) {
    wsAlive = true;
    try {
      if (!aux || typeof aux !== "object") return;
      if (aux.type === "auxd") {
        if (typeof aux.aseq !== "number" || aux.base !== auxSeqV1) {
          try { if (window.DwfWS) DwfWS.send({ type: "auxr" }); } catch (_) {}
          return;
        }
        let changed = false;
        if (aux.units && typeof aux.units === "object") {
          let unitsChanged = false;
          const up = Array.isArray(aux.units.up) ? aux.units.up : [];
          const rm = Array.isArray(aux.units.rm) ? aux.units.rm : [];
          for (const rec of up) {
            if (!rec || typeof rec.id !== "number") continue;
            auxUnitsById.set(rec.id, rec); unitsChanged = true;
          }
          for (const id of rm) if (auxUnitsById.delete(id)) unitsChanged = true;
          if (unitsChanged) { lastAux.units = Array.from(auxUnitsById.values()); changed = true; }
        }
        {
          let bldgsChanged = false;
          if (aux.buildings && typeof aux.buildings === "object") {
            const up = Array.isArray(aux.buildings.up) ? aux.buildings.up : [];
            const rm = Array.isArray(aux.buildings.rm) ? aux.buildings.rm : [];
            for (const rec of up) {
              if (!rec || typeof rec.id !== "number") continue;
              auxBldgsById.set(rec.id, rec);
              if (auxBldgsParked.delete(rec.id)) { /* bridged record is live again */ }
              bldgsChanged = true;
            }
            for (const id of rm) {
              const prev = auxBldgsById.get(id);
              if (prev && bldOutsideWindow(prev, aux.cam) && bldInClientWindow(prev)) parkBld(prev);
              else auxBldgsParked.delete(id);
              if (auxBldgsById.delete(id)) bldgsChanged = true;
            }
          }
          // Every delta carries its cam; sweep the bridge even when no buildings section came.
          if (reconcileParkedBldgs(aux.cam)) bldgsChanged = true;
          if (bldgsChanged) { lastAux.buildings = composeAuxBldgs(); changed = true; }
        }
        if (Object.prototype.hasOwnProperty.call(aux, "djobs")) {
          lastAux.djobs = Array.isArray(aux.djobs) ? aux.djobs : []; changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(aux, "proj")) {
          lastAux.proj = Array.isArray(aux.proj) ? aux.proj : []; changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(aux, "env")) {
          lastAux.env = (aux.env && typeof aux.env === "object") ? aux.env : null; changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(aux, "players")) {
          lastAux.players = Array.isArray(aux.players) ? aux.players : [];
          publishRoster(lastAux.players); changed = true;
        }
        auxSeqV1 = aux.aseq;
        reconcileAuxCam(aux.cam);
        connected = true;
        markMapUpdate();
        if (changed) mapDirty = true;
        return;
      }
      if (typeof aux.aseq === "number") auxSeqV1 = aux.aseq;
      // Pass the full-frame arrays through UNCHANGED: an older live server emits building records with no
      // "id", and rebuilding them from the id-keyed maps would silently drop them.
      const fullUnits = Array.isArray(aux.units) ? aux.units : [];
      const fullBldgs = Array.isArray(aux.buildings) ? aux.buildings : [];
      auxUnitsById.clear();
      for (const rec of fullUnits)
        if (rec && typeof rec.id === "number") auxUnitsById.set(rec.id, rec);
      const prevBldgs = auxBldgsById.size ? new Map(auxBldgsById) : null;
      auxBldgsById.clear();
      for (const rec of fullBldgs)
        if (rec && typeof rec.id === "number") auxBldgsById.set(rec.id, rec);
      if (prevBldgs) {
        for (const [id, b] of prevBldgs) {
          if (auxBldgsById.has(id) || auxBldgsParked.has(id)) continue;
          if (bldOutsideWindow(b, aux.cam) && bldInClientWindow(b)) parkBld(b);
        }
      }
      reconcileParkedBldgs(aux.cam);
      const fullBldgsOut = auxBldgsParked.size
        ? fullBldgs.concat(Array.from(auxBldgsParked.values()))
        : fullBldgs;
      lastAux = { units: fullUnits, buildings: fullBldgsOut, players: aux.players || [],
                  proj: Array.isArray(aux.proj) ? aux.proj : [],   // projectiles/vehicles
                  djobs: Array.isArray(aux.djobs) ? aux.djobs : [],  // designation jobs
                  env: (aux.env && typeof aux.env === "object") ? aux.env : null }; // weather/season
      publishRoster(aux.players);   // feed the roster surface (elevation bar / minimap / lobby)
      reconcileAuxCam(aux.cam);
      connected = true;
      markMapUpdate();
      setHud(`player: ${player}  camera: ${bufOx}, ${bufOy}, ${bufOz}`);
      mapDirty = true; // belt & suspenders: units/buildings changed even if cam didn't
    } catch (_) { /* never throw out of the socket callback */ }
  }

  // ---- boot / public API ------------------------------------------------------
  function boot() {
    try {
      bindListeners();
      resizeCanvas();
      if (managePoll) pollLoop();
      // If the socket never connects or drops, onClose flips wsAlive false and pollLoop() resumes polling.
      if (window.DwfWS && managePoll) {
        const d = desiredWinDims();
        DwfWS.connect(player,
          () => { wsAlive = true; },
          () => { wsAlive = false; },       // onClose: fall back to HTTP polling
          d,
          { proto1: v1Active(), onAux: handleAuxV1, onHelloAck: handleHelloAckV1,
            onItemDefDict: handleItemDefDictV1, clientId: clientId,
            initialCam: desiredCam || { x: 0, y: 0, z: 0 } });
        startMapDrawLoop();
        if (typeof DwfWS.setCursorHandler === "function") {
          DwfWS.setCursorHandler(ingestSmoothCursors);
          startCursorOverlay();
        }
      }
      loadJsonMap("/item_type_meta.json", (d) => {
        if (d && Array.isArray(d.item_types)) applyItemTypeMeta(d.item_types);
      });
      if (window.DwfCache && typeof DwfCache.setTiletypeMeta === "function") {
        loadJsonMap("/tiletype_meta.json", (d) => {
          if (d && Array.isArray(d.tiletypes)) DwfCache.setTiletypeMeta(d.tiletypes);
        });
        if (typeof DwfCache.onDirty === "function") {
          DwfCache.onDirty(() => { mapDirty = true; });
        }
      }
      loadSpriteMap();
      loadTokenMap();
      loadShadowCellMap();
      loadJsonMap("/item_map.json", (d) => { itemMap = d; });
      // __dfcMaterialSettled is set once the fetch ATTEMPT completes, success or fail, and blocks nothing.
      loadJsonMap("/material_map.json?v=c3b8ef13", (d) => { materialMap = d; buildPaletteLookup(); })
        .then(() => { try { window.__dfcMaterialSettled = true; } catch (_) {} });
      loadJsonMap("/plant_map.json", (d) => { plantMap = d; });
      loadJsonMap("/tree_map.json", (d) => { treeMap = d; });
      loadJsonMap("/building_map.json", (d) => { buildingMap = d; });
      loadJsonMap("/creatures_map.json", (d) => { creaturesMap = d; });
      loadJsonMap("/spatter_map.json", (d) => { spatterMap = d; });
      loadJsonMap("/overlay_map.json", (d) => { overlayMap = d; });
      loadGrassColors(); // per-species grass tint table
      getBaked("dwarf.png");
      getBaked("dwarf_female.png");
      getSheet("liquids.png");
      getSheet(DESIG_SHEET); // designation-overlay glyph sheet (wire:5)
    } catch (_) {
      // Even boot failures should leave the page inert rather than throwing.
    }
  }

  function init(opts) {
    opts = opts || {};
    const el = (typeof opts.canvas === "string") ? document.getElementById(opts.canvas) : opts.canvas;
    if (!el || typeof el.getContext !== "function") return null;
    canvas = el;
    ctx = canvas.getContext("2d");
    hud = opts.hud ? ((typeof opts.hud === "string") ? document.getElementById(opts.hud) : opts.hud) : null;
    if (opts.player) player = opts.player;
    if (typeof opts.manageCamera === "boolean") manageCamera = opts.manageCamera;
    if (typeof opts.managePoll === "boolean") managePoll = opts.managePoll;
    onDrawCb = (typeof opts.onDraw === "function") ? opts.onDraw : null;
    boot();
    return api;
  }

  function drawsPerSecNow() {
    const now = Date.now();
    let c = 0;
    for (let i = drawRing.length - 1; i >= 0; i--) { if (now - drawRing[i] > 1000) break; c++; }
    return c;
  }

  function getStats() {
    return {
      renderer: "canvas2d", sceneBuildCount,
      lastDrawMs: +lastDrawMs.toFixed(2),
      drawsPerSec: drawsPerSecNow(),
    };
  }

  const api = {
    init,
    // THE one canonical name->colour helper: every multiplayer surface calls DwfTiles.playerColor(name)
    // rather than re-implementing it. dwf-gl.js's playerColorRgb re-expresses the same hash as RGB.
    playerColor,
    getPlantMap: () => plantMap,
    getSpriteMap: () => spriteMap,
    getItemDefTokens: () => itemDefTokens,
    getItemTypeNames: () => itemTypeNames,
    _projItemVisualForTest: projItemVisual,
    _setItemDefTokensForTest: (m) => { itemDefTokens = m; },
    resolveItemSpriteRef,
    refresh: pollNow,      // force an immediate /mapdata refetch (after a camera move)
    getLatest: () => latest,
    isConnected: () => connected,
    resize: resizeCanvas,
    draw,
    screenToGrid,
    getRenderRect,
    backingScale,   // -> min(2, devicePixelRatio), or 1 when the kill switch is off
    renderCellPx,   // (cssPx?) -> integer PHYSICAL px per tile at that ladder rung
    cellPxFor,      // (canvasW,canvasH,gw,gh,cssPx?) -> integer physical cell actually drawn
    hiDpiEnabled,   // -> bool (localStorage 'dwf.dpr' !== '0')
    setHiDpi,       // (bool) -> persist + re-apply to this canvas (GL follows on its next frame)
    zoom,        // zoom("in"|"out") -> {dw,dh} change in requested window tile dims
    zoomTo,      // zoomTo(px) -> {dw,dh}; set an exact px/tile
    getZoom,     // -> {px,min,max,def}
    pingSplash,  // pingSplash(x,y,z,name) -> spawn a location-ping splash in name's colour
    getStats,    // -> {renderer, sceneBuildCount}
    tileColor: (t, skipLiquidColor) => tileColor(t, skipLiquidColor),
    matRgb,
    wallMaterialRgb,
    terrainSpriteRef: (t, gx, gy) => terrainSpriteRef(t, gx, gy),
    plantSpriteRef: (t) => plantSpriteRef(t),
    treeSpriteRef: (t, gx, gy) => treeSpriteRef(t, gx, gy),
    _wantsHiddenHatchForTest: wantsHiddenHatch,   // tt<0 in-bounds -> hidden-path decision
    voxelColor: (t) => voxelColor(t),
    wallSpriteRef: (t, gx, gy, openMask, drawZ) => wallSpriteRef(t, gx, gy, openMask, drawZ),
    unitSpriteRefs: (u) => unitSpriteRefs(u),
    buildingSpriteRef: (b) => buildingSpriteRef(b),
    drawBuildingGhost: (ctx, b, opts) => drawBuildingGhost(ctx, b, opts),
    buildingGhostExtent: (b) => buildingGhostExtent(b),
    _wantsHiddenHatchForTest: wantsHiddenHatch,   // tt<0 in-bounds -> base-hatch decision
    _inMapBoundsForTest: inMapBounds,             // (t,dims) footprint test
    _hiddenScatterForTest: hiddenScatterFor,      // (bx,by,z) -> [{bx,by,variant} x4]
    _hiddenVariantAtForTest: hiddenVariantAt,     // (wx,wy,wz) -> 0..4, or -1 for "draw nothing"
    _resetHiddenScatterForTest: resetHiddenScatter,
    _overlaysAllowedForTest: overlaysAllowed,     // only DISCOVERED tiles get the overlay stack
    _setMapDimsForTest: (d) => { v1MapDims = d; },  // inject hello_ack footprint headless
    _lastAuxForTest: () => lastAux,
    _parkedBldgsForTest: () => Array.from(auxBldgsParked.keys()),
    _bldOutsideWindowForTest: bldOutsideWindow,
    // pure single-regime zoom step (px,dir) -> next px, clamped to [min,max].
    _zoomStepPxForTest: zoomStepPx,
    _windowDimsForTest: desiredWinDims,
    _zoomConstantsForTest: () => ({ min: TILE_PX_MIN, max: TILE_PX_MAX, def: TILE_PX_DEFAULT,
      ladder: ZOOM_LADDER.slice(), srcPx: SPRITE_SRC_PX }),
    _setBackingDprForTest: (d) => { backingDpr = Math.max(1, d || 1); },
    _backingDprForTest: () => backingDpr,
    _pingSplashForTest: pingSplash,
    _pingSplashCountForTest: () => activePings.length,
    _drawPingSplashesForTest: (octx, now) => drawPingSplashes(octx, now),
    _setGeomForTest: (g) => { geom = g; },
    noteCamDelta,     // noteCamDelta(dx,dy,dz) -- relative shift (pan/z-step)
    setCamAbsolute,   // setCamAbsolute(x,y,z) -- absolute jump (center-on-cursor)
    getDesiredCam: () => (desiredCam ? { x: desiredCam.x, y: desiredCam.y, z: desiredCam.z } : null),
    _buildingEntryForTest: buildingEntry,
    _setBuildingMapForTest: (m) => { buildingMap = m; },
    _statueEntryForTest: statueEntry,     // (b) -> 3-cell statue composite entry | null
    _plannedConstructionEntryForTest: plannedConstructionEntryTiles,
    _constructionPlannedTokenForTest: window.DwfConstructionSelect && window.DwfConstructionSelect.PLANNED_TOKENS,
    _bridgeTileIndexForTest: bridgeTileIndexTiles,
    _bridgeEntryForTest: bridgeEntryTiles,
    _buildingsInPaintOrderForTest: buildingsInPaintOrder,
    _buildingAlphaForZForTest: buildingAlphaForZ,
    _resolveDesigForTest: resolveDesig,
    _DESIG_TINT: DESIG_TINT,
    _AUTOMINE_SPRITE_TINT: AUTOMINE_SPRITE_TINT,
    _resolveDjobForTest: resolveDjobTiles,
    _designationGlyphVisibleForTest: designationGlyphVisible,
    _hasBlinkingDesignationJobForTest: hasBlinkingDesignationJob,
    _workedTileUnitVisibleForTest: workedTileUnitVisible,
    _designationBlinkStateForTest: designationBlinkState,   // three-state cadence
    _activeBlinkVisibleForTest: activeBlinkVisible,         // 400ms half-beat
    _DESIG_ACTIVE_BLINK_MS: DESIG_ACTIVE_BLINK_MS,
    _resolveTileDesignationForTest: resolveTileDesignation,
    _drawDesignationForTest: drawDesignation,   // drives the designation overlay against the init ctx
    setMineMode: setMineMode,
    setToolStateOverlay: setToolStateOverlayTiles,
    _toolStateOverlayVisibleForTest: toolStateOverlayVisibleTiles,
    MINING_SHEET: MINING_SHEET, MINING_CELL: MINING_CELL,
    _miningIndicatorCellForTest: miningIndicatorCell,
    _drawMiningIndicatorForTest: drawMiningIndicator,
    // fixed-blue marker palette constants -- must stay equal to dwf-gl.js's.
    _DESIG_WASH_ALPHA: DESIG_WASH_ALPHA, _DESIG_WASH_ALPHA_MARKER: DESIG_WASH_ALPHA_MARKER,
    _MARKER_RECOLOR: MARKER_RECOLOR, _MARKER_GLYPH_TINT: MARKER_GLYPH_TINT, _MARKER_WASH_RGB: MARKER_WASH_RGB,
    _flowOverlayForTest: flowOverlayFor,  // (cloud, nowMs) -> {rgb,alpha}|null (miasma haze)
    _drawFlowsForTest: drawFlows,         // drives the haze pass against the init ctx directly
    _machineEntryForTest: machineEntry,   // (b, buildingMap, frameParity) -> synth entry|null
    _machineFrameParityForTest: machineFrameParity,
    _machineAnimPhaseForTest: machineAnimPhase,
    _uiAnimMsForTest: uiAnimMs,           // UI blink clock; raw wall time unless frozen
    _machineCadenceStepForTest: machineCadenceStep,
    _hasDrawableMachineForTest: hasDrawableMachine,
    _farmPlotEntryForTest: farmPlotEntry,  // (b) -> furrowed/planted bed entry|null
    _farmCropPlansForTest: farmCropPlans,  // shared per-stage crop overlay plans
    _setSpriteMapForTest: (m) => { spriteMap = m; }, // inject a mock /sprites/map.json in a headless harness
    _setTiletypeTokenMapForTest: (m) => { tiletypeTokenMap = m; },  // inject the real token map headless
    _setSheetForTest: (name, sheet) => { sheets[name] = { visibleCells: new Map(), ...sheet }; },
    _resolveFlowFrameCellForTest: resolveFlowFrameCell,
    _worldAnimMsForTest: worldAnimMs,   // pause-aware world clock feeding flows + machines
    _isOverlayOnlyBuildingTypeForTest: isOverlayOnlyBuildingType,
    _pickBuildingPalRowForTest: pickBuildingPalRow,     // component STATE_COLOR token -> exact palette row
    _liquidEdgeTokensForTest: (t, gx, gy, lookupTile, Adj) => liquidEdgeTokens(t, gx, gy, lookupTile, Adj),
    _sheetCellGeometryForTest: sheetCellGeometry,
    _resolveItemEntryForTest: resolveItemEntry,
    _setItemMapForTest: (m) => { itemMap = m; },
    _setPlantMapForTest: (m) => { plantMap = m; },
    _resolvePlantEntryForTest: plantEntry,
    _setCreaturesMapForTest: (m) => { creaturesMap = m; },
    _resolveItemVisualForTest: resolveItemVisual,   // {entry,source} incl itemdef+material steps
    _containerPeekEntryForTest: containerPeekEntryCanvas, // (containerItem, peek) -> overlay cell|null
    _drawItemForTest: drawItem,                     // drives the item layer (incl. peek composite)
    remapPaletteForRow: (data, palRow) => {
      const rows = materialMap && materialMap.palette && materialMap.palette.rows;
      const target = rows && rows[palRow];
      return paletteLookup && target ? remapPaletteData(data, paletteLookup, target) : data;
    },
    _matPalRowForTest: matPalRowFor,                // material -> palette row
    _matFamilyForItemForTest: matFamilyForItem,     // EXACT METAL/STONE family (material-aware)
    _paletteRemapForTest: (palRow) => {             // pure remap fn used by paletteSwappedCell
      if (!paletteLookup || !materialMap || !materialMap.palette) return null;
      const target = materialMap.palette.rows[palRow];
      if (!target || !target.length) return null;
      return (d) => remapPaletteData(d, paletteLookup, target);
    },
    _setMaterialMapForTest: (m) => { materialMap = m; buildPaletteLookup(); },
    // Gem-variant lockstep: both renderers must pick the SAME arrangement for the same gem on the same
    // tile, or two players looking at one fort would see two different pictures.
    _gemVariantForTest: (it, v, gx, gy) => gemVariantForItem(it, v, gx, gy),
    _gemVariantCellForTest: gemVariantCell,
    _edgeOvergrowthPlanForTest: (gx, gy, lookup) => edgeOvergrowthPlan(gx, gy, lookup),
    _drawEdgeOvergrowthForTest: drawEdgeOvergrowth,
    _sandFloorPlanForTest: sandFloorPlan,
    _smoothFloorTokenForTest: (t) => window.DwfTerrainVariant && window.DwfTerrainVariant.smoothFloorToken(t),
    _itemSpatterPlanForTest: itemSpatterPlan,
    // construction floor/track plan (pure: ttname + base_mt/base_mi -> {token, palRow, mask} | null)
    _constructionFloorPlanForTest: constructionFloorPlan,
    _constructionTrackMaskForTest: constructionTrackMask,
    _fortificationOpenTokenForTest: fortificationOpenToken,
    _consMaterialForTest: consMaterial,                 // base_mt/mi -> {family,palRow}|null
    _consMaterialRgbForTest: consMaterialRgb,           // base_mt/mi -> [r,g,b]|null (fill)
    _wallMaterialForTest: wallMaterial,                 // construction/natural-stone wall material policy
    _wallJoinPalRowForTest: wallJoinPalRow,             // construction/natural-stone edge swap row
    _wallBackingTokenForTest: wallBackingToken,         // natural wall dark hidden-rock underlay
    _terrainSpritePalRowForTest: terrainSpritePalRow,   // palette-authored natural terrain classes
    _wallPrefixForTest: wallPrefix,                     // (mat, base_mt) -> family prefix
    _roughInorganicWallPrefixForTest: roughInorganicWallPrefix,  // exact native family
    _roughWallVariantForTest: roughWallVariant,         // labelled approximate RNG substitute
    _wallArtParityForTest: WALL_ART_PARITY,
    _resolveVerminEntryForTest: resolveVerminEntry,
    _handleItemDefDictForTest: handleItemDefDictV1,
    _matFamilyForTest: matFamilyFor,
    _spatterFamilyForTest: spatterFamilyFor,
    _bloodFamilyFromRgbForTest: bloodFamilyFromRgb,
    _spatterShapeForTest: spatterShapeFor,
    _spatterPartialKeyForTest: partialVariantKey,
    _spatterOracleCellForTest: spatterOracleCellFor,
    _spatterCellForTest: (sp, x, y, z, salt, fullKey) => window.DwfTerrainVariant
      && window.DwfTerrainVariant.spatterCell(spatterMap, sp, x, y, z, salt, fullKey),
    _spatterVisibleForTest: spatterVisible,
    _spatterVisibleAmountForTest: SPATTER_VISIBLE_AMOUNT,
    _resolveUnitTierForTest: (u) => resolveUnitTier(u, creaturesMap && creaturesMap.races),
    _getUnitSpriteForTest: getUnitSprite,
    _unitGhostPlanForTest: unitGhostPlan,           // (u) -> {rgb,alpha,css} | null
    _ghostTintRgbForTest: GHOST_TINT_RGB,           // shared tint (== dwf-gl.js)
    _ghostAlphaForTest: GHOST_ALPHA,                // shared translucency
    _unitStatusIconForTest: unitStatusIconForBits,
    _unitMapFlashForTest: unitMapFlash,   // the overhead map-flash cadence
    _unitStatusIconNowForTest: unitStatusIconNow,          // native per-unit phase-gated resolver
    _nativeBubblePhaseForTest: nativeBubblePhase,          // phase = (id*0x86e8 + nowMs) % 7000
    _physicalStatusIconForTest: physicalStatusIconForBits,
    _ordinaryStatusIconForTest: ordinaryStatusIconForBits,
    _unitStatusVisibilitySignatureForTest: unitStatusVisibilitySignature,
    NATIVE_BUBBLE_PERIOD_MS, NATIVE_BUBBLE_ID_STRIDE, NATIVE_BUBBLE_ORDINARY_MS,
    _unitStatusBlinkVisibleForTest: unitStatusBlinkVisible,
    _unitStatusDrawPlanForTest: unitStatusDrawPlan,
    _hasDrawableUnitStatusForTest: hasDrawableUnitStatus,
    _parseTreeTtnameForTest: parseTreeTtname,
    _resolveTreeCellForTest: resolveTreeCell,
    _treeGraphicsCellsForTest: treeGraphicsCells,
    _setTreeMapForTest: (m) => { treeMap = m; },
    _resolveOverleavesForTest: resolveOverleaves,   // canopy leaf-overlay resolution
    _isTreeWallMatForTest: isTreeWallMat,           // TREE/MUSHROOM WALL-as-trunk predicate
    _wallJoinBaseTokenForTest: wallJoinBaseToken,   // (t, openMask) -> stone-edge token | null
    _wallDetailPrefixForTest: wallDetailPrefix,     // (t) -> smoothed/worn wall family | null
    _tileColorForTest: tileColor,                   // corner base-fill color assertion
    _derivedTreePartForTest: derivedTreePart,       // tail-less tree part derivation
    _grassBackingCellForTest: grassBackingCell,     // (t,gx,gy,lookup) -> grass cell | null
    _groundBackingCellForTest: groundBackingCell,   // (t,gx,gy,lookup) -> {sheet,col,row,wash} | null
    _boulderVariantForTest: boulderVariant,         // (t,gx,gy) -> {col,row} | null (8-cell fan-out)
    _isGrassBackingSourceForTest: isGrassBackingSource,
    _grassTierIndexForTest: grassTierIndex,
    _grassSpeciesTintForTest: grassSpeciesTint,
    _grassSpriteSpecForTest: grassSpriteSpec,
    // Exposed so the no-digit law (a name with no variant digit reads GRASS_1, never a positional roll)
    // is pinned in both renderers.
    _grassVariantIndexForTest: grassVariantIndex,
    _stampCellProvenanceForTest: stampCellProvenance,
    _setGrassColorsForTest: (m) => { grassColors = m; },
    _engravingWallPlanForTest: engravingWallPlan,       // engraved wall token + material row
    _engravingFloorPlanForTest: engravingFloorPlan,     // palette/non-palette floor art + row
    _itemMarkTokenForTest: itemMarkToken,
    _projCenterPxForTest: projCenterPx,
    _resolveSpriteForTest: resolveSprite,
    _getSheetForTest: getSheet,
    _fogAlphaForDepthForTest: fogAlphaForDepth,
    _fogColorForTest: () => FOG_COLOR.slice(),
    _glOccludesForTest: glOccludesCanvas2d,
    // Escalating sheet-retry backoff: 2s, 4s, 8s ... capped.
    _sheetRetryDelayForTest: sheetRetryDelay,
  };
  try { window.DwfTiles = api; } catch (_) { /* non-browser context */ }

  try {
    const legacy = document.getElementById("tilemap");
    if (legacy && !canvas) {
      init({ canvas: legacy, hud: "hud", manageCamera: true, managePoll: true });
    }
  } catch (_) { /* ignore */ }
})();
