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

// panel_migration_test.mjs -- static migration-contract checks for WT07 M2/M3.
//
//   node tools/harness/panel_migration_test.mjs
// Exit: 0 PASS, 1 FAIL. Browser placement cells are intentionally not run here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.resolve(here, "../../web/js", name), "utf8");
const chat = read("dwf-chat.js");
const audio = read("dwf-audio.js");
const frame = read("dwf-panelframe.js");
let failed = 0;
let passed = 0;
function ok(value, name) {
  if (value) { passed++; console.log("  ok - " + name); }
  else { failed++; console.log("  FAIL - " + name); }
}

console.log("# M2 chat registration");
ok(/if \(window\.DFPanelFrame\) window\.DFPanelFrame\.register\(\{[\s\S]*?key: "chat"/.test(chat),
  "chat remains old-cache guarded and registers stable key chat");
ok(/headSel: "\.dfchat-head"[\s\S]*?resizable: \{ minW: 220, minH: 140 \}/.test(chat),
  "chat adopts its existing header and keeps the 220x140 resize minimum");
ok(/defaultPos: function \(vw, vh\) \{ return \{ anchor: "bl", x: 8, y: 52, w: 302, h: 272 \}; \}/.test(chat),
  "chat reset default preserves the current 302x272 border-box rect at bottom-left 8/52");
ok(/syncOpenState\("chat", true\)/.test(chat) && /syncOpenState\("chat", false\)/.test(chat),
  "chat's existing toggle and close behavior synchronize framework persistence");

console.log("# M3 audio popover registration");
ok(/if \(root\.DFPanelFrame\) root\.DFPanelFrame\.register\(\{[\s\S]*?key: "audio"/.test(audio),
  "audio popover remains old-cache guarded and registers stable key audio");
ok(/headSel: "h4"[\s\S]*?escClosable: true, zBand: false/.test(audio),
  "audio adopts its title as a drag handle, joins Esc, and retains its independent z layer");
ok(!/resizable:/.test(audio.slice(audio.indexOf('key: "audio"'), audio.indexOf('key: "audio"') + 400)),
  "audio popover is move-only");
ok(/function openPopover\(\)[\s\S]*?syncOpenState\("audio", true\)/.test(audio) &&
   /function closePopover\(\)[\s\S]*?syncOpenState\("audio", false\)/.test(audio),
  "audio's existing button and outside-dismiss paths synchronize open state");
ok(/#dfAudioPop h4 \.pf-x\{float:right;font-size:12px!important;padding:0\}/.test(audio),
  "framework-added audio X cannot enlarge the dormant title line");

console.log("# framework support");
ok(/function syncOpenState\(key, isOpen\)/.test(frame) && /syncOpenState: syncOpenState/.test(frame),
  "framework exposes the consumer synchronization hook");
ok(/if \(!visible\(el\) && spec\.open\) spec\.open\(\);/.test(frame),
  "persisted open panels reopen before their saved geometry is restored");
ok(/\.dfchat-close/.test(frame), "framework reuses chat's existing X instead of appending another");

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
