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

#include "websocket.h"

#include "auth.h"           // hello-token gate + hello_ack build stamp
#include "chat.h"           // chat_post relay on inbound {"type":"chat"}
#include "client_state.h"   // set_player_precise_cursor: store inbound smooth cursors + camera authority
#include "common_util.h"
#include "http_server.h"    // notify_player_input: wake the push loop on a WS-borne camera move
#include "json_util.h"      // json_escape: hello_ack.player (name dedup)
#include "request_origin.h"
#include "sdl_capture.h"    // clamp_camera: mirror POST /camera's bounds clamp for WS-borne moves
#include "wire_v1.h"        // v1 frame header build (writer stamps seq at send)
#include "world_stream.h"   // world_stream_forget: prune the /diag v1.players row on disconnect

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <sstream>
#include <thread>
#include <vector>

#include <zlib.h>

#include "diagnostics.h"
#include "json_mini.h"

// httplib.h (via websocket.h) already pulls in the platform socket headers, so ::recv / ::send /
// MSG_PEEK / closesocket are available here without adding any.

namespace dwf {

namespace {

// ---- module state --------------------------------------------------------------

std::mutex g_registry_mu;
// player -> its live connections. Small N; a flat vector per player is plenty.
std::map<std::string, std::vector<std::shared_ptr<WsConnection>>> g_registry;
// Player -> removal deadline. Entries intentionally remain after expiry as tombstones so a
// very-late socket teardown cannot resurrect an already-removed ghost; registry_add erases one.
std::map<std::string, long long> g_roster_grace_deadline;

// The connection whose real TCP peer is loopback IS the host: a tunnel or LAN peer always presents
// its own address to accept(), so nothing a client sends in headers or the URL can spoof this.
bool socket_is_loopback_peer(::socket_t sock) {
    std::string ip;
    int port = 0;
    httplib::detail::get_remote_ip_and_port(sock, ip, port);
    return peer_ip_is_loopback(ip);
}

std::mutex g_auth_mu;
WsAuthFn g_auth;                                    // unset => allow all

std::mutex g_v1_info_mu;
V1MapInfoFn g_v1_map_info;                          // hello_ack map dims + world_seq provider

// Monotonic session-id counter for v1 hello_ack "session" (uuid-ish, per connection).
std::atomic<uint64_t> g_session_counter{0};

// Every WS frame successfully written to a socket. The 60 s heartbeat prints the DELTA, which is
// how a crash tail proves the transport was still moving bytes in the minute before DF died.
std::atomic<uint64_t> g_ws_frames_sent{0};
std::atomic<size_t> g_reqblocks_map_capacity{0};  // total blocks in the loaded map; zero when unavailable
std::atomic<size_t> g_reqblocks_queued_total{0};
std::atomic<uint64_t> g_reqblocks_coalesced{0};
std::atomic<uint64_t> g_reqblocks_dropped_cap{0};
std::atomic<uint64_t> g_chat_dropped_rate{0};
std::atomic<uint64_t> g_ws_upgrade_misclassified{0};

// Sanity cap on an inbound frame payload so a hostile/broken client cannot make us
// allocate unbounded memory (control JSON from the browser is tiny).
constexpr uint64_t kMaxInboundPayload = 16u * 1024u * 1024u;   // 16 MiB

// ---- SHA-1 (public-domain style, complete) -------------------------------------
struct Sha1 {
    uint32_t h[5];
    uint64_t len = 0;
    uint8_t buf[64];
    size_t bi = 0;
    Sha1() {
        h[0] = 0x67452301u; h[1] = 0xEFCDAB89u; h[2] = 0x98BADCFEu;
        h[3] = 0x10325476u; h[4] = 0xC3D2E1F0u;
    }
    static uint32_t rol(uint32_t v, int c) { return (v << c) | (v >> (32 - c)); }
    void block(const uint8_t* p) {
        uint32_t w[80];
        for (int i = 0; i < 16; i++)
            w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) |
                   (uint32_t(p[i * 4 + 2]) << 8) | uint32_t(p[i * 4 + 3]);
        for (int i = 16; i < 80; i++)
            w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; i++) {
            uint32_t f, k;
            if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999u; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1u; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDCu; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6u; }
            uint32_t t = rol(a, 5) + f + e + k + w[i];
            e = d; d = c; c = rol(b, 30); b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    void add(const uint8_t* p, size_t n) {
        len += uint64_t(n) * 8;
        while (n) { buf[bi++] = *p++; n--; if (bi == 64) { block(buf); bi = 0; } }
    }
    void finish(uint8_t out[20]) {
        // Capture the ORIGINAL message bit-length BEFORE padding: the add() calls below advance
        // `len`, so reading it afterwards encodes the padded length and corrupts the digest.
        uint64_t ml = len;
        uint8_t pad = 0x80; add(&pad, 1);
        uint8_t z = 0; while (bi != 56) add(&z, 1);
        uint8_t lb[8]; for (int i = 0; i < 8; i++) lb[i] = uint8_t(ml >> (56 - i * 8));
        add(lb, 8);
        for (int i = 0; i < 5; i++) {
            out[i * 4] = uint8_t(h[i] >> 24);
            out[i * 4 + 1] = uint8_t(h[i] >> 16);
            out[i * 4 + 2] = uint8_t(h[i] >> 8);
            out[i * 4 + 3] = uint8_t(h[i]);
        }
    }
};

std::string ws_accept(const std::string& key) {
    std::string s = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    Sha1 h; h.add(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    uint8_t dg[20]; h.finish(dg);
    return base64(dg, 20);
}

// Known-answer self-test of SHA-1, base64 and the RFC6455 Accept derivation. A failure here means
// no browser or edge would ever accept our Upgrade.
bool ws_crypto_selftest() {
    // 1) SHA-1("abc") == a9993e36 4706816a ba3e2571 7850c26c 9cd0d89d
    static const uint8_t kAbc[20] = {
        0xa9,0x99,0x3e,0x36,0x47,0x06,0x81,0x6a,0xba,0x3e,
        0x25,0x71,0x78,0x50,0xc2,0x6c,0x9c,0xd0,0xd8,0x9d};
    Sha1 s; s.add(reinterpret_cast<const uint8_t*>("abc"), 3);
    uint8_t d[20]; s.finish(d);
    if (std::memcmp(d, kAbc, 20) != 0) return false;
    // 2) base64("Man") == "TWFu"
    if (base64(reinterpret_cast<const uint8_t*>("Man"), 3) != "TWFu") return false;
    // 3) RFC6455 handshake vector.
    if (ws_accept("dGhlIHNhbXBsZSBub25jZQ==") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        return false;
    return true;
}

// Run once at load: it keeps ws_crypto_selftest() referenced, so it is not dead-stripped, and
// surfaces a handshake-crypto regression loudly instead of as a silent failed Upgrade.
const bool g_ws_crypto_ok = [] {
    bool ok = ws_crypto_selftest();
    if (!ok)
        std::fputs("dwf: FATAL WebSocket crypto self-test FAILED "
                   "(Sec-WebSocket-Accept will be wrong)\n", stderr);
    return ok;
}();

// ---- raw socket helpers --------------------------------------------------------
// Used on sockets this file set non-blocking, so EWOULDBLOCK means "not yet", not a dead peer.
#ifdef _WIN32
inline int sock_last_err() { return WSAGetLastError(); }
inline bool sock_would_block(int e) { return e == WSAEWOULDBLOCK; }
#else
inline int sock_last_err() { return errno; }
inline bool sock_would_block(int e) { return e == EWOULDBLOCK || e == EAGAIN; }
#endif

// NEVER hold the socket in a long-blocking call: on this Winsock stack a thread parked in one
// serializes every concurrent op on the SAME handle, which froze the writer behind the recv thread.
constexpr int kPollSleepMs = 4;          // retry cadence when a non-blocking op would block
constexpr int kSendStallCapMs = 10000;   // give up on a send that can't drain for this long
// Windows autotunes SO_SNDBUF to megabytes, so ::send to a black-holed peer keeps succeeding for
// tens of seconds. Bounding it restores backpressure and lets the stall cap prune a dead peer.
constexpr int kSendBufBytes = 262144;    // 256 KiB

// Browsers auto-PONG protocol pings, so any live client refreshes last_inbound within one interval;
// a vanished client goes silent and is swept at kSilenceCloseMs.
constexpr long long kPingIntervalMs = 10000;
constexpr long long kSilenceCloseMs = 45000;
constexpr long long kRosterGraceMs = 5000;   // absorb refresh/reconnect flaps without row flicker
constexpr int kHttpIoTimeoutMs = 5000;       // bound dead HTTP peers; never held under DF locks

bool recv_all(::socket_t s, uint8_t* p, size_t n) {
    while (n) {
        int r = ::recv(s, reinterpret_cast<char*>(p), (int)n, 0);
        if (r > 0) { p += r; n -= (size_t)r; continue; }
        if (r == 0) return false;                                  // peer closed
        if (sock_would_block(sock_last_err())) {                   // no data yet: brief sleep, retry
            std::this_thread::sleep_for(std::chrono::milliseconds(kPollSleepMs));
            continue;                                              // idle client may stay silent for
        }                                                          // minutes; ::recv returns 0/err on close
        return false;                                              // real error
    }
    return true;
}
bool send_all(::socket_t s, const uint8_t* p, size_t n) {
    // An ABSOLUTE per-frame cap, not a "made progress" reset: a half-open peer dribbling a few
    // bytes per RTO would keep the stall timer alive and delay the zombie prune indefinitely.
    auto call_start = std::chrono::steady_clock::now();
    while (n) {
        int r = ::send(s, reinterpret_cast<const char*>(p), (int)n, 0);
        if (r > 0) { p += r; n -= (size_t)r; continue; }
        if (r < 0 && sock_would_block(sock_last_err())) {          // send buffer full: sleep, retry
            auto now = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::milliseconds>(now - call_start).count()
                > kSendStallCapMs)
                return false;                                      // stuck client: drop after cap
            std::this_thread::sleep_for(std::chrono::milliseconds(kPollSleepMs));
            continue;
        }
        return false;                                              // r==0 or real error
    }
    return true;
}
// Clear the read timeout httplib set for HTTP request parsing: a WebSocket is long-lived, and a
// well-behaved client legitimately sends nothing for long stretches.
void clear_socket_read_timeout(::socket_t s) {
#ifdef _WIN32
    // Keep the socket NON-BLOCKING so neither thread ever parks in a long-blocking call; recv_all
    // and send_all sleep-poll instead. TCP_NODELAY disables Nagle so small frames leave at once.
    u_long nonblocking = 1;   // 1 => non-blocking
    int rc = ::ioctlsocket(s, FIONBIO, &nonblocking);
    BOOL one = TRUE;
    int rc4 = ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof(one));
    int sndbuf = kSendBufBytes;   // bound the send buffer so a dead peer's ::send blocks fast
    ::setsockopt(s, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&sndbuf), sizeof(sndbuf));
    if (rc != 0 || rc4 != 0)   // unconditional only on FAILURE (should never happen)
        diagnostics_log("sock-setup FAILED sock=" + std::to_string((long long)s) +
                        " FIONBIO_rc=" + std::to_string(rc) + " NODELAY_rc=" + std::to_string(rc4));
    else
        diagnostics_log_v("sock-setup sock=" + std::to_string((long long)s) + " ok");
#else
    int flags = ::fcntl(s, F_GETFL, 0);
    if (flags != -1) ::fcntl(s, F_SETFL, flags & ~O_NONBLOCK);
    struct timeval tv; tv.tv_sec = 0; tv.tv_usec = 0;
    ::setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    struct timeval sndtv; sndtv.tv_sec = 8; sndtv.tv_usec = 0;
    ::setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &sndtv, sizeof(sndtv));
    int sndbuf = kSendBufBytes;   // bound the send buffer so a dead peer's ::send blocks fast
    ::setsockopt(s, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
#endif
}
bool set_socket_nonblocking(::socket_t s, bool enabled) {
#ifdef _WIN32
    u_long mode = enabled ? 1 : 0;
    return ::ioctlsocket(s, FIONBIO, &mode) == 0;
#else
    int flags = ::fcntl(s, F_GETFL, 0);
    if (flags == -1) return false;
    return ::fcntl(s, F_SETFL, enabled ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK)) == 0;
