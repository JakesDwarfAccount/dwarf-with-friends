// tools/predeploy-gate.mjs — WS5 deploy gate. Runs static checks, the load
// harness, and the crash-repro suite; exits non-zero unless everything
// passed. NO deploy to F:\...\Dwarf Fortress may happen unless this exits 0
// (JS-only deploys with no active session may use --static-only). Spec §6-WS5.
// Part of Dwarf With Friends (dwf). License: AGPL-3.0-only. Node >= 18, zero external deps.
//
// Full gate: node tools/predeploy-gate.mjs --df "C:\...\Dwarf Fortress"
//            [--url http://127.0.0.1:8765] [--thresholds ws1] [--baseline-fps n]
//            [--password pw] [--skip-operator]
// JS-only:   node tools/predeploy-gate.mjs --static-only
// Dry-run:   node tools/predeploy-gate.mjs --stub-only     (starts its own stub)

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, sleep } from "./lib/mdutil.mjs";

const args = parseArgs(process.argv.slice(2), {
  url: "http://127.0.0.1:8765", df: "", thresholds: "ws1", "baseline-fps": "",
  password: "", "static-only": false, "stub-only": false, "skip-operator": false,
});
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
let skips = 0;

function record(name, code) {
  results.push({ name, result: code === 0 ? "PASS" : `FAIL(exit ${code})` });
  return code === 0;
}
function runNode(name, scriptArgs) {
  console.log(`\n=== gate: ${name} ===`);
  const r = spawnSync(process.execPath, scriptArgs, { cwd: ROOT, stdio: "inherit" });
  return record(name, r.status ?? 1);
}
function walk(dir, exts, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p, exts, out); }
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}
function summaryAndExit() {
  console.log("\n=== predeploy-gate summary ===");
  for (const r of results) console.log(`${r.result.padEnd(14)} ${r.name}`);
  const failed = results.filter((r) => r.result !== "PASS").length;
  if (failed) { console.log("GATE: BLOCKED — do not deploy to F:"); process.exit(1); }
  if (skips) { console.log("GATE: PASS-WITH-SKIPS — the owner must approve the skipped items"); process.exit(0); }
  console.log("GATE: PASS — deployable (executes the copy to F:)");
  process.exit(0);
}

(async () => {
  // 1. Static: node --check every tools .mjs and web .js file.
  const files = [...walk(path.join(ROOT, "tools"), [".mjs"]),
                 ...walk(path.join(ROOT, "web", "js"), [".js"])];
  let staticOk = true;
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { stdio: "pipe" });
    if (r.status !== 0) {
      staticOk = false;
      console.error(`syntax FAIL: ${f}\n${r.stderr}`);
    }
  }
  record(`static syntax (${files.length} files)`, staticOk ? 0 : 1);
  if (args["static-only"]) summaryAndExit();

  // 2. Stub-only dry run: prove the harness machinery end-to-end without DF.
  if (args["stub-only"]) {
    const stub = spawn(process.execPath, [path.join(ROOT, "tools", "stub-server.mjs"), "--port", "8771"],
      { cwd: ROOT, stdio: "ignore" });
    await sleep(1000);
    runNode("loadtest vs stub", [
      path.join(ROOT, "tools", "loadtest.mjs"), "--url", "http://127.0.0.1:8771",
      "--players", "4", "--duration", "10", "--steady", "5", "--idle", "5",
      "--thresholds", "ws1", "--baseline-fps", "5", "--stub-pause",
    ]);
    stub.kill();
    summaryAndExit();
  }

  // 3. Live gate (needs a live session + --df).
  if (!args.df) {
    console.error("gate: --df is required for the full gate (or use --static-only / --stub-only)");
    process.exit(2);
  }
  const common = ["--url", args.url, "--df", args.df];
  if (args.password) common.push("--password", args.password);

  const lt = [path.join(ROOT, "tools", "loadtest.mjs"), ...common,
    "--players", "4", "--duration", "30", "--thresholds", args.thresholds,
    "--designate-rate", "0"];
  if (args["baseline-fps"]) lt.push("--baseline-fps", args["baseline-fps"]);
  runNode(`loadtest (${args.thresholds}, 4 players)`, lt);

  runNode("repro: save-spam x20",
    [path.join(ROOT, "tools", "repro", "save-spam.mjs"), ...common]);
  runNode("repro: unit-window",
    [path.join(ROOT, "tools", "repro", "unit-window.mjs"), ...common]);
  if (args["skip-operator"]) {
    console.warn("\n*** WARNING: world-unload repro SKIPPED (--skip-operator) — the owner must approve ***");
    results.push({ name: "repro: world-unload — SKIPPED (needs the owner approval)", result: "PASS" });
    skips++;
  } else {
    runNode("repro: world-unload (operator-assisted)",
      [path.join(ROOT, "tools", "repro", "world-unload.mjs"), ...common]);
  }
  summaryAndExit();
})().catch((e) => { console.error("gate: fatal:", e); process.exit(2); });
