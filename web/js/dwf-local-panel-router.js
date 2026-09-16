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

  function closeClientPanel() {
    window.DFAnnouncementMarkup?.closePanelCombatDrilldown();
    clientPanel.className = "";
    panelContent(clientPanel).innerHTML = "";
    activeInfoPanel = null;
    activeInfoSection = null;
    activeInfoDetail = null;
  }

  function setActiveToolbar(name) {
    document.querySelectorAll("[data-panel].active").forEach(button => button.classList.remove("active"));
    document.querySelectorAll("[data-panel]").forEach(button => {
      if (button.dataset.panel === name)
        button.classList.add("active");
    });
    refreshToolbarSprites(name);
  }

  function defaultSectionForPanel(name) {
    return ({
      citizens: "creatures",
      labor: "labor",
      locations: "places",
      orders: "tasks",
      workorders: "workorders",
      nobles: "nobles",
      objects: "objects",
      justice: "justice",
      stocks: "stocks"
    }[name] || "creatures");
  }

  function localPanelTitle(name) {
    return ({
      stocks: "Stocks",
      build: "Place Building",
      designate: "Designations",
      dig: "Dig",
      stockpile: "Stockpiles",
      zone: "Zones",
      objects: "Objects",
      justice: "Justice",
      search: "Search",
      alerts: "Announcements",
      hauling: "Hauling",
      settings: "Settings",
      speed: "Speed",
      map: "World Map",
      help: "Help",
      about: "DFHack"
    }[name] || name);
  }

  function renderLocalPanel(name) {
    const hud = currentHud || {};
    const title = localPanelTitle(name);
    const rows = [];
    if (name === "stocks") {
      rows.push(`Food: ~${hud.stocks?.food ?? 0}`);
      rows.push(`Drink: ~${hud.stocks?.drink ?? 0}`);
      rows.push("This is browser-owned; it does not open DF's global Stocks screen.");
    } else if (name === "designate" || name === "dig") {
      rows.push("Next layer: paint rectangles in this browser view and commit DF designations.");
    } else {
      rows.push("Panel shell is independent. Its real DF-backed controls are the next wiring step.");
    }
    panelContent(clientPanel).innerHTML = `
      <div class="kind">client ui</div>
      <h1>${window.escapeHtml(title)}</h1>
      ${rows.map(row => `<div class="line">${window.escapeHtml(row)}</div>`).join("")}
    `;
    clientPanel.classList.remove("info-panel");
    clientPanel.classList.add("visible");
  }

  if (typeof window !== "undefined") Object.assign(window, {
    closeClientPanel, setActiveToolbar, defaultSectionForPanel, renderLocalPanel,
  });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    closeClientPanel, setActiveToolbar, defaultSectionForPanel, renderLocalPanel,
  });
