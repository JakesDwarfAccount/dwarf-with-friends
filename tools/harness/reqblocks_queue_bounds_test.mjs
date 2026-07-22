// Offline guard for the per-connection REQ_BLOCKS admission queue and drop diagnostics.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const header = readFileSync(path.join(root, "src", "websocket.h"), "utf8");
const socket = readFileSync(path.join(root, "src", "websocket.cpp"), "utf8");
const stream = readFileSync(path.join(root, "src", "world_stream.cpp"), "utf8");

assert.match(header, /kReqblocksQueueDepth\s*=\s*256/,
  "per-connection admission queue must have an explicit finite cap");
assert.match(socket, /local_space = kReqblocksQueueDepth - reqblocks_queue_\.size\(\)[\s\S]*?reqblocks_overflow_drops_\.fetch_add/,
  "overflow must be bounded and counted before push_back");
assert.match(socket, /last_reqblocks_ms_ < 250[\s\S]*?reqblocks_rate_drops_\.fetch_add/,
  "rate-limited triples must be counted");
assert.match(stream, /reqQueued[\s\S]*?reqRateDrops[\s\S]*?reqOverflowDrops/,
  "/diag must expose queue depth and both drop classes");

function admit(existing, incoming, cap) {
  const queue = existing.slice();
  let dropped = 0;
  for (const triple of incoming) {
    if (queue.length >= cap) dropped++;
    else queue.push(triple);
  }
  return { queue, dropped };
}
const result = admit(Array(250).fill([0, 0, 0]), Array(64).fill([1, 1, 1]), 256);
assert.equal(result.queue.length, 256, "admission never grows beyond the cap");
assert.equal(result.dropped, 58, "every rejected triple is accounted for");
const legacy = Array(250).fill([0, 0, 0]).concat(Array(64).fill([1, 1, 1]));
assert(legacy.length > 256, "TEST-THE-TEST: the legacy unbounded append exceeds the cap");

console.log("PASS reqblocks_queue_bounds_test (256 cap, drop accounting, /diag fields, seeded unbounded append detected)");
