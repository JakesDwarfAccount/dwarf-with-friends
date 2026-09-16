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

namespace df { struct unit; }

namespace dwf {

// Runs the current native viewscreen's logic+render against this module's isolated SDL target.
// Call ONLY from a runOnRenderThread callback while holding capture_state_mutex().
bool native_viewscreen_logic_render_isolated(std::string* err = nullptr);

bool unit_portrait_on_render_thread(int32_t unit_id,
                                    bool allow_icon_fallbacks,
                                    bool generation_requested,
                                    CapturedFrame& frame,
                                    int32_t& texpos,
                                    std::string& source,
                                    std::string* err = nullptr);

// Outcome of calling DF's own lazy portrait generator: the call is pinned to the exact game
// binary by prologue signatures and SEH-wrapped, and any fault latches generation off for good.
enum class NativePortraitOutcome {
    Generated,      // DF composed a fresh portrait; unit->portrait_texpos is now set
    AlreadyExists,  // unit->portrait_texpos was already set; nothing was called
    NoPortraitArt,  // generator ran cleanly but DF has no portrait art for this creature
    Blocked,        // temporarily unsafe (save in progress, busy, unit missing); retry later
    Unavailable,    // generator not resolved (unsupported binary); permanent this session
    Faulted,        // a native fault occurred; generation is now latched off this session
};

// True when the pinned generator resolved against the running binary. `why` explains a false.
bool unit_portrait_native_generator_available(std::string* why = nullptr);

// True once any native generation attempt faulted (generation is latched off).
bool unit_portrait_native_generator_faulted();

// MUST be called from the render thread. Performs the gate-checked, SEH-wrapped native call.
NativePortraitOutcome unit_portrait_generate_native_on_render(df::unit* unit, std::string* err = nullptr);

} // namespace dwf
