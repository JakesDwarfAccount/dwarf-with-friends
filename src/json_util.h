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

#include "httplib.h"

#include <sstream>
#include <string>
#include <vector>

namespace dwf {

// WAVE-4 C++ WIRE BATCH build stamp. Emitted as an additive `"wireBatch"` field on every payload
// this batch touched (/kitchen, /stock-item-action, /unit, /justice) so the DLL can be PROVEN to
// contain the batch without trusting cmake's exit code (AGENTS.md "THIS MACHINE LIES WITH EXIT 0"):
//   grep the built dwf.plug.dll for this exact literal.
// It is a string constant, not a log line -- it costs nothing on any per-frame path.
constexpr const char* kWireBatchMarker = "dwf-wire-batch-W4-20260712";

bool query_int(const httplib::Request& req, const char* name, int& value);
bool is_safe_player_id(const std::string& player);
std::string query_player(const httplib::Request& req);

std::string json_escape(const std::string& raw);
std::string json_string(const std::string& raw);
void append_json_string_array(std::ostringstream& body, const std::vector<std::string>& values);

} // namespace dwf
