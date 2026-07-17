// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3.
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

#include "TileTypes.h"

namespace dwf {

// df.d_basics.xml's complete canopy matrix is:
//   TREE     x WALL/RAMP/BRANCH/TRUNK_BRANCH/TWIG
//   MUSHROOM x WALL/RAMP/FLOOR (living and dead giant-mushroom caps)
// Leaves are graphics on the tree-part tiletypes, not a separate tiletype material. Branches
// are pathable in DF, but are not the ground surface that recenter/first-join should target.
inline bool surface_z_skips_canopy(df::tiletype tile) {
    const auto material = DFHack::tileMaterial(tile);
    const auto shape = DFHack::tileShape(tile);

    if (material == df::tiletype_material::TREE) {
        switch (shape) {
        case df::tiletype_shape::WALL:
        case df::tiletype_shape::RAMP:
        case df::tiletype_shape::BRANCH:
        case df::tiletype_shape::TRUNK_BRANCH:
        case df::tiletype_shape::TWIG:
            return true;
        default:
            return false;
        }
    }

    if (material == df::tiletype_material::MUSHROOM) {
        return shape == df::tiletype_shape::WALL ||
               shape == df::tiletype_shape::RAMP ||
               shape == df::tiletype_shape::FLOOR;
    }

    return false;
}

} // namespace dwf
