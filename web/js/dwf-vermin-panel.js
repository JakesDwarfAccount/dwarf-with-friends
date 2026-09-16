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

  // Both use the item sheet's selection-host chassis: one click-time payload, one pure markup builder,
  // one write into #selection, and no camera mutation.
  function verminCaption(text, interiorCols = 60) {
    const chars = Array.from(String(text || "").trim());
    const budget = Math.max(3, Math.floor(Number(interiorCols) || 60) - 22);
    if (chars.length < budget) return chars.join("");
    // Native shortens to interiorWidth-23 and overwrites that string's final three cells with dots.
    return chars.slice(0, Math.max(0, budget - 4)).join("") + "...";
  }

  function verminBodyLines(text, columns = 56, maxRows = 11) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const next = line ? line + " " + word : word;
      if (line && Array.from(next).length > columns) {
        lines.push(line);
        line = word;
        if (lines.length >= maxRows) break;
      } else {
        line = next;
      }
    }
    if (lines.length < maxRows && line) lines.push(line);
    return lines.slice(0, maxRows);
  }

  function verminPortraitMarkup(data) {
    const ui = window.dwfuiAccessor();
    const source = { id: -1, rt: data?.verminToken || data?.creatureToken || "",
      ct: data?.verminCasteToken || data?.casteToken || "" };
    let art = null;
    try {
      if (typeof creatureCellMarkup === "function")
        art = creatureCellMarkup(source, "unit-portrait vermin-portrait-art", "");
    } catch { globalThis.DwfErr?.count("vermin-panel.portrait"); }
    if (!art && ui) art = ui.iconHtml({ emptyTile: false, cls: "vermin-portrait-missing", size: 32,
      alt: String(data?.title || "Vermin portrait") });
    return `<div class="vermin-portrait-slot" data-vermin-portrait data-creature-token="${ui.esc(source.rt)}">` +
      `${art || ""}${ui.frameNineSlice({ cols: 12, rows: 6, family: "pictureBox",
        cls: "vermin-portrait-frame" })}</div>`;
  }

  function verminSheetMarkup(data) {
    const ui = window.dwfuiAccessor();
    const caption = verminCaption(data?.title || "Vermin");
    const body = verminBodyLines(data?.description || "").map(line =>
      `<div class="vermin-text-line">${ui.bitmapTextHtml(line)}</div>`).join("");
    return ui.windowHtml({ cls: "vermin-sheet-window", nativeFrame: "viewSheet",
      ariaLabel: caption || "Vermin",
      bodyHtml: `<div class="vermin-sheet-body">${verminPortraitMarkup(data)}` +
        `<div class="vermin-species-caption" data-vermin-species>${ui.bitmapTextHtml(caption)}</div>` +
        `<div class="vermin-text" data-vermin-text>${body}</div></div>` });
  }
  function openVerminPanel(data) {
    if (!data) { closeSelection(); return; }
    selection.className = "visible view-sheet-panel vermin-sheet-panel";
    panelContent(selection).innerHTML = verminSheetMarkup(data);
    if (DWFUI.paintSprites) DWFUI.paintSprites(panelContent(selection));
  }

  if (typeof window !== "undefined") Object.assign(window, {
    verminCaption, verminBodyLines, verminSheetMarkup, openVerminPanel,
  });

  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    verminCaption, verminBodyLines, verminSheetMarkup,
  });
