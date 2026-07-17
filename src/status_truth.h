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

#pragma once

#include "httplib.h"

namespace dwf {

// B280 -- GET /statustruth : the LIVE half of the bubble-vs-sheet cross-check.
//
// It exists because no offline fixture can catch a STALE DLL. status_truth_test.mjs (offline)
// compares DF's decoded ladder against the constants in src/unit_status.h -- but the browser does
// not draw bubbles from src/unit_status.h, it draws them from whatever `st` bits the DLL that is
// actually loaded decided to ship. Those two can differ, and when they do, every offline suite
// stays green while the game is wrong. That is precisely the class of failure this wave exists to
// kill, so the rig gets a route that reports BOTH:
//
//   per unit: { id, name, st, st2,               <- what the DLL REALLY shipped this frame
//               hunger_timer, thirst_timer, sleepiness_timer, stress, paralysis, fever,
//               unconscious, stunned, nausea, winded, webbed, pain, dizziness, numbness,
//               exhaustion,                      <- DF's raw counters, unfiltered by any threshold
//               words[],                         <- the words DF's OWN sheet would print
//               needs[] }                        <- the unit's "Unmet need:" lines
//
// The harness then asserts bubble-state == sheet-word for every dwarf in the fort, and separately
// asserts that the DLL's `st` bits agree with the current source. No thresholds are applied here:
// the route ships the RAW counters so the grader is the test, not the server. A server that both
// applied the threshold and graded itself would be the seventh green-test-over-a-dead-feature.
//
// DIAGNOSTIC ROUTE, NOT A HOT PATH. One CoreSuspender hold, plain field reads, no map access --
// the same discipline as unit_status_bits(). It is not on the frame path and nothing in the client
// calls it; it is for the harness and for a human asking "is this dwarf really thirsty?".
void register_status_truth_routes(httplib::Server& server);

} // namespace dwf
