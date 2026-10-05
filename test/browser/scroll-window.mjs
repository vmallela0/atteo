// A bounded conversation on a long board (jxn #1365, on rail-cap for #1366/#1367): ~400 messages; far ones become
// placeholders, so the page holds a bounded number of messages; jumps, links, #refs, the rail and threads bring back
// what they need; new messages ease in, never push you when you're scrolled up, and the pill counts them.
// Fast (opus-a #2937): each step waits for what it should produce (the message centred, placeholders filled, the pill's
// count) instead of a fixed settle; the assertions are the same.
import { chromium } from "playwright-core";
import { until, stable } from "./lib/wait.mjs";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `sw${run}`, V = `sv${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Window ${run}` })).board.id; await ops("members", { board, user: V });
const ckP = (await ops("sessions", { user: P })).cookie, ckV = (await ops("sessions", { user: V })).cookie;
let lastSeq = 0;
const post = async (ck, text, reply_to) => { const r = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(reply_to ? { text, reply_to } : { text }) }); const j = await r.json(); const seq = j.entry?.seq ?? j.seq; lastSeq = Math.max(lastSeq, seq); return seq; };
const N = 400, words = "the quick brown fox jumps over a lazy dog while agents talk about the retry limit and the release plan".split(" ");
const line = (i) => Array.from({ length: 6 + (i * 7) % 40 }, (_, k) => words[(i + k) % words.length]).join(" ");
const S = {}; // named seqs
for (let i = 1; i <= N; i++) {
  if (i === 40) S.forYou = await post(ckV, `@${P} this one is for you ${run}`);
  else if (i === 100) S.root = await post(ckV, `Thread root ${run}: what should the retry limit be?`);
  else if (i === 102) S.kid1 = await post(ckV, `First answer: three ${run}`, S.root);
  else if (i === 300) S.kid2 = await post(ckV, `Late answer: five ${run}`, S.root);
  else if (i === 20) S.target = await post(ckV, `Ref target ${run}: the old decision`);
  else if (i === 390) S.ref = await post(ckV, `See #${S.target} for the old decision`);
  else await post(ckV, `message ${i}: ${line(i)}${i % 9 === 0 ? "\n\n" + line(i + 3) + "\n" + line(i + 5) : ""}`);
}
let fails = 0; const check = (ok, t) => { console.log(`${ok ? "✓" : "✗"} ${t}`); if (!ok) fails++; };
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
async function open(path = "", opts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ...opts }); const [k, ...v] = ckP.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  const p = await ctx.newPage(); p.errors = []; p.on("pageerror", (e) => p.errors.push(e.message)); p.seen = [];
  p.on("request", (r) => { if (r.url().endsWith("/seen") && r.method() === "POST") try { p.seen.push(JSON.parse(r.postData()).seq) } catch {} });
  await p.goto(`${BASE}/b/${board}${path}`); await p.waitForFunction(() => !!window.BOARD_CTX && document.querySelector("#thread>.entry"));
  // Opened where it should be (the newest, unless a link says otherwise) and done moving: the page's own load-time
  // placeholders and scroll-to-bottom have run.
  if (!path) await until(() => p.evaluate(() => { const sc = document.getElementById("thread-scroll"); return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 30; }), 5000);
  await stable(() => p.evaluate(() => { const sc = document.getElementById("thread-scroll"); return [sc.scrollTop, sc.scrollHeight, document.querySelectorAll("#thread>.ghost").length]; }), 4000, 300);
  return { ctx, p };
}
const stats = (p) => p.evaluate(() => ({ live: document.querySelectorAll("#thread>.entry").length, ghosts: document.querySelectorAll("#thread>.ghost").length, more: !!document.getElementById("load-earlier"), first: +document.querySelector("#thread>[data-seq]")?.dataset.seq }));
const centred = (p, seq) => p.evaluate((s) => { const el = document.getElementById("e" + s), sc = document.getElementById("thread-scroll"); if (!el) return 1e9; const r = el.getBoundingClientRect(), q = sc.getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - (q.top + q.bottom) / 2) }, seq);
const settle = (p, ms = 900) => p.waitForTimeout(ms);
/** After a jump: the message is a real entry, centred, and the view has stopped moving. */
const landed = async (p, seq, off = 120) => { await until(async () => (await p.locator(`#e${seq}.entry`).count()) === 1 && (await centred(p, seq)) < off, 8000); await stable(() => centred(p, seq), 3000, 100); };
/** Placeholders in view have come back as messages. */
const filled = (p) => until(() => p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(); return ![...document.querySelectorAll("#thread>.ghost")].some((g) => { const r = g.getBoundingClientRect(); return r.bottom > q.top && r.top < q.bottom; }); }), 8000);

