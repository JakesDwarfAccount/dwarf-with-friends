# Browser JavaScript

These plain scripts implement transport, caching, rendering, controls, panels, chat, and audio.
There is no framework, bundler, or package-manager dependency, and there are no ES modules: each
file is a classic `<script>` that registers a global (an IIFE namespace such as `DwfWS`, or plain
functions in global scope). Load order is fixed by the `<script>` tag order in `../index.html`.
The complete module inventory is in [../../docs/MAP.md](../../docs/MAP.md).

Read first:

- `dwf-core.js` — startup, camera, connection, and coordination; exposes `startDwf`.
- `dwf-ws.js` — WebSocket transport; routes typed frames to consumer modules.
- `dwf-wire-v1.js` — binary message decoding (mirror of `src/wire_v1.cpp`).
- `dwf-cache.js` / `dwf-cache-worker.js` — the world-addressed client cache.
- `dwf-render.js`, `dwf-gl.js`, `dwf-tiles.js` — the renderer seam and its two renderers.
- `dwf-ui-components.js` — the required DWFUI builders.

## Family ownership

Each gameplay family has one owning module; some delegate to sub-panels.

| Family | Owning module(s) |
|---|---|
| Squads / military | `dwf-squads.js` (orders from `dwf-controls-placement.js`) |
| Buildings / build menu | `dwf-build-info-panels.js`, `dwf-building-zone-stockpile-panels.js`, `dwf-menu-tree.js` |
| Zones / stockpiles | `dwf-building-zone-stockpile-panels.js` (boxes: `dwf-overlay-boxes.js`) |
| Kitchen / hospital | `dwf-kitchen.js`, `dwf-hospital-panel.js` |
| Trade | `dwf-tradedepot-panel.js` (depot), `dwf-tradescreen.js` (barter) |
| Labor and work orders | `dwf-labor-work-orders.js` |
| Nobles / justice / petitions | `dwf-fort-admin.js`, `dwf-obligations.js`, `dwf-diplo.js` |
| Locations / bookmarks | `dwf-location-panel.js`, `dwf-hotkeys.js` |
| Announcements / reports / combat | `dwf-announcements.js`, `dwf-unit-hud-notifications.js`, `dwf-popup.js`, `dwf-combatlog-panel.js` |
| World map / 3D view | `dwf-worldmap.js`; `dwf-world3d.js` (+ `dwf-world3d-model.js`, `dwf-voxelizer.js`, `dwf-voxel-mesh.js`) |
| Help / hotkeys | `dwf-help-panel.js` (+ `dwf-help-corpus.js`, `dwf-help-curated.js`), `dwf-keymap.js` |
| Chat / lobby / vote / console / analytics | `dwf-chat.js`, `dwf-lobby.js`, `dwf-vote.js`, `dwf-console-panel.js`, `dwf-analytics-panel.js` |
| Settings / host / pause / esc | `dwf-settings.js`, `dwf-hostpanel.js`, `dwf-pause.js`, `dwf-escmenu.js` |
| Units / tooltips / audio / touch | `dwf-unit-hud-notifications.js`, `dwf-unitcycle.js`, `dwf-tooltip.js`, `dwf-audio.js`, `dwf-touch.js` |

## DWFUI

`dwf-ui-components.js` is DWFUI, the mandatory shared component system: declarative builders that
take configuration and return escaped HTML, with no fetch, state, or listeners. All product UI goes
through it, and there are no private substitutes — a missing primitive is added to DWFUI and tested
there, not hand-built inside a panel. Declare the builders a panel uses with `require(surface,
[names])`; use `rawHtml(reason, html)` as the single audited escape hatch. The `.dwfui-*` classes and
`--dwfui-*` tokens live in `../css/dwf.css`.

## Rules

Stable IDs and `data-*` hooks are behaviour contracts; other modules and tests depend on them. UI
work runs `dwfui_boot_test.mjs` and both modes of
`ui_drift_guard_test.mjs`. Do not add third-party dependencies, and never replace a native sprite
token with an emoji or Unicode stand-in.
