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

#include "stone_use.h"

#include "Core.h"
#include "api_response.h"
#include "http_server.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"

#include "df/global_objects.h"
#include "df/inorganic_flags.h"
#include "df/inorganic_raw.h"
#include "df/material.h"
#include "df/material_flags.h"
#include "df/matter_state.h"
#include "df/plotinfost.h"
#include "df/reaction.h"
#include "df/reaction_handlerst.h"
#include "df/world.h"

#include <algorithm>
#include <charconv>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_stone_use_mutex;

template <typename Fn>
bool run_stone_use_locked(Fn&& fn) {
    return run_panel_locked(g_stone_use_mutex, std::forward<Fn>(fn));
}

// DF builtin material type for inorganics; mat_index indexes world.raws.inorganics.all.
constexpr int16_t kInorganicMatType = 0;

constexpr uint16_t kMagmaTemp = 12000;   // DF's magma temperature, the magma-safe cutoff
constexpr uint16_t kNoHeatPoint = 60001; // DF's "material has no such point" sentinel

bool is_magma_safe(const df::inorganic_raw* raw) {
    if (!raw) return false;
    const auto& heat = raw->material.heat;
    return heat.melting_point > kMagmaTemp
        && heat.boiling_point > kMagmaTemp
        && heat.ignite_point > kMagmaTemp
        && heat.heatdam_point > kMagmaTemp
        && (heat.colddam_point == kNoHeatPoint || heat.colddam_point < kMagmaTemp);
}

std::string capitalize(std::string s) {
    if (!s.empty())
        s[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(s[0])));
    return s;
}

std::vector<std::string> economic_use_labels(const df::inorganic_raw* raw) {
    std::vector<std::string> labels;
    auto world = df::global::world;
    if (!raw || !world)
        return labels;
    for (int32_t ore_mat_idx : raw->metal_ore.mat_index) {
        if (ore_mat_idx < 0 || static_cast<size_t>(ore_mat_idx) >= world->raws.inorganics.all.size())
            continue;
        auto* ore = world->raws.inorganics.all[ore_mat_idx];
        std::string metal_name = ore ? ore->material.state_name[df::matter_state::Solid] : "";
        if (metal_name.empty() && ore) metal_name = ore->material.id;
        if (!metal_name.empty())
            labels.push_back("Ore of " + metal_name);
    }
    for (int32_t reaction_idx : raw->economic_uses) {
        if (reaction_idx < 0 || static_cast<size_t>(reaction_idx) >= world->raws.reactions.reactions.size())
            continue;
        auto* reaction = world->raws.reactions.reactions[reaction_idx];
        if (reaction && !reaction->name.empty())
            labels.push_back(capitalize(reaction->name));
    }
    return labels;
}

enum class StoneUseCategory {
    Ineligible,
    Economic,
    Other,
};

StoneUseCategory stone_use_category(const df::inorganic_raw* raw) {
    if (!raw ||
            raw->flags.is_set(df::inorganic_flags::SOIL_ANY) ||
            !raw->material.flags.is_set(df::material_flags::IS_STONE) ||
            raw->material.flags.is_set(df::material_flags::NO_STONE_STOCKPILE))
        return StoneUseCategory::Ineligible;
    const bool other = raw->metal_ore.mat_index.empty() &&
        raw->economic_uses.empty() &&
        !raw->flags.is_set(df::inorganic_flags::THREAD_METAL) &&
        raw->material.material_value < 10000;
    return other ? StoneUseCategory::Other : StoneUseCategory::Economic;
}

std::string stone_display_name(const df::inorganic_raw* raw) {
    if (!raw->material.stone_name.empty()) return raw->material.stone_name;
    const std::string& solid = raw->material.state_name[df::matter_state::Solid];
    if (!solid.empty()) return solid;
    if (!raw->material.id.empty()) return raw->material.id;
    return raw->id;
}

ApiResult<std::string> build_stone_use_json() {
    std::ostringstream body;
    bool ok = run_stone_use_locked([&]() -> bool {
        auto world = df::global::world;
        auto plotinfo = df::global::plotinfo;
        if (!world || !plotinfo) return false;
        const auto& economic_stone = plotinfo->economic_stone;
        body << "{\"ok\":true,\"economic\":[";
        bool first_economic = true;
        std::ostringstream other_body;
        bool first_other = true;
        other_body << "[";
        const auto& inorganics = world->raws.inorganics.all;
        const size_t count = std::min(inorganics.size(), economic_stone.size());
        for (size_t idx = 0; idx < count; ++idx) {
            auto* raw = inorganics[idx];
            if (!raw || raw->id.empty())
                continue;
            const auto category = stone_use_category(raw);
            if (category == StoneUseCategory::Ineligible)
                continue;
            const bool economic = category == StoneUseCategory::Economic;
            auto& out = economic ? body : other_body;
            bool& first = economic ? first_economic : first_other;
            if (!first) out << ",";
            first = false;
            out << "{\"matType\":" << kInorganicMatType << ",\"matIndex\":" << idx
                << ",\"name\":" << json_string(capitalize(stone_display_name(raw)))
                << ",\"magmaSafe\":" << (is_magma_safe(raw) ? "true" : "false")
                << ",\"uses\":[";
            if (economic) {
                const auto uses = economic_use_labels(raw);
                for (size_t u = 0; u < uses.size(); ++u) {
                    if (u) out << ",";
                    out << json_string(uses[u]);
                }
            }
            out << "],\"selected\":" << (economic_stone[idx] != 0 ? "true" : "false") << "}";
        }
        other_body << "]";
        body << "],\"other\":" << other_body.str() << "}\n";
        return true;
    });
    if (!ok) return ApiResult<std::string>::failure(
        503, "stone_use_unavailable", "stone-use data is unavailable");
    return ApiResult<std::string>::success(body.str());
}

