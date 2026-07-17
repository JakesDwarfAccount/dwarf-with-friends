// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// D1 native-font contract. OFFLINE: no DF, no server, no browser, no network.
//
// Proves tools/ws2/build_df_font.mjs -- the build-time converter that traces DF's CP437 bitmap
// atlas into web/fonts/df-curses.ttf:
//   1. decodes the PNG (1-bit palette, the format DF actually ships) with node:zlib alone;
//   2. slices the 16x16 grid into 256 8x12 cell masks, with the ON rule rejecting the magenta
//      colour key, a black background, and transparency alike;
//   3. traces each mask into closed contours whose NONZERO-WINDING fill reproduces the source
//      pixels EXACTLY -- including holes ('O') and corner-touching diagonals ('X');
//   4. assembles a structurally valid TrueType file (sorted table directory, per-table checksums,
//      cmap format 4, loca/glyf agreement, monospace hmtx, lsb == xMin);
//   5. is DETERMINISTIC: the same atlas in gives byte-identical bytes out;
//   6. and that the COMMITTED web/fonts/df-curses.ttf is a valid font with the metrics the
//      Foundation Owner's CSS contract depends on.
//
// Risky cells carry a test-the-test: a seeded-bad implementation the assertion must REJECT (the
// b151 pattern). The synthetic atlas is generated here from first principles, so the test needs
// neither a DF install nor any Bay12 art of its own.
//
//   node tools/harness/glyph_font_test.mjs
// Exit: 0 PASS, 1 FAIL.

import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const F = await import(pathToFileURL(join(root, "tools/ws2/build_df_font.mjs")).href);

let pass = 0, fail = 0;
const cell = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
};
const rejects = (name, fn) => {
  try { fn(); fail++; console.log(`  FAIL ${name} -- seeded-bad implementation was ACCEPTED`); }
  catch { pass++; console.log(`  ok   ${name} (seeded-bad rejected)`); }
};

// ---------------------------------------------------------------------------------------------
// A synthetic 128x192 atlas, encoded as a REAL PNG (8-bit RGB) so decodePng is exercised too.
// 'A' has an enclosed counter, 'O' a hole, 'X' two diagonals touching only at a vertex, 0xDB a
// full block, 'g' a descender. Backgrounds cycle magenta-key / black / transparent so the ON rule
// is tested against all three conventions DF's tilesets use.
// ---------------------------------------------------------------------------------------------
const CW = 8, CH = 12, COLS = 16, ROWS = 16, W = COLS * CW, H = ROWS * CH;

const ART = {
  0x41: ["........", "..##....", ".####...", "##..##..", "##..##..", "##..##..",
         "######..", "##..##..", "##..##..", "##..##..", "........", "........"],
  0x4f: ["........", ".####...", "##..##..", "##..##..", "##..##..", "##..##..",
         "##..##..", "##..##..", "##..##..", ".####...", "........", "........"],
  0x58: ["........", "##....##", ".##..##.", "..####..", "...##...", "...##...",
         "..####..", ".##..##.", "##....##", "........", "........", "........"],
  0x67: ["........", "........", "........", "........", ".#####..", "##..##..",
         "##..##..", "##..##..", ".#####..", "....##..", "##..##..", ".####..."],
  0xdb: Array(12).fill("########"),
};

const maskOf = (c) => {
  const m = new Uint8Array(CW * CH);
  const art = ART[c];
  if (art) for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) m[y * CW + x] = art[y][x] === "#" ? 1 : 0;
  return m;
};

