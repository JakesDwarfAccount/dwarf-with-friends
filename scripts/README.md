# DFHack scripts

This directory contains Lua entry points installed beside the native plugin.

Read first:

- `gui/dwf.lua` — the in-game configuration and launcher window (run `gui/dwf`).
- Root `dwf.lua` — the plugin module installed under `hack/lua/plugins/`; it also hosts the guarded
  native-write engine driven by `src/lua_bridge.cpp`.
- `../docs/BUILD.md` — exact install destinations.

Keep Lua compatible with DFHack 53.15-r2. Do not copy scripts into a running install unless the task
explicitly authorises deployment. Never use a script to bypass the `DF_LOCK` rules in
[../AGENTS.md](../AGENTS.md) and [../tools/harness/README.md](../tools/harness/README.md).