#endif
}

void configure_http_socket(::socket_t s) {
    // No capture mutex or CoreSuspender is live here, but bound the kernel call anyway: a dead
    // reader may hold one HTTP worker for at most this deadline, never the server indefinitely.
    (void)set_socket_nonblocking(s, false);
#ifdef _WIN32
    DWORD timeout = kHttpIoTimeoutMs;
    ::setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    ::setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    int sndbuf = kSendBufBytes;
    ::setsockopt(s, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char*>(&sndbuf), sizeof(sndbuf));
#else
    struct timeval timeout;
    timeout.tv_sec = kHttpIoTimeoutMs / 1000; timeout.tv_usec = (kHttpIoTimeoutMs % 1000) * 1000;
    ::setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    ::setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    int sndbuf = kSendBufBytes;
    ::setsockopt(s, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
#endif
}

void shutdown_fd(::socket_t s) {
#ifdef _WIN32
    ::shutdown(s, SD_BOTH);
#else
    ::shutdown(s, SHUT_RDWR);
#endif
}

void close_fd(::socket_t s) {
#ifdef _WIN32
    ::closesocket(s);
#else
    ::close(s);
#endif
}

// Case-insensitive scan of a raw HTTP request head for a header value.
std::string header_val(const std::string& req, const char* name) {
    std::string ln, want = name;
    for (auto& c : want) c = (char)std::tolower((unsigned char)c);
    std::istringstream ss(req);
    while (std::getline(ss, ln)) {
        auto colon = ln.find(':');
        if (colon == std::string::npos) continue;
        std::string k = ln.substr(0, colon);
        for (auto& c : k) c = (char)std::tolower((unsigned char)c);
        while (!k.empty() && (k.back() == ' ' || k.back() == '\r')) k.pop_back();
        if (k == want) {
            std::string v = ln.substr(colon + 1);
            size_t a = v.find_first_not_of(" \t");
            size_t b = v.find_last_not_of(" \t\r");
            return a == std::string::npos ? std::string() : v.substr(a, b - a + 1);
        }
    }
    return {};
}

// The request-target ("/ws?player=x") -> path only ("/ws").
std::string req_path(const std::string& head) {
    auto sp = head.find(' ');
    if (sp == std::string::npos) return "/";
    auto sp2 = head.find(' ', sp + 1);
    if (sp2 == std::string::npos) return "/";
    std::string p = head.substr(sp + 1, sp2 - sp - 1);
    auto q = p.find('?');
    return q == std::string::npos ? p : p.substr(0, q);
}

// Extract ?player=NAME from the request target; url-decode is not needed for our
// player ids (uuid / alnum), but we stop at the next '&'. Defaults to "guest".
std::string req_player(const std::string& head) {
    auto sp = head.find(' ');
    if (sp == std::string::npos) return "guest";
    auto sp2 = head.find(' ', sp + 1);
    if (sp2 == std::string::npos) return "guest";
    std::string target = head.substr(sp + 1, sp2 - sp - 1);
    auto qp = target.find("player=");
    if (qp == std::string::npos) return "guest";
    std::string p = target.substr(qp + 7);
    auto amp = p.find('&');
    if (amp != std::string::npos) p = p.substr(0, amp);
    // The browser builds this URL with encodeURIComponent, so decode here with the SAME rule
    // httplib uses for HTTP params: both transports must canonicalize one identical raw identity.
    p = httplib::detail::decode_url(p, /*convert_plus_to_space=*/true);
    // Validate the DECODED identity with the same gate HTTP uses, or a control-char name registers
    // on the WS while every HTTP ?player= maps it to "default". Rejection falls back to "guest".
    if (p.empty() || !is_safe_player_id(p))
        return std::string("guest");
    return p;
}

// An integer query param off the request target; `def` when absent or unparseable.
int req_int(const std::string& head, const char* name, int def) {
    auto sp = head.find(' ');
    if (sp == std::string::npos) return def;
    auto sp2 = head.find(' ', sp + 1);
    if (sp2 == std::string::npos) return def;
    std::string target = head.substr(sp + 1, sp2 - sp - 1);
    std::string key = std::string(name) + "=";
    auto qp = target.find(key);
    if (qp == std::string::npos) return def;
    std::string v = target.substr(qp + key.size());
    auto amp = v.find('&');
    if (amp != std::string::npos) v = v.substr(0, amp);
    if (v.empty()) return def;
    int out = 0;
    for (char c : v) {
        if (c < '0' || c > '9') return def;
        out = out * 10 + (c - '0');
        if (out > 100000) return def;
    }
    return out;
}

bool check_auth(const std::string& cookie) {
    WsAuthFn fn;
    { std::lock_guard<std::mutex> lk(g_auth_mu); fn = g_auth; }
    if (!fn) return true;   // no auth wired yet -> permit
    return fn(cookie);
}

// ---- registry ------------------------------------------------------------------
void registry_add(const std::shared_ptr<WsConnection>& c) {
    c->start_writer();   // dedicated outbound thread so a slow socket never stalls the push loop
    {
        std::lock_guard<std::mutex> lk(g_registry_mu);
        g_registry[c->player()].push_back(c);
        g_roster_grace_deadline.erase(c->player());   // reconnect re-adopts the row immediately
    }
}
void registry_remove(const std::shared_ptr<WsConnection>& c) {
    bool last_gone = false;
    {
        std::lock_guard<std::mutex> lk(g_registry_mu);
        auto it = g_registry.find(c->player());
        if (it == g_registry.end()) return;
        auto& v = it->second;
        v.erase(std::remove(v.begin(), v.end(), c), v.end());
        if (v.empty()) {
            g_registry.erase(it);
            g_roster_grace_deadline.emplace(c->player(), steady_ms() + kRosterGraceMs);
            last_gone = true;
        }
    }
    // When a player's LAST socket departs, drop its /diag row. world_stream_forget only erases a
    // map entry keyed by player, so it is safe under no other lock.
    if (last_gone) {
        world_stream_forget(c->player());
    }
}

// Per-player server state is keyed on the player NAME, so two live connections sharing a name would
// share one camera and one delta baseline. At HELLO a colliding name becomes "name-2", "name-3", ...
std::mutex g_dedup_mu;

// Moves `c` between registry buckets and updates player_ atomically with respect to the registry,
// so registry_remove and the push loop can never see two different names. Caller holds g_dedup_mu.
void ws_rename_connection(const std::shared_ptr<WsConnection>& c, const std::string& newName) {
    std::lock_guard<std::mutex> lk(g_registry_mu);
    std::string oldName = c->player();
    if (oldName == newName) return;
    auto it = g_registry.find(oldName);
    if (it != g_registry.end()) {
        auto& v = it->second;
        v.erase(std::remove(v.begin(), v.end(), c), v.end());
        if (v.empty()) g_registry.erase(it);
    }
    c->set_player(newName);
    g_registry[newName].push_back(c);
    g_roster_grace_deadline.erase(newName);
}

void dedup_player_name(const std::shared_ptr<WsConnection>& conn, const std::string& clientId) {
    std::lock_guard<std::mutex> lk(g_dedup_mu);   // serialize all dedups (no two hellos race a name)
    const std::string base = conn->player();
    auto conns = ws_v1_connections();
    auto taken = [&](const std::string& cand) -> bool {
        for (auto& c : conns) {
            if (c.get() == conn.get()) continue;
            if (!c->hello_received()) continue;                     // hasn't claimed a name yet
            if (!clientId.empty() && c->client_id() == clientId) continue;  // our own ghost (refresh)
            if (c->player() == cand) return true;
        }
        return false;
    };
    if (!taken(base)) return;   // name is free -> keep it
    for (int n = 2; n < 10000; ++n) {
        std::string cand = base + "-" + std::to_string(n);
        if (!taken(cand)) { ws_rename_connection(conn, cand); return; }
    }
}

// hello_ack: map dims and world_seq come from the registered provider, the rest are protocol facts.
// `limits.k` is advertised at its FLOOR value -- window_open() scales the real admission window.
void send_hello_ack(const std::shared_ptr<WsConnection>& conn) {
    V1MapInfo mi;
    { V1MapInfoFn fn;
      { std::lock_guard<std::mutex> lk(g_v1_info_mu); fn = g_v1_map_info; }
      if (fn) mi = fn(); }
    std::string ack =
        "{\"type\":\"hello_ack\",\"proto\":1,\"world_seq\":" + std::to_string(mi.world_seq) +
        // The authoritative, possibly deduped, player name, sent on EVERY hello_ack so a client
        // self-heals. chat_escape, not json_escape, whose DF2UTF transcode would mojibake UTF-8.
        ",\"player\":\"" + chat_escape(conn->player()) + "\"" +
        ",\"session\":\"" + conn->session() + "\",\"tick_ms\":33,\"map\":{\"w\":" +
        std::to_string(mi.w) + ",\"h\":" + std::to_string(mi.h) + ",\"z\":" +
        std::to_string(mi.z) + "},\"limits\":{\"k\":3,\"bulk_bytes\":262144,\"ack_every\":1}" +
        // Server-computed from the peer address; never anything the client claimed.
        ",\"isHost\":" + std::string(conn->is_host() ? "true" : "false") +
        // The server build stamp. The client compares it to its own baked window.DFCAPTURE_BUILD
        // and shows the stale-tab banner on mismatch. Additive -- an old client ignores it.
        ",\"build\":\"" + json_escape(auth::build_stamp()) + "\"}";
    conn->enqueue_frame(WsConnection::CH_CTRL,
                        std::vector<uint8_t>(ack.begin(), ack.end()), /*binary=*/false);
}

// Route one decoded text frame from a connection. Legacy sessions understand cursor +
// reqkey; v1 sessions add hello/ack/cam/pong. Anything else is ignored.
void handle_client_text(const std::shared_ptr<WsConnection>& conn, const std::string& payload) {
    if (payload.size() > 4096) return;   // control JSON is tiny; ignore anything huge
    const std::string& player = conn->player();
    const json_mini::Doc doc = json_mini::parse(payload);
    auto malformed = [&](const std::string& detail) {
        if (conn->control_json_error_log_ok())
            diagnostics_log("ws control JSON rejected player=" + player + " detail=" + detail);
    };
    if (!doc.ok || doc.root.type != json_mini::Type::Object) {
        malformed(doc.ok ? "root must be an object" : doc.error);
        return;
    }
    std::string message_type;
    const json_mini::Get type_result = json_mini::string(doc.root, "type", message_type);
    if (type_result != json_mini::Get::Ok) {
        if (type_result == json_mini::Get::Malformed) malformed("field 'type' must be a string");
        return;
    }
    auto is_type = [&](const char* expected) { return message_type == expected; };
    auto get_number = [&](const json_mini::Value& scope, const char* key, double& out) {
        const json_mini::Get result = json_mini::number(scope, key, out);
        if (result == json_mini::Get::Malformed)
            malformed(std::string("field '") + key + "' must be a finite number");
        return result == json_mini::Get::Ok;
    };
    auto get_string = [&](const json_mini::Value& scope, const char* key, std::string& out) {
        const json_mini::Get result = json_mini::string(scope, key, out);
        if (result == json_mini::Get::Malformed)
            malformed(std::string("field '") + key + "' must be a string");
        return result == json_mini::Get::Ok;
    };

    // ---- protocol v1 control ---------------------------------------------------------
    if (conn->is_v1()) {
        if (is_type("hello")) {
            // With a passphrase configured the hello MUST carry it: the pre-routing HTTP gate
            // cannot see /ws. On failure, tell the client (auth_fail) and then close.
            if (dwf::auth::enabled()) {
                std::string tok;
                get_string(doc.root, "token", tok);
                if (!dwf::auth::check(tok)) {
                    diagnostics_log("ws hello DENIED (bad/missing join token) player=" + player);
                    const std::string deny = "{\"type\":\"auth_fail\",\"reason\":\"join password required\"}";
                    conn->enqueue_frame(WsConnection::CH_CTRL,
                                        std::vector<uint8_t>(deny.begin(), deny.end()), /*binary=*/false);
                    conn->deny_after_flush();
                    return;
                }
            }
            double have = 0;
            get_number(doc.root, "have", have);
            // HELLO normally carries camera fields in a nested object. The top-level fallback
            // preserves compatibility with early protocol-v1 clients without field shadowing.
            const json_mini::Value* cam_scope = &doc.root;
            const json_mini::Value* nested_cam = nullptr;
            const json_mini::Get cam_result = json_mini::object(doc.root, "cam", nested_cam);
            if (cam_result == json_mini::Get::Ok) cam_scope = nested_cam;
            else if (cam_result == json_mini::Get::Malformed) malformed("field 'cam' must be an object");
            double cw = 0, ch = 0, cx = 0, cy = 0, cz = 0;
            bool has_cam = get_number(*cam_scope, "w", cw) & get_number(*cam_scope, "h", ch);
            get_number(*cam_scope, "x", cx); get_number(*cam_scope, "y", cy); get_number(*cam_scope, "z", cz);
            // The capability list is additive: old clients send no caps and keep full AUX.
            bool wants_auxd = false;
            const auto caps_it = doc.root.object.find("caps");
            if (caps_it != doc.root.object.end() && caps_it->second.type == json_mini::Type::Array) {
                for (const auto& cap : caps_it->second.array)
                    if (cap.type == json_mini::Type::String && cap.string == "auxd") wants_auxd = true;
            } else if (caps_it != doc.root.object.end()) {
                malformed("field 'caps' must be an array");
            }
            conn->set_wants_auxd(wants_auxd);
            conn->mark_hello((uint32_t)(have < 0 ? 0 : have), has_cam,
                             (int)cx, (int)cy, (int)cz, (int)cw, (int)ch);
            // mark_hello ran first, so a concurrent hello already sees this connection as an
            // established name when the dedup scan runs.
            std::string cid;
            if (get_string(doc.root, "id", cid)) {
                if (cid.size() > 64) cid.resize(64);
                conn->set_client_id(cid);
            }
            dedup_player_name(conn, conn->client_id());
            send_hello_ack(conn);
            return;
        }
        // In-session rename reuses the join machinery: move the registry bucket, run the same
        // dedup, carry the name-keyed camera/cursor/follow state, and reply with a hello_ack.
        if (is_type("rename")) {
            std::string requested;
            if (!get_string(doc.root, "name", requested)) return;
            // Same validation contract as the join card: trim, non-empty, maxlength 32.
            // is_safe_player_id rejects only control chars, so spaces and UTF-8 are accepted.
            size_t b = requested.find_first_not_of(" \t\r\n");
            if (b == std::string::npos) return;                 // empty after trim -> ignore
            size_t e = requested.find_last_not_of(" \t\r\n");
            requested = requested.substr(b, e - b + 1);
            if (requested.size() > 32) requested.resize(32);
            if (!is_safe_player_id(requested)) return;
            const std::string oldName = conn->player();
            if (requested == oldName) { send_hello_ack(conn); return; }   // no-op rename
            ws_rename_connection(conn, requested);
            dedup_player_name(conn, conn->client_id());
            const std::string finalName = conn->player();
            rename_player_state(oldName, finalName);   // move view/cursor/follow to the new name
            world_stream_forget(oldName);              // drop the stale /diag row under the old name
            send_hello_ack(conn);                      // client adopts finalName via __dwfAdoptName
            return;
        }
        if (is_type("ack")) {
            double seq = 0;
            if (get_number(doc.root, "seq", seq) && seq >= 0) conn->apply_ack((uint32_t)seq);
            return;
        }
        if (is_type("cam")) {
            double cw = 0, ch = 0, cx = 0, cy = 0, cz = 0;
            bool has_dims = get_number(doc.root, "w", cw) & get_number(doc.root, "h", ch);
            bool has_pos = get_number(doc.root, "x", cx) & get_number(doc.root, "y", cy);
            bool has_z = get_number(doc.root, "z", cz);
            if (has_dims || has_pos)
                conn->update_cam(has_pos, (int)cx, (int)cy, (int)cz,
                                 has_dims ? (int)cw : 0, has_dims ? (int)ch : 0);
            // PRIMARY CAMERA TRANSPORT: a cam message carrying a position writes the SAME
            // per-player camera authority POST /camera writes, keyed on conn->player().
            if (has_pos) {
                Camera camera;
                std::string cam_err;
                if (camera_for_player(player, camera, &cam_err)) {
                    camera.x = (int)cx;
                    camera.y = (int)cy;
                    // Mirror POST /camera's absolute branch: overwrite z only when the message
                    // carried one.
                    if (has_z)
                        camera.z = (int)cz;
                    if (camera.z < 0)
                        camera.z = 0;
                    if (clamp_camera(camera, &cam_err)) {
                        forget_player_follow(player);
                        set_player_camera(player, camera);
                        notify_player_input();
                    }
                }
            }
            return;
        }
        if (is_type("pong")) {
            double ts = 0, tc = 0;
            get_number(doc.root, "ts", ts);
            get_number(doc.root, "tc", tc);
            conn->note_app_pong((long long)ts, (long long)tc);
            return;
        }
        if (is_type("auxr")) {
            conn->request_aux_full();
            return;
        }
        if (is_type("reqblocks")) {
            std::vector<std::array<int, 3>> triples;
            const json_mini::Get blocks_result =
                json_mini::int_triples(doc.root, "blocks", triples, 64);
            if (blocks_result == json_mini::Get::Malformed)
                malformed("field 'blocks' must contain integer triples");
            if (!triples.empty()) conn->queue_reqblocks(triples);   // map-bounded + coalesced; all pending handed off <=1/250ms
            return;
        }
        if (is_type("reqkey")) {
            // reqkey is treated as reqblocks for the interest window, and that window is already
            // re-offered every tick, so there is nothing extra to queue here.
            return;
        }
    }

    // The WS handshake already authenticated this connection, so chat needs no further auth. A
    // rate refusal is sent back on the control channel so the composer never looks successful.
    if (is_type("chat")) {
        long long retry_after_ms = 0;
        if (!conn->chat_rate_ok(&retry_after_ms)) {
            const std::string rejected = "{\"type\":\"chat_rejected\",\"reason\":\"rate_limit\",\"retryMs\":" +
                std::to_string(retry_after_ms) + "}";
            conn->enqueue_frame(WsConnection::CH_CTRL,
                std::vector<uint8_t>(rejected.begin(), rejected.end()), /*binary=*/false);
            return;
        }
        std::string text;
        if (get_string(doc.root, "text", text)) chat_post(conn->player(), text);
        return;
    }

    if (!is_type("cursor")) return;
    double x = 0, y = 0, z = 0, fx = 0, fy = 0, drag = 0;
    get_number(doc.root, "x", x);
    get_number(doc.root, "y", y);
    get_number(doc.root, "z", z);
    get_number(doc.root, "fx", fx);
    get_number(doc.root, "fy", fy);
    get_number(doc.root, "drag", drag);
    set_player_precise_cursor(player, (int)x, (int)y, (int)z,
                              (float)fx, (float)fy, drag != 0);
}

// ---- the connection handler for /ws --------------------------------------------
// Push-only from the server's side: register the socket, then drain client control frames.
void handle_ws_connection(std::shared_ptr<WsConnection> conn) {
    registry_add(conn);

    // Drain inbound control frames until the peer closes; ping/pong/close live inside recv().
    diagnostics_log_v("recv-loop ENTER player=" + conn->player());
    std::string payload;
    bool is_binary = false;
    std::string err;
    while (conn->recv(payload, is_binary, &err)) {
        // Text frames are small control JSON; binary from the client is reserved and ignored.
        if (!is_binary) handle_client_text(conn, payload);
    }
    diagnostics_log_v("recv-loop EXIT player=" + conn->player() + " reason=" + err);

    registry_remove(conn);   // removed from registry first: the push loop won't enqueue anymore
    conn->stop_writer();     // drain/join the outbound thread before we tear the socket down
    conn->close();
}

// ---- the httplib::Server subclass ----------------------------------------------
class WsHttpServer : public httplib::Server {
public:
    void begin_shutdown() {
        {
            std::lock_guard<std::mutex> lk(ws_threads_mu_);
            ws_stopping_ = true;
        }
        // stop() closes only the listen socket: the pool still drains every accepted connection,
        // and an idle keep-alive can hold a worker for five seconds. Wake them instead.
        {
            std::lock_guard<std::mutex> lk(http_sockets_mu_);
            http_stopping_ = true;
            for (auto sock : http_sockets_) shutdown_fd(sock);
        }
        ws_close_all();
    }

    ~WsHttpServer() override {
        // Enforce the no-new-upgrades side of teardown even if httplib changes its task-queue
        // destruction order. Idempotent, so it also covers destruction without begin_shutdown.
        begin_shutdown();
        std::vector<std::pair<std::shared_ptr<std::atomic<bool>>, std::thread>> threads;
        { std::lock_guard<std::mutex> lk(ws_threads_mu_); threads.swap(ws_threads_); }
        for (auto& entry : threads) if (entry.second.joinable()) entry.second.join();
    }

protected:
    // process_and_close_socket is a PRIVATE virtual on httplib::Server. Overriding it is legal but
    // CALLING it is not, so the non-WS path replicates the base body via the protected members.
    bool process_and_close_socket(::socket_t sock) override {
        // Register with the shutdown tracker before anything that can block: a worker arriving
        // after begin_shutdown must not enter the classifier or the keep-alive wait at all.
        {
            std::lock_guard<std::mutex> lk(http_sockets_mu_);
            if (http_stopping_) {
                close_fd(sock);
                return false;
            }
            http_sockets_.insert(sock);
        }
        auto untrack_http = [this, sock] {
            std::lock_guard<std::mutex> lk(http_sockets_mu_);
            http_sockets_.erase(sock);
        };

        // accept() returns a blocking socket. Make classification non-blocking first: a client
        // that connects and dies before sending headers must not occupy a pool worker forever.
        if (!set_socket_nonblocking(sock, true)) {
            configure_http_socket(sock);   // fallback remains bounded even if FIONBIO failed
        }
        // PEEK until the WHOLE header block has arrived: a browser splits the handshake across TCP
        // segments, and a block larger than this buffer misclassifies a real /ws Upgrade as HTTP.
        constexpr size_t kWsUpgradePeekBytes = 16384;
        std::array<char, kWsUpgradePeekBytes> peek{};
        int n = 0;
        for (int tries = 0; tries < 200; ++tries) {   // up to ~200ms for the header block
            int r = ::recv(sock, peek.data(), (int)peek.size() - 1, MSG_PEEK);
            if (r < 0) {
                // A MSG_PEEK issued before the request bytes arrive returns EWOULDBLOCK on a
                // non-blocking socket. That means "header not here yet", never "not a WebSocket".
                if (sock_would_block(sock_last_err())) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    continue;
                }
                n = r; break;                          // real error -> let base handle
            }
            if (r == 0) { n = 0; break; }              // peer closed -> let base handle
            n = r;
            if (std::string(peek.data(), (size_t)n).find("\r\n\r\n") != std::string::npos)
                break;                                 // full header block present -> decide now
            if (n >= (int)peek.size() - 1) break;      // headers exceed peek buffer -> stop waiting
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (n > 0) {
            std::string head(peek.data(), (size_t)n);
            std::string up = header_val(head, "Upgrade");
            for (auto& c : up) c = (char)std::tolower((unsigned char)c);
            if (up.find("websocket") != std::string::npos &&
                head.find("\r\n\r\n") != std::string::npos) {
                // Hand off to the WS registry, which has its own shutdown tracking
                // (ws_stopping_ / ws_close_all); this socket is no longer HTTP's to wake.
                untrack_http();
                launch_upgrade(sock, head);
                return true;   // WS lifetime no longer consumes a shared HTTP pool worker
            }
            if (up.find("websocket") != std::string::npos &&
                    head.find("\r\n\r\n") == std::string::npos) {
                std::string request_line = head.substr(0, std::min<size_t>(head.find("\r\n"), 120));
                for (char& ch : request_line)
                    if (static_cast<unsigned char>(ch) < 0x20) ch = ' ';
                const bool full = n >= static_cast<int>(peek.size()) - 1;
                g_ws_upgrade_misclassified.fetch_add(1, std::memory_order_relaxed);
                diagnostics_log("ws upgrade header incomplete reason=" +
                    std::string(full ? "buffer-full" : "timeout") +
                    " bytes=" + std::to_string(n) + " request=" + request_line);
            }
        }
        // Not a WebSocket. MSG_PEEK consumed nothing, so the bytes are still queued for the base
        // parser. Restore blocking I/O with kernel deadlines so a dead peer releases this worker.
        configure_http_socket(sock);
        bool result = httplib::detail::process_and_close_socket(
            /*is_client_request=*/false, sock, keep_alive_max_count_,
            read_timeout_sec_, read_timeout_usec_,
            [this](httplib::Stream& strm, bool last_connection,
                   bool& connection_close) {
                return this->process_request(strm, last_connection,
                                             connection_close, nullptr);
            });
        untrack_http();
        return result;
    }

private:
    void launch_upgrade(::socket_t sock, std::string head) {
        std::lock_guard<std::mutex> lk(ws_threads_mu_);
        if (ws_stopping_) {
            close_fd(sock);
            return;
        }
        // Join completed connection threads now, rather than holding one OS thread handle per
        // historical reconnect until shutdown.
        for (auto it = ws_threads_.begin(); it != ws_threads_.end(); ) {
            if (!it->first->load()) { ++it; continue; }
            if (it->second.joinable()) it->second.join();
            it = ws_threads_.erase(it);
        }
        auto done = std::make_shared<std::atomic<bool>>(false);
        ws_threads_.emplace_back(done, std::thread([this, sock, head = std::move(head), done] {
            (void)handle_upgrade(sock, head);
            done->store(true);
        }));
    }

    bool handle_upgrade(::socket_t sock, const std::string& head) {
        // We only PEEKed the head; drain exactly it off the socket (a WS client sends
        // no body before the upgrade completes, so there is nothing else to consume).
        size_t hs = head.find("\r\n\r\n") + 4;
        std::vector<uint8_t> drain(hs);
        if (hs && !recv_all(sock, drain.data(), hs)) { close_fd(sock); return true; }

        std::string path = req_path(head);
        std::string key = header_val(head, "Sec-WebSocket-Key");
        std::string cookie = header_val(head, "Cookie");

        auto reject = [&](const char* status) {
            std::string r = std::string("HTTP/1.1 ") + status +
                            "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
            send_all(sock, reinterpret_cast<const uint8_t*>(r.data()), r.size());
            close_fd(sock);
            return true;
        };

        if (path != "/ws") return reject("404 Not Found");
        if (key.empty()) return reject("400 Bad Request");
        if (!check_auth(cookie)) return reject("401 Unauthorized");

        std::string accept = ws_accept(key);
        std::string resp =
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
        if (!send_all(sock, reinterpret_cast<const uint8_t*>(resp.data()),
                      resp.size())) {
            close_fd(sock);
            return true;
        }

        // A WS is long-lived: clear the inherited HTTP read timeout, or an idle client reads as a
        // dead peer and gets dropped.
        clear_socket_read_timeout(sock);

        // `&proto=1` selects a protocol-v1 session; without it there is no map wire at all, just
        // cursor and ping control. A stray ?w=&h= is ignored -- the window comes from HELLO's cam.
        bool proto_v1 = req_int(head, "proto", 0) == 1;
        const bool forwarded = !header_val(head, "X-Forwarded-For").empty() ||
            !header_val(head, "CF-Connecting-IP").empty() ||
            !header_val(head, "Forwarded").empty() || !header_val(head, "X-Real-IP").empty();
        const RequestOrigin origin = classify_request_origin(
            socket_is_loopback_peer(sock), forwarded, header_val(head, "Host"));
        auto conn = std::make_shared<WsConnection>(sock, req_player(head), proto_v1,
                                                   origin_has_host_authority(origin));
        handle_ws_connection(conn);   // owns socket I/O until its recv loop exits
        close_fd(sock);               // exactly one closesocket; WsConnection::close only shutdowns
        return true;
    }

    // launch_upgrade spawns and opportunistically joins finished threads; the destructor rejects
    // new upgrades, closes live connections, then joins the rest. handle_upgrade owns the socket.
    std::mutex ws_threads_mu_;
    bool ws_stopping_ = false;
    std::vector<std::pair<std::shared_ptr<std::atomic<bool>>, std::thread>> ws_threads_;
    std::mutex http_sockets_mu_;
    bool http_stopping_ = false;
    std::set<::socket_t> http_sockets_;
};

} // namespace

