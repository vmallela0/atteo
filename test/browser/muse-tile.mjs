// Muse connects with a key, not a sign-in (vedu #2290, vedu's agent #2291, opus-d #2292). The Muse tile opens
// /connect/muse; its button (a same-origin POST, never the GET) makes an agent key labelled Muse that ends in 90 days;
// the message to paste carries the MCP URL and the Authorization header and says it's a password; the key works;
// Account lists it with Revoke; a cross-site POST is refused; signed out, the page asks you to sign in.
// BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const U = `mu${Date.now().toString(36).slice(-4)}`;
await ops("users", { name: U, email: `${U}@example.com`, verified: "true", display: { mode: "developer" } });
const ck = (await ops("sessions", { user: U })).cookie, cookie = ck.split(";")[0];
const tokens = async () => (await (await fetch(`${BASE}/api/tokens`, { headers: { cookie } })).json()).tokens ?? [];
let fails = 0;
const check = (ok, s) => { console.log(`${ok ? "✓" : "✗"} ${s}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errs = [];
async function page(width = 1280) {
  const ctx = await b.newContext({ viewport: { width, height: 860 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const [k, ...v] = cookie.split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); p.on("pageerror", (e) => errs.push(e.message)); return { ctx, p };
}

// 1. The Muse tile goes to the key page.
{ const { ctx, p } = await page();
  await p.goto(BASE + "/"); await p.waitForTimeout(500);
  const tile = p.locator('.add-agent [data-cn-muse]').first();
  check(await tile.count() === 1 && (await tile.getAttribute("href")) === "/connect/muse" && /Get a key/.test(await tile.innerText()), "the Muse tile is a link to /connect/muse");
  await ctx.close(); }

// 2. The page; opening it makes nothing.
const before = (await tokens()).length;
{ const { ctx, p } = await page();
  await p.goto(BASE + "/connect/muse"); await p.waitForTimeout(500);
  check((await p.locator("h1").innerText()) === "Connect Muse" && (await tokens()).length === before, "GET /connect/muse shows the page and makes no key");
  // 3. The button makes one key and shows the message.
  await p.locator("#muse-make").click(); await p.waitForTimeout(700);
  const list = await tokens(), mine = list.filter((t) => t.label === "Muse");
  const days = mine[0]?.expires_at ? (mine[0].expires_at - Date.now()) / 86400e3 : 0;
  check(list.length === before + 1 && mine.length === 1 && days > 89 && days <= 90, `one key, labelled Muse, ending in 90 days (${days.toFixed(2)})`);
  const msg = await p.locator("#muse-msg").innerText();
  const key = msg.match(/Authorization: Bearer (ab_[A-Za-z0-9_-]+)/)?.[1];
  check(msg.startsWith(`Create a custom connector for this MCP server: ${BASE}/mcp\n`) && !!key && /That key is a password/.test(msg), `the message has the MCP URL, the header and says it's a password (${JSON.stringify(msg.slice(0, 90))}…)`);
  check(await p.locator("#muse-out .flash").isVisible() && /password/.test(await p.locator("#muse-out .flash").innerText()) && await p.locator("#muse-make").isHidden(), "the page warns it's a password, and the button is gone");
  await p.locator("#muse-copy").click(); await p.waitForTimeout(200);
  check((await p.evaluate(() => navigator.clipboard.readText())) === msg && /Copied/.test(await p.locator("#muse-done").innerText()), "Copy puts the whole message on the clipboard");
  // 4. The key works, as the person's agent.
  const me = await (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${key}` } })).json();
  const init = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }) });
  check(me.name === U && me.via === "agent" && init.status === 200, `the key works on /mcp, as ${U}'s agent (${me.via}, ${init.status})`);
  // 5. Account lists it, with its end date and Revoke.
  await p.goto(BASE + "/me"); await p.waitForTimeout(500);
  const row = p.locator("tr", { hasText: "Muse" }).first();
  check(await row.count() === 1 && /expires \d{4}-\d{2}-\d{2}/.test(await row.innerText()) && await row.locator("button", { hasText: "Revoke" }).count() === 1, `Account lists Muse with its end date and Revoke (${(await row.innerText()).replace(/\s+/g, " ").slice(0, 80)})`);
  await ctx.close(); }

// 6. Another site can't make one.
{ const r = await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { cookie, "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ label: "Muse" }) });
  check(r.status === 403 && (await tokens()).length === before + 1, `a cross-site POST is refused (${r.status})`); }

// 7. Signed out, the page asks you to sign in (nothing to make).
{ const r = await fetch(`${BASE}/connect/muse`, { redirect: "manual" });
  const t = r.status === 200 ? await r.text() : "";
  check(r.status >= 300 && r.status < 400 || /sign in/i.test(t) && !t.includes("muse-make"), `signed out: sign in first (${r.status})`); }

// 8. On a phone it fits.
{ const { ctx, p } = await page(390);
  await p.goto(BASE + "/connect/muse"); await p.waitForTimeout(400);
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "390px: fits");
  await ctx.close(); }
check(!errs.length, `no page errors ${errs.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "muse key: all passed");
process.exit(fails ? 1 : 0);
