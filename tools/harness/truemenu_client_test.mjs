// truemenu_client_test.mjs -- TRUEMENU WP-1 client-side unit test for dwf-menu-tree.js.
//
// The forge drill-down has three pure surfaces the browser can't be trusted to reveal until
// deployed, so they are exercised here head-lessly (the gl_core_test vm-sandbox convention):
//   1. composeTaskKey -- the queue key grammar. It MUST stay in lock-step with dwf.lua's
//      parse_tree_task_key; this test embeds a faithful JS MIRROR of that lua parser and asserts
//      every composed key round-trips back to the exact fields the server would act on (a client
//      that emits a key the server misreads is the "wire connection opus misses" failure class).
//   2. levelAt / isForgeTree / categoryRowLabel -- the drill-down navigation + "(opens menu)"
//      labelling, across the level matrix (root / metal / leaf) incl. out-of-bounds fallback.
//   3. Rule-3 TEST-THE-TEST: seeded-bad inputs (malformed leaves, a non-forge tree, a corrupted
//      key) MUST be rejected -- the round-trip mirror is itself proven to discriminate.
//
// Run: node tools/harness/truemenu_client_test.mjs      (no server/browser). Exit 0 PASS / 1 FAIL.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok - ${name}`);
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

// ---- load the REAL client module (DOM-less vm sandbox) --------------------------------------
const sandbox = {};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "web/js/dwf-menu-tree.js"), "utf8"),
  sandbox, { filename: "dwf-menu-tree.js" });
const MT = sandbox.DwfMenuTree;
assert.ok(MT, "DwfMenuTree must load");

// ---- JS MIRROR of dwf.lua parse_tree_task_key (grammar oracle) ------------------------
// Kept deliberately independent of composeTaskKey so a drift in EITHER direction fails.
//   t:<JobType>[|it:<ItemType>][|st:<subtype>][|mat:<matType>:<matIndex>][|rc:<reactionCode>][|b:<batch>]
function parseTreeTaskKey(task) {
  if (typeof task !== "string" || task.slice(0, 2) !== "t:") return null;
  const out = {};
  const fields = task.split("|");
  out.jobType = fields[0].slice(2);            // strip "t:"
  for (let i = 1; i < fields.length; i++) {
    const f = fields[i];
    if (f.startsWith("it:")) out.itemType = f.slice(3);
    else if (f.startsWith("st:")) out.itemSubtype = Number(f.slice(3));
    else if (f.startsWith("mat:")) {
      const m = /^(-?\d+):(-?\d+)$/.exec(f.slice(4));
      if (m) { out.matType = Number(m[1]); out.matIndex = Number(m[2]); }
    } else if (f.startsWith("cat:")) out.materialCategory = f.slice(4);
    else if (f.startsWith("rc:")) out.reactionCode = f.slice(3);
    else if (f.startsWith("b:")) out.batch = Number(f.slice(2));
  }
  return out;
}

// ==============================================================================================
console.log("composeTaskKey grammar + round-trip:");

// (a) weapon leaf w/ subtype + metal (Forge iron battle axe)
{
  const leaf = { kind: "job", label: "Forge iron battle axe", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 1 };
  const metal = { label: "iron", matType: 0, matIndex: 0 };
  const key = MT.composeTaskKey(leaf, metal);
  check("weapon key form", key === "t:MakeWeapon|it:WEAPON|st:1|mat:0:0", `got ${key}`);
  const p = parseTreeTaskKey(key);
  check("weapon round-trip", p.jobType === "MakeWeapon" && p.itemType === "WEAPON" &&
    p.itemSubtype === 1 && p.matType === 0 && p.matIndex === 0);
}

// (b) ammo leaf w/ batch (Forge twenty-five iron bolts)
{
  const leaf = { kind: "job", label: "Forge twenty-five iron bolts", jobType: "MakeAmmo", itemType: "AMMO", itemSubtype: 0, batch: 25 };
  const metal = { label: "iron", matType: 0, matIndex: 0 };
  const key = MT.composeTaskKey(leaf, metal);
  check("ammo key has batch", key === "t:MakeAmmo|it:AMMO|st:0|mat:0:0|b:25", `got ${key}`);
  const p = parseTreeTaskKey(key);
  check("ammo round-trip batch+st0", p.batch === 25 && p.itemSubtype === 0 && p.matIndex === 0);
}

