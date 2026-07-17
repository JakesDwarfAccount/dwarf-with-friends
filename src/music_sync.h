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

// music_sync.h -- SERVER-AUTHORITATIVE, SYNCED music state (PARITY V2 correction #1).
//
// Before V2 every browser picked its OWN track (each client ran the CONTEXT/EVENT rules
// independently) -- The owner: "I want everyone synced up, not random from a list." DFHack cannot read
// DF's native music engine, so exact host-speaker mirroring is impossible; instead the SERVER
// computes ONE canonical music state and every client plays THAT track, seeked to the server-
// provided elapsed -- so late joiners land mid-track and two tabs are in lockstep.
//
// The canonical state = {track, start_ms, manual}. It is emitted every aux frame as an additive
// JSON object inside `env` (env.music) -- the SAME channel/pattern as env.siege, so the golden
// binary-wire CRC (0x538DEA9C) is untouched and late joiners get the current state for free from
// the aux stream (no relay, no per-client server mixing, no host-election).
//
//   * AUTO mode: the server re-derives the track each frame from DF's own music_standard.txt
//     trigger rules using signals it already has (env.siege / env.season / [year]). The start
//     timestamp resets only when the SELECTION changes, so a stable selection keeps counting up.
//   * MANUAL mode: the HOST (loopback tab) POSTs /music {track|auto} -> everyone hears the host's
//     pick. Manual takes full control: auto triggers (incl. a siege) do NOT swap the track while
//     manual is active (the host is driving; they see the siege in chat/announcements). set_auto
//     hands control back to the trigger rules.
//
// CLOCK: the aux frame carries elapsedMs = now - start_ms computed at emit time (server clock
// only). The client seeks to (elapsedMs/1000) and, because the loop is seamless, to
// (elapsedMs/1000 % audio.duration) on periodic re-sync -- so client<->server clock SKEW cancels
// entirely (both numbers are the server's) and the server never needs to know a track's length.
// "Track end" is just the seamless loop wrapping; elapsedMs keeps growing, client takes the
// modulo. That is why there is no track-duration table anywhere.
//
// The PURE decision + state-transition functions below are DF/httplib-free and header-only, so
// the offline fixture (tools/harness/music_sync_fixture.cpp) drives the whole sync matrix
// deterministically with a SEEDED clock -- no real time, no DF.

#pragma once

#include <cstdint>
#include <string>

// Forward-declare so the header doesn't drag httplib into the offline fixture TU.
namespace httplib { class Server; }

namespace dwf {
namespace music {

// The canonical fortress-track keys -- MUST match dwf-audio.js TRACKS exactly (the client
// resolves key -> install path). A POST /music with any other key is rejected (400), so a typo
// can never point the whole fort's music channel at a 404.
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

// PURE auto-selection: DF's own music_standard.txt priority, from signals the server already has.
// Priority mirrors DF's layering: an active SIEGE overrides the seasonal WINTER track, which
// overrides the year baseline, which falls back to CONTEXT:MAIN. `first_year` is a tri-state:
// 1 => still the embark year (CONTEXT:FIRST_YEAR), 0 => established (SECOND_YEAR_PLUS), -1 =>
// unknown (no cheap founding-year global; fall through to MAIN, exactly the client's prior
// unknown-year behavior -- see the .cpp banner). season enum: 0 spring/1 summer/2 autumn/3 winter.
inline std::string select_auto_track(bool siege, int season, int first_year) {
    if (siege) return "vile_force_of_darkness";   // EVENT:SIEGE
    if (season == 3) return "winter_entombs_you";  // CONTEXT:WINTER
    if (first_year == 1) return "first_year";      // CONTEXT:FIRST_YEAR
    if (first_year == 0) return "another_year";    // CONTEXT:SECOND_YEAR_PLUS
    return "hill_dwarf";                            // CONTEXT:MAIN baseline
}

// The canonical state. `start_ms` is a monotonic (steady_clock) millisecond stamp; `manual` marks
// a host override that suppresses auto swaps.
struct State {
    std::string track = "hill_dwarf";
    int64_t start_ms = 0;
    bool manual = false;
};

// PURE transition for the AUTO path (called once per aux frame). Manual state is inert here: while
// manual, the track/start are frozen (the host is in control). Otherwise the track follows the
// auto selection and start_ms is reset to `now_ms` ONLY when the selection actually changes -- a
// stable selection keeps its original start so elapsed counts up smoothly.
inline State advance_auto(const State& cur, const std::string& auto_track, int64_t now_ms) {
    if (cur.manual) return cur;
    if (auto_track == cur.track) return cur;
    State next;
    next.track = auto_track;
    next.start_ms = now_ms;
    next.manual = false;
    return next;
}

// PURE transition: host set an explicit track (manual override begins/refreshes; start resets so
// everyone restarts the picked track together).
inline State set_manual(const std::string& track, int64_t now_ms) {
    State next;
    next.track = track;
    next.start_ms = now_ms;
    next.manual = true;
    return next;
}

// PURE transition: host handed control back to AUTO. Snap to the current auto selection and reset
// start so the resumed auto track begins cleanly for all clients.
inline State set_auto(const std::string& auto_track, int64_t now_ms) {
    State next;
    next.track = auto_track;
    next.start_ms = now_ms;
    next.manual = false;
    return next;
}

// PURE JSON fragment: `"music":{"track":"..","elapsedMs":N,"manual":bool}` (no leading comma).
// elapsed clamps at >=0 (a clock that went backwards must never emit a negative seek).
inline std::string state_json(const State& s, int64_t now_ms) {
    int64_t elapsed = now_ms - s.start_ms;
    if (elapsed < 0) elapsed = 0;
    return std::string("\"music\":{\"track\":\"") + s.track +
           "\",\"elapsedMs\":" + std::to_string(elapsed) +
           ",\"manual\":" + (s.manual ? "true" : "false") + "}";
}

// ---- Runtime wrapper (mutex + steady_clock over the pure core) -------------------------------
// monotonic now in ms.
int64_t now_ms();
// Called once per aux frame with the frame's trigger signals; advances the AUTO state and returns
// the ready-to-splice `env.music` JSON fragment (no leading comma). Thread-safe.
std::string frame_json(bool siege, int season, int first_year);
// Host control (POST /music). apply_manual validates the key. Return false on an invalid key.
bool apply_manual(const std::string& track);
void apply_auto(bool siege, int season, int first_year);

} // namespace music

// Register POST /music (host-only) on the server. Called from register_sound_route (so no
// http_server.cpp edit -- that file is entangled with in-flight agents).
void register_music_route(httplib::Server& server);

} // namespace dwf
