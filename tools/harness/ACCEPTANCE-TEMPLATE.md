# Acceptance-test template (every Phase-4 spec item copies this block)

Every work item in a Phase-4 spec MUST end with an `## Acceptance` block in this exact
shape. "Done" = the gate command exits 0 and the evidence artifact exists — verified with
actual output pasted into the PR/commit/report, never asserted. No spot-checks.

```markdown
## Acceptance

- **Gate command(s)** (run from `tools/harness/`, DF loaded per README):
  - `python gate_perf.py --secs 20`            # if the change touches server/transport/client draw
  - `python gate_parity.py --camera X,Y,Z --max-score <N>`
                                               # if the change touches rendering/coverage
  - `<item-specific check>`                    # e.g. curl a new endpoint, a unit script, a
                                               # /diag field assertion — must be a COMMAND, not a look

- **Pass criteria** (objective, numeric):
  - perf: exit 0 (>=29.5fps, 0 gaps, 0 stalls, all phases incl. tunnel + pan)
  - parity: score_mae <= <N> at the pinned scene(s) below; bad_tile_pct must not increase
    vs the item's starting baseline (state the baseline JSON path)
  - item-specific: <exact expected output/values>

- **Pinned scene(s)**: camera `X,Y,Z` on save `region1` (list the scenes this item must
  affect; parity runs are only comparable at the same camera + same save state)

- **Evidence artifact(s)**: `tools/harness/results/<run>/parity.json` + `heatmap.png`
  (or `results/perf-<utc>.json`) — paste score/fps lines into the completion report.

- **Regression guard**: which OTHER gate(s) must still pass untouched (usually: perf gate
  after any client change; parity score must not grow after any renderer refactor).
```

Rules:
- A parity threshold `<N>` is set by the spec author from the CURRENT baseline for that
  scene (run the gate before writing the spec; put the number in the spec).
- If an item cannot be gated by perf/parity, the spec author must define a command-based
  check (curl + grep counts as one). "Renders correctly" is not a criterion.
- Scenes: prefer the standard baseline camera (65,82,161 surface) plus one item-relevant
  scene (e.g. an underground z for fog work, a workshop-heavy view for building art).
