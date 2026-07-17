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
//
// B246/B288/B289 -- see art_desc.h for the full df-structures citation trail. The short version:
//   statue prose           = composed at view time from item_statuest + its resolved art_image
//   figurine prose         = DF's own `art_string`, reached by DF's own getItemShapeDesc() vmethod
//   slab prose             = DF's own `memorial` field on item_slabst
//   engraving prose        = resident vmethods/templates first; per-world bank then DF's native
//                            offscreen view sheet on a lazy-chunk miss. Any final failure stays empty.

#include "art_desc.h"

#include "camera.h"
#include "json_util.h"
#include "native_popup.h"  // native_markup_plain_text -- shared DF MTB token grammar
#include "sdl_capture.h"   // capture_state_mutex() -- the proven lock order is capture mutex first,
                           // THEN CoreSuspender (interaction.cpp:1509-1513 says so explicitly).
#include "unit_portrait.h" // established isolated native view-sheet logic/render rail

#include "Core.h"
// DFHack::runOnRenderThread lives here -- unit_portrait.cpp includes it for the same rail; the
// round-4 wave was authored without access to the shared DFHack build, so the missing
// include only surfaced at the integration build. Same class of
// merge-fix as status_truth.cpp's sdl_capture.h.
#include "modules/DFSDL.h"
#include "DataDefs.h"
#include "MiscUtils.h"
#include "modules/Buildings.h"
#include "modules/Items.h"
#include "modules/Maps.h"
#include "modules/Materials.h"
#include "modules/Translation.h"

#include "df/building.h"
#include "df/building_actual.h"
#include "df/buildingitemst.h"
#include "df/building_type.h"
#include "df/art_image.h"
#include "df/art_image_chunk.h"
#include "df/art_image_chunk_handlerst.h"
#include "df/art_image_chunk_memberst.h"
#include "df/art_image_element.h"
#include "df/art_image_property.h"
#include "df/coord.h"
#include "df/engraving.h"
#include "df/engraving_flags.h"
#include "df/general_ref.h"
#include "df/general_ref_type.h"
#include "df/gamest.h"
#include "df/global_objects.h"
#include "df/historical_figure.h"
#include "df/item.h"
#include "df/item_quality.h"
#include "df/item_slabst.h"
#include "df/item_statuest.h"
#include "df/item_type.h"
#include "df/skill_rating.h"
#include "df/view_sheet_type.h"
#include "df/view_sheets_context_type.h"
#include "df/view_sheets_interfacest.h"
#include "df/world.h"

#include <algorithm>
#include <cctype>
#include <climits>
#include <fstream>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

using namespace DFHack;

namespace dwf {

namespace {

// DF's quality vocabulary, DF's own enum -> DF's own words. (Mirrors interaction.cpp's
// item_quality_name; kept local so this module has no link dependency on that TU.)
std::string quality_name(int32_t quality) {
    switch (quality) {
    case 0: return "Ordinary";
    case 1: return "Well-crafted";
    case 2: return "Finely-crafted";
    case 3: return "Superior";
    case 4: return "Exceptional";
    case 5: return "Masterful";
    default: return "";
    }
}

} // namespace   <-- close the ANONYMOUS namespace here.

// The art_image behind an (art_id, art_subid) pair. Chunks are lazily paged in from art_image_*.dat,
// so a chunk that DF has not loaded is simply ABSENT -- we return nullptr and the caller can take
// the bank/native-sheet miss path. We never guess a replacement image.
// Path matches DFHack's own remotefortressreader.cpp:1516-1526.
//
// MERGE FIX (2026-07-14): B253 EXPORTED this in art_desc.h so world_stream.cpp could share the chunk
// walk instead of growing a second copy -- but its definition was left inside the anonymous
// namespace above. That produced TWO functions with identical signatures (one internal-linkage, one
// declared at dwf scope) and every call site became ambiguous. Each wave compiled in
// isolation; only the merge exposed it. The definition therefore lives at namespace scope, matching
// the header.
df::art_image* find_art_image(int32_t art_id, int16_t art_subid) {
    auto world = df::global::world;
    if (!world || art_id < 0 || art_subid < 0)
        return nullptr;
    for (auto chunk : world->art_image_chunks.all) {
        if (!chunk || chunk->id != art_id)
            continue;
        const int kChunkImages = 500;   // df::art_image_chunk::images[500]
        if (art_subid >= kChunkImages)
            return nullptr;
        return chunk->images[art_subid].art_image;
    }
    return nullptr;
}

namespace {   // <-- reopen the anonymous namespace for the remaining file-private helpers.

// DF's OWN name generator for the artwork ("The Bronze Vault of Mining"), via DFHack's
// Translation::translateName over the art_image's df::language_name. Never composed here.
std::string art_image_name(df::art_image* image) {
    if (!image)
        return "";
    return Translation::translateName(&image->name, false);
}

std::string historical_figure_name(int32_t hfid) {
    if (hfid < 0)
        return "";
    auto hf = df::historical_figure::find(hfid);
    if (!hf)
        return "";
    return Translation::translateName(&hf->name, false);
}

std::string trim_copy(std::string value) {
    auto first = std::find_if_not(value.begin(), value.end(),
                                  [](unsigned char c) { return std::isspace(c); });
    auto last = std::find_if_not(value.rbegin(), value.rend(),
                                 [](unsigned char c) { return std::isspace(c); }).base();
    return first < last ? std::string(first, last) : std::string();
}

// Persistent, per-world art prose bank. The path follows dfcapture.json's established convention:
// relative to the DF working directory, inside dfhack-config. It is append-only because artwork is
// immutable after creation; a later duplicate key supersedes an earlier record when loaded.
//
// Format (one tab-separated record per line; all free-form UTF-8 is hex encoded):
//   DWF_ART_PROSE_V1 <world_hex> <I|E> <art_id> <subid> <x> <y> <z> <raw_hex> <plain_hex>
// Item keys use x/y/z=-1. Engravings additionally include their tile so identical art used on two
// surfaces remains independently addressable. raw_hex preserves DF's [C:f:b:br] tokens verbatim.
constexpr const char* kArtBankPath = "dfhack-config/dfcapture-art-prose.bank";
constexpr const char* kArtBankVersion = "DWF_ART_PROSE_V1";

struct ArtBankKey {
    std::string world;
    char kind = 'I';
    int32_t art_id = -1;
    int16_t art_subid = -1;
    int32_t x = -1, y = -1, z = -1;

