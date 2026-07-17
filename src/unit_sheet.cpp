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

#include "unit_sheet.h"

#include "http_server.h"
#include "info_panel.h"
#include "client_state.h"
#include "image_encoder.h"
#include "unit_portrait.h"
#include "unit_sprites.h"
#include "unit_activity.h"

#include "interaction.h"

#include "json_util.h"

#include "MiscUtils.h"
#include "modules/Buildings.h"
#include "modules/DFSDL.h"
#include "modules/Items.h"
#include "modules/Job.h"
#include "modules/Translation.h"
#include "modules/Units.h"

#include "df/body_part_raw.h"
#include "df/building.h"
#include "df/building_civzonest.h"
#include "df/caste_body_info.h"
#include "df/caste_raw.h"
#include "df/civzone_type.h"
#include "df/cultural_identity.h"
#include "df/dance_form.h"
#include "df/descriptor_color.h"
#include "df/descriptor_shape.h"
#include "df/dfhack_room_quality_level.h"
#include "df/creature_raw.h"
#include "df/emotion_type.h"
#include "df/entity_position.h"
#include "df/entity_position_assignment.h"
#include "df/entity_raw.h"
#include "df/goal_type.h"
#include "df/global_objects.h"
#include "df/historical_figure.h"
#include "df/historical_figure_info.h"
#include "df/historical_figure_relationships.h"
#include "df/historical_entity.h"
#include "df/historical_entity_type.h"
#include "df/job_skill_class.h"
#include "df/historical_kills.h"
#include "df/histfig_entity_link.h"
#include "df/histfig_entity_link_type.h"
#include "df/histfig_hf_link.h"
#include "df/histfig_hf_link_type.h"
#include "df/history_event.h"
#include "df/history_event_hist_figure_diedst.h"
#include "df/inv_item_role_type.h"
#include "df/item.h"
#include "df/item_type.h"
#include "df/job.h"
#include "df/job_item_ref.h"
#include "df/job_skill.h"
#include "df/profession.h"
#include "df/mental_attribute_type.h"
#include "df/need_type.h"
#include "df/personality_goalst.h"
#include "df/knowledge_profilest.h"
#include "df/mannerismst.h"
#include "df/musical_form.h"
#include "df/personality_facet_type.h"
#include "df/personality_memory_handlerst.h"
#include "df/personality_moodst.h"
#include "df/personality_needst.h"
#include "df/personality_preferencest.h"
#include "df/personality_preference_type.h"
#include "df/personality_valuest.h"
#include "df/plant_raw.h"
#include "df/poetic_form.h"
#include "df/physical_attribute_type.h"
#include "df/plotinfost.h"
#include "df/pronoun_type.h"
#include "df/relationship_profile_hf_visualst.h"
#include "df/skill_rating.h"
#include "df/squad.h"
#include "df/squad_position.h"
#include "df/squad_position_equipmentst.h"
#include "df/squad_uniform_spec.h"
#include "df/training_assignment.h"
#include "df/uniform_category.h"
#include "df/unit.h"
#include "df/unit_emotion_memory.h"
#include "df/unit_health_flags.h"
#include "df/unit_health_info.h"
#include "df/unit_inventory_item.h"
#include "df/unit_labor.h"
#include "df/unit_preference.h"
#include "df/unit_relationship_type.h"
#include "df/unit_skill.h"
#include "df/unit_soul.h"
#include "df/unit_thought_type.h"
#include "df/unit_wound.h"
#include "df/unit_wound_flag.h"
#include "df/unit_wound_layerst.h"
#include "df/value_type.h"
#include "df/written_content.h"
#include "df/written_content_type.h"
#include "df/world.h"
#include "df/wound_effect_type.h"

#include <algorithm>
#include <cctype>
#include <exception>
#include <future>
#include <iterator>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_unit_sheet_mutex;

void append_lines(std::ostringstream& body, const std::vector<std::string>& lines) {
    append_json_string_array(body, lines);
}

void append_relations(std::ostringstream& body, const std::vector<UnitRelation>& relations) {
    body << "[";
    for (size_t i = 0; i < relations.size(); ++i) {
        if (i)
            body << ",";
        const auto& relation = relations[i];
        body << "{"
             << "\"label\":" << json_string(relation.label) << ","
             << "\"name\":" << json_string(relation.name) << ","
             << "\"profession\":" << json_string(relation.profession) << ","
             << "\"hfId\":" << relation.hf_id << ","
             << "\"unitId\":" << relation.unit_id << ","
             << "\"portraitTexpos\":" << relation.portrait_texpos << ","
             << "\"sheetIconTexpos\":" << relation.sheet_icon_texpos << ","
             << "\"rt\":" << json_string(relation.race_token) << ","
             << "\"ct\":" << json_string(relation.caste_token) << ","
             << "\"age\":" << json_string(relation.age_class) << ","
             << "\"ageClass\":" << json_string(relation.age_class) << ","
             << "\"portraitState\":" << json_string(relation.portrait_state) << ","
             << "\"portraitKind\":" << json_string(relation.portrait_kind) << ","
             << "\"colorRole\":" << json_string(relation.color_role) << ","
             // W4: DF's own profession colour index (0-15, -1 unknown) + the dead flag. Additive --
             // `colorRole` above is untouched, so an older client keeps its relation-type colours.
             << "\"professionColor\":" << static_cast<int>(relation.profession_color) << ","
             << "\"dead\":" << (relation.dead ? "true" : "false") << ","
             << "\"order\":" << relation.order
             << "}";
    }
    body << "]";
}

void append_groups(std::ostringstream& body, const std::vector<UnitGroup>& groups) {
    body << "[";
    for (size_t i = 0; i < groups.size(); ++i) {
        if (i)
            body << ",";
        const auto& group = groups[i];
        body << "{"
             << "\"entityName\":" << json_string(group.entity_name) << ","
             << "\"status\":" << json_string(group.status) << ","
             << "\"category\":" << json_string(group.category) << ","
             << "\"order\":" << group.order
             << "}";
    }
    body << "]";
}

void append_rooms(std::ostringstream& body, const std::vector<UnitRoom>& rooms) {
    body << "[";
    for (size_t i = 0; i < rooms.size(); ++i) {
        if (i)
            body << ",";
        const auto& room = rooms[i];
        body << "{"
             << "\"category\":" << json_string(room.category) << ","
             << "\"assigned\":" << (room.assigned ? "true" : "false") << ","
             << "\"buildingId\":" << room.building_id << ","
             << "\"name\":" << json_string(room.name) << ","
             << "\"quality\":" << json_string(room.quality) << ","
             << "\"centerX\":" << room.center_x << ","
             << "\"centerY\":" << room.center_y << ","
             << "\"centerZ\":" << room.center_z
             << "}";
    }
    body << "]";
}

void append_inventory(std::ostringstream& body, const std::vector<UnitInventoryRecord>& inventory) {
    body << "[";
    for (size_t i = 0; i < inventory.size(); ++i) {
        if (i)
            body << ",";
        const auto& record = inventory[i];
        body << "{"
             << "\"itemId\":" << record.item_id << ","
             << "\"role\":" << json_string(record.role) << ","
             << "\"bodyPartId\":" << record.body_part_id << ","
             << "\"bodyPartName\":" << json_string(record.body_part_name) << ","
             << "\"name\":" << json_string(record.name) << ","
             << "\"colorRole\":" << json_string(record.color_role) << ","
             << "\"quality\":" << record.quality << ","
             << "\"wear\":" << record.wear
             << "}";
    }
    body << "]";
}

void append_text_spans(std::ostringstream& body, const std::vector<UnitTextSpan>& spans) {
    body << "[";
    for (size_t i = 0; i < spans.size(); ++i) {
        if (i)
            body << ",";
        body << "{"
             << "\"text\":" << json_string(spans[i].text) << ","
             << "\"role\":" << json_string(spans[i].role);
        if (spans[i].color >= 0)
            body << ",\"color\":" << spans[i].color;
        body << "}";
    }
    body << "]";
}

void append_text_paragraphs(std::ostringstream& body,
                            const std::vector<UnitTextParagraph>& paragraphs) {
    body << "[";
    for (size_t i = 0; i < paragraphs.size(); ++i) {
        if (i)
            body << ",";
        body << "{\"spans\":";
        append_text_spans(body, paragraphs[i].spans);
        body << "}";
    }
    body << "]";
}

void append_skills(std::ostringstream& body, const std::vector<UnitSkillRecord>& skills) {
    body << "[";
    for (size_t i = 0; i < skills.size(); ++i) {
        if (i)
            body << ",";
        const auto& skill = skills[i];
        body << "{"
             << "\"id\":" << skill.id << ","
             << "\"category\":" << json_string(skill.category) << ","
             << "\"caption\":" << json_string(skill.caption) << ","
             << "\"ratingCaption\":" << json_string(skill.rating_caption) << ","
             << "\"rating\":" << skill.rating << ","
             << "\"effectiveRating\":" << skill.effective_rating << ","
             << "\"rusty\":" << (skill.rusty ? "true" : "false") << ","
             << "\"experience\":" << skill.experience << ","
             << "\"xpThreshold\":" << skill.xp_threshold << ","
             << "\"colorRole\":" << json_string(skill.color_role) << ",";
        if (skill.native_color >= 0)
            body << "\"color\":" << skill.native_color << ",";
        body << "\"order\":" << skill.order
             << "}";
    }
    body << "]";
}

void append_knowledge(std::ostringstream& body,
                      const std::vector<UnitKnowledgeRecord>& knowledge) {
    body << "[";
    for (size_t i = 0; i < knowledge.size(); ++i) {
        if (i)
            body << ",";
        const auto& record = knowledge[i];
        body << "{"
             << "\"type\":" << json_string(record.type) << ","
             << "\"id\":" << record.id << ","
             << "\"title\":" << json_string(record.title) << ","
             << "\"subtype\":" << json_string(record.subtype) << ","
             << "\"colorRole\":" << json_string(record.color_role) << ","
             << "\"detailTarget\":" << json_string(record.detail_target) << ","
             << "\"order\":" << record.order
             << "}";
    }
    body << "]";
}

void append_needs(std::ostringstream& body, const std::vector<UnitNeedRecord>& needs) {
    body << "[";
    for (size_t i = 0; i < needs.size(); ++i) {
        if (i)
            body << ",";
        const auto& need = needs[i];
        body << "{"
             << "\"type\":" << json_string(need.type) << ","
             << "\"level\":" << need.level << ","
             << "\"focus\":" << need.focus << ","
             << "\"satisfactionBand\":" << json_string(need.satisfaction_band) << ","
             << "\"targetHfId\":" << need.target_hf_id << ","
             << "\"targetName\":" << json_string(need.target_name) << ","
             << "\"spans\":";
        append_text_spans(body, need.spans);
        body << ",\"order\":" << need.order << "}";
    }
    body << "]";
}

void append_thoughts(std::ostringstream& body, const std::vector<UnitThoughtRecord>& thoughts) {
    body << "[";
    for (size_t i = 0; i < thoughts.size(); ++i) {
        if (i)
            body << ",";
        const auto& thought = thoughts[i];
        body << "{"
             << "\"category\":" << json_string(thought.category) << ","
             << "\"emotion\":" << thought.emotion << ","
             << "\"thought\":" << thought.thought << ","
             << "\"subthought\":" << thought.subthought << ","
             << "\"strength\":" << thought.strength << ","
             << "\"year\":" << thought.year << ","
             << "\"yearTick\":" << thought.year_tick << ","
             << "\"remembered\":" << (thought.remembered ? "true" : "false") << ","
             << "\"dedupKey\":" << json_string(thought.dedup_key) << ","
             << "\"spans\":";
        append_text_spans(body, thought.spans);
        body << ",\"order\":" << thought.order << "}";
    }
    body << "]";
}

void append_labor_animals(std::ostringstream& body,
                          const std::vector<UnitLaborAnimalRecord>& animals) {
    body << "[";
    for (size_t i = 0; i < animals.size(); ++i) {
        if (i)
            body << ",";
        const auto& animal = animals[i];
        body << "{"
             << "\"unitId\":" << animal.unit_id << ","
             << "\"name\":" << json_string(animal.name) << ","
             << "\"trainingType\":" << json_string(animal.training_type) << ","
             << "\"assignmentState\":" << json_string(animal.assignment_state) << ","
             << "\"eligibilityReason\":" << json_string(animal.eligibility_reason) << ","
             << "\"portraitTexpos\":" << animal.portrait_texpos << ","
             << "\"sheetIconTexpos\":" << animal.sheet_icon_texpos << ","
             << "\"rt\":" << json_string(animal.race_token) << ","
             << "\"ct\":" << json_string(animal.caste_token) << ","
             << "\"ageClass\":" << json_string(animal.age_class) << ","
             << "\"portraitState\":" << json_string(animal.portrait_state) << ","
             << "\"portraitKind\":" << json_string(animal.portrait_kind) << ","
             << "\"order\":" << animal.order << ","
             // B233-2: the assignment half (see UnitLaborAnimalRecord).
             << "\"ownerId\":" << animal.owner_id << ","
             << "\"ownerName\":" << json_string(animal.owner_name) << ","
             << "\"assignable\":" << (animal.assignable ? "true" : "false") << ","
             << "\"blockedReason\":" << json_string(animal.blocked_reason)
             << "}";
    }
    body << "]";
}

void append_unit_json(std::ostringstream& body, const UnitSheet& unit) {
    body << "{"
         << "\"id\":" << unit.id << ","
         << "\"portraitTexpos\":" << unit.portrait_texpos << ","
         << "\"sheetIconTexpos\":" << unit.sheet_icon_texpos << ","
         << "\"rt\":" << json_string(unit.race_token) << ","
         << "\"ct\":" << json_string(unit.caste_token) << ","
         << "\"ageClass\":" << json_string(unit.age_class) << ","
         << "\"portraitState\":" << json_string(unit.portrait_state) << ","
         << "\"portraitKind\":" << json_string(unit.portrait_kind) << ","
         << "\"name\":" << json_string(unit.name) << ","
         << "\"nickname\":" << json_string(unit.nickname) << ","
         << "\"race\":" << json_string(unit.race) << ","
         << "\"profession\":" << json_string(unit.profession) << ","
         << "\"professionColor\":" << static_cast<int>(unit.profession_color) << ","
         << "\"currentJob\":" << json_string(unit.current_job) << ","
         << "\"age\":" << json_string(unit.age) << ","
         << "\"sex\":" << json_string(unit.sex) << ","
         << "\"status\":" << json_string(unit.status) << ","
         << "\"training\":" << json_string(unit.training) << ","
         << "\"bodySummary\":" << json_string(unit.body_summary) << ","
         << "\"flags\":";
    append_lines(body, unit.flags);
    body << ",\"overviewRelationLines\":";
    append_lines(body, unit.overview_relation_lines);
    body << ",\"overviewTraitLines\":";
    append_lines(body, unit.overview_trait_lines);
    body << ",\"overviewPositionLines\":";
    append_lines(body, unit.overview_position_lines);
    body << ",\"overviewSquadLines\":";
    append_lines(body, unit.overview_squad_lines);
    body << ",\"overviewSkillLines\":";
    append_lines(body, unit.overview_skill_lines);
    body << ",\"overviewNeedLines\":";
    append_lines(body, unit.overview_need_lines);
    body << ",\"overviewMemoryLines\":";
    append_lines(body, unit.overview_memory_lines);
    body << ",\"statusLines\":";
    append_lines(body, unit.status_lines);
    body << ",\"inventoryLines\":";
    append_lines(body, unit.inventory_lines);
    body << ",\"healthLines\":";
    append_lines(body, unit.health_lines);
    body << ",\"healthStatusLines\":";
    append_lines(body, unit.health_status_lines);
    body << ",\"healthWoundLines\":";
    append_lines(body, unit.health_wound_lines);
    body << ",\"healthTreatmentLines\":";
    append_lines(body, unit.health_treatment_lines);
    body << ",\"healthHistoryLines\":";
    append_lines(body, unit.health_history_lines);
    body << ",\"healthDescriptionLines\":";
    append_lines(body, unit.health_description_lines);
    body << ",\"skillLines\":";
    append_lines(body, unit.skill_lines);
    body << ",\"roomLines\":";
    append_lines(body, unit.room_lines);
    body << ",\"roomAssignmentLines\":";
    append_lines(body, unit.room_assignment_lines);
    body << ",\"laborLines\":";
    append_lines(body, unit.labor_lines);
    body << ",\"laborWorkDetailLines\":";
    append_lines(body, unit.labor_work_detail_lines);
    body << ",\"laborWorkshopLines\":";
    append_lines(body, unit.labor_workshop_lines);
    body << ",\"laborLocationLines\":";
    append_lines(body, unit.labor_location_lines);
    body << ",\"laborWorkAnimalLines\":";
    append_lines(body, unit.labor_work_animal_lines);
    body << ",\"relationLines\":";
    append_lines(body, unit.relation_lines);
    body << ",\"groupLines\":";
    append_lines(body, unit.group_lines);
    body << ",\"militaryLines\":";
    append_lines(body, unit.military_lines);
    body << ",\"militarySquadLines\":";
    append_lines(body, unit.military_squad_lines);
    body << ",\"militaryUniformLines\":";
    append_lines(body, unit.military_uniform_lines);
    body << ",\"militaryKillLines\":";
    append_lines(body, unit.military_kill_lines);
    body << ",\"thoughtLines\":";
    append_lines(body, unit.thought_lines);
    body << ",\"personalityLines\":";
    append_lines(body, unit.personality_lines);
    body << ",\"personalityTraitLines\":";
    append_lines(body, unit.personality_trait_lines);
    body << ",\"personalityValueLines\":";
    append_lines(body, unit.personality_value_lines);
    body << ",\"personalityPreferenceLines\":";
    append_lines(body, unit.personality_preference_lines);
    body << ",\"personalityNeedLines\":";
    append_lines(body, unit.personality_need_lines);
    body << ",\"relations\":";
    append_relations(body, unit.relations);
    body << ",\"groups\":";
    append_groups(body, unit.groups);
    body << ",\"rooms\":";
    append_rooms(body, unit.rooms);
    body << ",\"inventory\":";
    append_inventory(body, unit.inventory);
    body << ",\"skills\":";
    append_skills(body, unit.skills);
    body << ",\"knowledge\":";
    append_knowledge(body, unit.knowledge);
    body << ",\"personalityNarrative\":{\"traits\":";
    append_text_paragraphs(body, unit.personality_traits);
    body << ",\"values\":";
    append_text_paragraphs(body, unit.personality_values);
    body << ",\"preferences\":";
    append_text_paragraphs(body, unit.personality_preferences);
    body << ",\"needs\":";
    append_text_paragraphs(body, unit.personality_needs);
    body << ",\"focusSummary\":" << json_string(unit.personality_focus_summary) << "}";
    body << ",\"needs\":";
    append_needs(body, unit.needs);
    body << ",\"thoughts\":{\"recent\":";
    append_thoughts(body, unit.recent_thoughts);
    body << ",\"memories\":";
    append_thoughts(body, unit.memories);
    body << "}";
    body << ",\"laborWorkAnimals\":";
    append_labor_animals(body, unit.labor_work_animals);
    body << ",\"actions\":[";
    for (size_t i = 0; i < unit.actions.size(); ++i) {
        if (i)
            body << ",";
        const auto& action = unit.actions[i];
        body << "{"
             << "\"hotkey\":" << json_string(action.hotkey) << ","
             << "\"label\":" << json_string(action.label) << ","
             << "\"value\":" << json_string(action.value) << ","
             << "\"available\":" << (action.available ? "true" : "false")
             << "}";
    }
    body << "]}";
}

