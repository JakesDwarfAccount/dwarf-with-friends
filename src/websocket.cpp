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

#include "auth.h"           // JOIN SECURITY: hello-token gate + hello_ack build stamp
#include "chat.h"           // WP-D: chat_post relay on inbound {"type":"chat"}
#include "client_state.h"   // set_player_precise_cursor: store inbound smooth cursors + camera authority
#include "http_server.h"    // notify_player_input: wake the push loop on a WS-borne camera move
#include "json_util.h"      // json_escape: hello_ack.player (B09(a) name dedup)
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

// httplib.h (included via websocket.h) already pulls in <winsock2.h> on Windows and
// the BSD socket headers on POSIX, so ::recv / ::send / MSG_PEEK / closesocket are
// available here without adding platform includes.

namespace dwf {

namespace {

// ---- module state --------------------------------------------------------------

std::mutex g_registry_mu;
// player -> its live connections. Small N; a flat vector per player is plenty.
std::map<std::string, std::vector<std::shared_ptr<WsConnection>>> g_registry;
// Player -> removal deadline. Entries intentionally remain after expiry as tombstones so a
// very-late socket teardown cannot resurrect an already-removed ghost; registry_add erases one.
std::map<std::string, long long> g_roster_grace_deadline;

// isHostClient() hook (WD-27 follow-up): the only host-identity signal in this codebase
// (grepped -- see dwf-escmenu.js's header comment for the prior "no host concept exists
// yet" state this replaces). Definition: the connection whose real TCP peer is loopback IS the
// host -- true for the Steam/DFHack machine's own browser (localhost:8765 or 127.0.0.1:8765),
// false for every tunnel (cloudflared) or LAN peer, since those always present their own real
// address to accept(), never 127.0.0.1 -- nothing a client can spoof via headers/URL params.
// Reuses httplib's own already-vetted peer lookup (get_remote_ip_and_port, used internally by
// httplib::Server for its own remote_addr) rather than hand-rolling sockaddr parsing again.
bool socket_is_loopback_peer(::socket_t sock) {
    std::string ip;
    int port = 0;
    httplib::detail::get_remote_ip_and_port(sock, ip, port);
    return peer_ip_is_loopback(ip);
}

std::mutex g_auth_mu;
WsAuthFn g_auth;                                    // unset => allow all

std::mutex g_v1_info_mu;
V1MapInfoFn g_v1_map_info;                          // WA-8: hello_ack map dims + world_seq provider

// Monotonic session-id counter for v1 hello_ack "session" (uuid-ish, per connection).
std::atomic<uint64_t> g_session_counter{0};

// WT24: every WS frame this process has successfully written to a socket. One relaxed
// fetch_add per frame, next to a blocking socket write -- unmeasurable. The 60 s heartbeat
// prints the DELTA, which is how a crash tail proves the transport was still moving bytes
// (or had gone silent) in the minute before DF died.
std::atomic<uint64_t> g_ws_frames_sent{0};
constexpr size_t kReqblocksGlobalMax = 1024;
std::atomic<size_t> g_reqblocks_queued_total{0};
std::atomic<uint64_t> g_reqblocks_dropped_rate{0};
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
        // Capture the ORIGINAL message bit-length BEFORE appending padding. The
        // add() calls below each advance `len`, so reading it after padding would
        // encode the padded length into the final block and corrupt the digest
        // (the bug that produced a wrong Sec-WebSocket-Accept).
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

std::string base64(const uint8_t* d, size_t n) {
    static const char* t =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string o;
    int val = 0, bits = -6;
    for (size_t i = 0; i < n; i++) {
        val = (val << 8) + d[i]; bits += 8;
        while (bits >= 0) { o.push_back(t[(val >> bits) & 0x3f]); bits -= 6; }
    }
    if (bits > -6) o.push_back(t[((val << 8) >> (bits + 8)) & 0x3f]);
    while (o.size() % 4) o.push_back('=');
    return o;
}

std::string ws_accept(const std::string& key) {
    std::string s = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    Sha1 h; h.add(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    uint8_t dg[20]; h.finish(dg);
    return base64(dg, 20);
}

// Self-test of the handshake crypto against fixed known-answer vectors. Returns true
// iff SHA-1, base64 and the RFC6455 Sec-WebSocket-Accept derivation all match. Kept
// callable so the plugin can assert it once at startup (see ws_selftest()); a failure
// here means no browser/Cloudflare would ever accept our Upgrade.
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

// Run the crypto self-test once at plugin load. This both keeps ws_crypto_selftest()
// referenced (so it isn't dead-stripped) and surfaces any handshake-crypto regression
// loudly on stderr the moment the DLL loads, rather than as a silent failed Upgrade.
const bool g_ws_crypto_ok = [] {
    bool ok = ws_crypto_selftest();
    if (!ok)
        std::fputs("dwf: FATAL WebSocket crypto self-test FAILED "
                   "(Sec-WebSocket-Accept will be wrong)\n", stderr);
    return ok;
}();

// ---- raw socket helpers --------------------------------------------------------
// httplib leaves accepted sockets in NON-BLOCKING mode. Our raw WS I/O helpers previously
// treated ::recv/::send returning -1/EWOULDBLOCK as a dead peer and returned false. That was
// THE root cause of "stream only updates while I feed it input": an idle WebSocket sends no
// inbound frames, so the recv loop's recv_all hit EWOULDBLOCK, reported the connection closed,
// and handle_ws_connection tore it down -- which also killed the push writer's send (0 frames).
// Continuous client input kept recv_all returning data, keeping the connection (and the
// outbound stream) alive. Fix: EWOULDBLOCK is not an error -- wait for the socket to become
// ready via select() and retry, so these behave like true blocking I/O regardless of mode.
#ifdef _WIN32
inline int sock_last_err() { return WSAGetLastError(); }
inline bool sock_would_block(int e) { return e == WSAEWOULDBLOCK; }
#else
inline int sock_last_err() { return errno; }
inline bool sock_would_block(int e) { return e == EWOULDBLOCK || e == EAGAIN; }
#endif

// ROOT CAUSE (2026-07-05, proven): on this Winsock stack, a thread parked in a LONG-BLOCKING
// socket call on a handle -- a blocking ::recv(), or select() with an infinite/long timeout --
// serializes ANY concurrent socket op (send/select/recv) on that SAME handle from another
// thread. Our two-thread design (connection thread draining inbound via recv_all; writer thread
// pushing map frames via send_all) put both threads on ONE socket. An idle client left the
// recv thread parked forever, which blocked the writer's send -> 0 frames until the client sent
// inbound bytes (each byte briefly released recv, letting exactly one frame out = the "updates
// only while I move the mouse" stall). Fix: NEVER hold the socket in a long-blocking call.
// Socket stays non-blocking; both recv_all and send_all use short non-blocking attempts with a
// brief SLEEP between retries (no select, no blocking recv). Quick non-blocking ::recv/::send
// return in microseconds, so the two threads never serialize behind each other.
constexpr int kPollSleepMs = 4;          // retry cadence when a non-blocking op would block
constexpr int kSendStallCapMs = 10000;   // give up on a send that can't drain for this long
// Per-connection send-buffer cap. Windows autotunes SO_SNDBUF to several MB, so ::send to a
// black-holed/half-open peer keeps SUCCEEDING (copying into the kernel send buffer) for tens of
// seconds before it finally fills and ::send blocks -- which is when the A2 zombie prune can
// fire. Bounding the send buffer makes ::send block (and the stall cap + writer close() prune)
// within a couple seconds of the peer going dark, and -- the §D transport point -- restores
// server-side backpressure so a capacity-collapsed path self-limits to ~256 KiB of queued
// state instead of megabytes of buffer-bloat. 256 KiB is ~2 s of a 30 fps stream: ample for
// fast clients (each keyframe is ~30 KiB compressed), tight enough to prune a dead one fast.
constexpr int kSendBufBytes = 262144;    // 256 KiB

// Keepalive (WA-3): server PING cadence and the inbound-silence deadline. Browsers auto-PONG
// protocol pings, so any live client refreshes last_inbound within one interval; a vanished
// client (sleep/wake, tunnel path death, black-holed edge) goes silent and is swept at 45 s.
constexpr long long kPingIntervalMs = 10000;
constexpr long long kSilenceCloseMs = 45000;
constexpr long long kRosterGraceMs = 5000;   // absorb refresh/reconnect flaps without row flicker
constexpr int kHttpIoTimeoutMs = 5000;       // bound dead HTTP peers; never held under DF locks

long long steady_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

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
    // ABSOLUTE per-frame cap (not "continuous-block" cap). A half-open / wedged peer whose TCP
    // window dribbles open a few bytes per RTO would keep an r>0 "made progress, reset the
    // stall timer" loop alive indefinitely -- so the zombie (A2) would prune only tens of
    // seconds after the peer went dark (measured: ~25-30 s on a loopback half-open), not within
    // kSendStallCapMs as intended. Bounding the TOTAL time for a single frame's send makes a
    // dead peer's send fail within kSendStallCapMs of first blocking, so writer_loop's close()
    // (this item) prunes promptly. A healthy client drains any frame in microseconds and never
    // approaches the cap; a legitimately slow but progressing frame that needs >10 s is already
    // pathological (keyframes are ~30 KB compressed and the 30 fps gate passes over the tunnel).
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
// Clear any inherited receive timeout on an upgraded WebSocket socket. httplib set a read
// timeout on the accepted socket for HTTP request parsing; our WS drain loop uses raw
// blocking ::recv, so that timeout makes recv() fail on INBOUND SILENCE and we tear the
// socket down. But a WebSocket is long-lived and a well-behaved client legitimately sends
// nothing for long stretches (it only emits cursor/control frames while the user is active).
// Symptom of NOT clearing it: the stream hangs the instant the user stops moving the mouse,
// because that's when the browser stops sending and the server times out the read. Server->
// client pushes run on the push-loop thread and are unaffected by this.
void clear_socket_read_timeout(::socket_t s) {
    // CRITICAL: httplib leaves the accepted socket in NON-BLOCKING mode (it drives its own
    // HTTP I/O with select()). But our WS uses raw blocking-style recv_all/send_all, which
    // on a non-blocking socket FAIL immediately with EWOULDBLOCK -- recv_all drops the moment
    // the client is quiet, and send_all fails whenever a frame can't be buffered in one shot.
    // Put the socket back into BLOCKING mode so recv_all waits for data and send_all waits for
    // buffer space (the per-connection writer thread means a blocked send only stalls itself).
    // SEND TIMEOUT: bound how long a single blocking send can stall the per-connection writer.
    // A slow client (or a client whose async inflate backs up, filling the tunnel's buffer)
    // would otherwise make ::send block for MINUTES holding send_mu_, which also starves the
    // keepalive pong -> the connection dies anyway (1006), just slowly. With SO_SNDTIMEO the
    // send fails after a few seconds; the writer closes the socket and the client reconnects
    // cleanly. Fast clients complete each send in microseconds and never hit this.
#ifdef _WIN32
    // ROOT CAUSE FIX (2026-07-05): keep the socket NON-BLOCKING so ::recv/::send return
    // EWOULDBLOCK immediately instead of parking. recv_all/send_all then sleep-poll on
    // EWOULDBLOCK (see their comment) -- NEITHER thread ever holds the socket in a long-blocking
    // call, which is the only thing that serialized the writer behind the recv thread and caused
    // the idle stall. TCP_NODELAY disables Nagle so small delta frames go out immediately.
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
    // cpp-httplib writes a completed Response only after the route handler has returned, so no
    // capture mutex/CoreSuspender is live here. Bound the kernel call anyway: a dead reader may
    // consume one HTTP worker for at most this deadline, never the whole server indefinitely.
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
    // IDENTITY ENCODING (camera snap-back root cause, 2026-07-17): the browser builds this /ws URL
    // with encodeURIComponent(name), so a display name with a space/`&`/unicode arrives PERCENT-
    // ENCODED here (e.g. "Your Friend" -> "Your%20Friend"). httplib decodes ordinary HTTP query
    // params exactly once (detail::decode_url(val, true) in its parser), but this raw /ws-upgrade
    // parser did NOT -- so the connection (and thus the registry name, presence_json, hello_ack.player)
    // registered under the LITERAL "Your%20Friend". The client then adopted that as its player key and
    // re-encoded it on every HTTP ?player= (-> "Your%2520Friend"), which query_player's is_safe_player_id
    // guard rejected -> silently mapped to "default" -> POST /camera wrote a phantom camera while the
    // WS streamed the real one -> reconcileAuxCam snapped the view back ~1s after every move. Decode
    // here with the SAME rule httplib uses for HTTP params so both transports canonicalize one identical
    // RAW identity. (Chrome "worked" only because the owner's name had no space to encode.)
    p = httplib::detail::decode_url(p, /*convert_plus_to_space=*/true);
    // R1: validate the DECODED identity with the exact same gate HTTP uses (is_safe_player_id via
    // query_player). Without this, a control-char name ("x%0AINJECTED") would decode to a
    // newline-bearing identity that registers fine on the WS but that every HTTP ?player= route maps
    // to "default" -- the phantom split resurrected for hostile/malformed names -- and would forge
    // newlines into the "ws hello DENIED ... player=" diagnostics_log line. Fall back to "guest" (this
    // parser's existing rejection value) so both transports agree on rejection; a legit client then
    // adopts "guest" from hello_ack and keys HTTP on it too, so they still converge.
    if (p.empty() || !is_safe_player_id(p))
        return std::string("guest");
    return p;
}

// Extract an integer query param (?name=NN) from the request target. Returns `def`
// when absent/unparseable. Used to read the client's desired tile-window w/h off the
// /ws URL so pushed frames match its canvas (same sizing as GET /mapdata?w=&h=).
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
    // WA-15: the legacy per-player keyframe-resync flag (ws_request_keyframe) is gone -- a
    // fresh v1 connection's catch-up is entirely driven by its HELLO `have` (§0.6 resume) and
    // the interest-window scan (§0.8), which already re-offers every in-window block a new
    // connection hasn't been sent yet.
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
    // A8/WA-15: when a player's LAST socket departs, drop its /diag v1.players row (WA-12/13's
    // finding: it survives a disconnect -- cosmetic, since /diag's connections:0 already proves
    // no live socket, but stale rows are confusing). world_stream_forget only erases a diag-row
    // map entry keyed by player, so it's safe under no other lock.
    if (last_gone) {
        world_stream_forget(c->player());
    }
}

// ---- B09(a): server-side player-name dedup --------------------------------------
// Per-player server state is keyed on the player NAME: g_player_cameras (client_state.cpp),
// the frame-delta baseline g_frame_cache (sdl_capture.cpp), g_dismissed_alert_keys, the /diag
// row, AND the push loop's interest window (world_stream.cpp uses camera_for_player(player)).
// Two DIFFERENT live connections sharing a name (same invite link -> same ?player=) would thus
// share ONE camera + ONE delta baseline -> panning one yanks the other's viewport and their
// deltas corrupt each other. At HELLO we rename any name already held by a DIFFERENT live
// connection to the first free "name-2"/"name-3"/... and return the final name in
// hello_ack.player; the client adopts it for every HTTP ?player= + its display. A page REFRESH
// sends the SAME client-id (sessionStorage) as its own lingering ghost connection, so we SKIP a
// same-id holder and the refresh keeps (reuses) its slot rather than incrementing off its ghost.
// The dedup suffix uses '-' purely as a readable convention; the name is the HTTP ?player= key, but
// is_safe_player_id() now accepts any non-control byte (spaces/parens/UTF-8 included), so this is a
// style choice, not a safety constraint.
std::mutex g_dedup_mu;

// Move `c` from its current registry bucket to `newName`'s bucket and update player_ atomically
// wrt the registry (so a later registry_remove -- which finds the bucket via player() -- and the
// push loop see a consistent name). Caller holds g_dedup_mu.
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

// Build + enqueue the v1 hello_ack (§0.5) onto CH_CTRL. Map dims + world_seq come from
// the registered provider (DF-derived, cached); session/tick_ms/limits are protocol facts.
// NOTE (WA-16): `limits.k` is advertised as its FLOOR value (3) -- accurate at hello time,
// since no RTT sample exists yet -- but window_open() (websocket.cpp) now scales the real
// admission window up with the connection's measured RTT, up to 16. The client doesn't
// currently consume `limits.k` for anything, so this stays informational/unchanged.
void send_hello_ack(const std::shared_ptr<WsConnection>& conn) {
    V1MapInfo mi;
    { V1MapInfoFn fn;
      { std::lock_guard<std::mutex> lk(g_v1_info_mu); fn = g_v1_map_info; }
      if (fn) mi = fn(); }
    std::string ack =
        "{\"type\":\"hello_ack\",\"proto\":1,\"world_seq\":" + std::to_string(mi.world_seq) +
        // B09(a): the authoritative (possibly deduped) player name. The client adopts this for
        // every HTTP ?player= key + its display, so its per-player state stops colliding with a
        // same-named peer. Sent on EVERY hello_ack (incl. reconnects) so the client self-heals.
        // R2: emit BYTE-CLEAN (chat_escape, not json_escape) -- the name arrived from the browser
        // already UTF-8, and json_escape's DF2UTF CP437->UTF-8 transcode would mojibake it ("Zoe"
        // with a diaeresis -> "ZoA<<"), so the client would adopt a DIFFERENT string than the raw
        // identity the WS registered under -> HTTP ?player= keys on the mojibake -> phantom split for
        // every non-ASCII name. chat_escape passes UTF-8 bytes through so adopted == registered.
        ",\"player\":\"" + chat_escape(conn->player()) + "\"" +
        ",\"session\":\"" + conn->session() + "\",\"tick_ms\":33,\"map\":{\"w\":" +
        std::to_string(mi.w) + ",\"h\":" + std::to_string(mi.h) + ",\"z\":" +
        std::to_string(mi.z) + "},\"limits\":{\"k\":3,\"bulk_bytes\":262144,\"ack_every\":1}" +
        // isHostClient() hook (WD-27 follow-up): server-computed, peer-address-derived signal
        // (see socket_is_loopback_peer() / WsConnection::is_host_) -- NOT reflecting anything
        // the client claimed. dwf-ws.js surfaces this as DwfWS.isHost().
        ",\"isHost\":" + std::string(conn->is_host() ? "true" : "false") +
        // VERSION-MISMATCH GATE: the server build stamp (wire CRC + git short hash). The client
        // compares it to its own baked window.DFCAPTURE_BUILD and shows a "refresh -- stale tab"
        // banner on mismatch. Additive field; an old client ignores it.
        ",\"build\":\"" + json_escape(auth::build_stamp()) + "\"}";
    conn->enqueue_frame(WsConnection::CH_CTRL,
                        std::vector<uint8_t>(ack.begin(), ack.end()), /*binary=*/false);
}

// Route one decoded text frame from a connection. Legacy sessions understand cursor +
// reqkey; v1 sessions add hello/ack/cam/pong (§0.4). Anything else is ignored.
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

