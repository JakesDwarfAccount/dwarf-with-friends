// b255_bolt_jobs_test.mjs -- B255 "make bolts is an option at the bowyer's workshop".
//
//   node tools/harness/b255_bolt_jobs_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// THE REAL DF RULE (established from the game's own data + a native capture, not from memory):
//   * Craftsdwarf's Workshop -- wooden bolts (wood crafter) and bone bolts (bone carver).
//     the native capture `tools/orchestrator/attachments/B255-1.png` shows the row
//     "Make twenty-five wooden bolts" in that shop's task list.
//   * Metalsmith's Forge / Magma Forge -- metal bolts (weaponsmith). Already correct in the forge
//     tree: ft_weapon_leaves emits "Forge twenty-five <metal> bolts" (capture-01 oracle).
//   * Bowyer's Workshop -- CROSSBOWS ONLY (bone or wooden). It makes NO ammo.
//     Corroborating game data: DFHack df-structures `library/xml/df.job.xml` gives job_type MakeAmmo
//     the attrs skill_wood=WOODCRAFT, skill_stone=STONECRAFT, skill_metal=FORGE_WEAPON -- the
//     craftsdwarf labors and the weaponsmith. No bowyer skill is attached to MakeAmmo at all.
//
// THE BUG: dwf.lua's `dynamic_shop_jobs` enumerated the fort entity's ammo_type vector INTO
// THE BOWYER (with a wood-log reagent), and the craftsdwarf's wood/bone submenus -- a guessed,
// `derived-not-captured` 8-row crafts+jewelry list -- had no ammo at all. So the client offered
// bolts at a shop that cannot make them and hid them at the shop that can. Same failure class as
// B01/B160: a hand-maintained job list standing in for DF's own.
//
// SOURCE-TIE test (no live DF in the offline sweep). Every assertion below encodes the post-fix
// state and FAILS against pre-fix main.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const lua = fs.readFileSync(path.join(root, "dwf.lua"), "utf8");

let passed = 0, failed = 0;
function check(fn, name) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { failed++; console.log(`  FAIL - ${name}: ${err.message}`); }
}

// Slice a `[local ]function name(` body up to the first column-0 `end`.
function sliceFn(src, header) {
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `could not find ${header}`);
  const rest = src.slice(start);
  const m = rest.match(/\nend\b/);
  assert.ok(m, `could not find end of ${header}`);
  return rest.slice(0, m.index + m[0].length);
}
// Slice one `elseif is_x then` arm of dynamic_shop_jobs.
function sliceArm(fnSrc, header) {
  const start = fnSrc.indexOf(header);
  assert.notEqual(start, -1, `could not find arm ${header}`);
  const rest = fnSrc.slice(start + header.length);
  const m = rest.match(/\n {4}(elseif|end)\b/);
  return m ? rest.slice(0, m.index) : rest;
}

const dyn = sliceFn(lua, "function dynamic_shop_jobs(b)");

console.log("# the bowyer makes crossbows, NOT ammo (B255)");
check(() => {
  const arm = sliceArm(dyn, "elseif is_bowyer then");
  assert.doesNotMatch(arm, /MakeAmmo/,
    "the bowyer arm still enumerates MakeAmmo -- DF's bowyer's workshop makes no ammo");
  assert.doesNotMatch(arm, /R\.ammo_type/,
    "the bowyer arm still enumerates the entity ammo_type vector");
}, "dynamic_shop_jobs' bowyer arm offers no ammo job of any kind");
check(() => {
  const arm = sliceArm(dyn, "elseif is_bowyer then");
  assert.match(arm, /MakeWeapon/, "the bowyer still makes ranged weapons");
  assert.match(arm, /'Make bone'/, "the bowyer makes BONE ranged weapons (native: 'Make bone crossbow')");
  assert.match(arm, /'Make wooden'/, "the bowyer makes WOODEN ranged weapons (native: 'Make wooden crossbow')");
}, "dynamic_shop_jobs' bowyer arm offers bone + wooden ranged weapons");

console.log("# the craftsdwarf makes wooden + bone bolts (B255)");
check(() => {
  assert.match(lua, /local is_craftsdwarf = \(key == 'Craftsdwarfs'\)/,
    "dynamic_shop_jobs does not recognise the craftsdwarf at all");
  const arm = sliceArm(dyn, "elseif is_craftsdwarf then");
  assert.match(arm, /ammo_shop_defs\(defs, 'Ammo', 11, 'wooden', 'wood', WOODLOG_REAGENT\)/,
    "no wooden-ammo rows at the craftsdwarf");
  assert.match(arm, /ammo_shop_defs\(defs, 'Ammo', 11, 'bone',   'bone', BONE_REAGENT\)/,
    "no bone-ammo rows at the craftsdwarf");
}, "dynamic_shop_jobs gives the craftsdwarf entity-derived wood + bone ammo (flat + work-order path)");

check(() => {
  const fn = sliceFn(lua, "function ammo_shop_defs(defs, group, pri, adj, matcat, reagent)");
  assert.match(fn, /df\.job_type\.MakeAmmo/, "ammo_shop_defs must queue a MakeAmmo job");
  assert.match(fn, /df\.item_type\.AMMO/, "ammo_shop_defs must pin the AMMO product item type");
  assert.match(fn, /R\.ammo_type, IT\.ammo/,
    "ammo rows must come from the fort ENTITY's permitted ammo defs, not a hand list");
  assert.match(fn, /name_plural/, "the native label uses the ammo def's plural ('bolts')");
}, "ammo_shop_defs derives its rows from the entity + raws (no hand-written 'bolts' string)");

