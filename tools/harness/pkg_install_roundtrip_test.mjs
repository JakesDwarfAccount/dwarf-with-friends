// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// pkg_install_roundtrip_test.mjs -- the installer ROUND-TRIP fixture test. This is the coverage
// that was MISSING when the plugin identity was split dfcapture.* -> dwf.*: build_zip.mjs shipped a
// dwf.* release while the installer still expected dfcapture.*, and nothing drove the two together,
// so the drift went uncaught. This suite drives the REAL host/install.mjs end-to-end against the
// FIXED name contract and proves the whole round trip: reject the wrong release, deploy to the
// dwf.* target paths, quarantine every stale old-named artifact, stay idempotent, and fresh-install
// cleanly. Everything lives in throwaway temp dirs -- NO real DF install is ever touched.
//
//   node tools/harness/pkg_install_roundtrip_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// TARGET NAME CONTRACT (fixed for the packaging wave; web root name adjudicated by pkg-host):
//   release/dwf.plug.dll, release/dwf.lua, release/gui/dwf.lua, release/web/**
//   deploy -> hack/plugins/dwf.plug.dll
//             hack/lua/plugins/dwf.lua        (the REAL path the plugin require()s)
//             hack/scripts/dwf.lua            (scripts mirror)
//             hack/scripts/gui/dwf.lua        (gui mirror, NEW manifest entry)
//             hack/dfcapture-web/**           (served web root -- name UNCHANGED this wave; the C++
//                                              kWebRoot stays "hack/dfcapture-web", W9 does not
//                                              rename it, so the installer keeps deploying there)
//
// STALE-ARTIFACT CONTRACT (what a prior dfcapture.* install left that must be quarantined/removed):
//   REMOVE:   hack/plugins/dfcapture.plug.dll (+ dfcapture.plug.dll.* clutter),
//             hack/lua/plugins/dfcapture.lua, hack/scripts/dfcapture.lua,
//             hack/scripts/gui/dfcapture.lua, and DELETE hack/dfcapture-web.old/
//   PRESERVE: the LIVE hack/dfcapture-web/ web root (it is the deploy target, NOT stale) -- the
//             important negative assertion, since a naive "remove everything dfcapture*" would wrongly
//             delete the served web root. receipt.staleRemoved records the removals; a second run
//             records an EMPTY staleRemoved (idempotency).
//
// STANDALONE vs POST-MERGE. The dwf.* renames live on sibling lanes (pkg-rename: src/CMake/lua;
// pkg-host: host/hostlib resolveManifest + install.mjs checkRelease + stale removal). On this
// unmerged base the shipped host/ is still dfcapture.*, so the live battery against the REAL host
// is POST-MERGE-ONLY and reported as SKIP (never a FAIL) -- exactly the sb-tests pattern. To PROVE
// those SKIPped assertions actually pass once the siblings land, the suite ALSO builds a merged-state
// OVERLAY of host/ (the real installer with the contracted dwf.* renames + the gui manifest entry +
// stale-artifact quarantine applied) in a temp dir and runs the FULL battery, plus the test-the-test
// guards, against it. Overlay results are labelled [overlay-sim].
//
// Zero external dependencies. Node >= 18. Part of Dwarf With Friends (dwf).

import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_HOST = path.join(here, "..", "..", "host");

let passed = 0, failed = 0, skipped = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function guard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}
function skipPM(name, why) {
  skipped++; console.log(`  SKIP - (post-merge-only) ${name}${why ? "  -- " + why : ""}`);
}

const TMP = mkdtempSync(path.join(os.tmpdir(), "dwf-roundtrip-"));
function tmp(sub) { const p = path.join(TMP, sub); mkdirSync(p, { recursive: true }); return p; }
const j = path.join;

// -------------------------------------------------------------------- contract
// Deploy destinations under <dfRoot> the merged installer MUST produce (relative).
const EXPECT_DESTS = [
  j("hack", "plugins", "dwf.plug.dll"),
  j("hack", "lua", "plugins", "dwf.lua"),
  j("hack", "scripts", "dwf.lua"),
  j("hack", "scripts", "gui", "dwf.lua"),
  j("hack", "dfcapture-web"),   // web root name UNCHANGED this wave
];

