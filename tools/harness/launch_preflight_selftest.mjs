// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Self-test for tools/release/launch_preflight.mjs. It proves the RUNNER's plumbing without ever
// running the real 30 suites: it drives runSuitesPool() + classifySuites() against tiny STUB
// suites written to a temp dir. Three things are asserted:
//   1. stage plumbing: STAGES + the exported runner/classifier are wired and callable;
//   2. failure -> NO-GO: an unexpected non-zero suite makes classify() return FAIL;
//   3. known-failure tolerance: a failing suite whose basename is in KNOWN_FAILURES is reported
//      as tolerated, not as a hard failure, so the verdict stays PASS.
// Also checks the parallel pool actually runs concurrently, and the assets-fingerprint mirror.
//
// Run: node tools/harness/launch_preflight_selftest.mjs
// Exit 0 = all assertions pass. Exit 1 = a failure is printed above the summary.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  runSuitesPool, classifySuites, STAGES, KNOWN_FAILURES,
  cacheTags, assetsFingerprint,
} from "../release/launch_preflight.mjs";

const cases = [];
function check(name, cond, detail = "") { cases.push({ name, ok: !!cond, detail }); }

// A stub suite is a one-line node program. `exitCode` controls pass/fail; `sleepMs` lets us prove
// the pool overlaps work. A "SKIP" body exercises the skip classifier.
function stub({ exitCode = 0, sleepMs = 0, skip = false } = {}) {
  const body = [];
  if (skip) body.push('console.log("SKIP: no fixture");');
  if (sleepMs) body.push(`await new Promise(r=>setTimeout(r,${sleepMs}));`);
  body.push(`process.exit(${exitCode});`);
  return body.join("\n") + "\n";
}

async function main() {
  const base = path.join(os.tmpdir(), `lp-selftest-${process.pid}-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  try {
    // Pick a real member of KNOWN_FAILURES so the tolerance path is exercised with a live entry.
    const knownBase = [...KNOWN_FAILURES][0];

    // ---- Fixture: 3 pass, 1 skip, 1 unexpected-fail, 1 known-fail (named after a KNOWN_FAILURES entry).
    const write = (name, opts) => {
      const file = path.join(base, name);
      writeFileSync(file, stub(opts));
      return { file: name };
    };
    const allGreen = [
      write("pass_a_test.mjs", { exitCode: 0 }),
      write("pass_b_test.mjs", { exitCode: 0 }),
      write("skip_c_test.mjs", { exitCode: 0, skip: true }),
    ];
    const knownFail = write(knownBase, { exitCode: 1 });          // basename is in KNOWN_FAILURES
    const unexpectedFail = write("boom_test.mjs", { exitCode: 3 });

    // ---- (1) stage plumbing exported ----
    check("STAGES lists the six stages",
      STAGES.length === 6 && STAGES.includes("suites") && STAGES.includes("all"),
      JSON.stringify(STAGES));

    // ---- clean control: all green + skip -> verdict PASS, zero failures ----
    {
      const results = await runSuitesPool(allGreen, { repoRoot: base, jobs: 2 });
      const cls = classifySuites(results);
      check("clean control -> PASS", cls.verdict === "PASS", `verdict=${cls.verdict}`);
      check("clean control counts (2 pass, 1 skip)",
        cls.passed.length === 2 && cls.skipped.length === 1 && cls.failed.length === 0,
        `p=${cls.passed.length} s=${cls.skipped.length} f=${cls.failed.length}`);
    }

    // ---- (2) unexpected failure -> NO-GO ----
    {
      const results = await runSuitesPool([...allGreen, unexpectedFail], { repoRoot: base, jobs: 3 });
      const cls = classifySuites(results);
      check("unexpected fail -> FAIL verdict", cls.verdict === "FAIL", `verdict=${cls.verdict}`);
      check("unexpected fail listed in failed[]",
        cls.failed.length === 1 && cls.failed[0].base === "boom_test.mjs",
        cls.failed.map((r) => r.base).join(","));
      check("unexpected fail is NOT tolerated", cls.tolerated.length === 0, `tol=${cls.tolerated.length}`);
    }

    // ---- platform-scoped suite: explicitly skipped before spawning on another OS ----
    {
      const otherPlatform = process.platform === "win32" ? "linux" : "win32";
      const results = await runSuitesPool([{ ...unexpectedFail, platforms: [otherPlatform] }],
        { repoRoot: base, jobs: 1 });
      const cls = classifySuites(results);
      check("non-matching platform -> explicit SKIP",
        cls.verdict === "PASS" && cls.skipped.length === 1 && cls.failed.length === 0
          && results[0].output.includes(`current platform: ${process.platform}`),
        `verdict=${cls.verdict} skipped=${cls.skipped.length}`);
    }

    // ---- (3) known failure tolerated -> verdict stays PASS, reported distinctly ----
    {
      const results = await runSuitesPool([...allGreen, knownFail], { repoRoot: base, jobs: 3 });
      const cls = classifySuites(results);
      check("known fail -> PASS verdict (tolerated)", cls.verdict === "PASS", `verdict=${cls.verdict}`);
      check("known fail lands in tolerated[], not failed[]",
        cls.tolerated.length === 1 && cls.tolerated[0].base === knownBase && cls.failed.length === 0,
        `tol=${cls.tolerated.map((r) => r.base).join(",")} fail=${cls.failed.map((r) => r.base).join(",")}`);
    }

    // ---- known + unexpected together: verdict FAIL, but the known one is still only tolerated ----
    {
      const results = await runSuitesPool([...allGreen, knownFail, unexpectedFail], { repoRoot: base, jobs: 4 });
      const cls = classifySuites(results);
      check("known+unexpected -> FAIL, known still tolerated",
        cls.verdict === "FAIL" && cls.tolerated.length === 1 && cls.failed.length === 1,
        `verdict=${cls.verdict} tol=${cls.tolerated.length} fail=${cls.failed.length}`);
    }

    // ---- pool concurrency: three 300ms stubs on jobs=3 finish in well under the 900ms serial sum ----
    {
      const slow = [
        write("slow_a_test.mjs", { exitCode: 0, sleepMs: 300 }),
        write("slow_b_test.mjs", { exitCode: 0, sleepMs: 300 }),
        write("slow_c_test.mjs", { exitCode: 0, sleepMs: 300 }),
      ];
      const t = Date.now();
      await runSuitesPool(slow, { repoRoot: base, jobs: 3 });
      const wall = Date.now() - t;
      check("parallel pool overlaps (3x300ms in < 700ms)", wall < 700, `wall=${wall}ms`);
    }

    // ---- assets-fingerprint mirror: reproducible + tag extraction ----
    {
      const html = '<script src="/js/a.js?v=1.0"></script><link href="/css/b.css?v=2.0">';
      const tags = cacheTags(html);
      check("cacheTags sorted+unique", tags.join(",") === "1.0,2.0", tags.join(","));
      const fp = assetsFingerprint(html);
      check("assetsFingerprint is 8 hex + stable",
        /^[0-9a-f]{8}$/.test(fp) && fp === assetsFingerprint(html), fp);
    }
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  let allOk = true;
  console.log("=== launch_preflight_selftest ===");
  for (const c of cases) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : "   <-- " + c.detail}`);
    if (!c.ok) allOk = false;
  }
  console.log(`\nselftest: ${allOk ? "ALL PASS" : "FAILURES ABOVE"} (${cases.length} checks)`);
  process.exit(allOk ? 0 : 1);
}

main();
