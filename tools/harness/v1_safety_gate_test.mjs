// v1_safety_gate_test.mjs -- W23 V1 CRITICAL SAFETY, asserted at the source level (offline).
//
// the four release-gate decisions (docs/W18-TRIAGE-CANDIDATES.md critical rows, W23 wave):
//   1. The DFHack console is gated by a host setting, DEFAULT OFF, and the setting gates the
//      ROUTE -- POST /console/run and GET /console/commands refuse server-side when off. A
//      UI-only gate is security theatre: any player who knows the URL can POST. This suite
//      pins the refusal into the source the same way console_route_gate_test.mjs pins the
//      blocklist, so a regression that quietly drops the flag check fails in CI without a DF
//      build.
//   2. Squad disband frees DF-owned objects DFHack never frees (df::squad itself + native UI
//      pointer caches) -> guarded off behind `squad_disband`.
//   3. Zone removal (B34) purges the v50 zone-UI pointer caches (game.main_interface.civzone
//      cur_bld/list/zone_just_created) before Buildings::deconstruct, and is guarded off
//      behind `zone_remove` until one live probe passes.
//   4. The squad position-0 commander write (B249) was probe-guarded behind `squad_pos0` at BOTH
//      call sites. That guard is now GONE: the write was verified live on this machine 2026-07-17
//      (browser /squad-create -> /squad-assign?pos=0 seated the commander coherently, exactly one
//      fort noble assignment, disband unseated cleanly, DF alive). This suite now PINS the gate is
//      removed at both call sites and the verified-live note present -- re-adding the guard FAILS.
//
// After 2026-07-16 (zone_remove, hauling_route_delete, squad_disband liberated) and 2026-07-17
// (squad_pos0 liberated), dfhack_console is the SOLE remaining flag -- a host POLICY toggle, not a
// probe guard. It lives in dfcapture-hostwrites.json (THE established fail-closed mechanism -- same
// file the Lua hw_flags reads; missing file/key = OFF). The C++ reader must fail closed.
//
//   node tools/harness/v1_safety_gate_test.mjs
// Exit: 0 PASS, 1 FAIL.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (...p) => {                       // missing file = "" so absence FAILS checks, not the runner
  try { return fs.readFileSync(path.join(root, ...p), "utf8"); } catch (_) { return ""; }
};
const exists = (...p) => fs.existsSync(path.join(root, ...p));

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// ---- 0. the C++ hostwrites reader exists and FAILS CLOSED ---------------------------------------
console.log("# 0. src/write_guards.h -- one reader for dfcapture-hostwrites.json, fail closed");
{
  check("src/write_guards.h exists", exists("src", "write_guards.h"));
  check("src/write_guards.cpp exists", exists("src", "write_guards.cpp"));
  if (exists("src", "write_guards.h") && exists("src", "write_guards.cpp")) {
    const h = read("src", "write_guards.h");
    const cpp = read("src", "write_guards.cpp");
    const hCode = stripComments(h);
    check("reads dfcapture-hostwrites.json (SAME file as the Lua hw_flags -- one mechanism)",
      /dfcapture-hostwrites\.json/.test(h + cpp));
    // The pure scanner: only a literal `true` value enables. Everything else -- absent key,
    // malformed, "TRUE", 1, "yes" -- must scan false.
    check("scanner exists (scan_hostwrite_flag)", /scan_hostwrite_flag/.test(hCode));
    check("scanner enables ONLY on literal `true` (compare == 0 against \"true\")",
      /compare\(\s*i,\s*4,\s*"true"\s*\)\s*==\s*0/.test(hCode));
    check("scanner has no default-open path (never `return true` except the matched compare)",
      !/return\s+true\s*;/.test(hCode.replace(/return\s+text\.compare[^;]+;/, "")));
    // The cached reader must treat an unreadable/missing file as all-off.
    const cppCode = stripComments(cpp);
    check("missing/unreadable file -> false (fail closed), never a default-on fallback",
      !/=\s*true\s*;\s*\/\/\s*default/i.test(cppCode) && /return\s+false/.test(cppCode));
  }
}

