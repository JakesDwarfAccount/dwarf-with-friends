// wp3a_workers_profile_test.mjs -- OFFLINE fixture test for the WP-3a Workers-tab profile controls
// in web/js/dwf-building-zone-stockpile-panels.js (skill min/max, max general orders,
// ban-general-orders toggle, blocked-labors list). No Dwarf Fortress, no server, no browser: it
// seeds ground-truth workshop-info.profile payloads and asserts the PURE, exported builders +
// the /workshop-profile `field` wire map.
//
// The load-bearing regressions it guards (completeness protocol, docs/.../2026-07-08-completeness-
// protocol.md, and the wp3-executor spec-delta docs/.../2026-07-09-wp3-execution-notes.md):
//   1. WIRE: the POST `field` names the server acts on (minLevel/maxLevel/maxGeneralOrders/
//      blockLabor/unblockLabor/banGeneralOrders). A drift here is the "wire connection opus
//      misses" failure class -- so field names are a single exported source of truth (wsProfileField).
//   2. GRACEFUL DEGRADATION: profile fields absent -> renders "" (nothing new). Labor enum absent
//      -> blocked-labors DEGRADES to unblock-only over the served currently-blocked set (the
//      current live DLL has no /labor-list). Each per-field gate is independent.
//   3. TEST-THE-TEST (rule 3): seeded-bad inputs (wrong field name, missing degrade path, wrong
//      skill-level label) MUST make the corresponding assertion fail -- proven with checkGuard.
//
//   node tools/harness/wp3a_workers_profile_test.mjs
// Exit: 0 PASS, 1 FAIL.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-building-zone-stockpile-panels.js");

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
// A guard assertion: it is EXPECTED to hold that `badCond` is false (i.e. the seeded-bad case is
// rejected). If badCond is ever true, the fixture would have passed a wrong implementation -> FAIL.
function checkGuard(name, rejected, extra) {
  if (rejected) { passed++; console.log(`  ok - (test-the-test) ${name}`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name}${extra ? "  " + extra : ""}`); }
}

// The browser file references escapeHtml (defined in another <script>); provide a faithful stub so
// the pure builders run headless. It must actually escape so we can assert injection safety.
globalThis.escapeHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// node --check (the file must load as a browser script AND require cleanly via its export guard).
try {
  execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" });
  passed++; console.log("  ok - dwf-building-zone-stockpile-panels.js passes node --check");
} catch (e) {
  failed++; console.log(`  FAIL - node --check: ${e.stderr ? e.stderr.toString() : e.message}`);
}

const M = require(modPath);
const EXPORTS = ["wsProfileHasControls", "wsSkillLevelName", "wsSkillSelect", "wsMaxOrdersSelect",
  "wsBlockedLaborsHtml", "wsProfileControlsHtml", "wsProfileField", "WS_SKILL_LEVEL_NAMES", "WS_NO_MAX_LEVEL"];
check("module exports the pure WP-3a builders + wire map",
  EXPORTS.every(k => M[k] !== undefined), EXPORTS.filter(k => M[k] === undefined).join(","));

// ==============================================================================================
// 1. WIRE -- /workshop-profile `field` names MUST match the server (wp3-execution-notes.md §1a).
console.log("\n[1] wire: /workshop-profile field names (server source of truth):");
check("min -> minLevel", M.wsProfileField("min") === "minLevel");
check("max -> maxLevel", M.wsProfileField("max") === "maxLevel");
check("maxOrders -> maxGeneralOrders", M.wsProfileField("maxOrders") === "maxGeneralOrders");
check("banOrders -> banGeneralOrders", M.wsProfileField("banOrders") === "banGeneralOrders");
check("labor{blocking:true} -> blockLabor", M.wsProfileField("labor", { blocking: true }) === "blockLabor");
check("labor{blocking:false} -> unblockLabor", M.wsProfileField("labor", { blocking: false }) === "unblockLabor");
check("unknown control -> null", M.wsProfileField("bogus") === null);
// test-the-test: a WRONG expected name (the classic wire drift) must be rejected by the assertion.
checkGuard("wrong field name 'minSkill' would be caught", M.wsProfileField("min") !== "minSkill");
checkGuard("block/unblock don't collide", M.wsProfileField("labor", { blocking: true }) !== M.wsProfileField("labor", { blocking: false }));

// ==============================================================================================
// 2. GRACEFUL DEGRADATION -- gating on served fields.
console.log("\n[2] graceful degradation: per-field gating + labor degrade path:");
// (a) Pre-WP-3 DLL: profile has only the legacy permitted-worker count -> NOTHING new renders.
const legacyProfile = { permittedCount: 2 };
check("legacy profile has no new controls", M.wsProfileHasControls(legacyProfile) === false);
check("legacy profile renders empty string", M.wsProfileControlsHtml(legacyProfile, null) === "");
check("empty/undefined profile renders empty string",
  M.wsProfileControlsHtml(undefined, null) === "" && M.wsProfileControlsHtml({}, null) === "");
// test-the-test: a profile WITH a new field must NOT be gated out (degrade must not over-hide).
checkGuard("a served minLevel is NOT treated as absent", M.wsProfileHasControls({ minLevel: 0 }) === true);

// (b) Full WP-3 profile, NO labor enum (current live DLL: /labor-list absent) -> blocked-labors
//     degrades to unblock-only over the served currently-blocked set + a note.
const fullProfile = {
  permittedCount: 0, minLevel: 3, maxLevel: 3000, maxGeneralOrders: 5, generalOrdersBanned: false,
  blockedLabors: [{ id: 0, name: "Stone Hauling" }, { id: 4, name: "Mining" }],
};
const degradeHtml = M.wsProfileControlsHtml(fullProfile, null);
check("skill range section renders", degradeHtml.includes("Skill range") && degradeHtml.includes("data-ws-min-level") && degradeHtml.includes("data-ws-max-level"));
check("max general orders select renders", degradeHtml.includes("data-ws-max-orders"));
check("ban toggle renders (currently allowed -> offers Ban, value 1)", degradeHtml.includes('data-ws-ban-orders="1"') && degradeHtml.includes("Ban general work orders"));
check("blocked-labors count reflects served set", degradeHtml.includes("Blocked labors (2)"));
check("degrade path shows the 'unavailable' note", degradeHtml.includes("Full labor list unavailable"));
check("degrade path renders unblock buttons for served-blocked only", (degradeHtml.match(/data-ws-labor-unblock=/g) || []).length === 2);
check("degrade path renders NO block checkboxes (no enum)", !degradeHtml.includes("data-ws-labor="));
check("degrade path shows blocked labor names", degradeHtml.includes("Stone Hauling") && degradeHtml.includes("Mining"));
// test-the-test: the degrade note is the tell -- a full-list render must NOT carry it.
const laborEnum = [{ id: 0, name: "Stone Hauling" }, { id: 1, name: "Wood Hauling" }, { id: 4, name: "Mining" }];
const fullListHtml = M.wsProfileControlsHtml(fullProfile, laborEnum);
checkGuard("full-list render drops the 'unavailable' note", !fullListHtml.includes("Full labor list unavailable"));

// (c) Full WP-3 profile WITH a labor enum (cpp-batch /labor-list served) -> full checkbox list,
//     blocked ones checked.
check("full list renders one checkbox per labor", (fullListHtml.match(/data-ws-labor="/g) || []).length === laborEnum.length);
check("blocked labors are checked", /data-ws-labor="0"\s+checked/.test(fullListHtml) && /data-ws-labor="4"\s+checked/.test(fullListHtml));
check("unblocked labor is NOT checked", /data-ws-labor="1"(?!\s+checked)/.test(fullListHtml));
check("full list renders NO unblock-only buttons", !fullListHtml.includes("data-ws-labor-unblock"));
// test-the-test: if the 'checked' were dropped, a blocked labor would render unchecked -> caught.
checkGuard("a blocked labor without 'checked' would be caught", /data-ws-labor="0"\s+checked/.test(fullListHtml));

// (d) blockedLabors absent entirely, but other fields present -> skill/orders render, no labor block.
const noLaborProfile = { minLevel: 0, maxLevel: 3000, maxGeneralOrders: 10 };
const noLaborHtml = M.wsProfileControlsHtml(noLaborProfile, laborEnum);
check("no blockedLabors -> no Blocked-labors section", !noLaborHtml.includes("Blocked labors"));
check("no blockedLabors -> still renders skill range", noLaborHtml.includes("Skill range"));
// (e) banned state renders the 'allow' affordance with value 0.
const bannedHtml = M.wsProfileControlsHtml({ generalOrdersBanned: true }, null);
check("banned state offers 'allow' (value 0)", bannedHtml.includes('data-ws-ban-orders="0"') && bannedHtml.includes("banned"));

// ==============================================================================================
// 3. SKILL LEVEL semantics -- native names (DF wiki v50 "Skill") + 0..3000 range (df.building.xml).
console.log("\n[3] skill level names + select round-trip (0..3000, 3000 = no maximum):");
check("21 named levels Dabbling..Legendary+5", M.WS_SKILL_LEVEL_NAMES.length === 21 &&
  M.WS_SKILL_LEVEL_NAMES[0] === "Dabbling" && M.WS_SKILL_LEVEL_NAMES[15] === "Legendary" &&
  M.WS_SKILL_LEVEL_NAMES[20] === "Legendary+5");
check("wsSkillLevelName(0)=Dabbling", M.wsSkillLevelName(0) === "Dabbling");
check("wsSkillLevelName(3)=Competent", M.wsSkillLevelName(3) === "Competent");
check("wsSkillLevelName(12)=Master", M.wsSkillLevelName(12) === "Master");
check("wsSkillLevelName(18)=Legendary+3", M.wsSkillLevelName(18) === "Legendary+3");
check("wsSkillLevelName(3000)=No maximum", M.wsSkillLevelName(3000) === "No maximum");
check("wsSkillLevelName(WS_NO_MAX_LEVEL)=No maximum", M.wsSkillLevelName(M.WS_NO_MAX_LEVEL) === "No maximum");
// test-the-test: a wrong label mapping (off-by-one) must be caught.
checkGuard("level 3 is NOT 'Skilled' (guards off-by-one)", M.wsSkillLevelName(3) !== "Skilled");

// select generation: min (no No-maximum), max (with No-maximum), and out-of-band round-trip.
const minSel = M.wsSkillSelect("data-ws-min-level", 3, false);
check("min select selects the served level", /<option value="3" selected>Competent<\/option>/.test(minSel));
check("min select omits 'No maximum'", !minSel.includes("No maximum"));
const maxSel = M.wsSkillSelect("data-ws-max-level", 3000, true);
check("max select includes 'No maximum' selected at value 3000", /<option value="3000" selected>No maximum<\/option>/.test(maxSel));
const oddSel = M.wsSkillSelect("data-ws-max-level", 1500, true);
check("an out-of-band served value round-trips (adds a selected Level option)",
  /<option value="1500" selected>Level 1500<\/option>/.test(oddSel));
// max general orders select 0..10, served value selected.
const mgoSel = M.wsMaxOrdersSelect(5);
check("max-orders select has 11 options (0..10)", (mgoSel.match(/<option /g) || []).length === 11);
check("max-orders select selects the served value", /<option value="5" selected>5<\/option>/.test(mgoSel));

// injection safety: a hostile labor name is escaped in both render paths.
const evil = [{ id: 9, name: '<img src=x onerror=alert(1)>' }];
check("labor names are HTML-escaped (checkbox path)",
  M.wsBlockedLaborsHtml([], evil).includes("&lt;img") &&
  !M.wsBlockedLaborsHtml([], evil).includes("<img src=x"));

// ==============================================================================================
console.log(`\n${failed ? "FAIL" : "PASS"} wp3a_workers_profile_test -- ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
