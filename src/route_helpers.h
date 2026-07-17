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

// Tiny cross-route helpers shared by the register_*_routes() modules (split out of
// http_server.cpp's anonymous namespace by B212, 2026-07-13 -- bodies and banners verbatim).
// Header-only so the split adds no link surface.

#include "camera.h"

#include <algorithm>

namespace dwf {

// Clamp a client-requested tile-window dimension. The tile client (FIX 1) asks for a
// window sized to its browser canvas (~1 tile / 24px); bound it so a wild value can
// never make the reader allocate/loop unreasonably (build_map_json_impl also caps 512).
constexpr int kMinWindowTiles = 1;
constexpr int kMaxWindowTiles = 200;
inline int clamp_window_dim(int v) {
    if (v < kMinWindowTiles) return kMinWindowTiles;
    if (v > kMaxWindowTiles) return kMaxWindowTiles;
    return v;
}

// BUGFIX (cursor/selection misalignment -- see interaction.cpp's pixel_to_tile_coord banner
// for the full root-cause writeup): this used to overwrite the client's real frame_w/frame_h
// with DF's own native gps->main_viewport tile dims (effective_capture_viewport_dims), on the
// theory that "px*view_w/frame_w is an identity only when frame_w == view_w, so force that".
// That reasoning was backwards -- FIX 1 (the /mapdata comment just below) already decoupled
// the client's rendered window from DF's native viewport, and the wire's actual contract is
// `world = camera + grid_index` (px/py are ALREADY a plain tile-grid index, never a fraction
// of view_w). Forcing frame_w = view_w didn't restore an identity, it just replaced the
// client's real (larger) window with DF's much smaller native one for the CLAMP bound every
// downstream pixel_to_tile_index/pixel_to_tile/pixel_to_map_pos call applies -- so any click
// whose grid index exceeded that small native viewport silently clamped to its edge tile.
// Kept as a no-op (rather than deleting all eight call sites) so this stays the one place
// documenting why: frame_w/frame_h are the ONLY correct scale for a client grid index, and
// nothing here should ever consult the DF-native viewport size for that purpose again.
inline void normalize_frame_to_viewport(const Camera&, int&, int&) {}

// Same grid-index -> tile mapping placement.cpp/lua_bridge.cpp/burrows_panel.cpp each keep
// their own copy of; used by /zone-repaint to resolve its erase/extend rect to world tiles
// before handing off to building_zone.cpp's plan/finish pair. `frame` is the client's real
// rendered-window tile count (see the bugfix note above) -- px is already grid-relative to it,
// so this is just a defensive clamp, never a rescale.
inline int pixel_to_tile_index(int pixel, int frame) {
    if (frame <= 0)
        return 0;
    return std::max(0, std::min(frame - 1, pixel));
}

} // namespace dwf
