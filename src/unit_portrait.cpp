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

#include "unit_portrait.h"
#include "render_thread_wait.h"

#include "diagnostics.h"
#include "save_barrier.h"
#include "sdl_capture.h"
#include "modules/DFSDL.h"
#include "modules/Gui.h"

#include "df/enabler.h"
#include "df/global_objects.h"
#include "df/graphic.h"
#include "df/renderer.h"
#include "df/unit.h"
#include "df/unit_flags4.h"
#include "df/viewscreen.h"
#include "df/widget_unit_portrait.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <cstdlib>
#endif

#include <algorithm>
#include <atomic>
#include <cstring>
#include <future>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <vector>

namespace dwf {
namespace {

constexpr uint32_t SDL_PIXELFORMAT_ARGB8888 = 0x16362004u;
constexpr int SDL_TEXTUREACCESS_TARGET = 2;

struct SDLSurfaceLite {
    uint32_t flags;
    void* format;
    int w;
    int h;
    int pitch;
    void* pixels;
    void* userdata;
    int locked;
    void* list_blitmap;
    struct { int x, y, w, h; } clip_rect;
    void* map;
    int refcount;
};

using pfn_CreateTexture = void* (*)(void*, uint32_t, int, int, int);
using pfn_SetRenderTarget = int (*)(void*, void*);
using pfn_RenderReadPixels = int (*)(void*, const void*, uint32_t, void*, int);
using pfn_DestroyTexture = void (*)(void*);
using pfn_GetRendererOutputSize = int (*)(void*, int*, int*);
using pfn_SetRenderDrawColor = int (*)(void*, uint8_t, uint8_t, uint8_t, uint8_t);
using pfn_RenderClear = int (*)(void*);
using pfn_ConvertSurfaceFormat = void* (*)(void*, uint32_t, uint32_t);
using pfn_LockSurface = int (*)(void*);
using pfn_UnlockSurface = void (*)(void*);
using pfn_FreeSurface = void (*)(void*);

#ifdef _WIN32
pfn_CreateTexture p_CreateTexture = nullptr;
pfn_SetRenderTarget p_SetRenderTarget = nullptr;
pfn_RenderReadPixels p_RenderReadPixels = nullptr;
pfn_DestroyTexture p_DestroyTexture = nullptr;
pfn_GetRendererOutputSize p_GetRendererOutputSize = nullptr;
pfn_SetRenderDrawColor p_SetRenderDrawColor = nullptr;
pfn_RenderClear p_RenderClear = nullptr;
#endif
pfn_ConvertSurfaceFormat p_ConvertSurfaceFormat = nullptr;
pfn_LockSurface p_LockSurface = nullptr;
pfn_UnlockSurface p_UnlockSurface = nullptr;
pfn_FreeSurface p_FreeSurface = nullptr;

std::atomic<bool> g_warned_portrait_diag(false);
std::atomic<bool> g_warned_portrait_widget_success(false);
std::atomic<bool> g_warned_portrait_widget_fail(false);

// ---- native portrait generator (exe-pinned direct call) --------------------------------------
//
// Steam DF fills unit->portrait_texpos lazily: every native display site (unit sheet,
// announcement popups, ...) runs `if (portrait_texpos == 0 || flags4.portrait_must_be_refreshed)
// generate(unit);` before drawing. That generator is a self-contained one-argument routine: it
// picks the caste's PORTRAIT-flagged creature-graphics entry, composes the 96x96 bust into a new
// SDL surface registered with DF's texture handler, invalidates the renderer's cached tiles for
// any texpos it replaces, and stores the fresh index in unit->portrait_texpos. It never touches
// view_sheets, the interface grid, or any render target, so calling it cannot flash the host UI.
// (Binary evidence: rules-ledger entry 0005-unit-portrait-generation.)
//
// The call is pinned to the exact game build: both the wrapper and the compositor it invokes
// must match their recorded prologue bytes at the recorded image offsets, or generation reports
// itself unavailable and the browser keeps its explicit sprite fallback. Any native fault during
// a call latches generation off for the rest of the session.
constexpr uintptr_t NATIVE_PORTRAIT_GEN_RVA = 0x1b9610;         // generate-unit-graphics(unit)
constexpr uint8_t NATIVE_PORTRAIT_GEN_SIG[32] = {
    0x48, 0x89, 0x5c, 0x24, 0x10, 0x48, 0x89, 0x6c, 0x24, 0x18, 0x48, 0x89, 0x74, 0x24, 0x20,
    0x57, 0x41, 0x54, 0x41, 0x55, 0x41, 0x56, 0x41, 0x57, 0x48, 0x81, 0xec, 0xa0, 0x00, 0x00,
    0x00, 0x48,
};
constexpr uintptr_t NATIVE_PORTRAIT_COMPOSITOR_RVA = 0x71c610;  // bust compositor (5 args)
constexpr uint8_t NATIVE_PORTRAIT_COMPOSITOR_SIG[32] = {
    0x48, 0x8b, 0xc4, 0x55, 0x53, 0x56, 0x57, 0x41, 0x54, 0x41, 0x55, 0x41, 0x56, 0x41, 0x57,
    0x48, 0x8d, 0xa8, 0xf8, 0xfb, 0xff, 0xff, 0x48, 0x81, 0xec, 0xc8, 0x04, 0x00, 0x00, 0x0f,
    0x29, 0x70,
};

std::atomic<bool> g_native_gen_faulted(false);
std::mutex g_native_gen_resolve_mu;
bool g_native_gen_resolved = false;
void* g_native_gen_fn = nullptr;
std::string g_native_gen_unavailable_reason;

using pfn_native_portrait_gen = void (*)(df::unit*);

bool resolve_native_generator_locked() {
#ifdef _WIN32
    HMODULE exe = GetModuleHandleA(nullptr);
    if (!exe) {
        g_native_gen_unavailable_reason = "could not resolve the game module";
        return false;
    }
    auto base = reinterpret_cast<const uint8_t*>(exe);
    if (std::memcmp(base + NATIVE_PORTRAIT_GEN_RVA, NATIVE_PORTRAIT_GEN_SIG,
                    sizeof(NATIVE_PORTRAIT_GEN_SIG)) != 0 ||
        std::memcmp(base + NATIVE_PORTRAIT_COMPOSITOR_RVA, NATIVE_PORTRAIT_COMPOSITOR_SIG,
                    sizeof(NATIVE_PORTRAIT_COMPOSITOR_SIG)) != 0) {
        g_native_gen_unavailable_reason =
            "unsupported Dwarf Fortress binary (portrait generator signature mismatch)";
        diagnostics_log("DIAG portrait native generator UNAVAILABLE: signature mismatch; "
                        "browser sprite fallback stays active");
        return false;
    }
    g_native_gen_fn = const_cast<uint8_t*>(base) + NATIVE_PORTRAIT_GEN_RVA;
    // PORTRAIT-NATIVE-DIRECT rva=1b9610 -- unique deploy witness for this mechanism.
    diagnostics_log("DIAG portrait native generator pinned (PORTRAIT-NATIVE-DIRECT rva=1b9610)");
    return true;
#else
    g_native_gen_unavailable_reason = "native portrait generation is Windows-only";
    return false;
#endif
}

bool native_generator_ready(std::string* why) {
    std::lock_guard<std::mutex> lock(g_native_gen_resolve_mu);
    if (!g_native_gen_resolved) {
        g_native_gen_resolved = true;
        resolve_native_generator_locked();
    }
    if (!g_native_gen_fn && why)
        *why = g_native_gen_unavailable_reason;
    return g_native_gen_fn != nullptr;
}


#ifdef _WIN32
volatile uint32_t g_seh_code = 0;
void* g_seh_at = nullptr;
void* g_seh_access = nullptr;

int seh_filter(_EXCEPTION_POINTERS* ep) {
    g_seh_code = ep && ep->ExceptionRecord ? ep->ExceptionRecord->ExceptionCode : 0;
    g_seh_at = ep && ep->ExceptionRecord ? ep->ExceptionRecord->ExceptionAddress : nullptr;
    g_seh_access = (ep && ep->ExceptionRecord && ep->ExceptionRecord->NumberParameters >= 2)
        ? reinterpret_cast<void*>(ep->ExceptionRecord->ExceptionInformation[1])
        : nullptr;
    return EXCEPTION_EXECUTE_HANDLER;
}

constexpr DWORD DWF_INVALID_PARAMETER_EXCEPTION = 0xE0424643u;

void __cdecl invalid_parameter_handler(const wchar_t*, const wchar_t*,
                                       const wchar_t*, unsigned int, uintptr_t) {
    RaiseException(DWF_INVALID_PARAMETER_EXCEPTION, EXCEPTION_NONCONTINUABLE, 0, nullptr);
}

int call_native_portrait_generator_seh(void* fn, df::unit* unit) {
    __try {
        reinterpret_cast<pfn_native_portrait_gen>(fn)(unit);
        return 0;
    } __except (seh_filter(GetExceptionInformation())) {
        return 1;
    }
}

int call_widget_seh(df::widget_unit_portrait* widget) {
    int stage = 0;
    int result = 0;
    _invalid_parameter_handler old_handler =
        _set_thread_local_invalid_parameter_handler(invalid_parameter_handler);
    __try {
        stage = 1; widget->arrange();
        stage = 2; widget->logic();
        stage = 3; widget->render(0);
    } __except(seh_filter(GetExceptionInformation())) {
        result = stage;
    }
    _set_thread_local_invalid_parameter_handler(old_handler);
    return result;
}

int call_viewscreen_logic_seh(df::viewscreen* viewscreen) {
    int result = 0;
    __try {
        viewscreen->logic();
    } __except(seh_filter(GetExceptionInformation())) {
        result = 1;
    }
    return result;
}

int call_viewscreen_render_seh(df::viewscreen* viewscreen) {
    int result = 0;
    _invalid_parameter_handler old_handler =
        _set_thread_local_invalid_parameter_handler(invalid_parameter_handler);
    __try {
        viewscreen->render(0);
    } __except(seh_filter(GetExceptionInformation())) {
        result = 1;
    }
    _set_thread_local_invalid_parameter_handler(old_handler);
    return result;
}
#endif

bool resolve_sdl(std::string* err = nullptr) {
#ifdef _WIN32
    HMODULE sdl = GetModuleHandleA("SDL2.dll");
    if (!sdl) {
        if (err) *err = "SDL2.dll is not loaded";
        return false;
    }

    p_CreateTexture = reinterpret_cast<pfn_CreateTexture>(GetProcAddress(sdl, "SDL_CreateTexture"));
    p_SetRenderTarget = reinterpret_cast<pfn_SetRenderTarget>(GetProcAddress(sdl, "SDL_SetRenderTarget"));
    p_RenderReadPixels = reinterpret_cast<pfn_RenderReadPixels>(GetProcAddress(sdl, "SDL_RenderReadPixels"));
    p_DestroyTexture = reinterpret_cast<pfn_DestroyTexture>(GetProcAddress(sdl, "SDL_DestroyTexture"));
    p_GetRendererOutputSize = reinterpret_cast<pfn_GetRendererOutputSize>(GetProcAddress(sdl, "SDL_GetRendererOutputSize"));
    p_SetRenderDrawColor = reinterpret_cast<pfn_SetRenderDrawColor>(GetProcAddress(sdl, "SDL_SetRenderDrawColor"));
    p_RenderClear = reinterpret_cast<pfn_RenderClear>(GetProcAddress(sdl, "SDL_RenderClear"));
    p_ConvertSurfaceFormat = reinterpret_cast<pfn_ConvertSurfaceFormat>(GetProcAddress(sdl, "SDL_ConvertSurfaceFormat"));
    p_LockSurface = reinterpret_cast<pfn_LockSurface>(GetProcAddress(sdl, "SDL_LockSurface"));
    p_UnlockSurface = reinterpret_cast<pfn_UnlockSurface>(GetProcAddress(sdl, "SDL_UnlockSurface"));
    p_FreeSurface = reinterpret_cast<pfn_FreeSurface>(GetProcAddress(sdl, "SDL_FreeSurface"));

    if (p_CreateTexture && p_SetRenderTarget && p_RenderReadPixels &&
        p_DestroyTexture && p_GetRendererOutputSize && p_SetRenderDrawColor &&
        p_RenderClear && p_ConvertSurfaceFormat && p_LockSurface &&
        p_UnlockSurface && p_FreeSurface) {
        return true;
    }

    if (err) *err = "could not resolve SDL2 portrait surface/render-target functions";
    return false;
#else
    if (err) *err = "native portrait rendering is Windows-only";
    return false;
#endif
}

#ifdef _WIN32
class TemporaryRenderTarget {
public:
    bool begin(std::string* err = nullptr, int requested_w = 0, int requested_h = 0) {
        if (!resolve_sdl(err))
            return false;

        auto enabler = df::global::enabler;
        auto renderer = enabler ? enabler->renderer : nullptr;
        if (!renderer) {
            if (err) *err = "portrait target: no renderer";
            return false;
        }

        sdl_ = renderer->get_renderer();
        if (!sdl_) {
            if (err) *err = "portrait target: get_renderer returned null";
            return false;
        }

        int w = 0;
        int h = 0;
        p_GetRendererOutputSize(sdl_, &w, &h);
        if (requested_w > 0) w = requested_w;
        if (requested_h > 0) h = requested_h;
        if (w <= 0 || h <= 0) {
            if (err) *err = "portrait target: bad renderer output size";
            return false;
        }

        target_ = p_CreateTexture(sdl_, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_TARGET, w, h);
        if (!target_) {
            if (err) *err = "portrait target: SDL_CreateTexture failed";
            return false;
        }
        if (p_SetRenderTarget(sdl_, target_) != 0) {
            p_DestroyTexture(target_);
            target_ = nullptr;
            if (err) *err = "portrait target: SDL_SetRenderTarget failed";
            return false;
        }

        w_ = w;
        h_ = h;
        active_ = true;
        return true;
    }