    bool operator<(const ArtBankKey& other) const {
        if (world != other.world) return world < other.world;
        if (kind != other.kind) return kind < other.kind;
        if (art_id != other.art_id) return art_id < other.art_id;
        if (art_subid != other.art_subid) return art_subid < other.art_subid;
        if (x != other.x) return x < other.x;
        if (y != other.y) return y < other.y;
        return z < other.z;
    }
};

struct ArtBankEntry {
    std::string raw_markup;
    std::string plain_text;
};

std::mutex g_art_bank_mutex;
std::map<ArtBankKey, ArtBankEntry> g_art_bank;
bool g_art_bank_loaded = false;
std::mutex g_art_compose_queue; // one native sheet in flight; waiting callers form the queue.

std::string hex_encode(const std::string& value) {
    static constexpr char digits[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(value.size() * 2);
    for (unsigned char c : value) {
        out.push_back(digits[c >> 4]);
        out.push_back(digits[c & 15]);
    }
    return out;
}

int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool hex_decode(const std::string& value, std::string& out) {
    if (value.size() % 2 != 0)
        return false;
    out.clear();
    out.reserve(value.size() / 2);
    for (size_t i = 0; i < value.size(); i += 2) {
        int hi = hex_nibble(value[i]);
        int lo = hex_nibble(value[i + 1]);
        if (hi < 0 || lo < 0)
            return false;
        out.push_back(static_cast<char>((hi << 4) | lo));
    }
    return true;
}

std::vector<std::string> split_tabs(const std::string& line) {
    std::vector<std::string> fields;
    size_t start = 0;
    for (;;) {
        size_t tab = line.find('\t', start);
        fields.push_back(line.substr(start, tab == std::string::npos ? tab : tab - start));
        if (tab == std::string::npos)
            return fields;
        start = tab + 1;
    }
}

bool decode_bank_line(const std::string& line, ArtBankKey& key, ArtBankEntry& entry) {
    if (line.size() > 1024 * 1024)
        return false;
    std::vector<std::string> f = split_tabs(line);
    if (f.size() != 10 || f[0] != kArtBankVersion || f[2].size() != 1 ||
        (f[2][0] != 'I' && f[2][0] != 'E'))
        return false;
    try {
        long long art_id = std::stoll(f[3]);
        long long subid = std::stoll(f[4]);
        long long x = std::stoll(f[5]);
        long long y = std::stoll(f[6]);
        long long z = std::stoll(f[7]);
        if (art_id < 0 || art_id > INT32_MAX || subid < 0 || subid > INT16_MAX ||
            x < INT32_MIN || x > INT32_MAX || y < INT32_MIN || y > INT32_MAX ||
            z < INT32_MIN || z > INT32_MAX)
            return false;
        key.kind = f[2][0];
        key.art_id = static_cast<int32_t>(art_id);
        key.art_subid = static_cast<int16_t>(subid);
        key.x = static_cast<int32_t>(x);
        key.y = static_cast<int32_t>(y);
        key.z = static_cast<int32_t>(z);
    } catch (...) {
        return false;
    }
    return hex_decode(f[1], key.world) && hex_decode(f[8], entry.raw_markup) &&
           hex_decode(f[9], entry.plain_text) && !key.world.empty() &&
           !entry.plain_text.empty();
}

std::string encode_bank_line(const ArtBankKey& key, const ArtBankEntry& entry) {
    std::ostringstream out;
    out << kArtBankVersion << '\t' << hex_encode(key.world) << '\t' << key.kind << '\t'
        << key.art_id << '\t' << key.art_subid << '\t' << key.x << '\t' << key.y << '\t'
        << key.z << '\t' << hex_encode(entry.raw_markup) << '\t' << hex_encode(entry.plain_text)
        << '\n';
    return out.str();
}

void load_art_bank_locked() {
    if (g_art_bank_loaded)
        return;
    g_art_bank_loaded = true;
    std::ifstream in(kArtBankPath, std::ios::binary);
    std::string line;
    size_t accepted = 0;
    while (accepted < 100000 && std::getline(in, line)) {
        ArtBankKey key;
        ArtBankEntry entry;
        if (!decode_bank_line(line, key, entry))
            continue;
        g_art_bank[key] = std::move(entry);
        ++accepted;
    }
}

bool bank_lookup(const ArtBankKey& key, ArtBankEntry& entry, bool allow_disk_load) {
    std::lock_guard<std::mutex> lock(g_art_bank_mutex);
    if (allow_disk_load)
        load_art_bank_locked();
    if (!g_art_bank_loaded)
        return false; // Never perform first-use disk I/O while a caller holds CoreSuspender.
    auto it = g_art_bank.find(key);
    if (it == g_art_bank.end())
        return false;
    entry = it->second;
    return true;
}

void bank_store(const ArtBankKey& key, const ArtBankEntry& entry) {
    if (key.world.empty() || entry.plain_text.empty())
        return;
    std::lock_guard<std::mutex> lock(g_art_bank_mutex);
    load_art_bank_locked();
    auto it = g_art_bank.find(key);
    if (it != g_art_bank.end() && it->second.raw_markup == entry.raw_markup &&
        it->second.plain_text == entry.plain_text)
        return;
    g_art_bank[key] = entry;
    std::ofstream out(kArtBankPath, std::ios::binary | std::ios::app);
    if (out)
        out << encode_bank_line(key, entry);
}

std::string current_world_key() {
    auto world = df::global::world;
    return world ? world->cur_savegame.save_dir : std::string();
}

ArtBankKey item_bank_key(const std::string& world, int32_t art_id, int16_t art_subid) {
    ArtBankKey key;
    key.world = world;
    key.kind = 'I';
    key.art_id = art_id;
    key.art_subid = art_subid;
    return key;
}

ArtBankKey engraving_bank_key(const std::string& world, int32_t art_id, int16_t art_subid,
                              int32_t x, int32_t y, int32_t z) {
    ArtBankKey key = item_bank_key(world, art_id, art_subid);
    key.kind = 'E';
    key.x = x; key.y = y; key.z = z;
    return key;
}

std::string english_join(const std::vector<std::string>& parts) {
    if (parts.empty())
        return "";
    if (parts.size() == 1)
        return parts.front();
    if (parts.size() == 2)
        return parts[0] + " and " + parts[1];
    std::string out;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i)
            out += (i + 1 == parts.size()) ? ", and " : ", ";
        out += parts[i];
    }
    return out;
}

// DF itself supplies every element phrase, including counts, historical-figure names, creature
// castes, item names, and plant names. df.art_image.xml:22-27, vmethod original-name `get_string`.
std::string art_elements_description(df::art_image* image) {
    if (!image)
        return "";
    std::vector<std::string> parts;
    for (auto element : image->elements) {
        if (!element)
            continue;
        std::string name;
        element->getName(&name, false, true, false);
        name = trim_copy(std::move(name));
        if (!name.empty())
            parts.push_back(std::move(name));
    }
    return english_join(parts);
}

// These are byte-for-byte DF's quality phrases. B288-1 proves `masterfully designed`; the other
// four live beside it in Dwarf Fortress.exe and are the same vocabulary used by the native art
// formatter. Unknown/Artifact is deliberately unsupported: returning empty is safer than guessing.
std::string designed_image_phrase(int32_t quality) {
    switch (quality) {
    case 0: return "an image of ";
    case 1: return "a well-designed image of ";
    case 2: return "a finely-designed image of ";
    case 3: return "a superiorly designed image of ";
    case 4: return "an exceptionally designed image of ";
    case 5: return "a masterfully designed image of ";
    default: return "";
    }
}

// Native item-quality words are not the image-quality words above. In particular, quality 1 is
// "well-crafted" on the item sentence but "well-designed" on the art-image sentence. Ordinary
// items have no adjective; Artifact is deliberately unsupported until an oracle establishes the
// outer item sentence used for artifact statues.
std::string item_quality_phrase(int32_t quality) {
    switch (quality) {
    case 0: return "";
    case 1: return "well-crafted ";
    case 2: return "finely-crafted ";
    case 3: return "superior ";
    case 4: return "exceptional ";
    case 5: return "masterful ";
    default: return "";
    }
}

void append_sentence(std::string& body, std::string sentence) {
    sentence = trim_copy(std::move(sentence));
    if (sentence.empty())
        return;
    if (!body.empty())
        body += " ";
    body += sentence;
    char last = body.back();
    if (last != '.' && last != '!' && last != '?')
        body += ".";
}

// df.reference.xml:217-220 exposes general_ref::getDescription, DF's own `descriptive_string`
// vmethod. For an ENTITY_ART_IMAGE reference it returns the referenced entity/name/type phrase;
// B288-1 supplies the native outer sentence that identifies that phrase as the image's symbol.
std::string art_reference_sentence(df::art_image* image) {
    if (!image || !image->ref ||
        image->ref->getType() != df::general_ref_type::ENTITY_ART_IMAGE)
        return "";
    std::string reference;
    image->ref->getDescription(&reference, 0);
    reference = trim_copy(std::move(reference));
    if (reference.empty())
        return "";
    if (reference.rfind("The image ", 0) == 0)
        return reference;
    // Only DF's own complete sentence (the rfind branch above) is trusted. The former
    // "The image is the symbol of " + reference reconstruction was a hard-coded wrapper NOT emitted
    // by any DF vmethod -- reverse-engineered from oracle B288-1. Until a live-DF check confirms what
    // general_ref_entity_art_image::getDescription actually returns for this ref type, DROP the clause
    // rather than risk shipping invented prose (the B255/B265/B274 hazard). The main rendition sentence
    // is unaffected; only this trailing "symbol of ..." clause is withheld. Re-enable once the live
    // oracle confirms getDescription yields the full phrase.
    return "";
}

std::string art_properties_description(df::art_image* image) {
    if (!image)
        return "";
    std::string out;
    for (auto property : image->properties) {
        if (!property)
            continue;
        std::string sentence;
        // df.art_image.xml:94-99, vmethod original-name `get_string`. `full_desc=true` is the same
        // long-form channel used by the native sheet; markup stays off for JSON/plain text.
        property->getName(&sentence, image, true, false);
        append_sentence(out, std::move(sentence));
    }
    return out;
}

// DF 53.15 does not persist the statue paragraph in item_statuest.description. Live item 4141
// proved that field is only the subject name ("Avafi Blazebears"). DF composes the paragraph when
// it opens the sheet. Reproduce only the oracle-attested grammar while sourcing every variable part
// from DF: item quality/material/subject plus art-image quality/elements/artist/properties.
std::string statue_description(df::item_statuest* statue, df::art_image* image) {
    if (!statue || !image)
        return "";
    const int32_t item_quality = statue->getOverallQuality();
    if (item_quality < 0 || item_quality > 5)
        return "";
    const std::string subject = trim_copy(statue->description);
    const std::string elements = art_elements_description(image);
    const std::string image_phrase = designed_image_phrase(static_cast<int32_t>(image->quality));
    const std::string artist = historical_figure_name(image->artist);
    // Force the df::item* overload. MaterialInfo's generic pointer template expects public
    // mat_type/mat_index fields, while items expose material through virtual accessors.
    MaterialInfo material(static_cast<df::item*>(statue));
    const std::string material_name = material.isValid() ? trim_copy(material.toString()) : "";
    if (subject.empty() || elements.empty() || image_phrase.empty() || artist.empty() ||
        material_name.empty())
        return "";

    std::string out = "This is a " + item_quality_phrase(item_quality) + material_name +
                      " statue of " + subject + ".  The item is " + image_phrase + elements +
                      " in " + material_name + " by " + artist + ".";
    const std::string properties = art_properties_description(image);
    if (!properties.empty())
        out += " " + properties;
    return out;
}

std::string engraving_description(df::engraving* engraving, df::art_image* image,
                                   const std::string& english_art_name) {
    if (!engraving || !image)
        return "";
    const std::string artist = historical_figure_name(engraving->artist);
    const std::string elements = art_elements_description(image);
    const std::string image_phrase = designed_image_phrase(static_cast<int32_t>(engraving->quality));
    if (artist.empty() || elements.empty() || image_phrase.empty())
        return "";

    std::string out;
    const bool rendition = image->ref &&
        image->ref->getType() == df::general_ref_type::ENTITY_ART_IMAGE;
    if (rendition) {
        if (english_art_name.empty())
            return "";
        append_sentence(out, "Engraved is a " + artist + " rendition of " + english_art_name +
                             ", " + image_phrase + elements);
        append_sentence(out, art_reference_sentence(image));
    } else {
        // Rule ledger 0004: the native engraving view sheet uses "wall" in this simple
        // sentence even when the engraving's physical-surface flag says floor. Keep the
        // physical truth in EngravingArt::floor and the serialized surface field.
        append_sentence(out, "Engraved on the wall is " + image_phrase + elements +
                             " by " + artist);
    }
    const std::string properties = art_properties_description(image);
    if (!properties.empty()) {
        if (!out.empty()) out += " ";
        out += properties;
    }
    return out;
}

// DF does not expose a dedicated item-description builder widget. df.d_interface.xml:1685-1881
// identifies the actual native builder state: main_interface.view_sheets, with ITEM/ENGRAVING
// targets and raw_description/description outputs. markup_text_box_widget only renders a box that
// somebody else already populated and has no item/engraving target. This therefore maps 1:1 onto
// generate_unit_portrait_with_view_sheet: identity-only snapshot, native logic, isolated offscreen
// render, exact identity restoration. The host's visible sheet is never opened or painted.
struct NativeSheetIdentitySnapshot {
    df::view_sheets_interfacest& sheets;
    bool open;
    df::view_sheets_context_type context;
    df::view_sheet_type active_sheet;
    int32_t active_id;
    std::vector<int32_t> viewing_unid;
    std::vector<int32_t> viewing_itid;
    int32_t viewing_bldid;
    std::vector<int32_t> viewing_vermin_combined_id;
    int32_t viewing_x, viewing_y, viewing_z;
    int32_t scroll_position;
    bool scrolling;
    int32_t active_sub_tab;
    decltype(df::view_sheets_interfacest::last_tick_update) last_tick_update;
    int32_t scroll_position_item;
    bool scrolling_item;
    int32_t scroll_position_description;
    bool scrolling_description;

