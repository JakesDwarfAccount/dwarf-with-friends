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
//
// D1 (native font) -- BUILD-TIME CONVERTER. Reads DF's glyph atlas and emits a real TrueType
// font into web/fonts/, which the client then uses as an ordinary `font-family`.
//
//   node tools/ws2/build_df_font.mjs [--atlas <path to curses_640x300.png>] [--out web/fonts/df-curses.ttf]
//
// Default atlas: <your DF install>\data\art\curses_640x300.png  (resolved; --atlas overrides)
//
// WHAT THE ATLAS ACTUALLY IS (established from the file, not assumed):
//   * 128 x 192 px, PNG bit-depth 1, colour-type 3 (palette), 2-entry PLTE, NO tRNS chunk.
//   * Exactly two opaque colours: white (255,255,255) glyph, magenta (255,0,255) background.
//     It is a ONE-BIT MASK KEYED ON MAGENTA -- not an alpha channel.
//   * 16 x 16 grid => an 8 x 12 px cell. Every DF interface sprite is a multiple of that cell
//     (24x36, 32x36, 40x36, 16x12), which is how we know the cell is the layout unit.
//   * The layout is IBM code page 437, row-major: cell 0x41 is 'A', 0xDB is the full block,
//     0x02 is the inverse smiley. (Read off the pixels; see glyph_font_test.mjs.)
//   * It is the file named by [FONT:] in data/init/init_default.txt.
//
// WHY AN OUTLINE FONT IS FAITHFUL, NOT A COMPROMISE. DF draws each cell as a textured quad and
// multiplies the white glyph by a per-cell foreground colour -- the free recolouring you see in
// DF's UI is the SIGNATURE of a 1-bit tinted bitmap, not evidence of a normal font. Tracing that
// 1-bit mask into filled rectangle outlines and tinting with CSS `color` reproduces DF's model
// exactly: same shapes, same per-glyph tint, and text stays real selectable DOM text.
//
// DETERMINISM: same atlas in => byte-identical font out. No timestamps (head.created/modified are
// zero), no map iteration order dependence, no Date. Re-runnable when a DF version changes the
// atlas. Verified by glyph_font_test.mjs (builds twice, compares bytes).
//
// Zero dependencies: PNG inflate comes from node:zlib (stdlib). No npm, no fontTools, no pip.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDfRoot } from "../lib/dfroot.mjs";
export const FAMILY = "DF Curses";
export const CELL_W = 8;
export const CELL_H = 12;
export const GRID_COLS = 16;
export const GRID_ROWS = 16;

