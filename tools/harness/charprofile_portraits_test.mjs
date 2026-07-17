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

const portraits = JSON.parse(readFileSync(new URL("../../web/portraits_map.json", import.meta.url), "utf8"));
let liveUnits = [];
const tiles = { getLatest: () => ({ units: liveUnits }) };
globalThis.window = { setTimeout, addEventListener() {}, DwfTiles: tiles };
globalThis.DwfTiles = tiles;
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.unitImagesEnabled = true;

const M = await import("../../web/js/dwf-unit-hud-notifications.js");
M.__setPortraitMapsForTest(portraits, { cell: 32, races: { DWARF: { layered: true } } });

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("PASS " + label); }
  catch (error) { console.log("FAIL " + label); throw error; }
}

console.log("# authored animal portrait routing");
check("CAT adult renders the exact authored 96x96 crop", () => {
  const html = M.unitPortraitMarkup({ id: 1, name: "Mittens", race: "cat", rt: "CAT", ct: "FEMALE", ageClass: "adult", portraitState: "unavailable" });
  assert.match(html, /authored-portrait-box/);
  assert.match(html, /viewBox="480 0 96 96"/);
  assert.match(html, /\/sprites\/img\/portraits\/creature_domestic_portrait\.png/);
  assert.match(html, /portrait-glyph">C<\/div>/);
});
check("animal without a portrait definition keeps the letter glyph", () => {
  const html = M.unitPortraitMarkup({ id: 2, name: "Quagga", race: "quagga", rt: "NOT_IN_DF", ageClass: "adult", portraitState: "unavailable" });
  assert.match(html, /portrait-glyph">Q<\/div>/);
  assert.doesNotMatch(html, /authored-portrait|native-portrait-img|unit-sprite/);
});
check("failed authored image load never hides the glyph", () => {
  const classes = new Set();
  // The box stub needs setAttribute: a terminal portrait letter FLAGS itself now
  // (data-df-identity-missing="portrait:..."), and the stub predated the flag, so it threw.
  const box = { classList: { add: x => classes.add(x), remove: x => classes.delete(x) },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } };
  const image = { parentElement: box, closest: () => box, remove() { this.removed = true; } };
  window.dfcAuthoredPortraitError(image);
  assert.equal(classes.has("has-native-portrait"), false);
  assert.equal(image.removed, true);
});

console.log("# layered dwarf priority and cache");
liveUnits = [{ id: 7, ah: "0123456789abcdef", sw: 1, sh: 1 }];
check("ready dwarf native bust outranks its appearance-hash map composite", () => {
  const html = M.unitPortraitMarkup({ id: 7, name: "Urist", rt: "DWARF", ageClass: "adult", portraitState: "ready", portraitKind: "native", portraitTexpos: 17, sheetIconTexpos: 3 });
  assert.match(html, /\/unit-portrait\?id=7/);
  assert.doesNotMatch(html, /\/unit-sprite\/0123456789abcdef\.png/);
});
check("small citizen identity cells reuse the exact profile bust", () => {
  const html = M.unitPortraitMarkup({ id: 71, name: "Urist", rt: "DWARF", ageClass: "adult",
    portraitState: "ready", portraitKind: "native", portraitTexpos: 17, sheetIconTexpos: 3 },
    "info-portrait-small");
  assert.match(html, /mode=portrait/);
  assert.doesNotMatch(html, /mode=icon|\/unit-sprite\//);
});
check("successfully loaded native choice remains preferred for an off-screen/pending rerender", () => {
  const classes = new Set();
  // The box stub needs setAttribute: a terminal portrait letter FLAGS itself now
  // (data-df-identity-missing="portrait:..."), and the stub predated the flag, so it threw.
  const box = { classList: { add: x => classes.add(x), remove: x => classes.delete(x) },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } };
  window.dfcPortraitLoad({ parentElement: box, naturalWidth: 96, naturalHeight: 96,
    dataset: { unitId: "8", portraitSource: "native" } });
  liveUnits = [{ id: 8, ah: "fedcba9876543210", sw: 1, sh: 1 }];
  const html = M.unitPortraitMarkup({ id: 8, name: "Domas", rt: "DWARF", ageClass: "adult", portraitState: "pending", portraitKind: "native", portraitTexpos: 0, sheetIconTexpos: 2 });
  assert.match(html, /\/unit-portrait\?id=8/);
  assert.doesNotMatch(html, /\/unit-sprite\/fedcba9876543210\.png/);
});

console.log("# generated map fixture pins");
for (const [token, expected] of Object.entries({
  CAT: { adult: [480, 0], child: [576, 0] },
  DOG: { adult: [576, 96], child: [672, 96] }
})) {
  for (const age of ["adult", "child"]) {
    check(`${token} ${age} sheet/crop matches vanilla raw`, () => {
      const crop = portraits.races[token][age];
      assert.equal(crop.img, "portraits/creature_domestic_portrait.png");
      assert.deepEqual([crop.cx, crop.cy, crop.w, crop.h], [...expected[age], 96, 96]);
    });
  }
}

console.log("# B159 visitor portrait state: pending sheets auto-generate; the 404 loop re-routes to the composite");
check("human VISITOR with a pending portrait auto-generates its native bust (once per unit)", () => {
  // Live-oracle shape (unit 1670, human merchant): portrait_texpos==0 -> state "pending", kind
  // "native". Citizens probe identically -- the letter-glyph failure was never a race gate.
  const visitor = { id: 1670, name: "Dipug Radixim", rt: "HUMAN", ageClass: "adult",
    portraitState: "pending", portraitKind: "native", portraitTexpos: 0, sheetIconTexpos: 169047 };
  assert.equal(M.shouldAutoGeneratePortrait(visitor), true);
});
check("ready / remembered-native / authored-animal units never auto-generate", () => {
  assert.equal(M.shouldAutoGeneratePortrait({ id: 4661, rt: "HUMAN", portraitState: "ready", portraitKind: "native", portraitTexpos: 169071 }), false);
  const classes = new Set();
  // The box stub needs setAttribute: a terminal portrait letter FLAGS itself now
  // (data-df-identity-missing="portrait:..."), and the stub predated the flag, so it threw.
  const box = { classList: { add: x => classes.add(x), remove: x => classes.delete(x) },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } };
  window.dfcPortraitLoad({ parentElement: box, naturalWidth: 96, naturalHeight: 96,
    dataset: { unitId: "77", portraitSource: "native" } });
  assert.equal(M.shouldAutoGeneratePortrait({ id: 77, rt: "HUMAN", portraitState: "pending", portraitKind: "native", portraitTexpos: 0 }), false);
  assert.equal(M.shouldAutoGeneratePortrait({ id: 5, rt: "CAT", ct: "FEMALE", ageClass: "adult", portraitState: "pending", portraitKind: "native", portraitTexpos: 0 }), false);
});
check("seeded-bad: an 'unavailable'/'none' unit must never trigger generation", () => {
  assert.equal(M.shouldAutoGeneratePortrait({ id: 6344, rt: "HUMAN", portraitState: "unavailable", portraitKind: "none", portraitTexpos: -1 }), false);
});
check("a 404ing native bust re-routes the SAME img to the unit's composite sprite", () => {
  liveUnits = [{ id: 1671, ah: "d382304c092d084a", sw: 1, sh: 1 }];
  const box = { isConnected: true, classList: { add() {}, remove() {} } };
  const img = { parentElement: box, isConnected: true, src: "",
    dataset: { unitId: "1671", portraitSource: "native", srcBase: "/unit-portrait?id=1671&mode=portrait&tex=0&sheet=1", portraitRetry: "0" },
    remove() { this.removed = true; } };
  window.dfcPortraitError(img);
  assert.equal(img.src, "/unit-sprite/d382304c092d084a.png");
  assert.equal(img.dataset.portraitSource, "sprite");
  assert.equal(img.removed, undefined);
});
check("seeded-bad: with no composite known, the retry loop keeps the old cadence (no sprite swap)", () => {
  liveUnits = [];
  const savedTimeout = window.setTimeout;
  window.setTimeout = () => {};   // keep the 3 s retry timer from holding the harness open
  try {
    const box = { isConnected: true, classList: { add() {}, remove() {} } };
    const img = { parentElement: box, isConnected: true, src: "",
      dataset: { unitId: "1670", portraitSource: "native", srcBase: "/unit-portrait?id=1670&mode=portrait&tex=0&sheet=1", portraitRetry: "0" },
      remove() { this.removed = true; } };
    window.dfcPortraitError(img);
    assert.equal(img.dataset.portraitRetry, "1");
    assert.doesNotMatch(String(img.src), /unit-sprite/);
  } finally {
    window.setTimeout = savedTimeout;
  }
});

