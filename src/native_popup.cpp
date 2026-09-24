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

#include "native_popup.h"

#include "common_util.h"
#include "json_util.h"
#include "sdl_capture.h"
#include "websocket.h"

#include "Core.h"
#include "DataDefs.h"
#include "modules/Gui.h"

#include "df/global_objects.h"
#include "df/graphic.h"
#include "df/markup_text_boxst.h"
#include "df/popup_message.h"
#include "df/world.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <deque>
#include <iterator>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace dwf {
namespace {

// Mirrors one DF surface: the mega/BOX popup queue in world.status.popups.

// Defensive caps: a popup is a small acknowledge box, not a bulk transport.
constexpr size_t kMaxMirrored = 8;      // mirrored popups per frame (native queue is rarely >1)
constexpr size_t kMaxTextLines = 60;    // lines per popup
constexpr size_t kMaxLineChars = 400;   // chars per line
constexpr size_t kDismissedRing = 64;   // remembered dismissed ids (idempotency window)

// ---- state (all guarded by g_popup_mutex; plugin memory, ephemeral) ----------------------------
std::mutex g_popup_mutex;

struct MirroredPopup {
    int id = 0;
    std::string kind;                  // always "mega" (only the BOX queue is mirrored; the wire
                                       // "kind" field is retained for client/schema stability)
    std::string type_key;              // always "" for mega; retained on the wire for stability
    std::vector<std::string> text;     // scrubbed display lines
    bool pauses = false;               // BOX popups pause by DF's own contract
    int16_t color = 7;                 // mega_announcementst.color
    bool bright = true;                // mega_announcementst.bright
    int32_t portrait_hfid = -1;        // -1 sentinel = no portrait reserved
    const void* native_ptr = nullptr;  // popup_message* (match only, NEVER dereferenced outside a
                                       // suspender)
    std::string match_text;            // raw text fingerprint for TOCTOU re-verification
};

std::vector<MirroredPopup> g_current;      // mirrored set, native queue order
uint64_t g_seq = 0;                        // bumped on every broadcast change
int g_next_id = 1;                         // monotonic; NEVER reused (siege re-fire = fresh id)
std::deque<int> g_dismissed_ids;           // idempotency ring
std::set<std::string> g_synced;            // late-join sync bookkeeping
std::atomic<bool> g_blocked{false};        // popup_blocked() mirror for arbiter + /diag

// ---- markup scrub -------------------------------------------------------------------------------
// MTB token grammar, mirroring DFHack's MTB_parse: an unknown token is dropped, never shown.
std::string decode_markup_text(const std::string& raw) {
    std::string out;
    const size_t n = raw.size();
    size_t i = 0;
    while (i < n) {
        char c = raw[i];
        if (c == ']') {
            if (i + 1 < n && raw[i + 1] == ']') { out.push_back(']'); i += 2; }
            else ++i;   // stray ']' -- MTB skips it too
            continue;
        }
        if (c != '[') { out.push_back(c); ++i; continue; }
        if (i + 1 < n && raw[i + 1] == '[') { out.push_back('['); i += 2; continue; }
        // Punctuation immediately after '[' is literal text in MTB markup.
        if (i + 1 < n && (raw[i + 1] == '.' || raw[i + 1] == ':' || raw[i + 1] == '?' ||
                          raw[i + 1] == ' ' || raw[i + 1] == '!')) {
            out.push_back(raw[i + 1]);
            i += 2;
            continue;
        }
        size_t j = i + 1;
        std::string token;
        while (j < n && raw[j] != ':' && raw[j] != ']') token.push_back(raw[j++]);
        if (token == "R") out.push_back('\n');
        else if (token == "B") out += "\n\n";
        else if (token == "P") out.push_back('\n');
        else if (token == "CHAR" && j < n && raw[j] == ':') {
            size_t k = j + 1;
            std::string arg;
            while (k < n && raw[k] != ':' && raw[k] != ']') arg.push_back(raw[k++]);
            if (arg.size() > 1 && arg[0] == '~') out.push_back(arg[1]);
            else if (!arg.empty()) {
                int code = std::atoi(arg.c_str());
                // Printable ASCII only: a dropped decoration beats mojibake in the mirror.
                if (code >= 0x20 && code < 0x7f) out.push_back(static_cast<char>(code));
            }
            j = k;
        }
        while (j < n && raw[j] != ']') ++j;
        i = (j < n) ? j + 1 : n;
    }
    return out;
}

std::vector<std::string> scrub_markup_lines(const std::string& raw) {
    const std::string decoded = decode_markup_text(raw);
    // Capped for the popup box only -- native_markup_plain_text() keeps the uncapped decoded body
    // for the shared art-prose consumer.
    std::vector<std::string> lines;
    std::string line;
    auto flush = [&]() {
        while (!line.empty() && line.back() == ' ') line.pop_back();
        if (line.size() > kMaxLineChars) line.resize(kMaxLineChars);
        lines.push_back(line);
        line.clear();
    };
    for (char c : decoded) {
        if (c == '\n') { flush(); if (lines.size() >= kMaxTextLines) return lines; }
        else if (c != '\r') line.push_back(c);
    }
    if (!line.empty()) flush();
    while (!lines.empty() && lines.back().empty()) lines.pop_back();
    return lines;
}

// ---- native sampling ----------------------------------------------------------------------------
// MUST be called under a (Conditional)CoreSuspender: world is sim-owned heap.
struct RawPopup {
    std::string kind;
    std::string type_key;
    std::vector<std::string> text;
    bool pauses = false;
    int16_t color = 7;
    bool bright = true;
    int32_t portrait_hfid = -1;
    const void* native_ptr = nullptr;
    std::string match_text;
};

std::vector<RawPopup> sample_native_popups_suspended() {
    std::vector<RawPopup> out;
    auto world = df::global::world;

    // Mirror ONLY the genuine mega/BOX queue, in native order (front = what the native UI shows).
    // main_interface.announcement_alert is LOCAL host UI and must never be mirrored or broadcast.
    if (world) {
        for (auto popup : world->status.popups) {
            if (!popup)
                continue;
            RawPopup p;
            p.kind = "mega";
            p.pauses = true;   // BOX contract: "appear in a box and pause the game"
            // The popup the native UI is SHOWING takes world.status.mega_portrait_hfid; a queued
            // entry carries the value that becomes mega_portrait_hfid when it reaches the front.
            p.color = popup->color;
            p.bright = popup->bright;
            p.portrait_hfid = out.empty() ? world->status.mega_portrait_hfid : popup->portrait_hfid;
            p.native_ptr = popup;
            p.match_text = popup->text;
            p.text = scrub_markup_lines(popup->text);
            out.push_back(std::move(p));
            if (out.size() >= kMaxMirrored)
                return out;
        }
    }
    return out;
}

// Order-preserving match on (kind, native_ptr, match_text): the native queue only pops at the front
// and pushes at the back, so a stable entry keeps its id and a dismissed id is never resurrected.
std::vector<MirroredPopup> reconcile_locked(const std::vector<RawPopup>& raw) {
    std::vector<MirroredPopup> next;
    size_t search_from = 0;
    for (const auto& r : raw) {
        MirroredPopup m;
        m.kind = r.kind;
        m.type_key = r.type_key;
        m.text = r.text;
        m.pauses = r.pauses;
        m.color = r.color;
        m.bright = r.bright;
        m.portrait_hfid = r.portrait_hfid;
        m.native_ptr = r.native_ptr;
        m.match_text = r.match_text;
        m.id = 0;
        for (size_t j = search_from; j < g_current.size(); ++j) {
            if (g_current[j].kind == r.kind && g_current[j].native_ptr == r.native_ptr &&
                g_current[j].match_text == r.match_text) {
                m.id = g_current[j].id;
                search_from = j + 1;
                break;
            }
        }
        if (m.id == 0)
            m.id = g_next_id++;
        next.push_back(std::move(m));
    }
    return next;
}

bool sets_equal(const std::vector<MirroredPopup>& a, const std::vector<MirroredPopup>& b) {
    if (a.size() != b.size())
        return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (a[i].id != b[i].id || a[i].kind != b[i].kind || a[i].text != b[i].text ||
            a[i].type_key != b[i].type_key || a[i].color != b[i].color ||
            a[i].bright != b[i].bright || a[i].portrait_hfid != b[i].portrait_hfid)
            return false;
    }
    return true;
}

