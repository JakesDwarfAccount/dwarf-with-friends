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

#include "df/historical_entity.h"
#include "df/historical_entity_type.h"
#include "df/world_data.h"
#include "df/region_map_entry.h"
#include "df/world_site.h"
#include "df/world_site_inhabitant.h"
#include "df/world_site_type.h"
#include "df/site_map_infost.h"
#include "df/fortress_type.h"
#include "df/monument_type.h"
#include "df/lair_type.h"

#include <cstdint>
#include <string>

namespace dwf {

// LEDGER 0064 R1. DF does not store a site's displayed kind; it computes one, and several
// world_site_type values map to more than one displayed word. Three of those splits are pinned by
// name in df-structures: site_map_infost carries fortress_type, monument_type and lair_type, each
// commented "only when site.type = <X>". Serving that subtype key lets the client stop printing
// one word for a tower and a castle, or for a lair and a shrine.
//
// DELIBERATELY NOT SERVED: 0064's other branches (the dwarven underground/surface population
// split, and the type-1 / type-5 entity-flag splits). The ledger identifies those by raw byte
// offsets only, and those offsets do not line up with any named population or entity-link field
// in df-structures -- see the sweep report. Inventing a word off an unverified offset is exactly
// the class of guess this codebase refuses to ship. Those sites keep their plain type key.
// Returns an empty string when this site type has no pinned subtype, or DF has not filled one in.
inline std::string site_subtype_key(const df::world_site* site) {
    if (!site || !site->subtype_info)
        return {};
    switch (site->type) {
    case df::world_site_type::Fortress:
        if (site->subtype_info->fortress_type == df::fortress_type::NONE) return {};
        return DFHack::enum_item_key(site->subtype_info->fortress_type);
    case df::world_site_type::Monument:
        if (site->subtype_info->monument_type == df::monument_type::NONE) return {};
        return DFHack::enum_item_key(site->subtype_info->monument_type);
    case df::world_site_type::LairShrine:
        if (site->subtype_info->lair_type == df::lair_type::NONE) return {};
        return DFHack::enum_item_key(site->subtype_info->lair_type);
    default:
        return {};
    }
}

struct SitePopulationBand {
    int index;
    const char* advertised;
};

inline SitePopulationBand site_population_band(const df::world_site* site) {
    int64_t population = site ? static_cast<int64_t>(site->populace.nemesis.size()) : 0;
    if (site) {
        for (auto* inhabitant : site->populace.inhabitants) {
            if (inhabitant && inhabitant->count > 0 &&
                inhabitant->pop_spec.interaction_index == -1)
                population += inhabitant->count;
        }
    }
    static const int thresholds[] = {
        7, 15, 25, 35, 45, 55, 65, 85, 150, 250, 350, 450,
        550, 650, 850, 1500, 2500, 3500, 4500, 5500, 6500, 8500, 12500
    };
    static const char* advertised[] = {
        "fewer than ten", "about 10", "about 20", "about 30", "about 40", "about 50",
        "about 60", "about 75", "about 100", "about 200", "about 300", "about 400",
        "about 500", "about 600", "about 750", "about 1,000", "about 2,000",
        "about 3,000", "about 4,000", "about 5,000", "about 6,000", "about 7,500",
        "about 10,000"
    };
    for (int i = 0; i < 23; ++i)
        if (population < thresholds[i])
            return {i + 1, advertised[i]};
    return {24, "more than 10,000"};
}

inline df::historical_entity* site_government(const df::world_site* site) {
    auto* entity = site ? df::historical_entity::find(site->cur_owner_id) : nullptr;
    return entity && entity->type == df::historical_entity_type::SiteGovernment ? entity : nullptr;
}

// path_map below path_start means unreachable.
inline int32_t site_travel_cost(const df::world_data* world_data, const df::world_site* site) {
    if (!world_data || !site || !world_data->region_map ||
        site->pos.x < 0 || site->pos.x >= world_data->world_width ||
        site->pos.y < 0 || site->pos.y >= world_data->world_height)
        return -1;
    int32_t value = world_data->region_map[site->pos.x][site->pos.y].path_map;
    return value < world_data->path_start ? -1 : value - world_data->path_start;
}

} // namespace dwf
