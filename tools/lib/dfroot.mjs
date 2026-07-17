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
// W1 -- THE DF-ROOT RESOLVER (Node half).
//
// Before this file, ~90 places in the repo hardcoded ONE machine's Dwarf Fortress install
// (the Steam library on drive F). On anybody else's computer they hard-failed, and CI could not
// exist, because "needs a DF install" and "does not" were indistinguishable.
//
// There is now exactly ONE resolution policy, in two implementations that a test keeps in
// lockstep -- this one for Node, tools/lib/dfroot.py for Python:
//
//     --df-root <path>        (explicit; also accepted: --df, --dfroot)   AUTHORITATIVE
//     $DWF_DF_ROOT            (env; legacy $DFCAPTURE_DF_ROOT / $DF_ROOT still honoured)
//     autodetect              (Steam's own libraryfolders.vdf, then the usual install spots)
//     -> otherwise NOTHING. Never a silent fall back to somebody's machine.
//
// An EXPLICIT root (flag or env) is authoritative: if it is wrong we fail loudly rather than
// quietly using some other install we happened to find. Silently substituting a different art
// source for the one you asked for is a whole family of bug this project has already paid for.
//
// The actual detection engine lives in host/hostlib.mjs (it ships to hosts in the release zip);
// this file is the argv/env POLICY layer plus the two failure modes the repo needs:
//
//   dfRootOrSkip(name)  -- for HARNESS SUITES. No DF install => print one SKIP line, exit 0.
//                          This is the line CI runs on: a DF-less machine sweeps green, and a
//                          machine WITH DF still runs the real raws oracle. (Same shape as
//                          live_guard.mjs's requireLiveOptIn, for the same reason.)
//   dfRootOrDie(name)   -- for TOOLS a human runs on purpose. No DF install => a message that
//                          says exactly what to pass, exit 2.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autodetectDfRoot, checkDfhack, isDfRoot, dfCandidates,
  dfhackBuildCandidates, autodetectDfhackBuild, isDfhackBuild,
} from "../../host/hostlib.mjs";

export const ENV_VARS = ["DWF_DF_ROOT", "DFCAPTURE_DF_ROOT", "DF_ROOT"];
export const FLAGS = ["--df-root", "--df", "--dfroot"];
export const DFHACK_BUILD_ENV_VARS = ["DWF_DFHACK_BUILD"];
export const DFHACK_BUILD_FLAGS = ["--dfhack-build"];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function flagValue(argv) {
  for (const f of FLAGS) {
    const i = argv.indexOf(f);
    if (i >= 0 && argv[i + 1]) return { value: argv[i + 1], source: f };
    const eq = argv.find((a) => a.startsWith(f + "="));
    if (eq) return { value: eq.slice(f.length + 1), source: f };
  }
  return null;
}

function envValue(env) {
  for (const v of ENV_VARS) if (env[v]) return { value: env[v], source: "$" + v };
  return null;
}

function namedValue(flags, envVars, argv, env) {
  for (const f of flags) {
    const i = argv.indexOf(f);
    if (i >= 0 && argv[i + 1]) return { value: argv[i + 1], source: f };
    const eq = argv.find((a) => a.startsWith(f + "="));
    if (eq) return { value: eq.slice(f.length + 1), source: f };
  }
  for (const v of envVars) if (env[v]) return { value: env[v], source: "$" + v };
  return null;
}

/**
 * Resolve the DF install. Returns { root, source, explicit, tried }.
 *   root     absolute path, or null when nothing was found
 *   source   how we got it ("--df-root" | "$DWF_DF_ROOT" | "autodetect")
 *   explicit true when the caller named it (flag or env) -- an explicit-but-wrong root is an
 *            ERROR, never a reason to autodetect past it
 *   tried    the ordered list of places looked, for the failure message
 */
export function resolveDfRoot({ argv = process.argv.slice(2), env = process.env,
                                exists = existsSync } = {}) {
  const tried = [];
  const named = flagValue(argv) || envValue(env);
  if (named) {
    const root = path.resolve(named.value);
    tried.push(`  [${named.source}] ${root}`);
    return { root: exists(root) ? root : null, source: named.source, explicit: true, tried };
  }
  const cands = dfCandidates(exists);
  const found = autodetectDfRoot(cands, exists);
  for (const c of cands) tried.push(`  [autodetect] ${c}`);
  return { root: found, source: "autodetect", explicit: false, tried };
}

/** W22: --dfhack-build > $DWF_DFHACK_BUILD > portable workspace/ancestor guesses > nothing. */
export function resolveDfhackBuild({ argv = process.argv.slice(2), env = process.env,
                                     exists = existsSync, repoRoot = REPO_ROOT,
                                     candidates = null } = {}) {
  const tried = [];
  const named = namedValue(DFHACK_BUILD_FLAGS, DFHACK_BUILD_ENV_VARS, argv, env);
  if (named) {
    const root = path.resolve(named.value);
    tried.push(`  [${named.source}] ${root}`);
    return { root: exists(root) ? root : null, source: named.source, explicit: true, tried };
  }
  const cands = candidates || dfhackBuildCandidates(repoRoot);
  const found = autodetectDfhackBuild(cands, exists);
  for (const c of cands) tried.push(`  [autodetect] ${c}`);
  return { root: found, source: "autodetect", explicit: false, tried };
}

