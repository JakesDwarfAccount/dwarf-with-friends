import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "src", "labor.cpp"), "utf8");
const header = readFileSync(path.join(root, "src", "labor.h"), "utf8");

assert.match(source, /#include "api_response\.h"/,
  "Labor routes must use the shared result-to-HTTP adapter");

for (const [type, name] of [
  ["LaborState", "build_labor_state"],
  ["bool", "set_labor_assignment"],
  ["bool", "set_labor_mode"],
  ["bool", "set_labor_specialist"],
  ["int", "create_labor_detail"],
  ["bool", "rename_labor_detail"],
  ["bool", "delete_labor_detail"],
  ["bool", "set_labor_task"],
]) {
  const signature = new RegExp(`ApiResult<${type}> ${name}\\(`);
  assert.match(source, signature, `${name} implementation must return one explicit result`);
  assert.match(header, signature, `${name} public declaration must match its explicit result`);
  assert.match(source, new RegExp(`const auto result = ${name}\\([\\s\\S]*?if \\(!result\\.ok\\) \\{ send_api_error\\(result, res\\); return; \\}`),
    `${name} route must refuse failure before reporting success`);
}

for (const code of ["world_unavailable", "plotinfo_unavailable", "labor_detail_not_found",
  "unit_not_assignable", "invalid_labor_mode", "labor_detail_allocation_failed",
  "empty_labor_name", "labor_detail_protected", "invalid_labor"]) {
  assert.match(source, new RegExp(`"${code}"`), `missing stable Labor failure code ${code}`);
}

assert.doesNotMatch(header, /std::string\s*\*\s*err|out_index/,
  "Labor's public boundary must not expose parallel error or result output parameters");
assert.match(source, /if \(details\[detail\]->flags\.bits\.no_modify\)[\s\S]*?labor_detail_protected/,
  "default work details must remain protected from deletion");
assert.match(source, /set_labor_assignment[\s\S]*?Units::setAutomaticProfessions\(unit\)/,
  "assignment changes must still refresh the affected unit's automatic profession");

console.log("PASS labor_api_result_test (8 explicit operations and preserved safety rules)");
