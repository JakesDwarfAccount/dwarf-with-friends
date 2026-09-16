# Native Dwarf Fortress access boundaries

Read the owning module and its callers before changing native memory access. These categories describe the different locking requirements:

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
