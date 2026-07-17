// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// B127: a claimed priority Dig job on a revealed wall keeps B38 lighten and priority numeral.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const box = { self: null, performance: { now: () => 0 } }; box.self = box; vm.createContext(box);
vm.runInContext(fs.readFileSync("web/js/dwf-gl.js", "utf8"), box);
const GL = box.DwfGL;
const ids = new Map(); let next = 1;
const atlas = { resolve(sheet, col, row) { const key = `${sheet}|${col}|${row}`; if (!ids.has(key)) ids.set(key, next++); return ids.get(key); } };
const builder = GL.createSceneBuilder({ atlas, spriteMap: {}, tokenMap: {}, shadowCellMap: {} });
const wall = { tt: 1, ttname: "StoneWall", shape: "WALL", mat: "STONE", hidden: false,
  flow: 0, liquid: "none", outside: 0, desigPriority: { priority: 5 } };
builder.buildScene({ origin: { x: 10, y: 20, z: 30 }, width: 1, height: 1, tiles: [wall],
  djobs: [{ x: 10, y: 20, z: 30, k: 7 }], designationNowMs: 0 });
const f32 = new Float32Array(builder.buffer), u16 = new Uint16Array(builder.buffer), u8 = new Uint8Array(builder.buffer);
const rows = Array.from({ length: builder.count }, (_, i) => ({ x: f32[i*4], y: f32[i*4+1],
  cell: u16[i*8+4], attr: u16[i*8+5], a: u8[i*16+15] }));
const at = cell => rows.some(r => r.cell === cell);
assert.ok(rows.some(r => r.cell === GL.SOLID_CELL && (r.attr & GL.ATTR_ADDITIVE) && r.a === 0),
  "claimed revealed wall receives the B38 additive lighten despite cleared dig bits");
assert.ok(at(atlas.resolve("designations.png", 0, 1)), "claimed Dig job emits the mining glyph");
assert.ok(at(atlas.resolve("designation_priority.png", 0, 4)), "surviving priority 5 tail emits its numeral");
const gl = fs.readFileSync("web/js/dwf-gl.js", "utf8");
assert.doesNotMatch(gl, /djv\.cell[\s\S]{0,120}prio: 0/, "test-the-test rejects pre-fix claimed-job priority loss");
console.log("PASS B127 claimed priority wall emits additive lighten, dig glyph, and priority numeral");
