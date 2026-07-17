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

#include <cstdint>
#include <mutex>
#include <vector>

namespace dwf {

struct BakeSweepPoint {
    int x = 0;
    int y = 0;
    int z = 0;
};

void bake_sweep_arm_auto();
void bake_sweep_arm_manual();
void bake_sweep_observe_world(uintptr_t world_identity);

bool bake_sweep_needs_candidates();
void bake_sweep_submit_candidates(const std::vector<BakeSweepPoint>& points,
                                  int viewport_w, int viewport_h,
                                  int map_w, int map_h);

void bake_sweep_tick(std::recursive_mutex& capture_mu);

// True while camera steps are still queued or a plan is pending; the portrait sweep
// defers its own offscreen renders until the map bake sweep has drained.
bool bake_sweep_active();

} // namespace dwf
