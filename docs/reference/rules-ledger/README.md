# Rule Ledger

The verification loop's output (Pillar 5 of the ground-truth pipeline design). Each entry is a rule
about how native DF behaves, with the evidence that earned it.

Rules 0001-0003 also have adjacent `*.registry.json` sidecars. The Markdown remains the readable
explanation; the sidecar is the validated machine authority for stable IDs, fact-level evidence,
uncertainty, required counterexamples, recorder slices, and independent status axes. The registry
validator that checks both is maintainer-only tooling, not part of this public distribution.

**What is allowed in here: paraphrased facts only.** Plain-English statements of a rule,
addresses, hashes, field names, constants. **Never** decompiled code, disassembly listings,
string dumps, or any other excerpt of the game binary — that material stays in a private
decompilation workspace (outside this repo) and does not get committed here, ever.

## Entry format

One file per rule, `NNNN-slug.md`:

- **Rule** — the plain statement.
- **Binary evidence** — exe identity (SHA-256 + PE timestamp + DF version) and the address
  of the function whose logic states the rule. Status `binary-read` when an agent has read
  the condition in the oracle's decompiler output.
- **Corpus evidence** — Flight Recorder frame ids that confirm the rule empirically.
  Status `corpus-confirmed` when a reducer has replayed the predicate over the corpus.
- **Predicate** — a small JS module in `predicates/` that, given a state slice, predicts
  the screen fact.
- **Status ladder** — `hypothesized` → `binary-read` → `corpus-confirmed` → `shipped`.
  A rule needs BOTH binary-read and corpus-confirmed to ship. Shipped rules cite their
  ledger entry in code.

## Reproducing a binary read

The oracle workspace is a local decompilation working directory (local machine only; gitignored tooling).
Its README documents the string index (`build/strings.jsonl`), verified DFHack symbols
(`build/symbols.json`), and the headless Ghidra queries (`scripts/ghidra/OracleWho.java`,
`OracleHunt.java`). Every binary-evidence citation below names the exe hash so a re-read
can prove it is looking at the same build.
