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

  // ---- Labor -> Stone use, backed by /stone-use ----
  let stoneData = null;   // { economic: [full row], other: [full row | {name}] }
  let stoneActiveTab = "economic"; // "economic" | "other"
  let stoneLoadToken = 0;

  async function openStoneUsePanel() {
    const main = clientPanel.querySelector(".info-main");
    if (main) main.innerHTML = `<div class="info-message">Loading stone use...</div>`;
    const token = ++stoneLoadToken;
    try {
      const r = await fetch(`/stone-use?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error("stone-use failed");
      stoneData = await r.json();
    } catch {
      stoneData = null;
    }
    if (token !== stoneLoadToken) return;
    renderStoneUsePanel();
  }

  function stoneMagmaHtml(magmaSafe) {
    return DWFUI.iconHtml({
      sprite: magmaSafe ? "LABOR_STONE_USE_MAGMA_SAFE" : "LABOR_STONE_USE_MAGMA_UNSAFE",
      cls: "stone-magma", alt: magmaSafe ? "Magma-safe" : "Not magma-safe",
    });
  }
  function stoneCheckHtml(s) {
    return DWFUI.checkHtml({
      cls: "stone-check", checked: !!s.selected,
      sprite: "LABOR_STONE_USE_RESTRICTED", activeSprite: "LABOR_STONE_USE_ALLOWED",
      dataset: { stoneToggle: `${s.matType}:${s.matIndex}`, stoneOn: s.selected ? 0 : 1 },
      title: "Select to use in non-economic jobs",
    });
  }
  function stoneItemHtml(s) {
    const ref = s.spriteRef || {
      itemType: "BOULDER", itemSubtype: -1,
      materialType: Number(s.matType), materialIndex: Number(s.matIndex),
    };
    return DWFUI.iconHtml({ item: ref, cls: "stone-item", size: 44, alt: s.name });
  }
  function stoneHasFullWire(s) {
    return !!(s && s.matType !== undefined && s.matIndex !== undefined &&
      typeof s.magmaSafe === "boolean" && Array.isArray(s.uses) &&
      typeof s.selected === "boolean");
  }
  function stoneRowHtml(s) {
    return `<div class="stone-row" data-stone-mat="${s.matType}:${s.matIndex}">${stoneItemHtml(s)}<span class="stone-name">${escapeHtml(s.name)}</span>${stoneMagmaHtml(s.magmaSafe)}<span class="stone-uses">${escapeHtml(s.uses.join(", "))}</span>${stoneCheckHtml(s)}</div>`;
  }
  function legacyOtherStoneRowHtml(s) {
    return `<div class="stone-row stone-row-other"><span>${escapeHtml(s && s.name)}</span></div>`;
  }
  function stoneHeadHtml() {
    return `<div class="stone-head"><span>Stone type</span><span>Magma-safe</span><span>Economic uses</span><span>Select to use in non-economic jobs</span></div>`;
  }
  function stoneUseMarkup(data, activeTab = "economic") {
    if (!data) return `<div class="info-message">Stone use unavailable.</div>`;
    const economic = Array.isArray(data.economic) ? data.economic : [];
    const other = Array.isArray(data.other) ? data.other : [];
    const source = activeTab === "other" ? other : economic;
    const emptyCopy = activeTab === "other" ? "No other stone discovered." : "No economic stone discovered.";
    const rows = source.length
      ? source.map(s => stoneHasFullWire(s) ? stoneRowHtml(s) : legacyOtherStoneRowHtml(s)).join("")
      : `<div class="info-message">${emptyCopy}</div>`;
    const showHead = activeTab === "economic" || other.some(stoneHasFullWire);
    const tabs = DWFUI.tabsHtml({ cls: "info-detail-tabs standing-order-cat-tabs", tabCls: "info-tab", dataAttr: "stone-tab", level: "subsubtab", ariaLabel: "Stone category", active: activeTab, tabs: [{ key: "economic", label: "Economic stone" }, { key: "other", label: "Other stone" }] });
    // The stone list is the one region in this family with a NATIVE SCROLLBAR in its oracle
    // (16d-labor-stone-use.png). scrollHtml gives it the one shared bar + scroll preservation.
    const list = DWFUI.scrollHtml({ cls: "stone-list", rows: ".stone-row", preserveKey: "labor-stone-list" }, rows);
    return `<div class="stone-use-screen">${tabs}${showHead ? stoneHeadHtml() : ""}${list}</div>`;
  }

  async function stoneUsePost(mat, on, fetchImpl = fetch) {
    const response = await fetchImpl(
      `/stone-use?mat=${encodeURIComponent(mat)}&value=${on}`,
      { method: "POST", cache: "no-store" });
    let data = null;
    try { data = await response.json(); } catch { globalThis.DwfErr?.count("stone-use.response-parse"); }
    if (!response.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || "Stone use update failed");
    }
    // Older DLLs can return an empty successful body. HTTP success is sufficient for that
    // rollout case, while every non-OK response is rejected before local state changes.
    return data || {};
  }

  function renderStoneUsePanel() {
    const main = clientPanel.querySelector(".info-main");
    if (!main) return;
    if (!stoneData) { main.innerHTML = `<div class="info-message">Stone use unavailable.</div>`; return; }
    const economic = Array.isArray(stoneData.economic) ? stoneData.economic : [];
    const other = Array.isArray(stoneData.other) ? stoneData.other : [];
    main.innerHTML = stoneUseMarkup(stoneData, stoneActiveTab);
    main.querySelectorAll("[data-stone-tab]").forEach(b => b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      stoneActiveTab = b.dataset.stoneTab;
      renderStoneUsePanel();
      focusPage();
    }));
    main.querySelectorAll("[data-stone-toggle]").forEach(b => b.addEventListener("click", async e => {
      e.preventDefault(); e.stopPropagation();
      const mat = b.dataset.stoneToggle;
      const on = Number(b.dataset.stoneOn);
      try {
        await stoneUsePost(mat, on);
        const [mt, mi] = mat.split(":").map(Number);
        const s = economic.concat(other).find(x => x.matType === mt && x.matIndex === mi);
        if (s) s.selected = on !== 0;
        renderStoneUsePanel();
      } catch (err) { globalThis.DwfOrder.lost("labor.stone-use", err, "That stone-use change"); }
      focusPage();
    }));
  }


  window.openStoneUsePanel = openStoneUsePanel;

  if (typeof module !== "undefined" && module.exports) {
    Object.assign(module.exports, {
      stoneHasFullWire, stoneRowHtml, legacyOtherStoneRowHtml, stoneHeadHtml,
      stoneUsePost, stoneUseMarkup,
    });
  }
