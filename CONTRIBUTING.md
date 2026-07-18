# Contributing to Dwarf With Friends

Thanks for helping. A useful pull request here is small, testable, and clear about what it does not
verify.

## Set up and build

Read `AGENTS.md` before changing code; its DF safety rules are mandatory. Build the plugin against
DFHack 53.15-r2 by following [`docs/BUILD.md`](docs/BUILD.md). The browser client is plain JavaScript
with no npm install or bundling step.

## Test your change

Run the focused `tools/harness/*_test.mjs` suites covering the files you changed. Before opening a
PR, run every Node harness suite from repository root:

```powershell
Get-ChildItem tools/harness/*_test.mjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
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
skip honestly in CI. CI does not build the DLL; the pinned DFHack/MSVC build is a maintainer check.

## Pull requests

Keep one concern per PR. Include regression tests with behavior changes, run the relevant suites,
and list exact commands plus any skipped or unverified checks. Preserve unrelated files and never
commit generated review decks at repository root.

Good first areas include documentation corrections, offline fixture coverage, clearer diagnostics,
small host-installer checks, and isolated browser behavior with an existing DWFUI component. Issues
labelled `good-first-issue` should include the expected files and verification command.
