// b228_missions_test.mjs -- offline fixture acceptance for B228 ("missions/raids has no write path").
//
// What B228 shipped, and therefore what this test has to hold down:
//   * GET /missions (src/missions.cpp): active fort missions with per-goal detail read out of the
//     army_controller UNION, our squads with DF's own committed bit, candidate targets from
//     entity.relations.known_sites, the mission-type table, stranded squads, and TWO honest
//     capability blocks (create + rescue).
//   * POST /mission-create: validates the whole order the way DF would, stages it, and then REFUSES
//     with 501 + blocked:"native-only" -- because DF creates missions only inside viewscreen_worldst
//     and DFHack exposes no API for it. THE GUARD IS THE FEATURE. If a future edit ever lets the
//     commit run, the guard tests below must go red.
//   * POST /mission-rescue: the one REAL write -- DFHack's own scripts/fix/stuck-squad.lua.
//   * web/js/dwf-worldmap.js: the order-builder flow + the rescue button, DWFUI-only.
//
// This exercises the PURE client helpers and greps the server/lua for the load-bearing structure
// facts, so it runs with no DF and no DLL.
//
// Run: node tools/harness/b228_missions_test.mjs        (zero-dep, Node >= 18)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const modPath = join(root, "web", "js", "dwf-worldmap.js");
globalThis.DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
globalThis.escapeHtml = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

for (const f of [modPath, join(root, "web", "js", "dwf-ui-components.js")]) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); check(`${f.split(/[\\/]/).pop()} node --check`, true); }
  catch (e) { check(`node --check ${f}`, false, e.stderr ? e.stderr.toString() : e.message); }
}

const M = require(modPath);
const server = readFileSync(join(root, "src", "missions.cpp"), "utf8");
const header = readFileSync(join(root, "src", "missions.h"), "utf8");
const lua = readFileSync(join(root, "dwf.lua"), "utf8");

// ---- a representative /missions payload --------------------------------------------------------
const DATA = {
  ownSiteId: 7, ownSite: "Boatmurdered", civ: "The Bronze Realms",
  active: [
    { id: 1, goal: "SITE_INVASION", invasionIntent: "RAID", targetSiteId: 22, targetSite: "Black Spire",
      returning: 1, stuck: false, targetKind: "invasion", targetName: "",
      squads: [{ id: 5, name: "The Iron Fists", memberCount: 8 }] },
    { id: 2, goal: "RECOVER_ARTIFACT", targetSiteId: 31, targetSite: "Grimhold", returning: 0, stuck: true,
      targetKind: "artifact", targetId: 900, targetName: "Ustuthzasit the Amulet of Doom",
      squads: [{ id: 6, name: "The Ashen Guard", memberCount: 6 }] },
    { id: 3, goal: "RESCUE_HF", targetSiteId: 22, targetSite: "Black Spire", returning: 0, stuck: false,
      targetKind: "hf", targetId: 700, targetName: "Urist McPrisoner",
      squads: [{ id: 8, name: "The Long Watch", memberCount: 4 }] },
  ],
  squads: [
    { id: 5, name: "The Iron Fists", memberCount: 8, busy: true, busyReason: "Already assigned to a mission", armyId: 3, stuck: false },
    { id: 6, name: "The Ashen Guard", memberCount: 6, busy: true, busyReason: "Away from the fortress", armyId: 4, stuck: true },
    { id: 7, name: "The Silver Axes", memberCount: 10, busy: false, busyReason: "", armyId: -1, stuck: false },
  ],
  targets: [
    { id: 22, name: "Black Spire", type: "DarkFortress", civ: "The Ashen Horde", x: 4, y: 9, civId: 3 },
    { id: 31, name: "Grimhold", type: "Fortress", civ: "The Bronze Realms", x: 12, y: 3, civId: 1 },
  ],
  missionTypes: [
    { key: "SITE_INVASION", label: "Raid", needs: "site", available: false },
    { key: "RECOVER_ARTIFACT", label: "Recover artifact", needs: "artifact", available: false },
    { key: "RESCUE_HF", label: "Rescue prisoner", needs: "hf", available: false },
    { key: "MAKE_REQUEST", label: "Request workers", needs: "site", available: false },
  ],
  stuckSquads: [{ squadId: 6, squadName: "The Ashen Guard", armyId: 4 }],
  rescue: { available: true, stuckCount: 1, reason: "A returning army can carry them home." },
  create: { supported: false, blocked: "native-only", reason: "Dwarf Fortress creates missions only inside its own world screen..." },
};
const EMPTY_DRAFT = { goal: "", siteId: -1, squadIds: [], targetId: -1 };

check("exports the pure B228 mission helpers",
  ["missionsPanelHtml", "missionListHtml", "missionNewFormHtml", "missionDraftReady", "missionStateLabel"]
    .every(k => typeof M[k] === "function"));

