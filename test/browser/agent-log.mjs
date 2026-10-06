// The agent log (jxn #4734): board messages as log rows. A gutter with the #number and local time; agents drawn as a node
// (no picture), people keep theirs; each reply joined to its parent by a rail in the gutter (one SVG path per reply that
// ends on the reply's node). The rail follows the rows: in one-line mode, and when a parent 90 messages back loads by
// a jump. On a phone the gutter goes and the rails share one lane left of the pictures.
// Usage: BASE=http://localhost:8787 node agent-log.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
import { until } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `lg${run}`, B = `lh${run}`;
await ops("users", { name: A, email: `${A}@example.com`, verified: "true", display: { mode: "developer" } });
await ops("users", { name: B, email: `${B}@example.com`, verified: "true" });
const board = (await ops("boards", { user: A, title: `Agent log ${run}` })).board.id;
await ops("members", { board, user: B });
const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], ckB = (await ops("sessions", { user: B })).cookie.split(";")[0], tokB = (await ops("tokens", { user: B })).token;
const post = async (auth, body) => { for (let i = 0; i < 2; i++) { const j = await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) })).json(); if (j.entry) return j.entry.seq; } throw new Error("post refused"); };
const agentB = (body) => post({ authorization: `Bearer ${tokB}` }, body); // a refusal marks it read; the second try posts
const old = await post({ cookie: ckA }, { text: `An old question ${run}` });
for (let i = 0; i < 90; i += 10) await Promise.all(Array.from({ length: 10 }, (_, k) => post({ cookie: ckA }, { text: `filler ${i + k} ${run}` })));
const root = await post({ cookie: ckA }, { text: `Can we ship today? ${run}` });
const r1 = await agentB({ text: `Checking CI ${run}`, reply_to: root });
const other = await agentB({ type: "claim", text: `Taking the flaky test ${run}` });
const r2 = await agentB({ text: `CI is green ${run}`, reply_to: r1 });
const r3 = await post({ cookie: ckB }, { text: `Ship it ${run}`, reply_to: root });
const r4 = await agentB({ text: `Fixed: the retry waits 500ms ${run}`, reply_to: other });
const late = await agentB({ text: `Answering the old question ${run}`, reply_to: old });
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const [k, ...v] = ckA.split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(), errors = [];
p.on("pageerror", (e) => errors.push(e.message));
// Each subpath of the graph, as [start y, end y], and each reply's node centre and its parent's (both relative to #thread).
const graph = () => p.evaluate(() => {
  const th = document.getElementById("thread"), o = th.getBoundingClientRect(), d = document.querySelector(".graph path")?.getAttribute("d") || "";
  const segs = d.split("M").filter(Boolean).map((s) => { const n = s.match(/-?[\d.]+/g).map(Number); return [n[1], n[n.length - 2]]; });
  const node = (s) => { const a = document.querySelector(`#e${s}>.av`); if (!a || !a.getClientRects().length) return null; const r = a.getBoundingClientRect(); return r.top - o.top + r.height / 2; };
  const edges = [...th.querySelectorAll(":scope>.entry[data-reply]")].map((e) => [node(e.dataset.reply), node(e.dataset.seq)]).filter(([a, b]) => a != null && b != null);
  return { segs, edges };
});
const matches = (g) => g.segs.length === g.edges.length && g.edges.every(([a, b]) => g.segs.some(([s, e]) => Math.abs(s - a) < 1.5 && Math.abs(e - b) < 1.5));
await p.goto(`${BASE}/b/${board}`);
await p.waitForSelector(`#e${r4}`);
await until(async () => matches(await graph()), 4000);
let g = await graph();
check(matches(g) && g.edges.length === 4, `a rail per reply, from its parent's node to its own (${g.segs.length} rails, ${g.edges.length} replies with both rows loaded)`);
await p.waitForSelector(`#e${r2} .rq`, { state: "attached", timeout: 4000 }).catch(() => {});
const look = await p.evaluate(([a, h, q]) => {
  const ag = document.querySelector(`#e${a}>.av`), hu = document.querySelector(`#e${h}>.av`), lg = document.querySelector(`#e${a}>.gut`);
  return { agentImg: getComputedStyle(ag.querySelector(".av-img")).display, agentBg: getComputedStyle(ag).backgroundColor, dot: getComputedStyle(ag).backgroundImage.startsWith("radial-gradient"), human: getComputedStyle(hu).fontSize !== "0px" && getComputedStyle(hu, "::before").content === "none" && (!hu.querySelector(".av-img") || getComputedStyle(hu.querySelector(".av-img")).display !== "none"), lg: lg.innerText.replace(/\s+/g, " ").trim(), font: getComputedStyle(lg).fontFamily, radius: (() => { const x = document.querySelector(`#e${q} .rq`); return x ? getComputedStyle(x).borderRadius : "(no quote)"; })() };
}, [r1, r3, r2]);
check(look.agentImg === "none" && /rgba\(0, 0, 0, 0\)|transparent/.test(look.agentBg) && look.dot, `an agent is a node, not a picture (${JSON.stringify(look)})`);
check(look.human, "a person keeps their avatar (picture, or initials until they set one)");
check(new RegExp(`^#${r1} \\d\\d:\\d\\d$`).test(look.lg) && /mono|courier/i.test(look.font), `the gutter shows the #number and local time in mono ("${look.lg}")`);
check(look.radius === "0px", "the reply quote is a hairline, not a rounded card");
// One-line mode: the rows get shorter and the rails follow them.
await fetch(`${BASE}/api/app/prefs`, { method: "POST", headers: { cookie: ckA, "content-type": "application/json", origin: BASE }, body: JSON.stringify({ display: { compact: "others" } }) });
await p.reload();
await p.waitForSelector(`#e${r4}.ol`);
await until(async () => matches(await graph()), 4000);
g = await graph();
check(matches(g) && g.edges.length === 4, `one-line mode: the rails still end on their nodes (${g.segs.length} rails)`);
// A jump to a message 90 back loads it, and the late reply's rail reaches up to it.
await p.evaluate((s) => { location.hash = "#e" + s; }, old);
await until(() => p.evaluate((s) => !!document.getElementById("e" + s), old), 8000);
await until(async () => matches(await graph()), 4000);
g = await graph();
check(matches(g) && g.edges.some(([a]) => a < 400) && g.edges.length >= 5, `after a jump loads the old message, its reply is joined to it (${g.segs.length} rails)`);
check(!errors.length, `no page errors${errors.length ? ` (${errors[0]})` : ""}`);
// A phone: no gutter, no graph; a reply is indented with a line.
const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await ph.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const q = await ph.newPage();
await q.goto(`${BASE}/b/${board}`);
await q.waitForSelector(`#e${r4}`);
await until(() => q.evaluate(() => (document.querySelector(".graph path")?.getAttribute("d") || "").split("M").length > 2), 4000);
const phone = await q.evaluate((s) => { const d = document.querySelector(".graph path")?.getAttribute("d") || "", lanes = new Set(d.split("M").filter(Boolean).map((x) => x.match(/V/) ? x.split("Q")[1].split(" ")[0] : null)); return { gut: getComputedStyle(document.querySelector(`#e${s}>.gut`)).display, rails: d.split("M").length - 1, lanes: lanes.size, wide: document.documentElement.scrollWidth > innerWidth }; }, r4);
check(phone.gut === "none" && phone.rails >= 3 && phone.lanes === 1 && !phone.wide, `390px: no gutter, and the rails share one lane (${JSON.stringify(phone)})`);
await browser.close();
console.log(fails ? `${fails} FAILED` : "agent log: all passed");
process.exit(fails ? 1 : 0);
