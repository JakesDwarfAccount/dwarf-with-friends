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

// Self-contained in-process RFC6455 WebSocket server. It takes over the EXISTING httplib listen
// socket by subclassing httplib::Server; protocol v1 binary frames are the only map-push wire.

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
#include <unordered_set>
#include <vector>

namespace dwf {

// One live browser<->host WebSocket. Sends are thread-safe -- every send is serialized under
// send_mu_ -- while recv() is driven only by the connection's own worker loop.
class WsConnection {
public:
    // A v1 connection's interest window comes from HELLO's `cam`, never from the URL's ?w=&h=.
    WsConnection(::socket_t sock, std::string player, bool proto_v1 = false,
                 bool host_authority = false);
    ~WsConnection();                           // defensively joins the writer thread if alive

    // ---- protocol v1 negotiation -----------------------------------------------------
    // A v1 connection must send `hello` first, gets `hello_ack`, then the binary stream.
    bool is_v1() const { return proto_v1_; }
    const std::string& session() const { return session_; }
    // Computed once from the shared request-origin classifier, so a locally terminated tunnel is
    // remote even though its own socket is loopback. Surfaced to the client in hello_ack's `isHost`.
    bool is_host() const { return is_host_; }
    bool hello_received() const { return hello_received_.load(); }
    // The recv thread stamps parsed hello / `cam` messages here; the push loop reads them to size
    // each v1 connection's interest window.
    void mark_hello(uint32_t have, bool has_cam, int x, int y, int z, int w, int h);
    void update_cam(bool has_pos, int x, int y, int z, int w, int h);
    uint32_t hello_have() const { return hello_have_.load(); }
    bool cam_valid() const { return cam_valid_.load(); }
    // Capability negotiation. Set once by the recv thread while parsing HELLO.
    bool wants_auxd() const { return wants_auxd_.load(); }
    void set_wants_auxd(bool value) { wants_auxd_.store(value); }
    void request_aux_full() { aux_full_requested_.store(true); }
    bool take_aux_full_request() { return aux_full_requested_.exchange(false); }
    // Snapshot the v1 interest window (dims authoritative, xyz advisory). Returns
    // false if no cam/hello has set dims yet.
    bool get_cam(int& x, int& y, int& z, int& w, int& h) const;

    // ---- REQ_BLOCKS -------------------------------------------------------------------
    // Coalesced first-demand FIFO; the push loop validates coordinates and promotes them to front.
    bool queue_reqblocks(const std::vector<std::array<int, 3>>& triples);
    std::vector<std::array<int, 3>> take_reqblocks();   // push-loop thread: drain + clear
    size_t reqblocks_queued() const;
    uint64_t reqblocks_coalesced() const { return reqblocks_coalesced_.load(); }
    uint64_t reqblocks_overflow_drops() const { return reqblocks_overflow_drops_.load(); }

    // ---- chat outbound (reliable FIFO, text frames) -----------------------------
    // Chat must NOT ride a latest-wins channel: the 25 Hz cursor stream would clobber it in 40ms.
    void enqueue_chat(std::vector<uint8_t> text_frame);   // thread-safe; the wire bytes of one frame
    // Recv-thread-only rate limit: true iff enough time has passed since the last ACCEPTED chat
    // message, and it reports the remaining wait on refusal.
    bool chat_rate_ok(long long* retry_after_ms = nullptr);
    bool control_json_error_log_ok();

    // ---- ack-clocked pacing (frame window + byte window + app PING) ------------------
    // The push loop asks for budget before assembling; the recv thread applies ACKs, all under out_mu_.
    uint32_t next_seq();                       // reserve + stamp the next outbound seq
    void record_sent(uint32_t seq, size_t wire_bytes);
    void apply_ack(uint32_t seq);              // recv thread: peer acked up to `seq`
    int  inflight_frames() const;
    // True iff a new sequenced frame may be admitted now: inflight_frames < K, and (for
    // BLOCK_SET) inflight_bytes_ < kBulkBytes. `is_block_set` gates the byte cap.
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
    // Close only once the outbound CTRL queue has drained, so a queued auth_fail frame reaches the
    // client before the socket dies. Thread-safe.
    void deny_after_flush() { deny_after_flush_.store(true); out_cv_.notify_all(); }
    // By value under name_mu_: HELLO may RENAME the connection, and player_ is read concurrently by
    // the push loop, so a returned reference could tear against set_player().
    std::string player() const { std::lock_guard<std::mutex> lk(name_mu_); return player_; }
    void set_player(std::string p) { std::lock_guard<std::mutex> lk(name_mu_); player_ = std::move(p); }
    // Stable client-generated id from HELLO, so the dedup scan can skip a refresh's OWN lingering
    // ghost and let the refresh reuse its slot instead of being renamed.
    std::string client_id() const { std::lock_guard<std::mutex> lk(name_mu_); return client_id_; }
    void set_client_id(std::string id) { std::lock_guard<std::mutex> lk(name_mu_); client_id_ = std::move(id); }

