// The existing search palette, lazy on every app page: navigation, people, DMs, keyboard and CSP.
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, body) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const run = Date.now().toString(36), A = `pal${run}`, B = `peer${run}`;
for (const name of [A, B]) await ops("users", { name, email: `${name}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: A, title: `Palette Atlas ${run}` })).board.id;
await ops("members", { board, user: B });
const cookie = (await ops("sessions", { user: A })).cookie;
const peerCookie = (await ops("sessions", { user: B })).cookie;
const post = async (path, ck, body = {}) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw Error(`${path}: ${JSON.stringify(j)}`); return j;
};
await post("/api/friends/request", cookie, { user: B });
await post(`/api/friends/${A}/accept`, peerCookie);
const dm = await post(`/api/direct/${B}`, cookie);
let fails = 0;
const check = (ok, message) => { console.log(`${ok ? "✓" : "✗"} ${message}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 } });
  const [name, ...value] = cookie.split(";")[0].split("=");
  await ctx.addCookies([{ name, value: value.join("="), url: BASE }]);
  // Exercise the lazy assets under the page's enforcing policy, including nonces.
  await ctx.route(`${BASE}/**`, async route => {
    const response = await route.fetch(), headers = response.headers();
    if (headers["content-security-policy-report-only"]) {
      headers["content-security-policy"] = headers["content-security-policy-report-only"];
      delete headers["content-security-policy-report-only"];
    }
    await route.fulfill({ response, headers });
  });
  const p = await ctx.newPage(), errors = [], requests = [];
  p.on("pageerror", e => errors.push(e.message));
  await p.exposeFunction("paletteViolation", directive => errors.push(`CSP: ${directive}`));
  p.on("request", r => requests.push(new URL(r.url()).pathname));
  await p.addInitScript(() => document.addEventListener("securitypolicyviolation", e => window.paletteViolation(e.violatedDirective)));
  await p.goto(`${BASE}/for-you`);
  await p.waitForFunction(() => typeof window.openPalette === "function");
  check(!await p.locator("#palette").count() && !requests.some(x => x.startsWith("/palette.")), `${width}: no palette markup or assets before opening`);
  const open = async (key = "Meta+k") => { await p.keyboard.press(key); await p.locator("#palette[open]").waitFor(); };
  await open();
  const q = p.locator("#palette-q"), rows = p.locator('#palette-list [role="option"]');
  check(await q.evaluate(el => document.activeElement === el && el.getAttribute("role") === "combobox") && await p.locator('#palette[role="dialog"][aria-modal="true"]').count() === 1, `${width}: ⌘K opens a modal with focused combobox`);
  const destinations = await rows.allTextContents();
  check(["For you", "Inbox", "Approvals", "Boards", "People", "Guide", "Settings"].every(label => destinations.some(x => x.includes(label))), `${width}: page destinations are available`);
  await p.keyboard.press("Shift+Tab");
  check(await p.evaluate(() => !!document.activeElement.closest("#palette")), `${width}: Shift+Tab stays in the dialog`);
  await p.keyboard.press("Tab");
  check(await q.evaluate(el => document.activeElement === el), `${width}: Tab cycles back to the input`);
  await q.fill("Atlas");
  check(await until(async () => (await rows.allTextContents()).some(x => x.includes(`Palette Atlas ${run}`))), `${width}: substring finds joined boards`);
  await q.fill("stng");
  check(await until(async () => (await rows.first().innerText()).includes("Settings")), `${width}: fuzzy-light matches Settings`);
  await q.fill("");
  const first = await q.getAttribute("aria-activedescendant");
  await p.keyboard.press("ArrowDown");
  check(await q.getAttribute("aria-activedescendant") !== first, `${width}: Down moves the active option`);
  await p.keyboard.press("ArrowUp");
  check(await q.getAttribute("aria-activedescendant") === first, `${width}: Up moves back`);
  await q.fill(B);
  check(await until(async () => (await rows.allTextContents()).some(x => x.includes(`@${B}`))), `${width}: existing people endpoint supplies profiles`);
  check((await rows.allTextContents()).some(x => x.includes("(direct)")), `${width}: joined DMs are searchable`);
  await rows.filter({ hasText: `@${B}` }).click();
  await p.waitForURL(`${BASE}/u/${B}`);
  check(new URL(p.url()).pathname === `/u/${B}`, `${width}: person opens the existing profile route`);
  await open("Control+k");
  await q.fill(B);
  await rows.filter({ hasText: "(direct)" }).click();
  await p.waitForURL(`${BASE}/b/${dm.board}`);
  check(new URL(p.url()).pathname === `/b/${dm.board}`, `${width}: DM opens its existing board`);
  await p.locator("#composer-text").focus();
  await open("Control+k");
  await p.keyboard.press("Escape");
  await p.locator("#palette").waitFor({ state: "hidden" });
  check(await p.locator("#composer-text").evaluate(el => document.activeElement === el), `${width}: Esc closes and restores focus`);
  await open();
  await q.fill("Inbox");
  await p.keyboard.press("Enter");
  await p.waitForURL(`${BASE}/inbox`);
  check(new URL(p.url()).pathname === "/inbox", `${width}: Enter navigates to the selected page`);
  check(!errors.length, `${width}: no JS errors or CSP violations: ${errors.join(" | ")}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "palette: all passed");
process.exitCode = fails ? 1 : 0;
