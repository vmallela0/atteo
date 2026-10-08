// Live entries (vedu #6581): a message posted in one tab shows in another tab of the board from the socket alone, with
// no GET /updates for it; the sender's tab shows it once (no "sending…" copy left beside it). A question also refreshes
// the other tab's sidebar (one fetch, after it is shown); someone else's Just mine message never shows.
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `lp${run}`, Q = `lq${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Live push ${run}` })).board.id;
await ops("members", { board, user: Q });
const ckP = (await ops("sessions", { user: P })).cookie, ckQ = (await ops("sessions", { user: Q })).cookie;
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
async function tab(ck) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
  const [k, ...v] = ck.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  const updates = [];
  p.on("request", (r) => { if (r.url().includes(`/api/boards/${board}/updates`)) updates.push(Date.now()); });
  await p.goto(`${BASE}/b/${board}`);
  await p.locator("#composer-text").waitFor();
  await until(() => p.evaluate(() => ws && ws.readyState === 1));
  await p.waitForTimeout(300); // the page's own first fetches are done
  return { p, updates };
}
const sender = await tab(ckP), other = await tab(ckQ);
const shown = (p, t) => p.locator(`#thread>.entry:not(.pending) .body:has-text("${t}")`).count();
const send = async (p, text) => { await p.fill("#composer-text", text); await p.evaluate(() => document.querySelector("form.composer").requestSubmit()); };

// A note: the other tab renders it from the socket; no /updates from it, before or after.
const n0 = other.updates.length;
const note = `pushed note ${run}`;
await send(sender.p, note);
await until(async () => (await shown(other.p, note)) === 1, 5000);
check((await shown(other.p, note)) === 1, "the other tab shows the new message");
await other.p.waitForTimeout(700); // guards a negative: nothing fetched for it afterwards either
check(other.updates.length === n0, `…without a GET /updates (${other.updates.length - n0} made)`);
check((await shown(sender.p, note)) === 1 && (await sender.p.locator("#thread .entry.pending").count()) === 0, "the sender's tab shows it once, with no sending… copy left");
check(await other.p.evaluate(() => last) >= (await other.p.locator("#thread>.entry").last().getAttribute("data-seq")) * 1, "…and the tab's position moved past it");

// A question changes the sidebar's open questions: shown from the socket first, then one fetch refreshes the sidebar.
const q0 = other.updates.length;
const q = `pushed question ${run}?`;
await send(sender.p, `/ask ${q}`);
await until(async () => (await shown(other.p, q)) === 1, 5000);
check((await shown(other.p, q)) === 1, "a question shows in the other tab");
await until(() => other.updates.length > q0, 3000);
check(other.updates.length === q0 + 1, `…and the sidebar is refreshed with one fetch (${other.updates.length - q0})`);

// Someone else's Just mine message never shows in this tab.
const mine = `just mine ${run}`;
await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ckP.split(";")[0] }, body: JSON.stringify({ text: mine, own: true }) });
await until(async () => (await shown(sender.p, mine)) === 1, 5000);
check((await shown(sender.p, mine)) === 1, "the sender's own Just mine message shows in their tab (fetched)");
await other.p.waitForTimeout(500); // guards a negative
check((await shown(other.p, mine)) === 0 && !(await other.p.content()).includes(mine), "…and never in the other person's");

// Back to the push after it: the next note shows from the socket (the Just mine one between isn't this tab's).
const n1 = other.updates.length;
const after = `after the private one ${run}`;
await send(sender.p, after);
await until(async () => (await shown(other.p, after)) === 1, 5000);
await other.p.waitForTimeout(500);
check((await shown(other.p, after)) === 1 && other.updates.length === n1, `the next message is pushed too (${other.updates.length - n1} fetches)`);

// The board closes a socket whose push lease ran out (4000, "renew"): the tab reconnects at once (not after the error
// backoff), shows no "reconnecting" notice, and the next message is pushed on the new socket.
await other.p.evaluate(() => { const old = (window.__oldWs = ws), h = old.onclose; old.onclose = old.onmessage = null; old.close(); h({ code: 4000, reason: "renew" }); });
const t0 = Date.now();
await until(() => other.p.evaluate(() => ws !== window.__oldWs && ws.readyState === 1), 1500);
check(await other.p.evaluate(() => ws !== window.__oldWs && ws.readyState === 1), `after a 4000 close the tab reconnects at once (${Date.now() - t0} ms)`);
check(await other.p.evaluate(() => document.getElementById("conn").hidden), "…with no reconnecting notice");
await other.p.waitForTimeout(300);
const n2 = other.updates.length;
const renewed = `after the reconnect ${run}`;
await send(sender.p, renewed);
await until(async () => (await shown(other.p, renewed)) === 1, 5000);
await other.p.waitForTimeout(500);
check((await shown(other.p, renewed)) === 1 && other.updates.length === n2, `…and the next message is pushed on the new socket (${other.updates.length - n2} fetches)`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close();
console.log(fails ? `${fails} failed` : "live push: all passed");
process.exit(fails ? 1 : 0);
