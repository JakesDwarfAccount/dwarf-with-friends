# Agent instructions

Read [the development guide](docs/DEVELOPMENT.md) and [build instructions](docs/BUILD.md) before changing code.

Preserve unrelated changes. Stage named files. Do not publish, deploy, launch Dwarf Fortress, or interact with a running game without explicit authorization. Never replace a loaded plugin or hot-reload it; native plugin changes require a full game restart.

Read the current implementation before relying on documentation. Keep changes focused and report exact checks and their results. Offline checks do not establish gameplay correctness.

Native memory reads and writes must follow the owning module's locking order. Acquire the module mutex before CoreSuspender, validate pointers, minimize suspended work, and preserve save and shutdown guards. Never add broad per-frame memory scans or logging.

Browser panels use DWFUI in `web/js/dwf-ui-components.js`. Reuse shared controls, escape text, and keep panel state and event handlers in the owning module. Keep CSS beside its owner under `web/css/`. Shared render decisions must agree in WebGL and canvas.

Edit Lua parts under `lua/parts/`, then run `node tools/lua/build_dwf_lua.mjs --write`. After browser asset edits run `node tools/harness/stamp_busters.mjs` and `node tools/architecture/browser_dependency_inventory.mjs --write`.

Run `node tools/harness/wire_decode_test.mjs`, `node tools/lua/build_dwf_lua.mjs --check`, and `node tools/harness/stamp_busters.mjs --check`. Build native changes for the affected platforms. Add a small behavior check only when it catches an actual failure; do not add tests that merely assert source spelling.

Preserve license headers and credit. Keep the `capture-*` commands, config filenames, `dfcap_auth` cookie, and `hack/dfcapture-web` path compatible. See [the naming guide](docs/NAMING.md).