/** Encode an RGBA buffer as a real (uncompressed-filter, zlib) 8-bit RGBA PNG. */
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;                                  // filter: None
    for (let x = 0; x < w * 4; x++) raw[y * (1 + w * 4) + 1 + x] = rgba[y * w * 4 + x];
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function synthRGBA() {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let c = 0; c < 256; c++) {
    const ox = (c % COLS) * CW, oy = Math.floor(c / COLS) * CH;
    const art = ART[c] || null;
    const bg = c % 3 === 0 ? [255, 0, 255, 255] : (c % 3 === 1 ? [0, 0, 0, 255] : [0, 0, 0, 0]);
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const p = ((oy + y) * W + (ox + x)) * 4;
      const v = (art && art[y][x] === "#") ? [255, 255, 255, 255] : bg;
      px[p] = v[0]; px[p + 1] = v[1]; px[p + 2] = v[2]; px[p + 3] = v[3];
    }
  }
  return px;
}

const eqMask = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const show = (m) => {
  const out = [];
  for (let y = 0; y < CH; y++) {
    let s = "";
    for (let x = 0; x < CW; x++) s += m[y * CW + x] ? "#" : ".";
    out.push(s);
  }
  return out.join("\n");
};

// ---------------------------------------------------------------------------------------------
console.log("D1 font converter -- PNG decode + atlas slicing");
// ---------------------------------------------------------------------------------------------

const png = encodePng(synthRGBA(), W, H);
const decoded = F.decodePng(png);
const sliced = F.masksFromRGBA(decoded.rgba, decoded.width, decoded.height);

cell("decodePng round-trips a real PNG (node:zlib only, zero deps)", () => {
  assert.equal(decoded.width, 128);
  assert.equal(decoded.height, 192);
  assert.equal(decoded.rgba.length, 128 * 192 * 4);
});

cell("slices 256 cells at 8x12 from the 16x16 grid", () => {
  assert.equal(sliced.masks.length, 256);
  assert.equal(sliced.cellW, 8);
  assert.equal(sliced.cellH, 12);
});

cell("the ON rule rejects the magenta key, black, AND transparency (all three backgrounds)", () => {
  for (const c of [0x20, 0x21, 0x22]) {   // one cell of each background cycle, all blank
    assert.ok(sliced.masks[c].every(v => v === 0), `cell 0x${c.toString(16)} should be blank`);
  }
  assert.ok(eqMask(sliced.masks[0x41], maskOf(0x41)), "'A' mask");
  assert.ok(eqMask(sliced.masks[0xdb], maskOf(0xdb)), "full-block mask");
});

rejects("test-the-test: a mid-grey glyph (luma < 128) is NOT read as ON", () => {
  const bad = synthRGBA();
  const ox = (0x41 % COLS) * CW, oy = Math.floor(0x41 / COLS) * CH;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const p = ((oy + y) * W + (ox + x)) * 4;
    if (bad[p] === 255 && bad[p + 1] === 255) { bad[p] = 60; bad[p + 1] = 60; bad[p + 2] = 60; }
  }
  const s = F.masksFromRGBA(bad, W, H);
  assert.ok(eqMask(s.masks[0x41], maskOf(0x41)), "a dim glyph must NOT slice as ON");
});

rejects("test-the-test: a wrong-sized atlas is rejected, not silently mis-sliced", () => {
  F.masksFromRGBA(new Uint8ClampedArray(100 * 100 * 4), 100, 100);
});

// ---------------------------------------------------------------------------------------------
console.log("D1 font converter -- contour tracing (outline -> nonzero fill -> pixels)");
// ---------------------------------------------------------------------------------------------

cell("all 256 cells round-trip: rasterize(trace(mask)) === mask", () => {
  for (let c = 0; c < 256; c++) {
    const m = sliced.masks[c];
    const back = F.rasterizeContours(F.traceContours(m, CW, CH), CW, CH);
    assert.ok(eqMask(m, back), `cell 0x${c.toString(16)}\nwant:\n${show(m)}\ngot:\n${show(back)}`);
  }
});

const area = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
};

