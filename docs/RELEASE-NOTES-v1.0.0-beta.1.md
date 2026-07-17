# Dwarf With Friends v1.0.0-beta.1

This is the first public release of Dwarf With Friends: simultaneous multiplayer for modern Dwarf
Fortress. The host runs the live game and friends join from a browser link.

It ships as a **beta**: the everyday workflows of fortress play are built and tested, and we've
played full co-op sessions on it for weeks — but it hasn't met the wider world's hardware, forts,
and habits yet. Expect rough edges on rare screens; report anything odd and it will get fixed.

## Before you install

- The host needs Windows and Dwarf Fortress.
- Download `DwarfWithFriends-v1.0.0-beta.1.zip` from this release, not a source-code archive or branch.
- Setup installs the supported DFHack version (53.15-r1) and cloudflared automatically if they are
  missing; a portable Node runtime is bundled in the zip.

## Important for existing installs

DFHack loads *every* DLL in `hack/plugins/`. If a new `dwf.plug.dll` is installed while an old
`dfcapture.plug.dll` is still present, DF would load **both** — two copies of the plugin contending
for the same HTTP port and DF state, behaving erratically rather than crashing cleanly.

**DWF Setup.cmd removes these old files automatically** — it quarantines any obsolete
`dfcapture.plug.dll` and `hack/lua/plugins/dfcapture.lua` when it runs. If you are upgrading by hand
instead of using setup, delete those two files yourself before starting the server.

## Install and host

1. Extract the release zip.
2. Run `DWF Setup.cmd` and follow the setup page in your browser.
3. Open **Dwarf With Friends**, choose **Start hosting**, load a fortress, and share the friend link
   (and the join password, if you set one) from the host panel.

See [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) if setup stops or the friend link does not appear.

## Known issues

- If a player deletes a building at the exact moment the host has the native **build sidebar**
  open on that same building, the host's next click in that sidebar can crash DF. The window is
  narrow (it requires clicking a stale build menu) and rare in normal play; a proper fix needs an
  upstream change and is planned. Everyday deletes — including deleting things other players are
  merely viewing — are safe: the game's interface caches are cleared before anything is freed.

## Licence and credits

Dwarf With Friends is AGPL-3.0-only, runs on DFHack, grew out of SourceAirbender's multi-dwarf /
dfcapture, and continues the multiplayer approach of DFPlex and webfort. See the repository's
`NOTICE` and `LICENSE` files for the full credits and licence texts.
