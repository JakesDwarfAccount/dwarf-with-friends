// build_place_invariant_test.mjs -- OFFLINE source contract for crash-focused build placement
// instrumentation and cage mutation guards. No DF, DLL, server, or filesystem writes.
//   node tools/harness/build_place_invariant_test.mjs   (exit 0 PASS / 1 FAIL)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const lua = readFileSync(join(root, "dwf.lua"), "utf8");
const bridge = readFileSync(join(root, "src", "lua_bridge.cpp"), "utf8");
const cages = readFileSync(join(root, "src", "building_zone.cpp"), "utf8");

let failed = 0, passed = 0;
const check = (name, ok) => {
  if (ok) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
};

function validate(luaText, bridgeText, cageText) {
  const requiredLua = [
    "function building_invariant_snapshot(bld)",
    '"worldLinked"', '"centerOccupancy"', '"listLinked"', '"holderId"',
    '"filterCount"', '"attachedItemCount"', '"containedItems"', '"cage"',
    '"filters"', '"itemFlags"', '"refs"', '"assignedUnitIds"', '"assignedItemIds"',
    "building_invariant_snapshot_by_id",
    "pcall(building_invariant_snapshot, b)",
  ];
  const requiredBridge = [
    "invariant-audit token=", "audit_json", "call_lua(\"place_building\"",
  ];
  const requiredCage = [
    "validate_built_cage_backing_item", "df::item_cagest", "building_item_role_type::PERM",
    "in_building", "BUILDING_HOLDER", "CAGE-AUDIT phase=", 'kind != "unit" && kind != "item"',
  ];
  return requiredLua.every(s => luaText.includes(s)) &&
    requiredBridge.every(s => bridgeText.includes(s)) &&
    requiredCage.every(s => cageText.includes(s));
}

console.log("# build placement invariant audit contract");
check("placement snapshot and synchronized C++ audit are present", validate(lua, bridge, cages));
check("Lua returns five values including the audit", /return #blds,[^\n]+ids, '\['/.test(lua));
check("C++ requests five Lua results", /selected_item_id\), 5,/.test(bridge)); // arg list grew at B114 (item chooser); the 5-result contract is the pin
check("cage mutation logs both before and after states",
  cages.includes('cage_mutation_audit(cage, "before"') &&
  cages.includes('cage_mutation_audit(cage, "after"'));

console.log("\n# TEST-THE-TEST (seeded omissions must fail validation)");
check("missing reciprocal holder guard is detected",
  !validate(lua, bridge, cages.replaceAll("BUILDING_HOLDER", "REMOVED_HOLDER")));
check("missing placement job linkage field is detected",
  !validate(lua.replaceAll('"listLinked"', '"removedLinked"'), bridge, cages));
check("missing synchronized audit sink is detected",
  !validate(lua, bridge.replaceAll("invariant-audit token=", "removed-audit="), cages));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