// ---- the active-mission read: goal detail, state, stranded --------------------------------------
const list = M.missionListHtml(DATA, false);
check("a raid renders its INVASION INTENT, not the generic SITE_INVASION goal", /Raid/.test(list) && !/Site Invasion/.test(list));
check("recover-artifact names the artifact it is going after", /Ustuthzasit the Amulet of Doom/.test(list));
check("both target sites render", /Black Spire/.test(list) && /Grimhold/.test(list));
check("a returning mission says so, an outbound one says so", /Returning home/.test(list) && /Outbound/.test(list));
check("a stranded mission is called out as stranded", /Stranded/.test(list) && /world-mission-stuck/.test(list));
check("squad counts render", /1 squad</.test(list));
check("a rescue mission names the prisoner", /Urist McPrisoner/.test(list));

// `returning` is a TRI-state on the wire: a goal that tracks no homeward flag must not be described
// as outbound. That would be a fabricated fact, which is exactly what this lane is not allowed to do.
check("returning=1 -> Returning home", M.missionStateLabel({ returning: 1 }) === "Returning home");
check("returning=0 -> Outbound", M.missionStateLabel({ returning: 0 }) === "Outbound");
guard("returning=-1 (goal tracks no homeward flag) -> 'Away', never 'Outbound'",
  M.missionStateLabel({ returning: -1 }) === "Away" && M.missionStateLabel({}) === "Away");
guard("stranded outranks every other state", M.missionStateLabel({ stuck: true, returning: 1 }) === "Stranded -- cannot return");

// ---- the rescue write: the ONE real mutation ----------------------------------------------------
check("a stranded squad surfaces the rescue button, live", /data-mission-rescue/.test(list) && !/data-mission-rescue[^>]*disabled/.test(list));
check("the rescue button explains it runs DFHack's own repair", /fix\/stuck-squad/.test(list));
const noStuck = M.missionListHtml(Object.assign({}, DATA, { stuckSquads: [], rescue: { available: false, stuckCount: 0, reason: "No stranded squads." } }), false);
guard("no stranded squads -> NO rescue button at all (not a disabled one for a problem you do not have)",
  !/data-mission-rescue/.test(noStuck));
const stuckNoRide = M.missionListHtml(Object.assign({}, DATA, {
  rescue: { available: false, stuckCount: 2, reason: "Nothing is returning to the fortress." } }), false);
check("stranded but nothing returning -> button DISABLED and DFHack's reason shown",
  /data-mission-rescue/.test(stuckNoRide) && /disabled/.test(stuckNoRide) && /Nothing is returning to the fortress/.test(stuckNoRide));

// ---- the create flow: a real builder, an honest wall --------------------------------------------
check("the list offers New mission", /data-mission-new/.test(list));
check("the list states plainly that sending is blocked and why", /Sending is blocked/.test(list) && /world screen/.test(list));

const form = M.missionNewFormHtml(DATA, EMPTY_DRAFT, null, false);
check("the form offers every mission type DF's screen raises",
  ["Raid", "Recover artifact", "Rescue prisoner", "Request workers"].every(l => form.includes(l)));
check("the form offers the known sites as targets", /data-mission-site="22"/.test(form) && /data-mission-site="31"/.test(form));
check("the form offers every squad", /data-mission-squad="5"/.test(form) && /data-mission-squad="7"/.test(form));
check("a committed squad is offered DISABLED with DF's own reason, not hidden",
  /Already assigned to a mission/.test(form) && /Away from the fortress/.test(form) && /world-mission-busy/.test(form));
check("Send is disabled on an empty draft", /data-mission-send/.test(form) && /disabled/.test(form));

// The readiness rule is the client-side mirror of the server's validator. Both must agree, and the
// goal's OWN prerequisite (`needs`) must be part of it.
check("draft with type+site+squad is ready", M.missionDraftReady(DATA, { goal: "SITE_INVASION", siteId: 22, squadIds: [7], targetId: -1 }));
guard("no squad -> not ready", !M.missionDraftReady(DATA, { goal: "SITE_INVASION", siteId: 22, squadIds: [], targetId: -1 }));
guard("no target site -> not ready", !M.missionDraftReady(DATA, { goal: "SITE_INVASION", siteId: -1, squadIds: [7], targetId: -1 }));
guard("no mission type -> not ready", !M.missionDraftReady(DATA, { goal: "", siteId: 22, squadIds: [7], targetId: -1 }));
guard("RECOVER_ARTIFACT with no artifact chosen -> NOT ready (needs:'artifact' is enforced)",
  !M.missionDraftReady(DATA, { goal: "RECOVER_ARTIFACT", siteId: 22, squadIds: [7], targetId: -1 }));
