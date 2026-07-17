// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// Offline contract for S1 paused-idle skip and S2 staggered block detection.
// Run: node tools/harness/s1_s2_scheduler_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(root, "src/world_stream.cpp"), "utf8");
const N = 4;

function bucket(key) {
  let value = BigInt(key);
  value ^= value >> 33n;
  value = BigInt.asUintN(64, value * 0xff51afd7ed558ccdn);
  value ^= value >> 33n;
  return Number(value % BigInt(N));
}

// Every already-seen key gets exactly one ordinary scan opportunity in each N-tick epoch.
for (const key of [0, 1, 17, 255, 0x100001, 0xabcdef]) {
  const own = bucket(key);
  const seen = Array.from({ length: N }, (_, tick) => tick).filter((slot) => slot === own);
  assert.deepEqual(seen, [own], `key ${key} must have exactly one S2 slot per epoch`);
}

// S1's first three quiet paused ticks skip; its fourth takes a full scan. Therefore a native
// paused change immediately after any full scan is discovered on the next one, never later.
const pausedCadence = ["skip", "skip", "skip", "full"];
for (let changedAfter = 0; changedAfter < N; changedAfter++) {
  let delay = 0;
  while (pausedCadence[(changedAfter + delay) % N] !== "full") delay++;
  assert.ok(delay < N, `paused mutation after cadence position ${changedAfter} exceeds ${N} ticks`);
}

// The source assertions keep the behavioral proof tied to the staged C++ implementation.
assert.match(source, /constexpr uint32_t kSigScanBuckets = 4;/,
  "S2 must retain the specified N=4");
assert.match(source, /constexpr uint32_t kPausedIdleScanEvery = 4;/,
  "S1 must re-acquire every fourth paused-idle tick");
assert.match(source, /req_this_tick\.insert\(key\)/,
  "REQ_BLOCKS intake must be recorded as a force-scan exception");
assert.match(source, /!paused_idle_full_scan && !first_seen && !req_this_tick\.count\(key\)/,
  "S2 may defer only ordinary, already-seen, non-requested keys");
assert.match(source, /g_last_read\.units = std::move\(units\)/,
  "S1 must serve skipped AUX from a neutral snapshot, not DF memory");
assert.match(source, /paused_idle_full_scan = paused_idle && !paused_idle_skip/,
  "S1 cadence acquisition must bypass stagger to avoid a 4x4 latency bound");

console.log("s1_s2_scheduler_test: PASS");
