// v1_workorder_cancel_test.mjs -- v1 gap-closure regression: cancelling a work order must leave
// NO STALE ROW and must never claim FALSE SUCCESS.
//
// Release bar (docs/superpowers/plans/2026-07-16-v1-gap-closure-fable-handoff.md, "Work orders"):
//   "Create an amount-one scratch order, inspect/reopen its conditions, and cancel it without
//    leaving a stale row or claiming false success."
//
// This runs OFFLINE against the shipped builder (workOrdersMarkup) and the shipped click handler,
// not a hand copy:
//   1. no stale row  -- the exported builder rebuilds the list from the authoritative order array,
//                       so the cancelled order's row (data-wo-cancel="<id>") and its title vanish
//                       once the server list drops it.
//   2. no stale conditions view -- reopening conditions after the selected order is gone must not
//                       render the dead order's conditions screen.
//   3. no false success -- the real cancel handler is EXTRACTED from the source and EXECUTED with
//                       mock deps: the "Order removed." success status is only reachable AFTER the
//                       /order-cancel POST resolves; a rejected POST reaches the error branch and
//                       never refreshes or reports success.
//
//   node tools/harness/v1_workorder_cancel_test.mjs   (exit 0 PASS / 1 FAIL)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(import.meta.url);
const modPath = join(root, "web", "js", "dwf-labor-work-orders.js");
const src = readFileSync(modPath, "utf8");

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
};
const guard = (name, cond, extra) => check(`(test-the-test) ${name}`, cond, extra);

// ---- render the SHIPPED builder with the same globals the browser gives it ---------------------
const DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
function laborExports() {
  const ctx = vm.createContext({
    DWFUI, module: { exports: {} }, console, clientPanel: null, player: "p1",
    escapeHtml: s => String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    infoTabRowHtml: () => `<div class="info-tabs"></div>`,
    infoSearchBoxHtml: () => `<div class="info-search"></div>`,
    unitPortraitMarkup: (u, c) => `<span class="${c}"></span>`,
    attribRowHtml: () => `<span class="attrib-chip"></span>`,
    bldIconStyle: () => "", dfTokenMatch: () => true,
  });
  vm.runInContext(src, ctx);
  return ctx.module.exports;
}
const M = laborExports();
check("workOrdersMarkup is the shipped exported builder", typeof M.workOrdersMarkup === "function");

const orderA = { id: 1, pos: 0, job: "Encrust XcabinetX with XgemsX", amountTotal: 1, amountLeft: 1,
  frequency: "OneTime", validated: true, active: false, workshopId: 7, workshopName: "Jeweler's Workshop",
  maxWorkshops: 0, itemConditions: [{ idx: 0, label: "gem cut" }] };
const orderB = { id: 2, pos: 1, job: "Brew drink", amountTotal: 0, frequency: "Monthly",
  validated: false, active: false, workshopId: 8, workshopName: "Still", maxWorkshops: 0 };

// ---- 1. NO STALE ROW: the row disappears once the server list drops the cancelled order --------
console.log("# 1. cancel leaves no stale row (authoritative-list rebuild)");
const before = M.workOrdersMarkup({ hasManager: true, orders: [orderA, orderB] }, { mode: "list" });
check("before cancel, both order rows are present",
  before.includes('data-wo-cancel="1"') && before.includes('data-wo-cancel="2"'));
check("before cancel, order A's title is on screen", before.includes("Encrust"));

const after = M.workOrdersMarkup({ hasManager: true, orders: [orderB] }, { mode: "list" });
check("after cancel, order A's row (data-wo-cancel=\"1\") is GONE", !after.includes('data-wo-cancel="1"'));
check("after cancel, order A's title no longer renders (no stale row)", !after.includes("Encrust"));
check("after cancel, the surviving order B still renders", after.includes('data-wo-cancel="2"'));
guard("re-rendering the un-cancelled list still shows A -- the absence assertion is not vacuous",
  M.workOrdersMarkup({ hasManager: true, orders: [orderA, orderB] }, { mode: "list" }).includes('data-wo-cancel="1"'));

