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

// dwf-gl.js -- the WebGL2 instanced-quad renderer over the world cache: the GL pipeline plus the
// pure cache-to-instance scene build.
(function (root) {
  "use strict";

  // ---- atlas geometry mirror (must match dwf-gl-atlas.js exactly) -------------------
  var CELLS_PER_ROW = 60;
  var CELLS_PER_PAGE = 3600;
  var CELL_PITCH = 34;
  var CELL_SIZE = 32;
  var GUTTER = 1;
  var PAGE_SIZE = 2048;
  var SOLID_CELL = 0xFFFF;     // sentinel atlasCell: shader emits the tint as a flat colour
  var PENDING = 0;             // reserved transparent cell (== atlas PENDING)

  // instance record: 16 B interleaved
  //   f32 x,y (0)  | u16 atlasCell (8) | u16 attr (10) | u8 rgba (12..15)
  var INSTANCE_BYTES = 16;
  // attr bit layout: animFrames:4 | animRate:3 | ADDITIVE:1 | MARKER:1 | seeDown:4 | rsv:3
  var ATTR_ADDITIVE = 1 << 7;
  var ATTR_MARKER = 1 << 8;
  var ATTR_SEEDOWN_SHIFT = 9;
  var ATTR_SEEDOWN_MASK = 0xF;
  var MAX_SEEDOWN_DEPTH = 10;  // descend at most 10 z

  var ATTR_ANIMFRAMES_MASK = 0xF;      // bits 0-3, pre-shift (shift 0)
  var ATTR_ANIMRATE_SHIFT = 4;
  var ATTR_ANIMRATE_MASK = 0x7;        // bits 4-6, pre-shift
  var ANIM_RATE_HZ = [2, 4, 8, 15, 2, 4, 8, 15];

  // Pack a frame count (1-16) plus a rate-table index (0-7) into the attr bits above.
  function encodeAnimAttr(frameCount, rateCode) {
    var fc = Math.max(1, Math.min(16, frameCount | 0));
    if (fc <= 1) return 0; // no animation -- rate bits are meaningless, don't set them either
    var rc = Math.max(0, Math.min(7, rateCode | 0));
    return (((fc - 1) & ATTR_ANIMFRAMES_MASK)) | ((rc & ATTR_ANIMRATE_MASK) << ATTR_ANIMRATE_SHIFT);
  }

  // Per-token default animation rate: a documented default, not an authored DF constant.
  function defaultAnimRateCodeForToken(token) {
    if (token && token.indexOf("CAMPFIRE") === 0) return 3; // 15 Hz
    return 1; // 4 Hz -- brook/river bed flow, magma glow, everything else with >1 frame
  }

  // Pure JS mirror of the shader's per-instance frame-select math, for documentation and tests
  // only -- the GLSL is the sole runtime authority and this is never called on the render path.
  function hashGridPhase(gx, gy) {
    var gxu = gx >>> 0, gyu = gy >>> 0;
    var h = (Math.imul(gxu, 374761393) + Math.imul(gyu, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h % 1009) / 1009;
  }
  function animFrameIndexForTest(timeMs, attr, gx, gy, globalEnabled) {
    var frameCount = (attr & ATTR_ANIMFRAMES_MASK) + 1;
    if (frameCount <= 1 || globalEnabled === false) return 0;
    var rateCode = (attr >> ATTR_ANIMRATE_SHIFT) & ATTR_ANIMRATE_MASK;
    var hz = ANIM_RATE_HZ[rateCode];
    var phase = hashGridPhase(gx, gy);
    var adv = (timeMs / 1000) * hz + phase * frameCount;
    var idx = Math.floor(adv) % frameCount;
    if (idx < 0) idx += frameCount;
    return idx;
  }

  // ---- colour tables ---------------------------------------------------------------
  var MAT_COLOR = {
    STONE: [130, 122, 110], SOIL: [120, 82, 48], MINERAL: [150, 130, 90],
    LAVA_STONE: [70, 60, 60], FROZEN_LIQUID: [170, 200, 230], CONSTRUCTION: [110, 110, 120],
    GRASS_LIGHT: [86, 140, 62], GRASS_DARK: [58, 104, 48], GRASS_DRY: [150, 150, 70],
    GRASS_DEAD: [110, 100, 70], PLANT: [70, 130, 70], TREE: [86, 66, 40], ROOT: [96, 74, 48],
    MUSHROOM: [150, 120, 130], DRIFTWOOD: [120, 100, 70], POOL: [60, 90, 150],
    BROOK: [70, 110, 170], RIVER: [55, 95, 165], ASHES: [90, 90, 90], MAGMA: [200, 70, 20],
    AIR: [24, 24, 28], NONE: [18, 18, 20],
  };
  var FALLBACK_MAT = [100, 100, 100];
  var BG = [14, 14, 16];
  var WALL_DARKEN = 0.45;
  var HIDDEN_COLOR = [49, 44, 52];  // native's measured field colour == hidden_rock.png cell
  var TINT_COLORS = { grassSummer: [93, 119, 52, 0.25] };

  function matRgb(mat) { return MAT_COLOR[mat] || FALLBACK_MAT; }
  function darken(rgb, f) { return [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)]; }
  // A ground-surface tree trunk or mushroom cap is TREE/MUSHROOM + shape WALL, so it is EXEMPT
  // from the stone wall-edge and wall-darken passes: emitTree draws its own trunk/cap cell.
  function isTreeWallMat(mat) { return mat === "TREE" || mat === "MUSHROOM"; }
  function derivedTreePart(t) {
    var shape = t.shape || "", mat = t.mat || "";
    if (shape === "TWIG") return "LEAVES";
    if (shape === "BRANCH") return "BRANCH";
    if (shape === "TRUNK_BRANCH") return "TRUNK";
    if (mat === "TREE") return (shape === "WALL") ? "TRUNK" : "CANOPY";
    if (mat === "MUSHROOM") return "TRUNK";
    return null;
  }
  var GRASS_BACK_OFFSETS = (function () {
    var out = [];
    for (var r = 1; r <= 1; r++) {
      var ring = [];
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
        }
      }
      ring.sort(function (a, b) { return (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])); });
      out.push.apply(out, ring);
    }
    return out;
  })();
  function isGrassBackingSource(n) {
    if (!n || n.hidden) return false;
    return n.mat === "GRASS_LIGHT" || n.mat === "GRASS_DARK";
  }
  function waterRgb(depth) {
    var d = Math.max(1, Math.min(7, depth));
    var b = 90 + d * 18;
    return [30, 60 + d * 6, Math.min(255, b + 60)];
  }
  function magmaRgb(depth) {
    var d = Math.max(1, Math.min(7, depth));
    return [Math.min(255, 150 + d * 14), Math.max(30, 90 - d * 8), 10];
  }

  // Stable per-tile hash for the grass and hidden variant pick (canvas2d twin: hashXY).
  function hashXY(x, y) { return ((x * 374761393 + y * 668265263) ^ (x >> 3)) >>> 0; }

  // ---- the hidden / undiscovered tile display law (canvas2d twin, VERBATIM) --------------
  var HIDDEN_SLOTS = 4;
  var HIDDEN_SCATTER_MAX = 8192;
  var hiddenScatter = {};            // "bx,by,z" -> [{bx,by,variant} x4]
  var hiddenScatterCount = 0;
  function hiddenScatterSeed(bx, by, bz) {
    var s = (Math.imul(bx | 0, 0x27d4eb2d) ^ Math.imul(by | 0, 0x165667b1) ^
             Math.imul(bz | 0, 0x9e3779b1)) >>> 0;
    return s === 0 ? 0x6d2b79f5 : s;
  }
  function hiddenScatterFor(bx, by, bz) {
    var key = bx + "," + by + "," + bz;
    var hit = hiddenScatter[key];
    if (hit) return hit;
    var s = hiddenScatterSeed(bx, by, bz);
    function next() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; }
    next(); next();
    var slots = new Array(HIDDEN_SLOTS);
    for (var i = 0; i < HIDDEN_SLOTS; i++) {
      var sx = next() >>> 28, sy = next() >>> 28;
      var v = Math.floor((next() / 4294967296) * 5);
      slots[i] = { bx: sx, by: sy, variant: v > 4 ? 4 : v };
    }
    if (hiddenScatterCount >= HIDDEN_SCATTER_MAX) { hiddenScatter = {}; hiddenScatterCount = 0; }
    hiddenScatter[key] = slots;
    hiddenScatterCount++;
    return slots;
  }
  function resetHiddenScatter() { hiddenScatter = {}; hiddenScatterCount = 0; }
  // First matching slot in index order wins; no match -> -1 = "write nothing".
  function hiddenVariantAt(wx, wy, wz) {
    if (typeof wx !== "number" || typeof wy !== "number") return -1;
    var slots = hiddenScatterFor(wx >> 4, wy >> 4, (typeof wz === "number" ? wz : 0) | 0);
    var lx = wx & 15, ly = wy & 15;
    for (var i = 0; i < HIDDEN_SLOTS; i++) {
      if (slots[i].bx === lx && slots[i].by === ly) return slots[i].variant;
    }
    return -1;
  }

  var DESIG_SHEET = "designations.png";
  var DESIG_CELL = {
    dig: [0, 1], channel: [0, 2], stairUp: [0, 3], stairDown: [0, 4],
    stairUpDown: [0, 5], ramp: [0, 6], removeConstruction: [0, 7], chop: [0, 8],
    gather: [0, 9], smooth: [0, 10], engrave: [0, 11], fortify: [0, 12],
    trafficLow: [0, 13], trafficHigh: [0, 14], trafficRes: [0, 15],
  };
  var MINING_SHEET = "mining_indicators.png";
  var MINING_CELL = { damp: [0, 0], warm: [1, 0] };
  // ---- tool-state overlay gate -----------------------------------------------------------
  var TOOL_STATE_OVERLAYS = { mining: false, traffic: false };
  function setToolStateOverlayGL(kind, on) {
    return window.DwfDesignationJob.setToolStateOverlay(TOOL_STATE_OVERLAYS, kind, on);
  }
  function toolStateOverlayVisibleGL(kind) {
    return window.DwfDesignationJob.toolStateOverlayVisible(TOOL_STATE_OVERLAYS, kind);
  }
  function setMineMode(on) { setToolStateOverlayGL("mining", on); }
  function miningIndicatorCell(t, on) {
    if (!on || !t || t.hidden) return null;
    if ((t.shape || "") !== "WALL") return null;
    if (t.damp) return MINING_CELL.damp;
    if (t.warm) return MINING_CELL.warm;
    return null;
  }

  // carve-track adjacency mask (N=1 S=2 E=4 W=8) -> designations.png col-1 cell.
  var DESIG_TRACK_CELL = {
    1: [1, 0], 2: [1, 1], 8: [1, 2], 4: [1, 3], 3: [1, 4], 9: [1, 5], 5: [1, 6],
    10: [1, 7], 6: [1, 8], 12: [1, 9], 11: [1, 10], 7: [1, 11], 13: [1, 12],
    14: [1, 13], 15: [1, 14],
  };
  // Automining has no key here on purpose: emitDesignationOverlay skips the wash for cat "automine"
  // and tints the glyph with AUTOMINE_SPRITE_TINT, so a key added here would never be read.
  var DESIG_TINT_RGB = {
    dig: [240, 150, 40],
    channel: [200, 105, 20], ramp: [240, 175, 60], stair: [240, 195, 75],
    chop: [215, 150, 45], gather: [120, 200, 90], smooth: [90, 150, 235], engrave: [80, 215, 225],
    traffic: [225, 205, 80], track: [185, 140, 90], fortify: [90, 150, 235],
    removeConstruction: [220, 110, 55],
  };
  var AUTOMINE_SPRITE_TINT = [0, 255, 0];
  var CHOP_PLANT_PART = { TRUNK: 1, BRANCH: 1, CANOPY: 1, LEAVES: 1, SAPLING: 1 };
  var DESIG_WASH_ALPHA = 0.28, DESIG_WASH_ALPHA_MARKER = 0.5;

  var MARKER_RECOLOR = [0.43, 0.68, 1.0];   // fitted native per-channel multiply (blue exact)
  var MARKER_GLYPH_TINT = [110, 173, 255];  // round(255*MARKER_RECOLOR): glyph texel*tint multiply
  var MARKER_WASH_RGB = [32, 50, 78];       // native measured marker-wash colour (flat cell)

  var DESIG_PRIORITY_SHEET = "designation_priority.png";
  var DESIG_ITEM_SHEET = "designation_item.png";
  var DESIG_ITEM_ROW = {
    DESIGNATION_ITEM_MELT: 0, DESIGNATION_ITEM_DUMP: 1, DESIGNATION_ITEM_FORBIDDEN: 2,
    DESIGNATION_ITEM_HIDDEN: 3, DESIGNATION_ITEM_FORBIDDEN_MELT: 4, DESIGNATION_ITEM_FORBIDDEN_DUMP: 5,
  };
  // iflags web=0x01 forbid=0x02 dump=0x04 melt=0x08 on_fire=0x10 -> DESIGNATION_ITEM_* token, or null.
  function itemMarkToken(iflags) {
    if (!iflags) return null;
    var forbid = iflags & 0x02, dump = iflags & 0x04, melt = iflags & 0x08;
    if (forbid && melt) return "DESIGNATION_ITEM_FORBIDDEN_MELT";
    if (forbid && dump) return "DESIGNATION_ITEM_FORBIDDEN_DUMP";
    if (forbid) return "DESIGNATION_ITEM_FORBIDDEN";
    if (melt) return "DESIGNATION_ITEM_MELT";
    if (dump) return "DESIGNATION_ITEM_DUMP";
    return null;
  }

  // dig == "Default" is disambiguated by the tile's own mat/shape, mirroring DF's own glyph pick.
  function resolveDesig(d, t) {
    if (!d) return null;
    var dig = d.dig;
    if (dig && dig !== "No") {
      switch (dig) {
        case "Channel": return { cell: DESIG_CELL.channel, cat: "channel" };
        case "Ramp": return { cell: DESIG_CELL.ramp, cat: "ramp" };
        case "UpStair": return { cell: DESIG_CELL.stairUp, cat: "stair" };
        case "DownStair": return { cell: DESIG_CELL.stairDown, cat: "stair" };
        case "UpDownStair": return { cell: DESIG_CELL.stairUpDown, cat: "stair" };
        default:
          var mat = t.mat || "", shape = t.shape || "";
          var plantPart = (t.plant && t.plant.part) || "";
          if (mat === "CONSTRUCTION")
            return { cell: DESIG_CELL.removeConstruction, cat: "removeConstruction" };
          if (mat === "TREE" || mat === "ROOT" || CHOP_PLANT_PART[plantPart] ||
            shape.indexOf("TRUNK") !== -1 || shape === "BRANCH" || shape === "TWIG" || shape === "SAPLING")
            return { cell: DESIG_CELL.chop, cat: "chop" };
          if (shape === "SHRUB" || mat === "PLANT" || plantPart === "SHRUB")
            return { cell: DESIG_CELL.gather, cat: "gather" };
          return { cell: DESIG_CELL.dig, cat: d.automine ? "automine" : "dig" };
      }
    }
    if (d.smooth === 2) return { cell: DESIG_CELL.engrave, cat: "engrave" };
    if (d.smooth === 1) return { cell: DESIG_CELL.smooth, cat: "smooth" };
    if (d.track) { var c = DESIG_TRACK_CELL[d.track & 15]; if (c) return { cell: c, cat: "track" }; }
    // Traffic 0 (Normal) has no sprite at all: Normal is the ABSENCE of a mark, never a cell.
    if (toolStateOverlayVisibleGL("traffic")) {
      if (d.traffic === 1) return { cell: DESIG_CELL.trafficLow, cat: "traffic" };
      if (d.traffic === 2) return { cell: DESIG_CELL.trafficHigh, cat: "traffic" };
      if (d.traffic === 3) return { cell: DESIG_CELL.trafficRes, cat: "traffic" };
    }
    return null;
  }

  function resolveDjobGL(k, t) {
    return window.DwfDesignationJob.resolve(k, t, DESIG_CELL, DESIG_TRACK_CELL);
  }

  // The instance tint field is 0-255 RGB, so only playerColor's "fill" variant is needed here.
  function playerColorRgb(name) {
    var h = 2166136261 >>> 0;
    var s = String(name || "");
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    // Signed-wrap the hue exactly as playerColor does, or a name whose FNV hash has the sign bit set
    // tints differently here than on its own cursor label.
    var hue = ((h % 360) + 360) % 360;
    return hslToRgb255(hue, 0.85, 0.58);
  }
  function hslToRgb255(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r1 = 0, g1 = 0, b1 = 0;
    if (hp < 1) { r1 = c; g1 = x; b1 = 0; }
    else if (hp < 2) { r1 = x; g1 = c; b1 = 0; }
    else if (hp < 3) { r1 = 0; g1 = c; b1 = x; }
    else if (hp < 4) { r1 = 0; g1 = x; b1 = c; }
    else if (hp < 5) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    var m = l - c / 2;
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
  }

  function getOwnPlayerName() {
    try {
      if (typeof location !== "undefined" && location.search) {
        var q = new URLSearchParams(location.search).get("player");
        if (q) return q;
      }
      if (typeof localStorage !== "undefined") return localStorage.getItem("dwf.player");
    } catch (_) { /* non-browser/sandboxed context */ }
    return null;
  }

  var PRESENCE_DRAG_MAX_TILES = 4096;
  function presenceBudget(players) {
    var list = players || [];
    var budget = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      budget += 1; // tile-outline marker
      if (p.drag && typeof p.dx === "number" && typeof p.dy === "number" &&
          typeof p.x === "number" && typeof p.y === "number") {
        var w = Math.abs(p.dx - p.x) + 1, h = Math.abs(p.dy - p.y) + 1;
        budget += Math.min(PRESENCE_DRAG_MAX_TILES, w * h);
      }
    }
    return budget;
  }

  // /sprites/map.json mis-binds GRASS_n to floors.png; the real cells are grass.png cols 0..3 row 0.
  var TOKEN_CELL_OVERRIDE = {
    GRASS_1: { sheet: "grass.png", col: 0, row: 0 },
    GRASS_2: { sheet: "grass.png", col: 1, row: 0 },
    GRASS_3: { sheet: "grass.png", col: 2, row: 0 },
    GRASS_4: { sheet: "grass.png", col: 3, row: 0 },
  };
  var GRASS_FLOOR_FALLBACK = { Shrub: 1, ShrubDead: 1, Sapling: 1, SaplingDead: 1 };
  function looksLikeGrassFloor(ttname) {
    return GRASS_FLOOR_FALLBACK[ttname] === 1 ||
      (ttname.indexOf("Grass") !== -1 && ttname.indexOf("Floor") !== -1);
  }

  function grassTierIndex(amount) {
    if (amount <= 33) return 0;
    if (amount <= 66) return 1;
    if (amount <= 99) return 2;
    return 3;
  }
  function grassSpriteSpec(colors, id) {
    var law = root.DwfGrassSelection;
    var spec = law && law.speciesSpec(colors, id);
    return spec ? { sheet: spec.sheet, row: spec.row,
      tintName: spec.sheet === "grass.png" ? "grassSummer" : null } : null;
  }
  function grassVariantIndex(ttname, gx, gy, plantOccupied) {
    var law = root.DwfGrassSelection;
    return law ? law.variantIndex(ttname, plantOccupied) : 0;
  }

  function grassSpeciesTintRGBA(colors, id, amount) {
    if (!colors || !colors.plants || !id) return null;
    var p = colors.plants[id];
    if (!p || !p.tiers) return null;
    var tier = p.tiers[grassTierIndex(amount)];
    if (!tier || !tier.rgb) return null;
    // The same 0.25 source-over wash as TINT_COLORS.grassSummer, not a hard recolour.
    return [tier.rgb[0], tier.rgb[1], tier.rgb[2], 0.25];
  }

  function isStairOrRamp(shape) {
    return shape === "STAIR_UP" || shape === "STAIR_DOWN" || shape === "STAIR_UPDOWN" ||
      shape === "RAMP" || shape === "RAMP_TOP";
  }

  // ---- sparse-layer tables (mirrored from dwf-tiles.js) ---------------------------

  // Stable small integer hash: position/material -> a repeatable 0..N-1 variant pick.
  function hashInt(a, b) {
    var h = (a | 0) * 2654435761 ^ (b | 0) * 2246822519;
    h = (h ^ (h >>> 15)) >>> 0;
    return h;
  }

  // ---- items ------------------------------------------------------------------------------
  var ITEM_MATVARIANT_BASE = {
    DOOR: "Door", BED: "Bed", TABLE: "Table", CHAIR: "Chair", CABINET: "Cabinet",
    BOX: "Box", HATCH_COVER: "HatchCover", GRATE: "Grate",
  };
  function matFamilyFor(mat_type) {
    if (mat_type === 3 || mat_type === 4 || mat_type === 5) return "GLASS";
    if (mat_type >= 419) return "WOOD";
    if (mat_type === 0) return "STONE";
    return null;
  }
  var ITEM_TINT_RGB_BY_FAMILY = { WOOD: [223, 212, 200], GLASS: [240, 248, 248] };
  function itemSpatterPlanGL(arr, map) {
    return root.DwfTerrainVariant.itemSpatterLitter(arr, map);
  }

  // ---- spatter ---------------------------------------------------------------
  var SPATTER_BUILTIN_FAMILY = { 9: "DUST", 12: "MUD", 13: "VOMIT" };
  // Native enters the spatter draw path for every positive amount.
  var SPATTER_VISIBLE_AMOUNT = 1;
  function spatterVisible(amount, threshold) {
    var min = threshold === undefined ? SPATTER_VISIBLE_AMOUNT : threshold;
    return Number.isFinite(amount) && amount >= min;
  }
  function firstVisibleSpatter(arr) {
    if (!arr) return null;
    for (var i = 0; i < arr.length && i < 4; i++) {
      if (arr[i] && spatterVisible(arr[i].amount)) return arr[i];
    }
    return null;
  }
  function bloodFamilyFromRgb(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return null;
    var r = rgb[0], g = rgb[1], b = rgb[2];
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 36) return "BLOOD_GOO";
    if (r > g + 30 && b > g + 30) return "BLOOD_MAGENTA";
    if (b >= r && b >= g) return "BLOOD_CYAN";
    if (r >= g && r >= b) {
      if (g >= r * 0.6 && b < g) return "BLOOD_ICHOR";
      return "BLOOD_RED";
    }
    return "BLOOD_ICHOR";
  }
  function spatterFamilyForCtx(spatterMap, sp) {
    var TV = root.DwfTerrainVariant;
    if (TV && typeof TV.spatterFamily === "function") return TV.spatterFamily(spatterMap, sp);
    if (!spatterMap || !sp) return null;
    var mt = sp.mat_type;
    if (mt === 6) return (sp.state === 3) ? "SNOW" : "WATER_SPATTER";
    var hint = SPATTER_BUILTIN_FAMILY[mt];
    if (hint) return hint;
    if (mt >= 19 && mt < 419) {
      var byRgb = bloodFamilyFromRgb(sp.rgb);
      if (byRgb) return byRgb;
      var blood = spatterMap.blood_families;
      if (Array.isArray(blood) && blood.length) return blood[hashInt(mt, sp.mat_index) % blood.length];
    }
    return "MUD";
  }
  function spatterShapeForCtx(spatterMap, amount) {
    var TV = root.DwfTerrainVariant;
    if (TV && typeof TV.spatterShape === "function") return TV.spatterShape(spatterMap, amount);
    var thr = (spatterMap && spatterMap.amount_thresholds_default) || [];
    for (var i = 0; i < thr.length; i++) {
      var th = thr[i];
      if (th.max === null || amount <= th.max) return th.shape;
    }
    return "FULL";
  }
  // Native's 36x16 region is shape x FAMILY, not shape x amount.
  function spatterOracleCellForCtx(map, family, kind, familyLevel) {
    if (!map || !Array.isArray(map.oracle_kind_cells)) return null;
    if (!Number.isInteger(kind) || kind < 1 || kind > map.oracle_kind_cells.length) return null;
    var levels = map.oracle_family_levels;
    if (!Number.isInteger(familyLevel) || !Array.isArray(levels) ||
        familyLevel < 0 || familyLevel >= levels.length) return null;
    var famDef = map.families && map.families[levels[familyLevel] || family];
    var key = map.oracle_kind_cells[kind - 1];
    var c = famDef && famDef.cells && famDef.cells[key];
    return c ? { sheet: famDef.sheet, col: c.col, row: c.row, key: key } : null;
  }
  function spatterCellForKeyCtx(map, family, key) {
    var famDef = map && map.families && map.families[family];
    var c = famDef && famDef.cells && famDef.cells[key];
    return c ? { sheet: famDef.sheet, col: c.col, row: c.row, key: key } : null;
  }
  function partialVariantKey(band, gx, gy, gz, salt) {
    var TV = root.DwfTerrainVariant;
    if (TV && typeof TV.spatterPartialKey === "function")
      return TV.spatterPartialKey(band, gx, gy, gz || 0, salt || 0);
    var m = /^PARTIAL_([A-D])$/.exec(band || "");
    if (!m) return null;
    return "PARTIAL_" + (1 + hashInt(gx, gy) % 4) + m[1];
  }

  // ---- tree geometry ------------------------------------------------------------------------
  var TREE_FLAT_FALLBACK = {
    TREE_TRUNK: "TRUNK", TREE_TRUNK_THICK: "TRUNK", TREE_TRUNK_PILLAR: "TRUNK", TREE_BASE: "TRUNK",
    TREE_BRANCH: "BRANCH", TREE_HEAVY_BRANCH: "BRANCH",
    TREE_CAP: "CANOPY",
    TREE_TWIGS: "LEAVES", TREE_LEAFLESS_TWIGS: "LEAVES",
  };
  var TREE_DIR_ORDER = "NSWE";
  function canonicalDirs(letters) {
    var out = "";
    for (var i = 0; i < TREE_DIR_ORDER.length; i++) {
      if (letters.indexOf(TREE_DIR_ORDER[i]) !== -1) out += TREE_DIR_ORDER[i];
    }
    return out;
  }
  // ttname (minus "Tree"/"Dead") -> {family, variant, altFamily?, adjacency?} | {skip:true} | null
  function parseTreeTtname(ttname) {
    if (!ttname || ttname.indexOf("Tree") !== 0) return null;
    var dead = ttname.indexOf("Dead") !== -1;
    var rest = ttname.slice(4);
    if (dead) rest = rest.replace("Dead", "");
    var m;
    if (rest === "TrunkInterior") return { family: "TREE_TRUNK_THICK", variant: "INTERIOR", dead: dead };
    if (rest === "CapInterior") return { family: "TREE_CAP", variant: "THICK_INTERIOR", dead: dead };
    if (rest === "TrunkPillar") return { family: "TREE_TRUNK_PILLAR", variant: "_", dead: dead };
    if (rest === "TrunkSloping") return { family: "TREE_TRUNK", variant: "SLOPE_TOP", dead: dead };
    if (rest === "RootSloping" || rest === "Roots") return { family: "TREE_BASE", variant: "TRUNK", dead: dead };
    if (rest === "CapRamp") return { skip: true };
    if (rest === "Twigs") {
      return { family: dead ? "TREE_LEAFLESS_TWIGS" : "TREE_TWIGS", variant: null, dead: dead, adjacency: true };
    }
    if (rest === "Branches" || rest === "BranchesSmooth") {
      return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: "NSWE", dead: dead };
    }
    if (rest === "Branch") return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: "_", dead: dead };
    if (rest === "CapPillar") return { family: "TREE_CAP", variant: "PILLAR", dead: dead };
    if ((m = /^CapPillar[NSEW]{1,4}$/.exec(rest))) return { family: "TREE_CAP", variant: "PILLAR", dead: dead };
    if ((m = /^TrunkBranch([NSEW])$/.exec(rest))) return { family: "TREE_BASE", variant: "TRUNK_" + m[1], dead: dead };
    if ((m = /^TrunkThick([NSEW]{1,2})$/.exec(rest))) return { family: "TREE_TRUNK_THICK", variant: canonicalDirs(m[1]), dead: dead };
    if ((m = /^CapWallThick([NSEW]{1,2})$/.exec(rest))) return { family: "TREE_CAP", variant: "WALL_THICK_" + canonicalDirs(m[1]), dead: dead };
    // Plain CAP_WALL raw tokens join their direction letters with underscores (TREE_CAP_WALL_N_S_W_E).
    if ((m = /^CapWall([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_CAP", variant: "WALL_" + canonicalDirs(m[1]).split("").join("_"), dead: dead };
    if ((m = /^CapFloor([1-4])$/.exec(rest))) return { family: "TREE_CAP", variant: "FLOOR_" + m[1], dead: dead };
    if ((m = /^Trunk([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_TRUNK", variant: canonicalDirs(m[1]), dead: dead };
    if ((m = /^Branch([NSEW]{1,4})$/.exec(rest))) return { family: "TREE_BRANCH", altFamily: "TREE_HEAVY_BRANCH", variant: canonicalDirs(m[1]), dead: dead };
    return null;
  }
  // TREE_OVERLEAVES overlay resolution, sharing canvas2d's resolveOverleaves shape. Consumed by emitTree.
  var OVERLEAVES_PREFIX = {
    TREE_TRUNK: "TRUNK_",
    TREE_BRANCH: "HEAVY_BRANCH_",
    TREE_HEAVY_BRANCH: "HEAVY_BRANCH_",
  };
  function resolveOverleavesGL(treeMap, sel, id) {
    if (!sel || sel.dead || !treeMap) return null;
    var prefix = OVERLEAVES_PREFIX[sel.family];
    if (!prefix || !sel.variant || sel.variant === "_" || !/^[NSWE]+$/.test(sel.variant)) return null;
    var key = prefix + sel.variant;
    var sp = (id && treeMap[id]) || null;
    var own = sp && sp.TREE_OVERLEAVES && sp.TREE_OVERLEAVES[key];
    if (own) return own;
    var dflt = treeMap._default && treeMap._default.TREE_OVERLEAVES;
    return (dflt && dflt[key]) || null;
  }
  // Canopy-twig connectivity predicate (same shared 8-neighbor primitive drawWallJoin uses).
  function isCanopyNeighbor(nt) {
    if (!nt || nt.hidden) return false;
    var shape = nt.shape || "";
    if (shape !== "TWIG" && shape !== "BRANCH") return false;
    var mat = nt.mat || "";
    return mat === "TREE" || mat === "MUSHROOM";
  }

  function isOpenTileShapeMat(shape, mat) {
    return shape === "EMPTY" || shape === "NONE" || shape === "RAMP_TOP" || mat === "AIR";
  }

  function cacheHasMultiZ(cacheReader, z, wx, wy) {
    if (!cacheReader || typeof cacheReader.getChunk !== "function" ||
      typeof cacheReader.chunkKeyFor !== "function") return false;
    var chunk = null;
    try { chunk = cacheReader.getChunk(z, cacheReader.chunkKeyFor(wx, wy)); } catch (_) { chunk = null; }
    return !!(chunk && chunk.baked === false);
  }

  function wallPrefix(mat, base_mt) {
    if (mat === "SOIL") return "SOIL_WALL";
    if (mat === "FROZEN_LIQUID") return "ICE_WALL";
    if (mat === "LAVA_STONE" || mat === "MAGMA") return "MAGMA_WALL";
    // No `mat === "MINERAL" -> ORE_VEIN_WALL` fallback: roughInorganicWallPrefixGL already claims the
    // genuinely ore-bearing walls (wall_family 10), so anything reaching this line stays rough stone.
    if (mat === "CONSTRUCTION") return (typeof base_mt === "number" && base_mt >= 419) ? "WOODEN_WALL" : "ROCK_BLOCKS_WALL";
    return "STONE_WALL";
  }
  var WALL_ART_PARITY = Object.freeze({
    family: "exact", cellBase: "exact", variant: "approximate",
    variantReason: "native-global-rng-is-not-on-the-wire",
  });
  // There is no worn-ice art, so a WORN ice wall deliberately degrades to SMOOTHED_ICE_WALL.
  function wallDetailPrefix(t) {
    var nm = (t && t.ttname) || "";
    var isIce = ((t && t.mat) || "") === "FROZEN_LIQUID";
    if (/WallSmooth/.test(nm)) return isIce ? "SMOOTHED_ICE_WALL" : "SMOOTHED_STONE_WALL";
    var worn = /WallWorn([123])$/.exec(nm);
    if (worn) return isIce ? "SMOOTHED_ICE_WALL" : ("WORN" + worn[1] + "_STONE_WALL");
    return null;
  }

  // liquidCellFor: liquids.png depth cell (col 0 water / col 1 magma, row = 7 - depth).
  function liquidCellFor(liquid, flow) {
    if (liquid !== "water" && liquid !== "magma") return null;
    var d = Math.max(1, Math.min(7, flow || 0));
    return { sheet: "liquids.png", col: (liquid === "magma") ? 1 : 0, row: 7 - d };
  }

  function liquidEdgeTokens(t, gx, gy, lookupTile, Adj) {
    if (!Adj || !lookupTile) return [];
    var flow = t && (t.flow || 0), liquid = t && (t.liquid || "none");
    if (flow <= 0 || (liquid !== "water" && liquid !== "magma")) return [];
    var mask8 = Adj.computeMask8(lookupTile, gx, gy, function (nt) {
      if (!nt) return true;
      var nFlow = nt.flow || 0, nLiquid = nt.liquid || "none";
      return !(nFlow > 0 && (nLiquid === "water" || nLiquid === "magma"));
    });
    if (!mask8) return [];
    var prefix = (liquid === "magma") ? "UNDERMAGMA_EDGE_" : "UNDERWATER_EDGE_";
    var out = [];
    for (var i = 0; i < Adj.DIR_NAMES.length && out.length < 4; i++) {
      var name = Adj.DIR_NAMES[i];
      if (mask8 & Adj.BIT[name]) out.push(prefix + name);
    }
    return out;
  }

  // ---- buildings ------------------------------------------------------------------
  var WORKSHOP_SUBTYPE = [
    "Carpenters", "Farmers", "Masons", "Craftsdwarfs", "Jewelers", "MetalsmithsForge",
    "MagmaForge", "Bowyers", "Mechanics", "Siege", "Butchers", "Leatherworks", "Tanners",
    "Clothiers", "Fishery", "Still", "Loom", "Quern", "Kennels", "Kitchen", "Ashery",
    "Dyers", "Millstone", "Custom", "Tool",
  ];
  var FURNACE_SUBTYPE = [
    "WoodFurnace", "Smelter", "GlassFurnace", "Kiln", "MagmaSmelter",
    "MagmaGlassFurnace", "MagmaKiln", "Custom",
  ];
  var MISSING_BUILDING = { sheet: "defaults.png", col: 0, row: 1 };
  function isOverlayOnlyBuildingType(type) { return type === "Stockpile" || type === "Civzone"; }

  // Buildings must paint BACK-TO-FRONT (ascending y1) or a nearer building's authored overhang
  // ends up UNDER the one behind it.
  function buildingsInPaintOrder(list) {
    if (!Array.isArray(list) || list.length < 2) return Array.isArray(list) ? list.slice() : [];
    return list.map(function (building, index) { return { building: building, index: index }; })
      .sort(function (a, b) {
        var ay = a.building && Number.isFinite(a.building.y1) ? a.building.y1 : -2147483648;
        var by = b.building && Number.isFinite(b.building.y1) ? b.building.y1 : -2147483648;
        return (ay - by) || (a.index - b.index);
      }).map(function (entry) { return entry.building; });
  }

  function pickBuildingPalRow(b, map) {
    if (!b || typeof b.cpal !== "string" || !map || !map.palette) return null;
    var r = map.palette.byname && map.palette.byname[b.cpal];
    return typeof r === "number" && map.palette.rows && map.palette.rows[r] ? r : null;
  }
  var FOG_ALPHA_INTERCEPT = 0.2464;
  var FOG_ALPHA_RATE = 0.1057;
  var FOG_DISABLED = false;
  function fogAlphaForDepth(depth) {
    if (FOG_DISABLED) return 0;
    var d = (typeof depth === "number") ? depth : 0;
    if (d <= 0) return 0;
    return Math.max(0, Math.min(1, FOG_ALPHA_INTERCEPT + FOG_ALPHA_RATE * d));
  }
  function belowAlpha(d) { return Math.max(0, 1 - fogAlphaForDepth(d)); }

  // ---- units ---------------------------------------------------------------------------

  // Fallback dot tint: a flat SOLID_CELL instance approximating canvas2d's filled circle.
  var UNIT_FALLBACK_RGB = [240, 220, 60];
  // Spectral-green multiply plus DF's ghost translucency; shared with canvas2d's GHOST_TINT_RGB.
  var GHOST_TINT_RGB = [120, 235, 150];
  var GHOST_ALPHA = 163 / 255;
  var UNIT_STATUS_BLINK_MS = 800;
  var MACHINE_ANIM_MS = 500;
  var USTAT_SLEEPING = 0x01;
  var USTAT_UNCONSCIOUS = 0x02;
  var USTAT_NAUSEA = 0x00000800;
  var USTAT_PARALYZED = 0x00002000;

  var UnitStatusLaw = root.DwfUnitStatus;
  var unitStatusIconForBitsLaw = UnitStatusLaw && UnitStatusLaw.unitStatusIconForBits;
  var nativeBubblePhaseLaw = UnitStatusLaw && UnitStatusLaw.nativeBubblePhase;
  var physicalStatusIconForBitsLaw = UnitStatusLaw && UnitStatusLaw.physicalStatusIconForBits;
  var ordinaryStatusIconForBitsLaw = UnitStatusLaw && UnitStatusLaw.ordinaryStatusIconForBits;
  var unitStatusIconNowLaw = UnitStatusLaw && UnitStatusLaw.unitStatusIconNow;
  var NATIVE_BUBBLE_PERIOD_MS = UnitStatusLaw && UnitStatusLaw.NATIVE_BUBBLE_PERIOD_MS;
  var NATIVE_BUBBLE_ID_STRIDE = UnitStatusLaw && UnitStatusLaw.NATIVE_BUBBLE_ID_STRIDE;
  var NATIVE_BUBBLE_ORDINARY_MS = UnitStatusLaw && UnitStatusLaw.NATIVE_BUBBLE_ORDINARY_MS;
  function unitStatusIconForBitsGL(st, st2) { return unitStatusIconForBitsLaw(st, st2); }
  function nativeBubblePhaseGL(unitId, nowMs) { return nativeBubblePhaseLaw(unitId, nowMs); }
  function physicalStatusIconForBitsGL(st) { return physicalStatusIconForBitsLaw(st); }
  function ordinaryStatusIconForBitsGL(st, st2) { return ordinaryStatusIconForBitsLaw(st, st2); }
  function unitStatusIconNowGL(st, st2, unitId, nowMs) {
    return unitStatusIconNowLaw(st, st2, unitId, nowMs);
  }
  var unitStatusIconForBits = unitStatusIconForBitsGL;
  var nativeBubblePhase = nativeBubblePhaseGL;
  var physicalStatusIconForBits = physicalStatusIconForBitsGL;
  var ordinaryStatusIconForBits = ordinaryStatusIconForBitsGL;
  var unitStatusIconNow = unitStatusIconNowGL;
  // ---- the overhead map flash --------------------------------------------------------------
  var FLASH_CYAN_RGB = [20, 255, 233];
  function unitMapFlash(st, nowMs) {
    st = st | 0;
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    var period = 0, onWindow = 0, rgb = null;
    if ((st & USTAT_SLEEPING) && (st & USTAT_UNCONSCIOUS)) { period = 1000; onWindow = 500; }
    else if (st & USTAT_UNCONSCIOUS) { period = 500; onWindow = 100; }
    else if (st & USTAT_PARALYZED) { period = 500; onWindow = 100; rgb = FLASH_CYAN_RGB; }
    else if (st & USTAT_NAUSEA) { period = 500; onWindow = 100; }
    else return null;
    var t = Math.floor(nowMs) % period;
    if (t < 0) t += period;
    return { on: t < onWindow, rgb: rgb };
  }

  // The 800ms on/off beat. It does NOT gate overhead status bubbles -- those follow the native
  // per-unit phase cadence; this drives designation-job blinking and flow-cloud breathing only.
  function unitStatusBlinkVisible(nowMs) {
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    return (Math.floor(nowMs / UNIT_STATUS_BLINK_MS) % 2) === 0;
  }
  var DESIG_ACTIVE_BLINK_MS = UNIT_STATUS_BLINK_MS / 2;
  function isBlinkingDesignationJob(djobKind) {
    return djobKind >= 1 && djobKind <= 13;
  }
  function activeBlinkVisible(nowMs) {
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    return (Math.floor(nowMs / DESIG_ACTIVE_BLINK_MS) % 2) === 0;
  }
  function designationBlinkState(djobKind, hasWorker, unitOnTile) {
    if (!isBlinkingDesignationJob(djobKind) || !hasWorker) return 0;
    return unitOnTile ? 2 : 1;
  }
  function designationGlyphVisible(djobKind, nowMs, hasWorker, unitOnTile) {
    var s = designationBlinkState(djobKind, hasWorker, unitOnTile);
    if (s === 2) return activeBlinkVisible(nowMs);
    if (s === 1) return unitStatusBlinkVisible(nowMs);
    return true;
  }
  function workedTileUnitVisible(nowMs) {
    return !activeBlinkVisible(nowMs);
  }
  function hasBlinkingDesignationJob(djobs) {
    if (!Array.isArray(djobs)) return false;
    for (var i = 0; i < djobs.length; i++)
      if (djobs[i] && djobs[i].w && isBlinkingDesignationJob(djobs[i].k)) return true;
    return false;
  }
  var FLOW_STYLES_GL = {
    0: { token: "FLOW_MIASMA", rgb: [150, 64, 176] },   // Miasma: native EVENT_FLOWS art
  };
  function flowOverlayForGL(cloud, nowMs) {
    if (!cloud || typeof cloud.type !== "number") return null;
    var style = FLOW_STYLES_GL[cloud.type];
    var d = typeof cloud.density === "number" ? cloud.density : 0;
    if (!style || d <= 0) return null;
    var a = 0.2 + 0.55 * Math.min(1, d / 64);   // fallback-haze alpha (unchanged)
    var sa = 0.9;                                // authored-sprite alpha: strong, not faint
    if (!unitStatusBlinkVisible(nowMs)) { a *= 0.78; sa *= 0.85; }
    return { token: style.token || null, rgb: style.rgb, alpha: a, spriteAlpha: sa };
  }
  function markDesignationJobBlink(list, gx, gy, dj, unitOnTile) {
    if (!isBlinkingDesignationJob(dj.k)) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i].gx === gx && list[i].gy === gy) {
        list[i].djobKind = dj.k; list[i].djobWorker = !!dj.w; list[i].djobActive = !!unitOnTile;
        return;
      }
    }
  }
  function unitTileSet(view) {
    var us = (view && view.units) || null;
    if (!us || !us.length) return null;
    var set = new Set();
    for (var i = 0; i < us.length; i++) {
      var u = us[i];
      if (u && typeof u.x === "number" && typeof u.y === "number") set.add(u.x + "|" + u.y + "|" + u.z);
    }
    return set.size ? set : null;
  }
  function machineAnimPhase(nowMs) {
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now();
    return Math.floor(nowMs / MACHINE_ANIM_MS);
  }
  function machineFrameParityGL(nowMs, freezeAnim) {
    return freezeAnim ? 0 : (machineAnimPhase(nowMs) % 2);
  }
  var MACHINE_TYPES_GL = { ScrewPump: 1, WaterWheel: 1, Windmill: 1, AxleHorizontal: 1, AxleVertical: 1, GearAssembly: 1, Rollers: 1 };
  function hasDrawableMachineGL(buildings) {
    if (!Array.isArray(buildings)) return false;
    for (var i = 0; i < buildings.length; i++) {
      var b = buildings[i];
      if (b && MACHINE_TYPES_GL[b.type] && (typeof b.bst === "number") && (b.bst & 1)) return true;
    }
    return false;
  }
  function machineCadenceStepGL(buildings, nowMs, lastPhase, freezeAnim) {
    if (freezeAnim || !hasDrawableMachineGL(buildings)) return { phase: -1, dirty: false };
    var phase = machineAnimPhase(nowMs);
    return { phase: phase, dirty: phase !== lastPhase };
  }

  function buildingRebuildViewGL(sceneView, latestView) {
    if (!sceneView || !sceneView.origin || !latestView || !latestView.origin ||
        sceneView.origin.z !== latestView.origin.z) return latestView;
    return Object.assign({}, sceneView, {
      buildings: Array.isArray(latestView.buildings) ? latestView.buildings : [],
      freezeAnim: latestView.freezeAnim,
      machineParity: latestView.machineParity,
    });
  }

  function resolveUnitTierGL(u, races, atlas) {
    if (!u || !atlas) return { tier: 5 };
    if (u.ah && typeof u.sw === "number" && typeof u.sh === "number") {
      var ready1 = atlas.registerDynamicSheet(u.ah, "/unit-sprite/" + u.ah + ".png");
      if (ready1) return { tier: 1 };
      // tier 2 (fetch in flight, or evicted forever on a 404): fall through, the fetch is already away.
    }
    var rec = races && u.rt && races[u.rt];
    if (rec && rec.sheet && typeof rec.col === "number") return { tier: 3, rec: rec };
    if (rec && (rec.layered || rec.baked)) {
      var bname = (u.ct === "FEMALE") ? "dwarf_female.png" : (rec.baked || "dwarf.png");
      var ready4 = atlas.registerDynamicSheet(bname, "/" + bname);
      if (ready4) return { tier: 4, key: bname };
      return { tier: 5 }; // in-flight/failed: dot until it resolves, same as tier 1's fallthrough
    }
    return { tier: 5 };
  }

  var UNIT_LERP_MS = 66;  // ~2x the AUX stream's metronome: absorbs jitter without visibly lagging the true position
  function createUnitInterpolator(opts) {
    opts = opts || {};
    var lerpMs = (typeof opts.lerpMs === "number") ? opts.lerpMs : UNIT_LERP_MS;
    var smooth = !!opts.smooth;  // default OFF -- native motion
    var tracks = new Map(); // unit id -> {fromX,fromY,toX,toY,tStart,raw}

    function currentXY(tr, nowMs) {
      if (!smooth || lerpMs <= 0) return { x: tr.toX, y: tr.toY };
      var a = (nowMs - tr.tStart) / lerpMs;
      if (a < 0) a = 0; else if (a > 1) a = 1;
      return { x: tr.fromX + (tr.toX - tr.fromX) * a, y: tr.fromY + (tr.toY - tr.fromY) * a };
    }

    // A unit id missing from `units` is dropped immediately: no lingering ghost, no fade-out.
    function ingest(units, nowMs) {
      var seen = new Map();
      var list = units || [];
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        if (!u || typeof u.id === "undefined" || typeof u.x !== "number" || typeof u.y !== "number") continue;
        seen.set(u.id, true);
        var tr = tracks.get(u.id);
        if (!tr) {
          tracks.set(u.id, { fromX: u.x, fromY: u.y, toX: u.x, toY: u.y, tStart: nowMs, raw: u });
          continue;
        }
        var cur = currentXY(tr, nowMs);
        tr.fromX = cur.x; tr.fromY = cur.y;
        tr.toX = u.x; tr.toY = u.y;
        tr.tStart = nowMs;
        tr.raw = u; // z/rt/ct/ah/sw/sh/ax/ay always reflect the newest wire state (never lerped)
      }
      var stale = [];
      tracks.forEach(function (_tr, id) { if (!seen.has(id)) stale.push(id); });
      for (var s = 0; s < stale.length; s++) tracks.delete(stale[s]);
    }

    // Interpolated {x,y} plus every non-interpolated field from the unit's most recent raw record.
    function tick(nowMs) {
      var out = [];
      tracks.forEach(function (tr) {
        var cur = currentXY(tr, nowMs);
        var u = tr.raw;
        out.push({
          id: u.id, x: cur.x, y: cur.y, z: u.z, rt: u.rt, ct: u.ct,
          ah: u.ah, sw: u.sw, sh: u.sh, ax: u.ax, ay: u.ay,
          sd: u.sd, st: u.st, st2: u.st2,
        });
      });
      return out;
    }

    return {
      ingest: ingest, tick: tick, size: function () { return tracks.size; },
      setSmooth: function (on) { smooth = !!on; },
      isSmooth: function () { return smooth; },
    };
  }

  // ---- SCENE-BUILD CORE (pure -- no DOM, no GL) -----------------------------------------------
  // Instance order IS painter's order: a blit becomes a sprite instance, a fillRect a SOLID_CELL one.

  // Holds the growable instance buffer and its typed-array views; reused across rebuilds.
  function createSceneBuilder(ctx) {
    ctx = ctx || {};
    var atlas = ctx.atlas || null;
    var spriteMap = ctx.spriteMap || null;
    var tokenMap = ctx.tokenMap || null;
    var shadowCellMap = ctx.shadowCellMap || null;
    var Adj = ctx.adjacency || (typeof root.DwfAdjacency !== "undefined" ? root.DwfAdjacency : null);
    var cacheReader = ctx.cacheReader || null;
    var tiletypeMeta = ctx.tiletypeMeta || null;
    var itemMap = ctx.itemMap || null;
    function applySheetGeometryFromItemMap() {
      if (atlas && itemMap && itemMap.sheet_geometry && typeof atlas.setSheetGeometry === "function") {
        atlas.setSheetGeometry(itemMap.sheet_geometry);
      }
    }
    applySheetGeometryFromItemMap();
    var plantMap = ctx.plantMap || null;
    var treeMap = ctx.treeMap || null;
    var spatterMap = ctx.spatterMap || null;
    var buildingMap = ctx.buildingMap || null;
    var creaturesMap = ctx.creaturesMap || null;
    var grassColors = ctx.grassColors || null;
    var materialMap = ctx.materialMap || null;
    var itemDefTokens = ctx.itemDefTokens || null;
    var itemTypeNames = ctx.itemTypeNames || null;
    var paletteLookup = null;
    function buildPaletteLookup() {
      paletteLookup = null;
      matInorganicByIdGL = null;  // id-join cache follows the materialMap instance
      var def = materialMap && (materialMap.default_row ||
        (materialMap.palette && materialMap.palette.rows && materialMap.palette.rows[0]));
      if (!def || !def.length) return;
      var m = new Map();
      for (var k = 0; k < def.length; k++) {
        var c = def[k];
        var key = c && c.length >= 3
          ? (((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255)) : null;
        if (key !== null && !m.has(key)) m.set(key, k);
      }
      paletteLookup = m;
    }
    buildPaletteLookup();
    // Returns a remap(cellData,w,h) that rewrites default-palette pixels to palette row `palRow` in place.
    function paletteRemapFor(palRow) {
      var rows = materialMap && materialMap.palette && materialMap.palette.rows;
      var target = rows && rows[palRow];
      if (!paletteLookup || !target || !target.length) return null;
      var look = paletteLookup;
      // DwfGemVariant.remapPalette is the canonical substitution; index.html loads it before this
      // file, so the local loop below runs only in harnesses that omit dwf-gem-variant.js.
      var GVp = (typeof window !== "undefined") && window.DwfGemVariant;
      if (GVp) return function (d) { GVp.remapPalette(d, look, target); };
      return function (d) {
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          var k = look.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
          if (k !== undefined) { var t = target[k]; if (t) { d[i] = t[0]; d[i + 1] = t[1]; d[i + 2] = t[2]; } }
        }
      };
    }

    // Which of native's four generated arrangements a small cut gem wears, or undefined if it is none.
    function gemVariantForItemGL(it, vis, gx, gy) {
      var GV = (typeof window !== "undefined") && window.DwfGemVariant;
      if (!GV || !it || it.type !== "SMALLGEM") return undefined;
      if (!vis || !vis.entry || vis.entry.sheet !== "smallgems.png") return undefined;
      return GV.variantIndex(GV.seedFromTile(gx, gy, 0));
    }
    // The stamp geometry and the palette substitution both come from the shared module: no art here.
    function gemCompositeCell(entry, palRow, variant) {
      var GV = (typeof window !== "undefined") && window.DwfGemVariant;
      if (!GV || !atlas || !atlas.resolveComposite) return -1;
      var remap = (typeof palRow === "number") ? paletteRemapFor(palRow) : null;
      return atlas.resolveComposite(entry.sheet, entry.col, entry.row,
        "gem" + variant + ":" + (typeof palRow === "number" ? palRow : "raw"),
        function (dst, dw, dh, src, sw, sh) {
          GV.composite(dst, dw, dh, src, sw, sh, variant);
          if (remap) remap(dst, dw, dh);
        });
    }

    var cap = 0;               // instance capacity
    var buf = null, f32 = null, u16 = null, u8 = null;
    var k = 0;                 // current instance write cursor
    // Instance coordinates are world anchored. Emitters keep their grid-relative maths, and this one
    // translation at the write boundary keeps i_grid stable across pans.
    var emitOriginX = 0, emitOriginY = 0;

    function ensureCapacity(n) {
      if (n <= cap) return;
      var newCap = Math.max(n, (cap * 2) | 0, 4096);
      var newBuf = new ArrayBuffer(newCap * INSTANCE_BYTES);
      if (buf) new Uint8Array(newBuf).set(new Uint8Array(buf, 0, Math.min(buf.byteLength, newBuf.byteLength)));
      buf = newBuf; cap = newCap;
      f32 = new Float32Array(buf);
      u16 = new Uint16Array(buf);
      u8 = new Uint8Array(buf);
    }

    function emit(x, y, cell, r, g, b, a, attr) {
      if (k >= cap) return; // capacity clamp (never overflow the buffer)
      // A resolved atlas index is not proof its source cell paints a pixel, so blank sprite instances
      // are dropped centrally. An animated run counts as visible when any authored frame has alpha.
      if (cell !== SOLID_CELL && atlas && atlas.isCellVisible) {
        var visibleFrames = (((attr || 0) & ATTR_ANIMFRAMES_MASK) + 1);
        if (!(cell > 0) || !atlas.isCellVisible(cell, visibleFrames)) return;
      }
      var fo = k * 4;
      f32[fo] = x + emitOriginX; f32[fo + 1] = y + emitOriginY;
      var so = k * 8;
      u16[so + 4] = cell; u16[so + 5] = attr || 0;
      var bo = k * INSTANCE_BYTES;
      u8[bo + 12] = r; u8[bo + 13] = g; u8[bo + 14] = b; u8[bo + 15] = a;
      k++;
    }
    function emitSolid(x, y, rgb, alpha255, attr) { emit(x, y, SOLID_CELL, rgb[0], rgb[1], rgb[2], alpha255, attr); }
    function emitSprite(x, y, cell, attr) { emit(x, y, cell, 255, 255, 255, 255, attr || 0); }

    // token -> loaded atlas cell (>0), or 0 when the token has no sheet or the sheet is not packed yet.
    function tokenCell(token) {
      var entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
      if (!entry || !entry.sheet || !atlas) return 0;
      var c = (entry.frames && entry.frames.length > 1 && atlas.resolveAnimated)
        ? atlas.resolveAnimated(token, entry.sheet, entry.frames)
        : atlas.resolve(entry.sheet, entry.col, entry.row);
      if (c > 0 && atlas.isCellVisible &&
          !atlas.isCellVisible(c, entry.frames && entry.frames.length > 1 ? entry.frames.length : 1)) return 0;
      return (c > 0) ? c : 0;
    }

    function boulderVariantGL(t, gx, gy, palRow) {
      var entry = spriteMap && spriteMap.BOULDER;
      if (!entry || entry.sheet !== "terrain_boulders.png" || entry.col !== 0 || entry.row !== 0 || !atlas) return 0;
      var wx = (t && typeof t.x === "number") ? t.x : gx;
      var wy = (t && typeof t.y === "number") ? t.y : gy;
      var h = hashXY(wx, wy);
      var col = h & 3, row = (h >> 2) & 1, c = 0;
      if (typeof palRow === "number" && atlas.resolvePalette) {
        var remap = paletteRemapFor(palRow);
        if (remap) c = atlas.resolvePalette(entry.sheet, col, row, palRow, remap);
      }
      if (!(c > 0)) c = atlas.resolve(entry.sheet, col, row);
      return (c > 0) ? c : 0;
    }

    // A palette hit returns an already-recoloured cell; the tokenCell fallback does not. Callers emit
    // either with identity instance tint, so no colour layer spills through transparent pixels.
    function paletteTokenCellGL(token, palRow) {
      var entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
      if (typeof palRow === "number" && entry && entry.sheet && atlas && atlas.resolvePalette) {
        var remap = paletteRemapFor(palRow);
        var pc = remap ? atlas.resolvePalette(entry.sheet, entry.col, entry.row, palRow, remap) : 0;
        if (pc > 0) return pc;
      }
      return tokenCell(token);
    }

    function animAttrForToken(token) {
      var entry = spriteMap && spriteMap[token];
      var frames = entry && entry.frames;
      if (!frames || frames.length <= 1) return 0;
      return encodeAnimAttr(frames.length, defaultAnimRateCodeForToken(token));
    }

    // Glass floors are pre-coloured sheet variants, not palette swaps: this table stands in for the
    // palRow path every other construction-floor family takes.
    var CONS_GLASS_FLOOR_TOKEN = { 3: "GLASS_GREEN_FLOOR", 4: "GLASS_CLEAR_FLOOR", 5: "GLASS_CRYSTAL_FLOOR" };
    function constructionTrackMask(ttname) {
      var m = /Track([NSEW]+)$/.exec(ttname || "");
      if (!m) return 0;
      var s = m[1];
      return (s.indexOf("N") >= 0 ? 1 : 0) | (s.indexOf("S") >= 0 ? 2 : 0) |
             (s.indexOf("E") >= 0 ? 4 : 0) | (s.indexOf("W") >= 0 ? 8 : 0);
    }
    function paletteRowRgbGL(palRow) {
      if (typeof palRow !== "number" || !materialMap || !materialMap.palette) return null;
      var row = materialMap.palette.rows && materialMap.palette.rows[palRow];
      var c = row && row[7];
      return (c && c.length >= 3) ? [c[0], c[1], c[2]] : null;
    }
    function plantWoodRowGL(base_mi) {
      var ids = materialMap && materialMap.plant_ids;
      var id = ids && ids[base_mi];
      var p = id && materialMap.plant && materialMap.plant[id];
      return p && typeof p.WOOD === "number" ? p.WOOD : null;
    }
    function consMaterialGL(base_mt, base_mi) {
      if (typeof base_mt !== "number" || base_mt < 0) return null;
      if (CONS_GLASS_FLOOR_TOKEN[base_mt]) {
        var prg = matPalRowForGL({ mat_type: base_mt });
        return { family: "GLASS", glassMt: base_mt, palRow: (typeof prg === "number") ? prg : null, tintRgb: paletteRowRgbGL(prg) };
      }
      if (base_mt >= 419) {
        var wr = plantWoodRowGL(base_mi);
        return { family: "WOOD", palRow: wr, woodRow: wr, tintRgb: paletteRowRgbGL(wr) || [150, 120, 84] };
      }
      if (base_mt === 0) {
        var ino = materialMap && materialMap.inorganic && materialMap.inorganic[base_mi];
        var fam = ino && ino.family;
        var pr = ino && typeof ino.row === "number" ? ino.row : null;
        var prOkG = (typeof pr === "number") && materialMap && materialMap.palette
          && materialMap.palette.rows && materialMap.palette.rows[pr];
        var row = prOkG ? pr : null;
        return { family: fam || "STONE", palRow: row, tintRgb: paletteRowRgbGL(row) };
      }
      return null;
    }
    function consMaterialRgbGL(base_mt, base_mi) {
      var m = consMaterialGL(base_mt, base_mi);
      return m && m.tintRgb ? m.tintRgb : null;
    }
    function wallMaterialGL(t) {
      if (!t) return null;
      var mat = t.mat || "";
      var m = consMaterialGL(t.base_mt, t.base_mi);
      if (!m) return null;
      if (mat === "CONSTRUCTION") return m;
      if (mat === "STONE" && (m.family === "STONE" || m.family === "GEM")) return m;
      if (mat === "SOIL" && m.family === "SOIL") return m;
      if (mat === "MINERAL" && (m.family === "STONE" || m.family === "GEM")) return m;
      return null;
    }
    function wallMaterialRgbGL(t) {
      var m = wallMaterialGL(t);
      return m && m.tintRgb ? m.tintRgb : null;
    }
    // The hidden-rock backing is never palette-swapped: hiddenRockCell resolves it plain and buildTile
    // emits it white, unlike wallJoinCell's face.
    function wallBackingTokenGL(t, gx, gy, openMask) {
      if (!t || (t.shape || "") !== "WALL") return null;
      if (!wallMaterialGL(t)) return null;
      // Mask 0 means fully buried, so wallJoinCell emits no face; without one the backing reads as a box.
      if (!((openMask | 0) & 0xff)) return null;
      return "HIDDEN_ROCK_" + ((hashXY(gx, gy) % 5) + 1);
    }
    function wallJoinPalRowGL(t) {
      var m = wallMaterialGL(t);
      if (!m || typeof m.palRow !== "number") return null;
      return m.palRow;
    }
    function roughInorganicWallPrefixGL(t) {
      if (!t || t.base_mt !== 0 || (t.mat !== "STONE" && t.mat !== "MINERAL")) return null;
      var ino = materialMap && materialMap.inorganic && materialMap.inorganic[t.base_mi];
      var family = ino && ino.wall_family;
      var base = ino && ino.wall_cell_base;
      if (family === 10) return "ORE_VEIN_WALL";
      if (family === 7 && base === 0x4c6a) return "STONE_WALL";
      var gemBases = [0x4bbf, 0x4bd2, 0x4be5, 0x4bf8];
      if (family >= 11 && family <= 14 && base === gemBases[family - 11])
        return "GEM_" + "ABCD"[family - 11] + "_WALL";
      return null;
    }
    // Both the law and its fallback key on the tile's WORLD position; gx/gy are used only when the
    // caller has no tile to read one from, which no production caller does.
    function roughWallVariantGL(gx, gy, t, drawZ) {
      var wx = (t && typeof t.x === "number") ? t.x : gx;
      var wy = (t && typeof t.y === "number") ? t.y : gy;
      var TV = (typeof self !== "undefined" ? self : globalThis).DwfTerrainVariant;
      if (TV && typeof drawZ === "number") {
        var v = TV.variant(wx, wy, drawZ);
        if (typeof v === "number") return v;
      }
      return hashXY(wx, wy) & 3;
    }
    function fortificationOpenTokenGL(prefix, openMask) {
      // Adjacency bits N=1, S=2, W=4, E=8; the suffix letters must equal the set bits.
      var m = openMask & 15;
      var suffix = m === 15 ? "NSWE" : m === 11 ? "NSE" : m === 7 ? "NSW" :
        m === 13 ? "NWE" : m === 14 ? "SWE" : m === 3 ? "NS" : m === 12 ? "WE" :
        m === 9 ? "NE" : m === 5 ? "NW" : m === 10 ? "SE" : m === 6 ? "SW" : null;
      return suffix ? (prefix + "_OPEN_" + suffix) : prefix;
    }
    function constructionFloorPlanGL(ttname, base_mt, base_mi, openMask) {
      var nm = ttname || "";
      var isFloor = /^(?:Shoddy)?ConstructedFloor/.test(nm);
      var isRamp = /^(?:Shoddy)?ConstructedRamp/.test(nm);
      var stairM = /^ConstructedStair(UD|U|D)$/.exec(nm);
      var isFort = nm === "ConstructedFortification";
      if (!isFloor && !isRamp && !stairM && !isFort) return null;
      var m = consMaterialGL(base_mt, base_mi);
      if (!m) return null;
      var kind = isFloor ? "FLOOR" : isRamp ? "RAMP" : stairM ? stairM[1] : "FORT";
      return root.DwfTerrainVariant.constructedTerrainPlan(kind, nm, m, openMask);
    }
    function resolveConstructionFloorGL(t, gx, gy, lookupTile) {
      var openMask = 0;
      if ((t.ttname || "") === "ConstructedFortification" && Adj && typeof gx === "number" && typeof gy === "number" && lookupTile) {
        openMask = Adj.computeMask8(lookupTile, gx, gy, Adj.isOpenNeighbor);
      }
      var plan = constructionFloorPlanGL(t.ttname || "", t.base_mt, t.base_mi, openMask);
      if (!plan || !atlas) return null;
      var token = plan.token, palRow = plan.palRow;
      var entry = TOKEN_CELL_OVERRIDE[token] || (spriteMap && spriteMap[token]);
      if (!entry || !entry.sheet) return null;
      var cell = 0;
      if (typeof palRow === "number") {
        var remap = paletteRemapFor(palRow);
        if (remap) cell = atlas.resolvePalette(entry.sheet, entry.col, entry.row, palRow, remap);
        if (cell <= 0) cell = atlas.resolve(entry.sheet, entry.col, entry.row);
      } else {
        cell = tokenCell(token);
      }
      if (!(cell > 0)) return null;
      var overlay = 0;
      var mask = plan.mask;
      if (mask) {
        var rc = DESIG_TRACK_CELL[mask];
        if (rc) { var oc = atlas.resolve(DESIG_SHEET, rc[0], rc[1]); if (oc > 0) overlay = oc; }
      }
      return { cell: cell, tintName: null, multiplyRgb: plan.multiplyRgb || null, overlay: overlay, animAttr: 0, overlayAnimAttr: 0 };
    }

    function terrainSpritePalRowGL(t, token) {
      if (!t || (token !== "BOULDER" && token !== "FORTIFICATION" &&
        !/^PEBBLES_FLOOR_/.test(token || ""))) return null;
      var mat = t.mat || "";
      if (mat !== "STONE" && mat !== "MINERAL") return null;
      var m = consMaterialGL(t.base_mt, t.base_mi);
      return m && typeof m.palRow === "number" ? m.palRow : null;
    }

    function sandFloorPlan(t, ttname) {
      if (!t || t.base_mt !== 0 || !/^SoilFloor[1-4]$/.test(ttname || "")) return null;
      var ino = materialMap && materialMap.inorganic && materialMap.inorganic[t.base_mi];
      var m = ino && /^SAND_(TAN|YELLOW|WHITE|BLACK|RED)$/.exec(ino.id || "");
      if (!m) return null;
      var prefix = m[1] === "TAN" ? "SAND" : "SAND_" + m[1];
      var vv = ((/([1-4])$/.exec(ttname) || [null, "1"])[1]);
      return { token: prefix + "_FLOOR_5", overlay: prefix + "_FLOOR_" + vv };
    }

    function resolveGrassSprite(id, gx, gy, ttname, plantOccupied, tile) {
      if (!atlas || !root.DwfGrassSelection) return null;
      var selection = root.DwfGrassSelection.select(grassColors,
        tile || { ttname: ttname, grass: { id: id } }, plantOccupied);
      if (!selection) return null;
      var cell = atlas.resolveRef ? atlas.resolveRef(selection)
        : atlas.resolve(selection.sheet, selection.col, selection.row);
      if (cell > 0 && atlas.isCellVisible && !atlas.isCellVisible(cell, 1)) return null;
      return cell > 0 ? { cell: cell, tintName: selection.tint, overlay: 0, animAttr: 0, overlayAnimAttr: 0 } : null;
    }

    function resolveSprite(t, gx, gy, lookupTile) {
      if (t.hidden) return null;
      var ttname = t.ttname;
      if (!ttname) return null;
      // Shape WALL returns null so the art composes downstream: a backing sprite where one resolves,
      // tileColor's fill only as the fallback, plus wallJoinCell's edge. FORTIFICATION is not WALL.
      if ((t.shape || "") === "WALL") return null;
      var TV = root.DwfTerrainVariant;
      var sweepFloorToken = TV && typeof TV.smoothFloorToken === "function" ? TV.smoothFloorToken(t) : null;
      if (sweepFloorToken) {
        var sweepFloorCell = tokenCell(sweepFloorToken);
        if (sweepFloorCell > 0) return { cell: sweepFloorCell, tintName: null, multiplyRgb: null, overlay: 0, animAttr: 0, overlayAnimAttr: 0 };
      }
      var sandPlan = sandFloorPlan(t, ttname);
      if (sandPlan) {
        var sandCell = tokenCell(sandPlan.token);
        if (sandCell > 0) return { cell: sandCell, tintName: null, multiplyRgb: null, overlay: tokenCell(sandPlan.overlay), animAttr: 0, overlayAnimAttr: 0 };
      }
      // The tail's selected species chooses the authored grass art; the tiletype chooses GRASS_1..4.
      var isGrassMat = !!(t.mat && t.mat.indexOf("GRASS_") === 0);
      // Amount is description and trample state, never an art selector.
      if (t.grass && isGrassMat && (t.shape || "") === "FLOOR") {
        var speciesCell = resolveGrassSprite(t.grass.id, gx, gy, ttname, false, t);
        // A present species id is authoritative. Never fall through to generic green GRASS_n.
        return speciesCell;
      }
      if (t.grass && atlas && !isGrassMat) {
        var gu = /^(?:SoilFloor[1-4]|(?:Stone|Mineral|Lava|Feature)Pebbles([1-4]))$/.exec(ttname);
        if (gu) {
          var guPlan = resolveGrassSprite(t.grass.id, gx, gy, ttname, false, t);
          if (guPlan) {
            var guCell = guPlan.cell;
            var guOverlay = 0;
            if (gu[1]) {
              var pebbleToken = "PEBBLES_FLOOR_" + gu[1];
              guOverlay = paletteTokenCellGL(pebbleToken, terrainSpritePalRowGL(t, pebbleToken));
            }
            return {
              cell: guCell, tintName: guPlan.tintName,
              overlay: guOverlay,
              animAttr: 0, overlayAnimAttr: 0,
            };
          }
          // grass.png is not resolved into the atlas yet: fall through to the normal ttname art for one rebuild.
        }
      }
      // Material-family construction floor/track art wins over the material-blind token map.
      var consCell = resolveConstructionFloorGL(t, gx, gy, lookupTile);
      if (consCell) return consCell;
      var map = spriteMap && tokenMap && tokenMap[ttname];
      if (map && map.token) {
        var baseCell = tokenCell(map.token);
        if (!baseCell) return null;   // token uncovered or sheet not loaded -> colour fallback
        var terrainPalRow = terrainSpritePalRowGL(t, map.token);
        // BOULDER fans out to its 8 authored variant cells, on the same world-coord hashXY pick as canvas2d.
        if (map.token === "BOULDER") {
          var bv = boulderVariantGL(t, gx, gy, terrainPalRow);
          if (bv > 0) baseCell = bv;
        } else if (typeof terrainPalRow === "number") {
          baseCell = paletteTokenCellGL(map.token, terrainPalRow);
        }
        var overlayCell = map.overlay ? tokenCell(map.overlay) : 0;
        return {
          cell: baseCell, tintName: map.tint || null, overlay: overlayCell,
          animAttr: animAttrForToken(map.token),
          overlayAnimAttr: map.overlay ? animAttrForToken(map.overlay) : 0,
        };
      }
      if (tokenMap && looksLikeGrassFloor(ttname)) {
        return resolveGrassSprite(t.grass && t.grass.id, gx, gy, ttname, false, t);
      }
      return null;
    }

    // Atlas cell for one HIDDEN_ROCK_<n> token (n = 1..5).
    function hiddenRockCell(idx) {
      var entry = spriteMap && spriteMap["HIDDEN_ROCK_" + idx];
      if (!entry || !entry.sheet || !atlas) return 0;
      var c = atlas.resolve(entry.sheet, entry.col, entry.row);
      return (c > 0) ? c : 0;
    }
    // 0 means "no speckle in this slot" -- the overwhelmingly common answer -- or an unresolved
    // hidden_rock cell; callers must not treat it as an error. Keyed on WORLD (x,y,z).
    function resolveHiddenCell(t, wz) {
      var v = hiddenVariantAt(t && t.x, t && t.y, wz);
      if (v < 0) return 0;
      return hiddenRockCell(v + 1);  // variant 0..4 -> HIDDEN_ROCK_1..5
    }

    function inMapBoundsGL(t, dims) {
      if (!dims || !t) return false;
      var x = t.x, y = t.y;
      return typeof x === "number" && x >= 0 && x < dims.w &&
             typeof y === "number" && y >= 0 && y < dims.h;
    }

    function wantsHiddenHatchGL(t, dims) {
      if (!t) return false;
      var tt = (typeof t.tt === "number") ? t.tt : -1;
      if (t.hidden && tt >= 0) return true;
      return tt < 0 && inMapBoundsGL(t, dims);
    }

    function overlaysAllowedGL(t) {
      if (!t) return false;
      var tt = (typeof t.tt === "number") ? t.tt : -1;
      return tt >= 0 && !t.hidden;
    }

    // ---- items -------------------------------------------------------------------------
    var ITEM_PLANT_PART_GL = { SEEDS: "SEED", PLANT: "PICKED", PLANT_GROWTH: "PICKED" };
    var ITEM_CREATURE_TYPES_GL = { CORPSE: 1, CORPSEPIECE: 1, REMAINS: 1, VERMIN: 1, PET: 1, FISH: 1, FISH_RAW: 1 };
    function creatureFoodItemCellGL(it) {
      if (!it || (it.type !== "MEAT" && it.type !== "GLOB") || it.identKind !== 2 || !it.ident)
        return null;
      var food = itemMap && itemMap.creature_food;
      var profile = food && food.by_creature && food.by_creature[it.ident];
      var layout = profile && food.profiles && food.profiles[profile];
      var kind = layout && layout[String(it.mat_type)];
      var entry = kind && food.cells && food.cells[kind];
      return entry && entry.sheet ? entry : null;
    }
    function resolveIdentityEntryGL(it) {
      if (!it || typeof it.identKind !== "number" || !it.ident) return null;
      if (it.identKind === 1 && plantMap) {
        // WOOD, DRINK and POWDER_MISC are plant-material items too, but deliberately render a generic
        // per-TYPE cell: do NOT widen ITEM_PLANT_PART_GL to cover them.
        var part = ITEM_PLANT_PART_GL[it.type];
        if (!part) return null;
        var pm = plantMap[it.ident];
        if (pm) return pm[part] || pm.PICKED || pm.SHRUB || pm.SEED || null;
      } else if (it.identKind === 2 && creaturesMap && creaturesMap.races) {
        if (ITEM_CREATURE_TYPES_GL[it.type]) {
          var cm = creaturesMap.races[it.ident];
          if (cm) {
            if (it.type === "CORPSE" || it.type === "CORPSEPIECE" || it.type === "REMAINS") {
              var corpseCell = (cm.corpse && cm.corpse.sheet) ? cm.corpse : null;
              var skelCell   = (cm.skeleton && cm.skeleton.sheet) ? cm.skeleton : null;
              if (it.skeletal) {
                var dead = skelCell || corpseCell;
                if (dead) return dead;
              } else {
                if (corpseCell) return corpseCell;
              }
            }
            if (cm.sheet) return cm;
          }
        }
      }
      return null;
    }
    // identKind 3 is a server-resolved INORGANIC token and overrides the offline index join; an
    // unknown token (a modded world) yields null, never a wrong-index guess.
    var matInorganicByIdGL = null; // lazy {ID: entry}; reset in buildPaletteLookup on map swap
    function matInorganicGL(it) {
      if (!materialMap || !materialMap.inorganic || !it || it.mat_type !== 0) return null;
      if (it.identKind === 3 && it.ident) {
        if (!matInorganicByIdGL) {
          matInorganicByIdGL = Object.create(null);
          for (var j = 0; j < materialMap.inorganic.length; j++) {
            var e2 = materialMap.inorganic[j];
            if (e2 && e2.id) matInorganicByIdGL[e2.id] = e2;
          }
        }
        return matInorganicByIdGL[it.ident] || null;
      }
      var i = it.mat_index;
      if (typeof i !== "number" || i < 0 || i >= materialMap.inorganic.length) return null;
      return materialMap.inorganic[i] || null;
    }
    function matFamilyForItemGL(it) {
      var mt = it.mat_type;
      if (mt === 3 || mt === 4 || mt === 5) return "GLASS";
      if (mt === 0) {
        var e = matInorganicGL(it);
        if (e && e.family) return (e.family === "METAL") ? "METAL" : (e.family === "GLASS" ? "GLASS" : "STONE");
        return "STONE";
      }
      if (mt >= 419) return "WOOD";
      return null;
    }
    function matPalRowForGL(it) {
      if (!materialMap) return null;
      var mt = it.mat_type;
      if (mt === 0) { var e = matInorganicGL(it); return e && typeof e.row === "number" ? e.row : null; }
      if (mt === 3 || mt === 4 || mt === 5) {
        var b = materialMap.builtin && materialMap.builtin[String(mt)];
        return b && typeof b.row === "number" ? b.row : null;
      }
      if (mt >= 419 && materialMap.plant) {
        var ids = materialMap.plant_ids;
        var id = (it.identKind === 1 && it.ident) ? it.ident
          : (ids && typeof it.mat_index === "number" ? ids[it.mat_index] : null);
        var p = id && materialMap.plant[id];
        if (p) {
          if (it.type === "WOOD" && typeof p.WOOD === "number") return p.WOOD;
          var local = Object.keys(p)[mt - 419];
          if (local && typeof p[local] === "number") return p[local];
        }
      }
      return null;
    }
    var GLASS_ROUGH_KEY_GL = { 3: "GLASS_GREEN", 4: "GLASS_CLEAR", 5: "GLASS_CRYSTAL" };
    var CRAFT_ITEM_TOKEN_BASE_GL = {
      FIGURINE: "ITEM_FIGURINE", AMULET: "ITEM_AMULET", SCEPTER: "ITEM_SCEPTER",
      CROWN: "ITEM_CROWN", RING: "ITEM_RING", EARRING: "ITEM_EARRING", BRACELET: "ITEM_BRACELET",
    };
    function pickRoughTierGL(value) {
      var tiers = itemMap && itemMap.rough_gem_tiers;
      if (!tiers || !tiers.length) return null;
      var chosen = tiers[0].cell;
      for (var i = 0; i < tiers.length; i++) if (value >= tiers[i].min_value) chosen = tiers[i].cell;
      return chosen || null;
    }
    function hatchCoverMaterialCellGL(it) {
      var map = itemMap && itemMap.hatch_cover_bymat;
      if (!map || !it) return null;
      if (it.mat_type === 0) {
        if (it.identKind === 3 && it.ident && map[it.ident]) return map[it.ident];
        var e = matInorganicGL(it);
        if (e && e.id && map[e.id]) return map[e.id];
      }
      if (it.mat_type >= 419 && it.identKind === 1 && it.ident) {
        return map["PLANT_MAT:" + it.ident + ":WOOD"] || null;
      }
      return null;
    }
    function materialItemCellGL(it, type) {
      if (!itemMap) return null;
      var craftBase = CRAFT_ITEM_TOKEN_BASE_GL[type];
      if (craftBase && itemMap.bytoken) {
        var craftMaterial = matFamilyForItemGL(it) === "WOOD" ? "WOOD" : "METAL";
        var craftCell = itemMap.bytoken[craftBase + "_" + craftMaterial];
        if (craftCell) return craftCell;
      }
      if (itemMap.bytoken && (type === "BARREL" || type === "BUCKET" || type === "CAGE")) {
        var fam = matFamilyForItemGL(it);
        var token = null;
        if (type === "BARREL") token = fam === "METAL" ? "ITEM_BARREL_METAL_EMPTY" : "ITEM_BARREL_WOOD_EMPTY";
        else if (type === "BUCKET") token = fam === "METAL" ? "ITEM_BUCKET_METAL" : "ITEM_BUCKET_WOOD";
        else if (type === "CAGE")
          token = fam === "GLASS" ? "ITEM_CAGE_GLASS" : (fam === "METAL" ? "ITEM_CAGE_METAL" : "ITEM_CAGE_WOOD");
        if (token && itemMap.bytoken[token]) return itemMap.bytoken[token];
      }
      if (type === "BAR" && itemMap.bar_bymat) {
        var barKey = null;
        if (it.mat_type === 7) barKey = it.mat_index === 1 ? "COAL:CHARCOAL" : "COAL:COKE";
        else if (it.mat_type === 8) barKey = "POTASH";
        else if (it.mat_type === 10) barKey = "PEARLASH";
        if (barKey && itemMap.bar_bymat[barKey]) return itemMap.bar_bymat[barKey];
      }
      if (type === "HATCH_COVER") {
        var hc = hatchCoverMaterialCellGL(it);
        if (hc) return hc;
      }
      // Cut gems are MATERIAL-BLIND: art from the cut, palette from the material. Gating this on a
      // gem-flagged inorganic drops shell, pearl, ivory, horn, glass and ornamental-stone cut gems.
      if (type === "GEM" || type === "SMALLGEM") {
        // shape -> shape_tokens[shape] -> gem_shapes per-cut cell; -1 or unknown falls to the GEMS:0:0 default.
        if (typeof it.shape === "number" && it.shape >= 0 &&
            materialMap && materialMap.shape_tokens && itemMap.gem_shapes) {
          var stok = materialMap.shape_tokens[it.shape];
          var gsh = stok && itemMap.gem_shapes[stok];
          var cut = gsh && ((type === "GEM") ? gsh.large : gsh.small);
          if (cut) return cut;
        }
        var g = (type === "GEM") ? itemMap.gem_default : itemMap.smallgem_default;
        if (g) return g;
      }
      if (it.mat_type === 0) {
        var e = matInorganicGL(it);
        if (e) {
          if (type === "BOULDER" && itemMap.boulder_bymat && itemMap.boulder_bymat[e.id]) return itemMap.boulder_bymat[e.id];
          if (type === "ROUGH" && e.gem) { var c = pickRoughTierGL(e.value || 1); if (c) return c; }
        }
      }
      if (type === "ROUGH" && itemMap.rough_gem_glass) {
        var gk = GLASS_ROUGH_KEY_GL[it.mat_type];
        if (gk && itemMap.rough_gem_glass[gk]) return itemMap.rough_gem_glass[gk];
      }
      return null;
    }
    function itemdefVariantCellGL(it, token) {
      var variants = itemMap && itemMap.itemdef_variants && itemMap.itemdef_variants[token];
      if (!variants) return null;
      if (it.artifact && variants.ARTIFACT) return variants.ARTIFACT;
      if (it.specialMaterial && variants.SPECIAL_MAT) return variants.SPECIAL_MAT;
      var fam = matFamilyForItemGL(it);
      if (it.type === "AMMO")
        return fam === "WOOD" ? (variants.STRAIGHT_WOOD || null) :
          (variants.STRAIGHT_DEFAULT || null);
      if (fam === "WOOD") {
        if (it.grown && variants.WOOD_GROWN) return variants.WOOD_GROWN;
        return variants.WOOD || variants.WOODEN || null;
      }
      return fam && variants[fam] ? variants[fam] : null;
    }
    var PALETTIZABLE_SOURCE_GL = { itemdef: 1, material: 1, matvariant: 1, bytype: 1 };
    // Full resolution mirroring canvas2d's resolveItemVisual, including the itemdef -> bytoken step.
    function resolveItemVisualGL(it) {
      if (!itemMap) return null;
      var type = it.type;
      var food = creatureFoodItemCellGL(it);
      if (food) return { entry: food, source: "creaturefood" };
      var ident = resolveIdentityEntryGL(it);
      if (ident) return { entry: ident, source: "ident" };
      // Instrument PIECES are a different item type: TOOL + HARD_MAT + no own texpos always draws this pile.
      if (type === "TOOL" && it.generatedTool && itemMap.bytoken.ITEM_GENERATED_TOOL)
        return { entry: itemMap.bytoken.ITEM_GENERATED_TOOL, source: "itemdef" };
      if (type === "INSTRUMENT" && typeof it.instrumentClass === "number") {
        var instrumentTokens = [
          "ITEM_INSTRUMENT_KEYBOARD_BUILDING", "ITEM_INSTRUMENT_KEYBOARD_HANDHELD",
          "ITEM_INSTRUMENT_STRINGED_BUILDING", "ITEM_INSTRUMENT_STRINGED_HANDHELD",
          "ITEM_INSTRUMENT_WIND_BUILDING", "ITEM_INSTRUMENT_WIND_HANDHELD",
          "ITEM_INSTRUMENT_PERCUSSION_BUILDING", "ITEM_INSTRUMENT_PERCUSSION_HANDHELD",
        ];
        var instrumentToken = instrumentTokens[it.instrumentClass];
        var instrumentEntry = instrumentToken && itemMap.bytoken && itemMap.bytoken[instrumentToken];
        if (instrumentEntry) return { entry: instrumentEntry, source: "itemdef" };
      }
      if (itemDefTokens && typeof it.subtype === "number" && it.subtype >= 0) {
        var tok = itemDefTokens.get(type + ":" + it.subtype);
        var variant = tok && itemdefVariantCellGL(it, tok);
        if (variant) return { entry: variant, source: "itemdef" };
        if (tok && itemMap.bytoken && itemMap.bytoken[tok]) return { entry: itemMap.bytoken[tok], source: "itemdef" };
      }
      var matCell = materialItemCellGL(it, type);
      if (matCell) return { entry: matCell, source: "material" };
      var base = ITEM_MATVARIANT_BASE[type];
      if (base && itemMap.matvariants && itemMap.matvariants[base]) {
        var fam = matFamilyForItemGL(it);
        var variants = itemMap.matvariants[base];
        if (fam && variants[fam]) return { entry: variants[fam], source: "matvariant" };
      }
      if (itemMap.bytype && itemMap.bytype[type]) return { entry: itemMap.bytype[type], source: "bytype" };
      if ((type === "CORPSE" || type === "CORPSEPIECE" || type === "REMAINS") && itemMap._corpse_fallback) {
        return { entry: itemMap._corpse_fallback, source: "corpse" };
      }
      var miss = itemMap._missing || itemMap[type] || itemMap._default || null;
      return miss ? { entry: miss, source: "missing" } : null;
    }
    // Thin cell-only wrapper (preserves the GL item test-hook contract).
    function resolveItemEntryGL(it) {
      var v = resolveItemVisualGL(it);
      return v ? v.entry : null;
    }

    // ---- barrel/bin contents-peek overlay ----------------------------
    function containerPeekEntryGL(it, peek) {
      return root.DwfItemSelection.containerPeekEntry(it, peek, itemMap, materialMap);
    }

    // ---- stockpile checker and rope, emitted INSIDE the tile stack -----------------------------
    // The edge-set rule is not reimplemented: both renderers call DwfOverlayBoxes.stockpileLayerIndex.
    var spLayerIndex = null;
    function rebuildStockpileIndex(buildings, oz) {
      spLayerIndex = null;
      var B = (typeof window !== "undefined") && window.DwfOverlayBoxes;
      if (!B || typeof B.stockpileLayerIndex !== "function") return;
      if (!Array.isArray(buildings) || !buildings.length) return;
      try { spLayerIndex = B.stockpileLayerIndex(buildings, oz); } catch (_) { spLayerIndex = null; }
    }
    function stockpileTileAtGL(t, gx, gy) {
      if (!spLayerIndex || !spLayerIndex.size) return null;
      if (typeof t.x !== "number" || typeof t.y !== "number") return null;
      return spLayerIndex.get(t.x + "," + t.y) || null;
    }
    // Colour is baked into the art, so emitSprite passes white and never a tint.
    function emitStockpilePieces(tokens, gx, gy, attr) {
      var B = window.DwfOverlayBoxes;
      if (!tokens || !tokens.length || !atlas || !B) return;
      for (var i = 0; i < tokens.length; i++) {
        var spec = B.stockpileCells[tokens[i]];
        if (!spec) continue;
        var c = atlas.resolve("stockpile.png", spec.col, spec.row);
        if (c > 0) emitSprite(gx, gy, c, attr || 0);
      }
    }
    function emitStockpileFloor(t, gx, gy, attr) {
      var e = stockpileTileAtGL(t, gx, gy);
      if (e) emitStockpilePieces(e.floor, gx, gy, attr);
    }
    function emitStockpileRope(t, gx, gy, attr) {
      var e = stockpileTileAtGL(t, gx, gy);
      if (e) emitStockpilePieces(e.rope, gx, gy, attr);
    }

    function emitItem(t, gx, gy, attr) {
      var a = attr || 0;
      if (!itemMap || !t.item || !atlas) return;
      var it = t.item;
      if (it.type === "THREAD" && (it.iflags & 0x01) && itemMap.web) {
        var variants = (itemMap.web.harmless && itemMap.web.harmless.length) ? itemMap.web.harmless : itemMap.web.thick;
        if (variants && variants.length) {
          var v = variants[hashInt(gx, gy) % variants.length];
          if (v && v.sheet) {
            var vc = atlas.resolve(v.sheet, v.col, v.row);
            if (vc > 0) { emitSprite(gx, gy, vc, a); return; }
          }
        }
      }
      var vis = resolveItemVisualGL(it);
      var e = vis && vis.entry;
      if (e && e.sheet) {
        // On a palettizable path, resolve a palette-swapped cell per material row; the fallback keeps the legacy tint.
        var palRow;
        if (materialMap && (PALETTIZABLE_SOURCE_GL[vis.source] ||
            (vis.source === "ident" && (it.type === "PLANT_GROWTH" ||
              it.type === "PLANT" || it.type === "SEEDS")))) {
          var pr = matPalRowForGL(it);
          if (typeof pr === "number") palRow = pr;
        }
        var c = -1;
        var gemVar = gemVariantForItemGL(it, vis, gx, gy);
        if (typeof gemVar === "number") c = gemCompositeCell(e, palRow, gemVar);
        // Guard `atlas.resolvePalette` before calling it: an atlas without the method otherwise takes the
        // whole item branch down with it -- base sprite and contents-peek overlay alike.
        if (c <= 0 && palRow !== undefined && typeof atlas.resolvePalette === "function") {
          var remap = paletteRemapFor(palRow);
          if (remap) c = atlas.resolvePalette(e.sheet, e.col, e.row, palRow, remap);
        }
        // resolvePalette returns PENDING (0) while the swap cell builds, and stays 0 on a hard failure, so
        // any c <= 0 falls back to the plain cell and legacy tint for this frame rather than drawing nothing.
        if (c <= 0) { c = atlas.resolve(e.sheet, e.col, e.row); palRow = undefined; }
        if (c > 0) {
          if (palRow !== undefined) {
            emitSprite(gx, gy, c, a);  // pixels already carry the material color
          } else {
            var fam = matFamilyFor(it.mat_type);
            var tint = fam && ITEM_TINT_RGB_BY_FAMILY[fam];
            if (tint) emit(gx, gy, c, tint[0], tint[1], tint[2], 255, a);
            else emitSprite(gx, gy, c, a);
          }
          if (t.peek) {
            var pk = containerPeekEntryGL(it, t.peek);
            if (pk) {
              var ppr = matPalRowForGL(t.peek);
              var pc = 0;
              if (typeof ppr === "number" && atlas.resolvePalette) {
                var prem = paletteRemapFor(ppr);
                if (prem) pc = atlas.resolvePalette(pk.sheet, pk.col, pk.row, ppr, prem);
              }
              if (!(pc > 0)) pc = atlas.resolve(pk.sheet, pk.col, pk.row);
              if (pc > 0) emitSprite(gx, gy, pc, a);
            }
          }
        }
      }
      if (atlas) {
        var mtok = itemMarkToken(it.iflags);
        if (mtok) {
          var mr = DESIG_ITEM_ROW[mtok];
          if (typeof mr === "number") {
            var mc = atlas.resolve(DESIG_ITEM_SHEET, 0, mr);
            if (mc > 0) emitSprite(gx, gy, mc, a);
          }
        }
      }
    }

    // ---- vermin / vermin-colony sprite (mirrors canvas2d's drawVermin) -------------------------
    function resolveVerminEntryGL(t) {
      var v = t.vermin;
      if (!v || !v.length || !creaturesMap || !creaturesMap.races) return null;
      var pick = null;
      for (var i = 0; i < v.length; i++) {
        var e = v[i];
        if (!e || !e.token) continue;
        var c = creaturesMap.races[e.token];
        if (!c || !c.sheet) continue;
        if (e.vflags & 0x01) return c;   // colony takes precedence
        if (!pick) pick = c;
      }
      return pick;
    }
    function emitVermin(t, gx, gy, attr) {
      if (!atlas) return;
      var e = resolveVerminEntryGL(t);
      if (e && e.sheet) {
        var c = atlas.resolve(e.sheet, e.col, e.row);
        if (c > 0) emitSprite(gx, gy, c, attr || 0);
      }
    }

    // ---- spatter decals + item-spatter litter -------------------
    function resolveSpatterFullKey(fam, gx, gy, lookupTile, wx, wy, wz) {
      if (!Adj || !lookupTile) return "FULL_ISOLATED";
      var mask4 = 0;
      try {
        var mask8 = Adj.computeMask8(lookupTile, gx, gy, function (nt) {
          var nsp = nt && ((nt.spatters && nt.spatters[0]) || nt.spatter);
          return !!nt && spatterVisible(nsp && nsp.amount) && spatterFamilyForCtx(spatterMap, nsp) === fam;
        });
        mask4 = mask8 & Adj.CARDINAL_BITS;
      } catch (_) { mask4 = 0; }
      var suf = "";
      if (mask4 & Adj.BIT.N) suf += "N";
      if (mask4 & Adj.BIT.S) suf += "S";
      if (mask4 & Adj.BIT.W) suf += "W";
      if (mask4 & Adj.BIT.E) suf += "E";
      if (!suf) return "FULL_ISOLATED";
      if (suf === "NSWE") {
        var letters = ["A", "B", "C", "D", "E"];
        var TV = root.DwfTerrainVariant;
        var pick = TV && typeof TV.stableIndex === "function"
          ? TV.stableIndex(wx, wy, wz || 0, letters.length, 0) : hashInt(gx, gy) % letters.length;
        return "FULL_NSWE_" + letters[pick];
      }
      return "FULL_" + suf;
    }

    function emitSpatterFallbackWash(sp, gx, gy, attr) {
      if (!spatterVisible(sp && sp.amount)) return;
      var a = Math.min(0.4, 0.08 + sp.amount / 400);
      emitSolid(gx, gy, [140, 25, 20], Math.round(a * 255), attr || 0);
    }

    function emitSpatterDecals(t, gx, gy, lookupTile, attr) {
      var arr = t.spatters;
      if (!arr || !arr.length) return;
      if (!spatterMap || !atlas) { emitSpatterFallbackWash(firstVisibleSpatter(arr), gx, gy, attr); return; }
      var drewAny = false;
      for (var i = 0; i < arr.length && i < 4; i++) {
        var sp = arr[i];
        if (!sp || !spatterVisible(sp.amount)) continue;
        var fam = spatterFamilyForCtx(spatterMap, sp);
        var famDef = fam && spatterMap.families && spatterMap.families[fam];
        if (!famDef) continue;
        var wx = (typeof t.x === "number") ? t.x : gx;
        var wy = (typeof t.y === "number") ? t.y : gy;
        var wz = (typeof t.z === "number") ? t.z : 0;
        var shape = spatterShapeForCtx(spatterMap, sp.amount);
        var key = (shape === "FULL") ? resolveSpatterFullKey(fam, gx, gy, lookupTile, wx, wy, wz)
          : partialVariantKey(shape, wx, wy, wz, i);
        var TV = root.DwfTerrainVariant;
        var cellDef = TV && typeof TV.spatterCell === "function"
          ? TV.spatterCell(spatterMap, sp, wx, wy, wz, i, key)
          : (spatterCellForKeyCtx(spatterMap, fam, key)
            || spatterCellForKeyCtx(spatterMap, fam, "FULL_ISOLATED"));
        var c = cellDef ? atlas.resolve(cellDef.sheet, cellDef.col, cellDef.row) : 0;
        if (c > 0) { emitSprite(gx, gy, c, attr || 0); drewAny = true; }
      }
      if (!drewAny) emitSpatterFallbackWash(firstVisibleSpatter(arr), gx, gy, attr);
    }

    // Fallen leaves and fruit litter -- always PARTIAL_n, never a FULL neighbour-joined sheet.
    function emitItemSpatterLitter(t, gx, gy, attr) {
      if (!atlas) return;
      var best = itemSpatterPlanGL(t.itemSpatters, spatterMap);
      if (!best) return;
      var shape = spatterShapeForCtx(spatterMap, best.isp.amount);
      if (shape === "FULL") shape = "PARTIAL_D";
      var wx = (typeof t.x === "number") ? t.x : gx;
      var wy = (typeof t.y === "number") ? t.y : gy;
      var wz = (typeof t.z === "number") ? t.z : 0;
      var key = partialVariantKey(shape, wx, wy, wz, 0);
      var cellDef = best.famDef.cells[key];
      if (!cellDef) return;
      var c = atlas.resolve(best.famDef.sheet, cellDef.col, cellDef.row);
      if (c > 0) {
        var tint = root.DwfTerrainVariant.itemSpatterTintRgb(best.fam, best.isp.rgb);
        if (tint) emit(gx, gy, c, tint[0], tint[1], tint[2], 255, attr || 0);
        else emitSprite(gx, gy, c, attr || 0);
      }
    }

    // ---- plants/shrubs/saplings -----------------------------------------------
    function plantEntryGL(p) {
      if (!p || !plantMap || (p.part !== "SHRUB" && p.part !== "SAPLING")) return null;
      var part = p.part, id = p.id;
      var e = id && plantMap[id] && plantMap[id][part];
      if (!e && part === "SAPLING" && treeMap && id && treeMap[id]) e = treeMap[id].SAPLING;
      if (!e) e = (part === "SHRUB") ? plantMap._default_shrub : plantMap._default_sapling;
      return e && e.sheet ? e : null;
    }
    function emitPlant(t, gx, gy, attr) {
      if (!atlas) return;
      var e = plantEntryGL(t && t.plant);
      if (e) {
        var c = atlas.resolve(e.sheet, e.col, e.row);
        if (c > 0) emitSprite(gx, gy, c, attr || 0);
      }
    }

    // ---- tree geometry -------------------------------------------------------------------
    function treeFamilyTable(entry, family) { return entry && entry[family]; }
    function resolveTreeCellGL(sel, id, gx, gy, lookupTile) {
      if (!treeMap || !sel || sel.skip) return null;
      var species = (id && treeMap[id]) || treeMap._default;
      if (!species) return null;
      var variant = sel.variant;
      if (variant === null && sel.adjacency) {
        variant = "_";
        if (Adj && lookupTile) {
          var mask = Adj.computeMask8(lookupTile, gx, gy, isCanopyNeighbor);
          var suffix = Adj.cardinalSuffix(mask).replace(/_/g, "");
          if (suffix) variant = suffix;
        }
      }
      function lookupFam(fam) {
        if (!fam) return null;
        var t1 = treeFamilyTable(species, fam);
        if (t1 && t1[variant]) return t1[variant];
        var t2 = treeFamilyTable(treeMap._default, fam);
        if (t2 && t2[variant]) return t2[variant];
        return null;
      }
      var cell = lookupFam(sel.family) || lookupFam(sel.altFamily);
      if (!cell && variant !== "_") {
        var saved = variant;
        variant = "_";
        cell = lookupFam(sel.family) || lookupFam(sel.altFamily);
        variant = saved;
      }
      if (!cell) {
        var flatKey = TREE_FLAT_FALLBACK[sel.family];
        if (flatKey) cell = species[flatKey] || (treeMap._default && treeMap._default[flatKey]);
      }
      return cell;
    }

    // Resolve packed native keys only by INDEXING tree_map's extracted arrays -- never by slot
    // arithmetic: those arrays already encode native's displaced base-leaf slot and fruit runs.
    var TREE_GROWTH_NAMES = ["FRUIT_1", "FRUIT_2", "FRUIT_3", "FLOWER_2", "FLOWER_1"];
    function treeGraphicsCellsGL(g) {
      var shared = treeMap && treeMap._shared;
      if (!g || !shared || !shared.wood || !shared.leaf) return null;
      var out = { wood: null, leaf: null, growth: null, colorIndex: 0 };
      if (g.woodPresent) {
        var wk = g.woodKey >>> 0, ws = (wk >>> 8) & 0xff;
        if (ws < shared.wood.length) out.wood = shared.wood[ws];
        out.colorIndex = wk & 0xff;
      }
      if (g.leafPresent) {
        var lk = g.leafKey >>> 0, ls = (lk >>> 8) & 0xff, autumn = (lk >>> 19) & 3;
        var baseRun = autumn ? shared.leaf.autumn && shared.leaf.autumn[String(autumn)] : shared.leaf.base;
        if (baseRun && ls < baseRun.length) out.leaf = baseRun[ls];
        out.colorIndex = lk & 0xff;
        if (g.growthPresent) {
          var name = TREE_GROWTH_NAMES[(lk >>> 16) & 7];
          var run = name && shared.leaf.growth && shared.leaf.growth[name];
          if (run && ls < run.length) out.growth = run[ls];
        }
      }
      return out;
    }

    function emitTree(t, gx, gy, lookupTile, attr) {
      if (!treeMap || !atlas) return;
      var keyed = treeGraphicsCellsGL(t.treeGraphics);
      if (keyed && (keyed.wood || keyed.leaf)) {
        var keyedCells = [keyed.wood, keyed.leaf, keyed.growth];
        for (var ki = 0; ki < keyedCells.length; ki++) {
          var ke = keyedCells[ki];
          if (!ke || !ke.sheet) continue;
          var kc = keyed.colorIndex > 0 && atlas.resolvePalette
            ? atlas.resolvePalette(ke.sheet, ke.col, ke.row, keyed.colorIndex - 1, paletteRemapFor(keyed.colorIndex - 1))
            : atlas.resolve(ke.sheet, ke.col, ke.row);
          if (kc > 0) emitSprite(gx, gy, kc, attr || 0);
        }
        return;
      }
      var p = t.plant;
      // A missing plant tail no longer blanks the tile: derive the part from shape/mat, species -> _default.
      var part = (p && p.part) || derivedTreePart(t);
      if (part !== "TRUNK" && part !== "BRANCH" && part !== "CANOPY" && part !== "LEAVES") return;
      var pid = (p && p.id) || null;
      var sel = parseTreeTtname(t.ttname || "");
      if (sel && sel.skip) return;
      var e = sel && resolveTreeCellGL(sel, pid, gx, gy, lookupTile);
      if (!e) {
        e = pid && treeMap[pid] && treeMap[pid][part];
        if (!e) e = treeMap._default && treeMap._default[part];
      }
      if (e && e.sheet) {
        var c = atlas.resolve(e.sheet, e.col, e.row);
        if (c > 0) {
          emitSprite(gx, gy, c, attr || 0);
          // Live directional trunk and branch cells composite the species' TREE_OVERLEAVES leaf cell on top.
          var over = resolveOverleavesGL(treeMap, sel, pid);
          if (over && over.sheet) {
            var oc = atlas.resolve(over.sheet, over.col, over.row);
            if (oc > 0) emitSprite(gx, gy, oc, attr || 0);
          }
        }
      }
    }

    // ---- buildings: multi-tile art, material tint, MISSING_BUILDING fallback ----------------
    function customWorkshopEntryGL(b) {
      if (!buildingMap) return null;
      var w = Math.max(1, ((b.x2 | 0) - (b.x1 | 0)) + 1);
      var h = Math.max(1, ((b.y2 | 0) - (b.y1 | 0)) + 1);
      var keys = Object.keys(buildingMap);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("WORKSHOP_CUSTOM:") !== 0) continue;
        var e = buildingMap[keys[i]];
        if (e && e.w === w && e.h === h) return e;
      }
      return null;
    }

    function plannedConstructionEntryGL(b) {
      return window.DwfConstructionSelect.plannedConstructionEntry(b, buildingMap);
    }

    var STATUE_OVERALL_CREATURE_GL = 2;  // item_statue_graphics_type_overall
    var STATUE_OVERALL_EVENT_GL = 5;
    function statueSubjectGL(S, b) {
      if (!S.subjects) return S.default || null;
      var gt = (typeof b.sgt === "number") ? b.sgt : -1;
      if (gt === STATUE_OVERALL_CREATURE_GL && b.srt && S.creature) {
        var race = String(b.srt);
        var hit = S.creature[race] || S.creature[race.split(":")[0]];
        if (hit) return hit;
      } else if (gt === STATUE_OVERALL_EVENT_GL && S.event) {
        var etok = S.event[String(b.sgi)];
        if (etok && S.subjects[etok]) return S.subjects[etok];
      } else if (gt >= 0 && S.overall) {
        var otok = S.overall[String(gt)];
        if (otok && S.subjects[otok]) return S.subjects[otok];
      }
      return S.default || null;
    }
    function statueEntryGL(b) {
      if (!buildingMap || !b || b.type !== "Statue") return null;
      // Stage 0 falls through to the flat construction cell; every stage but the finished one is blank.
      if (typeof b.stage === "number" && isFinite(b.stage)) {
        var stage = b.stage | 0;
        if (stage === 0) return null;
        if (stage !== 1) return { hidden: true };
      }
      var S = buildingMap.statues;
      if (!S || !S.sheet || !S.pedestal) return null;
      // The statue's OWN stone (b.smt/b.smi); the header material is only the pre-DLL fallback.
      var mat = (typeof b.smt === "number") ? { mat_type: b.smt, mat_index: b.smi } : b;
      var mc = matFamilyForItemGL(mat) || "STONE";
      var q = (typeof b.sq === "number") ? b.sq : 0;
      var row = S.pedestal[mc] || S.pedestal.STONE;
      var ped = row && row.length ? row[Math.min(Math.max(q, 0), row.length - 1)] : null;
      if (!ped) return null;
      var e = { sheet: S.sheet, w: 1, h: 1, cells: [[ped]] };
      var subj = statueSubjectGL(S, b);
      if (subj && subj.top && subj.bottom) {
        var ssheet = subj.sheet || S.sheet;
        e.overlaySheet = ssheet;
        e.overlay = [[subj.bottom]];
        e.overlayTint = true;
        e.overhangSheet = ssheet;
        e.overhang = [subj.top];
      }
      return e;
    }

    var FURNITURE_MAT_PREF_GL = ["WOOD", "STONE", "METAL", "GLASS", "GEM", "ROPE"];
    function furnitureMaterialKeyGL(variants, b) {
      var family = matFamilyForItemGL(b);
      if (family && variants[family]) return family;
      if (family === "WOOD" && variants.ROPE) return "ROPE";
      for (var i = 0; i < FURNITURE_MAT_PREF_GL.length; i++) {
        if (variants[FURNITURE_MAT_PREF_GL[i]]) return FURNITURE_MAT_PREF_GL[i];
      }
      return Object.keys(variants)[0] || null;
    }
    function furnitureEntryGL(b) {
      if (!buildingMap || !buildingMap.furniture || !b) return null;
      var f = buildingMap.furniture[b.type];
      if (!f || !f.matvariants) return null;
      // One flat construction cell, one finished item-dispatch stage, and no art for every other stage.
      if (typeof b.stage === "number" && isFinite(b.stage)) {
        var stage = b.stage | 0;
        if (stage === 0) return null;
        if (stage !== 1) return { hidden: true };
      }
      var variants = f.matvariants;
      var TV = root.DwfTerrainVariant;
      var state = TV && typeof TV.furnitureStateKey === "function" ? TV.furnitureStateKey(b) : null;
      if (state && f.states && f.states[state]) {
        var sv = f.states[state];
        if (sv.sheet) return { sheet: sv.sheet, w: 1, h: 1, cells: [[sv]] };
        variants = sv;
      }
      var material = furnitureMaterialKeyGL(variants, b);
      var c = material && variants[material];
      if (!c) return null;
      var damage = null;
      if (TV && typeof TV.furnitureQualityArt === "function") {
        var art = TV.furnitureQualityArt(f, material, state, b.cq, b.cw, c);
        c = art.base;
        damage = art.damage;
      }
      var out = { sheet: c.sheet, w: 1, h: 1, cells: [[c]] };
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

    // A deliberate lockstep copy of canvas2d's trackStopEntry() and workshopStageEntry().
    var TRACK_STOP_SHAPE_GL = ["NSWE", "N", "S", "NS", "E", "NE", "SE", "NSE",
      "W", "NW", "SW", "NSW", "WE", "NWE", "SWE", "NSWE"];
    function trackStopEntryGL(b) {
      if (!buildingMap || !b || b.type !== "TrackStop") return null;
      var mask = (typeof b.track === "number") ? (b.track & 15) : 15;
      var material = matFamilyForItemGL(b) === "WOOD" ? "WOOD" : "STONE";
      return buildingMap["TRACK_STOP_" + material + "_" + TRACK_STOP_SHAPE_GL[mask]] || null;
    }
    function shiftBuildingEntryGL(entry, dx) {
      var out = Object.assign({}, entry);
      var shiftCell = function (c) { return c ? Object.assign({}, c, { col: c.col + dx }) : c; };
      var shiftGrid = function (grid) { return grid && grid.map(function (row) { return row.map(shiftCell); }); };
      if (entry.cells) out.cells = shiftGrid(entry.cells);
      if (entry.overhang) out.overhang = entry.overhang.map(shiftCell);
      if (entry.overlay) out.overlay = shiftGrid(entry.overlay);
      if (entry.overlayOverhang) out.overlayOverhang = entry.overlayOverhang.map(shiftCell);
      return out;
    }
    function workshopStageEntryGL(b, entry) {
      if (!entry || !b || (b.type !== "Workshop" && b.type !== "Furnace" && b.type !== "TradeDepot")) return entry;
      if (typeof b.stage !== "number" || !isFinite(b.stage)) return entry;
      var stage = b.stage | 0;
      if (stage < 0 || stage > 3) return Object.assign({}, entry, { cells: entry.cells.map(function (row) { return row.map(function () { return null; }); }), overhang: null, overlay: null, overlayOverhang: null });
      if (b.type === "Workshop" && (b.subtype === 17 || b.subtype === 22)) {
        if (stage > 1) return Object.assign({}, entry, { cells: entry.cells.map(function (row) { return row.map(function () { return null; }); }), overhang: null, overlay: null, overlayOverhang: null });
        return stage === 0 ? shiftBuildingEntryGL(entry, -entry.cells[0][0].col) : entry;
      }
      return shiftBuildingEntryGL(entry, (3 - stage) * entry.w);
    }

    var BR_RETRACT_GL = -1, BR_LEFT_GL = 0, BR_RIGHT_GL = 1, BR_UP_GL = 2, BR_DOWN_GL = 3;
    var BRIDGE_TI_HOLE_GL = 0x3c, BRIDGE_TI_MAX_GL = 0x4c;
    function bridgeTileIndexGL(dir, raised, rx1, rx2, ry1, ry2, x, y) {
      return window.DwfConstructionSelect.bridgeTileIndex(dir, raised, rx1, rx2, ry1, ry2, x, y);
    }
    function bridgeDrawRectGL(dir, raised, w, h) {
      var rx1 = 0, rx2 = w - 1, ry1 = 0, ry2 = h - 1;
      if (raised) {
        if (dir === BR_LEFT_GL) rx2 = rx1;
        else if (dir === BR_RIGHT_GL) rx1 = rx2;
        else if (dir === BR_UP_GL) ry2 = ry1;
        else if (dir === BR_DOWN_GL) ry1 = ry2;
      }
      return [rx1, rx2, ry1, ry2];
    }
    function bridgeEntryGL(b) {
      if (!buildingMap || !buildingMap.bridges || !b || b.type !== "Bridge" ||
          typeof b.dir !== "number" || typeof b.bst !== "number") return null;
      var variants = buildingMap.bridges;
      var material = furnitureMaterialKeyGL(variants, b);
      var map = material && variants[material];
      var w = b.x2 - b.x1 + 1, h = b.y2 - b.y1 + 1;
      if (!map || w < 1 || h < 1) return null;
      var dirCode = b.dir | 0;
      if (dirCode < BR_RETRACT_GL || dirCode > BR_DOWN_GL) return null;
      var raised = !!(b.bst & 1);
      if (dirCode === BR_RETRACT_GL && raised) return { hidden: true };
      var anchor = map.NS_CENTER;
      if (!anchor || typeof anchor.col !== "number" || !anchor.sheet) return null;

      var rect = bridgeDrawRectGL(dirCode, raised, w, h);
      var rx1 = rect[0], rx2 = rect[1], ry1 = rect[2], ry2 = rect[3];
      var cells = [];
      var drew = false;
      for (var y = 0; y < h; y++) {
        var row = [];
        for (var x = 0; x < w; x++) {
          var inRect = x >= rx1 && x <= rx2 && y >= ry1 && y <= ry2;
          var ti = inRect ? bridgeTileIndexGL(dirCode, raised, rx1, rx2, ry1, ry2, x, y) : null;
          if (ti === null) { row.push(null); continue; }
          if (ti === BRIDGE_TI_HOLE_GL || ti < 0 || ti > BRIDGE_TI_MAX_GL) return null;
          row.push({
            col: anchor.col, row: window.DwfConstructionSelect.bridgeSheetRow(ti),
          });
          drew = true;
        }
        cells.push(row);
      }
      if (!drew) return { hidden: true };
      return { sheet: anchor.sheet, w: w, h: h, cells: cells };
    }

    // Stage-correct siege art, mirroring canvas2d's siegeEngineEntry() exactly -- same token table and
    // the same built/stage gating. Do not re-derive the mechanism here.
    var CATAPULT_CONST_FRAMES_GL = ["CATAPULT_CONST_0", "CATAPULT_CONST_1", "CATAPULT_CONST_2", "CATAPULT_CONST_3"];
    var SIEGE_DIR_GL = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    var SIEGE_KIND_GL = ["CATAPULT", "BALLISTA", "BOLT_THROWER"];
    function siegeEngineTokenGL(b) {
      if (!b || b.type !== "SiegeEngine" || typeof b.dir !== "number" || typeof b.bextra !== "number") return null;
      var kind = SIEGE_KIND_GL[b.bextra & 0xff], dir = SIEGE_DIR_GL[b.dir & 7];
      if (!kind || !dir) return null;
      if (kind !== "BOLT_THROWER" && b.built === false) {
        var stage = (typeof b.stage === "number" && isFinite(b.stage)) ? (b.stage | 0) : 0;
        return kind + "_CONST_" + Math.max(0, Math.min(3, stage));
      }
      if (kind === "BOLT_THROWER") return "BOLT_THROWER_" + ((b.bst & 1) ? "FIRING_" : "READY_") + dir;
      return kind + "_" + dir + ((b.bst & 1) ? "_FIRING" : "");
    }
    function siegeEngineEntryGL(b) {
      var token = siegeEngineTokenGL(b), base = token && buildingMap && buildingMap[token];
      if (!base) return null;
      var ammoLevel = b && typeof b.bextra === "number" ? ((b.bextra >>> 8) & 7) : 0;
      if (token.indexOf("BOLT_THROWER_") !== 0 || ammoLevel < 1) return base;
      var ammo = buildingMap["BOLT_THROWER_AMMO_" + SIEGE_DIR_GL[b.dir & 7]];
      if (!ammo) return base;
      var choices = [ammo.overhang && ammo.overhang[0]].concat((ammo.cells || []).map(function(row) { return row && row[0]; }));
      var cell = choices[Math.min(5, ammoLevel) - 1];
      return cell ? Object.assign({}, base, { overlaySheet: ammo.sheet, overlay: [[cell]] }) : base;
    }
    function trapEntryGL(b) {
      if (!b || b.type !== "Trap" || typeof b.dir !== "number") return null;
      var delayed = !!(b.bst & 1);
      if (b.built === false) return null;
      if (b.dir === 0) return buildingMap[delayed ? "LEVER_PULLED" : "LEVER_SET"] || null;
      if (b.dir === 1) {
        var flags = (typeof b.bextra === "number") ? b.bextra : 0;
        var suffix = (flags & 4) ? "_MAGMA" : (flags & 2) ? "_WATER" : (flags & 32) ? "_MINECART" : "";
        return buildingMap[(delayed ? "TRAP_PLATE_PRESSED" : "TRAP_PLATE_READY") + suffix] || null;
      }
      if (b.dir === 2 || b.dir === 3) {
        var family = b.dir === 2 ? "TRAP_CAGE" : "TRAP_STONE";
        var base = buildingMap[family + (delayed ? "_UNLOADED" : "")];
        var top = !delayed && buildingMap[family + "_TOP"];
        return base && top ? Object.assign({}, base, { overhang: [top.cells[0][0]], overhangSheet: top.sheet }) : base || null;
      }
      return null;
    }

    // A deliberate GL mirror of wagonEntry and supportEntry.
    var WAGON_DIR_GL = ["BLD", "N", "S", "W", "E"];
    function wagonEntryGL(b) {
      if (!b || b.type !== "Wagon" || !buildingMap || !buildingMap.wagons ||
          typeof b.dir !== "number" || typeof b.bst !== "number") return null;
      var direction = WAGON_DIR_GL[b.dir | 0];
      var family = direction && buildingMap.wagons[direction];
      var body = family && buildingMap[family.body];
      if (!body) return null;
      var goods = Math.max(0, Math.min(7, b.bst | 0));
      var overlay = goods && family.goods && family.goods[goods];
      if (!overlay) return body;
      return Object.assign({}, body, {
        overlaySheet: overlay.sheet,
        overlay: overlay.overlay,
        overlayOverhang: overlay.overlayOverhang,
      });
    }
    function supportEntryGL(b) {
      if (!b || b.type !== "Support" || !buildingMap) return null;
      var family = matFamilyForItemGL(b);
      var token = family === "METAL" ? "BLD_SUPPORT_METAL" :
                  family === "WOOD" ? "BLD_SUPPORT_WOOD" : "BLD_SUPPORT_STONE";
      return buildingMap[token] || null;
    }

    function buildingEntryGL(b) {
      if (!buildingMap) return MISSING_BUILDING;
      var type = (b && b.type) || "";
      var st = (b && typeof b.subtype === "number") ? b.subtype : -1;
      // Stage-correct siege art, before the flat-key ladder can swallow it.
      var siege = siegeEngineEntryGL(b);
      if (siege) return siege;
      var trackStop = trackStopEntryGL(b);
      if (trackStop) return trackStop;
      var bridge = bridgeEntryGL(b);
      if (bridge) return bridge;
      var wagon = wagonEntryGL(b);
      if (wagon) return wagon;
      var support = supportEntryGL(b);
      if (support) return support;
      var trap = trapEntryGL(b);
      if (trap) return trap;
      // planned/in-progress constructions draw DF's authored preview art.
      var pc = plannedConstructionEntryGL(b);
      if (pc) return pc;
      var furniture = furnitureEntryGL(b);
      if (furniture) return furniture;
      var cands = [];
      if (type === "Workshop" && st >= 0 && st < WORKSHOP_SUBTYPE.length) {
        var stName = WORKSHOP_SUBTYPE[st];
        if (stName === "Custom") {
          var ce = customWorkshopEntryGL(b);
          if (ce) return ce;
        }
        cands.push("Workshop:" + stName);
      }
      if (type === "Furnace" && st >= 0 && st < FURNACE_SUBTYPE.length) cands.push("Furnace:" + FURNACE_SUBTYPE[st]);
      if (type) { cands.push(type + ":" + st); cands.push(type); }
      for (var i = 0; i < cands.length; i++) {
        if (cands[i] && buildingMap[cands[i]]) return workshopStageEntryGL(b, buildingMap[cands[i]]);
      }
      return MISSING_BUILDING;
    }
    var WINDMILL_DIR8_GL = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    var SCREWPUMP_DIR4_GL = ["N", "E", "S", "W"];
    function machineFamilyKeyGL(b) {
      var dir = (typeof b.dir === "number") ? b.dir : 0;
      switch (b.type) {
        case "ScrewPump": return "SCREWPUMP_" + SCREWPUMP_DIR4_GL[dir & 3];
        case "WaterWheel": return dir ? "WATER_WHEEL_NS" : "WATER_WHEEL_WE";
        case "AxleHorizontal": return dir ? "AXLE_HORIZONTAL_NS" : "AXLE_HORIZONTAL_WE";
        case "AxleVertical": return "AXLE_VERTICAL";
        case "GearAssembly": return "GEAR_ASSEMBLY";
        case "Windmill": return "WINDMILL_" + WINDMILL_DIR8_GL[dir & 7];
        default: return null;
      }
    }
    function machineTrackSuffixGL(mask) {
      var s = "";
      if (mask & 1) s += "N"; if (mask & 2) s += "S";
      if (mask & 8) s += "W"; if (mask & 4) s += "E";
      return s || "NSWE";
    }
    function machineLayerGridGL(w, h) {
      var grid = [];
      for (var y = 0; y < h; y++) {
        var row = [];
        for (var x = 0; x < w; x++) row.push(null);
        grid.push(row);
      }
      return grid;
    }
    function barsVerticalEntryGL(b, map) {
      var table = map && map.machine_variants && map.machine_variants.bars_vertical;
      if (!b || b.type !== "BarsVertical" || !table) return null;
      // `blayer` is the oracle/test seam for the twelve native compositor arms; live AUX has the gate state.
      var key = (typeof b.blayer === "string") ? b.blayer : ((b.bst & 1) ? "N_SIGNPOST" : "FLOOR");
      var src = table[key];
      if (!Array.isArray(src) || src.length === 0) return null;
      var e = { sheet: src[0].sheet, w: 1, h: 1,
        cells: [[{ col: src[0].col, row: src[0].row }]] };
      if (src.length > 1) {
        e.layers = src.slice(1).map(function (c) {
          return { sheet: c.sheet, tint: true, cells: [[{ col: c.col, row: c.row }]] };
        });
      }
      return e;
    }
    function rollerEntryGL(b, map, frameParity, tileLookup) {
      var table = map && map.machine_variants && map.machine_variants.rollers;
      if (!b || b.type !== "Rollers" || !table) return null;
      var material = (matFamilyForItemGL(b) === "WOOD") ? "WOOD" : "STONE";
      var fallbackMask = ((b.dir | 0) & 1) ? 12 : 3; // E/W drive -> WE rail; N/S -> NS.
      var tile = (typeof tileLookup === "function") ? tileLookup(b.x1, b.y1) : null;
      var liveMask = tile ? constructionTrackMask(tile.ttname) : 0;
      var mask = (typeof b.track === "number") ? b.track : (liveMask || fallbackMask);
      var shape = machineTrackSuffixGL(mask);
      var fam = table[material] && table[material][shape];
      if (!fam || !Array.isArray(fam.frames)) return null;
      var active = (typeof b.bst === "number") && (b.bst & 1);
      var fi = active
        ? ((((frameParity | 0) % fam.frames.length) + fam.frames.length) % fam.frames.length)
        : 0;
      var c = fam.frames[fi] || fam.frames[0];
      return c ? { sheet: fam.sheet, w: 1, h: 1,
        cells: [[{ col: c.col, row: c.row }]] } : null;
    }
    function machineEntryGL(b, map, frameParity, tileLookup) {
      if (!b || !map) return null;
      var bars = barsVerticalEntryGL(b, map); if (bars) return bars;
      var rollers = rollerEntryGL(b, map, frameParity, tileLookup); if (rollers) return rollers;
      if (!map.machines || !MACHINE_TYPES_GL[b.type]) return null;
      var key = machineFamilyKeyGL(b);
      var fam = key && map.machines[key];
      if (!fam || !Array.isArray(fam.frames) || fam.frames.length === 0) return null;
      var active = (typeof b.bst === "number") && (b.bst & 1);
      var fi = active
        ? (((frameParity | 0) % fam.frames.length + fam.frames.length) % fam.frames.length)
        : 0;
      var frame = fam.frames[fi] || fam.frames[0];
      if (!Array.isArray(frame) || frame.length === 0) return null;
      var fpw = Math.max(1, (b.x2 | 0) - (b.x1 | 0) + 1);
      var placed = [];
      var gw = 1, gh = 1;
      for (var i = 0; i < frame.length; i++) {
        var c = frame[i], sub = c.sub || [], dx, dy;
        if (sub.length >= 2) { dx = sub[0] | 0; dy = sub[1] | 0; }
        else if (sub.length === 1) {
          var index = sub[0] | 0;
          dx = index % fpw; dy = Math.floor(index / fpw);
        } else { dx = 0; dy = 0; }
        if (dx + 1 > gw) gw = dx + 1;
        if (dy + 1 > gh) gh = dy + 1;
        placed.push({ dx: dx, dy: dy, col: c.col, row: c.row });
      }
      var cells = machineLayerGridGL(gw, gh);
      for (var pi = 0; pi < placed.length; pi++) {
        var p0 = placed[pi];
        cells[p0.dy][p0.dx] = { col: p0.col, row: p0.row };
      }
      var e = { sheet: fam.sheet, w: gw, h: gh, cells: cells };
      var companions = map.machine_variants && map.machine_variants.companions;
      var layerKey = companions && companions[key];
      var layerAt = 0;
      if (b.type === "ScrewPump") {
        layerKey = companions && companions.SCREWPUMP;
        var hasAxle = (typeof b.maxle === "boolean") ? b.maxle : b.built !== false;
        var pumpDir = key.slice("SCREWPUMP_".length);
        if (!hasAxle || pumpDir === "S") layerKey = null; // S has no secondary-axle compositor arm.
        else layerAt = (pumpDir === "E") ? 0 : 1;         // E:first tile; N/W:second tile.
      }
      var layerFam = layerKey && map.machines[layerKey];
      var layerFrame = layerFam && layerFam.frames && (layerFam.frames[fi] || layerFam.frames[0]);
      if (Array.isArray(layerFrame) && layerFrame.length) {
        var grid = machineLayerGridGL(gw, gh);
        var layerX = layerAt % fpw, layerY = Math.floor(layerAt / fpw);
        if (grid[layerY] && layerX < grid[layerY].length) {
          grid[layerY][layerX] = { col: layerFrame[0].col, row: layerFrame[0].row };
        }
        e.layers = [{ sheet: layerFam.sheet, tint: false, cells: grid }];
      }
      return e;
    }
    // FARM PLOTS, mirroring canvas2d's farmPlotEntry exactly: a furrowed-soil bed when fallow and
    // FARMPLOT_PLANTED when a crop is set. building_map.json's null-cell FarmPlot entry is bypassed.
    var FARM_EMPTY = 0xFFFF;
    function farmCellRefGL(token) {
      var s = spriteMap && spriteMap[token];
      return (s && s.sheet) ? s : null;
    }
    function farmPlotEntryGL(b) {
      if (!b || b.type !== "FarmPlot" || !spriteMap) return null;
      var hasExtra = typeof b.bextra === "number";
      var planted = hasExtra && b.bextra !== FARM_EMPTY;
      if (planted) {
        var p = farmCellRefGL("FARMPLOT_PLANTED") || farmCellRefGL("FARMPLOT") || farmCellRefGL("FURROWED_SOIL_1");
        if (!p) return null;
        return { sheet: p.sheet, w: 1, h: 1, cells: [[{ col: p.col, row: p.row }]] };
      }
      var fur = [];
      for (var i = 1; i <= 4; i++) { var c = farmCellRefGL("FURROWED_SOIL_" + i); if (c) fur.push(c); }
      if (!fur.length) {
        var f = farmCellRefGL("FARMPLOT");
        if (!f) return null;
        return { sheet: f.sheet, w: 1, h: 1, cells: [[{ col: f.col, row: f.row }]] };
      }
      var x1 = b.x1 | 0, y1 = b.y1 | 0;
      var w = Math.max(1, (b.x2 | 0) - x1 + 1), h = Math.max(1, (b.y2 | 0) - y1 + 1);
      var cells = [];
      for (var y = 0; y < h; y++) {
        var row = [];
        for (var x = 0; x < w; x++) { var fc = fur[hashXY(x1 + x, y1 + y) % fur.length]; row.push({ col: fc.col, row: fc.row }); }
        cells.push(row);
      }
      return { sheet: fur[0].sheet, w: w, h: h, cells: cells };
    }
    function farmCropPlansGL(view) {
      var policy = (typeof DwfFarmCrops !== "undefined") ? DwfFarmCrops : null;
      return policy && typeof policy.collect === "function"
        ? policy.collect((view && view.tiles) || [], (view && view.width) | 0,
          (view && view.height) | 0, plantMap)
        : [];
    }
    function emitFarmCrops(view) {
      var plans = farmCropPlansGL(view);
      for (var i = 0; i < plans.length; i++) {
        var p = plans[i], c = p.cell, ac = atlas.resolve(c.sheet, c.col, c.row);
        if (ac) emit(p.gx, p.gy, ac, 255, 255, 255, 255, 0);
      }
    }
    function paintFarmLayers(paintBuildings, paintCrops) {
      var policy = (typeof DwfFarmCrops !== "undefined") ? DwfFarmCrops : null;
      if (policy && typeof policy.paintAboveBuildings === "function")
        policy.paintAboveBuildings(paintBuildings, paintCrops);
      else { paintBuildings(); paintCrops(); }
    }
    // Per-buildScene machine animation parity, ~2 Hz; frozen to 0 under the freeze seam.
    var machineParity = 0;
    function emitBuilding(b, ox, oy, camZ, tileLookup) {
      if (!b || isOverlayOnlyBuildingType(b.type) || !atlas) return;
      var x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2;
      if (typeof x1 !== "number" || typeof y1 !== "number" ||
        typeof x2 !== "number" || typeof y2 !== "number") return;
      var bdz = (typeof b.z === "number" && typeof camZ === "number") ? b.z - camZ : 0;
      // Buildings use the raw terrain fog ladder -- never the unit readability floor. Off-z is dropped
      // unless the server tagged the building visible through an open column below the camera.
      var seeDownB = !!b.sd && bdz < 0;
      if (bdz !== 0 && !seeDownB) return;
      var bAlpha = seeDownB ? belowAlpha(-bdz) : 1;
      var a255 = Math.max(0, Math.min(255, Math.round(bAlpha * 255)));
      var bPalRow = pickBuildingPalRow(b, materialMap);
      var e = machineEntryGL(b, buildingMap, machineParity, tileLookup) || farmPlotEntryGL(b)
            || statueEntryGL(b) || buildingEntryGL(b);   // statues are a 3-cell composite
      if (!e || !e.sheet) return;
      // A statue's SUBJECT cells can sit on a different sheet than its plinth, so callers may pass one.
      function put(bx, by, col, row, sheet) {
        var sh = sheet || e.sheet, c = 0;
        if (typeof bPalRow === "number" && atlas.resolvePalette) {
          var remap = paletteRemapFor(bPalRow);
          if (remap) c = atlas.resolvePalette(sh, col, row, bPalRow, remap);
        }
        if (!(c > 0)) c = atlas.resolve(sh, col, row);
        if (!c) return;
        emit(bx - ox, by - oy, c, 255, 255, 255, a255, 0);
      }
      if (Array.isArray(e.cells)) {
        var gh2 = e.cells.length;
        var gw2 = e.w || (e.cells[0] ? e.cells[0].length : 1);
        // Multi-cell art SMALLER than the footprint is CENTERED and the flanking tiles stay bare; a 1x1
        // entry keeps the pattern-stamp repeat that bridges rely on.
        var bfw = x2 - x1 + 1, bfh = y2 - y1 + 1;
        var multiCell = (gw2 > 1 || gh2 > 1);
        var offX = (multiCell && gw2 < bfw) ? ((bfw - gw2) >> 1) : 0;
        var offY = (multiCell && gh2 < bfh) ? ((bfh - gh2) >> 1) : 0;
        for (var by = y1; by <= y2; by++) {
          var ry = by - y1 - offY;
          if (multiCell && gh2 < bfh && (ry < 0 || ry >= gh2)) continue;
          if (ry >= gh2) ry = gh2 - 1; if (ry < 0) ry = 0;
          var rowArr = e.cells[ry];
          if (!rowArr) continue;
          for (var bx = x1; bx <= x2; bx++) {
            var rx = bx - x1 - offX;
            if (multiCell && gw2 < bfw && (rx < 0 || rx >= gw2)) continue;
            if (rx >= gw2) rx = gw2 - 1; if (rx < 0) rx = 0;
            // An EXPLICIT null cell draws nothing and must NOT be edge-clamped back to the row's last cell;
            // a MISSING index still clamps.
            var cd = rowArr[rx] !== undefined ? rowArr[rx] : rowArr[rowArr.length - 1];
            if (cd) {
              put(bx, by, cd.col, cd.row);
              if (e.overlay && e.overlaySheet) {
                var orow = e.overlay[ry];
                var ocd = orow && (orow[rx] || orow[orow.length - 1]);
                if (ocd) {
                  if (e.overlayTint) {
                    put(bx, by, ocd.col, ocd.row, e.overlaySheet);
                  } else {
                    var oc = atlas.resolve(e.overlaySheet, ocd.col, ocd.row);
                    if (oc) emit(bx - ox, by - oy, oc, 255, 255, 255, a255, 0);
                  }
                }
              }
              // multi-plane machine and bar composites (canvas2d parity)
              if (Array.isArray(e.layers)) {
                for (var li = 0; li < e.layers.length; li++) {
                  var layer = e.layers[li];
                  var lrow = layer && layer.cells && layer.cells[ry];
                  var lcd = lrow && (lrow[rx] || lrow[lrow.length - 1]);
                  if (!lcd || !layer.sheet) continue;
                  if (layer.tint) put(bx, by, lcd.col, lcd.row, layer.sheet);
                  else {
                    var lc = atlas.resolve(layer.sheet, lcd.col, lcd.row);
                    if (lc) emit(bx - ox, by - oy, lc, 255, 255, 255, a255, 0);
                  }
                }
              }
            }
          }
        }
        if (Array.isArray(e.overhang)) {
          var ow = e.overhang.length;
          // Align the overhang with the (possibly centred) art: one row above the ART's own top row.
          var ohy = y1 + offY - 1;
          for (var obx = x1; obx <= x2; obx++) {
            var orx = obx - x1 - offX;
            if (multiCell && ow < bfw && (orx < 0 || orx >= ow)) continue;
            if (orx >= ow) orx = ow - 1; if (orx < 0) orx = 0;
            var ocell = e.overhang[orx];
            if (!ocell) continue;
            // `overhangSheet` is optional: a creature statue's TOP cell sits on its own page, not the base sheet.
            put(obx, ohy, ocell.col, ocell.row, e.overhangSheet);
            if (Array.isArray(e.overlayOverhang) && e.overlaySheet) {
              var oov = e.overlayOverhang[orx];
              if (oov) {
                var ooc = atlas.resolve(e.overlaySheet, oov.col, oov.row);
                if (ooc) emit(obx - ox, ohy - oy, ooc, 255, 255, 255, a255, 0);
              }
            }
          }
        }
      } else if (typeof e.col === "number") {
        for (var by2 = y1; by2 <= y2; by2++) {
          for (var bx2 = x1; bx2 <= x2; bx2++) put(bx2, by2, e.col, e.row);
        }
      }
    }

    function resolveLiquidCell(t) {
      if (t.hidden) return 0;
      var flow = t.flow || 0;
      var liquid = t.liquid || "none";
      if (flow <= 0 || (liquid !== "water" && liquid !== "magma") || !atlas) return 0;
      var e = liquidCellFor(liquid, flow);
      if (!e) return 0;
      var c = atlas.resolve(e.sheet, e.col, e.row);
      return (c > 0) ? c : 0;
    }

    // ---- shore foam synthesis ------------------------------------------------------
    function emitShoreFoam(t, gx, gy, lookupTile, attr) {
      if (!atlas) return;
      var tokens = liquidEdgeTokens(t, gx, gy, lookupTile, Adj);
      if (lookupTile && lookupTile.incomplete) return;
      for (var i = 0; i < tokens.length; i++) {
        var c = tokenCell(tokens[i]);
        if (c) emitSprite(gx, gy, c, attr || 0);
      }
    }

    // Base fill colour, or null to leave the background.
    function tileColor(t, skipLiquidColor) {
      var tt = (typeof t.tt === "number") ? t.tt : -1;
      if (tt < 0) return null;
      if (t.hidden) return HIDDEN_COLOR;
      if (!skipLiquidColor) {
        var flow = t.flow || 0, liquid = t.liquid || "none";
        if (flow > 0 && liquid === "magma") return magmaRgb(flow);
        if (flow > 0 && liquid === "water") return waterRgb(flow);
      }
      var shape = t.shape || "NONE", mat = t.mat || "NONE";
      var base = matRgb(mat);
      // TREE/MUSHROOM WALL is a trunk or cap, not stone: keep its natural wood base.
      if (shape === "WALL" || shape === "FORTIFICATION") {
        if (isTreeWallMat(mat)) return base;
        // The wall's installed hidden-rock underlay owns transparent face pixels; keep the fallback dark
        // if that texture is not ready.
        if (shape === "WALL" && wallMaterialGL(t)) return HIDDEN_COLOR;
        var cr = wallMaterialRgbGL(t);
        if (cr) return darken(cr, WALL_DARKEN);
        return darken(base, WALL_DARKEN);
      }
      // RampTop/RAMPSPACE is open AIR, not a teal terrain cell.
      if (shape === "EMPTY" || shape === "NONE" || shape === "RAMP_TOP") return null;
      return base;
    }

    function resolveShadowCell(table, mask8) {
      if (!shadowCellMap || !spriteMap) return 0;
      var tbl = shadowCellMap[table];
      var tok = tbl && tbl[String(mask8)];
      if (!tok) return 0;
      return tokenCell(tok);
    }

    // 8-bit neighbour mask from a precomputed boolean grid, in dwf-adjacency.js's DELTA/BIT order.
    // Bit order MUST stay in step with Adj.computeMask8, or wall-join and shadow tables pick the wrong cell.
    function maskFromGrid(grid, gx, gy, gw, gh) {
      var m = 0;
      var north = gy > 0, south = gy < gh - 1, west = gx > 0, east = gx < gw - 1;
      var row = gy * gw, rowN = row - gw, rowS = row + gw;
      if (north && grid[rowN + gx]) m |= 1;                  // N
      if (south && grid[rowS + gx]) m |= 2;                  // S
      if (west && grid[row + gx - 1]) m |= 4;                // W
      if (east && grid[row + gx + 1]) m |= 8;                // E
      if (north && west && grid[rowN + gx - 1]) m |= 16;     // NW
      if (north && east && grid[rowN + gx + 1]) m |= 32;     // NE
      if (south && west && grid[rowS + gx - 1]) m |= 64;     // SW
      if (south && east && grid[rowS + gx + 1]) m |= 128;    // SE
      return m;
    }

    function grassBackingCellGL(t, gx, gy, lookupTile) {
      if (!lookupTile) return 0;
      var mat = t.mat || "";
      if (mat !== "TREE" && mat !== "MUSHROOM") return 0;
      var shape = t.shape || "";
      if (shape === "EMPTY" || shape === "NONE") return 0;
      for (var i = 0; i < GRASS_BACK_OFFSETS.length; i++) {
        if (isGrassBackingSource(lookupTile(gx + GRASS_BACK_OFFSETS[i][0], gy + GRASS_BACK_OFFSETS[i][1]))) {
          return tokenCell("GRASS_" + ((hashXY(gx, gy) & 3) + 1));
        }
      }
      return 0;
    }

    function groundBackingCellGL(t, gx, gy, lookupTile) {
      if (t.plant && t.grass && t.grass.amount > 0) {
        var own = resolveGrassSprite(t.grass.id, gx, gy, t.ttname, true);
        return own ? { cell: own.cell, wash: own.tintName === "grassSummer" } : null;
      }
      var gb = grassBackingCellGL(t, gx, gy, lookupTile);
      if (gb) return { cell: gb, wash: true };
      if ((t.shape || "") !== "BOULDER") return null;
      var grassCell = function (id) {
        var p = resolveGrassSprite(id, gx, gy, t.ttname);
        return p ? { cell: p.cell, wash: p.tintName === "grassSummer" } : null;
      };
      if (t.grass && t.grass.amount > 0) return grassCell(t.grass.id); // (1) true floor: grass
      if (!t.grass && lookupTile) {                                 // (2) ring-1 borrow
        for (var i = 0; i < GRASS_BACK_OFFSETS.length; i++) {
          if (isGrassBackingSource(lookupTile(gx + GRASS_BACK_OFFSETS[i][0], gy + GRASS_BACK_OFFSETS[i][1]))) {
            return grassCell();
          }
        }
      }
      var fc = tokenCell("STONE_FLOOR_5");                          // (3) rough stone floor
      return (fc > 0) ? { cell: fc, wash: false } : null;
    }

    function wallJoinCell(t, openMask, gx, gy, drawZ) {
      if (!spriteMap || (t.shape || "") !== "WALL" || !Adj) return 0;
      if (isTreeWallMat(t.mat || "")) return 0;  // trunk/cap keeps its round emitTree cell, no stone edge
      var infix = Adj.wallCellSuffix(openMask);
      if (!infix) return 0;
      // Player-smoothed and worn walls use DF's detailed-wall family; rough walls keep the natural one.
      var base = (wallDetailPrefix(t) || roughInorganicWallPrefixGL(t)
        || wallPrefix(t.mat || "", t.base_mt)) + "_" + infix;
      // constructed and natural stone/soil/mineral faces share the raw-derived row.
      var palRow = wallJoinPalRowGL(t);
      var v = roughWallVariantGL(gx, gy, t, drawZ) + 1;
      var cands = [base + "_" + v, base + "_1", base];
      for (var i = 0; i < cands.length; i++) {
        var tok = cands[i];
        if (typeof palRow === "number" && atlas) {
          var entry = TOKEN_CELL_OVERRIDE[tok] || (spriteMap && spriteMap[tok]);
          if (entry && entry.sheet) {
            var remap = paletteRemapFor(palRow);
            var pc = remap ? atlas.resolvePalette(entry.sheet, entry.col, entry.row, palRow, remap) : 0;
            if (pc > 0) return pc;
            var fc = atlas.resolve(entry.sheet, entry.col, entry.row); // graceful transient (sheet decoding)
            if (fc > 0) return fc;
          }
        }
        var c = tokenCell(tok);
        if (c) return c;
      }
      return 0;
    }

    var ENG_FLOOR = 0x0001, ENG_HIDDEN = 0x0020;
    function engravingWallPlanGL(t, mask) {
      var token = Adj.engravingWallToken(mask);
      return token ? { token: token, palRow: wallJoinPalRowGL(t) } : null;
    }
    function engravingFloorPlanGL(t) {
      var m = wallMaterialGL(t);
      if (m && typeof m.palRow === "number") {
        return { token: "FLOOR_STONE_ENGRAVED_PALETTE", palRow: m.palRow };
      }
      return { token: "FLOOR_STONE_ENGRAVED_NON_PALETTE", palRow: null };
    }
    function emitEngraving(t, gx, gy, seeDownAttr) {
      var hits = t.engravings;
      if (!hits || !hits.length) return;
      var mask = 0;
      for (var i = 0; i < hits.length; i++) mask |= (hits[i].eflags & 0x03ff);
      if (mask & ENG_HIDDEN) return; // DF hides the decoration
      if (mask & ENG_FLOOR) {
        var fp = engravingFloorPlanGL(t), fc = 0;
        if (typeof fp.palRow === "number" && atlas) {
          var fe = TOKEN_CELL_OVERRIDE[fp.token] || (spriteMap && spriteMap[fp.token]);
          if (fe && fe.sheet) {
            var fremap = paletteRemapFor(fp.palRow);
            fc = fremap ? atlas.resolvePalette(fe.sheet, fe.col, fe.row, fp.palRow, fremap) : 0;
          }
        }
        if (!fc) fc = tokenCell(fp.token);
        if (fc) emitSprite(gx, gy, fc, seeDownAttr);
      }
      var plan = engravingWallPlanGL(t, mask);
      if (plan) {
        var wc = 0;
        if (typeof plan.palRow === "number" && atlas) {
          var entry = TOKEN_CELL_OVERRIDE[plan.token] || (spriteMap && spriteMap[plan.token]);
          if (entry && entry.sheet) {
            var remap = paletteRemapFor(plan.palRow);
            wc = remap ? atlas.resolvePalette(entry.sheet, entry.col, entry.row, plan.palRow, remap) : 0;
          }
        }
        if (!wc) wc = tokenCell(plan.token);
        if (wc) emitSprite(gx, gy, wc, seeDownAttr);
      }
    }

    var chunkCacheByZ = null;

    function getChunkCached(z, wx, wy) {
      if (!cacheReader) return null;
      var byKey = chunkCacheByZ.get(z);
      if (!byKey) { byKey = new Map(); chunkCacheByZ.set(z, byKey); }
      var key;
      try { key = cacheReader.chunkKeyFor(wx, wy); } catch (_) { return null; }
      if (byKey.has(key)) return byKey.get(key);
      var c = null;
      try { c = cacheReader.getChunk(z, key) || null; } catch (_) { c = null; }
      byKey.set(key, c);
      return c;
    }

    function decodeRawAt(chunk, wx, wy) {
      var idx = (wy & 15) * 16 + (wx & 15);
      var tt = chunk.tt[idx];
      if (tt === 0xFFFF) return { tt: -1 };
      var m = chunk.mat[idx] | 0;
      var mt = m >> 16, mi = (m << 16) >> 16;
      var b = chunk.bits[idx];
      var liquidCode = b & 3, flow = (b >> 2) & 7, hidden = (b >> 5) & 1, outside = (b >> 6) & 1;
      var meta = tiletypeMeta && tiletypeMeta.get(tt);
      var out = {
        x: wx, y: wy, tt: tt, ttname: meta ? meta.ttname : "", shape: meta ? meta.shape : "", mat: meta ? meta.mat : "",
        flow: flow, liquid: flow > 0 ? (liquidCode === 2 ? "magma" : "water") : "none",
        hidden: !!hidden, outside: outside, base_mt: mt, base_mi: mi,
      };
      copySparseFields(out, chunk, idx);
      return out;
    }

    function copySparseFields(out, chunk, idx) {
      var sp = chunk && chunk.sparse && chunk.sparse.get && chunk.sparse.get(idx);
      if (!sp) return;
      // Field list held in step with dwf-cache.js decodeTile by seedown_sparse_parity_test.
      if (sp.item) out.item = sp.item;
      if (sp.plant) out.plant = sp.plant;
      if (sp.treeGraphics) out.treeGraphics = sp.treeGraphics;
      if (sp.farmCrop) out.farmCrop = sp.farmCrop;
      if (sp.spatterMat) out.spatter = sp.spatterMat;
      if (sp.spatters && sp.spatters.length) out.spatters = sp.spatters;
      else if (sp.spatterMat) out.spatters = [sp.spatterMat];
      if (sp.itemSpatters && sp.itemSpatters.length) out.itemSpatters = sp.itemSpatters;
      if (sp.flow) out.cloud = sp.flow;
      if (sp.grass) out.grass = sp.grass;
      if (sp.engravings && sp.engravings.length) out.engravings = sp.engravings;
      if (sp.desigPriority) out.desigPriority = sp.desigPriority;
      if (sp.vermin && sp.vermin.length) out.vermin = sp.vermin;
      // container representative-content descriptor (contents-peek overlay).
      if (sp.peek) out.peek = sp.peek;
    }

    function descendSeeDown(z, wx, wy) {
      if (!cacheReader || !tiletypeMeta) return null;
      var chunk = getChunkCached(z, wx, wy);
      if (!chunk || chunk.baked !== false) return null; // transitional / unknown: bail, ~free
      var cam = decodeRawAt(chunk, wx, wy);
      if (cam.tt < 0 || cam.hidden || !isOpenTileShapeMat(cam.shape, cam.mat)) return null;
      for (var d = 1; d <= MAX_SEEDOWN_DEPTH; d++) {
        var lz = z - d;
        if (lz < 0) break;
        var lchunk = getChunkCached(lz, wx, wy);
        if (!lchunk) continue;                      // missing lower chunk: keep descending
        var lo = decodeRawAt(lchunk, wx, wy);
        if (lo.tt < 0) continue;                     // void record: keep descending
        if (isOpenTileShapeMat(lo.shape, lo.mat) && !(lo.flow > 0)) continue; // still open: deeper
        return {
          depth: d,
          tile: lo,
        };
      }
      return null;
    }

    var descLookupZ = 0, descLookupOX = 0, descLookupOY = 0, descLookupW = 0, descLookupH = 0;
    function descendedLookup(x, y) {
      if (x < 0 || y < 0 || x >= descLookupW || y >= descLookupH) return null;
      var wx = descLookupOX + x, wy = descLookupOY + y;
      var c = getChunkCached(descLookupZ, wx, wy);
      if (!c) { descendedLookup.incomplete = true; return null; }
      return decodeRawAt(c, wx, wy);
    }
    descendedLookup.incomplete = false;

    function edgeReceiverGL(t) {
      if (!t || t.hidden) return false;
      var s = t.shape || "";
      return s === "FLOOR" || s === "PEBBLES" || s === "BOULDER" ||
        s === "STAIR_UP" || s === "STAIR_DOWN" || s === "STAIR_UPDOWN" || s === "RAMP" ||
        !!t.plant;
    }

    function edgeOvergrowthPlanGL(gx, gy, lookupTile) {
      var Edge = root.DwfEdgeOvergrowth;
      return Edge ? Edge.plan(lookupTile, gx, gy, materialMap) : null;
    }

    function emitEdgeOvergrowth(t, gx, gy, lookupTile, attr) {
      var Edge = root.DwfEdgeOvergrowth;
      if (!Edge || !edgeReceiverGL(t)) return 0;
      var p = edgeOvergrowthPlanGL(gx, gy, lookupTile), count = 0;
      if (!p) return 0;
      for (var i = 0; i < p.draws.length; i++) {
        var q = p.draws[i], art = Edge.artFor(q.code, q.slot);
        // A null block is an honest shipped-art gap; never substitute a nearby atlas cell.
        if (!art) continue;
        var cell = atlas.resolve(art.sheet, art.col, art.row);
        if (cell) { emitSprite(gx, gy, cell, attr); count++; }
      }
      return count;
    }

    function buildTile(t, gx, gy, gw, gh, isWall, isHidden, camZ, lookupTile, isOpen) {
      if (!t) return;
      var seeDownDepth = 0;
      if (cacheReader && typeof t.x === "number" && typeof t.y === "number" && typeof camZ === "number") {
        var desc = descendSeeDown(camZ, t.x, t.y);
        if (desc) {
          descLookupZ = camZ - desc.depth;
          descLookupOX = t.x - gx; descLookupOY = t.y - gy;
          descLookupW = gw; descLookupH = gh;
          descendedLookup.incomplete = false;
          lookupTile = descendedLookup;
          t = desc.tile; seeDownDepth = desc.depth;
        }
      }
      var seeDownAttr = seeDownDepth ? ((seeDownDepth & ATTR_SEEDOWN_MASK) << ATTR_SEEDOWN_SHIFT) : 0;

      var tt = (typeof t.tt === "number") ? t.tt : -1;

      var liquidCell = resolveLiquidCell(t);
      var hasLiquid = liquidCell > 0;
      var col = tileColor(t, hasLiquid);
      // curMapDims is null before the map-dims hello arrives, so until then a tt<0 tile cannot be
      // proved in-bounds and only shipped-hidden tiles hatch.
      var wantsHidden = wantsHiddenHatchGL(t, curMapDims);
      var hiddenWz = (typeof camZ === "number") ? camZ - seeDownDepth : undefined;
      var hiddenCell = wantsHidden ? resolveHiddenCell(t, hiddenWz) : 0;
      var sprite = resolveSprite(t, gx, gy, lookupTile);
      var wallOpenMask = ((t.shape || "") === "WALL" && isOpen)
        ? maskFromGrid(isOpen, gx, gy, gw, gh) : 0;

      var drew = false;
      if (col !== null) {
        var wallBackToken = (!t.hidden && !wantsHidden && !hasLiquid)
          ? wallBackingTokenGL(t, gx, gy, wallOpenMask) : null;
        var wallBackingCell = wallBackToken ? hiddenRockCell(wallBackToken.slice(12) | 0) : 0;
        var gbc = (!wallBackingCell && !t.hidden && !wantsHidden && !hasLiquid && ((t.shape || "") !== "BOULDER" || sprite))
          ? groundBackingCellGL(t, gx, gy, lookupTile) : null;
        if (wallBackingCell) {
          emitSprite(gx, gy, wallBackingCell, seeDownAttr);
        } else if (gbc) {
          emitSprite(gx, gy, gbc.cell, seeDownAttr);
          var gbt = gbc.wash ? TINT_COLORS.grassSummer : null;
          if (gbt) emitSolid(gx, gy, gbt, Math.round(gbt[3] * 255), seeDownAttr);
        } else {
          emitSolid(gx, gy, col, 255, seeDownAttr);
        }
        drew = true;
      } else if (wantsHidden) {
        // Emitted whether or not a speckle follows: without this fill, an in-bounds tile we hold
        // no record for reads as a black void band.
        emitSolid(gx, gy, HIDDEN_COLOR, 255, seeDownAttr);
        drew = true;
      }
      var edgeDrawn = false;
      if (drew && !hasLiquid && overlaysAllowedGL(t) && (t.shape || "") === "BOULDER") {
        emitEdgeOvergrowth(t, gx, gy, lookupTile, seeDownAttr);
        edgeDrawn = true;
      }

      if (hiddenCell) {
        emitSprite(gx, gy, hiddenCell, seeDownAttr); drew = true;
      } else if (hasLiquid) {
        if (sprite) {
          emitSprite(gx, gy, sprite.cell, seeDownAttr | sprite.animAttr);
          var bt = sprite.tintRGBA || (sprite.tintName && TINT_COLORS[sprite.tintName]);
          if (bt) emitSolid(gx, gy, bt, Math.round(bt[3] * 255), seeDownAttr);
          if (sprite.overlay) emitSprite(gx, gy, sprite.overlay, seeDownAttr | sprite.overlayAnimAttr);
        }
        // Native liquid is above bed contamination: emit spatter before the translucent depth cell, then
        // skip it in the sparse tail.
        emitSpatterDecals(t, gx, gy, lookupTile, seeDownAttr);
        emitSprite(gx, gy, liquidCell, seeDownAttr); drew = true;
        // Shore foam is only meaningful on the liquid tile itself, synthesized from water adjacency.
        emitShoreFoam(t, gx, gy, lookupTile, seeDownAttr);
      } else if (sprite) {
        if (sprite.multiplyRgb) emit(gx, gy, sprite.cell, sprite.multiplyRgb[0] | 0, sprite.multiplyRgb[1] | 0, sprite.multiplyRgb[2] | 0, 255, seeDownAttr | sprite.animAttr);
        else emitSprite(gx, gy, sprite.cell, seeDownAttr | sprite.animAttr);
        var tc = sprite.tintRGBA || (sprite.tintName && TINT_COLORS[sprite.tintName]);
        if (tc) emitSolid(gx, gy, tc, Math.round(tc[3] * 255), seeDownAttr);
        if (sprite.overlay) emitSprite(gx, gy, sprite.overlay, seeDownAttr | sprite.overlayAnimAttr);
        drew = true;
      }

      // Edge stamps are a distinct plane above the receiving cell's floor or ramp and below every sparse
      // plane, beginning with spatter. Liquids do not receive them.
      if (!edgeDrawn && drew && !hasLiquid && overlaysAllowedGL(t))
        emitEdgeOvergrowth(t, gx, gy, lookupTile, seeDownAttr);

      if (drew && overlaysAllowedGL(t)) {
        var shape = t.shape || "";
        var isWallShape = shape === "WALL";
        var wallMask = (isWall || isWallShape) ? maskFromGrid(isWall, gx, gy, gw, gh) : 0;

        if (shadowCellMap) {
          if (!isWallShape && shape !== "FORTIFICATION" && shape !== "EMPTY" && shape !== "NONE" && wallMask) {
            var tbl = (shape === "RAMP" || shape === "RAMP_TOP") ? "rampShadowOnRamp" : "wallShadow";
            var sc = resolveShadowCell(tbl, wallMask);
            if (sc) emitSprite(gx, gy, sc, seeDownAttr);
          }
          if (isHidden) {
            var hiddenMask = maskFromGrid(isHidden, gx, gy, gw, gh);
            if (hiddenMask) {
              var vc = resolveShadowCell("visionShadow", hiddenMask);
              if (vc) emitSprite(gx, gy, vc, seeDownAttr);
            }
          }
        }

        emitStockpileFloor(t, gx, gy, seeDownAttr);
        if (!hasLiquid) emitSpatterDecals(t, gx, gy, lookupTile, seeDownAttr);
        emitItemSpatterLitter(t, gx, gy, seeDownAttr);
        emitItem(t, gx, gy, seeDownAttr);
        emitVermin(t, gx, gy, seeDownAttr);
        emitPlant(t, gx, gy, seeDownAttr);
        emitTree(t, gx, gy, lookupTile, seeDownAttr);

        if (isWallShape) {
          // Select from the OPEN-face mask (exposed edges), not the wall-connection mask.
          var wj = wallJoinCell(t, wallOpenMask, gx, gy,
            (typeof camZ === "number") ? camZ - seeDownDepth : undefined);
          if (wj) emitSprite(gx, gy, wj, seeDownAttr);
        }

        // Engraving decoration LAST -- an overlay ON the resolved wall or floor art, as in canvas2d's order.
        emitEngraving(t, gx, gy, seeDownAttr);
        // The rope-and-post BOUNDARY stays above the contents, so a full pile still reads as one region.
        emitStockpileRope(t, gx, gy, seeDownAttr);
      }

      var dv = t.desig ? resolveDesig(t.desig, t) : null;
      if ((t.hidden || (t.shape || "") === "WALL") && dv && dv.cat !== "automine")
        emitSolid(gx, gy, [0, 0, 0], 0, ATTR_ADDITIVE);

      if (dv) desigList.push({ gx: gx, gy: gy, cell: dv.cell, cat: dv.cat, marker: !!t.desig.marker,
                               prio: (t.desigPriority && t.desigPriority.priority) | 0 });
    }

    function emitDesignationOverlay(list, nowMs) {
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        var automine = !e.marker && e.cat === "automine";
        if (!automine) {
          var rgb = e.marker ? MARKER_WASH_RGB : (DESIG_TINT_RGB[e.cat] || DESIG_TINT_RGB.dig);
          var washA = Math.round((e.marker ? DESIG_WASH_ALPHA_MARKER : DESIG_WASH_ALPHA) * 255);
          emitSolid(e.gx, e.gy, rgb, washA, 0);
        }
        if (!atlas || !designationGlyphVisible(e.djobKind, nowMs, e.djobWorker, e.djobActive)) continue;
        var gc = atlas.resolve(DESIG_SHEET, e.cell[0], e.cell[1]);
        if (gc > 0) {
          if (e.marker) emit(e.gx, e.gy, gc, MARKER_GLYPH_TINT[0], MARKER_GLYPH_TINT[1], MARKER_GLYPH_TINT[2], 255, 0);
          else if (automine) emit(e.gx, e.gy, gc, AUTOMINE_SPRITE_TINT[0], AUTOMINE_SPRITE_TINT[1], AUTOMINE_SPRITE_TINT[2], 255, 0);
          else emitSprite(e.gx, e.gy, gc, 0);
        }
        // dig-priority numeral, only when the tail carried a non-default priority (1..7).
        if (e.prio >= 1 && e.prio <= 7) {
          var pc = atlas.resolve(DESIG_PRIORITY_SHEET, 0, e.prio - 1);
          if (pc > 0) emitSprite(e.gx, e.gy, pc, 0);
        }
      }
    }

    function emitMiningIndicators(tiles, gw, gh) {
      if (!toolStateOverlayVisibleGL("mining") || !atlas) return;
      var n = Math.min(tiles.length, gw * gh);
      for (var i = 0; i < n; i++) {
        var cell = miningIndicatorCell(tiles[i], toolStateOverlayVisibleGL("mining"));
        if (!cell) continue;
        var c = atlas.resolve(MINING_SHEET, cell[0], cell[1]);
        if (c > 0) emitSprite(i % gw, (i - (i % gw)) / gw, c, 0);
      }
    }

    function emitPresence(players, ox, oy, camZ, ownName) {
      var list = players || [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || p.name === ownName || typeof p.x !== "number" || typeof p.y !== "number") continue;
        var rgb = playerColorRgb(p.name);
        var sameZ = (typeof p.z !== "number") || p.z === camZ;
        if (p.drag && typeof p.dx === "number" && typeof p.dy === "number") {
          var gx0 = Math.min(p.x, p.dx) - ox, gy0 = Math.min(p.y, p.dy) - oy;
          var gx1 = Math.max(p.x, p.dx) - ox, gy1 = Math.max(p.y, p.dy) - oy;
          var fillA = Math.round((sameZ ? 0.16 : 0.08) * 255);
          var emitted = 0;
          drag:
          for (var ry = gy0; ry <= gy1; ry++) {
            for (var rx = gx0; rx <= gx1; rx++) {
              if (emitted >= PRESENCE_DRAG_MAX_TILES) break drag;
              emitSolid(rx, ry, rgb, fillA, 0);
              emitted++;
            }
          }
        }
        var markA = Math.round((sameZ ? 0.55 : 0.28) * 255);
        emitSolid(p.x - ox, p.y - oy, rgb, markA, 0);
      }
    }

    var wallGrid = null, hiddenGrid = null, openGrid = null, gridN = 0;
    var curMapDims = null;
    function resolveMapDims() {
      if (ctx.mapDims !== undefined) return ctx.mapDims;
      if (cacheReader && typeof cacheReader.mapDims === "function") {
        try { return cacheReader.mapDims(); } catch (_) { return null; }
      }
      return null;
    }
    // Repopulated at the top of every buildScene() call, consumed by emitDesignationOverlay below.
    var desigList = [];
    var ownPlayerName = (ctx.ownPlayerName !== undefined) ? ctx.ownPlayerName : getOwnPlayerName();
    var terrainCount = 0, buildingStart = 0, buildingCount = 0;
    var cropStart = 0, cropCount = 0;
    var overlayStart = 0, overlayCount = 0, staticCount = 0;
    var lastBuildView = null;
    var blinkDjobTiles = new Set();
    // Terrain is retained as independently replaceable 16x16 CPU segments; the flat builder buffer
    // stays the upload shape, recompacted from these bytes in terrainOrder after every patch.
    var terrainSegments = new Map(); // "z:bx:by" -> {bx,by,z,count,bytes,builds}
    var terrainOrder = [];
    function terrainSegmentId(bx, by, z) { return z + ":" + bx + ":" + by; }
    function segmentResolvedCount(bytes, count) {
      var res = 0;
      var u = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
      for (var i = 0; i < count; i++) if (u[i * 8 + 4] !== PENDING) res++;
      return res;
    }
    function segmentFoldTile(h, t) {
      if (!t) return Math.imul(h ^ 254, 16777619) >>> 0;
      var tt = (typeof t.tt === "number" && isFinite(t.tt)) ? t.tt | 0 : -32768;
      h = Math.imul(h ^ (tt & 65535), 16777619) >>> 0;
      h = Math.imul(h ^ (t.hidden ? 1 : 0), 16777619) >>> 0;
      return h >>> 0;
    }
    function rememberTerrainSegment(bx, by, z, start, end, sourceTiles, sourceFingerprint, hiddenTiles) {
      var id = terrainSegmentId(bx, by, z);
      var prev = terrainSegments.get(id);
      var segBytes = new Uint8Array(buf, start * INSTANCE_BYTES, (end - start) * INSTANCE_BYTES).slice();
      terrainSegments.set(id, {
        bx: bx, by: by, z: z, count: end - start,
        bytes: segBytes,
        resolved: segmentResolvedCount(segBytes, end - start),
        // Tiles backed by actual map data; tt<0 placeholder hatches deliberately do not count.
        sourceTiles: sourceTiles || 0,
        sourceFingerprint: sourceFingerprint >>> 0,
        hiddenTiles: hiddenTiles || 0,
        builds: prev ? prev.builds + 1 : 1,
      });
      return id;
    }
    // Aggregate over the segments actually composed into the current static prefix.
    function terrainResolvedStats() {
      var total = 0, res = 0;
      for (var i = 0; i < terrainOrder.length; i++) {
        var s = terrainSegments.get(terrainOrder[i]);
        if (!s) continue;
        total += s.count; res += s.resolved || 0;
      }
      var sourceTiles = 0;
      for (var j = 0; j < terrainOrder.length; j++) {
        var seg = terrainSegments.get(terrainOrder[j]);
        if (seg) sourceTiles += seg.sourceTiles || 0;
      }
      return { total: total, resolved: res, sourceTiles: sourceTiles };
    }
    function terrainSegmentStats() {
      var out = [];
      for (var i = 0; i < terrainOrder.length; i++) {
        var id = terrainOrder[i], seg = terrainSegments.get(id);
        if (!seg) {
          out.push({ id: id, missing: true });
          continue;
        }
        out.push({
          id: id, bx: seg.bx, by: seg.by, z: seg.z,
          count: seg.count, resolved: seg.resolved || 0,
          sourceTiles: seg.sourceTiles || 0,
          sourceFingerprint: seg.sourceFingerprint >>> 0,
          hiddenTiles: seg.hiddenTiles || 0,
          builds: seg.builds || 0,
        });
      }
      return out;
    }
    function buildScene(view) {
      var t0 = now();
      k = 0;
      chunkCacheByZ = new Map(); // fresh per rebuild -- scene-build cadence, never per frame
      curMapDims = resolveMapDims();  // once per rebuild, read by buildTile's base-hatch gate
      desigList = []; // repopulated by this call's buildTile loop, consumed below.
      var gw = view.width | 0, gh = view.height | 0;
      var tiles = (view && view.tiles) || [];
      var total = gw * gh;
      var n = Math.min(tiles.length, total);
      var ox = (view && view.origin && typeof view.origin.x === "number") ? view.origin.x : 0;
      var oy = (view && view.origin && typeof view.origin.y === "number") ? view.origin.y : 0;
      emitOriginX = ox; emitOriginY = oy;
      var camZ = (view && view.origin && typeof view.origin.z === "number") ? view.origin.z : null;
      function lookupTile(x, y) {
        if (x < 0 || y < 0 || x >= gw || y >= gh) return null;
        return tiles[y * gw + x] || null;
      }
      var buildings = buildingsInPaintOrder((view && view.buildings) || []);
      var buildingBudget = 0;
      for (var bb = 0; bb < buildings.length; bb++) {
        var bB = buildings[bb];
        if (!bB || isOverlayOnlyBuildingType(bB.type)) continue;
        var bw = (typeof bB.x2 === "number" && typeof bB.x1 === "number") ? Math.max(1, bB.x2 - bB.x1 + 1) : 1;
        var bh = (typeof bB.y2 === "number" && typeof bB.y1 === "number") ? Math.max(1, bB.y2 - bB.y1 + 1) : 1;
        buildingBudget += bw * bh;
      }
      // Presence budget, on the same pre-pass convention as the building budget; the drag area is capped.
      var players = (view && view.players) || [];
      var presBudget = presenceBudget(players);
      ensureCapacity(total * 34 + 32 + buildingBudget + presBudget);
      var haveHidden = false;
      if (!wallGrid || gridN < total) {
        wallGrid = new Uint8Array(total); hiddenGrid = new Uint8Array(total); openGrid = new Uint8Array(total); gridN = total;
      }
      for (var j = 0; j < n; j++) {
        var tj = tiles[j];
        wallGrid[j] = (tj && tj.shape === "WALL") ? 1 : 0;
        // Share canvas2d's predicate, including tt<0 placeholders, and guard a null Adj in test contexts.
        openGrid[j] = (Adj ? Adj.isOpenNeighbor(tj) : (!!tj && !tj.hidden && tj.shape !== "WALL" && (typeof tj.tt !== "number" || tj.tt >= 0))) ? 1 : 0;
        if (tj && tj.hidden) { hiddenGrid[j] = 1; haveHidden = true; } else hiddenGrid[j] = 0;
      }
      var hg = haveHidden ? hiddenGrid : null; // skip vision-shadow masks entirely with no hidden tiles
      // The stockpile index must exist before the tile loop starts: once per scene build, not per tile.
      rebuildStockpileIndex((view && view.buildings) || [], camZ);
      terrainSegments = new Map();
      terrainOrder = [];
      // Each tile stack is cell-local, so chunks may be row-major while every stack inside a chunk keeps
      // the exact old y/x painter order.
      var bx0 = Math.floor(ox / 16), bx1 = Math.floor((ox + gw - 1) / 16);
      var by0 = Math.floor(oy / 16), by1 = Math.floor((oy + gh - 1) / 16);
      for (var by = by0; by <= by1; by++) {
        for (var bx = bx0; bx <= bx1; bx++) {
          var segmentStart = k;
          var segmentSourceTiles = 0;
          var segmentSourceFingerprint = 2166136261 >>> 0;
          var segmentHiddenTiles = 0;
          var gx0 = Math.max(0, bx * 16 - ox), gx1 = Math.min(gw, (bx + 1) * 16 - ox);
          var gy0 = Math.max(0, by * 16 - oy), gy1 = Math.min(gh, (by + 1) * 16 - oy);
          for (var gy = gy0; gy < gy1; gy++) {
            for (var gx = gx0; gx < gx1; gx++) {
              var i = gy * gw + gx;
              if (i >= n) continue;
              var t = tiles[i];
              segmentSourceFingerprint = segmentFoldTile(segmentSourceFingerprint, t);
              if (t && t.hidden) segmentHiddenTiles++;
              if (!t) continue;
              if (typeof t.tt === "number" && t.tt >= 0) segmentSourceTiles++;
              try { buildTile(t, gx, gy, gw, gh, wallGrid, hg, camZ, lookupTile, openGrid); } catch (_e) { /* one bad tile never blanks the map */ }
            }
          }
          terrainOrder.push(rememberTerrainSegment(bx, by, camZ, segmentStart, k,
            segmentSourceTiles, segmentSourceFingerprint, segmentHiddenTiles));
        }
      }
      terrainCount = k;
      buildingStart = terrainCount;
      machineParity = (view && view.freezeAnim) ? 0 :
        (typeof view.machineParity === "number" ? view.machineParity :
          machineFrameParityGL(typeof Date !== "undefined" ? Date.now() : 0, false));
      function lookupBuildingTile(wx, wy) { return lookupTile(wx - ox, wy - oy); }
      paintFarmLayers(function () {
        for (var bi = 0; bi < buildings.length; bi++) {
          try { emitBuilding(buildings[bi], ox, oy, camZ, lookupBuildingTile); } catch (_e2) { /* one bad building never blanks the map */ }
        }
        buildingCount = k - buildingStart;
        cropStart = k;
      }, function () {
        emitFarmCrops(view);
        cropCount = k - cropStart;
      });
      overlayStart = k;
      var djobs = (view && view.djobs) || [];
      blinkDjobTiles.clear();
      var unitTiles = unitTileSet(view);
      for (var dji = 0; dji < djobs.length; dji++) {
        var dj = djobs[dji];
        if (!dj) continue;
        // Only WORKER-claimed djobs blink (w:1 on the wire); workerless posted jobs stay steady, like native.
        if (dj.w && isBlinkingDesignationJob(dj.k)) blinkDjobTiles.add(dj.x + "|" + dj.y + "|" + dj.z);
        var djOnTile = !!(dj.w && unitTiles && unitTiles.has(dj.x + "|" + dj.y + "|" + dj.z));
        var dgx = dj.x - ox, dgy = dj.y - oy;
        if (dgx < 0 || dgy < 0 || dgx >= gw || dgy >= gh) continue;
        var dt = lookupTile(dgx, dgy);
        if (dt && dt.desig && resolveDesig(dt.desig, dt)) {
          markDesignationJobBlink(desigList, dgx, dgy, dj, djOnTile);
          continue; // bits still present -> already drawn
        }
        var djv = resolveDjobGL(dj.k, dt);
        if (djv) {
          if (dt && (dt.hidden || (dt.shape || "") === "WALL"))
            emitSolid(dgx, dgy, [0, 0, 0], 0, ATTR_ADDITIVE);
          desigList.push({ gx: dgx, gy: dgy, cell: djv.cell, cat: djv.cat, marker: false,
            prio: (dt && dt.desigPriority && dt.desigPriority.priority) | 0,
            djobKind: dj.k, djobWorker: !!dj.w, djobActive: djOnTile });
        }
      }
      try { emitDesignationOverlay(desigList, (typeof view.designationNowMs === "number") ? view.designationNowMs : 0); } catch (_e3) { /* overlay guarded */ }
      try { emitMiningIndicators(tiles, gw, gh); } catch (_e3b) { /* overlay guarded */ }
      try { emitPresence(players, ox, oy, camZ, ownPlayerName); } catch (_e4) { /* overlay guarded */ }
      overlayCount = k - overlayStart;
      staticCount = k; // checkpoint: units append/overwrite ONLY past this index
      lastBuildView = view;
      return { count: k, bytes: k * INSTANCE_BYTES, ms: now() - t0 };
    }

    function buildTerrainChunkSegment(patch) {
      var view = patch.view || {};
      var tiles = view.tiles || [];
      var gw = view.width | 0, gh = view.height | 0;
      var total = gw * gh, n = Math.min(tiles.length, total);
      var ox = view.origin && typeof view.origin.x === "number" ? view.origin.x : patch.bx * 16;
      var oy = view.origin && typeof view.origin.y === "number" ? view.origin.y : patch.by * 16;
      var camZ = view.origin && typeof view.origin.z === "number" ? view.origin.z : patch.z;
      function lookupTile(x, y) {
        if (x < 0 || y < 0 || x >= gw || y >= gh) return null;
        return tiles[y * gw + x] || null;
      }
      ensureCapacity(total * 34 + 32);
      if (!wallGrid || gridN < total) {
        wallGrid = new Uint8Array(total); hiddenGrid = new Uint8Array(total);
        openGrid = new Uint8Array(total); gridN = total;
      }
      var haveHidden = false;
      for (var i = 0; i < n; i++) {
        var t = tiles[i];
        wallGrid[i] = (t && t.shape === "WALL") ? 1 : 0;
        openGrid[i] = (Adj ? Adj.isOpenNeighbor(t) : (!!t && !t.hidden && t.shape !== "WALL" && (typeof t.tt !== "number" || t.tt >= 0))) ? 1 : 0;
        hiddenGrid[i] = (t && t.hidden) ? 1 : 0; if (hiddenGrid[i]) haveHidden = true;
      }
      // The chunk-patch path calls buildTile too, so it needs the same index, or a partially rebuilt
      // chunk silently loses its stockpile art.
      rebuildStockpileIndex((view && view.buildings) || [], camZ);
      var gx0 = Math.max(0, patch.bx * 16 - ox), gx1 = Math.min(gw, (patch.bx + 1) * 16 - ox);
      var gy0 = Math.max(0, patch.by * 16 - oy), gy1 = Math.min(gh, (patch.by + 1) * 16 - oy);
      k = 0;
      emitOriginX = ox; emitOriginY = oy;
      chunkCacheByZ = new Map();
      curMapDims = resolveMapDims();  // once per chunk-segment rebuild (patch path)
      desigList = [];
      var sourceTiles = 0;
      var sourceFingerprint = 2166136261 >>> 0;
      var hiddenTiles = 0;
      for (var gy = gy0; gy < gy1; gy++) {
        for (var gx = gx0; gx < gx1; gx++) {
          var idx = gy * gw + gx;
          if (idx >= n) continue;
          var sourceTile = tiles[idx] || null;
          sourceFingerprint = segmentFoldTile(sourceFingerprint, sourceTile);
          if (sourceTile && sourceTile.hidden) hiddenTiles++;
          if (!sourceTile) continue;
          if (typeof sourceTile.tt === "number" && sourceTile.tt >= 0) sourceTiles++;
          try { buildTile(sourceTile, gx, gy, gw, gh, wallGrid,
            haveHidden ? hiddenGrid : null,
            camZ, lookupTile, openGrid); } catch (_e) { /* one bad tile never blanks a chunk */ }
        }
      }
      return rememberTerrainSegment(patch.bx, patch.by, patch.z, 0, k,
        sourceTiles, sourceFingerprint, hiddenTiles);
    }

    // `patches` holds only the chunks being repainted, each decoded with a one-tile neighbour border.
    // `nextOrder` REPLACES terrainOrder and drops every segment it does not name; the rest keep bytes.
    function patchTerrainChunks(patches, fullView, nextOrder) {
      var t0 = now();
      patches = patches || [];
      var oldSuffixCount = Math.max(0, k - buildingStart);
      var suffix = oldSuffixCount > 0
        ? new Uint8Array(buf, buildingStart * INSTANCE_BYTES, oldSuffixCount * INSTANCE_BYTES).slice()
        : null;
      var changed = new Set(), chunkMs = [];
      for (var i = 0; i < patches.length; i++) {
        var chunkT0 = now();
        changed.add(buildTerrainChunkSegment(patches[i]));
        chunkMs.push(now() - chunkT0);
      }
      if (Array.isArray(nextOrder)) {
        terrainOrder = nextOrder.slice();
        var keep = new Set(terrainOrder);
        for (var id of terrainSegments.keys()) if (!keep.has(id)) terrainSegments.delete(id);
      }
      var totalTerrain = 0, dirtyStart = -1;
      for (var oi = 0; oi < terrainOrder.length; oi++) {
        var seg0 = terrainSegments.get(terrainOrder[oi]);
        if (!seg0) continue;
        if (dirtyStart < 0 && changed.has(terrainOrder[oi])) dirtyStart = totalTerrain;
        totalTerrain += seg0.count;
      }
      // A rect shift can reorder retained segments, moving their compacted GPU offsets, so upload the
      // flat static prefix from zero -- still with no terrain re-emission for clean chunks.
      if (Array.isArray(nextOrder)) dirtyStart = 0;
      ensureCapacity(totalTerrain + oldSuffixCount + 32);
      k = 0;
      for (var oj = 0; oj < terrainOrder.length; oj++) {
        var seg = terrainSegments.get(terrainOrder[oj]);
        if (!seg) continue;
        new Uint8Array(buf, k * INSTANCE_BYTES, seg.bytes.byteLength).set(seg.bytes);
        k += seg.count;
      }
      terrainCount = k;
      buildingStart = terrainCount;
      if (suffix) new Uint8Array(buf, k * INSTANCE_BYTES, suffix.byteLength).set(suffix);
      cropStart = buildingStart + buildingCount;
      overlayStart = cropStart + cropCount;
      staticCount = overlayStart + overlayCount;
      k = staticCount + Math.max(0, oldSuffixCount - buildingCount - cropCount - overlayCount);
      emitOriginX = fullView && fullView.origin ? fullView.origin.x : emitOriginX;
      emitOriginY = fullView && fullView.origin ? fullView.origin.y : emitOriginY;
      lastBuildView = fullView || lastBuildView;
      return {
        count: staticCount, bytes: Math.max(0, staticCount - Math.max(0, dirtyStart)) * INSTANCE_BYTES,
        ms: now() - t0, dirtyStart: dirtyStart < 0 ? 0 : dirtyStart, dirtyEnd: staticCount,
        chunks: patches.length, chunkMs: chunkMs,
      };
    }

    function rebuildBuildings(view) {
      var t0 = now();
      view = view || lastBuildView || {};
      var oldBuildingCount = buildingCount;
      var oldCropCount = cropCount;
      var dynamicCount = Math.max(0, k - staticCount);
      var suffixCount = overlayCount + dynamicCount;
      var suffix = suffixCount > 0
        ? new Uint8Array(buf, overlayStart * INSTANCE_BYTES, suffixCount * INSTANCE_BYTES).slice()
        : null;
      var buildings = buildingsInPaintOrder(view.buildings || []);
      var budget = 0;
      for (var i = 0; i < buildings.length; i++) {
        var b = buildings[i];
        if (!b || isOverlayOnlyBuildingType(b.type)) continue;
        var bw = (typeof b.x2 === "number" && typeof b.x1 === "number") ? Math.max(1, b.x2 - b.x1 + 1) : 1;
        var bh = (typeof b.y2 === "number" && typeof b.y1 === "number") ? Math.max(1, b.y2 - b.y1 + 1) : 1;
        budget += bw * bh;
      }
      budget += farmCropPlansGL(view).length;
      ensureCapacity(buildingStart + budget + suffixCount + 32);
      k = buildingStart;
      machineParity = (view && view.freezeAnim) ? 0 :
        (typeof view.machineParity === "number" ? view.machineParity :
          machineFrameParityGL(typeof Date !== "undefined" ? Date.now() : 0, false));
      var camZ = (view.origin && typeof view.origin.z === "number") ? view.origin.z : null;
      var tileWidth = view.width | 0, tileHeight = view.height | 0, viewTiles = view.tiles || [];
      function lookupBuildingTile(wx, wy) {
        var gx = wx - emitOriginX, gy = wy - emitOriginY;
        if (gx < 0 || gy < 0 || gx >= tileWidth || gy >= tileHeight) return null;
        return viewTiles[gy * tileWidth + gx] || null;
      }
      paintFarmLayers(function () {
        for (var bi = 0; bi < buildings.length; bi++) {
          try { emitBuilding(buildings[bi], emitOriginX, emitOriginY, camZ, lookupBuildingTile); } catch (_e) { /* one bad building never blanks the map */ }
        }
        buildingCount = k - buildingStart;
        cropStart = k;
      }, function () {
        emitFarmCrops(view);
        cropCount = k - cropStart;
      });
      overlayStart = k;
      if (suffix) new Uint8Array(buf, k * INSTANCE_BYTES, suffix.byteLength).set(suffix);
      staticCount = overlayStart + overlayCount;
      k = staticCount + dynamicCount;
      var countChanged = buildingCount !== oldBuildingCount || cropCount !== oldCropCount;
      return {
        count: staticCount, bytes: (buildingCount + cropCount) * INSTANCE_BYTES, ms: now() - t0,
        dirtyStart: buildingStart,
        dirtyEnd: countChanged ? staticCount : overlayStart,
      };
    }

    function rebuildOverlay(view) {
      var t0 = now();
      view = view || lastBuildView || {};
      var dynamicCount = Math.max(0, k - staticCount);
      var dynamic = dynamicCount > 0
        ? new Uint8Array(buf, staticCount * INSTANCE_BYTES, dynamicCount * INSTANCE_BYTES).slice()
        : null;
      k = overlayStart;
      desigList = [];
      var gw = view.width | 0, gh = view.height | 0;
      var tiles = view.tiles || [];
      function lookupTile(x, y) {
        if (x < 0 || y < 0 || x >= gw || y >= gh) return null;
        return tiles[y * gw + x] || null;
      }
      for (var i = 0; i < Math.min(tiles.length, gw * gh); i++) {
        var t = tiles[i];
        if (!t || !t.desig) continue;
        var dv = resolveDesig(t.desig, t);
        if (!dv) continue;
        var gx = i % gw, gy = (i - gx) / gw;
        desigList.push({ gx: gx, gy: gy, cell: dv.cell, cat: dv.cat, marker: !!t.desig.marker,
                         prio: (t.desigPriority && t.desigPriority.priority) | 0 });
      }
      var djobs = view.djobs || [];
      blinkDjobTiles.clear();
      var unitTiles = unitTileSet(view);
      for (var di = 0; di < djobs.length; di++) {
        var dj = djobs[di];
        if (!dj) continue;
        // Only WORKER-claimed djobs blink (w:1 on the wire).
        if (dj.w && isBlinkingDesignationJob(dj.k)) blinkDjobTiles.add(dj.x + "|" + dj.y + "|" + dj.z);
        var djOnTile = !!(dj.w && unitTiles && unitTiles.has(dj.x + "|" + dj.y + "|" + dj.z));
        var dgx = dj.x - emitOriginX, dgy = dj.y - emitOriginY;
        if (dgx < 0 || dgy < 0 || dgx >= gw || dgy >= gh) continue;
        var dt = lookupTile(dgx, dgy);
        if (dt && dt.desig && resolveDesig(dt.desig, dt)) {
          markDesignationJobBlink(desigList, dgx, dgy, dj, djOnTile);
          continue;
        }
        var djv = resolveDjobGL(dj.k, dt);
        if (djv) {
          if (dt && (dt.hidden || (dt.shape || "") === "WALL"))
            emitSolid(dgx, dgy, [0, 0, 0], 0, ATTR_ADDITIVE);
          desigList.push({ gx: dgx, gy: dgy, cell: djv.cell, cat: djv.cat, marker: false,
            prio: (dt && dt.desigPriority && dt.desigPriority.priority) | 0,
            djobKind: dj.k, djobWorker: !!dj.w, djobActive: djOnTile });
        }
      }
      // plus gw*gh worst case: at most one mining indicator per tile in the window
      ensureCapacity(overlayStart + desigList.length * 4 + (toolStateOverlayVisibleGL("mining") ? gw * gh : 0)
                     + presenceBudget(view.players || []) + dynamicCount + 16);
      try { emitDesignationOverlay(desigList, (typeof view.designationNowMs === "number") ? view.designationNowMs : 0); } catch (_e2) { /* guarded */ }
      try { emitMiningIndicators(tiles, gw, gh); } catch (_e2b) { /* guarded */ }
      var camZ = (view.origin && typeof view.origin.z === "number") ? view.origin.z : null;
      try { emitPresence(view.players || [], emitOriginX, emitOriginY, camZ, ownPlayerName); } catch (_e3) { /* guarded */ }
      overlayCount = k - overlayStart;
      staticCount = k;
      if (dynamic) new Uint8Array(buf, staticCount * INSTANCE_BYTES, dynamic.byteLength).set(dynamic);
      k = staticCount + dynamicCount;
      return { count: staticCount, bytes: overlayCount * INSTANCE_BYTES, ms: now() - t0,
               dirtyStart: overlayStart, dirtyEnd: staticCount };
    }

    function resolveUnitTierForCtx(u) { return resolveUnitTierGL(u, creaturesMap && creaturesMap.races, atlas); }

    // One instance per sprite cell, never one big quad. Tier 1 anchors the unit's tile at (u.ax, u.ay),
    // NOT the block's top-left; tier 3 derives its anchor from sel.rec instead.
    function emitUnitSprite(u, gx, gy, alpha255, tr, tg, tb) {
      if (typeof tr !== "number") { tr = 255; tg = 255; tb = 255; }
      var sel = resolveUnitTierForCtx(u);
      if (sel.tier === 1) {
        var sw = u.sw | 0, sh = u.sh | 0;
        if (sw <= 0 || sh <= 0) return false;
        var ax = (typeof u.ax === "number") ? u.ax : 0;
        var ay = (typeof u.ay === "number") ? u.ay : Math.max(0, sh - 1);
        var any = false;
        for (var ry = 0; ry < sh; ry++) {
          for (var rx = 0; rx < sw; rx++) {
            var c = atlas.resolve(u.ah, rx, ry);
            if (c > 0) { emit(gx - ax + rx, gy - ay + ry, c, tr, tg, tb, alpha255, 0); any = true; }
          }
        }
        return any;
      }
      if (sel.tier === 3) {
        var rw = sel.rec.w || 1, rh = sel.rec.h || 1;
        var rax = (rw === 1) ? 0 : 1;
        var ray = rh - 1;
        var any3 = false;
        for (var ry3 = 0; ry3 < rh; ry3++) {
          for (var rx3 = 0; rx3 < rw; rx3++) {
            var c3 = atlas.resolve(sel.rec.sheet, sel.rec.col + rx3, sel.rec.row + ry3);
            if (c3 > 0) { emit(gx - rax + rx3, gy - ray + ry3, c3, tr, tg, tb, alpha255, 0); any3 = true; }
          }
        }
        return any3;
      }
      if (sel.tier === 4) {
        var c4 = atlas.resolve(sel.key, 0, 0);
        if (c4 > 0) { emit(gx, gy, c4, tr, tg, tb, alpha255, 0); return true; }
        return false;
      }
      return false; // tier 5: caller draws the fallback dot
    }

    function buildUnits(units, ox, oy, camZ, nowMs) {
      k = staticCount;
      var list = units || [];
      var budget = 0;
      var raceMap = creaturesMap && creaturesMap.races;
      for (var bi = 0; bi < list.length; bi++) {
        var bu = list[bi];
        var span = 1;
        if (bu && typeof bu.sw === "number" && typeof bu.sh === "number") {
          span = Math.max(1, bu.sw * bu.sh);
        } else if (bu && bu.rt && raceMap) {
          var brec = raceMap[bu.rt];
          if (brec && brec.sheet && (brec.w || brec.h)) span = Math.max(1, (brec.w || 1) * (brec.h || 1));
        }
        if (bu && unitStatusIconForBits(bu.st, bu.st2)) span += 1;
        budget += span;
      }
      ensureCapacity(staticCount + budget + 8);
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        if (!u || typeof u.x !== "number" || typeof u.y !== "number") continue;
        // emit() adds the scene origin, so subtract the stable BUILD origin, never the moving camera one.
        var gx = u.x - emitOriginX, gy = u.y - emitOriginY;
        // Units arrive across the whole stacked z-range around the camera, not just the camera plane.
        var udz = (typeof u.z === "number" && typeof camZ === "number") ? u.z - camZ : 0;
        var seeDownU = !!u.sd && udz < 0;
        if (udz !== 0 && !seeDownU) continue;
        if (udz === 0 && blinkDjobTiles.size &&
            blinkDjobTiles.has(Math.round(u.x) + "|" + Math.round(u.y) + "|" + u.z) &&
            !workedTileUnitVisible(nowMs)) continue;
        // Floor a see-down unit's opacity so deep ones stay READABLE: belowAlpha reaches 0 by depth ~8.
        var uAlpha = seeDownU ? Math.max(0.55, belowAlpha(-udz)) : 1;
        // Fold DF's ghost translucency into the unit's alpha and pass the tint into every tier below.
        var isGhost = (u.gh === 1);
        if (isGhost) uAlpha *= GHOST_ALPHA;
        var alpha255 = Math.max(0, Math.min(255, Math.round(uAlpha * 255)));
        var gtr = isGhost ? GHOST_TINT_RGB[0] : 255;
        var gtg = isGhost ? GHOST_TINT_RGB[1] : 255;
        var gtb = isGhost ? GHOST_TINT_RGB[2] : 255;
        try {
          if (!emitUnitSprite(u, gx, gy, alpha255, gtr, gtg, gtb)) {
            var uc = (atlas && atlas.resolveStamp) ? atlas.resolveStamp("unit:dot", paintUnitDotStamp) : 0;
            if (uc > 0) emit(gx, gy, uc, gtr, gtg, gtb, alpha255, 0);
            else emitSolid(gx, gy, isGhost ? GHOST_TINT_RGB : UNIT_FALLBACK_RGB, alpha255, 0);  // legacy/mock-atlas fallback
          }
          // tickUnits re-emits the whole units tail every frame, so this blinking bubble needs no
          // dirty tracking and must never be cached across frames.
          var sic = unitStatusIconNow(u.st, u.st2, u.id, nowMs);
          if (sic) {
            var scell = atlas && atlas.resolve ? atlas.resolve(sic.sheet, sic.col, sic.row) : 0;
            if (scell > 0) emit(gx, gy - 1, scell, 255, 255, 255, alpha255, 0);
          }
          // A soft emphasis pulse over the unit's own cell: cyan when native supplied a colour, else neutral.
          var uflash = unitMapFlash(u.st, nowMs);
          if (uflash && uflash.on) {
            var frgb = uflash.rgb || [255, 255, 255];
            emitSolid(gx, gy, frgb, Math.round(alpha255 * 0.35), 0);
          }
        } catch (_e3) { /* one bad unit never blanks the map */ }
      }
      return { count: k - staticCount, bytes: (k - staticCount) * INSTANCE_BYTES };
    }

    var PROJ_RGB = [250, 240, 200];   // bolt/stone/etc. (canvas2d rgba(250,240,200,0.95))
    var VEHICLE_RGB = [180, 150, 90]; // minecart/vehicle (canvas2d rgba(180,150,90,0.9))
    function paintVehicleStamp(d, size) {
      var s = Math.max(3, Math.round(size * 0.5));     // canvas2d: Math.max(3, cell*0.5)
      var x0 = Math.round((size - s) / 2), y0 = Math.round((size - s) / 2);
      for (var y = y0; y < y0 + s; y++) {
        for (var x = x0; x < x0 + s; x++) {
          var i = (y * size + x) * 4;
          var edge = (x === x0 || x === x0 + s - 1 || y === y0 || y === y0 + s - 1);
          if (edge) { d[i] = 40; d[i + 1] = 30; d[i + 2] = 10; d[i + 3] = 230; }
          else { d[i] = VEHICLE_RGB[0]; d[i + 1] = VEHICLE_RGB[1]; d[i + 2] = VEHICLE_RGB[2]; d[i + 3] = 230; }
        }
      }
    }
    function paintProjStamp(d, size) {
      var cx = size / 2, cy = size / 2, r = Math.max(1.5, size * 0.16);
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > r + 1) continue;
          var i = (y * size + x) * 4;
          if (dist <= r) { d[i] = PROJ_RGB[0]; d[i + 1] = PROJ_RGB[1]; d[i + 2] = PROJ_RGB[2]; d[i + 3] = 242; }
          else { d[i] = 30; d[i + 1] = 20; d[i + 2] = 10; d[i + 3] = 230; }
        }
      }
    }
    // Tier-5 unit fallback dot, with canvas2d's exact geometry.
    function paintUnitDotStamp(d, size) {
      var cx = size / 2, cy = size / 2, r = Math.max(2, Math.floor(size / 3));
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > r + 1) continue;
          var i = (y * size + x) * 4;
          if (dist <= r) { d[i] = UNIT_FALLBACK_RGB[0]; d[i + 1] = UNIT_FALLBACK_RGB[1]; d[i + 2] = UNIT_FALLBACK_RGB[2]; d[i + 3] = 255; }
          else { d[i] = 20; d[i + 1] = 20; d[i + 2] = 20; d[i + 3] = 235; }
        }
      }
    }
    function projItemVisualGL(p) {
      if (!p || !itemMap || typeof p.item_type !== "number" || p.item_type < 0) return null;
      var type = itemTypeNames && itemTypeNames.get(p.item_type);
      if (!type) return null;
      var v = resolveItemVisualGL({
        type: type,
        subtype: typeof p.subtype === "number" ? p.subtype : -1,
        mat_type: typeof p.mat_type === "number" ? p.mat_type : -1,
        mat_index: typeof p.mat_index === "number" ? p.mat_index : -1,
        iflags: 0,
      });
      return (v && v.entry && v.entry.sheet && v.source !== "missing") ? v : null;
    }
    function emitProjItem(p, gx, gy, a255) {
      var vis = projItemVisualGL(p);
      var e = vis && vis.entry;
      if (!e || !atlas) return false;
      var alpha = (typeof a255 === "number") ? a255 : 255;
      var palRow;
      if (materialMap && PALETTIZABLE_SOURCE_GL[vis.source]) {
        var pr = matPalRowForGL({ mat_type: p.mat_type, mat_index: p.mat_index });
        if (typeof pr === "number") palRow = pr;
      }
      var c = -1;
      if (palRow !== undefined && atlas.resolvePalette) {
        var remap = paletteRemapFor(palRow);
        if (remap) c = atlas.resolvePalette(e.sheet, e.col, e.row, palRow, remap);
      }
      if (c <= 0) { c = atlas.resolve(e.sheet, e.col, e.row); palRow = undefined; }
      if (!(c > 0)) return false;
      if (palRow !== undefined) { emit(gx, gy, c, 255, 255, 255, alpha, 0); return true; }
      var fam = matFamilyFor(p.mat_type);
      var tint = fam && ITEM_TINT_RGB_BY_FAMILY[fam];
      if (tint) emit(gx, gy, c, tint[0], tint[1], tint[2], alpha, 0);
      else emit(gx, gy, c, 255, 255, 255, alpha, 0);
      return true;
    }
    function buildProjectiles(projs, ox, oy, camZ) {
      var list = projs || [];
      // keep the units tail already at [staticCount,k) and add one instance per projectile
      ensureCapacity(k + list.length + 4);
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
        var pdz = (typeof p.z === "number" && typeof camZ === "number") ? p.z - camZ : 0;
        var seeDownP = !!p.sd && pdz < 0;
        if (pdz !== 0 && !seeDownP) continue;
        var pAlpha255 = seeDownP
          ? Math.max(0, Math.min(255, Math.round(Math.max(0.55, belowAlpha(-pdz)) * 255)))
          : 255;
        var offx = ((typeof p.fx === "number" ? p.fx : 128) - 128) / 255;
        var offy = ((typeof p.fy === "number" ? p.fy : 128) - 128) / 255;
        var gx = (p.x - emitOriginX) + offx, gy = (p.y - emitOriginY) + offy;
        try {
          // Real item art first. Vehicles keep the cart marker, because the minecart's own ITEM sprite is
          // drawn by the tile layer underneath.
          if (!p.vehicle && emitProjItem(p, gx, gy, pAlpha255)) continue;
          var sc = 0;
          if (atlas && atlas.resolveStamp) {
            sc = p.vehicle ? atlas.resolveStamp("proj:vehicle", paintVehicleStamp)
                           : atlas.resolveStamp("proj:bolt", paintProjStamp);
          }
          if (sc > 0) emit(gx, gy, sc, 255, 255, 255, pAlpha255, 0);
          else emitSolid(gx, gy, p.vehicle ? VEHICLE_RGB : PROJ_RGB,
                         Math.round(245 * pAlpha255 / 255), 0);  // legacy/mock-atlas fallback
        } catch (_ep) { /* one bad proj never blanks the map */ }
      }
      return { count: k - staticCount, bytes: (k - staticCount) * INSTANCE_BYTES };
    }

    function paintFlowCloudStamp(d, size) {
      var cx = size / 2, cy = size / 2, rr = size * 0.5;
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          var dist = Math.sqrt(dx * dx + dy * dy) / rr;   // 0 center .. 1 quad edge
          if (dist >= 1) continue;
          // mirror the canvas gradient stops (1 @0, 0.6 @0.62, 0 @1), linear between
          var a = dist < 0.62 ? 1 - 0.4 * (dist / 0.62) : 0.6 * (1 - dist) / 0.38;
          var i = (y * size + x) * 4;
          d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.round(255 * a);
        }
      }
    }
    function buildFlows(flows, nowMs) {
      var list = flows || [];
      ensureCapacity(k + list.length + 4);
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (!f || typeof f.x !== "number" || typeof f.y !== "number") continue;
        try {
          var plan = flowOverlayForGL(f, nowMs);
          if (!plan) continue;
          var a = plan.alpha, sa = plan.spriteAlpha;
          // see-down substituted tile: the same depth dim canvas2d's drawFlows applies
          if (typeof f.depth === "number" && f.depth > 0) {
            var fdim = Math.max(0.35, 1 - 0.12 * f.depth); a *= fdim; sa *= fdim;
          }
          var a255 = Math.max(0, Math.min(255, Math.round(a * 255)));
          var sa255 = Math.max(0, Math.min(255, Math.round(sa * 255)));
          var gx = f.x - emitOriginX, gy = f.y - emitOriginY;
          var animCell = 0, animAttr = 0;
          var e = plan.token && spriteMap && spriteMap[plan.token];
          if (e && e.sheet && e.frames && e.frames.length && atlas && atlas.resolveAnimated) {
            animCell = atlas.resolveAnimated(plan.token, e.sheet, e.frames);
            if (animCell > 0 && e.frames.length > 1)
              animAttr = encodeAnimAttr(e.frames.length, defaultAnimRateCodeForToken(plan.token));
          }
          if (animCell > 0) { emit(gx, gy, animCell, 255, 255, 255, sa255, animAttr); continue; }
          var sc = (atlas && atlas.resolveStamp) ? atlas.resolveStamp("flow:cloud", paintFlowCloudStamp) : 0;
          if (sc > 0) emit(gx, gy, sc, plan.rgb[0], plan.rgb[1], plan.rgb[2], a255, 0);
          // A solid quad has no radial falloff, so halve the alpha to keep coverage in the same class.
          else emitSolid(gx, gy, plan.rgb, Math.round(a255 * 0.55), 0);
        } catch (_ef) { /* one bad flow never blanks the map */ }
      }
      return { count: k - staticCount, bytes: (k - staticCount) * INSTANCE_BYTES };
    }

    return {
      buildScene: buildScene,
      patchTerrainChunks: patchTerrainChunks,
      rebuildBuildings: rebuildBuildings,
      rebuildOverlay: rebuildOverlay,
      buildUnits: buildUnits,
      buildProjectiles: buildProjectiles,   // third dynamic region, appends after units
      buildFlows: buildFlows,               // fourth dynamic region, flow clouds (miasma)
      get buffer() { return buf; },
      get count() { return k; },
      get staticCount() { return staticCount; },
      get terrainCount() { return terrainCount; },
      terrainResolvedStats: terrainResolvedStats,
      terrainSegmentStats: terrainSegmentStats,
      foldTerrainTile: segmentFoldTile,
      get buildingCount() { return buildingCount; },
      get cropStart() { return cropStart; },
      get cropCount() { return cropCount; },
      get overlayCount() { return overlayCount; },
      hasTerrainSegment: function (bx, by, z) {
        return terrainSegments.has(terrainSegmentId(bx, by, z));
      },
      terrainSegmentId: terrainSegmentId,
      _getTerrainSegmentForTest: function (bx, by, z) {
        return terrainSegments.get(terrainSegmentId(bx, by, z)) || null;
      },
      setMaps: function (m) {
        if (m.atlas !== undefined) atlas = m.atlas;
        if (m.spriteMap !== undefined) spriteMap = m.spriteMap;
        if (m.tokenMap !== undefined) tokenMap = m.tokenMap;
        if (m.shadowCellMap !== undefined) shadowCellMap = m.shadowCellMap;
        if (m.adjacency !== undefined) Adj = m.adjacency;
        if (m.cacheReader !== undefined) cacheReader = m.cacheReader;
        if (m.tiletypeMeta !== undefined) tiletypeMeta = m.tiletypeMeta;
        // sparse-layer maps.
        if (m.itemMap !== undefined) { itemMap = m.itemMap; applySheetGeometryFromItemMap(); }
        if (m.plantMap !== undefined) plantMap = m.plantMap;
        if (m.treeMap !== undefined) treeMap = m.treeMap;
        if (m.spatterMap !== undefined) spatterMap = m.spatterMap;
        if (m.buildingMap !== undefined) buildingMap = m.buildingMap;
        if (m.creaturesMap !== undefined) creaturesMap = m.creaturesMap;
        if (m.grassColors !== undefined) grassColors = m.grassColors;
        // Material identity and palette table, plus the wire-driven itemdef token map from dwf-tiles.js.
        if (m.materialMap !== undefined) { materialMap = m.materialMap; buildPaletteLookup(); }
        if (m.itemDefTokens !== undefined) itemDefTokens = m.itemDefTokens;
        if (m.itemTypeNames !== undefined) itemTypeNames = m.itemTypeNames;
      },
      // test hooks
      _resolveSprite: resolveSprite,
      _tileColor: tileColor,
      _isTreeWallMatForTest: isTreeWallMat,  // TREE/MUSHROOM WALL-as-trunk predicate (canvas2d parity)
      _wallJoinCellForTest: function (t, openMask, gx, gy) { return wallJoinCell(t, openMask, gx, gy); },
      _grassBackingCellForTest: grassBackingCellGL,
      _grassVariantIndexForTest: grassVariantIndex,
      _groundBackingCellForTest: groundBackingCellGL, // (t,gx,gy,lookup) -> {cell,wash} | null
      _boulderVariantForTest: boulderVariantGL,       // (t,gx,gy) -> atlas cell | 0 (8-cell fan-out)
      _inMapBoundsForTest: inMapBoundsGL,  // (t,dims) footprint test (canvas2d parity)
      _wantsHiddenHatchForTest: wantsHiddenHatchGL,  // hidden-path decision (canvas2d parity)
      _edgeOvergrowthPlanForTest: edgeOvergrowthPlanGL,
      _emitEdgeOvergrowthForTest: emitEdgeOvergrowth,
      // hidden-tile display law (canvas2d parity)
      _hiddenScatterForTest: hiddenScatterFor,      // (bx,by,z) -> [{bx,by,variant} x4]
      _hiddenVariantAtForTest: hiddenVariantAt,     // (wx,wy,wz) -> 0..4, or -1 for "draw nothing"
      _resetHiddenScatterForTest: resetHiddenScatter,
      _overlaysAllowedForTest: overlaysAllowedGL,   // only DISCOVERED tiles get the overlay stack
      _sandFloorPlanForTest: sandFloorPlan,  // (t,gx,gy,lookup) -> atlas cell | 0
      _smoothFloorTokenForTest: function (t) { return root.DwfTerrainVariant && root.DwfTerrainVariant.smoothFloorToken(t); },
      _emitTreeForTest: emitTree,  // tail-less tree tiles still emit art
      _descendSeeDown: descendSeeDown,
      // test hooks (the same fixture-replay convention as dwf-tiles.js's)
      _resolveItemEntryForTest: resolveItemEntryGL,
      _resolveItemVisualForTest: resolveItemVisualGL,  // {entry,source} including the itemdef step
      // lockstep partner of dwf-tiles.js's _gemVariantForTest
      _gemVariantForTest: function (it, v, gx, gy) { return gemVariantForItemGL(it, v, gx, gy); },
      _projItemVisualForTest: projItemVisualGL,               // projectile record -> item art
      _containerPeekEntryForTest: containerPeekEntryGL,       // (containerItem, peek) -> overlay cell|null
      _matPalRowForTest: matPalRowForGL,  // material -> palette row
      _matFamilyForItemForTest: matFamilyForItemGL,  // EXACT METAL/STONE family
      _constructionFloorPlanForTest: constructionFloorPlanGL,  // GL/canvas2d parity plan
      _constructionTrackMaskForTest: constructionTrackMask,  // ttname -> track adjacency mask
      _fortificationOpenTokenForTest: fortificationOpenTokenGL,
      _consMaterialForTest: consMaterialGL,  // base_mt/mi -> {family,palRow}|null
      _consMaterialRgbForTest: consMaterialRgbGL,  // base_mt/mi -> [r,g,b]|null
      _wallMaterialForTest: wallMaterialGL,                   // construction/natural-stone material policy
      _wallJoinPalRowForTest: wallJoinPalRowGL,               // wall-face palette row
      _wallBackingTokenForTest: wallBackingTokenGL,           // natural wall dark hidden-rock underlay
      _terrainSpritePalRowForTest: terrainSpritePalRowGL,     // palette-authored natural terrain
      _wallPrefixForTest: wallPrefix,  // (mat,base_mt) -> family prefix
      _roughInorganicWallPrefixForTest: roughInorganicWallPrefixGL,  // exact native family
      _roughWallVariantForTest: roughWallVariantGL,  // approximate RNG substitute
      _wallArtParityForTest: WALL_ART_PARITY,
      _wallDetailPrefixForTest: wallDetailPrefix,  // (t) -> smoothed/worn wall family | null
      _paletteRemapForTest: paletteRemapFor,  // (palRow) -> remap(cellData) | null
      _resolveIdentityEntryForTest: resolveIdentityEntryGL,
      _resolvePlantEntryForTest: plantEntryGL,
      _spatterFamilyForTest: function (sp) { return spatterFamilyForCtx(spatterMap, sp); },
      _bloodFamilyFromRgbForTest: bloodFamilyFromRgb,
      _engravingWallPlanForTest: engravingWallPlanGL,         // engraved wall token + material row
      _engravingFloorPlanForTest: engravingFloorPlanGL,       // palette/non-palette floor art + row
      _itemMarkTokenForTest: itemMarkToken,
      _spatterShapeForTest: function (amount) { return spatterShapeForCtx(spatterMap, amount); },
      _spatterPartialKeyForTest: partialVariantKey,
      _spatterOracleCellForTest: function (family, kind, familyLevel) {
        return spatterOracleCellForCtx(spatterMap, family, kind, familyLevel);
      },
      _spatterCellForTest: function (sp, x, y, z, salt, fullKey) {
        return root.DwfTerrainVariant && root.DwfTerrainVariant.spatterCell(spatterMap, sp, x, y, z, salt, fullKey);
      },
      _spatterVisibleForTest: spatterVisible,
      _spatterVisibleAmountForTest: SPATTER_VISIBLE_AMOUNT,
      _parseTreeTtnameForTest: parseTreeTtname,
      _resolveTreeCellForTest: resolveTreeCellGL,
      _treeGraphicsCellsForTest: treeGraphicsCellsGL,
      // test hooks (the same fixture-replay convention as dwf-tiles.js's)
      _buildingEntryForTest: buildingEntryGL,
      _statueEntryForTest: statueEntryGL,
      _plannedConstructionEntryForTest: plannedConstructionEntryGL,
      _constructionPlannedTokenForTest: window.DwfConstructionSelect && window.DwfConstructionSelect.PLANNED_TOKENS,
      _bridgeTileIndexForTest: bridgeTileIndexGL,
      _bridgeEntryForTest: bridgeEntryGL,
      _machineEntryForTest: machineEntryGL,   // (b, buildingMap, frameParity) -> synth entry|null
      _hasDrawableMachineForTest: hasDrawableMachineGL,
      _machineCadenceStepForTest: machineCadenceStepGL,
      _farmPlotEntryForTest: farmPlotEntryGL,  // (b) -> furrowed/planted bed entry|null
      _farmCropPlansForTest: farmCropPlansGL,  // shared per-stage crop overlay plans
      _emitBuildingForTest: emitBuilding,
      // test hooks (same fixture-replay convention as every tier above).
      _resolveUnitTierForTest: resolveUnitTierForCtx,
      // test hooks (same fixture-replay convention as every tier above).
      _tokenCellForTest: tokenCell, _animAttrForTokenForTest: animAttrForToken,
      _emitShoreFoamForTest: emitShoreFoam,
      _liquidEdgeTokensForTest: function (t, gx, gy, lookupTile) { return liquidEdgeTokens(t, gx, gy, lookupTile, Adj); },
    };
  }

  function now() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  function animOffset(wallMs) {
    try {
      var c = (typeof window !== "undefined") && window.DFAnimClock;
      if (c && typeof c.offset === "function") return c.offset(wallMs) || 0;
    } catch (_e) { /* inert-graceful */ }
    return 0;
  }
  // A wall-rate clock (perf.now or Date.now epoch) with paused spans removed.
  function worldNow(wallMs) {
    var b = (typeof wallMs === "number" && isFinite(wallMs)) ? wallMs : now();
    return b - animOffset(b);
  }
  function machineNow() {
    return worldNow(Date.now());
  }

  // ---- GL PIPELINE (browser only) ------------------------------------------------------------

  var VERT_SRC =
    "#version 300 es\n" +
    "layout(location=0) in vec2 i_grid;\n" +          // grid (gx,gy)
    "layout(location=1) in uvec2 i_cellAttr;\n" +     // x=atlasCell, y=attr
    "layout(location=2) in vec4 i_tint;\n" +          // normalized rgba
    "uniform vec2 u_scroll;\n" +                       // fractional world offset (pan)
    "uniform vec3 u_view;\n" +                         // cellPx, canvasWpx, canvasHpx
    "uniform float u_timeMs;\n" +
    "layout(std140) uniform RenderParams {\n" +
    "  vec4 designationLighten;\n" +
    "  vec4 grassRecolor;\n" +
    "  vec4 reserved0;\n" +
    "  vec4 seeDownTint;\n" +
    "  vec4 seeDownCurve;\n" +
    "} u_rp;\n" +
    "out vec3 v_uvp;\n" +
    "out vec4 v_tint;\n" +
    "flat out uint v_attr;\n" +
    "flat out uint v_solid;\n" +
    "void main(){\n" +
    "  int vid = gl_VertexID;\n" +
    "  vec2 corner = vec2(float(vid==1||vid==4||vid==5), float(vid==2||vid==3||vid==5));\n" +
    "  vec2 tilePx = (i_grid - u_scroll + corner) * u_view.x;\n" +
    "  vec2 clip = vec2(tilePx.x / u_view.y * 2.0 - 1.0, 1.0 - tilePx.y / u_view.z * 2.0);\n" +
    "  gl_Position = vec4(clip, 0.0, 1.0);\n" +
    "  uint cell = i_cellAttr.x;\n" +
    "  v_attr = i_cellAttr.y;\n" +
    "  v_tint = i_tint;\n" +
    "  if (cell == 65535u) { v_solid = 1u; v_uvp = vec3(0.0); }\n" +
    "  else {\n" +
    "    v_solid = 0u;\n" +
    "    uint frameCount = (v_attr & 0xFu) + 1u;\n" +
    "    if (frameCount > 1u && u_rp.reserved0.w > 0.5) {\n" +
    "      uint rateCode = (v_attr >> 4u) & 0x7u;\n" +
    "      float hzTable[8] = float[8](2.0, 4.0, 8.0, 15.0, 2.0, 4.0, 8.0, 15.0);\n" +
    "      float hz = hzTable[rateCode];\n" +
    "      uint gxu = uint(i_grid.x);\n" +
    "      uint gyu = uint(i_grid.y);\n" +
    "      uint h = gxu * 374761393u + gyu * 668265263u;\n" +
    "      h = (h ^ (h >> 13u)) * 1274126177u;\n" +
    "      h = h ^ (h >> 16u);\n" +
    "      float phase = float(h % 1009u) / 1009.0;\n" +
    "      float adv = (u_timeMs / 1000.0) * hz + phase * float(frameCount);\n" +
    "      uint frameIdx = uint(mod(floor(adv), float(frameCount)));\n" +
    "      cell = cell + frameIdx;\n" +
    "    }\n" +
    "    float idx = float(cell);\n" +
    "    float page = floor(idx / 3600.0);\n" +
    "    float local = idx - page * 3600.0;\n" +
    "    float ccol = mod(local, 60.0);\n" +
    "    float crow = floor(local / 60.0);\n" +
    "    vec2 originPx = vec2(ccol, crow) * 34.0 + 1.0;\n" +
    "    vec2 uv = (originPx + corner * 32.0) / 2048.0;\n" +
    "    v_uvp = vec3(uv, page);\n" +
    "  }\n" +
    "}\n";

  var FRAG_SRC =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "precision highp sampler2DArray;\n" +
    "uniform sampler2DArray u_atlas;\n" +
    "layout(std140) uniform RenderParams {\n" +
    "  vec4 designationLighten;\n" +
    "  vec4 grassRecolor;\n" +
    "  vec4 reserved0;\n" +
    "  vec4 seeDownTint;\n" +
    // Only seeDownCurve.x is read -- the intercept added before seeDownTint.a * depth; y/z/w are
    // unwired std140 padding.
    "  vec4 seeDownCurve;\n" +
    "} u_rp;\n" +
    "in vec3 v_uvp;\n" +
    "in vec4 v_tint;\n" +
    "flat in uint v_attr;\n" +
    "flat in uint v_solid;\n" +
    "out vec4 o;\n" +
    "void main(){\n" +
    "  vec4 base;\n" +
    "  if (v_solid == 1u) { base = vec4(v_tint.rgb * v_tint.a, v_tint.a); }\n" +
    "  else { vec4 s = texture(u_atlas, v_uvp); base = vec4(s.rgb * v_tint.rgb * v_tint.a, s.a * v_tint.a); }\n" +
    "  uint seeDownDepth = (v_attr >> 9u) & 0xFu;\n" +
    "  if (seeDownDepth > 0u && u_rp.seeDownTint.a > 0.0) {\n" +
    "    float amt = clamp(u_rp.seeDownCurve.x + float(seeDownDepth) * u_rp.seeDownTint.a, 0.0, 1.0);\n" +
    "    base.rgb = mix(base.rgb, u_rp.seeDownTint.rgb * base.a, amt);\n" +
    "  }\n" +
    "  if (((v_attr >> 7u) & 1u) == 1u) {\n" +  // ADDITIVE: rgb carries the add, a=0
    "    base.rgb += u_rp.designationLighten.rgb;\n" +
    "    base.a = 0.0;\n" +
    "  }\n" +
    "  o = base;\n" +
    "}\n";

  function compileProgram(gl) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error("shader compile failed: " + log);
      }
      return s;
    }
    var vs = sh(gl.VERTEX_SHADER, VERT_SRC);
    var fs = sh(gl.FRAGMENT_SHADER, FRAG_SRC);
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log2 = gl.getProgramInfoLog(p);
      throw new Error("program link failed: " + log2);
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    return p;
  }

  function defaultRenderParams() {
    return {
      designationLighten: [27 / 255, 29 / 255, 26 / 255, 0], // additive, a unused
      grassRecolor: [78 / 255, 104 / 255, 52 / 255, 1],       // measured summer target, a=blend enable
      // reserved0.w defaults to 1 (animation ON); 0 is the global kill-switch, not the default state.
      reserved0: [0, 0, 0, 1],
      seeDownTint: [88 / 255, 138 / 255, 158 / 255, 0.1057],
      // x is that same fit's intercept: the measured curve is concave, not linear through the origin.
      seeDownCurve: [0.2464, 0, 0, 0],
    };
  }

  function create(gl, opts) {
    opts = opts || {};
    var warn = opts.warn || (typeof console !== "undefined" ? function (m) { console.warn(m); } : function () {});
    var builder = createSceneBuilder(opts);

    var glResources = null;   // {program, vao, vbo, ubo, locs} -- recreated on context restore
    var vboCapacityBytes = 0;
    var instanceCount = 0;
    // Everything but the dynamic units/projectiles/flows tail, reported separately so the reveal
    // gate cannot be satisfied by units alone.
    var staticInstanceCount = 0;
    var pendingStaticBuffer = null;
    var pendingStaticCount = 0;
    var pendingStaticStart = 0;
    var pendingStaticEnd = 0;
    var staticBaseInstances = 0; // last-uploaded static count (== the units tail's GPU offset)
    // units tail, restaged on every tickUnits() call, independent of the key buildScene() gates on.
    var pendingUnitsCount = 0;
    // Native motion (snap-to-tile) is the default; the seam passes smoothMotion only when asked for.
    var unitInterp = createUnitInterpolator({ smooth: !!opts.smoothMotion });
    var lastUnitsRef = null;    // identity of the last units[] array ingest()ed (dedupe re-ingest)
    var lastUnitXY = new Map(); // unit id -> {x,y} last TICK's rendered position (motion counter)
    var renderParams = defaultRenderParams();
    // QA-only kill switch: seeDownTint.a/seeDownCurve.x AND the module-level FOG_DISABLED must both
    // go, or belowAlpha() still dims units, buildings and projectiles CPU-side.
    if (opts.nofog) {
      FOG_DISABLED = true;
      renderParams.seeDownTint = renderParams.seeDownTint.slice(0, 4);
      renderParams.seeDownTint[3] = 0;
      renderParams.seeDownCurve = renderParams.seeDownCurve.slice(0, 4);
      renderParams.seeDownCurve[0] = 0;
    }
    var camera = { cell: 16, canvasW: 0, canvasH: 0 };
    var scroll = { x: 0, y: 0 };
    var contextLost = false;
    var freezeAnim = !!opts.freezeAnim;
    var lastSceneView = null;
    var lastMachineAnimPhase = -1;
    var lastDesignationBlinkPhase = -1;
    // builtRect is world-space, half-open, and aligned to 16x16 cache chunks with one chunk of margin.
    var builtRect = null;
    var builtRectVersion = null;
    var builtZ = null, builtViewportW = 0, builtViewportH = 0;
    var firstSceneInput = null, firstBuiltRect = null;
    var lastCameraOrigin = null;
    var lastBuiltSceneView = null;
    var lastBuildingFingerprint = null, lastOverlayFingerprint = null;
    // The chunk list is remembered so a pile that shrinks or is removed can repaint what it vacated.
    var lastStockpileFingerprint = null, lastStockpileChunkKeys = [];
    var sceneInvalidated = false;
    var chunkPatchingEnabled = true;
    var unsubscribeDirty = null;
    var patchSamples = [];
    var gpuDiagAt = -Infinity;
    var gpuDiagCached = { available: false, comparedBytes: 0, mismatchBytes: 0, firstMismatch: -1 };

    var stats = {
      renderer: "gl", sceneBuildCount: 0, lastBuildMs: 0, lastBuildInstances: 0,
      drawCount: 0, uploadBytes: 0, contextLosses: 0, atlasPages: 0,
      panReuseCount: 0, buildingBuildCount: 0, lastBuildingBuildMs: 0,
      overlayBuildCount: 0, lastOverlayBuildMs: 0,
      chunkPatchCount: 0, chunkBuildCount: 0, lastPatchMs: 0,
      lastPatchBatchMs: 0, lastPatchChunks: 0,
      unitTrackedCount: 0, unitInstances: 0, unitPositionSamples: 0,
    };

    if (opts.cacheReader && typeof opts.cacheReader.onDirty === "function") {
      unsubscribeDirty = opts.cacheReader.onDirty(handleCacheDirty);
    }

    function buildGLResources() {
      var program = compileProgram(gl);
      var vao = gl.createVertexArray();
      var vbo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      // location 0: vec2 grid (f32) @0
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, INSTANCE_BYTES, 0);
      gl.vertexAttribDivisor(0, 1);
      // location 1: uvec2 cell/attr (u16) @8
      gl.enableVertexAttribArray(1);
      gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_SHORT, INSTANCE_BYTES, 8);
      gl.vertexAttribDivisor(1, 1);
      // location 2: vec4 tint (u8 normalized) @12
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, INSTANCE_BYTES, 12);
      gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(null);

      var ubo = gl.createBuffer();
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferData(gl.UNIFORM_BUFFER, 80, gl.DYNAMIC_DRAW); // 5 vec4 std140 (+seeDownTint/seeDownCurve)
      var blockIndex = gl.getUniformBlockIndex(program, "RenderParams");
      if (blockIndex !== 0xFFFFFFFF && blockIndex !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(program, blockIndex, 0);
      }
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);

      var locs = {
        u_scroll: gl.getUniformLocation(program, "u_scroll"),
        u_view: gl.getUniformLocation(program, "u_view"),
        u_atlas: gl.getUniformLocation(program, "u_atlas"),
        u_timeMs: gl.getUniformLocation(program, "u_timeMs"),
      };
      glResources = { program: program, vao: vao, vbo: vbo, ubo: ubo, locs: locs };
      vboCapacityBytes = 0;
      uploadRenderParams();
    }

    function uploadRenderParams() {
      if (!glResources) return;
      var rp = renderParams;
      var arr = new Float32Array(20); // 5 vec4 (+seeDownTint/seeDownCurve)
      arr.set(rp.designationLighten, 0);
      arr.set(rp.grassRecolor, 4);
      arr.set(rp.reserved0, 8);
      arr.set(rp.seeDownTint, 12);
      arr.set(rp.seeDownCurve, 16);
      gl.bindBuffer(gl.UNIFORM_BUFFER, glResources.ubo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, arr);
    }

    function paddedRect(view) {
      var o = view.origin || { x: 0, y: 0 };
      var w = view.width | 0, h = view.height | 0;
      if (!(opts.cacheReader && typeof opts.cacheReader.windowView === "function")) {
        return { x0: o.x, y0: o.y, x1: o.x + w, y1: o.y + h };
      }
      var x0 = Math.floor(o.x / 16) * 16 - 16;
      var y0 = Math.floor(o.y / 16) * 16 - 16;
      var x1 = Math.ceil((o.x + w) / 16) * 16 + 16;
      var y1 = Math.ceil((o.y + h) / 16) * 16 + 16;
      return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    function rectContainsView(rect, view) {
      if (!rect || !view || !view.origin) return false;
      var o = view.origin;
      return o.x >= rect.x0 && o.y >= rect.y0 &&
        o.x + (view.width | 0) <= rect.x1 && o.y + (view.height | 0) <= rect.y1;
    }

    // world_seq is monotonic for ordinary changes, but every block in a cold snapshot may share one.
    // Include the local chunk generation, or a same-seq placeholder replacement compares equal.
    function rectVersion(rect, z, fallback) {
      var cr = opts.cacheReader;
      if (!rect || !cr || typeof cr.getChunk !== "function") return fallback;
      var maxv = 0;
      var coverage = 2166136261 >>> 0;
      var bx0 = Math.floor(rect.x0 / 16), bx1 = Math.ceil(rect.x1 / 16) - 1;
      var by0 = Math.floor(rect.y0 / 16), by1 = Math.ceil(rect.y1 / 16) - 1;
      var z0 = Math.max(0, (z | 0) - MAX_SEEDOWN_DEPTH);
      for (var zz = z0; zz <= (z | 0); zz++) {
        for (var bx = bx0; bx <= bx1; bx++) {
          for (var by = by0; by <= by1; by++) {
            var key = bx * 4096 + by;
            var chunk = cr.getChunk(zz, key);
            var revision = chunk && typeof cr.chunkRevision === "function"
              ? cr.chunkRevision(zz, key) : (chunk ? 1 : 0);
            coverage = Math.imul(coverage ^ revision, 16777619) >>> 0;
            if (chunk && chunk.ver > maxv) maxv = chunk.ver;
          }
        }
      }
      return maxv + ":" + coverage;
    }

    function viewForRect(view, rect) {
      var cr = opts.cacheReader;
      if (!cr || typeof cr.windowView !== "function") return view;
      var z = view.origin && view.origin.z;
      var decoded = cr.windowView(rect.x0, rect.y0, z, rect.x1 - rect.x0, rect.y1 - rect.y0);
      return Object.assign({}, view, decoded, {
        origin: { x: rect.x0, y: rect.y0, z: z },
        width: rect.x1 - rect.x0,
        height: rect.y1 - rect.y0,
      });
    }

    function terrainOrderForRect(rect, z) {
      var order = [];
      var bx0 = Math.floor(rect.x0 / 16), bx1 = Math.ceil(rect.x1 / 16) - 1;
      var by0 = Math.floor(rect.y0 / 16), by1 = Math.ceil(rect.y1 / 16) - 1;
      for (var by = by0; by <= by1; by++) {
        for (var bx = bx0; bx <= bx1; bx++) order.push(builder.terrainSegmentId(bx, by, z));
      }
      return order;
    }

    function chunkIntersectsRect(bx, by, rect) {
      return bx * 16 < rect.x1 && (bx + 1) * 16 > rect.x0 &&
        by * 16 < rect.y1 && (by + 1) * 16 > rect.y0;
    }

    function chunkPatchView(bx, by, z) {
      var cr = opts.cacheReader;
      if (!cr || typeof cr.windowView !== "function") return null;
      var view = cr.windowView(bx * 16 - 1, by * 16 - 1, z, 18, 18);
      if (view && !Array.isArray(view.buildings)) view.buildings = currentBuildings();
      return view;
    }
    // lastSceneView is updated at the top of every buildScene() AND by updateSceneSegments, so it leads
    // lastBuiltSceneView whenever a payload-only change arrives without a rebuild.
    function currentBuildings() {
      var v = lastSceneView && Array.isArray(lastSceneView.buildings) ? lastSceneView
        : (lastBuiltSceneView && Array.isArray(lastBuiltSceneView.buildings) ? lastBuiltSceneView : null);
      return v ? v.buildings : [];
    }

    function overlayTileFold(t) {
      if (!t) return "";
      var d = t.desig || {}, p = t.desigPriority || {};
      return [t.tt, t.shape, t.mat, d.dig, d.smooth, d.traffic, d.track,
        d.marker ? 1 : 0, p.priority].join("|");
    }

    function foldChunkIntoBuiltView(patch) {
      var full = lastBuiltSceneView;
      if (!full || !full.origin || !patch || !patch.view) return false;
      var pv = patch.view, changed = false;
      for (var wy = patch.by * 16; wy < (patch.by + 1) * 16; wy++) {
        for (var wx = patch.bx * 16; wx < (patch.bx + 1) * 16; wx++) {
          var fgx = wx - full.origin.x, fgy = wy - full.origin.y;
          if (fgx < 0 || fgy < 0 || fgx >= full.width || fgy >= full.height) continue;
          var pgx = wx - pv.origin.x, pgy = wy - pv.origin.y;
          var fi = fgy * full.width + fgx, pi = pgy * pv.width + pgx;
          var next = pv.tiles[pi] || null, prev = full.tiles[fi] || null;
          if (overlayTileFold(prev) !== overlayTileFold(next)) changed = true;
          full.tiles[fi] = next;
        }
      }
      return changed;
    }

    function recordPatch(chunkMs, batchMs) {
      chunkMs = chunkMs || [];
      stats.chunkPatchCount += chunkMs.length;
      stats.chunkBuildCount += chunkMs.length;
      stats.lastPatchMs = chunkMs.length ? chunkMs[chunkMs.length - 1] : 0;
      stats.lastPatchBatchMs = batchMs;
      stats.lastPatchChunks = chunkMs.length;
      for (var i = 0; i < chunkMs.length; i++) patchSamples.push(chunkMs[i]);
      while (patchSamples.length > 120) patchSamples.shift();
    }

    function patchP95() {
      if (!patchSamples.length) return 0;
      var sorted = patchSamples.slice().sort(function (a, b) { return a - b; });
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    }

    // A lower-z dirty block can change the camera-plane see-down composite: keys within
    // MAX_SEEDOWN_DEPTH of builtZ patch their camera-plane chunk plus its 3x3 neighbourhood.
    function handleCacheDirty(dirtyZ, keys) {
      if (!chunkPatchingEnabled || !builtRect || !lastBuiltSceneView || sceneInvalidated) return;
      if (dirtyZ > builtZ || dirtyZ < Math.max(0, builtZ - MAX_SEEDOWN_DEPTH)) return;
      keys = Array.isArray(keys) ? keys : [];
      var targets = new Map();
      for (var i = 0; i < keys.length; i++) {
        var key = Number(keys[i]);
        if (!isFinite(key)) continue;
        var bx = Math.floor(key / 4096), by = key - bx * 4096;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = bx + dx, ny = by + dy;
            if (!chunkIntersectsRect(nx, ny, builtRect) || !builder.hasTerrainSegment(nx, ny, builtZ)) continue;
            targets.set(nx + ":" + ny, { bx: nx, by: ny, z: builtZ });
          }
        }
      }
      if (!targets.size) return;
      var t0 = now(), patches = [], overlayChanged = false;
      for (var target of targets.values()) {
        var pv = chunkPatchView(target.bx, target.by, builtZ);
        if (!pv) continue;
        var patch = { bx: target.bx, by: target.by, z: builtZ, view: pv };
        overlayChanged = foldChunkIntoBuiltView(patch) || overlayChanged;
        patches.push(patch);
      }
      if (!patches.length) return;
      var r = builder.patchTerrainChunks(patches, lastBuiltSceneView);
      stageStaticRange(r.dirtyStart, r.dirtyEnd);
      if (overlayChanged && lastSceneView) rebuildOverlaySegment(lastSceneView, Date.now());
      builtRectVersion = rectVersion(builtRect, builtZ, builtRectVersion);
      recordPatch(r.chunkMs, now() - t0);
    }

    function hashText(h, value) {
      var s = value == null ? "" : String(value);
      for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
      return h;
    }
    function hashNum(h, value) {
      var n = (typeof value === "number" && isFinite(value)) ? value : -2147483648;
      return Math.imul(h ^ (n | 0), 16777619) >>> 0;
    }
    function buildingFingerprint(list) {
      list = Array.isArray(list) ? list : [];
      var h = hashNum(2166136261, list.length);
      for (var i = 0; i < list.length; i++) {
        var b = list[i] || {};
        h = hashText(h, b.type); h = hashNum(h, b.id); h = hashNum(h, b.subtype);
        h = hashNum(h, b.x1); h = hashNum(h, b.y1); h = hashNum(h, b.x2); h = hashNum(h, b.y2);
        h = hashNum(h, b.z); h = hashNum(h, b.dir); h = hashNum(h, b.bst);
        h = hashNum(h, b.stage); h = hashNum(h, b.bextra);
        var crgb = b.crgb || [], rgb = b.rgb || [];
        h = hashNum(h, Array.isArray(b.crgb) ? 1 : 0);
        h = hashNum(h, crgb[0]); h = hashNum(h, crgb[1]); h = hashNum(h, crgb[2]);
        h = hashNum(h, Array.isArray(b.rgb) ? 1 : 0);
        h = hashNum(h, rgb[0]); h = hashNum(h, rgb[1]); h = hashNum(h, rgb[2]);
      }
      return h;
    }
    // ---- the stockpile art's own invalidation key ---------------------------------------------
    function stockpileFingerprint(list) {
      list = Array.isArray(list) ? list : [];
      var h = 2166136261 >>> 0, n = 0;
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b || b.type !== "Stockpile") continue;
        n++;
        h = hashNum(h, b.id); h = hashNum(h, b.x1); h = hashNum(h, b.y1);
        h = hashNum(h, b.x2); h = hashNum(h, b.y2); h = hashNum(h, b.z);
        h = hashText(h, b.ext);
      }
      h = hashNum(h, n);
      // a staged repaint changes the drawn shape without touching the payload at all
      try {
        if (typeof window !== "undefined" && window.DwfPaintSession)
          h = hashNum(h, window.DwfPaintSession.revision());
      } catch (_) { /* no session module -> committed shapes only */ }
      return h;
    }
    function stockpileChunkKeys(buildings, z) {
      var keys = [];
      var B = (typeof window !== "undefined") && window.DwfOverlayBoxes;
      if (!B || typeof B.stockpileLayerIndex !== "function") return keys;
      var idx;
      try { idx = B.stockpileLayerIndex(buildings || [], z); } catch (_) { return keys; }
      var seen = new Set();
      for (var e of idx.values()) {
        var bx = Math.floor(e.wx / 16), by = Math.floor(e.wy / 16), k = bx + ":" + by;
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push({ bx: bx, by: by });
      }
      return keys;
    }
    function patchStockpileTerrain(view) {
      if (!chunkPatchingEnabled || !builtRect || !lastBuiltSceneView || sceneInvalidated) return;
      var buildings = (view && Array.isArray(view.buildings)) ? view.buildings : currentBuildings();
      var fp = stockpileFingerprint(buildings);
      if (fp === lastStockpileFingerprint) return;
      var z = builtZ;
      var next = stockpileChunkKeys(buildings, z);
      var targets = new Map();
      function want(bx, by) {
        if (!chunkIntersectsRect(bx, by, builtRect)) return;
        if (!builder.hasTerrainSegment(bx, by, z)) return;
        targets.set(bx + ":" + by, { bx: bx, by: by });
      }
      // OLD union NEW: a pile that shrank or was removed must repaint the chunks it vacated, or its rope
      // is left stranded on tiles that are no longer members.
      for (var i = 0; i < lastStockpileChunkKeys.length; i++)
        want(lastStockpileChunkKeys[i].bx, lastStockpileChunkKeys[i].by);
      for (var j = 0; j < next.length; j++) want(next[j].bx, next[j].by);
      lastStockpileFingerprint = fp;
      lastStockpileChunkKeys = next;
      if (!targets.size) return;
      var t0 = now(), patches = [];
      for (var target of targets.values()) {
        var pv = chunkPatchView(target.bx, target.by, z);
        if (!pv) continue;
        pv.buildings = buildings;
        patches.push({ bx: target.bx, by: target.by, z: z, view: pv });
      }
      if (!patches.length) return;
      var r = builder.patchTerrainChunks(patches, lastBuiltSceneView);
      stageStaticRange(r.dirtyStart, r.dirtyEnd);
      recordPatch(r.chunkMs, now() - t0);
      // Deliberately NOT bumping builtRectVersion and NOT folding tiles into the built view: no cache
      // block changed, and bumping it would re-key every later reuse decision off a fiction.
    }

    function overlayFingerprint(players, djobs) {
      players = Array.isArray(players) ? players : [];
      djobs = Array.isArray(djobs) ? djobs : [];
      var h = hashNum(2166136261, players.length);
      for (var i = 0; i < players.length; i++) {
        var p = players[i] || {};
        h = hashText(h, p.name); h = hashNum(h, p.x); h = hashNum(h, p.y); h = hashNum(h, p.z);
        h = hashNum(h, p.drag ? 1 : 0); h = hashNum(h, p.dx); h = hashNum(h, p.dy);
      }
      h = hashNum(h, djobs.length);
      for (var j = 0; j < djobs.length; j++) {
        var d = djobs[j] || {};
        h = hashNum(h, d.x); h = hashNum(h, d.y); h = hashNum(h, d.z); h = hashText(h, d.k);
        h = hashNum(h, d.w ? 1 : 0);
      }
      return h;
    }

    function stageStaticRange(start, end) {
      if (pendingStaticBuffer === null) {
        pendingStaticStart = start;
        pendingStaticEnd = end;
      } else {
        pendingStaticStart = Math.min(pendingStaticStart, start);
        pendingStaticEnd = Math.max(pendingStaticEnd, end);
      }
      pendingStaticBuffer = builder.buffer;
      pendingStaticCount = builder.staticCount;
    }

    // Three outcomes when sameBasis holds: an unchanged rectVersion reuses outright if the view is
    // inside builtRect, reframes onto a new padded rect if not; a changed one is a full rebuild.
    function buildScene(view) {
      lastSceneView = view || null;
      if (!view || !view.origin) return { count: 0, bytes: 0, ms: 0 };
      var o = view.origin;
      if (!firstSceneInput) {
        firstSceneInput = {
          x: o.x, y: o.y, z: o.z,
          width: view.width | 0, height: view.height | 0,
        };
      }
      scroll.x = o.x; scroll.y = o.y;
      var originChanged = !!lastCameraOrigin &&
        (o.x !== lastCameraOrigin.x || o.y !== lastCameraOrigin.y);
      lastCameraOrigin = { x: o.x, y: o.y, z: o.z };
      var canPatch = !!(opts.cacheReader && typeof opts.cacheReader.windowView === "function" &&
        typeof opts.cacheReader.getChunk === "function");
      var sameBasis = canPatch && !sceneInvalidated && !!builtRect && builtZ === o.z;
      var currentRectVersion = sameBasis
        ? rectVersion(builtRect, o.z, view.contentVersion)
        : null;
      if (sameBasis && rectContainsView(builtRect, view) && currentRectVersion === builtRectVersion) {
        if (originChanged) stats.panReuseCount++;
        updateSceneSegments(view);
        return { count: builder.staticCount, bytes: 0, ms: 0, reused: true };
      }
      var nextRect = (sameBasis && rectContainsView(builtRect, view)) ? builtRect : paddedRect(view);

      if (sameBasis && !rectContainsView(builtRect, view) && currentRectVersion === builtRectVersion) {
        var shiftedView = viewForRect(view, nextRect);
        var nextOrder = terrainOrderForRect(nextRect, o.z);
        var entering = [];
        var enteringSeeds = [];
        var bx0 = Math.floor(nextRect.x0 / 16), bx1 = Math.ceil(nextRect.x1 / 16) - 1;
        var by0 = Math.floor(nextRect.y0 / 16), by1 = Math.ceil(nextRect.y1 / 16) - 1;
        for (var by = by0; by <= by1; by++) {
          for (var bx = bx0; bx <= bx1; bx++) {
            if (!builder.hasTerrainSegment(bx, by, o.z)) enteringSeeds.push({ bx: bx, by: by });
          }
        }
        // An entering chunk changes border-neighbour inputs for the retained chunks beside it, so the
        // seed's whole 3x3 neighbourhood is rebuilt, not just the entering chunk.
        var enteringTargets = new Map();
        for (var si = 0; si < enteringSeeds.length; si++) {
          var seed = enteringSeeds[si];
          for (var sy = -1; sy <= 1; sy++) {
            for (var sx = -1; sx <= 1; sx++) {
              var tx = seed.bx + sx, ty = seed.by + sy;
              if (tx < bx0 || tx > bx1 || ty < by0 || ty > by1) continue;
              enteringTargets.set(tx + ":" + ty, { bx: tx, by: ty });
            }
          }
        }
        for (var target of enteringTargets.values()) {
          var cv = chunkPatchView(target.bx, target.by, o.z);
          if (cv) entering.push({ bx: target.bx, by: target.by, z: o.z, view: cv });
        }
        var rr = builder.patchTerrainChunks(entering, shiftedView, nextOrder);
        stageStaticRange(rr.dirtyStart, rr.dirtyEnd);
        lastBuiltSceneView = shiftedView;
        builtRect = nextRect;
        builtRectVersion = rectVersion(nextRect, o.z, view.contentVersion);
        builtViewportW = view.width | 0; builtViewportH = view.height | 0;
        stats.panReuseCount++;
        stats.chunkBuildCount += entering.length;
        var shiftedBfp = buildingFingerprint(view.buildings);
        if (shiftedBfp !== lastBuildingFingerprint) {
          rebuildBuildingSegment(view, machineNow(), freezeAnim || !!view.freezeAnim);
          lastBuildingFingerprint = shiftedBfp;
        }
        rebuildOverlaySegment(view, now()); // perf-epoch designation clock (matches render/tickUnits)
        lastOverlayFingerprint = overlayFingerprint(view.players, view.djobs);
        patchStockpileTerrain(view);
        return { count: builder.staticCount, bytes: rr.bytes, ms: rr.ms, reused: true, reframed: true };
      }
      var sceneView = viewForRect(view, nextRect);
      var nowMs = machineNow();   // machine-frame clock (freezes on game pause)
      var viewFreezeAnim = freezeAnim || !!(view && view.freezeAnim);
      var buildView = sceneView;
      if (sceneView) {
        buildView = Object.assign({}, sceneView, {
          machineParity: (typeof sceneView.machineParity === "number")
            ? sceneView.machineParity : machineFrameParityGL(nowMs, viewFreezeAnim),
          designationNowMs: now(),
        });
      }
      var r = builder.buildScene(buildView);
      pendingStaticBuffer = builder.buffer;
      pendingStaticCount = r.count;
      pendingStaticStart = 0;
      pendingStaticEnd = r.count;
      var mstep = machineCadenceStepGL(view && view.buildings, nowMs, lastMachineAnimPhase, viewFreezeAnim);
      lastMachineAnimPhase = mstep.phase;
      builtRect = nextRect;
      builtRectVersion = rectVersion(nextRect, o.z, view.contentVersion);
      builtZ = o.z; builtViewportW = view.width | 0; builtViewportH = view.height | 0;
      if (!firstBuiltRect) {
        firstBuiltRect = {
          x0: nextRect.x0, y0: nextRect.y0, x1: nextRect.x1, y1: nextRect.y1, z: o.z,
        };
      }
      sceneInvalidated = false;
      lastBuiltSceneView = buildView;
      lastBuildingFingerprint = buildingFingerprint(view.buildings);
      lastOverlayFingerprint = overlayFingerprint(view.players, view.djobs);
      // The full build just drew the current stockpile art, so re-seed the key rather than leave it stale.
      lastStockpileFingerprint = stockpileFingerprint(view.buildings);
      lastStockpileChunkKeys = stockpileChunkKeys(view.buildings, o.z);
      stats.sceneBuildCount++;
      stats.lastBuildMs = r.ms;
      stats.lastBuildInstances = r.count;
      return r;
    }

    function rebuildBuildingSegment(view, nowMs, viewFreezeAnim) {
      // Buildings arrive through AUX but crops arrive through block tails: keep crop extraction on the
      // retained padded scene basis and overlay only the fresh AUX building snapshot.
      var buildView = buildingRebuildViewGL(lastBuiltSceneView, view);
      if (buildView && typeof buildView.machineParity !== "number") {
        buildView = Object.assign({}, buildView, { machineParity: machineFrameParityGL(nowMs, viewFreezeAnim) });
      }
      var r = builder.rebuildBuildings(buildView);
      stageStaticRange(r.dirtyStart, r.dirtyEnd);
      stats.buildingBuildCount++;
      stats.lastBuildingBuildMs = r.ms;
      return r;
    }

    function rebuildOverlaySegment(view, nowMs) {
      var overlayView = lastBuiltSceneView
        ? Object.assign({}, lastBuiltSceneView, {
          // Units ride along so each beat's "worker ON the tile" decision sees current positions.
          players: view.players || [], djobs: view.djobs || [], units: view.units || [],
          designationNowMs: nowMs,
        })
        : Object.assign({}, view, { designationNowMs: nowMs });
      var r = builder.rebuildOverlay(overlayView);
      stageStaticRange(r.dirtyStart, r.dirtyEnd);
      stats.overlayBuildCount++;
      stats.lastOverlayBuildMs = r.ms;
      return r;
    }

    // AUX invalidation seam: cheap content folds keep identity churn from rebuilding either segment.
    function updateSceneSegments(view) {
      if (!view) return;
      lastSceneView = view;
      if (view.origin) {
        lastCameraOrigin = { x: view.origin.x, y: view.origin.y, z: view.origin.z };
        scroll.x = view.origin.x; scroll.y = view.origin.y;
      }
      if (!builtRect) return;
      var bfp = buildingFingerprint(view.buildings);
      if (bfp !== lastBuildingFingerprint) {
        var nowMs = machineNow();   // machine-frame clock (freezes on game pause)
        var frozen = freezeAnim || !!view.freezeAnim;
        rebuildBuildingSegment(view, nowMs, frozen);
        lastBuildingFingerprint = bfp;
        var mstep = machineCadenceStepGL(view.buildings, nowMs, lastMachineAnimPhase, frozen);
        lastMachineAnimPhase = mstep.phase;
      }
      var ofp = overlayFingerprint(view.players, view.djobs);
      if (ofp !== lastOverlayFingerprint) {
        rebuildOverlaySegment(view, now()); // perf-epoch designation clock (matches render/tickUnits)
        lastOverlayFingerprint = ofp;
      }
      // The stockpile checker and rope live in the TERRAIN segment, which neither rebuild above touches.
      patchStockpileTerrain(view);
    }

    var FROZEN_ANIM_MS = 1000;
    function animFrozen() {
      return freezeAnim || !!(lastSceneView && lastSceneView.freezeAnim);
    }

    function updateUnits(units, nowMs) {
      if (units === lastUnitsRef) return;
      lastUnitsRef = units;
      if (animFrozen()) { unitInterp.ingest(units, FROZEN_ANIM_MS); return; }
      unitInterp.ingest(units, typeof nowMs === "number" ? nowMs : now());
    }

    var lastProjRef = null, lastProj = [];
    function updateProjectiles(projs) {
      if (projs === lastProjRef) return;
      lastProjRef = projs;
      lastProj = Array.isArray(projs) ? projs : [];
    }

    var lastFlowsRef = null, lastFlowsKey = null, lastFlows = [];
    function extractFlows(latest) {
      var out = [];
      var tiles = latest && latest.tiles;
      var w = latest && latest.width;
      if (!Array.isArray(tiles) || !(w > 0)) return out;
      var o = latest.origin || { x: 0, y: 0, z: 0 };
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        if (!t || !t.cloud || t.hidden) continue;
        if (typeof t.cloud.type !== "number" || !(t.cloud.density > 0)) continue;
        out.push({ x: o.x + (i % w), y: o.y + ((i / w) | 0),
                   depth: (typeof t.depth === "number") ? t.depth : 0,
                   type: t.cloud.type, density: t.cloud.density });
      }
      return out;
    }
    function updateFlows(latest) {
      if (!latest) { lastFlowsRef = null; lastFlowsKey = null; lastFlows = []; return; }
      var o = latest.origin || { x: 0, y: 0, z: 0 };
      var key = (typeof latest.contentVersion === "number")
        ? "v" + latest.contentVersion + "|" + o.x + "," + o.y + "," + o.z + "|" + latest.width + "x" + latest.height
        : null;
      if (key !== null ? key === lastFlowsKey : latest === lastFlowsRef) return;
      lastFlowsRef = latest; lastFlowsKey = key;
      lastFlows = extractFlows(latest);
    }

    function tickUnits(nowMs, ox, oy, camZ) {
      var t = animFrozen() ? FROZEN_ANIM_MS
        : (typeof nowMs === "number" ? nowMs : now());
      var list = unitInterp.tick(t);
      var r = builder.buildUnits(list, ox || 0, oy || 0, camZ, t);
      var rp = builder.buildProjectiles(lastProj, ox || 0, oy || 0, camZ);
      stats.projInstances = rp.count - r.count;
      // Flow clouds append after projectiles in the same tail; re-emitting per frame is what animates them.
      var rf = builder.buildFlows(lastFlows, t);
      pendingUnitsCount = rf.count;
      stats.flowInstances = rf.count - rp.count;
      stats.unitTrackedCount = list.length;
      stats.unitInstances = r.count;
      var moved = false;
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        var prev = lastUnitXY.get(u.id);
        if (!prev || prev.x !== u.x || prev.y !== u.y) { moved = true; lastUnitXY.set(u.id, { x: u.x, y: u.y }); }
      }
      if (moved) stats.unitPositionSamples++;
      return r;
    }

    function uploadIfPending() {
      if (!glResources) return;
      var haveStatic = pendingStaticBuffer !== null;
      var curStaticCount = haveStatic ? pendingStaticCount : staticBaseInstances;
      var totalCount = curStaticCount + pendingUnitsCount;
      var totalBytes = totalCount * INSTANCE_BYTES;
      gl.bindBuffer(gl.ARRAY_BUFFER, glResources.vbo);
      var grew = false;
      if (totalBytes > vboCapacityBytes) {
        vboCapacityBytes = Math.max(totalBytes, (vboCapacityBytes * 2) | 0);
        gl.bufferData(gl.ARRAY_BUFFER, vboCapacityBytes, gl.DYNAMIC_DRAW);
        grew = true;
      }
      var uploadedBytes = 0;
      if (totalBytes > 0) {
        if (grew) {
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(builder.buffer, 0, totalBytes));
          uploadedBytes += totalBytes;
        } else {
          if (haveStatic && pendingStaticEnd > pendingStaticStart) {
            var staticOffset = pendingStaticStart * INSTANCE_BYTES;
            var staticBytes = (pendingStaticEnd - pendingStaticStart) * INSTANCE_BYTES;
            gl.bufferSubData(gl.ARRAY_BUFFER, staticOffset,
              new Uint8Array(builder.buffer, staticOffset, staticBytes));
            uploadedBytes += staticBytes;
          }
          if (pendingUnitsCount > 0) {
            var unitsBase = curStaticCount * INSTANCE_BYTES;
            gl.bufferSubData(gl.ARRAY_BUFFER, unitsBase, new Uint8Array(builder.buffer, unitsBase, pendingUnitsCount * INSTANCE_BYTES));
            uploadedBytes += pendingUnitsCount * INSTANCE_BYTES;
          }
        }
      }
      if (haveStatic) { staticBaseInstances = pendingStaticCount; pendingStaticBuffer = null; }
      instanceCount = totalCount;
      staticInstanceCount = curStaticCount;
      stats.uploadBytes = uploadedBytes;
    }

    function setCamera(c) {
      if (typeof c.cell === "number") camera.cell = c.cell;
      if (typeof c.canvasW === "number") camera.canvasW = c.canvasW;
      if (typeof c.canvasH === "number") camera.canvasH = c.canvasH;
    }
    // Bench callers pass offsets RELATIVE to the camera, but u_scroll is world-space, so the camera
    // origin has to be added back here. Do not "simplify" this to a plain assignment.
    function setScroll(x, y) {
      scroll.x = (lastCameraOrigin ? lastCameraOrigin.x : 0) + (x || 0);
      scroll.y = (lastCameraOrigin ? lastCameraOrigin.y : 0) + (y || 0);
    }

    function setRenderParams(p) {
      // zero scene rebuild: only the UBO changes
      if (!p) return;
      if (p.designationLighten) renderParams.designationLighten = p.designationLighten.slice(0, 4);
      if (p.grassRecolor) renderParams.grassRecolor = p.grassRecolor.slice(0, 4);
      if (p.reserved0) renderParams.reserved0 = p.reserved0.slice(0, 4);
      if (p.seeDownTint) renderParams.seeDownTint = p.seeDownTint.slice(0, 4);
      if (p.seeDownCurve) renderParams.seeDownCurve = p.seeDownCurve.slice(0, 4);
      uploadRenderParams();
    }

    function render(ts) {
      if (contextLost || !glResources) return false;
      // machine frames ride the pause-aware world clock (frozen while the game is paused).
      var machineMs = machineNow();
      var mstep = machineCadenceStepGL(lastSceneView && lastSceneView.buildings, machineMs, lastMachineAnimPhase,
        freezeAnim || !!(lastSceneView && lastSceneView.freezeAnim));
      lastMachineAnimPhase = mstep.phase;
      if (mstep.dirty && lastSceneView) rebuildBuildingSegment(lastSceneView, machineMs,
        freezeAnim || !!lastSceneView.freezeAnim);
      var designationNowMs = (typeof ts === "number" && isFinite(ts)) ? ts : now();
      if (lastSceneView && hasBlinkingDesignationJob(lastSceneView.djobs)) {
        var designationPhase = Math.floor(designationNowMs / DESIG_ACTIVE_BLINK_MS);
        if (designationPhase !== lastDesignationBlinkPhase) {
          lastDesignationBlinkPhase = designationPhase;
          rebuildOverlaySegment(lastSceneView, designationNowMs);
        }
      } else {
        lastDesignationBlinkPhase = -1;
      }
      uploadIfPending();
      var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      gl.viewport(0, 0, w, h);
      gl.clearColor(BG[0] / 255, BG[1] / 255, BG[2] / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (instanceCount <= 0) { stats.drawCount++; return true; }
      gl.useProgram(glResources.program);
      gl.bindVertexArray(glResources.vao);
      if (opts.atlas && opts.atlas.setMinifying) opts.atlas.setMinifying(camera.cell < CELL_SIZE);
      var atlasTex = opts.atlas && opts.atlas.getTexture && opts.atlas.getTexture();
      if (atlasTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlasTex);
        gl.uniform1i(glResources.locs.u_atlas, 0);
      }
      gl.uniform2f(glResources.locs.u_scroll, scroll.x, scroll.y);
      gl.uniform3f(glResources.locs.u_view, camera.cell, w, h);
      gl.uniform1f(glResources.locs.u_timeMs, freezeAnim ? 0 : worldNow(typeof ts === "number" ? ts : now()));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);  // premultiplied alpha
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
      gl.bindVertexArray(null);
      stats.drawCount++;
      if (opts.atlas && opts.atlas.pageCount) stats.atlasPages = opts.atlas.pageCount();
      return true;
    }

    // Fallback policy on context loss belongs to the seam; these two hooks only keep GL state coherent.
    function handleLost() {
      contextLost = true;
      stats.contextLosses++;
      glResources = null;      // objects are invalid after loss
      vboCapacityBytes = 0;
      instanceCount = 0;
    }
    function handleRestored() {
      contextLost = false;
      buildGLResources();
      // Re-stage the FULL last-known scene so the next render() re-uploads it whole: context loss
      // invalidated the GPU-side VBO entirely.
      staticBaseInstances = 0;
      pendingUnitsCount = 0;
      if (builder.buffer && builder.count > 0) {
        pendingStaticBuffer = builder.buffer;
        pendingStaticCount = builder.staticCount;
        pendingStaticStart = 0;
        pendingStaticEnd = builder.staticCount;
        pendingUnitsCount = builder.count - builder.staticCount;
      }
    }

    function setMaps(m) { builder.setMaps(m); sceneInvalidated = true; }
    function invalidateScene() { sceneInvalidated = true; }

    function retainedCacheDiagnostics() {
      var cr = opts.cacheReader;
      var segments = builder.terrainSegmentStats ? builder.terrainSegmentStats() : [];
      var mismatches = [], hiddenChunks = [], voidChunks = [], missingSegments = 0;
      var retainedHiddenTotal = 0, cacheHiddenTotal = 0;
      var retainedVoidTotal = 0, cacheVoidTotal = 0;
      if (!cr || typeof cr.tileAt !== "function") {
        return {
          checked: 0, stale: 0, missing: 0, mismatches: mismatches,
          retainedHidden: 0, cacheHidden: 0, hiddenChunks: hiddenChunks,
          retainedVoid: 0, cacheVoid: 0, voidChunks: voidChunks,
        };
      }
      for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (!seg || seg.missing) { missingSegments++; continue; }
        var cacheSourceTiles = 0, cacheFingerprint = 2166136261 >>> 0, cacheHiddenTiles = 0;
        for (var gy = 0; gy < 16; gy++) {
          for (var gx = 0; gx < 16; gx++) {
            var t = cr.tileAt(seg.z, seg.bx * 16 + gx, seg.by * 16 + gy);
            if (t && typeof t.tt === "number" && t.tt >= 0) cacheSourceTiles++;
            if (t && t.hidden) cacheHiddenTiles++;
            cacheFingerprint = builder.foldTerrainTile(cacheFingerprint, t);
          }
        }
        retainedHiddenTotal += seg.hiddenTiles || 0;
        cacheHiddenTotal += cacheHiddenTiles;
        retainedVoidTotal += Math.max(0, 256 - (seg.sourceTiles || 0));
        cacheVoidTotal += Math.max(0, 256 - cacheSourceTiles);
        if (seg.hiddenTiles || cacheHiddenTiles) {
          hiddenChunks.push({
            bx: seg.bx, by: seg.by, z: seg.z,
            retainedHidden: seg.hiddenTiles || 0, cacheHidden: cacheHiddenTiles,
          });
        }
        if (seg.sourceTiles < 256 || cacheSourceTiles < 256) {
          voidChunks.push({
            bx: seg.bx, by: seg.by, z: seg.z,
            retainedVoid: Math.max(0, 256 - (seg.sourceTiles || 0)),
            cacheVoid: Math.max(0, 256 - cacheSourceTiles),
          });
        }
        if (cacheSourceTiles !== seg.sourceTiles ||
            cacheFingerprint !== seg.sourceFingerprint ||
            cacheHiddenTiles !== seg.hiddenTiles) {
          mismatches.push({
            bx: seg.bx, by: seg.by, z: seg.z,
            retained: seg.sourceTiles, cache: cacheSourceTiles,
            retainedFingerprint: seg.sourceFingerprint, cacheFingerprint: cacheFingerprint,
            retainedHidden: seg.hiddenTiles, cacheHidden: cacheHiddenTiles,
            resolved: seg.resolved, instances: seg.count, builds: seg.builds,
          });
        }
      }
      hiddenChunks.sort(function (a, b) {
        return Math.max(b.retainedHidden, b.cacheHidden) - Math.max(a.retainedHidden, a.cacheHidden);
      });
      voidChunks.sort(function (a, b) {
        return Math.max(b.retainedVoid, b.cacheVoid) - Math.max(a.retainedVoid, a.cacheVoid);
      });
      return {
        checked: segments.length, stale: mismatches.length,
        missing: missingSegments, mismatches: mismatches.slice(0, 12),
        retainedHidden: retainedHiddenTotal, cacheHidden: cacheHiddenTotal,
        hiddenChunks: hiddenChunks.slice(0, 12),
        retainedVoid: retainedVoidTotal, cacheVoid: cacheVoidTotal,
        voidChunks: voidChunks.slice(0, 12),
      };
    }

    function gpuStaticDiagnostics() {
      var diagNow = now();
      if (diagNow - gpuDiagAt < 750) return gpuDiagCached;
      gpuDiagAt = diagNow;
      var bytes = Math.max(0, staticBaseInstances * INSTANCE_BYTES);
      if (!opts.diagnosticReadback || !glResources || !bytes ||
          typeof gl.getBufferSubData !== "function") {
        gpuDiagCached = { available: false, comparedBytes: 0, mismatchBytes: 0, firstMismatch: -1 };
        return gpuDiagCached;
      }
      try {
        var gpuBytes = new Uint8Array(bytes);
        gl.bindBuffer(gl.ARRAY_BUFFER, glResources.vbo);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, gpuBytes);
        var cpuBytes = new Uint8Array(builder.buffer, 0, bytes);
        var mismatches = 0, first = -1;
        for (var i = 0; i < bytes; i++) {
          if (gpuBytes[i] === cpuBytes[i]) continue;
          if (first < 0) first = i;
          mismatches++;
        }
        gpuDiagCached = {
          available: true, comparedBytes: bytes,
          mismatchBytes: mismatches, firstMismatch: first,
        };
      } catch (err) {
        gpuDiagCached = {
          available: false, comparedBytes: bytes, mismatchBytes: -1, firstMismatch: -1,
          error: String(err && err.message || err),
        };
      }
      return gpuDiagCached;
    }

    function getStats(includeRetainedDiagnostics) {
      // Reveal-gate input, computed once per call.
      var terrRes = builder.terrainResolvedStats();
      var retainedDiag = includeRetainedDiagnostics ? retainedCacheDiagnostics()
        : { checked: 0, stale: 0, missing: 0, mismatches: [],
            retainedHidden: 0, cacheHidden: 0, hiddenChunks: [],
            retainedVoid: 0, cacheVoid: 0, voidChunks: [] };
      var gpuDiag = includeRetainedDiagnostics ? gpuStaticDiagnostics()
        : { available: false, comparedBytes: 0, mismatchBytes: 0, firstMismatch: -1 };
      return {
        renderer: stats.renderer, sceneBuildCount: stats.sceneBuildCount,
        lastBuildMs: +stats.lastBuildMs.toFixed(3), lastBuildInstances: stats.lastBuildInstances,
        drawCount: stats.drawCount, uploadBytes: stats.uploadBytes,
        contextLosses: stats.contextLosses, atlasPages: stats.atlasPages,
        instanceCount: instanceCount,
        // reveal-gate inputs, read by the render seam
        staticInstanceCount: staticInstanceCount,
        staticResolvedFraction: terrRes.total > 0 ? terrRes.resolved / terrRes.total : 0,
        terrainResolvedInstances: terrRes.resolved,
        terrainSourceTiles: terrRes.sourceTiles,
        retainedTerrainChecked: retainedDiag.checked,
        staleTerrainChunkCount: retainedDiag.stale,
        missingTerrainSegmentCount: retainedDiag.missing,
        staleTerrainChunks: retainedDiag.mismatches,
        retainedHiddenTileCount: retainedDiag.retainedHidden,
        cacheHiddenTileCount: retainedDiag.cacheHidden,
        hiddenTerrainChunks: retainedDiag.hiddenChunks,
        retainedVoidTileCount: retainedDiag.retainedVoid,
        cacheVoidTileCount: retainedDiag.cacheVoid,
        voidTerrainChunks: retainedDiag.voidChunks,
        gpuStaticAvailable: gpuDiag.available,
        gpuStaticComparedBytes: gpuDiag.comparedBytes,
        gpuStaticMismatchBytes: gpuDiag.mismatchBytes,
        gpuStaticFirstMismatch: gpuDiag.firstMismatch,
        cpuStaticInstances: builder.staticCount,
        gpuStaticInstances: staticBaseInstances,
        pendingStaticStart: pendingStaticBuffer !== null ? pendingStaticStart : -1,
        pendingStaticEnd: pendingStaticBuffer !== null ? pendingStaticEnd : -1,
        panReuseCount: stats.panReuseCount,
        buildingBuildCount: stats.buildingBuildCount,
        lastBuildingBuildMs: +stats.lastBuildingBuildMs.toFixed(3),
        overlayBuildCount: stats.overlayBuildCount,
        lastOverlayBuildMs: +stats.lastOverlayBuildMs.toFixed(3),
        chunkPatchCount: stats.chunkPatchCount,
        chunkBuildCount: stats.chunkBuildCount,
        lastPatchMs: +stats.lastPatchMs.toFixed(3),
        lastPatchBatchMs: +stats.lastPatchBatchMs.toFixed(3),
        patchP95Ms: +patchP95().toFixed(3),
        lastPatchChunks: stats.lastPatchChunks,
        terrainChunkCount: builtRect ? terrainOrderForRect(builtRect, builtZ).length : 0,
        terrainInstances: builder.terrainCount,
        buildingInstances: builder.buildingCount,
        cropInstances: builder.cropCount,
        overlayInstances: builder.overlayCount,
        buildRect: builtRect ? { x0: builtRect.x0, y0: builtRect.y0, x1: builtRect.x1, y1: builtRect.y1 } : null,
        firstSceneInput: firstSceneInput,
        firstBuiltRect: firstBuiltRect,
        currentSceneInput: lastSceneView && lastSceneView.origin ? {
          x: lastSceneView.origin.x, y: lastSceneView.origin.y, z: lastSceneView.origin.z,
          width: lastSceneView.width | 0, height: lastSceneView.height | 0,
        } : null,
        sceneInvalidated: sceneInvalidated,
        scrollX: scroll.x, scrollY: scroll.y,
        unitTrackedCount: stats.unitTrackedCount, unitInstances: stats.unitInstances,
        unitPositionSamples: stats.unitPositionSamples,
        // The unitPositionSamples gate is MODE-DEPENDENT, so report which mode produced the count.
        unitSmoothMotion: unitInterp.isSmooth(),
      };
    }

    function dispose() {
      if (unsubscribeDirty) { try { unsubscribeDirty(); } catch (_) {} unsubscribeDirty = null; }
      if (!glResources) return;
      try {
        gl.deleteBuffer(glResources.vbo);
        gl.deleteBuffer(glResources.ubo);
        gl.deleteVertexArray(glResources.vao);
        gl.deleteProgram(glResources.program);
      } catch (_) { /* context may already be gone */ }
      glResources = null;
    }

    // initial build
    buildGLResources();

    return {
      buildScene: buildScene, render: render, setCamera: setCamera, setScroll: setScroll,
      setRenderParams: setRenderParams, setMaps: setMaps, invalidateScene: invalidateScene, getStats: getStats,
      usesChunkPatching: !!unsubscribeDirty,
      handleLost: handleLost, handleRestored: handleRestored, dispose: dispose,
      updateUnits: updateUnits, tickUnits: tickUnits,
      // Runtime motion mode: no reload and no scene rebuild. tickUnits() reads the interpolator each frame.
      setSmoothMotion: function (on) { unitInterp.setSmooth(on); },
      isSmoothMotion: function () { return unitInterp.isSmooth(); },
      // cheap AUX folds plus buildings/overlay-only invalidation
      updateSceneSegments: updateSceneSegments,
      // third dynamic-instance region (projectiles/vehicles)
      updateProjectiles: updateProjectiles,
      // fourth dynamic-instance region (flow clouds -- miasma et al.)
      updateFlows: updateFlows,
      _extractFlowsForTest: extractFlows,
      _setChunkPatchingEnabledForTest: function (enabled) { chunkPatchingEnabled = enabled !== false; },
      _builder: builder,
    };
  }

  var DwfGL = {
    create: create,
    createSceneBuilder: createSceneBuilder,
    // constants / helpers exposed for tests + the seam
    SOLID_CELL: SOLID_CELL, PENDING: PENDING, INSTANCE_BYTES: INSTANCE_BYTES,
    ATTR_ADDITIVE: ATTR_ADDITIVE, ATTR_MARKER: ATTR_MARKER,
    // see-down descent depth encoding, and the transitional-mode guard
    ATTR_SEEDOWN_SHIFT: ATTR_SEEDOWN_SHIFT, ATTR_SEEDOWN_MASK: ATTR_SEEDOWN_MASK,
    MAX_SEEDOWN_DEPTH: MAX_SEEDOWN_DEPTH, cacheHasMultiZ: cacheHasMultiZ,
    isOpenTileShapeMat: isOpenTileShapeMat,
    defaultRenderParams: defaultRenderParams,
    hashXY: hashXY, wallPrefix: wallPrefix, wallDetailPrefix: wallDetailPrefix, isTreeWallMat: isTreeWallMat, tileColorTables: { MAT_COLOR: MAT_COLOR, BG: BG },
    // Module-scope so both the scene builder and dwf-tiles.js's world-change handler reach one scatter.
    hiddenScatterFor: hiddenScatterFor, hiddenVariantAt: hiddenVariantAt,
    resetHiddenScatter: resetHiddenScatter,
    _hiddenScatterForTest: hiddenScatterFor,
    _hiddenVariantAtForTest: hiddenVariantAt,
    _resetHiddenScatterForTest: resetHiddenScatter,
    liquidEdgeTokens: liquidEdgeTokens,
    edgeOvergrowth: root.DwfEdgeOvergrowth || null,
    derivedTreePart: derivedTreePart,  // tail-less tree part derivation (canvas2d parity)
    isGrassBackingSource: isGrassBackingSource,  // grass-backing neighbour predicate
    GRASS_BACK_OFFSETS: GRASS_BACK_OFFSETS,  // ring-ordered neighbour scan offsets
    VERT_SRC: VERT_SRC, FRAG_SRC: FRAG_SRC,
    // pure grass tier and tint helpers exposed module-wide
    grassTierIndex: grassTierIndex, grassSpeciesTintRGBA: grassSpeciesTintRGBA,
    grassSpriteSpec: grassSpriteSpec,
    // (ttname, plantOccupied) -> a grass sprite COLUMN; gx/gy are ignored. No trailing 1-4 digit,
    // or an occupying plant, reads column 0 = GRASS_1, never a positional roll.
    _grassVariantIndexForTest: grassVariantIndex,
    // pure sparse-layer helpers exposed module-wide, for fixture tests
    hashInt: hashInt, matFamilyFor: matFamilyFor, parseTreeTtname: parseTreeTtname,
    resolveOverleavesGL: resolveOverleavesGL,  // canopy leaf-overlay resolution
    canonicalDirs: canonicalDirs,  // parser parity with canvas2d
    ITEM_TINT_RGB_BY_FAMILY: ITEM_TINT_RGB_BY_FAMILY,
    _itemSpatterPlanForTest: itemSpatterPlanGL,
    // pure building helpers exposed module-wide (no builder/buildingMap instance needed).
    isOverlayOnlyBuildingType: isOverlayOnlyBuildingType, buildingsInPaintOrder: buildingsInPaintOrder,
    pickBuildingPalRow: pickBuildingPalRow,     // component STATE_COLOR token -> exact palette row
    fogAlphaForDepth: fogAlphaForDepth, belowAlpha: belowAlpha, MISSING_BUILDING: MISSING_BUILDING,
    // pure unit tier-resolution and interpolation helpers exposed module-wide
    resolveUnitTierGL: resolveUnitTierGL, createUnitInterpolator: createUnitInterpolator,
    unitStatusIconForBits: unitStatusIconForBits, unitStatusBlinkVisible: unitStatusBlinkVisible,
    unitStatusIconNow: unitStatusIconNow, nativeBubblePhase: nativeBubblePhase,
    unitMapFlash: unitMapFlash,  // the overhead map-flash cadence
    physicalStatusIconForBits: physicalStatusIconForBits, ordinaryStatusIconForBits: ordinaryStatusIconForBits,
    NATIVE_BUBBLE_PERIOD_MS: NATIVE_BUBBLE_PERIOD_MS, NATIVE_BUBBLE_ID_STRIDE: NATIVE_BUBBLE_ID_STRIDE,
    NATIVE_BUBBLE_ORDINARY_MS: NATIVE_BUBBLE_ORDINARY_MS,
    isBlinkingDesignationJob: isBlinkingDesignationJob, designationGlyphVisible: designationGlyphVisible,
    hasBlinkingDesignationJob: hasBlinkingDesignationJob, workedTileUnitVisible: workedTileUnitVisible,
    // flow-cloud policy (miasma et al.) -- pure helpers, fixture tests hit these directly.
    FLOW_STYLES_GL: FLOW_STYLES_GL, flowOverlayForGL: flowOverlayForGL,
    designationBlinkState: designationBlinkState, activeBlinkVisible: activeBlinkVisible,
    DESIG_ACTIVE_BLINK_MS: DESIG_ACTIVE_BLINK_MS,
    UNIT_FALLBACK_RGB: UNIT_FALLBACK_RGB, UNIT_LERP_MS: UNIT_LERP_MS,
    GHOST_TINT_RGB: GHOST_TINT_RGB, GHOST_ALPHA: GHOST_ALPHA,  // ghost tint (shared with canvas2d)
    UNIT_STATUS_BLINK_MS: UNIT_STATUS_BLINK_MS,
    MACHINE_ANIM_MS: MACHINE_ANIM_MS, machineAnimPhase: machineAnimPhase,
    machineFrameParityGL: machineFrameParityGL, machineCadenceStepGL: machineCadenceStepGL,
    _buildingRebuildViewForTest: buildingRebuildViewGL,
    // animation-clock attr encoding, and the pure JS mirror of the shader's frame-select math
    ATTR_ANIMFRAMES_MASK: ATTR_ANIMFRAMES_MASK, ATTR_ANIMRATE_SHIFT: ATTR_ANIMRATE_SHIFT,
    ATTR_ANIMRATE_MASK: ATTR_ANIMRATE_MASK, ANIM_RATE_HZ: ANIM_RATE_HZ,
    encodeAnimAttr: encodeAnimAttr, defaultAnimRateCodeForToken: defaultAnimRateCodeForToken,
    hashGridPhase: hashGridPhase, animFrameIndexForTest: animFrameIndexForTest,
    // the pause-aware world clock the renderer feeds u_timeMs and machine frames
    _worldNowForTest: worldNow, _animOffsetForTest: animOffset,
    // pure designation and presence helpers exposed module-wide, for fixture tests
    DESIG_CELL: DESIG_CELL, DESIG_TRACK_CELL: DESIG_TRACK_CELL, DESIG_TINT_RGB: DESIG_TINT_RGB,
    AUTOMINE_SPRITE_TINT: AUTOMINE_SPRITE_TINT,
    DESIG_WASH_ALPHA: DESIG_WASH_ALPHA, DESIG_WASH_ALPHA_MARKER: DESIG_WASH_ALPHA_MARKER,
    MARKER_RECOLOR: MARKER_RECOLOR, MARKER_GLYPH_TINT: MARKER_GLYPH_TINT, MARKER_WASH_RGB: MARKER_WASH_RGB,
    resolveDesig: resolveDesig, resolveDjob: resolveDjobGL, playerColorRgb: playerColorRgb, hslToRgb255: hslToRgb255,
    presenceBudget: presenceBudget, PRESENCE_DRAG_MAX_TILES: PRESENCE_DRAG_MAX_TILES,
    setMineMode: setMineMode,
    // The general mode-gated overlay input; setMineMode above is the mining entry under its older name.
    setToolStateOverlay: setToolStateOverlayGL,
    _toolStateOverlayVisibleForTest: toolStateOverlayVisibleGL,
    MINING_SHEET: MINING_SHEET, MINING_CELL: MINING_CELL,
    _miningIndicatorCellForTest: miningIndicatorCell,
  };

  try { root.DwfGL = DwfGL; } catch (_) { /* non-browser context */ }
  if (typeof module === "object" && module && module.exports) module.exports = DwfGL;
})(typeof self !== "undefined" ? self : this);
