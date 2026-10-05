// Favourite reactions follow you across devices (vedu #1163, #1166): the web picker's row lives in /api/app/prefs (reactions),
// with a localStorage copy that draws at once. Checks: an unset row is seeded from recent_reactions; favourites set in one
// browser show up in a second one with fresh localStorage; the row draws from the copy when the server can't be reached; a
// failed write keeps the row and lands once the network is back; Reset goes back to the default (and the seeded row); a row
// saved by an older build (browser only) is sent up; a read-only viewer never calls the prefs API; no page errors.
// Usage: BASE=http://localhost:8787 [ADMIN_KEY=…] node emoji-sync.mjs
import { chromium } from "playwright-core";
const BASE = (process.env.BASE || "http://localhost:8787").replace(/\/$/, "");
let KEY = process.env.ADMIN_KEY;
// (the gate runs against 8787, whose ADMIN_KEY is ci-admin-key)
KEY ||= "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-5), P = `es${run}`, V = `ev${run}`, R = `er${run}`;
for (const u of [P, V, R]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
const board = (await ops("boards", { user: P, title: `Emoji sync ${run}` })).board.id;
await ops("members", { board, user: V });
await ops("members", { board, user: R });
const ck = (await ops("sessions", { user: P })).cookie, ckR = (await ops("sessions", { user: R })).cookie, tokV = (await ops("tokens", { user: V })).token;
const mcp = async (name, args) => (await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokV}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.content[0].text;
const post = async (text) => { await mcp("read", {}); return +(await mcp("post", { type: "note", text })).match(/#(\d+)/)[1]; };
const n1 = await post(`First ${run}`), n2 = await post(`Second ${run}`);
const W = { cookie: ck.split(";")[0] };
const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...W, "content-type": "application/json", ...(init.headers || {}) } });
const prefs = async () => (await (await api("/api/app/prefs")).json()).prefs;
const DEF = ["👍", "✅", "🤔", "🎉", "❤️", "🔥", "😂", "🙏"];
let fails = 0;
const check = (ok, m) => { console.log(`${ok ? "✓" : "✗"} ${m}`); if (!ok) fails++; };
const until = async (f, ms = 15000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 150)); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The person reacts (as on any device): 🚀 twice, 🐙 once, so recent_reactions = [🚀, 🐙]. Favourites never set.
const react = (seq, emoji) => api(`/api/boards/${board}/entries/${seq}/react`, { method: "POST", body: JSON.stringify({ emoji }) });
await react(n1, "🚀"); await react(n2, "🚀"); await react(n1, "🐙");
const p0 = await until(async () => { const p = await prefs(); return p.recent_reactions.length === 2 && p; });
check(p0 && same(p0.recent_reactions, ["🚀", "🐙"]) && same(p0.reactions, DEF), `server: recent_reactions ${JSON.stringify(p0?.recent_reactions)}, reactions still the default`);

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const cookieOf = (c) => { const [k, ...v] = c.split(";")[0].split("="); return { name: k, value: v.join("="), url: BASE }; };
const errors = [];
const open = async (c = ck, init) => {
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  await ctx.addCookies([cookieOf(c)]);
  // Only in the page itself: the HTML preview's sandboxed iframe (no allow-same-origin) throws on any localStorage access.
  if (init) await ctx.addInitScript(`if (window.top === window) { ${init} }`);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return { ctx, p };
};
const bar = (p, seq = n1) => p.locator(`#e${seq} .acts .rx-q`).evaluateAll((bs) => bs.map((b) => b.dataset.emo).join(""));
const quick = (p) => p.locator(".rx-pick .rp-quick [data-pick]").evaluateAll((bs) => bs.map((b) => b.dataset.pick).join(""));
const lsGet = (p, k, who = P) => p.evaluate(([k, who]) => localStorage.getItem("atteo.rx." + k + "." + who), [k, who]);
// Playwright's own actionability waits cover the picker opening and its buttons appearing: no settle sleeps needed.
const openPicker = async (p) => { await p.locator(`#e${n1}`).hover(); await p.locator(`#e${n1} .acts [data-rx-add]`).click(); };
const customize = async (p) => { await openPicker(p); await p.locator(".rx-pick [data-rp-cz]").click(); };
const tap = async (p, e) => { await p.locator(`.rx-pick .rp-body [data-ep="${e}"]`).first().click(); };
const done = async (p) => { await p.locator(".rx-pick [data-rp-done]").click(); await p.keyboard.press("Escape"); };

// 1. Seeding: a fresh browser, nothing chosen: the row is your most-used from every device, then the defaults.
const A = await open();
await A.p.goto(`${BASE}/b/${board}`);
const seeded = await until(async () => (await bar(A.p)) === "🚀🐙👍" && "ok", 12000);
check(seeded, `fresh browser, never set: one-click buttons seeded from recent_reactions (${await bar(A.p)})`);
await openPicker(A.p);
const q0 = await quick(A.p);
check(q0 === "🚀🐙👍✅🤔🎉❤️🔥", `quick row: most-used then the defaults (${q0})`);
const fr0 = await A.p.locator(".rx-pick .rp-sec").first().locator("[data-ep]").evaluateAll((bs) => bs.map((b) => b.dataset.ep).join(""));
check(fr0.startsWith("🚀🐙"), `Frequently used starts with your most-used on every device (${fr0.slice(0, 12)}…)`);
await A.p.keyboard.press("Escape");
check(same((await prefs()).reactions, DEF), "seeding writes nothing: the server still says the default");

