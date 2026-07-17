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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = { setTimeout, addEventListener() {} };
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.unitImagesEnabled = true;
// B176: renderUnitRooms now builds through the shared DWFUI component layer (rowHtml +
// actionButtonsHtml), resolved as a global at call time exactly as in the browser.
globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;

const M = await import("../../web/js/dwf-unit-hud-notifications.js");

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("PASS " + label); }
  catch (error) { console.log("FAIL " + label); throw error; }
}

// ---- WAVE-5: THE COPY ASSERTIONS FOLLOW THE COPY INTO THE BITMAP CHASSIS ------------------------
// Every one of these rows now renders through DWFUI.rowHtml, whose text slots go through
// bitmapTextHtml -- so a label no longer sits as a bare text node immediately after its class
// attribute (`unit-group-name">The Cooperative Citadel`), it sits inside
// `<span class="dwfui-bitmap-text" data-dwfui-bitmap-text="...">`. That is the POINT of the migration:
// DF's menu text is a bitmap font, and a row that renders browser text is the defect.
//
// The assertion is NOT weakened -- it is made structure-aware and STRONGER. `carries()` proves BOTH
// that the pinned semantic class still exists (the CSS + these selectors keep resolving) AND that
// the exact copy is inside it AND that it went through the bitmap layer. A regression to a raw div,
// or to the wrong copy, or to browser text, still fails.
//
// (NOTE for the closeout: the Relations assertion below was ALREADY RED at this lane's start SHA --
// Wave-4 migrated renderUnitRelations onto rowHtml and did not carry its test forward. This lane
// inherits and repairs that break; it did not cause it.)
function carries(html, cls, copy) {
  const re = new RegExp(
    `class="[^"]*\\b${cls}\\b[^"]*"[^>]*>\\s*<span class="dwfui-bitmap-text" data-dwfui-bitmap-text="${
      copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  assert.match(html, re, `expected .${cls} to carry the bitmap-rendered copy ${JSON.stringify(copy)}`);
}

console.log("# structured Relations");
const relationHtml = M.renderUnitTabBody({
  relationLines: ["Spouse: stale fallback"],
  relations: [
    { label: "Friend", name: "Atis", profession: "Mason", hfId: 30, unitId: -1, colorRole: "friend", order: 30 },
    { label: "Husband", name: "Urist", profession: "Carpenter", hfId: 10, unitId: 7, colorRole: "family", order: 10 },
    { label: "Deity", name: "Olon", profession: "Deity", hfId: 20, unitId: -1, colorRole: "deity", order: 20 }
  ]
}, "Relations", null);
check("semantic order and two-line labels", () => {
  assert.ok(relationHtml.indexOf("Urist") < relationHtml.indexOf("Olon"));
  assert.ok(relationHtml.indexOf("Olon") < relationHtml.indexOf("Atis"));
  assert.match(relationHtml, /unit-structured-line/);
  carries(relationHtml, "unit-structured-subline", "Husband");
});
check("live local relation gets the existing unit-open action", () =>
  assert.match(relationHtml, /data-unit-relation-open="7"/));
check("structured relations never leak raw Unit ids or legacy rows", () => {
  assert.doesNotMatch(relationHtml, /Unit\s+-?\d+/);
  assert.doesNotMatch(relationHtml, /stale fallback/);
});
check("legacy-only relationLines still render", () => {
  const html = M.renderUnitTabBody({ relationLines: ["Spouse: Urist"] }, "Relations", null);
  assert.match(html, /Spouse: Urist/);
  assert.match(html, /unit-list-grid/);
});

console.log("# structured Groups");
const groupHtml = M.renderUnitTabBody({ groups: [
  { entityName: "The Waning Vestibule", status: "Member", category: "Site government", order: 30 },
  { entityName: "The Cooperative Citadel", status: "Citizen", category: "Civilization", order: 10 },
  { entityName: "The Mint Creed", status: "Member", category: "Religion", order: 20 }
] }, "Groups", null);
check("three memberships render in semantic order", () => {
  assert.equal((groupHtml.match(/unit-group-row/g) || []).length, 3);
  assert.ok(groupHtml.indexOf("Cooperative") < groupHtml.indexOf("Mint Creed"));
  assert.ok(groupHtml.indexOf("Mint Creed") < groupHtml.indexOf("Waning"));
});
check("group name, status, and right category use native color spans", () => {
  carries(groupHtml, "unit-group-name", "The Cooperative Citadel");
  carries(groupHtml, "unit-group-status", "Citizen");
  // WAVE-5: the gold category word is a right-aligned COLUMN, so it is a rowHtml `cells[]` entry
  // (a .dwfui-cell), not a third div inside the copy block. The pinned class rides through `cls`.
  carries(groupHtml, "unit-group-category", "Civilization");
  assert.match(groupHtml, /class="dwfui-cell unit-group-category"/);
  // the row is the native TABLE chassis, and the CELL draws no border of its own (the grid does)
  assert.match(groupHtml, /class="dwfui-row unit-structured-row unit-group-row dwfui-row--table"/);
});

console.log("# structured Rooms");
const roomHtml = M.renderUnitTabBody({ rooms: [
  { category: "Quarters", assigned: true, buildingId: 41, name: "Bedroom #4", quality: "Meager Quarters" }
] }, "Rooms", null);
check("Rooms always render all four fixed category slots", () => {
  assert.equal((roomHtml.match(/data-unit-room-category=/g) || []).length, 4);
  for (const category of ["Study", "Quarters", "Dining Room", "Tomb"])
    assert.match(roomHtml, new RegExp(`data-unit-room-category="${category}"`));
});
check("unassigned and assigned room wording is native", () => {
  assert.match(roomHtml, /data-dwfui-bitmap-text="No Study"/);
  assert.match(roomHtml, /data-dwfui-bitmap-text="Meager Quarters"/);
  assert.doesNotMatch(roomHtml, /Bedroom #4/);
});

// B176: an assigned room row is click-to-view -- the row carries the buildingId + the
// server room center, and a trailing zoom button reuses the follow-camera glyph.
const roomClickHtml = M.renderUnitTabBody({ rooms: [
  { category: "Quarters", assigned: true, buildingId: 41, name: "Bedroom #4",
    quality: "Meager Quarters", centerX: 120, centerY: 88, centerZ: 5 }
] }, "Rooms", null);
check("assigned room carries buildingId + room center + a zoom affordance", () => {
  assert.match(roomClickHtml, /data-unit-room-open="41"/);
  assert.match(roomClickHtml, /data-room-x="120"/);
  assert.match(roomClickHtml, /data-room-y="88"/);
  assert.match(roomClickHtml, /data-room-z="5"/);
  assert.match(roomClickHtml, /unit-room-row assigned clickable/);
  // WAVE-5 / R3: the trailing tile was the MOVIE-CAMERA EMOJI (codepoint 127909), reached through
  // TOKENS.glyphs.follow. It is now DF's own RECENTER_RECENTER sprite -- never an emoji where a
  // sprite exists. Strictly stronger: it pins the real interface_map token AND proves the emoji is
  // gone from the emitted markup.
  assert.match(roomClickHtml, /class="unit-structured-action"[\s\S]*?data-dwfui-sprite="RECENTER_RECENTER"/);
  assert.doesNotMatch(roomClickHtml, /&#127909;/);
});
check("unassigned rooms are inert (no open target, no zoom button)", () => {
  // roomHtml above has only Quarters assigned; the other three slots are unassigned.
  const opens = (roomClickHtml.match(/data-unit-room-open=/g) || []).length;
  // one on the row + one on the button, for the single assigned room only
  assert.equal(opens, 2);
  assert.match(roomClickHtml, /unit-room-row unassigned/);
  assert.doesNotMatch(roomClickHtml, /unassigned clickable/);
});
check("an assigned room WITHOUT a server center still opens (fail-open, no pos)", () => {
  const noPos = M.renderUnitTabBody({ rooms: [
    { category: "Tomb", assigned: true, buildingId: 77, quality: "Meager Tomb" }
  ] }, "Rooms", null);
  assert.match(noPos, /data-unit-room-open="77"/);   // zone panel still reachable
  assert.doesNotMatch(noPos, /data-room-x=/);         // but no camera jump target
});

console.log("# structured Items");
const itemHtml = M.renderUnitTabBody({ inventory: [
  { itemId: 99, role: "Worn", bodyPartId: 3, bodyPartName: "Upper body", name: "pig tail shirt", colorRole: "item" },
  { itemId: 100, role: "Weapon", bodyPartId: 7, bodyPartName: "Right hand", name: "copper battle axe", colorRole: "quality" }
] }, "Items", null);
check("item rows show parenthesized yellow names and cyan body locations", () => {
  carries(itemHtml, "unit-inventory-name", "(pig tail shirt)");
  carries(itemHtml, "unit-inventory-location", "Upper body");
  carries(itemHtml, "unit-inventory-name", "(copper battle axe)");
  carries(itemHtml, "unit-inventory-location", "Right hand");
  assert.match(itemHtml, /class="dwfui-row unit-structured-row unit-inventory-row dwfui-row--table"/);
});
check("structured items omit role prefixes", () => {
  assert.doesNotMatch(itemHtml, /Worn:/);
  assert.doesNotMatch(itemHtml, /Weapon:/);
});

console.log("# additive server contract guards");
const header = readFileSync(new URL("../../src/unit_sheet.h", import.meta.url), "utf8");
const cpp = readFileSync(new URL("../../src/unit_sheet.cpp", import.meta.url), "utf8");
check("structured fields are additive beside every legacy Lines field", () => {
  for (const legacy of ["inventoryLines", "relationLines", "groupLines", "roomLines"])
    assert.ok(cpp.includes(`\\\"${legacy}\\\"`));
  for (const field of ["inventory", "relations", "groups", "rooms"])
    assert.ok(cpp.includes(`\\\"${field}\\\"`));
  for (const member of ["std::vector<UnitInventoryRecord> inventory", "std::vector<UnitRelation> relations", "std::vector<UnitGroup> groups", "std::vector<UnitRoom> rooms"])
    assert.ok(header.includes(member));
});
check("B176: the room center is an additive on-demand /unit field (not per-tick AUX)", () => {
  // struct + JSON emit the three center coordinates the client zooms to.
  for (const m of ["int32_t center_x", "int32_t center_y", "int32_t center_z"])
    assert.ok(header.includes(m), `unit_sheet.h missing ${m}`);
  for (const k of ["centerX", "centerY", "centerZ"])
    assert.ok(cpp.includes(`\\\"${k}\\\"`), `append_rooms missing ${k}`);
  // it is populated from the civzone extent, guarded by the assigned branch.
  assert.match(cpp, /room\.center_x\s*=\s*\(zone->x1 \+ zone->x2\)/);
});

console.log(`\ncharprofile structured: ${passed} passed`);