cell("'O' traces to 2 contours with OPPOSITE winding, outer clockwise (TrueType nonzero)", () => {
  const ct = F.traceContours(maskOf(0x4f), CW, CH);
  assert.equal(ct.length, 2, "outer + hole");
  const signs = ct.map(c => Math.sign(area(c)));
  assert.ok(signs.includes(1) && signs.includes(-1), `windings ${signs} must be opposite`);
  const outer = ct.reduce((a, b) => (Math.abs(area(a)) > Math.abs(area(b)) ? a : b));
  assert.equal(Math.sign(area(outer)), -1, "outer contour must be clockwise (negative in y-up)");
});

cell("'X' -- blobs touching only at a corner still fill exactly (ambiguous-vertex walk)", () => {
  const m = maskOf(0x58);
  const back = F.rasterizeContours(F.traceContours(m, CW, CH), CW, CH);
  assert.ok(eqMask(m, back), `X\nwant:\n${show(m)}\ngot:\n${show(back)}`);
});

cell("a blank cell has zero contours (space carries no ink)", () => {
  assert.equal(F.traceContours(new Uint8Array(CW * CH), CW, CH).length, 0);
});

cell("collinear points are merged: the full block is ONE 4-point contour", () => {
  const ct = F.traceContours(maskOf(0xdb), CW, CH);
  assert.equal(ct.length, 1);
  assert.equal(ct[0].length, 4, "a rectangle is 4 points, not 40");
});

rejects("test-the-test: a tracer that drops the hole contour is CAUGHT", () => {
  const m = maskOf(0x4f);
  const ct = F.traceContours(m, CW, CH);
  const outerOnly = [ct.reduce((a, b) => (Math.abs(area(a)) > Math.abs(area(b)) ? a : b))];
  assert.ok(eqMask(m, F.rasterizeContours(outerOnly, CW, CH)), "a filled-in 'O' must NOT equal the ring");
});

rejects("test-the-test: a tracer that shifts a glyph one pixel is CAUGHT", () => {
  const ct = F.traceContours(maskOf(0x41), CW, CH).map(c => c.map(([x, y]) => [x + F.PU, y]));
  assert.ok(eqMask(maskOf(0x41), F.rasterizeContours(ct, CW, CH)), "a 1px-shifted 'A' must NOT equal it");
});

// ---------------------------------------------------------------------------------------------
console.log("D1 font converter -- TrueType assembly + determinism");
// ---------------------------------------------------------------------------------------------

cell("DETERMINISTIC: converting the same atlas twice yields byte-identical fonts", () => {
  const a = F.convertAtlas(png), b = F.convertAtlas(png);
  assert.equal(a.length, b.length);
  assert.ok(Buffer.from(a).equals(Buffer.from(b)), "the converter must be reproducible");
});

// Structural checks run against the COMMITTED font -- the artifact that actually ships.
const ttfPath = join(root, "web/fonts/df-curses.ttf");
const ttf = existsSync(ttfPath) ? new Uint8Array(readFileSync(ttfPath)) : null;

cell("the committed font web/fonts/df-curses.ttf exists", () => {
  assert.ok(ttf, "run: node tools/ws2/build_df_font.mjs");
  assert.ok(ttf.length > 8000, `suspiciously small: ${ttf.length} bytes`);
});

const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
const tag4 = (o) => String.fromCharCode(ttf[o], ttf[o + 1], ttf[o + 2], ttf[o + 3]);
const dir = (() => {
  const n = dv.getUint16(4);
  const out = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    out[tag4(o)] = { checksum: dv.getUint32(o + 4), offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) };
  }
  return out;
})();

cell("sfnt header: TrueType outlines, sorted directory, the 10 tables OTS requires", () => {
  assert.equal(dv.getUint32(0), 0x00010000, "sfntVersion must be 0x00010000 (glyf outlines)");
  const want = ["OS/2", "cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"];
  for (const t of want) assert.ok(dir[t], `missing table ${t}`);
  const n = dv.getUint16(4);
  const tags = [];
  for (let i = 0; i < n; i++) tags.push(tag4(12 + i * 16));
  assert.deepEqual(tags, [...tags].sort(), "table directory must be sorted by tag");
});