// The old-named artifacts a prior dfcapture.* install left that MUST be removed. The live web root
// hack/dfcapture-web/ is deliberately NOT here -- it is the deploy target and must be preserved.
const STALE_RELS = [
  j("hack", "plugins", "dfcapture.plug.dll"),
  j("hack", "plugins", "dfcapture.plug.dll.bak"),
  j("hack", "lua", "plugins", "dfcapture.lua"),
  j("hack", "scripts", "dfcapture.lua"),
  j("hack", "scripts", "gui", "dfcapture.lua"),
  j("hack", "dfcapture-web.old"),
];

// -------------------------------------------------------------- fixture builders
// A fake DFHack install. withOld => pre-seed the OLD dfcapture.* artifacts that a prior
// install left behind, plus .bak clutter and a dfcapture-web.old/ directory.
function seedDfRoot(dir, { withOld }) {
  writeFileSync(j(dir, "Dwarf Fortress.exe"), "MZ");
  mkdirSync(j(dir, "hack", "plugins"), { recursive: true });
  mkdirSync(j(dir, "hack", "lua", "plugins"), { recursive: true });
  mkdirSync(j(dir, "hack", "scripts", "gui"), { recursive: true });
  if (withOld) {
    writeFileSync(j(dir, "hack", "plugins", "dfcapture.plug.dll"), "OLD-DLL");
    writeFileSync(j(dir, "hack", "plugins", "dfcapture.plug.dll.bak"), "OLD-DLL-BAK");
    writeFileSync(j(dir, "hack", "lua", "plugins", "dfcapture.lua"), "-- old lua\n");
    writeFileSync(j(dir, "hack", "scripts", "dfcapture.lua"), "-- old mirror lua\n");
    writeFileSync(j(dir, "hack", "scripts", "gui", "dfcapture.lua"), "-- old gui lua\n");
    mkdirSync(j(dir, "hack", "dfcapture-web", "js"), { recursive: true });
    writeFileSync(j(dir, "hack", "dfcapture-web", "index.html"), "<html>old</html>\n");
    writeFileSync(j(dir, "hack", "dfcapture-web", "js", "client.js"), "old();\n");
    mkdirSync(j(dir, "hack", "dfcapture-web.old"), { recursive: true });
    writeFileSync(j(dir, "hack", "dfcapture-web.old", "stale.txt"), "stale\n");
  }
  return dir;
}

// A well-formed dwf.* release (the fixed contract).
function makeDwfRelease(dir) {
  writeFileSync(j(dir, "dwf.plug.dll"), "NEW-DLL-v1");
  writeFileSync(j(dir, "dwf.lua"), "-- dwf lua v1\n");
  mkdirSync(j(dir, "gui"), { recursive: true });
  writeFileSync(j(dir, "gui", "dwf.lua"), "-- dwf gui lua v1\n");
  mkdirSync(j(dir, "web", "js"), { recursive: true });
  writeFileSync(j(dir, "web", "index.html"), "<html>v1</html>\n");
  writeFileSync(j(dir, "web", "js", "client.js"), "client();\n");
  writeFileSync(j(dir, "VERSION.txt"), "1.0.0-test\n");
  return dir;
}

// The WRONG release: only old dfcapture.* names. A contract-correct checkRelease must reject it.
function makeOldRelease(dir) {
  writeFileSync(j(dir, "dfcapture.plug.dll"), "OLD-DLL-v1");
  writeFileSync(j(dir, "dfcapture.lua"), "-- old lua v1\n");
  mkdirSync(j(dir, "web"), { recursive: true });
  writeFileSync(j(dir, "web", "index.html"), "<html>old</html>\n");
  return dir;
}

// Drive the REAL (or overlaid) host/install.mjs. Returns parsed --json output; install.mjs exits 3
// on refusal, whose stdout still carries the JSON, so capture both paths.
function runInstall(hostDir, args, backupRoot, extraEnv = {}) {
  const INSTALL = j(hostDir, "install.mjs");
  // Fixtures use FAKE DF roots; pin the DF-running pre-flight OFF so a real game running on the dev
  // machine cannot refuse these installs. The cold-start test overrides via extraEnv.
  const env = { ...process.env, DWF_BACKUP_ROOT: backupRoot, DWF_ASSUME_DF_RUNNING: "0", ...extraEnv };
  try {
    const outv = execFileSync(process.execPath, [INSTALL, ...args, "--json"], { env, stdio: "pipe" });
    return JSON.parse(outv.toString());
  } catch (e) {
    if (e.stdout) { try { return JSON.parse(e.stdout.toString()); } catch { /* fall through */ } }
    throw e;
  }
}

