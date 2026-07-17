// Regression gate for the 2026-07-12 zone-repaint crash.
// Repaint must preserve the existing civzone object/id. Native DF keeps owner, location,
// assignment, and squad links to that object; replacement + deconstruction can strand pointers.

import assert from "node:assert/strict";
import fs from "node:fs";

const zone = fs.readFileSync(new URL("../../src/building_zone.cpp", import.meta.url), "utf8");
// B212: /zone-repaint lives in register_building_zone_routes (building_zone.cpp) now.
const http = fs.readFileSync(new URL("../../src/building_zone.cpp", import.meta.url), "utf8");

const applyStart = zone.indexOf("bool apply_zone_repaint_in_place_on_core_thread");
assert.ok(applyStart >= 0, "in-place zone repaint implementation exists");
// Bound the slice at the next top-level definition (the route registrar), not a namespace-end
// sentinel: hygiene merges shifted code after the repaint fn, and an unmatched sentinel silently
// extended the slice over the zone-remove handler (which legitimately deconstructs).
const applyEnd = zone.indexOf("\nvoid register_building_zone_routes", applyStart);
assert.ok(applyEnd > applyStart, "repaint fn is followed by the route registrar (slice bound)");
const applyBody = zone.slice(applyStart, applyEnd);

assert.match(applyBody, /df::building::find\(id\)/,
  "repaint mutates the requested existing zone");
assert.doesNotMatch(applyBody, /Buildings::deconstruct|create_zone|new_id|old_id/,
  "repaint never replaces or destroys a civzone");
assert.match(applyBody, /std::nothrow/,
  "allocation failure is a harmless error, not an exception through the game");
assert.match(applyBody, /kMaxZoneRepaintTiles/,
  "untrusted browser geometry has a hard allocation bound");
assert.match(applyBody, /Maps::isValidTilePos/,
  "repaint refuses coordinates outside the loaded map");
assert.match(applyBody, /repaint would erase the entire zone/,
  "full erase is refused instead of becoming an implicit deletion");
assert.match(applyBody, /plan\.extents\[i\][\s\S]*building_extents_type::None/,
  "apply preserves zero-valued holes from the exact planned bitmap");
assert.doesNotMatch(applyBody, /fill_n\([^\n]*building_extents_type::Stockpile/,
  "apply cannot flatten an arbitrary zone into a solid rectangle");
assert.match(applyBody, /Buildings::notifyCivzoneModified\(zone\)/,
  "repaint rebuilds furniture/building relationships against the changed civzone footprint");

const planStart = zone.indexOf("bool build_zone_repaint_plan");
const planBody = zone.slice(planStart, zone.indexOf("} // namespace", planStart));
assert.match(planBody, /present = old_present \|\| selected/,
  "add changes tile membership, including holes inside an unchanged bounding box");
assert.match(planBody, /present = old_present && !selected/,
  "erase can clear any selected tile, including an interior hole");
assert.doesNotMatch(planBody, /only supported at a zone edge|full row\/column trim/,
  "interior and corner erase are not artificially rejected");
assert.match(planBody, /unknown repaint mode/,
  "unrecognized modes are rejected instead of falling through to erase");
assert.match(zone, /repaint bitmap size does not match[\s\S]*repaint bitmap contains an invalid tile value/,
  "malformed extent bitmaps are rejected before mutation");

const routeStart = http.indexOf("auto zone_repaint_handler");
const routeBody = http.slice(routeStart, http.indexOf("server.Post(\"/zone-repaint\"", routeStart));
assert.match(routeBody, /apply_zone_repaint_in_place_on_core_thread\(id, plan/,
  "HTTP route uses the stable-id mutation path");
assert.doesNotMatch(routeBody, /create_zone_at_world_rect_via_lua|finish_zone_repaint|zone_action_on_core_thread/,
  "HTTP repaint cannot create, migrate, or delete zones");
assert.match(routeBody, /res\.status = 409/,
  "unsupported full erase returns a controlled conflict response");

console.log("zone repaint safety: PASS (stable id, arbitrary extents, relation refresh, no implicit delete)");
