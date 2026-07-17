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
// SPDX-License-Identifier: AGPL-3.0-only
//
// Slice-5 (buildings/workshops/zones) repair coverage for the tavern LocationDetails sheet
// (oracle LEVER-LINK-2), the fail-silent action-error surfacing, and the host-assisted rename
// fallback. Pure-markup assertions, offline -- no live host.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const panelPath = join(root, "web", "js", "dwf-location-panel.js");
const panelSrc = readFileSync(panelPath, "utf8");
const cpp = readFileSync(join(root, "src", "building_zone.cpp"), "utf8");

globalThis.DWFUI = require(join(root, "web", "js", "dwf-ui-components.js"));
const M = require(panelPath);
let passed = 0, failed = 0;
function check(name, ok, extra) {
  console.log(`  ${ok ? "ok" : "FAIL"} - ${name}${ok || extra === undefined ? "" : "  <<< " + extra}`);
  ok ? passed++ : failed++;
}
function checkSeededBad(name, ok) {
  // ok===true here means the intentionally-wrong shape was DETECTED (good).
  console.log(`  ${ok ? "ok" : "FAIL"} - (seeded-bad) ${name}`);
  ok ? passed++ : failed++;
}
function inOrder(haystack, needles) {
  let at = -1;
  for (const needle of needles) {
    at = haystack.indexOf(needle, at + 1);
    if (at < 0) return false;
  }
  return true;
}

// A tavern whose native block serves the real instrument counters (tavern default desired = 5),
// with two rooms (one rented). Chests/dance/goblets have no honest wire, so they stay unavailable.
const tavern = {
  id: 4, kind: "tavern", label: "Inn/Tavern", name: "The Golden Mug",
  occupancy: { inside: 0, citizens: 0, residents: 0, visitors: 0, others: 0, inhabitants: 0, names: [] },
  zones: [{ id: 90, name: "Great Hall", type: "MeetingHall" }],
  occupations: [
    { id: 12, typeKey: "TAVERN_KEEPER", label: "Tavern Keeper", unitId: 55, holder: "Urist McKeeper", assigned: true, verified: true },
    { id: -1, typeKey: "PERFORMER", label: "Performer", unitId: -1, holder: "", assigned: false, verified: true },
  ],
  rooms: { canWrite: false, rooms: [
    { id: 1, label: "the eastern room", rented: true, renter: "Ast the Bard", owed: 40 },
    { id: 2, label: "the western room", rented: false, renter: "", owed: 0 },
  ] },
  positions: [], candidates: [],
  native: {
    accessMode: "visitors", guards: { locationAccess: true, locationInstruments: true },
    countInstruments: 0, desiredInstruments: 5, danceFloorKnown: false, chestsVerified: false,
  },
};

console.log("TEST: tavern LocationDetails mechanics (LEVER-LINK-2)");
const html = M.locationPanelMarkup({ data: tavern });

check("the tavern grows a mechanics cluster (was temple-only before)", /loc-tavern-mechanics/.test(html));
check("served instrument counters render read-only in DF's `0 (5)` shape",
  /Stored Instruments \(Desired\): 0 \(5\)/.test(html));
check("the tavern does NOT get an editable instrument stepper (its write is temple-only server-side)",
  !/data-loc-instruments=/.test(html) && !/data-loc-instrument-enter=/.test(html));
check("chests / dance floor / goblets stay explicitly unavailable, never a fabricated 0",
  /Chests in common area: unavailable/.test(html) &&
  /Dance floor in common area: unavailable/.test(html) &&
  /Goblets \(Desired\): unavailable/.test(html) &&
  !/Chests in common area: 0|Dance floor in common area: \d|Goblets \(Desired\): 0/.test(html));
check("mechanics row order matches the native capture (chests, goblets, instruments, dance)",
  inOrder(html, ["Chests in common area", "Goblets (Desired)", "Stored Instruments (Desired)", "Dance floor in common area"]));
check("mechanics sit after access and before the census-depth Occupants section",
  inOrder(html, ["loc-access", "loc-tavern-mechanics", "Occupants"]));
check("native inline rented-rooms total is honored: 1 rented of 2", /Rented rooms \(Total\): 1 \(2\)/.test(html));
check("the tavern keeps its occupation depth (Tavern Keeper holder + Performer assign)",
  /Urist McKeeper/.test(html) && /data-loc-assign="PERFORMER"/.test(html));
// Proof the read-only choice is load-bearing: a temple with the SAME guard flags DOES get the
// editable stepper, so the tavern's absence of it is a deliberate branch, not a missing feature.
checkSeededBad("the editable instrument stepper is temple-gated (a tavern that showed it would be a bug)",
  /data-loc-instruments=/.test(M.locationPanelMarkup({ data: { ...tavern, kind: "temple" } })) &&
  !/data-loc-instruments=/.test(html));

console.log("TEST: tavern with NO native block degrades honestly");
const noNative = M.locationPanelMarkup({ data: {
  id: 4, kind: "tavern", occupancy: { inside: 0 }, occupations: [], rooms: null, positions: [], candidates: [] } });
