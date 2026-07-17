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

// sound_route.h -- P1 audio serving (spec 2026-07-09-audio-music-spec.md §3).
//
// GET /sound/(.+) serves the player's OWN Dwarf Fortress OST straight off the install
// (data/sound/...), as browser-native Ogg Vorbis, with:
//   * a custom Get route (NOT set_mount_point) so httplib emits a real 206 on a ranged seek
//     -- a mount hard-sets status 200 (httplib.h:3401), which breaks <audio> seek logic; a
//     route that leaves res.status unset gets `req.ranges.empty() ? 200 : 206` for free
//     (httplib.h:3698). This is the whole reason §3 chose a route over the one-line mount.
//   * `.ogg`-only whitelist + a traversal guard (httplib's MIME map has no ogg entry anyway);
//   * Content-Type: audio/ogg;
//   * Cache-Control: max-age=31536000, immutable (install audio never changes; 350 MB of
//     re-fetches over a tunnel is the thing to avoid);
//   * a remote-play licensing gate: the OST is Bay 12's copyright. A NON-loopback peer is
//     served UNLESS the host has opted OUT via `"audio_remote": false` in
//     dfhack-config/dfcapture.json. DEFAULT ON (decision 2026-07-09): fresh installs stream
//     DF's own audio to remote/tunnel players out of the box -- an absent file, absent key, or
//     unreadable file all resolve to ON; only an explicit `false` disables. The owner accepted the
//     copyright tradeoff knowingly (Phase-8 README/license notes must state the mod streams DF's
//     own audio assets to remote players by default and how to opt out). A denied remote peer
//     (explicit opt-out) gets 403 and the client falls back to synthesized UI blips + silent music.
//
// GET /sound-info is the client's capability probe: 200 {"audio":true,"allowed":bool,
// "remote":bool} on this DLL; an OLD DLL (no route) 404s -> the client shows "host needs update"
// and stays fully functional (graceful-dormant, zero errors).
//
// The path-resolution + gate DECISION logic below is header-only + DF/httplib-free so the
// offline fixture (tools/harness/sound_route_fixture.cpp) exercises the REAL functions, not a
// mirror.

#pragma once

#include <cstddef>
#include <string>

// Forward-declare so the header doesn't drag httplib into the offline fixture TU.
namespace httplib { class Server; }

