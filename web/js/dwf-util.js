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

// dwf-util.js -- the shared storage primitives, the numeric clamp, and DwfErr, loaded first in
// every document. HTML escaping is NOT here: DWFUI.esc owns it.
(function (root) {
  "use strict";

  function lsGet(key, onError) {
    try { return root.localStorage ? root.localStorage.getItem(key) : null; }
    catch (err) { if (typeof onError === "function") onError(err); return null; }
  }

  function lsSet(key, value, onError) {
    try {
      if (!root.localStorage) return false;
      root.localStorage.setItem(key, value);
      return true;
    } catch (err) { if (typeof onError === "function") onError(err); return false; }
  }

  function lsRemove(key) {
    try {
      if (!root.localStorage) return false;
      root.localStorage.removeItem(key);
      return true;
    } catch { return false; }
  }

  function ssGet(key, onError) {
    try {
      var storage = root.sessionStorage;
      if (!storage) {
        if (typeof onError === "function") onError();
        return null;
      }
      return storage.getItem(key);
    } catch (err) { if (typeof onError === "function") onError(err); return null; }
  }

  function ssSet(key, value, onError) {
    try {
      var storage = root.sessionStorage;
      if (!storage) return false;
      storage.setItem(key, value);
      return true;
    } catch (err) { if (typeof onError === "function") onError(err); return false; }
  }

  function ssRemove(key) {
    try {
      var storage = root.sessionStorage;
      if (!storage) return false;
      storage.removeItem(key);
      return true;
    } catch { return false; }
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // ---- DwfErr: every failure is counted, reported, or raised -- never nothing. ----
  // Here and not dwf-core.js: tiles.html runs dwf-ws/cache/tiles without ever loading dwf-core.js.
  const errCounts = Object.create(null);
  const errLastReport = Object.create(null);
  const ERR_REPORT_INTERVAL_MS = 10000;

  function errText(detail) {
    if (detail == null) return "no detail";
    if (typeof detail === "string") return detail;
    if (detail.message) return String(detail.message);
    try { return String(detail); } catch { return "unprintable detail"; }
  }

  function count(key, by) {
    const k = String(key);
    const n = (typeof by === "number" && isFinite(by)) ? Math.max(0, Math.round(by)) : 1;
    errCounts[k] = (errCounts[k] || 0) + n;
    return errCounts[k];
  }

  // First of a key always prints, then one line per key per interval; suppressed lines still count.
  // `now < last` is a backwards clock step: re-open the window, never stay mute for the step's size.
  function report(key, detail) {
    const k = String(key);
    const n = count(k);
    const now = Date.now();
    const last = errLastReport[k];
    if (last !== undefined && now >= last && (now - last) < ERR_REPORT_INTERVAL_MS) return n;
    errLastReport[k] = now;
    if (typeof console !== "undefined" && console.warn) {
      console.warn(`[dwf] ${k} (#${n}): ${errText(detail)}`);
    }
    return n;
  }

  // wrap() REPORTS AND SWALLOWS: the wrapped call never rethrows and returns undefined on failure.
  // It is for a callback that must not throw into its caller, never for a step whose failure must stop.
  function wrap(fn, key) {
    if (typeof fn !== "function") return fn;
    return function () {
      try { return fn.apply(this, arguments); }
      catch (err) { report(key, err); return undefined; }
    };
  }

  // Null-prototype, like errCounts: a key spelled `__proto__` must land in the snapshot, not vanish.
  function stats() {
    const out = Object.create(null);
    for (const k in errCounts) out[k] = errCounts[k];
    return out;
  }

  const DwfErr = { count: count, report: report, wrap: wrap, stats: stats };
  const api = {
    lsGet: lsGet, lsSet: lsSet, lsRemove: lsRemove,
    ssGet: ssGet, ssSet: ssSet, ssRemove: ssRemove,
    clamp: clamp, DwfErr: DwfErr,
  };

  try { root.DwfUtil = api; root.DwfErr = DwfErr; } catch { /* non-browser/worker context */ }
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