// The real accept() peer IP, shared by the socket path and by HTTP callers. Nothing a client can
// spoof through headers or URL params.
bool peer_ip_is_loopback(const std::string& ip) {
    if (ip.empty()) return false;
    if (ip.rfind("127.", 0) == 0) return true;                 // 127.0.0.0/8 (always 127.0.0.1 in practice)
    if (ip == "::1" || ip == "::ffff:127.0.0.1") return true;   // IPv6 loopback (+ v4-mapped form)
    return false;
}

std::string ws_drop_counters_json() {
    std::ostringstream out;
    const uint64_t reqblocks_coalesced = g_reqblocks_coalesced.load(std::memory_order_relaxed);
    out << "{\"reqblocksRate\":" << reqblocks_coalesced   // compatibility: rate-limit events, not drops
        << ",\"reqblocksCoalesced\":" << reqblocks_coalesced
        << ",\"reqblocksCap\":" << g_reqblocks_dropped_cap.load(std::memory_order_relaxed)
        << ",\"reqblocksQueued\":" << g_reqblocks_queued_total.load(std::memory_order_relaxed)
        << ",\"chatRate\":" << g_chat_dropped_rate.load(std::memory_order_relaxed)
        << ",\"upgradeMisclass\":" << g_ws_upgrade_misclassified.load(std::memory_order_relaxed)
        << "}";
    return out.str();
}

