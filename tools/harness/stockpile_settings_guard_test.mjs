#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const part = readFileSync(join(root, "lua", "parts", "00-core.lua"), "utf8");
const built = readFileSync(join(root, "dwf.lua"), "utf8");
const panel = readFileSync(join(root, "src", "stockpile_panel.cpp"), "utf8");
const bridge = readFileSync(join(root, "src", "lua_bridge.cpp"), "utf8");

for (const source of [part, built]) {
  assert.match(source, /function sp_ensure_category_vectors\(b, spec\)/);
  assert.match(source, /if sp_bool\(on\) then sp_ensure_category_vectors\(b, spec\) end/);
  assert.match(source, /if want then sp_ensure_category_vectors\(b, spec\) end/);
  assert.match(source, /function repair_incomplete_stockpile_settings\(\)/);
  assert.match(source, /df\.building_stockpilest:is_instance\(bld\)/);
  assert.match(source, /plotinfo\.hauling\.routes/);

  const vectors = {
    animals: ["enabled"],
    food: ["meat", "fish", "unprepared_fish", "egg", "plants", "drink_plant",
      "drink_animal", "cheese_plant", "cheese_animal", "seeds", "leaves",
      "powder_plant", "powder_creature", "glob", "glob_paste", "glob_pressed",
      "liquid_plant", "liquid_animal", "liquid_misc"],
    furniture: ["type", "other_mats", "mats"],
    corpses: ["corpses"],
    refuse: ["type", "corpses", "body_parts", "skulls", "bones", "hair", "shells", "teeth", "horns"],
    stone: ["mats"], ammo: ["type", "other_mats", "mats"], coins: ["mats"],
    bars_blocks: ["bars_other_mats", "blocks_other_mats", "bars_mats", "blocks_mats"],
    gems: ["rough_other_mats", "cut_other_mats", "rough_mats", "cut_mats"],
    finished_goods: ["type", "other_mats", "mats", "color"],
    leather: ["mats", "color"],
    cloth: ["thread_silk", "thread_plant", "thread_yarn", "thread_metal", "cloth_silk",
      "cloth_plant", "cloth_yarn", "cloth_metal", "color"],
    wood: ["mats"], weapons: ["weapon_type", "trapcomp_type", "other_mats", "mats"],
    armor: ["body", "head", "feet", "hands", "legs", "shield", "other_mats", "mats", "color"],
    sheet: ["paper", "parchment"],
  };
  for (const [category, fields] of Object.entries(vectors)) {
    for (const field of fields) {
      assert.ok(source.includes(`settings.${category}.${field}`),
        `category model covers ${category}.${field}`);
    }
  }
}

assert.match(panel, /stockpile_set_preset_via_lua\(/,
  "ordinary stockpile preset route uses the guarded serializer path");
assert.doesNotMatch(panel, /set_all_stockpile_groups|set_stockpile_group_flag/,
  "no C++ path exposes category flags before sibling vectors exist");
assert.match(bridge, /call_lua\("stockpile_set_preset"/);

console.log("PASS stockpile category sibling-vector guard and save repair surface");
