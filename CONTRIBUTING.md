# Contributing to Dwarf With Friends

Thanks for helping. A useful pull request here is small, testable, and clear about what it does not
verify.

## Choose the smallest useful path

- **Documentation, policy inventory, or browser fixture:** about 15 minutes to get started. You
  need Node, but not Dwarf Fortress, a compiler, or an npm install.
- **Native C++ change:** use the pinned DFHack 53.15-r2 build described below and include an offline
  regression test wherever the behaviour can be isolated.
- **Live-game change:** coordinate with a maintainer before testing. Use an approved disposable
  save, follow `AGENTS.md`, and state whether the check reads or changes the fortress.

## Set up and build

Read `AGENTS.md` before changing code; its DF safety rules are mandatory. Build the plugin against
DFHack 53.15-r2 by following [`docs/BUILD.md`](docs/BUILD.md). The browser client is plain JavaScript
with no npm install or bundling step.

## Test your change

Run the focused `tools/harness/*_test.mjs` suites covering the files you changed. Before opening a
PR, run the manifest-controlled offline battery from repository root:

```powershell
node tools/release/launch_preflight.mjs --stage=suites --json
```

Run Python unit tests when those areas change:

```text
Get-ChildItem tools/ws2/tests/test_*.py | ForEach-Object { python $_.FullName }
```

UI changes must use or extend `web/js/dwf-ui-components.js` and pass:

```text
node tools/harness/dwfui_boot_test.mjs
node tools/harness/ui_drift_guard_test.mjs
node tools/harness/ui_drift_guard_test.mjs --selftest
```

Server, transport, or renderer work also needs the relevant local gate in `tools/harness/README.md`.
`gate_perf.py`, `gate_parity.py`, and `gate_localnav.py`, plus suites guarded by `live_guard.mjs`,
stay local because they require a running fortress, native window, or performance hardware. The
DF-install oracles `b36_wall_adjacency`, `b47_construction_floor`, `b74_b93_surfaces`,
`construction_remainder`, `wallsfix_construction`, `tx16_stone_wall_tint`, and
`tx17_planned_construction` run locally when an install is available and
skip honestly in CI. Windows CI compiles the plugin against pinned DFHack 53.15-r2; maintainers also
record a local build receipt before packaging a release.

## Pull requests

Keep one concern per PR. Explain the data flow and failure behaviour, include regression tests with
behaviour changes, run the relevant suites, and list exact commands plus any skipped or unverified
checks. Say what you intentionally left unchanged so reviewers can see the boundary of the work.
Preserve unrelated files and never commit generated review decks at repository root.

AI assistance is welcome, but the author owns every submitted line. Disclose where AI materially
shaped the patch, then explain the important behaviour in your own words: inputs, validation,
state changes, failure path, and tests. If you cannot explain a generated section yet, reduce or
rewrite it before asking somebody else to maintain it.

Good first areas include documentation corrections, offline fixture coverage, clearer diagnostics,
small host-installer checks, and isolated browser behavior with an existing DWFUI component. Issues
labelled `good-first-issue` should include the expected files and verification command.
