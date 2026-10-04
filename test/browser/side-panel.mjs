// A tidier side panel (#1385; vedu #1361, jxn #1380): each list shows its newest 3, one line each, with "Show all N"
// (kept open across live refreshes); a question closes itself when the member it's for (or their agent) answers in its
// thread; people mark a stale one answered with the ✓ (live in other tabs too); viewers get no ✓. Phone, dark, no
// page errors.
// Usage: BASE=http://localhost:8787 [ADMIN_KEY=…] node side-panel.mjs
import { SHOTS_DIR } from "./lib/shots.mjs";
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
let KEY = process.env.ADMIN_KEY;
// (the gate runs against 8787, whose ADMIN_KEY is ci-admin-key)
KEY ||= "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), O = `so${run}`, M = `sm${run}`, V = `sv${run}`;
for (const u of [O, M, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: O, title: `Side panel ${run}` })).board.id;
for (const u of [M, V]) await ops("members", { board, user: u });
const ck = (await ops("sessions", { user: O })).cookie, ckV = (await ops("sessions", { user: V })).cookie;
const tokO = (await ops("tokens", { user: O })).token, tokM = (await ops("tokens", { user: M })).token;
await fetch(`${BASE}/api/boards/${board}/members/${V}`, { method: "POST", headers: { cookie: ck.split(";")[0], "content-type": "application/json" }, body: JSON.stringify({ role: "viewer" }) });
const post = async (tok, body) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json()).entry.seq;
const qs = [];
for (let i = 1; i <= 5; i++) qs.push(await post(tokO, { type: "question", text: `Question number ${i} about the rollout?` }));
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (f, ms = 8000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 150)); } };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const errors = [];
const open = async (c, w = 1400, h = 900, scheme = "light") => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  const [k, ...v] = c.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.waitForTimeout(600);
  return { ctx, p };
};
const shown = (p, id = "questions") => p.locator(`#sum ul[data-cap="${id}"] > li, #sum [data-fold="${id}"] ul > li`).evaluateAll((ls) => [...new Set(ls)].filter((l) => getComputedStyle(l).display !== "none").map((l) => +l.querySelector("a").getAttribute("href").slice(2)));

const A = await open(ck);
const B = await open(ck, 1400, 900, "dark");
let s = await shown(A.p);
check(JSON.stringify(s) === JSON.stringify(qs.slice(-3)), `the newest 3 of 5 show (${s})`);
check((await A.p.locator('#sum [data-cap-more="questions"]').textContent()) === "Show all 5", "…with Show all 5");
const oneLine = await A.p.locator("#sum li .one").first().evaluate((el) => el.scrollHeight <= el.clientHeight + 2 && getComputedStyle(el).whiteSpace === "nowrap");
check(oneLine, "one line each");
await A.p.locator('#sum [data-cap-more="questions"]').click();
s = await shown(A.p);
check(s.length === 5 && (await A.p.locator('#sum [data-cap-more="questions"]').textContent()) === "Show less", `Show all opens the rest (${s.length})`);
// A live refresh (a new question) keeps it open.
const q6 = await post(tokO, { type: "question", to: M, text: "Is staging on 8443?" });
check(await until(async () => (await A.p.locator(`#sum a[href="#e${q6}"]`).count()) > 0 && "ok"), "a new question arrives live");
s = await shown(A.p);
check(s.length >= 5 && (await A.p.locator('#sum ul.capped.all').count()) >= 1, `…and Show all stays open (${s.length} shown)`);
await A.p.locator('#sum [data-cap-more="questions"]').click();
check((await shown(A.p)).length === 3, "Show less goes back to 3");
// Waiting on you / for your agent are capped the same way: q6 is for M, so in O's panel it's an open question.
// The member it's for answers deeper in its thread: it closes, live, in both tabs.
const follow = await post(tokO, { type: "question", reply_to: q6, text: "Or 443?" });
await until(async () => (await A.p.locator(`#sum a[href="#e${follow}"]`).count()) > 0 && "ok");
await post(tokM, { type: "note", reply_to: follow, text: "8443." });
check(await until(async () => (await A.p.locator(`#sum a[href="#e${q6}"]`).count()) === 0 && (await B.p.locator(`#sum a[href="#e${q6}"]`).count()) === 0 && "ok"), "answered in its thread by the member it's for: it closes, live, everywhere");
// Mark answered.
const target = qs[4];
const btn = A.p.locator(`#sum [data-answered="${target}"]`);
check(await btn.isVisible() && (await btn.getAttribute("title")) === "Mark answered", "open questions have a ✓ Mark answered");
await btn.click();
check(await until(async () => (await A.p.locator(`#sum a[href="#e${target}"]`).count()) === 0 && "ok", 4000), "✓ removes it from the panel");
check(await until(async () => (await B.p.locator(`#sum a[href="#e${target}"]`).count()) === 0 && "ok"), "…and from another open tab, live");
check(await A.p.locator("#toast").textContent() === "Marked answered", "says so");
await A.p.reload();
await A.p.waitForTimeout(500);
check((await A.p.locator(`#sum a[href="#e${target}"]`).count()) === 0, "…and it stays answered after a reload");
await A.p.screenshot({ path: `${SHOTS_DIR}/side-panel-desktop.png` });
await B.p.screenshot({ path: `${SHOTS_DIR}/side-panel-dark.png` });
// A viewer sees the panel, no ✓.
const Vw = await open(ckV);
check((await Vw.p.locator("#sum [data-answered]").count()) === 0 && (await Vw.p.locator("#sum li").count()) > 0, "a viewer gets no ✓");
// Phone: the board info panel.
const P = await open(ck, 390, 844);
const over = await P.p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check(over <= 1, `phone: no sideways scroll (${over}px)`);
check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
