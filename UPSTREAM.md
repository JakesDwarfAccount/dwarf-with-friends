# Project lineage

Dwarf With Friends grew directly from Gabriel Rios's
[SourceAirbender/multi-dwarf](https://github.com/SourceAirbender/multi-dwarf), whose `dfcapture`
DFHack plugin is the direct ancestor of this codebase. The exact divergence commit is not preserved
in this checkout's current Git ancestry, so this repository does not claim a fabricated base SHA.
The inherited project and Dwarf With Friends are licensed AGPL-3.0-only, and Gabriel's copyright is
retained in source files, `NOTICE`, and release artifacts.

Major inherited foundations include the original browser-served multiplayer approach, DFHack plugin
structure, capture and HTTP concepts, and retained `dfcapture` runtime/build identifiers. Dwarf With
Friends has since added or substantially rebuilt the binary acknowledged WebSocket transport,
world-addressed block cache and interest-union streaming, independent browser renderer and cameras,
many fortress actions and native-style panels, host/install tooling, runtime use of the host's game
art and audio, and extensive fixture/parity infrastructure.

Those additions are substantial, but they do not erase ancestry. The project also continues ideas
from DFPlex and webfort; their licenses and credits are reproduced in `NOTICE`.
