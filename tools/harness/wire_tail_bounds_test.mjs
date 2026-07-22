// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Offline contract test for the protocol-v1 u8 tail-body length. The independent model proves why
// oversized bodies must be dropped, while source guards ensure the C++ assembler uses that policy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "src", "wire_v1.cpp"), "utf8");

assert.match(source, /if \(t\.data\.size\(\) > 255\) continue;/,
  "assembler must skip oversized tail bodies");
assert.match(source, /uint16_t tail_count = 0;[\s\S]*?if \(t\.data\.size\(\) > 255\)[\s\S]*?\+\+tail_count;/,
  "tail_count must count only bodies that can be encoded");
assert.match(source, /wire-v1: dropped[\s\S]*?oversized tail/,
  "an impossible tail must leave one assembly-level diagnostic");
assert.doesNotMatch(source,
  /push_back\(\(uint8_t\)\(t\.data\.size\(\) > 255 \? 255 : t\.data\.size\(\)\)\)[\s\S]*?t\.data\.begin\(\), t\.data\.end\(\)/,
  "the old clamped-prefix/full-payload defect must not return");

function encodeSafe(tails) {
  const valid = tails.filter((tail) => tail.data.length <= 255);
  const out = [valid.length & 0xff, valid.length >>> 8];
  for (const tail of valid) out.push(tail.tile, tail.kind, tail.data.length, ...tail.data);
  return Uint8Array.from(out);
}

function decode(bytes) {
  let offset = 0;
  const count = bytes[offset++] | (bytes[offset++] << 8);
  const tails = [];
  for (let i = 0; i < count; i++) {
    const tile = bytes[offset++];
    const kind = bytes[offset++];
    const length = bytes[offset++];
    const data = bytes.slice(offset, offset + length);
    offset += length;
    tails.push({ tile, kind, data: [...data] });
  }
  return { tails, offset };
}

const tails = [
  { tile: 1, kind: 6, data: [11, 12] },
  { tile: 2, kind: 99, data: Array(256).fill(0xaa) },
  { tile: 3, kind: 4, data: [21, 22, 23] },
];
const safe = encodeSafe(tails);
const decoded = decode(safe);
assert.deepEqual(decoded.tails.map(({ tile, kind }) => ({ tile, kind })),
  [{ tile: 1, kind: 6 }, { tile: 3, kind: 4 }],
  "dropping the impossible middle tail keeps the following tail synchronized");
assert.equal(decoded.offset, safe.length, "decoder consumes the complete safe encoding");

function encodeLegacy(input) {
  const out = [input.length & 0xff, input.length >>> 8];
  for (const tail of input) out.push(tail.tile, tail.kind, Math.min(255, tail.data.length), ...tail.data);
  return Uint8Array.from(out);
}
const broken = decode(encodeLegacy(tails));
assert.notDeepEqual(broken.tails.map(({ tile, kind }) => ({ tile, kind })),
  [{ tile: 1, kind: 6 }, { tile: 2, kind: 99 }, { tile: 3, kind: 4 }],
  "TEST-THE-TEST: the legacy clamped prefix desynchronizes the following tail");

console.log("PASS wire_tail_bounds_test (oversized body dropped; following tail stays synchronized; seeded legacy encoder fails)");
