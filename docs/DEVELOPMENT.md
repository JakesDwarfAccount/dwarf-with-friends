# Development

How to build, test, and extend Dwarf With Friends. Read [AGENTS.md](../AGENTS.md) first: its Dwarf
Fortress safety rules (never hot-reload the plugin, one DF instance only, hold `DF_LOCK` before
driving the game, respect the `CoreSuspender` performance trap) are mandatory and prevent crashes
and lost work. For the shape of the system see [ARCHITECTURE.md](ARCHITECTURE.md); to find a
specific file see [MAP.md](MAP.md).

## Prerequisites

- **Plugin:** Windows and an MSVC C++ toolchain, plus a DFHack 53.15-r1 source checkout with its
  normal build prerequisites. `cpp-httplib` is vendored under `third_party/`; there are no other
  third-party checkouts. The target links `gdiplus`, `ole32`, and `ws2_32`, and streaming is
  compiled only on Windows.
- **Client:** none. The browser client is plain JavaScript with no framework, bundler, or npm
  dependency.
- **Tests and tools:** a stock Node runtime (Node ≥ 18) and Python. The offline suites need neither
  a network nor a Dwarf Fortress install.

## Build

The plugin is an external DFHack plugin. The CMake target is `dfcapture_public`; its output name is
`dwf`, so the built artefact is `dwf.plug.dll`. Place or junction this repository at
`<dfhack-source>/plugins/external/multi-dwarf/`, ensure DFHack's `plugins/external/CMakeLists.txt`
includes it, configure DFHack the normal way, then build only this target:

```powershell
cmake --build <dfhack-source>/build-msvc --config Release --target dfcapture_public
```

CMake bakes a build stamp (`DFCAPTURE_GIT_HASH`) into the binary so `/version` and the WebSocket
hello can advertise a deploy identity the client compares against its own baked stamp; a mismatch
triggers the client's stale-tab guard. For the full procedure, install destinations, and the
source-export stamp override, see [BUILD.md](BUILD.md).

## The offline test harness

The harness under `tools/harness/` is the project's main safety net: several hundred suites that
run with no DF install, no network, and no running game. The culture is that behaviour changes ship
with a regression test, and that a machine without Dwarf Fortress can still prove almost everything.

Run one suite from the repository root:

```powershell
node tools/harness/<name>_test.mjs
```

Each suite prints its own `ok`/`FAIL` lines and exits non-zero on failure; there is no build or
install step. Suites that read DF raws or art call `dfRootOrSkip` and skip honestly when no install
is present; suites that need a running game or native window are guarded by `live_guard.mjs` and
run only with an explicit `--live` flag. A few gates are Python instead (for example
`python tools/harness/gate_perf.py`). `tools/harness/TEST-MAP.md` maps a source file to the suites
that cover it, and lists the current untested files.

### The launch-preflight battery

`tools/release/launch_preflight.mjs` is the single go/no-go command. It prepares and verifies a
launch but never launches, deploys, or restarts anything — it prints the exact manual commands and
stops. It runs in stages:

```powershell
node tools/release/launch_preflight.mjs --stage=suites      # the full offline evidence battery
node tools/release/launch_preflight.mjs --stage=build-check # verify the compiled dll, print sha/size/staleness
node tools/release/launch_preflight.mjs --stage=package     # build the release zip + fixtures
node tools/release/launch_preflight.mjs --stage=all         # suites, build-check, predeploy, then stop
```

Every stage resolves to `PASS`, `FAIL`, or `MANUAL`, and the run ends with a go/no-go summary and
the remaining human checklist. Exit 0 means go; exit 1 means a hard failure. The `--stage=suites`
list is deliberately curated to contain only suites that stay green on a DF-less machine — adding a
live-game suite there would make the launch machine go red for the wrong reason.

### Test-the-test

Many suites carry a self-test that re-seeds the original defect and proves the checker still catches
it. Conventionally this is a `--selftest` (or `--selftest-old <session-dir>`) mode that feeds the
checker the pre-fix, known-bad state and asserts it goes **red**. A guard that cannot fail is not a
guard, so a new regression suite is expected to demonstrate its own failure mode. `dfroot_gate_test`
and the UI drift guard are examples that ship with their own self-tests.

### The DF-install boundary

On a machine with no Dwarf Fortress install the whole sweep is green: the raws/art oracles and the
live-server oracles skip honestly rather than fail, and nothing is red. That skipping set is exactly
what continuous integration runs. `tools/harness/README.md` lists the install-only and live-only
suites; `node tools/release/launch_preflight.mjs --stage=suites` prints the current pass/skip
counts — treat those numbers as living, and run that command rather than memorising a figure. CI
does not build the DLL — the pinned DFHack/MSVC build is a maintainer check.

