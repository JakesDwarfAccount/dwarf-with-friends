// b88_worldmap_test.mjs -- offline fixture acceptance for B88 ("The world map is totally broken").
//
// Root cause: /view world screen drew only site markers as tiny squares on a near-black canvas,
// with NO terrain raster -> read as confetti on black. Fix: the server now emits an additive
// downsampled biome grid (`terrain`) on /world-map (src/worldmap_panel.cpp) and the client
// (web/js/dwf-worldmap.js) renders it behind the sites, with a resilient ocean-plate
// fallback when the field is absent (older DLL). This test exercises the PURE client helpers:
// the biome colour map, the terrain-envelope decoder (+ its reject cases), the fit/centre
// transform, and the site colouring.
//
// Run: node tools/harness/b88_worldmap_test.mjs        (zero-dep, Node >= 18)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "..", "..", "web", "js", "dwf-worldmap.js");
const serverPath = join(here, "..", "..", "src", "worldmap_panel.cpp");
globalThis.DWFUI = require(join(here, "..", "..", "web", "js", "dwf-ui-components.js"));
globalThis.escapeHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

let failed = 0, passed = 0;
const check = (n, c, x) => { if (c) { passed++; console.log(`  ok - ${n}`); } else { failed++; console.log(`  FAIL - ${n}${x ? "  " + x : ""}`); } };
const guard = (n, c, x) => check(`(test-the-test) ${n}`, c, x);

try { execFileSync(process.execPath, ["--check", modPath], { stdio: "pipe" }); check("dwf-worldmap.js node --check", true); }
catch (e) { check("node --check", false, e.stderr ? e.stderr.toString() : e.message); }

const M = require(modPath);
check("exports the pure B88 helpers",
  ["worldSiteColor", "worldTerrainColor", "decodeWorldTerrain", "worldMapLayout", "worldButtonRoute"].every(k => typeof M[k] === "function"));
check("Artifacts reuses the production Objects panel", M.worldButtonRoute("artifacts").name === "objects");
check("Reports reuses the production Reports panel", M.worldButtonRoute("reports").name === "reports");
check("Missing citizens reuses Creatures Dead/Missing", M.worldButtonRoute("missing").detail === "dead");
check("Missions and News route to production world subpanels", M.worldButtonRoute("missions").kind === "missions" && M.worldButtonRoute("news").kind === "news");
guard("unknown world action remains blocked", M.worldButtonRoute("invented").kind === "blocked");

const worldData = {
  civs: [{ id: 3, name: "The Ashen Horde", relation: "War", population: 900, siteCount: 4, knownSiteCount: 3, meetingCount: 0, warFatigue: 37 }],
  missions: [{ id: 1, goal: "RECOVER_ARTIFACT", targetSite: "Black Spire", squadIds: [5, 6] }],
  news: [{ type: "ARMY_MARCHING_TO_SITE", source: "The Ashen Horde", year: 126 }],
};
check("civilization list links every served civilization", /data-world-civ-id="3"/.test(M.worldCivsPanelHtml(worldData)) && /War/.test(M.worldCivsPanelHtml(worldData)));
check("civilization detail renders live diplomacy and population facts", /Known population/.test(M.worldCivsPanelHtml(worldData, 3)) && /900/.test(M.worldCivsPanelHtml(worldData, 3)) && /War fatigue/.test(M.worldCivsPanelHtml(worldData, 3)));
check("missions render goal, target, and assigned squad count", /Recover Artifact/.test(M.worldMissionsPanelHtml(worldData)) && /Black Spire/.test(M.worldMissionsPanelHtml(worldData)) && /2 squads/.test(M.worldMissionsPanelHtml(worldData)));
check("news renders rumor type, source, and year", /Army Marching To Site/.test(M.worldNewsPanelHtml(worldData)) && /The Ashen Horde/.test(M.worldNewsPanelHtml(worldData)) && /Year 126/.test(M.worldNewsPanelHtml(worldData)));
const serverSource = readFileSync(serverPath, "utf8");
check("server reads civilization diplomacy, active army controllers, and rumor events", /relations\.diplomacy\.state/.test(serverSource) && /army_controllers\.all/.test(serverSource) && /rumor_info\.events/.test(serverSource));

