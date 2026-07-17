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

// WT28 / B218 -- see native_popup.h for the surface overview. STRUCTURE CITATIONS (all verified
// against the <DFHACK_ROOT> checkout's df-structures for this DF build):
//   * df.announcement.xml:179-208  announcement_handlerst ("$global.world.status"):
//       popups (original `mega`, vector<popup_message*>), mega_text (markup_text_boxst),
//       mega_portrait_hfid.  <-- THE ONE MIRRORED SURFACE.
//   * df.announcement.xml:72-78    popup_message = mega_announcementst {text, color, bright,
//       portrait_hfid}. NO id field and NO announcement-type field -- ids are plugin-assigned,
//       and `pauses` mirrors DF's own announcements.txt contract for BOX ("the announcement
//       will appear in a box and pause the game").
//   * DFHack library/modules/Gui.cpp showPopupAnnouncement() (the reverse of our dismissal):
//       push popups, MTB_clean + MTB_parse(popups[0]->text) + MTB_set_width on mega_text, bump
//       gps->force_full_display_count. Dismissal here performs the exact inverse transition so
//       queued popups, mega_text, and the portrait stay consistent -- never an ESC injection.
//
// EXPLICITLY NOT MIRRORED -- game->main_interface.announcement_alert (the Alerts / report /
// combat-log reader window). It looks sim-blocking to DFHack's World::ReadPauseState() only
// because that helper lumps announcement_alert.open in with info.open / stocks.open / trade.open /
// squads / work-order dialogs -- a long list of LOCAL host screens, not shared modals. Native DF
// does not globally pause the sim when the host opens it. Broadcasting it (the original B-popup
// bug) meant the Steam host clicking any announcement / combat report threw a bogus
// "Alerts / (no text)" modal onto every browser, wrongly refused browser unpause, and let any
// browser close the host's local window. It is local UI; opening/browsing/closing it raises no
// browser popup. Ordinary announcements + combat reports keep flowing through the browser
// notification and combat-log pipelines (untouched here).
//
// The diplomacy CHOICE dialog (main_interface.diplomacy) is likewise NOT mirrored here: it is a
// real decision surface owned by vote.cpp (WT14). Everything mirrored by this module is
// acknowledge-only.

long long steady_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

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
    const void* native_ptr = nullptr;  // popup_message* (match only, NEVER dereferenced outside a
                                       // suspender)
    std::string match_text;            // raw text fingerprint for TOCTOU re-verification
};

std::vector<MirroredPopup> g_current;      // mirrored set, native queue order
uint64_t g_seq = 0;                        // bumped on every broadcast change
int g_next_id = 1;                         // monotonic; NEVER reused (siege re-fire = fresh id)
std::deque<int> g_dismissed_ids;           // idempotency ring
std::set<std::string> g_synced;            // late-join sync bookkeeping (vote.cpp pattern)
std::atomic<bool> g_blocked{false};        // popup_blocked() mirror for arbiter + /diag

// ---- markup scrub -------------------------------------------------------------------------------
// popup_message.text is MTB markup (DFHack Gui.cpp MTB_parse, reverse-engineered from DF's own
// markup_text_boxst::process_string_to_lines). Token grammar handled here, matching that parser:
//   [R] new line / [B] blank line / [P] paragraph indent -> line breaks
//   [CHAR:n] / [CHAR:~c]           -> the literal character
//   [[ and ]]                      -> literal [ and ]
//   [C:f:b:br], [KEY:n], [LPAGE:...], [/LPAGE], [VAR:...] -> dropped (visual/link decoration;
//       the LPAGE link TEXT is outside the token and is kept)
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
        // '[' ...
        if (i + 1 < n && raw[i + 1] == '[') { out.push_back('['); i += 2; continue; }
        // Punctuation immediately after '[' is literal text in MTB (no_split_space path).
        if (i + 1 < n && (raw[i + 1] == '.' || raw[i + 1] == ':' || raw[i + 1] == '?' ||
                          raw[i + 1] == ' ' || raw[i + 1] == '!')) {
            out.push_back(raw[i + 1]);
            i += 2;
            continue;
        }
        // Token: capture up to the first ':' or ']'.
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
                // Keep printable ASCII; CP437 glyphs outside it have no faithful UTF-8 story
                // here and a dropped decoration beats mojibake in the mirror.
                if (code >= 0x20 && code < 0x7f) out.push_back(static_cast<char>(code));
            }
            j = k;
        }
        // else: [C:...], [KEY:...], [LPAGE:...], [/LPAGE], [VAR:...], unknown -> dropped.
        // Advance past the rest of the token to its closing ']'.
        while (j < n && raw[j] != ']') ++j;
        i = (j < n) ? j + 1 : n;
    }
    return out;
}