    // Keepalive/health. last_inbound_ms_ is stamped on EVERY inbound frame (data, pong,
    // ping); rtt_ms_ is the last round-trip measured from a server PING's echoed timestamp.
    long long last_inbound_ms() const { return last_inbound_ms_.load(); }
    long long rtt_ms() const { return rtt_ms_.load(); }

    // ---- non-blocking outbound (map-frame) queue -------------------------------------
    // A blocking send to one slow socket would freeze the push thread for EVERY player.
    void start_writer();                       // spawn the writer thread (call once, post-registry)
    void stop_writer();                        // signal + join the writer (call on disconnect)

    // Per-type latest-wins slots under one out_mu_/out_cv_, so no channel can clobber or starve
    // another. The writer drains CTRL -> DICT -> chat -> AUX -> MAP -> CURSORS, one frame per wake.
    enum OutChan { CH_CTRL = 0, CH_DICT = 1, CH_AUX = 2, CH_MAP = 3, CH_CURSORS = 4, CH_N = 5 };
    // Queues into `chan`'s latest-wins slot, overwriting only that channel. True means it DROPPED a
    // still-unsent frame there, so the caller can force a keyframe resync.
    bool enqueue_frame(int chan, std::vector<uint8_t> bytes, bool binary);

    // The writer stamps seq at ACTUAL send time, so a coalesced-away AUX never orphans one and
    // leaks inflight. BLOCK_SETs are disjoint state and ride a FIFO; AUX is latest-wins.
    bool enqueue_v1_block_set(std::vector<uint8_t> payload, bool deflated);  // false if FIFO full
    bool enqueue_v1_aux(std::vector<uint8_t> payload, bool deflated);  // true if an unsent AUX was replaced
    size_t v1_map_fifo_space() const;    // remaining FIFO depth (push-loop pre-check)

private:
    bool send_frame(uint8_t opcode, const uint8_t* data, size_t len);
    void writer_loop();

    ::socket_t sock_;
    mutable std::mutex name_mu_;                // guards player_ + client_id_ (rename)
    std::string player_;
    std::string client_id_;                    // stable per-tab id from HELLO (may be empty)
    std::mutex send_mu_;
    std::atomic<bool> closed_{false};
    std::atomic<bool> socket_shutdown_{false};  // transport shutdown is independent of closed_
    std::atomic<bool> deny_after_flush_{false};  // close once CTRL drains (auth_fail)
    bool is_host_ = false;                     // set once in the constructor; see is_host()

    // ---- protocol v1 -----------------------------------------------------------------
    bool proto_v1_ = false;
    std::string session_;                      // per-connection session id (hello_ack)
    long long connect_ms_ = 0;                 // for the 5 s no-hello 1002 close
    std::atomic<bool> hello_received_{false};
    std::atomic<uint32_t> hello_have_{0};
    std::atomic<bool> wants_auxd_{false};
    std::atomic<bool> aux_full_requested_{false};
    // v1 interest window (dims authoritative from CAM, xyz advisory). Guarded by v1_mu_.
    mutable std::mutex v1_mu_;
    std::atomic<bool> cam_valid_{false};
    int cam_x_ = 0, cam_y_ = 0, cam_z_ = 0, cam_w_ = 0, cam_h_ = 0;
    std::atomic<long long> rtt_ms_app_{-1};    // app-level PING/RTT
    long long last_app_ping_ms_ = 0;           // writer-thread only (app PING cadence)

    // REQ_BLOCKS pending demand. The deque preserves first-demand order; the set makes
    // duplicate retries O(1) without moving older demand behind newer demand.
    struct ReqblocksHash {
        size_t operator()(const std::array<int, 3>& t) const noexcept {
            size_t h = std::hash<int>{}(t[0]);
            h ^= std::hash<int>{}(t[1]) + 0x9e3779b9u + (h << 6) + (h >> 2);
            h ^= std::hash<int>{}(t[2]) + 0x9e3779b9u + (h << 6) + (h >> 2);
            return h;
        }
    };
    mutable std::mutex reqblocks_mu_;
    std::deque<std::array<int, 3>> reqblocks_queue_;
    std::unordered_set<std::array<int, 3>, ReqblocksHash> reqblocks_members_;
    long long last_reqblocks_window_ms_ = 0;    // recv-thread-only: legacy rate-event clock
    long long last_reqblocks_drain_ms_ = 0;     // guarded by reqblocks_mu_: smoothing clock
    std::atomic<uint64_t> reqblocks_coalesced_{0};
    std::atomic<uint64_t> reqblocks_overflow_drops_{0};

