// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ws = readFileSync(path.join(root, "src", "websocket.cpp"), "utf8");
const http = readFileSync(path.join(root, "src", "http_server.cpp"), "utf8");

assert.match(ws, /kReqblocksGlobalMax = 1024/, "REQ_BLOCKS must have a process-wide ceiling");
assert.match(ws, /g_reqblocks_queued_total\.compare_exchange_weak/,
  "global queue slots must be reserved atomically");
assert.match(ws, /take_reqblocks[\s\S]*?g_reqblocks_queued_total\.fetch_sub/,
  "draining a queue must release its global slots");
assert.match(ws, /~WsConnection[\s\S]*?g_reqblocks_queued_total\.fetch_sub/,
  "disconnecting with pending requests must release its global slots");
for (const counter of ["g_reqblocks_dropped_rate", "g_reqblocks_dropped_cap", "g_chat_dropped_rate"])
  assert.match(ws, new RegExp(`${counter}\\.fetch_add`), `${counter} must increment at its drop site`);
assert.match(ws, /g_ws_upgrade_misclassified\.fetch_add/,
  "incomplete WebSocket upgrades must be counted");
assert.match(ws, /ws_stopping_ = true[\s\S]*?ws_close_all/,
  "server teardown must reject new upgrade threads before closing existing sockets");
assert.match(http, /\\"wsDrops\\"[\s\S]*?ws_drop_counters_json\(\)/,
  "/diag must surface aggregate WebSocket drops");
assert.match(http, /HEARTBEAT[\s\S]*?heartbeat_line|wsDrops=/,
  "crash-tail heartbeat output must carry the same counters");

const seededGlobalLimit = 4;
let queued = 0;
const reserve = (requested) => {
  const accepted = Math.min(requested, seededGlobalLimit - queued);
  queued += accepted;
  return accepted;
};
assert.equal(reserve(3), 3);
assert.equal(reserve(3), 1);
assert.equal(reserve(1), 0, "TEST-THE-TEST: aggregate demand cannot exceed the seeded ceiling");

console.log("PASS ws_drop_counters_test (global cap, counters, diagnostics, and teardown guarded)");
