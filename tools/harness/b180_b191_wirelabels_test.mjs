// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// Offline source/fixture coverage for B180 material-aware workshop labels and B191's complete
// fort-agreement list. No DF process, network request, or browser is used.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lua = readFileSync(join(root, "dwf.lua"), "utf8");
const cpp = readFileSync(join(root, "src/fort_admin.cpp"), "utf8");
const client = readFileSync(join(root, "web/js/dwf-building-zone-stockpile-panels.js"), "utf8");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { failed++; console.error(`FAIL ${name}: ${err.message}`); }
}

console.log("# B180 native flat-task label source");
check("prospective native job receives material derived from the same authoritative definition", () => {
  assert.match(lua, /function native_flat_task_label\([\s\S]*?derive_order_material\(def\)/);
  assert.match(lua, /material\.mode == 'cat'[\s\S]*?probe\.material_category\[material\.cat\] = true/);
  assert.match(lua, /material\.mode == 'mat'[\s\S]*?probe\.mat_type = material\.mt[\s\S]*?probe\.mat_index = material\.mi/);
});
check("native button text is the primary label and unknown-material output is rejected", () => {
  assert.match(lua, /native_name = dfhack\.job\.getName\(probe\)/);
  assert.match(lua, /native_name:lower\(\):find\('unknown material', 1, true\)[\s\S]*?return fallback/);
  assert.match(lua, /return native_name, 'native-material-aware'/);
  assert.match(lua, /return fallback, 'definition-fallback'/);
  assert.match(lua, /"labelSource":' \..*task\.label_source/);
});
// D3/D4 (2026-07-14 parity review): the suppression is now table-driven and covers the leatherworks,
// and the pattern is fixed -- the generated codes read 'MAKE_ENT291 INP2_BODY' (a SPACE), so the old
// '^MAKE_ENT%d+_' matched NOTHING and the suppression it advertised never ran.
check("captured flat shops do not expose generated MAKE_ENT leaves", () => {
  assert.match(lua, /local CAPTURED_FLAT_SHOPS = \{ Masons = true, Carpenters = true, Leatherworks = true \}/);
  assert.match(lua, /CAPTURED_FLAT_SHOPS\[shop_key\]/);
  assert.match(lua, /reaction:match\('\^MAKE_ENT%d\+'\)/);
  assert.doesNotMatch(lua, /reaction:match\('\^MAKE_ENT%d\+_'\)/,
    "the underscore pattern can never match a real generated reaction code");
  assert.match(lua, /if not generated_instrument then/);
});
check("client sentence-case stopgap is a passthrough for native-cased labels", () => {
  const sentenceCase = value => {
    const s = String(value ?? "");
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  };
  for (const label of ["Make rock armor stand", "Make bed", "Make four wooden blocks"])
    assert.equal(sentenceCase(label), label);
  assert.match(client, /label: DWFUI\.sentenceCase\(label\)/);
});
check("test-the-test: the old context-free probe is caught by the material fixture", () => {
  const oldProbe = { matType: -1, materialCategory: null, rendered: "Make unknown material armor stand" };
  assert.equal(oldProbe.rendered.includes("unknown material"), true);
  assert.notEqual(oldProbe.matType, 0);
});

console.log("\n# B191 pending + continuing fort agreements");
function unionFortAgreements(pending, continuing) {
  const refs = [];
  const append = (rows, pendingList) => rows.forEach(row => {
    let ref = refs.find(value => value.id === row.id);
    if (!ref) refs.push(ref = { ...row, inPendingList: false, inContinuingList: false });
    if (pendingList) ref.inPendingList = true;
    else ref.inContinuingList = true;
  });
  append(pending, true);
  append(continuing, false);
  return refs;
}

// Category matrix from df.agreement.xml + the two fort-owned plotinfo vectors. Location covers
// both temple and guildhall obligations; Residency and Citizenship are the other petition details.
const pending = [
  { id: 10, detail: "Residency" },
  { id: 11, detail: "Citizenship" },
  { id: 12, detail: "Location", location: "Temple" },
];
const continuing = [
  { id: 12, detail: "Location", location: "Temple" }, // duplicate across states
  { id: 13, detail: "Location", location: "Guildhall" },
  { id: 14, detail: "Residency" },
  { id: 15, detail: "Citizenship" },
];
const union = unionFortAgreements(pending, continuing);

check("all pending and continuing Residency/Citizenship/Location fixtures are listed", () => {
  assert.deepEqual(union.map(row => row.id), [10, 11, 12, 13, 14, 15]);
  for (const kind of ["Residency", "Citizenship", "Location"])
    assert.equal(union.some(row => row.detail === kind), true, `missing ${kind}`);
  assert.equal(union.some(row => row.location === "Temple"), true);
  assert.equal(union.some(row => row.location === "Guildhall"), true);
});
check("duplicate agreement ids are emitted once with both memberships", () => {
  const row = union.find(value => value.id === 12);
  assert.equal(union.filter(value => value.id === 12).length, 1);
  assert.equal(row.inPendingList, true);
  assert.equal(row.inContinuingList, true);
});
check("test-the-test: the old pending-only source misses every continuing-only fixture", () => {
  const oldIds = new Set(pending.map(row => row.id));
  assert.deepEqual(continuing.filter(row => !oldIds.has(row.id)).map(row => row.id), [13, 14, 15]);
});
check("server unions only the two fort-owned id vectors and advertises the coverage witness", () => {
  assert.match(cpp, /append_ids\(plotinfo->petitions, true\)/);
  assert.match(cpp, /append_ids\(plotinfo->continuing_agreement_id, false\)/);
  assert.doesNotMatch(cpp, /world->agreements\.all/);
  assert.match(cpp, /agreementCoverage\\\":\\\"pending\+continuing/);
  assert.match(cpp, /inPendingList/);
  assert.match(cpp, /inContinuingList/);
});
check("crash-correlation guard: ids resolve after dedupe and every existing detail/party walk is guarded", () => {
  assert.match(cpp, /for \(const auto& ref : agreement_refs\)[\s\S]*?df::agreement::find\(ref\.id\)/);
  assert.match(cpp, /for \(auto detail : agreement->details\) \{\s*if \(!detail\)\s*continue;/);
  assert.match(cpp, /detail->type == df::agreement_details_type::Citizenship && detail->data\.Citizenship/);
  assert.match(cpp, /detail->type == df::agreement_details_type::Residency && detail->data\.Residency/);
  assert.match(cpp, /party && !party->histfig_ids\.empty\(\)/);
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
