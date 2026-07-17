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
// W1 -- the DF-root resolver's own suite, and the thing that keeps ONE POLICY from quietly
// becoming two. Node and Python cannot share an implementation, so this suite runs BOTH against
// the same synthetic inputs and fails if they disagree: candidate order, precedence, and the
// resolved answer. Without it, "one resolver" is an aspiration; with it, it is a gate.
//
// Everything here uses INJECTED existence predicates and fake trees -- no real DF install is
// touched, and the suite is identical on a machine that has one and a machine that does not.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveDfRoot, dfCandidates, isDfRoot, dfhackRun, defaultDfhackRun, missingDfMessage,
  resolveDfhackBuild, missingDfhackBuildMessage, builtDfcaptureDll, dfhackSourceRoot,
  DFHACK_BUILD_ENV_VARS, DFHACK_BUILD_FLAGS, ENV_VARS, FLAGS,
} from "../lib/dfroot.mjs";
import {
  steamDfCandidates, steamLibraryDfCandidates, autodetectDfRoot,
  dfhackBuildCandidates, autodetectDfhackBuild,
} from "../../host/hostlib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY_LIB = path.join(ROOT, "tools", "lib");

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ok   - " + name); }
  catch (e) { failed++; console.log("  FAIL - " + name + "\n         " + (e.message || e)); }
};

// ---------------------------------------------------------------- a fake DF install on disk
const tmp = mkdtempSync(path.join(tmpdir(), "dfroot-"));
const FAKE = path.join(tmp, "Dwarf Fortress");
mkdirSync(path.join(FAKE, "data", "vanilla"), { recursive: true });
mkdirSync(path.join(FAKE, "hack", "plugins"), { recursive: true });
writeFileSync(path.join(FAKE, "Dwarf Fortress.exe"), "");
const NOT_DF = path.join(tmp, "not-a-df");
mkdirSync(NOT_DF, { recursive: true });
const FAKE_BUILD = path.join(tmp, "dfhack", "build-msvc");
mkdirSync(FAKE_BUILD, { recursive: true });
const FAKE_DFHACK_SOURCE = path.join(tmp, "dfhack-source");
writeFileSync(path.join(FAKE_BUILD, "CMakeCache.txt"),
  `CMAKE_HOME_DIRECTORY:INTERNAL=${FAKE_DFHACK_SOURCE}\n`);

console.log("# dfroot resolver");

console.log("\n## candidate list (pure, no disk)");
check("the fixed candidates are RELATIVE tails cross-producted with drives", () => {
  const c = steamDfCandidates(["Q"]);
  assert.ok(c.length >= 5, "expected the usual Steam tails");
  assert.ok(c.every((p) => /^Q:\\/.test(p)), "every candidate must be on the requested drive");
  assert.ok(c.some((p) => p.endsWith("SteamLibrary\\steamapps\\common\\Dwarf Fortress")));
});
check("Steam's libraryfolders.vdf is parsed into candidates (finds drives we never guess)", () => {
  const vdf = 'X:\\lf.vdf';
  const text = '"libraryfolders"{"0"{"path"\t\t"Z:\\\\Weird Place\\\\Steam"}}';
  const out = steamLibraryDfCandidates((p) => p === vdf, () => text, [vdf]);
  assert.deepEqual(out, [path.join("Z:\\Weird Place\\Steam", "steamapps", "common", "Dwarf Fortress")]);
});
check("vdf candidates come BEFORE the fixed guesses", () => {
  const all = dfCandidates(() => false);   // no vdf on disk -> just the fixed list
  assert.equal(all[0], steamDfCandidates()[0]);
});

console.log("\n## what counts as an install");
check("a DF root is the exe OR data/vanilla (raws are all most tools need)", () => {
  assert.equal(isDfRoot(FAKE), true);
  assert.equal(isDfRoot(NOT_DF), false);
  assert.equal(isDfRoot(null), false);
});
check("autodetect prefers a DFHack-complete install over a bare one", () => {
  const bare = "A:\\bare", full = "B:\\full";
  const present = new Set([bare, path.join(bare, "Dwarf Fortress.exe"),
                           full, path.join(full, "Dwarf Fortress.exe"),
                           path.join(full, "hack"), path.join(full, "hack", "plugins")]);
  assert.equal(autodetectDfRoot([bare, full], (p) => present.has(p)), full,
    "the bare install is listed first, but the DFHack one must win");
});
check("autodetect returns null when nothing is there", () => {
  assert.equal(autodetectDfRoot(["A:\\x"], () => false), null);
});

