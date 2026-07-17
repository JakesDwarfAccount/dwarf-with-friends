// cim_standingorders_test.mjs -- OFFLINE fixture for R2 (CIM-labor-standing-orders-*.jpg):
// native regrouping + verbatim {on,off} labels, keyed on STABLE server keys.
//   node tools/harness/cim_standingorders_test.mjs   (exit 0 PASS / 1 FAIL)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-labor-work-orders.js");

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);

// Mock /standing-orders payload -- items filed under their SERVER groups (standing_orders.cpp),
// each with its server label + a chosen value. soRegroup must re-home them to native tabs.
const item = (key, value) => ({ key, label: `server:${key}`, value });
const serverPayload = {
  groups: [
    { id: "workshops", items: ["auto_loom", "use_dyed_cloth", "auto_collect_webs", "auto_slaughter", "auto_butcher", "auto_fishery", "auto_kitchen", "auto_tan"].map(k => item(k, true)) },
    { id: "hauling", items: ["gather_wood", "gather_food", "gather_furniture", "gather_minerals", "gather_animals", "gather_refuse", "gather_refuse_outside", "gather_vermin_remains", "zoneonly_drink", "zoneonly_fish"].map(k => item(k, false)) },
    { id: "refuse", items: [item("gather_bodies", true), item("dump_bones", false), item("dump_corpses", false), item("dump_hair", false), item("dump_shells", false), item("dump_skins", false), item("dump_skulls", false), item("dump_other", false)] },
    { id: "forbidding", items: [item("forbid_own_dead", false), item("forbid_own_dead_items", false), item("forbid_other_dead_items", true), item("forbid_other_nohunt", false), item("forbid_used_ammo", true), item("forbid_rearming_traps", true), item("forbid_trap_cleaning", true), item("forbid_cages_from_sprung_traps", true), item("forbid_toppled_building_items", true), item("forbid_floor_and_wall_cleaning", true)] },
    { id: "petitions", items: ["petition_citizenship", "petition_resident_mercenary", "petition_resident_monster_hunter", "petition_resident_performer", "petition_resident_sanctuary", "petition_resident_scholar"].map(k => item(k, false)) },
    { id: "chores", items: [item("farmer_harvest", true), item("ignore_damp_stone", false), item("ignore_warm_stone", false)] },
    { id: "other", items: [item("job_cancel_announce", true), item("mix_food", false)] },
  ],
};

const g = M.soRegroup(serverPayload.groups);
const byId = Object.fromEntries(g.map(x => [x.id, x]));
const keys = id => (byId[id]?.items || []).map(i => i.key);
const labelOf = (id, key) => (byId[id]?.items || []).find(i => i.key === key)?.label;

console.log("\n# native tab order + membership");
check("7 native tabs in order", g.map(x => x.id).join(",") === "workshops,hauling,refuse,forbidding,petitions,chores,other");
check("Hauling = animals,food,furniture,BODIES,minerals,wood (native order)",
  keys("hauling").join(",") === "gather_animals,gather_food,gather_furniture,gather_bodies,gather_minerals,gather_wood");
check("gather_bodies moved OUT of refuse into hauling", keys("refuse").includes("gather_bodies") === false && keys("hauling").includes("gather_bodies"));
check("Refuse = gather refuse trio then dump_* (native order)",
  keys("refuse").join(",") === "gather_refuse,gather_refuse_outside,gather_vermin_remains,dump_corpses,dump_skulls,dump_bones,dump_shells,dump_skins,dump_hair,dump_other");
check("gather_refuse* moved OUT of hauling into refuse", keys("hauling").some(k => k.startsWith("gather_refuse")) === false);
check("Other = cancel,damp,warm,harvest,mix,zonedrink,zonefish (native order)",
  keys("other").join(",") === "job_cancel_announce,ignore_damp_stone,ignore_warm_stone,farmer_harvest,mix_food,zoneonly_drink,zoneonly_fish");