// {"type":"popup",...} frame / GET /popup body. Caller holds the mutex.
std::string state_json_locked(bool as_ws_frame, const std::string& by) {
    std::ostringstream body;
    body << "{";
    if (as_ws_frame) body << "\"type\":\"popup\",";
    body << "\"seq\":" << g_seq
         << ",\"blocked\":" << (g_current.empty() ? "false" : "true");
    if (!by.empty())
        body << ",\"by\":" << json_string(by);
    body << ",\"popups\":[";
    for (size_t i = 0; i < g_current.size(); ++i) {
        const auto& p = g_current[i];
        if (i) body << ",";
        body << "{\"id\":" << p.id
             << ",\"kind\":" << json_string(p.kind)
             << ",\"typeKey\":" << json_string(p.type_key)
             << ",\"title\":" << json_string(std::string())   // provisional: parity pass owns copy
             << ",\"text\":";
        append_json_string_array(body, p.text);
        body << ",\"pauses\":" << (p.pauses ? "true" : "false")
             << ",\"color\":" << static_cast<int>(p.color)
             << ",\"bright\":" << (p.bright ? "true" : "false")
             << ",\"portraitHfid\":" << p.portrait_hfid << "}";
    }
    body << "]}";
    return body.str();
}

// Built under the mutex, sent outside it -- broadcast_to_player only enqueues on per-connection queues.
void broadcast_state(const std::string& frame) {
    auto connected = ws_connected_players();
    for (const auto& p : connected)
        broadcast_to_player(p, frame);
    std::lock_guard<std::mutex> lock(g_popup_mutex);
    g_synced.clear();
    g_synced.insert(connected.begin(), connected.end());
}

