import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "tools", "release", "test-manifest.json"), "utf8"));
const categories = ["offline", "df_install_optional", "live_read_only", "live_mutating", "manual_visual"];
for (const category of categories) {
  assert(Array.isArray(manifest[category]), `${category} must be an explicit array`);
  assert(manifest[category].length > 0, `${category} must not disappear into an implicit skip`);
}
for (const suite of manifest.offline) {
  const exists = existsSync(path.join(root, suite.file));
  assert(exists || suite.private === true, `offline suite is missing: ${suite.file}`);
  assert.equal(suite.requires, undefined, `offline suite cannot hide an environmental requirement: ${suite.file}`);
  if (suite.platforms !== undefined) {
    assert(Array.isArray(suite.platforms) && suite.platforms.length > 0,
      `offline suite platforms must be a non-empty array: ${suite.file}`);
    for (const platform of suite.platforms)
      assert(["win32", "linux", "darwin"].includes(platform), `unknown platform ${platform}: ${suite.file}`);
  }
}
for (const category of ["df_install_optional", "live_read_only", "live_mutating"])
  for (const suite of manifest[category]) {
    const exists = existsSync(path.join(root, suite.file));
    assert(exists || suite.private === true, `${category} suite is missing: ${suite.file}`);
    assert.equal(typeof suite.requires, "string", `${category} suite must state why it is not offline`);
  }
for (const item of manifest.manual_visual)
  assert(existsSync(path.join(root, item.document)) || item.private === true,
    `manual evidence document is missing: ${item.document}`);

console.log(`PASS test_manifest_test (${manifest.offline.length} offline; explicit optional/live/manual categories)`);
