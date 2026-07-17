// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// B284 -- SEARCHING "bolts" IN THE "ADD A WORK ORDER" PICKER RETURNED NOTHING.
//
//   node tools/harness/b284_bolt_search_test.mjs
// Exit: 0 PASS, 1 FAIL.   (B284_LUA=<path> overrides the dwf.lua read, for before/after proof.)
//
// THE BUG, as the player saw it: the "add an order" picker's "Find a task..." box, queried for
// "bolts", listed ZERO rows -- even though wooden + bone bolts are made at the craftsdwarf and metal
// bolts at the forge, and each shop's own Tasks tab shows them.
//
// THE CAUSE (NOT the B261 regression first suspected): that search filters woShopCatalog, which is
// /order-catalog-shops -> order_catalog_by_shop -> order_spec_entries. That path predates B261 and
// B261 did not touch it. Bolts were never IN the corpus: MakeAmmo is a subtype-bearing job, and the
// B22 subtype gate (ORDER_SUBTYPE_JOBS) plus order_spec_entries' dynamic-arm gate both admitted only
// MakeTool (+ AssembleSiegeAmmo). So the ammo defs the shops build were filtered out before the
// picker ever saw them, and a substring search over an empty corpus finds nothing.
//
// WHAT THIS TEST IS, EXACTLY -- no overstatement. There is no Lua interpreter in the offline harness
// (see order_catalog_shops_test.mjs / lua_syntax_guard.mjs), so this does not run order_spec_entries.
// It is a RESULT-SET test built the way that file models the pipeline:
//   * the two admission GATES are READ from the live dwf.lua (ORDER_SUBTYPE_JOBS assignments +
//     the order_spec_entries dynamic-arm predicate), never hard-coded to the post-fix answer;
//   * the three representative bolt rows the shops build (wood/bone at the craftsdwarf, per-metal at
//     the forge) are pushed into a modelled order corpus IFF both gates admit MakeAmmo, with their
//     labels composed exactly as expand_order_entries composes them (label_locked verbatim for the
//     craftsdwarf 'cat' rows; 'forge <metal> <noun>' for the forge 'metal' rows);
//   * the ACTUAL client search -- dfTokenMatch, mirrored from web/js/dwf-core.js and asserted
//     still present there -- is then run over the corpus with query "bolts", and the RESULT SET is
//     asserted (not the source). A baseline of non-ammo orders is in the corpus so the search must
//     DISCRIMINATE, not merely echo membership.
// It is one-sided in the safe direction: with the gates closed (pre-fix) the corpus carries no bolt
// row and the "bolts" search yields zero -- the exact failure this file reproduces. Run it against
// the pre-fix tree to see it fail:  B284_LUA=<pre-fix dwf.lua> node .../b284_bolt_search_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const luaPath = process.env.B284_LUA || path.join(root, "dwf.lua");
const lua = fs.readFileSync(luaPath, "utf8");
const coreJs = fs.readFileSync(path.join(root, "web", "js", "dwf-core.js"), "utf8");

let passed = 0, failed = 0;
function check(fn, name) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { failed++; console.log(`  FAIL - ${name}: ${err.message}`); }
}

// --------------------------------------------------------------------------------------------------
// The ACTUAL client search, mirrored from web/js/dwf-core.js. A guard below asserts the real
// function still has this token/indexOf shape, so a change to the real matcher trips this test.
// --------------------------------------------------------------------------------------------------
function dfTokenMatch(haystack, query) {
  const h = String(haystack == null ? "" : haystack).toLowerCase();
  const q = String(query == null ? "" : query).trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] && h.indexOf(tokens[i]) === -1) return false;
  }
  return true;
}

// --------------------------------------------------------------------------------------------------
// Gate readers -- both pulled from the live dwf.lua, so the corpus reflects the source's rules.
// --------------------------------------------------------------------------------------------------

