// Board switches feel instant (#3717): holding the pointer on a board link in the sidebar fetches that board's page ahead
// (speculation rules, "moderate"), and the click then uses it (the navigation's deliveryType is "navigational-prefetch").
// Nothing is marked read by it: the prefetched board still has its unread message afterwards.
// Usage: BASE=http://localhost:8798 node board-prefetch.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `bp${run}`, B = `bq${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], ckB = (await ops("sessions", { user: B })).cookie.split(";")[0];
const one = (await ops("boards", { user: A, title: `First ${run}` })).board.id, two = (await ops("boards", { user: A, title: `Second ${run}` })).board.id;
await ops("members", { board: two, user: B });
const post = (board, ck, text) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: JSON.stringify({ text }) }).then((r) => r.json()).then((j) => j.entry.seq);
await post(two, ckA, `hello ${run}`);
const seenBefore = await (await fetch(`${BASE}/api/boards/${two}/updates?after=0`, { headers: { cookie: ckA } })).json();
const lastTwo = await post(two, ckB, `are you there? ${run}`);
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const [k, ...v] = ckA.split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = [], ahead = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("request", (r) => { if (new URL(r.url()).pathname === `/b/${two}` && /prefetch/.test(r.headers()["sec-purpose"] || "")) ahead.push(r.url()); });
const res = await p.goto(`${BASE}/b/${one}`);
check((await p.evaluate(() => HTMLScriptElement.supports?.("speculationrules"))) && /speculation-rules\.json/.test(res.headers()["speculation-rules"] || ""), `the page names its speculation rules in a header (${res.headers()["speculation-rules"]}) this browser supports`);
const link = p.locator(`.btab[href="/b/${two}"]`).first(); // its tab in the strip (jxn #4860)
await link.hover();
await until(() => ahead.length > 0, 5000);
check(ahead.length > 0, `holding the pointer on the board's link fetches its page ahead (${ahead.length})`);
// Nothing on the server moved: the board's read position is where it was.
const reads = (await (await fetch(`${BASE}/api/boards/${two}/updates?after=${lastTwo}`, { headers: { cookie: ckA } })).json()).reads?.[A]?.person_seen ?? 0;
check(reads < lastTwo, `the prefetch marks nothing read (seen ${reads}, newest #${lastTwo}; before ${seenBefore.reads?.[A]?.person_seen ?? 0})`);
await Promise.all([p.waitForURL(`**/b/${two}`), link.click()]);
const type = await p.evaluate(() => performance.getEntriesByType("navigation")[0]?.deliveryType ?? "");
check(type === "navigational-prefetch", `the click opens the page fetched ahead (deliveryType "${type}")`);
check(await p.locator("#thread").innerText().then((t) => t.includes(`are you there? ${run}`)), "the board shows its messages");
check(!errors.length, `no page errors${errors.length ? ` (${errors[0]})` : ""}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "board prefetch: all passed");
process.exit(fails ? 1 : 0);
