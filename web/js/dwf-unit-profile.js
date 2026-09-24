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

  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function") DWFUI.require("unit-profile-alerts", [
    "actionButtonsHtml", "artBtnHtml", "bitmapTextHtml", "gridCellHtml", "gridHtml", "headerHtml", "iconHtml",
    "listHtml", "paintSprites", "plaqueBtnHtml", "rawHtml", "restoreScroll", "rowHtml", "scrollHtml", "statusHtml", "tabsHtml", "textInputHtml", "windowHtml", "TextLaw", "TOKENS",
  ]);

  function unitOverviewLines(unit, key, fallback = []) {
    const value = unit && Array.isArray(unit[key]) ? unit[key] : [];
    return value.length ? value : fallback;
  }

  // Native colour arrives as a per-span index from the plugin and renders through DwfDfMarkup.html().
  // Do NOT re-inline that renderer, or this becomes the only screen that can read DF's colour codes.
  function renderDfMarkup(raw) {
    const parser = typeof window !== "undefined" ? window.DwfDfMarkup : globalThis.DwfDfMarkup;
    if (!parser || typeof parser.html !== "function") return escapeHtml(raw);
    return parser.html(raw);
  }
  function colorizeUnitLine(line, tab, detail) {
    if (typeof line === "string" && line.includes("[")) return renderDfMarkup(line);
    if (detail === "Needs" || /^Unmet need:/.test(line))
      return `<span class="unit-need-line">${escapeHtml(line)}</span>`;
    return escapeHtml(line);
  }

  function renderUnitOverviewLines(unit, lines, tab = "Overview", detail = "") {
    const list = Array.isArray(lines) ? lines : [];
    if (!list.length) return "";
    return list.map(line => `<div class="unit-cell-line">${colorizeUnitLine(line, tab, detail)}</div>`).join("");
  }

  function renderUnitOverviewRelations(unit) {
    if (!Array.isArray(unit && unit.relations))
      return renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewRelationLines"), "Relations");
    return structuredOrder(unit.relations).filter(record => record && record.name).slice(0, 6).map(record =>
      `<div class="unit-cell-line">${escapeHtml(record.label || "Relation")}: ` +
      `<span${unitProfessionColorAttrs(record)}>${escapeHtml(record.name)}</span></div>`
    ).join("");
  }

  function renderUnitOverviewSkills(unit, category = null, limit = 6) {
    if (!Array.isArray(unit && unit.skills))
      return renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewSkillLines"), "Skills");
    return structuredOrder(unit.skills)
      .filter(skill => skill && skill.caption && (!category || skill.category === category))
      .slice(0, limit).map(skill =>
      `<div class="unit-cell-line"><span${skillCaptionColorStyle(skill)}>` +
      `${escapeHtml(`${skill.ratingCaption || "Dabbling"} ${skill.caption}`)}</span></div>`
    ).join("");
  }

  // Five is the observed capacity of the Overview military band; a sixth row clips.
  function renderUnitOverviewMilitary(unit) {
    const squadLines = unitOverviewLines(unit, "overviewSquadLines").slice(0, 5);
    const skillRows = Math.max(0, 5 - squadLines.length);
    return renderUnitOverviewLines(unit, squadLines, "Military", "Squad") +
      renderUnitOverviewSkills(unit, "Combat", skillRows);
  }

  // Native's upper-right Overview pane is six terse personal-value lines, not Traits or wounds.
  function renderUnitOverviewValues(unit) {
    const paragraphs = unit && unit.personalityNarrative &&
      Array.isArray(unit.personalityNarrative.values) ? unit.personalityNarrative.values : [];
    return paragraphs.flatMap(paragraph => Array.isArray(paragraph && paragraph.spans)
      ? paragraph.spans : [])
      .filter(span => /^personal-(?:positive|negative)$/.test(String(span && span.role || "")))
      .slice(0, 6)
      .map(span => {
        const negative = span.role === "personal-negative";
        const text = String(span.text || "")
          .replace(/^\s*(?:He|She|They|It)\s+personally\s+(?:values?|does not care about)\s+/i, "")
          .replace(/[.\s]+$/, "");
        return `<div class="unit-cell-line">${escapeHtml(`${negative ? "Disdains" : "Values"} ${text}`)}</div>`;
      }).join("");
  }

  function renderUnitOverviewActivity(unit) {
    const activity = unitActivityLine(unit);
    if (!activity || activity === "No activity") return "";
    return `<div class="unit-cell-line">${escapeHtml(activity)}</div>`;
  }

  function renderUnitOverviewQuote(unit) {
    const paragraphs = unit && unit.personalityNarrative &&
      Array.isArray(unit.personalityNarrative.traits) ? unit.personalityNarrative.traits : [];
    const source = paragraphs[0] && Array.isArray(paragraphs[0].spans) ? paragraphs[0].spans : [];
    const sentence = [];
    for (const span of source) {
      const text = String(span && span.text || "");
      const stop = text.indexOf(".");
      sentence.push({ ...span, text: stop >= 0 ? text.slice(0, stop + 1) : text });
      if (stop >= 0) break;
    }
    return sentence.length
      ? `<div class="unit-cell-line unit-overview-quote">"${renderUnitSpans(sentence)}"</div>` : "";
  }

  function renderUnitOverviewThoughts(unit) {
    const records = unit && unit.thoughts && Array.isArray(unit.thoughts.recent)
      ? structuredOrder(unit.thoughts.recent) : [];
    if (!records.length)
      return renderUnitOverviewLines(unit,
        unitOverviewLines(unit, "overviewMemoryLines", unit && unit.thoughtLines || []), "Thoughts");
    return records.slice(0, 6).map(record =>
      `<div class="unit-cell-line">${renderUnitSpans(normalizeThoughtSpans(record && record.spans))}</div>`
    ).join("");
  }

  // Overview uses native's terse "Unmet need: X" preview; the full prose belongs in the Personality tab.
  function renderUnitOverviewNeeds(unit) {
    return renderUnitOverviewLines(unit,
      unitOverviewLines(unit, "overviewNeedLines").slice(0, 6), "Personality", "Needs");
  }

  function renderUnitStatusWords(unit) {
    const words = unit && unit.statusWords;
    if (!Array.isArray(words)) {
      // Older hosts: use the served status list without inventing a "Health / N wounds" card.
      return renderUnitOverviewLines(unit,
        Array.isArray(unit && unit.statusLines) ? unit.statusLines.filter(line => line !== "Healthy") : []);
    }
    return words.map(word =>
      `<div class="unit-cell-line">${escapeHtml(word)}</div>`).join("");
  }

  function profileFollowId() { return window.getUnitFollowState().unitId; }

  function showUnitSheet(data) {
    selectedUnitData = data;
    activeUnitTab = "Overview";
    activeUnitDetailTab = null;
    renderUnitSheet();
    // startUnitSheetRefresh stops any prior timer, so opening a different unit re-targets the loop.
    startUnitSheetRefresh(Number(data?.unit?.id ?? -1));
  }

  // Follow: recenter off the live client snapshot, with a throttled /unit fallback that also reports
  // the unit dying or leaving the map. Moves ONLY this player's camera.

  function stripEmbeddedNickname(name) {
    const s = String(name || "");
    const out = s.replace(/'[^']*'/, "").replace(/\s{2,}/g, " ").replace(/^\s*,\s*/, "").trim();
    return out || s;
  }
  // Only strip when a live nickname line (unit.nickname) exists to defer to, so a unit whose only
  // nickname is the embedded one (e.g. a legends nickname with no fort nickname) never loses it.
  function unitNameLine(unit) {
    const name = String((unit && unit.name) || "");
    return (unit && unit.nickname) ? stripEmbeddedNickname(name) : name;
  }

  // DF colours the name/title line with the unit's profession colour; older payloads stay uncoloured.
  function unitNameColorStyle(unit) {
    const idx = unit && unit.professionColor;
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }
  // Native's third header line reads "No activity" when idle; older hosts send "No job".
  function unitActivityLine(unit) {
    const job = String((unit && unit.currentJob) || "").trim();
    return (!job || job === "No job") ? "No activity" : job;
  }

  async function openUnitRoom(buildingId, pos) {
    window.stopUnitFollow();
    stopUnitSheetRefresh();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
      try { await window.setCameraToMapPos(pos); }
      catch (err) { DwfErr.report("unit-profile.room-camera", err); }
      if (typeof flashMapTile === "function") flashMapTile(pos);
    }
    if (Number.isInteger(buildingId) && buildingId >= 0 && typeof openInfoPlace === "function")
      openInfoPlace("zone", buildingId);
    focusPage();
  }

  const UNIT_SHEET_REFRESH_MS = 3000;
  let unitSheetRefreshTimer = null;
  let unitSheetRefreshId = -1;
  let unitSheetRefreshBusy = false;

  function stopUnitSheetRefresh() {
    if (unitSheetRefreshTimer) { window.clearInterval(unitSheetRefreshTimer); unitSheetRefreshTimer = null; }
    unitSheetRefreshId = -1;
    unitSheetRefreshBusy = false;
  }

  function startUnitSheetRefresh(unitId) {
    stopUnitSheetRefresh();
    const id = Number(unitId);
    if (!Number.isInteger(id) || id < 0) return;
    unitSheetRefreshId = id;
    unitSheetRefreshTimer = window.setInterval(() => { unitSheetRefreshTick(); }, UNIT_SHEET_REFRESH_MS);
  }

  // True only while THIS player's unit sheet is the open panel for the unit we are refreshing.
  function unitSheetStillOpen(id) {
    return selection.classList.contains("visible") &&
      selection.classList.contains("unit-sheet-panel") &&
      Number(selectedUnitData?.unit?.id) === id;
  }

  // An in-progress interaction (the nickname editor) must survive a refresh untouched.
  function unitSheetInteractionBusy() {
    return !!selection.querySelector("[data-unit-nickname-editor]");
  }

  async function unitSheetRefreshTick() {
    if (unitSheetRefreshId < 0 || unitSheetRefreshBusy) return;
    if (!unitSheetStillOpen(unitSheetRefreshId)) { stopUnitSheetRefresh(); return; }
    if (unitSheetInteractionBusy()) return;   // don't clobber an open nickname edit
    unitSheetRefreshBusy = true;
    try {
      const ac = ("AbortController" in window) ? new AbortController() : null;
      const to = ac ? setTimeout(() => ac.abort(), 2500) : null;
      const r = await fetch(`/unit?player=${encodeURIComponent(player)}&id=${encodeURIComponent(unitSheetRefreshId)}&t=${Date.now()}`,
        { cache: "no-store", signal: ac ? ac.signal : undefined });
      if (to) clearTimeout(to);
      if (!r.ok) return;                       // transient failure -> keep the current view, retry next tick
      const data = await r.json();
      // The sheet may have closed / switched / opened an editor during the await.
      if (unitSheetRefreshId < 0 || !unitSheetStillOpen(unitSheetRefreshId) ||
          Number(data?.unit?.id) !== unitSheetRefreshId || unitSheetInteractionBusy())
        return;
      selectedUnitData = data;
      renderUnitSheet();
    } catch {
      // network/timeout -> leave the current (stale) view in place; the next tick retries.
    } finally {
      unitSheetRefreshBusy = false;
    }
  }

  function unitNicknameEditorMarkup(unit, statusText = "") {
    const nickname = String(unit?.nickname || "").slice(0, 64);
    return `<form class="unit-nickname-editor" data-unit-nickname-editor>` +
      `<label class="unit-nickname-label"><span>Nickname</span>${DWFUI.textInputHtml({ cls: "unit-nickname-input", maxLength: 64, value: nickname, ariaLabel: "Unit nickname", autocomplete: "off", spellcheck: false })}</label>` +
      DWFUI.plaqueBtnHtml({ type: "submit", cls: "unit-nickname-save", tone: "green", label: "Save" }) +
      DWFUI.plaqueBtnHtml({ type: "button", cls: "unit-nickname-cancel", label: "Cancel", dataset: { unitNicknameCancel: "" } }) +
      DWFUI.statusHtml({ tag: "span", cls: "unit-nickname-status", text: statusText, role: "status", live: "polite" }) +
      `</form>`;
  }

  // The shared profile shell: no title bar, no footer, no visual close -- Esc and right-click dismiss.
  // ONE 11-item tablist over two rows; row B is not a sub-level, and the subtab row is conditional.
  const UNIT_PRIMARY_TABS = [
    "Overview", "Items", "Health", "Skills", "Rooms", "Labor",
    "Relations", "Groups", "Military", "Thoughts", "Personality",
  ];
  const UNIT_PRIMARY_TAB_GEOMETRY = {
    Overview: [0, 2, 11, 2], Items: [11, 2, 8, 2], Health: [19, 2, 9, 2],
    Skills: [28, 2, 9, 2], Rooms: [37, 2, 8, 2], Labor: [45, 2, 8, 2],
    Relations: [0, 0, 12, 2], Groups: [12, 0, 9, 2], Military: [21, 0, 11, 2],
    Thoughts: [32, 0, 11, 2], Personality: [43, 0, 14, 2],
  };
  function unitHeaderToolRows(unit, data) {
    const S = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
    const following = profileFollowId() >= 0 && profileFollowId() === Number(unit && unit.id);
    const tile = dataset => Object.assign({ dwfuiGlyphbox: "4x3" }, dataset);
    const upper = [];
    if (unit && unit.hasCombatReports === true)
      upper.push({ sprite: S.viewReports, glyphBox: { cols: 4, rows: 3 },
        dataset: tile({ unitCombatlog: "" }), title: "Combat history" });
    upper.push(
      { sprite: S.quill, glyphBox: { cols: 4, rows: 3, shareLeft: upper.length > 0 },
        dataset: tile({ unitNickname: "" }), title: "Customize identity" },
      {
        sprite: following ? S.cameraOn : S.cameraOff, active: following,
        glyphBox: { cols: 4, rows: 3, shareLeft: true, current: following },
        dataset: tile({ unitFollow: "" }),
        title: following ? "Following this unit -- camera tracks it (pan or Esc to stop)"
                         : "Follow this unit (camera tracks it until you pan or press Esc)",
      });
    // A control that cannot resolve a coordinate is OMITTED, not drawn disabled: a disabled tile
    // advertises a jump native would actually make.
    const lower = [];
    if (unitHasTile(unit, data))
      lower.push({ sprite: S.expel, glyphBox: { cols: 4, rows: 3 },
        dataset: tile({ unitRecenter: "" }), title: "Zoom to this unit" });
    return lower.length ? [upper, lower] : [upper];
  }
  // `data.tile` is the authority at render time; the live client position wins at CLICK time.
  function unitHasTile(unit, data) {
    const t = (data && data.tile) || (unit && unit.tile) || null;
    return !!t && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y)) && Number.isFinite(Number(t.z));
  }
  function unitSheetMarkup(data, options = {}) {
    const unit = data?.unit || {};
    const tab = options.tab || "Overview";
    const detailTabs = unitDetailTabs(tab);
    const detail = detailTabs.includes(options.detail) ? options.detail : (detailTabs[0] || null);
    // The flag chips are gone, but the ARRAY is load-bearing: it feeds the Overview "Groups" cell.
    const flags = Array.isArray(unit.flags) ? unit.flags : [];
    const sexSymbol = unit.sex === "female" ? "&#9792;" : (unit.sex === "male" ? "&#9794;" : "?");
    const training = unit.training ? `<div class="subtle">${escapeHtml(unit.training)}</div>` : "";
    // The body is a TABLE of cells and the GRID owns the dividers: a cell states no border, so there
    // is exactly one frame between it and the window.
    const cell = (cls, html) => DWFUI.gridCellHtml({ cls }, html);
    const overviewGrid = DWFUI.gridHtml({ cls: "unit-grid" }, [
      cell("unit-cell", `<div>${escapeHtml(unit.age || "Age unknown")}, ${sexSymbol}</div>${training}${renderUnitOverviewRelations(unit)}`),
      cell("unit-cell", renderUnitOverviewValues(unit)),
      cell("unit-cell", renderUnitStatusWords(unit)),
      cell("unit-cell", renderUnitOverviewLines(unit, unitOverviewLines(unit, "overviewPositionLines", flags), "Groups")),
      cell("unit-cell", renderUnitOverviewActivity(unit)),
      cell("unit-cell", renderUnitOverviewMilitary(unit)),
      cell("unit-cell", renderUnitOverviewSkills(unit, "Labor", 6)),
      cell("unit-cell", renderUnitOverviewNeeds(unit)),
      DWFUI.gridCellHtml({ cls: "unit-cell wide", wide: true,
        dataset: { dwfuiScrollKey: unitSheetScrollKey(unit, tab, detail) } },
        renderUnitOverviewQuote(unit) + (renderUnitOverviewThoughts(unit) ||
        `<div class="unit-cell-line subtle">No recent thoughts recorded.</div>`)),
    ].join(""));
    const scrollKey = unitSheetScrollKey(unit, tab, detail);
    const bodyHtml = tab === "Overview" ? overviewGrid : renderUnitTabBody(unit, tab, detail, scrollKey);
    const nicknameEditor = options.nicknameEditing ? unitNicknameEditorMarkup(unit, options.nicknameStatus || "") : "";
    // Native's customize is an IN-PLACE swap of the identity block, so the editor lives in that cell.
    const fittedIdentityLine = (cls, text, attrs = "") =>
      `<div class="${cls}"${attrs}>${DWFUI.bitmapTextHtml(text, {
        cls: "unit-sheet-identity-label", fitNativeLabel: { host: "parent" },
      })}</div>`;
    const identity = fittedIdentityLine("unit-name-line",
      unitNameLine(unit) || data?.title || "Unit", unitNameColorStyle(unit)) +
      `${unit.nickname ? fittedIdentityLine("unit-nickname-line", `"${unit.nickname}"`) : ""}` +
      `${fittedIdentityLine("unit-job-line", unitActivityLine(unit))}${nicknameEditor}`;
    const header = DWFUI.headerHtml({
      variant: "unit",
      cls: "unit-sheet-header",   // .unit-sheet-header is PanelFrame's adoptHeadSel target
      close: false,
      // The compositor box is 12x6 cells and the portrait texture is 12x8; keeping them distinct
      // siblings stops the frame table stretching to the artwork's extent.
      icon: `<div class="unit-portrait-slot">${window.unitPortraitMarkup(unit)}` +
        DWFUI.frameNineSlice({ family: "pictureBox", cols: 12, rows: 6, cls: "unit-portrait-frame" }) + `</div>`,
      titleHtml: identity,
      toolRows: unitHeaderToolRows(unit, data),
    });
    // Native uses eleven fixed tab hitboxes across two bands, with content beginning after row four.
    const tabs = DWFUI.tabsHtml({
      level: "primary", cellGrid: { cols: 59, rows: 4 }, gapCells: 0, fitLabels: true, dataAttr: "unit-tab",
      ariaLabel: "Unit profile tabs",
      tabs: UNIT_PRIMARY_TABS.map(label => {
        const [x, y, w, h] = UNIT_PRIMARY_TAB_GEOMETRY[label];
        return { key: label, label, x, y, w, h };
      }),
      active: tab,
    });
    const subtabs = detailTabs.length
      ? DWFUI.tabsHtml({
        level: "subtab", gapCells: 0, dataAttr: "unit-detail-tab", ariaLabel: "Unit profile subtabs",
        tabs: detailTabs.map(label => ({ key: label, label })),
        active: detail,
      })
      : "";
    const sheetBody = `
      ${header}
      ${tabs}
      ${subtabs}
      ${bodyHtml}
    `;
    return DWFUI.windowHtml({ cls: "unit-sheet", nativeFrame: "viewSheet", bodyHtml: sheetBody });
  }

  function renderUnitSheet() {
    const data = selectedUnitData || {};
    const unit = data.unit || {};
    // The subtab normalisation below is NOT dead: it mutates the module-level activeUnitDetailTab
    // that unitSheetMarkup then reads.
    const detailTabs = unitDetailTabs(activeUnitTab);
    if (detailTabs.length && !detailTabs.includes(activeUnitDetailTab))
      activeUnitDetailTab = detailTabs[0];
    if (!detailTabs.length)
      activeUnitDetailTab = null;
    selection.className = "visible view-sheet-panel unit-sheet-panel";
    // NOT a bare `innerHTML =`: that destroys the decoded portrait <img> and re-requests it, which is
    // the letter/art flicker. renderPreservingPortraits detaches and re-attaches in one task.
    window.renderPreservingPortraits(panelContent(selection),
      () => unitSheetMarkup(data, { tab: activeUnitTab, detail: activeUnitDetailTab }));
    DWFUI.restoreScroll(selection);
    // UI-DIV-004: re-fit from the immutable full captions after every rebuild, and keep one observer
    // on the stable #selection host, so a drag abbreviates on whole bitmap cells.
    DWFUI.TextLaw.mountFitting(selection);
    selection.querySelectorAll("[data-unit-tab]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        activeUnitTab = button.dataset.unitTab || "Overview";
        activeUnitDetailTab = null;
        renderUnitSheet();
        focusPage();
      });
    });
    selection.querySelectorAll("[data-unit-detail-tab]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        activeUnitDetailTab = button.dataset.unitDetailTab || null;
        renderUnitSheet();
        focusPage();
      });
    });
    selection.querySelectorAll("[data-unit-relation-open]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.unitRelationOpen);
        if (Number.isInteger(id) && id >= 0 && typeof openUnitById === "function")
          openUnitById(id);
        focusPage();
      });
    });
    // Native's relation row carries a PAIR of trailing tiles: recenter, then view-item.
    selection.querySelectorAll("[data-unit-relation-recenter]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const id = Number(button.dataset.unitRelationRecenter);
        if (!Number.isInteger(id) || id < 0) return;
        const pos = window.liveUnitPos(id);
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
          await window.setCameraToMapPos(pos);
          flashMapTile(pos);
        }
        focusPage();
      });
    });
    selection.querySelectorAll("[data-unit-room-open]").forEach(el => {
      el.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const row = el.closest("[data-unit-room-category]") || el;
        const bid = Number(el.dataset.unitRoomOpen ?? row.dataset.unitRoomOpen ?? -1);
        const pos = {
          x: Number(row.dataset.roomX), y: Number(row.dataset.roomY), z: Number(row.dataset.roomZ),
        };
        openUnitRoom(bid, Number.isFinite(pos.x) ? pos : null);
      });
    });
    const nicknameButton = selection.querySelector("[data-unit-nickname]");
    if (nicknameButton) {
      nicknameButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (selection.querySelector("[data-unit-nickname-editor]")) return;
        const header = nicknameButton.closest(".unit-sheet-header");
        if (!header) return;
        const identity = header.querySelector(".dwfui-head-title") || header;
        const tools = header.querySelector(".dwfui-head-tools");
        if (tools) tools.hidden = true;
        identity.insertAdjacentHTML("beforeend", unitNicknameEditorMarkup(unit));
        const editor = header.querySelector("[data-unit-nickname-editor]");
        const nicknameInput = editor?.querySelector('input[aria-label="Unit nickname"]');
        const save = editor?.querySelector('.unit-nickname-save');
        const cancel = editor?.querySelector('[data-unit-nickname-cancel]');
        const status = editor?.querySelector('.unit-nickname-status');
        if (!editor || !nicknameInput || !save || !cancel || !status) return;
        nicknameInput.focus();
        cancel.addEventListener("click", () => {
          editor.remove();
          if (tools) tools.hidden = false;
        });
        editor.addEventListener("submit", async submitEvent => {
          submitEvent.preventDefault();
          const id = Number(unit.id);
          if (!Number.isInteger(id) || id < 0) return;
          save.disabled = true;
          status.textContent = "Saving…";
          try {
            const nicknameParams = new URLSearchParams({
              player, unit: String(id), nickname: nicknameInput.value.slice(0, 64),
            });
            const nicknameResponse = await fetch(`/unit-nickname?${nicknameParams}`, {
              method: "POST", cache: "no-store",
            });
            if (!nicknameResponse.ok) throw new Error("nickname update failed");
            const nicknameUpdated = await nicknameResponse.json();
            unit.nickname = String(nicknameUpdated.nickname || "");
            renderUnitSheet();
          } catch {
            save.disabled = false;
            status.textContent = "Could not save nickname.";
          }
        });
      });
    }
    const combatBtn = selection.querySelector("[data-unit-combatlog]");
    if (combatBtn) {
      combatBtn.addEventListener("click", event => {
        event.preventDefault();

        event.stopPropagation();
        const id = Number(unit.id);
        if (!Number.isInteger(id) || id < 0) return;
        window.DFAnnouncementMarkup?.openUnitCombatHistory({
          unitId: id,
          unitName: unit.name || data.title || "",
        });
        focusPage();
      });
    }
    // A one-shot jump through the shared recenter path, with no follow lock -- which is why it is a
    // separate control from the camera latch beside it.
    const recenter = selection.querySelector("[data-unit-recenter]");
    if (recenter) {
      recenter.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        const live = window.liveUnitPos(Number(unit.id));
        const t = live || data.tile || unit.tile || {};
        const pos = { x: Number(t.x), y: Number(t.y), z: Number(t.z) };
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
        if (typeof window.centerAndFlashMapPos === "function") await window.centerAndFlashMapPos(pos);
        else await window.setCameraToMapPos(pos);
        focusPage();
      });
    }
    const follow = selection.querySelector("[data-unit-follow]");
    if (follow) {
      // Re-render can blow the sheet DOM away mid-follow; restore the latched state + tooltip.
      window.markFollowButton(profileFollowId() === Number(unit.id));
      follow.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (profileFollowId() === Number(unit.id)) {
          window.stopUnitFollow();
          focusPage();
          return;
        }
        // Prefer the live client-side position; fall back to the sheet's own tile.
        const live = window.liveUnitPos(Number(unit.id));
        const tile = live || data.tile || {};
        const pos = { x: Number(tile.x), y: Number(tile.y), z: Number(tile.z) };
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
          // Engage follow before the tile flash: the flash is a fire-and-forget cue and must not delay
          // the lock by the length of its animation.
          await window.setCameraToMapPos(pos);
          window.startUnitFollow(Number(unit.id), pos);
          flashMapTile(pos);
        }
        focusPage();
      });
    }
    // Portrait generation is a click on the portrait itself, not an invented header button.
    const portraitBox = selection.querySelector(".unit-sheet-header .unit-portrait");
    const nativePortraitCapable = unit.portraitKind === "native" ||
      (!unit.portraitKind && window.nativePortraitState(unit) !== "unavailable");
    if (portraitBox && unitImagesEnabled && nativePortraitCapable) {
      portraitBox.classList.add("unit-portrait-clickable");
      // The sheet header doubles as the drag handle, so the clickable portrait opts out explicitly.
      portraitBox.setAttribute("data-pf-nodrag", "1");
      portraitBox.title = "Click to generate a portrait";
      portraitBox.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        window.generateUnitPortrait(unit);
      });
    }
    if (portraitBox && window.shouldAutoGeneratePortrait(unit)) {
      const genId = Number(unit.id);
      window.__dfcPortraitAutoGenerated.add(genId);
      window.generateUnitPortrait(unit, { keepCurrent: true });
      if (window.nativePortraitState(unit) !== "ready")
        window.setTimeout(() => {
          if (window.nativePortraitState(unit) !== "ready") window.__dfcPortraitAutoGenerated.delete(genId);
        }, 15000);
    }
    // Warm the composite-sprite snapshot for units that just left the viewport.
    window.refreshUnitSpriteSnapshot();
    // Populate the Labor > Work details sub-tab, async, over /labor*.
    const wdBox = selection.querySelector("[data-unit-workdetails]");
    if (wdBox) loadUnitWorkDetails(unit, wdBox);
  }

  function unitDetailTabs(tab) {
    return ({
      Skills: ["Labor", "Combat", "Social", "Other skills", "Knowledge"],
      Personality: ["Traits", "Values", "Preferences", "Needs"],
      Thoughts: ["Recent thoughts", "Memories"],
      Labor: ["Work details", "Workshops", "Locations", "Work animals"],
      Health: ["Status", "Wounds", "Treatment", "History", "Description"],
      Military: ["Squad", "Uniform", "Kills"]
    }[tab] || []);
  }

  // Health lines arrive with a leading [C:...] colour token, and the empty-state match below compares
  // SENTENCES -- strip the markup first or every health empty state loses its native treatment.
  function stripDfMarkup(line) {
    return String(line == null ? "" : line).replace(/\[[^\]]*\]/g, "").trim();
  }

  // Native's empty state is ONE plain white sentence: never a boxed row, a centred card, or italic grey.
  function isNativePlainEmpty(tab, detail, line) {
    line = stripDfMarkup(line);
    if (tab === "Personality") return line === "No personality information.";
    // The Wounds tab has TWO empty states: "No evaluated wounds" means nobody has examined this
    // dwarf, "No injuries" means genuinely unhurt. Neither is the other.
    if (tab === "Health" && detail === "Wounds")
      return line === "No evaluated wounds" || line === "No injuries";
    return ({
      Health: {
        Treatment: "No treatment scheduled",
        History: "No medical history"
      },
      Labor: {
        Workshops: "No dedicated workshop assignments",
        Locations: "No location assignments",
        "Work animals": "No assigned or assignable work animals"
      },
      // Native REUSES one string across the first two Military sub-tabs: Uniform's empty state is also
      // "No squad assigned", because the reason the list is empty is that there is no squad.
      Military: { Squad: "No squad assigned", Uniform: "No squad assigned" }
    }[tab] || {})[detail] === line;
  }

  // ---- the scroll host ---------------------------------------------------------------------------
  function unitSheetScrollKey(unit, tab, detail) {
    return `unit-profile:${Number(unit && unit.id)}:${tab}:${detail || ""}`;
  }
  function unitScrollAttr(key) {
    return key ? ` data-dwfui-scroll-key="${DWFUI.esc(key)}"` : "";
  }
  // A list of whole rows: the viewport never shows a row cut in half.
  function unitRowsHtml(cls, scrollKey, rows, empty) {
    return DWFUI.scrollHtml({ cls, rows: ".dwfui-row", preserveKey: scrollKey },
      rows || `<div class="dwfui-text--empty">${escapeHtml(empty || "")}</div>`);
  }
  function unitTabScrollHtml(cfg, innerHtml) {
    return DWFUI.scrollHtml({
      cls: `unit-tab-scroll${cfg && cfg.cls ? " " + cfg.cls : ""}`,
      rows: ".unit-list-row",
      ariaLabel: cfg && cfg.ariaLabel,
      preserveKey: cfg && cfg.preserveKey,
    }, innerHtml);
  }

  // Native draws an empty tab, Health status and the description as plain lines, and every other
  // list as one entry per row with no rule between rows.
  function renderUnitListGrid(tab, detail, lines, options, scrollKey) {
    const values = Array.isArray(lines) ? lines : [];
    const scroll = !(options && options.scroll === false);
    const plain = values.length === 0 ||
      (tab === "Health" && ["Status", "Description"].includes(detail || "Status")) ||
      (values.length === 1 && isNativePlainEmpty(tab, detail, values[0]));
    if (plain) {
      const text = (values.length ? values : ["No entries."]).map(line =>
        `<p class="unit-text-line">${colorizeUnitLine(line, tab, detail)}</p>`).join("");
      return scroll ? `<div class="unit-text-block"${unitScrollAttr(scrollKey)}>${text}</div>` : text;
    }
    const grid = DWFUI.gridHtml({ cls: "unit-list-grid" }, values.map(line =>
      DWFUI.gridCellHtml({ cls: "unit-list-row" }, colorizeUnitLine(line, tab, detail))).join(""));
    if (!scroll) return grid;
    return unitTabScrollHtml({ ariaLabel: detail ? `${tab} ${detail}` : tab, preserveKey: scrollKey }, grid);
  }

  function structuredOrder(records) {
    return records.map((record, index) => ({ record, index })).sort((a, b) => {
      const ao = Number(a.record && a.record.order);
      const bo = Number(b.record && b.record.order);
      const av = Number.isFinite(ao) ? ao : a.index;
      const bv = Number.isFinite(bo) ? bo : b.index;
      return av - bv || a.index - b.index;
    }).map(entry => entry.record);
  }

  function relationColorClass(role) {
    const value = String(role || "friend").toLowerCase();
    return ["family", "deity", "friend"].includes(value) ? ` unit-relation-${value}` : " unit-relation-friend";
  }

  // A deity row has no portrait tile and no trailing controls; its empty column keeps the name in line.
  function renderUnitRelations(unit, scrollKey) {
    if (!Array.isArray(unit && unit.relations))
      return renderUnitListGrid("Relations", null, unit && unit.relationLines, null, scrollKey);
    const S = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
    const rows = structuredOrder(unit.relations).filter(relation => relation && relation.name).map(relation => {
      const uid = Number(relation.unitId);
      const live = Number.isInteger(uid) && uid >= 0;
      const deity = String(relation.colorRole || "").toLowerCase() === "deity";
      // The trailing pair is self-framed, so it takes no generic button chassis.
      const trailing = live
        ? DWFUI.actionButtonsHtml([
          {
            action: "recenter", sprite: S.recenterStocks,
            dataset: { unitRelationRecenter: uid },
            title: `Center the view on ${relation.name}`,
          },
          {
            action: "view", sprite: S.view,
            dataset: { unitRelationOpen: uid },
            title: "Open this unit", ariaLabel: `Open ${relation.name}`,
          },
        ], { cls: "unit-relation-actions", btnCls: "unit-structured-action" })
        : "";
      return DWFUI.rowHtml({
        chassis: "table",
        cls: `unit-structured-row unit-relation-row${deity ? " unit-relation-row-deity" : ""}`,
        icon: `<div class="unit-structured-portrait">${deity ? "" : window.unitPortraitMarkup(relation, "unit-relation-portrait")}</div>`,
        // Both vocabularies on purpose: the DWFUI chassis classes carry layout and type, the pinned
        // unit-structured-* names carry the semantic colour roles. Dropping either is a regression.
        copyCls: "unit-structured-copy",
        labelCls: "unit-structured-line",
        labelHtml: `<span${unitProfessionColorAttrs(relation, `unit-relation-name${relationColorClass(relation.colorRole)}`)}>` +
          `${DWFUI.bitmapTextHtml(relation.name || "")}</span>` +
          (relation.profession ? `<span class="unit-relation-profession">` +
            `${DWFUI.bitmapTextHtml(`, ${relation.profession}`)}</span>` : ""),
        sub: { cls: "unit-structured-subline", text: relation.label || "Relation" },
        trailing,
      });
    }).join("");
    return unitRowsHtml("unit-structured-list unit-relations-list", scrollKey, rows, "No relationships recorded.");
  }

  // Native prints the category right-aligned on the name line.
  function renderUnitGroups(unit, scrollKey) {
    if (!Array.isArray(unit && unit.groups))
      return renderUnitListGrid("Groups", null, unit && unit.groupLines, null, scrollKey);
    const rows = structuredOrder(unit.groups).filter(group => group && group.entityName).map(group =>
      DWFUI.rowHtml({
        chassis: "table",
        cls: "unit-structured-row unit-group-row",
        copyCls: "unit-structured-copy",
        labelCls: "unit-group-label",
        labelHtml: `<span class="unit-group-name">${DWFUI.bitmapTextHtml(group.entityName, { fitNativeLabel: { host: "parent" } })}</span>` +
          `<span class="unit-group-category">${DWFUI.bitmapTextHtml(group.category || "Group")}</span>`,
        sub: { cls: "unit-group-status", text: group.status || "Member" },
      })).join("");
    return unitRowsHtml("unit-structured-list unit-groups-list", scrollKey, rows, "No group memberships.");
  }

  const UNIT_ROOM_CATEGORIES = ["Study", "Quarters", "Dining Room", "Tomb"];

  function renderUnitRooms(unit, scrollKey) {
    if (!Array.isArray(unit && unit.rooms))
      return renderUnitListGrid("Rooms", null, unit && unit.roomLines, null, scrollKey);
    const S = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
    const roomSprites = {
      Study: { good: S.noblesOfficeGood, missing: S.noblesOfficeMissing },
      Quarters: { good: S.noblesBedroomGood, missing: S.noblesBedroomMissing },
      "Dining Room": { good: S.noblesDiningGood, missing: S.noblesDiningMissing },
      Tomb: { good: S.noblesTombGood, missing: S.noblesTombMissing },
    };
    const byCategory = new Map(unit.rooms.filter(Boolean).map(room => [String(room.category || ""), room]));
    const rows = UNIT_ROOM_CATEGORIES.map(category => {
      const room = byCategory.get(category) || { category, assigned: false };
      const label = room.assigned ? (room.quality || room.name || category) : `No ${category}`;
      const sprite = roomSprites[category] && roomSprites[category][room.assigned ? "good" : "missing"];
      const bid = Number(room.buildingId ?? -1);
      const clickable = !!room.assigned && Number.isInteger(bid) && bid >= 0;
      const cx = Number(room.centerX), cy = Number(room.centerY), cz = Number(room.centerZ);
      const hasPos = Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz) && cx >= 0 && cy >= 0;
      const dataset = { unitRoomCategory: category };
      if (clickable) {
        dataset.unitRoomOpen = bid;
        if (hasPos) { dataset.roomX = cx; dataset.roomY = cy; dataset.roomZ = cz; }
      }
      const trailing = clickable
        ? DWFUI.actionButtonsHtml(
            [{ action: "follow", sprite: DWFUI.TOKENS.sprites.recenter,
               dataset: { unitRoomOpen: bid }, title: "Zoom to this room and open it" }],
            { cls: "unit-room-actions", btnCls: "unit-structured-action" })
        : "";
      return DWFUI.rowHtml({
        chassis: "table",
        cls: `unit-structured-row unit-room-row${room.assigned ? " assigned" : " unassigned"}${clickable ? " clickable" : ""}`,
        dataset,
        role: clickable ? "button" : undefined,
        title: clickable ? "View this room" : undefined,
        icon: sprite ? DWFUI.iconHtml({ sprite, nativeCell: true, cls: "unit-room-art", alt: "" }) : "",
        label,
        copyCls: "unit-structured-copy unit-room-copy",
        labelCls: "unit-room-name",
        trailing,
      });
    }).join("");
    return unitRowsHtml("unit-structured-list unit-rooms-list", scrollKey, rows);
  }

  // *** THE ASSIGNMENT-CLASS INDICATOR IS NOT RENDERED (DEF-034). *** The wire ships a body-slot
  // `role`, never the assignment class; deriving one from the other would be fabricated UI.
  function renderUnitInventory(unit, scrollKey) {
    if (!Array.isArray(unit && unit.inventory))
      return renderUnitListGrid("Items", null, unit && unit.inventoryLines, null, scrollKey);
    const rows = unit.inventory.filter(record => record && record.name).map(record =>
      DWFUI.rowHtml({
        chassis: "table",
        cls: "unit-structured-row unit-inventory-row",
        copyCls: "unit-structured-copy",
        labelCls: "unit-inventory-name",
        label: `(${record.name})`,
        sub: { cls: "unit-inventory-location",
          text: record.bodyPartName || record.role || "Carried" },
      })).join("");
    return unitRowsHtml("unit-structured-list unit-inventory-list", scrollKey, rows, "No inventory items.");
  }

  function unitSpanClass(role) {
    const value = String(role || "neutral").toLowerCase();
    return ({
      positive: "positive", negative: "negative", warning: "warning", attention: "attention",
      "personal-positive": "personal-positive", "personal-negative": "personal-negative",
      dream: "dream", "emotion-positive": "emotion-positive", "emotion-negative": "emotion-negative",
      "emotion-neutral": "emotion-neutral", memory: "memory", form: "form", work: "work"
    })[value] || "neutral";
  }

  // A served native colour index (0..15) is AUTHORITATIVE and drives hue via DWFUI.dfColor. With no
  // index, do not stamp an inline inherit that defeats the role class.
  function unitSpanColorStyle(span) {
    const idx = span && span.color;
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }
  // DEF-074: the preference join can expose a resolver sentinel such as `iNVALID:554:-1 fish`.
  // Player-facing prose must never print an engine token.
  function honestUnitNarrativeText(value) {
    return String(value == null ? "" : value)
      .replace(/\binvalid:-?\d+:-?\d+(?:\s+([a-z][a-z-]*))?/gi,
        (_, hint) => `unidentified ${String(hint || "preference").toLowerCase()}`);
  }
  function unitProfessionColorAttrs(record, baseClass = "") {
    const idx = record && record.professionColor;
    // A dead relation has no served colour: never apply the old profession hue or the legacy role CSS.
    const inherit = (record && record.dead) || !Number.isInteger(idx) || idx < 0 || idx > 15;
    const className = `${baseClass}${inherit ? `${baseClass ? " " : ""}unit-profession-color-inherit` : ""}`;
    return `${className ? ` class="${className}"` : ""}${inherit ? "" : ` style="color:${DWFUI.dfColor(idx)}"`}`;
  }
  function renderUnitSpans(spans) {
    return (Array.isArray(spans) ? spans : []).map(span =>
      `<span class="unit-prose-${unitSpanClass(span && span.role)}"${unitSpanColorStyle(span)}>${escapeHtml(honestUnitNarrativeText(span && span.text || ""))}</span>`
    ).join("");
  }

  function renderUnitProse(paragraphs, emptyText = "No entries.", scrollKey) {
    const values = Array.isArray(paragraphs) ? paragraphs : [];
    const rendered = values.map(paragraph => {
      const spans = paragraph && Array.isArray(paragraph.spans) ? paragraph.spans : [];
      return spans.length ? `<p class="unit-prose-paragraph">${renderUnitSpans(spans)}</p>` : "";
    }).join("");
    // The empty prose must not carry the grey `.unit-list-empty`; `unit-prose-empty` leaves it native white.
    return `<div class="unit-prose-block"${unitScrollAttr(scrollKey)}>${rendered || `<p class="unit-prose-paragraph unit-prose-empty">${escapeHtml(emptyText)}</p>`}</div>`;
  }

  function renderUnitSkills(unit, detail, scrollKey) {
    if (detail === "Knowledge") {
      if (!Array.isArray(unit && unit.knowledge))
        return renderUnitListGrid("Skills", detail, [], null, scrollKey);
      const rows = structuredOrder(unit.knowledge).filter(record => record && record.title).map(record =>
        DWFUI.rowHtml({
          chassis: "table",
          cls: "unit-knowledge-row",
          labelCls: "unit-knowledge-title",
          label: record.title,
          sub: { cls: `unit-prose-${unitSpanClass(record.colorRole)}`, text: record.subtype || "Knowledge" },
          trailing: DWFUI.artBtnHtml({
            sprite: DWFUI.TOKENS.sprites.view, cls: "unit-knowledge-action", placeholder: true,
            dataset: { unitKnowledgeDetail: record.detailTarget || `${record.type || "knowledge"}:${record.id}` },
            title: "Knowledge details are not implemented yet -- no server route exists for this " +
              "record. The control is kept so the wire is ready; it does nothing today.",
            ariaLabel: `View ${record.title}`,
          }),
        })).join("");
      return unitRowsHtml("unit-knowledge-list", scrollKey, rows, "No knowledge recorded.");
    }
    if (!Array.isArray(unit && unit.skills)) {
      const legacy = detail === "Labor" ? unit && unit.skillLines : [];
      return renderUnitListGrid("Skills", detail, legacy, null, scrollKey);
    }
    const rows = structuredOrder(unit.skills).filter(skill => skill && skill.category === detail).map(skill =>
      DWFUI.rowHtml({
        chassis: "table",
        cls: "unit-skill-row",
        labelCls: `unit-skill-${escapeHtml(skill.colorRole || "skill-0")}`,
        labelHtml: `<span class="unit-skill-caption"${skillCaptionColorStyle(skill)}>` +
          `${DWFUI.bitmapTextHtml(`${skill.ratingCaption || "Dabbling"} ${skill.caption || "Skill"}`)}</span>` +
          (skill.rusty ? `<span class="unit-skill-rust">${DWFUI.bitmapTextHtml(" (Rusty)")}</span>` : ""),
      })).join("");
    return unitRowsHtml("unit-skill-list", scrollKey, rows, `No ${String(detail || "notable").toLowerCase()} skills.`);
  }

  // A skill row is coloured by the SKILL's profession colour, served as skill.color (0..15).
  // Absent on older hosts -> plain.
  function skillCaptionColorStyle(skill) {
    const idx = skill && skill.color;
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }

  function renderUnitPersonality(unit, detail, scrollKey) {
    const narrative = unit && unit.personalityNarrative;
    const key = String(detail || "Traits").toLowerCase();
    if (!narrative || !Array.isArray(narrative[key]))
      return null;
    const paragraphs = key === "traits"
      ? narrative[key].map(normalizeMannerismParagraph)
      : narrative[key];
    return renderUnitProse(paragraphs, `No ${key} recorded.`, scrollKey);
  }

  // DEF-075: mannerisms arrive as title-cased enum keys split from their pronoun; an unknown enum
  // becomes explicit prose, never a plausible-looking fabrication.
  function normalizeMannerismParagraph(paragraph) {
    const spans = Array.isArray(paragraph && paragraph.spans) ? paragraph.spans : [];
    const subject = (spans.map(span => span && span.text || "").join("").match(/\b(He|She|They|It)\b/) || [])[1] || "They";
    const possessive = ({ He: "his", She: "her", They: "their", It: "its" })[subject] || "their";
    const contraction = ({ He: "he's", She: "she's", They: "they're", It: "it's" })[subject] || "they're";
    const mannerisms = {
      "chews cheek": `chews ${possessive} cheek`,
      "conversation interrupts others": "interrupts others during conversation",
      "eyes winks": "winks",
      "fingers point": `points with ${possessive} fingers`,
      "posture rigid": "stands rigid",
    };
    const situations = {
      angry: `when ${contraction} angry`,
      bored: `when ${contraction} bored`,
      greeting: "when greeting others",
      nervous: `when ${contraction} nervous`,
      thinking: "when thinking",
    };
    return {
      ...paragraph,
      spans: spans.map(span => {
        const text = String(span && span.text || "");
        const match = text.match(/^(.+?)\s+When\s+(.+)$/);
        if (!match) return span;
        const behavior = mannerisms[match[1].toLowerCase()];
        const situation = situations[match[2].toLowerCase()] || `when ${match[2].toLowerCase()}`;
        return {
          ...span,
          text: behavior ? `${behavior} ${situation}` : `has an unclassified mannerism ${situation}`,
        };
      }),
    };
  }

  // DEF-076: the thought wire still leaks event enum fragments. Repair only the provable grammar
  // seams and name an unresolved event honestly.
  function normalizeThoughtSpans(spans) {
    const values = (Array.isArray(spans) ? spans : []).map(span => ({
      ...span,
      text: honestUnitNarrativeText(span && span.text || "")
        .replace(/\ba acquaintance\b/g, "an acquaintance")
        .replace(/\bafter eating the event\b/g, "after eating")
        .replace(/\bdue to the event\b/g, "because of an unresolved event")
        .replace(/\bperforming the rites of the event\b/g, "performing religious rites")
        .replace(/\s+for the event\b/g, ""),
    }));
    for (let i = 0; i + 1 < values.length; i++) {
      if (unitSpanClass(values[i] && values[i].role) !== "memory" ||
          !/\bremembering\b/i.test(values[i] && values[i].text || ""))
        continue;
      values[i + 1].text = String(values[i + 1].text || "")
        .replace(/^ after\b/i, "")
        .replace(/^ upon\b/i, "")
        .replace(/^ Defended site against invaders\b/i, " defending the site against invaders")
        .replace(/^ saw somebody's dead body\b/i, " seeing somebody's dead body");
    }
    return values;
  }

  function renderUnitThoughts(unit, detail, scrollKey) {
    const thoughts = unit && unit.thoughts;
    if (!thoughts || typeof thoughts !== "object")
      return null;
    const key = detail === "Memories" ? "memories" : "recent";
    const records = Array.isArray(thoughts[key]) ? structuredOrder(thoughts[key]) : [];
    // Native draws one flowing prose block, not a stack with paragraph margins between every entry.
    const spans = [];
    records.forEach((record, index) => {
      if (index) spans.push({ text: " ", role: "neutral" });
      spans.push(...normalizeThoughtSpans(record && record.spans));
    });
    const paragraphs = spans.length ? [{ spans }] : [];
    return renderUnitProse(paragraphs, key === "memories" ? "No memories recorded." : "No recent thoughts recorded.", scrollKey);
  }

  const UNIT_LABOR_ROW_SEL = ".unit-wd-row,.unit-list-row,.unit-structured-row";

  function renderUnitWorkDetailsTab(unit, detail = "Work details", scrollKey) {
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));
    return DWFUI.scrollHtml({
      cls: "unit-tab-scroll unit-workdetails",
      rows: UNIT_LABOR_ROW_SEL,
      ariaLabel: `Labor ${detail}`,
      dataset: { unitWorkdetails: uid, unitLaborDetail: detail },
      preserveKey: scrollKey,
    }, `<div class="dwfui-text--empty unit-list-row unit-list-empty">Loading work details&#8230;</div>`);
  }

  let unitLaborSnapshot = null;
  let unitLaborSnapshotPromise = null;

  async function fetchUnitLaborSnapshot() {
    if (unitLaborSnapshot) return unitLaborSnapshot;
    if (!unitLaborSnapshotPromise) {
      unitLaborSnapshotPromise = fetch(`/labor?detail=0&t=${Date.now()}`, { cache: "no-store" })
        .then(r => {
          if (!r.ok) throw new Error("labor fetch failed");
          return r.json();
        })
        .then(data => (unitLaborSnapshot = data))
        .finally(() => { unitLaborSnapshotPromise = null; });
    }
    return unitLaborSnapshotPromise;
  }

  async function loadUnitWorkDetails(unit, box) {
    if (!box) return;
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));
    if (!Number.isFinite(uid) || uid < 0) {
      box.innerHTML = `<div class="dwfui-text--empty unit-list-row unit-list-empty">No unit selected.</div>`;
      return;
    }
    try {
      renderUnitWorkDetails(unit, box, await fetchUnitLaborSnapshot());
    } catch {
      box.innerHTML = `<div class="dwfui-text--empty unit-list-row unit-list-empty">Work details unavailable.</div>`;
    }
  }

  // Native's checkbox is a COMPLETE sprite in BOTH states, so an unchecked detail draws the real dark
  // tile, never nothing. The check is a CELL of the row; only the row carries the toggle wire.
  function unitWorkDetailCheckHtml(checked) {
    return DWFUI.checkHtml({ checked, cls: "unit-wd-check-tile", ariaLabel: checked ? "Assigned" : "Not assigned" });
  }
  function unitWorkDetailRow(d, checked) {
    const icon = DWFUI.workDetailIconHtml(d.iconKey, { alt: d.name || "Work detail" }) ||
      `<span class="unit-wd-icon-blank"></span>`;
    return DWFUI.rowHtml({
      chassis: "table",
      cls: `unit-wd-row${checked ? " on" : ""}`,
      dataset: { unitWdToggle: Number(d.index), on: checked ? 1 : 0 },
      title: `Toggle this dwarf's membership in the ${d.name} work detail`,
      icon: `<span class="unit-wd-icon-slot">${icon}</span>`,
      copyCls: "unit-wd-copy",
      labelCls: "unit-wd-name",
      label: d.name,
      cells: [{ cls: `unit-wd-check${checked ? " on" : ""}`, html: unitWorkDetailCheckHtml(checked) }],
    });
  }

  // Two states, two different icons (green "works anywhere", red "only assigned jobs"), so this is a
  // latch, not a check. Ctrl+z is the one hotkey native attests for it; never fabricate another.
  const UNIT_SPECIALIST_TEXT = {
    on: "Will not do tasks unless assigned",
    off: "Will do available tasks anywhere",
  };
  function unitSpecialistText(specialist) {
    return specialist ? UNIT_SPECIALIST_TEXT.on : UNIT_SPECIALIST_TEXT.off;
  }
  function unitSpecialistLatchHtml(specialist) {
    const S = (window.DWFUI && DWFUI.TOKENS && DWFUI.TOKENS.sprites) || {};
    return DWFUI.latchHtml({
      on: !!specialist,
      cls: "unit-wd-anywhere-icon",
      sprite: S.workerAny,          // OFF -> the green "will work anywhere" tile
      activeSprite: S.workerOnly,   // ON  -> the red "only assigned jobs" tile
      hotkey: "Ctrl+z",
      title: unitSpecialistText(specialist),
      ariaLabel: unitSpecialistText(specialist),
    });
  }

  function renderUnitLaborAnimals(unit) {
    const animals = Array.isArray(unit && unit.laborWorkAnimals) ? structuredOrder(unit.laborWorkAnimals) : null;
    // scroll:false -- `.unit-workdetails` above this is already the tab's scroll host.
    if (animals === null)
      return renderUnitListGrid("Labor", "Work animals", unit && unit.laborWorkAnimalLines, { scroll: false });
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));
    const rows = animals.filter(animal => animal && animal.name).map(animal => {
      const assigned = animal.assignmentState === "assigned";
      const blocked = !animal.assignable && !!animal.blockedReason;
      const action = blocked
        ? `<span class="unit-labor-animal-blocked" title="${DWFUI.esc(animal.blockedReason)}">${DWFUI.bitmapTextHtml("Locked")}</span>`
        : DWFUI.plaqueBtnHtml({
            label: assigned ? "Remove" : "Assign",
            tone: assigned ? "red" : "green",
            chassis: "slab",
            cls: "unit-labor-animal-btn",
            dataset: { unitWorkAnimal: animal.unitId, unitWorkAnimalOwner: assigned ? -1 : uid },
            title: assigned
              ? "Remove this work-animal assignment"
              : "Assign this animal as this citizen's work animal",
          });
      return DWFUI.rowHtml({
        chassis: "table",
        cls: `unit-structured-row unit-labor-animal-row ${assigned ? "assigned" : "assignable"}${blocked ? " blocked" : ""}`,
        icon: `<div class="unit-structured-portrait">${window.unitPortraitMarkup(animal, "unit-relation-portrait")}</div>`,
        copyCls: "unit-structured-copy",
        labelCls: "unit-structured-line unit-labor-animal-name",
        label: animal.name,
        sub: { cls: "unit-structured-subline", text: animal.trainingType || "Animal training" },
        cells: [
          { cls: "unit-labor-animal-state",
            html: DWFUI.bitmapTextHtml(assigned ? "Assigned" : (blocked ? "Blocked" : "Assignable")) },
          { cls: "unit-labor-animal-action", html: action },
        ],
      });
    }).join("");
    const status = `<div id="unitWorkAnimalStatus" class="unit-labor-animal-status" role="status" aria-live="polite"></div>`;
    return rows ? `<div class="unit-structured-list unit-labor-animal-list">${rows}${status}</div>` :
      renderUnitListGrid("Labor", "Work animals", ["No assigned or assignable work animals"], { scroll: false });
  }

  function renderUnitLaborPanel(unit, detail, data) {
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));
    const details = Array.isArray(data && data.details) ? data.details : [];
    const rows = Array.isArray(data && data.rows) ? data.rows : [];
    const myRow = rows.find(r => Number(r.id) === uid) || null;
    if (!myRow)
      return `<div class="dwfui-text--empty unit-list-row unit-list-empty">Only fortress citizens can be assigned work details.</div>`;
    const membership = new Set(String(myRow.assignedTo || "").split(", ").map(s => s.trim()).filter(Boolean));
    const specialist = !!myRow.specialist;
    const headText = unitSpecialistText(specialist);
    const headRow = DWFUI.rowHtml({
      chassis: "table",
      cls: `unit-wd-row unit-wd-header${specialist ? " specialist" : ""}`,
      dataset: { unitWdSpec: uid, on: specialist ? 1 : 0 },
      title: "Toggle whether this dwarf only works its assigned work details",
      icon: `<span class="unit-wd-icon-slot">${unitSpecialistLatchHtml(specialist)}</span>`,
      copyCls: "unit-wd-copy",
      labelCls: "unit-wd-name",
      label: headText,
    });
    let body;
    if (detail === "Work details") {
      const list = details.map(d => unitWorkDetailRow(d, membership.has(d.name))).join("");
      body = list || `<div class="dwfui-text--empty unit-list-row unit-list-empty">No work details defined.</div>`;
    } else if (detail === "Work animals") {
      body = renderUnitLaborAnimals(unit);
    } else {
      const laborLines = {
        Workshops: unit.laborWorkshopLines,
        Locations: unit.laborLocationLines
      }[detail];
      body = renderUnitListGrid("Labor", detail, laborLines, { scroll: false });
    }
    return `<div class="unit-wd-list">${headRow}${body}</div>`;
  }

  function renderUnitWorkDetails(unit, box, data) {
    const detail = box.dataset.unitLaborDetail || "Work details";
    box.innerHTML = renderUnitLaborPanel(unit, detail, data);
    wireUnitWorkDetails(unit, box);
  }

  function wireUnitWorkDetails(unit, box) {
    const uid = Number(unit && (unit.id ?? unit.unitId ?? -1));

    box.querySelectorAll("[data-unit-work-animal]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.busy === "1") return;
        const animalId = Number(button.dataset.unitWorkAnimal);
        const ownerId = Number(button.dataset.unitWorkAnimalOwner);
        const status = box.querySelector("#unitWorkAnimalStatus");
        button.dataset.busy = "1";
        button.disabled = true;
        try {
          const r = await fetch(
            `/livestock-action?unit=${animalId}&action=assign-work-animal&owner=${ownerId}&t=${Date.now()}`,
            { method: "POST", cache: "no-store" });
          const data = await r.json().catch(() => null);
          if (!r.ok || !data || data.ok === false)
            throw new Error((data && data.error) || "assignment failed");
          if (status) status.textContent = ownerId < 0 ? "Work animal removed." : "Work animal assigned.";
          // Re-read the truth through the sheet's own live-refresh path; never guess the new list.
          unitSheetRefreshId = uid;
          await unitSheetRefreshTick();
        } catch (err) {
          if (status) status.textContent = (err && err.message) || "Could not change the work-animal assignment.";
          button.disabled = false;
          if (typeof flashStatus === "function") flashStatus("Could not change the work-animal assignment.");
        } finally {
          button.dataset.busy = "";
        }
      });
    });

    box.querySelectorAll("[data-unit-wd-toggle]").forEach(row => {
      row.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (row.dataset.busy === "1") return;
        const detail = Number(row.dataset.unitWdToggle);
        const on = row.dataset.on === "1" ? 0 : 1;
        row.dataset.busy = "1";
        try {
          const r = await fetch(`/labor-toggle?detail=${detail}&unit=${uid}&on=${on}`, { method: "POST", cache: "no-store" });
          if (!r.ok) throw new Error("toggle failed");
          unitLaborSnapshot = null;
          row.dataset.on = String(on);
          row.classList.toggle("on", !!on);
          // Rebuild the check through the SAME builder, so OFF draws the real tile instead of blanking it.
          const check = row.querySelector(".unit-wd-check");
          if (check) { check.classList.toggle("on", !!on); check.innerHTML = unitWorkDetailCheckHtml(!!on); }
        } catch {
          if (typeof flashStatus === "function") flashStatus("Could not update work detail.");
        } finally {
          row.dataset.busy = "";
        }
      });
    });
    const head = box.querySelector("[data-unit-wd-spec]");
    if (head) {
      head.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        if (head.dataset.busy === "1") return;
        const on = head.dataset.on === "1" ? 0 : 1;
        head.dataset.busy = "1";
        try {
          const r = await fetch(`/labor-specialist?unit=${uid}&on=${on}`, { method: "POST", cache: "no-store" });
          if (!r.ok) throw new Error("specialist failed");
          unitLaborSnapshot = null;
          head.dataset.on = String(on);
          head.classList.toggle("specialist", !!on);
          // Rebuild the label rather than writing textContent, which would destroy the bitmap-text span.
          // The latch is re-rendered so its sprite flips with the state just written.
          const name = head.querySelector(".unit-wd-name");
          if (name) name.innerHTML = DWFUI.bitmapTextHtml(unitSpecialistText(!!on));
          const slot = head.querySelector(".unit-wd-icon-slot");
          if (slot) slot.innerHTML = unitSpecialistLatchHtml(!!on);
          head.title = "Toggle whether this dwarf only works its assigned work details";
        } catch {
          if (typeof flashStatus === "function") flashStatus("Could not update work preference.");
        } finally {
          head.dataset.busy = "";
        }
      });
    }
  }

  function renderUnitTabBody(unit, tab, detail, scrollKey) {
    if (tab === "Labor")
      return renderUnitWorkDetailsTab(unit, detail || "Work details", scrollKey);
    if (tab === "Relations") return renderUnitRelations(unit, scrollKey);
    if (tab === "Groups") return renderUnitGroups(unit, scrollKey);
    if (tab === "Rooms") return renderUnitRooms(unit, scrollKey);
    if (tab === "Items") return renderUnitInventory(unit, scrollKey);
    if (tab === "Skills") return renderUnitSkills(unit, detail || "Labor", scrollKey);
    if (tab === "Thoughts") {
      const structured = renderUnitThoughts(unit, detail || "Recent thoughts", scrollKey);
      if (structured !== null) return structured;
    }
    // A missing personalityNarrative is an explicit native empty state, never a silent fall back to the
    // numeric rows. Only this branch: renderUnitListGrid still owns Health and Military.
    if (tab === "Personality") {
      const structured = renderUnitPersonality(unit, detail || "Traits", scrollKey);
      return structured !== null
        ? structured
        : renderUnitListGrid("Personality", detail, ["No personality information."], null, scrollKey);
    }
    const map = {
      Thoughts: unit.thoughtLines,
      Skills: unit.skillLines,
      Health: {
        Status: unit.healthStatusLines,
        Wounds: unit.healthWoundLines,
        Treatment: unit.healthTreatmentLines,
        History: unit.healthHistoryLines,
        Description: unit.healthDescriptionLines
      }[detail] || unit.healthLines,
      Labor: {
        "Work details": unit.laborWorkDetailLines,
        Workshops: unit.laborWorkshopLines,
        Locations: unit.laborLocationLines,
        "Work animals": unit.laborWorkAnimalLines
      }[detail] || unit.laborLines,
      Military: {
        Squad: unit.militarySquadLines,
        // DEF-077: the wire serves uniform category specs rather than native assigned-item records.
        // Do not invent those items here; suppress only byte-identical duplicate specs.
        Uniform: Array.isArray(unit.militaryUniformLines)
          ? unit.militaryUniformLines.filter((line, index, lines) => lines.indexOf(line) === index)
          : unit.militaryUniformLines,
        Kills: unit.militaryKillLines
      }[detail] || unit.militaryLines
    };
    return renderUnitListGrid(tab, detail, Array.isArray(map[tab]) ? map[tab] : [], null, scrollKey);
  }

  // The client-wide `escapeHtml` global the panel files call. Its body is DWFUI.esc.
  function escapeHtml(value) {
    return DWFUI.esc(value);
  }

  if (typeof window !== "undefined") Object.assign(window, { showUnitSheet, renderUnitSheet, escapeHtml });
  if (typeof window !== "undefined") window.DFUnitProfileMarkup = { unitSheetMarkup, unitNicknameEditorMarkup };
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, {
    renderUnitTabBody, renderUnitLaborPanel, renderUnitRelations, renderUnitGroups, renderUnitRooms,
    renderUnitInventory, unitSheetMarkup, renderUnitStatusWords, unitNicknameEditorMarkup,
  });