    bool clear(std::string* err = nullptr) {
        if (!active_ || !sdl_) {
            if (err) *err = "portrait target: target inactive";
            return false;
        }
        if (p_SetRenderDrawColor(sdl_, 0, 0, 0, 0) != 0 || p_RenderClear(sdl_) != 0) {
            if (err) *err = "portrait target: SDL_RenderClear failed";
            return false;
        }
        return true;
    }

    bool read_frame(CapturedFrame& frame, std::string* err = nullptr) {
        if (!active_ || !sdl_ || w_ <= 0 || h_ <= 0) {
            if (err) *err = "portrait target: target inactive";
            return false;
        }
        CapturedFrame next;
        next.width = w_;
        next.height = h_;
        next.bgra.resize(static_cast<size_t>(w_) * h_ * 4);
        int rc = p_RenderReadPixels(sdl_, nullptr, SDL_PIXELFORMAT_ARGB8888,
                                    next.bgra.data(), w_ * 4);
        if (rc != 0) {
            if (err) *err = "portrait target: SDL_RenderReadPixels failed";
            return false;
        }
        frame = std::move(next);
        return true;
    }

    void reset() {
        if (active_ && sdl_)
            p_SetRenderTarget(sdl_, nullptr);
        active_ = false;
        if (target_) {
            p_DestroyTexture(target_);
            target_ = nullptr;
        }
        sdl_ = nullptr;
        w_ = 0;
        h_ = 0;
    }

