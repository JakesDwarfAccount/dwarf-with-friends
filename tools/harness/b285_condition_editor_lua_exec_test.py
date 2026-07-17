# b285_condition_editor_lua_exec_test.py -- B285 wave-2: EXECUTE the condition write path.
#
# The .mjs suites pin the source; this one actually RUNS dwf.lua's add/edit/remove/
# suggested_conditions against fixture orders, in a plain Lua 5.3 state built from DF's OWN
# hack/lua53.dll (compile + execute; no game process, no DF memory, no DF_LOCK needed).
# Ground truth is the DF install's lua runtime -> dfRootOrSkip semantics: no install = SKIP, exit 0.
#
# SPDX-License-Identifier: AGPL-3.0-only
import ctypes
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "lib"))
from dfroot import df_root_or_skip  # noqa: E402

NAME = "b285_condition_editor_lua_exec_test"


def main():
    df_root = df_root_or_skip(NAME, "executes dwf.lua's condition write path on DF's own lua53.dll")
    dll_path = os.path.join(df_root, "hack", "lua53.dll")
    if not os.path.exists(dll_path):
        print("SKIP %s: %s not found (DFHack not installed into this DF root)." % (NAME, dll_path))
        return 0

    os.add_dll_directory(os.path.dirname(dll_path))
    lua = ctypes.CDLL(dll_path)
    # DFHack builds lua as C++, so the exports are MSVC-mangled.
    newstate = getattr(lua, "?luaL_newstate@@YAPEAUlua_State@@XZ")
    newstate.restype = ctypes.c_void_p
    openlibs = getattr(lua, "?luaL_openlibs@@YAXPEAUlua_State@@@Z")
    openlibs.argtypes = [ctypes.c_void_p]
    loadbuf = getattr(lua, "?luaL_loadbufferx@@YAHPEAUlua_State@@PEBD_K11@Z")
    loadbuf.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_char_p]
    pcallk = getattr(lua, "?lua_pcallk@@YAHPEAUlua_State@@HHH_JP6AH0H1@Z@Z")
    pcallk.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                       ctypes.c_longlong, ctypes.c_void_p]
    tolstring = getattr(lua, "?lua_tolstring@@YAPEBDPEAUlua_State@@HPEA_K@Z")
    tolstring.restype = ctypes.c_char_p
    tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]

    def read(path):
        with open(path, "rb") as f:
            data = f.read()
        return data[3:] if data[:3] == b"\xef\xbb\xbf" else data

    L = newstate()
    openlibs(L)

    # Three chunks, one state: dwf.lua ends in `return _ENV`, so it cannot be concatenated
    # with the test suite -- MODULE_ENV (stashed by the stub mkmodule) carries state across chunks.
    chunks = [
        ("prelude", read(os.path.join(HERE, "fixtures", "b285_exec_prelude.lua"))),
        ("dwf.lua", read(os.path.join(ROOT, "dwf.lua"))),
        ("tests", read(os.path.join(HERE, "fixtures", "b285_exec_tests.lua"))),
    ]
    for label, script in chunks:
        rc = loadbuf(L, script, len(script), b"@b285_exec:" + label.encode(), b"t")
        if rc != 0:
            print("FAIL %s: %s COMPILE error: %s"
                  % (NAME, label, tolstring(L, -1, None).decode("utf-8", "replace")))
            return 1
        rc = pcallk(L, 0, -1, 0, 0, None)  # -1 = LUA_MULTRET (dfcapture returns its module env)
        sys.stdout.flush()
        if rc != 0:
            print("FAIL %s: %s RUNTIME error: %s"
                  % (NAME, label, tolstring(L, -1, None).decode("utf-8", "replace")))
            return 1
    print("PASS %s" % NAME)
    return 0


if __name__ == "__main__":
    sys.exit(main())
