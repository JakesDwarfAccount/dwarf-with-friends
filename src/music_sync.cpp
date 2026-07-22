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

#include "music_sync.h"

#include "httplib.h"
#include "sound_route.h"   // request_is_local_host (host gate), shared with the licensing gate
#include "websocket.h"     // peer_ip_is_loopback

#include <chrono>
#include <mutex>

namespace dwf {
namespace music {
namespace {

std::mutex g_mu;
State g_state;
bool g_seeded = false;

// FIRST_YEAR vs SECOND_YEAR_PLUS: DF's music_standard.txt distinguishes the embark year from
// established years, but there is no ONE cheap global that gives the fort's founding year
// (plotinfo->fortress_age is "+1 per 10", units undocumented, and unreliable across saves). Rather
// than ship a wrong guess, the server passes first_year = -1 (unknown) today, so select_auto_track
// falls through to CONTEXT:MAIN (hill_dwarf) -- byte-for-byte the client's PRIOR unknown-year
// behavior (autoMusicTrack returned hill_dwarf when ctx.firstYear was null), i.e. NO regression.
// The seam is fully wired (first_year threads through select_auto_track/frame_json); wiring a
// real founding-year signal later is a one-line change. Documented, not silently dropped.

} // namespace

int64_t now_ms() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               clock::now().time_since_epoch())
        .count();
}

std::string frame_json(bool siege, int season, int first_year) {
    std::lock_guard<std::mutex> lk(g_mu);
    int64_t t = now_ms();
    std::string auto_track = select_auto_track(siege, season, first_year);
    if (!g_seeded) {
        // First frame: adopt the auto selection and start the clock now (avoids a bogus huge
        // elapsed from the default-constructed start_ms == 0 vs a large steady_clock stamp).
        g_state = set_auto(auto_track, t);
        g_seeded = true;
    } else {
        g_state = advance_auto(g_state, auto_track, t);
    }
    return state_json(g_state, t);
}

bool apply_manual(const std::string& track) {
    if (!is_valid_track(track)) return false;
    std::lock_guard<std::mutex> lk(g_mu);
    g_state = set_manual(track, now_ms());
    g_seeded = true;
    return true;
}

void apply_auto(bool siege, int season, int first_year) {
    std::lock_guard<std::mutex> lk(g_mu);
    g_state = set_auto(select_auto_track(siege, season, first_year), now_ms());
    g_seeded = true;
}

namespace {

// Same tunnel-aware host gate the /sound licensing gate uses (sound_route.h::request_is_local_host):
// loopback peer + no proxy forwarding header + a loopback-ish Host. A tunneled remote friend must
// NOT be able to seize the fort's music channel by curling /music.
bool peer_is_host(const httplib::Request& req) {
    return request_has_host_authority(req);
}

// Flat body scan -- our own client sends `{"track":"<key>"}` or `{"auto":true}`. Extracts the
// track key (empty if absent). Never throws; whitespace-tolerant enough for our fixed shape.
std::string scan_track(const std::string& body) {
    const std::string key = "\"track\"";
    size_t k = body.find(key);
    if (k == std::string::npos) return "";
    size_t i = body.find(':', k + key.size());
    if (i == std::string::npos) return "";
    ++i;
    while (i < body.size() && (body[i] == ' ' || body[i] == '\t')) ++i;
    if (i >= body.size() || body[i] != '"') return "";
    ++i;
    std::string out;
    while (i < body.size() && body[i] != '"') { out.push_back(body[i]); ++i; }
    return out;
}

bool scan_auto_true(const std::string& body) {
    const std::string key = "\"auto\"";
    size_t k = body.find(key);
    if (k == std::string::npos) return false;
    size_t i = body.find(':', k + key.size());
    if (i == std::string::npos) return false;
    ++i;
    while (i < body.size() && (body[i] == ' ' || body[i] == '\t')) ++i;
    return body.compare(i, 4, "true") == 0;
}

} // namespace
} // namespace music

void register_music_route(httplib::Server& server) {
    // POST /music -- HOST-ONLY canonical music control. `{"track":"<key>"}` sets a manual override
    // (everyone hears it, seeked together); `{"auto":true}` hands control back to the trigger
    // rules. The picked track is emitted as the canonical env.music on the very next aux frame, so
    // there is no separate broadcast -- the shared aux stream IS the broadcast (late joiners too).
    server.Post("/music", [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        if (!music::peer_is_host(req)) {
            res.status = 403;
            res.set_content("{\"ok\":false,\"error\":\"host only\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        if (music::scan_auto_true(req.body)) {
            // Hand back to AUTO. The next frame_json re-derives from live triggers; snap now so the
            // host UI reflects it immediately (siege/season unknown here -> conservative MAIN, the
            // frame loop corrects within one tick).
            music::apply_auto(false, 0, -1);
            res.set_content("{\"ok\":true,\"manual\":false}\n",
                            "application/json; charset=utf-8");
            return;
        }
        std::string track = music::scan_track(req.body);
        if (!music::apply_manual(track)) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"unknown track\"}\n",
                            "application/json; charset=utf-8");
            return;
        }
        res.set_content(std::string("{\"ok\":true,\"manual\":true,\"track\":\"") + track + "\"}\n",
                        "application/json; charset=utf-8");
    });
}

} // namespace dwf
