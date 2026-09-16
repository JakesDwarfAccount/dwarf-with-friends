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

#include "worldmap_panel.h"

#include "Core.h"
#include "json_util.h"
#include "panel_http.h"
#include "sdl_capture.h"
#include "world_site_readonly.h"

#include "modules/Translation.h"
#include "modules/Items.h"
#include "modules/Units.h"

#include "df/global_objects.h"
#include "df/army_controller.h"
#include "df/artifact_record.h"
#include "df/diplomacy_statest.h"
#include "df/entity_event.h"
#include "df/historical_entity.h"
#include "df/historical_entity_type.h"
#include "df/item.h"
#include "df/plotinfost.h"
#include "df/mission_report.h"
#include "df/region_map_entry.h"
#include "df/spoils_report.h"
#include "df/unit.h"
#include "df/world.h"
#include "df/world_data.h"
#include "df/world_region.h"
#include "df/world_site.h"
#include "df/world_site_type.h"

#include <algorithm>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_worldmap_mutex;

template <typename Fn>
bool run_worldmap_locked(Fn&& fn) {
    return run_panel_locked(g_worldmap_mutex, std::forward<Fn>(fn));
}

std::string entity_name(df::historical_entity* entity) {
    if (!entity)
        return "";
    std::string name = DFHack::Translation::translateName(&entity->name, true);
    return name;
}

std::string site_name(df::world_data* wd, int32_t site_id) {
    if (!wd) return "";
    for (auto* site : wd->sites)
        if (site && site->id == site_id)
            return DFHack::Translation::translateName(&site->name, true);
    return "";
}

std::string diplomacy_relation_to(df::historical_entity* entity, int32_t group_id,
                                  int32_t civ_id) {
    if (!entity) return "Unknown";
    for (auto* state : entity->relations.diplomacy.state) {
        if (!state || (state->group_id != group_id && state->group_id != civ_id)) continue;
        std::string key = DFHack::enum_item_key(state->relation);
        return key.empty() ? "Unknown" : key;
    }
    return entity->id == civ_id ? "Own civilization" : "Unknown";
}

// elevation below 100 is water and 150+ is mountain; vegetation/rainfall/salinity are 0-100.
char classify_region_char(const df::region_map_entry& e) {
    int elev = e.elevation;
    if (elev < 100)
        return (e.salinity >= 33) ? '~' : 'l'; // salt ocean vs fresh lake
    if (elev >= 150)
        return '^';                             // mountains
    int veg = e.vegetation;
    if (veg >= 66) return 'T';                  // forest
    if (veg >= 33) return '.';                  // grassland / light vegetation
    if (e.rainfall < 33) return 'd';            // arid -> desert
    return 'n';                                 // barren / rock
}

// The additive "terrain" field: a downsampled biome-char grid of the world (rows are y, chars x).
void append_terrain_json(std::ostringstream& body, df::world_data* wd) {
    if (!wd || !wd->region_map || wd->world_width <= 0 || wd->world_height <= 0)
        return;
    const int W = wd->world_width, H = wd->world_height;
    const int MAX_DIM = 200; // cap the larger world dimension in samples
    int step = (std::max(W, H) + MAX_DIM - 1) / MAX_DIM;
    if (step < 1) step = 1;
    const int OW = (W + step - 1) / step;
    const int OH = (H + step - 1) / step;
    body << ",\"terrain\":{\"w\":" << OW << ",\"h\":" << OH << ",\"step\":" << step << ",\"rows\":[";
    std::string row;
    row.reserve(OW);
    for (int ty = 0; ty < OH; ++ty) {
        int wy = ty * step;
        if (wy >= H) wy = H - 1;
        row.clear();
        for (int tx = 0; tx < OW; ++tx) {
            int wx = tx * step;
            if (wx >= W) wx = W - 1;
            row.push_back(classify_region_char(wd->region_map[wx][wy]));
        }
        if (ty) body << ",";
        body << json_string(row);
    }
    body << "]}";
}

