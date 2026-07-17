// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// sprite_provenance_gate_test.mjs -- W11 HARD GATE: no Kitfox/Bay 12-derived
// artwork may be TRACKED in this repository. The eight client sprite PNGs
// (dwarf.png family, item_*_composite.png, animal_people_flat.png, favicon.png)
// were proven derived from the paid DF graphics (byte-identical rebuilds from a
// real install, 2026-07-14) and removed; they are baked on the HOST's machine
// by host/bake_sprites.mjs from host/sprite_recipe.json instead. This gate
// fails if any of them -- or ANY new raster image -- is reintroduced into the
// tracked tree under web/, tools/ws2/sprites/, or tools/ws2/evidence/.
//
//   node tools/harness/sprite_provenance_gate_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// The check runs on `git ls-files` (TRACKED files only): regenerating sprites
// locally for a deploy is fine; COMMITTING them is what this gate forbids.
// Non-vacuity: the scanner is a pure function and this suite first proves it
// flags seeded violations before trusting its verdict on the real repo.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

// The eight files proven Kitfox-derived (W11 provenance verdicts) -- banned by
// BASENAME anywhere in the tracked tree, so a move does not evade the gate.
export const BANNED_BASENAMES = [
  "dwarf.png", "dwarf_dark.png", "dwarf_female.png", "animal_people_flat.png",
  "item_chair_composite.png", "item_hatch_composite.png", "item_table_composite.png",
  "favicon.png",
];

// Directories where NO tracked raster image is acceptable at all. web/ ships to
// every host; the two tools dirs held DF-derived pixels (sprite bakes, unit-
// texture exports) before W11. New legitimate raster assets need an explicit
// allowlist entry here WITH a provenance justification.
const NO_RASTER_DIRS = ["web/", "tools/ws2/sprites/", "tools/ws2/evidence/"];
const RASTER_ALLOWLIST = new Map([
  // "web/example.png": "why this file is provably original",
]);
const RASTER_RE = /\.(png|jpe?g|gif|bmp|webp|ico)$/i;

// Pure scanner: tracked paths (forward slashes) -> violation strings.
export function scanTracked(paths) {
  const violations = [];
  for (const p of paths) {
    const base = p.split("/").pop();
    if (BANNED_BASENAMES.includes(base)) {
      violations.push(`${p}: '${base}' is a Kitfox-derived sprite (bake it on the host; never commit it)`);
      continue;
    }
    if (RASTER_RE.test(p) && NO_RASTER_DIRS.some((d) => p.startsWith(d)) && !RASTER_ALLOWLIST.has(p)) {
      violations.push(`${p}: raster image tracked in a no-raster dir (add allowlist entry ONLY with provenance proof)`);
    }
  }
  return violations;
}

function main() {
  console.log("# scanner non-vacuity (seeded violations MUST be flagged)");
  check("flags web/dwarf.png", scanTracked(["web/dwarf.png"]).length === 1);
  check("flags a banned basename even when MOVED (src/img/favicon.png)",
    scanTracked(["src/img/favicon.png"]).length === 1);
  check("flags a NEW raster smuggled into web/ under a fresh name",
    scanTracked(["web/sneaky_sprite.png"]).length === 1);
  check("flags a raster in tools/ws2/sprites/", scanTracked(["tools/ws2/sprites/elf.png"]).length === 1);
  check("clean paths pass", scanTracked([
    "web/js/app.js", "web/creatures_map.json", "host/sprite_recipe.json",
    "tools/ws2/bake_dwarf.py", "docs/x.png",
  ]).length === 0);

  console.log("\n# real repository (tracked files)");
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO })
    .toString().split("\n").filter(Boolean).map((s) => s.replace(/\\/g, "/"));
  check("git ls-files returned a plausible tree", tracked.length > 100);
  const violations = scanTracked(tracked);
  check("ZERO Kitfox-derived / unexplained raster files tracked", violations.length === 0,
    "\n    " + violations.slice(0, 20).join("\n    "));

  console.log("\n# NOTICE stays in lockstep with reality");
  const notice = readFileSync(join(REPO, "NOTICE"), "utf8");
  check("NOTICE explains the install-time sprite bake (mentions bake_sprites.mjs)",
    notice.includes("bake_sprites.mjs"));
  check("NOTICE still credits the curses-font glyph shapes to Bay 12",
    notice.includes("df-curses.ttf") && /Bay 12/i.test(notice));

  console.log(`\n${failed ? "FAIL" : "PASS"} - ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