// (c) furniture leaf: no itemType/subtype, non-zero metal index (Make gold table)
{
  const leaf = { kind: "job", label: "Make gold table", jobType: "ConstructTable" };
  const metal = { label: "gold", matType: 0, matIndex: 12 };
  const key = MT.composeTaskKey(leaf, metal);
  check("furniture key (metal only)", key === "t:ConstructTable|mat:0:12", `got ${key}`);
  const p = parseTreeTaskKey(key);
  check("furniture round-trip pins metal", p.jobType === "ConstructTable" &&
    p.matIndex === 12 && p.itemType === undefined && p.itemSubtype === undefined);
}

// (d) reaction leaf: rc only, metal ignored (instrument piece)
{
  const leaf = { kind: "reaction", label: "make brass tromp body", reactionCode: "MAKE_ENT291 INP2_BODY" };
  const metal = { label: "brass", matType: 0, matIndex: 7 };
  const key = MT.composeTaskKey(leaf, metal);
  check("reaction key is CustomReaction|rc", key === "t:CustomReaction|rc:MAKE_ENT291 INP2_BODY", `got ${key}`);
  const p = parseTreeTaskKey(key);
  check("reaction round-trip carries code, no mat", p.reactionCode === "MAKE_ENT291 INP2_BODY" &&
    p.matIndex === undefined && p.jobType === "CustomReaction");
}

// (e) leaf w/ jobType but null metal (defensive: still valid, no mat pin)
{
  const key = MT.composeTaskKey({ kind: "job", jobType: "MintCoins" }, null);
  check("null-metal leaf still keys", key === "t:MintCoins" && parseTreeTaskKey(key).matType === undefined, `got ${key}`);
}

// ==============================================================================================
console.log("isForgeTree:");
const forgeTree = [
  { kind: "category", label: "Weapons and ammunition", metals: [
    { kind: "material", label: "iron", matType: 0, matIndex: 0, leaves: [
      { kind: "job", label: "Forge iron battle axe", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 1 },
      { kind: "job", label: "Forge iron pick", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 2 },
    ] },
    { kind: "material", label: "silver", matType: 0, matIndex: 2, leaves: [
      { kind: "job", label: "Forge silver mace", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 3 },
    ] },
  ] },
  { kind: "custom_category", label: "Make instrument", token: "INSTRUMENT", metals: [
    { kind: "material", label: "iron", matType: 0, matIndex: 0, leaves: [
      { kind: "reaction", label: "make iron drum", reactionCode: "R_DRUM" },
    ] },
  ] },
];
check("forge tree recognised", MT.isForgeTree(forgeTree) === true);
check("flat array (jobs) is NOT a forge tree", MT.isForgeTree([{ key: "MakeTable", name: "Make table" }]) === false);
check("null is NOT a forge tree", MT.isForgeTree(null) === false);
check("empty array is NOT a forge tree", MT.isForgeTree([]) === false);

// ==============================================================================================
console.log("categoryRowLabel (opens menu suffix):");
check("appends (opens menu)", MT.categoryRowLabel({ label: "Armor" }) === "Armor (opens menu)");
check("handles missing label", MT.categoryRowLabel({}) === "Category (opens menu)");

// ==============================================================================================
console.log("levelAt navigation matrix:");
{
  const l0 = MT.levelAt(forgeTree, []);
  check("root -> level 0, category rows", l0.level === 0 && l0.rows.length === 2 && l0.rows === forgeTree);

  const l1 = MT.levelAt(forgeTree, [0]);
  check("[0] -> level 1, metals of weapons", l1.level === 1 && l1.rows.length === 2 &&
    l1.rows[0].label === "iron" && l1.node === forgeTree[0]);

  const l2 = MT.levelAt(forgeTree, [0, 0]);
  check("[0,0] -> level 2, iron leaves", l2.level === 2 && l2.rows.length === 2 && l2.node.label === "iron");

  const l2b = MT.levelAt(forgeTree, [0, 1]);
  check("[0,1] -> level 2, silver leaves", l2b.level === 2 && l2b.rows.length === 1 && l2b.node.label === "silver");

  // out-of-bounds fallbacks (defensive navigation)
  check("bad catIdx -> falls back to root", MT.levelAt(forgeTree, [99]).level === 0);
  check("bad metalIdx -> falls back to that category's metals", MT.levelAt(forgeTree, [0, 99]).level === 1);
  check("non-array path -> root", MT.levelAt(forgeTree, null).level === 0);
  check("non-forge tree -> empty root", MT.levelAt([{ key: "x" }], [0]).rows.length === 0);
}

