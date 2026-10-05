// A bounded conversation on a long board (jxn #1365, on rail-cap for #1366/#1367): ~400 messages; far ones become
// placeholders, so the page holds a bounded number of messages; jumps, links, #refs, the rail and threads bring back
// what they need; new messages ease in, never push you when you're scrolled up, and the pill counts them.
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const run = Date.now().toString(36).slice(-4), P = `sw${run}`, V = `sv${run}`;
for (const u of [P, V]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true", display: { mode: "developer" } });
const board = (await ops("boards", { user: P, title: `Window ${run}` })).board.id; await ops("members", { board, user: V });
const ckP = (await ops("sessions", { user: P })).cookie, ckV = (await ops("sessions", { user: V })).cookie;
const post = async (ck, text, reply_to) => { const r = await fetch(`${BASE}/api/boards/${board}/entries`, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(reply_to ? { text, reply_to } : { text }) }); const j = await r.json(); return j.entry?.seq ?? j.seq; };
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
  await p.goto(`${BASE}/b/${board}${path}`); await p.waitForTimeout(1500); return { ctx, p };
}
const stats = (p) => p.evaluate(() => ({ live: document.querySelectorAll("#thread>.entry").length, ghosts: document.querySelectorAll("#thread>.ghost").length, more: !!document.getElementById("load-earlier"), first: +document.querySelector("#thread>[data-seq]")?.dataset.seq }));
const centred = (p, seq) => p.evaluate((s) => { const el = document.getElementById("e" + s), sc = document.getElementById("thread-scroll"); if (!el) return 1e9; const r = el.getBoundingClientRect(), q = sc.getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - (q.top + q.bottom) / 2) }, seq);
const settle = (p, ms = 900) => p.waitForTimeout(ms);
// A jump has landed once its message is a real one near the middle of the view (or after 6 s, and the check says how far off).
const landed = (p, seq, off = 100) => p.waitForFunction(({ s, off }) => { const el = document.getElementById("e" + s), sc = document.getElementById("thread-scroll"); if (!el || !el.classList.contains("entry")) return false; const r = el.getBoundingClientRect(), q = sc.getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - (q.top + q.bottom) / 2) < off; }, { s: seq, off }, { timeout: 6000, polling: 100 }).then(() => settle(p, 300), () => {});
const jumpTo = async (p, seq) => { await p.evaluate((s) => window.BOARD_CTX.jump(s), seq); await landed(p, seq); };

// 1. Opening and going all the way back: older messages load as you scroll up, the page never holds more than a window.
// (Alone: it measures frame times while scrolling.) Then 2, 3 and 3b, which only read, run side by side with 4's reduced-motion
// pass; 4's pill count comes last, alone.
const t1 = Date.now();
{ const { ctx, p } = await open();
  let s = await stats(p); check(s.live <= 90 && s.ghosts > 0, `opening: ${s.live} messages on the page, ${s.ghosts} placeholders`);
  await p.locator("#thread-scroll").hover({ position: { x: 300, y: 300 } });
  let maxLive = 0, frames = [];
  await p.evaluate(() => { window.__fr = []; let t0 = performance.now(); const f = (t) => { window.__fr.push(t - t0); t0 = t; if (window.__fr.length < 4000) requestAnimationFrame(f) }; requestAnimationFrame(f) });
  for (let i = 0; i < 160 && (s.more || s.first > 1); i++) { await p.mouse.wheel(0, -900); await p.waitForTimeout(90); if (i % 8 === 0) { s = await stats(p); maxLive = Math.max(maxLive, s.live) } }
  await settle(p, 1200); s = await stats(p); maxLive = Math.max(maxLive, s.live);
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
    await settle(p, 1500);
    const a1 = await p.evaluate((s) => { const el = document.getElementById("e" + s) || document.getElementById("g" + s); return el && { y: el.getBoundingClientRect().top, live: el.classList.contains("entry"), ghosts: [...document.querySelectorAll("#thread>.ghost")].filter((g) => { const r = g.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight }).length } }, a0.seq);
    check(a0.ghost && a1 && a1.live && a1.ghosts === 0 && Math.abs(a1.y - a0.y) <= 3, `landing among placeholders at ${f * 100}%: they come back and #${a0.seq} stays put (${Math.round(a0.y)} → ${a1 ? Math.round(a1.y) : "gone"})`);
  }
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