// ---- WsConnection --------------------------------------------------------------
WsConnection::WsConnection(::socket_t sock, std::string player, bool proto_v1, bool host_authority)
    : sock_(sock), player_(std::move(player)), is_host_(host_authority), proto_v1_(proto_v1) {
    // Start the silence clock at connect so a client that never sends anything is still swept.
    long long now = steady_ms();
    last_inbound_ms_.store(now);
    last_ping_ms_ = now;
    connect_ms_ = now;
    last_app_ping_ms_ = now;
    if (proto_v1_) {
        // Per-connection session id: time plus counter, in hex. Enough to tell this connection
        // apart in hello_ack and the logs without a real UUID dependency.
        uint64_t n = g_session_counter.fetch_add(1);
        char buf[40];
        std::snprintf(buf, sizeof(buf), "v1-%llx-%llx",
                      (unsigned long long)now, (unsigned long long)n);
        session_ = buf;
    }
}

WsConnection::~WsConnection() {
    // Never let a joinable std::thread reach its destructor (that calls std::terminate).
    // stop_writer() is normally called on disconnect; this is a belt-and-suspenders guard.
    stop_writer();
    std::lock_guard<std::mutex> lk(reqblocks_mu_);
    if (!reqblocks_queue_.empty()) {
        g_reqblocks_queued_total.fetch_sub(reqblocks_queue_.size(), std::memory_order_relaxed);
        reqblocks_queue_.clear();
    }
}

