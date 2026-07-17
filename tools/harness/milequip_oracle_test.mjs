// milequip_oracle_test.mjs -- DEPLOY-GATED oracle-differential acceptance for the milequip
// wave-3 work: uniform-template authoring (fort->uniforms) + squad ammunition authoring
// (squad->ammo.ammunition[]). Every mutation is issued over the LIVE plugin HTTP server, then
// READ BACK via dfhack-run lua against the actual df structures and asserted EXACT -- the
// mechanism (real struct writes) is verified, not just the JSON echo (completeness rule 2).
// Seeded-bad cases (rule 3) confirm the oracle discriminates.
//
// Run AFTER the milequip DLL is deployed + a fort is loaded:
//   node tools/harness/milequip_oracle_test.mjs   [--host http://localhost:8765]
// Exit: 0 PASS, 1 FAIL, 2 CANNOT-RUN (server unreachable / dfhack-run missing).
//
// NOTE: uniform authoring needs NO squad (operates on fort->uniforms directly). Squad ammo
// authoring needs a live squad; the test creates a temp squad if a free militia-captain
// position exists, else SKIPS the ammo section (reported, not failed) as a precondition gap.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireLiveOptIn } from "./live_guard.mjs";

import { defaultDfhackRun } from "../lib/dfroot.mjs";   // W1: resolved, never hardcoded
const argHost = (() => {
  const i = process.argv.indexOf("--host");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "http://localhost:8765";
})();
const BASE = argHost.replace(/\/+$/, "");

// B242: a live oracle must be asked for on purpose -- port 8765 may be a fort someone is playing.
requireLiveOptIn("milequip_oracle_test.mjs", BASE);
const DFHACK_RUN = defaultDfhackRun();

// item_type ground-truth constants (df/item_type.h), used in-lua by name so drift is caught.
let failed = 0, passed = 0, skipped = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}
// A "seeded-bad" assertion is EXPECTED to be false; the oracle passes iff it correctly reports false.
function checkSeededBad(name, cond) {
  if (!cond) { passed++; console.log(`  ok - (test-the-test) ${name} -> correctly detected as wrong`); }
  else { failed++; console.log(`  FAIL - (test-the-test) ${name} -> oracle did NOT discriminate`); }
}

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

// dfhack-run's inline `lua <code>` form chokes on multi-statement chunks ("unexpected symbol
// near 'local'"). Write the chunk to an ABSOLUTE temp file and run it with `-f` instead.
// dfhack stdout is CP437, but every value we print here is a bare boolean/number (ASCII), so a
// utf8 decode is lossless for these outputs.
let _luaSeq = 0;
function lua(code) {
  const tmp = join(tmpdir(), `milequip_lua_${process.pid}_${_luaSeq++}.lua`);
  writeFileSync(tmp, code, "utf8");
  return execFileSync(DFHACK_RUN, ["lua", "-f", tmp], { encoding: "utf8" }).trim();
}
// Evaluate a boolean lua expression with the fort + a uniform-by-id helper (U) in scope.
function luaBool(expr) {
  const prelude = "local p=df.global.plotinfo local f=df.historical_entity.find(p.group_id) " +
    "local function U(id) for _,u in ipairs(f.uniforms) do if u.id==id then return u end end end " +
    "local function last(v) return v[#v-1] end ";
  return lua(prelude + "print(" + expr + ")") === "true";
}
function luaNum(expr) {
  const prelude = "local p=df.global.plotinfo local f=df.historical_entity.find(p.group_id) " +
    "local function U(id) for _,u in ipairs(f.uniforms) do if u.id==id then return u end end end ";
  return Number(lua(prelude + "print(" + expr + ")"));
}

