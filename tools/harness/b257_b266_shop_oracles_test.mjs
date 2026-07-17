// b257_b266_shop_oracles_test.mjs -- B257/B258/B259/B260/B264/B265/B266.
//
//   node tools/harness/b257_b266_shop_oracles_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// GROUND TRUTH: the 30 native workshop captures in evidence/oracles/workshops/ (see
// evidence/oracles/workshops/MANIFEST.md and the row-by-row transcription in
// docs/superpowers/analysis/2026-07-14-workshop-oracle-transcription.md).
//
// THE RULE THIS WAVE ENFORCES: every workshop job list is rebuilt VERBATIM from its capture. No row
// is invented. B255 proved what invention costs -- the bowyer was offering bolts it cannot make and
// the craftsdwarf was missing bolts, cups and its whole tool block.
//
// SOURCE-TIE test (the offline sweep has no live DF). Every assertion encodes the post-fix state and
// FAILS against pre-fix main.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const lua = fs.readFileSync(path.join(root, "dwf.lua"), "utf8");
const model = fs.readFileSync(path.join(root, "tools/harness/menu_model.lua"), "utf8");
const client = fs.readFileSync(
  path.join(root, "web/js/dwf-building-zone-stockpile-panels.js"), "utf8");

let passed = 0, failed = 0;
function check(fn, name) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { failed++; console.log(`  FAIL - ${name}: ${err.message}`); }
}
// Slice a lua table literal `local NAME = {` ... up to the matching close at column 0.
function sliceTable(src, header) {
  const at = src.indexOf(header);
  if (at === -1) return "";          // absent (e.g. pre-fix main) -> every check reports, none crash
  const rest = src.slice(at);
  const m = rest.match(/\n\}/);
  if (!m) return "";
  return rest.slice(0, m.index + 2);
}
// Same, for a `[local ]function NAME(` body up to the first column-0 `end`. Returns "" when absent,
// so a pre-fix tree reports every failure instead of crashing on the first missing symbol.
function sliceFn(src, header) {
  const at = src.indexOf(header);
  if (at === -1) return "";
  const rest = src.slice(at);
  const m = rest.match(/\nend\b/);
  if (!m) return "";
  return rest.slice(0, m.index + m[0].length);
}
// Assert the quoted labels appear in exactly this relative order (DF's alphabetical order).
function assertOrder(block, labels, what) {
  let cursor = -1, prev = null;
  for (const label of labels) {
    const at = block.indexOf(`'${label}'`);
    assert.notEqual(at, -1, `${what}: native row missing -- "${label}"`);
    assert.ok(at > cursor, `${what}: out of native order -- "${label}" must follow "${prev}"`);
    cursor = at; prev = label;
  }
}

// ---------------------------------------------------------------------------------------------
console.log("# B264 -- craftsdwarf WOOD: the invented 'wooden toy' row is gone");
const woodSeq = sliceTable(lua, "local CD_WOOD_SEQ = {");
check(() => {
  assert.doesNotMatch(woodSeq, /Make wooden toy/,
    "CD_WOOD_SEQ still carries 'Make wooden toy' -- WS-CRAFTSDWARF-WOOD-native-FULL.png is the " +
    "COMPLETE list (it fits one screen) and has no such row. B255 guessed it sat below the fold.");
  assert.doesNotMatch(sliceTable(model, "local ND_WOOD = {"), /Make wooden toy/,
    "menu_model.lua still carries the wooden toy -- the model and the server would disagree");
}, "'Make wooden toy' is deleted from BOTH dwf.lua and menu_model.lua");
check(() => {
  assert.match(woodSeq, /\{ 'AMMO' \}/, "the wood submenu lost its bolts row (B255)");
  assertOrder(woodSeq, ["Make large wooden gem", "Make three wooden cups"], "wood");
}, "the wood submenu still carries its captured bolts + cups rows");

console.log("# B264 -- craftsdwarf ROCK: same 19 rows, now in DF's alphabetical order");
const rockSeq = sliceTable(lua, "local CD_ROCK_SEQ = {");
check(() => {
  assertOrder(rockSeq, [
    "Make large rock gem", "Make rock amulet", "Make rock book binding", "Make rock bracelet",
    "Make rock crafts", "Make rock crown", "Make rock die", "Make rock earring",
    "Make rock figurine", "Make rock hive", "Make rock jug", "Make rock nest box", "Make rock pot",
    "Make rock ring", "Make rock scepter", "Make rock scroll rollers", "Make rock short sword",
    "Make rock toy", "Make three rock mugs",
  ], "rock");
}, "CD_ROCK_SEQ is in the capture's order (WS-CRAFTSDWARF-ROCK-native-{1,2}of2.png)");

