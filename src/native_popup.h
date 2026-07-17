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

// WT28 / B218: mirror DF's native BOX announcement popups in the browser so any web player can
// read AND dismiss them -- an unattended host PC no longer wedges the fortress when a siege /
// megabeast / first-caravan BOX popup opens and hard-pauses the game.
//
// DETECTION -- ONE surface (verified against the df-structures checkout for this DF version; see
// the .cpp banner for the exact citations):
//
//   "mega" box popups -- df.global.world.status.popups (announcement_handlerst::popups, original
//   name `mega`, vector of df::popup_message* = mega_announcementst). Created by any announcement
//   whose d_init flag carries DO_MEGA (announcements.txt token BOX, documented in DF's own file
//   header as "the announcement will appear in a box and pause the game"). Vanilla v50:
//   MEGABEAST_ARRIVAL, WEREBEAST_ARRIVAL, NIGHT_ATTACK_*, UNDEAD_ATTACK, FIRST_CARAVAN_ARRIVAL,
//   MADE_ARTIFACT, ... The native UI shows popups[0]'s text (parsed into world.status.mega_text)
//   until dismissed, then advances the queue. These are genuine game-wide modals: DF sets
//   *pause_state for them, so mirroring + gating browser unpause on them is correct.
//
// NOT MIRRORED -- df.global.game.main_interface.announcement_alert (the Alerts / report /
// combat-log reader window). DFHack's World::ReadPauseState() (library/modules/World.cpp) returns
// true when it is open, but that helper returns true for a LONG list of purely-local host screens
// in the same expression -- info.open, stocks.open, trade.open, squads dialogs, create_work_order,
// petitions, ... -- so "ReadPauseState is true" does NOT mean "the sim is globally wedged" and
// does NOT make a surface a shared modal. Native DF does not globally pause the sim when the host
// opens the Alerts window or a combat report. Treating it as a shared modal was the B-popup bug:
// the host clicking any announcement / combat report broadcast a bogus "Alerts / (no text)" modal
// to every browser, wrongly refused browser unpause, and let any browser close the host's local
// window (announcement_alert.open = false). It is host-local UI; opening, browsing, or closing it
// raises NO browser popup, blocks nothing, and is never reachable by the dismissal route. Ordinary
// announcements + combat reports keep flowing through the browser notification and combat-log
// pipelines, which this module does not touch.
//
// popup_push_tick() samples the BOX queue at <=1 Hz under a ConditionalCoreSuspender (the
// vote_push_tick posture: skips instantly while the core is save-blocked, keeping the previous
// snapshot), diffs against the mirrored set, and on change broadcasts to every live socket:
//
//   {"type":"popup","seq":N,"blocked":<bool>[,"by":"<player>"],
//    "popups":[{"id":I,"kind":"mega","typeKey":"","title":"...",
//               "text":["line",...],"pauses":<bool>}]}
//
// ("kind"/"typeKey" are retained on the wire for client/schema stability; only "mega" is emitted.)
// Empty `popups` = all clear. Sticky for late joiners: once seq > 0, players who have not seen
// the current state get it pushed on join/reconnect (vote.cpp g_synced pattern). Ids are
// plugin-assigned monotonic ints -- a re-fired siege is a NEW entry and gets a FRESH id, never a
// resurrected one.
//
// DISMISSAL (POST /popup/dismiss?player=&id=): performs the same state transition DF's own
// dismissal performs (pop the front of world.status.popups, re-parse mega_text) -- never a blanket
// ESC injection, never a camera move, and never a write to announcement_alert. Idempotent per id:
// a second concurrent click is a no-op {"ok":true,"already":true}. Scope: acknowledge-only BOX
// popups; the diplomacy CHOICE dialog stays owned by vote.cpp (WT14) and is not touched here.
//
// The forced pause is KEPT (a siege pausing the game is good signal); while any BOX popup is
// mirrored, popup_blocked() is true, /diag reports "popupBlocked":true, and the pause arbiter
// refuses web unpause with a clear reason so the client can explain instead of appearing broken.
// popup_blocked() reflects ONLY the BOX queue -- an open host Alerts window never sets it.

// Routes: GET /popup (current mirrored state; mutex-only cache read) and POST /popup/dismiss.
void register_popup_routes(httplib::Server& server);

// Called once per ws_push_loop iteration (after vote_push_tick): sample, diff, broadcast,
// late-join sync.
void popup_push_tick();

// True while any native popup is mirrored (set by the sample tick / dismissal; atomic read --
// safe from any thread). The pause arbiter consults this to refuse unpause while blocked, and
// /diag exposes it as "popupBlocked".
bool popup_blocked();

// B288/B289 round 4: turn DF's markup text grammar into display text without discarding the raw
// source. Art prose banking keeps the original string (including [C:f:b:br] colour tokens) and
// uses this shared parser for its plain-text companion. This is the same grammar the native popup
// mirror consumes; keeping one parser prevents the two DF-authored text paths from drifting.
std::string native_markup_plain_text(const std::string& raw);

} // namespace dwf
