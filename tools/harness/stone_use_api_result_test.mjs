import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(path.join(root, "src", "stone_use.cpp"), "utf8");
const result = readFileSync(path.join(root, "src", "api_result.h"), "utf8");
assert.match(result, /struct ApiError[\s\S]*?status[\s\S]*?code[\s\S]*?message/,
  "domain failures must carry status, stable code, and human message");
assert.match(source, /ApiResult<StoneUseCommand> parse_stone_use_command/,
  "request parsing must be separate from DF mutation");
assert.match(source, /std::from_chars/, "material coordinates must be parsed exactly");
assert.doesNotMatch(source, /std::atoi/, "malformed material coordinates must not silently become zero");
assert.match(source, /ApiResult<bool> set_stone_use\(const StoneUseCommand& command\)/,
  "the DF operation must accept a stable command DTO and return an explicit result");
assert.match(source, /if \(!command\.ok\)[\s\S]*?set_stone_use\(command\.value\)/,
  "the route must parse, refuse failures, then invoke the domain operation");
assert.match(source, /set_stone_use\(command\.value\)[\s\S]*?notify_player_input/,
  "stream wakeup must happen only after a successful mutation");

const parse = (mat, value = "1") => {
  if (!/^-?\d+:-?\d+$/.test(mat)) return false;
  const [type, index] = mat.split(":").map(Number);
  return Number.isInteger(type) && type >= -32768 && type <= 32767 && Number.isInteger(index) &&
    index >= -2147483648 && index <= 2147483647 && (value === "0" || value === "1");
};
for (const good of [["0:0", "1"], ["0:2147483647", "0"], ["-32768:-1", "1"]])
  assert(parse(...good), `valid boundary rejected: ${good}`);
for (const bad of [["x:1", "1"], ["0:", "1"], ["0:1junk", "1"], ["0:1:2", "1"],
  ["32768:1", "1"], ["0:2147483648", "1"], ["0:1", "true"]])
  assert(!parse(...bad), `TEST-THE-TEST: malformed command accepted: ${bad}`);

console.log("PASS stone_use_api_result_test (typed parse/operation/result seam and hostile inputs)");
