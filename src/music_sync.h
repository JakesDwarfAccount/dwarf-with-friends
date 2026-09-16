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

#include <cstdint>
#include <string>

namespace httplib { class Server; }

namespace dwf {
namespace music {

// These keys MUST match dwf-audio.js's TRACKS exactly -- the client resolves key -> install path,
// so a key that exists only here points the whole fort's music channel at a 404.
inline bool is_valid_track(const std::string& k) {
    static const char* kKeys[] = {
        "koganusan", "expansive_cavern", "death_spiral", "hill_dwarf", "forgotten_beast",
        "drink_and_industry", "vile_force_of_darkness", "first_year", "another_year",
        "strike_the_earth", "strange_moods", "winter_entombs_you", "craftsdwarfship",
        "mountainhome", "nabidas", "dwarf_fortress", "song_game",
    };
    for (const char* p : kKeys) if (k == p) return true;
    return false;
}

// first_year: 1 = embark year, 0 = established, -1 = unknown. season: 0 spring .. 3 winter.
inline std::string select_auto_track(bool siege, int season, int first_year) {
    if (siege) return "vile_force_of_darkness";   // EVENT:SIEGE
    if (season == 3) return "winter_entombs_you";  // CONTEXT:WINTER
    if (first_year == 1) return "first_year";      // CONTEXT:FIRST_YEAR
    if (first_year == 0) return "another_year";    // CONTEXT:SECOND_YEAR_PLUS
    return "hill_dwarf";                            // CONTEXT:MAIN baseline
}

struct State {
    std::string track = "hill_dwarf";
    int64_t start_ms = 0;   // steady_clock milliseconds
    bool manual = false;    // host override; suppresses auto swaps
};

inline State advance_auto(const State& cur, const std::string& auto_track, int64_t now_ms) {
    if (cur.manual) return cur;
    if (auto_track == cur.track) return cur;
    State next;
    next.track = auto_track;
    next.start_ms = now_ms;
    next.manual = false;
    return next;
}

inline State set_manual(const std::string& track, int64_t now_ms) {
    State next;
    next.track = track;
    next.start_ms = now_ms;
    next.manual = true;
    return next;
}

inline State set_auto(const std::string& auto_track, int64_t now_ms) {
    State next;
    next.track = auto_track;
    next.start_ms = now_ms;
    next.manual = false;
    return next;
}

// JSON fragment with NO leading comma -- the caller splices it into `env`.
inline std::string state_json(const State& s, int64_t now_ms) {
    int64_t elapsed = now_ms - s.start_ms;
    if (elapsed < 0) elapsed = 0;
    return std::string("\"music\":{\"track\":\"") + s.track +
           "\",\"elapsedMs\":" + std::to_string(elapsed) +
           ",\"manual\":" + (s.manual ? "true" : "false") + "}";
}

// ---- Runtime wrapper (mutex + steady_clock over the pure core) -------------------------------
int64_t now_ms();
// Once per aux frame: advances the AUTO state, returns the `env.music` fragment. Thread-safe.
std::string frame_json(bool siege, int season, int first_year);
bool apply_manual(const std::string& track);   // false on an invalid track key
void apply_auto(bool siege, int season, int first_year);

} // namespace music

// Registers POST /music (host-only).
void register_music_route(httplib::Server& server);

} // namespace dwf
