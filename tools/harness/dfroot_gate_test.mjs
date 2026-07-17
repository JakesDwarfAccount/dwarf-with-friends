// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// W1/W22 GREP GATE -- no source file may hardcode one machine's Dwarf Fortress install or
// DFHack CMake build tree.
// Required by the W17 release checklist item 5 ("No F:\SteamLibrary anywhere in the source").
//
// THE RULE, stated exactly, because a gate whose rule is vague gets neutered the first time it
// false-positives:
//
//   SCANNED:   tracked CODE under src/ web/ host/ tools/ scripts/, plus code at the repo root.
//              Code = .mjs .js .cjs .ts .py .cpp .h .hpp .lua .sh .cmd .bat .ps1 .html .css
//   NOT SCANNED:
//     - *.md and everything under docs/  -- prose is ALLOWED to quote the historical path; that
//       is how you explain a bug's history. Documentation that INSTRUCTS (AGENTS.md, the harness
//       README) was rewritten to the --df-root mechanism, but the gate does not police prose.
//     - *.json  -- data, not source. tools/orchestrator/registry.json is a bug database whose
//       report text quotes real paths; tools/ws2/evidence/*.json is a frozen record of a past
//       run's stdout. Rewriting either would be falsifying a record.
//     - node_modules/, .git/, and this file's own fixtures.
//
//   FAILS ON:  an ABSOLUTE path that names a Dwarf Fortress install or DFHack build tree --
//     (a) drive-lettered:   F:\SteamLibrary\...\Dwarf Fortress   C:/Program Files/Steam/...
//     (b) MSYS/Git-Bash:    /f/SteamLibrary/...                  /c/.../Dwarf Fortress
//     (c) the bare token `SteamLibrary` preceded by a drive letter or a root slash.
//     (d) build axis:       C:\work\dfhack\build-msvc            /c/work/dfhack/build
//
//   PASSES:    the resolver's own candidate tables, because every entry there is a RELATIVE tail
//              ("SteamLibrary\\steamapps\\common\\Dwarf Fortress") with no drive letter -- the
//              drive is cross-producted in at runtime. That is not an accident of the regex; it
//              is the shape a portable candidate list has to have, so the gate keys on it.
//
//   ESCAPE HATCH: a line carrying the marker `dfroot-gate: allow -- <reason>` is exempt, and the
//              gate PRINTS every exemption with its reason on every run, so the list cannot grow
//              quietly. Two exist today, both in tests that must assert on drive-lettered output.
//
// Self-test (`--selftest`) proves the scanner is not vacuous by feeding it a seeded violation.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const THIS_FILE = "tools/harness/dfroot_gate_test.mjs";

const CODE_EXT = new Set([
  ".mjs", ".js", ".cjs", ".ts", ".py", ".cpp", ".h", ".hpp", ".lua",
  ".sh", ".cmd", ".bat", ".ps1", ".html", ".css",
]);
const SCAN_DIRS = ["src", "web", "host", "tools", "scripts"];
const ALLOW_MARKER = "dfroot-gate: allow";

// (a) drive-lettered absolute path into a DF install / Steam library. Spaces are legal inside a
//     Windows path ("Program Files (x86)"), so only quotes/backticks/pipes terminate the scan.
const RE_DRIVE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}[^"'`\n|]*?(?:SteamLibrary|Dwarf[ _]Fortress)/g;
// (b) MSYS/Git-Bash-rooted absolute path (/f/SteamLibrary/..., /c/.../Dwarf Fortress).
const RE_MSYS = /(?<![A-Za-z0-9.])\/[a-zA-Z]\/[^"'`\n|]*?(?:SteamLibrary|Dwarf Fortress)/g;
// W22: the second localization axis. Match a concrete absolute path through a dfhack build dir;
// relative output suffixes are portable and deliberately allowed.
const RE_DFHACK_BUILD_DRIVE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}[^"'`\n|]*?dfhack[\\/]+build(?:-[A-Za-z0-9_.-]+)?/gi;
const RE_DFHACK_BUILD_MSYS = /(?<![A-Za-z0-9.])\/[a-zA-Z]\/[^"'`\n|]*?dfhack\/build(?:-[A-Za-z0-9_.-]+)?/gi;

// A PLACEHOLDER is not a hardcoded path: `--df-root "C:\...\Dwarf Fortress"` is the very advice
// this gate exists to make people print. Placeholders elide with `...` or `<angle brackets>`.
// Anything concrete enough to actually open on a disk is a violation.
function isPlaceholder(m) { return m.includes("...") || m.includes("<"); }

export function violationsIn(text, relPath) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    const hits = [...line.matchAll(RE_DRIVE), ...line.matchAll(RE_MSYS),
                  ...line.matchAll(RE_DFHACK_BUILD_DRIVE),
                  ...line.matchAll(RE_DFHACK_BUILD_MSYS)]
      .map((m) => m[0]).filter((m) => !isPlaceholder(m));
    if (hits.length) {
      out.push({ file: relPath, line: i + 1, hit: hits[0], text: line.trim().slice(0, 110) });
    }
  });
  return out;
}

