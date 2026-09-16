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

#include <modules/Constructions.h>
#include <modules/MapCache.h>
#include <df/construction.h>
#include <df/tiletype_material.h>

namespace dwf {

inline void resolve_tile_material(MapExtras::MapCache& cache, const df::coord& pos,
                                  df::tiletype_material tile_material,
                                  int& mat_type, int& mat_index) {
    mat_type = -1;
    mat_index = -1;
    if (tile_material == df::tiletype_material::CONSTRUCTION) {
        if (df::construction* construction = DFHack::Constructions::findAtTile(pos)) {
            mat_type = construction->mat_type;
            mat_index = construction->mat_index;
        }
        return;
    }

    if (MapExtras::Block* block = cache.BlockAtTile(pos)) {
        DFHack::t_matpair material = block->baseMaterialAt(df::coord2d(pos.x & 15, pos.y & 15));
        mat_type = material.mat_type;
        mat_index = material.mat_index;
    }
}

} // namespace dwf
