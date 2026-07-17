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

// auth.h -- JOIN SECURITY (ship-blocker, PROJECT-CLOSEOUT Phase 5).
//
// Friends-tier shared-passphrase gate. NO accounts, NO sessions DB, NO crypto handshake:
// the host sets ONE shared passphrase; every web client that wants to issue orders presents
// that passphrase (typed once on the join screen, then remembered by the browser) as its
// credential on the WS hello and on every mutating HTTP request. The server constant-time
// compares it to the configured passphrase. Because the credential IS the (stable) passphrase,
// a page refresh or even a server restart needs no re-auth -- the stored credential keeps
// working as long as the host doesn't change the passphrase.
//
// Default: no passphrase set => auth DISABLED => the current wide-open behavior (dev-friendly),
// with a loud "no join password set" warning logged at server start. The ship default should be
// passphrase-ON (see docs).
//
// VERSION-MISMATCH GATE lives here too (same "what build is this" concern): build_stamp() is the
// wire CRC + git short hash the client compares against its own baked stamp to detect a stale tab
// after a deploy.

#pragma once

#include <string>

namespace dwf {
namespace auth {

// Set (or clear) the shared join passphrase. Leading/trailing whitespace is trimmed; an empty
// (or all-whitespace) value DISABLES auth (wide-open). Thread-safe.
void set_password(const std::string& passphrase);

// True iff a non-empty passphrase is configured (auth is enforced).
bool enabled();

// Constant-time check of a client-presented credential against the configured passphrase.
// Returns false when auth is disabled (callers gate on enabled() first; a disabled server never
// rejects). Constant-time in the compared bytes so a lazy attacker can't time-oracle the secret.
bool check(const std::string& candidate);

// The on-disk join-password file, relative to DF's working directory. Single source of truth for
// the filename: the console command's `reload` reads it (dwf.cpp) and the host-only
// POST /join-password route persists to it via persist_password() so a UI-set passphrase
// survives a DF restart.
constexpr const char* kPasswordFile = "dfcapture_join_password.txt";

// Persist `passphrase` to kPasswordFile (trimmed; empty => an empty file => auth DISABLED on the
// next load). Returns false and sets *err on a write failure. In-memory state is applied
// separately via set_password(); the host /join-password route calls both so the change is both
// live and durable. Best-effort persistence: a caller may still choose to proceed on failure.
bool persist_password(const std::string& passphrase, std::string* err);

// ---- version-mismatch gate ---------------------------------------------------------------
// The build identity the client compares against its own baked window.DFCAPTURE_BUILD. Format:
// "<wire-crc-hex>-<git-short>" e.g. "0x538dea9c-23092973d". The CRC half is the wire-protocol
// identity (a mismatch there means incompatible binary wire); the git half is the deploy identity
// (a mismatch there means a stale browser tab holding old JS after a redeploy).
std::string build_stamp();

// The git short hash baked at build time (DFCAPTURE_GIT_HASH; "dev" when unavailable, e.g. a
// git-archive mirror build).
std::string git_hash();

// JSON body for GET /version: {"crc":"0x...","git":"...","build":"...","authRequired":bool
// [,"assets":"..."][,<extra_fields>]}. `assets` (the soft-tier buster fingerprint) is appended
// only when non-empty; it's computed by the caller (http_server) from the served index.html.
// `extra_fields`, when non-empty, is spliced verbatim before the closing brace as additional
// top-level members -- it MUST begin with the leading comma and key (e.g.
// ",\"palette\":[[0,0,0],...]"). This keeps DF-specific payloads (the curses palette handshake,
// text-color spec §3.2) out of the auth module: the route builds them and passes them in.
std::string version_json(const std::string& assets = std::string(),
                         const std::string& extra_fields = std::string());

} // namespace auth
} // namespace dwf
