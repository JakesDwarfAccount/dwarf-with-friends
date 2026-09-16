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

// ---- Boot health: an error ring, a script-integrity check with one self-heal, and an honest banner. ----
// A bug in THIS layer must never be why the app fails to start; refusing a degraded boot is deliberate (criticalMissing).

(function (root) {
  "use strict";
  if (!root) return;

  var ERROR_CAP = 50;          // ring-buffer size; boot-time noise is bounded, not unbounded
  var HEAL_TIMEOUT_MS = 8000;  // per re-injected script before we stop waiting on it

  // index.html's inline head script created this array already; adopt it rather than replacing it, so
  // nothing recorded before this file landed is lost.
  var errors = root.__dwfBootErrors;
  if (Object.prototype.toString.call(errors) !== "[object Array]") errors = [];
  root.__dwfBootErrors = errors;

  function push(entry) {
    try {
      entry.t = Math.round((root.performance && root.performance.now && root.performance.now()) || 0);
      errors.push(entry);
      while (errors.length > ERROR_CAP) errors.shift();
    } catch (_) { /* the reporter must never be the thing that breaks boot */ }
  }

  // The one call other modules make. Deliberately tolerant of being called before or without a console.
  function note(kind, message, extra) {
    push({ kind: String(kind || "note"), message: String(message == null ? "" : message),
      detail: extra == null ? undefined : String(extra) });
    try { if (root.console && root.console.warn) root.console.warn("[dwf boot] " + kind + ": " + message); }
    catch (_) { /* the in-memory boot error remains available when console access fails */ }
  }

  // A file with an EMPTY provides list cannot be verified by its globals. Those are covered by the
  // capture-phase error listener and the SyntaxError a truncated body throws, both of which name the file.
  function manifest() {
    var m = root.__DWF_SCRIPT_MANIFEST__;
    return Object.prototype.toString.call(m) === "[object Array]" ? m : [];
  }

  // ANY provided global, not ALL: one live global already proves the body ran past its definition point.
  function evaluated(entry) {
    var names = (entry && entry.provides) || [];
    for (var i = 0; i < names.length; i++) {
      try { if (typeof root[names[i]] !== "undefined" && root[names[i]] !== null) return true; }
      catch (_) { /* a throwing optional-global probe means this candidate is unavailable */ }
    }
    return false;
  }

  // Files the browser or the parser already told us about, by src/filename. Matched on basename so
  // a cache-buster query or an absolute origin never defeats the match.
  function base(u) {
    var s = String(u || "");
    s = s.split("?")[0].split("#")[0];
    return s.slice(s.lastIndexOf("/") + 1);
  }
  // ---- what counts as a script that did not load ---------------------------------------------
  function declaredAlready(message) {
    return /has already been declared|already declared/i.test(String(message || ""));
  }
  // Returns a plain-English reason, or null when this entry is not load-shaped.
  function loadFault(entry) {
    if (!entry) return null;
    if (entry.kind === "resource") return "it never arrived";
    if (entry.kind !== "error") return null;
    var msg = String(entry.message || "");
    if (!/SyntaxError/.test(msg)) return null;
    // Except the ONE SyntaxError that proves the opposite: re-running a classic script whose top level
    // declares const/let always fails "already declared", which heal()'s own retry manufactures.
    if (declaredAlready(msg)) return null;
    return "it arrived incomplete (" + msg.replace(/^Uncaught\s+/, "").slice(0, 90) + ")";
  }

  // basename -> the reason it looks un-loaded. Load-shaped errors only (see above).
  function reportedBad() {
    var bad = {};
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i];
      var f = e && (e.file || e.source);
      if (!f) continue;
      var b = base(f);
      // Positive proof the body already ran; outranks any earlier complaint about this file.
      if (declaredAlready(e.message)) { retryOk[b] = true; delete bad[b]; continue; }
      var why = loadFault(e);
      if (why) bad[b] = why;
    }
    return bad;
  }

  // Files a re-injection has since fetched. Without this, a file that provides no global stays "missing"
  // forever and raises the failure banner on a boot that actually recovered.
  var retryOk = {};

  // A manifest entry plus the plain-English reason it is on the missing list. A copy, so the
  // generated manifest is never mutated and a second check() cannot inherit a stale reason.
  function withReason(entry, reason) {
    return { file: entry.file, url: entry.url, provides: entry.provides || [], reason: reason };
  }

  // check() -> array of manifest entries that are missing, each carrying `.reason`. Never throws.
  function check() {
    var out = [];
    try {
      var bad = reportedBad();
      var list = manifest();
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || !e.url) continue;
        var b = base(e.url);
        var names = e.provides || [];
        // retryOk clears the ERROR-based verdict only. The globals check still applies: a retry
        // whose body arrived but did not define anything has not actually recovered.
        var reported = retryOk[b] ? null : (bad[b] || null);
        // Carry WHY: a banner naming only the file sends the next bug report back to square one.
        if (reported) out.push(withReason(e, reported));
        else if (names.length && !evaluated(e)) {
          out.push(withReason(e, "it ran but defined none of: " + names.join(", ")));
        }
      }
    } catch (err) { note("integrity-check", "check() failed: " + ((err && err.message) || err)); }
    return out;
  }

  // Re-inject one script and resolve when it has either run or definitively failed. `&r=1` makes
  // the retry URL distinct from the one the browser may have cached a truncated body under.
  function reinject(entry) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(how) { if (done) return; done = true; resolve(how); }
      try {
        var el = root.document.createElement("script");
        el.src = entry.url + (entry.url.indexOf("?") >= 0 ? "&" : "?") + "r=1";
        el.async = false;
        el.onload = function () { retryOk[base(entry.url)] = true; finish("loaded"); };
        el.onerror = function () { note("script-retry-failed", entry.file); finish("error"); };
        root.setTimeout(function () { finish("timeout"); }, HEAL_TIMEOUT_MS);
        (root.document.head || root.document.documentElement).appendChild(el);
      } catch (err) { note("script-retry-failed", entry.file, (err && err.message) || err); finish("error"); }
    });
  }

  // heal() -> Promise<string[]> of files still missing after ONE retry pass. Order is preserved:
  // these are classic scripts and a re-injected dependency must still evaluate before its consumer.
  var healed = false;
  function heal() {
    var missing = check();
    if (!missing.length || healed) return Promise.resolve(missing.map(function (e) { return e.file; }));
    healed = true;
    note("script-missing", missing.map(function (e) { return e.file; }).join(", "),
      "re-injecting " + missing.length + " script(s) in load order");
    var chain = Promise.resolve();
    missing.forEach(function (e) { chain = chain.then(function () { return reinject(e); }); });
    return chain.then(function () {
      var still = check().map(function (e) { return e.file; });
      if (still.length) note("script-unrecovered", still.join(", "));
      else note("script-recovered", missing.length + " script(s) recovered without a refresh");
      return still;
    }).catch(function (err) {
      note("script-heal-failed", (err && err.message) || err);
      return check().map(function (e) { return e.file; });
    });
  }

  // A reload comes FIRST: re-injecting a dropped file restores its globals but cannot un-run the files
  // that already evaluated without them, and a consumer's top-level const/let cannot be redeclared.
  var RELOAD_KEY = "dwf.boot.autoreloaded";
  var CARRY_KEY = "dwf.boot.carry";        // also read by index.html's inline <head> script
  var MAX_RELOAD_ATTEMPTS = 5;
  function criticalMissing(list) {
    // The manifest is an ordered classic-script program, not a bag of optional modules: treat every missing
    // entry as an atomic boot failure, and never let in-place healing authorize startup.
    return (list || check()).slice();
  }
  function reloadAttempts() {
    var failed = false;
    var raw = root.DwfUtil.ssGet(RELOAD_KEY, function () { failed = true; });
    if (failed) return MAX_RELOAD_ATTEMPTS;
    var n = parseInt(raw || "0", 10);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function reloadSpent() {
    return reloadAttempts() >= MAX_RELOAD_ATTEMPTS;
  }
  function recover() {
    var missing = check();
    if (!missing.length) return Promise.resolve([]);
    var names = missing.map(function (e) { return e.file; }).join(", ");
    if (reloadSpent()) {
      note("script-unrecovered", names, "automatic reload limit reached -- refusing a degraded boot");
      return Promise.resolve(missing.map(function (e) { return e.file; }));
    }
    var attempt = reloadAttempts() + 1;
    root.DwfUtil.ssSet(RELOAD_KEY, String(attempt));
    note("script-missing", names, "reloading so the chain re-runs in order (attempt " +
      attempt + "/" + MAX_RELOAD_ATTEMPTS + ")");
    // Carry the fault across the navigation, or the reload wipes the ring buffer and a repaired boot looks
    // exactly like a clean one.
    root.DwfUtil.ssSet(CARRY_KEY, JSON.stringify({
      kind: "script-reload", file: "", message: "auto-reloaded after: " + names,
    }));
    return new Promise(function (resolve) {
      // If reload() is unavailable or a no-op, fail honestly rather than starting a page whose
      // classic-script consumers already ran against an incomplete dependency chain.
      root.setTimeout(function () {
        resolve(missing.map(function (e) { return e.file; }));
      }, 3000);
      try { root.location.reload(); } catch (err) { note("reload", "automatic reload failed", err); }
    });
  }

  // Called only after startDwf() has completed its synchronous initialization. A successful,
  // complete boot earns a fresh bounded reload allowance for a later navigation in this tab.
  function markHealthy() {
    if (root.__dwfStarted !== true || check().length) return false;
    return root.DwfUtil.ssRemove(RELOAD_KEY);
  }

  function verify() {
    try {
      if (root.__dwfStarted !== true) return [];
      var missing = check();
      if (!missing.length) return [];
      var names = missing.map(function (e) { return e.file; });
      note("boot-incomplete", names.join(", "),
        "the app started but the script chain is still incomplete");
      showFailure(missing[0].file, missing[0].reason || "");
      return names;
    } catch (err) {
      note("integrity-check", "verify() failed: " + ((err && err.message) || err));
      return [];
    }
  }

  // ---- 3. the honest dead end ----------------------------------------------------------------
  // Plain DOM + inline styles on purpose: the production stylesheet may itself be the thing that did not arrive.
  var bannerShown = false;
  // ROUND 3: look the reason up if the caller did not supply one, so index.html's existing
  // one-argument call sites get the richer banner for free.
  function reasonFor(what) {
    try {
      var name = base(what);
      var list = check();
      for (var i = 0; i < list.length; i++) {
        if (list[i].file === what || base(list[i].url) === name) return list[i].reason || "";
      }
    } catch (err) { note("boot-health.reason-lookup", "failure reason unavailable", err); }
    return "";
  }
  function showFailure(what, why) {
    if (bannerShown) return;
    bannerShown = true;
    if (!why && what) why = reasonFor(what);
    try {
      var box = root.document.createElement("div");
      box.id = "dwfBootFailure";
      box.setAttribute("role", "alert");
      box.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:12px 16px;" +
        "background:#2b1a12;color:#e8d9b0;border-bottom:2px solid #a55;font:14px/1.5 monospace;text-align:center";
      var msg = root.document.createElement("span");
      msg.textContent = "The page didn't load completely" +
        (what ? " (" + what + (why ? ": " + why : "") + ")" : "") + " — reload to fix it. ";
      var btn = root.document.createElement("button");
      btn.textContent = "Reload";
      btn.style.cssText = "margin-left:8px;padding:2px 12px;font:inherit;cursor:pointer";
      btn.onclick = function () {
        try { root.location.reload(); } catch (err) { note("reload", "manual reload failed", err); }
      };
      box.appendChild(msg); box.appendChild(btn);
      (root.document.body || root.document.documentElement).appendChild(box);
    } catch (_) { /* if even this fails there is nothing left to do but stay quiet */ }
  }

  // ---- status, for the harness and for a human in the console --------------------------------
  function status() {
    var missing = check();
    return {
      started: root.__dwfStarted === true,
      scripts: manifest().length,
      missing: missing.map(function (e) { return e.file; }),
      // ROUND 3: the same list with its reasons, so a harness (and a console-reading human) can
      // assert on WHY, not just on how many.
      missingWhy: missing.map(function (e) { return e.file + ": " + (e.reason || "unknown"); }),
      healAttempted: healed,
      reloadSpent: reloadSpent(),
      reloadAttempts: reloadAttempts(),
      reloadLimit: MAX_RELOAD_ATTEMPTS,
      errors: errors.slice(),
    };
  }

  root.DwfBoot = {
    note: note,
    check: check,
    heal: heal,
    recover: recover,
    criticalMissing: criticalMissing,
    markHealthy: markHealthy,
    verify: verify,
    showFailure: showFailure,
    status: status,
    errors: function () { return errors.slice(); },
  };
}(typeof window !== "undefined" ? window : null));
