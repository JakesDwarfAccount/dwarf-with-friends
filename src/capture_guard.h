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

#include "frame.h"
#include "sdl_dlsym.h"

#include "df/enabler.h"
#include "df/global_objects.h"
#include "df/renderer.h"
#include "df/viewscreen.h"

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

#include <cstdint>
#include <string>
#include <utility>

// The crash guard every off-screen capture path shares: the SEH filter and its latched fault state,
// the CRT invalid-parameter bridge, and the throwaway SDL render target. Render thread only.

namespace dwf {

constexpr uint32_t SDL_PIXELFORMAT_ARGB8888 = 0x16362004u;
constexpr int SDL_TEXTUREACCESS_TARGET = 2;

using pfn_CreateTexture = void* (*)(void*, uint32_t, int, int, int);
using pfn_SetRenderTarget = int (*)(void*, void*);
using pfn_RenderReadPixels = int (*)(void*, const void*, uint32_t, void*, int);
using pfn_DestroyTexture = void (*)(void*);
using pfn_GetRendererOutputSize = int (*)(void*, int*, int*);
using pfn_SetRenderDrawColor = int (*)(void*, uint8_t, uint8_t, uint8_t, uint8_t);
using pfn_RenderClear = int (*)(void*);

inline pfn_CreateTexture p_CreateTexture = nullptr;
inline pfn_SetRenderTarget p_SetRenderTarget = nullptr;
inline pfn_RenderReadPixels p_RenderReadPixels = nullptr;
inline pfn_DestroyTexture p_DestroyTexture = nullptr;
inline pfn_GetRendererOutputSize p_GetRendererOutputSize = nullptr;
inline pfn_SetRenderDrawColor p_SetRenderDrawColor = nullptr;
inline pfn_RenderClear p_RenderClear = nullptr;

inline bool resolve_sdl(std::string* err = nullptr) {
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

    if (p_CreateTexture && p_SetRenderTarget && p_RenderReadPixels &&
        p_DestroyTexture && p_GetRendererOutputSize &&
        p_SetRenderDrawColor && p_RenderClear) {
        return true;
    }

    if (err) *err = "could not resolve required SDL2 render-target functions";
    return false;
#else
    p_CreateTexture = reinterpret_cast<pfn_CreateTexture>(sdl_symbol("SDL_CreateTexture"));
    p_SetRenderTarget = reinterpret_cast<pfn_SetRenderTarget>(sdl_symbol("SDL_SetRenderTarget"));
    p_RenderReadPixels = reinterpret_cast<pfn_RenderReadPixels>(sdl_symbol("SDL_RenderReadPixels"));
    p_DestroyTexture = reinterpret_cast<pfn_DestroyTexture>(sdl_symbol("SDL_DestroyTexture"));
    p_GetRendererOutputSize = reinterpret_cast<pfn_GetRendererOutputSize>(sdl_symbol("SDL_GetRendererOutputSize"));
    p_SetRenderDrawColor = reinterpret_cast<pfn_SetRenderDrawColor>(sdl_symbol("SDL_SetRenderDrawColor"));
    p_RenderClear = reinterpret_cast<pfn_RenderClear>(sdl_symbol("SDL_RenderClear"));

    if (p_CreateTexture && p_SetRenderTarget && p_RenderReadPixels &&
        p_DestroyTexture && p_GetRendererOutputSize &&
        p_SetRenderDrawColor && p_RenderClear) {
        return true;
    }

    if (err) *err = "could not resolve required SDL2 render-target functions";
    return false;
#endif
}

#ifdef _WIN32

inline volatile uint32_t g_seh_code = 0;
inline void* g_seh_at = nullptr;
inline void* g_seh_access = nullptr;

constexpr DWORD DWF_INVALID_PARAMETER_EXCEPTION = 0xE0424643u;

inline int seh_filter(_EXCEPTION_POINTERS* ep) {
    g_seh_code = ep && ep->ExceptionRecord ? ep->ExceptionRecord->ExceptionCode : 0;
    g_seh_at = ep && ep->ExceptionRecord ? ep->ExceptionRecord->ExceptionAddress : nullptr;
    g_seh_access = (ep && ep->ExceptionRecord && ep->ExceptionRecord->NumberParameters >= 2)
        ? reinterpret_cast<void*>(ep->ExceptionRecord->ExceptionInformation[1])
        : nullptr;
    return EXCEPTION_EXECUTE_HANDLER;
}

// The CRT answers an invalid argument by terminating the process, which SEH never sees. Raising
// instead turns it into a fault the guards below can catch.
inline void __cdecl invalid_parameter_handler(const wchar_t*, const wchar_t*,
                                              const wchar_t*, unsigned int, uintptr_t) {
    RaiseException(DWF_INVALID_PARAMETER_EXCEPTION, EXCEPTION_NONCONTINUABLE, 0, nullptr);
}

inline int call_viewscreen_render_seh(df::viewscreen* viewscreen) {
    int fault = 0;
    _invalid_parameter_handler old_handler =
        _set_thread_local_invalid_parameter_handler(invalid_parameter_handler);
    __try {
        viewscreen->render(0);
    } __except(seh_filter(GetExceptionInformation())) {
        fault = 1;
    }
    _set_thread_local_invalid_parameter_handler(old_handler);
    return fault;
}

// Binds a throwaway SDL texture as the render target for one isolated render, so nothing the
// guarded call draws reaches the host window.
class TemporaryRenderTarget {
public:
    explicit TemporaryRenderTarget(const char* label) : label_(label) {}