// Font-unit metrics. 100 units per atlas pixel => the em IS the 12px cell, so `font-size: 12px`
// renders one atlas pixel as exactly one CSS pixel and `line-height: 12px` is exactly the line
// box. Crisp sizes are therefore integer multiples of the cell: 12px (1x) and 24px (2x, which is
// what DF's own screenshots show). See the CONTRACT NOTE for the Foundation Owner.
//
// A power-of-two em (1024 units / 64 per pixel, at font-size 16px) was built and MEASURED in
// headless Chrome on the theory that binary fixed-point scaling would be crisper. It rendered
// byte-identically -- so the fixed-point theory is refuted and the intuitive metric wins.
export const PU = 100;                     // font units per atlas pixel
export const UNITS_PER_EM = CELL_H * PU;   // 1200 == the 12px cell
export const ADVANCE = CELL_W * PU;        // 800 == 8 px (monospace)
export const ASCENT = 1000;                // top of cell row 0; baseline at the bottom of row 9
export const DESCENT = -200;               // rows 10-11 (2 px) hang below the baseline
// ASCENT - DESCENT == 1200 == one em == the 12px cell.
//
// ===============================================================================================
// THE "SOFT FONT" QUESTION IS SETTLED. DO NOT RE-LITIGATE THE EM. (measured 2026-07-11, headless
// Chrome via tools/harness/cdp_probe.mjs, decoding every channel of the screenshot -- not just red)
//
// The owner: "the real df font seems more crisp, the one we are using does feel slightly soft." Correct.
// It is NOT this file. The evidence:
//
//   * THE GEOMETRY IS ALREADY EXACT. unitsPerEm is 1200 and 1200 % CELL_H == 0, so one atlas pixel
//     is exactly 100 font units and every glyph edge already lands on a whole device pixel at 12px
//     and 24px. The divisibility theory ("upem must be divisible by 12") is SATISFIED, not broken.
//     Proof: feed the SAME traced coordinates to an SVG <path> and Chrome rasterizes them to 100%
//     pure on/off pixels -- zero intermediate values. Same numbers, same browser, same screenshot.
//     So the outline, the winding, the metrics and the baseline are all right.
//
//   * THE SOFTNESS LIVES IN CHROME'S TEXT PATH, NOT IN THE FONT. On Windows, Skia rasterizes glyphs
//     through DirectWrite, whose ClearType filter smears each glyph edge ~1px HORIZONTALLY. Vertical
//     edges stay perfectly crisp -- that asymmetry is the fingerprint. A 2px atlas stem arrives as
//     1 full + 2 partial pixels; in linear light the partials sum to 1.0 (energy conserved, then
//     smeared). This is the halo, and it is applied to the glyph mask AFTER our outline is scaled.
//
//   * NOTHING IN THE FONT FILE CAN TURN IT OFF. All measured, all no-ops, all identical pixel
//     counts: a `gasp` table (every combination of GRIDFIT / DOGRAY / no-flags), head.flags bit 3
//     (force integer ppem), and a power-of-two em. Skia's DirectWrite scaler does not consult gasp
//     to choose its rendering mode, and Blink never asks it for a bilevel (kBW) mask on Windows.
//     Embedded bitmap strikes (EBDT/EBLC) are reachable only from that same kBW path, so they would
//     ship dead bytes. NOTHING IN CSS CAN TURN IT OFF EITHER: -webkit-font-smoothing (none and
//     antialiased), text-rendering (optimizeSpeed, geometricPrecision), font-smooth:never and even
//     Chrome's own --disable-lcd-text all leave the pixel count unchanged. translateZ(0) only swaps
//     COLOUR fringing for GREY at the identical count -- a DIFFERENT defect, do not conflate them.
//
//   * THE FIX IS DOWNSTREAM, IN CSS: threshold the glyph mask's ALPHA back to 1 bit, which is what
//     a bitmap font IS. See --dwfui-text-crisp / .dwfui-crisp-text in web/css/dwf.css. Measured:
//     964 grey px -> 0 at 12px and 1004 -> 0 at 24px, with all 255 CP437 cells then rendering
//     PIXEL-IDENTICAL to the atlas. Text stays real, selectable DOM text tinted by CSS `color`.
//
// So: changing PU / UNITS_PER_EM / ASCENT / DESCENT here cannot make the text crisper. It can only
// break the 12px == one-cell contract. Leave them alone.
// ===============================================================================================

// CP437 -> Unicode, row-major over the 16x16 grid.
export const CP437 = [
  0x0000, 0x263a, 0x263b, 0x2665, 0x2666, 0x2663, 0x2660, 0x2022,
  0x25d8, 0x25cb, 0x25d9, 0x2642, 0x2640, 0x266a, 0x266b, 0x263c,
  0x25ba, 0x25c4, 0x2195, 0x203c, 0x00b6, 0x00a7, 0x25ac, 0x21a8,
  0x2191, 0x2193, 0x2192, 0x2190, 0x221f, 0x2194, 0x25b2, 0x25bc,
  0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0025, 0x0026, 0x0027,
  0x0028, 0x0029, 0x002a, 0x002b, 0x002c, 0x002d, 0x002e, 0x002f,
  0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037,
  0x0038, 0x0039, 0x003a, 0x003b, 0x003c, 0x003d, 0x003e, 0x003f,
  0x0040, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047,
  0x0048, 0x0049, 0x004a, 0x004b, 0x004c, 0x004d, 0x004e, 0x004f,
  0x0050, 0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057,
  0x0058, 0x0059, 0x005a, 0x005b, 0x005c, 0x005d, 0x005e, 0x005f,
  0x0060, 0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067,
  0x0068, 0x0069, 0x006a, 0x006b, 0x006c, 0x006d, 0x006e, 0x006f,
  0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077,
  0x0078, 0x0079, 0x007a, 0x007b, 0x007c, 0x007d, 0x007e, 0x2302,
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
  0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
  0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
  0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
  0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
  0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
  0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
  0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
];