// ---- B41: leaf-only custom category (instruments have NO metal layer -- capture 28) ----------
{
  const leafOnlyTree = [
    { kind: "category", label: "Weapons and ammunition", metals: [
      { kind: "material", label: "iron", matType: 0, matIndex: 0, leaves: [
        { kind: "job", label: "Forge iron mace", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 1 } ] } ] },
    { kind: "custom_category", label: "Make instrument piece", token: "INSTRUMENT_PIECE", leaves: [
      { kind: "reaction", label: "Forge madush case", reactionCode: "MAKE_ENT305 INK1_BODY" },
      { kind: "reaction", label: "Forge madush strings", reactionCode: "MAKE_ENT305 INK1_VIB" } ] },
  ];
  check("leaf-only tree still recognised as forge tree", MT.isForgeTree(leafOnlyTree) === true);
  const li = MT.levelAt(leafOnlyTree, [1]);
  check("[1] on leaf-only category -> level 2 leaves directly (no metal layer)",
    li.level === 2 && li.rows.length === 2 && li.rows[0].kind === "reaction" && li.node === leafOnlyTree[1]);
  // the reaction leaf keys correctly with the category (no matType) passed as the 'metal' node
  const rkey = MT.composeTaskKey(li.rows[0], li.node);
  check("leaf-only reaction composes CustomReaction key w/o mat pin",
    rkey === "t:CustomReaction|rc:MAKE_ENT305 INK1_BODY", `got ${rkey}`);
  // a normal metal category is unaffected (still drills to metals at level 1)
  check("metal category still level 1 in same tree", MT.levelAt(leafOnlyTree, [0]).level === 1);
}