// ORDER_SUBTYPE_JOBS[df.job_type.X] = true  -> the subtype families expand_order_entries admits.
function orderSubtypeJobs() {
  return new Set([...lua.matchAll(/ORDER_SUBTYPE_JOBS\[df\.job_type\.(\w+)\]\s*=\s*true/g)].map(m => m[1]));
}

// The dynamic-arm admission predicate inside order_spec_entries: does it let a MakeAmmo dynamic def
// through? Read the loop body, don't assume. Post-fix defers to ORDER_SUBTYPE_JOBS; pre-fix hard-coded
// `== df.job_type.MakeTool`.
function specDynamicLoopBody() {
  const at = lua.indexOf("function order_spec_entries(spec, wo, metals)");
  assert.notEqual(at, -1, "order_spec_entries not found");
  const body = lua.slice(at, lua.indexOf("\nend", at));
  const dynAt = body.indexOf("local dynamic = dynamic_shop_jobs");
  assert.notEqual(dynAt, -1, "order_spec_entries no longer has a dynamic_shop_jobs arm");
  return body.slice(dynAt);
}
function dynamicArmAdmits(job, SUBTYPE) {
  const loop = specDynamicLoopBody();
  if (/ORDER_SUBTYPE_JOBS\[\w+\]/.test(loop)) return SUBTYPE.has(job);   // defers to the shared list
  const re = new RegExp(`job_type == df\\.job_type\\.${job}\\b`);
  return re.test(loop);
}

// Does ammo_shop_defs mark its (craftsdwarf wood/bone) rows label_locked? Governs whether the
// composed 'cat' label is used verbatim or re-adjectived.
function ammoDefsLabelLocked() {
  const at = lua.indexOf("function ammo_shop_defs(defs, group, pri, adj, matcat, reagent)");
  const body = lua.slice(at, lua.indexOf("\nend", at));
  return /label_locked = true/.test(body);
}

// --------------------------------------------------------------------------------------------------
// expand_order_entries label composition, mirrored for the two modes the bolt defs take.
// --------------------------------------------------------------------------------------------------
function nameWithAdj(name, adj) {                       // dwf.lua name_with_adj
  if (!adj) return name;
  const m = name.match(/^(\S+)\s+(.+)$/);
  return m ? `${m[1]} ${adj} ${m[2]}` : `${adj} ${name}`;
}

const SUBTYPE = orderSubtypeJobs();
const ammoAdmitted = SUBTYPE.has("MakeAmmo") && dynamicArmAdmits("MakeAmmo", SUBTYPE);
const locked = ammoDefsLabelLocked();

// --------------------------------------------------------------------------------------------------
// The modelled "add a work order" corpus the picker search runs over (== woShopCatalog items).
// --------------------------------------------------------------------------------------------------
function buildCorpus() {
  const corpus = [];
  // Baseline non-ammo orders that are ALWAYS orderable (MakeTool passed both gates long before B284).
  // Their presence makes the "bolts" query DISCRIMINATE rather than trivially echo membership.
  corpus.push({ key: "j:MakeTool|it:TOOL|st:1|cat:wood", label: "Make wooden minecart" });
  corpus.push({ key: "j:MakeCage|cat:wood",              label: "Make wooden cage" });
  corpus.push({ key: "j:MakeWeapon|it:WEAPON|st:0|mat:0:8", label: "forge iron short sword" });

  if (ammoAdmitted) {
    // Craftsdwarf: ammo_shop_defs pins material_category -> expand takes mode='cat'. The namer already
    // baked the adjective in, so label_locked => verbatim; without it, name_with_adj doubles it.
    const woodName = "Make twenty-five wooden bolts";
    const boneName = "Make five bone bolts";
    corpus.push({ key: "j:MakeAmmo|it:AMMO|st:0|cat:wood",
                  label: locked ? woodName : nameWithAdj(woodName, "wooden") });
    corpus.push({ key: "j:MakeAmmo|it:AMMO|st:0|cat:bone",
                  label: locked ? boneName : nameWithAdj(boneName, "bone") });
    // Forge: no material_category, metal-bar reagent -> expand mode='metal', one row per forge metal,
    // label 'forge <metal> <noun>' with noun = name minus the leading forge/make (here: "bolts").
    for (const metal of ["copper", "iron", "steel", "bronze"]) {
      corpus.push({ key: `j:MakeAmmo|it:AMMO|st:0|mat:0:${metal.length}`,
                    label: `forge ${metal} bolts` });
    }
  }
  return corpus;
}

