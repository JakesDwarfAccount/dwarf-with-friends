// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const interaction = readFileSync(join(root, "src/interaction.cpp"), "utf8");
const unitSheet = readFileSync(join(root, "src/unit_sheet.cpp"), "utf8");

function assertDirectSubtype(source) {
  assert.match(source, /mi\.plant->growths\[growth_item->subtype\]/);
  assert.doesNotMatch(source, /mi\.plant->growths\[0\]/);
}

assertDirectSubtype(interaction);
assert.match(interaction, /growth_item->subtype < 0[\s\S]*growth_item->subtype >= mi\.plant->growths\.size\(\)/);
assert.match(interaction, /return Items::getDescription\(item, type, decorate\)/);
assert.match(interaction, /hover_push\(out, "item", item_display_name\(item, 0, true\)/);
assert.match(unitSheet, /item_display_name\(inv->item, 0, true\)/);
assert.match(interaction, /std::string item_display_name\([^)]*\)\s*\{\s*return item_display_name_impl/);

const deliberatelyWrong = interaction
  .replaceAll("mi.plant->growths[growth_item->subtype]", "mi.plant->growths[0]");
assert.throws(() => assertDirectSubtype(deliberatelyWrong),
  /regular expression/, "test-the-test: always selecting growths[0] must be rejected");

console.log("PASS B123 direct growth subtype naming and fallbacks");
