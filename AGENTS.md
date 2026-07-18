# Agent instructions — Dwarf With Friends

Instructions for AI coding agents (and a fast orientation for humans). This project is a DFHack
plugin plus a browser client that lets several people play one Dwarf Fortress fortress together.
Much of it was built with AI assistance under test-driven parity discipline — these rules are what
kept that honest. Follow them.

## Orientation

- `README.md` — what the project is; `docs/MAP.md` — where everything lives.
- `docs/ARCHITECTURE.md` — plugin ↔ server ↔ client data flow.
- `docs/BUILD.md` — building the plugin DLL (CMake, DFHack 53.15-r2 source tree required).
- `docs/DEVELOPMENT.md` — dev workflow, test harness, and the DWFUI component rules.
- `docs/NAMING.md` — why some runtime identifiers still say `dfcapture`. Do not "fix" them.

## Hard rules

1. **Native Dwarf Fortress behavior is the authority.** This project reproduces DF's real UI and
   behavior in the browser. Never invent plausible behavior for a screen you cannot verify against
   the native game — implement it fail-closed (visible, honest "unavailable") instead. Plausible
   inventions are this codebase's defining bug class; several shipped ones took days to root out.
2. **No hand-built UI controls.** All browser UI goes through the shared DWFUI component layer
   (`web/js/dwf-ui-components.js`). `tools/harness/ui_drift_guard_test.mjs` (both modes) and
   `dwfui_boot_test.mjs` enforce this; do not grow the drift baseline.
3. **Cache busters are mandatory.** Any changed file under `web/` must get a bumped `?v=` query in
   `web/index.html` in the same commit. Tests enforce this; reviewers check it.
4. **Comments carry constraints.** Existing comments record non-obvious facts about DF internals,
   wire formats, and test pins. Don't delete them because they look verbose; don't add narration
   about your own process. Some comments cite internal design specs (`docs/superpowers/...`) that
   are not included in this public distribution; the behavior they describe is pinned by the
   shipped tests — see `docs/NAMING.md`.
5. **Test evidence over claims.** A change isn't done until the relevant harness suites pass and
   you've reported their actual output. Exit code 0 from a build script is not a success signal.

## Build and test

- Build: see `docs/BUILD.md`. The CMake target is `dfcapture_public`; the output DLL is
  `dwf.plug.dll` (target name ≠ output name, deliberately — see `docs/NAMING.md`).
- Test: suites live in `tools/harness/` and run with plain Node, e.g.
  `node tools/harness/panel_frame_test.mjs`. The one-command battery is
  `node tools/release/launch_preflight.mjs --stage=suites`.
- Some suites need artifacts a bare clone doesn't have (a built DLL, a git checkout with history,
  recorded evidence corpora). Those suites skip or fail with a clear message; that is expected and
  documented in `tools/harness/TEST-MAP.md`.

## Danger zones — never run casually

- Anything that deploys to or reads from a **live running Dwarf Fortress** (deploy scripts,
  `gate_unitsprites.py --refresh-atlas`, flight-recorder captures). Some of these freeze the game
  for a minute or more; all of them require the human at the keyboard to have agreed first, and
  several are interlocked behind explicit confirmation flags and a `DF_LOCK` file. Respect both.
- Never copy a plugin DLL while DF is running. The deploy flow is: stop DF → copy → start DF once.
- `hack/plugins/` must contain exactly one copy of this plugin. Two DLLs (old + new name) will
  both load and contend for the same port and state.

## Conventions

- C++ (plugin): match the existing style in `src/`; cite DF structure offsets/decompilation
  evidence in comments when adding memory reads, as the existing code does.
- JavaScript (client): no frameworks, no build step — files under `web/js/` load directly.
  Match the module pattern of neighboring files.
- Commits: imperative subject, scoped prefix when natural (`web:`, `plugin:`, `docs:`, `harness:`).
- When behavior differs between the GL and canvas renderers (`dwf-gl.js` / `dwf-tiles.js`), it's a
  bug: shared logic must resolve identically in both, and parity tests pin this.
