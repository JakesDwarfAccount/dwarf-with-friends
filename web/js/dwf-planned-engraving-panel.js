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

  function plannedEngravingSheetMarkup(tile) {
    const ui = window.dwfuiAccessor();
    const x = Number(tile?.x), y = Number(tile?.y), z = Number(tile?.z);
    const coords = [x, y, z].every(Number.isFinite) ? `${x}, ${y}, ${z}` : "unknown tile";
    return ui.windowHtml({ cls: "planned-engraving-window", nativeFrame: "viewSheet",
      ariaLabel: "Planned engraving",
      bodyHtml: `<div class="planned-engraving-body">` +
        `<div class="planned-engraving-title">${ui.bitmapTextHtml(`Artwork planned at ${coords}`)}</div>` +
        ui.glyphBoxButton({ cols: 17, rows: 3, cls: "planned-engraving-image",
          glyphHtml: ui.rawHtml("planned-engraving case 4 has a text face inside native nine-slice chrome",
            ui.bitmapTextHtml("Choose artwork")),
          disabled: true, title: "Artwork selection is not available in the browser yet" }) +
        `</div>` });
  }
  function openPlannedEngravingPanel(tile) {
    if (!tile || !Number.isFinite(Number(tile.x))) { closeSelection(); return; }
    selection.className = "visible view-sheet-panel planned-engraving-panel";
    panelContent(selection).innerHTML = plannedEngravingSheetMarkup(tile);
    if (DWFUI.paintSprites) DWFUI.paintSprites(panelContent(selection));
  }

  if (typeof window !== "undefined") Object.assign(window, {
    plannedEngravingSheetMarkup, openPlannedEngravingPanel,
  });

  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    plannedEngravingSheetMarkup,
  });
