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

#include "chat.h"

#include "diagnostics.h"
#include "websocket.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace dwf {

namespace {

constexpr size_t kRingCap = 100;   // scrollback depth held server-side (late-join + gap-fill)
constexpr size_t kMaxLen = 500;    // per-line hard clamp (bytes). The WS recv path already drops
                                   // any control frame > 4096 bytes before it reaches chat_post,
                                   // so this is the display/storage bound within that.

struct ChatLine {
    uint64_t seq = 0;
    bool system = false;
    std::string from;   // empty for system lines
    std::string text;   // RAW (UTF-8); JSON-escaped only when serialized to the wire
    long long ts = 0;   // wall-clock ms (Date.now()-comparable, for the client timestamp)
};

std::mutex g_mu;                    // guards g_ring + g_seq
std::deque<ChatLine> g_ring;
uint64_t g_seq = 0;

long long wall_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}
long long steady_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch()).count();
}

// chat_escape is defined below, OUTSIDE this anonymous namespace, so it has EXTERNAL linkage
// (http_server.cpp / websocket.cpp emit player names through it). The calls in this file resolve
// via the declaration in chat.h.

// Serialize ONE line as a JSON object (no wrapping envelope). Shared by the live broadcast and
// the /chat scrollback array so both wire shapes are byte-identical.
std::string serialize_line(const ChatLine& l) {
    std::ostringstream o;
    o << "{\"seq\":" << l.seq;
    if (l.system) o << ",\"system\":true";
    else          o << ",\"from\":\"" << chat_escape(l.from) << "\"";
    o << ",\"text\":\"" << chat_escape(l.text) << "\",\"ts\":" << l.ts << "}";
    return o.str();
}

// Append to the ring under g_mu, assign the next seq, and broadcast the live frame. Returns the
// serialized OBJECT (for logging); the broadcast envelope wraps it as {"type":"chat",...fields}.
uint64_t append_and_broadcast(bool system, const std::string& from, const std::string& text) {
    ChatLine l;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        l.seq = ++g_seq;
        l.system = system;
        l.from = from;
        l.text = text;
        l.ts = wall_ms();
        g_ring.push_back(l);
        while (g_ring.size() > kRingCap) g_ring.pop_front();
    }
    // Live frame: {"type":"chat", <the same fields serialize_line emits>}. Splice the object's
    // body in after the type so the client parses ONE flat object.
    std::string obj = serialize_line(l);           // "{...}"
    std::string frame = "{\"type\":\"chat\"," + obj.substr(1);   // drop leading '{'
    broadcast_chat_to_all(frame);
    return l.seq;
}

// ---- presence (join/leave), single-thread state: only chat_presence_tick touches it ----------
std::set<std::string> g_present;                 // confirmed-in-room names
std::map<std::string, long long> g_pending_leave; // name -> steady_ms the last socket dropped
bool g_present_seeded = false;
constexpr long long kLeaveGraceMs = 5000;        // absorbs a page-refresh socket flap

} // namespace

// JSON string escaper that PASSES BYTES THROUGH (no CP437->UTF-8 transcode). Chat/player text
// arrives from the browser already UTF-8-decoded (websocket.cpp), so json_util's json_escape --
// which runs DF2UTF -- would double-transcode and corrupt any non-ASCII. We only need to make the
// bytes safe inside a JSON string literal; the client renders them as inert text regardless.
// EXTERNAL linkage on purpose: presence/hello_ack name emission uses it (see chat.h).
std::string chat_escape(const std::string& raw) {
    std::ostringstream out;
    for (unsigned char ch : raw) {
        switch (ch) {
            case '\\': out << "\\\\"; break;
            case '"':  out << "\\\""; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (ch < 0x20) {
                    static const char* hexd = "0123456789ABCDEF";
                    out << "\\u00" << hexd[(ch >> 4) & 0xF] << hexd[ch & 0xF];
                } else {
                    out << static_cast<char>(ch);   // >=0x20: literal (UTF-8 bytes pass through)
                }
        }
    }
    return out.str();
}

bool chat_sanitize(const std::string& in, std::string& out) {
    // Trim ASCII whitespace (space, \t, \n, \r, \f, \v) from both ends.
    auto is_ws = [](unsigned char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
    };
    size_t b = 0, e = in.size();
    while (b < e && is_ws((unsigned char)in[b])) ++b;
    while (e > b && is_ws((unsigned char)in[e - 1])) --e;
    std::string s = in.substr(b, e - b);
    // Hard clamp to kMaxLen bytes WITHOUT splitting a UTF-8 sequence: if the first dropped byte is
    // a continuation byte (10xxxxxx), back the cut up to the char boundary.
    if (s.size() > kMaxLen) {
        size_t n = kMaxLen;
        while (n > 0 && ((unsigned char)s[n] & 0xC0) == 0x80) --n;
        s.resize(n);
    }
    out.swap(s);
    return !out.empty();
}

