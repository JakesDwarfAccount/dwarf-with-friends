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

// B15 + B245: the RECENTER LOCATIONS panel (DF's F1-F9 camera bookmarks -- plotinfo->main.hotkeys;
// NOT the taverns/temples "Places > Locations" screen, which is a different feature).
//
// B245 rebuilt this surface to the native oracles:
//   * B243-broken-ours-tab.png   -- what we shipped: a vertical "LOCATIONS" tab covering the
//                                   elevation column. Native has NO such tab; the tab is GONE.
//   * B243-oracle-native-icon.png -- native's entry point: the RECENTER_HOTKEYS cell at the top
//                                   of the icon column beside the minimap. That button
//                                   (#recenterLocationsBtn, dwf-interface-shell.js) is the
//                                   ONLY opener now.
//   * B243-oracle-native-panel.png -- the panel grammar, row by row: a name field (black fill,
//                                   silver border, white mono; "Unnamed recenter location" when
//                                   unnamed) + quill rename tile + RECENTER_RECENTER (recenter to
//                                   the saved spot) + RECENTER_SET_LOCATION (assign the CURRENT
//                                   view to the slot -- the raws name is the evidence for what the
//                                   four-arrows tile does) + the red X delete
//                                   (RECENTER_REMOVE_OR_CLEAR). Beneath the name, in cyan:
//                                   "Recenter to elevation Z, position X,Y" -- or grey
//                                   "Not yet assigned". Then "Hotkey:" with the key in green.
//                                   Footer: one green "Add new recenter location" plaque.
//
// SERVER MODEL (unchanged; B15): GET /hotkeys lists the 16 df::ui_hotkey slots; POST
// /hotkey-action?slot=N&action=set|clear|rename mutates one. df::hotkey_type: None=-1, Zoom=0.
// Native's list semantics map onto it exactly:
//   * a row EXISTS      <=> cmd == Zoom (0). "Add new" = set with the -30000 sentinel coords
//                           (DF's own empty value) then rename to "" -- which leaves cmd=Zoom,
//                           x=-30000, name="" = native's "Unnamed recenter location /
//                           Not yet assigned" row.
//   * a row is ASSIGNED <=> `set` (cmd==Zoom && x>=0). Assigning an unnamed row lets the server
//                           default-name it "Location N" -- exactly the native capture's row 2.
//   * delete            = action=clear (cmd=None): the row leaves the list, like native.
//
// HOTKEYS: native binds F1-F8 then Shift+F1-F8; in a browser those belong to the UA, so this
// client's real jump keys are the digits 1-9 (WT12 + B203, landed and remappable via DFKeybinds).
// The row grammar keeps native's "Hotkey: <key>" line but prints the key that actually works
// here -- 1-9 for slots 1-9; slots 10-16 have no key and print no Hotkey line.
//
// B216 holds: opening the panel never moves the camera -- recentering is the explicit
// RECENTER_RECENTER tile (or a digit key), only ever on a deliberate press.
(function () {
  "use strict";

  var HK_EMPTY = -30000;            // DF's ui_hotkey empty-coordinate sentinel
  var HK_CMD_ZOOM = 0;              // df::hotkey_type::Zoom (None=-1)

  function routingPlayer() {
    try { if (typeof player !== "undefined" && player) return player; } catch (_) {}
    try {
      return new URLSearchParams(location.search).get("player") ||
        localStorage.getItem("dwf.player") || "";
    } catch (_) { return ""; }
  }

  // The player's current viewport-centre tile, for "set to current view". currentHud.camera is
  // the camera ORIGIN (top-left of the render window); add half the viewport to reach the centre.
  function currentCameraCentre() {
    try {
      if (typeof currentHud === "undefined" || !currentHud || !currentHud.camera) return null;
      var cam = currentHud.camera;
      var vp = currentHud.viewport || { w: 0, h: 0 };
      return {
        x: Math.round((cam.x || 0) + (vp.w || 0) / 2),
        y: Math.round((cam.y || 0) + (vp.h || 0) / 2),
        z: cam.z || 0,
      };
    } catch (_) { return null; }
  }

  function recenterOn(x, y, z) {
    var pos = { x: Number(x), y: Number(y), z: Number(z) };
    if (!isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) return;
    // Prefer the shared helper (flashes the tile); fall back to a plain /camera POST.
    try {
      if (typeof centerAndFlashMapPos === "function") { centerAndFlashMapPos(pos); return; }
    } catch (_) {}
    var p = encodeURIComponent(routingPlayer());
    fetch("/camera?player=" + p + "&x=" + pos.x + "&y=" + pos.y + "&z=" + pos.z,
      { method: "POST", cache: "no-store" })
      .then(function () { try { if (typeof loadHud === "function") loadHud(); } catch (_) {} })
      .catch(function () {});
  }

  // WT12: map a pressed number key (1-9) to the location it should jump to. Digits 1-9 address
  // list slots 1-9 (slots[0..8]); returns the slot object only when that slot holds a saved
  // location, else null (empty slot / out of range / no list). Pure + exported so the offline
  // fixture test can exercise the mapping without a browser. Slots 10-16 have no single-digit key
  // and are still reachable by click, exactly as before.
  function slotForDigit(slots, digit) {
    const d = Number(digit);
    if (!Number.isInteger(d) || d < 1 || d > 9) return null;
    const hk = Array.isArray(slots) ? slots[d - 1] : null;
    return (hk && hk.set) ? hk : null;
  }

  // WT12 + B203: pressing 1-9 recenters on that list entry -- "jump without clicking". B203 makes
  // it GLOBAL: it fires from the map view whether or not the Locations panel is open, matching how
  // DF's own hotkeys work (and every other global hotkey in this client). Guards, in order:
  //   * a modifier (Ctrl/Alt/Meta) is held -> leave the browser shortcut alone;
  //   * a text field is focused (chat input, the panel's own name fields, contentEditable) ->
  //     never steal the digit from typing -- the same exclusion dwf-controls-placement's
  //     switch applies to its own hotkeys;
  //   * the pressed key, RESOLVED through the shared keybind registry, is not a 1-9 jump. Reading
  //     DFKeybinds.resolve(e) (the same source controls-placement's switch reads) keeps the jump
  //     remappable: a digit a user reassigned to another action stops jumping, and a key a user
  //     bound to a location jump starts jumping. With no overrides resolve() is the identity, so
  //     the default 1-9 behavior is byte-unchanged; if settings never loaded we fall back to e.key.
  function onLocationsDigitKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    let ae = null;
    try { ae = document.activeElement; } catch (_) {}
    if (ae && (/^(input|textarea|select)$/i.test(ae.tagName || "") || ae.isContentEditable)) return;
    let key = e.key;
    try {
      if (typeof window !== "undefined" && window.DFKeybinds && typeof window.DFKeybinds.resolve === "function") {
        key = window.DFKeybinds.resolve(e);
      }
    } catch (_) {}
    if (!/^[1-9]$/.test(key)) return;
    const hk = slotForDigit(slots, Number(key));
    if (!hk) return;
    e.preventDefault();
    recenterOn(hk.x, hk.y, hk.z);
    setStatus("Jumped to location " + (hk.slot + 1) + ".");
  }

  function hotkeyAction(params) {
    var qs = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      qs.set(k, params[k] == null ? "" : String(params[k]));
    });
    qs.set("t", Date.now());
    return fetch("/hotkey-action?" + qs.toString(), { method: "POST", cache: "no-store" })
      .then(function (r) { return r.text().then(function (t) {
        var d = {}; try { d = t ? JSON.parse(t) : {}; } catch (_) {}
        if (!r.ok || d.ok === false) throw new Error(d.error || t || "request failed");
        return d;
      }); });
  }

  // ---- styling (self-contained; avoids editing the shared dwf.css) -----------------
  // Colours come from the F1 --dwfui-* custom properties (one palette, drift rule R1); the
  // fallbacks are those same measured native values.
  try {
    var style = document.createElement("style");
    style.textContent =
      "#dfHotkeysPanel{position:fixed;right:0;top:12%;z-index:61;width:390px;max-height:76vh;" +
      "display:flex;flex-direction:column;background:var(--dwfui-surface,#1c1c1c);" +
      "border:2px solid var(--dwfui-gold,#ffbf01);" +
      "font:400 12px ui-monospace,Consolas,monospace;box-shadow:-3px 0 14px rgba(0,0,0,0.5);}" +
      "#dfHotkeysPanel.hidden{display:none;}" +
      "#dfHotkeysPanel .hk-head{display:flex;align-items:center;justify-content:space-between;" +
      "gap:6px;padding:6px 10px;border-bottom:1px solid var(--dwfui-gold-bevel-dark,#a46028);" +
      "color:var(--dwfui-text-title,#fff);}" +
      "#dfHotkeysPanel .hk-head.pf-handle{cursor:move;}" +
      "#dfHotkeysPanel .hk-hint{color:var(--dwfui-text-secondary,#d7d7d7);margin-left:auto;}" +
      "#dfHotkeysPanel .hk-x{cursor:pointer;background:none;border:none;" +
      "color:var(--dwfui-text-secondary,#d7d7d7);font:700 14px ui-monospace,monospace;}" +
      "#dfHotkeysPanel .hk-x:hover{color:var(--dwfui-gold,#ffbf01);}" +
      // WT07 M4 (kept): only .hk-body re-renders; the head and the panel-frame grips stay put.
      "#dfHotkeysPanel .hk-body{overflow:auto;flex:1 1 auto;min-height:0;padding:8px 10px 0;}" +
      // The native row: name field + four tiles, the position line, the hotkey line.
      "#dfHotkeysPanel .hk-row{margin-bottom:10px;}" +
      "#dfHotkeysPanel .hk-row-main{display:flex;align-items:center;gap:2px;}" +
      // The name field: black fill, silver border, white mono (oracle rows 1-9).
      "#dfHotkeysPanel .hk-name{flex:1 1 auto;min-width:0;background:#000;" +
      "border:1px solid var(--dwfui-silver,#d8dbe4);color:var(--dwfui-text-row,#fff);" +
      "font:400 13px/1.4 ui-monospace,Consolas,monospace;padding:5px 6px;border-radius:0;}" +
      "#dfHotkeysPanel .hk-name::placeholder{color:var(--dwfui-text-row,#fff);opacity:1;}" +
      "#dfHotkeysPanel .hk-name:focus{outline:1px solid var(--dwfui-gold,#ffbf01);}" +
      // The tile cluster: bare hosts -- every cell is complete native art (SELF_FRAMED_SPRITES).
      "#dfHotkeysPanel .hk-tools{display:flex;align-items:center;gap:2px;flex:0 0 auto;}" +
      "#dfHotkeysPanel .hk-tools button{background:transparent;border:0;padding:0;cursor:pointer;" +
      "line-height:0;display:block;}" +
      "#dfHotkeysPanel .hk-pos{display:block;margin:3px 0 0 2px;color:var(--dwfui-text-active,#14ffe9);}" +
      "#dfHotkeysPanel .hk-pos.hk-unset{color:#aaaaaa;}" +
      "#dfHotkeysPanel .hk-hotline{margin:1px 0 0 2px;color:var(--dwfui-text-row,#fff);}" +
      "#dfHotkeysPanel .hk-key{color:var(--dwfui-text-good,#16ff76);}" +
      "#dfHotkeysPanel .hk-foot{flex:0 0 auto;padding:6px 10px 10px;}" +
      "#dfHotkeysPanel .hk-status{padding:2px 10px 6px;color:var(--dwfui-text-secondary,#d7d7d7);" +
      "font-size:11px;min-height:14px;}" +
      "#dfHotkeysPanel .hk-status.err{color:var(--dwfui-text-warning,#ff7f13);}";
    (document.head || document.documentElement).appendChild(style);
  } catch (_) { /* cosmetic */ }

  var panel = null, statusEl = null;
  var slots = [];
  var open = false;

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className = "hk-status" + (isErr ? " err" : "");
  }

  function refresh() {
    return fetch("/hotkeys?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        slots = (d && Array.isArray(d.hotkeys)) ? d.hotkeys : [];
        render();
      })
      .catch(function () { setStatus("Recenter locations unavailable.", true); });
  }

  // A slot the panel shows as a row: it EXISTS in native terms (cmd==Zoom -- covers both assigned
  // and added-but-unassigned). `set`/name are accepted as fallbacks so story-mode fixtures without
  // a cmd field still render.
  function isLiveSlot(hk) {
    if (!hk) return false;
    if (hk.cmd === HK_CMD_ZOOM) return true;
    return !!hk.set || !!(hk.name && String(hk.name).length);
  }

  // Our client's REAL jump key for a slot ("1".."9"), or "" when the slot has none (10-16).
  function hotkeyLabelFor(slot) {
    return (slot >= 0 && slot < 9) ? String(slot + 1) : "";
  }

  function headMarkup() {
    return window.DWFUI.headerHtml({
      cls: "hk-head", titleTag: "span", titleCls: "hk-title",
      title: "Recenter locations",
      tools: window.DWFUI.bitmapTextHtml("1-9 to jump", { cls: "hk-hint" }),
      close: { cls: "hk-x", data: "hk-close", title: "Close", glyph: "&times;" },
    });
  }

  // One native row (oracle B243-oracle-native-panel.png): [name field][quill][recenter][set][X],
  // then the cyan position line (or grey "Not yet assigned"), then "Hotkey: <key>" in green.
  function hotkeyRowsHtml(list) {
    var DWFUI = window.DWFUI;
    var S = DWFUI.TOKENS.sprites;
    return (Array.isArray(list) ? list : []).filter(isLiveSlot).map(function (hk) {
      var isSet = !!hk.set;
      var name = (hk.name || "").trim();
      var posText = isSet
        ? "Recenter to elevation " + hk.z + ", position " + hk.x + "," + hk.y
        : "Not yet assigned";
      var key = hotkeyLabelFor(hk.slot);
      return '<div class="hk-row" data-slot="' + hk.slot + '">' +
        '<div class="hk-row-main">' +
          DWFUI.textInputHtml({
            cls: "hk-name", dataset: { hkName: hk.slot }, value: name, maxLength: 128,
            placeholder: "Unnamed recenter location",
            ariaLabel: "Location " + (hk.slot + 1) + " name",
            title: "Location name (Enter saves, Esc reverts)",
          }) +
          DWFUI.actionButtonsHtml([
            { action: "rename", sprite: S.quill, dataset: { hkFocus: hk.slot },
              title: "Rename this location" },
            { action: "recenter", sprite: S.recenter, dataset: { hkGo: hk.slot },
              title: isSet ? "Recenter to this location" : "Not yet assigned" },
            { action: "assign", sprite: S.recenterSet, dataset: { hkSave: hk.slot },
              title: "Set this location to the current view" },
            { action: "delete", sprite: S.recenterClear, dataset: { hkClear: hk.slot },
              title: "Delete this recenter location" },
          ], { cls: "dwfui-actions hk-tools", ariaLabel: "Location " + (hk.slot + 1) + " actions" }) +
        "</div>" +
        DWFUI.bitmapTextHtml(posText, { cls: "hk-pos" + (isSet ? "" : " hk-unset") }) +
        (key
          ? '<div class="hk-hotline">' +
            DWFUI.bitmapTextHtml("Hotkey: ", { cls: "hk-hotlabel" }) +
            DWFUI.bitmapTextHtml(key, { cls: "hk-key" }) + "</div>"
          : "") +
        "</div>";
    }).join("");
  }

  function footMarkup(list) {
    var full = (Array.isArray(list) ? list : []).filter(isLiveSlot).length >= 16;
    return '<div class="hk-foot">' + window.DWFUI.plaqueBtnHtml({
      cls: "hk-add", tone: "green", dataset: { hkAdd: "" },
      label: "Add new recenter location",
      title: full ? "All 16 recenter locations exist" : "Add a new recenter location",
      disabled: full,
    }) + "</div>";
  }

  function hotkeysPanelMarkup(list) {
    return headMarkup() +
      '<div class="hk-body">' + hotkeyRowsHtml(list) + "</div>" +
      footMarkup(list) +
      '<div class="hk-status"></div>';
  }

  // WT07 M4: build the persistent head + body/foot shell exactly once. The head is the framework's
  // drag handle; only .hk-body and .hk-foot re-render per refresh.
  function ensureShell() {
    if (!panel || panel.querySelector(".hk-head")) return;
    panel.innerHTML = headMarkup() +
      '<div class="hk-body"></div><div class="hk-foot-host"></div><div class="hk-status"></div>';
    panel.querySelector("[data-hk-close]").addEventListener("click", function () { toggle(false); });
    try { window.DWFUI.paintBitmapText(panel); } catch (_) {}
  }

  function paint(rootNode) {
    try { window.DWFUI.paintSprites(rootNode); } catch (_) {}
    try { window.DWFUI.paintBitmapText(rootNode); } catch (_) {}
  }

  function commitRename(input) {
    var slot = Number(input.dataset.hkName);
    var hk = slots[slot];
    var next = input.value == null ? "" : String(input.value);
    var cur = (hk && hk.name) || "";
    if (next === cur) return;
    hotkeyAction({ slot: slot, action: "rename", name: next })
      .then(function () { setStatus("Renamed."); return refresh(); })
      .catch(function (e) { setStatus(e.message || "Rename failed.", true); });
  }

  function render() {
    if (!panel) return;
    ensureShell();
    var body = panel.querySelector(".hk-body");
    var footHost = panel.querySelector(".hk-foot-host");
    if (!body || !footHost) return;
    body.innerHTML = hotkeyRowsHtml(slots);
    footHost.innerHTML = footMarkup(slots);
    statusEl = panel.querySelector(".hk-status");
    paint(panel);

    body.querySelectorAll("[data-hk-go]").forEach(function (el) {
      el.addEventListener("click", function () {
        var hk = slots[Number(el.dataset.hkGo)];
        // The explicit recenter affordance (B216: nothing else moves the camera).
        if (hk && hk.set) recenterOn(hk.x, hk.y, hk.z);
      });
    });
    body.querySelectorAll("[data-hk-save]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var c = currentCameraCentre();
        if (!c) { setStatus("No camera yet.", true); return; }
        var slot = Number(btn.dataset.hkSave);
        hotkeyAction({ slot: slot, action: "set", x: c.x, y: c.y, z: c.z })
          .then(function () { setStatus("Location " + (slot + 1) + " set to the current view."); return refresh(); })
          .catch(function (e) { setStatus(e.message || "Set failed.", true); });
      });
    });
    body.querySelectorAll("[data-hk-clear]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var slot = Number(btn.dataset.hkClear);
        hotkeyAction({ slot: slot, action: "clear" })
          .then(function () { setStatus("Deleted recenter location " + (slot + 1) + "."); return refresh(); })
          .catch(function (e) { setStatus(e.message || "Delete failed.", true); });
      });
    });
    body.querySelectorAll("[data-hk-focus]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var input = body.querySelector('[data-hk-name="' + btn.dataset.hkFocus + '"]');
        if (input) { input.focus(); input.select(); }
      });
    });
    // Native rename grammar via the live field (same as the zone panel's name row): Enter/blur
    // commits, Escape reverts.
    body.querySelectorAll("[data-hk-name]").forEach(function (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        else if (e.key === "Escape") {
          e.preventDefault();
          var hk = slots[Number(input.dataset.hkName)];
          input.value = (hk && hk.name) || "";
          input.blur();
        }
        e.stopPropagation();   // never let a digit in the name field become a 1-9 jump
      });
      input.addEventListener("blur", function () { commitRename(input); });
    });
    // Add new = native's footer plaque: claim the first free slot with DF's own empty sentinel,
    // then blank the server's default name -- yielding cmd=Zoom, x=-30000, name="" = native's
    // "Unnamed recenter location / Not yet assigned" row.
    footHost.querySelectorAll("[data-hk-add]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var free = slots.find(function (hk) { return !isLiveSlot(hk); });
        if (!free) { setStatus("All 16 recenter locations exist.", true); return; }
        hotkeyAction({ slot: free.slot, action: "set", x: HK_EMPTY, y: HK_EMPTY, z: HK_EMPTY })
          .then(function () { return hotkeyAction({ slot: free.slot, action: "rename", name: "" }); })
          .then(function () { setStatus("Added recenter location " + (free.slot + 1) + "."); return refresh(); })
          .catch(function (e) { setStatus(e.message || "Add failed.", true); });
      });
    });
  }

  function toggle(next) {
    open = (typeof next === "boolean") ? next : !open;
    if (panel) panel.classList.toggle("hidden", !open);
    if (open) refresh();
    // WT07 M4: keep the framework's persistence/focus in sync with the panel's own toggle.
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("hotkeys", open); } catch (_) {}
  }

  function inject() {
    if (document.getElementById("dfHotkeysPanel")) return;
    panel = document.createElement("div");
    panel.id = "dfHotkeysPanel";
    panel.className = "hidden";
    ensureShell();
    document.body.appendChild(panel);
    // B245: the ONLY opener is the native entry point -- the RECENTER_HOTKEYS button at the top
    // of the minimap icon column (dwf-interface-shell.js). The old right-edge vertical
    // "LOCATIONS" tab is gone (native has none; it also sat over the elevation column).
    var opener = document.getElementById("recenterLocationsBtn");
    if (opener) opener.addEventListener("click", function () { toggle(); });
    // WT07 M4: movable/resizable via the shared framework; geometry persists (not open-state --
    // the panel always loads closed, like today).
    if (window.DFPanelFrame) window.DFPanelFrame.register({
      key: "hotkeys", el: function () { return panel; }, title: "Recenter locations",
      headSel: ".hk-head", closable: true, resizable: { minW: 320, minH: 200 },
      fillSel: ".hk-body",
      persistOpen: false,
      defaultPos: function (vw, vh) { return { anchor: "tr", x: 0, y: Math.round(vh * 0.12), w: 390, h: Math.round(vh * 0.6) }; },
      open: function () { toggle(true); }, close: function () { toggle(false); },
      isOpen: function () { return open; }, escClosable: true,
    });
    // WT12 + B203: number-key jump, GLOBAL (fires from the map view, panel open or not; guarded
    // inside the handler against modifiers / typing / remapped digits).
    document.addEventListener("keydown", onLocationsDigitKey);
    // B203: the jump reads `slots`, which used to be fetched only when the panel opened. Prime it
    // once on load so 1-9 work before the panel is ever opened. (Set/clear/rename go through this
    // client's own panel, which re-fetches after each edit, so the local list stays current; a
    // slot another player changes while this panel stays closed can be stale until next open.)
    refresh();
  }

  if (typeof document !== "undefined" && !window.__DWF_STORY_MODE) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", inject);
    } else {
      inject();
    }
  }

  // Node export for the offline fixture tests (harmless in the browser: `module` is undefined).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { slotForDigit, hotkeyRowsHtml, hotkeysPanelMarkup, isLiveSlot, hotkeyLabelFor };
  }

  if (typeof window !== "undefined") window.DwfHotkeys = { storyMarkup: hotkeysPanelMarkup };
})();