const t2 = Date.now();
await Promise.all([jumps(), deepLink(), phone(), newMessages("reduce")]); // reduce only checks its own message's animation
const t4 = Date.now();
await newMessages("no-preference"); // counts the pill, so nothing else posts meanwhile
// 2. Jumps to messages that aren't on the page: search's jump, a #ref chip, a link, the rail and a thread.
async function jumps() { const { ctx, p } = await open();
  await jumpTo(p, 5);
  check((await p.locator("#e5.entry").count()) === 1 && (await centred(p, 5)) < 120, `a jump to #5 (never loaded) brings it in, centred (${Math.round(await centred(p, 5))}px off)`);
  await jumpTo(p, S.ref);
  await jumpTo(p, 200);
  check((await centred(p, 200)) < 120, `a jump to #200 lands centred (${Math.round(await centred(p, 200))}px off)`);
  let s = await stats(p); check(s.live <= 130, `after jumping around, ${s.live} messages on the page`);
  check((await p.locator(`#g8`).count()) === 1 && (await p.locator(`#g${S.target}`).count()) === 1, `messages left behind became placeholders (#8, #${S.target})`);
  await jumpTo(p, S.ref);
  await p.locator(`#e${S.ref} a.ref`).first().click(); await landed(p, S.target, 140);
  check((await p.locator(`#e${S.target}.entry`).count()) === 1 && (await centred(p, S.target)) < 140, `a #ref chip jumps to #${S.target}, brought back from a placeholder`);
  // The thread's root and late reply: "2 replies" counts a reply that's a placeholder, and the overlay brings both back.
  await jumpTo(p, S.root);
  const sum = await p.locator(`#e${S.root} .thr-sum`).innerText().catch(() => "");
  check(/2 replies/.test(sum) && (await p.locator(`#g${S.kid2}`).count()) === 1, `"2 replies" counts the late reply while it's a placeholder ("${sum.replace(/\s+/g, " ").trim()}")`);
  await p.locator(`#e${S.root} .thr-sum`).click(); await p.locator("dialog.thr-dlg", { hasText: "Late answer" }).waitFor({ timeout: 6000 }).catch(() => {});
  const dl = await p.locator("dialog.thr-dlg").innerText().catch(() => "");
  check(dl.includes("First answer") && dl.includes("Late answer"), `the thread overlay brings back every reply`);
  await p.keyboard.press("Escape"); await settle(p, 400);
  // The rail: clicking near its top goes there and the messages come back.
  const rb = await p.locator("#rail").boundingBox(); await p.mouse.click(rb.x + rb.width / 2, rb.y + rb.height * 0.04); await settle(p, 1500);
  const near = await p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(); const els = [...document.querySelectorAll("#thread>.entry,#thread>.ghost")].filter((x) => { const r = x.getBoundingClientRect(); return r.bottom > q.top && r.top < q.bottom }); return { n: els.length, ghosts: els.filter((x) => x.classList.contains("ghost")).length, seq: +els[0]?.dataset.seq } });
  check(near.n > 0 && near.ghosts === 0 && near.seq < 60, `the rail goes back to the start (#${near.seq} at the top) and what's in view is real messages`);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 3. A deep link to a message that's not on the page.