bool chat_post(const std::string& from, const std::string& text) {
    std::string clean;
    if (!chat_sanitize(text, clean)) return false;   // empty after trim -> reject, no seq consumed
    append_and_broadcast(/*system=*/false, from, clean);
    return true;
}

void chat_system(const std::string& text) {
    std::string clean;
    if (!chat_sanitize(text, clean)) return;
    append_and_broadcast(/*system=*/true, std::string(), clean);
}

void chat_presence_tick() {
    std::vector<std::string> cur = ws_connected_players();
    std::set<std::string> curset(cur.begin(), cur.end());

    // First tick after (re)load: adopt the current roster silently so a DLL hot-swap mid-session
    // doesn't emit "joined" for everyone already connected.
    if (!g_present_seeded) {
        g_present = curset;
        g_pending_leave.clear();
        g_present_seeded = true;
        return;
    }

    const long long now = steady_ms();

    // Joins + refresh-reconnect cancellations.
    for (const auto& name : curset) {
        g_pending_leave.erase(name);            // back before the grace expired -> not a leave
        if (g_present.insert(name).second) {    // newly present
            chat_system(name + " joined");
        }
    }
    // Departures: start a grace timer when a present name has no sockets; fire after it expires.
    std::vector<std::string> left;
    for (const auto& name : g_present) {
        if (curset.count(name)) continue;       // still here
        auto it = g_pending_leave.find(name);
        if (it == g_pending_leave.end()) {
            g_pending_leave[name] = now;        // start grace
        } else if (now - it->second >= kLeaveGraceMs) {
            left.push_back(name);
        }
    }
    for (const auto& name : left) {
        g_present.erase(name);
        g_pending_leave.erase(name);
        chat_system(name + " left");
    }
}

void register_chat_routes(httplib::Server& server) {
    // GET /chat[?since=N] -- scrollback. Gated by the shared-cookie pre-routing auth handler like
    // every other game-state route (no static extension, not in join_public_path). An OLD DLL has
    // no /chat route at all (httplib 404), which is exactly the signal the client uses to detect a
    // chat-less host and show "host needs update".
    server.Get("/chat", [](const httplib::Request& req, httplib::Response& res) {
        long long since = -1;
        if (req.has_param("since")) since = std::atoll(req.get_param_value("since").c_str());
        std::ostringstream body;
        {
            std::lock_guard<std::mutex> lk(g_mu);
            body << "{\"latest\":" << g_seq << ",\"lines\":[";
            bool first = true;
            for (const auto& l : g_ring) {
                if (since >= 0 && (long long)l.seq <= since) continue;
                if (!first) body << ",";
                first = false;
                body << serialize_line(l);
            }
            body << "]}";
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(body.str() + "\n", "application/json; charset=utf-8");
    });
}

bool chat_selftest() {
    struct Case { std::string in; bool expect_ok; std::string expect_out; };
    const std::vector<Case> cases = {
        {"",                         false, ""},
        {"   \t\n ",                 false, ""},               // whitespace-only -> reject
        {"  hi  ",                   true,  "hi"},             // trim
        {"<img src=x onerror=alert(1)>", true, "<img src=x onerror=alert(1)>"}, // XSS seed passthrough
        {std::string(600, 'a'),      true,  std::string(500, 'a')},             // overlong clamp
    };
    bool ok = true;
    for (const auto& c : cases) {
        std::string out;
        bool r = chat_sanitize(c.in, out);
        if (r != c.expect_ok || (r && out != c.expect_out)) { ok = false; break; }
    }
    // UTF-8 boundary: a 3-byte char (U+20AC EURO = E2 82 AC) straddling the clamp must not split.
    {
        std::string in;
        in.append(kMaxLen - 1, 'a');       // 499 'a'
        in += "\xE2\x82\xAC";              // + 3-byte char -> would end at byte 502
        std::string out;
        chat_sanitize(in, out);
        // Cut at 500 would land inside the euro (byte 500 = 0x82 continuation) -> backed up to 499.
        if (out.size() != kMaxLen - 1) ok = false;
    }
    diagnostics_log(std::string("chat-selftest ") + (ok ? "PASS" : "FAIL"));
    return ok;
}

} // namespace dwf
