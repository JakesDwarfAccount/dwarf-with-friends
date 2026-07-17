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

// W23 -- the C++ binding of the dfcapture-hostwrites.json guard mechanism (V1 critical safety).
//
// dfcapture-hostwrites.json (next to the DF executable == the plugin's working directory, the
// SAME file dwf.lua's hw_flags reads for the trade/justice probe guards) is THE repo's one
// mechanism for runtime write-guards that FAIL CLOSED: a missing file, a missing key, or any
// value other than the literal `true` means OFF. This header adds the C++ side so routes
// implemented in the plugin (not the Lua) can be gated by the same file with the same semantics.
// DO NOT invent a second flag file or a second reader convention.
//
// The W23 flags (docs/W18-TRIAGE-CANDIDATES.md critical rows; the triage decisions):
//   dfhack_console        -- the browser DFHack console (WT26). HOST POLICY, not a probe guard:
//                            "let friends run DFHack commands on my PC". Default OFF for a
//                            stranger's install. The host may flip it from the host panel
//                            (POST /console-config, host-tab-only) -- the ONLY HTTP-settable key.
//                            It is now the ONLY flag: /write-guards enumerates exactly one guard.
//
// REMOVED 2026-07-17 (owner policy -- ship it working; the write was verified live on this
// machine): `squad_pos0`, B249's position-0 commander write. A browser /squad-create ->
// /squad-assign?pos=0 on a real fort seated the commander coherently (positions[0].occupant ==
// unit.hist_figure_id, exactly one fort noble assignment, no duplicates) and disband unseated it
// cleanly, DF alive throughout -- the exact Nobles state the probe guard was waiting for. Its
// guard, flag constant, /write-guard-config toggle route, /write-guards enumeration entry, host-
// panel row, and client lock states are all gone.
//
// REMOVED 2026-07-16 (owner policy -- small-group co-op, no anti-griefing gates on destructive
// play): `zone_remove`, `hauling_route_delete`, and `squad_disband`. All three delete paths are
// hazard-closed -- they purge their native UI pointer caches before the free, under CoreSuspender
// (zone: civzone cur_bld/list/zone_just_created; hauling: view_routes/view_stops; squad:
// purge_ui_caches_for_squad over the eight squad-pointer caches -- the five main_interface fields,
// plotinfo.squads.list/nearest_squad, the world/mission viewscreen_worldst.squad on the gview
// stack, and the world.squads.order_load load buffer). squad_disband was the last to fall: it was
// HELD as an implementation-safety gate until do_squad_delete's use-after-free (freeing a squad
// still cached in a live squad screen -- the stockpile-UAF class) was fixed by
// purge_ui_caches_for_squad. With the UAF closed, removal is open to every authenticated player,
// join-auth still upstream. Their guards, flag constants, /write-guards enumeration, host-panel
// rows, and client lock states are all gone.
//
// dfhack_console is the sole remaining guard: a HOST POLICY toggle, not a probe guard. Every other
// probe flag has been retired. No route may set any key but dfhack_console (host-tab-only).

#pragma once

#include <string>

namespace httplib { class Server; struct Request; }

namespace dwf {
namespace guards {

// The W23 flag names (single source for C++ call sites; the Lua side spells its own).
constexpr const char* kConsoleFlag = "dfhack_console";

// Pure flat scan of the hostwrites JSON text for `"<flag>": true`. FAIL CLOSED: the ONLY input
// that enables is a well-formed `"<flag>"` key whose value is literally `true` (with a
// non-identifier character or end-of-text after it). Absent key, malformed colon, `false`,
// `"true"` (string), `TRUE`, `1`, `truex` -- all scan as off. This is the exact inverse default
// of sound_route.h's scan_audio_remote (which fails OPEN by product decision); guards fail
// CLOSED by definition. Header-only + pure so an offline fixture can drive the real function.
inline bool scan_hostwrite_flag(const std::string& text, const std::string& flag) {
    const std::string key = "\"" + flag + "\"";
    size_t k = text.find(key);
    if (k == std::string::npos) return false;                 // key absent -> OFF
    size_t i = k + key.size();
    while (i < text.size() && (text[i] == ' ' || text[i] == '\t')) ++i;
    if (i >= text.size() || text[i] != ':') return false;     // malformed -> OFF
    ++i;
    while (i < text.size() && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' ||
                               text[i] == '\n')) ++i;
    const size_t after = i + 4;
    if (after < text.size()) {
        const char c = text[after];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
            c == '_')
            return false;                                     // `truex` etc. -> OFF
    }
    // The ONLY enabling return: a literal, boundary-clean `true`.
    return text.compare(i, 4, "true") == 0;
}

// Read one flag from dfcapture-hostwrites.json (working dir == DF root, same relative-path
// convention as dfhack-config/dfcapture.json in sound_route.cpp). Missing/unreadable file ->
// false. Whole-file text cached with a short TTL so a host toggle takes effect within seconds
// without a plugin reload, and request bursts don't re-stat the file each time.
bool hostwrite_enabled(const std::string& flag);

// {"ok":false,"unsupported":true,"guarded":true,"flag":...,"error":...}\n -- the same refusal
// shape dwf.lua's hw_guarded emits, so clients treat Lua-guarded and C++-guarded routes
// identically. `what` is the plain-English name of the refused action; `why` the one-sentence
// host-facing reason.
std::string guarded_refusal_json(const std::string& flag, const std::string& what,
                                 const std::string& why);

// True iff the request comes from the host's OWN browser tab -- the SAME tunnel-aware test
// /console-config uses to decide who may flip a flag (loopback peer + no proxy-forwarding header +
// a loopback-ish Host, so a cloudflared-tunneled remote friend is NOT waved through as the host).
// Exposed so a mutation route can grant the host the authority it plainly already has at the DF
// keyboard, while every remote guest stays bound by the fail-closed hostwrite flag. Server-side
// and peer-address-derived: it never trusts anything the client claimed (mirror of
// websocket.cpp's is_host_ / DwfWS.isHost()).
bool request_is_host_tab(const httplib::Request& req);

// Register GET /write-guards and the host-only /console-config toggle (the sole settable flag).
// Call above the catch-all so auth covers all.
void register_write_guard_routes(httplib::Server& server);

} // namespace guards
} // namespace dwf
