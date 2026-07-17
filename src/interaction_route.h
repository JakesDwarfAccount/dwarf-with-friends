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

namespace dwf {

// Native B288-1/B288-2 show an engraving as its own tile click-info sheet, with no zone title or
// controls, so tile art precedes the passive civzone overlay. The production /inspect resolver uses
// this function after unit/building/item occupants have had their normal precedence.
enum class SurfaceClickRoute { Engraving, Civzone, Tile };

constexpr SurfaceClickRoute surface_click_route(bool has_engraving, bool has_civzone) {
    return has_engraving ? SurfaceClickRoute::Engraving
         : has_civzone ? SurfaceClickRoute::Civzone
                       : SurfaceClickRoute::Tile;
}

static_assert(surface_click_route(true, true) == SurfaceClickRoute::Engraving,
              "an engraved floor inside a zone must surface the engraving");
static_assert(surface_click_route(false, true) == SurfaceClickRoute::Civzone,
              "an ordinary zone floor must retain zone routing");

// B253 draws the statue subject TOP at (building.x, building.y - 1, building.z). A click on that
// authored cell maps back to the one-tile footprint at y + 1.
constexpr int STATUE_OVERHANG_FOOTPRINT_DX = 0;
constexpr int STATUE_OVERHANG_FOOTPRINT_DY = 1;
constexpr int STATUE_OVERHANG_FOOTPRINT_DZ = 0;

struct RouteCoord { int x; int y; int z; };

constexpr RouteCoord statue_overhang_footprint(RouteCoord click) {
    return {click.x + STATUE_OVERHANG_FOOTPRINT_DX,
            click.y + STATUE_OVERHANG_FOOTPRINT_DY,
            click.z + STATUE_OVERHANG_FOOTPRINT_DZ};
}

static_assert(statue_overhang_footprint({40, 50, 7}).y == 51,
              "the statue's upper drawn cell must map one world-y row down to its footprint");

} // namespace dwf