struct RenderThreadUnitRequest {
    int32_t unit_id = -1;
    UnitSheet unit;
    Camera tile;
    std::string err;
    std::promise<bool> done;
};

} // namespace

void append_unit_sheet_json(std::ostringstream& body, const UnitSheet& unit) {
    append_unit_json(body, unit);
}

const char* yes_no(bool value) {
    return value ? "Yes" : "No";
}

std::string unit_age_label(df::unit* unit) {
    double age = Units::getAge(unit);
    if (age < 0)
        return "Age unknown";
    int years = static_cast<int>(age);
    return std::to_string(years) + (years == 1 ? " Year Old" : " Years Old");
}

std::string unit_age_class(df::unit* unit) {
    if (Units::isBaby(unit))
        return "baby";
    if (Units::isChild(unit))
        return "child";
    return "adult";
}

std::string unit_sex_label(df::unit* unit) {
    if (Units::isFemale(unit))
        return "female";
    if (Units::isMale(unit))
        return "male";
    return "unknown";
}

df::training_assignment* find_training_assignment(df::unit* unit) {
    auto plotinfo = df::global::plotinfo;
    if (!unit || !plotinfo)
        return nullptr;
    return binsearch_in_vector(plotinfo->training.training_assignments,
                               &df::training_assignment::animal_id, unit->id);
}

std::string unit_training_label(df::unit* unit) {
    if (Units::isWar(unit))
        return "War trained";
    if (Units::isHunter(unit))
        return "Hunting trained";
    if (Units::isTrained(unit))
        return "Trained";
    if (Units::isMarkedForWarTraining(unit))
        return "Marked for war training";
    if (Units::isMarkedForHuntTraining(unit))
        return "Marked for hunting training";
    if (Units::isMarkedForTaming(unit))
        return "Marked for taming";
    if (Units::isTame(unit))
        return "Tame";
    if (Units::isTamable(unit))
        return "Tamable";
    return "";
}

void push_if(std::vector<std::string>& lines, bool condition, const std::string& line) {
    if (condition)
        lines.push_back(line);
}

std::string capitalize_first(std::string text) {
    if (!text.empty())
        text[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(text[0])));
    return text;
}

std::string pretty_key(std::string key) {
    for (char& ch : key) {
        if (ch == '_')
            ch = ' ';
        else
            ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return capitalize_first(key);
}

std::string humanize_key(const std::string& key) {
    std::string text;
    for (size_t i = 0; i < key.size(); ++i) {
        unsigned char ch = static_cast<unsigned char>(key[i]);
        if (ch == '_') {
            text.push_back(' ');
        } else {
            if (i && std::isupper(ch) && std::islower(static_cast<unsigned char>(key[i - 1])))
                text.push_back(' ');
            text.push_back(static_cast<char>(std::tolower(ch)));
        }
    }
    return capitalize_first(text);
}

std::string lower_first(std::string text) {
    if (!text.empty())
        text[0] = static_cast<char>(std::tolower(static_cast<unsigned char>(text[0])));
    return text;
}

std::string pronoun_subject(df::unit* unit) {
    if (Units::isFemale(unit))
        return "She";
    if (Units::isMale(unit))
        return "He";
    return "It";
}

std::string pronoun_subject_lower(df::unit* unit) {
    auto text = pronoun_subject(unit);
    text[0] = static_cast<char>(std::tolower(static_cast<unsigned char>(text[0])));
    return text;
}

std::string pronoun_object(df::unit* unit) {
    if (Units::isFemale(unit))
        return "her";
    if (Units::isMale(unit))
        return "him";
    return "it";
}

std::string pronoun_possessive(df::unit* unit) {
    if (Units::isFemale(unit))
        return "her";
    if (Units::isMale(unit))
        return "his";
    return "its";
}

std::string join_phrases(const std::vector<std::string>& phrases) {
    if (phrases.empty())
        return "";
    if (phrases.size() == 1)
        return phrases[0];
    std::string out;
    for (size_t i = 0; i < phrases.size(); ++i) {
        if (i)
            out += (i + 1 == phrases.size()) ? " and " : ", ";
        out += phrases[i];
    }
    return out;
}

int physical_attr_value(df::unit* unit, df::physical_attribute_type attr) {
    return Units::getPhysicalAttrValue(unit, attr);
}

int physical_attr_low_threshold(df::unit* unit, df::physical_attribute_type attr) {
    if (auto caste = Units::getCasteRaw(unit))
        return caste->attributes.phys_att_range[attr][1];
    return 700;
}

int physical_attr_high_threshold(df::unit* unit, df::physical_attribute_type attr) {
    if (auto caste = Units::getCasteRaw(unit))
        return caste->attributes.phys_att_range[attr][5];
    return 1300;
}

int physical_attr_very_low_threshold(df::unit* unit, df::physical_attribute_type attr) {
    if (auto caste = Units::getCasteRaw(unit))
        return caste->attributes.phys_att_range[attr][0];
    return 450;
}

int mental_attr_value(df::unit* unit, df::mental_attribute_type attr) {
    return Units::getMentalAttrValue(unit, attr);
}

int mental_attr_low_threshold(df::unit* unit, df::mental_attribute_type attr) {
    if (auto caste = Units::getCasteRaw(unit))
        return caste->attributes.ment_att_range[attr][1];
    return 700;
}

int mental_attr_high_threshold(df::unit* unit, df::mental_attribute_type attr) {
    if (auto caste = Units::getCasteRaw(unit))
        return caste->attributes.ment_att_range[attr][5];
    return 1300;
}

bool trait_high(df::unit* unit, df::personality_facet_type facet) {
    auto soul = unit->status.current_soul;
    return soul && soul->personality.traits[facet] >= 76;
}

bool trait_low(df::unit* unit, df::personality_facet_type facet) {
    auto soul = unit->status.current_soul;
    return soul && soul->personality.traits[facet] <= 24;
}

std::string physical_description_sentence(df::unit* unit) {
    using df::enums::physical_attribute_type::AGILITY;
    using df::enums::physical_attribute_type::DISEASE_RESISTANCE;
    using df::enums::physical_attribute_type::ENDURANCE;
    using df::enums::physical_attribute_type::RECUPERATION;
    using df::enums::physical_attribute_type::STRENGTH;
    using df::enums::physical_attribute_type::TOUGHNESS;

    std::vector<std::string> positives;
    std::vector<std::string> negatives;
    auto add_physical = [&](df::physical_attribute_type attr, const char* high, const char* low, const char* very_low = nullptr) {
        int value = physical_attr_value(unit, attr);
        if (value >= physical_attr_high_threshold(unit, attr)) {
            positives.push_back(high);
        } else if (value < physical_attr_low_threshold(unit, attr)) {
            negatives.push_back(value <= physical_attr_very_low_threshold(unit, attr) && very_low ? very_low : low);
        }
    };

    add_physical(AGILITY, "agile", "clumsy");
    add_physical(STRENGTH, "strong", "weak", "very weak");
    add_physical(TOUGHNESS, "tough", "fragile");
    add_physical(ENDURANCE, "slow to tire", "quick to tire", "very quick to tire");
    add_physical(RECUPERATION, "quick to heal", "slow to heal");
    add_physical(DISEASE_RESISTANCE, "resistant to disease", "susceptible to disease");

    if (positives.empty() && negatives.empty())
        return "";

    std::string sentence = pronoun_subject(unit) + " is ";
    if (!positives.empty())
        sentence += join_phrases(positives);
    if (!positives.empty() && !negatives.empty())
        sentence += ", but " + pronoun_subject(unit);
    if (!negatives.empty()) {
        if (!positives.empty())
            sentence += " is ";
        sentence += join_phrases(negatives);
    }
    sentence += ".";
    return sentence;
}

std::vector<std::string> unit_condition_lines(df::unit* unit) {
    std::vector<std::string> lines;
    if (!Units::isAlive(unit))
        lines.push_back("Dead");
    if (!Units::isSane(unit))
        lines.push_back("Not sane");
    push_if(lines, unit->counters.unconscious > 0, "Unconscious");
    push_if(lines, unit->counters.stunned > 0, "Stunned");
    push_if(lines, unit->counters.winded > 0, "Winded");
    push_if(lines, unit->counters.pain > 0, "In pain");
    push_if(lines, unit->counters.nausea > 0, "Nauseated");
    push_if(lines, unit->counters.dizziness > 0, "Dizzy");
    push_if(lines, unit->counters2.paralysis > 0, "Paralyzed");
    push_if(lines, unit->counters2.numbness > 0, "Numb");
    push_if(lines, unit->counters2.fever > 0, "Fevered");
    push_if(lines, unit->counters2.exhaustion > 0, "Exhausted");

    auto strength = df::enums::physical_attribute_type::STRENGTH;
    auto agility = df::enums::physical_attribute_type::AGILITY;
    auto toughness = df::enums::physical_attribute_type::TOUGHNESS;
    auto endurance = df::enums::physical_attribute_type::ENDURANCE;
    auto recuperation = df::enums::physical_attribute_type::RECUPERATION;
    auto disease_resistance = df::enums::physical_attribute_type::DISEASE_RESISTANCE;
    push_if(lines, physical_attr_value(unit, endurance) < physical_attr_low_threshold(unit, endurance),
            "Low stamina");
    push_if(lines, physical_attr_value(unit, strength) < physical_attr_low_threshold(unit, strength),
            "Weak");
    push_if(lines, physical_attr_value(unit, agility) < physical_attr_low_threshold(unit, agility),
            "Clumsy");
    push_if(lines, physical_attr_value(unit, toughness) < physical_attr_low_threshold(unit, toughness),
            "Fragile");
    push_if(lines, physical_attr_value(unit, recuperation) < physical_attr_low_threshold(unit, recuperation),
            "Recovers slowly");
    push_if(lines, physical_attr_value(unit, disease_resistance) < physical_attr_low_threshold(unit, disease_resistance),
            "Disease-prone");
    if (!unit->body.wounds.empty())
        lines.push_back("Injured");
    if (unit->effective_rate > 100)
        lines.push_back("Recovers quickly");
    if (lines.empty())
        lines.push_back("Healthy");
    return lines;
}

std::string related_unit_label(int32_t id) {
    if (id == -1)
        return "None";
    if (auto unit = df::unit::find(id)) {
        auto name = Units::getReadableName(unit);
        return name.empty() ? ("Unit " + std::to_string(id)) : name;
    }
    return "Unit " + std::to_string(id);
}

std::vector<std::string> unit_inventory_lines(df::unit* unit) {
    std::vector<std::string> lines;
    for (auto inv : unit->inventory) {
        if (!inv || !inv->item)
            continue;
        std::string desc = item_display_name(inv->item, 0, true);
        if (!desc.empty())
            lines.push_back(pretty_key(DFHack::enum_item_key(inv->mode)) + ": " + desc);
        if (lines.size() >= 32)
            break;
    }
    if (lines.empty())
        lines.push_back("No inventory items.");
    return lines;
}

std::vector<std::string> unit_health_lines(df::unit* unit, const std::vector<std::string>& conditions) {
    std::vector<std::string> lines;
    // Native Status does not synthesize physical-attribute descriptors. Keep actual conditions,
    // but route the low/high attribute prose to Overview/Description instead of this tab.
    static const std::vector<std::string> attribute_rows = {
        "Low stamina", "Weak", "Clumsy", "Fragile", "Recovers slowly",
        "Disease-prone", "Recovers quickly"
    };
    std::vector<std::string> actual_conditions;
    for (const auto& condition : conditions) {
        if (condition != "Healthy" && condition != "Injured" &&
                std::find(attribute_rows.begin(), attribute_rows.end(), condition) == attribute_rows.end())
            actual_conditions.push_back(condition);
    }
    if (unit->body.wounds.empty() && actual_conditions.empty())
        return {"No health problems"};
    if (!unit->body.wounds.empty())
        lines.push_back(std::to_string(unit->body.wounds.size()) +
                        (unit->body.wounds.size() == 1 ? " wound" : " wounds"));
    lines.insert(lines.end(), actual_conditions.begin(), actual_conditions.end());
    if (!unit->body.wounds.empty())
        lines.push_back("Detailed wound breakdown is not wired yet.");
    return lines;
}

std::vector<std::string> unit_health_description_lines(df::unit* unit) {
    std::vector<std::string> lines;
    if (auto caste = Units::getCasteRaw(unit)) {
        if (!caste->description.empty())
            lines.push_back(caste->description);
    }
    auto attrs = physical_description_sentence(unit);
    if (!attrs.empty())
        lines.push_back(attrs);
    if (lines.empty())
        lines.push_back("No description available.");
    return lines;
}

std::string body_part_name(df::unit* unit, int16_t body_part_id) {
    auto plan = unit->body.body_plan;
    if (plan && body_part_id >= 0 &&
            body_part_id < static_cast<int>(plan->body_parts.size())) {
        auto part = plan->body_parts[body_part_id];
        if (part && !part->name_singular.empty() && part->name_singular[0] &&
                !part->name_singular[0]->empty())
            return *part->name_singular[0];
    }
    return "body part " + std::to_string(body_part_id);
}

std::vector<UnitInventoryRecord> unit_inventory(df::unit* unit) {
    std::vector<UnitInventoryRecord> records;
    // df.unit.xml:1292-1303: inventory order is authoritative and each entry carries its
    // inv_item_role_type plus a body_part_id into unit.body.body_plan.body_parts.
    for (auto inv : unit->inventory) {
        if (!inv || !inv->item)
            continue;
        UnitInventoryRecord record;
        record.item_id = inv->item->id;
        record.role = pretty_key(DFHack::enum_item_key(inv->mode));
        record.body_part_id = inv->body_part_id;
        if (inv->body_part_id >= 0)
            record.body_part_name = capitalize_first(body_part_name(unit, inv->body_part_id));
        else
            record.body_part_name = record.role;
        record.name = item_display_name(inv->item, 0, true);
        if (record.name.empty())
            continue;
        record.quality = inv->item->getQuality();
        record.wear = inv->item->getWear();
        record.color_role = record.wear > 0 ? "worn" :
            (record.quality >= 5 ? "masterwork" :
             (record.quality >= 2 ? "quality" : "item"));
        records.push_back(std::move(record));
    }
    // Native's Items view also exposes the item attached to the unit's active hauling job.
    // It is not guaranteed to have reached unit->inventory yet (notably while gathering a
    // plant growth), so project current-job item refs here. This endpoint is on demand and
    // the current job has only a small, bounded item list.
    if (unit->job.current_job) {
        for (auto ref : unit->job.current_job->items) {
            auto item = ref ? ref->item : nullptr;
            if (!item || std::any_of(records.begin(), records.end(), [&](const auto& record) {
                    return record.item_id == item->id;
                }))
                continue;
            UnitInventoryRecord record;
            record.item_id = item->id;
            record.role = "Hauled";
            record.body_part_name = "Hauled";
            record.name = item_display_name(item, 0, true);
            if (record.name.empty())
                continue;
            record.quality = item->getQuality();
            record.wear = item->getWear();
            record.color_role = record.wear > 0 ? "worn" :
                (record.quality >= 5 ? "masterwork" :
                 (record.quality >= 2 ? "quality" : "item"));
            records.push_back(std::move(record));
        }
    }
    return records;
}

std::vector<std::string> unit_health_wound_lines(df::unit* unit) {
    std::vector<std::string> lines;
    for (auto wound : unit->body.wounds) {
        if (!wound)
            continue;
        for (auto part : wound->parts) {
            if (!part)
                continue;
            std::string line = capitalize_first(body_part_name(unit, part->body_part_id));
            std::vector<std::string> effects;
            for (auto effect : part->effect_type)
                effects.push_back(pretty_key(DFHack::enum_item_key(effect)));
            if (!effects.empty())
                line += ": " + join_phrases(effects);
            if (part->bleeding > 0)
                line += " (bleeding)";
            if (part->pain > 0)
                line += " (pain " + std::to_string(part->pain) + ")";
            lines.push_back(line);
            if (lines.size() >= 24)
                return lines;
        }
        if (wound->flags.bits.infection)
            lines.push_back("An infection is present.");
    }
    if (lines.empty())
        lines.push_back("No evaluated wounds"); // native-parity display string
    return lines;
}

std::vector<std::string> unit_health_treatment_lines(df::unit* unit) {
    std::vector<std::string> lines;
    if (auto health = unit->health) {
        const auto& bits = health->flags.bits;
        push_if(lines, bits.rq_diagnosis, "Needs diagnosis");
        push_if(lines, bits.rq_immobilize, "Needs immobilization");
        push_if(lines, bits.rq_dressing, "Needs dressing");
        push_if(lines, bits.rq_cleaning, "Needs cleaning");
        push_if(lines, bits.rq_surgery, "Needs surgery");
        push_if(lines, bits.rq_suture, "Needs suturing");
        push_if(lines, bits.rq_setting, "Needs a bone set");
        push_if(lines, bits.rq_traction, "Needs traction");
        push_if(lines, bits.rq_crutch, "Needs a crutch");
        push_if(lines, bits.needs_healthcare, "Under hospital care");
    }
    if (lines.empty())
        lines.push_back("No treatment scheduled"); // native-parity display string
    return lines;
}

std::vector<std::string> unit_health_history_lines(df::unit* unit) {
    std::vector<std::string> lines;
    if (unit->body.wounds.empty()) {
        lines.push_back("No medical history"); // native-parity display string
        return lines;
    }
    int32_t oldest = 0;
    for (auto wound : unit->body.wounds)
        if (wound && wound->age > oldest)
            oldest = wound->age;
    lines.push_back(std::to_string(unit->body.wounds.size()) +
                    (unit->body.wounds.size() == 1 ? " active wound" : " active wounds") +
                    ", oldest " + std::to_string(oldest) + " ticks old.");
    lines.push_back("Full medical history beyond active wounds is out of scope.");
    return lines;
}

std::vector<std::string> unit_skill_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto soul = unit->status.current_soul;
    if (soul) {
        std::vector<std::pair<int, std::string>> ranked;
        for (auto skill : soul->skills) {
            if (!skill || skill->rating < df::skill_rating::Dabbling)
                continue;
            auto skill_name = df::enum_traits<df::job_skill>::attrs(skill->id).caption;
            auto rating_name = df::enum_traits<df::skill_rating>::attrs(skill->rating).caption;
            if (skill_name && rating_name) {
                int xp = skill->experience;
                int xp_needed = 500 + 100 * static_cast<int>(skill->rating); // DF per-level cost
                ranked.emplace_back(static_cast<int>(skill->rating),
                                    std::string(rating_name) + " " + skill_name +
                                    " (Lv " + std::to_string(static_cast<int>(skill->rating)) +
                                    ", " + std::to_string(xp) + "/" + std::to_string(xp_needed) + " xp)");
            }
        }
        std::sort(ranked.begin(), ranked.end(),
                  [](const auto& a, const auto& b) { return a.first > b.first; });
        for (const auto& entry : ranked) {
            lines.push_back(entry.second);
            if (lines.size() >= 40)
                break;
        }
    }
    if (lines.empty())
        lines.push_back("No notable skills.");
    return lines;
}

