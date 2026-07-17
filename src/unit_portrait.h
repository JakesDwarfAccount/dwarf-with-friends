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

#include "frame.h"

#include <cstdint>
#include <string>

namespace dwf {

// PORTRAITS-ROOT (B128): native view-sheet portrait generation is a shared, contended
// resource -- it must be SKIPPED (not failed) while the host interface has a real view
// sheet open or another generation is in flight. These exact literals are the busy
// signals; the sweep re-queues busy units without burning a retry attempt.
extern const char* const kPortraitBusyHostSheetOpen;
extern const char* const kPortraitBusyGeneratorRunning;

// Run the current native viewscreen's logic and render passes against the portrait module's
// isolated SDL target. Must be called from a runOnRenderThread callback while the caller owns
// capture_state_mutex(). Art prose uses this exact established view-sheet rail so DF can page and
// compose item/engraving descriptions without painting the host window.
bool native_viewscreen_logic_render_isolated(std::string* err = nullptr);

bool unit_portrait_on_render_thread(int32_t unit_id,
                                    bool allow_icon_fallbacks,
                                    bool allow_view_sheet_generation,
                                    CapturedFrame& frame,
                                    int32_t& texpos,
                                    std::string& source,
                                    std::string* err = nullptr,
                                    bool* busy_skip = nullptr);

} // namespace dwf