struct StoneUseCommand { int16_t mat_type = 0; int32_t mat_index = 0; bool selected = false; };

bool parse_integer(const std::string& text, int64_t& out) {
    if (text.empty()) return false;
    const char* first = text.data();
    const char* last = first + text.size();
    auto parsed = std::from_chars(first, last, out);
    return parsed.ec == std::errc{} && parsed.ptr == last;
}

ApiResult<StoneUseCommand> parse_stone_use_command(const httplib::Request& req) {
    if (!req.has_param("mat")) return ApiResult<StoneUseCommand>::failure(
        400, "missing_mat", "missing mat");
    const std::string mat = req.get_param_value("mat");
    const size_t separator = mat.find(':');
    if (separator == std::string::npos || mat.find(':', separator + 1) != std::string::npos)
        return ApiResult<StoneUseCommand>::failure(
            400, "invalid_mat", "mat must be matType:matIndex");
    int64_t type = 0, index = 0;
    if (!parse_integer(mat.substr(0, separator), type) ||
            !parse_integer(mat.substr(separator + 1), index) ||
            type < std::numeric_limits<int16_t>::min() ||
            type > std::numeric_limits<int16_t>::max() ||
            index < std::numeric_limits<int32_t>::min() ||
            index > std::numeric_limits<int32_t>::max())
        return ApiResult<StoneUseCommand>::failure(
            400, "invalid_mat", "mat contains an invalid integer");
    int64_t value = 1;
    if (req.has_param("value") && (!parse_integer(req.get_param_value("value"), value) ||
            (value != 0 && value != 1)))
        return ApiResult<StoneUseCommand>::failure(
            400, "invalid_value", "value must be 0 or 1");
    return ApiResult<StoneUseCommand>::success(StoneUseCommand{
        static_cast<int16_t>(type), static_cast<int32_t>(index), value != 0});
}

ApiResult<bool> set_stone_use(const StoneUseCommand& command) {
    ApiError failure;
    const bool ok = run_stone_use_locked([&]() -> bool {
        auto world = df::global::world;
        auto plotinfo = df::global::plotinfo;
        if (!world || !plotinfo) {
            failure = {503, "world_unavailable", "world/plotinfo unavailable"};
            return false;
        }
        if (command.mat_type != kInorganicMatType) {
            failure = {400, "not_inorganic", "not an inorganic material"};
            return false;
        }
        if (command.mat_index < 0 ||
                static_cast<size_t>(command.mat_index) >= world->raws.inorganics.all.size()) {
            failure = {400, "invalid_material", "invalid material index"};
            return false;
        }
        auto& economic_stone = plotinfo->economic_stone;
        if (static_cast<size_t>(command.mat_index) >= economic_stone.size()) {
            failure = {400, "invalid_material", "material has no stone-use restriction byte"};
            return false;
        }
        auto* raw = world->raws.inorganics.all[command.mat_index];
        if (stone_use_category(raw) == StoneUseCategory::Ineligible) {
            failure = {400, "invalid_material", "material is not listed by Stone use"};
            return false;
        }
        economic_stone[command.mat_index] = command.selected ? 1 : 0;
        return true;
    });
    if (!ok) return ApiResult<bool>::failure(
        failure.status, std::move(failure.code), std::move(failure.message));
    return ApiResult<bool>::success(true);
}

} // namespace

void register_stone_use_routes(httplib::Server& server) {
    server.Get("/stone-use", [](const httplib::Request&, httplib::Response& res) {
        const auto result = build_stone_use_json();
        if (!result.ok) { send_api_error(result, res); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content(result.value, "application/json; charset=utf-8");
    });

    auto toggle_handler = [](const httplib::Request& req, httplib::Response& res) {
        const auto command = parse_stone_use_command(req);
        if (!command.ok) { send_api_error(command, res); return; }
        const auto result = set_stone_use(command.value);
        if (!result.ok) { send_api_error(result, res); return; }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Post("/stone-use", toggle_handler);
}

} // namespace dwf
