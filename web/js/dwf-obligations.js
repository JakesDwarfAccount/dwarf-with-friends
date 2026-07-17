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

  // WT15 Obligations board: a summonable, always-current running list of the fort's standing
  // obligations, aggregated from two existing wires (NO new server work):
  //   1. NOBLE MANDATES  -- the `mandates` array already on /nobles (who, item, made/required,
  //      time state). Same source noblesBody derives its demand/mandate icons from.
  //   2. GUILD HALLS & TEMPLES -- Location-type agreements on /petitions (B191 pending+continuing
  //      union). Continuing Location agreements are the accepted guildhall/temple obligations;
  //      pending ones are outstanding requests.
  // Summoned like the other client-only panels (Shift+B, mirroring Petitions' Shift+G): a keydown
  // case + the settings keybind registry + the hotkey overlay. It stays current while open by
  // re-polling both routes on a guarded interval (the hostpanel/combatlog refresh pattern) and
  // re-rendering only when the payload actually changed (no scroll thrash on an idle fort).
  //
  // ALL row/structure markup goes through DWFUI (rowHtml); the window chrome reuses the shared
  // fortRenderWindow skin (same as Petitions/Kitchen). No hand-rolled row grammar, no color/glyph
  // literals in this file.

  let oblTimer = null;          // live-refresh interval handle
  let oblLastSig = null;        // last-rendered payload signature (skip redundant re-renders)
  const OBL_POLL_MS = 2500;

  // ---- dependency-light helpers (resolve browser globals at call time; fall back for node) ------
  function oblEsc(value) { return (typeof DWFUI !== "undefined" && DWFUI.esc) ? DWFUI.esc(value) : String(value == null ? "" : value); }
  function oblUnitRef(id, name) {
    if (typeof fortUnitRef === "function") return fortUnitRef(id, name);
    return `<span>${oblEsc(name || (Number(id) >= 0 ? "Unit " + id : "—"))}</span>`;
  }
  function oblPretty(key) {
    if (typeof fortPrettyKey === "function") return fortPrettyKey(key);
    if (!key) return "";
    let s = String(key).replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---- PURE DATA: normalize the two wires into obligation rows (DOM-free, unit-tested) ----------

  // Noble mandates from a /nobles payload. Mirrors noblesBody's mandate semantics: `what` is the
  // material+item the mandate names, export bans carry no made/required (they are a standing ban),
  // and daysRemaining < 0 (or absent) means ongoing/no deadline. Returns [] when the payload has no
  // mandates array (old DLL, or a /nobles error) so the caller renders the honest empty state.
  function mandateObligations(noblesData) {
    const mandates = (noblesData && Array.isArray(noblesData.mandates)) ? noblesData.mandates : [];
    return mandates.map((m, i) => {
      const isExport = String(m.mode || "").toLowerCase() === "export";
      const what = [m.material, m.item].map(s => (s || "").trim()).filter(Boolean).join(" ");
      const kind = oblPretty(m.mode);
      const total = Number(m.amountTotal);
      const remaining = Number(m.amountRemaining);
      const ongoing = !(typeof m.daysRemaining === "number" && m.daysRemaining >= 0);
      let title;
      if (isExport) title = what ? `Do not export ${what}` : (kind || "Export ban");
      else if (what) title = `Make ${total || 0} ${what}`;
      else title = kind || "Mandate";
      return {
        index: i,
        unitId: Number(m.unitId),
        by: m.by || "",
        kind, isExport, what, ongoing,
        amountTotal: total, amountRemaining: remaining,
        daysRemaining: Number(m.daysRemaining),
        title,
        // made/required progress (only meaningful for production mandates, never export bans)
        progressText: isExport ? "" : `${Number.isFinite(remaining) ? remaining : 0}/${Number.isFinite(total) ? total : 0} left`,
        // time state, when served
        deadlineText: ongoing ? "Ongoing" : `${Number(m.daysRemaining)} day(s) left`,
        punishMultiple: !!m.punishMultiple,
      };
    });
  }

  // Feature-detect the B191 pending+continuing coverage. The continuing (accepted) guildhall/temple
  // obligations only exist on a server that unions plotinfo->continuing_agreement_id; an older
  // server serves pending petitions only, with no agreementCoverage and no inContinuingList flags.
  // Detect on the coverage witness first (present even when zero rows), then on the per-row flag.
  function obligationsFeatureSupported(petData) {
    if (!petData) return false;
    if (typeof petData.agreementCoverage === "string" && /continuing/i.test(petData.agreementCoverage)) return true;
    const rows = Array.isArray(petData.petitions) ? petData.petitions : [];
    return rows.some(r => typeof r.inContinuingList === "boolean");
  }

  // A petition row is a guildhall/temple obligation when its agreement carries a Location detail.
  // The wire's `summary` is the joined agreement_details_type key(s) (fort_admin.cpp
  // agreement_detail_summary), so Location agreements read "Location" there while Residency/
  // Citizenship petitions read their own type -- those belong to the Petitions panel, not here.
  function isLocationAgreement(row) {
    return !!row && /location/i.test(String(row.summary || ""));
  }

  // Guildhall/temple obligations from a /petitions payload. { supported, items }.
  //   supported=false  -> old server without continuing coverage (caller shows "needs update").
  //   items            -> Location agreements only, each with request/established state.
  // site/purpose are rendered when the server carries them; on the current server Location details
  // are not enriched (petition_detail only fills site/purpose for Citizenship/Residency), so those
  // fall back gracefully to the petitioner + state.
  function locationObligations(petData) {
    const supported = obligationsFeatureSupported(petData);
    const rows = (petData && Array.isArray(petData.petitions)) ? petData.petitions : [];
    const items = rows.filter(isLocationAgreement).map(row => {
      const isPending = !!row.pending;
      const established = row.inContinuingList === true && !isPending;
      const site = (row.site || "").trim();
      const petitioner = (row.petitioner || "").trim();
      const purpose = (row.purpose || "").trim();
      return {
        id: row.id,
        site, petitioner,
        purposeText: purpose ? oblPretty(purpose) : "",
        pending: isPending,
        established,
        inPendingList: !!row.inPendingList,
        inContinuingList: row.inContinuingList === true,
        // display primary: the most specific thing the wire gives us
        primary: site || petitioner || "Guild hall or temple",
        stateLabel: isPending ? "Requested" : (row.inContinuingList === true ? "Established" : "Accepted"),
      };
    });
    return { supported, items };
  }

  // ---- RENDER: DWFUI rows only ------------------------------------------------------------------
  function mandateRowHtml(m) {
    const progress = m.progressText ? `<span class="fort-dim">${oblEsc(m.progressText)}</span>` : "";
    const trailing = `<span class="obl-trailing">${progress}` +
      `<span class="fort-badge ${m.ongoing ? "fort-badge-open" : "fort-badge-open"}">${oblEsc(m.deadlineText)}</span></span>`;
    const subHtml = `${oblEsc(m.kind)} &middot; By ${oblUnitRef(m.unitId, m.by)}` +
      (m.punishMultiple ? ` &middot; multiple offenders punished` : "");
    return DWFUI.rowHtml({
      cls: "obl-row obl-mandate-row",
      copyCls: "obl-copy", labelCls: "fort-cell-main",
      label: m.title,
      sub: { html: subHtml, cls: "fort-dim" },
      trailing,
    });
  }

  function locationRowHtml(item) {
    const badge = item.pending ? "fort-badge-open" : "fort-badge-done";
    const trailing = `<span class="obl-trailing"><span class="fort-badge ${badge}">${oblEsc(item.stateLabel)}</span></span>`;
    const subParts = [];
    if (item.purposeText) subParts.push(oblEsc(item.purposeText));
    if (item.petitioner && item.primary !== item.petitioner) subParts.push(`Requested by ${oblEsc(item.petitioner)}`);
    const sub = subParts.length ? { html: subParts.join(" &middot; "), cls: "fort-dim" } : null;
    return DWFUI.rowHtml({
      cls: "obl-row obl-location-row",
      copyCls: "obl-copy", labelCls: "fort-cell-main",
      label: item.primary,
      sub,
      trailing,
    });
  }

  // Build the full body from both payloads (either may be an {error} object).
  function obligationsBodyHtml(noblesData, petData) {
    const mandates = mandateObligations(noblesData);
    const mandateRows = mandates.length
      ? mandates.map(mandateRowHtml).join("")
      : `<div class="info-message">${noblesData && noblesData.error
          ? "Mandates unavailable: " + oblEsc(noblesData.error) : "No active mandates."}</div>`;

    let locRows;
    if (petData && petData.error) {
      locRows = `<div class="info-message">Agreements unavailable: ${oblEsc(petData.error)}</div>`;
    } else {
      const loc = locationObligations(petData);
      if (!loc.supported) {
        locRows = `<div class="info-message">Guild hall and temple obligations need a server update (the continuing-agreement wire is not served by this host).</div>`;
      } else if (!loc.items.length) {
        locRows = `<div class="info-message">No standing guild hall or temple obligations.</div>`;
      } else {
        locRows = loc.items.map(locationRowHtml).join("");
      }
    }

    return `<div id="obligationsRoot">
      <div id="fortStatus" class="info-message fort-status" style="display:none"></div>
      <div class="fort-note">Standing fort obligations, kept current while this panel is open: demands and mandates from your nobles, plus guild hall and temple agreements requested by petitioning groups.</div>
      <div class="fort-section-title">Noble mandates</div>${mandateRows}
      <div class="fort-section-title">Guild halls &amp; temples</div>${locRows}
    </div>`;
  }

  // ---- SUMMON + LIVE REFRESH --------------------------------------------------------------------
  function oblIsOpen() {
    return typeof document !== "undefined"
      && !!document.getElementById("obligationsRoot")
      && !!clientPanel && clientPanel.classList.contains("visible");
  }

  async function oblFetch(route) {
    try {
      return await fortFetchJson(`${route}?player=${encodeURIComponent(player)}&t=${Date.now()}`);
    } catch (err) {
      return { error: err && err.message ? err.message : "unavailable" };
    }
  }

  // Re-fetch both wires and render. `force` renders even if the signature is unchanged (first open).
  async function oblRefresh(force) {
    const [nobles, petitions] = await Promise.all([oblFetch("/nobles"), oblFetch("/petitions")]);
    // Signature over only the fields the board renders, so an idle fort doesn't re-render (and
    // reset scroll) every poll.
    const sig = JSON.stringify({
      m: mandateObligations(nobles).map(x => [x.title, x.progressText, x.deadlineText, x.unitId]),
      s: obligationsFeatureSupported(petitions),
      l: locationObligations(petitions).items.map(x => [x.primary, x.stateLabel, x.purposeText, x.petitioner]),
      en: nobles && nobles.error || "", ep: petitions && petitions.error || "",
    });
    if (!force && sig === oblLastSig && oblIsOpen()) return;
    oblLastSig = sig;
    fortRenderWindow({ title: "Obligations", body: obligationsBodyHtml(nobles, petitions) });
  }

  function oblStartPolling() {
    if (oblTimer) clearInterval(oblTimer);
    oblTimer = setInterval(() => {
      if (!oblIsOpen()) { clearInterval(oblTimer); oblTimer = null; return; }
      oblRefresh(false);
    }, OBL_POLL_MS);
  }

  async function openObligationsPanel() {
    if (typeof setActiveToolbar === "function") setActiveToolbar("obligations");
    if (typeof clearBuildPlacement === "function") clearBuildPlacement(false);
    oblLastSig = null;
    fortLoadingShell("Obligations");
    await oblRefresh(true);
    oblStartPolling();
  }

  // Node export for the offline fixture test (harmless in the browser: `module` is undefined).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      mandateObligations, obligationsFeatureSupported, isLocationAgreement, locationObligations,
      mandateRowHtml, locationRowHtml, obligationsBodyHtml,
    };
  }