// ==============================================================================================
// flatshop-executor: FLAT-SHOP menu shapes -- leaf-at-root (Smelter/Kennels) + mixed root with
// material-selector submenus (Craftsdwarf). The client must render + key these correctly.
console.log("flat-shop menu-tree shapes:");
{
  // Smelter: leaf-at-root. Ore leaves pin their OWN material (matType/matIndex on the leaf, no
  // container). Reactions carry a code. Melt is a bare job.
  const smelter = [
    { kind: "job", label: "Melt a metal object", jobType: "MeltMetalObject" },
    { kind: "job", label: "Smelt hematite ore", jobType: "SmeltOre", matType: 0, matIndex: 186 },
    { kind: "reaction", label: "Make brass bars (use ore)", reactionCode: "BRASS_MAKING" },
  ];
  check("smelter tree is a menu tree", MT.isMenuTree(smelter) === true);
  check("smelter tree is NOT a forge tree", MT.isForgeTree(smelter) === false);
  const l0 = MT.levelAt(smelter, []);
  check("smelter root -> level 0 leaves", l0.level === 0 && l0.rows.length === 3);
  check("smelter leaves are not containers", smelter.every(n => MT.rowIsContainer(n) === false));
  // ore leaf keys with its OWN mat pin (no container passed)
  const oreKey = MT.composeTaskKey(smelter[1], null);
  check("smelter ore leaf pins its own material", oreKey === "t:SmeltOre|mat:0:186", `got ${oreKey}`);
  check("smelter melt leaf keys bare", MT.composeTaskKey(smelter[0], null) === "t:MeltMetalObject");
  check("smelter reaction leaf keys by code",
    MT.composeTaskKey(smelter[2], null) === "t:CustomReaction|rc:BRASS_MAKING");

  // Craftsdwarf: MIXED root -- material selectors (containers), direct leaves, custom categories.
  const craft = [
    { kind: "material_selector", label: "rock", matType: 0, matIndex: -1, leaves: [
      { kind: "job", label: "Make rock crafts", jobType: "MakeCrafts" },
      { kind: "job", label: "Make rock short sword", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 3 },
    ] },
    { kind: "job", label: "Make totem", jobType: "MakeTotem" },
    { kind: "custom_category", label: "Make instrument piece", token: "INSTRUMENT_PIECE", leaves: [
      { kind: "reaction", label: "Forge madush case", reactionCode: "MAKE_ENT305 INK1_BODY" } ] },
  ];
  check("craftsdwarf mixed root is a menu tree", MT.isMenuTree(craft) === true);
  check("craftsdwarf material selector is a container", MT.rowIsContainer(craft[0]) === true);
  check("craftsdwarf direct leaf is not a container", MT.rowIsContainer(craft[1]) === false);
  check("craftsdwarf custom category is a container", MT.rowIsContainer(craft[2]) === true);
  check("selector row label gets (opens menu)", MT.categoryRowLabel(craft[0]) === "rock (opens menu)");
  // drill into the rock selector -> its leaves, node carries the material pin
  const rockLevel = MT.levelAt(craft, [0]);
  check("[0] rock selector -> level 2 leaves", rockLevel.level === 2 && rockLevel.rows.length === 2 &&
    rockLevel.node === craft[0]);
  // a rock leaf inherits the selector's material pin (mat:0:-1) -- the queue-path material carry
  const rockKey = MT.composeTaskKey(rockLevel.rows[1], rockLevel.node);
  check("rock submenu leaf carries selector's material pin",
    rockKey === "t:MakeWeapon|it:WEAPON|st:3|mat:0:-1", `got ${rockKey}`);
  const rockCraftKey = MT.composeTaskKey(rockLevel.rows[0], rockLevel.node);
  check("rock crafts leaf carries the rock pin", rockCraftKey === "t:MakeCrafts|mat:0:-1", `got ${rockCraftKey}`);
  // the direct root leaf (Make totem) keys with no material pin
  check("craftsdwarf direct leaf keys bare", MT.composeTaskKey(craft[1], null) === "t:MakeTotem");

  // material_category discriminates same-job organic leaves (Make cloth crafts vs Make silk crafts),
  // which otherwise collide on "t:MakeCrafts" and would queue the wrong material.
  const clothCrafts = { kind: "job", label: "Make cloth crafts", jobType: "MakeCrafts", materialCategory: "cloth" };
  const silkCrafts = { kind: "job", label: "Make silk crafts", jobType: "MakeCrafts", materialCategory: "silk" };
  const ck1 = MT.composeTaskKey(clothCrafts, null), ck2 = MT.composeTaskKey(silkCrafts, null);
  check("cloth crafts keys with its category", ck1 === "t:MakeCrafts|cat:cloth", `got ${ck1}`);
  check("silk crafts keys distinctly (no collision)", ck2 === "t:MakeCrafts|cat:silk" && ck1 !== ck2);
  check("cat round-trips", parseTreeTaskKey(ck2).materialCategory === "silk");
}

// ==============================================================================================
console.log("RULE-3 test-the-test (seeded-bad MUST be rejected):");
// A leaf with no jobType AND no reactionCode is unqueueable -> composeTaskKey must return null.
check("malformed leaf (no job/rc) -> null key", MT.composeTaskKey({ kind: "job", label: "broken" }, { matType: 0, matIndex: 0 }) === null);
check("null leaf -> null key", MT.composeTaskKey(null, null) === null);
// A reaction leaf missing its code cannot be queued.
check("reaction w/o code -> null key", MT.composeTaskKey({ kind: "reaction", label: "x" }, null) === null);
// Prove the grammar MIRROR itself discriminates: a corrupted key must NOT round-trip to the same fields.
{
  const good = MT.composeTaskKey({ jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 1 }, { matType: 0, matIndex: 0 });
  const corrupted = good.replace("mat:0:0", "mat:0:9");        // wrong metal index
  const p = parseTreeTaskKey(corrupted);
  check("mirror catches corrupted metal index", p.matIndex === 9 && p.matIndex !== 0);
  const dropped = good.replace("|mat:0:0", "");                 // dropped metal pin
  check("mirror catches dropped metal pin", parseTreeTaskKey(dropped).matIndex === undefined);
}

