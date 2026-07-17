# Native plugin source

This directory is the C++ DFHack plugin: HTTP/WebSocket transport, world reads, wire encoding, and
game actions. It builds as the external plugin target `dfcapture_public` with output name `dwf`, so
the artefact is `dwf.plug.dll`. Build instructions live in [../docs/BUILD.md](../docs/BUILD.md); the
full file-by-file index is in [../docs/MAP.md](../docs/MAP.md).

Read first:

- `dwf.cpp` — plugin lifecycle and `capture-*` command registration.
- `http_server.cpp` — HTTP routes and server assembly (fans out to every `register_*_routes`).
- `world_stream.cpp` — change detection and world streaming.
- `wire_v1.cpp` — binary protocol encoding.
- `client_state.cpp` — per-player camera and session state.

## Module groups

- **Server and transport** — `http_server`, `websocket`, `world_stream`, `wire_v1`, `web_assets`,
  `session_routes`, `console_routes`, `oracle_routes`, `sound_route`, `music_sync`, `json_util`.
- **World read and render capture** — `sdl_capture`, `tile_map_dump`, `tile_dump`, `image_encoder`,
  `sprite_map`, `curses_palette`, `overlay_control`, `hud`, and the paced portrait/composite
  sweeps (`bake_sweep`, `portrait_sweep`, `unit_portrait`, `unit_sprites`).
- **Per-family panels and routes** — `squads`, `stockpile_panel`, `building_zone`, `burrows_panel`,
  `work_orders`, `labor`, `standing_orders`, `stone_use`, `info_panel`, `kitchen_panel`, `hospital`,
  `trade_depot`, `unit_sheet`, `unit_activity`, `fort_admin`, `hauling`, `lever_link`, `placement`,
  `worldmap_panel`, `missions`, `interaction`, `art_desc`.
- **Guards, auth, pause, coordination** — `write_guards`, `auth`, `pause_arbiter`, `vote`,
  `client_state`, `attribution`.
- **Lua bridge, diagnostics, messaging** — `lua_bridge`, `diagnostics`, `flight_recorder`,
  `flight_recorder_v3`, `menu_oracle`, `status_harvest`, `status_truth`, `chat`, `notifications`,
  `announcements`, `native_popup`, `diplo`.

## Rules

Do not hot-reload the plugin; a changed DLL requires a full Dwarf Fortress restart. Any DF memory
read must respect the `CoreSuspender` performance constraints in [../AGENTS.md](../AGENTS.md): take
the module mutex, then the suspender, validate every pointer, read or mutate the minimum, and
release promptly. Keep per-frame logging behind `capture-diag-verbose`.

Do not delete `/frame.jpg` or `/menu-oracle` as dead code. They are deliberately compiled into
release builds as test oracles for parity and native-menu gates, with rationale documented in
`oracle_routes.cpp` and `menu_oracle.cpp`. Several files are named for an earlier responsibility
(`sdl_capture`, `tile_dump` versus `tile_map_dump`, `world_stream`); read
[../docs/NAMING.md](../docs/NAMING.md) before assuming one is obsolete.
