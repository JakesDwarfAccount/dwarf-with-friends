#!/usr/bin/env node
// tools/harness/deploy_integrity_check.mjs — deploy-integrity gate for dwf.
//
// Deploys here have repeatedly shipped stale or misplaced artifacts wearing
// fresh labels. This is the single command the orchestrator runs BEFORE and
// AFTER any deploy to catch that class of failure. Each worked example below
// is encoded as one check (see docs/superpowers/plans + registry
// TESTRIG-DEPLOY-INTEGRITY):
//
//   lua-path      — the plugin loads <DF>/hack/lua/plugins/dwf.lua; the installer
//                   also writes a mirror copy to <DF>/hack/scripts/dwf.lua. Compare
//                   repo lua vs the REAL plugins copy; warn if the scripts mirror
//                   has drifted from it.
//   mirror-sync   — the build mirror compiles mirror\src\*.cpp; files copied to
//                   the mirror ROOT compile into nothing while the stamp updates.
//                   Compare every repo src/* vs mirror\src\*; flag a mirror-ROOT
//                   .cpp/.h NEWER than its src\ twin (the root-copy trap in the act).
//   dll-witness   — a matching /version stamp proves nothing. Content-gate by
//                   grepping a witness string in the BUILT dll and the DEPLOYED dll.
//   web-sync      — hash-compare repo web/ vs <DF>/hack/dfcapture-web/.
//   buster-lockstep — JS/CSS changes need an index.html cache-buster bump; a code
//                   file that differs while index.html did not = shipped without a buster.
//   conflict-markers — a conflicted index.html once reached production.
//
// Zero external dependencies. Node >= 18. Part of Dwarf With Friends (dwf). License: AGPL-3.0-only.
//
// Usage:
//   node tools/harness/deploy_integrity_check.mjs [--witness <string>] [--df-root <path>]
//        [--dfhack-build <path>]
//        [--mirror <path>] [--built-dll <path>] [--json]
//   node tools/harness/deploy_integrity_check.mjs --selftest
//
// Exit 0 = every check PASS. Exit 1 = any check FAIL. INFO/SKIP never fail.

import {
  readFileSync, existsSync, statSync, readdirSync,
  mkdirSync, writeFileSync, rmSync, utimesSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  resolveDfRoot, resolveDfhackBuild, builtDfcaptureDll, dfhackSourceRoot,
  missingDfhackBuildMessage,
} from "../lib/dfroot.mjs";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// W1: resolved, never hardcoded. "" when no install is found -- the check then reports a
// missing DF root instead of silently gating a deploy against somebody else's machine.
const DEFAULT_DF_ROOT = resolveDfRoot().root || "";
const DEFAULT_DFHACK_BUILD = resolveDfhackBuild().root || "";
const DEFAULT_MIRROR = DEFAULT_DFHACK_BUILD
  ? path.join(dfhackSourceRoot(DEFAULT_DFHACK_BUILD), "plugins", "external", "multi-dwarf") : "";
const DEFAULT_BUILT_DLL = DEFAULT_DFHACK_BUILD ? builtDfcaptureDll(DEFAULT_DFHACK_BUILD) : "";

// Text extensions get line-ending + BOM normalization before hashing, because
// the web deploy rewrites CRLF->LF (inconsistently) and some files carry a BOM;
// neither is a real content change. Everything else is hashed raw (binary).
const TEXT_EXT = new Set([
  ".js", ".css", ".html", ".htm", ".lua", ".json",
  ".cpp", ".h", ".hpp", ".c", ".txt", ".md", ".svg",
]);

// ---------------------------------------------------------------- small utils