// ==============================================================================================
// B144: "make X" item lists sort alphabetically. Native keeps raw order ("Forge twenty-five
// iron bolts" LAST in the metalsmithing oracle screenshots) -- the word wins for item rows;
// navigation rows (categories / metals / selectors) keep native order.
console.log("B144 alphabetical make-X ordering:");
{
  // SEEDED-BAD leaf list: deliberately unsorted, native-flavored (bolts last, axe not first).
  const unsortedLeaves = [
    { kind: "job", label: "Forge iron pick", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 2 },
    { kind: "job", label: "Forge iron battle axe", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 1 },
    { kind: "job", label: "Forge iron war hammer", jobType: "MakeWeapon", itemType: "WEAPON", itemSubtype: 4 },
    { kind: "job", label: "Forge twenty-five iron bolts", jobType: "MakeAmmo", itemType: "AMMO", itemSubtype: 0, batch: 25 },
    { kind: "job", label: "Forge iron crossbow", jobType: "MakeCrossbow", itemType: "WEAPON", itemSubtype: 8 },
  ];
  // test-the-test: prove the seed really is unsorted (a sorted seed would pass vacuously).
  const labels = rows => rows.map(r => String(r.node.label));
  const seedLabels = unsortedLeaves.map(l => l.label.toLowerCase());
  check("(test-the-test) seeded leaf list is NOT already alphabetical",
    JSON.stringify(seedLabels) !== JSON.stringify([...seedLabels].sort()));
  const ordered = MT.orderRowsAlpha(unsortedLeaves);
  check("leaf rows come back A->Z", JSON.stringify(labels(ordered)) === JSON.stringify([
    "Forge iron battle axe", "Forge iron crossbow", "Forge iron pick",
    "Forge iron war hammer", "Forge twenty-five iron bolts"]), `got ${labels(ordered).join(" | ")}`);
  check("ordering DIFFERS from the seeded-bad input (helper discriminates)",
    JSON.stringify(labels(ordered)) !== JSON.stringify(unsortedLeaves.map(l => l.label)));
  check("original indices survive reordering (drill attributes stay valid)",
    ordered.every(r => unsortedLeaves[r.idx] === r.node));
  check("input array is untouched (pure)", unsortedLeaves[0].label === "Forge iron pick");

  // Mixed root (Craftsdwarf shape): containers keep native order FIRST, leaves follow A->Z.
  const mixedRoot = [
    { kind: "job", label: "Make totem", jobType: "MakeTotem" },
    { kind: "material_selector", label: "rock", matType: 0, matIndex: -1, leaves: [
      { kind: "job", label: "Make rock crafts", jobType: "MakeCrafts" } ] },
    { kind: "job", label: "Make bone crafts", jobType: "MakeCrafts", materialCategory: "bone" },
    { kind: "material_selector", label: "wood", matType: -1, matIndex: -1, leaves: [
      { kind: "job", label: "Make wood crafts", jobType: "MakeCrafts" } ] },
  ];
  const mixed = MT.orderRowsAlpha(mixedRoot);
  check("containers first, in NATIVE order (rock before wood, never alphabetized against leaves)",
    mixed[0].node.label === "rock" && mixed[1].node.label === "wood");
  check("root leaves follow, A->Z", mixed[2].node.label === "Make bone crafts" && mixed[3].node.label === "Make totem");
  check("mixed indices address the served tree", mixed.every(r => mixedRoot[r.idx] === r.node));

  // Flat picker: SEEDED-BAD unsorted names + interleaved groups. Group order = first appearance;
  // names A->Z within each group; groups become contiguous (no duplicate headers).
  const unsortedTasks = [
    { key: "k3", name: "Make wooden shield", group: "Common" },
    { key: "k1", name: "Construct bed", group: "Common" },
    { key: "r1", name: "assemble akith", group: "Instruments" },
    { key: "k2", name: "Make wooden cage", group: "Common" },   // interleaved: Common resumes
    { key: "r2", name: "Make shosel bow", group: "Instruments" },
  ];
  check("(test-the-test) seeded task list is NOT already alphabetical-within-group",
    unsortedTasks[0].name !== "Construct bed");
  const sorted = MT.sortTasksAlpha(unsortedTasks);
  check("groups keep first-appearance order and become contiguous",
    JSON.stringify(sorted.map(t => t.group)) ===
    JSON.stringify(["Common", "Common", "Common", "Instruments", "Instruments"]));
  check("names sort A->Z within each group (case-insensitive)",
    JSON.stringify(sorted.map(t => t.key)) === JSON.stringify(["k1", "k2", "k3", "r1", "r2"]),
    `got ${sorted.map(t => t.key).join(",")}`);
  check("sortTasksAlpha is pure (input order untouched)", unsortedTasks[0].key === "k3");
  check("defensive: non-array -> empty", Array.isArray(MT.sortTasksAlpha(null)) && MT.sortTasksAlpha(null).length === 0);
}

