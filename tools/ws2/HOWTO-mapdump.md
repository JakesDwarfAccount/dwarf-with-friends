# HOWTO — `capture-mapdump` (WS2 map-data pivot, crash-safe)

This is the **crash-safe alternative to approach A** (render-buffer scraping, which
SIGSEGV'd DF 3×). It reads the current viewport's map via the STABLE DFHack map APIs
(`Maps::getBlock` + `MapExtras::MapCache` + `world->units`/`buildings`) under the core
suspender — it never touches `graphic_viewportst` / `screentexpos_*` / offscreen render.
By design this path cannot hit approach A's fault class, so it is safe to run live.

## 1. Build + deploy the plugin
Build `dfcapture_public` (produces `dwf.plug.dll`) as usual, then deploy the DLL to
your DF install's `hack/plugins/` exactly the way you deploy the existing dwf build.
(No new assets — `capture-mapdump` writes only a JSON file, no web/ folder needed.)

## 2. Run in-game (with a fort loaded, viewport where you want it)
In the DFHack console:

```
capture-mapdump
```

Optional explicit window size in tiles (default = current screen grid, `gps->dimx/dimy`):

```
capture-mapdump 80 50
```

- **origin** = the live host scroll position (`window_x/y/z`); **z** = `window_z`.
- Writes `dwf_mapdump/map.json` in the DF working directory.
- Null / unrevealed / edge blocks are skipped (logged to `dwf.log`), never faulted.

`map.json` shape (abridged):
```json
{ "wire":1, "origin":{"x":..,"y":..,"z":..}, "width":W, "height":H, "z":Z,
  "tiles":[ {"tt":id,"shape":"FLOOR","mat":"STONE","special":"NORMAL",
             "flow":0,"liquid":"none","hidden":0,"outside":1,
             "base_mt":0,"base_mi":-1}, ... ],           // row-major, W*H entries
  "units":[ {"x":..,"y":..,"z":..,"id":..,"race":..,"caste":..,"name":".."} ],
  "buildings":[ {"x1":..,"y1":..,"x2":..,"y2":..,"z":..,"type":"Workshop"} ] }
```
(`tt` = -1 means a null/edge tile — render as background.)

## 3. Render the map image (offline, on this machine)
Copy `dwf_mapdump/map.json` back next to this repo (or point `--in` at it), then:

```
python tools/ws2/render_mapdump.py \
    --in dwf_mapdump/map.json --out mapdump_render.png
```

Produces `mapdump_render.png`: walls dark, floors colored by material, water blue-by-depth,
magma orange/red, stairs/ramps X-marked, buildings outlined, units as yellow dots. This is
the Level-1.5 "Armok-Vision-style" view proving the data reconstructs into a legible map.

## Notes / limits
- Single z-level per dump (the host `window_z`). Multi-z see-down is a later client concern.
- Material coloring is by tiletype **category** (STONE/SOIL/GRASS/…) + base `mat_type/mat_index`;
  it is NOT DF's premium per-tile sprite (that is only obtainable via approach A, which crashes).
- Width/height auto-size to the full screen grid, so the dump can slightly overshoot the map
  viewport into UI columns; those tiles just read as normal map cells or null. Pass explicit
  `width height` to match a precise region.
