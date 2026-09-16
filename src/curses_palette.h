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

// The home for DF's live 16-color curses palette (gps->uccolor): every curses index -> RGB read
// belongs here, never a hardcoded copy -- the player is free to edit the palette.
namespace dwf {
namespace curses {

constexpr int kColors = 16;

struct Rgb { int r; int g; int b; };

// False when gps is unavailable or the index is out of range; a caller must then leave the bytes
// alone or ship an empty palette, never substitute an invented color.
bool rgb(int index, Rgb& out);

// The palette as a JSON array literal: "[[r,g,b],[r,g,b],...]" (16 entries) or "[]" when gps is
// unavailable. Ready to splice into a response body.
std::string palette_json();

} // namespace curses
} // namespace dwf
