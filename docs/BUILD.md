# Building Dwarf With Friends

> **Pre-release:** the build integration and output paths may change before the first stable release.

This plugin builds as an external plugin inside a DFHack 53.15-r2 source tree. The
repository's target is named `dfcapture_public`, with output name `dwf`.

## Requirements

- A DFHack 53.15-r2 source checkout, including its normal build prerequisites.
- **Windows:** an MSVC C++ toolchain. The target links Windows libraries `gdiplus`, `ole32`
  and `ws2_32`.
- **Linux:** GCC and DFHack's normal Linux prerequisites (cmake, ninja/make, zlib, SDL2
  headers, and Perl with `XML::LibXML`/`XML::LibXSLT` for the structures codegen). The
  target links only `dl`; images are encoded with the vendored `stb_image_write` instead
  of GDI+. Note for very new GCC (16+): DFHack's own `-Werror` trips a false-positive
  `-Warray-bounds` inside its library — configure DFHack without `-Werror` or add
  `-Wno-error=array-bounds`.
- CMake configured for the DFHack tree.

Platform parity: streaming works on both platforms. Two features remain Windows-only
because they call into the Windows DF binary at fixed addresses (per-player pan/zoom's
native map render, and native unit portraits) — Linux serves the shared-camera viewscreen
fallback and placeholder portraits.

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

On Linux the same external-plugin layout applies (a symlink works):

```sh
ln -s /path/to/this-repo /path/to/dfhack/plugins/external/multi-dwarf
printf 'add_subdirectory(multi-dwarf)\n' >> /path/to/dfhack/plugins/external/CMakeLists.txt
cmake -S /path/to/dfhack -B /path/to/dfhack/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build /path/to/dfhack/build --target dfcapture_public
```

The result is `build/plugins/external/multi-dwarf/dwf.plug.so`, deployed to
`<Dwarf Fortress>/hack/plugins/dwf.plug.so`.

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
