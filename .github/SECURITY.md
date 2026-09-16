# Security policy and threat model

Dwarf With Friends is designed for a small group of people who know and trust one another. It is
not a public game server, an anonymous service, or a safe way to let a streamer audience control a
fortress. A join password keeps an unlisted friend link private; it does not turn the plugin into a
hostile multi-tenant service.

## What players are trusted to do

Authenticated players can make broad changes to the shared fortress. That is the point of the mod.
Normal play mistakes, arguments, and intentional fortress damage are social risks for the group,
not security boundaries the server tries to solve. The host should keep ordinary save backups and
should share the link only with people they trust.

Host-machine settings, saving, and local diagnostic tools are a separate boundary. Those should be
available only to the host. Diagnostic endpoints may be expensive or expose development details and
are not intended for remote players.

The optional DFHack console is disabled by default. If enabled, treat every player who can use it as
fully trusted: DFHack commands are powerful and may affect more than the current fortress, including
files accessible to commands installed on the host machine. Its command checks reduce accidents;
they are not a complete sandbox.

## Supported exposure

- Use the host launcher and its supported Cloudflare tunnel or a private network such as Tailscale.
- Set a join password when the friend link could be forwarded.
- Do not expose the server as a public endpoint or advertise it to strangers.
- Stop hosting when the session ends and keep Dwarf Fortress saves backed up.

## Reporting a vulnerability

Please report a suspected vulnerability privately to the maintainer through GitHub's private
security-advisory feature. Include the affected version, exact request or steps, expected impact,
and whether the issue is reachable by a remote authenticated friend or only by a local process.
Please allow time for a fix before publishing details.

Issues that matter most are unintended host-machine access, authentication bypass, save corruption,
remote access to host-only settings or diagnostics, unbounded resource use during ordinary supported
friend sessions, and defects in the installer or update chain.
