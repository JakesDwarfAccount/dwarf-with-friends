// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// b270_chooser_geometry.probe.js -- REAL-BROWSER geometry oracle for B270/B271 (the "assign X to Y"
// chooser is cut off everywhere).
//
// This is a BROWSER MODULE, not a node test. It is loaded into a page that has already loaded the
// production stylesheet + DWFUI + the zone/building markup module (the ui-lab index does exactly
// that), it builds the REAL production chooser panels inside a REAL `#selection` chassis (the panel
// width rules are ID-scoped: `#selection.building-panel.zone-panel.zone-wide`, so a class-only host
// silently measures the wrong width), and it returns getBoundingClientRect/scrollWidth numbers.
//
// WHY A BROWSER AND NOT A GREP: seven green tests masked dead features on 2026-07-13 because they
// asserted what we wrote, not what reached the screen. A CSS grid places children into TRACKS; the
// bug here is a track/child mismatch, and only layout can tell you which child landed in which
// track. `grep` for a rule proves nothing.
//
// Drive it with:
//   python tools/ui-lab/serve.py --port 4199
//   node tools/harness/cdp_probe.mjs --url http://localhost:4199/tools/ui-lab/index.html \
//     --eval "(async()=>{const m=await import('/tools/harness/b270_chooser_geometry.probe.js');return m.run();})()"
// or, with the assertions applied, `node tools/harness/b270_chooser_geometry_test.mjs` (which
// spawns Chrome + the lab server itself).

// The long content that this class of bug hides behind. Real DF names: a dwarf with a nickname and
// a long profession, and a long animal species. B250 shipped broken for exactly this reason -- the
// lab only ever previewed the component holding SHORT content.
export const LONG_DWARF = 'Deduk Èrithlokum "Nameworked" Uzolnokzim';
export const LONG_ANIMAL = "Stray Giant Desert Scorpion Foal, ♂ (Tame)";

function rect(el) { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; }

function measurePanel(host, surface) {
  const panel = host.getBoundingClientRect();
  const out = { surface, panel: { w: Math.round(panel.width), right: Math.round(panel.right) }, clipped: [] };
  const note = (what, px) => { if (px > 0.5) out.clipped.push(`${what}: ${Math.round(px)}px`); };

  const head = host.querySelector(".bld-head");
  if (head) {
    const t = head.querySelector(".bld-name");
    const tr = t.getBoundingClientRect();
    out.header = {
      gridTemplateColumns: getComputedStyle(head).gridTemplateColumns,
      childCount: head.children.length,
      titleBoxW: Math.round(tr.width),
      titleContentW: Math.round(t.scrollWidth),
      titleClippedPx: Math.round(t.scrollWidth - tr.width),
      backBoxW: head.firstElementChild ? Math.round(head.firstElementChild.getBoundingClientRect().width) : null,
    };
    note("window title", out.header.titleClippedPx);
  }

  out.rows = [...host.querySelectorAll(".zone-unit-row")].map(r => {
    const name = r.querySelector(".zone-unit-name");
    const copy = r.querySelector(".zone-animal-copy");
    const icon = r.firstElementChild;
    const nr = name && name.getBoundingClientRect();
    const row = {
      text: (name ? name.textContent : r.textContent).trim().slice(0, 34),
      gridTemplateColumns: getComputedStyle(r).gridTemplateColumns,
      childCount: r.children.length,
      firstChild: icon ? icon.className : null,
      iconBoxW: icon ? Math.round(icon.getBoundingClientRect().width) : null,
      copyBoxW: copy ? Math.round(copy.getBoundingClientRect().width) : null,
      nameBoxW: nr ? Math.round(nr.width) : null,
      nameContentW: name ? Math.round(name.scrollWidth) : null,
      nameClippedPx: name && nr ? Math.round(name.scrollWidth - nr.width) : null,
      pastPanelEdgePx: nr ? Math.round(nr.right - panel.right) : null,
      rowOverflowPx: Math.round(r.scrollWidth - r.clientWidth),
    };
    note(`row "${row.text}" name`, row.nameClippedPx);
    note(`row "${row.text}" past the panel edge`, row.pastPanelEdgePx);
    return row;
  });

  const bar = host.querySelector(".zone-owner-sortbar, .zone-animal-sortbar");
  if (bar) {
    out.sortbar = {
      gridTemplateColumns: getComputedStyle(bar).gridTemplateColumns,
      overflowPx: bar.scrollWidth - bar.clientWidth,
      pastPanelEdgePx: Math.round(bar.getBoundingClientRect().right - panel.right),
      buttons: [...bar.querySelectorAll("button")].map(b => ({
        label: b.textContent.trim().slice(0, 10),
        boxW: Math.round(b.getBoundingClientRect().width),
        contentW: b.scrollWidth,
        clippedPx: b.scrollWidth - b.clientWidth,
        pastPanelEdgePx: Math.round(b.getBoundingClientRect().right - panel.right),
      })),
    };
    out.sortbar.buttons.forEach(b => note(`sort header "${b.label}"`, b.clippedPx));
    note("sort bar past the panel edge", out.sortbar.pastPanelEdgePx);
  }

  const list = host.querySelector(".zone-unit-list, .zone-animal-list");
  if (list) {
    out.list = { boxW: Math.round(list.getBoundingClientRect().width), contentW: list.scrollWidth, hOverflowPx: list.scrollWidth - list.clientWidth };
    note("list horizontal overflow", out.list.hOverflowPx);
  }

  const deadCols = out.rows.filter(r => r.iconBoxW != null && r.copyBoxW != null && r.iconBoxW > r.copyBoxW);
  if (deadCols.length) out.deadIconColumn = { rows: deadCols.length, iconBoxW: deadCols[0].iconBoxW, copyBoxW: deadCols[0].copyBoxW };
  if (out.header && out.header.backBoxW > 80) out.deadHeaderColumn = { backBoxW: out.header.backBoxW, titleBoxW: out.header.titleBoxW };
  return out;
}

