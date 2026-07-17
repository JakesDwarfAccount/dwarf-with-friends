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

// Premium-sprite lookup for the browser tile renderer.
//
// Returns a cached JSON object mapping a tiletype/graphics TOKEN -> the sheet
// PNG + cell it lives on:  {"<TOKEN>":{"sheet":"floors.png","col":1,"row":1}, ...}
//
// Built once (magic-static, thread-safe) by parsing DF's OWN graphics raws,
// relative to the plugin CWD (the DF root):
//   data/vanilla/vanilla_environment/graphics/{tile_page_*.txt, graphics_*.txt}
//   data/vanilla/vanilla_plants_graphics/graphics/{tile_page_*.txt, graphics_*.txt}
// tile_page_*.txt supplies each TILE_PAGE's FILE (png) + dims; graphics_*.txt
// supplies the [TILE_GRAPHICS:PAGE:col:row:TOKEN] cell bindings.
//
// Keys are the graphics-file TOKEN as-is (e.g. "STONE_FLOOR_5", "BOULDER").
// Where a token's PascalCase form is a valid df::tiletype ENUM KEY (matching the
// client's wire "ttname"), an extra alias entry under that enum key is emitted
// too, so ttname lookups resolve directly. Tokens whose TILE_PAGE has no known
// FILE are skipped. Missing files -> "{}" (never throws / crashes).
const std::string& sprite_map_json();

} // namespace dwf
