// ui_cache_purge_guard_test.mjs -- source-contract guard for the v50 UI-cache UAF fix (offline).
//
// The bug CLASS (dump-proven twice): Buildings::deconstruct frees a building but never clears
// game.main_interface's raw building* caches, so DF's renderer virtual-calls a freed building next
// frame -> 0xc0000005. B34 proved it for zones (civzone.cur_bld/list/zone_just_created); the
// 2026-07-16 dump proved it for stockpiles (custom_stockpile.sp held a freed building_stockpilest
// at crash time, faulting instruction building->getName()).
//
// The fix is ONE shared helper -- purge_ui_caches_for_building(df::building*) -- called from EVERY
// deconstruct path under the CoreSuspender, BEFORE the free. This suite pins, at the source level
// (no DF build needed):
//   A. the helper exists and purges every building-pointer cache the main_interface.h audit found,
//      each guarded by an equality against the dying building (unrelated buildings untouched),
//      and leaves id-based caches alone;
//   B. every deconstruct call site (zone remove, stockpile remove, stockpile repaint, generic
//      building-action remove) calls the helper BEFORE Buildings::deconstruct, inside a
//      run_*_locked lambda that establishes a CoreSuspender;
//   C. test-the-test: a path with the helper call deleted FAILS the "purges before free" check;
//   D. the DIAG log-spam gate (DWF_DIAG) ships default-OFF and wtrace() early-returns when off.
//
//   node tools/harness/ui_cache_purge_guard_test.mjs
// Exit: 0 PASS, 1 FAIL.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = (...p) => {
  try { return fs.readFileSync(path.join(root, ...p), "utf8"); } catch (_) { return ""; }
};
const exists = (...p) => fs.existsSync(path.join(root, ...p));
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

let failed = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

