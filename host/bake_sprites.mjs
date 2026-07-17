// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// host/bake_sprites.mjs -- W11 (sprite provenance): produce the web client's
// composite sprites (dwarf.png family, item_*_composite.png, animal_people_flat.png,
// favicon.png) ON THE HOST'S MACHINE, from the host's own Dwarf Fortress art.
//
// Those PNGs are composites of the paid DF graphics, so the repository may not
// ship their pixels. It ships host/sprite_recipe.json instead -- crop/blit/
// palette-remap COORDINATES emitted by tools/ws2/emit_sprite_recipe.py -- and
// this script replays the recipe at install time. Plain node, ZERO npm deps
// (PNG codec: host/pnglite.mjs, written for this repo on node:zlib).
//
//   node host/bake_sprites.mjs --df-root "<DF folder>" [--out <dir>] [--recipe <file>] [--json]
//
// Default --out is <df-root>/hack/dfcapture-web (the deployed web root).
// install.mjs calls bakeSprites() after copying the release; the setup wizard
// (W12) surfaces it as its "Sprites" step.
//
// Compositing math is bit-for-bit Pillow's alpha_composite (PRECISION_BITS=7),
// because the recipe was authored against Pillow output and the bar is
// pixel-identical results. Verified against the original baked PNGs 2026-07-14.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./pnglite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RECIPE = path.join(HERE, "sprite_recipe.json");

// --- Pillow-exact "src over dst" for one pixel (PRECISION_BITS = 7) ----------
// out/dst/src are Uint8Arrays; oi/di/si are byte offsets of the RGBA pixel.
function overPixel(dst, di, src, si) {
  const sa = src[si + 3];
  if (sa === 0) return;
  if (sa === 255) {
    dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
    return;
  }
  const da = dst[di + 3];
  const blend = da * (255 - sa);
  const outa255 = sa * 255 + blend;              // > 0 because sa > 0
  const coef1 = Math.floor(sa * 255 * 255 * 128 / outa255);
  const coef2 = 255 * 128 - coef1;
  const shiftfordiv255 = (v) => (((v >> 8) + v) >> 8);
  for (let c = 0; c < 3; c++) {
    const tmp = src[si + c] * coef1 + dst[di + c] * coef2;
    dst[di + c] = shiftfordiv255(tmp + (0x80 << 7)) >> 7;
  }
  dst[di + 3] = shiftfordiv255(outa255 + 0x80);
}

// Composite `src` (an {width,height,data} image) over `dst` at (dx,dy), clipped.
function compositeOver(dst, src, dx, dy) {
  const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
  const x1 = Math.min(dst.width, dx + src.width);
  const y1 = Math.min(dst.height, dy + src.height);
  for (let y = y0; y < y1; y++) {
    let di = (y * dst.width + x0) * 4;
    let si = ((y - dy) * src.width + (x0 - dx)) * 4;
    for (let x = x0; x < x1; x++, di += 4, si += 4) overPixel(dst.data, di, src.data, si);
  }
}

