// cim_petitions_test.mjs -- OFFLINE fixture for R9 (CIM-labor-standing-orders-petitions.jpg):
// the 3-state prompt/accept/reject petition cycle, keyed on the STABLE server keys + raw byte.
//   node tools/harness/cim_petitions_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-labor-work-orders.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);

console.log("\n# 3-state labels (oracle: '<Type> petitions: prompt')");
check("raw 0 -> prompt", M.petitionStateLabel(0) === "prompt");
check("raw 1 -> accept", M.petitionStateLabel(1) === "accept");
check("raw 2 -> reject", M.petitionStateLabel(2) === "reject");
check("PETITION_STATES order = prompt,accept,reject", M.PETITION_STATES.join(",") === "prompt,accept,reject");
check("out-of-range/garbage raw -> prompt (no crash)", M.petitionStateLabel(undefined) === "prompt" && M.petitionStateLabel(NaN) === "prompt");
check("raw 3 wraps -> prompt", M.petitionStateLabel(3) === "prompt");

console.log("\n# cycle order (click advances prompt->accept->reject->prompt)");
check("next(0) = 1", M.petitionNextRaw(0) === 1);
check("next(1) = 2", M.petitionNextRaw(1) === 2);
check("next(2) = 0 (wraps)", M.petitionNextRaw(2) === 0);
check("next(undefined) = 1 (defaults to 0 then +1)", M.petitionNextRaw(undefined) === 1);

console.log("\n# row label = '<label>: <state>'");
check("Citizenship prompt", M.petitionRowLabel({ label: "Citizenship petitions", raw: 0 }) === "Citizenship petitions: prompt");
check("Performer accept", M.petitionRowLabel({ label: "Performer petitions", raw: 1 }) === "Performer petitions: accept");
check("Sanctuary reject", M.petitionRowLabel({ label: "Sanctuary petitions", raw: 2 }) === "Sanctuary petitions: reject");

console.log("\n# tristate detection + soRegroup passthrough (raw/tristate survive the regroup)");
check("soItemIsTristate true when flagged", M.soItemIsTristate({ tristate: true }) === true);
check("soItemIsTristate false when absent (old DLL bool)", M.soItemIsTristate({}) === false);

// New-DLL payload: petitions carry the oracle labels + raw + tristate.
const pet = (key, label, raw) => ({ key, label, value: raw !== 0, raw, tristate: true });
const payload = {
  groups: [
    { id: "workshops", items: [{ key: "auto_loom", label: "Automatically weave all thread", value: true }] },
    { id: "petitions", items: [
      pet("petition_citizenship", "Citizenship petitions", 0),
      pet("petition_resident_performer", "Performer petitions", 1),
      pet("petition_resident_monster_hunter", "Monster slayer petitions", 2),
      pet("petition_resident_mercenary", "Mercenary petitions", 0),
      pet("petition_resident_scholar", "Scholar petitions", 0),
      pet("petition_resident_sanctuary", "Sanctuary petitions", 0),
    ] },
  ],
};
const g = M.soRegroup(payload.groups);
const petGroup = g.find(x => x.id === "petitions");
const petByKey = Object.fromEntries((petGroup.items || []).map(i => [i.key, i]));
check("petitions membership preserved (6)", (petGroup.items || []).length === 6);
check("tristate flag carried through soRegroup", petByKey.petition_citizenship.tristate === true);
check("raw byte carried through soRegroup", petByKey.petition_resident_performer.raw === 1);
check("label kept verbatim (server relabel, no remap)", petByKey.petition_citizenship.label === "Citizenship petitions");
check("rendered label: 'Monster slayer petitions: reject'",
  M.petitionRowLabel(petByKey.petition_resident_monster_hunter) === "Monster slayer petitions: reject");
check("workshops item is NOT tristate", M.soItemIsTristate(g.find(x => x.id === "workshops").items[0]) === false);

console.log("\n# TEST-THE-TEST (seeded-bad must be discriminated)");
// 1) A boolean petition item (old DLL, no tristate) must NOT be treated as a 3-state cycle.
guard("boolean petition item (no tristate) is not cycled", M.soItemIsTristate({ key: "petition_citizenship", value: true }) === false);
// 2) A wrong cycle table (e.g. accept<->reject swapped) would break next(1)=2; assert the correct one.
guard("next(1) is 2 not 0 (cycle-order guard)", M.petitionNextRaw(1) === 2 && M.petitionNextRaw(1) !== 0);
// 3) A mislabeled state map (prompt/reject swapped) would fail raw 0 -> prompt.
guard("raw 0 maps to prompt not reject (state-map guard)", M.petitionStateLabel(0) === "prompt" && M.petitionStateLabel(0) !== "reject");

// ---- W5 RENDER PROOF: the petition row is a DWFUI plaque -------------------------------------
// EXECUTED, not grepped. Native carries the petition's state IN THE LABEL TEXT ITSELF
// ("Citizenship: accept"), which is exactly what petitionRowLabel already produces -- so the plaque
// needs no invented state affordance, and the 3-state POST wire must survive the migration intact.
const DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));
function laborRenderContext() {
  const ctx = vm.createContext({
    DWFUI, module: { exports: {} }, console, clientPanel: null, player: "p1",
    escapeHtml: s => String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    infoTabRowHtml: () => `<div class="info-tabs"></div>`,
    infoSearchBoxHtml: () => "",
    unitPortraitMarkup: (u, c) => `<span class="${c}"></span>`,
    attribRowHtml: () => "", bldIconStyle: () => "", dfTokenMatch: () => true,
  });
  vm.runInContext(readFileSync(modPath, "utf8"), ctx);
  return ctx.module.exports;
}
const R = laborRenderContext();
const petHtml = R.standingOrdersMarkup({ groups: [{ id: "petitions", items: [
  { key: "petition_citizenship", label: "Citizenship", value: false, raw: 1, tristate: true },
  { key: "petition_resident_performer", label: "Performer residency", value: false, raw: 2, tristate: true },
] }] }, "petitions");

console.log("\n# W5 -- the petition row is DWFUI.plaqueBtnHtml, keeping `.so-petition`");
check("petition renders as a plaque with its bitmap label, not a hand-built button",
  /class="dwfui-plaque dwfui-plaque--art-neutral so-toggle so-petition"/.test(petHtml) && /dwfui-plaque-label/.test(petHtml) &&
  !/<button class="so-toggle so-petition"/.test(petHtml));
check("the STATE IS IN THE LABEL TEXT, verbatim (`<name>: <state>`) -- no invented state affordance",
  /Citizenship: accept/.test(petHtml) && /Performer residency: reject/.test(petHtml));
check("the 3-state POST wire survives: data-so-raw carries the NEXT raw byte (1->2, 2->0)",
  /data-so-key="petition_citizenship" data-so-raw="2"/.test(petHtml) &&
  /data-so-key="petition_resident_performer" data-so-raw="0"/.test(petHtml));
check("a petition never emits the boolean `data-so-on` hook (the handler discriminates on so-raw)",
  !/data-so-key="petition_citizenship"[^>]*data-so-on/.test(petHtml));
guard("a boolean order in the SAME builder still emits data-so-on and NOT data-so-raw",
  /data-so-key="dump_bones" data-so-on="1"/.test(
    R.standingOrdersMarkup({ groups: [{ id: "refuse", items: [{ key: "dump_bones", label: "x", value: false }] }] }, "refuse")));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
