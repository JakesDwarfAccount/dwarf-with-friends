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

// NATIVE TERRAIN VARIANT SELECTION. The variant is a deterministic function of the tile's WORLD
// position: a viewport-position key re-rolls every wall face on every pan.
(function (root) {
  "use strict";

  var Z_MUL = 0x7960717n;   // 140e94ac0.c:2141
  var Y_MUL = 0x29d3n;      // 140e94ac0.c:2141
  var VARIANT_COUNT = 4;    // the field is two bits: 1407d36f0.c:147 `(key & 0x300000) >> 0x14`

  // Native's seed polynomial, signed 64-bit: a negative map coordinate cannot occur in a real fort, but
  // a test can produce one, and native's `longlong` arithmetic wraps signed.
  function seedFor(gx, gy, gz) {
    return BigInt.asIntN(64, BigInt(gz | 0) * Z_MUL + BigInt(gy | 0) * Y_MUL + BigInt(gx | 0));
  }

  // Memoised because this runs once per drawn wall face per frame and BigInt is not free. Keyed in two
  // steps -- a Map per z, then a signed 32-bit (x,y) pack -- so the inner key stays a small integer.
  var byZ = new Map();
  var MAX_PLANES = 64;          // z-planes retained; a see-down stack is ~10 and a fort ~170
  var MAX_PER_PLANE = 262144;   // 512x512 tiles of one plane
  function xyKey(x, y) { return (((y & 0xffff) << 16) | (x & 0xffff)) | 0; }

  // Returns 0..3, or null when the mixer is unavailable (script load order) so a caller can keep
  // its own pre-0071 fallback rather than render nothing. Never throws.
  function variant(gx, gy, gz) {
    if (typeof gx !== "number" || typeof gy !== "number" || typeof gz !== "number") return null;
    if (!isFinite(gx) || !isFinite(gy) || !isFinite(gz)) return null;
    var z = gz | 0;
    var plane = byZ.get(z);
    if (plane === undefined) {
      if (byZ.size >= MAX_PLANES) byZ.clear();
      plane = new Map();
      byZ.set(z, plane);
    }
    var key = xyKey(gx | 0, gy | 0);
    var hit = plane.get(key);
    if (hit !== undefined) return hit;
    var gem = root.DwfGemVariant;
    if (!gem || typeof gem.splitmix64 !== "function") return null;
    var v;
    try {
      v = Number((gem.splitmix64(seedFor(gx, gy, gz)) >> 32n) & 3n);
    } catch { return null; }
    if (plane.size >= MAX_PER_PLANE) plane.clear();
    plane.set(key, v);
    return v;
  }

  // Renderer-neutral: the canvas and GL paths ask this module for the same sheet and cell decision.
  // Coordinates are WORLD coordinates, so camera movement cannot reshuffle partial decals.
  var SPATTER_BUILTIN_FAMILY = { 9: "DUST", 12: "MUD", 13: "VOMIT" };
  function stableIndex(gx, gy, gz, count, salt) {
    if (!(count > 0)) return 0;
    var gem = root.DwfGemVariant;
    if (!gem || typeof gem.splitmix64 !== "function") return 0;
    try {
      var seeded = seedFor(gx | 0, gy | 0, gz | 0) + BigInt((salt || 0) | 0);
      return Number((gem.splitmix64(seeded) >> 32n) % BigInt(count));
    } catch { return 0; }
  }
  function bloodFamily(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return null;
    var r = rgb[0], g = rgb[1], b = rgb[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 36) return "BLOOD_GOO";
    if (r > g + 30 && b > g + 30) return "BLOOD_MAGENTA";
    if (b >= r && b >= g) return "BLOOD_CYAN";
    if (r >= g && r >= b) return (g >= r * 0.6 && b < g) ? "BLOOD_ICHOR" : "BLOOD_RED";
    return "BLOOD_ICHOR";
  }
  function spatterFamily(map, sp) {
    if (!map || !sp) return null;
    var mt = sp.mat_type;
    if (mt === 6) return sp.state === 3 ? "SNOW" : "WATER_SPATTER";
    if (SPATTER_BUILTIN_FAMILY[mt]) return SPATTER_BUILTIN_FAMILY[mt];
    if (mt >= 19 && mt < 419) {
      var byRgb = bloodFamily(sp.rgb);
      if (byRgb) return byRgb;
      var blood = map.blood_families;
      if (Array.isArray(blood) && blood.length)
        return blood[stableIndex(mt, sp.mat_index || 0, 0, blood.length, 0)];
    }
    return "MUD";
  }
  function spatterShape(map, amount) {
    var thresholds = (map && map.amount_thresholds_default) || [];
    for (var i = 0; i < thresholds.length; i++) {
      var th = thresholds[i];
      if (th.max === null || amount <= th.max) return th.shape;
    }
    return "FULL";
  }
  function spatterPartialKey(band, gx, gy, gz, salt) {
    var m = /^PARTIAL_([A-D])$/.exec(band || "");
    if (!m) return null;
    return "PARTIAL_" + (1 + stableIndex(gx, gy, gz, 4, salt)) + m[1];
  }
  function spatterCell(map, sp, gx, gy, gz, salt, fullKey) {
    var family = spatterFamily(map, sp);
    var familyDef = family && map && map.families && map.families[family];
    if (!familyDef) return null;
    var shape = spatterShape(map, sp.amount);
    var key = shape === "FULL" ? (fullKey || "FULL_ISOLATED")
      : spatterPartialKey(shape, gx, gy, gz, salt);
    var cell = familyDef.cells && (familyDef.cells[key] || familyDef.cells.FULL_ISOLATED);
    return cell ? { family: family, sheet: familyDef.sheet, col: cell.col, row: cell.row, key: key } : null;
  }
  var ITEM_SPATTER_TINT_RGB_BY_FAMILY = {
    LEAVES: [82, 116, 48], FRUIT: [194, 120, 38],
    FRUIT_SMALL: [164, 57, 42], FRUIT_LARGE: [178, 72, 44],
  };
  function itemSpatterTintRgb(family, rgb) {
    if (!ITEM_SPATTER_TINT_RGB_BY_FAMILY[family]) return null;
    return rgb && rgb.length === 3 ? rgb : ITEM_SPATTER_TINT_RGB_BY_FAMILY[family];
  }
  function itemSpatterLitter(arr, map) {
    if (!arr || !arr.length || !map || !map.growth_class_family || !map.families) return null;
    var best = null;
    for (var i = 0; i < arr.length && i < 4; i++) {
      var isp = arr[i];
      if (!isp || !(isp.amount > 0)) continue;
      var family = map.growth_class_family[String(isp.growth_class)];
      if (!family || family === "OTHER") continue;
      var familyDef = map.families[family];
      if (!familyDef) continue;
      if (best && ((isp.amount | 0) < (best.isp.amount | 0)
          || ((isp.amount | 0) === (best.isp.amount | 0)
            && ((isp.growth_class | 0) > (best.isp.growth_class | 0)
              || ((isp.growth_class | 0) === (best.isp.growth_class | 0)
                && (isp.item_type | 0) >= (best.isp.item_type | 0)))))) continue;
      best = { isp: isp, fam: family, famDef: familyDef };
    }
    return best;
  }
  function trackMaskOfConstruction(ttname) {
    var m = /Track([NSEW]+)$/.exec(ttname || "");
    if (!m) return 0;
    var s = m[1];
    return (s.indexOf("N") >= 0 ? 1 : 0) | (s.indexOf("S") >= 0 ? 2 : 0) |
           (s.indexOf("E") >= 0 ? 4 : 0) | (s.indexOf("W") >= 0 ? 8 : 0);
  }
  function fortOpenTokenOf(prefix, openMask) {
    var m = openMask & 15;
    var suffix = m === 15 ? "NSWE" : m === 11 ? "NSE" : m === 7 ? "NSW" :
      m === 13 ? "NWE" : m === 14 ? "SWE" : m === 3 ? "NS" : m === 12 ? "WE" :
      m === 9 ? "NE" : m === 5 ? "NW" : m === 10 ? "SE" : m === 6 ? "SW" : null;
    return suffix ? (prefix + "_OPEN_" + suffix) : prefix;
  }
  function constructedTerrainPlan(kind, ttname, material, openMask) {
    if (kind !== "FLOOR" && kind !== "RAMP" && kind !== "UD" && kind !== "U" &&
        kind !== "D" && kind !== "FORT") return null;
    var token, palRow = null, mask = 0, multiplyRgb = null;
    if (kind === "FLOOR") {
      mask = trackMaskOfConstruction(ttname);
      if (material.family === "GLASS") token = material.glassMt === 3 ? "GLASS_GREEN_FLOOR" :
        material.glassMt === 4 ? "GLASS_CLEAR_FLOOR" :
        material.glassMt === 5 ? "GLASS_CRYSTAL_FLOOR" : null;
      else if (material.family === "WOOD") { token = "WOOD_FLOOR"; palRow = material.palRow; }
      else { token = material.family === "METAL" ? "METAL_FLOOR" : "FLOOR_STONE_BLOCK"; palRow = material.palRow; }
    } else if (kind === "RAMP") {
      mask = trackMaskOfConstruction(ttname);
      token = "STONE_RAMP_OTHER";
      multiplyRgb = material.tintRgb;
    } else if (kind === "UD" || kind === "U" || kind === "D") {
      var stairKind = kind === "UD" ? "UPDOWN" : kind === "U" ? "UP" : "DOWN";
      token = "PALETTE_STAIR_" + stairKind;
      palRow = material.palRow;
    } else {
      var prefix = material.family === "WOOD" ? "FORTIFICATION_WOOD" : "FORTIFICATION";
      token = fortOpenTokenOf(prefix, typeof openMask === "number" ? openMask : 0);
      palRow = material.palRow;
    }
    if (!token) return null;
    return { token: token, palRow: palRow, mask: mask, multiplyRgb: multiplyRgb };
  }

  function smoothFloorToken(t) {
    if (!t || (t.shape || "") !== "FLOOR" ||
        !/^(?:Stone|Mineral)FloorSmooth$/.test(t.ttname || "")) return null;
    var hits = t.engravings;
    var mask = 0;
    if (Array.isArray(hits)) {
      for (var i = 0; i < hits.length; i++) mask |= ((hits[i] && hits[i].eflags) || 0) & 0x03ff;
    }
    var visibleFloorEngraving = (mask & 0x0001) && !(mask & 0x0020);
    return visibleFloorEngraving
      ? "FLOOR_STONE_ENGRAVED_NON_PALETTE"
      : "SMOOTH_FLOOR";
  }

  function furnitureStateKey(b) {
    if (!b || typeof b.bst !== "number") return null;
    switch (b.type) {
      case "Door": case "Hatch":
        return (typeof b.dopen === "boolean" ? b.dopen : !(b.bst & 1)) ? "OPEN" : "CLOSED";
      case "Floodgate": return (b.bst & 1) ? "CLOSED" : "OPEN";
      case "GrateWall": case "GrateFloor": return (b.bst & 1) ? null : "OPEN";
      case "Cage": case "AnimalTrap": return (b.bst & 1) ? "OCCUPIED" : null;
      case "Weaponrack": case "Armorstand": return (b.bst & 1) ? "FULL" : null;
      case "TractionBench": return (b.bst & 1) ? "ROPE" : null;
      case "Hive": return ["EMPTY", "IN_USE", "PRODUCTS"][b.bst] || null;
      default: return null;
    }
  }

  function furnitureQualityArt(family, material, state, quality, wear, fallback) {
    var base = fallback;
    var qualityRows = family && family.closed_quality && family.closed_quality[material];
    if (state === "CLOSED" && Array.isArray(qualityRows) && qualityRows.length) {
      var q = typeof quality === "number" && isFinite(quality) ? quality | 0 : 0;
      base = qualityRows[Math.max(0, Math.min(qualityRows.length - 1, q))] || base;
    }
    var damage = null;
    if (family && Array.isArray(family.damage) && typeof wear === "number" && isFinite(wear)) {
      var w = wear | 0;
      if (w > 0) damage = family.damage[Math.min(family.damage.length, w) - 1] || null;
    }
    return { base: base, damage: damage };
  }

  root.DwfTerrainVariant = {
    Z_MUL: Z_MUL,
    Y_MUL: Y_MUL,
    VARIANT_COUNT: VARIANT_COUNT,
    seedFor: seedFor,
    variant: variant,
    stableIndex: stableIndex,
    bloodFamily: bloodFamily,
    spatterFamily: spatterFamily,
    spatterShape: spatterShape,
    spatterPartialKey: spatterPartialKey,
    spatterCell: spatterCell,
    itemSpatterTintRgb: itemSpatterTintRgb,
    itemSpatterLitter: itemSpatterLitter,
    constructedTerrainPlan: constructedTerrainPlan,
    smoothFloorToken: smoothFloorToken,
    furnitureStateKey: furnitureStateKey,
    furnitureQualityArt: furnitureQualityArt,
    _cacheSizeForTest: function () {
      var n = 0;
      byZ.forEach(function (p) { n += p.size; });
      return n;
    },
    _clearCacheForTest: function () { byZ.clear(); },
    // Stated in code, not only in the ledger, so a reader of either renderer finds it.
    PARITY: {
      mixer: "exact",
      seedPolynomial: "exact",
      bitField: "exact",
      frameStable: "exact",
      selection: "approximate",
      selectionReason: "native seeds from GLOBAL coords (region_*); the wire carries map-local only",
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