    ~TemporaryRenderTarget() {
        reset();
    }

private:
    void* sdl_ = nullptr;
    void* target_ = nullptr;
    int w_ = 0;
    int h_ = 0;
    bool active_ = false;
};

// widget_unit_portrait::render() composes the native portrait texture and writes its texpos into
// DF's interface grid. It does not paint SDL directly, which is why the former temporary-target
// readback was blank for nearly every unit. Snapshot the small POD grid, let the native widget run,
// recover only texpos values it added, then restore the host grid byte-for-byte. Unlike the retired
// recursive sheet generator, this never opens or rewrites the owning sheet interface and never copies an
// owning DF structure.
template <typename T>
struct GridPlaneSnapshot {
    T* ptr = nullptr;
    std::vector<T> data;

    bool capture(T* source, size_t count) {
        if (!source)
            return false;
        ptr = source;
        data.assign(source, source + count);
        return true;
    }

    bool same(const T* current) const { return current == ptr; }
    void restore() const { std::copy(data.begin(), data.end(), ptr); }
};

class InterfaceGridSnapshot {
public:
    explicit InterfaceGridSnapshot(df::graphic* gps) : gps_(gps) {
        if (!gps_ || gps_->dimx <= 0 || gps_->dimy <= 0)
            return;
        dimx_ = gps_->dimx;
        dimy_ = gps_->dimy;
        cells_ = static_cast<size_t>(dimx_) * static_cast<size_t>(dimy_);
        if (!screen_.capture(gps_->screen, cells_ * 8) ||
            !texpos_.capture(gps_->screentexpos, cells_) ||
            !texpos_lower_.capture(gps_->screentexpos_lower, cells_) ||
            !texpos_anchored_.capture(gps_->screentexpos_anchored, cells_) ||
            !texpos_anchored_x_.capture(gps_->screentexpos_anchored_x, cells_) ||
            !texpos_anchored_y_.capture(gps_->screentexpos_anchored_y, cells_) ||
            !texpos_flag_.capture(gps_->screentexpos_flag, cells_))
            return;

        screenx_ = gps_->screenx;
        screeny_ = gps_->screeny;
        screenf_ = gps_->screenf;
        screenb_ = gps_->screenb;
        screenbright_ = gps_->screenbright;
        use_old_16_colors_ = gps_->use_old_16_colors;
        screen_color_r_ = gps_->screen_color_r;
        screen_color_g_ = gps_->screen_color_g;
        screen_color_b_ = gps_->screen_color_b;
        screen_color_br_ = gps_->screen_color_br;
        screen_color_bg_ = gps_->screen_color_bg;
        screen_color_bb_ = gps_->screen_color_bb;
        top_in_use_ = gps_->top_in_use;

        if (top_in_use_) {
            if (!(screen_top_.capture(gps_->screen_top, cells_ * 8) &&
                texpos_top_lower_.capture(gps_->screentexpos_top_lower, cells_) &&
                texpos_top_anchored_.capture(gps_->screentexpos_top_anchored, cells_) &&
                texpos_top_.capture(gps_->screentexpos_top, cells_) &&
                texpos_top_anchored_x_.capture(gps_->screentexpos_top_anchored_x, cells_) &&
                texpos_top_anchored_y_.capture(gps_->screentexpos_top_anchored_y, cells_) &&
                texpos_top_flag_.capture(gps_->screentexpos_top_flag, cells_)))
                return;
            top_captured_ = true;
        }
        valid_ = true;
    }

