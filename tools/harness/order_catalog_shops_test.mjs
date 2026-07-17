// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// D8/D9 -- THE ORDER SURFACES ARE THE THIRD CONSUMER OF THE SHOP JOB TABLES, AND NOTHING WAS
// WATCHING THEM.
//
//   node tools/harness/order_catalog_shops_test.mjs
// Exit: 0 PASS/SKIP, 1 FAIL.
//
// WHY THIS FILE EXISTS. The shop-oracles wave re-authored the Siege workshop's 21 task rows from
// WS-SIEGE-native-{1,2}of2.png and, in doing so, silently EMPTIED both work-order surfaces:
//   * order_catalog_by_shop() filtered dynamic defs to MakeTool only -- the 21 new defs are
//     AssembleSiegeAmmo / Construct*Parts, so ZERO entries survived and the whole Siege group was
//     omitted from the fort-wide manager catalog.
//   * expand_order_entries() dropped every subtype-carrying non-MakeTool def -- killing all 18
//     `Assemble <metal> ballista arrow` rows on the workshop's own "Add shop work order" picker.
// Before the wave the owner could order `assemble balista arrow`; after it, nowhere. The wave's own 37-cell
// suite asserted that the getJobs FILTER was applied -- never that the Siege still YIELDED anything.
// That is the bug this file is built to make impossible.
//
// WHAT THIS TEST IS, EXACTLY -- no overstatement. There is no Lua interpreter in the offline harness
// (see lua_syntax_guard.mjs), so this is not `order_catalog_by_shop()` running. It is a DATA-FLOW
// MODEL of it, and BOTH ends of the pipeline are read from REAL sources, not from expectations typed
// into this file:
//   * ours   -- dwf.lua: SHOP_CATALOG_SPECS, AUTHORED_SHOPS, EXTRA_SHOP_JOBS, FORGE_STATIC,
//               the dynamic_shop_jobs arms, ORDER_SUBTYPE_JOBS, ORDER_EXCLUDED_JOBS.
//   * DF's   -- <DF>/hack/lua/dfhack/workshops.lua: the hardcoded job tables getJobs() returns.
// It then applies the three gates the server applies (getjobs_def_allowed, the catalog's dynamic-def
// rule, expand_order_entries' subtype/exclusion gates) and asserts the RESULT IS NON-EMPTY for every
// workshop the owner captured.
//
// KNOWN LIMITS, said plainly:
//   * getJobs also returns the BUILDING'S RAWS REACTIONS. This model ignores them, which makes every
//     count here a LOWER BOUND -- it can report a false emptiness, never a false non-emptiness. The
//     assertion is one-sided in the safe direction.
//   * a 'metal'-mode def expands per on-hand metal; with no metals in the fort it yields 0 rows. That
//     is a live-fort property and is out of scope for an offline model.
//   * needs a DF install to read dfhack's own workshops.lua. No install => SKIP (harness rule).
//
// It fails against the branch tip it was written for: Siege modelled ZERO entries.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDfRoot } from "../lib/dfroot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const lua = fs.readFileSync(path.join(root, "dwf.lua"), "utf8");

const df = resolveDfRoot();
const dfhackShops = df.root
  ? path.join(df.root, "hack", "lua", "dfhack", "workshops.lua") : null;
if (!dfhackShops || !fs.existsSync(dfhackShops)) {
  console.log("SKIP - order_catalog_shops_test needs a Dwarf Fortress install (it reads dfhack's " +
              "own hack/lua/dfhack/workshops.lua, which is the other half of the catalog). " +
              "Pass --df-root or set DWF_DF_ROOT.");
  process.exit(0);
}
const dfhackLua = fs.readFileSync(dfhackShops, "utf8");

let passed = 0, failed = 0;
function check(fn, name) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { failed++; console.log(`  FAIL - ${name}: ${err.message}`); }
}

// ---------------------------------------------------------------------------------------------
// Source readers. Each pulls DATA out of a real file; none encodes an expected answer.
// ---------------------------------------------------------------------------------------------