bool WsConnection::send_frame(uint8_t opcode, const uint8_t* data, size_t len) {
    if (closed_.load()) return false;
    // No per-frame logging here: at 30 Hz that is ~60 mutex-serialized file open/write/close per
    // second per player, and it showed up as pan jitter. Error paths below still log.
    std::lock_guard<std::mutex> lk(send_mu_);
    if (closed_.load()) return false;   // re-check under the lock (close() may have raced)
    std::vector<uint8_t> h;
    h.push_back(0x80 | opcode);         // FIN + opcode
    if (len < 126) {
        h.push_back((uint8_t)len);      // no mask bit: server->client is unmasked
    } else if (len < 65536) {
        h.push_back(126);
        h.push_back((uint8_t)((len >> 8) & 0xff));
        h.push_back((uint8_t)(len & 0xff));
    } else {
        h.push_back(127);
        for (int i = 7; i >= 0; i--) h.push_back((uint8_t)((uint64_t)len >> (i * 8)));
    }
    if (!send_all(sock_, h.data(), h.size())) {
#ifdef _WIN32
        int e = WSAGetLastError();
        diagnostics_log("send HEADER-fail player=" + player_ + " err=" + std::to_string(e));
#endif
        closed_.store(true); return false;
    }
    if (len && !send_all(sock_, data, len)) {
#ifdef _WIN32
        int e = WSAGetLastError();
        diagnostics_log("send PAYLOAD-fail player=" + player_ + " len=" + std::to_string(len) +
                        " err=" + std::to_string(e));
#endif
        closed_.store(true); return false;
    }
    g_ws_frames_sent.fetch_add(1, std::memory_order_relaxed);
    return true;
}

