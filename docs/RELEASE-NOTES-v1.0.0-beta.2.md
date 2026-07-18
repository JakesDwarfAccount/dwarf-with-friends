# Dwarf With Friends v1.0.0-beta.2

A compatibility + fix release, prompted by the beta's first field bug report
([issue #1](https://github.com/JakesDwarfAccount/dwarf-with-friends/issues/1) — thank you!).

## DFHack 53.15-r2 (the headline)

The plugin is now built for **DFHack 53.15-r2** — the current release, and the version Steam
auto-updates to. beta.1 was built for 53.15-r1; DFHack refuses to load a plugin built for any
other release, so beta.1 on an r2 install failed with
`capture-stream-start is not a recognized command`.

If you installed DFHack yourself for beta.1, run `DWF Setup.cmd` again after upgrading — it
installs 53.15-r2 if DFHack is missing, and re-installs the mod either way.

## Clothed dwarves

Units on the map are now drawn with their real in-game composited sprites — clothes, dyes, and
all — instead of the static base creature art. (The compositing pipeline shipped in beta.1 but was
never switched on; dwarves rendered "naked" in the browser as a result.) The sprites stream in as
DF renders them, so allow a moment on first load. Kill switches, if anything misbehaves on your
hardware: `capture-unit-sprites off` (and `capture-unit-census off`) in the DFHack console.

## Clearer failures and setup

- If hosting fails because the plugin didn't load, the host panel now explains the actual cause
  (DFHack version mismatch or missing plugin) instead of echoing the raw DFHack error.
- Setup no longer waves through a DFHack whose version it cannot read — it asks you to confirm or
  installs the known-good version. Version detection also works on stock official DFHack zips now.
- Docs spell out that the desktop shortcut and `Dwarf With Friends.cmd` are the same thing, and
  that the host panel opens in your browser. TROUBLESHOOTING has a section for the
  `not a recognized command` error.

## Install and host

1. Extract the release zip.
2. Run `DWF Setup.cmd` and follow the setup page in your browser.
3. Open **Dwarf With Friends** (desktop shortcut or `Dwarf With Friends.cmd` — same thing), choose
   **Start hosting**, load a fortress, and share the friend link (and the join password, if you
   set one) from the host panel.

See [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) if setup stops or the friend link does not appear.

## Known issues

- The stale-build-sidebar crash window from beta.1 remains (rare; needs an upstream change).
- On worlds with pre-existing save corruption, generating a missing unit portrait can trip a fault
  inside DF's own view-sheet code. The generator now shuts itself down for the session on the
  first such fault and portraits fall back to simpler sources — you'll see a
  `portrait view-sheet generation disabled` line in `dwf.log` if it happens. Healthy worlds are
  unaffected.

## Licence and credits

Dwarf With Friends is AGPL-3.0-only, runs on DFHack, grew out of SourceAirbender's multi-dwarf /
dfcapture, and continues the multiplayer approach of DFPlex and webfort. See the repository's
`NOTICE` and `LICENSE` files for the full credits and licence texts.
