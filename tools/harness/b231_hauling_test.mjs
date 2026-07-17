// b231_hauling_test.mjs -- B231 acceptance (hauling depth: per-stop desired items, departure
// conditions, guide paths, and THE VEHICLE WRITE BUG).
//
// src/hauling.cpp was a TEST BLIND SPOT (tools/harness/TEST-MAP.md lists it under "files with no
// test"). That is exactly how the bug below shipped and survived a week of green gates.
//
// WHAT THIS PINS, AND WHY EACH IS A REAL BUG CLASS:
//
//  1. THE VEHICLE WRITE SET (src/hauling.cpp). df::hauling_route.vehicle_ids is declared
//        <stl-vector type-name='int32_t' name="vehicle_ids" ref-target='vehicle'/>
//     (df.hauling.xml:57) -- it holds df::vehicle IDs. The shipped code pushed the *ITEM* id, never
//     grew the PARALLEL vector `vehicle_stops`, and never set `vehicle.route_id`. Three silent
//     failures: DF binsearches the wrong id space; two lockstep vectors desync (the one
//     unacceptable outcome for a write path); and nothing hauls, because both DF and DFHack key
//     "this cart is on a route" off vehicle.route_id (Items::isRouteVehicle, library/modules/
//     Items.cpp:2044; autolabor/labormanager.cpp:1394), which stayed -1 forever.
//     The corrected write set is DFHack's own, field-for-field from its canonical assigner
//     scripts/assign-minecarts.lua::assign_minecart_to_route():
//         WRITE:    vehicle_ids += vehicle->id ; vehicle_stops += 0 ; vehicle->route_id = route->id
//         RELEASE:  vehicle->route_id = -1  BEFORE dropping the binding (route teardown included)
//         REFUSE:   a route with no stops; a cart already bound to another route; a wheelbarrow
//     A route delete that does NOT release its carts leaves live df::vehicle records pointing at a
//     freed route id -- so `release_route_vehicles` in do_route_remove is asserted, not optional.
//
//  2. THE PARALLEL-INDEX FIXUP. route.vehicle_stops holds INDEXES into route.stops
//     (df.hauling.xml:58, refers-to '$$._global.stops[$]'). Erasing a stop shifts every later
//     index by one; the old do_stop_remove deleted the stop and left them stale.
//
//  3. WHAT WE REFUSE TO WRITE. stop_depart_condition.guide_path is annotated in df-structures
//     "initialized on first run, and saved" -- DF's pathfinder owns it. We serialize it read-only
//     and never author it. No oracle -> no guess. Asserted textually, like B230's refusals.
//
//  4. THE DEPART-CONDITION FLAGS. stop_leave_condition_flag.{at_most,desired} (df.hauling.xml:12)
//     were declared and NEVER touched -- which is why a departure condition did nothing useful:
//     without `desired` the load test ignores the stop's item filter, and without `at_most` there
//     is no way to say "leave once emptied".
//
//  5. THE SHARED SETTINGS EDITOR. df::hauling_stop.settings IS a df::stockpile_settings
//     (df.hauling.xml:42) -- the same struct a pile carries, which is why DFHack's stockpiles
//     plugin edits a route stop with its stockpile serializer (stockpiles.cpp:126). The client
//     editor is therefore SHARED, not duplicated: this pins that there is exactly one item filter
//     implementation and that it is target-addressed.
//
// Run: node tools/harness/b231_hauling_test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const CPP = read("src/hauling.cpp");
const LUA = read("dwf.lua");
const SHELL = read("web/js/dwf-control-shell.js");
const PLACE = read("web/js/dwf-controls-placement.js");
const SPPANEL = read("web/js/dwf-building-zone-stockpile-panels.js");

