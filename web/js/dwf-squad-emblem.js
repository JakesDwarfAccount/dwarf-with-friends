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

  // ---- Emblem edit screen (native 3): symbol grid + fg/bg colour pickers. ----
  function sqEmblemView(detail, draft, esc = window.sqEsc) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const emblem = draft || squad.emblem;
    if (!emblem) {
      return window.sqBackHeader(squad, esc) +
        `<div class="info-message">This build does not serve squad-emblem data, so it cannot be edited here.</div>`;
    }
    const sym = Number(emblem.symbol);
    const unassigned = window.sqEmblemUnassigned(emblem);
    const rows = Math.ceil(window.SQUAD_SYMBOL_COUNT / 8);
    const grid = Array.from({ length: window.SQUAD_SYMBOL_COUNT }, (unused, i) =>
      DWFUI.selectCellHtml({
        cls: "squad-symbol-btn", selected: i === sym,
        dataset: { emblemSymbol: i }, title: `Symbol ${i + 1} of ${window.SQUAD_SYMBOL_COUNT}`,
        ariaLabel: `Symbol ${i + 1} of ${window.SQUAD_SYMBOL_COUNT}`,
      }, DWFUI.emblemHtml({ symbol: i, fg: emblem.fg, bg: emblem.bg, size: 32,
        count: window.SQUAD_SYMBOL_COUNT, cls: "squad-symbol-art", alt: `Symbol ${i + 1}` }))).join("");
    // The unassigned banner is the honest half of 0081 R8: DWF states that native has not yet rolled
    // this squad's emblem and that picking one here is what assigns it. It never rolls one itself.
    const banner = unassigned
      ? `<div class="info-message squad-emblem-unassigned-note">${"Dwarf Fortress has not assigned " +
          "this squad an emblem yet — it does that the first time it draws one, and the choice " +
          "is permanent. Pick a symbol and two colours below to assign it now."}</div>`
      : "";
    return `
      ${window.sqBackHeader(squad, esc)}
      <div id="squadStatus" class="info-message squad-status"></div>
      ${banner}
      <div class="squad-controls">
        <span class="squad-emblem" id="emblemPreview">${DWFUI.emblemHtml({ symbol: emblem.symbol,
          fg: emblem.fg, bg: emblem.bg, size: 32, count: window.SQUAD_SYMBOL_COUNT,
          cls: "squad-emblem-art", alt: "Emblem preview" })}</span>
        <span>Choose a symbol for the squad.</span>
      </div>
      <div class="dwfui-text--section squad-section-title">Symbol</div>
      ${DWFUI.scrollHtml({ cls: "squad-symbol-grid", rows: ".squad-symbol-btn",
        preserveKey: "squads:emblem-symbols" },
        `<div class="squad-emblem-grid" data-emblem-rows="${rows}">${grid}</div>`)}
      <div class="dwfui-text--section squad-section-title">Colours</div>
      <div class="squad-controls squad-emblem-palette">
        ${/* WIRED SUPERSET, NO BUILDER EXISTS, AND NOW ALSO AN EVIDENCE GAP. Native's picker is a
             36 x 10 RGB swatch block whose selected cell is found by RGB EQUALITY (0081 R10) -- but
             0081's open question 2 records that the palette's ACTUAL 36x10 rgb values were never
             located, so a native-shaped swatch grid could only be built out of invented colours.
             `<input type=color>` is a strict superset of the palette (0081 R3: emblem colour is full
             24-bit rgb, not a DF colour index), so it loses no capability -- it only loses the
             native grammar, and that stays reported rather than faked. */""}
        <label class="squad-ammo-flag">Symbol&nbsp;<input type="color" id="emblemFg" value="${window.sqRgbToHex(emblem.fg)}"></label>
        <label class="squad-ammo-flag">Background&nbsp;<input type="color" id="emblemBg" value="${window.sqRgbToHex(emblem.bg)}"></label>
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Done", tone: "green", artTone: "confirm",
          title: "Save this emblem" }), "emblemDoneBtn")}
      </div>`;
  }

  // ---- Emblem edit wiring (native screen 3). ----
  function sqHexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ""));
    if (!m) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  async function squadEmblemPost(squadId, e) {
    const q = new URLSearchParams({
      player, squad: squadId, symbol: e.symbol,
      fgR: e.fg.r, fgG: e.fg.g, fgB: e.fg.b,
      bgR: e.bg.r, bgG: e.bg.g, bgB: e.bg.b,
    }).toString();
    return window.squadFetchJson(`/squad-emblem?${q}&t=${Date.now()}`, { method: "POST" });
  }

  function wireEmblemControls(squad) {
    // Seed the draft from the served emblem the first time we enter the screen.
    if (!window.DFSquadController.emblemDraft) {
      const base = squad.emblem;
      if (!base) return;   // no emblem data -> the view already shows the graceful message
      // An unrolled record carries symbol -1: never `Number(x) || 0` here -- it invents choice 0 and Done persists it.
      const seeded = Number(base.symbol);
      window.DFSquadController.emblemDraft = { symbol: Number.isFinite(seeded) ? seeded : -1,
        fg: Object.assign({}, base.fg), bg: Object.assign({}, base.bg) };
    }
    // Repaint in place, never re-render: `<input type=color>` fires `input` continuously while the OS
    // picker is dragged, and a re-render destroys the live control.
    const repaintPreview = () => {
      const fg = DWFUI.emblemRgb(window.DFSquadController.emblemDraft.fg), bg = DWFUI.emblemRgb(window.DFSquadController.emblemDraft.bg);
      clientPanel.querySelectorAll("[data-dwfui-emblem]").forEach(node => {
        node.setAttribute("data-dwfui-emblem-fg", `${fg.r},${fg.g},${fg.b}`);
        node.setAttribute("data-dwfui-emblem-bg", `${bg.r},${bg.g},${bg.b}`);
      });
      const previewNode = clientPanel.querySelector("#emblemPreview [data-dwfui-emblem]");
      if (previewNode && window.DFSquadController.emblemDraft.symbol >= 0)
        previewNode.setAttribute("data-dwfui-emblem", String(window.DFSquadController.emblemDraft.symbol));
      DWFUI.paintEmblems(clientPanel);
    };
    const pickEmblemSymbol = btn => {
      window.DFSquadController.emblemDraft.symbol = Number(btn.dataset.emblemSymbol);
      window.renderSquadsPanel();
    };
    clientPanel.querySelectorAll("[data-emblem-symbol]").forEach(btn => {
      btn.addEventListener("click", () => pickEmblemSymbol(btn));
      btn.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        pickEmblemSymbol(btn);
      });
    });
    clientPanel.querySelector("#emblemFg")?.addEventListener("input", event => {
      window.DFSquadController.emblemDraft.fg = sqHexToRgb(event.target.value); repaintPreview();
    });
    clientPanel.querySelector("#emblemBg")?.addEventListener("input", event => {
      window.DFSquadController.emblemDraft.bg = sqHexToRgb(event.target.value); repaintPreview();
    });
    clientPanel.querySelector("#emblemDoneBtn")?.addEventListener("click", async () => {
      const draft = window.DFSquadController.emblemDraft;
      try {
        await squadEmblemPost(squad.id, draft);
        window.DFSquadController.squadStatusMsg = "Emblem saved.";
        window.DFSquadController.emblemDraft = null;
        window.DFSquadController.squadView = "list";
        await window.refreshSquads();       // re-read /squads so the row badge reflects the write
      } catch (err) {
        window.DFSquadController.squadStatusMsg = err.message || "Could not save emblem.";
        window.renderSquadsPanel();         // stay on the editor; draft preserved
      }
    });
  }



  window.sqEmblemView = sqEmblemView;
  window.wireEmblemControls = wireEmblemControls;