bool WsConnection::send_text(const std::string& utf8) {
    return send_frame(0x1, reinterpret_cast<const uint8_t*>(utf8.data()), utf8.size());
}
bool WsConnection::send_binary(const uint8_t* data, size_t len) {
    return send_frame(0x2, data, len);
}

// ---- per-connection outbound writer --------------------------------------------
void WsConnection::writer_loop() {
    diagnostics_log_v("writer START player=" + player_);
    int sent_count = 0;
    static const int kDrainOrder[CH_N] = { CH_CTRL, CH_DICT, CH_AUX, CH_MAP, CH_CURSORS };
    for (;;) {
        std::vector<uint8_t> frame;
        bool binary = true;
        bool got = false;
        V1Frame v1frame;
        bool got_v1 = false;
        {
            std::unique_lock<std::mutex> lk(out_mu_);
            auto any_pending = [&] {
                if (v1_aux_has_ || !v1_map_fifo_.empty() || !chat_fifo_.empty()) return true;
                for (int ch = 0; ch < CH_N; ++ch) if (out_[ch].has) return true;
                return false;
            };
            // Bounded wait: wake at least every second so the keepalive ping + inbound-
            // silence sweep run even on an otherwise idle connection.
            out_cv_.wait_for(lk, std::chrono::milliseconds(1000),
                             [&] { return any_pending() || out_stop_; });
            if (out_stop_ && !any_pending()) {
                diagnostics_log_v("writer EXIT(stop) player=" + player_ + " sent=" + std::to_string(sent_count));
                lk.unlock();   // don't hold out_mu_ across close()'s socket I/O
                close();       // close on EVERY exit path (idempotent)
                return;
            }
            // Hello-token denied -- close once the auth_fail CTRL frame has drained
            // (any_pending() false => the deny frame we queued has been sent this or a prior wake).
            if (deny_after_flush_.load() && !any_pending()) {
                diagnostics_log("writer EXIT(auth-deny) player=" + player_);
                lk.unlock();
                close();
                return;
            }
            // Pick order: CTRL -> dictionary -> chat FIFO -> v1 AUX -> v1 BLOCK_SET FIFO -> the
            // legacy slots. One frame per wake, and the predicate keeps anything left from starving.
            if (out_[CH_CTRL].has) {
                frame.swap(out_[CH_CTRL].bytes); binary = out_[CH_CTRL].binary;
                out_[CH_CTRL].has = false; got = true;
            } else if (out_[CH_DICT].has) {
                frame.swap(out_[CH_DICT].bytes); binary = out_[CH_DICT].binary;
                out_[CH_DICT].has = false; got = true;
            } else if (!chat_fifo_.empty()) {
                // Reliable chat FIFO: before the bulk streams, and never coalesced.
                frame.swap(chat_fifo_.front()); chat_fifo_.pop_front();
                binary = false; got = true;
            } else if (v1_aux_has_) {
                v1frame = std::move(v1_aux_); v1_aux_has_ = false; got_v1 = true;
            } else if (!v1_map_fifo_.empty()) {
                v1frame = std::move(v1_map_fifo_.front()); v1_map_fifo_.pop_front(); got_v1 = true;
            } else {
                for (int i = 0; i < CH_N; ++i) {
                    OutSlot& s = out_[kDrainOrder[i]];
                    if (s.has) { frame.swap(s.bytes); binary = s.binary; s.has = false; got = true; break; }
                }
            }
        }
        // ---- keepalive maintenance, OUTSIDE out_mu_ (send_frame takes send_mu_) ----
        long long now = steady_ms();
        // A v1 connection that never sends `hello` within 5 s is dropped (close 1002).
        if (proto_v1_ && !hello_received_.load() && now - connect_ms_ > 5000) {
            diagnostics_log("writer EXIT(no-hello) player=" + player_);
            close();
            return;
        }
        if (now - last_inbound_ms_.load() > kSilenceCloseMs) {
            // no inbound frame (data OR the browser's auto-PONG to our PINGs) for 45 s ==
            // a dead path even if sends still "succeed" into a black-holed edge. Prune it.
            diagnostics_log("writer EXIT(silence) player=" + player_ +
                            " silentMs=" + std::to_string(now - last_inbound_ms_.load()));
            close();
            return;
        }
        if (now - last_ping_ms_ >= kPingIntervalMs && !closed_.load()) {
            last_ping_ms_ = now;
            if (proto_v1_) {
                // App-level PING on CH_CTRL. The client answers {"type":"pong"} and the recv
                // thread computes rttMs and the clock offset.
                std::string ping = "{\"type\":\"ping\",\"ts\":" + std::to_string(now) + "}";
                enqueue_frame(CH_CTRL, std::vector<uint8_t>(ping.begin(), ping.end()), /*binary=*/false);
                last_app_ping_ms_ = now;
            } else {
                uint8_t pl[8];
                for (int i = 0; i < 8; ++i) pl[i] = (uint8_t)((uint64_t)now >> (8 * i));
                if (!send_frame(0x9, pl, 8)) {   // WS PING; browser auto-PONGs, recv() times the RTT
                    diagnostics_log("writer EXIT(ping-fail) player=" + player_);
                    close();
                    return;
                }
            }
        }
        if (!got && !got_v1) continue;   // woke on the 1 s timer with nothing queued: re-wait
        if (closed_.load()) {
            diagnostics_log_v("writer EXIT(closed) player=" + player_ + " sent=" + std::to_string(sent_count));
            close();   // idempotent; guarantees the fd is shut so the recv thread unblocks
            return;
        }
        // Stamp the seq NOW -- at actual send, so a coalesced-away AUX never orphans one -- then
        // prepend the 10-byte header and account the wire bytes against the pacing window.
        if (got_v1) {
            uint32_t seq = next_seq();
            uint8_t flags = v1frame.deflated ? wire::kFlagDeflated : 0;
            std::vector<uint8_t> out = wire::build_frame_header(v1frame.type, flags, seq);
            out.insert(out.end(), v1frame.payload.begin(), v1frame.payload.end());
            bool ok = send_binary(out.data(), out.size());
            if (!ok) {
                diagnostics_log("writer EXIT(v1-send-fail) player=" + player_ + " seq=" + std::to_string(seq));
                close();
                return;
            }
            record_sent(seq, out.size());
            if (sent_count == 0) diagnostics_log_v("writer FIRST-SEND(v1) player=" + player_ + " bytes=" + std::to_string(out.size()));
            ++sent_count;
            continue;
        }
        bool ok = binary ? send_binary(frame.data(), frame.size())
                         : send_text(std::string(frame.begin(), frame.end()));
        if (!ok) {
            // Unconditional: a writer death is rare and is exactly what you want in the log
            // when a player reports a frozen view.
            diagnostics_log("writer EXIT(send-fail) player=" + player_ + " sent=" + std::to_string(sent_count) +
                            " frameBytes=" + std::to_string(frame.size()));
            // On a send failure send_frame only sets closed_. Without this close() the recv thread
            // polls a half-open socket forever and the push loop keeps paying CoreSuspender for it.
            close();
            return;
        }
        if (sent_count == 0) diagnostics_log_v("writer FIRST-SEND player=" + player_ + " bytes=" + std::to_string(frame.size()));
        ++sent_count;
        // Sustained-rate trace (verbose only): the delivered per-client send count.
        if (sent_count % 60 == 0) diagnostics_log_v("writer player=" + player_ + " totalSent=" + std::to_string(sent_count));
    }
}

void WsConnection::start_writer() {
    out_thread_ = std::thread([this] { writer_loop(); });
}

void WsConnection::stop_writer() {
    {
        std::lock_guard<std::mutex> lk(out_mu_);
        out_stop_ = true;
    }
    out_cv_.notify_all();
    if (out_thread_.joinable()) out_thread_.join();
}

bool WsConnection::enqueue_frame(int chan, std::vector<uint8_t> bytes, bool binary) {
    if (chan < 0 || chan >= CH_N) return false;
    std::lock_guard<std::mutex> lk(out_mu_);
    OutSlot& s = out_[chan];
    bool dropped = s.has;                     // overwriting a still-unsent frame => client behind
    s.bytes.swap(bytes);
    s.binary = binary;
    s.has = true;
    out_cv_.notify_one();
    return dropped;
}

size_t WsConnection::v1_map_fifo_space() const {
    std::lock_guard<std::mutex> lk(out_mu_);
    return v1_map_fifo_.size() >= kV1MapFifoDepth ? 0 : (kV1MapFifoDepth - v1_map_fifo_.size());
}

bool WsConnection::enqueue_v1_block_set(std::vector<uint8_t> payload, bool deflated) {
    std::lock_guard<std::mutex> lk(out_mu_);
    if (v1_map_fifo_.size() >= kV1MapFifoDepth) return false;   // caller shouldn't have assembled
    v1_map_fifo_.push_back(V1Frame{std::move(payload), wire::kTypeBlockSet, deflated});
    out_cv_.notify_one();
    return true;
}