// ---- 2. NO STALE CONDITIONS VIEW after the selected order is cancelled --------------------------
console.log("# 2. reopening conditions after cancel does not show the dead order");
const condLive = M.workOrdersMarkup({ hasManager: true, orders: [orderA, orderB] },
  { mode: "conditions", selectedOrderId: 1 });
check("with A alive, its conditions screen renders A", condLive.includes("Encrust"));

// A cancelled, B remains: the selected id is gone, so no dead-A conditions screen may render.
const condAfterCancelA = M.workOrdersMarkup({ hasManager: true, orders: [orderB] },
  { mode: "conditions", selectedOrderId: 1 });
check("after cancelling the selected order, its dead conditions view is not shown", !condAfterCancelA.includes("Encrust"));

// The last order cancelled: no order at all -> builder must fall back to the list, not a null screen.
const condAfterCancelAll = M.workOrdersMarkup({ hasManager: true, orders: [] },
  { mode: "conditions", selectedOrderId: 1 });
check("cancelling the last order falls back to the list (no orphaned conditions screen)",
  !condAfterCancelAll.includes("Encrust") && !/undefined|null/.test(condAfterCancelAll.replace(/data-[^=]+="[^"]*"/g, "")));
guard("the conditions screen CAN render a selected order -- the dead-order absence assertion is real",
  condLive.length > condAfterCancelAll.length && condLive.includes("Encrust"));

// ---- 3. NO FALSE SUCCESS: the real cancel handler only reports success AFTER the POST resolves --
console.log("# 3. the shipped cancel handler never claims false success");
const arrowMatch = /(async e => \{\s*e\.preventDefault\(\); e\.stopPropagation\(\);\s*try \{ await woApi\("\/order-cancel"[\s\S]*?catch \(err\) \{ woSetStatus\(err\.message \|\| "Could not remove order\.", true\); \}\s*\})/.exec(src);
check("the cancel click handler is extractable from the shipped source", !!arrowMatch);

async function runHandler(apiImpl) {
  const calls = [];
  const woApi = async (path, body) => { calls.push(["woApi", path, body]); return apiImpl(path, body); };
  const refreshWorkOrders = async () => { calls.push(["refresh"]); };
  const woSetStatus = (msg, isError) => { calls.push(["status", msg, !!isError]); };
  const b = { dataset: { woCancel: "1" } };
  const makeHandler = new Function("woApi", "refreshWorkOrders", "woSetStatus", "b",
    `return (${arrowMatch[1]});`);
  const handler = makeHandler(woApi, refreshWorkOrders, woSetStatus, b);
  await handler({ preventDefault() {}, stopPropagation() {} });
  return calls;
}

if (arrowMatch) {
  const ok = await runHandler(async () => ({ ok: true }));
  const status = ok.find(c => c[0] === "status");
  check("success path posts /order-cancel with the row's id",
    ok.some(c => c[0] === "woApi" && c[1] === "/order-cancel" && Number(c[2]?.id) === 1));
  check("success path refreshes the list before reporting", ok.findIndex(c => c[0] === "refresh") >= 0 &&
    ok.findIndex(c => c[0] === "refresh") < ok.findIndex(c => c[0] === "status"));
  check("success path reports success (isError=false)", status && status[1] === "Order removed." && status[2] === false);

  const bad = await runHandler(async () => { throw new Error("route refused"); });
  const badStatus = bad.find(c => c[0] === "status");
  check("a REJECTED /order-cancel never reports success (no false success)",
    !bad.some(c => c[0] === "status" && c[2] === false));
  check("a rejected /order-cancel reports the error (isError=true)", badStatus && badStatus[2] === true);
  check("a rejected /order-cancel does not refresh the list as if it worked",
    !bad.some(c => c[0] === "refresh"));
  guard("the handler routes success vs failure differently -- the false-success guard is load-bearing",
    ok.some(c => c[0] === "status" && c[2] === false) && bad.every(c => c[0] !== "status" || c[2] === true));
}

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
