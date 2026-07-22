## What changed

<!-- Keep this to one concern and explain the user-visible or technical outcome. -->

## Intentionally unchanged

<!-- State the boundary of this PR. Name nearby behaviour or cleanup you deliberately did not alter. -->

## Data flow and failure behaviour

<!-- In plain English: what enters, what validates it, what state changes, and what the user sees if it fails? -->

## Verification

<!-- List exact commands and results. Do not write "tests pass" without naming them. -->

- [ ] Focused regression tests added or updated
- [ ] Relevant Node harness suites pass
- [ ] Python suites pass when applicable
- [ ] UI work uses DWFUI and passes both drift-guard modes
- [ ] Local-only build/live/perf/parity checks are listed below when applicable

## Risk check

- [ ] Public/pre-login route policy is unchanged, or its inventory and tests are updated
- [ ] Host-only and player authority boundaries are unchanged, or covered by regression tests
- [ ] New queues, files, logs, or request bodies have explicit size/time limits
- [ ] Native writes notify the stream only after success

## AI assistance and explain-back

<!-- Say where AI materially shaped the patch, or write "None". -->

<!-- Explain the important implementation in your own words. The author owns every submitted line. -->

## Missing or unverified

<!-- Explicitly list skipped checks, unavailable DF/save context, and remaining risk. -->