bool WsConnection::enqueue_v1_aux(std::vector<uint8_t> payload, bool deflated) {
    std::lock_guard<std::mutex> lk(out_mu_);
    const bool replaced_unsent = v1_aux_has_;
    v1_aux_.payload.swap(payload);
    v1_aux_.type = wire::kTypeAux;
    v1_aux_.deflated = deflated;
    v1_aux_has_ = true;                       // latest-wins: newest AUX supersedes an unsent one
    out_cv_.notify_one();
    return replaced_unsent;
}

// ---- protocol v1 negotiation + pacing ------------------------------------------------
void WsConnection::mark_hello(uint32_t have, bool has_cam, int x, int y, int z, int w, int h) {
    hello_have_.store(have);
    if (has_cam) update_cam(true, x, y, z, w, h);
    hello_received_.store(true);
}

void WsConnection::update_cam(bool has_pos, int x, int y, int z, int w, int h) {
    std::lock_guard<std::mutex> lk(v1_mu_);
    if (w > 0) cam_w_ = w;
    if (h > 0) cam_h_ = h;
    if (has_pos) { cam_x_ = x; cam_y_ = y; cam_z_ = z; }
    if (cam_w_ > 0 && cam_h_ > 0) cam_valid_.store(true);
}

bool WsConnection::get_cam(int& x, int& y, int& z, int& w, int& h) const {
    std::lock_guard<std::mutex> lk(v1_mu_);
    if (cam_w_ <= 0 || cam_h_ <= 0) return false;
    x = cam_x_; y = cam_y_; z = cam_z_; w = cam_w_; h = cam_h_;
    return true;
}

// ---- REQ_BLOCKS ----------------------------------------------------------------------
bool WsConnection::queue_reqblocks(const std::vector<std::array<int, 3>>& triples) {
    const long long now = steady_ms();
    if (last_reqblocks_window_ms_ && now - last_reqblocks_window_ms_ < 250) {
        reqblocks_coalesced_.fetch_add(1, std::memory_order_relaxed);
        g_reqblocks_coalesced.fetch_add(1, std::memory_order_relaxed);
    } else {
        last_reqblocks_window_ms_ = now;
    }

    std::lock_guard<std::mutex> lk(reqblocks_mu_);
    const size_t map_capacity = g_reqblocks_map_capacity.load(std::memory_order_acquire);
    size_t dropped = 0;
    for (const auto& triple : triples) {
        if (reqblocks_members_.find(triple) != reqblocks_members_.end())
            continue;

        // With one slot for every block in the loaded map, valid unique demand cannot reach here:
        // a hit means bad map dims or bad client coordinates. Never evict live demand for newer ids.
        if (map_capacity == 0 || reqblocks_queue_.size() >= map_capacity) {
            ++dropped;
            continue;
        }
        reqblocks_queue_.push_back(triple);
        reqblocks_members_.insert(triple);
        g_reqblocks_queued_total.fetch_add(1, std::memory_order_relaxed);
    }
    if (dropped) {
        reqblocks_overflow_drops_.fetch_add(dropped, std::memory_order_relaxed);
        g_reqblocks_dropped_cap.fetch_add(dropped, std::memory_order_relaxed);
    }
    return !reqblocks_queue_.empty();
}

std::vector<std::array<int, 3>> WsConnection::take_reqblocks() {
    std::lock_guard<std::mutex> lk(reqblocks_mu_);
    const long long now = steady_ms();
    std::vector<std::array<int, 3>> out;
    if (reqblocks_queue_.empty() ||
        (last_reqblocks_drain_ms_ && now - last_reqblocks_drain_ms_ < 250))
        return out;
    const size_t count = reqblocks_queue_.size();
    out.assign(reqblocks_queue_.begin(), reqblocks_queue_.end());
    reqblocks_queue_.clear();
    reqblocks_members_.clear();
    last_reqblocks_drain_ms_ = now;
    g_reqblocks_queued_total.fetch_sub(count, std::memory_order_relaxed);
    return out;
}

size_t WsConnection::reqblocks_queued() const {
    std::lock_guard<std::mutex> lk(reqblocks_mu_);
    return reqblocks_queue_.size();
}

// ---- Chat outbound --------------------------------------------------------------
bool WsConnection::chat_rate_ok(long long* retry_after_ms) {
    long long now = steady_ms();
    long long elapsed = now - last_chat_ms_;
    if (elapsed < 400) {
        if (retry_after_ms) *retry_after_ms = 400 - elapsed;
        g_chat_dropped_rate.fetch_add(1, std::memory_order_relaxed);
        return false;   // >=400ms between accepted lines (~2.5/s max)
    }
    if (retry_after_ms) *retry_after_ms = 0;
    last_chat_ms_ = now;
    return true;
}

bool WsConnection::control_json_error_log_ok() {
    const long long now = steady_ms();
    if (now - last_json_error_log_ms_ < 5000) return false;
    last_json_error_log_ms_ = now;
    return true;
}

void WsConnection::enqueue_chat(std::vector<uint8_t> text_frame) {
    {
        std::lock_guard<std::mutex> lk(out_mu_);
        chat_fifo_.push_back(std::move(text_frame));
        // Bounded: a wedged client that never drains gets its OLDEST queued line dropped rather
        // than growing without limit (it will refetch GET /chat scrollback on reconnect anyway).
        while (chat_fifo_.size() > kChatFifoDepth) chat_fifo_.pop_front();
    }
    out_cv_.notify_all();
}

// Pacing. All under out_mu_ so the writer's window check and the recv thread's ACK application stay
// consistent, and an ACK wakes a window-blocked writer through out_cv_.
uint32_t WsConnection::next_seq() {
    std::lock_guard<std::mutex> lk(out_mu_);
    return ++last_sent_seq_;
}

void WsConnection::record_sent(uint32_t seq, size_t wire_bytes) {
    std::lock_guard<std::mutex> lk(out_mu_);
    seq_ring_[seq % kSeqRing] = SeqBytes{seq, wire_bytes};
    inflight_bytes_ += wire_bytes;
}

void WsConnection::apply_ack(uint32_t seq) {
    {
        std::lock_guard<std::mutex> lk(out_mu_);
        // Cumulative ACK: clamp to the un-acked, already-sent range. Duplicates/stale/out-
        // of-range acks are ignored.
        if (seq <= last_acked_seq_ || seq > last_sent_seq_) return;
        for (uint32_t s = last_acked_seq_ + 1; s <= seq; ++s) {
            SeqBytes& e = seq_ring_[s % kSeqRing];
            if (e.seq == s && e.bytes > 0) {
                inflight_bytes_ = (inflight_bytes_ >= e.bytes) ? inflight_bytes_ - e.bytes : 0;
                e.bytes = 0;
            }
        }
        last_acked_seq_ = seq;
    }
    out_cv_.notify_one();   // wake a writer blocked on a closed window
}

int WsConnection::inflight_frames() const {
    std::lock_guard<std::mutex> lk(out_mu_);
    return (int)(last_sent_seq_ - last_acked_seq_);
}

bool WsConnection::window_open(bool is_block_set) const {
    std::lock_guard<std::mutex> lk(out_mu_);
    constexpr size_t kBulkBytes = 262144;      // 256 KiB byte window (BLOCK_SET only)
    // K scales with this connection's own measured app-level RTT, floored at 3 and ceilinged at 16.
    // AUX and BLOCK_SET share this ONE window, so a fixed K capped a WAN client to ~K/RTT frames/s.
    constexpr uint32_t kKMin = 3;
    constexpr uint32_t kKMax = 16;
    long long rtt = rtt_ms_app_.load();
    uint32_t kK = kKMin;
    if (rtt > 0) {
        uint32_t scaled = (uint32_t)((rtt * 6 + 99) / 100);   // ceil(rtt_ms * 0.06) ~= rtt*60fps/1000
        if (scaled > kK) kK = scaled;
        if (kK > kKMax) kK = kKMax;
    }
    if ((last_sent_seq_ - last_acked_seq_) >= kK) return false;
    if (is_block_set && inflight_bytes_ >= kBulkBytes) return false;
    return true;
}

void WsConnection::note_app_pong(long long server_ts, long long client_ts) {
    (void)client_ts;
    long long r = steady_ms() - server_ts;
    if (r >= 0 && r < 600000) rtt_ms_app_.store(r);
}