// 1. Opening and going all the way back: older messages load as you scroll up, the page never holds more than a window.
{ const { ctx, p } = await open();
  let s = await stats(p); check(s.live <= 90 && s.ghosts > 0, `opening: ${s.live} messages on the page, ${s.ghosts} placeholders`);
  await p.locator("#thread-scroll").hover({ position: { x: 300, y: 300 } });
  let maxLive = 0, frames = [];
  await p.evaluate(() => { window.__fr = []; let t0 = performance.now(); const f = (t) => { window.__fr.push(t - t0); t0 = t; if (window.__fr.length < 4000) requestAnimationFrame(f) }; requestAnimationFrame(f) });
  for (let i = 0; i < 160 && (s.more || s.first > 1); i++) { await p.mouse.wheel(0, -900); await p.waitForTimeout(90); if (i % 8 === 0) { s = await stats(p); maxLive = Math.max(maxLive, s.live) } }
  await until(async () => { s = await stats(p); return !s.more && s.first === 1; }, 5000); await filled(p); s = await stats(p); maxLive = Math.max(maxLive, s.live);
  frames = await p.evaluate(() => window.__fr.slice(5).sort((a, b) => a - b));
  const p95 = frames[Math.floor(frames.length * 0.95)] || 0;
  check(!s.more && s.first === 1, `scrolling up loads older messages on its own, back to #1 (first on page #${s.first})`);
  check(maxLive <= 130, `the page held at most ${maxLive} messages while scrolling through ${N}`);
  check(s.live + s.ghosts >= N - 2, `every message is on the page or a placeholder (${s.live} + ${s.ghosts})`);
  check(p95 < 70, `scrolling stays smooth: 95% of frames under ${Math.round(p95)}ms`);
  check(await p.locator(`#e${S.forYou}`).count() === 1, `the message for you stays on the page however far you scroll`);
  // Placeholders coming back don't move what you're looking at: land among them, then watch the message at the top of the view
  // (messages below it in view can still settle to their real heights, as off-screen ones always have since rail-cap).
  for (const f of [0.3, 0.6]) {
    const a0 = await p.evaluate((f) => { const sc = document.getElementById("thread-scroll"); sc.scrollTop = sc.scrollHeight * f; const q = sc.getBoundingClientRect();
      const el = [...document.getElementById("thread").children].find((x) => x.getBoundingClientRect().bottom > q.top); return { seq: el.dataset.seq, ghost: el.classList.contains("ghost"), y: el.getBoundingClientRect().top } }, f);
    await filled(p); await stable(() => p.evaluate((s) => (document.getElementById("e" + s) || document.getElementById("g" + s))?.getBoundingClientRect().top, a0.seq), 3000, 120);
    const a1 = await p.evaluate((s) => { const el = document.getElementById("e" + s) || document.getElementById("g" + s); return el && { y: el.getBoundingClientRect().top, live: el.classList.contains("entry"), ghosts: [...document.querySelectorAll("#thread>.ghost")].filter((g) => { const r = g.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight }).length } }, a0.seq);
    check(a0.ghost && a1 && a1.live && a1.ghosts === 0 && Math.abs(a1.y - a0.y) <= 3, `landing among placeholders at ${f * 100}%: they come back and #${a0.seq} stays put (${Math.round(a0.y)} → ${a1 ? Math.round(a1.y) : "gone"})`);
  }
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 2. Jumps to messages that aren't on the page: search's jump, a #ref chip, a link, the rail and a thread.
{ const { ctx, p } = await open();
  await p.evaluate((s) => window.BOARD_CTX.jump(s), 5); await landed(p, 5);
  check((await p.locator("#e5.entry").count()) === 1 && (await centred(p, 5)) < 120, `a jump to #5 (never loaded) brings it in, centred (${Math.round(await centred(p, 5))}px off)`);
  await p.evaluate((s) => window.BOARD_CTX.jump(s), S.ref); await landed(p, S.ref);
  await p.evaluate((s) => window.BOARD_CTX.jump(s), 200); await landed(p, 200);
  await until(async () => (await p.locator(`#g8`).count()) === 1 && (await p.locator(`#g${S.target}`).count()) === 1, 5000); // left behind: placeholders
  check((await centred(p, 200)) < 120, `a jump to #200 lands centred (${Math.round(await centred(p, 200))}px off)`);
  let s = await stats(p); check(s.live <= 130, `after jumping around, ${s.live} messages on the page`);
  check((await p.locator(`#g8`).count()) === 1 && (await p.locator(`#g${S.target}`).count()) === 1, `messages left behind became placeholders (#8, #${S.target})`);
  await p.evaluate((s) => window.BOARD_CTX.jump(s), S.ref); await landed(p, S.ref);
  await p.locator(`#e${S.ref} a.ref`).first().click(); await landed(p, S.target, 140);
  check((await p.locator(`#e${S.target}.entry`).count()) === 1 && (await centred(p, S.target)) < 140, `a #ref chip jumps to #${S.target}, brought back from a placeholder`);
  // The thread's root and late reply: "2 replies" counts a reply that's a placeholder, and the overlay brings both back.
  await p.evaluate((s) => window.BOARD_CTX.jump(s), S.root); await landed(p, S.root);
  await until(async () => /2 replies/.test(await p.locator(`#e${S.root} .thr-sum`).innerText({ timeout: 200 }).catch(() => "")), 5000);
  const sum = await p.locator(`#e${S.root} .thr-sum`).innerText().catch(() => "");
  check(/2 replies/.test(sum) && (await p.locator(`#g${S.kid2}`).count()) === 1, `"2 replies" counts the late reply while it's a placeholder ("${sum.replace(/\s+/g, " ").trim()}")`);
  await p.locator(`#e${S.root} .thr-sum`).click();
  await until(async () => { const t = await p.locator("dialog.thr-dlg").innerText({ timeout: 200 }).catch(() => ""); return t.includes("First answer") && t.includes("Late answer"); }, 8000);
  const dl = await p.locator("dialog.thr-dlg").innerText().catch(() => "");
  check(dl.includes("First answer") && dl.includes("Late answer"), `the thread overlay brings back every reply`);
  await p.keyboard.press("Escape"); await until(() => p.evaluate(() => !document.querySelector("dialog.thr-dlg[open]")), 3000);
  // The rail: clicking near its top goes there and the messages come back.
  const rb = await p.locator("#rail").boundingBox(); await p.mouse.click(rb.x + rb.width / 2, rb.y + rb.height * 0.04);
  await stable(() => p.evaluate(() => document.getElementById("thread-scroll").scrollTop), 4000, 150); await filled(p);
  const near = await p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(); const els = [...document.querySelectorAll("#thread>.entry,#thread>.ghost")].filter((x) => { const r = x.getBoundingClientRect(); return r.bottom > q.top && r.top < q.bottom }); return { n: els.length, ghosts: els.filter((x) => x.classList.contains("ghost")).length, seq: +els[0]?.dataset.seq } });
  check(near.n > 0 && near.ghosts === 0 && near.seq < 60, `the rail goes back to the start (#${near.seq} at the top) and what's in view is real messages`);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 3. A deep link to a message that's not on the page.
{ const { ctx, p } = await open(`#e12`); await landed(p, 12, 200);
  check((await p.locator("#e12.entry").count()) === 1 && (await centred(p, 12)) < 200, `a link to #12 opens there (${Math.round(await centred(p, 12))}px off centre)`);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 3b. On a phone: the same window, and a jump still lands.
{ const { ctx, p } = await open("", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await p.evaluate((s) => window.BOARD_CTX.jump(s), 150); await landed(p, 150, 140);
  const s = await stats(p);
  check((await centred(p, 150)) < 140 && s.live <= 130 && s.ghosts > 100, `phone: a jump to #150 lands (${Math.round(await centred(p, 150))}px off), ${s.live} messages on the page`);
  check(!p.errors.length, `phone: no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 4. New messages: ease in at the bottom; scrolled up, they don't push you and the pill counts them. P has read
// everything so far (as the earlier pages would report given time), so the board opens at the newest, not at a New line.
for (const motion of ["no-preference", "reduce"]) {
  await fetch(`${BASE}/api/boards/${board}/seen`, { method: "POST", headers: { "content-type": "application/json", cookie: ckP.split(";")[0] }, body: JSON.stringify({ seq: lastSeq }) });
  const { ctx, p } = await open("", { reducedMotion: motion });
  const seqA = await post(ckV, `arrives at the bottom ${motion}`); await p.waitForSelector(`#e${seqA}`, { timeout: 8000 });
  const anim = await p.evaluate((s) => getComputedStyle(document.getElementById("e" + s)).animationName, seqA);
  if (motion === "reduce") check(!/entryin/.test(anim), `reduced motion: the new message doesn't move (${anim})`);
  else check(/entryin/.test(anim) && (await p.evaluate(() => { const sc = document.getElementById("thread-scroll"); return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 30 })), `at the bottom, a new message eases in and the view follows it (${anim})`);
  if (motion === "no-preference") {
    await p.locator("#thread-scroll").hover({ position: { x: 300, y: 300 } }); for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -700); await p.waitForTimeout(120) }
    await stable(() => p.evaluate(() => document.getElementById("thread-scroll").scrollTop), 3000, 150); await until(async () => /Jump to latest/.test(await p.locator("#new-pill").innerText({ timeout: 200 }).catch(() => "")), 3000);
    const pin0 = await p.locator("#new-pill").innerText();
    const before = await p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(); const el = [...document.querySelectorAll("#thread>.entry")].find((x) => x.getBoundingClientRect().top > q.top); return { top: sc.scrollTop, id: el.id, y: el.getBoundingClientRect().top } });
    await post(ckV, "one while you're up"); await until(async () => /^1 new message\b/.test(await p.locator("#new-pill").innerText({ timeout: 200 }).catch(() => "")), 8000);
    const pill1 = await p.locator("#new-pill").innerText();
    await post(ckV, "two while you're up"); await post(ckV, "three while you're up"); await until(async () => /^3 new messages/.test(await p.locator("#new-pill").innerText({ timeout: 200 }).catch(() => "")), 8000);
    await p.waitForTimeout(300); // the arrivals have laid out: give a push, if there were one, time to show
    const after = await p.evaluate((id) => ({ top: document.getElementById("thread-scroll").scrollTop, y: document.getElementById(id)?.getBoundingClientRect().top }), before.id);
    check(Math.abs(after.top - before.top) <= 2 && Math.abs(after.y - before.y) <= 2, `scrolled up, new messages don't push the conversation (${Math.round(before.y)} → ${Math.round(after.y)})`);
    const pill3 = await p.locator("#new-pill").innerText();
    check(/Jump to latest/.test(pin0) && /^1 new message\b/.test(pill1) && /^3 new messages/.test(pill3), `the pill reads "${pin0}", then "${pill1}", then "${pill3}"`);
    await p.locator("#new-pill").click(); await until(() => p.locator("#thread>.entry", { hasText: "three while you're up" }).isVisible(), 5000);
    check(await p.locator("#thread>.entry", { hasText: "three while you're up" }).isVisible(), `the pill takes you to the newest`);
    const last = await p.evaluate(() => Math.max(...[...document.querySelectorAll("#thread>.entry")].map((x) => +x.dataset.seq)));
    await until(() => Math.max(0, ...p.seen) >= last, 5000); check(Math.max(0, ...p.seen) >= last, `reading to the bottom reports the newest message as seen (#${Math.max(0, ...p.seen)} of #${last})`);
  }
  check(!p.errors.length, `${motion}: no page errors ${p.errors.join(" | ")}`); await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "scroll window: all passed"); process.exit(fails ? 1 : 0);
