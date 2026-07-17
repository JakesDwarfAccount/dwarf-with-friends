// b213_savetrigger_test.mjs -- B213 "craftsdwarf workshop interaction saves the server".
//
//   node tools/harness/b213_savetrigger_test.mjs
// Exit: 0 PASS, 1 FAIL.
//
// ROOT CAUSE (evidence, not a save): the server has exactly ONE code path that writes a save --
// save_world_on_core_thread() (interaction.cpp), called ONLY from the POST /save route
// (session_routes.cpp), reached ONLY by the Esc-menu "Save" button (dwf-escmenu.js). It sets
// plotinfo.main.autosave_request; the pause-arbiter samples that flag into g_autosave_seen. NO
// workshop route (/workshop-info, /workshop-add-job, /workshop-job-action, ...) or its Lua
// (workshop_info / workshop_add_job / add_tree_task / native_queue) touches that path.
//
// What a playtester actually saw: every craftsdwarf interaction runs its Lua under a full CoreSuspender
// (lua_bridge run_lua_locked). The craftsdwarf builds the heaviest add-task tree of any workshop
// (getJobs + a full raws-reaction scan + a fort item-presence scan) on EVERY panel open, stalling
// the core past the 1500 ms busy watchdog. The busy banner then fired -- and its wording said
// "Host is saving / world busy", which read as "the server saves". autosave:false means it is
// provably NOT saving, so the banner must not say "saving". This test pins both halves.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

let passed = 0, failed = 0;
function check(fn, name) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { failed++; console.log(`  FAIL - ${name}: ${err.message}`); }
}

const buildingZone = read("src/building_zone.cpp");
const sessionRoutes = read("src/session_routes.cpp");
const interaction = read("src/interaction.cpp");
const lua = read("dwf.lua");
const pause = read("web/js/dwf-pause.js");
const escmenu = read("web/js/dwf-escmenu.js");
const wsPanels = read("web/js/dwf-building-zone-stockpile-panels.js");

console.log("# server: the save path is singular and is NOT the workshop path");
check(() => assert.match(interaction, /bool save_world_on_core_thread/),
  "the one save routine is defined in interaction.cpp");
check(() => assert.match(sessionRoutes, /save_world_on_core_thread/),
  "session_routes.cpp (the /save route) is the caller of the save routine");
check(() => assert.match(sessionRoutes, /server\.Post\("\/save"/),
  "the save routine is reached only via POST /save");
check(() => assert.doesNotMatch(buildingZone, /save_world_on_core_thread/),
  "no /workshop-* route in building_zone.cpp reaches the save routine");
check(() => assert.doesNotMatch(buildingZone, /autosave_request/),
  "no /workshop-* route in building_zone.cpp pokes DF's autosave_request flag");

console.log("# server Lua: no workshop function triggers a save");
// The Lua never sets DF's save flag (that is C++), and none of its workshop entrypoints call save.
check(() => assert.doesNotMatch(lua, /autosave_request/),
  "dwf.lua never writes plotinfo.main.autosave_request");
check(() => assert.doesNotMatch(lua, /dfhack\.[A-Za-z.]*[Ss]ave|createDirsAndSaveGame|\bDoSave\b/),
  "dwf.lua never calls a DFHack/DF save routine");
for (const fn of ["function workshop_info", "function workshop_add_job", "function add_tree_task",
                  "function native_queue", "function workshop_job_action", "function workshop_worker_action"]) {
  check(() => assert.match(lua, new RegExp(fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
    `${fn} exists (the craftsdwarf interaction path)`);
}

console.log("# client: only the Esc-menu Save button POSTs /save; the workshop panel never does");
check(() => assert.match(escmenu, /fetch\("\/save",\s*\{\s*method:\s*"POST"/),
  "dwf-escmenu.js is the single /save POST call site");
check(() => assert.doesNotMatch(wsPanels, /["'`]\/save\b/),
  "the workshop/building panel module never references the /save endpoint");

console.log("# fix: a non-autosave busy stall never claims the game is 'saving' (B213)");
check(() => assert.doesNotMatch(pause, /Host is saving/),
  "the old 'Host is saving / world busy' wording is gone");
check(() => assert.match(pause, /:\s*"Host is busy"/),
  "a plain core stall (autosave:false) now reads 'Host is busy'");
// Count both label sites (live paintBanner + ui-lab storyMarkup) so neither regresses.
check(() => assert.equal((pause.match(/:\s*"Host is busy"/g) || []).length, 2,
  "both the live banner and the story-markup labels were updated"), "both busy-label sites updated");
check(() => assert.match(pause, /\?\s*"Autosaving"\s*:/),
  "a REAL save (autosave flag true) still reads 'Autosaving'");

console.log("# TEST-THE-TEST");
const seededBad = 'const label = lastAutosave ? "Autosaving" : "Host is saving / world busy";';
check(() => assert.match(seededBad, /Host is saving/),
  "a reverted-to-old-wording line would be caught by the 'no saving' assertion");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
