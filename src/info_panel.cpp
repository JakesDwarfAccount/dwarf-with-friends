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

#include "info_panel.h"
#include "render_thread_wait.h"
#include "fort_stock.h"
#include "interaction.h"
#include "unit_activity.h"

#include "MiscUtils.h"
#include "modules/Buildings.h"
#include "modules/DFSDL.h"
#include "modules/Items.h"
#include "modules/Job.h"
#include "modules/Maps.h"
#include "modules/Translation.h"
#include "modules/Units.h"
#include "modules/World.h"

#include "df/abstract_building.h"
#include "df/abstract_building_contents.h"
#include "df/abstract_building_type.h"
#include "df/occupation.h"
#include "df/artifact_claim.h"
#include "df/artifact_claim_type.h"
#include "df/artifact_record.h"
#include "df/building.h"
#include "df/building_civzonest.h"
#include "df/building_extents_type.h"
#include "df/building_farmplotst.h"
#include "df/building_furnacest.h"
#include "df/building_siegeenginest.h"
#include "df/building_squad_infost.h"
#include "df/building_stockpilest.h"
#include "df/building_trapst.h"   // B224: lever/plate/trap icon split (building_icon_key)
#include "df/building_type.h"
#include "df/building_workshopst.h"
#include "df/civzone_type.h"
#include "df/entity_position.h"
#include "df/entity_position_assignment.h"
#include "df/map_block.h"
#include "df/squad.h"
#include "df/tile_occupancy.h"
#include "df/furnace_type.h"
#include "df/gamest.h"
#include "df/global_objects.h"
#include "df/historical_figure.h"
#include "df/historical_entity.h"
#include "df/inv_item_role_type.h"
#include "df/item.h"
#include "df/item_actual.h"
#include "df/item_type.h"
#include "df/items_other_id.h"
#include "df/job.h"
#include "df/plant_raw.h"
#include "df/plotinfost.h"
#include "df/season.h"
#include "df/siegeengine_type.h"
#include "df/training_assignment.h"
#include "df/unit.h"
#include "df/unit_relationship_type.h"   // B233-2: PetOwner (the work-animal owner slot)
#include "df/unit_animal_training_info_flag.h"
#include "df/unit_inventory_item.h"
#include "df/unit_labor.h"
#include "df/work_detail.h"             // B254: plotinfo.labor_info.work_details
#include "df/work_detail_icon_type.h"   // B254: work_detail.icon
#include "df/workshop_type.h"
#include "df/world.h"
#include "df/world_data.h"
#include "df/world_site.h"
#include "df/creature_raw.h"   // B51: rt/ct tokens for creature-row species-cell portraits
#include "df/caste_raw.h"
#include "df/written_content.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <future>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

using namespace DFHack;