    InterfaceGridSnapshot(const InterfaceGridSnapshot&) = delete;
    InterfaceGridSnapshot& operator=(const InterfaceGridSnapshot&) = delete;

    bool valid() const { return valid_; }

    std::vector<int32_t> added_texpos() const {
        std::vector<int32_t> out;
        if (!same_base_grid())
            return out;
        collect_changed(texpos_, out);
        collect_changed(texpos_lower_, out);
        collect_changed(texpos_anchored_, out);
        if (top_captured_ && same_top_grid()) {
            collect_changed(texpos_top_, out);
            collect_changed(texpos_top_lower_, out);
            collect_changed(texpos_top_anchored_, out);
        }
        return out;
    }

    void restore() {
        if (restored_ || !valid_)
            return;
        restored_ = true;
        if (!same_base_grid())
            return;

        screen_.restore();
        texpos_.restore();
        texpos_lower_.restore();
        texpos_anchored_.restore();
        texpos_anchored_x_.restore();
        texpos_anchored_y_.restore();
        texpos_flag_.restore();

        if (top_captured_ && same_top_grid()) {
            screen_top_.restore();
            texpos_top_lower_.restore();
            texpos_top_anchored_.restore();
            texpos_top_.restore();
            texpos_top_anchored_x_.restore();
            texpos_top_anchored_y_.restore();
            texpos_top_flag_.restore();
        }

        gps_->screenx = screenx_;
        gps_->screeny = screeny_;
        gps_->screenf = screenf_;
        gps_->screenb = screenb_;
        gps_->screenbright = screenbright_;
        gps_->use_old_16_colors = use_old_16_colors_;
        gps_->screen_color_r = screen_color_r_;
        gps_->screen_color_g = screen_color_g_;
        gps_->screen_color_b = screen_color_b_;
        gps_->screen_color_br = screen_color_br_;
        gps_->screen_color_bg = screen_color_bg_;
        gps_->screen_color_bb = screen_color_bb_;
        gps_->top_in_use = top_in_use_;
    }

    ~InterfaceGridSnapshot() { restore(); }

private:
    bool same_base_grid() const {
        return gps_ && gps_->dimx == dimx_ && gps_->dimy == dimy_ &&
               screen_.same(gps_->screen) && texpos_.same(gps_->screentexpos) &&
               texpos_lower_.same(gps_->screentexpos_lower) &&
               texpos_anchored_.same(gps_->screentexpos_anchored) &&
               texpos_anchored_x_.same(gps_->screentexpos_anchored_x) &&
               texpos_anchored_y_.same(gps_->screentexpos_anchored_y) &&
               texpos_flag_.same(gps_->screentexpos_flag);
    }

