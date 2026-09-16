# Browser JavaScript

These plain scripts implement transport, caching, rendering, controls, panels, chat, and audio.
There is no framework, bundler, or package-manager dependency, and there are no ES modules: each
file is a classic `<script>` that registers a global (an IIFE namespace such as `DwfWS`, or plain
functions in global scope). Load order is fixed by the `<script>` tag order in `../index.html`.
The complete module inventory is in [MAP.md](../../docs/MAP.md).

Read first:

- `dwf-core.js`: startup, camera, connection, and coordination; exposes `startDwf`.
- `dwf-ws.js`: WebSocket transport; routes typed frames to consumer modules.
- `dwf-wire-v1.js`: binary message decoding (mirror of `src/wire_v1.cpp`).
- `dwf-cache.js` / `dwf-cache-worker.js`: the world-addressed client cache.
- `dwf-render.js`, `dwf-gl.js`, `dwf-tiles.js`: the renderer seam and its two renderers.
- `dwf-ui-components.js`: the required DWFUI builders.

## Family ownership

Each gameplay family has one owning module; some delegate to sub-panels.

| Family | Owning module(s) |
|---|---|
| Squads / military | `dwf-squad-panel.js` (overview/orders), `dwf-squad-positions.js`, `dwf-squad-equipment.js`, `dwf-squad-schedule.js`, `dwf-squad-emblem.js`, `dwf-squad-burrow-order.js`, and `dwf-squad-patrol-order.js` (map orders from `dwf-map-target-modes.js`) |
| Buildings / build menu | `dwf-build-panel.js`, `dwf-building-panel.js`, `dwf-machine-panel.js`, `dwf-siege-engine-panel.js`, `dwf-farm-plot-panel.js`, `dwf-lever-link-panel.js`, `dwf-workshop-panel.js`, `dwf-menu-tree.js` |
| Information panels | `dwf-info-panel.js`, `dwf-creatures-panel.js`, `dwf-vermin-panel.js`, `dwf-planned-engraving-panel.js`, `dwf-item-panel.js`, `dwf-stocks-panel.js`, `dwf-tasks-panel.js` |
| Zones / stockpiles | `dwf-zone-panel.js`, `dwf-stockpile-panel.js`, `dwf-stockpile-settings.js` (boxes: `dwf-overlay-boxes.js`) |
| Kitchen / hospital | `dwf-kitchen.js`, `dwf-hospital-panel.js` |
| Trade | `dwf-tradedepot-panel.js` (depot), `dwf-tradescreen.js` (barter) |
| Labor and work orders | `dwf-labor-details.js` (work details), `dwf-standing-orders.js` (standing orders), `dwf-stone-use.js` (stone use), `dwf-work-orders.js` (manager work orders) |
| Nobles / justice / petitions | `dwf-fort-admin.js`, `dwf-obligations.js`, `dwf-diplo.js` |
| Locations / bookmarks | `dwf-location-panel.js`, `dwf-hotkeys.js` |
| Announcements / reports / combat | `dwf-announcements.js`, `dwf-announcement-viewer.js`, `dwf-local-panel-router.js`, `dwf-popup.js` |
| World map / 3D view | `dwf-worldmap.js`; `dwf-world3d.js` (+ `dwf-world3d-model.js`, `dwf-voxelizer.js`, `dwf-voxel-mesh.js`) |
| Help / hotkeys | `dwf-help-panel.js` (+ `dwf-help-corpus.js`, `dwf-help-curated.js`), `dwf-keymap.js` |
| Chat / lobby / console / analytics | `dwf-chat.js`, `dwf-lobby.js`, `dwf-console-panel.js`, `dwf-analytics-panel.js` |
| Settings / host / pause / esc | `dwf-settings.js`, `dwf-hostpanel.js`, `dwf-pause.js`, `dwf-escmenu.js` |
| Units / HUD / tooltips / audio / touch | `dwf-unit-portrait.js`, `dwf-unit-follow.js`, `dwf-unit-profile.js`, `dwf-fortress-hud.js`, `dwf-minimap.js`, `dwf-unitcycle.js`, `dwf-tooltip.js`, `dwf-audio.js`, `dwf-touch.js` |

## DWFUI

`dwf-ui-components.js` is DWFUI, the mandatory shared component system: declarative builders that
take configuration and return escaped HTML, with no fetch, state, or listeners. All product UI goes
through it, and a missing primitive is added to DWFUI and tested
there, not hand-built inside a panel. Declare the builders a panel uses with `require(surface,
[names])`; use `rawHtml(reason, html)` as the single audited escape hatch. The `.dwfui-*` classes and
`--dwfui-*` tokens live in `../css/dwf-dwfui.css` and `../css/dwf-tokens.css`.

## Rules

Stable IDs and `data-*` hooks are behaviour contracts; other modules and tests depend on them. Run the source checks listed in [the development guide](../../docs/DEVELOPMENT.md). Do not add third-party dependencies, and never replace a native sprite
token with an emoji or Unicode stand-in.