bool id_dismissed_locked(int id) {
    return std::find(g_dismissed_ids.begin(), g_dismissed_ids.end(), id) != g_dismissed_ids.end();
}

void remember_dismissed_locked(int id) {
    g_dismissed_ids.push_back(id);
    while (g_dismissed_ids.size() > kDismissedRing)
        g_dismissed_ids.pop_front();
}

// ---- dismissal core-thread apply -----------------------------------------------------------------
// Lock order is capture_state_mutex() then CoreSuspender, and the camera is never touched.
enum class DismissApply { Done, AlreadyGone };

DismissApply apply_dismiss_mega(const void* ptr, const std::string& match_text) {
    std::lock_guard<std::recursive_mutex> capture_lock(capture_state_mutex());
    DFHack::CoreSuspender suspend;
    auto world = df::global::world;
    if (!world || world->status.popups.empty())
        return DismissApply::AlreadyGone;
    auto& popups = world->status.popups;
    df::popup_message* front = popups[0];
    if (static_cast<const void*>(front) != ptr || !front || front->text != match_text)
        return DismissApply::AlreadyGone;   // queue advanced natively since our snapshot

    // The exact inverse of DFHack's Gui::showPopupAnnouncement -- never an ESC injection.
    popups.erase(popups.begin());
    DFHack::Gui::MTB_clean(&world->status.mega_text);
    if (!popups.empty() && popups[0]) {
        DFHack::Gui::MTB_parse(&world->status.mega_text, popups[0]->text);
        DFHack::Gui::MTB_set_width(&world->status.mega_text);
        world->status.mega_portrait_hfid = popups[0]->portrait_hfid;
    } else {
        world->status.mega_portrait_hfid = -1;
    }
    // Never `delete front`: df::popup_message is DF-allocated and DFHack's own source never frees
    // one, so a delete here is a double-free. Unlinked above and deliberately leaked instead.
    (void)front;   // intentionally leaked
    auto gps = df::global::gps;
    if (gps && gps->force_full_display_count < 2)
        gps->force_full_display_count = 2;
    return DismissApply::Done;
}

// There is deliberately no apply_dismiss_alert: the dismissal route must never reach
// main_interface.announcement_alert, which is the host's local window, not a mirrored modal.

void popup_json_error(httplib::Response& res, int status, const std::string& message) {
    res.status = status;
    res.set_header("Cache-Control", "no-store");
    res.set_content("{\"ok\":false,\"error\":" + json_string(message) + "}\n",
                    "application/json; charset=utf-8");
}

} // namespace

std::string native_markup_plain_text(const std::string& raw) {
    std::string out = decode_markup_text(raw);
    while (!out.empty() && (out.back() == '\r' || out.back() == '\n'))
        out.pop_back();
    return out;
}

// ---- push-loop tick ------------------------------------------------------------------------------