// ---------------------------------------------------------------------------------------------
// df-structures ground truth. Read from the live checkout when present; otherwise fall back to the
// values read from it on 2026-07-14 (recorded so the test still runs without the DFHack tree).
// ---------------------------------------------------------------------------------------------
const DFH = [process.env.DFHACK_SRC].filter(Boolean).find(p => fs.existsSync(path.join(p, "library/xml/df.hauling.xml")));
if (DFH) {
  const xml = fs.readFileSync(path.join(DFH, "library/xml/df.hauling.xml"), "utf8");

  check("df-structures: vehicle_ids is a vector of VEHICLE ids (not item ids)", () => {
    const m = xml.match(/<stl-vector[^>]*name="vehicle_ids"[^>]*\/>/);
    assert.ok(m, "vehicle_ids not found in df.hauling.xml");
    assert.match(m[0], /ref-target='vehicle'/,
      "vehicle_ids must be ref-target='vehicle' -- this is the whole basis of the B231 fix");
  });

  check("df-structures: vehicle_stops is the PARALLEL vector, indexing route.stops", () => {
    assert.match(xml, /name="vehicle_stops"[\s\S]{0,140}?refers-to='\$\$\._global\.stops\[\$\]'/,
      "vehicle_stops must refer to stops[] by INDEX");
  });

  check("df-structures: hauling_stop.settings is a stockpile_settings", () => {
    assert.match(xml, /<compound type-name='stockpile_settings' name='settings'/,
      "a stop's desired-items filter IS a stockpile filter -- the shared editor depends on it");
  });

  check("df-structures: stop_leave_condition_flag has at_most + desired", () => {
    assert.match(xml, /flag-bit name='at_most'/);
    assert.match(xml, /flag-bit name='desired'/);
  });

  check("df-structures: guide_path is DF-authored ('initialized on first run')", () => {
    assert.match(xml, /name='guide_path'[\s\S]{0,160}?initialized on first run/,
      "if this annotation ever changes, revisit the refusal below");
  });

  // The DFHack script we copied the write set from. If it changes, we want to know.
  const AM = path.join(DFH, "scripts/assign-minecarts.lua");
  if (fs.existsSync(AM)) {
    const am = fs.readFileSync(AM, "utf8");
    check("DFHack assign-minecarts.lua still writes the 3 fields we mirror", () => {
      assert.match(am, /route\.vehicle_ids:insert\('#',\s*minecart\.id\)/);
      assert.match(am, /route\.vehicle_stops:insert\('#',\s*0\)/);
      assert.match(am, /minecart\.route_id\s*=\s*route\.id/);
      assert.match(am, /vehicle\.route_id\s*=\s*-1/, "release path");
    });
  }
} else {
  console.log("  --  df-structures checkout absent; skipping the 5 ground-truth cells");
}

// ---------------------------------------------------------------------------------------------
// 1 + 2. The C++ write set, and the refusals.
// ---------------------------------------------------------------------------------------------
check("C++: vehicle assign writes the VEHICLE id, not the item id", () => {
  const fn = CPP.slice(CPP.indexOf("bool do_vehicle_assign"), CPP.indexOf("} // namespace", CPP.indexOf("bool do_vehicle_assign")));
  assert.ok(fn.length > 200, "do_vehicle_assign not found");
  assert.match(fn, /ids\.push_back\(vehicle->id\)/, "must push the df::vehicle id");
  assert.doesNotMatch(fn, /push_back\(item_id\)/,
    "REGRESSION: the item id is being written into vehicle_ids again (the original B231 bug)");
});

check("C++: vehicle assign grows the PARALLEL vehicle_stops in lockstep", () => {
  const fn = CPP.slice(CPP.indexOf("bool do_vehicle_assign"));
  assert.match(fn, /stops\.push_back\(0\)/, "cart starts at stop index 0, per assign-minecarts.lua");
  assert.match(fn, /stops\.erase\(stops\.begin\(\) \+ idx\)/, "release must erase the parallel entry");
});

check("C++: vehicle assign sets vehicle->route_id (nothing hauls without it)", () => {
  const fn = CPP.slice(CPP.indexOf("bool do_vehicle_assign"));
  assert.match(fn, /vehicle->route_id = route->id/);
  assert.match(fn, /vehicle->route_id = -1/, "release must clear it");
});

check("C++: assign REFUSES a stopless route, a taken cart, and a wheelbarrow", () => {
  const fn = CPP.slice(CPP.indexOf("bool do_vehicle_assign"));
  assert.match(fn, /route->stops\.empty\(\)/, "assign-minecarts.lua refuses this; so must we");
  assert.match(fn, /vehicle->route_id != -1 && vehicle->route_id != route->id/);
  assert.match(fn, /item_is_minecart\(item\)/);
  // The wheelbarrow must be rejected by the predicate itself, not merely by getVehicleID().
  const pred = CPP.slice(CPP.indexOf("bool item_is_minecart"), CPP.indexOf("df::vehicle* vehicle_for_item"));
  assert.match(pred, /tool_uses::TRACK_CART/);
  assert.doesNotMatch(pred, /HEAVY_OBJECT_HAULING/,
    "a wheelbarrow is stockpile equipment, has no df::vehicle, and can never ride a route");
});

