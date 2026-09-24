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

// ---- Holds protected fetches and image preloads at one boundary until DwfJoin validates the credential. ----
// /version, /join and the script and style chain stay available so the join card can boot.
(function (root) {
  "use strict";

  const nativeFetch = typeof root.fetch === "function" ? root.fetch.bind(root) : null;
  const imageProto = root.HTMLImageElement && root.HTMLImageElement.prototype;
  const imageSrc = imageProto && Object.getOwnPropertyDescriptor(imageProto, "src");
  const delayedImages = new Map();
  let ready = false;
  let releaseWait;
  const wait = new Promise(resolve => { releaseWait = resolve; });

  function requestUrl(input) {
    try {
      const raw = typeof input === "string" || input instanceof URL
        ? String(input)
        : input && typeof input.url === "string" ? input.url : "";
      return new URL(raw, root.location && root.location.href || "http://localhost/");
    } catch {
      return null;
    }
  }

  function shouldHold(input) {
    const url = requestUrl(input);
    if (!url || !root.location || url.origin !== root.location.origin) return false;
    return !(/^\/(?:version|join)(?:\/|$)/.test(url.pathname) ||
      /^\/(?:js|css)\//.test(url.pathname));
  }

  if (nativeFetch) {
    root.fetch = function (input, init) {
      if (!ready && shouldHold(input)) return wait.then(() => nativeFetch(input, init));
      return nativeFetch(input, init);
    };
  }

  if (imageSrc && imageSrc.configurable && typeof imageSrc.set === "function") {
    Object.defineProperty(imageProto, "src", {
      configurable: true,
      enumerable: imageSrc.enumerable,
      get: function () {
        return delayedImages.has(this)
          ? delayedImages.get(this)
          : imageSrc.get ? imageSrc.get.call(this) : "";
      },
      set: function (value) {
        if (!ready && shouldHold(value)) {
          delayedImages.set(this, String(value));
          return;
        }
        delayedImages.delete(this);
        imageSrc.set.call(this, value);
      },
    });
  }

  try {
    root.document.documentElement.classList.add("dwf-auth-pending");
    const style = root.document.createElement("style");
    style.id = "dwfAuthGateStyle";
    // Self-contained because the stylesheet under diagnosis cannot conceal protected surfaces.
    style.textContent = "@layer preboot {" +
      "html.dwf-auth-pending body>:not(#dfcapJoinOverlay):not(#dwfBootFailure):not(#dfcapVerBanner):not(script):not(svg){" +
      "display:none!important}}";
    root.document.head.appendChild(style);
  } catch { /* a failed preboot gate leaves the page visible instead of trapping it hidden */ }

  function release() {
    if (ready) return;
    ready = true;
    try { root.document.documentElement.classList.remove("dwf-auth-pending"); }
    catch (err) { if (root.DwfErr) root.DwfErr.report("auth-gate.pending-release", err); }
    try {
      const favicon = root.document.getElementById("dwfFavicon");
      const href = favicon && favicon.getAttribute("data-dwf-auth-href");
      if (href) {
        favicon.setAttribute("type", "image/png");
        favicon.setAttribute("href", href);
      }
    } catch (err) { if (root.DwfErr) root.DwfErr.report("auth-gate.image-src-restore", err); }
    releaseWait();
    if (imageSrc && typeof imageSrc.set === "function") {
      delayedImages.forEach((value, image) => {
        try { imageSrc.set.call(image, value); }
        catch (err) { if (root.DwfErr) root.DwfErr.report("auth-gate.image-restore", err); }
      });
      delayedImages.clear();
    }
  }

  root.DwfAuthGate = {
    release,
    isReady: () => ready,
    shouldHold,
  };
})(window);
