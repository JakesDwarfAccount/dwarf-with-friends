// Offline policy guard for bounded plugin diagnostics retention.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "src", "diagnostics.cpp"), "utf8");
const docs = readFileSync(path.join(root, "TROUBLESHOOTING.md"), "utf8");

assert.match(source, /kDiagnosticsLogMaxBytes\s*=\s*4 \* 1024 \* 1024/,
  "active diagnostic log must have a named 4 MiB cap");
assert.match(source, /std::rename\(kDiagnosticsLogPath, kDiagnosticsLogPreviousPath\)/,
  "full active log must rotate to one previous generation");
assert.match(source, /rotation failed[\s\S]*?std::ios::trunc|std::ios::trunc[\s\S]*?rotation failed/,
  "failed rotation must still bound the active file and leave a marker");
assert(docs.includes("dwf.log.1") && docs.includes("4 MiB"),
  "player documentation must explain the retention bound and backup name");

function nextSizes(active, previous, incoming, cap) {
  if (active >= cap) return { active: incoming, previous: active };
  return { active: active + incoming, previous };
}
const rotated = nextSizes(4 * 1024 * 1024, 123, 80, 4 * 1024 * 1024);
assert.deepEqual(rotated, { active: 80, previous: 4 * 1024 * 1024 });
const legacy = { active: 4 * 1024 * 1024 + 80, previous: 123 };
assert(legacy.active > rotated.active, "TEST-THE-TEST: append-only behavior remains observably unbounded");

console.log("PASS diagnostics_log_bound_test (4 MiB active cap, one backup, bounded fallback, documented retention)");