void popup_push_tick() {
    // <=1 Hz cadence for BOTH sampling and late-join sync (pause_push_tick posture).
    static long long last_pass = 0;
    const long long now = steady_ms();
    if (now - last_pass < 1000)
        return;
    last_pass = now;

    // Sample outside g_popup_mutex -- never hold a plugin mutex across a suspender acquire. The
    // ConditionalCoreSuspender skips instantly while the core is blocked on a save.
    bool sampled = false;
    std::vector<RawPopup> raw;
    {
        DFHack::ConditionalCoreSuspender suspend;
        if (suspend) {
            raw = sample_native_popups_suspended();
            sampled = true;
        }
    }

    // 2) Reconcile ids + detect change under the mutex; broadcast after releasing it.
    std::string frame;
    if (sampled) {
        std::lock_guard<std::mutex> lock(g_popup_mutex);
        auto next = reconcile_locked(raw);
        if (!sets_equal(next, g_current)) {
            g_current = std::move(next);
            ++g_seq;
            g_blocked.store(!g_current.empty());
            frame = state_json_locked(/*as_ws_frame=*/true, /*by=*/"");
        } else {
            g_blocked.store(!g_current.empty());
        }
    }
    if (!frame.empty())
        broadcast_state(frame);

    // Late-join sync ships the CURRENT state, the empty set included, so a reconnecting tab can
    // never keep a stale modal on screen.
    auto connected = ws_connected_players();
    std::vector<std::string> to_sync;
    std::string sync_frame;
    {
        std::lock_guard<std::mutex> lock(g_popup_mutex);
        std::set<std::string> live(connected.begin(), connected.end());
        for (auto it = g_synced.begin(); it != g_synced.end();)
            it = live.count(*it) ? std::next(it) : g_synced.erase(it);
        if (g_seq > 0) {
            for (const auto& p : connected)
                if (!g_synced.count(p)) { to_sync.push_back(p); g_synced.insert(p); }
            if (!to_sync.empty())
                sync_frame = state_json_locked(/*as_ws_frame=*/true, /*by=*/"");
        }
    }
    for (const auto& p : to_sync)
        broadcast_to_player(p, sync_frame);
}

bool popup_blocked() {
    return g_blocked.load();
}

// ---- routes --------------------------------------------------------------------------------------

void register_popup_routes(httplib::Server& server) {
    // GET /popup -> the mirrored state. Mutex-only cache read, no CoreSuspender per request.
    server.Get("/popup", [](const httplib::Request&, httplib::Response& res) {
        std::string json;
        {
            std::lock_guard<std::mutex> lock(g_popup_mutex);
            json = state_json_locked(/*as_ws_frame=*/false, /*by=*/"");
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    // Idempotent per id: a stale or already-dismissed id answers {"ok":true,"already":true}. Only
    // the FRONT mega popup can be dismissed; a queued id gets 409 and the client waits its turn.
    auto dismiss_handler = [](const httplib::Request& req, httplib::Response& res) {
        int id = -1;
        if (!query_int(req, "id", id) || id <= 0) {
            popup_json_error(res, 400, "missing or invalid id");
            return;
        }
        const std::string player = query_player(req);

        // Snapshot the target under the mutex (never hold it across the suspender below).
        std::string kind;
        const void* ptr = nullptr;
        std::string match_text;
        bool found = false;
        bool front_mega = false;
        {
            std::lock_guard<std::mutex> lock(g_popup_mutex);
            if (id_dismissed_locked(id)) {
                res.set_header("Cache-Control", "no-store");
                res.set_content("{\"ok\":true,\"already\":true}\n",
                                "application/json; charset=utf-8");
                return;
            }
            for (size_t i = 0; i < g_current.size(); ++i) {
                if (g_current[i].id == id) {
                    found = true;
                    kind = g_current[i].kind;
                    ptr = g_current[i].native_ptr;
                    match_text = g_current[i].match_text;
                    // Native queue order is preserved, so the front mega is the first entry.
                    front_mega = (kind == "mega") && (i == 0);
                    break;
                }
            }
        }
        if (!found) {
            // Unknown or no-longer-current id: idempotent success, the caller's goal state holds.
            res.set_header("Cache-Control", "no-store");
            res.set_content("{\"ok\":true,\"already\":true}\n",
                            "application/json; charset=utf-8");
            return;
        }
        if (!front_mega) {
            popup_json_error(res, 409, "not the front popup - dismiss the current one first");
            return;
        }

        DismissApply applied = apply_dismiss_mega(ptr, match_text);

        // Update the mirror + broadcast the new set immediately (don't wait for the next tick).
        std::string frame;
        {
            std::lock_guard<std::mutex> lock(g_popup_mutex);
            remember_dismissed_locked(id);
            auto it = std::find_if(g_current.begin(), g_current.end(),
                                   [&](const MirroredPopup& p) { return p.id == id; });
            if (it != g_current.end()) {
                g_current.erase(it);
                ++g_seq;
                g_blocked.store(!g_current.empty());
                frame = state_json_locked(/*as_ws_frame=*/true, player);
            }
        }
        if (!frame.empty())
            broadcast_state(frame);

        const bool paused = df::global::pause_state && *df::global::pause_state;
        std::ostringstream out;
        out << "{\"ok\":true,\"dismissed\":" << id
            << ",\"already\":" << (applied == DismissApply::AlreadyGone ? "true" : "false")
            << ",\"paused\":" << (paused ? "true" : "false") << "}\n";
        res.set_header("Cache-Control", "no-store");
        res.set_content(out.str(), "application/json; charset=utf-8");
    };
    server.Post("/popup/dismiss", dismiss_handler);
}

} // namespace dwf
