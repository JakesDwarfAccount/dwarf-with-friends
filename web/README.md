# Browser client

This is the zero-dependency browser client and its generated sprite/token maps. The plugin serves a
copied `web/` tree from the host's Dwarf Fortress install (`hack/dfcapture-web`); these files are not
embedded in the DLL, so a browser-only change does not require a plugin rebuild.

Read first:

- `index.html` — main client shell, script load order, and panel mounts.
- `tiles.html` — renderer-focused map surface.
- `js/dwf-core.js` — client boot and shared runtime state.
- `js/dwf-wire-v1.js` — wire decoder.
- `css/dwf.css` — shared styling and DWFUI tokens.

Read [js/README.md](js/README.md) before changing a feature module. All product UI must use DWFUI
(`js/dwf-ui-components.js`); raw controls and hand-built native chrome fail the drift guards. Never
replace existing native sprite tokens with emoji or Unicode stand-ins. Change the generated JSON
maps through the matching builder under `../tools/ws2/`, never by hand.
