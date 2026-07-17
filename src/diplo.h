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

namespace dwf {

// B225 / DIPLO-PETITIONS: the browser-side DETECTOR for petitions + diplomacy, and the
// diplomacy-meeting mirror.
//
// Native shows two left-rail attention plaques (vanilla_interface graphics_interface.txt:
// PETITIONS_LIGHT and DIPLOMACY_LIGHT, both TILE_GRAPHICS_RECTANGLE 3x3 on INTERFACE_BITS)
// when a petition awaits a decision or a diplomat meeting is pending/underway. The browser
// had NEITHER: the B188 petitions screen existed but nothing ever lit up or opened it, and
// the diplomacy meeting existed only on the host's physical screen.
//
// DETECTION (df-structures citations in the .cpp banner):
//   * petitionsPending  -- df.global.plotinfo.petitions.size() (the unapproved-agreement
//     list; the exact vector /petition-accept and /petition-deny mutate in fort_admin.cpp).
//   * meetingsQueued    -- df.global.plotinfo.dipscript_popups.size() ("cause
//     viewscreen_meetingst to pop up" per df-structures: a diplomat has reached the noble
//     and the meeting dialog is available/queued on the host).
//   * open + meeting {} -- df.global.game.main_interface.diplomacy (diplomacy_interfacest):
//     the live meeting dialog. Sim-blocking per DFHack World::ReadPauseState()
//     (library/modules/World.cpp: `game->main_interface.diplomacy.open`).
//
// diplo_push_tick() samples all of it at <=1 Hz under a ConditionalCoreSuspender (the
// vote/popup posture) and broadcasts ON CHANGE ONLY (AUX growth policy: delta story = this
// frame is edge-triggered, never per-tick):
//
//   {"type":"diplo","seq":N,"petitionsPending":N,"meetingsQueued":N,"open":<bool>
//    [,"by":"<player>"],"meeting":null|{...}}   -- full shape in diplo.cpp's banner.
//
// Sticky for late joiners: once seq > 0, players who have not seen the current state get it
// on join/reconnect (vote.cpp g_synced pattern), so a reconnecting tab never keeps a stale
// plaque or meeting screen.
//
// CHOICES: the export-agreement priorities (the one meeting choice whose native mutation is
// PROVEN data-only -- DFHack's own tradeagreement.lua overlay writes
// dipev.sell_requests.priority[cat][i] while the native Requests screen is open) are
// writable via POST /diplo-request-priority. The meeting ADVANCE (the "Okay" button), the
// land-holder pick, and the Requests "Done" commit are HOST-NATIVE in v1: their native
// mutations run through the dipscript VM in the DF binary and cannot be reproduced from
// static evidence -- the wire says so ("advanceHostNative":true) and the client renders an
// honest placeholder. See the DIPLO-PETITIONS closeout's screenshot/experiment request list.
//
// CAMERA IS NEVER TOUCHED (B216 rule). No ESC injection, no cur_step poking, no mm->flags
// writes -- a corrupted dipscript state could break agreements for the whole world.

// Routes: GET /diplo (current mirrored state; mutex-only cache read) and
// POST /diplo-request-priority?player=&cat=&index=&value=0..4.
void register_diplo_routes(httplib::Server& server);

// Called once per ws_push_loop iteration (after popup_push_tick): sample, diff, broadcast,
// late-join sync.
// ★ 2026-07-14 (B234): briefly disabled on a hunch after the heap-corruption crash, then
//   RE-ENABLED once the audit proved it structurally incapable of causing one:
//   sample_native_suspended() is 100% READS under a CoreSuspender (diplo.cpp:169-253), and
//   a read cannot raise STATUS_HEAP_CORRUPTION (0xc0000374) -- it raises an access violation
//   (0xC0000005). The real defect was a double-free of a DF-owned df::popup_message
//   (native_popup.cpp), now fixed. Kept as a switch so the detector can be cut instantly if
//   it is ever implicated again.
inline constexpr bool kDiploTickEnabled = true;

void diplo_push_tick();

// True while the native diplomacy meeting dialog is open (atomic; safe from any thread).
// The pause arbiter consults this to refuse web unpause with a clear reason while the sim
// is wedged by the meeting, and /diag exposes it as "diploBlocked".
bool diplo_meeting_open();

} // namespace dwf
