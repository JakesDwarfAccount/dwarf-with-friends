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
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// SPDX-License-Identifier: AGPL-3.0-only

// tools/stub-server.mjs -- dependency-free dwf protocol and browser-fixture server.
//
// The original WS5 load stub remains the default CLI behavior. Browser gates import
// createStubServer() in-process (the managed test sandbox blocks child Node processes), point it at
// a web root, and opt into deterministic screen fixtures. This is still a stub DATA source: the
// browser receives and executes the real web client files unchanged.
//
// CLI: node tools/stub-server.mjs [--port 8770] [--frame-ms 100] [--frame-bytes 15000]
//                                  [--password pw] [--web-root path] [--screen-truth]

import http from "node:http";
import { deflateSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/mdutil.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const DIRECT_RUN = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(MODULE_PATH);
const REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
};

const SPRITE_DIRS = [
  "data/vanilla/vanilla_environment/graphics/images",
  "data/vanilla/vanilla_plants_graphics/graphics/images",
  "data/vanilla/vanilla_creatures_graphics/graphics/images",
  "data/vanilla/vanilla_creatures_extinct_graphics/graphics/images",
  "data/vanilla/vanilla_descriptors_graphics/graphics/images",
  "data/vanilla/vanilla_buildings_graphics/graphics/images",
  "data/vanilla/vanilla_items_graphics/graphics/images",
  "data/vanilla/vanilla_interface/graphics/images",
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

function rgbaPng(width, height, paint) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const rgba = paint(x, y) || [0, 0, 0, 0];
      const offset = y * stride + 1 + x * 4;
      raw[offset] = rgba[0]; raw[offset + 1] = rgba[1]; raw[offset + 2] = rgba[2]; raw[offset + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const TRANSPARENT_PNG = rgbaPng(32, 32, () => [0, 0, 0, 0]);
const DIAGNOSTIC_FONT_PNG = rgbaPng(640, 300, (x, y) =>
  ((x >> 3) + (y >> 3)) % 2 ? [245, 245, 245, 255] : [15, 15, 15, 255]);

// CI has no redistributable DF art. This sheet is deliberately diagnostic, not a fake claim of
// native parity: every row is visibly distinct, and row 8 contains a literal pixel Z. It proves
// that status identity survived transport/interpolation and was actually painted. When a DF install
// is supplied, /sprites/img/unit_status.png serves DF's own sheet instead and the same gate becomes
// an exact native-art screen comparison.
const DIAGNOSTIC_STATUS_PNG = rgbaPng(32, 32 * 41, (x, y) => {
  const row = Math.floor(y / 32), cy = y % 32;
  const hue = [(53 + row * 37) % 210 + 30, (91 + row * 53) % 210 + 30, (127 + row * 29) % 210 + 30];
  const inBubble = x >= 2 && x <= 29 && cy >= 2 && cy <= 24;
  const inTail = cy >= 25 && cy <= 29 && x >= 8 && x <= 13 - (cy - 25);
  if (!inBubble && !inTail) return [0, 0, 0, 0];
  const border = x <= 3 || x >= 28 || cy <= 3 || cy >= 23;
  if (border) return [hue[0], hue[1], hue[2], 255];
  if (row === 8) {
    const z1 = (cy === 8 || cy === 16) && x >= 8 && x <= 19;
    const z2 = x === 19 - (cy - 8) && cy >= 8 && cy <= 16;
    const little = ((cy === 12 || cy === 17) && x >= 21 && x <= 26) ||
      (x === 26 - (cy - 12) && cy >= 12 && cy <= 17);
    if (z1 || z2 || little) return [12, 12, 18, 255];
  }
  // Encode the row number as bars so the wrong status row can never be pixel-identical.
  if ((row & 1) && x >= 6 && x <= 8 && cy >= 7 && cy <= 19) return [20, 20, 20, 255];
  if ((row & 2) && x >= 11 && x <= 13 && cy >= 7 && cy <= 19) return [20, 20, 20, 255];
  if ((row & 4) && x >= 16 && x <= 18 && cy >= 7 && cy <= 19) return [20, 20, 20, 255];
  if ((row & 8) && x >= 21 && x <= 23 && cy >= 7 && cy <= 19) return [20, 20, 20, 255];
  return [246, 246, 240, 255];
});

function safeFile(root, relative) {
  if (!root || !relative || relative.includes("\0")) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, relative.replace(/^[/\\]+/, ""));
  return file === base || file.startsWith(base + path.sep) ? file : null;
}

function nativeSprite(dfRoot, name) {
  if (!dfRoot || !/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)?\.png$/.test(name)) return null;
  for (const relative of SPRITE_DIRS) {
    const file = safeFile(path.join(dfRoot, relative), name);
    if (file && existsSync(file)) return file;
  }
  return null;
}