// ==============================================================================================
// B155: dfhack.workshops.getJobs omits every MakeTool row from the carpenter. The served flat-task
// supplement is entity-derived; the forge tree already carries the same tool subtypes per metal.
console.log("B155 MakeTool served-tree coverage:");
{
  // Live itemdef_tool/entity oracle, 2026-07-10. NO_DEFAULT_JOB tools (scroll, quire, display case)
  // are deliberately absent. Subtype numbers pin the real vanilla itemdef_tool order.
  const tools = [
    [10, "nest box"], [11, "jug"], [12, "pot"], [13, "hive"],
    [16, "minecart"], [17, "wheelbarrow"], [18, "stepladder"],
    [19, "scroll rollers"], [20, "book binding"], [23, "bookcase"],
    [26, "pedestal"], [28, "altar"], [29, "die"],
  ];
  const carpenterServed = tools.map(([subtype, name], i) => ({
    key: `d${i + 1}`, name: `make wooden ${name}`, job: "MakeTool", reaction: "",
    group: "Tools", pri: 10,
    orderKey: `j:MakeTool|it:TOOL|st:${subtype}|cat:wood`,
  }));
  // /workshop-info.orderTasks is the shared legal-order projection used by the workshop's
  // "Add shop work order" picker. It is separate from direct Tasks because forge rows expand
  // once per concrete metal.
  const shopOrderServed = carpenterServed.map(t => ({
    key: t.orderKey, name: t.name, orderKey: t.orderKey,
  }));
  // /order-catalog-shops is the fort-wide New work order source (B165 screenshot surface).
  const fortCarpenterServed = shopOrderServed.map(t => ({ key: t.key, label: t.name }));
  const forgeServed = [{ kind: "category", label: "Other objects", metals: [{
    kind: "material", label: "iron", matType: 0, matIndex: 0,
    leaves: tools.map(([subtype, name]) => ({
      kind: "job", label: `Forge iron ${name}`, jobType: "MakeTool",
      itemType: "TOOL", itemSubtype: subtype,
    })),
  }]}];
  const missingCarpenter = rows => tools.filter(([, name]) =>
    !rows.some(r => r.job === "MakeTool" && r.name === `make wooden ${name}`));
  const missingOrderSurface = rows => tools.filter(([subtype, name]) =>
    !rows.some(r => (r.name || r.label) === `make wooden ${name}` &&
      (r.orderKey || r.key) === `j:MakeTool|it:TOOL|st:${subtype}|cat:wood`));
  const forgeLeaves = forgeServed[0].metals[0].leaves;
  const forgeOrderServed = tools.map(([subtype, name]) => ({
    key: `j:MakeTool|it:TOOL|st:${subtype}|mat:0:0`,
    name: `forge iron ${name}`,
    orderKey: `j:MakeTool|it:TOOL|st:${subtype}|mat:0:0`,
  }));
  const missingForge = rows => tools.filter(([subtype, name]) =>
    !rows.some(r => r.jobType === "MakeTool" && r.itemType === "TOOL" &&
      r.itemSubtype === subtype && r.label === `Forge iron ${name}`));
  const missingForgeOrder = rows => tools.filter(([subtype, name]) =>
    !rows.some(r => (r.name || r.label) === `forge iron ${name}` &&
      (r.orderKey || r.key) === `j:MakeTool|it:TOOL|st:${subtype}|mat:0:0`));

  for (const [, name] of tools) {
    check(`carpenter serves Make wooden ${name}`, carpenterServed.some(r =>
      r.job === "MakeTool" && r.name === `make wooden ${name}`));
  }
  check("workshop Add shop work order serves all 13 typed/material-pinned tools",
    missingOrderSurface(shopOrderServed).length === 0);
  check("fort-wide New work order serves all 13 typed/material-pinned carpenter tools",
    missingOrderSurface(fortCarpenterServed).length === 0);
  check("forge serves the same 13 tool subtypes in metal", missingForge(forgeLeaves).length === 0);
  check("forge Add shop work order serves all 13 subtype + concrete-metal tools",
    missingForgeOrder(forgeOrderServed).length === 0);
  check("fort-wide New work order serves all 13 subtype + concrete-metal forge tools",
    missingForgeOrder(forgeOrderServed).length === 0);
  check("wheelbarrow queues as MakeTool/TOOL subtype 17 with an iron material pin",
    MT.composeTaskKey(forgeLeaves.find(l => l.itemSubtype === 17), forgeServed[0].metals[0]) ===
      "t:MakeTool|it:TOOL|st:17|mat:0:0");
  check("NO_DEFAULT_JOB tools stay absent",
    ![...carpenterServed.map(r => r.name), ...forgeLeaves.map(r => r.label)]
      .some(s => /\b(scroll|quire|display case)$/.test(s)));

  // Test-the-test: removing wheelbarrow recreates the exact failure and must be detected.
  const seededBadDirect = carpenterServed.filter(r => r.name !== "make wooden wheelbarrow");
  const seededBadShopOrder = shopOrderServed.map(r => r.name === "make wooden wheelbarrow"
    ? { ...r, orderKey: "j:MakeTool|cat:wood" } : r);
  const seededBadFort = fortCarpenterServed.filter(r => r.label !== "make wooden wheelbarrow");
  const seededBadForgeOrder = forgeOrderServed.map(r => r.name === "forge iron wheelbarrow"
    ? { ...r, key: "j:MakeTool|it:TOOL|st:17", orderKey: "j:MakeTool|it:TOOL|st:17" } : r);
  check("(test-the-test) seeded-bad direct Tasks tree is rejected for missing wheelbarrow",
    missingCarpenter(seededBadDirect).some(([, name]) => name === "wheelbarrow"));
  check("(test-the-test) seeded-bad shop-order tree rejects an untyped wheelbarrow key",
    missingOrderSurface(seededBadShopOrder).some(([, name]) => name === "wheelbarrow"));
  check("(test-the-test) seeded-bad fort-wide tree is rejected for missing wheelbarrow",
    missingOrderSurface(seededBadFort).some(([, name]) => name === "wheelbarrow"));
  check("(test-the-test) seeded-bad forge order tree rejects wheelbarrow without a metal pin",
    missingForgeOrder(seededBadForgeOrder).some(([, name]) => name === "wheelbarrow"));

  const luaSource = fs.readFileSync(path.join(ROOT, "dwf.lua"), "utf8");
  check("fort-wide catalog consumes the shared entity-derived job source",
    /local dynamic = dynamic_shop_jobs\(spec\[2\]\)/.test(luaSource));
  check("both order surfaces consume the shared legal-order expander",
    // B261: the per-shop projection was extracted into order_spec_entries (the single place the
    // order gates + order_entries_for_defs are applied); BOTH the by-shop picker and the fort-wide
    // catalog now derive from it, so neither can be a parallel hand list.
    /function shop_order_tasks\(defs\)[\s\S]*?order_entries_for_defs\(defs, forge_metals\(\)\)/.test(luaSource) &&
    /function order_spec_entries\(spec, wo, metals\)[\s\S]*?order_entries_for_defs\(defs, metals\)/.test(luaSource) &&
    /function order_catalog_by_shop\(\)[\s\S]*?order_spec_entries\(spec, wo, metals\)/.test(luaSource) &&
    /function order_catalog\(\)[\s\S]*?order_spec_entries\(spec, wo, metals\)/.test(luaSource));
  check("manager-order parser carries item type/subtype into the real order definition",
    /if item_type_val ~= nil then def\.item_type = df\.item_type\[item_type_val\] end/.test(luaSource) &&
    /if item_subtype ~= nil then def\.item_subtype = item_subtype end/.test(luaSource));
}