(async () => {
  // Preconditions.
  try {
    const h = await fetch(`${BASE}/health`);
    if (!h.ok) throw new Error(`/health ${h.status}`);
  } catch (e) {
    console.log(`CANNOT RUN - server unreachable at ${BASE} (${e.message}). Deploy + load a fort first.`);
    process.exit(2);
  }
  try {
    if (lua("print(df.global.world ~= nil)") !== "true") throw new Error("world nil");
  } catch (e) {
    console.log(`CANNOT RUN - dfhack-run lua unavailable (${e.message}).`);
    process.exit(2);
  }

  // ======================= UNIFORM TEMPLATE AUTHORING =======================
  console.log("TEST: uniform-template authoring (fort->uniforms)");
  const n0 = luaNum("#f.uniforms");
  const nid0 = luaNum("f.next_uniform_id");

  const created = await post(`/uniform-create?name=MILEQUIP_TEST&type=3`);
  check("U1 create returns ok+id", created.status === 200 && created.data && typeof created.data.id === "number",
    JSON.stringify(created.data));
  const uid = created.data ? created.data.id : -1;
  check("U1 new id == prior next_uniform_id", uid === nid0, `uid=${uid} nid0=${nid0}`);
  check("U1 fort.uniforms grew by 1", luaNum("#f.uniforms") === n0 + 1);
  check("U1 next_uniform_id incremented", luaNum("f.next_uniform_id") === nid0 + 1);
  check("U1 template type==Soldier(3), flags==0",
    luaBool(`U(${uid}).type==df.entity_uniform_type.Soldier and U(${uid}).flags.whole==0`));

  const renamed = await post(`/uniform-rename?id=${uid}&name=RENAMED_UNIFORM`);
  check("U2 rename ok", renamed.status === 200);
  check("U2 name persisted", luaBool(`U(${uid}).name=="RENAMED_UNIFORM"`));

  // U3: body/ARMOR, leather (matclass 1), any subtype.
  await post(`/uniform-item-add?id=${uid}&cat=0&subtype=-1&matclass=1`);
  check("U3 body item_type==ARMOR",
    luaBool(`last(U(${uid}).uniform_item_types[0])==df.item_type.ARMOR`));
  check("U3 body subtype==-1 (any)", luaBool(`last(U(${uid}).uniform_item_subtypes[0])==-1`));
  check("U3 body material_class==Leather(1)",
    luaBool(`last(U(${uid}).uniform_item_info[0]).material_class==df.entity_material_category.Leather`));

  // U4: weapon, specific subtype 3 (short sword), individual choice = ranged (bit 2 -> whole 4).
  await post(`/uniform-item-add?id=${uid}&cat=6&subtype=3&matclass=-1&choice=4`);
  check("U4 weapon item_type==WEAPON",
    luaBool(`last(U(${uid}).uniform_item_types[6])==df.item_type.WEAPON`));
  check("U4 weapon subtype==3", luaBool(`last(U(${uid}).uniform_item_subtypes[6])==3`));
  check("U4 weapon indiv_choice.whole==4 (ranged)",
    luaBool(`last(U(${uid}).uniform_item_info[6]).indiv_choice.whole==4`));

  // U5 (EDGE): body, metal armor (matclass 16), specific subtype 0, dye color 1.
  await post(`/uniform-item-add?id=${uid}&cat=0&subtype=0&matclass=16&color=1`);
  check("U5 (edge) body[1] material_class==Armor(16, metal)",
    luaBool(`last(U(${uid}).uniform_item_info[0]).material_class==df.entity_material_category.Armor`));
  check("U5 (edge) body[1] item_color==1", luaBool(`last(U(${uid}).uniform_item_info[0]).item_color==1`));
  check("U5 (edge) body[1] subtype==0", luaBool(`last(U(${uid}).uniform_item_subtypes[0])==0`));
  check("U5 (edge) body category now has 2 items", luaNum(`#U(${uid}).uniform_item_types[0]`) === 2);

  // U6 (EDGE): remove body index 0; the surviving item must be the ex-index-1 (metal, color 1).
  await post(`/uniform-item-remove?id=${uid}&cat=0&index=0`);
  check("U6 (edge) body count 2->1", luaNum(`#U(${uid}).uniform_item_types[0]`) === 1);
  check("U6 (edge) surviving body item is the metal one (matclass 16)",
    luaBool(`U(${uid}).uniform_item_info[0][0].material_class==df.entity_material_category.Armor`));
  check("U6 (edge) surviving body subtype==0 (shifted correctly)",
    luaBool(`U(${uid}).uniform_item_subtypes[0][0]==0`));

  // U7: both flags.
  await post(`/uniform-flags?id=${uid}&replaceClothing=1&exactMatches=1`);
  check("U7 flags.whole==3 (replace_clothing|exact_matches)", luaBool(`U(${uid}).flags.whole==3`));

  // U9 (test-the-test): a wrong assertion MUST be detected.
  checkSeededBad("U9 flags.whole is (wrongly) 2", luaBool(`U(${uid}).flags.whole==2`));

  // U8 (EDGE): delete removes it entirely.
  await post(`/uniform-delete?id=${uid}`);
  check("U8 (edge) fort.uniforms back to baseline", luaNum("#f.uniforms") === n0);
  check("U8 (edge) uniform id no longer found", luaBool(`U(${uid})==nil`));

  // ======================= SQUAD AMMUNITION AUTHORING =======================
  console.log("TEST: squad ammunition authoring (squad->ammo.ammunition[])");
  let tempSquadId = -1;
  let ownsSquad = false;  // true => we created it (safe to run the destructive clear + delete)
  const sc = await post(`/squad-create`);
  if (sc.status === 200 && sc.data && typeof sc.data.id === "number") {
    tempSquadId = sc.data.id;
    ownsSquad = true;
    console.log(`  (created temp squad ${tempSquadId} for ammo tests)`);
  } else {
    // Fallback: BORROW any existing squad. The assertions are index-relative (anchored to the
    // squad's current ammo count `base`), and the borrowed path ONLY adds our own specs at/after
    // base and then removes exactly them -- the squad's pre-existing (e.g. v50 default) specs are
    // never touched, so it returns to baseline non-destructively. The destructive clear (A5) is
    // gated to squads WE own. This is why an empty-ammo squad is no longer required (v50 squads
    // ship a default spec, so one rarely exists).
    const existing = lua(
      `local civ=df.historical_entity.find(df.global.plotinfo.group_id) ` +
      `for _,sid in ipairs(civ.squads) do local s=df.squad.find(sid) ` +
      `if s then print(sid) return end end print(-1)`);
    const eid = Number(existing);
    if (eid >= 0) {
      tempSquadId = eid;
      console.log(`  (borrowing existing squad ${eid}; only our own specs are added+removed, ` +
        `pre-existing specs untouched)`);
    } else {
      console.log(`  SKIP ammo tests - could not create a squad (status ${sc.status}: ` +
        `${sc.data ? sc.data.error : "?"}) and no existing squad to borrow. ` +
        `[NOT-VERIFIED: squad-ammo live-oracle, precondition gap]`);
      skipped += 6;
    }
  }

  if (tempSquadId >= 0) {
    const sid = tempSquadId;
    // NB: build the full chunk and run it directly (like An below). Routing this through
    // luaBool would wrap the `local s=...` statement inside print(...), a parse error.
    const A = (expr) => lua(`local s=df.squad.find(${sid}) print(${expr})`) === "true";
    const An = (expr) => Number(lua(`local s=df.squad.find(${sid}) print(${expr})`));

    // INDEX-RELATIVE: v50 squads ship with a default ammo spec (or more) already in
    // squad->ammo.ammunition[], so a freshly created temp squad is NOT guaranteed to start
    // empty. Anchor every assertion to `base` = the count BEFORE our first add, and index the
    // specs WE add at base, base+1, ... -- never the absolute 0/1 (which would read/mutate the
    // pre-existing default spec). Server routes (add/update/remove) still take absolute indices;
    // we pass base-relative absolutes so the mutation lands on OUR spec, not DF's default.
    const base = An(`#s.ammo.ammunition`);
    const i0 = base;      // our first added spec (bolts)
    const i1 = base + 1;  // our second added spec (arrows)

    // A1: bolts (subtype 0), amount 100, combat, metal ammo (matclass 14).
    await post(`/squad-ammo?squad=${sid}&action=add&subtype=0&amount=100&combat=1&matclass=14`);
    check("A1 ammunition[base] item_type==AMMO", A(`s.ammo.ammunition[${i0}].item_type==df.item_type.AMMO`));
    check("A1 subtype==0 (bolts)", A(`s.ammo.ammunition[${i0}].item_subtype==0`));
    check("A1 amount==100", A(`s.ammo.ammunition[${i0}].amount==100`));
    check("A1 flags.whole==1 (use_combat)", A(`s.ammo.ammunition[${i0}].flags.whole==1`));
    check("A1 material_class==AmmoMetal(14)",
      A(`s.ammo.ammunition[${i0}].material_class==df.entity_material_category.AmmoMetal`));

    // A2: arrows (subtype 1), training.
    await post(`/squad-ammo?squad=${sid}&action=add&subtype=1&amount=50&training=1`);
    check("A2 ammunition count==base+2", An(`#s.ammo.ammunition`) === base + 2);
    check("A2 ammunition[base+1] subtype==1, flags.whole==2 (training)",
      A(`s.ammo.ammunition[${i1}].item_subtype==1 and s.ammo.ammunition[${i1}].flags.whole==2`));

    // A3: update our bolts spec (absolute index base) -> amount 250, both flags.
    await post(`/squad-ammo?squad=${sid}&action=update&index=${i0}&amount=250&combat=1&training=1`);
    check("A3 [base] amount==250", A(`s.ammo.ammunition[${i0}].amount==250`));
    check("A3 [base] flags.whole==3 (combat|training)", A(`s.ammo.ammunition[${i0}].flags.whole==3`));

    // A4 (EDGE): remove our bolts spec (absolute index base); the arrows shift down into base.
    await post(`/squad-ammo?squad=${sid}&action=remove&index=${i0}`);
    check("A4 (edge) count base+2 -> base+1", An(`#s.ammo.ammunition`) === base + 1);
    check("A4 (edge) survivor at base is arrows subtype==1 (shifted correctly)",
      A(`s.ammo.ammunition[${i0}].item_subtype==1`));

    if (ownsSquad) {
      // A5: clear (DESTRUCTIVE -- owned squad only; wipes ALL specs incl. any default).
      await post(`/squad-ammo?squad=${sid}&action=clear`);
      check("A5 ammunition empty after clear", An(`#s.ammo.ammunition`) === 0);

      // A6 (test-the-test): after clear, count is NOT base+1.
      checkSeededBad("A6 ammunition count is (wrongly) base+1", An(`#s.ammo.ammunition`) === base + 1);

      // cleanup: delete the temp squad.
      await post(`/squad-delete?squad=${sid}`);
      check("ammo cleanup: temp squad deleted", luaBool(`df.squad.find(${sid})==nil`));
    } else {
      // Borrowed squad: restore non-destructively by removing OUR surviving spec (arrows now at
      // base after A4), leaving the pre-existing specs exactly as we found them. Clear (A5/A6) is
      // skipped -- it is destructive and already covered by the owned-squad path.
      await post(`/squad-ammo?squad=${sid}&action=remove&index=${i0}`);
      check("ammo restore: borrowed squad back to baseline", An(`#s.ammo.ammunition`) === base);
      skipped += 2;  // A5 + A6 not run on a borrowed squad
    }
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} - ${passed} ok, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
})();
