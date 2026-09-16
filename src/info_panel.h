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
#include <string>
#include <utility>
#include <vector>

namespace df { struct building; struct unit; }

namespace dwf {

struct InfoTab {
    std::string id;
    std::string label;
};

struct InfoRow {
    int32_t unit_id = -1;
    int32_t item_id = -1;
    int32_t portrait_texpos = -1;
    int32_t building_id = -1;
    int32_t location_id = -1;
    int32_t x = 0;
    int32_t y = 0;
    int32_t z = 0;
    bool has_pos = false;
    std::string name;
    std::string subtitle;
    std::string category;
    std::string profession;
    // DF's own 4-bit profession colour; -1 = none, and the client must leave the name uncoloured.
    int8_t profession_color = -1;
    std::string job;
    std::string status;
    std::string kind;
    std::string icon_key;
    std::string icon_sheet;
    int32_t icon_x = -1;
    int32_t icon_y = -1;
    int32_t icon_row = -1;
    // raw creature/caste tokens; the client crops the species cell from creatures_map.json by these.
    std::string race_token;
    std::string caste_token;
    std::vector<std::string> badges;
    bool muted = false;
    // mood face bucket 0..6 (the same bucket as the top bar's HudState::happiness); -1 = unknown.
    int32_t mood_category = -1;
    std::string held_item;
    int32_t held_item_id = -1;
    // df::job id for rows that represent a real job; -1 otherwise, activity-only rows included
    // (/task-cancel cannot cancel an activity).
    int32_t job_id = -1;
    int8_t job_color = -1;
    bool job_need_driven = false;
    int32_t job_building_id = -1;
    bool job_has_pos = false;
    int32_t job_x = 0;
    int32_t job_y = 0;
    int32_t job_z = 0;
    bool job_repeat = false;
    bool job_suspended = false;
    bool job_do_now = false;
    // Gates the whole job-control group out of the JSON for rows with no df::job; the client reads
    // an ABSENT key as "unknown" and suppresses the control rather than inventing one.
    bool has_job_controls = false;
    bool job_special = false;      // "cannot be aborted via the ui"
    bool job_by_manager = false;   // spawned by a work order
    bool job_dessource = false;    // created from a designation
    bool job_has_worker = false;
    bool job_has_holder = false;
    bool job_holder_finished = false;
    bool job_details_avail = false;
    // The wire must decide this: the client is never sent trap_type and cannot re-derive it.
    bool job_holder_production = false;
    bool job_cancel_avail = false;
    // `contained` rides every unit row; `containerPos` is emitted only when the CONTAINED_IN_ITEM
    // ref resolved to a real tile, and the client omits both recenter buttons when it is absent.
    bool contained = false;
    bool container_has_pos = false;
    int32_t container_x = 0;
    int32_t container_y = 0;
    int32_t container_z = 0;
    bool tasks_row = false;
    bool livestock = false;
    bool ls_slaughter = false;
    bool ls_war = false;
    bool ls_hunt = false;
    bool ls_trainable_war = false;
    bool ls_trainable_hunt = false;
    bool ls_pet = false;
    bool ls_adoption = false;
    bool ls_tamable = false;
    bool ls_training = false;
    bool ls_taming = false;
    // trainer unit id, or a negative wildcard code (kTrainerAny / kTrainerAnyUnassigned).
    int32_t ls_trainer_id = -1;
    bool ls_geld = false;
    bool ls_geldable = false;
    // ls_status_exact = false when the caption was reconstructed from DFHack's pet/adoption
    // predicates instead of native's own gate; the client renders that as a hedged tooltip.
    std::string ls_status;
    int ls_status_color = -1;      // DF colour index 0..15; -1 = absent
    bool ls_status_bright = false;
    bool ls_status_exact = false;
    // Gates `specialized` + `workDetails` out of the JSON for units the labor system does not
    // apply to; the client reads an ABSENT key as "unknown" and renders no padlock at all.
    bool has_labor_columns = false;
    bool specialized = false;
    std::vector<std::pair<std::string, std::string>> work_details;  // (name, icon enum key)
};

struct LivestockState {
    bool ok = false;
    bool slaughter = false;
    bool war = false;
    bool hunt = false;
    bool trainable_war = false;
    bool trainable_hunt = false;
    bool pet = false;
    bool adoption = false;
    bool tamable = false;
    bool training = false;
    bool taming = false;
    int32_t trainer_id = -1;
    bool geld = false;
    bool geldable = false;
    // unit.relationship_ids[PetOwner] after the action; -1 = unassigned.
    int32_t work_animal_owner = -1;
    std::string err;
};

struct TaskJobActionResult {
    bool has_pos = false;
    int32_t x = 0;
    int32_t y = 0;
    int32_t z = 0;
    bool repeat = false;
    bool suspended = false;
    bool has_worker = false;
};

struct StockItemRow {
    int32_t item_id = -1;
    int32_t count = 1;
    std::string item_type;
    int32_t item_subtype = -1;
    int32_t material_type = -1;
    int32_t material_index = -1;
    std::string name;
    std::string subtitle;
    std::string status;
    bool muted = false;
    int32_t quality = 0;
    int32_t wear = 0;
    bool artifact = false;
};

struct InfoPanel {
    std::string panel;
    std::string section;
    std::string detail;
    std::string title;
    std::vector<InfoTab> primary_tabs;
    std::vector<InfoTab> section_tabs;
    std::vector<InfoTab> detail_tabs;
    std::vector<std::string> messages;
    std::vector<std::string> side_items;
    std::vector<InfoRow> rows;
    std::vector<StockItemRow> stock_items;
    // {unit id, display name}
    std::vector<std::pair<int32_t, std::string>> trainers;
    struct TrainingKnowledgeRow {
        std::string race;   // the creature's display name
        int level = 0;      // df::training_knowledge_level
        std::string label;  // the ladder caption for that level
        int color = -1;     // DF colour index for that level
    };
    std::vector<TrainingKnowledgeRow> training_knowledge;
    std::string footer;
};

InfoPanel build_info_panel(const std::string& panel,
                           const std::string& section,
                           const std::string& detail,
                           const std::string& search = "");

std::string info_panel_json(const InfoPanel& panel);

// Maps a building to its building_icons.png cell name; "" = no cell for this building type.
std::string building_icon_key(df::building* building);

bool info_panel_on_render_thread(const std::string& panel_name,
                                 const std::string& section,
                                 const std::string& detail,
                                 InfoPanel& panel,
                                 std::string* err = nullptr,
                                 const std::string& search = "");

bool cancel_job_on_render_thread(int32_t job_id, std::string* err = nullptr);

// `action` is one of recenter | removeWorker | suspend | repeat (the last two are toggles).
bool task_job_action_on_render_thread(int32_t job_id, const std::string& action,
                                      TaskJobActionResult& out, std::string* err = nullptr);

// `action` is one of slaughter | war | hunt | pet | geld | assign-trainer | unassign-trainer |
// assign-work-animal; `trainer_id` is read only by assign-trainer, `owner_id` only by the last.
bool livestock_action_on_render_thread(int32_t unit_id, const std::string& action,
                                       LivestockState& out, std::string* err = nullptr,
                                       int32_t trainer_id = -1, int32_t owner_id = -1);
std::string livestock_state_json(int32_t unit_id, const LivestockState& s);

// "" when the animal may be assigned as a work animal, else a player-facing reason. Both the
// unit_sheet read and set_work_animal_owner call it, so the UI cannot offer a refused button.
std::string work_animal_blocked_reason(df::unit* animal);

// An empty nickname clears it; `stored_nickname` receives the value DF ended up holding.
bool set_unit_nickname_on_render_thread(int32_t unit_id, const std::string& nickname,
                                        std::string& stored_nickname, std::string* err = nullptr);

void register_info_panel_routes(httplib::Server& server);

} // namespace dwf