    bool same_top_grid() const {
        return gps_ && screen_top_.same(gps_->screen_top) &&
               texpos_top_lower_.same(gps_->screentexpos_top_lower) &&
               texpos_top_anchored_.same(gps_->screentexpos_top_anchored) &&
               texpos_top_.same(gps_->screentexpos_top) &&
               texpos_top_anchored_x_.same(gps_->screentexpos_top_anchored_x) &&
               texpos_top_anchored_y_.same(gps_->screentexpos_top_anchored_y) &&
               texpos_top_flag_.same(gps_->screentexpos_top_flag);
    }

    void collect_changed(const GridPlaneSnapshot<long>& plane,
                         std::vector<int32_t>& out) const {
        for (size_t i = 0; i < cells_; ++i) {
            const long value = plane.ptr[i];
            if (value <= 0 || value == plane.data[i] ||
                value > std::numeric_limits<int32_t>::max())
                continue;
            const int32_t texpos = static_cast<int32_t>(value);
            if (std::find(out.begin(), out.end(), texpos) == out.end())
                out.push_back(texpos);
        }
    }

    df::graphic* gps_ = nullptr;
    size_t cells_ = 0;
    int32_t dimx_ = 0;
    int32_t dimy_ = 0;
    bool valid_ = false;
    bool restored_ = false;
    bool top_captured_ = false;
    bool top_in_use_ = false;
    GridPlaneSnapshot<uint8_t> screen_;
    GridPlaneSnapshot<long> texpos_;
    GridPlaneSnapshot<long> texpos_lower_;
    GridPlaneSnapshot<long> texpos_anchored_;
    GridPlaneSnapshot<long> texpos_anchored_x_;
    GridPlaneSnapshot<long> texpos_anchored_y_;
    GridPlaneSnapshot<uint32_t> texpos_flag_;
    GridPlaneSnapshot<uint8_t> screen_top_;
    GridPlaneSnapshot<long> texpos_top_lower_;
    GridPlaneSnapshot<long> texpos_top_anchored_;
    GridPlaneSnapshot<long> texpos_top_;
    GridPlaneSnapshot<long> texpos_top_anchored_x_;
    GridPlaneSnapshot<long> texpos_top_anchored_y_;
    GridPlaneSnapshot<uint32_t> texpos_top_flag_;
    int32_t screenx_ = 0;
    int32_t screeny_ = 0;
    decltype(df::graphic::screenf) screenf_{};
    decltype(df::graphic::screenb) screenb_{};
    bool screenbright_ = false;
    bool use_old_16_colors_ = false;
    uint8_t screen_color_r_ = 0;
    uint8_t screen_color_g_ = 0;
    uint8_t screen_color_b_ = 0;
    uint8_t screen_color_br_ = 0;
    uint8_t screen_color_bg_ = 0;
    uint8_t screen_color_bb_ = 0;
};
#endif

bool copy_sdl_surface_to_frame(void* surface_ptr, CapturedFrame& frame, std::string* err = nullptr) {
    if (!surface_ptr) {
        if (err) *err = "portrait surface unavailable";
        return false;
    }
    if (!resolve_sdl(err))
        return false;

    void* converted = p_ConvertSurfaceFormat(surface_ptr, SDL_PIXELFORMAT_ARGB8888, 0);
    if (!converted) {
        if (err) *err = "SDL_ConvertSurfaceFormat failed";
        return false;
    }

    auto* surface = reinterpret_cast<SDLSurfaceLite*>(converted);
    if (surface->w <= 0 || surface->h <= 0 || surface->pitch < surface->w * 4 || !surface->pixels) {
        p_FreeSurface(converted);
        if (err) *err = "portrait surface has invalid dimensions";
        return false;
    }

    if (p_LockSurface(converted) != 0) {
        p_FreeSurface(converted);
        if (err) *err = "SDL_LockSurface failed";
        return false;
    }

    CapturedFrame next;
    next.width = surface->w;
    next.height = surface->h;
    next.bgra.resize(static_cast<size_t>(next.width) * next.height * 4);
    const auto* src = reinterpret_cast<const uint8_t*>(surface->pixels);
    for (int y = 0; y < next.height; ++y) {
        std::memcpy(next.bgra.data() + static_cast<size_t>(y) * next.width * 4,
                    src + static_cast<size_t>(y) * surface->pitch,
                    static_cast<size_t>(next.width) * 4);
    }

    p_UnlockSurface(converted);
    p_FreeSurface(converted);
    frame = std::move(next);
    return true;
}

bool frame_has_visible_pixels(const CapturedFrame& frame) {
    if (frame.width <= 0 || frame.height <= 0 || frame.bgra.empty())
        return false;
    size_t visible = 0;
    size_t sampled = 0;
    for (size_t i = 0; i + 3 < frame.bgra.size(); i += 4) {
        uint8_t b = frame.bgra[i + 0];
        uint8_t g = frame.bgra[i + 1];
        uint8_t r = frame.bgra[i + 2];
        uint8_t a = frame.bgra[i + 3];
        if (a > 8 && (static_cast<int>(r) + g + b) > 24)
            ++visible;
        ++sampled;
    }
    return sampled > 0 && visible >= std::max<size_t>(8, sampled / 200);
}

bool crop_visible_bounds(const CapturedFrame& src, CapturedFrame& dst) {
    if (src.width <= 0 || src.height <= 0 || src.bgra.empty())
        return false;

    int min_x = src.width;
    int min_y = src.height;
    int max_x = -1;
    int max_y = -1;
    for (int y = 0; y < src.height; ++y) {
        for (int x = 0; x < src.width; ++x) {
            size_t i = (static_cast<size_t>(y) * src.width + x) * 4;
            uint8_t b = src.bgra[i + 0];
            uint8_t g = src.bgra[i + 1];
            uint8_t r = src.bgra[i + 2];
            uint8_t a = src.bgra[i + 3];
            if (a > 8 && (static_cast<int>(r) + g + b) > 24) {
                min_x = std::min(min_x, x);
                min_y = std::min(min_y, y);
                max_x = std::max(max_x, x);
                max_y = std::max(max_y, y);
            }
        }
    }
    if (max_x < min_x || max_y < min_y)
        return false;

    int pad = 2;
    min_x = std::max(0, min_x - pad);
    min_y = std::max(0, min_y - pad);
    max_x = std::min(src.width - 1, max_x + pad);
    max_y = std::min(src.height - 1, max_y + pad);

    CapturedFrame cropped;
    cropped.width = max_x - min_x + 1;
    cropped.height = max_y - min_y + 1;
    cropped.bgra.resize(static_cast<size_t>(cropped.width) * cropped.height * 4);
    for (int y = 0; y < cropped.height; ++y) {
        const uint8_t* row = src.bgra.data() +
            (static_cast<size_t>(min_y + y) * src.width + min_x) * 4;
        std::memcpy(cropped.bgra.data() + static_cast<size_t>(y) * cropped.width * 4,
                    row, static_cast<size_t>(cropped.width) * 4);
    }
    dst = std::move(cropped);
    return true;
}

bool copy_texture_to_frame(df::enabler* enabler, int32_t texpos, const std::string& label,
                           CapturedFrame& frame, std::string& last_err) {
    if (!enabler) {
        last_err = "enabler unavailable";
        return false;
    }
    // DF's unset sentinel for unit texture fields is 0, not -1 (the constructor zeroes them and
    // every native display site gates on == 0). texpos 0 would index raws[0], an unrelated tile.
    if (texpos <= 0)
        return false;
    if (static_cast<size_t>(texpos) >= enabler->textures.raws.size()) {
        last_err = label + " texture out of range";
        return false;
    }

    CapturedFrame candidate;
    std::string copy_err;
    if (!copy_sdl_surface_to_frame(enabler->textures.raws[texpos], candidate, &copy_err)) {
        last_err = label + ": " + copy_err;
        return false;
    }
    if (!frame_has_visible_pixels(candidate)) {
        last_err = label + " surface is blank";
        return false;
    }
    frame = std::move(candidate);
    return true;
}

bool copy_unit_portrait_candidate(df::unit* unit, df::enabler* enabler,
                                  CapturedFrame& frame, int32_t& texpos,
                                  std::string& source, std::string& last_err,
                                  bool allow_icon_fallbacks = false) {
    if (!unit)
        return false;

    std::vector<std::pair<int32_t, std::string>> candidates;
    candidates.emplace_back(unit->portrait_texpos, "portrait");
    if (allow_icon_fallbacks) {
        candidates.emplace_back(unit->sheet_icon_texpos, "sheet-icon");
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 2; ++j) {
                if (unit->texpos_currently_in_use[i][j])
                    candidates.emplace_back(unit->texpos[i][j],
                                            "sprite-inuse-" + std::to_string(i) + std::to_string(j));
            }
        }
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 2; ++j)
                candidates.emplace_back(unit->texpos[i][j],
                                        "sprite-" + std::to_string(i) + std::to_string(j));
        }
    }

    for (auto& candidate : candidates) {
        CapturedFrame candidate_frame;
        if (!copy_texture_to_frame(enabler, candidate.first, candidate.second,
                                   candidate_frame, last_err))
            continue;
        if (allow_icon_fallbacks) {
            CapturedFrame cropped;
            if (crop_visible_bounds(candidate_frame, cropped) && frame_has_visible_pixels(cropped))
                candidate_frame = std::move(cropped);
        }
        texpos = candidate.first;
        source = candidate.second;
        frame = std::move(candidate_frame);
        return true;
    }
    return false;
}

