# Shared tool libraries

This directory centralizes policies reused by Node, Python, and shell tools.

Read first:

- `dfroot.mjs` — Node DF-root policy and skip/die APIs.
- `dfroot.py` — Python implementation kept in resolver parity.
- `dfroot.sh` — shell adapter to the Node resolver.
- `mdutil.mjs` — HTTP, auth, and DFHack helpers.

Do not create another DF-root resolver. Callers use `--df-root`, then `DWF_DF_ROOT`, then
autodetection; explicit bad paths fail loudly.
Harnesses use `OrSkip`; intentional human-run tools use `OrDie`.
Keep implementations in lockstep and run `dfroot_resolver_test.mjs`. Add no dependencies.