function crop(img, sx, sy, w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((sy + y) * img.width + sx) * 4;
    data.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

function scaleNearest(img, s) {
  const w = img.width * s, h = img.height * s;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srow = Math.floor(y / s) * img.width;
    for (let x = 0; x < w; x++) {
      const si = (srow + Math.floor(x / s)) * 4;
      data.set(img.data.subarray(si, si + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

// Palette remap exactly as tools/ws2/bake_dwarf.py remap(): every pixel with
// alpha > 0 whose RGB equals key-row[slot] becomes to-row[slot] (alpha kept).
// Later slots override earlier on duplicate key colors (dict-comprehension order).
function buildLut(palImg, fromRow, toRow) {
  const lut = new Map();
  for (let s = 0; s < palImg.width; s++) {
    const k = (fromRow * palImg.width + s) * 4;
    const v = (toRow * palImg.width + s) * 4;
    const key = (palImg.data[k] << 16) | (palImg.data[k + 1] << 8) | palImg.data[k + 2];
    lut.set(key, [palImg.data[v], palImg.data[v + 1], palImg.data[v + 2]]);
  }
  return lut;
}

function applyLut(img, lut) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const hit = lut.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (hit) { d[i] = hit[0]; d[i + 1] = hit[1]; d[i + 2] = hit[2]; }
  }
}

// --- the bake -----------------------------------------------------------------

export function bakeSprites({ dfRoot, outDir, recipePath, log = () => {} } = {}) {
  const problems = [];
  const written = [];
  recipePath = recipePath || DEFAULT_RECIPE;
  if (!dfRoot) return { ok: false, written, problems: ["no DF root given"] };
  outDir = outDir || path.join(dfRoot, "hack", "dfcapture-web");

  let recipe;
  try {
    recipe = JSON.parse(readFileSync(recipePath, "utf8"));
  } catch (e) {
    return { ok: false, written, problems: [`cannot read recipe ${recipePath}: ${e.message}`] };
  }
  if (recipe.version !== 1) {
    return { ok: false, written, problems: [`unsupported recipe version ${recipe.version}`] };
  }

  // Resolve + decode every referenced source up front so a host with missing
  // art (e.g. DF Classic, no premium graphics) gets ONE clear message.
  const sources = [];
  const missing = [];
  for (const rel of recipe.sources) {
    const abs = path.join(dfRoot, ...rel.split("/"));
    if (!existsSync(abs)) { missing.push(rel); sources.push(null); continue; }
    try {
      sources.push(decodePng(readFileSync(abs), rel));
    } catch (e) {
      problems.push(`cannot decode ${rel}: ${e.message}`);
      sources.push(null);
    }
  }
  if (missing.length) {
    problems.push(
      `DF art not found under ${dfRoot} (${missing.length} file(s), e.g. ${missing[0]}). ` +
      `The graphical (Steam/itch) edition of Dwarf Fortress is required for sprites.`);
  }
  if (problems.length) return { ok: false, written, problems };

  const palettes = recipe.remaps.map((r) => {
    const abs = path.join(dfRoot, ...r.palette.split("/"));
    if (!existsSync(abs)) return null;
    return { img: decodePng(readFileSync(abs), r.palette), from: r.from, to: r.to };
  });
  for (let i = 0; i < palettes.length; i++) {
    if (!palettes[i]) return { ok: false, written, problems: [`palette missing: ${recipe.remaps[i].palette}`] };
    palettes[i].lut = buildLut(palettes[i].img, palettes[i].from, palettes[i].to);
  }

  mkdirSync(outDir, { recursive: true });
  const baked = {}; // name -> image (favicon references dwarf.png)
  for (const [name, spec] of Object.entries(recipe.outputs)) {
    const img = { width: spec.w, height: spec.h, data: new Uint8Array(spec.w * spec.h * 4) };
    for (const op of spec.ops) {
      const kind = op[0];
      if (kind === "b") {
        const [, srcIdx, sx, sy, w, h, dx, dy, remapIdx] = op;
        const cell = crop(sources[srcIdx], sx, sy, w, h);
        if (remapIdx >= 0) applyLut(cell, palettes[remapIdx].lut);
        compositeOver(img, cell, dx, dy);
      } else if (kind === "fill") {
        const [, r, g, b, a] = op;
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
        }
      } else if (kind === "o") {
        const [, from, scale, dx, dy] = op;
        if (!baked[from]) return { ok: false, written, problems: [`${name}: needs ${from} baked first`] };
        compositeOver(img, scaleNearest(baked[from], scale), dx, dy);
      } else if (kind === "clear") {
        for (const [x, y] of op[1]) {
          const i = (y * img.width + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = img.data[i + 3] = 0;
        }
      } else {
        return { ok: false, written, problems: [`${name}: unknown op '${kind}'`] };
      }
    }
    baked[name] = img;
    const outFile = path.join(outDir, name);
    writeFileSync(outFile, encodePng(img));
    written.push(name);
    log(`  baked ${name} (${spec.w}x${spec.h})`);
  }
  return { ok: true, written, problems, outDir };
}

// Install-state probe for install.mjs --check: can this DF root bake, and are
// the baked outputs present in the deployed web dir? Touches nothing.
export function spriteBakeState({ dfRoot, outDir, recipePath } = {}) {
  recipePath = recipePath || DEFAULT_RECIPE;
  outDir = outDir || (dfRoot ? path.join(dfRoot, "hack", "dfcapture-web") : "");
  let recipe = null;
  try { recipe = JSON.parse(readFileSync(recipePath, "utf8")); } catch { /* reported below */ }
  if (!recipe || !dfRoot) {
    return { bakeable: false, recipeOk: !!recipe, missingSources: [], missingBaked: [], bakedPresent: [] };
  }
  const missingSources = recipe.sources.filter(
    (rel) => !existsSync(path.join(dfRoot, ...rel.split("/"))));
  const names = Object.keys(recipe.outputs);
  const missingBaked = names.filter((n) => !existsSync(path.join(outDir, n)));
  return {
    bakeable: missingSources.length === 0, recipeOk: true, missingSources,
    missingBaked, bakedPresent: names.filter((n) => !missingBaked.includes(n)),
  };
}

// --- CLI ------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const args = { dfRoot: "", out: "", recipe: "", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--df-root") args.dfRoot = argv[++i] ?? "";
    else if (a === "--out") args.out = argv[++i] ?? "";
    else if (a === "--recipe") args.recipe = argv[++i] ?? "";
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("node host/bake_sprites.mjs --df-root \"<DF folder>\" [--out <dir>] [--recipe <file>] [--json]");
      process.exit(0);
    } else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!args.dfRoot) { console.error("required: --df-root \"<DF folder>\""); process.exit(2); }
  const res = bakeSprites({
    dfRoot: args.dfRoot, outDir: args.out || undefined,
    recipePath: args.recipe || undefined, log: (s) => { if (!args.json) console.log(s); },
  });
  if (args.json) console.log(JSON.stringify(res, null, 2));
  else {
    if (res.ok) console.log(`Baked ${res.written.length} sprite file(s) into ${res.outDir}`);
    for (const p of res.problems) console.error("  ! " + p);
  }
  process.exit(res.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
