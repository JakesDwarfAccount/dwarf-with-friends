// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// STOCKPILE-UI fixture coverage: custom-editor mutations refresh Stores automatically.
// B115 has a documented chooser-branch handoff in the accompanying report.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const panelPath = join(root, "web/js/dwf-building-zone-stockpile-panels.js");
const panelSource = readFileSync(panelPath, "utf8");
const require = createRequire(import.meta.url);
// The panels module resolves these at call time (browser: earlier <script>s). The Wave-5 chrome
// builders below are DWFUI calls, so the component layer must be on the global exactly as the page
// provides it -- same bootstrap as b174_wsrebuild_client_test.
globalThis.escapeHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
globalThis.dfTokenMatch = (name, q) =>
  String(name || "").toLowerCase().includes(String(q || "").toLowerCase());
globalThis.DWFUI = require(join(root, "web/js/dwf-ui-components.js"));
const panel = require(panelPath);

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

check("individual custom-item mutation refreshes the Stores summary only after success", () => {
  // post-B174 shape: the refresh lives inside the success branch (updated && it).
  // B231: the editor now drives EITHER a stockpile or a hauling stop (a df::hauling_stop's
  // `settings` is the same df::stockpile_settings struct), so the concrete
  // refreshStockpileSummary(spEditId) call moved behind speRefreshSubject(), which dispatches on
  // the target. What this cell guards -- the refresh happens ONLY inside the success branch -- is
  // unchanged, so it is asserted against the dispatcher rather than the pile-specific callee.
  assert.match(panelSource, /const updated = await postStockpile[\s\S]*?if \(updated && it\) \{[\s\S]*?await speRefreshSubject\(\)/);
  // ...and the dispatcher still refreshes the Stores summary for the stockpile case.
  assert.match(panelSource, /async function speRefreshSubject\(\)[\s\S]*?await refreshStockpileSummary\(spEditId\)/);
});

check("category and group All/None mutations refresh the Stores summary once", () => {
  // post-B174 shape: cache updates gate on batch success; the single summary
  // refresh is centralized in speAfterMutation()
  assert.match(panelSource, /const results = await Promise\.all\(groups\.map\(group => postStockpile[\s\S]*?if \(stockpileMutationSucceeded\(results\)\)/);
  assert.match(panelSource, /async function speAfterMutation\(\) \{[\s\S]*?await speRefreshSubject\(\)/);
  assert.match(panelSource, /if \(column === "categories"\) \{[\s\S]*?preset=\$\{on \? "all" : "none"\}/);
});

check("manual generic refresh is repurposed to links", () => {
  // WAVE-5: this pinned `data-sp-refresh-links title="Reload linked buildings">Refresh links` --
  // the hook, the title and the LABEL TEXT byte-adjacent, in the SOURCE. That is a fact about
  // hand-built markup, not about the product: every DWFUI button renders its label through
  // bitmapTextHtml, so the label can never again sit immediately after the `>`, and the assertion
  // silently forbade this button from EVER adopting the layer. Re-expressed against the EMITTED
  // markup as the three things that actually matter -- the HOOK, the LABEL, and the ROUTE -- plus
  // the original negative (the old generic `Refresh` is gone). Strictly stronger: it now also
  // proves the control is the native plaque and that the click still re-opens the panel.
  const row = panel.spModeRowHtml();
  assert.match(row, /class="dwfui-plaque sp-mode-button"/);   // native plaque + the cls hook the CSS pins
  assert.match(row, /data-sp-refresh-links/);                // THE HOOK
  assert.ok(row.replace(/<[^>]*>/g, "").includes("Refresh links"), "the plaque reads `Refresh links`");
  // THE ROUTE: the hook still re-opens the panel (which re-fetches /stockpile-info).
  assert.match(panelSource,
    /\[data-sp-refresh-links\]"\)\.addEventListener\("click", event => \{[\s\S]{0,120}openStockpilePanel\(id\)/);
  assert.doesNotMatch(panelSource, /data-sp-refresh>Refresh/);
});

check("test-the-test: failed mutations do not schedule a summary refresh", () => {
  assert.equal(panel.stockpileMutationSucceeded([null, undefined]), false);
  assert.equal(panel.stockpileMutationSucceeded(null), false);
});

check("successful mutation result is recognized across single and batch routes", () => {
  assert.equal(panel.stockpileMutationSucceeded({ ok: true }), true);
  assert.equal(panel.stockpileMutationSucceeded([null, { ok: true }]), true);
});

// ---- WAVE 5 GATE C: the stockpile panel's chrome is built by DWFUI, not by hand ----------------
// These assert on the EMITTED MARKUP of the exported builders, not on the source text. A source
// regex once reported "0 queued" while 467 controls bypassed the layer; if a builder is claimed,
// its output must carry the builder's own class.

check("PB-10: the title bar carries `sp-header`, the class core's adoptHeadSel has always asked for", () => {
  // dwf-core.js:1413 lists `.sp-header` in #selection's adoptHeadSel and NOTHING emitted it,
  // so PanelFrame head adoption failed and the generated `.pf-head` bar stacked above the native
  // title box. This is the guarantee that it cannot silently regress: emit the class, or adoption
  // breaks and the non-native bar comes back.
  // headerHtml's `cls` REPLACES the `dwfui-head` base (components.js:2165) -- the same contract the
  // workshop head uses (`cls: "bld-head ws-head"`). What must hold is that the head element the
  // panel emits is the one core's adoptHeadSel names, and that `.spn-titlebar`'s CSS still lands.
  const html = panel.spnTitlebarHtml({ name: "Food pile" }, "Stockpile #10");
  assert.match(html, /^<div class="sp-header spn-titlebar">/);
  const core = readFileSync(join(root, "web/js/dwf-core.js"), "utf8");
  assert.match(core, /adoptHeadSel:[^\n]*\.sp-header/);
});

check("the title bar is DWFUI.headerHtml and keeps every rename hook", () => {
  const html = panel.spnTitlebarHtml({ name: "Food pile" }, "Stockpile #10");
  assert.match(html, /class="spn-titlebox"/);          // the cls hook the CSS pins
  assert.match(html, /class="spn-title" data-spn-title/);
  assert.match(html, /class="spn-name sp-name"/);      // free-text rename superset -- /stockpile-rename
  assert.match(html, /data-sp-rename/);
});

check("the quill is native art (UNIT_SHEET_CUSTOMIZE) and draws NO second frame", () => {
  const html = panel.spnTitlebarHtml({ name: "x" }, "x");
  assert.match(html, /class="dwfui-art-btn spn-quill"/);
  assert.match(html, /data-dwfui-sprite="UNIT_SHEET_CUSTOMIZE"/);
  // a self-framed native sprite gets NO generic box -- the CSS keys on both attributes
  assert.match(html, /data-dwfui-native-art="true" data-dwfui-self-framed="true"/);
});

check("native has NO close X on this panel: the title bar emits none", () => {
  // The X that remains is `.unit-close-button`, host-anchored OUTSIDE the head, and it is what
  // panelframe.js:483 demands before it will adopt the head at all (stockpile-panel is not in
  // core's ESC_ONLY_SELECTION_VARIANTS). The HEAD itself must not grow a second one.
  const html = panel.spnTitlebarHtml({ name: "x" }, "x");
  assert.doesNotMatch(html, /bld-x|pf-x|data-bld-close/);
});

check("links-pane targets are the native table row + native plaques, wires unchanged", () => {
  const row = panel.spLinkTargetRowHtml(
    { id: 7, name: "Craftsdwarf's workshop", kind: "workshop", pos: { x: 1, y: 2, z: 3 } },
    new Set([7]), new Set());
  assert.match(row, /class="dwfui-row sp-target-row dwfui-row--table"/);
  assert.match(row, /class="dwfui-plaque green sp-link-button active"/);   // Give is on
  assert.match(row, /data-sp-link-mode="give" data-sp-link-target="7" data-on="0"/);
  assert.match(row, /data-sp-link-mode="take" data-sp-link-target="7" data-on="1"/);
  assert.match(row, /class="sp-target-meta"/);
});

check("the five tool tiles are DWFUI on DF's own art, self-framed, wires unchanged", () => {
  const armed = panel.spnToolsHtml({ linksOnly: false }, true);
  // 1. every tile carries a REAL interface_map token -- not the frozen --spa-tool-* data-URI.
  for (const token of ["STOCKPILE_REPAINT", "STOCKPILE_REMOVE_EXISTING", "STOCKPILE_TAKE_FROM_ANYWHERE",
    "STOCKPILE_SET_CONNECTIONS", "STOCKPILE_TOOL_SETTINGS"])
    assert.match(armed, new RegExp(`data-dwfui-sprite="${token}"`), token);
  // 2. NOT ONE of them draws a generic box: DF's frame is baked into the art (the double-frame bug).
  assert.equal((armed.match(/data-dwfui-self-framed="true"/g) || []).length, 10);  // 5 buttons + 5 icons
  assert.doesNotMatch(armed, /<button(?![^>]*data-dwfui-native-art)/);   // no hand-built button survives
  // 3. every wire the handlers read is unchanged.
  for (const hook of ["data-sp-repaint", "data-sp-remove", "data-sp-links-only",
    "data-spn-links-toggle", "data-spn-storage-open"])
    assert.ok(armed.includes(hook), hook);
  // 4. repaint is a LATCH (a real armed state), not a plain button.
  assert.match(armed, /class="dwfui-latch spn-tool spn-tool-paint armed on"[^>]*aria-pressed="true"/);
  assert.match(panel.spnToolsHtml({ linksOnly: false }, false), /class="dwfui-latch spn-tool spn-tool-paint"[^>]*aria-pressed="false"/);
  // 5. links-only is the two-state native mode: a DISTINCT sprite per state, and the wire posts the
  //    value it is about to become.
  assert.match(armed, /data-sp-links-only="1"/);
  const only = panel.spnToolsHtml({ linksOnly: true }, false);
  assert.match(only, /data-dwfui-sprite="STOCKPILE_TAKE_FROM_LINKS_ONLY"/);
  assert.match(only, /data-sp-links-only="0"/);
  // 6. native leaves the bottom-left cell EMPTY (B143-1) -- it omits, it does not blank.
  assert.match(armed, /<span class="spn-tool-spacer"><\/span>/);
});

check("the 20 type tiles are DWFUI.rowHtml, and the icon cell and every wire survive", () => {
  const html = panel.spnTypeGridHtml({ food: true });
  assert.equal((html.match(/class="dwfui-row spn-type/g) || []).length, 20);
  assert.match(html, /<button class="dwfui-row spn-type active" title="Food" data-sp-cat="food">/);
  // the two-layer icon cell (category glyph + green selected strip) is intact
  assert.match(html, /<span class="spn-ticon on" style="background-position:0 -315px, 0 0"><\/span>/);
  // the label goes through bitmap text now -- and keeps the class the CSS pins, so it still WRAPS
  assert.match(html, /class="spn-tlab"/);
  assert.ok(html.replace(/<[^>]*>/g, "").includes("Bars and Blocks"));
  // every category still dispatches /stockpile-set through [data-sp-cat]
  for (const [, key] of panel.SPN_TYPES) assert.ok(html.includes(`data-sp-cat="${key}"`), key);
});

check("PB-10: EXACTLY ONE Done in the storage window, and it is the native plaque", () => {
  // The old `.spn-done` was an empty <button> whose face was --spa-plaque-done, i.e. an image with
  // the word "Done" baked in. sideWindowHtml emits its OWN red Done; adopting it here while keeping
  // .spn-done is precisely how the doubled Done the owner reported gets CREATED. One Done, one builder.
  assert.match(panelSource, /DWFUI\.plaqueBtnHtml\(\{\s*label: "Done", tone: "red", cls: "spn-done"/);
  assert.doesNotMatch(panelSource, /DWFUI\.sideWindowHtml[\s\S]{0,400}spn-done/);
  // the storage window emits exactly ONE close/confirm control, and it is that plaque
  const win = panelSource.slice(panelSource.indexOf("function spnEnsureStorageWin"),
    panelSource.indexOf("function spnRenderStorage"));
  const emit = win.slice(win.indexOf("win.innerHTML"));
  assert.equal((emit.match(/data-spn-storage-done|dwfuiSidewinDone/g) || []).length, 1);
  assert.doesNotMatch(emit, /<button/);   // no hand-built button survives in the storage head
});

check("deleting a stockpile is honest: it confirms the remove, and NEVER closes on a silent failure", () => {
  // The server answers a failed remove (pile already gone, un-droppable building) with HTTP 200
  // {"ok":false} -- so r.ok alone is not proof. The handler must read the JSON, close ONLY on a
  // real removal, and RE-READ otherwise (a still-present pile reappears; an already-gone one 404s
  // to the "unavailable" state) -- the same honest shape the zone [data-zone-act] remove uses.
  assert.match(panelSource,
    /\[data-sp-remove\]"\)\.addEventListener\("click", async event => \{[\s\S]*?\/stockpile-remove\?id=\$\{id\}[\s\S]*?removed = !d \|\| d\.ok !== false[\s\S]*?if \(removed\) \{ spnCloseStorage\(\); closeSelection\(\); \}\s*else openStockpilePanel\(id\)/);
  // test-the-test: the old unconditional close-on-any-response shape must be gone. If it comes
  // back, the panel would vanish as if the pile were removed even when the host refused -- exactly
  // the "unsupported action fails silently" class this guards against.
  assert.doesNotMatch(panelSource,
    /await postStockpile\(`\/stockpile-remove\?id=\$\{id\}`\);\s*spnCloseStorage\(\); closeSelection\(\);/);
});

check("the 'Stockpile unavailable' error state offers an explicit way out (not just Esc)", () => {
  // A headless #selection panel with no visible close reads as a dead-end. The catch state emits
  // the same native DWFUI close button the loaded panel has, wired straight to closeSelection (no
  // PanelFrame head-adoption dependency -- there is no titlebar here).
  assert.match(panelSource,
    /const close = DWFUI\.artBtnHtml\(\{[\s\S]*?TOKENS\.sprites\.close[\s\S]*?spClose[\s\S]*?panelContent\(selection\)\.innerHTML =\s*close \+[\s\S]*?Stockpile unavailable[\s\S]*?selection\.querySelector\("\[data-sp-close\]"\)[\s\S]*?closeSelection\(\)/);
  assert.equal((panelSource.match(/<button class="unit-close-button" data-sp-close/g) || []).length, 1,
    "the new error-state affordance must not grow the one grandfathered raw close button");
});

if (failed) process.exit(1);
console.log("stockpile_ui_wave_test: PASS");
