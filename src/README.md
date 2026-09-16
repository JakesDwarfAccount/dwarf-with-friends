# Native plugin source

This directory is the C++ DFHack plugin: it reads and mutates one running Dwarf Fortress process
under strict locking and serves every player's browser over HTTP and WebSocket. It builds as the
external plugin target `dfcapture_public` with output name `dwf`, so the artifact is `dwf.plug.dll` on Windows or `dwf.plug.so` on Linux.
Build instructions live in [BUILD.md](../docs/BUILD.md); the longer per-file
purposes and the runtime diagram are in [MAP.md](../docs/MAP.md), and the
safety contract every file here obeys is [../AGENTS.md](../AGENTS.md).

Read first:

- `dwf.cpp`: plugin lifecycle and `capture-*` command registration.
- `http_server.cpp`: HTTP routes and server assembly (fans out to every `register_*_routes`).
- `world_stream.cpp`: change detection and world streaming.
- `wire_v1.cpp`: binary protocol encoding.
- `client_state.cpp`: per-player camera and session state.

## Module groups

Every `.cpp`/`.h` file in this directory appears exactly once below, under the one group that owns
it. A `foo.cpp/.h` row names both files. Roles are one line; MAP.md carries the depth.

### Transport, session, and the streaming hot path (20 files)

| File | Role |
|---|---|
| `dwf.cpp` | Plugin entry point: `DFHACK_PLUGIN("dwf")`, the `capture-*` console commands, init and shutdown ordering. |
| `http_server.cpp/.h` | Server lifecycle (`DEFAULT_STREAM_PORT` 8765), the auth pre-routing gate, and the fan-out to every `register_*_routes`. |
| `websocket.cpp/.h` | In-process RFC 6455 server subclassing cpp-httplib; the only map-push wire. |
| `world_stream.cpp/.h` | Protocol-v1 global read pass: one interest-union scan per tick, encode once, distribute to N connections. |
| `wire_v1.cpp/.h` | Protocol-v1 binary codec: frame header, tile record, `BLOCK_SET` assembly. Mirrored by `web/js/dwf-wire-v1.js`. |
| `tile_map_dump.cpp/.h` | Crash-safe tile and unit serialization through stable map APIs; the `wire:1` JSON `/mapdata` shape. |
| `web_assets.cpp/.h` | Locates and serves the on-disk web root `hack/dfcapture-web` and its `index.html`. |
| `session_routes.cpp/.h` | Session and server-meta routes: `/`, `/view`, `/health`, `/version`, `/join`, `/state`, `/camera`, `/follow`, `/zoom`, `/action`, `/save`. |
| `client_state.cpp/.h` | Per-player camera cache and follow target, behind one mutex. |
| `request_origin.cpp/.h` | Classifies a request as loopback, forwarded, or remote: the single source of host authority. |
| `route_helpers.h` | Header-only helpers shared by the `register_*_routes` modules. |

### Gameplay panels and route modules (75 files)