function parseArgs(argv) {
  const out = { witness: "", "df-root": "", "dfhack-build": "", mirror: "", "built-dll": "",
                json: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--selftest") out.selftest = true;
    else if (a === "--witness") out.witness = argv[++i] ?? "";
    else if (a === "--df-root") out["df-root"] = argv[++i] ?? "";
    else if (a.startsWith("--df-root=")) out["df-root"] = a.slice("--df-root=".length);
    else if (a === "--dfhack-build") out["dfhack-build"] = argv[++i] ?? "";
    else if (a.startsWith("--dfhack-build=")) out["dfhack-build"] = a.slice("--dfhack-build=".length);
    else if (a === "--mirror") out.mirror = argv[++i] ?? "";
    else if (a === "--built-dll") out["built-dll"] = argv[++i] ?? "";
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function isText(p) { return TEXT_EXT.has(path.extname(p).toLowerCase()); }

// FNV-1a over a buffer -> hex. Good enough for equality; zero-dep, fast.
function fnv1a(buf) {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Strip a leading UTF-8 BOM and all CR bytes for text; raw for binary.
function normalize(buf, textual) {
  if (!textual) return buf;
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  // Remove CR (0x0d). Fast path: if none present, return as-is.
  if (b.indexOf(0x0d) === -1) return b;
  const out = Buffer.allocUnsafe(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] !== 0x0d) out[n++] = b[i];
  return out.subarray(0, n);
}

function contentHash(p) {
  return fnv1a(normalize(readFileSync(p), isText(p)));
}

// Fast equality: raw bytes first (cheap), fall back to normalized compare so a
// CRLF/LF-or-BOM-only difference does not read as "stale".
function sameContent(a, b) {
  const ba = readFileSync(a), bb = readFileSync(b);
  if (ba.equals(bb)) return true;
  const t = isText(a);
  return normalize(ba, t).equals(normalize(bb, t));
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Byte-search a haystack buffer for a witness string in both narrow (latin1)
// and wide (utf16le) encodings — MSVC uses narrow literals, but wide is cheap
// insurance.
function bufHasString(hay, needle) {
  if (hay.includes(Buffer.from(needle, "latin1"))) return true;
  if (hay.includes(Buffer.from(needle, "utf16le"))) return true;
  return false;
}

// -------------------------------------------------------------- check helpers
// Each check returns { name, status: PASS|FAIL|INFO|SKIP, lines:[], fix:"" }.
// A result is a FAIL iff status === "FAIL".

function mk(name) { return { name, status: "PASS", lines: [], fix: "" }; }
function fail(r, fix) { r.status = "FAIL"; if (fix) r.fix = fix; }

// ---- 1. lua-path ----------------------------------------------------------
function checkLuaPath(ctx) {
  const r = mk("lua-path");
  const repoLua = path.join(ctx.repo, "dwf.lua");
  const realLua = path.join(ctx.dfRoot, "hack", "lua", "plugins", "dwf.lua");
  const mirrorLua = path.join(ctx.dfRoot, "hack", "scripts", "dwf.lua");

  if (!existsSync(repoLua)) { fail(r, "repo dwf.lua missing"); r.lines.push(`MISSING repo: ${repoLua}`); return r; }
  if (!existsSync(realLua)) {
    fail(r, `copy repo dwf.lua -> ${realLua}`);
    r.lines.push(`MISSING deployed (the REAL path): ${realLua}`);
    return r;
  }
  if (!sameContent(repoLua, realLua)) {
    fail(r, `copy repo dwf.lua -> hack\\lua\\plugins\\dwf.lua (NOT hack\\scripts\\)`);
    r.lines.push(`STALE: hack/lua/plugins/dwf.lua differs from repo (repo=${contentHash(repoLua)} deployed=${contentHash(realLua)})`);
  } else {
    r.lines.push(`ok: hack/lua/plugins/dwf.lua matches repo (${contentHash(repoLua)})`);
  }

  // Drift between the two deployed copies => the scripts mirror was written out of lockstep.
  if (existsSync(mirrorLua) && !sameContent(realLua, mirrorLua)) {
    r.lines.push(`INFO drift: hack/scripts/dwf.lua (scripts mirror) differs from the plugins copy — a restart drill likely wrote only one path`);
    if (r.status === "PASS") r.status = "INFO";
  }
  return r;
}

// ---- 2. mirror-sync -------------------------------------------------------
function checkMirrorSync(ctx) {
  const r = mk("mirror-sync");
  const repoSrc = path.join(ctx.repo, "src");
  const mirSrc = path.join(ctx.mirror, "src");
  if (!existsSync(mirSrc)) {
    fail(r, `mirror src\\ missing — recreate ${mirSrc}`);
    r.lines.push(`MISSING mirror src: ${mirSrc}`);
    return r;
  }
  const repoFiles = walk(repoSrc).filter((p) => /\.(cpp|h|hpp|c)$/i.test(p));
  const stale = [];
  for (const f of repoFiles) {
    const rel = path.relative(repoSrc, f);
    const twin = path.join(mirSrc, rel);
    if (!existsSync(twin)) { stale.push(`${rel} (missing in mirror)`); continue; }
    if (!sameContent(f, twin)) stale.push(`${rel} (content differs)`);
  }
  if (stale.length) {
    fail(r, `re-copy the listed files into ${mirSrc}\\ (NOT the mirror root). NOTE: repo is treated as source-of-truth — if the MIRROR is actually the fixed copy, the repo source is stale; commit the repo instead.`);
    for (const s of stale) r.lines.push(`STALE mirror src: ${s}`);
  } else {
    r.lines.push(`ok: all ${repoFiles.length} repo src/* match mirror/src/*`);
  }

  // Root-copy trap: a .cpp/.h at the mirror ROOT NEWER than its src\ twin means
  // someone dropped a fresh file where nothing compiles it. Older root copies
  // are stale leftovers — a latent hazard, reported as INFO.
  let trapFired = false, leftovers = 0;
  for (const e of readdirSync(ctx.mirror)) {
    if (!/\.(cpp|h|hpp|c)$/i.test(e)) continue;
    const rootF = path.join(ctx.mirror, e);
    if (statSync(rootF).isDirectory()) continue;
    const twin = path.join(mirSrc, e);
    if (!existsSync(twin)) {
      r.lines.push(`INFO mirror-root file with no src twin: ${e}`);
      continue;
    }
    const rootM = statSync(rootF).mtimeMs, srcM = statSync(twin).mtimeMs;
    if (rootM > srcM) {
      trapFired = true;
      r.lines.push(`ROOT-NEWER TRAP: mirror-root ${e} is newer than src/${e} — root copies compile into NOTHING; the src/ twin is stale`);
    } else {
      leftovers++;
    }
  }
  if (trapFired) fail(r, `delete the mirror-ROOT .cpp/.h copies; edit only mirror\\src\\`);
  if (leftovers) {
    r.lines.push(`INFO: ${leftovers} stale .cpp/.h leftover(s) at mirror ROOT (older than src twin; harmless now, delete to remove the landmine)`);
    if (r.status === "PASS") r.status = "INFO";
  }
  return r;
}

// ---- 3. dll-witness -------------------------------------------------------
function checkDllWitness(ctx) {
  const r = mk("dll-witness");
  if (!ctx.witness) {
    r.status = "SKIP";
    r.lines.push("SKIP: no --witness <string> given (pass a string unique to this build to content-gate the dll)");
    return r;
  }
  const builtDll = ctx.builtDll;
  const deployedDll = path.join(ctx.dfRoot, "hack", "plugins", "dwf.plug.dll");
  const inBuilt = existsSync(builtDll) ? bufHasString(readFileSync(builtDll), ctx.witness) : null;
  const inDeployed = existsSync(deployedDll) ? bufHasString(readFileSync(deployedDll), ctx.witness) : null;

  if (inBuilt === null) { fail(r, `built dll missing — rebuild: ${builtDll}`); r.lines.push(`MISSING built dll: ${builtDll}`); }
  else r.lines.push(`built dll: witness "${ctx.witness}" ${inBuilt ? "PRESENT" : "ABSENT"}`);
  if (inDeployed === null) { fail(r, `deployed dll missing — copy the built dll to ${deployedDll}`); r.lines.push(`MISSING deployed dll: ${deployedDll}`); }
  else r.lines.push(`deployed dll: witness "${ctx.witness}" ${inDeployed ? "PRESENT" : "ABSENT"}`);

  if (inBuilt === false && inDeployed === true)
    { fail(r, "impossible/stale build tree — deployed has the witness the built dll lacks; rebuild clean"); r.lines.push("deployed-not-built: the build tree is STALE relative to what shipped"); }
  if (inBuilt === true && inDeployed === false)
    { fail(r, `copy the freshly-built dll to ${deployedDll} (you built it but did not deploy it)`); r.lines.push("built-not-deployed: forgot the copy to <DF>/hack/plugins/"); }
  if (inBuilt === false && inDeployed === false)
    { fail(r, "witness in NEITHER dll — is the change actually built? check the witness string"); r.lines.push("built-and-deployed both ABSENT: change is not in either binary"); }
  return r;
}

// ---- 4. web-sync ----------------------------------------------------------
function checkWebSync(ctx) {
  const r = mk("web-sync");
  const repoWeb = path.join(ctx.repo, "web");
  const depWeb = path.join(ctx.dfRoot, "hack", "dfcapture-web");
  if (!existsSync(depWeb)) {
    fail(r, `deploy web/ -> ${depWeb}`);
    r.lines.push(`MISSING deployed web root: ${depWeb}`);
    return r;
  }
  const repoFiles = walk(repoWeb);
  const staleList = [], missingList = [];
  for (const f of repoFiles) {
    const rel = path.relative(repoWeb, f);
    const dep = path.join(depWeb, rel);
    if (!existsSync(dep)) { missingList.push(rel); continue; }
    // size+mtime prefilter: if raw size equal AND deployed not older, cheap raw
    // compare may short-circuit; otherwise fall through to normalized compare.
    if (!sameContent(f, dep)) staleList.push(rel);
  }
  // extra-deployed: files present in deploy but not repo (info only).
  const repoRel = new Set(repoFiles.map((f) => path.relative(repoWeb, f).replace(/\\/g, "/")));
  const extraList = [];
  for (const f of walk(depWeb)) {
    const rel = path.relative(depWeb, f).replace(/\\/g, "/");
    if (!repoRel.has(rel)) extraList.push(rel);
  }

  if (staleList.length || missingList.length) {
    fail(r, `re-deploy web/ to ${depWeb} (stale/missing files below)`);
    for (const s of staleList) r.lines.push(`stale-deployed: ${s}`);
    for (const m of missingList) r.lines.push(`missing-deployed: ${m}`);
  } else {
    r.lines.push(`ok: all ${repoFiles.length} web files match deployed (content-normalized)`);
  }
  for (const e of extraList) r.lines.push(`INFO extra-deployed (not in repo): ${e}`);
  return r;
}

// ---- 5. buster-lockstep ---------------------------------------------------
function checkBusterLockstep(ctx) {
  const r = mk("buster-lockstep");
  const repoWeb = path.join(ctx.repo, "web");
  const depWeb = path.join(ctx.dfRoot, "hack", "dfcapture-web");
  const repoIndex = path.join(repoWeb, "index.html");
  const depIndex = path.join(depWeb, "index.html");
  if (!existsSync(repoIndex) || !existsSync(depIndex)) {
    r.status = "SKIP";
    r.lines.push("SKIP: index.html missing in repo or deploy (web-sync covers that)");
    return r;
  }
  const indexIdentical = sameContent(repoIndex, depIndex);
  // Parse the buster versions the deployed index last shipped (informational).
  const busterMap = {};
  const idxTxt = readFileSync(depIndex, "utf8");
  const re = /(?:js|css)\/([a-zA-Z0-9._-]+\.(?:js|css))\?v=([a-zA-Z0-9._-]+)/g;
  let m;
  while ((m = re.exec(idxTxt))) busterMap[m[1]] = m[2];

  const codeFiles = [
    ...walk(path.join(repoWeb, "js")).filter((p) => p.endsWith(".js")),
    ...walk(path.join(repoWeb, "css")).filter((p) => p.endsWith(".css")),
  ];
  const violations = [];
  for (const f of codeFiles) {
    const rel = path.relative(repoWeb, f);
    const dep = path.join(depWeb, rel);
    if (!existsSync(dep)) continue; // web-sync reports missing files
    const codeChanged = !sameContent(f, dep);
    // Code changed vs deploy, but index.html was NOT redeployed (repo==deployed)
    // => the buster/index step did not accompany the code change.
    if (codeChanged && indexIdentical) violations.push(path.basename(f));
  }
  if (violations.length) {
    fail(r, `bump ?v= for each file in web/index.html and redeploy index.html together with the js/css`);
    for (const v of violations)
      r.lines.push(`buster violation: ${v} changed but index.html (repo==deployed) shipped no accompanying bump [deployed buster=${busterMap[v] ?? "n/a"}]`);
  } else {
    r.lines.push(`ok: no js/css changed without an index.html redeploy (${codeFiles.length} files, index ${indexIdentical ? "identical" : "differs"})`);
  }
  return r;
}

// ---- 6. conflict-markers --------------------------------------------------
function checkConflictMarkers(ctx) {
  const r = mk("conflict-markers");
  const repoWeb = path.join(ctx.repo, "web");
  const files = walk(repoWeb).filter(isText);
  const hits = [];
  const open = Buffer.from("<<<<<<<"), close = Buffer.from(">>>>>>>");
  for (const f of files) {
    const b = readFileSync(f);
    if (b.includes(open) || b.includes(close)) hits.push(path.relative(ctx.repo, f));
  }
  if (hits.length) {
    fail(r, "resolve the git conflict markers before deploying");
    for (const h of hits) r.lines.push(`conflict markers in: ${h}`);
  } else {
    r.lines.push(`ok: no <<<<<<< / >>>>>>> in ${files.length} repo web text files`);
  }
  return r;
}

// -------------------------------------------------------------------- runner
function runAll(ctx) {
  return [
    checkLuaPath(ctx),
    checkMirrorSync(ctx),
    checkDllWitness(ctx),
    checkWebSync(ctx),
    checkBusterLockstep(ctx),
    checkConflictMarkers(ctx),
  ];
}

function buildContext(args) {
  const buildRoot = args["dfhack-build"] || DEFAULT_DFHACK_BUILD;
  return {
    repo: REPO_ROOT,
    dfRoot: args["df-root"] || DEFAULT_DF_ROOT,
    mirror: args.mirror || (buildRoot
      ? path.join(dfhackSourceRoot(buildRoot), "plugins", "external", "multi-dwarf")
      : DEFAULT_MIRROR),
    builtDll: args["built-dll"] || (buildRoot ? builtDfcaptureDll(buildRoot) : DEFAULT_BUILT_DLL),
    witness: args.witness || "",
  };
}

function report(results, args) {
  const anyFail = results.some((r) => r.status === "FAIL");
  if (args.json) {
    console.log(JSON.stringify({
      ok: !anyFail,
      results: results.map((r) => ({ name: r.name, status: r.status, lines: r.lines, fix: r.fix })),
    }, null, 2));
  } else {
    for (const r of results) {
      const tag = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL"
                : r.status === "SKIP" ? "SKIP" : "INFO";
      console.log(`\n[${tag}] ${r.name}`);
      for (const l of r.lines) console.log(`   ${l}`);
      if (r.status === "FAIL" && r.fix) console.log(`   FIX: ${r.fix}`);
    }
    console.log(`\n=== deploy-integrity: ${anyFail ? "FAIL — do not deploy" : "PASS"} ===`);
  }
  return anyFail ? 1 : 0;
}

// -------------------------------------------------------------------- selftest
// Build throwaway fixture trees, seed each failure mode, assert the matching
// check FAILs — and a clean control PASSes. "Test the test" (protocol rule 3):
// an audit that has never failed is unvalidated.
function selftest() {
  const base = path.join(os.tmpdir(), `dic-selftest-${process.pid}-${Date.now()}`);
  const cases = [];
  const assert = (name, cond, detail) => cases.push({ name, ok: cond, detail });

  function makeFixture(root) {
    const repo = path.join(root, "repo");
    const df = path.join(root, "df");
    const mirror = path.join(root, "mirror");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    mkdirSync(path.join(repo, "web", "js"), { recursive: true });
    mkdirSync(path.join(repo, "web", "css"), { recursive: true });
    mkdirSync(path.join(df, "hack", "lua", "plugins"), { recursive: true });
    mkdirSync(path.join(df, "hack", "scripts"), { recursive: true });
    mkdirSync(path.join(df, "hack", "plugins"), { recursive: true });
    mkdirSync(path.join(df, "hack", "dfcapture-web", "js"), { recursive: true });
    mkdirSync(path.join(df, "hack", "dfcapture-web", "css"), { recursive: true });
    mkdirSync(path.join(mirror, "src"), { recursive: true });

    const lua = "-- dwf lua v1\nreturn {}\n";
    writeFileSync(path.join(repo, "dwf.lua"), lua);
    writeFileSync(path.join(df, "hack", "lua", "plugins", "dwf.lua"), lua);
    writeFileSync(path.join(df, "hack", "scripts", "dwf.lua"), lua);

    const cpp = "// src file\nint x = 1;\n";
    writeFileSync(path.join(repo, "src", "a.cpp"), cpp);
    writeFileSync(path.join(mirror, "src", "a.cpp"), cpp);

    const index = '<script src="/js/app.js?v=1.0.0"></script>\n<link href="/css/app.css?v=1.0.0">\n';
    const appjs = "console.log('app');\n";
    const appcss = "body{color:red}\n";
    writeFileSync(path.join(repo, "web", "index.html"), index);
    writeFileSync(path.join(df, "hack", "dfcapture-web", "index.html"), index);
    writeFileSync(path.join(repo, "web", "js", "app.js"), appjs);
    writeFileSync(path.join(df, "hack", "dfcapture-web", "js", "app.js"), appjs);
    writeFileSync(path.join(repo, "web", "css", "app.css"), appcss);
    writeFileSync(path.join(df, "hack", "dfcapture-web", "css", "app.css"), appcss);

    const dll = Buffer.concat([Buffer.from("garbage"), Buffer.from("WITNESS_OK"), Buffer.from("more")]);
    writeFileSync(path.join(mirror, "..", "built.dll"), dll); // placeholder, overridden below
    return { repo, df, mirror,
      builtDll: path.join(root, "built.dll"),
      deployedDll: path.join(df, "hack", "plugins", "dwf.plug.dll") };
  }

  const ctxOf = (fx, witness = "") => ({
    repo: fx.repo, dfRoot: fx.df, mirror: fx.mirror, builtDll: fx.builtDll, witness,
  });
  const statusOf = (results, name) => results.find((r) => r.name === name).status;

  try {
    // --- Clean negative control: everything PASS/INFO/SKIP, no FAIL. ---
    {
      const root = path.join(base, "clean");
      const fx = makeFixture(root);
      const dll = Buffer.concat([Buffer.from("WITNESS_OK build")]);
      writeFileSync(fx.builtDll, dll);
      writeFileSync(fx.deployedDll, dll);
      const results = runAll(ctxOf(fx, "WITNESS_OK"));
      const noFail = results.every((r) => r.status !== "FAIL");
      assert("clean-control: no FAIL", noFail,
        noFail ? "" : "failed: " + results.filter((r) => r.status === "FAIL").map((r) => r.name).join(","));
    }
    // --- Seeded stale mirror src file -> mirror-sync FAIL. ---
    {
      const root = path.join(base, "stalemirror");
      const fx = makeFixture(root);
      writeFileSync(path.join(fx.mirror, "src", "a.cpp"), "// STALE mirror copy\nint x = 999;\n");
      const s = statusOf(runAll(ctxOf(fx)), "mirror-sync");
      assert("stale-mirror -> mirror-sync FAIL", s === "FAIL", `got ${s}`);
    }
    // --- Seeded root-copy trap (root newer than src) -> mirror-sync FAIL. ---
    {
      const root = path.join(base, "roottrap");
      const fx = makeFixture(root);
      const rootCpp = path.join(fx.mirror, "a.cpp");
      writeFileSync(rootCpp, "// fresh code dropped at ROOT\nint x = 2;\n");
      // make the root copy newer than the src twin
      const future = Date.now() / 1000 + 60;
      utimesSync(rootCpp, future, future);
      const s = statusOf(runAll(ctxOf(fx)), "mirror-sync");
      assert("root-copy-trap -> mirror-sync FAIL", s === "FAIL", `got ${s}`);
    }
    // --- Seeded lua divergence (real plugins copy differs from repo) -> lua-path FAIL. ---
    {
      const root = path.join(base, "luadiv");
      const fx = makeFixture(root);
      writeFileSync(path.join(fx.df, "hack", "lua", "plugins", "dwf.lua"), "-- STALE deployed lua\n");
      const s = statusOf(runAll(ctxOf(fx)), "lua-path");
      assert("lua-divergence -> lua-path FAIL", s === "FAIL", `got ${s}`);
    }
    // --- Seeded missing witness (built has it, deployed does not) -> dll-witness FAIL. ---
    {
      const root = path.join(base, "witness");
      const fx = makeFixture(root);
      writeFileSync(fx.builtDll, Buffer.from("NEWFEATURE present in build"));
      writeFileSync(fx.deployedDll, Buffer.from("old dll no feature"));
      const s = statusOf(runAll(ctxOf(fx, "NEWFEATURE")), "dll-witness");
      assert("missing-witness -> dll-witness FAIL", s === "FAIL", `got ${s}`);
    }
    // --- Seeded buster violation (js changed, index.html identical) -> buster-lockstep FAIL. ---
    {
      const root = path.join(base, "buster");
      const fx = makeFixture(root);
      // repo js differs from deployed js, but index.html unchanged repo==deployed
      writeFileSync(path.join(fx.repo, "web", "js", "app.js"), "console.log('CHANGED no buster');\n");
      const results = runAll(ctxOf(fx));
      const s = statusOf(results, "buster-lockstep");
      assert("buster-violation -> buster-lockstep FAIL", s === "FAIL", `got ${s}`);
    }
    // --- Seeded conflict marker -> conflict-markers FAIL. ---
    {
      const root = path.join(base, "conflict");
      const fx = makeFixture(root);
      writeFileSync(path.join(fx.repo, "web", "index.html"),
        '<<<<<<< HEAD\n<script src="/js/app.js?v=1"></script>\n>>>>>>> other\n');
      const s = statusOf(runAll(ctxOf(fx)), "conflict-markers");
      assert("conflict-marker -> conflict-markers FAIL", s === "FAIL", `got ${s}`);
    }
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  let allOk = true;
  console.log("=== deploy_integrity_check --selftest ===");
  for (const c of cases) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   <-- " + c.detail}`);
    if (!c.ok) allOk = false;
  }
  console.log(`\nselftest: ${allOk ? "ALL PASS" : "FAILURES ABOVE"}`);
  return allOk ? 0 : 1;
}

// --------------------------------------------------------------------- main
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(String(e.message || e)); process.exit(2); }
  if (args.help) {
    console.log("Usage: node tools/harness/deploy_integrity_check.mjs [--witness <s>] [--df-root <p>] [--dfhack-build <p>] [--mirror <p>] [--built-dll <p>] [--json] [--selftest]");
    process.exit(0);
  }
  if (args.selftest) process.exit(await selftest());
  if ((!args["built-dll"] || !args.mirror) && !DEFAULT_DFHACK_BUILD) {
    const resolution = resolveDfhackBuild();
    console.error(missingDfhackBuildMessage(resolution,
      "the deploy gate compares the freshly built DLL and DFHack source junction"));
    process.exit(2);
  }
  const ctx = buildContext(args);
  const results = runAll(ctx);
  process.exit(report(results, args));
}

main();
