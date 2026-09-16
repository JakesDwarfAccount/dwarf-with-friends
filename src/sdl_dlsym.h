// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only
//
// Linux/macOS SDL2 symbol lookup: resolves render functions from the SDL the game already loaded.
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