#ifdef _WIN32
bool render_viewscreen_isolated(std::string* err = nullptr, int target_w = 0, int target_h = 0) {
    auto viewscreen = DFHack::Gui::getCurViewscreen(true);
    if (!viewscreen) {
        if (err) *err = "no current viewscreen";
        return false;
    }
    TemporaryRenderTarget target;
    std::string target_err;
    if (!target.begin(&target_err, target_w, target_h)) {
        if (err) *err = target_err;
        return false;
    }
    target.clear(nullptr);
    int fault = call_viewscreen_render_seh(viewscreen);
    if (fault != 0) {
        if (err) {
            std::ostringstream ss;
            ss << "isolated viewscreen render fault code=0x" << std::hex << g_seh_code
               << " at=" << g_seh_at
               << " access=0x" << reinterpret_cast<uintptr_t>(g_seh_access);
            *err = ss.str();
        }
        return false;
    }
    return true;
}
#endif

bool capture_unit_icon_with_widget(df::unit* unit, df::enabler* enabler,
                                   CapturedFrame& frame, int32_t& texpos,
                                   std::string& source, std::string& last_err) {
#ifdef _WIN32
    if (!unit) {
        last_err = "unit not found";
        return false;
    }
    if (!enabler) {
        last_err = "enabler unavailable";
        return false;
    }

    std::unique_ptr<df::widget_unit_portrait> widget(df::allocate<df::widget_unit_portrait>());
    if (!widget) {
        last_err = "could not allocate native unit portrait widget";
        return false;
    }

    bool saved_refresh = unit->flags4.bits.portrait_must_be_refreshed;
    unit->flags4.bits.portrait_must_be_refreshed = true;
    auto restore_refresh = [&]() {
        unit->flags4.bits.portrait_must_be_refreshed = saved_refresh;
    };

    constexpr int ICON_GRID_TILES = 4;
    widget->u = unit;
    widget->rect.x1 = 0;
    widget->rect.y1 = 0;
    widget->rect.x2 = ICON_GRID_TILES - 1;
    widget->rect.y2 = ICON_GRID_TILES - 1;
    widget->min_w = ICON_GRID_TILES;
    widget->min_h = ICON_GRID_TILES;

    auto gps = df::global::gps;
    InterfaceGridSnapshot grid(gps);
    if (!grid.valid()) {
        restore_refresh();
        last_err = "native interface grid unavailable";
        return false;
    }

    int fault = call_widget_seh(widget.get());
    if (fault != 0) {
        restore_refresh();
        std::ostringstream ss;
        ss << "native unit portrait widget fault at stage " << fault
           << " code=0x" << std::hex << g_seh_code
           << " at=" << g_seh_at
           << " access=0x" << reinterpret_cast<uintptr_t>(g_seh_access);
        last_err = ss.str();
        if (!g_warned_portrait_widget_fail.exchange(true))
            diagnostics_log("DIAG portrait widget failed: " + last_err);
        return false;
    }

    CapturedFrame generated;
    int32_t generated_texpos = -1;
    std::string generated_source;
    if (copy_unit_portrait_candidate(unit, enabler, generated, generated_texpos,
                                     generated_source, last_err, true)) {
        restore_refresh();
        frame = std::move(generated);
        texpos = generated_texpos;
        source = "widget-" + generated_source;
        if (!g_warned_portrait_widget_success.exchange(true))
            diagnostics_log("DIAG portrait widget generated native texture source=" + source +
                            " texpos=" + std::to_string(texpos));
        return true;
    }

    // The native widget writes its selected icon into DF's interface grid. Recover that exact
    // texture before restoring the grid. This is an icon fallback only, never a profile portrait.
    for (int32_t candidate : grid.added_texpos()) {
        if (!copy_texture_to_frame(enabler, candidate, "widget-grid", generated, last_err))
            continue;
        restore_refresh();
        frame = std::move(generated);
        texpos = candidate;
        source = "widget-grid";
        if (!g_warned_portrait_widget_success.exchange(true))
            diagnostics_log("DIAG unit icon widget recovered grid texture texpos=" +
                            std::to_string(texpos) + " " +
                            std::to_string(frame.width) + "x" +
                            std::to_string(frame.height));
        return true;
    }

    restore_refresh();
    if (last_err.empty())
        last_err = "native unit portrait widget produced no recoverable texture";
    if (!g_warned_portrait_widget_fail.exchange(true))
        diagnostics_log("DIAG portrait widget failed: " + last_err);
    return false;
#else
    (void)unit; (void)enabler; (void)frame; (void)texpos; (void)source;
    last_err = "native unit icon widget rendering is Windows-only";
    return false;
#endif
}

