# Browser client

The zero-dependency browser client: plain classic scripts, no framework, bundler, npm runtime, or
build step. The plugin serves a copy of this tree from the host's Dwarf Fortress install
(`<DF>/hack/dfcapture-web/`: the legacy stem is deliberate, see [the naming guide](../docs/NAMING.md)). These
files are not embedded in the DLL, so a browser-only change does not require a plugin rebuild.

## Surfaces

- `index.html`: the game client: shell, script load order, panel mounts.
- `tiles.html`: renderer-focused map surface; loads the render stack only.
## Layers

Foundation modules load before the panels and controls that consume them:

| Layer | Modules |
|---|---|
| Boot / gate | `js/dwf-auth-gate.js`, `js/dwf-boot-health.js`, `js/dwf-join.js`, `js/dwf-core.js` |
| Components | `js/dwf-ui-components.js` (DWFUI), `js/dwf-bitmap-text.js`, `js/dwf-df-markup.js` |
| Transport | `js/dwf-ws.js`, `js/dwf-wire-v1.js` (mirror of `src/wire_v1.cpp`) |
| Cache | `js/dwf-cache.js`, `js/dwf-cache-worker.js` |
| Render | `js/dwf-render.js` (seam) → `js/dwf-tiles.js` (canvas2d) or `js/dwf-gl.js` + `js/dwf-gl-atlas.js` (WebGL2) |
| Chrome / controls | `js/dwf-interface-shell.js`, `js/dwf-control-shell.js`, and the ten `js/dwf-*-controls.js` / placement / mode family modules listed in `index.html` |
| Panels | the remaining `js/dwf-*.js`, one owning module per gameplay family |

The complete module inventory, with the global each file registers, is
[MAP.md](../docs/MAP.md). Read [js/README.md](js/README.md): it carries the
family-ownership table: before changing a feature module.

## Loading and cache keys

Load order is fixed by `<script>` tag order in `index.html` and is part of the application
contract. Every `?v=` cache key here is a content hash of the file it points at: on the script
and stylesheet tags of `index.html` and `tiles.html`, and on the JSON maps fetched from inside
`js/`. After changing any referenced asset, run `node tools/harness/stamp_busters.mjs`, then
`node tools/architecture/browser_dependency_inventory.mjs --write`; never hand-write a key.
`node tools/harness/stamp_busters.mjs --check` fails on any that is not generated.
`tools/architecture/browser-scripts.json` is generated from `index.html` and guarded by
`tools/architecture/browser_dependency_inventory.mjs`. The contract is
[BROWSER-DEPENDENCIES.md](../docs/BROWSER-DEPENDENCIES.md).

## DWFUI

All product UI goes through DWFUI (`js/dwf-ui-components.js`, with the `.dwfui-*` classes and
`--dwfui-*` tokens in `css/dwf-dwfui.css` and `css/dwf-tokens.css`). A missing primitive is added to DWFUI and tested there, never
hand-built inside a panel; `DWFUI.rawHtml("reason", html)` is the single audited escape hatch.

Stable `id`s and `data-*` hooks are behaviour contracts: other modules and tests depend on them.
Never replace an existing native sprite token with an emoji or Unicode stand-in.

## Generated assets

The committed JSON maps describe sprite selection and composition. They do not contain the game's source graphics sheets. Preserve their structure when updating mappings. Font provenance is in [fonts/README.md](fonts/README.md) and [NOTICE](../NOTICE).

## Checks

Run `node tools/harness/wire_decode_test.mjs`, `node tools/harness/stamp_busters.mjs --check`, and `node tools/architecture/browser_dependency_inventory.mjs` from the repository root.
