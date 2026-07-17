# Reproduction tools

These focused scripts recreate known transport, save, and session failures.

Read first:

- `save-spam.mjs` — save-gate behavior and recovery.
- The script header for exact prerequisites and safety rules.
- `../harness/README.md` — live opt-in and DF locking.

Assume repro scripts can affect a world even when they look diagnostic.
Do not run against localhost or another live server without explicit authorization and `--live`.
Acquire `DF_LOCK` before driving DF. Keep an offline or stub mode when adding repros.