export const FIXTURES = {
  owners: {
    id: 9, type: "Office", name: "", ownerId: -1,
    owners: [
      { id: 1, name: "Deduk Èrith", profession: "Miner" },
      { id: 2, name: "Doren Mistêm", profession: "expedition leader" },
      { id: 3, name: LONG_DWARF, profession: "Dwarven Child" },
    ],
  },
  pasture: {
    id: 7, type: "Pen", name: "", isPen: true,
    units: [
      { id: 11, kind: "unit", name: "Stray Cat, ♀ (Tame)", race: "CAT", flags: ["tame"], x: 1, y: 1, z: 1 },
      { id: 12, kind: "unit", name: "Stray Ewe, ♀ (Tame)", race: "SHEEP", flags: ["tame", "grazer", "milkable"], x: 1, y: 1, z: 1 },
      { id: 13, kind: "unit", name: LONG_ANIMAL, race: "SCORPION", flags: ["tame", "grazer"], x: 1, y: 1, z: 1 },
    ],
  },
};

export async function run() {
  const API = window.DFBuildingOperationsMarkup;
  if (!API) throw new Error("DFBuildingOperationsMarkup is not on the page");
  let host = document.getElementById("b270-probe-host");
  if (!host) { host = document.createElement("div"); host.id = "b270-probe-host"; document.body.appendChild(host); }
  // The width rules are ID-scoped to #selection. Measuring in a class-only host measures a
  // DIFFERENT panel than the player sees, which is how a "measured" pass can still be a lie.
  host.id = "selection";

  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = [];

  host.className = "visible building-panel zone-panel zone-wide zone-owner-panel";
  host.innerHTML = API.zoneOwnersPanelMarkup
    ? API.zoneOwnersPanelMarkup(FIXTURES.owners, { sortKey: "name", sortDirection: 1, search: "" })
    : "<!-- zoneOwnersPanelMarkup is not exported: the owner chooser has no lab/probe surface -->";
  window.DWFUI?.mountDom?.(host);
  await settle();
  out.push(measurePanel(host, "assign office (owner chooser)"));

  host.className = "visible building-panel zone-panel zone-wide zone-animal-panel";
  host.innerHTML = API.zoneAnimalsPanelMarkup(FIXTURES.pasture, { sortKey: "name", sortDirection: 1, search: "" });
  window.DWFUI?.mountDom?.(host);
  await settle();
  out.push(measurePanel(host, "assign animals to pasture (animal chooser)"));

  host.remove();
  return out;
}
