// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// b52_b53_designation_pipeline_test.mjs -- offline pipeline cells for the B52/B53 fixes.
// Verifies the browser button/tool mapping through POST /designate, the server's construction
// designation mapping, and the right-docked squad-panel geometry. No Dwarf Fortress or browser.
//
// Run: node tools/harness/b52_b53_designation_pipeline_test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const client = readFileSync(join(root, "web/js/dwf-controls-placement.js"), "utf8");
const css = readFileSync(join(root, "web/css/dwf.css"), "utf8");
const placement = readFileSync(join(root, "src/placement.cpp"), "utf8");
// B212: /designate lives in register_placement_routes (src/placement.cpp) now.
const http = readFileSync(join(root, "src/placement.cpp"), "utf8");

let failed = 0;
function check(name, condition) {
  if (condition) console.log("  ok - " + name);
  else { failed++; console.log("  FAIL - " + name); }
}
function checkGuard(name, condition) {
  check("(test-the-test) " + name, condition);
}
function section(name) { console.log("\n# " + name); }
function between(text, start, end) {
  const a = text.indexOf(start);
  const b = a < 0 ? -1 : text.indexOf(end, a + start.length);
  return a < 0 ? "" : text.slice(a, b < 0 ? text.length : b);
}

section("B52 squad panel geometry");
const squadsRule = between(css, "#clientPanel.squads-sidebar {", "}");
check("squad panel is widened to 300px at desktop widths", /width:\s*300px;/.test(squadsRule));
check("squad panel stays docked to the right edge", /right:\s*0;/.test(squadsRule) && /left:\s*auto;/.test(squadsRule));
check("squad panel begins below the 232px right chrome and ends above the toolbar", /top:\s*236px;/.test(squadsRule) && /bottom:\s*52px;/.test(squadsRule));
const seededNarrowRule = squadsRule.replace(/width:\s*300px;/, "width: 208px;");
checkGuard("B52 width assertion rejects the old 208px sidebar", !/width:\s*300px;/.test(seededNarrowRule));

section("B53 button -> params -> route -> designation mapping");
const toolMap = between(client, "function backendToolFor(tool)", "  // WD-8.5:");
const removeMapping = toolMap.match(/remove:\s*"([^"]+)"/);
check("remove button remains in the dig tool family", /new Set\(\[[^\]]*"remove"/.test(client));
check("remove button maps to the remove-stairs/ramps action, not erase -- sent as the LEGACY spelling so it works against an older DLL too (a client that sends an action the server does not know silently does NOTHING)", !!removeMapping && (removeMapping[1] === "remove-construction" || removeMapping[1] === "remove-stairs-ramps"));
check("designation requests append the selected backend tool and dig parameters", /tool=\$\{encodeURIComponent\(currentTool\)\}.*\+ digOptsQuery\(\)/s.test(client));
check("POST /designate is registered and forwards query tool into DesignationRequest", /server\.Post\("\/designate", designate_handler\)/.test(http) && /desig\.tool\s*=\s*req\.has_param\("tool"\)/.test(http));

const kindMap = between(placement, "bool kind_from_tool", "bool is_visible_natural_stone");
const removeApply = between(placement, "} else if (req.kind == DesignationKind::RemoveStairsRamps)", "} else if (req.kind == DesignationKind::Clear)");
const removalGuard = between(placement, "bool can_remove_stairs_ramps", "// BUGFIX (cursor/selection misalignment");
check("server route maps canonical action (and legacy alias) to RemoveStairsRamps", /tool == "remove-stairs-ramps"/.test(kindMap) && /tool == "remove-construction"/.test(kindMap) && /DesignationKind::RemoveStairsRamps/.test(kindMap));
check("removal accepts visible constructions and natural ramps", /des\.bits\.hidden/.test(removalGuard) && /tiletype_material::CONSTRUCTION/.test(removalGuard) && /tiletype_shape::RAMP/.test(removalGuard));
check("constructed wall/ramp removal sets dig designation Default", /des\.bits\.dig = df::tile_dig_designation::Default;/.test(removeApply));
check("construction removal does not repurpose marker or auto occupancy bits", !/occupancyAt|dig_marked|dig_auto/.test(removeApply));
check("erase also recognizes queued RemoveConstruction jobs", /case df::job_type::RemoveConstruction:/.test(between(placement, "bool is_designation_job", "bool dig_from_tool")));

const seededBadMap = toolMap.replace(/remove:\s*"remove-construction"/, "remove:\"clear\"");
checkGuard("B53 client mapping assertion rejects the previous remove->clear bug", /remove:\s*"clear"/.test(seededBadMap) && !/remove:\s*"remove-construction"/.test(seededBadMap));
const seededBadApply = removeApply.replace(/des\.bits\.dig = df::tile_dig_designation::Default;/, "des.bits.dig = df::tile_dig_designation::No;");
checkGuard("B53 designation assertion rejects clearing instead of scheduling removal", !/des\.bits\.dig = df::tile_dig_designation::Default;/.test(seededBadApply));

if (failed) {
  console.error("\nFAIL " + failed + " B52/B53 pipeline cell(s)");
  process.exit(1);
}
console.log("\nPASS B52/B53 squad geometry and construction-removal pipeline cells");
