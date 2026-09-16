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

  // ---- Shared fort-management scaffolding: open/close/route/fetch/error/unit-link for every panel. ----

  // Shared fetch: parses JSON, throws on !ok / {"ok":false}. Mirrors squadFetchJson.
  async function fortFetchJson(url, opts) {
    const response = await fetch(url, Object.assign({ cache: "no-store" }, opts || {}));
    let data = null;
    try { data = await response.json(); } catch { globalThis.DwfErr?.count("fort-panels.response-parse"); }
    if (!response.ok || (data && data.ok === false)) {
      const msg = (data && data.error) || ("request failed (" + response.status + ")");
      throw new Error(msg);
    }
    return data || {};
  }

  // The sprite is self-framed, so artBtnHtml marks it data-dwfui-self-framed and the reset suppresses
  // the generic tile border. `.info-close` and [data-fort-close] are the close wiring's hooks -- keep both.
  function fortCloseBtnHtml() {
    return DWFUI.artBtnHtml({
      sprite: DWFUI.TOKENS.sprites.close, cls: "info-close", size: 24,
      dataset: { fortClose: "" }, title: "Close", ariaLabel: "Close",
    });
  }

  function fortWindowHeaderHtml(title) {
    return DWFUI.headerHtml({
      cls: "info-header", title, titleCls: "info-title",
      close: { cls: "info-close", dataset: { fortClose: "" }, title: "Close", ariaLabel: "Close" },
    });
  }

  function fortBindWindowClose() {
    clientPanel.querySelector("[data-fort-close]")?.addEventListener("click", closeClientPanel);
  }

  function fortLoadingShell(title) {
    clientPanel.className = "visible info-panel fort-window";
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({
      role: "dialog", ariaLabel: `${title} loading`,
      bodyHtml: `${fortWindowHeaderHtml(title)}` +
        `<div class="info-body"><div class="info-message">Loading ${escapeHtml(title)}...</div></div>`,
    });
    fortBindWindowClose();
  }

  function fortRenderWindow(opts) {
    const title = opts.title || "";
    clientPanel.className = "visible info-panel fort-window";
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({
      role: "dialog", ariaLabel: title,
      bodyHtml: `${fortWindowHeaderHtml(title)}<div class="info-body fort-body">${opts.body || ""}</div>`,
      ...(opts.footer ? { footerHtml: opts.footer } : {}),
    });
    fortBindWindowClose();
    fortBindUnitLinks(clientPanel);
    if (typeof opts.onRender === "function") opts.onRender();
  }

  // Bind every [data-unit-id] element to the shared unit sheet (deep linking).
  function fortBindUnitLinks(root) {
    root.querySelectorAll("[data-unit-id]").forEach(el => {
      const id = Number(el.dataset.unitId);
      if (!(id >= 0)) return;
      el.classList.add("unit-link");
      el.addEventListener("click", event => {
        event.stopPropagation();
        if (typeof openUnitById === "function") openUnitById(id);
      });
    });
  }

  // bitmapTextHtml escapes internally, so the raw name is passed straight in -- escaping it first would
  // DOUBLE-escape it. `.unit-link` and `data-unit-id` are fortBindUnitLinks' hooks.
  function fortUnitRef(id, name) {
    const label = name || (id >= 0 ? "Unit " + id : "—");
    const text = DWFUI.bitmapTextHtml(label);
    return (id >= 0) ? `<span class="unit-link" data-unit-id="${id}">${text}</span>` : `<span>${text}</span>`;
  }

  // CamelCase / SNAKE_CASE enum key -> human "Camel Case" for display.
  function fortPrettyKey(key) {
    if (!key) return "";
    let s = String(key).replace(/_/g, " ");
    s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function fortSetStatus(msg, isError) {
    const el = document.getElementById("fortStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("fort-status-active", !!msg);
    el.classList.toggle("fort-status-error", !!isError);
  }

  function renderInfoShellWindow(activeKey, bodyHtml, opts) {
    opts = opts || {};
    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({
      ariaLabel: `${activeKey} information`, primaryTabs: infoTabRowHtml(activeKey),
      detailTabs: opts.subTabsHtml || "",
      bodyHtml: `<div class="info-body">
          <div class="info-main">${bodyHtml}</div>
        </div>`,
      footerHtml: `${infoSearchBoxHtml()}${opts.footer || ""}`,
    });
    wireInfoTabRow(clientPanel);
    fortBindUnitLinks(clientPanel);
    if (typeof opts.onRender === "function") opts.onRender();
  }

  // Keeps the persistent tab row visible and clickable while a newly-opened tab's first fetch is in flight.
  function infoShellLoadingShell(activeKey, title) {
    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({
      primaryTabs: infoTabRowHtml(activeKey),
      bodyHtml: `<div class="info-body"><div class="info-message">Loading ${escapeHtml(title)}...</div></div>`,
    });
    wireInfoTabRow(clientPanel);
  }

  // Node export for the offline fixture tests, so they assert against the REAL markup instead of a stub.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { fortUnitRef, fortPrettyKey, fortCloseBtnHtml, fortRenderWindow, fortLoadingShell };
  }
