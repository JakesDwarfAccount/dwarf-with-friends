# Manual install (the hard way)

The one-click launcher (`DWF Setup.cmd`) does everything below automatically. Use this guide only if
you'd rather install by hand, the launcher won't run on your system, or you want a different tunnel
(a Tailscale option is at the bottom).

You need **Windows** and a working copy of **Dwarf Fortress**. Only the **host** does any of this —
friends just open a link in their browser.

Throughout, `<DF>` means your Dwarf Fortress folder (the one holding `Dwarf Fortress.exe`).

---

## 1. Install DFHack

Dwarf With Friends is a DFHack plugin, so DFHack must be installed first, and the version must match
exactly.

- **Required version: DFHack `53.15-r2`** — https://github.com/DFHack/dfhack/releases/tag/53.15-r2
- Download `dfhack-53.15-r2-Windows-64bit.zip` and extract it **into `<DF>`** so that a `hack\`
  folder appears next to `Dwarf Fortress.exe`.
- Launch Dwarf Fortress once and confirm the DFHack terminal/overlay appears, then close it.

(If you use the Steam version of DFHack, make sure it is the `53.15-r2` build — a mismatched DFHack
is the #1 cause of the plugin not loading.)

## 2. Install the plugin files

From this release's zip, copy these files to these exact locations, creating folders as needed:

| From the zip | To |
|---|---|
| `dwf.plug.dll` | `<DF>\hack\plugins\dwf.plug.dll` |
| `dwf.lua` | `<DF>\hack\lua\plugins\dwf.lua` |
| `dwf.lua` (same file) | `<DF>\hack\scripts\dwf.lua` |
| `gui\dwf.lua` | `<DF>\hack\scripts\gui\dwf.lua` |
| everything in `web\` | `<DF>\hack\dfcapture-web\` (the whole folder) |

If you are **upgrading** from an older build, first delete any leftover `dfcapture.plug.dll` and
`hack\lua\plugins\dfcapture.lua` — DFHack loads *every* DLL in `hack\plugins\`, and an old copy
running alongside the new one will fight over the port. (The launcher quarantines these for you;
by hand, just delete them.)

## 3. Bake the sprites

The browser UI uses Dwarf Fortress's own art. Rather than redistribute the game's copyrighted files,
the plugin generates the sprites it needs from *your* installed copy. Run once, from the extracted
release folder (the one containing `DWF Setup.cmd`):

```
node host\bake_sprites.mjs --df-root "<DF>"
```

(The launcher ships a portable Node; if you're doing this fully by hand you'll need Node installed,
or just let `DWF Setup.cmd` do this one step.) This writes a handful of PNGs into
`hack\dfcapture-web\`. No game files leave your machine.

## 4. Start hosting

1. Launch Dwarf Fortress (with DFHack) and load your fortress.
2. In the DFHack console (backtick `` ` `` opens it), the plugin auto-loads; the web server listens on
   **http://127.0.0.1:8765**.
3. Open **http://127.0.0.1:8765/view** in your browser — because you're on the same machine you're
   recognized as the host automatically (no password prompt).
4. Press **Esc → Host settings** for the control panel: the friend link, the join password (off by
   default — anyone with the link can join; set one here if you want), and the connected-player list.

At this point local play works. To let friends on other networks join, you need a tunnel — pick
**one** of the next two sections.

---

## 5a. Internet play with cloudflared (the default, no account)

A tunnel exposes your local server to the internet without router port-forwarding.

- **cloudflared `2026.6.1`** — https://github.com/cloudflare/cloudflared/releases/tag/2026.6.1
- Download `cloudflared-windows-amd64.exe`, put it wherever you like, then run:

```
cloudflared.exe tunnel --url http://localhost:8765
```

- It prints a `https://<random>.trycloudflare.com` URL. **That link + the join password (if you set
  one) is what your friends open.** Nothing to configure, no account, no login. The link lasts until
  you stop cloudflared.
- The host panel can start/stop this for you; doing it by hand is only for troubleshooting.

**Security note:** with no password, anyone who gets that link can join your fort. The random URL is
unguessable, but treat it like a secret — don't post it publicly. Set a password in Host settings if
you're sharing more widely.

## 5b. Internet play with Tailscale (if you prefer a private mesh)

[Tailscale](https://tailscale.com) puts you and your friends on a private encrypted network as if you
were on the same LAN — no public URL exists at all, which some people prefer over a cloudflared link.
Everyone who wants to join installs Tailscale (free tier is plenty).

1. **Host:** install Tailscale (https://tailscale.com/download), sign in, and note your machine's
   Tailscale IP — run `tailscale ip -4` (looks like `100.x.y.z`). Keep Tailscale running while you host.
2. **Each friend:** install Tailscale and sign in. To be on the same network they must either be on
   **your tailnet** — invite them from the Tailscale admin console (https://login.tailscale.com/admin)
   via *Share* / an invite link — or use a shared node. (If everyone's already on one shared tailnet,
   skip this.)
3. **The bind caveat:** the console command `capture-stream-start` listens only on `127.0.0.1`
   (localhost) unless you pass a bind address, so a Tailscale peer can't reach a console-started
   server directly. (The in-game `gui/dwf` window is different: its "Who can connect" toggle
   starts on LAN, `0.0.0.0` — see `docs/CONFIG.md`.) Two ways to host over Tailscale:
   - **Easiest — `tailscale serve`:** on the host, run
     `tailscale serve --bg http://127.0.0.1:8765`
     This proxies your local server onto your tailnet over HTTPS. Tailscale prints the URL to share
     (a `https://<your-machine>.<tailnet>.ts.net` address). Friends on your tailnet open that link.
     This is the cleanest option, needs no firewall changes, and works with a loopback-only bind.
   - **Manual — reach the host by Tailscale IP:** make the server listen on all interfaces
     (`capture-stream-start 8765 0.0.0.0`, or leave `gui/dwf` on its LAN setting) and friends
     browse to `http://100.x.y.z:8765/view` (the host's Tailscale IP).

**Why someone would pick Tailscale over cloudflared:** no public URL to leak, end-to-end encrypted,
and the connection stays up as a stable named address instead of a random per-session link. The
trade-off is that every friend installs Tailscale and joins your tailnet, versus cloudflared where
they join straight from their browser.

---

## Uninstalling

Delete the five files/folders from step 2 (`hack\plugins\dwf.plug.dll`, both `dwf.lua` copies,
`hack\scripts\gui\dwf.lua`, and `hack\dfcapture-web\`). That's the entire footprint — the one-click
installer also writes an install receipt (`dwf_install_receipt.json` in `<DF>`) you can delete if
present. DFHack itself is untouched.

## Troubleshooting

- **Plugin doesn't load / `/view` won't open:** almost always a DFHack version mismatch. Confirm
  `53.15-r2`.
- **Two plugins loading / port already in use:** an old `dfcapture.plug.dll` is still in
  `hack\plugins\`. Delete it.
- **Friends can't connect over cloudflared:** the tunnel isn't running, or you shared the local
  `127.0.0.1` link instead of the `trycloudflare.com` one.
- **Friends can't connect over Tailscale:** they're not on your tailnet, or you shared the Tailscale
  IP without `tailscale serve` while the server is still localhost-only.