bool WsConnection::recv(std::string& payload, bool& is_binary, std::string* err) {
    for (;;) {
        uint8_t hdr[2];
        if (!recv_all(sock_, hdr, 2)) {
            if (err) *err = "closed";
            closed_.store(true);
            return false;
        }
        uint8_t opcode = hdr[0] & 0x0f;
        bool masked = (hdr[1] & 0x80) != 0;
        uint64_t len = hdr[1] & 0x7f;
        if (len == 126) {
            uint8_t e[2];
            if (!recv_all(sock_, e, 2)) { closed_.store(true); return false; }
            len = ((uint64_t)e[0] << 8) | e[1];
        } else if (len == 127) {
            uint8_t e[8];
            if (!recv_all(sock_, e, 8)) { closed_.store(true); return false; }
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | e[i];
        }
        if (len > kMaxInboundPayload) {
            if (err) *err = "frame too large";
            close();
            return false;
        }
        uint8_t mask[4] = {0, 0, 0, 0};
        if (masked && !recv_all(sock_, mask, 4)) { closed_.store(true); return false; }
        std::string data;
        data.resize((size_t)len);
        if (len && !recv_all(sock_, reinterpret_cast<uint8_t*>(&data[0]), (size_t)len)) {
            closed_.store(true);
            return false;
        }
        if (masked)
            for (size_t i = 0; i < data.size(); i++) data[i] ^= mask[i & 3];

        // ANY inbound frame proves the path is alive -> refresh the silence clock.
        last_inbound_ms_.store(steady_ms());

        if (opcode == 0x8) {            // close
            close();
            if (err) *err = "peer close";
            return false;
        }
        if (opcode == 0x9) {            // ping -> pong
            send_frame(0xA, reinterpret_cast<const uint8_t*>(data.data()), data.size());
            continue;
        }
        if (opcode == 0xA) {            // pong: our PING payload echoed back -> measure RTT
            if (data.size() == 8) {
                uint64_t echoed = 0;
                for (int i = 0; i < 8; ++i)
                    echoed |= (uint64_t)(uint8_t)data[i] << (8 * i);
                long long r = steady_ms() - (long long)echoed;
                if (r >= 0 && r < 600000) rtt_ms_.store(r);
            }
            continue;
        }
        if (opcode == 0x1 || opcode == 0x2) {
            payload.swap(data);
            is_binary = (opcode == 0x2);
            return true;
        }
        // continuation / reserved opcodes: ignored by this simple protocol.
    }
}

void WsConnection::close() {
    const bool was_closed = closed_.exchange(true);
    // closed_ is logical protocol state, not descriptor ownership: send_frame sets it before
    // returning failure, so transport shutdown still has to run here, exactly once.
    std::lock_guard<std::mutex> lk(send_mu_);
    if (!was_closed) {
        uint8_t f[2] = {0x88, 0x00};    // best-effort close frame; send_all is time-bounded
        (void)send_all(sock_, f, 2);
    }
    if (!socket_shutdown_.exchange(true)) shutdown_fd(sock_);
}

// ---- module API ----------------------------------------------------------------
void set_v1_map_info(V1MapInfoFn fn) {
    std::lock_guard<std::mutex> lk(g_v1_info_mu);
    g_v1_map_info = std::move(fn);
}

void set_reqblocks_map_capacity(size_t blocks) {
    g_reqblocks_map_capacity.store(blocks, std::memory_order_release);
}

size_t broadcast_to_player(const std::string& player, const std::string& msg) {
    std::vector<std::shared_ptr<WsConnection>> targets;
    {
        std::lock_guard<std::mutex> lk(g_registry_mu);
        auto it = g_registry.find(player);
        if (it != g_registry.end()) targets = it->second;   // copy shared_ptrs
    }
    // Enqueue per connection instead of sending on the shared cursor-loop thread: one wedged
    // client's full send buffer used to freeze EVERY player's cursor stream.
    std::vector<uint8_t> payload(msg.begin(), msg.end());
    size_t queued = 0;
    for (auto& c : targets) {
        if (!c) continue;
        c->enqueue_frame(WsConnection::CH_CURSORS, payload, /*binary=*/false);
        ++queued;
    }
    return queued;
}

// enqueue a chat text frame on EVERY live connection's reliable chat FIFO.
size_t broadcast_chat_to_all(const std::string& msg) {
    std::vector<std::shared_ptr<WsConnection>> targets;
    {
        std::lock_guard<std::mutex> lk(g_registry_mu);
        for (auto& kv : g_registry)
            for (auto& c : kv.second)
                if (c) targets.push_back(c);
    }
    std::vector<uint8_t> payload(msg.begin(), msg.end());
    for (auto& c : targets) c->enqueue_chat(payload);
    return targets.size();
}

uint64_t ws_frames_sent_total() {
    return g_ws_frames_sent.load(std::memory_order_relaxed);
}

size_t ws_connection_count() {
    std::lock_guard<std::mutex> lk(g_registry_mu);
    size_t n = 0;
    for (auto& kv : g_registry) n += kv.second.size();
    return n;
}

size_t ws_connection_count_for(const std::string& player) {
    std::lock_guard<std::mutex> lk(g_registry_mu);
    auto it = g_registry.find(player);
    return it == g_registry.end() ? 0 : it->second.size();
}

bool ws_player_health(const std::string& player, long long& rtt_ms, long long& last_inbound_age_ms) {
    std::lock_guard<std::mutex> lk(g_registry_mu);
    auto it = g_registry.find(player);
    if (it == g_registry.end() || it->second.empty()) return false;
    long long now = steady_ms();
    long long best_age = -1;
    long long best_rtt = -1;
    for (const auto& c : it->second) {
        if (!c) continue;
        long long age = now - c->last_inbound_ms();   // freshest connection = smallest age
        if (best_age < 0 || age < best_age) { best_age = age; best_rtt = c->rtt_ms(); }
    }
    if (best_age < 0) return false;
    last_inbound_age_ms = best_age;
    rtt_ms = best_rtt;
    return true;
}

bool ws_cam_for_player(const std::string& player, int& x, int& y, int& z, int& w, int& h) {
    std::lock_guard<std::mutex> lk(g_registry_mu);
    auto it = g_registry.find(player);
    if (it == g_registry.end() || it->second.empty()) return false;
    long long now = steady_ms();
    long long best_age = -1;
    bool found = false;
    for (const auto& c : it->second) {
        if (!c || !c->is_v1()) continue;
        int cx, cy, cz, cw, ch;
        if (!c->get_cam(cx, cy, cz, cw, ch)) continue;   // no cam dims from this conn yet
        long long age = now - c->last_inbound_ms();       // freshest connection wins
        if (best_age < 0 || age < best_age) {
            best_age = age; x = cx; y = cy; z = cz; w = cw; h = ch; found = true;
        }
    }
    return found;
}

std::vector<std::string> ws_connected_players() {
    std::lock_guard<std::mutex> lk(g_registry_mu);
    std::vector<std::string> out;
    out.reserve(g_registry.size());
    for (auto& kv : g_registry)
        if (!kv.second.empty()) out.push_back(kv.first);
    return out;
}

std::vector<std::string> ws_roster_players() {
    std::lock_guard<std::mutex> lk(g_registry_mu);
    const long long now = steady_ms();
    std::map<std::string, bool> visible;

    // A player is live when at least one socket answered inside the keepalive deadline. The first
    // unhealthy observation starts the same grace a socket removal does; a reconnect cancels it.
    for (const auto& kv : g_registry) {
        long long freshest = -1;
        for (const auto& c : kv.second) {
            if (!c) continue;
            long long stamp = c->last_inbound_ms();
            if (stamp > freshest) freshest = stamp;
        }
        if (freshest >= 0 && now - freshest <= kSilenceCloseMs) {
            g_roster_grace_deadline.erase(kv.first);
            visible[kv.first] = true;
            continue;
        }
        auto state = g_roster_grace_deadline.emplace(kv.first, now + kRosterGraceMs);
        if (now < state.first->second) visible[kv.first] = true;
    }

    // Last socket already departed: keep the name through its short anti-flicker grace. Expired
    // entries stay as tombstones until reconnect so a late teardown cannot resurrect a ghost.
    for (const auto& kv : g_roster_grace_deadline)
        if (now < kv.second) visible[kv.first] = true;

    std::vector<std::string> out;
    out.reserve(visible.size());
    for (const auto& kv : visible) out.push_back(kv.first);
    return out;
}

std::vector<std::shared_ptr<WsConnection>> ws_v1_connections() {
    std::lock_guard<std::mutex> lk(g_registry_mu);
    std::vector<std::shared_ptr<WsConnection>> out;
    for (auto& kv : g_registry)
        for (auto& c : kv.second)
            if (c && c->is_v1()) out.push_back(c);
    return out;
}

std::vector<uint8_t> deflate_wire_payload(const uint8_t* data, size_t len) {
    z_stream zs;
    std::memset(&zs, 0, sizeof(zs));
    if (deflateInit(&zs, Z_BEST_SPEED) != Z_OK) return {};
    std::vector<uint8_t> out(deflateBound(&zs, (uLong)len));
    zs.next_in = const_cast<Bytef*>(reinterpret_cast<const Bytef*>(data));
    zs.avail_in = (uInt)len;
    zs.next_out = out.data();
    zs.avail_out = (uInt)out.size();
    int r = deflate(&zs, Z_FINISH);
    size_t produced = out.size() - zs.avail_out;
    deflateEnd(&zs);
    if (r != Z_STREAM_END) return {};
    out.resize(produced);
    return out;
}

void ws_close_all() {
    std::vector<std::shared_ptr<WsConnection>> all;
    {
        std::lock_guard<std::mutex> lk(g_registry_mu);
        for (auto& kv : g_registry)
            for (auto& c : kv.second) all.push_back(c);
    }
    for (auto& c : all)
        if (c) c->close();   // unblocks each worker's recv(); it deregisters itself
}

std::unique_ptr<httplib::Server> make_ws_server() {
    return std::unique_ptr<httplib::Server>(new WsHttpServer());
}

void ws_server_begin_shutdown(httplib::Server& server) {
    static_cast<WsHttpServer&>(server).begin_shutdown();
}

} // namespace dwf
