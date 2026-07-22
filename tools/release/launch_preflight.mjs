// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// LAUNCH PREFLIGHT — the one command the owner runs repeatedly on launch day.
//
// This script PREPARES and VERIFIES a launch; it NEVER launches, restarts, or deploys anything
// itself. Dwarf Fortress and the deploy copy stay human actions: the script prints the exact
// manual commands at the right moment and then stops. Every stage ends in one of PASS / FAIL /
// MANUAL, and every run ends with a go/no-go summary plus the remaining human checklist so no
// genuinely-human step is forgotten.
//
// Dependency-free, portable Node (same house style as tools/release/build_zip.mjs). Node >= 18.
//
// Stages:
//   --stage=suites      run the full offline evidence battery (parallel worker pool)
//   --stage=build-check verify the compiled dwf.plug.dll exists, print sha256/size/mtime, staleness
//   --stage=predeploy   deploy_integrity_check report-only + the manual deploy commands (not run)
//   --stage=postdeploy  deploy_integrity_check expecting full pass + served /version + /view proof
//   --stage=package     build_zip.mjs (pass-through args) + zip fixtures -> launch-manifest.json
//   --stage=all         suites -> build-check -> predeploy, then stop with deploy instructions
//
// Common flags: --df-root <path>  --witness <string>  --dfhack-build <path>
//               --jobs <n>  --serial  --json  --server <http://host:port>
//
// Exit 0 = GO (every stage that ran is PASS or MANUAL). Exit 1 = NO-GO (any hard FAIL).

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync, readFileSync, statSync, readdirSync, writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  resolveDfRoot, resolveDfhackBuild, builtDfcaptureDll, missingDfhackBuildMessage,
} from "../lib/dfroot.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// ---------------------------------------------------------------------------------------------
// The offline evidence battery. Each entry is { file, args } relative to the repo root; the
// runner spawns `node <file> <args>` and reads its exit code (0 = pass, non-zero = fail, a
// SKIP line is neither). Grouped only for the printed report. Keep this list curated: adding a
// suite that needs a live game or a save fixture would make a DF-less launch machine go red for
// the wrong reason.
const LEGACY_SUITE_CATALOG = [
  { group: "protocol", file: "tools/harness/json_mini_vectors_test.mjs" },
  { group: "security", file: "tools/harness/join_public_allowlist_test.mjs" },
  { group: "security", file: "tools/harness/route_policy_completeness_test.mjs" },
  { group: "security", file: "tools/harness/request_origin_test.mjs" },
  { group: "security", file: "tools/harness/diagnostic_route_gate_test.mjs" },
  { group: "security", file: "tools/harness/tiledump_bounds_test.mjs" },
  { group: "security", file: "tools/harness/friend_save_policy_test.mjs" },
  { group: "release", file: "tools/harness/test_manifest_test.mjs" },
  { group: "release", file: "tools/harness/native_build_receipt_test.mjs" },
  { group: "contributors", file: "tools/harness/contributor_surface_test.mjs" },
  { group: "native", file: "tools/harness/stone_use_api_result_test.mjs" },
  { group: "native", file: "tools/harness/burrows_api_result_test.mjs" },
  { group: "native", file: "tools/harness/kitchen_api_result_test.mjs" },
  { group: "native", file: "tools/harness/labor_api_result_test.mjs" },
  { group: "native", file: "tools/harness/portrait_native_fault_guard_test.mjs" },
  { group: "native", file: "tools/harness/df_access_inventory_test.mjs" },
  { group: "wire", file: "tools/harness/wire_tail_bounds_test.mjs" },
  { group: "wire", file: "tools/harness/automine_tint_test.mjs" },
  { group: "lifecycle", file: "tools/harness/save_barrier_test.mjs" },
  { group: "lua", file: "tools/harness/stockpile_settings_guard_test.mjs" },
  { group: "lua", file: "tools/harness/stockpile_repair_wiring_test.mjs" },
  { group: "lua", file: "tools/harness/lua_bridge_signature_test.mjs" },
  { group: "lua", file: "tools/harness/lua_fort_entity_test.mjs" },
  { group: "lua", file: "tools/harness/lua_generated_source_test.mjs" },
  { group: "chat", file: "tools/harness/chat_rate_signal_test.mjs" },
  { group: "wire", file: "tools/harness/reqblocks_queue_bounds_test.mjs" },
  { group: "wire", file: "tools/harness/ws_drop_counters_test.mjs" },
  { group: "diagnostics", file: "tools/harness/diagnostics_log_bound_test.mjs" },
  { group: "lifecycle", file: "tools/harness/world_reload_reset_test.mjs" },
  // packaging + host install contract
  { group: "package", file: "tools/harness/pkg_install_roundtrip_test.mjs" },
  { group: "package", file: "tools/harness/release_zip_fixture_test.mjs" },
  { group: "package", file: "tools/harness/host_install_fixture_test.mjs" },
  { group: "package", file: "tools/harness/deploy_integrity_check.mjs", args: ["--selftest"] },
  { group: "package", file: "tools/harness/dfroot_resolver_test.mjs" },
  // ground-truth / parity plumbing
  { group: "parity", file: "tools/ground_truth/task_test.mjs" },
  { group: "parity", file: "tools/ground_truth/parity_seed_build_test.mjs", platforms: ["win32"] },
  { group: "parity", file: "tools/ground_truth/parity_web_integrity_test.mjs" },
  // client render + shell guards
  { group: "shell", file: "tools/harness/lua_syntax_guard.mjs" },
  { group: "shell", file: "tools/harness/browser_dependency_inventory_test.mjs" },
  { group: "wire", file: "tools/harness/protocol_v1_registry_test.mjs" },
  { group: "shell", file: "tools/harness/view_stamp_test.mjs" },
  { group: "shell", file: "tools/harness/panel_frame_test.mjs" },
  { group: "shell", file: "tools/harness/uiflow_test.mjs" },
  { group: "shell", file: "tools/harness/ui_components_test.mjs" },
  // status bubbles — the seven sb_* suites
  { group: "status-bubbles", file: "tools/harness/sb_cadence_test.mjs" },
  { group: "status-bubbles", file: "tools/harness/sb_predicate_source_test.mjs" },
  { group: "status-bubbles", file: "tools/harness/sb_predicate_test.mjs" },
  { group: "status-bubbles", file: "tools/harness/sb_regression_suites_test.mjs" },
  { group: "status-bubbles", file: "tools/harness/sb_resolver_parity_test.mjs" },
  { group: "status-bubbles", file: "tools/harness/sb_seeded_bad_test.mjs" },
  { group: "status-bubbles", file: "tools/harness/sb_transport_test.mjs" },
  // status truth family
  { group: "status", file: "tools/harness/wt29_mood_subtype_test.mjs" },
  { group: "status", file: "tools/harness/wt30_status_full_test.mjs" },
  { group: "status", file: "tools/harness/wb13_units_test.mjs" },
  { group: "status", file: "tools/harness/b248_status_priority_test.mjs" },
  { group: "status", file: "tools/harness/status_truth_test.mjs" },
  { group: "status", file: "tools/harness/b222_status_serializer_parity_test.mjs" },
  // exact shaped repaint — the four zone_repaint_* suites + the stockpile session mirror
  { group: "zone-repaint", file: "tools/harness/zone_repaint_safety_test.mjs" },
  { group: "zone-repaint", file: "tools/harness/zone_repaint_session_test.mjs" },
  { group: "zone-repaint", file: "tools/harness/zone_repaint_shape_test.mjs" },
  { group: "zone-repaint", file: "tools/harness/zone_repaint_status_test.mjs" },
  { group: "zone-repaint", file: "tools/harness/stockpile_repaint_session_test.mjs" },
  // seven-family flows: squads / stocks / units / work orders / tavern
  { group: "families", file: "tools/harness/squads_view_fixture_test.mjs" },
  { group: "families", file: "tools/harness/wave4_squads_parity_test.mjs" },
  { group: "families", file: "tools/harness/b295_squad_flow_parity_test.mjs" },
  { group: "families", file: "tools/harness/b293_noble_squad_availability_test.mjs" },
  { group: "families", file: "tools/harness/cim_workorders_test.mjs" },
  { group: "families", file: "tools/harness/b285_workorder_condition_editor_test.mjs" },
  { group: "families", file: "tools/harness/b285_workorder_conditions_read_test.mjs" },
  { group: "families", file: "tools/harness/wave4_info_stocks_test.mjs" },
  { group: "families", file: "tools/harness/s5_location_tavern_test.mjs" },
  // v1 gate suites
  { group: "v1", file: "tools/harness/v1_safety_gate_test.mjs" },
  { group: "v1", file: "tools/harness/squad_delete_teardown_test.mjs" },
  { group: "v1", file: "tools/harness/ws_upgrade_header_capacity_test.mjs" },
  { group: "v1", file: "tools/harness/ui_cache_purge_guard_test.mjs" },
  { group: "v1", file: "tools/harness/v1_shell_single_pop_test.mjs" },
  { group: "v1", file: "tools/harness/v1_squad_asneeded_gates_test.mjs" },
  { group: "v1", file: "tools/harness/v1_stale_honesty_test.mjs" },
  { group: "v1", file: "tools/harness/v1_stock_item_flags_test.mjs" },
  { group: "v1", file: "tools/harness/v1_workorder_cancel_test.mjs" },
];