// -----------------------------------------------------------------------------------------------
// PNG -> RGBA. node:zlib only. Covers what DF ships (1-bit palette) plus the obvious variants, so
// a future DF atlas in another format still converts.
// -----------------------------------------------------------------------------------------------
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === "PLTE") plte = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    i += 12 + len;
  }
  if (interlace) throw new Error("interlaced PNG not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error("unsupported PNG colour type " + color);
  const raw = inflateSync(Buffer.concat(idat));

  // Un-filter into packed samples.
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const rowBytes = Math.ceil((w * channels * depth) / 8);
  const out = Buffer.alloc(h * rowBytes);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + rowBytes); p += rowBytes;
    const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prior = y ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prior ? prior[x] : 0;
      const c = (prior && x >= bpp) ? prior[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error("bad PNG filter " + filter);
      cur[x] = v & 0xff;
    }
  }

  // Expand to RGBA.
  const rgba = new Uint8ClampedArray(w * h * 4);
  const sample = (row, idx) => {
    if (depth === 8) return out[row * rowBytes + idx];
    const bitsPer = depth;
    const bitPos = idx * bitsPer;
    const byte = out[row * rowBytes + (bitPos >> 3)];
    const shift = 8 - bitsPer - (bitPos & 7);
    return (byte >> shift) & ((1 << bitsPer) - 1);
  };
  const maxVal = (1 << depth) - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (color === 3) {
        const ix = sample(y, x);
        rgba[o] = plte[ix * 3]; rgba[o + 1] = plte[ix * 3 + 1]; rgba[o + 2] = plte[ix * 3 + 2];
        rgba[o + 3] = (trns && ix < trns.length) ? trns[ix] : 255;
      } else if (color === 0) {
        const v = Math.round((sample(y, x) / maxVal) * 255);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = 255;
      } else if (color === 2) {
        rgba[o] = sample(y, x * 3); rgba[o + 1] = sample(y, x * 3 + 1);
        rgba[o + 2] = sample(y, x * 3 + 2); rgba[o + 3] = 255;
      } else if (color === 6) {
        rgba[o] = sample(y, x * 4); rgba[o + 1] = sample(y, x * 4 + 1);
        rgba[o + 2] = sample(y, x * 4 + 2); rgba[o + 3] = sample(y, x * 4 + 3);
      } else throw new Error("unsupported PNG colour type " + color);
    }
  }
  return { width: w, height: h, rgba };
}

// -----------------------------------------------------------------------------------------------
// RGBA atlas -> 256 one-bit cell masks.
//
// A pixel is ON when it is opaque AND light. That single rule covers every background convention
// DF ships: the magenta key (luma 105 -> rejected), a black background (luma 0 -> rejected), and a
// real alpha channel (rejected on alpha). It is the ONLY place the keying convention is decided.
// -----------------------------------------------------------------------------------------------
export function masksFromRGBA(rgba, imgW, imgH, opts = {}) {
  const cols = opts.cols || GRID_COLS, rows = opts.rows || GRID_ROWS;
  const cw = opts.cellW || Math.floor(imgW / cols), ch = opts.cellH || Math.floor(imgH / rows);
  if (imgW !== cols * cw || imgH !== rows * ch) {
    throw new Error(`atlas is ${imgW}x${imgH}, expected ${cols * cw}x${rows * ch}`);
  }
  const masks = [];
  for (let cell = 0; cell < cols * rows; cell++) {
    const ox = (cell % cols) * cw, oy = Math.floor(cell / cols) * ch;
    const m = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const p = ((oy + y) * imgW + (ox + x)) * 4;
        const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
        m[y * cw + x] = (rgba[p + 3] >= 128 && luma >= 128) ? 1 : 0;
      }
    }
    masks.push(m);
  }
  return { masks, cellW: cw, cellH: ch };
}