// ---- A. the shared helper: complete building-pointer purge, conservative -----------------------
console.log("# A. src/ui_cache_purge.{h,cpp} -- purge every v50 building* cache, guarded by identity");
const purgeRaw = read("src", "ui_cache_purge.cpp");
const purge = stripComments(purgeRaw);
{
  check("src/ui_cache_purge.h exists", exists("src", "ui_cache_purge.h"));
  check("src/ui_cache_purge.cpp exists", exists("src", "ui_cache_purge.cpp"));
  check("declares purge_ui_caches_for_building(df::building*)",
    /void\s+purge_ui_caches_for_building\s*\(\s*df::building\s*\*/.test(read("src", "ui_cache_purge.h")));
  // Null-safety: a null building or a null game must not deref.
  check("guards null building and null game before touching main_interface",
    /if\s*\(\s*!\s*b\s*\)\s*return/.test(purge) && /if\s*\(\s*!\s*game\s*\)\s*return/.test(purge));

  // Every building-pointer cache field from the main_interface.h audit gets a purge cell. Each
  // must be (i) assigned nullptr AND (ii) guarded by an equality against the dying building, so an
  // UNRELATED building is left untouched. (id/abstract_building caches are deliberately excluded.)
  const purgedFields = [
    ["civzone.cur_bld",                  /cur_bld\s*==\s*b[\s\S]{0,60}cur_bld\s*=\s*nullptr/],
    ["civzone.list[]",                   /list\[i\]\s*==\s*b[\s\S]{0,80}list\.erase/],
    ["civzone.zone_just_created[]",      /zone_just_created\[i\]\s*==\s*b[\s\S]{0,120}zone_just_created\.erase/],
    ["info.buildings.list[mode][]",      /mode_list\[i\]\s*==\s*b[\s\S]{0,80}mode_list\.erase/],
    ["custom_stockpile.abd",             /abd\s*==\s*sp[\s\S]{0,140}abd\s*=\s*nullptr/],
    ["custom_stockpile.sp",              /sp\s*==\s*&\s*sp->settings[\s\S]{0,140}\.sp\s*=\s*nullptr/],
    ["custom_stockpile.open",            /open\s*=\s*false/],
    ["stockpile.cur_bld",                /stockpile\.cur_bld\s*==\s*sp[\s\S]{0,60}cur_bld\s*=\s*nullptr/],
    ["job_details.bld",                  /job_details\.bld\s*==\s*b[\s\S]{0,60}job_details\.bld\s*=\s*nullptr/],
    ["buildjob.display_furniture_bld",   /display_furniture_bld\s*==\s*furn[\s\S]{0,90}display_furniture_bld\s*=\s*nullptr/],
    ["assign_display_item.display_bld",  /display_bld\s*==\s*furn[\s\S]{0,80}display_bld\s*=\s*nullptr/],
    ["trade.bld",                        /trade\.bld\s*==\s*depot[\s\S]{0,60}trade\.bld\s*=\s*nullptr/],
    ["assign_trade.trade_depot_bld",     /trade_depot_bld\s*==\s*depot[\s\S]{0,80}trade_depot_bld\s*=\s*nullptr/],
  ];
  for (const [field, re] of purgedFields)
    check(`purges ${field} only when it references the dying building`, re.test(purge), field);

  // Dependent-view sweep (dump 97692, 2026-07-16 22:25): the location_selector crash proved that a
  // purged building* cache whose dependent sub-interface carries an `open` flag must be CLOSED, not
  // merely nulled -- otherwise that interface's renderer dereferences the (now-null) subject next
  // frame. Each close MUST be guarded by the dying-building identity so only the panel pointed at
  // THIS building is dismissed. One cell per sweep decision.
  const dependentCloses = [
    // location_selector: no zone pointer of its own; it renders civzone.cur_bld->location_id
    // unguarded (FUN_1403b7cf0 @ exe+0x3b9bc1). Close under cur_bld identity + the exact context,
    // and reset context to NONE.
    ["location_selector closed under cur_bld==b + ZONE_MEETING_AREA_ASSIGNMENT context",
     /cur_bld\s*==\s*b[\s\S]{0,260}location_selector[\s\S]{0,200}context\s*==[\s\S]{0,90}ZONE_MEETING_AREA_ASSIGNMENT[\s\S]{0,80}open\s*=\s*false/],
    ["location_selector.context reset to NONE on close",
     /ZONE_MEETING_AREA_ASSIGNMENT[\s\S]{0,140}context\s*=\s*[\s\S]{0,60}NONE/],
    ["job_details.open closed when its bld dies",
     /job_details\.bld\s*==\s*b[\s\S]{0,160}job_details\.open\s*=\s*false/],
    ["assign_display_item.open closed when its display_bld dies",
     /assign_display_item\.display_bld\s*==\s*furn[\s\S]{0,160}assign_display_item\.open\s*=\s*false/],
    ["trade.open closed when its depot dies",
     /trade\.bld\s*==\s*depot[\s\S]{0,160}trade\.open\s*=\s*false/],
    ["assign_trade.open closed when its depot dies",
     /assign_trade\.trade_depot_bld\s*==\s*depot[\s\S]{0,180}assign_trade\.open\s*=\s*false/],
  ];
  for (const [name, re] of dependentCloses)
    check(`dependent-view sweep: ${name}`, re.test(purge), name);

  // No-open-flag interfaces are null-only by design; pin the ABSENCE of a bogus close so a future
  // edit doesn't cargo-cult an `open` onto a struct that has no such field.
  check("buildjob is null-only (buildjob_interfacest has no open flag)", !/buildjob\.open/.test(purge));
  check("info.buildings is list-erase-only (no open flag / subject pointer)",
    !/buildings\.open/.test(purge));
  // The audit table must carry the dependent-view sweep decision record.
  check("audit table documents the dependent-view sweep (open-flag close rule + evidence)",
    /DEPENDENT-VIEW SWEEP/.test(purgeRaw) && /location_selector/.test(purgeRaw) &&
    /\bCLOSE\b/.test(purgeRaw) && /FUN_1403b7cf0|3b9bc1/.test(purgeRaw));

  // 2026-07-17 offset correction (MSVC offsetof probe): the prior dump analysis placed
  // custom_stockpile.sp at gamest+0x2c10 via a stale typed-Ghidra layout; ground truth is +0x2cb0.
  // The purge is immune because it names fields (compiler resolves offsets) -- pin BOTH the
  // documented correction and that no code path hardcodes either raw offset.
  check("stockpile offset citation corrected (+0x2cb0 ground truth; stale +0x2c10 flagged as such)",
    /0x2cb0/.test(purgeRaw) && /0x2c10/.test(purgeRaw) && /BY FIELD NAME/.test(purgeRaw));
  check("no code depends on a hardcoded gamest offset (purge is field-name based)",
    !/0x2c10|0x2cb0/.test(purge));

  // Typed subtype gating: pointer fields are compared to the right virtual_cast, so the helper is
  // sound across building types (a stockpile* never gets nulled by the trade-depot branch, etc.).
  check("stockpile fields gated behind virtual_cast<building_stockpilest>",
    /virtual_cast<df::building_stockpilest>/.test(purge));
  check("display-furniture fields gated behind virtual_cast<building_display_furniturest>",
    /virtual_cast<df::building_display_furniturest>/.test(purge));
  check("trade-depot fields gated behind virtual_cast<building_tradedepotst>",
    /virtual_cast<df::building_tradedepotst>/.test(purge));
  // info.buildings.list is a static-array of vectors -> iterate ALL modes (ranged-for), not one.
  check("info.buildings.list purge iterates ALL modes (ranged-for over the mode array)",
    /for\s*\(\s*auto\s*&\s*\w+\s*:\s*mi\.info\.buildings\.list\s*\)/.test(purge));

  // Conservative by construction: no UNGUARDED `= nullptr` on a cache (every null is preceded by a
  // matching `==` identity test in the same block). Approximate: count nullptr assigns vs `==`.
  const nulls = (purge.match(/=\s*nullptr/g) || []).length;
  const eqs = (purge.match(/==\s*(b|sp|depot|furn)\b/g) || []).length;
  check("no unconditional cache clears (every nullptr assign has an identity guard)", eqs >= nulls, `nulls=${nulls} eqs=${eqs}`);

  // id-based caches must NOT be purged -- purging by id here would be at best pointless and at
  // worst wrong (ids are reused). Pin their ABSENCE so a future edit doesn't cargo-cult them in.
  check("does NOT touch view_sheets id caches (viewing_unid/itid)",
    !/viewing_unid/.test(purge) && !/viewing_itid/.test(purge));
  check("does NOT touch create_work_order.forced_bld_id", !/forced_bld_id/.test(purge));
  check("does NOT null abstract_building caches (selected_ab/valid_ab -- different free class)",
    !/selected_ab\s*=\s*nullptr/.test(purge) && !/valid_ab\s*=\s*nullptr/.test(purge));

  // building_interfacest.button/press_button/filtered_button[].bd is CLASSIFIED (not omitted):
  // the audit must carry a SAFE row explaining it is not the render-thread UAF class, and the
  // helper must NOT blind-mutate the shared build-menu buttons (naive erase/delete would dangle
  // or double-free the object shared across button+press_button; nulling ->bd only trades a
  // click-time UAF for a click-time null-deref). Pin BOTH the documentation and the non-mutation.
  check("audit table documents the building.button[].bd classification with SAFE + evidence",
    /button\/press_button\/filtered_button/.test(purgeRaw) && /\bSAFE\b/.test(purgeRaw) &&
    /never dereferences[\s\S]{0,8}->bd/i.test(purgeRaw) && /press handler/i.test(purgeRaw));
  check("helper does NOT erase or null the build-menu button vectors (avoids dangle/double-free)",
    !/press_button\.erase/.test(purge) && !/filtered_button\.erase/.test(purge) &&
    !/->\s*bd\s*=\s*nullptr/.test(purge) && !/\.button\.erase/.test(purge));
}

// ---- B. every deconstruct path calls the helper BEFORE the free, under CoreSuspender ------------
console.log("\n# B. every building-deconstruct path purges via the helper, before the free");
const zones = stripComments(read("src", "building_zone.cpp"));
const stock = stripComments(read("src", "stockpile_panel.cpp"));

// run_*_locked establish the CoreSuspender the purge must run under.
check("run_building_zone_locked establishes a CoreSuspender",
  /run_building_zone_locked[\s\S]{0,400}CoreSuspender/.test(zones));
check("run_stockpile_locked establishes a CoreSuspender",
  /run_stockpile_locked[\s\S]{0,400}CoreSuspender/.test(stock));

// Per-call-site: helper is called and BEFORE Buildings::deconstruct in the same body.
function purgesBeforeFree(body) {
  const p = body.indexOf("purge_ui_caches_for_building");
  const d = body.indexOf("Buildings::deconstruct");
  return p >= 0 && d >= 0 && p < d;
}
const sites = [
  ["zone remove (zone_action_on_core_thread)",
    zones.slice(zones.indexOf("zone_action_on_core_thread"), zones.indexOf("if (action == \"pond\")"))],
  ["generic building-action remove (building_action_on_core_thread)",
    // Bound by the "suspend" action branch that immediately follows the remove branch -- a stable
    // structural anchor rather than a fragile fixed byte offset.
    zones.slice(zones.indexOf("building_action_on_core_thread"), zones.indexOf('action == "suspend"'))],
  ["stockpile remove (remove_stockpile_on_core_thread)",
    stock.slice(stock.indexOf("remove_stockpile_on_core_thread"), stock.indexOf("set_stockpile_links_only_on_core_thread"))],
  ["stockpile repaint/resize (finish_stockpile_repaint_on_core_thread)",
    stock.slice(stock.indexOf("finish_stockpile_repaint_on_core_thread"), stock.indexOf("register_stockpile_routes"))],
];
for (const [name, body] of sites)
  check(`${name} purges via helper BEFORE Buildings::deconstruct`, purgesBeforeFree(body), name);

// ---- C. test-the-test: a path that SKIPS the helper must FAIL --------------------------------
console.log("\n# C. seeded-bad: a deconstruct path without the helper call is detected");
{
  const good = sites[2][1]; // stockpile remove
  const seeded = good.replace(/purge_ui_caches_for_building\s*\([^;]*\);/g, "/* purge removed */");
  check("(seeded-bad) stockpile remove with the purge deleted FAILS the before-free check",
    !purgesBeforeFree(seeded));
  // and the field-contract detector actually bites if the helper body loses a purge.
  const seededHelper = purge.replace(/custom_stockpile[\s\S]{0,200}?cs\.sp\s*=\s*nullptr\s*;/, "/* stockpile purge removed */");
  check("(seeded-bad) a helper missing the custom_stockpile.sp purge is detected",
    !/\.sp\s*=\s*nullptr/.test(seededHelper));
  // Item 1: a helper that drops the info.buildings.list purge must be caught -- this is the
  // reviewer-required render-UAF cache, so its detector has to bite.
  const seededInfo = purge.replace(/for\s*\(\s*auto\s*&\s*\w+\s*:\s*mi\.info\.buildings\.list[\s\S]{0,220}?mode_list\.erase[^;]*;/, "/* info.buildings purge removed */");
  check("(seeded-bad) a helper missing the info.buildings.list purge is detected",
    !/mi\.info\.buildings\.list/.test(seededInfo) || !/mode_list\.erase/.test(seededInfo));
  // Item (dump 97692): the location_selector dependent-view close is the 2026-07-16 22:25 crash fix.
  // A helper that nulls civzone.cur_bld but leaves the picker OPEN must be caught -- that is the
  // exact half-invariant that turned the freed-zone UAF into a null-deref at exe+0x3b9bc1.
  const seededPicker = purge.replace(/ls\.open\s*=\s*false\s*;/, "/* picker close removed */");
  check("(seeded-bad) nulling civzone.cur_bld WITHOUT closing location_selector is detected",
    !/ZONE_MEETING_AREA_ASSIGNMENT[\s\S]{0,80}open\s*=\s*false/.test(seededPicker));
  // Item: dropping a trade/assign_trade close (subject depot freed under an open trade screen)
  // must also be caught by the dependent-view detectors.
  const seededTrade = purge.replace(/trade\.open\s*=\s*false\s*;/g, "/* trade close removed */");
  check("(seeded-bad) a helper that stops closing trade.open on depot death is detected",
    !/trade\.bld\s*==\s*depot[\s\S]{0,160}trade\.open\s*=\s*false/.test(seededTrade));
}

// ---- D. DIAG log-spam gate ships default-OFF -------------------------------------------------
console.log("\n# D. DIAG trace gate (DWF_DIAG) default-off; wtrace early-returns when off");
{
  const lua = read("dwf.lua");
  check("DWF_DIAG is declared and defaults to false", /DWF_DIAG\s*=\s*false/.test(lua));
  const wtraceAt = lua.indexOf("function wtrace(msg)");
  const wtraceBody = lua.slice(wtraceAt, wtraceAt + 400);
  check("wtrace() early-returns when DWF_DIAG is off (before any printerr/file I/O)",
    /if\s+not\s+DWF_DIAG\s+then\s+return\s+end/.test(wtraceBody) &&
    wtraceBody.indexOf("DWF_DIAG") < wtraceBody.indexOf("printerr"));
  check("the DUMP-JOB dump_jobs_of_type call is gated behind DWF_DIAG",
    /if\s+DWF_DIAG\s+then[\s\S]{0,80}dump_jobs_of_type/.test(lua));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
