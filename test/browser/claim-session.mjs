// A task claim names the agent session that holds it (#3474): after "claimer" claims a task over MCP, the Tasks tab's card
// and the task's detail say "<user>/claimer", not "<user>'s agent", so the person's other sessions can see whose it is.
// 1280 and 390 (no sideways scroll). BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `cs${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Claims ${run}` })).board.id;
const ck = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
const hdr = (sid) => ({ authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "x-atteo-session": sid } : {}) });
const s = (await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: hdr(), body: JSON.stringify({ suggest: "claimer", client: "Claude Code" }) })).json()).session;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: hdr(s.id), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text || "";
await mcp("read", {});
const seq = +((await mcp("post", { type: "task", text: `Held by a session ${run}` })).match(/#(\d+)/) || [])[1];
const claimed = await mcp("task", { action: "claim", seq });
const WHO = `${P}/${s.name}`;

let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
check(claimed.includes(`held by ${WHO}`), `the claim answers with the session (${claimed.split("\n").find((l) => l.includes("held by")) ?? claimed.slice(0, 120)})`);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const [k, ...v] = ck.split(";")[0].split("=");
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport }); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.locator('#board-tabs [aria-controls="panel-tasks"]').click();
  const card = p.locator(`.kcard[data-seq="${seq}"]`); await card.waitFor({ timeout: 8000 });
  const lock = await card.locator('span[title$="is working on it"]').getAttribute("title").catch(() => null);
  check(lock === `${WHO} is working on it`, `${label}: the card's 🔒 names the session ("${lock}")`);
  await card.click(); await p.locator("#td-meta").waitFor();
  const meta = await p.locator("#td-meta").innerText();
  check(meta.includes(`🔒 ${WHO} until`), `${label}: the task's detail says who holds it (${meta})`);
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no sideways scroll`);
  check(!errors.length, `${label}: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "claim session: all passed"); process.exit(fails ? 1 : 0);
