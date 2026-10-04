// A task someone else said they resolved (vedu's agent #2221): their message can't close a task they don't hold, so the
// Tasks tab card says "A message says this is done" (a link to it, no number) with Done, which closes it in one tap.
// A task its own author resolved is already in Done. 1280 and 390px; strings come from the tables (es checked).
// Usage: BASE=http://localhost:8798 node resolve-hint.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `rh${run}`, B = `rb${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], tokB = (await ops("tokens", { user: B })).token;
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w, lang] of [[1280, ""], [390, "es"]]) {
  const board = (await ops("boards", { user: A, title: `Resolve hint ${w} ${run}` })).board.id;
  await ops("members", { board, user: B });
  const post = (auth, body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const task = (await post({ cookie: ckA }, { type: "task", text: `Ship the release notes ${run}` })).entry.seq;
  const mine = (await post({ cookie: ckA }, { type: "task", text: `Tag the release ${run}` })).entry.seq;
  const said = (await post({ authorization: `Bearer ${tokB}` }, { type: "note", text: `release notes are out ${run}`, resolves: [task] })).entry.seq;
  // B's agent didn't write, hold or get that task, so it stays open; A's own resolve of A's task closes it.
  await post({ cookie: ckA }, { type: "note", text: `tagged ${run}`, resolves: [mine] });
  const tag = `${w}px${lang ? ` ${lang}` : ""}`, phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 820 }, isMobile: phone, hasTouch: phone });
  const [k, ...v] = ckA.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}${lang ? `?lang=${lang}` : ""}`);
  await p.waitForTimeout(700);
  await p.locator("#board-tabs button").nth(3).click();
  await p.waitForTimeout(700);
  const card = p.locator(`.kcard[data-seq="${task}"]`);
  const col = async (n) => p.locator(`.kcard[data-seq="${n}"]`).evaluate((c) => c.closest(".kcol")?.dataset.status).catch(() => null);
  check((await col(task)) !== "done" && (await col(mine)) === "done", `${tag}: another member's resolve leaves the task open (${await col(task)}); the author's own closes theirs (${await col(mine)})`);
  const link = card.locator(".kres a");
  const words = lang === "es" ? "Un mensaje dice que esto está hecho" : "A message says this is done";
  check((await link.innerText()) === words && (await link.getAttribute("href")) === `#e${said}`, `${tag}: the card says "${await link.innerText().catch(() => "")}", linking to that message`);
  check(!/#\d/.test(await card.innerText()), `${tag}: no number shows on the card (vedu #675)`);
  const btn = card.locator("[data-kdone]");
  const bb = await btn.boundingBox(), cb = await card.boundingBox();
  check(!!bb && bb.x + bb.width <= cb.x + cb.width + 0.5 && bb.height >= (phone ? 24 : 18), `${tag}: Done sits inside the card (${bb && Math.round(bb.x + bb.width)} ≤ ${Math.round(cb.x + cb.width)}, ${bb && Math.round(bb.height)}px tall)`);
  await btn.click();
  await p.waitForTimeout(900);
  check((await col(task)) === "done" && !(await p.locator(`.kcard[data-seq="${task}"] .kres`).count()), `${tag}: one tap on Done moves it to Done and the hint goes`);
  const t = (await (await fetch(`${BASE}/api/boards/${board}/tasks/${task}`, { headers: { cookie: ckA } })).json()).task;
  check(t.status === "done" && t.resolved_by === null, `${tag}: the task is done on the server (${t.status}, resolved_by ${t.resolved_by})`);
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "resolve hint: all passed");
process.exit(fails ? 1 : 0);