async function deepLink() { const { ctx, p } = await open(`#e12`); await landed(p, 12, 200);
  check((await p.locator("#e12.entry").count()) === 1 && (await centred(p, 12)) < 200, `a link to #12 opens there (${Math.round(await centred(p, 12))}px off centre)`);
  check(!p.errors.length, `no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 3b. On a phone: the same window, and a jump still lands.
async function phone() { const { ctx, p } = await open("", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await settle(p, 600);
  await jumpTo(p, 150);
  const s = await stats(p);
  check((await centred(p, 150)) < 140 && s.live <= 130 && s.ghosts > 100, `phone: a jump to #150 lands (${Math.round(await centred(p, 150))}px off), ${s.live} messages on the page`);
  check(!p.errors.length, `phone: no page errors ${p.errors.join(" | ")}`); await ctx.close(); }

// 4. New messages: ease in at the bottom; scrolled up, they don't push you and the pill counts them.
async function newMessages(motion) {
  const { ctx, p } = await open("", { reducedMotion: motion });
  const seqA = await post(ckV, `arrives at the bottom ${motion}`); await p.waitForSelector(`#e${seqA}`, { timeout: 8000 });
  const anim = await p.evaluate((s) => getComputedStyle(document.getElementById("e" + s)).animationName, seqA);
  if (motion === "reduce") check(!/entryin/.test(anim), `reduced motion: the new message doesn't move (${anim})`);
  else check(/entryin/.test(anim) && (await p.evaluate(() => { const sc = document.getElementById("thread-scroll"); return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 30 })), `at the bottom, a new message eases in and the view follows it (${anim})`);
  if (motion === "no-preference") {
    await p.locator("#thread-scroll").hover({ position: { x: 300, y: 300 } }); for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -700); await p.waitForTimeout(120) } await settle(p, 1000);
    const pin0 = await p.locator("#new-pill").innerText();
    const before = await p.evaluate(() => { const sc = document.getElementById("thread-scroll"), q = sc.getBoundingClientRect(); const el = [...document.querySelectorAll("#thread>.entry")].find((x) => x.getBoundingClientRect().top > q.top); return { top: sc.scrollTop, id: el.id, y: el.getBoundingClientRect().top } });
    await post(ckV, "one while you're up"); await p.locator("#new-pill", { hasText: /^1 new message/ }).waitFor({ timeout: 8000 }).catch(() => {}); await settle(p, 500);
    const pill1 = await p.locator("#new-pill").innerText();
    await post(ckV, "two while you're up"); await post(ckV, "three while you're up"); await p.locator("#new-pill", { hasText: /^3 new messages/ }).waitFor({ timeout: 8000 }).catch(() => {}); await settle(p, 800);
    const after = await p.evaluate((id) => ({ top: document.getElementById("thread-scroll").scrollTop, y: document.getElementById(id)?.getBoundingClientRect().top }), before.id);
    check(Math.abs(after.top - before.top) <= 2 && Math.abs(after.y - before.y) <= 2, `scrolled up, new messages don't push the conversation (${Math.round(before.y)} → ${Math.round(after.y)})`);
    const pill3 = await p.locator("#new-pill").innerText();
    check(/Jump to latest/.test(pin0) && /^1 new message\b/.test(pill1) && /^3 new messages/.test(pill3), `the pill reads "${pin0}", then "${pill1}", then "${pill3}"`);
    await p.locator("#new-pill").click(); await settle(p, 1500);
    check(await p.locator("#thread>.entry", { hasText: "three while you're up" }).isVisible(), `the pill takes you to the newest`);
    const last = await p.evaluate(() => Math.max(...[...document.querySelectorAll("#thread>.entry")].map((x) => +x.dataset.seq)));
    await settle(p, 1200); check(Math.max(0, ...p.seen) >= last, `reading to the bottom reports the newest message as seen (#${Math.max(0, ...p.seen)} of #${last})`);
  }
  check(!p.errors.length, `${motion}: no page errors ${p.errors.join(" | ")}`); await ctx.close();
}
await b.close(); console.log(fails ? `${fails} FAILED` : "scroll window: all passed"); process.exit(fails ? 1 : 0);
