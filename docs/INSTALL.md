# Installing Dwarf With Friends

Dwarf With Friends is simultaneous multiplayer for modern Dwarf Fortress. You (the host)
run the live game; your friends join from a browser link. Everyone playing should own a copy of
Dwarf Fortress: please grab it on Steam and support Bay 12.

The supported way to install is the one-click setup in the release zip: **DWF Setup.cmd** on
Windows, **`./dwf-setup.sh`** on Linux. It verifies and repairs an existing install too, so
it can repair missing or stale mod files. Close Dwarf Fortress before updating.

## What you need

- **Host:** Windows or Linux, and Dwarf Fortress 0.53.16. Setup installs everything else it needs ,
  DFHack 53.16-r1 and cloudflared are downloaded automatically if they are missing, and a
  portable Node runtime is bundled in the zip. Nothing to build.
- **Friends:** a desktop browser and the link you share.

**If you are hosting on Linux, read this first.** Hosting works on Linux, but only since beta.3,
and it has had far less real-world play than Windows. Streaming works on both platforms; two
features remain Windows-only because they call into the Windows DF binary at fixed addresses
(per-player pan/zoom's native map render, and native unit portraits): Linux serves the
shared-camera viewscreen fallback and placeholder portraits. Your friends still get their own
cursors, designations, menus, and panels; they share the host's view of the map.

## Install and host

1. **Download** the zip that matches the machine running Dwarf Fortress: `DwarfWithFriends-v…`
   for Windows, `DwarfWithFriends-v…-linux` for Linux: from the release, not a source-code
   archive or a branch.
2. **Unzip** it anywhere on your Windows or Linux PC.
3. **Double-click `DWF Setup.cmd`**: on Linux, run `./dwf-setup.sh` from a terminal instead. A
   small console window opens (on Linux, the terminal you started it from); this is the engine
   log, so minimize it but leave it open. The setup page opens in your browser.
4. **Follow the setup page.** It walks these steps in order and only changes anything after
   you click:
   - point it at your Dwarf Fortress folder (the one with `Dwarf Fortress.exe`, or `dwarfort`
     on Linux); it auto-detects common Steam locations;
   - install or verify **DFHack 53.16-r1** (downloaded automatically if missing; the
     plugin loads only in exactly this DFHack version);
   - install the mod into the correct plugin paths (upgrade-safe: it backs up anything it
     overwrites);
   - bake sprites from your own Dwarf Fortress art (DF Classic has no premium art: the
     game still works and friends see simple placeholders);
   - fetch **cloudflared** for internet play;
   - create a **Dwarf With Friends** desktop shortcut (on Linux, an entry in your applications
     menu, and on your desktop if you have one).
5. **Linux only: set Dwarf Fortress's Steam launch options, once.** In Steam, right-click
   **Dwarf Fortress** → **Properties** → **Launch Options**, and enter exactly:

   ```text
   sh -c 'exec "./dfhack"' %command%
   ```

   The host panel starts the game through Steam so it gets Steam's own per-game environment,
   and Steam applies these options when it does: they are what make DFHack come up with the
   game. Without them Dwarf Fortress starts on its own and hosting never begins.
6. **Host.** Open **Dwarf With Friends** (the desktop shortcut, or `Dwarf With Friends.cmd`
   in the unzipped folder: on Linux, `./dwarf-with-friends.sh`: they are the same thing).
   The **host panel** opens in your browser automatically; if it doesn't, the address is
   printed in the console window (something like `http://127.0.0.1:8812`). In the host panel:
   - optionally set a **join password** on the Access tab. There is none by default: the
     random tunnel link is unguessable, so treat the link itself like a secret. Anyone who
     has the link (and the password, if you set one) can join;
   - click **Start hosting**. Dwarf Fortress opens; load a fortress and the panel creates
     the friend link;
   - **share the friend link (and password, if you set one)** shown under "Send this to your
     friends." For
     internet play the panel starts a cloudflared tunnel and shows a public HTTPS link;
     for a LAN game it shows your local address.

## Fresh friends join from a browser

They open the link, type a display name (and the join password if the host set one), and they
are in the fortress, straight from their browser.

Once connected, each player has their own camera; open the lobby to jump to another
player's view or follow it. Per-player client settings (zoom, UI scale, and more) live in
the browser Settings panel.

## Upgrading, verifying, or repairing an install

Re-run **DWF Setup.cmd** (**`./dwf-setup.sh`** on Linux) at any time. It re-checks every step,
re-copies stale files, and quarantines the obsolete `dfcapture.plug.dll` and
`hack/lua/plugins/dfcapture.lua` left by an older build so DFHack cannot load two competing
copies of the plugin. The live served web root `hack/dfcapture-web` is preserved and refreshed in
place (only a leftover `dfcapture-web.old`, if any, is removed): the web root keeps its
`dfcapture-web` name this release. If you ever placed files by hand, see the fallback below.

## Advanced: manual file placement (fallback only)

The one-click installer above is the supported path; use it unless you have a specific
reason not to. If you must place the plugin by hand, the shipped plugin files use the `dwf.*`
identity (dll, Lua bridge, and in-game script); the served web root keeps its `dfcapture-web`
name this release. Everything goes under your Dwarf Fortress `hack/` folder:

```text
<Dwarf Fortress>/
└── hack/
    ├── plugins/dwf.plug.dll          the plugin
    ├── lua/plugins/dwf.lua           the plugin's Lua module (this exact path only)
    ├── scripts/dwf.lua               a second copy of the module (legacy path, kept in sync)
    ├── scripts/gui/dwf.lua           the in-game control window (run gui/dwf)
    └── dfcapture-web/                 the browser client (served web root)
```

On Linux the tree is the same under `hack/`, except the plugin itself is `dwf.plug.so` instead of
`dwf.plug.dll` (`hack/plugins/dwf.plug.so`); if you copy it by hand, give it `chmod 0755`.

The Lua module must be at `hack/lua/plugins/dwf.lua` exactly: placed elsewhere the map
still streams but everything the module powers (workshop tasks, locations, and more) is
silently missing. A DFHack update can overwrite `hack/lua/plugins/`, so recopy after
updating DFHack. Then load a fortress and control the stream from the in-game window
(`gui/dwf`) or the host panel.

## Configuration

Host-side settings: join password, remote audio, pause policy, and bind address: are in
[CONFIG.md](CONFIG.md). If setup stops or the friend link does not appear, see
[TROUBLESHOOTING.md](../TROUBLESHOOTING.md).
