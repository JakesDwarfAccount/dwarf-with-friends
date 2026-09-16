# Getting help

Three kinds of question, three different places. Pick the row that matches yours.

## Something is broken while playing

Start with [TROUBLESHOOTING.md](../TROUBLESHOOTING.md): a hard refresh (Ctrl+Shift+R) in the game
tab fixes most one-off weirdness, and the rest of that page covers the setup and hosting failures
we see most. If you are not sure your install is right, the
[release page](https://github.com/JakesDwarfAccount/dwarf-with-friends/releases) has the download
and the run instructions in one place: unzip, run `DWF Setup.cmd` on Windows or `./dwf-setup.sh` on Linux.

## It survives a hard refresh: report it

Read [REPORTING-BUGS.md](../docs/REPORTING-BUGS.md) first; it is short and plain-English, and it
says exactly what to include. Then file it on
[GitHub Issues](https://github.com/JakesDwarfAccount/dwarf-with-friends/issues) and pick the **Bug
report** form. Only the first two questions are required. Feature ideas have their own **Feature
request** form.

## A question, or an idea you want to talk through first

Open an issue and say so in the title: a question is a perfectly good issue here, and it is the
one channel guaranteed to be watched. If the project has a **Discussions** tab, that is the better
home for open-ended conversation, and a maintainer will move your thread there.

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) explains the
trusted-friends threat model and how to report privately.

## Beta 4 interface issues and fallback

Beta 4 has known interface rough edges, including Labor layout and selection styling and occasional long announcement text overflow. No new full live gameplay test pass was performed for this release. If these issues get in your way, [beta 3](https://github.com/JakesDwarfAccount/dwarf-with-friends/releases/tag/v1.0.0-beta.3) remains the more stable fallback. Its Windows and Linux packages require Dwarf Fortress 0.53.15 with DFHack 53.15-r2; beta 4 requires Dwarf Fortress 0.53.16 with DFHack 53.16-r1. Follow beta 3’s own setup instructions in a compatible installation. Do not assume a save opened in a newer Dwarf Fortress version can be downgraded.
