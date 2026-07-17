# Host configuration reference

These are the persistent files and start-command arguments read by the host code. Paths
without a prefix are relative to the Dwarf Fortress working directory.

> **A note on naming.** The plugin's shipped *files* use the `dwf.*` identity (the v1 rename:
> `dwf.plug.dll`, `dwf.lua`, `scripts/gui/dwf.lua`). The runtime *identifiers* below deliberately
> keep the original `dfcapture`/`capture-` stem for compatibility — the `capture-*` console
> commands, `dfcapture_join_password.txt`, `dfcapture.json`, the `dfcapture-web` served root, and
> the `dfcap_auth` cookie. Renaming those would break existing installs, so it is deferred. See
> [NAMING.md](NAMING.md) for the full story.

| Name | Where | Default | Effect |
|---|---|---|---|
| Join password | `dfcapture_join_password.txt`; first non-blank, non-comment line. It can also be set for the running session with `capture-join-password`, and the host UI persists to this file. | Unset; authentication disabled and the reachable server is open. | Gates clients with one shared passphrase. `reload` rereads the file; `off`, `none` or `clear` disables it for the session. |
| Authentication cookie | `dfcap_auth` in each player's browser. | Absent until a password-protected join succeeds. | Carries the shared passphrase to same-origin HTTP requests; the server reads this cookie and compares it with the configured password. |
| Host pause flags | `dwf_host_flags.txt`, with `hostunpause=on\|off` and `autopause=on\|off`. | `hostunpause=off`; `autopause=on`. | Restores whether only the host may unpause and whether disconnect autopause is enabled. The server loads it at stream start. |
| Remote audio | `dfhack-config/dfcapture.json`, key `"audio_remote": false`. | On. A missing/unreadable file or absent key leaves it on. | Explicit `false` prevents non-host browser clients from fetching the host installation's Dwarf Fortress audio; the file is reread at most once every three seconds. |
| DFHack console | `dfcapture-hostwrites.json`, key `"dfhack_console": true`. Also togglable from the host panel's "Remote commands & guarded writes" section (host tab only). | **Off.** A missing file, missing key, or any value other than literal `true` refuses both console routes server-side (fail closed). | Lets every joined player run DFHack commands on the host PC through the in-browser console (the server-side blocklist still applies). Reread at most every 2 seconds; no restart needed. |
| Guarded writes | `dfcapture-hostwrites.json`, keys `"squad_disband"`, `"hauling_route_delete"`, `"zone_remove"`, `"squad_pos0"` (plus the `trade_*`/`justice_*` per-action verification flags read by the Lua side). Deliberately **not** settable over HTTP. | **Off** (fail closed, same rule as above). | Each `true` unlocks one probe-guarded destructive write: squad disband, hauling route/stop delete, zone removal, squad position-0 commander assignment. Flip only after the matching live probe passes. |
| Stream port | First argument to `capture-stream-start [port] [bind-address]`. | `8765`. | Selects the TCP listen port; accepted values are 1–65535. |
| Bind address | Second argument to `capture-stream-start [port] [bind-address]`, or the local/LAN choice in `gui/dwf`. | `127.0.0.1` for the console command; the GUI initially selects LAN (`0.0.0.0`). | `127.0.0.1` accepts connections from this computer; `0.0.0.0` listens on network interfaces. |
