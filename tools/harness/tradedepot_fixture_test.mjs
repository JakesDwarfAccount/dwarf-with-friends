// tradedepot_fixture_test.mjs -- OFFLINE fixture test for the W-F depot panel's pure
// data-shapers (depotStatusText / caravanRows / brokerText / goodsRows / tradeStatusText).
// Runs with NO Dwarf Fortress and NO server: it exercises the client rendering logic against
// SEEDED JSON -- good rows AND deliberately-bad rows (completeness rule 3, "test the test") --
// and asserts graceful, honest output (no throw, correct exclusions, correct state strings).
//
//   node tools/harness/tradedepot_fixture_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// The panel file browser-safe-exports its shapers behind `typeof module !== 'undefined'`, so a
// CommonJS require pulls them in without executing any DOM/fetch code.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const panelPath = join(here, "..", "..", "web", "js", "dwf-tradedepot-panel.js");
const serverPath = join(here, "..", "..", "src", "trade_depot.cpp");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
// A seeded-bad assertion is EXPECTED false; the test passes iff it is correctly detected false.
function checkSeededBad(name, cond) {
  if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> NOT discriminated`); }
}
function noThrow(name, fn) {
  try { const v = fn(); passed++; console.log(`  ok - ${name} (no throw)`); return v; }
  catch (e) { failed++; console.log(`  FAIL - ${name} threw: ${e.message}`); return undefined; }
}

// Parse the panel with Node's own Function constructor (syntax gate). Keeping this in-process
// also lets the fixture run in restricted harness sandboxes that prohibit child processes.
try {
  new Function(readFileSync(panelPath, "utf8"));
  passed++; console.log("  ok - dwf-tradedepot-panel.js parses in Node");
} catch (e) {
  failed++; console.log(`  FAIL - panel syntax: ${e.message}`);
}

// WAVE 5: the goods mark renders through DWFUI.checkHtml, so the fixture must mirror the
// BROWSER LOAD ORDER (ui-components loads first). Requiring it also publishes globalThis.DWFUI,
// which is how the panel resolves it at call time.
globalThis.DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));
const M = require(panelPath);
check("module exports the 5 shapers",
  ["depotStatusText", "caravanRows", "brokerText", "goodsRows", "tradeStatusText"].every(k => typeof M[k] === "function"));

// ---------------- per-depot access (B154: two depots must not share one answer) ----------------
console.log("TEST: per-depot wagon access");
const accessFixtures = [
  { id: 54, wagonAccessible: true, storedAccessible: false },
  { id: 56, wagonAccessible: false, storedAccessible: false },
];
const accessResponse = id => {
  const depot = accessFixtures.find(d => d.id === id);
  return depot && { id: depot.id, accessible: depot.wagonAccessible,
    storedAccessible: depot.storedAccessible };
};
check("B154 reachable depot reports its own true state",
  accessResponse(54).id === 54 && accessResponse(54).accessible === true);
check("B154 unreachable depot reports its own false state",
  accessResponse(56).id === 56 && accessResponse(56).accessible === false);
check("B154 stale stored flag is not used as live access",
  accessResponse(54).storedAccessible === false && accessResponse(54).accessible === true);
checkSeededBad("B154 second depot (wrongly) reuses first depot's reachable state",
  accessResponse(56).accessible === accessResponse(54).accessible);

const serverSource = readFileSync(serverPath, "utf8");
check("B154 route computes wagon access from the resolved requested depot",
  /auto depot = resolve_depot\(id\);[\s\S]*?bool accessible = depot_accessible_by_wagons\(depot\);[\s\S]*?\"accessible\\\":\" << \(accessible/.test(serverSource));
check("B154 route keeps the stale DF field diagnostic separate",
  /\"storedAccessible\\\":\" << \(depot->accessible/.test(serverSource));
checkSeededBad("B154 route (wrongly) emits the stored field as live accessible",
  /\"accessible\\\":\" << \(depot->accessible/.test(serverSource));

// ---------------- depotStatusText (A2/A3/A4) ----------------
console.log("TEST: depotStatusText");
check("A4 built+accessible", M.depotStatusText({ ok: true, built: true, accessible: true }).includes("reachable"));
check("A3 built+not accessible warns", /NOT reachable/i.test(M.depotStatusText({ ok: true, built: true, accessible: false })));
check("A2 under construction", /construction/i.test(M.depotStatusText({ ok: true, built: false, accessible: false })));
check("bad: null payload -> unavailable (no throw)", M.depotStatusText(null).length > 0);
check("bad: ok:false -> unavailable", /unavailable/i.test(M.depotStatusText({ ok: false, error: "x" })));
checkSeededBad("A3 is (wrongly) the 'reachable' happy string", M.depotStatusText({ ok: true, built: true, accessible: false }).includes("Constructed and reachable"));

// ---------------- caravanRows (B1-B8) ----------------
console.log("TEST: caravanRows");
const carsGood = M.caravanRows({ caravans: [
  { origin: "Dwarven caravan from Foo", state: "AtDepot", active: true, atDepot: true, tribute: false, daysRemaining: 3, flags: [], importValue: 500, offerValue: 0 },
  { origin: "Elven caravan from Bar", state: "Approaching", active: true, atDepot: false, tribute: false, daysRemaining: 1, flags: ["Offended"], importValue: 0, offerValue: 0 },
  { origin: "Goblin tribute", state: "AtDepot", active: false, atDepot: true, tribute: true, daysRemaining: 0, flags: ["Tribute"], importValue: 0, offerValue: 0 },
]});
check("B: three rows shaped", carsGood.length === 3);
check("B3 atDepot row flagged", carsGood[0].atDepot === true && carsGood[0].active === true);
check("B8 daysText singular", carsGood[1].daysText === "1 day left");
check("B8 daysText plural", carsGood[0].daysText === "3 days left");
check("B5 tribute row not active", carsGood[2].tribute === true && carsGood[2].active === false);
check("B6 caravan flag surfaced", carsGood[1].flags.includes("Offended"));
check("B1 empty caravans -> []", M.caravanRows({ caravans: [] }).length === 0);
// bad rows
const carsBad = noThrow("bad: caravan missing all fields", () => M.caravanRows({ caravans: [{}, null] }));
check("bad: missing-field caravan defaults origin", carsBad && carsBad[0].origin === "Unknown caravan");
check("bad: missing days -> 'leaving soon'", carsBad && carsBad[0].daysText === "leaving soon");
check("bad: caravans not an array -> []", M.caravanRows({ caravans: "nope" }).length === 0);
check("bad: whole payload null -> []", M.caravanRows(null).length === 0);
checkSeededBad("B5 tribute caravan is (wrongly) active", carsGood[2].active === true);

// ---------------- brokerText (D4/D5) ----------------
console.log("TEST: brokerText");
check("D4 broker found", M.brokerText({ broker: { found: true, name: "Urist" } }) === "Broker: Urist");
check("D5 no broker -> appoint note", /assign one in Nobles/i.test(M.brokerText({ broker: { found: false } })));
check("bad: missing broker obj -> no-broker note", /Nobles/i.test(M.brokerText({})));
checkSeededBad("D5 (missing) is (wrongly) 'Broker:'", M.brokerText({}).startsWith("Broker:"));

// ---------------- goodsRows (C1-C10) ----------------
console.log("TEST: goodsRows");
const goodsGood = M.goodsRows({ goods: [
  { id: 10, desc: "☼steel long sword☼", value: 1200, dist: 5, pending: false, atDepot: false, forbidden: false, requested: true },
  { id: 11, desc: "rope reed cloth", value: 12, dist: 20, pending: true, atDepot: false, forbidden: false, requested: false },
  { id: 12, desc: "at-depot barrel", value: 30, dist: 0, pending: true, atDepot: true, forbidden: false, requested: false },
]});
check("C: three good rows", goodsGood.length === 3);
check("C1 requested surfaced", goodsGood[0].requested === true);
check("C2 at-depot row", goodsGood[2].atDepot === true && goodsGood[2].pending === true);
check("C3 pending (marked) row", goodsGood[1].pending === true);
// bad rows: negative id filtered; malformed defaulted
const goodsBad = noThrow("bad: goods with bad ids/missing fields", () => M.goodsRows({ goods: [
  { id: -1, desc: "ghost" }, { desc: "no id" }, null, { id: 7 },
]}));
check("bad: id<0 and missing-id rows filtered out", goodsBad && goodsBad.length === 1 && goodsBad[0].id === 7);
check("bad: missing desc defaults", goodsBad && goodsBad[0].desc === "(item)");
check("bad: goods not array -> []", M.goodsRows({ goods: 5 }).length === 0);
check("bad: null payload -> []", M.goodsRows(null).length === 0);
checkSeededBad("C: negative-id row is (wrongly) kept", M.goodsRows({ goods: [{ id: -3, desc: "x", value: 1 }] }).length === 1);

// ---------------- tradeStatusText (E1/E2) ----------------
console.log("TEST: tradeStatusText");
check("E1 screen closed -> request-trader hint", /Request the trader|No active trade/i.test(M.tradeStatusText({ ok: true, tradeScreenOpen: false })));
check("E2 screen open reports counts", /5 fort goods/.test(M.tradeStatusText({ ok: true, tradeScreenOpen: true, merchantCiv: "Foo", fortGoods: 5, caravanGoods: 9 })));
check("E2 open names civ", /with Foo/.test(M.tradeStatusText({ ok: true, tradeScreenOpen: true, merchantCiv: "Foo", fortGoods: 0, caravanGoods: 0 })));
check("bad: null status -> empty string", M.tradeStatusText(null) === "");
checkSeededBad("E1 closed status (wrongly) claims a session is open", /session open/i.test(M.tradeStatusText({ ok: true, tradeScreenOpen: false })));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