    explicit NativeSheetIdentitySnapshot(df::view_sheets_interfacest& value)
        : sheets(value), open(value.open), context(value.context), active_sheet(value.active_sheet),
          active_id(value.active_id), viewing_unid(value.viewing_unid),
          viewing_itid(value.viewing_itid), viewing_bldid(value.viewing_bldid),
          viewing_vermin_combined_id(value.viewing_vermin_combined_id),
          viewing_x(value.viewing_x), viewing_y(value.viewing_y), viewing_z(value.viewing_z),
          scroll_position(value.scroll_position), scrolling(value.scrolling),
          active_sub_tab(value.active_sub_tab), last_tick_update(value.last_tick_update),
          scroll_position_item(value.scroll_position_item), scrolling_item(value.scrolling_item),
          scroll_position_description(value.scroll_position_description),
          scrolling_description(value.scrolling_description) {}

    ~NativeSheetIdentitySnapshot() {
        sheets.open = open;
        sheets.context = context;
        sheets.active_sheet = active_sheet;
        sheets.active_id = active_id;
        sheets.viewing_unid.swap(viewing_unid);
        sheets.viewing_itid.swap(viewing_itid);
        sheets.viewing_bldid = viewing_bldid;
        sheets.viewing_vermin_combined_id.swap(viewing_vermin_combined_id);
        sheets.viewing_x = viewing_x;
        sheets.viewing_y = viewing_y;
        sheets.viewing_z = viewing_z;
        sheets.scroll_position = scroll_position;
        sheets.scrolling = scrolling;
        sheets.active_sub_tab = active_sub_tab;
        sheets.last_tick_update = last_tick_update;
        sheets.scroll_position_item = scroll_position_item;
        sheets.scrolling_item = scrolling_item;
        sheets.scroll_position_description = scroll_position_description;
        sheets.scrolling_description = scrolling_description;
    }
};

bool compose_native_art_sheet(const ArtBankKey& key, int32_t item_id,
                              ArtBankEntry& entry, std::string& err) {
#ifdef _WIN32
    auto game = df::global::game;
    if (!game || !df::global::world || current_world_key() != key.world) {
        err = "world/game changed before native art composition";
        return false;
    }
    auto& sheets = game->main_interface.view_sheets;
    if (sheets.open) {
        err = "host view sheet is open; native art composition deferred";
        return false;
    }

    df::item* item = nullptr;
    if (key.kind == 'I') {
        item = df::item::find(item_id);
        if (!item) {
            err = "art item no longer exists";
            return false;
        }
        bool identity_matches = false;
        if (auto statue = virtual_cast<df::item_statuest>(item)) {
            identity_matches = statue->image.id == key.art_id &&
                               statue->image.subid == key.art_subid;
        } else {
            int32_t* live_art_id = nullptr;
            int16_t* live_art_subid = nullptr;
            item->getImageRef(&live_art_id, &live_art_subid);
            identity_matches = live_art_id && live_art_subid && *live_art_id == key.art_id &&
                               *live_art_subid == key.art_subid;
        }
        if (!identity_matches) {
            err = "art item identity changed before native composition";
            return false;
        }
    } else {
        bool found = false;
        for (auto engraving : df::global::world->event.engravings) {
            if (engraving && engraving->pos.x == key.x && engraving->pos.y == key.y &&
                engraving->pos.z == key.z && engraving->art_id == key.art_id &&
                engraving->art_subid == key.art_subid) {
                found = true;
                break;
            }
        }
        if (!found) {
            err = "engraving identity changed before native composition";
            return false;
        }
    }

    NativeSheetIdentitySnapshot restore(sheets);
    sheets.open = true;
    sheets.context = df::view_sheets_context_type::REGULAR_PLAY;
    sheets.active_sheet = key.kind == 'I' ? df::view_sheet_type::ITEM
                                          : df::view_sheet_type::ENGRAVING;
    sheets.active_id = item ? item->id : -1;
    sheets.viewing_unid.clear();
    sheets.viewing_itid.clear();
    if (item)
        sheets.viewing_itid.push_back(item->id);
    sheets.viewing_bldid = -1;
    sheets.viewing_vermin_combined_id.clear();
    sheets.viewing_x = item ? item->pos.x : key.x;
    sheets.viewing_y = item ? item->pos.y : key.y;
    sheets.viewing_z = item ? item->pos.z : key.z;
    sheets.scroll_position = 0;
    sheets.scrolling = false;
    sheets.active_sub_tab = 0;
    sheets.scroll_position_item = 0;
    sheets.scrolling_item = false;
    sheets.scroll_position_description = 0;
    sheets.scrolling_description = false;

    // Clearing only this ownership-free string prevents a stale closed sheet from looking like a
    // successful build. Never copy/restore the whole view_sheets_interfacest: its pointer vectors
    // own DF allocations, and the portrait postmortem proves whole-struct restoration double-frees.
    for (int attempt = 0; attempt < 3; ++attempt) {
        sheets.last_tick_update = 0;
        sheets.raw_description.clear();
        if (!native_viewscreen_logic_render_isolated(&err))
            return false;
        // Do not bank a generic item fallback forever. Success means DF's sheet actually paged the
        // requested immutable art record AND produced its description, not merely that some text
        // happened to appear in the shared closed-sheet buffer.
        if (!find_art_image(key.art_id, key.art_subid))
            continue;
        entry.raw_markup = sheets.raw_description;
        entry.plain_text = trim_copy(native_markup_plain_text(entry.raw_markup));
        if (!entry.plain_text.empty())
            return true;
    }
    err = "native art view sheet produced no description";
    return false;
#else
    (void)key; (void)item_id; (void)entry;
    err = "native art composition is Windows-only";
    return false;
#endif
}

struct NativeArtRequest {
    ArtBankKey key;
    int32_t item_id = -1;
    ArtBankEntry entry;
    std::string err;
    std::promise<bool> done;
};

bool bank_or_compose(const ArtBankKey& key, int32_t item_id, ArtBankEntry& entry) {
    if (key.world.empty() || key.art_id < 0 || key.art_subid < 0)
        return false;
    std::lock_guard<std::mutex> queue(g_art_compose_queue);
    if (bank_lookup(key, entry, true))
        return true; // A request ahead of us may have filled it while this caller waited.

    auto request = std::make_shared<NativeArtRequest>();
    request->key = key;
    request->item_id = item_id;
    auto future = request->done.get_future();
    bool composed = false;
    {
        // Same lock posture as unit_portrait_on_render_thread: the HTTP thread owns the capture
        // mutex while DF's render-thread callback performs native logic + isolated render.
        std::lock_guard<std::recursive_mutex> render_lock(capture_state_mutex());
        try {
            DFHack::runOnRenderThread([request]() {
                bool ok = false;
                try {
                    ok = compose_native_art_sheet(request->key, request->item_id,
                                                  request->entry, request->err);
                } catch (...) {
                    request->err = "exception during native art composition";
                }
                request->done.set_value(ok);
            });
            composed = future.get();
        } catch (...) {
            composed = false;
        }
    }
    if (!composed || request->entry.plain_text.empty())
        return false;
    entry = request->entry;
    bank_store(key, entry);
    return true;
}

} // namespace

