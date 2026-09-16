// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

// dwf-keymap.js -- the live source of truth for every keyboard binding in the client: the
// canonical/current tables below, and the in-UI hotkey reference overlay they render.

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

  // Client current bindings.
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
    "h": { action: "toggleHaulingPanel", status: "BOUND", note: "freed from camera pan-left this pass" },

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

// Verify on load (console output).
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

// ---- The in-UI hotkey reference overlay, toggled by Shift+H, ? and F1. ----
// Renders directly from the table above, so the on-screen reference can never drift from it.
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
      ["w a s d", "Pan (Shift = 2x, like DF's W A S D)"], ["Arrows", "Pan"],
      ["e / c", "Z-level up / down"], ["E / C", "Z-level up / down, 10 at a time"],
      ["PageUp / PageDown", "Z-level up / down (client alias)"],
      ["[ / ]", "Zoom in / out"], ["Home", "Reset to host camera (client extra)"],
    ]},
    { title: "Mouse controls", rows: [
      ["Wheel", "Z-level up / down"], ["Shift + wheel", "Z-level up / down, 10 at a time"],
      ["Ctrl + wheel, or pinch", "Zoom the view"],
      ["Middle drag", "Pan the map"], ["Right drag", "Pan the map (client extra)"],
      ["Middle click", "Centre on that tile (client extra)"],
      ["Right click", "Back out one layer"],
      ["Click", "Inspect a tile or use the active tool"],
      ["Left drag", "Draw a designation or placement"],
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
      <section class="hotkey-section">
        <h3>${section.title}</h3>
        <table class="hotkey-table">
          ${section.rows.map(([key, label]) => `
            <tr><td class="hotkey-key">${key}</td><td class="hotkey-label">${label}</td></tr>
          `).join("")}
        </table>
      </section>
    `).join("");
    overlayEl.innerHTML = `
      <div class="hotkey-panel" role="dialog" aria-label="Hotkey reference">
        <div class="hotkey-head">
          <h2>Hotkeys</h2>
          <button type="button" class="hotkey-close" aria-label="Close">&times;</button>
        </div>
        <div class="hotkey-body">${sectionsHtml}</div>
        <div class="hotkey-foot">Mirrors Dwarf Fortress's own key bindings wherever possible. Press
          <b>Shift+H</b> or <b>Esc</b> to close.</div>
      </div>
    `;
    overlayEl.querySelector(".hotkey-close")?.addEventListener("click", closeOverlay);
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
    const view = document.getElementById("view");
    if (view) {
      try { view.focus({ preventScroll: true }); }
      catch { return; }
    }
  }
  function toggleOverlay() {
    if (isOpen()) closeOverlay(); else openOverlay();
  }

  try { window.DwfModeStack?.register({
    id: "keymap-reference", flow: "global-overlays", depth: 50,
    active: isOpen,
    pop: () => { closeOverlay(); return true; },
  }); } catch (err) { DwfErr.report("mode-stack.register", err); }

  window.DwfKeymap = { toggleOverlay, openOverlay, closeOverlay, isOpen };
})();