console.log("\n## precedence: --df-root > $DWF_DF_ROOT > autodetect > nothing");
check("--df-root wins over the environment", () => {
  const r = resolveDfRoot({ argv: ["--df-root", FAKE], env: { DWF_DF_ROOT: NOT_DF } });
  assert.equal(r.root, FAKE);
  assert.equal(r.explicit, true);
});
check("--df-root=<v> form works too", () => {
  assert.equal(resolveDfRoot({ argv: [`--df-root=${FAKE}`], env: {} }).root, FAKE);
});
check("the legacy --df flag is still honoured (many tools already shipped it)", () => {
  assert.equal(resolveDfRoot({ argv: ["--df", FAKE], env: {} }).root, FAKE);
});
check("$DWF_DF_ROOT wins over the legacy env names", () => {
  const r = resolveDfRoot({ argv: [], env: { DF_ROOT: NOT_DF, DWF_DF_ROOT: FAKE } });
  assert.equal(r.root, FAKE);
  assert.equal(r.source, "$DWF_DF_ROOT");
});
check("the legacy $DFCAPTURE_DF_ROOT / $DF_ROOT still resolve", () => {
  assert.equal(resolveDfRoot({ argv: [], env: { DFCAPTURE_DF_ROOT: FAKE } }).root, FAKE);
  assert.equal(resolveDfRoot({ argv: [], env: { DF_ROOT: FAKE } }).root, FAKE);
});
check("an EXPLICIT-BUT-WRONG root resolves to null -- it NEVER autodetects past you", () => {
  const r = resolveDfRoot({ argv: ["--df-root", "Q:\\nope"], env: {} });
  assert.equal(r.root, null, "silently substituting a different install is the bug we are killing");
  assert.equal(r.explicit, true);
});
check("no flag, no env, nothing on disk -> null, and the message says what to pass", () => {
  const r = resolveDfRoot({ argv: [], env: {}, exists: () => false });
  assert.equal(r.root, null);
  const msg = missingDfMessage(r, "reads the raws");
  assert.match(msg, /--df-root/);
  assert.match(msg, /DWF_DF_ROOT/);
  assert.match(msg, /reads the raws/);
  assert.match(msg, /Looked in:/);
});

console.log("\n## dfhack-run");
check("dfhack-run lives in hack/, not at the DF root", () => {
  assert.equal(dfhackRun(FAKE), path.join(FAKE, "hack", "dfhack-run.exe"));
});
check("defaultDfhackRun is non-fatal with no install (the live oracles must still import)", () => {
  const saved = { ...process.env };
  delete process.env.DFHACK_RUN;
  process.env.DWF_DF_ROOT = "Q:\\nope";
  const v = defaultDfhackRun();
  assert.equal(v, "", "no install -> empty string, never a throw and never a foreign path");
  process.env = saved;
});

console.log("\n## W22 DFHack build tree: --dfhack-build > $DWF_DFHACK_BUILD > autodetect > nothing");
check("build candidates are workspace/ancestor-relative, not one developer's absolute path", () => {
  const candidates = dfhackBuildCandidates(path.join(tmp, "project"));
  assert.ok(candidates.includes(path.join(tmp, "dfhack", "build-msvc")));
});
check("autodetect recognizes CMakeCache.txt", () => {
  assert.equal(autodetectDfhackBuild([NOT_DF, FAKE_BUILD]), FAKE_BUILD);
});
check("--dfhack-build wins over the environment and is authoritative", () => {
  const r = resolveDfhackBuild({ argv: ["--dfhack-build", FAKE_BUILD],
    env: { DWF_DFHACK_BUILD: NOT_DF }, candidates: [NOT_DF] });
  assert.equal(r.root, FAKE_BUILD);
  assert.equal(r.source, "--dfhack-build");
  assert.equal(r.explicit, true);
});
check("$DWF_DFHACK_BUILD wins over autodetect", () => {
  const r = resolveDfhackBuild({ argv: [], env: { DWF_DFHACK_BUILD: FAKE_BUILD },
    candidates: [NOT_DF] });
  assert.equal(r.root, FAKE_BUILD);
  assert.equal(r.source, "$DWF_DFHACK_BUILD");
});
check("wrong explicit build never falls through, and failure names both overrides", () => {
  const r = resolveDfhackBuild({ argv: ["--dfhack-build", path.join(tmp, "missing")], env: {},
    candidates: [FAKE_BUILD] });
  assert.equal(r.root, null);
  assert.equal(r.explicit, true);
  const msg = missingDfhackBuildMessage(r);
  assert.match(msg, /--dfhack-build/);
  assert.match(msg, /DWF_DFHACK_BUILD/);
});
check("built DLL path is derived from the resolved build root", () => {
  assert.equal(builtDfcaptureDll(FAKE_BUILD), path.join(FAKE_BUILD, "plugins", "external",
    "multi-dwarf", "Release", "dwf.plug.dll"));
});
check("DFHack source root comes from CMakeCache (out-of-tree builds need not be siblings)", () => {
  assert.equal(dfhackSourceRoot(FAKE_BUILD), FAKE_DFHACK_SOURCE);
});

