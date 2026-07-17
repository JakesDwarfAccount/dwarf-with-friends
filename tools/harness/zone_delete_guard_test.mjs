// zone_delete_guard_test.mjs -- OFFLINE contract for browser DESTRUCTIVE PLAY actions after the
// 2026-07-16 owner policy: this is small-group co-op on private links, so griefing-protection
// gates are REMOVED. Zone removal and hauling route/stop deletion are open to every AUTHENTICATED
// player (join-auth still upstream). Squad disband is now ALSO open to all: its former hold was an
// unfinished crash risk (implementation safety, not anti-grief), and that UAF is fixed --
// do_squad_delete purges the UI caches before freeing the squad. No DF, no server.
// Covers:
//   1. zone/hauling deletes are UNGATED at the route (allow-for-all) -- and native-faithful
//      (Buildings::deconstruct / purge-before-free, under CoreSuspender).
//   2. the client controls are unconditionally live (no disabled-with-tooltip lock states, no
//      zone_remove / hauling_route_delete flags left in the write-guard mirror).
//   3. the honest reopen-after-delete "Zone unavailable" refresh-to-truth state is KEPT (that is
//      correctness, not protection).
//   4. squad_disband is LIBERATED (open to all) now that do_squad_delete's un-purged UI pointer
//      caches are fixed -- purge_ui_caches_for_squad runs before the free; pinned so the purge
//      cannot be dropped and the old griefing flag cannot be resurrected.
//   5. seeded-bad (test-the-test): REINTRODUCING a griefing guard on the liberated routes MUST
//      fail these pins; dropping a native-faithfulness safeguard MUST fail these pins.
//   node tools/harness/zone_delete_guard_test.mjs   (exit 0 PASS / 1 FAIL)

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const webJs = name => join(here, "..", "..", "web", "js", name);
const src = name => join(here, "..", "..", "src", name);

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

const bz = readFileSync(src("building_zone.cpp"), "utf8");
const haul = readFileSync(src("hauling.cpp"), "utf8");
const squads = readFileSync(src("squads.cpp"), "utf8");
const wgH = readFileSync(src("write_guards.h"), "utf8");
const wgCpp = readFileSync(src("write_guards.cpp"), "utf8");
const zjs = readFileSync(webJs("dwf-building-zone-stockpile-panels.js"), "utf8");
const shell = readFileSync(webJs("dwf-control-shell.js"), "utf8");
const wgJs = readFileSync(webJs("dwf-write-guards.js"), "utf8");
const placement = readFileSync(webJs("dwf-controls-placement.js"), "utf8");

// ---- parse ---------------------------------------------------------------------------------------
console.log("\n# parse");
for (const f of ["dwf-building-zone-stockpile-panels.js", "dwf-control-shell.js",
                 "dwf-write-guards.js", "dwf-controls-placement.js", "dwf-hostpanel.js"]) {
  try { execFileSync(process.execPath, ["--check", webJs(f)], { stdio: "pipe" }); check(`node --check ${f}`, true); }
  catch (e) { check(`node --check ${f}`, false, e.stderr ? e.stderr.toString() : e.message); }
}

// ================================================================================================
console.log("\n# zone removal: OPEN TO ALL authenticated players (building_zone.cpp)");
const zhStart = bz.indexOf("auto zone_action_handler =");
const zh = zhStart >= 0 ? bz.slice(zhStart, bz.indexOf('server.Get("/zone-action"', zhStart)) : "";
check("the /zone-action handler exists", zh.length > 0);
check("remove/cancel/deconstruct is NOT gated on a hostwrite flag (no 501 griefing refusal)",
  zh.length > 0 && !/hostwrite_enabled\("zone_remove"\)/.test(zh) && !/guarded_refusal_json/.test(zh));
check("no host-only special-casing remains on the delete (plain allow, no request_is_host_tab)",
  zh.length > 0 && !/request_is_host_tab/.test(zh));
check("policy is documented as open-to-all with join-auth upstream",
  /OPEN TO EVERY AUTHENTICATED PLAYER/.test(bz) && /join-auth catch-all/.test(bz));

console.log("\n# zone removal stays NATIVE-FAITHFUL (the safety that lets it ship to everyone)");
check("delete delegates to the native/DFHack canonical free Buildings::deconstruct(z)",
  /return Buildings::deconstruct\(z\);/.test(bz));