bool complete_item_art_prose(ItemArt& art) {
    if (!art.description.empty())
        return true; // Resident-chunk round-3 composition is the free first path.
    ArtBankEntry entry;
    ArtBankKey key = item_bank_key(art.world_key, art.art_id, art.art_subid);
    if (!bank_or_compose(key, art.item_id, entry))
        return false;
    art.description = entry.plain_text;
    return !art.description.empty();
}

bool complete_engraving_art_prose(EngravingArt& art) {
    if (!art.description.empty())
        return true; // Resident-chunk round-3 composition is the free first path.
    ArtBankEntry entry;
    ArtBankKey key = engraving_bank_key(art.world_key, art.art_id, art.art_subid,
                                        art.x, art.y, art.z);
    if (!bank_or_compose(key, -1, entry))
        return false;
    art.description = entry.plain_text;
    return !art.description.empty();
}

ItemArt item_art(df::item* item) {
    ItemArt out;
    if (!item)
        return out;
    out.present = true;
    out.item_id = item->id;
    out.world_key = current_world_key();
    out.title = Items::getDescription(item, 0, true);
    out.base_description = Items::getDescription(item, 0, false);
    if (out.base_description.empty())
        out.base_description = out.title;
    out.quality = item->getOverallQuality();

    // (1) DF'S OWN ART SUBJECT/STRING, via DF'S OWN VMETHOD.
    // df/item.h:145 -- `virtual std::string* getItemShapeDesc()`, df-structures
    // df.item.xml:602 `original-name='get_art_string_ptr'`, comment: 'a statue/figurine of "string
    // goes here"'. DF returns &this->description for item_statuest / item_figurinest (both have
    // <stl-string name='description' original-name='art_string'/>), and nullptr for every item class
    // that carries no art string. Dispatching through DF's vtable rather than switching on item type
    // is deliberate: the vtable IS DF's authoritative enumeration of which items have art prose.
    if (std::string* art_string = item->getItemShapeDesc()) {
        if (!art_string->empty())
            out.description = *art_string;
    }

    // (2) SLABS. A slab's engraved text is DF's `memorial` field (df.item.xml:1546), which is NOT an
    // art_string and so is NOT routed through get_art_string_ptr. Still DF's stored string.
    if (out.description.empty()) {
        if (auto slab = virtual_cast<df::item_slabst>(item)) {
            if (!slab->description.empty())
                out.description = slab->description;
        }
    }

    // (3) Resolve the artwork. item_statuest owns the exact pair directly:
    // df.item.xml:1533-1540 item_statuest.image.id (`art_image_chunk_id`) + .subid
    // (`art_image_chunk_member`), generated as df/item_statuest.h::T_image. That pair enters the
    // same find_art_image chunk walk used by engravings. The base item vmethod remains the correct
    // generic accessor for figurines and other art-bearing item classes.
    df::art_image* image = nullptr;
    auto statue = virtual_cast<df::item_statuest>(item);
    if (statue) {
        out.art_id = statue->image.id;
        out.art_subid = statue->image.subid;
        image = find_art_image(statue->image.id, statue->image.subid);
    }
    int32_t* image_id = nullptr;
    int16_t* image_subid = nullptr;
    if (!image) {
        item->getImageRef(&image_id, &image_subid);
        if (image_id && image_subid) {
            out.art_id = *image_id;
            out.art_subid = *image_subid;
            image = find_art_image(*image_id, *image_subid);
        }
    }
    if (image)
        out.art_name = art_image_name(image);

    // A statue's stored string is only its subject name, not prose. A resolved image lets us compose
    // the native paragraph; an unresolved image deliberately clears the subject-only body so the
    // client falls back to the already-shipped title + item-quality + base-name rows.
    if (statue)
        out.description = image ? statue_description(statue, image) : "";

    // Residency-aware second path. Never load the file here: callers hold CoreSuspender, and a
    // first-use disk read would stall the fortress. Detailed click routes call complete_* outside
    // the suspend; once loaded, every other art read can take this in-memory bank hit for free.
    if (statue && out.description.empty() && out.art_id >= 0 && out.art_subid >= 0) {
        ArtBankEntry banked;
        if (bank_lookup(item_bank_key(out.world_key, out.art_id, out.art_subid), banked, false))
            out.description = banked.plain_text;
    }

    // (4) The SPRITE -- the SAME item art channel the item sheet and the occupant rail already use.
    out.sprite.item_type = DFHack::enum_item_key(item->getType());
    out.sprite.item_subtype = item->getSubtype();
    out.sprite.material_type = item->getMaterial();
    out.sprite.material_index = item->getMaterialIndex();
    return out;
}

