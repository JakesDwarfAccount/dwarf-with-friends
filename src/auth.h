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

#pragma once

#include <string>

namespace dwf {
namespace auth {

// An empty (or all-whitespace) passphrase DISABLES auth entirely. Thread-safe.
void set_password(const std::string& passphrase);

bool enabled();

// Returns FALSE when auth is disabled, so callers must gate on enabled() first.
bool check(const std::string& candidate);

// relative to DF's working directory
constexpr const char* kPasswordFile = "dfcapture_join_password.txt";

// The durable half only: without a matching set_password() the change is not live until reload.
bool persist_password(const std::string& passphrase, std::string* err);

// ---- version-mismatch gate: "<wire-crc-hex>-<git-short>" ------------------------------------
// The CRC half is binary-wire identity; the git half catches a stale tab holding old JS.
std::string build_stamp();

std::string git_hash();

// `extra_fields` is spliced verbatim before the closing brace, so it MUST carry its own leading
// comma and key (e.g. ",\"palette\":[[0,0,0],...]"); `assets` is emitted only when non-empty.
std::string version_json(const std::string& assets = std::string(),
                         const std::string& extra_fields = std::string());

} // namespace auth
} // namespace dwf
