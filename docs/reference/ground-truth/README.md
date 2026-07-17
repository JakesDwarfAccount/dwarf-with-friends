# Ground-Truth Registry

This directory is the public, rebuildable index of native Dwarf Fortress facts. It contains
paraphrased facts and stable evidence IDs only. Decompiled text, disassembly, raw recorder planes,
and absolute private paths stay in the private evidence vault.

Version 1 schemas live in `schema/v1/`. The validator (maintainer-only tooling, not part of this
public distribution) applies the schema for each record type, then checks IDs, build
applicability, evidence references, parent/child symmetry, mapping references, status
prerequisites, and the private/public boundary.

The pipeline's generated coverage report is `build/ground-truth/coverage.json` and is
intentionally ignored. It reports
native and implementation coverage, evidence and verification debt, conflicts, and explicit gaps.
Product-orphan scanning remains visibly `not-scanned` until its later phase lands. Rebuild
candidates are computed only from each mapping's required audit classification and findings; an
unexplained disposition cannot silently become an empty, apparently green result.

The initial build and evidence manifests are in `builds/` and `evidence/`. Rules 0001–0003 retain
their readable Markdown in `docs/reference/rules-ledger/`; their adjacent `*.registry.json` files
are the machine-readable sidecars. Recorder reducers now distinguish captured, confirmed,
inconclusive, and disputed facts. A corpus contradiction remains visible and blocks implementation
or audit tasks until research resolves it; it is never rewritten into a passing observation.

Computed status is represented now so gaps are explicit, but the registry does not yet provide a promotion
writer. Later phases must use the dedicated promotion/gate path instead of editing an axis merely to
make a task pass.
