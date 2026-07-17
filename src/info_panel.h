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
    // DF's own 4-bit profession colour for unit-name rows. -1 for non-unit rows or when DF has
    // no profession colour. The browser must leave those names uncoloured instead of guessing.
    int8_t profession_color = -1;
    std::string job;
    std::string status;
    std::string kind;
    std::string icon_key;
    std::string icon_sheet;
    int32_t icon_x = -1;
    int32_t icon_y = -1;
    int32_t icon_row = -1;
    // B51: raw creature/caste tokens (world->raws.creatures) for creature rows -- the client crops
    // the animal's species cell from creatures_map.json by these (same rt/ct tile_map_dump emits
    // per on-screen unit). Empty for non-unit rows / when the race can't be resolved.
    std::string race_token;
    std::string caste_token;
    std::vector<std::string> badges;
    bool muted = false;
    // WD-17 (Creatures tab parity): per-unit mood face (0..6, same bucket as the top bar's
    // HudState::happiness -- see Units::getStressCategory) and a "held item" glyph (the item
    // currently wielded/hauled, real data, empty if none) -- both absent from the payload before
    // this item (job/name/profession already existed and are reused as-is).
    int32_t mood_category = -1;
    std::string held_item;
    int32_t held_item_id = -1;
    // WD-22 (Tasks tab parity): the job this row represents, so the client can render DF's
    // cancel button (14-info-tasks.png) -- -1 for rows that aren't job rows (Places/Objects/
    // Creatures reuse the same InfoRow shape). Residents also carry it when their current task is
    // a real df::job; the native workshop cluster's remove tile reuses /task-cancel. Activity-only
    // rows leave it -1 because that route cannot cancel activities.
    int32_t job_id = -1;
    // B296 Residents CUR_JOB/ACTIVITY_DETAILS columns. DF's widget exposes no job-text color byte;
    // job_color comes from the task source bucket pinned by the 2026-07-15 native A/B oracle.
    // job_need_driven is real DF state (Units::hasUnbailableSocialActivity), not punctuation parsed
    // by the browser. Workshop jobs also expose the existing workshop mutation state/path; other
    // current jobs stay control-free until their native ACTIVITY_DETAILS path exists. Stockpile
    // hauling jobs additionally carry the center of their holder building: DF's own hover contract
    // calls this control "recenter on the task's building" (INFO_RECENTER_ON_JOB_BUILDING).
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
    // B16 (Pets/Livestock action buttons): DF's own livestock screen exposes Slaughter, War/Hunt
    // training, and Make-available-for-adoption toggles per animal. `livestock` gates the whole
    // group (true only for live animals); the rest mirror DF's flags (marked-for-slaughter, the
    // war/hunt training assignment, adoption availability) and the caste's TRAINABLE_WAR/HUNTING
    // gates so the client only shows a training button the caste actually supports. All false for
    // non-animal rows (Residents/Tasks/Places reuse this same InfoRow shape).
    bool livestock = false;
    bool ls_slaughter = false;
    bool ls_war = false;
    bool ls_hunt = false;
    bool ls_trainable_war = false;
    bool ls_trainable_hunt = false;
    bool ls_pet = false;
    bool ls_adoption = false;
    // B33: taming / trainer-assignment state (DF's "Assign a trainer to this creature" action).
    // `ls_tamable` gates whether the assign-trainer control shows (a tameable animal not already
    // domesticated); `ls_training` = an assignment exists; `ls_taming` = a plain taming assignment
    // (no war/hunt flag); `ls_trainer_id` = the assigned trainer unit id (-1 = any trainer).
    bool ls_tamable = false;
    bool ls_training = false;
    bool ls_taming = false;
    int32_t ls_trainer_id = -1;
    // Husbandry (gelding): DF's Pets/Livestock geld toggle (Ctrl+g). `ls_geldable` gates the button
    // (the caste has the GELDABLE flag AND the animal isn't already gelded -- native hides Geld once
    // an animal has been gelded); `ls_geld` mirrors flags3.marked_for_gelding. Both false on every
    // non-animal row and on a caste that can't be gelded, so an OLD DLL that omits the JSON field
    // leaves the client with no geld button (graceful-dormant, same as the B16 group).
    bool ls_geld = false;
    bool ls_geldable = false;
    // B254 (Creatures -> Residents parity): the two columns DF's own residents list has and ours
    // never did. df-structures enumerates that list's columns exactly -- `unit_list_options` in
    // df.widgets.unit_list.xml: ... HAPPINESS, SPECIALIZED, WORK_DETAILS, ...
    //
    // `specialized` = unit.flags4.only_do_assigned_jobs (df.unit.xml:1469, UNITFLAG4_
    // ONLY_DO_ASSIGNED_JOBS): "will only do tasks that match their workshop assignments, work
    // details, and occupations" vs "will do any free tasks that become available"
    // (DF's own captions, df.d_interface.xml:3776-3781). It is the green/red padlocked hammer.
    //
    // `work_details` = every work detail in plotinfo.labor_info.work_details (df.plotinfo.xml:609)
    // whose assigned_units contains this unit, each with its `icon` (a work_detail_icon_type,
    // df.plotinfo.xml:573) rendered as the bare enum key -- "MINERS", "PLANT_GATHERERS", "NONE" --
    // matching what /labor already emits. The client maps that to DF's own WORK_DETAIL_<KEY> tile.
    // "NONE" is common and legitimate (a custom detail with no icon); DF draws nothing for it.
    //
    // Both are meaningless on non-citizen rows (Pets/Other/Dead reuse this same InfoRow shape), so
    // they stay at their defaults there, and the client only renders them on the Residents sub-tab.
    //
    // `has_labor_columns` gates BOTH KEYS OUT OF THE JSON ENTIRELY for any unit the labor system
    // does not apply to (animals, the dead, and -- the one that matters -- B215 long-term residents,
    // who DO appear on the Residents list but cannot hold a fortress labor). Emitting
    // `specialized:false` for them would read to the client as a KNOWN state and draw a live padlock
    // over a dwarf /labor-specialist will refuse. An ABSENT key is the client's "unknown" signal, and
    // it renders no control at all -- the same signal an old DLL sends. One fail-closed path, not two.
    bool has_labor_columns = false;
    bool specialized = false;
    std::vector<std::pair<std::string, std::string>> work_details;  // (name, icon enum key)
};