std::string native_skill_category(const df::enum_traits<df::job_skill>::attr_entry_type& attrs) {
    using namespace df::enums::job_skill_class;
    switch (attrs.type) {
    case Social:
        return "Social";
    case MilitaryWeapon:
    case MilitaryUnarmed:
    case MilitaryAttack:
    case MilitaryDefense:
    case MilitaryMisc:
        return "Combat";
    default:
        return attrs.labor != df::unit_labor::NONE ? "Labor" : "Other skills";
    }
}

std::vector<UnitSkillRecord> unit_skill_records(df::unit* unit) {
    std::vector<UnitSkillRecord> records;
    auto soul = unit->status.current_soul;
    if (!soul)
        return records;
    for (auto skill : soul->skills) {
        if (!skill || skill->rating < df::skill_rating::Dabbling ||
            !df::enum_traits<df::job_skill>::is_valid(static_cast<int16_t>(skill->id)))
            continue;
        const auto& attrs = df::enum_traits<df::job_skill>::attrs(skill->id);
        const auto& rating_attrs = df::enum_traits<df::skill_rating>::attrs(skill->rating);
        const char* caption = attrs.caption_noun ? attrs.caption_noun : attrs.caption;
        if (!caption || !rating_attrs.caption)
            continue;
        UnitSkillRecord record;
        record.id = static_cast<int16_t>(skill->id);
        record.category = native_skill_category(attrs);
        record.caption = caption;
        record.rating_caption = rating_attrs.caption;
        record.rating = static_cast<int32_t>(skill->rating);
        record.effective_rating = std::max(0, record.rating - skill->rusty);
        record.rusty = skill->rusty > 0;
        record.experience = skill->experience;
        record.xp_threshold = rating_attrs.xp_threshold;
        // Native skill-row color = the SKILL's profession color (text-color spec §2.5, live-
        // verified: "Competent Miner" 7 == MINER, "Adequate Bone Carver" 9 == BONE_CARVER, same
        // level word / different color -- disproving any level-keyed rule). Chain:
        // profession.color[ job_skill.profession[ skill ] ]. profession `color` defaults to -1
        // (df.d_basics.xml:5039) which we pass through as "no native color".
        {
            df::profession prof = attrs.profession;
            if (df::enum_traits<df::profession>::is_valid(static_cast<int16_t>(prof)))
                record.native_color =
                    static_cast<int>(df::enum_traits<df::profession>::attrs(prof).color);
        }
        record.color_role = "neutral";
        if (record.category == "Labor") {
            if (skill->id == df::job_skill::PROCESSFISH)
                record.color_role = "accent";
            else if (record.rating >= static_cast<int32_t>(df::skill_rating::Adequate))
                record.color_role = "attention";
            else
                record.color_role = "warning";
        } else if (record.category == "Combat" &&
                   attrs.type == df::job_skill_class::MilitaryWeapon) {
            record.color_role = "accent";
        }
        records.push_back(std::move(record));
    }
    std::sort(records.begin(), records.end(), [](const auto& a, const auto& b) {
        if (a.category != b.category)
            return a.category < b.category;
        if (a.rating != b.rating)
            return a.rating > b.rating;
        return a.id < b.id;
    });
    for (size_t i = 0; i < records.size(); ++i)
        records[i].order = static_cast<int32_t>(i);
    return records;
}

std::string knowledge_form_name(const df::language_name& name, const char* fallback, int32_t id) {
    auto title = Translation::translateName(&name, true);
    if (!title.empty())
        return title;
    return std::string(fallback) + " " + std::to_string(id);
}

void add_knowledge_record(std::vector<UnitKnowledgeRecord>& records, const std::string& type,
                          int32_t id, const std::string& title, const std::string& subtype,
                          const std::string& color_role) {
    if (title.empty())
        return;
    auto duplicate = std::find_if(records.begin(), records.end(), [&](const auto& record) {
        return record.type == type && record.id == id;
    });
    if (duplicate != records.end())
        return;
    UnitKnowledgeRecord record;
    record.type = type;
    record.id = id;
    record.title = title;
    record.subtype = subtype;
    record.color_role = color_role;
    record.detail_target = type + ":" + std::to_string(id);
    record.order = static_cast<int32_t>(records.size());
    records.push_back(std::move(record));
}

std::vector<UnitKnowledgeRecord> unit_knowledge_records(df::unit* unit) {
    std::vector<UnitKnowledgeRecord> records;
    auto hf = df::historical_figure::find(unit->hist_figure_id);
    auto known = hf && hf->info ? hf->info->known_info : nullptr;
    if (!known)
        return records;
    for (auto id : known->known_poetic_forms) {
        if (auto form = df::poetic_form::find(id))
            add_knowledge_record(records, "poetic-form", id,
                knowledge_form_name(form->name, "Poetic form", id), "Poetic form", "form");
    }
    for (auto id : known->known_musical_forms) {
        if (auto form = df::musical_form::find(id))
            add_knowledge_record(records, "musical-form", id,
                knowledge_form_name(form->name, "Musical form", id), "Musical form", "form");
    }
    for (auto id : known->known_dance_forms) {
        if (auto form = df::dance_form::find(id))
            add_knowledge_record(records, "dance-form", id,
                knowledge_form_name(form->name, "Dance form", id), "Dance form", "form");
    }
    for (auto id : known->known_written_contents) {
        auto content = df::written_content::find(id);
        if (!content)
            continue;
        auto subtype = humanize_key(DFHack::enum_item_key(content->type));
        add_knowledge_record(records, "written-content", id, content->title,
                             subtype, content->type == df::written_content_type::Poem ? "work" : "form");
    }
    return records;
}

std::vector<std::string> unit_room_lines(df::unit* unit) {
    std::vector<std::string> lines;
    for (auto building : unit->owned_buildings) {
        if (!building)
            continue;
        std::string name = Buildings::getName(static_cast<df::building*>(building));
        if (name.empty())
            name = "Building " + std::to_string(building->id);
        lines.push_back(name);
        if (lines.size() >= 12)
            break;
    }
    if (lines.empty()) {
        lines.push_back("No Study");
        lines.push_back("No Quarters");
        lines.push_back("No Dining Room");
        lines.push_back("No Tomb");
    }
    return lines;
}

int room_category_index(df::civzone_type type) {
    using namespace df::enums::civzone_type;
    switch (type) {
        case Office: return 0;
        case Bedroom: return 1;
        case DiningHall: return 2;
        case Tomb: return 3;
        default: return -1;
    }
}

std::string room_quality_label(df::building_civzonest* zone, df::unit* unit, int category) {
    // Buildings.cpp:1552-1576 is the canonical helper. In DFHack 53.15-r1 its v50 body is
    // intentionally stubbed, so fall back to building::getPersonalValue(), the v50 virtual that
    // replaced getRoomValue(), and the same dfhack_room_quality_level thresholds/labels.
    std::string description = Buildings::getRoomDescription(static_cast<df::building*>(zone), unit);
    if (!description.empty())
        return description;

    auto level = df::dfhack_room_quality_level::Meager;
    int32_t value = zone->getPersonalValue(unit);
    for (int i = df::enum_traits<df::dfhack_room_quality_level>::first_item_value;
         i <= df::enum_traits<df::dfhack_room_quality_level>::last_item_value; ++i) {
        auto candidate = static_cast<df::dfhack_room_quality_level>(i);
        if (value >= df::enum_traits<df::dfhack_room_quality_level>::attrs(candidate).min_value)
            level = candidate;
    }
    const auto& attrs = df::enum_traits<df::dfhack_room_quality_level>::attrs(level);
    const char* label = category == 0 ? attrs.office :
        (category == 1 ? attrs.bedroom : (category == 2 ? attrs.dining_room : attrs.burial));
    return label ? label : "";
}

std::vector<UnitRoom> unit_rooms(df::unit* unit) {
    std::vector<UnitRoom> rooms = {
        {"Study", false, -1, "", ""},
        {"Quarters", false, -1, "", ""},
        {"Dining Room", false, -1, "", ""},
        {"Tomb", false, -1, "", ""}
    };
    // df.unit.xml:2757 and df.building.xml:1059-1083: owned_buildings are civzones whose
    // civzone_type identifies the native Office/Bedroom/DiningHall/Tomb profile slots.
    for (auto zone : unit->owned_buildings) {
        if (!zone)
            continue;
        int category = room_category_index(zone->type);
        if (category < 0 || rooms[category].assigned)
            continue;
        auto& room = rooms[category];
        room.assigned = true;
        room.building_id = zone->id;
        room.name = Buildings::getName(static_cast<df::building*>(zone));
        room.quality = room_quality_label(zone, unit, category);
        // B176: bounding-box midpoint of the civzone -- always valid (unlike a possibly-zero
        // centerx on some zones), and close enough for the client's zoom-to-room camera jump.
        room.center_x = (zone->x1 + zone->x2) / 2;
        room.center_y = (zone->y1 + zone->y2) / 2;
        room.center_z = zone->z;
    }
    return rooms;
}

std::vector<std::string> unit_labor_work_detail_lines(df::unit* unit) {
    if (!Units::isCitizen(unit))
        return {"Cannot assign work details"};
    return {"No work details assigned."};
}

std::vector<std::string> unit_labor_workshop_lines(df::unit*) {
    return {"No dedicated workshop assignments"}; // native-parity display string
}

std::vector<std::string> unit_labor_location_lines(df::unit*) {
    return {"No location assignments"}; // native-parity display string
}

