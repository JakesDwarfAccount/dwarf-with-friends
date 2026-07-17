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

// chat.h -- WP-D MULTIPLAYER CHAT (friends-tier). Server relay + short scrollback ring buffer.
//
// The server is AUTHORITATIVE: every accepted line gets a monotonic `seq`, is appended to a
// bounded ring (last kRingCap lines), and is broadcast to every live WebSocket as a text frame
//   {"type":"chat","seq":N,"from":"<name>","text":"<raw>","ts":<wall_ms>}          (player line)
//   {"type":"chat","seq":N,"system":true,"text":"<raw>","ts":<wall_ms>}            (join/leave)
// Live delivery rides a dedicated per-connection FIFO channel (WsConnection::enqueue_chat), so a
// chat line is NEVER coalesced away by the 25 Hz cursor stream the latest-wins channels carry.
// The ring + `seq` are the safety net for the two cases live delivery can't cover: a LATE JOINER
// (fetches GET /chat for recent history) and a RECONNECT gap (client refetches GET /chat?since=N
// when it sees a seq jump). One reconciliation path covers both.
//
// The server stores + relays the RAW text (JSON-escaped on the wire only). It is the CLIENT's job
// to render it as inert text (textContent, never innerHTML) -- the chat box is an injection
// surface, so `<img src=x onerror=...>` must display as literal characters, never execute. That
// XSS defense is structural (dwf-chat.js) and is the mandatory test-the-test cell.
//
// Colors: chat name chips are colored on the CLIENT via the ONE canonical helper
// DwfTiles.playerColor(name) (the same hash the cursor/lobby/minimap use), so no `color`
// field rides the wire and a player's chat name matches their cursor exactly.

#pragma once

#include "httplib.h"

#include <string>

namespace dwf {

// Accept + relay a player chat line. `from` is the connection's authoritative (deduped) name.
// Trims + clamps `text` (see chat_sanitize); a line that is empty after trimming is REJECTED
// (returns false, no seq consumed, no broadcast). Otherwise assigns the next seq, appends to the
// ring, and broadcasts to all. Thread-safe. Rate-limiting is the CALLER's concern (per-connection,
// WsConnection::chat_rate_ok) so a flood never even reaches the shared ring lock.
bool chat_post(const std::string& from, const std::string& text);

// Emit a system line (join/leave). Same seq/ring/broadcast path; `system:true`, no `from`.
void chat_system(const std::string& text);

// Presence-driven join/leave lines. Called ~1 Hz from ws_cursor_loop (core-free). Reconciles a
// confirmed-present set against ws_connected_players(): a newly-present name emits "X joined"; a
// name gone for longer than the leave grace emits "X left" (the grace absorbs a page REFRESH, which
// briefly empties then refills the name's socket bucket -- no spurious left/joined pair). The very
// first tick SILENTLY seeds the present set (so a DLL hot-swap mid-session doesn't dump a "joined"
// burst for everyone already connected).
void chat_presence_tick();

// GET /chat[?since=N] -- scrollback for a late joiner (no `since`, returns the whole ring) or a
// reconnect gap-fill (`since=N`, returns only lines with seq > N). Response:
//   {"latest":<seq>,"lines":[{"seq":N,"from":"..","text":"..","ts":..}|{"seq":N,"system":true,..}]}
// Gated by the shared-cookie pre-routing auth handler like every other game route; an OLD DLL has
// no /chat route (404), which is exactly how the client detects a chat-less host (dormant).
void register_chat_routes(httplib::Server& server);

// ---- offline selftest (capture-chat-selftest command) --------------------------------------
// Pure text sanitizer, exercised by the selftest with NO DF/world access: trims ASCII whitespace
// (incl. \r\n\t) from both ends and hard-clamps to kMaxLen bytes (UTF-8-safe: never splits a
// trailing multibyte sequence). Returns false iff the result is empty (the reject signal).
bool chat_sanitize(const std::string& in, std::string& out);

// Runs chat_sanitize over a fixed table of cases (empty, whitespace-only, XSS seed passthrough,
// overlong clamp, UTF-8 boundary). Returns true iff all pass. Logs a one-line PASS/FAIL.
bool chat_selftest();

// JSON string-body escaper that PASSES BYTES THROUGH -- makes a raw UTF-8 string safe inside a JSON
// "..." literal WITHOUT the CP437->UTF-8 transcode json_util::json_escape applies (which corrupts
// already-UTF-8 browser text; see the definition's comment). Used for any string that arrived from
// the browser already UTF-8-decoded: chat from/text AND player names (hello_ack.player + presence
// name), so the identity the client adopts is byte-identical to the raw name the WS registered under.
std::string chat_escape(const std::string& raw);

} // namespace dwf
