// Connect an agent is always reachable on phones (vedu #2241, claude #2246): the phone menu has it whether or not an
// agent is connected, and it opens the same Connect dialog (this page's, or Account's via /me#connect). The board's
// header keeps its button only while nothing is connected; desktop's sidebar doesn't grow. Everyday says "Connect your
// assistant". BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), FRESH = `cr${run}`, CONN = `cc${run}`, EV = `ce${run}`;
await ops("users", { name: FRESH, email: `${FRESH}@example.com`, verified: "true", display: { mode: "developer" } });
await ops("users", { name: CONN, email: `${CONN}@example.com`, verified: "true", display: { mode: "developer" } });
await ops("users", { name: EV, email: `${EV}@example.com`, verified: "true", display: { mode: "everyday" } });
const boards = {};
for (const u of [FRESH, CONN, EV]) boards[u] = (await ops("boards", { user: u, title: `Connect ${u}` })).board.id;
// CONN has an agent connected: a sign-in it has used.
const tok = (await ops("tokens", { user: CONN })).token;
await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${tok}` } });
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
async function open(user, path, width = 390) {
  const phone = width < 500;
  const ctx = await b.newContext({ viewport: { width, height: 844 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const ck = (await ops("sessions", { user })).cookie; const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message));
  await p.goto(`${BASE}${path}`); await p.waitForTimeout(700);
  return { ctx, p, tap: (sel) => (phone ? p.locator(sel).tap() : p.locator(sel).click()) };
}
const headerBtn = (p) => p.locator('.actions [data-open="connect"]').isVisible();
const dlgOpen = (p) => p.evaluate(() => !!document.querySelector("dialog#connect")?.open);

for (const [who, connected] of [[FRESH, false], [CONN, true]]) {
  const tag = connected ? "connected" : "not connected";
  const { ctx, p, tap } = await open(who, `/b/${boards[who]}`);
  check((await headerBtn(p)) === !connected, `${tag}: the board's header ${connected ? "has no" : "has its"} Connect button`);
  await tap("[data-nav]"); await p.waitForTimeout(300);
  const item = p.locator("#sidebar .side-connect");
  check(await item.isVisible() && /Connect an agent/.test(await item.innerText()), `${tag}: the phone menu has Connect an agent`);
  await tap("#sidebar .side-connect"); await p.waitForTimeout(400);
  check(await dlgOpen(p) && !(await p.evaluate(() => document.getElementById("app").classList.contains("nav-open"))) && new URL(p.url()).pathname === `/b/${boards[who]}`, `${tag}: it opens this page's Connect dialog and closes the menu`);
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: nothing wider than the phone`);
  check(!p.errors.length, `${tag}: no page errors ${p.errors.join(" | ")}`);
  await ctx.close();
}
// A page with no Connect dialog of its own (Inbox): the menu item goes to Account and the dialog opens there.
{ const { ctx, p, tap } = await open(CONN, "/inbox");
  check(!(await p.locator("dialog#connect").count()), "Inbox has no Connect dialog of its own");
  await tap("[data-nav]"); await p.waitForTimeout(300);
  await Promise.all([p.waitForURL(/\/me#connect$/), tap("#sidebar .side-connect")]); await p.waitForTimeout(600);
  check(await dlgOpen(p), `from Inbox it opens Account's Connect dialog (${p.url().replace(BASE, "")})`);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }
// Account keeps its own button, always.
{ const { ctx, p } = await open(CONN, "/me");
  check(await p.locator('.section-title [data-open="connect"]').isVisible(), "Account has Connect an agent, with an agent connected");
  await ctx.close(); }
// Everyday words.
{ const { ctx, p, tap } = await open(EV, `/b/${boards[EV]}`);
  await tap("[data-nav]"); await p.waitForTimeout(300);
  const t = (await p.locator("#sidebar .side-connect").innerText()).trim();
  check(t === "Connect your assistant", `Everyday: the menu says "${t}"`);
  await ctx.close(); }
// Chinese.
{ const { ctx, p, tap } = await open(CONN, `/b/${boards[CONN]}?lang=zh-Hans`);
  await tap("[data-nav]"); await p.waitForTimeout(300);
  const t = (await p.locator("#sidebar .side-connect").innerText()).trim();
  check(/[一-鿿]/.test(t) && !/Connect/.test(t), `zh-Hans: the menu item is translated ("${t}")`);
  await ctx.close(); }
// Desktop: the sidebar doesn't grow (the header button and Account cover it).
{ const { ctx, p } = await open(CONN, `/b/${boards[CONN]}`, 1280);
  check(!(await p.locator("#sidebar .side-connect").isVisible()), "desktop: no extra sidebar item");
  await ctx.close(); }
await b.close(); console.log(fails ? `${fails} FAILED` : "connect reachable: all passed"); process.exit(fails ? 1 : 0);
