// Pinned means pinned (#1569, ci-browser verify-layout "scrollTop 3004/3026"): once the conversation is at the bottom, any
// late growth (a font, an avatar, a card settling) keeps the latest fully in view, even a small one. Growth under 24px used to
// count as "near the end" and was left un-followed, so the page opened 22px short on a slow runner.
// Usage: BASE=http://localhost:8787 node pin-stay.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `ps${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Pinned ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
for (let i = 0; i < 30; i++) { await mcp("read", {}); await mcp("post", { type: "note", text: `message ${i} with a few words so the conversation scrolls` }); }

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` });
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(900);
  const gap = () => p.evaluate(() => { const s = document.getElementById("thread-scroll"); return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight); });
  check((await gap()) <= 1, `${w}px: opens at the bottom (gap ${await gap()}px)`);
  // Late growth of the last message, smaller and larger than the old 24px "near the end" slack.
  for (const px of [22, 8, 60]) {
    await p.evaluate((n) => { const d = document.createElement("div"); d.className = "late-grow"; d.style.height = n + "px"; document.querySelector("#thread>.entry:last-of-type .grow").appendChild(d); }, px);
    await p.waitForTimeout(250);
    check((await gap()) <= 1, `${w}px: ${px}px of late growth is followed (gap ${await gap()}px)`);
  }
  // Scrolled up by the reader: growth doesn't pull them down.
  await p.mouse.move(w / 2, h / 2);
  await p.mouse.wheel(0, -600);
  await p.waitForTimeout(400);
  const before = await p.evaluate(() => document.getElementById("thread-scroll").scrollTop);
  await p.evaluate(() => { const d = document.createElement("div"); d.style.height = "40px"; document.querySelector("#thread>.entry:last-of-type .grow").appendChild(d); });
  await p.waitForTimeout(250);
  const after = await p.evaluate(() => document.getElementById("thread-scroll").scrollTop);
  check(after === before && (await gap()) > 100, `${w}px: scrolled up, late growth leaves you where you are (${before} → ${after})`);
  check(!errors.length, `${w}px: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "pin-stay: all passed");
process.exit(fails ? 1 : 0);