    bool begin(std::string* err = nullptr, int requested_w = 0, int requested_h = 0) {
        if (!resolve_sdl(err))
            return false;

        auto enabler = df::global::enabler;
        df::renderer* renderer = enabler ? enabler->renderer : nullptr;
        if (!renderer) {
            if (err) *err = fail("no renderer");
            return false;
        }

        sdl_ = renderer->get_renderer();
        if (!sdl_) {
            if (err) *err = fail("get_renderer() returned null");
            return false;
        }

        int w = 0;
        int h = 0;
        p_GetRendererOutputSize(sdl_, &w, &h);
        if (requested_w > 0) w = requested_w;
        if (requested_h > 0) h = requested_h;
        if (w <= 0 || h <= 0) {
            if (err) *err = fail("bad renderer output size");
            return false;
        }

        target_ = p_CreateTexture(sdl_, SDL_PIXELFORMAT_ARGB8888,
                                  SDL_TEXTUREACCESS_TARGET, w, h);
        if (!target_) {
            if (err) *err = fail("SDL_CreateTexture failed");
            return false;
        }

        if (p_SetRenderTarget(sdl_, target_) != 0) {
            p_DestroyTexture(target_);
            target_ = nullptr;
            if (err) *err = fail("SDL_SetRenderTarget failed");
            return false;
        }

        w_ = w;
        h_ = h;
        active_ = true;
        return true;
    }

    bool clear(std::string* err = nullptr) {
        if (!active_ || !sdl_) {
            if (err) *err = fail("target is not active");
            return false;
        }
        if (p_SetRenderDrawColor(sdl_, 0, 0, 0, 0) != 0 || p_RenderClear(sdl_) != 0) {
            if (err) *err = fail("SDL_RenderClear failed");
            return false;
        }
        return true;
    }

    bool read_frame(CapturedFrame& frame, std::string* err = nullptr) {
        if (!active_ || !sdl_ || w_ <= 0 || h_ <= 0) {
            if (err) *err = fail("target is not active");
            return false;
        }
        CapturedFrame next;
        next.width = w_;
        next.height = h_;
        next.bgra.resize(static_cast<size_t>(w_) * h_ * 4);
        int rc = p_RenderReadPixels(sdl_, nullptr, SDL_PIXELFORMAT_ARGB8888,
                                    next.bgra.data(), w_ * 4);
        if (rc != 0) {
            if (err) *err = fail("SDL_RenderReadPixels failed");
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
    std::string fail(const char* what) const {
        return std::string(label_) + ": " + what;
    }

    const char* label_ = "";
    void* sdl_ = nullptr;
    void* target_ = nullptr;
    int w_ = 0;
    int h_ = 0;
    bool active_ = false;
};

#endif // _WIN32

} // namespace dwf