// ---------------------------------------------------------------- CROSS-LANGUAGE PARITY
// Two languages, one policy. If these drift, "the single resolver" is a lie.
console.log("\n## Node <-> Python parity (one policy, two implementations)");

function py(code) {
  return execFileSync("python", ["-c",
    `import sys, json; sys.path.insert(0, r"${PY_LIB}")\nimport dfroot\n${code}`],
    { encoding: "utf8" }).trim();
}

let pyOk = true;
try { py("print('hi')"); } catch { pyOk = false; }

if (!pyOk) {
  console.log("  SKIP - no `python` on PATH; the Node half was still fully checked above.");
} else {
  check("the fixed candidate lists are IDENTICAL", () => {
    const node = steamDfCandidates(["C", "D"]);
    const pyOut = JSON.parse(py('print(json.dumps(dfroot.steam_df_candidates(["C","D"])))'));
    assert.deepEqual(pyOut, node, "the two candidate tables have drifted apart");
  });
  check("the env-var names and flag names are IDENTICAL", () => {
    assert.deepEqual(JSON.parse(py("print(json.dumps(dfroot.ENV_VARS))")), ENV_VARS);
    assert.deepEqual(JSON.parse(py("print(json.dumps(dfroot.FLAGS))")), FLAGS);
  });
  check("the DFHack-build env/flag names and candidate lists are IDENTICAL", () => {
    assert.deepEqual(JSON.parse(py("print(json.dumps(dfroot.DFHACK_BUILD_ENV_VARS))")), DFHACK_BUILD_ENV_VARS);
    assert.deepEqual(JSON.parse(py("print(json.dumps(dfroot.DFHACK_BUILD_FLAGS))")), DFHACK_BUILD_FLAGS);
    const node = dfhackBuildCandidates(tmp);
    const pyOut = JSON.parse(py(`print(json.dumps(dfroot.dfhack_build_candidates(r"${tmp}")))`));
    assert.deepEqual(pyOut, node);
  });
  check("both resolve --dfhack-build to the same answer", () => {
    const p = py(`r = dfroot.resolve_dfhack_build(argv=["--dfhack-build", r"${FAKE_BUILD}"], env={})\nprint(r[0] or "")`);
    assert.equal(p, resolveDfhackBuild({ argv: ["--dfhack-build", FAKE_BUILD], env: {} }).root);
  });
  check("both resolve --df-root to the same answer", () => {
    const p = py(`r = dfroot.resolve_df_root(argv=["--df-root", r"${FAKE}"], env={})\nprint(r[0] or "")`);
    assert.equal(p, resolveDfRoot({ argv: ["--df-root", FAKE], env: {} }).root);
  });
  check("both refuse an explicit-but-wrong root the same way (null/empty, no substitution)", () => {
    const p = py('r = dfroot.resolve_df_root(argv=["--df-root", r"Q:\\nope"], env={})\nprint((r[0] or "") + "|" + str(r[2]))');
    assert.equal(p, "|True");
    const n = resolveDfRoot({ argv: ["--df-root", "Q:\\nope"], env: {} });
    assert.equal(n.root, null);
    assert.equal(n.explicit, true);
  });
  check("both agree on what a DF install IS", () => {
    assert.equal(py(`print(dfroot.is_df_root(r"${FAKE}"))`), "True");
    assert.equal(py(`print(dfroot.is_df_root(r"${NOT_DF}"))`), "False");
    assert.equal(isDfRoot(FAKE), true);
    assert.equal(isDfRoot(NOT_DF), false);
  });
  check("both put dfhack-run in hack/", () => {
    assert.equal(py(`print(dfroot.dfhack_run(r"${FAKE}"))`), dfhackRun(FAKE));
  });
  check("both agree on THIS machine (whatever it has, or has not)", () => {
    const p = py("print(dfroot.resolve_df_root(argv=[], env={})[0] or '')");
    const n = resolveDfRoot({ argv: [], env: {} }).root || "";
    assert.equal(p, n, "the two resolvers disagree about this very machine");
    console.log(`         (both resolved: ${n || "<no DF install>"})`);
  });
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exit(failed ? 1 : 0);
