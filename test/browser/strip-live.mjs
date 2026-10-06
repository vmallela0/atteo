// The frame's top tabs (vedu #5194, #5192): they never scroll up or down (also at the largest text), a post on another
// board moves its tab to the front without a reload, and Display → Tab order "Last opened" puts the board you opened last
// first. POST /api/boards/:id/opened is for people only. Light 1280. Usage: BASE=http://localhost:8787 node strip-live.mjs
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `sl${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode: "developer" } });
const ids = [];
for (const t of ["One", "Two", "Three", "Four"]) ids.push((await ops("boards", { user: A, title: `${t} ${run}` })).board.id);
const [one, two, three, four] = ids;
const ck = (await ops("sessions", { user: A })).cookie, tok = (await ops("tokens", { user: A })).token;
const post = (id, text) => fetch(`${BASE}/api/boards/${id}/entries`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ type: "note", text }) });
// Activity order to start with: Four, Three, Two, One (each board's last post is newer than the one before).
for (const id of ids) { await post(id, `hello ${run}`); await new Promise((r) => setTimeout(r, 20)); }
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 } });
const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
const open = async (id) => { await p.goto(`${BASE}/b/${id}`); await p.locator("#composer-text").waitFor(); };
const order = () => p.evaluate((mine) => [...document.querySelectorAll(".btabs [data-tabw]")].map((w) => w.dataset.tabw).filter((x) => mine.includes(x)), ids);
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };
const yScroll = () => p.evaluate(() => { const n = document.querySelector(".btabs"), s = getComputedStyle(n); return { y: s.overflowY, over: n.scrollHeight - n.clientHeight }; });

await open(one);
check(JSON.stringify(await order()) === JSON.stringify([four, three, two, one]), "the tabs start most recent message first");
for (const text of ["m", "l"]) {
  await p.evaluate((t) => window.applyDisplay({ text: t }), text);
  const s = await yScroll();
  await p.locator(".btabs").hover();
  await p.mouse.wheel(0, 400);
  const top = await p.evaluate(() => document.querySelector(".btabs").scrollTop);
  check(s.y === "hidden" && s.over <= 0 && top === 0, `text ${text}: the tabs can't scroll up or down (${JSON.stringify({ ...s, top })})`);
}
await p.evaluate(() => window.applyDisplay({ text: "m" }));

// Live: a post on Two (from A's agent, elsewhere) moves Two's tab to the front, no reload.
const before = p.url();
await post(two, `live ${run}`);
check(await until(async () => (await order())[0] === two), "a post on another board moves its tab to the front at once");
check(p.url() === before, "without reloading the page");

// Tab order: Last opened (saved to the account like the other display settings).
const saved = await p.evaluate(async () => (await fetch("/api/me/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display: { tab_order: "opened" } }) })).status);
check(saved === 200, `tab_order saves to the account (${saved})`);
await p.evaluate(() => window.applyDisplay({ tab_order: "opened" }));
check(await until(async () => (await order())[0] === one), "Last opened: the board you're on leads");
await open(three);
const o = await order();
check(o[0] === three && o[1] === one, `opening another board puts it first, the one before next (${o.map((x) => ids.indexOf(x) + 1).join(",")})`);
await p.locator("#dp-form").count(); // (Settings shows the choice: checked below)
await p.goto(`${BASE}/me`);
check(await p.locator('#dp-form input[name="tab_order"][value="opened"]').isChecked(), "Settings → Display shows Tab order: Last opened");
await p.locator('label[for="dp-tab_order-recent"]').click();
await open(one);
check(await until(async () => (await order())[0] === two), "back to Most recent message: the latest post's board leads again");

// Only people mark a board opened.
const asPerson = await p.evaluate(async (id) => (await fetch(`/api/boards/${id}/opened`, { method: "POST" })).status, four);
const asAgent = (await fetch(`${BASE}/api/boards/${four}/opened`, { method: "POST", headers: { authorization: `Bearer ${tok}` } })).status;
check(asPerson === 200 && asAgent === 403, `POST …/opened: people 200, agents 403 (${asPerson}, ${asAgent})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "strip live: all passed");
process.exit(fails ? 1 : 0);
