# Reporting bugs

Thanks for playing the beta! Rough edges are expected, and a good bug report is genuinely the
fastest way to get something fixed — reports with clear steps usually get attention within days.

## Before you report

**Hard-refresh first: press Ctrl+Shift+R in the game tab.** This clears cached files and fixes
most one-off weirdness (blank map, stale UI, mystery lag). If the problem disappears, it wasn't
a bug worth filing. More quick fixes live in [TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

If it *survives* a hard refresh, we want to hear about it.

## Where to report

File it on GitHub Issues:
**<https://github.com/JakesDwarfAccount/dwarf-with-friends/issues>**

Click **New issue** and pick **Bug report** — the form walks you through everything below, and
only the first two questions are required. You don't need to be technical to file a great report.

## What helps us most

**Steps to reproduce.** The single most valuable thing. What were you (and the host) doing right
before it broke? For example:

> 1. Host opened the native zone location picker.
> 2. I deleted that zone from the browser.
> 3. Game crashed.

Even "I'm not sure, but it happens every time I open the stocks screen" is useful.

**The F3 overlay.** Press **F3** in the game to open a small diagnostics panel. Two lines matter
most: **Transport** (how your browser receives the game — `WS delta` is the fast path, `HTTP`
is the fallback) and **Renderer** (`gl` is the fast path, `canvas2d` is the fallback). Paste
those plus any FPS/latency numbers — essential for lag reports.

**Browser console.** Press **F12**, open the **Console** tab, and copy any red error messages.

**Host only — DFHack logs.** If the game itself crashed, look in your Dwarf Fortress folder for
`stderr.log` (and `stdout.log`). The **last ~30 lines** of `stderr.log` usually show exactly
which plugin fell over — paste them into the form. For friend-link or tunnel problems, the tail
of `host/cloudflared.log` (inside the extracted Dwarf With Friends folder) tells the same story.

## About crash dumps — an honest note

Normal players do **not** get full crash dumps automatically, and we don't ask you to set that
up. Reproduction steps plus the DFHack log tail are what we actually work from, and they solve
most crashes. For a truly stubborn one, a maintainer may walk you through capturing more — but
that's our job to ask for, not yours to prepare.

## What to expect

This is a beta: things will break, and that's fine. File it, be as specific as you can, and
don't stress about getting the form perfect — a vague report is still better than silence.
Good reports get fixed fast.
