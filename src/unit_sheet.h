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

#include "httplib.h"

#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

#include "camera.h"

namespace df {
struct unit;
}

namespace dwf {

struct UnitAction {
    std::string hotkey;
    std::string label;
    std::string value;
    bool available = false;
};

struct UnitRelation {
    std::string label;
    std::string name;
    std::string profession;
    int32_t hf_id = -1;
    int32_t unit_id = -1;
    int32_t portrait_texpos = -1;
    int32_t sheet_icon_texpos = -1;
    std::string race_token;
    std::string caste_token;
    std::string age_class;
    std::string portrait_state;
    std::string portrait_kind;
    std::string color_role;
    int8_t profession_color = -1;   // DF's 4-bit profession colour index (0-15); -1 == unknown
    bool dead = false;
    int32_t order = 0;
};

struct UnitGroup {
    std::string entity_name;
    std::string status;
    std::string category;
    int32_t order = 0;
};

struct UnitRoom {
    std::string category;
    bool assigned = false;
    int32_t building_id = -1;
    std::string name;
    std::string quality;
    // The civzone's centre tile, for the client's zoom-to-room jump (-1 = unknown/unassigned).
    int32_t center_x = -1;
    int32_t center_y = -1;
    int32_t center_z = -1;
};

struct UnitInventoryRecord {
    int32_t item_id = -1;
    std::string role;
    int16_t body_part_id = -1;
    std::string body_part_name;
    std::string name;
    std::string color_role;
    int16_t quality = 0;
    int16_t wear = 0;
};

struct UnitSkillRecord {
    int16_t id = -1;
    std::string category;
    std::string caption;
    std::string rating_caption;
    int32_t rating = 0;
    int32_t effective_rating = 0;
    bool rusty = false;
    int32_t experience = 0;
    uint32_t xp_threshold = 0;
    std::string color_role;
    // DF colours a skill row by the SKILL's profession, not its level; -1 -> theme by color_role.
    int native_color = -1;
    int32_t order = 0;
};

struct UnitKnowledgeRecord {
    std::string type;
    int32_t id = -1;
    std::string title;
    std::string subtype;
    std::string color_role;
    std::string detail_target;
    int32_t order = 0;
};

struct UnitTextSpan {
    std::string text;
    std::string role;
    // Native curses colour index (0..15), or -1 = "no native colour, theme by role". Authoritative
    // over `role` for hue; `role` stays for weight and emphasis.
    int color = -1;
};

struct UnitTextParagraph {
    std::vector<UnitTextSpan> spans;
};

struct UnitNeedRecord {
    std::string type;
    int32_t level = 0;
    int32_t focus = 0;
    std::string satisfaction_band;
    int32_t target_hf_id = -1;
    std::string target_name;
    std::vector<UnitTextSpan> spans;
    int32_t order = 0;
};

struct UnitThoughtRecord {
    std::string category;
    int32_t emotion = -1;
    int32_t thought = -1;
    int32_t subthought = -1;
    int32_t strength = 0;
    int32_t year = -1;
    int32_t year_tick = -1;
    bool remembered = false;
    std::string dedup_key;
    std::vector<UnitTextSpan> spans;
    int32_t order = 0;
};

struct UnitLaborAnimalRecord {
    int32_t unit_id = -1;
    std::string name;
    std::string training_type;
    std::string assignment_state;
    std::string eligibility_reason;
    int32_t portrait_texpos = -1;
    int32_t sheet_icon_texpos = -1;
    std::string race_token;
    std::string caste_token;
    std::string age_class;
    std::string portrait_state;
    std::string portrait_kind;
    int32_t order = 0;
    // The animal's work-animal owner: unit.relationship_ids[PetOwner]; -1 == unassigned.
    int32_t owner_id = -1;
    std::string owner_name;
    bool assignable = false;
    std::string blocked_reason;
};

struct UnitSheet {
    bool present = false;
    int32_t id = -1;
    int32_t portrait_texpos = -1;
    int32_t sheet_icon_texpos = -1;
    std::string race_token;
    std::string caste_token;
    std::string age_class;
    std::string portrait_state;
    std::string portrait_kind;
    std::string name;
    std::string nickname;
    std::string race;
    std::string profession;
    int8_t profession_color = -1; // Units::getProfessionColor
    std::string current_job;
    std::string age;
    std::string sex;
    std::string status;
    std::string training;
    std::string body_summary;
    bool has_combat_reports = false;
    std::vector<std::string> overview_relation_lines;
    std::vector<std::string> overview_trait_lines;
    std::vector<std::string> overview_position_lines;
    std::vector<std::string> overview_squad_lines;
    std::vector<std::string> overview_skill_lines;
    std::vector<std::string> overview_need_lines;
    std::vector<std::string> overview_memory_lines;
    std::vector<std::string> flags;
    // [] means DF prints an empty box; an absent JSON key is the older-DLL case.
    std::vector<std::string> status_words;
    std::vector<std::string> status_lines;
    std::vector<std::string> inventory_lines;
    // The chief medical dwarf's DIAGNOSE level: 0 with none appointed, 15 outside fortress mode.
    int diagnosis_level = 0;
    // D == 0 whether nobody is appointed or the appointee cannot diagnose; only this flag separates them.
    bool chief_medical_appointed = false;
    std::vector<std::string> health_lines;
    std::vector<std::string> health_status_lines;
    std::vector<std::string> health_wound_lines;
    std::vector<std::string> health_treatment_lines;
    std::vector<std::string> health_history_lines;
    std::vector<std::string> health_description_lines;
    std::vector<std::string> skill_lines;
    std::vector<std::string> room_lines;
    std::vector<std::string> room_assignment_lines;
    std::vector<std::string> labor_lines;
    std::vector<std::string> labor_work_detail_lines;
    std::vector<std::string> labor_workshop_lines;
    std::vector<std::string> labor_location_lines;
    std::vector<std::string> labor_work_animal_lines;
    std::vector<std::string> relation_lines;
    std::vector<std::string> group_lines;
    std::vector<std::string> military_lines;
    std::vector<std::string> military_squad_lines;
    std::vector<std::string> military_uniform_lines;
    std::vector<std::string> military_kill_lines;
    std::vector<std::string> thought_lines;
    std::vector<std::string> personality_lines;
    std::vector<std::string> personality_trait_lines;
    std::vector<std::string> personality_value_lines;
    std::vector<std::string> personality_preference_lines;
    std::vector<std::string> personality_need_lines;
    std::vector<UnitRelation> relations;
    std::vector<UnitGroup> groups;
    std::vector<UnitRoom> rooms;
    std::vector<UnitInventoryRecord> inventory;
    std::vector<UnitSkillRecord> skills;
    std::vector<UnitKnowledgeRecord> knowledge;
    std::vector<UnitTextParagraph> personality_traits;
    std::vector<UnitTextParagraph> personality_values;
    std::vector<UnitTextParagraph> personality_preferences;
    std::vector<UnitTextParagraph> personality_needs;
    std::string personality_focus_summary;
    std::vector<UnitNeedRecord> needs;
    std::vector<UnitThoughtRecord> recent_thoughts;
    std::vector<UnitThoughtRecord> memories;
    std::vector<UnitLaborAnimalRecord> labor_work_animals;
    std::vector<UnitAction> actions;
};

UnitSheet build_unit_sheet(df::unit* unit);

void append_unit_sheet_json(std::ostringstream& body, const UnitSheet& unit);

// `following` == this player's FollowTarget is this unit.
std::string unit_sheet_json(const std::string& player,
                            const UnitSheet& unit,
                            const Camera& tile,
                            bool following = false);

bool unit_sheet_on_render_thread(int32_t unit_id,
                                 UnitSheet& unit,
                                 Camera& tile,
                                 std::string* err = nullptr);

void register_unit_routes(httplib::Server& server);

} // namespace dwf