// ---- 1. THE CONSOLE ROUTE REFUSES WHEN THE SETTING IS OFF ---------------------------------------
console.log("\n# 1. /console/run + /console/commands are gated by dfhack_console, ROUTE-side");
{
  const routes = read("src", "console_routes.cpp");
  const code = stripComments(routes);
  check("console_routes.cpp consults the hostwrites gate (console_enabled/hostwrite)",
    /console_enabled\s*\(|hostwrite_enabled\s*\(/.test(code));
  check("the gate names the dfhack_console flag", /dfhack_console/.test(routes));

  // ORDER IS THE FEATURE: in the run handler the flag refusal must land BEFORE the blocklist
  // and BEFORE the exec bridge -- when the console is off, NOTHING about the command runs.
  const gateAt = code.search(/console_enabled\s*\(|hostwrite_enabled\s*\(/);
  const denyAt = code.indexOf("command_denied");
  const runAt = code.indexOf("console_run_via_lua");
  check("flag gate is checked BEFORE the blocklist", gateAt >= 0 && denyAt > gateAt);
  check("flag gate is checked BEFORE the exec bridge", gateAt >= 0 && runAt > gateAt);

  // BOTH routes refuse: the catalog is part of the feature surface (a palette that lists every
  // command on a host that disabled the console is a live-looking console).
  const catalogAt = code.indexOf("console_catalog_json_via_lua");
  const catGate = code.slice(0, catalogAt);
  check("/console/commands (catalog) is ALSO gated before the catalog call",
    catalogAt >= 0 && /console_enabled\s*\(|hostwrite_enabled\s*\(/.test(catGate));

  check("a refused console call returns 403 with guarded:true",
    /403[\s\S]{0,400}guarded/.test(code) || /guarded[\s\S]{0,400}403/.test(code));

  // The original WT26 security model is NOT weakened by the gate:
  check("(preserved) no loopback/host-identity gate appears in console_routes.cpp",
    !/peer_ip_is_loopback/.test(code));
  check("(preserved) blocklist still gates execution when the console is ON",
    denyAt >= 0 && runAt >= 0 && denyAt < runAt);

  // test-the-test: strip every gate call and prove the detector (the rule-1 expression above)
  // reads false on the seeded source -- i.e. this suite CAN catch the gate being deleted.
  const seeded = code.replace(/console_enabled\s*\(|hostwrite_enabled\s*\(/g, "seeded_gone(");
  check("(test-the-test) a console_routes.cpp with the gate deleted is detected",
    !/console_enabled\s*\(|hostwrite_enabled\s*\(/.test(seeded));
}

// ---- 2. the three crash-risk writes -------------------------------------------------------------
console.log("\n# 2a. squad disband OPEN TO ALL (owner 2026-07-16) + purge_ui_caches_for_squad UAF fix");
{
  const squads = stripComments(read("src", "squads.cpp"));
  const handlerAt = squads.indexOf("squad_delete_handler");
  check("squads.cpp has the squad_delete handler", handlerAt >= 0);
  check("squad disband is no longer gated on squad_disband (open to all)",
    !/hostwrite_enabled\("squad_disband"\)/.test(squads));
  // The UAF root cause is fixed: do_squad_delete nulls the dying squad out of every native squad-UI
  // pointer cache BEFORE freeing it, under CoreSuspender (run_squad_locked). Same class as the B34
  // zone purge and the stockpile-uaf branch's purge_ui_caches_for_building.
  const purgeAt = squads.indexOf("void purge_ui_caches_for_squad");
  check("purge_ui_caches_for_squad exists", purgeAt >= 0);
  const purgeBody = squads.slice(purgeAt, squads.indexOf("bool do_squad_delete", purgeAt));
  for (const c of ["squad_list_sq", "name_squad", "barracks_squad", "ap_squad", "ap_squad_list",
                   "nearest_squad", "viewscreen_worldst", "order_load"]) {
    check(`purge covers the ${c} cache`, purgeBody.includes(c));
  }
  check("the world/mission viewscreen is purged via a full gview-stack walk",
    /getViewscreenByType<df::viewscreen_worldst>\(0\)/.test(purgeBody));
  const ddAt = squads.indexOf("bool do_squad_delete");
  const ddBody = squads.slice(ddAt, squads.indexOf("squad_delete_handler", ddAt));
  check("do_squad_delete purges caches BEFORE delete squad",
    /purge_ui_caches_for_squad\(squad\)/.test(ddBody) &&
    ddBody.indexOf("purge_ui_caches_for_squad(squad)") < ddBody.indexOf("delete squad"));
}

console.log("\n# 2b. noble unassign -- PROVED SAFE, stays live (no guard)");
{
  const admin = stripComments(read("src", "fort_admin.cpp"));
  // The proof is in the report; here we pin the SHAPE that makes it safe: erase-then-delete of
  // histfig_entity_link_positionst -- the exact type + recipe DFHack's Military.cpp:385 uses.
  const at = admin.indexOf("unlink_position_holder");
  const body = admin.slice(at, at + 900);
  check("unlink_position_holder still targets histfig_entity_link_positionst only",
    /histfig_entity_link_positionst/.test(body));
  check("...and erases the link from entity_links (no other holder exists for this type)",
    /entity_links\.erase/.test(body));
  check("noble unassign is NOT guarded (proved safe -- a guard here would be cargo cult)",
    !/hostwrite_enabled/.test(admin.slice(admin.indexOf("do_noble_assign"), admin.indexOf("do_noble_assign") + 2500)));
}

console.log("\n# 2c. hauling route/stop delete OPEN TO ALL (owner 2026-07-16) + view-cache purge kept");
{
  const hauling = stripComments(read("src", "hauling.cpp"));
  // Owner policy: no griefing gate on destructive play. The route-level hostwrite guard is gone;
  // join-auth upstream is the only gate. What KEEPS it safe (the view-cache purge) is pinned below.
  check("hauling.cpp no longer gates deletion on hauling_route_delete (open to all)",
    !/hauling_route_delete/.test(hauling));
  for (const h of ["route_remove_handler", "stop_remove_handler"]) {
    check(`hauling.cpp still has ${h}`, hauling.indexOf(h) >= 0);
  }
  // The concrete hazard: plotinfo.hauling.view_routes / view_stops (df.hauling.xml i_route /
  // i_stop -- the native Hauling menu's pointer caches) must be purged BEFORE the frees.
  const helpAt = hauling.indexOf("void purge_view_stop");
  check("the purge helpers exist (purge_view_stop / purge_view_route)",
    helpAt >= 0 && hauling.indexOf("void purge_view_route") >= 0);
  const helpers = hauling.slice(helpAt, hauling.indexOf("release_route_vehicles"));
  check("...and they erase from view_routes AND view_stops",
    /view_routes/.test(helpers) && /view_stops/.test(helpers));
  check("view_bad stays parallel to view_stops (erased in lockstep)",
    /view_bad/.test(helpers));
  const rrAt = hauling.indexOf("bool do_route_remove");
  const rrBody = hauling.slice(rrAt, hauling.indexOf("do_stop_add", rrAt));
  check("do_route_remove purges the caches BEFORE deleting the route",
    /purge_view_route/.test(rrBody) &&
    rrBody.indexOf("purge_view_route") < rrBody.lastIndexOf("delete route"));
  const srAt = hauling.indexOf("bool do_stop_remove");
  const srBody = hauling.slice(srAt, hauling.indexOf("bool do_stop_link", srAt));
  check("do_stop_remove purges the caches BEFORE deleting the stop",
    /purge_view_stop/.test(srBody) &&
    srBody.indexOf("purge_view_stop") < srBody.lastIndexOf("delete stop"));
}

// ---- 3. zone removal (B34) ----------------------------------------------------------------------
console.log("\n# 3. zone removal OPEN TO ALL (owner 2026-07-16) but still purges v50 UI caches");
{
  const zones = stripComments(read("src", "building_zone.cpp"));
  const handlerAt = zones.indexOf("zone_action_handler");
  check("building_zone.cpp has the zone_action handler", handlerAt >= 0);
  const handlerSlice = zones.slice(handlerAt, handlerAt + 1600);
  check("/zone-action remove/cancel/deconstruct is NOT gated on zone_remove (open to all)",
    !/zone_remove/.test(handlerSlice) && !/request_is_host_tab/.test(handlerSlice));
  // The B34 mechanism fix, now generalized: Buildings::deconstruct never clears
  // game.main_interface.civzone's cur_bld / list / zone_just_created (df.d_interface.xml:464-467).
  // The inline purge was refactored into the shared purge_ui_caches_for_building() helper (see
  // ui_cache_purge_guard_test.mjs for the field-by-field contract). Here we pin that zone remove
  // still purges BEFORE the free -- via the helper -- so the refactor provably lost nothing.
  const coreAt = zones.indexOf("zone_action_on_core_thread");
  const coreBody = zones.slice(coreAt, coreAt + 3000);
  const deconAt = coreBody.indexOf("Buildings::deconstruct");
  check("zone remove calls purge_ui_caches_for_building BEFORE deconstruct",
    /purge_ui_caches_for_building/.test(coreBody) &&
    coreBody.indexOf("purge_ui_caches_for_building") < deconAt);
  // The purges the B34 fix used are still present -- now inside the shared helper.
  const purgeSrc = stripComments(read("src", "ui_cache_purge.cpp"));
  check("(refactor loses nothing) helper still purges civzone.cur_bld",
    /cur_bld\s*=\s*nullptr/.test(purgeSrc));
  check("(refactor loses nothing) helper still purges civzone.zone_just_created",
    /zone_just_created/.test(purgeSrc));
  // enable/disable and settings writes stay live -- the guard covers only destruction.
  check("zone enable/disable is NOT guarded",
    !/zone_remove/.test(coreBody.slice(coreBody.indexOf("\"enable\""), coreBody.indexOf("\"enable\"") + 200)));
}

// ---- 4. squad position-0 write (B249): probe guard REMOVED (verified live 2026-07-17) -----------
console.log("\n# 4. squad pos-0 commander write LIBERATED (squad_pos0 gate removed)");
{
  const squadsRaw = read("src", "squads.cpp");
  const squads = stripComments(squadsRaw);
  // /squad-assign pos=0 seats the commander directly, with NO squad_pos0 / hostwrite gate.
  const assignAt = squads.indexOf("bool do_squad_assign");
  const assignBody = squads.slice(assignAt, squads.indexOf("bool do_squad_remove", assignAt));
  check("do_squad_assign's pos==0 path is no longer gated on squad_pos0 (seeded-bad: re-adding fails)",
    !/squad_pos0/.test(assignBody) && !/hostwrite_enabled/.test(assignBody) &&
    /squad_pos\s*==\s*0[\s\S]{0,160}seat_leader_at_pos0/.test(assignBody));
  // squad-create's auto-seat runs unconditionally now (no guard wrapping seat_leader_at_pos0).
  const createAt = squads.indexOf("int do_squad_create");
  const createBody = squads.slice(createAt, squads.indexOf("bool do_squad_rename", createAt));
  check("do_squad_create's auto-seat is no longer gated on squad_pos0 (seeded-bad: re-adding fails)",
    !/squad_pos0/.test(createBody) && !/hostwrite_enabled/.test(createBody) &&
    /seat_leader_at_pos0/.test(createBody));
  // No squad code references the flag, its reader, or the guarded-refusal shape anywhere.
  check("no squad code references the squad_pos0 flag or any hostwrite guard",
    !/squad_pos0/.test(squads) && !/hostwrite_enabled/.test(squads) &&
    !/guarded_refusal_json/.test(squads));
  // The verified-live evidence must be recorded in the source (raw file, comments intact).
  check("the verified-live 2026-07-17 evidence note is present at the pos-0 seat",
    /VERIFIED LIVE 2026-07-17/.test(squadsRaw) && /3151/.test(squadsRaw));
}

// ---- 5. wiring + client honesty -----------------------------------------------------------------
console.log("\n# 5. wiring: guards surface, host toggle, no live-looking buttons");
{
  const httpsrv = stripComments(read("src", "http_server.cpp"));
  const registerAt = httpsrv.indexOf("register_write_guard_routes");
  const catchallAt = httpsrv.search(/Post\s*\(\s*"\.\*"/);
  check("register_write_guard_routes is called in http_server.cpp", registerAt >= 0);
  check("...above the catch-all (auth pre-routing covers it)",
    catchallAt < 0 || registerAt < catchallAt);

  const wg = read("src", "write_guards.cpp") + read("src", "write_guards.h");
  const wgCode = stripComments(wg);
  // After 2026-07-16 (zone_remove, hauling_route_delete, squad_disband) and 2026-07-17 (squad_pos0),
  // /write-guards serves exactly ONE flag: the console POLICY toggle. Every probe guard is retired.
  check("GET /write-guards serves the sole remaining flag (dfhack_console) read-only",
    /\/write-guards/.test(wgCode) && /dfhack_console/.test(wgCode));
  check("all liberated flags are fully removed from the guard registry",
    !/zone_remove/.test(wgCode) && !/hauling_route_delete/.test(wgCode) &&
    !/squad_disband/.test(wgCode) && !/squad_pos0/.test(wgCode) && !/kSquadPos0Flag/.test(wgCode));
  // The console toggle is HOST-ONLY through the shared HTTP/WS origin classifier.
  check("/console-config exists and is host-gated (shared request origin)",
    /\/console-config/.test(wgCode) && /request_has_host_authority/.test(wgCode));
  // The squad_pos0 exception route is GONE: with the probe guard lifted there is no writable-flag
  // HTTP route but /console-config. No generic arbitrary-flag mutation route may exist.
  check("the squad_pos0 /write-guard-config toggle route is removed",
    !/write-guard-config/.test(wgCode));

  const html = read("web", "index.html");
  check("consoleBtn ships hidden by default (shown only when the host setting is on)",
    /id="consoleBtn"[^>]*style="display:\s*none/.test(html));
  check("the write-guards client module is loaded", /dwf-write-guards\.js/.test(html));

  const wgjs = read("web", "js", "dwf-write-guards.js");
  check("client guard state FAILS CLOSED (=== true test, unknown/unreachable = locked)",
    /===\s*true/.test(wgjs));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