// B16: the current livestock action state for one animal, returned by a mutation so the client can
// flip a button's toggle state without a full panel re-fetch.
struct LivestockState {
    bool ok = false;
    bool slaughter = false;
    bool war = false;
    bool hunt = false;
    bool trainable_war = false;
    bool trainable_hunt = false;
    bool pet = false;
    bool adoption = false;
    // B33: taming / trainer-assignment state (see InfoRow::ls_* above for field meanings).
    bool tamable = false;
    bool training = false;
    bool taming = false;
    int32_t trainer_id = -1;
    // Husbandry (gelding): see InfoRow::ls_geld/ls_geldable above.
    bool geld = false;
    bool geldable = false;
    // B233-2: work-animal owner (unit.relationship_ids[PetOwner]) after the action, so the client
    // can repaint the Work-animals row without a full sheet re-fetch. -1 = unassigned.
    int32_t work_animal_owner = -1;
    std::string err;
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
    // B33: trainer-capable citizens (animal-training labor enabled), sent with the Pets/Livestock
    // panel so the client can offer a specific-dwarf choice in the "Assign a trainer" control.
    // {unit id, display name}. Empty on every other panel (and when no dwarf can train).
    std::vector<std::pair<int32_t, std::string>> trainers;
    std::string footer;
};

InfoPanel build_info_panel(const std::string& panel,
                           const std::string& section,
                           const std::string& detail,
                           const std::string& search = "");

std::string info_panel_json(const InfoPanel& panel);

// B224: the building -> building_icons.png cell-name derivation the Places rows already use,
// exported for /tile-occupants (interaction.cpp) so the occupant rail paints the same art channel.
// "" = no cell for this building type (client falls back, then fails loud).
std::string building_icon_key(df::building* building);

bool info_panel_on_render_thread(const std::string& panel_name,
                                 const std::string& section,
                                 const std::string& detail,
                                 InfoPanel& panel,
                                 std::string* err = nullptr,
                                 const std::string& search = "");

// WD-22: cancel the job (14-info-tasks.png's per-row cancel button, hotkey-equivalent to
// DFHack's Job::removeJob). Runs on the render thread like the panel builder above.
bool cancel_job_on_render_thread(int32_t job_id, std::string* err = nullptr);

// B16/B33: toggle a Pets/Livestock action on one animal (action = "slaughter" | "war" | "hunt" |
// "pet" | "geld" | "assign-trainer" | "unassign-trainer"), then report the resulting state back.
// "geld" marks/unmarks the animal for gelding (rejected 400 on a non-geldable or already-gelded
// caste, exactly as native hides the control). Runs on
// the render thread like the panel builder. `trainer_id` is only consulted by "assign-trainer"
// (-1 = any available trainer; a specific unit id restricts the assignment to that dwarf).
// B233-2: `owner_id` is only consulted by "assign-work-animal" (-1 = clear the assignment;
// a citizen's unit id = make this animal that citizen's work animal).
bool livestock_action_on_render_thread(int32_t unit_id, const std::string& action,
                                       LivestockState& out, std::string* err = nullptr,
                                       int32_t trainer_id = -1, int32_t owner_id = -1);
std::string livestock_state_json(int32_t unit_id, const LivestockState& s);

// B233-2 (WORK ANIMALS -- native Labor > Work animals / INFO_ASSIGN_WORK_ANIMAL).
// A work-animal assignment in DF is ONE field: the animal's
//   unit.relationship_ids[unit_relationship_type::PetOwner]   (df.unit.xml:1574 + :2732)
// which is what DFHack's own AssignWorkAnimal overlay counts per citizen
// (dfhack plugins/lua/sort/info.lua:458) and what Units::isPet() reads
// (dfhack library/modules/Units.cpp:534). There is NO DFHack API that WRITES it (verified: the
// whole DFHack tree only ever reads PetOwner), so this plugin writes the field itself -- under
// the guards below, which are exactly the eligibility DF's own screen shows.
//
// work_animal_blocked_reason() returns "" when the animal may be assigned, or a PLAYER-FACING
// reason why not. Both the read (unit_sheet's Work-animals list) and the write use it, so the UI
// can never offer a button the write would refuse. The HISTFIG guard is the honest one: a
// historical-figure animal also carries its ownership in the history graph
// (histfig_hf_link_pet_ownerst, df.history_figure.xml:996), and we cannot yet establish that
// link's exact shape, so we refuse rather than land a half-write. See the B233 closeout's
// live-probe list.
std::string work_animal_blocked_reason(df::unit* animal);

// B7: mirror native nickname editing for one validated unit on the render thread. Empty clears
// the nickname; callers receive the stored value for an immediate sheet refresh.
bool set_unit_nickname_on_render_thread(int32_t unit_id, const std::string& nickname,
                                        std::string& stored_nickname, std::string* err = nullptr);

// Registers this module's HTTP routes (moved verbatim from http_server.cpp's
// register_routes monolith -- B212, 2026-07-13).
void register_info_panel_routes(httplib::Server& server);

} // namespace dwf
