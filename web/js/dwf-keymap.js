// dwf - keyboard parity audit + keymap documentation + in-UI hotkey reference
// WD-28: Keyboard parity audit comparing DF v53.15-r1 canonical hotkeys vs client bindings.
// WD-28 REMEDIATION (2026-07-07, per the morning decision): mirror DF's original hotkeys as
// closely as possible; where a deviation is unavoidable, make it logical and document it here
// AND in the in-UI "?" / F1 / Shift+H overlay this file also renders. This file is the LIVE
// source of truth for every keyboard binding in the client -- when a hotkey changes anywhere
// (dwf-core.js's camera handler or dwf-controls-placement.js's tool-key switch),
// update dfCanonical/clientCurrent below in the SAME commit.
//
// Ground truth: DF's interface.txt (<your DF install>\data\init\
// interface.txt), read directly for this remediation pass -- every D_* bind's [KEY:...]/[SYM:...]
// line was cross-checked (not just the WD-4 tooltip-capture screenshots). Notable confirmations:
//   D_DESIGNATE_CHOP=l, D_TOGGLE_RAMP_INDICATORS=r, D_TOGGLE_FLUID_NUMBERS=f, D_HAULING=h,
//   D_JUSTICE=j, D_STOCKS=k, D_SQUADS=q, D_HOT_KEYS=Shift+H, D_ONESTEP=".",
//   CURSOR_UP_Z/CURSOR_DOWN_Z=e/c (fast E/C) -- these are DF's real map z-step, NOT a vim
//   convention -- and STANDARDSCROLL_UP/DOWN/LEFT/RIGHT=arrow keys (DF's real camera pan).
// Client handlers: dwf-controls-placement.js (tool-key switch + fallback camera switch),
// dwf-core.js (handleCameraKey, capture-phase camera owner), dwf-tiles.js (F3
// overlay, untouched by this pass).
//
// WHAT CHANGED IN THIS PASS (previously stale rows, now fixed):
// - `U` (audit v1 listed it MISSING/CONFLICT; controls-placement.js already had
//   `case "U": toggleBurrowPanel()` since WD-13 -- the flagged stale row).
// - `i`, `T`, `Y` were ALSO already bound by WD-9/WD-10/WD-13 (this audit file just hadn't been
//   refreshed since commit 6a18a99) -- now reflected below.
// - `h`, `j`, `k`, `q`, `l` were genuinely unbound/conflicting (camera pan/z had the letters) --
//   fixed THIS pass: camera moved to arrows-primary (+Shift fast) and PageUp/PageDown/e/c for
//   z-level (all DF-real), freeing h/j/k/q/l for D_HAULING/D_JUSTICE/D_STOCKS/D_SQUADS/
//   D_DESIGNATE_CHOP. `r`/`f` also fixed: they were camera-reset/chop deviations, now DF's real
//   D_TOGGLE_RAMP_INDICATORS/D_TOGGLE_FLUID_NUMBERS (both already had working display-toggle
//   buttons, just missing a keyboard binding).
// - `H`/`?`/F1 now open this file's in-UI hotkey-reference overlay -- the logical stand-in for
//   D_HOT_KEYS until WD-26's fuller help popup lands.
// - The old Shift+M squads fallback is RETIRED: it existed only because `q` was unavailable;
//   now that `q` is free, keeping M around would just be an undocumented extra, so it's gone.
//
// COVERAGE, BEFORE -> AFTER THIS PASS (of the 28 DF keys this client's scope covers; "." is the
// one remaining honest gap -- see its row below):
//   BEFORE: 22/28 = 79% direct DF parity (l/h/j/k/q/r/f conflicted with vim-style camera keys;
//           "." and Shift+H unbound).
//   AFTER:  27/28 = 96% direct DF parity. The lone remaining gap ("." / D_ONESTEP) is documented
//           NA below: it needs a NEW server-side action (advance one game tick while paused),
//           which doesn't exist yet in src/interaction.cpp (only pause/play/resume/toggle-pause
//           do) -- backend work, out of this front-end item's territory. Flagged as a follow-up.
//
// KEYMAP TABLE: DF Canonical -> Client Current Binding -> Status
// - Status values: BOUND (matches DF exactly), CLIENT_EXTRA (non-DF convenience, documented,
//   collides with nothing real), CLIENT_PANEL (pre-existing WD-1/WD-2 UI relocation, not a DF
//   hotkey), CLIENT_DIAGNOSTIC (dev-only, not DF), RETIRED (used to exist, deliberately removed
//   this pass), NA_DOCUMENTED (genuinely not implementable/implemented right now, reason given).
//
// =============================================================================================
// DESIGNATION TOOLS (core gameplay)
// =============================================================================================
// Key    | DF Function                    | Client Binding              | Status | Notes
// -------|--------------------------------|------------------------------|--------|----------------------------------------------
// m      | Dig / Mine                     | armDesignation("dig")        | BOUND  |
// l      | Chop trees (D_DESIGNATE_CHOP)  | armDesignation("plant","chop")| BOUND | WD-28: moved off `f`, DF's real chop key
// g      | Gather plants                  | armDesignation("gather")     | BOUND  |
// v      | Smooth floors/walls            | armDesignation("smooth")     | BOUND  |
// x      | Erase designations             | selectDesignation("erase")   | BOUND  |
// n      | Advanced dig options (submenu) | N/A                          | NA_DOCUMENTED | DF reuses `n` inside the dig submenu; this client has no advanced-dig-options UI yet, so there's no context for it to shadow global `n` (Nobles, below) -- not a collision, just unimplemented.
// i      | Item/building designations     | armDesignation("itemdesig")  | BOUND  | WD-10
// T      | Traffic designations (Shift+T) | armModeTool("traffic")       | BOUND  | WD-28: now toggles off like clicking, same as hauling
// =============================================================================================
// BUILD / STRUCTURE TOOLS
// =============================================================================================
// Key    | DF Function                    | Client Binding              | Status | Notes
// -------|--------------------------------|------------------------------|--------|----------------------------------------------
// b      | Build / buildings              | openPanel("build")           | BOUND  |
// p      | Stockpiles (palette mode)      | openPanel("stockpile")       | BOUND  |
// z      | Zones / civzone                | openPanel("zone")            | BOUND  |
// Shift+U| Burrows (D_BURROWS)            | toggleBurrowPanel()          | BOUND  | WD-13 real burrows mode (the stale row this audit flagged as fixed)
// h      | Hauling routes (D_HAULING)     | armModeTool("hauling")       | BOUND  | WD-28: freed from camera pan-left
// =============================================================================================
// FORT INFO PANELS
// =============================================================================================
// Key    | DF Function                    | Client Binding              | Status | Notes
// -------|--------------------------------|------------------------------|--------|----------------------------------------------
// u      | Units / Creatures (D_UNITLIST) | openPanel("citizens")        | BOUND  |
// t      | Tasks / Jobs (D_JOBLIST)       | openPanel("orders")          | BOUND  |
// y      | Labor details (D_LABOR)        | openPanel("labor")           | BOUND  |
// o      | Work orders (D_ORDERS)         | openPanel("workorders")      | BOUND  |
// n      | Nobles (D_NOBLES)              | openPanel("nobles")          | BOUND  | see the dig-submenu dual-use note above
// Shift+O| Objects / Artifacts (D_ARTLIST)| openPanel("objects")         | BOUND  |
// Shift+P| Locations / Places (D_LOCATIONS)| openPanel("locations")      | BOUND  |
// q      | Squads (D_SQUADS)              | openPanel("squads")          | BOUND  | WD-28: freed from camera z-down; RETIRES the old Shift+M fallback
// j      | Justice (D_JUSTICE)            | openPanel("justice")         | BOUND  | WD-28: freed from camera pan-down
// Shift+Y| World map (D_WORLD)            | openPanel("worldmap")        | BOUND  |
// k      | Stocks (D_STOCKS)              | openPanel("stocks")          | BOUND  | WD-28: freed from camera pan-up
// =============================================================================================
// SYSTEM CONTROLS
// =============================================================================================
// Key    | DF Function                    | Client Binding              | Status | Notes
// -------|--------------------------------|------------------------------|--------|----------------------------------------------
// Space  | Pause / Unpause (D_PAUSE)      | performAction("toggle-pause")| BOUND  |
// .      | One-step (D_ONESTEP)           | N/A                          | NA_DOCUMENTED | No server action exists (src/interaction.cpp only has pause/play/resume/toggle-pause) -- needs a new core-thread "advance one tick" action; backend work, queued as a follow-up, out of this front-end item's territory.
// Shift+N| Announcements (D_ANNOUNCE)     | openPanel("alerts")          | BOUND  |
// Shift+H| Hotkey menu (D_HOT_KEYS)       | toggleOverlay() [this file]  | BOUND  | An in-UI reference panel listing every binding on this page. Complements (doesn't replace) WD-26's per-context first-time help popups, which explain WHAT a mode does rather than every keybind. Also reachable via `?` and F1 (non-DF extras) and the top-bar Help button.
// Esc    | Escape (back out one layer)    | cascade -> openEscMenu()     | BOUND  | WD-27: mirrors DF's real behavior exactly -- each press closes the innermost open layer first (a submenu/paint-stage, then a panel/tool, ...); when NOTHING else is open, Escape opens DF's own Esc menu (23-esc-menu.png; dwf-escmenu.js) instead of doing nothing. The Esc menu's Save/Retire/Abandon/Quit rows are COSMETIC ONLY per the owner (the host saves in their own Steam client) -- always rendered but disabled; Settings/Return to game are functional. See dwf-escmenu.js's file header for the full host-gating rationale.
// =============================================================================================
// DISPLAY / RENDER TOGGLES
// =============================================================================================
// Key    | DF Function                    | Client Binding              | Status | Notes
// -------|--------------------------------|------------------------------|--------|----------------------------------------------
// r      | Toggle ramp indicators         | setDisplayToggle("rampArrows")| BOUND | WD-28: freed from camera-reset (Home is now the only keyboard reset)
// f      | Toggle liquid numerals         | setDisplayToggle("liquidNumbers")| BOUND | WD-28: freed from chop (moved to `l`)
// =============================================================================================
// CAMERA / VIEW CONTROLS (arrows + PageUp/PageDown/e/c are DF-real; the rest are client extras)
// =============================================================================================
// Key           | DF Function                     | Client Binding      | Status       | Notes
// --------------|----------------------------------|----------------------|-------------|----------------------------------------------
// Arrow keys    | Pan (STANDARDSCROLL_*)           | queueMove(...)       | BOUND        | DF's real camera pan
// Shift+Arrow   | Pan, 3x step                     | queueMove(...)       | CLIENT_EXTRA | DF has no pan-speed modifier key (its "fast" is OS key-repeat rate); harmless, documented
// PageUp/PageDown| Z-level up/down                | queueMove(0,0,±1)    | BOUND        | Per the ruling: DF's real map z-step
// e/E, c/C      | Z-level up/down (CURSOR_UP/DOWN_Z)| queueMove(0,0,±1)   | BOUND        | Confirmed in interface.txt; collides with no fort-tool letter
// w/a/s/d (+caps)| Pan                             | queueMove(...)       | CLIENT_EXTRA | DF's own w/a/s/d bind (CURSOR_*) drives a keyboard designation-cursor this client never implements (mouse-only designation) -- reusing the letters for pan collides with nothing real
// [ / ]         | Zoom in/out (ZOOM_IN/ZOOM_OUT)   | zoomView(...)        | BOUND        |
// = / +         | Zoom in (alias)                  | zoomView("in")       | CLIENT_EXTRA | Not in interface.txt
// - / _         | Zoom out (alias)                 | zoomView("out")      | CLIENT_EXTRA | Not in interface.txt
// Home          | Reset camera to host             | resetToHost()        | CLIENT_EXTRA | DF is single-player -- no "host" concept to reset to; `r` no longer doubles for this (see display toggles)
// Shift+M       | (was: squads fallback)           | -- removed --        | RETIRED      | Existed only because `q` was unavailable; `q` is free now, so this is gone (fully mirrors DF instead of keeping an extra)
// =============================================================================================
// CLIENT-ONLY PANEL RELOCATIONS (not DF hotkeys; pre-existing WD-1/WD-2 moves, unaffected here)
// =============================================================================================
// Key    | Client Function                | Client Binding              | Status | Notes
// -------|--------------------------------|------------------------------|--------|----------------------------------------------
// Shift+F| Kitchen                        | openPanel("kitchen")         | CLIENT_PANEL | WD-2 relocation, not a DF main-toolbar key
// Shift+G| Petitions                      | openPanel("petitions")       | CLIENT_PANEL | WD-1 relocation, not a DF main-toolbar key
// Shift+B| Obligations board              | openPanel("obligations")     | CLIENT_PANEL | WT15 aggregate of noble mandates + guildhall/temple agreements; not a DF key
// (Reports is a tab inside the Announcements panel, not a separate hotkey -- WD-1.3/WD-7)
// =============================================================================================
// DIAGNOSTIC / CLIENT-ONLY CONTROLS
// =============================================================================================
// Key     | Function                       | Client Binding              | Status | Notes
// --------|--------------------------------|------------------------------|--------|-----------------
// F3      | Perf overlay (diagnostic)      | toggleDiag()                 | CLIENT_DIAGNOSTIC | Not a DF hotkey
// ?, F1   | Hotkey reference overlay        | toggleOverlay() [this file]  | CLIENT_EXTRA | Alternate ways in besides Shift+H; F1 is also DF's D_HOTKEY1 fort-bookmark slot (unimplemented here, so no real clash)
// =============================================================================================