check(() => {
  assert.match(lua, /local AMMO_COUNT_WORD = \{ wood = 'twenty-five', bone = 'five' \}/,
    "the native stack word is missing -- DF's row reads 'Make twenty-five wooden bolts'");
  assert.match(lua, /AMMO_COUNT_N = \{ wood = 25, bone = 5 \}/, "leaf batch counts missing");
}, "labels carry DF's stack size (25 per log / 5 per bone), per B255-1.png");

console.log("# the craftsdwarf's WOOD submenu matches the native capture B255-1.png");
const seqAt = lua.indexOf("local CD_WOOD_SEQ = {");
const woodSeq = seqAt === -1 ? "" : lua.slice(seqAt, lua.indexOf("local function cd_wood_submenu()"));
check(() => assert.ok(woodSeq.length > 0, "CD_WOOD_SEQ (the captured native wood sequence) does not exist"),
  "CD_WOOD_SEQ exists");
// Every row visible in the capture, in the capture's order.
const CAPTURED = [
  "Make large wooden gem", "Make three wooden cups", /* bolts */ "Make wooden amulet",
  "Make wooden book binding", "Make wooden bracelet", "Make wooden crafts", "Make wooden crown",
  "Make wooden die", "Make wooden earring", "Make wooden figurine", "Make wooden hive",
  "Make wooden jug", "Make wooden nest box", "Make wooden pot", "Make wooden ring",
  "Make wooden scepter", "Make wooden scroll rollers",
];
check(() => {
  let cursor = -1;
  for (const label of CAPTURED) {
    const at = woodSeq.indexOf(`'${label}'`);
    assert.notEqual(at, -1, `native row missing from the wood submenu: "${label}"`);
    assert.ok(at > cursor, `wood submenu out of native order at "${label}"`);
    cursor = at;
  }
}, "all 17 non-ammo rows of the capture are present, in the capture's order");
check(() => {
  const at = woodSeq.indexOf("{ 'AMMO' }");
  assert.notEqual(at, -1, "the wood submenu has no bolts row -- the whole point of B255");
  assert.ok(at > woodSeq.indexOf("'Make three wooden cups'"), "bolts row before 'three wooden cups'");
  assert.ok(at < woodSeq.indexOf("'Make wooden amulet'"), "bolts row after 'wooden amulet'");
}, "'Make twenty-five wooden bolts' sits where the capture puts it (after cups, before amulet)");
check(() => {
  const fn = sliceFn(lua, "local function cd_wood_submenu()");
  assert.match(fn, /cd_ammo_leaves\('wooden', 'wood', 'screenshot-verified'\)/,
    "the wood submenu must build its bolts from the shared entity-derived ammo defs");
}, "the wood submenu's bolts leaf is entity-derived and marked screenshot-verified");
// B264 rebuilt the bone/shell submenus VERBATIM from WS-CRAFTSDWARF-{BONE,SHELL}-native.png, so the
// ammo branch moved from an `if matcat == 'bone'` special case into the captured row sequence itself
// (an { 'AMMO' } row at the position DF puts it). B255's guarantee is unchanged and still asserted:
// BONE offers bolts, SHELL offers none. The capture also CONFIRMS B255's uncaptured stack word:
// the native row reads "Make five bone bolts".
check(() => {
  const boneSeq = lua.slice(lua.indexOf("local CD_BONE_SEQ = {"), lua.indexOf("local CD_SHELL_SEQ = {"));
  assert.ok(boneSeq.length > 0, "CD_BONE_SEQ (the captured native bone sequence) does not exist");
  assert.match(boneSeq, /\{ 'AMMO' \}/, "the bone submenu has no bolts row");
  const fn = sliceFn(lua, "local function cd_organic_submenu(word, matcat)");
  assert.match(fn, /cd_ammo_leaves\(word, matcat/,
    "the bone submenu must still build its bolts from the shared entity-derived ammo defs");
}, "the craftsdwarf's BONE submenu offers bone bolts");
check(() => {
  const shellSeq = lua.slice(lua.indexOf("local CD_SHELL_SEQ = {"), lua.indexOf("local CD_ORGANIC_SEQ"));
  assert.ok(shellSeq.length > 0, "CD_SHELL_SEQ does not exist");
  assert.doesNotMatch(shellSeq, /AMMO/,
    "the SHELL submenu offers ammo -- the capture shows shell makes no bolts at all");
}, "the craftsdwarf's SHELL submenu offers NO ammo (WS-CRAFTSDWARF-SHELL-native.png)");
check(() => {
  const root = sliceFn(lua, "local function craftsdwarf_tree(bt, st)");
  assert.match(root, /label = 'wood'.*\n.*cd_wood_submenu\(\)/,
    "the craftsdwarf tree's wood selector still uses the old guessed cd_organic_submenu('wooden')");
}, "craftsdwarf_tree's wood material selector serves the captured sequence");

console.log("# the forge keeps its (already correct) metal ammo");
check(() => {
  const fn = sliceFn(lua, "local function ft_weapon_leaves(R, metal)");
  assert.match(fn, /'Forge twenty-five ' \.\. metal\.label/, "the forge lost its metal ammo rows");
}, "ft_weapon_leaves still forges twenty-five <metal> bolts (ITEMS_AMMO-gated)");
check(() => {
  const arm = sliceArm(dyn, "if is_forge then");
  assert.match(arm, /MakeAmmo/, "the forge flat path lost its metal ammo");
}, "the forge's flat/work-order path still offers metal ammo");

console.log(`\n${failed === 0 ? "# PASS" : "# FAIL"} -- ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
