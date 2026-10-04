// gate: everyday (runs without devmode.mjs: it tests Everyday)
// Everyday leak audit (#1527): what Everyday mode re-words on the page ("Q's assistant", "to-do", "Chat", "Add", the
// composer's placeholder) never goes back out. Runs as a person in Everyday (no coding agent connected = Everyday by
// default). Quoting an agent's message posts "— q's agent, #N", not "assistant"; typing "@q's assistant" (the word
// Everyday shows) reaches q's agent, like "@q's agent"; a renamed agent keeps Everyday's words and Developer gets the new
// ones back; the page still shows Everyday words. No page errors.
// Usage: BASE=http://localhost:8787 [ADMIN_KEY=…] node everyday-leaks.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
let KEY = process.env.ADMIN_KEY;
// (the gate runs against 8787, whose ADMIN_KEY is ci-admin-key)
KEY ||= "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `lp${run}`, Q = `lq${run}`;
for (const u of [P, Q]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Leaks ${run}` })).board.id;
await ops("members", { board, user: Q });
const ck = (await ops("sessions", { user: P })).cookie, ckQ = (await ops("sessions", { user: Q })).cookie, tokQ = (await ops("tokens", { user: Q })).token;
const post = async (body) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tokQ}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json()).entry.seq;
const entries = async () => (await (await fetch(`${BASE}/api/boards/${board}/entries?after=0`, { headers: { authorization: `Bearer ${tokQ}` } })).json()).entries;
const s1 = await post({ type: "note", text: "The staging port is 8443 and the cache is warm." });
const s2 = await post({ type: "task", text: "Rotate the staging key" });
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (f, ms = 6000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 150)); } };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
const [k, ...v] = ck.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`);
const ev = await until(async () => (await p.evaluate(() => document.documentElement.dataset.mode)) === "everyday" && "ok", 5000);
check(ev, "a person with no coding agent is in Everyday");
const who1 = () => p.locator(`#e${s1} .meta .who`).textContent();
check(await until(async () => (await who1()).includes("assistant") && "ok", 3000), `the page shows Everyday's words (${await who1()})`);

// 1. Quote: select words in Q's agent's message, Quote, post.
await p.evaluate((seq) => { const b = document.querySelector(`#e${seq} .body`); const r = document.createRange(); const t = b.querySelector("p")?.firstChild || b.firstChild; r.setStart(t, 0); r.setEnd(t, 20); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, s1);
await until(async () => (await p.locator("#quote-btn").isVisible()) && "ok", 3000);
await p.locator("#quote-btn").click();
const draft = await p.locator("#composer-text").inputValue();
check(/— lq\w+'s agent, #\d+/.test(draft) && !/assistant/i.test(draft), `the quote says "— ${Q}'s agent", not "assistant" (${JSON.stringify(draft.split("\n").pop() || draft.slice(-40))})`);
await p.locator("#composer-text").press("Enter");
const quoted = await until(async () => (await entries()).find((e) => e.via === "person" && e.text.includes("> — ")));
check(quoted && !/assistant/i.test(quoted.text) && quoted.text.includes(`— ${Q}'s agent, #${s1}`), `…and that's what's posted: ${JSON.stringify(quoted?.text.split("\n").pop())}`);

// 2. "@Q's assistant" (the word Everyday shows) reaches Q's agent.
await p.locator("#composer-text").fill(`@${Q}'s assistant can you double-check the port?`);
check(await until(async () => (await p.locator("#composer-mirror .chip.agent").count()) === 1 && "ok", 2000), "the composer marks it as an agent mention");
await p.locator("#composer-text").press("Enter");
const m = await until(async () => (await entries()).find((e) => e.text.startsWith(`@${Q}'s assistant`)));
check(m && JSON.stringify(m.mentions) === JSON.stringify([{ user: Q, agent: true }]), `it's addressed to ${Q}'s agent (${JSON.stringify(m?.mentions)})`);
check(await until(async () => (await p.locator(`#e${m?.seq} .body .mention.agent[data-user="${Q}"]`).count()) === 1 && "ok", 4000), "…and drawn as the agent's chip");
const mail = await (await fetch(`${BASE}/api/mailbox?peek=1`, { headers: { authorization: `Bearer ${tokQ}` } })).json();
check((mail.mail || []).some((x) => x.seq === m?.seq), `${Q}'s agent gets it in its mailbox`);

// People-only needs a person @mentioned: "@q's assistant" is q's agent, so it doesn't count (the server agrees).
await p.locator('#composer-text').fill("");
const po = p.locator("#po-btn");
if (await po.count()) {
  await po.click();
  await p.locator("#composer-text").fill(`@${Q}'s assistant only you`);
  await p.locator("#composer-text").press("Enter");
  check(await until(async () => ((await p.locator("#toast").textContent()) || "").includes("agents never will") && "ok", 2000), "people-only with only \"@q's assistant\" asks for a person");
  await p.locator("#composer-text").fill("");
  await po.click();
} else check(false, "people-only toggle found");

// 3. Q names their agent: Everyday still says "Q's assistant" by the name; Developer shows the new words.
await fetch(`${BASE}/api/me/profile`, { method: "POST", headers: { cookie: ckQ.split(";")[0], "content-type": "application/json" }, body: JSON.stringify({ agent_name: "Scout" }) });
check(await until(async () => (await who1()) === "Scout" && "ok"), `renamed live: ${await who1()}`);
const owner = () => p.locator(`#e${s1} .meta .via.owner`).textContent();
check(await until(async () => /assistant/.test(await owner()) && "ok", 3000), `…with Everyday's owner words (${await owner()})`);
await p.evaluate(() => window.applyDisplay({ developer: true }));
check(await until(async () => (await owner()) === `${Q}'s agent` && "ok", 2000), `Developer: the new owner words, not stale ones (${await owner()})`);
await p.evaluate(() => window.applyDisplay({ developer: false }));
check(await until(async () => /assistant/.test(await owner()) && "ok", 2000), "back to Everyday");

// 4. The task tag reads "to-do" here, and the board's tasks API still says task.
check(((await p.locator(`#e${s2} .t-task`).textContent()) || "").includes("to-do"), "Everyday shows the task as a to-do");
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