check("RECOVER_ARTIFACT with an artifact -> ready",
  M.missionDraftReady(DATA, { goal: "RECOVER_ARTIFACT", siteId: 22, squadIds: [7], targetId: 900 }));
guard("RESCUE_HF with no prisoner chosen -> NOT ready",
  !M.missionDraftReady(DATA, { goal: "RESCUE_HF", siteId: 22, squadIds: [7], targetId: -1 }));

const ready = M.missionNewFormHtml(DATA, { goal: "SITE_INVASION", siteId: 22, squadIds: [7], targetId: -1 }, null, false);
check("a complete draft enables Send", /data-mission-send[^>]*>/.test(ready) && !/data-mission-send[^>]*disabled/.test(ready));
check("the chosen type and target are marked as chosen (state, not hover)", (ready.match(/world-mission-picked/g) || []).length === 2);

// THE 501. The refusal must render as "validated but NOT sent" WITH the staged order -- proving the
// order was fully resolved -- and must never read as success.
const blocked = M.missionNewFormHtml(DATA, { goal: "SITE_INVASION", siteId: 22, squadIds: [7], targetId: -1 },
  { ok: false, blocked: "native-only", error: "Dwarf Fortress creates missions only inside its own world screen.",
    staged: { goal: "SITE_INVASION", targetSite: "Black Spire", squadNames: ["The Silver Axes"] } }, false);
check("a native-only refusal says validated but NOT sent", /Order validated but NOT sent/.test(blocked));
check("the refusal shows the staged order back (target + squads)", /Black Spire/.test(blocked) && /The Silver Axes/.test(blocked));
guard("the refusal NEVER claims the mission departed", !/Mission sent/.test(blocked) && !/preparing to depart/.test(blocked));

// A 400 (your order is wrong) must look DIFFERENT from a 501 (your order is fine, DF will not take it).
const rejected = M.missionNewFormHtml(DATA, EMPTY_DRAFT, { ok: false, error: "The Iron Fists is already away on a mission" }, false);
check("a rejected order shows the server's specific reason", /already away on a mission/.test(rejected));
guard("a rejected order is NOT dressed up as the native-only wall",
  !/Order validated but NOT sent/.test(rejected) && !/The order we staged/.test(rejected));

// ---- test-the-test: the wall itself --------------------------------------------------------------
// If someone flips the guard or wires a fake success, these go red.
guard("the server's commit guard is OFF", /constexpr bool kMissionCommitEnabled = false;/.test(server));
guard("the server refuses with 501 + blocked:native-only",
  /res\.status = 501;/.test(server) && /\\"blocked\\":\\"native-only\\"/.test(server));
guard("the server stages the order BEFORE refusing (the refusal carries the staged plan)",
  /,\\"staged\\":" \+ staged_json\(staged\)/.test(server) || /staged_json\(staged\)/.test(server));
guard("the client renders the SERVER's capability, not a hardcoded verdict",
  /create\.supported/.test(readFileSync(modPath, "utf8")));
const supported = M.missionListHtml(Object.assign({}, DATA, { create: { supported: true } }), false);
guard("if the server ever advertises create.supported the client stops printing the block notice",
  !/Sending is blocked/.test(supported) && /data-mission-new/.test(supported));

// ---- test-the-test: the server reads the structures it claims to ---------------------------------
guard("server reads army_controller + the goal UNION member the goal selects",
  /army_controllers\.all/.test(server) && /goal_recover_artifact/.test(server) &&
  /goal_rescue_hf/.test(server) && /goal_site_invasion/.test(server));
guard("server reads DF's own squad-committed bit (squad.assigned_army_controller_id)",
  /assigned_army_controller_id/.test(server));
guard("server takes targets from DF's known_sites relation (both group AND civ -- a fresh fort's group is empty)",
  /relations\.known_sites/.test(server) && /v\.group, v\.civ/.test(server));
guard("server mirrors fix/stuck-squad's stuck test verbatim (controller_id != 0 && !controller)",
  /controller_id != 0 && !army->controller/.test(server));
guard("the rescue runs DFHack's OWN script, it does not reimplement it",
  /reqscript, 'fix\/stuck-squad'/.test(lua) && /dfhack\.run_script, 'fix\/stuck-squad'/.test(lua));
guard("the lua pre-checks with the script's own scan_fort_armies rather than running it blind",
  /scan_fort_armies/.test(lua));
guard("missions.h cites where DF actually creates missions (viewscreen_worldst / new_mission[])",
  /viewscreen_worldst/.test(header) && /new_mission/.test(header));
guard("missions.cpp carries the numbered live-probe list for the orchestrator",
  /LIVE-PROBE LIST/.test(server) && /army_controller_next_id/.test(server));

console.log(`\nB228 missions: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