function screenMap(search, wallHalo = false) {
  const width = Math.max(42, Math.min(80, Number(search.get("w")) || 64));
  const height = Math.max(24, Math.min(60, Number(search.get("h")) || 40));
  const tiles = new Array(width * height).fill(null);
  if (wallHalo) {
    const put = (x, y, tile) => {
      if (x >= 0 && y >= 0 && x < width && y < height) {
        tiles[y * width + x] = { x, y, z: 100, ...tile };
      }
    };
    // B282: a 2x2 revealed siltstone wall cluster in an otherwise-unshipped (tt<0) rock
    // ring, with a mined floor along its south edge. WT25's tt<0 records deliberately carry
    // no `hidden` bit. They paint the hidden-rock hatch, and must also count as SOLID for wall
    // adjacency; the old bare !hidden predicate falsely selected N/W/E material faces here.
    for (let y = 17; y <= 20; y++) for (let x = 29; x <= 32; x++) {
      put(x, y, { tt: -1 });
    }
    for (let y = 18; y <= 19; y++) for (let x = 30; x <= 31; x++) {
      put(x, y, { tt: 1, ttname: "StoneWall", shape: "WALL", mat: "STONE", base_mt: 0, base_mi: 162 });
    }
    for (let x = 30; x <= 31; x++) {
      put(x, 20, { tt: 2, ttname: "StoneFloor1", shape: "FLOOR", mat: "STONE", base_mt: 0, base_mi: 162 });
    }
  }
  return {
    wire: 6,
    origin: { x: 0, y: 0, z: 100 }, width, height,
    tiles,
    // Sleeping+grounded discriminates B248. NO_JOB lives only in st2 and discriminates B277.
    units: [
      { id: 101, x: 10, y: 12, z: 100, rt: "", ct: "MALE", st: 0x00008001, st2: 0 },
      { id: 102, x: 24, y: 12, z: 100, rt: "", ct: "FEMALE", st: 0, st2: 0x00000002 },
      { id: 103, x: 38, y: 12, z: 100, rt: "", ct: "MALE", st: 0, st2: 0 },
    ],
    buildings: [], players: [], djobs: [], proj: [], env: { paused: true },
  };
}

function masonWorkshopFixture(defects) {
  // Independent screen transcript: evidence/oracles/workshops/WS-MASONS-native-1of2.png visibly
  // starts with this exact submenu row. The browser cell checks that it is served AND laid out;
  // it does not grep this fixture or the product renderer.
  const tasks = [
    { key: "memorial", name: "Engrave memorial slab (opens menu)", avail: true },
    { key: "blocks", name: "Make rock blocks", avail: true },
    { key: "table", name: "Make rock table", avail: true },
  ];
  if (defects.has("shop-menu-missing")) tasks.shift();
  return {
    ok: true, id: 16, name: "DWF 16: Mason's", type: "Workshop", subtype: 2,
    canAddTasks: true, jobs: [], tasks, orders: [], workers: [], items: [], linkedStockpiles: [],
    profile: { permittedCount: 0 },
  };
}