Before opening a pull request, run the full Node battery and the UI suites relevant to your change;
[CONTRIBUTING.md](../CONTRIBUTING.md) lists the exact commands.

## Deploying to a local install

Because a changed DLL cannot be swapped while the game runs, deploying is always: stop
Dwarf Fortress, copy the DLL, the Lua files, and the `web/` tree into place, and relaunch
(`host/install.mjs` does this for release layouts; `tools/harness/auto_load.sh` automates the
dev loop). Deployment is a safety boundary: it requires `DF_LOCK` and an explicit decision to
deploy. Never hot-reload the plugin, and never copy the DLL over a running game. The DF-root
resolution order is `--df-root`, then the environment variable, then Steam/common-location
autodetection; never hardcode a machine's path — a grep gate (`dfroot_gate_test`) fails the build if
a machine-specific DF path reappears in tracked code.

## Parity verification

During development the browser UI was verified against an internal screenshot-parity studio: a local
workspace that renders the production DWFUI builders through the same sprite path the real client
uses, side by side with native Steam captures. That studio and its private native-screenshot corpus
are development-only and are not part of this public distribution.

## The DWFUI component rules

The browser UI has one shared component system, DWFUI (`web/js/dwf-ui-components.js`). It is a declarative markup layer:
configuration in, escaped HTML out, with no fetching, DOM mutation, listeners, or state of its own.
Panels own fetching, state, and delegated `data-*` handlers; DWFUI owns the native-style rows, tabs,
plaques, buttons, inputs, dialogs, grids, scrollbars, sprite bindings, and bitmap text.

The policy is: **all product UI goes through DWFUI, and there are no private substitutes.** A
missing primitive is added to DWFUI and tested there, not hand-built inside one panel.
`rawHtml(reason, html)` is the single audited escape hatch for genuinely composed markup. This is a
hard boundary enforced by tests, not a style preference — UI changes must pass
`dwfui_boot_test.mjs` and both modes of `ui_drift_guard_test.mjs`. Never
replace a native sprite token with an emoji or Unicode stand-in.

## Where to add a new panel

1. **Server route.** Add or extend a domain module in `src/` that exposes a `register_*_routes()`
   function, and register it from `http_server.cpp` alongside the others. Reads and mutations follow
   the module-mutex-then-`CoreSuspender` discipline described in ARCHITECTURE.md; read only what
   changed. Return panel state as JSON over HTTP; reserve the WebSocket for high-rate map and
   presence state.
2. **Client module.** Add a `web/js/dwf-<family>.js` script that registers a global namespace,
   fetches from your route, and builds its markup with `DWFUI` builders after declaring them via
   `require(surface, [names])`. Add the `<script>` tag to `web/index.html` in dependency order
   (after `dwf-ui-components.js`, and after any module it depends on). Give interactive elements
   stable IDs and `data-*` hooks — those are behaviour contracts the tests and other modules rely
   on.
3. **Ownership and tests.** Give the family a single owning module (see the ownership table in
   [web/js/README.md](../web/js/README.md)) rather than spreading it across panels, and add an
   offline fixture suite under `tools/harness/` with a self-test.

## Where to add a new endpoint

Add the handler to the most relevant `register_*_routes()` module (or `session_routes.cpp` for
server-meta routes such as `/health` or `/version`). Validate identity and parameters, take the same
lock discipline as reads, use DFHack APIs or carefully mirror DF's own field updates, and notify the
stream after a successful mutation. Destructive native-UI writes go through the fail-closed
host-write guard in `write_guards.cpp` and the Lua engine in `dwf.lua`; they stay disabled unless the
matching flag in `dfcapture-hostwrites.json` is literally `true`, and that file cannot be changed
over HTTP. Mirror any new client-visible guard flag in `web/js/dwf-write-guards.js`.

## A note on names

Plugin **files** use the `dwf.*` identity (`dwf.plug.dll`, `dwf.lua`, `scripts/gui/dwf.lua`), but the
CMake **target** is `dfcapture_public`, and several **runtime identifiers** deliberately keep the
older stem: the `capture-*` DFHack console commands, the served web root `hack/dfcapture-web`, the
config files (`dfcapture-hostwrites.json`, `dfcapture_join_password.txt`, `dfhack-config/dfcapture.json`),
and the `dfcap_auth` cookie. This is intentional, not stale; [NAMING.md](NAMING.md) explains which
names are load-bearing and which merely look disposable. Do not mass-rename them.
