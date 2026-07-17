# Architecture

Dwarf With Friends runs one real Dwarf Fortress simulation and gives each browser its own view and
controls. The host loads a C++ DFHack plugin, the plugin reads and changes the running fortress, and
an HTTP/WebSocket server inside that plugin serves a zero-dependency browser client.

The short name `dwf` — Dwarf With Friends — is used throughout the source, URLs, files, globals,
and configuration. A handful of runtime identifiers instead keep the `dfcapture` stem inherited
from the project's ancestor, deliberately, for compatibility with existing installs. See
[NAMING.md](NAMING.md) before renaming something that merely looks stale.

## The system at a glance

```text
Dwarf Fortress process
  DF simulation memory
       ^  DFHack APIs and generated df:: structures
       |  short, guarded reads and writes
  dwf plugin (C++)
       |-- HTTP: page, assets, panel data, actions, fallback map reads
       `-- WebSocket: world-addressed block changes, AUX state, controls
                              |
                              v
  browser client (vanilla JavaScript)
       |-- world cache --> WebGL2 tile renderer --> map canvas
       |                     `-- canvas2d fallback
       `-- panel modules --> DWFUI builders --> DOM interface
```

The web application is not embedded in the DLL. The plugin mounts
`<Dwarf Fortress>/hack/dfcapture-web/`, where the installer copies `web/`. A browser-only change
therefore does not require a plugin rebuild. This disk-served arrangement is useful, but it also
means a stale or partially copied web directory can disagree with the running DLL.

## Plugin: reading a live fortress safely

`src/dwf.cpp` owns the DFHack plugin lifecycle and commands. `src/http_server.cpp` owns the
embedded cpp-httplib server and its push threads; domain modules such as `labor.cpp`, `squads.cpp`,
`placement.cpp`, and `fort_admin.cpp` register their own routes. Most game data is reached through
DFHack modules (`Maps`, `Units`, `Items`, `Buildings`, `MapCache`) and the generated `df::` types and
globals for the pinned DFHack/DF version.

Those pointers belong to a simulation that is changing on another thread. The normal safety shape
is therefore:

1. take the module or capture mutex, where one exists;
2. acquire `DFHack::CoreSuspender`;
3. validate the world and every pointer/index used;
4. read or perform the small mutation;
5. release the suspender promptly.

The established shared lock order is capture-state mutex before `CoreSuspender`. Reversing it can
deadlock another path. Render-thread state is a separate domain: code that genuinely needs it first
does a bounded `runOnRenderThread` hop and must not wait for that hop while the core is suspended.

This discipline makes memory access coherent, but suspension is not free: `CoreSuspender` parks
DF's main simulation thread. A broad scan per player or an unnecessary high-frequency read freezes
the game without violating memory safety. The map stream consequently performs one global,
interest-union scan per tick, caches static dictionaries, compares block signatures, re-encodes
only changed blocks, and distributes the resulting bytes to all interested connections. Slow
native-popup readers use cached snapshots sampled at a bounded cadence; cursor and presence loops
avoid DF memory entirely. `ConditionalCoreSuspender` is used where a missed sampling window is
better than waiting through a save or native transition.

There is one exceptional reader worth knowing. Native menu widget vectors can change from both the
simulation and render threads; either thread guard alone proved unsafe. `menu_oracle.cpp` first
parks the render thread, then makes bounded conditional attempts to suspend the core, copies the
menu while both are quiescent, and returns HTTP 503 if it cannot obtain that window. That complexity
is based on observed crashes, not a preferred general pattern.

## World stream and wire protocol

The current map path is protocol v1, implemented by `world_stream.cpp`, `wire_v1.cpp`, and
`websocket.cpp`, with the mirror decoder in `web/js/dwf-wire-v1.js`.

After a JSON hello/hello-ack negotiation, server-to-client state primarily uses sequenced binary
WebSocket frames. Every frame has a 10-byte little-endian header (`D5`, protocol version, type,
flags, and per-connection sequence); sufficiently large payloads can be zlib-compressed. The two
main frame classes are:

- `BLOCK_SET`: changed 16x16 map blocks. Each tile starts with a fixed 12-byte record containing
  tile type, base material, liquid/visibility and designation bits. Length-prefixed sparse tails
  add items, plants, spatters, flows, grass, engravings, vermin, crops, and other less-common data.
  Unknown tail kinds can be skipped, which is the protocol's normal additive-extension mechanism.
- `AUX`: camera-window objects and session state that do not fit the fixed tile record, including
  units, buildings, designation jobs, projectiles, environment state, and player presence. Full
  AUX snapshots are supplemented by negotiated deltas.

The coordinates are world coordinates. The server does not paint a separate screen-sized image for
each player. `world_stream_tick()` unions every connection's block interest, scans signatures once
under one suspension, advances a global world sequence for dirty blocks, encodes a changed block
once, then assembles per-connection block sets from shared encoded data. Per-connection state tracks
the interest window, versions already sent, pending blocks, acknowledgements, resumption, explicit
block re-requests, and the background snapshot trickle used after a fresh join.

The browser acknowledges sequences and can request a fresh keyframe/block when it detects a hole.
Camera and resize messages update the existing socket rather than reconnecting it. HTTP
`/mapdata` remains a fallback when the socket is unavailable, but it is not the primary streaming
architecture. Some comments in older files still explain the retired per-player JSON push path;
`world_stream.h` is the current authority.

## Independent players and cameras

`client_state.cpp` stores a `Camera` per player in a mutex-protected map. The browser sends camera
origin, z-level, viewport dimensions, zoom, and cursor controls under its player/session identity.
That state defines the connection's interest window and the world coordinates used for inspection,
designations, placement, and panel actions.

A first-time player is seeded near the embark wagon (or the map center/surface fallback). Once a
camera exists, reconnects and subsequent actions use that player's stored view. The host's native
camera (`df.global.window_x/y/z`) is only a seed/cache and an oracle concern; it is not the remote
players' camera and normally does not move when they pan. Follow mode records a target, while the
browser performs the inexpensive recenter loop; doing a per-player DF memory lookup every server
frame would recreate the `CoreSuspender` starvation problem.

Presence and smooth cursors also use world coordinates, so another player's cursor can be composed
over a different local camera. The cursor WebSocket loop reads mutex-protected client snapshots and
never suspends DF.

## Browser data and rendering

The client is plain scripts loaded in order by `web/index.html`: no framework, bundler, or npm
runtime. `dwf-ws.js` owns connection, reconnect, acknowledgement, and control messages;
`dwf-cache.js` plus `dwf-cache-worker.js` maintain the world-addressed block cache;
`dwf-tiles.js` resolves tile/object layers and retains the canvas2d renderer.

WebGL2 is the default renderer. `dwf-render.js` selects and supervises it,
`dwf-gl-atlas.js` packs source sprite cells into GPU texture-array pages, and
`dwf-gl.js` builds compact instanced geometry. Terrain is partitioned by block so a dirty
block patches its segment instead of rebuilding the whole view. Buildings, presence, flows,
projectiles, and units have separate update paths; units interpolate on the animation-frame clock
without rebuilding terrain. Shader uniforms handle scrolling and animation cheaply. Text and some
interaction overlays deliberately remain on a 2D overlay canvas.

If WebGL2 initialization fails, the atlas fills, or a context is lost twice, the render seam removes
the GL canvas and promotes the canvas2d renderer. The two renderers intentionally duplicate some
resolution tables. That is a maintenance wart: fixes to tile art, layer order, or animation often
need matching changes and tests in both `dwf-tiles.js` and `dwf-gl.js`.

## Sprites and the host's Dwarf Fortress files

The project does **not** redistribute Kitfox's premium graphics sheets. At runtime the plugin reads
the host's own installation:

- `sprite_map.cpp` parses the environment and plant graphics raws into the `/sprites/map.json`
  token-to-sheet-cell map;
- `/sprites/img/<name>.png` searches the installed vanilla environment, plant, creature,
  descriptor, building, item, and interface graphics directories;
- `/asset` and `/dfart` mount the installed interface images and `data/art` read-only;
- the browser uploads only the cells it needs into its in-memory/GPU atlas.

Committed JSON maps in `web/` describe how DF identities and raw tokens resolve into those cells:
terrain, materials, items, plants, trees, buildings, creatures, interface chrome, portraits,
shadows, and overlays. The generators under `tools/ws2/` derive those lookup structures from a
resolved local DF installation. They contain mappings and composition metadata, not a substitute
copy of the source PNG sheets. Dynamic unit composites are content-addressed and served from the
host when available, with progressively simpler host-art fallbacks.

One historical wrinkle is the bitmap UI font: `web/fonts/df-curses.ttf` is a traced font artifact
used by the client, while the original `data/art` atlas remains mounted from the host. Map and UI
sprite pixels still come from the host installation.

## DWFUI and panels

`web/js/dwf-ui-components.js` is DWFUI, the mandatory component grammar for the browser UI.
Its builders are deliberately declarative: configuration in, escaped HTML out. Panel modules own
fetching, state, and delegated `data-*` event handlers; DWFUI owns native-style rows, tabs, plaques,
buttons, searches, dialogs, switches, radio groups, scrollbars, sprite bindings, and bitmap text.
The `.dwfui-*` classes and `--dwfui-*` tokens live in `web/css/dwf.css`.

All new or changed UI must go through DWFUI. A missing primitive is added to DWFUI and tested there,
not hand-built inside one panel. `DWFUI.rawHtml(reason, html)` is the explicit, audited escape hatch
for genuinely composed markup. This is a hard architectural boundary enforced by the UI drift and
component tests, not just a visual convention.

Panels are split by game domain rather than by a central application store. Examples include labor
and work orders, squads, buildings/zones/stockpiles, trade, hospital, nobles/justice/administration,
world map and missions, announcements/combat logs, help, settings, chat, and the host panel. Their
C++ route providers follow the same domain split. This yields many files and some shared-global
wiring in `dwf-core.js`; it is less elegant than a framework component tree, but it keeps the
client dependency-free and lets each domain evolve with focused fixtures.

## Mutations, authentication, and guarded host writes

Ordinary game mutations are explicit HTTP actions. They validate identity and parameters, acquire
the same mutex/suspender discipline as reads, use DFHack APIs or carefully mirror DF's own field
updates, and notify the stream after success. A join password, when configured, is enforced by a
pre-routing gate for HTTP and by the WebSocket hello. Host-only controls are determined from the
real loopback peer on the server; the browser's host UI defaults to non-host until the server says
otherwise.

Some high-risk actions cannot safely be reconstructed as direct structure writes: barter commit,
opening/selecting in the native trade screen, conviction, and interrogation. The `HOST-WRITES`
engine in `dwf.lua` drives DF's own viewscreen input path so Dwarf Fortress itself creates all
of the coupled records. Each step is gated by a host-controlled boolean in
`dfcapture-hostwrites.json` beside the DF executable. The file cannot be changed over HTTP.

The guard fails closed at every layer. A missing file, malformed JSON, missing key, or value other
than literal `true` produces an empty/false flag set. Lua returns a structured
`{"guarded":true}` refusal before sending native input; C++ maps that to HTTP 501; panel controls
render disabled with the required flag and reason. Flags are read on each state poll, so a host can
enable a verified action without rebuilding, but a network client cannot enable one. This guard is
specific to the native-UI host-write engine; it is not a global switch for routine designations and
other established DFHack-backed actions.

## Test oracles compiled into the release binary

Two test-oracle families deliberately remain in the shipping plugin:

- `/frame.jpg` and its capture/encoder path provide the only unattended renderer-parity oracle.
  Normal browser play does not consume it.
- the native menu oracle snapshots volatile interface widgets for menu-parity tooling, using the
  two-thread quiescence protocol described above.

`/tiledump` is a related render-buffer diagnostic. It passively copies DF's currently populated
native viewport arrays after a guarded native render and is screen-locked to DF's one native camera;
it is not the multiplayer renderer and must not be repurposed as one. These routes make the DLL
larger and expose old capture vocabulary, but removing them would remove the parity ground truth.

## Known seams and historical accidents

- `sdl_capture.cpp` is not merely an obsolete screenshot module. It contains live camera and
  render-thread machinery as well as JPEG/tiledump oracle code. It needs a tested split, not a
  cosmetic rename.
- The server has both binary WebSocket streaming and many JSON HTTP routes. Panel state is mostly
  HTTP, while high-rate map/presence state is WebSocket; forcing everything through one transport
  would be a redesign.
- The client has two renderers and intentionally duplicated resolution logic. Canvas2d is a real
  fallback and test reference, not dead code.
- The web app is a large ordered set of globals. Script load order in `web/index.html` is part of
  the dependency system.
- The retained `dfcapture` runtime identifiers (console commands, config filenames, web root,
  auth cookie) stay until a separately gated compatibility-breaking rename after v1. Again,
  consult [NAMING.md](NAMING.md) before broad renames.

## Directory guides

Start with the guide nearest the code you plan to change:

- [repository overview](../README.md)
- [C++ plugin](../src/README.md)
- [browser assets](../web/README.md)
- [browser JavaScript](../web/js/README.md)
- [host installer and panel](../host/README.md)
- [DFHack scripts](../scripts/README.md)
- [developer tools](../tools/README.md)
- [test harness and gates](../tools/harness/README.md)

