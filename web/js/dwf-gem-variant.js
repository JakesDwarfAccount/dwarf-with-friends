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

// ---- Cut-gem RUNTIME-COMPOSITED art: three 16x16 stamps into one 32x32 tile, then recoloured. ----
// Native draws no cell for a small cut gem; it generates four textures per cut, above every PNG page.
(function (root) {
  "use strict";

  // The four scatter arrangements, read out of the generator. Nothing may be added to this table without
  // a corpus read behind it.
  var OFFSETS = [
    [[0, -5], [5, 0], [-5, 5]],
    [[-4, -5], [4, -1], [-1, 5]],
    [[5, -5], [-5, 0], [0, 5]],
    [[-5, -3], [4, -2], [-2, 4]],
  ];
  var BASE = 8;                 // native's fixed stamp origin inside the doubled surface
  var VARIANT_COUNT = OFFSETS.length;

  // Native's variant mixer, reproduced exactly: a splitmix64 step whose state is SET to the seed and then
  // advanced, so the effective input is the seed plus the constant.
  var GOLDEN = 0x9e3779b97f4a7c15n;
  var M64 = (1n << 64n) - 1n;
  function splitmix64(seed) {
    var x = (BigInt.asUintN(64, BigInt(seed)) + GOLDEN) & M64;
    x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & M64;
    return (x ^ (x >> 31n)) & M64;
  }

  // Native takes bits 32-33 of the mixed value. Memoised because this runs per drawn gem and BigInt
  // is not free; the seed space in practice is small (one entry per gem-bearing tile).
  var selCache = new Map();
  function variantIndex(seed) {
    var k = String(seed);
    var hit = selCache.get(k);
    if (hit !== undefined) return hit;
    var v = Number((splitmix64(seed) >> 32n) & 3n);
    if (selCache.size > 4096) selCache.clear();   // bounded: this is a cache, not a ledger
    selCache.set(k, v);
    return v;
  }

  // APPROXIMATION SEED. DEF-031: we do not have the item id native uses, so the tile the gem lies on
  // seeds the mixer -- stable across frames, and a different assignment rather than a different set.
  function seedFromTile(gx, gy, gz) {
    return (((gx | 0) * 73856093) ^ ((gy | 0) * 19349663) ^ ((gz | 0) * 83492791)) >>> 0;
  }

  // Where the three stamps land, for a source cell of the given size. Destination is 2x the source
  // in each dimension, which for smallgems.png's 16x16 cells is exactly one 32x32 tile.
  function stamps(variant, cellW, cellH) {
    var tbl = OFFSETS[((variant | 0) % VARIANT_COUNT + VARIANT_COUNT) % VARIANT_COUNT];
    var out = [];
    for (var i = 0; i < tbl.length; i++)
      out.push({ x: BASE + tbl[i][0], y: BASE + tbl[i][1], w: cellW, h: cellH });
    return out;
  }
  function destSize(cellW, cellH) { return { w: cellW * 2, h: cellH * 2 }; }

  function premultipliedIndex(lookup, alpha) {
    var cache = lookup.__dfcPmCache || (lookup.__dfcPmCache = new Map());
    var byAlpha = cache.get(alpha);
    if (byAlpha) return byAlpha;
    byAlpha = new Map();
    lookup.forEach(function (k, packed) {
      var r = Math.round((((packed >> 16) & 255) * alpha) / 255);
      var g = Math.round((((packed >> 8) & 255) * alpha) / 255);
      var b = Math.round(((packed & 255) * alpha) / 255);
      var key = (r << 16) | (g << 8) | b;
      if (!byAlpha.has(key)) byAlpha.set(key, k);
    });
    cache.set(alpha, byAlpha);
    return byAlpha;
  }
  function remapPalette(data, lookup, target) {
    if (!data || !lookup || !target) return data;
    for (var i = 0; i < data.length; i += 4) {
      var a = data[i + 3];
      if (a === 0) continue;
      var k = lookup.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (k === undefined && a < 255) {
        k = premultipliedIndex(lookup, a).get(
          (Math.round((data[i] * a) / 255) << 16) |
          (Math.round((data[i + 1] * a) / 255) << 8) |
          Math.round((data[i + 2] * a) / 255));
      }
      if (k === undefined) continue;
      var t = target[k];
      if (t) { data[i] = t[0]; data[i + 1] = t[1]; data[i + 2] = t[2]; }
    }
    return data;
  }

  // Pure pixel compositor, shared by the GL atlas path (which has no canvas). Paints the three
  // stamps of `src` (srcW x srcH straight-alpha RGBA) into `dst` (dstW x dstH), in order, source-over.
  function composite(dst, dstW, dstH, src, srcW, srcH, variant) {
    var rects = stamps(variant, srcW, srcH);
    for (var s = 0; s < rects.length; s++) {
      var r = rects[s];
      for (var y = 0; y < srcH; y++) {
        var dy = r.y + y;
        if (dy < 0 || dy >= dstH) continue;
        for (var x = 0; x < srcW; x++) {
          var dx = r.x + x;
          if (dx < 0 || dx >= dstW) continue;
          var si = (y * srcW + x) * 4, di = (dy * dstW + dx) * 4;
          var a = src[si + 3];
          if (a === 0) continue;
          if (a === 255) {
            dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
            continue;
          }
          // Straight-alpha source-over. The shipped gem art is opaque, so this branch is a
          // correctness backstop rather than a path native exercises.
          var ia = a / 255, inv = 1 - ia, da = dst[di + 3] / 255;
          var oa = ia + da * inv;
          if (oa <= 0) { dst[di + 3] = 0; continue; }
          dst[di] = Math.round((src[si] * ia + dst[di] * da * inv) / oa);
          dst[di + 1] = Math.round((src[si + 1] * ia + dst[di + 1] * da * inv) / oa);
          dst[di + 2] = Math.round((src[si + 2] * ia + dst[di + 2] * da * inv) / oa);
          dst[di + 3] = Math.round(oa * 255);
        }
      }
    }
    return dst;
  }

  root.DwfGemVariant = {
    OFFSETS: OFFSETS,
    BASE: BASE,
    VARIANT_COUNT: VARIANT_COUNT,
    splitmix64: splitmix64,
    variantIndex: variantIndex,
    seedFromTile: seedFromTile,
    stamps: stamps,
    destSize: destSize,
    remapPalette: remapPalette,
    composite: composite,
    // Stated in code, not only in the ledger, so a reader of either renderer finds it: the
    // arrangement geometry is exact; the choice among the four is not.
    PARITY: { geometry: "exact", palette: "exact", selection: "approximate" },
  };
})(typeof window !== "undefined" ? window : globalThis);
