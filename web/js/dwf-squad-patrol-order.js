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

  // ---- Patrol route editor (native 2.3). ----
  // Never add route deletion: a patrol order stores only `route_id`, so deleting a route leaves a dangling id.
  function sqPatrolView(squad, draft, esc = window.sqEsc) {
    if (!squad) return `<div class="info-message">Select a squad.</div>`;
    const route = draft || { name: "Route 1", points: [] };
    const points = Array.isArray(route.points) ? route.points : [];
    const hasDistinctPair = points.some((p, i) => i > 0 &&
      (Number(p.x) !== Number(points[0].x) || Number(p.y) !== Number(points[0].y) || Number(p.z) !== Number(points[0].z)));
    const rows = points.length ? points.map((p, index) => `<div class="squad-pos-row squad-patrol-point">
      <span class="squad-pos-role">Point ${index + 1}</span>
      ${DWFUI.artBtnHtml({ sprite: DWFUI.TOKENS.sprites.dump, dataset: { patrolRemove: index },
        title: `Remove point ${index + 1}`, ariaLabel: `Remove point ${index + 1}` })}
    </div>`).join("") : `<div class="info-message">No points yet. Click the map to add the first point.</div>`;
    return `${sqBackHeader(squad, esc)}${DWFUI.modalHtml({
      cls: "squad-modal squad-patrol-modal", prompt: "Assign patrol route",
      ariaLabel: "Assign patrol route",
    }, `
      <div id="squadStatus" class="info-message squad-status"></div>
      <label class="squad-field-label" for="patrolRouteName">Route name</label>
      ${DWFUI.textInputHtml({ cls: "squad-input squad-text-input", id: "patrolRouteName", maxLength: 30,
        value: route.name || "Route 1", ariaLabel: "Patrol route name" })}
      <div class="info-message">Click the map to add points. Change floors between clicks if the route uses stairs.</div>
      ${window.sqListHtml({ cls: "squad-patrol-list", rows: ".squad-patrol-point", preserveKey: "squads:patrol" }, rows)}
      <div class="squad-controls">
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Confirm", tone: "green", artTone: "confirm",
          disabled: !hasDistinctPair, title: "A patrol route needs two different points" }), "patrolConfirmBtn")}
        ${window.sqWithId(DWFUI.plaqueBtnHtml({ label: "Cancel", tone: "grey",
          title: "Abandon the patrol route" }), "patrolCancelBtn")}
      </div>`)}`;
  }

  // R7: native's back affordance is a CENTRED GREEN PLAQUE reading "Back to squads" -- not a "←"
  // arrow (TOKENS.sprites.back is the BUILDING-header arrow and squads does not use it).
  function sqBackPlaque(label = "Back to squads") {
    return window.sqWithId(DWFUI.plaqueBtnHtml({ label, tone: "green", cls: "squad-back-plaque" }), "squadBackBtn");
  }

  function sqBackHeader(squad, esc = window.sqEsc) {
    const displayName = esc(squad.alias || squad.name || ("Squad " + squad.id));
    return `<div class="squad-back-head">
      ${sqBackPlaque()}
      <div class="squad-back-title">${displayName}</div>
    </div>`;
  }

  // Native patrol flow: the editor remains open and map selection remains armed until Confirm,
  // Cancel, or Back. Map clicks arrive as persistent world coordinates from controls-placement.
  function wirePatrolControls(squad) {
    const nameInput = clientPanel.querySelector("#patrolRouteName");
    nameInput?.addEventListener("input", () => { window.DFSquadController.squadPatrolDraft.name = nameInput.value; });
    clientPanel.querySelectorAll("[data-patrol-remove]").forEach(button => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.patrolRemove);
        if (index >= 0) window.DFSquadController.squadPatrolDraft.points.splice(index, 1);
        window.renderSquadsPanel();
      });
    });
    if (window.DFSquadPatrol) {
      window.DFSquadPatrol.onPoint = pos => {
        if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return;
        const last = window.DFSquadController.squadPatrolDraft.points[window.DFSquadController.squadPatrolDraft.points.length - 1];
        if (!last || last.x !== pos.x || last.y !== pos.y || last.z !== pos.z)
          window.DFSquadController.squadPatrolDraft.points.push({ x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) });
        window.DFSquadController.squadStatusMsg = `${window.DFSquadController.squadPatrolDraft.points.length} route point${window.DFSquadController.squadPatrolDraft.points.length === 1 ? "" : "s"}.`;
        window.renderSquadsPanel();
      };
      window.DFSquadPatrol.arm(squad.id);
    }
    clientPanel.querySelector("#patrolConfirmBtn")?.addEventListener("click", async () => {
      window.DFSquadController.squadPatrolDraft.name = nameInput ? nameInput.value : window.DFSquadController.squadPatrolDraft.name;
      const points = window.DFSquadController.squadPatrolDraft.points.map(p => `${p.x}:${p.y}:${p.z}`).join(";");
      try {
        await window.squadOrderPost({ squad: squad.id, action: "patrol", name: window.DFSquadController.squadPatrolDraft.name, points });
        window.DFSquadController.squadStatusMsg = "Patrol order issued.";
        if (window.DFSquadPatrol) window.DFSquadPatrol.disarm();
        window.DFSquadController.squadView = "list";
        await window.refreshSquads();
      } catch (err) {
        window.DFSquadController.squadStatusMsg = err.message || "Patrol order failed.";
        window.renderSquadsPanel();
      }
    });
    clientPanel.querySelector("#patrolCancelBtn")?.addEventListener("click", () => window.goToView("list"));
  }



  window.sqPatrolView = sqPatrolView;
  window.sqBackPlaque = sqBackPlaque;
  window.sqBackHeader = sqBackHeader;
  window.wirePatrolControls = wirePatrolControls;
