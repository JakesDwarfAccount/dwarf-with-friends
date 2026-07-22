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

// websocket.h -- self-contained in-process RFC6455 WebSocket server for dwf.
//
// Replaces the ~2/sec /mapdata HTTP polling with an instant server->client PUSH. As of
// WA-15 the ONLY map-push wire is protocol v1 (binary BLOCK_SET/AUX frames, driven by
// world_stream.cpp's global read pass -- see world_stream.h); the original per-player
// JSON push API this file used to describe (send_map_update/send_ws_keyframe/
// send_ws_delta) was the legacy wire and has been removed.
//
// The transport reuses the *existing* httplib server socket by subclassing
// httplib::Server and overriding the (private virtual) process_and_close_socket:
// a raw MSG_PEEK classifies each accepted socket as either an HTTP `Upgrade:
// websocket` (which we take over for RFC6455 framing) or a normal HTTP request
// (which we hand back to httplib::Server's own handling). No new listen socket,
// no new thread pool, no third-party dependency -- SHA-1 + base64 + framing are
// implemented inline in websocket.cpp.
//
// This header + websocket.cpp are a self-contained module. Integration only has to:
//   (1) build the WsHttpServer instead of a plain httplib::Server (make_ws_server()),
//   (2) drive protocol v1 through world_stream.cpp's push (world_stream_tick),
//   (3) optionally set_ws_auth(...) to gate the handshake behind the shared cookie.
// See docs/superpowers/analysis/websocket-integration.md for the (now historical)
// legacy-wire integration diff.

#pragma once