std::string build_worldmap_json(const std::string& player, std::string* err) {
    std::ostringstream body;
    bool ok = run_worldmap_locked([&]() -> bool {
        auto world = df::global::world;
        auto plotinfo = df::global::plotinfo;
        if (!world || !world->world_data) { if (err) *err = "world data unavailable"; return false; }
        auto wd = world->world_data;
        int32_t own_site = plotinfo ? plotinfo->site_id : -1;
        int32_t own_group = plotinfo ? plotinfo->group_id : -1;
        int32_t own_civ = plotinfo ? plotinfo->civ_id : -1;
        auto* fort_entity = df::historical_entity::find(own_group);

        std::unordered_map<int32_t, std::string> region_name_cache;
        auto region_name_at = [&](const df::coord2d& pos) -> std::string {
            if (!wd->region_map || wd->world_width <= 0 || wd->world_height <= 0 ||
                pos.x < 0 || pos.x >= wd->world_width || pos.y < 0 || pos.y >= wd->world_height)
                return "";
            int32_t region_id = wd->region_map[pos.x][pos.y].region_id;
            if (region_id < 0 || static_cast<size_t>(region_id) >= wd->regions.size() ||
                !wd->regions[region_id])
                return "";
            auto hit = region_name_cache.find(region_id);
            if (hit != region_name_cache.end())
                return hit->second;
            std::string name = DFHack::Translation::translateName(&wd->regions[region_id]->name, true);
            region_name_cache.emplace(region_id, name);
            return name;
        };

        std::string region_name;
        for (auto site : wd->sites) {
            if (!site || site->id != own_site)
                continue;
            region_name = region_name_at(site->pos);
            break;
        }

        int32_t missing_citizen_count = 0;
        for (auto* unit : world->units.active) {
            if (unit && Units::isOwnGroup(unit) &&
                (!Units::isActive(unit) || Units::isDead(unit) || Units::isGhost(unit)))
                ++missing_citizen_count;
        }

        int32_t artifact_count = 0;
        {
            int32_t fort_site = (plotinfo && plotinfo->main.fortress_site)
                ? plotinfo->main.fortress_site->id : -1;
            for (auto* artifact : world->artifacts.all) {
                if (!artifact) continue;
                bool on_map = false;
                if (artifact->item && !artifact->item->flags.bits.removed &&
                    !artifact->item->flags.bits.garbage_collect) {
                    df::coord p = Items::getPosition(artifact->item);
                    on_map = (p.x >= 0 && p.y >= 0 && p.z >= 0);
                }
                if (on_map || (fort_site >= 0 &&
                               (artifact->site == fort_site || artifact->storage_site == fort_site)))
                    ++artifact_count;
            }
        }

        const auto& mission_reports = world->status.mission_reports;
        const auto& tribute_reports = world->status.spoils_reports;
        int32_t report_count = static_cast<int32_t>(mission_reports.size() + tribute_reports.size());

        body << "{\"player\":" << json_string(player)
             << ",\"width\":" << wd->world_width
             << ",\"height\":" << wd->world_height
             << ",\"ownSiteId\":" << own_site
             << ",\"regionName\":" << json_string(region_name)
             << ",\"missingCitizenCount\":" << missing_citizen_count
             << ",\"artifactCount\":" << artifact_count
             << ",\"reportCount\":" << report_count
             << ",\"sites\":[";
        bool first = true;
        int count = 0;
        for (auto site : wd->sites) {
            if (!site)
                continue;
            if (!first) body << ",";
            first = false;
            std::string name = DFHack::Translation::translateName(&site->name, true);
            auto* government = site_government(site);
            auto* civilization = df::historical_entity::find(site->civ_id);
            int32_t travel_cost = site_travel_cost(wd, site);
            body << "{\"id\":" << site->id
                 << ",\"name\":" << json_string(name)
                 << ",\"type\":" << json_string(DFHack::enum_item_key(site->type))
                 << ",\"subtypeKey\":" << json_string(site_subtype_key(site))
                 << ",\"regionName\":" << json_string(region_name_at(site->pos))
                 << ",\"x\":" << site->pos.x
                 << ",\"y\":" << site->pos.y
                 << ",\"civId\":" << site->civ_id
                 << ",\"own\":" << (site->id == own_site ? "true" : "false")
                 << ",\"hasGovernment\":" << (government ? "true" : "false")
                 << ",\"govName\":";
            if (government) body << json_string(entity_name(government)); else body << "null";
            body << ",\"civName\":";
            if (civilization) body << json_string(entity_name(civilization)); else body << "null";
            body << ",\"travelBand\":";
            const char* travel_band = "unreachable";
            int travel_days = -1;
            if (travel_cost >= 18) { travel_band = "days"; travel_days = travel_cost / 9; }
            else if (travel_cost >= 11) travel_band = "over-day";
            else if (travel_cost >= 8) travel_band = "day";
            else if (travel_cost >= 6) travel_band = "near-day";
            else if (travel_cost >= 3) travel_band = "half-day";
            else if (travel_cost >= 0) travel_band = "brief";
            body << json_string(travel_band) << ",\"travelDays\":";
            if (travel_days >= 0) body << travel_days; else body << "null";
            body << ",\"populationBand\":";
            if (government) {
                SitePopulationBand band = site_population_band(site);
                body << "{\"index\":" << band.index
                     << ",\"advertised\":" << json_string(band.advertised) << "}";
            } else {
                body << "null";
            }
            body << "}";
            if (++count >= 2000)
                break;
        }
        body << "],\"civs\":[";
        first = true;
        for (auto entity : world->entities.all) {
            if (!entity || entity->type != df::historical_entity_type::Civilization)
                continue;
            std::string name = entity_name(entity);
            if (name.empty())
                continue;
            if (!first) body << ",";
            first = false;
            int site_count = 0;
            for (auto* site : wd->sites)
                if (site && site->civ_id == entity->id) ++site_count;
            body << "{\"id\":" << entity->id
                 << ",\"name\":" << json_string(name)
                 << ",\"race\":" << entity->race
                 << ",\"siteCount\":" << site_count
                 << ",\"knownSiteCount\":" << entity->relations.known_sites.size()
                 << ",\"population\":" << std::max(0, entity->total_pop)
                 << ",\"relation\":" << json_string(diplomacy_relation_to(entity, own_group, own_civ))
                 << ",\"warFatigue\":" << entity->war_fatigue
                 << ",\"meetingCount\":" << entity->meeting_events.size()
                 << ",\"lastReportYear\":" << entity->last_report_year
                 << "}";
        }
        body << "],\"missions\":[";
        first = true;
        for (auto* controller : world->army_controllers.all) {
            if (!controller || controller->assigned_squads.empty()) continue;
            bool fort_mission = false;
            if (fort_entity) {
                for (int32_t squad_id : controller->assigned_squads)
                    if (std::find(fort_entity->squads.begin(), fort_entity->squads.end(), squad_id) != fort_entity->squads.end()) {
                        fort_mission = true;
                        break;
                    }
            }
            if (!fort_mission && controller->entity_id != own_group && controller->entity_id != own_civ) continue;
            if (!first) body << ",";
            first = false;
            std::string goal = DFHack::enum_item_key(controller->goal);
            std::string target = site_name(wd, controller->site_id);
            body << "{\"id\":" << controller->id
                 << ",\"goal\":" << json_string(goal.empty() ? "Unknown mission" : goal)
                 << ",\"targetSiteId\":" << controller->site_id
                 << ",\"targetSite\":" << json_string(target)
                 << ",\"year\":" << controller->year
                 << ",\"yearTick\":" << controller->year_tick
                 << ",\"reportTitle\":" << json_string(controller->mission_report ? controller->mission_report->title : "")
                 << ",\"squadIds\":[";
            for (size_t i = 0; i < controller->assigned_squads.size(); ++i) {
                if (i) body << ",";
                body << controller->assigned_squads[i];
            }
            body << "]}";
        }
        body << "],\"news\":[";
        first = true;
        auto append_news = [&](df::historical_entity* source) {
            if (!source) return;
            int emitted = 0;
            for (auto it = source->rumor_info.events.rbegin(); it != source->rumor_info.events.rend() && emitted < 200; ++it) {
                auto* event = *it;
                if (!event) continue;
                if (!first) body << ",";
                first = false;
                std::string type = DFHack::enum_item_key(event->type);
                body << "{\"sourceEntityId\":" << source->id
                     << ",\"source\":" << json_string(entity_name(source))
                     << ",\"type\":" << json_string(type.empty() ? "Unknown rumor" : type)
                     << ",\"year\":" << event->year
                     << ",\"yearTick\":" << event->year_tick << "}";
                ++emitted;
            }
        };
        append_news(fort_entity);
        if (own_civ != own_group) append_news(df::historical_entity::find(own_civ));
        body << "]";

        body << ",\"reports\":[";
        first = true;
        // Neither report record carries an id field, so the vector index IS the id: it must stay
        // namespaced by `kind`, because the two vectors number independently and would collide.
        auto append_reports = [&](const auto& vec, const char* kind) {
            int emitted = 0;
            for (size_t i = 0; i < vec.size() && emitted < 500; ++i) {
                auto* report = vec[i];
                if (!report) continue;
                if (!first) body << ",";
                first = false;
                body << "{\"id\":" << static_cast<int32_t>(i)
                     << ",\"kind\":" << json_string(kind)
                     << ",\"title\":" << json_string(report->title)
                     << ",\"year\":" << report->year << "}";
                ++emitted;
            }
        };
        append_reports(mission_reports, "mission");
        append_reports(tribute_reports, "tribute");
        body << "]";
        append_terrain_json(body, wd);
        body << "}\n";
        return true;
    });
    if (!ok)
        return "";
    return body.str();
}

} // namespace

void register_worldmap_routes(httplib::Server& server) {
    // GET /world-map -> read-only world overview: sites, civs, missions, news, reports, terrain.
    server.Get("/world-map", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        std::string err;
        std::string json = build_worldmap_json(player, &err);
        if (json.empty()) { json_error(res, 503, err.empty() ? "world map unavailable" : err); return; }
        set_no_store_json(res, json);
    });
}

} // namespace dwf