// B233-2: WORK ANIMALS (Labor > Work animals), rebuilt on DF's real work-animal field.
//
// The previous implementation listed plotinfo.training.training_assignments -- that is the ANIMAL
// TRAINING assignment ("who TRAINS this creature", INFO_ASSIGN_TRAINER), a different DF concept
// from a WORK ANIMAL ("assign this creature as a work animal for a specific citizen",
// INFO_ASSIGN_WORK_ANIMAL, df.d_interface.xml:3742). DF stores the latter on the ANIMAL as
//   unit.relationship_ids[unit_relationship_type::PetOwner]   (df.unit.xml:1574 + :2732)
// which is exactly what DFHack's own AssignWorkAnimal overlay counts per citizen
// (dfhack plugins/lua/sort/info.lua:452-460) and what Units::isPet() reads. So the tab now shows,
// for THIS citizen: the animals it already owns as work animals, plus the unowned war/hunting
// animals of the fort it COULD be given (the same eligibility DF's own screen lists).
//
// B214: world.units.active retains corpses and real ghosts -- every list here is filtered by the
// living predicate, so a dead war dog can never appear as assignable.
std::vector<UnitLaborAnimalRecord> unit_labor_work_animals(df::unit* owner) {
    std::vector<UnitLaborAnimalRecord> records;
    auto world = df::global::world;
    if (!world || !owner)
        return records;
    const bool owner_is_citizen = Units::isCitizen(owner, true) && Units::isActive(owner) &&
                                  !Units::isDead(owner) && !Units::isGhost(owner);
    for (auto animal : world->units.active) {
        if (!animal || !Units::isAnimal(animal) || !Units::isActive(animal) || Units::isDead(animal))
            continue;
        const int32_t animal_owner =
            animal->relationship_ids[df::enums::unit_relationship_type::PetOwner];
        const bool assigned = (animal_owner == owner->id);
        // Eligible-for-this-citizen == DF's AssignWorkAnimal list: a tame war/hunting animal of our
        // own civ that nobody owns yet. work_animal_blocked_reason() is the SINGLE gate shared with
        // the write (info_panel.cpp), so the UI can never offer a row the write would refuse -- an
        // animal that LOOKS eligible but the write refuses (the histfig case) is still listed, with
        // assignable=false and the reason, instead of vanishing with no explanation.
        const bool candidate = animal_owner == -1 && owner_is_citizen &&
                               Units::isOwnCiv(animal) && Units::isTame(animal) &&
                               (Units::isWar(animal) || Units::isHunter(animal));
        if (!assigned && !candidate)
            continue;
        const std::string blocked = work_animal_blocked_reason(animal);
        const bool offerable = candidate && blocked.empty();

        UnitLaborAnimalRecord record;
        record.unit_id = animal->id;
        record.name = Translation::translateName(Units::getVisibleName(animal), true);
        record.portrait_texpos = animal->portrait_texpos;
        record.sheet_icon_texpos = animal->sheet_icon_texpos;
        record.age_class = unit_age_class(animal);
        record.portrait_state = animal->portrait_texpos > 0 ? "ready" :
            (animal->portrait_texpos == 0 ? "pending" : "unavailable");
        record.portrait_kind = animal->portrait_texpos >= 0 ? "native" : "none";
        if (animal->race >= 0 && static_cast<size_t>(animal->race) < world->raws.creatures.all.size()) {
            if (auto creature = world->raws.creatures.all[animal->race]) {
                record.race_token = creature->creature_id;
                if (record.name.empty())
                    record.name = creature->name[0];
                if (animal->caste >= 0 && static_cast<size_t>(animal->caste) < creature->caste.size())
                    if (auto caste = creature->caste[animal->caste])
                        record.caste_token = caste->caste_id;
            }
        }
        if (Units::isWar(animal))
            record.training_type = "War training";
        else if (Units::isHunter(animal))
            record.training_type = "Hunting training";
        else
            record.training_type = "Animal training";
        record.owner_id = animal_owner;
        record.owner_name.clear();
        if (animal_owner >= 0) {
            if (auto owner_unit = df::unit::find(animal_owner))
                record.owner_name = Units::getReadableName(owner_unit);
        }
        record.assignment_state = assigned ? "assigned" : "assignable";
        // `assignable` == "the assign/unassign button may be shown". It tracks the WRITE gate
        // exactly: an already-assigned animal is unassignable-able (the write clears PetOwner) only
        // when the write would accept it, so a blocked (histfig) animal shows its reason in both
        // directions rather than a button that 400s.
        record.assignable = (assigned || offerable) && blocked.empty();
        record.blocked_reason = record.assignable ? "" : blocked;
        record.eligibility_reason = assigned
            ? "Assigned to this citizen"
            : (Units::isWar(animal) ? "War-trained, unassigned" : "Hunt-trained, unassigned");
        records.push_back(std::move(record));
    }
    std::sort(records.begin(), records.end(), [](const auto& a, const auto& b) {
        if (a.assignment_state != b.assignment_state)
            return a.assignment_state == "assigned";
        return a.name < b.name;
    });
    for (size_t i = 0; i < records.size(); ++i)
        records[i].order = static_cast<int32_t>(i);
    return records;
}

std::vector<std::string> unit_labor_work_animal_lines(
        const std::vector<UnitLaborAnimalRecord>& animals) {
    std::vector<std::string> lines;
    for (const auto& animal : animals)
        lines.push_back(animal.name + " — " + animal.training_type +
                        (animal.assignment_state == "assigned" ? " (assigned)" : ""));
    if (lines.empty())
        lines.push_back("No assigned or assignable work animals"); // native-parity display string
    return lines;
}

std::vector<std::string> unit_labor_lines(df::unit* unit) {
    std::vector<std::string> lines;
    for (int i = 0; i <= df::enum_traits<df::unit_labor>::last_item_value; ++i) {
        auto labor = static_cast<df::unit_labor>(i);
        if (!df::enum_traits<df::unit_labor>::is_valid(i) || !unit->status.labors[i])
            continue;
        auto caption = df::enum_traits<df::unit_labor>::attrs(labor).caption;
        if (caption)
            lines.push_back(std::string(caption));
        if (lines.size() >= 16)
            break;
    }
    if (lines.empty())
        lines.push_back("No labors enabled.");
    return lines;
}

std::vector<std::string> unit_relation_lines(df::unit* unit) {
    std::vector<std::string> lines;
    // relationship_ids contains only the simple slots [0, NUM). The enum continues with social
    // relationship labels stored elsewhere, so iterating the full enum reads past this array.
    const size_t relation_count = std::min(
        std::size(unit->relationship_ids),
        static_cast<size_t>(df::unit_relationship_type::NUM));
    for (size_t i = 0; i < relation_count; ++i) {
        if (!df::enum_traits<df::unit_relationship_type>::is_valid(i))
            continue;
        int32_t other = unit->relationship_ids[i];
        if (other == -1)
            continue;
        auto rel = static_cast<df::unit_relationship_type>(i);
        lines.push_back(pretty_key(DFHack::enum_item_key(rel)) + ": " + related_unit_label(other));
    }
    if (lines.empty())
        lines.push_back("No relationships recorded.");
    return lines;
}

std::vector<std::string> unit_group_lines(df::unit* unit) {
    std::vector<std::string> lines;
    lines.push_back("Civilization id: " + std::to_string(unit->civ_id));
    lines.push_back("Population id: " + std::to_string(unit->population_id));
    lines.push_back(std::string("Own group: ") + yes_no(Units::isOwnGroup(unit)));
    lines.push_back(std::string("Fort controlled: ") + yes_no(Units::isFortControlled(unit)));
    lines.push_back(std::string("Citizen: ") + yes_no(Units::isCitizen(unit)));
    return lines;
}

void fill_relation_portrait(UnitRelation& relation, df::historical_figure* hf, df::unit* live) {
    int race = live ? live->race : (hf ? hf->race : -1);
    int caste_id = live ? live->caste : (hf ? hf->caste : -1);
    if (auto world = df::global::world) {
        if (race >= 0 && static_cast<size_t>(race) < world->raws.creatures.all.size()) {
            if (auto creature = world->raws.creatures.all[race]) {
                relation.race_token = creature->creature_id;
                if (caste_id >= 0 && static_cast<size_t>(caste_id) < creature->caste.size()) {
                    if (auto caste = creature->caste[caste_id])
                        relation.caste_token = caste->caste_id;
                }
            }
        }
    }
    if (!live)
        return;
    relation.portrait_texpos = live->portrait_texpos;
    relation.sheet_icon_texpos = live->sheet_icon_texpos;
    relation.age_class = unit_age_class(live);
    relation.portrait_state = live->portrait_texpos > 0 ? "ready" :
        (live->portrait_texpos == 0 ? "pending" : "unavailable");
    relation.portrait_kind = live->portrait_texpos >= 0 ? "native" : "none";
}

std::string family_relation_label(df::histfig_hf_link_type type, df::historical_figure* target) {
    using namespace df::enums::histfig_hf_link_type;
    switch (type) {
        case SPOUSE:
            if (target && target->sex == df::pronoun_type::she) return "Wife";
            if (target && target->sex == df::pronoun_type::he) return "Husband";
            return "Spouse";
        case CHILD:
            if (target && target->sex == df::pronoun_type::she) return "Daughter";
            if (target && target->sex == df::pronoun_type::he) return "Son";
            return "Child";
        case MOTHER: return "Mother";
        case FATHER: return "Father";
        case DEITY: return "Deity";
        case LOVER: return "Lover";
        case PET_OWNER: return "Owner";
        default: return "";
    }
}

int family_relation_order(df::histfig_hf_link_type type) {
    using namespace df::enums::histfig_hf_link_type;
    switch (type) {
        case SPOUSE: return 1000;
        case LOVER: return 1100;
        case CHILD: return 2000;
        case MOTHER: return 2200;
        case FATHER: return 2210;
        case PET_OWNER: return 2300;
        case DEITY: return 3000;
        default: return 9000;
    }
}

bool same_relation_target(const UnitRelation& a, const UnitRelation& b) {
    if (a.hf_id >= 0 && b.hf_id >= 0)
        return a.hf_id == b.hf_id;
    return a.unit_id >= 0 && b.unit_id >= 0 && a.unit_id == b.unit_id;
}

UnitRelation relation_for_hf(df::historical_figure* hf, const std::string& label,
                             const std::string& color_role, int order) {
    UnitRelation relation;
    if (!hf)
        return relation;
    relation.hf_id = hf->id;
    relation.name = Translation::translateName(&hf->name, true);
    relation.profession = Units::getProfessionName(hf);
    relation.label = label;
    relation.color_role = color_role;
    relation.order = order;
    auto live = df::unit::find(hf->unit_id);
    if (live && Units::isAlive(live) && Units::isActive(live))
        relation.unit_id = live->id;
    else
        live = nullptr;
    // W4: DF's own profession colour. `Units::getCasteProfessionColor(race, caste, profession)`
    // (modules/Units.h:335) is the exact function DF's own profession-coloured name lines use, and
    // the historical figure carries all three inputs (df/historical_figure.h: profession, race,
    // caste), so it works for the dead and the off-site alike -- not just for loaded units.
    // DEATH: `historical_figure::died_year` is -1 while alive (df/historical_figure.h:42). That is
    // the authoritative flag; a missing live unit only means "not on this map right now".
    relation.profession_color =
        Units::getCasteProfessionColor(hf->race, hf->caste, hf->profession);
    relation.dead = hf->died_year != -1;
    fill_relation_portrait(relation, hf, live);
    return relation;
}

std::vector<UnitRelation> unit_relations(df::unit* unit) {
    std::vector<UnitRelation> relations;
    auto add = [&](UnitRelation relation) {
        // Native never substitutes numeric ids for an unresolved name.
        if (relation.name.empty())
            return;
        if (std::none_of(relations.begin(), relations.end(),
                         [&](const auto& existing) { return same_relation_target(existing, relation); }))
            relations.push_back(std::move(relation));
    };

    auto hf = df::historical_figure::find(unit->hist_figure_id);
    if (hf) {
        // df.history_figure.xml:1021-1071: family/deity links are typed histfig_hf_link records.
        size_t child_count = std::count_if(hf->histfig_links.begin(), hf->histfig_links.end(),
            [](auto link) { return link && link->getType() == df::histfig_hf_link_type::CHILD; });
        int family_sequence = 0;
        for (auto link : hf->histfig_links) {
            if (!link)
                continue;
            auto type = link->getType();
            auto target = df::historical_figure::find(link->target_hf);
            auto label = family_relation_label(type, target);
            if (label.empty())
                continue; // suppress former, coercive, and non-profile categories
            if (type == df::histfig_hf_link_type::CHILD && child_count == 1)
                label = "Only " + std::string(1, static_cast<char>(std::tolower(label[0]))) + label.substr(1);
            add(relation_for_hf(target, label, type == df::histfig_hf_link_type::DEITY ? "deity" : "family",
                                family_relation_order(type) + family_sequence++));
        }

        // df.history_figure.xml:773-795: rank zero is suppressed. The remaining native social
        // labels are determined by core.love (Friend <=74, Close Friend <=99, Kindred at 100).
        if (hf->info && hf->info->relationships) {
            for (auto profile : hf->info->relationships->hf_visual) {
                if (!profile || static_cast<int>(profile->rank) == 0 || profile->core.love < 50)
                    continue;
                std::string label = profile->core.love >= 100 ? "Kindred spirit" :
                    (profile->core.love >= 75 ? "Close friend" : "Friend");
                int order = 40000 + std::max(profile->histfig_id, 0);
                add(relation_for_hf(df::historical_figure::find(profile->histfig_id), label,
                                    "friend", order));
            }
        }
    }

    // df.unit.xml:2732: direct unit relations are exactly [0, NUM). Merge only the persistent
    // profile categories; transient attacker/drag/mount mechanics are suppressed by native UI.
    const size_t relation_count = std::min(
        std::size(unit->relationship_ids),
        static_cast<size_t>(df::unit_relationship_type::NUM));
    for (size_t i = 0; i < relation_count; ++i) {
        auto direct_type = static_cast<df::unit_relationship_type>(i);
        if (direct_type != df::unit_relationship_type::PetOwner &&
                direct_type != df::unit_relationship_type::Spouse &&
                direct_type != df::unit_relationship_type::Mother &&
                direct_type != df::unit_relationship_type::Father)
            continue;
        auto live = df::unit::find(unit->relationship_ids[i]);
        if (!live || !Units::isAlive(live) || !Units::isActive(live))
            continue;
        auto target_hf = df::historical_figure::find(live->hist_figure_id);
        df::histfig_hf_link_type hf_type = df::histfig_hf_link_type::NONE;
        if (direct_type == df::unit_relationship_type::PetOwner) hf_type = df::histfig_hf_link_type::PET_OWNER;
        if (direct_type == df::unit_relationship_type::Spouse) hf_type = df::histfig_hf_link_type::SPOUSE;
        if (direct_type == df::unit_relationship_type::Mother) hf_type = df::histfig_hf_link_type::MOTHER;
        if (direct_type == df::unit_relationship_type::Father) hf_type = df::histfig_hf_link_type::FATHER;
        UnitRelation relation = target_hf
            ? relation_for_hf(target_hf, family_relation_label(hf_type, target_hf), "family",
                              family_relation_order(hf_type))
            : UnitRelation{};
        if (!target_hf) {
            relation.label = family_relation_label(hf_type, nullptr);
            relation.name = Units::getReadableName(live, true);
            relation.profession = Units::getProfessionName(live);
            relation.unit_id = live->id;
            relation.color_role = "family";
            // W4: no historical figure on this branch (pets, unhistoric kin), so read the colour and
            // the death state off the live unit -- Units::getProfessionColor / Units::isDead, the
            // unit-side twins of the histfig reads in relation_for_hf.
            relation.profession_color = Units::getProfessionColor(live);
            relation.dead = Units::isDead(live);
            relation.order = family_relation_order(hf_type);
            fill_relation_portrait(relation, nullptr, live);
        }
        add(std::move(relation));
    }

    std::stable_sort(relations.begin(), relations.end(), [](const auto& a, const auto& b) {
        if (a.order != b.order)
            return a.order < b.order;
        return a.name < b.name;
    });
    return relations;
}

std::string group_category(df::historical_entity_type type) {
    using namespace df::enums::historical_entity_type;
    switch (type) {
        case Civilization: return "Civilization";
        case Religion: return "Religion";
        case SiteGovernment: return "Site government";
        case MilitaryUnit: return "Military organization";
        case Guild: return "Guild";
        case PerformanceTroupe: return "Performance troupe";
        case MerchantCompany: return "Merchant company";
        default: return pretty_key(DFHack::enum_item_key(type));
    }
}

int group_category_order(df::historical_entity_type type) {
    using namespace df::enums::historical_entity_type;
    if (type == Civilization) return 1000;
    if (type == Religion) return 2000;
    if (type == SiteGovernment) return 3000;
    return 4000 + static_cast<int>(type) * 10;
}

std::string group_status(df::histfig_entity_link_type type, df::historical_entity_type entity_type) {
    using namespace df::enums::histfig_entity_link_type;
    switch (type) {
        case MEMBER: return entity_type == df::historical_entity_type::Civilization ? "Citizen" : "Member";
        case RESIDENT: return "Resident";
        case MERCENARY: return "Mercenary";
        default: return "";
    }
}

std::vector<UnitGroup> unit_groups(df::unit* unit) {
    std::vector<UnitGroup> groups;
    std::vector<int32_t> entity_ids;
    auto hf = df::historical_figure::find(unit->hist_figure_id);
    if (!hf)
        return groups;
    // df.history_figure.xml:813-899,1068: active affiliations are typed entity_links.
    for (auto link : hf->entity_links) {
        if (!link || std::find(entity_ids.begin(), entity_ids.end(), link->entity_id) != entity_ids.end())
            continue;
        auto entity = df::historical_entity::find(link->entity_id);
        if (!entity)
            continue;
        auto status = group_status(link->getType(), entity->type);
        if (status.empty())
            continue; // former/involuntary/adversarial links are not native membership rows
        auto name = Translation::translateName(&entity->name, true);
        if (name.empty())
            continue;
        entity_ids.push_back(entity->id);
        groups.push_back({name, status, group_category(entity->type),
                          group_category_order(entity->type) + static_cast<int>(groups.size())});
    }
    std::stable_sort(groups.begin(), groups.end(), [](const auto& a, const auto& b) {
        if (a.order != b.order)
            return a.order < b.order;
        return a.entity_name < b.entity_name;
    });
    return groups;
}

std::vector<std::string> unit_military_lines(df::unit* unit) {
    std::vector<std::string> lines;
    if (unit->military.squad_id == -1)
        lines.push_back("No squad assigned");
    else {
        lines.push_back("Squad id: " + std::to_string(unit->military.squad_id));
        lines.push_back("Squad position: " + std::to_string(unit->military.squad_position));
        lines.push_back("Patrol timer: " + std::to_string(unit->military.patrol_timer));
    }
    return lines;
}