// Which of the known STALE artifacts still exist under dfRoot (relative). Excludes the live web
// root by construction, so a preserved hack/dfcapture-web/ never reads as "stale".
function stillStale(dfRoot) {
  return STALE_RELS.filter((rel) => existsSync(j(dfRoot, rel)));
}

// Import a host's resolveManifest (the two lanes' target for the deploy map).
async function hostResolveManifest(hostDir) {
  const mod = await import(pathToFileURL(j(hostDir, "hostlib.mjs")).href + `?t=${Date.now()}`);
  return mod.resolveManifest;
}

// ------------------------------------------------------ merged-state overlay builder
// Copy the real host/ tree and apply the contracted transforms the sibling lanes will land:
//   (1) global rename of the three artifact identities dfcapture.* -> dwf.* (pkg-rename/pkg-host),
//   (2) a gui manifest entry release/gui/dwf.lua -> hack/scripts/gui/dwf.lua (pkg-host),
//   (3) stale-artifact quarantine of every old dfcapture.* under hack/ (pkg-host).
// Each structural patch asserts its anchor was found so a silent no-op cannot fake a green overlay.
function buildMergedOverlay(destDir) {
  cpSync(REAL_HOST, destDir, { recursive: true });

  // Only the dll/lua identity literals move to dwf.*; the web root name (dfcapture-web) is UNCHANGED
  // this wave, so it is deliberately NOT renamed here.
  const rename = (s) => s
    .replace(/dfcapture\.plug\.dll/g, "dwf.plug.dll")
    .replace(/dfcapture\.lua/g, "dwf.lua");

  // hostlib.mjs: rename + insert the gui entry ahead of the (unchanged) web entry.
  const hostlibPath = j(destDir, "hostlib.mjs");
  let hostlib = rename(readFileSync(hostlibPath, "utf8"));
  const webAnchor =
    `    { role: "web", kind: "dir",\n` +
    `      src: j(releaseDir, "web"),\n` +
    `      dest: j(dfRoot, "hack", "dfcapture-web") },`;
  if (!hostlib.includes(webAnchor)) throw new Error("overlay: resolveManifest web anchor not found (formatting drift)");
  const guiEntry =
    `    { role: "lua-gui", kind: "file",\n` +
    `      src: j(releaseDir, "gui", "dwf.lua"),\n` +
    `      dest: j(dfRoot, "hack", "scripts", "gui", "dwf.lua") },\n`;
  hostlib = hostlib.replace(webAnchor, guiEntry + webAnchor);
  writeFileSync(hostlibPath, hostlib);

  // install.mjs: rename + widen the fs import + inject stale-artifact quarantine after the copy loop.
  const installPath = j(destDir, "install.mjs");
  let install = rename(readFileSync(installPath, "utf8"));
  const importAnchor = `import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";`;
  if (!install.includes(importAnchor)) throw new Error("overlay: install.mjs fs import anchor not found");
  install = install.replace(importAnchor,
    `import { existsSync, statSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync } from "node:fs";`);

  const bakeAnchor = `  // W11: bake the composite sprites from THIS install's own DF art into the`;
  if (!install.includes(bakeAnchor)) throw new Error("overlay: install.mjs sprite-bake anchor not found");
  const staleBlock =
    `  // MERGED-CONTRACT stale-artifact quarantine (simulates pkg-host): move the old dfcapture.*\n` +
    `  // plugin/lua artifacts + dfcapture-web.old/ out of hack/ so DFHack cannot load two competing\n` +
    `  // copies. The LIVE hack/dfcapture-web/ web root is preserved (it is the deploy target).\n` +
    `  const staleRemoved = removeStaleArtifacts(dfRoot, backupDir);\n\n`;
  install = install.replace(bakeAnchor, staleBlock + bakeAnchor);

  // Record the removals on the receipt (contract: receipt.staleRemoved).
  const receiptAnchor = `  receipt.spriteBake = { ok: bake.ok, written: bake.written, problems: bake.problems };`;
  if (!install.includes(receiptAnchor)) throw new Error("overlay: install.mjs receipt anchor not found");
  install = install.replace(receiptAnchor, receiptAnchor + `\n  receipt.staleRemoved = staleRemoved;`);

  // Append the helper before the trailing main() call.
  const mainAnchor = `\nmain();\n`;
  if (!install.includes(mainAnchor)) throw new Error("overlay: install.mjs main() anchor not found");
  const helper =
    `\nfunction removeStaleArtifacts(dfRoot, backupDir) {\n` +
    `  const targets = [\n` +
    `    path.join("hack", "plugins", "dfcapture.plug.dll"),\n` +
    `    path.join("hack", "lua", "plugins", "dfcapture.lua"),\n` +
    `    path.join("hack", "scripts", "dfcapture.lua"),\n` +
    `    path.join("hack", "scripts", "gui", "dfcapture.lua"),\n` +
    `    path.join("hack", "dfcapture-web.old"),\n` +
    `  ];\n` +
    `  // dfcapture.plug.dll.* clutter (e.g. .bak) beside the old dll -- but never the live web root.\n` +
    `  const pluginsDir = path.join(dfRoot, "hack", "plugins");\n` +
    `  if (existsSync(pluginsDir)) for (const e of readdirSync(pluginsDir))\n` +
    `    if (/^dfcapture\\.plug\\.dll(\\..+)?$/i.test(e)) targets.push(path.join("hack", "plugins", e));\n` +
    `  const removed = [];\n` +
    `  for (const rel of [...new Set(targets)]) {\n` +
    `    const p = path.join(dfRoot, rel);\n` +
    `    if (!existsSync(p)) continue;\n` +
    `    const q = path.join(backupDir, "_stale", rel);\n` +
    `    mkdirSync(path.dirname(q), { recursive: true });\n` +
    `    try { renameSync(p, q); }\n` +
    `    catch { copyTree(p, q, () => {}); rmSync(p, { recursive: true, force: true }); }\n` +
    `    removed.push(rel);\n` +
    `  }\n` +
    `  return removed;\n` +
    `}\n`;
  install = install.replace(mainAnchor, helper + mainAnchor);
  writeFileSync(installPath, install);

  return destDir;
}

