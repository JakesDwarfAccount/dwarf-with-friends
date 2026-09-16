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

// dwf-hotkeys.js -- the RECENTER LOCATIONS panel (DF's F1-F9 camera bookmarks,
// plotinfo->main.hotkeys; NOT the taverns/temples "Places > Locations" screen).
(function () {
  "use strict";

  var HK_EMPTY = -30000;            // DF's ui_hotkey empty-coordinate sentinel
  var HK_CMD_ZOOM = 0;              // df::hotkey_type::Zoom (None=-1)

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
    } catch (err) { DwfErr.report("hotkeys.local-recenter", err); }
    var p = encodeURIComponent(window.dwfPlayerIdentity("hotkeys"));
    fetch("/camera?player=" + p + "&x=" + pos.x + "&y=" + pos.y + "&z=" + pos.z,
      { method: "POST", cache: "no-store" })
      .then(function () { try { if (typeof loadHud === "function") loadHud(); }
        catch (err) { DwfErr.report("hotkeys.recenter-hud", err); } })
      .catch(function (err) { DwfErr.report("hotkeys.recenter", err); });
  }

  // Digits 1-9 address list slots 1-9; null for an empty slot, out of range, or no list. Slots 10-16
  // have no single-digit key and stay click-only.
  function slotForDigit(slots, digit) {
    const d = Number(digit);
    if (!Number.isInteger(d) || d < 1 || d > 9) return null;
    const hk = Array.isArray(slots) ? slots[d - 1] : null;
    return (hk && hk.set) ? hk : null;
  }

  function onLocationsDigitKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    let ae = null;
    try { ae = document.activeElement; } catch (err) { DwfErr.report("hotkeys.active-element", err); }
    if (ae && (/^(input|textarea|select)$/i.test(ae.tagName || "") || ae.isContentEditable)) return;
    let key = e.key;
    try {
      if (typeof window !== "undefined" && window.DFKeybinds && typeof window.DFKeybinds.resolve === "function") {
        key = window.DFKeybinds.resolve(e);
      }
    } catch (err) { DwfErr.report("hotkeys.bound-action", err); }
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
        var d = {}; try { d = t ? JSON.parse(t) : {}; }
        catch (err) { DwfErr.report("hotkeys.response-json", err); }
        if (!r.ok || d.ok === false) throw new Error(d.error || t || "request failed");
        return d;
      }); });
  }

  var panel = null, statusEl = null;
  var slots = [];
  var open = false;

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className = "hotkey-status" + (isErr ? " err" : "");
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

  // A slot that EXISTS in native terms (cmd == Zoom); `set` and name are accepted so story fixtures render.
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
      cls: "hotkey-head", titleTag: "span", titleCls: "hotkey-title",
      title: "Recenter locations",
      tools: window.DWFUI.bitmapTextHtml("1-9 to jump", { cls: "hotkey-hint" }),
      close: { cls: "hotkey-x", data: "hotkey-close", title: "Close", glyph: "&times;" },
    });
  }

  // One native row: [name field][quill][recenter][set][X],
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
      var body = '<div class="hotkey-row-main">' +
          DWFUI.textInputHtml({
            cls: "hotkey-name", dataset: { hkName: hk.slot }, value: name, maxLength: 128,
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
          ], { cls: "dwfui-actions hotkey-tools", ariaLabel: "Location " + (hk.slot + 1) + " actions" }) +
        "</div>" +
        DWFUI.bitmapTextHtml(posText, { cls: "hotkey-pos" + (isSet ? "" : " hotkey-unset") }) +
        (key
          ? '<div class="hotkey-hotline">' +
            DWFUI.bitmapTextHtml("Hotkey: ", { cls: "hotkey-hotlabel" }) +
            DWFUI.bitmapTextHtml(key, { cls: "hotkey-key" }) + "</div>"
          : "");
      return DWFUI.rowHtml({
        cls: "hotkey-row", dataset: { slot: hk.slot },
        trailing: DWFUI.rawHtml(
          "A recenter row composes its editable name, native action cells, position, and hotkey lines.", body),
      });
    }).join("");
  }

  function footMarkup(list) {
    var full = (Array.isArray(list) ? list : []).filter(isLiveSlot).length >= 16;
    return '<div class="hotkey-foot">' + window.DWFUI.plaqueBtnHtml({
      cls: "hotkey-add", tone: "green", dataset: { hkAdd: "" },
      label: "Add new recenter location",
      title: full ? "All 16 recenter locations exist" : "Add a new recenter location",
      disabled: full,
    }) + "</div>";
  }

  function hotkeysPanelMarkup(list) {
    return headMarkup() +
      window.DWFUI.scrollHtml({
        cls: "hotkey-body", rows: ".hotkey-row", preserveKey: "recenter-hotkeys",
        ariaLabel: "Saved recenter locations",
      }, hotkeyRowsHtml(list)) +
      footMarkup(list) +
      '<div class="hotkey-status"></div>';
  }

  // Build the persistent head and body/foot shell exactly once: the head is the framework's drag handle.
  function ensureShell() {
    if (!panel || panel.querySelector(".hotkey-head")) return;
    panel.innerHTML = headMarkup() +
      window.DWFUI.scrollHtml({
        cls: "hotkey-body", rows: ".hotkey-row", preserveKey: "recenter-hotkeys",
        ariaLabel: "Saved recenter locations",
      }, "") +
      '<div class="hotkey-foot-host"></div><div class="hotkey-status"></div>';
    panel.querySelector("[data-hk-close]").addEventListener("click", function () { toggle(false); });
    try { window.DWFUI.paintBitmapText(panel); } catch (err) { DwfErr.report("hotkeys.bitmap-paint", err); }
  }

  function paint(rootNode) {
    try { window.DWFUI.paintSprites(rootNode); } catch (err) { DwfErr.report("hotkeys.sprite-paint", err); }
    try { window.DWFUI.paintBitmapText(rootNode); } catch (err) { DwfErr.report("hotkeys.bitmap-paint", err); }
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
    var body = panel.querySelector(".hotkey-body");
    var footHost = panel.querySelector(".hotkey-foot-host");
    if (!body || !footHost) return;
    body.innerHTML = hotkeyRowsHtml(slots);
    footHost.innerHTML = footMarkup(slots);
    statusEl = panel.querySelector(".hotkey-status");
    paint(panel);

    body.querySelectorAll("[data-hk-go]").forEach(function (el) {
      el.addEventListener("click", function () {
        var hk = slots[Number(el.dataset.hkGo)];
        // The explicit recenter affordance (nothing else moves the camera).
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
    // Claim the first free slot with DF's own empty sentinel, then blank the server's default name, which
    // yields native's "Unnamed recenter location" row.
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
    // Keep the framework's persistence and focus in sync with the panel's own toggle.
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("hotkeys", open); }
    catch (err) { DwfErr.report("hotkeys.panel-open-sync", err); }
  }

  function inject() {
    if (document.getElementById("dfHotkeysPanel")) return;
    panel = document.createElement("div");
    panel.id = "dfHotkeysPanel";
    panel.className = "hidden";
    ensureShell();
    document.body.appendChild(panel);
    var opener = document.getElementById("recenterLocationsBtn");
    if (opener) opener.addEventListener("click", function () { toggle(); });
    // Geometry persists, not open-state: the panel always loads closed.
    if (window.DFPanelFrame) window.DFPanelFrame.register({
      key: "hotkeys", el: function () { return panel; }, title: "Recenter locations",
      headSel: ".hotkey-head", closable: true, resizable: { minW: 320, minH: 200 },
      fillSel: ".hotkey-body",
      persistOpen: false,
      defaultPos: function (vw, vh) { return { anchor: "tr", x: 0, y: Math.round(vh * 0.12), w: 390, h: Math.round(vh * 0.6) }; },
      open: function () { toggle(true); }, close: function () { toggle(false); },
      isOpen: function () { return open; }, escClosable: true,
    });
    // number-key jump, GLOBAL (fires from the map view, panel open or not; guarded
    // inside the handler against modifiers / typing / remapped digits).
    document.addEventListener("keydown", onLocationsDigitKey);
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
