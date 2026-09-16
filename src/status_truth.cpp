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

#include "status_truth.h"

#include <sstream>
#include <string>
#include <vector>

#include "client_state.h"
#include "json_util.h"
#include "sdl_capture.h"   // capture_state_mutex()
#include "unit_status.h"
#include "unit_status_words.h"

#include "Core.h"
#include "DataDefs.h"
#include "modules/Translation.h"
#include "modules/Units.h"

#include "df/global_objects.h"
#include "df/unit.h"
#include "df/unit_personality.h"
#include "df/unit_soul.h"
#include "df/world.h"

namespace dwf {

namespace {

std::string build_status_truth_json() {
    std::ostringstream body;
    body << "{\"v\":1,\"units\":[";

    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;

    df::world* world = df::global::world;
    if (!world) {
        body << "]}";
        return body.str();
    }

    bool first = true;
    for (df::unit* u : world->units.active) {
        // Must stay the same population the bubbles are drawn for, or the cross-check
        // manufactures disagreements that mean nothing.
        if (!u || !unit_is_animate(u) || !DFHack::Units::isCitizen(u, true))
            continue;

        int32_t stress = 0, longterm_stress = 0;
        if (df::unit_soul* soul = u->status.current_soul) {
            stress = soul->personality.stress;
            longterm_stress = soul->personality.longterm_stress;
        }

        std::vector<std::string> words = unit_status_words(u);
        std::vector<std::string> needs = unit_unmet_need_lines(u);

        if (!first)
            body << ',';
        first = false;

        body << "{\"id\":" << u->id
             << ",\"name\":" << json_string(DFHack::Translation::translateName(&u->name, false))
             << ",\"st\":" << unit_status_bits(u)
             << ",\"st2\":" << unit_status_bits2(u)
             << ",\"hunger_timer\":" << u->counters2.hunger_timer
             << ",\"thirst_timer\":" << u->counters2.thirst_timer
             << ",\"sleepiness_timer\":" << u->counters2.sleepiness_timer
             << ",\"exhaustion\":" << u->counters2.exhaustion
             << ",\"paralysis\":" << u->counters2.paralysis
             << ",\"numbness\":" << u->counters2.numbness
             << ",\"fever\":" << u->counters2.fever
             << ",\"stress\":" << stress
             << ",\"longterm_stress\":" << longterm_stress
             << ",\"unconscious\":" << u->counters.unconscious
             << ",\"stunned\":" << u->counters.stunned
             << ",\"winded\":" << u->counters.winded
             << ",\"webbed\":" << u->counters.webbed
             << ",\"pain\":" << u->counters.pain
             << ",\"nausea\":" << u->counters.nausea
             << ",\"dizziness\":" << u->counters.dizziness
             << ",\"words\":";
        append_json_string_array(body, words);
        body << ",\"needs\":";
        append_json_string_array(body, needs);
        body << '}';
    }
    body << "]}";
    return body.str();
}

} // namespace

void register_status_truth_routes(httplib::Server& server) {
    server.Get("/statustruth", [](const httplib::Request&, httplib::Response& res) {
        std::string json = build_status_truth_json();
        res.set_header("Cache-Control", "no-store");
        res.set_content(json, "application/json; charset=utf-8");
    });
}

} // namespace dwf
