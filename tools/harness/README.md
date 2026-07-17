# Test harness — offline suites, DF-install oracles, and live gates

This directory contains the project's test suites and the objective build/deploy/load/verify
gates. Three tiers:

1. **Offline fixture suites** (`*_test.mjs`, most of the directory) — plain Node, no build step,
   no DF install, no network. Run any of them from the repository root:

   ```sh
   node tools/harness/<name>_test.mjs
   ```

   The one-command battery is `node tools/release/launch_preflight.mjs --stage=suites`; it runs
   the launch suite pool and prints a GO/NO-GO verdict with per-suite pass/skip/fail counts.

2. **DF-install oracle suites** — read ground truth (graphics raws, art assets) from a resolved
   Dwarf Fortress installation. They use `dfRootOrSkip` and **skip honestly** when no install is
   present; on a machine with an install they run for real.

3. **Live gates** (`gate_*.py`, the `*_oracle_test.mjs` suites, `live_guard.mjs`-guarded suites) —
   require a running fortress, a deployed DLL, or a native window. They never run implicitly:
   `live_guard.mjs` requires an explicit `--live`, and anything that drives DF requires the
   `DF_LOCK` file (below). Never point a test at localhost merely because a server is present.

Read first: `wire_decode_test.mjs`, `ui_drift_guard_test.mjs`, `live_guard.mjs`,
`deploy_integrity_check.mjs`, and `ACCEPTANCE-TEMPLATE.md`. `TEST-MAP.md` maps each source file to
the suites that exercise it. Do not weaken guards or rewrite the UI-drift baseline to accept new
debt.

## Test-file naming conventions

Suite filenames carry a prefix that records where the test came from, not a category of behaviour.
They are historical batch identifiers; the prefix is navigation, not meaning.

- **`bNNN_` (for example `b36_wall_adjacency_test.mjs`, `b74_b93_surfaces_test.mjs`)** — a
  work-item batch number. Each `bNNN` was one bug or feature ticket; the number increases over
  project history and a single file may span two batches (`b74_b93`). A high or low number implies
  nothing about importance.
- **`*wave*` (for example `renderer_wave_test.mjs`, `stockpile_ui_wave_test.mjs`)** — a suite added
  as part of a themed coverage sweep that landed many related tests at once.
- **`v1_` (for example `v1_safety_gate_test.mjs`)** — tests of the protocol-v1 binary wire (the
  current map transport, mirrored by `web/js/dwf-wire-v1.js`); the earlier per-player JSON push
  path was removed.
- **`sb_` (for example `sb_predicate_ref.mjs`)** — the status-bubble family: the graphics-mode
  overhead status-selector oracle and its regression suites.

Unprefixed suites are named for the file or behaviour they cover.

Some source comments and fixtures cite internal design specs and screenshot corpora
(`docs/superpowers/...`, native oracle screenshots) that are not included in this public
distribution; the behaviour they pin is enforced by the shipped suites here. See `docs/NAMING.md`.

## The gates (what "done" means — see ACCEPTANCE-TEMPLATE.md)

All gates exit 0 = PASS, 1 = FAIL, 2 = CANNOT-RUN, and write evidence JSON under `results/`
(gitignored). They resolve the DF install per the boundary rules below and require a live,
deployed server unless noted.

- **Perf gate** — `python tools/harness/gate_perf.py [--secs 20] [--skip-tunnel]`
  Wraps `ws_probe.py` into PASS/FAIL: ≥29.5fps, 0 gaps (>500ms), 0 stalls (2s), across four
  phases: localhost idle, localhost panning, tunnel idle, tunnel panning. Every phase connects as
  a protocol-v1 probe (sends `hello`, ACKs every binary frame, decodes the 10-byte header).
  Panning is driven programmatically over the same HTTP camera path the browser client pans with.
  Unpauses DF first (idle fps is defined over a running sim). The tunnel hostname is
  auto-discovered from cloudflared metrics (below).

