// A board tab whose live socket went quiet without closing (a laptop woke up, the Wi-Fi changed) replaces it and catches
// up (vedu #6564): coming back to the tab pings it, and no pong within 5s means a new socket and a fetch of what it missed.
// A healthy socket is left alone.
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `sr${run}`, Q = `sq${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Revive ${run}` })).board.id;
await ops("members", { board, user: Q });
const ck = (await ops("sessions", { user: P })).cookie, ckQ = (await ops("sessions", { user: Q })).cookie;
const post = (text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ckQ.split(";")[0] }, body: JSON.stringify({ text }) });
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
const [k, ...v] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
await p.locator("#composer-text").waitFor();
const open = () => p.evaluate(() => ws && ws.readyState === 1);
await until(open);
const shown = (t) => p.locator(`#thread>.entry .body:has-text("${t}")`).count();

// Healthy: back on the tab, the ping is answered and the socket stays.
await p.evaluate(() => { window.__first = ws; document.dispatchEvent(new Event("visibilitychange")); });
await p.waitForTimeout(5600);
check(await p.evaluate(() => ws === window.__first && ws.readyState === 1), "a socket that answers the ping is kept");

// Quiet: the socket stops delivering anything (no close event), as a half-open connection does.
await p.evaluate(() => { const s = ws; s.onmessage = null; s.send = () => {}; window.__dead = s; });
await post(`missed while quiet ${run}`);
await p.waitForTimeout(800);
check((await shown(`missed while quiet ${run}`)) === 0, "while the socket is quiet, nothing arrives (the condition this fixes)");
await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await until(async () => (await p.evaluate(() => ws !== window.__dead && ws.readyState === 1)) && (await shown(`missed while quiet ${run}`)) === 1, 9000);
check(await p.evaluate(() => ws !== window.__dead && ws.readyState === 1), "no pong within 5s: a new socket replaces it");
check((await shown(`missed while quiet ${run}`)) === 1, "…and the page catches up on what it missed");
await post(`live again ${run}`);
await until(async () => (await shown(`live again ${run}`)) === 1, 5000);
check((await shown(`live again ${run}`)) === 1, "the new socket delivers live messages");
check(await p.evaluate(() => window.__dead.readyState >= 2), "the quiet socket was closed, not left open beside the new one");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} failed` : "socket revive: all passed");
process.exit(fails ? 1 : 0);
