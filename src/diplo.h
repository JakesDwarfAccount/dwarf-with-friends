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

// The browser mirror of native's petition/diplomacy plaques and of the diplomacy meeting dialog.

// Routes: GET /diplo (current mirrored state; mutex-only cache read) and
// POST /diplo-request-priority?player=&cat=&index=&value=0..4.
void register_diplo_routes(httplib::Server& server);

// A switch, so the detector can be cut instantly if it is ever implicated in a crash. It cannot
// itself corrupt the heap: sample_native_suspended() is 100% READS under a CoreSuspender
// (diplo.cpp), and a read raises an access violation (0xC0000005), never
// STATUS_HEAP_CORRUPTION (0xc0000374).
inline constexpr bool kDiploTickEnabled = true;

void diplo_push_tick();

// True while the native diplomacy meeting dialog is open (atomic; safe from any thread).
bool diplo_meeting_open();

} // namespace dwf