// Export the audit table for programmatic use (test harnesses, keymap verification, and this
// file's own hotkey-reference overlay -- ONE data source feeds both).
window.dwfKeymapAudit = {
  version: "WD-28 audit v2 (remediation pass)",
  timestamp: "2026-07-07",

  // Canonical DF hotkeys (from interface.txt D_* binds, verified this pass).
  dfCanonical: {
    // Designations
    "m": { function: "Dig / Mine", panel: "dig" },
    "l": { function: "Chop trees", panel: "plant" },
    "g": { function: "Gather plants", panel: "plant" },
    "v": { function: "Smooth floors/walls", panel: "smooth" },
    "x": { function: "Erase designations", panel: "erase" },
    "i": { function: "Item/building designations", panel: "items" },
    "T": { function: "Traffic designations", panel: "traffic" },
    "n": { function: "Advanced dig options / Nobles", expand: true },

    // Structures
    "b": { function: "Build", panel: "build" },
    "p": { function: "Stockpiles", panel: "stockpile" },
    "z": { function: "Zones", panel: "zone" },
    "h": { function: "Hauling routes", panel: "hauling" },

    // Fort panels
    "u": { function: "Units/Creatures", panel: "creatures" },
    "t": { function: "Tasks/Jobs", panel: "tasks" },
    "y": { function: "Labor", panel: "labor" },
    "o": { function: "Work orders", panel: "orders" },
    "O": { function: "Objects/Artifacts", panel: "objects" },
    "P": { function: "Locations/Places", panel: "places" },
    "q": { function: "Squads", panel: "squads" },
    "j": { function: "Justice", panel: "justice" },
    "Y": { function: "World map", panel: "world" },
    "k": { function: "Stocks", panel: "stocks" },

    // System
    " ": { function: "Pause", action: "pause" },
    ".": { function: "One-step", action: "onestep" },
    "H": { function: "Hotkey menu", action: "hotkeys" },
    "N": { function: "Announcements", panel: "alerts" },
    "U": { function: "Burrows", panel: "burrows" },

    // Display toggles
    "r": { function: "Toggle ramp indicators", toggle: "rampArrows" },
    "f": { function: "Toggle liquid numerals", toggle: "liquidNumbers" },

    // Camera
    "[": { function: "Zoom in", action: "zoom-in" },
    "]": { function: "Zoom out", action: "zoom-out" },
  },

  // Client current bindings (post WD-28 remediation).
  clientCurrent: {
    // Designations
    "m": { action: "armDesignation", params: ["dig", "dig"], status: "BOUND" },
    "l": { action: "armDesignation", params: ["plant", "chop"], status: "BOUND", note: "moved off f this pass -- DF's real chop key" },
    "g": { action: "armDesignation", params: ["plant", "gather"], status: "BOUND" },
    "v": { action: "armDesignation", params: ["smooth", "smooth"], status: "BOUND" },
    "x": { action: "selectDesignation", params: ["erase"], status: "BOUND" },
    "n": { action: "openPanel", params: ["nobles"], status: "BOUND", note: "DF also reuses lowercase n inside the dig submenu (advanced options) -- no client UI for that yet, so no real collision" },

    // Structures
    "b": { action: "openPanel", params: ["build"], status: "BOUND" },
    "p": { action: "openPanel", params: ["stockpile"], status: "BOUND" },
    "z": { action: "openPanel", params: ["zone"], status: "BOUND" },
    "h": { action: "armModeTool", params: ["hauling"], status: "BOUND", note: "freed from camera pan-left this pass" },

    // Fort panels
    "u": { action: "openPanel", params: ["citizens"], status: "BOUND" },
    "t": { action: "openPanel", params: ["orders"], status: "BOUND" },
    "y": { action: "openPanel", params: ["labor"], status: "BOUND" },
    "o": { action: "openPanel", params: ["workorders"], status: "BOUND" },
    "i": { action: "armDesignation", params: ["itemdesig", "claim"], status: "BOUND" },
    "O": { action: "openPanel", params: ["objects"], status: "BOUND" },
    "N": { action: "openPanel", params: ["alerts"], status: "BOUND" },
    "U": { action: "toggleBurrowPanel", status: "BOUND" },
    "q": { action: "openPanel", params: ["squads"], status: "BOUND", note: "freed from camera z-down this pass; retires the old Shift+M fallback" },
    "P": { action: "openPanel", params: ["locations"], status: "BOUND" },
    "F": { action: "openPanel", params: ["kitchen"], status: "CLIENT_PANEL", note: "not a DF hotkey; WD-2 relocation" },
    "G": { action: "openPanel", params: ["petitions"], status: "CLIENT_PANEL", note: "not a DF hotkey; WD-1 relocation" },
    "T": { action: "armModeTool", params: ["traffic"], status: "BOUND" },
    "j": { action: "openPanel", params: ["justice"], status: "BOUND", note: "freed from camera pan-down this pass" },
    "k": { action: "openPanel", params: ["stocks"], status: "BOUND", note: "freed from camera pan-up this pass" },
    "Y": { action: "openPanel", params: ["worldmap"], status: "BOUND" },

    // System
    " ": { action: "performAction", params: ["toggle-pause"], status: "BOUND" },
    ".": { action: null, status: "NA_DOCUMENTED", note: "D_ONESTEP has no server action yet (src/interaction.cpp: pause/play/resume/toggle-pause only) -- backend follow-up, out of front-end territory" },
    "H": { action: "toggleOverlay", status: "BOUND", note: "in-UI hotkey reference (this file) stands in for D_HOT_KEYS until WD-26" },
    "?": { action: "toggleOverlay", status: "CLIENT_EXTRA", note: "common web convention alias for the hotkey overlay" },
    "F1": { action: "toggleOverlay", status: "CLIENT_EXTRA", note: "DF's D_HOTKEY1 fort-bookmark slot is unimplemented here, so reusing F1 collides with nothing real" },

    // Display toggles
    "r": { action: "setDisplayToggle", params: ["rampArrows"], status: "BOUND", note: "freed from camera-reset this pass" },
    "f": { action: "setDisplayToggle", params: ["liquidNumbers"], status: "BOUND", note: "freed from chop this pass" },

    // Camera/View
    "ArrowLeft/Right/Up/Down": { action: "queueMove", status: "BOUND", note: "DF's real STANDARDSCROLL_* pan; Shift = 3x step (CLIENT_EXTRA, DF has no pan-speed modifier)" },
    "w/a/s/d": { action: "queueMove", status: "CLIENT_EXTRA", note: "DF's own w/a/s/d (CURSOR_*) drives a keyboard designation-cursor this client doesn't implement -- no real collision" },
    "PageUp/PageDown": { action: "queueMove", params: ["z"], status: "BOUND" },
    "e/E, c/C": { action: "queueMove", params: ["z"], status: "BOUND", note: "DF's real CURSOR_UP_Z/CURSOR_DOWN_Z" },
    "[": { action: "zoomView", params: ["in"], status: "BOUND" },
    "]": { action: "zoomView", params: ["out"], status: "BOUND" },
    "=": { action: "zoomView", params: ["in"], status: "CLIENT_EXTRA" },
    "+": { action: "zoomView", params: ["in"], status: "CLIENT_EXTRA" },
    "-": { action: "zoomView", params: ["out"], status: "CLIENT_EXTRA" },
    "_": { action: "zoomView", params: ["out"], status: "CLIENT_EXTRA" },
    "Home": { action: "resetToHost", status: "CLIENT_EXTRA", note: "DF is single-player, no host-reset concept" },
    "Shift+M": { action: null, status: "RETIRED", note: "old squads fallback, removed now that q is free" },

    // Diagnostic
    "F3": { action: "toggleDiag", status: "CLIENT_DIAGNOSTIC" },
  },

  // Self-check: flag any entry that's still a real DF/client conflict (should be empty post-remediation).
  findConflicts() {
    const conflicts = [];
    for (const [key, binding] of Object.entries(this.clientCurrent)) {
      if (binding.status && binding.status.includes("CONFLICT")) {
        conflicts.push(`${key}: client=${binding.action}, df=${this.dfCanonical[key]?.function}`);
      }
    }
    return conflicts;
  },

  // Self-check: coverage of DF's real single-key canonical hotkeys (the multi-key camera/combo
  // rows above aren't in dfCanonical -- they're documented in clientCurrent/the overlay only).
  getCoverageSummary() {
    const dfKeys = Object.keys(this.dfCanonical);
    const bound = dfKeys.filter(k => this.clientCurrent[k]?.status === "BOUND").length;
    const naDocumented = dfKeys.filter(k => this.clientCurrent[k]?.status === "NA_DOCUMENTED").length;
    const unresolved = dfKeys.filter(k => !this.clientCurrent[k]);
    return {
      totalDFKeys: dfKeys.length,
      boundToClient: bound,
      naDocumented,
      unresolvedCount: unresolved.length,
      unresolvedKeys: unresolved,
      coverage: `${bound}/${dfKeys.length} = ${Math.round(100 * bound / dfKeys.length)}%`,
      resolvedCoverage: `${bound + naDocumented}/${dfKeys.length} = ${Math.round(100 * (bound + naDocumented) / dfKeys.length)}%`,
    };
  }
};