const TEST_MANIFEST_PATH = path.join(REPO_ROOT, "tools", "release", "test-manifest.json");
export const TEST_MANIFEST = JSON.parse(readFileSync(TEST_MANIFEST_PATH, "utf8"));
export const SUITES = TEST_MANIFEST.offline;
const suiteMembership = SUITES.map((suite) => {
  const { private: _private, ...membership } = suite;
  return membership;
});
if (JSON.stringify(suiteMembership) !== JSON.stringify(LEGACY_SUITE_CATALOG))
  throw new Error("test-manifest.json offline membership drifted from the reviewed catalog");

// Suites known to fail on this candidate for reasons already understood (long-term evidence debt,
// not launch blockers). Keyed by file basename. A failure HERE is tolerated but reported apart; a
// failure anywhere else is a hard NO-GO. Matched by basename so the list survives path shuffles.
export const KNOWN_FAILURES = new Set([
  "b151_parity_test.mjs",
  "b252_schedule_columns_test.mjs",
  "bz_erase_zrange_test.mjs",
  "help_reference_test.mjs",
  "waveb_designation_test.mjs",
]);

// The remaining genuinely-human checklist. Printed at the end of EVERY run so no one forgets a
// step the automation deliberately cannot take. Short, plain-English, in launch order.
export const MANUAL_CHECKLIST = [
  "Rebuild the unified DLL if any server predicate changed, then copy DLL + web together (predeploy prints the exact commands).",
  "Restart Dwarf Fortress ONCE and load the same fortress save.",
  "Pause in the tavern with multiple dwarves and the hungry animal on screen.",
  "Watch the same on-screen units in native and browser for 10-15 seconds.",
  "Count yellow DISTRACTED faces in both views; confirm they match.",
  "Confirm ordinary unmet needs no longer create mass false yellow faces.",
  "Confirm legit red mental-state / hunger / thirst / sleep / animal-hunger / activity bubbles are not displaced.",
  "Confirm there is no fort-wide synchronized disappearance of bubbles.",
  "Paused mutations: scratch squad, stockpile, item flag, unit nickname/labor, exact zone repaint, amount-one work order — each with before / after / reopen / cleanup evidence.",
  "Two-client runbook: modify or remove a scratch entity in client A while B has it open; B must refresh to truth or show an honest, closable unavailable state.",
  "Pan, refresh, reconnect, and do a fresh browser join to prove status words survive every transport route.",
  "Clean-VM install: install from the actual release zip on a clean Windows machine; a fresh friend joins from a browser with no local client.",
  "Capture native + browser screenshots/video for the release evidence record.",
  "the owner's visual verdict: list / selected / empty / deep-child-picker / success / refusal-or-unavailable states for every core family.",
];