const CORPUS = buildCorpus();
// This IS the picker's filter (dwf-labor-work-orders.js woNewTaskList): dfTokenMatch over the
// full label of every catalog row, deduped by key.
function searchOrders(q) {
  const out = [], seen = new Set();
  for (const it of CORPUS) {
    if (dfTokenMatch(it.label, q) && !seen.has(it.key)) { seen.add(it.key); out.push(it); }
  }
  return out;
}

// --------------------------------------------------------------------------------------------------
console.log("# the client search fn is the one this test mirrors");
check(() => {
  assert.match(coreJs, /function dfTokenMatch\(haystack, query\)/,
    "web/js/dwf-core.js no longer defines dfTokenMatch -- the picker search this test models");
  assert.match(coreJs, /tokens\[i\] && h\.indexOf\(tokens\[i\]\) === -1/,
    "dfTokenMatch changed shape from the token/indexOf substring match this test mirrors");
}, "dfTokenMatch is the real client search (token substring over the full label)");

console.log("# the corpus is real and the search discriminates (not a trivial pass)");
check(() => {
  assert.ok(CORPUS.length >= 3, "modelled order corpus is empty even of its non-ammo baseline");
  const none = searchOrders("zzzznotathing");
  assert.equal(none.length, 0, "search matched a query present in no label");
  const tools = searchOrders("minecart");
  assert.equal(tools.length, 1, "search for 'minecart' should return exactly the one tool row");
}, "the modelled corpus + search behave (baseline present, nonsense query empty, exact query narrows)");

console.log('# THE BUG + FIX: searching "bolts" returns the wooden, bone AND metal bolt orders');
check(() => {
  const results = searchOrders("bolts");
  const labels = results.map(r => r.label);
  assert.ok(results.length > 0,
    'THE BUG: searching "bolts" in the add-an-order picker returns ZERO rows. The order corpus ' +
    '(/order-catalog-shops -> order_spec_entries) carries no MakeAmmo row: ORDER_SUBTYPE_JOBS and/or ' +
    "the order_spec_entries dynamic-arm gate exclude MakeAmmo, so the bolt defs the craftsdwarf and " +
    'forge build are filtered out before the picker sees them. Open MakeAmmo on both gates. Got: ' +
    JSON.stringify(labels));

  const wood = labels.filter(l => /wooden bolts$/.test(l));
  const bone = labels.filter(l => /bone bolts$/.test(l));
  const metal = labels.filter(l => /^forge \w+ bolts$/.test(l));
  assert.ok(wood.length === 1, `expected exactly one WOODEN bolts order, got ${JSON.stringify(wood)}`);
  assert.ok(bone.length === 1, `expected exactly one BONE bolts order, got ${JSON.stringify(bone)}`);
  assert.ok(metal.length >= 1, `expected at least one METAL (forge) bolts order, got ${JSON.stringify(metal)}`);

  // Every result actually contains the searched word, and none is double-adjectived.
  for (const l of labels) assert.ok(/\bbolts\b/.test(l), `a "bolts" result has no 'bolts' in it: "${l}"`);
  assert.deepEqual(wood, ["Make twenty-five wooden bolts"],
    `the wooden bolts label is wrong (double-adjective if not label_locked): ${JSON.stringify(wood)}`);
  assert.deepEqual(bone, ["Make five bone bolts"],
    `the bone bolts label is wrong (double-adjective if not label_locked): ${JSON.stringify(bone)}`);
}, 'searching "bolts" returns wooden + bone + metal bolt orders, each with a clean native label');

console.log(`\n${failed === 0 ? "# PASS" : "# FAIL"} -- ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