console.log("# B264 -- craftsdwarf BONE + SHELL: verbatim, replacing the guessed 8-row set");
const boneSeq = sliceTable(lua, "local CD_BONE_SEQ = {");
const shellSeq = sliceTable(lua, "local CD_SHELL_SEQ = {");
check(() => {
  assertOrder(boneSeq, [
    "Decorate with bone", "Make bone amulet", "Make bone bracelet", "Make bone crafts",
    "Make bone crown", "Make bone earring", "Make bone figurine", "Make bone greaves",
    "Make bone helm", "Make bone leggings", "Make bone ring", "Make bone scepter",
  ], "bone");
  assert.match(boneSeq, /\{ 'AMMO' \}/, "the bone submenu lost its 'Make five bone bolts' row");
  assertOrder(boneSeq, ["Make large bone gem", "Make pair of bone gauntlets"], "bone tail");
}, "BONE = 15 captured rows incl. Decorate-with, the armour block and the bolts (WS-CRAFTSDWARF-BONE)");
check(() => {
  assertOrder(shellSeq, [
    "Decorate with shell", "Make large shell gem", "Make pair of shell gauntlets",
    "Make shell amulet", "Make shell bracelet", "Make shell crafts", "Make shell crown",
    "Make shell earring", "Make shell figurine", "Make shell helm", "Make shell leggings",
    "Make shell ring",
  ], "shell");
  assert.doesNotMatch(shellSeq, /AMMO/,
    "the shell submenu offers ammo -- WS-CRAFTSDWARF-SHELL-native.png has NO ammo at all");
  assert.doesNotMatch(shellSeq, /scepter/, "shell has no scepter in the capture");
  assert.doesNotMatch(shellSeq, /greaves/, "shell has no greaves in the capture");
}, "SHELL = 12 captured rows, and SHELL HAS NO AMMO");

console.log("# B264/B266 -- the craftsdwarf root: containers first, then ONE alphabetical block");
check(() => {
  const fn = lua.slice(lua.indexOf("local function craftsdwarf_tree(bt, st)"));
  const body = fn.slice(0, fn.indexOf("\nend"));
  assert.match(body, /cd_alpha_sort\(leaves\)/,
    "craftsdwarf_tree still emits its leaves in SOURCE order -- DF sorts every menu alphabetically");
  const sel = body.indexOf("material_selector");
  const leafBlock = body.indexOf("Decorate with ");
  assert.ok(sel !== -1 && sel < leafBlock, "the material selectors must lead the root");
}, "craftsdwarf_tree sorts its root leaves (dwf.lua)");
check(() => {
  const fn = model.slice(model.indexOf("local function craftsdwarf_native(bt, st)"));
  assert.match(fn.slice(0, fn.indexOf("\nend")), /alpha_sort\(leaves\)/,
    "menu_model.lua's craftsdwarf root is unsorted -- gate_truemenu would grade the served tree " +
    "against a stale model and call this wave's fix a regression (B255 hit exactly this)");
}, "menu_model.lua mirrors the sorted root");