// ---------------------------------------------------------------------------------------------
// small utils
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const u = ["KB", "MB", "GB"]; let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}
const C = { PASS: "PASS", FAIL: "FAIL", MANUAL: "MANUAL", WARN: "WARN", INFO: "INFO" };

function parseArgs(argv) {
  const out = { stage: "", jobs: 0, serial: false, json: false, dfRoot: "", witness: "",
                dfhackBuild: "", server: "http://localhost:8765", passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--stage=")) out.stage = a.slice("--stage=".length);
    else if (a === "--stage") out.stage = argv[++i] ?? "";
    else if (a.startsWith("--jobs=")) out.jobs = Number(a.slice("--jobs=".length)) || 0;
    else if (a === "--jobs") out.jobs = Number(argv[++i]) || 0;
    else if (a === "--serial") out.serial = true;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--df-root=")) out.dfRoot = a.slice("--df-root=".length);
    else if (a === "--df-root") out.dfRoot = argv[++i] ?? "";
    else if (a.startsWith("--witness=")) out.witness = a.slice("--witness=".length);
    else if (a === "--witness") out.witness = argv[++i] ?? "";
    else if (a.startsWith("--dfhack-build=")) out.dfhackBuild = a.slice("--dfhack-build=".length);
    else if (a === "--dfhack-build") out.dfhackBuild = argv[++i] ?? "";
    else if (a.startsWith("--server=")) out.server = a.slice("--server=".length);
    else if (a === "--server") out.server = argv[++i] ?? "";
    else if (a === "--help" || a === "-h") out.help = true;
    else out.passthrough.push(a);   // package stage forwards these to build_zip.mjs
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parallel suite runner. Exported so the self-test can drive it against stub suites in a temp dir
// without ever running the real 30. Spawns `node <file> <args>` with cwd = repoRoot, pools the
// spawns across `jobs` workers, and classifies each by exit code. A run whose output contains a
// standalone SKIP token and exited 0 is recorded as skipped, never a failure.
export async function runSuitesPool(suites, { repoRoot = REPO_ROOT, jobs = 0,
                                              onResult = null } = {}) {
  const width = jobs > 0 ? jobs : Math.max(1, Math.min(suites.length, os.cpus().length));
  const results = new Array(suites.length);
  let next = 0;

  function runOne(index) {
    const suite = suites[index];
    const started = Date.now();
    const args = suite.args || [];
    if (suite.platforms && !suite.platforms.includes(process.platform)) {
      const base = path.basename(suite.file);
      const res = {
        index, file: suite.file, base, group: suite.group || "",
        code: 0, ok: true, skipped: true, known: false, ms: 0,
        output: `SKIP: ${suite.file} runs on ${suite.platforms.join(", ")} (current platform: ${process.platform}).`,
      };
      results[index] = res;
      if (onResult) onResult(res);
      return Promise.resolve(res);
    }
    // Skip-if-absent: some suites (e.g. the parity-studio-coupled tests) are excluded from the
    // public distribution by PRE_PUBLISH_HISTORY_FILTER_PATHS.txt while remaining in the private
    // tree. A missing suite file is a clean SKIP with a logged notice here, never a spawn failure
    // that would read as a NO-GO. The private tree still has the files and runs them for real.
    if (!existsSync(path.join(repoRoot, suite.file))) {
      const base = path.basename(suite.file);
      const res = {
        index, file: suite.file, base, group: suite.group || "",
        code: 0, ok: true, skipped: true, known: KNOWN_FAILURES.has(base), ms: 0,
        output: `SKIP: ${suite.file} is absent from this distribution (excluded from the public tree; runs in the private tree).`,
      };
      results[index] = res;
      if (onResult) onResult(res);
      return Promise.resolve(res);
    }
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(repoRoot, suite.file), ...args],
        { cwd: repoRoot, windowsHide: true });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("error", (err) => { out += `\n[spawn error] ${err.message}`; finish(1); });
      child.on("close", (code) => finish(code == null ? 1 : code));
      function finish(code) {
        const base = path.basename(suite.file);
        const known = KNOWN_FAILURES.has(base);
        const skipped = code === 0 && /(^|\s)SKIP(\s|:)/.test(out);
        const res = {
          index, file: suite.file, base, group: suite.group || "",
          code, ok: code === 0, skipped, known, ms: Date.now() - started,
          output: out,
        };
        results[index] = res;
        if (onResult) onResult(res);
        resolve(res);
      }
    });
  }

  async function worker() {
    while (next < suites.length) { const i = next++; await runOne(i); }
  }
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

