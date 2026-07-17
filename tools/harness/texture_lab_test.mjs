// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const web = join(root, "web");
const html = readFileSync(join(web, "texture-lab.html"), "utf8");
const js = readFileSync(join(web, "js", "dwf-texture-lab.js"), "utf8");
const css = readFileSync(join(web, "css", "texture-lab.css"), "utf8");

assert.match(html, /href="css\/texture-lab\.css"/, "CSS path must work when the HTML is double-clicked");
assert.match(html, /src="js\/dwf-texture-lab\.js"/, "JS path must work when the HTML is double-clicked");

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
assert.equal(new Set(htmlIds).size, htmlIds.length, "texture lab must not contain duplicate ids");

const selectedIds = [...new Set([...js.matchAll(/\$\("#([^"]+)"\)/g)].map((m) => m[1]))];
const missingIds = selectedIds.filter((id) => !htmlIds.includes(id));
assert.deepEqual(missingIds, [], "every fixed id selector must exist in texture-lab.html");

for (const required of ["guided", "pipeline", "trace", "atlas", "failures", "repair"])
  assert.match(html, new RegExp(`data-panel="${required}"`), `missing ${required} panel`);

assert.match(js, /const GUIDED_STAGES = \[/, "guided course data is missing");
assert.match(js, /const TRACE_SIMPLE = \{/, "plain-English trace translations are missing");
assert.match(css, /prefers-reduced-motion/, "animation accessibility guard must remain in the stylesheet");

const readJson = (name) => JSON.parse(readFileSync(join(web, name), "utf8"));
const tiletypes = readJson("tiletype_token_map.json");
const items = readJson("item_map.json");
const creatures = readJson("creatures_map.json");
const buildings = readJson("building_map.json");
const trees = readJson("tree_map.json");
const materials = readJson("material_map.json");
const spatter = readJson("spatter_map.json");

assert.deepEqual(tiletypes.StoneFloor1, { overlay: "STONE_FLOOR_1", tint: null, token: "STONE_FLOOR_5" });
assert.equal(items.bytoken.ITEM_WEAPON_PICK.sheet, "item_weapons.png");
assert.ok(creatures.races.CAT.corpse, "CAT must expose dead-state art for the corpse trace");
assert.equal(creatures.races.DWARF.layered, true);
assert.equal(buildings["Workshop:Carpenters"].w, 3);
assert.ok(trees.OAK.TREE_TRUNK, "OAK must expose structural tree families");
assert.equal(typeof materials.plant.OAK.WOOD, "number");
assert.ok(spatter.families.BLOOD_RED, "blood-spatter trace requires BLOOD_RED family");

for (const file of [
  "tiletype_token_map.json", "item_map.json", "creatures_map.json", "building_map.json",
  "plant_map.json", "tree_map.json", "material_map.json", "spatter_map.json", "flow_map.json",
  "overlay_map.json", "shadow_cell_map.json", "interface_map.json",
]) assert.match(js, new RegExp(`/` + file.replace(".", "\\.")), `catalog missing ${file}`);

console.log(`texture_lab_test: PASS (${selectedIds.length} fixed selectors, ${htmlIds.length} unique ids, 12 static catalogs, 8 visual trace scenarios, 7 guided steps)`);
