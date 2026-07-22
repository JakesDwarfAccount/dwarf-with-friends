// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Linux/macOS twin of the Windows GetModuleHandleA("SDL2.dll")/GetProcAddress lookups:
// resolve SDL2 render functions from the copy of SDL the game process already loaded.
// dwarfort links libSDL2 directly, so RTLD_DEFAULT normally finds the symbols; the
// dlopen fallbacks cover a namespace-local SDL without ever loading a SECOND copy
// (RTLD_NOLOAD first) unless none is present at all.
#pragma once

#ifndef _WIN32

#include <dlfcn.h>

namespace dwf {

inline void* sdl_symbol(const char* name) {
    void* sym = dlsym(RTLD_DEFAULT, name);
    if (sym)
        return sym;
    static void* lib = [] {
        void* h = dlopen("libSDL2-2.0.so.0", RTLD_LAZY | RTLD_NOLOAD);
        if (!h)
            h = dlopen("libSDL2-2.0.so.0", RTLD_LAZY);
        return h;
    }();
    return lib ? dlsym(lib, name) : nullptr;
}

} // namespace dwf

#endif // !_WIN32
