// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// R2 controller fixture: cache-backed GL must not retain contentVersion as a hidden full-build
// fallback. BLOCK_SET/onDirty is the sole terrain trigger after the initial scene.
// Run: node tools/harness/r2_rebuildkey_test.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
globalThis.window = globalThis;
globalThis.location = { search: "" };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  createElement: () => ({ style: {}, addEventListener() {}, getContext: () => null }),
  body: { appendChild() {} },
};
globalThis.requestAnimationFrame = () => 0;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-render.js"), "utf8"),
  { filename: "dwf-render.js" });

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`  ok   - ${name}`);
  else { failures++; console.log(`  FAIL - ${name}`); }
}

console.log("R2 -- controller rebuild key delegates terrain to onDirty");
const key = globalThis.DwfRender && globalThis.DwfRender._terrainKeyComponentForTest;
check("R2 terrain key helper is exposed", typeof key === "function");

const patching = { usesChunkPatching: true };
const before = key(patching, { contentVersion: 100 }, 1);
const after = key(patching, { contentVersion: 101 }, 2);
check("cache contentVersion churn cannot request a full scene build under R2",
  before === "r2" && after === "r2" && before === after);

const legacyBefore = key({ usesChunkPatching: false }, { contentVersion: 100 }, 1);
const legacyAfter = key({ usesChunkPatching: false }, { contentVersion: 101 }, 2);
check("legacy/no-onDirty fallback still follows F3 contentVersion",
  legacyBefore === "v100" && legacyAfter === "v101" && legacyBefore !== legacyAfter);

// B211 (2026-07-14): the overview/world-map stage is deleted, so the key no longer has an
// overview escape hatch -- under R2 chunk patching, EVERY view is a patched terrain view.
check("no overview escape hatch: a patching renderer always takes the r2 path",
  key(patching, { overview: {}, overviewVersion: "1.2.3" }, 1) === "r2");

check("TEST-THE-TEST: seeded old full-rebuild key is detected as different on terrain churn",
  legacyBefore !== legacyAfter && before === after);

console.log(failures ? `FAIL R2 rebuild key (${failures} failures)` : "PASS R2 rebuild key (0 failures)");
process.exit(failures ? 1 : 0);
