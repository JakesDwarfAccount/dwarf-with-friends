# Troubleshooting Dwarf With Friends

Start here if setup or hosting stops before you get a link. These instructions assume you
downloaded Dwarf With Friends from the project's official [GitHub Releases](https://github.com/JakesDwarfAccount/dwarf-with-friends/releases)
page.

## First load, and the refresh fix

**The very first time you open the fort, give it ~30 seconds.** The art streams in as it loads,
so the map can look sparse or partly blank for a moment before everything pops in. If it seems
stuck, refresh the tab once or twice — the first load is the slow one.

After that, if something looks wrong **while playing**, refresh the tab — and if a normal refresh
doesn't do it, hard-refresh with **Ctrl+Shift+R**. This fixes most transient issues:

- units drawn as **yellow circles** or tiles as **blue boxes** (sprite art didn't finish loading);
- the map stuck partially loaded or frozen;
- panels or windows behaving oddly after the host restarted the game.

Nothing is lost by refreshing: you rejoin automatically with your name and the fort streams right
back in.

**If some sprites stay yellow dots no matter how many times you refresh** — usually rarer things
like a visiting bard or a specific creature — it's because that art hasn't been generated yet.
The fix is on the **host's** side: the host tabs into their Steam client and simply *looks at*
those tiles on their screen for a moment. That makes the game render the missing sprites, which
then propagate to every browser immediately. (A friend refreshing won't fix it; the host viewing
them will.)

If a problem *survives* a hard refresh and isn't the host-view case above, it's worth reporting.

## The game is laggy or choppy while playing

Press **F3** in the browser to open the diagnostics overlay. It shows how your session is
actually running, which points straight at the cause.

**Transport** — how map data is arriving:

- **`WS delta`** is what you want: a live WebSocket sending only what changed. Smooth.
- If it says it fell back to **HTTP polling**, the WebSocket didn't connect, and you'll get
  periodic hitching. Fixes, in order: **hard-refresh** (Ctrl+Shift+R); try a **different browser**
  (some browsers' privacy/ad-block extensions or aggressive shields interfere — Chrome with
  extensions paused is the safe baseline); disable browser extensions for the game's page. If
  you're the host and *everyone* is on HTTP, a firewall or proxy is blocking the socket.

**Renderer** — how the map is drawn:

- **`gl`** (WebGL) is the fast default and runs at your monitor's refresh rate.
- **`canvas2d`** is the automatic fallback if your browser can't do WebGL (old GPU, disabled
  hardware acceleration, a lost graphics context). It works but is slower on big, busy views.
- If you're on `canvas2d` and want to force WebGL back: make sure **hardware acceleration** is ON
  in your browser settings, then reload. You can also force a renderer with a URL switch —
  add `?renderer=gl` (or `?renderer=canvas2d`) to the `/view` address — handy for testing which
  one behaves better on your machine.

**Other lag causes worth checking:**

- **A slow or distant tunnel.** If you're joining over a `trycloudflare.com` link, all traffic
  detours through Cloudflare — usually fine, but a bad route adds latency for everyone. For a
  regular friend group, a Tailscale connection is often snappier (see the manual-install guide).
- **A huge, busy fort.** Hundreds of active units or a full-screen zoomed-out view is more work to
  stream and draw. Zooming in a little, or a smaller window, lightens both the network and the
  renderer.
- **Too many browser tabs / low memory.** The client keeps a map cache; a machine already tight on
  RAM will stutter. Close heavy tabs and other apps.
- **The host machine is the bottleneck.** If the host's own game is chugging, everyone feels it —
  the fort only streams as fast as it simulates.

If none of that helps and it *survives a hard refresh*, capture what F3 shows (transport,
renderer, and the FPS/latency numbers) and include it when asking for help — it tells us exactly
which layer is slow.

## Windows asks whether to run `DWF Setup.cmd`

A freshly downloaded `.cmd` file is expected to show a Mark-of-the-Web warning with **Run** and
**Cancel** choices. Choose **Run** to open setup. The exact Windows wording has not yet been
confirmed on the required clean-machine test, so it is deliberately not quoted here.

If you downloaded the file from anywhere other than the official Releases page, choose **Cancel**
and get a fresh copy from Releases.

## Antivirus removed the plugin DLL

Some antivirus tools may quarantine `dwf.plug.dll` as a false positive. Only restore it if it came
from the official GitHub Release.

For Windows Security:

1. Open **Windows Security** → **Virus & threat protection** → **Protection history**.
2. Open the entry for `dwf.plug.dll`, then choose **Actions** → **Restore** or **Allow on device**.
3. Under **Virus & threat protection settings**, open **Manage settings** → **Exclusions** →
   **Add or remove exclusions**. Add both copies of `dwf.plug.dll`—the one under the extracted
   `DwarfWithFriends\release` folder and the one under your Dwarf Fortress `hack\plugins` folder—as
   file exclusions.
4. Run `DWF Setup.cmd` again so setup can replace the missing file.

For another antivirus product, restore `dwf.plug.dll` from its quarantine and allowlist both the
release copy and the copy in Dwarf Fortress's `hack\plugins` folder before running setup again.

## Port 8765 is already in use

Dwarf With Friends uses port 8765 by default. Another copy of Dwarf With Friends, an old plugin,
or another program may already be using it.

1. Close any other Dwarf Fortress or Dwarf With Friends window, then try **Start hosting** again.
2. If the port is still busy, open **Config** in the host panel, change **Game connection port**
   from `8765` to another unused port such as `8766`, choose **Save config**, and start hosting
   again.
3. If you upgraded from an older build, also follow [Remove the old plugin after upgrading](#remove-the-old-plugin-after-upgrading).

## The friend link never appears

The friend link comes from cloudflared, the tunnel that lets friends reach you over the internet.
Leave Dwarf Fortress and the Dwarf With Friends engine window open while it starts.

The host panel shows the tunnel's status and a live log tail — check it for the reason the link
didn't appear (no network connection, a blocked cloudflared process, and so on). If it stays stuck
waiting for a link, use the panel's **Restart the tunnel** button. The same log is written to
`host/cloudflared.log` inside the extracted `DwarfWithFriends` folder; keep those last lines when
asking for help.

If the log says cloudflared is missing, run `DWF Setup.cmd` again and repair the **Get cloudflared**
step. If it reports a network error, check the connection and try again. If you'd rather not use
cloudflared at all, [docs/MANUAL-INSTALL.md](docs/MANUAL-INSTALL.md) has a Tailscale option.

## Windows Firewall asks about Dwarf Fortress

On the first Dwarf Fortress launch, Windows may ask whether to allow network access. Allow Dwarf
Fortress/DFHack on **Private networks** so the local browser stream can run. You do not need to
enable **Public networks** for the normal cloudflared setup.

## Remove the old plugin after upgrading

DFHack loads every plugin DLL it finds. An older Dwarf With Friends install can therefore load both
the old `dfcapture` plugin and the new `dwf` plugin, causing port conflicts and erratic behaviour.

1. Close Dwarf Fortress completely.
2. Open your Dwarf Fortress folder.
3. Delete `hack/plugins/dfcapture.plug.dll`.
4. Delete `hack/lua/plugins/dfcapture.lua`.
5. Start Dwarf Fortress again.

Do not delete `dwf.plug.dll` or `hack/lua/plugins/dwf.lua`; those are the current files.