// ---------------------------------------------------- the round-trip battery (a-e)
// Requires a host on the dwf.* contract. Runs live assertions + the (a)/(c) test-the-test guards.
async function battery(hostDir, tag) {
  const L = (s) => `${s} ${tag}`;
  const resolveManifest = await hostResolveManifest(hostDir);

  // (b) resolveManifest deploys to the dwf.* target paths.
  {
    const m = resolveManifest("D:\\DF", "R:\\rel");
    const dests = m.map((e) => path.relative("D:\\DF", e.dest));
    for (const want of EXPECT_DESTS) {
      check(L(`(b) resolveManifest maps a target -> ${want}`), dests.includes(want),
        `got: ${dests.join(", ")}`);
    }
    const srcs = m.filter((e) => e.kind === "file").map((e) => path.basename(e.src));
    guard(L("(b) manifest carries no dfcapture.* source name"),
      !srcs.some((s) => /dfcapture/i.test(s)), `srcs: ${srcs.join(", ")}`);
  }

  // (a) checkRelease REJECTS a dfcapture.*-only release, and (guard) ACCEPTS the dwf.* release.
  {
    const backupRoot = tmp(`${tag}-a-backup`);
    const df = seedDfRoot(tmp(`${tag}-a-df`), { withOld: false });
    const oldRel = makeOldRelease(tmp(`${tag}-a-oldrel`));
    const rej = runInstall(hostDir, ["--df-root", df, "--release", oldRel, "--yes"], backupRoot);
    check(L("(a) a dfcapture.*-only release is REJECTED"),
      rej.ok === false && rej.stage === "release" &&
      (rej.problems || []).some((p) => /dwf\.plug\.dll|dwf\.lua/i.test(p)),
      JSON.stringify(rej.problems || rej.stage));

    const dwfRel = makeDwfRelease(tmp(`${tag}-a-dwfrel`));
    const acc = runInstall(hostDir, ["--df-root", df, "--release", dwfRel, "--yes"], backupRoot);
    guard(L("(a) the SAME checkRelease ACCEPTS a proper dwf.* release"),
      acc.ok === true && acc.stage === "installed", JSON.stringify(acc.stage || acc.problems));
  }

  // (c) stale-artifact removal quarantines every old-named artifact + (b) deploy landed + live
  // web root preserved.
  {
    const backupRoot = tmp(`${tag}-c-backup`);
    const df = seedDfRoot(tmp(`${tag}-c-df`), { withOld: true });
    const rel = makeDwfRelease(tmp(`${tag}-c-rel`));
    const before = stillStale(df);
    guard(L("(c) fixture actually seeded the old dfcapture.* artifacts"), before.length === STALE_RELS.length,
      `seeded: ${before.join(", ")}`);
    const res = runInstall(hostDir, ["--df-root", df, "--release", rel, "--yes"], backupRoot);
    check(L("(c) install succeeds on a dirty (old-artifact) install"), res.ok === true);
    // dwf.* deployed to every target path...
    for (const want of EXPECT_DESTS) {
      check(L(`(b) deployed file present -> ${want}`), existsSync(j(df, want)), "");
    }
    // ...every known stale artifact is gone (removed or quarantined)...
    const after = stillStale(df);
    check(L("(c) every old dfcapture.* artifact removed after install"),
      after.length === 0, `still present: ${after.join(", ")}`);
    // ...the LIVE web root is PRESERVED and now holds the freshly-deployed client (negative assert)...
    check(L("(c) LIVE hack/dfcapture-web/ preserved and re-deployed (not quarantined)"),
      existsSync(j(df, "hack", "dfcapture-web", "index.html")) &&
      readFileSync(j(df, "hack", "dfcapture-web", "index.html"), "utf8") === "<html>v1</html>\n");
    // ...and the receipt records exactly the removals.
    check(L("(c) receipt.staleRemoved records the removals"),
      Array.isArray(res.receipt?.staleRemoved) && res.receipt.staleRemoved.length === STALE_RELS.length,
      JSON.stringify(res.receipt?.staleRemoved));

    // (d) idempotent second run: still ok, still clean, and staleRemoved is now EMPTY.
    const res2 = runInstall(hostDir, ["--df-root", df, "--release", rel, "--yes"], backupRoot);
    check(L("(d) idempotent second run stays ok"), res2.ok === true);
    check(L("(d) second run leaves no stale artifacts"), stillStale(df).length === 0);
    check(L("(d) second run records an EMPTY receipt.staleRemoved (idempotency)"),
      Array.isArray(res2.receipt?.staleRemoved) && res2.receipt.staleRemoved.length === 0,
      JSON.stringify(res2.receipt?.staleRemoved));
  }

  // (c) test-the-test: the SAME stillStale assertion must FIRE when nothing removed the artifacts.
  // Seed old artifacts, never run the installer, and confirm the check would have caught it.
  {
    const df = seedDfRoot(tmp(`${tag}-c-negcontrol`), { withOld: true });
    guard(L("(c) stillStale DETECTS un-removed artifacts (guard is not vacuous)"),
      stillStale(df).length === STALE_RELS.length);
  }

  // (e) fresh install: a clean DF root (no old artifacts) deploys cleanly and quarantines nothing.
  {
    const backupRoot = tmp(`${tag}-e-backup`);
    const df = seedDfRoot(tmp(`${tag}-e-df`), { withOld: false });
    const rel = makeDwfRelease(tmp(`${tag}-e-rel`));
    const res = runInstall(hostDir, ["--df-root", df, "--release", rel, "--yes"], backupRoot);
    check(L("(e) fresh install (no old artifacts) succeeds"), res.ok === true && res.stage === "installed");
    for (const want of EXPECT_DESTS) {
      check(L(`(e) fresh deploy present -> ${want}`), existsSync(j(df, want)), "");
    }
    check(L("(e) fresh install removes nothing (empty receipt.staleRemoved)"),
      Array.isArray(res.receipt?.staleRemoved) && res.receipt.staleRemoved.length === 0);
    check(L("(e) fresh install leaves no stale artifact"), stillStale(df).length === 0);
  }

  // (f) cold-start guard: a running Dwarf Fortress is refused up front with a friendly message,
  // BEFORE any copy touches the locked plugin dll. Forced via DWF_ASSUME_DF_RUNNING=1.
  {
    const backupRoot = tmp(`${tag}-f-backup`);
    const df = seedDfRoot(tmp(`${tag}-f-df`), { withOld: false });
    const rel = makeDwfRelease(tmp(`${tag}-f-rel`));
    const res = runInstall(hostDir, ["--df-root", df, "--release", rel, "--yes"], backupRoot,
      { DWF_ASSUME_DF_RUNNING: "1" });
    check(L("(f) DF-running install is refused with a friendly, stack-free message"),
      res.ok === false && res.stage === "df-running" &&
      /Dwarf Fortress is running/i.test(res.error) && !/copyfile|copyTree|EBUSY/i.test(res.error),
      JSON.stringify(res.stage || res.error));
    guard(L("(f) the refusal fired BEFORE any copy -- dwf.plug.dll not deployed"),
      !existsSync(j(df, "hack", "plugins", "dwf.plug.dll")));
  }
}

