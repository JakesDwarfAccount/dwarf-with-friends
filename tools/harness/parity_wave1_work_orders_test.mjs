// parity_wave1_work_orders_test.mjs -- OFFLINE wave-1 parity coverage for the work-orders lane.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Binds the STATE-RECONSTRUCTION packet's caseIds
//   case.info-work-orders.exact-state.{positive,boundary,counterexample}
// to the PINNED native state evidence for family "dwarfmode/Info/WORK_ORDERS"
// (family.e5de6b8323...), covering completionScope=bounded-state-reconstruction.
//
// For every packet caseId this suite produces a REAL observation + comparison two ways:
//   (1) the authoritative sealed evaluator (native_requirement_case_evaluator.mjs) run with the
//       packet's own pinned sealed command-id, cross-checked against the packet's expectedComparison
//       and the pinned request's nativeStateEvidence, and
//   (2) the web-client state reconstruction (workOrdersMarkup, mode:"conditions") that must
//       rebuild the exact native Conditions/Default state without inventing wording or satisfaction.
//
//   node tools/harness/parity_wave1_work_orders_test.mjs      (exit 0 PASS / 1 FAIL)

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);

const FAMILY_ID = "family.e5de6b83232065c3b7a7632046cc68332e2a361d9eab28efa035804d3c1a6571";
const FAMILY_KEY = "dwarfmode/Info/WORK_ORDERS";
const EXACT_FOCUS = "dwarfmode/Info/WORK_ORDERS/Conditions/Default";
const REQUIREMENT_ID = "requirement.info-work-orders.exact-state.v1";
const REQUIRED_SLICE = "work_order.v2";
const EVALUATOR = join(root, "tools", "ground_truth", "native_requirement_case_evaluator.mjs");

let passed = 0, failed = 0;
const check = (n, c, x) => {
  if (c) { passed++; console.log(`  ok - ${n}`); }
  else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); }
};
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1. Discover the PINNED state-reconstruction request + packet for lane.work-orders ---------
// Discovery is by lane identity, not a hardcoded content-address, so the binding survives re-issue.
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function discover(subdir, suffix, predicate) {
  const dir = join(root, "build", "ground-truth", "parity", subdir);
  const hits = readdirSync(dir).filter(f => f.endsWith(suffix))
    .map(f => ({ file: join(dir, f), json: readJson(join(dir, f)) }))
    .filter(({ json }) => predicate(json));
  return hits;
}

const requests = discover("requests", ".request.json",
  j => j.serializationKey === "lane.work-orders" && j.familyId === FAMILY_ID
    && String(j.id).startsWith("state-reconstruction."));
check("exactly one pinned state-reconstruction request for lane.work-orders", requests.length === 1,
  `found ${requests.length}`);
const request = requests[0].json;

const packets = discover("packets", ".packet.json",
  j => j.recordType === "parity-gap-packet" && j.id === request.id
    && j.scope?.familyKey === FAMILY_KEY);
check("exactly one pinned parity-gap-packet matching the request id", packets.length === 1,
  `found ${packets.length}`);
const packet = packets[0].json;

// ---- 2. PINNED native state evidence provenance (state-reconstruction inputs) ------------------
console.log("\n# pinned native state evidence -- WORK_ORDERS/Conditions/Default");
const evidence = request.nativeStateEvidence || [];
check("native state evidence is non-empty", evidence.length > 0, `${evidence.length} entries`);
check("every evidence entry pins exactFocusPath = Conditions/Default",
  evidence.length > 0 && evidence.every(e => e.exactFocusPath === EXACT_FOCUS));
check("every evidence entry is bound to the exact-state requirement",
  evidence.every(e => e.requirementId === REQUIREMENT_ID));
check("every evidence entry carries at least one native stateHash witness",
  evidence.every(e => Array.isArray(e.stateHashes) && e.stateHashes.length > 0));
check("every evidence entry's uiHash is the tail of its screenId (screen<->ui binding)",
  evidence.every(e => typeof e.screenId === "string"
    && e.screenId.toUpperCase().endsWith(e.uiHash.toUpperCase())));
check("request pins nativeFocusPaths to the single exact focus",
  deepEq(request.nativeFocusPaths, [EXACT_FOCUS]));
check("request pins the required recorder slice to work_order.v2",
  deepEq(request.recorderSliceIds, [REQUIRED_SLICE]));
check("packet scope family key/id match the pinned WORK_ORDERS family",
  packet.scope.familyId === FAMILY_ID && packet.scope.familyKey === FAMILY_KEY);

// ---- 3. Per-caseId authoritative observation via the sealed evaluator --------------------------
// caseId -> { requiredTestId, expectedComparison } from the packet's own requirement cases,
// joined to the sealed command-id in the packet's test bindings. Nothing is hardcoded.
const kindByCase = {}; // requiredTestId -> { kind, expectedComparison }
for (const kind of ["positive", "boundary", "counterexample"]) {
  const c = packet.requirements.cases[kind][0];
  kindByCase[c.requiredTestId] = { kind, caseId: c.id, expectedComparison: c.expectedComparison };
}
const bindingByTestId = {}; // testId -> sealed command-id
for (const t of packet.requirements.tests) {
  const testId = t.bindingArgs[t.bindingArgs.indexOf("--case") + 1];
  bindingByTestId[testId] = t.command.args[t.command.args.indexOf("--command-id") + 1];
}

