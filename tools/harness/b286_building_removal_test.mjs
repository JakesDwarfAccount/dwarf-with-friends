// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

// B286 screen-truth fixture. Assertions run against the real production panel builders and a
// serialized /building-info or /workshop-info payload, never against source-text matches.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
globalThis.window = globalThis;
globalThis.escapeHtml = value => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
globalThis.DWFUI = require(path.join(root, "web/js/dwf-ui-components.js"));
const panels = require(path.join(root, "web/js/dwf-building-zone-stockpile-panels.js"));

const payload = JSON.parse('{"id":286,"name":"Still","built":true,"markedForRemoval":true,' +
  '"removalActive":false,"removalStatus":"Slated for removal",' +
  '"removalActivityStatus":"Removal inactive.","items":[' +
  '{"id":99,"name":"pecan wood Barrel","itemType":"BARREL","hidden":false}]}');

const generic = panels.genericBuildingPanelMarkup(payload, {});
const workshop = panels.workshopRemovalBodyHtml(payload, payload.items);
const farmHeader = panels.farmHeaderHtml(payload);

assert.ok(generic.includes("Slated for removal"),
  "the serialized removal status reaches the production building panel payload");
assert.ok(generic.indexOf("Slated for removal") < generic.indexOf("Removal inactive."));
assert.ok(generic.indexOf("Removal inactive.") < generic.indexOf("Cancel removal"));
assert.ok(!generic.includes("Remove building"), "remove is swapped for cancel while slated");
assert.ok(generic.includes('data-bld-act="cancel-removal"'));
assert.ok(workshop.includes('data-ws-cancel-removal=""'));
assert.ok(workshop.includes("Cancel removal"));
assert.ok(workshop.indexOf("Cancel removal") < workshop.indexOf("pecan wood Barrel"),
  "the removal section precedes the contained-items list, matching B286-1");
assert.ok(!farmHeader.includes("data-bld-act=\"cancel\""),
  "a marked farm plot also suppresses its remove-building tool in favor of the shared cancel action");

const activePayload = { ...payload, removalActive: true, removalActivityStatus: "" };
const active = panels.buildingRemovalSectionHtml(activePayload, { action: "ws" });
assert.ok(active.includes("Slated for removal"));
assert.ok(!active.includes("Removal inactive."),
  "an active job never receives invented inactive or unverified active copy");

console.log("PASS B286 building-removal panel payload: wording, order, and cancel actions");
