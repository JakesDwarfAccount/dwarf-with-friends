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

  // WS3 fort-management shared scaffolding. Every management panel (nobles,
  // justice, petitions, burrows, kitchen, world map) uses these helpers so
  // open/close/route/fetch/error/unit-link behaviour is identical across the
  // whole menu system. Classic script -> these land in the global scope next to
  // player, clientPanel, escapeHtml, openUnitById, setActiveToolbar.

  // Shared fetch: parses JSON, throws on !ok / {"ok":false}. Mirrors squadFetchJson.
  async function fortFetchJson(url, opts) {
    const response = await fetch(url, Object.assign({ cache: "no-store" }, opts || {}));
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || (data && data.ok === false)) {
      const msg = (data && data.error) || ("request failed (" + response.status + ")");
      throw new Error(msg);
    }
    return data || {};
  }

  // W5: the window's close tile. Was a raw `.info-close` button holding a `&times;` entity -- a
  // Unicode multiplication sign standing in for art DF already ships. `.info-close` carries NO CSS
  // rule at all (checked: zero hits in web/css/dwf.css), so the glyph was rendering as a bare
  // browser-default button. The sprite is self-framed, so artBtnHtml marks it
  // data-dwfui-self-framed and the foundation's reset suppresses the generic tile border -- one
  // native frame, not two. `.info-close` + [data-fort-close] both survive verbatim: they are the
  // hooks this file's own close wiring (and the four surfaces below) select on.
  function fortCloseBtnHtml() {
    return DWFUI.artBtnHtml({
      sprite: DWFUI.TOKENS.sprites.close, cls: "info-close", size: 24,
      dataset: { fortClose: "" }, title: "Close", ariaLabel: "Close",
    });
  }

  // Standard loading shell into clientPanel while a panel's first fetch runs.
  function fortLoadingShell(title) {
    clientPanel.className = "visible info-panel fort-window";
    panelContent(clientPanel).innerHTML =
      `<div class="info-window"><div class="info-header"><div class="info-title">${escapeHtml(title)}</div>` +
      `${fortCloseBtnHtml()}</div>` +
      `<div class="info-body"><div class="info-message">Loading ${escapeHtml(title)}...</div></div></div>`;
    clientPanel.querySelector("[data-fort-close]")?.addEventListener("click", closeClientPanel);
  }

  // Render a full panel: standard .info-window shell with header + body.
  //
  // W5 -- THE `tabs:`/`onTab:` TAB STRIP IS DELETED AS DEAD MARKUP. Proof (the three-step test), run
  // before removing it: (1) `grep -rn "fortRenderWindow(" web/js/` -> SIX call sites (burrows x2,
  // kitchen x2, obligations x1, fort-admin/petitions x1) and NOT ONE of them passes `tabs:` or
  // `onTab:`; (2) `grep -rni "fort-tab" src/` -> ZERO; (3) `data-fort-tab` appears nowhere outside
  // the dead builder itself. It is unreachable in every caller, so nothing dispatches through it and
  // no capability is lost. (fort-admin.js:64-66 had already declared it vestigial: the strip only
  // ever existed to hop to nobles/justice, which moved into the shared info-window tab row in WD-16.)
  // Its `.fort-tabs`/`.fort-tab` CSS is left in place -- CSS is another wave's owner.
  function fortRenderWindow(opts) {
    const title = opts.title || "";
    clientPanel.className = "visible info-panel fort-window";
    panelContent(clientPanel).innerHTML =
      `<div class="info-window">
        <div class="info-header">
          <div class="info-title">${escapeHtml(title)}</div>
          ${fortCloseBtnHtml()}
        </div>
        <div class="info-body fort-body">${opts.body || ""}</div>
        ${opts.footer ? `<div class="info-footer">${opts.footer}</div>` : ""}
      </div>`;
    clientPanel.querySelector("[data-fort-close]")?.addEventListener("click", closeClientPanel);
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

  // A unit reference span with a deep link (empty/invalid -> plain text).
  // W5: this emitted a RAW <span> of DOM text -- a bitmap-text bypass on EVERY unit name in the
  // Nobles and Justice stories (holders, mandate issuers, convicts, injured parties, guard members)
  // and, through the shared helper, in Burrows and Obligations too. The name now renders through
  // DWFUI.bitmapTextHtml (DF's own atlas) while `.unit-link` + `data-unit-id` survive verbatim --
  // fortBindUnitLinks still selects [data-unit-id] and still opens the unit sheet.
  // NOTE: bitmapTextHtml escapes internally (`esc(text)` on both the data attribute and the visual
  // fallback), so the raw name is passed straight in -- escaping it first would DOUBLE-escape it.
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

  // Transient status/error line shown at the top of a fort panel body.
  function fortSetStatus(msg, isError) {
    const el = document.getElementById("fortStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
    el.classList.toggle("fort-status-error", !!isError);
  }

  // WD-16: mount a body inside the ONE shared 8-tab info-window shell (dwf-build-info-
  // panels.js's infoTabRowHtml/wireInfoTabRow/infoSearchBoxHtml -- loads before this file, see
  // index.html script order). Used by the two fort-admin destinations that are real DF info
  // tabs (Nobles, Justice); Petitions/Squads/Kitchen/World map are NOT among the 8 and keep
  // fortRenderWindow's own standalone chrome below, unchanged.
  // WD-21: opts.subTabsHtml renders a second DF-styled tab row directly under the main row
  // (Justice's Open/Closed/Cold/Fortress guard/Convicts/Counterintelligence strip) -- same
  // sibling position as the generic panel's detailTabs row (dwf-build-info-panels.js),
  // just supplied pre-rendered since fort-admin.js owns its own mode state/wiring.
  // W5: the inline `style="grid-template-columns:1fr;"` is GONE, with no visual diff. It was a
  // verbatim duplicate of the stylesheet's own default -- `.info-body { display:grid;
  // grid-template-columns:1fr; }` (web/css/dwf.css:3123-3128); the two-column form is the
  // opt-in `.info-body.with-side`, which this shell never sets. So the rule already said exactly
  // what the inline copy said, and dropping the duplicate is a no-op on screen and removes an
  // inline-layout bypass. (Only Nobles + Justice reach this shell -- verified: fort-admin.js is the
  // sole caller -- so this change has no blast radius outside my two stories.)
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

  // Loading placeholder for the shell above -- keeps the persistent tab row visible (and
  // clickable) while the first fetch for a newly-opened tab is in flight, instead of flashing a
  // bare "Loading..." window with no chrome.
  function infoShellLoadingShell(activeKey, title) {
    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = DWFUI.windowHtml({
      primaryTabs: infoTabRowHtml(activeKey),
      bodyHtml: `<div class="info-body"><div class="info-message">Loading ${escapeHtml(title)}...</div></div>`,
    });
    wireInfoTabRow(clientPanel);
  }

  // Node export for the offline CIM fixture tests, so they can assert against the REAL fortUnitRef /
  // fortCloseBtnHtml markup instead of a re-implemented stub (a stub would let this file drift while
  // the tests stayed green -- the exact failure mode the programme is trying to kill). Harmless in
  // the browser: these are classic scripts, so `module` is undefined and the guard is a no-op. Same
  // pattern dwf-fort-admin.js already uses. No exported name or signature changes.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { fortUnitRef, fortPrettyKey, fortCloseBtnHtml, fortRenderWindow, fortLoadingShell };
  }