// Turn raw suite results into a launch verdict. tolerated = failed-but-known; failed = the rest.
export function classifySuites(results) {
  const passed = results.filter((r) => r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const tolerated = results.filter((r) => !r.ok && r.known);
  const failed = results.filter((r) => !r.ok && !r.known);
  return {
    passed, skipped, tolerated, failed,
    verdict: failed.length === 0 ? C.PASS : C.FAIL,
  };
}

// ---------------------------------------------------------------------------------------------
// STAGE 1 — suites
async function stageSuites(args, log) {
  log(`\n=== STAGE suites — offline evidence battery (${SUITES.length} suites, ${args.serial ? "serial" : `parallel x${args.jobs > 0 ? args.jobs : Math.min(SUITES.length, os.cpus().length)}`}) ===`);
  const started = Date.now();
  let done = 0;
  const results = await runSuitesPool(SUITES, {
    jobs: args.serial ? 1 : args.jobs,
    onResult: (r) => {
      done++;
      const tag = r.skipped ? "skip" : r.ok ? " ok " : r.known ? "known" : "FAIL";
      log(`  [${String(done).padStart(2)}/${SUITES.length}] ${tag}  ${r.base} (${(r.ms / 1000).toFixed(1)}s)`);
    },
  });
  const cls = classifySuites(results);
  const wall = (Date.now() - started) / 1000;
  log(`\n  passed ${cls.passed.length}  skipped ${cls.skipped.length}  tolerated-known-fail ${cls.tolerated.length}  UNEXPECTED-FAIL ${cls.failed.length}`);
  if (cls.tolerated.length) {
    log(`  tolerated (pre-existing, reported not gating):`);
    for (const r of cls.tolerated) log(`     - ${r.base} (exit ${r.code})`);
  }
  if (cls.failed.length) {
    log(`  UNEXPECTED FAILURES (each = NO-GO):`);
    for (const r of cls.failed) {
      log(`     - ${r.base} (exit ${r.code})`);
      const tail = r.output.trim().split(/\r?\n/).slice(-6).map((l) => `         ${l}`).join("\n");
      if (tail) log(tail);
    }
  }
  log(`  wall-clock ${wall.toFixed(1)}s`);
  return {
    stage: "suites", status: cls.verdict, wall,
    detail: { passed: cls.passed.length, skipped: cls.skipped.length,
              tolerated: cls.tolerated.map((r) => r.base),
              failed: cls.failed.map((r) => r.base) },
  };
}

// ---------------------------------------------------------------------------------------------
// STAGE 2 — build-check: does the compiled DLL exist under the NEW name, and is it fresh?
function stageBuildCheck(args, log) {
  log(`\n=== STAGE build-check — compiled dwf.plug.dll presence + freshness ===`);
  const res = resolveDfhackBuild(args.dfhackBuild ? { argv: ["--dfhack-build", args.dfhackBuild] } : {});
  if (!res.root) {
    log(`  [${C.FAIL}] no DFHack build tree resolved.`);
    log(missingDfhackBuildMessage(res, "build-check needs the compiled dwf.plug.dll").split("\n").map((l) => `    ${l}`).join("\n"));
    return { stage: "build-check", status: C.FAIL, detail: { reason: "no build tree" } };
  }
  const dll = builtDfcaptureDll(res.root);
  log(`  build tree: ${res.root} (${res.source})`);
  log(`  expected DLL: ${dll}`);
  if (!existsSync(dll)) {
    log(`  [${C.FAIL}] DLL ABSENT — nothing compiled here yet. Build the plugin, then re-run.`);
    return { stage: "build-check", status: C.FAIL, detail: { dll, present: false } };
  }
  const st = statSync(dll);
  const buf = readFileSync(dll);
  const digest = sha256(buf);
  log(`  sha256: ${digest}`);
  log(`  size:   ${st.size} bytes (${human(st.size)})`);
  log(`  mtime:  ${new Date(st.mtimeMs).toISOString()}`);

  // Staleness heuristic: newest src/*.cpp newer than the DLL => the DLL predates a source edit.
  const srcDir = path.join(REPO_ROOT, "src");
  let newest = 0, newestFile = "";
  if (existsSync(srcDir)) {
    for (const name of readdirSync(srcDir)) {
      if (!/\.(cpp|h|hpp|c)$/i.test(name)) continue;
      const m = statSync(path.join(srcDir, name)).mtimeMs;
      if (m > newest) { newest = m; newestFile = name; }
    }
  }
  let status = C.PASS;
  if (newest > st.mtimeMs) {
    status = C.WARN;
    log(`  [${C.WARN}] STALE? newest source src/${newestFile} (${new Date(newest).toISOString()}) is newer than the DLL — rebuild before deploy.`);
  } else {
    log(`  [${C.PASS}] DLL is newer than every src/* file (${newestFile ? `newest src/${newestFile}` : "no src files found"}).`);
  }
  return { stage: "build-check", status,
           detail: { dll, present: true, sha256: digest, size: st.size,
                     mtime: new Date(st.mtimeMs).toISOString(), newestSrc: newestFile } };
}

// ---------------------------------------------------------------------------------------------
// deploy_integrity_check driver (shared by predeploy + postdeploy). Runs it with --json and
// returns { ok, results } or { error }.
function runDeployIntegrity(args) {
  const script = path.join(REPO_ROOT, "tools", "harness", "deploy_integrity_check.mjs");
  const a = ["--json"];
  if (args.dfRoot) a.push("--df-root", args.dfRoot);
  if (args.witness) a.push("--witness", args.witness);
  if (args.dfhackBuild) a.push("--dfhack-build", args.dfhackBuild);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...a], { cwd: REPO_ROOT, windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ error: e.message }));
    child.on("close", (code) => {
      try { resolve({ code, parsed: JSON.parse(out) }); }
      catch { resolve({ code, error: (err || out || "no output").trim() }); }
    });
  });
}

