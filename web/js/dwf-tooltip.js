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

// The DF-styled hover tooltip and the first-time help-popup system.

(function () {
  DWFUI.require("tooltip", ["checkHtml", "modalHtml", "plaqueBtnHtml", "rawHtml", "esc"]);
  // ---- Tooltip component ------------------------------------------------------------------
  const TT_DELAY_MS = 350;
  let ttEl = null;
  let ttTimer = null;
  let ttTarget = null;

  function ensureTooltipEl() {
    if (ttEl) return ttEl;
    ttEl = document.getElementById("dfTooltip");
    if (!ttEl) {
      ttEl = document.createElement("div");
      ttEl.id = "dfTooltip";
      document.body.appendChild(ttEl);
    }
    return ttEl;
  }

  function titleTextFor(el) {
    return el.getAttribute("data-df-title") || el.getAttribute("title") || "";
  }

  // Moving `title` onto `data-df-title` is what suppresses the browser's own bubble: leave the
  // live attribute in place and every hover shows two tooltips.
  function claimTitle(el) {
    const t = el.getAttribute("title");
    if (t !== null) {
      el.setAttribute("data-df-title", t);
      el.removeAttribute("title");
    }
  }

  function renderTooltipHtml(text) {
    const lines = String(text || "").split("\n");
    return lines.map(line => {
      const isHotkey = /^\s*Hotkey:/i.test(line);
      const cls = isHotkey ? "df-tt-hotkey" : "df-tt-line";
      return `<div class="${cls}">${DWFUI.esc(line)}</div>`;
    }).join("");
  }

  // Anchor providers: the surface that owns a control supplies its hover rect, first non-null
  // wins; with no answer the element's own rect is used.
  const anchorProviders = [];
  function provideAnchor(fn) { if (typeof fn === "function") anchorProviders.push(fn); }
  function anchorRectFor(el) {
    for (const fn of anchorProviders) {
      try {
        const r = fn(el);
        if (r && Number.isFinite(r.top) && Number.isFinite(r.left)) return r;
      } catch { /* the element's own rectangle below remains the anchor */ }
    }
    return el.getBoundingClientRect();
  }

  function positionTooltip(el) {
    const box = ensureTooltipEl();
    const r = anchorRectFor(el);
    box.classList.remove("is-visible");
    box.classList.add("is-measuring");
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    let left = r.left;
    let top = r.top - bh - 6;
    if (top < 4) top = r.bottom + 6;
    if (left + bw > innerWidth - 4) left = innerWidth - bw - 4;
    if (left < 4) left = 4;
    box.style.setProperty("--df-tooltip-left", `${Math.round(left)}px`);
    box.style.setProperty("--df-tooltip-top", `${Math.round(top)}px`);
    box.classList.remove("is-measuring");
    box.classList.add("is-visible");
  }

  function showTooltipFor(el) {
    const text = titleTextFor(el);
    if (!text) return;
    const box = ensureTooltipEl();
    box.innerHTML = renderTooltipHtml(text);
    positionTooltip(el);
  }

  function hideTooltip() {
    if (ttTimer) { clearTimeout(ttTimer); ttTimer = null; }
    ttTarget = null;
    if (ttEl) ttEl.classList.remove("is-measuring", "is-visible");
  }

  function targetIsConnected(el) {
    return !!el && el.isConnected !== false;
  }

  function findTitledAncestor(el) {
    return el && el.closest ? el.closest("[title], [data-df-title]") : null;
  }

  if (!window.__DWF_STORY_MODE) {
  document.addEventListener("mouseover", event => {
    const el = findTitledAncestor(event.target);
    if (!el) return;
    claimTitle(el);
    if (el === ttTarget) return;
    hideTooltip();
    ttTarget = el;
    ttTimer = setTimeout(() => {
      if (ttTarget === el && targetIsConnected(el)) showTooltipFor(el);
      else if (ttTarget === el) hideTooltip();
    }, TT_DELAY_MS);
  }, true);

  document.addEventListener("mouseout", event => {
    const el = findTitledAncestor(event.target);
    if (!el || el !== ttTarget) return;
    // Only hide once the pointer has actually left this element (not just moved to a child).
    const to = event.relatedTarget;
    if (to && el.contains(to)) return;
    hideTooltip();
  }, true);

  document.addEventListener("mousedown", hideTooltip, true);
  window.addEventListener("blur", hideTooltip);
  const tooltipAnchorObserver = new MutationObserver(() => {
    if (ttTarget && !targetIsConnected(ttTarget)) hideTooltip();
  });
  tooltipAnchorObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.DFTooltip = { hide: hideTooltip, storyMarkup: renderTooltipHtml, provideAnchor };

  // First-time help popups. `{{word}}` marks a keyword DF renders as a coloured link; the mirror has
  // no per-word native indices, so highlightBody inherits rather than collapsing them to one hue.
  const HELP_CONTEXTS = {
    zones: {
      title: "Zones",
      body: [
        "{{Zones}} are areas you designate where your citizens will work, socialize, rest, or perform specific duties. There are several kinds of {{Zones}}, which you can see in the panel on the left.",
        "{{Zones}} are placed much like {{Stockpiles}}. Unlike {{Stockpiles}}, multiple {{Zones}} can overlap.",
        "Certain {{Zones}} like {{Bedrooms}} can be placed several at a time. Just make sure you have the correct {{Furniture}} placed in the rooms with {{Doors}} or vertical entries separating each room before you begin.",
      ],
    },
    burrows: {
      title: "Burrows",
      body: [
        "{{Burrows}} are work and living areas where citizens can be assigned. Workers will try to limit their tasks to the confines of the {{Burrow}}, but they will sometimes form paths which pass through other areas.",
        "{{Burrows}} can be suspended and unsuspended freely. When a {{Burrow}} is suspended, assigned citizens will ignore it.",
        "It can be useful to assign all of your civilians to a safe emergency {{Burrow}} which you activate in case of intruders.",
      ],
    },
    hauling: {
      title: "Minecart routes",
      body: [
        "{{Minecarts}} and {{Tracks}} are a convenient way to move a lot of objects around the fortress quickly, though they take a little effort to prepare. One {{Minecart}} can be assigned to each route, and workers will move the vehicle from {{Track Stop}} to {{Track Stop}} according to conditions you specify.",
        "Each {{Track Stop}} must be linked to a {{Stockpile}} for {{Items}} to be put on or removed from the {{Minecart}}.",
        "Only one condition needs to be satisfied for the {{Minecart}} to move to the next {{Track Stop}}.",
        "{{Minecarts}} that move too quickly around corners will spill their contents. When a route has a steep descent, consider using powered {{Rollers}}, extra curves, track \"stops\" between {{Stops}} with various friction settings, or a worker to guide the vehicle.",
      ],
    },
    justice: {
      title: "Justice",
      body: [
        "If you have a law enforcement administrator like a {{Sheriff}} or {{Captain of the Guard}}, witnesses of crimes will make reports, which find their way here. Certain crimes are indicative of larger problems, so you should pay attention to them, and affected victims and family members get upset if crime is ignored.",
        "It's up to you to choose whom to convict. All available witness information is presented for each case. You can also interrogate suspects. This is particularly important for schemes where the witnesses might not have the full story.",
        "It is recommended to place a certain number of {{Cages}} and {{Chains}} and assign them to a {{Dungeon}} zone. Officers may opt for physical punishment if they cannot carry out custodial sentences.",
      ],
    },
    nobles: {
      title: "Nobles and administrators",
      body: [
        "Here you can view your nobles, as well as assign your military leaders, and other officials.",
        "{{Militia Commanders}} are assigned here. Once the first leader is assigned, subsequent {{Captain}} positions will appear. These can also be assigned from the squad menu.",
        "Certain important functions in your fortress can only be performed by assigned administrators, such as the {{Manager}} and {{Bookkeeper}}. Once they are assigned, you can create work orders, run a {{Hospital}}, and count and appraise your hoard.",
        "Nobles and certain administrators require rooms, and some may also make demands.",
      ],
    },
    stocks: {
      title: "Stocks",
      body: [
        "Here you can see every {{Item}} in the fortress. Click on category headings to collapse and expand them.",
        "If you don't have a {{Bookkeeper}}, or they don't have an {{Office}} to work in, numbers may be approximate.",
      ],
    },
    world: {
      title: "The World",
      body: [
        "The world created at the beginning of the game is active, and others may take an interest in your outpost as it grows. Stolen {{Artifacts}} and kidnapped citizens can be recovered by preparing missions from this screen.",
        "You can also cause trouble if you'd like to raid your neighbors. Raids are created by clicking on any site not belonging to your civilization.",
      ],
    },
  };

  function dismissKey(contextId) {
    return `dwf.help.dismissed.${contextId}`;
  }

  function isDismissed(contextId) {
    return window.DwfUtil.lsGet(dismissKey(contextId)) === "1";
  }

  function setDismissed(contextId) {
    window.DwfUtil.lsSet(dismissKey(contextId), "1");
  }

  function highlightBody(line) {
    return DWFUI.esc(line).replace(/\{\{(.+?)\}\}/g, (_, word) => `<span class="df-help-kw df-help-kw-inline">${word}</span>`);
  }

  let popupEl = null;
  let helpFocusGuardInstalled = false;
  function helpFocusable(panel) {
    return [...panel.querySelectorAll(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
  }
  function cycleHelpFocus(event, panel) {
    const focusable = helpFocusable(panel);
    if (!focusable.length) return;
    const at = focusable.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (at <= 0 ? focusable.at(-1) : focusable[at - 1])
      : (at < 0 || at === focusable.length - 1 ? focusable[0] : focusable[at + 1]);
    event.preventDefault();
    next.focus({ preventScroll: true });
  }
  function ensurePopupEl() {
    if (popupEl) return popupEl;
    popupEl = document.getElementById("helpPopup");
    if (!popupEl) {
      popupEl = document.createElement("div");
      popupEl.id = "helpPopup";
      document.body.appendChild(popupEl);
    }
    if (!helpFocusGuardInstalled) {
      helpFocusGuardInstalled = true;
      document.addEventListener("focusin", event => {
        if (!popupEl?.classList.contains("open") || popupEl.contains(event.target)) return;
        try { popupEl.querySelector("[data-help-dontshow]")?.focus({ preventScroll: true }); }
        catch (error) { DwfErr.report("tooltip.contain-help-focus", error); }
      }, true);
      const holdBackdropFocus = event => {
        if (!popupEl.classList.contains("open") ||
            event.target.closest?.("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")) return;
        event.preventDefault();
        if (event.target === popupEl) event.stopPropagation();
        try { popupEl.querySelector("[data-help-dontshow]")?.focus({ preventScroll: true }); }
        catch (error) { DwfErr.report("tooltip.refocus-help-backdrop", error); }
      };
      popupEl.addEventListener("pointerdown", holdBackdropFocus, true);
      popupEl.addEventListener("mousedown", holdBackdropFocus, true);
      popupEl.addEventListener("click", holdBackdropFocus, true);
    }
    return popupEl;
  }

  function closeHelpPopup() {
    const el = ensurePopupEl();
    el.classList.remove("open");
    el.innerHTML = "";
  }
  function restorePageFocus() {
    try { document.getElementById("view")?.focus({ preventScroll: true }); }
    catch (error) { DwfErr.report("tooltip.restore-map-focus", error); }
  }

  function helpPopupMarkup(contextId) {
    const ctx = HELP_CONTEXTS[contextId];
    if (!ctx) return "";
    const collapse = DWFUI.plaqueBtnHtml({
      cls: "df-help-collapse", size: "compact", title: "Collapse", ariaLabel: "Collapse",
      dataset: { helpCollapse: "" },
      labelHtml: DWFUI.rawHtml("the compact help chrome keeps its existing arrow glyph", "&#8593;"),
    });
    const close = DWFUI.plaqueBtnHtml({
      cls: "df-help-x", size: "compact", title: "Close", ariaLabel: "Close",
      dataset: { helpClose: "" },
      labelHtml: DWFUI.rawHtml("the compact help chrome keeps its existing close glyph", "&#10005;"),
    });
    const dontShow = DWFUI.checkHtml({
      checked: false, dataset: { helpDontshow: "" }, ariaLabel: "Don't show again",
    });
    const okay = DWFUI.plaqueBtnHtml({
      cls: "df-help-okay", label: "Okay", dataset: { helpOkay: "" },
    });
    const body = `
        <div class="df-help-icon" aria-hidden="true">?</div>
        <div class="df-help-controls">${collapse}${close}</div>
        <div class="df-help-scroll">
          <h2 class="df-help-title">${DWFUI.esc(ctx.title)}</h2>
          <div class="df-help-body">${ctx.body.map(line => `<p>${highlightBody(line)}</p>`).join("")}</div>
          <div class="df-help-dontshow" data-help-dontshow-row><span>Don't show again</span>${dontShow}</div>
          ${okay}
        </div>
      `;
    return DWFUI.modalHtml({ cls: "df-help-panel", ariaLabel: ctx.title }, body);
  }

  function showHelpPopup(contextId) {
    const ctx = HELP_CONTEXTS[contextId];
    if (!ctx) return;
    const el = ensurePopupEl();
    el.innerHTML = helpPopupMarkup(contextId);
    el.classList.add("open");
    const panel = el.querySelector(".df-help-panel");
    panel?.addEventListener("keydown", event => {
      if (event.key === "Tab") cycleHelpFocus(event, panel);
    });
    let dontShow = false;
    el.querySelector("[data-help-dontshow-row]")?.addEventListener("click", () => {
      dontShow = !dontShow;
      const control = el.querySelector("[data-help-dontshow]");
      if (control) {
        const restoreFocus = document.activeElement === control;
        control.outerHTML = DWFUI.checkHtml({
          checked: dontShow, dataset: { helpDontshow: "" }, ariaLabel: "Don't show again",
        });
        if (restoreFocus) el.querySelector("[data-help-dontshow]")?.focus();
      }
    });
    function close() {
      if (dontShow) setDismissed(contextId);
      closeHelpPopup();
      restorePageFocus();
    }
    el.querySelector("[data-help-okay]")?.addEventListener("click", close);
    el.querySelector("[data-help-collapse]")?.addEventListener("click", close);
    el.querySelector("[data-help-close]")?.addEventListener("click", close);
    try { el.querySelector("[data-help-dontshow]")?.focus({ preventScroll: true }); }
    catch (error) { DwfErr.report("tooltip.focus-help-dialog", error); }
  }

  // Shown-once per page load; the permanent dismissal lives in localStorage.
  const shownThisSession = new Set();

  function maybeShowHelp(contextId) {
    if (!HELP_CONTEXTS[contextId]) return;
    if (isDismissed(contextId)) return;
    if (shownThisSession.has(contextId)) return;
    shownThisSession.add(contextId);
    showHelpPopup(contextId);
  }

  if (!window.__DWF_STORY_MODE) try { window.DwfModeStack?.register({
    id: "context-help", flow: "global-overlays", depth: 70,
    active: () => !!popupEl && popupEl.classList.contains("open"),
    pop: () => { closeHelpPopup(); restorePageFocus(); return true; },
  }); } catch (err) { DwfErr.report("mode-stack.register", err); }

  window.DFHelpPopup = { maybeShow: maybeShowHelp, show: showHelpPopup, close: closeHelpPopup, storyMarkup: helpPopupMarkup };
})();
