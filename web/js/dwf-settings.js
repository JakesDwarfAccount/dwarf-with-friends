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

// ============================================================================================
// CLIENT SETTINGS PANEL (Phase 5): keybind remapping, UI preferences, UI scale (absorbs PDF-B17),
// and read-only info. All persisted in localStorage. Opened from the Esc menu's "Settings" row
// (dwf-escmenu.js) -- and dormant-safe: if this file never loads or the panel never opens,
// the client behaves EXACTLY as before (the keybind resolver below is only consulted when
// window.DFKeybinds exists AND a user override is present; with zero overrides it is the identity
// function, so no keypress changes behavior).
//
// ARCHITECTURE (why it is surgical):
//   The client is a SEMANTIC client: it has no raw-keystroke passthrough to DF. Every key maps to
//   a CLIENT action (openPanel/armDesignation/queueMove/performAction). There are two live keydown
//   dispatchers:
//     * dwf-core.js  (capture phase)  -- owns CAMERA keys (arrows/wasd/PageUp-Down/e-c/[-]/
//       Home). Multi-alias, capture-phase, stopImmediatePropagation. Left FIXED (read-only in the
//       panel) -- remapping camera keys is the "unsafe" class the brief allows us to keep read-only.
//     * dwf-controls-placement.js (bubble phase) -- a `switch (event.key)` over DF's
//       semantic single-key hotkeys (dig/build/panels/pause/display-toggles). THIS is the
//       remappable surface, and its switch now reads `DFKeybinds.resolve(event)` instead of
//       `event.key` (one-line touchpoint), falling back to `event.key` if this module is absent.
//   dwf-keymap.js is pure DOCUMENTATION (the WD-28 audit table + the "?" reference overlay);
//   it does not dispatch, so it is untouched.
//
//   RESOLVER CONTRACT: resolve(event) returns the CANONICAL (default) key string that the switch's
//   `case` labels already match. Pressing a key that a user has bound to action A returns A's
//   DEFAULT key -> the existing `case` fires unchanged. A key whose default action was remapped
//   AWAY (and nothing else now maps to it) returns a sentinel "\u0000" -> the switch's `default:`
//   branch -> no-op (and no preventDefault, so it passes through cleanly). Keys we do not manage
//   are returned verbatim. => the two switches need no case rewrites, only the one dispatch-source
//   swap. Camera/help/diagnostic keys are NOT managed, so they always pass through untouched.
//
//   CROSS-DISPATCHER SAFETY: camera keys are RESERVED as remap targets (you cannot bind a fort tool
//   onto `a`/`w`/arrows/etc.) precisely because core.js's capture handler would swallow them before
//   the fort-tool switch ever runs. decodeOverrides() drops any override onto a reserved key, and
//   the rebind UI rejects it -- see the harness counterexample cell.

