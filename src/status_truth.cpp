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
// capture_state_mutex() lives here -- the route takes it before the CoreSuspender, in the same
// order every other read route does. Missing this include is what broke the merge build: the file
// compiled nowhere on its own because the agent was (correctly) barred from building the shared
// dfhack tree, so the omission only surfaced when the orchestrator built it.
#include "sdl_capture.h"
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
        // Same population the bubbles are drawn for: living fort citizens. A caged goblin has
        // counters too, but no sheet a player reads and no bubble we draw, so including it would
        // manufacture "disagreements" that mean nothing.
        if (!u || !DFHack::Units::isAlive(u) || !DFHack::Units::isCitizen(u, true))
            continue;

        // BOTH stress numbers ride the payload. DF grades its sheet word off longterm_stress; the
        // raw `stress` accumulator is what DFHack's getStressCategory reads and what we used to
        // bubble off. Shipping both is what lets the harness show the two diverging on a real dwarf
        // instead of arguing about it from source.
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
             // what the DLL ACTUALLY shipped -- recomputed here from the very same shared
             // functions the two serializers call, so a divergence between this and the wire is a
             // serializer bug and not a threshold bug.
             << ",\"st\":" << unit_status_bits(u)
             << ",\"st2\":" << unit_status_bits2(u)
             // DF's raw counters. NO threshold applied: the harness grades, the server reports.
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
