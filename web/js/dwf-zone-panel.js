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

  function zoneAnimalAssignmentState(row) {
    const assigned = !!(row && row.assigned);
    const assignedElsewhere = !assigned && !!(row && row.assignedElsewhere);
    return {
      assigned,
      assignedElsewhere,
      assign: assigned ? 0 : 1,
      label: assigned ? "Assigned here" : (assignedElsewhere ? "Assigned elsewhere" : "Not assigned"),
      action: assigned ? "Unassign" : (assignedElsewhere ? "Move here" : "Assign"),
    };
  }

  // [wire, bitKey, meta-label, icon token, column title]. The title is per-icon because native
  // shows a column name only on hover -- there is no always-on header row.
  const ZONE_SQUAD_MODES = [
    ["sleep", "sleep", "Sleeping", "ZONE_SQUAD_SLEEP", "Sleep"],
    ["train", "train", "Training", "ZONE_SQUAD_TRAIN", "Train"],
    ["individual-equipment", "individualEquipment", "Individual equipment", "ZONE_SQUAD_INDIV_EQ", "Individual equipment"],
    ["squad-equipment", "squadEquipment", "Squad equipment", "ZONE_SQUAD_SQUAD_EQ", "Squad equipment"],
  ];

  function zoneSquadModeState(row, mode) {
    const spec = ZONE_SQUAD_MODES.find(item => item[0] === mode);
    return !!(spec && row && row[spec[1]]);
  }

  function zoneSquadRgb(color) {
    const n = value => Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
    return `rgb(${n(color && color.r)},${n(color && color.g)},${n(color && color.b)})`;
  }

  function zoneSquadRowsHtml(rows, esc = value => String(value)) {
    if (!Array.isArray(rows)) return "";
    return rows.map(row => {
      const id = Number(row && row.id);
      const name = row && (row.alias || row.name) || `Squad ${id}`;
      const modes = ZONE_SQUAD_MODES.filter(spec => zoneSquadModeState(row, spec[0]));
      const assigned = modes.length > 0;
      const emblem = row && row.emblem || {};
      const initial = esc((String(name).trim()[0] || "?").toUpperCase());
      const latches = ZONE_SQUAD_MODES.map(([mode, , label, token, title]) => {
        const on = zoneSquadModeState(row, mode);
        return DWFUI.latchHtml({
          on, cls: "zone-squad-mode", sprite: `${token}_INACTIVE`, activeSprite: `${token}_ACTIVE`,
          dataset: { zoneSquad: id, zoneSquadMode: mode, zoneSquadEnabled: on ? 0 : 1 },
          title: `${title}: ${on ? "on" : "off"}`, ariaLabel: label,
        });
      }).join("");
      const emblemHtml = `<span class="zone-squad-emblem" data-df-identity-missing="letter"` +
        ` style="background:${zoneSquadRgb(emblem.bg)};color:${zoneSquadRgb(emblem.fg)}"` +
        ` aria-hidden="true">${initial}</span>`;
      return DWFUI.rowHtml({
        cls: "zone-squad-row" + (assigned ? " assigned" : ""),
        dataset: { zoneSquadRow: id },
        icon: emblemHtml,
        copyCls: "zone-squad-copy", labelCls: "zone-squad-name",
        label: String(name),
        // one label per mode, so a long list wraps between modes instead of running under the latches
        sub: { cls: "zone-squad-meta", html: assigned
          ? modes.map((spec, i) => DWFUI.bitmapTextHtml(spec[2] + (i < modes.length - 1 ? "," : ""))).join(" ")
          : DWFUI.bitmapTextHtml("Not assigned") },
        trailing: latches,
      });
    }).join("");
  }

  // The zone panels' remaining DFChrome-direct icon hosts: the barracks rename quill and the
  // "Assign squads" launcher glyph.
  function paintZoneSquadIcons(root) {
    if (!root) return;
    if (window.DWFUI && typeof window.DWFUI.paintSprites === "function") window.DWFUI.paintSprites(root);
    if (!window.DFChrome || typeof window.DFChrome.icon !== "function") return;
    root.querySelectorAll("[data-zone-squad-icon],[data-zone-chrome-icon]").forEach(host => {
      if (host.firstChild) return;
      host.appendChild(window.DFChrome.icon(host.dataset.zoneSquadIcon || host.dataset.zoneChromeIcon, 36));
    });
  }

  function zoneAnimalNativeLabel(row) {
    const flags = Array.isArray(row && row.flags) ? row.flags : [];
    const tame = flags.some(flag => String(flag).toLowerCase() === "tame") || /\(tame\)\s*$/i.test(String(row && row.name || ""));
    let name = String(row && (row.name || row.race) || `Unit ${Number(row && row.id)}`)
      .replace(/\s*\(tame\)\s*$/i, "").trim();
    if (tame && name && !/^stray\b/i.test(name) && !name.includes(",")) name = `Stray ${name}`;
    const sex = String(row && row.sex || "").toLowerCase();
    const sexGlyph = sex === "female" ? "♀" : (sex === "male" ? "♂" : "");
    return `${name}${sexGlyph ? `, ${sexGlyph}` : ""}${tame ? " (Tame)" : ""}`;
  }

  function zoneAnimalSortedRows(rows, key = "name", direction = 1) {
    const value = row => {
      if (key === "category") return String(row && row.race || "");
      if (key === "profession") return (Array.isArray(row && row.flags) ? row.flags : [])
        .filter(flag => flag !== "assigned here" && flag !== "assigned elsewhere").join(" ");
      return zoneAnimalNativeLabel(row);
    };
    return [...(Array.isArray(rows) ? rows : [])].sort((a, b) =>
      direction * value(a).localeCompare(value(b), undefined, { sensitivity: "base", numeric: true }) ||
      Number(a && a.id) - Number(b && b.id));
  }

  let zoneAnimalSortKey = "name";
  let zoneAnimalSortDirection = 1;
  let zoneAnimalSearch = "";
  // Search state for the cage and workshop-worker choosers. Module-scoped like zoneAnimalSearch,
  // so it survives the panel's re-render-on-write.
  const ZONE_TYPE_LABEL = {
    Pond: "Pit/Pond", Pen: "Pen/Pasture", WaterSource: "Water Source",
    MeetingHall: "Meeting Area", FishingArea: "Fishing", SandCollection: "Sand",
    ClayCollection: "Clay", Dump: "Garbage Dump", PlantGathering: "Gather Fruit",
    AnimalTraining: "Animal Training", Dungeon: "Dungeon", Bedroom: "Bedroom",
    DiningHall: "Dining Hall", Office: "Office", Dormitory: "Dormitory",
    Barracks: "Barracks", ArcheryRange: "Archery Range", Tomb: "Tomb"
  };
  // The type row leads with the zone icon in a gold box -- the same art the palette paints, keyed here
  // by the /zone-info enum string.
  const ZONE_TYPE_SPRITE = {
    Pond: "ZONE_PIT", Pen: "ZONE_PEN", WaterSource: "ZONE_WATER_SOURCE",
    MeetingHall: "ZONE_MEETING", FishingArea: "ZONE_FISHING", SandCollection: "ZONE_SAND",
    ClayCollection: "ZONE_CLAY", Dump: "ZONE_DUMP", PlantGathering: "ZONE_GATHER",
    AnimalTraining: "ZONE_ANIMAL_TRAINING", Dungeon: "ZONE_DUNGEON", Bedroom: "ZONE_BEDROOM",
    DiningHall: "ZONE_DINING_HALL", Office: "ZONE_OFFICE", Dormitory: "ZONE_DORMITORY",
    Barracks: "ZONE_BARRACKS", ArcheryRange: "ZONE_ARCHERY_RANGE", Tomb: "ZONE_TOMB"
  };
  const ZONE_UNNAMED = {
    Pen: "Unnamed pen/pasture", Bedroom: "Unnamed bedroom",
    PlantGathering: "Unnamed plant gathering area", MeetingHall: "Unnamed meeting hall",
    Barracks: "Unnamed barracks",
    ArcheryRange: "Unnamed archery range",   // derived, not captured -- see the closeout.
  };
  function zoneUnnamedLabel(type, typeLabel) {
    return ZONE_UNNAMED[type] || `Unnamed ${String(typeLabel || "zone").toLowerCase()}`;
  }
  // A zone attached to a location swaps its type icon for the LOCATION's own, and its label for
  // "location name / location type".
  const LOCATION_TYPE_SPRITE = [
    ["tavern", "ZONE_TAVERN"], ["inn", "ZONE_TAVERN"], ["hospital", "ZONE_HOSPITAL"],
    ["temple", "ZONE_TEMPLE"], ["library", "ZONE_LIBRARY"], ["guildhall", "ZONE_GUILDHALL"],
    ["shrine", "ZONE_SHRINE"],
  ];
  function zoneLocationSprite(locationType) {
    const label = String(locationType || "").toLowerCase();
    for (const [needle, sprite] of LOCATION_TYPE_SPRITE)
      if (label.includes(needle)) return sprite;
    return null;
  }
  // Native's own tooltip copy, transcribed verbatim from the captures.
  const ZONE_TIP_LOCATION_ASSIGN = "Assign a new or existing location to this zone. Locations are groups of zones and rooms with a larger purpose, like a tavern, a temple, a library, or a craft guildhall."; // LEVER-LINK-3
  const ZONE_TIP_LOCATION_DETAILS = "Set details for the assigned location.";                       // LEVER-LINK-1
  const ZONE_TIP_GATHER_TREES = "Gather fruit in trees in and just above this zone. Requires a stepladder."; // Z11-19
  const ZONE_TIP_GATHER_SHRUBS = "Gather fruit and vegetables from shrubs in this zone.";           // Z11-20
  const ZONE_TIP_GATHER_FALLEN = "Gather fallen fruit in this zone.";                               // Z11-21
  function zoneIsAutoNamed(name) {
    return !name || /^activity zone\b/i.test(String(name).trim());
  }
  function zoneDisplayName(name, typeLabel) {
    return zoneIsAutoNamed(name) ? typeLabel : name;
  }
  function zoneAcceptsSquads(info) {
    if (!info) return false;
    if (typeof info.canSquads === "boolean") return info.canSquads;
    return !!info.isBarracks;
  }
  function squadRoomName(name, type) {
    return zoneIsAutoNamed(name)
      ? zoneUnnamedLabel(type, ZONE_TYPE_LABEL[type] || type) : name;
  }

  // Two different sprites per state is latchHtml's contract. The STATUS toggle is ONE tile and still
  // reaches BOTH wire verbs: it dispatches "disable" while active and "enable" while suspended.
  function zoneLatch(cfg) {
    return DWFUI.latchHtml({
      on: cfg.on, cls: "zone-tgl", sprite: cfg.off, activeSprite: cfg.on_,
      dataset: { zoneAct: cfg.act }, title: cfg.title, ariaLabel: cfg.title,
    });
  }

  // ---- zonePanelMarkup ---------------------------------------------------------------------------
  function zonePanelMarkup(info, options = {}) {
    const typeLabel = ZONE_TYPE_LABEL[info.type] || info.type || "Zone";
    const owner = info.owner || {};
    const location = info.location || {};
    const gather = info.gather || {};
    const tomb = info.tomb || {};
    const archery = info.archery || {};
    const hasLocation = Number(location.id) >= 0;
    const autoNamed = zoneIsAutoNamed(info.name);
    const headTitle = autoNamed ? typeLabel : info.name;
    const assignedCount = Math.max(0, Number(info.assignedUnits) || 0);
    const assignedText = `${assignedCount} assigned`;

    // ---- the right rail ------------------------------------------------------------------------
    const rail = [];
    // Gather options: native order is TREES, SHRUBS, FALLEN (Z11-19/20/21, one tooltip per shot).
    if (info.isGather) rail.push(`<div class="zone-rail-row">${
      zoneLatch({ on: !!gather.trees, off: "ZONE_GATHER_TREE_INACTIVE", on_: "ZONE_GATHER_TREE_ACTIVE", act: gather.trees ? "gather-trees-off" : "gather-trees-on", title: ZONE_TIP_GATHER_TREES })}${
      zoneLatch({ on: !!gather.shrubs, off: "ZONE_GATHER_SHRUB_INACTIVE", on_: "ZONE_GATHER_SHRUB_ACTIVE", act: gather.shrubs ? "gather-shrubs-off" : "gather-shrubs-on", title: ZONE_TIP_GATHER_SHRUBS })}${
      zoneLatch({ on: !!gather.fallen, off: "ZONE_GATHER_FALLEN_INACTIVE", on_: "ZONE_GATHER_FALLEN_ACTIVE", act: gather.fallen ? "gather-fallen-off" : "gather-fallen-on", title: ZONE_TIP_GATHER_FALLEN })}</div>`);
    if (info.isPitPond) rail.push(`<div class="zone-rail-row">${
      zoneLatch({ on: !!info.fillingPond, off: "ZONE_POND_INACTIVE", on_: "ZONE_POND_ACTIVE", act: "pond", title: "Pond (fill with water)" })}${
      zoneLatch({ on: !info.fillingPond, off: "ZONE_PIT_INACTIVE", on_: "ZONE_PIT_ACTIVE", act: "pit", title: "Pit (drop)" })}</div>`);
    // /zone-action accepts ONLY the `tomb-pets-*` form; the bare `pets-*` form belongs to the COFFIN route.
    if (info.isTomb) rail.push(`<div class="zone-rail-row">${
      zoneLatch({ on: !!tomb.citizens, off: "ZONE_TOMB_CITIZEN_BURIAL_INACTIVE", on_: "ZONE_TOMB_CITIZEN_BURIAL_ACTIVE", act: tomb.citizens ? "tomb-citizens-off" : "tomb-citizens-on", title: "Bury citizens here" })}${
      zoneLatch({ on: !!tomb.pets, off: "ZONE_TOMB_PET_BURIAL_INACTIVE", on_: "ZONE_TOMB_PET_BURIAL_ACTIVE", act: tomb.pets ? "tomb-pets-off" : "tomb-pets-on", title: "Bury pets here" })}</div>`);
    if (info.isArchery) {
      const dir = archery.direction || "west";
      rail.push(`<div class="zone-rail-row">${
        zoneLatch({ on: dir === "west", off: "ZONE_SHOOT_LEFT_INACTIVE", on_: "ZONE_SHOOT_LEFT_ACTIVE", act: "archery-west", title: "Shoot from the west" })}${
        zoneLatch({ on: dir === "east", off: "ZONE_SHOOT_RIGHT_INACTIVE", on_: "ZONE_SHOOT_RIGHT_ACTIVE", act: "archery-east", title: "Shoot from the east" })}</div>`);
      rail.push(`<div class="zone-rail-row">${
        zoneLatch({ on: dir === "north", off: "ZONE_SHOOT_UP_INACTIVE", on_: "ZONE_SHOOT_UP_ACTIVE", act: "archery-north", title: "Shoot from the north" })}${
        zoneLatch({ on: dir === "south", off: "ZONE_SHOOT_DOWN_INACTIVE", on_: "ZONE_SHOOT_DOWN_ACTIVE", act: "archery-south", title: "Shoot from the south" })}</div>`);
    }
    // Native shows no "N assigned" line in the panel, so the count folds into the tooltip.
    if (info.isPen || info.isPitPond) {
      const verb = info.isPen ? "Assign animals to pasture"
        : (info.fillingPond ? "Assign animals to pond" : "Assign animals to drop");
      rail.push(`<div class="zone-rail-row">${DWFUI.artBtnHtml({ sprite: "ZONE_PICK_ANIMALS", cls: "zone-tgl",
        dataset: { zoneUnits: "" }, title: `${verb} (${assignedText})`, ariaLabel: verb })}</div>`);
    }
    if (info.canOwner) rail.push(`<div class="zone-rail-row">${DWFUI.artBtnHtml({ sprite: "ZONE_ASSIGN_UNIT", cls: "zone-tgl",
      dataset: { zoneOwner: "" },
      title: Number(owner.id) >= 0 ? `Assigned to ${owner.name || `Unit ${owner.id}`} -- click to change` : "Assign a citizen",
      ariaLabel: "Assign a citizen" })}</div>`);
    // The blue flag belongs to EVERY zone DF's squad selector accepts -- barracks AND archery range.
    if (zoneAcceptsSquads(info)) {
      const squadCount = Math.max(0, Number(info.assignedSquads) || 0);
      rail.push(`<div class="zone-rail-row">${DWFUI.artBtnHtml({ sprite: "ZONE_SQUAD_LIST", cls: "zone-tgl",
        dataset: { zoneSquads: "" },
        title: `Assign squads to this ${info.type === "ArcheryRange" ? "archery range" : "barracks"} (${squadCount === 1 ? "1 squad assigned" : `${squadCount} squads assigned`})`,
        ariaLabel: "Assign squads" })}</div>`);
    }
    // The location pair rides the panel's bottom-right corner; the tooltip copy is native's own.
    if (info.canLocation) rail.push(`<div class="zone-rail-row zone-rail-location">${
      DWFUI.artBtnHtml({ sprite: "ZONE_LOCATION_ASSIGN", cls: "zone-tgl", dataset: { zoneLocations: "" },
        title: ZONE_TIP_LOCATION_ASSIGN, ariaLabel: "Assign location" })}${
      hasLocation ? DWFUI.artBtnHtml({ sprite: "ZONE_LOCATION_DETAILS", cls: "zone-tgl",
        dataset: { zoneLocationOpen: Number(location.id) }, title: ZONE_TIP_LOCATION_DETAILS,
        ariaLabel: "Location details" }) : ""}</div>`);

    // ---- the tool cluster (repaint | suspend | remove), butted, flush right ---------------------
    const coreTools = `<span class="zone-core-tools">${
      DWFUI.artBtnHtml({ sprite: "ZONE_REPAINT", cls: "zone-tgl zone-repaint-tile", dataset: { zoneRepaint: "" },
        title: "Repaint area -- extend this zone by painting a rectangle on the map", ariaLabel: "Repaint area" })}${
      zoneLatch({ on: !info.active, off: "ZONE_SUSPEND_INACTIVE", on_: "ZONE_SUSPEND",
        act: info.active ? "disable" : "enable",
        title: info.active ? "Zone active (click to suspend)" : "Zone suspended (click to activate)" })}${
      DWFUI.artBtnHtml({ sprite: "ZONE_REMOVE_EXISTING", cls: "zone-tgl zone-remove-tile",
        dataset: { zoneAct: "remove" }, title: "Remove zone", ariaLabel: "Remove zone" })}</span>`;

    // ---- the type row ---------------------------------------------------------------------------
    const typeSprite = (hasLocation && zoneLocationSprite(location.type)) || ZONE_TYPE_SPRITE[info.type] || null;
    const typeIcon = typeSprite
      ? DWFUI.iconHtml({ sprite: typeSprite, size: 32, alt: typeLabel })
      : DWFUI.iconHtml({ emptyTile: true, alt: typeLabel });
    const typeLabelHtml = hasLocation
      ? `<span class="zone-type-label">${escapeHtml(location.name || location.type || "Location")}<small class="zone-type-sub">${escapeHtml(location.type || "")}</small></span>`
      : `<span class="zone-type-label">${escapeHtml(typeLabel)}</span>`;
    const typeRow = `<div class="zone-type-row"><span class="zone-type-icon">${typeIcon}</span>${typeLabelHtml}${coreTools}</div>`;

    // ---- the owner row (Z12-jt-3: portrait + readable name, left, under the type row) -----------
    const ownerRow = (info.canOwner && Number(owner.id) >= 0)
      ? `<div class="zone-owner-row">${zoneOwnerPortraitHtml(owner)}<span class="zone-owner-name">${escapeHtml(owner.name || `Unit ${owner.id}`)}</span></div>`
      : "";

    // Superset, dressed native: overlap cycling has real DF art. The count readout has no native
    // counterpart and stays.
    const cycle = options.cycle;
    const cycling = cycle && Array.isArray(cycle.ids) && cycle.ids.length > 1;
    const cycleRow = cycling ? `
      <div class="zone-btn-row zone-cycle-row">
        ${DWFUI.artBtnHtml({ sprite: "ZONE_PREVIOUS", cls: "zone-tgl", dataset: { zoneCycle: -1 },
          title: "Previous zone on this tile", ariaLabel: "Previous zone on this tile" })}
        <span class="zone-cycle-count">${DWFUI.iconHtml({ sprite: "ZONE_MULTI", cls: "zone-cycle-icon", alt: "Several zones on this tile" })}${Number(cycle.idx) + 1}/${cycle.ids.length}</span>
        ${DWFUI.artBtnHtml({ sprite: "ZONE_NEXT", cls: "zone-tgl", dataset: { zoneCycle: 1 },
          title: "Next zone on this tile", ariaLabel: "Next zone on this tile" })}
      </div>` : "";

    // A refused extend or repaint drag arrives as response text threaded back through options.status.
    // Without this sink the panel reopened unchanged and the player never learned the drag was rejected.
    const statusMsg = options.status && options.status.text
      ? DWFUI.statusHtml({ cls: "zone-action-status", tone: options.status.isError ? "danger" : "good",
          role: options.status.isError ? "alert" : "status", live: options.status.isError ? "assertive" : "polite",
          text: String(options.status.text) })
      : "";

    // Everything below the pinned header is ONE scrollbox; the scrollbar appears only on real overflow.
    const bodyHtml = `${statusMsg}${typeRow}
      <div class="zone-body-grid">
        <div class="zone-body-left">${ownerRow}${options.orderedByLine || ""}${cycleRow}</div>
        <div class="zone-rail">${rail.join("")}</div>
      </div>`;
    // Row 1 is native's NAME ROW: an editable field plus the quill tile. close:false -- native zone
    // panels carry no X, and ESC or a map click dismisses.
    return `${DWFUI.headerHtml({
      cls: "building-head zone-head", close: false, titleCls: "zone-name-cell",
      titleHtml: DWFUI.rawHtml("editable zone-name field: the browser must own caret/selection/IME, so this is DWFUI.textInputHtml (the component grammar for editable copy), not bitmap text",
        DWFUI.textInputHtml({
          cls: "zone-name-input", dataset: { zoneName: "" }, value: autoNamed ? "" : info.name,
          placeholder: zoneUnnamedLabel(info.type, typeLabel), maxLength: 128,
          ariaLabel: `Zone name (${headTitle})`, title: "Zone name -- Enter saves, Escape reverts",
        })),
      tools: [{ sprite: DWFUI.TOKENS.sprites.zoneQuill, cls: "zone-quill", dataset: { zoneNameFocus: "" },
        title: "Name this zone", ariaLabel: "Name this zone" }],
    })}${DWFUI.scrollHtml({ cls: "zone-info-body" }, bodyHtml)}`;
  }

  // Same fallback chain as the animal rows; a terminal letter must carry data-df-identity-missing.
  function zoneOwnerPortraitHtml(owner) {
    const name = owner.name || `Unit ${owner.id}`;
    const glyph = `<div class="portrait-glyph">${escapeHtml(String(name).trim().slice(0, 1).toUpperCase() || "?")}</div>`;
    const source = { id: Number(owner.id), name };
    const cell = typeof creatureCellMarkup === "function" ? creatureCellMarkup(source, "info-portrait-small", glyph) : null;
    if (cell) return cell;
    if (typeof unitPortraitMarkup === "function") return unitPortraitMarkup(source, "info-portrait-small");
    return `<span class="zone-animal-item-glyph" aria-hidden="true" data-df-identity-missing="portrait:zone-owner">${escapeHtml(String(name).slice(0, 1).toUpperCase() || "?")}</span>`;
  }

  async function openZonePanel(id, opts) {
    // `opts.status` lets a caller surface a one-shot message on the reopened panel instead of silently
    // reopening it unchanged. Ordinary opens pass no opts, so the message self-clears.
    const o = opts || {};
    let info = null;
    try {
      const r = await fetch(`/zone-info?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) info = await r.json();
    } catch { globalThis.DwfErr?.count("zone-panel.info"); }
    if (!info || info.error || Number(info.id) < 0) {
      // Refresh-to-truth stays on the same close-less view-sheet chassis.
      selection.style.height = "";
      selection.style.maxHeight = "";
      window.setSelectionPanel("building-panel zone-panel", `<h1>Zone unavailable</h1>`);
      return;
    }
    const repaintTypeLabel = ZONE_TYPE_LABEL[info.type] || info.type || "Zone";
    // A hospital location attached to this zone delegates to the hospital panel, which owns the native
    // one-page supplies, facilities, posts and doctor rows.
    if (info.isHospital && typeof openHospitalPanel === "function") {
      openHospitalPanel(Number(info.hospitalLocationId), info);
      return;
    }
    // The "Ordered by" line, merged from /attrib by zone id; an unknown id renders nothing.
    try { if (typeof attribRefresh === "function") await attribRefresh(); } catch { globalThis.DwfErr?.count("zone-panel.attribution"); }
    const orderedByChip = (typeof attribRowHtml === "function") ? attribRowHtml("zone", info.id) : "";
    const orderedByLine = orderedByChip ? `<div class="dwfui-text--note building-note building-attrib">Ordered by ${orderedByChip}</div>` : "";
    // Superset: overlap cycling walks the stack of zones under the clicked tile client-side. `cycle` is
    // read by the [data-zone-cycle] handler, so it stays here; its markup lives in zonePanelMarkup.
    const cycle = window.dfZoneCycle;
    const cycling = cycle && Array.isArray(cycle.ids) && cycle.ids.length > 1 &&
      cycle.ids.includes(Number(info.id));
    if (cycling) cycle.idx = cycle.ids.indexOf(Number(info.id));
    selection.style.height = "";
    selection.style.maxHeight = "";
    window.setSelectionPanel("building-panel zone-panel", zonePanelMarkup(info, {
      orderedByLine,
      cycle: cycling ? { ids: cycle.ids, idx: cycle.idx } : null,
      status: o.status || null,
    }));
    const nameInput = selection.querySelector("[data-zone-name]");
    const initialName = nameInput ? nameInput.value : "";
    let nameBusy = false;
    const commitZoneName = async () => {
      if (!nameInput || nameBusy) return;
      const name = nameInput.value.trim();
      if (name === initialName.trim()) return;
      nameBusy = true;
      try {
        const response = await fetch(`/zone-rename?id=${info.id}&name=${encodeURIComponent(name)}`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`zone rename failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("zone.rename", err, "That zone rename"); }
      openZonePanel(info.id);
      loadZones();
    };
    nameInput?.addEventListener("click", event => event.stopPropagation());
    nameInput?.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); commitZoneName(); focusPage(); }
      else if (event.key === "Escape") { event.preventDefault(); nameInput.value = initialName; nameInput.blur(); }
    });
    nameInput?.addEventListener("blur", () => { commitZoneName(); });
    selection.querySelector("[data-zone-name-focus]")?.addEventListener("click", event => {
      event.stopPropagation();
      if (nameInput) { nameInput.focus(); nameInput.select(); }
    });
    // The shield-magnifier opens the attached location's own panel, beside the zone panel.
    selection.querySelector("[data-zone-location-open]")?.addEventListener("click", event => {
      event.stopPropagation();
      const locId = Number(event.currentTarget.dataset.zoneLocationOpen);
      if (typeof openLocationPanel === "function" && Number.isInteger(locId) && locId >= 0)
        openLocationPanel(locId);
      focusPage();
    });
    // Native repaint session: keep the overlay visible, stage map edits, and commit only on Accept.
    selection.querySelector("[data-zone-repaint]")?.addEventListener("click", event => {
      event.stopPropagation();
      closeSelection();
      if (window.DFZoneRepaint && typeof window.DFZoneRepaint.arm === "function")
        window.DFZoneRepaint.arm(info.id, {
          label: zoneDisplayName(info.name, repaintTypeLabel),
          sprite: ZONE_TYPE_SPRITE[info.type] || null,
        });
      focusPage();
    });
    selection.querySelectorAll("[data-zone-act]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const action = btn.dataset.zoneAct;
      let refused = false;
      try {
        const r = await fetch(`/zone-action?id=${info.id}&action=${encodeURIComponent(action)}`, { method: "POST", cache: "no-store" });
        // A 501 {"guarded":true} means the host guard refused: keep the panel open and say why instead
        // of silently closing as if the zone were gone.
        if (!r.ok) refused = true;   // guarded 501 (or any failure): the zone still exists
      } catch { refused = true; }
      if (action === "remove" && !refused) closeSelection();
      else openZonePanel(info.id);   // re-render with the new state (active/pit-pond shading)
      focusPage();
    }));
    selection.querySelectorAll("[data-zone-cycle]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const step = Number(btn.dataset.zoneCycle) || 1;
      const n = cycle.ids.length;
      cycle.idx = ((cycle.idx + step) % n + n) % n;
      openZonePanel(cycle.ids[cycle.idx]);
      focusPage();
    }));
    selection.querySelector("[data-zone-units]")?.addEventListener("click", event => {
      event.stopPropagation(); openZoneUnitsPanel(info.id); focusPage();
    });
    selection.querySelector("[data-zone-squads]")?.addEventListener("click", event => {
      event.stopPropagation(); openZoneSquadsPanel(info.id); focusPage();
    });
    selection.querySelector("[data-zone-owner]")?.addEventListener("click", event => {
      event.stopPropagation(); openZoneOwnersPanel(info.id); focusPage();
    });
    selection.querySelector("[data-zone-locations]")?.addEventListener("click", event => {
      event.stopPropagation(); openZoneLocationsPanel(info.id); focusPage();
    });
    // The zone panel has no X; ESC and map clicks close it. Optional-chained so a stray close button
    // in a future skin still binds without throwing.
    selection.querySelector("[data-building-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  async function openZoneSquadsPanel(id) {
    let data = null;
    try {
      const r = await fetch(`/zone-squads?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch { globalThis.DwfErr?.count("zone-panel.squads"); }
    if (!data || Number(data.id) < 0) { openZonePanel(id); return; }
    const rows = Array.isArray(data.squads) ? data.squads : [];
    // Same close-less chrome as the rest of the zone family: native's gold left-arrow is the back
    // affordance, no X and no status line.
    window.setSelectionPanel("building-panel zone-panel zone-wide zone-squad-panel", `
      ${DWFUI.headerHtml({ cls: "building-head zone-sub-head", close: false,
        back: { dataset: { zoneBack: "" }, title: "Back to zone" },
        title: squadRoomName(data.name, data.type), titleCls: "building-name" })}
      ${rows.length ? `<div class="zone-squad-list">${zoneSquadRowsHtml(rows, escapeHtml)}</div>`
        : `<div class="dwfui-text--note zone-note">No squads are available in this fortress.</div>`}
    `);
    paintZoneSquadIcons(selection);
    selection.querySelector("[data-zone-back]").addEventListener("click", event => {
      event.stopPropagation(); openZonePanel(data.id); focusPage();
    });
    selection.querySelectorAll("[data-zone-squad-mode]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const squad = Number(btn.dataset.zoneSquad);
      const mode = btn.dataset.zoneSquadMode || "";
      const enabled = Number(btn.dataset.zoneSquadEnabled) ? 1 : 0;
      if (Number.isInteger(squad) && squad >= 0) {
        btn.disabled = true;
        try {
          const response = await fetch(`/zone-squad-action?id=${data.id}&squad=${squad}&mode=${encodeURIComponent(mode)}&enabled=${enabled}`, {
            method: "POST", cache: "no-store"
          });
          if (!response.ok) throw new Error(`squad assignment failed (${response.status})`);
        } catch (err) { globalThis.DwfOrder.lost("zone.squad-assignment", err, "That squad assignment"); }
      }
      openZoneSquadsPanel(data.id);
      loadZones();
      focusPage();
    }));
    selection.querySelector("[data-building-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  // The sort bar is a RADIOGROUP over columns with exactly one active key. Each column's arrow defaults
  // to descending, so pass `sort: "asc"` where the column sorts (or would sort) ascending.
  const ZONE_ANIMAL_SORT_COLUMNS = [["name", "Name"], ["category", "Cat"], ["profession", "Prof"]];
  function zoneAnimalSortBarHtml(sortKey, sortDirection) {
    return DWFUI.sortHeaderHtml({
      cls: "zone-animal-sortbar", dataAttr: "zone-animal-sort", ariaLabel: "Sort animals",
      active: sortKey,
      columns: ZONE_ANIMAL_SORT_COLUMNS.map(([key, label]) => ({
        key, label,
        // The ACTIVE column shows its current direction; the others show the direction they WOULD sort in.
        sort: (key === sortKey && Number(sortDirection) < 0) ? "desc" : "asc",
      })),
    });
  }
  function zoneProfessionNameHtml(unit, label) {
    const idx = Number(unit && unit.professionColor);
    const body = DWFUI.bitmapTextHtml(label == null ? "" : label);
    const html = Number.isInteger(idx) && idx >= 0 && idx <= 15
      ? `<span style="color:${DWFUI.dfColor(idx)}">${body}</span>` : body;
    return DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered unit name", html);
  }
  function zoneCreaturePortraitHtml(unit, name) {
    const kind = unit?.kind || "unit";
    const label = name || unit?.name || unit?.race || `Unit ${Number(unit?.id)}`;
    const glyph = `<div class="portrait-glyph">${escapeHtml(String(unit?.race || label).slice(0, 1).toUpperCase() || "?")}</div>`;
    const creaturePortrait = kind === "unit" && typeof creatureCellMarkup === "function"
      ? creatureCellMarkup({ ...unit, rt: unit?.rt || unit?.race }, "info-portrait-small", glyph) : null;
    return creaturePortrait || (kind === "unit" && typeof unitPortraitMarkup === "function"
      ? unitPortraitMarkup(unit, "info-portrait-small")
      : `<span class="zone-animal-item-glyph" aria-hidden="true" data-df-identity-missing="portrait:non-unit">${escapeHtml(String(label).slice(0, 1).toUpperCase() || "?")}</span>`);
  }
  function zoneAnimalRowHtml(unit) {
    const state = zoneAnimalAssignmentState(unit);
    const flags = Array.isArray(unit.flags)
      ? unit.flags.filter(flag => flag !== "assigned here" && flag !== "assigned elsewhere") : [];
    const meta = flags.join(" | ");
    const kind = unit.kind || "unit";
    const name = unit.name || unit.race || `Unit ${unit.id}`;
    const label = zoneAnimalNativeLabel(unit);
    // A terminal letter must be FLAGGED. unitPortraitMarkup marks its own; this non-unit branch is the
    // last letter left.
    const portrait = zoneCreaturePortraitHtml(unit, name);
    const locate = state.assigned
      ? DWFUI.artBtnHtml({
        sprite: DWFUI.TOKENS.sprites.unitSelPasture, cls: "zone-animal-locate",
        dataset: { zoneUnitLocate: Number(unit.id), zoneX: Number(unit.x), zoneY: Number(unit.y), zoneZ: Number(unit.z) },
        title: `Assigned here -- view ${name} on the map`, ariaLabel: `View ${name} on the map`,
      })
      : `<span class="zone-animal-locate-slot" aria-hidden="true"></span>`;
    const toggle = DWFUI.checkHtml({
      checked: state.assigned, cls: "zone-animal-toggle",
      dataset: { zoneUnit: Number(unit.id), zoneKind: kind, zoneAssign: state.assign },
      title: `${state.action} ${name}`, ariaLabel: `${state.action} ${name}`,
    });
    return DWFUI.rowHtml({
      cls: "zone-unit-row zone-animal-row" + (state.assigned ? " assigned" : ""),
      dataset: { zoneRow: Number(unit.id), zoneSearch: `${label} ${unit.race || ""} ${meta}`.toLowerCase() },
      icon: portrait,
      copyCls: "zone-animal-copy", labelCls: "zone-unit-name",
      labelHtml: DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered zone unit name",
        zoneProfessionNameHtml(unit, label)),
      sub: meta ? { text: meta, cls: "zone-unit-meta" } : null,
      trailing: locate + toggle,
    });
  }
  function zoneAnimalsPanelMarkup(data, options) {
    const o = options || {};
    const typeLabel = ZONE_TYPE_LABEL[data?.type] || data?.type || "Zone";
    const sortKey = o.sortKey || "name";
    const sortDirection = Number(o.sortDirection) < 0 ? -1 : 1;
    const rows = zoneAnimalSortedRows(data?.units, sortKey, sortDirection);
    const body = rows.length
      ? `${zoneAnimalSortBarHtml(sortKey, sortDirection)}` +
        DWFUI.listHtml({ cls: "zone-unit-list zone-animal-list", rows: ".zone-animal-row", key: "zone-animals" }, rows.map(zoneAnimalRowHtml).join("")) +
        DWFUI.searchHtml({
          cls: "zone-animal-search", placement: "footer", magnifier: true,
          dataAttr: "zone-animal-search", type: "search", value: o.search || "",
          preserveKey: "zone-animals", ariaLabel: "Search animals",
        })
      : `<div class="dwfui-text--note zone-note">No assignable animals found.</div>`;
    return `${DWFUI.headerHtml({ cls:"building-head zone-sub-head", close:false,
      back: { dataset: { zoneBack: "" }, title: "Back to zone" },
      title:zoneDisplayName(data?.name, typeLabel), titleCls:"building-name" })}${body}`;
  }

  function warmUnitSpriteSnapshot() {
    try {
      return typeof refreshUnitSpriteSnapshot === "function" ? refreshUnitSpriteSnapshot() : null;
    } catch { return null; }
  }

  async function openZoneUnitsPanel(id, restore = {}) {
    let data = null;
    const warm = warmUnitSpriteSnapshot();
    try {
      const r = await fetch(`/zone-units?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch { globalThis.DwfErr?.count("zone-panel.units"); }
    try { await warm; } catch { globalThis.DwfErr?.count("zone-panel.unit-list"); }
    if (!data || Number(data.id) < 0) { openZonePanel(id); return; }
    window.setSelectionPanel("building-panel zone-panel zone-wide zone-animal-panel", zoneAnimalsPanelMarkup(data, {
      sortKey: zoneAnimalSortKey, sortDirection: zoneAnimalSortDirection, search: zoneAnimalSearch,
    }));
    const animalList = selection.querySelector(".zone-animal-list");
    const applySearch = () => {
      animalList?.querySelectorAll("[data-zone-row]").forEach(row => {
        row.hidden = typeof dfTokenMatch === "function"
          ? !dfTokenMatch(row.dataset.zoneSearch || "", zoneAnimalSearch)
          : !String(row.dataset.zoneSearch || "").includes(zoneAnimalSearch.trim().toLowerCase());
      });
    };
    applySearch();
    requestAnimationFrame(() => {
      if (!animalList) return;
      const host = animalList.closest("[data-dwfui-list]");
      const kept = animalList.querySelector(`[data-zone-row="${Number(restore.keepUnit)}"]`);
      DWFUI.setListPosition(host, { operation: "restore-row", follow: kept });
    });
    selection.querySelectorAll("[data-zone-animal-sort]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const key = btn.dataset.zoneAnimalSort || "name";
      if (key === zoneAnimalSortKey) zoneAnimalSortDirection *= -1;
      else { zoneAnimalSortKey = key; zoneAnimalSortDirection = 1; }
      openZoneUnitsPanel(data.id);
    }));
    selection.querySelector("[data-zone-animal-search]")?.addEventListener("input", event => {
      zoneAnimalSearch = event.target.value || "";
      applySearch();
    });
    selection.querySelector("[data-zone-back]").addEventListener("click", event => {
      event.stopPropagation(); openZonePanel(data.id); focusPage();
    });
    selection.querySelectorAll("[data-zone-unit]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const unit = Number(btn.dataset.zoneUnit);
      const kind = btn.dataset.zoneKind || "unit";
      const assign = Number(btn.dataset.zoneAssign) ? 1 : 0;
      if (Number.isInteger(unit) && unit >= 0) {
        btn.disabled = true;
        try {
          const response = await fetch(`/zone-unit-action?id=${data.id}&unit=${unit}&assign=${assign}&kind=${encodeURIComponent(kind)}`, { method: "POST", cache: "no-store" });
          if (!response.ok) throw new Error(`zone assignment failed (${response.status})`);
        } catch (err) { globalThis.DwfOrder.lost("zone.unit-assignment", err, "That zone assignment"); }
      }
      await openZoneUnitsPanel(data.id, { keepUnit: unit });
      loadZones();
      focusPage();
    }));
    selection.querySelectorAll("[data-zone-unit-locate]").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const pos = { x: Number(btn.dataset.zoneX), y: Number(btn.dataset.zoneY), z: Number(btn.dataset.zoneZ) };
      if (typeof centerAndFlashMapPos === "function" && pos.x >= 0 && pos.y >= 0 && pos.z >= 0)
        centerAndFlashMapPos(pos);
      focusPage();
    }));
    selection.querySelector("[data-building-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  // ---- the owner chooser -----------------------------------------------------------------------
  let zoneOwnerSortKey = "name";
  let zoneOwnerSortDirection = 1;
  let zoneOwnerSearch = "";
  function zoneOwnerSortedRows(rows, key, direction) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    const val = u => key === "profession" ? String(u.profession || "") : String(u.name || "");
    list.sort((a, b) => val(a).localeCompare(val(b)) * direction ||
      String(a.name || "").localeCompare(String(b.name || "")));
    return list;
  }
  function zoneOwnerRowHtml(u, typeLabel) {
    const name = u.name || `Unit ${u.id}`;
    const flags = [];
    if (u.profession) flags.push(u.profession);
    if (u.dead) flags.push("deceased");
    if (Number(u.sameTypeRooms) > 0) flags.push(`${u.sameTypeRooms} other ${typeLabel}`);
    const portrait = typeof unitPortraitMarkup === "function"
      ? unitPortraitMarkup(u, "info-portrait-small")
      : `<span class="zone-animal-item-glyph" aria-hidden="true" data-df-identity-missing="portrait:zone-owner">${escapeHtml(String(name).slice(0, 1).toUpperCase() || "?")}</span>`;
    const professionColor = Number(u && u.professionColor);
    const nameHtml = Number.isInteger(professionColor) && professionColor >= 0 && professionColor <= 15
      ? `<span style="color:${DWFUI.dfColor(professionColor)}">${DWFUI.bitmapTextHtml(name)}</span>`
      : DWFUI.bitmapTextHtml(name);
    return DWFUI.rowHtml({
      cls: "zone-unit-row zone-owner-pick-row" + (u.assigned ? " assigned" : ""),
      role: "button",
      dataset: { zoneOwnerUnit: Number(u.id), zoneSearch: `${name} ${u.profession || ""}`.toLowerCase() },
      icon: portrait, copyCls: "zone-animal-copy", labelCls: "zone-unit-name",
      labelHtml: DWFUI.rawHtml("DF profession colour wraps the bitmap-rendered room-owner name", nameHtml),
      sub: flags.length ? { text: flags.join(" | "), cls: "zone-unit-meta" } : null,
      title: u.assigned
        ? `Assigned to this ${typeLabel} -- click to remove the assignment`
        : `Assign this ${typeLabel} to ${name}`,
    });
  }
  function zoneOwnersPanelMarkup(data, options) {
    const o = options || {};
    const typeLabel = ZONE_TYPE_LABEL[data?.type] || data?.type || "Zone";
    const sortKey = o.sortKey || "name";
    const sortDirection = Number(o.sortDirection) < 0 ? -1 : 1;
    const rows = zoneOwnerSortedRows(data?.owners, sortKey, sortDirection);
    const sortBar = DWFUI.sortHeaderHtml({
      cls: "zone-owner-sortbar", dataAttr: "zone-owner-sort", ariaLabel: "Sort citizens",
      active: sortKey,
      columns: [
        { key: "name", label: "Name", sort: (sortKey === "name" && sortDirection < 0) ? "desc" : "asc" },
        { key: "category", label: "Cat", sort: "asc", disabled: true,
          title: "Native sorts a unit-category column here; the /zone-owners wire carries no category data yet" },
        { key: "profession", label: "Prof", sort: (sortKey === "profession" && sortDirection < 0) ? "desc" : "asc" },
        { key: "extra", label: "", sort: "desc", disabled: true,
          title: "Native shows one more sort control here (Z12-jt-2); what it sorts is unverified" },
      ],
    });
    const clearRow = Number(data?.ownerId) >= 0
      ? DWFUI.rowHtml({ cls: "zone-unit-row zone-owner-clear-row", role: "button",
        dataset: { zoneOwnerClear: "" }, label: "Remove assignment" })
      : "";
    const listBody = rows.length || clearRow
      ? DWFUI.scrollHtml({ cls: "zone-unit-list zone-owner-list", rows: ".zone-unit-row" },
        clearRow + rows.map(u => zoneOwnerRowHtml(u, typeLabel)).join(""))
      : `<div class="dwfui-text--note zone-note">No assignable citizens found.</div>`;
    return `
      ${DWFUI.headerHtml({ cls:"building-head zone-sub-head", close:false,
        back: { dataset: { zoneBack: "" }, title: "Back to zone" },
        title:zoneDisplayName(data?.name, typeLabel), titleCls:"building-name" })}
      ${sortBar}
      ${listBody}
      ${DWFUI.searchHtml({
        cls: "zone-owner-search", placement: "footer", magnifier: true,
        dataAttr: "zone-owner-search", type: "search", value: o.search || "",
        preserveKey: "zone-owners", ariaLabel: "Search citizens",
      })}
    `;
  }

  async function openZoneOwnersPanel(id) {
    let data = null;
    const warm = warmUnitSpriteSnapshot();   // see warmUnitSpriteSnapshot above.
    try {
      const r = await fetch(`/zone-owners?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch { globalThis.DwfErr?.count("zone-panel.owners"); }
    try { await warm; } catch { globalThis.DwfErr?.count("zone-panel.owner-list"); }
    if (!data || Number(data.id) < 0) { openZonePanel(id); return; }
    window.setSelectionPanel("building-panel zone-panel zone-wide zone-owner-panel", zoneOwnersPanelMarkup(data, {
      sortKey: zoneOwnerSortKey, sortDirection: zoneOwnerSortDirection, search: zoneOwnerSearch,
    }));
    const ownerList = selection.querySelector(".zone-owner-list");
    const applyOwnerSearch = () => {
      ownerList?.querySelectorAll("[data-zone-owner-unit]").forEach(row => {
        row.hidden = typeof dfTokenMatch === "function"
          ? !dfTokenMatch(row.dataset.zoneSearch || "", zoneOwnerSearch)
          : !String(row.dataset.zoneSearch || "").includes(zoneOwnerSearch.trim().toLowerCase());
      });
    };
    applyOwnerSearch();
    selection.querySelectorAll("[data-zone-owner-sort]:not([disabled])").forEach(btn => btn.addEventListener("click", event => {
      event.stopPropagation();
      const key = btn.dataset.zoneOwnerSort || "name";
      if (key === zoneOwnerSortKey) zoneOwnerSortDirection *= -1;
      else { zoneOwnerSortKey = key; zoneOwnerSortDirection = 1; }
      openZoneOwnersPanel(data.id);
    }));
    selection.querySelector("[data-zone-owner-search]")?.addEventListener("input", event => {
      zoneOwnerSearch = event.target.value || "";
      applyOwnerSearch();
    });
    selection.querySelector("[data-zone-back]").addEventListener("click", event => {
      event.stopPropagation(); openZonePanel(data.id); focusPage();
    });
    selection.querySelector("[data-zone-owner-clear]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try {
        const response = await fetch(`/zone-owner-action?id=${data.id}&unit=-1`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`owner assignment failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("zone.owner-assignment", err, "That owner change"); }
      openZoneOwnersPanel(data.id);
      focusPage();
    });
    selection.querySelectorAll("[data-zone-owner-unit]").forEach(row => row.addEventListener("click", async event => {
      event.stopPropagation();
      const unit = Number(row.dataset.zoneOwnerUnit);
      if (Number.isInteger(unit) && unit >= 0) {
        const nextUnit = row.classList.contains("assigned") ? -1 : unit;
        try {
          const response = await fetch(`/zone-owner-action?id=${data.id}&unit=${nextUnit}`, { method: "POST", cache: "no-store" });
          if (!response.ok) throw new Error(`owner assignment failed (${response.status})`);
        } catch (err) { globalThis.DwfOrder.lost("zone.owner-assignment", err, "That owner change"); }
      }
      openZoneOwnersPanel(data.id);
      focusPage();
    }));
    selection.querySelector("[data-building-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  async function openZoneLocationsPanel(id) {
    let data = null;
    try {
      const r = await fetch(`/zone-locations?id=${id}&t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) data = await r.json();
    } catch { globalThis.DwfErr?.count("zone-panel.locations"); }
    if (!data || Number(data.id) < 0) { openZonePanel(id); return; }
    const typeLabel = ZONE_TYPE_LABEL[data.type] || data.type || "Zone";
    const locations = Array.isArray(data.locations) ? data.locations : [];
    const createTypes = Array.isArray(data.createTypes) ? data.createTypes : [];
    const currentSummary = locations.find(l => l.current);
    let currentDetails = null;
    if (currentSummary && Number(currentSummary.id) >= 0) {
      try {
        const r = await fetch(`/location-detail?id=${Number(currentSummary.id)}&t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) currentDetails = await r.json();
      } catch { globalThis.DwfErr?.count("zone-panel.location-detail"); }
    }
    window.setSelectionPanel("building-panel zone-panel zone-wide", `
      ${DWFUI.headerHtml({ cls:"building-head zone-sub-head", close:false,
        back: { dataset: { zoneBack: "" }, title: "Back to zone" },
        title:zoneDisplayName(data.name, typeLabel), titleCls:"building-name" })}
      ${Number(data.locationId) >= 0 ? DWFUI.plaqueBtnHtml({ cls: "building-btn danger", tone: "red", dataset: { zoneLocationClear: "" }, label: "Remove current location assignment" }) : ""}
      ${createTypes.length ? `<div class="dwfui-text--section zone-section-label">Create New Location</div>
        <div class="zone-location-create-grid">
          ${createTypes.map(t => DWFUI.plaqueBtnHtml({ cls: "zone-mini-btn", size: "compact", dataset: { zoneLocationCreate: t.kind }, label: `New ${t.label}` })).join("")}
        </div>` : ""}
      <div class="dwfui-text--section zone-section-label">Existing Locations</div>
      ${window.zoneUnitListHtml(locations.map(loc => {
        const flags = [];
        if (loc.label) flags.push(loc.label);
        flags.push(`${Number(loc.zoneCount) || 0} zone${Number(loc.zoneCount) === 1 ? "" : "s"}`);
        return window.zoneUnitRowHtml({
          label: loc.name || loc.label || `Location ${loc.id}`,
          meta: flags.join(" | "),
          trailing: DWFUI.plaqueBtnHtml({
            cls: "zone-unit-act" + (loc.current ? " assigned" : ""), size: "compact",
            label: loc.current ? "Current" : "Assign", on: !!loc.current,
            dataset: { zoneLocation: Number(loc.id) },
          }),
        });
      }), "No existing locations found.")}
      ${(() => {
        const current = locations.find(l => l.current);
        if (!current) return "";
        const occs = Array.isArray(current.occupations) ? current.occupations : [];
        const details = currentDetails || current;
        return `
      <div class="dwfui-text--section zone-section-label">${escapeHtml(current.name || current.label || "Location")} &middot; details</div>
      <div class="zone-loc-rename">
        ${DWFUI.textInputHtml({ cls: "zone-loc-name-input", maxLength: 48, value: current.name || "", placeholder: "Location name" })}
        ${DWFUI.plaqueBtnHtml({ cls: "zone-mini-btn", size: "compact", dataset: { zoneLocationRename: "" }, label: "Rename" })}
      </div>
      <div class="zone-loc-access"><span class="zone-loc-access-label">Access</span>
        ${window.DFLocationMarkup && window.DFLocationMarkup.locationAccessHtml
          ? window.DFLocationMarkup.locationAccessHtml(details) : ""}
      </div>
      <div class="zone-loc-occs"><span class="zone-loc-access-label">Occupations</span>
        ${occs.length ? occs.map(o => `<div class="zone-unit-meta">${DWFUI.bitmapTextHtml(`${o.type}: ${o.assigned ? o.holder || "assigned" : "open"}`)}</div>`).join("")
          : `<div class="dwfui-text--note zone-note">No occupations assigned yet.</div>`}
      </div>
      ${DWFUI.plaqueBtnHtml({ cls: "building-btn", tone: "gold",
        dataset: { zoneLocationDetails: Number(current.id) },
        label: "Location details (staff, occupants, dedication)" })}
      ${DWFUI.plaqueBtnHtml({ cls: "building-btn danger", tone: "red", dataset: { zoneLocationRetire: "" }, label: "Retire location" })}`;
      })()}
    `);
    selection.querySelector("[data-zone-back]").addEventListener("click", event => {
      event.stopPropagation(); openZonePanel(data.id); focusPage();
    });
    selection.querySelector("[data-zone-location-details]")?.addEventListener("click", event => {
      event.stopPropagation();
      const locId = Number(event.currentTarget.dataset.zoneLocationDetails);
      if (typeof openLocationPanel === "function" && Number.isInteger(locId) && locId >= 0)
        openLocationPanel(locId);
      focusPage();
    });
    selection.querySelector("[data-zone-location-clear]")?.addEventListener("click", async event => {
      event.stopPropagation();
      try {
        const response = await fetch(`/zone-location-action?id=${data.id}&action=clear`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`location clear failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("zone.location-clear", err, "That location change"); }
      openZoneLocationsPanel(data.id);
      focusPage();
    });
    selection.querySelectorAll("[data-zone-location-create]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const kind = btn.dataset.zoneLocationCreate || "";
      try {
        const response = await fetch(`/zone-location-action?id=${data.id}&action=create&kind=${encodeURIComponent(kind)}`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`location creation failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("zone.location-create", err, "That location change"); }
      openZoneLocationsPanel(data.id);
      focusPage();
    }));
    selection.querySelectorAll("[data-zone-location]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      const loc = Number(btn.dataset.zoneLocation);
      if (!btn.classList.contains("assigned") && Number.isInteger(loc) && loc >= 0) {
        try {
          const response = await fetch(`/zone-location-action?id=${data.id}&action=assign&location=${loc}`, { method: "POST", cache: "no-store" });
          if (!response.ok) throw new Error(`location assignment failed (${response.status})`);
        } catch (err) { globalThis.DwfOrder.lost("zone.location-assign", err, "That location change"); }
      }
      openZoneLocationsPanel(data.id);
      focusPage();
    }));
    const currentLoc = locations.find(l => l.current);
    selection.querySelectorAll("[data-loc-access]").forEach(btn => btn.addEventListener("click", async event => {
      event.stopPropagation();
      if (!currentLoc || btn.classList.contains("active")) return;
      const mode = btn.dataset.locAccess || "";
      try {
        const response = await fetch(`/location-native-action?id=${Number(currentLoc.id)}&action=access&mode=${encodeURIComponent(mode)}`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`location access failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("zone.location-access", err, "That access change"); }
      openZoneLocationsPanel(data.id);
      focusPage();
    }));
    selection.querySelector("[data-zone-location-rename]")?.addEventListener("click", async event => {
      event.stopPropagation();
      if (!currentLoc) return;
      const input = selection.querySelector(".zone-loc-name-input");
      const name = (input?.value || "").trim();
      if (!name) return;
      try {
        const response = await fetch(`/zone-location-action?id=${data.id}&action=rename&location=${Number(currentLoc.id)}&kind=${encodeURIComponent(name)}`, { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(`location rename failed (${response.status})`);
      } catch (err) { globalThis.DwfOrder.lost("zone.location-rename", err, "That location rename"); }
      openZoneLocationsPanel(data.id);
      focusPage();
    });
    selection.querySelector("[data-zone-location-retire]")?.addEventListener("click", async event => {
      event.stopPropagation();
      if (!currentLoc) return;
      try {
        const r = await fetch(`/zone-location-action?id=${data.id}&action=retire&location=${Number(currentLoc.id)}`, { method: "POST", cache: "no-store" });
        if (!r.ok) { const t = await r.text().catch(() => ""); alert("Cannot retire: " + (t || "location in use")); }
      } catch (err) { globalThis.DwfOrder.lost("zone.location-retire", err, "That location retirement"); }
      openZoneLocationsPanel(data.id);
      focusPage();
    });
    selection.querySelector("[data-building-close]")?.addEventListener("click", event => {
      event.stopPropagation(); closeSelection(); focusPage();
    });
  }

  // --- Stockpile management panel ---

  if (typeof window !== "undefined") Object.assign(window.DFBuildingOperationsMarkup ||= {}, { zonePanelMarkup, zoneAnimalsPanelMarkup, zoneOwnersPanelMarkup });

  if (typeof window !== "undefined") Object.assign(window, { openZoneOwnersPanel, openZonePanel, zoneAnimalNativeLabel, zoneAnimalSortBarHtml, zoneAnimalSortedRows, zoneCreaturePortraitHtml, zoneProfessionNameHtml });
  if (typeof module !== "undefined" && module.exports) Object.assign(module.exports, { zoneAnimalAssignmentState, ZONE_SQUAD_MODES, zoneSquadModeState, zoneSquadRgb, zoneSquadRowsHtml, paintZoneSquadIcons, zoneAnimalNativeLabel, zoneAnimalSortedRows, ZONE_TYPE_LABEL, ZONE_TYPE_SPRITE, ZONE_UNNAMED, zoneUnnamedLabel, LOCATION_TYPE_SPRITE, zoneLocationSprite, ZONE_TIP_LOCATION_ASSIGN, ZONE_TIP_LOCATION_DETAILS, ZONE_TIP_GATHER_TREES, ZONE_TIP_GATHER_SHRUBS, ZONE_TIP_GATHER_FALLEN, zoneIsAutoNamed, zoneDisplayName, zoneAcceptsSquads, squadRoomName, zoneLatch, zonePanelMarkup, zoneOwnerPortraitHtml, openZonePanel, openZoneSquadsPanel, ZONE_ANIMAL_SORT_COLUMNS, zoneAnimalSortBarHtml, zoneProfessionNameHtml, zoneCreaturePortraitHtml, zoneAnimalRowHtml, zoneAnimalsPanelMarkup, warmUnitSpriteSnapshot, openZoneUnitsPanel, zoneOwnerSortedRows, zoneOwnerRowHtml, zoneOwnersPanelMarkup, openZoneOwnersPanel, openZoneLocationsPanel });