// -----------------------------------------------------------------------------------------------
// Boundary trace: pixel mask -> closed axis-aligned contours in font units (y-up).
//
// For each ON pixel we emit the sides that face an OFF pixel, directed so the filled area is
// always on the RIGHT of travel. Chaining those directed edges yields clockwise outer contours and
// counter-clockwise holes automatically -- TrueType's nonzero-winding convention -- with no seams.
// (A naive "one square per pixel" soup leaves hairline antialiasing seams wherever two squares
// merely touch; tracing the true boundary of the pixel set cannot.)
// -----------------------------------------------------------------------------------------------
export function traceContours(mask, cw, ch) {
  const on = (c, r) => (c >= 0 && c < cw && r >= 0 && r < ch) ? mask[r * cw + c] : 0;
  const edges = new Map();
  const push = (x0, y0, x1, y1) => {
    const k = x0 + "," + y0;
    let a = edges.get(k);
    if (!a) { a = []; edges.set(k, a); }
    a.push({ x0, y0, x1, y1, used: false });
  };
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      if (!on(c, r)) continue;
      const x0 = c * PU, x1 = (c + 1) * PU;
      const yt = ASCENT - r * PU, yb = ASCENT - (r + 1) * PU;
      if (!on(c, r - 1)) push(x0, yt, x1, yt);    // top:    left   -> right
      if (!on(c + 1, r)) push(x1, yt, x1, yb);    // right:  top    -> bottom
      if (!on(c, r + 1)) push(x1, yb, x0, yb);    // bottom: right  -> left
      if (!on(c - 1, r)) push(x0, yb, x0, yt);    // left:   bottom -> top
    }
  }
  // Where two blobs touch only at a corner the walk is ambiguous. Prefer the hardest right turn:
  // it stays on the blob it entered. Any choice that consumes each edge once fills the identical
  // region; this one just yields the fewest, tidiest contours.
  const pick = (prev, cand) => {
    const dx = Math.sign(prev.x1 - prev.x0), dy = Math.sign(prev.y1 - prev.y0);
    for (const [ox, oy] of [[dy, -dx], [dx, dy], [-dy, dx]]) {   // right, straight, left (y-up)
      const m = cand.find(e => Math.sign(e.x1 - e.x0) === ox && Math.sign(e.y1 - e.y0) === oy);
      if (m) return m;
    }
    return cand[0];
  };
  const contours = [];
  for (const arr of edges.values()) {
    for (const seed of arr) {
      if (seed.used) continue;
      const sx = seed.x0, sy = seed.y0;
      const pts = [];
      let e = seed;
      while (e && !e.used) {
        e.used = true;
        pts.push([e.x0, e.y0]);
        if (e.x1 === sx && e.y1 === sy) break;
        const cand = (edges.get(e.x1 + "," + e.y1) || []).filter(x => !x.used);
        if (!cand.length) break;
        e = pick(e, cand);
      }
      if (pts.length >= 3) contours.push(dropCollinear(pts));
    }
  }
  return contours;
}

// Merge unit edges back into single segments: a straight 8px stroke is 2 points, not 9.
function dropCollinear(pts) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    const collinear = (p[0] === c[0] && c[0] === q[0]) || (p[1] === c[1] && c[1] === q[1]);
    if (!collinear) out.push(c);
  }
  return out.length >= 3 ? out : pts;
}

// Inverse of traceContours, for testing: fill the contours by nonzero winding at each pixel
// centre. If this does not reproduce the source mask, the outline is wrong.
export function rasterizeContours(contours, cw, ch) {
  const cross = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (px - ax) * (by - ay);
  const m = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      const px = c * PU + PU / 2, py = ASCENT - r * PU - PU / 2;
      let wind = 0;
      for (const ct of contours) {
        for (let i = 0; i < ct.length; i++) {
          const [ax, ay] = ct[i], [bx, by] = ct[(i + 1) % ct.length];
          if (ay <= py) { if (by > py && cross(ax, ay, bx, by, px, py) > 0) wind++; }
          else if (by <= py && cross(ax, ay, bx, by, px, py) < 0) wind--;
        }
      }
      m[r * cw + c] = wind !== 0 ? 1 : 0;
    }
  }
  return m;
}