cell("every table's directory checksum matches its bytes", () => {
  const sum = (b) => {
    let s = 0;
    for (let i = 0; i < b.length; i += 4) {
      const v = ((b[i] || 0) << 24) | ((b[i + 1] || 0) << 16) | ((b[i + 2] || 0) << 8) | (b[i + 3] || 0);
      s = (s + (v >>> 0)) >>> 0;
    }
    return s >>> 0;
  };
  for (const [t, e] of Object.entries(dir)) {
    if (t === "head") continue;   // carries checkSumAdjustment; checked separately
    assert.equal(sum(ttf.subarray(e.offset, e.offset + e.length)), e.checksum, `checksum: ${t}`);
  }
});

cell("head: magic, unitsPerEm 1200 (100 units per atlas pixel), long loca, patched adjustment", () => {
  const h = dir.head.offset;
  assert.equal(dv.getUint32(h + 12), 0x5f0f3cf5, "magicNumber");
  assert.equal(dv.getUint16(h + 18), 1200, "unitsPerEm");
  assert.equal(dv.getInt16(h + 50), 1, "indexToLocFormat must be long");
  assert.notEqual(dv.getUint32(h + 8), 0, "checkSumAdjustment must be patched");
});

cell("METRICS the CSS contract depends on: 8x12 cell, monospace, line box == one em", () => {
  assert.equal(F.UNITS_PER_EM, 1200);
  assert.equal(F.ADVANCE, 800);
  assert.equal(F.ASCENT - F.DESCENT, F.UNITS_PER_EM, "ascent+descent must be exactly one em");
  assert.deepEqual([F.CELL_W, F.CELL_H], [8, 12]);
  const hh = dir.hhea.offset;
  assert.equal(dv.getInt16(hh + 4), 1000, "hhea.ascender");
  assert.equal(dv.getInt16(hh + 6), -200, "hhea.descender");
  assert.equal(dv.getInt16(hh + 8), 0, "hhea.lineGap must be 0");
  const numH = dv.getUint16(hh + 34);
  for (let i = 0; i < numH; i++) {
    assert.equal(dv.getUint16(dir.hmtx.offset + i * 4), 800, `glyph ${i} advance must be 800 (monospace)`);
  }
});

cell("hmtx.lsb == glyph xMin for every glyph (head.flags bit 1 asserts it; lying phase-shifts text)", () => {
  const numGlyphs = dv.getUint16(dir.maxp.offset + 4);
  for (let g = 0; g < numGlyphs; g++) {
    const o0 = dv.getUint32(dir.loca.offset + g * 4), o1 = dv.getUint32(dir.loca.offset + (g + 1) * 4);
    const lsb = dv.getInt16(dir.hmtx.offset + g * 4 + 2);
    const xMin = o1 > o0 ? dv.getInt16(dir.glyf.offset + o0 + 2) : 0;
    assert.equal(lsb, xMin, `glyph ${g}: lsb ${lsb} != xMin ${xMin}`);
  }
});

cell("loca/glyf agree: 257 glyphs (.notdef + 256 cells), monotonic offsets, blank space glyph", () => {
  const numGlyphs = dv.getUint16(dir.maxp.offset + 4);
  assert.equal(numGlyphs, 257);
  let prev = -1;
  for (let i = 0; i <= numGlyphs; i++) {
    const off = dv.getUint32(dir.loca.offset + i * 4);
    assert.ok(off >= prev, "loca must be monotonic");
    assert.ok(off <= dir.glyf.length, "loca offset past end of glyf");
    prev = off;
  }
  const g = 0x20 + 1;   // CP437 space
  assert.equal(dv.getUint32(dir.loca.offset + g * 4), dv.getUint32(dir.loca.offset + (g + 1) * 4),
    "space must be a zero-length glyph");
});

