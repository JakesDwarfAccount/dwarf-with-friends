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

// dwf-tradescreen.js -- the browser trade screen (barter) and the bring-goods-to-depot screen.

  // ---- shared helpers ---------------------------------------------------------------------------

  function _tsUi() {
    if (typeof DWFUI !== "undefined" && DWFUI) return DWFUI;
    if (typeof window !== "undefined" && window.DWFUI) return window.DWFUI;
    throw new Error("dwf-tradescreen.js requires DWFUI (load order: ui-components first)");
  }

  // Native value/weight unit glyphs (oracle rows: "Value: 30☼" / "Weight: 53Γ").
  const TS_VALUE_GLYPH = "☼";   // CP437 0x0F -- DF's value star
  const TS_WEIGHT_GLYPH = "Γ";  // CP437 0xE2 -- DF's weight unit

  const TS_GROUP_LABELS = {
    BAR: "Bars",                 // *
    SMALLGEM: "Cut gems",        // *
    BLOCKS: "Blocks",            // *
    ROUGH: "Rough gems",         // *
    BOULDER: "Boulders",         // *
    CHAIN: "Chains",             // *
    BARREL: "Barrels",           // *
    STATUE: "Statues",           // *
    BOX: "Boxes",                // *
    WOOD: "Logs", WEAPON: "Weapons", ARMOR: "Armor", SHOES: "Footwear", HELM: "Headwear",
    GLOVES: "Handwear", PANTS: "Legwear", SHIELD: "Shields", AMMO: "Ammunition",
    ANVIL: "Anvils", CLOTH: "Cloth", THREAD: "Thread", SKIN_TANNED: "Leather",
    MEAT: "Meat", FISH: "Fish", FISH_RAW: "Raw fish", PLANT: "Plants",
    PLANT_GROWTH: "Plant growths", SEEDS: "Seeds", DRINK: "Drinks", POWDER_MISC: "Powders",
    CHEESE: "Cheese", FOOD: "Prepared meals", LIQUID_MISC: "Liquids", EGG: "Eggs",
    GEM: "Large gems", FIGURINE: "Figurines", AMULET: "Amulets", SCEPTER: "Scepters",
    CROWN: "Crowns", RING: "Rings", EARRING: "Earrings", BRACELET: "Bracelets",
    TOTEM: "Totems", INSTRUMENT: "Instruments", TOY: "Toys", GOBLET: "Goblets",
    FLASK: "Flasks", BACKPACK: "Backpacks", QUIVER: "Quivers", CAGE: "Cages",
    TABLE: "Tables", CHAIR: "Chairs", BED: "Beds", COFFIN: "Coffins", DOOR: "Doors",
    BIN: "Bins", BUCKET: "Buckets", CABINET: "Cabinets", ARMORSTAND: "Armor stands",
    WEAPONRACK: "Weapon racks", WINDOW: "Windows", MILLSTONE: "Millstones",
    QUERN: "Querns", TOOL: "Tools", SHEET: "Sheets", BOOK: "Books", COIN: "Coins",
    PIPE_SECTION: "Pipe sections", ANIMALTRAP: "Animal traps", SPLINT: "Splints",
    CRUTCH: "Crutches", TRAPCOMP: "Trap components", SIEGEAMMO: "Siege ammunition",
    CORPSE: "Corpses", CORPSEPIECE: "Body parts", REMAINS: "Remains", VERMIN: "Vermin",
    PET: "Pets",
  };

  function tsGroupLabel(key) {
    if (!key) return "";
    if (TS_GROUP_LABELS[key]) return TS_GROUP_LABELS[key];
    const words = String(key).toLowerCase().replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  async function _tsFetchJson(path, method) {
    const { response: r, text, data } = await globalThis.DwfCoreTransport.queryJson(path, {}, { method });
    if (!r.ok && !(data && data.ok === false))
      throw new Error((data && data.error) || text.trim() || `request failed (${r.status})`);
    return data;
  }

  async function _tsPost(path) {
    const { response: r, text, data } = await globalThis.DwfCoreTransport.queryJson(path, {}, { method: "POST", bust: true });
    if (!r.ok || data.ok === false) throw new Error(data.error || text.trim() || "request failed");
    return data;
  }

  // ---- pure shapers: the barter screen (node-tested) ----------------------------------------------

  function tsRows(trade, side) {
    return globalThis.DwfTradeModel.barterRows(trade, side, { detail: true });
  }

  // Contained rows attach to the container row above them, and top-level rows group into consecutive
  // item-type runs. Rows with no `group` field fall into ONE label-less group and render header-free.
  function tsGroups(rows) {
    const top = [];
    for (const r of rows || []) {
      if (r.contained && top.length) { top[top.length - 1].children.push(r); continue; }
      top.push(Object.assign({}, r, { children: [] }));
    }
    const groups = [];
    for (const r of top) {
      const key = r.group || "";
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(r);
      else groups.push({ key, label: tsGroupLabel(key), items: [r] });
    }
    return groups;
  }

  // NATIVE bin-following semantics: the contents of a selected container count with it. Weight is
  // carried in milligrams for the footer arithmetic.
  function tsTotals(trade) {
    const totals = {};
    for (const side of [0, 1]) {
      let count = 0, value = 0, weightMg = 0, inSelectedBin = false;
      for (const r of tsRows(trade, side)) {
        if (!r.contained) inSelectedBin = r.selected;
        if (r.selected || inSelectedBin) {
          count += 1; value += r.value;
          weightMg += r.weight * 1e6 + r.weightFr;
        }
      }
      totals[side === 0 ? "caravan" : "fort"] = { count, value, weightMg };
    }
    return totals;
  }

  function tsFooter(trade) {
    const totals = tsTotals(trade);
    const diff = totals.fort.value - totals.caravan.value;
    const profit = diff < 0
      ? { kind: "loss", text: `Trader Loss: ${-diff}${TS_VALUE_GLYPH}` }
      : { kind: "profit",
          text: `Trader Profit: ${totals.caravan.value > 0 ? Math.floor(diff * 100 / totals.caravan.value) : 0}%` };
    let weight = null;
    const capacity = Number(trade && trade.capacity);
    if (Number.isFinite(capacity) && capacity >= 0) {
      let caravanLoadMg = 0;
      for (const r of tsRows(trade, 0)) caravanLoadMg += r.weight * 1e6 + r.weightFr;
      const capacityMg = capacity * 1e6 + (Number(trade.capacityFr) || 0);
      const roomMg = capacityMg - caravanLoadMg + totals.caravan.weightMg - totals.fort.weightMg;
      const kg = Math.floor(Math.abs(roomMg) / 1e6);
      weight = roomMg >= 0
        ? { kind: "allowed", text: `Allowed Weight: ${kg}${TS_WEIGHT_GLYPH}` }
        : { kind: "excess", text: `Excess Weight: ${kg}${TS_WEIGHT_GLYPH}` };
    }
    return {
      merchantLine: `Merchants from ${(trade && (trade.merchantCivNative || trade.merchantCiv)) || "the caravan"}`,
      fortLine: (trade && trade.fortName) ? `Your fortress of ${trade.fortName}` : "Your fortress",
      merchantValue: `Value: ${totals.caravan.value}${TS_VALUE_GLYPH}`,
      fortValue: `Value: ${totals.fort.value}${TS_VALUE_GLYPH}`,
      profit, weight, totals,
    };
  }

  // Only native or oracle-evidenced copy: the quote renders ONLY for the post-trade line the oracle
  // shows verbatim, and an uncaptured merchant mood renders NO line rather than an invented one.
  function tsHeader(trade) {
    const t = trade || {};
    const name = t.screenTitle || t.merchantName ||
      (t.merchantCiv ? `Merchant of ${t.merchantCiv}` : "Merchant");
    const quote = t.talkLine === "Trade" ? '"Ah, wonderful.  Thank you for your business."' : "";
    let mood = "";
    if (t.open && Number(t.haveTalker) === 1 && !t.counterOffer && t.talkLine !== "Trade" &&
        Number(t.merchantMood) >= 0) {
      const who = String(t.talkerName || t.merchantName || "").trim().split(/\s+/)[0];
      if (who) mood = `${who} seems willing to trade.`;
    }
    return { name, quote, mood };
  }

  // Why the whole barter table is unavailable right now ("" = it is usable).
  function tsBlockText(trade) {
    if (!trade || trade.ok === false) return "Trade session state unavailable.";
    if (!trade.open) return "No trade session is open.";
    if (trade.choosingMerchant) return "Merchant selection is open on the host screen.";
    if (Number(trade.stillUnloading) !== 0) return "The merchants are still unloading their goods.";
    if (Number(trade.haveTalker) !== 1) return "No merchant negotiator is at the depot yet.";
    return "";
  }

  const TS_GUARD_COPY = {
    tradeSelect: 'Marking goods is implemented but locked behind the host-side verification ' +
      'probe (flag "trade_select" in dfcapture-hostwrites.json). It unlocks live once the ' +
      'host owner runs the probe -- no reload needed.',
    tradeConfirm: 'This commit is implemented but locked behind the host-side verification ' +
      'probe (flag "trade_confirm" in dfcapture-hostwrites.json). It unlocks live once the ' +
      'host owner runs the probe -- no reload needed.',
    tradeOpen: 'Opening the trade screen remotely is implemented but locked behind the ' +
      'host-side verification probe (flag "trade_open" in dfcapture-hostwrites.json). Until ' +
      'then the session must be opened at the host keyboard.',
  };

  function tsActionState(trade, action) {
    const guards = (trade && trade.guards) || {};
    const block = tsBlockText(trade);
    if (action === "select") {
      if (block) return { enabled: false, reason: block };
      if (guards.tradeSelect !== true) return { enabled: false, reason: TS_GUARD_COPY.tradeSelect };
      return { enabled: true, reason: "" };
    }
    if (block) return { enabled: false, reason: block };
    if (guards.tradeConfirm !== true) return { enabled: false, reason: TS_GUARD_COPY.tradeConfirm };
    const totals = tsTotals(trade);
    if (action === "offer" && totals.fort.count > 0)
      return { enabled: false, reason: "Native greys Offer as gift while your own goods are " +
        "marked (oracle B226-barter-3). Unmark your fortress goods to offer a gift." };
    if (action === "seize")
      return { enabled: false, reason: "Seize is grey in every native capture -- even with " +
        "caravan goods marked -- so its enable-condition is not yet pinned. It stays disabled " +
        "until a native capture shows it lit (screenshot request filed)." };
    return { enabled: true, reason: "" };
  }

  // ---- pure shapers: the bring-goods screen (node-tested) -----------------------------------------

  function dgRows(goods) {
    return globalThis.DwfTradeModel.depotGoodsRows(goods);
  }

  function dgGroupKey(desc) {
    let s = String(desc || "").trim();
    s = s.replace(/<#\d+>/g, "").trim();
    const wrap = s.match(/^([-+*≡☼])(.*)\1$/);
    if (wrap) s = wrap[2].trim();
    const paren = s.match(/^\((.*)\)$/);
    if (paren) s = paren[1].trim();
    return s.toLowerCase();
  }

  function dgGroups(rows, search, sort) {
    const term = String(search || "").trim().toLowerCase();
    let shown = term ? (rows || []).filter(r => r.desc.toLowerCase().includes(term)) : (rows || []).slice();
    if (sort === "distance") shown.sort((a, b) => a.dist - b.dist || a.id - b.id);
    else if (sort === "value") shown.sort((a, b) => b.value - a.value || a.id - b.id);
    const byKey = new Map();
    for (const r of shown) {
      const key = dgGroupKey(r.desc);
      if (!byKey.has(key)) byKey.set(key, { key, items: [] });
      byKey.get(key).items.push(r);
    }
    const groups = [...byKey.values()];
    for (const g of groups) {
      const name = dgGroupKey(g.items[0].desc);
      g.label = name.charAt(0).toUpperCase() + name.slice(1);
      g.count = g.items.length;
    }
    return groups;
  }

  // ---- barter-screen markup -----------------------------------------------------------------------

  function _tsCheck(cfg) {
    const ui = _tsUi();
    return ui.checkHtml(Object.assign({
      sprite: ui.TOKENS.sprites.tradeNotSelected, activeSprite: ui.TOKENS.sprites.tradeSelected,
    }, cfg));
  }

  function _tsMetaHtml(row, trade) {
    const ui = _tsUi();
    const approx = Number(trade && trade.handleAppraisal) !== 0 ? "~" : "";
    const value = ui.bitmapTextHtml(`Value: ${approx}${row.value}${TS_VALUE_GLYPH}`, { cls: "trade-screen-meta-value" });
    const weightText = row.weightText != null ? row.weightText : (row.weight > 0 ? String(row.weight) : "");
    const weight = weightText
      ? ui.bitmapTextHtml(`Weight: ${weightText}${TS_WEIGHT_GLYPH}`, { cls: "trade-screen-meta-weight" })
      : "";
    return `${value}${weight}`;
  }

  function _tsRowHtml(row, side, trade, selectState) {
    const ui = _tsUi();
    const sub = row.children.length
      ? { text: `Contains ${row.children.length} item${row.children.length === 1 ? "" : "s"}`,
          cls: "trade-screen-contains", tone: "numeric" }
      : null;
    const mark = _tsCheck({
      checked: row.selected, cls: "trade-screen-row-mark",
      dataset: { tsItem: row.id, tsSide: side, tsOn: row.selected ? 0 : 1 },
      disabled: !selectState.enabled,
      title: selectState.enabled
        ? (row.selected ? "Marked for this trade -- click to unmark" : "Not marked -- click to mark")
        : selectState.reason,
      ariaLabel: row.selected ? "Marked for this trade" : "Not marked for this trade",
    });
    return ui.rowHtml({
      cls: "trade-screen-row", chassis: "table", selected: row.selected, labelCls: "trade-screen-row-name",
      dataset: { tsRowItem: row.id, tsRowSide: side },
      iconCfg: { item: row.spriteRef, cls: "trade-screen-row-icon", size: 32, alt: row.desc },
      label: row.desc, sub,
      cells: [{ cls: "trade-screen-row-meta", html: _tsMetaHtml(row, trade) }],
      trailing: mark,
    });
  }

  function _tsSideHtml(state, side) {
    const ui = _tsUi();
    const trade = state.trade;
    const selectState = tsActionState(trade, "select");
    const term = String(state.search[side] || "").trim().toLowerCase();
    const rows = tsRows(trade, side);
    const groups = tsGroups(rows)
      .map(g => ({ key: g.key, label: g.label,
        items: term ? g.items.filter(r => r.desc.toLowerCase().includes(term)) : g.items }))
      .filter(g => g.items.length);
    const listHtml = groups.length ? groups.map(g => {
      const rowsHtml = g.items.map(r => _tsRowHtml(r, side, trade, selectState));
      if (!g.label) return rowsHtml.join("");
      const ids = g.items.map(r => r.id);
      const allOn = g.items.every(r => r.selected);
      const head = _tsCheck({
        checked: allOn, cls: "trade-screen-group-mark",
        dataset: { tsGroup: ids.join(","), tsSide: side, tsOn: allOn ? 0 : 1 },
        disabled: !selectState.enabled,
        title: selectState.enabled
          ? (allOn ? `Unmark all ${g.label}` : `Mark all ${g.label}`)
          : selectState.reason,
        ariaLabel: `${allOn ? "Unmark" : "Mark"} the whole ${g.label} group`,
      });
      return ui.rowGroupHtml({
        cls: "trade-screen-group",
        header: { label: g.label, cls: "trade-screen-group-head", actionsHtml: head },
        rows: rowsHtml,
      });
    }).join("") : ui.statusHtml({ cls: "trade-screen-empty", text: term
      ? "No goods match the search." : "Nothing on this side of the table." });
    return `<section class="trade-screen-side">
      ${ui.searchHtml({ cls: "trade-screen-search", inputCls: "trade-screen-search-input", placement: "pane-header",
        magnifier: true, value: state.search[side], placeholder: "...",
        dataAttr: `trade-screen-search-${side}`, preserveKey: `trade-screen-search-${side}`,
        ariaLabel: side === 0 ? "Search merchant goods" : "Search fortress goods" })}
      ${ui.scrollHtml({ cls: "trade-screen-list", preserveKey: `trade-screen-list-${side}`,
        ariaLabel: side === 0 ? "Merchant goods" : "Fortress goods" }, listHtml)}
    </section>`;
  }

  function _tsCommitBtn(state, action, label, tone) {
    const ui = _tsUi();
    const a = tsActionState(state.trade, action);
    const armed = state.armed === action && a.enabled;
    const titles = {
      trade: "DF's own trade logic runs on the host: the merchant may accept or counter-offer.",
      offer: "Gifts the marked fortress goods to the merchants (improves relations; no payment).",
      seize: "Seizes the marked caravan goods. The merchants stop trading and relations suffer.",
    };
    return ui.plaqueBtnHtml({
      cls: `trade-screen-commit trade-screen-commit-${action}${armed ? " active" : ""}`,
      tone: a.enabled ? (armed ? "red" : tone) : "grey",
      dataset: { tsAct: action },
      disabled: !a.enabled,
      label: armed
        ? (action === "seize" ? "Really seize? This angers the merchants"
          : action === "offer" ? "Really offer with no payment?" : label)
        : label,
      title: a.enabled ? titles[action] : a.reason,
    });
  }

  function _tsFooterHtml(state, hostCloseHtml) {
    const ui = _tsUi();
    const trade = state.trade;
    const f = tsFooter(trade);
    const selectState = tsActionState(trade, "select");
    const markAll = (side, on) => ui.plaqueBtnHtml({
      cls: "trade-screen-markall", tone: selectState.enabled ? "green" : "grey",
      dataset: { tsMarkAll: side, tsOn: on ? 1 : 0 },
      disabled: !selectState.enabled,
      label: on ? "Mark all" : "Unmark all",
      title: selectState.enabled
        ? `${on ? "Mark" : "Unmark"} every item on this side of the table`
        : selectState.reason,
    });
    const block = (line1, line2Html) => `<div class="trade-screen-totals">` +
      `${ui.bitmapTextHtml(line1, { cls: "trade-screen-totals-name", fitNativeLabel: { host: "parent" } })}${line2Html}</div>`;
    const merchantTotals =
      ui.bitmapTextHtml(f.merchantValue, { cls: "trade-screen-totals-value" }) +
      ui.bitmapTextHtml(f.profit.text, { cls: f.profit.kind === "loss" ? "trade-screen-totals-loss" : "trade-screen-totals-profit" }) +
      (f.weight
        ? ui.bitmapTextHtml(f.weight.text, { cls: f.weight.kind === "excess" ? "trade-screen-totals-excess" : "trade-screen-totals-weight" })
        : "");
    const fortTotals = ui.bitmapTextHtml(f.fortValue, { cls: "trade-screen-totals-value" });
    let center;
    if (trade && trade.counterOffer) {
      const items = Array.isArray(trade.counterOfferItems) ? trade.counterOfferItems : [];
      center = ui.statusHtml({ cls: "trade-screen-counter", text: `The merchant counter-offers${items.length
        ? `: ${items.map(i => (i && i.desc) || "").filter(Boolean).join(", ")}` : "."}` }) +
        ui.plaqueBtnHtml({ cls: "trade-screen-commit", tone: "green", dataset: { tsAct: "counter-accept" },
          label: "Accept", title: "Accept the merchant's counter-offer (native click on the host)." }) +
        ui.plaqueBtnHtml({ cls: "trade-screen-commit", tone: "red", dataset: { tsAct: "counter-decline" },
          label: "Refuse", title: "Refuse the merchant's counter-offer (native click on the host)." });
    } else {
      center = _tsCommitBtn(state, "seize", "Seize", "grey") +
        _tsCommitBtn(state, "trade", "Trade", "green") +
        _tsCommitBtn(state, "offer", "Offer as gift", "green");
    }
    // Each side's totals and mark buttons sit under that side's goods list.
    return `<div class="trade-screen-footer">
      <div class="trade-screen-footer-sides">
        <div class="trade-screen-footer-row">${block(f.merchantLine, merchantTotals)}
          <div class="trade-screen-markalls">${markAll(0, true)}${markAll(0, false)}</div></div>
        <div class="trade-screen-footer-row">${block(f.fortLine, fortTotals)}
          <div class="trade-screen-markalls">${markAll(1, true)}${markAll(1, false)}</div></div>
      </div>
      <div class="trade-screen-footer-commits"><span></span>
        <div class="trade-screen-footer-center">${center}</div>${hostCloseHtml || "<span></span>"}</div>
    </div>`;
  }

  function tradeScreenMarkup(state) {
    const ui = _tsUi();
    const trade = state.trade;
    const close = ui.artBtnHtml({ sprite: ui.TOKENS.sprites.close, cls: "info-close trade-screen-close",
      dataset: { tsClose: "" }, title: "Close this view (leaves the host's trade session as it is)",
      ariaLabel: "Close" });
    if (!trade) {
      return ui.windowHtml({ cls: "trade-screen-window", ariaLabel: "Trade at the depot",
        bodyHtml: `${close}${ui.statusHtml({ cls: "trade-screen-note", text: "Loading the trade session…" })}` });
    }
    if (trade.ok === false || !trade.open) {
      const why = trade.ok === false
        ? `Trade session state unavailable: ${trade.error || "the server did not answer."}`
        : "No trade session is open on the host.";
      const openState = (trade.guards || {}).tradeOpen === true;
      const openBtn = ui.plaqueBtnHtml({
        cls: "trade-screen-commit", tone: openState ? "green" : "grey",
        dataset: { tsAct: "open" }, disabled: !openState,
        label: "Open trade session (remote)",
        title: openState
          ? "Opens DF's own trade screen on the host; the barter is always executed natively."
          : TS_GUARD_COPY.tradeOpen,
      });
      const err = state.error ? ui.statusHtml({ cls: "trade-screen-error", tone: "warning", text: state.error }) : "";
      return ui.windowHtml({ cls: "trade-screen-window", ariaLabel: "Trade at the depot",
        bodyHtml: `${close}${ui.statusHtml({ cls: "trade-screen-note", text: why })}${openBtn}${err}` });
    }
    const head = tsHeader(trade);
    const portrait = (typeof unitPortraitMarkup === "function" && Number(trade.merchantTraderId) >= 0)
      ? unitPortraitMarkup({ id: Number(trade.merchantTraderId), name: head.name }, "trade-screen-portrait")
      : `<span class="trade-screen-portrait" data-df-identity-missing="portrait:merchant"></span>`;
    const headHtml = `<div class="trade-screen-head">${portrait}<div class="trade-screen-head-lines">
        ${ui.bitmapTextHtml(head.name, { cls: "trade-screen-head-name" })}
        ${head.quote ? ui.bitmapTextHtml(head.quote, { cls: "trade-screen-head-quote" }) : ""}
        ${head.mood ? ui.bitmapTextHtml(head.mood, { cls: "trade-screen-head-mood" }) : ""}
      </div>${close}</div>`;
    const block = tsBlockText(trade);
    const blockHtml = block ? ui.statusHtml({ cls: "trade-screen-note", tone: "warning", text: block }) : "";
    const errHtml = state.error ? ui.statusHtml({ cls: "trade-screen-error", tone: "warning", text: state.error }) : "";
    const hostClose = ui.plaqueBtnHtml({ cls: "trade-screen-host-close", dataset: { tsAct: "close" },
      label: "Close trade session on the host",
      title: "Feeds one native LEAVESCREEN to DF (selections are discarded)." });
    return ui.windowHtml({
      cls: "trade-screen-window", ariaLabel: "Trade at the depot",
      bodyHtml: `${headHtml}${blockHtml}${errHtml}
        <div class="trade-screen-body">${_tsSideHtml(state, 0)}${_tsSideHtml(state, 1)}</div>`,
      footerHtml: _tsFooterHtml(state, hostClose),
      footerCls: "trade-screen-window-footer",
    });
  }

  // ---- bring-goods-to-depot markup ------------------------------------------------------------------

  function _dgMarkSprite(r) {
    const sprites = _tsUi().TOKENS.sprites;
    return r.forbidden ? sprites.tradeProhibited
      : r.atDepot ? sprites.tradeInDepot
      : r.pending ? sprites.tradeBeingBrought
      : sprites.tradeNotSelected;
  }

  function _dgRowHtml(r, expanded) {
    const ui = _tsUi();
    const mark = ui.checkHtml({
      checked: r.pending, cls: "depot-goods-row-mark",
      sprite: _dgMarkSprite(r), activeSprite: _dgMarkSprite(r),
      dataset: { dgItem: r.id, dgOn: r.pending ? 0 : 1 },
      title: r.forbidden ? "Forbidden -- cannot be traded"
        : r.atDepot ? "At the depot"
        : r.pending ? "Marked for trade (being brought to the depot)"
        : "Not marked for trade",
      ariaLabel: r.pending ? "Marked for trade" : "Not marked for trade",
    });
    const meta = ui.bitmapTextHtml(`Distance: ${r.dist}`, { cls: "depot-goods-meta-dist" }) +
      ui.bitmapTextHtml(`Value: ${r.value}${TS_VALUE_GLYPH}`, { cls: "depot-goods-meta-value" });
    const exp = expanded[r.id];
    const row = ui.rowHtml({
      cls: "depot-goods-row", chassis: "table", selected: r.pending, labelCls: "trade-screen-row-name",
      dataset: { dgRow: r.id },
      title: "Click the name to expand a container inline; click the check tile to mark for trade",
      iconCfg: { item: null, cls: "depot-goods-row-icon", size: 32, alt: r.desc },
      label: r.desc,
      cells: [{ cls: "depot-goods-row-meta", html: meta }],
      trailing: mark,
    });
    if (!exp) return row;
    let childHtml;
    if (exp.loading) {
      childHtml = ui.statusHtml({ cls: "depot-goods-child-note", text: "Loading contents…" });
    } else if (exp.error) {
      childHtml = ui.statusHtml({ cls: "depot-goods-child-note", tone: "warning", text: exp.error });
    } else if (!exp.contents.length) {
      childHtml = ui.statusHtml({ cls: "depot-goods-child-note", text: "This item contains nothing." });
    } else {
      childHtml = exp.contents.map(c => ui.rowHtml({
        cls: "depot-goods-child-row", chassis: "table", labelCls: "trade-screen-row-name",
        iconCfg: { item: c.spriteRef || null, cls: "depot-goods-row-icon", size: 32, alt: c.name },
        label: c.name,
      })).join("");
    }
    return `${row}<div class="depot-goods-children">${childHtml}</div>`;
  }

  function depotGoodsScreenMarkup(state) {
    const ui = _tsUi();
    const close = ui.artBtnHtml({ sprite: ui.TOKENS.sprites.close, cls: "info-close depot-goods-close",
      dataset: { dgClose: "" }, title: "Close", ariaLabel: "Close" });
    if (!state.goods) {
      return ui.windowHtml({ cls: "depot-goods-window", ariaLabel: "Move goods to the trade depot",
        bodyHtml: `${close}${ui.statusHtml({ cls: "depot-goods-note", text: "Loading tradeable goods…" })}` });
    }
    if (state.goods.ok === false) {
      return ui.windowHtml({ cls: "depot-goods-window", ariaLabel: "Move goods to the trade depot",
        bodyHtml: `${close}${ui.statusHtml({ cls: "depot-goods-note", tone: "warning",
          text: state.goods.error || "Goods unavailable." })}` });
    }
    const rows = dgRows(state.goods);
    const groups = dgGroups(rows, state.goodsSearch, state.goodsSort);
    const listHtml = groups.length ? groups.map(g => {
      const allOn = g.items.every(r => r.pending);
      const markable = g.items.filter(r => !r.forbidden);
      const head = ui.checkHtml({
        checked: allOn, cls: "depot-goods-group-mark",
        sprite: ui.TOKENS.sprites.tradeNotSelected, activeSprite: ui.TOKENS.sprites.tradeSelected,
        dataset: { dgGroup: markable.map(r => r.id).join(","), dgOn: allOn ? 0 : 1 },
        disabled: !markable.length,
        title: markable.length
          ? `${allOn ? "Unmark" : "Mark"} the whole ${g.label} group`
          : "Every item in this group is forbidden",
        ariaLabel: `${allOn ? "Unmark" : "Mark"} the whole ${g.label} group`,
      });
      const count = g.count > 1 ? ui.bitmapTextHtml(`[${g.count}]`, { cls: "dwfui-group-count" }) : "";
      return DWFUI.rowHtml({
        cls: "depot-goods-group depot-goods-group-head", label: g.label, labelCls: "dwfui-group-label",
        trailing: count + head,
      }) + g.items.map(r => _dgRowHtml(r, state.goodsExpanded)).join("");
    }).join("") : ui.statusHtml({ cls: "depot-goods-note", text: "No tradeable goods match." });
    const sprites = ui.TOKENS.sprites;
    const tools = ui.actionButtonsHtml([
      { action: "cull", sprite: state.goodsCull ? sprites.tradeCullMandatesOn : sprites.tradeCullMandatesOff,
        dataset: { dgTool: "cull" }, disabled: true, placeholder: true,
        title: "Native's mandate-culling filter (hide goods that would violate export mandates). " +
          "Disabled: /depot-goods does not serve a mandate flag yet -- plugin update required." },
      { action: "sortDistance",
        sprite: state.goodsSort === "distance" ? sprites.tradeSortDistanceOn : sprites.tradeSortDistanceOff,
        active: state.goodsSort === "distance",
        dataset: { dgTool: "sort-distance" }, title: "Sort by distance to the depot" },
      { action: "sortValue",
        sprite: state.goodsSort === "value" ? sprites.tradeSortValueOn : sprites.tradeSortValueOff,
        active: state.goodsSort === "value",
        dataset: { dgTool: "sort-value" }, title: "Sort by value" },
      { action: "selectAll", sprite: sprites.selectAll, gapBefore: true,
        dataset: { dgTool: "select-all" },
        title: "Mark every item currently listed for trade" },
    ], { cls: "depot-goods-tools", ariaLabel: "Goods list tools" });
    const truncNote = state.goods.truncated
      ? ui.statusHtml({ cls: "depot-goods-note", text: `Showing the first ${state.goods.cap} items -- refine with the search.` })
      : "";
    const gapNote = ui.statusHtml({ cls: "depot-goods-gap-note", text:
      "Category rail and native type-groups need a /depot-goods plugin update (item type is not served yet)." });
    return ui.windowHtml({
      cls: "depot-goods-window", ariaLabel: "Move goods to the trade depot",
      bodyHtml: `<div class="depot-goods-top">
          ${ui.searchHtml({ cls: "depot-goods-search", inputCls: "depot-goods-search-input", placement: "pane-header",
            magnifier: true, value: state.goodsSearch, placeholder: "...",
            dataAttr: "depot-goods-search", preserveKey: "depot-goods-search", ariaLabel: "Search tradeable goods" })}
          ${tools}${close}
        </div>
        ${truncNote}
        ${ui.scrollHtml({ cls: "depot-goods-list", rows: ".depot-goods-row", preserveKey: "depot-goods-list",
          ariaLabel: "Tradeable goods" }, listHtml)}
        ${gapNote}`,
    });
  }

  // ---- state + wiring (browser only) ---------------------------------------------------------------

  let _tsState = null;   // barter screen
  let _dgState = null;   // bring-goods screen

  function _tsStopPoll() {
    if (_tsState && _tsState.pollTimer) { clearInterval(_tsState.pollTimer); _tsState.pollTimer = null; }
  }

  function _tsCloseView() {
    _tsStopPoll();
    _tsState = null;
    if (typeof closeClientPanel === "function") closeClientPanel();
    if (typeof focusPage === "function") focusPage();
  }

  function _dgCloseView() {
    _dgState = null;
    if (typeof closeClientPanel === "function") closeClientPanel();
    if (typeof focusPage === "function") focusPage();
  }

  async function _tsRefresh() {
    if (!_tsState) return;
    try { _tsState.trade = await _tsFetchJson(`/depot-trade?t=${Date.now()}`); }
    catch (err) { _tsState.trade = { ok: false, error: err.message || "unavailable" }; }
  }

  function _tsRender() {
    const s = _tsState;
    if (!s || typeof clientPanel === "undefined") return;
    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = tradeScreenMarkup(s);
    const ui = _tsUi();
    if (typeof ui.restoreSearchCaret === "function") ui.restoreSearchCaret(clientPanel);
    if (typeof ui.restoreScroll === "function") ui.restoreScroll(clientPanel);
    _tsWire();
  }

  async function _tsAction(query) {
    const s = _tsState;
    if (!s || s.busy) return;
    s.busy = true;
    s.error = "";
    try { await _tsPost(`/depot-trade?${query}`); }
    catch (err) { s.error = err.message || "trade action failed"; }
    await _tsRefresh();
    s.busy = false;
    _tsRender();
  }

  function _tsWire() {
    const s = _tsState;
    if (!s) return;
    clientPanel.querySelector("[data-ts-close]")?.addEventListener("click", e => {
      e.stopPropagation(); _tsCloseView();
    });
    // Item + group checkboxes -> the native goodflag selection bits.
    clientPanel.querySelectorAll("[data-ts-item]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      _tsAction(`action=select&side=${el.dataset.tsSide}&items=${el.dataset.tsItem}&on=${el.dataset.tsOn}`);
    }));
    clientPanel.querySelectorAll("[data-ts-group]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      _tsAction(`action=select&side=${el.dataset.tsSide}&items=${el.dataset.tsGroup}&on=${el.dataset.tsOn}`);
    }));
    clientPanel.querySelectorAll("[data-ts-mark-all]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const side = Number(el.dataset.tsMarkAll);
      const ids = tsRows(s.trade, side).filter(r => !r.contained).map(r => r.id);
      if (!ids.length) return;
      _tsAction(`action=select&side=${side}&items=${ids.join(",")}&on=${el.dataset.tsOn}`);
    }));
    // Commits. Offer/Seize are one-way doors: a first click ARMS, the second fires.
    clientPanel.querySelectorAll("[data-ts-act]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const act = el.dataset.tsAct;
      if ((act === "offer" || act === "seize") && s.armed !== act) {
        s.armed = act;
        _tsRender();
        return;
      }
      s.armed = "";
      if (act === "open") { _tsAction(`action=open&id=${s.depotId}`); return; }
      _tsAction(`action=${act}`);
    }));
    // Per-side searches: client-side filter; re-render keeps caret via preserveKey.
    for (const side of [0, 1]) {
      const input = clientPanel.querySelector(`[data-trade-screen-search-${side}]`);
      if (!input) continue;
      input.addEventListener("keydown", e => e.stopPropagation());
      input.addEventListener("input", () => { s.search[side] = input.value || ""; _tsRender(); });
    }
  }

  async function openTradeScreen(depotId) {
    _tsStopPoll();
    _tsState = { depotId: Number(depotId), trade: null, error: "", busy: false,
                 armed: "", search: { 0: "", 1: "" }, pollTimer: null };
    _tsRender();
    await _tsRefresh();
    if (!_tsState) return;
    _tsRender();
    // Live poll: guards + selections + counter-offers flip on the host at any time. Re-render
    // only when the payload actually changed, so the search caret / scroll stay untouched.
    let lastJson = JSON.stringify(_tsState.trade);
    _tsState.pollTimer = setInterval(async () => {
      const s = _tsState;
      if (!s || s.busy) return;
      if (!clientPanel.querySelector(".trade-screen-window")) { _tsStopPoll(); return; }
      await _tsRefresh();
      const nowJson = JSON.stringify(s.trade);
      if (nowJson !== lastJson) { lastJson = nowJson; _tsRender(); }
    }, 2000);
  }

  // ---- bring-goods wiring -------------------------------------------------------------------------

  async function _dgRefresh() {
    if (!_dgState) return;
    try { _dgState.goods = await _tsFetchJson(`/depot-goods?id=${_dgState.depotId}&t=${Date.now()}`); }
    catch (err) { _dgState.goods = { ok: false, error: err.message || "goods unavailable" }; }
  }

  function _dgRender() {
    const s = _dgState;
    if (!s || typeof clientPanel === "undefined") return;
    clientPanel.className = "visible info-panel";
    panelContent(clientPanel).innerHTML = depotGoodsScreenMarkup(s);
    const ui = _tsUi();
    if (typeof ui.restoreSearchCaret === "function") ui.restoreSearchCaret(clientPanel);
    if (typeof ui.restoreScroll === "function") ui.restoreScroll(clientPanel);
    _dgWire();
  }

  async function _dgMark(ids, on) {
    const s = _dgState;
    if (!s || s.busy) return;
    s.busy = true;
    let failed = 0;
    let lastError = null;
    for (const id of ids) {
      try { await _tsPost(`/depot-mark?id=${s.depotId}&item=${id}&on=${on}`); } catch (err) { failed++; lastError = err; }
    }
    if (failed) globalThis.DwfOrder.lost("trade.mark-goods", lastError, `${failed} ${failed === 1 ? "item" : "items"} could not be traded`);
    await _dgRefresh();
    s.busy = false;
    _dgRender();
  }

  async function _dgExpand(id) {
    const s = _dgState;
    if (!s) return;
    if (s.goodsExpanded[id]) { delete s.goodsExpanded[id]; _dgRender(); return; }
    s.goodsExpanded[id] = { loading: true, contents: [] };
    _dgRender();
    try {
      const who = (typeof player !== "undefined" && player) ? player : "";
      // action=info only reads, but it shares the item-action route, which accepts POST only.
      const info = await _tsFetchJson(
        `/stock-item-action?player=${encodeURIComponent(who)}&id=${id}&action=info&t=${Date.now()}`, "POST");
      const contents = Array.isArray(info.contents) ? info.contents.filter(Boolean) : [];
      if (s.goodsExpanded[id]) s.goodsExpanded[id] = { loading: false, contents };
    } catch (err) {
      if (s.goodsExpanded[id])
        s.goodsExpanded[id] = { loading: false, contents: [], error: err.message || "contents unavailable" };
    }
    _dgRender();
  }

  function _dgWire() {
    const s = _dgState;
    if (!s) return;
    clientPanel.querySelector("[data-dg-close]")?.addEventListener("click", e => {
      e.stopPropagation(); _dgCloseView();
    });
    clientPanel.querySelectorAll("[data-dg-item]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      _dgMark([el.dataset.dgItem], el.dataset.dgOn);
    }));
    clientPanel.querySelectorAll("[data-dg-group]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const ids = String(el.dataset.dgGroup || "").split(",").filter(Boolean);
      if (ids.length) _dgMark(ids, el.dataset.dgOn);
    }));
    // Row body click (not the check tile) toggles inline container expansion.
    clientPanel.querySelectorAll("[data-dg-row]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      _dgExpand(Number(el.dataset.dgRow));
    }));
    clientPanel.querySelectorAll("[data-dg-tool]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const tool = el.dataset.dgTool;
      if (tool === "sort-distance") { s.goodsSort = s.goodsSort === "distance" ? "" : "distance"; _dgRender(); return; }
      if (tool === "sort-value") { s.goodsSort = s.goodsSort === "value" ? "" : "value"; _dgRender(); return; }
      if (tool === "select-all") {
        const shown = dgGroups(dgRows(s.goods), s.goodsSearch, s.goodsSort)
          .flatMap(g => g.items).filter(r => !r.forbidden && !r.pending);
        if (shown.length) _dgMark(shown.map(r => r.id), 1);
      }
    }));
    const input = clientPanel.querySelector("[data-depot-goods-search]");
    if (input) {
      input.addEventListener("keydown", e => e.stopPropagation());
      input.addEventListener("input", () => { s.goodsSearch = input.value || ""; _dgRender(); });
    }
  }

  async function openDepotGoodsScreen(depotId) {
    _dgState = { depotId: Number(depotId), goods: null, busy: false,
                 goodsSearch: "", goodsSort: "distance", goodsCull: false, goodsExpanded: {} };
    _dgRender();
    await _dgRefresh();
    if (!_dgState) return;
    _dgRender();
  }

  // ---- exports -------------------------------------------------------------------------------------

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      tsRows, tsGroups, tsTotals, tsFooter, tsHeader, tsBlockText, tsActionState, tsGroupLabel,
      dgRows, dgGroups, dgGroupKey,
      tradeScreenMarkup, depotGoodsScreenMarkup,
      TS_VALUE_GLYPH, TS_WEIGHT_GLYPH,
    };
  }
  if (typeof window !== "undefined") {
    window.DFTradeScreen = { openTradeScreen, openDepotGoodsScreen, tradeScreenMarkup, depotGoodsScreenMarkup };
  }
