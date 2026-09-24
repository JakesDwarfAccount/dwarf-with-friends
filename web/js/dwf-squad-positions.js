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

  // ---- Positions screen (native 4): roster only; an unfilled position is a plain assign plaque. ----
  // A FILLED row is a div, not a button: it has a real tick-box, and a button inside a button eats the click.
  function sqPositionRows(members, selected = null) {
    if (!Array.isArray(members) || !members.length) {
      return `<div class="info-message">This squad has no positions.</div>`;
    }
    const ticked = selected instanceof Set ? selected : new Set();
    return members.map(m => {
      if (!m.filled) {
        return DWFUI.plaqueBtnHtml({ label: `Assign position ${m.idx}`, tone: "green",
          artTone: "neutral", cls: "squad-position-assign", dataset: { squadPickPos: m.idx },
          title: `Choose a citizen for position ${m.idx}` });
      }
      const name = m.name || ("Unit " + m.unitId);
      const orders = Array.isArray(m.orders) ? m.orders : [];
      const line = window.sqOrderLine(orders[0]);
      const labelHtml = DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered squad member name",
        `<span class="squad-roster-name-fit"${window.sqProfessionColorStyle(m)}>${DWFUI.bitmapTextHtml(name,
          { fitNativeLabel: { host: "parent" } })}</span>`);
      const sub = {
        html: DWFUI.bitmapTextHtml(orders.length > 1
          ? `${line.text} (+${orders.length - 1} more)` : line.text, { fitNativeLabel: { host: "parent" } }),
        cls: "squad-pos-order", tone: line.tone,
      };
      return DWFUI.rowHtml({
        tag: "div", cls: "squad-position-row", chassis: "table",
        dataset: { squadPickPos: m.idx }, icon: window.sqUnitPortrait(m),
        labelHtml, labelCls: "squad-pos-who", sub,
        title: `Choose a citizen for position ${m.idx}`,
        trailing: DWFUI.checkHtml({
          checked: ticked.has(Number(m.idx)), cls: "squad-pos-check",
          dataset: { squadMemberSelect: m.idx },
          title: "Select this soldier - orders then apply to the ticked soldiers only",
          ariaLabel: `Select ${name} for member-level orders`,
        }),
      });
    }).join("");
  }

  function sqCandidateSortedRows(candidates, sortKey = "suitability", direction = 1) {
    const rows = Array.isArray(candidates) ? candidates.slice() : [];
    if (sortKey === "suitability") return direction < 0 ? rows.reverse() : rows;
    const value = candidate => sortKey === "profession"
      ? String(candidate.profession || candidate.job || "") : String(candidate.name || "");
    rows.sort((a, b) => value(a).localeCompare(value(b)) * direction ||
      String(a.name || "").localeCompare(String(b.name || "")));
    return rows;
  }

  function sqCandidateRows(candidates, pos) {
    if (!Array.isArray(candidates) || !candidates.length) {
      return `<div class="info-message">No available citizens.</div>`;
    }
    return candidates.map(c => {
      const name = c.name || ("Unit " + c.unitId);
      const meta = [c.profession || c.job || "Citizen",
        ...(Array.isArray(c.topSkills) ? c.topSkills : [])].filter(Boolean).join(" - ");
      const labelHtml = DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered squad candidate name",
        `<span class="squad-roster-name-fit"${window.sqProfessionColorStyle(c)}>${DWFUI.bitmapTextHtml(name,
          { fitNativeLabel: { host: "parent" } })}</span>`);
      return DWFUI.rowHtml({
        tag: "button", cls: "squad-candidate-row", chassis: "table",
        dataset: { squadAssignUnit: c.unitId, squadAssignPos: pos,
          candidateSearch: `${name} ${meta}`.toLowerCase() },
        icon: window.sqUnitPortrait(c), labelHtml, labelCls: "squad-pos-who",
        sub: { html: DWFUI.bitmapTextHtml(meta, { fitNativeLabel: { host: "parent" } }),
          cls: "squad-pos-role" }, title: `Assign ${name} to position ${pos}`,
      });
    }).join("");
  }

  function sqPositionsView(detail, esc = window.sqEsc, opts = {}) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const members = Array.isArray(squad.members) ? squad.members : [];
    const picks = opts.memberPicks instanceof Set ? opts.memberPicks : new Set();
    return `
      ${window.sqBackHeader(squad, esc)}
      <div id="squadStatus" class="info-message squad-status"></div>
      <div class="dwfui-text--section squad-section-title">Positions</div>
      ${window.sqListHtml({ cls: "squad-pos-list", rows: ".squad-position-row, .squad-position-assign", preserveKey: "squads:positions" },
        sqPositionRows(members, picks))}
      ${opts.showOrders === false ? "" : window.sqOrderToolbar(squad, {
        moveArmed: window.DFSquadController.squadMoveArmedFor.id === squad.id,
        killArmed: window.DFSquadController.squadKillArmedFor.id === squad.id, killTargets: window.DFSquadController.squadKillArmedFor.targets,
        memberPicks: picks })}`;
  }

  // Native screen 4.1: one exact SQUAD_FILL_POSITION target, never a roster+slot-stepper mashup.
  function sqCandidateView(detail, pos, options = {}) {
    const squad = detail && detail.squad;
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const members = Array.isArray(squad.members) ? squad.members : [];
    const member = members.find(row => Number(row.idx) === Number(pos));
    if (!member) return `<div class="info-message">Position unavailable.</div>`;
    // Position 0 (the squad commander) is assigned like any other slot: there is no locked pos-0
    // branch here.
    const candidates = sqCandidateSortedRows(detail.candidates, options.sortKey, options.sortDirection);
    const sort = DWFUI.sortHeaderHtml({
      cls: "squad-candidate-sort", dataAttr: "squad-candidate-sort", ariaLabel: "Sort citizens",
      active: options.sortKey || "suitability",
      columns: [
        { key: "name", label: "Name", sort: options.sortDirection < 0 ? "desc" : "asc" },
        { key: "category", label: "Cat", sort: "asc", disabled: true,
          title: "The squad payload does not expose native's category field" },
        { key: "profession", label: "Prof", sort: options.sortDirection < 0 ? "desc" : "asc" },
        { key: "suitability", label: "Skill", sort: options.sortDirection < 0 ? "desc" : "asc",
          title: "DF effective military-skill order (exact native squad suitability is not exposed)" },
      ],
    });
    const remove = member.filled ? DWFUI.rowHtml({
      tag: "button", cls: "squad-candidate-remove", chassis: "table",
      dataset: { squadRemoveAssignment: member.unitId }, label: "Remove assignment",
      title: `Remove ${member.name || "this citizen"} from position ${pos}`,
    }) : "";
    return `<div class="squad-candidate-screen" data-candidate-position="${Number(pos)}">
      ${sort}${remove}
      ${DWFUI.scrollHtml({ cls: "squad-candidate-list", preserveKey: `squads:candidates:${pos}`,
        dataset: { dwfuiTable: ".squad-candidate-row", dwfuiTableFlex: 1 } },
        sqCandidateRows(candidates, pos))}
      ${DWFUI.searchHtml({ cls: "squad-candidate-search", placement: "footer", magnifier: true,
        dataAttr: "squad-candidate-search", type: "search", value: options.search || "",
        preserveKey: `squads:candidates:${pos}`, ariaLabel: "Search citizens" })}
    </div>`;
  }

  window.sqPositionsView = sqPositionsView;
  window.sqPositionRows = sqPositionRows;
  window.sqCandidateRows = sqCandidateRows;
  window.sqCandidateView = sqCandidateView;
  window.sqCandidateSortedRows = sqCandidateSortedRows;
