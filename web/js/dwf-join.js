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

// dwf-join.js -- JOIN SECURITY + VERSION-MISMATCH GATE (ship-blockers, PROJECT-CLOSEOUT
// Phase 5). Self-contained: injects its own DOM + styles, has zero hard dependency on any other
// module loading first, and NEVER throws out of the boot path.
//
// JOIN SECURITY (friends-tier, the owner: "super simple security, just for sharing with friends"):
//   - The generic join link is just the server URL; every new session lands here first.
//   - gate(startFn) fetches GET /version to learn whether the host set a passphrase (authRequired)
//     and the server's build stamp.
//   - No passphrase set (dev default) AND a name already stored  -> boot immediately (current wide-
//     open behavior; zero interruption for returning players -> safe to deploy against the old DLL).
//   - No passphrase, first-ever visit -> a name-only screen (set your display name), then boot.
//   - Passphrase set -> a name + password JOIN SCREEN (name prefilled from localStorage). On submit
//     the password is validated (POST /join, constant-time compared server-side), stored in the
//     `dfcap_auth` cookie (auto-sent on every same-origin fetch/<img>/<script> -> no per-call-site
//     plumbing) and kept for the WS hello `token`. A returning session that already holds a valid
//     credential cookie + a name skips the screen (seamless; survives a server RESTART because the
//     passphrase is stable). If the host later CHANGES the passphrase the server rejects the stale
//     credential -> auth_fail -> onAuthFail() clears it and re-shows the screen.
//
// VERSION-MISMATCH GATE: the client bakes window.DFCAPTURE_BUILD at deploy time. On boot (and again
// on every WS hello_ack, via checkVersion) it compares that to the server's build stamp; a hard
// mismatch (different git/deploy, or different wire CRC) shows a BLOCKING "refresh -- this tab is
// stale" banner; an asset-buster-only difference shows a soft, dismissible warning. Busters cover
// caches; this covers a human sitting on an old tab after a redeploy.