ItemArt building_art(df::building* building) {
    ItemArt out;
    if (!building)
        return out;
    // A statue is a BUILDING (df::building_statuest) that DF constructed OUT OF an ITEM
    // (df::item_statuest). building_statuest itself holds no art at all -- it has exactly one field,
    // an unused `statue_flag` (df/building_statuest.h). ALL of the art -- the description AND the
    // material/type that make the sprite -- lives on the contained item. That is the whole reason the
    // B246 panel showed neither: /building-info only ever looked at the building.
    auto actual = virtual_cast<df::building_actual>(building);
    if (!actual)
        return out;
    bool statue = building->getType() == df::building_type::Statue;
    for (auto contained : actual->contained_items) {
        if (!contained || !contained->item)
            continue;
        ItemArt candidate = item_art(contained->item);
        if (!candidate.has_art() && !statue)
            continue;                      // a chair's contained item has no art string: skip, mute.
        return candidate;                  // a statue's sole item also wins as the empty-art fallback.
    }
    return out;
}

bool engraving_art_at(const df::coord& pos, EngravingArt& out) {
    auto world = df::global::world;
    if (!world)
        return false;
    // B24 established the vector: world->event.engravings (there is no world->engravings in this
    // structures version). interaction.cpp:669-680 already walks it for the hover's "Engraved "
    // prefix -- which is exactly the proof that the DATA was reachable all along and only the
    // SELECTION path was missing.
    for (auto e : world->event.engravings) {
        if (!e || e->pos.x != pos.x || e->pos.y != pos.y || e->pos.z != pos.z)
            continue;
        out.present = true;
        out.world_key = current_world_key();
        out.x = pos.x;
        out.y = pos.y;
        out.z = pos.z;
        out.quality = static_cast<int32_t>(e->quality);
        out.artist_id = e->artist;
        out.artist_name = historical_figure_name(e->artist);
        out.skill = DFHack::enum_item_key(e->skill_rating);
        out.floor = e->flags.bits.floor;
        out.hidden = e->flags.bits.hidden;
        out.art_id = e->art_id;
        out.art_subid = e->art_subid;
        if (auto image = find_art_image(e->art_id, e->art_subid)) {
            const std::string native_name = Translation::translateName(&image->name, false);
            const std::string english_name = Translation::translateName(&image->name, true);
            out.art_name = !english_name.empty() ? english_name : native_name;
            out.title = native_name;
            if (!english_name.empty() && english_name != native_name) {
                if (!out.title.empty()) out.title += ", ";
                out.title += "\"" + english_name + "\"";
            }
            if (out.title.empty())
                out.title = out.art_name;
            out.description = engraving_description(e, image, out.art_name);
        }
        if (out.description.empty() && out.art_id >= 0 && out.art_subid >= 0) {
            ArtBankEntry banked;
            if (bank_lookup(engraving_bank_key(out.world_key, out.art_id, out.art_subid,
                                               out.x, out.y, out.z), banked, false))
                out.description = banked.plain_text;
        }
        return true;
    }
    return false;
}