check("zoneonly_* moved OUT of hauling into Other", keys("hauling").some(k => k.startsWith("zoneonly")) === false);
check("Chores is empty (children roster is a wave-3 route)", keys("chores").length === 0);
check("Forbidding native order (used ammo, own dead, own items, other dead, other items, sieges...)",
  keys("forbidding").join(",") === "forbid_used_ammo,forbid_own_dead,forbid_own_dead_items,forbid_other_nohunt,forbid_other_dead_items,forbid_floor_and_wall_cleaning,forbid_trap_cleaning,forbid_rearming_traps,forbid_cages_from_sprung_traps,forbid_toppled_building_items");

console.log("\n# verbatim {on,off} labels vs oracle snapshots");
check("dump_bones OFF -> 'Workers save bones' (refuse oracle)", labelOf("refuse", "dump_bones") === "Workers save bones");
check("gather_refuse_outside OFF -> 'Workers ignore outdoor refuse'", labelOf("refuse", "gather_refuse_outside") === "Workers ignore outdoor refuse");
check("gather_vermin_remains OFF -> 'Workers ignore outdoor vermin remains'", labelOf("refuse", "gather_vermin_remains") === "Workers ignore outdoor vermin remains");
check("gather_refuse OFF (seeded false) -> 'Workers ignore refuse'", labelOf("refuse", "gather_refuse") === "Workers ignore refuse");
check("gather_refuse ON verb -> 'Workers gather refuse' (oracle state)", M.soNativeLabel("gather_refuse", true, "x") === "Workers gather refuse");
check("forbid_own_dead OFF -> 'Claim your dead' (forbidding oracle)", labelOf("forbidding", "forbid_own_dead") === "Claim your dead");
check("forbid_own_dead_items OFF -> 'Claim your death items'", labelOf("forbidding", "forbid_own_dead_items") === "Claim your death items");
check("forbid_other_dead_items ON -> 'Forbid other death items'", labelOf("forbidding", "forbid_other_dead_items") === "Forbid other death items");
check("forbid_used_ammo ON -> 'Forbid used ammunition'", labelOf("forbidding", "forbid_used_ammo") === "Forbid used ammunition");
check("ignore_damp_stone OFF -> 'Mining cancelled near new damp stone' (other oracle)", labelOf("other", "ignore_damp_stone") === "Mining cancelled near new damp stone");
check("farmer_harvest ON -> 'Everybody harvests'", labelOf("other", "farmer_harvest") === "Everybody harvests");
check("mix_food OFF -> 'Do not mix foods in barrels'", labelOf("other", "mix_food") === "Do not mix foods in barrels");
check("zoneonly_drink OFF -> 'Use any water source for drinking'", labelOf("other", "zoneonly_drink") === "Use any water source for drinking");
check("Hauling gather_wood OFF (seeded false) -> 'Workers ignore wood'", labelOf("hauling", "gather_wood") === "Workers ignore wood");
check("Hauling gather_wood ON verb -> 'Workers gather wood' (oracle state)", M.soNativeLabel("gather_wood", true, "x") === "Workers gather wood");

console.log("\n# state-dependence (value flips the verb)");
check("dump_bones ON -> 'Workers dump bones'", M.soNativeLabel("dump_bones", true, "x") === "Workers dump bones");
check("dump_bones OFF -> 'Workers save bones'", M.soNativeLabel("dump_bones", false, "x") === "Workers save bones");
check("forbid_own_dead ON -> 'Forbid your dead'", M.soNativeLabel("forbid_own_dead", true, "x") === "Forbid your dead");

console.log("\n# petitions/workshops untouched (counterexample: no strip/relabel)");
check("petitions membership preserved (6)", keys("petitions").length === 6);
check("petition label FALLS BACK to server label (route pending, not remapped)", labelOf("petitions", "petition_citizenship") === "server:petition_citizenship");
check("workshops order unchanged", keys("workshops").join(",") === "auto_loom,use_dyed_cloth,auto_collect_webs,auto_slaughter,auto_butcher,auto_fishery,auto_kitchen,auto_tan");
check("workshops label falls back to server label", labelOf("workshops", "auto_loom") === "server:auto_loom");

