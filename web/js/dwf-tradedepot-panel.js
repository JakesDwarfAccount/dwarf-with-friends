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

// ---- Trade-depot panel: reads /depot-info, /depot-goods and /depot-trade-status; writes /depot-mark. ----
// The barter confirm itself is host-native -- the server's /depot-trade answers 501.

  // esc: reuse the shared global escapeHtml in the browser; fall back to a minimal impl so the
  // pure shapers still run under node (the fixture test).
  function _tdEsc(s) {
    if (typeof DWFUI !== "undefined" && DWFUI && typeof DWFUI.esc === "function") return DWFUI.esc(s);
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- pure data-shapers (node-testable) ------------------------------------------------

  // One honest status line from the depot's build and accessibility state.
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

  // Broker presence line.
  function brokerText(info) {
    const b = info && info.broker;
    if (b && b.found) return `Broker: ${b.name || "(appointed)"}`;
    return "No broker appointed — assign one in Nobles before trading.";
  }

  // C1-C10: normalise a /depot-goods payload into display rows (defensive against malformed).
  function goodsRows(goods) {
    return globalThis.DwfTradeModel.depotGoodsRows(goods);
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

  // ---- barter-session shapers (node-testable) --------------------------------------------

  // NATIVE bin-following semantics: an item inside a selected container counts even when its own bit is
  // off. Rows must stay in native table order, which is the order hw_trade_state emits them.
  function barterTotals(trade) {
    const totals = {};
    for (const side of [0, 1]) {
      let count = 0, value = 0, inSelectedBin = false;
      for (const r of window.DwfTradeModel.barterRows(trade, side, { detail: false })) {
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
    return DWFUI.headerHtml({ cls: "building-head", title: name || "Trade Depot", titleCls: "building-name",
      close: { cls: "building-x", dataset: { tdClose: "" }, title: "Close" } });
  }

  async function _tdFetchJson(path) {
    const { response: r, text, data } = await globalThis.DwfCoreTransport.queryJson(path);
    if (!r.ok && !(data && data.ok === false)) throw new Error((data && data.error) || text.trim() || "request failed");
    return data;
  }

  async function _tdPost(path) {
    const { response: r, text, data } = await globalThis.DwfCoreTransport.queryJson(path, {}, { method: "POST", bust: true });
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "request failed");
    return data;
  }

  async function openTradeDepotPanel(id, buildingInfo) {
    _tdState = { id, info: null, goods: null, tradeStatus: null, trade: null, tradeError: "",
                 armed: "", goodsOpen: false, goodsSearch: "", busy: false };
    if (typeof selection !== "undefined") {
      selection.className = "visible building-panel";
      panelContent(selection).innerHTML = `${_tdHeader((buildingInfo && buildingInfo.name) || "Trade Depot")}${DWFUI.statusHtml({ cls: "building-status", tone: "dim", text: "Loading depot…" })}`;
      selection.querySelector("[data-td-close]")?.addEventListener("click", e => { e.stopPropagation(); closeSelection(); focusPage(); });
    }
    try {
      _tdState.info = await _tdFetchJson(`/depot-info?id=${id}&t=${Date.now()}`);
    } catch (err) {
      _tdState.info = { ok: false, error: err.message || "unavailable" };
    }
    // trade-session status is a cheap read; fetch it alongside.
    try { _tdState.tradeStatus = await _tdFetchJson(`/depot-trade-status?id=${id}&t=${Date.now()}`); } catch { globalThis.DwfErr?.count("tradedepot-panel.trade-status"); }
    // the full barter-session state (goods tables + guard flags). A failed read is kept
    // as an ok:false record so the barter doorway can state the honest reason.
    try { _tdState.trade = await _tdFetchJson(`/depot-trade?t=${Date.now()}`); }
    catch (err) { _tdState.trade = { ok: false, error: err.message || "unavailable" }; }
    _tdRender();
  }

  function _tdBadge(text, cls) { return `<span class="trade-depot-badge${cls ? " " + cls : ""}">${_tdEsc(text)}</span>`; }

  // ---- the barter entry -------------------------------------------------------------------
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
      ? DWFUI.statusHtml({ cls: "building-status err trade-depot-barter-error", tone: "alert", text: s.tradeError }) : "";
    return `<div class="trade-depot-section trade-depot-barter">
      ${DWFUI.plaqueBtnHtml({
        cls: "building-btn", tone: entry.enabled ? (live ? "green" : "gold") : "grey",
        dataset: { tdAct: "barter-screen" }, disabled: !entry.enabled,
        label: live ? "Barter at the depot (session open)" : "Barter at the depot",
        title: entry.enabled
          ? "Opens the trade screen. Every write is performed by Dwarf Fortress natively on the host."
          : entry.reason,
      })}
      ${entry.enabled ? "" : `<div class="building-note">${_tdEsc(entry.reason)}</div>`}
      ${err}</div>`;
  }

  function tradeDepotPanelMarkup(state) {
    const s = state || {};
    if (!s.info) return `${_tdHeader(s.name || "Trade Depot")}${DWFUI.statusHtml({ cls: "building-status", tone: "dim", text: "Loading depot…" })}`;
    const info = s.info || {};
    if (info.ok === false) {
      return `${_tdHeader(s.name || "Trade Depot")}<div class="building-status err">${_tdEsc(info.error || "Depot data unavailable.")}</div>`;
    }

    // Caravans block.
    const cars = caravanRows(info);
    const carsHtml = cars.length ? cars.map(c => {
      const badges = [
        c.atDepot ? _tdBadge("At depot", "ok") : (c.active ? _tdBadge("Approaching", "ok") : _tdBadge(c.state)),
        c.tribute ? _tdBadge("Tribute", "warn") : "",
        ...c.flags.map(f => _tdBadge(f, "warn")),
      ].filter(Boolean).join(" ");
      return DWFUI.rowHtml({
        cls: "trade-depot-caravan", label: c.origin, labelCls: "trade-depot-caravan-name",
        sub: { cls: "trade-depot-caravan-meta", html: DWFUI.rawHtml(
          "Caravan metadata combines escaped timing copy with DWFUI-built status badges.",
          _tdEsc(c.daysText) + " " + badges) },
      });
    }).join("") : `<div class="building-note">No caravans on the map.</div>`;

    // Broker + flag toggles.
    const req = !!info.traderRequested;
    const anyone = !!info.anyoneCanTrade;
    const brokerHtml = `<div class="building-note">${_tdEsc(brokerText(info))}</div>` +
      DWFUI.plaqueBtnHtml({ cls: `building-btn${req ? " active" : ""}`, tone: req ? "green" : "gold",
        dataset: { tdAct: "broker", tdVal: req ? 0 : 1 },
        label: req ? "Recall trader (cancel request)" : "Request trader at depot" }) +
      DWFUI.plaqueBtnHtml({ cls: `building-btn${anyone ? " active" : ""}`, tone: anyone ? "green" : "gold",
        dataset: { tdAct: "anyone", tdVal: anyone ? 0 : 1 }, label: `Anyone can trade: ${anyone ? "On" : "Off"}` });

    // Trade-session status line (suppressed while the live barter table below is rendering --
    // "complete the barter at the depot (host)" would be false advice next to a working table).
    const barterHtml = _tdBarterHtml(s);
    const barterLive = !!(s.trade && s.trade.ok !== false && s.trade.open);
    const tradeTxt = barterLive ? "" : tradeStatusText(s.tradeStatus);
    const tradeHtml = tradeTxt ? `<div class="building-note trade-depot-trade-status">${_tdEsc(tradeTxt)}</div>` : "";

    // Goods: the full bring-goods screen lives in
    // dwf-tradescreen.js; this plaque is its doorway.
    const goodsHtml = DWFUI.plaqueBtnHtml({ cls: "building-btn", dataset: { tdAct: "goods-screen" },
      label: "Move goods to depot",
      title: "Opens the bring-goods screen. Marked items are hauled to the depot by your dwarves." });

    return `
      ${_tdHeader(info.name || "Trade Depot")}
      ${DWFUI.statusHtml({ cls: `building-status${!info.accessible && info.built ? " suspended" : ""}`, text: depotStatusText(info) })}
      ${DWFUI.scrollHtml({
        cls: "trade-depot-section trade-depot-caravans", rows: ".trade-depot-caravan",
        preserveKey: "trade-depot-caravans", ariaLabel: "Caravans",
      }, carsHtml)}
      <div class="trade-depot-section trade-depot-broker">${brokerHtml}</div>
      ${tradeHtml}
      ${barterHtml}
      <div class="trade-depot-section trade-depot-goods">${goodsHtml}</div>
      <div class="trade-depot-section">${DWFUI.plaqueBtnHtml({ cls: "building-btn danger", tone: "red", dataset: { tdAct: "remove" }, label: info.built ? "Remove depot" : "Cancel construction" })}</div>
    `;
  }

  function _tdRender() {
    if (typeof selection === "undefined") return;
    const info = _tdState.info || {};
    selection.className = info.ok === false ? "visible building-panel" : "visible building-panel trade-depot-depot-panel";
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
      // both trade screens live in dwf-tradescreen.js (full windows).
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
        try { await _tdPost(`/building-action?id=${s.id}&action=remove`); } catch (err) { globalThis.DwfOrder.lost("trade-depot.remove", err, "That trade-depot removal"); }
        closeSelection(); focusPage();
        return;
      }
      if (act === "broker" || act === "anyone") {
        const param = act === "broker" ? "request" : "anyone";
        try { await _tdPost(`/depot-broker?id=${s.id}&${param}=${btn.dataset.tdVal}`); }
        catch (err) { globalThis.DwfOrder.lost("trade-depot.broker", err, "That trader-request change"); }
        try { s.info = await _tdFetchJson(`/depot-info?id=${s.id}&t=${Date.now()}`); } catch { globalThis.DwfErr?.count("tradedepot-panel.info-refresh"); }
        try { s.tradeStatus = await _tdFetchJson(`/depot-trade-status?id=${s.id}&t=${Date.now()}`); } catch { globalThis.DwfErr?.count("tradedepot-panel.trade-status-refresh"); }
        _tdRender();
        focusPage();
        return;
      }
    }));
  }

  // Browser-safe node export for the offline fixture test.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { depotStatusText, caravanRows, brokerText, goodsRows, tradeStatusText,
                       tradeDepotPanelMarkup, barterRows: globalThis.DwfTradeModel.barterRows, barterTotals, barterBlockText,
                       barterEntryState, hostwriteGuardText };
  }
  if (typeof window !== "undefined") window.DFTradeDepotMarkup = { tradeDepotPanelMarkup };