void append_item_art_json(std::ostringstream& body, const ItemArt& art) {
    if (!art.present)
        return;
    // `artDescription` remains DF'S OWN SENTENCE or absent. `artBaseDescription` is separately
    // labelled DF item-name fallback data; keeping the keys distinct prevents the B236 defect where
    // a title was misrepresented as generated prose.
    body << ",\"artTitle\":" << json_string(art.title)
         << ",\"artDescription\":" << json_string(art.description)
         << ",\"artBaseDescription\":" << json_string(art.base_description)
         << ",\"artName\":" << json_string(art.art_name)
         << ",\"artQuality\":" << art.quality
         << ",\"artQualityName\":" << json_string(quality_name(art.quality))
         << ",\"artItemId\":" << art.item_id;
    if (art.sprite.present()) {
        body << ",\"spriteRef\":{\"itemType\":" << json_string(art.sprite.item_type)
             << ",\"itemSubtype\":" << art.sprite.item_subtype
             << ",\"materialType\":" << art.sprite.material_type
             << ",\"materialIndex\":" << art.sprite.material_index << "}";
    } else {
        body << ",\"spriteRef\":null";
    }
}

std::string engraving_art_json(const EngravingArt& art) {
    std::ostringstream body;
    body << "{\"ok\":true,\"present\":" << (art.present ? "true" : "false");
    if (!art.present) {
        body << "}\n";
        return body.str();
    }
    body << ",\"tile\":{\"x\":" << art.x << ",\"y\":" << art.y << ",\"z\":" << art.z << "}"
         << ",\"title\":" << json_string(art.title)
         << ",\"artName\":" << json_string(art.art_name)
         << ",\"quality\":" << art.quality
         << ",\"qualityName\":" << json_string(quality_name(art.quality))
         << ",\"skill\":" << json_string(art.skill)
         << ",\"artistId\":" << art.artist_id
         << ",\"artistName\":" << json_string(art.artist_name)
         << ",\"surface\":" << json_string(art.floor ? "floor" : "wall")
         << ",\"obscured\":" << (art.hidden ? "true" : "false")
         // Empty means one of DF's required formatter inputs was unavailable. The client renders
         // no substitute sentence and no explanatory prose in that case.
         << ",\"descriptionAvailable\":" << (!art.description.empty() ? "true" : "false")
         << ",\"description\":" << json_string(art.description)
         << "}\n";
    return body.str();
}

