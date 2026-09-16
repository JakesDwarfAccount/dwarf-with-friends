# Plugin Lua module tree

This directory is the **source** of the plugin's Lua module. `lua/parts/*.lua` are ordered fragments;
`lua/dwf.parts.json` is the manifest that names them and their output. The assembler is
[`../tools/lua/build_dwf_lua.mjs`](../tools/lua/build_dwf_lua.mjs): it concatenates the parts in
manifest order into the repository-root `dwf.lua`, which is the file installed to
`hack/lua/plugins/`.

- Edit a part, then regenerate: `node tools/lua/build_dwf_lua.mjs --write`.
- With no flag the same script is a **check**: it asserts the committed `dwf.lua` is byte-identical
  to the concatenated parts and fails if you edited the generated file instead of a part.
- Never hand-edit root `dwf.lua`; the next regeneration overwrites it.

Current parts, in manifest order:

- `parts/00-core.lua`: shared core.
- `parts/10-placement-and-management.lua`: browser build menu and placement.
- `parts/20-burial.lua`: burial and memorial flows.
- `parts/30-workshops-and-orders.lua`: workshop/furnace panels and work orders.
- `parts/40-console.lua`: the DFHack command console.
- `parts/50-hostwrites.lua`: host-write entry points.

Related directories: [`../scripts/`](../scripts) holds the console entry points installed beside the
DLL, and root `dwf.lua` is the generated module. Keep Lua
compatible with DFHack 53.16-r1.
