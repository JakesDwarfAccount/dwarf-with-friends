// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// sprite_bake_fixture_test.mjs -- OFFLINE fixture test for the W11 install-time
// sprite bake (host/pnglite.mjs + host/bake_sprites.mjs) and for the committed
// recipe's integrity (host/sprite_recipe.json). NO Dwarf Fortress install, NO
// server: all sources are synthetic PNGs in a temp dir.
//
//   node tools/harness/sprite_bake_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// The compositor's correctness bar is "bit-for-bit Pillow": the expected pixel
// values below were computed with Pillow's Image.alpha_composite (the tool the
// recipe was authored against) and inlined -- the test does NOT re-derive them
// with the code under test. The full-resolution proof (Node replay vs the
// original baked PNGs: 8/8 pixel-identical against a real DF install) was run
// 2026-07-14 and is recorded in the W11 closeout; this suite keeps the pure
// logic honest offline.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import zlib from "node:zlib";
import process from "node:process";
import { decodePng, encodePng } from "../../host/pnglite.mjs";
import { bakeSprites, spriteBakeState } from "../../host/bake_sprites.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

const TMP = mkdtempSync(join(os.tmpdir(), "dwf-bake-"));

function img(w, h, fill = [0, 0, 0, 0]) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width: w, height: h, data };
}
function setPx(im, x, y, rgba) { im.data.set(rgba, (y * im.width + x) * 4); }
function getPx(im, x, y) { const i = (y * im.width + x) * 4; return [...im.data.subarray(i, i + 4)]; }

