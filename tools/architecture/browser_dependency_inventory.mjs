// Capture the classic-script load contract without changing the browser's loading model.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(path.join(root, "web", "index.html"), "utf8");
const output = path.join(root, "tools", "architecture", "browser-scripts.json");
const scripts = [...html.matchAll(/<script\s+src="\/js\/([^"?]+)(?:\?([^"]*))?"\s*>\s*<\/script>/g)]
  .map((match, order) => {
    const file = `web/js/${match[1]}`;
    const source = readFileSync(path.join(root, file), "utf8");
    const provided = new Set();
    for (const item of source.matchAll(/(?:window|root|globalThis)\.([A-Z][A-Za-z0-9_]*)\s*=/g))
      provided.add(item[1]);
    const used = new Set();
    for (const item of source.matchAll(/(?:window|globalThis)\.([A-Z][A-Za-z0-9_]*)/g))
      if (!provided.has(item[1])) used.add(item[1]);
    return { order, file, cacheKey: match[2] || "", provides: [...provided].sort(), uses: [...used].sort() };
  });
const document = { schemaVersion: 1, loadingModel: "ordered-classic-scripts", scripts };
const serialized = `${JSON.stringify(document, null, 2)}\n`;

// COLD-LOAD ROUND 2: the same scan, baked back into index.html as window.__DWF_SCRIPT_MANIFEST__.
// dwf-boot-health.js reads it to answer "which scripts in the chain did not actually evaluate?" and
// re-injects exactly those. Generating it HERE is the point: the manifest and browser-scripts.json
// come from one pass over one source of truth, so the self-heal list can never drift from the
// chain it is supposed to repair. Files with no detectable window global carry an empty `provides`
// and are covered instead by the capture-phase error listener (a dropped request) and by the
// SyntaxError a truncated body throws -- both of which name the file.
const MANIFEST_BEGIN = "<!-- BEGIN GENERATED SCRIPT MANIFEST -->";
const MANIFEST_END = "<!-- END GENERATED SCRIPT MANIFEST -->";
const manifestRows = scripts.map((s) => JSON.stringify({
  file: s.file.replace(/^web\/js\//, ""),
  url: `/js/${s.file.replace(/^web\/js\//, "")}${s.cacheKey ? `?${s.cacheKey}` : ""}`,
  provides: s.provides,
}));
const manifestBlock = `${MANIFEST_BEGIN}\n<script>\nwindow.__DWF_SCRIPT_MANIFEST__ = [\n${
  manifestRows.map((r) => `  ${r}`).join(",\n")}\n];\n</script>\n${MANIFEST_END}`;
const manifestRe = new RegExp(`${MANIFEST_BEGIN}[\\s\\S]*?${MANIFEST_END}`);
assert(manifestRe.test(html), "web/index.html must contain the generated script-manifest markers");
const htmlWithManifest = html.replace(manifestRe, () => manifestBlock);

if (process.argv.includes("--write")) {
  writeFileSync(output, serialized);
  if (htmlWithManifest !== html) writeFileSync(path.join(root, "web", "index.html"), htmlWithManifest);
  console.log(`WROTE ${path.relative(root, output)} (${scripts.length} scripts)`);
} else {
  assert.equal(readFileSync(output, "utf8").replace(/\r\n/g, "\n"), serialized,
    "classic-script dependency inventory drifted; inspect load order/globals/cache keys and refresh with --write");
  assert.equal(htmlWithManifest, html,
    "web/index.html's generated script manifest drifted from the chain; refresh with --write");
  assert(scripts.every((script, index) => script.order === index && script.cacheKey),
    "every production script needs an explicit ordered cache key");
  const position = (name) => scripts.findIndex((script) => script.file.endsWith(name));
  for (const [provider, consumer] of [["dwf-ui-components.js", "dwf-chat.js"],
    ["dwf-wire-v1.js", "dwf-ws.js"], ["dwf-cache.js", "dwf-ws.js"],
    ["dwf-core.js", "dwf-map-chrome-controls.js"]])
    assert(position(provider) >= 0 && position(provider) < position(consumer),
      `${provider} must load before ${consumer}`);
  console.log(`PASS browser dependency inventory (${scripts.length} ordered classic scripts)`);
}
