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

// Flight Recorder -- Pillar 2 of the ground-truth pipeline
// (docs/superpowers/specs/2026-07-15-ground-truth-pipeline-design.md).
//
// Passively records DF's own screen arrays (exact texture ids + char/color cells, never
// pixels) paired with the memory state behind them, while the game is played normally.
// The corpus it writes is what the Atlas/Reducer tooling and the Rule Ledger's
// corpus-confirmed evidence consume.
//
// WHY THIS IS SAFE -- same argument, word for word, as status_harvest.h: this is a PASSIVE
// read of arrays DF already populated this frame (the /tiledump read class), NOT the
// widget-vector virtual_cast walk and NOT the screentexpos WRITE + forced re-render that
// SIGSEGV'd the render thread three times (see menu_oracle.h). The screen hash/copy runs on
// DF's render thread and is SEH-guarded against a queued request overlapping a grid resize.
// It deliberately does NOT take capture_state_mutex there: another capture path can hold that
// mutex while waiting for a render callback, so taking it inside our callback would deadlock.
//
// HARD RULE 5 (CoreSuspender starvation) is honored by UI+route hash-gating BEFORE suspension: an
// unchanged tick costs one render-thread hash pass and no CoreSuspender, grid copy, or I/O unless
// an explicit rich qualification session requested bounded state_hz sampling.
// Focus, the UNIT_STATUS texture map, and render-owned work-order suggestions are copied in that
// same render callback. Cheap mode never suspends. Only a changed rich screen (or capped
// qualification state sample) then attempts a
// ConditionalCoreSuspender on the worker for simulation-owned unit and manager-order vectors.
// Render is fully released before that attempt: waiting on render while core-suspended is a proven
// DF deadlock, and parking render before requesting the core makes the core unavailable on some
// frames. After core enrichment is released, a second render callback rechecks the exact screen,
// route scalars, and stable IDs. Busy, invalid, capped, faulted, and mismatched joins are explicit
// envelopes and never usable evidence. Compression and file writes happen after both threads are
// released.
//
// Routes (registered like every other module; no client UI calls these -- diagnostic/corpus
// tooling only):
//   GET /recorder/start?mode=cheap|rich&hz=<1..30>&vp=0|1&state_hz=0|1|2&qualification=0|1
//                       &max_mb=<1..4096>&dir=<path>
//        mode=cheap (default): screen-grid dedupe only -- gps text + UI texture planes + tags.
//        mode=rich:            adds eight bounded v3 family slices while retaining visible-unit
//                              status and native work-order v2 data sources.
//        state_hz=1|2:         rich qualification only; bounded state-only attempts on unchanged UI.
//        vp=1: also record the 26 graphic_viewportst map planes (heavier; default off --
//              UI truth lives in the gps text/texture layers; map truth has /tiledump).
//        dir:  output directory; default "dfcapture-recordings" under DF's cwd (DF root).
//   GET /recorder/stop
//   GET /recorder/status
//
//        max_mb: hard session cap; default 512 MiB. A full flush failure stops the recorder.
// Output: one uniquely named session file per start, JSONL, beginning with a provenance manifest,
// then one record per changed UI/route frame (plus requested state-only qualification records):
//   { v:3, t_ms, frame, ui_tick, gps_top_in_use, focus:[..], window:{x,y,z}, mouse:{x,y}, dims:{x,y},
//     planes:[ {name, elem, zb64} ], ui_hash, route_stamp, slices:[..rich only..] }
// where zb64 = base64(zlib deflate) of the raw little-endian plane buffer, elem = bytes per
// cell element. gps_top_in_use=true requires all seven top planes; false requires none. Grids
// are column-major (idx = x*dim_y + y), exactly as DF stores them.
// Session files are corpus data, never committed (recordings dirs are gitignored).
void register_flight_recorder_routes(httplib::Server& server);

// Stops the capture thread if running (joins it). Called from stop_server() so a plugin
// unload can never leave the worker alive; also the /recorder/stop implementation.
void stop_flight_recorder();

} // namespace dwf
