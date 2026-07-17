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

// WD-26: the DF-styled tooltip component + first-time help-popup system.
//
// TOOLTIPS: every hover-title in the client (WD-4/WD-5/WD-6's TOOLBAR_TOOLTIPS-driven
// `title="text\nHotkey: x"` attributes, plus every other plain `title=` in index.html/the
// panel templates) today only shows the BROWSER's own native tooltip bubble -- not DF's dark
// panel + orange border + green "Hotkey: x" line (07-stockpile-mode.png, 09-burrows.png,
// 10-hauling.png, 11-traffic.png, 12b-itemdesig-tooltip.png all show the same anatomy: one
// dark box, 2px orange border, white body text, the LAST line colored green when it reads
// "Hotkey: X"). This is a fully delegated, zero-call-site-change component: it watches every
// `[title]` element in the document (mouseover/mouseout on `document`, one pair of listeners
// for the whole page -- no per-button wiring needed anywhere else) and re-renders that same
// text in DF's style, after DF's own ~350ms hover delay. The very first time an element is
// seen its `title` attribute is moved to `data-df-title` (this SUPPRESSES the browser's native
// bubble permanently for that element, including on the very first hover -- removing the
// attribute cancels the browser's own pending tooltip timer too); later hovers read from
// `data-df-title` instead, so nothing here needs to run more than once per element.
//
// HELP POPUPS: DF's first-time context popups (help_context_type) are a second, pervasive,
// real system: a ❓ icon box, a title, body paragraphs (colored keyword links in DF, simplified
// to plain copy because this mirror has no per-word native indices yet), a "Don't show again"
// checkbox, a green "Okay"
// button, and an up-arrow ("collapse") + red-X ("close") pair at the panel's top-right corner
// (08b-zones-helppopup.png, 09-burrows.png, 10-hauling.png, 18-info-nobles.png,
// 20-info-justice.png, 22-world.png, 25-stocks.png all show one). Content below is transcribed
// verbatim from those seven captures -- the eighth context the spec names, "stockpiles", was
// NOT captured with a help popup in tools/spikes/ui-truth/07*.png (only its tooltip was), so it
// is deliberately left OUT of HELP_CONTEXTS rather than inventing body text (same "no fabricated
// data" rule WD-21's honest justice empty-states already established) -- flagged in the
// completion report as a follow-up for whenever that capture exists.
//
// "Don't show again" persists per (player, context) in localStorage -- the spec says server
// persistence isn't needed.