// ---------------------------------------------------------------------------------------------
console.log("# B257 -- the Farmer's Workshop ships NINE rows, not zero");
const extra = lua.slice(lua.indexOf("local EXTRA_SHOP_JOBS = {"), lua.indexOf("-- B01-residue: forge / carpenter"));
check(() => {
  for (const [label, jt] of [
    ["Make cheese", "MakeCheese"], ["Milk animal", "MilkCreature"],
    ["Process plants", "ProcessPlants"], ["Process plants (barrel)", "ProcessPlantsBarrel"],
    ["Process plants (vial)", "ProcessPlantsVial"], ["Shear animal", "ShearCreature"],
    ["Spin thread", "SpinThread"],
  ]) {
    assert.match(extra, new RegExp(`Farmers[\\s\\S]*'${label.replace(/[()]/g, "\\$&")}'`),
      `the farmer's is missing the native row "${label}"`);
    assert.match(extra, new RegExp(`'${jt}'`), `the farmer's row "${label}" has no ${jt} job`);
  }
  assert.match(extra, /Farmers = \{/, "EXTRA_SHOP_JOBS has no Farmers block at all");
}, "all 7 missing farmer's jobs are present (the other 2 native rows are the raws reactions)");

console.log("# B258 -- the Quern can Mill plants (the building's entire purpose)");
check(() => {
  assert.match(extra, /Quern = \{[\s\S]*?'Mill plants'[\s\S]*?MillPlants/,
    "the quern still cannot mill plants");
}, "Quern offers 'Mill plants'");

console.log("# B259 -- the Ashery makes lye and potash");
check(() => {
  assert.match(extra, /Ashery = \{[\s\S]*?'Make lye'[\s\S]*?MakeLye/, "no 'Make lye'");
  assert.match(extra, /'Make potash from ash'[\s\S]*?MakePotashFromAsh/, "no 'Make potash from ash'");
  assert.match(extra, /'Make potash from lye'[\s\S]*?MakePotashFromLye/, "no 'Make potash from lye'");
}, "Ashery offers lye + both potash jobs (milk-of-lime was all we shipped)");

// ---------------------------------------------------------------------------------------------
console.log("# B260 -- the tool split: [FURNITURE] is what separates carpenter/mason/craftsdwarf");
check(() => {
  assert.match(lua, /local function carpenter_tool\(d\)[\s\S]*?tool_flag\(d, 'FURNITURE'\)/,
    "no FURNITURE gate on the carpenter's tools");
  assert.match(lua, /local function mason_tool\(d\)[\s\S]*?tool_flag\(d, 'FURNITURE'\)[\s\S]*?tool_flag\(d, 'HARD_MAT'\)/,
    "no FURNITURE+HARD_MAT gate on the mason's tools");
  assert.match(lua, /local function craftsdwarf_tool\(d\)[\s\S]*?not tool_flag\(d, 'FURNITURE'\)/,
    "the craftsdwarf's tools must be the NON-furniture ones");
}, "the three tool filters exist and are gated on the itemdef's FURNITURE token");
check(() => {
  const dyn = lua.slice(lua.indexOf("function dynamic_shop_jobs(b)"));
  const body = dyn.slice(0, dyn.indexOf("\nend"));
  const arm = body.slice(body.indexOf("elseif is_carpenter then"), body.indexOf("elseif is_mason then"));
  assert.match(arm, /carpenter_tool/,
    "the carpenter still takes EVERY non-NO_DEFAULT_JOB tool -- that is what put wooden jugs, " +
    "pots, hives and nest boxes on a shop whose capture shows none of them");
  assert.doesNotMatch(arm, /default_tool/, "the old permissive tool filter is still in use");
  assert.match(arm, /MakeShield/, "the carpenter makes no shields/bucklers");
  assert.match(arm, /TRAINING/, "the carpenter makes no training weapons");
}, "the carpenter's arm: FURNITURE tools + shields + training weapons (B260)");
check(() => {
  assert.match(lua, /local is_mason\s+= \(key == 'Masons'\)/, "dynamic_shop_jobs does not know the mason");
  assert.match(lua, /local is_leatherworks = \(key == 'Leatherworks'\)/,
    "dynamic_shop_jobs does not know the leatherworks");
}, "the mason and the leatherworks are recognised at all");
check(() => {
  const body = sliceFn(lua, "function dynamic_shop_jobs(b)");
  const li = body.indexOf("elseif is_leatherworks then"), bi = body.indexOf("elseif is_bowyer then");
  assert.ok(li !== -1 && bi > li, "dynamic_shop_jobs has no leatherworks arm");
  const arm = body.slice(li, bi);
  for (const jt of ["MakeArmor", "MakeHelm", "MakePants", "MakeGloves", "MakeShoes", "MakeShield"]) {
    assert.match(arm, new RegExp(jt), `the leatherworks cannot make ${jt} -- we shipped 5 of 25 rows`);
  }
  assert.match(arm, /is_leather_clothing/, "the leather line must be gated on the [LEATHER] props flag");
  assert.match(arm, /pair_namer\('Make', 'leather'\)/,
    "native reads 'Make pair of leather gloves' / 'high boots' -- the pair form is missing");
}, "the leatherworks serves the whole [LEATHER] armour line (B260)");

// ---------------------------------------------------------------------------------------------
console.log("# B266 -- the Clothier's is a THREE-SUBMENU tree, not a flat list");
check(() => {
  assert.match(lua, /local function clothier_tree\(b\)/, "there is no clothier tree at all");
  assert.match(lua, /if k == 'Clothiers' then return clothier_tree\(b\) end/,
    "the clothier still serves entity_flat_tree -- the wrong SHAPE, not just the wrong rows");
  assert.match(lua, /local CLOTHIER_MATS = \{[\s\S]*?word = 'cloth'[\s\S]*?word = 'silk'[\s\S]*?word = 'yarn'/,
    "the clothier has no cloth/silk/yarn split");
}, "clothier_tree exists and is what native_build_tree dispatches to");
check(() => {
  const fn = lua.slice(lua.indexOf("local function clothier_tree(b)"));
  const body = fn.slice(0, fn.indexOf("\nend"));
  assert.match(body, /kind = 'material_selector'/,
    "the clothier's three rows must be submenu containers -- the client renders those '(opens menu)'");
}, "each clothier material is a material_selector -> the client prints '(opens menu)' (B266)");
check(() => {
  const body = sliceFn(lua, "function dynamic_shop_jobs(b)");
  const arm = body.slice(body.indexOf("elseif is_clothier then"));
  assert.match(arm, /is_soft_clothing/, "the clothing line must be gated on the [SOFT] props flag");
  assert.doesNotMatch(arm.slice(0, arm.indexOf("\n    end")), /'sew'/,
    "the old 'sew <item>' verb is still in use -- native says 'Make cloth cap'");
  assert.match(arm, /' bag'/, "no bag row");
  assert.match(arm, /' rope'/, "no rope row");
  assert.match(arm, /'Sew ' \.\. m\.word \.\. ' image'/, "no Sew-<mat>-image row");
}, "each clothier submenu carries the captured 16 rows (SOFT armour + bag + rope + sew image)");

// ---------------------------------------------------------------------------------------------
console.log("# B265 -- DF LISTS an unrunnable job, reds it, and prints the reason underneath");
check(() => {
  assert.match(lua, /local function reagent_desc\(rg, P\)/,
    "there is no reagent-description composer -- we can name no requirement at all");
  assert.match(lua, /local RX_CLASS_ADJ = \{[\s\S]*?PAPER_PLANT = 'paper-making'/,
    "the capture-pinned reaction_class adjectives are missing");
  assert.match(lua, /RENDER_MAT = 'renderable'/, "the RENDER_MAT adjective is missing");
  assert.match(lua, /BOX = 'bag'/, "DF prints 'bag' for a BOX reagent ('[Requires Empty bag]')");
}, "the requirement grammar exists, and its non-derivable adjectives are capture-pinned");
check(() => {
  assert.match(lua, /local function reagent_present\(rg, P\)/, "no general presence check");
  assert.match(lua, /P\.itype_sub\[/,
    "presence must index item subtypes -- '[Requires Scroll rollers]' is a TOOL subtype");
  const fn = lua.slice(lua.indexOf("local function build_presence()"));
  assert.match(fn.slice(0, fn.indexOf("\nend")), /P\.itype\[ity\] = true/,
    "build_presence still indexes only bars/boulders/threads, so it can never see a bag or a sheet");
}, "build_presence indexes every item type + subtype (one pass, same serve budget)");
check(() => {
  const rc = lua.slice(lua.indexOf("local function reagent_check(rg, P)"));
  const body = rc.slice(0, rc.indexOf("\nend"));
  assert.match(body, /reagent_desc\(rg, P\)/,
    "reagent_check still returns nil for globs/plants/bags/sheets/windows -- i.e. for exactly the " +
    "nine RED rows in the captures");
}, "reagent_check no longer skips the reagents DF actually objects about");
check(() => {
  assert.match(lua, /function annotate_flat_avail\(tasks\)/,
    "the flat shops (farmer's, quern, ashery, kitchen, carpenter) get no accurate objection at all");
  assert.match(lua, /annotate_flat_avail\(tasks\)/, "workshop_info never calls annotate_flat_avail");
  // B274: the crude guess is GONE ENTIRELY now, not merely fenced off from reaction rows.
  const st = sliceFn(lua, "function shop_tasks(b, defs)");
  assert.doesNotMatch(st, /item_buildable\(item\) and item_matches_filter/,
    "shop_tasks still runs its crude per-def IN_PLAY objection guess -- see the B274 block below");
}, "the flat task list is annotated by the shared reaction-objection engine");

// =================================================================================================
// B274 -- our Still told the owner the exact OPPOSITE of the truth. He HAS plants and has NO fruit; we showed
// `Brew drink from fruit` as doable and `Brew drink from plant` as RED "[Requires materials]".
// Oracle (OURS, broken -- not native): evidence/oracles/workshops/WS-STILL-OURS-broken-requires.png
// =================================================================================================
console.log("# B274 -- the [Requires materials] placeholder + the inverted/fail-closed red state");
check(() => {
  assert.doesNotMatch(lua, /or 'materials'/,
    "`[Requires materials]` is a string DF NEVER prints. The crude per-def IN_PLAY scan in shop_tasks " +
    "was its ONLY producer anywhere in the codebase -- a fabricated reason on a fabricated red state.");
  assert.doesNotMatch(lua, /objection = '\[Requires ' \.\. req \.\. '\]'/,
    "the hand-written 3-way reason (wood/boulders/metal bars/materials) must be gone");
}, "the fabricated `[Requires materials]` reason has no producer left");
check(() => {
  const st = sliceFn(lua, "function shop_tasks(b, defs)");
  assert.doesNotMatch(st, /item_buildable\(item\) and item_matches_filter\(filter, item\)/,
    "THE SERIOUS HALF: the crude test could FAIL CLOSED -- item_matches_filter cannot model the " +
    "Still's `barrel/pot` reagent (item_type NONE + EMPTY + FOOD_STORAGE_CONTAINER), so it never " +
    "matched and the row went red while the job was perfectly queueable. Marking a doable job as " +
    "blocked is worse than showing nothing: the player trusts it and never queues the job.");
  assert.match(st, /local avail, objection = true, ''/,
    "a job row must default to WHITE -- in ALL 30 captures every RED row is a raws REACTION and NOT " +
    "ONE hardcoded-job row is red. Do not invent a red state that is not in a capture.");
}, "the fail-closed guess is deleted at the root, not special-cased for the Still");
check(() => {
  // The Still is reaction-driven: dfhack's getJobs has NO Still table at all, so all three rows are
  // raws reactions -- which means the B265 engine, not the deleted loop, must speak for them.
  assert.match(lua, /function annotate_flat_avail\(tasks\)/);
  assert.match(lua, /if r then t\.avail, t\.objection = reaction_objection\(r, P\) end/,
    "a reaction row's state must come from the reaction's OWN reagents (reagent_check/reagent_desc)");
  // The direction of error is now provably fail-OPEN and never fail-closed: reagent_present answers
  // false only when the fort holds NO item of that type -- a strict SUPERSET of DF's own condition,
  // so DF cannot be satisfied where we say it is not.
  const rp = sliceFn(lua, "local function reagent_present(rg, P)");
  assert.match(rp, /if ity == nil or ity < 0 then return nil end/,
    "an 'any item' reagent must be SKIPPED, not counted as absent -- that is precisely the Still's " +
    "barrel/pot reagent, and counting it as absent is what reded a doable job");
  assert.match(rp, /return P\.itype\[ity\] == true/);
}, "the reaction path is fail-open by construction (it cannot mark a doable job blocked)");

console.log("# THE ORDERING LAW -- a vanilla reaction interleaves; only MAKE_ENT is bucketed");
check(() => {
  const tg = sliceFn(lua, "function task_group(job_type, reaction)");
  assert.match(tg, /if reaction and reaction:match\('\^MAKE_ENT'\) then return 'Instruments', 91 end/,
    "B01's procedural-instrument bucket must survive -- that flood is what buried the useful jobs");
  assert.doesNotMatch(tg, /return 'Reactions', 90/,
    "vanilla reactions are still bucketed below the jobs at pri 90. DF interleaves them: the " +
    "ashery puts 'Make milk of lime' BETWEEN 'Make lye' and 'Make potash from ash', and the " +
    "farmer's interleaves its two reactions with its seven jobs. Bucketing exiles exactly the rows " +
    "B257/B258/B259 exist to surface.");
}, "task_group interleaves vanilla reactions and keeps MAKE_ENT pinned at 91");

// =================================================================================================
// PARITY REVIEW 2026-07-14 (D1-D7). An independent reviewer opened all 30 captures and diffed them
// against what this branch emits. Seven defects. Each block below FAILS against the pre-review tree.
// =================================================================================================

console.log("# D1 -- SIEGE: 21 native rows, per-metal, and no row native never shows");
check(() => {
  const body = sliceFn(lua, "function dynamic_shop_jobs(b)");
  const arm = body.slice(body.indexOf("elseif is_siege then"), body.indexOf("elseif is_bowyer then"));
  assert.ok(arm.length > 0, "dynamic_shop_jobs has no siege arm at all -- the shop was left on " +
    "dfhack's 4 generic rows despite having a 2-part capture");
  assert.match(arm, /'Assemble wooden ' \.\. nm/,
    "no wooden ballista arrow row (WOOD_TEMPLATE carries ITEMS_AMMO; native shows ONE wooden row)");
  assert.match(arm, /for _, m in ipairs\(ammo_metals\(\)\) do/,
    "no per-metal expansion -- WS-SIEGE-native-1of2.png shows one row per metal, exactly as the " +
    "forge already does with forge_metals()");
  assert.match(arm, /'Assemble ' \.\. m\.name \.\. ' ' \.\. nm/, "the per-metal label is not composed");
  assert.match(arm, /BALLISTAARROWHEAD/,
    "a metal ballista arrow is the TIPPED one -- it needs an arrowhead of that metal as a reagent");
  assert.match(arm, /'Make bolt thrower parts'[\s\S]*?ConstructBoltThrowerParts/,
    "no bolt-thrower row. ConstructBoltThrowerParts is df.job.xml:1432 -- one plain job away, " +
    "exactly like the Quern's 'Mill plants'");
  assert.match(arm, /'Make ballista parts'/, "no ballista parts row");
  assert.match(arm, /'Make catapult parts'/, "no catapult parts row");
  assert.doesNotMatch(arm, /name = '[^']*tipped/i,
    "native has NO 'assemble tipped ballista arrow' row anywhere in either capture -- dfhack's " +
    "table has one, and AUTHORED_SHOPS is what drops it");
}, "the siege workshop is built from its capture (18 assemble rows + 3 parts rows)");
check(() => {
  const fn = sliceFn(lua, "function ammo_metals()");
  assert.ok(fn.length > 0, "there is no ammo-capable-metal filter");
  assert.match(fn, /ITEMS_AMMO/,
    "the siege metal set is NOT every forge metal: gold/platinum/nickel/lead/tin/zinc/brass/electrum/" +
    "pewter/aluminum/billon/sterling silver/black bronze/rose gold/nickel silver/pig iron all lack " +
    "[ITEMS_AMMO] in inorganic_metal.txt and NONE of them appears in WS-SIEGE-native-1of2.png");
  assert.match(fn, /forge_metals\(\)/, "reuse the proven forge metal enumeration, do not re-derive it");
}, "ammo_metals() is forge_metals() gated on the raws' ITEMS_AMMO flag");
check(() => {
  assert.match(lua, /local AUTHORED_SHOPS = \{ Jewelers = true, Siege = true \}/,
    "dfhack's hardcoded siege/jeweler rows are still served alongside ours -- every row twice");
  const fn = sliceFn(lua, "function getjobs_def_allowed(shop_key, def)");
  assert.match(fn, /return jf\.job_type == df\.job_type\.CustomReaction/,
    "the suppression must drop only dfhack's HAND-WRITTEN job table; raws reactions still flow");
  assert.match(lua, /getjobs_def_allowed\(shop_key, def\)/, "shop_job_defs does not apply it");
  assert.match(lua, /getjobs_def_allowed\(spec\[2\], def\)/, "order_catalog_by_shop does not apply it");
}, "AUTHORED_SHOPS drops dfhack's hardcoded rows for the two shops we author in full");

console.log("# D2 -- JEWELER'S: all TWELVE rows (we shipped 6, on a factually wrong justification)");
check(() => {
  const jw = extra.slice(extra.indexOf("Jewelers = "), extra.indexOf("Craftsdwarfs = "));
  for (const t of ["ammo", "finished goods", "furniture"]) {
    for (const g of ["cut gems", "cut glass", "polished stones"]) {
      assert.match(jw, new RegExp(`'Encrust ${t} with ${g}'`),
        `the jeweler's is missing the native row "Encrust ${t} with ${g}"`);
    }
  }
  assert.match(jw, /'Cut gems'/, "no Cut gems row");
  assert.match(jw, /'Cut raw glass into gems'/, "no Cut raw glass row");
  assert.match(jw, /'Polish stones'/, "no Polish stones row");
}, "all 12 rows of WS-JEWELERS-native.png are served");
check(() => {
  const jw = extra.slice(extra.indexOf("Jewelers = "), extra.indexOf("Craftsdwarfs = "));
  assert.match(jw, /EncrustWithGlass/,
    "the encrust variants differ by JOB TYPE, not by a job_item filter: EncrustWithGlass is " +
    "df.job.xml:546. The old comment claiming otherwise was simply wrong.");
  assert.match(jw, /EncrustWithStones/, "EncrustWithStones is df.job.xml:895");
  const enc = sliceFn(lua, "local function encrust_job(name, jt, target)");
  assert.match(enc, /improvable = true/,
    "the ammo/finished-goods/furniture split is dfhack's own model (workshops.lua:96-110): " +
    "job_item_flags1 improvable + the target bit");
  assert.match(jw, /'finished_goods'/, "no finished-goods target rows");
  const gems = sliceTable(lua, "local ENCRUST_GEM = {");
  assert.match(gems, /EncrustWithGlass\s+= \{ item_type = df\.item_type\.SMALLGEM, flags1 = \{ glass = true \} \}/,
    "flags1.glass IS the documented 'check for material flag IS_GLASS' pin (df.d_basics.xml:2828)");
  assert.match(gems, /EncrustWithStones = \{ item_type = df\.item_type\.SMALLGEM, flags3 = \{ stone = true \} \}/,
    "flags3.stone IS ANY_STONE_MATERIAL (df.d_basics.xml). These two pins are FLAG-DERIVED, not " +
    "capture-verified -- no capture can show a reagent filter. Said plainly, not overstated.");
}, "the encrust rows are derived, not guessed: job type + dfhack's improvable/target flags");

console.log("# D6 -- three same-job_type rows would otherwise render with IDENTICAL labels");
check(() => {
  const fn = sliceFn(lua, "function native_flat_task_label(def, job_type, reaction, fallback)");
  assert.match(fn, /if def\.label_locked/,
    "native_flat_task_label builds its probe from job_fields ONLY. The three 'Encrust X with cut " +
    "gems' rows differ solely in def.items, which the probe never carries -- so all three would " +
    "probe to the same string. A capture-transcribed label must win over the probe.");
  assert.match(fn, /return def\.name, 'capture-verbatim'/, "the locked label must be returned verbatim");
  const jw = extra.slice(extra.indexOf("Jewelers = "), extra.indexOf("Craftsdwarfs = "));
  assert.match(jw, /label_locked = true/, "the jeweler's rows are not label-locked");
}, "label_locked defeats the probe collision, and native says 'cut gems', not 'gems'");

console.log("# D3/D4 -- the container rows: row 1 of the carpenter's and the leatherworks' captures");
check(() => {
  assert.match(lua, /local FLAT_CONTAINER_LABEL = \{[\s\S]*?INSTRUMENT = 'Make instrument'/,
    "no 'Make instrument' container -- WS-CARPENTERS-native-1of3.png row 1 is simply missing from " +
    "our list (we suppress the leaves and add nothing)");
  assert.match(lua, /INSTRUMENT_PIECE = 'Make instrument piece'/,
    "no 'Make instrument piece' container -- WS-LEATHERWORKS-native-1of2.png row 1");
  const fn = sliceFn(lua, "function flat_shop_containers(b, suppressed)");
  assert.ok(fn.length > 0, "flat_shop_containers does not exist");
  assert.match(fn, /name = label \.\. ' \(opens menu\)'/, "the container row must read '(opens menu)'");
  assert.match(fn, /pri = -1/, "containers lead the list (the universal ordering law)");
  assert.match(fn, /local prefix = fort_civ_prefix\(\)/,
    "D4: the flat path applied NO fort-civ filter, so a FOREIGN civ's generated reactions could be " +
    "served as fort jobs. cd_reaction_cat and the smelter tree have always filtered on the civ.");
  assert.match(fn, /code:sub\(1, #prefix\) == prefix/, "the civ prefix is never actually compared");
}, "the two container rows exist, civ-filtered, and lead their lists");
check(() => {
  assert.match(lua, /Leatherworks = true/,
    "CAPTURED_FLAT_SHOPS must include the leatherworks -- it was leaking every raw MAKE_ENT " +
    "instrument-piece reaction as an individual flat row");
  assert.match(lua, /,"submenu":true,"children":\[/,
    "shop_tasks_json does not serve the container's children, so the client cannot open the menu");
  assert.match(client, /data-ws-flat-cat|wsFlatCat/,
    "the client cannot drill into a flat-shop container");
}, "the leatherworks stops leaking leaves, and the client can open the submenu");

console.log("# D5 -- the worldgen-roll hole at the clothier + leatherworks (FLAGGED AND GATED)");
check(() => {
  assert.match(lua, /local CAPTURE_ABSENT_CLOTHING = \{[\s\S]*?ITEM_ARMOR_SHIRT = true/,
    "shirt/tunic/toga/loincloth all pass the [SOFT]/[LEATHER] filters and are all permitted to " +
    "dwarves by entity_default.txt -- yet NO capture shows any of them. We enumerate the " +
    "post-worldgen rolled entity vectors, which we cannot read offline: if they contain these four " +
    "we emit 4 invented rows at the leatherworks and 12 across the clothier submenus. That is the " +
    "B255 failure class. Gate it against the captured set.");
  for (const id of ["ITEM_ARMOR_TUNIC", "ITEM_ARMOR_TOGA", "ITEM_PANTS_LOINCLOTH"])
    assert.match(lua, new RegExp(id), `${id} is not gated`);
  assert.match(lua, /local function is_soft_clothing\(d\)\s+return armor_prop\(d, 'SOFT'\) and capture_shows\(d\) end/,
    "the clothier gate is not applied");
  assert.match(lua, /local function is_leather_clothing\(d\) return armor_prop\(d, 'LEATHER'\) and capture_shows\(d\) end/,
    "the leatherworks gate is not applied");
  assert.match(lua, /capture_absent_count = capture_absent_count \+ 1/,
    "a dropped row must be COUNTED -- a non-zero count is the live answer to a question the " +
    "captures cannot settle offline");
}, "the four capture-absent clothing rows are gated out and counted (they can only be REMOVED)");

console.log("# D7 -- and the invented row is finally dead");
check(() => {
  const cd = extra.slice(extra.indexOf("Craftsdwarfs = {"));
  assert.doesNotMatch(cd, /craft_job\('Make wooden toy'/,
    "EXTRA_SHOP_JOBS.Craftsdwarfs STILL carries craft_job('Make wooden toy'). It is masked in the " +
    "Tasks tab by the native tree -- but masked is not deleted, and this table also feeds " +
    "order_catalog_by_shop, so the single invented row this whole wave exists to kill was still " +
    "LIVE on the work-order picker.");
  assert.doesNotMatch(cd, /MakeToy/, "the MakeToy job has no wooden row in any capture");
  assert.doesNotMatch(cd, /'Make rock mug'/,
    "native says 'Make three rock mugs' (MakeGoblet makes a stack of three)");
  assert.match(cd, /'Make three rock mugs'/, "the goblet row must carry its native count word");
}, "'Make wooden toy' is deleted and the mug row carries its native name");
// D9 (second parity review) -- THIS CELL USED TO GREP FOR THE SUFFIX LINE AND PASS WHILE THE ROW DID
// NOT EXIST. The suffix only ever fires for a def with job_type == EngraveSlab, and NO source produced
// one: dfhack's Masons table has `construct slab` (the blank slab) and no engrave job, EXTRA_SHOP_JOBS
// had no Masons key, and the mason's dynamic arm emits MakeTool rows only. So the mason served 19 of
// native's 20 rows and this cell was green. Assert the ROW, then the marker.
// The behavioural version -- the row modelled through the real merge of dfhack's getJobs + ours -- is
// tools/harness/order_catalog_shops_test.mjs.
check(() => {
  const masons = extra.slice(extra.indexOf("Masons = {"), extra.indexOf("Jewelers = "));
  assert.ok(masons.length > 0, "EXTRA_SHOP_JOBS has no Masons block, so nothing serves an EngraveSlab " +
    "def, so the mason's row 1 -- `Engrave memorial slab (opens menu)`, WS-MASONS-native-1of2.png -- " +
    "is simply MISSING. Adding the '(opens menu)' suffix to a row that does not exist is dead code.");
  assert.match(masons, /'Engrave memorial slab'/, "the row's captured label is missing");
  assert.match(masons, /job_type = df\.job_type\.EngraveSlab/, "the row has no EngraveSlab job");
  assert.match(masons, /item_type = df\.item_type\.SLAB/,
    "DF engraves an EXISTING blank slab -- the reagent is a SLAB item, not a boulder");
  const st = sliceFn(lua, "function shop_tasks(b, defs)");
  assert.match(st, /native_name = tostring\(native_name\) \.\. ' \(opens menu\)'/,
    "the mason's 'Engrave memorial slab' opens the dead-unit picker and native marks it " +
    "'(opens menu)' -- WS-MASONS-native-1of2.png. We rendered it as an ordinary row.");
  assert.match(lua, /ORDER_EXCLUDED_JOBS\[df\.job_type\.EngraveSlab\] = true/,
    "an EngraveSlab order needs a specific dead historical figure, which no order key can carry -- " +
    "the row must be a TASK only, or adding it puts a nonsense order on both work-order pickers");
}, "the mason SERVES an 'Engrave memorial slab' row, marked '(opens menu)', excluded from orders");
check(() => {
  // The workshop-capture manifest is a private dev oracle (see docs/NAMING.md); this
  // assertion self-checks the manifest, not the shipped code, so it skips in a clone.
  const manifestPath = path.join(root, "evidence/oracles/workshops/MANIFEST.md");
  if (!fs.existsSync(manifestPath)) {
    console.log("  ok - MANIFEST.md absent (private dev oracle); manifest self-check skipped");
    return;
  }
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const row = manifest.split("\n").find(l => l.includes("WS-JEWELERS-native.png"));
  assert.ok(row, "the manifest has no jeweler's row");
  assert.doesNotMatch(row, /\b11 rows\b/, "the manifest says 11 rows; the capture shows 12");
  assert.match(row, /12 rows/, "the manifest must record the twelve rows the capture actually shows");
}, "MANIFEST.md records the jeweler's TWELVE rows");

console.log(`\n${failed === 0 ? "# PASS" : "# FAIL"} -- ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
