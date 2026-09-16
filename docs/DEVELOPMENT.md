# Development

Dwarf With Friends contains a C++ DFHack plugin, a plain JavaScript browser client, a Node host installer, and Lua gameplay helpers. Read [AGENTS.md](../AGENTS.md) before changing code. [MAP.md](MAP.md) identifies the main modules.

## Build

Use DFHack 53.16-r1 and follow [BUILD.md](BUILD.md) for Windows or Linux. The target is `dfcapture_public`; outputs are `dwf.plug.dll` and `dwf.plug.so`. The browser client needs no bundler or npm install. Use Node 22 for source checks and host tools.

The two root Windows launchers use Node from PATH. Release archives provide platform-specific launchers and bundle Node. `DWF Setup.cmd` runs `host/setup.mjs`; `Dwarf With Friends.cmd` starts `host/host_panel.mjs --open`. On Linux a source checkout can use `node host/setup.mjs` and `node host/host_panel.mjs --open`; these operate a real installation and are not offline tests.

## Offline checks

From the repository root:

```sh
node tools/harness/wire_decode_test.mjs
node tools/lua/build_dwf_lua.mjs --check
node tools/harness/stamp_busters.mjs --check
node tools/architecture/browser_dependency_inventory.mjs
```

The decoder check feeds a known fixture into the production decoder. The Lua check verifies generated module bytes. The asset check verifies content-derived cache keys. Report actual results and limitations; none proves live gameplay or installation behavior. Native changes also need compilation for the affected platforms.

## Browser panels

Use DWFUI (`web/js/dwf-ui-components.js`) for shared components. It returns escaped markup; the panel owns fetching, state, and delegated events. Add missing reusable controls to DWFUI. Keep stable IDs and `data-*` hooks compatible and use native sprite tokens where available.

Register scripts in dependency order in `web/index.html`. Keep panel CSS in its owning file under `web/css/panels/`; shared components belong in `web/css/dwf-dwfui.css`. After an asset edit, run `node tools/harness/stamp_busters.mjs`, then `node tools/architecture/browser_dependency_inventory.mjs --write`.

## Native routes and Lua

Extend the relevant `register_*_routes()` module in `src/`. Validate identity and parameters before changing the fortress. Follow the module's mutex-before-CoreSuspender order, preserve save/unload guards, and notify the stream only after success. Keep unsupported operations unavailable rather than guessing native behavior.

Edit `lua/parts/` and regenerate `dwf.lua` with `node tools/lua/build_dwf_lua.mjs --write`. Do not hand-edit the generated module. Preserve the host-write guards and the configuration behavior described in [CONFIG.md](CONFIG.md).

## Installing a development build

Deployment changes a real game installation. Obtain explicit authorization first, close Dwarf Fortress, and follow [the manual install destinations](MANUAL-INSTALL.md). Never hot-reload or replace a loaded plugin. Keep one plugin copy in `hack/plugins/` and back up saves before testing changes.
