# Vendored dependencies

Vendored dependencies and their license provenance. Keep changes to dependencies explicit so future updates preserve local fixes.

Current entries, with the provenance readable from their own headers and licence files:

- `cpp-httplib/httplib.h`: single-header HTTP server/client, upstream `yhirose/cpp-httplib`. The
  header says *"Copyright (c) 2020 Yuji Hirose"*; `LICENSE` is MIT, *"Copyright (c) 2017 yhirose"*.
  No `CPPHTTPLIB_VERSION` macro is present in this copy, so the exact upstream tag is not
  recoverable from the file. Included by
  `src/http_server.cpp`, `src/websocket.cpp`, `src/sound_route.cpp`, `src/music_sync.cpp`,
  `src/write_guards.cpp`, and `src/announcements.h`.
- `stb/stb_image_write.h`: `stb_image_write v1.16`, Sean Barrett, `http://nothings.org/stb`,
  dual-licensed MIT / public-domain (Unlicense). Included by `src/image_encoder.cpp` to encode PNG on
  non-Windows hosts, where GDI+ is unavailable.

New dependencies require explicit approval and license compatibility review. Record the upstream URL, version or commit, and license when adding or upgrading a dependency.