check("C++: deleting a route RELEASES its carts before freeing it", () => {
  const fn = CPP.slice(CPP.indexOf("bool do_route_remove"), CPP.indexOf("int32_t do_stop_add"));
  assert.match(fn, /release_route_vehicles\(route\)/,
    "otherwise live df::vehicle records point at a freed route id");
  // and the helper must actually clear route_id, not just drop the ids
  const helper = CPP.slice(CPP.indexOf("void release_route_vehicles"), CPP.indexOf("// ---", CPP.indexOf("void release_route_vehicles")));
  assert.match(helper, /vehicle->route_id = -1/);
  assert.match(helper, /vehicle_ids\.clear\(\)/);
  assert.match(helper, /vehicle_stops\.clear\(\)/);
});

check("C++: removing a stop fixes up the vehicle_stops INDEXES", () => {
  const fn = CPP.slice(CPP.indexOf("bool do_stop_remove"), CPP.indexOf("bool do_stop_link"));
  assert.match(fn, /removed_index/);
  assert.match(fn, /idx > removed_index/, "later indexes shift down by one");
  assert.match(fn, /release_route_vehicles\(route\)/, "no stops left -> no cart can be bound");
});

check("C++: uses DFHack's item->getVehicleID() rather than poking item_toolst.vehicle_id", () => {
  assert.match(CPP, /item->getVehicleID\(\)/);
  assert.match(CPP, /df::vehicle::find\(vid\)/);
});

// ---------------------------------------------------------------------------------------------
// 3. What we REFUSE to write. (The B230 pattern: the fields we do NOT touch are load-bearing.)
// ---------------------------------------------------------------------------------------------
check("C++: guide_path is READ-ONLY -- serialized, never authored", () => {
  assert.match(CPP, /guidePath/, "must be serialized for the player to see");
  assert.match(CPP, /guide_path\.x\[p\]/, "read");
  // No assignment into guide_path anywhere: no push_back, no clear, no resize, no `= `.
  assert.doesNotMatch(CPP, /guide_path\.(x|y|z)\.(push_back|clear|resize|assign)/,
    "REGRESSION: something is now WRITING guide_path. DF's pathfinder owns it -- we have no oracle.");
  assert.doesNotMatch(CPP, /guide_path\s*=/,
    "REGRESSION: guide_path is being assigned.");
});

check("C++: no df::vehicle is ever allocated (DF creates them)", () => {
  assert.doesNotMatch(CPP, /allocate<df::vehicle>/,
    "we only ever BIND an existing free vehicle, exactly as assign-minecarts.lua does");
});

check("C++: load_percent is snapped to DF's 0/50/100 (df-structures: 'broken display' otherwise)", () => {
  assert.match(CPP, /load_percent <= 25 \? 0 : \(load_percent >= 75 \? 100 : 50\)/);
});

// --- TEST-THE-TEST -----------------------------------------------------------------------------
// A source-assertion suite is worthless if it passes against text that does not contain the thing.
// Prove the two most important cells are NOT vacuous by running them against mutated source: the
// bug-shaped source must FAIL them.
check("NON-VACUOUS: the vehicle-id cell fails against the ORIGINAL (buggy) source", () => {
  const buggy = CPP
    .replace(/ids\.push_back\(vehicle->id\)/, "v.push_back(item_id)")
    .replace(/stops\.push_back\(0\);/, "")
    .replace(/vehicle->route_id = route->id;/, "");
  let threw = false;
  try {
    const fn = buggy.slice(buggy.indexOf("bool do_vehicle_assign"));
    assert.match(fn, /ids\.push_back\(vehicle->id\)/);
    assert.match(fn, /stops\.push_back\(0\)/);
    assert.match(fn, /vehicle->route_id = route->id/);
  } catch (_) { threw = true; }
  assert.ok(threw, "the write-set assertions do not actually detect the original bug -- they are vacuous");
});

check("NON-VACUOUS: the guide_path refusal fails against a source that writes it", () => {
  const bogus = CPP + "\nvoid bogus() { cond->guide_path.x.push_back(1); }\n";
  let threw = false;
  try {
    assert.doesNotMatch(bogus, /guide_path\.(x|y|z)\.(push_back|clear|resize|assign)/);
  } catch (_) { threw = true; }
  assert.ok(threw, "the guide_path refusal is vacuous -- it would not catch a write");
});

// ---------------------------------------------------------------------------------------------
// 4. The depart-condition flags, end to end.
// ---------------------------------------------------------------------------------------------
check("C++: at_most + desired are written and serialized", () => {
  assert.match(CPP, /cond->flags\.bits\.at_most = at_most/);
  assert.match(CPP, /cond->flags\.bits\.desired = desired/);
  assert.match(CPP, /atMost/);
  assert.match(CPP, /\\"desired\\":/);
});

