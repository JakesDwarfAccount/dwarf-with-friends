// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// SPDX-License-Identifier: AGPL-3.0-only

// Executable client-shape gate for native-style zone repaint. This runs the shipped final-shape
// serializer, not a test copy, and proves interior holes, add-back, mixed edits, and disjoint tiles
// survive Accept without bounding-box gap fill.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(root, "web/js/dwf-controls-placement.js"), "utf8");
const core = fs.readFileSync(path.join(root, "web/js/dwf-core.js"), "utf8");

function declaration(name, text = source) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  assert.fail(`unterminated ${name}`);
}

const { zoneRepaintFinalShape } = new Function(
  `${declaration("zoneExtentAt", core)}\n${declaration("zoneRepaintFinalShape")}\n` +
  "return { zoneRepaintFinalShape };")();

const zone = { id: 7, x: 10, y: 20, z: 100, w: 3, h: 3, extents: "111111111" };
const shape = changes => zoneRepaintFinalShape({ zone, changes: new Map(changes) });

assert.deepEqual(shape([["11,21", false]]), {
  x1: 10, y1: 20, x2: 12, y2: 22, z: 100, extents: "111101111"
}, "erasing the center of a solid 3x3 produces a real interior hole");

assert.deepEqual(shape([["11,21", false], ["11,21", true]]), {
  x1: 10, y1: 20, x2: 12, y2: 22, z: 100, extents: "111111111"
}, "adding a previously erased tile restores membership exactly");

assert.deepEqual(shape([["11,21", false], ["14,21", true], ["10,20", false]]), {
  x1: 10, y1: 20, x2: 14, y2: 22, z: 100,
  extents: "011001010111100"
}, "mixed erase/add keeps holes and the gap before a disconnected added tile");

const emptyChanges = [];
for (let y = 20; y <= 22; y++) for (let x = 10; x <= 12; x++) emptyChanges.push([`${x},${y}`, false]);
assert.deepEqual(shape(emptyChanges), { empty: true },
  "clearing every tile is detected before the request and must use explicit Remove Zone");

console.log("PASS zone repaint exact shape: interior hole, add-back, mixed/disconnected edits, full-erase guard");
