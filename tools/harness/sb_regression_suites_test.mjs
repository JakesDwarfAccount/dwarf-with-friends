// sb_regression_suites_test.mjs -- work-order criterion 10: the animation suites that SHARE the old
// 800ms clock constant (designation blink, worked-tile alternation, flow breathing, machine cadence,
// pause animation) and the renderer-parity sweep must stay GREEN after bubbles are decoupled from
// that clock. Run: node tools/harness/sb_regression_suites_test.mjs
//
// The v1 rule (table §CADENCE) is: separate BUBBLES from the shared clock, leave everything else
// byte-identical. These are the exact suites that would turn red if a renderer worker deleted or
// repurposed unitStatusBlinkVisible / DESIG_ACTIVE_BLINK_MS instead of just removing its use in the
// bubble path. This meta-suite runs each as a child process and asserts a clean exit.
//
// STANDALONE-PASSING: green on the base (nothing touched yet) AND the integrator re-runs it after
// merging the renderer changes to confirm no collateral damage. The list was derived by grepping the
// harness for each shared-clock consumer.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = path.dirname(fileURLToPath(import.meta.url));

// [suite, what it guards against the shared-clock decoupling]
const SUITES = [
  ["b108_claimed_designation_blink_test.mjs", "designation-job blink + worked-tile alternation (DESIG_ACTIVE_BLINK_MS = clock/2)"],
  ["flows_miasma_test.mjs",                   "flow/miasma breathing (flowOverlay dims on the shared clock's off half)"],
  ["wc6_wc8_machine_test.mjs",                "machine gear cadence"],
  ["pause_anim_test.mjs",                     "pause animation freeze + UI-blink-keeps-running"],
  ["renderer_wave_test.mjs",                  "cross-renderer parity sweep"],
];

const results = [];
for (const [suite, guards] of SUITES) {
  let ok = true, detail = "";
  try {
    execFileSync(process.execPath, [path.join(HARNESS, suite)], { stdio: "pipe", timeout: 120000 });
  } catch (e) {
    ok = false;
    detail = (e.stdout ? e.stdout.toString() : "") + (e.stderr ? e.stderr.toString() : "");
  }
  results.push({ suite, guards, ok, detail });
  assert.ok(ok, `criterion 10: ${suite} must stay GREEN (${guards})\n${detail.split("\n").slice(-6).join("\n")}`);
}

// test-the-test: prove the runner actually FAILS on a red child (not silently green).
let caught = false;
try {
  execFileSync(process.execPath, ["-e", "process.exit(1)"], { stdio: "pipe" });
} catch { caught = true; }
assert.ok(caught, "the child-process runner detects a non-zero exit (test-the-test)");

console.log("sb_regression_suites_test: PASS -- " + results.length + " shared-clock/parity suites stay green: " +
  results.map((r) => r.suite.replace("_test.mjs", "")).join(", "));