export function createStubServer(options = {}) {
  const port = Number(options.port ?? 0);
  const frameMs = Number(options.frameMs ?? options["frame-ms"] ?? 100);
  const frameBytes = Number(options.frameBytes ?? options["frame-bytes"] ?? 15000);
  const password = String(options.password || "");
  const webRoot = options.webRoot ? path.resolve(options.webRoot) : null;
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const dfRoot = options.dfRoot ? path.resolve(options.dfRoot) : null;
  const screenTruth = options.screenTruth === true;
  const spriteMapOverride = options.spriteMapOverride || null;
  const wallHalo = options.wallHalo === true;
  const defects = new Set(options.fixtureDefects || []);
  const overrides = new Map(Object.entries(options.fileOverrides || {}));
  const startMs = Date.now();
  let paused = false;
  const players = new Map();
  const state = { designations: 0, lastDesignationTool: "", removedConstruction: false };

  const frame = Buffer.alloc(frameBytes, 0x55);
  frame[0] = 0xff; frame[1] = 0xd8;
  frame[frame.length - 2] = 0xff; frame[frame.length - 1] = 0xd9;

  function player(name) {
    if (!players.has(name)) players.set(name, {
      camera: { x: 60, y: 60, z: 100 }, seq: 1,
      framesServed: 0, bytesSent: 0, inputs: 0, renders: 0,
    });
    return players.get(name);
  }

  const worldTimer = setInterval(() => {
    if (!paused) for (const record of players.values()) record.seq++;
  }, frameMs);
  worldTimer.unref?.();

  function send(res, status, body, contentType, method = "GET") {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": raw.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    if (method !== "HEAD") res.end(raw); else res.end();
  }
  const json = (res, status, value, method) =>
    send(res, status, JSON.stringify(value) + "\n", "application/json; charset=utf-8", method);

  function authed(req) {
    if (!password) return true;
    return (req.headers.cookie || "").includes("dwf_auth=stubsession") ||
      (req.headers.cookie || "").includes(`dfcap_auth=${password}`);
  }

  function servePath(req, res, pathname) {
    const override = overrides.get(pathname);
    if (override && existsSync(override)) {
      send(res, 200, readFileSync(override), MIME[path.extname(override).toLowerCase()] || "application/octet-stream", req.method);
      return true;
    }
    let file = null;
    if (pathname === "/" || pathname === "/index.html") file = safeFile(webRoot, "index.html");
    else if (pathname.startsWith("/web/") || pathname.startsWith("/tools/") ||
      pathname.startsWith("/evidence/") || pathname.startsWith("/Menu Oracle Screenshots/"))
      file = safeFile(repoRoot, decodeURIComponent(pathname));
    else file = safeFile(webRoot, decodeURIComponent(pathname));
    if (!file || !existsSync(file)) return false;
    send(res, 200, readFileSync(file), MIME[path.extname(file).toLowerCase()] || "application/octet-stream", req.method);
    return true;
  }

  function serveArt(req, res, pathname) {
    if (pathname === "/dfart/curses_640x300.png") {
      const native = dfRoot ? path.join(dfRoot, "data", "art", "curses_640x300.png") : null;
      send(res, 200, native && existsSync(native) ? readFileSync(native) : DIAGNOSTIC_FONT_PNG, "image/png", req.method);
      return true;
    }
    if (pathname.startsWith("/asset/")) {
      const name = pathname.slice("/asset/".length);
      const native = nativeSprite(dfRoot, name);
      send(res, 200, native ? readFileSync(native) : TRANSPARENT_PNG, "image/png", req.method);
      return true;
    }
    if (pathname.startsWith("/sprites/img/")) {
      const name = pathname.slice("/sprites/img/".length);
      const native = nativeSprite(dfRoot, name);
      const fallback = name === "unit_status.png" ? DIAGNOSTIC_STATUS_PNG : TRANSPARENT_PNG;
      send(res, 200, native ? readFileSync(native) : fallback, "image/png", req.method);
      return true;
    }
    if (pathname === "/sprites/map.json") {
      if (spriteMapOverride) {
        json(res, 200, spriteMapOverride, req.method);
        return true;
      }
      const installed = dfRoot ? path.join(dfRoot, "hack", "dfcapture-web", "sprites", "map.json") : null;
      if (installed && existsSync(installed)) send(res, 200, readFileSync(installed), MIME[".json"], req.method);
      else json(res, 200, {}, req.method);
      return true;
    }
    return false;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;
    const name = url.searchParams.get("player") || "anon";

    if (pathname === "/auth") {
      if (url.searchParams.get("token") === password && password) {
        res.writeHead(200, {
          "Set-Cookie": "dwf_auth=stubsession; HttpOnly; SameSite=Lax; Path=/",
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end('{"ok":true}\n');
      } else json(res, 403, { ok: false });
      return;
    }
    if (!authed(req)) { json(res, 401, { ok: false, auth: true }); return; }

    if (serveArt(req, res, pathname)) return;
    if (servePath(req, res, pathname)) return;

    if (pathname === "/version") {
      json(res, 200, { ok: true, build: "__DFCAPTURE_BUILD__", assets: "screen-truth", authRequired: false, worldLoaded: true });
      return;
    }
    if (pathname === "/join") { json(res, 200, { ok: true }); return; }
    if (pathname === "/mapdata" && screenTruth) { json(res, 200, screenMap(url.searchParams, wallHalo)); return; }
    if (pathname === "/hud") {
      json(res, 200, { ok: true, fortName: "Screen Truth", siteName: "Fixture", population: 3, paused: true }); return;
    }
    if (pathname === "/notifications") { json(res, 200, { ok: true, alerts: [], recent: [] }); return; }
    if (pathname === "/reports") { json(res, 200, { ok: true, reports: [] }); return; }
    if (pathname === "/attrib") { json(res, 200, { ok: true, buildings: {} }); return; }
    if (pathname === "/zones") { json(res, 200, { ok: true, zones: [] }); return; }
    if (pathname === "/console/commands") {
      json(res, 200, { ok: true, commands: [{ name: "ls", short: "List commands" }], denyRules: [] }); return;
    }
    if (pathname === "/workshop-info" && screenTruth) { json(res, 200, masonWorkshopFixture(defects)); return; }
    if (pathname === "/__screen_truth/state") { json(res, 200, { ...state }); return; }

    if (pathname === "/stream") {
      const record = player(name);
      res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=dwf",
        "Cache-Control": "no-store", Connection: "close",
      });
      let lastSeq = 0, lastSent = Date.now();
      const timer = setInterval(() => {
        const now = Date.now();
        if (record.seq !== lastSeq) {
          const camera = record.camera;
          const header = `--dwf\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n` +
            `X-Dwf-Camera: ${camera.x},${camera.y},${camera.z}\r\nX-Dwf-Seq: ${record.seq}\r\n\r\n`;
          res.write(header); res.write(frame); res.write("\r\n");
          record.framesServed++; record.bytesSent += header.length + frame.length + 2; record.renders++;
          lastSeq = record.seq; lastSent = now;
        } else if (now - lastSent > 15000) {
          res.write("--dwf\r\nContent-Type: text/plain\r\nX-Dwf-Heartbeat: 1\r\nContent-Length: 2\r\n\r\nok\r\n");
          lastSent = now;
        }
      }, 25);
      req.on("close", () => clearInterval(timer));
      return;
    }

    if (pathname === "/camera") {
      const record = player(name), query = url.searchParams;
      if (req.method === "POST" || [...query.keys()].some(key => "xyz".includes(key) || key.startsWith("d"))) {
        if (query.has("x") || query.has("y") || query.has("z")) {
          record.camera.x = Number(query.get("x") ?? record.camera.x);
          record.camera.y = Number(query.get("y") ?? record.camera.y);
          record.camera.z = Number(query.get("z") ?? record.camera.z);
        } else {
          record.camera.x += Number(query.get("dx") || 0);
          record.camera.y += Number(query.get("dy") || 0);
          record.camera.z += Number(query.get("dz") || 0);
        }
        record.inputs++; record.seq++;
      }
      json(res, 200, { player: name, ...record.camera, zoom: 100, zoomExplicit: false });
      return;
    }

    if (pathname === "/designate") {
      const record = player(name);
      const tool = url.searchParams.get("tool") || "dig";
      state.lastDesignationTool = tool;
      // Compatibility oracle: the oldest deployed server knows remove-construction only. Unknown
      // actions deliberately answer 200/count=0, reproducing the silent no-op that made B268 live.
      const recognized = tool !== "remove-stairs-ramps";
      if (recognized) {
        state.designations++; state.removedConstruction ||= tool === "remove-construction";
        record.inputs++; record.seq++;
      }
      json(res, 200, { ok: true, count: recognized ? 1 : 0, tool });
      return;
    }

    if (pathname === "/stats") {
      const out = { players: {}, uptimeSec: Math.floor((Date.now() - startMs) / 1000) };
      for (const [playerName, record] of players) out.players[playerName] = {
        framesServed: record.framesServed, cacheHitPct: 0, renders: record.renders,
        avgRenderMs: 1, avgEncodeMs: 1, bytesSent: record.bytesSent, inputs: record.inputs,
      };
      json(res, 200, out); return;
    }

    if (pathname === "/stub/pause") {
      paused = url.searchParams.get("on") === "1";
      json(res, 200, { ok: true, paused }); return;
    }

    json(res, 404, { ok: false, error: "no such stub route" });
  });
  server.on("upgrade", (_request, socket) => socket.destroy());

  return {
    server, state, diagnosticArt: !dfRoot,
    async start() {
      if (server.listening) return this;
      await new Promise((resolveStart, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolveStart);
      });
      const address = server.address();
      this.port = address.port;
      this.url = `http://127.0.0.1:${address.port}`;
      return this;
    },
    async stop() {
      clearInterval(worldTimer);
      if (!server.listening) return;
      await new Promise(resolveStop => server.close(() => resolveStop()));
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    port: "8770", "frame-ms": "100", "frame-bytes": "15000", password: "",
    "web-root": "", "screen-truth": false,
  });
  const fixture = createStubServer({
    port: Number(args.port), frameMs: Number(args["frame-ms"]), frameBytes: Number(args["frame-bytes"]),
    password: args.password, webRoot: args["web-root"] || null, screenTruth: !!args["screen-truth"],
  });
  await fixture.start();
  console.log(`stub-server listening on ${fixture.url} (frame every ${args["frame-ms"]}ms, ${args["frame-bytes"]}B)`);
}

if (DIRECT_RUN) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