// 2. Set favourites in browser A: 👀 🎉 🔥, then move 🔥 to the front.
await customize(A.p);
for (const e of ["👀", "🎉", "🔥"]) await tap(A.p, e);
await A.p.locator('.rx-pick .rp-quick [data-slot="2"]').click();
await A.p.locator('.rx-pick [data-rp-mv="-1"]').click(); await A.p.locator('.rx-pick [data-rp-mv="-1"]').click();
await done(A.p);
const want = ["🔥", "👀", "🎉"];
const p1 = await until(async () => { const p = await prefs(); return same(p.reactions, want) && p; });
check(p1, `browser A's choice lands on the server in order (${JSON.stringify((await prefs()).reactions)})`);
check((await bar(A.p)) === "🔥👀🎉", `browser A's one-click buttons follow (${await bar(A.p)})`);
check(!(await lsGet(A.p, "dirty")), "nothing left unsent in A");

// 3. Browser B, fresh localStorage: sees them.
const B = await open();
await B.p.goto(`${BASE}/b/${board}`);
check(await until(async () => (await bar(B.p)) === "🔥👀🎉" && "ok", 12000), `browser B (fresh localStorage) shows A's favourites (${await bar(B.p)})`);
await openPicker(B.p);
const qB = await quick(B.p);
check(qB.startsWith("🔥👀🎉🚀🐙"), `B's quick row: favourites, then most-used fill the rest (${qB})`);
await B.p.keyboard.press("Escape");
check(same(JSON.parse(await lsGet(B.p, "quick")), want), "B keeps a local copy");
// Server unreachable: the row draws from the copy immediately.
await B.p.route("**/api/app/prefs", (r) => r.abort());
await B.p.reload();
await B.p.waitForSelector(`#e${n1} .acts .rx-q`, { state: "attached" });
check((await bar(B.p)) === "🔥👀🎉", `prefs API down: B draws the row from its copy (${await bar(B.p)})`);
// A failed write keeps the local value and retries quietly; it lands once the network is back.
await customize(B.p);
await tap(B.p, "🙏");
await done(B.p);
// Wait for the local copy to be marked unsent (the thing asserted below), not a fixed settle.
await until(async () => (await lsGet(B.p, "dirty")) === "1", 3000);
check((await bar(B.p)) === "🔥👀🎉" && same(JSON.parse(await lsGet(B.p, "quick")), [...want, "🙏"]) && (await lsGet(B.p, "dirty")) === "1", "offline write: kept locally, marked unsent");
check(same((await prefs()).reactions, want), "…and the server still has the old row");
const toasts = await B.p.locator(".toast").evaluateAll((ts) => ts.filter((t) => t.offsetParent).map((t) => t.textContent));
check(!toasts.some((t) => /prefs|save|couldn/i.test(t)), `…quietly, no error toast (${JSON.stringify(toasts)})`);
await B.p.unroute("**/api/app/prefs");
check(await until(async () => same((await prefs()).reactions, [...want, "🙏"]) && "ok", 20000), `back online: the retry lands (${JSON.stringify((await prefs()).reactions)})`);
check(await until(async () => !(await lsGet(B.p, "dirty")) && "ok", 6000), "…and B has nothing left unsent");
// A picks it up on its next load.
await A.p.reload();
check(await until(async () => { await openPicker(A.p); const q = await quick(A.p); await A.p.keyboard.press("Escape"); return q.startsWith("🔥👀🎉🙏") && "ok"; }, 12000), "A's next load has B's change");

// 4. Reset (in A): the server goes back to the default; both browsers fall back to the seeded row.
await customize(A.p);
await A.p.locator(".rx-pick [data-rp-reset]").click();
await done(A.p);
check(await until(async () => same((await prefs()).reactions, DEF) && "ok"), `Reset: server back to the default preset (${JSON.stringify((await prefs()).reactions)})`);
check((await bar(A.p)) === "🚀🐙👍", `A after Reset: seeded row again (${await bar(A.p)})`);
check((await lsGet(A.p, "quick")) === null, "A's local copy cleared");
await B.p.reload();
check(await until(async () => (await bar(B.p)) === "🚀🐙👍" && "ok", 12000), `B after reload: seeded row too (${await bar(B.p)})`);

// 5. A row saved by an older build (this browser only, before the server held it) is sent up, not wiped.
const C = await open(ck, `localStorage.setItem(${JSON.stringify("atteo.rx.quick." + P)}, JSON.stringify(["🐛","🚢"]))`);
await C.p.goto(`${BASE}/b/${board}`);
check(await until(async () => same((await prefs()).reactions, ["🐛", "🚢"]) && "ok"), `older browser-only row is sent up (${JSON.stringify((await prefs()).reactions)})`);
check((await bar(C.p)) === "🐛🚢🚀", `…and stays on screen (${await bar(C.p)})`);
await api("/api/app/prefs", { method: "POST", body: JSON.stringify({ reactions: null }) });

// 6. A read-only viewer: the row from this browser alone, never the prefs API.
check((await api(`/api/boards/${board}/members/${R}`, { method: "POST", body: JSON.stringify({ role: "viewer" }) })).ok, "R is a viewer on the board");
const RO = await open(ckR, `localStorage.setItem(${JSON.stringify("atteo.rx.quick." + R)}, JSON.stringify(["🦄","👀"]))`);
const calls = [];
RO.p.on("request", (r) => { if (r.url().includes("/api/app/prefs")) calls.push(r.method()); });
await RO.p.goto(`${BASE}/b/${board}`);
await RO.p.waitForTimeout(1500);
const roBar = await bar(RO.p);
check(calls.length === 0, `read-only viewer makes no prefs calls (${calls.join(",") || "none"})`);
check(roBar === "" || roBar === "🦄👀👍", `…and any one-click buttons come from localStorage (${roBar || "none shown"})`);

check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
