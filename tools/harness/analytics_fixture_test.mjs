// analytics_fixture_test.mjs -- OFFLINE fixture test for the WT13 fortress-activity aggregator's
// pure shapers (analyticsAggregate / analyticsWindowLabel + the ANALYTICS_* tables). No Dwarf
// Fortress and no server: seeded /attrib payloads spanning the matrix (multi-player, multi-kind,
// empty, garbage/unknown-creator, single-player) plus deliberately-bad rows (completeness rule 3,
// "test the test") that MUST be discriminated.
//
//   node tools/harness/analytics_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-analytics-panel.js");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
function checkGuard(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}
function noThrow(name, fn) {
  try { const v = fn(); passed++; console.log(`  ok - ${name} (no throw)`); return v; }
  catch (e) { failed++; console.log(`  FAIL - ${name} threw: ${e.message}`); return undefined; }
}

try {
  execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-analytics-panel.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

const M = require(modPath);
check("module exports the pure shapers + tables",
  ["analyticsAggregate", "analyticsWindowLabel", "ANALYTICS_KINDS", "ANALYTICS_UNTRACKED"]
    .every(k => M[k] !== undefined));
check("the four attributed kinds match the /attrib section names (attribution.cpp map_for)",
  M.ANALYTICS_KINDS.map(k => k.key).sort().join(",") === "buildings,orders,stockpiles,zones");

// ---------------- analyticsAggregate: real, multi-player, multi-kind ----------------
console.log("\n# analyticsAggregate (real data)");
{
  // guest: 2 constructions + 1 stockpile = 3 ; host: 1 construction + 1 room = 2 ; visitor: 1 order = 1
  const agg = M.analyticsAggregate({
    world: "region1",
    buildings: { "10": "guest", "11": "guest", "12": "host" },
    zones: { "5": "host" },
    stockpiles: { "9": "guest" },
    orders: { "40": "visitor" },
  });
  check("world preserved", agg.world === "region1");
  check("grandTotal = every attributed id (6)", agg.grandTotal === 6);
  check("per-kind grand tallies", agg.grand.buildings === 3 && agg.grand.zones === 1 &&
    agg.grand.stockpiles === 1 && agg.grand.orders === 1);
  check("playerCount = distinct creators (3)", agg.playerCount === 3);
  check("players sorted by total desc (guest, host, visitor)",
    agg.players.map(p => p.name).join(",") === "guest,host,visitor");
  check("guest total 3 with per-kind counts",
    agg.players[0].name === "guest" && agg.players[0].total === 3 &&
    agg.players[0].counts.buildings === 2 && agg.players[0].counts.stockpiles === 1);
  check("busiest = guest / 3", agg.fun.busiest && agg.fun.busiest.name === "guest" && agg.fun.busiest.total === 3);
  check("topBuilder = most CONSTRUCTIONS (guest / 2)",
    agg.fun.topBuilder && agg.fun.topBuilder.name === "guest" && agg.fun.topBuilder.count === 2);
  check("not empty", agg.empty === false);
  // TEST-THE-TEST: a construction id is NOT a work order -- cross-section counts must not bleed.
  checkGuard("orders tally is exactly the orders section (1), not buildings",
    agg.grand.orders === 1 && agg.grand.buildings !== agg.grand.orders);
}
// Tie-break: equal totals sort by name asc.
{
  const agg = M.analyticsAggregate({ buildings: { "1": "zed", "2": "amy" } });
  check("equal-total players tie-break by name (amy before zed)",
    agg.players.map(p => p.name).join(",") === "amy,zed");
}

// ---------------- window labeling ----------------
console.log("\n# analyticsWindowLabel (honest window)");
{
  const w = M.analyticsWindowLabel();
  check("names the window as this session / since fort load", /session/i.test(w) && /since the fort was loaded/i.test(w));
  check("says it RESETS on host restart (survives refresh, not restart)", /reset/i.test(w) && /restart/i.test(w));
  // TEST-THE-TEST: the window must NEVER be sold as all-time.
  checkGuard("does NOT claim all-time / forever", !/all[- ]?time/i.test(w) && !/forever/i.test(w));
}

// ---------------- empty state (no actions yet) ----------------
console.log("\n# empty state");
{
  const agg = M.analyticsAggregate({ world: "region1" });
  check("no sections -> empty:true, grandTotal 0, no players",
    agg.empty === true && agg.grandTotal === 0 && agg.players.length === 0);
  check("no fabricated fun stats on empty", agg.fun.busiest === null && agg.fun.topBuilder === null);
  const agg2 = M.analyticsAggregate({ buildings: {}, zones: {}, stockpiles: {}, orders: {} });
  checkGuard("all-empty sections still read empty (never a phantom count)", agg2.empty === true && agg2.grandTotal === 0);
}

// ---------------- unknown-creator / garbage degrade ----------------
console.log("\n# unknown-creator + garbage degrade");
{
  // numeric + empty creator values must NOT count; a valid string alongside them does.
  const agg = M.analyticsAggregate({ buildings: { "5": 999, "6": "", "7": "ok", "8": null }, orders: "not-an-object" });
  check("only the valid string creator is counted (1)", agg.grandTotal === 1 && agg.grand.buildings === 1);
  check("the valid creator is 'ok'", agg.players.length === 1 && agg.players[0].name === "ok");
  checkGuard("numeric creator 999 is NOT counted (would fabricate a player)", !agg.players.some(p => p.name === "999" || p.name === 999));
  checkGuard("non-object section -> ignored, not crash", agg.grand.orders === 0);
}
noThrow("analyticsAggregate(null)", () => M.analyticsAggregate(null));
noThrow("analyticsAggregate(42)", () => M.analyticsAggregate(42));
noThrow("analyticsAggregate(undefined)", () => M.analyticsAggregate());
noThrow("analyticsAggregate([])", () => M.analyticsAggregate([]));

// ---------------- untracked-gaps table (honesty surface) ----------------
console.log("\n# untracked gaps");
{
  check("gaps list is non-empty and each has a label + note",
    Array.isArray(M.ANALYTICS_UNTRACKED) && M.ANALYTICS_UNTRACKED.length >= 3 &&
    M.ANALYTICS_UNTRACKED.every(u => u.label && u.note));
  check("digging is listed as not-tracked (it is a designation, no id)",
    M.ANALYTICS_UNTRACKED.some(u => /dig/i.test(u.label)));
  // TEST-THE-TEST: a tracked kind must NOT also appear as an untracked gap (no double-story).
  const gapText = M.ANALYTICS_UNTRACKED.map(u => u.label.toLowerCase()).join(" | ");
  checkGuard("work orders (a TRACKED kind) is not also listed as a gap", !/work order/.test(gapText));
}

// ---------------- summary ----------------
console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
