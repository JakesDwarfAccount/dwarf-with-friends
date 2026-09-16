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

// Tiny cross-route helpers shared by the register_*_routes() modules.

#include "camera.h"
#include "fnv.h"

#include <algorithm>
#include <cstdint>
#include <sstream>
#include <string>

namespace dwf {

// A 304 must only ever mean byte-identical content, so hash the whole body, never a cheaper proxy.
inline std::string content_etag(const std::string& body) {
    uint64_t h = fnv1a(kFnvOffsetBasis, body.data(), body.size());
    std::ostringstream o;
    o << '"' << std::hex << h << '"';
    return o.str();
}

// Bound the client-requested window: an unbounded value makes the map reader allocate and loop.
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

// `pixel` is ALREADY a grid index into the client's rendered window, so this clamps, never rescales.
inline int pixel_to_tile_index(int pixel, int frame) {
    if (frame <= 0)
        return 0;
    return std::max(0, std::min(frame - 1, pixel));
}

} // namespace dwf
