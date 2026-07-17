# Host installer and control panel

This contains the zero-dependency Node installer and local host-management UI.

Read first:

- `install.mjs` — install, backup, receipt, and `--check` flow.
- `hostlib.mjs` — shared DF-root resolution and filesystem policy.
- `host_panel.mjs` — host-panel backend entry point.
- `panel.js` — browser-side host controls.
- `download-manifest.json` — packaged-file inventory.

Never hardcode a machine's Dwarf Fortress path. Preserve the resolution order:
`--df-root`, `DWF_DF_ROOT`, then Steam/common-location autodetection.
Do not remove backup or receipt checks to make an install appear successful.
Keep the installer runnable with stock Node and no dependencies.
