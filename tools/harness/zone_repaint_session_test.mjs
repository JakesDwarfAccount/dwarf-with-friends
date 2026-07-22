// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// SPDX-License-Identifier: AGPL-3.0-only

// Native selected-zone repaint regression: the selected zone remains visible, edits are staged
// behind the four-tool paint float, and only Accept reaches the mutation route.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const controls = fs.readFileSync(path.join(root, "web/js/dwf-controls-placement.js"), "utf8");
const core = fs.readFileSync(path.join(root, "web/js/dwf-core.js"), "utf8");
const panels = fs.readFileSync(path.join(root, "web/js/dwf-building-zone-stockpile-panels.js"), "utf8");

function body(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

const arm = body(controls, "function setZoneRepaint(id, meta)");
assert.doesNotMatch(arm, /closeZoneMode\(\)/,
  "arming repaint must not leave Zone mode and clear the selected-zone overlay");
assert.match(arm, /zoneMode = "repaint"[\s\S]*zoneOverlayEnabled = true/,
  "arming establishes the repaint submode with the zone overlay enabled");
assert.match(arm, /loadZones\(\)\.then\(updateZoneRepaintSummary\)/,
  "arming refreshes the authoritative zone footprint and count");

const disarm = body(controls, "function disarmZoneRepaint()");
assert.match(disarm, /zoneMode === "repaint"[\s\S]*zoneMode = "menu"/,
  "Cancel/Escape leaves repaint for the existing-zones context");
assert.doesNotMatch(disarm, /currentZones\s*=\s*\[\]|zoneOverlayEnabled\s*=\s*false/,
  "Cancel/Escape cannot make the zone disappear");

const newPreset = body(controls, "function setZonePreset(key)");
assert.match(newPreset,
  /if \(key\) \{[\s\S]*closeSelection\(\)[\s\S]*zoneMode === "repaint"[\s\S]*disarmZoneRepaint\(\)[\s\S]*zonePreset = key/,
  "choosing a new zone closes the old detail and explicitly leaves stale repaint state first");

const toolsStart = controls.indexOf('<div class="zone-repaint-tools"');
const toolsEnd = controls.indexOf('<div class="stock-palette-status"', toolsStart);
const toolsMarkup = controls.slice(toolsStart, toolsEnd);
for (const token of ["BUTTON_PAINT_RECTANGLE_INACTIVE", "BUTTON_FREE_PAINT_INACTIVE",
  "ZONE_ERASE_INACTIVE", "ZONE_REMOVE_EXISTING"])
  assert.ok(toolsMarkup.includes(token), `repaint float includes native tool ${token}`);
assert.ok(toolsMarkup.indexOf("BUTTON_PAINT_RECTANGLE_INACTIVE") < toolsMarkup.indexOf("BUTTON_FREE_PAINT_INACTIVE") &&
  toolsMarkup.indexOf("BUTTON_FREE_PAINT_INACTIVE") < toolsMarkup.indexOf("ZONE_ERASE_INACTIVE") &&
  toolsMarkup.indexOf("ZONE_ERASE_INACTIVE") < toolsMarkup.indexOf("ZONE_REMOVE_EXISTING"),
  "native tool order is Rectangle, Freehand, Erase portion, Remove zone");
assert.match(controls, /zoneCancel: ""[\s\S]*label: "Cancel"[\s\S]*zoneAccept: ""[\s\S]*label: "Accept"/,
  "the staged float exposes both Cancel and Accept");
assert.match(controls, /zoneRepaintSummaryCopy\.innerHTML = DWFUI\.bitmapTextHtml\([\s\S]*`\$\{label\}: \$\{count\} /,
  "the repaint float reports original tile count plus/minus the staged delta");

assert.match(controls, /zoneRepaintId != null && !zoneRemoveArmed[\s\S]*stageZoneRepaintDrag/,
  "map pointer-up stages repaint geometry");
assert.doesNotMatch(controls, /zoneRepaintId != null && !zoneRemoveArmed[\s\S]{0,180}repaintZoneDrag/,
  "map pointer-up does not mutate the zone immediately");
assert.match(body(controls, "async function acceptZoneRepaint()"), /commitZoneRepaintDraft/,
  "Accept is the commit point");
assert.match(body(controls, "async function commitZoneRepaintDraft(id, draft)"),
  /mode=replace[\s\S]*body: shape\.extents/,
  "Accept sends one exact final extent bitmap instead of a bounding-box shortcut");
assert.match(body(controls, "function stageZoneRepaintDrag(x1, y1, x2, y2)"),
  /rendered\.ox[\s\S]*setZoneDraftTile[\s\S]*zoneRepaintFreeCells/,
  "strokes become exact world tiles immediately, including free-paint cells");
assert.match(controls, /zoneRepaintDraft = \{ zone, changes: new Map\(\) \}/,
  "mixed add and erase strokes share one exact pending membership map");

assert.match(core, /\(!zonePreset && zoneRepaintId == null\)/,
  "the persistent paint preview also renders for an existing-zone repaint");
assert.match(core, /zoneRepaintDraft\.changes\.forEach[\s\S]*present \? "rgba\(90, 205, 255[\s\S]*"rgba\(235, 75, 65/,
  "the retained preview distinguishes exact added and erased tiles");
assert.match(panels, /DFZoneRepaint\.arm\(info\.id, \{[\s\S]*label:[\s\S]*sprite:/,
  "the selected-zone panel supplies native label and icon identity to the repaint float");

console.log("PASS zone repaint session: native four-tool staged float, visible footprint, count delta, Accept/Cancel semantics");