std::vector<std::string> unit_military_uniform_lines(df::unit* unit) {
    if (unit->military.squad_id == -1)
        return {"No uniform assigned"};
    auto squad = df::squad::find(unit->military.squad_id);
    if (!squad)
        return {"Squad data unavailable."};
    int pos_idx = unit->military.squad_position;
    if (pos_idx < 0 || pos_idx >= static_cast<int>(squad->positions.size()))
        return {"No squad position."};
    auto pos = squad->positions[pos_idx];
    if (!pos)
        return {"No squad position."};
    std::vector<std::string> lines;
    for (int cat = 0; cat <= df::enum_traits<df::uniform_category>::last_item_value; ++cat) {
        auto category = static_cast<df::uniform_category>(cat);
        for (auto spec : pos->equipment.uniform[cat]) {
            if (!spec)
                continue;
            std::string line = pretty_key(DFHack::enum_item_key(category)) + ": " +
                               pretty_key(DFHack::enum_item_key(spec->item_type));
            if (!spec->assigned.empty())
                line += " (assigned)";
            lines.push_back(line);
            if (lines.size() >= 24)
                return lines;
        }
    }
    if (lines.empty())
        lines.push_back("No uniform items for this position.");
    return lines;
}

std::string historical_figure_name_or_blank(int32_t hf_id) {
    if (hf_id == -1)
        return "";
    auto hf = df::historical_figure::find(hf_id);
    if (!hf)
        return "";
    std::string name = Translation::translateName(&hf->name, true);
    return name;
}

std::vector<std::string> unit_military_kill_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto world = df::global::world;
    auto hf = df::historical_figure::find(unit->hist_figure_id);
    if (hf && hf->info && hf->info->kills) {
        auto kills = hf->info->kills;
        for (auto event_id : kills->events) {
            auto event = df::history_event::find(event_id);
            auto died = strict_virtual_cast<df::history_event_hist_figure_diedst>(event);
            if (!died)
                continue;
            auto name = historical_figure_name_or_blank(died->victim_hf);
            if (!name.empty())
                lines.push_back(name);
            if (lines.size() >= 20)
                break;
        }
        for (size_t i = 0; i < kills->killed_race.size() &&
                           i < kills->killed_count.size(); ++i) {
            int race = kills->killed_race[i];
            if (!world || race < 0 ||
                    race >= static_cast<int>(world->raws.creatures.all.size()))
                continue;
            auto craw = world->raws.creatures.all[race];
            if (!craw)
                continue;
            lines.push_back(std::to_string(kills->killed_count[i]) + " " +
                            craw->name[kills->killed_count[i] == 1 ? 0 : 1]);
            if (lines.size() >= 40)
                break;
        }
    }
    if (lines.empty())
        lines.push_back("No kills recorded");
    return lines;
}

std::string unit_current_job_label(df::unit* unit,
                                   const WorldActivityIndex& world_activities) {
    auto name = unit_current_task_name(unit, &world_activities);
    if (!name.empty())
        return name;
    return "No job";
}

std::vector<std::string> unit_overview_relation_lines(df::unit* unit) {
    std::vector<std::string> lines;
    int32_t spouse_id = unit->relationship_ids[df::enums::unit_relationship_type::Spouse];
    if (spouse_id != -1)
        lines.push_back("Spouse: " + related_unit_label(spouse_id));
    int32_t lover_id = unit->relationship_ids[df::enums::unit_relationship_type::Lover];
    if (lover_id != -1 && lover_id != spouse_id)
        lines.push_back("Lover: " + related_unit_label(lover_id));
    int32_t owner_id = unit->relationship_ids[df::enums::unit_relationship_type::PetOwner];
    if (owner_id != -1)
        lines.push_back("Owner: " + related_unit_label(owner_id));
    return lines;
}

std::vector<std::string> unit_personality_trait_lines(df::unit* unit);

std::vector<std::string> unit_overview_trait_lines(df::unit* unit,
                                                   const std::vector<std::string>& status_lines) {
    std::vector<std::string> lines;
    for (const auto& line : status_lines) {
        if (line != "Healthy")
            lines.push_back(line);
        if (lines.size() >= 6)
            return lines;
    }

    auto short_trait = [&](df::personality_facet_type facet, const char* high, const char* low) {
        if (trait_high(unit, facet))
            lines.push_back(high);
        else if (trait_low(unit, facet))
            lines.push_back(low);
    };

    using namespace df::enums::personality_facet_type;
    short_trait(CHEER_PROPENSITY, "Cheerful", "Often sad");
    short_trait(PERSEVERANCE, "High willpower", "Poor focus");
    short_trait(TOLERANT, "Tolerant", "Disdains harmony");
    short_trait(ALTRUISM, "Merciful", "Self-interested");
    short_trait(BRAVERY, "Brave", "Quick to give up");
    using namespace df::enums::mental_attribute_type;
    if (mental_attr_value(unit, KINESTHETIC_SENSE) >= mental_attr_high_threshold(unit, KINESTHETIC_SENSE))
        lines.push_back("High kinesthetic sense");
    else if (mental_attr_value(unit, KINESTHETIC_SENSE) < mental_attr_low_threshold(unit, KINESTHETIC_SENSE))
        lines.push_back("Poor kinesthetic sense");
    if (mental_attr_value(unit, SOCIAL_AWARENESS) >= mental_attr_high_threshold(unit, SOCIAL_AWARENESS))
        lines.push_back("Good social ability");
    else if (mental_attr_value(unit, SOCIAL_AWARENESS) < mental_attr_low_threshold(unit, SOCIAL_AWARENESS))
        lines.push_back("Low social ability");

    if (lines.empty()) {
        for (const auto& line : unit_personality_trait_lines(unit)) {
            if (line == "No notable personality traits.")
                continue;
            lines.push_back(line);
            if (lines.size() >= 6)
                break;
        }
    }
    return lines;
}

std::string noble_position_label(const Units::NoblePosition& pos, df::unit* unit) {
    if (!pos.position)
        return "";
    int plural_idx = 0;
    std::string name;
    if (Units::isFemale(unit))
        name = pos.position->name_female[plural_idx];
    else if (Units::isMale(unit))
        name = pos.position->name_male[plural_idx];
    if (name.empty())
        name = pos.position->name[plural_idx];
    return name;
}

std::vector<std::string> unit_overview_position_lines(df::unit* unit) {
    std::vector<std::string> lines;
    if (Units::isCitizen(unit))
        lines.push_back("Citizen");
    else if (Units::isOwnGroup(unit))
        lines.push_back("Fort controlled");
    else if (Units::isTame(unit))
        lines.push_back("Tame");

    std::vector<Units::NoblePosition> positions;
    if (Units::getNoblePositions(&positions, unit)) {
        for (const auto& pos : positions) {
            auto label = noble_position_label(pos, unit);
            if (!label.empty())
                lines.push_back(label);
            if (lines.size() >= 6)
                break;
        }
    }
    if (lines.size() == (Units::isCitizen(unit) || Units::isOwnGroup(unit) || Units::isTame(unit) ? 1u : 0u))
        lines.push_back("No official position");
    return lines;
}

std::vector<std::string> unit_overview_squad_lines(df::unit* unit) {
    std::vector<std::string> lines;
    if (unit->military.squad_id == -1) {
        lines.push_back("Squad: None");
        return lines;
    }
    auto squad = df::squad::find(unit->military.squad_id);
    if (!squad) {
        lines.push_back("Squad id: " + std::to_string(unit->military.squad_id));
        return lines;
    }
    std::string name = squad->alias;
    if (name.empty())
        name = Translation::translateName(&squad->name, true);
    if (name.empty())
        name = "Squad " + std::to_string(squad->id);
    lines.push_back("Squad: " + name);
    if (unit->military.squad_position >= 0)
        lines.push_back("Position: " + std::to_string(unit->military.squad_position + 1));
    return lines;
}

std::vector<std::string> unit_overview_skill_lines(const std::vector<std::string>& skill_lines) {
    std::vector<std::string> lines;
    for (const auto& line : skill_lines) {
        if (line == "No notable skills.")
            continue;
        lines.push_back(line);
        if (lines.size() >= 6)
            break;
    }
    return lines;
}

std::vector<std::string> unit_overview_need_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto soul = unit->status.current_soul;
    if (!soul)
        return lines;
    std::vector<std::pair<int32_t, std::string>> ranked;
    for (auto need : soul->personality.needs) {
        if (!need || need->focus_level >= 0)
            continue;
        auto key = pretty_key(DFHack::enum_item_key(need->id));
        ranked.emplace_back(need->focus_level, "Unmet need: " + key);
    }
    std::sort(ranked.begin(), ranked.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });
    for (const auto& entry : ranked) {
        lines.push_back(entry.second);
        if (lines.size() >= 7)
            break;
    }
    return lines;
}

std::string relation_for_subthought(int32_t subthought) {
    switch (subthought) {
    case 0: return "pet";
    case 1: return "spouse";
    case 2: return "mother";
    case 3: return "father";
    case 9: return "lover";
    case 11: return "sibling";
    case 12: return "child";
    case 13: return "friend";
    case 14: return "acquaintance";
    case 18: return "animal training partner";
    default: return "acquaintance";
    }
}

std::string need_clause(df::need_type type, const std::string& target);

void replace_all(std::string& text, const std::string& from, const std::string& to) {
    if (from.empty())
        return;
    size_t pos = 0;
    while ((pos = text.find(from, pos)) != std::string::npos) {
        text.replace(pos, from.size(), to);
        pos += to.size();
    }
}

std::string emotion_name(df::emotion_type emotion) {
    if (!df::enum_traits<df::emotion_type>::is_valid(static_cast<int32_t>(emotion)) ||
        emotion == df::emotion_type::ANYTHING)
        return "emotion";
    return pretty_key(DFHack::enum_item_key(emotion));
}

std::string thought_phrase(df::unit* unit, df::unit_thought_type thought, int32_t subthought) {
    using namespace df::enums::unit_thought_type;
    if (thought == SatisfiedAtWork)
        return "at work";
    if (thought == NeedsUnfulfilled && df::enum_traits<df::need_type>::is_valid(subthought))
        return "after " + need_clause(static_cast<df::need_type>(subthought), "") + " for too long";
    if (thought == BedroomQuality)
        return "after sleeping in a good bedroom";
    if (thought == BecomeParent)
        return "after becoming a parent";
    if (thought == GaveBirth) {
        auto child = df::unit::find(subthought);
        return std::string("after giving birth to ") +
            (child ? (Units::isFemale(child) ? "a girl" : Units::isMale(child) ? "a boy" : "a baby") : "a baby");
    }
    if (thought == MadeFriend)
        return "after making a friend";
    if (thought == NewRomance)
        return "after beginning a new romance";
    if (thought == Rain)
        return "when caught in the rain";
    if (thought == LackChairs)
        return "at the lack of chairs";
    if (thought == IntellectualDiscussion)
        return "after having an intellectual discussion";
    if (thought == IgnoredTemplePetition) {
        auto entity = df::historical_entity::find(subthought);
        auto name = entity ? Translation::translateName(&entity->name, true) : "a religious congregation";
        return "dwelling upon a petition for a temple for " + name + " being ignored";
    }
    std::string text;
    if (df::enum_traits<df::unit_thought_type>::is_valid(static_cast<int32_t>(thought))) {
        const char* caption = df::enum_traits<df::unit_thought_type>::attrs(thought).caption;
        if (caption)
            text = caption;
    }
    if (text.empty() || text == "[multiple]" || text == "[varying]")
        text = humanize_key(DFHack::enum_item_key(thought));

    replace_all(text, "[relation]", relation_for_subthought(subthought));
    replace_all(text, "[somebody]", "somebody");
    replace_all(text, "[a baby]", "a baby");
    replace_all(text, "[animal]", "an animal");
    replace_all(text, "[vermin]", "vermin");
    auto target_name = historical_figure_name_or_blank(subthought);
    replace_all(text, "[deity]", target_name.empty() ? "a deity" : target_name);
    replace_all(text, "[skill]", "a skill");
    replace_all(text, "[quality]", "quality");
    replace_all(text, "[building]", "building");
    replace_all(text, "[relative]", "relative");
    replace_all(text, "[research]", "research");
    replace_all(text, "[topic]", "a topic");
    replace_all(text, "[book]", "a book");
    replace_all(text, "[his]", pronoun_possessive(unit));
    replace_all(text, "[he]", pronoun_subject(unit));
    size_t open;
    while ((open = text.find('[')) != std::string::npos) {
        auto close = text.find(']', open + 1);
        if (close == std::string::npos)
            break;
        text.replace(open, close - open + 1, "the event");
    }
    return text;
}

std::string emotion_memory_line(df::unit* unit, df::emotion_type emotion,
                                df::unit_thought_type thought, int32_t subthought,
                                bool current) {
    auto emotion_text = emotion_name(emotion);
    std::transform(emotion_text.begin(), emotion_text.end(), emotion_text.begin(),
                   [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    auto phrase = thought_phrase(unit, thought, subthought);
    std::string out = pronoun_subject(unit) + (current ? " feels " : " felt ") + emotion_text;
    if (!phrase.empty())
        out += " " + phrase;
    out += ".";
    return out;
}

bool valid_memory(const df::unit_emotion_memory& memory) {
    return memory.type != df::emotion_type::ANYTHING &&
           memory.thought != df::unit_thought_type::None &&
           df::enum_traits<df::emotion_type>::is_valid(static_cast<int32_t>(memory.type)) &&
           df::enum_traits<df::unit_thought_type>::is_valid(static_cast<int32_t>(memory.thought));
}

std::vector<std::string> unit_recent_feeling_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto soul = unit->status.current_soul;
    if (!soul)
        return lines;

    for (auto mood : soul->personality.emotions) {
        if (!mood || mood->type == df::emotion_type::ANYTHING ||
            mood->thought == df::unit_thought_type::None)
            continue;
        lines.push_back(emotion_memory_line(unit, mood->type, mood->thought, mood->subthought, true));
        if (lines.size() >= 6)
            break;
    }

    if (auto memories = soul->personality.memories) {
        for (const auto& memory : memories->shortterm) {
            if (!valid_memory(memory))
                continue;
            lines.push_back(emotion_memory_line(unit, memory.type, memory.thought, memory.subthought, false));
            if (lines.size() >= 16)
                break;
        }
        for (const auto& memory : memories->longterm) {
            if (lines.size() >= 16 || !valid_memory(memory))
                continue;
            lines.push_back(emotion_memory_line(unit, memory.type, memory.thought, memory.subthought, false));
        }
    }
    return lines;
}

std::vector<std::string> unit_thought_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto soul = unit->status.current_soul;
    if (soul) {
        static const char* const kStressLabels[] = {
            "Ecstatic", "Happy", "Content", "Fine", "Stressed", "Haggard", "Overwhelmed"};
        int cat = DFHack::Units::getStressCategory(unit);
        cat = std::max(0, std::min(6, cat));
        lines.push_back("Stress: " + std::to_string(soul->personality.stress) +
                        " (" + kStressLabels[cat] + ")");
    }

    auto feelings = unit_recent_feeling_lines(unit);
    lines.insert(lines.end(), feelings.begin(), feelings.end());
    if (!feelings.empty())
        return lines;

    if (soul) {
        lines.push_back("Long-term stress: " + std::to_string(soul->personality.longterm_stress));
        lines.push_back("Current focus: " + std::to_string(soul->personality.current_focus));
        if (soul->personality.dreams.empty()) {
            lines.push_back("No dreams recorded.");
        } else {
            for (auto dream : soul->personality.dreams) {
                if (!dream)
                    continue;
                auto name = pretty_key(DFHack::enum_item_key(dream->type));
                lines.push_back(std::string("Dream: ") + name);
                if (lines.size() >= 12)
                    break;
            }
        }
    }
    if (lines.empty())
        lines.push_back("No thought data for this unit.");
    return lines;
}

void add_mental_attribute_line(std::vector<std::string>& lines, df::unit* unit,
                               df::mental_attribute_type attr,
                               const char* high_text, const char* low_text) {
    int value = mental_attr_value(unit, attr);
    if (value >= mental_attr_high_threshold(unit, attr))
        lines.push_back(pronoun_subject(unit) + " has " + high_text + ".");
    else if (value < mental_attr_low_threshold(unit, attr))
        lines.push_back(pronoun_subject(unit) + " has " + low_text + ".");
}

void add_trait_line(std::vector<std::string>& lines, df::unit* unit,
                    df::personality_facet_type facet,
                    const char* high_text, const char* low_text) {
    if (trait_high(unit, facet))
        lines.push_back(pronoun_subject(unit) + " " + high_text + ".");
    else if (trait_low(unit, facet))
        lines.push_back(pronoun_subject(unit) + " " + low_text + ".");
}