function summarizeIntegrity(parsed, log) {
  for (const r of parsed.results) {
    log(`    [${r.status}] ${r.name}`);
    for (const l of r.lines) log(`        ${l}`);
    if (r.status === "FAIL" && r.fix) log(`        FIX: ${r.fix}`);
  }
}

// ---------------------------------------------------------------------------------------------
// STAGE 3 — predeploy: report-only integrity + the manual deploy commands (NEVER executed).
async function stagePredeploy(args, log) {
  log(`\n=== STAGE predeploy — expected deploy diff + manual copy commands (report only) ===`);
  const dfRoot = args.dfRoot || resolveDfRoot().root || "";
  const build = resolveDfhackBuild(args.dfhackBuild ? { argv: ["--dfhack-build", args.dfhackBuild] } : {});
  const dll = build.root ? builtDfcaptureDll(build.root) : "(build tree unresolved)";
  if (!dfRoot) {
    log(`  [${C.MANUAL}] no --df-root given and none autodetected; pass --df-root "C:\\...\\Dwarf Fortress" to see the exact diff.`);
  } else {
    const r = await runDeployIntegrity(args);
    if (r.parsed) {
      log(`  deploy_integrity_check (report-only, before the copy):`);
      summarizeIntegrity(r.parsed, log);
      log(`  NOTE: FAIL/stale lines here are the EXPECTED pre-deploy diff (new cache-busted assets + DLL not yet copied).`);
    } else {
      log(`  [${C.INFO}] deploy_integrity_check could not run cleanly: ${r.error}`);
    }
  }
  const depWeb = dfRoot ? path.join(dfRoot, "hack", "dfcapture-web") : "<DF>\\hack\\dfcapture-web";
  const depDll = dfRoot ? path.join(dfRoot, "hack", "plugins", "dwf.plug.dll") : "<DF>\\hack\\plugins\\dwf.plug.dll";
  const depLua = dfRoot ? path.join(dfRoot, "hack", "lua", "plugins", "dwf.lua") : "<DF>\\hack\\lua\\plugins\\dwf.lua";
  log(`\n  MANUAL DEPLOY — copy the DLL and web together, in one restart window (DO NOT run from this script):`);
  log(`    copy "${dll}" "${depDll}"`);
  log(`    xcopy /E /I /Y "${path.join(REPO_ROOT, "web")}" "${depWeb}"`);
  log(`    copy "${path.join(REPO_ROOT, "dwf.lua")}" "${depLua}"`);
  log(`  Then restart Dwarf Fortress once, and run:  node tools/release/launch_preflight.mjs --stage=postdeploy --df-root "${dfRoot || "C:\\...\\Dwarf Fortress"}"`);
  return { stage: "predeploy", status: C.MANUAL, detail: { dfRoot, dll } };
}

