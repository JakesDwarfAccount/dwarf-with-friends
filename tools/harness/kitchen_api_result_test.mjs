import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "src", "kitchen_panel.cpp"), "utf8");
const response = readFileSync(path.join(root, "src", "api_response.h"), "utf8");

assert.match(source, /#include "api_response\.h"/,
  "Kitchen routes must use the shared result-to-HTTP adapter");
assert.match(response, /result\.error\.code[\s\S]*?result\.error\.message/,
  "the shared adapter must preserve stable code and human message");

for (const [type, name] of [
  ["std::string", "build_kitchen_json"],
  ["bool", "set_plant_brew_allowed"],
  ["bool", "set_seed_cook_allowed"],
  ["bool", "set_item_kitchen_allowed"],
]) {
  assert.match(source, new RegExp(`ApiResult<${type}> ${name}\\(`),
    `${name} must return one explicit result`);
}

for (const code of ["world_unavailable", "invalid_plant", "plant_not_brewable",
  "invalid_item_type", "item_not_brewable"]) {
  assert.match(source, new RegExp(`"${code}"`), `missing stable Kitchen failure code ${code}`);
}

assert.match(source,
  /const auto result = build_kitchen_json\(player\);[\s\S]*?if \(!result\.ok\) \{ send_api_error\(result, res\); return; \}[\s\S]*?result\.value/,
  "Kitchen reads must refuse failure before serializing success");
assert.match(source,
  /const auto result = set_item_kitchen_allowed\([\s\S]*?if \(!result\.ok\) \{ send_api_error\(result, res\); return; \}[\s\S]*?\{\\"ok\\":true\}/,
  "item toggles must refuse failure before reporting success");
assert.match(source,
  /set_plant_brew_allowed\(id, on != 0\)[\s\S]*?set_seed_cook_allowed\(id, on != 0\)[\s\S]*?if \(!result\.ok\) \{ send_api_error\(result, res\); return; \}/,
  "plant toggles must share the explicit success/failure route path");
assert.doesNotMatch(source, /bool do_kitchen_(?:brew_)?toggle|bool do_kitchen_item_toggle/,
  "legacy bool plus error-output operations must be gone");

console.log("PASS kitchen_api_result_test (4 explicit operations and stable failures)");
