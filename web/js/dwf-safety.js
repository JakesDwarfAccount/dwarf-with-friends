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
// ---- Safety foundations: DwfConfirmGate, a two-step latch, and DwfPaintModes, a rect/free flag ----
// ---- per subsystem. The latch is in-UI, never confirm(): a native fortress shows no OS dialog. ----
(function (root) {
  "use strict";

  // ---- 1. the confirm gate ---------------------------------------------------------------------
  var DEFAULT_TTL_MS = 6000;
  var pendingKey = null;
  var pendingAt = 0;
  var pendingTtl = DEFAULT_TTL_MS;
  var clock = function () { return Date.now(); };

  function expired(now) {
    return pendingKey !== null && (now - pendingAt) >= pendingTtl;
  }

  // A stable key for one destructive target. Two different burrows are two different keys, so
  // arming one and clicking the other disarms rather than deleting the wrong thing.
  function key(action, target) {
    return String(action) + ":" + String(target);
  }

  // Anything that renders an "armed" affordance registers here, so a latch that lapses takes its
  // "press again" styling with it. Listeners must never throw at the gate.
  var changeListeners = [];
  var expireTimer = null;

  function onChange(fn) {
    if (typeof fn === "function" && changeListeners.indexOf(fn) < 0) changeListeners.push(fn);
    return function () {
      var i = changeListeners.indexOf(fn);
      if (i >= 0) changeListeners.splice(i, 1);
    };
  }

  function notifyChanged() {
    for (var i = 0; i < changeListeners.length; i++) {
      try { changeListeners[i](); } catch (err) { DwfErr.report("safety.change-listener", err); }
    }
  }

  function clearExpireTimer() {
    if (expireTimer !== null && typeof clearTimeout === "function") {
      try { clearTimeout(expireTimer); } catch (err) { DwfErr.report("safety.expire-timer-clear", err); }
    }
    expireTimer = null;
  }

  function arm(k, options) {
    if (!k) return false;
    var ttl = options && Number(options.ttlMs);
    clearExpireTimer();
    pendingKey = String(k);
    pendingAt = clock();
    pendingTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS;
    // The TTL was checked lazily in isArmed(), which means nothing repaints when the window
    // simply lapses. Wake the renderers ourselves. (No timer facility -> lazy behaviour, as before.)
    if (typeof setTimeout === "function") {
      expireTimer = setTimeout(function () {
        expireTimer = null;
        if (disarm()) notifyChanged();
      }, pendingTtl);
    }
    return true;
  }

  function isArmed(k) {
    var now = clock();
    if (expired(now)) { disarm(); return false; }
    if (pendingKey === null) return false;
    return k === undefined ? true : pendingKey === String(k);
  }

  function armedKey() { return isArmed() ? pendingKey : null; }

  function disarm() {
    var had = pendingKey !== null;
    clearExpireTimer();
    pendingKey = null;
    pendingAt = 0;
    pendingTtl = DEFAULT_TTL_MS;
    return had;
  }

  // The call site's whole decision: "armed" (first press), "commit" (second press on the same target),
  // or "retarget" (a press on a different target -- arm the new one and act on neither).
  function press(k, options) {
    if (!k) return "armed";
    var same = isArmed(k);
    if (same) { disarm(); return "commit"; }
    var hadOther = isArmed();
    arm(k, options);
    return hadOther ? "retarget" : "armed";
  }

  // Each subsystem is independent, and no "current" subsystem is stored here on purpose: a remembered
  // "current" is how the single shared flag went wrong in the first place.
  var SUBSYSTEMS = ["designation", "stockpile", "zone", "burrow"];
  var modes = {};
  function resetModes() {
    modes = {};
    for (var i = 0; i < SUBSYSTEMS.length; i++) modes[SUBSYSTEMS[i]] = "rect"; // native's default
  }
  resetModes();

  function known(subsystem) {
    return SUBSYSTEMS.indexOf(String(subsystem)) >= 0;
  }

  function getMode(subsystem) {
    return known(subsystem) ? modes[String(subsystem)] : "rect";
  }

  function setMode(subsystem, mode) {
    if (!known(subsystem)) return false;
    modes[String(subsystem)] = mode === "free" ? "free" : "rect";
    return true;
  }

  function allModes() {
    var out = {};
    for (var i = 0; i < SUBSYSTEMS.length; i++) out[SUBSYSTEMS[i]] = modes[SUBSYSTEMS[i]];
    return out;
  }

  root.DwfConfirmGate = {
    key: key,
    arm: arm,
    isArmed: isArmed,
    armedKey: armedKey,
    disarm: disarm,
    press: press,
    onChange: onChange,
    notifyChanged: notifyChanged,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    _setClock: function (fn) { clock = typeof fn === "function" ? fn : function () { return Date.now(); }; },
  };

  root.DwfPaintModes = {
    SUBSYSTEMS: SUBSYSTEMS.slice(),
    get: getMode,
    set: setMode,
    all: allModes,
    reset: resetModes,
  };
})(typeof window !== "undefined" ? window : globalThis);
