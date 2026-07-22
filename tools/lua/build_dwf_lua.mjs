// Ordered Lua source parts generate the one dwf.lua artifact every installer already understands.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "lua", "dwf.parts.json"), "utf8"));
const output = path.join(root, manifest.output);
const partPaths = manifest.parts.map((part) => path.join(root, part));

if (process.argv.includes("--bootstrap")) {
  const current = readFileSync(output, "utf8");
  const markers = [
    "-- ---------------------------------------------------------------------------\n-- Browser build menu + placement",
    "-- ---------------------------------------------------------------------------\n-- Burial / memorial flows (Phase 5)",
    "-- ---------------------------------------------------------------------------\n-- Workshop/furnace panels",
    "-- ---------------------------------------------------------------------------\n-- WT26 -- DFHack command console",
    "-- ================================================================================================\n-- HOST-WRITES",
  ];
  const boundaries = [0, ...markers.map((marker) => {
    const index = current.indexOf(marker);
    assert(index > 0, `bootstrap marker not found: ${marker.split("\n").at(-1)}`);
    return index;
  }), current.length];
  assert.deepEqual([...boundaries].sort((a, b) => a - b), boundaries,
    "Lua domain markers must appear in manifest order");
  mkdirSync(path.dirname(partPaths[0]), { recursive: true });
  for (let i = 0; i < partPaths.length; i++)
    writeFileSync(partPaths[i], current.slice(boundaries[i], boundaries[i + 1]), "utf8");
}

const generated = Buffer.concat(partPaths.map((part) => readFileSync(part)));
if (process.argv.includes("--write")) {
  writeFileSync(output, generated);
  console.log(`WROTE ${manifest.output} from ${partPaths.length} ordered parts`);
} else {
  const installed = readFileSync(output);
  assert(installed.equals(generated),
    "dwf.lua differs from ordered source parts; edit a part and run node tools/lua/build_dwf_lua.mjs --write");
  console.log(`PASS dwf.lua is byte-identical to ${partPaths.length} ordered source parts`);
}
