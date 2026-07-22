// Live, read-only browser smoke test for the Creatures panel.
//
// Requires a running local Dwarf With Friends server and DWF_JOIN_PASSWORD in the environment.
// The shared CDP driver always launches an isolated, headless, muted Chrome profile.

import { CdpProbe, delay } from "./cdp_probe.mjs";

const baseUrl = process.env.DWF_BASE_URL || "http://127.0.0.1:8765";
const password = process.env.DWF_JOIN_PASSWORD || "";
const player = process.env.DWF_TEST_PLAYER || "codex-creature-tabs";
const probe = new CdpProbe({ width: 1600, height: 1000 });
let page;

async function click(selector) {
  const point = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      width: rect.width, height: rect.height };
  })()`);
  if (!point || point.width <= 0 || point.height <= 0)
    throw new Error(`element is not clickable: ${selector}`);
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
}

async function joinIfNeeded() {
  await page.waitFor(
    `document.querySelector("#dfcapJoinName") || document.querySelector("#view")`,
    { timeoutMs: 15000, message: "join screen or game canvas" },
  );
  if (!await page.evaluate(`!!document.querySelector("#dfcapJoinOverlay")`)) return;
  await page.evaluate(`(() => {
    const name = document.querySelector("#dfcapJoinName");
    const pass = document.querySelector("#dfcapJoinPass");
    name.value = ${JSON.stringify(player)};
    name.dispatchEvent(new Event("input", { bubbles: true }));
    if (pass) pass.value = ${JSON.stringify(password)};
  })()`);
  await click("[data-dfcj-join]");
  await page.waitFor(`!document.querySelector("#dfcapJoinOverlay")`, {
    timeoutMs: 15000, message: "successful join",
  });
}

async function inspectActiveTab() {
  return page.evaluate(`(() => {
    const panel = document.querySelector("#clientPanel");
    const rows = Array.from(panel?.querySelectorAll(".creature-row") || []);
    const portraits = Array.from(panel?.querySelectorAll("img.native-portrait-img") || []);
    const active = Array.from(panel?.querySelectorAll("[data-info-detail]") || [])
      .find(element => element.classList.contains("active") ||
        element.getAttribute("aria-selected") === "true");
    return {
      active: active?.dataset.infoDetail || "",
      rows: rows.length,
      portraits: portraits.length,
      brokenPortraits: portraits.filter(img => img.complete &&
        (!img.naturalWidth || !img.naturalHeight)).length,
      pendingPortraits: portraits.filter(img => !img.complete).length,
      portraitIdentityMissing: panel?.querySelectorAll(
        '[data-df-identity-missing^="portrait:"]',
      ).length || 0,
      unresolvedIdentity: Array.from(panel?.querySelectorAll("[data-df-identity-missing]") || [])
        .map(element => ({
          reason: element.getAttribute("data-df-identity-missing"),
          unitId: element.closest(".creature-row")?.dataset.unitId || "",
          rowText: (element.closest(".creature-row")?.textContent || "").trim()
            .replace(/\s+/g, " ").slice(0, 160),
        })),
      messages: Array.from(panel?.querySelectorAll(".info-message") || [])
        .map(element => (element.textContent || "").trim()).filter(Boolean),
    };
  })()`);
}

try {
  await probe.start();
  page = await probe.newPage({ url: `${baseUrl}/view?player=${encodeURIComponent(player)}`, settleMs: 2500 });
  await joinIfNeeded();

  // Authenticated reload verifies that reconnecting does not return to the join screen and also
  // gives protected images a clean request cycle after the cookie has been established.
  page.errors.length = 0;
  await page.send("Page.reload", { ignoreCache: true });
  await page.waitFor(
    `document.querySelector("#view") && !document.querySelector("#dfcapJoinOverlay")`,
    { timeoutMs: 20000, message: "authenticated game reload" },
  );
  await delay(2500);

  await click('button[data-panel="citizens"]');
  await page.waitFor(`document.querySelectorAll("[data-info-detail]").length >= 4`, {
    timeoutMs: 15000, message: "creature detail tabs",
  });
  const definitions = await page.evaluate(`Array.from(document.querySelectorAll("[data-info-detail]"))
    .map(element => ({ id: element.dataset.infoDetail, label: (element.textContent || "").trim() }))`);
  const tabs = [];
  for (const definition of definitions) {
    await click(`[data-info-detail="${definition.id}"]`);
    await delay(1800);
    tabs.push({ ...definition, ...await inspectActiveTab() });
  }
  const health = await page.evaluate(`fetch("/diag", { cache: "no-store" })
    .then(response => response.json()).then(data => ({
      overall: data.overall, wsDrops: data.wsDrops,
    }))`);
  const failures = tabs.filter(tab => tab.active !== tab.id || tab.brokenPortraits ||
    tab.pendingPortraits || tab.portraitIdentityMissing);
  console.log(JSON.stringify({ ok: failures.length === 0, tabs, health, pageErrors: page.errors }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await probe.stop();
}