function trackedCodeFiles() {
  const out = execFileSync("git", ["ls-files", "-z", ...SCAN_DIRS, "*.lua", "*.mjs", "*.js", "*.py",
                                   "*.cmd", "*.sh", "*.ps1"],
                           { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\0").filter(Boolean)
    .filter((f) => CODE_EXT.has(path.extname(f).toLowerCase()))
    .filter((f) => f !== THIS_FILE)
    .filter((f) => !f.includes("node_modules/"));
}

function selftest() {
  let bad = 0;
  const must = [
    ['const DF = "F:\\\\SteamLibrary\\\\steamapps\\\\common\\\\Dwarf Fortress";', "windows backslash"],
    ['const DF = "F:/SteamLibrary/steamapps/common/Dwarf Fortress";', "windows forward slash"],
    ['DF="/f/SteamLibrary/steamapps/common/Dwarf Fortress"', "msys path"],
    ["DF_ROOT = r\"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dwarf Fortress\"", "program files"],
    ["local f = io.open('C:/DaMain/Games/Steam/steamapps/common/Dwarf Fortress/x.log')", "someone else's machine"],
    ['DLL="/c/dev/dfhack/build-release/plugins/dfcapture.plug.dll"', "MSYS DFHack build tree"],
    ['const BUILD = "D:\\work\\dfhack\\build-msvc";', "Windows DFHack build tree"],
  ];
  for (const [line, label] of must) {
    if (violationsIn(line, "x").length !== 1) { console.log(`  FAIL selftest catches: ${label}`); bad++; }
    else console.log(`  ok   - selftest catches: ${label}`);
  }
  const mustNot = [
    ['"SteamLibrary\\\\steamapps\\\\common\\\\Dwarf Fortress",', "relative candidate tail (the resolver)"],
    ['r"SteamLibrary\\steamapps\\common\\Dwarf Fortress",', "relative candidate tail (python)"],
    ["// see docs for the F: history", "prose without a path"],
    ['const DF = "F:\\\\SteamLibrary\\\\x"; // dfroot-gate: allow -- test fixture', "allow marker"],
    ['  --df-root "C:\\\\...\\\\Dwarf Fortress"', "the placeholder the failure message prints"],
    ['usage: --df-root <path to Dwarf Fortress>', "angle-bracket placeholder"],
    ['  --dfhack-build "C:\\...\\dfhack\\build"', "DFHack build placeholder"],
    ['path.join(buildRoot, "plugins", "external")', "relative build output suffix"],
  ];
  for (const [line, label] of mustNot) {
    if (violationsIn(line, "x").length !== 0) { console.log(`  FAIL selftest ignores: ${label}`); bad++; }
    else console.log(`  ok   - selftest ignores: ${label}`);
  }
  return bad;
}

// --------------------------------------------------------------------------------- run
const args = process.argv.slice(2);
console.log("# dfroot_gate -- no hardcoded Dwarf Fortress install in source");

console.log("\n## scanner self-test (proves the gate is not vacuous)");
let failed = selftest();

console.log("\n## repo scan");
const files = trackedCodeFiles();
const violations = [];
const exemptions = [];
for (const f of files) {
  const abs = path.join(ROOT, f);
  if (!existsSync(abs)) continue;
  let text;
  try { text = readFileSync(abs, "utf8"); } catch { continue; }
  violations.push(...violationsIn(text, f));
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) {
      const reason = line.slice(line.indexOf(ALLOW_MARKER) + ALLOW_MARKER.length)
        .replace(/^\s*--\s*/, "").trim();
      exemptions.push(`${f}:${i + 1}  ${reason || "(NO REASON GIVEN)"}`);
    }
  });
}
console.log(`  scanned ${files.length} tracked code files`);

if (exemptions.length) {
  console.log(`\n  ${exemptions.length} exemption(s) -- printed every run so the list cannot grow quietly:`);
  for (const e of exemptions) console.log("    " + e);
  for (const e of exemptions) {
    if (e.includes("(NO REASON GIVEN)")) {
      console.log("  FAIL - an exemption with no reason: " + e);
      failed++;
    }
  }
}

if (violations.length) {
  console.log(`\n  FAIL - ${violations.length} hardcoded DF install/build path(s):`);
  for (const v of violations) console.log(`    ${v.file}:${v.line}  ${v.text}`);
  console.log("\n  Route it through the shared resolver instead:");
  console.log("    node    import { dfRootOrSkip, dfRootOrDie } from '<repo>/tools/lib/dfroot.mjs'");
  console.log("    python  sys.path.insert(0, <repo>/tools/lib); import dfroot");
  console.log("    shell   . \"$(dirname \"$0\")/../lib/dfroot.sh\"; DF=\"$(df_root_or_die <name>)\"");
  console.log("    build   resolveDfhackBuild() / dfhack_build_or_die (same three bindings)");
  console.log("  If a line genuinely must contain one (a test asserting on the candidate list),");
  console.log(`  mark it: // ${ALLOW_MARKER} -- <why>`);
  failed += violations.length;
} else {
  console.log("  ok   - no hardcoded Dwarf Fortress install path in source");
}

console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exit(failed ? 1 : 0);
