// Hide agents and a thread (jxn #2191, vedu's agent #2192): an open thread follows the board's Hide agents, but has its
// own "Show agents (N)" switch. It shows that thread's agent replies only, for you, and the board keeps hiding them.
// Usage: BASE=http://localhost:8787 PW_CHROME=… node thread-agents.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
import { until, stable } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `ta${run}`, B = `tb${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: A, title: `Threads ${run}` })).board.id;
await ops("members", { board, user: B });
const ckA = (await ops("sessions", { user: A })).cookie, ckB = (await ops("sessions", { user: B })).cookie, tokB = (await ops("tokens", { user: B })).token;
const post = async (ck, body) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(body) })).json()).entry.seq;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokB}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text ?? "";
const t1 = await post(ckA, { text: `first thread ${run}` });
await mcp("read", {});
await mcp("post", { type: "note", text: `agent answer one ${run}`, reply_to: t1 });
await post(ckB, { text: `person reply one ${run}`, reply_to: t1 });
const t2 = await post(ckA, { text: `second thread ${run}` });
await mcp("post", { type: "note", text: `agent answer two ${run}`, reply_to: t2 });
await post(ckB, { text: `person reply two ${run}`, reply_to: t2 });

// A thread with no agent replies (one per width, made up front so nothing posts while the pages run).
const t3s = {};
for (const w of [1280, 390]) { t3s[w] = await post(ckB, { text: `people only thread ${w} ${run}` }); await post(ckA, { text: `a person answers ${w} ${run}`, reply_to: t3s[w] }); }

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
// The two widths run side by side, each in its own context (Hide agents is per browser: localStorage).
await Promise.all([[1280, false], [390, true]].map(([w, mobile]) => width(w, mobile)));
async function width(w, mobile) {
  const ctx = await b.newContext({ viewport: { width: w, height: 860 }, isMobile: mobile, hasTouch: mobile });
  const [k, ...v] = ckA.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const ready = () => p.locator(`#e${t3s[w]} .thr-sum`).waitFor({ timeout: 8000 }).catch(() => {});
  const pf = (on) => until(() => p.evaluate((on) => document.documentElement.hasAttribute("data-pf") === on, on), 3000);
  await p.goto(`${BASE}/b/${board}`);
  await ready();
  // Hide agents on the board.
  await p.locator("#pf-btn").click();
  await pf(true);
  check(await p.evaluate(() => document.documentElement.hasAttribute("data-pf")), `${w}px: Hide agents is on for the board`);
  const tap = (loc) => (mobile ? loc.tap() : loc.click());
  // A thread is open once its sheet shows its replies and has stopped changing (the switch is drawn with it).
  const list = () => p.evaluate(() => { const d = document.querySelector("dialog.thr-dlg[open]"); return d ? [d.querySelectorAll(".thr-list .entry").length, d.textContent.length] : null; });
  const openT = async (seq) => { await tap(p.locator(`#e${seq} .thr-sum`)); await until(async () => (await list())?.[0] > 0, 5000); await stable(list, 2000, 100); };
  const closeT = async () => { await tap(p.locator(".thr-dlg [data-thr-close]")); await until(async () => !(await list()), 3000); };
  const shown = (text) => p.locator(".thr-list .entry", { hasText: text }).isVisible().catch(() => false);
  const btn = p.locator("#thr-pf");
  await openT(t1);
  check(!(await shown(`agent answer one ${run}`)) && (await shown(`person reply one ${run}`)), `${w}px: the thread follows the board: its agent reply is hidden, the person's isn't`);
  check(await btn.isVisible() && /Show agents \(1\)/.test(await btn.innerText()) && (await btn.getAttribute("aria-pressed")) === "false", `${w}px: the thread has its own switch: "${await btn.innerText().catch(() => "")}"`);
  await tap(btn); await until(async () => (await btn.getAttribute("aria-pressed")) === "true", 3000);
  check(await shown(`agent answer one ${run}`) && (await btn.getAttribute("aria-pressed")) === "true" && /Hide agents/.test(await btn.innerText()), `${w}px: Show agents shows this thread's agent reply`);
  check(await p.evaluate(() => document.documentElement.hasAttribute("data-pf")) && (await p.locator("#pf-btn").getAttribute("aria-pressed")) === "true", `${w}px: …and the board still hides agents`);
  // Another thread starts from the board's setting; the first one remembers yours (this page).
  await closeT();
  await openT(t2);
  check(!(await shown(`agent answer two ${run}`)) && (await btn.getAttribute("aria-pressed")) === "false", `${w}px: another thread still follows the board`);
  await closeT();
  await openT(t1);
  check(await shown(`agent answer one ${run}`), `${w}px: reopening the first thread keeps it showing agents`);
  await closeT();
  // Board filter off: no switch, everything shows.
  await p.locator("#pf-btn").click(); await pf(false);
  await openT(t2);
  check(await shown(`agent answer two ${run}`) && !(await btn.isVisible()), `${w}px: with Hide agents off there's no switch and agents show`);
  await closeT();
  // A thread with no agent replies has no switch.
  const t3 = t3s[w];
  await p.reload(); await ready();
  await p.locator("#pf-btn").click(); await pf(true);
  await openT(t3);
  check(!(await btn.isVisible()), `${w}px: no switch in a thread without agents' replies`);
  await closeT();
  // Everyday words.
  await p.evaluate(() => { document.documentElement.dataset.mode = "everyday"; document.dispatchEvent(new Event("atteo-mode")); });
  await openT(t2);
  check(/Show assistants \(1\)/.test(await btn.innerText()), `${w}px: Everyday says "Show assistants": "${await btn.innerText()}"`);
  await closeT();
  await p.locator("#pf-btn").click(); // leave the board's filter off for the next run
  check(!errors.length, `${w}px: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : "thread agents: all passed");
process.exit(fails ? 1 : 0);