cell("glyf: real DF glyphs survived -- 'A' has a counter, 'g' descends below the baseline", () => {
  const at = (gid) => dir.glyf.offset + dv.getUint32(dir.loca.offset + gid * 4);
  assert.equal(dv.getInt16(at(0x41 + 1)), 2, "'A' = outline + counter");
  assert.ok(dv.getInt16(at(0x67 + 1) + 4) < 0, "'g' yMin must be negative (a real descender)");
  const [xMin, xMax] = [2, 6].map(k => dv.getInt16(at(0x41 + 1) + k));
  assert.ok(xMin >= 0 && xMax <= 800, `'A' x bbox ${xMin}..${xMax} must stay inside the 8px cell`);
});

// ---------------------------------------------------------------------------------------------
console.log("D1 font converter -- CP437 mapping");
// ---------------------------------------------------------------------------------------------

function lookup(cp) {
  const c = dir.cmap.offset;
  assert.equal(dv.getUint16(c + 4), 3, "platformID 3 (Windows)");
  assert.equal(dv.getUint16(c + 6), 1, "encodingID 1 (BMP)");
  const s = c + dv.getUint32(c + 8);
  assert.equal(dv.getUint16(s), 4, "cmap subtable format 4");
  const segX2 = dv.getUint16(s + 6), seg = segX2 / 2;
  const endO = s + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
  for (let i = 0; i < seg; i++) {
    if (cp > dv.getUint16(endO + i * 2)) continue;
    if (cp < dv.getUint16(startO + i * 2)) return 0;
    assert.equal(dv.getUint16(rangeO + i * 2), 0, "idRangeOffset must be 0 (delta-only cmap)");
    return (cp + dv.getUint16(deltaO + i * 2)) & 0xffff;
  }
  return 0;
}

cell("the grid IS code page 437: 0x41='A', 0xDB=FULL BLOCK, 0x02=inverse smiley", () => {
  assert.equal(F.CP437.length, 256);
  assert.equal(F.CP437[0x41], 0x0041);
  assert.equal(F.CP437[0xdb], 0x2588);
  assert.equal(F.CP437[0x02], 0x263b);
});

cell("cmap maps Unicode -> the right cell for ASCII, box-drawing, and DF's own symbols", () => {
  assert.equal(lookup(0x0041), 0x41 + 1, "'A'");
  assert.equal(lookup(0x007a), 0x7a + 1, "'z'");
  assert.equal(lookup(0x0020), 0x20 + 1, "space");
  assert.equal(lookup(0x2588), 0xdb + 1, "FULL BLOCK");
  assert.equal(lookup(0x263c), 0x0f + 1, "U+263C -- DF's value/coin glyph");
  assert.equal(lookup(0x0393), 0xe2 + 1, "U+0393 GAMMA -- DF's weight unit");
  assert.equal(lookup(0x2502), 0xb3 + 1, "box drawing");
});

cell("codepoints outside CP437 do NOT resolve -- which is why the fallback chain is REQUIRED", () => {
  assert.equal(lookup(0x1f50d), 0, "emoji");
  assert.equal(lookup(0x2014), 0, "em dash");
  assert.equal(lookup(0x4e2d), 0, "CJK");
});

rejects("test-the-test: an off-by-one cmap is CAUGHT (.notdef occupies gid 0)", () => {
  assert.equal(lookup(0x0041), 0x41, "gid must be cell+1");
});

// ---------------------------------------------------------------------------------------------
console.log("D1 font converter -- shipping contract");
// ---------------------------------------------------------------------------------------------

cell("the plugin names a font MIME type (httplib has none for .ttf => no Content-Type at all)", () => {
  const cpp = readFileSync(join(root, "src/http_server.cpp"), "utf8");
  assert.match(cpp, /set_file_extension_and_mimetype_mapping\("ttf",\s*"font\/ttf"\)/);
});

