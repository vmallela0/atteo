// The frame's tabs keep their state live (jxn #4860): after the page has loaded, a board where an agent starts working
// turns its tab green with "1 working", and a board where your agent asks for an approval turns amber with "1 approval",
// without a reload (GET /api/me/board-states, polled every 20s). A quiet board stays grey. Light 1280.
// Usage: BASE=http://localhost:8787 node frame-tab-state.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `ts${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode: "developer" } });
const mk = async (title) => (await ops("boards", { user: A, title: `${title} ${run}` })).board.id;
const quiet = await mk("Quiet"), busy = await mk("Busy"), asks = await mk("Asks");
const ck = (await ops("sessions", { user: A })).cookie, tok = (await ops("tokens", { user: A })).token;
const H = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const [k, ...v] = ck.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${quiet}`); await p.locator("#composer-text").waitFor();
const tab = (id) => p.locator(`.btab[data-tab="${id}"]`);
const state = (id) => tab(id).evaluate((t) => ({ work: t.classList.contains("st-work"), ap: t.classList.contains("st-ap"), wk: t.querySelector(".wk")?.hidden ? "" : t.querySelector(".wk")?.textContent, apn: t.querySelector(".apn")?.hidden ? "" : t.querySelector(".apn")?.textContent }));
check((await tab(busy).count()) === 1 && (await tab(asks).count()) === 1, "the strip has a tab for each board");
const s0 = await state(busy);
check(!s0.work && !s0.ap && !s0.wk, `before anything happens the busy board's tab is quiet (${JSON.stringify(s0)})`);
// After the page loaded: an agent session starts working on "Busy", and your agent asks for an approval on "Asks".
const sess = await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: H, body: JSON.stringify({ name: "worker", client: "Claude Code" }) })).json();
const sid = sess.id ?? sess.session?.id;
await fetch(`${BASE}/api/sessions/${sid}/boards`, { method: "POST", headers: { ...H, "x-agent-soup-session": sid }, body: JSON.stringify({ board: busy }) });
await fetch(`${BASE}/api/boards/${busy}/entries`, { method: "POST", headers: { ...H, "x-agent-soup-session": sid }, body: JSON.stringify({ text: `working on it ${run}` }) });
const mcp = await fetch(`${BASE}/mcp?board=${asks}`, { method: "POST", headers: { ...H, accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_approval", arguments: { title: `Deploy ${run}`, details: "npm run deploy", risk: "low", wait_seconds: 0 } } }) });
check(mcp.ok, `the agent asked for an approval (${mcp.status})`);
// Coming back to a visible tab uses the same refresh as the 20s poll; trigger it instead of paying for the interval.
await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await p.waitForFunction(([b1, b2]) => document.querySelector(`.btab[data-tab="${b1}"]`)?.classList.contains("st-work") && document.querySelector(`.btab[data-tab="${b2}"]`)?.classList.contains("st-ap"), [busy, asks], { timeout: 15000, polling: 100 }).catch(() => {});
const s1 = await state(busy), s2 = await state(asks), s3 = await state(quiet);
check(s1.work && !s1.ap && /1/.test(s1.wk || ""), `the busy board's tab turns green with its working count, live (${JSON.stringify(s1)})`);
check(s2.ap && !s2.work && /1/.test(s2.apn || ""), `the board with a waiting approval turns amber with its count, live (${JSON.stringify(s2)})`);
check(!s3.work && !s3.ap, `the quiet board's tab stays grey (${JSON.stringify(s3)})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} FAILED` : "frame tab state: all passed");
process.exit(fails ? 1 : 0);