try {
  console.log("# node --check");
  for (const f of ["pnglite.mjs", "bake_sprites.mjs"]) {
    try { execFileSync(process.execPath, ["--check", join(REPO, "host", f)], { stdio: "pipe" }); check(`${f} passes node --check`, true); }
    catch (e) { check(`${f} passes node --check`, false, e.message); }
  }

  // ---------------- PNG codec ----------------
  console.log("\n# pnglite: encode/decode round-trip");
  {
    const src = img(7, 5);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) {
      setPx(src, x, y, [(x * 37) & 0xff, (y * 91) & 0xff, (x * y * 13) & 0xff, (x + y) % 3 === 0 ? 0 : 200 + x]);
    }
    const back = decodePng(encodePng(src));
    check("RGBA8 round-trips exactly",
      back.width === 7 && back.height === 5 && Buffer.from(back.data).equals(Buffer.from(src.data)));
  }

  console.log("\n# pnglite: unfilter paths (hand-filtered scanlines, one filter per row)");
  {
    // 4x5 RGBA image; rows written with filter types 0..4. The FORWARD filtering
    // below is independent arithmetic per the PNG spec -- the decoder must invert it.
    const w = 4, h = 5, bpp = 4;
    const rows = [];
    for (let y = 0; y < h; y++) {
      const r = Buffer.alloc(w * 4);
      for (let x = 0; x < w; x++) r.set([x * 50 + y, 255 - x * 30, (x * x * 7 + y * 3) & 0xff, x % 2 ? 128 : 255], x * 4);
      rows.push(r);
    }
    const paeth = (a, b, c) => {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
    };
    const raw = [];
    const zero = Buffer.alloc(w * 4);
    for (let y = 0; y < h; y++) {
      const ft = y % 5;
      const cur = rows[y], up = y ? rows[y - 1] : zero;
      const line = Buffer.alloc(w * 4);
      for (let i = 0; i < w * 4; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = up[i], c = i >= bpp ? up[i - bpp] : 0;
        if (ft === 0) line[i] = cur[i];
        else if (ft === 1) line[i] = (cur[i] - a) & 0xff;
        else if (ft === 2) line[i] = (cur[i] - b) & 0xff;
        else if (ft === 3) line[i] = (cur[i] - ((a + b) >> 1)) & 0xff;
        else line[i] = (cur[i] - paeth(a, b, c)) & 0xff;
      }
      raw.push(Buffer.from([ft]), line);
    }
    const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
    const crc = (...bs) => { let c = 0xffffffff; for (const b of bs) for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
      const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
      const cb = Buffer.alloc(4); cb.writeUInt32BE(crc(head.subarray(4), data), 0);
      return Buffer.concat([head, data, cb]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(raw))), chunk("IEND", Buffer.alloc(0)),
    ]);
    const dec = decodePng(png, "filtered-fixture");
    const expected = Buffer.concat(rows);
    check("filters Sub/Up/Average/Paeth all invert correctly",
      Buffer.from(dec.data).equals(expected));
  }

  // ---------------- Pillow-exact compositing ----------------
  console.log("\n# bake ops: Pillow-exact alpha compositing (expected values from Pillow)");
  {
    // (dst) + (src over) => expected -- computed with PIL.Image.alpha_composite.
    const CASES = [
      [[50, 60, 70, 200], [100, 150, 200, 128], [78, 111, 143, 228]],
      [[0, 0, 0, 0], [100, 150, 200, 128], [100, 150, 200, 128]],
      [[10, 20, 30, 255], [200, 100, 50, 1], [11, 20, 30, 255]],
      [[255, 255, 255, 40], [0, 0, 0, 90], [57, 57, 57, 116]],
      [[1, 2, 3, 77], [9, 8, 7, 0], [1, 2, 3, 77]],          // src a=0: no-op
      [[1, 2, 3, 77], [9, 8, 7, 255], [9, 8, 7, 255]],       // src a=255: replace
    ];
    // exercise through the public surface: a 1x1 source blitted over a 1x1 fill
    for (const [dst, src, want] of CASES) {
      const dfr = join(TMP, `over-${dst.join("_")}-${src.join("_")}`);
      mkdirSync(join(dfr, "art"), { recursive: true });
      writeFileSync(join(dfr, "art", "s.png"), encodePng(img(1, 1, src)));
      const recipe = {
        version: 1, sources: ["art/s.png"], remaps: [],
        outputs: { "t.png": { w: 1, h: 1, ops: [["fill", ...dst], ["b", 0, 0, 0, 1, 1, 0, 0, -1]] } },
      };
      writeFileSync(join(dfr, "r.json"), JSON.stringify(recipe));
      const res = bakeSprites({ dfRoot: dfr, outDir: join(dfr, "out"), recipePath: join(dfr, "r.json") });
      const got = res.ok ? getPx(decodePng(readFileSync(join(dfr, "out", "t.png"))), 0, 0) : null;
      check(`over ${JSON.stringify(src)} on ${JSON.stringify(dst)} -> ${JSON.stringify(want)}`,
        got && got.join(",") === want.join(","), `got ${JSON.stringify(got)}`);
    }
  }

  // ---------------- mini end-to-end recipe: remap, clip, scale, clear ----------------
  console.log("\n# bakeSprites: mini recipe end-to-end");
  {
    const dfr = join(TMP, "mini-df");
    mkdirSync(join(dfr, "data", "art"), { recursive: true });
    // sheet.png 4x2: two 2x1 "cells": left = red,blue ; right = white,semi-green
    const sheet = img(4, 2);
    setPx(sheet, 0, 0, [255, 0, 0, 255]); setPx(sheet, 1, 0, [0, 0, 255, 255]);
    setPx(sheet, 0, 1, [255, 0, 0, 255]); setPx(sheet, 1, 1, [0, 0, 255, 255]);
    setPx(sheet, 2, 0, [255, 255, 255, 255]); setPx(sheet, 3, 0, [0, 255, 0, 128]);
    setPx(sheet, 2, 1, [7, 7, 7, 0]); setPx(sheet, 3, 1, [40, 41, 42, 255]);
    writeFileSync(join(dfr, "data", "art", "sheet.png"), encodePng(sheet));
    // palette 2 slots x 2 rows; slot colors deliberately DUPLICATED in the key row:
    // both key slots are red -> later slot must win (dict-comprehension order).
    const pal = img(2, 2);
    setPx(pal, 0, 0, [255, 0, 0, 255]); setPx(pal, 1, 0, [255, 0, 0, 255]);
    setPx(pal, 0, 1, [0, 255, 0, 255]); setPx(pal, 1, 1, [255, 255, 0, 255]);
    writeFileSync(join(dfr, "data", "art", "pal.png"), encodePng(pal));
    const recipe = {
      version: 1,
      sources: ["data/art/sheet.png"],
      remaps: [{ palette: "data/art/pal.png", from: 0, to: 1 }],
      outputs: {
        "base.png": { w: 2, h: 2, ops: [
          ["b", 0, 0, 0, 2, 2, 0, 0, 0],     // left cell, remapped: red -> YELLOW (slot 1 wins)
          ["b", 0, 2, 0, 2, 2, 1, 1, -1],    // right cell at (1,1): clipped to 1x1 (only white lands)
        ] },
        "big.png": { w: 4, h: 4, ops: [
          ["fill", 9, 9, 9, 255],
          ["o", "base.png", 2, 0, 0],        // 2x nearest of base over gray
          ["clear", [[0, 0], [3, 3]]],
        ] },
      },
    };
    writeFileSync(join(dfr, "r.json"), JSON.stringify(recipe));
    const res = bakeSprites({ dfRoot: dfr, outDir: join(dfr, "out"), recipePath: join(dfr, "r.json") });
    check("mini recipe bakes ok", res.ok === true && res.written.join(",") === "base.png,big.png",
      JSON.stringify(res.problems));
    if (res.ok) {
      const base = decodePng(readFileSync(join(dfr, "out", "base.png")));
      check("palette remap applied, LATER duplicate slot wins (red->yellow not green)",
        getPx(base, 0, 0).join(",") === "255,255,0,255" && getPx(base, 0, 1).join(",") === "255,255,0,255");
      check("non-key color untouched by remap", getPx(base, 1, 0).join(",") === "0,0,255,255");
      check("second blit clipped: only its top-left pixel landed inside the canvas",
        getPx(base, 1, 1).join(",") === "255,255,255,255");
      const big = decodePng(readFileSync(join(dfr, "out", "big.png")));
      check("output-composite at 2x nearest (yellow block top-left)",
        getPx(big, 1, 0).join(",") === "255,255,0,255" && getPx(big, 0, 1).join(",") === "255,255,0,255" &&
        getPx(big, 2, 0).join(",") === "0,0,255,255");
      check("clear op punches transparent holes", getPx(big, 0, 0).join(",") === "0,0,0,0" &&
        getPx(big, 3, 3).join(",") === "0,0,0,0");
    }
    // spriteBakeState against this mini world
    const st = spriteBakeState({ dfRoot: dfr, outDir: join(dfr, "out"), recipePath: join(dfr, "r.json") });
    check("spriteBakeState: bakeable + all baked present",
      st.bakeable === true && st.missingBaked.length === 0 && st.bakedPresent.length === 2);
    rmSync(join(dfr, "out", "big.png"));
    const st2 = spriteBakeState({ dfRoot: dfr, outDir: join(dfr, "out"), recipePath: join(dfr, "r.json") });
    check("spriteBakeState: detects a missing baked file", st2.missingBaked.join(",") === "big.png");
  }

  // ---------------- failure modes ----------------
  console.log("\n# failure modes");
  {
    const empty = join(TMP, "empty-df");
    mkdirSync(empty, { recursive: true });
    const res = bakeSprites({ dfRoot: empty }); // real committed recipe, no art
    check("art-less DF root: fails with the graphical-edition message, writes nothing",
      res.ok === false && res.written.length === 0 &&
      res.problems.some((s) => /graphical|DF art/i.test(s)));
    const badRecipe = join(TMP, "bad.json");
    writeFileSync(badRecipe, "{not json");
    check("unreadable recipe -> clean failure",
      bakeSprites({ dfRoot: empty, recipePath: badRecipe }).ok === false);
    check("future recipe version -> clean refusal",
      (() => { writeFileSync(badRecipe, JSON.stringify({ version: 99 })); return bakeSprites({ dfRoot: empty, recipePath: badRecipe }).ok === false; })());
  }

  // ---------------- committed recipe integrity ----------------
  console.log("\n# host/sprite_recipe.json integrity");
  {
    const recipe = JSON.parse(readFileSync(join(REPO, "host", "sprite_recipe.json"), "utf8"));
    const EXPECT = [
      "dwarf.png", "dwarf_female.png", "dwarf_dark.png",
      "item_hatch_composite.png", "item_table_composite.png", "item_chair_composite.png",
      "animal_people_flat.png", "favicon.png",
    ];
    check("outputs are exactly the 8 client sprite files",
      Object.keys(recipe.outputs).sort().join(",") === [...EXPECT].sort().join(","));
    check("every source path is DF-root-relative under data/ (no drive letters, no ..)",
      recipe.sources.every((s) => s.startsWith("data/") && !s.includes(":") && !s.includes("..")) &&
      recipe.remaps.every((r) => r.palette.startsWith("data/") && !r.palette.includes(":")));
    let opsOk = true, why = "";
    const names = Object.keys(recipe.outputs);
    for (const [name, spec] of Object.entries(recipe.outputs)) {
      for (const op of spec.ops) {
        if (op[0] === "b") {
          const [, si, sx, sy, w, h, dx, dy, ri] = op;
          if (si < 0 || si >= recipe.sources.length) { opsOk = false; why = `${name}: bad src idx`; }
          if (ri !== -1 && (ri < 0 || ri >= recipe.remaps.length)) { opsOk = false; why = `${name}: bad remap idx`; }
          if (sx < 0 || sy < 0 || w <= 0 || h <= 0) { opsOk = false; why = `${name}: bad src rect`; }
          if (dx < 0 || dy < 0 || dx + w > spec.w || dy + h > spec.h) { opsOk = false; why = `${name}: blit not pre-clipped`; }
        } else if (op[0] === "o") {
          if (names.indexOf(op[1]) === -1 || names.indexOf(op[1]) >= names.indexOf(name)) {
            opsOk = false; why = `${name}: 'o' must reference an EARLIER output`;
          }
        } else if (op[0] !== "fill" && op[0] !== "clear") { opsOk = false; why = `${name}: unknown op ${op[0]}`; }
      }
    }
    check("all ops well-formed, in-bounds, and dependency-ordered", opsOk, why);
    check("recipe contains no absolute Windows path anywhere (redistribution hygiene)",
      !readFileSync(join(REPO, "host", "sprite_recipe.json"), "utf8").includes(":\\"));
  }
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failed ? "FAIL" : "PASS"} - ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