cell("the plugin mounts DF's data/art at /dfart (atlas reachable for a future regen/runtime path)", () => {
  const cpp = readFileSync(join(root, "src/http_server.cpp"), "utf8");
  assert.match(cpp, /set_mount_point\("\/dfart",\s*"data\/art"\)/);
});

cell("the converter is re-runnable and committed (a new DF version can regenerate the font)", () => {
  assert.ok(existsSync(join(root, "tools/ws2/build_df_font.mjs")));
  const src = readFileSync(join(root, "tools/ws2/build_df_font.mjs"), "utf8");
  assert.match(src, /SPDX-License-Identifier: AGPL-3\.0-only/, "AGPL header required");
  assert.match(src, /created \/ modified: ZERO/, "determinism must stay explicit");
});

cell("NOTICE records the provenance of the committed font (Bay 12 glyph art)", () => {
  const notice = readFileSync(join(root, "NOTICE"), "utf8");
  assert.match(notice, /df-curses\.ttf/, "NOTICE must attribute web/fonts/df-curses.ttf");
});

// ---------------------------------------------------------------------------------------------
console.log("D1-CRISP -- the 1-bit contract (the em is NOT the defect; the AA threshold is the fix)");
// ---------------------------------------------------------------------------------------------
const css = readFileSync(join(root, "web/css/dwf.css"), "utf8");

cell("the em is divisible by the cell height -- one atlas pixel is a WHOLE number of font units", () => {
  assert.equal(F.UNITS_PER_EM % F.CELL_H, 0,
    `unitsPerEm ${F.UNITS_PER_EM} must divide by the ${F.CELL_H}px cell, else every glyph edge ` +
    `lands on a fractional unit and the face re-blurs at 12px`);
  assert.equal(F.UNITS_PER_EM / F.CELL_H, F.PU, "units-per-atlas-pixel must be exactly PU");
  assert.equal(F.ADVANCE % F.CELL_W, 0, "the advance must divide by the cell width");
});

