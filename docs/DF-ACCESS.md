# Native Dwarf Fortress access boundaries

Every C++ implementation file is listed in `tools/architecture/df-access-policy.json`. The inventory
is a navigation and review tool, not proof that every access is safe.

- `ordinary-suspended`: ordinary DF reads or writes must happen under a visible `CoreSuspender` or a
  named locked helper that owns it.
- `render-thread`: SDL, texture, viewport, or native-render state uses the documented render-thread
  hop and its timeout/fault guards. Do not wrap it in an ordinary generic suspender helper.
- `conditional-sampling`: diagnostics may read a small stable value without suspension when taking
  the core lock would itself distort or deadlock the measurement. These paths never mutate DF.
- `no-df-access`: transport, parsing, packaging, or other infrastructure should not gain DF global
  access without being reclassified and reviewed.
- `direct-or-delegated-review`: the file includes DF APIs but has no local `CoreSuspender`. It may
  call a safe owner elsewhere, run on an already-owned thread, or need cleanup. Read the actual call
  path before changing it; this category is deliberately a review queue, not a claim of unsafety.

The inventory check fails when a native file is added or its obvious access markers change. A human
must then decide whether the new classification and rule are accurate. Exceptional paths such as
`menu_oracle`, offscreen capture, and flight-recorder sampling stay explicit instead of being hidden
behind an abstraction that suggests ordinary safety.
