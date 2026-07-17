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

  // WS3 fort administration panel: Nobles, Justice, Petitions. Nobles/Justice re-host into the
  // shared WD-16 info-window shell (see openNoblesPanel/openJusticePanel/renderFortAdminPanel
  // below); Petitions keeps its own small standalone window. Reads /nobles, /justice,
  // /petitions; mutates /petition-policy (standing-orders auto-response) and /noble-assign.
  // Per-petition approve/deny is host-only: /petition-accept and /petition-deny are fail-closed
  // (501 native-only) because the plugin cannot faithfully perform native's residency grant.
  let adminTab = "nobles";                       // active tab
  let adminData = { nobles: null, justice: null, petitions: null };
  let petitionSelectedId = null;

  // WD-20: [+] assign candidate picker state (one open at a time; opening a different
  // position's picker closes the previous one, matching a normal dropdown/flyout).
  let nobleAssignOpenPosition = -1;
  let nobleAssignCandidates = null;   // {positionId, positionName, candidates:[...]} | {error}
  let nobleAssignLoading = false;

  // R3 (CIM-justice-*.jpg): Justice's 6 native sub-tabs. The 6th is "Intelligence" in base DF
  // (NOT "Counterintelligence") and has no inner tabs at this level -- just a verbatim empty state.
  // The `counterintel` KEY is retained as the server contract (/justice?mode=); only the label +
  // rendering are corrected to native.
  const JUSTICE_MODES = [
    { key: "open", label: "Open cases", empty: "No open cases." },
    { key: "closed", label: "Closed cases", empty: "No closed cases." },
    { key: "cold", label: "Cold cases", empty: "No cold cases." },
    { key: "guard", label: "Fortress guard", empty: "No fortress guard assigned." },
    { key: "convicts", label: "Convicts", empty: "No convicts." },
    { key: "counterintel", label: "Intelligence", empty: "There is no intelligence information yet." },
  ];
  let justiceMode = "open";
  let justiceSelectedCase = -1;   // R3: selected crime id (open/closed/cold) or convict crimeId

  // B227: the host's action flags for the native justice drives, read from GET /justice-convict
  // (`guards:{justiceConvict,justiceInterrogate}` -- dfcapture.lua hw_justice_state, backed by
  // dfcapture-hostwrites.json next to the DF exe; a missing file means everything off).
  //   null  = not read yet / unreadable -> actions stay LOCKED and say so.
  //   {...} = the live flags; the poll below re-reads them every 2s, so flipping a flag on the
  //           host lights the buttons up on their own -- no reload, no rebuild.
  let justiceHostState = null;
  let justicePollTimer = null;

  function fortProfessionColorStyle(record, key = "professionColor") {
    const idx = record && record[key];
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) return "";
    return ` style="color:${DWFUI.dfColor(idx)}"`;
  }

  const ADMIN_TABS = [
    { key: "nobles", label: "Nobles", route: "/nobles" },
    { key: "justice", label: "Justice", route: "/justice" },
    { key: "petitions", label: "Petitions", route: "/petitions" },
  ];

  function adminRouteFor(tab) {
    const t = ADMIN_TABS.find(x => x.key === tab);
    return t ? t.route : "/nobles";
  }

  // WD-16: Nobles and Justice are two of the 8 real DF info tabs and now re-host into the
  // shared shell (dwf-fort-panels.js's renderInfoShellWindow) instead of this file's own
  // private nobles/justice/petitions 3-way tab strip. Petitions is NOT one of the 8 (a WD-1
  // client-only relocation reachable via Shift+G) and keeps the old standalone fortRenderWindow
  // chrome, with no more tab strip of its own (it was only ever there to hop to nobles/justice,
  // which now live in the main window's tab row instead).
  async function openFortAdminPanel(startTab) {
    setActiveToolbar(startTab || adminTab);
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    adminTab = startTab || adminTab || "petitions";
    fortLoadingShell("Petitions");
    await refreshFortAdmin();
  }

  async function openNoblesPanel() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("nobles"); // WD-26 first-time help (18-info-nobles.png)
    setActiveToolbar("nobles");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    adminTab = "nobles";
    activeInfoPanel = "nobles";
    nobleAssignOpenPosition = -1;
    nobleAssignCandidates = null;
    infoShellLoadingShell("nobles", "Nobles and administrators");
    await refreshFortAdmin();
  }
  async function openJusticePanel() {
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("justice"); // WD-26 first-time help (20-info-justice.png)
    setActiveToolbar("justice");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    adminTab = "justice";
    activeInfoPanel = "justice";
    infoShellLoadingShell("justice", "Justice");
    await refreshFortAdmin();
    justiceStartPoll();
  }
  function openPetitionsPanel() { return openFortAdminPanel("petitions"); }

  // B227: the host flags (and the case list itself) change on the host at any moment -- a flag can
  // be flipped on the host mid-session, and a new crime can be discovered while a friend is
  // looking at the screen. Poll like the trade screen does (dwf-tradescreen.js), and RE-RENDER
  // ONLY WHEN THE PAYLOAD ACTUALLY CHANGED so the selection/scroll/caret survive an idle poll.
  function justiceStopPoll() {
    if (justicePollTimer) { clearInterval(justicePollTimer); justicePollTimer = null; }
  }
  function justiceStartPoll() {
    justiceStopPoll();
    let last = JSON.stringify([adminData.justice, justiceHostState]);
    justicePollTimer = setInterval(async () => {
      // The panel was closed or a different info tab took over -> stop (nothing to keep alive).
      if (adminTab !== "justice" || activeInfoPanel !== "justice" ||
          typeof clientPanel === "undefined" || !clientPanel ||
          !clientPanel.querySelector("[data-justice-mode]")) { justiceStopPoll(); return; }
      await refreshFortAdminData();
      const now = JSON.stringify([adminData.justice, justiceHostState]);
      if (now === last) return;
      last = now;
      renderFortAdminPanel();
    }, 2000);
  }

  // Fetch only -- no render. (Split out of refreshFortAdmin so the poll can diff before painting.)
  async function refreshFortAdminData() {
    try {
      let route = adminRouteFor(adminTab);
      if (adminTab === "justice") route += `?mode=${encodeURIComponent(justiceMode)}&`;
      else route += "?";
      adminData[adminTab] = await fortFetchJson(
        `${route}player=${encodeURIComponent(player)}&t=${Date.now()}`);
    } catch (err) {
      adminData[adminTab] = { error: err.message || "unavailable" };
    }
    if (adminTab !== "justice") return;
    // GET /justice-convict is READ-ONLY (it drives nothing): guards + the host's live justice-screen
    // state. If it cannot be read, justiceHostState stays null and every drive renders LOCKED with
    // that as the stated reason -- failing closed, exactly like the server's own flag file does.
    try {
      const state = await fortFetchJson(
        `/justice-convict?player=${encodeURIComponent(player)}&t=${Date.now()}`);
      justiceHostState = (state && state.ok) ? state : null;
    } catch (_) {
      justiceHostState = null;
    }
  }

  async function refreshFortAdmin() {
    await refreshFortAdminData();
    renderFortAdminPanel();
  }

  // ---------------------------------------------------------------------------------------
  // Nobles (WD-20)
  // ---------------------------------------------------------------------------------------

  async function toggleNobleAssign(positionId) {
    if (nobleAssignOpenPosition === positionId) {
      nobleAssignOpenPosition = -1;
      nobleAssignCandidates = null;
      renderFortAdminPanel();
      return;
    }
    nobleAssignOpenPosition = positionId;
    nobleAssignCandidates = null;
    nobleAssignLoading = true;
    renderFortAdminPanel();
    try {
      const data = await fortFetchJson(
        `/noble-candidates?player=${encodeURIComponent(player)}&position=${positionId}&t=${Date.now()}`);
      if (nobleAssignOpenPosition !== positionId) return; // a different row opened meanwhile
      nobleAssignCandidates = data;
    } catch (err) {
      if (nobleAssignOpenPosition !== positionId) return;
      nobleAssignCandidates = { error: err.message || "unavailable" };
    } finally {
      nobleAssignLoading = false;
      renderFortAdminPanel();
    }
  }

  async function submitNobleAssign(positionId, unitId) {
    try {
      await fortFetchJson(
        `/noble-assign?player=${encodeURIComponent(player)}&position=${positionId}&unit=${unitId}&t=${Date.now()}`,
        { method: "POST" });
      nobleAssignOpenPosition = -1;
      nobleAssignCandidates = null;
      adminData.nobles = null;
      await refreshFortAdmin();
      fortSetStatus(unitId >= 0 ? "Position assigned." : "Position vacated.", false);
    } catch (err) {
      fortSetStatus(err.message || "Assignment failed.", true);
    }
  }

  function nobleCandidateListHtml(positionId) {
    if (nobleAssignOpenPosition !== positionId) return "";
    let inner;
    if (nobleAssignLoading) {
      inner = `<div class="info-message">Loading candidates...</div>`;
    } else if (!nobleAssignCandidates || nobleAssignCandidates.error) {
      inner = `<div class="info-message">Candidates unavailable: ${escapeHtml((nobleAssignCandidates && nobleAssignCandidates.error) || "")}</div>`;
    } else {
      const candidates = Array.isArray(nobleAssignCandidates.candidates) ? nobleAssignCandidates.candidates : [];
      const rows = [`<div class="fort-candidate-row fort-candidate-vacant" data-noble-pick="${positionId}" data-noble-unit="-1">— Vacant —</div>`]
        .concat(candidates.map(c => `
          <div class="fort-candidate-row${c.current ? " fort-candidate-current" : ""}" data-noble-pick="${positionId}" data-noble-unit="${c.unitId}">
            <span class="fort-cell-main"${fortProfessionColorStyle(c)}>${escapeHtml(c.name)}</span>
            <span class="fort-dim">${escapeHtml(c.profession || "")}</span>
          </div>`));
      inner = candidates.length
        ? `<div class="fort-candidate-list">${rows.join("")}</div>`
        : `<div class="fort-candidate-list"><div class="info-message">No eligible citizens.</div></div>`;
    }
    return inner;
  }

  // R4 (CIM-Nobles and administrators.jpg) pure helpers -- DOM-free, unit-tested by
  // tools/harness/cim_nobles_test.mjs. The five room-requirement icons, left→right as the native
  // screen: office/bedroom/dining/tomb/box.
  //
  // *** W5: THE EMOJI ARE GONE. *** This table used to carry a Unicode glyph per row
  // (&#129681; chair, &#128719; bed, &#127860; fork+knife, &#9904; coffin, &#128230; parcel) which
  // the renderer then TINTED with inline hex. DF ships all five as real art in four states --
  // NOBLES_<ROOM>_{GOOD,PARTIAL,MISSING,NA}, 20 tokens, every one of them present in
  // web/interface_map.json and already registered in TOKENS.sprites. `art` below is the token's room
  // family; note DF names the coffer's family FURN, not BOX (the `key` stays `box` because that is
  // the SERVER's field name in /nobles `rooms`/`roomsSatisfied` -- the wire contract is untouched).
  const NOBLE_ROOM_KINDS = [
    { key: "office",  art: "OFFICE",  label: "Office" },
    { key: "bedroom", art: "BEDROOM", label: "Bedroom" },
    { key: "dining",  art: "DINING",  label: "Dining room" },
    { key: "tomb",    art: "TOMB",    label: "Tomb" },
    { key: "box",     art: "FURN",    label: "Coffer" },
  ];
  // Per-icon state from the served `rooms` (required levels) + `roomsSatisfied` (holder ownership).
  // required=false → gray; required & satisfied → green-check; required & !satisfied → red-!; box (no
  // ownership signal) or unknown → required-but-neutral (null). Returns [] when the DLL served no room
  // data (old build), so the caller can fall back to the legacy text requirements (graceful).
  function nobleRoomIconStates(p) {
    if (!p || !p.rooms || typeof p.rooms !== "object") return [];
    const reqs = p.rooms;
    const sat = (p.roomsSatisfied && typeof p.roomsSatisfied === "object") ? p.roomsSatisfied : {};
    return NOBLE_ROOM_KINDS.map(k => {
      const required = Number(reqs[k.key] || 0) > 0;
      const satisfied = (k.key === "box") ? null
        : (typeof sat[k.key] === "boolean" ? sat[k.key] : null);
      return { kind: k.key, required, satisfied, art: k.art, label: k.label };
    });
  }

  // The room icon is a REAL FOUR-STATE, and it is NOT a tri-state: DWFUI.triState's vocabulary is
  // all/some/none and cannot express GOOD/PARTIAL/MISSING/NA, so this must NOT be delegated to it.
  // These are INDICATORS, not buttons -- they render through iconHtml with no click handler, exactly
  // as the INVENTORY_ASSIGNED_* precedent in ui-components.js requires.
  //
  //   !required                       -> NA        (native's "this position needs no such room" tile)
  //   required && satisfied === true  -> GOOD
  //   required && satisfied === false -> MISSING
  //   required && satisfied === null  -> PARTIAL   (required; ownership UNKNOWN -- see below)
  //
  // *** HONESTY NOTE -- WIRE GAP, NOT A RENDERING CHOICE. *** GOOD here is PRESENCE-ONLY. The server
  // says so itself at src/fort_admin.cpp holder_owned_rooms(): it walks the noble's owned_buildings
  // (v50 CIVZONES) and matches each zone's civzone type (Office/Bedroom/DiningHall/Tomb), and
  // "Presence-only: a too-cheap room DF would still flag red reads as satisfied here
  // (value-threshold not modeled)" -- the room-VALUE threshold is not exposed by DFHack in v50. (B283
  // fixed the inverse defect: the server used to match by furniture building_type, which is Civzone
  // for every entry, so every required room wrongly read "not satisfied".) DF's real
  // GOOD-vs-PARTIAL split IS that value threshold, so `roomsSatisfied` alone cannot discriminate the
  // two and we do not pretend to: PARTIAL is reached ONLY by the unknown-ownership case. In practice
  // that is the coffer, which carries no ownership signal at all (RoomOwned in fort_admin.cpp has no
  // `box` member), plus any room the DLL left out of `roomsSatisfied`. Closing this properly needs a
  // room-VALUE field on /nobles; it is reported as a wire gap rather than guessed at here.
  function nobleRoomSpriteState(st) {
    if (!st || !st.required) return "NA";
    if (st.satisfied === true) return "GOOD";
    if (st.satisfied === false) return "MISSING";
    return "PARTIAL";
  }
  function nobleRoomSprite(st) {
    return `NOBLES_${(st && st.art) || "FURN"}_${nobleRoomSpriteState(st)}`;
  }
  // The two clock cells. Same story: 10 real sprites
  // (NOBLES_{MANDATES,DEMANDS}_{TIME_GOOD,TIME_WARN_1,_2,_3,NA}) replacing a briefcase emoji
  // (&#128188;) and a hammer emoji (&#128296;) tinted with inline hex.
  //
  // *** AXIS MISMATCH, DECLARED. *** The sprite family is a DEADLINE ramp (TIME_*), but
  // nobleMandateIcons() -- which is correct, tested by 21 green cells, and which the lane keeps --
  // derives SEVERITY (hammerstrikes > 0 -> red, else yellow). Those are different axes. The wire DOES
  // carry `daysRemaining` per mandate, so a true deadline ramp is buildable with no server work; what
  // is missing is any evidence pinning the WARN_1/2/3 DAY THRESHOLDS, and inventing thresholds is
  // fabrication. So: keep the existing, tested severity semantics (function is never reduced) and map
  // them onto the ramp's ENDPOINTS only -- none -> NA, yellow -> TIME_WARN_1, red -> TIME_WARN_3.
  // TIME_GOOD and TIME_WARN_2 are deliberately left UNREACHED rather than guessed at. Reported.
  const NOBLE_CLOCK_STATE = { red: "TIME_WARN_3", yellow: "TIME_WARN_1" };
  // Demand chest + mandate hammer, derived from the already-served `mandates` array joined by unitId
  // (no server field for these -- Make mandate → demand chest, Export/Guild → hammer, red when the
  // punishment carries hammerstrikes else yellow). Only lights up on a live mandate (never fabricated).
  function nobleMandateIcons(p, mandates) {
    const out = { demand: null, mandate: null };
    if (!p || !p.filled || !(Number(p.unitId) >= 0)) return out;
    const mine = (Array.isArray(mandates) ? mandates : []).filter(m => Number(m.unitId) === Number(p.unitId));
    for (const m of mine) {
      const mode = String(m.mode || "").toLowerCase();
      if (mode === "make") {
        out.demand = "red";
      } else {
        const sev = Number(m.hammerstrikes) > 0 ? "red" : "yellow";
        if (out.mandate !== "red") out.mandate = sev;
      }
    }
    return out;
  }
  // Bookkeeper 1-5 precision selector: enum value 0..4 → highlighted button (index+1). Clamp guard so
  // an absent/invalid value highlights nothing.
  function noblePrecisionActiveButton(precision) {
    const v = Number(precision);
    return (v >= 0 && v <= 4) ? v + 1 : -1;
  }

  // INDICATORS, NOT BUTTONS -- iconHtml, no click handler (the INVENTORY_ASSIGNED_* precedent).
  // The NOBLES_* tokens are all in SELF_FRAMED_SPRITES, so iconHtml tags them
  // `dwfui-icon--native-cell` and the foundation draws NO generic box around DF's own framed cell.
  const NOBLE_ROOM_WORDS = { GOOD: "satisfied", PARTIAL: "required", MISSING: "not satisfied", NA: "not required" };
  function nobleRoomIconHtml(st) {
    const label = `${st.label}: ${NOBLE_ROOM_WORDS[nobleRoomSpriteState(st)]}`;
    return DWFUI.iconHtml({
      sprite: nobleRoomSprite(st), cls: "noble-room-icon", size: 24, title: label, alt: label,
    });
  }
  function nobleClockIconHtml(family, severity, cls, onTitle, offTitle) {
    const title = severity ? onTitle : offTitle;
    return DWFUI.iconHtml({
      sprite: `NOBLES_${family}_${NOBLE_CLOCK_STATE[severity] || "NA"}`,
      cls, size: 24, title, alt: title,
    });
  }
  function nobleMandateIconHtml(icons) {
    return nobleClockIconHtml("DEMANDS", icons.demand, "noble-demand-icon", "Active demand", "No demand")
      + nobleClockIconHtml("MANDATES", icons.mandate, "noble-mandate-icon", "Active mandate", "No mandate");
  }
  // The bookkeeper's 1..5 accounting-precision strip: five hand-built raw buttons with inline hex
  // borders/fills, over TEN sprites DF ships for exactly this control
  // (NOBLES_ACCOUNTING_{1..5}_{ACTIVE,INACTIVE}). It is a radiogroup -- exactly one active.
  //
  // *** segmentedHtml LIMITATION, REPORTED (lane contract says report, do not edit the foundation).
  // DWFUI.segmentedHtml is the right SEMANTIC component here (role=radiogroup / role=radio /
  // aria-checked) but it has NO per-option sprite or art channel: its options render only through
  // bitmapTextHtml (ui-components.js:1779-1785), so it physically cannot show DF's ten accounting
  // tiles. web/js/dwf-ui-components.js is LOCKED this wave, so per the contract's explicit
  // instruction the strip is composed from actionButtonsHtml + the sprites, and the gap is reported.
  // The cost is the radiogroup ARIA, not the art. `data-noble-precision` is unchanged, so
  // wireNoblesBody() and POST /noble-precision dispatch exactly as before.
  function noblePrecisionHtml(precision) {
    const active = noblePrecisionActiveButton(precision);
    return DWFUI.actionButtonsHtml(
      [1, 2, 3, 4, 5].map(n => ({
        action: `precision${n}`,
        sprite: `NOBLES_ACCOUNTING_${n}_INACTIVE`,
        activeSprite: `NOBLES_ACCOUNTING_${n}_ACTIVE`,
        active: n === active,
        title: `Bookkeeper precision ${n}`,
        dataset: { noblePrecision: n - 1 },
      })),
      { cls: "dwfui-actions noble-precision", ariaLabel: "Bookkeeper accounting precision" });
  }

  function noblesBody(data) {
    if (!data || data.error) return `<div class="info-message">Nobles unavailable: ${escapeHtml(data && data.error || "")}</div>`;
    const positions = Array.isArray(data.positions) ? data.positions : [];
    const mandates = Array.isArray(data.mandates) ? data.mandates : [];
    const hasPrecision = typeof data.bookkeeperPrecision === "number";
    const rows = positions.length ? positions.map(p => {
      const who = p.filled
        ? `<span${fortProfessionColorStyle(p)}>${fortUnitRef(p.unitId, p.holder)}</span>`
        : `<span class="fort-vacant">${DWFUI.bitmapTextHtml(p.assignmentId >= 0 ? "VACANT" : "NEW")}</span>`;
      // R4: room-requirement icons + demand/mandate icons for filled rows (native shows no icons on
      // VACANT rows). Falls back to the legacy "Needs:" text when the DLL served no room data.
      const iconStates = nobleRoomIconStates(p);
      let subHtml;
      if (p.filled && iconStates.length) {
        const isBookkeeper = /bookkeeper/i.test(String(p.name || ""));
        subHtml = `<div class="noble-icons" style="display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap">`
          + iconStates.map(nobleRoomIconHtml).join("")
          + `<span style="display:inline-block;width:6px"></span>`
          + nobleMandateIconHtml(nobleMandateIcons(p, mandates))
          + (isBookkeeper && hasPrecision ? noblePrecisionHtml(Number(data.bookkeeperPrecision)) : "")
          + `</div>`;
      } else {
        subHtml = p.requirements ? `<span class="fort-dim">Needs: ${escapeHtml(p.requirements)}</span>` : "";
      }
      // [+] ASSIGN. Native shows this ONLY on reassignable rows -- the blurb below says the nobility
      // "cannot be reassigned" -- and ours draws it on every row. *** THE WIRE DOES NOT SUPPORT THE
      // DISTINCTION: *** /nobles serves {name, positionId, assignmentId, squadSize, squadName,
      // precedence, requirements, rooms, roomsSatisfied, filled, holder, unitId}
      // (src/fort_admin.cpp:242-260) and carries NO appointed/elected/reassignable flag; DF's own
      // signal lives in entity_position flags, which the DLL never reads out. Deriving it from
      // `precedence` would be a guess. The lane brief says to verify the wire first -- it does not
      // support it -- so the button stays on every row (removing it would DELETE a live, approved
      // capability: the [+] candidate flyout -> /noble-candidates -> POST /noble-assign) and the gap
      // is REPORTED. Only the art changes here: NOBLES_ADD, the sprite DF ships for this exact tile.
      const assignBtn = DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.noblesAdd, cls: "fort-assign-btn", size: 24,
        dataset: { nobleAssign: p.positionId },
        title: "Assign / unassign this position", ariaLabel: "Assign or unassign this position",
      });
      // CROWN. Native draws it on EVERY row, including VACANT ones, so it keeps rendering
      // unconditionally. It was a 👑 emoji (&#128081;) over NOBLES_ASSIGN_SYMBOL, a sprite we own.
      // It stays `disabled` because it still dispatches nothing (no handler is bound to it anywhere
      // -- behaviour is unchanged), and it is marked `placeholder` so the foundation's
      // explicitly-unverified styling applies and the REQUIRED title says what is missing rather
      // than inventing behaviour.
      const crownBtn = DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.noblesCrown, cls: "fort-crown-btn", size: 24,
        placeholder: true, disabled: true, ariaLabel: "Assign a symbol",
        title: "Assign a symbol -- the native symbols screen is not implemented, so this tile does " +
          "nothing yet. Placeholder: its behaviour is unverified.",
      });
      // The row chassis. `.fort-row-noble` is a FIXED FIVE-TRACK CSS grid
      // (grid-template-columns: 1.3fr auto 1.4fr 1fr auto, dwf.css:4515-4521) that places its
      // children BY ORDER, so the migrated row must still emit exactly five direct children in the
      // same order: copy | [+] | who | sub | crown. That is why the sub cell is emitted even when
      // empty -- dropping it would shift the crown into the sub track. (This is the arch spec's own
      // rule: a fixed grid is not content-driven; an empty cell still occupies its track.)
      // `copyCls` REPLACES `.dwfui-copy` rather than adding to it, so both classes are passed: losing
      // `.dwfui-copy` would lose the chassis rule that makes it a flex COLUMN, and the squad-name
      // second line would collapse onto the position name.
      return `<div class="fort-noble-row">
        ${DWFUI.rowHtml({
          chassis: "table", cls: "fort-row fort-row-noble",
          copyCls: "dwfui-copy fort-cell-main",
          labelHtml: DWFUI.bitmapTextHtml(p.name),
          // R4: squad name second line on militia rows ("The Pinkertons"/"Delta Squad").
          sub: p.squadName ? { text: p.squadName, cls: "fort-dim noble-squad-name" } : null,
          cells: [
            { html: assignBtn },
            { html: who, cls: "fort-cell-who" },
            { html: subHtml, cls: "fort-cell-sub" },
          ],
          trailing: crownBtn,
        })}
        ${nobleCandidateListHtml(p.positionId)}
      </div>`;
    }).join("") : `<div class="info-message">No fort positions defined.</div>`;
    // SUPERSET -- PRESERVED BY RULING. Native has no mandate LIST; ours is a read-only display of
    // real wire data (/nobles `mandates`) carrying detail the icons above physically cannot: the
    // material, the amounts, and the days remaining. Coordinator ruling: KEEP + restyle. Function is
    // never reduced -- so it is migrated onto rowHtml and bitmap text, not deleted.
    // NO `chassis:` here, deliberately: `.fort-row-tall` is a ONE-COLUMN grid
    // (dwf.css:4468) whose three children stack, and the table chassis would re-lay it.
    const mandateRows = mandates.length ? mandates.map(m => {
      const byText = m.unitId >= 0 ? fortUnitRef(m.unitId, m.by) : DWFUI.bitmapTextHtml(m.by || "");
      const by = `<span${fortProfessionColorStyle(m, "byProfessionColor")}>${byText}</span>`;
      const kind = fortPrettyKey(m.mode); // Make / Export / Guild
      const isExport = String(m.mode || "").toLowerCase() === "export";
      // Material + item together ("iron short sword" / "silver"), whichever the mandate carries.
      const what = [m.material, m.item].map(s => (s || "").trim()).filter(Boolean).join(" ");
      const titleText = what
        ? `${isExport ? "Do not export" : "Make " + m.amountTotal} ${what}`
        : kind;
      // Countdown: server sends daysRemaining (-1 == ongoing/no deadline, e.g. an export ban).
      const deadline = (typeof m.daysRemaining === "number" && m.daysRemaining >= 0)
        ? `${m.daysRemaining} day(s) left` : "Ongoing";
      const progress = isExport ? ""
        : `<span class="fort-dim">${DWFUI.bitmapTextHtml(`${m.amountRemaining}/${m.amountTotal} left`)}</span> &middot; `;
      const penalty = m.punishMultiple
        ? ` &middot; <span class="fort-dim">${DWFUI.bitmapTextHtml("multiple offenders punished")}</span>` : "";
      return DWFUI.rowHtml({
        cls: "fort-row fort-row-tall",
        copyCls: "dwfui-copy fort-cell-main",
        labelHtml: DWFUI.bitmapTextHtml(titleText) +
          `<span class="fort-dim"> &middot; ${DWFUI.bitmapTextHtml(kind)}</span>`,
        cells: [
          { html: `${progress}<span class="fort-badge fort-badge-open">${DWFUI.bitmapTextHtml(deadline)}</span>${penalty}`,
            cls: "fort-cell-who" },
          { html: `${DWFUI.bitmapTextHtml("By")} ${by}`, cls: "fort-cell-sub" },
        ],
      });
    }).join("") : `<div class="info-message">No active mandates.</div>`;
    return `<div id="fortStatus" class="info-message fort-status" style="display:none"></div>
      <div class="fort-note">Members of the nobility have required rooms and can make demands. They cannot be reassigned. Administrators handle various aspects of your fortress and can be reassigned.</div>
      <div class="fort-section-title">Positions</div>${rows}
      <div class="fort-section-title">Active mandates</div>${mandateRows}`;
  }

  function wireNoblesBody(root) {
    root.querySelectorAll("[data-noble-assign]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        toggleNobleAssign(Number(button.dataset.nobleAssign));
      });
    });
    root.querySelectorAll("[data-noble-pick]").forEach(row => {
      row.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        submitNobleAssign(Number(row.dataset.noblePick), Number(row.dataset.nobleUnit));
      });
    });
    // R4: bookkeeper precision selector.
    root.querySelectorAll("[data-noble-precision]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        submitNoblePrecision(Number(button.dataset.noblePrecision));
      });
    });
  }

  async function submitNoblePrecision(level) {
    try {
      await fortFetchJson(
        `/noble-precision?player=${encodeURIComponent(player)}&level=${level}&t=${Date.now()}`,
        { method: "POST" });
      adminData.nobles = null;
      await refreshFortAdmin();
      fortSetStatus("Bookkeeper precision set.", false);
    } catch (err) {
      fortSetStatus(err.message || "Precision change failed.", true);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Justice (WD-21)
  // ---------------------------------------------------------------------------------------

  function justiceSubTabsHtml(activeMode = justiceMode) {
    // R3: no inner tabs -- native Intelligence is a flat sub-tab like the other five.
    // W3: the six Justice sub-tabs are the SHORT_SUBTAB tier (CIM-justice-convicts.jpg). Without
    // `level` they rendered as the generic tab and never reached the native art.
    return DWFUI.tabsHtml({
      cls: "info-tab-row", tabCls: "info-tab", dataAttr: "justice-mode", level: "subtab",
      ariaLabel: "Justice section", active: activeMode,
      tabs: JUSTICE_MODES.map(mode => ({ key: mode.key, label: mode.label })),
    });
  }

  // R3 pure helpers (DOM-free, unit-tested by tools/harness/cim_justice_test.mjs).
  // Native crime-mode label (CIM-justice-closed cases.jpg). Keys on the served enum string; falls
  // back to prettyFn for modes the oracle didn't pin.
  function justiceCrimeModeLabel(mode, prettyFn) {
    const m = String(mode || "");
    if (/production ?order/i.test(m)) return "Violation of production order";
    if (/export/i.test(m)) return "Violation of export prohibition";
    if (/job ?order/i.test(m)) return "Violation of job order";
    return typeof prettyFn === "function" ? prettyFn(m) : m;
  }
  // Right-pane detail lines. Omits any party the crime record does not carry (seeded-bad guard: a
  // null victim must produce NO "Injured party:" line, never "Injured party: .").
  function justiceCaseDetailLines(c) {
    const lines = [];
    if (!c) return lines;
    const has = (name, id) => (name != null && String(name).trim() !== "") || Number(id) >= 0;
    if (has(c.victim, c.victimId)) lines.push({ kind: "injured", label: "Injured party", name: c.victim, unitId: Number(c.victimId), professionColor: c.victimProfessionColor });
    if (c.sentenced && has(c.criminal, c.criminalId)) lines.push({ kind: "convicted", label: "Convicted", name: c.criminal, unitId: Number(c.criminalId), professionColor: c.criminalProfessionColor });
    else if (has(c.accused, c.accusedId)) lines.push({ kind: "accused", label: "Accused", name: c.accused, unitId: Number(c.accusedId), professionColor: c.accusedProfessionColor });
    return lines;
  }

  // ---- B227: convict / interrogate from the browser ----------------------------------------------
  // The server drives DF's NATIVE justice UI (widget walk + native keys through the viewscreen
  // feed -- see src/fort_admin.cpp /justice-convict); nothing is hand-written into the crime or
  // punishment records. The browser offers the case's NAMED parties as targets (accused first --
  // that is the native play flow). If the requested unit is not on DF's own suspect list, the
  // server's plain-English refusal is surfaced verbatim in the status line.
  //
  // GUARD-AWARENESS (the B226 trade-screen contract, applied here). Both drives ship behind host
  // flags in dfcapture-hostwrites.json (`justice_convict`, `justice_interrogate`; a MISSING file
  // means everything off -- it fails closed). A locked action must NEVER look live: it renders
  // DISABLED, names its own flag, and says in one plain sentence why. The guards ride the GET
  // /justice-convict poll, so the moment the host flips a flag the button lights up by itself --
  // no reload, no rebuild. Pure (DOM-free), tested by cim_justice_test.mjs.
  const JUSTICE_GUARD_COPY = {
    convict: 'Convicting from the browser is built, but it is locked until the host verifies it ' +
      'on this machine: flag "justice_convict" in dfcapture-hostwrites.json (next to the DF exe) ' +
      'is off. Dwarf Fortress itself performs the conviction; nothing is written until the flag is ' +
      'on. It unlocks live -- no reload.',
    interrogate: 'Assigning an interrogation from the browser is built, but it is locked until the ' +
      'host verifies it on this machine: flag "justice_interrogate" in dfcapture-hostwrites.json ' +
      '(next to the DF exe) is off. It unlocks live -- no reload.',
    unreadable: 'The host is not reporting its justice action flags (GET /justice-convict did not ' +
      'answer), so this action stays locked. That is a host/plugin problem, not a rule -- tell ' +
      'whoever runs the fort.',
  };

  // {enabled, reason} for one drive. `hostState` is the GET /justice-convict payload (or null when
  // it could not be read). Fails closed on every unknown: no flags = no action.
  function justiceActionState(hostState, kind) {
    const key = kind === "convict" ? "justiceConvict" : "justiceInterrogate";
    const guards = hostState && hostState.guards;
    if (!guards) return { enabled: false, reason: JUSTICE_GUARD_COPY.unreadable };
    if (guards[key] !== true) return { enabled: false, reason: JUSTICE_GUARD_COPY[kind] };
    return { enabled: true, reason: "" };
  }

  // The case's named parties, deduped, accused first (the native play flow). DF's own convict list
  // offers every unit in the fort; the browser only offers who the CASE names, and the server
  // honestly refuses anyone DF would not list ("unit N is not among the M candidates DF lists").
  function justiceCaseParties(c) {
    const parties = [];
    const seen = {};
    if (!c) return parties;
    for (const p of [{ id: c.accusedId, name: c.accused },
                     { id: c.criminalId, name: c.criminal }]) {
      const id = Number(p.id);
      const name = p.name != null ? String(p.name).trim() : "";
      if (Number.isInteger(id) && id >= 0 && !seen[id]) {
        seen[id] = true;
        parties.push({ id, name: name || `unit ${id}` });
      }
    }
    return parties;
  }

  function justiceCaseActionsHtml(c, activeMode, hostState) {
    if (!c || c.sentenced || activeMode !== "open") return "";
    const parties = justiceCaseParties(c);
    if (!parties.length) {
      return `<div class="justice-detail-line justice-case-noparty">${DWFUI.bitmapTextHtml(
        "No named suspect on this case yet; interrogation may surface one.")}</div>`;
    }
    const convict = justiceActionState(hostState, "convict");
    const interrogate = justiceActionState(hostState, "interrogate");
    const buttons = parties.map(p =>
      DWFUI.plaqueBtnHtml({
        label: `Convict ${p.name}`, tone: "red", cls: "justice-convict-btn",
        dataset: { justiceConvict: c.id, justiceUnit: p.id },
        disabled: !convict.enabled,
        title: convict.enabled
          ? "Convicts this unit through DF's own justice screen on the host. Irreversible " +
            "(a served sentence can only be commuted with Pardon). Click twice to confirm."
          : convict.reason,
      }) +
      DWFUI.plaqueBtnHtml({
        label: `Interrogate ${p.name}`, tone: "grey", cls: "justice-interrogate-btn",
        dataset: { justiceInterrogate: c.id, justiceUnit: p.id },
        disabled: !interrogate.enabled,
        title: interrogate.enabled
          ? "Adds this unit to the case's interrogation list through DF's own justice " +
            "screen; the Captain of the Guard conducts it."
          : interrogate.reason,
      })).join("");
    // The locked note: which action is locked, and why, ONCE -- so the reason is readable without
    // hovering a disabled button (a disabled button's tooltip is easy to miss, and on touch there
    // is no hover at all). Nothing is said when both are live.
    const locked = [];
    if (!convict.enabled) locked.push(convict.reason);
    if (!interrogate.enabled && interrogate.reason !== convict.reason) locked.push(interrogate.reason);
    const note = locked.length
      ? `<div class="justice-detail-line justice-guard-note">${
          locked.map(r => DWFUI.bitmapTextHtml(r)).join("</div><div class=\"justice-detail-line justice-guard-note\">")}</div>`
      : "";
    return `<div class="justice-detail-actions justice-case-actions">${buttons}</div>${note}`;
  }

  // R3: shared two-pane (master-detail) wrapper. Inline flex so it renders without new CSS; the
  // classnames let the CSS owner enhance later (justice-master-detail / -case-list / -case-detail /
  // justice-case-btn requested in the closeout).
  // Native colours each named party by that unit's profession. The crimes payload now supplies the
  // accused/criminal/victim professionColor fields, so the same dfColor pipeline can render the
  // actual unit instead of hard-coding the magenta observed for one captured dwarf.
  function justiceDetailLineHtml(l) {
    const who = Number(l.unitId) >= 0 ? fortUnitRef(l.unitId, l.name) : DWFUI.bitmapTextHtml(l.name || "");
    return `<div class="justice-detail-line">${DWFUI.bitmapTextHtml(`${l.label}:`)} <span${fortProfessionColorStyle(l)}>${who}</span>${DWFUI.bitmapTextHtml(".")}</div>`;
  }
  // W10 two-pane split (master LEFT half, detail RIGHT -- CIM-justice-convicts.jpg).
  //
  // *** CSS-HANDOFF S3-C1 IS ALREADY DONE ON THE CSS SIDE -- so the inline layout props are now just
  // a redundant duplicate, and they are deleted here with ZERO visual diff. *** The comment this
  // function used to carry was STALE. web/css/dwf.css:4491-4505 now reads, in the CSS owner's
  // own words: "The layout now lives HERE, so the JS inline layout props are a redundant duplicate
  // rather than the only source of truth, and dwf-fort-admin.js (NOT this owner's path) can
  // delete them in its own change with no visual diff -- the CSS already says the same thing."
  // `.justice-master-detail` supplies display:flex + gap:18px + align-items:flex-start, and
  // `.justice-case-list` / `.justice-case-detail` supply flex:1 1 50% + min-width:0. This is that
  // change. No CSS was edited to make it true; it was already true.
  //
  // *** NOT MIGRATED TO gridHtml, ON PURPOSE (reported). *** The lane brief nominated
  // gridHtml/gridCellHtml here under the frame rule, but gridHtml is the GOLD-DIVIDER table chassis:
  // `.dwfui-grid` paints `background: var(--dwfui-gold)` and lets it show through the `gap` as 1px
  // dividers (ui-components.js:2450-2470, dwf.css:6149-6153). The justice master/detail has NO
  // divider between its two panes in any oracle -- it is two panes side by side. Adopting gridHtml
  // would therefore ADD a gold rule the native screen does not have, and would additionally need a
  // grid-template-columns that neither the CSS nor a no-CSS-edit lane can supply (the template is
  // explicitly the consumer's job). Painting chrome native lacks is the exact defect the frame rule
  // exists to prevent, so the honest move is to drop the inline duplicate and leave the seam.
  function justiceMasterDetailHtml(listHtml, detailHtml) {
    return `<div class="justice-master-detail">` +
      `<div class="justice-case-list">${listHtml}</div>` +
      `<div class="justice-case-detail">${detailHtml}</div></div>`;
  }
  // The case MASTER SELECTOR (open / closed / cold). Native (attach-4-justice__open.webp) is a slab
  // plaque with GOLD CORNER BRACKETS when selected -- not a filled box, and not the inline gold
  // border this used to draw. `data-justice-case` IS the capability and survives verbatim:
  // it drives the detail pane, and on Convicts the detail pane is the only route to Pardon.
  function justiceCaseButtonHtml(id, label, active) {
    return DWFUI.plaqueBtnHtml({
      cls: "justice-case-btn", label: String(label), focus: !!active,
      dataset: { justiceCase: id },
    });
  }

  // ---- Justice / Convicts: the native UNIT ROW (CIM-justice-convicts.jpg) -------------------------
  // CONTENT-MODEL FIX: convicts were rendered as case PLAQUES. Native renders them as unit rows --
  // portrait tile, name + profession, then the [recenter][magnifier] tiles -- with the selected row
  // carrying a gold outline and corner ticks, fill unchanged.
  //
  // The convicts payload supplies profession, professionColor, and portraitTexpos. The renderer
  // consumes all three: native name colour, the profession line, and the portrait.
  // THE TRAILING PAIR (Wave 4). The oracle row is [portrait][name][recenter][magnifier], and both
  // tiles are GOLD-FRAMED and the SAME SIZE (CIM-justice-convicts.jpg, read directly).
  //
  //  * MAGNIFIER: was SQUADS_INSPECT (GREY/silver frame) -- The owner: "ours has a thinner white border,
  //    native has gold". Native is STOCKS_VIEW_ITEM (`TOKENS.sprites.view`, gold frame). S1 already
  //    established this for the unit profile; the fix never reached here. A magnifier that OPENS A
  //    SHEET is `view`, never `inspect`.
  //  * RECENTER: previously NOT DRAWN, on a FALSE premise ("the native tile has no route in the info
  //    family; cameraJump is private to dwf-chat.js"). chat's cameraJump is merely a private
  //    WRAPPER around `setCameraToMapPos` (dwf-unit-hud-notifications.js) -- a plain script-scope
  //    global reachable from here -- and GET /unit has always served `tile:{x,y,z}`
  //    (src/unit_sheet.cpp). Nothing was blocked. The owner, verbatim: this button "brings camera to that
  //    dwarf and selects their character profile" -- so ONE tile does BOTH (see justiceRecenterUnit).
  //  * SIZE: STOCKS_RECENTER + STOCKS_VIEW_ITEM, the 24x36 pair S1's unit-profile rows already use,
  //    so the two tiles match. (RECENTER_RECENTER/SQUADS_RECENTER is 32x36 and would not.)
  //
  // The guard branch calls this too. Guard members now carry the same profession/portrait identity
  // fields, but no crimeId, so `hasCase` is false for them
  // and the row correctly omits `data-justice-case` and `role="option"`: an absent cell renders
  // NOTHING (native omits; it does not blank), and a guard row is not a selectable case. For a
  // convict, crimeId is present and the emitted markup is UNCHANGED, byte for byte.
  function justiceConvictRowHtml(c, selected) {
    const unitId = Number(c.unitId);
    const name = String(c.name || "Unknown");
    const live = Number.isInteger(unitId) && unitId >= 0;
    const hasCase = Number.isFinite(Number(c.crimeId));
    const portrait = (typeof unitPortraitMarkup === "function")
      ? unitPortraitMarkup(Object.assign({ unitId, id: unitId, name }, c), "info-portrait-small")
      : DWFUI.iconHtml({ letter: name, size: 48, alt: name });
    const profession = String(c.profession || "").trim();
    const labelHtml = `<div class="justice-row-identity"${fortProfessionColorStyle(c)}>` +
      DWFUI.bitmapTextHtml(name) +
      (profession ? `<div class="justice-row-profession">${DWFUI.bitmapTextHtml(profession)}</div>` : "") +
      `</div>`;
    const S = DWFUI.TOKENS.sprites;
    const actions = DWFUI.actionButtonsHtml(
      [{ action: "recenter", sprite: S.recenterStocks, title: `Center the view on ${name} and open their profile`,
         disabled: !live, dataset: { justiceRecenter: live ? unitId : "" } },
       { action: "view", sprite: S.view, title: `View ${name}`,
         dataset: { unitId: live ? unitId : "" } }],
      { cls: "dwfui-actions justice-row-actions", ariaLabel: "Convict actions" });
    return DWFUI.rowHtml(Object.assign({
      chassis: "table", cls: "justice-convict-row", selected: !!selected,
      icon: portrait,
      labelHtml,
      cells: [{ html: actions, cls: "justice-row-actions-cell" }],
    }, hasCase ? { role: "option", dataset: { justiceCase: c.crimeId } } : {}));
  }
  // W7a. `Cat` and `Prof` are the columns native sorts by; neither field is on our wire, so they
  // render DISABLED with a title that says why. A live-looking sort button over data we do not have
  // is a fabricated control -- this is the honest form of the native header.
  function justiceConvictSortHtml(active) {
    return DWFUI.sortHeaderHtml({
      cls: "justice-sort", dataAttr: "justice-sort", ariaLabel: "Sort convicts",
      active: active === "name" ? "name" : "name",
      columns: [
        { key: "name", label: "Name", sort: "desc", title: "Sort by name" },
        { key: "cat", label: "Cat", sort: "desc", disabled: true,
          title: "Category sorting needs a `category` field on /justice (not served)" },
        { key: "prof", label: "Prof", sort: "desc", disabled: true,
          title: "Profession sorting needs a `profession` field on /justice (not served)" },
      ],
    });
  }

  function justiceBody(data, options = {}) {
    if (!data || data.error) return `<div class="info-message">Justice unavailable: ${escapeHtml(data && data.error || "")}</div>`;
    const activeMode = options.mode || justiceMode;
    let selectedCase = Number.isFinite(Number(options.selectedCase)) ? Number(options.selectedCase) : justiceSelectedCase;
    const modeDef = JUSTICE_MODES.find(m => m.key === activeMode) || JUSTICE_MODES[0];
    // The `.fort-note` prose that used to sit here ("Pardon commutes a serving sentence from
    // here...") is DELETED: native's Justice screens carry no blurb (W5 is a Nobles-only region),
    // and its one real job -- explaining Pardon, a control vanilla DF does not have -- is now done
    // by Pardon's own tooltip in the convicts branch below. DELETION-LEDGER row 3 permits the
    // deletion only in the same change that gives Pardon that tooltip; this is that change.
    const status = `<div id="fortStatus" class="info-message fort-status" style="display:none"></div>`;

    if (activeMode === "open" || activeMode === "closed" || activeMode === "cold") {
      const crimes = Array.isArray(data.crimes) ? data.crimes : [];
      if (!crimes.length) return status + `<div class="info-message">${modeDef.empty}</div>`;
      if (!crimes.some(c => Number(c.id) === selectedCase)) selectedCase = Number(crimes[0].id);
      if (!options.mode) justiceSelectedCase = selectedCase;
      const sel = crimes.find(c => Number(c.id) === selectedCase) || crimes[0];
      const listHtml = crimes.map(c =>
        justiceCaseButtonHtml(c.id, justiceCrimeModeLabel(c.mode, fortPrettyKey), Number(c.id) === selectedCase)).join("");
      const lines = justiceCaseDetailLines(sel);
      // Native's selected plaque already states the crime. The right pane contains party lines
      // only; repeating the crime and adding a year produced a title that is absent from every
      // exact case capture.
      // B227: plus the convict/interrogate actions for OPEN cases (native-driven server-side),
      // guard-aware: `hostState` carries the host's action flags (options.hostState lets the
      // offline fixtures drive it; the browser reads the live poll's justiceHostState).
      const hostState = Object.prototype.hasOwnProperty.call(options, "hostState")
        ? options.hostState : justiceHostState;
      const detailHtml = (lines.length ? lines.map(justiceDetailLineHtml).join("") : "")
        + justiceCaseActionsHtml(sel, activeMode, hostState);
      return status + justiceMasterDetailHtml(listHtml, detailHtml);
    }
    if (activeMode === "guard") {
      // CONTENT-MODEL FIX. This branch hand-built a bare `.fort-row` + `.fort-cell-main` holding a
      // name -- but native (CIM-justice-Fortress guard.jpg, provenance native/good) draws a guard
      // member with the IDENTICAL anatomy as a convict: portrait tile, semantic name, then the
      // [recenter][magnifier] pair. justiceConvictRowHtml already emits exactly that row and is
      // Gate-C APPROVED, so this reuses it rather than maintaining a second, worse copy of the same
      // row. Both trailing tiles keep working for guard members: `justiceRecenter` (camera + profile)
      // and `unitId` (unit sheet) are keyed off unitId, which the guard payload does serve.
      // Guard members carry NO crimeId, so the row omits data-justice-case and is not selectable --
      // correct: there is no case to select, and the guard branch has no detail pane.
      const guard = data.guard || {};
      const members = Array.isArray(guard.members) ? guard.members : [];
      if (guard.unsupported || !members.length)
        return status + `<div class="info-message">${modeDef.empty}</div>`;
      // Guard members now use the same profession-coloured identity row as convicts.
      const hasDesiredCount = guard.desiredTotal != null && Number.isFinite(Number(guard.desiredTotal));
      const current = Number.isFinite(Number(guard.desiredCurrent)) ? Number(guard.desiredCurrent) : 0;
      const total = hasDesiredCount ? Number(guard.desiredTotal) : 0;
      const selectedUnitId = Number(guard.selectedUnitId);
      const rows = members.map(m => justiceConvictRowHtml(m,
        Number.isFinite(selectedUnitId) && Number(m.unitId) === selectedUnitId)).join("");
      return status + (hasDesiredCount ? `<div class="justice-guard-summary">${DWFUI.bitmapTextHtml(`Desired metal cages and chains in dungeons: ${current} of ${total}`)}</div>` : "") +
        justiceConvictSortHtml("name") +
        `<div class="justice-guard-list">${rows}</div>`;
    }
    if (activeMode === "convicts") {
      const convicts = Array.isArray(data.convicts) ? data.convicts : [];
      if (!convicts.length) return status + `<div class="info-message">${modeDef.empty}</div>`;
      if (!convicts.some(c => Number(c.crimeId) === selectedCase)) selectedCase = Number(convicts[0].crimeId);
      if (!options.mode) justiceSelectedCase = selectedCase;
      const sel = convicts.find(c => Number(c.crimeId) === selectedCase) || convicts[0];
      const sorted = convicts.slice().sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || "")));
      const listHtml = justiceConvictSortHtml("name") +
        `<div class="justice-convict-list" role="listbox" aria-label="Convicts">` +
        sorted.map(c => justiceConvictRowHtml(c, Number(c.crimeId) === selectedCase)).join("") +
        `</div>`;
      const serving = sel.prisonTime > 0 || sel.hammerstrikes > 0;
      const sentence = serving
        ? [sel.prisonTime > 0 ? `${sel.prisonTime} days jail` : "", sel.hammerstrikes > 0 ? `${sel.hammerstrikes} hammerstrikes` : ""].filter(Boolean).join(", ")
        : "No sentence pending.";
      // PARDON. NOT NATIVE, AND THAT IS THE POINT: it mirrors DFHack `justice.lua pardon`
      // (src/fort_admin.cpp:882 do_justice_pardon), commuting a serving sentence AND clearing the
      // pending physical-punishment counters, because a browser player cannot reach DFHack's
      // console. KEEP + restyle (DELETION-LEDGER row 1, the owner 2026-07-12). It only renders for the
      // SELECTED convict, which is why the row list above had to keep `data-justice-case`.
      // The `alerts-action` class -- borrowed from another family -- is gone; the deleted
      // `.fort-note` prose that used to explain it now lives in this button's own tooltip, as the
      // ledger requires (row 3: delete the note ONLY alongside a Pardon tooltip).
      const pardonBtn = serving && Number(sel.unitId) >= 0
        ? `<div class="justice-detail-actions">${DWFUI.plaqueBtnHtml({
            label: "Pardon", tone: "grey", cls: "justice-pardon",
            dataset: { justicePardon: sel.unitId },
            title: "Pardon commutes this convict's serving sentence and clears any pending " +
              "hammerstrikes. Convictions and interrogations are decided natively on the host.",
          })}</div>`
        : "";
      // R3: injured-party join (convicts payload now carries victim/victimId). Omit the line when the
      // crime has no recorded victim (seeded-bad guard: never "Injured party: .").
      const hasVictim = Number(sel.victimId) >= 0 || (sel.victim != null && String(sel.victim).trim() !== "");
      const injuredHtml = hasVictim
        ? `<div class="justice-detail-line justice-detail-indent">${DWFUI.bitmapTextHtml("Injured party:")} ` +
          `<span${fortProfessionColorStyle(sel, "victimProfessionColor")}>` +
          `${Number(sel.victimId) >= 0 ? fortUnitRef(sel.victimId, sel.victim) : DWFUI.bitmapTextHtml(sel.victim)}</span>` +
          `${DWFUI.bitmapTextHtml(".")}</div>`
        : "";
      // Native's detail pane (CIM-justice-convicts.jpg) is: sentence line, blank, crime, indented
      // injured party. There is NO name heading -- the name is already in the selected row, and the
      // row's magnifier still opens the unit sheet, so no capability is lost by dropping it.
      const detailHtml = `<div class="justice-detail-line">${DWFUI.bitmapTextHtml(sentence)}</div>`
        + `<div class="justice-detail-line justice-detail-crime">${DWFUI.bitmapTextHtml(justiceCrimeModeLabel(sel.mode, fortPrettyKey))}</div>`
        + injuredHtml
        + pardonBtn;
      return status + justiceMasterDetailHtml(listHtml, detailHtml);
    }
    if (activeMode === "counterintel") {
      // R3: base-DF Intelligence tab -- verbatim two-line empty state (CIM-justice-intelligence.jpg).
      // Reports aren't trivially readable server-side (fort_admin.cpp ENDPOINT-EXTEND note); when a
      // fort has no intelligence activity this IS the native screen, not a placeholder.
      return `<div id="fortStatus" class="info-message fort-status" style="display:none"></div>
        <div class="info-message">There is no intelligence information yet.</div>
        <div class="info-message">If a crime involves a conspiracy, an interrogation may reveal the plot.</div>`;
    }
    return status + `<div class="info-message">${modeDef.empty}</div>`;
  }

  // B227: run the native conviction / interrogation drive. Success refreshes the justice data;
  // a 501 {"guarded":true} or any drive abort surfaces the server's own reason verbatim.
  async function justiceDrive(kind, crimeId, unitId) {
    // Defence in depth: the buttons are already rendered `disabled` when the flag is off (a
    // disabled button fires no click), so this can only be reached by a stale render racing a
    // flag flip -- refuse locally rather than send a POST we know the server will 501.
    const state = justiceActionState(justiceHostState, kind);
    if (!state.enabled) { fortSetStatus(state.reason, true); return; }
    const route = kind === "convict" ? "/justice-convict" : "/justice-interrogate";
    fortSetStatus(kind === "convict" ? "Convicting through the host's justice screen…"
                                     : "Updating the interrogation list…", false);
    try {
      const data = await fortFetchJson(
        `${route}?player=${encodeURIComponent(player)}&crime=${crimeId}&unit=${unitId}&t=${Date.now()}`,
        { method: "POST" });
      adminData.justice = null;
      await refreshFortAdmin();
      if (kind === "convict") fortSetStatus("Conviction recorded by Dwarf Fortress.", false);
      else fortSetStatus(Number(data && data.reportsDelta) > 0
        ? "Added to the case's interrogation list." : "Interrogation list updated.", false);
    } catch (err) {
      fortSetStatus(err.message || `${kind} failed.`, true);
    }
  }

  async function justicePardon(unitId) {
    if (!(unitId >= 0)) return;
    try {
      await fortFetchJson(
        `/justice-pardon?player=${encodeURIComponent(player)}&unit=${unitId}&t=${Date.now()}`,
        { method: "POST" });
      adminData.justice = null;
      await refreshFortAdmin();
      fortSetStatus("Sentence commuted.", false);
    } catch (err) {
      fortSetStatus(err.message || "Pardon failed.", true);
    }
  }

  // The native [recenter] tile, wired. The owner: it "brings camera to that dwarf AND selects their character
  // profile" -- both, from ONE tile. `GET /unit` already returns the camera target (`tile`) and the
  // whole sheet payload in the SAME response, so this is one fetch, no new route, no new wire field:
  //   tile -> setCameraToMapPos (dwf-unit-hud-notifications.js, script-scope global)
  //   payload -> showUnitSheet (same file) -- identical to what openUnitById does with it.
  // Falls back to openUnitById if the camera global is absent (e.g. the Node harness), so the profile
  // half never silently disappears.
  async function justiceRecenterUnit(unitId) {
    const id = Number(unitId);
    if (!Number.isInteger(id) || id < 0) return false;
    try {
      const response = await fetch(
        `/unit?player=${encodeURIComponent(player)}&id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("unit failed");
      const data = await response.json();
      const pos = data && (data.tile || (data.unit && data.unit.tile));
      if (pos && typeof setCameraToMapPos === "function") {
        await setCameraToMapPos(pos);
        if (typeof flashMapTile === "function") flashMapTile(pos);
      }
      if (typeof showUnitSheet === "function") showUnitSheet(data);
      else if (typeof openUnitById === "function") openUnitById(id);
      return true;
    } catch (_) {
      if (typeof openUnitById === "function") openUnitById(id);
      return false;
    }
  }

  function wireJusticeBody(root) {
    root.querySelectorAll("[data-justice-recenter]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justiceRecenterUnit(button.dataset.justiceRecenter);
      });
    });
    root.querySelectorAll("[data-justice-pardon]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justicePardon(Number(button.dataset.justicePardon));
      });
    });
    // B227: conviction is a one-way door -> armed two-step click (first click arms, second
    // fires); switching targets or re-rendering disarms. Interrogation is reversible: one click.
    root.querySelectorAll("[data-justice-convict]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.armed !== "1") {
          root.querySelectorAll("[data-justice-convict]").forEach(b => { b.dataset.armed = ""; b.classList.remove("armed"); });
          button.dataset.armed = "1";
          button.classList.add("armed");
          fortSetStatus("Click again to confirm the conviction — it is irreversible.", true);
          return;
        }
        button.dataset.armed = "";
        button.classList.remove("armed");
        justiceDrive("convict", Number(button.dataset.justiceConvict), Number(button.dataset.justiceUnit));
      });
    });
    root.querySelectorAll("[data-justice-interrogate]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justiceDrive("interrogate", Number(button.dataset.justiceInterrogate), Number(button.dataset.justiceUnit));
      });
    });
    root.querySelectorAll("[data-justice-mode]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const mode = button.dataset.justiceMode;
        if (mode === justiceMode) return;
        justiceMode = mode;
        justiceSelectedCase = -1;   // R3: reset master-detail selection when switching sub-tabs
        adminData.justice = null;
        infoShellLoadingShell("justice", "Justice");
        refreshFortAdmin();
      });
    });
    // R3: master-detail case selection (open/closed/cold + convicts). No refetch -- data is cached.
    root.querySelectorAll("[data-justice-case]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        justiceSelectedCase = Number(button.dataset.justiceCase);
        renderFortAdminPanel();
      });
    });
  }

  function petitionsBody(data) {
    if (!data || data.error) return `<div class="info-message">Petitions unavailable: ${escapeHtml(data && data.error || "")}</div>`;
    const petitions = Array.isArray(data.petitions) ? data.petitions : [];
    if (!petitions.length) return `<div id="fortStatus" class="info-message fort-status" style="display:none"></div><div class="info-message">No pending petitions or agreements.</div>`;
    if (!petitions.some(p => Number(p.id) === Number(petitionSelectedId))) petitionSelectedId = petitions[0].id;
    const selected = petitions.find(p => Number(p.id) === Number(petitionSelectedId)) || petitions[0];
    const rows = petitions.map(p => {
      return DWFUI.rowHtml({ cls: "petition-list-row", dataset: { petitionSelect: p.id },
        selected: Number(p.id) === Number(selected.id),
        label: `Status of ${p.petitioner || "Unknown petitioner"}`,
        trailing: "" });
    }).join("");
    const detail = selected.site && selected.purpose
      ? `<div class="petition-copy"><div class="petition-person">${escapeHtml(selected.petitioner)}</div><div>wishes to reside in</div><div class="petition-site">${escapeHtml(selected.site)}</div><div>for the purpose of</div><div class="petition-purpose">${escapeHtml(selected.purpose)}</div></div>`
      : `<div class="petition-copy"><div class="petition-person">${escapeHtml(selected.petitioner || "Unknown petitioner")}</div><div class="petition-wire-gap">${escapeHtml(fortPrettyKey(selected.summary || "Petition details unavailable"))}</div></div>`;
    // B225 fail-closed (2026-07-17): the Approve/Deny buttons were REMOVED. They POSTed
    // /petition-accept|/petition-deny, which faked the decision -- accept only cleared the agreement
    // flag (LIVE-verified the petitioner never actually gained residency) and deny only dropped the
    // row (the petitioner re-petitioned), so petitions "vanished then came back and were never
    // really resolved" -- the owner's exact report. The plugin can't reproduce native's residency
    // grant without risking save corruption, so we tell the truth: the host decides each petition in
    // the Steam client. The honest browser lever is the "Future such petitions" standing-order
    // toggle below (DF then auto-handles new petitions of this kind natively). Server routes now
    // 501 native-only to match.
    const selectedActions = selected.pending
      ? `<div class="petition-question">This petition must be decided by the host</div><div class="petition-hint">Approving or denying isn't available in the browser — a plugin write can’t grant residency or record the decision, so it would only hide the row without resolving it. The host can decide it in the Steam client (the petition notification / Agreements screen). You can still set the auto-response for future petitions of this kind below.</div>`
      : `<span class="fort-badge fort-badge-done">Accepted</span>`;
    // B225 (was the B190 "wired route with no listener" follow-up): the plaque is now BOUND --
    // renderFortAdminPanel() below wires [data-petition-future] to petitionPolicyCycle(), which
    // POSTs /petition-policy with the NEXT value of native's 3-state prompt/accept/reject cycle
    // (the same cycle the standing-orders Petitions tab uses -- see PETITION_POLICY_CYCLE).
    const future = DWFUI.plaqueBtnHtml({
      label: `Future such petitions: ${selected.futurePolicy || "unavailable"}`,
      tone: "grey", cls: "petition-future", dataset: { petitionFuture: selected.id },
      disabled: !selected.futurePolicy,
    });
    // W5: the two statements that used to sit BELOW this return were UNREACHABLE -- a second
    // `return` and a `.fort-note` string that no build has ever rendered. Removed as genuinely dead
    // code (no id, no data-attr, no handler, no route: nothing selects it, and it cannot execute).
    return `<div id="fortStatus" class="info-message fort-status" style="display:none"></div><div class="petition-box"><div class="petition-list">${rows}</div><div class="petition-detail">${detail}${selectedActions}${future}<div class="petition-hint">This can also be changed in<br>Labor -&gt; Standing orders -&gt; Petitions.</div></div></div>`;
  }

  function renderFortAdminPanel() {
    const data = adminData[adminTab];
    if (adminTab === "nobles") {
      activeInfoPanel = "nobles";
      renderInfoShellWindow("nobles", noblesBody(data), { onRender: () => wireNoblesBody(clientPanel) });
      return;
    }
    if (adminTab === "justice") {
      activeInfoPanel = "justice";
      renderInfoShellWindow("justice", justiceBody(data), {
        subTabsHtml: justiceSubTabsHtml(),
        onRender: () => wireJusticeBody(clientPanel),
      });
      return;
    }
    fortRenderWindow({
      title: "Petitions",
      body: petitionsBody(data),
      onRender: () => {
        clientPanel.querySelectorAll("[data-petition-select]").forEach(row =>
          row.addEventListener("click", () => { petitionSelectedId = Number(row.dataset.petitionSelect); renderFortAdminPanel(); }));
        // B225 fail-closed: no [data-petition-accept]/[data-petition-deny] any more -- per-petition
        // approve/deny is host-only (Steam client). Only select + the standing-order policy remain.
        clientPanel.querySelectorAll("[data-petition-future]").forEach(b =>
          b.addEventListener("click", () => petitionPolicyCycle(b.dataset.petitionFuture)));
      },
    });
  }

  // Native's standing-orders petition policy is a 3-state cycle (labor-work-orders R9:
  // prompt=0 / accept=1 / reject=2, from CIM-labor-standing-orders-petitions.jpg). The
  // futurePolicy wire value (B190 petition_policy_name) is one of these names; clicking
  // advances to the NEXT state via POST /petition-policy?id=&value= (server maps the value
  // onto the right standing_orders_petition_* global for this petition's category).
  const PETITION_POLICY_CYCLE = ["prompt", "accept", "reject"];

  async function petitionPolicyCycle(id) {
    const current = adminData.petitions && Array.isArray(adminData.petitions.petitions)
      ? (adminData.petitions.petitions.find(p => Number(p.id) === Number(id)) || {}).futurePolicy
      : "";
    const idx = PETITION_POLICY_CYCLE.indexOf(current);
    if (idx < 0) { fortSetStatus("Petition policy unavailable for this petition.", true); return; }
    const next = (idx + 1) % PETITION_POLICY_CYCLE.length;
    try {
      await fortFetchJson(`/petition-policy?player=${encodeURIComponent(player)}&id=${encodeURIComponent(id)}&value=${next}&t=${Date.now()}`, { method: "POST" });
      adminData.petitions = null;
      await refreshFortAdmin();
      fortSetStatus(`Future such petitions: ${PETITION_POLICY_CYCLE[next]}.`, false);
    } catch (err) {
      fortSetStatus(err.message || "Policy change failed.", true);
    }
  }

  // B225 fail-closed (2026-07-17): petitionAction() was DELETED. It POSTed /petition-accept or
  // /petition-deny and then optimistically re-rendered as "Petition accepted/denied." -- but those
  // routes faked the decision (accept never granted residency; deny only dropped the row and the
  // petitioner re-petitioned), so the confirmation was a lie and the petition "came back". Approve/
  // deny is now host-only; the routes 501 native-only. The only remaining petition write from the
  // browser is petitionPolicyCycle() below (the standing-orders auto-response), which is honest.

  // Node export for the offline CIM fixture tests (harmless in the browser: `module` is undefined).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { justiceCrimeModeLabel, justiceCaseDetailLines, justiceSubTabsHtml, justiceBody, noblesBody,
      justiceConvictRowHtml, justiceRecenterUnit, justiceCaseActionsHtml,
      justiceActionState, justiceCaseParties, JUSTICE_GUARD_COPY,
      JUSTICE_MODES, nobleRoomIconStates, nobleMandateIcons, noblePrecisionActiveButton, NOBLE_ROOM_KINDS,
      nobleRoomSpriteState, nobleRoomSprite, nobleRoomIconHtml, nobleMandateIconHtml, noblePrecisionHtml };
  }