cell("the crisp token exists and is wired to the .dwfui-crisp-text class", () => {
  assert.match(css, /--dwfui-text-crisp:\s*url\(#dwfui-crisp\)/,
    "the --dwfui-text-crisp token must name the in-document filter");
  assert.match(css, /\.dwfui-crisp-text\s*\{[^}]*filter:\s*var\(--dwfui-text-crisp\)/,
    ".dwfui-crisp-text must apply the token (the class is the only supported way to switch it on)");
});

cell("the documented alpha threshold is inside the MEASURED safe band (0.6 .. 0.875)", () => {
  // tableValues="0 0 0 1" == a discrete step whose cut sits at (index of the first 1) / n.
  const m = css.match(/tableValues="([01](?:\s+[01])*)"/);
  assert.ok(m, "the required <feFuncA type=\"discrete\"> snippet must stay documented in the CSS");
  const tv = m[1].trim().split(/\s+/).map(Number);
  const cut = tv.indexOf(1) / tv.length;
  // Measured over all 256 CP437 cells in headless Chrome: a FALSE edge pixel never exceeds 0.6
  // coverage, and a TRUE ink pixel is never below 0.875. 0.5 fattens 447 px by closing 1px gaps.
  assert.ok(cut >= 0.6 && cut <= 0.875, `threshold ${cut} is outside the measured safe band`);
});

// ---- D1-INTEGRATION: the two ways this whole feature dies SILENTLY --------------------------
// Both of these already happened once. Neither throws, neither logs, neither fails a test that
// existed at the time -- the product just quietly renders the wrong thing, which is why they are
// pinned here rather than left to review.

cell("the SVG filter EXISTS in the client document -- without it the crisp class is a no-op", () => {
  // Chrome does not support external or data:-URL filter refs (measured), so `url(#dwfui-crisp)`
  // only resolves against a filter in the SAME document. A missing one renders UNFILTERED -- it
  // degrades quietly instead of breaking, so nothing but this assertion would ever catch it.
  const html = readFileSync(join(root, "web", "index.html"), "utf8");
  assert.match(html, /<filter\s+id="dwfui-crisp"/,
    "web/index.html must inline the <filter id=\"dwfui-crisp\"> the CSS token references");
  assert.match(html, /<feFuncA\s+type="discrete"\s+tableValues="0 0 0 1"\s*\/>/,
    "the filter must be the 1-bit alpha threshold at the measured 0.75 cut");
});

cell("THE FONT ACTUALLY REACHES THE ROWS -- the DWFUI chassis declares its own font", () => {
  // THE BUG THIS PINS: .dwfui-row/.dwfui-copy/.dwfui-label declared NO font, so the component layer
  // INHERITED the host document's -- Consolas 14px in the client, Inter 15px (SANS-SERIF) in Parity
  // Studio. The @font-face was declared, the token was right, the face was committed and tested,
  // and the product still rendered the wrong font, because nothing consumed the token. A font that
  // is not on screen is not shipped, and no other test in this repo could see the difference.
  const chassis = /:is\(\.dwfui-row--slab, \.dwfui-row--table\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(chassis, "the migrated row chassis rule is gone -- did the selector change?");
  assert.match(chassis[1], /font:\s*var\(--dwfui-font\)/,
    "the row chassis MUST declare font:var(--dwfui-font); inheriting it is how the DF face " +
    "silently became Inter in the gallery and Consolas in the client");
});

cell("no SHARED DWFUI rule re-hardcodes the mono stack (that is what orphaned the font)", () => {
  // Scope: the SHARED component layer only -- a selector whose subject is a bare `.dwfui-*`. An
  // id-scoped override (`#world3dScreen ... .dwfui-head-title`, which deliberately uses Josefin Sans)
  // belongs to that SCREEN, not to the shared layer, and is a family's business.
  // ONE sanctioned exception in the shared layer: `.dwfui-actions button` renders EMOJI, which the
  // CP437 face cannot resolve, so it keeps the mono stack ON PURPOSE (see the rule's own comment).
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");   // strip comments: they DISCUSS these stacks
  const offenders = [];
  const re = /([^{}]*\.dwfui-[a-z-]+[^{}]*)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) {
    const sel = m[1].trim();
    if (!/ui-monospace|Consolas/.test(m[2])) continue;
    // A `:not(.dwfui-tab)` GUARD is a negation, not a subject: `.farm-season-tab:not(.dwfui-tab)` is a
    // legacy CONSUMER rule that is switched OFF wherever the shared class is present (Wave 4 F3). It
    // is the opposite of a shared-layer rule, so it cannot orphan the shared font.
    if (!/\.dwfui-[a-z-]+/.test(sel.replace(/:not\([^)]*\)/g, ""))) continue;
    if (sel.includes("#")) continue;                   // an id-scoped family override
    if (/\.dwfui-actions\s+button/.test(sel)) continue; // the sanctioned emoji exception
    offenders.push(sel.split("\n").pop().trim().slice(0, 70));
  }
  assert.deepEqual(offenders, [],
    "these shared .dwfui-* rules hardcode a font family instead of using var(--dwfui-font):\n  " +
    offenders.join("\n  "));
});

cell("the traced face is weight 400 ONLY -- a bold DWFUI rule would trigger synthetic bold", () => {
  // Chrome fakes a missing bold by SMEARING the glyph horizontally. That is the exact artefact
  // D1-CRISP removes, so a `font-weight:700` on the DF face would re-introduce it AND fatten the
  // stems off the 8x12 grid. var(--dwfui-font) carries weight 400 with the face for this reason.
  assert.match(css, /--dwfui-font:\s*var\(--dwfui-font-weight,\s*400\)/,
    "--dwfui-font must default to weight 400: the traced face ships exactly one weight");
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${fail ? "FAIL" : "PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
