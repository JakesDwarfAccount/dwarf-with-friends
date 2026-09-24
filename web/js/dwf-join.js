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

// ---- Join security and the version-mismatch gate. Self-contained; never throws out of the boot path. ----
// The passphrase is validated by POST /join, kept in the `dfcap_auth` cookie, and reused as the WS hello token.

(function () {
  "use strict";

  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("join", ["windowHtml", "plaqueBtnHtml", "statusHtml", "textInputHtml", "bitmapTextHtml",
      "bitmapProseHtml", "esc"]);

  var AUTH_COOKIE = "dfcap_auth";
  var NAME_KEY = "dwf.player";
  var DwfUtil = window.DwfUtil;
  var REMEMBER_S = 400 * 24 * 3600;   // ~max cookie lifetime (Chrome caps at 400 days)

  var credential = "";                // the shared passphrase, for the WS hello `token`
  var serverInfo = null;              // last /version payload
  var started = false;                // guard: boot the app at most once
  var gateState = "idle";             // idle | checking | awaiting-user | ready | started
  var activeJoinPromise = null;       // one unresolved join card, never a stacked duplicate
  var reauthPending = false;

  // ---- cookies -----------------------------------------------------------------------------
  function getCookie(name) {
    try {
      var parts = String(document.cookie || "").split(";");
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (p.indexOf(name + "=") === 0) return decodeURIComponent(p.slice(name.length + 1));
      }
    } catch (err) { DwfErr.report("join.get-cookie", err); }
    return "";
  }
  function setCookie(name, val) {
    try {
      document.cookie = name + "=" + encodeURIComponent(val) +
        "; path=/; SameSite=Strict; max-age=" + REMEMBER_S;
    } catch (err) { DwfErr.report("join.set-cookie", err); }
  }
  function clearCookie(name) {
    try { document.cookie = name + "=; path=/; SameSite=Strict; max-age=0"; }
    catch (err) { DwfErr.report("join.clear-cookie", err); }
  }

  // ---- version compare (PURE -- unit-tested offline in tools/harness/join_version_test.mjs) ----
  // A stamp is "0x<wirecrc>-<git>", e.g. "0x538dea9c-23092973d".
  function parseStamp(s) {
    if (!s || typeof s !== "string") return null;
    var i = s.indexOf("-");
    return i < 0 ? { crc: s, git: "" } : { crc: s.slice(0, i), git: s.slice(i + 1) };
  }
  function isDev(s) { return /(^|[-])dev($|[-])/.test(String(s || "")); }
  // A "real" stamp is "0x<crc>-<git>". Anything else -- empty, the un-replaced __DFCAPTURE_BUILD__
  // placeholder (old DLL that doesn't stamp), or a "dev" build -- is treated as unknown.
  function looksReal(s) { return /^0x[0-9a-fA-F]+-/.test(String(s || "")) && !isDev(s); }
  // Returns {level:"ok"|"soft"|"hard"|"unknown", reason?}. "unknown" (no banner) when either side
  // isn't a real stamp -- avoids false positives against an old DLL with no /version / no stamp.
  function compareBuild(clientBuild, serverBuild, clientAssets, serverAssets) {
    if (!looksReal(clientBuild) || !looksReal(serverBuild)) return { level: "unknown" };
    if (clientBuild === serverBuild) {
      if (clientAssets && serverAssets && clientAssets !== serverAssets)
        return { level: "soft", reason: "assets" };
      return { level: "ok" };
    }
    var a = parseStamp(clientBuild), b = parseStamp(serverBuild);
    if (a && b && a.crc !== b.crc) return { level: "hard", reason: "protocol" };
    return { level: "hard", reason: "stale" };
  }

  // FNV-1a (32-bit) hex -- the asset-buster fingerprint (soft tier). Deterministic + tiny so the
  // client + server compute the same value from the same sorted buster set.
  function fnv1a(str) {
    var h = 2166136261; // 0x811c9dc5 offset basis
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0; // FNV prime, 32-bit
    }
    return ("0000000" + (h >>> 0).toString(16)).slice(-8);
  }
  // Fingerprint of THIS page's asset busters (the ?v= tokens on its <script>/<link> tags). Sorted
  // + unique so it's order-independent, matching the server's computation over the same index.html.
  function clientAssetsHash() {
    try {
      var set = {};
      var nodes = document.querySelectorAll("script[src], link[href]");
      for (var i = 0; i < nodes.length; i++) {
        var url = nodes[i].getAttribute("src") || nodes[i].getAttribute("href") || "";
        var m = /[?&]v=([^&"'\s]+)/.exec(url);
        if (m) set[m[1]] = 1;
      }
      var keys = Object.keys(set).sort();
      if (!keys.length) return "";
      return fnv1a(keys.join("|"));
    } catch { return ""; }
  }

  // ---- version banner ----------------------------------------------------------------------
  var bannerDismissedSoft = false;
  function versionBannerMessage(cmp) {
    return cmp.level === "hard"
      ? (cmp.reason === "protocol"
          ? "The game was updated (protocol changed) - this tab is out of date."
          : "A new version is live; this browser tab is running stale code.")
      : "Some assets were updated - a refresh is recommended.";
  }
  function versionBannerMarkup(cmp) {
    cmp = cmp || { level: "hard", reason: "stale" };
    var soft = cmp.level === "soft";
    return '<div id="dfcapVerBanner" class="' + (soft ? "soft" : "hard") + '">' +
      window.DWFUI.statusHtml({ tag: "span", cls: "join-gate-msg", text: versionBannerMessage(cmp),
        role: "status", live: "polite" }) +
      window.DWFUI.plaqueBtnHtml({ label: "Refresh now", tone: soft ? "grey" : "red",
        cls: "join-gate-refresh", dataset: { dfcjAct: "refresh" }, title: "Reload this tab" }) +
      (soft ? window.DWFUI.plaqueBtnHtml({ label: "Dismiss", tone: "grey", cls: "join-gate-x",
        dataset: { dfcjAct: "dismiss" }, title: "Keep using this tab" }) : "") + '</div>';
  }
  function showBanner(cmp) {
    var existing = document.getElementById("dfcapVerBanner");
    if (cmp.level === "soft" && bannerDismissedSoft) return;
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.innerHTML = versionBannerMarkup(cmp);
    var el = holder.firstElementChild;
    if (!el) return;
    el.addEventListener("click", function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest("[data-dfcj-act]") : null;
      if (!t) return;
      if (t.dataset.dfcjAct === "dismiss") { bannerDismissedSoft = true; el.remove(); return; }
      try { location.reload(true); } catch { location.reload(); }
    });
    document.body.appendChild(el);
  }
  // ---- session-pinned drift gate -----------------------------------------------------------
  function compareSessionPin(pinBuild, pinAssets, serverBuild, serverAssets) {
    if (!looksReal(pinBuild) || !looksReal(serverBuild)) return { level: "unknown" };
    if (serverBuild !== pinBuild) {
      var a = parseStamp(pinBuild), b = parseStamp(serverBuild);
      if (a && b && a.crc !== b.crc) return { level: "hard", reason: "protocol" };
      return { level: "hard", reason: "stale" };
    }
    if (pinAssets && serverAssets && serverAssets !== pinAssets)
      return { level: "soft", reason: "assets" };
    return { level: "ok" };
  }
  var sessionPin = null;   // {build, assets} -- first REAL server stamp seen by this page load
  var PIN_SEVERITY = { unknown: 0, ok: 0, soft: 1, hard: 2 };

  // The baked-stamp compare stays authoritative when it is real; the session pin closes the
  // unknown-stamp gap by escalating to whichever verdict is more severe.
  function checkVersion(serverBuild, serverAssets) {
    var baked = compareBuild(window.DFCAPTURE_BUILD || "", serverBuild || "",
                             clientAssetsHash(), serverAssets || "");
    var pinned = sessionPin
      ? compareSessionPin(sessionPin.build, sessionPin.assets, serverBuild || "", serverAssets || "")
      : { level: "unknown" };
    if (!sessionPin && looksReal(serverBuild || ""))
      sessionPin = { build: serverBuild, assets: serverAssets || "" };
    var cmp = PIN_SEVERITY[pinned.level] > PIN_SEVERITY[baked.level] ? pinned : baked;
    if (cmp.level === "hard" || cmp.level === "soft") {
      try { showBanner(cmp); } catch (err) { DwfErr.report("join.version-banner", err); }
    }
    return cmp;
  }

  // Also renders the in-session rename card: the same name field and green plaque, and the submit hook
  // `data-dfcj-join` is shared, so rename adds no new hand-built control.
  function joinCardMarkup(opts) {
    opts = opts || {};
    var rename = opts.mode === "rename";
    var needPass = !rename && !!opts.needPass;
    var D = window.DWFUI;
    var passField = needPass
      ? '<label for="dfcapJoinPass">' + D.bitmapTextHtml("Join password") + '</label>' +
        D.textInputHtml({ id: "dfcapJoinPass", cls: "join-gate-input", type: "password",
          autocomplete: "current-password", placeholder: "shared password from your host" })
      : "";
    var heading = rename ? "Change your name" : "Dwarf With Friends";
    var sub = rename
      ? "Pick a new display name. Everyone in the fort will see the change."
      : (needPass
          ? "Enter your name and the password your host shared."
          : "Pick a display name to join.");
    var cardBody =
      '<h1>' + D.bitmapTextHtml(heading) + '</h1>' +
      '<p class="join-gate-sub">' + D.bitmapProseHtml(sub, 32) + '</p>' +
      '<label for="dfcapJoinName">' + D.bitmapTextHtml("Your name") + '</label>' +
      D.textInputHtml({ id: "dfcapJoinName", cls: "join-gate-input", autocomplete: "nickname", maxLength: 32,
        placeholder: "e.g. Urist", value: String(opts.prefillName || "").slice(0, 32) }) +
      passField +
      '<div id="dfcapJoinBtn">' + window.DWFUI.plaqueBtnHtml({
        label: rename ? "Save" : "Join", tone: "green", cls: "join-gate-join", dataset: { dfcjJoin: "" },
        disabled: !!opts.submitting, title: rename ? "Save your new name" : "Join this fortress",
      }) + '</div>' +
      '<div id="dfcapJoinErr">' + window.DWFUI.esc(opts.error || "") + '</div>';
    return window.DWFUI.windowHtml({ id: "dfcapJoinCard", cls: "dwf-join-card", role: "dialog",
      ariaLabel: rename ? "Change your name" : "Join Dwarf With Friends", bodyHtml: cardBody });
  }

  function showJoinScreen(opts) {
    if (activeJoinPromise) return activeJoinPromise;
    activeJoinPromise = new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.id = "dfcapJoinOverlay";
      var needPass = !!opts.needPass;
      ov.innerHTML = joinCardMarkup(opts);
      document.body.appendChild(ov);

      var nameEl = ov.querySelector("#dfcapJoinName");
      var passEl = ov.querySelector("#dfcapJoinPass");
      var btn = ov.querySelector("[data-dfcj-join]");
      var err = ov.querySelector("#dfcapJoinErr");
      nameEl.value = (opts.prefillName || "").slice(0, 32);
      if (nameEl.value && needPass && passEl) passEl.focus(); else nameEl.focus();

      // A name is REQUIRED on every join: Join stays disabled until the trimmed name is non-empty, and
      // submit() re-checks it.
      function syncEnabled() {
        if (opts.submitting) return;
        btn.disabled = !String(nameEl.value || "").trim();
      }
      syncEnabled();
      nameEl.addEventListener("input", syncEnabled);

      function fail(m) { err.textContent = m || "Something went wrong."; syncEnabled(); }

      async function submit() {
        var name = String(nameEl.value || "").trim().slice(0, 32);
        if (!name) { fail("Please enter a name."); nameEl.focus(); return; }
        btn.disabled = true;
        err.textContent = "";
        if (needPass) {
          var pass = passEl ? String(passEl.value || "") : "";
          if (!pass) { fail("Please enter the join password."); if (passEl) passEl.focus(); return; }
          // Validate before committing so the user gets immediate right/wrong feedback.
          var ok;
          try {
            var body = "password=" + encodeURIComponent(pass);
            var r = await fetch("/join", {
              method: "POST", cache: "no-store",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: body,
            });
            var j = null; try { j = await r.json(); }
            catch (err) { DwfErr.report("join.password-response", err); }
            ok = r.ok && j && j.ok === true;
          } catch { ok = false; }
          if (!ok) { fail("Wrong password. Ask your host for the shared password."); if (passEl) { passEl.focus(); passEl.select(); } return; }
          credential = pass;
          setCookie(AUTH_COOKIE, pass);
        }
        // Adopt the chosen name now, so every live request, chat marker and presence entry uses it immediately.
        try { if (typeof window.__dwfAdoptName === "function") window.__dwfAdoptName(name); }
        catch (err) { DwfErr.report("join.adopt-name", err); }
        DwfUtil.lsSet(NAME_KEY, name, function (err) { DwfErr.report("join.persist-name", err); });
        ov.remove();
        activeJoinPromise = null;
        resolve({ name: name });
      }

      btn.addEventListener("click", submit);
      ov.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return; }
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    });
    return activeJoinPromise;
  }

  // Rename is a SERVER rename, not a rejoin: the WS control message moves this connection's registry
  // entry in place. Calling only __dwfAdoptName is the local-label trap and leaves everyone else stale.
  function renameSelf(name) {
    var clean = String(name == null ? "" : name).trim().slice(0, 32);
    if (!clean) return { ok: false, name: "" };
    var sent = false;
    try {
      if (window.DwfWS && typeof window.DwfWS.send === "function")
        sent = !!window.DwfWS.send({ type: "rename", name: clean });
    } catch (err) { DwfErr.report("join.rename-send", err); }
    // Persist so a reload keeps the chosen name, then adopt locally for instant feedback. The
    // server's hello_ack re-adopts the authoritative (possibly dedup-suffixed) name on top of this.
    DwfUtil.lsSet(NAME_KEY, clean, function (err) { DwfErr.report("join.persist-name", err); });
    try { if (typeof window.__dwfAdoptName === "function") window.__dwfAdoptName(clean); }
    catch (err) { DwfErr.report("join.adopt-name", err); }
    return { ok: true, name: clean, sent: sent };
  }

  function showRenameScreen(currentName) {
    var cur = String(currentName == null ? "" : currentName);
    if (!cur) cur = DwfUtil.lsGet(NAME_KEY) || "";
    if (!cur) cur = String(window.playerName || "");
    cur = cur.slice(0, 32);
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.id = "dfcapJoinOverlay";
      ov.innerHTML = joinCardMarkup({ mode: "rename", prefillName: cur });
      document.body.appendChild(ov);

      var nameEl = ov.querySelector("#dfcapJoinName");
      var btn = ov.querySelector("[data-dfcj-join]");
      var err = ov.querySelector("#dfcapJoinErr");
      nameEl.value = cur;
      nameEl.focus();
      try { nameEl.select(); } catch (err) { DwfErr.report("join.name-select", err); }

      function syncEnabled() { btn.disabled = !String(nameEl.value || "").trim(); }
      syncEnabled();
      nameEl.addEventListener("input", syncEnabled);
      function fail(m) { err.textContent = m || "Something went wrong."; syncEnabled(); }
      function done(result) {
        try { ov.remove(); } catch (err) { DwfErr.report("join.rename-overlay-remove", err); }
        resolve(result);
      }

      function submit() {
        var name = String(nameEl.value || "").trim().slice(0, 32);
        if (!name) { fail("Please enter a name."); nameEl.focus(); return; }
        if (name === cur) { done(null); return; }   // unchanged: nothing to broadcast
        var r = renameSelf(name);
        if (!r.ok) { fail("Please enter a name."); nameEl.focus(); return; }
        done({ name: r.name });
      }

      btn.addEventListener("click", submit);
      ov.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); return; }
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    });
  }

  // ---- auth-fail recovery (WS hello rejected: stale credential after a host password change) ----
  function onAuthFail() {
    if (reauthPending) return;
    reauthPending = true;
    credential = "";
    clearCookie(AUTH_COOKIE);
    gateState = "awaiting-user";
    // Stop the app's socket churn if it's up, then re-run the gate to re-collect the password.
    try { if (window.DwfWS) window.DwfWS.close(); } catch (err) { DwfErr.report("join.socket-close", err); }
    var storedName = DwfUtil.lsGet(NAME_KEY) || "";
    Promise.resolve(showJoinScreen({ needPass: true, prefillName: storedName })).then(function () {
      // Simplest robust recovery: reload so every module re-inits with the fresh credential/cookie
      // (the new cookie is already set by showJoinScreen, so the next gate() runs seamlessly).
      try { location.reload(); } catch (err) { DwfErr.report("join.reload", err); }
    }).catch(function (err) { DwfErr.report("join.reauthenticate", err); });
  }

  // ---- the boot gate -----------------------------------------------------------------------
  function markReady() {
    if (gateState === "ready" || gateState === "started") return;
    gateState = "ready";
    // F00 pass 2: parse-time modules may now issue the protected work held by dwf-auth-gate.js.
    // The validated cookie is already installed before the join promise resolves.
    try {
      if (window.DwfAuthGate && typeof window.DwfAuthGate.release === "function")
        window.DwfAuthGate.release();
    } catch (err) { DwfErr.report("join.auth-release", err); }
    // Fires only after the join card resolves or a returning credential is adopted, so no module probes a
    // protected route while the card is still up.
    try {
      if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function")
        window.dispatchEvent(new CustomEvent("dwf:join-ready"));
    } catch (err) { DwfErr.report("join.ready-event", err); }
  }

  function bootOnce(startFn) {
    if (started) return true;
    markReady();
    try {
      if (startFn() === false) return false;
      started = true;
      gateState = "started";
      return true;
    } catch (err) {
      try { if (window.DwfBoot) window.DwfBoot.note("boot-init", (err && err.message) || err); }
      catch (noteErr) { DwfErr.report("join.boot-init-note", noteErr); }
      return false;
    }
  }

  // ---- COLD-LOAD ROUND 2: /version can DELAY the boot, but it must never PREVENT it ----------
  var VERSION_DEADLINE_MS = 2500;        // how long boot is willing to wait, once
  var VERSION_RETRY_MS = [2500, 5000];   // background retries after boot, then give up

  function withDeadline(promise, ms) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(null); }, ms);
      Promise.resolve(promise).then(function (v) { clearTimeout(timer); resolve(v); },
        function () { clearTimeout(timer); resolve(null); });
    });
  }

  // One /version attempt that is guaranteed to settle. AbortController releases the socket instead
  // of leaving a dead request occupying one of the six HTTP/1.1 connections for the whole session.
  function fetchVersionOnce(ms) {
    return new Promise(function (resolve) {
      var ctl = null, settled = false, timer = null;
      function done(v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); }
      try { ctl = new AbortController(); } catch { ctl = null; }
      timer = setTimeout(function () {
        try { if (ctl) ctl.abort(); } catch (err) { DwfErr.report("join.version-abort", err); }
        done(null);
      }, ms);
      var opts = { cache: "no-store", priority: "high" };
      if (ctl) opts.signal = ctl.signal;
      try {
        fetch("/version", opts).then(function (r) { return r && r.ok ? r.json() : null; })
          .then(done, function (err) { DwfErr.report("join.version-fetch", err); done(null); });
      } catch { done(null); }
    });
  }

  // Server features the running DLL advertises on /version. A page newer than the DLL sees an empty set,
  // so every caller must treat "unknown" as "not there" and render its control disabled.
  window.dwfServerFeatures = window.dwfServerFeatures || [];
  window.dwfHasServerFeature = function (name) {
    return Array.isArray(window.dwfServerFeatures) && window.dwfServerFeatures.indexOf(name) !== -1;
  };

  function applyServerInfo(info) {
    if (!info) return;
    serverInfo = info;
    window.dwfServerFeatures = Array.isArray(info.serverFeatures) ? info.serverFeatures.slice() : [];
    if (info.build) {
      try { checkVersion(info.build, info.assets); }
      catch (err) { DwfErr.report("join.version-check", err); }
    }
    // Adopt DF's live 16-colour palette from the handshake so every native colour index resolves to the RGB
    // DF actually paints. Absent on an old DLL, where DWFUI keeps its defaults.
    if (info.palette && typeof window.DWFUI !== "undefined") {
      try { window.DWFUI.applyPalette(info.palette); } catch (err) { DwfErr.report("join.palette-apply", err); }
    }
  }

  function retryVersionInBackground(i) {
    var idx = i || 0;
    if (idx >= VERSION_RETRY_MS.length) {
      try { if (window.DwfBoot) window.DwfBoot.note("version-unavailable",
        "/version never answered; booted without the version/palette handshake"); }
      catch (err) { DwfErr.report("join.version-unavailable-note", err); }
      return;
    }
    fetchVersionOnce(VERSION_RETRY_MS[idx]).then(function (info) {
      if (info) applyServerInfo(info);
      else retryVersionInBackground(idx + 1);
    }).catch(function (err) { DwfErr.report("join.version-retry", err); });
  }

  async function gate(startFn) {
    if (typeof startFn !== "function") return;
    gateState = "checking";
    // Adopt any credential the browser already holds (returning authed session / restart-proof).
    var existing = getCookie(AUTH_COOKIE);
    if (existing) credential = existing;

    // Prefer the <head> prefetch (in flight since t~0); fall back to our own request only if
    // index.html is an old copy that does not have it.
    var pending = window.__dwfVersionPromise;
    var info = await withDeadline(
      (pending && typeof pending.then === "function") ? pending : fetchVersionOnce(VERSION_DEADLINE_MS),
      VERSION_DEADLINE_MS);
    if (info) applyServerInfo(info);
    else {
      serverInfo = null;   // old DLL with no /version route, or a wedged link -> treat as open
      try { if (window.DwfBoot) window.DwfBoot.note("version-timeout",
        "/version did not answer within " + VERSION_DEADLINE_MS + " ms; booting anyway"); }
      catch (err) { DwfErr.report("join.version-timeout-note", err); }
      retryVersionInBackground(0);
    }
    var authRequired = !!(serverInfo && serverInfo.authRequired);

    var storedName = DwfUtil.lsGet(NAME_KEY) || "";

    // No passphrase: a returning player with a stored name boots with zero interruption; a first visitor
    // gets a one-time name screen.
    if (!authRequired) {
      if (storedName) { bootOnce(startFn); return; }
      gateState = "awaiting-user";
      Promise.resolve(showJoinScreen({ needPass: false, prefillName: "" })).then(function () { bootOnce(startFn); })
        .catch(function (err) { DwfErr.report("join.returning-screen", err); });
      return;
    }

    // The skip is a UX convenience, not the gate: the server re-checks the credential at the WS hello and
    // on every HTTP request, so a stale cookie is still caught.
    if (existing && storedName) { bootOnce(startFn); return; }

    gateState = "awaiting-user";
    Promise.resolve(showJoinScreen({ needPass: true, prefillName: storedName })).then(function () { bootOnce(startFn); })
      .catch(function (err) { DwfErr.report("join.password-screen", err); });
  }

  window.DwfAuth = {
    token: function () { return credential; },
    hasCredential: function () { return !!credential; },
    clear: function () { credential = ""; clearCookie(AUTH_COOKIE); },
    serverInfo: function () { return serverInfo; },
    onAuthFail: onAuthFail,
  };
  // Exposed for the boot script, the WS hello_ack version re-check, and offline tests.
  window.DwfJoin = {
    gate: gate,
    compareBuild: compareBuild,
    compareSessionPin: compareSessionPin,
    parseStamp: parseStamp,
    fnv1a: fnv1a,
    clientAssetsHash: clientAssetsHash,
    checkVersion: checkVersion,
    onAuthFail: onAuthFail,
    authState: function () { return gateState; },
    isPending: function () { return gateState === "checking" || gateState === "awaiting-user"; },
    canBoot: function () { return gateState === "ready" || gateState === "started"; },
    showJoinScreen: showJoinScreen,
    showRenameScreen: showRenameScreen,
    renameSelf: renameSelf,
    storyMarkup: joinCardMarkup,
    versionBannerMarkup: versionBannerMarkup,
    preparePreview: function () {},
  };
})();