- **Parity gate** — `python tools/harness/gate_parity.py [--camera X,Y,Z] [--max-score N]
  [--label tag]`
  Pixel-diff of the real tile client vs DF's own render for the SAME camera. Oracle =
  `GET /frame.jpg` (jpeg) or `GET /tiledump`'s lossless `ground_truth.png` (raw); client =
  headless Chrome on `/tiles.html`, geometry from `DwfTiles.getRenderRect()`. Oracle grid
  geometry is measured directly off the oracle image's own rendered-content bounding box divided
  by `/tiledump`'s `meta.json` dims, with a small per-run alignment search for sub-pixel error.
  Pauses DF around the two captures (restores prior state) so creatures don't skew the diff.
  Outputs a per-tile heatmap + triptych PNG + `parity.json` (score_mae 0-255, p95, %tiles>30).
  Without `--max-score` it's report-only.

  **Fog caveat:** both the `jpeg` and `raw` oracles read upstream of DF's screen-space depth-fog
  present pass, so they are fog-blind for multi-level/see-down scenes. Use `--oracle window` —
  a passive `PrintWindow` capture of the real on-screen DF window (`win_capture.py`) — for scenes
  where fog matters. That mode needs the DF window visible and not minimized (a minimized window
  is CANNOT-RUN, never a score of 0); it steals no focus and injects no input, but `--camera`
  writes the native camera directly (restored afterwards) and therefore needs `DF_LOCK`. DF draws
  its UI chrome on top of the same screen space, so absolute window-oracle scores are only
  comparable to other window-oracle runs at the same window size/camera; frame the region of
  interest away from the window edges. The client's `?nofog=1` URL param (both renderers, via
  `dwf-render.js`) is a QA-only kill switch for A/B-ing the client's fog against the window
  oracle (`--extra-params '&nofog=1'`).

