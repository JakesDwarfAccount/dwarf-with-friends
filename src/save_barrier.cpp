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
    // Do not reopen on the first post-save callback. DF can finish writing before all of its
    // transient save bookkeeping has been retired; three completed core updates are cheap and
    // close the exact end-of-save race seen in crash_2026-07-19-21-06-46.
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
