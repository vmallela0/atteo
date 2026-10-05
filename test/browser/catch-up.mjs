// Catch up (vedu's agent #2498 item 5, task #2504): opening a board with 20+ unread messages offers "Catch up on N new
// messages" just above the New line; it opens Recap since you last looked, which says where its lines come from (every
// line is a message on the board, linked; nothing model-written), and a line jumps to its message. Fewer than 20 unread:
// no offer. 1280 (Developer) and 390px (Everyday, es).
// Usage: BASE=http://localhost:8798 node catch-up.mjs  (local dev only, ADMIN_KEY=ci-admin-key in .dev.vars)
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const KEY = process.env.ADMIN_KEY || "ci-admin-key";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4);
let fails = 0;
const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });

for (const [w, mode, lang] of [[1280, "developer", ""], [390, "everyday", "es"]]) {
  const A = `cu${w}${run}`, B = `cv${w}${run}`, tag = `${w}px ${mode}${lang ? ` ${lang}` : ""}`, phone = w < 500;
  for (const u of [A, B]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode } });
  const ckA = (await ops("sessions", { user: A })).cookie.split(";")[0], ckB = (await ops("sessions", { user: B })).cookie.split(";")[0];
  const mk = async (title) => { const id = (await ops("boards", { user: A, title })).board.id; await ops("members", { board: id, user: B }); return id; };
  const busy = await mk(`Busy ${w} ${run}`), calm = await mk(`Calm ${w} ${run}`);
  const post = (board, ck, body) => fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { cookie: ck, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).then((j) => j.entry.seq);
  for (const b of [busy, calm]) await post(b, ckA, { text: `hello ${run}` });

  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 820 }, isMobile: phone, hasTouch: phone });
  const [k, ...v] = ckA.split("=");
  await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(), errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  // A reads both boards (that's where "since you last looked" starts), then B writes: 24 on one, 5 on the other.
  for (const b of [busy, calm]) { await p.goto(`${BASE}/b/${busy === b ? busy : calm}`); await p.waitForTimeout(800); }
  let q = 0;
  for (let i = 0; i < 24; i++) {
    const s = await post(busy, ckB, i === 3 ? { type: "question", to: A, text: `Should staging use port 8985? ${run}` } : { text: `update ${i} on the deploy ${run}` });
    if (i === 3) q = s;
  }
  for (let i = 0; i < 5; i++) await post(calm, ckB, { text: `small thing ${i} ${run}` });

  await p.goto(`${BASE}/b/${busy}${lang ? `?lang=${lang}` : ""}`);
  await p.waitForTimeout(1200);
  const offer = p.locator("#catch-up button");
  const want = lang === "es" ? "Ponte al día: 24 mensajes nuevos" : "Catch up on 24 new messages";
  check((await offer.count()) === 1 && (await offer.innerText()).trim() === want, `${tag}: 24 unread → "${(await offer.innerText().catch(() => "")).trim()}"`);
  const order = await p.evaluate(() => { const c = document.getElementById("catch-up"), l = document.getElementById("new-line"); return !!c && !!l && c.nextElementSibling === l; });
  check(order, `${tag}: the offer sits right above the New line`);
  const ob = await offer.boundingBox(), sb = await p.locator("#thread-scroll").boundingBox();
  check(!!ob && ob.y >= sb.y && ob.y + ob.height <= sb.y + sb.height && ob.x >= 0 && ob.x + ob.width <= w, `${tag}: it's on screen when the board opens`);
  if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/catch-up-${w}.png` }).catch(() => {});
  await offer.click();
  const dlg = p.locator("dialog#recap-dlg[open]");
  await dlg.waitFor({ timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(600);
  const sub = await p.locator("#recap-sub").innerText().catch(() => "");
  check((await dlg.count()) === 1 && /24/.test(sub), `${tag}: it opens Recap since you last looked ("${sub}")`);
  const note = await p.locator("#recap-body .rc-src").innerText().catch(() => "");
  check(note.length > 20 && !/\bAI\b|IA\b/.test(note), `${tag}: Recap says its lines are the board's own messages ("${note}")`);
  check(!(await p.locator("#catch-up").count()), `${tag}: the offer goes once used`);
  const line = p.locator(`#recap-body a[data-recap-go="${q}"]`).first();
  check((await line.count()) === 1, `${tag}: the open question is in Recap, linked to its message`);
  if (await line.count()) {
    await line.click();
    await p.waitForTimeout(900);
    const seen = await p.evaluate((s) => { const e = document.getElementById("e" + s); if (!e) return false; const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }, q);
    check(!(await dlg.count()) && seen, `${tag}: a Recap line jumps to its message`);
  }
  // Only a few unread: no offer, just the New line.
  await p.goto(`${BASE}/b/${calm}`);
  await p.waitForTimeout(1000);
  check(!(await p.locator("#catch-up").count()) && (await p.locator("#new-line").count()) === 1, `${tag}: 5 unread → no offer, just the New line`);
  check(!errors.length, `${tag}: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "catch up: all passed");
process.exit(fails ? 1 : 0);