(function (root) {
  "use strict";

  // ==========================================================================================
  // PURE CORE (no DOM / no localStorage) -- exported as DFSettings._pure for the Node harness.
  // ==========================================================================================

  var KEYBINDS_LS_KEY = "dwf.keybinds";
  var UI_SCALE_MIN = 0.7, UI_SCALE_MAX = 1.6;

  // The REMAPPABLE action registry: one entry per DF-semantic single-key hotkey handled by
  // dwf-controls-placement.js's switch. `default` is the exact `event.key` its `case` label
  // matches (case-sensitive: an uppercase letter is a Shift+letter chord). Array ORDER is the
  // deterministic tie-break for a dispatch-time conflict (later entry wins boundBy) -- the panel
  // warns about the conflict so a user resolves it; this just makes the interim behavior defined.
  var ACTIONS = [
    // Designations
    { id: "dig",         default: "m", label: "Dig / Mine",            cat: "Designations" },
    { id: "gather",      default: "g", label: "Gather plants",         cat: "Designations" },
    { id: "chop",        default: "l", label: "Chop trees",            cat: "Designations" },
    { id: "smooth",      default: "v", label: "Smooth floors/walls",   cat: "Designations" },
    { id: "erase",       default: "x", label: "Erase designations",    cat: "Designations" },
    { id: "itemdesig",   default: "i", label: "Item/building designations", cat: "Designations" },
    // Structures & modes
    { id: "build",       default: "b", label: "Build",                 cat: "Structures" },
    { id: "stockpile",   default: "p", label: "Stockpiles",            cat: "Structures" },
    { id: "zone",        default: "z", label: "Zones",                 cat: "Structures" },
    { id: "burrows",     default: "U", label: "Burrows",               cat: "Structures" },
    { id: "hauling",     default: "h", label: "Hauling routes",        cat: "Structures" },
    { id: "traffic",     default: "T", label: "Traffic designations",  cat: "Structures" },
    // Fort info panels
    { id: "citizens",    default: "u", label: "Units / Creatures",     cat: "Fort panels" },
    { id: "tasks",       default: "t", label: "Tasks / Jobs",          cat: "Fort panels" },
    { id: "labor",       default: "y", label: "Labor",                 cat: "Fort panels" },
    { id: "workorders",  default: "o", label: "Work orders",           cat: "Fort panels" },
    { id: "nobles",      default: "n", label: "Nobles",                cat: "Fort panels" },
    { id: "objects",     default: "O", label: "Objects / Artifacts",   cat: "Fort panels" },
    { id: "alerts",      default: "N", label: "Announcements",         cat: "Fort panels" },
    { id: "locations",   default: "P", label: "Locations / Places",    cat: "Fort panels" },
    { id: "squads",      default: "q", label: "Squads",                cat: "Fort panels" },
    { id: "justice",     default: "j", label: "Justice",               cat: "Fort panels" },
    { id: "stocks",      default: "k", label: "Stocks",                cat: "Fort panels" },
    { id: "worldmap",    default: "Y", label: "World map",             cat: "Fort panels" },
    { id: "kitchen",     default: "F", label: "Kitchen",               cat: "Fort panels" },
    { id: "petitions",   default: "G", label: "Petitions",             cat: "Fort panels" },
    { id: "obligations", default: "B", label: "Obligations board",      cat: "Fort panels" },
    // System & display
    { id: "pause",       default: " ", label: "Pause / Unpause",       cat: "System & display" },
    { id: "rampArrows",  default: "r", label: "Toggle ramp indicators", cat: "System & display" },
    { id: "liquidNums",  default: "f", label: "Toggle liquid numerals", cat: "System & display" },
    // Saved map-location jumps (B203). Digits 1-9 zoom the camera to the location saved in that
    // list slot -- global (fire from the map view, panel open or not), the way DF's own hotkeys
    // work. dwf-hotkeys.js owns the jump (it holds the live slot list); it resolves the
    // pressed key through DFKeybinds.resolve() exactly like the fort-tool switch, so a remapped
    // digit still jumps and a digit reassigned to another action stops jumping. Listed LAST so a
    // location wins the deterministic tie-break if a user also binds another action onto a digit
    // (the panel banners the conflict so they can resolve it).
    { id: "location1",   default: "1", label: "Jump to location 1",     cat: "Locations" },
    { id: "location2",   default: "2", label: "Jump to location 2",     cat: "Locations" },
    { id: "location3",   default: "3", label: "Jump to location 3",     cat: "Locations" },
    { id: "location4",   default: "4", label: "Jump to location 4",     cat: "Locations" },
    { id: "location5",   default: "5", label: "Jump to location 5",     cat: "Locations" },
    { id: "location6",   default: "6", label: "Jump to location 6",     cat: "Locations" },
    { id: "location7",   default: "7", label: "Jump to location 7",     cat: "Locations" },
    { id: "location8",   default: "8", label: "Jump to location 8",     cat: "Locations" },
    { id: "location9",   default: "9", label: "Jump to location 9",     cat: "Locations" },
  ];

  var DEFAULTS_BY_ID = {};
  for (var i = 0; i < ACTIONS.length; i++) DEFAULTS_BY_ID[ACTIONS[i].id] = ACTIONS[i].default;

  // Keys that may NOT be a remap target (and are shown read-only in the panel). Two groups:
  //   (a) CAMERA / capture-owned keys -- core.js's capture handler consumes these before the
  //       fort-tool switch runs, so binding a tool onto one would be dead. (WD-28 already moved
  //       every fort-tool default OFF these, so none of ACTIONS' defaults collide with this set.)
  //   (b) STRUCTURAL / reference keys -- Escape (the UI back-out cascade) and the help/diagnostic
  //       keys (?/F1/F3/H), which the switch/overlay own outside this registry.
  var RESERVED_KEYS = new Set([
    // camera pan
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
    "a", "A", "w", "W", "s", "S", "d", "D",
    // camera z / zoom / reset
    "e", "E", "c", "C", "PageUp", "PageDown", ">", "<",
    "[", "]", "=", "+", "-", "_", "Home",
    // structural / reference
    "Escape", "?", "F1", "F3", "H",
  ]);

  // Is `key` acceptable as a remap TARGET? A single printable character or Space, and not reserved.
  // Multi-char keys (Arrow*, F-keys) are refused as targets -- they belong to the camera/help sets.
  function isValidBindKey(key) {
    if (typeof key !== "string" || key.length === 0) return false;
    if (RESERVED_KEYS.has(key)) return false;
    if (key === " ") return true;         // Space (default for pause) is allowed
    return key.length === 1;              // exactly one character (letters/symbols/digits)
  }

  // Parse the persisted override string into a CLEAN {actionId: key} map. Every guard here is the
  // corrupt-input fallback the harness exercises: bad JSON -> {}, non-object -> {}, unknown action
  // id -> dropped, invalid/reserved key -> dropped (that action falls back to its default). A single
  // bad entry never poisons the rest.
  function decodeOverrides(raw) {
    var obj;
    try { obj = JSON.parse(raw); } catch (_) { return {}; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    var clean = {};
    for (var id in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, id)) continue;
      if (!DEFAULTS_BY_ID[id]) continue;           // unknown action -> drop
      if (!isValidBindKey(obj[id])) continue;      // invalid/reserved -> drop -> defaults win
      clean[id] = obj[id];
    }
    return clean;
  }

  function encodeOverrides(map) {
    var out = {};
    for (var id in map) {
      if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
      if (DEFAULTS_BY_ID[id] && map[id] !== DEFAULTS_BY_ID[id] && isValidBindKey(map[id])) out[id] = map[id];
    }
    return JSON.stringify(out);
  }

  // The effective key for an action = its override if present, else its default.
  function effectiveKey(id, overrides) {
    overrides = overrides || {};
    return (overrides[id] != null) ? overrides[id] : DEFAULTS_BY_ID[id];
  }

  // Physical-key -> actionId, with the ACTIONS-order "last wins" tie-break for a shared key.
  function computeBoundBy(overrides) {
    var boundBy = {};
    for (var j = 0; j < ACTIONS.length; j++) {
      boundBy[effectiveKey(ACTIONS[j].id, overrides)] = ACTIONS[j].id;
    }
    return boundBy;
  }

  // The set of physical keys this layer manages (all defaults + all override targets). A key
  // outside this set is none of our business and resolve() returns it verbatim.
  function computeManaged(overrides) {
    var managed = new Set();
    for (var j = 0; j < ACTIONS.length; j++) managed.add(ACTIONS[j].default);
    if (overrides) for (var id in overrides) { if (overrides[id]) managed.add(overrides[id]); }
    return managed;
  }

  // The core dispatch translation (see file header RESOLVER CONTRACT). Pure: takes the pressed
  // key string + the override map, returns the canonical key the switch should match.
  function resolveKeyString(pressedKey, overrides) {
    overrides = overrides || {};
    var managed = computeManaged(overrides);
    if (!managed.has(pressedKey)) return pressedKey;         // untouched (camera/help/typing/etc.)
    var actionId = computeBoundBy(overrides)[pressedKey];
    if (actionId) return DEFAULTS_BY_ID[actionId];           // canonical key the `case` label matches
    return "\u0000";                                         // managed but now unbound -> switch default -> no-op
  }

  // Conflicts = any effective key shared by >1 action. Returns [{key, actions:[id,...]}].
  function detectConflicts(overrides) {
    overrides = overrides || {};
    var byKey = {};
    for (var j = 0; j < ACTIONS.length; j++) {
      var k = effectiveKey(ACTIONS[j].id, overrides);
      (byKey[k] = byKey[k] || []).push(ACTIONS[j].id);
    }
    var out = [];
    for (var k2 in byKey) { if (byKey[k2].length > 1) out.push({ key: k2, actions: byKey[k2] }); }
    return out;
  }

  // UI-scale clamp (absorbs PDF-B17's clamp; mirrors dwf-controls-placement.js's DWFUIScale).
  function clampScale(v, min, max) {
    min = (min == null) ? UI_SCALE_MIN : min;
    max = (max == null) ? UI_SCALE_MAX : max;
    v = Number(v);
    if (!isFinite(v)) return 1;
    v = Math.round(v * 100) / 100;
    return Math.min(max, Math.max(min, v));
  }

  // The server's optional AUX `env.autosave` is a closed DF enum, so only known values may be
  // displayed. An absent, malformed, or future value stays honest instead of being invented.
  function autosaveIntervalLabel(value) {
    switch (value) {
      case "none": return "None";
      case "seasonal": return "Seasonal";
      case "yearly": return "Yearly";
      case "semiannual": return "Semiannual";
      default: return "Not reported by the host";
    }
  }

  var PURE = {
    KEYBINDS_LS_KEY: KEYBINDS_LS_KEY,
    ACTIONS: ACTIONS,
    DEFAULTS_BY_ID: DEFAULTS_BY_ID,
    RESERVED_KEYS: RESERVED_KEYS,
    isValidBindKey: isValidBindKey,
    decodeOverrides: decodeOverrides,
    encodeOverrides: encodeOverrides,
    effectiveKey: effectiveKey,
    computeBoundBy: computeBoundBy,
    computeManaged: computeManaged,
    resolveKeyString: resolveKeyString,
    detectConflicts: detectConflicts,
    clampScale: clampScale,
    autosaveIntervalLabel: autosaveIntervalLabel,
  };

  // ==========================================================================================
  // STATEFUL LAYER (localStorage-backed) -- overrides cache + the DFKeybinds.resolve() the two
  // dispatchers consult. Kept alive even with no DOM so the resolver works headless.
  // ==========================================================================================

  var overrides = {};        // {actionId: key}
  var _managed = computeManaged({});
  var _boundBy = computeBoundBy({});

  function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (_) { return null; } }
  function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, v); } catch (_) {} }

  function recompute() {
    _managed = computeManaged(overrides);
    _boundBy = computeBoundBy(overrides);
  }

  function loadOverrides() {
    overrides = decodeOverrides(lsGet(KEYBINDS_LS_KEY) || "");
    recompute();
  }

  function persist() { lsSet(KEYBINDS_LS_KEY, encodeOverrides(overrides)); }

  // Live resolver used by both dispatchers (cached fast path -- no per-keypress JSON parse).
  function resolve(event) {
    try {
      var k = event && event.key;
      if (typeof k !== "string") return k;
      if (!_managed.has(k)) return k;
      var id = _boundBy[k];
      return id ? DEFAULTS_BY_ID[id] : "\u0000";
    } catch (_) { return event && event.key; }
  }

  function setBinding(actionId, key) {
    if (!DEFAULTS_BY_ID[actionId]) return false;
    if (!isValidBindKey(key)) return false;                  // rejects reserved/invalid targets
    if (key === DEFAULTS_BY_ID[actionId]) delete overrides[actionId];  // back to default -> no override stored
    else overrides[actionId] = key;
    recompute(); persist();
    return true;
  }

  function resetBinding(actionId) {
    if (overrides[actionId] != null) { delete overrides[actionId]; recompute(); persist(); }
  }

  function resetAll() { overrides = {}; recompute(); persist(); }

  loadOverrides();

  // ==========================================================================================
  // UI (guarded -- skipped entirely with no document, e.g. under the Node harness).
  // ==========================================================================================

  var doc = root.document;
  var hasDom = typeof doc !== "undefined" && !!doc && !!doc.createElement;

  // DWFUI contract -- see dwf-escmenu.js. Declared LAZILY (inside the DOM guard) because the
  // Node keybind harness loads this file's PURE core with no DWFUI and no document at all.
  if (hasDom && typeof root.DWFUI !== "undefined" && typeof root.DWFUI.require === "function")
    root.DWFUI.require("settings", ["headerHtml", "nonNativeTabsHtml", "plaqueBtnHtml", "switchHtml",
      "rowHtml", "scrollHtml", "bitmapTextHtml", "esc", "TOKENS"]);

  // Was a private escapeHtml shim. DWFUI.esc is the shared escaper. (It does not escape `'`; every
  // attribute this module writes is double-quoted, so the escape set is equivalent here.)
  function esc(s) { return root.DWFUI.esc(s); }

  // Human label for a key string (Space, Shift+X for a bare uppercase letter, else the key).
  function keyLabel(key) {
    if (key == null || key === "") return "(unbound)";
    if (key === " ") return "Space";
    if (key === "\u0000") return "(unbound)";
    if (key.length === 1 && key >= "A" && key <= "Z") return "Shift+" + key;
    return key;
  }

  var backdrop = null, panel = null, curTab = "keybinds", rebindingId = null;

  // R1: this block carried 52 HEX LITERALS -- the single largest private palette in the family, and
  // it was INVISIBLE to the drift guard purely because of its SYNTAX (`.textContent = [...].join("")`
  // holds no template literal and is not a declaration). Wave 5 widened R1 to see it. Every colour
  // now resolves through the `--dwfui-*` custom properties (F1's measured native palette) declared
  // once in dwf.css :root. NO COLOUR IS STATED HERE. Geometry stays: this is the strangler
  // seam, and CSS consolidation is a later wave.
  //
  // R4: `.if-toggle` -- the THIRD copy of the 34x18 gold pill -- IS DELETED, together with its
  // ::after knob and its two `.on` rules. renderInterface() now emits DWFUI.switchHtml, whose own
  // `.dwfui-switch-track` / `.dwfui-switch-knob` paint the control. That takes R4 in this family to 0.
  function ensureStyle() {
    if (!hasDom || doc.getElementById("dfSettingsStyle")) return;
    var st = doc.createElement("style");
    st.id = "dfSettingsStyle";
    st.textContent = [
      // Backdrop + centered modal (safe placement: a centered modal never collides with the
      // fixed HUD clusters -- bottomBar / zone submenus / docked panels / hoverInfo / chat).
      "#dfSettingsBackdrop{position:fixed;inset:0;z-index:120;display:none;",
      "background:rgba(0,0,0,.5);align-items:center;justify-content:center;}",
      "#dfSettingsBackdrop.open{display:flex;}",
      "#dfSettingsPanel{width:min(720px,94vw);max-height:88vh;display:flex;flex-direction:column;",
      "background:var(--dwfui-surface);border:2px solid var(--dwfui-gold);color:var(--dwfui-text-body);",
      "font:12px/1.4 ui-monospace,Consolas,monospace;box-shadow:0 10px 30px rgba(0,0,0,.6);}",
      "#dfSettingsPanel .dfs-head{display:flex;align-items:center;justify-content:space-between;",
      "padding:10px 12px;border-bottom:1px solid var(--dwfui-gold-bevel-dark);}",
      "#dfSettingsPanel .dfs-head h2{margin:0;font-size:14px;color:var(--dwfui-gold);letter-spacing:.5px;}",
      "#dfSettingsPanel .dfs-x{background:none;border:none;cursor:pointer;line-height:1;}",
      "#dfSettingsPanel .dfs-body{display:flex;min-height:0;flex:1;}",
      "#dfSettingsPanel .dfs-nav{flex:0 0 130px;border-right:1px solid var(--dwfui-gold-bevel-dark);padding:8px 0;display:flex;flex-direction:column;}",
      "#dfSettingsPanel .dfs-tab{background:none;border:none;color:var(--dwfui-text-secondary);text-align:left;padding:8px 14px;cursor:pointer;font:inherit;}",
      "#dfSettingsPanel .dfs-tab:hover{background:var(--dwfui-hatch);color:var(--dwfui-gold);}",
      "#dfSettingsPanel .dfs-tab.on{background:var(--dwfui-slab);color:var(--dwfui-gold);border-left:3px solid var(--dwfui-gold);padding-left:11px;}",
      // .dfs-pane is now DWFUI.scrollHtml's node: the native scrollbar comes from .dwfui-scroll, so
      // this rule must NOT restate overflow (that is what manufactured the browser-default bar).
      "#dfSettingsPanel .dfs-pane{flex:1;min-width:0;padding:12px 14px;}",
      "#dfSettingsPanel h3{margin:14px 0 6px;font-size:12px;color:var(--dwfui-gold);font-weight:700;border-bottom:1px solid var(--dwfui-gold-bevel-dark);padding-bottom:3px;}",
      "#dfSettingsPanel h3:first-child{margin-top:0;}",
      "#dfSettingsPanel .dfs-note{color:var(--dwfui-text-secondary);font-size:11px;margin:4px 0 8px;}",
      // Keybind rows -- now DWFUI.rowHtml({chassis:'table'}); the grid template stays on .kb-row.
      "#dfSettingsPanel .kb-row{display:grid;grid-template-columns:minmax(0,1fr) 120px 78px;gap:8px;align-items:center;padding:4px 2px;border-bottom:1px solid var(--dwfui-hatch);}",
      "#dfSettingsPanel .kb-row .dwfui-copy{display:none;}",
      "#dfSettingsPanel .kb-row.conflict{background:var(--dwfui-destructive);}",
      "#dfSettingsPanel .kb-row.readonly{opacity:.6;}",
      "#dfSettingsPanel .kb-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
      // The bind/reset controls are DWFUI plaques now; only the CELL sizing lives here. The plaque's
      // own native slab art + bitmap label come from .dwfui-plaque (dwf.css) -- one plaque.
      "#dfSettingsPanel .kb-bind{width:100%;min-width:0;}",
      "#dfSettingsPanel .kb-bind.listening{animation:dfsPulse 1s infinite;}",
      "#dfSettingsPanel .kb-reset{width:100%;min-width:0;padding:0 4px;}",
      "@keyframes dfsPulse{50%{opacity:.55;}}",
      "#dfSettingsPanel .dfs-banner{background:var(--dwfui-destructive);border:1px solid var(--dwfui-text-warning);color:var(--dwfui-text-title);padding:6px 8px;margin:0 0 8px;font-size:11px;}",
      "#dfSettingsPanel .dfs-actions{display:flex;gap:8px;margin-top:10px;}",
      // Interface rows are DWFUI.switchHtml now (R4): no private pill, no ::after knob.
      "#dfSettingsPanel .if-row{display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid var(--dwfui-hatch);cursor:pointer;}",
      "#dfSettingsPanel .if-row:hover{background:var(--dwfui-hatch);}",
      "#dfSettingsPanel .if-scale{display:flex;align-items:center;gap:10px;padding:8px 2px;}",
      // DECLARED NON-NATIVE CONTROL (see renderInterface): DF has NO continuous-value control, so
      // there is no native grammar to render. The raw range input stays, unrestyled.
      "#dfSettingsPanel .if-scale input[type=range]{flex:1;accent-color:var(--dwfui-gold);}",
      "#dfSettingsPanel .if-scale .val{min-width:44px;text-align:right;color:var(--dwfui-gold);font-variant-numeric:tabular-nums;}",
      "#dfSettingsPanel .info-row{display:flex;justify-content:space-between;gap:10px;padding:5px 2px;border-bottom:1px solid var(--dwfui-hatch);}",
      "#dfSettingsPanel .info-row .dwfui-copy{display:none;}",
      "#dfSettingsPanel .info-row .k{color:var(--dwfui-text-secondary);}",
      "#dfSettingsPanel .info-row .v{color:var(--dwfui-text-body);text-align:right;}",
    ].join("");
    (doc.head || doc.documentElement).appendChild(st);
  }

  function ensurePanel() {
    if (panel) return;
    ensureStyle();
    backdrop = doc.createElement("div");
    backdrop.id = "dfSettingsBackdrop";
    panel = doc.createElement("div");
    panel.id = "dfSettingsPanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Settings");
    backdrop.appendChild(panel);
    doc.body.appendChild(backdrop);
    // Click the dimmed backdrop (outside the panel) to close.
    backdrop.addEventListener("pointerdown", function (ev) { if (ev.target === backdrop) close(); });
  }

  var TABS = [
    { id: "keybinds",  label: "Keybinds" },
    { id: "interface", label: "Interface" },
    { id: "audio",     label: "Audio" },
    { id: "info",      label: "Info" },
  ];

  function settingsMarkup(tab) {
    var activeTab = TABS.some(function (t) { return t.id === tab; }) ? tab : "keybinds";
    // NOT A NATIVE TAB ROW. This Settings panel (Keybinds / Interface / Audio / Info) is a BROWSER-
    // CLIENT screen -- it configures our web client, and DF has no counterpart to copy. There is no
    // oracle capture of it and no F3 row for it in the native-component matrix. Giving it a native tab
    // grammar would be inventing one, so it declares the opt-out instead of hiding it.
    var navHtml = root.DWFUI.nonNativeTabsHtml({ cls: "dfs-nav", tabCls: "dfs-tab", activeCls: "on", dataAttr: "tab", ariaLabel: "Settings sections", active: activeTab,
      reason: "browser-client settings screen; no native DF counterpart and no oracle capture -- no F3 grammar to adopt",
      tabs: TABS.map(function (t) { return { key: t.id, label: t.label }; }) });
    var pane =
      activeTab === "keybinds" ? renderKeybinds() :
      activeTab === "interface" ? renderInterface() :
      activeTab === "audio" ? renderAudio() :
      renderInfo();
    // The `glyph: "&times;"` escape hatch is dropped: headerHtml now renders the NATIVE close tile
    // (BUILDING_JOBS_REMOVE via artBtnHtml). The pinned `.dfs-x` class and the click wire survive.
    // The pane's raw `overflow:auto` becomes scrollHtml -- the browser-default scrollbar was the
    // "very important" F5 complaint. `preserveKey` keeps the scroll position across the re-render
    // that every rebind / toggle triggers (the keybind list is 34 rows and DID jump to the top).
    return root.DWFUI.headerHtml({ cls: "dfs-head", titleTag: "h2", title: "Settings", titleCls: "dfs-title", close: { cls: "dfs-x", dataset: { dfsClose: "" }, title: "Close" } }) +
      '<div class="dfs-body">' + navHtml +
      root.DWFUI.scrollHtml({ cls: "dfs-pane", preserveKey: "settings:" + activeTab }, pane) +
      "</div>";
  }

  function render() {
    if (!panel) return;
    panel.innerHTML = settingsMarkup(curTab);

    panel.querySelector(".dfs-x").addEventListener("click", close);
    panel.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { cancelRebind(); curTab = b.dataset.tab; render(); });
    });
    if (curTab === "keybinds") wireKeybinds();
    else if (curTab === "interface") wireInterface();
    else if (curTab === "audio") wireAudio();
  }

  // ---- Keybinds tab -------------------------------------------------------------------------
  // NON-NATIVE SURFACE, DECLARED. DF has no keybind remapper, so there is no native oracle for this
  // screen and none is invented. What IS adopted is the GRAMMAR: every control below is a DWFUI
  // builder, so it speaks the same visual language as the rest of the game (matrix §7.3). The 34
  // remappable actions are a SUPERSET and every one of them stays -- deleting this screen would kill
  // every fort-tool hotkey in the client.
  //
  // THE `kb-reset` CONTROL, AND WHY IT IS A WORD AND NOT A TILE: it means "revert this binding to its
  // default", and grep over web/interface_map.json's 1,502 tokens returns ZERO hits for
  // RESET / UNDO / REVERT / RESTORE / DEFAULT. THERE IS NO NATIVE SPRITE FOR THIS ACTION. It used to
  // render the clockwise-open-circle-arrow HTML entity (TOKENS.glyphs.repeat's character) -- an
  // emoji-class glyph, and this file's only R3 violation. The fix is NOT to fabricate a tile, and NOT
  // to borrow an unrelated one (the gold
  // BUTTON_CLOSE_LEFT back-arrow was the tempting near-miss): it is to use the grammar DF ITSELF uses
  // when it has no icon -- a TEXT PLAQUE. So the control now reads "Reset". Zero invented art, zero
  // emoji, R3 -> 0. The missing sprite is reported as an art gap, not papered over.
  function renderKeybinds() {
    var conflicts = detectConflicts(overrides);
    var banner = "";
    if (conflicts.length) {
      var lines = conflicts.map(function (c) {
        var names = c.actions.map(function (id) {
          var a = ACTIONS.find(function (x) { return x.id === id; });
          return a ? a.label : id;
        }).join(" & ");
        return keyLabel(c.key) + " -> " + names;
      });
      banner = '<div class="dfs-banner"><b>Key conflict:</b> ' + esc(lines.join("; ")) +
        '. The last-listed action wins when pressed.</div>';
    }
    var D = root.DWFUI;
    var cats = [];
    ACTIONS.forEach(function (a) { if (cats.indexOf(a.cat) < 0) cats.push(a.cat); });
    var body = cats.map(function (cat) {
      var rows = ACTIONS.filter(function (a) { return a.cat === cat; }).map(function (a) {
        var key = effectiveKey(a.id, overrides);
        var isConflict = conflicts.some(function (c) { return c.key === key; });
        var isOverridden = overrides[a.id] != null;
        var listening = rebindingId === a.id;
        // The BIND control is a native text plaque showing the currently-bound key. The RESET control
        // is a native text plaque reading "Reset" -- native has no reset/undo/revert SPRITE (verified
        // absent from all 1,502 tokens in interface_map.json), and a text plaque is the grammar DF
        // uses when it has no icon. It is NOT an invented tile and NOT the retired emoji.
        var bind = D.plaqueBtnHtml({
          label: listening ? "Press a key…" : keyLabel(key),
          tone: "grey", cls: "kb-bind" + (listening ? " listening" : ""),
          dataset: { rebind: a.id }, title: "Click, then press the new key",
        });
        var reset = D.plaqueBtnHtml({
          label: "Reset", tone: "grey", cls: "kb-reset", dataset: { reset: a.id },
          disabled: !isOverridden, title: "Reset to default (" + keyLabel(a.default) + ")",
        });
        return D.rowHtml({
          chassis: "table", cls: "kb-row" + (isConflict ? " conflict" : ""),
          dataset: { action: a.id }, title: a.label,
          cells: [{ html: esc(a.label), cls: "kb-label" }, { html: bind }, { html: reset }],
        });
      }).join("");
      return "<h3>" + esc(cat) + "</h3>" + rows;
    }).join("");
    // Read-only reference: the FIXED camera + system keys (not remappable -- see file header).
    var fixed = [
      ["Arrows / W A S D", "Pan camera (Shift = fast)"],
      ["PageUp / PageDown, E / C", "Z-level up / down"],
      ["[ / ]", "Zoom in / out"],
      ["Home", "Reset camera to host"],
      ["Esc", "Back out one layer / open this menu"],
      ["Shift+H, ?, F1", "Hotkey reference overlay"],
      ["F3", "Performance overlay"],
      ["Ctrl + / − / 0, Ctrl+Wheel", "UI scale (see Interface tab)"],
    ].map(function (r) {
      return D.rowHtml({
        chassis: "table", cls: "kb-row readonly",
        cells: [
          { html: esc(r[1]), cls: "kb-label" },
          { html: D.plaqueBtnHtml({ label: r[0], tone: "grey", cls: "kb-bind dim", disabled: true }) },
        ],
      });
    }).join("");
    return banner +
      '<div class="dfs-note">Click a binding, then press the new key. These apply to client ' +
      'shortcuts only. Space and Shift+letter chords are allowed; camera and system keys below ' +
      'are fixed.</div>' +
      body +
      '<div class="dfs-actions">' +
      D.plaqueBtnHtml({ label: "Reset all to defaults", tone: "grey", cls: "dfs-btn",
        dataset: { resetAll: "" }, title: "Restore every keybind to its default" }) +
      '</div>' +
      '<h3>Fixed controls (not remappable)</h3>' + fixed;
  }

  function wireKeybinds() {
    panel.querySelectorAll("[data-rebind]").forEach(function (b) {
      b.addEventListener("click", function () { startRebind(b.dataset.rebind); });
    });
    panel.querySelectorAll("[data-reset]").forEach(function (b) {
      if (b.disabled) return;
      b.addEventListener("click", function () { cancelRebind(); resetBinding(b.dataset.reset); render(); });
    });
    var all = panel.querySelector("[data-reset-all]");
    if (all) all.addEventListener("click", function () { cancelRebind(); resetAll(); render(); });
  }

  function startRebind(actionId) {
    rebindingId = actionId;
    render();
    doc.addEventListener("keydown", captureRebind, true);
  }
  function cancelRebind() {
    if (rebindingId == null) return;
    rebindingId = null;
    try { doc.removeEventListener("keydown", captureRebind, true); } catch (_) {}
  }
  function captureRebind(ev) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    var k = ev.key;
    if (k === "Escape") { cancelRebind(); render(); return; }
    // Ignore bare modifier presses -- wait for the actual key.
    if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return;
    // Reject modifier-combos (we can't express Ctrl/Alt in a single event.key the switch matches)
    // and reserved/invalid targets -- leaving the binding unchanged.
    var id = rebindingId;
    cancelRebind();
    if (ev.ctrlKey || ev.altKey || ev.metaKey || !isValidBindKey(k)) {
      // brief inline feedback via a re-render banner note
      flashReject(k);
      render();
      return;
    }
    setBinding(id, k);
    render();
  }
  var rejectMsg = "";
  function flashReject(k) {
    rejectMsg = "\"" + keyLabel(k) + "\" can't be used (reserved for camera/system, or needs no modifier).";
    setTimeout(function () { rejectMsg = ""; if (backdrop && backdrop.classList.contains("open")) render(); }, 2200);
  }

  // ---- Interface tab ------------------------------------------------------------------------
  function panelFrameEnabled() {
    try { return root.DFPanelFrame ? root.DFPanelFrame.enabled : root.localStorage.getItem("dwf.panelFrame.enabled") !== "0"; }
    catch (_) { return true; }
  }

  function renderInterface() {
    var scale = 1;
    try { if (root.DWFUIScale) scale = root.DWFUIScale.get(); } catch (_) {}
    var pct = Math.round(clampScale(scale) * 100);
    var prefsHtml = "";
    var prefs = null;
    try { if (root.DFClientPrefs) prefs = root.DFClientPrefs.list(); } catch (_) {}
    if (prefs && prefs.length) {
      // R4: this was a hand-rolled `if-row` + `if-toggle` pill -- the THIRD copy of a control DWFUI
      // already owns. switchHtml renders the SHARED track+knob; [data-pref] (now on the switch root)
      // is the SAME wire wireInterface() has always read, so every client pref still round-trips.
      prefsHtml = prefs.map(function (p) {
        var on = false; try { on = !!p.get(); } catch (_) {}
        return root.DWFUI.switchHtml({
          cls: "if-row" + (on ? " on" : ""), checked: on,
          rootDataset: { pref: p.id }, label: p.label,
        });
      }).join("");
    } else {
      prefsHtml = '<div class="dfs-note">Interface toggles are provided by the top-bar cog menu ' +
        'on this build.</div>';
    }
    return '<h3>UI scale</h3>' +
      '<div class="dfs-note">Size of the interface panels and toolbars (the map is never rescaled). ' +
      'Also Ctrl + mouse wheel, or Ctrl + / − / 0.</div>' +
      // *** DECLARED NON-NATIVE CONTROL: THE UI-SCALE SLIDER STAYS A RAW RANGE INPUT. ***
      // DWFUI has no sliderHtml and MUST NOT GROW ONE. DF has NO continuous-value control anywhere:
      // grepping web/interface_map.json's 1,502 tokens for SLIDER|TRACK|THUMB|VOLUME returns no value
      // affordance (the one continuous thing DF owns is the SCROLLBAR -- a SCROLL affordance, not a
      // VALUE one). A sliderHtml would be a DWFUI component with NO NATIVE GRAMMAR TO RENDER, and
      // inventing DF art for a control DF does not have is exactly what the parity rules forbid.
      // UI scale is a WIRED SUPERSET (ours, not DF's) -- so the control STAYS: unrestyled, declared,
      // reported. R7 deliberately does not flag type=range; that is not an oversight.
      '<div class="if-scale"><input type="range" id="dfsScale" min="' + UI_SCALE_MIN + '" max="' + UI_SCALE_MAX +
      '" step="0.05" value="' + clampScale(scale) + '"><span class="val" id="dfsScaleVal">' + pct + '%</span>' +
      root.DWFUI.plaqueBtnHtml({ label: "Reset", tone: "grey", cls: "dfs-btn",
        dataset: { dfsAct: "scale-reset" }, title: "Reset the UI scale to 100%" }) + '</div>' +
      '<h3>Panels</h3>' +
      root.DWFUI.switchHtml({ cls: "if-row" + (panelFrameEnabled() ? " on" : ""),
        checked: panelFrameEnabled(), rootDataset: { dfsToggle: "panelframe" },
        label: "Movable panels (beta)" }) +
      '<div class="dfs-note">Lets migrated panels be moved, resized, closed, and remembered in this browser.</div>' +
      '<div class="dfs-actions">' +
      root.DWFUI.plaqueBtnHtml({ label: "Reset panel layout", tone: "grey", cls: "dfs-btn",
        dataset: { dfsAct: "panelframe-reset" },
        title: "Forget every remembered panel position and size" }) + '</div>' +
      '<h3>Preferences</h3>' + prefsHtml;
  }

  function wireInterface() {
    var slider = panel.querySelector("#dfsScale");
    var val = panel.querySelector("#dfsScaleVal");
    if (slider) slider.addEventListener("input", function () {
      var v = clampScale(parseFloat(slider.value));
      try { if (root.DWFUIScale) root.DWFUIScale.set(v); } catch (_) {}
      if (val) val.textContent = Math.round(v * 100) + "%";
    });
    // HOOK NOTE: #dfsScaleReset / #dfsPanelFrameReset / #dfsPanelFrameToggle / #dfsOpenAudio were
    // INTERNAL querySelector handles -- proved by grep to be referenced by no other web/js file, no
    // CSS rule, no src/ C++ source, no index.html, and no tools/ui-lab story. DWFUI builders take
    // `cls` + `dataset` hooks (the strangler seam), not ids, so each handle moves to a [data-dfs-*]
    // attribute. Same element, same handler, same action: the wire is preserved, only its name moved.
    var reset = panel.querySelector('[data-dfs-act="scale-reset"]');
    if (reset) reset.addEventListener("click", function () {
      try { if (root.DWFUIScale) root.DWFUIScale.reset(); } catch (_) {}
      if (slider) slider.value = "1";
      if (val) val.textContent = "100%";
    });
    var panelFrameToggle = panel.querySelector('[data-dfs-toggle="panelframe"]');
    if (panelFrameToggle) {
      // WTHR-2 (live-fix): the movable-panels switch is the SAME DWFUI.switchHtml chassis as the
      // [data-pref] rows below -- a <label> wrapping a checkbox -- so a `click` handler on the label
      // fires TWICE (real click + the click re-dispatched through the checkbox) and cancels its own
      // `!panelFrameEnabled()` flip out, leaving the setting unchanged while the checkbox toggled once
      // (looks flipped, isn't). Drive the inner checkbox's `change` (fires once) with `.checked` as
      // the authoritative new state, then resync the row class + checkbox to what actually applied.
      var panelFrameInput = panelFrameToggle.querySelector('input[type="checkbox"]');
      var panelFrameTarget = panelFrameInput || panelFrameToggle;
      panelFrameTarget.addEventListener(panelFrameInput ? "change" : "click", function () {
        var on = panelFrameInput ? panelFrameInput.checked : !panelFrameEnabled();
        try {
          if (root.DFPanelFrame) root.DFPanelFrame.setEnabled(on);
          else root.localStorage.setItem("dwf.panelFrame.enabled", on ? "1" : "0");
        } catch (_) {}
        var applied = panelFrameEnabled();
        panelFrameToggle.classList.toggle("on", applied);
        if (panelFrameInput) panelFrameInput.checked = applied;
      });
    }
    var panelFrameReset = panel.querySelector('[data-dfs-act="panelframe-reset"]');
    if (panelFrameReset) panelFrameReset.addEventListener("click", function () {
      try {
        if (root.DFPanelFrame) root.DFPanelFrame.resetAll();
        else root.localStorage.removeItem("dwf.panelLayout.v1");
      } catch (_) {}
    });
    panel.querySelectorAll("[data-pref]").forEach(function (row) {
      // WTHR-2 (live-fix): DWFUI.switchHtml renders these rows as a label wrapping a checkbox.
      // A click on the LABEL fires the label's click handler TWICE -- once for the real click and
      // once for the click the label re-dispatches through its associated checkbox (which bubbles
      // back up). The old `click` handler flipped `set(id, !get(id))`, so the two fires cancelled
      // out: the persisted state (and DwfWeather.setEnabled -> the rain draw gate) never changed,
      // while the native checkbox toggled exactly once -- the switch looked OFF but the overlay kept
      // drawing and reopening the panel showed it back ON. Wire the inner checkbox's `change` event
      // instead: it fires exactly ONCE per user toggle and its `.checked` is the authoritative new
      // state, so UI, persistence, and the live draw gate stay in lockstep. (Direct-call tests
      // missed this because they never went through the label's DOM click path.)
      var input = row.querySelector('input[type="checkbox"]');
      var target = input || row;
      var evt = input ? "change" : "click";
      target.addEventListener(evt, function () {
        var id = row.dataset.pref;
        try {
          if (!root.DFClientPrefs) return;
          var on = input ? input.checked : !root.DFClientPrefs.get(id);
          root.DFClientPrefs.set(id, on);
          var applied = !!root.DFClientPrefs.get(id);
          row.classList.toggle("on", applied);
          if (input) input.checked = applied; // resync the checkbox to the state actually applied
        } catch (_) {}
      });
    });
  }

  // ---- Audio tab ----------------------------------------------------------------------------
  function renderAudio() {
    return '<h3>Audio &amp; music</h3>' +
      '<div class="dfs-note">Audio has its own controls in the top-bar speaker popover: manual ' +
      'playlist, per-channel volume/mute, UI click sounds, and announcement stingers.</div>' +
      '<div class="dfs-actions">' +
      root.DWFUI.plaqueBtnHtml({ label: "Open audio controls", tone: "green", cls: "dfs-btn",
        dataset: { dfsAct: "open-audio" }, title: "Open the audio & music popover" }) +
      '</div>';
  }
  function wireAudio() {
    var b = panel.querySelector('[data-dfs-act="open-audio"]');
    if (b) b.addEventListener("click", function () {
      close();
      try { doc.getElementById("audioBtn")?.click(); } catch (_) {}
    });
  }

  // ---- Info tab -----------------------------------------------------------------------------
  function renderInfo() {
    var player = lsGet("dwf.player") || "(unset)";
    var renderer = lsGet("dwf.renderer") || "gl (default)";
    var autosave = null;
    try { autosave = root.DwfSessionInfo && root.DwfSessionInfo.autosave; } catch (_) {}
    var D = root.DWFUI;
    // The three read-only key/value lines become DWFUI table rows (the same chassis the keybind list
    // uses). `.info-row` / `.k` / `.v` stay as the pinned class hooks, and #dfsAutosave is preserved.
    var infoRow = function (k, valueHtmlRaw) {
      return D.rowHtml({ chassis: "table", cls: "info-row",
        cells: [{ html: esc(k), cls: "k" }, { html: valueHtmlRaw, cls: "v" }] });
    };
    return '<h3>Autosave</h3>' +
      infoRow("Autosave interval",
        '<span id="dfsAutosave">' + esc(autosaveIntervalLabel(autosave)) + '</span>') +
      '<div class="dfs-note">Reported read-only by the host from Dwarf Fortress\'s autosave setting.</div>' +
      '<h3>Session</h3>' +
      infoRow("Your name", esc(player)) +
      infoRow("Renderer", esc(renderer));
  }

  // ---- open / close -------------------------------------------------------------------------
  function open(tab) {
    if (!hasDom) return;
    ensurePanel();
    if (tab && TABS.some(function (t) { return t.id === tab; })) curTab = tab;
    render();
    // reflect any pending reject message from a prior rebind attempt
    if (rejectMsg && panel && curTab === "keybinds") {
      var pane = panel.querySelector(".dfs-pane");
      if (pane) pane.insertAdjacentHTML("afterbegin", '<div class="dfs-banner">' + esc(rejectMsg) + "</div>");
    }
    backdrop.classList.add("open");
  }
  function close() {
    cancelRebind();
    if (backdrop) backdrop.classList.remove("open");
    try { doc.getElementById("view")?.focus({ preventScroll: true }); } catch (_) {}
  }
  function isOpen() { return !!backdrop && backdrop.classList.contains("open"); }

  // Escape closes the panel (before the map's Esc cascade would open the Esc menu). Capture phase
  // + stopImmediatePropagation so a single Esc closes only this.
  if (hasDom) {
    doc.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && isOpen() && rebindingId == null) {
        ev.preventDefault(); ev.stopImmediatePropagation(); close();
      }
    }, true);
  }

  // ==========================================================================================
  // EXPORTS
  // ==========================================================================================
  root.DFKeybinds = {
    resolve: resolve,
    reload: loadOverrides,
    getOverrides: function () { var o = {}; for (var k in overrides) o[k] = overrides[k]; return o; },
    setBinding: setBinding, resetBinding: resetBinding, resetAll: resetAll,
    _pure: PURE,
  };
  root.DFSettings = {
    open: open, close: close, isOpen: isOpen,
    storyMarkup: settingsMarkup,
    preparePreview: ensureStyle,
    _pure: PURE,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PURE;

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
