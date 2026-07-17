// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// panel_frame_test.mjs -- pure-contract test for WT07's shared panel framework.
//
//   node tools/harness/panel_frame_test.mjs
// Exit: 0 PASS, 1 FAIL. The test imports the real module's DFPanelFrame._pure export.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const P = require(path.resolve(here, "../../web/js/dwf-panelframe.js"));
const readJs = name => fs.readFileSync(path.resolve(here, "../../web/js", name), "utf8");
let passed = 0;
let failed = 0;
function ok(value, name, extra = "") {
  if (value) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  " + extra : "")); }
}
function guard(value, name) { ok(value, "(test-the-test) " + name); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("# persistence schema: encode/decode and garbage tolerance");
const layout = {
  chat: { anchor: "bl", x: 8.4, y: 52.4, w: 300.2, h: 270.1, open: true },
  combatlog: { anchor: "tl", x: 44, y: 44, w: 620, h: 480, open: false },
};
const encoded = P.encodeLayout(layout);
const decoded = P.decodeLayout(encoded);
ok(decoded.v === 1 && same(decoded.panels.chat, { anchor: "bl", x: 8, y: 52, w: 300, h: 270, open: true }),
  "encoded panel geometry round-trips as integer panel-space values");
ok(same(P.decodeLayout("{torn").panels, {}), "torn JSON is ignored without throwing");
ok(same(P.decodeLayout('{"v":2,"panels":{"chat":' + JSON.stringify(layout.chat) + "}}").panels, {}),
  "wrong schema version is ignored");
ok(same(P.decodeLayout('{"v":1,"panels":{"chat":{"anchor":"bl","x":1e999,"y":2,"w":3,"h":4}}}').panels, {}),
  "non-finite persisted geometry is ignored");
ok(same(P.decodeLayout(encoded, { combatlog: true }).panels, { combatlog: decoded.panels.combatlog }),
  "unknown panel keys are ignored against the registered key set");

console.log("# nearest-corner anchors remain stable across viewport sizes");
for (const scale of [0.7, 1.0, 1.3, 1.6]) {
  const viewport = { w: 1920 / scale, h: 1080 / scale };
  const rect = { x: 8, y: viewport.h - 52 - 270, w: 300, h: 270 };
  const entry = P.anchorForRect(rect, viewport);
  const restored = P.rectFromEntry(entry, { w: 1280 / scale, h: 720 / scale });
  ok(entry.anchor === "bl" && restored.x === 8 && restored.y === 720 / scale - 52 - 270,
    "bottom-left anchor restores at scale " + scale);
}
const topRight = P.anchorForRect({ x: 900, y: 50, w: 200, h: 100 }, { w: 1200, h: 800 });
ok(topRight.anchor === "tr" && same(P.rectFromEntry(topRight, { w: 900, h: 700 }), { x: 600, y: 50, w: 200, h: 100 }),
  "top-right offsets are measured from the nearest corner");

console.log("# zoom-correct drag math (seeded-bad: raw client deltas)");
for (const scale of [0.7, 1.0, 1.3, 1.6]) {
  const start = { x: 100, y: 120, w: 300, h: 200 };
  const actual = P.dragByVisual(start, { x: 10, y: 20 }, { x: 140, y: 111 }, scale);
  ok(Math.abs(actual.x - (100 + 130 / scale)) < 1e-9 && Math.abs(actual.y - (120 + 91 / scale)) < 1e-9,
    "visual drag divides by effective zoom at scale " + scale);
}
const badRawClientDelta = { x: 100 + 130, y: 120 + 91 };
const correctAt13 = P.dragByVisual({ x: 100, y: 120, w: 1, h: 1 }, { x: 0, y: 0 }, { x: 130, y: 91 }, 1.3);
guard(badRawClientDelta.x !== correctAt13.x && badRawClientDelta.y !== correctAt13.y,
  "seeded-bad raw client drag fails the 1.3x assertion (it would pass only at 1.0)");
const walkup = { style: { zoom: "1.3" }, parentElement: { style: { zoom: "1.6" }, parentElement: null } };
ok(Math.abs(P.effectiveZoom(walkup) - 2.08) < 1e-12, "effective zoom uses the cumulative ancestor walk-up fallback");
ok(P.cssSizeForRect(302, "content-box", 2) === 300 && P.cssSizeForRect(302, "border-box", 2) === 302,
  "measured border-box geometry writes back without content-box growth");

console.log("# z-stack focus order is normalized inside 60..89");
let stack = [];
stack = P.focusStack(stack, "chat");
stack = P.focusStack(stack, "hotkeys");
stack = P.focusStack(stack, "chat");
const z = P.zForStack(stack);
ok(same(stack, ["hotkeys", "chat"]) && z.hotkeys === 60 && z.chat === 61,
  "refocusing moves a panel to the top and restacks consecutive z values");
const many = Array.from({ length: 32 }, (_, i) => "p" + i).reduce((s, key) => P.focusStack(s, key), []);
ok(many.length === 30 && P.zForStack(many).p31 === 89, "stack never exceeds the z-band ceiling");

console.log("# Esc closes the topmost panel first");
const escStack = P.focusStack(P.focusStack([], "chat"), "hotkeys");
const first = escStack.at(-1);
const second = escStack.slice(0, -1).at(-1);
ok(first === "hotkeys" && second === "chat", "topmost-first pop order is preserved");
guard(first !== "chat", "seeded-bad bottom-pop would fail the Esc topmost assertion");

console.log("# dormant state is identity");
const baseline = { left: "", top: "", width: "", zIndex: "45" };
const result = P.dormant(false, baseline, value => ({ ...value, left: "10px", zIndex: "60" }));
ok(result === baseline && same(result, baseline), "disabled framework returns the exact pre-framework layout object");
globalThis.localStorage = { value: "0", getItem() { return this.value; }, setItem(_key, value) { this.value = value; }, removeItem() { this.value = null; } };
globalThis.DFPanelFrame.setEnabled(false);
let dormantResolverCalls = 0;
globalThis.DFPanelFrame.register({ key: "dormant-test", el() { dormantResolverCalls++; return null; } });
ok(dormantResolverCalls === 0, "disabled register records a panel without resolving or mutating its element");
guard(!same({ ...baseline, left: "10px" }, baseline), "seeded-bad injected title/layout mutation is caught by dormant identity");

console.log("# clamp keeps the whole rect inside reserved chrome without resizing it (PANEL-GEOMETRY-2)");
const clamped = P.clampRect({ x: -900, y: -5, w: 5000, h: 10 }, { w: 800, h: 600 }, { minW: 220, minH: 140, top: 48, bottom: 44, head: 22 });
ok(clamped.w === 800 && clamped.h === 10 && clamped.x === 0 && clamped.y === 48,
  "oversized width shrinks to the work area; an under-minimum height is NOT inflated (min sizes are a resize contract, not a clamp side effect)");
guard(5000 > 800 && -5 < 48, "seeded-bad unclamped restore fails the size and chrome-bound assertions");

console.log("# PANEL-GEOMETRY-2 measured truth (live repro 2026-07-10 @1920x1080)");
// B129 behavior on the screen: dragging the 724-wide build panel right pinned its right edge at
// 1708 (the phantom full-height "right column"), then SHRANK w 1024->902->240 while the inner
// window stayed 724 -- overflow:hidden culled everything past the pin, 212px left of the screen
// edge. And at open, the pre-render skeleton (724x57) was floored to minH 140 and frozen inline,
// culling the 456px-tall window that rendered a moment later.
const dragLimits = { minW: 240, minH: 140, top: 60, right: 0, bottom: 44 };
const dragged = P.clampRect({ x: 1400, y: 896, w: 724, h: 140 }, { w: 1920, h: 1080 }, dragLimits);
ok(dragged.w === 724 && dragged.h === 140 && dragged.x === 1920 - 724,
  "drag stops AT the viewport edge at full size -- position clamps, size never shrinks in place");
const openSkeleton = P.clampRect({ x: 6, y: 979, w: 724, h: 57 }, { w: 1920, h: 1080 }, dragLimits);
ok(same(openSkeleton, { x: 6, y: 979, w: 724, h: 57 }),
  "open-time clamp of the pre-render build skeleton is an identity (no minH inflation to freeze)");
for (const vw of [800, 1024, 1280, 1920])
  ok(P.chromeInsetsFor(vw, 1, 1).right === 0,
    "no full-height right column reserved at " + vw + "px (#rightHud measured 208x204: a corner cluster, not a column)");

console.log("# B129 corner resize: four directions and zoom-correct two-axis math");
const cornerStart = { x: 100, y: 120, w: 400, h: 300 };
for (const scale of [0.7, 1.0, 1.3, 1.6]) {
  const sw = P.resizeByVisual(cornerStart, { x: 10, y: 20 }, { x: 80, y: -15 }, scale, "sw");
  ok(Math.abs(sw.x - (100 + 70 / scale)) < 1e-9 && Math.abs(sw.w - (400 - 70 / scale)) < 1e-9 &&
     Math.abs(sw.h - (300 - 35 / scale)) < 1e-9 && sw.y === 120,
    "SW corner changes width + height with visual deltas divided by zoom at scale " + scale);
  const ne = P.resizeByVisual(cornerStart, { x: 10, y: 20 }, { x: 80, y: -15 }, scale, "ne");
  ok(ne.x === 100 && Math.abs(ne.w - (400 + 70 / scale)) < 1e-9 &&
     Math.abs(ne.y - (120 - 35 / scale)) < 1e-9 && Math.abs(ne.h - (300 + 35 / scale)) < 1e-9,
    "NE corner changes width + height in the opposite signed directions at scale " + scale);
}
const badCornerAt13 = { x: 170, w: 330, h: 265 };
const goodCornerAt13 = P.resizeByVisual(cornerStart, { x: 10, y: 20 }, { x: 80, y: -15 }, 1.3, "sw");
guard(badCornerAt13.x !== goodCornerAt13.x && badCornerAt13.w !== goodCornerAt13.w && badCornerAt13.h !== goodCornerAt13.h,
  "seeded-bad raw corner deltas fail away from scale 1.0");

console.log("# B129 strict open/restore clamp reserves live-scale chrome");
for (const scale of [0.7, 1.0, 1.3, 1.6]) {
  // Scaled host: viewport and chrome both convert back to the host's panel space.
  const viewport = { w: 1024 / scale, h: 768 / scale };
  const inset = P.chromeInsetsFor(1024, scale, scale);
  const stale = P.rectFromEntry({ anchor: "tr", x: 16, y: 12, w: 1200, h: 900 }, viewport);
  const fixed = P.clampRect(stale, viewport, { ...inset, minW: 240, minH: 140 });
  ok(fixed.x >= inset.left && fixed.y >= inset.top &&
     fixed.x + fixed.w <= viewport.w - inset.right + 1e-9 &&
     fixed.y + fixed.h <= viewport.h - inset.bottom + 1e-9,
    "stale 2560-era geometry restores fully inside a 1024px viewport at scale " + scale);
  // Unscaled panel: scaled HUD reserves grow in its coordinate space instead of skipping /Z.
  const unscaledInset = P.chromeInsetsFor(1024, scale, 1);
  const unscaled = P.clampRect({ x: 900, y: 0, w: 900, h: 900 }, { w: 1024, h: 768 },
    { ...unscaledInset, minW: 220, minH: 140 });
  ok(unscaled.x + unscaled.w <= 1024 - unscaledInset.right + 1e-9 && unscaled.y >= unscaledInset.top,
    "unscaled panel uses the scaled chrome reserve at UI scale " + scale);
}
guard(P.clampRect({ x: 900, y: 0, w: 900, h: 900 }, { w: 1024, h: 768 },
  { minW: 220, minH: 140, top: 48, right: 40, bottom: 44 }).x + P.clampRect({ x: 900, y: 0, w: 900, h: 900 },
  { w: 1024, h: 768 }, { minW: 220, minH: 140, top: 48, right: 40, bottom: 44 }).w <= 1024 - 40,
  "an explicitly measured right inset (a genuine column) still binds the clamp");

console.log("# B129 directional resize bounds preserve max chrome clearance and minimum floors");
const bounds = { top: 48, right: 164, bottom: 44, left: 0, minW: 240, minH: 140 };
const boundedStart = { x: 100, y: 100, w: 400, h: 300 };
const hugeSE = P.resizeByVisual(boundedStart, { x: 0, y: 0 }, { x: 5000, y: 5000 }, 1, "se");
const cappedSE = P.clampResizeRect(boundedStart, hugeSE, "se", { w: 1024, h: 768 }, bounds);
ok(cappedSE.x + cappedSE.w === 860 && cappedSE.y + cappedSE.h === 724,
  "SE growth caps at the right control column and bottom chrome boundary");
const tinySE = P.resizeByVisual(boundedStart, { x: 0, y: 0 }, { x: -5000, y: -5000 }, 1, "se");
const flooredSE = P.clampResizeRect(boundedStart, tinySE, "se", { w: 1024, h: 768 }, bounds);
ok(flooredSE.w === 240 && flooredSE.h === 140, "resize-to-near-zero enforces the declared 240x140 floor");
const tinyNW = P.resizeByVisual(boundedStart, { x: 0, y: 0 }, { x: 5000, y: 5000 }, 1, "nw");
const flooredNW = P.clampResizeRect(boundedStart, tinyNW, "nw", { w: 1024, h: 768 }, bounds);
ok(flooredNW.w === 240 && flooredNW.h === 140 && flooredNW.x + flooredNW.w === 500 && flooredNW.y + flooredNW.h === 400,
  "NW minimum clamp keeps the opposite right/bottom edges fixed");

console.log("# B129 corner affordance and variant-transition wiring");
const frameSource = readJs("dwf-panelframe.js");
const cssSource = fs.readFileSync(path.resolve(here, "../../web/css/dwf.css"), "utf8");
for (const corner of ["nw", "ne", "sw", "se"])
  ok(new RegExp('pf-grip pf-grip-' + corner).test(frameSource), "framework injects the " + corner.toUpperCase() + " corner grip");
ok(/\.pf-grip \{[^}]*width: 22px; height: 22px;/s.test(cssSource), "corner grips expose a 22x22 hit target");
ok(/\.pf-grip:hover \{/.test(cssSource), "corner grips have a hover affordance (discoverable before first use)");
ok(/#clientPanel\.build-panel \{[^}]*display: flex/s.test(cssSource) && /\.build-window \{[^}]*flex: 1 1 auto/s.test(cssSource),
  "build panel host owns the box and .build-window stretches to fill it (single geometry source)");
ok(/if \(spec && !spec\.resizable\) return;/.test(frameSource),
  "move-only panels never get inline width/height (B134: the players list grows with the roster)");
ok(/variantChanged[\s\S]*syncOpenState\(spec\.key, now\)/s.test(frameSource) &&
   /state\.layoutKey !== lk[\s\S]*clearRectStyles\(el\)[\s\S]*savedV[\s\S]*clampOpenRect/s.test(frameSource),
  "visible content-host variant changes clear old inline geometry before restore/open clamp");

console.log("# per-migrated-panel registration contract (M2..M6 consumers wire the framework)");
// Each migrated panel file must call DFPanelFrame.register with its stable key, the correct drag
// handle (headSel adopted from the panel's own header -- never a framework-injected .pf-head for
// these, since every one has a real header), and the flags its behavior class requires. Source-
// level assertions in the manner of uiflow_test: the wiring is a static register({...}) literal,
// and a regression that renames a key, drops headSel, or removes the Esc participation fails here
// rather than silently shipping. Keys are contract (module header of dwf-panelframe.js).
const migrations = {
  chat:      { file: "dwf-chat.js",           headSel: ".dfchat-head", resizable: true,  escClosable: true },
  audio:     { file: "dwf-audio.js",          headSel: "h4",           resizable: false, escClosable: true, zBandFalse: true },
  hotkeys:   { file: "dwf-hotkeys.js",        headSel: ".hk-head",     resizable: true,  escClosable: true, persistOpenFalse: true },
  lobby:     { file: "dwf-lobby.js",          headSel: "h3",           resizable: false, escClosable: true, persistOpenFalse: true },
  combatlog: { file: "dwf-combatlog-panel.js",headSel: ".cl-help",     resizable: true,  closable: false, escClosable: true, persistOpenFalse: true },
  analytics: { file: "dwf-analytics-panel.js",headSel: ".an-head",     resizable: true,  escClosable: true, persistOpenFalse: true },
  vote:      { file: "dwf-vote.js",           headSel: ".vt-head",     resizable: true,  escClosable: true, persistOpenFalse: true },
};
const rx = (field, value) => new RegExp(field + "\\s*:\\s*" + value);
for (const [key, m] of Object.entries(migrations)) {
  const src = readJs(m.file);
  ok(/DFPanelFrame\.register\s*\(/.test(src), key + ": calls DFPanelFrame.register");
  ok(rx("key", '"' + key + '"').test(src), key + ": registers under its stable key");
  ok(rx("headSel", '"' + m.headSel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"').test(src),
    key + ': adopts its own header (headSel "' + m.headSel + '") as the drag handle');
  ok(rx("closable", String(m.closable !== false)).test(src), key +
    (m.closable === false ? ": preserves native no-X chrome" : ": is closable (gets an X)"));
  ok(rx("escClosable", "true").test(src) === !!m.escClosable, key + ": Esc-stack participation matches contract");
  ok(/resizable\s*:\s*\{/.test(src) === !!m.resizable, key + ": resizable-with-mins matches contract (" + !!m.resizable + ")");
  if (m.persistOpenFalse)
    ok(rx("persistOpen", "false").test(src), key + ": session-semantic -> persistOpen:false (geometry persists, open-state does not)");
  if (m.zBandFalse)
    ok(rx("zBand", "false").test(src), key + ": keeps its own z-index (zBand:false)");
  // Every migrated panel keeps the framework/open-state in sync through its own opener.
  ok(new RegExp('syncOpenState\\s*\\(\\s*"' + key + '"').test(src), key + ": syncs open-state on its own open/close");
}
// M5 fix pin: the lobby shell (its <h3> drag handle) MUST be built before register(), or attach()
// finds no h3, injects a throwaway .pf-head, and the first render() wipes head + X + drag. A revert
// of that ordering fix regresses this cell.
const lobbySrc = readJs("dwf-lobby.js");
const iShell = lobbySrc.indexOf("ensureShell(panel)");
const iReg = lobbySrc.indexOf("DFPanelFrame.register");
ok(iShell >= 0 && iReg >= 0 && iShell < iReg,
  "lobby builds its <h3> shell before register() so the framework adopts the real header");
guard(!Object.keys(migrations).some(k => rx("key", '"pf-nonexistent"').test(readJs(migrations[k].file))),
  "seeded-bad: the contract matcher does not spuriously match an unregistered key");

console.log("# complete registration inventory");
const registrationFiles = ["dwf-panelframe.js", "dwf-chat.js", "dwf-audio.js",
  "dwf-hotkeys.js", "dwf-lobby.js", "dwf-combatlog-panel.js", "dwf-core.js",
  "dwf-controls-placement.js", "dwf-analytics-panel.js", "dwf-vote.js"];
const registeredKeys = registrationFiles.flatMap(file =>
  [...readJs(file).matchAll(/(?:DFPanelFrame\.)?register\s*\(\s*\{\s*key:\s*"([^"]+)"/g)].map(match => match[1]));
const expectedKeys = ["analytics", "audio", "chat", "clientPanel", "combatlog", "hotkeys", "lobby", "selection", "settingsMenu", "vote", "zonePalette"];
ok(same([...registeredKeys].sort(), expectedKeys),
  "exactly the eleven audited stable keys are registered (" + [...registeredKeys].sort().join(", ") + ")");

console.log("# B146 zone palette registration (dwf-controls-placement.js)");
const controlsSrc = readJs("dwf-controls-placement.js");
{
  const at = controlsSrc.indexOf('key: "zonePalette"');
  const block = controlsSrc.slice(at, at + 620);
  ok(at >= 0, "zonePalette registers under its stable key");
  ok(/closable:\s*true/.test(block), "zonePalette is closable (framework X drives closeZoneMode)");
  ok(/resizable:\s*\{\s*minW:\s*260,\s*minH:\s*200\s*\}/.test(block), "zonePalette is resizable with a 260x200 minimum");
  ok(/zBand:\s*false/.test(block), "zonePalette keeps CSS z60 (zone editor z75 stays above it)");
  ok(/escClosable:\s*false/.test(block), "zonePalette stays OUT of the Esc stack (the cascade owns zone back-out)");
  ok(/persistOpen:\s*false/.test(block), "zonePalette open-state is a tool mode -> only geometry persists");
  ok(/menu:\s*false/.test(block), "zonePalette is excluded from the cog Panels list");
  ok(/closeZoneMode\(\);\s*setActiveToolbar\(null\)/.test(block), "framework close routes through closeZoneMode + toolbar reset");
  ok(/syncOpenState\("zonePalette", true\)/.test(controlsSrc) && /syncOpenState\("zonePalette", false\)/.test(controlsSrc),
    "enterZoneMenu/closeZoneMode synchronize framework open-state");
  ok(/DOMContentLoaded", registerZonePalette/.test(controlsSrc),
    "registration is deferred to DOMContentLoaded (panelframe.js loads after controls-placement.js)");
  ok(/#zonePalette:has\(> \.pf-head\)/.test(cssSource) && /#zonePalette > \.pf-head \{ position: sticky/.test(cssSource),
    "framed palette gets host chrome + a sticky head; dormant (no .pf-head) keeps the WD-14 two-plate look");
}

console.log("# B142 tile-occupant chooser dock (CSS contract)");
ok(/#selection\.tile-list-panel \{ bottom: 90px; z-index: 8990; \}/.test(cssSource),
  "chooser docks above the chat toggle (bottom 90) and stacks over the bottom-left HUD (z8990 > chat 8981)");
guard(!/#selection\.tile-list-panel[^}]*z-index:\s*45/.test(cssSource),
  "seeded-bad: the chooser inheriting #selection's z45 would sit under the chat toggle/panel again");

console.log("# M7/M8 content-host registration (#clientPanel + #selection)");
// These two hosts are re-skinned by ~10 writer modules with wholesale innerHTML, so they use the
// content-wrapper seam (contentHost) instead of adopting a header out of their own content. The
// registration lives in core.js (owns the host consts + closeSelection). Static assertions in the
// uiflow_test manner: a regression that drops contentHost, flips a z/Esc flag, or renames a key
// fails here rather than shipping flicker.
const core = readJs("dwf-core.js");
for (const key of ["clientPanel", "selection"]) {
  const block = core.slice(core.indexOf('key: "' + key + '"'), core.indexOf('key: "' + key + '"') + 700);
  ok(rx("key", '"' + key + '"').test(core), key + ": registers under its stable key");
  ok(/contentHost:\s*true/.test(block), key + ": is a contentHost (persistent header + .pf-content seam)");
  ok(/movable:\s*true/.test(block), key + ": is movable");
  // WAVE 4: `closable` is VARIANT-AWARE on #selection (native has no close X on the unit profile or
  // the stock-item sheet; ESC dismisses them). B232 R2: #clientPanel joins the same pattern -- the
  // native ALERT BOX (oracle B232-oracle-native.png) has no close chrome of any kind ("Right click
  // to close."), so its variant declares close-less and every other skin keeps its close.
  if (key === "clientPanel")
    ok(/closable:\s*clientClosable/.test(block),
      key + ": is closable PER VARIANT (the native alert box carries no close chrome -- B232 R2)");
  else
    ok(/closable:\s*selectionClosable/.test(block),
      key + ": is closable PER VARIANT (the ESC-only native sheets carry no close chrome)");
  ok(/resizable:\s*\{\s*minW:\s*240,\s*minH:\s*140\s*\}/.test(block), key + ": resizable with a 240x140 minimum");
  ok(/zBand:\s*false/.test(block), key + ": keeps its CSS z-index (zBand:false -> preserves zone-panel/palette stacking)");
  ok(/escClosable:\s*false/.test(block), key + ": stays OUT of the Esc stack (cascade branches own its back-out)");
  ok(/persistOpen:\s*false/.test(block), key + ": content-driven open -> only geometry persists");
  ok(/menu:\s*false/.test(block), key + ": excluded from the cog Panels list (no single reopen)");
  ok(/variantKey:\s*el\s*=>/.test(block), key + ": persists geometry per skin (variantKey)");
  ok(/adoptHeadSel:\s*"/.test(block), key + ": declares skin headers for framework adoption (B159)");
}
// The close-less list is EVIDENCE-BOUND, not a convenience: exactly the native sheets that have
// no close X in their oracles. A new entry here silently deletes a real close affordance, so the
// cell pins the list itself, and pins that the predicate is a NEGATION of it (a typo'd predicate
// that returned `true` for the list would leave the X and read as compliance).
// B217 r2 added "zone-panel": NO native zone panel carries an X (B217-2, Z12-jt-1/3/4,
// Z11-19/20/21, LEVER-LINK-1/3, "Menu Oracle Screenshots/barracks zone .png"); ESC and map
// clicks dismiss, and the sub-panels carry native's gold back arrow.
ok(/const ESC_ONLY_SELECTION_VARIANTS = \["unit-sheet-panel", "stock-item-panel", "zone-panel"\];/.test(core),
  "the ESC-only variants are EXACTLY the unit profile, the stock-item sheet, and the zone family (native: no close X)");
ok(/const selectionClosable = el =>\s*\n?\s*!ESC_ONLY_SELECTION_VARIANTS\.includes\(PV\(el\.className, SELECTION_VARIANTS\)\);/.test(core),
  "selectionClosable is the NEGATION of that list, resolved through primaryVariant");
guard(!/closable:\s*true,\s*menu:\s*false,\s*adoptHeadSel:\s*"\.unit-sheet-header/.test(core),
  "seeded-bad: a flat `closable: true` on #selection is what made deleting the sheet's X un-hide " +
  "the framework title bar and stack a fresh ✕");
ok(/adoptHeadSel:\s*"\.unit-sheet-header,\.stock-item-header,\.sp-header,\.farm-native-head,\.bld-head"/.test(core),
  "selection adopts every skin-owned header (unit sheet / stock item / stockpile / farm / bld family)");
ok(/adoptHeadSel:\s*"\.build-head,\.info-header,\.alertbox-hint"/.test(core),
  "clientPanel adopts the build menu, info-window headers, and the alert box's hint line (B232 R2)");
// B232 R2: the close-less clientPanel variant list is EVIDENCE-BOUND like the selection one --
// exactly the native alert box, whose oracle shows no close X anywhere (right click closes).
ok(/const clientClosable = el => PV\(el\.className, CLIENT_VARIANTS\) !== "alertbox-panel";/.test(core),
  "the close-less clientPanel variant is EXACTLY the native alert box");
guard(!/key: "clientPanel"[\s\S]{0,200}closable:\s*true/.test(core),
  "seeded-bad: a flat `closable: true` on #clientPanel would stack a framework ✕ on the native alert box");
ok(/if \(document\.readyState === "loading"\) window\.addEventListener\("DOMContentLoaded", registerContentHosts\)/.test(core),
  "registration is deferred to DOMContentLoaded (panelframe.js loads after core.js in index.html)");
ok(/function panelContent\(host\)/.test(core) && /window\.DFPanelFrame\.contentEl/.test(core),
  "core exposes the shared panelContent() writer seam guarded for an old cached page");

// ---- TIER-AWARE GEOMETRY KEYS (fix-width): a wide skin must NOT share the narrow skin's slot ----
// The movable/resizable content hosts persist ONE saved rect per variantKey. Because
// primaryVariant collapses every squads view to "squads-sidebar" and every zone skin to "zone-panel",
// the ~300px root list shared a geometry slot with the ~880-2048px deep editors, and the 420px zone
// info panel shared one with the 620px zone sub-panels -- so a saved narrow rect froze an inline
// width onto the wide skin and its columns collapsed. The fix appends a width-tier suffix off the
// family's own host-flag classes WITHOUT growing CLIENT_VARIANTS/SELECTION_VARIANTS (clientFillSel /
// selectionClosable / ESC_ONLY depend on PV still returning the base variant). Execute the REAL
// variantKey functions out of the shipped source so a regression that drops the suffix fails here.
console.log("# fix-width: tier-aware geometry keys for wide client/selection hosts");
const PV = P.primaryVariant;
const CLIENT_VARIANTS = eval(core.match(/const CLIENT_VARIANTS = (\[[^\]]*\]);/)[1]);
const SELECTION_VARIANTS = eval(core.match(/const SELECTION_VARIANTS = (\[[\s\S]*?\]);/)[1]);
const clientBlock = core.slice(core.indexOf('key: "clientPanel"'), core.indexOf('key: "selection"'));
const selBlock = core.slice(core.indexOf('key: "selection"'), core.indexOf('key: "selection"') + 900);
function extractVariantKey(block) {
  const start = block.indexOf("variantKey:");
  const end = block.indexOf("isOpen:", start);
  return block.slice(start + "variantKey:".length, end).trim().replace(/,\s*$/, "");
}
function compileVariantKey(exprSrc) {
  return new Function("PV", "CLIENT_VARIANTS", "SELECTION_VARIANTS", "return (" + exprSrc + ");")(
    PV, CLIENT_VARIANTS, SELECTION_VARIANTS);
}
const elFor = className => ({
  className,
  classList: { contains: c => className.split(/\s+/).includes(c) },
});
const clientKey = compileVariantKey(extractVariantKey(clientBlock));
const selKey = compileVariantKey(extractVariantKey(selBlock));

// squads: the root list and each wide tier must land on DISTINCT keys, and the base variant survives.
const kList  = clientKey(elFor("visible squads-sidebar"));
const kWide  = clientKey(elFor("visible squads-sidebar squads-wide"));
const kCtx   = clientKey(elFor("visible squads-sidebar squads-wide squads-contextual"));
const kEquip = clientKey(elFor("visible squads-sidebar squads-wide squads-equipment"));
ok(kList === "clientPanel.squads-sidebar", "squads root LIST keeps the base slot (clientPanel.squads-sidebar)");
ok(kWide === "clientPanel.squads-sidebar.wide", "plain wide tier gets .wide");
ok(kCtx === "clientPanel.squads-sidebar.ctx", "contextual (schedule/routines) tier gets .ctx");
ok(kEquip === "clientPanel.squads-sidebar.equip", "equipment (widest) tier gets .equip");
ok(new Set([kList, kWide, kCtx, kEquip]).size === 4,
  "list and all three wide tiers persist INDEPENDENT geometry (four distinct slots)");
ok(kList !== kWide && kList !== kCtx && kList !== kEquip,
  "the narrow list never shares a slot with any wide editor (the reported bug is structurally gone)");
// non-squads clientPanel skins are untouched (no squads-wide -> no suffix).
ok(clientKey(elFor("visible build-panel")) === "clientPanel.build-panel",
  "a non-squads client skin (build menu) keeps its plain key -- CLIENT_VARIANTS was not grown");

// zone: the 420px info panel and the 620px wide sub-panels must land on DISTINCT keys.
const kZone = selKey(elFor("visible building-panel zone-panel"));
const kZoneWide = selKey(elFor("visible building-panel zone-panel zone-wide"));
ok(kZone === "selection.zone-panel", "narrow zone info panel keeps the base slot (selection.zone-panel)");
ok(kZoneWide === "selection.zone-panel.wide", "wide zone sub-panels (squad/animal/owner) get .wide");
ok(kZone !== kZoneWide, "the 420px zone info panel no longer shares a slot with the 620px sub-panels");
ok(selKey(elFor("visible unit-sheet-panel")) === "selection.unit-sheet-panel",
  "a non-zone selection skin (unit sheet) keeps its plain key -- SELECTION_VARIANTS was not grown");

// TEST-THE-TEST: the PRE-FIX key (base variant, no suffix) is what made list and wide collide. Prove
// that shape would fail the distinctness assertions above -- otherwise the guard is worthless.
const preFixClientKey = el => "clientPanel." + PV(el.className, CLIENT_VARIANTS);
const preFixSelKey = el => "selection." + PV(el.className, SELECTION_VARIANTS);
guard(preFixClientKey(elFor("visible squads-sidebar")) ===
      preFixClientKey(elFor("visible squads-sidebar squads-wide squads-contextual")),
  "the pre-fix client key really did collapse the list and a wide editor onto ONE slot");
guard(preFixSelKey(elFor("visible building-panel zone-panel")) ===
      preFixSelKey(elFor("visible building-panel zone-panel zone-wide")),
  "the pre-fix selection key really did collapse the narrow and wide zone panels onto ONE slot");

console.log("# write-site completeness: every host writer targets panelContent(), none the host directly");
// Completeness is the whole game -- a single missed `host.innerHTML =` reintroduces the header-
// death this wave exists to kill. Every writer file's innerHTML write to a host must route through
// panelContent(host); a bare write (not preceded by the panelContent( call) fails here.
const WRITERS = ["dwf-core.js", "dwf-announcements.js", "dwf-build-info-panels.js",
  "dwf-fort-panels.js", "dwf-labor-work-orders.js", "dwf-squads.js",
  "dwf-unit-hud-notifications.js", "dwf-building-zone-stockpile-panels.js",
  "dwf-hospital-panel.js", "dwf-tradedepot-panel.js"];
let bareWrites = 0, routedWrites = 0;
for (const f of WRITERS) {
  const src = readJs(f);
  for (const host of ["clientPanel", "selection"]) {
    const bare = (src.match(new RegExp("(^|[^(])\\b" + host + "\\.innerHTML\\s*=", "gm")) || []).length;
    const routed = (src.match(new RegExp("panelContent\\(" + host + "\\)\\.innerHTML\\s*=", "g")) || []).length;
    bareWrites += bare; routedWrites += routed;
    ok(bare === 0, f + ": no bare " + host + ".innerHTML write (all routed through panelContent)");
  }
}
ok(routedWrites >= 45, "the full writer set is converted (" + routedWrites + " panelContent innerHTML sites)");
// unitcycle's tile-occupant chooser writes #selection via textContent/appendChild -- also seamed.
const unitcycle = readJs("dwf-unitcycle.js");
ok(/DFPanelFrame\.contentEl\(sel\)/.test(unitcycle) && !/(^|[^(])\bsel\.textContent\s*=\s*''/.test(unitcycle.replace(/content\.textContent/g, "")),
  "unitcycle chooser writes #selection through the content wrapper");
guard(/(^|[^(])\bclientPanel\.innerHTML\s*=/.test("x = clientPanel.innerHTML = 'y'"),
  "seeded-bad: the bare-write matcher would catch an un-routed host.innerHTML write");

console.log("# primaryVariant: most-specific-first per-skin persistence key");
const SEL_PRI = ["tile-list-panel", "stock-item-panel", "unit-sheet-panel", "stockpile-panel",
  "zone-panel", "farm-panel", "workshop-panel", "td-depot-panel", "hosp-panel", "building-panel"];
ok(P.primaryVariant("visible building-panel zone-panel zone-wide", SEL_PRI) === "zone-panel",
  "a building-panel zone editor maps to zone-panel, not the shared building-panel base");
ok(P.primaryVariant("visible building-panel", SEL_PRI) === "building-panel", "a plain building maps to building-panel");
ok(P.primaryVariant("visible building-panel workshop-panel", SEL_PRI) === "workshop-panel", "a workshop maps to workshop-panel");
ok(P.primaryVariant("", SEL_PRI) === "default" && P.primaryVariant("visible foo", SEL_PRI) === "default",
  "an unknown/empty skin falls back to a single default key");
guard(P.primaryVariant("visible building-panel zone-panel", SEL_PRI) !== "building-panel",
  "seeded-bad: a base-first priority would mis-key every zone editor as building-panel");

console.log("# seeded-bad legacy writer: a direct host.innerHTML must not destroy the header");
runHealCell();

console.log("# B145 one close per panel: framework X yields to a skin's own close and returns after it");
runCloseReconcileCell();

console.log("# B159 head adoption: a skin's own header becomes the framework head (no double header)");
runHeadAdoptionCell();

console.log("# WAVE 4 variant-aware `closable`: an ESC-only skin ends with ZERO close chrome and NO title bar");
runCloseLessVariantCell();
runEscTeardownContractCell();

console.log("# B167 panel scroll-fill: resize tracking, live chain marks, and content-sized exemptions");
const smallFill = P.scrollFillHeight(280, 96);
const largeFill = P.scrollFillHeight(520, 96);
ok(smallFill === 184 && largeFill === 424 && largeFill - smallFill === 240,
  "seeded panel resize passes its full height delta to the designated scroll region");
const seededBadFixedList = [190, 190];
guard(seededBadFixedList[1] - seededBadFixedList[0] !== largeFill - smallFill,
  "seeded-bad fixed-height list fails the resize-tracking contract cell");
ok(/\.pf-fill-scroll\s*\{[^}]*flex:\s*1 1 auto !important;[^}]*min-height:\s*0 !important;[^}]*height:\s*auto !important;[^}]*max-height:\s*none !important;[^}]*overflow-y:\s*auto !important;/s.test(cssSource),
  "designated scroll CSS owns remaining height, can shrink, drops fixed caps, and scrolls vertically");
ok(/#clientPanel\.pf-fill-host > \.pf-content,[\s\S]*#selection\.pf-fill-host > \.pf-content\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s.test(cssSource),
  "content-host wrapper is the flex-column height bridge between panel box and skin");
ok(/\.farm-crop-list:not\(\.pf-fill-scroll\)/.test(cssSource) &&
   /\.kitchen-scroll:not\(\.pf-fill-scroll\)/.test(cssSource) &&
   /\.workshop-task-list:not\(\.pf-fill-scroll\)/.test(cssSource),
  "old viewport caps are dormant-only fallbacks, not active framework geometry");
ok(/fillSel:\s*clientFillSel/.test(core) && /fillSel:\s*selectionFillSel/.test(core),
  "both content hosts resolve the active skin's designated scroll region through the framework");
ok(!/fillSel:/.test(lobbySrc.slice(iReg, iReg + 420)),
  "players/lobby registration stays exempt: move-only and content-sized (B134)");
runScrollFillCell();

console.log("# ESC-HANG repro: the Esc close path (wholesale className wipe + wrapper clear) must SETTLE");
runEscCloseSettleCell();

console.log("# ESC-HANG close-vocabulary unification: a [data-pf-close] skin close (spe shape) is one close");
runSpeCloseUnificationCell();

console.log("# ESC-HANG defense in depth: settle budget survives a seeded-divergent reconciler");
runSettleBudgetCell();

console.log("\n" + (failed ? "FAIL" : "PASS") + ": " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;

// --- DOM shim just large enough to drive attach()->buildChrome + the reconcile MutationObservers.
// The shim's MutationObserver QUEUES callbacks (drained by flush()) so the cells can assert the
// exact moment a legacy write has destroyed the header, THEN that the heal restores it -- proving
// the heal is the load-bearing defense, not incidental timing.
//
// BROWSER-FAITHFUL MUTATION SEMANTICS (the ESC-HANG lesson): per the DOM spec's DOMTokenList
// "update steps", classList.add/remove ALWAYS re-set the class attribute when one exists -- even
// when the token set did not change -- and setting an attribute queues a mutation record even for
// an identical value. An earlier shim notified only on real changes, and exactly that infidelity
// hid an unguarded classList.remove() that spun the real browser's class observer into an infinite
// microtask loop (the Esc-close dead tab). Observers are typed (childList/subtree/attributes +
// attributeFilter) so a class write reaches only the observers a real browser would invoke.
// querySelector understands ".class", "[attr]", and "[attr='v']" tokens (compound allowed).
function domShim() {
  const pending = [];
  const rafQ = [];
  class Style { constructor() { this.cssText = ""; } }
  class El {
    constructor(tag) { this.tagName = tag; this.nodeType = 1; this._c = new Set(); this._hasClassAttr = false; this._attrs = {}; this.childNodes = []; this.style = new Style(); this.dataset = {}; this.parentElement = null; this.id = ""; this.textContent = ""; this._obs = []; this._li = {}; }
    get className() { return [...this._c].join(" "); }
    set className(v) { this._c = new Set(String(v).split(/\s+/).filter(Boolean)); this._hasClassAttr = true; this._notifyAttr("class"); }
    get classList() {
      const self = this;
      return {
        contains: c => self._c.has(c),
        // Faithful: add/remove run the update steps and re-set the attribute regardless of
        // whether the token set changed (the sole spec exception: remove on an element with no
        // class attribute and an empty token set is a silent no-op).
        add: c => { self._c.add(c); self._hasClassAttr = true; self._notifyAttr("class"); },
        remove: c => { if (!self._hasClassAttr && self._c.size === 0) return; self._c.delete(c); self._notifyAttr("class"); },
      };
    }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    _detach(n) { if (n.parentElement) { const i = n.parentElement.childNodes.indexOf(n); if (i >= 0) n.parentElement.childNodes.splice(i, 1); } }
    appendChild(n) { this._detach(n); n.parentElement = this; this.childNodes.push(n); this._notifyChildList(); return n; }
    insertBefore(n, ref) { this._detach(n); n.parentElement = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n); this._notifyChildList(); return n; }
    remove() { const p = this.parentElement; this._detach(this); this.parentElement = null; if (p) p._notifyChildList(); }
    set innerHTML(v) { this.childNodes.forEach(n => { n.parentElement = null; }); this.childNodes = []; if (v) { const t = new El("div"); t._c.add("written-content"); t.parentElement = this; this.childNodes.push(t); } this._notifyChildList(); }
    get innerHTML() { return ""; }
    setAttribute(k, v) { this._attrs[k] = String(v); this._notifyAttr(k); }
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
    removeAttribute(k) { if (k in this._attrs) { delete this._attrs[k]; this._notifyAttr(k); } }
    _match(sel) {
      let s = String(sel);
      if (!s) return false;
      while (s.length) {
        if (s[0] === ".") {
          const m = s.match(/^\.([\w-]+)/);
          if (!m || !this._c.has(m[1])) return false;
          s = s.slice(m[0].length);
        } else if (s[0] === "[") {
          const m = s.match(/^\[([\w-]+)(?:='([^']*)')?\]/);
          if (!m) return false;
          const v = this.getAttribute(m[1]);
          if (v == null || (m[2] !== undefined && v !== m[2])) return false;
          s = s.slice(m[0].length);
        } else return false;
      }
      return true;
    }
    querySelector(sel) {
      const tokens = String(sel).split(",").map(s => s.trim());
      const walk = node => {
        for (const kid of node.children) {
          if (tokens.some(t => kid._match(t))) return kid;
          const hit = walk(kid);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    }
    querySelectorAll(sel) {
      const tokens = String(sel).split(",").map(s => s.trim());
      const out = [];
      const walk = node => node.children.forEach(kid => { if (tokens.some(t => kid._match(t))) out.push(kid); walk(kid); });
      walk(this);
      return out;
    }
    addEventListener(t, f) { (this._li[t] = this._li[t] || []).push(f); }
    // Typed delivery mirrors real observer routing: childList records reach childList observers on
    // the mutation's parent (or an ancestor via subtree); attribute records reach attribute
    // observers on the node itself (or an ancestor via subtree), honoring attributeFilter.
    _notifyChildList() {
      for (let n = this, depth = 0; n; n = n.parentElement, depth++)
        n._obs.forEach(o => { if (o.opts.childList && (depth === 0 || o.opts.subtree)) o._queue(); });
    }
    _notifyAttr(name) {
      for (let n = this, depth = 0; n; n = n.parentElement, depth++)
        n._obs.forEach(o => {
          if (!o.opts.attributes || (depth > 0 && !o.opts.subtree)) return;
          if (o.opts.attributeFilter && !o.opts.attributeFilter.includes(name)) return;
          o._queue();
        });
    }
  }
  const headOf = host => host.children.find(n => n._c.has("pf-head")) || null;
  const doc = { createElement: tag => new El(tag) };
  const prev = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, MutationObserver: globalThis.MutationObserver, requestAnimationFrame: globalThis.requestAnimationFrame, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight, console: globalThis.console, localStorage: globalThis.localStorage };
  const counters = { warns: 0, errors: 0, lastError: "" };
  globalThis.document = doc;
  globalThis.getComputedStyle = () => ({ display: "block", zoom: "1", boxSizing: "content-box", paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0", borderLeftWidth: "0", borderRightWidth: "0", borderTopWidth: "0", borderBottomWidth: "0" });
  globalThis.innerWidth = 1920; globalThis.innerHeight = 1080;
  globalThis.console = { log: prev.console.log.bind(prev.console), warn: () => { counters.warns++; }, error: (...a) => { counters.errors++; counters.lastError = a.join(" "); } };
  globalThis.localStorage = { value: null, getItem() { return this.value; }, setItem(_k, v) { this.value = v; }, removeItem() { this.value = null; } };
  globalThis.requestAnimationFrame = fn => (rafQ.push(fn), rafQ.length);
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.opts = {}; this._el = null; }
    observe(el, opts) { this.opts = opts || {}; if (this._el && this._el !== el) this.disconnect(); this._el = el; if (!el._obs.includes(this)) el._obs.push(this); }
    disconnect() { if (this._el) { const i = this._el._obs.indexOf(this); if (i >= 0) this._el._obs.splice(i, 1); } this._el = null; }
    // One queued delivery per observer per checkpoint (real observers batch records per callback).
    _queue() { if (!pending.includes(this.cb)) pending.push(this.cb); }
  };
  // Drain the observer microtask queue for up to `rounds` checkpoints. Returns true iff the DOM
  // SETTLED (queue empty) -- a divergent reconciler leaves work pending forever, which in a real
  // browser is an unbounded microtask loop and a dead tab.
  const flush = (rounds = 8) => { for (let i = 0; i < rounds && pending.length; i++) { const q = pending.splice(0); q.forEach(cb => cb()); } return pending.length === 0; };
  // Run one animation frame's rAF callbacks (the framework's settle-budget reset/re-arm), then
  // drain whatever they caused. A spinning microtask queue never reaches a frame -- exactly why
  // the budget must count passes-per-frame rather than trust a timer.
  const frame = () => { const q = rafQ.splice(0); q.forEach(fn => fn()); return flush(); };
  const restore = () => { Object.assign(globalThis, prev); };
  return { El, headOf, flush, frame, restore, counters };
}

function runHealCell() {
  const { El, headOf, flush, restore, counters } = domShim();
  try {
    const host = new El("div"); host.id = "selection";
    host.className = ""; // starts hidden/unskinned; not "visible" -> class observer stays quiet
    globalThis.DFPanelFrame.setEnabled(true);
    globalThis.DFPanelFrame.register({
      key: "healcell", el: () => host, title: "Selection", contentHost: true, movable: true,
      closable: true, menu: false, resizable: { minW: 240, minH: 140 }, zBand: false,
      escClosable: false, persistOpen: false, isOpen: () => host._c.has("visible"),
    });
    flush(); // settle any build-time notifications
    ok(!!headOf(host), "attach injects a persistent .pf-head onto the content host");
    const builtHead = headOf(host);

    // A CONVERTED writer targets the wrapper: header untouched, no heal, no warn.
    const beforeWarn = counters.warns;
    globalThis.DFPanelFrame.contentEl(host).innerHTML = "converted render";
    flush();
    ok(headOf(host) === builtHead && counters.warns === beforeWarn,
      "a converted writer (panelContent) leaves the header intact with no heal/warn");

    // A LEGACY writer hits the host directly -> header is destroyed at this instant...
    host.innerHTML = "legacy render";
    ok(!headOf(host), "(test-the-test) a direct host.innerHTML write destroys the header before heal runs");
    guard(headOf(host) === null, "seeded-bad: without the heal the framework header stays gone");

    // ...and the heal observer restores it loudly on the next tick.
    flush();
    ok(!!headOf(host), "the heal observer re-injects the framework header after a legacy write");
    ok(counters.warns === beforeWarn + 1, "the heal warns exactly once (loud detection of the missed writer)");
    ok(host.children.some(n => n._c.has("pf-content")) && !host.children.some(n => n._c.has("written-content")),
      "healed content is re-wrapped inside .pf-content (graceful degradation, not lost)");
  } finally {
    globalThis.DFPanelFrame.setEnabled(false);
    restore();
  }
}

// B145 cell: drives the real attach()->reconcileX pipeline. A skin that renders its OWN close
// (bld-head ✕) must end with exactly ONE close control (the skin's; the framework X is removed),
// and a skin without one (base selection / tile-list chooser) must get the framework X back.
function runCloseReconcileCell() {
  const { El, headOf, flush, restore } = domShim();
  try {
    const host = new El("div"); host.id = "selection";
    host.className = "";
    globalThis.DFPanelFrame.setEnabled(true);
    globalThis.DFPanelFrame.register({
      key: "reconcilecell", el: () => host, title: "Selection", contentHost: true, movable: true,
      closable: true, menu: false, resizable: { minW: 240, minH: 140 }, zBand: false,
      escClosable: false, persistOpen: false, isOpen: () => host._c.has("visible"),
    });
    flush();
    const closesIn = node => node.querySelectorAll(".pf-x,.bld-x,.build-close,.info-close,.unit-close-button").length;
    ok(!!headOf(host) && closesIn(host) === 1 && !!headOf(host).querySelector(".pf-x"),
      "a skin with no close of its own gets exactly one close: the framework X");

    // Render a depot-like skin that carries its own bld-head ✕ (the B145 double-X shape).
    const wrap = host.children.find(n => n._c.has("pf-content"));
    const bldHead = new El("div"); bldHead._c.add("bld-head");
    const bldX = new El("button"); bldX._c.add("bld-x");
    bldHead.appendChild(bldX);
    wrap.innerHTML = "";
    wrap.appendChild(bldHead);
    ok(closesIn(host) === 2, "(test-the-test) before reconcile runs, the skin's ✕ and the framework X coexist -- the shipped B145 bug");
    flush();
    ok(closesIn(host) === 1 && !headOf(host).querySelector(".pf-x") && !!wrap.querySelector(".bld-x"),
      "reconcile keeps ONE working close: the skin's own; the framework X is removed, not stacked above it");

    // Skin swap back to content without a close (tile-list chooser shape) -> framework X returns.
    wrap.innerHTML = "plain tile list";
    flush();
    ok(closesIn(host) === 1 && !!headOf(host).querySelector(".pf-x"),
      "a later skin without its own close gets the framework X back (chooser stays dismissible)");

    // B145 root cause: skins assign host.className wholesale, wiping framework classes. The class
    // observer must re-assert pf-resizable or the CSS X-inset dies and the NE grip eats X clicks.
    host.className = "visible building-panel";
    ok(!host._c.has("pf-resizable"), "(test-the-test) a wholesale className write wipes pf-resizable -- the shipped B145 bug");
    flush();
    ok(host._c.has("pf-resizable"), "the class observer re-asserts pf-resizable after a skin's wholesale className write");
  } finally {
    globalThis.DFPanelFrame.setEnabled(false);
    restore();
  }
}

// B159 cell: drives attach()->reconcileHead through real skin renders. A skin that carries its own
// header (unit sheet .unit-sheet-header, .bld-head family) must have it ADOPTED: the generated
// pf-head bar hides (no double header / nothing covering the skin's close+name), drag binds to the
// skin's header, and the panel's ONE close is the skin's own (B145 kept intact). A later skin
// without a header gets the framework bar (and its X) back.
function runHeadAdoptionCell() {
  const { El, headOf, flush, restore } = domShim();
  try {
    const host = new El("div"); host.id = "selection";
    host.className = "";
    globalThis.DFPanelFrame.setEnabled(true);
    globalThis.DFPanelFrame.register({
      key: "adoptcell", el: () => host, title: "Selection", contentHost: true, movable: true,
      closable: true, menu: false, adoptHeadSel: ".unit-sheet-header,.bld-head",
      resizable: { minW: 240, minH: 140 }, zBand: false,
      escClosable: false, persistOpen: false, isOpen: () => host._c.has("visible"),
    });
    flush();
    const bar = headOf(host);
    ok(!!bar && bar.style.display !== "none", "before any skin renders, the generated framework bar is the visible head");

    // Unit-sheet-like skin: own header + own host-anchored close button.
    const wrap = host.children.find(n => n._c.has("pf-content"));
    const sheet = new El("div"); sheet._c.add("unit-sheet");
    const close = new El("button"); close._c.add("unit-close-button");
    const header = new El("div"); header._c.add("unit-sheet-header");
    sheet.appendChild(close); sheet.appendChild(header);
    wrap.innerHTML = "";
    wrap.appendChild(sheet);
    ok(headOf(host).style.display !== "none" && !!wrap.querySelector(".unit-sheet-header"),
      "(test-the-test) before reconcile runs, the framework bar and the skin header coexist -- the B159-1 double-header");
    flush();
    ok(headOf(host).style.display === "none", "the generated bar hides: the skin's header is THE head (no double header)");
    ok(header._c.has("pf-handle") && header.dataset.pfDragBound === "1",
      "drag binds to the adopted skin header (pf-handle + bound)");
    const closes = host.querySelectorAll(".pf-x,.bld-x,.build-close,.info-close,.unit-close-button");
    ok(closes.length === 1 && closes[0]._c.has("unit-close-button"),
      "exactly one close remains and it is the skin's own (skin close == the framework close, B145 intact)");

    // Skin swap to headerless content (tile-list chooser shape) -> bar + framework X return.
    wrap.innerHTML = "plain tile list";
    flush();
    ok(headOf(host).style.display !== "none", "a later headerless skin gets the framework bar back");
    ok(!!headOf(host).querySelector(".pf-x"), "...and the framework X returns with it (panel stays dismissible)");

    // bld-head family: adopted too, with its in-header close as the one close.
    const bldHead = new El("div"); bldHead._c.add("bld-head");
    const bldX = new El("button"); bldX._c.add("bld-x");
    bldHead.appendChild(bldX);
    wrap.innerHTML = "";
    wrap.appendChild(bldHead);
    flush();
    ok(headOf(host).style.display === "none" && bldHead._c.has("pf-handle") && bldHead.dataset.pfDragBound === "1",
      "a .bld-head skin is adopted the same way (hidden bar, drag on the skin header)");
    ok(host.querySelectorAll(".pf-x").length === 0 && host.querySelectorAll(".bld-x").length === 1,
      "bld-head skin keeps its own single close; no framework X is stacked");

    // Seeded-bad loading shell: a header WITHOUT its own close must NOT be adopted -- hiding the
    // bar would hide the panel's only X. The bar (and its X) stays until the real skin lands.
    const bareHead = new El("div"); bareHead._c.add("unit-sheet-header");
    wrap.innerHTML = "";
    wrap.appendChild(bareHead);
    flush();
    ok(headOf(host).style.display !== "none" && !!headOf(host).querySelector(".pf-x"),
      "a skin header without its own close is NOT adopted: the framework bar + X keep the panel dismissible");
  } finally {
    globalThis.DFPanelFrame.setEnabled(false);
    restore();
  }
}

// ---- WAVE 4: VARIANT-AWARE `closable` (S1's COMPONENT-GAP-S1-CLOSE == S4's GAP-A) -------------
// Native has NO close X on the unit profile or the stock-item sheet. THE TRAP both agents hit and
// correctly refused to hand-roll around: head adoption is CONDITIONAL on the skin owning a close,
// so DELETING the X made skinCloseFor() return null -> adoption FAILED -> the generated "Selection"
// TITLE BAR UN-HID and reconcileX stacked a FRESH framework ✕. Removing non-native chrome ADDED
// non-native chrome, while the diff read as parity compliance.
//
// This cell drives the REAL attach() -> reconcileHead/reconcileX pipeline over ONE registration
// whose `closable` is a PREDICATE (exactly core.js's `selectionClosable`), across three skins:
//   1. a closable variant with no close        -> framework bar + framework X   (unchanged)
//   2. the SAME variant WITH its own close     -> adopted, one close            (unchanged, B145/B159)
//   3. an ESC-ONLY variant with NO close       -> adopted, ZERO closes, bar HIDDEN  (the new thing)
// and then back, to prove the framework X RETURNS for a closable skin (no panel is ever stranded).
function runCloseLessVariantCell() {
  const { El, headOf, flush, restore } = domShim();
  try {
    const host = new El("div"); host.id = "selection";
    host.className = "";
    const VARIANTS = ["tile-list-panel", "stock-item-panel", "unit-sheet-panel", "stockpile-panel"];
    const ESC_ONLY = ["unit-sheet-panel", "stock-item-panel"];
    globalThis.DFPanelFrame.setEnabled(true);
    globalThis.DFPanelFrame.register({
      key: "esconlycell", el: () => host, title: "Selection", contentHost: true, movable: true,
      // The shape core.js ships. PV === primaryVariant, the same resolver.
      closable: el => !ESC_ONLY.includes(P.primaryVariant(el.className, VARIANTS)),
      menu: false, adoptHeadSel: ".unit-sheet-header,.stock-item-header",
      resizable: { minW: 240, minH: 140 }, zBand: false, escClosable: false, persistOpen: false,
      isOpen: () => host._c.has("visible"),
    });
    flush();
    const closesIn = () => host.querySelectorAll(".pf-x,.bld-x,.build-close,.info-close,.unit-close-button").length;
    const wrap = host.children.find(n => n._c.has("pf-content"));

    ok(P.closableFor({ closable: true }) === true && P.closableFor({ closable: false }) === false,
      "closableFor: a BOOLEAN registration is unchanged (every other panel in the product)");
    ok(P.closableFor({ closable: () => { throw new Error("boom"); } }, host) === true,
      "closableFor: a THROWING predicate falls back to CLOSABLE -- never strand a panel with no way out");

    // 1. A closable variant (stockpile) whose skin has no close of its own.
    host.className = "visible stockpile-panel";
    flush();
    ok(headOf(host).style.display !== "none" && closesIn() === 1 && !!headOf(host).querySelector(".pf-x"),
      "a CLOSABLE variant with no skin close still gets the framework bar + X (nothing regressed)");

    // 2. The unit sheet AS SHIPPED TODAY: close-less variant, but the skin still renders its own X.
    //    Exactly one close, header adopted -- i.e. flipping the variant is INERT until the family
    //    deletes its X. (This is why the change can land ahead of the consumers.)
    host.className = "visible unit-sheet-panel";
    const sheet = new El("div"); sheet._c.add("unit-sheet");
    const skinClose = new El("button"); skinClose._c.add("unit-close-button");
    const header = new El("div"); header._c.add("unit-sheet-header");
    sheet.appendChild(skinClose); sheet.appendChild(header);
    wrap.innerHTML = "";
    wrap.appendChild(sheet);
    flush();
    ok(headOf(host).style.display === "none" && closesIn() === 1,
      "the ESC-only variant WITH its shipped close: adopted head, exactly one close (change is inert)");

    // 3. THE END STATE. The family deletes its X. Native's unit sheet: no close at all.
    const bare = new El("div"); bare._c.add("unit-sheet");
    const bareHead = new El("div"); bareHead._c.add("unit-sheet-header");
    bare.appendChild(bareHead);
    wrap.innerHTML = "";
    wrap.appendChild(bare);
    flush();
    ok(closesIn() === 0, "ZERO close affordances: no skin ✕, and the framework manufactured none");
    ok(headOf(host).style.display === "none",
      "ZERO framework title bar: the close-less header is ADOPTED (the old gate un-hid the bar here)");
    ok(bareHead._c.has("pf-handle") && bareHead.dataset.pfDragBound === "1",
      "...and the adopted close-less header is still the drag handle");

    // 4. A stale framework X generated by an earlier closable variant must be SHED, not ridden along
    //    inside the hidden head where a later skin would un-hide it.
    host.className = "visible stockpile-panel";
    wrap.innerHTML = "plain tile list";
    flush();
    ok(closesIn() === 1 && !!headOf(host).querySelector(".pf-x"),
      "(setup) back on a closable variant, the framework X returns");
    host.className = "visible stock-item-panel";
    const isheet = new El("div"); isheet._c.add("stock-item-header");
    wrap.innerHTML = "";
    wrap.appendChild(isheet);
    flush();
    ok(host.querySelectorAll(".pf-x").length === 0,
      "switching to an ESC-only variant SHEDS the previously-generated framework X (no stowaway ✕)");
    ok(headOf(host).style.display === "none", "the item sheet's close-less header is adopted too");

    // 5. And back once more: the panel is never left without a way out.
    host.className = "visible stockpile-panel";
    wrap.innerHTML = "plain tile list";
    flush();
    ok(closesIn() === 1 && !!headOf(host).querySelector(".pf-x"),
      "a later CLOSABLE skin gets the framework X back (no panel is ever stranded)");
  } finally {
    globalThis.DFPanelFrame.setEnabled(false);
    restore();
  }
}

// THE TEARDOWN CONTRACT ON THE ZERO-CLOSE PATH. A close-less unit sheet has NO click handler to run
// stopUnitSheetRefresh(), so the ONLY thing standing between ESC and a leaked 3s /unit poll is the
// refresh tick's own self-terminating guard. Both halves of that guard live in files this owner may
// not edit, so they are PINNED here: if either is ever "tidied away", the option this commit ships
// becomes a resource leak, and this cell fails first.
//   half 1  closeSelection() clears #selection's className and selectedUnitData   (dwf-core.js)
//   half 2  the tick OPENS with `if (!unitSheetStillOpen(id)) { stopUnitSheetRefresh(); return; }`,
//           and unitSheetStillOpen() reads exactly those two things -- BEFORE any fetch, so an
//           ESC-closed sheet issues no further request and the interval clears on the next tick.
function runEscTeardownContractCell() {
  const core = readJs("dwf-core.js");
  const unit = readJs("dwf-unit-hud-notifications.js");
  const placement = readJs("dwf-controls-placement.js");

  const closeFn = /function closeSelection\(\)\s*\{[\s\S]*?\n  \}/.exec(core);
  ok(!!closeFn && /selectedUnitData\s*=\s*null/.test(closeFn[0]) && /selection\.className\s*=\s*""/.test(closeFn[0]),
    "closeSelection() still clears BOTH things unitSheetStillOpen() reads (className + selectedUnitData)");
  ok(/selection\.classList\.contains\("visible"\)\)\s*\{\s*\n\s*closeSelection\(\);/.test(placement),
    "ESC still closes #selection (the Esc cascade calls closeSelection() -- the ONLY dismissal a " +
    "close-less native sheet has)");

  const stillOpen = /function unitSheetStillOpen\(id\)\s*\{[\s\S]*?\n  \}/.exec(unit);
  ok(!!stillOpen && /classList\.contains\("visible"\)/.test(stillOpen[0]) &&
    /classList\.contains\("unit-sheet-panel"\)/.test(stillOpen[0]) &&
    /selectedUnitData\?\.unit\?\.id/.test(stillOpen[0]),
    "unitSheetStillOpen() is keyed on the class list + selectedUnitData that closeSelection() clears");

  const tick = /async function unitSheetRefreshTick\(\)\s*\{[\s\S]*?\n  \}/.exec(unit);
  ok(!!tick, "the unit sheet's refresh tick exists");
  const guard = tick && /if \(!unitSheetStillOpen\(unitSheetRefreshId\)\) \{ stopUnitSheetRefresh\(\); return; \}/.exec(tick[0]);
  ok(!!guard, "THE TEARDOWN: the tick self-terminates when the sheet is no longer open");
  ok(!!guard && !!tick && tick[0].indexOf("fetch(") > tick[0].indexOf(guard[0]),
    "the guard runs BEFORE the fetch: an ESC-closed sheet issues ZERO further /unit requests");
  ok(/const UNIT_SHEET_REFRESH_MS = 3000;/.test(unit),
    "teardown is bounded by one tick (3000ms) -- the leak this guard prevents is the 2-3s /unit poll");
  ok(/window\.clearInterval\(unitSheetRefreshTimer\)/.test(unit),
    "stopUnitSheetRefresh() genuinely clears the interval (not just the id)");
}

// ESC-HANG repro cell (live dead-tab bug, 2026-07-10): drives the EXACT close codepath that hung
// the browser. closeSelection()/closeClientPanel() do `host.className = ""` + wrapper clear; the
// class observer then runs reconcileFill, whose no-targets branch called an UNGUARDED
// classList.remove("pf-fill-host") on the already-clean panel. Browsers queue an attribute record
// for that no-change write, which re-fires the same observer -> a self-sustaining microtask loop
// that never yields to the event loop. This cell fails (queue never settles) on the broken code.
function runEscCloseSettleCell() {
  const { El, headOf, flush, restore, counters } = domShim();
  try {
    const host = new El("div"); host.id = "selection";
    globalThis.DFPanelFrame.setEnabled(true);
    globalThis.DFPanelFrame.register({
      key: "escsettle", el: () => host, title: "Selection", contentHost: true, movable: true,
      closable: true, menu: false, adoptHeadSel: ".sp-header",
      resizable: { minW: 240, minH: 140 }, zBand: false, escClosable: false, persistOpen: false,
      // Mirrors core.js selectionFillSel: a recognized skin designates a scrollbox; the wiped
      // "default" variant resolves to null -- the branch that fed the loop.
      fillSel: el => el.classList.contains("stockpile-panel") ? ".sp-targets" : null,
      isOpen: () => host._c.has("visible"),
    });
    flush();
    // B173 OPEN-PATH repro: the stockpile writer sets the skin class FIRST and renders content
    // after an async fetch. Between the two, fillSel designates ".sp-targets" but the DOM has no
    // such node -- reconcileFill's no-targets branch runs on a host that DOES have a class
    // attribute, and the unguarded remove spins the class observer before the fetch ever lands.
    const wrap = host.children.find(n => n._c.has("pf-content"));
    host.className = "visible stockpile-panel";
    ok(flush(64), "OPEN with fill targets not yet rendered (async skin, B173 shape) settles instead of killing the tab");
    // The fetch lands: skin renders its own header + close + designated scrollbox.
    const spHead = new El("div"); spHead._c.add("sp-header");
    const spClose = new El("button"); spClose._c.add("unit-close-button");
    spHead.appendChild(spClose);
    const targets = new El("div"); targets._c.add("sp-targets");
    wrap.appendChild(spHead); wrap.appendChild(targets);
    ok(flush(64), "the async skin render reconciles to a settled DOM");
    guard(host._c.has("pf-fill-host") && targets._c.has("pf-fill-scroll"),
      "open skin is fill-marked before close (the close pass has marks to clear)");
    // THE ESC PATH: closeSelection() shape -- wholesale className wipe, then wrapper clear.
    const errsBefore = counters.errors;
    host.className = "";
    wrap.innerHTML = "";
    ok(flush(64), "the Esc close path SETTLES: every reconcile pass converges (no infinite microtask loop)");
    ok(!host._c.has("pf-fill-host"), "fill marks are cleared exactly once on close");
    ok(counters.errors === errsBefore,
      "the ordinary close path never trips the settle budget (the root fix converges; the budget is only an airbag)");
    ok(!!headOf(host) && headOf(host).style.display !== "none",
      "after close the generated bar is back as the head for the empty host");
  } finally {
    globalThis.DFPanelFrame.setEnabled(false);
    restore();
  }
}

// ESC-HANG selector unification: the stockpile-editor close shape (`.spe-close` carrying
// [data-pf-close] + aria-label, none of the legacy SKIN_CLOSE classes) was visible to makeX's
// broad head-scoped selector but INVISIBLE to skinCloseFor's narrow list. The two detectors
// disagreeing about "does this panel already have a close?" stacked a second framework X and
// blocked head adoption. One CLOSE_SEL vocabulary now feeds both.
function runSpeCloseUnificationCell() {
  const { El, headOf, flush, restore } = domShim();
  try {
    const host = new El("div"); host.id = "selection";
    globalThis.DFPanelFrame.setEnabled(true);
    globalThis.DFPanelFrame.register({
      key: "speunify", el: () => host, title: "Selection", contentHost: true, movable: true,
      closable: true, menu: false, adoptHeadSel: ".spe-head",
      resizable: { minW: 240, minH: 140 }, zBand: false, escClosable: false, persistOpen: false,
      isOpen: () => host._c.has("visible"),
    });
    flush();
    const wrap = host.children.find(n => n._c.has("pf-content"));
    const speHead = new El("div"); speHead._c.add("spe-head");
    const speClose = new El("button"); speClose._c.add("spe-close");
    speClose.setAttribute("data-pf-close", "");
    speClose.setAttribute("aria-label", "Close");
    speHead.appendChild(speClose);
    wrap.appendChild(speHead);
    ok(flush(64), "the spe-close skin render settles");
    const closes = host.querySelectorAll(".pf-x,[data-pf-close]");
    ok(closes.length === 1 && closes[0]._c.has("spe-close"),
      "ONE close-control vocabulary: the skin's [data-pf-close] close is THE close (no stacked framework X)",
      "closes=" + closes.length);
    ok(headOf(host).style.display === "none" && speHead._c.has("pf-handle"),
      "a [data-pf-close]-carrying header is adoptable (skinCloseFor and makeX agree the skin owns close)");
    // Return contract unchanged: a closeless skin still gets the framework bar + X back.
    wrap.innerHTML = "plain list";
    flush(64);
    ok(headOf(host).style.display !== "none" && !!headOf(host).querySelector(".pf-x"),
      "a later closeless skin gets the framework bar + X back (panel stays dismissible)");
  } finally {
    globalThis.DFPanelFrame.setEnabled(false);
    restore();
  }
}

// ESC-HANG defense in depth: a SEEDED-DIVERGENT reconciler (fill selector alternates between
// matching and not, so reconcileFill genuinely flip-flops pf-fill-host every pass -- the class of
// future bug the budget exists for). The settle budget must (1) starve the loop by disconnecting
// the panel's observers, (2) report loudly with the panel key, (3) re-arm next frame so the panel
// isn't dead afterward. A future divergent reconciler becomes a console.error, never a dead tab.
function runSettleBudgetCell() {
  const { El, flush, frame, restore, counters } = domShim();
  try {
    const host = new El("div"); host.id = "selection";
    const alpha = new El("div"); alpha._c.add("alpha");
    host.appendChild(alpha);
    let flip = 0;
    const mode = { diverge: true };
    globalThis.DFPanelFrame.setEnabled(true);
    globalThis.DFPanelFrame.register({
      key: "budgetcell", el: () => host, title: "Budget", contentHost: true, movable: true,
      closable: true, menu: false, resizable: { minW: 240, minH: 140 },
      fillSel: () => mode.diverge ? ((flip++ % 2) ? ".alpha" : ".no-such") : ".alpha",
      isOpen: () => host._c.has("visible"),
    });
    flush();
    counters.errors = 0; counters.lastError = "";
    host.className = "visible";   // kick the class observer; divergence takes it from here
    ok(flush(200), "the settle budget converts an unbounded reconcile loop into a drained queue (observers disconnected)");
    ok(counters.errors === 1, "the tripped budget reports exactly once via console.error", "errors=" + counters.errors);
    ok(counters.lastError.indexOf("budgetcell") >= 0, "the report names the offending panel key", counters.lastError);
    // Loop starved; the next animation frame re-arms the observers and normal life resumes.
    mode.diverge = false;
    ok(frame(), "the re-arm frame itself settles");
    counters.errors = 0;
    host.className = "visible";
    ok(flush(64), "after re-arm, a legitimate class write reconciles and settles again");
    ok(host._c.has("pf-fill-host") && alpha._c.has("pf-fill-scroll"),
      "re-armed observers reconcile the panel again (fill marks land -- the panel is alive, not abandoned)");
    ok(counters.errors === 0, "a convergent reconciler never trips the budget again");
    guard(flip > 25, "the seeded reconciler really diverged past the budget before being stopped (flip=" + flip + ")");
  } finally {
    globalThis.DFPanelFrame.setEnabled(false);
    restore();
  }
}

function runScrollFillCell() {
  const { El, flush, restore } = domShim();
  try {
    const host = new El("div"); host.id = "fill-host";
    const skin = new El("div"); skin.className = "skin-shell";
    const scroll = new El("div"); scroll.className = "scrollbox";
    skin.appendChild(scroll); host.appendChild(skin);
    globalThis.DFPanelFrame.setEnabled(true);
    globalThis.DFPanelFrame.register({
      key: "fillcell", el: () => host, title: "Fill", contentHost: true, movable: true,
      closable: true, menu: false, resizable: { minW: 240, minH: 140 }, fillSel: ".scrollbox",
    });
    flush();
    const wrap = host.children.find(node => node._c.has("pf-content"));
    ok(host._c.has("pf-fill-host") && scroll._c.has("pf-fill-scroll"),
      "framework marks the registered panel and its designated live scrollbox");
    ok(!!wrap && wrap._c.has("pf-fill-chain") && skin._c.has("pf-fill-chain"),
      "every ancestor from scrollbox through content wrapper is marked as a shrinkable height chain");

    const exempt = new El("div"); exempt.id = "exempt-host";
    const fixed = new El("div"); fixed.className = "scrollbox"; fixed.style.height = "190px";
    exempt.appendChild(fixed);
    globalThis.DFPanelFrame.register({ key: "exemptcell", el: () => exempt, movable: false, closable: false });
    flush();
    ok(!exempt._c.has("pf-fill-host") && !fixed._c.has("pf-fill-scroll") && fixed.style.height === "190px",
      "a registration without fillSel is unchanged (content-sized exemption keeps its own height)");
  } finally {
    globalThis.DFPanelFrame.setEnabled(false);
    restore();
  }
}