struct RenderThreadPortraitRequest {
    int32_t unit_id = -1;
    bool allow_icon_fallbacks = false;
    bool generation_requested = false;
    int32_t texpos = -1;
    std::string source;
    CapturedFrame frame;
    std::string err;
    std::promise<bool> done;
};

} // namespace

bool unit_portrait_native_generator_available(std::string* why) {
    return native_generator_ready(why);
}

bool unit_portrait_native_generator_faulted() {
    return g_native_gen_faulted.load();
}

NativePortraitOutcome unit_portrait_generate_native_on_render(df::unit* unit, std::string* err) {
#ifdef _WIN32
    if (g_native_gen_faulted.load()) {
        if (err) *err = "native portrait generation is disabled after an earlier native fault";
        return NativePortraitOutcome::Faulted;
    }
    std::string why;
    if (!native_generator_ready(&why)) {
        if (err) *err = why;
        return NativePortraitOutcome::Unavailable;
    }
    if (!unit) {
        if (err) *err = "unit not found";
        return NativePortraitOutcome::Blocked;
    }
    if (save_barrier_active()) {
        if (err) *err = "save in progress; portrait generation deferred";
        return NativePortraitOutcome::Blocked;
    }
    if (unit->portrait_texpos > 0 && !unit->flags4.bits.portrait_must_be_refreshed)
        return NativePortraitOutcome::AlreadyExists;

    const int32_t before = unit->portrait_texpos;
    if (call_native_portrait_generator_seh(g_native_gen_fn, unit) != 0) {
        g_native_gen_faulted.store(true);
        std::ostringstream ss;
        ss << "DIAG portrait native generator FAULT code=0x" << std::hex << g_seh_code
           << " at=" << g_seh_at
           << " access=0x" << reinterpret_cast<uintptr_t>(g_seh_access)
           << "; generation latched OFF for this session";
        diagnostics_log(ss.str());
        if (err) *err = "native portrait generator faulted; generation disabled";
        return NativePortraitOutcome::Faulted;
    }
    if (unit->portrait_texpos > 0)
        return before > 0 ? NativePortraitOutcome::AlreadyExists   // refresh of an existing bust
                          : NativePortraitOutcome::Generated;
    if (err) *err = "DF has no portrait art for this creature";
    return NativePortraitOutcome::NoPortraitArt;
#else
    (void)unit;
    if (err) *err = "native portrait generation is Windows-only";
    return NativePortraitOutcome::Unavailable;
#endif
}

