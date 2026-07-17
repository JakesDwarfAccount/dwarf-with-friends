# Naming guide

Dwarf With Friends grew out of the `dfcapture` plugin (SourceAirbender's multi-dwarf; see
[NOTICE](../NOTICE)) while its rendering, transport, and UI architecture changed substantially. Some
names now describe an earlier implementation, and a few directories that sound disposable contain
validation assets. This guide records those traps. It is signposting, not a rename plan: do not
mass-rename these paths. Semantic moves and file splits need their own tests and review.

## Project identity: `dwf` now, `dfcapture` before

`dwf` is the project's own name — short for Dwarf With Friends. The v1 rename gave the DFHack
plugin and Lua module names, the shipped plugin files, browser filenames and globals, CSS, and
harness fixtures the `dwf` identity. The inherited name from the ancestor project is `dfcapture`;
it survives only in the deliberately retained runtime identifiers listed in the next section. So a
`dwf-*` filename is current, load-bearing code, and a `dfcapture*` identifier is a kept
compatibility contract — do not classify either as legacy from the prefix alone.

The most important example is `web/js/dwf-ui-components.js`: it is DWFUI, the current shared UI
component foundation exported as `DWFUI`. New panels are expected to use or extend it; it is not an
old UI layer waiting to be removed.

## Retained runtime identity

The v1 rename changed the shipped plugin *files* to the `dwf.*` identity (`dwf.plug.dll`, `dwf.lua`,
`scripts/gui/dwf.lua`, in-game command `gui/dwf`). It deliberately did **not** change the runtime
identifiers below: console commands, on-disk config filenames, the served web root, and the auth
cookie all keep the original `dfcapture`/`capture-` stem. Each is a wire- or disk-level contract that
existing installs and saved browser state depend on; renaming them is a breaking change deliberately
deferred until after v1.

- **`capture-*` console commands** (`capture-stream-start`, `capture-join-password`, and the rest,
  registered in `src/dwf.cpp`) — the command names players and scripts already type.
- **`dfcapture_join_password.txt`** (`src/auth.h:63`) — the on-disk join-password file; a rename
  would silently drop an existing host's configured password.
- **`dfhack-config/dfcapture.json`** (`src/sound_route.cpp:43`) — the remote-audio config file.
- **`dfcapture-hostwrites.json`** — the host-writes / guarded-writes flag file
  (`src/write_guards.cpp:46`).
- **`hack/dfcapture-web`** (`src/web_assets.cpp:31`) — the served web root; the deploy path is
  explicitly kept this release so live upgrades over a running server keep serving.
- **`dfcap_auth` cookie** (`src/http_server.cpp`) — the auth cookie already stored in players'
  browsers; renaming it would log everyone out.

The one intentional exception is **`dwf_host_flags.txt`** (`src/pause_arbiter.cpp:421`), the host
pause-flags file, which already uses the new `dwf` stem.

## Names that misdescribe their contents

### `src/sdl_capture.cpp` and `src/sdl_capture.h`

The name suggests one SDL screenshot implementation. The module actually contains several different
responsibilities:

- the live camera model and camera clamping used throughout the plugin;
- render-thread coordination and capture locking;
- the live tile-layer capture used by render-buffer tooling;
- the retired product JPEG renderer retained as the unattended parity oracle.

Much of the server depends on the camera and locking portions, so the file is not dead because the
browser stopped displaying JPEG frames. The eventual correction is a tested split by responsibility,
not a single replacement name.

### `src/tile_dump.cpp` versus `src/tile_map_dump.cpp`

These similar names refer to different data sources:

- `tile_dump.cpp` is render-buffer/atlas oracle tooling. It copies DF's currently rendered tile
  layers and can write diagnostic artifacts.
- `tile_map_dump.cpp` reads stable world/map structures under suspension and serializes the older
  JSON map representation. Its `dump` name understates that serializer role.

Neither is the current per-connection transport. The protocol-v1 global read and distribution path
lives in `world_stream.cpp`; WebSocket framing and connection management live in `websocket.cpp`.

### `src/world_stream.cpp`

This is not the socket transport and it does not stream screen pixels. It performs the protocol-v1
global world read, change detection, block/AUX encoding, and per-connection interest distribution.
Look in `src/websocket.cpp` for RFC6455 transport behavior.

### `src/menu_oracle.cpp`

This is not the browser's menu implementation. It exposes the harness-only `/menu-oracle` snapshot
of DF's native building-menu state. No web module calls it. It is deliberately compiled into release
builds so menu differential and stress tools can validate the browser model; its lack of product
callers is not evidence that it is dead.

## Directories and evidence whose names over-promise or understate them

### `tools/spikes/` (development-only; not in the public distribution)

The directory name means throwaway experiments, but several durable items were historically filed
there. The two small load-bearing files were long since moved to honest homes:

- `tools/harness/atlas-test.html` is an acceptance check, not merely a prototype.
- `docs/reference/fogparams.json` records measured fog parameters cited by parity and rendering
  work.

No automated gate reads a file under `tools/spikes/`, and the tree itself (like the screenshot
corpora below) stays on the development machine.

### `tools/spikes/ui-truth/` and `Menu Oracle Screenshots/`

Neither path name establishes provenance. The trees contain captures with different origins and
quality levels, including browser-client captures and native DF captures; some native captures also
include DFHack overlays. Resolution and filenames such as `steam` or `native` are not proof. Consult
the relevant manifest and the pixels themselves before using any image as a parity oracle. (These
trees, and the internal parity studio that referenced them, are development-only and are not part of
the public distribution.)

## Citations to internal design specs

Some source comments and test headers cite internal design specs and analysis notes by path
(`docs/superpowers/specs/...`, `docs/superpowers/plans/...`, scratchpad notes) or reference private
native-screenshot corpora. Those documents are development-era working papers and are **not
included in the public distribution** — the citations are kept because they record where a
constraint came from, and the behavior they describe is pinned by the shipped tests in
`tools/harness/`. A citation that 404s here is intentional provenance bookkeeping, not a broken
link to something the build needs.

## Safe rule for future cleanup

Treat names as navigation hints only. Before deleting or moving a suspiciously named file, check its
compiled references, runtime callers, harness callers, and documented gates. If a name spans multiple
responsibilities, prefer a small tested split over a broad rename that merely replaces one inaccurate
label with another.