// ---- biome colour map ------------------------------------------------------------------------
for (const ch of ["~", "l", "^", "T", ".", "d", "n"])
  check(`biome '${ch}' has a colour`, /^#[0-9a-f]{6}$/i.test(M.worldTerrainColor(ch)));
check("ocean and forest are visibly different", M.worldTerrainColor("~") !== M.worldTerrainColor("T"));
guard("unknown biome char -> '' (drawn as nothing, layer degrades)", M.worldTerrainColor("?") === "" && M.worldTerrainColor(" ") === "" && M.worldTerrainColor("") === "");

// ---- site colouring --------------------------------------------------------------------------
check("own fort marker is the red highlight", M.worldSiteColor("Town", true) === "#ff5252");
check("known site type keeps its colour", M.worldSiteColor("Town", false) === "#66bb6a");
check("unknown site type -> neutral default", /^#[0-9a-f]{6}$/i.test(M.worldSiteColor("Zorbon", false)));

// ---- terrain envelope decoder ----------------------------------------------------------------
const good = { w: 3, h: 2, step: 4, rows: ["~~T", ".^d"] };
const dec = M.decodeWorldTerrain(good);
check("valid terrain decodes", dec && dec.w === 3 && dec.h === 2 && dec.step === 4 && dec.rows.length === 2);
check("decoded rows carry the biome chars", dec.rows[0] === "~~T" && dec.rows[1].charAt(1) === "^");
guard("absent terrain -> null (fallback path)", M.decodeWorldTerrain(undefined) === null && M.decodeWorldTerrain(null) === null);
guard("rows/height mismatch -> null", M.decodeWorldTerrain({ w: 3, h: 5, step: 1, rows: ["~~T", ".^d"] }) === null);
guard("empty rows -> null", M.decodeWorldTerrain({ w: 3, h: 0, step: 1, rows: [] }) === null);
guard("non-positive dims -> null", M.decodeWorldTerrain({ w: 0, h: 2, step: 1, rows: ["", ""] }) === null);
guard("missing step defaults to 1 (not a reject)", (M.decodeWorldTerrain({ w: 1, h: 1, rows: ["~"] }) || {}).step === 1);

// ---- fit-and-centre transform ----------------------------------------------------------------
// A 100x100 world in a 400x200 viewport: limited by height -> scale 2, centred horizontally.
const L = M.worldMapLayout(100, 100, 400, 200);
check("layout scales to fit the smaller axis", Math.abs(L.scale - 2) < 1e-9);
check("layout centres on the free axis", Math.abs(L.ox - 100) < 1e-9 && Math.abs(L.oy - 0) < 1e-9);
guard("degenerate inputs don't divide-by-zero", (() => {
  const z = M.worldMapLayout(0, 0, 0, 0);
  return Number.isFinite(z.scale) && Number.isFinite(z.ox) && Number.isFinite(z.oy);
})());

// ---- WAVE-5 GATE C: the world screen's controls are DWFUI components -----------------------------
// Asserted on the EMITTED MARKUP (a source regex for /DWFUI/ is not proof of adoption).
//
// ORACLE: tools/spikes/ui-truth/22-world.png -- provenance "native", quality "good" (checked in
// tools/ui-lab/reference-provenance.json). Its bottom-right stack is native PLAQUES WITH TONES, in
// exactly the order WORLD_BUTTONS already declared. The tones below are transcribed from that single
// capture as OBSERVED FACT; no state-semantics are inferred from it (one frame cannot tell us whether
// red means "you have none"), so nothing here asserts behaviour -- only the paint.
// NOT AN ORACLE, deliberately unused: .../CIM-objects-artifacts.jpg is declared "dfhack-overlay".
const buttons = M.worldButtonsHtml();
check("world buttons are DWFUI plaques, not hand-built HTML buttons",
  /class="dwfui-plaque/.test(buttons) && !/class="world-btn"[^>]*>[A-Za-z]/.test(buttons));
check("world button labels are BITMAP text", /dwfui-bitmap-text/.test(buttons));
check("every world button keeps its data-world-btn route wire",
  ["center", "missions", "news", "civs", "missing", "artifacts", "reports", "done"]
    .every(k => new RegExp(`data-world-btn="${k}"`).test(buttons)));
check("the .world-btn classname is preserved through the cls hook (its CSS + tests still pin it)",
  (buttons.match(/dwfui-plaque[^"]*world-btn/g) || []).length === 8);

// The oracle's tone per button, in DF's own stack order.
const TONES = [["center", "green"], ["missions", "red"], ["news", "green"], ["civs", "green"],
  ["missing", "red"], ["artifacts", "green"], ["reports", "red"], ["done", "grey"]];
for (const [key, tone] of TONES) {
  const btn = (buttons.match(new RegExp(`<button[^>]*data-world-btn="${key}"[^>]*>`)) || [""])[0];
  check(`22-world.png: "${key}" is a ${tone} plaque`, new RegExp(`\\b${tone}\\b`).test(btn), btn);
}
guard("a tone the oracle does not show is NOT emitted (no invented orange/blue plaques)",
  !/dwfui-plaque[^"]*\borange\b/.test(buttons));

const civs = M.worldCivsPanelHtml(worldData, -1);
check("civilization rows are DWFUI rows, keeping the data-world-civ-id wire",
  /class="dwfui-row[^"]*world-civ-row/.test(civs) && /data-world-civ-id="3"/.test(civs));
const civDetail = M.worldCivsPanelHtml(worldData, 3);
check("the civ BACK control is native's gold BUTTON_CLOSE_LEFT tile, not a Unicode arrow",
  /data-dwfui-sprite="BUTTON_CLOSE_LEFT"/.test(civDetail) && /data-world-civ-back/.test(civDetail));
check("civ/missions/news closes are the native close SPRITE, not a raw multiplication-sign glyph",
  [civs, civDetail, M.worldMissionsPanelHtml(worldData), M.worldNewsPanelHtml(worldData)]
    .every(h => !/&times;/.test(h) && /data-world-civs-close/.test(h)));

console.log(`\nB88 worldmap: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
