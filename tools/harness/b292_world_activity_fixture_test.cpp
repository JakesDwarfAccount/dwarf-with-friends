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

#include "../../src/unit_activity_logic.h"

#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>

struct FixtureEvent {
    int32_t event_id;
    int32_t parent_event_id;
    std::vector<int32_t> participants;
    std::string label;
};

struct FixtureUnit {
    int32_t id;
    void* current_job = nullptr;
    std::vector<int32_t> individual_drills;
    std::vector<int32_t> social_activities;
    std::vector<int32_t> conversations;
    std::vector<int32_t> activities;
};

int main() {
    // the live 4009/4959 shape: every unit-owned source is empty, while the world activity has
    // nested TrainingSession > CombatTraining > SkillDemonstration events that all list the unit.
    FixtureUnit unit{4009};
    std::vector<FixtureEvent> activity4959 = {
        {0, -1, {4009}, "Training Session"},
        {1, 0, {4009}, "Combat Training"},
        {2, 1, {4009}, "Watch Dodging Demonstration"},
    };

    assert(!unit.current_job && unit.individual_drills.empty() &&
           unit.social_activities.empty() && unit.conversations.empty() && unit.activities.empty());

    // The removed resolver had no world input, so this fixture really did resolve to No job.
    auto old_name = unit.current_job ? std::string("Working") : std::string("No job");
    assert(old_name == "No job");

    FixtureEvent* best = nullptr;
    dwf::activity_detail::CandidateRank best_rank{-1, 0};
    for (size_t order = 0; order < activity4959.size(); ++order) {
        auto& event = activity4959[order];
        int depth = event.event_id; // fixture IDs deliberately encode the observed parent chain
        for (auto participant : event.participants) {
            if (participant == unit.id && (!best || dwf::activity_detail::candidate_wins(
                    {depth, order}, best_rank))) {
                best = &event;
                best_rank = {depth, order};
            }
        }
    }

    auto resolved = dwf::activity_detail::resolve_current_task(
        static_cast<int*>(nullptr), static_cast<FixtureEvent*>(nullptr), best,
        [](int*) { return std::string("Working"); },
        [](FixtureEvent* event) { return event->label; });
    assert(resolved == "Watch Dodging Demonstration");
    std::cout << "PASS b292 world activity fixture: " << resolved << '\n';
}