- **Local-nav gate (60fps GL floor)** — `python tools/harness/gate_localnav.py [--host H]
  [--camera X,Y,Z] [--renderer gl|canvas2d] [--dims WxH] [--p95-budget-ms N]
  [--require-wire-silence]`
  Loads `GET /view?renderer=<gl|canvas2d>&benchpan=1`, waits cache-warm, drives a scripted
  pan+zoom gesture through the same pathways human input uses. **PASS = p95 frame time ≤17ms**
  (default budget), read from `DwfRender.getStats().benchP95` (the GL rAF loop's own timer) when
  GL is active, falling back to the canvas2d data-layer's `mapDirty`-gated redraw cadence
  otherwise — deliberately different metrics, because the canvas2d layer keeps drawing underneath
  at its own ~30Hz cadence and structurally cannot see faster than that floor. Discrimination
  proof: `--renderer canvas2d --dims 200x200` forces the 200×200-tile cap and MUST fail the same
  budget, proving the gate discriminates a slow renderer rather than rubber-stamping green.
  `--require-wire-silence` additionally asserts zero BLOCK_SET bytes during the pan window.

- **Unit-sprite parity gate** — `python tools/harness/gate_unitsprites.py [--min-units 5]
  [--no-wire-check] [--no-bake-check] [--label tag]`
  For every unit the exporter serves a composite for, independently re-derives the expected
  span/anchor geometry and pixels — from a **cached** `/tiledump?atlas=1` dump plus a
  `dfhack-run lua -f tools/ws2/scout_units.lua` read of the raw texpos fields, an entirely
  separate code path from the exporter — and byte-compares against the served
  `/unit-sprite/<hash>.png` and listing geometry. A secondary, non-gating check re-runs
  `tools/ws2/bake_unit.py --group-match last` against live dwarf fixtures to track DF-update
  drift (a drop is a signal, never a shipping-gate failure). Toggles the census/sprite captures
  on for the run and restores them; pauses DF around the measurement window (`--no-pause` to
  skip; pausing needs `DF_LOCK`).

  **Atlas safety rule:** a full atlas dump (`enabler->textures.raws`, ~150k surfaces) saturates
  DF's render thread for 60-100+ seconds and once froze a live game solid. This gate therefore
  NEVER dumps a fresh atlas on its own — it reuses a cache at
  `<df-root>/dwf_unitsprites_gate/atlas_cache/` (keyed by the current save; atlas content only
  changes on a world/save reload) and warns if the cache looks stale. A fresh dump requires both
  `--refresh-atlas` and `--confirmed-with-owner` confirmation flags and takes `DF_LOCK` for the
  duration of the dump only. Do not work around this by lowering `--min-units` or hand-crafting a
  `/tiledump?atlas=1` call.

- **TRUEMENU model/oracle/gate** — `menu_model.lua` (read-only Lua generator: DF's native
  workshop add-task menu tree for all 33 shop types from raws+entity, JSON out),
  `menu_oracle.lua` (live-read of `main_interface.building.button/filtered_button` +
  `job_details` while a native sheet is open — the ground-truth rows including `objection`
  availability strings), `gate_truemenu.py` (structural checks + `--oracle` differential mode +
  `--self-test` seeded-bad pass). Run the Lua via
  `dfhack-run lua -f <ABSOLUTE path> <ABSOLUTE out.json>` (dfhack-run's cwd is the DF root);
  JSON is CP437. The plugin's `GET /menu-oracle` route quiesces both DF threads in a bounded,
  ordered way (a missed window returns 503, and the caller retries — never a wedge), so
  continuous polling during live menu navigation is the supported use; per-read timings are in
  the `X-Menu-Oracle-Quiesce` response header. Snapshots landing in the legitimate cross-frame
  teardown state carry `"in_transition":true` — recorders/diffs must skip those. Stress
  acceptance: `python tools/harness/menu_oracle_stress.py --hz 30 --secs 300` while sheets are
  rapidly opened/navigated/closed; `--selftest-old <session-dir>` proves the checker can fail.

- **Acceptance template** — `ACCEPTANCE-TEMPLATE.md`: the gate-command + numeric-criteria format
  acceptance reports use.

## The DF-install boundary — what CI can and cannot run

No source file may name one machine's Dwarf Fortress install. Two suites enforce and exercise that:

| Suite | What it does |
|---|---|
| `dfroot_gate_test.mjs` | **The grep gate.** Fails if a drive-lettered or MSYS-rooted DF/Steam path reappears in any tracked code file. Prose and `*.json` data are out of scope; a line may be exempted with `// dfroot-gate: allow -- <reason>` and every exemption is printed on every run. Carries its own self-test. |
| `dfroot_resolver_test.mjs` | The resolver's own suite, **plus Node↔Python parity** — the two implementations are run against the same inputs and must agree. Without this, "one resolver" would silently become two. |

Every tool resolves the install the same way: `--df-root` > `$DWF_DF_ROOT` > autodetect (Steam's
`libraryfolders.vdf`, then the usual spots) > a failure that says what to pass. Never a default.

**A suite either needs a DF install or it does not, and it says so.** With no install on the
machine, the whole sweep is **green**: every other suite passes, the live-server oracles skip
behind `live_guard.mjs`, the raws/art oracles skip behind `dfRootOrSkip`, and nothing is red. That
is exactly the set CI runs. On a machine WITH an install, the raws oracles run for real — the skip
is honest, not a way of hiding a broken test.

The suites that need a real install: `b36_wall_adjacency`, `b47_construction_floor`,
`b74_b93_surfaces`, `construction_remainder`, `wallsfix_construction`, `tx16_stone_wall_tint`, and
`tx17_planned_construction` (all read DF's `graphics_*.txt` raws as their ground truth).

## DF_LOCK — the single "who is driving DF" safety file

Only one process (or person) may drive DF at a time — launch/kill/load/click/pause, or anything
that saturates its render thread. The convention is a lock file, `tools/harness/DF_LOCK`, acquired
**atomically** — never an exists()-then-write check, which is a TOCTOU race. Use the helper, which
acquires via a noclobber (`O_EXCL`) create so exactly one racer wins, then re-reads to verify
ownership:

```sh
tools/harness/df_lock.sh acquire <name>          # exit 1 if held by someone else
tools/harness/df_lock.sh acquire <name> --wait   # or block, polling every 60s until free
tools/harness/df_lock.sh check                   # prints holder + timestamp, or "free"
tools/harness/df_lock.sh release <name>          # only releases if the lock is YOURS
```

`release` refuses to delete another holder's lock. The helper never auto-breaks a stale lock; a
dead holder's lock is cleared by a human. Python gates that need the lock create the file with an
`O_EXCL` open too. (`results/` and `DF_LOCK` are gitignored; `df_lock.sh` is committed.)

**`/tiledump?atlas=1` (full atlas dump) also requires this lock**, even though a plain
`/tiledump` (no atlas) is cheap and lock-free (~26ms, used by the parity gate's raw oracle): the
atlas hop copies DF's entire persistent texture set and saturates the render thread for 60-100+
seconds. See the unit-sprite gate's atlas-cache rule above (cache once, keyed by save, reuse;
refresh only under lock with explicit confirmation).

## Loader scripts

- `auto_load.sh` — fully autonomous deploy + load: kills DF, copies the DLL, relaunches, pins the
  window to (0,0,1400,1000), clicks Continue → World → Save via low-level `mouse_event` (AHK
  `SendInput` is ignored by DF's SDL2), verifies each menu transition via `dfhack-run lua`,
  retries, and ends with `capture-stream-start`. Click coordinates assume the pinned window and
  the current save list. Requires `DWF_AHK_EXE` pointing at a portable `AutoHotkeyU64.exe` (not
  committed) and, like all synthetic input, must never run while a human is using the machine —
  take `DF_LOCK` first. `./auto_load.sh noload` skips the deploy step.
- `deploy_load.sh` — earlier/simpler variant.
- `ahk/*.ahk` — the click/key scripts `auto_load.sh` uses.
- `ws_probe.py` — raw-socket WS probe (fast-draining, wss-capable): real fps/gaps without a
  browser. `python ws_probe.py <player> <secs> [wss:<host>] [proto1] [...]`. It counts EVERY WS
  frame (v1 BLOCK_SET/AUX binary frames AND ~25Hz cursor pushes); the gate criterion is a floor,
  so this only ever errs strict. See the file's docstring for its many probe tokens.

## Cloudflare tunnel (perf-gate dependency)

Quick tunnel: `cloudflared tunnel --metrics 127.0.0.1:20241 --url http://localhost:8765`
(run detached/hidden; survives DF restarts). ALWAYS pass `--metrics 127.0.0.1:20241` — the
gates auto-discover the current hostname from `http://127.0.0.1:20241/quicktunnel` and check
liveness via `/ready` (readyConnections ≥ 1). trycloudflare hostnames ROT when the tunnel
reconnects: never hardcode one in docs/scripts; if `/ready` shows 0 connections, kill and
relaunch cloudflared (the old hostname is gone from DNS).

## Gotchas (hard-won, do not relearn)

- NEVER hot-reload the plugin (`unload`/`load dwf`) — hangs/crashes DF. Full restart only.
- Copy the DLL only AFTER killing DF ("Device or resource busy" otherwise).
- 150% DPI: `mouse_event`+`SetCursorPos` use PHYSICAL pixels directly.
- Saves live under `%APPDATA%\Bay 12 Games\Dwarf Fortress\save\`, not the DF install dir.
- Only ONE DF instance ever (a 2nd steals DFHack's control port).
- A fresh save-load starts PAUSED — unpause via
  `dfhack-run lua "df.global.pause_state=false"` before measuring idle fps.
- Build (PATH needs the Strawberry Perl c+perl bins on it):
  `export PATH="<STRAWBERRY>/c/bin:<STRAWBERRY>/perl/bin:$PATH"`
  `cmake --build "$DWF_DFHACK_BUILD" --config Release --target dfcapture_public -- -m`
  DLL out: `$DWF_DFHACK_BUILD/plugins/external/multi-dwarf/Release/dwf.plug.dll`
  Deploy: kill DF → copy DLL to `<DF>\hack\plugins\` (`<DF>` = your resolved DF root)
  (+ `cp -r web/* "<DF>/hack/dfcapture-web/"` for client changes) → relaunch → load a save.
