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

// The panel framework: registration, docking, drag, and remembered position. The persistence
// keys dwf.panelLayout.v1 / dwf.panelFrame.enabled and every panel key are stable contract.
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
  // "user positioned this", per (variant-)key: an untouched variant keeps its CSS docking, so a
  // responsive layout is never frozen into stale inline styles.
  var dirty = Object.create(null);
  var hasDom = !!(root.document && root.document.createElement);

  function finite(n) { return typeof n === "number" && Number.isFinite(n); }
  function round(n) { return Math.round(n); }
  var DwfUtil = root.DwfUtil || (typeof require === "function" ? require("./dwf-util.js") : null);
  var clamp = DwfUtil.clamp;

  // A 0-wide or 0-tall rect is not geometry -- it is an unlaid-out element. Refuse it here and in
  // geometryEntry, or one stored entry snaps that panel to the viewport origin for good.
  function validEntry(entry) {
    return !!entry && typeof entry === "object" &&
      (entry.anchor === "tl" || entry.anchor === "tr" || entry.anchor === "bl" || entry.anchor === "br") &&
      finite(entry.x) && finite(entry.y) && finite(entry.w) && finite(entry.h) &&
      entry.w > 0 && entry.h > 0 && (entry.open == null || typeof entry.open === "boolean");
  }

  function decodeLayout(raw, knownKeys) {
    var parsed;
    try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { v: VERSION, panels: {} }; }
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

  // Drag/open clamp: SIZE is preserved and POSITION stops at the boundary. Minimum sizes belong to
  // clampResizeRect and restore only -- flooring here shrinks a panel dragged toward an edge.
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

  // For an untouched CSS-docked panel the docking IS the truth: shrink from the FAR edge and leave
  // the docked near edge where CSS put it. Only clampOpenRect uses this; drag and restore do not.
  function clampDockedRect(rect, viewport, limits) {
    var area = workArea(viewport, limits);
    var x = clamp(rect.x, area.left, Math.max(area.left, area.right));
    var y = clamp(rect.y, area.top, Math.max(area.top, area.bottom));
    var w = Math.min(rect.w, area.right - x);
    var h = Math.min(rect.h, area.bottom - y);
    // A dock that leaves no room at all is not a dock; fall back to the whole work area.
    if (!(w > 0)) { x = area.left; w = Math.max(0, Math.min(rect.w, area.w)); }
    if (!(h > 0)) { y = area.top; h = Math.max(0, Math.min(rect.h, area.h)); }
    return { x: x, y: y, w: w, h: h };
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

  // Clamp a directional resize with the OPPOSITE edge pinned, and apply minW/minH against that edge:
  // clampRect applies no floor at all, so routing a resize through it would move the wrong edge.
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

  function scrollFillHeight(panelHeight, reservedHeight) {
    return Math.max(0, Number(panelHeight) - Number(reservedHeight || 0));
  }

  function footerMinimumHeight(el, bodySelector, listSelector, footerSelector, floor, styleResolver) {
    if (!el || !el.querySelector) return Number(floor) || 0;
    var body = el.querySelector(bodySelector), list = el.querySelector(listSelector);
    var footer = el.querySelector(footerSelector);
    if (!body || !list || !footer || !el.getBoundingClientRect || !body.getBoundingClientRect ||
        !list.getBoundingClientRect || !footer.getBoundingClientRect) return Number(floor) || 0;
    var zoom = effectiveZoomPure(el, styleResolver) || 1;
    var panelRect = el.getBoundingClientRect(), bodyRect = body.getBoundingClientRect();
    var listRect = list.getBoundingClientRect(), footerRect = footer.getBoundingClientRect();
    var chrome = Math.max(0, panelRect.height - bodyRect.height);
    var beforeList = Math.max(0, listRect.top - bodyRect.top);
    var afterList = Math.max(0, footerRect.top - listRect.bottom);
    return Math.max(Number(floor) || 0,
      Math.ceil((beforeList + afterList + footerRect.height + chrome) / zoom));
  }

  // #clientPanel and #selection are ONE element many modules re-skin, so geometry is remembered per
  // variant. `priority` is most-specific-first: a `building-panel zone-panel` host maps to zone-panel.
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
    clampDockedRect: clampDockedRect,
    chromeInsetsFor: chromeInsetsFor, workArea: workArea,
    dragByVisual: dragByVisual, resizeByVisual: resizeByVisual, clampResizeRect: clampResizeRect,
    effectiveZoom: effectiveZoomPure,
    focusStack: focusStack, zForStack: zForStack, cssSizeForRect: cssSizeForRect,
    primaryVariant: primaryVariant, scrollFillHeight: scrollFillHeight,
    footerMinimumHeight: footerMinimumHeight,
    closableFor: closableFor,          // variant-aware close (declared below; hoisted)
    surfaceDragRefused: surfaceDragRefused, SURFACE_NODRAG_SEL: function () { return SURFACE_NODRAG_SEL; },
    dormant: function (enabled, value, apply) { return enabled ? apply(value) : value; },
  };

  function enabled() { return DwfUtil.lsGet(ENABLED_KEY) !== "0"; }

  function styleFor(el) { return root.getComputedStyle ? root.getComputedStyle(el) : el.style; }
  function effectiveZoom(el) { return effectiveZoomPure(el, styleFor); }
  function viewportFor(el) {
    var z = effectiveZoom(el);
    return { w: root.innerWidth / z, h: root.innerHeight / z, z: z };
  }
  function uiScale() {
    try { if (root.DWFUIScale) return root.DWFUIScale.get(); }
    catch (err) { DwfErr.report("panel-frame.ui-scale", err); }
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
    var rightHud = measured("rightHud");
    if (rightHud && rightHud.height >= root.innerHeight * 0.6)
      inset.right = Math.max(inset.right, (root.innerWidth - rightHud.left) / z);
    var bottomBar = measured("bottomBar");
    if (bottomBar) inset.bottom = Math.max(inset.bottom, (root.innerHeight - bottomBar.top) / z);
    return inset;
  }
  function visible(el) { return !!el && styleFor(el).display !== "none"; }
  function specEl(spec) { try { return spec.el && spec.el(); } catch { return null; } }

  // Only the layout MAP is variant-scoped; identity (focus, z, escStack, attached) always stays
  // keyed on spec.key.
  function layoutKeyFor(spec, el) {
    if (spec && spec.variantKey && el) {
      try { var k = spec.variantKey(el); if (k) return k; }
      catch (err) { DwfErr.report("panel-frame.variant-key", err); }
    }
    return spec.key;
  }
  function isChrome(node) {
    return node && node.nodeType === 1 && node.classList &&
      (node.classList.contains("pf-head") || node.classList.contains("pf-grip") ||
       node.classList.contains("pf-edge-e") || node.classList.contains("pf-edge-s"));
  }
  // The content-wrapper seam: writers target contentEl(host), never host.innerHTML, so the
  // persistent framework header and grips survive a wholesale re-render.
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

  function clearFillMarks(el) {
    if (!el || !el.classList) return;
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
    catch { return []; }
    var selectors = Array.isArray(choice) ? choice : [choice];
    for (var i = 0; i < selectors.length; i++) {
      if (typeof selectors[i] !== "string" || !selectors[i]) continue;
      try {
        var found = Array.prototype.slice.call(el.querySelectorAll(selectors[i]));
        if (found.length) return found;
      } catch (err) { DwfErr.report("panel-frame.fill-selector", err); }
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
    // Only mutate a marker when its membership actually changed: the class observer sees our own
    // writes, and an unconditional one feeds itself forever.
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

  var CLOSE_SEL = "[data-pf-close],[aria-label='Close'],.building-x,.build-close,.info-close," +
    ".unit-close-button,.chat-close,.chat-x,.hotkey-x,.combat-log-close";
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
    try { return wrap.querySelector(CLOSE_SEL); } catch { return null; }
  }

  // `closable` may be a predicate of the live element. Dropping a variant's close X without one
  // un-hides the generated title bar AND stacks a fresh framework X; a bad predicate falls back to true.
  function closableFor(spec, el) {
    if (!spec) return false;
    if (typeof spec.closable === "function") {
      try { return !!spec.closable(el || (spec.el && spec.el())); } catch { return true; }
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
    // A close-less variant must SHED an X a previous variant generated, or the stale one re-appears
    // the moment a later skin un-hides the bar.
    if (!closableFor(spec, el) || skinCloseFor(spec, el)) { removeGeneratedX(head); return; }
    makeX(spec, el, head);
  }

  function skinHeadFor(spec, el) {
    if (!spec || !spec.contentHost || !spec.adoptHeadSel) return null;
    var wrap = childByClass(el, "pf-content");
    if (!wrap || !wrap.querySelector) return null;
    var head;
    try { head = wrap.querySelector(spec.adoptHeadSel); } catch { return null; }
    // Adoption requires a CLOSABLE skin to provide its own close: hiding the bar hides its X. A
    // variant declared close-less has none to lose, so its header is adopted without one.
    if (!head || (closableFor(spec, el) && !skinCloseFor(spec, el))) return null;
    return head;
  }
  function reconcileHead(spec, el) {
    var generated = childByClass(el, "pf-head");
    var skin = skinHeadFor(spec, el);
    if (skin) {
      if (generated) {
      generated.hidden = true;
        // Only write when the value changes: an unconditional setAttribute queues a mutation record.
        if (generated.setAttribute && (!generated.getAttribute || generated.getAttribute("data-pf-adopted") !== "1"))
          generated.setAttribute("data-pf-adopted", "1");
      }
      if (skin.classList && !skin.classList.contains("pf-handle")) skin.classList.add("pf-handle");
      addDrag(spec, el, skin);
      return skin;
    }
    if (generated) {
      generated.hidden = false;
      if (generated.removeAttribute && generated.getAttribute && generated.getAttribute("data-pf-adopted") != null)
        generated.removeAttribute("data-pf-adopted");
    }
    return generated;
  }

  function loadedLayout() {
    return decodeLayout(DwfUtil.lsGet(LAYOUT_KEY));
  }
  function layoutState() {
    if (layoutPanels == null) layoutPanels = loadedLayout().panels;
    return layoutPanels;
  }
  function geometryEnabled(spec) { return !!spec && (spec.movable !== false || !!spec.resizable); }
  // Never freeze an untouched variant's CSS docking into inline geometry, and with `persistGeometry`
  // never write an entry nobody reads: a dead write is a stale rect waiting for a future reader.
  function persistBlocked(spec, lk, el) {
    if (spec.persistGeometry && el) {
      var keep;
      try { keep = !!spec.persistGeometry(el); } catch { keep = true; }
      if (!keep) return true;
    }
    return (spec.contentHost || spec.variantKey || spec.cssDocked) &&
      !dirty[lk] && !(lk in layoutState());
  }
  function rememberPanel(spec) {
    if (!geometryEnabled(spec)) return;
    var el = specEl(spec);
    var entry = el && geometryEntry(spec, el);
    if (!entry) return;
    var lk = layoutKeyFor(spec, el);
    if (persistBlocked(spec, lk, el)) return;
    if (spec.persistOpen !== false && spec.isOpen) entry.open = !!spec.isOpen();
    layoutState()[lk] = entry;
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
        if (persistBlocked(spec, lk, el)) return;
        var entry = geometryEntry(spec, el);
        if (entry) {
          if (spec.persistOpen !== false && spec.isOpen) entry.open = !!spec.isOpen();
          panels[lk] = entry;
        } else if (panels[lk] && spec.persistOpen !== false && spec.isOpen) {
          panels[lk].open = false;
        }
      });
      DwfUtil.lsSet(LAYOUT_KEY, encodeLayout(panels));
    }, 250);
  }
  function flushRememberedLayout() {
    if (!saveTimer) return;
    root.clearTimeout(saveTimer);
    saveTimer = 0;
    DwfUtil.lsSet(LAYOUT_KEY, encodeLayout(layoutState()));
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
    if (spec && !spec.resizable) return;
    el.style.width = round(cssSizeForRect(rect.w, styleFor(el).boxSizing, boxExtras(el, true))) + "px";
    el.style.height = round(cssSizeForRect(rect.h, styleFor(el).boxSizing, boxExtras(el, false))) + "px";
    el.style.maxHeight = "none";
  }
  function limitsFor(spec, el) {
    var inset = chromeInsets(el);
    var minW = spec.resizable && spec.resizable.minW;
    var minH = spec.resizable && spec.resizable.minH;
    return {
      minW: (typeof minW === "function" ? minW(el) : minW) || 0,
      minH: (typeof minH === "function" ? minH(el) : minH) || 0,
      top: inset.top, right: inset.right, bottom: inset.bottom, left: inset.left, head: HEAD_H,
    };
  }
  function clearRectStyles(el, includeZIndex) {
    var names = ["left", "top", "right", "bottom", "width", "height", "max-height"];
    if (includeZIndex) names.push("z-index");
    names.forEach(function (name) { el.style.removeProperty(name); });
  }
  function rectChanged(a, b) {
    return Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 ||
      Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5;
  }
  // A vertically docked panel is SIZED BY ITS EDGES: never give it an inline height and never
  // release one (`top:<px>; bottom:auto`) -- that leaves the panel measuring height 0.
  function vDockModeFor(el) {
    if (!el || !el.style) return "";
    if (el.style.height || el.style.bottom === "auto") return "";
    var style = styleFor(el);
    if (!style || !style.getPropertyValue) return "";
    if (String(style.getPropertyValue("--pf-vstretch")).trim() === "1") return "stretch";
    if (String(style.getPropertyValue("--pf-vdock-bottom")).trim() === "1") return "bottom";
    return "";
  }
  // Re-derive the stretch clamp from the CSS box every pass: a clamp made for a short window would
  // otherwise outlive it and the panel would never return to its dock.
  function releaseStretchV(el) {
    if (!el.dataset || el.dataset.pfStretchClamp !== "1") return;
    el.style.top = "";
    el.style.bottom = "";
    // The bottom dock shrinks with max-height, so its clamp is released the same way.
    el.style.maxHeight = "";
    el.dataset.pfStretchClamp = "0";
  }
  function clampStretchV(el, rect, viewport, limits, out) {
    var area = workArea(viewport, limits);
    var top = rect.y, bottom = rect.y + rect.h, clamped = false;
    if (top < area.top - 0.5) { top = area.top; el.style.top = round(top) + "px"; clamped = true; }
    if (bottom > area.bottom + 0.5) {
      bottom = area.bottom;
      el.style.bottom = round(Math.max(0, viewport.h - area.bottom)) + "px";
      clamped = true;
    }
    if (clamped && el.dataset) el.dataset.pfStretchClamp = "1";
    out.y = top;
    out.h = Math.max(0, bottom - top);
  }
  // A bottom-docked panel loses height from its TOP, via max-height: moving `top` would delete the
  // dock and stop the panel tracking the window.
  function clampBottomDockedV(el, rect, viewport, limits, out) {
    var area = workArea(viewport, limits);
    out.y = rect.y;
    out.h = rect.h;
    if (rect.h <= area.h + 0.5) return;
    el.style.maxHeight = round(area.h) + "px";
    if (el.dataset) el.dataset.pfStretchClamp = "1";
    out.h = area.h;
    out.y = Math.max(area.top, rect.y + rect.h - area.h);
  }
  function clampOpenRect(spec, el) {
    if (!visible(el) || !el.getBoundingClientRect) return null;
    var vdock = vDockModeFor(el);
    if (vdock) releaseStretchV(el);
    var stretched = vdock === "stretch";
    var viewport = viewportFor(el), limits = limitsFor(spec, el);
    var rect = rectFor(el), next = clampDockedRect(rect, viewport, limits);
    // Hold the measured values so the top/height writes below cannot fire on a declared vertical dock.
    if (vdock) { next.y = rect.y; next.h = rect.h; }
    if (rectChanged(rect, next)) {
      if (Math.abs(next.w - rect.w) > 0.5)
        el.style.width = round(cssSizeForRect(next.w, styleFor(el).boxSizing, boxExtras(el, true))) + "px";
      if (Math.abs(next.h - rect.h) > 0.5) {
        el.style.height = round(cssSizeForRect(next.h, styleFor(el).boxSizing, boxExtras(el, false))) + "px";
        el.style.maxHeight = "none";
      }
      if (Math.abs(next.x - rect.x) > 0.5) { el.style.left = round(next.x) + "px"; el.style.right = "auto"; }
      if (Math.abs(next.y - rect.y) > 0.5) { el.style.top = round(next.y) + "px"; el.style.bottom = "auto"; }
    }
    if (stretched) clampStretchV(el, rect, viewport, limits, next);
    else if (vdock === "bottom") clampBottomDockedV(el, rect, viewport, limits, next);
    return next;
  }
  function explicitRect(spec, el) {
    var rect = clampRect(rectFor(el), viewportFor(el), limitsFor(spec, el));
    applyRect(spec, el, rect);
    return rect;
  }
  // `visible(el)` speaks only for the element itself: a block element inside a display:none host
  // reads visible and measures 0x0, so the zero-size guard below refuses it before it is ever stored.
  function geometryEntry(spec, el) {
    if (!visible(el)) return null;
    var rect = rectFor(el);
    if (!(rect.w > 0) || !(rect.h > 0)) return null;
    return anchorForRect(rect, viewportFor(el));
  }
  function restore(spec, el, entry) {
    var viewport = viewportFor(el), limits = limitsFor(spec, el);
    var raw = rectFromEntry(entry, viewport);
    // clampRect does not inflate to minimums; floor a stale or corrupt save here.
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
      if (el) el.style.setProperty("--pf-z-index", String(z[key]));
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
        if (el && item.zBand !== false && index >= 0) el.style.setProperty("--pf-z-index", String(PF_Z_BASE + index));
      });
    }
    if (spec.escClosable) escStack = focusStack(escStack, key);
    restack();
  }

  function syncOpenState(key, isOpen) {
    var spec = registry[key], el = spec && specEl(spec);
    if (!enabled() || !spec || !el || !attached[key]) return;
    if (spec.contentHost) {
      // A host can change from one VISIBLE skin to another: clear inline geometry on variant change,
      // or the old skin's rect beats the new skin's CSS.
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
      return;
    }
    if (isOpen) {
      // layoutKeyFor, not the bare key: rememberPanel and saveSoon write under the variant key.
      var saved = geometryEnabled(spec) && layoutState()[layoutKeyFor(spec, el)];
      if (saved) restore(spec, el, saved); else clampOpenRect(spec, el);
      rememberPanel(spec);
      focus(key);
    } else {
      rememberPanel(spec);
      // layoutKeyFor, not the bare key -- symmetrical with the open path above.
      var closing = layoutState()[layoutKeyFor(spec, el)];
      if (spec.persistOpen !== false && closing) closing.open = false;
      escStack = escStack.filter(function (item) { return item !== key; });
    }
    saveSoon();
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
      close.textContent = "✕";   // MULTIPLICATION X (U+2715), not an ASCII x
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
    el.insertBefore(head, el.firstChild);
    return head;
  }

  // One drag runner for both grabs. `threshold` 0 means the press IS the drag; above it the press
  // stays a plain click until the pointer travels that far, which is what makes grab-anywhere safe.
  var DRAG_THRESHOLD = 4;

  function setDragging(on) {
    var docEl = root.document && root.document.documentElement;
    if (!docEl || !docEl.classList) return;
    if (on) {
      if (!docEl.classList.contains("pf-dragging")) docEl.classList.add("pf-dragging");
      // A grab that began over text would otherwise paint a growing selection under the cursor.
      try { var sel = root.getSelection && root.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges(); }
      catch (err) { DwfErr.report("panel-frame.selection-clear", err); }
    } else if (docEl.classList.contains("pf-dragging")) docEl.classList.remove("pf-dragging");
  }

  // A committed drag must not also fire the click its pointerdown started, or dropping a panel on
  // a list row selects that row.
  function swallowNextClick() {
    var doc = root.document;
    if (!doc || !doc.addEventListener) return;
    function swallow(event) {
      event.preventDefault();
      event.stopPropagation();
      doc.removeEventListener("click", swallow, true);
    }
    doc.addEventListener("click", swallow, true);
    root.setTimeout(function () { doc.removeEventListener("click", swallow, true); }, 0);
  }

  function runDrag(spec, el, event, captureNode, listenOn, threshold) {
    // Document-level tracking must run in the CAPTURE phase: panels that swallow pointer events on
    // their own container would otherwise eat the pointerup and the drag would never end.
    var phase = listenOn === root.document;
    var pointerStart = { x: event.clientX, y: event.clientY };
    var start = null, pending = null, raf = 0, engaged = false;
    function engage() {
      engaged = true;
      focus(spec.key);
      start = explicitRect(spec, el);
      try { captureNode.setPointerCapture(event.pointerId); }
      catch { /* dragging continues from document listeners without capture */ }
      setDragging(true);
    }
    function move(ev) {
      if (!engaged) {
        if (Math.abs(ev.clientX - pointerStart.x) < threshold &&
            Math.abs(ev.clientY - pointerStart.y) < threshold) return;
        engage();
      }
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
      listenOn.removeEventListener("pointermove", move, phase);
      listenOn.removeEventListener("pointerup", end, phase);
      listenOn.removeEventListener("pointercancel", end, phase);
      if (raf) { root.cancelAnimationFrame(raf); raf = 0; }
      if (!engaged) return;          // a plain click: nothing moved, nothing to remember
      setDragging(false);
      swallowNextClick();
      markDirty(spec, el);
      rememberPanel(spec);
      saveSoon();
    }
    if (threshold <= 0) { event.preventDefault(); event.stopPropagation(); engage(); }
    listenOn.addEventListener("pointermove", move, phase);
    listenOn.addEventListener("pointerup", end, phase);
    listenOn.addEventListener("pointercancel", end, phase);
  }

  function addDrag(spec, el, head) {
    if (!head || spec.movable === false || head.dataset.pfDragBound === "1") return;
    head.dataset.pfDragBound = "1";
    head.addEventListener("pointerdown", function (event) {
      if (!enabled() || !attached[spec.key]) return;
      if (event.button != null && event.button !== 0) return;
      if (event.target && event.target.closest && event.target.closest("button,input,select,a,[data-pf-nodrag]")) return;
      runDrag(spec, el, event, head, head, 0);
    });
  }

  // ---- UI-DIV-004: THE CHROMELESS DRAG-ANYWHERE SURFACE ------------------------------------------
  // APPROVED BLANKET DIVERGENCE (JT 2026-07-28, docs/reference/divergence-register.md UI-DIV-004):
  // every registered panel is draggable and remembers where the player left it. Native docks its
  // panels at fixed coordinates; DWF is played by several people at once, on different screens, so
  // each player arranges their own view.
  //
  // WHY THIS LIVES HERE, GENERICALLY, AND NOT AS A PER-PANEL HANDLE. The parity campaign correctly
  // deleted the framework's generated title bar from the native-chrome screens (the reports window's
  // "Info" bar was an invented widget -- ledger 0016 P1/P2 read the announcements widget tree as
  // exactly a tab strip over a report list). Drag went with it, because drag was welded to that bar.
  // Re-adding a bar to get drag back would re-add the parity bug. So the affordance becomes
  // CHROMELESS, exactly like the resize grips already are: no pixels, no title, no ✕ -- the panel
  // body itself is the handle. Visual parity is untouched; only behavior diverges.
  //
  // THE THREE THINGS THAT MAKE "GRAB ANYWHERE" SAFE:
  //   1. A REFUSAL SET (below). Real controls, editable text, and scrollbar gutters are never a
  //      drag surface -- a press there is theirs.
  //   2. A CLICK-VS-DRAG THRESHOLD. Under DRAG_THRESHOLD px the gesture is still a click and the
  //      framework has written nothing at all; past it the panel moves and the resulting click is
  //      swallowed. Every existing click target keeps working untouched.
  //   3. MOUSE AND PEN ONLY. A touch drag would have to preventDefault the browser's scroll gesture
  //      at pointerdown -- i.e. `touch-action: none` on whole panel bodies, which would kill
  //      scrolling inside every list. Touch keeps the header/handle grab. Recorded as a known limit
  //      in the register entry rather than faked.
  var SURFACE_NODRAG_SEL = "button,a,input,select,textarea,label,summary,option," +
    "[contenteditable],[data-pf-nodrag],[role='button'],[role='tab'],[role='checkbox']," +
    "[role='radio'],[role='slider'],[role='textbox'],[role='option'],[role='spinbutton']," +
    ".pf-grip,.pf-edge-e,.pf-edge-s,.pf-head,.pf-handle,.pf-x," +
    "[data-dwfui-list-bar]";

  // clientWidth/Height exclude the scrollbar gutter, so a press beyond them inside the border box
  // belongs to the scrollbar.
  function onScrollbarGutter(node, event) {
    if (!node || node.nodeType !== 1 || !node.getBoundingClientRect) return false;
    var vertical = node.scrollHeight > node.clientHeight;
    var horizontal = node.scrollWidth > node.clientWidth;
    if (!vertical && !horizontal) return false;
    var rect = node.getBoundingClientRect();
    if (vertical && event.clientX > rect.left + node.clientWidth) return true;
    if (horizontal && event.clientY > rect.top + node.clientHeight) return true;
    return false;
  }
  function surfaceDragRefused(el, event) {
    var target = event.target;
    if (!target || target.nodeType !== 1) return true;
    try { if (target.closest && target.closest(SURFACE_NODRAG_SEL)) return true; } catch { return true; }
    for (var node = target; node && node !== el.parentElement; node = node.parentElement)
      if (onScrollbarGutter(node, event)) return true;
    return false;
  }
  function addSurfaceDrag(spec, el) {
    if (!el || spec.movable === false || el.dataset.pfSurfaceDragBound === "1") return;
    el.dataset.pfSurfaceDragBound = "1";
    el.addEventListener("pointerdown", function (event) {
      if (!enabled() || !attached[spec.key]) return;
      if (event.button != null && event.button !== 0) return;
      if (event.pointerType === "touch") return;   // touch keeps the header/handle grab
      if (surfaceDragRefused(el, event)) return;
      // Deliberately NO preventDefault/stopPropagation here: until the threshold is crossed this
      // press must still reach whatever the panel put underneath it.
      runDrag(spec, el, event, el, root.document, DRAG_THRESHOLD);
    });
  }

  // ---- the chrome layer is framework-owned -----------------------------------------------------
  var CHROME_PARTS = [
    ["pf-edge-e", "e"],
    ["pf-edge-s", "s"],
    ["pf-grip pf-grip-nw", "nw"],
    ["pf-grip pf-grip-ne", "ne"],
    ["pf-grip pf-grip-sw", "sw"],
    ["pf-grip pf-grip-se", "se"]
  ];

  // A host that refuses pointer events has said it is not a surface: resize chrome pinned to its
  // corners lands where nothing is and cannot be grabbed. Reconciled per pass, never decided once.
  function isSurface(el) {
    var style = styleFor(el);
    return !style || String(style.pointerEvents) !== "none";
  }
  function resizeChromeWanted(spec, el) { return !!spec.resizable && isSurface(el); }
  function removeResize(el) {
    el.classList.remove("pf-resizable");
    el.querySelectorAll(".pf-grip,.pf-edge-e,.pf-edge-s").forEach(function (node) { node.remove(); });
    // `pfGripScrollBound` is deliberately LEFT SET: its listener is anonymous and unremovable, and
    // the mark is what stops a remove/re-add cycle stacking a second copy of it.
  }
  function reconcileResize(spec, el) {
    if (!spec.resizable) return;
    if (!resizeChromeWanted(spec, el)) {
      if (el.querySelector(".pf-grip,.pf-edge-e,.pf-edge-s") || el.classList.contains("pf-resizable"))
        removeResize(el);
      return;
    }
    if (!el.classList.contains("pf-resizable")) el.classList.add("pf-resizable");
    addResize(spec, el);
  }

  function addResize(spec, el) {
    if (!resizeChromeWanted(spec, el) || el.querySelector(".pf-grip,.pf-edge-e,.pf-edge-s")) return;
    el.classList.add("pf-resizable");
    // Edges first, corners last: at equal z the later sibling wins hit-testing.
    CHROME_PARTS.forEach(function (part) {
      var grip = root.document.createElement("div");
      grip.className = part[0];
      el.appendChild(grip);
      grip.addEventListener("pointerdown", function (event) {
        if (!enabled() || !attached[spec.key]) return;
        if (event.button != null && event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); focus(spec.key);
        var start = explicitRect(spec, el), pointerStart = { x: event.clientX, y: event.clientY }, pending = null, raf = 0;
        try { grip.setPointerCapture(event.pointerId); }
        catch { /* resizing continues from document listeners without capture */ }
        function paintPending() {
          if (!pending) return;
          var latest = pending;
          pending = null;
          var raw = resizeByVisual(start, pointerStart, { x: latest.clientX, y: latest.clientY }, effectiveZoom(el), part[1]);
          // Probe the prospective width inside this frame because narrowing can wrap a footer
          // and raise minH. Measure again before the final rect; the probe is never painted.
          var viewport = viewportFor(el), limits = limitsFor(spec, el);
          if (/[ew]/.test(part[1])) {
            var probe = clampResizeRect(start, raw, part[1], viewport,
              { minW: limits.minW, minH: 0, top: limits.top, right: limits.right,
                bottom: limits.bottom, left: limits.left, head: limits.head });
            probe.y = start.y; probe.h = start.h;
            applyRect(spec, el, probe);
            limits = limitsFor(spec, el);
          }
          applyRect(spec, el, clampResizeRect(start, raw, part[1], viewport, limits));
        }
        function move(ev) {
          pending = ev;
          if (raf) return;
          raf = root.requestAnimationFrame(function () {
            raf = 0;
            paintPending();
          });
        }
        function end() {
          grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", end); grip.removeEventListener("pointercancel", end);
          if (raf) { root.cancelAnimationFrame(raf); raf = 0; }
          // A quick move-and-release can happen before the scheduled frame. The release must flush
          // that last pointer sample, not cancel the player's entire resize.
          paintPending();
          markDirty(spec, el);
          rememberPanel(spec);
          saveSoon();
        }
        grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end);
      });
    });
    // Some hosts scroll at the element level, so absolute children would scroll away with the
    // content; translating by the live scroll offset pins every grip to the visible corners.
    if (el.dataset.pfGripScrollBound !== "1") {
      el.dataset.pfGripScrollBound = "1";
      el.addEventListener("scroll", function () {
        var t = (el.scrollLeft || el.scrollTop) ? "translate(" + el.scrollLeft + "px," + el.scrollTop + "px)" : "";
    el.querySelectorAll(".pf-grip,.pf-edge-e,.pf-edge-s").forEach(function (node) {
      node.style.setProperty("--pf-resize-transform", t);
    });
      }, { passive: true });
    }
  }

  function closePanel(spec) {
    rememberPanel(spec);
    if (spec.close) spec.close();
    if (spec.persistOpen !== false && layoutState()[spec.key]) layoutState()[spec.key].open = false;
    escStack = escStack.filter(function (key) { return key !== spec.key; });
    saveSoon();
  }

  // Idempotent: the pf*Bound datasets stop repeat calls double-binding, and contentEl reuses its wrapper.
  function buildChrome(spec, el) {
    var head = spec.headSel ? el.querySelector(spec.headSel) : null;
    // `chromeless: true` means movable with NO generated title bar: the panel is dragged by its own
    // body and paints nothing the native screen does not own.
    if (spec.movable !== false && !spec.chromeless) head = head || newHead(spec, el);
    if (head && !head.classList.contains("pf-handle")) head.classList.add("pf-handle");
    reconcileX(spec, el, head);
    addDrag(spec, el, head);
    addSurfaceDrag(spec, el);   // UI-DIV-004: every panel is draggable, with or without a handle
    reconcileResize(spec, el);  // ...but only a SURFACE wears resize chrome (see isSurface)
    if (spec.contentHost) {
      contentEl(el);   // ensure the wrapper exists after the head/grips
      var adopted = reconcileHead(spec, el);
      if (adopted) head = adopted;
    }
    reconcileFill(spec, el);
    return head;
  }

  // A writer that bypasses panelContent() and writes host.innerHTML destroys the framework header;
  // the heal observer rebuilds it. SETTLE_BUDGET passes without a frame disconnects a divergent loop.
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
    // Bitmap labels mount and unmount a <canvas> as rows scroll, so a batch that is ENTIRELY label
    // churn is dropped before the settle budget sees it -- it says nothing about panel structure.
    function isLabelChurn(record) {
      var target = record && record.target;
      return !!(target && target.nodeType === 1 && target.closest &&
        target.closest("[data-dwfui-bitmap-text]"));
    }
    function budgeted(reconcile, ignorable) {
      return function (records) {
        if (!attached[spec.key] || !enabled() || state.settleTripped) return;
        if (ignorable && records && records.length && Array.prototype.every.call(records, ignorable))
          return;
        // A frame boundary is the "settled" signal; a spinning microtask loop never reaches one, which
        // is why the budget counts passes per frame instead of trusting a timer.
        if (state.settlePasses === 0 && root.requestAnimationFrame)
          root.requestAnimationFrame(function () { state.settlePasses = 0; });
        state.settlePasses++;
        if (state.settlePasses > SETTLE_BUDGET) {
          state.settleTripped = true;
          state.observers.forEach(function (o) {
            try { o.disconnect(); } catch (err) { DwfErr.report("panel-frame.observer-disconnect", err); }
          });
          try {
            root.console.error("[DFPanelFrame] settle budget exceeded for panel '" + spec.key +
              "': a reconciler is not converging; observers disconnected, re-arming next frame.");
          } catch { /* the settle guard remains armed even when console access fails */ }
          if (root.requestAnimationFrame) root.requestAnimationFrame(function () {
            if (attached[spec.key] !== state || !state.observers || !enabled()) return;
            state.settlePasses = 0;
            state.settleTripped = false;
            observeAll();
            // Catch up on what the disconnected window missed; reconcilers are convergent either way.
            reconcilePanel();
          });
          return;
        }
        reconcile();
      };
    }
    function reconcilePanel() {
      reconcileResize(spec, el);
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
        try { root.console && root.console.warn("[DFPanelFrame] direct innerHTML write to #" + (el.id || spec.key) + " bypassed panelContent(); framework header re-healed. Convert this writer to panelContent()."); }
        catch { /* the healed header remains authoritative when console access fails */ }
      }
      state.head = buildChrome(spec, el);
      var lk = layoutKeyFor(spec, el), saved = layoutState()[lk];
      if (visible(el) && saved && (dirty[lk] || (lk in layoutState()))) restore(spec, el, saved);
    }));

    var xsync = new root.MutationObserver(budgeted(reconcilePanel, isLabelChurn));

    var cls = new root.MutationObserver(budgeted(function () {
      reconcileResize(spec, el);
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


  // Close-only registrations have no consumer sync hook; observe the open class instead.
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
        // Geometry persists, open-state does not: restore only if already open, never auto-open.
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
  }

  function detach(key) {
    var state = attached[key];
    if (!state) return;
    var spec = registry[key], el = state.el;
    if (state.observers) {
      state.observers.forEach(function (o) {
        try { o.disconnect(); } catch (err) { DwfErr.report("panel-frame.observer-disconnect", err); }
      });
      state.observers = null;
    }
    if (state.openObserver) {
      try { state.openObserver.disconnect(); }
      catch (err) { DwfErr.report("panel-frame.open-observer-disconnect", err); }
      state.openObserver = null;
    }
    if (el) clearRectStyles(el, true);
    if (state.head) state.head.classList.remove("pf-handle");
    // an adopted skin header carries pf-handle too; strip it from every carrier.
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

  function escCloseTopmost() {
    if (!enabled()) return false;
    var candidates = Object.keys(registry).filter(function (key) {
      var spec = registry[key];
      return attached[key] && spec.escClosable && spec.isOpen && spec.isOpen();
    });
    if (!candidates.length) return false;
    // Registered order is the deterministic Esc fallback until the user gives a panel focus.
    candidates.forEach(function (key) { if (escStack.indexOf(key) < 0) escStack.push(key); });
    var key = escStack.filter(function (item) { return candidates.indexOf(item) >= 0; }).pop();
    if (!key) key = candidates[candidates.length - 1];
    closePanel(registry[key]);
    return true;
  }

  function resetAll() {
    DwfUtil.lsRemove(LAYOUT_KEY);
    layoutPanels = {};
    dirty = Object.create(null);
    Object.keys(registry).forEach(function (key) {
      var spec = registry[key], el = specEl(spec);
      if (!el || !attached[key]) return;
      clearRectStyles(el, true);
      if (spec.defaultPos && (!spec.isOpen || spec.isOpen())) {
        var viewport = viewportFor(el), pos = spec.defaultPos(viewport.w, viewport.h);
        if (pos && finite(pos.x) && finite(pos.y) && finite(pos.w) && finite(pos.h)) restore(spec, el, pos);
      }
    });
    order = [];
    escStack = [];
  }

  function register(spec) {
    if (!spec || !spec.key || typeof spec.el !== "function") return;
    registry[spec.key] = spec;
    if (enabled()) attach(spec);
  }

  function setEnabled(on) {
    DwfUtil.lsSet(ENABLED_KEY, on ? "1" : "0");
    if (on) Object.keys(registry).forEach(function (key) { attach(registry[key]); });
    else Object.keys(attached).forEach(detach);
  }

  if (hasDom) {
    root.addEventListener("resize", function () {
      if (!enabled()) return;
      flushRememberedLayout();
      Object.keys(attached).forEach(function (key) {
        var spec = registry[key], el = specEl(spec);
        if (!el || !visible(el)) return;
        // A remembered panel has an unconstrained source rect: reconstruct from it on every window
        // size change, so the full saved size returns when room does.
        var saved = geometryEnabled(spec) && layoutState()[layoutKeyFor(spec, el)];
        if (saved) restore(spec, el, saved);
        else clampOpenRect(spec, el);
      });
    });
  }

  var api = {
    register: register, escCloseTopmost: escCloseTopmost, resetAll: resetAll,
    setEnabled: setEnabled, chromeInsets: chromeInsets,
    syncOpenState: syncOpenState, contentEl: contentEl,
    _pure: PURE,
  };
  Object.defineProperty(api, "enabled", { enumerable: true, get: enabled });
  root.DFPanelFrame = api;
  if (typeof module !== "undefined" && module.exports) module.exports = PURE;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