#include "httplib.h"

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace dwf {

// One live browser<->host WebSocket. Sends are thread-safe (a producer thread may
// push while the owning worker thread blocks in recv() -- the two directions are
// independent and every send is serialized under send_mu_). recv() is driven only
// by the connection's own worker loop.
class WsConnection {
public:
    // WA-15: the `?w=&h=` pre-HELLO URL dims (and the req_w()/req_h() accessors that used
    // to expose them to the legacy per-player push loop) were removed along with the
    // legacy wire -- a v1 connection's interest window comes from HELLO's `cam` (or a
    // later `cam` message), never the URL. The server harmlessly ignores a `w=`/`h=` a
    // client still sends on the URL.
    WsConnection(::socket_t sock, std::string player, bool proto_v1 = false,
                 bool host_authority = false);
    ~WsConnection();                           // defensively joins the writer thread if alive

    // ---- protocol v1 negotiation (WA-8) ----------------------------------------------
    // A v1 connection (?proto=1 on the /ws URL) receives NO legacy seed and NO legacy
    // pushes; it must send `hello` first (§0.4), gets `hello_ack`, then the binary stream.
    bool is_v1() const { return proto_v1_; }
    const std::string& session() const { return session_; }
    // isHostClient() hook: computed once from the shared request-origin classifier using the
    // accepted peer plus Upgrade headers. A locally terminated tunnel is therefore remote even
    // though its origin socket is loopback. Surfaced to the client in hello_ack's
    // `isHost` field (send_hello_ack) -- the "existing per-player JSON" the client already
    // parses on every v1 connection.
    bool is_host() const { return is_host_; }
    bool hello_received() const { return hello_received_.load(); }
    // Recv thread stamps the parsed hello (§0.4) / subsequent `cam` messages here; the push
    // loop (world_stream, WA-9) reads them to size each v1 connection's interest window.
    void mark_hello(uint32_t have, bool has_cam, int x, int y, int z, int w, int h);
    void update_cam(bool has_pos, int x, int y, int z, int w, int h);
    uint32_t hello_have() const { return hello_have_.load(); }
    bool cam_valid() const { return cam_valid_.load(); }
    // S5 capability negotiation. Set once by the recv thread while parsing HELLO.
    bool wants_auxd() const { return wants_auxd_.load(); }
    void set_wants_auxd(bool value) { wants_auxd_.store(value); }
    void request_aux_full() { aux_full_requested_.store(true); }
    bool take_aux_full_request() { return aux_full_requested_.exchange(false); }
    // Snapshot the v1 interest window (dims authoritative; xyz advisory in W-A). Returns
    // false if no cam/hello has set dims yet.
    bool get_cam(int& x, int& y, int& z, int& w, int& h) const;

    // ---- REQ_BLOCKS (WA-11.3) ---------------------------------------------------------
    // Client cache-hole refill request ({"type":"reqblocks","blocks":[[bx,by,bz],...]}),
    // parsed + range-sanity-checked by the recv thread's handle_client_text, rate-limited
    // here to >=250ms between ACCEPTED messages (extras dropped silently, §0.4) and queued
    // for world_stream's push-loop thread to drain, validate against map dims, and promote
    // to front-of-pending (priority 0, §0.8). Thread-safe; `triples` is already capped at 64
    // by the caller's parser. Returns false when the message was rate-limited (dropped).
    bool queue_reqblocks(const std::vector<std::array<int, 3>>& triples);
    std::vector<std::array<int, 3>> take_reqblocks();   // push-loop thread: drain + clear
    size_t reqblocks_queued() const;
    uint64_t reqblocks_rate_drops() const { return reqblocks_rate_drops_.load(); }
    uint64_t reqblocks_overflow_drops() const { return reqblocks_overflow_drops_.load(); }

    // ---- WP-D chat outbound (reliable FIFO, text frames) -----------------------------
    // Chat lines must NOT be coalesced away like the latest-wins channels (a chat frame on
    // CH_CURSORS would be clobbered within 40ms by the 25Hz cursor stream). They ride their own
    // small FIFO, drained right after CH_CTRL (tiny + latency-sensitive). Bounded: if a slow
    // client backs up past kChatFifoDepth the OLDEST queued line is dropped -- that client will
    // reconnect and refetch GET /chat scrollback anyway, so no line is ever truly lost.
    void enqueue_chat(std::vector<uint8_t> text_frame);   // thread-safe; the wire bytes of one frame
    // Per-connection send rate limit (recv-thread-only, like last_reqblocks_ms_): true iff enough
    // time has elapsed since the last ACCEPTED chat message. Updates the clock on acceptance and
    // reports the remaining wait on refusal so the sender gets an honest client-visible result.
    bool chat_rate_ok(long long* retry_after_ms = nullptr);
    bool control_json_error_log_ok();

    // ---- ack-clocked pacing (WA-9 basic window; WA-10 byte-window + app PING) ---------
    // Per-connection sequence space for BLOCK_SET/AUX frames (§0.6). The push loop queries
    // the window budget before assembling frames; the recv thread applies ACKs (signals
    // out_cv_ so a window-blocked writer wakes on an ACK). All guarded by out_mu_.
    uint32_t next_seq();                       // reserve + stamp the next outbound seq
    void record_sent(uint32_t seq, size_t wire_bytes);
    void apply_ack(uint32_t seq);              // recv thread: peer acked up to `seq`
    int  inflight_frames() const;
    size_t inflight_bytes() const;
    // True iff a new sequenced frame may be admitted now: inflight_frames < K, and (for
    // BLOCK_SET) inflight_bytes < bulk_bytes. `is_block_set` gates the byte cap (WA-10).
    bool window_open(bool is_block_set) const;
    long long rtt_ms_app() const { return rtt_ms_app_.load(); }
    void note_app_pong(long long server_ts, long long client_ts);
    long long app_ping_due_ms() const { return last_app_ping_ms_; }
    void set_app_ping_ms(long long ms) { last_app_ping_ms_ = ms; }

    // server->client, always UNMASKED per RFC6455. false once the socket is closed.
    bool send_text(const std::string& utf8);
    bool send_binary(const uint8_t* data, size_t len);

    // Blocks until a full text/binary message arrives (transparently answering
    // ping->pong and honoring close). false on close/error; *err set when non-null.
    bool recv(std::string& payload, bool& is_binary, std::string* err);

    void close();                              // idempotent: sends close once + shuts socket I/O
    bool is_closed() const;
    // JOIN SECURITY: request the writer to close this connection once its outbound CTRL queue has
    // drained (so a queued auth_fail frame actually reaches the client before the socket dies).
    // Thread-safe; called from the recv thread on a failed hello-token check.
    void deny_after_flush() { deny_after_flush_.store(true); out_cv_.notify_all(); }
    // player() returns by value under name_mu_: B09(a) may RENAME the connection at HELLO
    // (server-side name dedup), and player_ is read concurrently by the push loop / registry,
    // so a plain reference could tear against set_player(). The name is set once at connect and
    // at most once more at HELLO, so the lock is uncontended in steady state.
    std::string player() const { std::lock_guard<std::mutex> lk(name_mu_); return player_; }
    void set_player(std::string p) { std::lock_guard<std::mutex> lk(name_mu_); player_ = std::move(p); }
    // B09(a): stable client-generated id from HELLO (sessionStorage). Lets the dedup scan skip a
    // page-refresh's OWN lingering ghost (same id) so a refresh reuses its slot instead of being
    // renamed. Empty until a HELLO carrying `id` arrives.
    std::string client_id() const { std::lock_guard<std::mutex> lk(name_mu_); return client_id_; }
    void set_client_id(std::string id) { std::lock_guard<std::mutex> lk(name_mu_); client_id_ = std::move(id); }

    // Keepalive/health (WA-3). last_inbound_ms_ is stamped on EVERY inbound frame (data, pong,
    // ping); rtt_ms_ is the last round-trip measured from a server PING's echoed timestamp.
    long long last_inbound_ms() const { return last_inbound_ms_.load(); }
    long long rtt_ms() const { return rtt_ms_.load(); }

    // ---- non-blocking outbound (map-frame) queue -------------------------------------
    // The map-push loop must NEVER block on a slow socket: a single blocking send to a
    // backed-up client (tunnel hiccup, backgrounded tab) would freeze the push thread for
    // EVERY player. So map frames are handed to this per-connection queue (non-blocking)
    // and a dedicated writer thread drains it with blocking sends -- isolating the stall to
    // the one slow connection. The queue holds only the LATEST frame: if a new frame arrives
    // before the previous one was sent, the old one is dropped (coalesced) and the client
    // simply gets the newest state at whatever rate its link sustains (a fast client gets
    // every 30Hz delta; a slow one gets fewer, larger-gap frames -- but never a backlog).
    void start_writer();                       // spawn the writer thread (call once, post-registry)
    void stop_writer();                        // signal + join the writer (call on disconnect)

    // Outbound channels: per-type latest-wins slots under the SAME out_mu_/out_cv_. A frame of
    // one type can never clobber (A1: a cursor push froze another player's map/cursors) nor be
    // starved by another; the writer drains in priority order CTRL -> MAP -> CURSORS, one frame
    // per wake. CH_CTRL is reserved here for WA-3/WA-10 protocol control (ping/hello_ack). This
    // is the writer shape the v1 sender later rides.
    // CH_AUX (WA-9): the 30 Hz units/buildings/cam JSON rides its OWN channel so a big
    // BLOCK_SET never starves it. CH_MAP carries v1 BLOCK_SET frames (and legacy map
    // frames); both are drained CTRL -> AUX -> MAP -> CURSORS.
    enum OutChan { CH_CTRL = 0, CH_AUX = 1, CH_MAP = 2, CH_CURSORS = 3, CH_N = 4 };
    // Queue a frame (already WS-payload bytes) into `chan`'s latest-wins slot; overwrites ONLY
    // that channel. Returns true if it DROPPED a still-unsent frame in that channel (the client
    // is falling behind on that stream) so the caller can react (e.g. force a keyframe resync).
    bool enqueue_frame(int chan, std::vector<uint8_t> bytes, bool binary);

    // ---- v1 sequenced outbound (WA-9/10) ---------------------------------------------
    // BLOCK_SET/AUX carry a per-connection seq the writer stamps at ACTUAL send time (so a
    // coalesced-away AUX never orphans a seq -> no inflight leak). `payload` is the frame
    // BODY (no header); the writer prepends build_frame_header(type, deflated?flag:0,
    // next_seq()) and record_sent()s the wire bytes. BLOCK_SETs are DISJOINT state, so they
    // ride a small FIFO (never dropped-after-marked); AUX is latest-wins (full re-send/tick).
    bool enqueue_v1_block_set(std::vector<uint8_t> payload, bool deflated);  // false if FIFO full
    bool enqueue_v1_aux(std::vector<uint8_t> payload, bool deflated);  // true if an unsent AUX was replaced
    size_t v1_map_fifo_space() const;    // remaining FIFO depth (push-loop pre-check)

private:
    bool send_frame(uint8_t opcode, const uint8_t* data, size_t len);
    void writer_loop();

    ::socket_t sock_;
    mutable std::mutex name_mu_;                // guards player_ + client_id_ (B09(a) rename)
    std::string player_;
    std::string client_id_;                    // B09(a): stable per-tab id from HELLO (may be empty)
    std::mutex send_mu_;
    std::atomic<bool> closed_{false};
    std::atomic<bool> socket_shutdown_{false};  // transport shutdown is independent of closed_
    std::atomic<bool> deny_after_flush_{false};  // JOIN SECURITY: close once CTRL drains (auth_fail)
    bool is_host_ = false;                     // set once in the constructor; see is_host()

    // ---- protocol v1 (WA-8/9/10) -----------------------------------------------------
    bool proto_v1_ = false;
    std::string session_;                      // per-connection session id (hello_ack)
    long long connect_ms_ = 0;                 // for the 5 s no-hello 1002 close
    std::atomic<bool> hello_received_{false};
    std::atomic<uint32_t> hello_have_{0};
    std::atomic<bool> wants_auxd_{false};
    std::atomic<bool> aux_full_requested_{false};
    // v1 interest window (dims authoritative from CAM; xyz advisory in W-A). Guarded by v1_mu_.
    mutable std::mutex v1_mu_;
    std::atomic<bool> cam_valid_{false};
    int cam_x_ = 0, cam_y_ = 0, cam_z_ = 0, cam_w_ = 0, cam_h_ = 0;
    std::atomic<long long> rtt_ms_app_{-1};    // app-level PING/RTT (WA-10)
    long long last_app_ping_ms_ = 0;           // writer-thread only (app PING cadence, WA-10)

    // REQ_BLOCKS queue (WA-11.3). last_reqblocks_ms_ is recv-thread-only (calls serialized
    // by the connection's own single recv loop -- no sync needed for it).
    static constexpr size_t kReqblocksQueueDepth = 256;
    mutable std::mutex reqblocks_mu_;
    std::vector<std::array<int, 3>> reqblocks_queue_;
    long long last_reqblocks_ms_ = 0;
    std::atomic<uint64_t> reqblocks_rate_drops_{0};
    std::atomic<uint64_t> reqblocks_overflow_drops_{0};

    // WP-D chat FIFO (guarded by out_mu_, drained after CH_CTRL) + recv-thread-only send clock.
    static constexpr size_t kChatFifoDepth = 64;
    std::deque<std::vector<uint8_t>> chat_fifo_;
    long long last_chat_ms_ = 0;   // recv-thread-only (chat_rate_ok); no lock needed
    long long last_json_error_log_ms_ = 0; // recv-thread-only; bounds malformed-client logging

    // pacing (WA-10) -- guarded by out_mu_ (recv thread updates on ACK, writer reads).
    uint32_t last_sent_seq_ = 0;
    uint32_t last_acked_seq_ = 0;
    size_t   inflight_bytes_ = 0;
    struct SeqBytes { uint32_t seq = 0; size_t bytes = 0; };
    static constexpr int kSeqRing = 64;
    SeqBytes seq_ring_[kSeqRing];              // seq -> wire bytes, for inflight_bytes accounting

    // Keepalive state (WA-3). last_inbound_ms_ written by the recv thread, read by the writer
    // (silence sweep) and /diag. rtt_ms_ written by the recv thread on PONG, read by /diag.
    // last_ping_ms_ is touched only by the writer thread (no sync needed).
    std::atomic<long long> last_inbound_ms_{0};
    std::atomic<long long> rtt_ms_{-1};
    long long last_ping_ms_ = 0;

    // outbound per-type channel slots (guarded by out_mu_)
    struct OutSlot {
        std::vector<uint8_t> bytes;            // latest pending payload for this channel
        bool binary = true;
        bool has = false;                       // a frame is pending in this channel
    };
    mutable std::mutex out_mu_;
    std::condition_variable out_cv_;
    OutSlot out_[CH_N];
    bool out_stop_ = false;
    std::thread out_thread_;

    // v1 sequenced outbound (guarded by out_mu_). type is wire::kTypeBlockSet/kTypeAux.
    struct V1Frame { std::vector<uint8_t> payload; uint8_t type = 0; bool deflated = false; };
    // WA-16: sized to the RTT-adaptive ack window's ceiling (window_open()'s kKMax) so the
    // FIFO itself never becomes the new bottleneck once the window opens up for a
    // high-latency connection -- see window_open()'s comment for the throughput math.
    static constexpr size_t kV1MapFifoDepth = 16;
    std::deque<V1Frame> v1_map_fifo_;    // BLOCK_SET FIFO (never dropped-after-marked)
    V1Frame v1_aux_;                     // AUX latest-wins slot
    bool v1_aux_has_ = false;
};

// Auth hook. Integration wires this to the WS0 shared-cookie check
// (request_authed) so an unauthenticated Upgrade is rejected with 401 BEFORE the
// protocol switch. Default (unset) => allow all, so the module compiles and runs
// standalone before WS0 auth lands. Receives the raw `Cookie:` header value.
using WsAuthFn = std::function<bool(const std::string& cookie_header)>;
void set_ws_auth(WsAuthFn fn);

// ---- protocol v1 map info provider (WA-8) -----------------------------------------
// hello_ack (§0.5) must carry the map size + current world_seq, which require DF access
// under the capture lock. The transport can't read DF safely from the recv thread, so
// http_server registers this provider; websocket.cpp calls it (off the DF sim thread,
// results cached) to fill hello_ack. Unset => zeros (valid JSON, WA-9 fills it in).
struct V1MapInfo { int w = 0, h = 0, z = 0; uint32_t world_seq = 0; };
using V1MapInfoFn = std::function<V1MapInfo()>;
void set_v1_map_info(V1MapInfoFn fn);

// ---- per-player push API (called by the map producer, any thread) ----------------
// WA-15: the legacy per-player JSON push API (send_map_update/send_ws_keyframe/
// send_ws_delta/ws_request_keyframe/ws_take_keyframe, plus the g_latest_map seed cache
// and g_keyframe_players resync flag they used) was removed with the legacy wire itself
// -- protocol v1's world_stream (world_stream_tick) is the only map-push path left.

// Broadcast a raw (already-serialized) text message to all of a player's sockets.
// Returns the number of live sockets it was written to.
size_t broadcast_to_player(const std::string& player, const std::string& msg);

// WP-D: broadcast a chat text frame to EVERY live connection via its reliable chat FIFO (never the
// coalescing latest-wins channels). Returns the number of connections it was enqueued on. Used by
// chat.cpp's relay/scrollback; the sender's own connection is included, so a sender sees its own
// line echoed back through the normal receive path (single source of truth for ordering).
size_t broadcast_chat_to_all(const std::string& msg);

// Diagnostics.
// WT24: total WS frames successfully written to a socket since the plugin loaded (all
// players, all channels). The 60 s crash-evidence heartbeat prints the per-beat delta.
uint64_t ws_frames_sent_total();
std::string ws_drop_counters_json();
size_t ws_connection_count();
size_t ws_connection_count_for(const std::string& player);

// Keepalive health for /diag (WA-3): the freshest (most-recently-heard-from) connection's
// last measured RTT (ms; -1 if none yet) and inbound-silence age (ms). Returns false when the
// player has no live socket.
bool ws_player_health(const std::string& player, long long& rtt_ms, long long& last_inbound_age_ms);

// WT-spec WP-A §1.2: the freshest live v1 connection's REAL zoom-aware interest window
// (WsConnection cam_x_/y_/z_/w_/h_, fed by {"type":"cam"} on every pan/zoom) for the presence
// roster's viewbox fields (WT05 minimap boxes + WT02 elevation camz). This is the window the
// player actually SEES -- never hud.viewport (the server capture grid, B25). Returns false when
// the player has no live v1 socket that has sent cam dims yet (caller falls back to the
// client_state camera x/y/z with dims omitted). Same locking pattern as ws_player_health.
bool ws_cam_for_player(const std::string& player, int& x, int& y, int& z, int& w, int& h);

// Distinct player names that currently have at least one live WebSocket. The push loop
// iterates THIS (who is actually connected) rather than the camera registry, so a connected
// player is streamed the running game every tick even when they aren't sending input.
std::vector<std::string> ws_connected_players();

// Roster truth with disconnect grace: live/healthy sockets plus names whose last socket or
// heartbeat disappeared less than the grace window ago. Reconnect cancels the pending removal.
std::vector<std::string> ws_roster_players();

// Every live protocol-v1 connection (WA-9). The v1 push path is per-CONNECTION (each has
// its own interest window + pacing); this is now the ONLY map-push path (WA-15).
std::vector<std::shared_ptr<WsConnection>> ws_v1_connections();

// Deflate a raw binary payload (zlib/RFC1950, Z_BEST_SPEED -- same codec as the legacy
// envelope; client inflates with DecompressionStream("deflate")). Used by world_stream to
// compress v1 BLOCK_SET/AUX bodies > 8 KiB (§0.2). Returns empty on failure.
std::vector<uint8_t> deflate_wire_payload(const uint8_t* data, size_t len);

// Close every open WebSocket (call on plugin shutdown so worker threads unblock).
void ws_close_all();

// isHostClient() peer test, exported for HTTP callers (the /action pause route): true iff `ip`
// is loopback (127.0.0.0/8, ::1, or the v4-mapped form). This is the SAME determination
// WsConnection::is_host() uses for a socket -- an HTTP handler passes req.remote_addr here to
// get the identical host signal for a same-machine (localhost) browser vs any tunnel/LAN peer.
bool peer_ip_is_loopback(const std::string& ip);

// ---- server factory ---------------------------------------------------------------

// Returns a WsHttpServer (a httplib::Server subclass) with the "/ws" push route
// installed. Drop-in for `std::make_unique<httplib::Server>()` in start_server --
// register_routes(*server), bind, and the listen thread are all unchanged.
std::unique_ptr<httplib::Server> make_ws_server();

// Reject queued HTTP work and wake accepted sockets before the listen thread is joined.
// This is separate from httplib::Server::stop(), which only closes the listen socket.
void ws_server_begin_shutdown(httplib::Server& server);

} // namespace dwf