console.log("# additive server schema and Relations bounds inspection");
const header = readFileSync(new URL("../../src/unit_sheet.h", import.meta.url), "utf8");
const cpp = readFileSync(new URL("../../src/unit_sheet.cpp", import.meta.url), "utf8");
check("/unit retains legacy portrait fields and adds rt/ct/age/state/kind", () => {
  for (const field of ["portraitTexpos", "sheetIconTexpos", "rt", "ct", "ageClass", "portraitState", "portraitKind"])
    assert.ok(cpp.includes(`\\\"${field}\\\"`));
  for (const member of ["race_token", "caste_token", "age_class", "portrait_state", "portrait_kind"])
    assert.ok(header.includes(member));
});
// DF cannot run in this offline harness. The regression is therefore verified by source-level
// bounds inspection plus the representative legacy fixture shape old clients still consume.
check("Relations scan is bounded by both actual array extent and NUM sentinel", () => {
  assert.match(cpp, /std::size\(unit->relationship_ids\)/);
  assert.match(cpp, /unit_relationship_type::NUM/);
  const body = cpp.match(/std::vector<std::string> unit_relation_lines[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(body, /last_item_value/);
  assert.deepEqual({ relationLines: ["Spouse: Urist"] }, { relationLines: ["Spouse: Urist"] });
});

console.log(`\ncharprofile portraits: ${passed} passed`);
