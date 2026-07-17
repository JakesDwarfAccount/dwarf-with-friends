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

#include <string>

namespace dwf {

// B37 (rev. 2026-07-08 fix-batch #0): CRASH-SAFE native menu/widget read path.
//
// PROBLEM: reading df.global.game.main_interface.building.{button,filtered_button} crashes DF
// with virtual_cast/text() on freed-and-reused button memory. It crashed via RPC lua
// (dfhack-run) on 2026-07-08 (06:57 + 07:32, RunCoreQueryLoop->Lua::SafeCall->stl_string_identity)
// even though that path runs UNDER CoreSuspender (DFHack RemoteServer.cpp:353-361 +
// LuaTools.cpp:1210), AND crashed AGAIN via the B37 render-thread snapshot (crashes #4/#5,
// `Class not in symbols.xml: 'std::_Associated_state<int>'` / `'dummy'`). The B37 claim that a
// render-thread copy is "safe by construction" was empirically FALSE. Together the two crash
// classes prove mutation windows exist on BOTH DF threads: neither the sim-suspended context nor
// the render-thread context alone is safe.
//
// FIX: quiesce BOTH DF threads across the copy, in the LAW-compliant order (never wait on a
// render hop while core-suspended -- hud.cpp:327): (1) PARK the render thread in a trivial
// runOnRenderThread callback that holds no DF state and no DFHack lock, (2) acquire the core
// suspension on the httplib worker thread with BOUNDED ConditionalCoreSuspender attempts, (3)
// read + serialize on the worker thread while both DF threads are provably excluded, (4) release
// the park with a non-blocking notify. A missed window degrades to HTTP 503 (caller retries) --
// it can never wedge DF. Full threading-evidence dossier + deadlock argument: menu_oracle.cpp.
//
// Post-fix the route is safe under continuous polling during live menu navigation (that is its
// purpose); each read costs the sim thread ~one suspend hold (sub-ms build) and the render
// thread ~10-30ms park. Snapshots are internally consistent; the additive "in_transition" field
// tags the legitimate cross-frame state `active_id == -1 with button rows` so recorders can skip
// transition states.
//
// Output schema is byte-compatible with menu_oracle.lua's "truemenu-oracle-v1" so
// gate_truemenu.py --oracle and the 29 captures in results/truemenu-native consume it unchanged
// (one caveat: this route emits UTF-8 like every other dwf route, whereas the lua tool
// emitted raw CP437 -- see the migration note in the closeout / spec). Post-2026-07-08 additions
// are ADDITIVE only: "in_transition" (bool) + the X-Menu-Oracle-Quiesce response header.
void register_menu_oracle_routes(httplib::Server& server);

} // namespace dwf