// ==============================================================================================
// B156: unresolved work-order jobs really carry mat_type=-1. DFHack's generic namer returns
// "Make unknown material X"; the workshop Tasks formatter must omit only that placeholder.
console.log("B156 unresolved-material workshop task labels:");
{
  const stripUnknownMaterial = name => String(name)
    .replace(/\s+of unknown material/g, "")
    .replace(/unknown material\s+/g, "")
    .replace(/\s+/g, " ").trim();
  const liveAnyMaterialJobs = [
    { matType: -1, raw: "Make unknown material barrel", expected: "Make barrel" },
    { matType: -1, raw: "Make unknown material bin", expected: "Make bin" },
    { matType: -1, raw: "Polish object of unknown material", expected: "Polish object" },
  ];
  check("every mat_type=-1 fixture renders without 'unknown material'",
    liveAnyMaterialJobs.every(j => j.matType === -1 && stripUnknownMaterial(j.raw) === j.expected &&
      !stripUnknownMaterial(j.raw).includes("unknown material")));
  check("(test-the-test) seeded-bad raw namer output still contains the rejected placeholder",
    liveAnyMaterialJobs.some(j => j.raw.includes("unknown material")));

  const luaSource = fs.readFileSync(path.join(ROOT, "dwf.lua"), "utf8");
  // B260 re-pointed these two at the post-oracle shape. The INTENT is unchanged and still enforced:
  // (1) the carpenter's tools come from the fort ENTITY's tool_type vector against a wood-log
  // reagent -- never a hand-written list; (2) NO_DEFAULT_JOB tools stay out (that exclusion is what
  // drops the generated instrument-piece tools).
  // STRENGTHENED: the filter is now `carpenter_tool`, which additionally requires the itemdef's
  // [FURNITURE] token. WS-CARPENTERS-native-{1,2,3}of3.png shows NO wooden jug / pot / hive / nest
  // box / die / scroll rollers / book binding at the carpenter -- the old `default_tool` filter
  // offered all of them. Those are craftsdwarf rows (non-FURNITURE), and the craftsdwarf's own wood
  // submenu carries exactly them.
  check("server carpenter supplement enumerates entity tool_type with wood-log reagents",
    /elseif is_carpenter then[\s\S]*?enum_entity_defs\(defs, 'Tools', 13, 'Make wooden', df\.job_type\.MakeTool,[\s\S]*?df\.item_type\.TOOL, R\.tool_type, IT\.tools, WOODLOG_REAGENT, carpenter_tool, 'wood'\)/.test(luaSource));
  check("server excludes NO_DEFAULT_JOB tools from the carpenter supplement",
    /local function tool_default\(d\) return not tool_flag\(d, 'NO_DEFAULT_JOB'\) end/.test(luaSource) &&
    /local function carpenter_tool\(d\)[\s\S]*?tool_default\(d\)[\s\S]*?tool_flag\(d, 'FURNITURE'\)/.test(luaSource));
  check("server keeps the carpenter's tool block to FURNITURE tools only (B260 oracle)",
    /local function craftsdwarf_tool\(d\)[\s\S]*?not tool_flag\(d, 'FURNITURE'\)/.test(luaSource));
  check("server workshop job formatter applies the generic placeholder stripper",
    /function job_label\(job\)[\s\S]*?dfhack\.job\.getName[\s\S]*?return strip_unknown_material\(name\)/.test(luaSource));
}

// ==============================================================================================
console.log(`\n${failed ? "FAIL" : "PASS"} truemenu_client_test -- ${failed} failed`);
process.exit(failed ? 1 : 0);
