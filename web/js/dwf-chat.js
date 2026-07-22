// dwf - WP-D MULTIPLAYER CHAT (friends-tier), client consumer.
//
// A collapsible chat box (bottom-left, never covers the map) for players to talk to each other.
// Server-authoritative relay: the host assigns each line a monotonic `seq`, holds a short
// scrollback ring, and pushes {"type":"chat",...} over the SAME WebSocket the map rides. This
// module is the self-contained consumer, routed the live frame by dwf-ws.js (mirrors the
// pause/busy modules); it also fetches GET /chat for scrollback on join and to fill any seq gap.
//
// CHAT LINK WIRE GRAMMAR (stored inside the existing raw `text` field, no server change):
//   [[loc:<signed-decimal-x>,<signed-decimal-y>,<signed-decimal-z>]]
//   [[unit:<nonnegative-decimal-id>|<1..80 chars other than |, ], CR, or LF>]]
// Old clients display either token literally; this client turns valid tokens into links at render
// time. A unit token intentionally carries no position: clicks resolve its id against the current
// AUX roster so a walking dwarf is followed to its CURRENT tile, not its tile when authored.
//
// SECURITY -- the chat box is an INJECTION SURFACE. Every piece of player-supplied text (message
// bodies, token labels, URLs, AND names) is rendered as INERT TEXT via textContent, NEVER inserted
// as HTML. Trusted composer chrome/suggestion markup comes only from DWFUI's escaping builders.
// A message like `<img src=x onerror=alert(1)>` therefore shows as literal characters and can
// never execute. buildLineNode() is the single message render path and is tested adversarially
// (tools/harness/chat_client_test.mjs).
//
// GRACEFUL-DORMANT -- against an OLD host DLL that predates chat: GET /chat 404s (no route) and no
// live {"type":"chat"} frame ever arrives, so the box shows a disabled "Chat unavailable - host
// needs update" state instead of a broken input. If a live chat frame DOES arrive later (host was
// updated), the box self-enables. Deployable web-only: with a chat-less host it simply stays
// dormant; with a chat-capable host it lights up.
(function () {
  "use strict";

  // DWFUI contract -- see dwf-escmenu.js. Presence-guarded (the offline harness loads this file
  // with a stub DOM), but NOT throw-swallowing.
  if (typeof DWFUI !== "undefined" && typeof DWFUI.require === "function")
    DWFUI.require("chat", ["headerHtml", "scrollHtml", "rowHtml", "plaqueBtnHtml",
      "actionButtonsHtml", "esc"]);

  var MAX_LEN = 500;          // per-line client clamp (server hard-clamps to the same; the WS recv
                              // path also drops any control frame > 4096 bytes, bounding a paste)
  var HISTORY_KEEP = 100;     // rendered-line cap (matches the server ring)
  var INT32_MIN = -2147483648;
  var INT32_MAX = 2147483647;
  var SPECIAL_RE = /\[\[loc:-?\d{1,10},-?\d{1,10},-?\d{1,10}\]\]|\[\[unit:\d{1,10}\|[^\]|\r\n]{1,80}\]\]|https?:\/\/[^\s<>"']+/ig;
  var LOC_RE = /^\[\[loc:(-?\d{1,10}),(-?\d{1,10}),(-?\d{1,10})\]\]$/;
  var UNIT_RE = /^\[\[unit:(\d{1,10})\|([^\]|\r\n]{1,80})\]\]$/;

  // ---- state ---------------------------------------------------------------------------------
  var supported = null;       // null=unknown, true=host relays chat, false=dormant (old host)
  var lastSeq = 0;            // highest seq we've applied
  var lines = new Map();      // seq -> {seq, system, from, text, ts}; the source of truth we render
  var open = false;
  var unread = 0;
  var els = {};               // cached DOM handles
  var booted = false;
  var activeMention = null;   // {start,end,matches}; live @completion state in the composer
  var navigationHooks = null; // offline-test seam; null in production

  function selfName() {
    try { return (typeof window.playerName === "string" && window.playerName) ? window.playerName : ""; }
    catch (_) { return ""; }
  }
  function colorFor(name) {
    try {
      if (window.DwfTiles && typeof window.DwfTiles.playerColor === "function")
        return window.DwfTiles.playerColor(name).fill;
    } catch (_) {}
    return "#8cf";   // fallback if the canonical color helper isn't loaded yet
  }

  function storyPartHtml(part) {
    var text = window.DWFUI.esc(part.kind === "location"
      ? ("Location " + part.pos.x + ", " + part.pos.y + ", " + part.pos.z)
      : (part.kind === "unit" ? ("@" + part.label) : part.text));
    if (part.kind === "url") return '<a class="dfchat-link dfchat-url" href="' + window.DWFUI.esc(part.url) + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
    if (part.kind === "location") return '<a class="dfchat-link dfchat-location" href="#" data-chat-location="' + part.pos.x + "," + part.pos.y + "," + part.pos.z + '">' + text + "</a>";
    if (part.kind === "unit") return '<a class="dfchat-link dfchat-unit" href="#" data-chat-unit="' + part.id + '">' + text + "</a>";
    return "<span>" + text + "</span>";
  }

  function chatStoryLineHtml(msg, self) {
    if (msg && msg.system) return '<div class="dfchat-line dfchat-system"><span>' + window.DWFUI.esc(msg.text || "") + "</span></div>";
    var from = String(msg && msg.from || "");
    var you = self && from === self ? ' <span class="dfchat-you">(you)</span>' : "";
    var body = parseChatText(msg && msg.text || "").map(storyPartHtml).join("");
    return '<div class="dfchat-line"><span class="dfchat-name" style="color:' + window.DWFUI.esc(msg && msg.color || colorFor(from)) + '">' +
      window.DWFUI.esc(from) + you + '</span><span>: </span><span class="dfchat-body">' + body + "</span></div>";
  }

  // ---- THE SHARED COMPOSER CHROME -------------------------------------------------------------
  // *** THIS MODULE HAD TWO DIFFERENT RENDER PATHS AND THE STUDIO SHOWED THE WRONG ONE. ***
  // chatStoryMarkup() (the Studio card) built a DWFUI panel; build() -- THE PATH THE REAL CLIENT
  // RUNS -- hand-built the SAME chrome with document.createElement and a `closeBtn.textContent = "x"`.
  // So a lane could migrate the story, watch the Studio go green, and change NOTHING A PLAYER SEES.
  // The chrome is defined ONCE here, and BOTH paths consume it: build() lifts real nodes out of this
  // markup instead of hand-building lookalikes. There is now no second definition to drift.
  function chatHeadHtml() {
    // `glyph: "&times;"` DROPPED: headerHtml renders the NATIVE close tile (artBtnHtml) instead of a
    // raw button holding a Unicode x. `.dfchat-close` is a CLOSE_SEL member (dwf-panelframe.js),
    // so PanelFrame's one-close reconciliation still finds exactly one close -- panel_frame_test pins it.
    return window.DWFUI.headerHtml({
      cls: "dfchat-head", titleTag: "span", title: "Chat",
      close: { cls: "dfchat-close", title: "Close chat", ariaLabel: "Close chat" },
    });
  }
  function chatSendHtml(disabled) {
    return window.DWFUI.plaqueBtnHtml({
      label: "Send", tone: "green", cls: "dfchat-send", dataset: { chatSend: "" },
      disabled: !!disabled, title: "Send this message",
    });
  }
  // ONE config for the ping cluster, consumed by BOTH paths. (ui_components_test pins the literal
  // `authorTools.innerHTML = DWFUI.actionButtonsHtml(` call in build() -- that gate is not this
  // lane's to edit, and it is right: the LIVE path must visibly consume the factory. So build()
  // keeps the direct call and shares these exact arguments, which is what makes drift impossible.)
  //
  // B223: this button used to stamp the CURRENT CAMERA CENTRE into the composer as a [[loc:]] token
  // that the player then had to send by hand -- wrong twice over ("it should then wait for you
  // to click on a unit or a location, and then send that ping in chat automatically"). It is now an
  // ARM button for the map-side one-shot pick (window.DFChatPing, dwf-controls-placement.js).
  var CHAT_PING_ITEMS = [{
    action: "follow", dataset: { chatPingArm: "" }, title: "Ping a unit or location on the map",
  }];
  var CHAT_PING_OPTS = { cls: "dfchat-author-actions", btnCls: "dfchat-ping-location", ariaLabel: "Chat pings" };
  function chatAuthorToolsHtml() {
    return window.DWFUI.actionButtonsHtml(CHAT_PING_ITEMS, CHAT_PING_OPTS);
  }
  // The log is the F5 case the owner called "very important": a raw `overflow-y:auto` region renders the
  // BROWSER-DEFAULT scrollbar. scrollHtml puts it on the native bar.
  //
  // *** preserveKey IS DELIBERATELY NOT PASSED. *** restoreScroll() restores an ABSOLUTE scrollTop,
  // and mountDom's MutationObserver calls it on every childList change -- which is every new chat
  // line. On a log that must STICK TO THE BOTTOM as it grows, that would actively drag the player
  // back to a stale offset on each message. Chat's stick-to-bottom math in render() is NOT migration
  // debt; it is different semantics, and it stays.
  function chatLogHtml(rows) {
    return window.DWFUI.scrollHtml({ cls: "dfchat-log", ariaLabel: "Chat log" }, rows || "");
  }

  function chatStoryMarkup(options) {
    options = options || {};
    var history = collapsePresenceLines((options.lines || []).slice().sort(function (a, b) { return Number(a.seq || 0) - Number(b.seq || 0); }));
    var rows = history.map(function (msg) { return chatStoryLineHtml(msg, options.self || ""); }).join("") || '<div id="dfChatEmpty">No messages yet.</div>';
    var note = options.supported === false ? "Chat unavailable - host needs update." : "";
    return '<div id="dfChatToggle"' + (options.open === false ? "" : ' style="display:none"') + '><span>Chat</span><span class="dfchat-badge' + (options.unread ? " show" : "") + '">' + (options.unread || "") + "</span></div>" +
      '<section id="dfChatPanel" class="' + (options.open === false ? "" : "open") + '">' +
      chatHeadHtml() +
      '<div id="dfChatLog">' + chatLogHtml(rows) + '</div>' +
      '<div id="dfChatNote" class="' + (note ? "show" : "") + '">' + window.DWFUI.esc(note) + "</div>" +
      '<div id="dfChatFoot"><span class="dfchat-author-tools">' + chatAuthorToolsHtml() + '</span><input id="dfChatInput" type="text" maxlength="' + MAX_LEN + '" placeholder="' + (note ? "Chat unavailable" : "Message... (@ to mention)") + '" autocomplete="off"' + (note ? " disabled" : "") + '>' + chatSendHtml(!!note) + '<div id="dfChatUnitPicker" role="listbox" aria-label="Mention a character"></div></div></section>';
  }

  function int32(value, nonnegative) {
    var n = Number(value);
    if (!Number.isInteger(n) || n < (nonnegative ? 0 : INT32_MIN) || n > INT32_MAX) return null;
    return n;
  }

  function mapPos(value) {
    if (!value) return null;
    var x = int32(value.x, false), y = int32(value.y, false), z = int32(value.z, false);
    return x == null || y == null || z == null ? null : { x: x, y: y, z: z };
  }

  function locationToken(pos) {
    var p = mapPos(pos);
    return p ? "[[loc:" + p.x + "," + p.y + "," + p.z + "]]" : "";
  }

  function cleanUnitLabel(value) {
    return String(value == null ? "" : value).replace(/[|\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function unitToken(unit) {
    var id = int32(unit && unit.id, true);
    if (id == null) return "";
    var label = cleanUnitLabel(unit && unit.name) || ("Unit " + id);
    return "[[unit:" + id + "|" + label + "]]";
  }

  function pushText(parts, text) {
    if (!text) return;
    var last = parts[parts.length - 1];
    if (last && last.kind === "text") last.text += text;
    else parts.push({ kind: "text", text: text });
  }

  // Parse only the two exact token forms above plus plain http(s) URLs. Anything malformed stays
  // ordinary text, which is both the legacy-degrade contract and the fail-closed security path.
  function parseChatText(value) {
    var text = String(value == null ? "" : value);
    var parts = [], cursor = 0, match;
    SPECIAL_RE.lastIndex = 0;
    while ((match = SPECIAL_RE.exec(text))) {
      pushText(parts, text.slice(cursor, match.index));
      var raw = match[0], loc = LOC_RE.exec(raw), unit = UNIT_RE.exec(raw);
      if (loc) {
        var pos = mapPos({ x: loc[1], y: loc[2], z: loc[3] });
        if (pos) parts.push({ kind: "location", text: raw, pos: pos });
        else pushText(parts, raw);
      } else if (unit) {
        var id = int32(unit[1], true);
        if (id != null) parts.push({ kind: "unit", text: raw, id: id, label: unit[2] });
        else pushText(parts, raw);
      } else {
        // Sentence punctuation is not part of a pasted URL. Put it back as ordinary text.
        var url = raw, suffix = "";
        while (/[),.!?;:\]}]$/.test(url)) { suffix = url.slice(-1) + suffix; url = url.slice(0, -1); }
        if (/^https?:\/\//i.test(url)) parts.push({ kind: "url", text: url, url: url });
        else pushText(parts, url);
        pushText(parts, suffix);
      }
      cursor = match.index + raw.length;
    }
    pushText(parts, text.slice(cursor));
    return parts;
  }

  function currentUnits() {
    try {
      var latest = window.DwfTiles && typeof window.DwfTiles.getLatest === "function"
        ? window.DwfTiles.getLatest() : null;
      return latest && Array.isArray(latest.units) ? latest.units : [];
    } catch (_) { return []; }
  }

  function unitRoster(query) {
    var q = String(query == null ? "" : query).trim().toLowerCase();
    var seen = {}, out = [];
    currentUnits().forEach(function (unit) {
      var id = int32(unit && unit.id, true), name = cleanUnitLabel(unit && unit.name);
      if (id == null || !name || seen[id] || (q && name.toLowerCase().indexOf(q) < 0)) return;
      seen[id] = true;
      out.push({ id: id, name: name, x: unit.x, y: unit.y, z: unit.z });
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name) || a.id - b.id; });
    return out;
  }

  function resolveUnitPing(id) {
    id = int32(id, true);
    if (id == null) return null;
    var units = currentUnits();
    for (var i = 0; i < units.length; i++) {
      if (int32(units[i] && units[i].id, true) !== id) continue;
      var pos = mapPos(units[i]);
      return pos ? { id: id, name: cleanUnitLabel(units[i].name), pos: pos } : null;
    }
    return null;
  }

  function routingPlayer() {
    try { if (typeof player !== "undefined" && player) return player; } catch (_) {}
    try { return window.playerName || ""; } catch (_) { return ""; }
  }

  async function resolveCurrentUnit(id) {
    var live = resolveUnitPing(id);
    if (live) return live;
    id = int32(id, true);
    if (id == null) return null;
    // A mentioned unit can walk off the currently streamed AUX window. The existing /unit route
    // is the authoritative fallback and returns its current tile without new server plumbing.
    try {
      var response = await fetch("/unit?player=" + encodeURIComponent(routingPlayer()) +
        "&id=" + encodeURIComponent(id) + "&t=" + Date.now(), { cache: "no-store" });
      if (!response.ok) return null;
      var data = await response.json(), pos = mapPos(data && (data.tile || data.unit));
      return pos ? { id: id, name: cleanUnitLabel(data && data.unit && data.unit.name),
        pos: pos, sheetData: data } : null;
    } catch (_) { return null; }
  }

  function cameraJump(pos) {
    var p = mapPos(pos);
    if (!p) return Promise.resolve(false);
    try {
      if (navigationHooks && typeof navigationHooks.cameraJump === "function")
        return Promise.resolve(navigationHooks.cameraJump(p));
      if (typeof setCameraToMapPos === "function") return Promise.resolve(setCameraToMapPos(p));
    } catch (_) {}
    return Promise.resolve(false);
  }

  function openUnitSheet(id, data) {
    try {
      if (navigationHooks && typeof navigationHooks.openUnit === "function") return navigationHooks.openUnit(id);
      if (data && typeof showUnitSheet === "function") return showUnitSheet(data);
      if (typeof openUnitById === "function") return openUnitById(id);
    } catch (_) {}
  }

  function jumpToLocation(pos) { return cameraJump(pos); }

  async function jumpToUnit(id) {
    var current = await resolveCurrentUnit(id);
    if (!current) { flashNote("That unit is no longer available."); return false; }
    var jumped = await cameraJump(current.pos);
    // The existing unit opener is already cheap plumbing; keep it after the camera move so the
    // sheet's live refresh starts from the unit's new z-level.
    openUnitSheet(current.id, current.sheetData);
    return jumped !== false;
  }

  // ---- style (injected once; self-contained, no shared-CSS dependency) -----------------------
  function ensureStyle() {
    if (document.getElementById("dfChatStyle")) return;
    var st = document.createElement("style");
    st.id = "dfChatStyle";
    // R1: 24 hex literals -- a private palette -- replaced by the shared --dwfui-* custom properties
    // (F1's MEASURED native palette). No colour is stated in this module. Geometry stays.
    // The dead `#dfChatSend` skin is DELETED with its control: Send is a DWFUI plaque now, and
    // `#dfChatLog`'s `overflow-y:auto` is DELETED because the log is DWFUI.scrollHtml -- restating
    // overflow here is exactly what manufactured the browser-default scrollbar the owner flagged.
    st.textContent =
      // WT20 (mobile): bottom offsets ride the --dfvv-kb-inset var (maintained by
      // dwf-touch.js from visualViewport) so the toggle+panel lift above an OVERLAY
      // on-screen keyboard (iOS). Everywhere else the var is 0px -> geometry unchanged.
      "#dfChatToggle{position:fixed;left:8px;bottom:calc(52px + var(--dfvv-kb-inset, 0px));z-index:8980;font-family:inherit;" +
        "background:var(--dwfui-surface);color:var(--dwfui-text-body);border:1px solid var(--dwfui-gold-bevel-dark);" +
        "padding:6px 12px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.5);" +
        "display:flex;align-items:center;gap:7px;user-select:none}" +
      "#dfChatToggle:hover{border-color:var(--dwfui-gold)}" +
      "#dfChatToggle .dfchat-badge{background:var(--dwfui-destructive);color:var(--dwfui-text-title);border-radius:9px;min-width:16px;" +
        "height:16px;padding:0 4px;font-size:11px;line-height:16px;text-align:center;display:none}" +
      "#dfChatToggle .dfchat-badge.show{display:inline-block}" +
      "#dfChatPanel{position:fixed;left:8px;bottom:calc(52px + var(--dfvv-kb-inset, 0px));z-index:8981;width:300px;height:270px;" +
        "display:none;flex-direction:column;font-family:inherit;background:var(--dwfui-surface);" +
        "border:1px solid var(--dwfui-gold-bevel-dark);box-shadow:0 4px 16px rgba(0,0,0,.6);overflow:hidden}" +
      "#dfChatPanel.open{display:flex}" +
      "#dfChatPanel .dfchat-head{display:flex;align-items:center;justify-content:space-between;" +
        "padding:7px 10px;background:var(--dwfui-hatch);border-bottom:1px solid var(--dwfui-gold-bevel-dark);font-size:13px;" +
        "color:var(--dwfui-text-body);font-weight:600}" +
      "#dfChatPanel .dfchat-close{cursor:pointer;line-height:1;background:none;border:none;padding:0 2px}" +
      "#dfChatLog{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}" +
      "#dfChatLog .dfchat-log{flex:1 1 auto;min-height:0;padding:8px 10px;font-size:12.5px;line-height:1.45;color:var(--dwfui-text-body)}" +
      ".dfchat-line{margin:2px 0;word-wrap:break-word;overflow-wrap:anywhere}" +
      ".dfchat-line .dfchat-name{font-weight:600}" +
      ".dfchat-line .dfchat-you{opacity:.75;font-weight:400;font-style:italic}" +
      ".dfchat-line.dfchat-system{color:var(--dwfui-text-secondary);font-style:italic}" +
      ".dfchat-line .dfchat-time{color:var(--dwfui-text-secondary);font-size:10.5px;margin-right:5px}" +
      ".dfchat-link{color:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer}" +
      ".dfchat-link:hover{opacity:.78}" +
      "#dfChatEmpty{color:var(--dwfui-text-secondary);font-style:italic;padding:4px 0}" +
      "#dfChatFoot{position:relative;display:flex;gap:6px;padding:8px;align-items:center;" +
        "border-top:1px solid var(--dwfui-gold-bevel-dark);background:var(--dwfui-hatch)}" +
      "#dfChatFoot .dfchat-author-actions{flex:0 0 auto}" +
      "#dfChatFoot .dfchat-author-actions button{width:30px;height:30px}" +
      // B223: the ARMED ping button. `.active` is DWFUI's own action-button state class (the button
      // is re-rendered through actionButtonsHtml with active:true), so this is a skin for an
      // existing state, not a private one. It reads as "this tool is live" while the map waits for
      // the player's pick -- the same read as the crosshair the map puts up at the same moment.
      "#dfChatFoot .dfchat-author-actions button.active{outline:1px solid var(--dwfui-gold-bright);" +
        "outline-offset:-1px;background:var(--dwfui-gold-bevel-dark)}" +
      "#dfChatFoot .dfchat-send{flex:0 0 auto}" +
      // DELIBERATE EXCEPTION (spec invariant): "editable inputs stay DOM inputs". The composer is
      // the one control here that native has no analog for and that must remain a real text field.
      "#dfChatInput{flex:1;background:var(--dwfui-ink);color:var(--dwfui-text-body);" +
        "border:1px solid var(--dwfui-gold-bevel-dark);padding:6px 8px;font-size:12.5px;font-family:inherit}" +
      "#dfChatInput:disabled{opacity:.5}" +
      "#dfChatUnitPicker{position:absolute;left:8px;right:8px;bottom:100%;display:none;" +
        "max-height:180px;overflow:hidden;background:var(--dwfui-surface);border:1px solid var(--dwfui-gold-bevel-dark)}" +
      "#dfChatUnitPicker.show{display:flex}" +
      "#dfChatUnitPicker .dfchat-unit-list{width:100%;display:flex;flex-direction:column}" +
      "#dfChatUnitPicker .dfchat-unit-option{display:block;width:100%;padding:6px 8px;" +
        "background:transparent;color:inherit;border:0;border-bottom:1px solid var(--dwfui-gold-bevel-dark);" +
        "text-align:left;cursor:pointer}" +
      "#dfChatUnitPicker .dfchat-unit-option:hover{opacity:.78}" +
      "#dfChatNote{color:var(--dwfui-text-warning);font-size:11.5px;padding:6px 10px;" +
        "border-top:1px solid var(--dwfui-gold-bevel-dark);display:none}" +
      "#dfChatNote.show{display:block}";
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- DOM build -----------------------------------------------------------------------------
  // Lifts a real element out of a DWFUI builder's markup. Trusted component output ONLY -- no chat
  // TEXT ever passes through here (see the security note above buildLineNode).
  function nodeFrom(html) {
    var holder = document.createElement("div");
    holder.innerHTML = html;
    return holder.firstElementChild;
  }

  function build() {
    if (els.toggle) return;
    ensureStyle();

    var toggle = document.createElement("div");
    toggle.id = "dfChatToggle";
    var tlabel = document.createElement("span");
    tlabel.textContent = "Chat";
    var badge = document.createElement("span");
    badge.className = "dfchat-badge";
    toggle.appendChild(tlabel);
    toggle.appendChild(badge);
    toggle.addEventListener("click", openPanel);

    var panel = document.createElement("div");
    panel.id = "dfChatPanel";

    // *** THE LIVE PATH. *** This used to hand-build the header with createElement and set
    // `closeBtn.textContent = "x"` -- a Unicode stand-in for art we already own -- while the Studio
    // card rendered a DWFUI header from chatStoryMarkup(). Two code paths, one of them invisible to
    // every gate. Both now come from chatHeadHtml(), so what the Studio shows IS what the player gets.
    var head = nodeFrom(chatHeadHtml());
    var closeBtn = head.querySelector(".dfchat-close");
    if (closeBtn) closeBtn.addEventListener("click", closePanel);

    // The log region. STRUCTURE IS IDENTICAL TO chatStoryMarkup's: a #dfChatLog host (PanelFrame's
    // fillSel, unchanged) wrapping DWFUI.scrollHtml -- which is what puts the log on the NATIVE
    // scrollbar instead of the browser-default one. `els.log` is the SCROLL node, so render()'s
    // stick-to-bottom math and its line appends act on the element that actually scrolls.
    var logHost = document.createElement("div");
    logHost.id = "dfChatLog";
    logHost.innerHTML = chatLogHtml("");
    var log = logHost.firstElementChild;

    var note = document.createElement("div");
    note.id = "dfChatNote";

    var foot = document.createElement("div");
    foot.id = "dfChatFoot";
    var input = document.createElement("input");
    input.id = "dfChatInput";
    input.type = "text";
    input.maxLength = MAX_LEN;               // first-line clamp (a 10KB paste is truncated here)
    input.placeholder = "Message... (@ to mention)";
    input.autocomplete = "off";
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); hideUnitSuggestions(); sendCurrent(); }
      // B223: the map-side Escape cascade (controls-placement) never sees a keypress made while a
      // text input has focus -- that handler blurs and returns early. So the composer cancels the
      // armed ping itself; otherwise arming, clicking into the composer, then pressing Esc would
      // leave the crosshair armed with no way out but the button.
      else if (e.key === "Escape") { hideUnitSuggestions(); if (pingArmed) disarmPing(); }
      else if (e.key === "Tab" && activeMention && activeMention.matches.length) {
        e.preventDefault(); completeUnitMention(activeMention.matches[0].id);
      }
    });
    input.addEventListener("input", renderUnitSuggestions);

    // New authoring chrome is built through DWFUI, per the shared component architecture. The
    // assigned HTML is trusted component output only; no message text ever reaches innerHTML.
    var authorTools = document.createElement("span");
    authorTools.className = "dfchat-author-tools";
    if (window.DWFUI) authorTools.innerHTML = DWFUI.actionButtonsHtml(CHAT_PING_ITEMS, CHAT_PING_OPTS);

    var unitPicker = document.createElement("div");
    unitPicker.id = "dfChatUnitPicker";
    unitPicker.setAttribute("role", "listbox");
    unitPicker.setAttribute("aria-label", "Mention a character");

    // The Send control is a NATIVE PLAQUE, from the same builder the story uses.
    var send = nodeFrom(chatSendHtml(false));
    send.addEventListener("click", sendCurrent);
    foot.appendChild(authorTools);
    foot.appendChild(input);
    foot.appendChild(send);
    foot.appendChild(unitPicker);
    foot.addEventListener("click", function (e) {
      var node = e.target;
      while (node && node !== foot) {
        if (node.getAttribute && node.getAttribute("data-chat-ping-arm") != null) {
          // B223: ARM (or, if already armed, CANCEL) the map pick. Nothing is written to the
          // composer and nothing is sent until the player actually clicks a target.
          e.preventDefault(); togglePing(); return;
        }
        var unitId = node.getAttribute && node.getAttribute("data-chat-unit-id");
        if (unitId != null) { e.preventDefault(); completeUnitMention(unitId); return; }
        node = node.parentNode;
      }
    });

    panel.appendChild(head);
    panel.appendChild(logHost);
    panel.appendChild(note);
    panel.appendChild(foot);

    document.body.appendChild(toggle);
    document.body.appendChild(panel);

    els = { toggle: toggle, badge: badge, panel: panel, log: log, note: note, input: input,
      send: send, unitPicker: unitPicker, authorTools: authorTools };
    if (window.DFPanelFrame) window.DFPanelFrame.register({
      key: "chat", el: function () { return els.panel; }, title: "Chat", headSel: ".dfchat-head",
      closable: true, resizable: { minW: 220, minH: 140 },
      fillSel: "#dfChatLog",
      defaultPos: function (vw, vh) { return { anchor: "bl", x: 8, y: 52, w: 302, h: 272 }; },
      open: openPanel, close: closePanel, isOpen: function () { return open; }, escClosable: true,
    });
    bindPingBridge();   // B223: publish onArmed/onDisarmed/onPick for the map-side armed mode
    applySupportState();
    render();
  }

  // ---- line rendering (XSS-safe: raw chat reaches textContent/attributes only) ----------------
  function appendChatBody(doc, body, text) {
    var parts = parseChatText(text);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i], node = doc.createElement(part.kind === "text" ? "span" : "a");
      if (part.kind === "text") {
        node.textContent = part.text;
      } else if (part.kind === "url") {
        node.className = "dfchat-link dfchat-url";
        node.textContent = part.text;
        node.setAttribute("href", part.url);       // parser admitted http/https only
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      } else if (part.kind === "location") {
        node.className = "dfchat-link dfchat-location";
        node.textContent = "Location " + part.pos.x + ", " + part.pos.y + ", " + part.pos.z;
        node.setAttribute("href", "#");
        node.setAttribute("data-chat-location", part.pos.x + "," + part.pos.y + "," + part.pos.z);
        node.addEventListener("click", function (segment) {
          return function (e) { e.preventDefault(); return jumpToLocation(segment.pos); };
        }(part));
      } else {
        node.className = "dfchat-link dfchat-unit";
        node.textContent = "@" + part.label;
        node.setAttribute("href", "#");
        node.setAttribute("data-chat-unit", String(part.id));
        node.addEventListener("click", function (segment) {
          return function (e) { e.preventDefault(); return jumpToUnit(segment.id); };
        }(part));
      }
      body.appendChild(node);
    }
  }

  // Exposed for the offline test. `doc` is injected so it can run under a minimal DOM stub.
  function buildLineNode(doc, msg, self) {
    var line = doc.createElement("div");
    line.className = "dfchat-line" + (msg.system ? " dfchat-system" : "");

    if (msg.system) {
      // System lines ("X joined"/"X left") are server-generated but still rendered as inert text.
      var sys = doc.createElement("span");
      sys.textContent = String(msg.text == null ? "" : msg.text);
      line.appendChild(sys);
      return line;
    }

    var from = String(msg.from == null ? "" : msg.from);
    var name = doc.createElement("span");
    name.className = "dfchat-name";
    // Color from the ONE canonical helper so a chat name matches that player's cursor/lobby chip.
    try { name.style.color = colorFor(from); } catch (_) {}
    name.textContent = from;
    line.appendChild(name);

    if (self && from === self) {
      var you = doc.createElement("span");
      you.className = "dfchat-you";
      you.textContent = " (you)";
      name.appendChild(you);
    }

    var sep = doc.createElement("span");
    sep.textContent = ": ";
    line.appendChild(sep);

    var body = doc.createElement("span");
    body.className = "dfchat-body";
    // *** Injection-critical: parser output is still installed only via textContent/safe attrs. ***
    appendChatBody(doc, body, String(msg.text == null ? "" : msg.text));
    line.appendChild(body);

    return line;
  }

  function isPresenceSystemLine(msg) {
    return !!(msg && msg.system) && /\b(?:joined|left)\.?$/i.test(String(msg.text == null ? "" : msg.text));
  }

  function collapsePresenceLines(ordered) {
    var collapsed = [];
    for (var i = 0; i < ordered.length; i++) {
      var msg = ordered[i];
      var previous = collapsed[collapsed.length - 1];
      if (isPresenceSystemLine(msg) && previous && previous._presenceCount) {
        previous._presenceCount++;
        previous.text = previous._presenceCount + " players joined or left.";
      } else if (isPresenceSystemLine(msg)) {
        var entry = Object.assign({}, msg);
        entry._presenceCount = 1;
        collapsed.push(entry);
      } else {
        collapsed.push(msg);
      }
    }
    return collapsed;
  }

  function render() {
    if (!els.log) return;
    var log = els.log;
    // Preserve "stick to bottom" if the user is already at the bottom.
    var atBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 24;

    // Rebuild from the ordered line map (cheap: <=100 nodes). A full rebuild keeps ordering correct
    // even when a gap-fill fetch delivers lines out of arrival order.
    while (log.firstChild) log.removeChild(log.firstChild);

    var ordered = Array.from(lines.values()).sort(function (a, b) { return a.seq - b.seq; });
    if (ordered.length > HISTORY_KEEP) ordered = ordered.slice(ordered.length - HISTORY_KEEP);
    ordered = collapsePresenceLines(ordered);

    if (ordered.length === 0 && supported !== false) {
      var empty = document.createElement("div");
      empty.id = "dfChatEmpty";
      empty.textContent = "No messages yet.";
      log.appendChild(empty);
    } else {
      var self = selfName();
      for (var i = 0; i < ordered.length; i++) log.appendChild(buildLineNode(document, ordered[i], self));
    }
    if (atBottom || open) log.scrollTop = log.scrollHeight;
  }

  // ---- apply lines (dedup by seq) ------------------------------------------------------------
  function applyLine(msg) {
    if (!msg || typeof msg.seq !== "number") return;
    if (lines.has(msg.seq)) { if (msg.seq > lastSeq) lastSeq = msg.seq; return; }  // already have it
    lines.set(msg.seq, {
      seq: msg.seq,
      system: !!msg.system,
      from: msg.from,
      text: msg.text,
      ts: msg.ts,
    });
    // Prune far below the ring cap so the Map can't grow unbounded on a long session.
    if (lines.size > HISTORY_KEEP * 2) {
      var ks = Array.from(lines.keys()).sort(function (a, b) { return a - b; });
      for (var i = 0; i < ks.length - HISTORY_KEEP; i++) lines.delete(ks[i]);
    }
    if (msg.seq > lastSeq) lastSeq = msg.seq;
    if (!open && !msg.system) { unread++; refreshBadge(); }
  }

  function applyBatch(arr) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) applyLine(arr[i]);
    render();
  }

  // ---- server fetch (scrollback + gap fill) --------------------------------------------------
  function fetchChat(since) {
    var url = "/chat" + (since > 0 ? ("?since=" + since) : "");
    return fetch(url, { credentials: "same-origin", cache: "no-store" }).then(function (r) {
      if (r.status === 404) { setSupported(false); return null; }   // old host: no chat route
      if (!r.ok) return null;                                        // 401/5xx: leave state as-is
      return r.json();
    }).then(function (data) {
      if (!data) return;
      setSupported(true);
      if (Array.isArray(data.lines)) applyBatch(data.lines);
      if (typeof data.latest === "number" && data.latest > lastSeq) lastSeq = data.latest;
    }).catch(function () { /* network hiccup: keep whatever we have; a later frame/probe recovers */ });
  }

  // WT27: a ping travels as a chat message carrying a [[loc:x,y,z]] or [[unit:id|Name]] token. When
  // such a message arrives LIVE, drop a LoL/Dota-style splash on the map at that target in the
  // author's color. Fired only from the live onChat path (not scrollback), and only for genuinely-
  // new seqs, so historical pings loaded at boot never re-splash. Best-effort: a splash must never
  // break chat delivery.
  //
  // B223: BOTH token kinds splash, and both splash AT THE PICKED TARGET.
  //   * location -- EVERY location token in a message splashes (WT27's contract, unchanged). The
  //     token now carries the tile the author CLICKED; it used to carry their camera centre, which
  //     is the whole bug -- the splash landed nowhere near what they meant.
  //   * unit -- a unit token deliberately carries NO coordinates (that is what lets a unit link
  //     follow a walking dwarf), so the splash resolves the id against the CURRENT live roster,
  //     exactly as a click on the link does. A unit outside the streamed AUX window resolves to
  //     nothing and simply does not splash -- there is no on-screen tile to splash on. The chat
  //     link still works; only the map effect is skipped.
  //
  // *** THE BARE-TOKEN GATE ON UNIT SPLASHES IS DELIBERATE. *** A plain @mention typed in a
  // sentence ("@Urist is hurt") ALSO expands to a [[unit:]] token at send time. Splashing those
  // would fire the map effect on ordinary conversation, which nobody asked for. A ping auto-sends
  // the token AS THE WHOLE MESSAGE, so "the message is exactly one unit token" is precisely the
  // "this is a ping, not a mention" test -- and a hand-typed bare token pings too.
  function emitPingSplashes(msg) {
    try {
      if (!msg || msg.system || !msg.text) return;
      if (!window.DwfTiles || typeof window.DwfTiles.pingSplash !== "function") return;
      var parts = parseChatText(msg.text);
      var bare = parseChatText(String(msg.text).trim());
      var bareUnitPing = bare.length === 1 && bare[0].kind === "unit";
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i], pos = null;
        if (part.kind === "location") pos = part.pos;
        else if (part.kind === "unit" && bareUnitPing) {
          var live = resolveUnitPing(part.id);
          pos = live ? live.pos : null;
        }
        if (pos) window.DwfTiles.pingSplash(pos.x, pos.y, pos.z, msg.from);
      }
    } catch (_) { /* never let a splash break the chat log */ }
  }

  // ---- live frame (routed from dwf-ws.js) ----------------------------------------------
  function onChat(msg) {
    if (!booted) return;
    if (!msg || typeof msg.seq !== "number") return;
    setSupported(true);                       // a live frame proves the host relays chat
    var fresh = !lines.has(msg.seq);          // genuinely new this arrival -> eligible to splash
    // Gap detection: a jump beyond the next expected seq means we missed line(s) (a coalesced
    // reconnect, a dropped frame). Refetch the whole gap from the authoritative ring; the fetch
    // returns this line too, and applyLine dedups. This is the self-heal that lets live delivery
    // be best-effort while the log stays complete.
    if (lastSeq > 0 && msg.seq > lastSeq + 1) {
      var gapFrom = lastSeq;   // capture BEFORE applyLine bumps lastSeq to msg.seq
      applyLine(msg);          // show the newest immediately
      if (fresh) emitPingSplashes(msg);
      render();
      fetchChat(gapFrom);      // fill the hole (may include msg again -> deduped)
      return;
    }
    applyLine(msg);
    if (fresh) emitPingSplashes(msg);
    render();
  }

  // ---- support state (enable/disable input, dormant note) ------------------------------------
  function setSupported(v) {
    if (supported === v) return;
    supported = v;
    applySupportState();
    render();
  }
  function applySupportState() {
    if (!els.input) return;
    var dormant = (supported === false);
    els.input.disabled = dormant;
    els.send.disabled = dormant;
    if (dormant) {
      els.note.textContent = "Chat unavailable - host needs update.";
      els.note.classList.add("show");
      els.input.placeholder = "Chat unavailable";
    } else {
      els.note.classList.remove("show");
      els.input.placeholder = "Message... (@ to mention)";
    }
  }

  // ---- authoring: ping TARGETING (B223) + @ roster completion --------------------------------
  //
  // THE FLOW, end to end:
  //   1. ping button  -> armPing()   -> window.DFChatPing.arm()   (map goes to a crosshair)
  //   2. next MAP click -> controls-placement resolves it through /inspect and calls onPick(...)
  //   3. onPick        -> pingTargetToken() -> sendChatText(token) -- AUTO-SENT, no composer step
  //   4. the token round-trips through the server relay, and onChat -> emitPingSplashes drops the
  //      WT27 splash AT THE PICKED TARGET (a location token carries the picked tile; a unit token
  //      resolves to that unit's CURRENT tile through the live roster -- see emitPingSplashes).
  // Cancel: Escape (map-side cascade AND the composer's own keydown, below) or a second click on
  // the button. A pick disarms itself, so the mode is never wedged.
  //
  // The message IS the token and nothing else: that is what a ping reads like today, and it keeps
  // the auto-send unable to smuggle any composer text the player did not mean to send.
  var pingArmed = false;

  // The armed affordance is DWFUI's OWN `active` state, re-rendered through the SAME factory that
  // built the button (actionButtonsHtml stamps `class="... active"` for `active:true`). The armed
  // look is therefore not a hand-stamped class this module invented -- it is the one the whole
  // client uses for a lit-up tool, and it cannot drift from the component layer.
  function pingItems() {
    if (!pingArmed) return CHAT_PING_ITEMS;
    return [Object.assign({}, CHAT_PING_ITEMS[0], {
      active: true, title: "Click a unit or a tile to ping it (Esc cancels)",
    })];
  }
  function paintPingButton() {
    if (!els.authorTools || !window.DWFUI) return;
    // Trusted component output only (no player text reaches this sink).
    els.authorTools.innerHTML = window.DWFUI.actionButtonsHtml(pingItems(), CHAT_PING_OPTS);
  }
  function pingBridge() {
    try { return window.DFChatPing || null; } catch (_) { return null; }
  }
  function armPing() {
    // GRACEFUL-DORMANT: against an old host that cannot relay chat, a ping could never be sent.
    // Refuse to arm rather than put the map on a crosshair that eats a click and does nothing.
    if (supported === false) return false;
    var bridge = pingBridge();
    if (!bridge || typeof bridge.arm !== "function") {
      flashNote("Ping targeting is unavailable.");   // map layer absent (never true in the client)
      return false;
    }
    hideUnitSuggestions();
    bridge.arm();                     // -> onArmed() below flips our own state + button
    return true;
  }
  function disarmPing() {
    var bridge = pingBridge();
    if (bridge && typeof bridge.disarm === "function") { bridge.disarm(); return true; }
    // No map layer: keep our own state honest anyway.
    pingArmed = false;
    paintPingButton();
    return false;
  }
  function togglePing() { return pingArmed ? disarmPing() : armPing(); }

  // Resolve the pick with the SAME precedence a plain map click uses. DFTileList.buildCandidates
  // (dwf-unitcycle.js) is the B208/B219 top-occupant ordering -- units outrank buildings and
  // items -- so the unit a ping picks is exactly the unit a click would have opened. No parallel
  // hit-test exists here. When no unit is on the tile (or the tile-list module is not loaded on an
  // old cached client), it degrades to the plain /inspect `kind:"unit"` answer, and then to the
  // clicked tile itself.
  function pingTargetToken(data, pos) {
    var top = null;
    try {
      if (window.DFTileList && typeof window.DFTileList.buildCandidates === "function") {
        var latest = null;
        try {
          if (window.DwfTiles && typeof window.DwfTiles.getLatest === "function")
            latest = window.DwfTiles.getLatest();
        } catch (_) {}
        var candidates = window.DFTileList.buildCandidates(data || {}, latest) || [];
        top = candidates.length ? candidates[0] : null;
      }
    } catch (_) { top = null; }
    if (top && top.kind === "unit") {
      var token = unitToken({ id: top.id, name: top.label });
      if (token) return token;
    }
    if (String(data && data.kind || "").toLowerCase() === "unit" && data.unit) {
      var fallback = unitToken(data.unit);
      if (fallback) return fallback;
    }
    // Not a unit -> the TILE. Prefer the coordinates /inspect resolved; fall back to the world tile
    // the click layer computed browser-side (which is what makes a ping on bare ground work at all).
    return locationToken(mapPos(data && data.tile) || mapPos(pos));
  }

  // The map layer calls this exactly once per armed click, and has already disarmed itself.
  function onPingPick(data, pos) {
    pingArmed = false;
    paintPingButton();
    var token = pingTargetToken(data, pos);
    if (!token) { flashNote("Could not resolve that spot."); return false; }
    if (!sendChatText(token)) { flashNote("Not connected - ping not sent."); return false; }
    return true;
  }

  // window.DFChatPing is created by whichever of the two files loads first (controls-placement owns
  // arm/disarm/isArmed; chat owns onArmed/onDisarmed/onPick) -- the same split DFWsLink/DFSquadKill
  // use, so neither file depends on script order.
  function bindPingBridge() {
    var bridge;
    try { bridge = window.DFChatPing = window.DFChatPing || {}; } catch (_) { return; }
    bridge.onArmed = function () {
      pingArmed = true;
      paintPingButton();
      flashNote("Click a unit or a tile to ping it. Esc cancels.");
    };
    bridge.onDisarmed = function () {          // fires for Escape, the toggle, AND a completed pick
      pingArmed = false;
      paintPingButton();
    };
    bridge.onPick = onPingPick;
  }

  function insertComposerText(input, value, start, end) {
    if (!input || !value) return false;
    var before = String(input.value || "");
    start = Number.isInteger(start) ? start : (Number.isInteger(input.selectionStart) ? input.selectionStart : before.length);
    end = Number.isInteger(end) ? end : (Number.isInteger(input.selectionEnd) ? input.selectionEnd : start);
    var lead = start > 0 && !/\s/.test(before.charAt(start - 1)) ? " " : "";
    var tail = end < before.length && !/\s/.test(before.charAt(end)) && !/\s$/.test(value) ? " " : "";
    var inserted = lead + value + tail;
    if (before.length - (end - start) + inserted.length > MAX_LEN) {
      flashNote("That ping would make the message too long.");
      return false;
    }
    input.value = before.slice(0, start) + inserted + before.slice(end);
    var caret = start + inserted.length;
    try { input.setSelectionRange(caret, caret); input.focus(); } catch (_) {}
    return true;
  }

  function mentionAtCaret(input) {
    if (!input) return null;
    var end = Number.isInteger(input.selectionStart) ? input.selectionStart : String(input.value || "").length;
    var before = String(input.value || "").slice(0, end);
    var match = /(^|\s)@([^@\[\]\r\n]{0,80})$/.exec(before);
    if (!match) return null;
    var start = end - match[2].length - 1;
    return { start: start, end: end, query: match[2] };
  }

  function unitSuggestionsHtml(matches) {
    if (!window.DWFUI) return "";
    var rows = (matches || []).slice(0, 6).map(function (unit) {
      return DWFUI.rowHtml({
        tag: "button", cls: "dfchat-unit-option", dataset: { chatUnitId: unit.id },
        label: unit.name, sub: { text: "Character", cls: "dfchat-unit-kind" },
        role: "option", ariaLabel: "Mention " + unit.name,
      });
    }).join("");
    return DWFUI.scrollHtml({ cls: "dfchat-unit-list", ariaLabel: "Character matches" }, rows);
  }

  function hideUnitSuggestions() {
    activeMention = null;
    if (els.unitPicker) {
      els.unitPicker.classList.remove("show");
      els.unitPicker.textContent = "";
    }
  }

  function renderUnitSuggestions() {
    if (!els.input || !els.unitPicker || !window.DWFUI) return;
    var mention = mentionAtCaret(els.input);
    if (!mention) { hideUnitSuggestions(); return; }
    mention.matches = unitRoster(mention.query).slice(0, 6);
    if (!mention.matches.length) { hideUnitSuggestions(); return; }
    activeMention = mention;
    // Trusted DWFUI output: rowHtml escapes every roster name and dataset value.
    els.unitPicker.innerHTML = unitSuggestionsHtml(mention.matches);
    els.unitPicker.classList.add("show");
  }

  function completeUnitMention(id, input) {
    input = input || els.input;
    var mention = activeMention || mentionAtCaret(input);
    if (!mention) return false;
    var matches = mention.matches || unitRoster(mention.query);
    id = int32(id, true);
    var unit = matches.find(function (candidate) { return candidate.id === id; });
    if (!unit) return false;
    var ok = insertComposerText(input, "@" + unit.name + " ", mention.start, mention.end);
    hideUnitSuggestions();
    return ok;
  }

  // Expand exact roster names at send time. Longest names win ("@Urist McMiner" before
  // "@Urist"), the mention must begin at start/whitespace, and a boundary must follow it.
  function expandUnitMentions(value, roster) {
    var text = String(value == null ? "" : value);
    var units = (roster || unitRoster("")).slice().sort(function (a, b) {
      return String(b.name || "").length - String(a.name || "").length || Number(a.id) - Number(b.id);
    });
    var out = "", cursor = 0;
    for (var i = 0; i < text.length;) {
      if (text.charAt(i) !== "@" || (i > 0 && !/\s/.test(text.charAt(i - 1)))) { i++; continue; }
      var found = null;
      for (var j = 0; j < units.length; j++) {
        var name = cleanUnitLabel(units[j] && units[j].name);
        if (!name || text.slice(i + 1, i + 1 + name.length).toLowerCase() !== name.toLowerCase()) continue;
        var after = text.charAt(i + 1 + name.length);
        if (!after || /[\s.,!?;:]/.test(after)) { found = { unit: units[j], length: name.length + 1 }; break; }
      }
      if (!found) { i++; continue; }
      out += text.slice(cursor, i) + unitToken(found.unit);
      i += found.length;
      cursor = i;
    }
    return out + text.slice(cursor);
  }

  function utf8Length(value) {
    try { if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(value)).length; }
    catch (_) {}
    try { return unescape(encodeURIComponent(String(value))).length; } catch (_) { return String(value).length; }
  }

  // ---- send ----------------------------------------------------------------------------------
  // THE one WS dispatch. sendCurrent() (composer) and onPingPick() (B223 auto-send) both go through
  // it, so an auto-sent ping is byte-for-byte an ordinary chat line -- same relay, same seq, same
  // ordering source, no local echo. Returns false when the socket is down; the caller decides
  // whether to keep the text (composer) or flash a note (ping).
  function sendChatText(text) {
    if (supported === false) return false;
    text = String(text == null ? "" : text);
    if (!text.replace(/\s+/g, "")) return false;
    try {
      if (window.DwfWS && typeof window.DwfWS.send === "function")
        return !!window.DwfWS.send({ type: "chat", text: text });
    } catch (_) {}
    return false;
  }

  function sendCurrent() {
    if (!els.input || supported === false) return;
    var raw = els.input.value;
    if (raw.length > MAX_LEN) raw = raw.slice(0, MAX_LEN);   // clamp (belt & braces vs maxlength)
    var text = expandUnitMentions(raw);
    // Never slice through a structured token created by expansion. Plain legacy text keeps the
    // old clamp behavior; an expanded mention that would overflow asks the author to shorten it.
    var structured = parseChatText(text).some(function (part) {
      return part.kind === "location" || part.kind === "unit";
    });
    if (text.length > MAX_LEN || (structured && utf8Length(text) > MAX_LEN)) {
      flashNote("Message is too long after adding the ping."); return;
    }
    if (!text.replace(/\s+/g, "")) { els.input.value = ""; return; }   // whitespace-only: ignore
    var okSent = sendChatText(text);
    if (okSent) {
      els.input.value = "";   // no local echo -- the server relays it back to us (single ordering source)
    } else {
      // Socket down: keep the text, hint. (Rare; the WS auto-reconnects.)
      flashNote("Not connected - message not sent.");
    }
  }
  var noteTimer = null;
  var lastRejectionReason = "";
  function flashNote(text) {
    if (!els.note || supported === false) return;
    els.note.textContent = text;
    els.note.classList.add("show");
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { if (supported !== false) els.note.classList.remove("show"); }, 2500);
  }

  function onRejected(msg) {
    lastRejectionReason = msg && msg.reason || "rejected";
    if (lastRejectionReason === "rate_limit")
      flashNote("You're sending messages too quickly. Please wait a moment.");
    else
      flashNote("Message was not accepted by the host.");
  }

  // ---- open / close / badge ------------------------------------------------------------------
  function refreshBadge() {
    if (!els.badge) return;
    if (unread > 0 && !open) {
      els.badge.textContent = unread > 99 ? "99+" : String(unread);
      els.badge.classList.add("show");
    } else {
      els.badge.classList.remove("show");
    }
  }
  function openPanel() {
    open = true; unread = 0;
    if (els.panel) els.panel.classList.add("open");
    if (els.toggle) els.toggle.style.display = "none";
    refreshBadge();
    render();
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("chat", true); } catch (_) {}
    try { if (els.input && supported !== false) els.input.focus(); } catch (_) {}
  }
  function closePanel() {
    try { if (window.DFPanelFrame) window.DFPanelFrame.syncOpenState("chat", false); } catch (_) {}
    open = false;
    hideUnitSuggestions();
    // B223 NO WEDGED STATE: closing chat while a ping is armed would hide the only button that can
    // cancel it and leave the map on a crosshair that silently eats the next click. Disarm.
    if (pingArmed) disarmPing();
    if (els.panel) els.panel.classList.remove("open");
    if (els.toggle) els.toggle.style.display = "flex";
    refreshBadge();
  }

  // ---- boot ----------------------------------------------------------------------------------
  function boot() {
    if (booted) return;
    booted = true;
    try {
      build();
      fetchChat(0);   // capability probe + initial scrollback
    } catch (_) { /* never let chat boot break the page */ }
  }

  // Public API + test hooks.
  window.DwfChat = {
    onChat: onChat,
    onRejected: onRejected,
    storyMarkup: chatStoryMarkup,
    preparePreview: ensureStyle,
    // test-only internals (offline harness): the injection-critical render path + gap math.
    _buildLineNode: buildLineNode,
    _parseChatText: parseChatText,
    _locationToken: locationToken,
    _unitToken: unitToken,
    _unitSuggestionsHtml: unitSuggestionsHtml,
    _expandUnitMentions: expandUnitMentions,
    _resolveUnitPing: resolveUnitPing,
    _jumpToLocation: jumpToLocation,
    _jumpToUnit: jumpToUnit,
    // B223 ping-targeting seams: arm/cancel, the unit-vs-tile resolution, and the pick handler
    // (which is what auto-sends).
    _togglePingForTest: togglePing,
    _pingArmedForTest: function () { return pingArmed; },
    _closePanelForTest: closePanel,
    _pingTargetTokenForTest: pingTargetToken,
    _onPingPickForTest: onPingPick,
    _completeUnitMentionForTest: completeUnitMention,
    _setNavigationHooksForTest: function (hooks) { navigationHooks = hooks || null; },
    _collapsePresenceLines: collapsePresenceLines,
    _needFetchSince: function (prevLast, seq) { return (prevLast > 0 && seq > prevLast + 1) ? prevLast : -1; },
    _applyLineForTest: function (msg) { applyLine(msg); },
    _emitPingSplashesForTest: emitPingSplashes,   // WT27: location-token -> DwfTiles.pingSplash
    _stateForTest: function () { return { lastSeq: lastSeq, supported: supported, count: lines.size, unread: unread }; },
    _lastRejectionForTest: function () { return lastRejectionReason; },
    _resetForTest: function () { supported = null; lastSeq = 0; lines = new Map(); open = false;
      unread = 0; activeMention = null; navigationHooks = null; pingArmed = false;
      lastRejectionReason = ""; },
  };

  if (typeof document !== "undefined" && document.body && !window.__DWF_STORY_MODE) {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", boot);
    else
      boot();
  } else if (typeof document !== "undefined" && !window.__DWF_STORY_MODE) {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
