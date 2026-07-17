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

// W-F trade-depot panel. A trade depot resolves to kind:"building" in interaction.cpp, so the
// shared openBuildingPanel (dwf-building-zone-stockpile-panels.js) delegates here when
// /building-info reports isDepot:true. Reads /depot-info + /depot-goods + /depot-trade-status;
// mutates /depot-mark + /depot-broker. The barter confirm itself is host-native (see the
// server's /depot-trade 501 + the spec §2.4) -- this panel marks goods, requests the trader,
// and reports the native trade-session state.
//
// The pure data-shapers below (depotStatusText / caravanRows / brokerText / goodsRows /
// tradeStatusText) take plain JSON and return display strings/structs with NO DOM dependency,
// so tools/harness/tradedepot_fixture_test.mjs can exercise them (incl. seeded-bad rows)
// offline. They are node-exported at the bottom behind a browser-safe guard.

  // esc: reuse the shared global escapeHtml in the browser; fall back to a minimal impl so the
  // pure shapers still run under node (the fixture test).
  function _tdEsc(s) {
    if (typeof DWFUI !== "undefined" && DWFUI && typeof DWFUI.esc === "function") return DWFUI.esc(s);
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- pure data-shapers (node-testable) ------------------------------------------------

  // A2/A3/A4: one honest status line from the depot's build + accessibility state.
  function depotStatusText(info) {
    if (!info || info.ok === false) return "Trade depot data unavailable.";
    if (!info.built) return "Trade depot under construction.";
    if (!info.accessible)
      return "Built, but NOT reachable by wagons — a caravan cannot unload here (clear the path).";
    return "Constructed and reachable by wagons.";
  }

  // B1-B8: one row per caravan (active first is left to the caller's order = plotinfo order).
  function caravanRows(info) {
    const list = (info && Array.isArray(info.caravans)) ? info.caravans.filter(Boolean) : [];
    return list.map(c => {
      const days = Number(c && c.daysRemaining);
      const flags = (c && Array.isArray(c.flags)) ? c.flags : [];
      return {
        origin: (c && c.origin) || "Unknown caravan",
        state: (c && c.state) || "None",
        active: !!(c && c.active),
        atDepot: !!(c && c.atDepot),
        tribute: !!(c && c.tribute),
        daysText: Number.isFinite(days) && days > 0 ? `${days} day${days === 1 ? "" : "s"} left`
                                                     : "leaving soon",
        flags,
        importValue: Number((c && c.importValue) || 0),
        offerValue: Number((c && c.offerValue) || 0),
      };
    });
  }

  // D4/D5: broker presence line.
  function brokerText(info) {
    const b = info && info.broker;
    if (b && b.found) return `Broker: ${b.name || "(appointed)"}`;
    return "No broker appointed — assign one in Nobles before trading.";
  }

  // C1-C10: normalise a /depot-goods payload into display rows (defensive against malformed).
  function goodsRows(goods) {
    const list = (goods && Array.isArray(goods.goods)) ? goods.goods.filter(Boolean) : [];
    return list.map(g => ({
      id: Number(g && g.id),
      desc: (g && g.desc) || "(item)",
      value: Number((g && g.value) || 0),
      dist: Number((g && g.dist) || 0),
      pending: !!(g && g.pending),
      atDepot: !!(g && g.atDepot),
      forbidden: !!(g && g.forbidden),
      requested: !!(g && g.requested),
    })).filter(r => Number.isFinite(r.id) && r.id >= 0);
  }

  // E1/E2: native trade-session status line.
  function tradeStatusText(st) {
    if (!st || st.ok === false) return "";
    if (!st.tradeScreenOpen)
      return "No active trade session. Request the trader, then complete the barter at the depot in-game.";
    const civ = st.merchantCiv ? ` with ${st.merchantCiv}` : "";
    return `Trade session open${civ}: ${Number(st.fortGoods || 0)} fort goods / ` +
      `${Number(st.caravanGoods || 0)} caravan goods on the table. Complete the barter at the depot (host).`;
  }

  // ---- B226 barter-session shapers (node-testable) ---------------------------------------
  // The GET /depot-trade payload: {open, stillUnloading, haveTalker, counterOffer,
  // caravanGoods:[{id,idx,desc,value,selected,contained}], fortGoods:[...], guards:{...}}.

  function barterRows(trade, side) {
    const key = side === 0 ? "caravanGoods" : "fortGoods";
    const list = (trade && Array.isArray(trade[key])) ? trade[key].filter(Boolean) : [];
    return list.map(g => ({
      id: Number(g && g.id),
      idx: Number(g && g.idx),
      desc: (g && g.desc) || "(item)",
      value: Number((g && g.value) || 0),
      selected: !!(g && g.selected),
      contained: !!(g && g.contained),
    })).filter(r => Number.isFinite(r.id) && r.id >= 0);
  }

  // Selected count + value per side, with NATIVE bin-following semantics: an item inside a
  // selected container counts even when its own bit is off (mirrors for_selected_item in
  // DFHack's caravan/trade.lua, which mirrors the native trade loop). Rows must be in native
  // table order (they are: hw_trade_state emits them by index).
  function barterTotals(trade) {
    const totals = {};
    for (const side of [0, 1]) {
      let count = 0, value = 0, inSelectedBin = false;
      for (const r of barterRows(trade, side)) {
        if (!r.contained) inSelectedBin = r.selected;
        if (r.selected || inSelectedBin) { count += 1; value += r.value; }
      }
      totals[side === 0 ? "caravan" : "fort"] = { count, value };
    }
    return totals;
  }

  // Why the barter can't be committed right now (empty string = it can). Pure, testable.
  function barterBlockText(trade) {
    if (!trade || trade.ok === false) return "Trade session state unavailable.";
    if (!trade.open) return "No trade session is open.";
    if (trade.choosingMerchant) return "Merchant selection is open on the host screen.";
    if (Number(trade.stillUnloading) !== 0) return "The merchants are still unloading their goods.";
    if (Number(trade.haveTalker) !== 1) return "No merchant negotiator is at the depot yet.";
    return "";
  }

  // Plain-English text for a hostwrites 501 {"guarded":true} response. The server's error field
  // already says exactly why (which probe flag, what to do); this only adds a fallback.
  function hostwriteGuardText(resp) {
    if (resp && resp.error) return String(resp.error);
    return "This action is implemented but still locked behind a host-side verification probe.";
  }

  // ---- rendering (browser only) ---------------------------------------------------------

  let _tdState = { id: -1, info: null, goods: null, tradeStatus: null, trade: null, tradeError: "",
                   armed: "", goodsOpen: false, goodsSearch: "", busy: false };

  function _tdHeader(name) {
    return DWFUI.headerHtml({ cls: "bld-head", title: name || "Trade Depot", titleCls: "bld-name",
      close: { cls: "bld-x", dataset: { tdClose: "" }, title: "Close", glyph: "&#10005;" } });
  }

  async function _tdFetchJson(path) {
    const r = await fetch(path, { cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok && !(data && data.ok === false)) throw new Error((data && data.error) || text.trim() || "request failed");
    return data;
  }

  async function _tdPost(path) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${path}${sep}t=${Date.now()}`, { method: "POST", cache: "no-store" });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "request failed");
    return data;
  }

  async function openTradeDepotPanel(id, buildingInfo) {
    _tdState = { id, info: null, goods: null, tradeStatus: null, trade: null, tradeError: "",
                 armed: "", goodsOpen: false, goodsSearch: "", busy: false };
    if (typeof selection !== "undefined") {
      selection.className = "visible building-panel";
      panelContent(selection).innerHTML = `${_tdHeader((buildingInfo && buildingInfo.name) || "Trade Depot")}<div class="bld-status">Loading depot…</div>`;
      selection.querySelector("[data-td-close]")?.addEventListener("click", e => { e.stopPropagation(); closeSelection(); focusPage(); });
    }
    try {
      _tdState.info = await _tdFetchJson(`/depot-info?id=${id}&t=${Date.now()}`);
    } catch (err) {
      _tdState.info = { ok: false, error: err.message || "unavailable" };
    }
    // trade-session status is a cheap read; fetch it alongside.
    try { _tdState.tradeStatus = await _tdFetchJson(`/depot-trade-status?id=${id}&t=${Date.now()}`); } catch (_) {}
    // B226: the full barter-session state (goods tables + guard flags). A failed read is kept
    // as an ok:false record so the barter doorway can state the honest reason.
    try { _tdState.trade = await _tdFetchJson(`/depot-trade?t=${Date.now()}`); }
    catch (err) { _tdState.trade = { ok: false, error: err.message || "unavailable" }; }
    _tdRender();
  }

  function _tdBadge(text, cls) { return `<span class="td-badge${cls ? " " + cls : ""}">${_tdEsc(text)}</span>`; }

  // ---- B226: the barter entry -------------------------------------------------------------
  // The barter itself is the FULL trade screen (dwf-tradescreen.js, oracle
  // B226-barter-1..4); this panel carries its doorway. The plaque is ALWAYS rendered -- when the
  // barter is not possible it renders visibly disabled with the honest reason (never hidden,
  // never a fake button), and lights up the moment the state allows it (session opened on the
  // host, caravan arrival, guard flag flipped -- all re-read on every panel refresh).
  function barterEntryState(trade, info) {
    if (!trade || trade.ok === false) {
      return { enabled: false, reason: "Barter state unavailable -- the server did not answer " +
        "/depot-trade (a live build older than the hostwrites engine, or a transient error). " +
        `${trade && trade.error ? "Server said: " + trade.error : ""}`.trim() };
    }
    if (trade.open) return { enabled: true, reason: "" };
    const cars = caravanRows(info || {});
    if (!cars.some(c => c.atDepot))
      return { enabled: false, reason: "No caravan is at the depot -- the barter screen needs merchants." };
    // Caravan present, session closed: the screen opens with its remote-open control (which
    // explains the trade_open guard itself when locked).
    return { enabled: true, reason: "" };
  }

  function _tdBarterHtml(s) {
    const entry = barterEntryState(s.trade, s.info);
    const live = !!(s.trade && s.trade.ok !== false && s.trade.open);
    const err = s.tradeError
      ? `<div class="bld-status err td-barter-error">${_tdEsc(s.tradeError)}</div>` : "";
    return `<div class="td-section td-barter">
      ${DWFUI.plaqueBtnHtml({
        cls: "bld-btn", tone: entry.enabled ? (live ? "green" : "gold") : "grey",
        dataset: { tdAct: "barter-screen" }, disabled: !entry.enabled,
        label: live ? "Barter at the depot (session open)" : "Barter at the depot",
        title: entry.enabled
          ? "Opens the trade screen. Every write is performed by Dwarf Fortress natively on the host."
          : entry.reason,
      })}
      ${entry.enabled ? "" : `<div class="bld-note">${_tdEsc(entry.reason)}</div>`}
      ${err}</div>`;
  }

  function tradeDepotPanelMarkup(state) {
    const s = state || {};
    if (!s.info) return `${_tdHeader(s.name || "Trade Depot")}<div class="bld-status">Loading depotâ€¦</div>`;
    const info = s.info || {};
    if (info.ok === false) {
      return `${_tdHeader(s.name || "Trade Depot")}<div class="bld-status err">${_tdEsc(info.error || "Depot data unavailable.")}</div>`;
    }

    // Caravans block.
    const cars = caravanRows(info);
    const carsHtml = cars.length ? cars.map(c => {
      const badges = [
        c.atDepot ? _tdBadge("At depot", "ok") : (c.active ? _tdBadge("Approaching", "ok") : _tdBadge(c.state)),
        c.tribute ? _tdBadge("Tribute", "warn") : "",
        ...c.flags.map(f => _tdBadge(f, "warn")),
      ].filter(Boolean).join(" ");
      return `<div class="td-caravan"><div class="td-caravan-name">${_tdEsc(c.origin)}</div>
        <div class="td-caravan-meta">${_tdEsc(c.daysText)} ${badges}</div></div>`;
    }).join("") : `<div class="bld-note">No caravans on the map.</div>`;

    // Broker + flag toggles.
    const req = !!info.traderRequested;
    const anyone = !!info.anyoneCanTrade;
    const brokerHtml = `<div class="bld-note">${_tdEsc(brokerText(info))}</div>` +
      DWFUI.plaqueBtnHtml({ cls: `bld-btn${req ? " active" : ""}`, tone: req ? "green" : "gold",
        dataset: { tdAct: "broker", tdVal: req ? 0 : 1 },
        label: req ? "Recall trader (cancel request)" : "Request trader at depot" }) +
      DWFUI.plaqueBtnHtml({ cls: `bld-btn${anyone ? " active" : ""}`, tone: anyone ? "green" : "gold",
        dataset: { tdAct: "anyone", tdVal: anyone ? 0 : 1 }, label: `Anyone can trade: ${anyone ? "On" : "Off"}` });

    // Trade-session status line (suppressed while the live barter table below is rendering --
    // "complete the barter at the depot (host)" would be false advice next to a working table).
    const barterHtml = _tdBarterHtml(s);
    const barterLive = !!(s.trade && s.trade.ok !== false && s.trade.open);
    const tradeTxt = barterLive ? "" : tradeStatusText(s.tradeStatus);
    const tradeHtml = tradeTxt ? `<div class="bld-note td-trade-status">${_tdEsc(tradeTxt)}</div>` : "";

    // Goods: the full bring-goods screen (oracle B226-depot-1..7) lives in
    // dwf-tradescreen.js; this plaque is its doorway.
    const goodsHtml = DWFUI.plaqueBtnHtml({ cls: "bld-btn", dataset: { tdAct: "goods-screen" },
      label: "Move goods to depot",
      title: "Opens the bring-goods screen. Marked items are hauled to the depot by your dwarves." });

    return `
      ${_tdHeader(info.name || "Trade Depot")}
      <div class="bld-status${!info.accessible && info.built ? " suspended" : ""}">${_tdEsc(depotStatusText(info))}</div>
      <div class="td-section td-caravans">${carsHtml}</div>
      <div class="td-section td-broker">${brokerHtml}</div>
      ${tradeHtml}
      ${barterHtml}
      <div class="td-section td-goods">${goodsHtml}</div>
      <div class="td-section">${DWFUI.plaqueBtnHtml({ cls: "bld-btn danger", tone: "red", dataset: { tdAct: "remove" }, label: info.built ? "Remove depot" : "Cancel construction" })}</div>
    `;
  }

  function _tdRender() {
    if (typeof selection === "undefined") return;
    const info = _tdState.info || {};
    selection.className = info.ok === false ? "visible building-panel" : "visible building-panel td-depot-panel";
    panelContent(selection).innerHTML = tradeDepotPanelMarkup(_tdState);
    if (info.ok === false) {
      selection.querySelector("[data-td-close]")?.addEventListener("click", e => { e.stopPropagation(); closeSelection(); focusPage(); });
      return;
    }
    _tdWire();
  }

  function _tdWire() {
    if (typeof selection === "undefined") return;
    const s = _tdState;
    selection.querySelector("[data-td-close]")?.addEventListener("click", e => { e.stopPropagation(); closeSelection(); focusPage(); });

    selection.querySelectorAll("[data-td-act]").forEach(btn => btn.addEventListener("click", async e => {
      e.stopPropagation();
      const act = btn.dataset.tdAct;
      // B226: both trade screens live in dwf-tradescreen.js (full windows).
      if (act === "barter-screen") {
        if (window.DFTradeScreen) window.DFTradeScreen.openTradeScreen(s.id);
        return;
      }
      if (act === "goods-screen") {
        if (window.DFTradeScreen) window.DFTradeScreen.openDepotGoodsScreen(s.id);
        return;
      }
      if (act === "remove") {
        // Reuse the DF-native deconstruct route (Buildings::deconstruct) the generic panel uses.
        try { await _tdPost(`/building-action?id=${s.id}&action=remove`); } catch (_) {}
        closeSelection(); focusPage();
        return;
      }
      if (act === "broker" || act === "anyone") {
        const param = act === "broker" ? "request" : "anyone";
        try { await _tdPost(`/depot-broker?id=${s.id}&${param}=${btn.dataset.tdVal}`); }
        catch (_) {}
        try { s.info = await _tdFetchJson(`/depot-info?id=${s.id}&t=${Date.now()}`); } catch (_) {}
        try { s.tradeStatus = await _tdFetchJson(`/depot-trade-status?id=${s.id}&t=${Date.now()}`); } catch (_) {}
        _tdRender();
        focusPage();
        return;
      }
    }));
  }

  // Browser-safe node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { depotStatusText, caravanRows, brokerText, goodsRows, tradeStatusText,
                       tradeDepotPanelMarkup, barterRows, barterTotals, barterBlockText,
                       barterEntryState, hostwriteGuardText };
  }
  if (typeof window !== "undefined") window.DFTradeDepotMarkup = { tradeDepotPanelMarkup };