check("mutation runs under CoreSuspender (run_building_zone_locked)",
  /DFHack::CoreSuspender suspend;/.test(bz) && /run_building_zone_locked/.test(bz));
// B34 purge now lives in the shared purge_ui_caches_for_building() helper (ui_cache_purge.cpp;
// field-by-field contract pinned in ui_cache_purge_guard_test.mjs). Here we pin the call site:
// zone remove purges via the helper BEFORE the free.
check("B34 dangling-pointer fix: v50 zone-UI pointer caches purged BEFORE the free",
  /purge_ui_caches_for_building/.test(bz) &&
  bz.indexOf("purge_ui_caches_for_building") < bz.indexOf("return Buildings::deconstruct(z);"));

// ================================================================================================
console.log("\n# hauling route/stop delete: OPEN TO ALL (hauling.cpp)");
check("/hauling-route-remove is NOT gated on hauling_route_delete",
  !/hostwrite_enabled\("hauling_route_delete"\)/.test(haul) && !/guarded_refusal_json/.test(haul));
check("both delete paths run under CoreSuspender (run_hauling_locked)",
  /run_hauling_locked/.test(haul));
check("route delete purges the native Hauling view caches + releases carts BEFORE the free",
  /purge_view_route\(plotinfo, route\)/.test(haul) && /release_route_vehicles\(route\)/.test(haul) &&
  haul.indexOf("purge_view_route(plotinfo, route)") < haul.indexOf("delete route;"));
check("stop delete purges the view_stop cache before freeing the stop",
  /purge_view_stop\(plotinfo, stop\)/.test(haul) &&
  haul.indexOf("purge_view_stop(plotinfo, stop)") < haul.indexOf("delete stop;"));

// ================================================================================================
console.log("\n# client controls are unconditionally live (locks removed)");
check("zone remove button renders with NO guard/disabled/tooltip lock branch",
  /dataset: \{ zoneAct: "remove" \}, title: "Remove zone"/.test(zjs) &&
  !/enabled\("zone_remove"\)/.test(zjs) && !/zoneRemoveButtonState/.test(zjs));
check("zone map-click + repaint-accept removal have no client lock check",
  !/enabled\("zone_remove"\)/.test(placement) && !/reason\("zone_remove"\)/.test(placement));