| File | Role |
|---|---|
| `squads.cpp/.h` | Military squad reads and orders. |
| `squad_emblem.cpp/.h` | Triggers native's own random-emblem generator so a squad has an emblem no browser client ever drew. |
| `stockpile_panel.cpp/.h` | Stockpile info, rename, remove, links, storage, category, and exact-mask repaint. |
| `building_zone.cpp/.h` | Building and civic-zone inspect panel, zone routes, and farm plots. |
| `burrows_panel.cpp/.h` | Burrows panel and mutations, plus the rate-limited burrow-change broadcast. |
| `work_orders.cpp/.h` | Manager work-order routes, bridged to Lua. |
| `labor.cpp/.h` | Labor and work-detail routes, plus the assignable-labor enum. |
| `standing_orders.cpp/.h` | `plotinfo` standing-order toggles, grouped by DF's own categories. |
| `stone_use.cpp/.h` | Economic-stone flags (`plotinfo.economic_stone`). |
| `info_panel.cpp/.h` | Info screen tabs: creatures, buildings, artifacts, occupations. |
| `kitchen_panel.cpp/.h` | Cook and brew exclusion toggles per plant. |
| `hospital.cpp/.h` | Hospital location supplies, patients, doctors, and supply-maxima writes. |
| `trade_depot.cpp/.h` | Depot state, caravan roster, mark-for-trade, and trade requests. |
| `unit_sheet.cpp/.h` | The unit detail sheet, including the three-tier military current-order walk. |
| `unit_activity.cpp/.h` | One world-side activity scan per pass; O(1) per-unit current-task lookup. |
| `unit_activity_logic.h` | The activity-precedence template and its behavioral-fixture seam. |
| `unit_status.h` | The one shared computation of the per-unit overhead-status bitfield `st`. |
| `unit_status_words.h` | Status words and unmet-need lines, with the thresholds decoded from DF itself. |
| `unit_face.h` | The happiness face, kept apart from the bubble predicates on purpose. |
| `fort_admin.cpp/.h` | Nobles and administrators, justice, and petitions/agreements. |
| `hauling.cpp/.h` | Hauling-route panel, stops, and vehicle assignment. |
| `lever_link.cpp/.h` | Lever linkage and what each target class does with a delivered trigger. |
| `placement.cpp/.h` | Designation and building placement; the eraser cancels the queued jobs as native does. |
| `worldmap_panel.cpp/.h` | World-map overlay and its coarse biome classification. |
| `missions.cpp/.h` | Missions and raids screen; `/mission-create` validates then refuses behind a deliberate guard. |
| `interaction.cpp/.h` | `/inspect`, `/hover`, tile occupants, and the click-to-tile resolver. |
| `interaction_route.h` | Surface-click precedence seam (tile art ahead of the passive civzone overlay). |
| `art_desc.cpp/.h` | Statue, figurine, slab, and engraving prose sourced only from DF fields. |
| `machines.cpp/.h` | Read-only machine and power networks; never writes DF's running power totals. |
| `siege_engines.cpp/.h` | Siege-engine state, action mode, and the bolt thrower's resting facing. |
| `diplo.cpp/.h` | Petitions and diplomacy detector plus the diplomacy-meeting mirror. |
| `native_popup.cpp/.h` | Mirrors DF's native BOX announcement popups so a web player can read and dismiss them. |
| `notifications.cpp/.h` | The alert stack and recent-report feed. |
| `announcements.cpp/.h` | Read-only paging over the full `world->status.reports` log, by category. |
| `announce_taxonomy.gen.h` | Generated announcement taxonomy. |
| `chat.cpp/.h` | Server-authoritative chat relay, sequenced scrollback ring, and late-join reconciliation. |
| `hud.cpp/.h` | Fort name, site, rank, population, happiness, food, and weather HUD payload. |
| `music_sync.cpp/.h` | One canonical track and elapsed time for every client, carried on the aux frame. |
| `sound_route.cpp/.h` | Serves the host's own DF soundtrack as ranged Ogg behind the remote-play licensing gate. |
| `fort_stock.h` | Shared item ownership and eligibility predicates, one named purpose per caller family. |
| `tile_material.h` | The material a tile is actually made of; a construction record beats the surrounding geology. |
| `world_site_readonly.h` | The pinned site subtype (fortress, monument, lair-shrine). |

### Sprites, portraits, and render capture (22 files)

| File | Role |
|---|---|
| `sdl_capture.cpp/.h` | Live camera model, render-thread coordination, capture locking, and the retained JPEG parity oracle. Owns `capture_state_mutex`. |
| `image_encoder.cpp/.h` | Frame encoding to JPEG/PNG/BMP: GDI+ on Windows, vendored `stb_image_write` elsewhere. |
| `sprite_map.cpp/.h` | Parses DF's premium graphics raws into the token-to-sprite-cell lookup the client renderer uses. |
| `curses_palette.cpp/.h` | DF's live 16-colour curses palette to RGB/JSON, shipped on the `/version` handshake. |
| `overlay_control.cpp/.h` | Disables and restores the DFHack `overlay` plugin while streaming. |
| `bake_sweep.cpp/.h` | Paced offscreen map bake renders, capped well under the shared render budget. |
| `portrait_sweep.cpp/.h` | Paces portrait generation to at most one unit per update tick, gated on save barriers and the fault latch. |
| `unit_portrait.cpp/.h` | Calls DF's own one-argument portrait generator on the render thread, exe-pinned and SEH-latched. |
| `unit_sprites.cpp/.h` | Per-unit texture census and dirty tracking; watches composite identity, never pixels. |
| `camera.h` | The viewport struct (position, zoom, placement mode, hover). |
| `frame.h` | `CapturedFrame`: width, height, BGRA bytes. |
| `surface_z.h` | Which z-level counts as the ground surface for recenter and first join. |
| `sdl_dlsym.h` | Linux/macOS twin of the Windows SDL symbol lookups; never loads a second copy of SDL. |