std::vector<std::string> unit_personality_trait_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto soul = unit->status.current_soul;
    if (soul) {
        using namespace df::enums::mental_attribute_type;
        add_mental_attribute_line(lines, unit, EMPATHY, "a great sense of empathy", "a poor sense of empathy");
        add_mental_attribute_line(lines, unit, KINESTHETIC_SENSE, "a good kinesthetic sense", "a poor kinesthetic sense");
        add_mental_attribute_line(lines, unit, LINGUISTIC_ABILITY, "a way with words", "little facility with words");
        add_mental_attribute_line(lines, unit, SOCIAL_AWARENESS, "a good sense for social relationships", "a meager ability with social relationships");
        add_mental_attribute_line(lines, unit, MEMORY, "a good memory", "a poor memory");
        add_mental_attribute_line(lines, unit, MUSICALITY, "natural musical ability", "no natural musical ability");

        using namespace df::enums::personality_facet_type;
        add_trait_line(lines, unit, DEPRESSION_PROPENSITY, "often feels discouraged", "rarely feels discouraged");
        add_trait_line(lines, unit, ANGER_PROPENSITY, "is quick to anger", "is slow to anger");
        add_trait_line(lines, unit, ANXIETY_PROPENSITY, "tends to worry", "is calm under pressure");
        add_trait_line(lines, unit, ORDERLINESS, "likes to keep things orderly", "does not mind a little clutter");
        add_trait_line(lines, unit, FRIENDLINESS, "is a friendly individual", "keeps others at arm's length");
        add_trait_line(lines, unit, GREGARIOUSNESS, "enjoys forming deep emotional bonds", "tends to keep away from others");
        add_trait_line(lines, unit, CURIOUS, "is curious and eager to learn", "is not very curious");
        add_trait_line(lines, unit, ART_INCLINED, "is moved by art and natural beauty", "does not care about art or natural beauty");
        add_trait_line(lines, unit, IMAGINATION, "has a vivid imagination", "has little imagination");
        add_trait_line(lines, unit, PERSEVERANCE, "has strong willpower", "gives up easily");
    }
    if (lines.empty())
        lines.push_back("No notable personality traits.");
    return lines;
}

std::vector<std::string> unit_personality_value_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto soul = unit->status.current_soul;
    if (soul) {
        for (auto value : soul->personality.values) {
            if (!value)
                continue;
            lines.push_back(pretty_key(DFHack::enum_item_key(value->type)) +
                            ": " + std::to_string(value->strength));
            if (lines.size() >= 16)
                break;
        }
    }
    if (lines.empty())
        lines.push_back("No values recorded.");
    return lines;
}

std::string native_emotion_word(df::emotion_type emotion) {
    using namespace df::enums::emotion_type;
    switch (emotion) {
    case SATISFACTION: return "satisfied";
    case BLISS: return "blissful";
    case UNEASINESS: return "uneasy";
    case ANNOYANCE: return "annoyed";
    case INTEREST: return "interested";
    case RESENTMENT: return "resentful";
    case RIGHTEOUS_INDIGNATION: return "indignant";
    case HAPPINESS: return "happy";
    case SADNESS: return "sad";
    case ANGER: return "angry";
    case FEAR: return "afraid";
    default: {
        auto word = emotion_name(emotion);
        std::transform(word.begin(), word.end(), word.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        return word;
    }
    }
}

// DF's OWN emotion color, from the binary-extracted enum attr (df.d_basics.xml:686,
// `df::emotion_type::color`, int8 curses index, default 7). This is the exact table DF uses to
// color the emotion word in thoughts text -- e.g. ADORATION=11 (bright cyan), UNEASINESS=6 (brown),
// SATISFACTION=10 (bright green) -- live-verified against the running game (text-color spec §2.4,
// §5). Returns -1 for an invalid emotion so the client themes by role instead of inventing a hue.
int emotion_native_color(df::emotion_type emotion) {
    if (!df::enum_traits<df::emotion_type>::is_valid(static_cast<int32_t>(emotion)))
        return -1;
    return static_cast<int>(df::enum_traits<df::emotion_type>::attrs(emotion).color);
}

// Valence as DATA, not a hand-sorted word list (the deletion in text-color spec §3.4). DF's
// `divider` attr is a stress divider whose SIGN is the valence: negative divider = positive
// emotion, positive divider = negative emotion, zero = neutral (df.d_basics.xml:687). The old
// ~55-case hand switch could never agree with DF's ~130 emotions; this covers all of them and
// versions with df-structures. `role` now drives only weight/emphasis theming -- hue comes from
// emotion_native_color.
std::string emotion_role(df::emotion_type emotion) {
    if (!df::enum_traits<df::emotion_type>::is_valid(static_cast<int32_t>(emotion)))
        return "emotion-neutral";
    int divider = static_cast<int>(df::enum_traits<df::emotion_type>::attrs(emotion).divider);
    if (divider < 0)
        return "emotion-positive";
    if (divider > 0)
        return "emotion-negative";
    return "emotion-neutral";
}

UnitThoughtRecord make_thought_record(df::unit* unit, const std::string& category,
                                      df::emotion_type emotion, df::unit_thought_type thought,
                                      int32_t subthought, int32_t strength, int32_t year,
                                      int32_t year_tick, bool remembered, bool current,
                                      int32_t order) {
    UnitThoughtRecord record;
    record.category = category;
    record.emotion = static_cast<int32_t>(emotion);
    record.thought = static_cast<int32_t>(thought);
    record.subthought = subthought;
    record.strength = strength;
    record.year = year;
    record.year_tick = year_tick;
    record.remembered = remembered;
    record.dedup_key = std::to_string(record.emotion) + ":" + std::to_string(record.thought) +
        ":" + std::to_string(subthought) + ":" + std::to_string(year) + ":" +
        std::to_string(year_tick);
    record.order = order;
    record.spans.push_back({pronoun_subject(unit) + (current ? " feels " : " felt "), "neutral"});
    // The emotion word itself carries DF's OWN color index (text-color spec §3.4). role stays for
    // theming; color is authoritative for hue on the client.
    UnitTextSpan emotion_span;
    emotion_span.text = native_emotion_word(emotion);
    emotion_span.role = emotion_role(emotion);
    emotion_span.color = emotion_native_color(emotion);
    record.spans.push_back(std::move(emotion_span));
    if (remembered)
        record.spans.push_back({" remembering", "memory"});
    auto phrase = thought_phrase(unit, thought, subthought);
    if (!phrase.empty())
        record.spans.push_back({" " + phrase, "neutral"});
    record.spans.push_back({".", "neutral"});
    return record;
}

std::vector<UnitThoughtRecord> unit_recent_thought_records(df::unit* unit) {
    std::vector<UnitThoughtRecord> records;
    auto soul = unit->status.current_soul;
    if (!soul)
        return records;
    std::vector<df::personality_moodst*> moods;
    for (auto mood : soul->personality.emotions) {
        if (!mood || mood->type == df::emotion_type::ANYTHING ||
            mood->thought == df::unit_thought_type::None)
            continue;
        moods.push_back(mood);
    }
    std::stable_sort(moods.begin(), moods.end(), [](const auto* a, const auto* b) {
        if (a->year != b->year)
            return a->year > b->year;
        return a->year_tick > b->year_tick;
    });
    for (auto mood : moods) {
        bool remembered = mood->flags.bits.remembered_longterm ||
            mood->flags.bits.remembered_shortterm || mood->flags.bits.remembered_reflected_on;
        records.push_back(make_thought_record(unit, "recent", mood->type, mood->thought,
            mood->subthought, mood->strength, mood->year, mood->year_tick, remembered,
            records.empty(), static_cast<int32_t>(records.size())));
    }
    return records;
}

std::vector<UnitThoughtRecord> unit_memory_records(df::unit* unit) {
    std::vector<UnitThoughtRecord> records;
    auto soul = unit->status.current_soul;
    auto memories = soul ? soul->personality.memories : nullptr;
    if (!memories)
        return records;
    auto append_memory = [&](const df::unit_emotion_memory& memory, const char* category) {
        if (!valid_memory(memory))
            return;
        records.push_back(make_thought_record(unit, category, memory.type, memory.thought,
            memory.subthought, memory.strength, memory.year, memory.year_tick,
            memory.flags.bits.has_remembered, false, static_cast<int32_t>(records.size())));
    };
    for (const auto& memory : memories->shortterm)
        append_memory(memory, "short-term");
    for (const auto& memory : memories->longterm)
        append_memory(memory, "long-term");
    std::stable_sort(records.begin(), records.end(), [](const auto& a, const auto& b) {
        if (a.year != b.year)
            return a.year > b.year;
        return a.year_tick > b.year_tick;
    });
    for (size_t i = 0; i < records.size(); ++i)
        records[i].order = static_cast<int32_t>(i);
    return records;
}

std::string unit_preference_name(df::unit_preference* pref);

std::vector<std::string> unit_personality_preference_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto soul = unit->status.current_soul;
    if (soul) {
        for (auto pref : soul->preferences) {
            if (!pref)
                continue;
            auto name = unit_preference_name(pref);
            if (!name.empty())
                lines.push_back((pref->type == df::unitpref_type::HateCreature ?
                    "Absolutely detests " : "Likes ") + name);
        }
    }
    if (lines.empty())
        lines.push_back("No preferences recorded.");
    return lines;
}

std::string need_level_label(int32_t level) {
    if (level <= 1)
        return "Slight";
    if (level < 5)
        return "Moderate";
    if (level < 10)
        return "Strong";
    return "Intense";
}

std::string need_focus_label(int32_t focus) {
    if (focus >= 300)
        return "satisfied";
    if (focus >= 100)
        return "content";
    if (focus >= 0)
        return "distracting";
    return "unfulfilled";
}

std::vector<std::string> unit_personality_need_lines(df::unit* unit) {
    std::vector<std::string> lines;
    auto soul = unit->status.current_soul;
    if (soul) {
        for (auto need : soul->personality.needs) {
            if (!need)
                continue;
            lines.push_back(need_level_label(need->need_level) + " need to " +
                            pretty_key(DFHack::enum_item_key(need->id)) +
                            " (" + need_focus_label(need->focus_level) +
                            ", focus " + std::to_string(need->focus_level) + ")");
            if (lines.size() >= 16)
                break;
        }
    }
    if (lines.empty())
        lines.push_back("No needs recorded.");
    return lines;
}

// `color` is DF's native curses index for the whole clause, or -1 for "no native color, theme by
// role". DF's personality_raw_str wraps each clause in a single [C:fg:bg:bright] run (text-color
// spec §2.2, §5 second probe), so the subject, phrase, and period share one color -- we mirror that
// by stamping the same index on all three spans. Callers that pass no color (mannerisms/quirks,
// which the live probe found token-free -> parser default) leave the spans uncolored.
void append_sentence(UnitTextParagraph& paragraph, const std::string& subject,
                     const std::string& phrase, const std::string& role, int color = -1) {
    if (!paragraph.spans.empty())
        paragraph.spans.push_back({" ", "neutral"});
    paragraph.spans.push_back({subject + " ", "neutral", color});
    paragraph.spans.push_back({phrase, role, color});
    paragraph.spans.push_back({".", "neutral", color});
}

std::vector<UnitTextParagraph> unit_personality_trait_narrative(df::unit* unit) {
    std::vector<UnitTextParagraph> paragraphs;
    auto soul = unit->status.current_soul;
    if (!soul)
        return paragraphs;

    struct MentalPhrase {
        df::mental_attribute_type type;
        const char* high;
        const char* low;
    };
    static const MentalPhrase mental_phrases[] = {
        {df::mental_attribute_type::ANALYTICAL_ABILITY, "has a natural analytical ability", "has difficulty with analytical thinking"},
        {df::mental_attribute_type::FOCUS, "is able to focus easily", "is easily distracted"},
        {df::mental_attribute_type::WILLPOWER, "has a great deal of willpower", "has very little willpower"},
        {df::mental_attribute_type::CREATIVITY, "has a natural creative ability", "is not naturally creative"},
        {df::mental_attribute_type::INTUITION, "has very good intuition", "has very bad intuition"},
        {df::mental_attribute_type::PATIENCE, "has a great deal of patience", "is very impatient"},
        {df::mental_attribute_type::MEMORY, "has a good memory", "has a poor memory"},
        {df::mental_attribute_type::LINGUISTIC_ABILITY, "has a natural inclination toward language", "has little facility with words"},
        {df::mental_attribute_type::SPATIAL_SENSE, "has a good spatial sense", "has a poor spatial sense"},
        {df::mental_attribute_type::MUSICALITY, "has natural musical ability", "has no natural musical ability"},
        {df::mental_attribute_type::KINESTHETIC_SENSE, "has a good kinesthetic sense", "has a poor kinesthetic sense"},
        {df::mental_attribute_type::EMPATHY, "has a great sense of empathy", "has a poor sense of empathy"},
        {df::mental_attribute_type::SOCIAL_AWARENESS, "has a good sense for social relationships", "has a meager ability with social relationships"},
    };
    UnitTextParagraph aptitude;
    for (const auto& entry : mental_phrases) {
        int value = mental_attr_value(unit, entry.type);
        // Native attribute-summary valence color (text-color spec §5 second probe: the aptitude
        // clauses are [C:2:0:0] green for a strength / [C:4:0:0] red for a weakness). 2 = green,
        // 4 = red in the curses palette.
        if (value >= mental_attr_high_threshold(unit, entry.type))
            append_sentence(aptitude, pronoun_subject(unit), entry.high, "positive", 2);
        else if (value < mental_attr_low_threshold(unit, entry.type))
            append_sentence(aptitude, pronoun_subject(unit), entry.low, "negative", 4);
    }
    if (!aptitude.spans.empty())
        paragraphs.push_back(std::move(aptitude));

    struct FacetPhrase {
        df::personality_facet_type type;
        const char* high;
        const char* low;
    };
    using namespace df::enums::personality_facet_type;
    static const FacetPhrase facet_phrases[] = {
        {LOVE_PROPENSITY, "easily falls in love and develops positive sentiments", "does not easily fall in love or develop positive sentiments"},
        {HATE_PROPENSITY, "is quick to form lasting grudges", "does not tend to hate others"},
        {ENVY_PROPENSITY, "is often envious of others", "doesn't often feel envious of others"},
        {CHEER_PROPENSITY, "has a naturally cheerful disposition", "is rarely cheerful"},
        {DEPRESSION_PROPENSITY, "often feels discouraged", "rarely feels discouraged"},
        {ANGER_PROPENSITY, "is quick to anger", "is slow to anger"},
        {ANXIETY_PROPENSITY, "tends to worry", "is calm under pressure"},
        {LUST_PROPENSITY, "is driven by lust", "is rarely moved by lust"},
        {STRESS_VULNERABILITY, "is easily overwhelmed by stress", "is confident under pressure"},
        {GREED, "has a greedy streak", "cares little for material wealth"},
        {IMMODERATION, "occasionally overindulges", "is restrained and self-controlled"},
        {VIOLENT, "is given to violent outbursts", "avoids violence when possible"},
        {PERSEVERANCE, "has strong willpower and continues through adversity", "gives up easily"},
        {WASTEFULNESS, "is wasteful with resources", "is careful with resources"},
        {DISCORD, "often creates discord", "seeks harmony in relationships"},
        {FRIENDLINESS, "is a friendly individual", "keeps others at arm's length"},
        {POLITENESS, "is unfailingly polite", "could be considered rude"},
        {DISDAIN_ADVICE, "dislikes receiving advice", "welcomes advice from others"},
        {BRAVERY, "is remarkably brave", "is easily frightened"},
        {CONFIDENCE, "is confident in personal abilities", "lacks confidence"},
        {VANITY, "is deeply concerned with appearances", "is not vain"},
        {AMBITION, "is very ambitious", "has little ambition"},
        {GRATITUDE, "is grateful for the help of others", "rarely feels gratitude"},
        {IMMODESTY, "is given to self-promotion", "is modest about personal accomplishments"},
        {HUMOR, "has a great sense of humor", "has little sense of humor"},
        {VENGEFUL, "is vengeful", "is forgiving"},
        {PRIDE, "takes great pride in personal accomplishments", "is not prideful"},
        {CRUELTY, "can be cruel", "is compassionate"},
        {SINGLEMINDED, "pursues goals single-mindedly", "is easily diverted from goals"},
        {HOPEFUL, "is hopeful about the future", "expects the worst"},
        {CURIOUS, "is curious and eager to learn", "is not particularly interested in what others think"},
        {BASHFUL, "is bashful around others", "is socially bold"},
        {PRIVACY, "greatly values privacy", "is open about personal matters"},
        {PERFECTIONIST, "is a perfectionist", "is comfortable with imperfections"},
        {CLOSEMINDED, "is close-minded to new ideas", "is open to new ideas"},
        {TOLERANT, "is tolerant of differences", "is intolerant of differences"},
        {EMOTIONALLY_OBSESSIVE, "can become emotionally obsessive", "does not dwell on emotions"},
        {SWAYED_BY_EMOTIONS, "is swayed by emotional appeals", "is not swayed by emotional appeals"},
        {ALTRUISM, "finds helping others emotionally rewarding", "is primarily self-interested"},
        {DUTIFULNESS, "has a strong sense of duty", "dislikes obligations"},
        {THOUGHTLESSNESS, "often acts without deliberation", "can get caught up in internal deliberations when action is necessary"},
        {ORDERLINESS, "likes to keep things orderly", "does not mind a little clutter"},
        {TRUST, "is trusting of others", "is slow to trust"},
        {GREGARIOUSNESS, "seeks out the company of others", "avoids exciting or stressful social situations"},
        {ASSERTIVENESS, "is assertive in conversation", "rarely asserts personal opinions"},
        {ACTIVITY_LEVEL, "is constantly active", "has a relaxed pace"},
        {EXCITEMENT_SEEKING, "seeks excitement", "avoids excitement"},
        {IMAGINATION, "has a vivid imagination", "has little imagination"},
        {ABSTRACT_INCLINED, "enjoys abstract thinking", "prefers practical matters"},
        {ART_INCLINED, "is moved by art and natural beauty", "does not care about art or natural beauty"},
    };
    UnitTextParagraph facets;
    // Native colors the whole trait-facet paragraph bright white (text-color spec §5 second probe:
    // the trait paragraph is [P][C:7:0:1] -> curses index 7 + bright*8 = 15). No per-facet valence
    // hue exists in native, so every facet clause is the same 15, not a positive/negative split.
    for (const auto& entry : facet_phrases) {
        if (trait_high(unit, entry.type))
            append_sentence(facets, pronoun_subject(unit), entry.high, "neutral", 15);
        else if (trait_low(unit, entry.type))
            append_sentence(facets, pronoun_subject(unit), entry.low, "neutral", 15);
    }
    if (!facets.spans.empty())
        paragraphs.push_back(std::move(facets));

    UnitTextParagraph mannerisms;
    for (auto mannerism : soul->personality.mannerism) {
        if (!mannerism)
            continue;
        auto behavior = pretty_key(DFHack::enum_item_key(mannerism->type));
        auto situation = pretty_key(DFHack::enum_item_key(mannerism->situation));
        append_sentence(mannerisms, pronoun_subject(unit), behavior +
            (situation == "None" ? "" : " " + situation), "neutral");
    }
    for (auto habit : soul->personality.habit) {
        auto behavior = humanize_key(DFHack::enum_item_key(habit));
        append_sentence(mannerisms, pronoun_subject(unit), "has a habit of " + lower_first(behavior), "neutral");
    }
    if (soul->personality.combat_hardened >= 3)
        append_sentence(mannerisms, pronoun_subject(unit), "is a hardened individual", "neutral");
    if (!mannerisms.spans.empty())
        paragraphs.push_back(std::move(mannerisms));
    if (paragraphs.empty())
        paragraphs.push_back({{{"No notable personality traits.", "neutral"}}});
    return paragraphs;
}

