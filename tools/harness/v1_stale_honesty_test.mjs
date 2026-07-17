// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// SPDX-License-Identifier: AGPL-3.0-only

// V1 STALE-HONESTY guards: two verified two-client silent-failure defects closed.
//
// The v1 release bar forbids silent failures and requires honest, closable unavailable states when
// one client acts on an entity another client already changed or removed. These are SOURCE-CONTRACT
// assertions against the two product files, plus test-the-test seeded-bad guards that reconstruct
// the OLD silent path and prove the contract regex rejects it (so the guard is load-bearing, not a
// tautology). No DOM/fetch is exercised -- offline fixtures prove the contract, not live behavior.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const infoPath = join(root, "web/js/dwf-build-info-panels.js");
const spPath = join(root, "web/js/dwf-building-zone-stockpile-panels.js");
const infoSrc = readFileSync(infoPath, "utf8");
const spSrc = readFileSync(spPath, "utf8");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name + "\n" + (error.stack || error)); }
}

// ---- BLOCKER-1: stock item sheet forbid/dump/hide toggle -------------------------------------

check("BLOCKER-1: a refused item-flag toggle re-reads the item instead of swallowing the non-ok", () => {
  // On r.ok the sheet repaints and returns; the ONLY other exits (a non-ok reply, or a thrown
  // fetch) must reach the authoritative re-read -- never the bare `} catch (_) {}` + focusPage that
  // left the stale sheet up indefinitely when another client forbade/dumped/consumed/removed it.
  assert.match(infoSrc,
    /const r = await fetch\(`\/stock-item-action\?[^`]*&action=\$\{encodeURIComponent\(action\)\}[^`]*`,[\s\S]*?if \(r\.ok\) \{ showStockItemSheet\(await r\.json\(\), \{ siblings \}\); focusPage\(\); return; \}\s*\} catch \(_\) \{\}[\s\S]*?await reReadStockItemOrUnavailable\(itemId, siblings\);/,
    "the item-toggle handler must re-read on any non-ok/failure, not swallow it");
});