console.log("\n# TEST-THE-TEST (seeded-bad must be discriminated)");
// 1) polarity inversion: if the label table were inverted, dump_bones OFF would say "dump".
guard("OFF label is NOT the ON verb (polarity guard)", M.soNativeLabel("dump_bones", false, "x") !== "Workers dump bones");
// 2) membership: a deliberately-bad regroup that leaves gather_bodies in refuse must be caught by
//    the 'bodies in hauling' assertion.
const badRegroup = [{ id: "hauling", items: [] }, { id: "refuse", items: [{ key: "gather_bodies" }] }];
const bodiesInHauling = rg => (rg.find(x => x.id === "hauling")?.items || []).some(i => i.key === "gather_bodies");
guard("bad regroup (bodies left in refuse) FAILS the bodies-in-hauling check", bodiesInHauling(badRegroup) === false);
guard("correct regroup PASSES the bodies-in-hauling check", bodiesInHauling(g) === true);

// ---- W5 RENDER PROOF -------------------------------------------------------------------------
// A green source-regex is NOT proof (`assert.match(source, /DWFUI/)` once reported "0 queued" while
// 467 controls bypassed the layer). These cells EXECUTE the production markup builder and assert the
// BUILDER'S OWN SIGNATURE in the emitted HTML -- the class it always writes AND the bitmap-label span
// it always emits. A hand-typed look-alike that merely wears the class cannot pass them.
const DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));
function laborRenderContext() {
  const ctx = vm.createContext({
    DWFUI, module: { exports: {} }, console, clientPanel: null, player: "p1",
    escapeHtml: s => String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    infoTabRowHtml: () => `<div class="info-tabs"></div>`,
    infoSearchBoxHtml: () => DWFUI.searchHtml({ cls: "info-search", placement: "footer", magnifier: true, ariaLabel: "Search" }),
    unitPortraitMarkup: (u, c) => `<span class="${c}"></span>`,
    attribRowHtml: (kind, id) => `<span class="attrib-chip" data-attrib="${kind}:${id}">&#9679; p1</span>`,
    bldIconStyle: () => "", dfTokenMatch: () => true,
  });
  vm.runInContext(readFileSync(modPath, "utf8"), ctx);
  return ctx.module.exports;
}
const R = laborRenderContext();

console.log("\n# W5 -- standing-order rows are DWFUI plaques, not hand-built buttons");
const soRefuse = R.standingOrdersMarkup(serverPayload, "refuse");
const soHauling = R.standingOrdersMarkup(serverPayload, "hauling");
check("an OFF standing order renders DWFUI.plaqueBtnHtml (dwfui-plaque + its bitmap label span)",
  /class="dwfui-plaque dwfui-plaque--art-neutral so-toggle off" data-so-key="dump_bones" data-so-on="1"/.test(soRefuse) &&
  /dwfui-plaque-label/.test(soRefuse));
check("an ON standing order keeps its pinned `.so-toggle.on` class hook through the builder",
  /class="dwfui-plaque dwfui-plaque--art-neutral so-toggle on" data-so-key="gather_bodies"/.test(soHauling));
check("the POST wire is unchanged: data-so-key + data-so-on still carry the key and the next value",
  /data-so-key="dump_corpses" data-so-on="1"/.test(soRefuse));
check("the third tab row is still the SHORT_SUBSUBTAB grammar (level was already correct)",
  /class="dwfui-tabs dwfui-tabs--subsubtab info-detail-tabs so-cat-tabs"/.test(soRefuse));
check("no hand-rolled `<button class=\"so-toggle\"` survives in the emitted markup",
  !/<button class="so-toggle/.test(soRefuse));
guard("a look-alike wearing the plaque CLASS but not its bitmap label would NOT pass",
  !/dwfui-plaque-label/.test(`<button class="dwfui-plaque grey so-toggle">Workers save bones</button>`));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