std::string value_subject(df::value_type type) {
    using namespace df::enums::value_type;
    switch (type) {
    case LAW: return "the law";
    case LOYALTY: return "loyalty";
    case FAMILY: return "family";
    case FRIENDSHIP: return "friendship";
    case TRUTH: return "honesty";
    case FAIRNESS: return "fair dealing";
    case DECORUM: return "decorum and respect";
    case ARTWORK: return "art";
    case COOPERATION: return "cooperation";
    case HARMONY: return "harmony";
    case MERRIMENT: return "merrymaking";
    case CRAFTSMANSHIP: return "craftsmanship";
    case MARTIAL_PROWESS: return "martial prowess";
    case SKILL: return "skill";
    case HARD_WORK: return "hard work";
    case LEISURE_TIME: return "leisure time";
    case COMMERCE: return "commerce";
    case ROMANCE: return "romance";
    case NATURE: return "nature";
    case PEACE: return "peace";
    case KNOWLEDGE: return "knowledge";
    default: {
        auto text = pretty_key(DFHack::enum_item_key(type));
        std::transform(text.begin(), text.end(), text.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        return text;
    }
    }
}

const int32_t* cultural_values(df::unit_soul* soul) {
    if (auto identity = df::cultural_identity::find(soul->personality.cultural_identity))
        return identity->values;
    if (auto entity = df::historical_entity::find(soul->personality.civ_id))
        if (entity->entity_raw)
            return entity->entity_raw->values;
    return nullptr;
}

std::vector<UnitTextParagraph> unit_personality_value_narrative(df::unit* unit) {
    std::vector<UnitTextParagraph> paragraphs;
    auto soul = unit->status.current_soul;
    if (!soul)
        return paragraphs;
    if (auto values = cultural_values(soul)) {
        std::vector<std::string> held;
        std::vector<std::string> rejected;
        for (int32_t i = 0; i <= df::enum_traits<df::value_type>::last_item_value; ++i) {
            auto type = static_cast<df::value_type>(i);
            if (values[i] >= 10)
                held.push_back(value_subject(type));
            else if (values[i] <= -10)
                rejected.push_back(value_subject(type));
        }
        UnitTextParagraph culture;
        if (!held.empty())
            culture.spans.push_back({"Like others in " + pronoun_possessive(unit) +
                " culture, " + pronoun_subject_lower(unit) + " values " + join_phrases(held) + ".", "neutral"});
        if (!rejected.empty())
            culture.spans.push_back({" " + pronoun_subject(unit) + " has little respect for " +
                join_phrases(rejected) + ".", "neutral"});
        if (!culture.spans.empty())
            paragraphs.push_back(std::move(culture));
    }
    UnitTextParagraph personal;
    for (auto value : soul->personality.values) {
        if (!value)
            continue;
        std::string phrase = pronoun_subject(unit) + " personally " +
            (value->strength >= 0 ? "values " : "does not care about ") + value_subject(value->type) + ".";
        personal.spans.push_back({(personal.spans.empty() ? "" : " ") + phrase,
                                  value->strength >= 0 ? "personal-positive" : "personal-negative"});
    }
    for (auto dream : soul->personality.dreams) {
        if (!dream || !dream->flags.bits.accomplished)
            continue;
        const auto& attrs = df::enum_traits<df::goal_type>::attrs(dream->type);
        std::string dream_text = attrs.short_name ? attrs.short_name : "achieve a personal goal";
        personal.spans.push_back({(personal.spans.empty() ? "" : " ") + pronoun_subject(unit) +
            " had a dream to " + dream_text + ", and this dream was realized.", "dream"});
    }
    if (!personal.spans.empty())
        paragraphs.push_back(std::move(personal));
    if (paragraphs.empty())
        paragraphs.push_back({{{"No values recorded.", "neutral"}}});
    return paragraphs;
}

std::string unit_preference_name(df::unit_preference* pref) {
    if (!pref)
        return "";
    using namespace df::enums::unitpref_type;
    switch (pref->type) {
    case LikeMaterial:
    case LikeFood: {
        MaterialInfo material(pref->mattype, pref->matindex);
        auto name = material.toString();
        if (pref->type == LikeFood) {
            ItemTypeInfo item(static_cast<df::item_type>(pref->item_type), pref->item_subtype);
            auto item_name = item.toString();
            if (!item_name.empty() && name.find(item_name) == std::string::npos)
                name += (name.empty() ? "" : " ") + item_name;
        }
        return lower_first(name);
    }
    case LikeCreature:
    case HateCreature:
        if (auto creature = df::creature_raw::find(pref->creature_id))
            return lower_first(creature->name[1].empty() ? creature->name[0] : creature->name[1]);
        break;
    case LikeItem:
        return lower_first(ItemTypeInfo(static_cast<df::item_type>(pref->item_type),
                                        pref->item_subtype).toString());
    case LikePlant:
    case LikeTree:
        if (auto plant = df::plant_raw::find(pref->plant_id))
            return lower_first(plant->name_plural.empty() ? plant->name : plant->name_plural);
        break;
    case LikeColor:
        if (auto color = df::descriptor_color::find(pref->color_id))
            return lower_first(color->name);
        break;
    case LikeShape:
        if (auto shape = df::descriptor_shape::find(pref->shape_id))
            return lower_first(shape->name_plural.empty() ? shape->name : shape->name_plural);
        break;
    case LikePoeticForm:
        if (auto form = df::poetic_form::find(pref->poetic_form_id))
            return knowledge_form_name(form->name, "Poetic form", form->id);
        break;
    case LikeMusicalForm:
        if (auto form = df::musical_form::find(pref->musical_form_id))
            return knowledge_form_name(form->name, "Musical form", form->id);
        break;
    case LikeDanceForm:
        if (auto form = df::dance_form::find(pref->dance_form_id))
            return knowledge_form_name(form->name, "Dance form", form->id);
        break;
    default:
        break;
    }
    return "";
}

std::vector<UnitTextParagraph> unit_personality_preference_narrative(df::unit* unit) {
    std::vector<UnitTextParagraph> paragraphs;
    auto soul = unit->status.current_soul;
    if (!soul)
        return paragraphs;
    std::vector<std::string> likes;
    std::vector<std::string> hates;
    for (auto pref : soul->preferences) {
        auto name = unit_preference_name(pref);
        if (name.empty())
            continue;
        if (pref->type == df::unitpref_type::HateCreature)
            hates.push_back(name);
        else
            likes.push_back(name);
    }
    UnitTextParagraph paragraph;
    std::string name = Translation::translateName(Units::getVisibleName(unit), true);
    if (name.empty())
        name = pronoun_subject(unit);
    if (!likes.empty())
        paragraph.spans.push_back({name + " likes " + join_phrases(likes) + ".", "neutral"});
    if (!hates.empty())
        paragraph.spans.push_back({(paragraph.spans.empty() ? "" : " ") + pronoun_subject(unit) +
            " absolutely detests " + join_phrases(hates) + ".", "negative"});
    if (paragraph.spans.empty())
        paragraph.spans.push_back({"No preferences recorded.", "neutral"});
    paragraphs.push_back(std::move(paragraph));
    return paragraphs;
}

std::string need_band(int32_t focus) {
    if (focus >= 300) return "unfettered";
    if (focus >= 200) return "level-headed";
    if (focus >= 100) return "untroubled";
    if (focus >= -999) return "not-distracted";
    if (focus >= -9999) return "unfocused";
    if (focus >= -99999) return "distracted";
    return "badly-distracted";
}

std::string need_clause(df::need_type type, const std::string& target) {
    using namespace df::enums::need_type;
    switch (type) {
    case Socialize: return "being away from people";
    case DrinkAlcohol: return "being kept from alcohol";
    case PrayOrMeditate: return target.empty() ? "being unable to pray" : "being unable to pray to " + target;
    case StayOccupied: return "staying occupied";
    case BeCreative: return "doing nothing creative";
    case Excitement: return "a lack of excitement";
    case LearnSomething: return "not learning anything";
    case BeWithFamily: return "being away from family";
    case BeWithFriends: return "being away from friends";
    case HearEloquence: return "not hearing eloquent speech";
    case UpholdTradition: return "being unable to uphold tradition";
    case SelfExamination: return "a lack of self-examination";
    case MakeMerry: return "being unable to make merry";
    case CraftObject: return "being unable to practice a craft";
    case MartialTraining: return "being unable to practice a martial art";
    case PracticeSkill: return "being unable to practice a skill";
    case TakeItEasy: return "being unable to take it easy";
    case MakeRomance: return "being unable to pursue romance";
    case SeeAnimal: return "being away from animals";
    case SeeGreatBeast: return "being unable to see a great beast";
    case AcquireObject: return "being unable to acquire something";
    case EatGoodMeal: return "a lack of decent meals";
    case Fight: return "being unable to fight";
    case CauseTrouble: return "a lack of trouble-making";
    case Argue: return "being unable to argue";
    case BeExtravagant: return "being unable to be extravagant";
    case Wander: return "being unable to wander";
    case HelpSomebody: return "being unable to help anybody";
    case ThinkAbstractly: return "a lack of abstract thinking";
    case AdmireArt: return "being unable to admire art";
    default: return "an unmet need";
    }
}

std::string need_band_text(const std::string& band) {
    if (band == "not-distracted") return "not distracted";
    if (band == "badly-distracted") return "badly distracted";
    return band;
}

std::string need_band_role(const std::string& band) {
    if (band == "unfettered" || band == "level-headed" || band == "untroubled")
        return "positive";
    if (band == "unfocused") return "warning";
    if (band == "distracted") return "attention";
    if (band == "badly-distracted") return "negative";
    return "neutral";
}

// DF's OWN need-focus band color, from live-probe of the needs sub-tab's [C:fg:bg:bright] tokens
// (text-color spec §2.7 + §5 second probe -- band derived from personality_needst.focus_level,
// df.personality.xml:1411). Only the FOUR bands the probe actually captured are pinned; the other
// three (level-headed, untroubled, badly-distracted) were never observed on a live sheet, so they
// return -1 and the client themes them by role instead of an invented hue -- pending the §4 sheet
// harvest. Do NOT guess a gradient for the missing bands.
int need_band_native_color(const std::string& band) {
    if (band == "unfettered")     return 10;  // bright green  (spec §2.7: "unfettered" 10)
    if (band == "not-distracted") return 7;   // white/lgray   (spec §2.7: "not distracted" 7)
    if (band == "unfocused")      return 6;   // brown         (spec §2.7: "unfocused" 6)
    if (band == "distracted")     return 14;  // yellow (6+br) (spec §2.7: "distracted" 6+bright=14)
    return -1;                                // level-headed / untroubled / badly-distracted: unpinned
}

std::vector<UnitNeedRecord> unit_need_records(df::unit* unit, std::string& focus_summary) {
    std::vector<UnitNeedRecord> records;
    auto soul = unit->status.current_soul;
    if (!soul)
        return records;
    int32_t average_focus = soul->personality.needs.empty() ? soul->personality.current_focus :
        soul->personality.current_focus / static_cast<int32_t>(soul->personality.needs.size());
    auto overall_band = need_band(average_focus);
    focus_summary = "Overall, " + pronoun_subject_lower(unit) + " is " +
        need_band_text(overall_band) + " by unmet needs.";
    for (auto need : soul->personality.needs) {
        if (!need)
            continue;
        UnitNeedRecord record;
        record.type = DFHack::enum_item_key(need->id);
        record.level = need->need_level;
        record.focus = need->focus_level;
        record.satisfaction_band = need_band(need->focus_level);
        record.target_hf_id = need->deity_id;
        record.target_name = historical_figure_name_or_blank(need->deity_id);
        auto clause = need_clause(need->id, record.target_name);
        record.spans.push_back({pronoun_subject(unit) + " is ", "neutral"});
        // The band word carries DF's OWN color index (text-color spec §2.7); role stays for
        // theming, color is authoritative for hue. -1 for the unpinned bands (see
        // need_band_native_color) so the client does not invent one. These spans are shared by both
        // the top-level `needs` payload and personalityNarrative.needs, so both surfaces color.
        record.spans.push_back({need_band_text(record.satisfaction_band),
                                need_band_role(record.satisfaction_band),
                                need_band_native_color(record.satisfaction_band)});
        record.spans.push_back({" after " + clause + ".", "neutral"});
        record.order = static_cast<int32_t>(records.size());
        records.push_back(std::move(record));
    }
    return records;
}

std::vector<UnitTextParagraph> unit_personality_need_narrative(
        const std::string& summary, const std::vector<UnitNeedRecord>& needs) {
    std::vector<UnitTextParagraph> paragraphs;
    if (!summary.empty())
        paragraphs.push_back({{{summary, "warning"}}});
    for (const auto& need : needs)
        paragraphs.push_back({need.spans});
    if (paragraphs.empty())
        paragraphs.push_back({{{"No needs recorded.", "neutral"}}});
    return paragraphs;
}

UnitSheet build_unit_sheet(df::unit* unit) {
    UnitSheet sheet;
    if (!unit)
        return sheet;

    sheet.present = true;
    sheet.id = unit->id;
    sheet.portrait_texpos = unit->portrait_texpos;
    sheet.sheet_icon_texpos = unit->sheet_icon_texpos;
    sheet.age_class = unit_age_class(unit);
    sheet.portrait_state = unit->portrait_texpos > 0 ? "ready" :
        (unit->portrait_texpos == 0 ? "pending" : "unavailable");
    sheet.portrait_kind = unit->portrait_texpos >= 0 ? "native" : "none";
    // Raw tokens are stable portrait-map keys. Keep the bounds checks identical to info_panel.cpp.
    if (auto world = df::global::world) {
        if (unit->race >= 0 && static_cast<size_t>(unit->race) < world->raws.creatures.all.size()) {
            if (auto cr = world->raws.creatures.all[unit->race]) {
                sheet.race_token = cr->creature_id;
                if (unit->caste >= 0 && static_cast<size_t>(unit->caste) < cr->caste.size()) {
                    if (auto caste = cr->caste[unit->caste])
                        sheet.caste_token = caste->caste_id;
                }
            }
        }
    }
    // WD-24: DF's unit sheet shows name+title and the quoted nickname as two SEPARATE header
    // lines (26-unit-sheet.png: "Rigoth Oslanan, expedition leader" / "\"Rigoth Windyawn\"").
    // dfhack's getReadableName(unit) mashes both into one string ('native "nickname", prof');
    // skip_english=true gives us line 1 without the nickname, and Translation::translateName's
    // english-name form (same call formatReadableName uses internally) gives us the nickname
    // alone -- empty when the unit has never been nicknamed, matching the capture's behavior.
    sheet.name = Units::getReadableName(unit, true);
    if (sheet.name.empty())
        sheet.name = Units::getRaceReadableName(unit);
    if (auto* visible_name = Units::getVisibleName(unit))
        sheet.nickname = Translation::translateName(visible_name, true, true);
    sheet.race = Units::getRaceReadableName(unit);
    sheet.profession = Units::getProfessionName(unit);
    sheet.profession_color = Units::getProfessionColor(unit);
    // Build the world fallback once for this single-unit serialization pass. The resolver checks
    // the job and four unit-side activity channels before consulting this O(1) lookup.
    WorldActivityIndex world_activities;
    sheet.current_job = unit_current_job_label(unit, world_activities);
    sheet.age = unit_age_label(unit);
    sheet.sex = unit_sex_label(unit);
    sheet.status_lines = unit_condition_lines(unit);
    sheet.status = sheet.status_lines.empty() ? "Healthy" : sheet.status_lines.front();
    sheet.training = unit_training_label(unit);
    sheet.body_summary = unit->body.wounds.empty() ? "No health problems" :
        std::to_string(unit->body.wounds.size()) + (unit->body.wounds.size() == 1 ? " wound" : " wounds");
    sheet.inventory_lines = unit_inventory_lines(unit);
    sheet.inventory = unit_inventory(unit);
    sheet.health_lines = unit_health_lines(unit, sheet.status_lines);
    sheet.health_status_lines = sheet.health_lines;
    sheet.health_wound_lines = unit_health_wound_lines(unit);
    sheet.health_treatment_lines = unit_health_treatment_lines(unit);
    sheet.health_history_lines = unit_health_history_lines(unit);
    sheet.health_description_lines = unit_health_description_lines(unit);
    sheet.skill_lines = unit_skill_lines(unit);
    sheet.skills = unit_skill_records(unit);
    sheet.knowledge = unit_knowledge_records(unit);
    sheet.room_lines = unit_room_lines(unit);
    sheet.room_assignment_lines = sheet.room_lines;
    sheet.rooms = unit_rooms(unit);
    sheet.labor_lines = unit_labor_lines(unit);
    sheet.labor_work_detail_lines = unit_labor_work_detail_lines(unit);
    sheet.labor_workshop_lines = unit_labor_workshop_lines(unit);
    sheet.labor_location_lines = unit_labor_location_lines(unit);
    sheet.labor_work_animals = unit_labor_work_animals(unit);
    sheet.labor_work_animal_lines = unit_labor_work_animal_lines(sheet.labor_work_animals);
    sheet.relation_lines = unit_relation_lines(unit);
    sheet.group_lines = unit_group_lines(unit);
    sheet.relations = unit_relations(unit);
    sheet.groups = unit_groups(unit);
    sheet.military_lines = unit_military_lines(unit);
    sheet.military_squad_lines = sheet.military_lines;
    sheet.military_uniform_lines = unit_military_uniform_lines(unit);
    sheet.military_kill_lines = unit_military_kill_lines(unit);
    sheet.thought_lines = unit_thought_lines(unit);
    sheet.recent_thoughts = unit_recent_thought_records(unit);
    sheet.memories = unit_memory_records(unit);
    sheet.personality_trait_lines = unit_personality_trait_lines(unit);
    sheet.personality_value_lines = unit_personality_value_lines(unit);
    sheet.personality_preference_lines = unit_personality_preference_lines(unit);
    sheet.personality_need_lines = unit_personality_need_lines(unit);
    sheet.personality_lines = sheet.personality_trait_lines;
    sheet.personality_traits = unit_personality_trait_narrative(unit);
    sheet.personality_values = unit_personality_value_narrative(unit);
    sheet.personality_preferences = unit_personality_preference_narrative(unit);
    sheet.needs = unit_need_records(unit, sheet.personality_focus_summary);
    sheet.personality_needs = unit_personality_need_narrative(
        sheet.personality_focus_summary, sheet.needs);
    sheet.overview_relation_lines = unit_overview_relation_lines(unit);
    sheet.overview_trait_lines = unit_overview_trait_lines(unit, sheet.status_lines);
    sheet.overview_position_lines = unit_overview_position_lines(unit);
    sheet.overview_squad_lines = unit_overview_squad_lines(unit);
    sheet.overview_skill_lines = unit_overview_skill_lines(sheet.skill_lines);
    sheet.overview_need_lines = unit_overview_need_lines(unit);
    sheet.overview_memory_lines = sheet.thought_lines;

    if (Units::isCitizen(unit))
        sheet.flags.push_back("Citizen");
    if (Units::isTame(unit))
        sheet.flags.push_back("Tame");
    if (Units::isPet(unit))
        sheet.flags.push_back("Pet");
    if (Units::isAvailableForAdoption(unit))
        sheet.flags.push_back("Available for adoption");
    if (Units::isMarkedForSlaughter(unit))
        sheet.flags.push_back("Marked for slaughter");
    if (Units::isMarkedForGelding(unit))
        sheet.flags.push_back("Marked for gelding");

    auto training = find_training_assignment(unit);
    bool has_trainer = training && training->trainer_id != -1;
    sheet.actions.push_back({"Ctrl+b", "Butcher", yes_no(Units::isMarkedForSlaughter(unit)), true});
    sheet.actions.push_back({"Ctrl+g", "Geld", yes_no(Units::isMarkedForGelding(unit)), Units::isGeldable(unit)});
    sheet.actions.push_back({"Ctrl+a", "Adopt", yes_no(Units::isAvailableForAdoption(unit)), Units::isTame(unit)});
    sheet.actions.push_back({"Ctrl+t", "Has Trainer", yes_no(has_trainer), Units::isMarkedForTraining(unit)});
    return sheet;
}

std::string unit_sheet_json(const std::string& player,
                            const UnitSheet& unit,
                            const Camera& tile,
                            bool following) {
    std::ostringstream body;
    body << "{"
         << "\"player\":" << json_string(player) << ","
         << "\"kind\":\"unit\","
         << "\"title\":" << json_string(unit.name) << ","
         << "\"tile\":{\"x\":" << tile.x << ",\"y\":" << tile.y << ",\"z\":" << tile.z << "},"
         // W2: is THIS player's camera following this unit (client_state.h FollowTarget)? Drives
         // UNIT_SHEET_CAMERA_ACTIVE, the green camera tile, which could never light before.
         << "\"following\":" << (following ? "true" : "false") << ","
         << "\"wireBatch\":" << json_string(kWireBatchMarker) << ","
         << "\"unit\":";
    append_unit_sheet_json(body, unit);
    body << "}\n";
    return body.str();
}

bool unit_sheet_on_render_thread(int32_t unit_id,
                                 UnitSheet& unit,
                                 Camera& tile,
                                 std::string* err) {
    std::lock_guard<std::recursive_mutex> lock(g_unit_sheet_mutex);

    auto request = std::make_shared<RenderThreadUnitRequest>();
    request->unit_id = unit_id;
    auto future = request->done.get_future();

    DFHack::runOnRenderThread([request]() {
        try {
            auto found = df::unit::find(request->unit_id);
            if (!found) {
                request->err = "unit not found";
                request->done.set_value(false);
                return;
            }
            request->unit = build_unit_sheet(found);
            request->tile = Camera{found->pos.x, found->pos.y, found->pos.z};
            request->done.set_value(request->unit.present);
        } catch (const std::exception& ex) {
            request->err = ex.what();
            request->done.set_value(false);
        } catch (...) {
            request->err = "unknown unit sheet error";
            request->done.set_value(false);
        }
    });

    bool ok = future.get();
    if (!ok) {
        if (err) *err = request->err.empty() ? "unit sheet failed" : request->err;
        return false;
    }
    unit = std::move(request->unit);
    tile = request->tile;
    return true;
}

// ---------------------------------------------------------------------------------------------
// HTTP routes, extracted from http_server.cpp's register_routes():
// that function had grown to ~2,750 lines / ~150 inline registrations and was the repo's #1
// merge-conflict site (49 of the last 200 commits). This finishes the register_*_routes() split
// the other 18 modules already used. Handler bodies are unchanged; route behavior is identical.
void register_unit_routes(httplib::Server& server) {
    // WD-22: Tasks tab cancel button (14-info-tasks.png) -- POST /task-cancel?job=<jobId>.
    auto task_cancel_handler = [](const httplib::Request& req, httplib::Response& res) {
        int job_id = -1;
        if (!query_int(req, "job", job_id)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing job\"}\n", "application/json; charset=utf-8");
            return;
        }
        std::string err;
        if (!cancel_job_on_render_thread(job_id, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n", "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true}\n", "application/json; charset=utf-8");
    };
    server.Get("/task-cancel", task_cancel_handler);
    server.Post("/task-cancel", task_cancel_handler);

    // B16: Pets/Livestock action buttons -- POST /livestock-action?unit=<id>&action=<slaughter|
    // war|hunt|pet>. Toggles DF's own flag/designation for the animal and returns the new state so
    // the client can flip the button without a full panel re-fetch.
    auto livestock_action_handler = [](const httplib::Request& req, httplib::Response& res) {
        int unit_id = -1;
        if (!query_int(req, "unit", unit_id)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing unit\"}\n", "application/json; charset=utf-8");
            return;
        }
        std::string action = req.has_param("action") ? req.get_param_value("action") : "";
        // B33: optional trainer unit id for "assign-trainer" (-1/absent => any available trainer).
        int trainer_id = -1;
        query_int(req, "trainer", trainer_id);
        // B233-2: optional owner unit id for "assign-work-animal" (-1/absent => clear the
        // work-animal assignment, i.e. native's "Remove assignment").
        int owner_id = -1;
        query_int(req, "owner", owner_id);
        LivestockState state;
        std::string err;
        if (!livestock_action_on_render_thread(unit_id, action, state, &err, trainer_id, owner_id)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n", "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content(livestock_state_json(unit_id, state), "application/json; charset=utf-8");
    };
    server.Get("/livestock-action", livestock_action_handler);
    server.Post("/livestock-action", livestock_action_handler);

    // B7: Native-style unit nickname editing. The render-thread helper validates the unit id
    // before writing only df::unit::name.nickname; an empty nickname intentionally clears it.
    auto unit_nickname_handler = [](const httplib::Request& req, httplib::Response& res) {
        int unit_id = -1;
        if (!query_int(req, "unit", unit_id) || !req.has_param("nickname")) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing unit/nickname\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        std::string stored;
        std::string err;
        if (!set_unit_nickname_on_render_thread(unit_id, req.get_param_value("nickname"), stored, &err)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }
        notify_player_input();
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\":true,\"unitId\":" + std::to_string(unit_id) +
                        ",\"nickname\":" + json_string(stored) + "}\n",
                        "application/json; charset=utf-8");
    };
    server.Post("/unit-nickname", unit_nickname_handler);

    server.Get("/unit", [](const httplib::Request& req, httplib::Response& res) {
        std::string player = query_player(req);
        int unit_id = -1;
        if (!query_int(req, "id", unit_id)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"missing id\"}\n",
                            "application/json; charset=utf-8");
            return;
        }

        UnitSheet unit;
        Camera tile;
        std::string err;
        if (!unit_sheet_on_render_thread(unit_id, unit, tile, &err)) {
            res.status = 404;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(unit_sheet_json(player, unit, tile,
                                        player_is_following(player, "unit", unit_id)),
                        "application/json; charset=utf-8");
    });

    server.Get("/unit-portrait", [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        int unit_id = -1;
        if (!query_int(req, "id", unit_id)) {
            res.status = 400;
            res.set_content("missing id\n", "text/plain; charset=utf-8");
            return;
        }

        CapturedFrame frame;
        int32_t texpos = -1;
        std::string source;
        std::string err;
        bool icon_mode = req.has_param("mode") && req.get_param_value("mode") == "icon";
        bool generate = req.has_param("generate") &&
            (req.get_param_value("generate") == "1" ||
             req.get_param_value("generate") == "true" ||
             req.get_param_value("generate") == "yes");
        if (!unit_portrait_on_render_thread(unit_id, icon_mode, generate,
                                            frame, texpos, source, &err)) {
            res.status = 404;
            res.set_content("portrait failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        std::vector<uint8_t> png;
        if (!encode_png(frame, png, &err)) {
            res.status = 503;
            res.set_content("portrait encode failed: " + err + "\n", "text/plain; charset=utf-8");
            return;
        }

        res.set_header("X-Dwf-Texpos", std::to_string(texpos));
        res.set_header("X-Dwf-Portrait-Source", source);
        res.set_content(reinterpret_cast<const char*>(png.data()), png.size(), "image/png");
    });

    // WE-2: per-unit composite export service (spec:
    // docs/superpowers/specs/2026-07-07-WE-dwarf-compositing-spec.md). DF composites every
    // layered unit into its own runtime texpos cells; this route serves those SAME pixels,
    // copied verbatim off the render thread and cached content-addressed by their hash --
    // never touches DF state at serve time. Registering the route also lazily starts the
    // background export worker (inert until `capture-unit-sprites on`, see unit_sprites.cpp).
    //
    // GET /unit-sprite/<16-hex>.png -> cache lookup ONLY; 404 if the hash was never produced
    // or has since been evicted (client falls back / refetches on the next hash sighting).
    // The path regex itself enforces the hygiene rule (exactly 16 lowercase hex + ".png";
    // same discipline as /sprites/img/) -- anything else simply doesn't match this route.
    unit_sprite_export_ensure_started();
    server.Get(R"(/unit-sprite/([0-9a-f]{16})\.png)", [](const httplib::Request& req, httplib::Response& res) {
        std::string hash = req.matches.size() > 1 ? req.matches[1].str() : std::string();
        std::vector<uint8_t> png;
        if (!unit_sprite_cache_get(hash, png)) {
            res.status = 404;
            res.set_content("not found\n", "text/plain; charset=utf-8");
            return;
        }
        // Content-addressed: this hash's bytes never change -> safe to cache forever.
        res.set_header("Cache-Control", "public, max-age=31536000, immutable");
        res.set_content(reinterpret_cast<const char*>(png.data()), png.size(), "image/png");
    });

    // GET /unit-sprite (no hash segment) -> JSON snapshot of unit_id -> {hash,sw,sh,ax,ay} +
    // exporter stats. This item's manual oracle-parity/QA surface (WE-3 will additionally put
    // the same fields on the live AUX wire; WE-8 formalizes the shipping gate against it).
    server.Get("/unit-sprite", [](const httplib::Request&, httplib::Response& res) {
        auto snap = unit_sprite_snapshot();
        auto stats = unit_sprite_export_stats();
        std::ostringstream out;
        out << "{\"ok\":true,\"exportEnabled\":" << (unit_sprite_export_enabled() ? "true" : "false")
            << ",\"units\":{";
        bool first = true;
        for (const auto& kv : snap) {
            if (!first) out << ",";
            first = false;
            out << "\"" << kv.first << "\":{\"ah\":\"" << kv.second.hash << "\""
                << ",\"sw\":" << kv.second.sw << ",\"sh\":" << kv.second.sh
                << ",\"ax\":" << kv.second.ax << ",\"ay\":" << kv.second.ay << "}";
        }
        out << "},\"stats\":{"
            << "\"exportsAttempted\":" << stats.exports_attempted
            << ",\"exportsSucceeded\":" << stats.exports_succeeded
            << ",\"exportsSkippedBlank\":" << stats.exports_skipped_blank
            << ",\"hashesNew\":" << stats.hashes_new
            << ",\"hashesReused\":" << stats.hashes_reused
            << ",\"cacheEvictions\":" << stats.cache_evictions
            << ",\"cacheSize\":" << stats.cache_size
            << ",\"recordsTracked\":" << stats.records_tracked
            << ",\"lastBatchUnits\":" << stats.last_batch_units
            << ",\"lastRenderHopMs\":" << stats.last_render_hop_ms
            << "}}";
        res.set_header("Cache-Control", "no-store");
        res.set_content(out.str(), "application/json; charset=utf-8");
    });
}

} // namespace dwf
