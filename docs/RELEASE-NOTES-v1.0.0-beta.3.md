# Dwarf With Friends v1.0.0-beta.3

Beta 3 is mostly about making Dwarf With Friends harder to break. It has been through several
hours of real fortress play with two browser players, repeated saves, returns to the menu,
reconnects, and full game exits. Saving and returning to the menu now works reliably, and a full
exit finishes cleanly after a short delay instead of hanging forever.

## Linux hosting is here

There are now separate downloads for Windows and Linux. Pick the one that matches the computer
running Dwarf Fortress. Adding Linux support does not change the Windows plugin or installer.

The Linux package includes its own plugin, setup script, host launcher, DFHack installer, and
cloudflared setup. Core streaming and hosting work on both platforms. Linux currently uses the
shared host camera and placeholder unit portraits because the independent native map renderer and
native portrait renderer call Windows-specific Dwarf Fortress code.

## Saving and quitting are much safer

Beta 3 closes several different ways the game could become stuck while saving, returning to the
menu, or quitting:

- render-thread waits now have a firm timeout
- new world requests are stopped while a fortress is unloading
- active network connections are woken up during shutdown
- teardown no longer tries to re-enable an overlay while the whole process is exiting

In the final playtest, saving and returning to the menu succeeded. Quitting the game took about
three seconds and then closed normally.

## Portraits fail safely

Native unit portraits have better guards, pacing, and error handling. If portrait generation is
not available or fails, the browser stops retrying and falls back to a simple glyph portrait. A
bad portrait request should no longer turn into a request storm or threaten the host game.

## Fortress management fixes

- damaged stockpile settings are repaired when they are loaded instead of being passed deeper into
  Dwarf Fortress
- disbanding a squad now performs the same important cleanup as the native game
- stockpile, zone, placement, and automining requests have stronger validation and clearer errors
- server endpoints are more consistent about reporting whether an action actually succeeded

## Contributor and developer improvements

Beta 3 includes two pull requests from William Wilkins, also known as `catagris`:

- PR #2 bounded a render-thread wait that could otherwise stall forever
- PR #3 added the Linux build, installer, launcher, and packaging path

The public repository also gains Windows native-build CI, platform-aware test coverage, and new
documentation for the browser dependencies, Dwarf Fortress memory access rules, network protocol,
security model, maintainers, and project lineage.

## Downloads

- Windows: `DwarfWithFriends-v1.0.0-beta.3.zip`
- Linux: `DwarfWithFriends-v1.0.0-beta.3-linux.zip`

Both packages target Dwarf Fortress 0.53.15 with DFHack 53.15-r2. The setup launcher downloads and
checks the correct DFHack build for its platform.

## Still beta

The common fortress flows are in good shape, but plenty of interface work remains. Trading, some
parts of hospitals and justice, missions, diplomacy, petitions, and other less common screens can
still require the host to use the native game. Linux support is new and has had less real-world
testing than Windows, so Linux hosts should report any platform-specific trouble they find.
