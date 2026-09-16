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

#include "save_barrier.h"

#include "DataDefs.h"
#include "diagnostics.h"
#include "modules/Gui.h"

#include "df/gamest.h"
#include "df/global_objects.h"
#include "df/plotinfost.h"
#include "df/viewscreen_export_regionst.h"
#include "df/viewscreen_savegamest.h"

#include <atomic>

namespace dwf {
namespace {

std::atomic<bool> g_active{false};
int g_clear_frames = 0; // core thread only

bool df_still_saving() {
    if (df::global::plotinfo && df::global::plotinfo->main.autosave_request)
        return true;
    if (df::global::game && df::global::game->main_interface.options.do_manual_save)
        return true;
    df::viewscreen* screen = DFHack::Gui::getCurViewscreen(true);
    return strict_virtual_cast<df::viewscreen_savegamest>(screen) ||
           strict_virtual_cast<df::viewscreen_export_regionst>(screen);
}

} // namespace

void save_barrier_begin() {
    g_clear_frames = 0;
    if (!g_active.exchange(true))
        diagnostics_log("SAVE-BARRIER engaged; browser world operations are blocked");
}

void save_barrier_update() {
    if (!g_active.load()) return;
    if (df_still_saving()) {
        g_clear_frames = 0;
        return;
    }
    // Do not reopen on the first post-save callback: DF can finish writing before its transient
    // save bookkeeping is retired, and a browser world write inside that window crashes DF.
    if (++g_clear_frames < 3) return;
    g_clear_frames = 0;
    g_active.store(false);
    diagnostics_log("SAVE-BARRIER cleared after completed save cleanup");
}

bool save_barrier_active() {
    return g_active.load();
}

void save_barrier_reset() {
    g_clear_frames = 0;
    g_active.store(false);
}

} // namespace dwf
