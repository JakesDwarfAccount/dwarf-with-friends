# Contributing

A useful contribution explains the player-visible problem, keeps the change focused, and reports what was checked.

Read [AGENTS.md](AGENTS.md), [development](docs/DEVELOPMENT.md), and [build instructions](docs/BUILD.md). The client has no package dependencies or bundling step. Native code builds against DFHack 53.16-r1 on Windows and Linux.

Run the offline checks in the development guide and include exact commands and results. Add a small regression check when it can demonstrate the reported failure. Do not treat an offline pass as proof of gameplay correctness. Coordinate before using a running game or deploying a changed plugin.

Use or extend DWFUI for browser controls. Preserve authentication, host-only permissions, save guards, and native locking. Keep unrelated changes out of the patch. Split a module when a concrete responsibility or testing boundary calls for it, rather than because of line count alone.

Open a ready pull request with the problem first, followed by the solution, verification, and any remaining limitations. Disclose material AI assistance and explain the important behavior in plain English. Documentation corrections, clearer diagnostics, and small reproducible bug fixes are useful starting points.
