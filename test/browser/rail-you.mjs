// The rail's black ticks are for messages that mention you (jxn #4120): "@you" marks a message for you, whoever wrote
// it; "@you's agent", "@you/session", "@agents" and a question to your agent don't. The ticks of the messages in view
// are a lighter grey, so they don't read as mentions too. Light and dark.
// Usage: BASE=http://localhost:8787 PW_CHROME=… node rail-you.mjs  (local dev only, ADMIN_KEY=ci-admin-key)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), J = `ry${run}`, V = `rv${run}`;
for (const u of [J, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: J, title: `Rail you ${run}` })).board.id;
await ops("members", { board, user: V });
const ckV = (await ops("sessions", { user: V })).cookie.split(";")[0], ckJ = (await ops("sessions", { user: J })).cookie.split(";")[0];
const tokV = (await ops("tokens", { user: V })).token;
const post = async (body) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ckV }, body: JSON.stringify(body) })).json()).entry.seq;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokV}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text ?? "";
const forYou = [await post({ text: `hey @${J} look` })];
const notYou = [await post({ text: `hey @${J}'s agent look` }), await post({ text: `hey @${J}/claude look` }), await post({ text: "hey @agents look" })];
await mcp("read", {});
const seqOf = (t) => +(t.match(/Posted #(\d+)/)?.[1] ?? 0);
notYou.push(seqOf(await mcp("post", { type: "note", text: `agent to agent: @${J}'s agent please` })), seqOf(await mcp("post", { type: "question", text: "a question for your agent", to: J })));
forYou.push(seqOf(await mcp("post", { type: "note", text: `agent to person: @${J} fyi` })));

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
check(notYou.every(Boolean) && forYou.every(Boolean), `posted (${forYou.join(",")} for you; ${notYou.join(",")} not)`);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
await Promise.all(["light", "dark"].map(async (scheme) => {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: scheme });
  await ctx.addCookies([{ name: ckJ.split("=")[0], value: ckJ.split("=").slice(1).join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}`);
  await p.locator("#rail i").first().waitFor({ state: "attached" });
  await p.waitForFunction((n) => document.querySelectorAll("#thread>.entry").length >= n && document.querySelectorAll("#rail i.on").length > 0, forYou.length + notYou.length);
  await p.evaluate(() => document.querySelectorAll("#rail i").forEach((i) => (i.style.transition = "none"))); // the ticks' end colours, not mid-fade
  const marked = await p.evaluate(() => [...document.querySelectorAll("#thread>.entry.for-you")].map((e) => +e.dataset.seq).sort((a, b) => a - b));
  check(JSON.stringify(marked) === JSON.stringify([...forYou].sort((a, b) => a - b)), `${scheme}: only the messages that say @${J} are for you (${marked.join(",")}), not @…'s agent, @…/claude, @agents or a question to the agent`);
  // Each tick's colour as drawn on the page's background, and its contrast with it.
  const look = await p.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = cv.height = 1; const g = cv.getContext("2d", { willReadFrequently: true });
    const bg = getComputedStyle(document.getElementById("thread-scroll")).backgroundColor, page = getComputedStyle(document.body).backgroundColor;
    const px = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = page; g.fillRect(0, 0, 1, 1); g.fillStyle = bg; g.fillRect(0, 0, 1, 1); g.fillStyle = c; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = ([r, gg, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const base = px("transparent"), of = (sel) => { const el = document.querySelector(sel); return el ? +ratio(px(getComputedStyle(el).backgroundColor), base).toFixed(2) : null; };
    return { me: of("#rail i.me"), on: of("#rail i.on:not(.me)"), plain: of("#rail i:not(.on):not(.me)"), meN: document.querySelectorAll("#rail i.me").length };
  });
  check(look.meN === forYou.length, `${scheme}: one black tick per message for you (${look.meN})`);
  check(look.me >= 3 && look.on != null && look.on <= 4.5 && look.on >= 1.5, `${scheme}: a message for you has the strongest tick (${look.me}:1), the ones in view a lighter grey (${look.on}:1), the rest fainter (${look.plain ?? "—"}:1)`);
  await ctx.close();
}));
await b.close();
console.log(fails ? `${fails} FAILED` : "rail you: all passed");
process.exit(fails ? 1 : 0);