namespace dwf {
namespace sound {

// Base dir (relative to DF's cwd, same convention as the /asset mount). The whole P1+P2+P3
// serving set (tracks/ ambience/ cards/ sounds/ audio/ui/ + song_game.ogg) lives under it.
constexpr const char* kSoundBaseDir = "data/sound/";

// Result of validating a /sound/<capture> request path.
struct PathResolve {
    bool ok = false;       // true => safe to serve
    std::string rel;       // sanitized path relative to kSoundBaseDir (valid only when ok)
    int status = 404;      // suggested HTTP status when !ok (always 404 -- never leak why)
};

// Whitelist `.ogg` only + reject every traversal / escape vector. Pure; no filesystem touch.
// REJECTS (each -> {ok:false, status:404}):
//   empty; > 512 bytes; leading '/' (absolute); any control byte (<0x20, incl. NUL);
//   backslash '\' (Windows separator); colon ':' (drive letter / NTFS alternate data stream);
//   the substring ".." anywhere (parent-dir traversal, incl. dot-dot inside a segment);
//   any name whose lowercased tail is not ".ogg".
// ACCEPTS forward-slash-separated relative .ogg paths, e.g.
//   "tracks/koganusan/KG_Full.ogg", "sounds/megabeast.ogg",
//   "audio/ui/clicks/generic/click-001.ogg", "song_game.ogg".
inline PathResolve resolve_sound_path(const std::string& cap) {
    PathResolve r;
    if (cap.empty() || cap.size() > 512) return r;
    if (cap.front() == '/') return r;                       // no absolute paths
    for (char c : cap) {
        unsigned char u = static_cast<unsigned char>(c);
        if (u < 0x20) return r;                             // control chars / embedded NUL
        if (c == '\\' || c == ':') return r;                // backslash / drive / ADS
    }
    if (cap.find("..") != std::string::npos) return r;      // parent-dir traversal
    // Case-insensitive ".ogg" suffix (the only extension we ever serve).
    const std::string ext = ".ogg";
    if (cap.size() < ext.size()) return r;
    for (size_t i = 0; i < ext.size(); ++i) {
        char c = cap[cap.size() - ext.size() + i];
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        if (c != ext[i]) return r;
    }
    r.ok = true;
    r.rel = cap;
    r.status = 200;
    return r;
}

// Remote-play licensing gate. The HOST's own browser (the player who owns the game) is ALWAYS
// allowed; a remote peer only when the host opted in (audio_remote true).
inline bool remote_allowed(bool peer_is_host, bool audio_remote_cfg) {
    return peer_is_host || audio_remote_cfg;
}

// Is this request really the host's OWN browser? A bare loopback-peer test is NOT enough for a
// licensing gate: cloudflared/ngrok/ssh -L all run ON the host and connect to the origin over
// 127.0.0.1, so accept() sees loopback for every TUNNELED remote peer (adversarial-review
// finding #1 -- a locally-terminated tunnel always presents a loopback peer address).
// Distinguish them by what the tunnel adds and the browser sends:
//   * cloudflared (and every standard reverse proxy) STAMPS forwarding headers on each request
//     (X-Forwarded-For / CF-Connecting-IP); a remote user cannot strip them from outside.
//   * a remote browser's Host header is the PUBLIC tunnel hostname (xyz.trycloudflare.com),
//     never a loopback literal; the host's own tab says localhost:8765 / 127.0.0.1:8765 / [::1].
// So: host-tab iff loopback peer AND no forwarding header AND a loopback-ish Host. A LOCAL
// process could still forge all three -- but a local process already owns the install; this
// gate's threat model is the REMOTE friend on the tunnel URL, who can forge none of them.
// Pure (strings in, bool out) so the offline fixture drives the full matrix.
inline bool host_header_is_local(const std::string& host) {
    // Strip :port (careful with [::1]:port).
    std::string h = host;
    if (!h.empty() && h.front() == '[') {                 // bracketed IPv6
        size_t rb = h.find(']');
        h = (rb == std::string::npos) ? h : h.substr(1, rb - 1);
    } else {
        size_t c = h.find(':');
        if (c != std::string::npos) h = h.substr(0, c);
    }
    for (char& ch : h) if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
    if (h == "localhost" || h == "::1") return true;
    if (h.rfind("127.", 0) == 0) {                        // 127.0.0.0/8 -- IP LITERAL only:
        for (char ch : h)                                 // "127.evil.com" must NOT qualify
            if (!((ch >= '0' && ch <= '9') || ch == '.')) return false;
        return true;
    }
    return false;
}
inline bool request_is_local_host(bool peer_is_loopback, bool has_forwarded_header,
                                  const std::string& host_header) {
    return peer_is_loopback && !has_forwarded_header && host_header_is_local(host_header);
}

// Pure flat scan of a dfcapture.json body for `"audio_remote"`. DEFAULT ON (2026-07-09):
// remote players get audio out of the box, so this returns true UNLESS the config carries an
// EXPLICIT `"audio_remote": false`. Absent key, malformed value, or empty text -> true. The only
// input that yields false is a well-formed `"audio_remote"` key whose value is literally `false`.
// Header-only + pure so the offline fixture drives the on/off matrix against the REAL function.
inline bool scan_audio_remote(const std::string& text) {
    const std::string key = "\"audio_remote\"";
    size_t k = text.find(key);
    if (k == std::string::npos) return true;                // key absent -> default ON
    size_t i = k + key.size();
    while (i < text.size() && (text[i] == ' ' || text[i] == '\t')) ++i;
    if (i >= text.size() || text[i] != ':') return true;    // malformed (no colon) -> default ON
    ++i;
    while (i < text.size() && (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' ||
                              text[i] == '\n')) ++i;
    return text.compare(i, 5, "false") != 0;                // ONLY an explicit `false` disables
}

// Read the `audio_remote` bool from dfhack-config/dfcapture.json (DEFAULT ON; missing/corrupt/
// unreadable file -> true). Cheap flat scan, cached with a short TTL so a host toggle takes effect
// without a plugin reload but a burst of /sound GETs doesn't re-stat the file each time.
bool audio_remote_enabled();

} // namespace sound

// Register GET /sound/(.+) + GET /sound-info on the server. Call from register_routes().
void register_sound_route(httplib::Server& server);

} // namespace dwf