check("hauling remove tiles are plain live tiles, not guardedTile(hauling_route_delete)",
  !/guardedTile\(/.test(shell) && /haulingRouteRemove:id \}, "Remove route"/.test(shell) &&
  /haulingStopRemove:`[^`]*` \}, "Remove stop"/.test(shell));
check("the write-guard mirror carries ONLY the sole survivor (dfhack_console)",
  !/zone_remove/.test(wgJs) && !/hauling_route_delete/.test(wgJs) && !/squad_disband/.test(wgJs) &&
  !/squad_pos0/.test(wgJs) && /dfhack_console/.test(wgJs));
check("the liberated flag constants are gone from the C++ guard registry",
  !/kZoneRemoveFlag/.test(wgH) && !/kHaulingDeleteFlag/.test(wgH) && !/kSquadDisbandFlag/.test(wgH) &&
  !/kSquadPos0Flag/.test(wgH) && !/kSquadPos0Flag/.test(wgCpp) &&
  !/kZoneRemoveFlag|kHaulingDeleteFlag|kSquadDisbandFlag/.test(wgCpp));
check("GET /write-guards enumeration is down to the sole survivor (dfhack_console)",
  /const char\* flags\[\] = \{ kConsoleFlag \}/.test(wgCpp.replace(/\s+/g, " ")));

// ================================================================================================
console.log("\n# reopen-after-delete: honest 'Zone unavailable' KEPT (correctness, not protection)");
check("a gone/unfetchable zone renders an explicit closable 'Zone unavailable' panel",
  /Zone unavailable/.test(zjs) && /data-zone-unavail-close/.test(zjs) &&
  /\[data-zone-unavail-close\][\s\S]{0,160}closeSelection\(\)/.test(zjs));
guard("it reuses the SAME pattern the stockpile panel uses ('Stockpile unavailable')",
  /Stockpile unavailable/.test(zjs));

// ================================================================================================
console.log("\n# squad disband: LIBERATED after the UAF fix (open to all) + purge_ui_caches_for_squad");
const sdStart = squads.indexOf("auto squad_delete_handler =");
const sd = sdStart >= 0 ? squads.slice(sdStart, squads.indexOf('server.Get("/squad-delete"', sdStart)) : "";
check("/squad-delete is NOT gated on squad_disband anymore (open to all)",
  sd.length > 0 && !/hostwrite_enabled\("squad_disband"\)/.test(sd) && !/guarded_refusal_json/.test(sd));

// The UAF root cause: do_squad_delete freed the squad while native squad screens held raw pointers
// to it. purge_ui_caches_for_squad must NULL the dying squad out of EVERY named cache, BEFORE the
// free, under CoreSuspender -- the same class as the B34 zone purge and the stockpile-uaf branch.
const purgeStart = squads.indexOf("inline void null_if_squad");
const purge = purgeStart >= 0 ? squads.slice(purgeStart, squads.indexOf("bool do_squad_delete", purgeStart)) : "";
check("purge_ui_caches_for_squad exists (sibling of purge_ui_caches_for_building)",
  purge.length > 0 && /void purge_ui_caches_for_squad/.test(purge));
for (const cache of ["view.squad_list_sq", "view.name_squad", "barracks_squad", "ap_squad",
                     "ap_squad_list", "squads.list", "squads.nearest_squad"]) {
  check(`purge covers the ${cache} cache`, purge.includes(cache));
}
// The world/mission viewscreen (d_interface:7029 viewscreen_worldst.squad) caches FORT squads for
// mission dispatch and can be live during fort play -- purge it by walking the whole gview stack.
check("purge covers viewscreen_worldst.squad via a full-stack walk (getViewscreenByType<>(0))",
  /getViewscreenByType<df::viewscreen_worldst>\(0\)/.test(purge) && /wv->squad/.test(purge));
// world.squads.order_load (squad:356) -- DF has-bad-pointers load buffer; nulled as defense-in-depth.
check("purge covers world.squads.order_load", /world->squads\.order_load/.test(purge));
check("purge never ERASES from a parallel-vector member -- null-in-place or whole-family clear only",
  /p = nullptr/.test(purge) && /slot = nullptr/.test(purge) && !/\.erase\(/.test(purge));

// ---- 2026-07-17 renderer-guardedness audit: dependent squad screens are DISMISSED, not just ------
// nulled. No static consumer of the main_interface squad caches exists anywhere in the binary
// (full displacement + VA scan, prior_art_types2), so per-consumer null-check proof is unobtainable
// and dump 97692 proved this renderer family derefs subjects unguarded. Fix shape: mirror DF's own
// decomp-proven resets (FUN_1408bd4e0 clears both assigning_position flags; FUN_1407c49c0 clears
// barracks_squad+barracks_squad_flag together + ind=0). Empty list = native state; null entry = not.
console.log("\n# squad purge closes dependent screens (location_selector fix shape, 2026-07-17)");
check("audit provenance documented (FUN_1408bd4e0 flag-clear + FUN_1407c49c0 pair-clear cites)",
  /FUN_1408bd4e0/.test(purge) && /FUN_1407c49c0/.test(purge) &&
  /0x1408bd902/.test(purge) && /widget indirection|NOT obtainable statically/.test(purge));
check("unit-sheet squad tab: all FIVE parallel vectors cleared together + selected_squad reset",
  /squad_list_sq\.clear\(\)[\s\S]{0,220}squad_list_ep\.clear\(\)[\s\S]{0,200}squad_list_epp\.clear\(\)[\s\S]{0,180}squad_list_has_subord_pos\.clear\(\)[\s\S]{0,160}squad_list_add_index\.clear\(\)[\s\S]{0,140}selected_squad = 0/.test(purge));
check("squad rename box CLOSED when its subject dies (name_squad nulled AND naming_squad=false)",
  /name_squad == squad[\s\S]{0,160}name_squad = nullptr[\s\S]{0,120}naming_squad = false/.test(purge));
check("barracks pair cleared TOGETHER (squad+flag) with barracks_selected_squad_ind reset",
  /barracks_squad\.clear\(\)[\s\S]{0,120}barracks_squad_flag\.clear\(\)[\s\S]{0,120}barracks_selected_squad_ind = 0/.test(purge));
check("assign-position pickers dismissed: BOTH mode flags cleared when subject or any entry dies",
  /ap_squad = nullptr/.test(purge) && /ap_squad_list\.clear\(\)/.test(purge) &&
  /ap_squad_sel = 0/.test(purge) &&
  /assigning_position = false[\s\S]{0,80}assigning_position_squad = false/.test(purge));
check("picker dismissal is conservative: fires when the dying squad is subject OR any list entry",
  /ap_hit \|\| apl_hit/.test(purge) && /contains_squad\(mi\.ap_squad_list, squad\)/.test(purge));
check("null-tolerant surfaces documented as GUARDED-by-DF-contract (plotinfo.squads reset cite)",
  /FUN_140e5c1c0/.test(purge) && /has-bad-pointers/.test(purge));

// seeded-bad: nulling WITHOUT closing the dependent screen is the exact half-fix that produced
// crash #2 (dump 97692). Each detector above must bite when the close/clear half is removed.
guard("(seeded-bad) nulling name_squad WITHOUT naming_squad=false is detected",
  !/name_squad == squad[\s\S]{0,160}name_squad = nullptr[\s\S]{0,120}naming_squad = false/
    .test(purge.replace(/naming_squad = false;/, "/* close removed */")));
guard("(seeded-bad) nulling ap_squad WITHOUT clearing the assigning_position flags is detected",
  !/assigning_position = false[\s\S]{0,80}assigning_position_squad = false/
    .test(purge.replace(/assigning_position = false;\s*\n\s*mi\.assigning_position_squad = false;/, "/* dismiss removed */")));
guard("(seeded-bad) clearing barracks_squad WITHOUT its parallel flag vector is detected",
  !/barracks_squad\.clear\(\)[\s\S]{0,120}barracks_squad_flag\.clear\(\)/
    .test(purge.replace(/mi\.barracks_squad_flag\.clear\(\);/, "/* pair member removed */")));
// Reviewer correction: :7029 is viewscreen_worldst, NOT setup_race_selectionst. The record must
// name the right type and must not resurrect the wrong "embark-only, unreachable" excuse.
check("corrected attribution: :7029 named as viewscreen_worldst, setup_race_selectionst excuse gone",
  /viewscreen_worldst.squad\s+\(d_interface:7029\)/.test(purge) &&
  !/setup_race_selectionst.*unreachable/.test(squads) &&
  !/NOT purged: setup_race_selectionst/.test(squads));
const ddStart = squads.indexOf("bool do_squad_delete");
const dd = ddStart >= 0 ? squads.slice(ddStart, squads.indexOf("auto squad_delete_handler", ddStart)) : "";
check("do_squad_delete purges the UI caches BEFORE freeing the squad",
  /purge_ui_caches_for_squad\(squad\)/.test(dd) &&
  dd.indexOf("purge_ui_caches_for_squad(squad)") < dd.indexOf("delete squad;"));
check("the free path runs under CoreSuspender (run_squad_locked)",
  /run_squad_locked/.test(squads) && /DFHack::CoreSuspender/.test(squads));

// ================================================================================================
console.log("\n# seeded-bad (a re-added griefing guard or a dropped safeguard MUST fail here)");
guard('re-adding hostwrite_enabled("zone_remove") to the zone handler would fail the allow-all pin',
  zh.length > 0 && !/hostwrite_enabled\("zone_remove"\)/.test(zh));
guard('re-adding hostwrite_enabled("hauling_route_delete") would fail the allow-all pin',
  !/hostwrite_enabled\("hauling_route_delete"\)/.test(haul));
guard("dropping the B34 cache purge before deconstruct would fail the native-faithfulness pin",
  bz.indexOf("purge_ui_caches_for_building") >= 0 &&
  bz.indexOf("purge_ui_caches_for_building") < bz.indexOf("return Buildings::deconstruct(z);"));
guard("dropping purge_view_route before the route free would fail the hauling safety pin",
  haul.indexOf("purge_view_route(plotinfo, route)") >= 0 &&
  haul.indexOf("purge_view_route(plotinfo, route)") < haul.indexOf("delete route;"));
guard("freeing the squad WITHOUT purge_ui_caches_for_squad (the exact UAF) fails the purge-before-free pin",
  dd.indexOf("purge_ui_caches_for_squad(squad)") >= 0 &&
  dd.indexOf("purge_ui_caches_for_squad(squad)") < dd.indexOf("delete squad;"));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
