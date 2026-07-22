// Inventory native source ownership by its strongest DF access boundary.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = path.join(root, "src");
const output = path.join(root, "tools", "architecture", "df-access-policy.json");
const renderOwners = new Set(["sdl_capture.cpp", "tile_dump.cpp", "unit_portrait.cpp"]);
const conditionalOwners = new Set(["diagnostics.cpp", "flight_recorder.cpp", "flight_recorder_v3.cpp"]);

function classify(file, text) {
  if (renderOwners.has(file) || text.includes("runOnRenderThread")) return "render-thread";
  if (conditionalOwners.has(file)) return "conditional-sampling";
  if (text.includes("CoreSuspender")) return "ordinary-suspended";
  const dfMarkers = /df::global|#include "df\/|DFHack::|modules\//.test(text);
  return dfMarkers ? "direct-or-delegated-review" : "no-df-access";
}

const files = readdirSync(src).filter((file) => file.endsWith(".cpp")).sort().map((file) => {
  const text = readFileSync(path.join(src, file), "utf8");
  const category = classify(file, text);
  return {
    file: `src/${file}`,
    category,
    rule: category === "ordinary-suspended" ? "DF reads/writes occur under a visible CoreSuspender or owned locked helper" :
      category === "render-thread" ? "render state is accessed only through the documented render-thread hop/guard" :
      category === "conditional-sampling" ? "diagnostic sampling may read stable DF state without suspension and must never mutate it" :
      category === "no-df-access" ? "must remain independent of DF globals and render state" :
      "review delegated helpers and direct DF references before changing this file",
  };
});
const document = { schemaVersion: 1, categories: ["ordinary-suspended", "render-thread",
  "conditional-sampling", "no-df-access", "direct-or-delegated-review"], files };
const serialized = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes("--write")) {
  writeFileSync(output, serialized);
  console.log(`WROTE ${path.relative(root, output)} (${files.length} native files)`);
} else {
  assert.equal(readFileSync(output, "utf8").replace(/\r\n/g, "\n"), serialized,
    "DF access policy drifted; inspect the new access pattern and refresh intentionally with --write");
  assert(files.some((item) => item.category === "render-thread"));
  assert(files.some((item) => item.category === "ordinary-suspended"));
  assert(files.some((item) => item.category === "direct-or-delegated-review"));
  console.log(`PASS DF access inventory (${files.length} native files classified)`);
}