namespace dwf {
namespace {

std::recursive_mutex g_info_panel_mutex;

// Independent browser Info panels mirror DF's premium Info screen tab names.
// Local source references:
// - dfhack-src/library/modules/Gui.cpp: add_main_interface_focus_strings()
//   exposes the active DF Info tabs/subtabs ("Pets/Livestock", "Dead/Missing",
//   "Work Details", "Standing orders", etc.).
// - dfhack-src/library/modules/Units.cpp provides the fort-control, citizen,
//   tame animal, animal, and visitor predicates used for creature bucketing.
// - dfhack-src/plugins/lua/sort/info.lua shows how DFHack tooling maps units
//   into Info-panel subsets without relying on DF's singleton UI state.
// - dfhack-src/plugins/lua/stocks.lua and df::stocks_interfacest document the
//   native Stocks screen's type_list/storeamount/badamount model. We read those
//   values when DF has populated them, then fall back to world->items.other.IN_PLAY so the
//   browser screen remains independent of DF's singleton Stocks UI.

std::string json_escape(const std::string& raw) {
    std::ostringstream out;
    for (unsigned char c : DF2UTF(raw)) {
        switch (c) {
        case '\\': out << "\\\\"; break;
        case '"': out << "\\\""; break;
        case '\b': out << "\\b"; break;
        case '\f': out << "\\f"; break;
        case '\n': out << "\\n"; break;
        case '\r': out << "\\r"; break;
        case '\t': out << "\\t"; break;
        default:
            if (c < 0x20) {
                out << "\\u" << std::hex << std::uppercase
                    << static_cast<int>(c) << std::dec << std::nouppercase;
            } else {
                out << static_cast<char>(c);
            }
        }
    }
    return out.str();
}

std::string json_string(const std::string& raw) {
    return "\"" + json_escape(raw) + "\"";
}

void append_string_array(std::ostringstream& body, const std::vector<std::string>& values) {
    body << "[";
    for (size_t i = 0; i < values.size(); ++i) {
        if (i) body << ",";
        body << json_string(values[i]);
    }
    body << "]";
}

void append_tabs(std::ostringstream& body, const std::vector<InfoTab>& tabs) {
    body << "[";
    for (size_t i = 0; i < tabs.size(); ++i) {
        if (i) body << ",";
        body << "{\"id\":" << json_string(tabs[i].id)
             << ",\"label\":" << json_string(tabs[i].label) << "}";
    }
    body << "]";
}

std::string pretty_key(std::string key) {
    for (char& ch : key) {
        if (ch == '_')
            ch = ' ';
        else
            ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    if (!key.empty())
        key[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(key[0])));
    return key;
}

std::vector<InfoTab> primary_tabs() {
    return {
        {"nobles", "Nobles and administrators"},
        {"objects", "Objects"},
        {"justice", "Justice"},
    };
}

std::vector<InfoTab> section_tabs() {
    return {
        {"creatures", "Creatures"},
        {"tasks", "Tasks"},
        {"places", "Places"},
        {"labor", "Labor"},
        {"workorders", "Work orders"},
    };
}

std::vector<InfoTab> stocks_section_tabs() {
    return {
        {"stocks", "Stocks"},
    };
}

std::vector<InfoTab> detail_tabs_for(const std::string& section) {
    if (section == "creatures") {
        return {
            {"residents", "Residents"},
            {"pets", "Pets/Livestock"},
            {"other", "Other"},
            {"dead", "Dead/Missing"},
        };
    }
    if (section == "places") {
        return {
            {"zones", "Zones"},
            {"locations", "Locations"},
            {"stockpiles", "Stockpiles"},
            {"workshops", "Workshops"},
            {"farmplots", "Farm plots"},
            {"siege", "Siege engines"},
        };
    }
    if (section == "labor") {
        return {
            {"workdetails", "Work Details"},
            {"standing", "Standing orders"},
            {"kitchen", "Kitchen"},
            {"stone", "Stone use"},
        };
    }
    if (section == "objects") {
        return {
            {"artifacts", "Artifacts"},
            {"symbols", "Symbols"},
            {"named", "Named objects"},
            {"written", "Written content"},
        };
    }
    return {};
}

std::string default_section_for_panel(const std::string& panel) {
    if (panel == "stocks")
        return "stocks";
    if (panel == "labor")
        return "labor";
    if (panel == "locations")
        return "places";
    if (panel == "orders")
        return "tasks";
    if (panel == "workorders")
        return "workorders";
    if (panel == "nobles")
        return "nobles";
    if (panel == "objects")
        return "objects";
    if (panel == "justice")
        return "justice";
    return "creatures";
}

std::string default_detail_for_section(const std::string& section) {
    auto tabs = detail_tabs_for(section);
    return tabs.empty() ? "" : tabs.front().id;
}

UnitCurrentTask current_task(df::unit* unit, const WorldActivityIndex& world_activities) {
    auto task = unit_current_task(unit, &world_activities);
    if (task.name.empty())
        task.name = "No job";
    return task;
}

std::string unit_display_name(df::unit* unit) {
    std::string name = Units::getReadableName(unit);
    if (name.empty())
        name = Units::getRaceReadableName(unit);
    return name.empty() ? ("Unit " + std::to_string(unit->id)) : name;
}

std::string unit_list_name(df::unit* unit) {
    // Native's Residents NAME_PROF widget shows the visible native-language name, not DFHack's
    // getReadableName() convenience string (which appends the English translation in quotes and
    // the profession). Profession is served separately and composed once by the browser.
    std::string name = Translation::translateName(Units::getVisibleName(unit));
    if (name.empty())
        name = Units::getRaceReadableName(unit);
    return name.empty() ? ("Unit " + std::to_string(unit->id)) : name;
}

// B296 round 3. The resolver supplies the source bucket alongside DF's label; this mapping only
// translates that provenance to the four palette indices pixel-sampled from the native oracle.
// None includes a genuinely idle "No job" row, for which no native color evidence exists yet.
int8_t resident_job_bucket_color(UnitTaskColorBucket bucket) {
    switch (bucket) {
    case UnitTaskColorBucket::Job: return 11;      // bright cyan
    case UnitTaskColorBucket::Social: return 10;   // bright green
    case UnitTaskColorBucket::Need: return 13;     // bright magenta
    case UnitTaskColorBucket::Training: return 14; // yellow
    case UnitTaskColorBucket::None: return -1;
    }
    return -1;
}

// WD-17: the "held item" column -- the item currently wielded (weapon/shield/crutch) takes
// priority (most visually meaningful, e.g. a miner's pick), falling back to whatever the unit is
// hauling. Real inventory data (df::unit::inventory), never fabricated; empty when neither mode
// is present (most idle/no-job units).
void fill_held_item(df::unit* unit, InfoRow& row) {
    if (!unit) return;
    df::unit_inventory_item* hauled = nullptr;
    for (auto inv : unit->inventory) {
        if (!inv || !inv->item) continue;
        if (inv->mode == df::inv_item_role_type::Weapon) {
            row.held_item = item_display_name(inv->item, 0, true);
            row.held_item_id = inv->item->id;
            return;
        }
        if (!hauled && inv->mode == df::inv_item_role_type::Hauled)
            hauled = inv;
    }
    if (hauled) {
        row.held_item = item_display_name(hauled->item, 0, true);
        row.held_item_id = hauled->item->id;
    }
}

// B254: the SPECIALIZED + WORK_DETAILS columns of DF's residents list (`unit_list_options` in
// df.widgets.unit_list.xml). Both read straight off DF's own state:
//
//   * unit.flags4.only_do_assigned_jobs -- df.unit.xml:1469 (UNITFLAG4_ONLY_DO_ASSIGNED_JOBS). This
//     is the flag the green/red padlocked hammer flips, and it is the SAME bit /labor-specialist has
//     always written (labor.cpp set_labor_specialist). Nothing new is written here -- this is the
//     READ that the Creatures panel never had, which is why its toggle could not exist.
//
//   * plotinfo.labor_info.work_details -- df.plotinfo.xml:609. Each work_detail has assigned_units
//     (sorted; DF keeps it that way and labor.cpp already binary_searches it) and an `icon` of type
//     work_detail_icon_type (df.plotinfo.xml:573). Emit the bare enum key, exactly as
//     work_detail_icon_key() does for /labor, so both wires speak one vocabulary.
//
// Cheap by construction: work_details is ~10-20 entries, each assigned_units lookup is a binary
// search. This runs per unit row on a panel fetch, not per frame -- nowhere near the CoreSuspender
// trap in AGENTS.md rule 5.
// Declared below (with the other three population predicates, kept together on purpose). Work-detail
// eligibility is CITIZEN-ONLY in native DF -- a long-term resident (B215: an accepted-petition bard,
// mercenary, monster hunter) appears on the Residents list but cannot hold a fortress labor, and
// /labor-specialist refuses them by the identical test (labor.cpp is_assignable_citizen). If we
// emitted the columns for them anyway, the browser would draw a live padlock over a dwarf the game
// will not let it change -- a control that lies. Skipping them leaves the fields off the row, which
// the client reads as "unknown" and renders as NO control at all. Fail closed, both wires agreeing.
bool is_fort_citizen(df::unit* unit);

void fill_labor_columns(df::unit* unit, InfoRow& row) {
    if (!is_fort_citizen(unit)) return;   // leaves has_labor_columns false -> the keys are omitted
    row.has_labor_columns = true;
    row.specialized = unit->flags4.bits.only_do_assigned_jobs;
    auto plotinfo = df::global::plotinfo;
    if (!plotinfo) return;
    for (auto detail : plotinfo->labor_info.work_details) {
        if (!detail) continue;
        const auto& assigned = detail->assigned_units;
        if (!std::binary_search(assigned.begin(), assigned.end(), unit->id)) continue;
        int icon = static_cast<int>(detail->icon);
        std::string icon_key = df::enum_traits<df::work_detail_icon_type>::is_valid(icon)
            ? DFHack::enum_item_key(detail->icon) : std::string("NONE");
        row.work_details.emplace_back(detail->name, icon_key);
    }
}

InfoRow row_for_unit(df::unit* unit, const WorldActivityIndex& world_activities) {
    InfoRow row;
    row.unit_id = unit->id;
    row.portrait_texpos = unit->portrait_texpos;
    // B51: resolve raw creature/caste tokens so the client can crop the animal's species cell from
    // creatures_map.json for off-screen rows too (mirrors tile_map_dump's per-unit rt/ct).
    if (auto world = df::global::world) {
        if (unit->race >= 0 && (size_t)unit->race < world->raws.creatures.all.size()) {
            df::creature_raw* cr = world->raws.creatures.all[unit->race];
            if (cr) {
                row.race_token = cr->creature_id;
                if (unit->caste >= 0 && (size_t)unit->caste < cr->caste.size()) {
                    df::caste_raw* ca = cr->caste[unit->caste];
                    if (ca) row.caste_token = ca->caste_id;
                }
            }
        }
    }
    row.name = unit_list_name(unit);
    row.category = Units::getRaceReadableName(unit);
    row.profession = Units::getProfessionName(unit);
    row.profession_color = Units::getProfessionColor(unit);
    // Merge of B292-r2 (world-activity fallback index) + B296 (job colour/need/controls fields):
    // label and source bucket resolve together; color never depends on the rendered string.
    auto task = current_task(unit, world_activities);
    row.job = std::move(task.name);
    row.job_color = resident_job_bucket_color(task.color_bucket);
    row.job_need_driven = !unit->job.current_job && Units::hasUnbailableSocialActivity(unit);
    if (auto job = unit->job.current_job) {
        row.job_id = job->id;
        row.job_repeat = job->flags.bits.repeat;
        row.job_suspended = job->flags.bits.suspend;
        row.job_do_now = job->flags.bits.do_now;
        // /workshop-job-action validates that the job belongs to this workshop/furnace. Only
        // expose that route for holders it accepts.
        if (auto holder = Job::getHolder(job)) {
            if (virtual_cast<df::building_workshopst>(holder) ||
                virtual_cast<df::building_furnacest>(holder))
                row.job_building_id = holder->id;

            // DF's generated hover contract names UNITLIST_RECENTER_JOB's action precisely:
            // "recenter on the task's building" (INFO_RECENTER_ON_JOB_BUILDING). The reviewed
            // native Residents oracle exposes that building-recenter + cancel pair only for the
            // exact "Store item in stockpile" label; "Store item in barrel" deliberately has no
            // pair. Require both that label and a real stockpile holder instead of generalizing the
            // native quirk to every hauling job. /task-cancel already consumes row.job_id.
            if (row.job == "Store item in stockpile" &&
                virtual_cast<df::building_stockpilest>(holder) &&
                Maps::isValidTilePos(holder->centerx, holder->centery, holder->z)) {
                row.job_has_pos = true;
                row.job_x = holder->centerx;
                row.job_y = holder->centery;
                row.job_z = holder->z;
            }
        }
    }
    row.status = Units::isAlive(unit) ? "" : "Dead";
    // WD-17: locate button needs a map position (reuses the same has_pos/x/y/z shape "Places"
    // rows already emit) + the mood face bucket (same getStressCategory the top bar HUD uses,
    // see hud.cpp build_hud_state) + a real held-item glyph.
    row.has_pos = true;
    row.x = unit->pos.x;
    row.y = unit->pos.y;
    row.z = unit->pos.z;
    // Units::getStressCategory returns 0=most-stressed..6=calmest (see stress_cutoffs in
    // Units.cpp); the top bar's HudState::happiness bucketing (hud.cpp build_hud_state)
    // re-indexes that as happiness[6-cat] so index 0 is the DISPLAYED-leftmost/happiest face
    // (BUTTON_STRESS_0) and index 6 is the miserable one. Mirror that same remap here so the
    // per-unit mood face uses the identical BUTTON_STRESS_N meaning as the top bar.
    int stress_cat = std::max(0, std::min(6, Units::getStressCategory(unit)));
    row.mood_category = 6 - stress_cat;
    fill_held_item(unit, row);
    fill_labor_columns(unit, row);   // B254: SPECIALIZED + WORK_DETAILS
    if (Units::isTame(unit))
        row.badges.push_back("Domesticated");
    if (Units::isGrazer(unit))
        row.badges.push_back("Grazer: requires pasture");
    if (Units::isPet(unit))
        row.badges.push_back("Pet");
    if (Units::isMarkedForSlaughter(unit))
        row.badges.push_back("Marked for slaughter");
    // B16: per-animal livestock action state (only meaningful for live animals; the Pets/Livestock
    // client tab renders Slaughter/War/Hunt/Make-pet buttons off these). Non-animals leave the
    // whole group false.
    if (Units::isAnimal(unit) && Units::isAlive(unit)) {
        row.livestock = true;
        row.ls_slaughter = Units::isMarkedForSlaughter(unit);
        row.ls_war = Units::isMarkedForWarTraining(unit);
        row.ls_hunt = Units::isMarkedForHuntTraining(unit);
        row.ls_trainable_war = Units::isTrainableWar(unit);
        row.ls_trainable_hunt = Units::isTrainableHunting(unit);
        row.ls_pet = Units::isPet(unit);
        row.ls_adoption = Units::isAvailableForAdoption(unit);
        // B33: trainer-assignment state. `tamable` = DFHack's own assignTrainer precondition
        // (tameable caste, not yet domesticated) -- gates the client's assign-trainer control.
        row.ls_tamable = Units::isTamable(unit) && !Units::isDomesticated(unit);
        row.ls_training = Units::isMarkedForTraining(unit);
        row.ls_taming = Units::isMarkedForTaming(unit);
        if (row.ls_training) {
            df::training_assignment* asg = binsearch_in_vector(
                df::global::plotinfo->training.training_assignments,
                &df::training_assignment::animal_id, unit->id);
            row.ls_trainer_id = asg ? asg->trainer_id : -1;
        }
        // Husbandry: gelding. isGeldable() == the caste's GELDABLE flag; isGelded() scans body
        // wounds for a gelded part. Native only offers Geld on a geldable, not-yet-gelded animal.
        row.ls_geld = Units::isMarkedForGelding(unit);
        row.ls_geldable = Units::isGeldable(unit) && !Units::isGelded(unit);
    }
    return row;
}

// A unit may remain in world->units.active after death, become a real ghost, or carry
// flags1.inactive. DFHack's isActive() owns the inactive-family interpretation; keep all
// three predicates together so Residents, Labor, and population cannot diverge.
bool is_living_active_unit(df::unit* unit) {
    return unit && Units::isActive(unit) && !Units::isDead(unit) && !Units::isGhost(unit);
}

// Fort GROUP members only. Work-detail eligibility and the animal-trainer picker are
// citizen-only in native DF (long-term residents cannot hold fortress labors), so those paths
// must use this, not the broader is_resident below.
bool is_fort_citizen(df::unit* unit) {
    return is_living_active_unit(unit) && Units::isCitizen(unit, true);
}

// B215: the Residents screen and the population total count fort citizens PLUS accepted-petition
// long-term residents (entertainers, bards, mercenaries, monster hunters). A long-term resident
// is isOwnCiv but NOT isOwnGroup, so isCitizen() drops them; DFHack's isResident() is DF's own
// long-term-resident test. This mirrors DFHack citizensRange(exclude_residents=false), the same
// grouping native's population/units screen uses.
bool is_resident(df::unit* unit) {
    return is_living_active_unit(unit) &&
           (Units::isCitizen(unit, true) || Units::isResident(unit, true));
}

// Mirrors the map stream's fort-visibility gate. Caged animals remain listable once seen;
// the caged flag alone is not evidence that the creature is undiscovered.
bool is_visible_to_fort(df::unit* unit) {
    if (!unit || unit->flags1.bits.hidden_in_ambush ||
        unit->flags1.bits.hidden_ambusher)
        return false;
    df::map_block* block = Maps::getTileBlock(unit->pos);
    return !block || !block->designation[unit->pos.x & 15][unit->pos.y & 15].bits.hidden;
}

bool is_pet_or_livestock(df::unit* unit) {
    return is_living_active_unit(unit) && !is_resident(unit) &&
           Units::isAnimal(unit) &&
           (Units::isFortControlled(unit) || Units::isTame(unit) || Units::isPet(unit));
}

bool is_other_creature(df::unit* unit) {
    return is_living_active_unit(unit) && !is_resident(unit) &&
           !is_pet_or_livestock(unit) && is_visible_to_fort(unit);
}

bool is_dead_or_missing(df::unit* unit) {
    return unit && Units::isOwnGroup(unit) &&
           (!Units::isActive(unit) || Units::isDead(unit) || Units::isGhost(unit));
}

int item_type_index(df::item_type type) {
    int idx = static_cast<int>(type);
    if (idx < 0 || idx > df::enum_traits<df::item_type>::last_item_value)
        return -1;
    return idx;
}

int item_stack_count(df::item* item) {
    if (!item)
        return 0;
    return std::max(1, item->getStackSize());
}

std::string format_stock_count(int count) {
    if (count <= 0)
        return "None";
    if (count < 10)
        return std::to_string(count);
    int rounded = ((count + 5) / 10) * 10;
    return "~" + std::to_string(std::max(10, rounded));
}

struct StockCategory {
    df::item_type type;
    const char* label;
};

std::vector<StockCategory> stock_categories() {
    using namespace df::enums::item_type;
    return {
        {AMMO, "Ammunition"},
        {AMULET, "Amulets"},
        {ANIMALTRAP, "Animal traps"},
        {ANVIL, "Anvils"},
        {ARMOR, "Armor"},
        {ARMORSTAND, "Armor stands"},
        {BACKPACK, "Backpacks"},
        {BAG, "Bags"},
        {BALLISTAARROWHEAD, "Ballista arrow heads"},
        {BALLISTAPARTS, "Ballista parts"},
        {BARREL, "Barrels"},
        {BAR, "Bars"},
        {BED, "Beds"},
        {BIN, "Bins"},
        {BLOCKS, "Blocks"},
        {CORPSEPIECE, "Body parts"},
        {BOLT_THROWER_PARTS, "Bolt thrower parts"},
        {BOULDER, "Boulders"},
        {BOOK, "Books"},
        {BOX, "Boxes"},
        {BRACELET, "Bracelets"},
        {BRANCH, "Branches"},
        {BUCKET, "Buckets"},
        {CABINET, "Cabinets"},
        {CAGE, "Cages"},
        {CATAPULTPARTS, "Catapult parts"},
        {CHAIN, "Chains"},
        {CHAIR, "Chairs"},
        {CHEESE, "Cheese"},
        {CLOTH, "Cloth"},
        {COFFIN, "Coffins"},
        {COIN, "Coins"},
        {CORPSE, "Corpses"},
        {CROWN, "Crowns"},
        {CRUTCH, "Crutches"},
        {DOOR, "Doors"},
        {DRINK, "Drinks"},
        {EARRING, "Earrings"},
        {EGG, "Eggs"},
        {FISH, "Fish"},
        {FISH_RAW, "Raw fish"},
        {FLASK, "Flasks"},
        {FLOODGATE, "Floodgates"},
        {FIGURINE, "Figurines"},
        {FOOD, "Prepared meals"},
        {GEM, "Large gems"},
        {GLOVES, "Gloves"},
        {GOBLET, "Goblets"},
        {GLOB, "Globs"},
        {GRATE, "Grates"},
        {HATCH_COVER, "Hatch covers"},
        {HELM, "Helms"},
        {INSTRUMENT, "Instruments"},
        {SKIN_TANNED, "Leather"},
        {LIQUID_MISC, "Liquids"},
        {MEAT, "Meat"},
        {MILLSTONE, "Millstones"},
        {ORTHOPEDIC_CAST, "Casts"},
        {PANTS, "Pants"},
        {PET, "Vermin pets"},
        {PIPE_SECTION, "Pipe sections"},
        {PLANT, "Plants"},
        {PLANT_GROWTH, "Plant growths"},
        {POWDER_MISC, "Powders"},
        {QUIVER, "Quivers"},
        {QUERN, "Querns"},
        {REMAINS, "Remains"},
        {RING, "Rings"},
        {ROCK, "Small rocks"},
        {ROUGH, "Rough gems"},
        {SCEPTER, "Scepters"},
        {SEEDS, "Seeds"},
        {SHEET, "Sheets"},
        {SHIELD, "Shields"},
        {SHOES, "Shoes"},
        {SIEGEAMMO, "Siege ammunition"},
        {SLAB, "Slabs"},
        {SMALLGEM, "Cut gems"},
        {SPLINT, "Splints"},
        {STATUE, "Statues"},
        {TABLE, "Tables"},
        {THREAD, "Thread"},
        {TOOL, "Tools"},
        {TOTEM, "Totems"},
        {TOY, "Toys"},
        {TRACTION_BENCH, "Traction benches"},
        {TRAPCOMP, "Trap components"},
        {TRAPPARTS, "Mechanisms"},
        {VERMIN, "Vermin"},
        {WEAPON, "Weapons"},
        {WEAPONRACK, "Weapon racks"},
        {WINDOW, "Windows"},
        {WOOD, "Wood"},
    };
}

std::string stock_category_key(df::item_type type) {
    return enum_item_key(type);
}

bool stock_category_for_key(const std::string& key, StockCategory* out) {
    for (const auto& category : stock_categories()) {
        if (stock_category_key(category.type) == key) {
            if (out)
                *out = category;
            return true;
        }
    }
    return false;
}

std::vector<df::unit*> active_units() {
    if (!df::global::world)
        return {};
    return df::global::world->units.active;
}

std::vector<int32_t> scan_stock_counts_from_world() {
    std::vector<int32_t> counts(df::enum_traits<df::item_type>::last_item_value + 1, 0);
    if (!df::global::world)
        return counts;
    for (auto item : df::global::world->items.other[df::items_other_id::IN_PLAY]) {
        if (!is_fort_stock_item(item, FortItemPurpose::Stocks))
            continue;
        int idx = item_type_index(item->getType());
        if (idx >= 0)
            counts[idx] += item_stack_count(item);
    }
    return counts;
}

std::vector<int32_t> stock_counts() {
    auto counts = scan_stock_counts_from_world();
    auto game = df::global::game;
    if (!game)
        return counts;

    auto& stocks = game->main_interface.stocks;
    bool has_native_counts =
        std::any_of(stocks.storeamount.begin(), stocks.storeamount.end(), [](int32_t v) { return v != 0; }) ||
        std::any_of(stocks.badamount.begin(), stocks.badamount.end(), [](int32_t v) { return v != 0; });
    if (!has_native_counts)
        return counts;

    for (size_t idx = 0; idx < counts.size(); ++idx) {
        int32_t good = idx < stocks.storeamount.size() ? stocks.storeamount[idx] : 0;
        int32_t bad = idx < stocks.badamount.size() ? stocks.badamount[idx] : 0;
        counts[idx] = std::max<int32_t>(0, good + bad);
    }
    return counts;
}

std::string stock_item_name(df::item* item) {
    if (!item)
        return "";
    std::string desc = item_display_name(item, 0, false);
    if (desc.empty())
        desc = enum_item_key(item->getType()) + " #" + std::to_string(item->id);
    return desc;
}

void add_stock_items_for_type(InfoPanel& panel, df::item_type type) {
    if (!df::global::world)
        return;
    for (auto item : df::global::world->items.other[df::items_other_id::IN_PLAY]) {
        if (!is_fort_stock_item(item, FortItemPurpose::Stocks) || item->getType() != type)
            continue;
        StockItemRow row;
        row.item_id = item->id;
        row.count = item_stack_count(item);
        row.item_type = enum_item_key(item->getType());
        row.item_subtype = item->getSubtype();
        row.material_type = item->getMaterial();
        row.material_index = item->getMaterialIndex();
        row.name = stock_item_name(item);
        row.quality = item->getOverallQuality();
        if (auto actual = virtual_cast<df::item_actual>(item))
            row.wear = actual->wear;
        row.artifact = item->flags.bits.artifact;
        row.status = row.count > 1 ? ("[" + std::to_string(row.count) + "]") : "";
        row.subtitle = enum_item_key(item->getType());
        panel.stock_items.push_back(row);
    }
    std::sort(panel.stock_items.begin(), panel.stock_items.end(), [](const StockItemRow& a, const StockItemRow& b) {
        if (a.name != b.name)
            return a.name < b.name;
        return a.item_id < b.item_id;
    });
}

std::string stock_search_fold(const std::string& value) {
    std::string folded = value;
    std::transform(folded.begin(), folded.end(), folded.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return folded;
}

bool stock_search_matches(const std::string& value, const std::string& query) {
    const std::string haystack = stock_search_fold(value);
    std::istringstream words(stock_search_fold(query));
    std::string word;
    while (words >> word) {
        if (haystack.find(word) == std::string::npos)
            return false;
    }
    return true;
}

void add_stock_items_for_search(InfoPanel& panel, const std::string& query) {
    if (!df::global::world || query.empty())
        return;
    constexpr size_t kSearchResultLimit = 400;
    for (auto item : df::global::world->items.other[df::items_other_id::IN_PLAY]) {
        if (!is_fort_stock_item(item, FortItemPurpose::Stocks))
            continue;
        const std::string name = stock_item_name(item);
        if (!stock_search_matches(name, query))
            continue;
        StockItemRow row;
        row.item_id = item->id;
        row.count = item_stack_count(item);
        row.item_type = enum_item_key(item->getType());
        row.item_subtype = item->getSubtype();
        row.material_type = item->getMaterial();
        row.material_index = item->getMaterialIndex();
        row.name = name;
        row.quality = item->getOverallQuality();
        if (auto actual = virtual_cast<df::item_actual>(item))
            row.wear = actual->wear;
        row.artifact = item->flags.bits.artifact;
        row.status = row.count > 1 ? ("[" + std::to_string(row.count) + "]") : "";
        row.subtitle = row.item_type;
        panel.stock_items.push_back(row);
        if (panel.stock_items.size() >= kSearchResultLimit)
            break;
    }
    std::sort(panel.stock_items.begin(), panel.stock_items.end(), [](const StockItemRow& a, const StockItemRow& b) {
        if (a.name != b.name)
            return a.name < b.name;
        return a.item_id < b.item_id;
    });
}

void add_unit_rows(InfoPanel& panel, bool (*predicate)(df::unit*),
                   const WorldActivityIndex& world_activities, size_t limit = 80) {
    for (auto unit : active_units()) {
        if (!predicate(unit))
            continue;
        panel.rows.push_back(row_for_unit(unit, world_activities));
        if (panel.rows.size() >= limit)
            break;
    }
}

// Defined further down (with the Labor panel helpers); forward-declared so the Pets/Livestock
// builder can enumerate animal-training-capable citizens for B33's trainer picker.
bool unit_has_labor(df::unit* unit, df::unit_labor labor);

// B33: citizens who can be assigned as a specific animal trainer -- residents with the
// Animal Training labor enabled (DF's own gate for who appears in the "assign a trainer" list).
void collect_animal_trainers(InfoPanel& panel) {
    for (auto unit : active_units()) {
        if (is_fort_citizen(unit) && Units::isAlive(unit) &&
            unit_has_labor(unit, df::unit_labor::ANIMALTRAIN)) {
            panel.trainers.emplace_back(unit->id, unit_display_name(unit));
        }
    }
}

void build_creatures_panel(InfoPanel& panel, const WorldActivityIndex& world_activities) {
    if (panel.detail == "pets") {
        add_unit_rows(panel, is_pet_or_livestock, world_activities);
        collect_animal_trainers(panel);
        for (auto& row : panel.rows) {
            if (row.status.empty())
                row.status = row.badges.empty() ? "Domesticated" : row.badges.front();
            if (row.status == "Domesticated") {
                row.job = "Unavailable as pet";
                if (auto unit = df::unit::find(row.unit_id)) {
                    if (Units::isAvailableForAdoption(unit))
                        row.job = "Interested in an owner";
                }
            }
        }
        panel.footer = "Ctrl+a: Autoretrain livestock: Off";
    } else if (panel.detail == "other") {
        add_unit_rows(panel, is_other_creature, world_activities);
        for (auto& row : panel.rows) {
            row.status = "Wild Animal";
            row.job.clear();
        }
    } else if (panel.detail == "dead") {
        add_unit_rows(panel, is_dead_or_missing, world_activities);
        panel.footer = "[d: Show death cause]";
    } else {
        add_unit_rows(panel, is_resident, world_activities);
        for (auto& row : panel.rows) {
            row.status = row.job;
            row.job.clear();
        }
    }
    if (panel.rows.empty() && panel.detail == "dead")
        panel.messages.push_back("No dead or missing citizens.");
    else if (panel.rows.empty())
        panel.messages.push_back("No entries.");
}

void build_tasks_panel(InfoPanel& panel, const WorldActivityIndex& world_activities) {
    for (auto unit : active_units()) {
        if (!is_resident(unit) || !unit->job.current_job)
            continue;
        auto row = row_for_unit(unit, world_activities);
        row.status = row.job;
        row.job_id = unit->job.current_job->id;
        panel.rows.push_back(row);
        if (panel.rows.size() >= 80)
            break;
    }
    if (panel.rows.empty())
        panel.messages.push_back("No active citizen tasks.");
}

std::string pretty_enum_key(const std::string& key) {
    std::string out;
    out.reserve(key.size() + 8);
    char prev = 0;
    for (char ch : key) {
        if (ch == '_') {
            out.push_back(' ');
        } else {
            if (prev && std::islower(static_cast<unsigned char>(prev)) &&
                std::isupper(static_cast<unsigned char>(ch)))
                out.push_back(' ');
            out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
        }
        prev = ch;
    }
    if (!out.empty())
        out[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(out[0])));
    return out;
}

std::string map_pos_label(df::building* b) {
    if (!b)
        return "";
    return "Tile: " + std::to_string(b->centerx) + ", " +
        std::to_string(b->centery) + ", " + std::to_string(b->z);
}

std::string building_size_label(df::building* b) {
    if (!b)
        return "";
    int w = std::max(1, b->x2 - b->x1 + 1);
    int h = std::max(1, b->y2 - b->y1 + 1);
    return std::to_string(w) + "x" + std::to_string(h);
}

bool visible_building(df::building* b) {
    return b && b->flags.bits.exists && !b->flags.bits.almost_deleted;
}

std::string building_label(df::building* b) {
    if (!b)
        return "";
    std::string name = Buildings::getName(b);
    if (!name.empty())
        return name;
    if (auto sp = virtual_cast<df::building_stockpilest>(b))
        return "Stockpile #" + std::to_string(sp->stockpile_number);
    if (auto ws = virtual_cast<df::building_workshopst>(b))
        return pretty_enum_key(enum_item_key(ws->type));
    if (auto furnace = virtual_cast<df::building_furnacest>(b))
        return pretty_enum_key(enum_item_key(furnace->type));
    if (auto siege = virtual_cast<df::building_siegeenginest>(b)) {
        if (siege->type == df::siegeengine_type::BoltThrower)
            return "Bolt Thrower";
        return pretty_enum_key(enum_item_key(siege->type));
    }
    if (b->getType() == df::building_type::FarmPlot)
        return "Farm Plot";
    return pretty_enum_key(enum_item_key(b->getType()));
}

std::string construction_status(df::building* b) {
    if (!b)
        return "";
    if (Buildings::markedForRemoval(b))
        return "Marked for removal";
    if (b->getBuildStage() < b->getMaxBuildStage()) {
        bool suspended = false;
        for (auto job : b->jobs) {
            if (job && job->flags.bits.suspend) {
                suspended = true;
                break;
            }
        }
        return suspended ? "Construction suspended" : "Under construction";
    }
    return "";
}

void set_row_pos(InfoRow& row, df::building* b) {
    if (!b)
        return;
    row.x = b->centerx;
    row.y = b->centery;
    row.z = b->z;
    row.has_pos = true;
}

InfoRow base_place_row(df::building* b, const std::string& kind, const std::string& category) {
    InfoRow row;
    row.kind = kind;
    row.building_id = b ? b->id : -1;
    row.name = building_label(b);
    row.subtitle = map_pos_label(b);
    row.category = category;
    row.profession = building_size_label(b);
    row.status = construction_status(b);
    set_row_pos(row, b);
    return row;
}

struct ZoneTypeMeta {
    const char* key;
    const char* label;
    int icon_x;
    int icon_y;
};

ZoneTypeMeta place_zone_type_meta(df::civzone_type type) {
    switch (type) {
    case df::civzone_type::MeetingHall:     return {"meeting", "Meeting Area", 5, 10};
    case df::civzone_type::Pen:             return {"pen", "Pen/Pasture", 5, 6};
    case df::civzone_type::Pond:            return {"pond", "Pit/Pond", 5, 7};
    case df::civzone_type::WaterSource:     return {"water", "Water Source", 5, 2};
    case df::civzone_type::FishingArea:     return {"fishing", "Fishing", 5, 3};
    case df::civzone_type::SandCollection:  return {"sand", "Sand", 5, 8};
    case df::civzone_type::ClayCollection:  return {"clay", "Clay", 5, 9};
    case df::civzone_type::Dump:            return {"dump", "Garbage Dump", 5, 5};
    case df::civzone_type::PlantGathering:  return {"gather", "Gather Fruit", 5, 4};
    case df::civzone_type::AnimalTraining:  return {"training", "Animal Training", 5, 12};
    case df::civzone_type::Dungeon:         return {"dungeon", "Dungeon", 6, 13};
    case df::civzone_type::Bedroom:         return {"bedroom", "Bedroom", 6, 7};
    case df::civzone_type::DiningHall:      return {"dining", "Dining Hall", 6, 8};
    case df::civzone_type::Office:          return {"office", "Office", 6, 9};
    case df::civzone_type::Dormitory:       return {"dormitory", "Dormitory", 6, 12};
    case df::civzone_type::Barracks:        return {"barracks", "Barracks", 6, 11};
    case df::civzone_type::ArcheryRange:    return {"archery", "Archery Range", 6, 10};
    case df::civzone_type::Tomb:            return {"tomb", "Tomb", 6, 14};
    case df::civzone_type::Shrine:          return {"shrine", "Shrine", 6, 4};
    case df::civzone_type::Temple:          return {"temple", "Temple", 6, 5};
    case df::civzone_type::Library:         return {"library", "Library", 6, 1};
    default:                                return {"zone", "Zone", 5, 13};
    }
}

int stockpile_icon_row(df::building_stockpilest* sp) {
    if (!sp)
        return 17;
    const auto& f = sp->settings.flags.bits;
    if (f.ammo) return 0;
    if (f.animals) return 1;
    if (f.armor) return 2;
    if (f.bars_blocks) return 3;
    if (f.cloth) return 4;
    if (f.coins) return 5;
    if (f.finished_goods) return 6;
    if (f.food) return 7;
    if (f.furniture) return 8;
    if (f.gems) return 9;
    if (f.leather) return 10;
    if (f.corpses) return 11;
    if (f.refuse) return 12;
    if (f.sheet) return 13;
    if (f.stone) return 15;
    if (f.weapons) return 16;
    if (f.wood) return 17;
    return 17;
}

std::string stockpile_groups_text(df::building_stockpilest* sp) {
    if (!sp)
        return "";
    const auto& f = sp->settings.flags.bits;
    std::vector<std::string> labels;
    if (f.animals) labels.push_back("Animals");
    if (f.food) labels.push_back("Food");
    if (f.furniture) labels.push_back("Furniture");
    if (f.corpses) labels.push_back("Corpses");
    if (f.refuse) labels.push_back("Refuse");
    if (f.stone) labels.push_back("Stone");
    if (f.ammo) labels.push_back("Ammo");
    if (f.coins) labels.push_back("Coins");
    if (f.bars_blocks) labels.push_back("Bars/blocks");
    if (f.gems) labels.push_back("Gems");
    if (f.finished_goods) labels.push_back("Finished goods");
    if (f.leather) labels.push_back("Leather");
    if (f.cloth) labels.push_back("Cloth");
    if (f.wood) labels.push_back("Wood");
    if (f.weapons) labels.push_back("Weapons");
    if (f.armor) labels.push_back("Armor");
    if (f.sheet) labels.push_back("Sheets");
    if (labels.empty())
        return "No item categories";
    std::ostringstream out;
    for (size_t i = 0; i < labels.size(); ++i) {
        if (i)
            out << ", ";
        out << labels[i];
        if (i == 2 && labels.size() > 3) {
            out << ", +" << (labels.size() - 3) << " more";
            break;
        }
    }
    return out.str();
}

const char* workshop_icon_key(df::workshop_type type) {
    switch (type) {
    case df::workshop_type::Carpenters:       return "workshop_carpenter";
    case df::workshop_type::Masons:           return "workshop_mason";
    case df::workshop_type::MetalsmithsForge: return "workshop_metalsmith";
    case df::workshop_type::MagmaForge:       return "workshop_metalsmith";
    case df::workshop_type::Craftsdwarfs:     return "workshop_crafts";
    case df::workshop_type::Jewelers:         return "workshop_jeweler";
    case df::workshop_type::Bowyers:          return "workshop_bowyer";
    case df::workshop_type::Mechanics:        return "workshop_mechanic";
    case df::workshop_type::Siege:            return "workshop_siege";
    case df::workshop_type::Ashery:           return "workshop_ashery";
    case df::workshop_type::Leatherworks:     return "workshop_leather";
    case df::workshop_type::Loom:             return "workshop_loom";
    case df::workshop_type::Clothiers:        return "workshop_clothes";
    case df::workshop_type::Dyers:            return "workshop_dyer";
    case df::workshop_type::Butchers:         return "workshop_butcher";
    case df::workshop_type::Tanners:          return "workshop_tanner";
    case df::workshop_type::Fishery:          return "workshop_fishery";
    case df::workshop_type::Kitchen:          return "workshop_kitchen";
    case df::workshop_type::Farmers:          return "workshop_farmer";
    case df::workshop_type::Quern:            return "workshop_quern";
    case df::workshop_type::Millstone:        return "workshop_millstone";
    case df::workshop_type::Kennels:          return "workshop_kennel";
    case df::workshop_type::Still:            return "workshop_still";
    default:                                  return "workshops";
    }
}

const char* furnace_icon_key(df::furnace_type type) {
    switch (type) {
    case df::furnace_type::WoodFurnace: return "furnace_wood";
    case df::furnace_type::Smelter:
    case df::furnace_type::MagmaSmelter: return "furnace_smelter";
    case df::furnace_type::GlassFurnace:
    case df::furnace_type::MagmaGlassFurnace: return "furnace_glass";
    case df::furnace_type::Kiln:
    case df::furnace_type::MagmaKiln: return "furnace_kiln";
    default: return "workshops_furnaces";
    }
}

std::string first_job_label(df::building* b) {
    if (!b)
        return "";
    for (auto job : b->jobs) {
        if (!job)
            continue;
        std::string name = native_job_name(job);
        if (!name.empty())
            return job->flags.bits.suspend ? (name + " (suspended)") : name;
    }
    return "";
}

df::world_site* current_site() {
    int32_t site_id = World::GetCurrentSiteId();
    if (site_id >= 0) {
        if (auto site = df::world_site::find(site_id))
            return site;
    }
    auto world = df::global::world;
    if (world && world->world_data && !world->world_data->active_site.empty())
        return world->world_data->active_site.front();
    return nullptr;
}

std::string abstract_location_type_label(df::abstract_building_type type) {
    switch (type) {
    case df::abstract_building_type::INN_TAVERN: return "Inn Tavern";
    case df::abstract_building_type::TEMPLE: return "Temple";
    case df::abstract_building_type::HOSPITAL: return "Hospital";
    case df::abstract_building_type::GUILDHALL: return "Guildhall";
    case df::abstract_building_type::LIBRARY: return "Library";
    case df::abstract_building_type::TOMB: return "Tomb";
    case df::abstract_building_type::COUNTING_HOUSE: return "Counting House";
    case df::abstract_building_type::DUNGEON: return "Dungeon";
    default: return pretty_enum_key(enum_item_key(type));
    }
}

const char* abstract_location_icon_key(df::abstract_building_type type) {
    switch (type) {
    case df::abstract_building_type::INN_TAVERN: return "table";
    case df::abstract_building_type::TEMPLE: return "offering_place";
    case df::abstract_building_type::HOSPITAL: return "bed";
    case df::abstract_building_type::GUILDHALL: return "workshops";
    case df::abstract_building_type::LIBRARY: return "bookcase";
    case df::abstract_building_type::TOMB: return "coffin";
    case df::abstract_building_type::COUNTING_HOUSE: return "box";
    case df::abstract_building_type::DUNGEON: return "cage";
    default: return "furniture";
    }
}

std::string abstract_location_name(df::abstract_building* location) {
    if (!location)
        return "";
    std::string type = abstract_location_type_label(location->getType());
    auto name = location->getName();
    if (name) {
        std::string translated = Translation::translateName(name, true);
        if (!translated.empty())
            return translated;
    }
    return type + " #" + std::to_string(location->id);
}

// B229 (census #46, "occupant counts"): how many people are actually IN the location right now,
// and how many of its staff slots are filled. The Places > Locations tab listed neither -- a tavern
// with nobody in it and a tavern with fourteen dwarves in it rendered identically.
//   occupants = live units standing inside any civzone attached to the location
//               (abstract_building_contents::building_ids -> df::building_civzonest x1..x2/y1..y2/z)
//   staff     = df::occupation entries on abstract_building::occupations with a holder
//               (occupation::unit_id / ::histfig_id; -1 == vacant, same as native's Location Details)
struct LocationCounts {
    int32_t occupants = 0;
    int32_t staff = 0;
    int32_t staff_slots = 0;
};

LocationCounts location_counts(df::abstract_building* location) {
    LocationCounts counts;
    if (!location)
        return counts;
    for (auto occ : location->occupations) {
        if (!occ)
            continue;
        counts.staff_slots++;
        if (occ->unit_id >= 0 || occ->histfig_id >= 0)
            counts.staff++;
    }
    auto contents = location->getContents();
    auto world = df::global::world;
    if (!contents || !world || contents->building_ids.empty())
        return counts;
    std::vector<df::building_civzonest*> zones;
    for (int32_t id : contents->building_ids) {
        if (auto zone = virtual_cast<df::building_civzonest>(df::building::find(id)))
            zones.push_back(zone);
    }
    if (zones.empty())
        return counts;
    for (auto unit : world->units.active) {
        if (!unit || DFHack::Units::isDead(unit) || !DFHack::Units::isActive(unit))
            continue;
        for (auto zone : zones) {
            if (unit->pos.z == zone->z && unit->pos.x >= zone->x1 && unit->pos.x <= zone->x2 &&
                unit->pos.y >= zone->y1 && unit->pos.y <= zone->y2) {
                counts.occupants++;
                break;
            }
        }
    }
    return counts;
}

df::building* first_location_building(df::abstract_building* location) {
    if (!location)
        return nullptr;
    auto contents = location->getContents();
    if (!contents)
        return nullptr;
    for (int32_t id : contents->building_ids) {
        if (auto b = df::building::find(id))
            return b;
    }
    return nullptr;
}

std::string farm_crop_label(df::building_farmplotst* farm) {
    if (!farm)
        return "";
    int season = static_cast<int>(farm->last_season);
    if (season < 0 || season > df::enum_traits<df::season>::last_item_value)
        season = 0;
    int plant_id = farm->plant_id[season];
    if (plant_id < 0)
        return "No crop selected";
    if (auto plant = df::plant_raw::find(plant_id)) {
        if (!plant->name_plural.empty())
            return plant->name_plural;
        if (!plant->id.empty())
            return pretty_enum_key(plant->id);
    }
    return "Plant " + std::to_string(plant_id);
}

std::string siege_engine_type_label(df::building_siegeenginest* siege) {
    if (!siege)
        return "";
    if (siege->type == df::siegeengine_type::BoltThrower)
        return "Bolt Thrower";
    return pretty_enum_key(enum_item_key(siege->type));
}

const char* siege_engine_icon_key(df::building_siegeenginest* siege) {
    if (!siege)
        return "workshop_siege";
    return siege->type == df::siegeengine_type::Catapult ? "catapult" : "ballista";
}

void sort_place_rows(InfoPanel& panel) {
    std::sort(panel.rows.begin(), panel.rows.end(), [](const InfoRow& a, const InfoRow& b) {
        if (a.name != b.name)
            return a.name < b.name;
        return a.building_id < b.building_id;
    });
}

// R6 (CIM-places-stockpiles.jpg): "NN% occupied" -- DF exposes no direct occupancy field, so we
// mirror what native computes: filled stockpile tiles / total stockpile tiles. A tile counts as
// filled when its map occupancy carries an item (tile_occupancy.bits.item, df.d_basics.xml:11054).
// Shaped (irregular) piles honor room.extents; rectangular piles scan the x1..x2/y1..y2 footprint.
// NOT-VERIFIED live: native may weight container capacity differently -- flagged in the notes.
std::string stockpile_occupancy_label(df::building_stockpilest* sp) {
    if (!sp)
        return "";
    int total = 0, filled = 0;
    bool shaped = sp->room.extents && sp->isExtentShaped();
    int rx = sp->room.width > 0 ? sp->room.x : sp->x1;
    int ry = sp->room.height > 0 ? sp->room.y : sp->y1;
    for (int y = sp->y1; y <= sp->y2; ++y) {
        for (int x = sp->x1; x <= sp->x2; ++x) {
            if (shaped) {
                int dx = x - rx, dy = y - ry;
                if (dx < 0 || dy < 0 || dx >= sp->room.width || dy >= sp->room.height)
                    continue;
                if (sp->room.extents[dx + dy * sp->room.width] == df::building_extents_type::None)
                    continue;
            }
            ++total;
            if (auto block = Maps::getTileBlock(df::coord(x, y, sp->z))) {
                if (block->occupancy[x & 15][y & 15].bits.item)
                    ++filled;
            }
        }
    }
    if (total <= 0)
        return "0% occupied"; // seeded-bad guard: never a div-by-zero NaN%
    int pct = static_cast<int>((static_cast<long long>(filled) * 100 + total / 2) / total);
    return std::to_string(pct) + "% occupied";
}

// R6 (CIM-places-zones.jpg): pen/pasture "N assigned / N present". assigned = the pasture roster;
// present = assigned units currently standing inside the zone footprint (native's live count).
std::string pen_assignment_label(df::building_civzonest* zone) {
    if (!zone)
        return "";
    int assigned = static_cast<int>(zone->assigned_units.size());
    if (assigned <= 0)
        return ""; // native omits the counts line for an empty pen (Fishing zone shows none)
    int present = 0;
    for (int32_t uid : zone->assigned_units) {
        auto unit = df::unit::find(uid);
        if (!unit)
            continue;
        if (unit->pos.z == zone->z && unit->pos.x >= zone->x1 && unit->pos.x <= zone->x2 &&
            unit->pos.y >= zone->y1 && unit->pos.y <= zone->y2)
            ++present;
    }
    return std::to_string(assigned) + " assigned / " + std::to_string(present) + " present";
}

// R6 (CIM-places-zones.jpg): barracks "2 squads assigned" / "<squad> assigned" / "Guard assigned".
std::string barracks_squad_label(df::building_civzonest* zone) {
    if (!zone)
        return "";
    size_t n = 0;
    df::building_squad_infost* info = nullptr;
    for (auto room : zone->squad_room_info) {
        if (!room || room->mode.whole == 0)
            continue;
        ++n;
        info = room;
    }
    // DFHack's native updater retains a building-side zero-mode row after the last mode is
    // cleared; it is not an assignment and must not inflate the Places status line.
    if (!n)
        return "";
    if (n > 1)
        return std::to_string(n) + " squads assigned";
    std::string name;
    if (auto squad = df::squad::find(info->squad_id)) {
        name = !squad->alias.empty() ? squad->alias
                                     : Translation::translateName(&squad->name, true);
    }
    if (name.empty())
        return "1 squad assigned";
    return name + " assigned";
}

// R6 (CIM-places-workshops.jpg): native appends "+ N task" to the current job when a workshop has
// more than one queued job. Empty when 0/1 jobs (the current-job label already covers the first).
std::string workshop_extra_tasks_suffix(df::building* b) {
    if (!b)
        return "";
    int extra = static_cast<int>(b->jobs.size()) - 1;
    if (extra <= 0)
        return "";
    return " + " + std::to_string(extra) + (extra == 1 ? " task" : " tasks");
}

void build_places_panel(InfoPanel& panel) {
    auto world = df::global::world;
    if (!world) {
        panel.messages.push_back("World data is not loaded.");
        return;
    }

    if (panel.detail == "zones") {
        for (auto zone : world->buildings.other.ANY_ZONE) {
            if (!visible_building(zone))
                continue;
            auto meta = place_zone_type_meta(zone->type);
            auto row = base_place_row(zone, "zone", meta.label);
            row.icon_sheet = "zone";
            row.icon_x = meta.icon_x;
            row.icon_y = meta.icon_y;
            // R6: native shows an assignment metric (not Active/Suspended) for pens + barracks;
            // fall back to the activity state for the zone types that carry no roster line.
            if (zone->type == df::civzone_type::Pen)
                row.status = pen_assignment_label(zone);
            else if (zone->type == df::civzone_type::Barracks)
                row.status = barracks_squad_label(zone);
            if (row.status.empty())
                row.status = zone->spec_sub_flag.bits.active ? "Active" : "Suspended";
            if (row.name.empty())
                row.name = meta.label;
            panel.rows.push_back(row);
            if (panel.rows.size() >= 120)
                break;
        }
        sort_place_rows(panel);
        if (panel.rows.empty()) {
            panel.messages.push_back("You do not have any zones.");
            panel.messages.push_back("Zones can be added using the zone menu at the bottom of the screen.");
        }
    } else if (panel.detail == "locations") {
        if (auto site = current_site()) {
            for (auto location : site->buildings) {
                if (!location)
                    continue;
                std::string type = abstract_location_type_label(location->getType());
                InfoRow row;
                row.kind = "location";
                row.location_id = location->id;
                row.name = abstract_location_name(location);
                row.category = "Location";
                row.profession = type;
                row.icon_key = abstract_location_icon_key(location->getType());
                if (auto b = first_location_building(location)) {
                    row.building_id = b->id;
                    row.subtitle = map_pos_label(b);
                    set_row_pos(row, b);
                    if (b->getType() == df::building_type::Civzone)
                        row.kind = "zone";
                    else
                        row.kind = "building";
                }
                if (auto contents = location->getContents()) {
                    row.status = std::to_string(contents->building_ids.size()) +
                        (contents->building_ids.size() == 1 ? " zone" : " zones");
                    if (contents->location_value > 0)
                        row.job = "Value: " + std::to_string(contents->location_value);
                }
                // B229: occupants + staffing, the two facts the stub screen was missing.
                auto counts = location_counts(location);
                row.subtitle = row.subtitle.empty()
                    ? std::to_string(counts.occupants) + " inside"
                    : row.subtitle + " \xc2\xb7 " + std::to_string(counts.occupants) + " inside";
                if (counts.staff_slots > 0)
                    row.status += " \xc2\xb7 " + std::to_string(counts.staff) + "/" +
                                  std::to_string(counts.staff_slots) + " staffed";
                row.badges.push_back(std::to_string(counts.occupants) + " inside");
                panel.rows.push_back(row);
                if (panel.rows.size() >= 80)
                    break;
            }
            sort_place_rows(panel);
        }
        if (panel.rows.empty())
            panel.messages.push_back("No locations listed.");
    } else if (panel.detail == "stockpiles") {
        for (auto sp : world->buildings.other.STOCKPILE) {
            if (!visible_building(sp))
                continue;
            auto row = base_place_row(sp, "stockpile", "Stockpile");
            row.icon_sheet = "stockpile";
            row.icon_row = stockpile_icon_row(sp);
            row.job = stockpile_groups_text(sp);
            // R6 (CIM-places-stockpiles.jpg): the native per-row metric is "NN% occupied".
            row.status = stockpile_occupancy_label(sp);
            if (sp->stockpile_flag.bits.use_links_only)
                row.status += row.status.empty() ? "Links only" : " \xC2\xB7 Links only";
            panel.rows.push_back(row);
            if (panel.rows.size() >= 120)
                break;
        }
        sort_place_rows(panel);
        if (panel.rows.empty())
            panel.messages.push_back("No stockpiles listed.");
    } else if (panel.detail == "workshops") {
        for (auto ws : world->buildings.other.WORKSHOP_ANY) {
            if (!visible_building(ws))
                continue;
            auto row = base_place_row(ws, "workshop", "Workshop");
            row.icon_key = workshop_icon_key(ws->type);
            row.profession = pretty_enum_key(enum_item_key(ws->type));
            row.job = first_job_label(ws);
            if (!row.job.empty())
                row.job += workshop_extra_tasks_suffix(ws); // R6: "+ N task"
            if (row.job.empty() && row.status.empty())
                row.status = "Idle";
            panel.rows.push_back(row);
        }
        for (auto furnace : world->buildings.other.FURNACE_ANY) {
            if (!visible_building(furnace))
                continue;
            auto row = base_place_row(furnace, "workshop", "Furnace");
            row.icon_key = furnace_icon_key(furnace->type);
            row.profession = pretty_enum_key(enum_item_key(furnace->type));
            row.job = first_job_label(furnace);
            if (!row.job.empty())
                row.job += workshop_extra_tasks_suffix(furnace); // R6: "+ N task"
            if (row.job.empty() && row.status.empty())
                row.status = "Idle";
            panel.rows.push_back(row);
        }
        sort_place_rows(panel);
        if (panel.rows.empty())
            panel.messages.push_back("No workshops listed.");
    } else if (panel.detail == "farmplots") {
        for (auto farm : world->buildings.other.FARM_PLOT) {
            if (!visible_building(farm))
                continue;
            auto row = base_place_row(farm, "building", "Farm plot");
            row.icon_key = "farm_plot";
            row.job = farm_crop_label(farm);
            if (farm->max_fertilization > 0)
                row.status = "Fertilized: " + std::to_string(farm->current_fertilization) +
                    "/" + std::to_string(farm->max_fertilization);
            panel.rows.push_back(row);
            if (panel.rows.size() >= 120)
                break;
        }
        sort_place_rows(panel);
        if (panel.rows.empty())
            panel.messages.push_back("No farm plots listed.");
    } else {
        for (auto b : world->buildings.all) {
            auto siege = virtual_cast<df::building_siegeenginest>(b);
            if (!visible_building(siege))
                continue;
            auto row = base_place_row(siege, "building", "Siege engine");
            row.icon_key = siege_engine_icon_key(siege);
            row.profession = siege_engine_type_label(siege);
            row.status = pretty_enum_key(enum_item_key(siege->action));
            row.job = first_job_label(siege);
            panel.rows.push_back(row);
            if (panel.rows.size() >= 80)
                break;
        }
        sort_place_rows(panel);
        if (panel.rows.empty()) {
            // R7 (CIM-places-siege engines.jpg): verbatim 2-line empty state.
            panel.messages.push_back("You do not have any siege engines.");
            panel.messages.push_back("Siege engines are placed using the building menu at the bottom of the screen.");
        }
    }
}

void add_labor_side_items(InfoPanel& panel) {
    panel.side_items = {
        "Add new work detail",
        "Miners",
        "Woodcutters",
        "Hunters",
        "Planters",
        "Fisherdwarves",
        "Plant gatherers",
        "Stonecutters",
        "Engravers",
        "Haulers",
        "Orderlies",
        "Siege operators",
    };
}

bool unit_has_labor(df::unit* unit, df::unit_labor labor) {
    int idx = static_cast<int>(labor);
    return idx >= 0 && idx <= df::enum_traits<df::unit_labor>::last_item_value &&
           unit->status.labors[idx];
}

void build_labor_panel(InfoPanel& panel, const WorldActivityIndex& world_activities) {
    add_labor_side_items(panel);
    if (panel.detail != "workdetails") {
        panel.messages.push_back("This independent labor subtab shell is ready; detailed controls are not wired yet.");
        return;
    }
    for (auto unit : active_units()) {
        if (!is_fort_citizen(unit))
            continue;
        auto row = row_for_unit(unit, world_activities);
        row.status = unit_has_labor(unit, df::unit_labor::MINE) ? "Selected" : "";
        row.job = row.profession;
        panel.rows.push_back(row);
        if (panel.rows.size() >= 80)
            break;
    }
    if (panel.rows.empty())
        panel.messages.push_back("No citizens available for work details.");
    panel.footer = "Ctrl+e: Save work details | Ctrl+i: Load work details";
}

std::string position_name(df::entity_position* position) {
    if (!position)
        return "";
    if (!position->name[0].empty())
        return position->name[0];
    if (!position->code.empty())
        return pretty_key(position->code);
    return "Position " + std::to_string(position->id);
}

void build_nobles_panel(InfoPanel& panel) {
    auto plotinfo = df::global::plotinfo;
    // Fort nobles/administrators live on the fort GROUP entity (group_id), not the
    // civilization (civ_id). Using civ_id here surfaced civ-level positions (monarch
    // etc.) instead of the fort's own positions. See /nobles in fort_admin.cpp.
    auto entity = plotinfo ? df::historical_entity::find(plotinfo->group_id) : nullptr;
    panel.messages.push_back("Ask host to assign");
    panel.messages.push_back("Members of the nobility have required rooms and can make demands. They cannot be reassigned.");
    panel.messages.push_back("Administrators handle various aspects of your fortress and can be reassigned.");
    if (entity) {
        for (auto position : entity->positions.own) {
            if (!position)
                continue;
            InfoRow row;
            row.name = position_name(position);
            row.status = "VACANT";
            for (auto assignment : entity->positions.assignments) {
                if (!assignment || assignment->position_id != position->id)
                    continue;
                if (assignment->histfig != -1) {
                    row.status = "Assigned";
                    row.subtitle = "historical figure " + std::to_string(assignment->histfig);
                    for (auto unit : active_units()) {
                        if (unit && unit->hist_figure_id == assignment->histfig) {
                            row.subtitle = unit_display_name(unit);
                            row.unit_id = unit->id;
                            row.portrait_texpos = unit->portrait_texpos;
                            row.profession = Units::getProfessionName(unit);
                            row.profession_color = Units::getProfessionColor(unit);
                            break;
                        }
                    }
                    break;
                }
            }
            panel.rows.push_back(row);
            if (panel.rows.size() >= 40)
                break;
        }
    }
    if (panel.rows.empty()) {
        const char* fallback[] = {
            "Expedition leader", "Militia commander", "Sheriff", "Hammerer",
            "Manager", "Chief medical dwarf", "Broker", "Bookkeeper", "Messenger"
        };
        for (auto name : fallback) {
            InfoRow row;
            row.name = name;
            row.status = std::string(name) == "Messenger" ? "NEW" : "VACANT";
            panel.rows.push_back(row);
        }
    }
}

std::string translated_name(const df::language_name& name) {
    if (!name.has_name)
        return "";
    std::string native = Translation::translateName(&name, false);
    std::string english = Translation::translateName(&name, true);
    if (native.empty())
        return english;
    if (english.empty() || english == native)
        return native;
    return native + " \"" + english + "\"";
}

std::string historical_figure_name(int32_t id) {
    if (id < 0)
        return "";
    auto hf = df::historical_figure::find(id);
    if (!hf)
        return "";
    std::string name = translated_name(hf->name);
    return name.empty() ? ("Historical figure " + std::to_string(id)) : name;
}

std::string artifact_name(df::artifact_record* artifact) {
    if (!artifact)
        return "";
    std::string name = translated_name(artifact->name);
    if (!name.empty())
        return name;
    if (artifact->item) {
        std::string desc = item_display_name(artifact->item, 1, true);
        if (!desc.empty())
            return desc;
    }
    return "Artifact " + std::to_string(artifact->id);
}

std::string object_item_description(df::item* item) {
    if (!item)
        return "";
    std::string desc = item_display_name(item, 1, true);
    if (desc.empty())
        desc = enum_item_key(item->getType()) + " #" + std::to_string(item->id);
    return desc;
}

bool is_written_artifact(df::artifact_record* artifact) {
    if (!artifact || !artifact->item)
        return false;
    using namespace df::enums::item_type;
    auto type = artifact->item->getType();
    return type == BOOK || type == SLAB || type == TOOL;
}

bool artifact_has_claim_type(df::artifact_record* artifact, df::artifact_claim_type type) {
    auto world = df::global::world;
    if (!world || !artifact)
        return false;
    for (auto entity : world->entities.all) {
        if (!entity)
            continue;
        for (auto claim : entity->artifact_claims) {
            if (claim && claim->artifact_id == artifact->id && claim->claim_type == type)
                return true;
        }
    }
    return false;
}

void set_row_item_position(InfoRow& row, df::item* item) {
    if (!item || item->flags.bits.removed || item->flags.bits.garbage_collect)
        return;
    df::coord pos = Items::getPosition(item);
    if (pos.x < 0 || pos.y < 0 || pos.z < 0)
        return;
    row.x = pos.x;
    row.y = pos.y;
    row.z = pos.z;
    row.has_pos = true;
}

// R7 (CIM-objects-artifacts.jpg): resolve a Symbol claim's position name via its
// entity_position_assignment id (symbol_claim_id) -> position_id -> entity_position.name[0].
std::string position_name_for_symbol_claim(df::historical_entity* entity, int32_t assignment_id) {
    if (!entity || assignment_id < 0)
        return "";
    for (auto asn : entity->positions.assignments) {
        if (!asn || asn->id != assignment_id)
            continue;
        for (auto pos : entity->positions.own) {
            if (pos && pos->id == asn->position_id && !pos->name[0].empty())
                return pos->name[0];
        }
        break;
    }
    return "";
}

// R7: the right-hand claim column ("Treasure of <entity>", "<hf>'s family heirloom",
// "Symbol of the <position>"). An artifact carries at most one displayed claim; prefer the most
// specific (Symbol > Heirloom > Treasure/HolyRelic) as the native list does. Empty when unclaimed
// (seeded-bad guard: never "Treasure of " with a blank entity).
std::string artifact_claim_label(df::artifact_record* artifact) {
    auto world = df::global::world;
    if (!world || !artifact)
        return "";
    df::historical_entity* symbol_ent = nullptr;
    int32_t symbol_assignment = -1;
    df::historical_entity* treasure_ent = nullptr;
    bool heirloom = false;
    for (auto entity : world->entities.all) {
        if (!entity)
            continue;
        for (auto claim : entity->artifact_claims) {
            if (!claim || claim->artifact_id != artifact->id)
                continue;
            switch (claim->claim_type) {
            case df::artifact_claim_type::Symbol:
                symbol_ent = entity;
                symbol_assignment = claim->symbol_claim_id;
                break;
            case df::artifact_claim_type::Heirloom:
                heirloom = true;
                break;
            case df::artifact_claim_type::Treasure:
            case df::artifact_claim_type::HolyRelic:
                if (!treasure_ent)
                    treasure_ent = entity;
                break;
            default:
                break;
            }
        }
    }
    if (symbol_ent) {
        std::string pos = position_name_for_symbol_claim(symbol_ent, symbol_assignment);
        return pos.empty() ? "" : ("Symbol of the " + pos);
    }
    if (heirloom) {
        std::string owner = historical_figure_name(
            artifact->owner_hf >= 0 ? artifact->owner_hf : artifact->holder_hf);
        return owner.empty() ? "" : (owner + "'s family heirloom");
    }
    if (treasure_ent) {
        std::string ename = Translation::translateName(&treasure_ent->name, true);
        return ename.empty() ? "" : ("Treasure of " + ename);
    }
    return "";
}

InfoRow row_for_artifact(df::artifact_record* artifact, const std::string& category) {
    InfoRow row;
    row.kind = "item";
    row.category = category;
    if (!artifact)
        return row;
    // R7: native stacks the artifact's own name (line 1) over its quoted English translation
    // (line 2, "" form). Fall back to the item description when the artifact has no english alias.
    std::string native = artifact->name.has_name ? Translation::translateName(&artifact->name, false) : "";
    std::string english = artifact->name.has_name ? Translation::translateName(&artifact->name, true) : "";
    row.name = !native.empty() ? native : artifact_name(artifact);
    if (!english.empty() && english != native)
        row.subtitle = "\"" + english + "\"";
    else
        row.subtitle = object_item_description(artifact->item);
    if (artifact->item) {
        row.item_id = artifact->item->id;
        row.profession = pretty_enum_key(enum_item_key(artifact->item->getType()));
        set_row_item_position(row, artifact->item);
    }
    std::string holder = historical_figure_name(artifact->holder_hf >= 0 ? artifact->holder_hf : artifact->owner_hf);
    if (!holder.empty())
        row.job = "Held by " + holder;
    // R7: the claim label is the native right-column text. Fall back to the location state when
    // the artifact carries no entity/heirloom/symbol claim.
    std::string claim = artifact_claim_label(artifact);
    if (!claim.empty())
        row.status = claim;
    else if (row.has_pos)
        row.status = "On map";
    else if (artifact->site >= 0 || artifact->storage_site >= 0)
        row.status = "Known";
    else
        row.status = "No location";
    row.badges.push_back("Artifact");
    return row;
}

void add_artifact_rows(InfoPanel& panel,
                       const std::vector<df::artifact_record*>& artifacts,
                       const std::string& category,
                       size_t limit) {
    std::vector<int32_t> seen;
    for (auto artifact : artifacts) {
        if (!artifact || std::find(seen.begin(), seen.end(), artifact->id) != seen.end())
            continue;
        seen.push_back(artifact->id);
        panel.rows.push_back(row_for_artifact(artifact, category));
        if (panel.rows.size() >= limit)
            break;
    }
}

std::vector<df::artifact_record*> all_world_artifacts() {
    std::vector<df::artifact_record*> out;
    auto world = df::global::world;
    if (!world)
        return out;
    for (auto artifact : world->artifacts.all) {
        if (artifact)
            out.push_back(artifact);
    }
    return out;
}

// --- Fort scoping ------------------------------------------------------------------------
// Base DF's fortress Objects screen lists only objects present at / claimed by YOUR fort, not
// every artifact in world history. world->artifacts.all is the whole world (hundreds, all the
// worldgen relics held by figures elsewhere), so a fresh fort must show (almost) none.
int32_t fortress_site_id() {
    auto pi = df::global::plotinfo;
    return (pi && pi->main.fortress_site) ? pi->main.fortress_site->id : -1;
}
bool item_on_local_map(df::item* item) {
    if (!item || item->flags.bits.removed || item->flags.bits.garbage_collect)
        return false;
    df::coord pos = Items::getPosition(item);
    return pos.x >= 0 && pos.y >= 0 && pos.z >= 0;
}
bool artifact_at_fort(df::artifact_record* a) {
    if (!a)
        return false;
    if (item_on_local_map(a->item))         // physically present on the fortress map
        return true;
    int32_t fs = fortress_site_id();         // or recorded as located/stored at the fort site
    return fs >= 0 && (a->site == fs || a->storage_site == fs);
}
std::vector<df::artifact_record*> fort_artifacts() {
    std::vector<df::artifact_record*> out;
    for (auto a : all_world_artifacts())
        if (artifact_at_fort(a))
            out.push_back(a);
    return out;
}

std::vector<df::artifact_record*> symbol_artifacts() {
    std::vector<df::artifact_record*> out;
    auto world = df::global::world;
    auto plotinfo = df::global::plotinfo;
    if (!world || !plotinfo)
        return out;
    for (auto entity : world->entities.all) {
        if (!entity)
            continue;
        // Only the player's own civilization / fortress group, not every entity in the world.
        if (entity->id != plotinfo->civ_id && entity->id != plotinfo->group_id)
            continue;
        for (auto claim : entity->artifact_claims) {
            if (!claim || claim->claim_type != df::artifact_claim_type::Symbol)
                continue;
            auto artifact = df::artifact_record::find(claim->artifact_id);
            if (artifact && std::find(out.begin(), out.end(), artifact) == out.end())
                out.push_back(artifact);
        }
    }
    return out;
}

std::vector<df::artifact_record*> named_object_artifacts() {
    std::vector<df::artifact_record*> out;
    for (auto artifact : all_world_artifacts()) {
        if (!artifact_at_fort(artifact))
            continue;
        if (is_written_artifact(artifact))
            continue;
        if (artifact_has_claim_type(artifact, df::artifact_claim_type::Symbol))
            continue;
        if (artifact->item && artifact->item->flags.bits.artifact)
            out.push_back(artifact);
    }
    return out;
}

std::string written_author_label(df::written_content* content) {
    if (!content || content->author < 0)
        return "";
    std::string author = historical_figure_name(content->author);
    return author.empty() ? "" : ("By " + author);
}

std::string written_page_label(df::written_content* content) {
    if (!content)
        return "";
    if (content->page_start >= 0 && content->page_end >= content->page_start)
        return "Pages " + std::to_string(content->page_start) + "-" + std::to_string(content->page_end);
    if (content->page_start >= 0)
        return "Page " + std::to_string(content->page_start);
    return "";
}

[[maybe_unused]] void build_written_content_panel(InfoPanel& panel) {
    auto world = df::global::world;
    if (!world)
        return;
    for (auto content : world->written_contents.all) {
        if (!content)
            continue;
        InfoRow row;
        row.kind = "written";
        row.name = content->title.empty() ? ("Written content " + std::to_string(content->id)) : content->title;
        row.category = pretty_enum_key(enum_item_key(content->type));
        row.profession = written_author_label(content);
        row.status = written_page_label(content);
        if (!content->styles.empty())
            row.job = pretty_enum_key(enum_item_key(content->styles.front()));
        panel.rows.push_back(row);
        if (panel.rows.size() >= 120)
            break;
    }
}

void build_objects_panel(InfoPanel& panel) {
    if (panel.detail.empty())
        panel.detail = "artifacts";
    if (panel.detail == "artifacts") {
        add_artifact_rows(panel, fort_artifacts(), "Artifact", 120);
    } else if (panel.detail == "symbols") {
        add_artifact_rows(panel, symbol_artifacts(), "Symbol", 120);
        for (auto& row : panel.rows) {
            row.badges.push_back("Symbol");
            row.status = row.has_pos ? "On map" : "Assigned";
        }
    } else if (panel.detail == "named") {
        add_artifact_rows(panel, named_object_artifacts(), "Named object", 120);
    } else if (panel.detail == "written") {
        for (auto artifact : all_world_artifacts()) {
            if (artifact_at_fort(artifact) && is_written_artifact(artifact)) {
                panel.rows.push_back(row_for_artifact(artifact, "Written object"));
                if (panel.rows.size() >= 120)
                    break;
            }
        }
        // No unfiltered world fallback: base DF lists only written works present at the fort,
        // so dumping world->written_contents.all here flooded the tab with every book in history.
    }

    if (panel.rows.empty()) {
        if (panel.detail == "artifacts") {
            // WD-22: verbatim empty-state text pinned by 19-info-objects.png (three lines, not
            // the previous single-line placeholder).
            panel.messages.push_back("There aren't any crafted artifacts here.");
            panel.messages.push_back("Your workers will rarely make them on their own.");
            panel.messages.push_back("You may also send a squad to obtain one.");
        }
        else if (panel.detail == "symbols")
            panel.messages.push_back("No symbols listed.");
        else if (panel.detail == "named")
            panel.messages.push_back("No named objects listed.");
        else if (panel.detail == "written") {
            // R7 (CIM-objects-written content.jpg): verbatim empty state, transcribed line-for-line.
            panel.messages.push_back("There is no written content here.");
            panel.messages.push_back("Prepare writing material and assign scholars to a library.");
            panel.messages.push_back("Writing materials include paper and parchment sheets.");
            panel.messages.push_back("Use these to make scrolls and quires.");
            panel.messages.push_back("Libraries are a location that can be created at a zone.");
        }
        else
            panel.messages.push_back("No entries.");
    } else {
        panel.footer = std::to_string(panel.rows.size()) + " entries listed.";
    }
}

void build_workorders_panel(InfoPanel& panel) {
    auto world = df::global::world;
    size_t count = world ? world->manager_orders.all.size() : 0;
    if (count == 0) {
        panel.messages.push_back("No work orders.");
        panel.messages.push_back("Manager work order editing is not wired into the independent client yet.");
    } else {
        panel.messages.push_back(std::to_string(count) + " manager orders exist.");
        panel.messages.push_back("Detailed manager order decoding is the next work-order pass.");
    }
}

void build_justice_panel(InfoPanel& panel) {
    panel.messages.push_back("No open justice cases listed.");
}

void build_stocks_panel(InfoPanel& panel, const std::string& search) {
    panel.panel = "stocks";
    panel.section = "stocks";
    auto categories = stock_categories();
    if (panel.detail.empty() && !categories.empty())
        panel.detail = stock_category_key(categories.front().type);
    panel.title = "Stocks";
    panel.primary_tabs.clear();
    panel.section_tabs = stocks_section_tabs();
    panel.detail_tabs.clear();
    panel.footer = "Counts update from the host fort.";

    auto counts = stock_counts();
    for (const auto& category : categories) {
        int idx = item_type_index(category.type);
        int32_t count = idx >= 0 && static_cast<size_t>(idx) < counts.size() ? counts[idx] : 0;
        InfoRow row;
        row.name = category.label;
        row.category = "Stock";
        row.status = format_stock_count(count);
        row.job = stock_category_key(category.type);
        row.muted = count <= 0;
        panel.rows.push_back(row);
    }

    if (!search.empty()) {
        add_stock_items_for_search(panel, search);
    } else {
        StockCategory selected;
        if (stock_category_for_key(panel.detail, &selected))
            add_stock_items_for_type(panel, selected.type);
    }
}

struct RenderThreadPanelRequest {
    std::string panel_name;
    std::string section;
    std::string detail;
    std::string search;
    InfoPanel panel;
    std::string err;
    std::promise<bool> done;
};

} // namespace

// B224: the occupant rail (dwf-unitcycle.js) paints one icon per tile occupant. The Places
// info rows above already own the building -> icon derivation over the client's building_icons.png
// cell names (workshop_icon_key / furnace_icon_key / siege_engine_icon_key / farm_plot); this
// exports that SAME channel so /tile-occupants (interaction.cpp) ships it per occupant instead of
// growing a second derivation. The furniture arm mirrors the client's BLD_ICON_CELL names
// (dwf-build-info-panels.js). Returns "" when this building type has no cell -- the client
// then falls back to a label-keyword match and finally fails loud (empty tile + identity marker).
std::string building_icon_key(df::building* building) {
    if (!building)
        return "";
    using df::building_type;
    switch (building->getType()) {
    case building_type::Workshop: {
        auto ws = virtual_cast<df::building_workshopst>(building);
        return ws ? workshop_icon_key(ws->type) : "workshops";
    }
    case building_type::Furnace: {
        auto furnace = virtual_cast<df::building_furnacest>(building);
        return furnace ? furnace_icon_key(furnace->type) : "workshops_furnaces";
    }
    case building_type::SiegeEngine:
        return siege_engine_icon_key(virtual_cast<df::building_siegeenginest>(building));
    case building_type::FarmPlot:        return "farm_plot";
    case building_type::TradeDepot:      return "trade_depot";
    case building_type::Bed:             return "bed";
    case building_type::Chair:           return "chair";
    case building_type::Table:           return "table";
    case building_type::Box:             return "box";
    case building_type::Cabinet:         return "cabinet";
    case building_type::Coffin:          return "coffin";
    case building_type::Slab:            return "slab";
    case building_type::Statue:          return "statue";
    case building_type::TractionBench:   return "traction_bench";
    case building_type::Bookcase:        return "bookcase";
    case building_type::DisplayFurniture: return "display_furniture";
    case building_type::OfferingPlace:   return "offering_place";
    case building_type::Instrument:      return "instrument";
    case building_type::Door:            return "door";
    case building_type::Hatch:           return "hatch";
    case building_type::Bridge:          return "bridge";
    case building_type::Well:            return "well";
    case building_type::Cage:            return "cage";
    case building_type::Chain:           return "restraint";
    case building_type::AnimalTrap:      return "animal_trap";
    case building_type::NestBox:         return "nest_box";
    case building_type::Hive:            return "hive";
    case building_type::ArcheryTarget:   return "archery_target";
    case building_type::Weaponrack:      return "weapon_rack";
    case building_type::Armorstand:      return "armor_stand";
    case building_type::WindowGlass:     return "window_glass";
    case building_type::WindowGem:       return "window_gem";
    case building_type::Support:         return "support";
    case building_type::GrateWall:       return "grate_wall";
    case building_type::GrateFloor:      return "grate_floor";
    case building_type::BarsVertical:    return "bars_vertical";
    case building_type::BarsFloor:       return "bars_floors";
    case building_type::Floodgate:       return "floodgate";
    case building_type::ScrewPump:       return "screw_pump";
    case building_type::WaterWheel:      return "water_wheel";
    case building_type::Windmill:        return "windmill";
    case building_type::GearAssembly:    return "gear_assembly";
    case building_type::AxleHorizontal:  return "axle_horizontal";
    case building_type::AxleVertical:    return "axle_vertical";
    case building_type::Rollers:         return "rollers";
    // Levers, pressure plates and the trap family are ONE building_type (Trap) split by trap_type.
    case building_type::Trap: {
        auto trap = virtual_cast<df::building_trapst>(building);
        if (!trap) return "";
        switch (trap->trap_type) {
        case df::trap_type::Lever:         return "lever";
        case df::trap_type::PressurePlate: return "pressure_plate";
        case df::trap_type::CageTrap:      return "trap_cage";
        case df::trap_type::StoneFallTrap: return "trap_stone";
        case df::trap_type::WeaponTrap:    return "trap_weapon";
        case df::trap_type::TrackStop:     return "track_stop";
        default:                           return "";
        }
    }
    case building_type::Wagon:           return "wagon";
    case building_type::RoadPaved:       return "road_paved";
    case building_type::RoadDirt:        return "road_dirt";
    default:                             return "";
    }
}

InfoPanel build_info_panel(const std::string& panel_name,
                           const std::string& requested_section,
                           const std::string& requested_detail,
                           const std::string& search) {
    InfoPanel panel;
    panel.panel = panel_name.empty() ? "citizens" : panel_name;
    panel.section = requested_section.empty() ? default_section_for_panel(panel.panel) : requested_section;
    panel.detail = requested_detail.empty() ? default_detail_for_section(panel.section) : requested_detail;
    panel.title = "Citizens";
    panel.primary_tabs = primary_tabs();
    panel.section_tabs = section_tabs();
    panel.detail_tabs = detail_tabs_for(panel.section);

    if (panel.panel == "stocks" || panel.section == "stocks") {
        build_stocks_panel(panel, search);
    } else if (panel.section == "creatures") {
        panel.title = "Citizens";
        WorldActivityIndex world_activities;
        build_creatures_panel(panel, world_activities);
    } else if (panel.section == "tasks") {
        panel.title = "Tasks";
        WorldActivityIndex world_activities;
        build_tasks_panel(panel, world_activities);
    } else if (panel.section == "places") {
        panel.title = "Places";
        build_places_panel(panel);
    } else if (panel.section == "labor") {
        panel.title = "Labor";
        WorldActivityIndex world_activities;
        build_labor_panel(panel, world_activities);
    } else if (panel.section == "workorders") {
        panel.title = "Work Orders";
        build_workorders_panel(panel);
    } else if (panel.section == "nobles") {
        panel.title = "Nobles and administrators";
        build_nobles_panel(panel);
    } else if (panel.section == "objects") {
        panel.title = "Objects";
        panel.detail_tabs = detail_tabs_for("objects");
        if (panel.detail.empty())
            panel.detail = "artifacts";
        build_objects_panel(panel);
    } else if (panel.section == "justice") {
        panel.title = "Justice";
        build_justice_panel(panel);
    } else {
        panel.messages.push_back("Unknown panel section.");
    }

    return panel;
}

std::string info_panel_json(const InfoPanel& panel) {
    std::ostringstream body;
    body << "{"
         << "\"panel\":" << json_string(panel.panel) << ","
         << "\"section\":" << json_string(panel.section) << ","
         << "\"detail\":" << json_string(panel.detail) << ","
         << "\"title\":" << json_string(panel.title) << ","
         << "\"primaryTabs\":";
    append_tabs(body, panel.primary_tabs);
    body << ",\"sectionTabs\":";
    append_tabs(body, panel.section_tabs);
    body << ",\"detailTabs\":";
    append_tabs(body, panel.detail_tabs);
    body << ",\"messages\":";
    append_string_array(body, panel.messages);
    body << ",\"sideItems\":";
    append_string_array(body, panel.side_items);
    body << ",\"trainers\":[";
    for (size_t i = 0; i < panel.trainers.size(); ++i) {
        if (i) body << ",";
        body << "{\"id\":" << panel.trainers[i].first
             << ",\"name\":" << json_string(panel.trainers[i].second) << "}";
    }
    body << "]";
    body << ",\"footer\":" << json_string(panel.footer) << ",\"rows\":[";
    for (size_t i = 0; i < panel.rows.size(); ++i) {
        const auto& row = panel.rows[i];
        if (i) body << ",";
        body << "{"
             << "\"unitId\":" << row.unit_id << ","
             << "\"itemId\":" << row.item_id << ","
             << "\"portraitTexpos\":" << row.portrait_texpos << ","
             << "\"buildingId\":" << row.building_id << ","
             << "\"locationId\":" << row.location_id << ","
             << "\"kind\":" << json_string(row.kind) << ","
             << "\"hasPos\":" << (row.has_pos ? "true" : "false") << ","
             << "\"x\":" << row.x << ","
             << "\"y\":" << row.y << ","
             << "\"z\":" << row.z << ","
             << "\"iconKey\":" << json_string(row.icon_key) << ","
             << "\"iconSheet\":" << json_string(row.icon_sheet) << ","
             << "\"iconX\":" << row.icon_x << ","
             << "\"iconY\":" << row.icon_y << ","
             << "\"iconRow\":" << row.icon_row << ","
             << "\"rt\":" << json_string(row.race_token) << ","
             << "\"ct\":" << json_string(row.caste_token) << ","
             << "\"name\":" << json_string(row.name) << ","
             << "\"subtitle\":" << json_string(row.subtitle) << ","
             << "\"category\":" << json_string(row.category) << ","
             << "\"profession\":" << json_string(row.profession) << ","
             << "\"professionColor\":" << static_cast<int>(row.profession_color) << ","
             << "\"job\":" << json_string(row.job) << ","
             << "\"status\":" << json_string(row.status) << ","
             << "\"jobColor\":" << static_cast<int>(row.job_color) << ","
             << "\"jobNeedDriven\":" << (row.job_need_driven ? "true" : "false") << ","
             << "\"jobBuildingId\":" << row.job_building_id << ","
             << "\"jobHasPos\":" << (row.job_has_pos ? "true" : "false") << ","
             << "\"jobX\":" << row.job_x << ","
             << "\"jobY\":" << row.job_y << ","
             << "\"jobZ\":" << row.job_z << ","
             << "\"jobRepeat\":" << (row.job_repeat ? "true" : "false") << ","
             << "\"jobSuspended\":" << (row.job_suspended ? "true" : "false") << ","
             << "\"jobDoNow\":" << (row.job_do_now ? "true" : "false") << ","
             << "\"muted\":" << (row.muted ? "true" : "false") << ","
             << "\"moodCategory\":" << row.mood_category << ","
             << "\"heldItem\":" << json_string(row.held_item) << ","
             << "\"heldItemId\":" << row.held_item_id << ",";
        // B254. Emitted ONLY for units the labor system applies to (see InfoRow::has_labor_columns).
        // The client presence-checks these keys: ABSENT means "unknown", and it then renders no
        // padlock at all rather than a live control over a state it cannot read or write. That is
        // the same signal an OLD DLL sends by omitting them, so one code path covers both.
        if (row.has_labor_columns) {
            body << "\"specialized\":" << (row.specialized ? "true" : "false") << ","
                 << "\"workDetails\":[";
            for (size_t wd = 0; wd < row.work_details.size(); ++wd) {
                if (wd) body << ",";
                body << "{\"name\":" << json_string(row.work_details[wd].first)
                     << ",\"icon\":" << json_string(row.work_details[wd].second) << "}";
            }
            body << "],";
        }
        body << "\"jobId\":" << row.job_id << ","
             << "\"livestock\":";
        if (row.livestock) {
            body << "{\"slaughter\":" << (row.ls_slaughter ? "true" : "false")
                 << ",\"war\":" << (row.ls_war ? "true" : "false")
                 << ",\"hunt\":" << (row.ls_hunt ? "true" : "false")
                 << ",\"trainableWar\":" << (row.ls_trainable_war ? "true" : "false")
                 << ",\"trainableHunt\":" << (row.ls_trainable_hunt ? "true" : "false")
                 << ",\"pet\":" << (row.ls_pet ? "true" : "false")
                 << ",\"adoption\":" << (row.ls_adoption ? "true" : "false")
                 << ",\"tamable\":" << (row.ls_tamable ? "true" : "false")
                 << ",\"training\":" << (row.ls_training ? "true" : "false")
                 << ",\"taming\":" << (row.ls_taming ? "true" : "false")
                 << ",\"trainerId\":" << row.ls_trainer_id
                 << ",\"geld\":" << (row.ls_geld ? "true" : "false")
                 << ",\"geldable\":" << (row.ls_geldable ? "true" : "false") << "}";
        } else {
            body << "null";
        }
        body << ",\"badges\":";
        append_string_array(body, row.badges);
        body << "}";
    }
    body << "],\"stockItems\":[";
    for (size_t i = 0; i < panel.stock_items.size(); ++i) {
        const auto& item = panel.stock_items[i];
        if (i) body << ",";
        body << "{"
             << "\"itemId\":" << item.item_id << ","
             << "\"count\":" << item.count << ","
             << "\"spriteRef\":{\"itemType\":" << json_string(item.item_type)
             << ",\"itemSubtype\":" << item.item_subtype
             << ",\"materialType\":" << item.material_type
             << ",\"materialIndex\":" << item.material_index << "},"
             << "\"name\":" << json_string(item.name) << ","
             << "\"subtitle\":" << json_string(item.subtitle) << ","
             << "\"status\":" << json_string(item.status) << ","
             << "\"quality\":" << item.quality << ","
             << "\"wear\":" << item.wear << ","
             << "\"artifact\":" << (item.artifact ? "true" : "false") << ","
             << "\"muted\":" << (item.muted ? "true" : "false")
             << "}";
    }
    body << "]}\n";
    return body.str();
}

bool info_panel_on_render_thread(const std::string& panel_name,
                                 const std::string& section,
                                 const std::string& detail,
                                 InfoPanel& panel,
                                 std::string* err,
                                 const std::string& search) {
    std::lock_guard<std::recursive_mutex> lock(g_info_panel_mutex);

    auto request = std::make_shared<RenderThreadPanelRequest>();
    request->panel_name = panel_name;
    request->section = section;
    request->detail = detail;
    request->search = search;
    auto future = request->done.get_future();

    DFHack::runOnRenderThread([request]() {
        try {
            request->panel = build_info_panel(request->panel_name,
                                              request->section,
                                              request->detail,
                                              request->search);
            request->done.set_value(true);
        } catch (const std::exception& ex) {
            request->err = ex.what();
            request->done.set_value(false);
        } catch (...) {
            request->err = "unknown info panel error";
            request->done.set_value(false);
        }
    });

    bool ok = render_future_ready(future) && future.get();
    if (!ok) {
        if (err) *err = request->err;
        return false;
    }
    panel = std::move(request->panel);
    return true;
}

namespace {

struct RenderThreadCancelRequest {
    int32_t job_id = -1;
    std::string err;
    std::promise<bool> done;
};

} // namespace

// WD-22: Tasks tab cancel button. Same recipe as placement.cpp's eraser job-cancel pass
// (DFHack::Job::removeJob on the matched df::job*), run via runOnRenderThread like every other
// mutation/read in this file rather than the CoreSuspender+capture_state_mutex pattern other
// panel files use -- info_panel.cpp has no dependency on sdl_capture.h today and the render
// thread is already the safe place to touch world->jobs.
bool cancel_job_on_render_thread(int32_t job_id, std::string* err) {
    std::lock_guard<std::recursive_mutex> lock(g_info_panel_mutex);

    auto request = std::make_shared<RenderThreadCancelRequest>();
    request->job_id = job_id;
    auto future = request->done.get_future();

    DFHack::runOnRenderThread([request]() {
        try {
            auto world = df::global::world;
            df::job* job = nullptr;
            if (world) {
                for (auto* link = world->jobs.list.next; link; link = link->next) {
                    if (link->item && link->item->id == request->job_id) {
                        job = link->item;
                        break;
                    }
                }
            }
            if (!job) {
                request->err = "job not found";
                request->done.set_value(false);
                return;
            }
            bool removed = DFHack::Job::removeJob(job);
            if (!removed)
                request->err = "removeJob failed";
            request->done.set_value(removed);
        } catch (const std::exception& ex) {
            request->err = ex.what();
            request->done.set_value(false);
        } catch (...) {
            request->err = "unknown cancel error";
            request->done.set_value(false);
        }
    });

    bool ok = render_future_ready(future) && future.get();
    if (!ok && err)
        *err = request->err;
    return ok;
}

namespace {

struct RenderThreadLivestockRequest {
    int32_t unit_id = -1;
    std::string action;
    int32_t trainer_id = -1;   // B33: only consulted by "assign-trainer"
    int32_t owner_id = -1;     // B233-2: only consulted by "assign-work-animal"
    LivestockState state;
    std::string err;
    std::promise<bool> done;
};

struct RenderThreadNicknameRequest {
    int32_t unit_id = -1;
    std::string nickname;
    std::string stored_nickname;
    std::string err;
    std::promise<bool> done;
};

// B16: mirror the current DF flags of one animal into a LivestockState (read-only helper, always
// on the render thread with the unit already validated).
void read_livestock_state(df::unit* unit, LivestockState& s) {
    s.slaughter = Units::isMarkedForSlaughter(unit);
    s.war = Units::isMarkedForWarTraining(unit);
    s.hunt = Units::isMarkedForHuntTraining(unit);
    s.trainable_war = Units::isTrainableWar(unit);
    s.trainable_hunt = Units::isTrainableHunting(unit);
    s.pet = Units::isPet(unit);
    s.adoption = Units::isAvailableForAdoption(unit);
    // B33: trainer-assignment state.
    s.tamable = Units::isTamable(unit) && !Units::isDomesticated(unit);
    s.training = Units::isMarkedForTraining(unit);
    s.taming = Units::isMarkedForTaming(unit);
    s.trainer_id = -1;
    if (s.training) {
        df::training_assignment* asg = binsearch_in_vector(
            df::global::plotinfo->training.training_assignments,
            &df::training_assignment::animal_id, unit->id);
        s.trainer_id = asg ? asg->trainer_id : -1;
    }
    // Husbandry: gelding state (same gate as build_row's ls_geld/ls_geldable).
    s.geld = Units::isMarkedForGelding(unit);
    s.geldable = Units::isGeldable(unit) && !Units::isGelded(unit);
    // B233-2: the work-animal owner field (df.unit.xml:2732 relationship_ids[PetOwner]).
    s.work_animal_owner = unit->relationship_ids[df::unit_relationship_type::PetOwner];
    s.ok = true;
}

// B16: set/clear the war-or-hunt training designation the same way DF's livestock screen does --
// by adding/removing an entry in plotinfo->training.training_assignments (the sorted-by-animal_id
// vector DFHack's Units::isMarkedFor*Training / assignTrainer read and write). War and hunt are
// mutually exclusive on one animal, exactly as in DF. `want_war==false` means hunt. Toggling the
// currently-set kind OFF removes the assignment (matching DFHack's unassignTrainer: erase the
// pointer from the vector, no delete -- avoids any double-free with DF's own references).
void toggle_training(df::unit* unit, bool want_war) {
    auto plotinfo = df::global::plotinfo;
    if (!plotinfo || !unit)
        return;
    auto& vec = plotinfo->training.training_assignments;
    df::training_assignment* asg =
        binsearch_in_vector(vec, &df::training_assignment::animal_id, unit->id);
    bool currently = asg && (want_war ? asg->flags.bits.train_war : asg->flags.bits.train_hunt);
    if (currently) {
        asg->flags.bits.train_war = 0;
        asg->flags.bits.train_hunt = 0;
        erase_from_vector(vec, &df::training_assignment::animal_id, unit->id);
        return;
    }
    if (!asg) {
        asg = new df::training_assignment();
        asg->animal_id = unit->id;
        asg->trainer_id = -1;
        asg->flags.whole = 0;
        asg->flags.bits.any_trainer = true;
        insert_into_vector(vec, &df::training_assignment::animal_id, asg);
    }
    asg->flags.bits.train_war = want_war ? 1 : 0;
    asg->flags.bits.train_hunt = want_war ? 0 : 1;
}

// B33: assign (or re-assign) a trainer to TAME this animal -- DF's "Assign a trainer to this
// creature" action (the ctrl+T workaround the owner had to use). trainer_id == -1 means "any available
// trainer"; a specific unit id restricts the assignment to that dwarf. Mirrors DFHack's
// Units::assignTrainer for the create case, but ALSO updates an existing assignment's trainer in
// place -- without disturbing any war/hunt flag already set -- which assignTrainer itself refuses
// to do (it bails if the animal is already marked for training). Returns false if the caste isn't
// tameable, the animal is already domesticated, or a bad trainer id was given.
bool set_trainer(df::unit* unit, int32_t trainer_id) {
    auto plotinfo = df::global::plotinfo;
    if (!plotinfo || !unit)
        return false;
    if (!Units::isTamable(unit) || Units::isDomesticated(unit))
        return false;
    if (trainer_id != -1 && !df::unit::find(trainer_id))
        return false;
    auto& vec = plotinfo->training.training_assignments;
    df::training_assignment* asg =
        binsearch_in_vector(vec, &df::training_assignment::animal_id, unit->id);
    bool created = false;
    if (!asg) {
        asg = new df::training_assignment();
        asg->animal_id = unit->id;   // set BEFORE insert (the vector is sorted by animal_id)
        asg->flags.whole = 0;
        created = true;
    }
    asg->trainer_id = trainer_id;
    asg->flags.bits.any_trainer = (trainer_id == -1);
    if (created)
        insert_into_vector(vec, &df::training_assignment::animal_id, asg);
    return true;
}

} // namespace

// B233-2: see the long note on the declaration in info_panel.h. Eligibility mirrors DF's own
// AssignWorkAnimal list (a trained war/hunting animal of the fort's own civ) -- the same predicate
// DFHack's WorkAnimalOverlay uses to count a citizen's work animals
// (plugins/lua/sort/info.lua:452-460: isOwnCiv && (isWar || isHunter), keyed on PetOwner).
std::string work_animal_blocked_reason(df::unit* animal) {
    if (!animal)
        return "Animal not found.";
    if (!Units::isAnimal(animal) || !Units::isActive(animal) || Units::isDead(animal))
        return "Only living animals can be work animals.";
    if (!Units::isOwnCiv(animal))
        return "This animal does not belong to your fortress.";
    if (!Units::isTame(animal))
        return "Only tame animals can be assigned as work animals.";
    if (!Units::isWar(animal) && !Units::isHunter(animal))
        return "Only war- or hunting-trained animals can be work animals. Train it first.";
    // The one honest wall: a historical-figure animal's ownership is ALSO recorded in the history
    // graph (histfig_hf_link_pet_ownerst). We write the unit field only, so for a histfig animal
    // that would be a half-write. Refuse instead of desyncing the save; assign it in DF.
    if (animal->hist_figure_id >= 0)
        return "This animal is a historical figure -- DF also stores its ownership in the history "
               "graph, which we cannot write safely yet. Assign it in DF.";
    return "";
}

namespace {

// B233-2 WRITE. owner_id < 0 clears the assignment; otherwise the owner must be a LIVING citizen
// (B214 living predicate -- world.units.active retains corpses and ghosts). One field, one write:
// unit.relationship_ids[PetOwner]. DF's pet AI derives the follow state (unit.following /
// owner_type = PET_MASTER, df.unit.xml:2728-2730) from this field, so there is no second field to
// keep in step.
bool set_work_animal_owner(df::unit* animal, int32_t owner_id, std::string* err) {
    std::string blocked = work_animal_blocked_reason(animal);
    if (!blocked.empty()) {
        if (err) *err = blocked;
        return false;
    }
    if (owner_id >= 0) {
        df::unit* owner = df::unit::find(owner_id);
        if (!owner || !Units::isCitizen(owner, true) || !Units::isActive(owner) ||
                Units::isDead(owner) || Units::isGhost(owner)) {
            if (err) *err = "Work animals can only be assigned to a living citizen.";
            return false;
        }
    }
    animal->relationship_ids[df::unit_relationship_type::PetOwner] = owner_id < 0 ? -1 : owner_id;
    return true;
}

} // namespace

bool livestock_action_on_render_thread(int32_t unit_id, const std::string& action,
                                       LivestockState& out, std::string* err, int32_t trainer_id,
                                       int32_t owner_id) {
    std::lock_guard<std::recursive_mutex> lock(g_info_panel_mutex);

    auto request = std::make_shared<RenderThreadLivestockRequest>();
    request->unit_id = unit_id;
    request->action = action;
    request->trainer_id = trainer_id;
    request->owner_id = owner_id;
    auto future = request->done.get_future();

    DFHack::runOnRenderThread([request]() {
        try {
            df::unit* unit = df::unit::find(request->unit_id);
            if (!unit) {
                request->err = "unit not found";
                request->done.set_value(false);
                return;
            }
            if (!Units::isAnimal(unit) || !Units::isAlive(unit)) {
                request->err = "not a live animal";
                request->done.set_value(false);
                return;
            }
            const std::string& a = request->action;
            if (a == "slaughter") {
                unit->flags2.bits.slaughter = unit->flags2.bits.slaughter ? 0 : 1;
            } else if (a == "war") {
                if (!Units::isTrainableWar(unit)) {
                    request->err = "caste not war-trainable";
                    request->done.set_value(false);
                    return;
                }
                toggle_training(unit, true);
            } else if (a == "hunt") {
                if (!Units::isTrainableHunting(unit)) {
                    request->err = "caste not hunt-trainable";
                    request->done.set_value(false);
                    return;
                }
                toggle_training(unit, false);
            } else if (a == "pet") {
                unit->flags3.bits.available_for_adoption =
                    unit->flags3.bits.available_for_adoption ? 0 : 1;
            } else if (a == "assign-trainer") {
                // B33: assign a trainer to tame this animal (request->trainer_id == -1 => any).
                if (!set_trainer(unit, request->trainer_id)) {
                    request->err = "animal not tameable (or bad trainer)";
                    request->done.set_value(false);
                    return;
                }
            } else if (a == "assign-work-animal") {
                // B233-2: native "Assign this creature as a work animal for a specific citizen or
                // resident" (INFO_ASSIGN_WORK_ANIMAL). owner < 0 clears the assignment.
                if (!set_work_animal_owner(unit, request->owner_id, &request->err)) {
                    request->done.set_value(false);
                    return;
                }
            } else if (a == "unassign-trainer") {
                // B33: cancel the trainer assignment entirely (DFHack Units::unassignTrainer).
                Units::unassignTrainer(unit);
            } else if (a == "geld") {
                // Husbandry: mark/unmark for gelding. Gate exactly as native does -- only a
                // geldable caste (GELDABLE flag) that isn't already gelded. A mis-rendered client
                // that ever POSTs geld on a non-geldable animal is rejected 400, no flag written.
                if (!Units::isGeldable(unit) || Units::isGelded(unit)) {
                    request->err = "animal not geldable (or already gelded)";
                    request->done.set_value(false);
                    return;
                }
                unit->flags3.bits.marked_for_gelding =
                    unit->flags3.bits.marked_for_gelding ? 0 : 1;
            } else {
                request->err = "unsupported livestock action";
                request->done.set_value(false);
                return;
            }
            read_livestock_state(unit, request->state);
            request->done.set_value(true);
        } catch (const std::exception& ex) {
            request->err = ex.what();
            request->done.set_value(false);
        } catch (...) {
            request->err = "unknown livestock action error";
            request->done.set_value(false);
        }
    });

    bool ok = render_future_ready(future) && future.get();
    if (!ok) {
        if (err) *err = request->err;
        return false;
    }
    out = std::move(request->state);
    return true;
}

bool set_unit_nickname_on_render_thread(int32_t unit_id, const std::string& nickname,
                                        std::string& stored_nickname, std::string* err) {
    std::lock_guard<std::recursive_mutex> lock(g_info_panel_mutex);
    auto request = std::make_shared<RenderThreadNicknameRequest>();
    request->unit_id = unit_id;
    request->nickname = nickname.substr(0, 64); // matches the browser field; native names are short
    auto future = request->done.get_future();

    DFHack::runOnRenderThread([request]() {
        try {
            auto unit = df::unit::find(request->unit_id);
            if (!unit) {
                request->err = "unit not found";
                request->done.set_value(false);
                return;
            }
            // This is the field written by DF's native nickname editor. Do not alter the real
            // name, translated words, profession, or unit flags.
            unit->name.nickname = request->nickname;
            request->stored_nickname = unit->name.nickname;
            request->done.set_value(true);
        } catch (const std::exception& ex) {
            request->err = ex.what();
            request->done.set_value(false);
        } catch (...) {
            request->err = "unknown nickname error";
            request->done.set_value(false);
        }
    });

    if (!render_future_ready(future) || !future.get()) {
        if (err) *err = request->err;
        return false;
    }
    stored_nickname = std::move(request->stored_nickname);
    return true;
}

std::string livestock_state_json(int32_t unit_id, const LivestockState& s) {
    std::ostringstream body;
    body << "{\"ok\":true,\"unitId\":" << unit_id
         << ",\"livestock\":{\"slaughter\":" << (s.slaughter ? "true" : "false")
         << ",\"war\":" << (s.war ? "true" : "false")
         << ",\"hunt\":" << (s.hunt ? "true" : "false")
         << ",\"trainableWar\":" << (s.trainable_war ? "true" : "false")
         << ",\"trainableHunt\":" << (s.trainable_hunt ? "true" : "false")
         << ",\"pet\":" << (s.pet ? "true" : "false")
         << ",\"adoption\":" << (s.adoption ? "true" : "false")
         << ",\"tamable\":" << (s.tamable ? "true" : "false")
         << ",\"training\":" << (s.training ? "true" : "false")
         << ",\"taming\":" << (s.taming ? "true" : "false")
         << ",\"trainerId\":" << s.trainer_id
         << ",\"geld\":" << (s.geld ? "true" : "false")
         << ",\"geldable\":" << (s.geldable ? "true" : "false") << "}}\n";
    return body.str();
}

// ---------------------------------------------------------------------------------------------
// HTTP routes, extracted from http_server.cpp's register_routes():
// that function had grown to ~2,750 lines / ~150 inline registrations and was the repo's #1
// merge-conflict site (49 of the last 200 commits). This finishes the register_*_routes() split
// the other 18 modules already used. Handler bodies are unchanged; route behavior is identical.
// NOTE: /panel's error body uses THIS FILE's anonymous-namespace json_string (this module
// predates the shared json_util helpers and keeps its own copy; including json_util.h here
// would make every existing unqualified json_string call ambiguous). The two copies differ
// only in \u zero-padding for control characters, which our fixed ASCII error strings never
// contain. Handlers that stringify USER input (/unit-nickname) live in unit_sheet.cpp, which
// uses the shared json_util implementation.
void register_info_panel_routes(httplib::Server& server) {
    server.Get("/panel", [](const httplib::Request& req, httplib::Response& res) {
        std::string panel_name = req.has_param("panel") ? req.get_param_value("panel") : "citizens";
        std::string section = req.has_param("section") ? req.get_param_value("section") : "";
        std::string detail = req.has_param("detail") ? req.get_param_value("detail") : "";
        std::string search = req.has_param("search") ? req.get_param_value("search") : "";
        if (search.size() > 80)
            search.resize(80);

        InfoPanel panel;
        std::string err;
        if (!info_panel_on_render_thread(panel_name, section, detail, panel, &err, search)) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":" + json_string(err) + "}\n",
                            "application/json; charset=utf-8");
            return;
        }

        res.set_header("Cache-Control", "no-store");
        res.set_content(info_panel_json(panel), "application/json; charset=utf-8");
    });

}

} // namespace dwf