bool native_viewscreen_logic_render_isolated(std::string* err) {
#ifdef _WIN32
    auto viewscreen = DFHack::Gui::getCurViewscreen(true);
    if (!viewscreen) {
        if (err) *err = "no current viewscreen";
        return false;
    }
    if (call_viewscreen_logic_seh(viewscreen) != 0) {
        if (err) {
            std::ostringstream ss;
            ss << "native viewscreen logic fault code=0x" << std::hex << g_seh_code
               << " at=" << g_seh_at
               << " access=0x" << reinterpret_cast<uintptr_t>(g_seh_access);
            *err = ss.str();
        }
        return false;
    }
    std::string render_err;
    if (!render_viewscreen_isolated(&render_err)) {
        if (err) *err = "native viewscreen render failed: " + render_err;
        return false;
    }
    return true;
#else
    if (err) *err = "isolated native viewscreen rendering is Windows-only";
    return false;
#endif
}

bool unit_portrait_on_render_thread(int32_t unit_id,
                                    bool allow_icon_fallbacks,
                                    bool generation_requested,
                                    CapturedFrame& frame,
                                    int32_t& texpos,
                                    std::string& source,
                                    std::string* err) {
    std::lock_guard<std::recursive_mutex> render_lock(capture_state_mutex());
    auto request = std::make_shared<RenderThreadPortraitRequest>();
    request->unit_id = unit_id;
    request->allow_icon_fallbacks = allow_icon_fallbacks;
    request->generation_requested = generation_requested;
    auto future = request->done.get_future();

    DFHack::runOnRenderThread([request]() {
        auto unit = df::unit::find(request->unit_id);
        if (!unit) {
            request->err = "unit not found";
            request->done.set_value(false);
            return;
        }
        auto enabler = df::global::enabler;
        if (!enabler) {
            request->err = "enabler unavailable";
            request->done.set_value(false);
            return;
        }

        std::string last_err;
        if (copy_unit_portrait_candidate(unit, enabler, request->frame,
                                         request->texpos, request->source, last_err,
                                         request->allow_icon_fallbacks)) {
            request->done.set_value(true);
            return;
        }

        if (!request->allow_icon_fallbacks) {
            // A portrait endpoint must return a real DF portrait texture or fail. The former
            // widget-grid fallback was a 32x32 map sprite, but a successful HTTP response caused
            // the browser and sweep to mislabel it as a generated Steam portrait.
            if (request->generation_requested) {
                std::string gen_err;
                NativePortraitOutcome outcome =
                    unit_portrait_generate_native_on_render(unit, &gen_err);
                if ((outcome == NativePortraitOutcome::Generated ||
                     outcome == NativePortraitOutcome::AlreadyExists) &&
                    copy_unit_portrait_candidate(unit, enabler, request->frame,
                                                 request->texpos, request->source, last_err,
                                                 false)) {
                    request->source = outcome == NativePortraitOutcome::Generated
                        ? "native-generated" : request->source;
                    request->done.set_value(true);
                    return;
                }
                request->err = gen_err.empty() ? last_err : gen_err;
                request->done.set_value(false);
                return;
            }
            request->err = "native portrait is not ready";
            request->done.set_value(false);
            return;
        }

        if (capture_unit_icon_with_widget(unit, enabler, request->frame,
                                          request->texpos, request->source,
                                          last_err)) {
            request->done.set_value(true);
            return;
        }

        if (!g_warned_portrait_diag.exchange(true)) {
            std::ostringstream ss;
            ss << "DIAG portrait fail unit " << request->unit_id
               << ": portrait_texpos=" << unit->portrait_texpos
               << " sheet_icon=" << unit->sheet_icon_texpos
               << " sprite[0][0]=" << unit->texpos[0][0]
               << " [0][1]=" << unit->texpos[0][1]
               << " [1][0]=" << unit->texpos[1][0]
               << " [2][0]=" << unit->texpos[2][0]
               << " inUse00=" << (unit->texpos_currently_in_use[0][0] ? 1 : 0)
               << " raws.size=" << enabler->textures.raws.size()
               << " lastErr='" << last_err << "'";
            diagnostics_log(ss.str());
        }

        request->err = last_err.empty() ? "unit has no usable native portrait surface" : last_err;
        request->done.set_value(false);
    });

    bool ok = render_future_ready(future) && future.get();
    if (ok) {
        frame = std::move(request->frame);
        texpos = request->texpos;
        source = request->source;
    } else if (err) {
        *err = request->err;
    }
    return ok;
}

} // namespace dwf