check("absent instrument counters render unavailable, not a manufactured count",
  /Stored Instruments \(Desired\): unavailable/.test(noNative) &&
  !/Stored Instruments \(Desired\): 0/.test(noNative));

console.log("TEST: non-tavern kinds get no tavern mechanics cluster (no native evidence for one)");
for (const kind of ["library", "guildhall"]) {
  const h = M.locationPanelMarkup({ data: { id: 5, kind, occupancy: { inside: 0 }, occupations: [], rooms: null, positions: [], candidates: [] } });
  check(`${kind} renders no tavern-mechanics block`, !/loc-tavern-mechanics/.test(h));
}

console.log("TEST: fail-silent write errors are now surfaced (release-blocker class)");
const withErr = M.locationPanelMarkup({ data: tavern, error: "that location kind does not offer this occupation" });
check("a failed location action renders a visible alert instead of vanishing",
  /loc-action-error/.test(withErr) && /that location kind does not offer this occupation/.test(withErr));
check("the alert uses the DWFUI danger status token + an assertive live region",
  /dwfui-status danger/.test(withErr) && /aria-live="assertive"/.test(withErr));
check("no error line renders on a clean panel", !/loc-action-error/.test(html));
check("both write paths clear the stale error before retrying",
  /_locState\.error = null;[\s\S]*location-action/.test(panelSrc) &&
  /_locState\.error = null;[\s\S]*location-native-action/.test(panelSrc));

console.log("TEST: host-assisted rename fallback (no /location-rename route exists)");
check("the native rename quill affordance renders, fail-closed (disabled), where native puts it",
  /loc-rename/.test(html) && /role: "quill"/.test(panelSrc) && /disabled: true/.test(panelSrc));
check("no /location-rename fetch is invented on the client (the affordance is fail-closed, not wired)",
  !/fetch\([^)]*location-rename/.test(panelSrc) && !/_locPost\([^)]*location-rename/.test(panelSrc));
check("the tooltip points the player at the Steam host (host-assisted, not a dead control)",
  /the host can rename it in the Steam client/.test(panelSrc));

console.log("TEST: no hand-rolled controls introduced (DWFUI policy)");
check("the location module still emits zero raw <button> in source", !/<button/.test(panelSrc));

console.log("TEST: server truth backing the read-only tavern instruments decision");
check("C++ confirms the desired-instruments write is temple-only",
  /instrument storage is only available for temples/.test(cpp));

// ---- zone panel: extend/repaint refusal surface (shell handoff) --------------------------------
// The /zone-repaint route EXISTS in this build (building_zone.cpp) and returns explicit refusal
// text ("repaint cannot erase an entire zone", ...). The placement caller (dwf-controls-placement.js
// repaintZoneDrag) dropped that text on !r.ok and reopened the panel unchanged -- a fail-silent gap.
// We own the panel: zonePanelMarkup/openZonePanel now accept options.status so the caller can thread
// the refusal here. This asserts the SINK renders; the one-line source change is a handoff to s7.
console.log("TEST: zone panel can surface an extend/repaint refusal (fail-silent fix, panel-side sink)");
const zoneCpp = cpp;  // same building_zone.cpp
check("the /zone-repaint route exists in this tree (discovery 'no route' finding is stale)",
  /server\.(Get|Post)\("\/zone-repaint"/.test(zoneCpp) && /zone-repaint refused: repaint cannot erase an entire zone/.test(zoneCpp));

globalThis.escapeHtml = value => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.window = globalThis;
globalThis.document = { readyState: "loading", querySelectorAll: () => [], getElementById: () => null, addEventListener: () => {} };
globalThis.addEventListener = () => {};
globalThis.unitImagesEnabled = false;
const zoneClientPath = join(root, "web", "js", "dwf-building-zone-stockpile-panels.js");
const zoneClientSrc = readFileSync(zoneClientPath, "utf8");
const zoneClient = require(zoneClientPath);
const zoneInfo = { id: 5, name: "Activity Zone #3", type: "Pen", active: true, isPen: true,
  assignedUnits: 0, canLocation: true, location: { id: -1 }, owner: {} };

const noStatus = zoneClient.zonePanelMarkup(zoneInfo, {});
check("an ordinary zone open shows no action-status line", !/zone-action-status/.test(noStatus));

const refused = zoneClient.zonePanelMarkup(zoneInfo, {
  status: { text: "repaint cannot erase an entire zone; use remove instead", isError: true } });
check("a threaded refusal renders as a visible DWFUI danger alert on the panel",
  /zone-action-status/.test(refused) && /dwfui-status danger/.test(refused) &&
  /repaint cannot erase an entire zone/.test(refused) && /aria-live="assertive"/.test(refused));
check("the refusal does not resurrect a native-absent 'N assigned' bld-status row",
  !/bld-status/.test(refused));
check("openZonePanel accepts the status opts so a caller can feed the sink",
  /async function openZonePanel\(id, opts\)/.test(zoneClientSrc) && /status: o\.status \|\| null/.test(zoneClientSrc));

console.log(`\nS5 location/tavern + zone-repaint sink: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
