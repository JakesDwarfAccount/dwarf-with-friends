# Building Dwarf With Friends

> **Pre-release:** the build integration and output paths may change before the first stable release.

This plugin builds as an external plugin inside a DFHack 53.15-r2 source tree. The
repository's target is named `dfcapture_public`, with output name `dwf`.

## Requirements

- A DFHack 53.15-r2 source checkout, including its normal build prerequisites.
- Windows and an MSVC C++ toolchain. The target links Windows libraries `gdiplus`, `ole32`
  and `ws2_32`, and streaming is compiled only on Windows.
- CMake configured for the DFHack tree.

cpp-httplib is vendored under `third_party/cpp-httplib` and is added as a private include
directory by this project's CMake file.

## Add the external plugin

Place or junction this repository at:

```text
<dfhack-source>/plugins/external/multi-dwarf/
```

Ensure DFHack's `plugins/external/CMakeLists.txt` includes the external plugin directory;
this worktree's known build integration uses that mechanism.

Configure DFHack using its normal Windows build instructions, then build only this target:

```powershell
cmake --build C:/path/to/dfhack/build-msvc --config Release --target dfcapture_public
```

In the repository's established layout, the result is
`build-msvc/plugins/external/multi-dwarf/Release/dwf.plug.dll`.

## Build stamp

CMake defines `DFCAPTURE_GIT_HASH` for the target. It uses `DFCAPTURE_BUILD_STAMP` when
provided, otherwise the current nine-character Git hash, otherwise `dev`.

For a source export without `.git`, supply an explicit stamp while configuring DFHack:

```powershell
cmake -S C:/path/to/dfhack -B C:/path/to/dfhack/build-msvc `
  -DDFCAPTURE_BUILD_STAMP=my-release-stamp
```

The server combines that value with the wire fixture CRC for the build identity returned
to the browser.

## Install the result

Copy the DLL to `<Dwarf Fortress>/hack/plugins/dwf.plug.dll`. Copy `web/` to
`<Dwarf Fortress>/hack/dfcapture-web/`, `dwf.lua` to BOTH
`<Dwarf Fortress>/hack/lua/plugins/dwf.lua` and `<Dwarf Fortress>/hack/scripts/dwf.lua`
(the legacy path, kept in sync so the installer's drift check stays green), and
`scripts/gui/dwf.lua` to `<Dwarf Fortress>/hack/scripts/gui/dwf.lua`.

Do not replace the DLL while Dwarf Fortress is running; the repository's deployment
procedure stops DF before copying it.
