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

// Route plumbing every panel module needs: JSON + error responders, lock discipline, frame parse.

#include "json_util.h"
#include "sdl_capture.h"

#include "Core.h"
#include "httplib.h"

#include <mutex>
#include <string>
#include <utility>

namespace dwf {

inline void set_no_store_json(httplib::Response& res, const std::string& json) {
    res.set_header("Cache-Control", "no-store");
    res.set_content(json, "application/json; charset=utf-8");
}

inline void json_error(httplib::Response& res, int status, const std::string& message) {
    res.status = status;
    res.set_header("Cache-Control", "no-store");
    res.set_content("{\"ok\":false,\"error\":" + json_string(message) + "}\n",
                    "application/json; charset=utf-8");
}

// The lock ORDER is a correctness invariant: panel mutex -> capture-state mutex -> CoreSuspender.
// Reads take the same guard as mutations, so walking sim vectors never races the sim.
template <typename Fn>
bool run_panel_locked(std::recursive_mutex& panel_mutex, Fn&& fn) {
    std::lock_guard<std::recursive_mutex> panel_lock(panel_mutex);
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    return fn();
}

// px/py are tile-grid indices into the CLIENT's own rendered window (0..frame-1) and w/h are that
// window's tile dimensions -- never DF's native viewport size.
inline bool parse_frame_point(const httplib::Request& req, int& px, int& py,
                              int& frame_w, int& frame_h) {
    return query_int(req, "px", px) && query_int(req, "py", py) &&
           query_int(req, "w", frame_w) && query_int(req, "h", frame_h);
}

// px2/py2 are optional and default to px/py, which makes a click a one-tile drag.
inline bool parse_frame_rect(const httplib::Request& req, int& px, int& py, int& px2, int& py2,
                             int& frame_w, int& frame_h) {
    if (!parse_frame_point(req, px, py, frame_w, frame_h))
        return false;
    px2 = px;
    py2 = py;
    query_int(req, "px2", px2);
    query_int(req, "py2", py2);
    return true;
}

} // namespace dwf