### Native truth, recording, and oracles (16 files)

| File | Role |
|---|---|
| `flight_recorder.cpp/.h` | Passively records DF's own screen arrays paired with the memory behind them for diagnostics. |
| `flight_recorder_v3.cpp/.h` | The sliced recorder: per-slice enable, capture, enrichment, and honest per-slice status. |
| `menu_oracle.cpp/.h` | Crash-safe native menu read path that quiesces both DF threads before copying widget state. |
| `oracle_routes.cpp/.h` | Harness-only test surface: `/host-state`, `/zoom-probe`, `/frame.jpg`, `/tiledump`. |
| `status_harvest.cpp/.h` | `GET /statusharvest`: the screen-array harvest the status-bubble derivation consumes. |
| `status_truth.cpp/.h` | `GET /statustruth`: the live bubble-versus-sheet cross-check that catches a stale DLL. |
| `texpos_conformance.cpp/.h` | `GET /texpos-conformance`: the texture positions the loaded world stamped on its own raws, plus the tile-page table. |
| `tile_dump.cpp/.h` | Render-buffer and atlas dumps: one frame's tile-layer arrays plus a ground-truth PNG. |

### Safety, guards, and lifecycle (15 files)

| File | Role |
|---|---|
| `auth.cpp/.h` | Join security: the shared-passphrase gate and the version-mismatch build stamp. |
| `write_guards.cpp/.h` | C++ binding of the fail-closed `dfcapture-hostwrites.json` guards; serves `/write-guards` and host-only `/console-config`. |
| `console_routes.cpp/.h` | The browser DFHack console's two handlers, gated on the `dfhack_console` host flag (default off, fail closed). |
| `console_policy.h` | The console's whole security surface: the header-only command deny table that applies to every caller including the host. |
| `pause_arbiter.cpp/.h` | Debounces and merges pause requests, auto-pauses on player leave, and broadcasts saving/busy state. |
| `save_barrier.cpp/.h` | Blocks plugin work while DF is serializing world memory, from DFHack's pre-save callback until the save completes. |
| `ui_cache_purge.cpp/.h` | Clears the raw building pointers DF's v50 sub-interfaces cache, so a deconstruct cannot leave a dangling pointer. |
| `attribution.cpp/.h` | Records which player created each building, order, stockpile, or zone; surfaced by `/attrib`. Plugin memory only. |

### Shared plumbing, Lua bridge, and diagnostics (11 files)

| File | Role |
|---|---|
| `lua_bridge.cpp/.h` | Bridge to the `plugins.dwf` Lua module: build catalog, placement, stuck-squad rescue, guarded console run. |
| `diagnostics.cpp/.h` | Transport counters, host state, and verbose tracing: default off, toggled by `capture-diag-verbose`. |
| `json_util.cpp/.h` | JSON escaping, query-parameter helpers, and the build stamp a grep can find inside the built DLL. |
| `json_mini.cpp/.h` | The minimal JSON reader (`Doc`/`Value`) for the small config and request bodies the plugin parses. |
| `api_result.h` | `ApiResult<T>`: a value or a `{status, code, message}` error, with no exceptions. |
| `api_response.h` | Turns an `ApiResult` failure into its HTTP response. |
| `render_thread_wait.h` | Bounded wait for `runOnRenderThread` marshals; an unbounded wait deadlocks shutdown. |

## Rules

Do not hot-reload the plugin; a changed DLL requires a full Dwarf Fortress restart. Any DF memory
read must respect the `CoreSuspender` performance constraints in [../AGENTS.md](../AGENTS.md): take
the module mutex, then the suspender, validate every pointer, read or mutate the minimum, and
release promptly. Keep per-frame logging behind `capture-diag-verbose`.

Do not delete `/frame.jpg`, `/tiledump`, or `/menu-oracle` as dead code. They are deliberately
compiled into release builds as test oracles for parity and native-menu gates, with rationale
documented in `oracle_routes.cpp` and `menu_oracle.cpp`. Several files are named for an earlier
responsibility (`sdl_capture`, `tile_dump` versus `tile_map_dump`, `world_stream`); read
[NAMING.md](../docs/NAMING.md) before assuming one is obsolete.
