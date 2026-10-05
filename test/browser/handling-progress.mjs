// The agent's progress under a message it's on (vedu's agent #2498 item 4, claude #2499): under a message an agent
// session took ("🤔 … is on it"), a line with that session's own status and how long it has been on it, and "Stalled?"
// once the session has gone quiet. The status is the agent's words, so it shows as text. Done markers have no line.
// Usage: BASE=http://localhost:8787 [PERSIST=<wrangler --persist-to dir>] node handling-progress.mjs  (local dev only)
import { d1Execute } from "./lib/d1.mjs";
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787", WT = process.env.WT || new URL("../../", import.meta.url).pathname;
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const sql = (q) => d1Execute(`--command ${JSON.stringify(q)}`, { cwd: WT });
const run = Date.now().toString(36).slice(-4), A = `hp${run}`, B = `hq${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: A, title: `Progress ${run}` })).board.id;
await ops("members", { board, user: B });
const tokA = (await ops("tokens", { user: A })).token, ckA = (await ops("sessions", { user: A })).cookie, ckB = (await ops("sessions", { user: B })).cookie;
const api = (m, p, b, sid) => fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json", ...(sid ? { "x-atteo-session": sid } : {}) }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const s = (await api("POST", "/api/sessions", { suggest: "worker", client: "Claude Code" })).session;
await api("POST", `/api/sessions/${s.id}/boards`, { board }, s.id);
const post = async (ck, text) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify({ text }) })).json()).entry.seq;
const m1 = await post(ckB, `@${A}'s agent can you run the gate ${run}?`);
const m2 = await post(ckB, `@${A}'s agent and check the logs ${run}`);
await api("POST", `/api/boards/${board}/handle/${m1}`, {}, s.id);
await api("POST", `/api/boards/${board}/handle/${m2}`, {}, s.id);
await api("POST", `/api/boards/${board}/handle/${m2}`, { action: "done" }, s.id);
const STATUS = `Running the gate <b>now</b> ${run}`;
await api("POST", `/api/sessions/${s.id}`, { status: STATUS }, s.id);

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w, mobile] of [[1280, false], [390, true]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 860 }, isMobile: mobile, hasTouch: mobile });
  const [k, ...v] = ckB.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(2200);
  const line = (seq) => p.locator(`#e${seq} .hdl-prog`);
  const t1 = await line(m1).innerText().catch(() => "");
  check(t1.startsWith(`🤔 ${A}/worker: ${STATUS}`) && / · <1m|· \d+m/.test(t1) && !/Stalled/.test(t1), `${w}px: under the message it's on: its status and time ("${t1}")`);
  check((await line(m1).evaluate((el) => el.querySelectorAll("*").length)) === 0, `${w}px: the status is shown as text (no markup made)`);
  check((await line(m2).count()) === 0, `${w}px: a done marker has no progress line`);
  check(!errors.length, `${w}px: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
// The session goes quiet (last seen 10 minutes ago): the line says it may be stalled. Needs this server's D1 (PERSIST).
let quiet = true;
try { await sql(`UPDATE agent_sessions SET last_seen = ${Date.now() - 10 * 60_000} WHERE id = '${s.id}'`); } catch (e) { quiet = false; console.log(`  (stalled step skipped: set PERSIST to the server's --persist-to dir: ${String(e.message || e).split("\n")[0]})`); }
if (quiet) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const [k, ...v] = ckB.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(2200);
  const t = await p.locator(`#e${m1} .hdl-prog`).innerText().catch(() => "");
  check(/Stalled\? No activity for 1\dm/.test(t) && (await p.locator(`#e${m1} .hdl-prog.stalled`).count()) === 1, `a quiet session: "stalled?" ("${t}")`);
  // Releasing the marker takes the line away live.
  await api("POST", `/api/boards/${board}/handle/${m1}`, { action: "release" }, s.id);
  await p.waitForTimeout(2500);
  check((await p.locator(`#e${m1} .hdl-prog`).count()) === 0, "a released marker's line goes away");
  await ctx.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : "handling progress: all passed");
process.exit(fails ? 1 : 0);
