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

// WD-27 (part 1/2 -- see dwf-escmenu.js for the Esc-menu half): DF's real World screen
// (22-world.png), hotkey Shift+Y / the bottom-right toolbar button. DF's World screen is a
// full-screen takeover (not a floating info-window like the other 8 tabs), so this owns its
// own top-level overlay (#worldScreen, a sibling of #hud -- same pattern as #hotkeyOverlay/
// #escMenu) instead of mounting into #clientPanel.
//
// Center on fort / Civilizations / Done are native world actions. Artifacts and Reports route
// into the production information/announcements screens that already own those datasets.
// Missing citizens reuses Creatures ▸ Dead/Missing. News and rumors and civilization details read
// the additive world-map payload. MISSIONS is now its own deep screen backed by /missions (B228):
// a real order builder (target / mission type / squads) plus the one real write in the domain
// (rescue a stranded squad via DFHack's fix/stuck-squad). The SEND is validated server-side and
// then refused -- DF creates missions only inside its own viewscreen_worldst and exposes no API.
// See src/missions.h and the B228 banner further down before changing any of it.
//
// REGION NAME PLATE (WD-27 follow-up, landed): 22-world.png's top-right plate shows DF's real
// *world-region* name ("The Gulf of Deteriorating", an orange-bordered box, region name only --
// no fort name in DF's own layout). `/world-map` now emits `regionName`
// (src/worldmap_panel.cpp: world_site.pos -> world_data.region_map[x][y].region_id ->
// world_data.regions[region_id].name, translated -- same lookup embark-assistant/probe/
// prospector use). The plate renders that as its primary line, 1:1 with DF; the fort's own name
// (previously the whole plate, as a stand-in before this endpoint existed) is kept as a small
// secondary line for multiplayer context -- clearly a client addition, not part of DF's native
// chrome, and never substituted for the real region name.

  let worldMapData = null;
  let worldScreenOpenState = false;
  let worldPanelMode = null; // null | civs | missions | news
  let worldSelectedCivId = -1;

  async function openWorldMapPanel() {
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    if (typeof closeClientPanel === "function") closeClientPanel();
    if (typeof closeSelection === "function") closeSelection();
    if (typeof setActiveToolbar === "function") setActiveToolbar("worldmap");
    worldScreenOpenState = true;
    worldPanelMode = null;
    worldSelectedCivId = -1;
    ensureWorldScreenEl().classList.add("open");
    renderWorldScreenShell("Loading world map...");
    try {
      worldMapData = await fortFetchJson(`/world-map?player=${encodeURIComponent(player)}&t=${Date.now()}`);
    } catch (err) {
      worldMapData = { error: err.message || "unavailable" };
    }
    renderWorldScreenShell();
    if (window.DFHelpPopup) DFHelpPopup.maybeShow("world");
  }

  function worldScreenOpen() { return worldScreenOpenState; }

  function closeWorldScreen() {
    worldScreenOpenState = false;
    worldPanelMode = null;
    worldSelectedCivId = -1;
    missionsData = null;      // B228: a reopened Missions panel re-reads DF; it never shows a stale
    missionsView = "list";    // roster of who is away.
    missionBusy = false;
    resetMissionDraft();
    const el = document.getElementById("worldScreen");
    if (el) { el.classList.remove("open"); el.innerHTML = ""; }
    if (typeof setActiveToolbar === "function") setActiveToolbar(null);
    try { document.getElementById("view")?.focus({ preventScroll: true }); } catch (_) {}
  }

  // R1 DEFERRAL, DELIBERATE. WORLD_SITE_COLORS + WORLD_TERRAIN_COLORS are the only two hex tables
  // left in this module, and they are NOT DOM chrome: they are raster data->colour maps consumed by
  // canvas ctx.fillStyle in drawWorldCanvas (a biome/site palette, not a button or a border). Their
  // correct home is a named biome palette under DWFUI.TOKENS.palette -- but dwf-ui-components.js
  // is LOCKED to this lane, so there is nowhere legal to put them, and inventing a second private
  // palette here would be strictly worse. They stay, and the drift baseline keeps its 2 R1 entries
  // for this file. Reported in the closeout as a foundation-owned follow-up.
  const WORLD_SITE_COLORS = {
    PlayerFortress: "#ffd54f", Fortress: "#b0bec5", DarkFortress: "#8e24aa",
    Town: "#66bb6a", MountainHalls: "#a1887f", ForestRetreat: "#43a047",
    Cave: "#6d4c41", Camp: "#bcaaa4", Monument: "#90a4ae",
  };

  function worldSiteColor(type, own) {
    if (own) return "#ff5252";
    return WORLD_SITE_COLORS[type] || "#78909c";
  }

  // B88: the world map was "totally broken" -- it drew only site markers as tiny squares on a
  // near-black background, with NO terrain/ocean/biome raster, so it read as confetti on black
  // instead of DF's colourful world map. The fix renders a downsampled biome grid the server now
  // emits on /world-map (additive `terrain` field, src/worldmap_panel.cpp) BEHIND the sites. The
  // biome char alphabet is classified server-side from region_map_entry elevation/vegetation/
  // rainfall/salinity; the COLOUR mapping lives here (client-side + testable). Unknown/missing
  // chars draw nothing, so the layer degrades cleanly. See decodeWorldTerrain() for the envelope.
  const WORLD_TERRAIN_COLORS = {
    "~": "#274b6e", // ocean (salt water)
    "l": "#356a8a", // lake / fresh water
    "^": "#6b5f50", // mountain
    "T": "#2f5a2c", // forest (heavy vegetation)
    ".": "#4e7638", // grassland / light vegetation
    "d": "#b9a566", // desert (arid, sparse vegetation)
    "n": "#6d6a53", // barren / rock
    "f": "#3f5f3a", // wetland / marsh (fallback greenish)
  };
  function worldTerrainColor(ch) {
    return WORLD_TERRAIN_COLORS[ch] || "";
  }

  // Validate + normalise the additive /world-map `terrain` envelope. Returns null when absent or
  // malformed (older DLLs, degenerate worlds) so the caller simply skips the terrain layer.
  //   terrain: { w:int, h:int, step:int, rows:[ "<w chars>" , ... ] }   (rows.length === h)
  function decodeWorldTerrain(terrain) {
    if (!terrain || typeof terrain !== "object") return null;
    const rows = Array.isArray(terrain.rows) ? terrain.rows : null;
    const w = Number(terrain.w), h = Number(terrain.h);
    const step = Math.max(1, Number(terrain.step) || 1);
    if (!rows || !rows.length) return null;
    if (!(w > 0) || !(h > 0)) return null;
    if (rows.length !== h) return null;
    return { w, h, step, rows };
  }

  // Pure fit-and-centre transform shared by the terrain + site passes (world tiles -> canvas px).
  function worldMapLayout(worldW, worldH, cssW, cssH) {
    const w = Math.max(1, Number(worldW) || 1);
    const h = Math.max(1, Number(worldH) || 1);
    const cw = Math.max(1, Number(cssW) || 1);
    const ch = Math.max(1, Number(cssH) || 1);
    const scale = Math.min(cw / w, ch / h);
    return { scale, ox: (cw - w * scale) / 2, oy: (ch - h * scale) / 2 };
  }

  function ensureWorldScreenEl() {
    let el = document.getElementById("worldScreen");
    if (!el) {
      el = document.createElement("div");
      el.id = "worldScreen";
      document.body.appendChild(el);
    }
    return el;
  }

  // Bottom-right button stack, DF's exact order (22-world.png): Center on fort / Missions /
  // News and rumors / Civilizations / Missing citizens / Artifacts / Reports / Done.
  //
  // THE TONES ARE READ OFF THE ORACLE, NOT INVENTED. tools/spikes/ui-truth/22-world.png (native,
  // quality "good") shows this stack as native PLAQUES, each with a tone, in exactly this order:
  //   Center on fort GREEN | Missions RED | News and rumors GREEN | Civilizations GREEN |
  //   Missing citizens RED | Artifacts GREEN | Reports RED | Done GREY
  // We used to emit toneless hand-built HTML buttons. The tones are recorded here as OBSERVED FACT
  // from one capture; whether DF drives any of them from state (e.g. red = "has none") is NOT
  // determinable from a single frame, so no semantics are inferred and none are coded.
  const WORLD_BUTTONS = [
    { key: "center", label: "Center on fort", enabled: true, tone: "green" },
    { key: "missions", label: "Missions", enabled: true, tone: "red" },
    { key: "news", label: "News and rumors", enabled: true, tone: "green" },
    { key: "civs", label: "Civilizations", enabled: true, tone: "green" },
    { key: "missing", label: "Missing citizens", enabled: true, tone: "red" },
    { key: "artifacts", label: "Artifacts", enabled: true, tone: "green" },
    { key: "reports", label: "Reports", enabled: true, tone: "red" },
    { key: "done", label: "Done", enabled: true, tone: "grey" },
  ];

  function worldButtonRoute(key) {
    if (key === "artifacts") return { kind:"panel", name:"objects" };
    if (key === "reports") return { kind:"panel", name:"reports" };
    if (key === "missing") return { kind:"panel", name:"citizens", section:"creatures", detail:"dead" };
    if (key === "civs") return { kind:"civs" };
    if (key === "missions") return { kind:"missions" };
    if (key === "news") return { kind:"news" };
    if (key === "center") return { kind:"center" };
    if (key === "done") return { kind:"done" };
    return { kind:"blocked" };
  }

  function renderWorldScreenShell(loadingText) {
    const el = ensureWorldScreenEl();
    if (loadingText) {
      el.innerHTML = DWFUI.statusHtml({ cls: "world-loading", text: loadingText, role: "status", live: "polite" });
      return;
    }
    if (worldMapData && worldMapData.error) {
      el.innerHTML = `
        ${DWFUI.statusHtml({ cls: "world-loading world-error", tone: "danger", text: `World map unavailable: ${worldMapData.error}`, role: "status" })}
        <div class="world-btn-stack">${worldButtonsHtml()}</div>
      `;
      wireWorldScreenButtons(el);
      return;
    }
    el.innerHTML = worldScreenMarkup(worldMapData, { panel: worldPanelMode, selectedCivId: worldSelectedCivId });
    wireWorldScreenButtons(el);
    drawWorldScreenCanvas();
  }

  function worldScreenMarkup(data, options) {
    options = options || {};
    const sites = Array.isArray(data?.sites) ? data.sites : [];
    const own = sites.find(s => s.own);
    const regionName = data?.regionName || "";
    const plateHtml = regionName
      ? `<div class="world-region-name">${escapeHtml(regionName)}</div>${own ? `<div class="world-fort-name">${escapeHtml(own.name || "")}</div>` : ""}`
      : (own ? `Your fort: ${escapeHtml(own.name || "")}` : "World map");
    return `
      <canvas id="worldScreenCanvas"></canvas>
      <div class="world-region-plate">${plateHtml}</div>
      <div class="world-btn-stack">${worldButtonsHtml()}</div>
      ${options.panel === "missions" ? worldMissionsPanelHtml(data) : options.panel === "news" ? worldNewsPanelHtml(data) : (options.panel === "civs" || options.civsOpen) ? worldCivsPanelHtml(data, options.selectedCivId) : ""}
    `;
  }

  // The not-yet-wired tooltip. It is held as a literal `title:` PROPERTY, not inlined into the
  // ternary below, because the "?" help reference harvests every tooltip in the client by scanning
  // source for `title=`/`title:` followed by a quoted literal (help_corpus_extractor.mjs). Buried in
  // a ternary the string still reaches the button but VANISHES from "a list of ALL of the tooltips in
  // the game" -- a silent shrink of that superset. Every button is enabled today; the disabled
  // path stays wired regardless (superset policy).
  const WORLD_BTN_PENDING = { title: "Not implemented yet -- read endpoint pending (WD-31 backlog)." };

  function worldButtonsHtml() {
    return WORLD_BUTTONS.map(b => DWFUI.plaqueBtnHtml({
      label: b.label, tone: b.tone,
      cls: "world-btn" + (b.enabled ? "" : " world-btn-disabled"),
      dataset: { worldBtn: b.key },
      disabled: !b.enabled,
      title: b.enabled ? "" : WORLD_BTN_PENDING.title,
    })).join("");
  }

  function worldPrettyKey(value) {
    return String(value || "Unknown").replace(/_/g, " ").toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
  }

  function worldCivsPanelHtml(data, selectedId) {
    const source = data || worldMapData;
    const civs = Array.isArray(source?.civs) ? source.civs : [];
    const selected = civs.find(c => Number(c.id) === Number(selectedId));
    if (selected) {
      const facts = [
        ["Relationship", worldPrettyKey(selected.relation)],
        ["Known population", Number(selected.population) || 0],
        ["Known sites", Number(selected.siteCount) || 0],
        ["Mapped sites", Number(selected.knownSiteCount) || 0],
        ["Diplomatic meetings", Number(selected.meetingCount) || 0],
        ["War fatigue", Number(selected.warFatigue) || 0],
      ].map(([label, value]) => DWFUI.rowHtml({ cls: "world-civ-fact", label, trailing: escapeHtml(String(value)) })).join("");
      // `back` is headerHtml's own slot: it emits the native gold BUTTON_CLOSE_LEFT tile. It used to
      // be a hand-built button carrying the Unicode left-arrow entity -- a glyph standing in for a
      // sprite that exists. The `data-world-civ-back` wire is unchanged.
      const head = DWFUI.headerHtml({ cls: "world-civs-head", title: selected.name || "Civilization", titleCls: "world-civs-title", back: { dataset: { worldCivBack: "" }, title: "Back to civilizations" }, close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" } });
      return `<div class="world-civs-panel world-civ-detail">${head}${DWFUI.scrollHtml({ cls: "world-civs-list", ariaLabel: "Civilization details" }, facts)}</div>`;
    }
    const rows = civs.length
      ? civs.map(c => DWFUI.rowHtml({
          tag: "button", cls: "world-civ-row", dataset: { worldCivId: c.id },
          label: c.name, trailing: `<span>${escapeHtml(worldPrettyKey(c.relation))}</span>`,
        })).join("")
      : `<div class="info-message">No civilizations recorded.</div>`;
    const head = DWFUI.headerHtml({ cls: "world-civs-head", title: "Civilizations", titleCls: "world-civs-title", close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" } });
    return `<div class="world-civs-panel">${head}${DWFUI.scrollHtml({ cls: "world-civs-list", ariaLabel: "Civilizations" }, rows)}</div>`;
  }

  // ================================================================================================
  // B228 -- MISSIONS. The read half was already production-backed (goals, targets, assigned squads,
  // dates, report titles). This is the write half, and it is an honest one.
  //
  // WHAT IS REAL HERE, AND WHAT IS NOT. Read src/missions.h before touching this. DF creates a
  // mission only inside its own viewscreen_worldst -- the per-goal eligibility verdicts live in
  // that screen's new_mission[] array and nowhere in world state, and the confirm allocates an
  // army_controller + an army + one army_nemesis record per dwarf. DFHack exposes no API for any of
  // it. So:
  //   * The NEW MISSION flow below is a real, server-validated order builder. Every squad it offers
  //     is a live squad with DF's own "already committed" bit read off squad.assigned_army_controller_id;
  //     every target is a site the fort's civ has actually heard of (entity.relations.known_sites).
  //     Send posts the order to /mission-create, which validates it the way DF would and then
  //     REFUSES with 501. The panel then shows the refusal, verbatim from the server, next to the
  //     order it staged. It is a real form that hits a real wall -- not a button that lies.
  //   * The RESCUE STRANDED SQUAD button is a real write. It runs DFHack's own fix/stuck-squad.
  //     It is only enabled when the server says DFHack would actually succeed.
  // The one thing this file must never grow is a Send button that pretends. If /missions comes back
  // with create.supported === true one day, this markup already handles it -- nothing here hardcodes
  // the refusal; it renders whatever the server advertises.
  //
  // No camera writes anywhere in this flow (B216): the world overlay draws its own canvas and the
  // mission panel never touches the fort camera, so opening Missions cannot move the map.
  // ================================================================================================

  let missionsData = null;      // /missions payload (null until the plaque is first opened)
  let missionsView = "list";    // "list" | "new"
  let missionDraft = { goal: "", siteId: -1, squadIds: [], targetId: -1 };
  let missionResult = null;     // { ok, blocked, error, staged } from the last /mission-create
  let missionBusy = false;

  function resetMissionDraft() {
    missionDraft = { goal: "", siteId: -1, squadIds: [], targetId: -1 };
    missionResult = null;
  }

  // The draft is only complete when the chosen goal's own prerequisites are met. `needs` comes from
  // the server's mission-type table, so a goal that needs an artifact can never be sent without one.
  function missionDraftReady(data, draft) {
    const d = draft || {};
    if (!d.goal || !(Number(d.siteId) >= 0) || !Array.isArray(d.squadIds) || !d.squadIds.length) return false;
    const kind = (Array.isArray(data?.missionTypes) ? data.missionTypes : []).find(k => k.key === d.goal);
    if (kind && (kind.needs === "artifact" || kind.needs === "hf") && !(Number(d.targetId) >= 0)) return false;
    return true;
  }

  // Away / returning / stranded, from the fields the server actually has. `returning` is a TRI-state
  // (-1 = this goal type tracks no homeward flag) so we never claim "outbound" about a goal that
  // does not record it.
  function missionStateLabel(m) {
    if (!m) return "";
    if (m.stuck) return "Stranded -- cannot return";
    if (Number(m.returning) === 1) return "Returning home";
    if (Number(m.returning) === 0) return "Outbound";
    return "Away";
  }

  function missionsPanelHtml(data, view, draft, result, busy) {
    const head = DWFUI.headerHtml({
      cls: "world-civs-head", title: view === "new" ? "New mission" : "Missions", titleCls: "world-civs-title",
      back: view === "new" ? { dataset: { missionBack: "" }, title: "Back to missions" } : undefined,
      close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" },
    });
    const bodyHtml = view === "new"
      ? missionNewFormHtml(data, draft, result, busy)
      : missionListHtml(data, busy);
    return `<div class="world-civs-panel world-missions-panel">${head}${bodyHtml}</div>`;
  }

  function missionListHtml(data, busy) {
    const active = Array.isArray(data?.active) ? data.active : [];
    const rows = active.length ? active.map(m => {
      const squads = Array.isArray(m.squads) ? m.squads : [];
      const target = m.targetName ? `${m.targetSite || "Unknown site"} -- ${m.targetName}` : (m.targetSite || "No target site");
      return DWFUI.rowHtml({
        cls: "world-mission-row" + (m.stuck ? " world-mission-stuck" : ""),
        label: worldPrettyKey(m.invasionIntent || m.goal),
        sub: { text: `${target} · ${missionStateLabel(m)}` },
        trailing: `${squads.length} squad${squads.length === 1 ? "" : "s"}`,
      });
    }).join("") : `<div class="info-message">No active fortress missions.</div>`;

    // The rescue write. `available` and `reason` are the server's, mirrored from DFHack's own
    // scan_fort_armies() -- the button is live only when fix/stuck-squad would actually work, and
    // when it would not, DFHack's reason is shown instead of a disabled button with no explanation.
    const rescue = data?.rescue || {};
    const stuckCount = Number(rescue.stuckCount) || 0;
    const rescueHtml = stuckCount > 0
      ? `<div class="world-mission-rescue">
           ${DWFUI.statusHtml({ cls: "world-mission-note", tone: "danger", role: "status",
             text: `${stuckCount} squad${stuckCount === 1 ? " is" : "s are"} stranded and cannot come home. ${rescue.reason || ""}` })}
           ${DWFUI.plaqueBtnHtml({ label: busy ? "Rescuing..." : "Rescue stranded squad", tone: "green",
             cls: "world-btn world-mission-action", dataset: { missionRescue: "" }, disabled: !rescue.available || !!busy,
             title: rescue.available ? "Run DFHack's fix/stuck-squad: a returning army carries the stranded dwarves home." : (rescue.reason || "") })}
         </div>`
      : "";

    // The create entry point. Enabled regardless of create.supported: the flow is real and the
    // refusal is informative. What it must NOT do is claim the mission was sent.
    const create = data?.create || {};
    const newHtml = `<div class="world-mission-rescue">
        ${DWFUI.plaqueBtnHtml({ label: "New mission", tone: "green", cls: "world-btn world-mission-action",
          dataset: { missionNew: "" }, title: "Pick a target, a mission type and the squads to send." })}
        ${create.supported ? "" : DWFUI.statusHtml({ cls: "world-mission-note", tone: "warn", role: "note",
          text: "Sending is blocked: Dwarf Fortress only creates missions from its own world screen. You can build and validate the order here and see exactly why." })}
      </div>`;

    return DWFUI.scrollHtml({ cls: "world-civs-list", ariaLabel: "Active missions" }, rows) + rescueHtml + newHtml;
  }

  function missionNewFormHtml(data, draft, result, busy) {
    const d = draft || {};
    const kinds = Array.isArray(data?.missionTypes) ? data.missionTypes : [];
    const targets = Array.isArray(data?.targets) ? data.targets : [];
    const squads = Array.isArray(data?.squads) ? data.squads : [];

    const kindRows = kinds.length ? kinds.map(k => DWFUI.rowHtml({
      tag: "button", cls: "world-civ-row" + (d.goal === k.key ? " world-mission-picked" : ""),
      dataset: { missionGoal: k.key }, label: k.label,
      trailing: d.goal === k.key ? "Chosen" : "",
    })).join("") : `<div class="info-message">No mission types are known.</div>`;

    const targetRows = targets.length ? targets.map(t => DWFUI.rowHtml({
      tag: "button", cls: "world-civ-row" + (Number(d.siteId) === Number(t.id) ? " world-mission-picked" : ""),
      dataset: { missionSite: t.id }, label: t.name || `Site ${t.id}`,
      sub: { text: `${worldPrettyKey(t.type)}${t.civ ? " · " + t.civ : ""}` },
      trailing: Number(d.siteId) === Number(t.id) ? "Chosen" : "",
    })).join("") : `<div class="info-message">Your civilization has not heard of any other site yet. Missions need a known target.</div>`;

    // Squads DF says are already committed are shown, disabled, WITH DF's reason -- not hidden. A
    // hidden squad reads as a bug; a disabled squad that says "already away on a mission" reads as
    // the game.
    const squadRows = squads.length ? squads.map(s => DWFUI.rowHtml({
      cls: "world-mission-squad" + (s.busy ? " world-mission-busy" : ""),
      label: s.name || `Squad ${s.id}`,
      sub: { text: s.busy ? (s.busyReason || "Unavailable") : `${Number(s.memberCount) || 0} dwarves` },
      trailing: DWFUI.checkHtml({
        checked: (d.squadIds || []).map(Number).includes(Number(s.id)), disabled: !!s.busy,
        dataset: { missionSquad: s.id },
        title: s.busy ? (s.busyReason || "Unavailable") : `Send ${s.name || "this squad"}`,
        ariaLabel: s.name || `Squad ${s.id}`,
      }),
    })).join("") : `<div class="info-message">You have no squads. Raise one in the Squads screen first.</div>`;

    const ready = missionDraftReady(data, d);
    const groups =
      DWFUI.rowGroupHtml({ cls: "world-mission-group", header: { label: "Mission type" }, rows: [kindRows] }) +
      DWFUI.rowGroupHtml({ cls: "world-mission-group", header: { label: "Target", count: targets.length }, rows: [targetRows] }) +
      DWFUI.rowGroupHtml({ cls: "world-mission-group", header: { label: "Squads", count: squads.length }, rows: [squadRows] });

    // The result block. THREE distinct outcomes, never collapsed into one: sent (would only ever
    // appear if the server gained a commit), rejected-order (400 -- your fault, fixable), and
    // native-blocked (501 -- the order is good, DF will not take it from us). The 501 case shows the
    // staged order back so it is visible that the whole thing WAS resolved and validated.
    let resultHtml = "";
    if (result && result.ok) {
      resultHtml = DWFUI.statusHtml({ cls: "world-mission-note", tone: "good", role: "status", text: "Mission sent. The squads are preparing to depart." });
    } else if (result && result.blocked === "native-only") {
      const s = result.staged || {};
      const names = Array.isArray(s.squadNames) ? s.squadNames.join(", ") : "";
      resultHtml =
        DWFUI.statusHtml({ cls: "world-mission-note", tone: "warn", role: "status",
          text: `Order validated but NOT sent. ${result.error || ""}` }) +
        DWFUI.rowGroupHtml({ cls: "world-mission-group", header: { label: "The order we staged" }, rows: [
          DWFUI.rowHtml({ cls: "world-civ-fact", label: "Mission", trailing: escapeHtml(worldPrettyKey(s.goal)) }) +
          DWFUI.rowHtml({ cls: "world-civ-fact", label: "Target", trailing: escapeHtml(s.targetSite || "") }) +
          DWFUI.rowHtml({ cls: "world-civ-fact", label: "Squads", trailing: escapeHtml(names) }),
        ] });
    } else if (result && result.error) {
      resultHtml = DWFUI.statusHtml({ cls: "world-mission-note", tone: "danger", role: "status", text: result.error });
    }

    const actions = `<div class="world-mission-rescue">
        ${DWFUI.plaqueBtnHtml({ label: busy ? "Sending..." : "Send mission", tone: ready ? "green" : "grey",
          cls: "world-btn world-mission-action", dataset: { missionSend: "" }, disabled: !ready || !!busy,
          title: ready ? "Validate and send this order." : "Choose a mission type, a target and at least one squad." })}
      </div>`;

    return DWFUI.scrollHtml({ cls: "world-civs-list", ariaLabel: "New mission" }, groups + resultHtml) + actions;
  }

  // Kept as the world-map overlay's small missions summary (the /world-map payload's own `missions`
  // array). The deep screen above reads /missions. Both exist because the overlay must render before
  // /missions has been fetched, and neither is allowed to invent a mission the other cannot see.
  function worldMissionsPanelHtml(data) {
    if (missionsData) return missionsPanelHtml(missionsData, missionsView, missionDraft, missionResult, missionBusy);
    const missions = Array.isArray(data?.missions) ? data.missions : [];
    const rows = missions.length ? missions.map(m => DWFUI.rowHtml({
      cls: "world-mission-row", label: worldPrettyKey(m.goal), sub: { text: m.targetSite || "No target site" },
      trailing: `${Array.isArray(m.squadIds) ? m.squadIds.length : 0} squad${Array.isArray(m.squadIds) && m.squadIds.length === 1 ? "" : "s"}`,
    })).join("") : `<div class="info-message">No active fortress missions.</div>`;
    const head = DWFUI.headerHtml({ cls: "world-civs-head", title: "Missions", titleCls: "world-civs-title", close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" } });
    return `<div class="world-civs-panel world-missions-panel">${head}${DWFUI.scrollHtml({ cls: "world-civs-list", ariaLabel: "Active missions" }, rows)}${DWFUI.statusHtml({ cls: "world-mission-note", text: "Loading missions..." , role: "status", live: "polite" })}</div>`;
  }

  async function loadMissions() {
    try {
      missionsData = await fortFetchJson(`/missions?player=${encodeURIComponent(player)}&t=${Date.now()}`);
    } catch (err) {
      missionsData = { active: [], squads: [], targets: [], missionTypes: [], rescue: {}, create: {},
                       error: err.message || "unavailable" };
    }
    renderWorldScreenShell();
  }

  function worldNewsPanelHtml(data) {
    const news = Array.isArray(data?.news) ? data.news : [];
    const rows = news.length ? news.map(item => DWFUI.rowHtml({
      cls: "world-news-row", label: worldPrettyKey(item.type), sub: { text: item.source || "Unknown source" },
      trailing: Number(item.year) >= 0 ? `Year ${item.year}` : "",
    })).join("") : `<div class="info-message">No news or rumors have reached the fortress.</div>`;
    const head = DWFUI.headerHtml({ cls: "world-civs-head", title: "News and rumors", titleCls: "world-civs-title", close: { cls: "world-civs-close", dataset: { worldCivsClose: "" }, title: "Close" } });
    return `<div class="world-civs-panel world-news-panel">${head}${DWFUI.scrollHtml({ cls: "world-civs-list", ariaLabel: "News and rumors" }, rows)}</div>`;
  }

  function wireWorldScreenButtons(root) {
    root.querySelectorAll("[data-world-btn]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const route = worldButtonRoute(button.dataset.worldBtn);
        if (route.kind === "done") { closeWorldScreen(); return; }
        if (route.kind === "center") { drawWorldScreenCanvas(); return; }
        if (route.kind === "civs") {
          worldPanelMode = worldPanelMode === "civs" ? null : "civs";
          worldSelectedCivId = -1;
          renderWorldScreenShell();
          return;
        }
        if (route.kind === "missions") {
          const closing = worldPanelMode === "missions";
          worldPanelMode = closing ? null : "missions";
          if (!closing) {
            // B228: opening Missions fetches /missions. It never touches the camera (B216) -- the
            // world overlay owns its own canvas and this panel writes no camera state at all.
            missionsView = "list";
            resetMissionDraft();
            renderWorldScreenShell();
            loadMissions();
            return;
          }
          missionsData = null;
          renderWorldScreenShell();
          return;
        }
        if (route.kind === "news") {
          worldPanelMode = worldPanelMode === route.kind ? null : route.kind;
          renderWorldScreenShell();
          return;
        }
        if (route.kind === "panel") {
          closeWorldScreen();
          if (typeof openPanel === "function") openPanel(route.name, route.section, route.detail);
          return;
        }
        // Unknown routes are ignored rather than fabricated.
      });
    });
    root.querySelector("[data-world-civs-close]")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      worldPanelMode = null;
      worldSelectedCivId = -1;
      renderWorldScreenShell();
    });
    root.querySelector("[data-world-civ-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); worldSelectedCivId = -1; renderWorldScreenShell();
    });
    root.querySelectorAll("[data-world-civ-id]").forEach(button => button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); worldSelectedCivId = Number(button.dataset.worldCivId); renderWorldScreenShell();
    }));
    wireMissionPanel(root);
  }

  // B228 mission-panel wiring. Every handler is a local state edit + re-render, except the two that
  // POST. Neither POST touches the camera, and neither optimistically mutates the mission list --
  // the server is re-read afterwards, so what the panel shows is always what DF actually has.
  function wireMissionPanel(root) {
    const rerender = () => renderWorldScreenShell();

    root.querySelector("[data-mission-new]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      missionsView = "new"; resetMissionDraft(); rerender();
    });
    root.querySelector("[data-mission-back]")?.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      missionsView = "list"; resetMissionDraft(); rerender();
    });
    root.querySelectorAll("[data-mission-goal]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      missionDraft.goal = btn.dataset.missionGoal;
      // Switching goal drops a target picked for the previous goal: an artifact id is meaningless
      // as a rescue target, and silently carrying it over is how a wrong order gets sent.
      missionDraft.targetId = -1;
      missionResult = null;
      rerender();
    }));
    root.querySelectorAll("[data-mission-site]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      missionDraft.siteId = Number(btn.dataset.missionSite);
      missionResult = null;
      rerender();
    }));
    root.querySelectorAll("[data-mission-squad]").forEach(btn => btn.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (btn.disabled) return;
      const id = Number(btn.dataset.missionSquad);
      const at = missionDraft.squadIds.indexOf(id);
      if (at >= 0) missionDraft.squadIds.splice(at, 1); else missionDraft.squadIds.push(id);
      missionResult = null;
      rerender();
    }));

    root.querySelector("[data-mission-send]")?.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      if (missionBusy || !missionDraftReady(missionsData, missionDraft)) return;
      missionBusy = true; missionResult = null; rerender();
      const params = new URLSearchParams();
      params.set("player", player);
      params.set("goal", missionDraft.goal);
      params.set("site", String(missionDraft.siteId));
      if (Number(missionDraft.targetId) >= 0) params.set("target", String(missionDraft.targetId));
      for (const id of missionDraft.squadIds) params.append("squad", String(id));
      try {
        // fortFetchJson throws on a non-2xx, so the 501 body is read directly here: the refusal IS
        // the payload we want to render, not an error to swallow.
        const res = await fetch(`/mission-create?${params.toString()}`, { method: "POST" });
        missionResult = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      } catch (err) {
        missionResult = { ok: false, error: err.message || "mission-create failed" };
      }
      missionBusy = false;
      rerender();
      if (missionResult && missionResult.ok) { missionsView = "list"; await loadMissions(); }
    });

    root.querySelector("[data-mission-rescue]")?.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      if (missionBusy) return;
      missionBusy = true; rerender();
      try {
        const res = await fetch(`/mission-rescue?player=${encodeURIComponent(player)}`, { method: "POST" });
        const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        if (!body.ok && typeof showToast === "function") showToast(body.error || "Rescue failed");
      } catch (err) {
        if (typeof showToast === "function") showToast(err.message || "Rescue failed");
      }
      missionBusy = false;
      await loadMissions();   // re-read: never optimistically clear a stranded squad.
    });
  }

  function drawWorldCanvas(canvas, data, cssWidth, cssHeight, pixelRatio) {
    if (!canvas || !data) return;
    const sites = Array.isArray(data.sites) ? data.sites : [];
    const w = Math.max(1, Number(data.width) || 1);
    const h = Math.max(1, Number(data.height) || 1);
    // Fill the overlay (minus the button stack column) at device pixel ratio, matching the
    // full-bleed world canvas in 22-world.png (this replaces the WHOLE view, not a small panel).
    const dpr = Math.max(1, Number(pixelRatio) || 1);
    const cssW = Math.max(200, Number(cssWidth) || 200);
    const cssH = Math.max(200, Number(cssHeight) || 200);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#14110c";
    ctx.fillRect(0, 0, cssW, cssH);
    const { scale, ox, oy } = worldMapLayout(w, h, cssW, cssH);

    // B88: terrain biome raster (behind the sites). Absent on older DLLs -> layer skipped, and we
    // fall back to a deep-water fill of the world bounds so the map never reads as broken confetti.
    const terrain = decodeWorldTerrain(data.terrain);
    if (terrain) {
      const cell = terrain.step * scale;
      const cw = Math.ceil(cell) + 1; // +1 avoids hairline seams between cells
      for (let ty = 0; ty < terrain.h; ty++) {
        const row = terrain.rows[ty] || "";
        const py = oy + ty * terrain.step * scale;
        for (let tx = 0; tx < terrain.w; tx++) {
          const color = worldTerrainColor(row.charAt(tx));
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(ox + tx * terrain.step * scale, py, cw, Math.ceil(cell) + 1);
        }
      }
    } else {
      // No terrain data: draw the world bounds as an ocean-toned plate with a border so the sites
      // sit on an intentional map surface rather than a black void (client-side resilience).
      ctx.fillStyle = "#1b2836";
      ctx.fillRect(ox, oy, w * scale, h * scale);
    }
    // World-bounds frame (matches DF's bordered world plate; also orients the viewer).
    ctx.strokeStyle = "rgba(217,152,43,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, w * scale - 1, h * scale - 1);

    for (const s of sites) {
      const px = ox + s.x * scale;
      const py = oy + s.y * scale;
      const r = s.own ? 5 : 2.5;
      if (s.own) {
        // Own fort: a filled marker with a bright ring so it stands out over terrain.
        ctx.fillStyle = worldSiteColor(s.type, true);
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
        ctx.strokeStyle = "#fff3c4";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px - r - 1.5, py - r - 1.5, r * 2 + 3, r * 2 + 3);
      } else {
        ctx.fillStyle = worldSiteColor(s.type, false);
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
      }
    }
  }

  function drawWorldScreenCanvas() {
    const canvas = document.getElementById("worldScreenCanvas");
    return drawWorldCanvas(canvas, worldMapData, innerWidth - 4, innerHeight - 4, window.devicePixelRatio || 1);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("resize", () => { if (worldScreenOpenState) drawWorldScreenCanvas(); });
  }

  // Node export for the offline fixture test (harmless in the browser: `module` is undefined).
  // Only the pure, DOM-free B88 helpers are exposed.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { worldSiteColor, worldTerrainColor, decodeWorldTerrain, worldMapLayout, worldButtonRoute,
      worldScreenMarkup, worldCivsPanelHtml, worldMissionsPanelHtml, worldNewsPanelHtml, worldButtonsHtml, drawWorldCanvas,
      // B228 missions (pure, DOM-free -- the whole create flow is testable offline)
      missionsPanelHtml, missionListHtml, missionNewFormHtml, missionDraftReady, missionStateLabel };
  }
  if (typeof window !== "undefined") window.DFWorldMapMarkup = { worldScreenMarkup, worldCivsPanelHtml, worldMissionsPanelHtml, worldNewsPanelHtml, worldButtonsHtml, drawWorldCanvas, worldButtonRoute, missionsPanelHtml };
