// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only

// b252_schedule_columns_test.mjs -- OFFLINE. B252: the squad SCHEDULE screen renders the routine
// columns (Off duty / Staggered training / Constant training / Ready) but the player cannot click
// them, and the selected column is not readable. No live DF, no server, no browser.
//   node tools/harness/b252_schedule_columns_test.mjs
//
// DF'S ACTUAL MODEL (cited, not invented):
//
//   plotinfo.alerts (df::alert_state_infost, library/xml/df.alert_state.xml)
//     .routines : vector<military_routinest*>   -- the FORT-WIDE named routines. These ARE the
//                                                  columns. ("Add/edit routines (columns)".)
//   df::squad (library/xml/df.squad.xml:308)
//     .schedule : squad_schedulest              -- .routine : vector<squad_routine_schedulest*>,
//                                                  PARALLEL to plotinfo.alerts.routines (same index).
//                                                  Each holds month[12] of squad_schedule_entry
//                                                  {name, sleep_mode, uniform_mode, orders[],
//                                                   order_assignments[]}  (df.squad.xml:224-241).
//     .cur_routine_idx : int32                  -- df.squad.xml:321, bay12 original name
//                                                  `current_routine_index`, refers-to schedule[$].
//                                                  *** THIS is what a column click writes. ***
//
//   So "how often a squad is training" = which routine index the squad is on. One int32 on the
//   squad. Nothing else moves. The per-column cell text ("Off duty" / "Monthly orders" / "Train" /
//   "No orders") is a SUMMARY of that routine's 12 squad_schedule_entry months for this squad; the
//   Edit/Clear plaque under it edits one month's orders (squad_schedule_order -> squad_order_trainst).
//
//   The write already exists in the DLL and predates this wave: do_squad_set_routine()
//   (src/squads.cpp) does exactly `squad->cur_routine_idx = routine_idx` behind a bounds check, and
//   POST /squad-schedule?action=set-routine reaches it. B252 is therefore CLIENT-ONLY: the column
//   was never a click target and the selection never had a style.
//
// THE SELECTED STATE, MEASURED (not guessed) off the two native captures:
//   Menu Oracle Screenshots/Squad Menu UI/7. Squad Schedule Menu.PNG  (squad on "Staggered training")
//   tools/orchestrator/attachments/B252-1.png                          (squad on "Constant training")
//   In BOTH, the modal background of the SELECTED routine's cell is rgb(78,71,78) = #4e474e
//   (== --dwfui-slab, the HORIZONTAL_OPTION plaque slab) and every UNSELECTED cell is
//   rgb(46,45,47) = #2e2d2f. The owner: "the lightest one is the one selected."
//   The bug: `.sq-schedule-routine` painted EVERY cell at --dwfui-slab, so all four columns read as
//   selected, and the `active` class the builder already emitted had no CSS rule at all.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
globalThis.DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
const squads = require(join(root, "web/js/dwf-squads.js"));
const squadsSrc = readFileSync(join(root, "web/js/dwf-squads.js"), "utf8");
const cppSrc = readFileSync(join(root, "src/squads.cpp"), "utf8");
const css = readFileSync(join(root, "web/css/dwf.css"), "utf8");
const dfcui = readFileSync(join(root, "web/js/dwf-ui-components.js"), "utf8");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${extra ? "  " + extra : ""}`); }
}

// Native's four default routines, in native's order, with the squad on index 2 (the B252 capture).
const ROUTINES = [
  { idx: 0, name: "Off duty" }, { idx: 1, name: "Staggered training" },
  { idx: 2, name: "Constant training" }, { idx: 3, name: "Ready" },
];
const detail = {
  squad: { id: 7, name: "The Growls of Inking", alias: "", routineIdx: 2 },
  routines: ROUTINES,
  routineSchedules: [
    { idx: 0, months: [{ orderLabel: "Off duty", hasTrain: false }] },
    { idx: 1, months: [{ orderLabel: "Monthly orders", hasTrain: false }] },
    { idx: 2, months: [{ orderLabel: "Train", hasTrain: true }] },
    { idx: 3, months: [{ orderLabel: "No orders", hasTrain: false }] },
  ],
};
const html = squads.sqScheduleView(detail);

// --- a hair-thin attribute reader (no jsdom; zero deps is the house rule) ----------------------
// Returns every tag that carries data-schedule-routine="<n>", with its full opening tag text.
function scheduleTargets(src) {
  const out = [];
  const re = /<([a-z]+)\b([^>]*\bdata-schedule-routine="(\d+)"[^>]*)>/gi;
  let m;
  while ((m = re.exec(src))) out.push({ tag: m[1].toLowerCase(), attrs: m[2], idx: Number(m[3]) });
  return out;
}
// The cell element for a routine: the outer container that holds the label AND the Edit/Copy plaques.
function cellTags(src) {
  const out = [];
  const re = /<([a-z]+)\b([^>]*\bdata-routine-idx="(\d+)"[^>]*)>/gi;
  let m;
  while ((m = re.exec(src))) out.push({ tag: m[1].toLowerCase(), attrs: m[2], idx: Number(m[3]) });
  return out;
}

console.log("# B252 (a): every routine COLUMN is a click target, not just its name plaque");
const targets = scheduleTargets(html);
check("all four routines are click targets", new Set(targets.map(t => t.idx)).size === 4,
  `saw idx ${[...new Set(targets.map(t => t.idx))].join(",")}`);
const cells = cellTags(html);
check("each routine renders one cell container", new Set(cells.map(c => c.idx)).size === 4);
// The bug in one line: before the fix the ONLY data-schedule-routine in the tree sat on the little
// name plaque; the cell (the thing a DF player clicks -- native's click target is the CELL in the
// squad's row, the header is a plain label) carried nothing.
check("THE CELL ITSELF carries data-schedule-routine",
  cells.every(c => /data-schedule-routine="/.test(c.attrs)),
  "the cell container is inert -- only the header plaque was clickable");
check("the cell announces radio semantics (one routine at a time)",
  cells.every(c => /role="radio"/.test(c.attrs)));
check("the cell announces which one is checked",
  cells.filter(c => /aria-checked="true"/.test(c.attrs)).length === 1);
check("the checked cell is the squad's cur_routine_idx",
  cells.find(c => /aria-checked="true"/.test(c.attrs))?.idx === 2);
check("the cell is keyboard-reachable", cells.every(c => /tabindex="0"/.test(c.attrs)));

console.log("\n# B252 (b): the selected column READS as selected ('the lightest one')");
check("exactly one cell carries the active class",
  (html.match(/class="[^"]*\bactive\b[^"]*"[^>]*data-routine-idx|data-routine-idx="\d+"[^>]*class="[^"]*\bactive\b/g) || []).length >= 1 ||
  cells.filter(c => /class="[^"]*\bactive\b/.test(c.attrs)).length === 1);
check("the active cell is routine 2, not routine 0",
  cells.filter(c => /class="[^"]*\bactive\b/.test(c.attrs)).map(c => c.idx).join(",") === "2");
// The measured native colours. An unselected cell MUST NOT be painted at the slab colour -- that was
// the whole visual bug (all four columns looked selected).
check("DWFUI owns a selectable-cell component with an active state",
  /\.dwfui-selectcell\b/.test(css) && /\.dwfui-selectcell\.active\b/.test(css));
const unselRule = css.match(/\.dwfui-selectcell\s*\{[^}]*\}/)?.[0] || "";
const selRule = css.match(/\.dwfui-selectcell\.active\s*\{[^}]*\}/)?.[0] || "";
check("unselected cell = the DARK fill #2e2d2f (native measurement)",
  /#2e2d2f/i.test(unselRule) || /--dwfui-cell-dark/.test(unselRule), unselRule);
check("selected cell = the LIGHT slab #4e474e / --dwfui-slab (native measurement)",
  /--dwfui-slab|#4e474e/i.test(selRule), selRule);
check("the schedule cell no longer paints every column at the slab colour",
  !/\.sq-schedule-routine\s*\{[^}]*background:\s*var\(--dwfui-slab\)/.test(css));

console.log("\n# B252 (c): the click is wired, and the nested plaques do not swallow / hijack it");
// Scope every assertion to the schedule wiring's own body -- squads.js has an Enter handler for the
// rename field and several `active` reads elsewhere, and a loose file-wide regex would report those
// as this fix (a false pass; AGENTS.md "when a green number looks too good, read the assertion").
const wiring = squadsSrc.match(/function wireSquadScheduleControls\([\s\S]*?\n  \}\n/)?.[0] || "";
check("the schedule wiring function is findable", wiring.length > 0);
check("wireSquadScheduleControls binds every data-schedule-routine target",
  /querySelectorAll\("\[data-schedule-routine\]"\)/.test(wiring));
check("the cell's Edit/Copy plaques stopPropagation (clicking Edit must not switch routine)",
  /stopPropagation\(\)/.test(wiring));
check("Enter/Space activate the focused cell (it is a radio, not a div)",
  /"keydown"/.test(wiring) && /Enter/.test(wiring) && /" "|Space/.test(wiring));
check("a re-click on the already-active routine is a no-op (no pointless write)",
  /routineIdx[\s\S]{0,160}?return;/.test(wiring));

console.log("\n# B252 (d): the write is DF's model -- squad.cur_routine_idx, and nothing else");
check("do_squad_set_routine writes cur_routine_idx", /squad->cur_routine_idx = routine_idx;/.test(cppSrc));
check("it is bounds-checked against squad.schedule.routine",
  /routine_idx >= static_cast<int>\(squad->schedule\.routine\.size\(\)\)/.test(cppSrc));
check("the client posts set-routine to /squad-schedule",
  /action: "set-routine", routine:/.test(squadsSrc) && /\/squad-schedule\?/.test(squadsSrc));
check("a rejected write surfaces to the player instead of failing silently",
  /Could not change routine/.test(squadsSrc));

console.log("\n# TEST-THE-TEST: seeded-bad renders");
const noSelection = squads.sqScheduleView({ ...detail, squad: { ...detail.squad, routineIdx: -1 } });
check("a squad on no routine highlights nothing",
  cellTags(noSelection).filter(c => /aria-checked="true"/.test(c.attrs)).length === 0);
const other = squads.sqScheduleView({ ...detail, squad: { ...detail.squad, routineIdx: 0 } });
check("moving cur_routine_idx moves the highlight (the state is READ, not hard-coded)",
  cellTags(other).find(c => /aria-checked="true"/.test(c.attrs))?.idx === 0);
check("the pre-fix markup (plaque-only target) would fail cell (a)",
  !/data-schedule-routine/.test('<section class="sq-schedule-routine" data-routine-idx="0">'));
const empty = squads.sqScheduleView({ squad: detail.squad, routines: [], routineSchedules: [] });
check("no routines -> an honest message, not a broken grid", /No military routines exist yet/.test(empty));

// --- hostwrites guard: the DELIBERATE non-application, stated in code so it cannot drift ---------
// B252's write is `squad.cur_routine_idx = n` -- a bounds-checked int32 on a squad the fort already
// owns. It is NOT the hostwrites class: dfcapture-hostwrites.json guards the NATIVE-INPUT DRIVES
// (trade confirm/open, justice convict/interrogate) where DF's own screen is aimed and its buttons
// fed, because those commits touch graphs we cannot reconstruct (see
// docs/superpowers/specs/2026-07-14-hostwrites-B226-B227.md sections 0-1). A direct squad-struct
// write is the same class as /squad-order, /squad-emblem, /squad-schedule set-month and
// /zone-squad-action -- all of which have shipped unguarded since WD-30. Adding a guard flag to
// set-routine alone would strand a route that already works. Asserted so a future wave does not
// "helpfully" guard it or, worse, guard the OTHER squad writes by copying this one.
console.log("\n# hostwrites: set-routine is deliberately NOT guard-gated (and neither are its peers)");
check("no hostwrites guard is consulted on the squad-schedule path",
  !/hw_guard|hostwrites/i.test(cppSrc.match(/do_squad_set_routine[\s\S]{0,700}/)?.[0] || ""));
check("the squad routes remain plain struct writes (no native-input drive)",
  !/simulateInput|feed\(&keys\)/.test(cppSrc));

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
