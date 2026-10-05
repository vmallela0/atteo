// Reacting inside an open thread (vedu #2877): a reply in the thread has its add-reaction button, the picker opens above
// the modal thread and takes the tap, and the chip shows on the thread's copy of the message as well as in the chat.
// Usage: BASE=http://localhost:8787 PW_CHROME=… node thread-react.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), A = `tr${run}`, B = `ts${run}`;
for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: A, title: `Thread react ${run}` })).board.id;
await ops("members", { board, user: B });
const ckA = (await ops("sessions", { user: A })).cookie, ckB = (await ops("sessions", { user: B })).cookie;
const post = async (ck, body) => (await (await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(body) })).json()).entry.seq;
const root = await post(ckA, { text: `thread root ${run}` });
const reply = await post(ckB, { text: `a reply to react to ${run}`, reply_to: root });

let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [w, mobile] of [[1280, false], [390, true]]) await width(w, mobile); // one after another: both react to the same reply
async function width(w, mobile) {
  const ctx = await b.newContext({ viewport: { width: w, height: 860 }, isMobile: mobile, hasTouch: mobile });
  const [k, ...v] = ckA.split(";")[0].split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${BASE}/b/${board}`);
  await p.locator(`#e${root}`).waitFor();
  await p.locator(`#e${root} [data-thread]`).first().click();
  const inThread = p.locator(`#thr-list [data-src="${reply}"]`);
  await inThread.waitFor({ timeout: 5000 });
  const add = inThread.locator(".rx-add");
  check(await add.count() === 1, `${w}px: a reply in the thread has its add-reaction button`);
  if (!(await add.count())) { await ctx.close(); return; }
  await add.click({ force: true });
  const pick = p.locator(".rx-pick:not([hidden]) .rp-quick button").first();
  await pick.waitFor({ timeout: 3000 }).catch(() => {});
  check(await pick.isVisible().catch(() => false), `${w}px: the picker opens above the open thread`);
  const emoji = await pick.textContent().catch(() => "");
  await pick.click().catch(() => {});
  await p.locator(`#thr-list [data-src="${reply}"] .rx-chip.on`).waitFor({ timeout: 5000 }).catch(() => {});
  check(await p.locator(`#thr-list [data-src="${reply}"] .rx-chip.on`).count() === 1, `${w}px: the reaction (${emoji}) shows on the thread's copy`);
  check(await p.locator(`#e${reply} .rx-chip.on, [data-rx="${reply}"] .rx-chip.on`).count() >= 1, `${w}px: and in the chat`);
  // Take it back off so the other width starts clean.
  await p.locator(`#thr-list [data-src="${reply}"] .rx-chip.on`).click().catch(() => {});
  check(!errors.length, `${w}px: no page errors ${errors.join(" | ")}`);
  await ctx.close();
}
await b.close();
console.log(fails ? `${fails} FAILED` : "thread-react: all passed");
process.exit(fails ? 1 : 0);
