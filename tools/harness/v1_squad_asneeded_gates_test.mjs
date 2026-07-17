// v1_squad_asneeded_gates_test.mjs -- v1 gap-closure regression for the AS_NEEDED squad-appointable
// sub-gates.
//
// Context: src/squads.cpp / src/fort_admin.cpp gained position_is_as_needed_squad_appointable so a
// militia captain seat stays creatable while DF's possible_appointable is empty. b293 pins that the
// C++ predicate MENTIONS the replacement / population / market clauses, but its asNeededSquadCase
// over-determines the one excluded position (COTG fails population AND market AND is capped at once),
// so dropping the market or population clause from the model still yields the same creatable list --
// those sub-gates rest only on a source-regex, never on behavior.
//
// This suite models the predicate BEHAVIORALLY (the exact way b293's fixture model does) against a
// fixture whose three excluded variants are each clean on EVERY gate but one. That makes each
// exclusion attributable to a single clause, and a seeded-bad guard drops that clause and proves the
// variant flips to creatable -- i.e. the market, population, and replacement clauses are each
// load-bearing, not decorative.
//
//   node tools/harness/v1_squad_asneeded_gates_test.mjs   (exit 0 PASS / 1 FAIL)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fx = JSON.parse(readFileSync(join(root, "tools/harness/fixtures/v1-squad-asneeded-gates.json"), "utf8"));

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
};
const guard = (name, cond, extra) => check(`(test-the-test) ${name}`, cond, extra);

// ---- the predicate model (mirrors b293's asNeededSquadCase model, clause-for-clause) ------------
// `opts` lets a seeded-bad run drop exactly one basicEligible clause to prove it is load-bearing.
function creatableIds(fx, opts = {}) {
  const byId = new Map(fx.positions.map(p => [p.id, p]));
  const offered = new Set(fx.possibleAppointable.map(a => a.positionId));
  const basicEligible = p =>
    (opts.dropReplacement ? true : !p.hasBeenReplaced) &&
    (opts.dropPopulation ? true : (p.requiresPopulation <= 0 || p.hasMetPopulationRequirement)) &&
    (opts.dropMarket ? true : (!p.requiresMarket || p.hasMetMarketRequirement));
  const hasHeldAppointer = p => p.appointedBy.some(appointerId =>
    fx.assignments.some(a => a.positionId === appointerId && a.histfig >= 0));
  const asNeededAvailable = p => basicEligible(p) && p.squadSize > 0 &&
    p.number < 0 && p.appointedBy.length > 0 && hasHeldAppointer(p);
  return fx.positions.filter(p => basicEligible(p) && p.squadSize > 0 &&
    (offered.has(p.id) || asNeededAvailable(p)) &&
    (p.number < 0 || fx.assignments.filter(a => a.positionId === p.id).length < p.number))
    .map(p => p.id);
}

const V = fx.gateVariants;

console.log("# only the clean AS_NEEDED captain is creatable; each gated variant is excluded");
const creatable = creatableIds(fx);
check("creatable set matches the fixture's expected list", JSON.stringify(creatable) === JSON.stringify(fx.expectedCreatablePositionIds),
  `got ${JSON.stringify(creatable)}`);
check(`the clean AS_NEEDED captain (id ${V.clean}) is creatable`, creatable.includes(V.clean));
check(`the market-gated captain (id ${V.market}) is excluded`, !creatable.includes(V.market));
check(`the population-gated captain (id ${V.population}) is excluded`, !creatable.includes(V.population));
check(`the replaced captain (id ${V.replacement}) is excluded`, !creatable.includes(V.replacement));

console.log("# each excluded variant differs from the clean one by exactly one gate field");
const byId = new Map(fx.positions.map(p => [p.id, p]));
const clean = byId.get(V.clean);
const diffFields = (a, b) => ["requiresPopulation", "hasMetPopulationRequirement", "requiresMarket",
  "hasMetMarketRequirement", "hasBeenReplaced", "number", "squadSize"]
  .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
check("market variant is clean except population/market? -> only its market gate differs",
  JSON.stringify(diffFields(byId.get(V.market), clean)) === JSON.stringify(["requiresMarket"]),
  `differs in ${JSON.stringify(diffFields(byId.get(V.market), clean))}`);
check("population variant differs only in its population gate fields",
  JSON.stringify(diffFields(byId.get(V.population), clean).sort()) === JSON.stringify(["hasMetPopulationRequirement", "requiresPopulation"]),
  `differs in ${JSON.stringify(diffFields(byId.get(V.population), clean))}`);
check("replaced variant differs only in hasBeenReplaced",
  JSON.stringify(diffFields(byId.get(V.replacement), clean)) === JSON.stringify(["hasBeenReplaced"]),
  `differs in ${JSON.stringify(diffFields(byId.get(V.replacement), clean))}`);

console.log("# seeded-bad: dropping each clause flips ITS variant to creatable (clause is load-bearing)");
const dropMarket = creatableIds(fx, { dropMarket: true });
guard(`dropping the market clause makes the market-gated captain (id ${V.market}) creatable`,
  dropMarket.includes(V.market) && !creatable.includes(V.market));
guard("dropping the market clause does not disturb the population/replacement exclusions",
  !dropMarket.includes(V.population) && !dropMarket.includes(V.replacement));

const dropPop = creatableIds(fx, { dropPopulation: true });
guard(`dropping the population clause makes the population-gated captain (id ${V.population}) creatable`,
  dropPop.includes(V.population) && !creatable.includes(V.population));
guard("dropping the population clause does not disturb the market/replacement exclusions",
  !dropPop.includes(V.market) && !dropPop.includes(V.replacement));

const dropReplaced = creatableIds(fx, { dropReplacement: true });
guard(`dropping the replacement clause makes the replaced captain (id ${V.replacement}) creatable`,
  dropReplaced.includes(V.replacement) && !creatable.includes(V.replacement));
guard("dropping the replacement clause does not disturb the market/population exclusions",
  !dropReplaced.includes(V.market) && !dropReplaced.includes(V.population));

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