// ------------------------------------------------------------------------ run
try {
  console.log("# host/install.mjs node --check");
  for (const f of ["install.mjs", "hostlib.mjs"]) {
    try { execFileSync(process.execPath, ["--check", j(REAL_HOST, f)], { stdio: "pipe" });
      check(`host/${f} passes node --check`, true); }
    catch (e) { check(`host/${f} passes node --check`, false, e.stderr ? e.stderr.toString() : e.message); }
  }

  console.log("\n# real host contract probe");
  const realResolve = await hostResolveManifest(REAL_HOST);
  const realManifest = realResolve("D:\\DF", "R:\\rel");
  const realDll = realManifest.find((e) => e.role === "dll");
  const realOnDwf = !!realDll && /dwf\.plug\.dll$/.test(realDll.src);
  console.log(`  real host/hostlib.mjs resolveManifest dll src basename: ${path.basename(realDll.src)}`);
  check("real host resolveManifest is importable and returns a dll entry", !!realDll);

  if (realOnDwf) {
    console.log("\n# LIVE battery against the REAL merged host");
    await battery(REAL_HOST, "[real]");
  } else {
    console.log("\n# LIVE battery against the REAL host -> POST-MERGE-ONLY (base host still dfcapture.*)");
    for (const item of [
      "(a) checkRelease rejects dfcapture-only / accepts dwf release",
      "(b) resolveManifest deploys to dwf.* target paths",
      "(c) stale dfcapture.* artifacts quarantined",
      "(d) idempotent second run",
      "(e) fresh install",
    ]) skipPM(item, "needs pkg-host (hostlib resolveManifest + install.mjs checkRelease + stale removal)");
  }

  // The overlay-sim only makes sense on an UNMERGED base: it applies the base->merged transforms to
  // prove the SKIPped battery passes post-merge. On an already-merged tree the anchors are gone (the
  // transforms would throw) AND the [real] battery above already exercises the merged state, so the
  // sim is redundant -- skip it.
  if (!realOnDwf) {
    console.log("\n# [overlay-sim] merged-state proof (real host/ + contracted dwf.* transforms)");
    const overlay = buildMergedOverlay(tmp("overlay-host"));
    const ovResolve = await hostResolveManifest(overlay);
    const ovDll = ovResolve("D:\\DF", "R:\\rel").find((e) => e.role === "dll");
    guard("[overlay-sim] overlay host is on the dwf.* contract", /dwf\.plug\.dll$/.test(ovDll.src));
    await battery(overlay, "[overlay-sim]");
  } else {
    console.log("\n# [overlay-sim] skipped -- host is already merged; the [real] battery covers the merged state");
  }
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failed ? "FAIL" : "PASS"} pkg_install_roundtrip_test -- ${passed} passed, ${failed} failed, ${skipped} post-merge-only skipped`);
process.exit(failed ? 1 : 0);