check("C++: /hauling-stop-conditions accepts atmost + desired", () => {
  assert.match(CPP, /query_int\(req, "atmost", at_most\)/);
  assert.match(CPP, /query_int\(req, "desired", desired\)/);
});

check("client: the depart-condition editor exists and posts both flags", () => {
  assert.match(PLACE, /hauling-stop-conditions\?/, "the endpoint shipped with NO caller before B231");
  assert.match(PLACE, /atmost: d\.atMost \? "1" : "0"/);
  assert.match(PLACE, /desired: d\.desired \? "1" : "0"/);
  assert.match(PLACE, /data-hauling-cond-add/);
  assert.match(PLACE, /data-hauling-cond-remove/);
});

// ---------------------------------------------------------------------------------------------
// 5. The shared settings editor: ONE item filter, two subjects.
// ---------------------------------------------------------------------------------------------
check("lua: the stop reuses the pile's editor primitives (no second item filter)", () => {
  assert.match(LUA, /function sp_toggle_item_on\(b, cat, group, idx, on\)/);
  assert.match(LUA, /function hauling_stop_toggle_item\(route_id, stop_id, cat, group, idx, on\)/);
  assert.match(LUA, /function hauling_stop_settings_snapshot\(route_id, stop_id\)/);
  // Both entry points must funnel into the SAME primitive.
  assert.match(LUA, /function stockpile_toggle_item\(id, cat, group, idx, on\)[\s\S]{0,160}?sp_toggle_item_on\(b, cat, group, idx, on\)/);
  assert.match(LUA, /function hauling_stop_toggle_item\([\s\S]{0,200}?sp_toggle_item_on\(stop, cat, group, idx, on\)/);
});

check("lua: the stop PRESET goes through DFHack's own route importer", () => {
  assert.match(LUA, /require\('plugins\.stockpiles'\)\.import_settings\(\s*\n?\s*lib, \{route_id = tonumber\(route_id\), stop_id = tonumber\(stop_id\), mode = mode\}\)/,
    "plugins/lua/stockpiles.lua:124 dispatches route_id -> stockpiles_route_import (native)");
});

check("client: the stockpile editor is TARGET-addressed, so a stop can drive it", () => {
  assert.match(SPPANEL, /let spEditTarget = null;/);
  assert.match(SPPANEL, /function speUrl\(action, extra\)/);
  assert.match(SPPANEL, /\/hauling-stop-" : "\/stockpile-"/);
  assert.match(SPPANEL, /window\.DFStockpileSettings\.openForHaulingStop = openSpEditorForHaulingStop/);
  // No hardcoded stockpile URL may survive inside the editor -- that is what made it single-subject.
  const editor = SPPANEL.slice(SPPANEL.indexOf("let spEditTarget"), SPPANEL.indexOf("// Derivation inputs for one category"));
  assert.doesNotMatch(editor, /fetch\(`\/stockpile-(items|settings-snapshot|toggle)/,
    "an editor URL is still hardcoded to /stockpile-* -- a hauling stop would silently edit a PILE");
});

check("client: the hauling panel opens the shared editor for a stop", () => {
  assert.match(PLACE, /DFStockpileSettings\.openForHaulingStop/);
  assert.match(PLACE, /data-hauling-desired-edit/);
});

// ---------------------------------------------------------------------------------------------
// The minecart picker: the raw item-id number box is GONE.
// ---------------------------------------------------------------------------------------------
check("client: the raw item-id <input type=number> is gone, replaced by a picker", () => {
  // NB: DWFUI dataset keys are camelCase in SOURCE (datasetAttrs kebabs them at paint time), so
  // the shell is asserted on the key and the controller on the rendered attribute selector.
  assert.doesNotMatch(SHELL, /haulingVehicleInput|data-hauling-vehicle-input/,
    "the player cannot discover a minecart's item id; a picker is the only usable surface");
  assert.doesNotMatch(PLACE, /data-hauling-vehicle-input/);
  assert.doesNotMatch(SHELL, /input class="fort-input" type="number"[^>]*hauling/,
    "the number box is gone for good");
  assert.match(SHELL, /function haulingVehiclesMarkup/);
  assert.match(SHELL, /haulingVehicleAdd:/);
  assert.match(SHELL, /haulingVehicleRemove:/, "a cart must be releasable, not just bindable");
  assert.match(PLACE, /data-hauling-vehicle-add/, "controller binds the picker");
  assert.match(PLACE, /data-hauling-vehicle-remove/);
  assert.match(PLACE, /\/hauling-vehicles\?/, "the free-cart pool");
  assert.match(CPP, /server\.Get\("\/hauling-vehicles"/);
});

check("C++: the free-cart pool is exactly DFHack's (vehicles with route_id == -1)", () => {
  const fn = CPP.slice(CPP.indexOf("std::string free_vehicles_json"));
  assert.match(fn, /vehicle->route_id != -1/, "get_free_vehicles() in assign-minecarts.lua");
  assert.match(fn, /world->vehicles\.active/);
});

// ---------------------------------------------------------------------------------------------
// DWFUI mandate: no hand-rolled markup in the new surface.
// ---------------------------------------------------------------------------------------------
check("DWFUI: the new hauling surface uses DWFUI primitives, not hand-rolled controls", () => {
  const start = SHELL.indexOf("const HAUL_GROUPS");
  const end = SHELL.indexOf("function haulingPanelMarkup");
  // Strip // comments: this file's own banner *describes* the `<input type=number>` it deleted,
  // and a code ban must be asserted against code, not prose.
  const region = SHELL.slice(start, end).split(/\r?\n/).filter(l => !l.trim().startsWith("//")).join("\n");
  assert.ok(region.length > 500, "B231 hauling markup region not found");
  assert.match(region, /root\.DWFUI\.segmentedHtml\(/, "mode/direction/load are segmented controls");
  assert.match(region, /root\.DWFUI\.checkHtml\(/, "at_most / desired are checkboxes");
  assert.match(region, /root\.DWFUI\.scrollHtml\(/, "scroll regions must be DWFUI scrollboxes");
  assert.doesNotMatch(region, /<input/, "no hand-rolled inputs (B231 removed the last one)");
  assert.doesNotMatch(region, /<select/, "no hand-rolled selects");
  // every interpolated label goes through esc()
  assert.match(region, /root\.DWFUI\.esc\(/);
});

// ---------------------------------------------------------------------------------------------
// Pure-function behaviour of the two new text builders (no DOM).
// ---------------------------------------------------------------------------------------------
// Same CJS load path ui_lab_test.mjs uses for the shared production builders (they export via
// module.exports under __DWF_STORY_MODE and take DWFUI off the global).
const shellApi = (() => {
  try {
    globalThis.escapeHtml = v => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    globalThis.DWFUI = require(path.join(ROOT, "web/js/dwf-ui-components.js"));
    globalThis.window = globalThis;
    globalThis.__DWF_STORY_MODE = true;
    globalThis.addEventListener = () => {};
    globalThis.document = { readyState: "loading", querySelectorAll: () => [], getElementById: () => null, addEventListener: () => {} };
    return require(path.join(ROOT, "web/js/dwf-control-shell.js"));
  } catch (e) {
    console.log(`  !!  control-shell load failed: ${e.message}`);
    return null;
  }
})();

if (shellApi && shellApi.haulingConditionText) {
  check("haulingConditionText speaks English, not df-structures", () => {
    const t = shellApi.haulingConditionText({ mode: "guide", direction: "north", loadPercent: 100, desired: true, atMost: false });
    assert.match(t, /Guide north when at least 100% the desired items/);
    const emptied = shellApi.haulingConditionText({ mode: "push", direction: "south", loadPercent: 0, atMost: true });
    assert.match(emptied, /at most 0% cargo/, "at_most is how 'leave once emptied' is expressed");
    const guided = shellApi.haulingConditionText({ mode: "ride", direction: "east", loadPercent: 50, guidePath: [1, 2, 3] });
    assert.match(guided, /guided path: 3 tiles/, "the DF-authored path is shown, never authored");
  });

  check("haulingDesiredSummary warns when a stop wants nothing", () => {
    assert.match(shellApi.haulingDesiredSummary({ desired: {} }), /Wants nothing yet/);
    assert.match(shellApi.haulingDesiredSummary({ desired: { stone: true, wood: true } }), /Wants: stone, wood/);
    assert.match(shellApi.haulingDesiredSummary({ desired: { bars_blocks: true } }), /bars\/blocks/);
  });

  check("a stopless route says so instead of offering a doomed picker", () => {
    const html = shellApi.haulingVehiclesMarkup({ id: 1, stops: [], vehicles: [] }, { freeVehicles: [{ itemId: 7, name: "minecart" }] });
    assert.match(html, /Add a stop before assigning a minecart/);
    assert.doesNotMatch(html, /data-hauling-vehicle-add/, "the server would 400 this; do not offer it");
  });
} else {
  console.log("  --  control-shell not importable in isolation; skipped the 3 pure-function cells");
}

console.log(`\nb231_hauling_test: ${passed} cells passed`);