check("BLOCKER-1: the re-read resolves to truth or the honest, closable 'Item unavailable' state", () => {
  // reReadStockItemOrUnavailable: a present item repaints (showStockItemSheet); a gone one
  // (non-ok / fetch throw) falls to showStockItemUnavailable -- never a silent no-op.
  assert.match(infoSrc,
    /async function reReadStockItemOrUnavailable\(id, siblings\) \{[\s\S]*?action=info[\s\S]*?if \(r\.ok\) \{ showStockItemSheet\(await r\.json\(\), \{ siblings \}\); return; \}\s*\} catch \(_\) \{\}\s*showStockItemUnavailable\(\);/);
  // The unavailable panel mirrors the accepted "Stockpile unavailable" one: native DWFUI close
  // button + honest heading, wired straight to closeSelection (the item sheet has no titlebar).
  assert.match(infoSrc,
    /function showStockItemUnavailable\(\) \{[\s\S]*?DWFUI\.artBtnHtml\(\{[\s\S]*?TOKENS\.sprites\.close[\s\S]*?stockItemGone[\s\S]*?panelContent\(selection\)\.innerHTML =\s*close \+\s*`<h1>Item unavailable<\/h1>`;[\s\S]*?querySelector\("\[data-stock-item-gone\]"\)[\s\S]*?closeSelection\(\)/);
});

check("BLOCKER-1 test-the-test: the OLD silent swallow shape is rejected by the guard", () => {
  // Reconstruct the shipped-before source: the failure branch was `if (r.ok) showStockItemSheet(...)`
  // then `} catch (_) {}` then `focusPage();` with NO re-read. The guard above must NOT match it.
  const seededSilent = infoSrc.replace(
    /if \(r\.ok\) \{ showStockItemSheet\(await r\.json\(\), \{ siblings \}\); focusPage\(\); return; \}\s*\} catch \(_\) \{\}[\s\S]*?await reReadStockItemOrUnavailable\(itemId, siblings\);\s*\n\s*focusPage\(\);/,
    'if (r.ok) showStockItemSheet(await r.json(), { siblings });\n        } catch (_) {}\n        focusPage();');
  assert.notStrictEqual(seededSilent, infoSrc, "the seed must actually revert the toggle handler");
  assert.doesNotMatch(seededSilent, /await reReadStockItemOrUnavailable\(itemId, siblings\)/,
    "the reverted (silent) source must have no re-read at all -- proving the guard discriminates");
  assert.doesNotMatch(seededSilent,
    /if \(r\.ok\) \{ showStockItemSheet\(await r\.json\(\), \{ siblings \}\); focusPage\(\); return; \}\s*\} catch \(_\) \{\}[\s\S]*?await reReadStockItemOrUnavailable/);
});

// ---- BLOCKER-2: stockpile settings editor (pile or hauling stop) ------------------------------

check("BLOCKER-2: a refused item toggle surfaces the honest unavailable state, not stale cache", () => {
  // postStockpile returns null on non-ok/failure. The guard must sit BETWEEN the write and the
  // optimistic `if (updated && it)` cache mutation, and bail out before the trailing renderSpe*.
  assert.match(spSrc,
    /const updated = await postStockpile\(speUrl\("toggle-item"[\s\S]*?const it = items\.find\([\s\S]*?if \(!updated\) \{ speSurfaceUnavailable\(\); return; \}\s*if \(updated && it\) \{/);
  // ...and the delegated dispatcher routes a pile to its re-read (openStockpilePanel -> intact panel
  // or "Stockpile unavailable") and a hauling stop to its caller's re-read hook.
  assert.match(spSrc,
    /function speSurfaceUnavailable\(\) \{[\s\S]*?closeSpEditor\(\);[\s\S]*?if \(wasStop\) \{ if \(typeof onChange === "function"\) onChange\(\); \}\s*else if \(pileId != null\) openStockpilePanel\(pileId\);/);
});

check("BLOCKER-2: a settings-snapshot 404/failure surfaces unavailable at open and after a preset", () => {
  // speFetchSnapshot returns false on !r.ok/404. Both callers that could leave a stale/loading
  // editor up must act on that false (once they confirm they are still the current open sequence).
  assert.match(spSrc,
    /const ok = await speFetchSnapshot\(seq\);\s*if \(seq !== speSeq\) return;[\s\S]*?if \(!ok\) \{ speSurfaceUnavailable\(\); return; \}[\s\S]*?loadSpGroups\(speDefaultCat\(\)\);/,
    "the open path must surface unavailable when the first snapshot 404s");
  assert.match(spSrc,
    /if \(key === spEditCat\) \{[\s\S]*?const ok = await speFetchSnapshot\(seq\);\s*if \(seq !== speSeq\) return;[\s\S]*?if \(!ok\) \{ speSurfaceUnavailable\(\); return; \}\s*await loadSpGroups\(spEditCat\);/,
    "the category-preset path must surface unavailable when its snapshot re-fetch 404s");
});

check("BLOCKER-2 test-the-test: the OLD silent fall-through shapes are rejected by the guards", () => {
  // Item toggle: strip the `if (!updated)` guard -> a failed toggle falls through to renderSpe* on
  // stale cache. The guard regex must stop matching.
  const seededItem = spSrc.replace(/\s*if \(!updated\) \{ speSurfaceUnavailable\(\); return; \}/, "");
  assert.notStrictEqual(seededItem, spSrc, "the seed must actually remove the item-toggle guard");
  assert.doesNotMatch(seededItem,
    /const it = items\.find\([\s\S]*?if \(!updated\) \{ speSurfaceUnavailable\(\); return; \}\s*if \(updated && it\) \{/,
    "with the guard gone a refused toggle again silently re-renders -- proving the guard is load-bearing");

  // Open path: revert to the old `if (!await speFetchSnapshot(seq) || seq !== speSeq) return;` that
  // silently left the loading frame up when the pile was already gone.
  const seededOpen = spSrc.replace(
    /const ok = await speFetchSnapshot\(seq\);\s*if \(seq !== speSeq\) return;[^\n]*\n\s*if \(!ok\) \{ speSurfaceUnavailable\(\); return; \}[^\n]*\n\s*loadSpGroups\(speDefaultCat\(\)\);/,
    "if (!await speFetchSnapshot(seq) || seq !== speSeq) return;\n      loadSpGroups(speDefaultCat());");
  assert.notStrictEqual(seededOpen, spSrc, "the seed must actually revert the open-path snapshot handling");
  assert.doesNotMatch(seededOpen,
    /const ok = await speFetchSnapshot\(seq\);\s*if \(seq !== speSeq\) return;[\s\S]*?if \(!ok\) \{ speSurfaceUnavailable\(\); return; \}\s*loadSpGroups\(speDefaultCat\(\)\);/);
});

// ---- Scope guard: the previously-accepted-fix regions stay untouched -------------------------

check("scope: the accepted stockpile delete-honesty + 'Stockpile unavailable' panel are intact", () => {
  // These were NOT ours to change; assert they still read exactly as the accepted fix left them so
  // a stray edit to the shared file would trip here rather than in the delete-honesty suite alone.
  assert.match(spSrc,
    /if \(removed\) \{ spnCloseStorage\(\); closeSelection\(\); \}\s*else openStockpilePanel\(id\)/);
  assert.match(spSrc,
    /const close = DWFUI\.artBtnHtml\(\{[\s\S]*?TOKENS\.sprites\.close[\s\S]*?spClose[\s\S]*?Stockpile unavailable/);
});

if (failed) process.exit(1);
console.log("v1_stale_honesty_test: PASS");