export function missingDfhackBuildMessage(res, purpose = "") {
  const why = purpose ? `\n  It needs one because: ${purpose}` : "";
  const head = res.explicit
    ? `The DFHack build tree you named does not exist.${why}`
    : `No DFHack build tree was found on this machine.${why}`;
  const looked = res.explicit ? res.tried : res.tried.slice(0, 8).concat(
    res.tried.length > 8 ? [`  ... and ${res.tried.length - 8} more`] : []);
  return [head, "", "Looked in:", ...looked, "",
    "Point it at your CMake build directory, either way:",
    '  --dfhack-build "C:\\...\\dfhack\\build"',
    '  set DWF_DFHACK_BUILD=C:\\...\\dfhack\\build',
  ].join("\n");
}

export function dfhackBuildOrDie(toolName, purpose = "") {
  const res = resolveDfhackBuild();
  if (res.root) return res.root;
  console.error(`${toolName}: CANNOT RUN.\n`);
  console.error(missingDfhackBuildMessage(res, purpose));
  process.exit(2);
}

export function builtDfcaptureDll(buildRoot, config = "Release") {
  return path.join(buildRoot, "plugins", "external", "multi-dwarf", config,
                   "dwf.plug.dll");
}

/** CMake records the source tree even when the build directory is not its sibling. */
export function dfhackSourceRoot(buildRoot, readText = (p) => readFileSync(p, "utf8")) {
  try {
    const cache = readText(path.join(buildRoot, "CMakeCache.txt"));
    const match = String(cache).match(/^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m);
    if (match) return path.resolve(match[1].trim());
  } catch { /* a DLL-only build tree may not retain its cache */ }
  return path.dirname(buildRoot);
}

export function missingDfMessage(res, purpose = "") {
  const why = purpose ? `\n  It needs one because: ${purpose}` : "";
  const head = res.explicit
    ? `The Dwarf Fortress folder you named does not exist.${why}`
    : `No Dwarf Fortress install was found on this machine.${why}`;
  const looked = res.explicit ? res.tried : res.tried.slice(0, 8).concat(
    res.tried.length > 8 ? [`  ... and ${res.tried.length - 8} more`] : []);
  return [
    head,
    "",
    "Looked in:",
    ...looked,
    "",
    "Point it at your install, either way:",
    '  --df-root "C:\\...\\Dwarf Fortress"',
    '  set DWF_DF_ROOT=C:\\...\\Dwarf Fortress',
    "",
    "The install is only ever READ.",
  ].join("\n");
}

/** HARNESS SUITES: no DF install => one SKIP line, exit 0. The CI boundary. */
export function dfRootOrSkip(suiteName, purpose = "reads Dwarf Fortress's own raws/art as an oracle") {
  const res = resolveDfRoot();
  if (res.root && isDfRoot(res.root)) return res.root;
  if (res.explicit && res.root) return res.root;   // named it: trust the caller, let it fail loud
  console.log(`SKIP ${suiteName}: needs a Dwarf Fortress install (${purpose}).`);
  console.log(`  Point it at one:  node tools/harness/${suiteName} --df-root "C:\\...\\Dwarf Fortress"`);
  console.log(`  or set DWF_DF_ROOT. Without it there is no oracle to compare against, so the`);
  console.log(`  suite skips rather than inventing ground truth.`);
  process.exit(0);
}

/** TOOLS: no DF install => the message that says what to pass, exit 2. */
export function dfRootOrDie(toolName, purpose = "") {
  const res = resolveDfRoot();
  if (res.root) return res.root;
  console.error(`${toolName}: CANNOT RUN.\n`);
  console.error(missingDfMessage(res, purpose));
  process.exit(2);
}

/** The DFHack CLI inside an install. It lives in hack/, NOT at the DF root. */
export function dfhackRun(dfRoot) { return path.join(dfRoot, "hack", "dfhack-run.exe"); }

/**
 * Default for the LIVE ORACLE suites' `--dfhack-run` flag. Non-fatal: these suites are gated by
 * live_guard's requireLiveOptIn() and skip long before they use this, so a machine with no DF
 * install must still be able to import them. Empty string when there is nothing to point at --
 * and an oracle that got this far without an install has already been opted in on purpose, so
 * the spawn's own ENOENT is the honest error.
 * ($DFHACK_RUN still wins, for a DFHack that is not inside the DF root.)
 */
export function defaultDfhackRun() {
  if (process.env.DFHACK_RUN) return process.env.DFHACK_RUN;
  const root = resolveDfRoot().root;
  return root ? dfhackRun(root) : "";
}

export {
  checkDfhack, isDfRoot, autodetectDfRoot, dfCandidates,
  dfhackBuildCandidates, autodetectDfhackBuild, isDfhackBuild,
};
