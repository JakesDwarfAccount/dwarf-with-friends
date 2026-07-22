import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "src", "burrows_panel.cpp"), "utf8");
const response = readFileSync(path.join(root, "src", "api_response.h"), "utf8");

assert.match(source, /#include "api_response\.h"/,
  "burrow routes must use the shared ApiResult response adapter");
assert.match(response, /#include "api_result\.h"[\s\S]*?void send_api_error/,
  "the response adapter must serialize the shared explicit domain result type");

const operations = [
  ["build_burrows_json", "std::string"],
  ["create_burrow", "int32_t"],
  ["rename_burrow", "bool"],
  ["set_burrow_member", "bool"],
  ["apply_burrow_action", "bool"],
  ["set_burrow_symbol", "bool"],
  ["delete_burrow", "bool"],
  ["paint_burrow", "int"],
];
for (const [name, value] of operations) {
  assert.match(source, new RegExp(`ApiResult<${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}> ${name}\\(`),
    `${name} must return an explicit result instead of a bool plus output parameters`);
}

for (const code of ["burrows_unavailable", "world_unavailable", "burrow_allocation_failed",
  "burrow_not_found", "unit_not_found", "civ_alert_update_failed", "unknown_burrow_action",
  "burrow_not_tracked", "viewport_unavailable"]) {
  assert.match(source, new RegExp(`"${code}"`), `missing stable burrow failure code ${code}`);
}

assert.doesNotMatch(source, /do_burrow_[a-z_]+\([^)]*std::string\* err/,
  "burrow operations must not communicate failure through nullable string output parameters");
assert.match(source,
  /if \(!set_burrow_civalert[\s\S]*?return false;[\s\S]*?bump_burrow_seq\(\);[\s\S]*?return true;/,
  "civilian-alert revision must advance only after the mutation succeeds");

for (const name of ["create_burrow", "rename_burrow", "set_burrow_member",
  "apply_burrow_action", "set_burrow_symbol", "delete_burrow", "paint_burrow"]) {
  const route = new RegExp(`const auto result = ${name}\\([\\s\\S]*?if \\(!result\\.ok\\) \\{ send_api_error\\(result, res\\); return; \\}`);
  assert.match(source, route, `${name} route must refuse the explicit error before reporting success`);
}

// TEST-THE-TEST: the old ambiguous shape must fail this contract.
const oldShape = source.replace("ApiResult<bool> rename_burrow", "bool rename_burrow");
assert.doesNotMatch(oldShape, /ApiResult<bool> rename_burrow\(/,
  "seeded old bool-plus-error shape should be detected");

console.log("PASS burrows_api_result_test (8 explicit operations, stable failures, success-only wakeups)");
