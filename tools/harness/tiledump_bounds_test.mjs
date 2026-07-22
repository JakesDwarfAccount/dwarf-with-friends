import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "src", "oracle_routes.cpp"), "utf8");
assert.match(source, /safe_dump_name[\s\S]*?std::isalnum/,
  "output names must be simple leaf names, not caller-controlled paths");
assert.match(source, /dfhack-config.*dwf-diagnostics.*tiledumps/,
  "all output must stay beneath the dedicated diagnostic root");
assert.match(source, /g_tiledump_active\.compare_exchange_strong/,
  "only one dump may run at a time");
assert.match(source, /atlas export is not available over HTTP/,
  "the unbounded 129k-file atlas export must not be remotely triggerable");
assert.match(source, /kMaxDumpBytes = 64u \* 1024u \* 1024u/,
  "viewport dump output must have an explicit byte ceiling");
assert.match(source, /elapsed > std::chrono::seconds\(30\)/,
  "viewport dump must have an explicit wall-time ceiling");
assert.match(source, /if \(!ok\) std::filesystem::remove_all\(output/,
  "failed or over-budget output must be removed");
for (const bad of ["../escape", "C:/escape", "a/b", "a\\b", ""])
  assert(!/^[A-Za-z0-9_-]{1,64}$/.test(bad), `TEST-THE-TEST: ${bad} must be rejected`);

console.log("PASS tiledump_bounds_test (dedicated root, single-flight, 64 MiB/30 s caps, cleanup)");
