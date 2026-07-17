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

// NATIVE-STATUS-BUBBLE harvest -- GET /statusharvest.
//
// The mechanized harvest defined by docs/superpowers/specs/2026-07-14-native-status-bubble-spec.md
// §3.A ("Screen-array harvest"). It is the tooling half of the derivation the spec says is "the
// only thing left": once this route can be sampled over time against the live game, its corpus
// yields the chooser's real CONDITIONS, PRIORITY order, and blink CADENCE -- the three unknowns the
// spec leaves open. This route does NOT itself decide any of those; it only reports, per graphical
// frame, WHICH UNIT_STATUS cell DF actually painted over WHICH unit, plus that unit's full input
// state. The reduction lives offline (tools/harness/status_harvest_test.mjs today pins the
// attribution math; a corpus reducer consumes many frames later).
//
// WHY THIS IS SAFE (and why it is NOT the pattern that crashed DF 3x). CLAUDE.md's load-bearing
// fact: *writing* graphic_viewportst.screentexpos_* to force an offscreen re-render SIGSEGV'd the
// render thread three times. This route does the opposite -- a PASSIVE read of the array DF already
// populated this frame (the same class of read as GET /tiledump, and exactly the read the spec
// live-probed via dfhack-run on 2026-07-14 without incident). No re-render, no SDL_RenderReadPixels,
// no screentexpos WRITE, no camera move. One CoreSuspender hold, plain pointer/array reads, every
// pointer null-guarded and every index bounds-checked. Diagnostic route, NOT a hot path -- nothing
// in the browser client calls it.
//
// The emit shape (see status_harvest.cpp for the field-by-field contract):
//   { v, frame, window:{x,y,z}, viewport:{dim_x,dim_y},
//     page:{ token, loaded, count, texpos:[...] },          <- the live UNIT_STATUS texpos map
//     hits:[ { layer, vx, vy, texpos, row, name, offset,     <- one painted UNIT_STATUS cell
//              unit_id, st, st2, counters..., mood, job } ], <- the unit under it + its inputs
//     unmatched:[ { layer, vx, vy, texpos, row, name } ] }   <- painted cells with no unit (honesty)
void register_status_harvest_routes(httplib::Server& server);

} // namespace dwf
