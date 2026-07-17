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

// WT07 panel framework. Persistence keys are stable contract: dwf.panelLayout.v1 and
// dwf.panelFrame.enabled. Panel keys must never be renamed once a migration ships.
(function (root) {
  "use strict";

  var LAYOUT_KEY = "dwf.panelLayout.v1";
  var ENABLED_KEY = "dwf.panelFrame.enabled";
  var VERSION = 1;
  var PF_Z_BASE = 60;
  var PF_Z_MAX = 89;
  var HEAD_H = 22;
  var registry = Object.create(null);
  var order = [];
  var escStack = [];
  var attached = Object.create(null);
  var saveTimer = 0;
  var layoutPanels = null;
  // Per-(variant-)key "user positioned this" flags. contentHost panels (#clientPanel/#selection)
  // persist a variant's geometry ONLY after the user drags/resizes it -- an untouched variant keeps
  // its CSS/media-query docking so we never freeze a responsive layout into stale inline styles.
  var dirty = Object.create(null);
  var hasDom = !!(root.document && root.document.createElement);

  function finite(n) { return typeof n === "number" && Number.isFinite(n); }
  function round(n) { return Math.round(n); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // Pure core: no DOM or storage. The harness drives this object directly.
  function validEntry(entry) {
    return !!entry && typeof entry === "object" &&
      (entry.anchor === "tl" || entry.anchor === "tr" || entry.anchor === "bl" || entry.anchor === "br") &&
      finite(entry.x) && finite(entry.y) && finite(entry.w) && finite(entry.h) &&
      entry.w >= 0 && entry.h >= 0 && (entry.open == null || typeof entry.open === "boolean");
  }

  function decodeLayout(raw, knownKeys) {
    var parsed;
    try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return { v: VERSION, panels: {} }; }
    if (!parsed || parsed.v !== VERSION || !parsed.panels || typeof parsed.panels !== "object" || Array.isArray(parsed.panels))
      return { v: VERSION, panels: {} };
    var panels = {};
    Object.keys(parsed.panels).forEach(function (key) {
      if (knownKeys && !knownKeys[key]) return;
      var item = parsed.panels[key];
      if (!validEntry(item)) return;
      panels[key] = {
        anchor: item.anchor, x: round(item.x), y: round(item.y), w: round(item.w), h: round(item.h),
        open: item.open == null ? true : item.open,
      };
    });
    return { v: VERSION, panels: panels };
  }

  function encodeLayout(panels) {
    var clean = {};
    Object.keys(panels || {}).forEach(function (key) {
      var item = panels[key];
      if (!validEntry(item)) return;
      clean[key] = {
        anchor: item.anchor, x: round(item.x), y: round(item.y), w: round(item.w), h: round(item.h),
        open: item.open == null ? true : item.open,
      };
    });
    return JSON.stringify({ v: VERSION, panels: clean });
  }

  function anchorForRect(rect, viewport) {
    var left = rect.x, top = rect.y, w = rect.w, h = rect.h;
    var right = viewport.w - (left + w);
    var bottom = viewport.h - (top + h);
    var horizontal = left + w / 2 <= viewport.w / 2 ? "l" : "r";
    var vertical = top + h / 2 <= viewport.h / 2 ? "t" : "b";
    return {
      anchor: vertical + horizontal,
      x: round(horizontal === "l" ? left : right),
      y: round(vertical === "t" ? top : bottom),
      w: round(w), h: round(h),
    };
  }

  function rectFromEntry(entry, viewport) {
    var x = entry.anchor.charAt(1) === "l" ? entry.x : viewport.w - entry.x - entry.w;
    var y = entry.anchor.charAt(0) === "t" ? entry.y : viewport.h - entry.y - entry.h;
    return { x: x, y: y, w: entry.w, h: entry.h };
  }

  // CSS chrome geometry expressed in the target panel's coordinate space. Keeping it as an inset
  // makes the resize/open solver deterministic even before the DOM has painted; chromeInsets()
  // below replaces these fallbacks with measured live rectangles. PANEL-GEOMETRY-2: there is NO
  // right fallback -- #rightHud and the topbar's right controls are a ~200px-tall TOP-RIGHT corner
  // cluster, not a column. B129 reserved their width for the full screen height, so panels stopped
  // (and, with the old shrinking clampRect, culled) 208-212 visual px left of the screen edge.
  // The boundary users see at panel height is the viewport edge; the work-area right edge is too.
  function chromeInsetsFor(visualWidth, scale, panelZoom) {
    scale = finite(scale) && scale > 0 ? scale : 1;
    panelZoom = finite(panelZoom) && panelZoom > 0 ? panelZoom : 1;
    return { top: 48 * scale / panelZoom, right: 0,
      bottom: 44 * scale / panelZoom, left: 0 };
  }

  function workArea(viewport, limits) {
    var left = limits && finite(limits.left) ? Math.max(0, limits.left) : 0;
    var rightInset = limits && finite(limits.right) ? Math.max(0, limits.right) : 0;
    var top = limits && finite(limits.top) ? Math.max(0, limits.top) : 48;
    var bottomInset = limits && finite(limits.bottom) ? Math.max(0, limits.bottom) : 44;
    var right = Math.max(left, viewport.w - rightInset);
    var bottom = Math.max(top, viewport.h - bottomInset);
    return { left: left, top: top, right: right, bottom: bottom,
      w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  }

  // Open, restore, drag, and window-resize all use the same strict work-area clamp: the SIZE is
  // preserved (shrunk only when the panel is genuinely larger than the work area) and the POSITION
  // stops at the boundary. PANEL-GEOMETRY-2: the previous version floored w/h at limits.minW/minH
  // and let x advance past the fit point, so dragging a panel toward an edge SHRANK it in place --
  // the frame stayed put while overflow:hidden culled the content. Minimum sizes are an interactive-
  // resize contract (clampResizeRect) and a restore floor, never a drag/open side effect.
  function clampRect(rect, viewport, limits) {
    var area = workArea(viewport, limits);
    var w = Math.max(0, Math.min(rect.w, area.w));
    var h = Math.max(0, Math.min(rect.h, area.h));
    return {
      x: clamp(rect.x, area.left, Math.max(area.left, area.right - w)),
      y: clamp(rect.y, area.top, Math.max(area.top, area.bottom - h)),
      w: w, h: h,
    };
  }

  function dragByVisual(start, clientStart, clientNow, zoom) {
    return {
      x: start.x + (clientNow.x - clientStart.x) / zoom,
      y: start.y + (clientNow.y - clientStart.y) / zoom,
      w: start.w, h: start.h,
    };
  }

  function resizeByVisual(start, clientStart, clientNow, zoom, direction) {
    var dx = (clientNow.x - clientStart.x) / zoom;
    var dy = (clientNow.y - clientStart.y) / zoom;
    var rect = { x: start.x, y: start.y, w: start.w, h: start.h };
    if (direction.indexOf("w") >= 0) { rect.x += dx; rect.w -= dx; }
    if (direction.indexOf("e") >= 0) rect.w += dx;
    if (direction.indexOf("n") >= 0) { rect.y += dy; rect.h -= dy; }
    if (direction.indexOf("s") >= 0) rect.h += dy;
    return rect;
  }

  // Clamp a directional resize while keeping the opposite edge fixed. A plain clampRect(raw)
  // would meet the size floor but make NW/NE/SW handles jump when that floor is reached.
  function clampResizeRect(start, proposed, direction, viewport, limits) {
    var area = workArea(viewport, limits);
    var minW = Math.min(limits && finite(limits.minW) ? limits.minW : 0, area.w);
    var minH = Math.min(limits && finite(limits.minH) ? limits.minH : 0, area.h);
    var rect = { x: start.x, y: start.y, w: start.w, h: start.h };
    if (direction.indexOf("w") >= 0) {
      var fixedRight = clamp(start.x + start.w, area.left + minW, area.right);
      rect.w = clamp(proposed.w, minW, fixedRight - area.left);
      rect.x = fixedRight - rect.w;
    } else if (direction.indexOf("e") >= 0) {
      rect.x = clamp(start.x, area.left, Math.max(area.left, area.right - minW));
      rect.w = clamp(proposed.w, minW, area.right - rect.x);
    }
    if (direction.indexOf("n") >= 0) {
      var fixedBottom = clamp(start.y + start.h, area.top + minH, area.bottom);
      rect.h = clamp(proposed.h, minH, fixedBottom - area.top);
      rect.y = fixedBottom - rect.h;
    } else if (direction.indexOf("s") >= 0) {
      rect.y = clamp(start.y, area.top, Math.max(area.top, area.bottom - minH));
      rect.h = clamp(proposed.h, minH, area.bottom - rect.y);
    }
    return clampRect(rect, viewport, limits);
  }

  function effectiveZoomPure(node, styleFor) {
    if (node && finite(node.currentCSSZoom) && node.currentCSSZoom > 0) return node.currentCSSZoom;
    var zoom = 1;
    for (var n = node; n; n = n.parentElement) {
      var style = styleFor ? styleFor(n) : n && n.style;
      var value = style && parseFloat(style.zoom);
      zoom *= finite(value) && value > 0 ? value : 1;
    }
    return zoom;
  }

  function focusStack(stack, key) {
    var next = (stack || []).filter(function (item) { return item !== key; });
    next.push(key);
    return next.slice(-1 * (PF_Z_MAX - PF_Z_BASE + 1));
  }

  function zForStack(stack) {
    var z = {};
    (stack || []).forEach(function (key, i) { z[key] = PF_Z_BASE + i; });
    return z;
  }

  function cssSizeForRect(size, boxSizing, extras) {
    return boxSizing === "border-box" ? size : Math.max(0, size - extras);
  }

  // Pure model for the scroll-fill contract. CSS performs the live layout; this helper pins the
  // invariant that a resize changes the designated scroll region by the same delta once the
  // panel's non-scrolling chrome has been reserved.
  function scrollFillHeight(panelHeight, reservedHeight) {
    return Math.max(0, Number(panelHeight) - Number(reservedHeight || 0));
  }

  // Content-host variant key: #clientPanel and #selection are ONE element that many writer modules
  // re-skin (build menu, squads, unit sheet, stockpile, zone editor...). Each skin is a variant
  // class on the host; per-variant persistence keeps a moved unit sheet from dragging the stockpile
  // panel with it. `priority` is most-specific-first so e.g. a `building-panel zone-panel` host maps
  // to "zone-panel", not the shared "building-panel" base.
  function primaryVariant(classNames, priority) {
    var set = Object.create(null);
    String(classNames || "").split(/\s+/).forEach(function (c) { if (c) set[c] = true; });
    for (var i = 0; i < (priority || []).length; i++) if (set[priority[i]]) return priority[i];
    return "default";
  }

  var PURE = {
    LAYOUT_KEY: LAYOUT_KEY, ENABLED_KEY: ENABLED_KEY, VERSION: VERSION,
    PF_Z_BASE: PF_Z_BASE, PF_Z_MAX: PF_Z_MAX,
    validEntry: validEntry, decodeLayout: decodeLayout, encodeLayout: encodeLayout,
    anchorForRect: anchorForRect, rectFromEntry: rectFromEntry, clampRect: clampRect,
    chromeInsetsFor: chromeInsetsFor, workArea: workArea,
    dragByVisual: dragByVisual, resizeByVisual: resizeByVisual, clampResizeRect: clampResizeRect,
    effectiveZoom: effectiveZoomPure,
    focusStack: focusStack, zForStack: zForStack, cssSizeForRect: cssSizeForRect,
    primaryVariant: primaryVariant, scrollFillHeight: scrollFillHeight,
    closableFor: closableFor,          // WAVE 4: variant-aware close (declared below; hoisted)
    dormant: function (enabled, value, apply) { return enabled ? apply(value) : value; },
  };

  function storageGet(key) { try { return root.localStorage.getItem(key); } catch (_) { return null; } }
  function storageSet(key, value) { try { root.localStorage.setItem(key, value); } catch (_) {} }
  function storageRemove(key) { try { root.localStorage.removeItem(key); } catch (_) {} }
  function enabled() { return storageGet(ENABLED_KEY) !== "0"; }

  function styleFor(el) { return root.getComputedStyle ? root.getComputedStyle(el) : el.style; }
  function effectiveZoom(el) { return effectiveZoomPure(el, styleFor); }
  function viewportFor(el) {
    var z = effectiveZoom(el);
    return { w: root.innerWidth / z, h: root.innerHeight / z, z: z };
  }
  function uiScale() {
    try { if (root.DWFUIScale) return root.DWFUIScale.get(); } catch (_) {}
    var docEl = root.document && root.document.documentElement;
    var style = docEl && root.getComputedStyle && root.getComputedStyle(docEl);
    var value = style && style.getPropertyValue ? style.getPropertyValue("--ui-scale") : 1;
    value = parseFloat(value);
    return finite(value) && value > 0 ? value : 1;
  }
  function chromeInsets(el) {
    var z = effectiveZoom(el);
    var inset = chromeInsetsFor(root.innerWidth, uiScale(), z);
    function measured(id) {
      var node = root.document && root.document.getElementById ? root.document.getElementById(id) : null;
      if (!node || !visible(node) || !node.getBoundingClientRect) return null;
      var rect = node.getBoundingClientRect();
      return finite(rect.left) && finite(rect.top) && finite(rect.right) && finite(rect.bottom) ? rect : null;
    }
    // The topbar can exceed its 48px minimum when flex-wrap activates. Measure that live height.
    var topbar = measured("topbar");
    if (topbar) inset.top = Math.max(inset.top, topbar.bottom / z);
    // Reserve a right column only if the right HUD genuinely IS one. Measured live it is a 208x204
    // corner cluster under the topbar (z 8980, far above the 60..89 panel band), so panels may
    // pass under its lower edge exactly as the pre-B129 CSS docks (hotkeys right:0) were designed.
    var rightHud = measured("rightHud");
    if (rightHud && rightHud.height >= root.innerHeight * 0.6)
      inset.right = Math.max(inset.right, (root.innerWidth - rightHud.left) / z);
    var bottomBar = measured("bottomBar");
    if (bottomBar) inset.bottom = Math.max(inset.bottom, (root.innerHeight - bottomBar.top) / z);
    return inset;
  }
  function visible(el) { return !!el && styleFor(el).display !== "none"; }
  function specEl(spec) { try { return spec.el && spec.el(); } catch (_) { return null; } }

  // Persistence key. Falls back to the stable spec.key; contentHost panels resolve a per-variant
  // key from the live host class so geometry is remembered per skin. Identity (focus/z/escStack/
  // attached) always stays keyed on spec.key -- only the layout MAP is variant-scoped.
  function layoutKeyFor(spec, el) {
    if (spec && spec.variantKey && el) { try { var k = spec.variantKey(el); if (k) return k; } catch (_) {} }
    return spec.key;
  }
  function isChrome(node) {
    return node && node.nodeType === 1 && node.classList &&
      (node.classList.contains("pf-head") || node.classList.contains("pf-grip") ||
       node.classList.contains("pf-edge-e") || node.classList.contains("pf-edge-s"));
  }
  // The content-wrapper seam. Every writer that used to do `host.innerHTML = ...` now targets
  // contentEl(host) instead, so the persistent framework header + grips (host children) survive a
  // wholesale re-render. `.pf-content` is display:contents (dwf.css) => zero layout change vs
  // writing the host directly, and descendant CSS selectors (#selection .kind, etc.) still match.
  function contentEl(host) {
    if (!host || host.nodeType !== 1) return host;
    var wrap = null, kids = host.children;
    for (var i = 0; i < kids.length; i++) if (kids[i].classList && kids[i].classList.contains("pf-content")) { wrap = kids[i]; break; }
    if (!wrap) {
      wrap = root.document.createElement("div");
      wrap.className = "pf-content";
      var move = [];
      for (var j = 0; j < host.childNodes.length; j++) { var n = host.childNodes[j]; if (!isChrome(n)) move.push(n); }
      for (var m = 0; m < move.length; m++) wrap.appendChild(move[m]);
      host.appendChild(wrap);
    }
    return wrap;
  }

  // B167 scroll-fill contract. A registration declares fillSel as a selector, or as a
  // most-specific-first array of selectors. The first selector with live matches wins; a comma
  // selector may designate parallel scroll regions (build columns, farm crop/seed lists). The
  // framework marks the target plus every ancestor up to the panel box, and CSS supplies the
  // flex/min-height/overflow contract. Reconcile after every content-host render because the
  // active scrollbox changes with the skin and with sub-views inside a skin.
  function clearFillMarks(el) {
    if (!el || !el.classList) return;
    // ESC-HANG root cause: this remove was UNGUARDED. Per the DOM spec, classList.remove on an
    // element that has a class attribute re-sets the attribute even when the token is absent, so
    // the host's own class observer re-fired reconcileFill's no-targets branch forever -- a pure
    // microtask loop and a dead tab (B172 Esc close, B173 stockpile open). Every reconciler must
    // be convergent: a settled DOM passes through with ZERO mutations.
    if (el.classList.contains("pf-fill-host")) el.classList.remove("pf-fill-host");
    if (!el.querySelectorAll) return;
    el.querySelectorAll(".pf-fill-chain,.pf-fill-scroll").forEach(function (node) {
      node.classList.remove("pf-fill-chain");
      node.classList.remove("pf-fill-scroll");
    });
  }
  function fillTargets(spec, el) {
    if (!spec || !spec.fillSel || !el || !el.querySelectorAll) return [];
    var choice;
    try { choice = typeof spec.fillSel === "function" ? spec.fillSel(el) : spec.fillSel; }
    catch (_) { return []; }
    var selectors = Array.isArray(choice) ? choice : [choice];
    for (var i = 0; i < selectors.length; i++) {
      if (typeof selectors[i] !== "string" || !selectors[i]) continue;
      try {
        var found = Array.prototype.slice.call(el.querySelectorAll(selectors[i]));
        if (found.length) return found;
      } catch (_) {}
    }
    return [];
  }
  function reconcileFill(spec, el) {
    var targets = fillTargets(spec, el);
    if (!targets.length) { clearFillMarks(el); return []; }
    var chains = [];
    targets.forEach(function (target) {
      for (var node = target.parentElement; node && node !== el; node = node.parentElement) {
        if (chains.indexOf(node) < 0) chains.push(node);
      }
    });
    // Idempotence matters: the content-host class observer sees host class changes. Only mutate a
    // marker when its membership actually changed, so reconciliation settles instead of feeding
    // its own observer forever.
    el.querySelectorAll(".pf-fill-scroll").forEach(function (node) {
      if (targets.indexOf(node) < 0) node.classList.remove("pf-fill-scroll");
    });
    el.querySelectorAll(".pf-fill-chain").forEach(function (node) {
      if (chains.indexOf(node) < 0) node.classList.remove("pf-fill-chain");
    });
    if (!el.classList.contains("pf-fill-host")) el.classList.add("pf-fill-host");
    targets.forEach(function (target) {
      if (!target.classList.contains("pf-fill-scroll")) target.classList.add("pf-fill-scroll");
    });
    chains.forEach(function (node) {
      if (!node.classList.contains("pf-fill-chain")) node.classList.add("pf-fill-chain");
    });
    return targets;
  }
  function markDirty(spec, el) { if (spec) dirty[layoutKeyFor(spec, el)] = true; }

  // B145: many contentHost skins render their OWN close control inside the content (the bld-head
  // ✕ on building/depot/hospital/zone panels, .build-close on the build menu, .info-close on the
  // fort/reports/info panels, .unit-close-button on the unit sheet / stockpile / stock item).
  // ONE working close per panel: while the live skin provides its own, the framework's generated
  // X is REMOVED rather than stacking a second X above it; the moment a skin without one renders
  // (base selection, tile-list chooser, squads sidebar) the framework X returns. Detection is
  // scoped to the content wrapper, so the framework's own .pf-x in the head can never satisfy it.
  // ONE close-control vocabulary (ESC-HANG unification). skinCloseFor and makeX previously used
  // DIFFERENT selectors: skinCloseFor matched only the four legacy skin classes while makeX also
  // honored [data-pf-close] / [aria-label='Close']. A close carrying only the generic markers
  // (the stockpile editor's .spe-close) was visible to one detector and invisible to the other:
  // reconcileX stacked a second framework X and head adoption was blocked. Both detectors now
  // share this constant so they can never disagree about "does this panel already have a close?".
  var CLOSE_SEL = "[data-pf-close],[aria-label='Close'],.bld-x,.build-close,.info-close," +
    ".unit-close-button,.dfchat-close,.dfchat-x,.hk-x,.cl-close";
  function childByClass(node, cls) {
    var kids = node && node.children;
    if (!kids) return null;
    for (var i = 0; i < kids.length; i++) if (kids[i].classList && kids[i].classList.contains(cls)) return kids[i];
    return null;
  }
  function skinCloseFor(spec, el) {
    if (!spec || !spec.contentHost) return null;
    var wrap = childByClass(el, "pf-content");
    if (!wrap || !wrap.querySelector) return null;
    try { return wrap.querySelector(CLOSE_SEL); } catch (_) { return null; }
  }

  // ---- WAVE 4 / VARIANT-AWARE `closable` (S1's COMPONENT-GAP-S1-CLOSE == S4's GAP-A) -----------
  // ONE registration hosts MANY skins. `closable` was a per-REGISTRATION boolean, so #selection was
  // "closable" for all ten of its variants -- and native has NO close X on the unit profile OR the
  // stock-item sheet (all 24 `steam *` profile captures; both item-sheet oracles). Dismissal there
  // is ESC.
  //
  // THE TRAP THIS CLOSES, and why two agents independently refused to hand-roll around it: head
  // adoption below is CONDITIONAL on the skin owning a close. Drop the skin's X and skinCloseFor()
  // returns null -> skinHeadFor() returns null -> the generated `.pf-head` "Selection" TITLE BAR
  // UN-HIDES and reconcileX stacks a FRESH framework ✕. So the naive parity fix ADDS TWO PIECES OF
  // NON-NATIVE CHROME while the diff reads as parity compliance.
  //
  // `closable` may now be a PREDICATE of the live element (`el => bool`), evaluated per reconcile,
  // so a registration can declare "this VARIANT has no close chrome at all; ESC dismisses it" and
  // BOTH gates agree: no framework X is generated, AND adoption no longer demands a skin close.
  // End state for such a variant: ZERO close affordances, ZERO framework title bar, ESC still
  // closes (controls-placement.js Esc cascade -> closeSelection()).
  // A boolean is unchanged in every respect; a throwing/garbage predicate falls back to CLOSABLE
  // (never silently strand a panel with no way out).
  function closableFor(spec, el) {
    if (!spec) return false;
    if (typeof spec.closable === "function") {
      try { return !!spec.closable(el || (spec.el && spec.el())); } catch (_) { return true; }
    }
    return !!spec.closable;
  }
  function removeGeneratedX(head) {
    var generated = childByClass(head, "pf-x");
    if (!generated || !generated.dataset || generated.dataset.pfGenerated !== "1") return;
    if (generated.remove) generated.remove();
    else if (generated.parentElement && generated.parentElement.removeChild) generated.parentElement.removeChild(generated);
  }
  function reconcileX(spec, el, head) {
    if (!head) return;
    // A close-less variant must also SHED an X a previous variant of the same panel generated --
    // otherwise the stale ✕ rides along inside the (hidden) head and re-appears the moment a later
    // skin un-hides the bar. Convergent: removeGeneratedX is a no-op when there is nothing to drop.
    if (!closableFor(spec, el) || skinCloseFor(spec, el)) { removeGeneratedX(head); return; }
    makeX(spec, el, head);
  }

  // B159 head ADOPTION (the CHOOSER-CHROME closeout direction): when the live contentHost skin
  // renders its OWN header (unit sheet .unit-sheet-header, building .bld-head, build menu
  // .build-head, info .info-header, ...), the framework adopts it -- drag binds to the skin's
  // header and the generated pf-head bar is HIDDEN (never removed: the heal observer and the
  // detach path key on its presence). Without this, the generated bar stacks a second header
  // above the skin's and its sticky opaque strip covers the skin's host-anchored close button
  // and name line (the B159-1 "Selection" bar regression). A skin without its own header (base
  // selection, tile-list chooser, squads sidebar) gets the generated bar back, X included --
  // the same return contract as B145's one-close reconciliation.
  function skinHeadFor(spec, el) {
    if (!spec || !spec.contentHost || !spec.adoptHeadSel) return null;
    var wrap = childByClass(el, "pf-content");
    if (!wrap || !wrap.querySelector) return null;
    var head = null;
    try { head = wrap.querySelector(spec.adoptHeadSel); } catch (_) { return null; }
    // Adoption requires the skin to provide its OWN close: hiding the bar hides its X, and a
    // CLOSABLE panel must never lose its last close. Transient loading shells that render a
    // header without a close keep the framework bar until the real skin lands.
    // WAVE 4: that gate is now scoped to variants that ARE closable. A variant declared close-less
    // (ESC-only, per closableFor above) has no X to lose, so its header is adopted WITHOUT one --
    // which is the whole point: the bar stays hidden and no ✕ is manufactured.
    if (!head || (closableFor(spec, el) && !skinCloseFor(spec, el))) return null;
    return head;
  }
  function reconcileHead(spec, el) {
    var generated = childByClass(el, "pf-head");
    var skin = skinHeadFor(spec, el);
    if (skin) {
      if (generated) {
        generated.style.display = "none";
        // Convergence guard: an unconditional setAttribute queues a mutation record even for an
        // identical value; only write when the state actually changes.
        if (generated.setAttribute && (!generated.getAttribute || generated.getAttribute("data-pf-adopted") !== "1"))
          generated.setAttribute("data-pf-adopted", "1");
      }
      if (skin.classList && !skin.classList.contains("pf-handle")) skin.classList.add("pf-handle");
      addDrag(spec, el, skin);
      return skin;
    }
    if (generated) {
      generated.style.display = "";
      if (generated.removeAttribute && generated.getAttribute && generated.getAttribute("data-pf-adopted") != null)
        generated.removeAttribute("data-pf-adopted");
    }
    return generated;
  }

  function loadedLayout() {
    // Keep clean entries for panels registered later in the same page; each registration only
    // consumes its own key, so unregistered/renamed keys remain inert.
    return decodeLayout(storageGet(LAYOUT_KEY));
  }
  function layoutState() {
    if (layoutPanels == null) layoutPanels = loadedLayout().panels;
    return layoutPanels;
  }
  function geometryEnabled(spec) { return !!spec && (spec.movable !== false || !!spec.resizable); }
  function rememberPanel(spec) {
    if (!geometryEnabled(spec)) return;
    var el = specEl(spec);
    var entry = el && geometryEntry(spec, el);
    if (!entry) return;
    if (spec.persistOpen !== false && spec.isOpen) entry.open = !!spec.isOpen();
    layoutState()[layoutKeyFor(spec, el)] = entry;
  }
  function saveSoon() {
    if (!enabled()) return;
    if (saveTimer) root.clearTimeout(saveTimer);
    saveTimer = root.setTimeout(function () {
      saveTimer = 0;
      var panels = layoutState();
      Object.keys(registry).forEach(function (key) {
        var spec = registry[key], el = specEl(spec);
        if (!el || !attached[key] || !geometryEnabled(spec)) return;
        var lk = layoutKeyFor(spec, el);
        // Never freeze an untouched contentHost variant's responsive CSS docking into inline geometry.
        if (spec.contentHost && !dirty[lk] && !(lk in panels)) return;
        var entry = geometryEntry(spec, el);
        if (entry) {
          if (spec.persistOpen !== false && spec.isOpen) entry.open = !!spec.isOpen();
          panels[lk] = entry;
        } else if (panels[lk] && spec.persistOpen !== false && spec.isOpen) {
          panels[lk].open = false;
        }
      });
      storageSet(LAYOUT_KEY, encodeLayout(panels));
    }, 250);
  }

  function rectFor(el) {
    var z = effectiveZoom(el), r = el.getBoundingClientRect();
    return { x: r.left / z, y: r.top / z, w: r.width / z, h: r.height / z };
  }
  function boxExtras(el, horizontal) {
    var style = styleFor(el);
    if (style && style.boxSizing === "border-box") return 0;
    var names = horizontal ? ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] :
      ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"];
    return names.reduce(function (sum, name) {
      var value = parseFloat(style && style[name]);
      return sum + (finite(value) ? value : 0);
    }, 0);
  }
  function applyRect(spec, el, rect) {
    el.style.left = round(rect.x) + "px";
    el.style.top = round(rect.y) + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
    // Move-only panels (lobby, audio) are sized by their content: the players list must grow when
    // the roster does. B134: writing inline width/height here froze the lobby at whatever height
    // it had at open/drag time, and every later roster change scrolled inside the stale box.
    if (spec && !spec.resizable) return;
    el.style.width = round(cssSizeForRect(rect.w, styleFor(el).boxSizing, boxExtras(el, true))) + "px";
    el.style.height = round(cssSizeForRect(rect.h, styleFor(el).boxSizing, boxExtras(el, false))) + "px";
    el.style.maxHeight = "none";
  }
  function limitsFor(spec, el) {
    var inset = chromeInsets(el);
    return {
      minW: spec.resizable && spec.resizable.minW || 0,
      minH: spec.resizable && spec.resizable.minH || 0,
      top: inset.top, right: inset.right, bottom: inset.bottom, left: inset.left, head: HEAD_H,
    };
  }
  function clearRectStyles(el) {
    ["left", "top", "right", "bottom", "width", "height", "maxHeight"].forEach(function (name) { el.style[name] = ""; });
  }
  function rectChanged(a, b) {
    return Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 ||
      Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5;
  }
  // Open-time / window-resize safety clamp. Writes ONLY the offending sides. PANEL-GEOMETRY-2:
  // the old version applied the whole rect once anything changed, freezing a CSS-docked host's
  // TRANSIENT auto size into inline styles -- the build panel's class flips before its catalog
  // renders, so its skeleton (724x57, floored to minH 140) got frozen and the 456px-tall window
  // that rendered moments later was culled by overflow:hidden. CSS must keep sizing an untouched
  // panel; inline geometry is written only by the user's own drag/resize or a violation shrink.
  function clampOpenRect(spec, el) {
    if (!visible(el) || !el.getBoundingClientRect) return null;
    var rect = rectFor(el), next = clampRect(rect, viewportFor(el), limitsFor(spec, el));
    if (!rectChanged(rect, next)) return next;
    if (Math.abs(next.w - rect.w) > 0.5)
      el.style.width = round(cssSizeForRect(next.w, styleFor(el).boxSizing, boxExtras(el, true))) + "px";
    if (Math.abs(next.h - rect.h) > 0.5) {
      el.style.height = round(cssSizeForRect(next.h, styleFor(el).boxSizing, boxExtras(el, false))) + "px";
      el.style.maxHeight = "none";
    }
    if (Math.abs(next.x - rect.x) > 0.5) { el.style.left = round(next.x) + "px"; el.style.right = "auto"; }
    if (Math.abs(next.y - rect.y) > 0.5) { el.style.top = round(next.y) + "px"; el.style.bottom = "auto"; }
    return next;
  }
  function explicitRect(spec, el) {
    var rect = clampRect(rectFor(el), viewportFor(el), limitsFor(spec, el));
    applyRect(spec, el, rect);
    return rect;
  }
  function geometryEntry(spec, el) {
    if (!visible(el)) return null;
    return anchorForRect(rectFor(el), viewportFor(el));
  }
  function restore(spec, el, entry) {
    var viewport = viewportFor(el), limits = limitsFor(spec, el);
    var raw = rectFromEntry(entry, viewport);
    // clampRect no longer inflates to minimums (PANEL-GEOMETRY-2); floor stale/corrupt saves here.
    if (finite(limits.minW)) raw.w = Math.max(raw.w, limits.minW);
    if (finite(limits.minH)) raw.h = Math.max(raw.h, limits.minH);
    applyRect(spec, el, clampRect(raw, viewport, limits));
  }

  function restack() {
    order = order.filter(function (key) { return registry[key] && attached[key] && registry[key].zBand !== false; });
    escStack = escStack.filter(function (key) { return registry[key] && attached[key]; });
    var z = zForStack(order);
    Object.keys(z).forEach(function (key) {
      var spec = registry[key], el = specEl(spec);
      if (el) el.style.zIndex = String(z[key]);
    });
  }
  function focus(key) {
    var spec = registry[key];
    if (!spec || !attached[key]) return;
    if (spec.zBand !== false) {
      order = focusStack(order, key);
      Object.keys(registry).forEach(function (id) {
        var item = registry[id], el = specEl(item);
        var index = order.indexOf(id);
        if (el && item.zBand !== false && index >= 0) el.style.zIndex = String(PF_Z_BASE + index);
      });
    }
    if (spec.escClosable) escStack = focusStack(escStack, key);
    restack();
  }

  // Consumers retain their own visibility bookkeeping. They call this after opening, or before
  // hiding, so an existing opener/X/toggle gets the same persistence and focus behavior.
  function syncOpenState(key, isOpen) {
    var spec = registry[key], el = spec && specEl(spec);
    if (!enabled() || !spec || !el || !attached[key]) return;
    if (spec.contentHost) {
      // A host can change directly from one VISIBLE skin to another. Inline geometry from the old
      // skin otherwise beats the new skin's CSS, and the old visibility-only observer never ran --
      // the build-panel half-off-screen failure. Clear on variant change, then restore only that
      // variant's saved geometry or clamp its live CSS-derived default.
      var lk = layoutKeyFor(spec, el), state = attached[key];
      if (isOpen) {
        if (state.layoutKey !== lk) {
          clearRectStyles(el);
          state.layoutKey = lk;
        }
        var savedV = layoutState()[lk];
        if (savedV) restore(spec, el, savedV); else clampOpenRect(spec, el);
        focus(key);
      } else {
        escStack = escStack.filter(function (item) { return item !== key; });
      }
      refreshPanelsMenu();
      return;
    }
    if (isOpen) {
      var saved = geometryEnabled(spec) && layoutState()[key];
      if (saved) restore(spec, el, saved); else clampOpenRect(spec, el);
      rememberPanel(spec);
      focus(key);
    } else {
      rememberPanel(spec);
      if (spec.persistOpen !== false && layoutState()[key]) layoutState()[key].open = false;
      escStack = escStack.filter(function (item) { return item !== key; });
    }
    saveSoon();
    refreshPanelsMenu();
  }

  function makeX(spec, el, head) {
    if (!closableFor(spec, el) || !head) return;
    var close = childByClass(head, "pf-x") ||
      head.querySelector(".pf-x," + CLOSE_SEL);
    if (!close) {
      close = root.document.createElement("button");
      close.type = "button";
      close.className = "pf-x";
      close.setAttribute("aria-label", "Close " + (spec.title || "panel"));
      close.setAttribute("data-pf-generated", "1");
      close.dataset.pfGenerated = "1";
      close.textContent = "✕";   // MULTIPLICATION X; a previous encoding mangle shipped "?"
      close.style.cssText = "margin-left:auto;border:0;background:none;color:#ffd45c;font:700 18px ui-monospace,monospace;cursor:pointer;line-height:1;";
      head.appendChild(close);
    }
    if (close.dataset.pfCloseBound === "1") return;
    close.dataset.pfCloseBound = "1";
    close.addEventListener("click", function (event) {
      if (!enabled() || !attached[spec.key]) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel(spec);
    });
  }

  function newHead(spec, el) {
    var head = root.document.createElement("div");
    head.className = "pf-head";
    head.textContent = spec.title || "Panel";
    head.style.cssText = "height:22px;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:0 5px;" +
      "background:#151515;border-bottom:1px solid #d89b27;color:#ffd45c;font:12px ui-monospace,Consolas,monospace;cursor:move;user-select:none;";
    el.insertBefore(head, el.firstChild);
    return head;
  }

  function addDrag(spec, el, head) {
    if (!head || spec.movable === false || head.dataset.pfDragBound === "1") return;
    head.dataset.pfDragBound = "1";
    head.addEventListener("pointerdown", function (event) {
      if (!enabled() || !attached[spec.key]) return;
      if (event.button != null && event.button !== 0) return;
      if (event.target && event.target.closest && event.target.closest("button,input,select,a,[data-pf-nodrag]")) return;
      event.preventDefault();
      event.stopPropagation();
      focus(spec.key);
      var start = explicitRect(spec, el);
      var pointerStart = { x: event.clientX, y: event.clientY };
      var pending = null, raf = 0;
      try { head.setPointerCapture(event.pointerId); } catch (_) {}
      function move(ev) {
        pending = ev;
        if (raf) return;
        raf = root.requestAnimationFrame(function () {
          raf = 0;
          if (!pending) return;
          var rect = dragByVisual(start, pointerStart, { x: pending.clientX, y: pending.clientY }, effectiveZoom(el));
          applyRect(spec, el, clampRect(rect, viewportFor(el), limitsFor(spec, el)));
        });
      }
      function end() {
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", end);
        head.removeEventListener("pointercancel", end);
        if (raf) { root.cancelAnimationFrame(raf); raf = 0; }
        markDirty(spec, el);
        rememberPanel(spec);
        saveSoon();
      }
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", end);
      head.addEventListener("pointercancel", end);
    });
  }

  function addResize(spec, el) {
    if (!spec.resizable || el.querySelector(".pf-grip,.pf-edge-e,.pf-edge-s")) return;
    el.classList.add("pf-resizable");
    // Edges are appended first and corners last: equal-z later siblings win hit-testing. In v1 the
    // E/S edges covered most of the lone 14px SE grip, making it behave like a one-axis handle.
    [["pf-edge-e", "e", "right:0;top:0;width:6px;height:100%;cursor:ew-resize;z-index:1;"],
     ["pf-edge-s", "s", "left:0;bottom:0;width:100%;height:6px;cursor:ns-resize;z-index:1;"],
     ["pf-grip pf-grip-nw", "nw", "left:0;top:0;cursor:nwse-resize;"],
     ["pf-grip pf-grip-ne", "ne", "right:0;top:0;cursor:nesw-resize;"],
     ["pf-grip pf-grip-sw", "sw", "left:0;bottom:0;cursor:nesw-resize;"],
     ["pf-grip pf-grip-se", "se", "right:0;bottom:0;cursor:nwse-resize;"]].forEach(function (part) {
      var grip = root.document.createElement("div");
      grip.className = part[0];
      grip.style.cssText = "position:absolute;" + part[2];
      el.appendChild(grip);
      grip.addEventListener("pointerdown", function (event) {
        if (!enabled() || !attached[spec.key]) return;
        if (event.button != null && event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); focus(spec.key);
        var start = explicitRect(spec, el), pointerStart = { x: event.clientX, y: event.clientY }, pending = null, raf = 0;
        try { grip.setPointerCapture(event.pointerId); } catch (_) {}
        function move(ev) {
          pending = ev;
          if (raf) return;
          raf = root.requestAnimationFrame(function () {
            raf = 0;
            if (!pending) return;
            var raw = resizeByVisual(start, pointerStart, { x: pending.clientX, y: pending.clientY }, effectiveZoom(el), part[1]);
            applyRect(spec, el, clampResizeRect(start, raw, part[1], viewportFor(el), limitsFor(spec, el)));
          });
        }
        function end() {
          grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", end); grip.removeEventListener("pointercancel", end);
          if (raf) { root.cancelAnimationFrame(raf); raf = 0; }
          markDirty(spec, el);
          rememberPanel(spec);
          saveSoon();
        }
        grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end);
      });
    });
    // Some hosts scroll at the element level (base #clientPanel/#selection, td-depot, hosp).
    // Absolute children anchor to the padding box at scroll 0 and would scroll away with the
    // content; translating by the live scroll offset pins every grip/edge to the VISIBLE corners.
    if (el.dataset.pfGripScrollBound !== "1") {
      el.dataset.pfGripScrollBound = "1";
      el.addEventListener("scroll", function () {
        var t = (el.scrollLeft || el.scrollTop) ? "translate(" + el.scrollLeft + "px," + el.scrollTop + "px)" : "";
        el.querySelectorAll(".pf-grip,.pf-edge-e,.pf-edge-s").forEach(function (node) { node.style.transform = t; });
      }, { passive: true });
    }
  }

  function openPanel(spec) {
    if (spec.open) spec.open();
    rememberPanel(spec);
    focus(spec.key);
    saveSoon();
    refreshPanelsMenu();
  }
  function closePanel(spec) {
    rememberPanel(spec);
    if (spec.close) spec.close();
    if (spec.persistOpen !== false && layoutState()[spec.key]) layoutState()[spec.key].open = false;
    escStack = escStack.filter(function (key) { return key !== spec.key; });
    saveSoon();
    refreshPanelsMenu();
  }

  // Build (or, on heal, rebuild) the persistent chrome: drag handle, X, resize grips, content
  // wrapper. Idempotent -- the pf*Bound datasets keep repeat calls from double-binding, and
  // contentEl reuses an existing wrapper. Called from attach and from the heal observer.
  function buildChrome(spec, el) {
    var head = spec.headSel ? el.querySelector(spec.headSel) : null;
    if (spec.movable !== false) head = head || newHead(spec, el);
    if (head && !head.classList.contains("pf-handle")) head.classList.add("pf-handle");
    reconcileX(spec, el, head);
    addDrag(spec, el, head);
    addResize(spec, el);
    if (spec.contentHost) {
      contentEl(el);   // ensure the wrapper exists after the head/grips
      var adopted = reconcileHead(spec, el);
      if (adopted) head = adopted;
    }
    reconcileFill(spec, el);
    return head;
  }

  // contentHost panels are re-skinned by ~20 writer modules. A converted writer mutates the
  // wrapper's children only, so this childList observer stays silent in normal operation and fires
  // ONLY when a writer bypasses panelContent() and writes host.innerHTML directly (a missed
  // migration, or a legacy add-on). That destroys the framework header; we re-heal it (re-wrap the
  // orphaned content, restore head + grips) and warn once. A class observer drives open/close
  // detection centrally, so no writer has to call syncOpenState.
  // Settle budget (ESC-HANG defense in depth). The root fix above makes every reconciler
  // convergent, so a settled DOM produces zero mutations and the observers go quiet after a
  // couple of passes. If a FUTURE reconciler diverges (flip-flopping a marker every pass), the
  // observers would otherwise feed each other in an unbounded microtask loop that never yields
  // to the event loop -- the dead-tab failure mode. Budget: more than SETTLE_BUDGET observer
  // passes without reaching an animation frame disconnects the panel's observers (starving the
  // loop), reports the panel key loudly ONCE via console.error, and re-arms next frame so the
  // panel stays alive. A divergent reconciler becomes one error per frame, never a dead tab.
  var SETTLE_BUDGET = 25;
  function installHostObservers(spec, el) {
    if (!root.MutationObserver) return;
    var state = attached[spec.key];
    if (!state || state.observers) return;
    state.observers = [];
    state.settlePasses = 0;
    state.settleTripped = false;
    function observeAll() {
      heal.observe(el, { childList: true });
      xsync.observe(el, { childList: true, subtree: true });
      cls.observe(el, { attributes: true, attributeFilter: ["class"] });
    }
    function budgeted(reconcile) {
      return function () {
        if (!attached[spec.key] || !enabled() || state.settleTripped) return;
        // A frame boundary is the "settled" signal: reset the pass count whenever one is reached.
        // A spinning microtask loop never reaches a frame, which is exactly why the budget counts
        // passes-per-frame instead of trusting a timer.
        if (state.settlePasses === 0 && root.requestAnimationFrame)
          root.requestAnimationFrame(function () { state.settlePasses = 0; });
        state.settlePasses++;
        if (state.settlePasses > SETTLE_BUDGET) {
          state.settleTripped = true;
          state.observers.forEach(function (o) { try { o.disconnect(); } catch (_) {} });
          try {
            root.console.error("[DFPanelFrame] settle budget exceeded for panel '" + spec.key +
              "': a reconciler is not converging; observers disconnected, re-arming next frame.");
          } catch (_) {}
          if (root.requestAnimationFrame) root.requestAnimationFrame(function () {
            if (attached[spec.key] !== state || !state.observers || !enabled()) return;
            state.settlePasses = 0;
            state.settleTripped = false;
            observeAll();
            // Catch up on whatever the disconnected window missed. Reconcilers are convergent
            // (or trip again next frame -- bounded either way).
            reconcilePanel();
          });
          return;
        }
        reconcile();
      };
    }
    function reconcilePanel() {
      if (spec.resizable && !el.classList.contains("pf-resizable")) el.classList.add("pf-resizable");
      reconcileX(spec, el, childByClass(el, "pf-head"));
      reconcileHead(spec, el);
      reconcileFill(spec, el);
    }
    var heal = new root.MutationObserver(budgeted(function () {
      var hasHead = false, kids = el.children;
      for (var i = 0; i < kids.length; i++) if (kids[i].classList && kids[i].classList.contains("pf-head")) { hasHead = true; break; }
      if (hasHead) return;   // normal converted write (wrapper mutated) or our own chrome adds
      if (!state.healWarned) {
        state.healWarned = true;
        try { root.console && root.console.warn("[DFPanelFrame] direct innerHTML write to #" + (el.id || spec.key) + " bypassed panelContent(); framework header re-healed. Convert this writer to panelContent()."); } catch (_) {}
      }
      state.head = buildChrome(spec, el);
      var lk = layoutKeyFor(spec, el), saved = layoutState()[lk];
      if (visible(el) && saved && (dirty[lk] || (lk in layoutState()))) restore(spec, el, saved);
    }));

    // B145 (one close per panel): every skin render replaces the wrapper's children -- and whether
    // the framework X should exist depends on what the new skin rendered (does it carry its own
    // close?). Subtree childList on the host sees wrapper-internal writes AND a healed wrapper
    // replacement. reconcileX is idempotent, so its own head edits settle in one no-op pass.
    // B159: reconcileHead re-decides whether the framework bar or the skin's own header is THE
    // head, alongside the X. Idempotent: class adds are guarded, drag binds stop on pfDragBound.
    var xsync = new root.MutationObserver(budgeted(reconcilePanel));

    var cls = new root.MutationObserver(budgeted(function () {
      // B145 root cause: skins assign host.className WHOLESALE (selection.className = "visible
      // building-panel"), wiping the framework's pf-resizable class. Without it the CSS close-
      // button inset (.pf-resizable .pf-handle .pf-x { margin-right: 22px }) stops applying and
      // the 22x22 NE corner grip (z-index 4) swallows clicks on the X -- the "top X doesn't
      // close" report. Re-assert before any early return; add() is guarded so the extra
      // attribute mutation settles in one no-op pass.
      if (spec.resizable && !el.classList.contains("pf-resizable")) el.classList.add("pf-resizable");
      reconcileFill(spec, el);
      var now = el.classList.contains("visible");
      var variantChanged = now && layoutKeyFor(spec, el) !== state.layoutKey;
      if (now === state.lastVisible && !variantChanged) return;
      state.lastVisible = now;
      syncOpenState(spec.key, now);
    }));

    state.lastVisible = visible(el) && el.classList.contains("visible");
    state.layoutKey = state.lastVisible ? layoutKeyFor(spec, el) : null;
    state.observers.push(heal, xsync, cls);
    observeAll();
  }


  // Close-only legacy registrations (currently settingsMenu) have no consumer sync hook. Observe
  // their open class so even an old cached controls script gets the same open-time safety clamp.
  function installOpenObserver(spec, el) {
    if (!root.MutationObserver || spec.contentHost || geometryEnabled(spec) || !spec.isOpen) return;
    var state = attached[spec.key];
    if (!state || state.openObserver) return;
    state.lastOpen = !!spec.isOpen();
    state.openObserver = new root.MutationObserver(function () {
      if (!attached[spec.key] || !enabled()) return;
      var now = !!spec.isOpen();
      if (now === state.lastOpen) return;
      state.lastOpen = now;
      syncOpenState(spec.key, now);
    });
    state.openObserver.observe(el, { attributes: true, attributeFilter: ["class"] });
  }

  function attach(spec) {
    if (attached[spec.key]) return;
    var el = specEl(spec);
    if (!el) return;
    attached[spec.key] = { el: el, added: [] };
    var head = buildChrome(spec, el);
    attached[spec.key].head = head;
    if (el.dataset.pfFocusBound !== "1") {
      el.dataset.pfFocusBound = "1";
      el.addEventListener("pointerdown", function () { if (enabled() && attached[spec.key]) focus(spec.key); });
    }
    if (spec.contentHost) installHostObservers(spec, el);
    else installOpenObserver(spec, el);
    var saved = geometryEnabled(spec) && layoutState()[layoutKeyFor(spec, el)];
    if (saved) {
      if (spec.contentHost || spec.persistOpen === false) {
        // Session-semantic / content hosts: geometry persists, open-state does not. Restore only if
        // already open; never auto-open. Their opener (or the class observer) restores on next open.
        if (visible(el)) restore(spec, el, saved);
      } else if (saved.open === false && spec.close) {
        spec.close();
      } else {
        if (!visible(el) && spec.open) spec.open();
        if (visible(el)) restore(spec, el, saved);
      }
    } else if (visible(el)) {
      clampOpenRect(spec, el);
    }
    if (spec.escClosable && spec.isOpen && spec.isOpen()) focus(spec.key);
    refreshPanelsMenu();
  }

  function detach(key) {
    var state = attached[key];
    if (!state) return;
    var spec = registry[key], el = state.el;
    if (state.observers) { state.observers.forEach(function (o) { try { o.disconnect(); } catch (_) {} }); state.observers = null; }
    if (state.openObserver) { try { state.openObserver.disconnect(); } catch (_) {} state.openObserver = null; }
    // M1 has no migrated panels; removal is nevertheless complete for an in-page master switch.
    if (el) ["left", "top", "right", "bottom", "width", "height", "maxHeight", "zIndex"].forEach(function (name) { el.style[name] = ""; });
    if (state.head) state.head.classList.remove("pf-handle");
    // B159: an adopted skin header carries pf-handle too; strip it from every carrier.
    if (el && el.querySelectorAll) el.querySelectorAll(".pf-handle").forEach(function (node) { node.classList.remove("pf-handle"); });
    if (el) el.classList.remove("pf-resizable");
    if (el) clearFillMarks(el);
    if (el) el.querySelectorAll("[data-pf-generated='1']").forEach(function (node) { node.remove(); });
    if (el) el.querySelectorAll(".pf-head,.pf-grip,.pf-edge-e,.pf-edge-s").forEach(function (node) {
      if (node.classList.contains("pf-head") && spec.headSel) return;
      node.remove();
    });
    delete attached[key];
    escStack = escStack.filter(function (item) { return item !== key; });
    order = order.filter(function (item) { return item !== key; });
  }

  function refreshPanelsMenu() {
    if (!hasDom) return;
    // Truthiness, NOT closableFor(): a variant-aware predicate means "closable in at least some
    // variants", and the cog's Panels list is a per-PANEL affordance, not a per-skin one. (Both
    // contentHost panels are menu:false anyway, so no live panel is affected either way.)
    var closable = Object.keys(registry).filter(function (key) { return registry[key].closable && registry[key].menu !== false && attached[key]; });
    var existing = root.document.getElementById("dfPanelFrameMenu");
    if (!closable.length) { if (existing) existing.remove(); return; }
    var menu = root.document.getElementById("settingsMenu");
    if (!menu) return;
    if (!existing) {
      existing = root.document.createElement("div");
      existing.id = "dfPanelFrameMenu";
      existing.className = "pf-menu";
      existing.style.cssText = "border-top:1px solid #5a4316;margin-top:6px;padding-top:4px;";
      menu.appendChild(existing);
    }
    existing.innerHTML = "<h3>Panels</h3>";
    closable.forEach(function (key) {
      var spec = registry[key], row = root.document.createElement("div"), open = !spec.isOpen || !!spec.isOpen();
      row.className = "set-row" + (open ? " on" : "");
      row.tabIndex = 0;
      row.innerHTML = '<div class="set-toggle"></div><div class="set-label"><b></b></div>';
      row.querySelector("b").textContent = spec.title || key;
      function toggle(event) {
        if (event) { event.preventDefault(); event.stopPropagation(); }
        if (!spec.isOpen || spec.isOpen()) closePanel(spec); else openPanel(spec);
      }
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") toggle(event); });
      existing.appendChild(row);
    });
  }

  function escCloseTopmost() {
    if (!enabled()) return false;
    var candidates = Object.keys(registry).filter(function (key) {
      var spec = registry[key];
      return attached[key] && spec.escClosable && spec.isOpen && spec.isOpen();
    });
    if (!candidates.length) return false;
    // A panel opened outside the framework still joins on its first Esc; registered order is the
    // deterministic fallback until the user gives it focus.
    candidates.forEach(function (key) { if (escStack.indexOf(key) < 0) escStack.push(key); });
    var key = escStack.filter(function (item) { return candidates.indexOf(item) >= 0; }).pop();
    if (!key) key = candidates[candidates.length - 1];
    closePanel(registry[key]);
    return true;
  }

  function resetAll() {
    storageRemove(LAYOUT_KEY);
    layoutPanels = {};
    dirty = Object.create(null);
    Object.keys(registry).forEach(function (key) {
      var spec = registry[key], el = specEl(spec);
      if (!el || !attached[key]) return;
      ["left", "top", "right", "bottom", "width", "height", "maxHeight", "zIndex"].forEach(function (name) { el.style[name] = ""; });
      if (spec.defaultPos && (!spec.isOpen || spec.isOpen())) {
        var viewport = viewportFor(el), pos = spec.defaultPos(viewport.w, viewport.h);
        if (pos && finite(pos.x) && finite(pos.y) && finite(pos.w) && finite(pos.h)) restore(spec, el, pos);
      }
    });
    order = [];
    escStack = [];
    refreshPanelsMenu();
  }

  function register(spec) {
    if (!spec || !spec.key || typeof spec.el !== "function") return;
    registry[spec.key] = spec;
    if (enabled()) attach(spec);
  }

  function setEnabled(on) {
    storageSet(ENABLED_KEY, on ? "1" : "0");
    if (on) Object.keys(registry).forEach(function (key) { attach(registry[key]); });
    else Object.keys(attached).forEach(detach);
    refreshPanelsMenu();
  }

  if (hasDom) {
    root.addEventListener("resize", function () {
      if (!enabled()) return;
      Object.keys(attached).forEach(function (key) {
        var spec = registry[key], el = specEl(spec);
        if (!el || !visible(el)) return;
        clampOpenRect(spec, el);
      });
    });
    // The settings cog is M1's sole close-only registration: it changes no geometry or z-order.
    register({
      key: "settingsMenu", el: function () { return root.document.getElementById("settingsMenu"); },
      movable: false, closable: false, zBand: false, escClosable: true, persistOpen: false,
      isOpen: function () { var el = root.document.getElementById("settingsMenu"); return !!el && el.classList.contains("open"); },
      close: function () { var el = root.document.getElementById("settingsMenu"); if (el) el.classList.remove("open"); },
    });
  }

  var api = {
    register: register, escCloseTopmost: escCloseTopmost, resetAll: resetAll,
    setEnabled: setEnabled, chromeInsets: chromeInsets, refreshPanelsMenu: refreshPanelsMenu,
    syncOpenState: syncOpenState, contentEl: contentEl,
    _pure: PURE,
  };
  Object.defineProperty(api, "enabled", { enumerable: true, get: enabled });
  root.DFPanelFrame = api;
  if (typeof module !== "undefined" && module.exports) module.exports = PURE;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
