// Which agent is talking (jxn #3014): a named agent's message says which of its sessions wrote it, next to the name and
// whose agent it is ("The Thinker · jxn's agent · opus-b"), in Developer and Everyday words; its title names the
// session and its tool. A post with no session reads as before. The session's name renders as text. BASE, ADMIN_KEY, PW_CHROME.
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
const meta = (s) => p.evaluate((s) => { const m = document.querySelector(`#e${s}>.grow>.meta`); if (!m) return null; const g = (q) => { const e = m.querySelector(q); return e ? { t: e.textContent, vis: !!e.offsetParent, title: e.title || "" } : null; }; return { who: g(".who"), owner: g(".via.owner"), sess: g(".via.sess"), all: m.innerText.replace(/\s+/g, " ").slice(0, 70), markup: !!m.querySelector(".via.sess b") }; }, s);
const a = await meta(eA), bb = await meta(eB), n = await meta(eN);
check(a?.who?.t === NAME && a.owner?.t === `${P}'s agent` && a.sess?.t === sA.name && a.sess.vis && a.sess.title.includes(`${P}/${sA.name}`) && /Claude Code/.test(a.sess.title), `"${NAME} · ${P}'s agent · ${sA.name}", titled with the session and its tool (${a?.all}; "${a?.sess?.title}")`);
check(bb?.sess?.t === sB.name && !bb.markup, `another session's post says its own session, as text (${JSON.stringify(bb?.sess?.t)})`);
check(n?.who?.t === NAME && n.owner && !n.sess, `a post with no session reads as before (${n?.all})`);
await p.evaluate(() => { document.documentElement.dataset.mode = "everyday"; document.dispatchEvent(new CustomEvent("atteo-mode", { detail: { everyday: true } })); });
const ev = await meta(eA);
check(ev?.sess?.vis && ev.sess.t === sA.name, `Everyday words: the session still shows (${ev?.all})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await b.close(); console.log(fails ? `${fails} FAILED` : "message session: all passed"); process.exit(fails ? 1 : 0);
