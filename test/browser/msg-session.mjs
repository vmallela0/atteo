// Which agent is talking (jxn #3014, #4522): a named agent's header shows its owner; hover adds the session and tool
// ("jxn's agent · opus-b · Claude Code") in Developer and Everyday. BASE, ADMIN_KEY, PW_CHROME.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": process.env.ADMIN_KEY || "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `ms${run}`, NAME = `Thinker${run}`;
await ops("users", { name: P, email: `${P}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Who ${run}` })).board.id;
const ckP = (await ops("sessions", { user: P })).cookie, tok = (await ops("tokens", { user: P })).token;
await fetch(`${BASE}/api/me/profile`, { method: "POST", headers: { "content-type": "application/json", cookie: ckP.split(";")[0] }, body: JSON.stringify({ agent_name: NAME }) });
const hdr = (sid) => ({ authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "x-atteo-session": sid } : {}) });
const sess = async (suggest) => (await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: hdr(), body: JSON.stringify({ suggest, client: "Claude Code" }) })).json()).session;
const mcp = async (sid, name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: hdr(sid), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text || "";
const say = async (sid, text) => { await mcp(sid, "read", {}); return +((await mcp(sid, "post", { type: "note", text })).match(/#(\d+)/) || [])[1]; };
const sA = await sess("opus-b"), sB = await sess("x<b>y");
const eA = await say(sA.id, `from the first session ${run}`), eB = await say(sB.id, `from the second ${run}`), eN = await say(null, `no session ${run}`);
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const [k, ...v] = ckP.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.locator(`#e${eN}`).waitFor({ timeout: 8000 }).catch(() => {});
const meta = (s) => p.evaluate((s) => { const m = document.querySelector(`#e${s}>.grow>.meta`); if (!m) return null; const w = m.querySelector(".who"); return { who: w?.textContent, title: w?.title || "", via: [...m.querySelectorAll(".via")].filter((x) => x.offsetParent).map((x) => x.textContent), markup: !!m.querySelector(".who b") }; }, s);
const a = await meta(eA), bb = await meta(eB), n = await meta(eN);
// The header shows the name and owner; the session and tool remain in the title.
check(a?.who === `${NAME} · ${P}'s agent` && !a.via.length && a.title === `${P}'s agent · ${sA.name} · Claude Code`, `the header shows the name and owner (${JSON.stringify(a)})`);
check(bb?.title.includes(sB.name) && !bb.markup && !bb.via.length, `another session's post names its own session on hover, as text (${JSON.stringify(bb?.title)})`);
check(n?.who === `${NAME} · ${P}'s agent` && n.title === `${P}'s agent` && !n.via.length, `a post with no session shows the owner (${JSON.stringify(n)})`);
await p.evaluate(() => { document.documentElement.dataset.mode = "everyday"; document.dispatchEvent(new CustomEvent("atteo-mode", { detail: { everyday: true } })); });
const ev = await meta(eA);
check(ev?.who === `${NAME} · ${P}'s agent` && ev.title.includes(sA.name), `Everyday: a named agent keeps its visible owner (${JSON.stringify(ev)})`);
// The ordinary layout stays trimmed; expanded one-line messages also show the session and tool.
for (const mode of ["developer", "everyday"]) {
  await p.evaluate((mode) => { document.documentElement.dataset.mode = mode; document.documentElement.dataset.compact = "others"; }, mode);
  for (const [seq, detail] of [[eA, `${P}'s agent · ${sA.name} · Claude Code`], [eB, `${P}'s agent · ${sB.name} · Claude Code`], [eN, `${P}'s agent`]]) {
    const info = p.locator(`#e${seq} .agent-info`);
    check(!await info.isVisible(), `${mode}: owner/session hidden in collapsed row #${seq}`);
    await p.locator(`#e${seq} .body`).click();
    check(await info.isVisible() && await info.innerText() === detail && await info.locator("*").count() === 0, `${mode}: opening shows escaped owner/session/tool text (${detail})`);
    check(await p.locator(`#e${seq} .who`).innerText() === `${NAME} · ${P}'s agent`, `${mode}: opening keeps the agent name and owner`);
    await p.locator(`#e${seq} .when`).click();
    check(!await info.isVisible(), `${mode}: folding hides details again`);
  }
}
await p.evaluate(() => { document.documentElement.dataset.compact = "off"; });
check(!await p.locator(`#e${eA} .agent-info`).isVisible(), "ordinary layout still keeps agent details on hover only");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "message session: all passed"); process.exit(fails ? 1 : 0);