// Verify on load (console output for WD-28 testing).
if (typeof window !== "undefined" && window.dwfKeymapAudit) {
  try {
    const summary = window.dwfKeymapAudit.getCoverageSummary();
    const conflicts = window.dwfKeymapAudit.findConflicts();
    console.log("[WD-28 Keymap Audit]", summary);
    if (conflicts.length > 0) {
      console.warn("[WD-28 Conflicts]", conflicts);
    } else if (summary.unresolvedCount > 0) {
      console.warn("[WD-28 Unresolved DF keys]", summary.unresolvedKeys);
    }
  } catch (e) {
    console.error("[WD-28 Keymap Audit Error]", e);
  }
}

// ---------------------------------------------------------------------------------------------
// In-UI hotkey reference overlay (WD-28 item 4): the logical interim for D_HOT_KEYS/WD-26's
// fuller help popup. Toggled by Shift+H, `?`, F1 (dwf-controls-placement.js's keydown
// switch calls window.DwfKeymap.toggleOverlay()) and by clicking the top-bar Help button
// (previously unwired). Renders directly from the table above so the on-screen reference can
// never drift from the documented bindings.
(function () {
  const SECTIONS = [
    { title: "Designations", rows: [
      ["m", "Dig / Mine"], ["l", "Chop trees"], ["g", "Gather plants"], ["v", "Smooth floors/walls"],
      ["x", "Erase designations"], ["i", "Item/building designations"], ["Shift+T", "Traffic designations"],
    ]},
    { title: "Structures", rows: [
      ["b", "Build"], ["p", "Stockpiles"], ["z", "Zones"], ["Shift+U", "Burrows"], ["h", "Hauling routes"],
    ]},
    { title: "Fort panels", rows: [
      ["u", "Units / Creatures"], ["t", "Tasks / Jobs"], ["y", "Labor"], ["o", "Work orders"],
      ["n", "Nobles"], ["Shift+O", "Objects / Artifacts"], ["Shift+P", "Locations / Places"],
      ["q", "Squads"], ["j", "Justice"], ["Shift+Y", "World map"], ["k", "Stocks"],
    ]},
    // B203: the saved map-location jumps. Global (fire from the map view whether or not the
    // Locations fly-out is open), and remappable via Settings > Keybinds (dwf-settings.js's
    // location1..location9 actions). dwf-hotkeys.js owns the jump itself.
    { title: "Locations", rows: [
      ["1 – 9", "Jump camera to saved map location 1–9 (works from the map, menu open or not)"],
    ]},
    { title: "System", rows: [
      ["Space", "Pause / Unpause"], ["Shift+N", "Announcements"], ["Shift+H / ? / F1", "This hotkey reference"],
      ["Esc", "Back out one layer; opens the Esc menu when nothing else is open"],
    ]},
    { title: "Display toggles", rows: [
      ["r", "Toggle ramp indicators"], ["f", "Toggle liquid numerals"],
    ]},
    { title: "Camera", rows: [
      ["Arrows (Shift = fast)", "Pan"], ["PageUp / PageDown", "Z-level up/down"],
      ["e/c (E/C fast)", "Z-level up/down (alt.)"], ["[ / ]", "Zoom in/out"], ["Home", "Reset to host"],
      ["w a s d", "Pan (client extra)"],
    ]},
    { title: "Mouse controls", rows: [
      ["Middle/right drag", "Pan the map"], ["Click", "Inspect a tile or use the active tool"],
      ["Left drag", "Draw a designation or placement"], ["Wheel", "Zoom the view"],
      ["Shift + wheel", "Change elevation"],
    ]},
    { title: "Client-only panels", rows: [
      ["Shift+F", "Kitchen"], ["Shift+G", "Petitions"], ["Shift+B", "Obligations board"],
    ]},
  ];

  let overlayEl = null;
  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.getElementById("hotkeyOverlay");
    if (!overlayEl) return null;
    const sectionsHtml = SECTIONS.map(section => `
      <section class="hk-section">
        <h3>${section.title}</h3>
        <table class="hk-table">
          ${section.rows.map(([key, label]) => `
            <tr><td class="hk-key">${key}</td><td class="hk-label">${label}</td></tr>
          `).join("")}
        </table>
      </section>
    `).join("");
    overlayEl.innerHTML = `
      <div class="hk-panel" role="dialog" aria-label="Hotkey reference">
        <div class="hk-head">
          <h2>Hotkeys</h2>
          <button type="button" class="hk-close" aria-label="Close">&times;</button>
        </div>
        <div class="hk-body">${sectionsHtml}</div>
        <div class="hk-foot">Mirrors Dwarf Fortress's own key bindings wherever possible. Press
          <b>Shift+H</b>, <b>?</b>, or <b>F1</b> to close.</div>
      </div>
    `;
    overlayEl.querySelector(".hk-close")?.addEventListener("click", closeOverlay);
    overlayEl.addEventListener("pointerdown", event => {
      if (event.target === overlayEl) closeOverlay();
    });
    return overlayEl;
  }
  function isOpen() {
    return !!overlayEl && overlayEl.classList.contains("open");
  }
  function openOverlay() {
    const el = ensureOverlay();
    if (!el) return;
    el.classList.add("open");
  }
  function closeOverlay() {
    if (overlayEl) overlayEl.classList.remove("open");
    try { document.getElementById("view")?.focus({ preventScroll: true }); } catch (_) {}
  }
  function toggleOverlay() {
    if (isOpen()) closeOverlay(); else openOverlay();
  }

  // Escape closes the overlay -- registered on this file's own listener so it doesn't have to
  // thread through controls-placement.js's already-large Escape cascade. Runs after that
  // cascade (script load order), which is fine: this overlay has no interaction with any of
  // those other Escape-closeable panels.
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      closeOverlay();
    }
  });

  // B207: the top-bar "?" Help button now opens the FULL help reference (every tooltip, not just
  // hotkeys) -- dwf-help-panel.js wires #helpBtn to window.DFHelpPanel.toggle(). This
  // compact overlay stays reachable on its own via Shift+H (D_HOT_KEYS) and F1.
  window.DwfKeymap = { toggleOverlay, openOverlay, closeOverlay, isOpen };
})();
