# Host installer and control panel

This contains the zero-dependency Node installer and local host-management UI.

Read first:

- `install.mjs`: install, backup, receipt, and `--check` flow.
- `hostlib.mjs`: shared DF-root resolution and filesystem policy.
- `host_panel.mjs`: host-panel backend entry point.
- `panel.js`: browser-side host controls.
- `download-manifest.json`: packaged-file inventory.

Dev entry points: the repository-root `.cmd` launchers start this code on a dev machine
(`DWF Setup.cmd` → `setup.mjs`; `Dwarf With Friends.cmd` → `host_panel.mjs --open`;
that filename is the desktop-shortcut target `setup.mjs` creates: keep it stable).
Players never see those files: the release zip synthesizes its own launchers around the bundled
Node runtime. See [development](../docs/DEVELOPMENT.md).

Never hardcode a machine's Dwarf Fortress path. Preserve the resolution order:
`--df-root`, `DWF_DF_ROOT`, then Steam/common-location autodetection.
Do not remove backup or receipt checks to make an install appear successful.
Keep the installer runnable with stock Node and no dependencies.