(function () {
  "use strict";

  // DWFUI contract -- see dwf-escmenu.js. Presence-guarded, but NOT throw-swallowing.
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("join", ["windowHtml", "plaqueBtnHtml", "statusHtml", "esc"]);

  var AUTH_COOKIE = "dfcap_auth";
  var NAME_KEY = "dwf.player";
  var REMEMBER_S = 400 * 24 * 3600;   // ~max cookie lifetime (Chrome caps at 400 days)

  var credential = "";                // the shared passphrase, for the WS hello `token`
  var serverInfo = null;              // last /version payload
  var started = false;                // guard: boot the app at most once

  // ---- cookies -----------------------------------------------------------------------------
  function getCookie(name) {
    try {
      var parts = String(document.cookie || "").split(";");
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (p.indexOf(name + "=") === 0) return decodeURIComponent(p.slice(name.length + 1));
      }
    } catch (_) {}
    return "";
  }
  function setCookie(name, val) {
    try {
      document.cookie = name + "=" + encodeURIComponent(val) +
        "; path=/; SameSite=Strict; max-age=" + REMEMBER_S;
    } catch (_) {}
  }
  function clearCookie(name) {
    try { document.cookie = name + "=; path=/; SameSite=Strict; max-age=0"; } catch (_) {}
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
    } catch (_) { return ""; }
  }

  // ---- injected styles ---------------------------------------------------------------------
  // R1: 18 hex literals -- a private palette on the SUPERSEDED gold -- replaced by the shared
  // --dwfui-* custom properties (F1's measured native palette). No colour is stated in this module.
  // The dead `#dfcapJoinBtn` / `#dfcapVerBanner button` skins go with their controls: both are DWFUI
  // plaques now, so their look comes from .dwfui-plaque -- one plaque, one place.
  function injectStyles() {
    if (document.getElementById("dfcapJoinStyle")) return;
    var css =
      "#dfcapJoinOverlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(5,5,5,.92);backdrop-filter:blur(2px)}" +
      "#dfcapJoinCard{width:min(360px,90vw);background:var(--dwfui-surface);" +
      "border:2px solid var(--dwfui-gold);height:auto;" +
      "padding:22px 24px 20px;box-shadow:0 12px 48px rgba(0,0,0,.6);color:var(--dwfui-text-body)}" +
      "#dfcapJoinCard h1{margin:0 0 4px;font-size:20px;font-weight:600;color:var(--dwfui-gold);letter-spacing:.2px}" +
      "#dfcapJoinCard .dfcj-sub{margin:0 0 16px;font-size:12.5px;color:var(--dwfui-text-secondary)}" +
      "#dfcapJoinCard label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.8px;" +
      "color:var(--dwfui-text-secondary);margin:12px 0 5px}" +
      // DELIBERATE EXCEPTION (spec invariant): editable text fields stay real DOM inputs.
      "#dfcapJoinCard input{width:100%;box-sizing:border-box;padding:9px 11px;" +
      "border:1px solid var(--dwfui-gold-bevel-dark);background:var(--dwfui-ink);" +
      "color:var(--dwfui-text-body);font-size:14px;outline:none}" +
      "#dfcapJoinCard input:focus{border-color:var(--dwfui-gold)}" +
      "#dfcapJoinBtn{margin-top:18px;display:flex}" +
      "#dfcapJoinBtn .dwfui-plaque{flex:1 1 auto;width:100%}" +
      "#dfcapJoinErr{min-height:16px;margin-top:10px;font-size:12px;color:var(--dwfui-text-warning)}" +
      "#dfcapVerBanner{position:fixed;left:0;right:0;top:0;z-index:99999;padding:10px 16px;" +
      "font-size:13.5px;display:flex;gap:12px;align-items:center;" +
      "justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,.4)}" +
      "#dfcapVerBanner.hard{background:var(--dwfui-destructive);color:var(--dwfui-text-title)}" +
      "#dfcapVerBanner.soft{background:var(--dwfui-slab);color:var(--dwfui-gold)}";
    var st = document.createElement("style");
    st.id = "dfcapJoinStyle";
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- version banner ----------------------------------------------------------------------
  var bannerDismissedSoft = false;
  function versionBannerMessage(cmp) {
    return cmp.level === "hard"
      ? (cmp.reason === "protocol"
          ? "The game was updated (protocol changed) - this tab is out of date."
          : "A new version is live — this browser tab is running stale code.")
      : "Some assets were updated - a refresh is recommended.";
  }
  // *** ONE DEFINITION, BOTH PATHS. *** versionBannerMarkup() fed only the Studio; showBanner() --
  // the path a PLAYER actually sees after a redeploy -- hand-built the same banner with
  // createElement and two raw buttons. Same two-path trap as chat's build(). The markup is now built
  // ONCE, and showBanner() mounts THAT and wires it, so the Studio card and the live banner cannot
  // drift. Both actions are native text plaques (red = the destructive/blocking refresh, grey = the
  // dismissible note).
  function versionBannerMarkup(cmp) {
    cmp = cmp || { level: "hard", reason: "stale" };
    var soft = cmp.level === "soft";
    return '<div id="dfcapVerBanner" class="' + (soft ? "soft" : "hard") + '">' +
      window.DWFUI.statusHtml({ tag: "span", cls: "dfcj-msg", text: versionBannerMessage(cmp),
        role: "status", live: "polite" }) +
      window.DWFUI.plaqueBtnHtml({ label: "Refresh now", tone: soft ? "grey" : "red",
        cls: "dfcj-refresh", dataset: { dfcjAct: "refresh" }, title: "Reload this tab" }) +
      (soft ? window.DWFUI.plaqueBtnHtml({ label: "Dismiss", tone: "grey", cls: "dfcj-x",
        dataset: { dfcjAct: "dismiss" }, title: "Keep using this tab" }) : "") + '</div>';
  }
  function showBanner(cmp) {
    injectStyles();
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
      try { location.reload(true); } catch (_) { location.reload(); }
    });
    document.body.appendChild(el);
  }
  // ---- SESSION-PINNED DRIFT GATE (2026-07-17) ----------------------------------------------
  // compareBuild() goes "unknown" whenever THIS page has no real baked stamp -- and live-verified,
  // only GET /view substitutes __DFCAPTURE_BUILD__; a tab loaded via "/" or "/index.html" is
  // served the RAW placeholder (and without the /view no-store header), so on those tabs the
  // stale-tab banner could never fire AT ALL. That is exactly the "human sitting on an old tab
  // after a redeploy" hole the banner exists to close (deploy = DF restart; an open tab
  // reconnects and keeps running its old JS against the new server, and mid-session UI faults
  // get reported as mystery glitches instead of a visible "refresh" prompt).
  //
  // The client can still catch a redeploy WITHOUT any baked stamp: the FIRST real server stamp
  // this page load sees (boot /version, or the first WS hello_ack) pins the session; any LATER
  // stamp that differs proves the server was redeployed underneath this open tab. Pure verdict
  // below (offline-tested in join_version_test.mjs); checkVersion owns the one pin.
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

  // Compare the client's baked stamp to a server stamp; show a banner on mismatch. Called on boot
  // (from /version) and on every WS hello_ack (dwf-ws surfaces build there too). The baked-stamp
  // compare stays authoritative when it is real; the session pin closes the unknown-stamp gap
  // (unstamped "/" tabs) by escalating to whichever verdict is more severe.
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
      try { showBanner(cmp); } catch (_) {}
    }
    return cmp;
  }

  // ---- join screen -------------------------------------------------------------------------
  // Renders the join card AND (mode:"rename") the in-session "change your name" card. Both reuse
  // the SAME single name text field + green plaque, so the rename affordance adds no new hand-built
  // control (dwf-join's declared editable-input exception stays at 2). Rename mode drops the
  // password field and retitles; the submit hook (`data-dfcj-join`) is shared.
  function joinCardMarkup(opts) {
    opts = opts || {};
    var rename = opts.mode === "rename";
    var needPass = !rename && !!opts.needPass;
    var passField = needPass
      ? '<label for="dfcapJoinPass">Join password</label>' +
        '<input id="dfcapJoinPass" type="password" autocomplete="current-password" ' +
        'placeholder="shared password from your host">'
      : "";
    var heading = rename ? "Change your name" : "Dwarf With Friends";
    var sub = rename
      ? "Pick a new display name. Everyone in the fort will see the change."
      : (needPass
          ? "Enter your name and the password your host shared."
          : "Pick a display name to join.");
    var cardBody =
      '<h1>' + window.DWFUI.esc(heading) + '</h1>' +
      '<p class="dfcj-sub">' + sub + '</p>' +
      '<label for="dfcapJoinName">Your name</label>' +
      '<input id="dfcapJoinName" type="text" autocomplete="nickname" maxlength="32" ' +
      'placeholder="e.g. Urist" value="' + window.DWFUI.esc(String(opts.prefillName || "").slice(0, 32)) + '">' +
      passField +
      // The Join action is a NATIVE GREEN PLAQUE. `id="dfcapJoinBtn"` is PRESERVED on its host:
      // tools/ui-lab/stories.js drives the Studio's join screen with `target.closest("#dfcapJoinBtn")`,
      // and tools/ui-lab is forbidden to this lane -- keeping the pinned hook IS the strangler
      // contract. The module itself addresses the button by [data-dfcj-join].
      '<div id="dfcapJoinBtn">' + window.DWFUI.plaqueBtnHtml({
        label: rename ? "Save" : "Join", tone: "green", cls: "dfcj-join", dataset: { dfcjJoin: "" },
        disabled: !!opts.submitting, title: rename ? "Save your new name" : "Join this fortress",
      }) + '</div>' +
      '<div id="dfcapJoinErr">' + window.DWFUI.esc(opts.error || "") + '</div>';
    return window.DWFUI.windowHtml({ id: "dfcapJoinCard", cls: "dwf-join-card", role: "dialog",
      ariaLabel: rename ? "Change your name" : "Join Dwarf With Friends", bodyHtml: cardBody });
  }

  function showJoinScreen(opts) {
    injectStyles();
    return new Promise(function (resolve) {
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

      // A name is REQUIRED on every join (the owner: "set your nickname on join no matter what").
      // Keep Join disabled until the trimmed name is non-empty, so an empty-name join is impossible
      // from the card itself; submit() re-checks (trim) as belt-and-suspenders.
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
          var ok = false;
          try {
            var body = "password=" + encodeURIComponent(pass);
            var r = await fetch("/join", {
              method: "POST", cache: "no-store",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: body,
            });
            var j = null; try { j = await r.json(); } catch (_) {}
            ok = r.ok && j && j.ok === true;
          } catch (_) { ok = false; }
          if (!ok) { fail("Wrong password. Ask your host for the shared password."); if (passEl) { passEl.focus(); passEl.select(); } return; }
          credential = pass;
          setCookie(AUTH_COOKIE, pass);
        }
        // core.js has already selected an in-memory fallback before this gate resolves. Adopt
        // the chosen name now so every live request, chat marker, and presence entry uses it
        // immediately rather than waiting for a reload.
        try { if (typeof window.__dwfAdoptName === "function") window.__dwfAdoptName(name); } catch (_) {}
        try { localStorage.setItem(NAME_KEY, name); } catch (_) {}
        ov.remove();
        resolve({ name: name });
      }

      btn.addEventListener("click", submit);
      ov.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return; }
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    });
  }

  // ---- in-session rename (players list -> "Rename" on your own row) ------------------------
  // MECHANISM: SERVER RENAME (not a rejoin). The client sends a tiny WS control message
  // {"type":"rename","name":"..."}; the host moves this connection's registry entry to the new
  // name IN PLACE (reusing its dedup machinery -- a collision suffixes name-2/...) and replies with
  // a hello_ack carrying the authoritative name, which dwf-tiles adopts via __dwfAdoptName. Because
  // the server keys presence/cursor on the connection's live name, the ~30Hz presence AUX then
  // advertises the new name to EVERY other client and your on-map cursor label follows -- with NO
  // ~40s ghost (a web-only rejoin would leave the old name lingering in everyone's roster). The DLL
  // rename handler rides the next build; against an older DLL the message is ignored, so we also
  // adopt locally for immediate self-feedback. The RE-BROADCAST (DwfWS.send) is the whole point:
  // calling only __dwfAdoptName -- the local-label-only trap -- would leave everyone else stale.
  // Validation matches the join card exactly: trimmed, non-empty, maxlength 32.
  function renameSelf(name) {
    var clean = String(name == null ? "" : name).trim().slice(0, 32);
    if (!clean) return { ok: false, name: "" };
    var sent = false;
    try {
      if (window.DwfWS && typeof window.DwfWS.send === "function")
        sent = !!window.DwfWS.send({ type: "rename", name: clean });
    } catch (_) {}
    // Persist so a reload keeps the chosen name, then adopt locally for instant feedback. The
    // server's hello_ack re-adopts the authoritative (possibly dedup-suffixed) name on top of this.
    try { localStorage.setItem(NAME_KEY, clean); } catch (_) {}
    try { if (typeof window.__dwfAdoptName === "function") window.__dwfAdoptName(clean); } catch (_) {}
    return { ok: true, name: clean, sent: sent };
  }

  function showRenameScreen(currentName) {
    injectStyles();
    var cur = String(currentName == null ? "" : currentName);
    if (!cur) { try { cur = localStorage.getItem(NAME_KEY) || ""; } catch (_) {} }
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
      try { nameEl.select(); } catch (_) {}

      function syncEnabled() { btn.disabled = !String(nameEl.value || "").trim(); }
      syncEnabled();
      nameEl.addEventListener("input", syncEnabled);
      function fail(m) { err.textContent = m || "Something went wrong."; syncEnabled(); }
      function done(result) { try { ov.remove(); } catch (_) {} resolve(result); }

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
    credential = "";
    clearCookie(AUTH_COOKIE);
    // Stop the app's socket churn if it's up, then re-run the gate to re-collect the password.
    try { if (window.DwfWS) window.DwfWS.close(); } catch (_) {}
    var storedName = "";
    try { storedName = localStorage.getItem(NAME_KEY) || ""; } catch (_) {}
    showJoinScreen({ needPass: true, prefillName: storedName }).then(function () {
      // Simplest robust recovery: reload so every module re-inits with the fresh credential/cookie
      // (the new cookie is already set by showJoinScreen, so the next gate() runs seamlessly).
      try { location.reload(); } catch (_) {}
    });
  }

  // ---- the boot gate -----------------------------------------------------------------------
  function bootOnce(startFn) {
    if (started) return;
    started = true;
    try { startFn(); } catch (_) {}
  }

  async function gate(startFn) {
    if (typeof startFn !== "function") return;
    // Adopt any credential the browser already holds (returning authed session / restart-proof).
    var existing = getCookie(AUTH_COOKIE);
    if (existing) credential = existing;

    try {
      var r = await fetch("/version", { cache: "no-store" });
      serverInfo = r && r.ok ? await r.json() : null;
    } catch (_) {
      serverInfo = null;   // old DLL with no /version route -> treat as open, no banner
    }
    var authRequired = !!(serverInfo && serverInfo.authRequired);
    if (serverInfo && serverInfo.build) {
      try { checkVersion(serverInfo.build, serverInfo.assets); } catch (_) {}
    }
    // Text-color spec §3.2: adopt DF's live 16-color curses palette (gps->uccolor) the handshake
    // ships, so every native color index the client renders resolves to the exact RGB DF paints --
    // honoring a player-edited data/init/colors.txt. Absent (old DLL) -> DWFUI keeps its defaults.
    if (serverInfo && serverInfo.palette && typeof window.DWFUI !== "undefined") {
      try { window.DWFUI.applyPalette(serverInfo.palette); } catch (_) {}
    }

    var storedName = "";
    try { storedName = localStorage.getItem(NAME_KEY) || ""; } catch (_) {}

    // Dev default (no passphrase): keep the CURRENT wide-open behavior. Returning player with a
    // stored name -> boot with zero interruption (this is what makes deploying against the old,
    // auth-less DLL graceful). First-ever visitor -> a one-time name screen.
    if (!authRequired) {
      if (storedName) { bootOnce(startFn); return; }
      showJoinScreen({ needPass: false, prefillName: "" }).then(function () { bootOnce(startFn); });
      return;
    }

    // Passphrase set. A returning session that already holds a credential cookie + a name skips
    // the screen (seamless; survives server restart since the passphrase is stable). The server
    // still re-checks the credential at the WS hello + on every HTTP request, so a stale cookie is
    // caught (auth_fail -> onAuthFail re-prompts) -- the skip is a UX convenience, not the gate.
    if (existing && storedName) { bootOnce(startFn); return; }

    showJoinScreen({ needPass: true, prefillName: storedName }).then(function () { bootOnce(startFn); });
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
    showJoinScreen: showJoinScreen,
    showRenameScreen: showRenameScreen,
    renameSelf: renameSelf,
    storyMarkup: joinCardMarkup,
    versionBannerMarkup: versionBannerMarkup,
    preparePreview: injectStyles,
  };
})();
