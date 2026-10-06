// Phone sidebars close easily (jxn #2223, claude #2225): the menu drawer and the board's info panel each close with an ✕
// in their header (the info panel's button turns into one), Esc, and a swipe back toward their edge (the drawer also with a tap on the dimmed page beside it),
// focus goes back to the button that opened them, and neither is open again after a reload. 390 and 320px, Developer
// and Everyday. Board info closes with a swipe in the reading direction: to the right in English, to the left in Arabic
// (jxn #2446). The menu drawer's swipe is its own gesture. Usage: BASE=http://localhost:8787 PW_CHROME=… node sidebar-close.mjs  (local dev only, ADMIN_KEY=ci-admin-key)
import { chromium } from "playwright-core";
import { until, stable } from "./lib/wait.mjs";
// Fast (opus-a #2937): loads wait for the page's script, opening and closing wait for the drawer or panel to get there
// and stop moving; short fixed waits stay only where nothing should happen (a swipe that must leave a panel open).
const loaded = (p) => p.waitForFunction(() => document.readyState === "complete" && document.getElementById("app"));
const settled = (p, sel) => stable(() => p.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? [r.left, r.width] : null; }, sel), 2000, 60);
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), D = `sd${run}`, E = `se${run}`;
await ops("users", { name: D, email: `${D}@example.com`, verified: "true", display: { mode: "developer" } });
await ops("users", { name: E, email: `${E}@example.com`, verified: "true", display: { mode: "everyday" } });
const board = (await ops("boards", { user: D, title: `Sidebars ${run}` })).board.id;
await ops("members", { board, user: E });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
// A one-finger swipe, as touch events on the element (dx to the right when positive).
const swipe = (p, sel, dx) => p.evaluate(({ sel, dx }) => {
  const el = document.querySelector(sel), r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + Math.min(200, r.height / 2);
  const t = (cx) => new Touch({ identifier: 1, target: el, clientX: cx, clientY: y });
  el.dispatchEvent(new TouchEvent("touchstart", { touches: [t(x)], changedTouches: [t(x)], bubbles: true }));
  el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [t(x + dx)], bubbles: true }));
}, { sel, dx });
// The four phone setups, the wide screen and Arabic run side by side (each its own context; nothing they do touches the others).
const cookies = { [D]: (await ops("sessions", { user: D })).cookie, [E]: (await ops("sessions", { user: E })).cookie };
await Promise.all([...[[D, "Developer"], [E, "Everyday"]].flatMap(([who, mode]) => [390, 320].map((w) => phone(who, mode, w))), wide(), arabic()]);
async function phone(who, mode, w) {
  const ck = cookies[who];
  {
    const tag = `${mode} ${w}px`;
    const ctx = await b.newContext({ viewport: { width: w, height: 760 }, isMobile: true, hasTouch: true });
    const [k, ...v] = ck.split(";")[0].split("=");
    await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${BASE}/b/${board}`);
    await loaded(p);
    const navOpen = () => p.evaluate(() => document.getElementById("app").classList.contains("nav-open"));
    const sbIn = () => p.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().left >= -1);
    const focused = (sel) => p.evaluate((sel) => document.activeElement === document.querySelector(sel), sel);
    const menu = p.locator(".menu-btn");
    const openNav = async () => { await menu.tap(); await until(navOpen, 2000); await settled(p, "#sidebar"); };
    // The drawer.
    check(await p.locator("#sidebar").evaluate((el) => el.inert), `${tag}: the closed off-screen menu is inert`);
    await menu.focus(); await p.keyboard.press("Tab");
    check(!(await p.evaluate(() => document.getElementById("sidebar").contains(document.activeElement))), `${tag}: Tab skips the closed off-screen menu`);
    await openNav();
    check(await navOpen() && await sbIn() && !(await p.locator("#sidebar").evaluate((el) => el.inert)) && await p.locator(".nav-x").isVisible() && await p.locator(".nav-scrim").isVisible() && await focused(".nav-x") && (await menu.getAttribute("aria-expanded")) === "true",
      `${tag}: the menu opens with an ✕, the page dimmed beside it, and focus on the ✕`);
    await p.locator(".nav-x").tap(); await until(async () => !(await navOpen()), 2000); await settled(p, "#sidebar");
    check(!(await navOpen()) && !(await sbIn()) && await p.locator("#sidebar").evaluate((el) => el.inert) && await focused(".menu-btn") && (await menu.getAttribute("aria-expanded")) === "false", `${tag}: ✕ closes it, makes it inert, and focus goes back to the menu button`);
    await openNav();
    await p.touchscreen.tap(w - 20, 500); await until(async () => !(await navOpen()), 2000);
    check(!(await navOpen()), `${tag}: a tap on the dimmed page beside it closes it`);
    await openNav();
    await p.keyboard.press("Escape"); await until(async () => !(await navOpen()), 2000);
    check(!(await navOpen()) && await focused(".menu-btn"), `${tag}: Esc closes it`);
    await openNav();
    await swipe(p, "#sidebar", -120); await until(async () => !(await navOpen()), 2000); await settled(p, "#sidebar");
    check(!(await navOpen()), `${tag}: a swipe back to the left closes it`);
    await swipe(p, "#sidebar", -10); await p.waitForTimeout(100); // (a small move on a closed drawer does nothing)
    await openNav();
    await p.reload(); await loaded(p); await settled(p, "#sidebar");
    check(!(await navOpen()) && !(await sbIn()), `${tag}: after a reload the menu is closed`);
    // The board's info panel.
    const infoOpen = () => p.evaluate(() => document.getElementById("conv-layout").classList.contains("info-open"));
    const openInfo = async () => { await p.locator("#info-btn").tap(); await until(infoOpen, 2000); await settled(p, "#board-info"); };
    await openInfo();
    const ib = p.locator("#info-btn");
    const x = await ib.evaluate((el) => getComputedStyle(el, "::after").content);
    check(await infoOpen() && await ib.isVisible() && x.includes("✕") && (await ib.getAttribute("aria-label")) === "Close board info" && await focused("#info-btn"), `${tag}: board info opens, its button turns into an ✕ (${x}), with focus on it`);
    await ib.tap(); await until(async () => !(await infoOpen()), 2000);
    check(!(await infoOpen()) && await focused("#info-btn") && (await p.locator("#info-btn").getAttribute("aria-expanded")) === "false", `${tag}: ✕ closes board info and focus goes back to its button`);
    await openInfo();
    await p.keyboard.press("Escape"); await until(async () => !(await infoOpen()), 2000);
    check(!(await infoOpen()) && await focused("#info-btn"), `${tag}: Esc closes board info`);
    await openInfo();
    await swipe(p, "#board-info", -140); await p.waitForTimeout(300);
    check(await infoOpen(), `${tag}: a swipe to the left leaves board info open`);
    await swipe(p, "#board-info", 140); await until(async () => !(await infoOpen()), 2000);
    check(!(await infoOpen()), `${tag}: a swipe to the right closes board info`);
    await openInfo();
    await swipe(p, "#board-info", 0); await p.waitForTimeout(200);
    check(await infoOpen(), `${tag}: a tap inside board info leaves it open`);
    await p.reload(); await loaded(p);
    check(!(await infoOpen()), `${tag}: after a reload board info is closed`);
    // Elsewhere (home) the drawer works the same.
    await p.goto(`${BASE}/`); await loaded(p);
    await openNav();
    await p.locator(".nav-x").tap(); await until(async () => !(await navOpen()), 2000);
    check(!(await navOpen()), `${tag}: home's menu closes with its ✕ too`);
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${tag}: no sideways scroll`);
    check(!errors.length, `${tag}: no page errors ${errors.join(" | ")}`);
    await ctx.close();
  }
}
// On a wide screen the menu is the same drawer (jxn #4860: tabs on top, no standing sidebar): the strip's Menu opens it
// with its ✕ and the page dimmed, Esc closes it and focus goes back to Menu; closed, it's inert (nothing in it takes focus).
async function wide() {
  const ck = cookies[D];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}`); await loaded(p);
  const menu = p.locator("[data-nav-s]");
  check(await p.locator("#sidebar").evaluate((el) => el.inert) && await menu.isVisible() && !(await p.locator(".topbar .menu-btn").isVisible()), "1280px: the menu is closed and inert; the strip has the Menu button");
  await menu.click(); await p.waitForTimeout(300);
  check(await p.locator(".nav-x").isVisible() && await p.locator(".nav-scrim").isVisible() && !(await p.locator("#sidebar").evaluate((el) => el.inert)) && (await menu.getAttribute("aria-expanded")) === "true", "1280px: Menu opens the drawer with its ✕ and the page dimmed");
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  check(!(await p.evaluate(() => document.getElementById("app").classList.contains("nav-open"))) && await menu.evaluate((el) => el === document.activeElement), "1280px: Esc closes it and focus goes back to Menu");
  await ctx.close();
}
// Arabic (right to left): board info follows the reading direction. A swipe to the right leaves it open; a swipe to the
// left closes it (jxn #2446). The menu drawer is not part of this check.
async function arabic() {
  const ck = cookies[D];
  const ctx = await b.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true, locale: "ar-EG" });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await loaded(p);
  const dir = await p.evaluate(() => document.dir);
  const infoOpen = () => p.evaluate(() => document.getElementById("conv-layout").classList.contains("info-open"));
  await p.locator("#info-btn").tap();
  await until(infoOpen, 2000); await settled(p, "#board-info");
  check(dir === "rtl" && (await infoOpen()), `ar 390px: board info opens on a right-to-left page (${dir})`);
  await swipe(p, "#board-info", 140); await p.waitForTimeout(300);
  check(await infoOpen(), "ar 390px: a swipe to the right leaves board info open");
  await swipe(p, "#board-info", -140); await until(async () => !(await infoOpen()), 2000);
  check(!(await infoOpen()), "ar 390px: a swipe to the left closes board info");
  check(!errors.length, `ar 390px: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : "sidebar close: all passed");
process.exit(fails ? 1 : 0);