std::vector<std::string> scrub_markup_lines(const std::string& raw) {
    const std::string decoded = decode_markup_text(raw);
    // Split popup copy into capped lines. The shared art-prose consumer calls
    // native_markup_plain_text() below and deliberately keeps the uncapped decoded body.
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
    // Trim trailing blank lines.
    while (!lines.empty() && lines.back().empty()) lines.pop_back();
    return lines;
}

// ---- native sampling ----------------------------------------------------------------------------
// Raw snapshot of the mirrored surface. MUST be called under a (Conditional)CoreSuspender --
// world is sim-owned heap. Null-guards everything (vote.cpp sampling discipline).
struct RawPopup {
    std::string kind;
    std::string type_key;
    std::vector<std::string> text;
    bool pauses = false;
    const void* native_ptr = nullptr;
    std::string match_text;
};

std::vector<RawPopup> sample_native_popups_suspended() {
    std::vector<RawPopup> out;
    auto world = df::global::world;

    // Mirror ONLY the genuine mega/BOX popup queue -- df.global.world.status.popups, in native
    // order (front = the one the native UI is showing). These are real game-wide modal
    // announcements (megabeast, werebeast, night-attack, undead attack, first caravan, artifact)
    // that DF itself boxes and hard-pauses via *pause_state (announcements.txt BOX contract:
    // "appear in a box and pause the game"). The queue only pops at the front and pushes at the
    // back, so a stable entry keeps its id (see reconcile_locked).
    //
    // The announcement-alert window (game->main_interface.announcement_alert) is DELIBERATELY NOT
    // sampled -- it is LOCAL host UI, not a shared modal. See the native_popup.h banner: DFHack's
    // World::ReadPauseState lists announcement_alert.open in the SAME breath as info.open /
    // stocks.open / trade.open (all local host screens), and native DF does not globally pause the
    // sim when it is open. Mirroring it produced the B-popup bug: the Steam host merely opening an
    // Alerts window / combat report broadcast a bogus "Alerts / (no text)" modal to every browser,
    // wrongly blocked browser unpause, and let any browser close the host's local window. Opening,
    // browsing, or closing that window must raise NO browser popup. Ordinary announcements and
    // combat reports keep flowing through the browser notification + combat-log pipelines, which
    // this module does not touch.
    if (world) {
        for (auto popup : world->status.popups) {
            if (!popup)
                continue;
            RawPopup p;
            p.kind = "mega";
            p.pauses = true;   // BOX contract: "appear in a box and pause the game"
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

// ---- id reconciliation + serialization (caller holds g_popup_mutex) ----------------------------
// Order-preserving match on (kind, native_ptr, match_text): the native mega queue only pops at
// the front and pushes at the back, so a stable entry keeps its id, a re-fired event (new native
// object) gets a fresh monotonic id, and a dismissed id is never resurrected.
std::vector<MirroredPopup> reconcile_locked(const std::vector<RawPopup>& raw) {
    std::vector<MirroredPopup> next;
    size_t search_from = 0;
    for (const auto& r : raw) {
        MirroredPopup m;
        m.kind = r.kind;
        m.type_key = r.type_key;
        m.text = r.text;
        m.pauses = r.pauses;
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
            a[i].type_key != b[i].type_key)
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
        body << ",\"pauses\":" << (p.pauses ? "true" : "false") << "}";
    }
    body << "]}";
    return body.str();
}

// Push a frame to every connected player and mark them synced (vote.cpp broadcast_state pattern:
// frame built under the mutex, sent OUTSIDE it -- broadcast_to_player only enqueues on mutexed
// per-connection queues).
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
// Same lock order as every other DF mutation (capture mutex -> CoreSuspender; interaction.cpp
// run_suspended posture). Re-verifies the native state under the suspender before touching it
// (TOCTOU: the popup may have been dismissed at the keyboard between our sample and this apply).
// CAMERA IS NEVER TOUCHED (B216 rule): no window_x/y/z writes, no recenter calls.
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

    // The exact inverse of Gui::showPopupAnnouncement (DFHack Gui.cpp): pop the front, then
    // re-parse mega_text for the next queued popup (or leave it clean when the queue empties),
    // and force a full redraw so the native screen drops the box immediately.
    popups.erase(popups.begin());
    DFHack::Gui::MTB_clean(&world->status.mega_text);
    if (!popups.empty() && popups[0]) {
        DFHack::Gui::MTB_parse(&world->status.mega_text, popups[0]->text);
        DFHack::Gui::MTB_set_width(&world->status.mega_text);
        world->status.mega_portrait_hfid = popups[0]->portrait_hfid;
    } else {
        world->status.mega_portrait_hfid = -1;
    }
    // ★ B234 (2026-07-14): DO NOT `delete front`. This object is DF-allocated
    //   (df::popup_message). DFHack's own source only ever `new`s one
    //   (library/modules/Gui.cpp: showPopupAnnouncement) and NEVER frees one -- DF owns
    //   its destruction, and we cannot prove DF has dropped its last reference (it may
    //   pool or re-free them). A `delete` here is a double-free candidate, and a
    //   double-free is exactly what produces STATUS_HEAP_CORRUPTION (0xc0000374) --
    //   which is how the fort died on 2026-07-14 (win39, ~55 min in).
    //
    //   Heap corruption surfaces at an ARBITRARY LATER heap operation, so the crash
    //   timing implicates nothing; what matters is that this was the only free of a
    //   DF-owned object reachable with no deliberate user write, and it can only fire
    //   while UNPAUSED (popups are sim events). We unlink it from world->status.popups
    //   above; we now deliberately LEAK the object (one small struct) rather than free
    //   memory whose ownership we cannot establish.
    //
    //   RULE (adopt): the plugin may `new` and push into DF containers, but must NOT
    //   `delete` a DF object unless DFHack's own source frees that exact type.
    (void)front;   // intentionally leaked -- see above
    auto gps = df::global::gps;
    if (gps && gps->force_full_display_count < 2)
        gps->force_full_display_count = 2;
    return DismissApply::Done;
}

// NOTE: there is deliberately NO apply_dismiss_alert. The browser dismissal route must never be
// able to touch game->main_interface.announcement_alert (in particular it must never set
// announcement_alert.open = false) -- that window is the host's local UI, not a mirrored modal.
// Only mega/BOX popups are ever mirrored, so dismissal only ever runs apply_dismiss_mega above.

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
    // <=1 Hz cadence for BOTH sampling and late-join sync (vote_push_tick posture).
    static long long last_pass = 0;
    const long long now = steady_ms();
    if (now - last_pass < 1000)
        return;
    last_pass = now;

    // 1) Sample the native surfaces OUTSIDE g_popup_mutex (never hold a plugin mutex across a
    //    suspender acquire). ConditionalCoreSuspender skips instantly while the core is blocked
    //    on a save -- we keep the previous mirrored set in that case.
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

    // 3) Late-join sync: once anything has ever been mirrored (seq > 0), a player who has not
    //    seen the CURRENT state gets it -- including the empty set, so a reconnecting tab never
    //    keeps a stale modal. Prune g_synced to the live roster so a reconnect resyncs.
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
    // GET /popup -> current mirrored state. Mutex-only cache read (no CoreSuspender per request);
    // the live probe and tests read this without a WS connection.
    server.Get("/popup", [](const httplib::Request&, httplib::Response& res) {
        std::string json;
        {
            std::lock_guard<std::mutex> lock(g_popup_mutex);
            json = state_json_locked(/*as_ws_frame=*/false, /*by=*/"");
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(json + "\n", "application/json; charset=utf-8");
    });

    // POST /popup/dismiss?player=&id= -> perform the native dismissal for the mirrored popup
    // `id`. Idempotent per id: a stale/unknown/already-dismissed id is {"ok":true,
    // "already":true} so two players clicking simultaneously is a no-op on the second. Only the
    // FRONT mega popup can be dismissed (native shows and dismisses the queue one at a time);
    // a queued non-front id gets 409 and the client simply waits its turn.
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
                    // megas precede the alert entry and keep native queue order, so the front
                    // mega is the first entry of the mirrored set.
                    front_mega = (kind == "mega") && (i == 0);
                    break;
                }
            }
        }
        if (!found) {
            // Unknown or no-longer-current id: already gone (dismissed natively, superseded, or
            // stale). Idempotent success -- the caller's goal state ("this popup is not up") holds.
            res.set_header("Cache-Control", "no-store");
            res.set_content("{\"ok\":true,\"already\":true}\n",
                            "application/json; charset=utf-8");
            return;
        }
        if (!front_mega) {
            popup_json_error(res, 409, "not the front popup - dismiss the current one first");
            return;
        }

        // Only mega/BOX popups are ever mirrored; dismissal only ever performs the native mega
        // queue transition. The host's announcement-alert window is never mirrored and so can
        // never be reached (let alone closed) through this route.
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
    server.Get("/popup/dismiss", dismiss_handler);
}

} // namespace dwf
