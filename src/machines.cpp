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

// GET /machines is READ-ONLY: DF maintains machine cur_power/min_power as running totals that
// nothing reconciles, so writing one desynchronises that machine permanently.

#include "machines.h"

#include "Core.h"
#include "http_server.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "modules/Buildings.h"

#include "df/building.h"
#include "df/machine.h"
#include "df/machine_handler.h"
#include "df/machine_info.h"
#include "df/machine_nodest.h"
#include "df/power_info.h"
#include "df/world.h"
#include "df/global_objects.h"

#include <algorithm>
#include <cstdint>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_machines_mutex;

template <typename Fn>
bool run_machines_locked(Fn&& fn) {
    return run_panel_locked(g_machines_mutex, std::forward<Fn>(fn));
}

struct ComponentRow {
    int32_t building_id = -1;
    std::string name;
    int32_t x = 0, y = 0, z = 0;
    int32_t produced = 0;
    int32_t consumed = 0;
    std::string role;
};

struct MachineRow {
    int32_t id = -1;
    int32_t x = 0, y = 0, z = 0;
    int32_t cur_power = 0;
    int32_t min_power = 0;
    bool active = false;
    bool frozen = false;
    std::vector<ComponentRow> components;
};

std::string building_name_or_fallback(df::building* b) {
    std::string name = Buildings::getName(b);
    if (!name.empty()) return name;
    return "Machine part #" + std::to_string(b ? b->id : -1);
}

ComponentRow component_row(df::building* b) {
    ComponentRow row;
    if (!b) return row;
    df::power_info profile;
    b->getPowerInfo(&profile);
    row.building_id = b->id;
    row.name = building_name_or_fallback(b);
    row.x = b->centerx;
    row.y = b->centery;
    row.z = b->z;
    row.produced = profile.produced;
    row.consumed = profile.consumed;
    row.role = profile.produced > 0 ? "producer" : (profile.consumed > 0 ? "consumer" : "inert");
    return row;
}

std::vector<MachineRow> collect_machines() {
    std::vector<MachineRow> rows;
    auto world = df::global::world;
    if (!world) return rows;
    for (auto* machine : world->machines.all) {
        if (!machine) continue;
        MachineRow row;
        row.id = machine->id;
        row.x = machine->x;
        row.y = machine->y;
        row.z = machine->z;
        row.cur_power = machine->cur_power;
        row.min_power = machine->min_power;
        row.active = machine->flags.bits.active != 0;
        row.frozen = machine->flags.bits.frozen != 0;
        for (auto* node : machine->components) {
            if (!node) continue;
            auto* b = df::building::find(node->building_id);
            if (b) row.components.push_back(component_row(b));
        }
        std::sort(row.components.begin(), row.components.end(),
                  [](const ComponentRow& a, const ComponentRow& b) {
            if ((a.produced > 0) != (b.produced > 0)) return a.produced > 0;
            if (a.consumed != b.consumed) return a.consumed > b.consumed;
            return a.building_id < b.building_id;
        });
        rows.push_back(std::move(row));
    }
    return rows;
}

int32_t machine_id_for(int32_t building_id) {
    auto* b = df::building::find(building_id);
    if (!b) return -1;
    auto* info = b->getMachineInfo();
    return info ? info->machine_id : -1;
}

std::string machines_json(int32_t building_id, std::string* err) {
    std::ostringstream out;
    bool ok = run_machines_locked([&]() -> bool {
        auto world = df::global::world;
        if (!world) { if (err) *err = "world unavailable"; return false; }
        int32_t selected = -1;
        if (building_id >= 0) {
            auto* b = df::building::find(building_id);
            if (!b) { if (err) *err = "building not found"; return false; }
            if (!b->getMachineInfo()) {
                out << "{\"ok\":true,\"buildingId\":" << building_id << ",\"isMachine\":false}\n";
                return true;
            }
            selected = machine_id_for(building_id);
        }
        auto machines = collect_machines();
        out << "{\"ok\":true,\"buildingId\":" << building_id
            << ",\"isMachine\":" << (building_id >= 0 ? "true" : "false")
            << ",\"machineId\":" << selected
            << ",\"machines\":[";
        for (size_t i = 0; i < machines.size(); ++i) {
            const auto& m = machines[i];
            if (i) out << ",";
            out << "{\"id\":" << m.id
                << ",\"x\":" << m.x << ",\"y\":" << m.y << ",\"z\":" << m.z
                << ",\"curPower\":" << m.cur_power
                << ",\"minPower\":" << m.min_power
                << ",\"active\":" << (m.active ? "true" : "false")
                << ",\"frozen\":" << (m.frozen ? "true" : "false")
                << ",\"componentCount\":" << m.components.size()
                << ",\"components\":[";
            for (size_t c = 0; c < m.components.size(); ++c) {
                const auto& comp = m.components[c];
                if (c) out << ",";
                out << "{\"buildingId\":" << comp.building_id
                    << ",\"name\":" << json_string(comp.name)
                    << ",\"x\":" << comp.x << ",\"y\":" << comp.y << ",\"z\":" << comp.z
                    << ",\"produced\":" << comp.produced
                    << ",\"consumed\":" << comp.consumed
                    << ",\"role\":" << json_string(comp.role) << "}";
            }
            out << "]}";
        }
        out << "]}\n";
        return true;
    });
    if (!ok) return "";
    return out.str();
}

} // namespace

void register_machine_routes(httplib::Server& server) {
    server.Get("/machines", [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id)) id = -1;   // no id = every network in the fortress
        std::string err;
        std::string json = machines_json(id, &err);
        if (json.empty()) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err.empty() ? "machines unavailable" : err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });
}

} // namespace dwf
