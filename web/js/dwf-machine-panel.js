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

  if (typeof window !== "undefined") window.DWF_EXTENSION_LABEL = "Dwarf With Friends extension";
  // "No power source" is its own state and is tested BEFORE "starved": DF sets `active` only when
  // cur >= min AND cur >= 1, so a network of all-zero components satisfies 0 >= 0 and still stops.
  function machineChip(machine) {
    if (machine.frozen) return { key: "frozen", text: "Iced over - will not run until it thaws" };
    if (machine.curPower < 1) return { key: "no-source", text: "No power source attached" };
    if (machine.curPower < machine.minPower)
      return { key: "starved", text: `Short by ${machine.minPower - machine.curPower}` };
    if (!machine.active) return { key: "idle", text: "Not running" };
    return { key: "running", text: `Running, ${machine.curPower - machine.minPower} to spare` };
  }

  function machinePanelState(data) {
    const rows = Array.isArray(data && data.machines) ? data.machines : [];
    const machines = rows.map(m => {
      const curPower = Number(m.curPower) || 0;
      const minPower = Number(m.minPower) || 0;
      const components = (Array.isArray(m.components) ? m.components : []).map(c => ({
        buildingId: Number(c.buildingId),
        name: c.name || "Machine part",
        type: c.type || c.name || "Machine part",
        produced: Number(c.produced) || 0,
        consumed: Number(c.consumed) || 0,
        role: c.role || "inert",
      })).sort((a, b) => ((b.produced > 0) - (a.produced > 0)) ||
                         (b.consumed - a.consumed) || (a.buildingId - b.buildingId));
      const machine = {
        id: Number(m.id), x: Number(m.x), y: Number(m.y), z: Number(m.z),
        curPower, minPower, active: !!m.active, frozen: !!m.frozen, components,
      };
      machine.chip = machineChip(machine);
      // The bar must AGREE with the sentence beside it: gold means running, so anything else greys
      // it. Same predicate as the chip tone, read once here so the two cannot disagree.
      machine.running = machine.chip.key === "running";
      // Never divide by zero: a network with no consumers has minPower 0 and a full bar.
      machine.fillPct = Math.min(100, (curPower / Math.max(1, minPower)) * 100);
      machine.surplus = curPower - minPower;
      return machine;
    }).sort((a, b) => (b.active - a.active) ||
                      ((b.minPower - b.curPower) - (a.minPower - a.curPower)) || (a.id - b.id));
    return { machines, empty: machines.length === 0, selectedId: Number(data && data.machineId) };
  }

  // A read-only network report, not a building sheet: it lists every network in the fort, so a
  // building's own header grammar would claim this screen is about one building.
  function machinePanelMarkup(data) {
    const state = machinePanelState(data);
    const lines = state.machines.flatMap(machine => [
      `<div class="dwfui-text--section machine-network-line">${escapeHtml(machine.id === state.selectedId
        ? `Network ${machine.id} (this building)` : `Network ${machine.id}`)}</div>`,
      DWFUI.statusHtml({ cls: "machine-network-line", tone: machine.running ? "dim" : "warn",
                         text: machine.chip.text }),
      // Spare power is a DISTINCT segment past the 100% mark; `surplus` is measured against the same
      // requirement the fill is, so the boundary between the segments IS that mark.
      DWFUI.barRowHtml({ cls: "machine-headroom", label: "Power", pct: machine.fillPct,
                         tone: machine.running ? "" : "inactive",
                         max: Math.max(1, machine.minPower),
                         surplus: machine.running && machine.minPower > 0 ? machine.surplus : 0,
                         valueText: `${machine.curPower} / ${machine.minPower}` }),
      ...machine.components.map(c => window.zoneUnitRowHtml({
        label: c.name,
        meta: c.produced > 0 ? `Produces ${c.produced}`
            : c.consumed > 0 ? `Draws ${c.consumed}`
            : "Neither produces nor draws power",
      })),
    ]);
    // One scroll for every network: a list per network drew a scrollbar beside each one-row list.
    return `${DWFUI.headerHtml({ cls:"building-head", title:"Power networks", titleCls:"building-name", close:false })}` +
      DWFUI.statusHtml({ cls: "building-status", tone: "dim", columns: 56,
        text: `${window.DWF_EXTENSION_LABEL} · fortress-wide read-only view` }) +
      DWFUI.plaqueBtnHtml({ cls: "building-btn", label: "Back to building", dataset: { buildingBack: "" } }) +
      (state.empty
        ? `<div class="dwfui-text--note zone-note">Nothing is connected to a power network yet. Axles, gears and pumps join one as they are built.</div>`
        : DWFUI.scrollHtml({ cls: "zone-unit-list machine-networks", rows: ".machine-networks > *" },
            lines.join("")));
  }

  async function fetchMachineInfo(id) {
    try {
      const r = await fetch(`/machines?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      if (data && data.ok !== false && data.isMachine) return data;
    } catch { globalThis.DwfErr?.count("machine-panel.info"); }
    return null;
  }

  async function openMachinePanel(id) {
    const data = await fetchMachineInfo(id);
    if (!data) { window.openBuildingPanel(id); return; }
    window.setSelectionPanel("building-panel zone-panel zone-wide", machinePanelMarkup(data));
    selection.querySelector("[data-building-back]").addEventListener("click", event => {
      event.stopPropagation(); window.openBuildingPanel(id); focusPage();
    });
    // No other handlers: the whole panel is a read.
  }


  if (typeof window !== "undefined") Object.assign(window.DFBuildingOperationsMarkup ||= {}, { machinePanelMarkup });

  if (typeof window !== "undefined") Object.assign(window, { fetchMachineInfo, machinePanelState, openMachinePanel });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { machineChip, machinePanelState, machinePanelMarkup, fetchMachineInfo, openMachinePanel, DWF_EXTENSION_LABEL: "Dwarf With Friends extension" });