void register_art_desc_routes(httplib::Server& server) {
    // /engraving-info?x=&y=&z=  -- read-only. Never moves the camera (B216): it takes an explicit
    // tile, not a pixel, so opening the panel cannot re-derive or nudge a viewport.
    server.Get("/engraving-info", [](const httplib::Request& req, httplib::Response& res) {
        int x = 0, y = 0, z = 0;
        if (!query_int(req, "x", x) || !query_int(req, "y", y) || !query_int(req, "z", z)) {
            res.status = 400;
            res.set_content("missing x/y/z\n", "text/plain; charset=utf-8");
            return;
        }
        EngravingArt art;
        {
            std::lock_guard<std::recursive_mutex> lock(capture_state_mutex());
            DFHack::CoreSuspender suspend;
            if (!df::global::world) {
                res.status = 503;
                res.set_content("{\"ok\":false,\"error\":\"world unavailable\"}\n",
                                "application/json; charset=utf-8");
                return;
            }
            engraving_art_at(df::coord(x, y, z), art);
        }
        // The suspended read above takes the free resident-chunk path and any already-loaded bank
        // hit. Only a true miss reaches DF's native offscreen sheet, outside CoreSuspender.
        if (art.present && art.description.empty())
            complete_engraving_art_prose(art);
        res.set_header("Cache-Control", "no-store");
        res.set_content(engraving_art_json(art), "application/json; charset=utf-8");
    });
}

} // namespace dwf