(function () {
  // ---------------------------------------------------------------------------------------
  // Tooltip component
  // ---------------------------------------------------------------------------------------
  const TT_DELAY_MS = 350;
  let ttEl = null;
  let ttTimer = null;
  let ttTarget = null;

  function ensureTooltipEl() {
    if (ttEl) return ttEl;
    ttEl = document.getElementById("dfTooltip");
    if (!ttEl) {
      // Defensive fallback in case index.html's container is ever missing -- create it rather
      // than silently doing nothing (tooltips are a WD-26 acceptance item).
      ttEl = document.createElement("div");
      ttEl.id = "dfTooltip";
      document.body.appendChild(ttEl);
    }
    return ttEl;
  }

  function titleTextFor(el) {
    return el.getAttribute("data-df-title") || el.getAttribute("title") || "";
  }

  // Moves a live `title` attribute onto `data-df-title` the first time an element is seen,
  // which is what actually suppresses the browser's own tooltip (removing the attribute
  // cancels its pending native-bubble timer, including the very first hover).
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
      return `<div class="${cls}">${escapeHtml(line)}</div>`;
    }).join("");
  }

  function positionTooltip(el) {
    const box = ensureTooltipEl();
    const r = el.getBoundingClientRect();
    // DF's own button tooltips float just above the hovered control (07/09/10/11/12b
    // captures); fall back to below if there isn't room (e.g. the top bar's row).
    box.style.visibility = "hidden";
    box.style.display = "block";
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    let left = r.left;
    let top = r.top - bh - 6;
    if (top < 4) top = r.bottom + 6;
    if (left + bw > innerWidth - 4) left = innerWidth - bw - 4;
    if (left < 4) left = 4;
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
    box.style.visibility = "visible";
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
    if (ttEl) ttEl.style.display = "none";
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
      if (ttTarget === el) showTooltipFor(el);
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

  // Any click/drag should drop a lingering tooltip immediately (matches native behavior).
  document.addEventListener("mousedown", hideTooltip, true);
  window.addEventListener("blur", hideTooltip);
  }

  window.DFTooltip = { hide: hideTooltip, storyMarkup: renderTooltipHtml };

  // ---------------------------------------------------------------------------------------
  // First-time help popups
  // ---------------------------------------------------------------------------------------
  // Body text transcribed verbatim from the ui-truth captures named above. Double braces mark
  // words DF renders in several colored link fonts. The mirror has no native per-word indices,
  // so these markers remain structural and inherit instead of collapsing them to one guessed hue.
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
    // "stockpiles" deliberately absent -- see file header. If a stockpile-mode help-popup
    // capture ever lands in tools/spikes/ui-truth/, transcribe it into a new entry here
    // exactly like the seven above (do NOT approximate/paraphrase DF's own copy).
  };

  function dismissKey(contextId) {
    return `dwf.help.dismissed.${contextId}`;
  }

  function isDismissed(contextId) {
    try { return localStorage.getItem(dismissKey(contextId)) === "1"; } catch (_) { return false; }
  }

  function setDismissed(contextId) {
    try { localStorage.setItem(dismissKey(contextId), "1"); } catch (_) {}
  }

  function highlightBody(line) {
    return escapeHtml(line).replace(/\{\{(.+?)\}\}/g, (_, word) => `<span class="df-help-kw" style="color:inherit">${word}</span>`);
  }

  let popupEl = null;
  function ensurePopupEl() {
    if (popupEl) return popupEl;
    popupEl = document.getElementById("helpPopup");
    if (!popupEl) {
      popupEl = document.createElement("div");
      popupEl.id = "helpPopup";
      document.body.appendChild(popupEl);
    }
    return popupEl;
  }

  function closeHelpPopup() {
    const el = ensurePopupEl();
    el.classList.remove("open");
    el.innerHTML = "";
  }

  function helpPopupMarkup(contextId) {
    const ctx = HELP_CONTEXTS[contextId];
    if (!ctx) return "";
    return `
      <div class="df-help-panel" role="dialog" aria-label="${escapeHtml(ctx.title)}">
        <div class="df-help-icon" aria-hidden="true">?</div>
        <div class="df-help-controls">
          <button type="button" class="df-help-collapse" title="Collapse" aria-label="Collapse">&#8593;</button>
          <button type="button" class="df-help-x" title="Close" aria-label="Close">&#10005;</button>
        </div>
        <div class="df-help-scroll">
          <h2 class="df-help-title">${escapeHtml(ctx.title)}</h2>
          <div class="df-help-body">${ctx.body.map(line => `<p>${highlightBody(line)}</p>`).join("")}</div>
          <label class="df-help-dontshow"><span>Don't show again</span><input type="checkbox" data-help-dontshow></label>
          <button type="button" class="df-help-okay" data-help-okay>Okay</button>
        </div>
      </div>`;
  }

  function showHelpPopup(contextId) {
    const ctx = HELP_CONTEXTS[contextId];
    if (!ctx) return; // no fabricated popups for contexts without a real capture
    const el = ensurePopupEl();
    el.innerHTML = helpPopupMarkup(contextId);
    el.classList.add("open");
    const dontShow = el.querySelector("[data-help-dontshow]");
    function close() {
      if (dontShow && dontShow.checked) setDismissed(contextId);
      closeHelpPopup();
      try { document.getElementById("view")?.focus({ preventScroll: true }); } catch (_) {}
    }
    el.querySelector("[data-help-okay]")?.addEventListener("click", close);
    // The collapse/close corner buttons are DF's window-chrome pair (08b/09/10/18/20/22/25 all
    // show them). This client has no separate "collapsed" popup state to restore from, so both
    // simply close the popup -- a documented simplification, not invented chrome (the buttons
    // are real DF elements; only the collapse *behavior* is simplified to "close").
    el.querySelector(".df-help-collapse")?.addEventListener("click", close);
    el.querySelector(".df-help-x")?.addEventListener("click", close);
  }

  // Re-entering a mode (e.g. clicking through Stocks' category rows, which re-opens the
  // "stocks" panel per row click) shouldn't re-pop the same help popup every single time --
  // DF's own help_context popups are a genuine "first entry" thing, not a per-refresh nag. This
  // in-memory set tracks "already shown this page load" independent of the permanent
  // localStorage dismiss flag, so a fresh page load still shows it again (until dismissed).
  const shownThisSession = new Set();

  function maybeShowHelp(contextId) {
    if (!HELP_CONTEXTS[contextId]) return;
    if (isDismissed(contextId)) return;
    if (shownThisSession.has(contextId)) return;
    shownThisSession.add(contextId);
    showHelpPopup(contextId);
  }

  if (!window.__DWF_STORY_MODE) document.addEventListener("keydown", event => {
    if (event.key === "Escape" && popupEl && popupEl.classList.contains("open")) {
      event.preventDefault();
      closeHelpPopup();
    }
  });

  window.DFHelpPopup = { maybeShow: maybeShowHelp, show: showHelpPopup, close: closeHelpPopup, storyMarkup: helpPopupMarkup };
})();