// ---------------------------------------------------------------------------------------------
// served-endpoint helpers for postdeploy
function httpGet(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => { if (!done) { done = true; resolve({ status: res.statusCode, body }); } });
    });
    req.on("error", (e) => { if (!done) { done = true; resolve({ error: e.code || e.message }); } });
    req.setTimeout(timeoutMs, () => { req.destroy(); if (!done) { done = true; resolve({ error: "timeout" }); } });
  });
}

// Cache tags = the ?v= / &v= token values on <script>/<link> URLs, sorted+unique. Mirrors the
// C++ assets_fingerprint() in src/session_routes.cpp so the served fingerprint is reproducible.
export function cacheTags(html) {
  const toks = [];
  const re = /[?&]v=([^&"'\s>]+)/g;
  let m;
  while ((m = re.exec(html))) toks.push(m[1]);
  return [...new Set(toks)].sort();
}
export function assetsFingerprint(html) {
  const joined = cacheTags(html).join("|");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < joined.length; i++) { h ^= joined.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

// STAGE 4 — postdeploy: full integrity pass + served build stamp / cache tags match the repo.
async function stagePostdeploy(args, log) {
  log(`\n=== STAGE postdeploy — full integrity pass + served build proof ===`);
  let status = C.PASS;
  const detail = {};

  // (a) full deploy-integrity pass
  if (!(args.dfRoot || resolveDfRoot().root)) {
    log(`  [${C.MANUAL}] no --df-root; cannot verify the deployed tree.`);
    status = C.MANUAL;
  } else {
    const r = await runDeployIntegrity(args);
    if (r.parsed) {
      summarizeIntegrity(r.parsed, log);
      const ok = r.parsed.ok === true;
      log(`  deploy_integrity: ${ok ? C.PASS : C.FAIL} (expected full PASS after deploy)`);
      detail.integrity = ok;
      if (!ok) status = C.FAIL;
    } else {
      log(`  [${C.INFO}] deploy_integrity_check could not run cleanly: ${r.error}`);
      status = C.MANUAL;
    }
  }

  // (b) served /version + /view vs repo
  const repoIndexPath = path.join(REPO_ROOT, "web", "index.html");
  const repoIndex = existsSync(repoIndexPath) ? readFileSync(repoIndexPath, "utf8") : "";
  const repoTags = cacheTags(repoIndex);
  const repoFp = assetsFingerprint(repoIndex);
  log(`  repo cache-tag fingerprint: ${repoFp} (${repoTags.length} tags)`);

  const ver = await httpGet(`${args.server}/version`);
  if (ver.error) {
    log(`  [${C.MANUAL}] server not reachable at ${args.server}/version (${ver.error}) — start DF, then re-run.`);
    if (status === C.PASS) status = C.MANUAL;
  } else {
    let v = {};
    try { v = JSON.parse(ver.body); } catch { /* leave empty */ }
    log(`  served /version: build="${v.build ?? "?"}" git="${v.git ?? "?"}" assets="${v.assets ?? "?"}"`);
    detail.servedBuild = v.build; detail.servedAssets = v.assets;
    if (v.assets && v.assets === repoFp) {
      log(`  [${C.PASS}] served assets fingerprint matches the repo (${repoFp}).`);
    } else if (v.assets) {
      log(`  [${C.FAIL}] served assets fingerprint ${v.assets} != repo ${repoFp} — deployed web/index.html cache tags differ from the repo.`);
      status = C.FAIL;
    }
    const view = await httpGet(`${args.server}/view`);
    if (view.error) {
      log(`  [${C.INFO}] /view not reachable (${view.error}).`);
    } else {
      if (view.body.includes("__DFCAPTURE_BUILD__")) {
        log(`  [${C.FAIL}] served /view still contains the raw __DFCAPTURE_BUILD__ placeholder — stamp did not run.`);
        status = C.FAIL;
      } else {
        const servedTags = cacheTags(view.body);
        const same = servedTags.length === repoTags.length && servedTags.every((t, i) => t === repoTags[i]);
        log(`  [${same ? C.PASS : C.FAIL}] served /view cache tags ${same ? "match" : "DIFFER from"} the repo (${servedTags.length} served vs ${repoTags.length} repo).`);
        if (!same) status = C.FAIL;
      }
    }
  }
  return { stage: "postdeploy", status, detail };
}

// ---------------------------------------------------------------------------------------------
// STAGE 5 — package: build the zip, verify it with the two fixtures, record hashes.
async function stagePackage(args, log) {
  log(`\n=== STAGE package — build_zip.mjs + zip fixtures -> launch-manifest.json ===`);
  let buildResult;
  try {
    const mod = await import("./build_zip.mjs");
    // Re-parse the pass-through argv exactly as build_zip's own CLI would.
    const parsed = packageArgs(args.passthrough);
    buildResult = mod.buildReleaseZip(parsed);
    log(`  built: ${buildResult.output}`);
    log(`  Node v${buildResult.nodeVersion} sha256 ${buildResult.nodeSha256}`);
  } catch (e) {
    log(`  [${C.FAIL}] build_zip failed: ${e.message}`);
    log(`  (package stage needs: --version <v> --node-version <v> --node-exe <path> --node-sha256 <sha>; --node-license <path> is optional when LICENSE is beside node.exe)`);
    return { stage: "package", status: C.FAIL, detail: { error: e.message } };
  }

  const zipBuf = readFileSync(buildResult.output);
  const zipSha = sha256(zipBuf);
  log(`  zip sha256: ${zipSha}  size ${human(zipBuf.length)}`);

  // Verify the packaged artifact with the same fixtures the suite battery uses.
  let status = C.PASS;
  for (const suite of ["tools/harness/release_zip_fixture_test.mjs",
                       "tools/harness/pkg_install_roundtrip_test.mjs"]) {
    const [r] = await runSuitesPool([{ file: suite }], { jobs: 1 });
    log(`  [${r.ok ? C.PASS : C.FAIL}] ${path.basename(suite)} (${(r.ms / 1000).toFixed(1)}s)`);
    if (!r.ok) { status = C.FAIL; log(r.output.trim().split(/\r?\n/).slice(-8).map((l) => `      ${l}`).join("\n")); }
  }

  const manifest = {
    generated: new Date().toISOString(),
    version: buildResult.version,
    zip: path.basename(buildResult.output),
    zipSha256: zipSha,
    zipSize: zipBuf.length,
    nodeVersion: buildResult.nodeVersion,
    nodeSha256: buildResult.nodeSha256,
    files: buildResult.files,
  };
  const manifestPath = path.join(path.dirname(buildResult.output), "launch-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  log(`  wrote ${manifestPath} (${manifest.files.length} inner files hashed via the zip)`);
  return { stage: "package", status, detail: { zipSha256: zipSha, manifest: manifestPath } };
}

// Map the pass-through argv to build_zip.mjs option names (a subset of its own parseArgs).
function packageArgs(argv) {
  const names = new Map([
    ["--version", "version"], ["--node-version", "nodeVersion"], ["--node-exe", "nodeExe"],
    ["--node-license", "nodeLicense"],
    ["--node-sha256", "nodeSha256"], ["--dfhack-sha256", "dfhackSha256"],
    ["--cloudflared-sha256", "cloudflaredSha256"], ["--host", "hostDir"],
    ["--release", "releaseDir"], ["--output-dir", "outputDir"],
    ["--source-commit", "sourceCommit"], ["--platform", "platform"],
  ]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = names.get(argv[i]);
    if (!key) continue;
    out[key] = argv[++i];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// orchestration
function printManual(log) {
  log(`\n=== REMAINING MANUAL CHECKLIST (the automation cannot take these) ===`);
  MANUAL_CHECKLIST.forEach((item, i) => log(`  ${String(i + 1).padStart(2)}. ${item}`));
}

function printSummary(stages, log) {
  log(`\n=== GO / NO-GO SUMMARY ===`);
  for (const s of stages) log(`  ${s.status.padEnd(6)} ${s.stage}`);
  const blocked = stages.some((s) => s.status === C.FAIL);
  const verdict = blocked ? "NO-GO" : "GO (offline gates clear; manual checklist still owed)";
  log(`\n  >>> ${verdict} <<<`);
  return blocked ? 1 : 0;
}

async function dispatch(stage, args, log) {
  switch (stage) {
    case "suites": return [await stageSuites(args, log)];
    case "build-check": return [stageBuildCheck(args, log)];
    case "predeploy": return [await stagePredeploy(args, log)];
    case "postdeploy": return [await stagePostdeploy(args, log)];
    case "package": return [await stagePackage(args, log)];
    case "all": {
      const stages = [];
      stages.push(await stageSuites(args, log));
      stages.push(stageBuildCheck(args, log));
      stages.push(await stagePredeploy(args, log));
      log(`\n  (--stage=all stops here — deploy is a human step; run --stage=postdeploy after the copy + restart.)`);
      return stages;
    }
    default:
      throw new Error(`unknown stage: "${stage}". Use one of: suites, build-check, predeploy, postdeploy, package, all.`);
  }
}

export const STAGES = ["suites", "build-check", "predeploy", "postdeploy", "package", "all"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = [];
  const log = (m) => { lines.push(m); if (!args.json) console.log(m); };
  if (args.help || !args.stage) {
    console.log("Usage: node tools/release/launch_preflight.mjs --stage=<suites|build-check|predeploy|postdeploy|package|all> [--df-root <p>] [--witness <s>] [--dfhack-build <p>] [--jobs <n>] [--serial] [--server <url>] [--json]");
    console.log("       package stage forwards --version/--node-version/--node-exe/--node-sha256 (etc.) to build_zip.mjs");
    process.exit(args.stage ? 0 : 2);
  }
  let stages;
  try { stages = await dispatch(args.stage, args, log); }
  catch (e) { console.error(`launch_preflight: ${e.message}`); process.exit(2); }
  printManual(log);
  const exit = printSummary(stages, log);
  if (args.json) {
    console.log(JSON.stringify({
      stage: args.stage,
      goNoGo: exit === 0 ? "GO" : "NO-GO",
      stages: stages.map((s) => ({ stage: s.stage, status: s.status, detail: s.detail })),
      manual: MANUAL_CHECKLIST,
    }, null, 2));
  }
  process.exit(exit);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