    // Chat FIFO (guarded by out_mu_, drained after CH_CTRL) + recv-thread-only send clock.
    static constexpr size_t kChatFifoDepth = 64;
    std::deque<std::vector<uint8_t>> chat_fifo_;
    long long last_chat_ms_ = 0;   // recv-thread-only (chat_rate_ok); no lock needed
    long long last_json_error_log_ms_ = 0; // recv-thread-only; bounds malformed-client logging

    // pacing -- guarded by out_mu_ (recv thread updates on ACK, writer reads).
    uint32_t last_sent_seq_ = 0;
    uint32_t last_acked_seq_ = 0;
    size_t   inflight_bytes_ = 0;
    struct SeqBytes { uint32_t seq = 0; size_t bytes = 0; };
    static constexpr int kSeqRing = 64;
    SeqBytes seq_ring_[kSeqRing];              // seq -> wire bytes, for inflight_bytes accounting

    // last_inbound_ms_ is written by the recv thread and read by the writer's silence sweep and
    // /diag; last_ping_ms_ is touched only by the writer thread.
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
    // Sized to window_open()'s kKMax, so the FIFO never becomes the bottleneck on a high-RTT link.
    static constexpr size_t kV1MapFifoDepth = 16;
    std::deque<V1Frame> v1_map_fifo_;    // BLOCK_SET FIFO (never dropped-after-marked)
    V1Frame v1_aux_;                     // AUX latest-wins slot
    bool v1_aux_has_ = false;
};

// Handshake auth predicate over the raw `Cookie:` header value; unset => allow all.
using WsAuthFn = std::function<bool(const std::string& cookie_header)>;

// ---- protocol v1 map info provider -------------------------------------------------
// hello_ack needs map size + world_seq, which the transport cannot read from the recv thread.
struct V1MapInfo { int w = 0, h = 0, z = 0; uint32_t world_seq = 0; };
using V1MapInfoFn = std::function<V1MapInfo()>;
void set_v1_map_info(V1MapInfoFn fn);

// Publishes the loaded map's total block universe as REQ_BLOCKS' hard sanity bound (zero=no map).
void set_reqblocks_map_capacity(size_t blocks);

// Broadcast a raw (already-serialized) text message to all of a player's sockets.
// Returns the number of live sockets it was written to.
size_t broadcast_to_player(const std::string& player, const std::string& msg);

// Broadcasts a chat frame to every live connection through its reliable FIFO, never the coalescing
// channels. The sender is included, so its own line returns through the normal receive path.
size_t broadcast_chat_to_all(const std::string& msg);

// Diagnostics.
// Total WS frames written to a socket since the plugin loaded, all players and channels.
uint64_t ws_frames_sent_total();
std::string ws_drop_counters_json();
size_t ws_connection_count();
size_t ws_connection_count_for(const std::string& player);

// The freshest connection's last measured RTT and inbound-silence age. False when the player has
// no live socket.
bool ws_player_health(const std::string& player, long long& rtt_ms, long long& last_inbound_age_ms);

// The freshest live v1 connection's real zoom-aware interest window -- what the player actually
// SEES, never hud.viewport. False when no live v1 socket has sent cam dims yet.
bool ws_cam_for_player(const std::string& player, int& x, int& y, int& z, int& w, int& h);

// Distinct player names with at least one live socket. The push loop iterates THIS, not the camera
// registry, so a connected player is streamed every tick even when sending no input.
std::vector<std::string> ws_connected_players();

// Roster truth with disconnect grace: live/healthy sockets plus names whose last socket or
// heartbeat disappeared less than the grace window ago. Reconnect cancels the pending removal.
std::vector<std::string> ws_roster_players();

// Every live protocol-v1 connection. The v1 push path is per-CONNECTION (each has
// its own interest window + pacing); this is the ONLY map-push path.
std::vector<std::shared_ptr<WsConnection>> ws_v1_connections();

// Deflates a payload (zlib/RFC1950, Z_BEST_SPEED); the client inflates with DecompressionStream.
// Returns empty on failure.
std::vector<uint8_t> deflate_wire_payload(const uint8_t* data, size_t len);

// Close every open WebSocket (call on plugin shutdown so worker threads unblock).
void ws_close_all();

// The SAME loopback determination WsConnection::is_host() uses, exported so an HTTP handler can
// pass req.remote_addr and get the identical host signal.
bool peer_ip_is_loopback(const std::string& ip);

// ---- server factory ---------------------------------------------------------------

// A WsHttpServer (httplib::Server subclass) with "/ws" installed. Drop-in for a plain
// httplib::Server: register_routes, bind and the listen thread are unchanged.
std::unique_ptr<httplib::Server> make_ws_server();

// Rejects queued HTTP work and wakes accepted sockets. httplib::Server::stop() only closes the
// listen socket, so this MUST be called before it. Safe to call more than once.
void ws_server_begin_shutdown(httplib::Server& server);

} // namespace dwf
