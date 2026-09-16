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

  // ---- Defend-burrow order (native 2.4): burrow checklist + Confirm/Cancel. ----
  function sqBurrowRgb(value) {
    if (Array.isArray(value) && value.length >= 3) {
      return { r: Number(value[0]) || 0, g: Number(value[1]) || 0, b: Number(value[2]) || 0 };
    }
    if (value && typeof value === "object") {
      return { r: Number(value.r) || 0, g: Number(value.g) || 0, b: Number(value.b) || 0 };
    }
    return null;
  }

  function sqBurrowArt(burrow) {
    const symbol = Number(burrow && burrow.symbolIndex);
    const fg = sqBurrowRgb(burrow && (burrow.rgb || burrow.fgRgb));
    const bg = sqBurrowRgb(burrow && burrow.bgRgb);
    if (Number.isInteger(symbol) && symbol >= 0 && symbol < 23 && fg && bg) {
      return DWFUI.emblemHtml({
        symbol, fg, bg, size: 32, count: 23, cls: "squad-burrow-art",
        alt: `Burrow symbol for ${burrow.name || ("Burrow " + burrow.id)}`,
      });
    }
    return `<span class="squad-burrow-art squad-burrow-art--unavailable" role="img"` +
      ` aria-label="Burrow art unavailable" title="Burrow art unavailable from this server"></span>`;
  }

  function sqBurrowDefendView(squad, burrows, esc = window.sqEsc, checked = null, opts = {}) {
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const on = id => !!(checked && typeof checked.has === "function" && checked.has(String(id)));
    // One prompt only: modalHtml's own white PROMPT LINE carries "Select which burrows to defend."
    // (a second .squad-section-title copy of the same sentence doubled it on screen).
    const header = `<div id="squadStatus" class="info-message squad-status"></div>`;
    // PB-06 / F9-a: this is the SMALL LEFT-DOCKED NATIVE DIALOG (`2.4`, 968x988 = 1.45 SB x 0.72 VH),
    // not a wide window. It has NO header and NO close: a white PROMPT LINE, then the choice.
    const modal = body => DWFUI.modalHtml({
      cls: "squad-modal squad-burrow-modal", prompt: "Select which burrows to defend.",
      ariaLabel: "Select which burrows to defend",
    }, body);
    const footer = (burrowPicks = 0) => `<div class="squad-controls">
      ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Confirm", tone: "green", artTone: "confirm",
        disabled: burrowPicks === 0,
        title: burrowPicks
          ? `Issue the defend order for the ${burrowPicks} checked burrow${burrowPicks === 1 ? "" : "s"}`
          : "Check at least one burrow first" }), "burrowDefendConfirmBtn")}
      ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Cancel", tone: "red",
        title: "Abandon the defend-burrow order" }), "burrowDefendCancelBtn")}
    </div>`;
    const contextual = (body, burrowPicks = 0) => {
      const hasContext = Array.isArray(opts.squads);
      const left = modal(header + body + footer(burrowPicks));
      if (!hasContext) return left;
      return `<div class="squad-context-layout squad-burrow-layout"><main class="squad-context-main">${left}</main>` +
        `<aside class="squad-equip-context squad-burrow-context" aria-label="Squads">` +
        `${window.sqRootPane(opts.squads, opts.selectedId, opts.hasFree, esc, {
          blockingAppointments: opts.blockingAppointments,
          contextOnly: true,
        })}</aside></div>`;
    };
    if (burrows === null) {
      return contextual(`<div class="info-message">Burrows unavailable (this build may not support the defend-burrow order).</div>`);
    }
    if (!burrows.length) {
      return contextual(`<div class="info-message">No burrows exist yet. Create one in the Burrows panel first.</div>`);
    }
    const rows = burrows.map(b => {
      const name = esc(b.name || ("Burrow " + b.id));
      const count = Number(b.memberCount) || 0;
      return DWFUI.rowHtml({
        tag: "div", cls: "squad-pos-row squad-burrow-row", chassis: "table",
        icon: sqBurrowArt(b),
        labelHtml: DWFUI.bitmapTextHtml(name, { cls: "squad-burrow-name" }),
        sub: `${count} member${count === 1 ? "" : "s"}`,
        trailing: DWFUI.checkHtml({ checked: on(b.id), cls: "squad-burrow-check",
          dataset: { burrowId: b.id }, title: `Defend ${b.name || ("Burrow " + b.id)}`,
          ariaLabel: `Defend ${b.name || ("Burrow " + b.id)}` }),
      });
    }).join("");
    const burrowPicks = burrows.filter(b => on(b.id)).length;
    return contextual(
      window.sqListHtml({ cls: "squad-burrow-list", rows: ".squad-pos-row", preserveKey: "squads:burrows" }, rows),
      burrowPicks);
  }

  // ---- Defend-burrow wiring (native screen 2.4). ----
  async function squadLoadBurrows() {
    try {
      const data = await window.squadFetchJson(`/burrows?player=${encodeURIComponent(player)}&t=${Date.now()}`);
      window.DFSquadController.squadBurrows = Array.isArray(data.burrows) ? data.burrows : [];
    } catch {
      window.DFSquadController.squadBurrows = null;
    }
  }

  // The burrow checklist is now the native 2-state check TILE. `window.DFSquadController.burrowChecked` holds what the DOM
  // checkboxes' `.checked` held; Confirm still sends the SAME comma-separated id list.
  function wireBurrowDefendControls(squad) {
    if (!window.DFSquadController.burrowChecked) window.DFSquadController.burrowChecked = new Set();
    clientPanel.querySelectorAll("[data-burrow-id]").forEach(tile => {
      tile.addEventListener("click", event => {
        event.preventDefault();
        const id = String(tile.dataset.burrowId);
        if (window.DFSquadController.burrowChecked.has(id)) window.DFSquadController.burrowChecked.delete(id); else window.DFSquadController.burrowChecked.add(id);
        window.renderSquadsPanel();
      });
    });
    clientPanel.querySelector("#burrowDefendCancelBtn")?.addEventListener("click", () => window.goToView("list"));
    clientPanel.querySelector("#burrowDefendConfirmBtn")?.addEventListener("click", async () => {
      const ids = Array.from(window.DFSquadController.burrowChecked || []);
      if (!ids.length) { window.DFSquadController.squadStatusMsg = "Check at least one burrow."; window.renderSquadsPanel(); return; }
      try {
        await window.squadOrderPost({ squad: squad.id, action: "defend-burrow", burrows: ids.join(",") });
        window.DFSquadController.squadStatusMsg = "Defend-burrow order issued.";
        window.DFSquadController.squadView = "list";
        await window.refreshSquads();   // re-read both list + detail so the footer cannot contradict the write
      } catch (err) {
        // 501 (old DLL) / 400 -> show the error and stay on the picker (control reverts).
        window.DFSquadController.squadStatusMsg = err.message || "Could not issue defend-burrow order.";
        window.renderSquadsPanel();
      }
    });
  }

  window.sqBurrowDefendView = sqBurrowDefendView;
  window.squadLoadBurrows = squadLoadBurrows;
  window.wireBurrowDefendControls = wireBurrowDefendControls;
