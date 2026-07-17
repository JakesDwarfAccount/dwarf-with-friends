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

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { dfRootOrDie } from "./lib/dfroot.mjs";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(REPO, "web");
// W1: resolved, never hardcoded (--df / --df-root / $DWF_DF_ROOT / autodetect).
const DEFAULT_DF_ROOT = dfRootOrDie("tools/texture-lab-server.mjs",
  "it serves the texture lab's sprite art live out of your own DF install");

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const host = argValue("--host", "127.0.0.1");
// dwf itself commonly owns 8765, so the standalone lab deliberately uses 8766.
const port = Number(argValue("--port", "8766"));
const dfRoot = resolve(argValue("--df", DEFAULT_DF_ROOT));
const noOpen = args.includes("--no-open");

const graphicsDirs = [
  join(dfRoot, "data/vanilla/vanilla_environment/graphics"),
  join(dfRoot, "data/vanilla/vanilla_plants_graphics/graphics"),
];

const imageDirs = [
  join(dfRoot, "data/vanilla/vanilla_environment/graphics/images"),
  join(dfRoot, "data/vanilla/vanilla_plants_graphics/graphics/images"),
  join(dfRoot, "data/vanilla/vanilla_creatures_graphics/graphics/images"),
  join(dfRoot, "data/vanilla/vanilla_creatures_extinct_graphics/graphics/images"),
  join(dfRoot, "data/vanilla/vanilla_descriptors_graphics/graphics/images"),
  join(dfRoot, "data/vanilla/vanilla_buildings_graphics/graphics/images"),
  join(dfRoot, "data/vanilla/vanilla_items_graphics/graphics/images"),
  join(dfRoot, "data/vanilla/vanilla_interface/graphics/images"),
  WEB_ROOT,
];

function txtFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".txt"))
    .sort()
    .map((name) => join(dir, name));
}

function bracketFields(text) {
  return [...text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1].split(":"));
}

function integer(value) {
  return /^-?\d+$/.test(value || "") ? Number(value) : null;
}

function buildSpriteMap() {
  const files = graphicsDirs.flatMap(txtFiles);
  const pages = new Map();
  for (const file of files) {
    let page = "";
    for (const fields of bracketFields(readFileSync(file, "utf8"))) {
      if (fields[0] === "TILE_PAGE" && fields[1]) page = fields[1];
      else if (fields[0] === "FILE" && fields[1] && page)
        pages.set(page, fields[1].replace(/\\/g, "/").split("/").pop());
    }
  }

  const tokens = new Map();
  for (const file of files) {
    for (const fields of bracketFields(readFileSync(file, "utf8"))) {
      if (fields.length < 5 || fields[0] !== "TILE_GRAPHICS") continue;
      const sheet = pages.get(fields[1]);
      const col = integer(fields[2]);
      const row = integer(fields[3]);
      const token = fields[4];
      if (!sheet || col == null || row == null || !token) continue;
      const extras = fields.slice(5).map(integer);
      const frameBinding = extras.length > 0 && extras.every((value) => value != null);
      const seriesKey = frameBinding ? extras.slice(0, -1).join(":") : null;
      const frameIndex = frameBinding ? extras.at(-1) : null;
      const existing = tokens.get(token);
      if (!existing) {
        tokens.set(token, {
          sheet, col, row,
          seriesKey,
          framePool: frameBinding ? [{ index: frameIndex, col, row }] : [],
        });
      } else if (frameBinding && existing.seriesKey != null && existing.seriesKey === seriesKey) {
        existing.framePool.push({ index: frameIndex, col, row });
      }
    }
  }

  const output = {};
  for (const token of [...tokens.keys()].sort()) {
    const entry = tokens.get(token);
    const value = { sheet: entry.sheet, col: entry.col, row: entry.row };
    if (entry.framePool.length > 1) {
      const seen = new Set();
      value.frames = entry.framePool
        .sort((a, b) => a.index - b.index)
        .filter((frame) => !seen.has(frame.index) && seen.add(frame.index))
        .map((frame) => ({ col: frame.col, row: frame.row }));
    }
    output[token] = value;
  }
  return output;
}

let spriteMap = null;
function spriteMapJson() {
  if (!spriteMap) spriteMap = buildSpriteMap();
  return JSON.stringify(spriteMap);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function safeStaticPath(pathname) {
  const rel = pathname === "/" ? "texture-lab.html" : pathname.replace(/^\/+/, "");
  const target = resolve(WEB_ROOT, rel);
  const inside = target === WEB_ROOT || target.startsWith(WEB_ROOT + sep);
  return inside ? target : null;
}

function serveSpriteImage(name, res) {
  if (!/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)?\.png$/.test(name)) {
    send(res, 404, "not found\n");
    return;
  }
  for (const dir of imageDirs) {
    const candidate = join(dir, ...name.split("/"));
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      send(res, 200, readFileSync(candidate), "image/png");
      return;
    }
  }
  send(res, 404, "not found\n");
}

const server = createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, `http://${host}:${port}`).pathname); }
  catch (_) { send(res, 400, "bad request\n"); return; }

  if (pathname === "/sprites/map.json") {
    const body = spriteMapJson();
    if (body === "{}") send(res, 503, "DF graphics raws not found\n");
    else send(res, 200, body, mime[".json"]);
    return;
  }
  if (pathname.startsWith("/sprites/img/")) {
    serveSpriteImage(pathname.slice("/sprites/img/".length), res);
    return;
  }

  const target = safeStaticPath(pathname);
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    send(res, 404, "not found\n");
    return;
  }
  send(res, 200, readFileSync(target), mime[extname(target).toLowerCase()] || "application/octet-stream");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Texture Lab could not start: port ${port} is already in use.`);
    console.error(`If the lab is already open, use http://${host}:${port}/texture-lab.html`);
  } else console.error(error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}/texture-lab.html`;
  const count = Object.keys(JSON.parse(spriteMapJson())).length;
  console.log(`Texture Lab: ${url}`);
  console.log(`Project catalogs: ${relative(REPO, WEB_ROOT)} | Installed DF sprite tokens: ${count}`);
  console.log("Close this window or press Ctrl+C to stop the local server.");
  if (!noOpen) {
    const opener = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
    });
    opener.unref();
  }
});
