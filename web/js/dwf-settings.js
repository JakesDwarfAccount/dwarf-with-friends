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

// ---- Client settings: keybind remapping, UI preferences, UI scale, persisted in localStorage. ----
// RESOLVER CONTRACT: resolve(event) returns the CANONICAL default key the dispatchers' `case` labels match.

(function (root) {
  "use strict";

  // ---- Pure core (no DOM, no localStorage), exported as DFSettings._pure for the Node harness. ----

  var KEYBINDS_LS_KEY = "dwf.keybinds";
  var UI_SCALE_MIN = 0.7, UI_SCALE_MAX = 1.6;

  // `default` is the exact `event.key` its `case` label matches -- case-sensitive, so an uppercase letter
  // is a Shift chord. Array ORDER is the tie-break for a dispatch-time conflict.
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

  // Keys that may NOT be a remap target: camera keys, which dwf-core.js's capture handler consumes before
  // the fort-tool switch runs, and structural keys -- Escape and the help/diagnostic keys.
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

  // Every guard here is a corrupt-input fallback: bad JSON, non-object, unknown action id, invalid or
  // reserved key. A single bad entry never poisons the rest.
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

  // UI-scale clamp; mirrors dwf-controls-placement.js's DWFUIScale
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

  // ---- Stateful layer: the overrides cache, plus the DFKeybinds.resolve() that ----
  // ---- dwf-controls-placement.js and dwf-hotkeys.js call. Alive with no DOM, so it works headless. ----

  var overrides = {};        // {actionId: key}
  var _managed = computeManaged({});
  var _boundBy = computeBoundBy({});

  var DwfUtil = root.DwfUtil || (typeof require === "function" ? require("./dwf-util.js") : null);
  var lsGet = DwfUtil.lsGet, lsSet = DwfUtil.lsSet, lsRemove = DwfUtil.lsRemove;

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

  // ---- UI, skipped entirely with no document (e.g. under the Node harness). ----

  var doc = root.document;
  var hasDom = typeof doc !== "undefined" && !!doc && !!doc.createElement;

  // Declared LAZILY, inside the DOM guard: settings_keybinds_test loads this file's PURE core with
  // no DWFUI and no document at all.
  if (hasDom && typeof root.DWFUI !== "undefined" && typeof root.DWFUI.require === "function")
    root.DWFUI.require("settings", ["headerHtml", "nonNativeTabsHtml", "plaqueBtnHtml", "switchHtml",
      "rowHtml", "scrollHtml", "bitmapTextHtml", "esc", "TOKENS"]);

  // Human label for a key string (Space, Shift+X for a bare uppercase letter, else the key).
  function keyLabel(key) {
    if (key == null || key === "") return "(unbound)";
    if (key === " ") return "Space";
    if (key === "\u0000") return "(unbound)";
    if (key.length === 1 && key >= "A" && key <= "Z") return "Shift+" + key;
    return key;
  }

  var backdrop = null, panel = null, curTab = "keybinds", rebindingId = null;

  // Panel styling ships in the production stylesheet so the same markup works in every document that loads it.
  function ensurePanel() {
    if (panel) return;
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
    // NOT a native tab row: this screen configures the web client and DF has no counterpart to copy, so it
    // declares the opt-out rather than inventing a native tab grammar.
    var navHtml = root.DWFUI.nonNativeTabsHtml({ cls: "settings-nav", tabCls: "settings-tab", activeCls: "on", dataAttr: "tab", ariaLabel: "Settings sections", active: activeTab,
      reason: "browser-client settings screen; no native DF counterpart and no oracle capture -- no F3 grammar to adopt",
      tabs: TABS.map(function (t) { return { key: t.id, label: t.label }; }) });
    var pane =
      activeTab === "keybinds" ? renderKeybinds() :
      activeTab === "interface" ? renderInterface() :
      activeTab === "audio" ? renderAudio() :
      renderInfo();
    // `preserveKey` keeps the scroll position across the re-render that every rebind or toggle triggers.
    return root.DWFUI.headerHtml({ cls: "settings-head", titleTag: "h2", title: "Settings", titleCls: "settings-title", close: { cls: "settings-x", dataset: { dfsClose: "" }, title: "Close" } }) +
      '<div class="settings-body">' + navHtml +
      root.DWFUI.scrollHtml({ cls: "settings-pane", preserveKey: "settings:" + activeTab }, pane) +
      "</div>";
  }

  function render() {
    if (!panel) return;
    panel.innerHTML = settingsMarkup(curTab);

    panel.querySelector(".settings-x").addEventListener("click", close);
    panel.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { cancelRebind(); curTab = b.dataset.tab; render(); });
    });
    if (curTab === "keybinds") wireKeybinds();
    else if (curTab === "interface") wireInterface();
    else if (curTab === "audio") wireAudio();
  }

  // ---- Keybinds tab. A non-native surface, declared: DF has no keybind remapper. ----
  // "Reset" is a TEXT PLAQUE -- interface_map.json has no RESET / UNDO / REVERT / RESTORE / DEFAULT token.
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
      banner = '<div class="settings-banner"><b>Key conflict:</b> ' + root.DWFUI.esc(lines.join("; ")) +
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
        var bind = D.plaqueBtnHtml({
          label: listening ? "Press a key…" : keyLabel(key),
          tone: "grey", cls: "keyboard-binding-bind" + (listening ? " listening" : ""),
          dataset: { rebind: a.id }, title: "Click, then press the new key",
        });
        var reset = D.plaqueBtnHtml({
          label: "Reset", tone: "grey", cls: "keyboard-binding-reset", dataset: { reset: a.id },
          disabled: !isOverridden, title: "Reset to default (" + keyLabel(a.default) + ")",
        });
        return D.rowHtml({
          chassis: "table", cls: "keyboard-binding-row" + (isConflict ? " conflict" : ""),
          dataset: { action: a.id }, title: a.label,
          cells: [{ html: root.DWFUI.esc(a.label), cls: "keyboard-binding-label" }, { html: bind }, { html: reset }],
        });
      }).join("");
      return "<h3>" + root.DWFUI.esc(cat) + "</h3>" + rows;
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
        chassis: "table", cls: "keyboard-binding-row readonly",
        cells: [
          { html: root.DWFUI.esc(r[1]), cls: "keyboard-binding-label" },
          { html: D.plaqueBtnHtml({ label: r[0], tone: "grey", cls: "keyboard-binding-bind dim", disabled: true }) },
        ],
      });
    }).join("");
    return banner +
      '<div class="settings-note">Click a binding, then press the new key. These apply to client ' +
      'shortcuts only. Space and Shift+letter chords are allowed; camera and system keys below ' +
      'are fixed.</div>' +
      body +
      '<div class="settings-actions">' +
      D.plaqueBtnHtml({ label: "Reset all to defaults", tone: "grey", cls: "settings-btn",
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
    try { doc.removeEventListener("keydown", captureRebind, true); }
    catch (err) { DwfErr.report("settings.rebind-listener-remove", err); }
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
    try { return root.DFPanelFrame ? root.DFPanelFrame.enabled : lsGet("dwf.panelFrame.enabled") !== "0"; }
    catch (_) { return true; }
  }

  // State, persistence and live apply all live in DwfRender; this panel only presents the switch.
  function smoothMotionEnabled() {
    try { return !!(root.DwfRender && root.DwfRender.smoothMotion); } catch (_) { return false; }
  }

  // State, persistence and live apply all live in DwfTiles; this panel only presents the switch.
  function hiDpiEnabled() {
    try { return root.DwfTiles ? !!root.DwfTiles.hiDpiEnabled() : true; } catch (_) { return true; }
  }

  function renderInterface() {
    var scale = 1;
    try { if (root.DWFUIScale) scale = root.DWFUIScale.get(); }
    catch (err) { DwfErr.report("settings.ui-scale-read", err); }
    var pct = Math.round(clampScale(scale) * 100);
    var prefsHtml = "";
    var prefs = null;
    try { if (root.DFClientPrefs) prefs = root.DFClientPrefs.list(); }
    catch (err) { DwfErr.report("settings.client-prefs-list", err); }
    if (prefs && prefs.length) {
      prefsHtml = prefs.map(function (p) {
        var on = false; try { on = !!p.get(); }
        catch (err) { DwfErr.report("settings.client-pref-read", err); }
        return root.DWFUI.switchHtml({
          cls: "interface-option-row" + (on ? " on" : ""), checked: on,
          rootDataset: { pref: p.id }, label: p.label,
        });
      }).join("");
    } else {
      prefsHtml = '<div class="settings-note">Interface toggles are provided by the top-bar cog menu ' +
        'on this build.</div>';
    }
    return '<h3>UI scale</h3>' +
      '<div class="settings-note">Size of the interface panels and toolbars (the map is never rescaled). ' +
      'Also Ctrl + / − / 0. (Ctrl + mouse wheel zooms the MAP, like DF.)</div>' +
      // DECLARED NON-NATIVE CONTROL: the UI-scale slider stays a raw range input. DF has no continuous-value
      // control anywhere, so DWFUI must not grow a sliderHtml -- it would have no native grammar to render.
      '<div class="interface-option-scale"><input type="range" id="dfsScale" min="' + UI_SCALE_MIN + '" max="' + UI_SCALE_MAX +
      '" step="0.05" value="' + clampScale(scale) + '"><span class="val" id="dfsScaleVal">' + pct + '%</span>' +
      root.DWFUI.plaqueBtnHtml({ label: "Reset", tone: "grey", cls: "settings-btn",
        dataset: { dfsAct: "scale-reset" }, title: "Reset the UI scale to 100%" }) + '</div>' +
      '<h3>Panels</h3>' +
      root.DWFUI.switchHtml({ cls: "interface-option-row" + (panelFrameEnabled() ? " on" : ""),
        checked: panelFrameEnabled(), rootDataset: { dfsToggle: "panelframe" },
        label: "Movable panels (beta)" }) +
      '<div class="settings-note">Lets migrated panels be moved, resized, closed, and remembered in this browser.</div>' +
      '<div class="settings-actions">' +
      root.DWFUI.plaqueBtnHtml({ label: "Reset panel layout", tone: "grey", cls: "settings-btn",
        dataset: { dfsAct: "panelframe-reset" },
        title: "Forget every remembered panel position and size" }) + '</div>' +
      // DECLARED BROWSER-CLIENT CONTROL: this configures our client, not anything DF has.
      '<h3>Map motion</h3>' +
      root.DWFUI.switchHtml({ cls: "interface-option-row" + (smoothMotionEnabled() ? " on" : ""),
        checked: smoothMotionEnabled(), rootDataset: { dfsToggle: "smoothmotion" },
        label: "Smooth creature motion" }) +
      '<div class="settings-note">Off by default: creatures step from tile to tile, exactly the way ' +
      'Dwarf Fortress itself draws them (it never paints a creature part-way between two tiles). ' +
      'Turn this on to glide them between tiles instead, which looks calmer on a slow connection ' +
      'but is not how the real game moves. Takes effect immediately.</div>' +
      // DECLARED BROWSER-CLIENT CONTROL: the escape hatch for the DPR-correct backing store, which costs 4x
      // the fragment work a weak integrated GPU may not want to spend.
      '<h3>Map sharpness</h3>' +
      root.DWFUI.switchHtml({ cls: "interface-option-row" + (hiDpiEnabled() ? " on" : ""),
        checked: hiDpiEnabled(), rootDataset: { dfsToggle: "hidpi" },
        label: "Sharp map (match display scale)" }) +
      '<div class="settings-note">On by default: the map is drawn at your display\'s real pixel ' +
      'density, so it stays crisp when Windows (or your browser) is set above 100% scale. ' +
      'Turn it off if the map feels slow on a laptop with weak graphics -- it draws up to four ' +
      'times fewer pixels, but the map goes soft. Takes effect immediately.</div>' +
      '<h3>Preferences</h3>' + prefsHtml;
  }

  function wireInterface() {
    var slider = panel.querySelector("#dfsScale");
    var val = panel.querySelector("#dfsScaleVal");
    if (slider) slider.addEventListener("input", function () {
      var v = clampScale(parseFloat(slider.value));
      try { if (root.DWFUIScale) root.DWFUIScale.set(v); }
      catch (err) { DwfErr.report("settings.ui-scale-set", err); }
      if (val) val.textContent = Math.round(v * 100) + "%";
    });
    // DWFUI builders take `cls` and `dataset` hooks, not ids, so every builder-emitted handle below is
    // a [data-dfs-*] attribute. The raw range input above keeps its id, because nothing built it.
    var reset = panel.querySelector('[data-dfs-act="scale-reset"]');
    if (reset) reset.addEventListener("click", function () {
      try { if (root.DWFUIScale) root.DWFUIScale.reset(); }
      catch (err) { DwfErr.report("settings.ui-scale-reset", err); }
      if (slider) slider.value = "1";
      if (val) val.textContent = "100%";
    });
    var panelFrameToggle = panel.querySelector('[data-dfs-toggle="panelframe"]');
    if (panelFrameToggle) {
      // switchHtml is a <label> wrapping a checkbox, so a `click` handler on the label fires TWICE and
      // cancels its own flip. Drive the inner checkbox's `change` and treat `.checked` as the new state.
      var panelFrameInput = panelFrameToggle.querySelector('input[type="checkbox"]');
      var panelFrameTarget = panelFrameInput || panelFrameToggle;
      panelFrameTarget.addEventListener(panelFrameInput ? "change" : "click", function () {
        var on = panelFrameInput ? panelFrameInput.checked : !panelFrameEnabled();
        try {
          if (root.DFPanelFrame) root.DFPanelFrame.setEnabled(on);
          else lsSet("dwf.panelFrame.enabled", on ? "1" : "0");
        } catch (err) { DwfErr.report("settings.panel-frame-set", err); }
        var applied = panelFrameEnabled();
        panelFrameToggle.classList.toggle("on", applied);
        if (panelFrameInput) panelFrameInput.checked = applied;
      });
    }
    // Same label-fires-twice hazard as the switch above: drive the inner checkbox's `change`, then resync.
    var smoothMotionToggle = panel.querySelector('[data-dfs-toggle="smoothmotion"]');
    if (smoothMotionToggle) {
      var smoothInput = smoothMotionToggle.querySelector('input[type="checkbox"]');
      var smoothTarget = smoothInput || smoothMotionToggle;
      smoothTarget.addEventListener(smoothInput ? "change" : "click", function () {
        var on = smoothInput ? smoothInput.checked : !smoothMotionEnabled();
        try { if (root.DwfRender) root.DwfRender.setSmoothMotion(on); }
        catch (err) { DwfErr.report("settings.smooth-motion-set", err); }
        var applied = smoothMotionEnabled();
        smoothMotionToggle.classList.toggle("on", applied);
        if (smoothInput) smoothInput.checked = applied;
      });
    }
    // Same chassis, same WTHR-2 hazard as the two switches above: drive the inner checkbox's
    // `change`, then resync the row to the state DwfTiles actually applied.
    var hiDpiToggle = panel.querySelector('[data-dfs-toggle="hidpi"]');
    if (hiDpiToggle) {
      var hiDpiInput = hiDpiToggle.querySelector('input[type="checkbox"]');
      var hiDpiTarget = hiDpiInput || hiDpiToggle;
      hiDpiTarget.addEventListener(hiDpiInput ? "change" : "click", function () {
        var on = hiDpiInput ? hiDpiInput.checked : !hiDpiEnabled();
        try { if (root.DwfTiles && root.DwfTiles.setHiDpi) root.DwfTiles.setHiDpi(on); }
        catch (err) { DwfErr.report("settings.hidpi-set", err); }
        var applied = hiDpiEnabled();
        hiDpiToggle.classList.toggle("on", applied);
        if (hiDpiInput) hiDpiInput.checked = applied;
      });
    }
    var panelFrameReset = panel.querySelector('[data-dfs-act="panelframe-reset"]');
    if (panelFrameReset) panelFrameReset.addEventListener("click", function () {
      try {
        if (root.DFPanelFrame) root.DFPanelFrame.resetAll();
        else lsRemove("dwf.panelLayout.v1");
      } catch (err) { DwfErr.report("settings.panel-layout-reset", err); }
    });
    panel.querySelectorAll("[data-pref]").forEach(function (row) {
      // Same hazard: a click on the label fires twice and cancels a `!get(id)` flip, so the persisted state
      // never changes while the checkbox toggles once. Wire the checkbox's `change` and trust `.checked`.
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
        } catch (err) { DwfErr.report("settings.client-pref-set", err); }
      });
    });
  }

  // ---- Audio tab ----------------------------------------------------------------------------
  function renderAudio() {
    return '<h3>Audio &amp; music</h3>' +
      '<div class="settings-note">Audio has its own controls in the top-bar speaker popover: manual ' +
      'playlist, per-channel volume/mute, UI click sounds, and announcement stingers.</div>' +
      '<div class="settings-actions">' +
      root.DWFUI.plaqueBtnHtml({ label: "Open audio controls", tone: "green", cls: "settings-btn",
        dataset: { dfsAct: "open-audio" }, title: "Open the audio & music popover" }) +
      '</div>';
  }
  function wireAudio() {
    var b = panel.querySelector('[data-dfs-act="open-audio"]');
    if (b) b.addEventListener("click", function () {
      close();
      try { doc.getElementById("audioBtn")?.click(); } catch (err) { DwfErr.report("settings.audio-open", err); }
    });
  }

  // ---- Info tab -----------------------------------------------------------------------------
  function renderInfo() {
    var player = lsGet("dwf.player") || "(unset)";
    var renderer = lsGet("dwf.renderer") || "gl (default)";
    var autosave = null;
    try { autosave = root.DwfSessionInfo && root.DwfSessionInfo.autosave; }
    catch (err) { DwfErr.report("settings.autosave-read", err); }
    var D = root.DWFUI;
    // The three read-only key/value lines become DWFUI table rows (the same chassis the keybind list
    // uses). `.info-row` / `.k` / `.v` stay as the pinned class hooks, and #dfsAutosave is preserved.
    var infoRow = function (k, valueHtmlRaw) {
      return D.rowHtml({ chassis: "table", cls: "info-row",
        cells: [{ html: root.DWFUI.esc(k), cls: "k" }, { html: valueHtmlRaw, cls: "v" }] });
    };
    return '<h3>Autosave</h3>' +
      infoRow("Autosave interval",
        '<span id="dfsAutosave">' + root.DWFUI.esc(autosaveIntervalLabel(autosave)) + '</span>') +
      '<div class="settings-note">Reported read-only by the host from Dwarf Fortress\'s autosave setting.</div>' +
      '<h3>Session</h3>' +
      infoRow("Your name", root.DWFUI.esc(player)) +
      infoRow("Renderer", root.DWFUI.esc(renderer));
  }

  // ---- open / close -------------------------------------------------------------------------
  function open(tab) {
    if (!hasDom) return;
    ensurePanel();
    if (tab && TABS.some(function (t) { return t.id === tab; })) curTab = tab;
    render();
    // reflect any pending reject message from a prior rebind attempt
    if (rejectMsg && panel && curTab === "keybinds") {
      var pane = panel.querySelector(".settings-pane");
      if (pane) pane.insertAdjacentHTML("afterbegin", '<div class="settings-banner">' + root.DWFUI.esc(rejectMsg) + "</div>");
    }
    backdrop.classList.add("open");
  }
  function close() {
    cancelRebind();
    if (backdrop) backdrop.classList.remove("open");
    try { doc.getElementById("view")?.focus({ preventScroll: true }); }
    catch (err) { DwfErr.report("settings.map-focus", err); }
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

  // ---- Exports ----
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
    preparePreview: function () {},
    _pure: PURE,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = PURE;

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