console.log("\n# packet caseIds -- authoritative sealed evaluator observation vs pinned evidence");
for (const testId of Object.keys(kindByCase).sort()) {
  const { kind, caseId, expectedComparison } = kindByCase[testId];
  const commandId = bindingByTestId[testId];
  check(`${kind}: packet binds a sealed command-id for ${testId}`,
    typeof commandId === "string" && /^test\.[a-f0-9]{20}$/.test(commandId), String(commandId));
  let result = null, evalErr = "";
  try {
    const out = execFileSync(process.execPath,
      [EVALUATOR, "--case", testId, "--command-id", commandId],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    result = JSON.parse(out.trim().split("\n").pop());
  } catch (e) { evalErr = (e.stderr || e.stdout || e.message || "").toString(); }
  check(`${kind}: sealed evaluator returns status=pass`,
    result && result.status === "pass", evalErr || JSON.stringify(result));
  check(`${kind}: evaluator's family + case match the pinned packet case`,
    !!result && result.nativeFamilyId === FAMILY_ID && result.caseId === caseId);
  check(`${kind}: evaluator's expectedComparison deep-equals the packet's`,
    !!result && deepEq(result.expectedComparison, expectedComparison));
  check(`${kind}: observed value satisfies the pinned comparison`,
    !!result && result.actualObservation.matched === true
      && deepEq(result.actualObservation.value, expectedComparison.value));
}

// ---- 4. Web-client STATE RECONSTRUCTION bound to the pinned focus ------------------------------
// The Conditions/Default state must be rebuilt from the DF-owned /orders payload with native
// wording only. Payloads mirror the read contract proven by b285_workorder_conditions_read_test.
const DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
function reconstruct() {
  const ctx = vm.createContext({
    DWFUI, module: { exports: {} }, console, clientPanel: null, player: "p1",
    escapeHtml: s => String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    infoTabRowHtml: () => `<div class="info-tabs"></div>`,
    infoSearchBoxHtml: () => "",
    unitPortraitMarkup: () => "", attribRowHtml: () => "",
    bldIconStyle: () => "", dfTokenMatch: () => true,
  });
  vm.runInContext(readFileSync(join(root, "web", "js", "dwf-labor-work-orders.js"), "utf8"), ctx);
  return ctx.module.exports;
}
const M = reconstruct();
check("web client exports workOrdersMarkup (the reconstruction seam)",
  typeof M.workOrdersMarkup === "function");

const conditionRow = {
  idx: 0, item: "BARREL", itemSubtype: -1, compare: "LessThan", value: 10,
  adjective: "empty", description: "Amount of empty barrels available is less than 10",
  satisfied: true, satisfactionSource: "df-ui",
};
const order = {
  id: 285, pos: 0, job: "Make wooden barrel", amountLeft: 10, amountTotal: 10,
  frequency: "Daily", validated: true, active: false, workshopId: -1,
  itemConditions: [conditionRow], orderConditions: [],
};
const recon = M.workOrdersMarkup({ hasManager: true, orders: [order] },
  { mode: "conditions", selectedOrderId: 285 });

console.log("\n# positive: exact Conditions/Default state is reconstructed with native wording only");
check("native repeating header reaches bitmap text exactly",
  recon.includes('data-dwfui-bitmap-text="Restarts if completed, conditions checked daily"'));
check("native condition wording reaches bitmap text exactly (not client-invented)",
  recon.includes('data-dwfui-bitmap-text="Amount of empty barrels available is less than 10"'));
check("condition row is built by the shared DWFUI.rowHtml chassis",
  /class="dwfui-row wo-condition-row/.test(recon));

console.log("\n# boundary: the full required work_order.v2 condition slice is consumed");
check("DF-owned satisfied=true reaches the green satisfied row + native wording",
  /class="dwfui-row wo-condition-row is-satisfied dwfui-row--table dwfui-row--on"/.test(recon)
    && recon.includes('data-dwfui-bitmap-text="Satisfied for next check"'));

console.log("\n# counterexample: unattested / cross-family satisfaction is rejected (fail-closed)");
const unknown = M.workOrdersMarkup({ hasManager: true, orders: [
  { ...order, itemConditions: [{ ...conditionRow, satisfied: null, satisfactionSource: null }] },
] }, { mode: "conditions", selectedOrderId: 285 });
check("unknown satisfaction is NOT painted satisfied and fabricates no result wording",
  !/is-satisfied|Satisfied for next check/.test(unknown));
const falseHtml = M.workOrdersMarkup({ hasManager: true, orders: [
  { ...order, itemConditions: [{ ...conditionRow, satisfied: false }] },
] }, { mode: "conditions", selectedOrderId: 285 });
check("df-owned false is not repainted green",
  !/is-satisfied|Satisfied for next check/.test(falseHtml));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
