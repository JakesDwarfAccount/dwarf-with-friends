# Development tools

This directory holds offline builders, test harnesses, and investigation utilities. Most tools
use only stock Node or Python.

Read first:

- `harness/README.md` — suites, gates, live boundaries, and DF locking.
- `lib/README.md` — shared DF-root and HTTP helpers.
- `ws2/README.md` — generated sprite/token maps.

The Windows launcher `OPEN-TEXTURE-LAB.cmd` lives here.
Generated review pages belong in dated result directories, never at the tools root.
Do not default tools to a live server, hardcode a DF install, add dependencies, or duplicate the
resolvers in `lib/`.