    // ---- protocol v1 control (§0.4) --------------------------------------------------
    if (conn->is_v1()) {
        if (is_type("hello")) {
            // JOIN SECURITY: when a passphrase is configured, the hello MUST carry the shared
            // credential (`token`). This gates a DIRECT ws:// connection that bypasses the join
            // screen (the pre-routing HTTP gate can't see /ws -- the upgrade is intercepted below
            // httplib routing). Legit clients set the same value in a cookie for HTTP, so the two
            // paths use one shared secret. On failure: tell the client (auth_fail) then close, so a
            // stored-but-stale credential re-shows the join screen instead of silently reconnecting.
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
            // S5 capability is additive: old clients send no caps and keep full AUX.
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
            // B09(a): capture the stable per-tab id, then dedup this connection's name against
            // OTHER live connections (renaming to name-2/... on a real collision). mark_hello
            // was called first so a concurrent hello sees this conn as an established name.
            std::string cid;
            if (get_string(doc.root, "id", cid)) {
                if (cid.size() > 64) cid.resize(64);
                conn->set_client_id(cid);
            }
            dedup_player_name(conn, conn->client_id());
            send_hello_ack(conn);
            return;
        }
        // In-session RENAME (players list -> "Rename" your own row). Small + safe: it reuses the
        // exact machinery a fresh join already uses. We move this connection's registry bucket to
        // the requested name, run the same dedup (a live collision on a DIFFERENT client-id suffixes
        // name-2/...; our own reconnect ghost is skipped), carry the name-keyed camera/cursor/follow
        // state across so the view doesn't snap to the host camera, and reply with a hello_ack whose
        // authoritative `player` the client adopts. The ~30Hz presence AUX re-advertises the new
        // registry key to every other client, and the server keys the smooth cursor on the live
        // connection name, so remote rosters + this player's cursor label update with NO ~40s ghost
        // (the old name leaves the registry immediately -- a web-only rejoin could not avoid that).
        if (is_type("rename")) {
            std::string requested;
            if (!get_string(doc.root, "name", requested)) return;
            // Same validation contract as the join card: trim, non-empty, maxlength 32. The name is
            // the HTTP ?player= key; is_safe_player_id (checked after dedup) now rejects only control
            // chars, so spaces/parens/UTF-8 in a rename are accepted just like on the join card.
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
            // PRIMARY CAMERA TRANSPORT (camera snap-back fix, 2026-07-17). Historically a cam message
            // carried DIMS ONLY: browsers panned via a separate HTTP POST /camera, and the streamer's
            // interest POSITION came from that POST authority (client_state g_player_cameras) while this
            // conn snapshot's xyz stayed stale/zero (world_stream.cpp:1082 reads camera_for_player, not
            // get_cam's position). When the HTTP POST silently failed (blocked, 401, or -- the real
            // culprit here -- a phantom double-encoded ?player=), the WS kept streaming the UNMOVED
            // authoritative camera and reconcileAuxCam snapped the player back. Fix: when a cam message
            // carries a position, apply it to the SAME per-player authority POST /camera writes, keyed
            // on the connection's RAW registry identity (conn->player()) -- so it can never miss the
            // is_safe_player_id/URL round-trip a browser-built ?player= can. This mirrors POST /camera's
            // ABSOLUTE branch (session_routes.cpp) exactly: seed from the player's current camera to
            // preserve zoom_factor/placement fields, overwrite x/y/z, floor z at 0, clamp_camera, break
            // any follow (no client sends follow=1 today), set, and wake the push loop. NO feedback
            // loop: the client sends its own optimistic desiredCam absolute, the ~30Hz AUX echoes that
            // exact clamped camera back, and reconcileAuxCam (dwf-tiles.js) sees desiredCam == aux.cam
            // -> not diverged -> no snap. The old HTTP POST remains as a socket-down fallback.
            if (has_pos) {
                Camera camera;
                std::string cam_err;
                if (camera_for_player(player, camera, &cam_err)) {
                    camera.x = (int)cx;
                    camera.y = (int)cy;
                    // Mirror POST /camera's absolute branch: only overwrite z when the message carried
                    // it (POST leaves the seeded camera's z untouched when `z` is absent). The client
                    // always sends z today, so this is latent -- but it keeps the two paths identical.
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
            if (!triples.empty()) conn->queue_reqblocks(triples);   // rate-limited (>=250ms/msg)
            return;
        }
        if (is_type("reqkey")) {
            // §0.4/WA-15: reqkey is permanently "treated as reqblocks for the interest
            // window". The interest window is already re-offered every tick regardless of
            // this message (WA-9's in-view scan keeps re-queuing any block this connection
            // hasn't been sent at its current ver -- world_stream.cpp), so there is nothing
            // extra to queue here.
            return;
        }
    }

    // ---- WP-D chat ({"type":"chat","text":"..."}) -- any session (v1 falls through here) -------
    // The WS handshake already authenticated this connection (hello token / cookie), so a live
    // socket is trusted; chat needs no further auth. Rate-limited per connection; a refusal is sent
    // back on the control channel so the composer does not falsely look successful. chat_post
    // trims/clamps + rejects an empty line; on acceptance it broadcasts to all.
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
// Push-only from the server's point of view: we register the socket, then block draining
// client control frames (pings, cursor/hello/ack/cam JSON). The actual map data is written
// by protocol v1's world_stream push. A v1 connection
// (`?proto=1`) sends `hello` and is streamed binary BLOCK_SET/AUX frames; a non-v1 connection
// (used only by a couple of raw-socket test probes that don't care about map data, e.g.
// wedge_probe.py/we5_ws_leak_probe.py) just sits here answering cursor/protocol-ping control
// forever -- there is no map data left to seed or push to it. We return when the socket closes.
void handle_ws_connection(std::shared_ptr<WsConnection> conn) {
    registry_add(conn);

    // Drain inbound control frames until the peer closes. Non-binary payloads are
    // currently ignored (reserved for future camera/chat control); ping/pong/close
    // are handled inside recv().
    diagnostics_log_v("recv-loop ENTER player=" + conn->player());
    std::string payload;
    bool is_binary = false;
    std::string err;
    while (conn->recv(payload, is_binary, &err)) {
        // Text frames are small control JSON (cursor/hello/ack/cam). Binary from the client
        // is reserved and ignored here.
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
        // httplib::Server::stop() closes only the listen socket. Its thread pool still drains
        // every accepted connection, and an idle keep-alive can hold each worker for five
        // seconds. Wake active HTTP sockets and make queued workers close immediately.
        {
            std::lock_guard<std::mutex> lk(http_sockets_mu_);
            http_stopping_ = true;
            for (auto sock : http_sockets_) shutdown_fd(sock);
        }
        ws_close_all();
    }

    ~WsHttpServer() override {
        // Enforce the no-new-upgrades side of teardown even if a future httplib version changes
        // task-queue destruction ordering. Closing the registry then unblocks every recv loop.
        begin_shutdown();
        std::vector<std::pair<std::shared_ptr<std::atomic<bool>>, std::thread>> threads;
        { std::lock_guard<std::mutex> lk(ws_threads_mu_); threads.swap(ws_threads_); }
        for (auto& entry : threads) if (entry.second.joinable()) entry.second.join();
    }

protected:
    // process_and_close_socket is a PRIVATE virtual on httplib::Server (httplib.h:543).
    // Overriding a private virtual is legal (NVI). We MSG_PEEK the accepted socket:
    // a WebSocket Upgrade is taken over here; anything else is handed back to the base
    // HTTP handling. Because the base method is private we cannot name/call
    // httplib::Server::process_and_close_socket() from a derived class, so the
    // delegate path replicates the base body (httplib.h:3708) using the *protected*
    // members keep_alive_max_count_/read_timeout_sec_/read_timeout_usec_/process_request
    // and the accessible httplib::detail::process_and_close_socket() free function.
    bool process_and_close_socket(::socket_t sock) override {
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
        // Peek (without consuming) until the FULL request header block has arrived, so a
        // WebSocket Upgrade whose handshake is split across multiple TCP segments is still
        // recognized. The old code did a SINGLE MSG_PEEK and required "\r\n\r\n" to already
        // be present; a browser routinely sends the request line and headers in separate
        // segments, so that one peek saw a partial request, the WS check failed, and the
        // connection fell through to the plain-HTTP handler -> 404 on /ws -> the browser's
        // WebSocket aborted (1006) and the client silently dropped to slow HTTP polling.
        // That was the real "WS never connects / view frozen until input" root cause.
        // MSG_PEEK never consumes, so the bytes stay queued for whichever path we pick.
        //
        // CAPACITY (2026-07-16): the classifier must see the WHOLE header block to find its
        // "\r\n\r\n" terminator. A block that overflows this buffer never matches, so a real /ws
        // Upgrade is misclassified as non-WS, falls through to the plain-HTTP handler -> 404 /ws
        // -> the browser aborts the socket (1006) and the client silently drops to slow HTTP
        // /mapdata polling (which renders units/buildings but NOT terrain -> "units floating in a
        // black void"). The browser attaches the ENTIRE same-HOST cookie jar to the handshake, and
        // cookies are host-scoped, NOT port-scoped: a single big cookie set by ANOTHER app that
        // shares the "localhost" hostname (observed live: a ~2.5 KB Supabase "sb-<ref>-auth-token"
        // from a dev app on localhost:<other-port>) pushes the block past 2 KiB. 127.0.0.1 and the
        // tunnel hostname carry no such cookie, so they worked while "localhost" did not. Size for a
        // realistic worst-case header block (large cookie jar), not a bare request line. 16 KiB
        // matches the headroom common HTTP front-ends (e.g. nginx large_client_header_buffers) give
        // the request head; anything the base HTTP path would accept, this must also classify.
        constexpr size_t kWsUpgradePeekBytes = 16384;
        std::array<char, kWsUpgradePeekBytes> peek{};
        int n = 0;
        for (int tries = 0; tries < 200; ++tries) {   // up to ~200ms for the header block
            int r = ::recv(sock, peek.data(), (int)peek.size() - 1, MSG_PEEK);
            if (r < 0) {
                // A5 (defensive): if httplib leaves the accepted socket non-blocking, a
                // MSG_PEEK issued before the request bytes arrive returns EWOULDBLOCK. Treat
                // that as "header not here yet" and keep waiting instead of falling through to
                // the plain-HTTP handler (which would 404 a /ws upgrade split across TCP
                // segments). Verified non-reproducing live, but this removes the reliance on
                // httplib's internal socket mode across the upgrade.
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
        // Not a WebSocket. MSG_PEEK consumed nothing, so the bytes are still queued
        // for the base parser -- delegate byte-for-byte. Restore blocking I/O with kernel
        // deadlines so a dead reader/writer releases this worker within kHttpIoTimeoutMs.
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
        // Join completed connection threads now instead of retaining one OS thread handle per
        // historical reconnect until server shutdown. Active threads remain managed below.
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

        // A WS is long-lived: clear the inherited HTTP read timeout so inbound silence
        // (client idle / mouse not moving) doesn't get mistaken for a dead peer and dropped.
        clear_socket_read_timeout(sock);

        // §0.1: `&proto=1` on the /ws URL selects a protocol-v1 session. Absence => a
        // non-v1 connection (WA-15: no longer a "legacy" map wire -- there is none left --
        // just cursors/protocol-ping control; used only by a couple of raw-socket test
        // probes that don't care about map data). A stray `?w=&h=` on the URL is now
        // ignored -- a v1 connection's interest window comes from HELLO's `cam`, never
        // pre-HELLO URL dims.
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

    // Lifecycle: launch_upgrade owns spawning and opportunistically joins only threads whose
    // `done` flag is set; the destructor rejects new upgrades, closes live connections, then
    // joins every remaining thread. handle_upgrade owns the accepted socket until its one final
    // close_fd; WsConnection::close performs shutdown only.
    std::mutex ws_threads_mu_;
    bool ws_stopping_ = false;
    std::vector<std::pair<std::shared_ptr<std::atomic<bool>>, std::thread>> ws_threads_;
    std::mutex http_sockets_mu_;
    bool http_stopping_ = false;
    std::set<::socket_t> http_sockets_;
};

} // namespace

// isHostClient() peer test shared by the socket path (socket_is_loopback_peer, above) and HTTP
// callers (the /action pause route passes req.remote_addr). Nothing a client can spoof via
// headers/URL params -- it is the real accept()/connection peer IP.
bool peer_ip_is_loopback(const std::string& ip) {
    if (ip.empty()) return false;
    if (ip.rfind("127.", 0) == 0) return true;                 // 127.0.0.0/8 (always 127.0.0.1 in practice)
    if (ip == "::1" || ip == "::ffff:127.0.0.1") return true;   // IPv6 loopback (+ v4-mapped form)
    return false;
}

std::string ws_drop_counters_json() {
    std::ostringstream out;
    out << "{\"reqblocksRate\":" << g_reqblocks_dropped_rate.load(std::memory_order_relaxed)
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
        // Per-connection session id (uuid-ish): time + counter, hex. Enough to distinguish
        // this connection in hello_ack / logs without a real UUID dependency.
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
    // NOTE: no per-frame logging here. The 2026-07-05 diagnosis briefly logged around this
    // lock; at 30 Hz that was ~60 mutex-serialized file open/write/close per second per
    // player (visible as pan jitter). Error paths below still log unconditionally.
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
    g_ws_frames_sent.fetch_add(1, std::memory_order_relaxed);   // WT24
    return true;
}

bool WsConnection::send_text(const std::string& utf8) {
    return send_frame(0x1, reinterpret_cast<const uint8_t*>(utf8.data()), utf8.size());
}
bool WsConnection::send_binary(const uint8_t* data, size_t len) {
    return send_frame(0x2, data, len);
}

// ---- per-connection outbound writer --------------------------------------------
// Drains the coalescing queue with BLOCKING sends. Only this connection's thread ever
// blocks here, so a slow client can never stall the shared push loop or other players.
void WsConnection::writer_loop() {
    diagnostics_log_v("writer START player=" + player_);
    int sent_count = 0;
    // Priority order the writer drains channels in, one frame per wake: control first (tiny,
    // latency-critical), then the bulk map stream, then cursors. When a send completes the loop
    // re-evaluates the predicate, which stays true while any channel still has a pending frame,
    // so all channels drain without one ever starving another.
    static const int kDrainOrder[CH_N] = { CH_CTRL, CH_AUX, CH_MAP, CH_CURSORS };
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
            // Bounded wait (WA-3): wake at least every second so the keepalive ping + inbound-
            // silence sweep run even on an otherwise idle connection.
            out_cv_.wait_for(lk, std::chrono::milliseconds(1000),
                             [&] { return any_pending() || out_stop_; });
            if (out_stop_ && !any_pending()) {
                diagnostics_log_v("writer EXIT(stop) player=" + player_ + " sent=" + std::to_string(sent_count));
                lk.unlock();   // don't hold out_mu_ across close()'s socket I/O
                close();       // A2: close on EVERY exit path (idempotent)
                return;
            }
            // JOIN SECURITY: hello-token denied -- close once the auth_fail CTRL frame has drained
            // (any_pending() false => the deny frame we queued has been sent this or a prior wake).
            if (deny_after_flush_.load() && !any_pending()) {
                diagnostics_log("writer EXIT(auth-deny) player=" + player_);
                lk.unlock();
                close();
                return;
            }
            // Pick order: CTRL (tiny hello_ack/ping) -> v1 AUX (30 Hz, latency-critical) ->
            // v1 BLOCK_SET FIFO -> legacy AUX/MAP/CURSORS slots. One frame per wake; the
            // predicate stays true while anything remains, so nothing starves.
            if (out_[CH_CTRL].has) {
                frame.swap(out_[CH_CTRL].bytes); binary = out_[CH_CTRL].binary;
                out_[CH_CTRL].has = false; got = true;
            } else if (!chat_fifo_.empty()) {
                // WP-D: reliable chat FIFO -- right after CTRL (tiny, latency-sensitive), before
                // the bulk map/aux/cursor streams. Never coalesced (that's the whole point).
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
        // ---- keepalive maintenance (WA-3), OUTSIDE out_mu_ (send_frame takes send_mu_) ----
        long long now = steady_ms();
        // §0.1: a v1 connection that never sends `hello` within 5 s is dropped (close 1002).
        if (proto_v1_ && !hello_received_.load() && now - connect_ms_ > 5000) {
            diagnostics_log("writer EXIT(no-hello) player=" + player_);
            close();
            return;
        }
        if (now - last_inbound_ms_.load() > kSilenceCloseMs) {
            // A3: no inbound frame (data OR the browser's auto-PONG to our PINGs) for 45 s ==
            // a dead path even if sends still "succeed" into a black-holed edge. Prune it.
            diagnostics_log("writer EXIT(silence) player=" + player_ +
                            " silentMs=" + std::to_string(now - last_inbound_ms_.load()));
            close();
            return;
        }
        if (now - last_ping_ms_ >= kPingIntervalMs && !closed_.load()) {
            last_ping_ms_ = now;
            if (proto_v1_) {
                // WA-10: app-level PING on CH_CTRL. The client answers {"type":"pong","ts",...}
                // and the recv thread computes rttMs + clock offset (§0.4/0.5). Replaces the
                // protocol-ping RTT for v1; protocol pings remain for legacy below.
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
            close();   // A2: idempotent; guarantees the fd is shut so the recv thread unblocks
            return;
        }
        // v1 sequenced frame: stamp the seq NOW (§0.6 -- at actual send, so coalesced AUX
        // never orphans a seq), prepend the 10-byte header, send as ONE binary WS frame,
        // then account the wire bytes against the pacing window.
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
            // A2 ZOMBIE FIX: on send failure `send_frame` sets closed_ but nobody closed the
            // fd, so the recv thread kept sleep-polling a half-open socket forever and the push
            // loop kept burning ~10 ms of CoreSuspender per tick building frames for a dead
            // player (measured 300 ms/s, 35 s after the writer died). close()'s closesocket()
            // makes the recv thread's ::recv error out -> normal teardown -> registry removal.
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

// ---- protocol v1 negotiation + pacing (WA-8/9/10) ------------------------------------
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

// ---- REQ_BLOCKS (WA-11.3) ------------------------------------------------------------
bool WsConnection::queue_reqblocks(const std::vector<std::array<int, 3>>& triples) {
    long long now = steady_ms();
    if (now - last_reqblocks_ms_ < 250) {
        reqblocks_rate_drops_.fetch_add(triples.size(), std::memory_order_relaxed);
        g_reqblocks_dropped_rate.fetch_add(triples.size(), std::memory_order_relaxed);
        return false;   // rate-limited: drop the whole message
    }
    last_reqblocks_ms_ = now;
    std::lock_guard<std::mutex> lk(reqblocks_mu_);
    const size_t local_space = kReqblocksQueueDepth - reqblocks_queue_.size();
    size_t wanted = std::min(local_space, triples.size());
    size_t reserved = 0;
    size_t total = g_reqblocks_queued_total.load(std::memory_order_relaxed);
    while (wanted && total < kReqblocksGlobalMax) {
        reserved = std::min(wanted, kReqblocksGlobalMax - total);
        if (g_reqblocks_queued_total.compare_exchange_weak(
                total, total + reserved, std::memory_order_relaxed)) break;
        reserved = 0;
    }
    for (size_t i = 0; i < reserved; ++i) reqblocks_queue_.push_back(triples[i]);
    const size_t dropped = triples.size() - reserved;
    if (dropped) {
        reqblocks_overflow_drops_.fetch_add(dropped, std::memory_order_relaxed);
        g_reqblocks_dropped_cap.fetch_add(dropped, std::memory_order_relaxed);
    }
    return reserved != 0;
}

std::vector<std::array<int, 3>> WsConnection::take_reqblocks() {
    std::lock_guard<std::mutex> lk(reqblocks_mu_);
    std::vector<std::array<int, 3>> out;
    out.swap(reqblocks_queue_);
    if (!out.empty())
        g_reqblocks_queued_total.fetch_sub(out.size(), std::memory_order_relaxed);
    return out;
}

size_t WsConnection::reqblocks_queued() const {
    std::lock_guard<std::mutex> lk(reqblocks_mu_);
    return reqblocks_queue_.size();
}

// ---- WP-D chat outbound --------------------------------------------------------------
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

// Pacing (§0.6). All under out_mu_ so the writer's window check and the recv thread's ACK
// application are consistent, and an ACK wakes a window-blocked writer via out_cv_.
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

size_t WsConnection::inflight_bytes() const {
    std::lock_guard<std::mutex> lk(out_mu_);
    return inflight_bytes_;
}

bool WsConnection::window_open(bool is_block_set) const {
    std::lock_guard<std::mutex> lk(out_mu_);
    constexpr size_t kBulkBytes = 262144;      // 256 KiB byte window (BLOCK_SET only)
    // WA-16 (idle-fps fix, 2026-07-07): the original fixed K=3 in-flight cap (§0.6) was
    // tuned/gated against near-zero-RTT test rigs (loopback, same-LAN tunnel). AUX and
    // BLOCK_SET share this ONE window (both are sequenced frames, same seq space), and a
    // real-WAN client is throughput-capped to roughly K/RTT frames/sec TOTAL, split ~evenly
    // between the two types. Measured live: a remote player at ~113-128ms RTT (confirmed via
    // /diag + an isolated rtt_probe.py A/B against this server) got only ~13 BLOCK_SET/s and
    // ~13 AUX/s at K=3 (vs ~30/s each at ~0ms RTT) -- matching the reported "idle ~17fps"
    // symptom exactly (the client's draw() is gated on new AUX/BLOCK_SET data while the
    // camera is still; panning "fixes" it only because a local camera move redraws from
    // cache immediately, without waiting on the wire -- see dwf-tiles.js mapDirty).
    // Fix: scale K with the connection's OWN measured app-level RTT (rtt_ms_app_, already
    // tracked for /diag) so the window is just large enough to sustain ~60 fps combined
    // (~30 each) over one round trip -- a small bandwidth-delay-product window, not an
    // unbounded one. Floored at 3 (unchanged behavior at near-zero RTT -- every existing
    // gate_perf phase runs at that floor, so this is a no-op there) and ceilinged at 16
    // (bounds worst-case buffered/in-flight bytes on a very bad link; still tiny in absolute
    // bytes since AUX/BLOCK_SET frames are small and the byte cap below still applies).
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

        // WA-3: ANY inbound frame proves the path is alive -> refresh the silence clock.
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
    // closed_ is logical protocol state, not descriptor ownership. send_frame() sets it before
    // returning failure, so the old early-return skipped closesocket/shutdown and stranded the
    // recv worker in the HTTP pool. Always execute transport shutdown exactly once.
    std::lock_guard<std::mutex> lk(send_mu_);
    if (!was_closed) {
        uint8_t f[2] = {0x88, 0x00};    // best-effort close frame; send_all is time-bounded
        (void)send_all(sock_, f, 2);
    }
    if (!socket_shutdown_.exchange(true)) shutdown_fd(sock_);
}

bool WsConnection::is_closed() const { return closed_.load(); }

// ---- module API ----------------------------------------------------------------
void set_ws_auth(WsAuthFn fn) {
    std::lock_guard<std::mutex> lk(g_auth_mu);
    g_auth = std::move(fn);
}

void set_v1_map_info(V1MapInfoFn fn) {
    std::lock_guard<std::mutex> lk(g_v1_info_mu);
    g_v1_map_info = std::move(fn);
}

size_t broadcast_to_player(const std::string& player, const std::string& msg) {
    std::vector<std::shared_ptr<WsConnection>> targets;
    {
        std::lock_guard<std::mutex> lk(g_registry_mu);
        auto it = g_registry.find(player);
        if (it != g_registry.end()) targets = it->second;   // copy shared_ptrs
    }
    // A1 FIX: enqueue into each connection's CURSORS channel instead of send_text()ing on the
    // shared cursor-loop thread. A wedged client's full send buffer used to block send_all here
    // for up to kSendStallCapMs, freezing EVERY player's cursor stream (measured 10,044 ms).
    // Now the blocking send happens only on that one connection's writer thread; a cursor frame
    // also can never clobber a still-unsent map frame (separate latest-wins slots).
    std::vector<uint8_t> payload(msg.begin(), msg.end());
    size_t queued = 0;
    for (auto& c : targets) {
        if (!c) continue;
        c->enqueue_frame(WsConnection::CH_CURSORS, payload, /*binary=*/false);
        ++queued;
    }
    return queued;
}

// WP-D: enqueue a chat text frame on EVERY live connection's reliable chat FIFO.
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

// WA-15: the legacy map-frame compression/broadcast helpers (deflate_envelope,
// broadcast_map_frame) and the send_map_update/send_ws_keyframe/send_ws_delta/
// ws_request_keyframe/ws_take_keyframe API they backed were removed along with the rest
// of the legacy per-player JSON push wire. Protocol v1's world_stream owns compression
// (deflate_wire_payload, below) and delivery (WsConnection::enqueue_v1_block_set/
// enqueue_v1_aux) for the only map-push path left.

uint64_t ws_frames_sent_total() {   // WT24
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

    // A player is live when at least one socket has answered traffic inside the keepalive
    // deadline. On the first unhealthy observation, start the same grace used for a detected
    // socket removal. A fresh reconnect/heartbeat cancels that pending removal.
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