// -----------------------------------------------------------------------------------------------
// TrueType assembly: a byte writer plus the 10 tables a `glyf` font needs to pass OTS (the
// sanitizer Chrome/Firefox run on every web font) -- OS/2, cmap, glyf, head, hhea, hmtx, loca,
// maxp, name, post.
// -----------------------------------------------------------------------------------------------
function W() {
  const b = [];
  const api = {
    u8: v => (b.push(v & 0xff), api),
    u16: v => (b.push((v >> 8) & 0xff, v & 0xff), api),
    i16: v => api.u16(v < 0 ? v + 0x10000 : v),
    u32: v => (b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff), api),
    tag: s => (b.push(s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)), api),
    bytes: a => { for (const v of a) b.push(v & 0xff); return api; },
    pad4: () => { while (b.length % 4) b.push(0); return api; },
    get length() { return b.length; },
    out: () => Uint8Array.from(b),
  };
  return api;
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const v = ((bytes[i] || 0) << 24) | ((bytes[i + 1] || 0) << 16) |
              ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0);
    sum = (sum + (v >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

function utf16be(s) {
  const a = [];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a.push((c >> 8) & 0xff, c & 0xff); }
  return a;
}

function glyfTable(glyphs) {
  const w = W();
  const loca = [0];
  for (const g of glyphs) {
    g.xMin = 0;                                                  // blank cells: lsb 0
    if (!g.contours.length) { loca.push(w.length); continue; }   // blank cell: zero-length entry
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    const flat = [], ends = [];
    for (const ct of g.contours) {
      for (const [x, y] of ct) {
        flat.push([x, y]);
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
      ends.push(flat.length - 1);
    }
    g.xMin = xMin;   // hmtx.lsb MUST equal glyph xMin: head.flags bit 1 asserts it, and a
                     // rasterizer that trusts the flag will phase-shift the glyph if we lie.
    w.i16(g.contours.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
    for (const e of ends) w.u16(e);
    w.u16(0);                                          // instructionLength
    for (let i = 0; i < flat.length; i++) w.u8(0x01);  // ON_CURVE; int16 coordinate deltas
    let px = 0; for (const [x] of flat) { w.i16(x - px); px = x; }
    let py = 0; for (const [, y] of flat) { w.i16(y - py); py = y; }
    w.pad4();
    loca.push(w.length);
  }
  w.pad4();
  return { table: w.out(), loca };
}

function cmapTable(gidByCp) {
  const cps = [...gidByCp.keys()].sort((a, b) => a - b);
  const segs = [];
  for (const cp of cps) {
    const gid = gidByCp.get(cp);
    const last = segs[segs.length - 1];
    if (last && cp === last.end + 1 && gid === last.startGid + (cp - last.start)) last.end = cp;
    else segs.push({ start: cp, end: cp, startGid: gid });
  }
  segs.push({ start: 0xffff, end: 0xffff, startGid: 0 });
  const segCount = segs.length;
  const searchRange = 2 * Math.pow(2, Math.floor(Math.log2(segCount)));
  const sub = W();
  sub.u16(4).u16(16 + segCount * 8).u16(0);
  sub.u16(segCount * 2).u16(searchRange)
     .u16(Math.log2(searchRange / 2)).u16(segCount * 2 - searchRange);
  for (const s of segs) sub.u16(s.end);
  sub.u16(0);
  for (const s of segs) sub.u16(s.start);
  // idDelta = (startGid - startCode) mod 65536. The 0xFFFF sentinel takes 1 so it maps to gid 0.
  for (const s of segs) sub.u16(s.start === 0xffff ? 1 : ((s.startGid - s.start) & 0xffff));
  for (let i = 0; i < segCount; i++) sub.u16(0);   // idRangeOffset: delta-only, no glyphIdArray
  const w = W();
  w.u16(0).u16(1).u16(3).u16(1).u32(12).bytes(sub.out());
  return w.out();
}

function nameTable(fields) {
  const recs = [];
  const strs = W();
  for (const [id, val] of fields) {
    const bytes = utf16be(val);
    recs.push({ id, off: strs.length, len: bytes.length });
    strs.bytes(bytes);
  }
  const w = W();
  w.u16(0).u16(recs.length).u16(6 + recs.length * 12);
  for (const r of recs) w.u16(3).u16(1).u16(0x0409).u16(r.id).u16(r.len).u16(r.off);
  return w.bytes(strs.out()).pad4().out();
}

/** 256 cell masks -> a TrueType font. Pure and deterministic. */
export function buildFont(masks, opts = {}) {
  const cw = opts.cellW || CELL_W, ch = opts.cellH || CELL_H;
  const family = opts.family || FAMILY;

  // gid 0 = .notdef, a hollow box, so a codepoint outside CP437 that somehow reaches this font is
  // VISIBLE rather than silently blank.
  const notdef = new Uint8Array(cw * ch);
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 0; x < cw; x++) {
      notdef[y * cw + x] = (y === 1 || y === ch - 2 || x === 0 || x === cw - 1) ? 1 : 0;
    }
  }
  const glyphs = [notdef, ...masks].map(m => ({ contours: traceContours(m, cw, ch) }));
  const numGlyphs = glyphs.length;

  const gidByCp = new Map();
  for (let i = 0; i < masks.length && i < CP437.length; i++) {
    const cp = CP437[i];
    if (!cp) continue;                       // CP437 0x00 -> U+0000: not mappable
    if (!gidByCp.has(cp)) gidByCp.set(cp, i + 1);
  }

  const { table: glyf, loca } = glyfTable(glyphs);

  let xMin = 0, yMin = 0, xMax = ADVANCE, yMax = ASCENT;
  for (const g of glyphs) for (const ct of g.contours) for (const [x, y] of ct) {
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }

  const head = W()
    .u32(0x00010000).u32(0x00010000).u32(0)        // version, fontRevision, checkSumAdjustment
    .u32(0x5f0f3cf5).u16(0x0003).u16(UNITS_PER_EM)
    .u32(0).u32(0).u32(0).u32(0)                   // created / modified: ZERO => deterministic
    .i16(xMin).i16(yMin).i16(xMax).i16(yMax)
    .u16(0).u16(8).i16(2).i16(1).i16(0)
    .out();

  // hmtx.lsb == the glyph's own xMin (see glyfTable). hhea's min-bearing / extent fields are
  // derived from the same numbers so the whole metric story is self-consistent.
  let minLsb = 0, minRsb = 0, xMaxExtent = 0;
  for (const g of glyphs) {
    if (!g.contours.length) continue;
    let gx = -Infinity;
    for (const ct of g.contours) for (const [x] of ct) if (x > gx) gx = x;
    if (g.xMin < minLsb) minLsb = g.xMin;
    if (ADVANCE - gx < minRsb) minRsb = ADVANCE - gx;
    if (gx > xMaxExtent) xMaxExtent = gx;
  }

  const hhea = W()
    .u32(0x00010000).i16(ASCENT).i16(DESCENT).i16(0)
    .u16(ADVANCE).i16(minLsb).i16(minRsb).i16(xMaxExtent)
    .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0)
    .i16(0).u16(numGlyphs)
    .out();

  const hm = W();
  for (const g of glyphs) hm.u16(ADVANCE).i16(g.xMin);
  const hmtx = hm.pad4().out();

  let maxPoints = 0, maxContours = 0;
  for (const g of glyphs) {
    let p = 0;
    for (const ct of g.contours) p += ct.length;
    if (p > maxPoints) maxPoints = p;
    if (g.contours.length > maxContours) maxContours = g.contours.length;
  }
  const maxp = W()
    .u32(0x00010000).u16(numGlyphs).u16(maxPoints).u16(maxContours)
    .u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0)
    .out();

  const cps = [...gidByCp.keys()].sort((a, b) => a - b);
  const os2 = W()
    .u16(4).i16(ADVANCE).u16(400).u16(5).u16(0)
    .i16(650).i16(600).i16(0).i16(0)
    .i16(650).i16(600).i16(0).i16(400)
    .i16(100).i16(400).i16(0)
    .bytes([2, 0, 5, 9, 0, 0, 0, 0, 0, 0])          // PANOSE: Latin text, monospaced
    .u32(0).u32(0).u32(0).u32(0)
    .tag("DFCP").u16(0x0040)                        // vendor, fsSelection = REGULAR
    .u16(cps[0]).u16(cps[cps.length - 1])
    .i16(ASCENT).i16(DESCENT).i16(0)
    .u16(ASCENT).u16(-DESCENT)
    .u32(0).u32(0)
    .i16(600).i16(900)
    .u16(0x0020).u16(0x0020).u16(0)
    .out();

  const lc = W();
  for (const off of loca) lc.u32(off);
  const locaT = lc.pad4().out();

  const name = nameTable([
    [0, "Traced at build time from the Dwarf Fortress interface tileset (data/art/curses_640x300.png). Glyph shapes are Bay 12 Games' artwork; see NOTICE."],
    [1, family],
    [2, "Regular"],
    [3, "dwf:" + family],
    [4, family],
    [5, "Version 1.000"],
    [6, family.replace(/\s+/g, "")],
  ]);

  const post = W()
    .u32(0x00030000).u32(0).i16(-100).i16(50)
    .u32(1).u32(0).u32(0).u32(0).u32(0)
    .out();

  const tables = [
    ["OS/2", os2], ["cmap", cmapTable(gidByCp)], ["glyf", glyf], ["head", head],
    ["hhea", hhea], ["hmtx", hmtx], ["loca", locaT], ["maxp", maxp],
    ["name", name], ["post", post],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const n = tables.length;
  const sr = 16 * Math.pow(2, Math.floor(Math.log2(n)));
  const dir = W().u32(0x00010000).u16(n).u16(sr).u16(Math.log2(sr / 16)).u16(n * 16 - sr);
  let offset = 12 + n * 16;
  const offsets = [];
  for (const [, data] of tables) {
    offsets.push(offset);
    offset += Math.ceil(data.length / 4) * 4;
  }
  tables.forEach(([tagName, data], i) =>
    dir.tag(tagName).u32(checksum(data)).u32(offsets[i]).u32(data.length));
  const font = W().bytes(dir.out());
  for (const [, data] of tables) font.bytes(data).pad4();
  const bytes = font.out();

  // head.checkSumAdjustment = 0xB1B0AFBA - checksum(whole file), patched in place.
  const csaAt = offsets[tables.findIndex(t => t[0] === "head")] + 8;
  const adj = (0xb1b0afba - checksum(bytes)) >>> 0;
  bytes[csaAt] = (adj >>> 24) & 0xff;
  bytes[csaAt + 1] = (adj >>> 16) & 0xff;
  bytes[csaAt + 2] = (adj >>> 8) & 0xff;
  bytes[csaAt + 3] = adj & 0xff;
  return bytes;
}

