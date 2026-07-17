// dwf -- multiplayer Dwarf Fortress in the browser
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
class FakeImage {
  constructor() { this.onload = null; this.onerror = null; this.width = 32; this.height = 32; }
  set src(_) { if (this.onload) this.onload(); }
}
function fakeCanvas() {
  return { width: 32, height: 32, style: {}, addEventListener() {}, removeEventListener() {},
    getContext() { return new Proxy({}, { get: (_, key) => key === "measureText" ? (() => ({ width: 8 })) : (() => {}), set: () => true }); } };
}
export function loadTiles() {
  const box = { console, URLSearchParams, setTimeout, clearTimeout, Image: FakeImage, performance: { now: () => 0 } };
  box.window = box; box.self = box; box.location = { search: "", protocol: "http:", host: "localhost" };
  box.document = { hidden: false, addEventListener() {}, getElementById() { return null; }, createElement: fakeCanvas, body: { appendChild() {} } };
  box.addEventListener = () => {}; box.requestAnimationFrame = () => 0; box.cancelAnimationFrame = () => {}; box.sessionStorage = { getItem() { return null; }, setItem() {} }; box.fetch = async () => ({ ok: false, json: async () => null });
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-tiles.js"), "utf8"), box, { filename: "dwf-tiles.js" });
  return box.DwfTiles.init({ canvas: fakeCanvas(), managePoll: false, manageCamera: false });
}
export function loadGL() {
  const box = { console, performance: { now: () => 0 } }; box.self = box;
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-gl.js"), "utf8"), box, { filename: "dwf-gl.js" });
  return box.DwfGL;
}
export function makeAtlas() {
  const ids = new Map(); let next = 1;
  return { resolve(sheet, col, row) { const k = sheet + "|" + col + "|" + row; if (!ids.has(k)) ids.set(k, next++); return ids.get(k); }, resolvePalette(sheet, col, row) { return this.resolve(sheet, col, row); }, setSheetGeometry() {} };
}
