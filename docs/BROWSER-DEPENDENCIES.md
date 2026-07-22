# Browser dependency and cache contract

The production browser intentionally uses plain classic scripts. There is no bundler, npm runtime,
or hidden build step. Their exact order, cache query, and obvious global names are recorded in
`tools/architecture/browser-scripts.json`, generated directly from `web/index.html`.

The order is part of the application contract. Foundation providers such as DWFUI, the wire decoder,
cache, WebSocket client, renderer, and core load before panels and controls that consume them. Every
production script URL has an explicit cache key. When a script's runtime behavior changes, update
its key in `index.html`; the dependency inventory then changes visibly in review.

The `provides` and `uses` lists are navigation hints produced from obvious `window.X`, `root.X`, and
`globalThis.X` references. They do not understand closure variables or dynamic property names and
must not be treated as a JavaScript type system. The load-order fixture contains explicit critical
relationships for that reason.

Native ES modules remain an optional later pilot. They would improve explicit imports, but child
module cache invalidation through the supported tunnel must be solved before mixing loading models.
The current stabilization goal is to make the existing dependency-free model legible and guarded.