/** atlas PNG bytes -> font bytes. The whole conversion, in one pure call. */
export function convertAtlas(pngBytes) {
  const { width, height, rgba } = decodePng(Buffer.from(pngBytes));
  const { masks, cellW, cellH } = masksFromRGBA(rgba, width, height);
  return buildFont(masks, { cellW, cellH });
}

// -----------------------------------------------------------------------------------------------
// W1: resolved, never hardcoded. "" when no DF install -- main() then says what to pass.
const DF_ROOT_W1 = resolveDfRoot().root;
const DEFAULT_ATLAS = DF_ROOT_W1 ? join(DF_ROOT_W1, "data", "art", "curses_640x300.png") : "";

function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..", "..");
  const atlasPath = arg("atlas", DEFAULT_ATLAS);
  const outPath = resolve(root, arg("out", "web/fonts/df-curses.ttf"));

  const png = readFileSync(atlasPath);
  const font = convertAtlas(png);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, font);

  const sha = createHash("sha256").update(font).digest("hex");
  console.log(`atlas : ${atlasPath}`);
  console.log(`out   : ${outPath}`);
  console.log(`bytes : ${font.length}`);
  console.log(`sha256: ${sha}`);
  console.log(`family: ${FAMILY}   cell: ${CELL_W}x${CELL_H}px   em: ${UNITS_PER_EM} (${PU}/px)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
