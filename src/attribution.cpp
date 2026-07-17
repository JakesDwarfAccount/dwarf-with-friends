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

#include "attribution.h"

#include "json_util.h"

#include <mutex>
#include <sstream>
#include <unordered_map>

namespace dwf {
namespace {

std::mutex g_attrib_mutex;
std::string g_world_key;
std::unordered_map<int32_t, std::string> g_buildings;
std::unordered_map<int32_t, std::string> g_orders;
std::unordered_map<int32_t, std::string> g_stockpiles;
std::unordered_map<int32_t, std::string> g_zones;

std::unordered_map<int32_t, std::string>& map_for(AttribKind kind) {
    switch (kind) {
        case AttribKind::Order:     return g_orders;
        case AttribKind::Stockpile: return g_stockpiles;
        case AttribKind::Zone:      return g_zones;
        case AttribKind::Building:
        default:                    return g_buildings;
    }
}

void clear_all_locked() {
    g_buildings.clear();
    g_orders.clear();
    g_stockpiles.clear();
    g_zones.clear();
}

void append_map_json(std::ostringstream& body, const char* key,
                     const std::unordered_map<int32_t, std::string>& m, bool& first_section) {
    if (!first_section) body << ",";
    first_section = false;
    body << "\"" << key << "\":{";
    bool first = true;
    for (const auto& kv : m) {
        if (!first) body << ",";
        first = false;
        body << "\"" << kv.first << "\":" << json_string(kv.second);
    }
    body << "}";
}

} // namespace

void attrib_note_world(const std::string& save_dir) {
    if (save_dir.empty())
        return; // no world loaded / transient nil -- never wipe on a blank key
    std::lock_guard<std::mutex> lock(g_attrib_mutex);
    if (g_world_key.empty()) {
        g_world_key = save_dir;
        return;
    }
    if (g_world_key != save_dir) {
        clear_all_locked();
        g_world_key = save_dir;
    }
}

void attrib_stamp(AttribKind kind, int32_t id, const std::string& player) {
    if (id < 0)
        return;
    std::lock_guard<std::mutex> lock(g_attrib_mutex);
    map_for(kind)[id] = player;
}

bool attrib_lookup(AttribKind kind, int32_t id, std::string& player_out) {
    if (id < 0)
        return false;
    std::lock_guard<std::mutex> lock(g_attrib_mutex);
    const auto& m = map_for(kind);
    auto it = m.find(id);
    if (it == m.end())
        return false;
    player_out = it->second;
    return true;
}

std::string attrib_json() {
    std::lock_guard<std::mutex> lock(g_attrib_mutex);
    std::ostringstream body;
    body << "{\"world\":" << json_string(g_world_key) << ",";
    bool first_section = true;
    append_map_json(body, "buildings", g_buildings, first_section);
    append_map_json(body, "orders", g_orders, first_section);
    append_map_json(body, "stockpiles", g_stockpiles, first_section);
    append_map_json(body, "zones", g_zones, first_section);
    body << "}\n";
    return body.str();
}

} // namespace dwf
