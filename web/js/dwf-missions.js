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

// ---- Mission roster and the site-first expedition flow; existing expeditions stay read-only. ----
// The server refuses the native-only commit, and this module always labels the expedition NOT created.
(function (root) {
  "use strict";

  var UI = root.DWFUI || (typeof DWFUI !== "undefined" ? DWFUI : null);
  if (UI && typeof UI.require === "function")
    UI.require("missions", ["headerHtml", "rowHtml", "scrollHtml", "statusHtml",
      "checkHtml", "plaqueBtnHtml", "rowGroupHtml"]);

  const REASONS = {
    "native-verdict-unavailable": "The game has not exposed enough state to confirm this option.",
    "own-civilization": "This site belongs to your own civilization.",
    "outside-authority": "This site is outside your authority.",
    "no-settled-populace": "No settled community is known here.",
    "no-requestable-workers": "Nobody here is currently available to answer a request.",
    unreachable: "The site cannot currently be reached.",
    "no-military-leader": "The fortress has no leader responsible for military plans.",
    "no-general-leader": "The fortress has no leader available for this request.",
    "no-contact": "Contact has not been established.",
    "already-at-war": "War has already been declared.",
    "peace-already-stands": "A peace agreement already stands.",
    "alliance-already-stands": "An alliance already stands.",
    "at-war": "The two sides are at war.",
    "cannot-communicate": "The two sides cannot communicate.",
    "implacably-hostile": "This group will not negotiate.",
    "no-trade": "There is no trade relationship.",
    "already-trading": "Trade is already established.",
    "no-civilization-military-leader": "Their civilization has no military representative.",
  };

  const ACTIONS = [
    ["Attack", "attack"],
    ["Request workers", "requestWorkers"],
    ["Diplomacy", "diplomacy"],
  ];

  const NEW_MISSION_GOALS = [
    { label: "Attack", verdictKey: "attack", goal: "SITE_INVASION" },
    { label: "Request workers", verdictKey: "requestWorkers", goal: "MAKE_REQUEST" },
    { label: "Diplomacy", verdictKey: "diplomacy", goal: "DIPLOMACY" },
  ];

  function pretty(value) {
    return String(value || "Unknown").replace(/[_-]/g, " ").toLowerCase()
      .replace(/(^|\s)\S/g, c => c.toUpperCase());
  }

  function travelText(site) {
    const labels = {
      unreachable: "Currently unreachable",
      brief: "A brief journey",
      "half-day": "Roughly half a day away",
      "near-day": "Nearly a day away",
      day: "About a day away",
      "over-day": "More than a day away",
    };
    if (site?.travelBand === "days")
      return `${Math.max(0, Number(site.travelDays) || 0)} days away`;
    return labels[site?.travelBand] || "";
  }

  // Keyed on the numeric verdict CODE, never on reasonKey: native keys on the number, and a server that
  // forgets a key must not silently change what the screen says. Four codes print NOTHING at all.
  const NEW_MISSION_ARRAY_LEN = 27;
  const DIPLOMACY_TOPIC_ARRAY_LEN = 18;

  // Verdict codes that print no reason at all. 0 and 1 are not disablement reasons; 2 and 11 are
  // disabled and deliberately silent.
  const SILENT_VERDICT_CODES = [0, 1, 2, 11];

  // code -> reason key, arms 3..20. `null` is an arm that prints nothing (11 has no caption).
  const VERDICT_REASON_KEY_BY_CODE = {
    3: "own-civilization", 4: "outside-authority", 5: "no-settled-populace",
    6: "no-requestable-workers", 7: "unreachable", 8: "no-military-leader",
    9: "no-general-leader", 10: "no-contact", 11: null, 12: "already-at-war",
    13: "peace-already-stands", 14: "alliance-already-stands", 15: "at-war",
    16: "cannot-communicate", 17: "implacably-hostile", 18: "no-trade",
    19: "already-trading", 20: "no-civilization-military-leader",
  };

  function verdictCaption(code) {
    const n = Number(code);
    if (SILENT_VERDICT_CODES.includes(n)) return "";
    const key = VERDICT_REASON_KEY_BY_CODE[n];
    return key ? (REASONS[key] || "") : "";
  }

  function verdictText(verdict) {
    if (!verdict) return "";
    const code = Number(verdict.code);
    if (code === 1) return "";
    if (verdict.enabled || code === 0) return "Available in the native world screen";
    // -1 is OURS, not native's, and has no arm to read a caption from, so it joins the silent values.
    if (code === -1) return "";
    return verdictCaption(code);
  }

  function siteTooltipHtml(site) {
    if (!site) return "";
    const rows = [UI.rowHtml({ label: site.name || "Unknown site" })];
    if (site.hasGovernment)
      rows.push(UI.rowHtml({ label: "Government", trailing: UI.statusHtml({ tag: "span", text: site.govName || "Unknown" }) }));
    rows.push(UI.rowHtml({
      label: "Population",
      trailing: UI.statusHtml({ tag: "span", text: site.hasGovernment && site.populationBand
        ? site.populationBand.advertised : "No settled population is recorded" }),
    }));
    if (site.civName)
      rows.push(UI.rowHtml({ label: "Civilization", trailing: UI.statusHtml({ tag: "span", text: site.civName }) }));
    if (!site.isOwnFortress && travelText(site))
      rows.push(UI.rowHtml({ label: "Travel", trailing: UI.statusHtml({ tag: "span", text: travelText(site) }) }));
    const verdicts = site.verdicts || {};
    const available = ACTIONS.map(([label, key]) => {
      const text = verdictText(verdicts[key]);
      return text ? `${label}: ${text}` : "";
    }).filter(Boolean);
    rows.push(UI.statusHtml({
      cls: "world-site-action-status", tone: "info", role: "note", columns: 42,
      text: available[0] || "Open Missions to inspect the game's current eligibility verdicts.",
    }));
    rows.push(UI.statusHtml({
      cls: "world-mission-readonly", tone: "warn", role: "note", columns: 42,
      text: "Mission actions are read-only in this build.",
    }));
    return `<div class="world-site-tooltip-card">${rows.join("")}</div>`;
  }

  function eligibilityRows(site) {
    const verdicts = site?.verdicts || {};
    const actions = ACTIONS.map(([label, key]) => {
      const verdict = verdicts[key];
      if (!verdict || Number(verdict.code) === 1) return "";
      return UI.rowHtml({
        cls: "world-mission-eligibility" + (verdict.enabled ? "" : " disabled"),
        label,
        sub: { text: verdictText(verdict) },
        trailing: UI.statusHtml({
          tag: "span", tone: verdict.enabled ? "good" : "muted",
          text: verdict.enabled ? "Eligible" : "Unavailable",
          title: verdictText(verdict),
        }),
      });
    }).join("");
    const topics = (Array.isArray(site?.diplomacyTopics) ? site.diplomacyTopics : [])
      .filter(topic => Number(topic.code) !== 1)
      .map(topic => UI.rowHtml({
        cls: "world-mission-eligibility diplomacy-topic" + (topic.enabled ? "" : " disabled"),
        label: pretty(topic.labelKey),
        sub: { text: verdictText(topic) },
        trailing: UI.statusHtml({ tag: "span", tone: topic.enabled ? "good" : "muted",
          text: topic.enabled ? "Eligible" : "Unavailable", title: verdictText(topic) }),
      })).join("");
    return actions + topics;
  }

  function missionTarget(data, siteId) {
    return (Array.isArray(data?.targets) ? data.targets : [])
      .find(site => Number(site.id) === Number(siteId)) || null;
  }

  function newMissionGoalRows(site) {
    const verdicts = site?.verdicts || {};
    return NEW_MISSION_GOALS.map(goal => {
      const verdict = verdicts[goal.verdictKey];
      // Verdict 1 is not a disabled row: it is absent and consumes no list pitch.
      if (!verdict || Number(verdict.code) === 1) return "";
      const reason = verdictText(verdict);
      return UI.rowHtml({
        tag: verdict.enabled ? "button" : "div",
        cls: "world-mission-goal-row" + (verdict.enabled ? "" : " disabled"),
        dataset: verdict.enabled ? { missionNewGoal: goal.goal } : {},
        label: goal.label,
        sub: reason ? { text: reason } : undefined,
        trailing: UI.statusHtml({
          tag: "span", tone: verdict.enabled ? "good" : "muted",
          text: verdict.enabled ? "Available" : "Unavailable",
        }),
      });
    }).join("");
  }

  function newMissionPanelHtml(data, siteId, options) {
    const opts = options || {};
    const site = missionTarget(data, siteId);
    const head = UI.headerHtml({
      cls: "world-civs-head", title: site?.name || "Choose an expedition goal", titleCls: "world-civs-title",
      back: { dataset: { missionNewBack: "" }, title: "Back to the world map" },
      close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" },
    });
    if (!data)
      return `<div class="world-civs-panel world-missions-panel world-new-mission-panel stale">${head}${UI.statusHtml({
        cls: "world-mission-note", text: "Reading this site's expedition options...", role: "status",
      })}</div>`;
    if (!site)
      return `<div class="world-civs-panel world-missions-panel world-new-mission-panel">${head}${UI.statusHtml({
        cls: "world-mission-note", tone: "danger", text: "The game did not provide expedition verdicts for this site.", role: "alert",
      })}</div>`;

    const kind = typeof opts.siteKind === "function" ? opts.siteKind(site) : pretty(site.subtypeKey || site.type);
    const population = site.populationBand?.advertised || "no settled population recorded";
    const standing = opts.diplomacy || "standing not recorded";
    const facts =
      UI.statusHtml({ cls: "world-new-mission-target-kind", role: "note", text: kind }) +
      UI.statusHtml({ cls: "world-new-mission-population world-newmission-population", role: "note", text: `Population: ${population}` }) +
      UI.statusHtml({ cls: "world-new-mission-diplomacy", role: "note", text: `Standing: ${standing}` });
    const goals = newMissionGoalRows(site);
    const body = goals || UI.statusHtml({ cls: "world-mission-note", tone: "muted", text: "No expedition goals are shown for this site." });
    // Deliberately no scrollHtml, squad picker, messenger picker, or commit plaque in this mode.
    return `<div class="world-civs-panel world-missions-panel world-new-mission-panel">${head}${facts}<div class="world-new-mission-goal-list">${body}</div></div>`;
  }

  function pendingMissionDetailHtml(data, pending, options) {
    const p = pending || {};
    const opts = options || {};
    const site = missionTarget(data, p.siteId) || opts.mapSite || null;
    const goal = NEW_MISSION_GOALS.find(item => item.goal === p.goal);
    const title = goal?.label || pretty(p.goal || "Pending expedition");
    const head = UI.headerHtml({
      cls: "world-civs-head", title, titleCls: "world-civs-title",
      back: { dataset: { missionPendingBack: "" }, title: "Back to expedition goals" },
      close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" },
    });
    let refusal;
    if (p.result?.blocked === "native-only") {
      refusal = `Expedition not created. ${p.result.error || "Dwarf Fortress did not accept the expedition."}`;
    } else if (p.result?.ok) {
      refusal = "Expedition not confirmed. The response could not prove that Dwarf Fortress created it, so this client has kept it pending.";
    } else if (p.error) {
      refusal = `Expedition not created. ${p.error}`;
    } else {
      refusal = p.busy ? "Expedition not created. Checking the native creation boundary..." : "Expedition not created.";
    }
    const refusalHtml = UI.statusHtml({
      cls: "world-mission-note world-mission-not-created", tone: "warn", role: "status", text: refusal,
    });
    const squads = Array.isArray(data?.squads) ? data.squads : [];
    const picked = new Set((Array.isArray(p.squadIds) ? p.squadIds : []).map(Number));
    const rows = squads.length ? squads.map(squad => UI.rowHtml({
      cls: "world-mission-roster" + (squad.busy ? " other-mission disabled" : " free"),
      label: squad.name || `Squad ${squad.id}`,
      sub: { text: squad.busy ? (squad.busyReason || "Unavailable") : `${Number(squad.memberCount) || 0} members` },
      trailing: UI.checkHtml({
        checked: picked.has(Number(squad.id)), disabled: !!squad.busy,
        dataset: { missionPendingSquad: squad.id },
        ariaLabel: `Stage ${squad.name || "squad"} for this pending expedition`,
        title: squad.busy ? (squad.busyReason || "Unavailable") : "Stage this assignment locally",
      }),
    })).join("") : UI.statusHtml({ cls: "info-message", text: "No squads are available to stage." });
    const staged = UI.statusHtml({
      cls: "world-mission-footer", tone: picked.size ? "info" : "muted",
      text: picked.size ? `${picked.size} squad assignment${picked.size === 1 ? "" : "s"} staged locally; nothing has been sent.`
        : "Choose squads to stage assignments. Nothing will be sent from this pending screen.",
    });
    const sections =
      UI.rowGroupHtml({ cls: "world-mission-group", header: { label: site?.name || "Unknown destination" },
        rows: [UI.statusHtml({ cls: "world-mission-pending-kind", text: `Pending ${title.toLowerCase()} expedition` })] }) +
      UI.rowGroupHtml({ cls: "world-mission-group", header: { label: "Squads", count: squads.length }, rows: [rows] }) + staged;
    return `<div class="world-civs-panel world-missions-panel world-mission-detail world-mission-pending">${head}${refusalHtml}${UI.scrollHtml({ cls: "world-civs-list", ariaLabel: "Pending expedition details" }, sections)}</div>`;
  }

  function siteRows(data) {
    const sites = Array.isArray(data?.targets) ? data.targets : [];
    if (!sites.length)
      return UI.statusHtml({ cls: "info-message", text: "No known mission sites are recorded.", role: "status" });
    return sites.map(site => UI.rowGroupHtml({
      cls: "world-mission-site",
      header: { label: site.name || `Site ${site.id}` },
      rows: [
        UI.rowHtml({
          label: site.hasGovernment && site.populationBand
            ? `Population ${site.populationBand.advertised}` : "No settled population is recorded",
          sub: { text: [site.govName, site.civName, travelText(site)].filter(Boolean).join(" · ") },
        }),
        eligibilityRows(site),
      ],
    })).join("");
  }

  function sortedMissions(data) {
    return (Array.isArray(data?.active) ? data.active : []).slice().sort((a, b) =>
      (Number(b.year) || 0) - (Number(a.year) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0));
  }

  function missionListHtml(data) {
    const missions = sortedMissions(data);
    if (!missions.length) return "";
    return UI.scrollHtml({ cls: "world-civs-list", rows: ".world-mission-row", ariaLabel: "Recorded missions" }, missions.map(mission => {
      const role = mission.roleNoun === "messenger" ? "messenger" : "commander";
      const counts = `${Number(mission.presentCount) || 0} present · ${Number(mission.travellingCount) || 0} away`;
      return UI.rowHtml({
        tag: mission.alterable ? "button" : "div",
        cls: "world-mission-row" + (mission.alterable ? "" : " disabled"),
        dataset: mission.alterable ? { missionDetail: mission.id } : {},
        label: mission.targetSiteName || mission.targetSite || "Unknown destination",
        sub: { text: mission.alterable
          ? `${pretty(mission.goalKey || mission.goal)} · Year ${Number(mission.year) || 0}`
          : "Every assigned member is away, so this mission cannot currently be changed." },
        trailing: UI.statusHtml({
          tag: "span", text: `${counts} ${role}${(Number(mission.presentCount) || 0) + (Number(mission.travellingCount) || 0) === 1 ? "" : "s"}`,
          title: `${counts}, ${role} roster`,
        }),
      });
    }).join(""));
  }

  function rosterHtml(mission) {
    const messengerMode = mission?.roleNoun === "messenger";
    const roster = messengerMode
      ? (Array.isArray(mission?.messengers) ? mission.messengers : [])
      : (Array.isArray(mission?.roster) ? mission.roster : []);
    if (!roster.length)
      return UI.statusHtml({ cls: "info-message", text: messengerMode
        ? "No messengers are recorded for this mission." : "No squads are recorded for this mission." });
    return roster.map(entry => {
      const assignedHere = entry.assignment === "this-mission";
      const status = assignedHere ? "Assigned here" : entry.assignment === "other-mission"
        ? (entry.otherMissionSummary || "Busy with another mission")
        : (entry.orderSummary || "No standing orders");
      const indicator = entry.lockedIn
        ? UI.statusHtml({ tag: "span", tone: "warn", text: "Locked", title: "Native has locked this assignment." })
        : UI.checkHtml({ checked: assignedHere, disabled: true, ariaLabel: `${entry.name || "Roster entry"} assignment` });
      return UI.rowHtml({
        cls: `world-mission-roster ${entry.assignment || "free"}`,
        label: entry.name || "Unnamed assignment",
        sub: { text: status },
        trailing: indicator,
      });
    }).join("");
  }

  function missionDetailHtml(mission) {
    if (!mission) return "";
    const count = (Number(mission.presentCount) || 0) + (Number(mission.travellingCount) || 0);
    const role = mission.roleNoun === "messenger" ? "messenger" : "commander";
    const summary = count
      ? `${Number(mission.presentCount) || 0} present and ${Number(mission.travellingCount) || 0} away`
      : `No ${role}s are assigned`;
    const missionRoster = mission.roleNoun === "messenger"
      ? (Array.isArray(mission.messengers) ? mission.messengers : [])
      : (Array.isArray(mission.roster) ? mission.roster : []);
    const anyAssigned = missionRoster.some(entry => entry.assignment === "this-mission");
    const footer = anyAssigned ? "The recorded assignment set is complete."
      : mission.roleNoun === "messenger" ? "No messengers are assigned."
      : "No squads are assigned.";
    const head = UI.headerHtml({
      cls: "world-civs-head", title: pretty(mission.goalKey || mission.goal),
      titleCls: "world-civs-title",
      back: { dataset: { missionDetailBack: "" }, title: "Back to missions" },
      close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" },
    });
    const sections =
      UI.rowGroupHtml({ cls: "world-mission-group", header: { label: mission.targetSiteName || mission.targetSite || "Unknown destination" },
        rows: [UI.rowHtml({ label: `Year ${Number(mission.year) || 0}`, sub: { text: summary } })] }) +
      (count ? UI.rowGroupHtml({ cls: "world-mission-group", header: { label: messengerModeLabel(mission) }, rows: [rosterHtml(mission)] }) : "") +
      UI.statusHtml({ cls: "world-mission-footer", tone: anyAssigned ? "good" : "muted", text: footer }) +
      UI.statusHtml({ cls: "world-mission-readonly", tone: "warn", columns: 42,
        text: mission.alterable
          ? "Assignments are shown for reference. This screen cannot change or confirm them."
          : "Everyone assigned is away; native would not allow this mission to be changed now." });
    return `<div class="world-civs-panel world-missions-panel world-mission-detail">${head}${UI.scrollHtml({ cls: "world-civs-list", ariaLabel: "Mission details" }, sections)}</div>`;
  }

  function messengerModeLabel(mission) {
    return mission?.roleNoun === "messenger" ? "Messengers" : "Squads";
  }

  function panelHtml(data, selectedId, options) {
    const opts = options || {};
    if (opts.mode === "new") return newMissionPanelHtml(data, opts.siteId, opts);
    if (opts.mode === "pending") return pendingMissionDetailHtml(data, opts.pending, opts);
    const head = UI.headerHtml({
      cls: "world-civs-head", title: "Missions", titleCls: "world-civs-title",
      close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" },
    });
    if (!data)
      return `<div class="world-civs-panel world-missions-panel stale">${head}${[1, 2, 3].map(i =>
        UI.rowHtml({ cls: "world-mission-skeleton", label: `Loading mission ${i}`, sub: { text: "Reading current world state…" } })).join("")}</div>`;
    if (data.error)
      return `<div class="world-civs-panel world-missions-panel">${head}${UI.statusHtml({
        cls: "world-mission-note", tone: "danger", text: `Missions could not be loaded: ${data.error}`, role: "alert",
      })}${UI.plaqueBtnHtml({ label: "Retry", tone: "green", dataset: { missionRetry: "" }, title: "Fetch the read-only mission list again." })}</div>`;
    const selected = sortedMissions(data).find(m => Number(m.id) === Number(selectedId));
    if (selected) return missionDetailHtml(selected);
    if (!sortedMissions(data).length) return "";
    const stale = Number(data.fetchedAt) > 0 && Date.now() - Number(data.fetchedAt) > 30000;
    const list = missionListHtml(data);
    const targets = siteRows(data);
    return `<div class="world-civs-panel world-missions-panel${stale ? " stale" : ""}">${head}` +
      `${stale ? UI.statusHtml({ cls: "world-mission-note", tone: "muted", text: "This mission snapshot is over 30 seconds old." }) : ""}` +
      `${list}${UI.rowGroupHtml({ cls: "world-mission-targets", header: { label: "Known sites and eligibility" }, rows: [targets] })}` +
      `${UI.statusHtml({ cls: "world-mission-readonly", tone: "warn", columns: 42,
        text: "This screen is read-only. Mission creation, assignment changes, and rescue actions remain in native Dwarf Fortress." })}</div>`;
  }

  function wire(container, handlers) {
    const h = handlers || {};
    container?.querySelectorAll("[data-mission-new-goal]").forEach(button =>
      button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        if (h.chooseGoal) h.chooseGoal(button.dataset.missionNewGoal);
      }));
    container?.querySelector("[data-mission-new-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (h.backToMap) h.backToMap();
    });
    container?.querySelector("[data-mission-pending-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (h.backToGoals) h.backToGoals();
    });
    container?.querySelectorAll("[data-mission-pending-squad]").forEach(input =>
      input.addEventListener("change", event => {
        event.stopPropagation();
        if (h.togglePendingSquad) h.togglePendingSquad(Number(input.dataset.missionPendingSquad));
      }));
    container?.querySelectorAll("[data-mission-detail]").forEach(button =>
      button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        if (h.select) h.select(Number(button.dataset.missionDetail));
      }));
    container?.querySelector("[data-mission-detail-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (h.select) h.select(-1);
    });
    container?.querySelector("[data-mission-retry]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (h.retry) h.retry();
    });
  }

  const api = { panelHtml, missionListHtml, missionDetailHtml, newMissionPanelHtml, pendingMissionDetailHtml, newMissionGoalRows, siteTooltipHtml, travelText, verdictText, wire,
    // Ledger 0084 R5/R2, exported so the world suite can grade the caption table arm for arm
    // against src/missions.cpp's verdict_reason_key() rather than trusting that they agree.
    verdictCaption, VERDICT_REASON_KEY_BY_CODE, SILENT_VERDICT_CODES,
    NEW_MISSION_ARRAY_LEN, DIPLOMACY_TOPIC_ARRAY_LEN };
  root.DwfMissions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
