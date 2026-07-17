# Dwarf With Friends demo rig

This keeper rig launches isolated, named browser contexts against a real host, choreographs a
scene, and records a separate 1920×1080 camera context. Its lead scene is the point of the project:
multiple named cursors co-building one fortress at the same time.

The browser is always headless and starts muted. It never asks Windows for foreground focus and
never moves the system cursor. The camera's exact 1920×1080 viewport is streamed over Chrome DevTools
Protocol into ffmpeg; ffmpeg emits a 60 fps high-bitrate NVENC master, then a README mp4 (hard-checked
at no more than 10 MiB) and a webm. Source compositor updates are paced by CDP, so ffmpeg duplicates
frames when necessary to make the 60 fps output timeline.

## Safety first

Scenes perform real designations, construction placement, camera movement, and chat. The command is
a dry run unless `--run` is present. Use a showcase save and have the host present; do not point this
at somebody's active fort.

```powershell
# Validate and print the default scene. Does not contact a server or open Chrome.
node tools/demo/demo.mjs --scene co-build

# See every available clip.
node tools/demo/demo.mjs --list

# Record one take against an already-running host and loaded demo fort.
node tools/demo/demo.mjs --run --scene co-build --url http://localhost:8765 --password "shared password"
```

Use `DWF_JOIN_PASSWORD` instead of `--password` if keeping the password out of shell history matters.
Other useful flags are `--out <directory>`, `--chrome <chrome.exe>`, `--ffmpeg <ffmpeg.exe>`,
`--cdp-port <port>`, and `--no-record` (real multiplayer smoke test without video encoding).

Each take lands under `tools/demo/takes/<scene>/<timestamp>/`. These files are intentionally ignored
from release/history workflows: upload the chosen README cut to GitHub's CDN and attach masters to the
release; do not commit video binaries.

## Add or change a scene

Edit `scenes.mjs`, not the runner. A scene has an id, title, duration, camera instructions, and named
players. Each player's steps are ordered by absolute milliseconds from the take start:

```js
{
  id: "feature-name",
  title: "What the viewer sees",
  durationMs: 15000,
  camera: {
    player: "DWF_Camera",
    follow: "Urist_A",
    steps: [{ at: 5000, action: "panel", panel: "workorders" }],
  },
  players: [{
    name: "Urist_A",
    steps: [
      { at: 1000, action: "pan", dx: 4, dy: 0, dz: 0 },
      { at: 3000, action: "panel", panel: "workorders" },
      { at: 7000, action: "chat", text: "Ready." },
    ],
  }],
}
```

Supported data actions are `cursor`, `pan`, `designate`, `build`, `panel`, `chat`, and `join`.
Canvas points are normalized `[x, y]` pairs, so choreography survives viewport changes. `build`
searches the real build catalog and chooses its first result; choose a specific, unambiguous search
term and rehearse against the demo save because availability and materials are save-dependent.
Camera steps use the same action vocabulary; use them for local UI such as panel tours. Set
`camera.start: "bare"` plus a `join` step when the camera itself must show the first-visit gate.

Run the scene without `--run` after editing it. The validator rejects unknown actions, duplicate
players, non-ascending times, and steps outside the scene duration.

## What a good take looks like

- Lead on the four differently colored, named cursors converging and placing a shared structure.
- Keep the map legible: choose a busy but not visually muddy part of the TOP save, and avoid modal
  panels covering the co-build moment.
- Let each action settle. A visible job/designation confirmation is better than faster choreography.
- For follow mode, make the followed player's camera movement deliberate enough to read on video.
- Check chat names and announcement text for accidental private or launch-spoiling content.
- Watch the master once at full resolution, then verify the README cut remains readable and is at
  most 10 MiB. The owner chooses the final take; the rig only produces candidates.

## Launch-copy guardrail

The precise honest claim is: **the first simultaneous multiplayer on modern (Steam-era) Dwarf
Fortress, and the first built as a real client (WebGL renderer, native panels, graphics, audio)
rather than a mirrored tile-screen.** Never claim “first ever multiple cursors”; DFPlex did that in
2018 through keyboard replay and screen mirroring, before DF v50's mouse UI.