// Body of a brace-delimited block starting at the first `{` at/after `from`.
function braceBlock(src, from) {
  const open = src.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return "";
}

function block(src, header) {
  const at = src.indexOf(header);
  return at === -1 ? "" : braceBlock(src, at + header.length - 1);
}

// dwf.lua: {'Workshop', 'Siege', "Siege Workshop", 'workshop_siege'} -> keys, in order.
function catalogSpecKeys() {
  const body = block(lua, "local SHOP_CATALOG_SPECS =");
  return [...body.matchAll(/\{\s*'(?:Workshop|Furnace)',\s*'(\w+)'/g)].map(m => m[1]);
}

// dwf.lua: local AUTHORED_SHOPS = { Jewelers = true, Siege = true }
function authoredShops() {
  const body = block(lua, "local AUTHORED_SHOPS =");
  return new Set([...body.matchAll(/(\w+)\s*=\s*true/g)].map(m => m[1]));
}

// dwf.lua: ORDER_SUBTYPE_JOBS[df.job_type.MakeTool] = true  (and ORDER_EXCLUDED_JOBS)
function jobSet(name) {
  const re = new RegExp(`^${name}\\[df\\.job_type\\.(\\w+)\\]\\s*=\\s*true`, "gm");
  return new Set([...lua.matchAll(re)].map(m => m[1]));
}

// A modelled def: the two properties the order gates actually branch on.
const def = (job, subtype, src) => ({ job, subtype: !!subtype, src });

// dwf.lua EXTRA_SHOP_JOBS: split the top-level `Key = {` blocks, then read each row's job type
// out of plain_job / craft_job / encrust_job / an explicit job_fields. None of these rows pins an
// item_subtype (they are all whole-item jobs), which is why `subtype` is false throughout.
function extraShopJobs() {
  const body = block(lua, "local EXTRA_SHOP_JOBS =");
  const out = new Map();
  const re = /^ {4}(\w+) = \{/gm;
  for (const m of body.matchAll(re)) {
    const rows = braceBlock(body, m.index + m[0].length - 1);
    const jobs = [
      ...[...rows.matchAll(/plain_job\('[^']*',\s*'(\w+)'/g)].map(x => x[1]),
      ...[...rows.matchAll(/encrust_job\('[^']*',\s*'(\w+)'/g)].map(x => x[1]),
      ...[...rows.matchAll(/craft_job\('[^']*',\s*df\.job_type\.(\w+)/g)].map(x => x[1]),
      ...[...rows.matchAll(/job_fields = \{ job_type = df\.job_type\.(\w+)/g)].map(x => x[1]),
    ];
    if (jobs.length) out.set(m[1], jobs.map(j => def(j, /item_subtype/.test(rows), "EXTRA")));
  }
  return out;
}

// dwf.lua FORGE_STATIC: subtype-free metal furniture/goods (its own comment says so).
function forgeStatic() {
  const body = block(lua, "local FORGE_STATIC =");
  const jobs = new Set([...body.matchAll(/df\.job_type\.(\w+)/g)].map(m => m[1]));
  return [...jobs].map(j => def(j, false, "FORGE_STATIC"));
}

// dwf.lua dynamic_shop_jobs(): the per-shop entity-derived arms. The arm a shop key reaches is
// declared in the file itself (`local is_siege = (key == 'Siege')`), so the mapping is READ, not
// assumed. Within an arm:
//   enum_entity_defs(defs, group, pri, verb, df.job_type.X, ...)  -> X, and it ALWAYS pins an itemdef
//                                                                    subtype (that is its whole job)
//   ammo_shop_defs(...)                                           -> MakeAmmo, subtype-pinned
//   defs[#defs + 1] = { ... }                                     -> read job_type + item_subtype
//                                                                    out of the literal itself
function dynamicShopJobs() {
  const fnAt = lua.indexOf("function dynamic_shop_jobs(b)");
  const body = lua.slice(fnAt, lua.indexOf("\nend", fnAt));
  const flagKey = new Map();     // is_siege -> ['Siege']
  for (const m of body.matchAll(/local (is_\w+)\s*=\s*\(([^)]*)\)/g)) {
    const keys = [...m[2].matchAll(/key == '(\w+)'/g)].map(x => x[1]);
    if (keys.length) flagKey.set(m[1], keys);
  }
  // Arm boundaries: `if is_X then` / `elseif is_X then` ... up to the next arm.
  const marks = [...body.matchAll(/\n {4}(?:els)?e?if (is_\w+) then/g)]
    .map(m => ({ flag: m[1], at: m.index + m[0].length }));
  const out = new Map();
  marks.forEach((mark, i) => {
    const src = body.slice(mark.at, i + 1 < marks.length ? marks[i + 1].at : body.length);
    const defs = [];
    for (const m of src.matchAll(/enum_entity_defs\(defs,[^,]*,[^,]*,[^,]*,\s*df\.job_type\.(\w+)/g))
      defs.push(def(m[1], true, "dynamic:enum"));
    if (/ammo_shop_defs\(/.test(src)) defs.push(def("MakeAmmo", true, "dynamic:ammo"));
    // A `jf_base` shared by the literals below it (the siege loop composes its job_fields that way).
    const jfBase = src.match(/jf_base\s*=\s*\{\s*job_type = df\.job_type\.(\w+)/);
    for (const m of src.matchAll(/defs\[#defs \+ 1\] = /g)) {
      const lit = braceBlock(src, m.index + m[0].length);
      const jt = lit.match(/job_type = df\.job_type\.(\w+)/)
        || (/job_type = jf_base\.job_type/.test(lit) && jfBase ? [null, jfBase[1]] : null);
      if (jt) defs.push(def(jt[1], /item_subtype/.test(lit), "dynamic:literal"));
    }
    for (const key of flagKey.get(mark.flag) || []) {
      out.set(key, (out.get(key) || []).concat(defs));
    }
  });
  return out;
}

// DF's OWN dfhack/workshops.lua: the hardcoded tables getJobs() returns per workshop/furnace. None of
// them sets job_fields.item_subtype (verified: the only `item_subtype` occurrences in that file are
// job_ITEM reagent defaults, not job_fields).
function dfhackGetJobs() {
  const out = new Map();
  for (const m of dfhackLua.matchAll(/\[df\.(?:workshop|furnace)_type\.(\w+)\]\s*=\s*\{/g)) {
    const body = braceBlock(dfhackLua, m.index + m[0].length - 1);
    const jobs = [...body.matchAll(/job_fields\s*=\s*\{\s*job_type\s*=\s*df\.job_type\.(\w+)/g)]
      .map(x => def(x[1], false, "getJobs"));
    if (jobs.length) out.set(m[1], jobs);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The model: exactly the gates order_catalog_by_shop() applies, in the order it applies them.
// ---------------------------------------------------------------------------------------------
const SPECS = catalogSpecKeys();
const AUTHORED = authoredShops();
const SUBTYPE_OK = jobSet("ORDER_SUBTYPE_JOBS");
const EXCLUDED = jobSet("ORDER_EXCLUDED_JOBS");
const EXTRA = extraShopJobs();
const DYNAMIC = dynamicShopJobs();
const GETJOBS = dfhackGetJobs();
const FORGE = forgeStatic();
const FORGES = new Set(["MetalsmithsForge", "MagmaForge"]);

// The catalog's dynamic-def rule is READ from the code that applies it, never assumed: B155 admitted
// MakeTool only; D8 additionally admits an AUTHORED shop's whole arm. Hardcoding the post-fix rule
// here would make this file green against the very tree it was written to fail on. B261 extracted the
// per-shop projection into order_spec_entries(), shared by BOTH order_catalog_by_shop and the flat
// order_catalog -- so the rule now lives there. Prefer that; fall back to the by-shop function.
const CATALOG_BODY = (() => {
  for (const hdr of ["function order_spec_entries(spec, wo, metals)", "function order_catalog_by_shop()"]) {
    const at = lua.indexOf(hdr);
    if (at !== -1) return lua.slice(at, lua.indexOf("\nend", at));
  }
  return "";
})();
const CATALOG_TAKES_AUTHORED_DYNAMIC = /AUTHORED_SHOPS\[spec\[2\]\] or/.test(CATALOG_BODY);

// expand_order_entries(): a def yields >= 1 picker entry unless a gate drops it.
function orderable(d) {
  if (EXCLUDED.has(d.job)) return false;                     // needs a selection the key can't carry
  if (d.subtype && !SUBTYPE_OK.has(d.job)) return false;     // B22 exclusion, opened per job type
  return true;
}

// The def set order_catalog_by_shop() hands to order_entries_for_defs(), for one shop key.
function catalogDefs(key) {
  const defs = [];
  // getJobs, minus dfhack's hand-written table for a shop we author ourselves (getjobs_def_allowed).
  if (!AUTHORED.has(key)) defs.push(...(GETJOBS.get(key) || []));
  defs.push(...(EXTRA.get(key) || []));
  if (FORGES.has(key)) defs.push(...FORGE);
  // The dynamic arm: MakeTool for everyone (B155), the WHOLE arm for an authored shop (D8) -- an
  // authored shop's dynamic arm IS its list, because its getJobs table was just dropped.
  for (const d of DYNAMIC.get(key) || []) {
    if ((CATALOG_TAKES_AUTHORED_DYNAMIC && AUTHORED.has(key)) || d.job === "MakeTool") defs.push(d);
  }
  return defs;
}
const catalogEntries = key => catalogDefs(key).filter(orderable);

// The workshop's OWN "Add shop work order" picker (shop_order_tasks -> order_entries_for_defs over
// shop_job_defs): same gates, but the def set is the shop's FULL merged table -- the whole dynamic
// arm, not just MakeTool.
function shopPickerEntries(key) {
  const defs = [];
  if (!AUTHORED.has(key)) defs.push(...(GETJOBS.get(key) || []));
  defs.push(...(EXTRA.get(key) || []));
  if (FORGES.has(key)) defs.push(...FORGE);
  defs.push(...(DYNAMIC.get(key) || []));
  return defs.filter(orderable);
}

// The workshop Tasks tab (shop_tasks over shop_job_defs): every merged def is a ROW, order key or not.
const servedTasks = key => [
  ...(AUTHORED.has(key) ? [] : (GETJOBS.get(key) || [])),
  ...(EXTRA.get(key) || []),
  ...(FORGES.has(key) ? FORGE : []),
  ...(DYNAMIC.get(key) || []),
];

// ---------------------------------------------------------------------------------------------
// The shops the owner captured. A shop with a native capture is a shop we claim parity on -- and a claimed
// shop that offers NO work orders at all is broken, whatever its Tasks tab shows.
// ---------------------------------------------------------------------------------------------
const CAPTURED = [
  ["Farmers", "WS-FARMERS-native.png"], ["Quern", "WS-QUERN-native.png"],
  ["Ashery", "WS-ASHERY-native.png"], ["Jewelers", "WS-JEWELERS-native.png"],
  ["Siege", "WS-SIEGE-native-1of2.png"], ["Masons", "WS-MASONS-native-1of2.png"],
  ["Carpenters", "WS-CARPENTERS-native-1of3.png"], ["Craftsdwarfs", "WS-CRAFTSDWARF-ROCK-native-1of2.png"],
  ["Leatherworks", "WS-LEATHERWORKS-native-1of2.png"], ["Kitchen", "WS-KITCHEN-native.png"],
  ["Butchers", "WS-BUTCHERS-native.png"], ["Mechanics", "WS-MECHANICS-native.png"],
  ["Bowyers", "WS-BOWYERS-native.png"], ["Clothiers", "WS-CLOTHIERS-native-top.png"],
];

// PRE-EXISTING, NOT THIS WAVE'S DOING, AND NOT SILENTLY TOLERATED: these two shops' entire job lists
// are subtype-bearing entity-derived rows (MakeWeapon / MakeArmor / MakeHelm / ...), and B22 excluded
// every subtype family except MakeTool from the order surfaces. So they have offered zero work orders
// since long before this branch. They are listed here as an EXACT ratchet -- if a third shop ever
// joins them the assertion below goes red, and when the B22 audit opens those families this list must
// SHRINK, never grow.
const KNOWN_EMPTY = new Set(["Bowyers", "Clothiers"]);

console.log("# D8 -- every captured workshop still offers work orders (the Siege regression)");
check(() => {
  assert.ok(SPECS.includes("Siege"), "SHOP_CATALOG_SPECS lost the Siege workshop");
  const empty = CAPTURED.filter(([k]) => catalogEntries(k).length === 0).map(([k]) => k);
  assert.deepEqual(empty.sort(), [...KNOWN_EMPTY].sort(),
    `the fort-wide manager catalog omits ${JSON.stringify(empty)} entirely -- a shop group with ` +
    "zero entries is not rendered at all, so the player cannot order anything from it. Expected only " +
    `the two pre-existing B22-excluded shops ${JSON.stringify([...KNOWN_EMPTY])}.`);
}, "no captured shop is missing from the manager catalog (except the 2 known B22 holdouts)");

check(() => {
  const items = catalogEntries("Siege");
  const jobs = new Set(items.map(d => d.job));
  assert.ok(items.length > 0,
    "THE REGRESSION: the Siege group yields ZERO catalog entries. order_catalog_by_shop takes the " +
    "dynamic arm only for MakeTool, AUTHORED_SHOPS drops dfhack's getJobs rows, and EXTRA_SHOP_JOBS " +
    "has no Siege key -- so nothing survives and the whole group is dropped from the catalog JSON.");
  assert.ok(jobs.has("AssembleSiegeAmmo"),
    "no ballista-arrow order anywhere in the fort-wide catalog -- the 18 per-metal Assemble rows are " +
    "the shop's whole point");
  for (const parts of ["ConstructBallistaParts", "ConstructBoltThrowerParts", "ConstructCatapultParts"])
    assert.ok(jobs.has(parts), `the Siege catalog lost ${parts}`);
}, "the Siege manager catalog serves the assemble rows AND all three parts rows");

check(() => {
  const jobs = new Set(shopPickerEntries("Siege").map(d => d.job));
  assert.ok(jobs.has("AssembleSiegeAmmo"),
    "the workshop's own 'Add shop work order' picker drops every Assemble row: expand_order_entries " +
    "excludes any subtype-carrying def whose job is not in ORDER_SUBTYPE_JOBS, and the 18 siege rows " +
    "carry item_type SIEGEAMMO + the itemdef index. The parts rows survive; the ammo does not.");
  assert.ok(SUBTYPE_OK.has("AssembleSiegeAmmo") && SUBTYPE_OK.has("MakeTool"),
    "ORDER_SUBTYPE_JOBS must carry both the B155 opening (MakeTool) and the D8 one");
}, "the workshop-level order picker keeps the Assemble rows too (both surfaces, one gate)");

check(() => {
  // The 18 rows differ ONLY by mat_type/mat_index. derive_order_material must key them per metal --
  // its bare `mat_type == 0` rock branch would collapse all 18 onto `|mat:0:-1` and dedupe 17 away.
  const fn = lua.slice(lua.indexOf("function derive_order_material(def)"));
  const body = fn.slice(0, fn.indexOf("\nend"));
  const pinned = body.indexOf("jf.mat_index >= 0");
  const rock = body.indexOf("jf.mat_type == 0 then");
  assert.ok(pinned !== -1, "derive_order_material has no branch for a def that pins a real material");
  assert.ok(pinned < rock,
    "the pinned-material branch must come BEFORE the `mat_type == 0` rock branch -- a metal IS " +
    "mat_type 0 (INORGANIC) with a real mat_index, so the rock branch swallows all 18 siege rows " +
    "into one key labelled '(rock)'");
  const exp = lua.slice(lua.indexOf("function expand_order_entries(def, base_key, metals)"));
  assert.match(exp.slice(0, exp.indexOf("\nend")), /if def\.label_locked then return name end/,
    "a capture-locked label already names its material ('Assemble bismuth bronze ballista arrow'); " +
    "re-applying the derived adjective prints it twice");
}, "the 18 per-metal rows key and label distinctly (no dedupe collapse, no doubled adjective)");

console.log("# D9 -- the mason's row 1 EXISTS (the '(opens menu)' marker was rendering nothing)");
check(() => {
  const rows = servedTasks("Masons");
  assert.ok(rows.some(d => d.job === "EngraveSlab"),
    "THE ROW IS NOT SERVED. WS-MASONS-native-1of2.png row 1 is `Engrave memorial slab (opens menu)` " +
    "and we serve 19 of native's 20 rows. D7b added the '(opens menu)' SUFFIX for a def with " +
    "job_type == EngraveSlab -- but no source produces one: dfhack's Masons table has `construct " +
    "slab` (the blank slab) and no engrave job, EXTRA_SHOP_JOBS had no Masons key, and the mason's " +
    "dynamic arm emits MakeTool only. The suffix code was dead. Add the DEF, not the marker.");
  assert.ok((GETJOBS.get("Masons") || []).every(d => d.job !== "EngraveSlab"),
    "dfhack's own Masons table now has an EngraveSlab job -- if DF/dfhack shipped one, drop ours " +
    "rather than serving the row twice");
  assert.ok((EXTRA.get("Masons") || []).some(d => d.job === "EngraveSlab"),
    "the EngraveSlab def must come from EXTRA_SHOP_JOBS.Masons");
}, "the mason serves an EngraveSlab task row (native row 1 of 20)");

check(() => {
  const st = lua.slice(lua.indexOf("function shop_tasks(b, defs)"));
  const body = st.slice(0, st.indexOf("\nend\n"));
  assert.match(body, /local needs_unit = job_type == df\.job_type\.EngraveSlab/,
    "the served row must be marked as needing a unit selection");
  assert.match(body, /native_name = tostring\(native_name\) \.\. ' \(opens menu\)'/,
    "native marks it '(opens menu)' -- it drills into dead units instead of reactions");
}, "the served row renders with its '(opens menu)' marker and needsUnitSelection");

check(() => {
  assert.ok(EXCLUDED.has("EngraveSlab"),
    "an EngraveSlab manager order needs a specific dead historical figure " +
    "(manager_order.specdata.hist_figure_id). The order key cannot carry one, so the row must be a " +
    "TASK only -- adding the def without excluding it would put a nonsense order on both pickers.");
  assert.ok(!catalogEntries("Masons").some(d => d.job === "EngraveSlab"),
    "the mason's manager catalog is offering an EngraveSlab order");
  assert.ok(!shopPickerEntries("Masons").some(d => d.job === "EngraveSlab"),
    "the mason's shop work-order picker is offering an EngraveSlab order");
  assert.ok(catalogEntries("Masons").length > 0,
    "excluding EngraveSlab must not empty the mason's catalog");
  const co = lua.slice(lua.indexOf("function create_order(key, amount, frequency, workshop_id)"));
  assert.match(co.slice(0, 4000), /if ORDER_EXCLUDED_JOBS\[job_type_val\] then/,
    "create_order must reject an excluded job too -- a raw POST is a surface as well");
}, "EngraveSlab is a task, never an order (both pickers + create_order agree)");

// ---------------------------------------------------------------------------------------------
// B261 -- THE FORT-WIDE /order-catalog MUST NOT BE A SECOND HAND LIST.
//
// The workshop Tasks menu and the two order pickers are surfaces of ONE concept. order_catalog_by_shop
// (served /order-catalog-shops) derives from the shop job tables (modelled above). The fort-wide
// order_catalog (served /order-catalog) used to be a SEPARATE hand-maintained `ORDER_CATALOG` literal,
// and it drifted: it missed MilkCreature / ShearCreature / ProcessPlantsVial and the whole Siege
// group, and carried a material-less `Ammo` row (a bare subtype job the create_order surface rejects).
// This cell fails the instant the flat catalog can offer a different orderable job set than the
// by-shop source -- i.e. the instant a parallel hand list exists again. It is one-sided in the SAFE
// direction (like the D8 cells: it can cry a false drift, never hide a real one).
// ---------------------------------------------------------------------------------------------

// Orderable job_types the by-shop picker offers, over EVERY shop (the single source of truth).
const byShopOrderableJobs = new Set();
for (const key of SPECS) for (const d of catalogEntries(key)) byShopOrderableJobs.add(d.job);

// Model of order_catalog()'s job set. If a hand-maintained ORDER_CATALOG literal still exists, parse
// the job rows it emits -- THAT is the drift we guard. Otherwise order_catalog() derives from
// order_spec_entries over SHOP_CATALOG_SPECS, so its orderable set is the by-shop union by
// construction, and we verify that delegation structurally so the branch is not vacuous.
const handListBody = block(lua, "local ORDER_CATALOG =");
const flatIsHandList = handListBody.length > 0;
const flatJobs = flatIsHandList
  ? new Set([...handListBody.matchAll(/job='(\w+)'/g)].map(m => m[1]))
  : byShopOrderableJobs;

// Subtype-bearing jobs anywhere in the shop model (MakeAmmo, MakeWeapon, MakeArmor, ...). A flat row
// for one of these carries no material/subtype in its key -- the "material-less Ammo row" defect.
const subtypeJobs = new Set();
for (const key of SPECS) for (const d of servedTasks(key)) if (d.subtype) subtypeJobs.add(d.job);

console.log("# B261 -- the fort-wide /order-catalog derives from the shop tables (no second hand list)");

check(() => {
  if (flatIsHandList) {
    const missing = [...byShopOrderableJobs].filter(j => !flatJobs.has(j)).sort();
    assert.equal(missing.length, 0,
      `the flat /order-catalog is a SEPARATE hand list and is missing ${missing.length} orderable ` +
      `job(s) the by-shop picker offers: ${JSON.stringify(missing)}. An orderable job must come from ` +
      `the ONE shared source (order_spec_entries), never a second copy that drifts.`);
  } else {
    const oc = lua.slice(lua.indexOf("function order_catalog()"));
    const body = oc.slice(0, oc.indexOf("\nend"));
    assert.match(body, /order_spec_entries\(/,
      "order_catalog() has no ORDER_CATALOG hand list but does not call order_spec_entries either -- " +
      "it must DERIVE from the shared per-shop projection so the two order surfaces cannot drift.");
    assert.match(body, /SHOP_CATALOG_SPECS/,
      "order_catalog() must iterate SHOP_CATALOG_SPECS (the single shop source) to derive its rows.");
  }
}, "every orderable job in the by-shop picker is reachable from the flat /order-catalog");

check(() => {
  if (flatIsHandList) {
    const bare = [...flatJobs].filter(j => subtypeJobs.has(j)).sort();
    assert.equal(bare.length, 0,
      `the flat /order-catalog carries bare rows for subtype-bearing jobs ${JSON.stringify(bare)} -- ` +
      `their key has no material/subtype (the 'Ammo' defect) so create_order rejects or mis-fills them. ` +
      `A derived catalog cannot emit them: expand_order_entries pins the material or drops the def.`);
  } else {
    const oc = lua.slice(lua.indexOf("function order_catalog()"));
    const body = oc.slice(0, oc.indexOf("\nend"));
    assert.doesNotMatch(body, /job='\w+'/,
      "order_catalog() contains a hand-written job='...' row -- that is a re-introduced parallel list. " +
      "Every row must come from order_spec_entries.");
    assert.equal(block(lua, "local ORDER_CATALOG =").length, 0,
      "a `local ORDER_CATALOG = {...}` literal is back in dwf.lua -- the second hand list the " +
      "B261 unification deleted. Delete it again; order_catalog() derives from the shop tables.");
  }
}, "the flat /order-catalog offers no material-less row for a subtype-bearing job (the Ammo defect)");

console.log(`\n${failed === 0 ? "# PASS" : "# FAIL"} -- ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
