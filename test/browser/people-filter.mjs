// Hide agents / People first (jxn #1731, vedu #1060): a board's "Hide agents" shows only what people wrote (conversation,
// threads, rail), remembered per person in this browser, live posts included; a jump or link to an agent's post brings
// them back; nothing is sent and agents still read everything. The chat list's "People first" (same switch) keeps chats
// with other people, person-last ones first. Desktop light + phone dark. The private "Your agent" chat has no toggle.
// Usage: BASE=http://localhost:8787 node people-filter.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ADMIN = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": ADMIN, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `pp${run}`, Q = `pq${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const ckP = (await ops("sessions", { user: P })).cookie, ckQ = (await ops("sessions", { user: Q })).cookie, tokQ = (await ops("tokens", { user: Q })).token;
const newBoard = async (title, withQ = true) => { const id = (await ops("boards", { user: P, title: `${title} ${run}` })).board.id; if (withQ) await ops("members", { board: id, user: Q }); return id; };
const say = async (ck, board, text, reply_to) => { const r = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck.split(";")[0] }, body: JSON.stringify({ type: "note", text, ...(reply_to ? { reply_to } : {}) }) }); const j = await r.json(); if (!j.entry) throw new Error(JSON.stringify(j)); return j.entry.seq; };
const mcp = async (board, name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokQ}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
const agentSay = async (board, text, reply_to) => { await mcp(board, "read", {}); return +(await mcp(board, "post", { type: "note", text, ...(reply_to ? { reply_to } : {}) })).match(/#(\d+)/)[1]; };

// The main board: people and an agent, a thread with both, and an agent post a person's message links to.
const board = await newBoard("Hide agents");
const p1 = await say(ckQ, board, "Person one: are we shipping Friday?");
const a1 = await agentSay(board, "Agent: the build is green on main.");
const p2 = await say(ckP, board, "Person two: yes, Friday.");
const a2 = await agentSay(board, "Agent: drafted the release notes.", p1); // an agent's reply in p1's thread
const p3 = await say(ckP, board, "Person three: thanks, looks good.", p1); // a person's reply in the same thread
const a3 = await agentSay(board, "Agent: root of a thread.");
const p4 = await say(ckQ, board, "Person four answers the agent.", a3); // a thread whose root is an agent's
const p5 = await say(ckQ, board, `Person five links the agent's notes: #${a2}`);
const people = [p1, p2, p3, p4, p5], agents = [a1, a2, a3];
// An all-agent board (the empty state) and the chat list's boards.
const onlyAgents = await newBoard("Only agents");
await agentSay(onlyAgents, "Agent alone here.");
const bAgentLast = await newBoard("Agent last");
await say(ckQ, bAgentLast, "Person first here.");
await agentSay(bAgentLast, "Agent last here.");
const bPersonLast = await newBoard("Person last");
await agentSay(bPersonLast, "Agent first here.");
await say(ckQ, bPersonLast, "Person last here.");
const bSolo = await newBoard("Solo", false);
await say(ckP, bSolo, "Just me.");
await say(ckQ, bAgentLast, "Bump."); await agentSay(bAgentLast, "Agent last again."); // newest activity, but an agent wrote last

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const visible = (p, seqs) => p.evaluate((ss) => ss.map((s) => { const e = document.getElementById("e" + s) || document.getElementById("g" + s); return !!e && getComputedStyle(e).display !== "none"; }), seqs);
const innerWidthOf = (w) => w;
const allOf = (a) => a.every(Boolean), noneOf = (a) => a.every((x) => !x);

for (const [label, w, scheme] of [["1280px light", 1280, "light"], ["390px dark", 390, "dark"], ["320px light", 320, "light"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 860 }, colorScheme: scheme, isMobile: w < 500, hasTouch: w < 500 });
  const [k, ...v] = ckP.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [], sent = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (r.method() !== "GET" && r.url().startsWith(BASE)) sent.push(r.method() + " " + new URL(r.url()).pathname); });
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(900);
  const btn = p.locator("#pf-btn");
  check(await btn.isVisible() && (await btn.getAttribute("aria-pressed")) === "false", `${label}: Hide agents is offered, off`);
  const fit = await p.evaluate(() => ["pf-btn", "recap-btn"].map((id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return [id, Math.round(r.left), Math.round(r.right)]; }).filter(Boolean));
  check(fit.every(([, l, r]) => l >= 0 && r <= innerWidthOf(w)), `${label}: Hide agents and Recap both fit by the tabs (${JSON.stringify(fit)})`);
  if (w < 640) check((await btn.innerText()).trim() === "" && /^Hide (agents|assistants)$/.test(await btn.getAttribute("aria-label")), `${label}: on a phone it's the icon, named for screen readers`);
  check(allOf(await visible(p, [...people.filter((s) => s !== p3 && s !== p4), ...agents.filter((s) => s !== a2)])), `${label}: off, everyone's messages show`);
  const ticks0 = await p.locator("#rail i").count();
  sent.length = 0;
  await btn.click();
  await p.waitForTimeout(400);
  check((await btn.getAttribute("aria-pressed")) === "true", `${label}: on`);
  check(noneOf(await visible(p, [a1, a3])), `${label}: agents' posts are hidden`);
  check(allOf(await visible(p, [p1, p2, p5])), `${label}: people's posts still show`);
  check(!sent.filter((x) => !/\/seen$/.test(x)).length, `${label}: toggling sends nothing (${sent.join(", ")})`);
  const ticks1 = await p.locator("#rail i").count();
  check(ticks1 < ticks0, `${label}: the rail drops agents' posts (${ticks0} → ${ticks1})`);
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no sideways scroll`);
  // Live: an agent's new post stays hidden, a person's shows.
  const a4 = await agentSay(board, "Agent: live post while hidden.");
  const p6 = await say(ckQ, board, "Person six, live.");
  await p.waitForSelector(`#e${p6}`, { state: "attached", timeout: 15000 });
  await p.waitForTimeout(500);
  const live = await visible(p, [a4, p6]);
  check(!live[0] && live[1], `${label}: live posts follow it (agent hidden, person shown)`);
  // Threads: the agent's reply is hidden, the person's shows; a thread whose root is an agent's keeps its root.
  await p.evaluate((s) => document.querySelector(`#e${s} .thr-sum`)?.click(), p1);
  await p.waitForTimeout(500);
  const thr = await p.evaluate(() => [...document.querySelectorAll(".thr-list>.entry")].map((e) => [e.dataset.src, getComputedStyle(e).display !== "none"]));
  const shown = (s) => thr.find(([x]) => +x === s)?.[1];
  check(shown(p1) && shown(p3) && shown(a2) === false, `${label}: in a thread, the agent's reply is hidden (${JSON.stringify(thr)})`);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  await p.evaluate((s) => document.querySelector(`#e${s} .thr-sum`)?.click(), a3);
  await p.waitForTimeout(500);
  const thr2 = await p.evaluate(() => [...document.querySelectorAll(".thr-list>.entry")].map((e) => [e.dataset.src, getComputedStyle(e).display !== "none"]));
  check(thr2.length >= 2 && thr2.every(([, s]) => s), `${label}: an agent-rooted thread keeps its root (${JSON.stringify(thr2)})`);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  // Remembered: a reload comes back with it on, and agents' posts never show first.
  await p.reload();
  const early = await p.evaluate(() => document.documentElement.hasAttribute("data-pf"));
  await p.waitForTimeout(700);
  check(early && (await btn.getAttribute("aria-pressed")) === "true" && noneOf(await visible(p, [a1, a3])), `${label}: remembered after a reload`);
  check(await p.evaluate((me) => localStorage.getItem("atteo.pf." + me) === "1", P), `${label}: kept per person (atteo.pf.<you>)`);
  // A link to an agent's post brings agents' posts back (for this visit; the setting stays).
  await p.evaluate((s) => document.querySelector(`#e${s} a.ref`)?.click(), p5);
  await p.waitForTimeout(1200);
  const back = await p.evaluate((s) => ({ pf: document.documentElement.hasAttribute("data-pf"), show: getComputedStyle(document.getElementById("e" + s) || document.body).display !== "none", inThread: !!document.querySelector(".thr-dlg[open]") }), a2);
  check(!back.pf, `${label}: a link to an agent's post shows agents' posts again (${JSON.stringify(back)})`);
  if (back.inThread) await p.keyboard.press("Escape");
  check(await p.evaluate((me) => localStorage.getItem("atteo.pf." + me) === "1", P), `${label}: …while the remembered setting stays on`);
  await p.goto(`${BASE}/b/${board}#e${a1}`);
  await p.waitForTimeout(900);
  check(!(await p.evaluate(() => document.documentElement.hasAttribute("data-pf"))) && allOf(await visible(p, [a1])), `${label}: opening a link to an agent's post shows it`);
  // The empty state, and turning it off.
  await p.goto(`${BASE}/b/${onlyAgents}`);
  await p.waitForTimeout(700);
  check(await p.locator("#pf-empty").isVisible(), `${label}: a board with no people's posts says so`);
  await p.locator("#pf-btn").click();
  await p.waitForTimeout(300);
  check(!(await p.locator("#pf-empty").isVisible()) && (await p.evaluate((me) => localStorage.getItem("atteo.pf." + me), P)) === null, `${label}: off again, forgotten`);
  // Chat list: People first.
  await p.goto(`${BASE}/`);
  await p.waitForTimeout(500);
  const order = () => p.evaluate(() => [...document.querySelectorAll("#bgrid .bcard")].filter((c) => !c.hidden).map((c) => c.dataset.title));
  const before = await order();
  const t = (n) => `${n} ${run}`;
  check(before.includes(t("Solo")) && before.indexOf(t("Agent last")) < before.indexOf(t("Person last")), `${label}: the list is by latest activity (${before.filter((x) => x.endsWith(run)).join(" | ")})`);
  await p.locator("#pf-list").click();
  await p.waitForTimeout(300);
  const after = await order();
  check(!after.includes(t("Solo")), `${label}: People first leaves out chats with only you`);
  check(after.indexOf(t("Person last")) >= 0 && after.indexOf(t("Person last")) < after.indexOf(t("Agent last")), `${label}: chats where a person wrote last come first (${after.filter((x) => x.endsWith(run)).join(" | ")})`);
  check((await p.locator("#pf-list").getAttribute("aria-pressed")) === "true", `${label}: People first is pressed`);
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: list, no sideways scroll`);
  await p.locator("#pf-list").click();
  await p.waitForTimeout(200);
  check(JSON.stringify(await order()) === JSON.stringify(before), `${label}: off again, the list is back as it was`);
  // The private "Your agent" chat has no toggle.
  const chat = await (await fetch(`${BASE}/api/me/agent-chat`, { method: "POST", headers: { "content-type": "application/json", cookie: ckP.split(";")[0] }, body: "{}" })).json();
  if (chat.board) { await p.goto(`${BASE}/b/${chat.board}`); await p.waitForTimeout(400); check(!(await p.locator("#pf-btn").count()), `${label}: "Your agent" has no Hide agents`); }
  check(!errors.length, `${label}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
// Agents still read everything.
await mcp(board, "read", {});
const all = await mcp(board, "read", { since: 0 });
check(["build is green", "release notes", "Person two", "live post while hidden"].every((x) => all.includes(x)), "agents still read every message");
await browser.close();
console.log(fails ? `${fails} FAILED` : "people-filter: all passed");
process.exit(fails ? 1 : 0);
